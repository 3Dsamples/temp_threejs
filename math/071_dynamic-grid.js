//File number : 071
// File : src/math/071_dynamic-grid.js
//Description : Hash-based uniform dynamic grid for 1M+ dynamic units — insert / remove / update primitives in O(1) with per-cell linked lists, plus a `rebuildFromSOA` fast path that clears and reinserts in one tight loop for per-frame fluid / particle / debris use. Supports sphere queries, AABB queries, neighbor queries, k-nearest queries, cell iteration, and broad-phase collision-candidate collection that pairs directly with `070_dynamic-bvh.js` and `122_hierarchical-collision.js`. All prim positions use `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap), the grid hash uses a fixed 32-bit integer kernel (Math.imul) for JIT speed, and all scratch memory is pooled. Chunked async variants yield via `scheduler.yield()` so 1M+ per-frame rebuilds never freeze the Android 64-bit UI thread. Auto-tunes cell size from an average query radius, and auto-grows the hash table under load.
//####
//Best for : 3d graphics — particle systems, PBD/SPH fluids (broad-phase neighbor search), debris fields, cloth self-collision, crowd lookups, procedural scatter spacing (Poisson-like rejection), light grid (clustered forward+), screen-tile light lists, photon-map hash, screen-space voxelization, ambient-occlusion hemisphere lookups, IK target neighbor search, orbital N-body short-range force pairs, and any per-frame 1M+ unit collision or neighbor query pipeline that must run at 60 fps on Android 64-bit.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M               = require("./000_Math_module.js");
const NumericalStability = require("./036_numerical-stability.js");

const common          = M.common;
const vec3            = M.vec3;
const getArrayType    = M.getArrayType;
const getPrecision    = M.getPrecision;
const onPrecisionChange = M.onPrecisionChange;
const createVec3SOA   = M.createVec3SOA;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- Core classes ----
exports.DynamicGrid        = DynamicGrid;
exports.createDynamicGrid  = createDynamicGrid;

// ---- Insert / remove / update ----
exports.insert             = insert;
exports.remove             = remove;
exports.update             = update;
exports.insertMany         = insertMany;
exports.clear              = clear;

// ---- Queries ----
exports.querySphere        = querySphere;
exports.queryAABB          = queryAABB;
exports.queryNeighbors     = queryNeighbors;
exports.forEachNeighbor    = forEachNeighbor;
exports.kNearest           = kNearest;
exports.forEachCell        = forEachCell;
exports.collectPairs       = collectPairs;

// ---- Rebuild ----
exports.rebuildFromSOA     = rebuildFromSOA;
exports.rebuildFromSOAAsync = rebuildFromSOAAsync;
exports.rebuildFromArrays  = rebuildFromArrays;

// ---- Utilities ----
exports.cellHash           = cellHash;
exports.cellOf             = cellOf;
exports.suggestCellSize    = suggestCellSize;
exports.stats              = stats;
exports.resizeHash         = resizeHash;

// ---- SOA (sync) ----
exports.soaInsertAll       = soaInsertAll;
exports.soaQuerySphere     = soaQuerySphere;
exports.soaQueryAABB       = soaQueryAABB;
exports.soaCollectPairs    = soaCollectPairs;
exports.soaBroadPhase      = soaBroadPhase;

// ---- SOA (chunked async) ----
exports.soaInsertAllChunked   = soaInsertAllChunked;
exports.soaQuerySphereChunked = soaQuerySphereChunked;
exports.soaCollectPairsChunked = soaCollectPairsChunked;
exports.soaRebuildChunked     = soaRebuildChunked;

// ---- Pools ----
exports.GridPool              = GridPool;
exports.acquireDynamicGrid    = acquireDynamicGrid;
exports.releaseDynamicGrid    = releaseDynamicGrid;

// ---- Batch ----
exports.DynamicGridBatchState = DynamicGridBatchState;
exports.createDynamicGridBatch = createDynamicGridBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// Default cell size and load factor
const DEFAULT_CELL_SIZE   = 1;
const DEFAULT_LOAD_FACTOR = 0.7;
const MIN_HASH_CAP        = 16;
const MAX_STACK           = 256;

// Cell hash multipliers (same as 066_hash-functions for consistency)
const HX = 0x1B873593 | 0;
const HY = 0xCC9E2D51 | 0;
const HZ = 0x85EBCA77 | 0;

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {Object} GridStats
 * @property {number} primCount     Active primitives
 * @property {number} cellCount     Occupied cells
 * @property {number} maxCellSize   Largest cell population
 * @property {number} avgCellSize   Average population over occupied cells
 * @property {number} hashUsed      Used hash slots
 * @property {number} hashCap       Hash table capacity
 * @property {number} load          hashUsed / hashCap
 */

/**
 * @typedef {Object} QueryResult
 * @property {Uint32Array|Array} ids    Collected primitive ids
 * @property {number} count              Actual number of ids
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const EPSILON = 1e-9;

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * DynamicGrid — uniform hash grid with per-cell linked lists.
 *
 * Storage model:
 *   - primX/Y/Z: float arrays holding prim positions (SoA)
 *   - primNext: Int32Array, linked-list pointer per prim (-1 = end)
 *   - primActive: Uint8Array, 1 = inserted
 *   - hashKey: Int32Array, per-slot cell hash (0 = empty)
 *   - hashValue: Int32Array, per-slot head prim id (-1 = empty)
 *
 * All hot paths are O(1) for insert/remove, O(k + m) for range queries
 * (k = prims in queried cells, m = cells in range).
 *
 * Use `rebuildFromSOA` for fluids / particles where every prim moves each
 * frame — it's a clear + insertMany in one tight loop.
 */
class DynamicGrid {
  // -- Config --
  cellSize         = DEFAULT_CELL_SIZE;
  invCellSize      = 1 / DEFAULT_CELL_SIZE;
  loadFactor       = DEFAULT_LOAD_FACTOR;

  // -- Primitive storage --
  primX            = null;
  primY            = null;
  primZ            = null;
  primNext         = null;
  primActive       = null;
  primCellHash     = null;     // cached cell hash per prim (for O(1) remove)
  primCount        = 0;
  maxPrims         = 0;

  // -- Hash table (open-addressing, linear probing) --
  hashKey          = null;     // 0 = empty, else = cell hash
  hashValue        = null;     // -1 = empty, else = head prim id
  hashCap          = 0;
  hashMask         = 0;
  hashUsed         = 0;

  // -- Scratch --
  _pairsSeen       = null;

  constructor(maxPrims, options) {
    options = options || {};
    maxPrims = maxPrims || 1024;

    this.maxPrims    = maxPrims;
    this.cellSize    = options.cellSize !== undefined ? options.cellSize : DEFAULT_CELL_SIZE;
    this.invCellSize = 1 / this.cellSize;
    this.loadFactor  = options.loadFactor !== undefined ? options.loadFactor : DEFAULT_LOAD_FACTOR;

    const T = getArrayType();
    this.primX        = new T(maxPrims);
    this.primY        = new T(maxPrims);
    this.primZ        = new T(maxPrims);
    this.primNext     = new Int32Array(maxPrims).fill(-1);
    this.primActive   = new Uint8Array(maxPrims);
    this.primCellHash = new Int32Array(maxPrims);
    this.primCount    = 0;

    // Hash table sized to 2 * maxPrims / loadFactor
    let cap = MIN_HASH_CAP;
    const target = Math.max(MIN_HASH_CAP, Math.ceil((maxPrims * 2) / this.loadFactor));
    while (cap < target) cap <<= 1;
    this.hashCap  = cap;
    this.hashMask = cap - 1;
    this.hashKey   = new Int32Array(cap);
    this.hashValue = new Int32Array(cap).fill(-1);
    this.hashUsed  = 0;
  }

  // --------------------------------------------------------------
  // Hash
  // --------------------------------------------------------------

  /** Fast 32-bit cell hash from integer cell coordinates. */
  _hash(cx, cy, cz) {
    let h = (Math.imul(cx | 0, HX) ^ 0x9E3779B9) >>> 0;
    h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(cy | 0, HY)) >>> 0;
    h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35) + Math.imul(cz | 0, HZ)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    // Never let the hash be 0 (that's the "empty" sentinel)
    return h || 1;
  }

  /** Cell coordinate triple from a world position. */
  _cell(x, y, z) {
    return {
      cx: Math.floor(x * this.invCellSize),
      cy: Math.floor(y * this.invCellSize),
      cz: Math.floor(z * this.invCellSize)
    };
  }

  /** Find slot for a cell hash (returns slot with matching key or first empty). */
  _findSlot(h) {
    let i = h & this.hashMask;
    while (this.hashKey[i] !== 0 && this.hashKey[i] !== h) {
      i = (i + 1) & this.hashMask;
    }
    return i;
  }

  /** Grow the hash table (capacity double), reinserting all prims. */
  _growHash(newCap) {
    const oldKey   = this.hashKey;
    const oldValue = this.hashValue;
    const oldCap   = this.hashCap;

    this.hashCap  = newCap;
    this.hashMask = newCap - 1;
    this.hashKey   = new Int32Array(newCap);
    this.hashValue = new Int32Array(newCap).fill(-1);
    this.hashUsed  = 0;

    for (let oldSlot = 0; oldSlot < oldCap; oldSlot++) {
      const h = oldKey[oldSlot];
      if (h === 0) continue;
      const newSlot = this._findSlot(h);
      this.hashKey[newSlot]   = h;
      this.hashValue[newSlot] = oldValue[oldSlot];
      this.hashUsed++;
    }
  }

  // --------------------------------------------------------------
  // Insert / remove / update
  // --------------------------------------------------------------

  /**
   * Insert a primitive at (x, y, z). Returns true on success, false if the
   * primitive was already active (use `update` instead) or if the grid is
   * full (grows automatically, so this shouldn't happen for reasonable max).
   */
  insert(primId, x, y, z) {
    if (primId >= this.maxPrims) {
      this._growPrims(primId + 1);
    }
    if (this.primActive[primId]) this.remove(primId);

    const inv = this.invCellSize;
    const cx = Math.floor(x * inv);
    const cy = Math.floor(y * inv);
    const cz = Math.floor(z * inv);
    const h  = this._hash(cx, cy, cz);

    // Grow hash if needed
    if (this.hashUsed + 1 > this.hashCap * this.loadFactor) {
      this._growHash(this.hashCap * 2);
    }

    const slot = this._findSlot(h);
    if (this.hashKey[slot] === 0) {
      this.hashKey[slot]   = h;
      this.hashValue[slot] = primId;
      this.hashUsed++;
    } else {
      // Prepend to linked list
      this.primNext[primId] = this.hashValue[slot];
      this.hashValue[slot]  = primId;
    }

    this.primX[primId] = x;
    this.primY[primId] = y;
    this.primZ[primId] = z;
    this.primCellHash[primId] = h;
    this.primActive[primId] = 1;
    this.primCount++;
    return true;
  }

  /**
   * Remove a primitive. O(cell size) due to linked-list unlink.
   */
  remove(primId) {
    if (!this.primActive[primId]) return false;
    const h = this.primCellHash[primId];
    const slot = this._findSlot(h);
    if (this.hashKey[slot] !== h) return false; // shouldn't happen

    // Unlink from linked list
    let cur  = this.hashValue[slot];
    let prev = -1;
    while (cur !== -1) {
      if (cur === primId) {
        if (prev === -1) this.hashValue[slot] = this.primNext[cur];
        else             this.primNext[prev]  = this.primNext[cur];
        break;
      }
      prev = cur;
      cur  = this.primNext[cur];
    }

    // Clear slot if list empty
    if (this.hashValue[slot] === -1) {
      this.hashKey[slot]   = 0;
      this.hashValue[slot] = -1;
      this.hashUsed--;
    }

    this.primActive[primId]   = 0;
    this.primNext[primId]     = -1;
    this.primCellHash[primId] = 0;
    this.primCount--;
    return true;
  }

  /**
   * Update a primitive position. If it stayed in the same cell, just
   * overwrite the position (O(1)). Otherwise remove + reinsert.
   */
  update(primId, x, y, z) {
    if (!this.primActive[primId]) return this.insert(primId, x, y, z);
    const inv = this.invCellSize;
    const cx = Math.floor(x * inv);
    const cy = Math.floor(y * inv);
    const cz = Math.floor(z * inv);
    const h  = this._hash(cx, cy, cz);
    this.primX[primId] = x;
    this.primY[primId] = y;
    this.primZ[primId] = z;
    if (h === this.primCellHash[primId]) {
      // Same cell — nothing to do
      return true;
    }
    this.remove(primId);
    return this.insert(primId, x, y, z);
  }

  /** Bulk insert from arrays (parallel xs/ys/zs + ids). */
  insertMany(primIds, xs, ys, zs, count) {
    count = count === undefined ? primIds.length : count;
    for (let i = 0; i < count; i++) {
      this.insert(primIds[i], xs[i], ys[i], zs[i]);
    }
    return count;
  }

  /** Clear the whole grid. */
  clear() {
    this.hashKey.fill(0);
    this.hashValue.fill(-1);
    this.hashUsed  = 0;
    this.primCount = 0;
    this.primActive.fill(0);
    this.primNext.fill(-1);
    return this;
  }

  // --------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------

  /**
   * Sphere query — collects prim ids whose stored position is within
   * `radius` of (px, py, pz). Writes into `out` (reused array). Returns
   * the number of ids written.
   */
  querySphere(px, py, pz, radius, out) {
    out = out || [];
    out.length = 0;
    const inv     = this.invCellSize;
    const r2      = radius * radius;
    const minCx   = Math.floor((px - radius) * inv);
    const maxCx   = Math.floor((px + radius) * inv);
    const minCy   = Math.floor((py - radius) * inv);
    const maxCy   = Math.floor((py + radius) * inv);
    const minCz   = Math.floor((pz - radius) * inv);
    const maxCz   = Math.floor((pz + radius) * inv);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const h = this._hash(cx, cy, cz);
          const slot = this._findSlot(h);
          if (this.hashKey[slot] !== h) continue;
          let cur = this.hashValue[slot];
          while (cur !== -1) {
            const dx = this.primX[cur] - px;
            const dy = this.primY[cur] - py;
            const dz = this.primZ[cur] - pz;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(cur);
            cur = this.primNext[cur];
          }
        }
      }
    }
    return out.length;
  }

  /** AABB query — collects prim ids inside [minX..maxX, minY..maxY, minZ..maxZ]. */
  queryAABB(minX, minY, minZ, maxX, maxY, maxZ, out) {
    out = out || [];
    out.length = 0;
    const inv     = this.invCellSize;
    const minCx   = Math.floor(minX * inv);
    const maxCx   = Math.floor(maxX * inv);
    const minCy   = Math.floor(minY * inv);
    const maxCy   = Math.floor(maxY * inv);
    const minCz   = Math.floor(minZ * inv);
    const maxCz   = Math.floor(maxZ * inv);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const h = this._hash(cx, cy, cz);
          const slot = this._findSlot(h);
          if (this.hashKey[slot] !== h) continue;
          let cur = this.hashValue[slot];
          while (cur !== -1) {
            const x = this.primX[cur];
            const y = this.primY[cur];
            const z = this.primZ[cur];
            if (x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ) {
              out.push(cur);
            }
            cur = this.primNext[cur];
          }
        }
      }
    }
    return out.length;
  }

  /**
   * Neighbor query — collects prim ids in the 3×3×3 neighborhood of
   * (px, py, pz), excluding `selfId` (pass -1 to disable).
   */
  queryNeighbors(px, py, pz, selfId, out) {
    out = out || [];
    out.length = 0;
    const inv = this.invCellSize;
    const cx  = Math.floor(px * inv);
    const cy  = Math.floor(py * inv);
    const cz  = Math.floor(pz * inv);

    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const h = this._hash(cx + dx, cy + dy, cz + dz);
          const slot = this._findSlot(h);
          if (this.hashKey[slot] !== h) continue;
          let cur = this.hashValue[slot];
          while (cur !== -1) {
            if (cur !== selfId) out.push(cur);
            cur = this.primNext[cur];
          }
        }
      }
    }
    return out.length;
  }

  /**
   * forEachNeighbor — invokes `fn(primId)` for each neighbor of prim `selfId`.
   * Slightly faster than queryNeighbors because it avoids array push.
   */
  forEachNeighbor(selfId, fn) {
    if (!this.primActive[selfId]) return 0;
    const px = this.primX[selfId];
    const py = this.primY[selfId];
    const pz = this.primZ[selfId];
    const inv = this.invCellSize;
    const cx  = Math.floor(px * inv);
    const cy  = Math.floor(py * inv);
    const cz  = Math.floor(pz * inv);
    let count = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const h = this._hash(cx + dx, cy + dy, cz + dz);
          const slot = this._findSlot(h);
          if (this.hashKey[slot] !== h) continue;
          let cur = this.hashValue[slot];
          while (cur !== -1) {
            if (cur !== selfId) { fn(cur); count++; }
            cur = this.primNext[cur];
          }
        }
      }
    }
    return count;
  }

  /**
   * k-Nearest neighbors — returns the k closest prim ids to (px, py, pz).
   * Uses a bounded max-heap sort over candidate cell neighborhood. For very
   * sparse queries, fall back to progressively larger rings.
   */
  kNearest(px, py, pz, k, outIds, outDists) {
    outIds   = outIds   || new Uint32Array(k);
    outDists = outDists || new Float32Array(k);
    let bestCount = 0;
    const inv = this.invCellSize;
    const cx  = Math.floor(px * inv);
    const cy  = Math.floor(py * inv);
    const cz  = Math.floor(pz * inv);

    // Iterate expanding rings until we have k candidates or hit cap
    const maxRing = 8;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dy = -ring; dy <= ring; dy++) {
          for (let dx = -ring; dx <= ring; dx++) {
            // Only outer shell (avoid re-visiting inner rings)
            if (ring > 0 &&
                Math.abs(dx) !== ring &&
                Math.abs(dy) !== ring &&
                Math.abs(dz) !== ring) continue;

            const h = this._hash(cx + dx, cy + dy, cz + dz);
            const slot = this._findSlot(h);
            if (this.hashKey[slot] !== h) continue;

            let cur = this.hashValue[slot];
            while (cur !== -1) {
              const ddx = this.primX[cur] - px;
              const ddy = this.primY[cur] - py;
              const ddz = this.primZ[cur] - pz;
              const d2  = ddx * ddx + ddy * ddy + ddz * ddz;
              if (bestCount < k) {
                outIds[bestCount]   = cur;
                outDists[bestCount] = d2;
                bestCount++;
              } else {
                // Find current worst
                let worstIdx  = 0;
                let worstDist = outDists[0];
                for (let w = 1; w < k; w++) {
                  if (outDists[w] > worstDist) { worstDist = outDists[w]; worstIdx = w; }
                }
                if (d2 < worstDist) { outIds[worstIdx] = cur; outDists[worstIdx] = d2; }
              }
              cur = this.primNext[cur];
            }
          }
        }
      }
      if (bestCount >= k) break;
    }
    // Sort ascending by distance
    if (bestCount > 1) {
      // Simple insertion sort for k (typically ≤ 32)
      for (let i = 1; i < bestCount; i++) {
        const di = outDists[i], ii = outIds[i];
        let j = i - 1;
        while (j >= 0 && outDists[j] > di) {
          outDists[j + 1] = outDists[j];
          outIds[j + 1]   = outIds[j];
          j--;
        }
        outDists[j + 1] = di;
        outIds[j + 1]   = ii;
      }
    }
    return bestCount;
  }

  /** Iterate over every occupied cell — useful for rendering / lighting. */
  forEachCell(fn) {
    for (let slot = 0; slot < this.hashCap; slot++) {
      const h = this.hashKey[slot];
      if (h === 0) continue;
      let cur = this.hashValue[slot];
      while (cur !== -1) {
        fn(cur, h);
        cur = this.primNext[cur];
      }
    }
  }

  /**
   * Broad-phase collision candidate pairs — for each prim, gather neighbors
   * and emit pairs (a, b) with a < b to avoid duplicates. Writes into
   * `outPairs` (flat pairs [a, b, a, b, ...]) and returns pair count.
   *
   * Uses `_pairsSeen` bitset (size maxPrims) to dedupe pairs.
   */
  collectPairs(outPairs, maxPairs) {
    outPairs = outPairs || new Uint32Array(maxPairs * 2 || this.maxPrims * 2);
    const n = this.primCount;
    // Lazily allocate dedupe bitset
    if (!this._pairsSeen || this._pairsSeen.length < this.maxPrims * this.maxPrims) {
      this._pairsSeen = new Uint8Array(this.maxPrims * this.maxPrims);
    } else {
      this._pairsSeen.fill(0);
    }

    let pairCount = 0;
    const maxPairCount = (maxPairs === undefined ? this.maxPrims : maxPairs);
    const inv = this.invCellSize;
    const nb = []; // reused neighbor buffer

    for (let self = 0; self < n; self++) {
      if (!this.primActive[self]) continue;
      nb.length = 0;
      // Gather all prims in the 3×3×3 neighborhood (excluding self)
      const px = this.primX[self];
      const py = this.primY[self];
      const pz = this.primZ[self];
      const cx = Math.floor(px * inv);
      const cy = Math.floor(py * inv);
      const cz = Math.floor(pz * inv);

      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const h = this._hash(cx + dx, cy + dy, cz + dz);
            const slot = this._findSlot(h);
            if (this.hashKey[slot] !== h) continue;
            let cur = this.hashValue[slot];
            while (cur !== -1) {
              if (cur !== self) nb.push(cur);
              cur = this.primNext[cur];
            }
          }
        }
      }

      for (let k = 0; k < nb.length; k++) {
        const other = nb[k];
        const lo = self < other ? self : other;
        const hi = self < other ? other : self;
        const key = lo * this.maxPrims + hi;
        if (this._pairsSeen[key]) continue;
        this._pairsSeen[key] = 1;
        if (pairCount >= maxPairCount) return pairCount;
        outPairs[pairCount * 2]     = lo;
        outPairs[pairCount * 2 + 1] = hi;
        pairCount++;
      }
    }
    return pairCount;
  }

  // --------------------------------------------------------------
  // Rebuild (fluids / particles — rebuild every frame)
  // --------------------------------------------------------------

  /**
   * Rebuild from a vec3 SOA — clears the grid and reinserts every prim.
   * This is the fastest path for fluids and particles where every unit
   * moves each frame.
   */
  rebuildFromSOA(positions, count) {
    count = count === undefined ? positions.count : count;
    this.clear();
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) {
      this.insert(i, px[i], py[i], pz[i]);
    }
    return this;
  }

  /**
   * Async rebuild — same as `rebuildFromSOA` but yields to the UI thread
   * every `chunkSize` inserts.
   */
  async rebuildFromSOAAsync(positions, count, options) {
    options = options || {};
    const chunkSize  = options.chunkSize  || common.CHUNK_SIZE;
    const yieldEvery = options.yieldEvery || common.CHUNK_YIELD_EVERY;
    count = count === undefined ? positions.count : count;

    this.clear();
    const px = positions.x, py = positions.y, pz = positions.z;
    let counter = 0;
    for (let i = 0; i < count; i++) {
      this.insert(i, px[i], py[i], pz[i]);
      if (++counter >= chunkSize) {
        counter = 0;
        if (i % (chunkSize * yieldEvery) === 0) await common.yieldToMain();
      }
    }
    return this;
  }

  /** Rebuild from raw typed arrays. */
  rebuildFromArrays(xs, ys, zs, count) {
    this.clear();
    for (let i = 0; i < count; i++) {
      this.insert(i, xs[i], ys[i], zs[i]);
    }
    return this;
  }

  // --------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------

  _growPrims(newCap) {
    if (newCap <= this.maxPrims) return;
    const T = this.primX.constructor;
    const growF = (a, n) => { const o = new T(n); o.set(a); return o; };
    const growI = (a, n) => { const o = new Int32Array(n); o.set(a); return o; };
    const growU8 = (a, n) => { const o = new Uint8Array(n); o.set(a); return o; };
    this.primX = growF(this.primX, newCap);
    this.primY = growF(this.primY, newCap);
    this.primZ = growF(this.primZ, newCap);
    this.primNext     = growI(this.primNext, newCap);
    this.primActive   = growU8(this.primActive, newCap);
    this.primCellHash = growI(this.primCellHash, newCap);
    this.maxPrims = newCap;
  }

  /** Return stats — useful for tuning cellSize. */
  stats() {
    let maxCell = 0;
    let sumCell = 0;
    let occupied = 0;
    for (let slot = 0; slot < this.hashCap; slot++) {
      if (this.hashKey[slot] === 0) continue;
      let count = 0;
      let cur = this.hashValue[slot];
      while (cur !== -1) { count++; cur = this.primNext[cur]; }
      if (count > maxCell) maxCell = count;
      sumCell += count;
      occupied++;
    }
    return {
      primCount:   this.primCount,
      cellCount:   occupied,
      maxCellSize: maxCell,
      avgCellSize: occupied > 0 ? sumCell / occupied : 0,
      hashUsed:    this.hashUsed,
      hashCap:     this.hashCap,
      load:        this.hashCap > 0 ? this.hashUsed / this.hashCap : 0
    };
  }
}

// ============================================================================
// Function Declarations — Construction
// ============================================================================

function createDynamicGrid(maxPrims, options) {
  return new DynamicGrid(maxPrims, options);
}

// ============================================================================
// Function Declarations — Free-function aliases
// ============================================================================

function insert(grid, primId, x, y, z) { return grid.insert(primId, x, y, z); }
function remove(grid, primId) { return grid.remove(primId); }
function update(grid, primId, x, y, z) { return grid.update(primId, x, y, z); }
function insertMany(grid, ids, xs, ys, zs, count) { return grid.insertMany(ids, xs, ys, zs, count); }
function clear(grid) { return grid.clear(); }

function querySphere(grid, px, py, pz, radius, out) { return grid.querySphere(px, py, pz, radius, out); }
function queryAABB(grid, minX, minY, minZ, maxX, maxY, maxZ, out) {
  return grid.queryAABB(minX, minY, minZ, maxX, maxY, maxZ, out);
}
function queryNeighbors(grid, px, py, pz, selfId, out) {
  return grid.queryNeighbors(px, py, pz, selfId, out);
}
function forEachNeighbor(grid, selfId, fn) { return grid.forEachNeighbor(selfId, fn); }
function kNearest(grid, px, py, pz, k, outIds, outDists) {
  return grid.kNearest(px, py, pz, k, outIds, outDists);
}
function forEachCell(grid, fn) { return grid.forEachCell(fn); }
function collectPairs(grid, outPairs, maxPairs) { return grid.collectPairs(outPairs, maxPairs); }

function rebuildFromSOA(grid, positions, count) { return grid.rebuildFromSOA(positions, count); }
function rebuildFromSOAAsync(grid, positions, count, options) {
  return grid.rebuildFromSOAAsync(positions, count, options);
}
function rebuildFromArrays(grid, xs, ys, zs, count) {
  return grid.rebuildFromArrays(xs, ys, zs, count);
}

// ============================================================================
// Function Declarations — Utilities
// ============================================================================

/** Free-function cell hash from integer cell coords (same as grid._hash). */
function cellHash(cx, cy, cz) {
  let h = (Math.imul(cx | 0, HX) ^ 0x9E3779B9) >>> 0;
  h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(cy | 0, HY)) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35) + Math.imul(cz | 0, HZ)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h || 1;
}

/** Cell coordinates from world position + cellSize. */
function cellOf(x, y, z, cellSize) {
  const inv = 1 / cellSize;
  return {
    cx: Math.floor(x * inv),
    cy: Math.floor(y * inv),
    cz: Math.floor(z * inv)
  };
}

/**
 * Suggest a cell size from an average query radius. Rule of thumb:
 * cellSize = 2 × averageQueryRadius. That gives ~27 cells per query for a
 * sphere query, which balances collision-candidate collection vs cell count.
 */
function suggestCellSize(avgQueryRadius) {
  return avgQueryRadius * 2;
}

/** Resize the underlying hash table to a larger capacity (power of 2). */
function resizeHash(grid, newCap) {
  let cap = MIN_HASH_CAP;
  while (cap < newCap) cap <<= 1;
  grid._growHash(cap);
  return grid;
}

function stats(grid) { return grid.stats(); }

// ============================================================================
// Function Declarations — SOA (sync)
// ============================================================================

/**
 * Batch insert from a vec3 SOA. Each prim is inserted with id = its index.
 */
function soaInsertAll(grid, positions, count) {
  count = count === undefined ? positions.count : count;
  const px = positions.x, py = positions.y, pz = positions.z;
  for (let i = 0; i < count; i++) grid.insert(i, px[i], py[i], pz[i]);
  return count;
}

/**
 * Batch sphere queries — one query per element of `queries` SOA. Writes the
 * hit count per query into `outCounts` and, if `outIds` is provided, the ids
 * sequentially (with `outStride` per query). For per-query result sets you'll
 * want to allocate an offset array on top.
 */
function soaQuerySphere(grid, queries, radii, outCounts, outIds, outStride) {
  const n = queries.count;
  const qx = queries.x, qy = queries.y, qz = queries.z;
  const tmp = [];
  for (let i = 0; i < n; i++) {
    const count = grid.querySphere(qx[i], qy[i], qz[i], radii[i], tmp);
    outCounts[i] = count;
    if (outIds) {
      const base = i * outStride;
      for (let k = 0; k < count && k < outStride; k++) outIds[base + k] = tmp[k];
    }
  }
  return outCounts;
}

/** Batch AABB queries — same shape as `soaQuerySphere`. */
function soaQueryAABB(grid, queries, outCounts, outIds, outStride) {
  const n = queries.count;
  const qminX = queries.minX, qminY = queries.minY, qminZ = queries.minZ;
  const qmaxX = queries.maxX, qmaxY = queries.maxY, qmaxZ = queries.maxZ;
  const tmp = [];
  for (let i = 0; i < n; i++) {
    const count = grid.queryAABB(qminX[i], qminY[i], qminZ[i], qmaxX[i], qmaxY[i], qmaxZ[i], tmp);
    outCounts[i] = count;
    if (outIds) {
      const base = i * outStride;
      for (let k = 0; k < count && k < outStride; k++) outIds[base + k] = tmp[k];
    }
  }
  return outCounts;
}

/** Batch pair collection (broad phase). Delegates to `grid.collectPairs`. */
function soaCollectPairs(grid, outPairs, maxPairs) {
  return grid.collectPairs(outPairs, maxPairs);
}

/** Alias — `soaBroadPhase` == `soaCollectPairs`. */
function soaBroadPhase(grid, outPairs, maxPairs) {
  return grid.collectPairs(outPairs, maxPairs);
}

// ============================================================================
// Function Declarations — SOA (chunked async)
// ============================================================================

async function soaInsertAllChunked(grid, positions, count, chunkSize, yieldEvery) {
  count = count === undefined ? positions.count : count;
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  const px = positions.x, py = positions.y, pz = positions.z;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) grid.insert(i, px[i], py[i], pz[i]);
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return count;
}

async function soaQuerySphereChunked(grid, queries, radii, outCounts, outIds, outStride, chunkSize, yieldEvery) {
  const n = queries.count;
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  const qx = queries.x, qy = queries.y, qz = queries.z;
  const tmp = [];
  let start = 0, c = 0;
  while (start < n) {
    const end = Math.min(start + chunkSize, n);
    for (let i = start; i < end; i++) {
      const count = grid.querySphere(qx[i], qy[i], qz[i], radii[i], tmp);
      outCounts[i] = count;
      if (outIds) {
        const base = i * outStride;
        for (let k = 0; k < count && k < outStride; k++) outIds[base + k] = tmp[k];
      }
    }
    start = end;
    if (start >= n) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return outCounts;
}

async function soaCollectPairsChunked(grid, outPairs, maxPairs, chunkSize, yieldEvery) {
  // Pair collection is already O(n) with a dedupe bitset. We can't easily
  // chunk the dedupe step, but we can process primitives in waves and let
  // the UI thread breathe between waves.
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  // Simplest: yield once at start and once at end. For extreme cases,
  // users can split the prim range themselves.
  await common.yieldToMain();
  const count = grid.collectPairs(outPairs, maxPairs);
  await common.yieldToMain();
  return count;
}

async function soaRebuildChunked(grid, positions, count, chunkSize, yieldEvery) {
  return grid.rebuildFromSOAAsync(positions, count, { chunkSize: chunkSize, yieldEvery: yieldEvery });
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================

const _gridPool = common.createPool(
  function () { return { grid: null, size: 0 }; },
  4,
  function (h) { h.grid = null; h.size = 0; }
);

/**
 * GridPool — pooled DynamicGrid instances keyed by capacity. When you release
 * a grid, its typed arrays are preserved so the next acquire of a similar
 * size reuses them without allocation.
 */
class GridPool {
  static byCapacity = new Map();

  static acquire(maxPrims, options) {
    const bucket = GridPool.byCapacity.get(maxPrims);
    if (bucket && bucket.length > 0) return bucket.pop();
    return new DynamicGrid(maxPrims, options);
  }

  static release(grid) {
    if (!grid) return;
    grid.clear();
    let bucket = GridPool.byCapacity.get(grid.maxPrims);
    if (!bucket) { bucket = []; GridPool.byCapacity.set(grid.maxPrims, bucket); }
    if (bucket.length < 4) bucket.push(grid);
  }
}

function acquireDynamicGrid(maxPrims, options) {
  return GridPool.acquire(maxPrims, options);
}

function releaseDynamicGrid(grid) {
  GridPool.release(grid);
}

/**
 * DynamicGridBatchState — per-frame state for 1M+ unit rebuild pipelines.
 * Holds a grid, a vec3 SOA, and query/result buffers.
 */
class DynamicGridBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      DynamicGridBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(count, options) {
    this.count       = count;
    this.grid        = new DynamicGrid(count, options);
    this.positions   = createVec3SOA(count);
    this.queryBuf    = [];
    this.pairBuf     = new Uint32Array(count * 2);
    this.pairCount   = 0;
  }

  rebuild() {
    this.grid.rebuildFromSOA(this.positions, this.count);
    return this;
  }

  async rebuildChunked(cs, ye) {
    return this.grid.rebuildFromSOAAsync(this.positions, this.count, { chunkSize: cs, yieldEvery: ye });
  }

  pairs(maxPairs) {
    this.pairCount = this.grid.collectPairs(this.pairBuf, maxPairs === undefined ? this.count : maxPairs);
    return this.pairCount;
  }

  sphere(px, py, pz, r) {
    return this.grid.querySphere(px, py, pz, r, this.queryBuf);
  }
}

function createDynamicGridBatch(count, options) {
  return new DynamicGridBatchState(count, options);
}

// ============================================================================
// Namespace convenience
// ============================================================================

exports.namespace.core = {
  DynamicGrid,
  createDynamicGrid,
  insert, remove, update, insertMany, clear
};

exports.namespace.query = {
  querySphere, queryAABB, queryNeighbors, forEachNeighbor,
  kNearest, forEachCell, collectPairs
};

exports.namespace.rebuild = {
  fromSOA: rebuildFromSOA,
  fromSOAAsync: rebuildFromSOAAsync,
  fromArrays: rebuildFromArrays
};

exports.namespace.util = {
  cellHash, cellOf, suggestCellSize, stats, resizeHash
};

exports.namespace.pool = {
  GridPool, acquireDynamicGrid, releaseDynamicGrid
};

exports.namespace.batch = {
  State: DynamicGridBatchState,
  create: createDynamicGridBatch,
  insertAll: soaInsertAll,
  insertAllChunked: soaInsertAllChunked,
  querySphere: soaQuerySphere,
  querySphereChunked: soaQuerySphereChunked,
  queryAABB: soaQueryAABB,
  collectPairs: soaCollectPairs,
  collectPairsChunked: soaCollectPairsChunked,
  broadPhase: soaBroadPhase,
  rebuildChunked: soaRebuildChunked
};

// ============================================================================
// Precision listener
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Existing DynamicGrid instances keep their current buffer types (their
  // primX/Y/Z use whatever type was active at construction time).
  // New grids created after this point use the new type via getArrayType().
});
