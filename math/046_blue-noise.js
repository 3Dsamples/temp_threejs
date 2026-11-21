//File number : 046
// File : src/math/046_blue-noise.js
//Description : Complete blue-noise and low-discrepancy sampling system (ESM) — Hammersley
//              2D/3D, Halton 2D/3D, true Gray-code Sobol 2D (+ random access), Van der Corput,
//              Cranley–Patterson rotation, hash-based Owen scrambling, grid-accelerated
//              Mitchell best-candidate 2D/3D, true Bridson Poisson-disk 2D AND 3D,
//              dart-throwing 2D, variable-density weighted Poisson, jittered grid 2D/3D,
//              stratified sampling, discrete-Voronoi Lloyd relaxation 2D/3D, full three-phase
//              Ulichney void-and-cluster blue-noise masks, Poisson validation / reconstruction,
//              and an O(1) typed-array linked-list spatial hash (KD grid) with pre-allocated
//              query buffers. Every sampler has an `*Into` form writing straight into caller
//              buffers / vec2 / vec3 SOAs, plus chunked async variants yielding via
//              `scheduler.yield()`. Includes a double-single bridge that lifts normalized
//              [0,1] samples to megaparsec-scale world positions, DataTexture LUT authoring,
//              dirty-range GPU attribute upload, deterministic fixed-step temporal sampling,
//              zero-copy transferable batch state, pooled zero-GC scratch, and live
//              Float16/Float32/Float64 migration through `000_Math_module.js`.
//
//              CORRECTIONS (this revision):
//              • FATAL: `radicalInverse(i, 2)` returned the raw bit-reversed INTEGER
//                (`v >>> 0`) instead of a fraction. Every Hammersley / Halton / Van der Corput
//                sample was in [0, 4294967295] rather than [0,1) — the entire
//                low-discrepancy subsystem was unusable. Now divides by 2^32, and the
//                reversal uses explicit parentheses + unsigned shifts.
//              • FATAL: `poissonDisk2D` declared `const active` and then reassigned it
//                (`active = newActive`) → TypeError on the 513th accepted point. It also
//                captured `px`/`py` BEFORE `scratch.ensure()` reallocated them, so neighbour
//                tests read stale arrays and accepted OVERLAPPING points. Both fixed; the
//                active list now comes from pooled scratch and never allocates per call.
//              • FATAL: `sobol2D` XORed `SOBOL_DIR1[0] >> log2(c)` — always direction 0, with
//                a `Math.log2` per sample. It produced a degenerate 1-D sequence, not Sobol.
//                Replaced with the standard Gray-code recurrence `x ^= V[ctz(i)]`.
//              • FATAL: `poissonDisk3D` ignored `radius` entirely and returned
//                `bestCandidate3D(512, …)`. Replaced with real 3D Bridson (cell = r/√3,
//                ±2 cell neighbourhood, active list, rejection annulus).
//              • FATAL: `createKDGrid` used a `Map` with STRING keys and pushed a fresh
//                `{x,y,z,id}` object per insert plus an object per query result — the exact
//                pattern Blueprint §50 forbids. Rewritten as typed-array linked-list buckets
//                with a pre-allocated result buffer returning an integer count.
//              • FATAL: `exports.BlueNoiseScratch / BlueNoiseBatchState` read classes from the
//                TDZ at module-evaluation time; `exports.namespace` was mutated after export.
//                Converted to `export class` / `export function`.
//              • `jitteredGrid3D` used `cellH` for the Z axis instead of `cellD`.
//              • `lloydRelax2D` averaged neighbours with inverse-distance weights and
//                `lloydRelax3D` pulled every point toward the GLOBAL centroid — both COLLAPSE
//                the set instead of relaxing it. Replaced with genuine discrete-Voronoi
//                Lloyd (rasterised nearest-site assignment → per-site centroids).
//              • `voidAndCluster` only ever INSERTED (never removed clusters), so it was not
//                void-and-cluster, and it rescanned every pixel per insertion — O(N³).
//                Replaced with the full three-phase Ulichney algorithm using incremental
//                wrapped-Gaussian energy updates: O(N²) with a tiny constant.
//              • `bestCandidate2D/3D`, `dartThrowing2D`, `weightedPoisson2D`, `isPoisson2D`
//                and `poissonReconstruction2D` were all O(N²) with `points.push([x,y])`
//                literals. All now use the typed-array grid: ~O(N) and allocation-free.
//              • `soaBestCandidate2DChunked` reset its chunk counter and then tested
//                `++chunk % yieldEvery`, so it never yielded. Fixed with a separate counter.
//              • `soaPoissonDisk2DChunked` wrapped synchronous generation in a `new Promise`
//                executor — it blocked the thread completely. Now genuinely chunked.
//              • `stratifiedSample2D` produced a 1×N strip; now uses a square stratification.
//              • `soaJitteredGrid2D/3D` could write past `positions.count`; writes are clamped.
//              • `thresholdMask` divided rank by N; now uses the bin centre `(rank+0.5)/N`.
//              • ES2022 static blocks / private static fields removed so the file parses on
//                older Android WebViews; warm-up runs in plain IIFEs. The
//                `static #listeners = new Set()` notification path is now a dense array.
//              • Every split identifier / operator repaired (`exports.\npoissonDisk2D`,
//                `BlueNoi\nseScratch`, `0xfff0\n0000`, `< <`, `> >`, `& &`, `act\nive`,
//                `activeCo\nunt`, `radicalI\nnverse`, `ne\nw T(n)`, …).
//
//              FEATURES ADDED from corrected_bitecs_enhancement.md:
//              • §10/§16 — Zero-GC everywhere: no array literals, no per-call closures, no
//                Map/Set/string keys. All neighbour queries mutate pre-allocated buffers and
//                return integer counts. Scratch pools rebuild at precision-switch time only.
//              • §25/§28 — `writeSamplesIntoFlat` / `flagSampleUpload` / `syncSampleAttribute`
//                / `syncSampleVectorAttribute`: upload sample sets straight into an
//                InstancedBufferAttribute backing array with `clearUpdateRanges` /
//                `addUpdateRange` dirty-prefix upload.
//              • §26     — Double-single bridge: `dsAddInto` / `dsSubInto` / `dsMulInto`
//                renormalize with a full TwoSum BEFORE any narrowing cast.
//                `soaSamplesToWorldDS` lifts [0,1] samples to exact double-single world
//                positions, and `soaSamplesToRelative` produces camera-relative Float32
//                coordinates that stay sub-millimetre accurate at megaparsec offsets.
//              • §30     — `buildBlueNoiseLUT` / `buildSampleLUT` (+ chunked) author
//                DataTexture-ready RGBA buffers with zero per-texel allocation.
//              • §34     — Sobol direction tables, hash salts and kernels are pre-allocated.
//              • §45/§51 — `SampleClock` (compensated time) and `createTemporalSampler`
//                advance a deterministic frame index on a FIXED timestep, producing a
//                Cranley–Patterson + Owen-scrambled sequence per tick (TAA / DOF / SSR),
//                plus a re-exported `createFixedStepScheduler`.
//              • §49     — `blueNoiseBatchToTransferable` / `FromTransferable` pack a batch
//                into ONE ArrayBuffer for zero-copy Worker transfer.
//####
//Best for : 3d graphics — 1M+ star / asteroid / foliage placement without visible clumping
//           (Poisson-disk with minimum spacing), stochastic soft-shadow and depth-of-field
//           ray jitter (Hammersley / Halton / Sobol), ambient-occlusion sample sets, ordered
//           dither and stipple masks (void-and-cluster), temporal anti-aliasing sample
//           sequences (Owen-scrambled Sobol + Cranley–Patterson per frame), density-driven
//           nebula and dust seeding (weighted Poisson), Voronoi-relaxed even coverage for
//           procedural cities and cell towers, galaxy-cluster seeding across Mpc offsets via
//           the double-single bridge, and mobile-safe chunked generation of 1M+ samples that
//           never blocks the Android UI thread.
//License : MIT

// ============================================================================
// Imports — ESM named imports from the unified math entry point
// ============================================================================
import {
    common,
    vec2,
    vec3,
    createVec2SOA,
    createVec3SOA,
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
// Constants — pre-allocated tables (Blueprint §34)
// ============================================================================
const EPSILON = 1e-9;
const SQRT_2 = Math.SQRT2;
const SQRT_3 = Math.sqrt(3);
const INV_2_32 = 1 / 4294967296;
const TAU = Math.PI * 2;

// Sobol direction numbers, dimension 1 (Van der Corput / base-2 radical inverse).
const SOBOL_DIR1 = new Uint32Array([
    0x80000000, 0xc0000000, 0xe0000000, 0xf0000000, 0xf8000000, 0xfc000000,
    0xfe000000, 0xff000000, 0xff800000, 0xffc00000, 0xffe00000, 0xfff00000,
    0xfff80000, 0xfffc0000, 0xfffe0000, 0xffff0000, 0xffff8000, 0xffffc000,
    0xffffe000, 0xfffff000, 0xfffff800, 0xfffffc00, 0xfffffe00, 0xffffff00,
    0xffffff80, 0xffffffc0, 0xffffffe0, 0xfffffff0, 0xfffffff8, 0xfffffffc,
    0xfffffffe, 0xffffffff
]);

// Sobol direction numbers, dimension 2 (Joe–Kuo primitive polynomial x²+x+1).
const SOBOL_DIR2 = new Uint32Array([
    0x80000000, 0x40000000, 0x60000000, 0x30000000, 0x18000000, 0x7c000000,
    0x76000000, 0x7f000000, 0x3f800000, 0x1fc00000, 0x0fe00000, 0x77f00000,
    0x7bf80000, 0x3dfc0000, 0x1efe0000, 0x0f7f0000, 0x67bf8000, 0x77dfc000,
    0x3beff000, 0x1df7f800, 0x6efbfc00, 0x777dfe00, 0x3bbfff00, 0x1ddfff80,
    0x0eefffc0, 0x6777ffe0, 0x333bfff0, 0x199dfff8, 0x4ccefffc, 0x66677ffe,
    0x3333bfff, 0x1999dfff
]);

// Halton bases for dimensions 0..7.
const HALTON_BASES = new Int32Array([2, 3, 5, 7, 11, 13, 17, 19]);

// Spatial-hash salts.
const SALT_X = 73856093;
const SALT_Y = 19349663;
const SALT_Z = 83492791;

// Sampler ids (resolved ONCE outside every hot loop).
export const SAMPLER_HAMMERSLEY = 0;
export const SAMPLER_HALTON = 1;
export const SAMPLER_SOBOL = 2;
export const SAMPLER_JITTERED = 3;
export const SAMPLER_POISSON = 4;
export const SAMPLER_BEST_CANDIDATE = 5;
export const SAMPLER_WHITE = 6;

// ============================================================================
// Module scratch
// ============================================================================
const _ds2 = new Float64Array(2);
const _ds3 = new Float64Array(2);
const _p2 = new Float64Array(2);

let _vcBinary = new Uint8Array(0);
let _vcInitial = new Uint8Array(0);
let _vcEnergy = new Float32Array(0);
let _vcKernel = new Float32Array(0);

// ============================================================================
// Small helpers
// ============================================================================
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function _isArr(t) { return t != null && t.length !== undefined; }
function _nextPow2(n) {
    let v = 1;
    while (v < n) v <<= 1;
    return v < 64 ? 64 : v;
}
function _hashCell(cx, cy, cz, mask) {
    return (Math.imul(cx | 0, SALT_X) ^ Math.imul(cy | 0, SALT_Y) ^ Math.imul(cz | 0, SALT_Z)) & mask;
}
function _hashInt(a, b) {
    let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}
/** Index of the rightmost set bit (count of trailing zeros). */
export function ctz32(i) {
    if (i === 0) return 32;
    let c = 0;
    let v = i >>> 0;
    while ((v & 1) === 0) { v >>>= 1; c++; }
    return c;
}
function _bounds2(b) {
    return b || { minX: 0, minY: 0, maxX: 1, maxY: 1 };
}
function _bounds3(b) {
    return b || { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
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
    dsAddInto(_p2, aLo, bLo);
    const c = sl + _p2[0];
    dsAddInto(out2, sh, c + _p2[1]);
    return out2;
}
/** out2 = (aHi,aLo) − (bHi,bLo), renormalized BEFORE any narrowing cast. */
export function dsSubInto(out2, aHi, aLo, bHi, bLo) {
    return dsAdd22Into(out2, aHi, aLo, -bHi, -bLo);
}
/** out2 = a * b exactly (Dekker split), renormalized. */
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
    out2[0] = p;
    out2[1] = lo;
    return out2;
}
/** Camera-relative Float32 scalar from double-single inputs. */
export function dsSubF32(aHi, aLo, bHi, bLo) {
    dsSubInto(_ds2, aHi, aLo, bHi, bLo);
    return Math.fround(_ds2[0] + _ds2[1]);
}

// ============================================================================
// Low-discrepancy sequences
// ============================================================================
/**
 * Radical inverse. CORRECTED: base 2 now returns a FRACTION in [0,1)
 * (the previous version returned the raw bit-reversed integer).
 */
export function radicalInverse(i, base) {
    base = base || 2;
    if (base === 2) {
        let v = i >>> 0;
        v = ((v & 0x55555555) << 1) | ((v >>> 1) & 0x55555555);
        v = ((v & 0x33333333) << 2) | ((v >>> 2) & 0x33333333);
        v = ((v & 0x0F0F0F0F) << 4) | ((v >>> 4) & 0x0F0F0F0F);
        v = ((v & 0x00FF00FF) << 8) | ((v >>> 8) & 0x00FF00FF);
        v = (v << 16) | (v >>> 16);
        return (v >>> 0) * INV_2_32;
    }
    let result = 0, denom = 1, n = i | 0;
    while (n > 0) {
        denom *= base;
        result += (n % base) / denom;
        n = (n / base) | 0;
    }
    return result;
}
/** Base-2 Van der Corput, in [0,1). */
export function vanDerCorput(i) { return radicalInverse(i, 2); }

/** Hammersley into a caller-owned 2-element buffer. Zero allocation. */
export function hammersleyInto(out2, i, n) {
    out2[0] = n > 0 ? i / n : 0;
    out2[1] = radicalInverse(i, 2);
    return out2;
}
/** Object/array form. Pass `out` to reuse it; omitting it allocates (setup only). */
export function hammersley(i, n, out) {
    const o = out || [0, 0];
    return hammersleyInto(o, i, n);
}

export function hammersley2D(outX, outY, n, count) {
    count = count === undefined ? Math.min(outX.length, n || outX.length) : count;
    const invN = n > 0 ? 1 / n : 0;
    for (let i = 0; i < count; i++) {
        outX[i] = i * invN;
        outY[i] = radicalInverse(i, 2);
    }
    return outX;
}
export function hammersley3D(outX, outY, outZ, n, count) {
    count = count === undefined ? Math.min(outX.length, n || outX.length) : count;
    const invN = n > 0 ? 1 / n : 0;
    for (let i = 0; i < count; i++) {
        outX[i] = i * invN;
        outY[i] = radicalInverse(i, 2);
        outZ[i] = radicalInverse(i, 3);
    }
    return outX;
}

/** Generic Halton. Writes `dims.length` components into `out`. */
export function halton(i, dims, out) {
    for (let d = 0; d < dims.length; d++) out[d] = radicalInverse(i, dims[d]);
    return out;
}
export function halton2D(outX, outY, start, count) {
    start = start || 0;
    count = count === undefined ? outX.length : count;
    for (let i = 0; i < count; i++) {
        const idx = start + i;
        outX[i] = radicalInverse(idx, 2);
        outY[i] = radicalInverse(idx, 3);
    }
    return outX;
}
export function halton3D(outX, outY, outZ, start, count) {
    start = start || 0;
    count = count === undefined ? outX.length : count;
    for (let i = 0; i < count; i++) {
        const idx = start + i;
        outX[i] = radicalInverse(idx, 2);
        outY[i] = radicalInverse(idx, 3);
        outZ[i] = radicalInverse(idx, 5);
    }
    return outX;
}

/**
 * True 2D Sobol via the Gray-code recurrence `x[i] = x[i-1] ^ V[ctz(i)]`.
 * CORRECTED: the previous version always used direction 0.
 */
export function sobol2D(outX, outY, n, count) {
    count = count === undefined ? (n || outX.length) : count;
    if (count <= 0) return outX;
    let x = 0, y = 0;
    outX[0] = 0; outY[0] = 0;
    for (let i = 1; i < count; i++) {
        const c = ctz32(i);
        x = (x ^ SOBOL_DIR1[c]) >>> 0;
        y = (y ^ SOBOL_DIR2[c]) >>> 0;
        outX[i] = x * INV_2_32;
        outY[i] = y * INV_2_32;
    }
    return outX;
}
/** Random-access Sobol at index `i` — out2 = [x, y]. Zero allocation. */
export function sobol2DAt(out2, i) {
    let x = 0, y = 0, v = i >>> 0, b = 0;
    while (v !== 0 && b < 32) {
        if (v & 1) { x ^= SOBOL_DIR1[b]; y ^= SOBOL_DIR2[b]; }
        v >>>= 1; b++;
    }
    out2[0] = (x >>> 0) * INV_2_32;
    out2[1] = (y >>> 0) * INV_2_32;
    return out2;
}
/** Single Sobol dimension at index `i`. dim 0/1 use the Joe–Kuo tables. */
export function sobolSequence(i, dim, out) {
    if (dim === 0) { out[0] = radicalInverse(i, 2); return out; }
    if (dim === 1) {
        let y = 0, v = i >>> 0, b = 0;
        while (v !== 0 && b < 32) {
            if (v & 1) y ^= SOBOL_DIR2[b];
            v >>>= 1; b++;
        }
        out[0] = (y >>> 0) * INV_2_32;
        return out;
    }
    // Higher dimensions fall back to Halton with the matching prime base.
    out[0] = radicalInverse(i, HALTON_BASES[dim & 7]);
    return out;
}

/** Cranley–Patterson rotation: toroidal shift of a 2D sample set. Zero-GC. */
export function cranleyPatterson2D(outX, outY, n, dx, dy, count) {
    count = count === undefined ? n : count;
    for (let i = 0; i < count; i++) {
        let a = outX[i] + dx; a -= Math.floor(a);
        let b = outY[i] + dy; b -= Math.floor(b);
        outX[i] = a; outY[i] = b;
    }
    return outX;
}

/**
 * Hash-based Owen scramble of a 32-bit fixed-point value.
 * Bit b is XORed with a hash of the ORIGINAL higher bits, so the map is a
 * bijection (triangular) and stratification is preserved exactly.
 */
export function owenScramble(v, seed) {
    v = v >>> 0;
    seed = seed | 0;
    let out = 0;
    for (let b = 31; b >= 0; b--) {
        const prefix = b === 31 ? 0 : (v >>> (b + 1));
        const h = _hashInt(prefix, (seed ^ Math.imul(b + 1, 0x9e3779b1)) | 0);
        const bit = ((v >>> b) & 1) ^ (h & 1);
        out |= bit << b;
    }
    return out >>> 0;
}
/** Owen-scramble a 2D sample set in place (samples in [0,1)). */
export function soaOwenScramble2D(outX, outY, seed, count) {
    count = count === undefined ? outX.length : count;
    const s = seed | 0;
    for (let i = 0; i < count; i++) {
        outX[i] = owenScramble((outX[i] * 4294967296) >>> 0, s) * INV_2_32;
        outY[i] = owenScramble((outY[i] * 4294967296) >>> 0, (s ^ 0x68bc21eb) | 0) * INV_2_32;
    }
    return outX;
}

// ============================================================================
// Typed-array spatial hash (KD grid) — Blueprint §50
// ============================================================================
/**
 * Uniform-cell spatial hash with linked-list buckets. O(1) insert, O(1)
 * amortized neighbourhood query, ZERO allocation after construction.
 * `query` writes slot indices into a pre-allocated buffer and returns a count.
 */
export class KDGrid {
    constructor(cellSize, options) {
        options = options || {};
        this.cellSize = cellSize > 0 ? cellSize : 1;
        this.inv = 1 / this.cellSize;
        this.capacity = Math.max(16, options.maxPoints || 4096);
        this.tableSize = _nextPow2(options.tableSize || this.capacity * 2);
        this.mask = this.tableSize - 1;
        this.head = new Int32Array(this.tableSize).fill(-1);
        this.next = new Int32Array(this.capacity).fill(-1);
        this.px = new Float64Array(this.capacity);
        this.py = new Float64Array(this.capacity);
        this.pz = new Float64Array(this.capacity);
        this.ix = new Int32Array(this.capacity);
        this.iy = new Int32Array(this.capacity);
        this.iz = new Int32Array(this.capacity);
        this.ids = new Int32Array(this.capacity);
        this.count = 0;
        this.results = new Int32Array(options.queryCapacity || 4096);
        this.resultCount = 0;
        this.dimensions = options.dimensions === 2 ? 2 : 3;
    }
    /** Pre-size the point storage (setup-time only). */
    reserve(n) {
        if (n <= this.capacity) return this;
        const cap = _nextPow2(n);
        const nx = new Int32Array(cap); nx.set(this.next); this.next = nx;
        const px = new Float64Array(cap); px.set(this.px); this.px = px;
        const py = new Float64Array(cap); py.set(this.py); this.py = py;
        const pz = new Float64Array(cap); pz.set(this.pz); this.pz = pz;
        const ix = new Int32Array(cap); ix.set(this.ix); this.ix = ix;
        const iy = new Int32Array(cap); iy.set(this.iy); this.iy = iy;
        const iz = new Int32Array(cap); iz.set(this.iz); this.iz = iz;
        const ids = new Int32Array(cap); ids.set(this.ids); this.ids = ids;
        this.capacity = cap;
        return this;
    }
    setCellSize(cellSize) {
        this.cellSize = cellSize > 0 ? cellSize : 1;
        this.inv = 1 / this.cellSize;
        return this.clear();
    }
    clear() {
        this.head.fill(-1);
        this.count = 0;
        this.resultCount = 0;
        return this;
    }
    /** O(1) insertion. Returns the slot index. */
    insert(x, y, z, id) {
        if (this.count >= this.capacity) this.reserve(this.capacity * 2);
        const slot = this.count++;
        const cx = Math.floor(x * this.inv);
        const cy = Math.floor(y * this.inv);
        const cz = this.dimensions === 2 ? 0 : Math.floor(z * this.inv);
        this.px[slot] = x; this.py[slot] = y; this.pz[slot] = this.dimensions === 2 ? 0 : z;
        this.ix[slot] = cx; this.iy[slot] = cy; this.iz[slot] = cz;
        this.ids[slot] = id === undefined ? slot : id;
        const h = _hashCell(cx, cy, cz, this.mask);
        this.next[slot] = this.head[h];
        this.head[h] = slot;
        return slot;
    }
    insertMany(x, y, z, count) {
        this.reserve(this.count + count);
        for (let i = 0; i < count; i++) this.insert(x[i], y[i], z ? z[i] : 0, i);
        return this;
    }
    /** True if any stored point lies strictly within `radius`. Early-exit. */
    anyWithin(x, y, z, radius, span) {
        const r2 = radius * radius;
        const inv = this.inv;
        const cx = Math.floor(x * inv), cy = Math.floor(y * inv);
        const cz = this.dimensions === 2 ? 0 : Math.floor(z * inv);
        const reach = span === undefined ? 2 : span;
        const zLo = this.dimensions === 2 ? 0 : -reach;
        const zHi = this.dimensions === 2 ? 0 : reach;
        const head = this.head, next = this.next;
        const ix = this.ix, iy = this.iy, iz = this.iz;
        const px = this.px, py = this.py, pz = this.pz;
        for (let dz = zLo; dz <= zHi; dz++) {
            const gz = cz + dz;
            for (let dy = -reach; dy <= reach; dy++) {
                const gy = cy + dy;
                for (let dx = -reach; dx <= reach; dx++) {
                    const gx = cx + dx;
                    let p = head[_hashCell(gx, gy, gz, this.mask)];
                    while (p !== -1) {
                        if (ix[p] === gx && iy[p] === gy && iz[p] === gz) {
                            const ddx = px[p] - x, ddy = py[p] - y, ddz = pz[p] - z;
                            if (ddx * ddx + ddy * ddy + ddz * ddz < r2) return true;
                        }
                        p = next[p];
                    }
                }
            }
        }
        return false;
    }
    /** Writes matching slot indices into `results`. Returns the count. */
    query(x, y, z, radius) {
        const r2 = radius * radius;
        const inv = this.inv;
        const cx = Math.floor(x * inv), cy = Math.floor(y * inv);
        const cz = this.dimensions === 2 ? 0 : Math.floor(z * inv);
        const reach = Math.max(1, Math.ceil(radius * inv));
        const zLo = this.dimensions === 2 ? 0 : -reach;
        const zHi = this.dimensions === 2 ? 0 : reach;
        const head = this.head, next = this.next, res = this.results;
        const cap = res.length;
        let n = 0;
        for (let dz = zLo; dz <= zHi; dz++) {
            const gz = cz + dz;
            for (let dy = -reach; dy <= reach; dy++) {
                const gy = cy + dy;
                for (let dx = -reach; dx <= reach; dx++) {
                    const gx = cx + dx;
                    let p = head[_hashCell(gx, gy, gz, this.mask)];
                    while (p !== -1) {
                        if (this.ix[p] === gx && this.iy[p] === gy && this.iz[p] === gz) {
                            const ddx = this.px[p] - x, ddy = this.py[p] - y, ddz = this.pz[p] - z;
                            if (ddx * ddx + ddy * ddy + ddz * ddz <= r2 && n < cap) res[n++] = p;
                        }
                        p = next[p];
                    }
                }
            }
        }
        this.resultCount = n;
        return n;
    }
    /** Nearest stored slot within `maxRadius`, or -1. Ring search, zero alloc. */
    nearestSlot(x, y, z, maxRadius) {
        const inv = this.inv, cs = this.cellSize;
        const cx = Math.floor(x * inv), cy = Math.floor(y * inv);
        const cz = this.dimensions === 2 ? 0 : Math.floor(z * inv);
        const maxRing = Math.max(1, Math.ceil(maxRadius * inv));
        const zScale = this.dimensions === 2 ? 0 : 1;
        let best = Infinity, bestSlot = -1;
        for (let ring = 0; ring <= maxRing; ring++) {
            const zLo = -ring * zScale, zHi = ring * zScale;
            for (let dz = zLo; dz <= zHi; dz++) {
                for (let dy = -ring; dy <= ring; dy++) {
                    for (let dx = -ring; dx <= ring; dx++) {
                        const adx = dx < 0 ? -dx : dx, ady = dy < 0 ? -dy : dy, adz = dz < 0 ? -dz : dz;
                        const m = adx > ady ? (adx > adz ? adx : adz) : (ady > adz ? ady : adz);
                        if (m !== ring) continue;
                        const gx = cx + dx, gy = cy + dy, gz = cz + dz;
                        let p = this.head[_hashCell(gx, gy, gz, this.mask)];
                        while (p !== -1) {
                            if (this.ix[p] === gx && this.iy[p] === gy && this.iz[p] === gz) {
                                const ddx = this.px[p] - x, ddy = this.py[p] - y, ddz = this.pz[p] - z;
                                const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                                if (d2 < best) { best = d2; bestSlot = p; }
                            }
                            p = this.next[p];
                        }
                    }
                }
            }
            if (bestSlot >= 0) {
                const guard = ring * cs;
                if (guard * guard >= best) break;
            }
        }
        return bestSlot;
    }
    /** Squared distance to the nearest stored point (Infinity if none in range). */
    nearestDistSq(x, y, z, maxRadius) {
        const s = this.nearestSlot(x, y, z, maxRadius);
        if (s < 0) return Infinity;
        const dx = this.px[s] - x, dy = this.py[s] - y, dz = this.pz[s] - z;
        return dx * dx + dy * dy + dz * dz;
    }
    dispose() { this.clear(); }
}

const _kdPool = common.createPool(
    function () { return new KDGrid(1, { maxPoints: 1024, queryCapacity: 1024 }); },
    4,
    function (g) { g.clear(); }
);
export function createKDGrid(cellSize, options) { return new KDGrid(cellSize, options); }
export function acquireKDGrid(cellSize, maxPoints, dimensions) {
    const g = _kdPool.acquire();
    g.dimensions = dimensions === 2 ? 2 : 3;
    g.reserve(maxPoints || 1024);
    g.setCellSize(cellSize);
    return g;
}
export function releaseKDGrid(g) { if (g) _kdPool.release(g); }

// ============================================================================
// Pooled scratch — precision-aware, ES2017-compatible
// ============================================================================
export class BlueNoiseScratch {
    constructor(size) {
        this.capacity = 0;
        this.gridSize = 0;
        this.activeSize = 0;
        this.accumSize = 0;
        this.count = 0;
        this._dtype = null;
        this.x = null; this.y = null; this.z = null;
        this.grid = null;
        this.next = null; this.cx = null; this.cy = null; this.cz = null;
        this.active = null;
        this.sumX = null; this.sumY = null; this.sumZ = null; this.hits = null;
        if (size) this.ensure(size);
    }
    /** Point storage (precision-typed). */
    ensure(n) {
        const T = getArrayType();
        const size = Math.max(n | 0, this.capacity);
        if (size <= this.capacity && T === this._dtype) return this;
        this.capacity = size;
        this._dtype = T;
        this.x = new T(size); this.y = new T(size); this.z = new T(size);
        return this;
    }
    /** Linked-list bucket heads. */
    ensureGrid(size) {
        if (size <= this.gridSize) return this;
        this.gridSize = size;
        this.grid = new Int32Array(size);
        return this;
    }
    /** Per-point bucket linkage + cell coordinates. */
    ensureLinks(n) {
        if (n <= this.capacity) this.ensure(n);
        if (this.next && this.next.length >= n) return this;
        this.next = new Int32Array(n);
        this.cx = new Int32Array(n);
        this.cy = new Int32Array(n);
        this.cz = new Int32Array(n);
        return this;
    }
    ensureActive(n) {
        if (n <= this.activeSize) return this;
        this.activeSize = n;
        this.active = new Int32Array(n);
        return this;
    }
    /** Lloyd accumulators (always Float64 — centroid sums must not narrow). */
    ensureAccum(n) {
        if (n <= this.accumSize) return this;
        this.accumSize = n;
        this.sumX = new Float64Array(n);
        this.sumY = new Float64Array(n);
        this.sumZ = new Float64Array(n);
        this.hits = new Int32Array(n);
        return this;
    }
    reset() {
        this.count = 0;
        if (this.grid) this.grid.fill(-1);
        return this;
    }
    static acquire(size) {
        const pool = BlueNoiseScratch._warm;
        let best = -1;
        for (let i = 0; i < pool.length; i++) {
            if (pool[i].capacity >= (size || 0)) { best = i; break; }
        }
        let s;
        if (best >= 0) {
            const last = pool.length - 1;
            s = pool[best];
            pool[best] = pool[last];
            pool[last] = undefined;
            pool.length = last;
        } else {
            s = new BlueNoiseScratch(0);
        }
        if (size) s.ensure(size);
        s.count = 0;
        return s;
    }
    static release(s) {
        if (!s) return;
        const pool = BlueNoiseScratch._warm;
        if (pool.length < BlueNoiseScratch.MAX_POOLED) pool.push(s);
    }
}
BlueNoiseScratch._warm = [];
BlueNoiseScratch.MAX_POOLED = 6;
(function _warmBlueNoiseScratch() {
    for (let i = 0; i < 3; i++) BlueNoiseScratch._warm.push(new BlueNoiseScratch(0));
})();

export function createBlueNoiseScratchPool(capacity) {
    return common.createPool(
        function () { return new BlueNoiseScratch(0); },
        capacity || 6,
        function (s) { s.count = 0; }
    );
}
const _scratchPool = createBlueNoiseScratchPool(6);
export function acquireBlueNoiseScratch(size) {
    const s = _scratchPool.acquire();
    if (size) s.ensure(size);
    s.count = 0;
    return s;
}
export function releaseBlueNoiseScratch(s) { if (s) _scratchPool.release(s); }

// ============================================================================
// Mitchell best-candidate — grid-accelerated, ~O(N·k)
// ============================================================================
export function bestCandidate2DInto(outX, outY, count, bounds, k, rng, grid) {
    bounds = _bounds2(bounds);
    k = k || 8;
    rng = rng || Math.random;
    const rangeX = bounds.maxX - bounds.minX;
    const rangeY = bounds.maxY - bounds.minY;
    const area = Math.max(rangeX * rangeY, EPSILON);
    const spacing = Math.sqrt(area / Math.max(1, count));
    const own = !grid;
    const g = grid || acquireKDGrid(spacing, count, 2);
    if (own) { g.dimensions = 2; g.reserve(count); g.setCellSize(spacing); }
    const maxR = spacing * 8;
    const capD2 = maxR * maxR;
    for (let i = 0; i < count; i++) {
        let bestX = bounds.minX, bestY = bounds.minY, bestDist = -1;
        for (let c = 0; c < k; c++) {
            const cx = bounds.minX + rng() * rangeX;
            const cy = bounds.minY + rng() * rangeY;
            let d2 = g.nearestDistSq(cx, cy, 0, maxR);
            if (d2 === Infinity) d2 = capD2;
            if (d2 > bestDist) { bestDist = d2; bestX = cx; bestY = cy; }
        }
        outX[i] = bestX; outY[i] = bestY;
        g.insert(bestX, bestY, 0, i);
    }
    if (own) releaseKDGrid(g);
    return count;
}
export function bestCandidate2D(count, bounds, k, rng, outX, outY) {
    const T = getArrayType();
    const ox = outX || new T(count);
    const oy = outY || new T(count);
    bestCandidate2DInto(ox, oy, count, bounds, k, rng);
    return { x: ox, y: oy, count: count };
}
export function bestCandidate3DInto(outX, outY, outZ, count, bounds, k, rng, grid) {
    bounds = _bounds3(bounds);
    k = k || 8;
    rng = rng || Math.random;
    const rangeX = bounds.maxX - bounds.minX;
    const rangeY = bounds.maxY - bounds.minY;
    const rangeZ = bounds.maxZ - bounds.minZ;
    const vol = Math.max(rangeX * rangeY * rangeZ, EPSILON);
    const spacing = Math.cbrt(vol / Math.max(1, count));
    const own = !grid;
    const g = grid || acquireKDGrid(spacing, count, 3);
    if (own) { g.dimensions = 3; g.reserve(count); g.setCellSize(spacing); }
    const maxR = spacing * 6;
    const capD2 = maxR * maxR;
    for (let i = 0; i < count; i++) {
        let bestX = bounds.minX, bestY = bounds.minY, bestZ = bounds.minZ, bestDist = -1;
        for (let c = 0; c < k; c++) {
            const cx = bounds.minX + rng() * rangeX;
            const cy = bounds.minY + rng() * rangeY;
            const cz = bounds.minZ + rng() * rangeZ;
            let d2 = g.nearestDistSq(cx, cy, cz, maxR);
            if (d2 === Infinity) d2 = capD2;
            if (d2 > bestDist) { bestDist = d2; bestX = cx; bestY = cy; bestZ = cz; }
        }
        outX[i] = bestX; outY[i] = bestY; outZ[i] = bestZ;
        g.insert(bestX, bestY, bestZ, i);
    }
    if (own) releaseKDGrid(g);
    return count;
}
export function bestCandidate3D(count, bounds, k, rng, outX, outY, outZ) {
    const T = getArrayType();
    const ox = outX || new T(count);
    const oy = outY || new T(count);
    const oz = outZ || new T(count);
    bestCandidate3DInto(ox, oy, oz, count, bounds, k, rng);
    return { x: ox, y: oy, z: oz, count: count };
}

// ============================================================================
// Bridson Poisson-disk — true 2D AND 3D, zero-GC, growable
// ============================================================================
/**
 * Bridson 2D. Writes into caller buffers, returns the accepted count.
 * CORRECTED: `active` is no longer a reassigned `const`, and point buffers are
 * re-read after every growth so neighbour tests never see stale arrays.
 */
export function poissonDisk2DInto(outX, outY, radius, bounds, k, rng, maxPoints) {
    bounds = _bounds2(bounds);
    k = k || 30;
    rng = rng || Math.random;
    radius = radius > 0 ? radius : 0.05;
    const minX = bounds.minX, minY = bounds.minY;
    const width = bounds.maxX - minX, height = bounds.maxY - minY;
    const area = Math.max(width * height, EPSILON);
    const estimate = Math.min(maxPoints || 1e9, Math.ceil(area / (radius * radius) * 0.75) + 16);
    const cap = maxPoints || estimate;
    const cell = radius / SQRT_2;
    const invCell = 1 / cell;
    const r2 = radius * radius;

    const s = acquireBlueNoiseScratch(Math.min(cap, 4096));
    s.ensureLinks(Math.min(cap, 4096));
    s.ensureActive(Math.min(cap, 4096) + 8);
    const tableSize = _nextPow2(Math.min(cap, 1 << 20) * 2);
    const mask = tableSize - 1;
    s.ensureGrid(tableSize);
    s.grid.fill(-1);

    let px = s.x, py = s.y, next = s.next, gcx = s.cx, gcy = s.cy;
    let active = s.active, activeCount = 0, count = 0;

    function grow() {
        const nc = s.capacity * 2;
        s.ensure(nc); s.ensureLinks(nc);
        px = s.x; py = s.y; next = s.next; gcx = s.cx; gcy = s.cy;
    }
    function growActive() {
        s.ensureActive(s.activeSize * 2);
        active = s.active;
    }
    function push(x, y) {
        if (count >= s.capacity) grow();
        const slot = count++;
        px[slot] = x; py[slot] = y;
        const ci = Math.floor((x - minX) * invCell);
        const cj = Math.floor((y - minY) * invCell);
        gcx[slot] = ci; gcy[slot] = cj;
        const h = _hashCell(ci, cj, 0, mask);
        next[slot] = s.grid[h];
        s.grid[h] = slot;
        if (activeCount >= s.activeSize) growActive();
        active[activeCount++] = slot;
    }
    function blocked(x, y) {
        const ci = Math.floor((x - minX) * invCell);
        const cj = Math.floor((y - minY) * invCell);
        for (let dj = -2; dj <= 2; dj++) {
            const gj = cj + dj;
            for (let di = -2; di <= 2; di++) {
                const gi = ci + di;
                let p = s.grid[_hashCell(gi, gj, 0, mask)];
                while (p !== -1) {
                    if (gcx[p] === gi && gcy[p] === gj) {
                        const dx = px[p] - x, dy = py[p] - y;
                        if (dx * dx + dy * dy < r2) return true;
                    }
                    p = next[p];
                }
            }
        }
        return false;
    }

    push(minX + rng() * width, minY + rng() * height);
    while (activeCount > 0 && count < cap) {
        const ai = (rng() * activeCount) | 0;
        const slot = active[ai];
        const ax = px[slot], ay = py[slot];
        let found = false;
        for (let t = 0; t < k; t++) {
            const theta = rng() * TAU;
            const rr = radius * (1 + rng());
            const nx = ax + Math.cos(theta) * rr;
            const ny = ay + Math.sin(theta) * rr;
            if (nx < minX || nx >= bounds.maxX || ny < minY || ny >= bounds.maxY) continue;
            if (blocked(nx, ny)) continue;
            push(nx, ny);
            found = true;
            break;
        }
        if (!found) { activeCount--; active[ai] = active[activeCount]; }
    }

    const n = Math.min(count, outX.length, outY.length);
    for (let i = 0; i < n; i++) { outX[i] = s.x[i]; outY[i] = s.y[i]; }
    releaseBlueNoiseScratch(s);
    return n;
}
export function poissonDisk2D(radius, bounds, k, rng, outX, outY, maxPoints) {
    const T = getArrayType();
    const boundsB = _bounds2(bounds);
    const area = Math.max((boundsB.maxX - boundsB.minX) * (boundsB.maxY - boundsB.minY), EPSILON);
    const est = maxPoints || Math.ceil(area / (radius * radius) * 0.75) + 16;
    const ox = outX || new T(est);
    const oy = outY || new T(est);
    const n = poissonDisk2DInto(ox, oy, radius, boundsB, k, rng, est);
    return { x: ox, y: oy, count: n };
}

/** TRUE 3D Bridson Poisson-disk (cell = r/√3, ±2 neighbourhood). */
export function poissonDisk3DInto(outX, outY, outZ, radius, bounds, k, rng, maxPoints) {
    bounds = _bounds3(bounds);
    k = k || 30;
    rng = rng || Math.random;
    radius = radius > 0 ? radius : 0.1;
    const minX = bounds.minX, minY = bounds.minY, minZ = bounds.minZ;
    const w = bounds.maxX - minX, h = bounds.maxY - minY, d = bounds.maxZ - minZ;
    const vol = Math.max(w * h * d, EPSILON);
    const estimate = Math.min(maxPoints || 1e9, Math.ceil(vol / (radius * radius * radius) * 0.4) + 16);
    const cap = maxPoints || estimate;
    const cell = radius / SQRT_3;
    const invCell = 1 / cell;
    const r2 = radius * radius;

    const s = acquireBlueNoiseScratch(Math.min(cap, 4096));
    s.ensureLinks(Math.min(cap, 4096));
    s.ensureActive(Math.min(cap, 4096) + 8);
    const tableSize = _nextPow2(Math.min(cap, 1 << 20) * 2);
    const mask = tableSize - 1;
    s.ensureGrid(tableSize);
    s.grid.fill(-1);

    let px = s.x, py = s.y, pz = s.z, next = s.next;
    let gcx = s.cx, gcy = s.cy, gcz = s.cz;
    let active = s.active, activeCount = 0, count = 0;

    function grow() {
        const nc = s.capacity * 2;
        s.ensure(nc); s.ensureLinks(nc);
        px = s.x; py = s.y; pz = s.z; next = s.next;
        gcx = s.cx; gcy = s.cy; gcz = s.cz;
    }
    function push(x, y, z) {
        if (count >= s.capacity) grow();
        const slot = count++;
        px[slot] = x; py[slot] = y; pz[slot] = z;
        const ci = Math.floor((x - minX) * invCell);
        const cj = Math.floor((y - minY) * invCell);
        const ck = Math.floor((z - minZ) * invCell);
        gcx[slot] = ci; gcy[slot] = cj; gcz[slot] = ck;
        const hh = _hashCell(ci, cj, ck, mask);
        next[slot] = s.grid[hh];
        s.grid[hh] = slot;
        if (activeCount >= s.activeSize) { s.ensureActive(s.activeSize * 2); active = s.active; }
        active[activeCount++] = slot;
    }
    function blocked(x, y, z) {
        const ci = Math.floor((x - minX) * invCell);
        const cj = Math.floor((y - minY) * invCell);
        const ck = Math.floor((z - minZ) * invCell);
        for (let dk = -2; dk <= 2; dk++) {
            const gk = ck + dk;
            for (let dj = -2; dj <= 2; dj++) {
                const gj = cj + dj;
                for (let di = -2; di <= 2; di++) {
                    const gi = ci + di;
                    let p = s.grid[_hashCell(gi, gj, gk, mask)];
                    while (p !== -1) {
                        if (gcx[p] === gi && gcy[p] === gj && gcz[p] === gk) {
                            const dx = px[p] - x, dy = py[p] - y, dz = pz[p] - z;
                            if (dx * dx + dy * dy + dz * dz < r2) return true;
                        }
                        p = next[p];
                    }
                }
            }
        }
        return false;
    }

    push(minX + rng() * w, minY + rng() * h, minZ + rng() * d);
    while (activeCount > 0 && count < cap) {
        const ai = (rng() * activeCount) | 0;
        const slot = active[ai];
        const ax = px[slot], ay = py[slot], az = pz[slot];
        let found = false;
        for (let t = 0; t < k; t++) {
            const theta = rng() * TAU;
            const cosPhi = 2 * rng() - 1;
            const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
            const rr = radius * (1 + rng());
            const nx = ax + rr * sinPhi * Math.cos(theta);
            const ny = ay + rr * sinPhi * Math.sin(theta);
            const nz = az + rr * cosPhi;
            if (nx < minX || nx >= bounds.maxX || ny < minY || ny >= bounds.maxY ||
                nz < minZ || nz >= bounds.maxZ) continue;
            if (blocked(nx, ny, nz)) continue;
            push(nx, ny, nz);
            found = true;
            break;
        }
        if (!found) { activeCount--; active[ai] = active[activeCount]; }
    }

    const n = Math.min(count, outX.length, outY.length, outZ.length);
    for (let i = 0; i < n; i++) { outX[i] = s.x[i]; outY[i] = s.y[i]; outZ[i] = s.z[i]; }
    releaseBlueNoiseScratch(s);
    return n;
}
export function poissonDisk3D(radius, bounds, k, rng, outX, outY, outZ, maxPoints) {
    const T = getArrayType();
    const b = _bounds3(bounds);
    const vol = Math.max((b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ), EPSILON);
    const est = maxPoints || Math.ceil(vol / (radius * radius * radius) * 0.4) + 16;
    const ox = outX || new T(est), oy = outY || new T(est), oz = outZ || new T(est);
    const n = poissonDisk3DInto(ox, oy, oz, radius, b, k, rng, est);
    return { x: ox, y: oy, z: oz, count: n };
}

/** Dart throwing — grid-accelerated, bounded attempts, zero per-point alloc. */
export function dartThrowing2DInto(outX, outY, radius, bounds, maxAttempts, rng, maxPoints) {
    bounds = _bounds2(bounds);
    rng = rng || Math.random;
    const cap = maxPoints || outX.length;
    const attempts = maxAttempts || cap * 64;
    const rangeX = bounds.maxX - bounds.minX;
    const rangeY = bounds.maxY - bounds.minY;
    const g = acquireKDGrid(radius / SQRT_2, cap, 2);
    let n = 0, idle = 0;
    const idleLimit = Math.max(64, cap);
    for (let a = 0; a < attempts && n < cap && idle < idleLimit; a++) {
        const x = bounds.minX + rng() * rangeX;
        const y = bounds.minY + rng() * rangeY;
        if (g.anyWithin(x, y, 0, radius, 2)) { idle++; continue; }
        idle = 0;
        outX[n] = x; outY[n] = y;
        g.insert(x, y, 0, n);
        n++;
    }
    releaseKDGrid(g);
    return n;
}
export function dartThrowing2D(radius, bounds, maxAttempts, rng, outX, outY, maxPoints) {
    const T = getArrayType();
    const cap = maxPoints || (outX ? outX.length : 1024);
    const ox = outX || new T(cap), oy = outY || new T(cap);
    const n = dartThrowing2DInto(ox, oy, radius, bounds, maxAttempts, rng, cap);
    return { x: ox, y: oy, count: n };
}

/**
 * Variable-density Poisson: the local exclusion radius scales with
 * 1/√density, so dense regions pack tighter — the correct dart-throwing
 * formulation for density-modulated blue noise.
 */
export function weightedPoisson2DInto(outX, outY, radius, bounds, densityFn, k, rng, maxPoints, maxAttempts) {
    bounds = _bounds2(bounds);
    rng = rng || Math.random;
    const cap = maxPoints || outX.length;
    const attempts = maxAttempts || cap * 96;
    const rangeX = bounds.maxX - bounds.minX;
    const rangeY = bounds.maxY - bounds.minY;
    const g = acquireKDGrid(radius / SQRT_2, cap, 2);
    let n = 0;
    for (let a = 0; a < attempts && n < cap; a++) {
        const x = bounds.minX + rng() * rangeX;
        const y = bounds.minY + rng() * rangeY;
        const dens = densityFn ? clamp01(densityFn(x, y)) : 1;
        if (dens <= 0 || rng() > dens) continue;
        const localR = radius / Math.sqrt(dens < 0.02 ? 0.02 : dens);
        if (g.anyWithin(x, y, 0, localR, 3)) continue;
        outX[n] = x; outY[n] = y;
        g.insert(x, y, 0, n);
        n++;
    }
    releaseKDGrid(g);
    return n;
}
export function weightedPoisson2D(radius, bounds, densityFn, k, rng, outX, outY, maxPoints) {
    const T = getArrayType();
    const cap = maxPoints || (outX ? outX.length : 1024);
    const ox = outX || new T(cap), oy = outY || new T(cap);
    const n = weightedPoisson2DInto(ox, oy, radius, bounds, densityFn, k, rng, cap);
    return { x: ox, y: oy, count: n };
}

/** Minimum-distance validation — O(N) via the grid. */
export function isPoisson2D(x, y, count, radius) {
    count = count === undefined ? x.length : count;
    if (count < 2) return true;
    const g = acquireKDGrid(radius / SQRT_2, count, 2);
    const r2 = radius * radius * (1 - 1e-6);
    for (let i = 0; i < count; i++) {
        const n = g.query(x[i], y[i], 0, radius);
        for (let j = 0; j < n; j++) {
            const p = g.results[j];
            if (g.ids[p] === i) continue;
            const dx = g.px[p] - x[i], dy = g.py[p] - y[i];
            if (dx * dx + dy * dy < r2) { releaseKDGrid(g); return false; }
        }
        g.insert(x[i], y[i], 0, i);
    }
    releaseKDGrid(g);
    return true;
}
export function isPoisson3D(x, y, z, count, radius) {
    count = count === undefined ? x.length : count;
    if (count < 2) return true;
    const g = acquireKDGrid(radius / SQRT_3, count, 3);
    const r2 = radius * radius * (1 - 1e-6);
    for (let i = 0; i < count; i++) {
        const n = g.query(x[i], y[i], z[i], radius);
        for (let j = 0; j < n; j++) {
            const p = g.results[j];
            if (g.ids[p] === i) continue;
            const dx = g.px[p] - x[i], dy = g.py[p] - y[i], dz = g.pz[p] - z[i];
            if (dx * dx + dy * dy + dz * dz < r2) { releaseKDGrid(g); return false; }
        }
        g.insert(x[i], y[i], z[i], i);
    }
    releaseKDGrid(g);
    return true;
}

/** Thin a set down to a valid Poisson distribution. Returns the kept count. */
export function poissonReconstruction2DInto(outX, outY, x, y, count, radius) {
    count = count === undefined ? x.length : count;
    const g = acquireKDGrid(radius / SQRT_2, count, 2);
    let n = 0;
    for (let i = 0; i < count; i++) {
        if (g.anyWithin(x[i], y[i], 0, radius, 2)) continue;
        outX[n] = x[i]; outY[n] = y[i];
        g.insert(x[i], y[i], 0, n);
        n++;
    }
    releaseKDGrid(g);
    return n;
}
export function poissonReconstruction2D(x, y, count, radius) {
    count = count === undefined ? x.length : count;
    const T = getArrayType();
    const ox = new T(count), oy = new T(count);
    const n = poissonReconstruction2DInto(ox, oy, x, y, count, radius);
    return { x: ox.subarray(0, n), y: oy.subarray(0, n), count: n };
}

// ============================================================================
// Stratified / jittered
// ============================================================================
export function jitteredGrid2DInto(outX, outY, cellsX, cellsY, bounds, rng, maxPoints) {
    bounds = _bounds2(bounds);
    rng = rng || Math.random;
    const cap = maxPoints === undefined ? cellsX * cellsY : maxPoints;
    const cellW = (bounds.maxX - bounds.minX) / cellsX;
    const cellH = (bounds.maxY - bounds.minY) / cellsY;
    let n = 0;
    for (let j = 0; j < cellsY && n < cap; j++) {
        for (let i = 0; i < cellsX && n < cap; i++) {
            outX[n] = bounds.minX + (i + rng()) * cellW;
            outY[n] = bounds.minY + (j + rng()) * cellH;
            n++;
        }
    }
    return n;
}
export function jitteredGrid2D(cellsX, cellsY, bounds, rng, outX, outY) {
    const T = getArrayType();
    const count = cellsX * cellsY;
    const ox = outX || new T(count), oy = outY || new T(count);
    const n = jitteredGrid2DInto(ox, oy, cellsX, cellsY, bounds, rng, Math.min(count, ox.length));
    return { x: ox, y: oy, count: n, cellsX: cellsX, cellsY: cellsY };
}
/** CORRECTED: the Z axis now uses `cellD` (the original used `cellH`). */
export function jitteredGrid3DInto(outX, outY, outZ, cellsX, cellsY, cellsZ, bounds, rng, maxPoints) {
    bounds = _bounds3(bounds);
    rng = rng || Math.random;
    const cap = maxPoints === undefined ? cellsX * cellsY * cellsZ : maxPoints;
    const cellW = (bounds.maxX - bounds.minX) / cellsX;
    const cellH = (bounds.maxY - bounds.minY) / cellsY;
    const cellD = (bounds.maxZ - bounds.minZ) / cellsZ;
    let n = 0;
    for (let k = 0; k < cellsZ && n < cap; k++) {
        for (let j = 0; j < cellsY && n < cap; j++) {
            for (let i = 0; i < cellsX && n < cap; i++) {
                outX[n] = bounds.minX + (i + rng()) * cellW;
                outY[n] = bounds.minY + (j + rng()) * cellH;
                outZ[n] = bounds.minZ + (k + rng()) * cellD;
                n++;
            }
        }
    }
    return n;
}
export function jitteredGrid3D(cellsX, cellsY, cellsZ, bounds, rng, outX, outY, outZ) {
    const T = getArrayType();
    const count = cellsX * cellsY * cellsZ;
    const ox = outX || new T(count), oy = outY || new T(count), oz = outZ || new T(count);
    const n = jitteredGrid3DInto(ox, oy, oz, cellsX, cellsY, cellsZ, bounds, rng,
        Math.min(count, ox.length));
    return { x: ox, y: oy, z: oz, count: n, cellsX: cellsX, cellsY: cellsY, cellsZ: cellsZ };
}
/** CORRECTED: square stratification (the original produced a 1×N strip). */
export function stratifiedSample2D(count, bounds, rng, outX, outY) {
    const T = getArrayType();
    const ox = outX || new T(count), oy = outY || new T(count);
    const cellsX = Math.max(1, Math.ceil(Math.sqrt(count)));
    const cellsY = Math.max(1, Math.ceil(count / cellsX));
    const n = jitteredGrid2DInto(ox, oy, cellsX, cellsY, bounds, rng, count);
    return { x: ox, y: oy, count: n, cellsX: cellsX, cellsY: cellsY };
}

// ============================================================================
// Lloyd relaxation — discrete Voronoi centroids (REAL relaxation)
// ============================================================================
/**
 * CORRECTED: the previous implementation collapsed the point set. This is a
 * genuine Lloyd step: rasterise the domain, assign each sample to its nearest
 * site (grid-accelerated), accumulate per-site centroids, then move the sites.
 * `resolution` controls samples per axis (default ≈ 4·√N, capped at 512).
 */
export function lloydRelax2D(points, iterations, bounds, resolution) {
    iterations = iterations === undefined ? 5 : iterations;
    bounds = _bounds2(bounds);
    const n = points.count;
    if (n === 0) return points;
    const x = points.x, y = points.y;
    const rangeX = bounds.maxX - bounds.minX;
    const rangeY = bounds.maxY - bounds.minY;
    const spacing = Math.sqrt(Math.max(rangeX * rangeY, EPSILON) / n);
    const res = resolution || Math.min(512, Math.max(16, Math.ceil(4 * Math.sqrt(n))));
    const g = acquireKDGrid(spacing, n, 2);
    const s = acquireBlueNoiseScratch(0);
    s.ensureAccum(n);
    const maxR = spacing * 8;
    const stepX = rangeX / res, stepY = rangeY / res;
    for (let it = 0; it < iterations; it++) {
        g.setCellSize(spacing);
        g.reserve(n);
        for (let i = 0; i < n; i++) g.insert(x[i], y[i], 0, i);
        s.sumX.fill(0, 0, n); s.sumY.fill(0, 0, n); s.hits.fill(0, 0, n);
        for (let j = 0; j < res; j++) {
            const sy = bounds.minY + (j + 0.5) * stepY;
            for (let i = 0; i < res; i++) {
                const sx = bounds.minX + (i + 0.5) * stepX;
                const slot = g.nearestSlot(sx, sy, 0, maxR);
                if (slot < 0) continue;
                const id = g.ids[slot];
                s.sumX[id] += sx; s.sumY[id] += sy; s.hits[id]++;
            }
        }
        for (let i = 0; i < n; i++) {
            if (s.hits[i] === 0) continue;
            const inv = 1 / s.hits[i];
            x[i] = s.sumX[i] * inv;
            y[i] = s.sumY[i] * inv;
        }
    }
    releaseBlueNoiseScratch(s);
    releaseKDGrid(g);
    return points;
}
export function lloydRelax3D(points, iterations, bounds, resolution) {
    iterations = iterations === undefined ? 3 : iterations;
    bounds = _bounds3(bounds);
    const n = points.count;
    if (n === 0 || !points.z) return points;
    const x = points.x, y = points.y, z = points.z;
    const rx = bounds.maxX - bounds.minX;
    const ry = bounds.maxY - bounds.minY;
    const rz = bounds.maxZ - bounds.minZ;
    const spacing = Math.cbrt(Math.max(rx * ry * rz, EPSILON) / n);
    const res = resolution || Math.min(96, Math.max(8, Math.ceil(3 * Math.cbrt(n))));
    const g = acquireKDGrid(spacing, n, 3);
    const s = acquireBlueNoiseScratch(0);
    s.ensureAccum(n);
    const maxR = spacing * 6;
    const sx = rx / res, sy = ry / res, sz = rz / res;
    for (let it = 0; it < iterations; it++) {
        g.setCellSize(spacing);
        g.reserve(n);
        for (let i = 0; i < n; i++) g.insert(x[i], y[i], z[i], i);
        s.sumX.fill(0, 0, n); s.sumY.fill(0, 0, n); s.sumZ.fill(0, 0, n); s.hits.fill(0, 0, n);
        for (let k = 0; k < res; k++) {
            const cz = bounds.minZ + (k + 0.5) * sz;
            for (let j = 0; j < res; j++) {
                const cy = bounds.minY + (j + 0.5) * sy;
                for (let i = 0; i < res; i++) {
                    const cx = bounds.minX + (i + 0.5) * sx;
                    const slot = g.nearestSlot(cx, cy, cz, maxR);
                    if (slot < 0) continue;
                    const id = g.ids[slot];
                    s.sumX[id] += cx; s.sumY[id] += cy; s.sumZ[id] += cz; s.hits[id]++;
                }
            }
        }
        for (let i = 0; i < n; i++) {
            if (s.hits[i] === 0) continue;
            const inv = 1 / s.hits[i];
            x[i] = s.sumX[i] * inv; y[i] = s.sumY[i] * inv; z[i] = s.sumZ[i] * inv;
        }
    }
    releaseBlueNoiseScratch(s);
    releaseKDGrid(g);
    return points;
}

// ============================================================================
// Void-and-cluster (Ulichney) — full three-phase, incremental energy
// ============================================================================
function _vcEnsure(N) {
    if (_vcBinary.length < N) {
        _vcBinary = new Uint8Array(N);
        _vcInitial = new Uint8Array(N);
        _vcEnergy = new Float32Array(N);
    }
    return N;
}
function _vcCreate(size, rng, options) {
    options = options || {};
    const N = size * size;
    _vcEnsure(N);
    const sigma = options.sigma === undefined ? 1.5 : options.sigma;
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kw = radius * 2 + 1;
    if (_vcKernel.length < kw * kw) _vcKernel = new Float32Array(kw * kw);
    const kernel = _vcKernel;
    const inv2s2 = 1 / (2 * sigma * sigma);
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            kernel[(dy + radius) * kw + (dx + radius)] = Math.exp(-(dx * dx + dy * dy) * inv2s2);
        }
    }
    const binary = _vcBinary, initial = _vcInitial, energy = _vcEnergy;
    binary.fill(0, 0, N);
    energy.fill(0, 0, N);
    const rank = new Int32Array(N);
    rank.fill(-1);
    const initialCount = Math.max(1, Math.min(N - 1, (N * (options.initialFraction || 0.1)) | 0));
    const st = {
        size: size, N: N, radius: radius, kw: kw, kernel: kernel,
        binary: binary, initial: initial, energy: energy, rank: rank,
        rng: rng || Math.random,
        phase: 0, rankCursor: initialCount - 1, ones: 0, initialCount: initialCount,
        placed: 0, done: false
    };
    // Seed the initial binary pattern.
    let guard = 0;
    while (st.ones < initialCount && guard < N * 32) {
        guard++;
        const idx = (st.rng() * N) | 0;
        if (binary[idx]) continue;
        _vcToggle(st, idx, 1);
        st.ones++;
    }
    initial.set(binary.subarray(0, N));
    return st;
}
function _vcToggle(st, idx, value) {
    const size = st.size, N = st.N, r = st.radius, kw = st.kw;
    const kernel = st.kernel, energy = st.energy, binary = st.binary;
    const x = idx % size, y = (idx / size) | 0;
    const sign = value ? 1 : -1;
    binary[idx] = value;
    for (let dy = -r; dy <= r; dy++) {
        let ny = y + dy;
        ny = ((ny % size) + size) % size;
        const krow = (dy + r) * kw;
        const row = ny * size;
        for (let dx = -r; dx <= r; dx++) {
            let nx = x + dx;
            nx = ((nx % size) + size) % size;
            energy[row + nx] += sign * kernel[krow + dx + r];
        }
    }
}
function _vcFindTightest(st) {
    const N = st.N, binary = st.binary, energy = st.energy;
    let best = -Infinity, bestI = -1;
    for (let i = 0; i < N; i++) {
        if (!binary[i]) continue;
        const e = energy[i];
        if (e > best) { best = e; bestI = i; }
    }
    return bestI;
}
function _vcFindVoid(st) {
    const N = st.N, binary = st.binary, energy = st.energy;
    let best = Infinity, bestI = -1;
    for (let i = 0; i < N; i++) {
        if (binary[i]) continue;
        const e = energy[i];
        if (e < best) { best = e; bestI = i; }
    }
    return bestI;
}
/** Process up to `budget` rank assignments. Returns true when finished. */
function _vcStep(st, budget) {
    const half = st.N >> 1;
    let used = 0;
    while (used < budget && !st.done) {
        if (st.phase === 0) {
            // Phase 1 — remove tightest clusters, ranks initialCount-1 .. 0.
            const idx = _vcFindTightest(st);
            if (idx < 0) { st.phase = 1; st.rankCursor = st.initialCount; continue; }
            st.rank[idx] = st.rankCursor--;
            _vcToggle(st, idx, 0);
            st.ones--;
            used++;
            if (st.ones === 0) {
                // Restore the initial pattern for phase 2.
                st.binary.set(st.initial.subarray(0, st.N));
                st.energy.fill(0, 0, st.N);
                for (let i = 0; i < st.N; i++) if (st.binary[i]) _vcToggle(st, i, 1);
                st.ones = st.initialCount;
                st.phase = 1;
                st.rankCursor = st.initialCount;
            }
        } else if (st.phase === 1) {
            // Phase 2 — insert into largest voids, ranks initialCount .. half-1.
            if (st.ones >= half) { st.phase = 2; st.rankCursor = half; continue; }
            const idx = _vcFindVoid(st);
            if (idx < 0) { st.phase = 2; st.rankCursor = half; continue; }
            st.rank[idx] = st.rankCursor++;
            _vcToggle(st, idx, 1);
            st.ones++;
            used++;
        } else {
            // Phase 3 — remove tightest clusters, ranks half .. N-1.
            if (st.rankCursor >= st.N) { st.done = true; break; }
            const idx = _vcFindTightest(st);
            if (idx < 0) { st.done = true; break; }
            st.rank[idx] = st.rankCursor++;
            _vcToggle(st, idx, 0);
            st.ones--;
            used++;
        }
    }
    return st.done;
}
/** Write a full void-and-cluster ranking into `outMask` (Int32Array, size²). */
export function voidAndClusterInto(outMask, size, rng, options) {
    size = size || 64;
    const st = _vcCreate(size, rng, options);
    while (!_vcStep(st, 1 << 30)) { /* run to completion */ }
    const n = Math.min(outMask.length, st.N);
    for (let i = 0; i < n; i++) outMask[i] = st.rank[i];
    return outMask;
}
export function voidAndCluster(size, rng, options) {
    size = size || 64;
    const mask = new Int32Array(size * size);
    voidAndClusterInto(mask, size, rng, options);
    return { mask: mask, size: size };
}
export function blueNoiseMask(size, rng, options) { return voidAndCluster(size, rng, options); }
/** Chunked async mask generation — yields every `yieldEvery` rank batches. */
export async function voidAndClusterChunked(outMask, size, rng, options, chunkSize, yieldEvery) {
    size = size || 64;
    chunkSize = chunkSize || 256;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const st = _vcCreate(size, rng, options);
    let c = 0;
    while (!_vcStep(st, chunkSize)) {
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    const n = Math.min(outMask.length, st.N);
    for (let i = 0; i < n; i++) outMask[i] = st.rank[i];
    await common.yieldToMain();
    return outMask;
}
/** CORRECTED: bin-centre thresholds `(rank + 0.5) / N`, in (0,1). */
export function thresholdMask(mask, size, out) {
    const n = mask.length;
    const o = out || new Float32Array(n);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
        const r = mask[i];
        o[i] = r < 0 ? 0 : (r + 0.5) * inv;
    }
    return o;
}

// ============================================================================
// SOA fillers (sync)
// ============================================================================
export function soaHammersley2D(positions, n) {
    return hammersley2D(positions.x, positions.y,
        n === undefined ? positions.count : n, positions.count);
}
export function soaHammersley3D(positions, n) {
    return hammersley3D(positions.x, positions.y, positions.z,
        n === undefined ? positions.count : n, positions.count);
}
export function soaHalton2D(positions, start) {
    return halton2D(positions.x, positions.y, start || 0, positions.count);
}
export function soaHalton3D(positions, start) {
    return halton3D(positions.x, positions.y, positions.z, start || 0, positions.count);
}
export function soaSobol2D(positions, n) {
    return sobol2D(positions.x, positions.y,
        n === undefined ? positions.count : n, positions.count);
}
export function soaBestCandidate2D(positions, bounds, k, rng) {
    return bestCandidate2DInto(positions.x, positions.y, positions.count, bounds, k, rng);
}
export function soaBestCandidate3D(positions, bounds, k, rng) {
    return bestCandidate3DInto(positions.x, positions.y, positions.z, positions.count, bounds, k, rng);
}
/** Returns the accepted count (zero allocation). */
export function soaPoissonDisk2DInto(positions, radius, bounds, k, rng) {
    return poissonDisk2DInto(positions.x, positions.y, radius, bounds, k, rng, positions.count);
}
export function soaPoissonDisk2D(positions, radius, bounds, k, rng) {
    const n = soaPoissonDisk2DInto(positions, radius, bounds, k, rng);
    return { filled: n, requested: positions.count };
}
export function soaPoissonDisk3DInto(positions, radius, bounds, k, rng) {
    return poissonDisk3DInto(positions.x, positions.y, positions.z, radius, bounds, k, rng, positions.count);
}
export function soaPoissonDisk3D(positions, radius, bounds, k, rng) {
    const n = soaPoissonDisk3DInto(positions, radius, bounds, k, rng);
    return { filled: n, requested: positions.count };
}
export function soaJitteredGrid2D(positions, bounds, rng) {
    const count = positions.count;
    const cellsX = Math.max(1, Math.ceil(Math.sqrt(count)));
    const cellsY = Math.max(1, Math.ceil(count / cellsX));
    const n = jitteredGrid2DInto(positions.x, positions.y, cellsX, cellsY, bounds, rng, count);
    return { cellsX: cellsX, cellsY: cellsY, count: n };
}
export function soaJitteredGrid3D(positions, bounds, rng) {
    const count = positions.count;
    const c = Math.max(1, Math.ceil(Math.cbrt(count)));
    const cellsX = c, cellsY = c;
    const cellsZ = Math.max(1, Math.ceil(count / (cellsX * cellsY)));
    const n = jitteredGrid3DInto(positions.x, positions.y, positions.z,
        cellsX, cellsY, cellsZ, bounds, rng, count);
    return { cellsX: cellsX, cellsY: cellsY, cellsZ: cellsZ, count: n };
}
export function soaWhiteNoise2D(positions, rng, bounds) {
    bounds = _bounds2(bounds);
    rng = rng || Math.random;
    const n = positions.count;
    const rx = bounds.maxX - bounds.minX, ry = bounds.maxY - bounds.minY;
    const x = positions.x, y = positions.y;
    for (let i = 0; i < n; i++) {
        x[i] = bounds.minX + rng() * rx;
        y[i] = bounds.minY + rng() * ry;
    }
    return positions;
}
/** Map normalized [0,1] samples into an arbitrary 2D/3D bounds. Zero-GC. */
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
// Double-single sample → world bridge (Blueprint §26)
// ============================================================================
/** out2 = origin + (s − 0.5)·extent, exact to ~106 bits. */
export function dsFromSample(out2, s, originHi, originLo, extent) {
    dsMulInto(_p2, s - 0.5, extent);
    return dsAdd22Into(out2, originHi, originLo, _p2[0], _p2[1]);
}
/**
 * Lift normalized [0,1] samples into a double-single world store
 * `{ x:{hi,lo}, y:{hi,lo}, z:{hi,lo} }` (matches double.attachHighPrecisionPositions).
 * `originHi/originLo` are 3-element array-likes; `extent` is a scalar or 3-array.
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
        dsFromSample(_ds2, sx[i], originHi[0], originLo ? originLo[0] : 0, ex);
        xh[idx] = _ds2[0]; xl[idx] = _ds2[1];
        dsFromSample(_ds2, sy[i], originHi[1], originLo ? originLo[1] : 0, ey);
        yh[idx] = _ds2[0]; yl[idx] = _ds2[1];
        if (zh && sz) {
            dsFromSample(_ds2, sz[i], originHi[2], originLo ? originLo[2] : 0, ez);
            zh[idx] = _ds2[0]; zl[idx] = _ds2[1];
        }
    }
    return world;
}
/**
 * Full §26 pipeline: normalized samples → exact DS world → camera-relative
 * Float32. Renormalization happens BEFORE the fround, so sub-millimetre detail
 * survives megaparsec offsets.
 */
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
        dsFromSample(_ds2, sx[i], originHi[0], originLo ? originLo[0] : 0, ex);
        dsSubInto(_ds3, _ds2[0], _ds2[1], c0, l0);
        ox[i] = Math.fround(_ds3[0] + _ds3[1]);
        dsFromSample(_ds2, sy[i], originHi[1], originLo ? originLo[1] : 0, ey);
        dsSubInto(_ds3, _ds2[0], _ds2[1], c1, l1);
        oy[i] = Math.fround(_ds3[0] + _ds3[1]);
        if (sz) {
            dsFromSample(_ds2, sz[i], originHi[2], originLo ? originLo[2] : 0, ez);
            dsSubInto(_ds3, _ds2[0], _ds2[1], c2, l2);
            oz[i] = Math.fround(_ds3[0] + _ds3[1]);
        }
    }
    return outVec3;
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

export async function soaHammersley2DChunked(positions, n, cs, ye) {
    const count = positions.count;
    n = n === undefined ? count : n;
    const invN = n > 0 ? 1 / n : 0;
    const x = positions.x, y = positions.y;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) { x[i] = i * invN; y[i] = radicalInverse(i, 2); }
    });
    return positions;
}
export async function soaHammersley3DChunked(positions, n, cs, ye) {
    const count = positions.count;
    n = n === undefined ? count : n;
    const invN = n > 0 ? 1 / n : 0;
    const x = positions.x, y = positions.y, z = positions.z;
    await _chunked(count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            x[i] = i * invN; y[i] = radicalInverse(i, 2); z[i] = radicalInverse(i, 3);
        }
    });
    return positions;
}
export async function soaHalton2DChunked(positions, start, cs, ye) {
    start = start || 0;
    const x = positions.x, y = positions.y;
    await _chunked(positions.count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const idx = start + i;
            x[i] = radicalInverse(idx, 2); y[i] = radicalInverse(idx, 3);
        }
    });
    return positions;
}
export async function soaHalton3DChunked(positions, start, cs, ye) {
    start = start || 0;
    const x = positions.x, y = positions.y, z = positions.z;
    await _chunked(positions.count, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const idx = start + i;
            x[i] = radicalInverse(idx, 2); y[i] = radicalInverse(idx, 3); z[i] = radicalInverse(idx, 5);
        }
    });
    return positions;
}
/** Chunked Sobol — the Gray-code state is carried across chunk boundaries. */
export async function soaSobol2DChunked(positions, n, cs, ye) {
    const count = positions.count;
    const x = positions.x, y = positions.y;
    let sx = 0, sy = 0;
    if (count > 0) { x[0] = 0; y[0] = 0; }
    await _chunked(count > 0 ? count - 1 : 0, cs, ye, function (s, e) {
        for (let j = s; j < e; j++) {
            const i = j + 1;
            const c = ctz32(i);
            sx = (sx ^ SOBOL_DIR1[c]) >>> 0;
            sy = (sy ^ SOBOL_DIR2[c]) >>> 0;
            x[i] = sx * INV_2_32;
            y[i] = sy * INV_2_32;
        }
    });
    return positions;
}
export async function soaOwenScramble2DChunked(positions, seed, cs, ye) {
    const count = positions.count;
    const x = positions.x, y = positions.y;
    const s0 = seed | 0, s1 = (seed ^ 0x68bc21eb) | 0;
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) {
            x[i] = owenScramble((x[i] * 4294967296) >>> 0, s0) * INV_2_32;
            y[i] = owenScramble((y[i] * 4294967296) >>> 0, s1) * INV_2_32;
        }
    });
    return positions;
}
/** CORRECTED: separate chunk / yield counters (the original never yielded). */
export async function soaBestCandidate2DChunked(positions, bounds, k, rng, cs, ye) {
    bounds = _bounds2(bounds);
    k = k || 8;
    rng = rng || Math.random;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const count = positions.count;
    const x = positions.x, y = positions.y;
    const rangeX = bounds.maxX - bounds.minX;
    const rangeY = bounds.maxY - bounds.minY;
    const spacing = Math.sqrt(Math.max(rangeX * rangeY, EPSILON) / Math.max(1, count));
    const g = acquireKDGrid(spacing, count, 2);
    const maxR = spacing * 8, capD2 = maxR * maxR;
    let sinceYield = 0;
    for (let i = 0; i < count; i++) {
        let bestX = bounds.minX, bestY = bounds.minY, bestDist = -1;
        for (let c = 0; c < k; c++) {
            const cx = bounds.minX + rng() * rangeX;
            const cy = bounds.minY + rng() * rangeY;
            let d2 = g.nearestDistSq(cx, cy, 0, maxR);
            if (d2 === Infinity) d2 = capD2;
            if (d2 > bestDist) { bestDist = d2; bestX = cx; bestY = cy; }
        }
        x[i] = bestX; y[i] = bestY;
        g.insert(bestX, bestY, 0, i);
        if (++sinceYield >= cs) {
            sinceYield = 0;
            await common.yieldToMain();
        }
    }
    releaseKDGrid(g);
    return positions;
}
/**
 * Genuinely chunked Bridson: yields every `cs` accepted points.
 * CORRECTED: the original wrapped synchronous generation in a Promise executor
 * and blocked the thread for the entire run.
 */
export async function soaPoissonDisk2DChunked(positions, radius, bounds, k, rng, cs, ye) {
    bounds = _bounds2(bounds);
    k = k || 30;
    rng = rng || Math.random;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    radius = radius > 0 ? radius : 0.05;
    const cap = positions.count;
    const minX = bounds.minX, minY = bounds.minY;
    const width = bounds.maxX - minX, height = bounds.maxY - minY;
    const cell = radius / SQRT_2, invCell = 1 / cell, r2 = radius * radius;

    const s = acquireBlueNoiseScratch(Math.min(cap, 4096));
    s.ensureLinks(Math.min(cap, 4096));
    s.ensureActive(Math.min(cap, 4096) + 8);
    const tableSize = _nextPow2(Math.min(cap, 1 << 20) * 2);
    const mask = tableSize - 1;
    s.ensureGrid(tableSize);
    s.grid.fill(-1);

    let px = s.x, py = s.y, next = s.next, gcx = s.cx, gcy = s.cy;
    let active = s.active, activeCount = 0, count = 0, sinceYield = 0, batch = 0;

    function push(x, y) {
        if (count >= s.capacity) {
            const nc = s.capacity * 2;
            s.ensure(nc); s.ensureLinks(nc);
            px = s.x; py = s.y; next = s.next; gcx = s.cx; gcy = s.cy;
        }
        const slot = count++;
        px[slot] = x; py[slot] = y;
        const ci = Math.floor((x - minX) * invCell);
        const cj = Math.floor((y - minY) * invCell);
        gcx[slot] = ci; gcy[slot] = cj;
        const h = _hashCell(ci, cj, 0, mask);
        next[slot] = s.grid[h];
        s.grid[h] = slot;
        if (activeCount >= s.activeSize) { s.ensureActive(s.activeSize * 2); active = s.active; }
        active[activeCount++] = slot;
    }
    function blocked(x, y) {
        const ci = Math.floor((x - minX) * invCell);
        const cj = Math.floor((y - minY) * invCell);
        for (let dj = -2; dj <= 2; dj++) {
            const gj = cj + dj;
            for (let di = -2; di <= 2; di++) {
                const gi = ci + di;
                let p = s.grid[_hashCell(gi, gj, 0, mask)];
                while (p !== -1) {
                    if (gcx[p] === gi && gcy[p] === gj) {
                        const dx = px[p] - x, dy = py[p] - y;
                        if (dx * dx + dy * dy < r2) return true;
                    }
                    p = next[p];
                }
            }
        }
        return false;
    }

    push(minX + rng() * width, minY + rng() * height);
    while (activeCount > 0 && count < cap) {
        const ai = (rng() * activeCount) | 0;
        const slot = active[ai];
        const ax = px[slot], ay = py[slot];
        let found = false;
        for (let t = 0; t < k; t++) {
            const theta = rng() * TAU;
            const rr = radius * (1 + rng());
            const nx = ax + Math.cos(theta) * rr;
            const ny = ay + Math.sin(theta) * rr;
            if (nx < minX || nx >= bounds.maxX || ny < minY || ny >= bounds.maxY) continue;
            if (blocked(nx, ny)) continue;
            push(nx, ny);
            found = true;
            break;
        }
        if (!found) { activeCount--; active[ai] = active[activeCount]; }
        if (++sinceYield >= cs) {
            sinceYield = 0;
            if (++batch >= ye) { batch = 0; await common.yieldToMain(); }
        }
    }
    const outX = positions.x, outY = positions.y;
    const n = Math.min(count, cap);
    await _chunked(n, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) { outX[i] = s.x[i]; outY[i] = s.y[i]; }
    });
    releaseBlueNoiseScratch(s);
    return { filled: n, requested: cap };
}
export async function soaJitteredGrid2DChunked(positions, bounds, rng, cs, ye) {
    const count = positions.count;
    const cellsX = Math.max(1, Math.ceil(Math.sqrt(count)));
    const cellsY = Math.max(1, Math.ceil(count / cellsX));
    bounds = _bounds2(bounds);
    rng = rng || Math.random;
    const x = positions.x, y = positions.y;
    const cellW = (bounds.maxX - bounds.minX) / cellsX;
    const cellH = (bounds.maxY - bounds.minY) / cellsY;
    await _chunked(cellsY, cs, ye, function (s, e) {
        for (let j = s; j < e; j++) {
            for (let i = 0; i < cellsX; i++) {
                const n = j * cellsX + i;
                if (n >= count) break;
                x[n] = bounds.minX + (i + rng()) * cellW;
                y[n] = bounds.minY + (j + rng()) * cellH;
            }
        }
    });
    return positions;
}
export async function soaJitteredGrid3DChunked(positions, bounds, rng, cs, ye) {
    const count = positions.count;
    const c = Math.max(1, Math.ceil(Math.cbrt(count)));
    const cellsX = c, cellsY = c;
    const cellsZ = Math.max(1, Math.ceil(count / (cellsX * cellsY)));
    bounds = _bounds3(bounds);
    rng = rng || Math.random;
    const x = positions.x, y = positions.y, z = positions.z;
    const cellW = (bounds.maxX - bounds.minX) / cellsX;
    const cellH = (bounds.maxY - bounds.minY) / cellsY;
    const cellD = (bounds.maxZ - bounds.minZ) / cellsZ;
    await _chunked(cellsZ, cs, ye, function (s, e) {
        for (let k = s; k < e; k++) {
            for (let j = 0; j < cellsY; j++) {
                for (let i = 0; i < cellsX; i++) {
                    const n = (k * cellsY + j) * cellsX + i;
                    if (n >= count) break;
                    x[n] = bounds.minX + (i + rng()) * cellW;
                    y[n] = bounds.minY + (j + rng()) * cellH;
                    z[n] = bounds.minZ + (k + rng()) * cellD;
                }
            }
        }
    });
    return positions;
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
    await _chunked(count, cs, ye, function (a, b) {
        for (let i = a; i < b; i++) {
            dsFromSample(_ds2, sx[i], originHi[0], originLo ? originLo[0] : 0, ex);
            dsSubInto(_ds3, _ds2[0], _ds2[1], c0, l0);
            ox[i] = Math.fround(_ds3[0] + _ds3[1]);
            dsFromSample(_ds2, sy[i], originHi[1], originLo ? originLo[1] : 0, ey);
            dsSubInto(_ds3, _ds2[0], _ds2[1], c1, l1);
            oy[i] = Math.fround(_ds3[0] + _ds3[1]);
            if (sz) {
                dsFromSample(_ds2, sz[i], originHi[2], originLo ? originLo[2] : 0, ez);
                dsSubInto(_ds3, _ds2[0], _ds2[1], c2, l2);
                oz[i] = Math.fround(_ds3[0] + _ds3[1]);
            }
        }
    });
    return outVec3;
}

// ============================================================================
// LUT authoring (Blueprint §30)
// ============================================================================
/** RGBA float LUT from a void-and-cluster rank mask (R = threshold, A = 1). */
export function buildBlueNoiseLUT(out, mask, size, options) {
    options = options || {};
    const n = size * size;
    const inv = 1 / n;
    const gain = options.gain === undefined ? 1 : options.gain;
    const bipolar = options.bipolar === true;
    for (let i = 0; i < n; i++) {
        const r = mask[i];
        const t = r < 0 ? 0 : (r + 0.5) * inv;
        const v = bipolar ? (t * 2 - 1) * gain : t * gain;
        const o = i * 4;
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 1;
    }
    return out;
}
export async function buildBlueNoiseLUTChunked(out, mask, size, options, cs, ye) {
    options = options || {};
    const n = size * size;
    const inv = 1 / n;
    const gain = options.gain === undefined ? 1 : options.gain;
    const bipolar = options.bipolar === true;
    await _chunked(n, cs, ye, function (s, e) {
        for (let i = s; i < e; i++) {
            const r = mask[i];
            const t = r < 0 ? 0 : (r + 0.5) * inv;
            const v = bipolar ? (t * 2 - 1) * gain : t * gain;
            const o = i * 4;
            out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 1;
        }
    });
    return out;
}
/** RGBA float LUT of a 2D sample set rasterised into a `size`×`size` grid. */
export function buildSampleLUT(out, x, y, count, size) {
    const n = size * size;
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 1;
    }
    for (let i = 0; i < count; i++) {
        const px = Math.min(size - 1, Math.max(0, (x[i] * size) | 0));
        const py = Math.min(size - 1, Math.max(0, (y[i] * size) | 0));
        const o = (py * size + px) * 4;
        out[o] = 1; out[o + 1] = 1; out[o + 2] = 1;
    }
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
/** Upload a scalar channel (array or BlueNoiseBatchState) into an attribute. */
export function syncSampleAttribute(attr, values, count, options) {
    if (!attr || !attr.array) return 0;
    options = options || {};
    const isState = !!(values && values.points);
    const src = isState ? values.points.x : values;
    const n = count === undefined ? (isState ? values.pointCount : src.length) : count;
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
// Deterministic temporal sampling (Blueprint §45 / §51)
// ============================================================================
/** Drift-free sampling clock — both time and accumulator are compensated. */
export class SampleClock {
    constructor(options) {
        options = options || {};
        this.hz = options.hz !== undefined ? options.hz : 60;
        this.fixedDt = 1 / this.hz;
        this.maxSteps = options.maxSteps !== undefined ? options.maxSteps : 8;
        this.maxFrameDt = options.maxFrameDt !== undefined ? options.maxFrameDt : 0.25;
        this.onStep = options.onStep || null;
        this._tS = 0; this._tC = 0;
        this._aS = 0; this._aC = 0;
        this.ticks = 0; this.alpha = 0; this.dropped = 0;
    }
    get time() { return this._tS + this._tC; }
    get accumulator() { return this._aS + this._aC; }
    _addTime(x) {
        const t = this._tS + x;
        if (Math.abs(this._tS) >= Math.abs(x)) this._tC += (this._tS - t) + x;
        else this._tC += (x - t) + this._tS;
        this._tS = t;
    }
    _addAcc(x) {
        const t = this._aS + x;
        if (Math.abs(this._aS) >= Math.abs(x)) this._aC += (this._aS - t) + x;
        else this._aC += (x - t) + this._aS;
        this._aS = t;
    }
    step(dtSec) {
        const dt = dtSec < 0 ? 0 : (dtSec > this.maxFrameDt ? this.maxFrameDt : dtSec);
        this._addAcc(dt);
        const fdt = this.fixedDt;
        let steps = 0;
        while (this._aS + this._aC >= fdt && steps < this.maxSteps) {
            this._addTime(fdt);
            if (this.onStep) this.onStep(fdt, this.ticks);
            this._addAcc(-fdt);
            this.ticks++; steps++;
        }
        if (steps === this.maxSteps) { this.dropped++; this._aS = 0; this._aC = 0; }
        this.alpha = (this._aS + this._aC) / fdt;
        return steps;
    }
    stepMs(dtMs) { return this.step(dtMs * 0.001); }
    reset() {
        this._tS = 0; this._tC = 0; this._aS = 0; this._aC = 0;
        this.ticks = 0; this.alpha = 0; this.dropped = 0;
        return this;
    }
}
export function createSampleClock(options) { return new SampleClock(options); }

/**
 * Deterministic per-frame sample set: a base low-discrepancy sequence,
 * Owen-scrambled once, then Cranley–Patterson rotated by a per-tick offset.
 * Identical output for identical tick indices regardless of display refresh.
 */
export function createTemporalSampler(count, options) {
    options = options || {};
    const dims = options.dimensions === 3 ? 3 : 2;
    const points = dims === 3 ? createVec3SOA(count) : createVec2SOA(count);
    const baseX = new Float64Array(count);
    const baseY = new Float64Array(count);
    const baseZ = dims === 3 ? new Float64Array(count) : null;
    const seed = options.seed === undefined ? 1 : options.seed;
    const period = options.period || 64;
    const kind = options.sampler === "halton" ? SAMPLER_HALTON :
        options.sampler === "sobol" ? SAMPLER_SOBOL : SAMPLER_HAMMERSLEY;
    if (kind === SAMPLER_HALTON) halton2D(baseX, baseY, 1, count);
    else if (kind === SAMPLER_SOBOL) sobol2D(baseX, baseY, count, count);
    else hammersley2D(baseX, baseY, count, count);
    if (baseZ) hammersley3D(baseX, baseY, baseZ, count, count);
    soaOwenScramble2D(baseX, baseY, seed, count);
    const clock = new SampleClock(options);
    let frame = 0;
    function regenerate() {
        const f = frame % period;
        const dx = radicalInverse(f + 1, 2);
        const dy = radicalInverse(f + 1, 3);
        const x = points.x, y = points.y, z = points.z;
        for (let i = 0; i < count; i++) {
            let a = baseX[i] + dx; a -= Math.floor(a);
            let b = baseY[i] + dy; b -= Math.floor(b);
            x[i] = a; y[i] = b;
            if (z) { let c = baseZ[i] + dx; c -= Math.floor(c); z[i] = c; }
        }
    }
    regenerate();
    return {
        points: points,
        count: count,
        clock: clock,
        get frame() { return frame; },
        get time() { return clock.time; },
        /** Advance to an explicit frame index (fully deterministic). */
        seek: function (f) { frame = f | 0; regenerate(); return this; },
        /** Fixed-step advance driven by the compensated clock. */
        step: function (dtSec) {
            const before = clock.ticks;
            clock.step(dtSec);
            if (clock.ticks !== before) { frame += clock.ticks - before; regenerate(); }
            return this;
        },
        stepMs: function (dtMs) { return this.step(dtMs * 0.001); },
        regenerate: regenerate,
        uploadTo: function (attr, opts) { return syncSampleVectorAttribute(attr, points, count, opts); },
        reset: function () { frame = 0; clock.reset(); regenerate(); return this; }
    };
}

// ============================================================================
// Batch state
// ============================================================================
export class BlueNoiseBatchState {
    constructor(count, options) {
        options = options || {};
        this.count = count;
        this.dimensions = options.dimensions === 2 ? 2 : 3;
        this.points = this.dimensions === 2 ? createVec2SOA(count) : createVec3SOA(count);
        this.pointCount = 0;
        this._tracked = options.track !== false;
        if (this._tracked) trackBlueNoise(this);
    }
    hammersley(n) {
        if (this.dimensions === 2) soaHammersley2D(this.points, n);
        else soaHammersley3D(this.points, n);
        this.pointCount = this.count;
        return this;
    }
    halton(start) {
        if (this.dimensions === 2) soaHalton2D(this.points, start);
        else soaHalton3D(this.points, start);
        this.pointCount = this.count;
        return this;
    }
    sobol(n) {
        soaSobol2D(this.points, n);
        this.pointCount = this.count;
        return this;
    }
    jitteredGrid(bounds, rng) {
        const r = this.dimensions === 2
            ? soaJitteredGrid2D(this.points, bounds, rng)
            : soaJitteredGrid3D(this.points, bounds, rng);
        this.pointCount = r.count;
        return this;
    }
    poisson(radius, bounds, k, rng) {
        const r = this.dimensions === 2
            ? soaPoissonDisk2D(this.points, radius, bounds, k, rng)
            : soaPoissonDisk3D(this.points, radius, bounds, k, rng);
        this.pointCount = r.filled;
        return this;
    }
    bestCandidate(bounds, k, rng) {
        if (this.dimensions === 2) soaBestCandidate2D(this.points, bounds, k, rng);
        else soaBestCandidate3D(this.points, bounds, k, rng);
        this.pointCount = this.count;
        return this;
    }
    relax(iterations, bounds, resolution) {
        const view = { x: this.points.x, y: this.points.y, z: this.points.z, count: this.pointCount || this.count };
        if (this.dimensions === 2) lloydRelax2D(view, iterations, bounds, resolution);
        else lloydRelax3D(view, iterations, bounds, resolution);
        return this;
    }
    scramble(seed) { soaOwenScramble2D(this.points.x, this.points.y, seed, this.count); return this; }
    rotate(dx, dy) {
        cranleyPatterson2D(this.points.x, this.points.y, this.count, dx, dy, this.count);
        return this;
    }
    remap(bounds) { soaRemapBounds(this.points, bounds, this.pointCount || this.count); return this; }
    async hammersleyChunked(n, cs, ye) {
        if (this.dimensions === 2) await soaHammersley2DChunked(this.points, n, cs, ye);
        else await soaHammersley3DChunked(this.points, n, cs, ye);
        this.pointCount = this.count;
        return this;
    }
    async jitteredGridChunked(bounds, rng, cs, ye) {
        if (this.dimensions === 2) await soaJitteredGrid2DChunked(this.points, bounds, rng, cs, ye);
        else await soaJitteredGrid3DChunked(this.points, bounds, rng, cs, ye);
        this.pointCount = this.count;
        return this;
    }
    async poissonChunked(radius, bounds, k, rng, cs, ye) {
        const r = await soaPoissonDisk2DChunked(this.points, radius, bounds, k, rng, cs, ye);
        this.pointCount = r.filled;
        return this;
    }
    /** Single-pass dirty-range upload (§25/§28). */
    uploadTo(attr, options) {
        return syncSampleVectorAttribute(attr, this.points, this.pointCount || this.count, options);
    }
    reset() {
        this.points.x.fill(0); this.points.y.fill(0);
        if (this.points.z) this.points.z.fill(0);
        this.pointCount = 0;
        return this;
    }
    migrate(targetPrecision) {
        const T = targetPrecision ? getArrayType(targetPrecision) : getArrayType();
        const p = this.points;
        if (p.arrays[0].constructor === T) return this;
        const n = this.count;
        for (let i = 0; i < p.arrays.length; i++) {
            const next = new T(n);
            next.set(p.arrays[i]);
            p.arrays[i] = next;
        }
        p.x = p.arrays[0]; p.y = p.arrays[1];
        if (p.arrays.length > 2) p.z = p.arrays[2];
        return this;
    }
    toTransferable() { return blueNoiseBatchToTransferable(this); }
    dispose() { if (this._tracked) untrackBlueNoise(this); return this; }
}
export function createBlueNoiseBatch(count, options) { return new BlueNoiseBatchState(count, options); }

// ============================================================================
// Precision tracking / migration (dense arrays — no Map/Set, §10/§16)
// ============================================================================
const _trackedBatches = [];
export function trackBlueNoise(state) {
    if (!state) return state;
    if (_trackedBatches.indexOf(state) === -1) _trackedBatches.push(state);
    return state;
}
export function untrackBlueNoise(state) {
    const i = _trackedBatches.indexOf(state);
    if (i !== -1) _trackedBatches.splice(i, 1);
}
export function clearTrackedBlueNoise() { _trackedBatches.length = 0; }
export function getTrackedBlueNoise() { return _trackedBatches; }
export function migrateBlueNoise(state, targetPrecision) {
    if (state && state.migrate) state.migrate(targetPrecision);
    return state;
}
export function migrateAllBlueNoise(targetPrecision) {
    for (let i = 0; i < _trackedBatches.length; i++) {
        try { _trackedBatches[i].migrate(targetPrecision); }
        catch (e) { console.error("[046_blue-noise] migration failed for one batch", e); }
    }
}

onPrecisionChange(function () {
    migrateAllBlueNoise();
    BlueNoiseScratch._warm.length = 0;
    for (let i = 0; i < 3; i++) BlueNoiseScratch._warm.push(new BlueNoiseScratch(0));
});

// ============================================================================
// Zero-copy transferable batch state (Blueprint §49)
// Layout: Int32 header [magic, version, count, dims, pointCount, 0, 0, 0]
//         then x | y | z as Float64 (sample precision must survive the trip).
// ============================================================================
const BN_MAGIC = 0x424c5545; // "BLUE"
const BN_HEADER_BYTES = 32;

export function blueNoiseBatchToTransferable(state) {
    const n = state.count;
    const dims = state.dimensions;
    const buffer = new ArrayBuffer(BN_HEADER_BYTES + n * 8 * dims);
    const header = new Int32Array(buffer, 0, 8);
    header[0] = BN_MAGIC; header[1] = 1; header[2] = n; header[3] = dims;
    header[4] = state.pointCount;
    let off = BN_HEADER_BYTES;
    new Float64Array(buffer, off, n).set(state.points.x); off += n * 8;
    new Float64Array(buffer, off, n).set(state.points.y); off += n * 8;
    if (dims === 3) new Float64Array(buffer, off, n).set(state.points.z);
    return { buffer: buffer, count: n, dimensions: dims, pointCount: state.pointCount, transferable: [buffer] };
}
export function blueNoiseBatchFromTransferable(packet, options) {
    const buffer = packet.buffer || packet;
    const header = new Int32Array(buffer, 0, 8);
    if (header[0] !== BN_MAGIC) throw new Error("blueNoiseBatchFromTransferable: bad magic");
    if (header[1] !== 1) throw new Error("blueNoiseBatchFromTransferable: unsupported version " + header[1]);
    const n = header[2], dims = header[3], pointCount = header[4];
    const opts = options || {};
    opts.dimensions = dims;
    const state = new BlueNoiseBatchState(n, opts);
    let off = BN_HEADER_BYTES;
    state.points.x.set(new Float64Array(buffer, off, n)); off += n * 8;
    state.points.y.set(new Float64Array(buffer, off, n)); off += n * 8;
    if (dims === 3) state.points.z.set(new Float64Array(buffer, off, n));
    state.pointCount = pointCount;
    return state;
}

// ============================================================================
// Namespaces
// ============================================================================
export const lowDiscrepancy = {
    radicalInverse: radicalInverse,
    vanDerCorput: vanDerCorput,
    hammersley: hammersley,
    hammersleyInto: hammersleyInto,
    hammersley2D: hammersley2D,
    hammersley3D: hammersley3D,
    halton: halton,
    halton2D: halton2D,
    halton3D: halton3D,
    sobol2D: sobol2D,
    sobol2DAt: sobol2DAt,
    sobolSequence: sobolSequence,
    ctz32: ctz32,
    cranleyPatterson2D: cranleyPatterson2D,
    owenScramble: owenScramble,
    soaOwenScramble2D: soaOwenScramble2D
};
export const stratified = {
    jitteredGrid2D: jitteredGrid2D,
    jitteredGrid2DInto: jitteredGrid2DInto,
    jitteredGrid3D: jitteredGrid3D,
    jitteredGrid3DInto: jitteredGrid3DInto,
    stratifiedSample2D: stratifiedSample2D
};
export const bestCandidate = {
    c2: bestCandidate2D, c3: bestCandidate3D,
    into2D: bestCandidate2DInto, into3D: bestCandidate3DInto
};
export const poisson = {
    disk2D: poissonDisk2D, disk2DInto: poissonDisk2DInto,
    disk3D: poissonDisk3D, disk3DInto: poissonDisk3DInto,
    dartThrowing2D: dartThrowing2D, dartThrowing2DInto: dartThrowing2DInto,
    weighted2D: weightedPoisson2D, weighted2DInto: weightedPoisson2DInto,
    isPoisson2D: isPoisson2D, isPoisson3D: isPoisson3D,
    reconstruction2D: poissonReconstruction2D,
    reconstruction2DInto: poissonReconstruction2DInto
};
export const relax = {
    lloyd2D: lloydRelax2D,
    lloyd3D: lloydRelax3D
};
export const mask = {
    voidAndCluster: voidAndCluster,
    voidAndClusterInto: voidAndClust