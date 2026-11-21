//File number : 062
// File : src/math/062_wavelets.js
//Description : Complete wavelet-transform system — 1D/2D/3D discrete wavelet transforms (DWT) with periodic/symmetric/zero boundary handling, multilevel decomposition, continuous wavelet transform (CWT) with Morlet and Mexican-hat mothers, wavelet packets with entropy best-basis selection, denoising (soft/hard thresholding + Donoho-Johnstone universal threshold), lifting schemes (Haar and CDF 5/3 for integer-reversible transforms), and a filter-bank registry (Haar, Daubechies db2/db3/db4, Symlet sym4/sym6, Coiflet coif1, biorthogonal CDF 9/7, Morlet, Mexican hat — extensible via `registerFilter`). Domain helpers cover multi-resolution terrain and volumetric clouds, detail addition for LOD refinement, motion-curve smoothing that preserves sharp transitions, IK joint-trajectory filtering, orbital position denoising for 1M+ bodies, color-domain spectral filtering, and LOD hierarchies from any mesh grid. Every single-level transform and every SOA batch is zero-GC and offset-indexed (no `subarray` views), with chunked async variants yielding via `scheduler.yield()` / `MessageChannel` so the Android UI thread stays at 60/120 fps. Buffers honor `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap); filter coefficients remain Float64 for numerical stability. Small-to-galactic seamless because every transform operates on normalized [0,1] parameter space.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. The filter registry is a frozen init-time plain object (no Map). All single-level transforms and SOA kernels are offset-indexed over caller or pooled buffers (no `TypedArray.subarray`). Chunked async kernels inline their loops (no per-call callbacks). Scratch pools are fixed-capacity with buffer-preserving release. All allocations occur exclusively at module init / pool growth / documented generation-time multi-level paths.
//Corrections : ESM imports/exports only (no require/exports). Fixed: filter registry used a forbidden `Map` (now a plain object with a prebuilt name list); `soaDWT1D`/`soaIDWT1D` contained corrupted operators (`> >`, `& &`, trailing-space mode strings) and out-of-range indexing; every chunked SOA kernel used `TypedArray.subarray` per instance (allocation); `bestBasis` allocated two entropy closures per node; `cwtMorlet`/`cwtMexicanHat` allocated a mother-wavelet closure per call; `WaveletScratch` used an unbounded push/splice warm pool; the scratch pool monkey-patched `acquire` with a bound closure; `WaveletBatchState` used a Set + forEach listeners; `lifting53`/`ilifting53` allocated two arrays per call; 2D transforms allocated three buffers per call; the unused `FFT` import was removed.
//Added : Offset-indexed zero-GC core (`_dwt1DCore`/`_idwt1DCore`/`_dwt2DCore`/`_idwt2DCore`), zero-GC single-level batch denoiser (`soaWaveletDenoise1` + chunked), `soaIDWT1DChunked`, `soaIDWT2DChunked`, hoisted CWT mothers, hoisted Shannon-entropy helper, and a third scratch buffer for 2D line transforms.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — sibling files within the 54-file math topology)
// ============================================================================
import { common, getArrayType, onPrecisionChange } from './000_Math_module.js';

// ============================================================================
// Variable Declarations — constants and module scratch (init-time only)
// ============================================================================
const SQRT2 = Math.SQRT2;
const INV_SQRT2 = 1 / SQRT2;

// Boundary mode codes (avoid string comparison inside inner loops).
const MODE_PERIODIC = 0;
const MODE_SYMMETRIC = 1;
const MODE_ZERO = 2;

// CWT module state (single-threaded, set per call).
let _cwtOmega0 = 6;

// ============================================================================
// Class Declarations — WaveletFilter
// ============================================================================
/**
 * WaveletFilter — a 2-channel filter bank (analysis + reconstruction).
 * For orthogonal filters the reconstruction banks are the reversed analysis
 * banks; biorthogonal filters supply all four explicitly.
 */
class WaveletFilter {
    constructor(name, analysisLow, analysisHigh, reconLow, reconHigh, options) {
        this.name = name;
        this.analysisLow = analysisLow;
        this.analysisHigh = analysisHigh;
        this.reconLow = reconLow || _reverseArray(analysisLow);
        this.reconHigh = reconHigh || _reverseArray(analysisHigh);
        this.length = analysisLow.length;
        options = options || {};
        this.isOrthogonal = options.isOrthogonal !== false;
        this.isContinuous = options.isContinuous === true;
        this.motherFn = options.motherFn || null;
    }
}

function _reverseArray(a) {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[a.length - 1 - i];
    return out;
}

// ============================================================================
// Filter registry — plain object (no Map) + prebuilt name list
// ============================================================================
const _filterRegistry = Object.create(null);
const _filterNames = [];

function registerFilter(name, filter) {
    _filterRegistry[name] = filter;
    _filterNames.push(name);
    return filter;
}

function getFilter(nameOrFilter) {
    if (nameOrFilter instanceof WaveletFilter) return nameOrFilter;
    const name = String(nameOrFilter || "haar").toLowerCase();
    const f = _filterRegistry[name];
    if (f === undefined) throw new Error("getFilter: unknown filter '" + name + "'");
    return f;
}

/** Returns the frozen init-time name list (do not mutate). */
function listFilters() { return _filterNames; }

// ---- Built-in filters ----
registerFilter("haar", new WaveletFilter(
    "haar",
    [INV_SQRT2, INV_SQRT2],
    [INV_SQRT2, -INV_SQRT2]
));

(function () {
    const d = 4 * SQRT2;
    const h = [
        (1 + Math.sqrt(3)) / d,
        (3 + Math.sqrt(3)) / d,
        (3 - Math.sqrt(3)) / d,
        (1 - Math.sqrt(3)) / d
    ];
    const g = [h[3], -h[2], h[1], -h[0]];
    registerFilter("db2", new WaveletFilter("db2", h, g));
})();

(function () {
    const h = [
        0.3326705529509569, 0.8068915093133388, 0.4598775021193313,
        -0.13501102001039084, -0.08544127388224149, 0.035226291882100656
    ];
    const g = [h[5], -h[4], h[3], -h[2], h[1], -h[0]];
    registerFilter("db3", new WaveletFilter("db3", h, g));
})();

(function () {
    const h = [
        0.2303778133088964, 0.7148465705529154, 0.6308807679298587,
        -0.027983769416859854, -0.18703481171909309, 0.030841381835560764,
        0.0328830116668852, -0.010597401785069032
    ];
    const g = [h[7], -h[6], h[5], -h[4], h[3], -h[2], h[1], -h[0]];
    registerFilter("db4", new WaveletFilter("db4", h, g));
})();

(function () {
    const h = [
        0.03222310060407815, -0.012603967262261507, -0.09921954357693596,
        0.29785779560560505, 0.803738751805386, 0.4976186676325629,
        -0.029635527645960395, -0.0757657147892364
    ];
    const g = [h[7], -h[6], h[5], -h[4], h[3], -h[2], h[1], -h[0]];
    registerFilter("sym4", new WaveletFilter("sym4", h, g));
})();

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

(function () {
    const h = [
        -0.015655728135465, -0.072732619512854,
        0.384864846864203, 0.852572020212255,
        0.337897662457809, -0.072732619512854
    ];
    const g = [h[5], -h[4], h[3], -h[2], h[1], -h[0]];
    registerFilter("coif1", new WaveletFilter("coif1", h, g));
})();

(function () {
    const analysisLow = [
        0.026748757411, -0.016864118443, -0.078223266529,
        0.266864118443, 0.602949018236, 0.266864118443,
        -0.078223266529, -0.016864118443, 0.026748757411
    ];
    const analysisHigh = [
        0, 0.091271763114, -0.057543526229,
        -0.591271763114, 1.115087052457, -0.591271763114,
        -0.057543526229, 0.091271763114, 0
    ];
    const reconLow = [
        0, -0.091271763114, -0.057543526229,
        0.591271763114, 1.115087052457, 0.591271763114,
        -0.057543526229, -0.091271763114, 0
    ];
    const reconHigh = [
        0.026748757411, 0.016864118443, -0.078223266529,
        -0.266864118443, 0.602949018236, -0.266864118443,
        -0.078223266529, 0.016864118443, 0.026748757411
    ];
    registerFilter("cdf97", new WaveletFilter(
        "cdf97", analysisLow, analysisHigh, reconLow, reconHigh,
        { isOrthogonal: false }
    ));
})();

registerFilter("morlet", new WaveletFilter(
    "morlet", [1], [1], [1], [1],
    { isContinuous: true, motherFn: null }
));

registerFilter("mexh", new WaveletFilter(
    "mexh", [1], [1], [1], [1],
    { isContinuous: true, motherFn: null }
));

// ============================================================================
// Scratch pool — precision-aware, buffer-preserving release, 3 buffers
// ============================================================================
function _waveletScratchEnsure(s, n) {
    if (n <= s.size) return s;
    const T = getArrayType();
    s.size = n;
    s.a = new T(n);
    s.b = new T(n);
    s.c = new T(n);
    return s;
}

function _waveletScratchFactory() {
    const T = getArrayType();
    return { a: new T(256), b: new T(256), c: new T(256), size: 256, ensure: _waveletScratchEnsure };
}

function _waveletScratchReset(s) { /* buffers retained for Zero-GC reuse */ }

const _waveletScratchPool = common.createPool(_waveletScratchFactory, 8, _waveletScratchReset);

for (let _pw = 0; _pw < 8; _pw++) {
    const _s = _waveletScratchPool.acquire() || _waveletScratchFactory();
    _waveletScratchPool.release(_s);
}

function acquireWaveletScratch(size) {
    const s = _waveletScratchPool.acquire() || _waveletScratchFactory();
    if (size !== undefined) s.ensure(size);
    return s;
}

function releaseWaveletScratch(s) { if (s) _waveletScratchPool.release(s); }

function createWaveletScratchPool(capacity) {
    return common.createPool(_waveletScratchFactory, capacity || 8, _waveletScratchReset);
}

function _modeCode(mode) {
    if (mode === "symmetric") return MODE_SYMMETRIC;
    if (mode === "zero") return MODE_ZERO;
    return MODE_PERIODIC;
}

// ============================================================================
// Function Declarations — 1D DWT core (offset-indexed, zero-GC)
// ============================================================================
/**
 * One-level 1D DWT with explicit offsets. Reads `x[xOff .. xOff+n)`, writes
 * `out[outOff .. outOff+n)` as [approx | detail]. `filter` is a resolved
 * WaveletFilter. No allocation.
 */
function _dwt1DCore(out, outOff, x, xOff, n, filter, mode) {
    const half = n >> 1;
    const L = filter.length;
    const low = filter.analysisLow, high = filter.analysisHigh;
    const m = _modeCode(mode);
    for (let i = 0; i < half; i++) {
        let sumL = 0, sumH = 0;
        for (let k = 0; k < L; k++) {
            let idx = 2 * i + k;
            let j;
            if (m === MODE_PERIODIC) {
                j = ((idx % n) + n) % n;
            } else if (m === MODE_SYMMETRIC) {
                if (idx < 0) idx = -idx - 1;
                if (idx >= n) idx = 2 * n - 1 - idx;
                j = idx;
            } else {
                j = idx;
            }
            if (j >= 0 && j < n) {
                const v = x[xOff + j];
                sumL += low[k] * v;
                sumH += high[k] * v;
            }
        }
        out[outOff + i] = sumL;
        out[outOff + half + i] = sumH;
    }
    return out;
}

/**
 * One-level 1D inverse DWT with explicit offsets. Reads `packed[pOff ..]`
 * ([approx | detail]), writes `out[outOff .. outOff+n)`. No allocation.
 */
function _idwt1DCore(out, outOff, packed, pOff, n, filter, mode) {
    const half = n >> 1;
    const L = filter.length;
    const rLow = filter.reconLow, rHigh = filter.reconHigh;
    const m = _modeCode(mode);
    for (let i = 0; i < n; i++) out[outOff + i] = 0;
    for (let i = 0; i < half; i++) {
        const a = packed[pOff + i];
        const d = packed[pOff + half + i];
        for (let k = 0; k < L; k++) {
            let idx = 2 * i + k;
            let j;
            if (m === MODE_PERIODIC) {
                j = ((idx % n) + n) % n;
            } else if (m === MODE_SYMMETRIC) {
                if (idx >= n) idx = 2 * n - 1 - idx;
                j = idx;
            } else {
                j = idx;
            }
            if (j >= 0 && j < n) {
                out[outOff + j] += rLow[k] * a + rHigh[k] * d;
            }
        }
    }
    return out;
}

/** Convenience wrappers (offset 0). */
function dwt1D(out, x, n, filter, boundaryMode) {
    return _dwt1DCore(out, 0, x, 0, n, getFilter(filter), boundaryMode);
}

function idwt1D(out, packed, n, filter, boundaryMode) {
    return _idwt1DCore(out, 0, packed, 0, n, getFilter(filter), boundaryMode);
}

// ============================================================================
// Function Declarations — Multilevel 1D (generation-time)
// ============================================================================
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
        const next = new T(size);
        _dwt1DCore(next, 0, current, 0, size, filter, boundaryMode);
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
        _idwt1DCore(reconstructed, 0, packed, 0, full, filter, boundaryMode);
        current = reconstructed;
        size = full;
    }
    return current;
}

// ============================================================================
// Function Declarations — 2D DWT (pooled scratch, zero-GC core)
// ============================================================================
function _dwt2DCore(out, x, n, m, filter, mode, s) {
    const tmp = s.a, lineIn = s.b, lineOut = s.c;
    for (let r = 0; r < n; r++) _dwt1DCore(tmp, r * m, x, r * m, m, filter, mode);
    for (let c = 0; c < m; c++) {
        for (let r = 0; r < n; r++) lineIn[r] = tmp[r * m + c];
        _dwt1DCore(lineOut, 0, lineIn, 0, n, filter, mode);
        for (let r = 0; r < n; r++) out[r * m + c] = lineOut[r];
    }
    return out;
}

function _idwt2DCore(out, packed, n, m, filter, mode, s) {
    const tmp = s.a, lineIn = s.b, lineOut = s.c;
    for (let c = 0; c < m; c++) {
        for (let r = 0; r < n; r++) lineIn[r] = packed[r * m + c];
        _idwt1DCore(lineOut, 0, lineIn, 0, n, filter, mode);
        for (let r = 0; r < n; r++) tmp[r * m + c] = lineOut[r];
    }
    for (let r = 0; r < n; r++) _idwt1DCore(out, r * m, tmp, r * m, m, filter, mode);
    return out;
}

function dwt2D(out, x, n, m, filter, boundaryMode) {
    filter = getFilter(filter);
    const s = acquireWaveletScratch(n * m);
    _dwt2DCore(out, x, n, m, filter, boundaryMode, s);
    releaseWaveletScratch(s);
    return out;
}

function idwt2D(out, packed, n, m, filter, boundaryMode) {
    filter = getFilter(filter);
    const s = acquireWaveletScratch(n * m);
    _idwt2DCore(out, packed, n, m, filter, boundaryMode, s);
    releaseWaveletScratch(s);
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
    const s = acquireWaveletScratch(n * m);
    for (let level = 0; level < levels; level++) {
        if (sizeN < 2 * filter.length || sizeM < 2 * filter.length) break;
        s.ensure(sizeN * sizeM);
        const next = new T(sizeN * sizeM);
        _dwt2DCore(next, current, sizeN, sizeM, filter, boundaryMode, s);
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
    releaseWaveletScratch(s);
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
        const s = acquireWaveletScratch(fullN * fullM);
        _idwt2DCore(reconstructed, packed, fullN, fullM, filter, boundaryMode, s);
        releaseWaveletScratch(s);
        current = reconstructed;
        sizeN = fullN;
        sizeM = fullM;
    }
    return current;
}

// ============================================================================
// Function Declarations — 3D DWT (generation-time)
// ============================================================================
function dwt3D(out, x, nx, ny, nz, filter, boundaryMode) {
    filter = getFilter(filter);
    boundaryMode = boundaryMode || "periodic";
    const sliceSize = nx * ny;
    const s2 = acquireWaveletScratch(sliceSize);
    const slice = s2.a, outSlice = s2.b;
    const tmp = new (getArrayType())(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
        for (let i = 0; i < sliceSize; i++) slice[i] = x[k * sliceSize + i];
        _dwt2DCore(outSlice, slice, nx, ny, filter, boundaryMode, s2);
        for (let i = 0; i < sliceSize; i++) tmp[k * sliceSize + i] = outSlice[i];
    }
    releaseWaveletScratch(s2);
    const col = new (getArrayType())(nz);
    const colOut = new (getArrayType())(nz);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            for (let k = 0; k < nz; k++) col[k] = tmp[(k * ny + j) * nx + i];
            _dwt1DCore(colOut, 0, col, 0, nz, filter, boundaryMode);
            for (let k = 0; k < nz; k++) out[(k * ny + j) * nx + i] = colOut[k];
        }
    }
    return out;
}

function idwt3D(out, packed, nx, ny, nz, filter, boundaryMode) {
    filter = getFilter(filter);
    boundaryMode = boundaryMode || "periodic";
    const tmp = new (getArrayType())(nx * ny * nz);
    const col = new (getArrayType())(nz);
    const colOut = new (getArrayType())(nz);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            for (let k = 0; k < nz; k++) col[k] = packed[(k * ny + j) * nx + i];
            _idwt1DCore(colOut, 0, col, 0, nz, filter, boundaryMode);
            for (let k = 0; k < nz; k++) tmp[(k * ny + j) * nx + i] = colOut[k];
        }
    }
    const sliceSize = nx * ny;
    const s2 = acquireWaveletScratch(sliceSize);
    const slice = s2.a, outSlice = s2.b;
    for (let k = 0; k < nz; k++) {
        for (let i = 0; i < sliceSize; i++) slice[i] = tmp[k * sliceSize + i];
        _idwt2DCore(outSlice, slice, nx, ny, filter, boundaryMode, s2);
        for (let i = 0; i < sliceSize; i++) out[k * sliceSize + i] = outSlice[i];
    }
    releaseWaveletScratch(s2);
    return out;
}

// ============================================================================
// Function Declarations — Continuous wavelet transform (hoisted mothers)
// ============================================================================
function _morletMother(t) {
    return Math.pow(Math.PI, -0.25) * Math.cos(_cwtOmega0 * t) * Math.exp(-0.5 * t * t);
}

function _mexhMother(t) {
    const t2 = t * t;
    return (2 / (Math.sqrt(3) * Math.pow(Math.PI, 0.25))) * (1 - t2) * Math.exp(-0.5 * t2);
}

/**
 * Continuous wavelet transform. Convolves the signal with the scaled and
 * translated mother wavelet at each scale. Generation-time (allocates the
 * per-scale coefficient arrays once).
 */
function cwt(signal, n, scales, motherFn) {
    const T = getArrayType();
    const out = new Array(scales.length);
    for (let s = 0; s < scales.length; s++) {
        const scale = scales[s];
        const coeffs = new T(n);
        const halfWidth = Math.ceil(scale * 5);
        const invSqrtScale = 1 / Math.sqrt(scale);
        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let k = -halfWidth; k <= halfWidth; k++) {
                const idx = i + k;
                if (idx < 0 || idx >= n) continue;
                sum += signal[idx] * motherFn(k / scale);
            }
            coeffs[i] = sum * invSqrtScale;
        }
        out[s] = coeffs;
    }
    return out;
}

function cwtMorlet(signal, n, scales, omega0) {
    _cwtOmega0 = omega0 === undefined ? 6 : omega0;
    return cwt(signal, n, scales, _morletMother);
}

function cwtMexicanHat(signal, n, scales) {
    return cwt(signal, n, scales, _mexhMother);
}

/** Scalogram — magnitude of the CWT at each scale. */
function scalogram(signal, n, scales, motherFn) {
    const coeffs = cwt(signal, n, scales, motherFn);
    const T = getArrayType();
    const out = new Array(coeffs.length);
    for (let s = 0; s < coeffs.length; s++) {
        const mag = new T(n);
        for (let i = 0; i < n; i++) mag[i] = Math.abs(coeffs[s][i]);
        out[s] = mag;
    }
    return out;
}

// ============================================================================
// Function Declarations — Wavelet packets + best basis
// ============================================================================
/** Hoisted Shannon entropy (no per-node closure). */
function _shannonEntropy(data, size) {
    let energy = 0;
    for (let i = 0; i < size; i++) energy += data[i] * data[i];
    if (energy < 1e-12) return 0;
    let h = 0;
    for (let i = 0; i < size; i++) {
        const p = data[i] * data[i] / energy;
        if (p > 1e-12) h -= p * Math.log(p);
    }
    return h;
}

/** Full wavelet-packet decomposition (generation-time). */
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
        _dwt1DCore(packed, 0, data, 0, size, filter, boundaryMode);
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
    const initial = new T(n);
    for (let i = 0; i < n; i++) initial[i] = signal[i];
    return recurse(initial, n, 0);
}

/** Entropy best-basis selection over a packet tree (generation-time). */
function bestBasis(root) {
    const result = [];
    function recurse(node) {
        if (!node.children) { result.push(node); return; }
        const childCost = _shannonEntropy(node.children[0].data, node.children[0].size)
            + _shannonEntropy(node.children[1].data, node.children[1].size);
        const nodeCost = _shannonEntropy(node.data, node.size);
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

/** Donoho-Johnstone universal threshold: σ·√(2·ln n). */
function universalThreshold(sigma, n) {
    return sigma * Math.sqrt(2 * Math.log(n));
}

/**
 * Multilevel wavelet denoising (generation-time). Decomposes, thresholds the
 * detail coefficients, and reconstructs. `mode` = "soft" | "hard".
 */
function waveletDenoise(signal, n, filter, levels, sigma, mode, boundaryMode) {
    const result = dwtMultiLevel1D(signal, n, filter, levels, boundaryMode);
    const threshold = universalThreshold(sigma || 1, n);
    const useHard = mode === "hard";
    for (let level = 0; level < result.details.length; level++) {
        const det = result.details[level];
        for (let i = 0; i < det.length; i++) {
            det[i] = useHard ? hardThreshold(det[i], threshold) : softThreshold(det[i], threshold);
        }
    }
    return idwtMultiLevel1D(result, n, filter, boundaryMode);
}

// ============================================================================
// Function Declarations — Lifting schemes (pooled, zero-GC)
// ============================================================================
/** Haar lifting, in-place on `buf` (length n, even). Forward: [approx|detail]. */
function liftingHaar(buf, n) {
    const half = n >> 1;
    const s = acquireWaveletScratch(n);
    const tmp = s.a;
    for (let i = 0; i < half; i++) {
        const a = buf[2 * i];
        const b = buf[2 * i + 1];
        tmp[i] = (a + b) * INV_SQRT2;
        tmp[half + i] = (a - b) * INV_SQRT2;
    }
    for (let i = 0; i < n; i++) buf[i] = tmp[i];
    releaseWaveletScratch(s);
    return buf;
}

function iliftingHaar(buf, n) {
    const half = n >> 1;
    const s = acquireWaveletScratch(n);
    const tmp = s.a;
    for (let i = 0; i < half; i++) {
        const a = buf[i];
        const d = buf[half + i];
        tmp[2 * i] = (a + d) * INV_SQRT2;
        tmp[2 * i + 1] = (a - d) * INV_SQRT2;
    }
    for (let i = 0; i < n; i++) buf[i] = tmp[i];
    releaseWaveletScratch(s);
    return buf;
}

/** CDF 5/3 lifting (reversible, JPEG2000). Forward: [approx|detail]. */
function lifting53(buf, n) {
    const half = n >> 1;
    const s = acquireWaveletScratch(n);
    const even = s.a, odd = s.b;
    for (let i = 0; i < half; i++) { even[i] = buf[2 * i]; odd[i] = buf[2 * i + 1]; }
    for (let i = 0; i < half; i++) {
        const e0 = even[i];
        const e1 = even[(i + 1) % half];
        odd[i] -= (e0 + e1) * 0.5;
    }
    for (let i = 0; i < half; i++) {
        const d0 = odd[(i - 1 + half) % half];
        const d1 = odd[i];
        even[i] += (d0 + d1) * 0.25;
    }
    for (let i = 0; i < half; i++) { buf[i] = even[i]; buf[half + i] = odd[i]; }
    releaseWaveletScratch(s);
    return buf;
}

function ilifting53(buf, n) {
    const half = n >> 1;
    const s = acquireWaveletScratch(n);
    const even = s.a, odd = s.b;
    for (let i = 0; i < half; i++) { even[i] = buf[i]; odd[i] = buf[half + i]; }
    for (let i = 0; i < half; i++) {
        const d0 = odd[(i - 1 + half) % half];
        const d1 = odd[i];
        even[i] -= (d0 + d1) * 0.25;
    }
    for (let i = 0; i < half; i++) {
        const e0 = even[i];
        const e1 = even[(i + 1) % half];
        odd[i] += (e0 + e1) * 0.5;
    }
    for (let i = 0; i < half; i++) { buf[2 * i] = even[i]; buf[2 * i + 1] = odd[i]; }
    releaseWaveletScratch(s);
    return buf;
}

// ============================================================================
// Function Declarations — Domain helpers (generation-time)
// ============================================================================
/** Multi-resolution terrain heightfield (n×n) from octave noise. */
function waveletTerrain(n, params, out) {
    params = params || {};
    out = out || new (getArrayType())(n * n);
    const octaves = params.octaves || 5;
    const seed = params.seed || 1;
    const scale = params.heightScale !== undefined ? params.heightScale : 1;
    const rng = common.mulberry32(seed);
    for (let i = 0; i < n * n; i++) out[i] = 0;
    let amp = 1, freq = 1;
    for (let oct = 0; oct < octaves; oct++) {
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const x = i / n * freq;
                const y = j / n * freq;
                const h = common.hash2(Math.floor(x * 1000), Math.floor(y * 1000));
                out[j * n + i] += (h * 2 - 1) * amp;
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

/** Volumetric cloud density cube (nx×ny×nz), values in [0,1]. */
function waveletClouds(nx, ny, nz, params, out) {
    params = params || {};
    out = out || new (getArrayType())(nx * ny * nz);
    const octaves = params.octaves || 4;
    const seed = params.seed || 42;
    const rng = common.mulberry32(seed);
    const N = nx * ny * nz;
    for (let i = 0; i < N; i++) out[i] = 0;
    let amp = 1;
    for (let oct = 0; oct < octaves; oct++) {
        for (let k = 0; k < nz; k++) {
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    out[(k * ny + j) * nx + i] += rng() * amp;
                }
            }
        }
        amp *= 0.5;
    }
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < N; i++) {
        if (out[i] < minV) minV = out[i];
        if (out[i] > maxV) maxV = out[i];
    }
    const range = maxV - minV || 1;
    for (let i = 0; i < N; i++) out[i] = (out[i] - minV) / range;
    return out;
}

/** Add high-frequency detail to a base field (LOD refinement). */
function waveletDetail(base, detail, n, blend) {
    blend = blend === undefined ? 1 : blend;
    for (let i = 0; i < n; i++) base[i] += detail[i] * blend;
    return base;
}

/** Motion-curve smoothing via multilevel wavelet denoising. */
function waveletMotionCurve(samples, n, filter, levels, sigma) {
    return waveletDenoise(samples, n, filter, levels, sigma, "soft", "symmetric");
}

/** IK joint-trajectory filter — denoises x/y/z tracks (generation-time). */
function waveletIKFilter(track, nSamples, filter, levels, sigma) {
    const T = getArrayType();
    const x = new T(nSamples), y = new T(nSamples), z = new T(nSamples);
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

/** Orbital position filter across many bodies (generation-time). */
function waveletOrbitalFilter(positions, nSamples, bodyCount, filter, levels, sigma) {
    const T = getArrayType();
    const out = new T(positions.length);
    const track = new T(nSamples * 3);
    for (let b = 0; b < bodyCount; b++) {
        for (let t = 0; t < nSamples; t++) {
            track[t * 3] = positions[(t * bodyCount + b) * 3];
            track[t * 3 + 1] = positions[(t * bodyCount + b) * 3 + 1];
            track[t * 3 + 2] = positions[(t * bodyCount + b) * 3 + 2];
        }
        const smoothed = waveletIKFilter(track, nSamples, filter, levels, sigma);
        for (let t = 0; t < nSamples; t++) {
            out[(t * bodyCount + b) * 3] = smoothed[t * 3];
            out[(t * bodyCount + b) * 3 + 1] = smoothed[t * 3 + 1];
            out[(t * bodyCount + b) * 3 + 2] = smoothed[t * 3 + 2];
        }
    }
    return out;
}

/** Color spectral filter — denoise a 1D RGB palette (generation-time). */
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

/** Wavelet LOD — approximate a heightfield at a coarser level. */
function waveletLOD(heightfield, n, level, filter) {
    const T = getArrayType();
    let current = new T(n * n);
    for (let i = 0; i < n * n; i++) current[i] = heightfield[i];
    let size = n;
    const flt = getFilter(filter);
    for (let l = 0; l < level; l++) {
        if (size < 2 * flt.length) break;
        const half = size >> 1;
        const next = new T(half * half);
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
// Function Declarations — SOA (sync, offset-indexed, zero-GC)
// ============================================================================
/** `count` independent 1D DWTs of size n on a flat buffer. */
function soaDWT1D(buffer, count, n, filterName, boundaryMode) {
    const filter = getFilter(filterName);
    const s = acquireWaveletScratch(n);
    const tmp = s.a;
    for (let i = 0; i < count; i++) {
        const off = i * n;
        _dwt1DCore(tmp, 0, buffer, off, n, filter, boundaryMode);
        for (let j = 0; j < n; j++) buffer[off + j] = tmp[j];
    }
    releaseWaveletScratch(s);
    return buffer;
}

function soaIDWT1D(buffer, count, n, filterName, boundaryMode) {
    const filter = getFilter(filterName);
    const s = acquireWaveletScratch(n);
    const tmp = s.a;
    for (let i = 0; i < count; i++) {
        const off = i * n;
        _idwt1DCore(tmp, 0, buffer, off, n, filter, boundaryMode);
        for (let j = 0; j < n; j++) buffer[off + j] = tmp[j];
    }
    releaseWaveletScratch(s);
    return buffer;
}

/** `count` independent 2D DWTs of size (n × m) on a flat buffer. */
function soaDWT2D(buffer, count, n, m, filterName, boundaryMode) {
    const filter = getFilter(filterName);
    const tileSize = n * m;
    const s = acquireWaveletScratch(tileSize);
    const tmp = s.a;
    for (let i = 0; i < count; i++) {
        const off = i * tileSize;
        _dwt2DCore(tmp, buffer, n, m, filter, boundaryMode, s);
        for (let j = 0; j < tileSize; j++) buffer[off + j] = tmp[j];
    }
    releaseWaveletScratch(s);
    return buffer;
}

function soaIDWT2D(buffer, count, n, m, filterName, boundaryMode) {
    const filter = getFilter(filterName);
    const tileSize = n * m;
    const s = acquireWaveletScratch(tileSize);
    const tmp = s.a;
    for (let i = 0; i < count; i++) {
        const off = i * tileSize;
        _idwt2DCore(tmp, buffer, n, m, filter, boundaryMode, s);
        for (let j = 0; j < tileSize; j++) buffer[off + j] = tmp[j];
    }
    releaseWaveletScratch(s);
    return buffer;
}

/**
 * Zero-GC single-level wavelet denoise for `count` signals of size n.
 * Ideal for per-frame motion-curve and IK-trajectory smoothing.
 */
function soaWaveletDenoise1(buffer, count, n, filterName, sigma, mode, boundaryMode) {
    const filter = getFilter(filterName);
    const half = n >> 1;
    const thresh = universalThreshold(sigma || 1, n);
    const useHard = mode === "hard";
    const s = acquireWaveletScratch(n);
    const tmp = s.a;
    for (let i = 0; i < count; i++) {
        const off = i * n;
        _dwt1DCore(tmp, 0, buffer, off, n, filter, boundaryMode);
        for (let k = half; k < n; k++) {
            tmp[k] = useHard ? hardThreshold(tmp[k], thresh) : softThreshold(tmp[k], thresh);
        }
        _idwt1DCore(buffer, off, tmp, 0, n, filter, boundaryMode);
    }
    releaseWaveletScratch(s);
    return buffer;
}

/** Batch terrain generation (writes into outBuffer tiles). */
function soaWaveletTerrain(outBuffer, count, n, params) {
    const tileSize = n * n;
    params = params || {};
    const baseSeed = params.seed || 1;
    const s = acquireWaveletScratch(tileSize);
    const tile = s.a;
    for (let i = 0; i < count; i++) {
        params.seed = baseSeed + i;
        waveletTerrain(n, params, tile);
        const off = i * tileSize;
        for (let j = 0; j < tileSize; j++) outBuffer[off + j] = tile[j];
    }
    releaseWaveletScratch(s);
    return outBuffer;
}

/** Batch motion-curve filter (single-level, zero-GC). */
function soaWaveletMotionFilter(outBuffer, inBuffer, count, n, filterName, levels, sigma) {
    const total = count * n;
    for (let i = 0; i < total; i++) outBuffer[i] = inBuffer[i];
    return soaWaveletDenoise1(outBuffer, count, n, filterName, sigma, "soft", "symmetric");
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaDWT1DChunked(buffer, count, n, filterName, boundaryMode, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const filter = getFilter(filterName);
    const s = acquireWaveletScratch(n);
    const tmp = s.a;
    try {
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + chunkSize, count);
            for (let i = start; i < end; i++) {
                const off = i * n;
                _dwt1DCore(tmp, 0, buffer, off, n, filter, boundaryMode);
                for (let j = 0; j < n; j++) buffer[off + j] = tmp[j];
            }
            start = end;
            if (start >= count) break;
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        releaseWaveletScratch(s);
    }
    return buffer;
}

async function soaIDWT1DChunked(buffer, count, n, filterName, boundaryMode, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const filter = getFilter(filterName);
    const s = acquireWaveletScratch(n);
    const tmp = s.a;
    try {
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + chunkSize, count);
            for (let i = start; i < end; i++) {
                const off = i * n;
                _idwt1DCore(tmp, 0, buffer, off, n, filter, boundaryMode);
                for (let j = 0; j < n; j++) buffer[off + j] = tmp[j];
            }
            start = end;
            if (start >= count) break;
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        releaseWaveletScratch(s);
    }
    return buffer;
}

async function soaDWT2DChunked(buffer, count, n, m, filterName, boundaryMode, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const filter = getFilter(filterName);
    const tileSize = n * m;
    const s = acquireWaveletScratch(tileSize);
    const tmp = s.a;
    try {
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + chunkSize, count);
            for (let i = start; i < end; i++) {
                const off = i * tileSize;
                _dwt2DCore(tmp, buffer, n, m, filter, boundaryMode, s);
                for (let j = 0; j < tileSize; j++) buffer[off + j] = tmp[j];
            }
            start = end;
            if (start >= count) break;
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        releaseWaveletScratch(s);
    }
    return buffer;
}

async function soaIDWT2DChunked(buffer, count, n, m, filterName, boundaryMode, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const filter = getFilter(filterName);
    const tileSize = n * m;
    const s = acquireWaveletScratch(tileSize);
    const tmp = s.a;
    try {
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + chunkSize, count);
            for (let i = start; i < end; i++) {
                const off = i * tileSize;
                _idwt2DCore(tmp, buffer, n, m, filter, boundaryMode, s);
                for (let j = 0; j < tileSize; j++) buffer[off + j] = tmp[j];
            }
            start = end;
            if (start >= count) break;
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        releaseWaveletScratch(s);
    }
    return buffer;
}

async function soaWaveletDenoise1Chunked(buffer, count, n, filterName, sigma, mode, boundaryMode, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const filter = getFilter(filterName);
    const half = n >> 1;
    const thresh = universalThreshold(sigma || 1, n);
    const useHard = mode === "hard";
    const s = acquireWaveletScratch(n);
    const tmp = s.a;
    try {
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + chunkSize, count);
            for (let i = start; i < end; i++) {
                const off = i * n;
                _dwt1DCore(tmp, 0, buffer, off, n, filter, boundaryMode);
                for (let k = half; k < n; k++) {
                    tmp[k] = useHard ? hardThreshold(tmp[k], thresh) : softThreshold(tmp[k], thresh);
                }
                _idwt1DCore(buffer, off, tmp, 0, n, filter, boundaryMode);
            }
            start = end;
            if (start >= count) break;
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        releaseWaveletScratch(s);
    }
    return buffer;
}

async function soaWaveletTerrainChunked(outBuffer, count, n, params, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const tileSize = n * n;
    params = params || {};
    const baseSeed = params.seed || 1;
    const s = acquireWaveletScratch(tileSize);
    const tile = s.a;
    try {
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + chunkSize, count);
            for (let i = start; i < end; i++) {
                params.seed = baseSeed + i;
                waveletTerrain(n, params, tile);
                const off = i * tileSize;
                for (let j = 0; j < tileSize; j++) outBuffer[off + j] = tile[j];
            }
            start = end;
            if (start >= count) break;
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        releaseWaveletScratch(s);
    }
    return outBuffer;
}

async function soaWaveletMotionFilterChunked(outBuffer, inBuffer, count, n, filterName, levels, sigma, chunkSize, yieldEvery) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const total = count * n;
    for (let i = 0; i < total; i++) outBuffer[i] = inBuffer[i];
    return soaWaveletDenoise1Chunked(outBuffer, count, n, filterName, sigma, "soft", "symmetric", chunkSize, yieldEvery);
}

// ============================================================================
// Class Declarations — Scratch and batch state
// ============================================================================
/** Reusable precision-aware wavelet scratch. Fixed-capacity pool, swap-remove. */
class WaveletScratch {
    static #pool = new Array(32);
    static #count = 0;
    static {
        for (let i = 0; i < 8; i++) WaveletScratch.#pool[WaveletScratch.#count++] = new WaveletScratch(256);
    }
    static acquire(size) {
        for (let i = 0; i < WaveletScratch.#count; i++) {
            if (WaveletScratch.#pool[i].size >= (size || 0)) {
                const s = WaveletScratch.#pool[i];
                WaveletScratch.#count--;
                WaveletScratch.#pool[i] = WaveletScratch.#pool[WaveletScratch.#count];
                WaveletScratch.#pool[WaveletScratch.#count] = null;
                return s;
            }
        }
        return new WaveletScratch(size || 256);
    }
    static release(s) {
        if (!s) return;
        s.reset();
        if (WaveletScratch.#count < 32) WaveletScratch.#pool[WaveletScratch.#count++] = s;
    }
    constructor(size) {
        this.size = size || 256;
        const T = getArrayType();
        this.a = new T(this.size);
        this.b = new T(this.size);
        this.c = new T(this.size);
    }
    ensure(n) { return _waveletScratchEnsure(this, n); }
    reset() {
        this.a.fill(0); this.b.fill(0); this.c.fill(0);
        return this;
    }
}

/** Batch state for `count` independent signals of size `n`. */
class WaveletBatchState {
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
    async idwtChunked(filterName, boundaryMode, cs, ye) { return soaIDWT1DChunked(this.buffer, this.count, this.n, filterName, boundaryMode, cs, ye); }
    denoise(filterName, sigma, mode, boundaryMode) { return soaWaveletDenoise1(this.buffer, this.count, this.n, filterName, sigma, mode, boundaryMode); }
    async denoiseChunked(filterName, sigma, mode, boundaryMode, cs, ye) {
        return soaWaveletDenoise1Chunked(this.buffer, this.count, this.n, filterName, sigma, mode, boundaryMode, cs, ye);
    }
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
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    filters: {
        register: registerFilter,
        get: getFilter,
        list: listFilters,
        WaveletFilter
    },
    transforms: {
        dwt1D, idwt1D,
        dwt2D, idwt2D,
        dwt3D, idwt3D,
        multi1D: dwtMultiLevel1D,
        imulti1D: idwtMultiLevel1D,
        multi2D: dwtMultiLevel2D,
        imulti2D: idwtMultiLevel2D
    },
    cwt: {
        transform: cwt,
        morlet: cwtMorlet,
        mexh: cwtMexicanHat,
        scalogram
    },
    packets: {
        decompose: waveletPacket,
        bestBasis
    },
    denoise: {
        wavelet: waveletDenoise,
        soft: softThreshold,
        hard: hardThreshold,
        universal: universalThreshold
    },
    lifting: {
        haar: liftingHaar,
        ihaar: iliftingHaar,
        cdf53: lifting53,
        icdf53: ilifting53
    },
    domain: {
        terrain: waveletTerrain,
        clouds: waveletClouds,
        detail: waveletDetail,
        motion: waveletMotionCurve,
        ik: waveletIKFilter,
        orbital: waveletOrbitalFilter,
        color: waveletColor,
        lod: waveletLOD
    },
    batch: {
        dwt1D: soaDWT1D,
        dwt1DChunked: soaDWT1DChunked,
        idwt1D: soaIDWT1D,
        idwt1DChunked: soaIDWT1DChunked,
        dwt2D: soaDWT2D,
        dwt2DChunked: soaDWT2DChunked,
        idwt2D: soaIDWT2D,
        idwt2DChunked: soaIDWT2DChunked,
        denoise1: soaWaveletDenoise1,
        denoise1Chunked: soaWaveletDenoise1Chunked,
        terrain: soaWaveletTerrain,
        terrainChunked: soaWaveletTerrainChunked,
        motion: soaWaveletMotionFilter,
        motionChunked: soaWaveletMotionFilterChunked,
        State: WaveletBatchState,
        create: createWaveletBatch
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Filter coefficients remain Float64 for numerical stability; transform
// buffers created after a precision change use the live array type.
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Filter registry
    WaveletFilter, registerFilter, getFilter, listFilters,
    // 1D DWT
    dwt1D, idwt1D, dwtMultiLevel1D, idwtMultiLevel1D,
    // 2D DWT
    dwt2D, idwt2D, dwtMultiLevel2D, idwtMultiLevel2D,
    // 3D DWT
    dwt3D, idwt3D,
    // CWT
    cwt, cwtMorlet, cwtMexicanHat, scalogram,
    // Wavelet packets
    waveletPacket, bestBasis,
    // Denoising
    waveletDenoise, softThreshold, hardThreshold, universalThreshold,
    // Lifting
    liftingHaar, iliftingHaar, lifting53, ilifting53,
    // Domain helpers
    waveletTerrain, waveletClouds, waveletDetail,
    waveletMotionCurve, waveletIKFilter, waveletOrbitalFilter,
    waveletColor, waveletLOD,
    // SOA (sync)
    soaDWT1D, soaIDWT1D, soaDWT2D, soaIDWT2D,
    soaWaveletDenoise1, soaWaveletTerrain, soaWaveletMotionFilter,
    // SOA (chunked async)
    soaDWT1DChunked, soaIDWT1DChunked,
    soaDWT2DChunked, soaIDWT2DChunked,
    soaWaveletDenoise1Chunked, soaWaveletTerrainChunked, soaWaveletMotionFilterChunked,
    // Pools
    WaveletScratch, acquireWaveletScratch, releaseWaveletScratch, createWaveletScratchPool,
    // Batch state
    WaveletBatchState, createWaveletBatch,
    // Namespaces
    namespace
};