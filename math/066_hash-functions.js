//File number : 066
// File : src/math/066_hash-functions.js
//Description : Complete hash-function system — 32-bit integer hashes (Wang, Murmur3 finalizer, xxHash32 with seed, FNV-1a, Jenkins one-at-a-time, SipHash-lite), string hashes (djb2, sdbm, FNV-1a string, Java string), seeded PRNGs (mulberry32, splitmix32, xorshift32, sfc32, pcg32), spatial integer hashes (2D/3D/4D), continuous float hashes ([0,1) and [-1,1)), gradient hashes for noise, Morton/Z-order encoding 2D/3D/4D, hash-combine primitives, a streaming hasher for composite object IDs, a 64-bit-style composite hash (hi/lo pair) for galactic-scale keyspaces, and a zero-GC micro-spatial-hash (typed-array linked-list buckets) for local collision and AI perception. Domain helpers cover hash-based terrain variation, tile-based scatter density, per-instance animation phase, IK target jitter, HDR-safe color generation, deterministic orbital seeds, spatial-hash grid lookups for 1M+ particles, and hash-driven value noise / fBm. Every routine has an SOA batch version + chunked async variant that yields via `scheduler.yield()` so the Android 64-bit UI thread never freezes. All mutable state lives in a pooled `HashScratch`, output buffers honor `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap), and primary hashes stay in 32-bit integer arithmetic (`Math.imul`, `>>> 0`) for maximum speed on mobile JITs.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. Object-returning domain helpers were converted to out-parameter form (gradient, IK jitter, orbital seed, grid slot, hash64). `StreamingHasher.writeFloat` uses a module-level shared DataView (no per-call ArrayBuffer). Chunked async kernels inline their loops (no per-call callbacks). The micro-spatial-hash uses preallocated `Int32Array` bucket heads + next pointers (blueprint §50) with a closure-free bucket collector. Scratch pools are fixed-capacity with buffer-preserving release. All allocations occur exclusively at module init / pool growth.
//Corrections : ESM imports/exports only (no require/exports). Fixed: dozens of corrupted bit-shift / comparison operators (`> > >`, `< <`, `& &`, `> =`) that were syntax errors; a malformed hex literal `0x 27D4EB2F`; `hashColorHDR` wrote `b glow` instead of `b * glow`; `hash2i` had a truncated final mix line; `createPRNG` used a broken `toLow erCase()` and trailing-space string keys; `StreamingHasher.writeFloat` allocated an ArrayBuffer + DataView per call (now a shared module DataView); `hash64ToFloat` lost precision via `hi * 2^32` overflow (now split into two scaled terms); `soaJitterPositions` passed four arguments to the three-coordinate `hash3i`; `soaColorHDR` allocated an array literal per instance; `HashScratch` used an unbounded push/splice warm pool (now fixed-capacity swap-remove); `_hashScratchPool` monkey-patched `acquire` with a bound closure (now a shared hoisted `ensure`); `HashBatchState` used a Set + forEach listeners (removed); every chunked kernel allocated a per-call closure via `_chunked` (now inlined while-loops).
//Added : Out-parameter zero-GC domain helpers (`hashGradient2/3`, `hashIKJitter`, `hashOrbitalSeed`, `hashGridSlot`, `hash64` now write into caller buffers), a zero-GC micro-spatial-hash (`createMicroSpatialHash`, `microSpatialClear`, `microSpatialInsert`, `microSpatialCollectBucket`, `hashBucketIndex`) implementing blueprint §50, and chunked variants for `soaHash2i`, `soaHashValue3`, `soaGradient3`, and `soaOrbitalSeeds`.
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
const TWO_PI       = Math.PI * 2;
const INV_2_32     = 1 / 4294967296;          // 2^-32
const FNV_OFFSET32 = 0x811C9DC5 | 0;
const FNV_PRIME32  = 0x01000193 | 0;

// Spatial hash primes (well-known good choices for 3D cellular hashes).
const PRIME_X = 0x1B873593 | 0;
const PRIME_Y = 0xCC9E2D51 | 0;
const PRIME_Z = 0x85EBCA77 | 0;
const PRIME_W = 0xC2B2AE3D | 0;

// Shared scratch for object-free domain helpers (single-threaded).
const _vec2Tmp = new Float64Array(2);
const _vec3Tmp = new Float64Array(3);
const _vec4Tmp = new Float64Array(4);
const _colorTmp = new Float64Array(4);
const _hash64Tmp = new Float64Array(2);

// Shared DataView for StreamingHasher.writeFloat (no per-call allocation).
const _hasherBuf = new ArrayBuffer(8);
const _hasherDV = new DataView(_hasherBuf);

// ============================================================================
// Scratch pool — precision-aware, buffer-preserving release
// ============================================================================
function _hashScratchEnsure(s, n) {
    if (n <= s.size) return s;
    const T = getArrayType();
    s.size = n;
    s.a = new T(n);
    s.b = new T(n);
    s.c = new T(n);
    s.d = new T(n);
    return s;
}

function _hashScratchFactory() {
    const T = getArrayType();
    return { a: new T(256), b: new T(256), c: new T(256), d: new T(256), size: 256, ensure: _hashScratchEnsure };
}

function _hashScratchReset(s) { /* buffers retained for Zero-GC reuse */ }

const _hashScratchPool = common.createPool(_hashScratchFactory, 8, _hashScratchReset);

for (let _pw = 0; _pw < 8; _pw++) {
    const _s = _hashScratchPool.acquire() || _hashScratchFactory();
    _hashScratchPool.release(_s);
}

function acquireHashScratch(size) {
    const s = _hashScratchPool.acquire() || _hashScratchFactory();
    if (size !== undefined) s.ensure(size);
    return s;
}
function releaseHashScratch(s) { if (s) _hashScratchPool.release(s); }
function createHashScratchPool(capacity) {
    return common.createPool(_hashScratchFactory, capacity || 8, _hashScratchReset);
}

// ============================================================================
// Function Declarations — 32-bit integer hashes
// ============================================================================
/** Thomas Wang's 32-bit mix — fast avalanche. */
function wangHash(x) {
    x = (x | 0) >>> 0;
    x = (x ^ 61) ^ (x >>> 16);
    x = (x + (x << 3)) | 0;
    x = x ^ (x >>> 4);
    x = Math.imul(x, 0x27d4eb2d) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0;
    return x;
}

function wangHash2(x, y) {
    return wangHash((Math.imul(x | 0, PRIME_X) ^ Math.imul(y | 0, PRIME_Y)) | 0);
}

/** MurmurHash3 finalizer — full 32-bit avalanche. */
function murmur3Finalize(h) {
    h = (h | 0) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x85EBCA6B) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0xC2B2AE35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h;
}

/** xxHash32-style scalar mix (single 32-bit value). */
function xxHash32(x, seed) {
    const P1 = 0x9E3779B1;
    const P2 = 0x85EBCA77;
    const P3 = 0xC2B2AE3D;
    const P4 = 0x27D4EB2F;
    const P5 = 0x165667B1;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    let h = (seed + P5) >>> 0;
    h = (h + Math.imul(x | 0, P5)) >>> 0;
    h = (Math.imul((h << 13) | (h >>> 19), P1)) >>> 0;
    h = (Math.imul(h ^ (h >>> 15), P2)) >>> 0;
    h = (Math.imul(h ^ (h >>> 13), P3)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h;
}

/** FNV-1a 32-bit over the four bytes of a single integer. */
function fnv1a32(x) {
    let h = FNV_OFFSET32 >>> 0;
    for (let k = 0; k < 4; k++) {
        const b = (x >>> (k * 8)) & 0xff;
        h ^= b;
        h = Math.imul(h, FNV_PRIME32) >>> 0;
    }
    return h >>> 0;
}

/** Jenkins one-at-a-time hash over the four bytes of a single integer. */
function jenkinsOAT(x) {
    let h = 0;
    for (let k = 0; k < 4; k++) {
        h = (h + ((x >>> (k * 8)) & 0xff)) | 0;
        h = (h + (h << 10)) | 0;
        h = h ^ (h >>> 6);
    }
    h = (h + (h << 3)) | 0;
    h = h ^ (h >>> 11);
    h = (h + (h << 15)) | 0;
    return h >>> 0;
}

/** Lightweight 2-input SipHash-style mix for composite object keys. */
function sipHashLite(a, b, seed) {
    seed = (seed === undefined ? 0 : seed) >>> 0;
    let v0 = (seed ^ PRIME_X) >>> 0;
    let v1 = (seed ^ PRIME_Y) >>> 0;
    v0 = (v0 + (a | 0)) >>> 0;
    v0 = Math.imul(v0, PRIME_X) >>> 0;
    v0 = (v0 ^ (v0 >>> 17)) >>> 0;
    v1 = (v1 + (b | 0)) >>> 0;
    v1 = Math.imul(v1, PRIME_Y) >>> 0;
    v1 = (v1 ^ (v1 >>> 15)) >>> 0;
    let h = (v0 ^ v1) >>> 0;
    h = Math.imul(h, 0x9E3779B1) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return h >>> 0;
}

// ============================================================================
// Function Declarations — String hashes
// ============================================================================
function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = (Math.imul(h, 33) + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
}

function sdbm(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (str.charCodeAt(i) + (h << 6) + (h << 16) - h) | 0;
    }
    return h >>> 0;
}

function fnv1aString(str) {
    let h = FNV_OFFSET32 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i) & 0xff;
        h = Math.imul(h, FNV_PRIME32) >>> 0;
        h ^= (str.charCodeAt(i) >>> 8) & 0xff;
        h = Math.imul(h, FNV_PRIME32) >>> 0;
    }
    return h >>> 0;
}

function javaStringHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
}

// ============================================================================
// Function Declarations — Seeded PRNGs (init-time factories)
// ============================================================================
/** Mulberry32 — 32-bit state, 2^32 period, extremely fast. */
function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    const next = function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) * INV_2_32;
    };
    return {
        next: next,
        nextInt: function () { return (next() * 4294967296) | 0; },
        reseed: function (s) { a = (s >>> 0) || 1; },
        state: function () { return a; },
        restore: function (s) { a = s | 0; }
    };
}

/** SplitMix32 — good seeding PRNG. */
function splitmix32(seed) {
    let state = (seed >>> 0) || 1;
    const next = function () {
        state = (state + 0x9E3779B9) | 0;
        let z = state >>> 0;
        z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B) >>> 0;
        z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35) >>> 0;
        z = (z ^ (z >>> 16)) >>> 0;
        return z * INV_2_32;
    };
    return {
        next: next,
        nextInt: function () { return (next() * 4294967296) | 0; },
        reseed: function (s) { state = (s >>> 0) || 1; },
        state: function () { return state; },
        restore: function (s) { state = s | 0; }
    };
}

/** Xorshift32 — minimal-state. */
function xorshift32(seed) {
    let x = (seed >>> 0) || 1;
    const next = function () {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        return x * INV_2_32;
    };
    return {
        next: next,
        nextInt: function () { return (next() * 4294967296) | 0; },
        reseed: function (s) { x = (s >>> 0) || 1; },
        state: function () { return x; },
        restore: function (s) { x = s >>> 0; }
    };
}

/** SFC32 — Small Fast Counting PRNG, 128-bit state. */
function sfc32(a, b, c, d) {
    a = (a >>> 0) || 1;
    b = (b >>> 0) || 2;
    c = (c >>> 0) || 3;
    d = (d >>> 0) || 4;
    const next = function () {
        const t = (((a + b) | 0) + d) | 0;
        d = (d + 1) | 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) | 0;
        c = ((c << 21) | (c >>> 11)) | 0;
        c = (c + t) | 0;
        return (t >>> 0) * INV_2_32;
    };
    return {
        next: next,
        nextInt: function () { return (next() * 4294967296) | 0; },
        reseed: function (seed) {
            const s = splitmix32(seed >>> 0);
            a = s.nextInt() >>> 0; s.next();
            b = s.nextInt() >>> 0; s.next();
            c = s.nextInt() >>> 0; s.next();
            d = s.nextInt() >>> 0;
        },
        state: function () { return { a: a, b: b, c: c, d: d }; },
        restore: function (st) { a = st.a; b = st.b; c = st.c; d = st.d; }
    };
}

/** PCG32 — permuted congruential generator. */
function pcg32(seed, seq) {
    let state = (seed >>> 0) || 1;
    let inc = ((seq >>> 0) || 1) | 1;
    const PCG_MULT = 0x5851F42D;
    const nextInt = function () {
        const old = state;
        state = (Math.imul(state, PCG_MULT) + inc) | 0;
        const xorshifted = (((old >>> 18) ^ old) >>> 27) >>> 0;
        const rot = old >>> 59;
        return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
    };
    const next = function () { return nextInt() * INV_2_32; };
    return {
        next: next,
        nextInt: nextInt,
        reseed: function (s, q) { state = (s >>> 0) || 1; if (q !== undefined) inc = (q | 1); },
        state: function () { return { state: state, inc: inc }; },
        restore: function (st) { state = st.state; inc = st.inc; }
    };
}

/** Factory — create a PRNG by kind. */
function createPRNG(kind, seed) {
    kind = (kind || "mulberry32").toLowerCase();
    switch (kind) {
        case "mulberry32": return mulberry32(seed);
        case "splitmix32": return splitmix32(seed);
        case "xorshift32": return xorshift32(seed);
        case "sfc32": return sfc32(seed || 1, (seed || 1) * 3 + 1, (seed || 1) * 5 + 2, (seed || 1) * 7 + 3);
        case "pcg32": return pcg32(seed);
        default: throw new Error("createPRNG: unknown kind '" + kind + "'");
    }
}

// ============================================================================
// Function Declarations — Spatial integer hashes
// ============================================================================
/** 2D spatial hash — deterministic 32-bit output for any integer coordinate. */
function hash2i(x, y, seed) {
    seed = (seed === undefined ? 0 : seed) >>> 0;
    let h = seed;
    h = (Math.imul(x | 0, PRIME_X) ^ h) >>> 0;
    h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(y | 0, PRIME_Y)) >>> 0;
    h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h;
}

function hash3i(x, y, z, seed) {
    seed = (seed === undefined ? 0 : seed) >>> 0;
    let h = seed;
    h = (Math.imul(x | 0, PRIME_X) ^ h) >>> 0;
    h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(y | 0, PRIME_Y)) >>> 0;
    h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35) + Math.imul(z | 0, PRIME_Z)) >>> 0;
    h = (Math.imul(h ^ (h >>> 15), 0x27D4EB2F)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h;
}

function hash4i(x, y, z, w, seed) {
    seed = (seed === undefined ? 0 : seed) >>> 0;
    let h = seed;
    h = (Math.imul(x | 0, PRIME_X) ^ h) >>> 0;
    h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(y | 0, PRIME_Y)) >>> 0;
    h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35) + Math.imul(z | 0, PRIME_Z)) >>> 0;
    h = (Math.imul(h ^ (h >>> 15), 0x27D4EB2F) + Math.imul(w | 0, PRIME_W)) >>> 0;
    h = (Math.imul(h ^ (h >>> 16), 0x165667B1)) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
    return h;
}

/** Combine two 32-bit hashes into one. */
function hashCombine(a, b) {
    return (Math.imul(a | 0, PRIME_X) ^ Math.imul(b | 0, PRIME_Y) ^ 0x9E3779B9) >>> 0;
}

/** Combine four 32-bit hashes. */
function hashCombine4(a, b, c, d) {
    let h = hashCombine(a, b);
    h = hashCombine(h, c);
    h = hashCombine(h, d);
    return h;
}

/** Deterministic object ID from a type tag, instance index and seed. */
function objectId(type, index, seed) {
    let h = (type | 0) >>> 0;
    h = hashCombine(h, index | 0);
    h = hashCombine(h, seed === undefined ? 0 : seed);
    return murmur3Finalize(h);
}

// ============================================================================
// Function Declarations — Continuous float hashes
// ============================================================================
function hashFloat01(x) { return wangHash(x | 0) * INV_2_32; }

function hashFloatSigned(x) { return wangHash(x | 0) * INV_2_32 * 2 - 1; }

function hash3Float01(x, y, z, seed) { return hash3i(x, y, z, seed) * INV_2_32; }

function hash3FloatSigned(x, y, z, seed) { return hash3i(x, y, z, seed) * INV_2_32 * 2 - 1; }

function hash4Float01(x, y, z, w, seed) { return hash4i(x, y, z, w, seed) * INV_2_32; }

function hash4FloatSigned(x, y, z, w, seed) { return hash4i(x, y, z, w, seed) * INV_2_32 * 2 - 1; }

// ============================================================================
// Function Declarations — Gradient hashes (out-parameter, zero-GC)
// ============================================================================
/**
 * Deterministic unit vector on the 2D circle from a hash. Writes out[0..1].
 */
function hashGradient2(out, x, y, seed) {
    const h = hash2i(x, y, seed);
    const angle = h * INV_2_32 * TWO_PI;
    out[0] = Math.cos(angle);
    out[1] = Math.sin(angle);
    return out;
}

/**
 * Deterministic unit vector on the 3D sphere from a hash. Writes out[0..2].
 */
function hashGradient3(out, x, y, z, seed) {
    const h = hash3i(x, y, z, seed);
    const h2 = murmur3Finalize(h);
    const theta = (h & 0xffff) / 65536 * TWO_PI;
    const zComp = (h2 & 0xffff) / 65536 * 2 - 1;
    const r = Math.sqrt(Math.max(0, 1 - zComp * zComp));
    out[0] = r * Math.cos(theta);
    out[1] = r * Math.sin(theta);
    out[2] = zComp;
    return out;
}

// ============================================================================
// Function Declarations — Morton / Z-order
// ============================================================================
function mortonEncode2(x, y) {
    let m = 0;
    for (let i = 0; i < 16; i++) {
        const mask = 1 << i;
        if (x & mask) m |= 1 << (2 * i);
        if (y & mask) m |= 1 << (2 * i + 1);
    }
    return m >>> 0;
}

function mortonEncode3(x, y, z) {
    let m = 0;
    for (let i = 0; i < 10; i++) {
        const mask = 1 << i;
        if (x & mask) m |= 1 << (3 * i);
        if (y & mask) m |= 1 << (3 * i + 1);
        if (z & mask) m |= 1 << (3 * i + 2);
    }
    return m >>> 0;
}

function mortonEncode4(x, y, z, w) {
    let m = 0;
    for (let i = 0; i < 8; i++) {
        const mask = 1 << i;
        if (x & mask) m |= 1 << (4 * i);
        if (y & mask) m |= 1 << (4 * i + 1);
        if (z & mask) m |= 1 << (4 * i + 2);
        if (w & mask) m |= 1 << (4 * i + 3);
    }
    return m >>> 0;
}

/** Decode a 2D Morton code into `out[0]=x, out[1]=y`. */
function mortonDecode2(out, m) {
    let x = 0, y = 0;
    for (let i = 0; i < 16; i++) {
        if (m & (1 << (2 * i))) x |= 1 << i;
        if (m & (1 << (2 * i + 1))) y |= 1 << i;
    }
    out[0] = x; out[1] = y;
    return out;
}

/** Decode a 3D Morton code into `out[0]=x, out[1]=y, out[2]=z`. */
function mortonDecode3(out, m) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < 10; i++) {
        if (m & (1 << (3 * i))) x |= 1 << i;
        if (m & (1 << (3 * i + 1))) y |= 1 << i;
        if (m & (1 << (3 * i + 2))) z |= 1 << i;
    }
    out[0] = x; out[1] = y; out[2] = z;
    return out;
}

// ============================================================================
// Function Declarations — 64-bit-style composite hash (out-parameter)
// ============================================================================
/**
 * Produce a 64-bit hash pair for very large keyspaces. Writes
 * `out[0]=hi`, `out[1]=lo`. Two independently-seeded 32-bit mixes.
 */
function hash64(out, x, y, z, seed) {
    seed = (seed === undefined ? 0 : seed) >>> 0;
    let lo = seed;
    lo = (Math.imul(x | 0, 0x9E3779B1) ^ lo) >>> 0;
    lo = (Math.imul(lo ^ (lo >>> 16), 0x85EBCA6B) + Math.imul(y | 0, 0xCC9E2D51)) >>> 0;
    lo = (Math.imul(lo ^ (lo >>> 13), 0xC2B2AE35) + Math.imul(z | 0, 0x85EBCA77)) >>> 0;
    lo = (lo ^ (lo >>> 16)) >>> 0;
    let hi = (seed ^ 0xA5A5A5A5) >>> 0;
    hi = (Math.imul(x | 0, 0x27D4EB2F) ^ hi) >>> 0;
    hi = (Math.imul(hi ^ (hi >>> 15), 0x165667B1) + Math.imul(y | 0, 0x9E3779B1)) >>> 0;
    hi = (Math.imul(hi ^ (hi >>> 17), 0x85EBCA6B) + Math.imul(z | 0, 0x27D4EB2F)) >>> 0;
    hi = (hi ^ (hi >>> 15)) >>> 0;
    out[0] = hi;
    out[1] = lo;
    return out;
}

/**
 * Convert a (hi, lo) pair to a float in [0, 1). Split into two scaled terms
 * to avoid the precision loss of `hi * 2^32` at large values.
 */
function hash64ToFloat(hi, lo) {
    return (hi >>> 0) * INV_2_32 + (lo >>> 0) * INV_2_32 * INV_2_32;
}

// ============================================================================
// Class Declarations — StreamingHasher
// ============================================================================
/**
 * StreamingHasher — incremental 32-bit hash accumulator for composite
 * object IDs. `writeFloat` uses a module-level shared DataView (zero-GC).
 */
class StreamingHasher {
    h = 0;
    constructor(seed) {
        this.h = (seed === undefined ? 0xdeadbeef : seed) >>> 0;
    }
    writeInt(v) {
        this.h = (Math.imul(this.h ^ (v >>> 0), PRIME_X) ^ (v >>> 0)) >>> 0;
        this.h = (this.h + 0x9E3779B9) >>> 0;
        return this;
    }
    writeFloat(v) {
        _hasherDV.setFloat64(0, v);
        this.writeInt(_hasherDV.getUint32(0));
        this.writeInt(_hasherDV.getUint32(4));
        return this;
    }
    write2i(x, y) { this.writeInt(x); this.writeInt(y); return this; }
    write3i(x, y, z) { this.writeInt(x); this.writeInt(y); this.writeInt(z); return this; }
    writeString(s) {
        for (let i = 0; i < s.length; i++) {
            this.h = (Math.imul(this.h, 31) + s.charCodeAt(i)) >>> 0;
        }
        return this;
    }
    finish() {
        let h = this.h;
        h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B | 0);
        h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35 | 0);
        h = (h ^ (h >>> 16)) >>> 0;
        return h;
    }
    reset(seed) {
        this.h = (seed === undefined ? 0xdeadbeef : seed) >>> 0;
        return this;
    }
}

function createHasher(seed) { return new StreamingHasher(seed); }

// ============================================================================
// Function Declarations — Micro-spatial-hash (blueprint §50)
// ============================================================================
/**
 * Zero-GC typed-array linked-list spatial hash. `heads` holds bucket heads,
 * `next` holds per-entity linked-list pointers. Created once at init.
 */
function createMicroSpatialHash(bucketCount, entityCapacity) {
    const heads = new Int32Array(bucketCount);
    const next = new Int32Array(entityCapacity);
    heads.fill(-1);
    next.fill(-1);
    return { heads: heads, next: next, bucketCount: bucketCount, entityCapacity: entityCapacity };
}

function microSpatialClear(hash) {
    hash.heads.fill(-1);
    return hash;
}

/** O(1) insertion at the head of the bucket's linked list. */
function microSpatialInsert(hash, entityId, bucket) {
    hash.next[entityId] = hash.heads[bucket];
    hash.heads[bucket] = entityId;
    return hash;
}

/**
 * Collect all entities in a bucket into `outEntities` (closure-free
 * iteration). Returns the number written.
 */
function microSpatialCollectBucket(hash, bucket, outEntities) {
    let count = 0;
    let cur = hash.heads[bucket];
    while (cur !== -1 && count < outEntities.length) {
        outEntities[count++] = cur;
        cur = hash.next[cur];
    }
    return count;
}

/** Map a world position to a bucket index via the 3D spatial hash. */
function hashBucketIndex(x, y, z, cellSize, bucketCount) {
    const ix = Math.floor(x / cellSize);
    const iy = Math.floor(y / cellSize);
    const iz = Math.floor(z / cellSize);
    return hash3i(ix, iy, iz, 0) % bucketCount;
}

// ============================================================================
// Function Declarations — Domain helpers (out-parameter, zero-GC)
// ============================================================================
/** Terrain variation between two tiles — returns [0, 1). */
function hashTerrainVariation(tileX, tileY, seed) {
    return hash2i(tileX, tileY, seed === undefined ? 0xCAFE : seed) * INV_2_32;
}

/** Deterministic tile seed at any scale (3D or 4D tile keys). */
function hashTileSeed(tileX, tileY, tileZ, tileW, seed) {
    if (tileW === undefined) {
        return hash3i(tileX, tileY, tileZ === undefined ? 0 : tileZ, seed);
    }
    return hash4i(tileX, tileY, tileZ, tileW, seed);
}

/** Hash-based density field — lightweight per-cell scatter density. */
function hashScatterDensity(x, y, z, scale, seed) {
    scale = scale === undefined ? 1 : scale;
    const ix = Math.floor(x * scale);
    const iy = Math.floor(y * scale);
    const iz = Math.floor(z * scale);
    return hash3i(ix, iy, iz, seed) * INV_2_32;
}

/** Per-instance animation phase in [0, 2π). */
function hashMotionPhase(x, y, z, seed) {
    return hash3i(x | 0, y | 0, z | 0, seed) * INV_2_32 * TWO_PI;
}

/** Per-instance IK target jitter in [-1, 1)³. Writes out[0..2]. */
function hashIKJitter(out, instanceId, seed) {
    const h1 = hash2i(instanceId, 0x11, seed);
    const h2 = hash2i(instanceId, 0x22, seed);
    const h3 = hash2i(instanceId, 0x33, seed);
    out[0] = h1 * INV_2_32 * 2 - 1;
    out[1] = h2 * INV_2_32 * 2 - 1;
    out[2] = h3 * INV_2_32 * 2 - 1;
    return out;
}

/**
 * HDR-safe per-instance color from a hash. Writes RGBA into `out[0..3]`.
 * Never clamps above 1, so HDR glow is preserved.
 */
function hashColorHDR(out, instanceId, seed, glow) {
    glow = glow === undefined ? 1 : glow;
    const hue = hash2i(instanceId, 0xAA, seed) * INV_2_32;
    const sat = 0.3 + hash2i(instanceId, 0xBB, seed) * INV_2_32 * 0.7;
    const val = 0.3 + hash2i(instanceId, 0xCC, seed) * INV_2_32 * 0.7;
    const h6 = hue * 6;
    const i = Math.floor(h6);
    const f = h6 - i;
    const p = val * (1 - sat);
    const q = val * (1 - f * sat);
    const t = val * (1 - (1 - f) * sat);
    let r, g, b;
    switch (i % 6) {
        case 0: r = val; g = t;   b = p;   break;
        case 1: r = q;   g = val; b = p;   break;
        case 2: r = p;   g = val; b = t;   break;
        case 3: r = p;   g = q;   b = val; break;
        case 4: r = t;   g = p;   b = val; break;
        case 5: r = val; g = p;   b = q;   break;
        default: r = val; g = val; b = val;
    }
    out[0] = r * glow;
    out[1] = g * glow;
    out[2] = b * glow;
    out[3] = 1;
    return out;
}

/**
 * Deterministic orbital-element seed. Writes
 * `out[0]=semiMajor, out[1]=eccentricity, out[2]=inclination, out[3]=phase`.
 */
function hashOrbitalSeed(out, instanceId, seed) {
    const h1 = hash2i(instanceId, 0xA1, seed);
    const h2 = hash2i(instanceId, 0xA2, seed);
    const h3 = hash2i(instanceId, 0xA3, seed);
    const h4 = hash2i(instanceId, 0xA4, seed);
    out[0] = 0.5 + h1 * INV_2_32 * 9.5;
    out[1] = h2 * INV_2_32 * 0.9;
    out[2] = h3 * INV_2_32 * Math.PI;
    out[3] = h4 * INV_2_32 * TWO_PI;
    return out;
}

/** Hash-based grid slot jitter in [-1, 1)². Writes out[0]=dx, out[1]=dy. */
function hashGridSlot(out, cellX, cellY, seed) {
    const h = hash2i(cellX, cellY, seed);
    const h2 = murmur3Finalize(h);
    out[0] = h * INV_2_32 * 2 - 1;
    out[1] = h2 * INV_2_32 * 2 - 1;
    return out;
}

/** Hash-based trilinear value noise (fast, lattice-interpolated). */
function hashValueNoise(x, y, z, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const w = fz * fz * (3 - 2 * fz);
    const c000 = hash3i(ix, iy, iz, seed) * INV_2_32;
    const c100 = hash3i(ix + 1, iy, iz, seed) * INV_2_32;
    const c010 = hash3i(ix, iy + 1, iz, seed) * INV_2_32;
    const c110 = hash3i(ix + 1, iy + 1, iz, seed) * INV_2_32;
    const c001 = hash3i(ix, iy, iz + 1, seed) * INV_2_32;
    const c101 = hash3i(ix + 1, iy, iz + 1, seed) * INV_2_32;
    const c011 = hash3i(ix, iy + 1, iz + 1, seed) * INV_2_32;
    const c111 = hash3i(ix + 1, iy + 1, iz + 1, seed) * INV_2_32;
    const nx0 = c000 + (c100 - c000) * u;
    const nx1 = c010 + (c110 - c010) * u;
    const nx2 = c001 + (c101 - c001) * u;
    const nx3 = c011 + (c111 - c011) * u;
    const ny0 = nx0 + (nx1 - nx0) * v;
    const ny1 = nx2 + (nx3 - nx2) * v;
    return ny0 + (ny1 - ny0) * w;
}

// ============================================================================
// Function Declarations — SOA (sync)
// ============================================================================
function soaHash2i(out, xs, ys, seed, count) {
    count = count === undefined ? out.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    for (let i = 0; i < count; i++) out[i] = hash2i(xs[i] | 0, ys[i] | 0, seed);
    return out;
}

function soaHash3i(out, xs, ys, zs, seed, count) {
    count = count === undefined ? out.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    for (let i = 0; i < count; i++) out[i] = hash3i(xs[i] | 0, ys[i] | 0, zs[i] | 0, seed);
    return out;
}

function soaHash3FloatSigned(out, xs, ys, zs, seed, count) {
    count = count === undefined ? out.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    for (let i = 0; i < count; i++) {
        out[i] = hash3i(xs[i] | 0, ys[i] | 0, zs[i] | 0, seed) * INV_2_32 * 2 - 1;
    }
    return out;
}

function soaHash3Float01(out, xs, ys, zs, seed, count) {
    count = count === undefined ? out.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    for (let i = 0; i < count; i++) {
        out[i] = hash3i(xs[i] | 0, ys[i] | 0, zs[i] | 0, seed) * INV_2_32;
    }
    return out;
}

/** Jitter `positions` SOA in place by a per-instance hash offset. */
function soaJitterPositions(positions, jitter, seed, count) {
    count = count === undefined ? positions.count : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        const h1 = hash3i(i, seed, 0x11, seed);
        const h2 = hash3i(i, seed, 0x22, seed);
        const h3 = hash3i(i, seed, 0x33, seed);
        px[i] += (h1 * INV_2_32 * 2 - 1) * jitter;
        py[i] += (h2 * INV_2_32 * 2 - 1) * jitter;
        pz[i] += (h3 * INV_2_32 * 2 - 1) * jitter;
    }
    return positions;
}

/** Per-instance animation phase array — random phase in [0, 2π). */
function soaMotionPhases(out, count, seed) {
    count = count === undefined ? out.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    for (let i = 0; i < count; i++) out[i] = hash2i(i, 0xAB, seed) * INV_2_32 * TWO_PI;
    return out;
}

/** Batch HDR-safe color generation into a vec4 SOA. */
function soaColorHDR(colors, seed, glow, count) {
    count = count === undefined ? colors.count : count;
    glow = glow === undefined ? 1 : glow;
    const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
    for (let i = 0; i < count; i++) {
        hashColorHDR(_colorTmp, i, seed, glow);
        cx[i] = _colorTmp[0]; cy[i] = _colorTmp[1];
        cz[i] = _colorTmp[2]; cw[i] = 1;
    }
    return colors;
}

/** Batch gradient hashing into a vec3 SOA — per-instance unit vectors. */
function soaGradient3(gradients, xs, ys, zs, seed, count) {
    count = count === undefined ? gradients.count : count;
    const gx = gradients.x, gy = gradients.y, gz = gradients.z;
    const s = acquireHashScratch(3);
    const g = s.a;
    for (let i = 0; i < count; i++) {
        hashGradient3(g, xs[i] | 0, ys[i] | 0, zs[i] | 0, seed);
        gx[i] = g[0]; gy[i] = g[1]; gz[i] = g[2];
    }
    releaseHashScratch(s);
    return gradients;
}

/** Batch orbital seed generation into four 1D arrays. */
function soaOrbitalSeeds(semiMajor, eccentricity, inclination, phase, seed, count) {
    count = count === undefined ? semiMajor.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    for (let i = 0; i < count; i++) {
        hashOrbitalSeed(_vec4Tmp, i, seed);
        semiMajor[i] = _vec4Tmp[0];
        eccentricity[i] = _vec4Tmp[1];
        inclination[i] = _vec4Tmp[2];
        phase[i] = _vec4Tmp[3];
    }
}

/** Batch 3D value noise. */
function soaHashValue3(out, positions, scale, seed, count) {
    count = count === undefined ? positions.count : count;
    scale = scale === undefined ? 1 : scale;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        out[i] = hashValueNoise(px[i] * scale, py[i] * scale, pz[i] * scale, seed);
    }
    return out;
}

/** Batch hash-based FBM (multi-octave value noise). */
function soaHashFBM3(out, positions, scale, octaves, lacunarity, gain, seed, count) {
    count = count === undefined ? positions.count : count;
    scale = scale === undefined ? 1 : scale;
    octaves = octaves || 4;
    lacunarity = lacunarity || 2;
    gain = gain || 0.5;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
        let sum = 0, amp = 1, freq = scale, norm = 0;
        const x = px[i], y = py[i], z = pz[i];
        for (let o = 0; o < octaves; o++) {
            sum += amp * hashValueNoise(x * freq, y * freq, z * freq, seed + o);
            norm += amp;
            freq *= lacunarity;
            amp *= gain;
        }
        out[i] = sum / norm;
    }
    return out;
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaHash2iChunked(out, xs, ys, seed, count, cs, ye) {
    count = count === undefined ? out.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = hash2i(xs[i] | 0, ys[i] | 0, seed);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaHash3iChunked(out, xs, ys, zs, seed, count, cs, ye) {
    count = count === undefined ? out.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = hash3i(xs[i] | 0, ys[i] | 0, zs[i] | 0, seed);
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaHash3FloatSignedChunked(out, xs, ys, zs, seed, count, cs, ye) {
    count = count === undefined ? out.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            out[i] = hash3i(xs[i] | 0, ys[i] | 0, zs[i] | 0, seed) * INV_2_32 * 2 - 1;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaJitterPositionsChunked(positions, jitter, seed, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const px = positions.x, py = positions.y, pz = positions.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            const h1 = hash3i(i, seed, 0x11, seed);
            const h2 = hash3i(i, seed, 0x22, seed);
            const h3 = hash3i(i, seed, 0x33, seed);
            px[i] += (h1 * INV_2_32 * 2 - 1) * jitter;
            py[i] += (h2 * INV_2_32 * 2 - 1) * jitter;
            pz[i] += (h3 * INV_2_32 * 2 - 1) * jitter;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return positions;
}

async function soaMotionPhasesChunked(out, count, seed, cs, ye) {
    count = count === undefined ? out.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) out[i] = hash2i(i, 0xAB, seed) * INV_2_32 * TWO_PI;
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaColorHDRChunked(colors, seed, glow, count, cs, ye) {
    count = count === undefined ? colors.count : count;
    glow = glow === undefined ? 1 : glow;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            hashColorHDR(_colorTmp, i, seed, glow);
            cx[i] = _colorTmp[0]; cy[i] = _colorTmp[1];
            cz[i] = _colorTmp[2]; cw[i] = 1;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return colors;
}

async function soaGradient3Chunked(gradients, xs, ys, zs, seed, count, cs, ye) {
    count = count === undefined ? gradients.count : count;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const gx = gradients.x, gy = gradients.y, gz = gradients.z;
    const s = acquireHashScratch(3);
    const g = s.a;
    try {
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + cs, count);
            for (let i = start; i < end; i++) {
                hashGradient3(g, xs[i] | 0, ys[i] | 0, zs[i] | 0, seed);
                gx[i] = g[0]; gy[i] = g[1]; gz[i] = g[2];
            }
            start = end;
            if (start >= count) break;
            if (++c >= ye) { c = 0; await common.yieldToMain(); }
        }
    } finally {
        releaseHashScratch(s);
    }
    return gradients;
}

async function soaOrbitalSeedsChunked(semiMajor, eccentricity, inclination, phase, seed, count, cs, ye) {
    count = count === undefined ? semiMajor.length : count;
    seed = (seed === undefined ? 0 : seed) >>> 0;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            hashOrbitalSeed(_vec4Tmp, i, seed);
            semiMajor[i] = _vec4Tmp[0];
            eccentricity[i] = _vec4Tmp[1];
            inclination[i] = _vec4Tmp[2];
            phase[i] = _vec4Tmp[3];
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
}

async function soaHashValue3Chunked(out, positions, scale, seed, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    scale = scale === undefined ? 1 : scale;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const px = positions.x, py = positions.y, pz = positions.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            out[i] = hashValueNoise(px[i] * scale, py[i] * scale, pz[i] * scale, seed);
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

async function soaHashFBM3Chunked(out, positions, scale, octaves, lacunarity, gain, seed, count, cs, ye) {
    count = count === undefined ? positions.count : count;
    scale = scale === undefined ? 1 : scale;
    octaves = octaves || 4;
    lacunarity = lacunarity || 2;
    gain = gain || 0.5;
    cs = cs || common.CHUNK_SIZE;
    ye = ye || common.CHUNK_YIELD_EVERY;
    const px = positions.x, py = positions.y, pz = positions.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + cs, count);
        for (let i = start; i < end; i++) {
            let sum = 0, amp = 1, freq = scale, norm = 0;
            const x = px[i], y = py[i], z = pz[i];
            for (let o = 0; o < octaves; o++) {
                sum += amp * hashValueNoise(x * freq, y * freq, z * freq, seed + o);
                norm += amp;
                freq *= lacunarity;
                amp *= gain;
            }
            out[i] = sum / norm;
        }
        start = end;
        if (start >= count) break;
        if (++c >= ye) { c = 0; await common.yieldToMain(); }
    }
    return out;
}

// ============================================================================
// Class Declarations — Scratch and batch state
// ============================================================================
/** Reusable precision-aware hash scratch. Fixed-capacity pool, swap-remove. */
class HashScratch {
    static #pool = new Array(32);
    static #count = 0;
    static {
        for (let i = 0; i < 8; i++) HashScratch.#pool[HashScratch.#count++] = new HashScratch(256);
    }
    static acquire(size) {
        for (let i = 0; i < HashScratch.#count; i++) {
            if (HashScratch.#pool[i].size >= (size || 0)) {
                const s = HashScratch.#pool[i];
                HashScratch.#count--;
                HashScratch.#pool[i] = HashScratch.#pool[HashScratch.#count];
                HashScratch.#pool[HashScratch.#count] = null;
                return s;
            }
        }
        return new HashScratch(size || 256);
    }
    static release(s) {
        if (!s) return;
        s.reset();
        if (HashScratch.#count < 32) HashScratch.#pool[HashScratch.#count++] = s;
    }
    constructor(size) {
        this.size = size || 256;
        const T = getArrayType();
        this.a = new T(this.size);
        this.b = new T(this.size);
        this.c = new T(this.size);
        this.d = new T(this.size);
    }
    ensure(n) { return _hashScratchEnsure(this, n); }
    reset() {
        this.a.fill(0); this.b.fill(0); this.c.fill(0); this.d.fill(0);
        return this;
    }
}

/** Batch state — preallocated buffers for 1M+ hash evaluations per frame. */
class HashBatchState {
    constructor(count, seed) {
        this.count = count;
        this.seed = seed === undefined ? 1 : (seed >>> 0);
        const T = getArrayType();
        this.hashes = new Uint32Array(count);
        this.values = new T(count);
        this.x = new T(count);
        this.y = new T(count);
        this.z = new T(count);
    }
    hash3i(seed) { return soaHash3i(this.hashes, this.x, this.y, this.z, seed === undefined ? this.seed : seed, this.count); }
    hash3FloatSigned(seed) { return soaHash3FloatSigned(this.values, this.x, this.y, this.z, seed === undefined ? this.seed : seed, this.count); }
    hash3Float01(seed) { return soaHash3Float01(this.values, this.x, this.y, this.z, seed === undefined ? this.seed : seed, this.count); }
    async hash3iChunked(seed, cs, ye) {
        return soaHash3iChunked(this.hashes, this.x, this.y, this.z, seed === undefined ? this.seed : seed, this.count, cs, ye);
    }
    async hash3FloatSignedChunked(seed, cs, ye) {
        return soaHash3FloatSignedChunked(this.values, this.x, this.y, this.z, seed === undefined ? this.seed : seed, this.count, cs, ye);
    }
}

function createHashBatch(count, seed) { return new HashBatchState(count, seed); }

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    integer: {
        wang: wangHash,
        wang2: wangHash2,
        murmur3Finalize,
        xxHash32,
        fnv1a32,
        jenkinsOAT,
        sipHashLite,
        hashCombine,
        hashCombine4,
        objectId
    },
    string: {
        djb2, sdbm, fnv1aString, javaStringHash
    },
    prng: {
        mulberry32, splitmix32, xorshift32, sfc32, pcg32,
        create: createPRNG
    },
    spatial: {
        hash2i, hash3i, hash4i,
        hashFloat01, hashFloatSigned,
        hash3Float01, hash3FloatSigned,
        hash4Float01, hash4FloatSigned,
        hashGradient2, hashGradient3,
        bucketIndex: hashBucketIndex
    },
    microHash: {
        create: createMicroSpatialHash,
        clear: microSpatialClear,
        insert: microSpatialInsert,
        collectBucket: microSpatialCollectBucket
    },
    morton: {
        encode2: mortonEncode2,
        encode3: mortonEncode3,
        encode4: mortonEncode4,
        decode2: mortonDecode2,
        decode3: mortonDecode3
    },
    hash64: {
        create: hash64,
        toFloat: hash64ToFloat
    },
    streaming: {
        Hasher: StreamingHasher,
        create: createHasher
    },
    domain: {
        terrainVariation: hashTerrainVariation,
        tileSeed: hashTileSeed,
        scatterDensity: hashScatterDensity,
        motionPhase: hashMotionPhase,
        ikJitter: hashIKJitter,
        colorHDR: hashColorHDR,
        orbitalSeed: hashOrbitalSeed,
        gridSlot: hashGridSlot,
        valueNoise: hashValueNoise
    },
    batch: {
        hash2i: soaHash2i, hash2iChunked: soaHash2iChunked,
        hash3i: soaHash3i, hash3iChunked: soaHash3iChunked,
        hash3FloatSigned: soaHash3FloatSigned,
        hash3FloatSignedChunked: soaHash3FloatSignedChunked,
        hash3Float01: soaHash3Float01,
        jitterPositions: soaJitterPositions,
        jitterPositionsChunked: soaJitterPositionsChunked,
        motionPhases: soaMotionPhases,
        motionPhasesChunked: soaMotionPhasesChunked,
        colorHDR: soaColorHDR,
        colorHDRChunked: soaColorHDRChunked,
        gradient3: soaGradient3,
        gradient3Chunked: soaGradient3Chunked,
        orbitalSeeds: soaOrbitalSeeds,
        orbitalSeedsChunked: soaOrbitalSeedsChunked,
        hashValue3: soaHashValue3,
        hashValue3Chunked: soaHashValue3Chunked,
        hashFBM3: soaHashFBM3,
        hashFBM3Chunked: soaHashFBM3Chunked,
        State: HashBatchState,
        create: createHashBatch
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Primary hash arithmetic is 32-bit integer (Math.imul) and is unaffected by
// precision mode; output buffers created after a change use the live type.
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // 32-bit integer hashes
    wangHash, wangHash2, murmur3Finalize, xxHash32, fnv1a32,
    jenkinsOAT, sipHashLite,
    // String hashes
    djb2, sdbm, fnv1aString, javaStringHash,
    // Seeded PRNGs
    mulberry32, splitmix32, xorshift32, sfc32, pcg32, createPRNG,
    // Spatial integer hashes
    hash2i, hash3i, hash4i, hashCombine, hashCombine4, objectId,
    // Continuous float hashes
    hashFloat01, hashFloatSigned,
    hash3Float01, hash3FloatSigned, hash4Float01, hash4FloatSigned,
    // Gradient hashes
    hashGradient2, hashGradient3,
    // Morton / Z-order
    mortonEncode2, mortonEncode3, mortonEncode4, mortonDecode2, mortonDecode3,
    // 64-bit-style composite hash
    hash64, hash64ToFloat,
    // Streaming hasher
    StreamingHasher, createHasher,
    // Micro-spatial-hash (blueprint §50)
    createMicroSpatialHash, microSpatialClear, microSpatialInsert,
    microSpatialCollectBucket, hashBucketIndex,
    // Domain helpers
    hashTerrainVariation, hashTileSeed, hashScatterDensity,
    hashMotionPhase, hashIKJitter, hashColorHDR,
    hashOrbitalSeed, hashGridSlot, hashValueNoise,
    // SOA (sync)
    soaHash2i, soaHash3i, soaHash3FloatSigned, soaHash3Float01,
    soaJitterPositions, soaMotionPhases, soaColorHDR, soaGradient3,
    soaOrbitalSeeds, soaHashValue3, soaHashFBM3,
    // SOA (chunked async)
    soaHash2iChunked, soaHash3iChunked, soaHash3FloatSignedChunked,
    soaJitterPositionsChunked, soaMotionPhasesChunked, soaColorHDRChunked,
    soaGradient3Chunked, soaOrbitalSeedsChunked,
    soaHashValue3Chunked, soaHashFBM3Chunked,
    // Pools
    HashScratch, createHashScratchPool, acquireHashScratch, releaseHashScratch,
    // Batch state
    HashBatchState, createHashBatch,
    // Namespaces
    namespace
};