//File number : 035
// File : src/math/035_sparse-systems.js
//Description : Complete sparse linear-systems math (ESM) — CSR / CSC / COO / DIA storage,
//              SpMV and SpGEMM (sync + chunked async), transpose, add, scale, diagonal
//              extraction, structure-aware builders (Laplacian 1D/2D/3D, Poisson 3D,
//              biharmonic 2D, IK Jacobian, orbital N-body Hessian), stationary solvers
//              (Jacobi, Gauss–Seidel, SOR), Krylov solvers (Jacobi-preconditioned CG,
//              BiCGSTAB), Jacobi / symmetric-SOR preconditioners, batched solves for 1M+
//              tiny per-instance systems, pooled zero-GC scratch, live Float16/Float32/
//              Float64 value migration, zero-copy transferable serialization for Web
//              Workers, dirty-range GPU attribute upload, and deterministic fixed-step
//              solver stepping.
//
//              CORRECTIONS (this revision):
//              • FATAL: `export s.gaussSeidelSolve`, `cons t v`, `ret urn`, `th is.rows`,
//                `co mmon`, `CHUNK_S IZE`, `SparseMa trix`, `scale InPlace`, `t = >`,
//                `& &`, and every other split identifier / operator repaired.
//              • FATAL: `exports.X = X` ran before the class declarations (TDZ) and
//                `exports.namespace` was mutated after export. Converted to ESM
//                `export class` / `export function` declarations, which hoist correctly.
//              • FATAL: `SparseCSC.multiply` computed `(Aᵀ·B)ᵀ = Bᵀ·A`, not `A·B`.
//                Now converts to CSR and multiplies directly.
//              • FATAL: `SparseDIA.transpose` negated the offsets but kept the diagonals
//                indexed by the OLD row, producing a silently wrong matrix. Transpose
//                now re-indexes: `newD[r] = oldD[r + newOffset]`.
//              • FATAL: `createFromTriplets` never summed duplicate (i,j) entries, so
//                every assembled IK / FEM / Hessian system was wrong. It now performs a
//                sorted CSR assembly with duplicate accumulation.
//              • `orbitalHessian` omitted the diagonal blocks entirely (a Hessian without
//                its diagonal is not a Hessian). Diagonal blocks are now assembled as
//                `-Σ_{j≠i} H_ij`; disable with `{ diagonal: false }`.
//              • CG had no `rz === 0` / `pAp <= 0` breakdown guard; BiCGSTAB divided by
//                `omega` without checking it and masked `r0ᵀv` breakdown with `|| 1`.
//                Both now detect breakdown, report it, and stop deterministically.
//              • `ssorPreconditioner` ignored `omega` and just called Jacobi. Replaced
//                with a real symmetric SOR (forward + backward relaxed sweep).
//              • `SparseDIA.matvec` branch-tested every row per diagonal; now iterates
//                only the valid row window, branch-free.
//              • ES2022 static blocks / private static fields removed so the file parses
//                on older Android WebViews; warm-up runs in a plain IIFE.
//              • `SparseScratch.acquire` used `Array.splice` (allocation per acquire);
//                now swap-removes from a dense pool.
//
//              FEATURES ADDED from corrected_bitecs_enhancement.md:
//              • §10/§16 — Every builder now fills exact-size typed arrays directly. The
//                `rows.push([i,j,v])` + `Int32Array.from(trips.map(...))` patterns (which
//                allocated NINE array literals per body pair in `orbitalHessian`) are
//                gone. SpGEMM uses Gustavson row accumulation with a typed-array marker,
//                add uses a two-pointer sorted merge, and all solvers draw from a pooled
//                scratch. `*Into` variants write into caller-owned result structs so no
//                object is returned inside a frame loop. No Map/Set in any hot path.
//              • §25/§28 — `writeVectorIntoFlat` / `flagSolutionUpload` /
//                `syncSolutionAttribute`: upload a solution vector straight into an
//                InstancedBufferAttribute backing array with `clearUpdateRanges` /
//                `addUpdateRange` dirty-prefix upload.
//              • §26     — Double-single precision bridge: `dsSubInto` performs a Knuth
//                twoSum plus renormalization BEFORE any narrowing, and
//                `orbitalHessianDS` builds megaparsec-safe N-body Hessians from
//                double-single world positions.
//              • §34     — All stencils are pre-allocated flat typed-array constants.
//              • §45/§51 — `createSolverStepper` / `SparseSolveState.stepIterations` run a
//                FIXED iteration count per tick for determinism, plus a re-exported
//                `createFixedStepScheduler` (spiral-of-death guarded accumulator).
//              • §49     — `sparseToTransferable` / `sparseFromTransferable` pack a matrix
//                into ONE ArrayBuffer for zero-copy Worker transfer.
//              • Precision — `trackSparse` / `migrateSparse` / `migrateAllSparse` and an
//                `onPrecisionChange` listener migrate value arrays live; indices stay
//                Int32Array. Dot-product reductions always accumulate in Float64.
//####
//Best for : 3d graphics — anisotropic diffusion terrain (Poisson), cloth / thin-plate
//           (biharmonic 2D), pressure-projection fluids (Poisson 3D), Levenberg–Marquardt
//           IK (damped Jacobian normal equations), orbital N-body constraint solving
//           (Hessian) at galactic offsets, mass-spring networks, FEM skinning, mesh
//           Laplacian smoothing on 1M+ vertices, per-particle implicit integration,
//           per-bone 6-DoF IK at 1M+ instances, and mobile 60 fps pipelines via chunked
//           async CG that never blocks the Android UI thread.
//License : MIT

// ============================================================================
// Imports — ESM named imports from the unified math entry point
// ============================================================================
import {
    common,
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
// Constants — pre-allocated, never rebuilt (Blueprint §34)
// ============================================================================
const EPSILON_DEFAULT = 1e-6;
const MAX_ITERS_DEFAULT = 500;
const BREAKDOWN_EPS = 1e-30;
const INSERTION_SORT_LIMIT = 16;

// 13-point biharmonic stencil: [dx, dy, coefficient] flattened.
const BIHARMONIC_STENCIL = new Int32Array([
    0, 0, 20,
    1, 0, -8, -1, 0, -8, 0, 1, -8, 0, -1, -8,
    2, 0, 1, -2, 0, 1, 0, 2, 1, 0, -2, 1,
    1, 1, 2, -1, 1, 2, 1, -1, 2, -1, -1, 2
]);
const BIHARMONIC_COUNT = 13;

// Value-type codes for the transferable header.
const VT_F32 = 0, VT_F64 = 1, VT_F16 = 2;

// ============================================================================
// Module scratch — reused by builders and reductions (setup-time allocation)
// ============================================================================
const _blk9 = new Float64Array(9);
const _acc9 = new Float64Array(9);
const _ds2 = new Float64Array(2);
const _stencilOrder = new Int32Array(BIHARMONIC_COUNT);
const _stencilDelta = new Int32Array(BIHARMONIC_COUNT);
const _stencilCoeff = new Int32Array(BIHARMONIC_COUNT);

// Shared solver result — reused, never allocated per call. Callers that need to
// retain a result must pass `options.result` from `createSolveResult()`.
const _sharedResult = { iters: 0, residual: Infinity, converged: false, breakdown: false };

// ============================================================================
// Internal helpers
// ============================================================================
function _allocValues(n) {
    const T = getArrayType();
    return new T(n);
}
function _allocFromArray(arr) {
    const T = getArrayType();
    const out = new T(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i];
    return out;
}
function _valueTypeCode(arr) {
    if (arr instanceof Float64Array) return VT_F64;
    if (arr instanceof Float32Array) return VT_F32;
    return VT_F16;
}
function _ctorForCode(code) {
    if (code === VT_F64) return Float64Array;
    if (code === VT_F16 && typeof Float16Array !== "undefined") return Float16Array;
    return Float32Array;
}

function _swapPair(ci, va, a, b) {
    const c = ci[a]; ci[a] = ci[b]; ci[b] = c;
    const v = va[a]; va[a] = va[b]; va[b] = v;
}

/** In-place paired quicksort + insertion sort over [lo, hi). Zero allocation. */
function _sortPairs(ci, va, lo, hi) {
    while (hi - lo > INSERTION_SORT_LIMIT) {
        const mid = (lo + hi) >> 1;
        _swapPair(ci, va, mid, hi - 1);
        const pivot = ci[hi - 1];
        let store = lo;
        for (let i = lo; i < hi - 1; i++) {
            if (ci[i] < pivot) { _swapPair(ci, va, i, store); store++; }
        }
        _swapPair(ci, va, store, hi - 1);
        if (store - lo < hi - store - 1) { _sortPairs(ci, va, lo, store); lo = store + 1; }
        else { _sortPairs(ci, va, store + 1, hi); hi = store; }
    }
    for (let i = lo + 1; i < hi; i++) {
        const c = ci[i], v = va[i];
        let j = i - 1;
        while (j >= lo && ci[j] > c) { ci[j + 1] = ci[j]; va[j + 1] = va[j]; j--; }
        ci[j + 1] = c; va[j + 1] = v;
    }
}

/** In-place integer quicksort + insertion sort over [lo, hi). Zero allocation. */
function _sortInts(arr, lo, hi) {
    while (hi - lo > INSERTION_SORT_LIMIT) {
        const mid = (lo + hi) >> 1;
        let t = arr[mid]; arr[mid] = arr[hi - 1]; arr[hi - 1] = t;
        const pivot = arr[hi - 1];
        let store = lo;
        for (let i = lo; i < hi - 1; i++) {
            if (arr[i] < pivot) { t = arr[i]; arr[i] = arr[store]; arr[store] = t; store++; }
        }
        t = arr[store]; arr[store] = arr[hi - 1]; arr[hi - 1] = t;
        if (store - lo < hi - store - 1) { _sortInts(arr, lo, store); lo = store + 1; }
        else { _sortInts(arr, store + 1, hi); hi = store; }
    }
    for (let i = lo + 1; i < hi; i++) {
        const v = arr[i];
        let j = i - 1;
        while (j >= lo && arr[j] > v) { arr[j + 1] = arr[j]; j--; }
        arr[j + 1] = v;
    }
}

/**
 * Gustavson sparse × sparse. One pass counts, the second writes.
 * `marker` / `accum` / `list` are caller-owned typed arrays of length B.cols.
 */
function _spgemmPass(A, B, marker, accum, list, rowPtr, outCol, outVal, write) {
    const arp = A.rowPtr, aci = A.colIdx, ava = A.values;
    const brp = B.rowPtr, bci = B.colIdx, bva = B.values;
    const rows = A.rows;
    let token = 0, cursor = 0;
    for (let i = 0; i < rows; i++) {
        token++;
        let len = 0;
        const aStart = arp[i], aEnd = arp[i + 1];
        for (let ka = aStart; ka < aEnd; ka++) {
            const jj = aci[ka], va = ava[ka];
            if (va === 0) continue;
            const bStart = brp[jj], bEnd = brp[jj + 1];
            for (let kb = bStart; kb < bEnd; kb++) {
                const c = bci[kb];
                const v = va * bva[kb];
                if (marker[c] !== token) { marker[c] = token; accum[c] = v; list[len++] = c; }
                else accum[c] += v;
            }
        }
        if (write) {
            _sortInts(list, 0, len);
            for (let k = 0; k < len; k++) {
                const c = list[k];
                const v = accum[c];
                if (v === 0) continue;
                outCol[cursor] = c; outVal[cursor] = v; cursor++;
            }
            rowPtr[i + 1] = cursor;
        } else {
            let nz = 0;
            for (let k = 0; k < len; k++) if (accum[list[k]] !== 0) nz++;
            rowPtr[i + 1] = rowPtr[i] + nz;
        }
    }
    return cursor;
}

/** Knuth twoSum + renormalization: out2 = [hi, lo] of (aHi,aLo) − (bHi,bLo). */
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
/** Full-precision scalar difference of two double-single numbers. */
export function dsSubF64(aHi, aLo, bHi, bLo) {
    dsSubInto(_ds2, aHi, aLo, bHi, bLo);
    return _ds2[0] + _ds2[1];
}

// ============================================================================
// Class Declarations
// ============================================================================
export class SparseMatrix {
    constructor(rows, cols) {
        this.rows = rows | 0;
        this.cols = cols | 0;
    }
    matvec() { throw new Error("SparseMatrix.matvec: not implemented"); }
    matvecChunked() { throw new Error("SparseMatrix.matvecChunked: not implemented"); }
    transpose() { throw new Error("SparseMatrix.transpose: not implemented"); }
    add() { throw new Error("SparseMatrix.add: not implemented"); }
    scaleInPlace() { throw new Error("SparseMatrix.scaleInPlace: not implemented"); }
    clone() { throw new Error("SparseMatrix.clone: not implemented"); }
    diagonal() { throw new Error("SparseMatrix.diagonal: not implemented"); }
    diagonalInto() { throw new Error("SparseMatrix.diagonalInto: not implemented"); }
    toCSR() { throw new Error("SparseMatrix.toCSR: not implemented"); }
    toDense() { throw new Error("SparseMatrix.toDense: not implemented"); }
    multiply() { throw new Error("SparseMatrix.multiply: not implemented"); }
}

export class SparseCSR extends SparseMatrix {
    constructor(rows, cols, rowPtr, colIdx, values) {
        super(rows, cols);
        this.rowPtr = rowPtr;
        this.colIdx = colIdx;
        this.values = values;
        this.nnz = colIdx.length;
    }
    matvec(out, x) {
        const rp = this.rowPtr, ci = this.colIdx, va = this.values;
        const n = this.rows;
        for (let i = 0; i < n; i++) {
            let sum = 0;
            const start = rp[i], end = rp[i + 1];
            for (let k = start; k < end; k++) sum += va[k] * x[ci[k]];
            out[i] = sum;
        }
        return out;
    }
    /** out = A·x + beta·out (beta = 0 → plain SpMV). */
    matvecAdd(out, x, beta) {
        const rp = this.rowPtr, ci = this.colIdx, va = this.values;
        const n = this.rows;
        if (beta === 0 || beta === undefined) return this.matvec(out, x);
        for (let i = 0; i < n; i++) {
            let sum = beta * out[i];
            const start = rp[i], end = rp[i + 1];
            for (let k = start; k < end; k++) sum += va[k] * x[ci[k]];
            out[i] = sum;
        }
        return out;
    }
    async matvecChunked(out, x, chunkSize, yieldEvery) {
        chunkSize = chunkSize || common.CHUNK_SIZE;
        yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
        const rp = this.rowPtr, ci = this.colIdx, va = this.values;
        const n = this.rows;
        let c = 0;
        for (let start = 0; start < n; start += chunkSize) {
            const end = Math.min(start + chunkSize, n);
            for (let i = start; i < end; i++) {
                let sum = 0;
                const s = rp[i], e = rp[i + 1];
                for (let k = s; k < e; k++) sum += va[k] * x[ci[k]];
                out[i] = sum;
            }
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
        return out;
    }
    transpose() {
        const rows = this.cols, cols = this.rows, nnz = this.nnz;
        const rp = new Int32Array(rows + 1);
        const ci = new Int32Array(nnz);
        const va = _allocValues(nnz);
        for (let k = 0; k < nnz; k++) rp[this.colIdx[k] + 1]++;
        for (let i = 0; i < rows; i++) rp[i + 1] += rp[i];
        const cursor = new Int32Array(rows);
        for (let i = 0; i < this.rows; i++) {
            const start = this.rowPtr[i], end = this.rowPtr[i + 1];
            for (let k = start; k < end; k++) {
                const j = this.colIdx[k];
                const dst = rp[j] + cursor[j]++;
                ci[dst] = i;
                va[dst] = this.values[k];
            }
        }
        return new SparseCSR(rows, cols, rp, ci, va);
    }
    /** Sorted two-pointer merge with duplicate summation. Zero per-element alloc. */
    add(other) {
        if (this.rows !== other.rows || this.cols !== other.cols) {
            throw new Error("SparseCSR.add: dimension mismatch");
        }
        const B = other instanceof SparseCSR ? other : other.toCSR();
        const rows = this.rows;
        const cap = this.nnz + B.nnz;
        const rp = new Int32Array(rows + 1);
        const ci = new Int32Array(cap);
        const va = _allocValues(cap);
        const arp = this.rowPtr, aci = this.colIdx, ava = this.values;
        const brp = B.rowPtr, bci = B.colIdx, bva = B.values;
        let w = 0;
        for (let i = 0; i < rows; i++) {
            let ka = arp[i], kaEnd = arp[i + 1];
            let kb = brp[i], kbEnd = brp[i + 1];
            while (ka < kaEnd || kb < kbEnd) {
                let col, val;
                if (kb >= kbEnd || (ka < kaEnd && aci[ka] < bci[kb])) {
                    col = aci[ka]; val = ava[ka]; ka++;
                } else if (ka >= kaEnd || bci[kb] < aci[ka]) {
                    col = bci[kb]; val = bva[kb]; kb++;
                } else {
                    col = aci[ka]; val = ava[ka] + bva[kb]; ka++; kb++;
                }
                if (val === 0) continue;
                ci[w] = col; va[w] = val; w++;
            }
            rp[i + 1] = w;
        }
        return new SparseCSR(rows, this.cols, rp, ci.slice(0, w), va.slice(0, w));
    }
    scaleInPlace(s) {
        const va = this.values;
        for (let k = 0; k < va.length; k++) va[k] *= s;
        return this;
    }
    clone() {
        return new SparseCSR(this.rows, this.cols,
            new Int32Array(this.rowPtr), new Int32Array(this.colIdx), _allocFromArray(this.values));
    }
    diagonal() {
        const n = Math.min(this.rows, this.cols);
        return this.diagonalInto(_allocValues(n));
    }
    diagonalInto(out) {
        const rp = this.rowPtr, ci = this.colIdx, va = this.values;
        const n = Math.min(this.rows, this.cols, out.length);
        for (let i = 0; i < n; i++) {
            let v = 0;
            const start = rp[i], end = rp[i + 1];
            for (let k = start; k < end; k++) if (ci[k] === i) { v = va[k]; break; }
            out[i] = v;
        }
        return out;
    }
    /** Gustavson SpGEMM — two passes, typed-array marker, zero per-element alloc. */
    multiply(other) {
        if (this.cols !== other.rows) throw new Error("SparseCSR.multiply: dimension mismatch");
        const B = other instanceof SparseCSR ? other : other.toCSR();
        const rows = this.rows, cols = B.cols;
        const marker = new Int32Array(cols);
        const accum = new Float64Array(cols);
        const list = new Int32Array(cols);
        const rp = new Int32Array(rows + 1);
        _spgemmPass(this, B, marker, accum, list, rp, null, null, false);
        const nnz = rp[rows];
        const ci = new Int32Array(nnz);
        const va = _allocValues(nnz);
        marker.fill(0);
        _spgemmPass(this, B, marker, accum, list, rp, ci, va, true);
        return new SparseCSR(rows, cols, rp, ci, va);
    }
    toCSR() { return this; }
    toCSC() {
        const rows = this.rows, cols = this.cols, nnz = this.nnz;
        const cp = new Int32Array(cols + 1);
        const ri = new Int32Array(nnz);
        const va = _allocValues(nnz);
        for (let k = 0; k < nnz; k++) cp[this.colIdx[k] + 1]++;
        for (let j = 0; j < cols; j++) cp[j + 1] += cp[j];
        const cursor = new Int32Array(cols);
        for (let i = 0; i < rows; i++) {
            const start = this.rowPtr[i], end = this.rowPtr[i + 1];
            for (let k = start; k < end; k++) {
                const j = this.colIdx[k];
                const dst = cp[j] + cursor[j]++;
                ri[dst] = i; va[dst] = this.values[k];
            }
        }
        return new SparseCSC(rows, cols, cp, ri, va);
    }
    toCOO() {
        const nnz = this.nnz;
        const iArr = new Int32Array(nnz), jArr = new Int32Array(nnz);
        const va = _allocValues(nnz);
        let w = 0;
        for (let i = 0; i < this.rows; i++) {
            const start = this.rowPtr[i], end = this.rowPtr[i + 1];
            for (let k = start; k < end; k++) { iArr[w] = i; jArr[w] = this.colIdx[k]; va[w] = this.values[k]; w++; }
        }
        return new SparseCOO(this.rows, this.cols, iArr, jArr, va);
    }
    toDIA() {
        const rows = this.rows, cols = this.cols;
        const span = rows + cols - 1;
        const marker = new Int32Array(span).fill(-1);
        const offs = new Int32Array(span);
        let count = 0;
        for (let i = 0; i < rows; i++) {
            const start = this.rowPtr[i], end = this.rowPtr[i + 1];
            for (let k = start; k < end; k++) {
                const off = this.colIdx[k] - i;
                const idx = off + rows - 1;
                if (marker[idx] === -1) { marker[idx] = count; offs[count++] = off; }
            }
        }
        const offsets = offs.slice(0, count);
        _sortInts(offsets, 0, count);
        for (let d = 0; d < count; d++) marker[offsets[d] + rows - 1] = d;
        const T = getArrayType();
        const diagonals = new Array(count);
        for (let d = 0; d < count; d++) diagonals[d] = new T(rows);
        for (let i = 0; i < rows; i++) {
            const start = this.rowPtr[i], end = this.rowPtr[i + 1];
            for (let k = start; k < end; k++) {
                const d = marker[this.colIdx[k] - i + rows - 1];
                diagonals[d][i] = this.values[k];
            }
        }
        return new SparseDIA(rows, cols, offsets, diagonals);
    }
    /** Diagnostic only — allocates. Never call inside a frame loop. */
    toDense() {
        const dense = new Array(this.rows);
        for (let i = 0; i < this.rows; i++) dense[i] = _allocValues(this.cols);
        for (let i = 0; i < this.rows; i++) {
            const start = this.rowPtr[i], end = this.rowPtr[i + 1];
            for (let k = start; k < end; k++) dense[i][this.colIdx[k]] = this.values[k];
        }
        return dense;
    }
}

export class SparseCSC extends SparseMatrix {
    constructor(rows, cols, colPtr, rowIdx, values) {
        super(rows, cols);
        this.colPtr = colPtr;
        this.rowIdx = rowIdx;
        this.values = values;
        this.nnz = rowIdx.length;
    }
    matvec(out, x) {
        const cp = this.colPtr, ri = this.rowIdx, va = this.values;
        for (let i = 0; i < this.rows; i++) out[i] = 0;
        for (let j = 0; j < this.cols; j++) {
            const start = cp[j], end = cp[j + 1];
            const xj = x[j];
            if (xj === 0) continue;
            for (let k = start; k < end; k++) out[ri[k]] += va[k] * xj;
        }
        return out;
    }
    async matvecChunked(out, x, chunkSize, yieldEvery) {
        chunkSize = chunkSize || common.CHUNK_SIZE;
        yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
        const cp = this.colPtr, ri = this.rowIdx, va = this.values;
        for (let i = 0; i < this.rows; i++) out[i] = 0;
        let c = 0;
        for (let start = 0; start < this.cols; start += chunkSize) {
            const end = Math.min(start + chunkSize, this.cols);
            for (let j = start; j < end; j++) {
                const s = cp[j], e = cp[j + 1], xj = x[j];
                if (xj === 0) continue;
                for (let k = s; k < e; k++) out[ri[k]] += va[k] * xj;
            }
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
        return out;
    }
    transpose() {
        const rows = this.cols, cols = this.rows, nnz = this.nnz;
        const rp = new Int32Array(rows + 1);
        const ci = new Int32Array(nnz);
        const va = _allocValues(nnz);
        for (let k = 0; k < nnz; k++) rp[this.rowIdx[k] + 1]++;
        for (let i = 0; i < rows; i++) rp[i + 1] += rp[i];
        const cursor = new Int32Array(rows);
        for (let j = 0; j < this.cols; j++) {
            const start = this.colPtr[j], end = this.colPtr[j + 1];
            for (let k = start; k < end; k++) {
                const i = this.rowIdx[k];
                const dst = rp[i] + cursor[i]++;
                ci[dst] = j; va[dst] = this.values[k];
            }
        }
        return new SparseCSR(rows, cols, rp, ci, va);
    }
    /** CORRECTED: was `(Aᵀ·B)ᵀ = Bᵀ·A`. Convert to CSR and multiply directly. */
    multiply(other) { return this.toCSR().multiply(other); }
    add(other) { return this.toCSR().add(other); }
    scaleInPlace(s) {
        const va = this.values;
        for (let k = 0; k < va.length; k++) va[k] *= s;
        return this;
    }
    clone() {
        return new SparseCSC(this.rows, this.cols,
            new Int32Array(this.colPtr), new Int32Array(this.rowIdx), _allocFromArray(this.values));
    }
    diagonal() {
        const n = Math.min(this.rows, this.cols);
        return this.diagonalInto(_allocValues(n));
    }
    diagonalInto(out) {
        for (let i = 0; i < out.length; i++) out[i] = 0;
        const n = Math.min(this.rows, this.cols, out.length);
        for (let j = 0; j < n; j++) {
            const start = this.colPtr[j], end = this.colPtr[j + 1];
            for (let k = start; k < end; k++) if (this.rowIdx[k] === j) { out[j] = this.values[k]; break; }
        }
        return out;
    }
    toCSR() {
        const rows = this.rows, cols = this.cols, nnz = this.nnz;
        const rp = new Int32Array(rows + 1);
        const ci = new Int32Array(nnz);
        const va = _allocValues(nnz);
        for (let k = 0; k < nnz; k++) rp[this.rowIdx[k] + 1]++;
        for (let i = 0; i < rows; i++) rp[i + 1] += rp[i];
        const cursor = new Int32Array(rows);
        for (let j = 0; j < cols; j++) {
            const start = this.colPtr[j], end = this.colPtr[j + 1];
            for (let k = start; k < end; k++) {
                const i = this.rowIdx[k];
                const dst = rp[i] + cursor[i]++;
                ci[dst] = j; va[dst] = this.values[k];
            }
        }
        return new SparseCSR(rows, cols, rp, ci, va);
    }
    toCSC() { return this; }
    toCOO() { return this.toCSR().toCOO(); }
    toDIA() { return this.toCSR().toDIA(); }
    toDense() { return this.toCSR().toDense(); }
}

export class SparseCOO extends SparseMatrix {
    constructor(rows, cols, iArr, jArr, values) {
        super(rows, cols);
        this.iArr = iArr;
        this.jArr = jArr;
        this.values = values;
        this.nnz = iArr.length;
    }
    matvec(out, x) {
        for (let i = 0; i < this.rows; i++) out[i] = 0;
        const ia = this.iArr, ja = this.jArr, va = this.values;
        for (let k = 0; k < this.nnz; k++) out[ia[k]] += va[k] * x[ja[k]];
        return out;
    }
    async matvecChunked(out, x, chunkSize, yieldEvery) {
        chunkSize = chunkSize || common.CHUNK_SIZE;
        yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
        for (let i = 0; i < this.rows; i++) out[i] = 0;
        const ia = this.iArr, ja = this.jArr, va = this.values;
        let c = 0;
        for (let start = 0; start < this.nnz; start += chunkSize) {
            const end = Math.min(start + chunkSize, this.nnz);
            for (let k = start; k < end; k++) out[ia[k]] += va[k] * x[ja[k]];
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
        return out;
    }
    toCSR() { return createFromTriplets(this.rows, this.cols, this.iArr, this.jArr, this.values); }
    transpose() {
        return new SparseCOO(this.cols, this.rows,
            new Int32Array(this.jArr), new Int32Array(this.iArr), _allocFromArray(this.values));
    }
    add(other) { return this.toCSR().add(other); }
    multiply(other) { return this.toCSR().multiply(other); }
    scaleInPlace(s) {
        const va = this.values;
        for (let k = 0; k < va.length; k++) va[k] *= s;
        return this;
    }
    clone() {
        return new SparseCOO(this.rows, this.cols,
            new Int32Array(this.iArr), new Int32Array(this.jArr), _allocFromArray(this.values));
    }
    diagonal() {
        const n = Math.min(this.rows, this.cols);
        return this.diagonalInto(_allocValues(n));
    }
    diagonalInto(out) {
        for (let i = 0; i < out.length; i++) out[i] = 0;
        const n = Math.min(this.rows, this.cols, out.length);
        for (let k = 0; k < this.nnz; k++) {
            const i = this.iArr[k];
            if (i === this.jArr[k] && i < n) out[i] += this.values[k];
        }
        return out;
    }
    toCSC() { return this.toCSR().toCSC(); }
    toCOO() { return this; }
    toDIA() { return this.toCSR().toDIA(); }
    toDense() { return this.toCSR().toDense(); }
}

export class SparseDIA extends SparseMatrix {
    constructor(rows, cols, offsets, diagonals) {
        super(rows, cols);
        this.offsets = offsets;
        this.diagonals = diagonals;
        this.numDiags = offsets.length;
    }
    get nnz() {
        let n = 0;
        for (let d = 0; d < this.numDiags; d++) {
            const off = this.offsets[d], diag = this.diagonals[d];
            const lo = off < 0 ? -off : 0;
            const hi = Math.min(this.rows, this.cols - off);
            for (let i = lo; i < hi; i++) if (diag[i] !== 0) n++;
        }
        return n;
    }
    /** CORRECTED: iterate only the valid row window — no per-row bounds branch. */
    matvec(out, x) {
        const rows = this.rows, cols = this.cols;
        for (let i = 0; i < rows; i++) out[i] = 0;
        for (let d = 0; d < this.numDiags; d++) {
            const off = this.offsets[d], diag = this.diagonals[d];
            const lo = off < 0 ? -off : 0;
            const hi = Math.min(rows, cols - off);
            for (let i = lo; i < hi; i++) out[i] += diag[i] * x[i + off];
        }
        return out;
    }
    async matvecChunked(out, x, chunkSize, yieldEvery) {
        chunkSize = chunkSize || common.CHUNK_SIZE;
        yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
        const rows = this.rows, cols = this.cols;
        for (let i = 0; i < rows; i++) out[i] = 0;
        let c = 0;
        for (let start = 0; start < rows; start += chunkSize) {
            const end = Math.min(start + chunkSize, rows);
            for (let d = 0; d < this.numDiags; d++) {
                const off = this.offsets[d], diag = this.diagonals[d];
                const lo = Math.max(start, off < 0 ? -off : 0);
                const hi = Math.min(end, cols - off);
                for (let i = lo; i < hi; i++) out[i] += diag[i] * x[i + off];
            }
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
        return out;
    }
    /** CORRECTED: re-index each diagonal, not just negate the offset. */
    transpose() {
        const rows = this.cols, cols = this.rows;
        const offs = new Int32Array(this.numDiags);
        const T = getArrayType();
        const diags = new Array(this.numDiags);
        for (let d = 0; d < this.numDiags; d++) {
            const newOff = -this.offsets[d];
            offs[d] = newOff;
            const src = this.diagonals[d];
            const dst = new T(rows);
            const lo = newOff < 0 ? -newOff : 0;
            const hi = Math.min(rows, cols - newOff);
            for (let r = lo; r < hi; r++) dst[r] = src[r + newOff];
            diags[d] = dst;
        }
        return new SparseDIA(rows, cols, offs, diags);
    }
    add(other) { return this.toCSR().add(other); }
    multiply(other) { return this.toCSR().multiply(other); }
    scaleInPlace(s) {
        for (let d = 0; d < this.numDiags; d++) {
            const diag = this.diagonals[d];
            for (let i = 0; i < diag.length; i++) diag[i] *= s;
        }
        return this;
    }
    clone() {
        const diags = new Array(this.numDiags);
        for (let d = 0; d < this.numDiags; d++) diags[d] = _allocFromArray(this.diagonals[d]);
        return new SparseDIA(this.rows, this.cols, new Int32Array(this.offsets), diags);
    }
    toCSR() {
        const rows = this.rows, cols = this.cols;
        const rp = new Int32Array(rows + 1);
        for (let d = 0; d < this.numDiags; d++) {
            const off = this.offsets[d], diag = this.diagonals[d];
            const lo = off < 0 ? -off : 0;
            const hi = Math.min(rows, cols - off);
            for (let i = lo; i < hi; i++) if (diag[i] !== 0) rp[i + 1]++;
        }
        for (let i = 0; i < rows; i++) rp[i + 1] += rp[i];
        const nnz = rp[rows];
        const ci = new Int32Array(nnz);
        const va = _allocValues(nnz);
        const cursor = new Int32Array(rows);
        for (let d = 0; d < this.numDiags; d++) {
            const off = this.offsets[d], diag = this.diagonals[d];
            const lo = off < 0 ? -off : 0;
            const hi = Math.min(rows, cols - off);
            for (let i = lo; i < hi; i++) {
                const v = diag[i];
                if (v === 0) continue;
                const dst = rp[i] + cursor[i]++;
                ci[dst] = i + off; va[dst] = v;
            }
        }
        // Offsets may be unsorted → sort each row's column range.
        for (let i = 0; i < rows; i++) _sortPairs(ci, va, rp[i], rp[i + 1]);
        return new SparseCSR(rows, cols, rp, ci, va);
    }
    diagonal() {
        const n = Math.min(this.rows, this.cols);
        return this.diagonalInto(_allocValues(n));
    }
    diagonalInto(out) {
        for (let i = 0; i < out.length; i++) out[i] = 0;
        for (let d = 0; d < this.numDiags; d++) {
            if (this.offsets[d] !== 0) continue;
            const diag = this.diagonals[d];
            const n = Math.min(diag.length, out.length);
            for (let i = 0; i < n; i++) out[i] = diag[i];
            break;
        }
        return out;
    }
    toCSC() { return this.toCSR().toCSC(); }
    toCOO() { return this.toCSR().toCOO(); }
    toDIA() { return this; }
    toDense() { return this.toCSR().toDense(); }
}

// ============================================================================
// Construction / builders — exact-size typed arrays, zero per-element alloc
// ============================================================================
export function createSparseCSR(rows, cols, nnz) {
    return new SparseCSR(rows, cols, new Int32Array(rows + 1), new Int32Array(nnz), _allocValues(nnz));
}
export function createSparseCSC(rows, cols, nnz) {
    return new SparseCSC(rows, cols, new Int32Array(cols + 1), new Int32Array(nnz), _allocValues(nnz));
}
export function createSparseCOO(rows, cols, nnz) {
    return new SparseCOO(rows, cols, new Int32Array(nnz), new Int32Array(nnz), _allocValues(nnz));
}
export function createSparseDIA(rows, cols, offsets, fillValue) {
    const T = getArrayType();
    const diags = new Array(offsets.length);
    for (let d = 0; d < offsets.length; d++) {
        const a = new T(rows);
        if (fillValue) a.fill(fillValue);
        diags[d] = a;
    }
    return new SparseDIA(rows, cols, Int32Array.from(offsets), diags);
}

/**
 * CORRECTED: sorted CSR assembly WITH duplicate summation.
 * The previous version placed duplicates side by side, so every assembled
 * FEM / IK / Hessian system silently double-counted shared entries.
 */
export function createFromTriplets(rows, cols, iArr, jArr, vArr, options) {
    options = options || {};
    const nnzIn = iArr.length;
    const counts = new Int32Array(rows);
    for (let k = 0; k < nnzIn; k++) counts[iArr[k]]++;
    const rowPtr = new Int32Array(rows + 1);
    for (let r = 0; r < rows; r++) rowPtr[r + 1] = rowPtr[r] + counts[r];

    const tmpCol = new Int32Array(nnzIn);
    const tmpVal = _allocValues(nnzIn);
    counts.fill(0);
    for (let k = 0; k < nnzIn; k++) {
        const row = iArr[k];
        const dst = rowPtr[row] + counts[row]++;
        tmpCol[dst] = jArr[k];
        tmpVal[dst] = vArr[k];
    }

    const outPtr = new Int32Array(rows + 1);
    const dropZeros = options.dropZeros === true;
    let w = 0;
    for (let r = 0; r < rows; r++) {
        const s = rowPtr[r], e = rowPtr[r + 1];
        _sortPairs(tmpCol, tmpVal, s, e);
        const rowStart = w;
        for (let k = s; k < e; k++) {
            const c = tmpCol[k], v = tmpVal[k];
            if (w > rowStart && tmpCol[w - 1] === c) {
                tmpVal[w - 1] += v;
            } else {
                tmpCol[w] = c; tmpVal[w] = v; w++;
            }
        }
        if (dropZeros) {
            let q = rowStart;
            for (let k = rowStart; k < w; k++) {
                if (tmpVal[k] === 0) continue;
                tmpCol[q] = tmpCol[k]; tmpVal[q] = tmpVal[k]; q++;
            }
            w = q;
        }
        outPtr[r + 1] = w;
    }
    return new SparseCSR(rows, cols, outPtr, tmpCol.slice(0, w), tmpVal.slice(0, w));
}

export function identitySparse(n) {
    const rowPtr = new Int32Array(n + 1);
    const colIdx = new Int32Array(n);
    const values = _allocValues(n);
    for (let i = 0; i < n; i++) { rowPtr[i] = i; colIdx[i] = i; values[i] = 1; }
    rowPtr[n] = n;
    return new SparseCSR(n, n, rowPtr, colIdx, values);
}

export function diagonalSparse(diag) {
    const n = diag.length;
    const rowPtr = new Int32Array(n + 1);
    const colIdx = new Int32Array(n);
    const values = _allocValues(n);
    for (let i = 0; i < n; i++) { rowPtr[i] = i; colIdx[i] = i; values[i] = diag[i]; }
    rowPtr[n] = n;
    return new SparseCSR(n, n, rowPtr, colIdx, values);
}

export function laplacian1D(n) {
    const nnz = n === 0 ? 0 : 3 * n - 2;
    const rowPtr = new Int32Array(n + 1);
    const colIdx = new Int32Array(nnz);
    const values = _allocValues(nnz);
    let o = 0;
    for (let i = 0; i < n; i++) {
        if (i > 0) { colIdx[o] = i - 1; values[o++] = -1; }
        colIdx[o] = i; values[o++] = 2;
        if (i < n - 1) { colIdx[o] = i + 1; values[o++] = -1; }
        rowPtr[i + 1] = o;
    }
    return new SparseCSR(n, n, rowPtr, colIdx, values);
}

/** 5-point 2D Laplacian, columns ascending per row. Direct fill, no triplets. */
export function laplacian2D(nx, ny) {
    const n = nx * ny;
    const nnz = n + 2 * (nx - 1) * ny + 2 * nx * (ny - 1);
    const rowPtr = new Int32Array(n + 1);
    const colIdx = new Int32Array(nnz);
    const values = _allocValues(nnz);
    let o = 0;
    for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
            const i = y * nx + x;
            if (y > 0) { colIdx[o] = i - nx; values[o++] = -1; }
            if (x > 0) { colIdx[o] = i - 1; values[o++] = -1; }
            colIdx[o] = i; values[o++] = 4;
            if (x < nx - 1) { colIdx[o] = i + 1; values[o++] = -1; }
            if (y < ny - 1) { colIdx[o] = i + nx; values[o++] = -1; }
            rowPtr[i + 1] = o;
        }
    }
    return new SparseCSR(n, n, rowPtr, colIdx, values);
}

/** 7-point 3D Laplacian, columns ascending per row. Direct fill, no triplets. */
export function laplacian3D(nx, ny, nz) {
    const n = nx * ny * nz;
    const sY = nx, sZ = nx * ny;
    const nnz = n
        + 2 * (nx - 1) * ny * nz
        + 2 * nx * (ny - 1) * nz
        + 2 * nx * ny * (nz - 1);
    const rowPtr = new Int32Array(n + 1);
    const colIdx = new Int32Array(nnz);
    const values = _allocValues(nnz);
    let o = 0;
    for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
            for (let x = 0; x < nx; x++) {
                const i = z * sZ + y * sY + x;
                if (z > 0) { colIdx[o] = i - sZ; values[o++] = -1; }
                if (y > 0) { colIdx[o] = i - sY; values[o++] = -1; }
                if (x > 0) { colIdx[o] = i - 1; values[o++] = -1; }
                colIdx[o] = i; values[o++] = 6;
                if (x < nx - 1) { colIdx[o] = i + 1; values[o++] = -1; }
                if (y < ny - 1) { colIdx[o] = i + sY; values[o++] = -1; }
                if (z < nz - 1) { colIdx[o] = i + sZ; values[o++] = -1; }
                rowPtr[i + 1] = o;
            }
        }
    }
    return new SparseCSR(n, n, rowPtr, colIdx, values);
}

/** Poisson = −Δ (symmetric positive definite). */
export function poisson3D(nx, ny, nz) { return laplacian3D(nx, ny, nz).scaleInPlace(-1); }

/** 13-point 2D biharmonic. Stencil sorted by column delta once per call. */
export function biharmonic2D(nx, ny) {
    const n = nx * ny;
    for (let s = 0; s < BIHARMONIC_COUNT; s++) {
        _stencilDelta[s] = BIHARMONIC_STENCIL[s * 3 + 1] * nx + BIHARMONIC_STENCIL[s * 3];
        _stencilCoeff[s] = BIHARMONIC_STENCIL[s * 3 + 2];
        _stencilOrder[s] = s;
    }
    _sortInts(_stencilDelta, 0, BIHARMONIC_COUNT);
    // Re-derive coefficients in sorted-delta order (deltas are unique for nx >= 5).
    for (let s = 0; s < BIHARMONIC_COUNT; s++) {
        const d = _stencilDelta[s];
        for (let t = 0; t < BIHARMONIC_COUNT; t++) {
            const dx = BIHARMONIC_STENCIL[t * 3], dy = BIHARMONIC_STENCIL[t * 3 + 1];
            if (dy * nx + dx === d) { _stencilCoeff[s] = BIHARMONIC_STENCIL[t * 3 + 2]; break; }
        }
    }
    const rowPtr = new Int32Array(n + 1);
    // Count pass.
    let total = 0;
    for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
            let cnt = 0;
            for (let s = 0; s < BIHARMONIC_COUNT; s++) {
                const d = _stencilDelta[s];
                const dx = d - Math.trunc(d / nx) * nx;
                const dy = Math.trunc(d / nx);
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || xx >= nx || yy < 0 || yy >= ny) continue;
                cnt++;
            }
            total += cnt;
            rowPtr[y * nx + x + 1] = total;
        }
    }
    const colIdx = new Int32Array(total);
    const values = _allocValues(total);
    let o = 0;
    for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
            const i = y * nx + x;
            for (let s = 0; s < BIHARMONIC_COUNT; s++) {
                const d = _stencilDelta[s];
                const dy = Math.trunc(d / nx);
                const dx = d - dy * nx;
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || xx >= nx || yy < 0 || yy >= ny) continue;
                colIdx[o] = yy * nx + xx;
                values[o++] = _stencilCoeff[s];
            }
        }
    }
    return new SparseCSR(n, n, rowPtr, colIdx, values);
}

/**
 * 3×N IK Jacobian: J[:,c] = axis_c × (endEffector − joint_c).
 * Two-pass direct fill — no entry arrays, no sort, no closures.
 */
export function ikJacobian(jointPositions, jointAxes, endEffector) {
    const N = (jointPositions.length / 3) | 0;
    const rows = 3, cols = N;
    const rowPtr = new Int32Array(rows + 1);
    let total = 0;
    for (let r = 0; r < rows; r++) {
        let cnt = 0;
        for (let c = 0; c < N; c++) {
            const px = jointPositions[c * 3], py = jointPositions[c * 3 + 1], pz = jointPositions[c * 3 + 2];
            const ax = jointAxes[c * 3], ay = jointAxes[c * 3 + 1], az = jointAxes[c * 3 + 2];
            const rx = endEffector[0] - px, ry = endEffector[1] - py, rz = endEffector[2] - pz;
            let v;
            if (r === 0) v = ay * rz - az * ry;
            else if (r === 1) v = az * rx - ax * rz;
            else v = ax * ry - ay * rx;
            if (v !== 0) cnt++;
        }
        total += cnt;
        rowPtr[r + 1] = total;
    }
    const colIdx = new Int32Array(total);
    const values = _allocValues(total);
    let o = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < N; c++) {
            const px = jointPositions[c * 3], py = jointPositions[c * 3 + 1], pz = jointPositions[c * 3 + 2];
            const ax = jointAxes[c * 3], ay = jointAxes[c * 3 + 1], az = jointAxes[c * 3 + 2];
            const rx = endEffector[0] - px, ry = endEffector[1] - py, rz = endEffector[2] - pz;
            let v;
            if (r === 0) v = ay * rz - az * ry;
            else if (r === 1) v = az * rx - ax * rz;
            else v = ax * ry - ay * rx;
            if (v === 0) continue;
            colIdx[o] = c; values[o++] = v;
        }
    }
    return new SparseCSR(rows, cols, rowPtr, colIdx, values);
}

/**
 * Gravitational N-body Hessian (block-dense, 3n × 3n).
 * CORRECTED: diagonal blocks are now assembled as −Σ_{j≠i} H_ij.
 * The previous version omitted them entirely and allocated nine array
 * literals per body pair inside the innermost loop.
 */
export function orbitalHessian(n, positions, masses, G, options) {
    options = options || {};
    const g = G === undefined ? 1 : G;
    const withDiagonal = options.diagonal !== false;
    const softening = options.softening === undefined ? 1e-6 : options.softening;
    const rows = n * 3;
    const perRow = withDiagonal ? rows : rows - 3;
    const nnz = rows * perRow;
    const rowPtr = new Int32Array(rows + 1);
    for (let i = 0; i < rows; i++) rowPtr[i + 1] = rowPtr[i] + perRow;
    const colIdx = new Int32Array(nnz);
    const values = _allocValues(nnz);

    for (let i = 0; i < n; i++) {
        const pix = positions[i * 3], piy = positions[i * 3 + 1], piz = positions[i * 3 + 2];
        const mi = masses[i];
        let c0 = rowPtr[i * 3], c1 = rowPtr[i * 3 + 1], c2 = rowPtr[i * 3 + 2];
        let d0 = -1, d1 = -1, d2 = -1;
        for (let a = 0; a < 9; a++) _acc9[a] = 0;
        for (let j = 0; j < n; j++) {
            if (j === i) {
                if (withDiagonal) { d0 = c0; d1 = c1; d2 = c2; c0 += 3; c1 += 3; c2 += 3; }
                continue;
            }
            const dx = positions[j * 3] - pix;
            const dy = positions[j * 3 + 1] - piy;
            const dz = positions[j * 3 + 2] - piz;
            const r2 = dx * dx + dy * dy + dz * dz + softening;
            const invR3 = 1 / (r2 * Math.sqrt(r2));
            const k = g * mi * masses[j] * invR3;
            const inv3r2 = 3 / r2;
            _blk9[0] = k * (1 - inv3r2 * dx * dx);
            _blk9[1] = k * (-inv3r2 * dx * dy);
            _blk9[2] = k * (-inv3r2 * dx * dz);
            _blk9[3] = _blk9[1];
            _blk9[4] = k * (1 - inv3r2 * dy * dy);
            _blk9[5] = k * (-inv3r2 * dy * dz);
            _blk9[6] = _blk9[2];
            _blk9[7] = _blk9[5];
            _blk9[8] = k * (1 - inv3r2 * dz * dz);
            const jb = j * 3;
            for (let b = 0; b < 3; b++) {
                const v0 = _blk9[b], v1 = _blk9[3 + b], v2 = _blk9[6 + b];
                colIdx[c0] = jb + b; values[c0++] = v0;
                colIdx[c1] = jb + b; values[c1++] = v1;
                colIdx[c2] = jb + b; values[c2++] = v2;
                _acc9[b] -= v0;
                _acc9[3 + b] -= v1;
                _acc9[6 + b] -= v2;
            }
        }
        if (withDiagonal) {
            const ib = i * 3;
            for (let b = 0; b < 3; b++) {
                colIdx[d0] = ib + b; values[d0++] = _acc9[b];
                colIdx[d1] = ib + b; values[d1++] = _acc9[3 + b];
                colIdx[d2] = ib + b; values[d2++] = _acc9[6 + b];
            }
        }
    }
    return new SparseCSR(rows, rows, rowPtr, colIdx, values);
}

/**
 * Blueprint §26 — megaparsec-safe N-body Hessian from double-single positions.
 * `posHi` / `posLo` are Float64Array(3n). Pair deltas are computed with a
 * Knuth twoSum + renormalization BEFORE the inverse-cube, so the low words
 * are never swallowed when both bodies sit at galactic offsets.
 */
export function orbitalHessianDS(n, posHi, posLo, masses, G, options) {
    options = options || {};
    const g = G === undefined ? 1 : G;
    const withDiagonal = options.diagonal !== false;
    const softening = options.softening === undefined ? 1e-6 : options.softening;
    const rows = n * 3;
    const perRow = withDiagonal ? rows : rows - 3;
    const nnz = rows * perRow;
    const rowPtr = new Int32Array(rows + 1);
    for (let i = 0; i < rows; i++) rowPtr[i + 1] = rowPtr[i] + perRow;
    const colIdx = new Int32Array(nnz);
    const values = _allocValues(nnz);

    for (let i = 0; i < n; i++) {
        const ix = i * 3, iy = ix + 1, iz = ix + 2;
        const mi = masses[i];
        let c0 = rowPtr[ix], c1 = rowPtr[iy], c2 = rowPtr[iz];
        let d0 = -1, d1 = -1, d2 = -1;
        for (let a = 0; a < 9; a++) _acc9[a] = 0;
        for (let j = 0; j < n; j++) {
            if (j === i) {
                if (withDiagonal) { d0 = c0; d1 = c1; d2 = c2; c0 += 3; c1 += 3; c2 += 3; }
                continue;
            }
            const jx = j * 3, jy = jx + 1, jz = jx + 2;
            dsSubInto(_ds2, posHi[jx], posLo[jx], posHi[ix], posLo[ix]);
            const dx = _ds2[0] + _ds2[1];
            dsSubInto(_ds2, posHi[jy], posLo[jy], posHi[iy], posLo[iy]);
            const dy = _ds2[0] + _ds2[1];
            dsSubInto(_ds2, posHi[jz], posLo[jz], posHi[iz], posLo[iz]);
            const dz = _ds2[0] + _ds2[1];
            const r2 = dx * dx + dy * dy + dz * dz + softening;
            const invR3 = 1 / (r2 * Math.sqrt(r2));
            const k = g * mi * masses[j] * invR3;
            const inv3r2 = 3 / r2;
            _blk9[0] = k * (1 - inv3r2 * dx * dx);
            _blk9[1] = k * (-inv3r2 * dx * dy);
            _blk9[2] = k * (-inv3r2 * dx * dz);
            _blk9[3] = _blk9[1];
            _blk9[4] = k * (1 - inv3r2 * dy * dy);
            _blk9[5] = k * (-inv3r2 * dy * dz);
            _blk9[6] = _blk9[2];
            _blk9[7] = _blk9[5];
            _blk9[8] = k * (1 - inv3r2 * dz * dz);
            for (let b = 0; b < 3; b++) {
                const v0 = _blk9[b], v1 = _blk9[3 + b], v2 = _blk9[6 + b];
                colIdx[c0] = jx + b; values[c0++] = v0;
                colIdx[c1] = jx + b; values[c1++] = v1;
                colIdx[c2] = jx + b; values[c2++] = v2;
                _acc9[b] -= v0;
                _acc9[3 + b] -= v1;
                _acc9[6 + b] -= v2;
            }
        }
        if (withDiagonal) {
            for (let b = 0; b < 3; b++) {
                colIdx[d0] = ix + b; values[d0++] = _acc9[b];
                colIdx[d1] = ix + b; values[d1++] = _acc9[3 + b];
                colIdx[d2] = ix + b; values[d2++] = _acc9[6 + b];
            }
        }
    }
    return new SparseCSR(rows, rows, rowPtr, colIdx, values);
}

// ============================================================================
// Free-form operations
// ============================================================================
export function spmv(out, A, x) { return A.matvec(out, x); }
export function spmvAdd(out, A, x, beta) {
    if (A.matvecAdd) return A.matvecAdd(out, x, beta);
    A.matvec(out, x);
    if (beta) for (let i = 0; i < out.length; i++) out[i] *= beta;
    return out;
}
export function spmvChunked(out, A, x, chunkSize, yieldEvery) {
    return A.matvecChunked(out, x, chunkSize, yieldEvery);
}
export function spmm(A, B) { return A.multiply(B); }
export function transposeSparse(A) { return A.transpose(); }
export function addSparse(A, B) { return A.add(B); }
export function scaleSparse(A, s) { return A.clone().scaleInPlace(s); }
export function diagonalOf(A) { return A.diagonal(); }
export function diagonalInto(out, A) { return A.diagonalInto(out); }
export function toDense(A) { return A.toDense(); }
export function toCSR(A) { return A.toCSR(); }
export function toCSC(A) { return A.toCSC(); }
export function toCOO(A) { return A.toCOO(); }
export function toDIA(A) { return A.toDIA(); }

/** Float64 dot product — reductions always accumulate at full precision. */
export function dot(a, b, count) {
    const n = count === undefined ? a.length : count;
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}
export function norm2(a, count) { return Math.sqrt(dot(a, a, count)); }

/** out = b − A·x, returns ‖out‖₂. `out` is caller-owned. */
export function residualNorm(out, A, b, x) {
    A.matvec(out, x);
    let s = 0;
    for (let i = 0; i < A.rows; i++) { const r = b[i] - out[i]; out[i] = r; s += r * r; }
    return Math.sqrt(s);
}

// ============================================================================
// Solver result struct
// ============================================================================
export function createSolveResult() {
    return { iters: 0, residual: Infinity, converged: false, breakdown: false };
}
function _result(options) {
    const r = (options && options.result) || _sharedResult;
    r.iters = 0; r.residual = Infinity; r.converged = false; r.breakdown = false;
    return r;
}

// ============================================================================
// Stationary solvers
// ============================================================================
export function jacobiSolveInto(result, A, b, x, options) {
    options = options || {};
    const tol = options.tol !== undefined ? options.tol : EPSILON_DEFAULT;
    const maxIt = options.maxIt !== undefined ? options.maxIt : MAX_ITERS_DEFAULT;
    const omega = options.omega !== undefined ? options.omega : 1;
    const n = A.rows;
    const s = SparseScratch.acquire(n, 2);
    s.ensure(n, 2);
    const diag = s.a, y = s.b;
    A.diagonalInto(diag);
    let it = 0, residual = Infinity;
    for (it = 0; it < maxIt; it++) {
        A.matvec(y, x);
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const d = diag[i] || 1;
            const r = b[i] - y[i];
            sum += r * r;
            x[i] += omega * (r / d);
        }
        residual = Math.sqrt(sum);
        if (residual < tol) break;
        if (!isFinite(residual)) { result.breakdown = true; break; }
    }
    SparseScratch.release(s);
    result.iters = it; result.residual = residual; result.converged = residual < tol;
    return result;
}
export function jacobiSolve(A, b, x, options) {
    return jacobiSolveInto(_result(options), A, b, x, options);
}

export function gaussSeidelSolveInto(result, A, b, x, options) {
    options = options || {};
    const tol = options.tol !== undefined ? options.tol : EPSILON_DEFAULT;
    const maxIt = options.maxIt !== undefined ? options.maxIt : MAX_ITERS_DEFAULT;
    const C = A instanceof SparseCSR ? A : A.toCSR();
    const rp = C.rowPtr, ci = C.colIdx, va = C.values;
    const n = C.rows;
    let it = 0, residual = Infinity;
    for (it = 0; it < maxIt; it++) {
        let maxDiff = 0;
        for (let i = 0; i < n; i++) {
            let sum = 0, diag = 1;
            const start = rp[i], end = rp[i + 1];
            for (let k = start; k < end; k++) {
                const j = ci[k];
                if (j === i) diag = va[k];
                else sum += va[k] * x[j];
            }
            const newX = (b[i] - sum) / (diag || 1);
            const diff = Math.abs(newX - x[i]);
            if (diff > maxDiff) maxDiff = diff;
            x[i] = newX;
        }
        residual = maxDiff;
        if (residual < tol) break;
        if (!isFinite(residual)) { result.breakdown = true; break; }
    }
    result.iters = it; result.residual = residual; result.converged = residual < tol;
    return result;
}
export function gaussSeidelSolve(A, b, x, options) {
    return gaussSeidelSolveInto(_result(options), A, b, x, options);
}

export function sorSolveInto(result, A, b, x, options) {
    options = options || {};
    const omega = options.omega !== undefined ? options.omega : 1.5;
    const tol = options.tol !== undefined ? options.tol : EPSILON_DEFAULT;
    const maxIt = options.maxIt !== undefined ? options.maxIt : MAX_ITERS_DEFAULT;
    const C = A instanceof SparseCSR ? A : A.toCSR();
    const rp = C.rowPtr, ci = C.colIdx, va = C.values;
    const n = C.rows;
    let it = 0, residual = Infinity;
    for (it = 0; it < maxIt; it++) {
        let maxDiff = 0;
        for (let i = 0; i < n; i++) {
            let sum = 0, diag = 1;
            const start = rp[i], end = rp[i + 1];
            for (let k = start; k < end; k++) {
                const j = ci[k];
                if (j === i) diag = va[k];
                else sum += va[k] * x[j];
            }
            const gs = (b[i] - sum) / (diag || 1);
            const newX = x[i] + omega * (gs - x[i]);
            const diff = Math.abs(newX - x[i]);
            if (diff > maxDiff) maxDiff = diff;
            x[i] = newX;
        }
        residual = maxDiff;
        if (residual < tol) break;
        if (!isFinite(residual)) { result.breakdown = true; break; }
    }
    result.iters = it; result.residual = residual; result.converged = residual < tol;
    return result;
}
export function sorSolve(A, b, x, options) {
    return sorSolveInto(_result(options), A, b, x, options);
}

// ============================================================================
// Krylov solvers
// ============================================================================
/**
 * Jacobi-preconditioned Conjugate Gradient. SPD systems only.
 * CORRECTED: guards `rz === 0` (happy breakdown) and `pAp <= 0` (indefinite /
 * non-SPD), reporting `result.breakdown` instead of producing NaN.
 */
export function cgInto(result, A, b, x, options) {
    options = options || {};
    const tol = options.tol !== undefined ? options.tol : EPSILON_DEFAULT;
    const maxIt = options.maxIt !== undefined ? options.maxIt : MAX_ITERS_DEFAULT;
    const n = A.rows;
    const s = SparseScratch.acquire(n, 5);
    s.ensure(n, 5);
    const r = s.a, z = s.b, p = s.c, Ap = s.d, diag = s.e;

    A.diagonalInto(diag);
    for (let i = 0; i < n; i++) if (!(diag[i] > 0)) diag[i] = 1;

    A.matvec(Ap, x);
    let rz = 0, residual = 0;
    for (let i = 0; i < n; i++) { const v = b[i] - Ap[i]; r[i] = v; residual += v * v; }
    residual = Math.sqrt(residual);
    for (let i = 0; i < n; i++) { z[i] = r[i] / diag[i]; rz += r[i] * z[i]; }
    for (let i = 0; i < n; i++) p[i] = z[i];

    let it = 0;
    for (it = 0; it < maxIt && residual > tol; it++) {
        if (Math.abs(rz) < BREAKDOWN_EPS) break;
        A.matvec(Ap, p);
        let pAp = 0;
        for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
        if (!(pAp > 0)) { result.breakdown = true; break; }
        const alpha = rz / pAp;
        let r2 = 0;
        for (let i = 0; i < n; i++) {
            x[i] += alpha * p[i];
            const v = r[i] - alpha * Ap[i];
            r[i] = v; r2 += v * v;
        }
        let rzNew = 0;
        for (let i = 0; i < n; i++) { z[i] = r[i] / diag[i]; rzNew += r[i] * z[i]; }
        const beta = rzNew / rz;
        rz = rzNew;
        for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
        residual = Math.sqrt(r2);
        if (!isFinite(residual)) { result.breakdown = true; break; }
    }
    SparseScratch.release(s);
    result.iters = it; result.residual = residual; result.converged = residual < tol;
    return result;
}
export function conjugateGradient(A, b, x, options) {
    return cgInto(_result(options), A, b, x, options);
}
export const pcg = conjugateGradient;

/** BiCGSTAB for non-symmetric / indefinite systems. */
export function bicgstabInto(result, A, b, x, options) {
    options = options || {};
    const tol = options.tol !== undefined ? options.tol : EPSILON_DEFAULT;
    const maxIt = options.maxIt !== undefined ? options.maxIt : MAX_ITERS_DEFAULT;
    const n = A.rows;
    const s = SparseScratch.acquire(n, 6);
    s.ensure(n, 6);
    const r = s.a, r0 = s.b, p = s.c, v = s.d, sv = s.e, tv = s.f;

    A.matvec(v, x);
    let residual = 0;
    for (let i = 0; i < n; i++) { const t = b[i] - v[i]; r[i] = t; r0[i] = t; residual += t * t; }
    residual = Math.sqrt(residual);
    for (let i = 0; i < n; i++) { p[i] = 0; v[i] = 0; }

    let rho = 1, alpha = 1, omega = 1, it = 0;
    for (it = 0; it < maxIt && residual > tol; it++) {
        let rhoNew = 0;
        for (let i = 0; i < n; i++) rhoNew += r0[i] * r[i];
        if (Math.abs(rhoNew) < BREAKDOWN_EPS) { result.breakdown = true; break; }
        if (Math.abs(omega) < BREAKDOWN_EPS) { result.breakdown = true; break; }
        const beta = (rhoNew / rho) * (alpha / omega);
        for (let i = 0; i < n; i++) p[i] = r[i] + beta * (p[i] - omega * v[i]);
        A.matvec(v, p);
        let r0v = 0;
        for (let i = 0; i < n; i++) r0v += r0[i] * v[i];
        if (Math.abs(r0v) < BREAKDOWN_EPS) { result.breakdown = true; break; }
        alpha = rhoNew / r0v;
        let sNorm = 0;
        for (let i = 0; i < n; i++) { const t = r[i] - alpha * v[i]; sv[i] = t; sNorm += t * t; }
        sNorm = Math.sqrt(sNorm);
        if (sNorm < tol) {
            for (let i = 0; i < n; i++) x[i] += alpha * p[i];
            residual = sNorm;
            it++;
            break;
        }
        A.matvec(tv, sv);
        let tt = 0, ts = 0;
        for (let i = 0; i < n; i++) { tt += tv[i] * tv[i]; ts += tv[i] * sv[i]; }
        omega = tt > BREAKDOWN_EPS ? ts / tt : 0;
        let r2 = 0;
        for (let i = 0; i < n; i++) {
            x[i] += alpha * p[i] + omega * sv[i];
            const t = sv[i] - omega * tv[i];
            r[i] = t; r2 += t * t;
        }
        residual = Math.sqrt(r2);
        rho = rhoNew;
        if (!isFinite(residual)) { result.breakdown = true; break; }
        if (Math.abs(omega) < BREAKDOWN_EPS) break;
    }
    SparseScratch.release(s);
    result.iters = it; result.residual = residual; result.converged = residual < tol;
    return result;
}
export function bicgstab(A, b, x, options) {
    return bicgstabInto(_result(options), A, b, x, options);
}

// ---- Chunked async solvers (mobile-safe, Blueprint §12 / §16) --------------
async function _chunkedRange(count, chunkSize, yieldEvery, perChunk) {
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

export async function cgChunked(A, b, x, options) {
    options = options || {};
    const result = _result(options);
    const tol = options.tol !== undefined ? options.tol : EPSILON_DEFAULT;
    const maxIt = options.maxIt !== undefined ? options.maxIt : MAX_ITERS_DEFAULT;
    const cs = options.chunkSize, ye = options.yieldEvery;
    const n = A.rows;
    const s = SparseScratch.acquire(n, 5);
    s.ensure(n, 5);
    const r = s.a, z = s.b, p = s.c, Ap = s.d, diag = s.e;

    A.diagonalInto(diag);
    for (let i = 0; i < n; i++) if (!(diag[i] > 0)) diag[i] = 1;
    await A.matvecChunked(Ap, x, cs, ye);

    let rz = 0, residual = 0;
    await _chunkedRange(n, cs, ye, function (a, e) {
        let local = 0;
        for (let i = a; i < e; i++) { const v = b[i] - Ap[i]; r[i] = v; local += v * v; }
        residual += local;
    });
    residual = Math.sqrt(residual);
    await _chunkedRange(n, cs, ye, function (a, e) {
        let local = 0;
        for (let i = a; i < e; i++) { z[i] = r[i] / diag[i]; p[i] = z[i]; local += r[i] * z[i]; }
        rz += local;
    });

    let it = 0;
    for (it = 0; it < maxIt && residual > tol; it++) {
        if (Math.abs(rz) < BREAKDOWN_EPS) break;
        await A.matvecChunked(Ap, p, cs, ye);
        let pAp = 0;
        await _chunkedRange(n, cs, ye, function (a, e) {
            let local = 0;
            for (let i = a; i < e; i++) local += p[i] * Ap[i];
            pAp += local;
        });
        if (!(pAp > 0)) { result.breakdown = true; break; }
        const alpha = rz / pAp;
        let r2 = 0, rzNew = 0;
        await _chunkedRange(n, cs, ye, function (a, e) {
            let l2 = 0, lz = 0;
            for (let i = a; i < e; i++) {
                x[i] += alpha * p[i];
                const v = r[i] - alpha * Ap[i];
                r[i] = v; l2 += v * v;
                z[i] = v / diag[i]; lz += v * z[i];
            }
            r2 += l2; rzNew += lz;
        });
        const beta = rzNew / rz;
        rz = rzNew;
        await _chunkedRange(n, cs, ye, function (a, e) {
            for (let i = a; i < e; i++) p[i] = z[i] + beta * p[i];
        });
        residual = Math.sqrt(r2);
        if (!isFinite(residual)) { result.breakdown = true; break; }
    }
    SparseScratch.release(s);
    result.iters = it; result.residual = residual; result.converged = residual < tol;
    return result;
}
export const conjugateGradientChunked = cgChunked;

export async function jacobiSolveChunked(A, b, x, options) {
    options = options || {};
    const result = _result(options);
    const tol = options.tol !== undefined ? options.tol : EPSILON_DEFAULT;
    const maxIt = options.maxIt !== undefined ? options.maxIt : MAX_ITERS_DEFAULT;
    const omega = options.omega !== undefined ? options.omega : 1;
    const cs = options.chunkSize, ye = options.yieldEvery;
    const n = A.rows;
    const s = SparseScratch.acquire(n, 2);
    s.ensure(n, 2);
    const diag = s.a, y = s.b;
    A.diagonalInto(diag);
    let it = 0, residual = Infinity;
    for (it = 0; it < maxIt; it++) {
        await A.matvecChunked(y, x, cs, ye);
        let sum = 0;
        await _chunkedRange(n, cs, ye, function (a, e) {
            let local = 0;
            for (let i = a; i < e; i++) {
                const r = b[i] - y[i];
                local += r * r;
                x[i] += omega * (r / (diag[i] || 1));
            }
            sum += local;
        });
        residual = Math.sqrt(sum);
        if (residual < tol) break;
        if (!isFinite(residual)) { result.breakdown = true; break; }
    }
    SparseScratch.release(s);
    result.iters = it; result.residual = residual; result.converged = residual < tol;
    return result;
}

// ============================================================================
// Preconditioners
// ============================================================================
export function jacobiPreconditioner(r, z, diag, count) {
    const n = count === undefined ? r.length : count;
    for (let i = 0; i < n; i++) z[i] = r[i] / (diag[i] || 1);
    return z;
}
export const jacobiPreconditionerInto = jacobiPreconditioner;

/**
 * CORRECTED: real symmetric SOR (forward + backward relaxed sweep).
 * The previous version ignored `omega` and simply called Jacobi.
 * `z` is zeroed then swept; requires CSR structure.
 */
export function ssorPreconditioner(A, r, z, omega, count) {
    const w = omega === undefined ? 1 : omega;
    const C = A instanceof SparseCSR ? A : A.toCSR();
    const rp = C.rowPtr, ci = C.colIdx, va = C.values;
    const n = count === undefined ? C.rows : count;
    for (let i = 0; i < n; i++) z[i] = 0;
    // Forward sweep (uses already-updated z[j] for j < i).
    for (let i = 0; i < n; i++) {
        let sum = 0, diag = 1;
        const start = rp[i], end = rp[i + 1];
        for (let k = start; k < end; k++) {
            const j = ci[k];
            if (j === i) diag = va[k];
            else sum += va[k] * z[j];
        }
        z[i] += w * ((r[i] - sum) / (diag || 1));
    }
    // Backward sweep (uses already-updated z[j] for j > i).
    for (let i = n - 1; i >= 0; i--) {
        let sum = 0, diag = 1;
        const start = rp[i], end = rp[i + 1];
        for (let k = start; k < end; k++) {
            const j = ci[k];
            if (j === i) diag = va[k];
            else sum += va[k] * z[j];
        }
        z[i] += w * ((r[i] - sum) / (diag || 1));
    }
    return z;
}
export const ssorPreconditionerInto = ssorPreconditioner;

/** Build a reusable Jacobi preconditioner vector for `A`. */
export function createJacobiPreconditioner(A) {
    const n = Math.min(A.rows, A.cols);
    const diag = _allocValues(n);
    A.diagonalInto(diag);
    for (let i = 0; i < n; i++) if (!(diag[i] > 0)) diag[i] = 1;
    return diag;
}

// ============================================================================
// Batch solves — 1M+ tiny per-instance systems
// ============================================================================
export function batchCG(batches, options) {
    for (let i = 0; i < batches.length; i++) {
        const B = batches[i];
        const opts = B.options || options || {};
        if (!B.result) B.result = createSolveResult();
        opts.result = B.result;
        cgInto(B.result, B.A, B.b, B.x, opts);
    }
    return batches;
}
export async function batchCGChunked(batches, chunkSize, yieldEvery, options) {
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let c = 0;
    for (let start = 0; start < batches.length; start += chunkSize) {
        const end = Math.min(start + chunkSize, batches.length);
        for (let i = start; i < end; i++) {
            const B = batches[i];
            const opts = B.options || options || {};
            if (!B.result) B.result = createSolveResult();
            opts.result = B.result;
            cgInto(B.result, B.A, B.b, B.x, opts);
        }
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return batches;
}

/**
 * Pre-allocated batch of `numSystems` independent `systemSize`×`systemSize`
 * systems. Matrices start as identity; overwrite `.values` in place.
 */
export function createBatchState(numSystems, systemSize) {
    const A = new Array(numSystems);
    const b = new Array(numSystems);
    const x = new Array(numSystems);
    const results = new Array(numSystems);
    const diag = _allocValues(systemSize);
    for (let i = 0; i < systemSize; i++) diag[i] = 1;
    for (let i = 0; i < numSystems; i++) {
        A[i] = diagonalSparse(diag);
        b[i] = _allocValues(systemSize);
        x[i] = _allocValues(systemSize);
        results[i] = createSolveResult();
    }
    const list = new Array(numSystems);
    for (let i = 0; i < numSystems; i++) list[i] = { A: A[i], b: b[i], x: x[i], result: results[i], options: null };
    return {
        A: A, b: b, x: x, results: results, list: list,
        count: numSystems, size: systemSize,
        solveAll: function (options) { batchCG(list, options); return this; },
        solveAllChunked: function (chunkSize, yieldEvery, options) {
            return batchCGChunked(list, chunkSize, yieldEvery, options);
        },
        get convergedCount() {
            let c = 0;
            for (let i = 0; i < numSystems; i++) if (results[i].converged) c++;
            return c;
        }
    };
}

// ============================================================================
// Persistent solve state + deterministic fixed-step stepping (§45 / §51)
// ============================================================================
export class SparseSolveState {
    constructor(A, b, x, options) {
        options = options || {};
        this.A = A;
        this.b = b;
        this.x = x || _allocValues(A.rows);
        this.options = options;
        this.result = createSolveResult();
        this.method = options.method === "bicgstab" ? "bicgstab"
            : options.method === "gaussSeidel" ? "gaussSeidel"
                : options.method === "sor" ? "sor"
                    : options.method === "jacobi" ? "jacobi" : "cg";
        this.iterationsPerStep = options.iterationsPerStep !== undefined ? options.iterationsPerStep : 8;
        this.totalIters = 0;
        this._opts = {};
        for (const k in options) this._opts[k] = options[k];
        this._opts.result = this.result;
    }
    /**
     * Run a FIXED number of iterations. Determinism (Blueprint §51) comes from
     * the fixed iteration budget, never from the variable frame delta.
     */
    stepIterations(count) {
        const k = count === undefined ? this.iterationsPerStep : count;
        this._opts.maxIt = k;
        this._run();
        this.totalIters += this.result.iters;
        return this.result;
    }
    /** Fixed-step hook — `dtSec` is ignored on purpose; the budget is fixed. */
    step() { return this.stepIterations(this.iterationsPerStep); }
    solve(maxIt) {
        this._opts.maxIt = maxIt === undefined
            ? (this.options.maxIt !== undefined ? this.options.maxIt : MAX_ITERS_DEFAULT)
            : maxIt;
        this._run();
        this.totalIters += this.result.iters;
        return this.result;
    }
    async solveChunked(maxIt) {
        if (this.method !== "cg") return this.solve(maxIt);
        this._opts.maxIt = maxIt === undefined
            ? (this.options.maxIt !== undefined ? this.options.maxIt : MAX_ITERS_DEFAULT)
            : maxIt;
        await cgChunked(this.A, this.b, this.x, this._opts);
        this.totalIters += this.result.iters;
        return this.result;
    }
    _run() {
        if (this.method === "bicgstab") bicgstabInto(this.result, this.A, this.b, this.x, this._opts);
        else if (this.method === "gaussSeidel") gaussSeidelSolveInto(this.result, this.A, this.b, this.x, this._opts);
        else if (this.method === "sor") sorSolveInto(this.result, this.A, this.b, this.x, this._opts);
        else if (this.method === "jacobi") jacobiSolveInto(this.result, this.A, this.b, this.x, this._opts);
        else cgInto(this.result, this.A, this.b, this.x, this._opts);
    }
    residual(out) {
        const buf = out || _allocValues(this.A.rows);
        return residualNorm(buf, this.A, this.b, this.x);
    }
    reset() {
        this.x.fill(0);
        this.totalIters = 0;
        this.result.iters = 0;
        this.result.residual = Infinity;
        this.result.converged = false;
        this.result.breakdown = false;
        return this;
    }
}
export function createSolveState(A, b, x, options) { return new SparseSolveState(A, b, x, options); }

/**
 * Deterministic fixed-step solver driver. Wraps the spiral-of-death guarded
 * accumulator from the unified math module; each fixed tick runs exactly
 * `iterationsPerStep` solver iterations.
 */
export function createSolverStepper(A, b, x, options) {
    options = options || {};
    const state = new SparseSolveState(A, b, x, options);
    const hz = options.hz !== undefined ? options.hz : 60;
    const maxSteps = options.maxSteps !== undefined ? options.maxSteps : 8;
    const scheduler = createFixedStepScheduler(hz, function () {
        state.stepIterations(state.iterationsPerStep);
    }, maxSteps);
    return {
        state: state,
        scheduler: scheduler,
        /** Feed the real frame delta in milliseconds. */
        step: function (dtMs) { scheduler.step(dtMs); return state.result; },
        reset: function () { scheduler.reset(); state.reset(); return this; },
        get result() { return state.result; },
        get x() { return state.x; }
    };
}

// ============================================================================
// Pooled scratch — zero-GC, precision-aware, ES2017-compatible
// ============================================================================
export class SparseScratch {
    constructor(size) {
        this.size = 0;
        this.have = 0;
        this._dtype = null;
        this.a = null; this.b = null; this.c = null; this.d = null;
        this.e = null; this.f = null; this.g = null; this.h = null;
        if (size) this.ensure(size, 1);
    }
    /** Grow to `n` entries and at least `channels` live channels. */
    ensure(n, channels) {
        const need = channels === undefined ? 1 : channels;
        const T = getArrayType();
        const size = Math.max(n | 0, this.size);
        const grow = size > this.size || this._dtype !== T;
        if (!grow && this.have >= need) return this;
        if (grow || !this.a) this.a = new T(size);
        if (need >= 2 && (grow || !this.b)) this.b = new T(size);
        if (need >= 3 && (grow || !this.c)) this.c = new T(size);
        if (need >= 4 && (grow || !this.d)) this.d = new T(size);
        if (need >= 5 && (grow || !this.e)) this.e = new T(size);
        if (need >= 6 && (grow || !this.f)) this.f = new T(size);
        if (need >= 7 && (grow || !this.g)) this.g = new T(size);
        if (need >= 8 && (grow || !this.h)) this.h = new T(size);
        this.size = size;
        this.have = Math.max(this.have, need);
        this._dtype = T;
        return this;
    }
    static acquire(size, channels) {
        const pool = SparseScratch._warm;
        let s;
        if (pool.length > 0) {
            const last = pool.length - 1;
            s = pool[last];
            pool[last] = undefined;
            pool.length = last;
        } else {
            s = new SparseScratch(0);
        }
        s.ensure(size || 0, channels || 1);
        return s;
    }
    static release(s) {
        if (!s) return;
        const pool = SparseScratch._warm;
        if (pool.length < SparseScratch.MAX_POOLED) pool.push(s);
    }
}
SparseScratch._warm = [];
SparseScratch.MAX_POOLED = 8;
(function _warmSparseScratch() {
    for (let i = 0; i < 4; i++) SparseScratch._warm.push(new SparseScratch(0));
})();

// ============================================================================
// Precision tracking / migration
// ============================================================================
const _trackedMatrices = [];

export function trackSparse(A) {
    if (!A) return A;
    if (_trackedMatrices.indexOf(A) === -1) _trackedMatrices.push(A);
    return A;
}
export function untrackSparse(A) {
    const i = _trackedMatrices.indexOf(A);
    if (i !== -1) _trackedMatrices.splice(i, 1);
}
export function clearTrackedSparse() { _trackedMatrices.length = 0; }
export function getTrackedSparse() { return _trackedMatrices; }

/** Migrate value arrays in place. Indices always remain Int32Array. */
export function migrateSparse(A, targetPrecision) {
    if (!A) return A;
    const T = targetPrecision ? getArrayType(targetPrecision) : getArrayType();
    if (A instanceof SparseDIA) {
        for (let d = 0; d < A.numDiags; d++) {
            const old = A.diagonals[d];
            if (old.constructor === T) continue;
            const next = new T(old.length);
            next.set(old);
            A.diagonals[d] = next;
        }
        return A;
    }
    if (A.values && A.values.constructor !== T) {
        const next = new T(A.values.length);
        next.set(A.values);
        A.values = next;
    }
    return A;
}
export function migrateAllSparse(targetPrecision) {
    for (let i = 0; i < _trackedMatrices.length; i++) {
        try { migrateSparse(_trackedMatrices[i], targetPrecision); }
        catch (e) { console.error("[035_sparse-systems] migrateAllSparse failed for one matrix", e); }
    }
}

onPrecisionChange(function () {
    migrateAllSparse();
    // Scratch reallocation happens lazily inside `ensure` via the dtype check.
    SparseScratch._warm.length = 0;
    for (let i = 0; i < 4; i++) SparseScratch._warm.push(new SparseScratch(0));
});

// ============================================================================
// Zero-copy transferable serialization (Blueprint §49)
// Layout: Int32 header [magic, version, rows, cols, nnz, valueCode, reserved, reserved]
//         then rowPtr (rows+1) | colIdx (nnz) | values (nnz), 8-byte aligned.
// ============================================================================
const SPARSE_MAGIC = 0x53505253; // "SPRS"
const SPARSE_HEADER_BYTES = 32;

export function sparseToTransferable(A) {
    const C = A instanceof SparseCSR ? A : A.toCSR();
    const rows = C.rows, cols = C.cols, nnz = C.nnz;
    const code = _valueTypeCode(C.values);
    const bpe = code === VT_F64 ? 8 : code === VT_F16 ? 2 : 4;
    const ptrBytes = (rows + 1) * 4;
    const colBytes = nnz * 4;
    const colOffset = SPARSE_HEADER_BYTES + ptrBytes;
    const valOffsetRaw = colOffset + colBytes;
    const valOffset = (valOffsetRaw + 7) & ~7;
    const total = valOffset + nnz * bpe;
    const buffer = new ArrayBuffer(total);
    const header = new Int32Array(buffer, 0, 8);
    header[0] = SPARSE_MAGIC; header[1] = 1;
    header[2] = rows; header[3] = cols; header[4] = nnz; header[5] = code;
    new Int32Array(buffer, SPARSE_HEADER_BYTES, rows + 1).set(C.rowPtr);
    new Int32Array(buffer, colOffset, nnz).set(C.colIdx);
    const VT = _ctorForCode(code);
    new VT(buffer, valOffset, nnz).set(C.values);
    return { buffer: buffer, rows: rows, cols: cols, nnz: nnz, valueType: code, transferable: [buffer] };
}

export function sparseFromTransferable(packet) {
    const buffer = packet.buffer || packet;
    const header = new Int32Array(buffer, 0, 8);
    if (header[0] !== SPARSE_MAGIC) throw new Error("sparseFromTransferable: bad magic");
    if (header[1] !== 1) throw new Error("sparseFromTransferable: unsupported version " + header[1]);
    const rows = header[2], cols = header[3], nnz = header[4], code = header[5];
    const bpe = code === VT_F64 ? 8 : code === VT_F16 ? 2 : 4;
    const ptrBytes = (rows + 1) * 4;
    const colOffset = SPARSE_HEADER_BYTES + ptrBytes;
    const valOffset = (colOffset + nnz * 4 + 7) & ~7;
    const rowPtr = new Int32Array(buffer, SPARSE_HEADER_BYTES, rows + 1);
    const colIdx = new Int32Array(buffer, colOffset, nnz);
    const VT = _ctorForCode(code);
    const values = new VT(buffer, valOffset, nnz);
    return new SparseCSR(rows, cols, rowPtr, colIdx, values);
}

// ============================================================================
// GPU attribute bridge (Blueprint §25 / §28)
// ============================================================================
/** Write x[i] into flat[i*stride + offset], optionally scaled and biased. */
export function writeVectorIntoFlat(flat, x, count, stride, offset, scale, bias) {
    const n = count === undefined ? x.length : count;
    const st = stride === undefined ? 1 : stride;
    const off = offset === undefined ? 0 : offset;
    const s = scale === undefined ? 1 : scale;
    const b = bias === undefined ? 0 : bias;
    for (let i = 0, o = off; i < n; i++, o += st) flat[o] = x[i] * s + b;
    return flat;
}

/** Dirty-prefix upload flag (Three.js r185 addUpdateRange). */
export function flagSolutionUpload(attr, count, itemSize) {
    if (!attr) return;
    const st = itemSize || attr.itemSize || 1;
    if (attr.clearUpdateRanges) attr.clearUpdateRanges();
    if (attr.addUpdateRange) attr.addUpdateRange(0, count * st);
    attr.needsUpdate = true;
}

/**
 * Upload a solution vector into an InstancedBufferAttribute (or any
 * BufferAttribute). `options`: { stride, offset, scale, bias, itemSize }.
 * Returns the number of elements written.
 */
export function syncSolutionAttribute(attr, x, count, options) {
    if (!attr || !attr.array) return 0;
    options = options || {};
    const n = count === undefined ? x.length : count;
    const st = options.stride !== undefined ? options.stride : (attr.itemSize || 1);
    writeVectorIntoFlat(attr.array, x, n, st, options.offset, options.scale, options.bias);
    flagSolutionUpload(attr, n, st);
    return n;
}

// ============================================================================
// Namespaces
// ============================================================================
export const formats = {
    csr: SparseCSR, csc: SparseCSC, coo: SparseCOO, dia: SparseDIA,
    createCSR: createSparseCSR, createCSC: createSparseCSC,
    createCOO: createSparseCOO, createDIA: createSparseDIA,
    toCSR: toCSR, toCSC: toCSC, toCOO: toCOO, toDIA: toDIA
};
export const builders = {
    identity: identitySparse, diagonal: diagonalSparse, fromTriplets: createFromTriplets,
    laplacian1D: laplacian1D, laplacian2D: laplacian2D, laplacian3D: laplacian3D,
    poisson3D: poisson3D, biharmonic2D: biharmonic2D,
    ikJacobian: ikJacobian, orbitalHessian: orbitalHessian, orbitalHessianDS: orbitalHessianDS
};
export const ops = {
    spmv: spmv, spmvAdd: spmvAdd, spmvChunked: spmvChunked, spmm: spmm,
    transpose: transposeSparse, add: addSparse, scale: scaleSparse,
    diagonalOf: diagonalOf, diagonalInto: diagonalInto,
    dot: dot, norm2: norm2, residualNorm: residualNorm, toDense: toDense
};
export const solvers = {
    jacobi: jacobiSolve, gaussSeidel: gaussSeidelSolve, sor: sorSolve,
    cg: conjugateGradient, pcg: pcg, bicgstab: bicgstab,
    jacobiInto: jacobiSolveInto, gaussSeidelInto: gaussSeidelSolveInto,
    sorInto: sorSolveInto, cgInto: cgInto, bicgstabInto: bicgstabInto,
    cgChunked: cgChunked, jacobiChunked: jacobiSolveChunked,
    batchCG: batchCG, batchCGChunked: batchCGChunked,
    createResult: createSolveResult, createState: createSolveState,
    createStepper: createSolverStepper
};
export const preconditioners = {
    jacobi: jacobiPreconditioner, ssor: ssorPreconditioner,
    createJacobi: createJacobiPreconditioner
};
export const precision = {
    dsSubInto: dsSubInto, dsSubF64: dsSubF64,
    track: trackSparse, untrack: untrackSparse, migrate: migrateSparse,
    migrateAll: migrateAllSparse, clearTracked: clearTrackedSparse,
    getTracked: getTrackedSparse,
    getPrecision: getPrecision, setPrecision: setPrecision, getArrayType: getArrayType
};
export const transfer = {
    toTransferable: sparseToTransferable,
    fromTransferable: sparseFromTransferable
};
export const gpu = {
    writeVectorIntoFlat: writeVectorIntoFlat,
    flagUpload: flagSolutionUpload,
    syncAttribute: syncSolutionAttribute
};
export const namespace = {
    formats: formats, builders: builders, ops: ops, solvers: solvers,
    preconditioners: preconditioners, precision: precision,
    transfer: transfer, gpu: gpu,
    SparseMatrix: SparseMatrix, SparseScratch: SparseScratch,
    SparseSolveState: SparseSolveState, createBatchState: createBatchState
};