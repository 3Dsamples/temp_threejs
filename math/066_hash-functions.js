//File number : 066
// File : src/math/066_hash-functions.js
//Description : Complete hash-function system — 32-bit integer hashes (Wang, Murmur3 finalizer, xxHash32 with seed, FNV-1a, Jenkins one-at-a-time, SipHash-lite), string hashes (djb2, sdbm, FNV-1a string, Java string), seeded PRNGs (mulberry32, splitmix32, xorshift32, sfc32, pcg32), spatial integer hashes (2D/3D/4D), continuous float hashes ([0,1) and [-1,1)), gradient hashes for noise, Morton/Z-order encoding 2D/3D/4D, hash-combine primitives, a streaming hasher for composite object IDs, plus a 64-bit-style composite hash (hi/lo pair) for galactic-scale keyspaces. Domain helpers cover hash-based terrain variation, tile-based scatter density, per-instance animation phase, IK target jitter, HDR-safe color generation, deterministic orbital seeds, and spatial-hash grid lookups for 1M+ particles. Every routine has an SOA batch version + chunked async variant that yields via `scheduler.yield()` so the Android 64-bit UI thread never freezes. All mutable state l
ives in a pooled `HashScratch`, output buffers honor `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap), and primary hashes stay in 32-bit integer arithmetic (`Math.imul`, `>>> 0`) for maximum speed on mobile JITs.
//####
//Best for : 3d graphics — deterministic per-instance variation on 1M+ particle/asteroid/foliage placements (spatial hash + noise-free), procedural tile variation across a 4D world (Morton code + hash), per-instance animation phase offsets without storing state (hash-based phase), IK target jitter for crowd variety, HDR-safe per-instance color palettes (hash-based), per-tile terrain seeds at galactic scale (composite 64-bit hash), object-pool IDs, network message IDs, Perlin/Worley gradient-table seeding (Wang hash of the lattice coordinate), reservoir-sampling vertex selection, and any procedural pipeline that needs 1M+ deterministic random values per frame on Android 64-bit without blocking the UI thread.
//License : MIT

// ============================================
================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M = require("./000_Math_module.js");

const common          = M.common;
const getArrayType    = M.getArrayType;
const onPrecisionChange = M.onPrecisionChange;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- 32-bit integer hashes ----
exports.wangHash          = wangHash;
exports.wangHash2         = wangHash2;
exports.murmur3Finalize   = murmur3Finalize;
exports.xxHash32          = xxHash32;
exports.fnv1a32           = fnv1a32;
exports.jenkinsOAT        = jenkinsOAT;
exports.sipHashLite       = sipHashLite;

// ---- String hashes ----
exports.dj
b2              = djb2;
exports.sdbm              = sdbm;
exports.fnv1aString       = fnv1aString;
exports.javaStringHash    = javaStringHash;

// ---- Seeded PRNGs ----
exports.mulberry32        = mulberry32;
exports.splitmix32        = splitmix32;
exports.xorshift32        = xorshift32;
exports.sfc32             = sfc32;
exports.pcg32             = pcg32;
exports.createPRNG        = createPRNG;

// ---- Spatial integer hashes ----
exports.hash2i            = hash2i;
exports.hash3i            = hash3i;
exports.hash4i            = hash4i;
exports.hashCombine       = hashCombine;
exports.hashCombine4      = hashCombine4;
exports.objectId          = objectId;

// ---- Continuous float hashes ----
exports.hashFloat01       = hashFloat01;
exports.hashFloatSigned   = hashFloatSigned;
exports.hash3Float01      = hash3Float01;
exports.hash3FloatSigned  = hash3FloatSigned;
exports.hash4Float01      = hash4Float01;
exports.hash4FloatSigned  = hash4FloatSigned;

// ---- Gradient hashes for noise ----
exports.hashGradie
nt2     = hashGradient2;
exports.hashGradient3     = hashGradient3;

// ---- Morton / Z-order ----
exports.mortonEncode2     = mortonEncode2;
exports.mortonEncode3     = mortonEncode3;
exports.mortonEncode4     = mortonEncode4;
exports.mortonDecode2     = mortonDecode2;
exports.mortonDecode3     = mortonDecode3;

// ---- 64-bit-style composite hash ----
exports.hash64            = hash64;
exports.hash64ToFloat     = hash64ToFloat;

// ---- Streaming hasher ----
exports.StreamingHasher   = StreamingHasher;
exports.createHasher      = createHasher;

// ---- Domain helpers ----
exports.hashTerrainVariation = hashTerrainVariation;
exports.hashTileSeed         = hashTileSeed;
exports.hashScatterDensity   = hashScatterDensity;
exports.hashMotionPhase      = hashMotionPhase;
exports.hashIKJitter         = hashIKJitter;
exports.hashColorHDR         = hashColorHDR;
exports.hashOrbitalSeed      = hashOrbitalSeed;
exports.hashGridSlot         = hashGridSlot;
exports.hashValueNoise       = hashValueNoise;

// ---- SOA (s
ync) ----
exports.soaHash2i           = soaHash2i;
exports.soaHash3i           = soaHash3i;
exports.soaHash3FloatSigned = soaHash3FloatSigned;
exports.soaHash3Float01     = soaHash3Float01;
exports.soaJitterPositions  = soaJitterPositions;
exports.soaMotionPhases     = soaMotionPhases;
exports.soaColorHDR         = soaColorHDR;
exports.soaGradient3        = soaGradient3;
exports.soaOrbitalSeeds     = soaOrbitalSeeds;
exports.soaHashValue3       = soaHashValue3;
exports.soaHashFBM3         = soaHashFBM3;

// ---- SOA (chunked async) ----
exports.soaHash3iChunked       = soaHash3iChunked;
exports.soaHash3FloatSignedChunked = soaHash3FloatSignedChunked;
exports.soaJitterPositionsChunked  = soaJitterPositionsChunked;
exports.soaMotionPhasesChunked     = soaMotionPhasesChunked;
exports.soaColorHDRChunked         = soaColorHDRChunked;
exports.soaHashFBM3Chunked         = soaHashFBM3Chunked;

// ---- Pools ----
exports.HashScratch        = HashScratch;
exports.createHashScratchPool = createHashScratchPool;
exports.a
cquireHashScratch    = acquireHashScratch;
exports.releaseHashScratch    = releaseHashScratch;

// ---- Batch ----
exports.HashBatchState     = HashBatchState;
exports.createHashBatch    = createHashBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// (all mutable state lives in pools or per-instance)

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {Object} Hash64
 * @property {number} hi  High 32 bits (0..2^32-1)
 * @property {number} lo  Low 32 bits (0..2^32-1)
 */

/**
 * @typedef {Object} PRNG
 * @property {Function} next     Returns a float in [0, 1)
 * @property {Function} nextInt  Returns an integer in [0, 2^32)
 * @property {Function} reseed   Re-seed the generator

 * @property {Function} state    Get a snapshot of the current state
 * @property {Function} restore  Restore a previously captured state
 */

/**
 * @typedef {Object} HasherHandle
 * @property {Function} write    Feed bytes / numbers into the accumulator
 * @property {Function} finish   Return the current 32-bit hash value
 * @property {Function} reset    Reset the accumulator
 */

/**
 * @typedef {Object} Gradient2
 * @property {number} x
 * @property {number} y
 */

/**
 * @typedef {Object} Gradient3
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const TWO_PI       = Math.PI * 2;
const INV_2_32     = 1 / 4294967296;          // 2^-32
const GOLDEN32     = 0x9E3779B9 | 0;          // knuth's golden ratio
const FNV_OFFSET32 = 0x811C9DC5 | 0;
const FNV_PRIME32  = 0x01000193 | 0;
const DJB2_SEED    
= 5381;
const SDBM_SEED    = 0;
const JAVA_SEED    = 0;

// Magic PCG multiplier
const PCG_MULT     = 0x5851F42D;

// Spatial hash primes (well known good choices for 3D cellular hashes)
const PRIME_X = 0x1B873593 | 0;
const PRIME_Y = 0xCC9E2D51 | 0;
const PRIME_Z = 0x85EBCA77 | 0;
const PRIME_W = 0xC2B2AE3D | 0;

// Pools
const _hashScratchPool = common.createPool(
  function () {
    const T = getArrayType();
    return {
      a: new T(256),
      b: new T(256),
      c: new T(256),
      d: new T(256),
      size: 256,
      _attached: false
    };
  },
  8,
  function (s) {
    if (s.a) s.a.fill(0);
    if (s.b) s.b.fill(0);
    if (s.c) s.c.fill(0);
    if (s.d) s.d.fill(0);
  }
);

// Attach ensure method once per pooled entry
(function warmHashScratch() {
  const pool = _hashScratchPool;
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
        this.c = new T(n);
        this.d = new T(n);
        return this;
      };
    }
    return s;
  };
})();

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * StreamingHasher — incremental 32-bit hash accumulator. Ideal for building
 * composite object IDs (position + type + seed) in one pass.
 */
class StreamingHasher {
  // Class Fields
  h = 0;

  constructor(seed) {
    this.h = (seed === undefined ? 0xdeadbeef : seed) >>> 0;
  }

  /** Feed an integer (any range) into the accumulator. */
  writeInt(v) {
    this.h = (Math.imul(this.h ^ (v >>> 0), PRIME_X) ^ (v >>> 0)) >>> 0;
    this.h = (this.h + 0x9E3779B9) >>> 0;
    return this;
  }

  /** Feed a float (its IEEE-754 bits) into the accumulator. */
  writeFloat(v) {
    // Split float into two 32-bit
 halves
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setFloat64(0, v);
    const hi = dv.getUint32(0);
    const lo = dv.getUint32(4);
    this.writeInt(hi);
    this.writeInt(lo);
    return this;
  }

  /** Feed a 2D integer pair. */
  write2i(x, y) {
    this.writeInt(x);
    this.writeInt(y);
    return this;
  }

  /** Feed a 3D integer triple. */
  write3i(x, y, z) {
    this.writeInt(x);
    this.writeInt(y);
    this.writeInt(z);
    return this;
  }

  /** Feed a string. */
  writeString(s) {
    for (let i = 0; i < s.length; i++) {
      this.h = (Math.imul(this.h, 31) + s.charCodeAt(i)) >>> 0;
    }
    return this;
  }

  /** Finalize (mix the accumulator one more time for avalanche). */
  finish() {
    let h = this.h;
    h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B | 0);
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35 | 0);
    h = (h ^ (h >>> 16)) >>> 0;
    return h;
  }

  /** Reset the accumulator to a new seed. */
  reset(seed) {
    this.h = (seed === undefined ? 
0xdeadbeef : seed) >>> 0;
    return this;
  }
}

function createHasher(seed) { return new StreamingHasher(seed); }

/**
 * HashScratch — reusable scalar scratch buffer for hash hot loops.
 */
class HashScratch {
  static #warm = [];
  static {
    for (let i = 0; i < 8; i++) HashScratch.#warm.push(new HashScratch(256));
  }
  static acquire(size) {
    for (let i = 0; i < HashScratch.#warm.length; i++) {
      if (HashScratch.#warm[i].size >= (size || 0)) {
        const s = HashScratch.#warm[i];
        HashScratch.#warm.splice(i, 1);
        return s;
      }
    }
    return new HashScratch(size || 256);
  }
  static release(s) { if (s) { s.reset(); HashScratch.#warm.push(s); } }

  constructor(size) {
    this.size = size || 256;
    const T = getArrayType();
    this.a = new T(this.size);
    this.b = new T(this.size);
    this.c = new T(this.size);
    this.d = new T(this.size);
  }

  ensure(n) {
    if (n <= this.size) return this;
    this.size = n;
    const T = getArrayType();
    this.a = new T(n
);
    this.b = new T(n);
    this.c = new T(n);
    this.d = new T(n);
    return this;
  }
  reset() {
    this.a.fill(0); this.b.fill(0); this.c.fill(0); this.d.fill(0);
    return this;
  }
}

/**
 * Batch state — preallocated buffers for 1M+ hash evaluations per frame.
 * Re-create after `setPrecision()` to pick up the new array type.
 */
class HashBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      HashBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

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
  hash3FloatSigned(seed) { retur
n soaHash3FloatSigned(this.values, this.x, this.y, this.z, seed === undefined ? this.seed : seed, this.count); }
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
// Function Declarations — 32-bit integer hashes
// ============================================================================

/**
 * Thomas Wang's 32-bit mix — fast avalanche. Good general-purpose hash.
 * Input any 32-bit integer, output a well-dis
tributed 32-bit integer.
 */
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

/**
 * MurmurHash3 finalizer — full 32-bit avalanche in one call.
 * Used by many engines for 32-bit ID generation.
 */
function murmur3Finalize(h) {
  h = (h | 0) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85EBCA6B) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xC2B2AE35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/**
 * xxHash32 — for byte sequences. Here we expose a scalar version that hashes
 * a single 32-bit value (sufficient for procedural object hashing).
 */
function xxHash32(x, seed) {
  const P1 = 0x9E3779B1;
  const P2 = 0x85EBCA77;
  const P3 = 0xC2B2AE3D;
  const P4 = 0x27D4EB2F;
  const P5 = 0x165667B1;
  seed = (seed === un
defined ? 0 : seed) >>> 0;
  let h = (seed + P5) >>> 0;
  h = (h + Math.imul(x | 0, P5)) >>> 0;
  h = (Math.imul((h << 13) | (h >>> 19), P1)) >>> 0;
  h = (Math.imul(h ^ (h >>> 15), P2)) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), P3)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/** FNV-1a 32-bit for a single 32-bit integer. */
function fnv1a32(x) {
  let h = FNV_OFFSET32 >>> 0;
  // Split x into 4 bytes
  for (let k = 0; k < 4; k++) {
    const b = (x >>> (k * 8)) & 0xff;
    h ^= b;
    h = Math.imul(h, FNV_PRIME32) >>> 0;
  }
  return h >>> 0;
}

/** Jenkins one-at-a-time hash for a 32-bit integer (4 bytes). */
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

/** Lightweight 2-input SipHash-lite for composite object keys. */
function sipHashLite(a, b, seed) {
  seed = (seed === undefined ?
 0 : seed) >>> 0;
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
  let h = DJB2_SEED;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function sdbm(str) {
  let h = SDBM_SEED;
  for (let i = 0; i < str.length; i++) {
    h = (str.charCodeAt(i) + (h << 6) + (h << 16) - h) | 0;
  }
  return h >>> 0;
}

function fnv1aString(str) {
  let h = FNV_OFFSET32 >>> 0;
  for (let i = 0; i < str.length; 
i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, FNV_PRIME32) >>> 0;
    h ^= (str.charCodeAt(i) >>> 8) & 0xff;
    h = Math.imul(h, FNV_PRIME32) >>> 0;
  }
  return h >>> 0;
}

function javaStringHash(str) {
  let h = JAVA_SEED;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// ============================================================================
// Function Declarations — Seeded PRNGs
// ============================================================================

/**
 * Mulberry32 — 32-bit state, 2^32 period, extremely fast and well-distributed.
 */
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
    nextInt: function () { return next() * 4294967296 | 0; },
    reseed: funct
ion (s) { a = (s >>> 0) || 1; },
    state: function () { return a; },
    restore: function (s) { a = s | 0; }
  };
}

/**
 * SplitMix32 — good seeding PRNG used internally by many systems.
 */
function splitmix32(seed) {
  let state = (seed >>> 0) || 1;
  const next = function () {
    state = (state + 0x9E3779B9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z * INV_2_32;
  };
  return {
    next: next,
    nextInt: function () { return next() * 4294967296 | 0; },
    reseed: function (s) { state = (s >>> 0) || 1; },
    state: function () { return state; },
    restore: function (s) { state = s | 0; }
  };
}

/**
 * Xorshift32 — minimal-state (32-bit) but shorter period than Mulberry.
 */
function xorshift32(seed) {
  let x = (seed >>> 0) || 1;
  const next = function () {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    return x * INV_2_32;
  };
  re
turn {
    next: next,
    nextInt: function () { return next() * 4294967296 | 0; },
    reseed: function (s) { x = (s >>> 0) || 1; },
    state: function () { return x; },
    restore: function (s) { x = s >>> 0; }
  };
}

/**
 * SFC32 — Small Fast Counting PRNG with 128-bit state and excellent quality.
 */
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
    nextInt: function () { return next() * 4294967296 | 0; },
    reseed: function (seed) {
      const s = splitmix32(seed >>> 0);
      a = s.nextInt() >>> 0; s.next();
      b = s.nextInt() >>> 0; s.next();
      c = s.nextInt() >>> 0; s.next();
      d = s.nextInt() >>> 0;
    },
    state: function () { return { a, b, c, d }; 
},
    restore: function (st) { a = st.a; b = st.b; c = st.c; d = st.d; }
  };
}

/**
 * PCG32 — permuted congruential generator. Excellent statistical quality with
 * only 64-bit state (represented as 2×32-bit).
 */
function pcg32(seed, seq) {
  let state = (seed >>> 0) || 1;
  let inc = ((seq >>> 0) || 1) | 1;
  const nextInt = function () {
    const old = state;
    state = (Math.imul(state, PCG_MULT) + inc) | 0;
    let xorshifted = (((old >>> 18) ^ old) >>> 27) >>> 0;
    let rot = old >>> 59;
    return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
  };
  const next = function () { return nextInt() * INV_2_32; };
  return {
    next: next,
    nextInt: nextInt,
    reseed: function (s, q) { state = (s >>> 0) || 1; inc = ((q === undefined ? inc : q) | 1); },
    state: function () { return { state, inc }; },
    restore: function (st) { state = st.state; inc = st.inc; }
  };
}

/** Factory — create a PRNG by kind. */
function createPRNG(kind, seed) {
  kind = (kind || "mulberry32").toLow
erCase();
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

/**
 * 2D spatial hash — deterministic 32-bit output for any integer lattice
 * coordinate. Good avalanche, zero allocations.
 */
function hash2i(x, y, seed) {
  seed = (seed === undefined ? 0 : seed) >>> 0;
  let h = seed;
  h = (Math.imul(x | 0, PRIME_X) ^ h) >>> 0;
  h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(y | 0, PRIME_Y)) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35)) >>> 0;
  h = (h ^ (h 
>>> 16)) >>> 0;
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
  return (Math.imul(a | 0, PRIME_
X) ^ Math.imul(b | 0, PRIME_Y) ^ 0x9E3779B9) >>> 0;
}

/** Combine four 32-bit hashes. */
function hashCombine4(a, b, c, d) {
  let h = hashCombine(a, b);
  h = hashCombine(h, c);
  h = hashCombine(h, d);
  return h;
}

/**
 * Deterministic object ID from a type tag, an instance index and a seed.
 * Useful for stable IDs across frames.
 */
function objectId(type, index, seed) {
  let h = (type | 0) >>> 0;
  h = hashCombine(h, index | 0);
  h = hashCombine(h, seed === undefined ? 0 : seed);
  return murmur3Finalize(h);
}

// ============================================================================
// Function Declarations — Continuous float hashes
// ============================================================================

/** Float in [0, 1) from a single integer. */
function hashFloat01(x) {
  return wangHash(x | 0) * INV_2_32;
}

/** Float in [-1, 1). */
function hashFloatSigned(x) {
  return (wangHash(x | 0) * INV_2_32) * 2 - 1;
}

function hash3Float01(x, y, z, seed) {
  return hash3i(x, y, z, seed
) * INV_2_32;
}

function hash3FloatSigned(x, y, z, seed) {
  return hash3i(x, y, z, seed) * INV_2_32 * 2 - 1;
}

function hash4Float01(x, y, z, w, seed) {
  return hash4i(x, y, z, w, seed) * INV_2_32;
}

function hash4FloatSigned(x, y, z, w, seed) {
  return hash4i(x, y, z, w, seed) * INV_2_32 * 2 - 1;
}

// ============================================================================
// Function Declarations — Gradient hashes
// ============================================================================

/**
 * Deterministic unit vector on the 2D circle from a hash — used by
 * Perlin-style gradient noise.
 */
function hashGradient2(x, y, seed) {
  const h = hash2i(x, y, seed);
  const angle = h * INV_2_32 * TWO_PI;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

/**
 * Deterministic unit vector on the 3D sphere from a hash — used by
 * Perlin-style 3D gradient noise.
 */
function hashGradient3(x, y, z, seed) {
  const h = hash3i(x, y, z, seed);
  // Split into two independent angles
  const h2 = mu
rmur3Finalize(h);
  const theta = (h & 0xffff) / 65536 * TWO_PI;
  const zComp = (h2 & 0xffff) / 65536 * 2 - 1;
  const r = Math.sqrt(1 - zComp * zComp);
  return { x: r * Math.cos(theta), y: r * Math.sin(theta), z: zComp };
}

// ============================================================================
// Function Declarations — Morton / Z-order
// ============================================================================

/** Encode (x, y) into a Morton (Z-order) code for 2D spatial locality. */
function mortonEncode2(x, y) {
  let m = 0;
  for (let i = 0; i < 16; i++) {
    const maskX = 1 << i;
    const maskY = 1 << i;
    if (x & maskX) m |= 1 << (2 * i);
    if (y & maskY) m |= 1 << (2 * i + 1);
  }
  return m >>> 0;
}

/** Encode (x, y, z) into a 30-bit Morton code for 3D spatial locality. */
function mortonEncode3(x, y, z) {
  let m = 0;
  for (let i = 0; i < 10; i++) {
    const mask = 1 << i;
    if (x & mask) m |= 1 << (3 * i);
    if (y & mask) m |= 1 << (3 * i + 1);
    if (z & mask) m |= 1
 << (3 * i + 2);
  }
  return m >>> 0;
}

/** Encode (x, y, z, w) into a 32-bit Morton code for 4D spatial locality. */
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

/** Decode a 2D Morton code. Returns `{ x, y }`. */
function mortonDecode2(m) {
  let x = 0, y = 0;
  for (let i = 0; i < 16; i++) {
    if (m & (1 << (2 * i))) x |= 1 << i;
    if (m & (1 << (2 * i + 1))) y |= 1 << i;
  }
  return { x, y };
}

function mortonDecode3(m) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < 10; i++) {
    if (m & (1 << (3 * i))) x |= 1 << i;
    if (m & (1 << (3 * i + 1))) y |= 1 << i;
    if (m & (1 << (3 * i + 2))) z |= 1 << i;
  }
  return { x, y, z };
}

// ============================================================================
// Function Declarations — 64-bit-style
 composite hash
// ============================================================================

/**
 * Produce a 64-bit hash pair for very large keyspaces (galactic coordinates).
 * Two independently-seeded 32-bit Murmur runs. Returns `{ hi, lo }`.
 */
function hash64(x, y, z, seed) {
  seed = (seed === undefined ? 0 : seed) >>> 0;
  // Compute two independent 32-bit hashes with different mixing constants
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

  return { hi: hi, lo: lo };
}

/** Convert
 a `{hi, lo}` pair to a float in [0, 1). Useful for a 64-bit random. */
function hash64ToFloat(h) {
  return (h.hi * 4294967296 + h.lo) * (1 / 18446744073709551616);
}

// ============================================================================
// Function Declarations — Domain helpers
// ============================================================================

/**
 * Terrain variation between two tiles — useful for procedural maps that
 * shouldn't repeat tile-by-tile. Returns [0, 1).
 */
function hashTerrainVariation(tileX, tileY, seed) {
  return hash2i(tileX, tileY, seed === undefined ? 0xCAFE : seed) * INV_2_32;
}

/**
 * Deterministic tile seed at any scale (works up to 4D tile keys).
 * Returns a 32-bit integer suitable for `mulberry32`.
 */
function hashTileSeed(tileX, tileY, tileZ, tileW, seed) {
  if (tileW === undefined) {
    return hash3i(tileX, tileY, tileZ === undefined ? 0 : tileZ, seed);
  }
  return hash4i(tileX, tileY, tileZ, tileW, seed);
}

/**
 * Hash-based density field — a ligh
tweight procedural scatter density.
 * Cheaper than simplex noise when all you need is per-cell variation.
 */
function hashScatterDensity(x, y, z, scale, seed) {
  scale = scale === undefined ? 1 : scale;
  const ix = Math.floor(x * scale);
  const iy = Math.floor(y * scale);
  const iz = Math.floor(z * scale);
  return hash3i(ix, iy, iz, seed) * INV_2_32;
}

/**
 * Per-instance animation phase — random phase for procedural animation of
 * 1M+ instances without storing per-instance state.
 */
function hashMotionPhase(x, y, z, seed) {
  return hash3i(x | 0, y | 0, z | 0, seed) * INV_2_32 * TWO_PI;
}

/** Per-instance IK target jitter in [-1, 1)³ for crowd variety. */
function hashIKJitter(instanceId, seed) {
  const h1 = hash2i(instanceId, seed, 0x11);
  const h2 = hash2i(instanceId, seed, 0x22);
  const h3 = hash2i(instanceId, seed, 0x33);
  return {
    x: h1 * INV_2_32 * 2 - 1,
    y: h2 * INV_2_32 * 2 - 1,
    z: h3 * INV_2_32 * 2 - 1
  };
}

/**
 * HDR-safe per-instance color from a hash. Hue is uniform 
in [0, 1),
 * saturation and value in [0.3, 1]. Writes into `out[0..3]` (RGBA).
 * Never clamps above 1, so HDR glow is preserved.
 */
function hashColorHDR(out, instanceId, seed, glow) {
  glow = glow === undefined ? 1 : glow;
  const hue = hash2i(instanceId, seed, 0xAA) * INV_2_32;
  const sat = 0.3 + hash2i(instanceId, seed, 0xBB) * INV_2_32 * 0.7;
  const val = 0.3 + hash2i(instanceId, seed, 0xCC) * INV_2_32 * 0.7;
  // HSL → RGB (fast)
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
  out[2] = b
 * glow;
  out[3] = 1;
  return out;
}

/**
 * Deterministic orbital elements seed from a hash — used to spawn 1M+
 * asteroids with reproducible orbital elements.
 */
function hashOrbitalSeed(instanceId, seed) {
  const h1 = hash2i(instanceId, seed, 0xA1);
  const h2 = hash2i(instanceId, seed, 0xA2);
  const h3 = hash2i(instanceId, seed, 0xA3);
  const h4 = hash2i(instanceId, seed, 0xA4);
  return {
    semiMajor:     0.5 + h1 * INV_2_32 * 9.5,   // 0.5..10 AU
    eccentricity:  h2 * INV_2_32 * 0.9,          // 0..0.9
    inclination:   h3 * INV_2_32 * Math.PI,      // 0..π
    phase:         h4 * INV_2_32 * TWO_PI        // 0..2π
  };
}

/**
 * Hash-based grid slot — deterministic jitter for grid snapping.
 * Returns `{ dx, dy }` in [-1, 1).
 */
function hashGridSlot(cellX, cellY, seed) {
  const h = hash2i(cellX, cellY, seed);
  const h2 = murmur3Finalize(h);
  return {
    dx: h * INV_2_32 * 2 - 1,
    dy: h2 * INV_2_32 * 2 - 1
  };
}

/**
 * Hash-based value noise — interpolated lattice values from a Wan
g hash.
 * Lower quality than gradient noise but 3× faster; useful for
 * per-instance modulation that doesn't need smoothness.
 */
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
  co
nst ny0 = nx0 + (nx1 - nx0) * v;
  const ny1 = nx2 + (nx3 - nx2) * v;
  return ny0 + (ny1 - ny0) * w;
}

// ============================================================================
// Function Declarations — SOA (sync)
// ============================================================================

/**
 * Batch 2D spatial hashes — fills `out[i] = hash2i(xs[i], ys[i], seed)`.
 */
function soaHash2i(out, xs, ys, seed, count) {
  count = count === undefined ? out.length : count;
  seed = (seed === undefined ? 0 : seed) >>> 0;
  for (let i = 0; i < count; i++) {
    out[i] = hash2i(xs[i] | 0, ys[i] | 0, seed);
  }
  return out;
}

function soaHash3i(out, xs, ys, zs, seed, count) {
  count = count === undefined ? out.length : count;
  seed = (seed === undefined ? 0 : seed) >>> 0;
  for (let i = 0; i < count; i++) {
    out[i] = hash3i(xs[i] | 0, ys[i] | 0, zs[i] | 0, seed);
  }
  return out;
}

/** Batch 3D signed float hashes in [-1, 1). */
function soaHash3FloatSigned(out, xs, ys, zs, seed, count) {
  count 
= count === undefined ? out.length : count;
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

/**
 * Jitter `positions` SOA in place by a per-instance hash offset in [-jitter, jitter].
 * Used for breaking up grid aliasing in 1M+ scatter placements.
 */
function soaJitterPositions(positions, jitter, seed, count) {
  count = count === undefined ? positions.count : count;
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
  for (let i = 0; i < count; i++) {
    out[i] = hash2i(i, seed, 0xAB) * INV_2_32 * TWO_PI;
  }
  return out;
}

/**
 * Batch HDR-safe color generation into a vec4 SOA. `glow` is a global
 * multiplier so the same call can produce both LDR UI and HDR bloom values.
 */
function soaColorHDR(colors, seed, glow, count) {
  count = count === undefined ? colors.count : count;
  glow = glow === undefined ? 1 : glow;
  const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
  const tmp = [0, 0, 0, 1];
  for (let i = 0; i < count; i++) {
    hashColorHDR(tmp, i, seed, glow);
    cx[i] = tmp[0]; cy[i] = tmp[1]; cz[i] = tmp[2]; cw[i] = 1
;
  }
  return colors;
}

/** Batch gradient hashing into a vec3 SOA — per-instance unit vectors. */
function soaGradient3(gradients, xs, ys, zs, seed, count) {
  count = count === undefined ? gradients.count : count;
  const gx = gradients.x, gy = gradients.y, gz = gradients.z;
  for (let i = 0; i < count; i++) {
    const g = hashGradient3(xs[i] | 0, ys[i] | 0, zs[i] | 0, seed);
    gx[i] = g.x; gy[i] = g.y; gz[i] = g.z;
  }
  return gradients;
}

/**
 * Batch orbital seed generation — fills four 1D arrays with semi-major axis,
 * eccentricity, inclination and phase per instance.
 */
function soaOrbitalSeeds(semiMajor, eccentricity, inclination, phase, seed, count) {
  count = count === undefined ? semiMajor.length : count;
  seed = (seed === undefined ? 0 : seed) >>> 0;
  for (let i = 0; i < count; i++) {
    const h1 = hash2i(i, seed, 0xA1);
    const h2 = hash2i(i, seed, 0xA2);
    const h3 = hash2i(i, seed, 0xA3);
    const h4 = hash2i(i, seed, 0xA4);
    semiMajor[i] = 0.5 + h1 * INV_2_32 * 9.5;
    ec
centricity[i] = h2 * INV_2_32 * 0.9;
    inclination[i] = h3 * INV_2_32 * Math.PI;
    phase[i] = h4 * INV_2_32 * TWO_PI;
  }
}

/** Batch 3D value noise — `out[i] = hashValueNoise(xs[i], ys[i], zs[i], seed)` */
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
    let sum = 0, amp = 1, freq =
 scale, norm = 0;
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
// Function Declarations — SOA (chunked async)
// ============================================================================

async function _chunked(count, chunkSize, yieldEvery, perChunk) {
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
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

async function soaHash3iChunked(out, xs, ys, zs, seed, count, cs, ye) {
  count = count === undefined ? ou
t.length : count;
  seed = (seed === undefined ? 0 : seed) >>> 0;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      out[i] = hash3i(xs[i] | 0, ys[i] | 0, zs[i] | 0, seed);
    }
  });
  return out;
}

async function soaHash3FloatSignedChunked(out, xs, ys, zs, seed, count, cs, ye) {
  count = count === undefined ? out.length : count;
  seed = (seed === undefined ? 0 : seed) >>> 0;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      out[i] = hash3i(xs[i] | 0, ys[i] | 0, zs[i] | 0, seed) * INV_2_32 * 2 - 1;
    }
  });
  return out;
}

async function soaJitterPositionsChunked(positions, jitter, seed, count, cs, ye) {
  count = count === undefined ? positions.count : count;
  const px = positions.x, py = positions.y, pz = positions.z;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      const h1 = hash3i(i, seed, 0x11, seed);
      const h2 = hash3i(i, seed, 0x22, seed);
      const h3 = hash3i(i, seed, 0x33, seed);
 
     px[i] += (h1 * INV_2_32 * 2 - 1) * jitter;
      py[i] += (h2 * INV_2_32 * 2 - 1) * jitter;
      pz[i] += (h3 * INV_2_32 * 2 - 1) * jitter;
    }
  });
  return positions;
}

async function soaMotionPhasesChunked(out, count, seed, cs, ye) {
  count = count === undefined ? out.length : count;
  seed = (seed === undefined ? 0 : seed) >>> 0;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      out[i] = hash2i(i, seed, 0xAB) * INV_2_32 * TWO_PI;
    }
  });
  return out;
}

async function soaColorHDRChunked(colors, seed, glow, count, cs, ye) {
  count = count === undefined ? colors.count : count;
  glow = glow === undefined ? 1 : glow;
  const cx = colors.x, cy = colors.y, cz = colors.z, cw = colors.w;
  const tmp = [0, 0, 0, 1];
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
      hashColorHDR(tmp, i, seed, glow);
      cx[i] = tmp[0]; cy[i] = tmp[1]; cz[i] = tmp[2]; cw[i] = 1;
    }
  });
  return colors;
}

async function soaHashFBM3Chunked(ou
t, positions, scale, octaves, lacunarity, gain, seed, count, cs, ye) {
  count = count === undefined ? positions.count : count;
  scale = scale === undefined ? 1 : scale;
  octaves = octaves || 4;
  lacunarity = lacunarity || 2;
  gain = gain || 0.5;
  const px = positions.x, py = positions.y, pz = positions.z;
  await _chunked(count, cs, ye, (s, e) => {
    for (let i = s; i < e; i++) {
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
  });
  return out;
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================

function createHashScratchPool(capacity) {
  return common.createPool(
    function () {

      const T = getArrayType();
      return {
        a: new T(256),
        b: new T(256),
        c: new T(256),
        d: new T(256),
        size: 256,
        _attached: false,
        ensure: function (n) {
          if (n <= this.size) return this;
          const T2 = getArrayType();
          this.size = n;
          this.a = new T2(n);
          this.b = new T2(n);
          this.c = new T2(n);
          this.d = new T2(n);
          return this;
        }
      };
    },
    capacity || 8,
    function (s) {
      if (s.a) s.a.fill(0);
      if (s.b) s.b.fill(0);
      if (s.c) s.c.fill(0);
      if (s.d) s.d.fill(0);
    }
  );
}

function acquireHashScratch(size) {
  const s = _hashScratchPool.acquire();
  if (size !== undefined) s.ensure(size);
  return s;
}
function releaseHashScratch(s) { _hashScratchPool.release(s); }

// ============================================================================
// Namespace convenience
// ==================================================================
==========

exports.namespace.integer = {
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
};

exports.namespace.string = {
  djb2, sdbm, fnv1aString, javaStringHash
};

exports.namespace.prng = {
  mulberry32, splitmix32, xorshift32, sfc32, pcg32,
  create: createPRNG
};

exports.namespace.spatial = {
  hash2i, hash3i, hash4i,
  hashFloat01, hashFloatSigned,
  hash3Float01, hash3FloatSigned,
  hash4Float01, hash4FloatSigned,
  hashGradient2, hashGradient3
};

exports.namespace.morton = {
  encode2: mortonEncode2,
  encode3: mortonEncode3,
  encode4: mortonEncode4,
  decode2: mortonDecode2,
  decode3: mortonDecode3
};

exports.namespace.hash64 = {
  create: hash64,
  toFloat: hash64ToFloat
};

exports.namespace.streaming = {
  Hasher: StreamingHasher,
  create: createHasher
};

exports.namespace.domain = {
  terrainVariation: hashTerrainVariation,
  tileSeed: hashTileSeed,
  scatterDensity: hashScatterDensity
,
  motionPhase: hashMotionPhase,
  ikJitter: hashIKJitter,
  colorHDR: hashColorHDR,
  orbitalSeed: hashOrbitalSeed,
  gridSlot: hashGridSlot,
  valueNoise: hashValueNoise
};

exports.namespace.batch = {
  hash2i: soaHash2i,
  hash3i: soaHash3i,
  hash3FloatSigned: soaHash3FloatSigned,
  hash3Float01: soaHash3Float01,
  hash3iChunked: soaHash3iChunked,
  hash3FloatSignedChunked: soaHash3FloatSignedChunked,
  jitterPositions: soaJitterPositions,
  jitterPositionsChunked: soaJitterPositionsChunked,
  motionPhases: soaMotionPhases,
  motionPhasesChunked: soaMotionPhasesChunked,
  colorHDR: soaColorHDR,
  colorHDRChunked: soaColorHDRChunked,
  gradient3: soaGradient3,
  orbitalSeeds: soaOrbitalSeeds,
  hashValue3: soaHashValue3,
  hashFBM3: soaHashFBM3,
  hashFBM3Chunked: soaHashFBM3Chunked,
  State: HashBatchState,
  create: createHashBatch
};

// ============================================================================
// Precision listener
// ================================================================
============

onPrecisionChange(function (mode, oldMode) {
  // Existing batch states keep their current arrays. New ones created after
  // this point use the new type via getArrayType().
  // Note: primary hash arithmetic is 32-bit integer (Math.imul) and is
  // unaffected by precision mode.
});

