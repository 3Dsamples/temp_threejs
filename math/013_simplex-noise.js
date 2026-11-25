// file number : 013
// full path name : src/math/013_simplex.js
// description : Fast simplex noise (2D / 3D / 4D — every original export
//               preserved, numerically identical to simplex-noise © Jonas
//               Wagner) rewritten as a self-contained native ES module in the
//               three.js r185 JSM addon style: no strict-mode directive, no
//               CommonJS, no Vite / Vue / client build, no CDN request.
//               Adds the full SOA batch layer for 1M+ points at real time:
//               zero-GC seeded noise pools, fBm / turbulence / ridged /
//               domain-warped variants, gradient + divergence-free curl flow
//               fields, vector displacement fields, curl advection integrator,
//               complete chunked-yielding counterparts for every fill (the UI
//               thread never freezes), an optional Blob-URL worker pool for
//               true multi-core noise generation with a non-blocking main
//               thread fallback, a bitECS noise-field system, and duck-typed
//               three.js r185 interop (BufferAttribute / BufferGeometry) so the
//               provided 002..012 SOA math stack stays the default vector /
//               matrix / quaternion maths while three.js only renders.
//               Same coordinate semantics as the original (finite, within
//               ±2^31) so scenes stay seamless from millimetres to megaparsecs.
// best for : 3d graphics with the SOA math stack + bitECS — 1M+ instance
//            terrain heightmaps, cloud / fog / nebula density, asteroid-belt
//            deformation, star-cluster seeding, galaxy arms (fBm + turbulence),
//            foliage scatter, damage / rust masks, planet detail, dust and
//            wind / water flow (curl = divergence-free), animated 4D noise for
//            ocean / plasma / fire, and seamless small-to-galactic scale by
//            scaling coordinates independently of Float32 world positions.
// license : MIT (original simplex-noise © 2024 Jonas Wagner, MIT)
//
// topological hierarchy (dependencies first — this file is last):
//   src/math/002_vec2.js
//   src/math/003_vec3.js
//   src/math/004_vec4.js
//   src/math/005_mat2.js
//   src/math/006_mat3.js          (optional, dynamic)
//   src/math/007_mat4.js
//   src/math/008_quat.js
//   src/math/009_quat2.js
//   src/math/010_bitECS_core.js   (optional, dynamic)
//   src/math/012_double.js        (optional precision tier, not required)
//   src/math/013_simplex.js       <- THIS FILE
// ============================================================================

import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";

// ============================================================================
// 0. FOUNDATION (inlined — replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;
const POOL_PREALLOC = 16;

function yieldToMain() {
    return new Promise((resolve) => {
        if (typeof setTimeout === "function") { setTimeout(resolve, 0); }
        else { resolve(); }
    });
}

function createPool(factory, capacity = 256, reset) {
    const items = [];
    for (let i = 0; i < capacity; i++) { items.push(factory()); }
    return {
        acquire() { return items.length > 0 ? items.pop() : factory(); },
        release(v) {
            if (reset) { reset(v); }
            if (items.length < capacity) { items.push(v); }
        }
    };
}

/** Deterministic seeded PRNG returning [0,1). */
function mulberry32(seed) {
    let a = seed | 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const common = {
    CHUNK_SIZE, CHUNK_YIELD_EVERY, POOL_PREALLOC,
    yieldToMain, createPool, mulberry32
};

// ============================================================================
// 1. CONSTANTS (identical to the original)
// ============================================================================
const SQRT3 = Math.sqrt(3.0);
const SQRT5 = Math.sqrt(5.0);
const F2 = 0.5 * (SQRT3 - 1.0);
const G2 = (3.0 - SQRT3) / 6.0;
const F3 = 1.0 / 3.0;
const G3 = 1.0 / 6.0;
const F4 = (SQRT5 - 1.0) / 4.0;
const G4 = (5.0 - SQRT5) / 20.0;

const fastFloor = (x) => Math.floor(x) | 0;

const grad2 = new Float64Array([
    1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0,
    1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1
]);

const grad3 = new Float64Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
]);

const grad4 = new Float64Array([
    0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
    0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
    1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
    -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
    1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
    -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
    1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
    -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0
]);

// ============================================================================
// 2. buildPermutationTable (exact copy of the original algorithm)
// ============================================================================
function buildPermutationTable(random = Math.random) {
    const tableSize = 512;
    const p = new Uint8Array(tableSize);
    for (let i = 0; i < tableSize / 2; i++) { p[i] = i; }
    for (let i = 0; i < tableSize / 2 - 1; i++) {
        const r = i + ~~(random() * (256 - i));
        const aux = p[i];
        p[i] = p[r];
        p[r] = aux;
    }
    for (let i = 256; i < tableSize; i++) { p[i] = p[i - 256]; }
    return p;
}

// ============================================================================
// 3. createNoise2D (byte-identical algorithm)
// ============================================================================
function createNoise2D(random = Math.random) {
    const perm = buildPermutationTable(random);
    const permGrad2x = new Float64Array(perm).map((v) => grad2[(v % 12) * 2]);
    const permGrad2y = new Float64Array(perm).map((v) => grad2[(v % 12) * 2 + 1]);

    return function noise2D(x, y) {
        let n0 = 0, n1 = 0, n2 = 0;
        const s = (x + y) * F2;
        const i = fastFloor(x + s);
        const j = fastFloor(y + s);
        const t = (i + j) * G2;
        const X0 = i - t, Y0 = j - t;
        const x0 = x - X0, y0 = y - Y0;

        let i1, j1;
        if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }

        const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
        const x2 = x0 - 1.0 + 2.0 * G2, y2 = y0 - 1.0 + 2.0 * G2;
        const ii = i & 255, jj = j & 255;

        let t0 = 0.5 - x0 * x0 - y0 * y0;
        if (t0 >= 0) {
            const gi0 = ii + perm[jj];
            const g0x = permGrad2x[gi0], g0y = permGrad2y[gi0];
            t0 *= t0;
            n0 = t0 * t0 * (g0x * x0 + g0y * y0);
        }
        let t1 = 0.5 - x1 * x1 - y1 * y1;
        if (t1 >= 0) {
            const gi1 = ii + i1 + perm[jj + j1];
            const g1x = permGrad2x[gi1], g1y = permGrad2y[gi1];
            t1 *= t1;
            n1 = t1 * t1 * (g1x * x1 + g1y * y1);
        }
        let t2 = 0.5 - x2 * x2 - y2 * y2;
        if (t2 >= 0) {
            const gi2 = ii + 1 + perm[jj + 1];
            const g2x = permGrad2x[gi2], g2y = permGrad2y[gi2];
            t2 *= t2;
            n2 = t2 * t2 * (g2x * x2 + g2y * y2);
        }
        return 70.0 * (n0 + n1 + n2);
    };
}

// ============================================================================
// 4. createNoise3D (byte-identical algorithm)
// ============================================================================
function createNoise3D(random = Math.random) {
    const perm = buildPermutationTable(random);
    const permGrad3x = new Float64Array(perm).map((v) => grad3[(v % 12) * 3]);
    const permGrad3y = new Float64Array(perm).map((v) => grad3[(v % 12) * 3 + 1]);
    const permGrad3z = new Float64Array(perm).map((v) => grad3[(v % 12) * 3 + 2]);

    return function noise3D(x, y, z) {
        let n0, n1, n2, n3;
        const s = (x + y + z) * F3;
        const i = fastFloor(x + s);
        const j = fastFloor(y + s);
        const k = fastFloor(z + s);
        const t = (i + j + k) * G3;
        const X0 = i - t, Y0 = j - t, Z0 = k - t;
        const x0 = x - X0, y0 = y - Y0, z0 = z - Z0;

        let i1, j1, k1, i2, j2, k2;
        if (x0 >= y0) {
            if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
            else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
            else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
        } else {
            if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
            else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
            else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        }

        const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
        const x2 = x0 - i2 + 2.0 * G3, y2 = y0 - j2 + 2.0 * G3, z2 = z0 - k2 + 2.0 * G3;
        const x3 = x0 - 1.0 + 3.0 * G3, y3 = y0 - 1.0 + 3.0 * G3, z3 = z0 - 1.0 + 3.0 * G3;
        const ii = i & 255, jj = j & 255, kk = k & 255;

        let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
        if (t0 < 0) { n0 = 0.0; }
        else {
            const gi0 = ii + perm[jj + perm[kk]];
            t0 *= t0;
            n0 = t0 * t0 * (permGrad3x[gi0] * x0 + permGrad3y[gi0] * y0 + permGrad3z[gi0] * z0);
        }
        let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
        if (t1 < 0) { n1 = 0.0; }
        else {
            const gi1 = ii + i1 + perm[jj + j1 + perm[kk + k1]];
            t1 *= t1;
            n1 = t1 * t1 * (permGrad3x[gi1] * x1 + permGrad3y[gi1] * y1 + permGrad3z[gi1] * z1);
        }
        let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
        if (t2 < 0) { n2 = 0.0; }
        else {
            const gi2 = ii + i2 + perm[jj + j2 + perm[kk + k2]];
            t2 *= t2;
            n2 = t2 * t2 * (permGrad3x[gi2] * x2 + permGrad3y[gi2] * y2 + permGrad3z[gi2] * z2);
        }
        let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
        if (t3 < 0) { n3 = 0.0; }
        else {
            const gi3 = ii + 1 + perm[jj + 1 + perm[kk + 1]];
            t3 *= t3;
            n3 = t3 * t3 * (permGrad3x[gi3] * x3 + permGrad3y[gi3] * y3 + permGrad3z[gi3] * z3);
        }
        return 32.0 * (n0 + n1 + n2 + n3);
    };
}

// ============================================================================
// 5. createNoise4D (byte-identical algorithm)
// ============================================================================
function createNoise4D(random = Math.random) {
    const perm = buildPermutationTable(random);
    const permGrad4x = new Float64Array(perm).map((v) => grad4[(v % 32) * 4]);
    const permGrad4y = new Float64Array(perm).map((v) => grad4[(v % 32) * 4 + 1]);
    const permGrad4z = new Float64Array(perm).map((v) => grad4[(v % 32) * 4 + 2]);
    const permGrad4w = new Float64Array(perm).map((v) => grad4[(v % 32) * 4 + 3]);

    return function noise4D(x, y, z, w) {
        let n0, n1, n2, n3, n4;
        const s = (x + y + z + w) * F4;
        const i = fastFloor(x + s);
        const j = fastFloor(y + s);
        const k = fastFloor(z + s);
        const l = fastFloor(w + s);
        const t = (i + j + k + l) * G4;
        const X0 = i - t, Y0 = j - t, Z0 = k - t, W0 = l - t;
        const x0 = x - X0, y0 = y - Y0, z0 = z - Z0, w0 = w - W0;

        let rankx = 0, ranky = 0, rankz = 0, rankw = 0;
        if (x0 > y0) { rankx++; } else { ranky++; }
        if (x0 > z0) { rankx++; } else { rankz++; }
        if (x0 > w0) { rankx++; } else { rankw++; }
        if (y0 > z0) { ranky++; } else { rankz++; }
        if (y0 > w0) { ranky++; } else { rankw++; }
        if (z0 > w0) { rankz++; } else { rankw++; }

        const i1 = rankx >= 3 ? 1 : 0, j1 = ranky >= 3 ? 1 : 0, k1 = rankz >= 3 ? 1 : 0, l1 = rankw >= 3 ? 1 : 0;
        const i2 = rankx >= 2 ? 1 : 0, j2 = ranky >= 2 ? 1 : 0, k2 = rankz >= 2 ? 1 : 0, l2 = rankw >= 2 ? 1 : 0;
        const i3 = rankx >= 1 ? 1 : 0, j3 = ranky >= 1 ? 1 : 0, k3 = rankz >= 1 ? 1 : 0, l3 = rankw >= 1 ? 1 : 0;

        const x1 = x0 - i1 + G4, y1 = y0 - j1 + G4, z1 = z0 - k1 + G4, w1 = w0 - l1 + G4;
        const x2 = x0 - i2 + 2.0 * G4, y2 = y0 - j2 + 2.0 * G4, z2 = z0 - k2 + 2.0 * G4, w2 = w0 - l2 + 2.0 * G4;
        const x3 = x0 - i3 + 3.0 * G4, y3 = y0 - j3 + 3.0 * G4, z3 = z0 - k3 + 3.0 * G4, w3 = w0 - l3 + 3.0 * G4;
        const x4 = x0 - 1.0 + 4.0 * G4, y4 = y0 - 1.0 + 4.0 * G4, z4 = z0 - 1.0 + 4.0 * G4, w4 = w0 - 1.0 + 4.0 * G4;
        const ii = i & 255, jj = j & 255, kk = k & 255, ll = l & 255;

        let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
        if (t0 < 0) { n0 = 0.0; }
        else {
            const gi0 = ii + perm[jj + perm[kk + perm[ll]]];
            t0 *= t0;
            n0 = t0 * t0 * (permGrad4x[gi0] * x0 + permGrad4y[gi0] * y0 + permGrad4z[gi0] * z0 + permGrad4w[gi0] * w0);
        }
        let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
        if (t1 < 0) { n1 = 0.0; }
        else {
            const gi1 = ii + i1 + perm[jj + j1 + perm[kk + k1 + perm[ll + l1]]];
            t1 *= t1;
            n1 = t1 * t1 * (permGrad4x[gi1] * x1 + permGrad4y[gi1] * y1 + permGrad4z[gi1] * z1 + permGrad4w[gi1] * w1);
        }
        let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
        if (t2 < 0) { n2 = 0.0; }
        else {
            const gi2 = ii + i2 + perm[jj + j2 + perm[kk + k2 + perm[ll + l2]]];
            t2 *= t2;
            n2 = t2 * t2 * (permGrad4x[gi2] * x2 + permGrad4y[gi2] * y2 + permGrad4z[gi2] * z2 + permGrad4w[gi2] * w2);
        }
        let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
        if (t3 < 0) { n3 = 0.0; }
        else {
            const gi3 = ii + i3 + perm[jj + j3 + perm[kk + k3 + perm[ll + l3]]];
            t3 *= t3;
            n3 = t3 * t3 * (permGrad4x[gi3] * x3 + permGrad4y[gi3] * y3 + permGrad4z[gi3] * z3 + permGrad4w[gi3] * w3);
        }
        let t4 = 0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
        if (t4 < 0) { n4 = 0.0; }
        else {
            const gi4 = ii + 1 + perm[jj + 1 + perm[kk + 1 + perm[ll + 1]]];
            t4 *= t4;
            n4 = t4 * t4 * (permGrad4x[gi4] * x4 + permGrad4y[gi4] * y4 + permGrad4z[gi4] * z4 + permGrad4w[gi4] * w4);
        }
        return 27.0 * (n0 + n1 + n2 + n3 + n4);
    };
}

// ============================================================================
// 6. POOL — reusable seeded noise instances (zero-GC, leak-free)
// ============================================================================
const _handleByFn = new WeakMap();

function makeNoiseHandle(kind, seed) {
    const rng = mulberry32((seed >>> 0) || 1);
    const fn = kind === 2 ? createNoise2D(rng) : kind === 3 ? createNoise3D(rng) : createNoise4D(rng);
    const handle = { kind, seed, fn, inUse: false, pool: null };
    _handleByFn.set(fn, handle);
    return handle;
}

function createNoisePool(kind, capacity = POOL_PREALLOC, seed) {
    let counter = 0;
    const pool = createPool(
        () => {
            const s = seed !== undefined ? (seed + counter++) : ((Math.random() * 0xffffffff) >>> 0);
            const h = makeNoiseHandle(kind, s);
            h.pool = pool;
            return h;
        },
        capacity,
        (h) => { h.inUse = false; }
    );
    return pool;
}

const _pools = { 2: null, 3: null, 4: null };
function pool2D() { if (!_pools[2]) { _pools[2] = createNoisePool(2, 8); } return _pools[2]; }
function pool3D() { if (!_pools[3]) { _pools[3] = createNoisePool(3, 16); } return _pools[3]; }
function pool4D() { if (!_pools[4]) { _pools[4] = createNoisePool(4, 8); } return _pools[4]; }

function acquireNoise2D(seed) {
    if (seed !== undefined) { return makeNoiseHandle(2, seed).fn; }
    const h = pool2D().acquire(); h.inUse = true; return h.fn;
}
function acquireNoise3D(seed) {
    if (seed !== undefined) { return makeNoiseHandle(3, seed).fn; }
    const h = pool3D().acquire(); h.inUse = true; return h.fn;
}
function acquireNoise4D(seed) {
    if (seed !== undefined) { return makeNoiseHandle(4, seed).fn; }
    const h = pool4D().acquire(); h.inUse = true; return h.fn;
}
/** Return a pooled noise function (no-op for explicitly seeded instances). */
function releaseNoise(fn) {
    const h = _handleByFn.get(fn);
    if (!h) { return false; }
    h.inUse = false;
    if (h.pool) { h.pool.release(h); return true; }
    return false;
}

// ============================================================================
// 7. SOA FILLS — synchronous tight loops (1M+ points, zero allocation)
// ============================================================================
function soaFillNoise2D(outF32, positions, noiseFn, scale = 1) {
    const n = positions.count, px = positions.x, py = positions.y;
    for (let i = 0; i < n; i++) { outF32[i] = noiseFn(px[i] * scale, py[i] * scale); }
    return outF32;
}

function soaFillNoise3D(outF32, positions, noiseFn, scale = 1) {
    const n = positions.count, px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < n; i++) { outF32[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale); }
    return outF32;
}

function soaFillNoise4D(outF32, positions, noiseFn, scale = 1, time = 0) {
    const n = positions.count, px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < n; i++) { outF32[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale, time); }
    return outF32;
}

// --- Fractional Brownian Motion (multi-octave, normalized to ~[-1,1]) -------
function soaFillFBM2D(outF32, positions, noiseFn, scale = 1, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    const n = positions.count, px = positions.x, py = positions.y;
    let norm = 0, a = 1;
    for (let o = 0; o < octaves; o++) { norm += a; a *= gain; }
    const invNorm = norm > 0 ? 1 / norm : 1;
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * noiseFn(x * freq, y * freq);
            freq *= lacunarity; amp *= gain;
        }
        outF32[i] = sum * invNorm;
    }
    return outF32;
}

function soaFillFBM3D(outF32, positions, noiseFn, scale = 1, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    const n = positions.count, px = positions.x, py = positions.y, pz = positions.z;
    let norm = 0, a = 1;
    for (let o = 0; o < octaves; o++) { norm += a; a *= gain; }
    const invNorm = norm > 0 ? 1 / norm : 1;
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * noiseFn(x * freq, y * freq, z * freq);
            freq *= lacunarity; amp *= gain;
        }
        outF32[i] = sum * invNorm;
    }
    return outF32;
}

function soaFillFBM4D(outF32, positions, noiseFn, scale = 1, time = 0, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    const n = positions.count, px = positions.x, py = positions.y, pz = positions.z;
    let norm = 0, a = 1;
    for (let o = 0; o < octaves; o++) { norm += a; a *= gain; }
    const invNorm = norm > 0 ? 1 / norm : 1;
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * noiseFn(x * freq, y * freq, z * freq, time * freq);
            freq *= lacunarity; amp *= gain;
        }
        outF32[i] = sum * invNorm;
    }
    return outF32;
}

// --- Turbulence (billowy clouds) — sum of |noise| * amp, in [0,1] -----------
function soaFillTurbulence3D(outF32, positions, noiseFn, scale = 1, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    const n = positions.count, px = positions.x, py = positions.y, pz = positions.z;
    let norm = 0, a = 1;
    for (let o = 0; o < octaves; o++) { norm += a; a *= gain; }
    const invNorm = norm > 0 ? 1 / norm : 1;
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * Math.abs(noiseFn(x * freq, y * freq, z * freq));
            freq *= lacunarity; amp *= gain;
        }
        outF32[i] = sum * invNorm;
    }
    return outF32;
}

// --- Ridged (mountain ridges) — sum of (1-|noise|)^2 * amp, in [0,1] --------
function soaFillRidged3D(outF32, positions, noiseFn, scale = 1, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    const n = positions.count, px = positions.x, py = positions.y, pz = positions.z;
    let norm = 0, a = 1;
    for (let o = 0; o < octaves; o++) { norm += a; a *= gain; }
    const invNorm = norm > 0 ? 1 / norm : 1;
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            const v = 1 - Math.abs(noiseFn(x * freq, y * freq, z * freq));
            sum += amp * v * v;
            freq *= lacunarity; amp *= gain;
        }
        outF32[i] = sum * invNorm;
    }
    return outF32;
}

// --- Domain warping (natural, flowing look) ---------------------------------
const WARP_OFFSET = 31.416;

function soaFillWarped3D(outF32, positions, noiseFn, scale = 1, warpStrength = 0.5, octaves = 4) {
    const n = positions.count, px = positions.x, py = positions.y, pz = positions.z;
    let norm = 0, a = 1;
    for (let o = 0; o < octaves; o++) { norm += a; a *= 0.5; }
    const invNorm = norm > 0 ? 1 / norm : 1;
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        const wx = noiseFn(x * 0.5 + WARP_OFFSET, y * 0.5, z * 0.5);
        const wy = noiseFn(x * 0.5, y * 0.5 + WARP_OFFSET * 1.5, z * 0.5);
        const wz = noiseFn(x * 0.5, y * 0.5, z * 0.5 + WARP_OFFSET * 2.5);
        const sx = x + wx * warpStrength;
        const sy = y + wy * warpStrength;
        const sz = z + wz * warpStrength;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * noiseFn(sx * freq, sy * freq, sz * freq);
            freq *= 2.0; amp *= 0.5;
        }
        outF32[i] = sum * invNorm;
    }
    return outF32;
}

// --- Curl noise (divergence-free flow field) --------------------------------
const CURL_OFF_Y = 31.416;
const CURL_OFF_Z = 47.123;

function soaFillCurl3D(outVec3, positions, noiseFn, scale = 1, epsilon = 0.001) {
    const n = positions.count;
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const inv2e = 1 / (2 * epsilon);
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        const dVy_dz = (noiseFn(x + CURL_OFF_Y, y, z + epsilon) - noiseFn(x + CURL_OFF_Y, y, z - epsilon)) * inv2e;
        const dVz_dy = (noiseFn(x, y + epsilon + CURL_OFF_Z, z) - noiseFn(x, y - epsilon + CURL_OFF_Z, z)) * inv2e;
        const dVz_dx = (noiseFn(x + epsilon, y + CURL_OFF_Z, z) - noiseFn(x - epsilon, y + CURL_OFF_Z, z)) * inv2e;
        const dVx_dz = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
        const dVx_dy = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
        const dVy_dx = (noiseFn(x + epsilon + CURL_OFF_Y, y, z) - noiseFn(x - epsilon + CURL_OFF_Y, y, z)) * inv2e;
        ox[i] = dVz_dy - dVy_dz;
        oy[i] = dVx_dz - dVz_dx;
        oz[i] = dVy_dx - dVx_dy;
    }
    return outVec3;
}

// --- Gradient (finite difference) — the surface-normal primitive ------------
function soaFillGradient3D(outVec3, positions, noiseFn, scale = 1, epsilon = 0.001) {
    const n = positions.count;
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const inv2e = 1 / (2 * epsilon);
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        ox[i] = (noiseFn(x + epsilon, y, z) - noiseFn(x - epsilon, y, z)) * inv2e;
        oy[i] = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
        oz[i] = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
    }
    return outVec3;
}

// ============================================================================
// 8. VECTOR FIELDS — displacement + curl advection for 1M+ particles / meshes
// ============================================================================
const VEC_OFF_A = 100.0;
const VEC_OFF_B = 200.0;

/** Per-instance 3D displacement vector sampled from three offset noise lobes. */
function soaFillVec3Noise3D(outVec3, positions, noiseFn, scale = 1, amplitude = 1) {
    const n = positions.count;
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        ox[i] = noiseFn(x, y, z) * amplitude;
        oy[i] = noiseFn(x + VEC_OFF_A, y + VEC_OFF_A, z + VEC_OFF_A) * amplitude;
        oz[i] = noiseFn(x + VEC_OFF_B, y + VEC_OFF_B, z + VEC_OFF_B) * amplitude;
    }
    return outVec3;
}

/** out = base + vectorNoise(base * scale + timeDrift) * amplitude. */
function soaDisplacePositions3D(out, base, noiseFn, scale = 1, amplitude = 1, timeDrift = 0) {
    const n = base.count;
    const bx = base.x, by = base.y, bz = base.z;
    const ox = out.x, oy = out.y, oz = out.z;
    for (let i = 0; i < n; i++) {
        const wx = bx[i], wy = by[i], wz = bz[i];
        const x = wx * scale + timeDrift, y = wy * scale, z = wz * scale;
        ox[i] = wx + noiseFn(x, y, z) * amplitude;
        oy[i] = wy + noiseFn(x + VEC_OFF_A, y + VEC_OFF_A, z + VEC_OFF_A) * amplitude;
        oz[i] = wz + noiseFn(x + VEC_OFF_B, y + VEC_OFF_B, z + VEC_OFF_B) * amplitude;
    }
    return out;
}

/**
 * Integrate a divergence-free curl-noise flow for 1M+ particles.
 * velocities[i] = curl(positions[i]) * strength ; positions += velocities * dt.
 * In-place safe (positions may alias the velocity source positions).
 */
function soaAdvectCurl3D(positions, velocities, noiseFn, scale = 1, dt = 0.016, strength = 1, epsilon = 0.001) {
    const n = positions.count;
    const px = positions.x, py = positions.y, pz = positions.z;
    const vx = velocities.x, vy = velocities.y, vz = velocities.z;
    const inv2e = 1 / (2 * epsilon);
    for (let i = 0; i < n; i++) {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        const dVy_dz = (noiseFn(x + CURL_OFF_Y, y, z + epsilon) - noiseFn(x + CURL_OFF_Y, y, z - epsilon)) * inv2e;
        const dVz_dy = (noiseFn(x, y + epsilon + CURL_OFF_Z, z) - noiseFn(x, y - epsilon + CURL_OFF_Z, z)) * inv2e;
        const dVz_dx = (noiseFn(x + epsilon, y + CURL_OFF_Z, z) - noiseFn(x - epsilon, y + CURL_OFF_Z, z)) * inv2e;
        const dVx_dz = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
        const dVx_dy = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
        const dVy_dx = (noiseFn(x + epsilon + CURL_OFF_Y, y, z) - noiseFn(x - epsilon + CURL_OFF_Y, y, z)) * inv2e;
        const cx = (dVz_dy - dVy_dz) * strength;
        const cy = (dVx_dz - dVz_dx) * strength;
        const cz = (dVy_dx - dVx_dy) * strength;
        vx[i] = cx; vy[i] = cy; vz[i] = cz;
        px[i] += cx * dt; py[i] += cy * dt; pz[i] += cz * dt;
    }
    return positions;
}

// ============================================================================
// 9. CHUNKED ASYNC — every fill yields to the UI thread (mobile-safe at 1M+)
// ============================================================================
async function _chunkedFill(out, count, perElem, chunkSize = CHUNK_SIZE, yieldEvery = CHUNK_YIELD_EVERY) {
    let c = 0;
    for (let start = 0; start < count; start += chunkSize) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) { perElem(i); }
        if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
    }
    return out;
}

function soaFillNoise2DChunked(out, positions, noiseFn, scale = 1, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y;
    return _chunkedFill(out, positions.count, (i) => {
        out[i] = noiseFn(px[i] * scale, py[i] * scale);
    }, chunkSize, yieldEvery);
}

function soaFillNoise3DChunked(out, positions, noiseFn, scale = 1, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    return _chunkedFill(out, positions.count, (i) => {
        out[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale);
    }, chunkSize, yieldEvery);
}

function soaFillNoise4DChunked(out, positions, noiseFn, scale = 1, time = 0, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    return _chunkedFill(out, positions.count, (i) => {
        out[i] = noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale, time);
    }, chunkSize, yieldEvery);
}

function _fbmNorm(octaves, gain) {
    let norm = 0, a = 1;
    for (let o = 0; o < octaves; o++) { norm += a; a *= gain; }
    return norm > 0 ? 1 / norm : 1;
}

function soaFillFBM2DChunked(out, positions, noiseFn, scale = 1, octaves = 4, lacunarity = 2.0, gain = 0.5, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y;
    const invNorm = _fbmNorm(octaves, gain);
    return _chunkedFill(out, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * noiseFn(x * freq, y * freq);
            freq *= lacunarity; amp *= gain;
        }
        out[i] = sum * invNorm;
    }, chunkSize, yieldEvery);
}

function soaFillFBM3DChunked(out, positions, noiseFn, scale = 1, octaves = 4, lacunarity = 2.0, gain = 0.5, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    const invNorm = _fbmNorm(octaves, gain);
    return _chunkedFill(out, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * noiseFn(x * freq, y * freq, z * freq);
            freq *= lacunarity; amp *= gain;
        }
        out[i] = sum * invNorm;
    }, chunkSize, yieldEvery);
}

function soaFillFBM4DChunked(out, positions, noiseFn, scale = 1, time = 0, octaves = 4, lacunarity = 2.0, gain = 0.5, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    const invNorm = _fbmNorm(octaves, gain);
    return _chunkedFill(out, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * noiseFn(x * freq, y * freq, z * freq, time * freq);
            freq *= lacunarity; amp *= gain;
        }
        out[i] = sum * invNorm;
    }, chunkSize, yieldEvery);
}

function soaFillTurbulence3DChunked(out, positions, noiseFn, scale = 1, octaves = 4, lacunarity = 2.0, gain = 0.5, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    const invNorm = _fbmNorm(octaves, gain);
    return _chunkedFill(out, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * Math.abs(noiseFn(x * freq, y * freq, z * freq));
            freq *= lacunarity; amp *= gain;
        }
        out[i] = sum * invNorm;
    }, chunkSize, yieldEvery);
}

function soaFillRidged3DChunked(out, positions, noiseFn, scale = 1, octaves = 4, lacunarity = 2.0, gain = 0.5, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    const invNorm = _fbmNorm(octaves, gain);
    return _chunkedFill(out, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            const v = 1 - Math.abs(noiseFn(x * freq, y * freq, z * freq));
            sum += amp * v * v;
            freq *= lacunarity; amp *= gain;
        }
        out[i] = sum * invNorm;
    }, chunkSize, yieldEvery);
}

function soaFillWarped3DChunked(out, positions, noiseFn, scale = 1, warpStrength = 0.5, octaves = 4, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    const invNorm = _fbmNorm(octaves, 0.5);
    return _chunkedFill(out, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        const wx = noiseFn(x * 0.5 + WARP_OFFSET, y * 0.5, z * 0.5);
        const wy = noiseFn(x * 0.5, y * 0.5 + WARP_OFFSET * 1.5, z * 0.5);
        const wz = noiseFn(x * 0.5, y * 0.5, z * 0.5 + WARP_OFFSET * 2.5);
        const sx = x + wx * warpStrength, sy = y + wy * warpStrength, sz = z + wz * warpStrength;
        let sum = 0, amp = 1, freq = 1;
        for (let o = 0; o < octaves; o++) {
            sum += amp * noiseFn(sx * freq, sy * freq, sz * freq);
            freq *= 2.0; amp *= 0.5;
        }
        out[i] = sum * invNorm;
    }, chunkSize, yieldEvery);
}

function soaFillCurl3DChunked(outVec3, positions, noiseFn, scale = 1, epsilon = 0.001, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const inv2e = 1 / (2 * epsilon);
    return _chunkedFill(outVec3, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        const dVy_dz = (noiseFn(x + CURL_OFF_Y, y, z + epsilon) - noiseFn(x + CURL_OFF_Y, y, z - epsilon)) * inv2e;
        const dVz_dy = (noiseFn(x, y + epsilon + CURL_OFF_Z, z) - noiseFn(x, y - epsilon + CURL_OFF_Z, z)) * inv2e;
        const dVz_dx = (noiseFn(x + epsilon, y + CURL_OFF_Z, z) - noiseFn(x - epsilon, y + CURL_OFF_Z, z)) * inv2e;
        const dVx_dz = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
        const dVx_dy = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
        const dVy_dx = (noiseFn(x + epsilon + CURL_OFF_Y, y, z) - noiseFn(x - epsilon + CURL_OFF_Y, y, z)) * inv2e;
        ox[i] = dVz_dy - dVy_dz;
        oy[i] = dVx_dz - dVz_dx;
        oz[i] = dVy_dx - dVx_dy;
    }, chunkSize, yieldEvery);
}

function soaFillGradient3DChunked(outVec3, positions, noiseFn, scale = 1, epsilon = 0.001, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    const inv2e = 1 / (2 * epsilon);
    return _chunkedFill(outVec3, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        ox[i] = (noiseFn(x + epsilon, y, z) - noiseFn(x - epsilon, y, z)) * inv2e;
        oy[i] = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
        oz[i] = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
    }, chunkSize, yieldEvery);
}

function soaFillVec3Noise3DChunked(outVec3, positions, noiseFn, scale = 1, amplitude = 1, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    const ox = outVec3.x, oy = outVec3.y, oz = outVec3.z;
    return _chunkedFill(outVec3, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        ox[i] = noiseFn(x, y, z) * amplitude;
        oy[i] = noiseFn(x + VEC_OFF_A, y + VEC_OFF_A, z + VEC_OFF_A) * amplitude;
        oz[i] = noiseFn(x + VEC_OFF_B, y + VEC_OFF_B, z + VEC_OFF_B) * amplitude;
    }, chunkSize, yieldEvery);
}

function soaDisplacePositions3DChunked(out, base, noiseFn, scale = 1, amplitude = 1, timeDrift = 0, chunkSize, yieldEvery) {
    const bx = base.x, by = base.y, bz = base.z;
    const ox = out.x, oy = out.y, oz = out.z;
    return _chunkedFill(out, base.count, (i) => {
        const wx = bx[i], wy = by[i], wz = bz[i];
        const x = wx * scale + timeDrift, y = wy * scale, z = wz * scale;
        ox[i] = wx + noiseFn(x, y, z) * amplitude;
        oy[i] = wy + noiseFn(x + VEC_OFF_A, y + VEC_OFF_A, z + VEC_OFF_A) * amplitude;
        oz[i] = wz + noiseFn(x + VEC_OFF_B, y + VEC_OFF_B, z + VEC_OFF_B) * amplitude;
    }, chunkSize, yieldEvery);
}

function soaAdvectCurl3DChunked(positions, velocities, noiseFn, scale = 1, dt = 0.016, strength = 1, epsilon = 0.001, chunkSize, yieldEvery) {
    const px = positions.x, py = positions.y, pz = positions.z;
    const vx = velocities.x, vy = velocities.y, vz = velocities.z;
    const inv2e = 1 / (2 * epsilon);
    return _chunkedFill(positions, positions.count, (i) => {
        const x = px[i] * scale, y = py[i] * scale, z = pz[i] * scale;
        const dVy_dz = (noiseFn(x + CURL_OFF_Y, y, z + epsilon) - noiseFn(x + CURL_OFF_Y, y, z - epsilon)) * inv2e;
        const dVz_dy = (noiseFn(x, y + epsilon + CURL_OFF_Z, z) - noiseFn(x, y - epsilon + CURL_OFF_Z, z)) * inv2e;
        const dVz_dx = (noiseFn(x + epsilon, y + CURL_OFF_Z, z) - noiseFn(x - epsilon, y + CURL_OFF_Z, z)) * inv2e;
        const dVx_dz = (noiseFn(x, y, z + epsilon) - noiseFn(x, y, z - epsilon)) * inv2e;
        const dVx_dy = (noiseFn(x, y + epsilon, z) - noiseFn(x, y - epsilon, z)) * inv2e;
        const dVy_dx = (noiseFn(x + epsilon + CURL_OFF_Y, y, z) - noiseFn(x - epsilon + CURL_OFF_Y, y, z)) * inv2e;
        const cx = (dVz_dy - dVy_dz) * strength;
        const cy = (dVx_dz - dVz_dx) * strength;
        const cz = (dVy_dx - dVx_dy) * strength;
        vx[i] = cx; vy[i] = cy; vz[i] = cz;
        px[i] += cx * dt; py[i] += cy * dt; pz[i] += cz * dt;
    }, chunkSize, yieldEvery);
}

// ============================================================================
// 10. bitECS INTEGRATION — procedural world generation
// ============================================================================
/**
 * Noise-field system bound to a bitECS world (world is optional; the system
 * works standalone). Direct conditional branches inside the hot path keep the
 * fill allocation-free — no closure is created per element or per call mode.
 */
class NoiseFieldSystem {
    constructor(world = null, options = {}) {
        this.world = world;
        this.noiseFn = options.noiseFn || acquireNoise3D(options.seed);
        this.scale = options.scale !== undefined ? options.scale : 0.01;
        this.mode = options.mode || "fbm";
        this.octaves = options.octaves || 4;
        this.lacunarity = options.lacunarity || 2.0;
        this.gain = options.gain || 0.5;
        this.warpStrength = options.warpStrength !== undefined ? options.warpStrength : 0.5;
        this.epsilon = options.epsilon || 0.001;
        this.threshold = options.threshold !== undefined ? options.threshold : -Infinity;
        this.eidsQuery = options.query || null;
    }

    setMode(mode) { this.mode = mode; return this; }
    setScale(scale) { this.scale = scale; return this; }
    setSeed(seed) {
        releaseNoise(this.noiseFn);
        this.noiseFn = acquireNoise3D(seed);
        return this;
    }

    /** Synchronous fill (fast; blocks for 1M+ — prefer fillChunked at runtime). */
    fillSync(outF32, positions) {
        const fn = this.noiseFn, s = this.scale, o = this.octaves, l = this.lacunarity, g = this.gain;
        if (this.mode === "fbm") { return soaFillFBM3D(outF32, positions, fn, s, o, l, g); }
        if (this.mode === "turbulence") { return soaFillTurbulence3D(outF32, positions, fn, s, o, l, g); }
        if (this.mode === "ridged") { return soaFillRidged3D(outF32, positions, fn, s, o, l, g); }
        if (this.mode === "warped") { return soaFillWarped3D(outF32, positions, fn, s, this.warpStrength, o); }
        return soaFillNoise3D(outF32, positions, fn, s);
    }

    /** Chunked async fill — mobile-safe for 1M+ entities. */
    fillChunked(outF32, positions, chunkSize, yieldEvery) {
        const fn = this.noiseFn, s = this.scale, o = this.octaves, l = this.lacunarity, g = this.gain;
        if (this.mode === "fbm") { return soaFillFBM3DChunked(outF32, positions, fn, s, o, l, g, chunkSize, yieldEvery); }
        if (this.mode === "turbulence") { return soaFillTurbulence3DChunked(outF32, positions, fn, s, o, l, g, chunkSize, yieldEvery); }
        if (this.mode === "ridged") { return soaFillRidged3DChunked(outF32, positions, fn, s, o, l, g, chunkSize, yieldEvery); }
        if (this.mode === "warped") { return soaFillWarped3DChunked(outF32, positions, fn, s, this.warpStrength, o, chunkSize, yieldEvery); }
        return soaFillNoise3DChunked(outF32, positions, fn, s, chunkSize, yieldEvery);
    }

    /** Write the field into a position channel (".y" by default). */
    applyToPositions(positions, channel = "y") {
        return this.fillSync(positions[channel], positions);
    }

    applyToPositionsChunked(positions, channel = "y", chunkSize, yieldEvery) {
        return this.fillChunked(positions[channel], positions, chunkSize, yieldEvery);
    }

    /** Divergence-free flow field for dust / wind / water. */
    curlSync(outVec3, positions) {
        return soaFillCurl3D(outVec3, positions, this.noiseFn, this.scale, this.epsilon);
    }
    curlChunked(outVec3, positions, chunkSize, yieldEvery) {
        return soaFillCurl3DChunked(outVec3, positions, this.noiseFn, this.scale, this.epsilon, chunkSize, yieldEvery);
    }

    /** Advect 1M+ particles along the curl field without freezing the UI. */
    advectChunked(positions, velocities, dt, strength = 1, chunkSize, yieldEvery) {
        return soaAdvectCurl3DChunked(positions, velocities, this.noiseFn, this.scale, dt, strength, this.epsilon, chunkSize, yieldEvery);
    }

    /** Count of samples above threshold (density / spawn gating). */
    countAbove(values, count) {
        const n = count !== undefined ? count : values.length;
        const t = this.threshold;
        let c = 0;
        for (let i = 0; i < n; i++) { if (values[i] > t) { c++; } }
        return c;
    }

    dispose() { releaseNoise(this.noiseFn); this.noiseFn = null; }
}

function createNoiseFieldSystem(world, options) {
    return new NoiseFieldSystem(world, options);
}

// ============================================================================
// 11. THREE.JS r185 INTEROP (duck-typed — no three import, no CDN, no build)
// ============================================================================
/**
 * Write scalar noise into any three.js r185 BufferAttribute (itemSize 1),
 * e.g. a custom "aNoise" attribute consumed by a ShaderMaterial.
 * `positions` may be a vec3 SOA or a three.js position BufferAttribute.
 */
function applyNoiseToAttribute(attribute, noiseFn, options = {}) {
    const scale = options.scale !== undefined ? options.scale : 1;
    const amplitude = options.amplitude !== undefined ? options.amplitude : 1;
    const offset = options.offset || 0;
    const src = options.positions;
    const count = attribute.count;

    if (src && src.x && src.y && src.z) {
        const px = src.x, py = src.y, pz = src.z;
        for (let i = 0; i < count; i++) {
            attribute.setX(i, noiseFn(px[i] * scale, py[i] * scale, pz[i] * scale) * amplitude + offset);
        }
    } else if (src && typeof src.getX === "function") {
        for (let i = 0; i < count; i++) {
            attribute.setX(i, noiseFn(src.getX(i) * scale, src.getY(i) * scale, src.getZ(i) * scale) * amplitude + offset);
        }
    } else {
        for (let i = 0; i < count; i++) { attribute.setX(i, noiseFn(i * scale, 0, 0) * amplitude + offset); }
    }
    attribute.needsUpdate = true;
    return attribute;
}

/**
 * Displace a three.js r185 BufferGeometry along its normals by simplex noise.
 * Works on 1M-vertex meshes; use the chunked variant to avoid a UI stall.
 */
function displaceBufferGeometry(geometry, noiseFn, options = {}) {
    const pos = geometry.attributes.position;
    const nrm = geometry.attributes.normal;
    const scale = options.scale !== undefined ? options.scale : 0.1;
    const amplitude = options.amplitude !== undefined ? options.amplitude : 1;
    const drift = options.timeDrift || 0;
    const count = pos.count;

    for (let i = 0; i < count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const d = noiseFn(x * scale + drift, y * scale, z * scale) * amplitude;
        if (nrm) {
            pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d);
        } else {
            pos.setXYZ(i, x, y + d, z);
        }
    }
    pos.needsUpdate = true;
    if (options.recomputeNormals !== false && typeof geometry.computeVertexNormals === "function") {
        geometry.computeVertexNormals();
    }
    if (typeof geometry.computeBoundingSphere === "function") { geometry.computeBoundingSphere(); }
    return geometry;
}

async function displaceBufferGeometryChunked(geometry, noiseFn, options = {}) {
    const pos = geometry.attributes.position;
    const nrm = geometry.attributes.normal;
    const scale = options.scale !== undefined ? options.scale : 0.1;
    const amplitude = options.amplitude !== undefined ? options.amplitude : 1;
    const drift = options.timeDrift || 0;
    const chunkSize = options.chunkSize || CHUNK_SIZE;
    const yieldEvery = options.yieldEvery || CHUNK_YIELD_EVERY;
    const count = pos.count;
    let c = 0;

    for (let start = 0; start < count; start += chunkSize) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            const d = noiseFn(x * scale + drift, y * scale, z * scale) * amplitude;
            if (nrm) {
                pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d);
            } else {
                pos.setXYZ(i, x, y + d, z);
            }
        }
        if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
    }
    pos.needsUpdate = true;
    if (options.recomputeNormals !== false && typeof geometry.computeVertexNormals === "function") {
        geometry.computeVertexNormals();
    }
    if (typeof geometry.computeBoundingSphere === "function") { geometry.computeBoundingSphere(); }
    return geometry;
}

// ============================================================================
// 12. WORKER POOL — true multi-core noise (Blob URL, no server, no CDN)
// ============================================================================
const _noiseWorkerSource = "(" + function () {
    const F3 = 1 / 3, G3 = 1 / 6;
    const CY = 31.416, CZ = 47.123;
    const g3 = new Float64Array([
        1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
        1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
        0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
    ]);

    function rng(seed) {
        let a = seed | 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function makeNoise3(seed) {
        const random = rng(seed);
        const p = new Uint8Array(512);
        for (let i = 0; i < 256; i++) { p[i] = i; }
        for (let i = 0; i < 255; i++) {
            const r = i + ~~(random() * (256 - i));
            const a = p[i]; p[i] = p[r]; p[r] = a;
        }
        for (let i = 256; i < 512; i++) { p[i] = p[i - 256]; }
        const gx = new Float64Array(p).map((v) => g3[(v % 12) * 3]);
        const gy = new Float64Array(p).map((v) => g3[(v % 12) * 3 + 1]);
        const gz = new Float64Array(p).map((v) => g3[(v % 12) * 3 + 2]);

        return function (x, y, z) {
            let n0, n1, n2, n3;
            const s = (x + y + z) * F3;
            const i = Math.floor(x + s) | 0, j = Math.floor(y + s) | 0, k = Math.floor(z + s) | 0;
            const t = (i + j + k) * G3;
            const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
            let i1, j1, k1, i2, j2, k2;
            if (x0 >= y0) {
                if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
                else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
                else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
            } else {
                if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
                else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
                else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
            }
            const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
            const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
            const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
            const ii = i & 255, jj = j & 255, kk = k & 255;
            let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
            if (t0 < 0) { n0 = 0; } else {
                const gi = ii + p[jj + p[kk]]; t0 *= t0;
                n0 = t0 * t0 * (gx[gi] * x0 + gy[gi] * y0 + gz[gi] * z0);
            }
            let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
            if (t1 < 0) { n1 = 0; } else {
                const gi = ii + i1 + p[jj + j1 + p[kk + k1]]; t1 *= t1;
                n1 = t1 * t1 * (gx[gi] * x1 + gy[gi] * y1 + gz[gi] * z1);
            }
            let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
            if (t2 < 0) { n2 = 0; } else {
                const gi = ii + i2 + p[jj + j2 + p[kk + k2]]; t2 *= t2;
                n2 = t2 * t2 * (gx[gi] * x2 + gy[gi] * y2 + gz[gi] * z2);
            }
            let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
            if (t3 < 0) { n3 = 0; } else {
                const gi = ii + 1 + p[jj + 1 + p[kk + 1]]; t3 *= t3;
                n3 = t3 * t3 * (gx[gi] * x3 + gy[gi] * y3 + gz[gi] * z3);
            }
            return 32 * (n0 + n1 + n2 + n3);
        };
    }

    let cachedSeed = null, noise = null;

    self.onmessage = function (e) {
        const d = e.data;
        if (cachedSeed !== d.seed) { cachedSeed = d.seed; noise = makeNoise3(d.seed); }
        const pos = d.pos, n = d.n, scale = d.scale, op = d.op;
        const oct = d.octaves, lac = d.lacunarity, gain = d.gain, eps = d.epsilon;
        const vector = (op === "curl3d");
        const out = new Float32Array(vector ? n * 3 : n);
        let norm = 0, a = 1;
        for (let o = 0; o < oct; o++) { norm += a; a *= gain; }
        const invNorm = norm > 0 ? 1 / norm : 1;
        const inv2e = 1 / (2 * eps);

        for (let i = 0; i < n; i++) {
            const x = pos[i * 3] * scale, y = pos[i * 3 + 1] * scale, z = pos[i * 3 + 2] * scale;
            if (op === "noise3d") {
                out[i] = noise(x, y, z);
            } else if (op === "curl3d") {
                const dVy_dz = (noise(x + CY, y, z + eps) - noise(x + CY, y, z - eps)) * inv2e;
                const dVz_dy = (noise(x, y + eps + CZ, z) - noise(x, y - eps + CZ, z)) * inv2e;
                const dVz_dx = (noise(x + eps, y + CZ, z) - noise(x - eps, y + CZ, z)) * inv2e;
                const dVx_dz = (noise(x, y, z + eps) - noise(x, y, z - eps)) * inv2e;
                const dVx_dy = (noise(x, y + eps, z) - noise(x, y - eps, z)) * inv2e;
                const dVy_dx = (noise(x + eps + CY, y, z) - noise(x - eps + CY, y, z)) * inv2e;
                out[i * 3] = dVz_dy - dVy_dz;
                out[i * 3 + 1] = dVx_dz - dVz_dx;
                out[i * 3 + 2] = dVy_dx - dVx_dy;
            } else {
                let sum = 0, amp = 1, freq = 1;
                for (let o = 0; o < oct; o++) {
                    const v = noise(x * freq, y * freq, z * freq);
                    if (op === "turbulence3d") { sum += amp * Math.abs(v); }
                    else if (op === "ridged3d") { const r = 1 - Math.abs(v); sum += amp * r * r; }
                    else { sum += amp * v; }
                    freq *= lac; amp *= gain;
                }
                out[i] = sum * invNorm;
            }
        }
        self.postMessage({ id: d.id, out: out }, [out.buffer]);
    };
}.toString() + ")();";

/**
 * Optional multi-core noise executor. When Workers / Blob URLs are unavailable
 * the pool transparently falls back to the chunked main-thread path, so a call
 * never blocks the UI and never throws.
 * op: "noise3d" | "fbm3d" | "turbulence3d" | "ridged3d" | "curl3d".
 */
class NoiseWorkerPool {
    constructor(size) {
        this._workers = [];
        this._idle = [];
        this._queue = [];
        this._pending = new Map();
        this._nextId = 1;
        this._url = null;
        this._disposed = false;

        const want = size || Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2);
        try {
            if (typeof Worker === "undefined" || typeof Blob === "undefined" ||
                typeof URL === "undefined" || !URL.createObjectURL) {
                throw new Error("workers unavailable");
            }
            this._url = URL.createObjectURL(new Blob([_noiseWorkerSource], { type: "text/javascript" }));
            for (let i = 0; i < want; i++) {
                const w = new Worker(this._url);
                w.onmessage = (e) => {
                    const job = this._pending.get(e.data.id);
                    if (job) { this._pending.delete(e.data.id); job.resolve(e.data.out); }
                    this._idle.push(w);
                    this._dispatch();
                };
                w.onerror = () => { this._idle.push(w); this._dispatch(); };
                this._workers.push(w);
                this._idle.push(w);
            }
        } catch (e) {
            this._workers.length = 0;
            this._idle.length = 0;
            if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
        }
    }

    get size() { return this._workers.length; }

    _dispatch() {
        while (this._queue.length > 0 && this._idle.length > 0) {
            const task = this._queue.shift();
            const w = this._idle.pop();
            this._pending.set(task.msg.id, task);
            w.postMessage(task.msg, [task.msg.pos.buffer]);
        }
    }

    _runChunk(msg) {
        return new Promise((resolve, reject) => {
            this._queue.push({ msg, resolve, reject });
            this._dispatch();
        });
    }

    /**
     * Fill noise over a vec3 SOA. Resolves to a Float32Array (scalar ops) or a
     * vec3 SOA (curl3d). `out` may be supplied to avoid allocation.
     */
    async fill(op, positions, options = {}) {
        if (this._disposed) { throw new Error("NoiseWorkerPool disposed"); }
        const n = positions.count;
        const seed = options.seed !== undefined ? options.seed : 1;
        const scale = options.scale !== undefined ? options.scale : 1;
        const octaves = options.octaves || 4;
        const lacunarity = options.lacunarity || 2.0;
        const gain = options.gain || 0.5;
        const epsilon = options.epsilon || 0.001;
        const vector = (op === "curl3d");

        if (this._workers.length === 0) {
            const fn = acquireNoise3D(seed);
            try {
                if (vector) {
                    const outV = options.out || vec3.createVec3SOA(n);
                    await soaFillCurl3DChunked(outV, positions, fn, scale, epsilon, options.chunkSize, options.yieldEvery);
                    return outV;
                }
                const outS = options.out || new Float32Array(n);
                if (op === "noise3d") { await soaFillNoise3DChunked(outS, positions, fn, scale, options.chunkSize, options.yieldEvery); }
                else if (op === "turbulence3d") { await soaFillTurbulence3DChunked(outS, positions, fn, scale, octaves, lacunarity, gain, options.chunkSize, options.yieldEvery); }
                else if (op === "ridged3d") { await soaFillRidged3DChunked(outS, positions, fn, scale, octaves, lacunarity, gain, options.chunkSize, options.yieldEvery); }
                else { await soaFillFBM3DChunked(outS, positions, fn, scale, octaves, lacunarity, gain, options.chunkSize, options.yieldEvery); }
                return outS;
            } finally { releaseNoise(fn); }
        }

        const W = this._workers.length;
        const per = Math.ceil(n / W);
        const jobs = [];
        const px = positions.x, py = positions.y, pz = positions.z;

        for (let k = 0; k < W; k++) {
            const s = k * per, e = Math.min(s + per, n);
            if (s >= e) { break; }
            const len = e - s;
            const buf = new Float32Array(len * 3);
            for (let i = 0; i < len; i++) {
                buf[i * 3] = px[s + i];
                buf[i * 3 + 1] = py[s + i];
                buf[i * 3 + 2] = pz[s + i];
            }
            jobs.push({
                s, e,
                p: this._runChunk({
                    id: this._nextId++, op, n: len, pos: buf, seed, scale,
                    octaves, lacunarity, gain, epsilon
                })
            });
        }

        const outS = vector ? null : (options.out || new Float32Array(n));
        const outV = vector ? (options.out || vec3.createVec3SOA(n)) : null;
        for (let j = 0; j < jobs.length; j++) {
            const res = await jobs[j].p;
            const s = jobs[j].s, len = jobs[j].e - s;
            if (vector) {
                for (let i = 0; i < len; i++) {
                    outV.x[s + i] = res[i * 3];
                    outV.y[s + i] = res[i * 3 + 1];
                    outV.z[s + i] = res[i * 3 + 2];
                }
            } else {
                outS.set(res, s);
            }
        }
        return vector ? outV : outS;
    }

    dispose() {
        this._disposed = true;
        for (let i = 0; i < this._workers.length; i++) { this._workers[i].terminate(); }
        this._workers.length = 0;
        this._idle.length = 0;
        this._queue.length = 0;
        this._pending.clear();
        if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
    }
}

function createNoiseWorkerPool(size) { return new NoiseWorkerPool(size); }

// ============================================================================
// 13. MATH NAMESPACE — the provided SOA stack stays the default maths
// ============================================================================
const math = {
    common, vec2, vec3, vec4, mat2,
    mat3: null, mat4, quat, quat2, bitecs: null
};

/** Optional modules load dynamically; a failure never breaks this module. */
const mathReady = Promise.allSettled([
    import("./006_mat3.js").then((m) => { math.mat3 = m; }),
    import("./010_bitECS_core.js").then((m) => { math.bitecs = m; })
]);

// ============================================================================
// 14. EXPORTS — every original export preserved + completed parallel layer
// ============================================================================
export {
    // constants
    SQRT3, SQRT5, F2, G2, F3, G3, F4, G4, grad2, grad3, grad4, fastFloor,
    CHUNK_SIZE, CHUNK_YIELD_EVERY, WARP_OFFSET, CURL_OFF_Y, CURL_OFF_Z,
    // original core (byte-identical algorithms)
    buildPermutationTable, createNoise2D, createNoise3D, createNoise4D,
    // pools
    createNoisePool, acquireNoise2D, acquireNoise3D, acquireNoise4D, releaseNoise,
    // SOA fills (sync)
    soaFillNoise2D, soaFillNoise3D, soaFillNoise4D,
    soaFillFBM2D, soaFillFBM3D, soaFillFBM4D,
    soaFillTurbulence3D, soaFillRidged3D, soaFillWarped3D,
    soaFillCurl3D, soaFillGradient3D,
    // SOA fills (chunked async — mobile-safe)
    soaFillNoise2DChunked, soaFillNoise3DChunked, soaFillNoise4DChunked,
    soaFillFBM2DChunked, soaFillFBM3DChunked, soaFillFBM4DChunked,
    soaFillTurbulence3DChunked, soaFillRidged3DChunked, soaFillWarped3DChunked,
    soaFillCurl3DChunked, soaFillGradient3DChunked,
    // vector fields / advection
    soaFillVec3Noise3D, soaFillVec3Noise3DChunked,
    soaDisplacePositions3D, soaDisplacePositions3DChunked,
    soaAdvectCurl3D, soaAdvectCurl3DChunked,
    // bitECS integration
    NoiseFieldSystem, createNoiseFieldSystem,
    // three.js r185 interop
    applyNoiseToAttribute, displaceBufferGeometry, displaceBufferGeometryChunked,
    // parallelism
    NoiseWorkerPool, createNoiseWorkerPool,
    // namespace
    math, mathReady
};

export default {
    SQRT3, SQRT5, F2, G2, F3, G3, F4, G4, grad2, grad3, grad4, fastFloor,
    CHUNK_SIZE, CHUNK_YIELD_EVERY, WARP_OFFSET, CURL_OFF_Y, CURL_OFF_Z,
    buildPermutationTable, createNoise2D, createNoise3D, createNoise4D,
    createNoisePool, acquireNoise2D, acquireNoise3D, acquireNoise4D, releaseNoise,
    soaFillNoise2D, soaFillNoise3D, soaFillNoise4D,
    soaFillFBM2D, soaFillFBM3D, soaFillFBM4D,
    soaFillTurbulence3D, soaFillRidged3D, soaFillWarped3D,
    soaFillCurl3D, soaFillGradient3D,
    soaFillNoise2DChunked, soaFillNoise3DChunked, soaFillNoise4DChunked,
    soaFillFBM2DChunked, soaFillFBM3DChunked, soaFillFBM4DChunked,
    soaFillTurbulence3DChunked, soaFillRidged3DChunked, soaFillWarped3DChunked,
    soaFillCurl3DChunked, soaFillGradient3DChunked,
    soaFillVec3Noise3D, soaFillVec3Noise3DChunked,
    soaDisplacePositions3D, soaDisplacePositions3DChunked,
    soaAdvectCurl3D, soaAdvectCurl3DChunked,
    NoiseFieldSystem, createNoiseFieldSystem,
    applyNoiseToAttribute, displaceBufferGeometry, displaceBufferGeometryChunked,
    NoiseWorkerPool, createNoiseWorkerPool,
    math, mathReady
};

// Continue with next file: src/math/014_simplex_demo.js (1M-particle curl-noise
// galaxy showcase wiring this module into three.js r185 Points + bitECS)?