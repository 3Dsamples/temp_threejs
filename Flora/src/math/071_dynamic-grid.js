//File number : 071
// File : src/math/071_dynamic-grid.js
//Description : Hash-based uniform dynamic grid for 1M+ dynamic units — insert / remove / update primitives in O(1) with per-cell typed-array linked lists, plus a `rebuildFromSOA` fast path that clears and reinserts in one tight loop for per-frame fluid / particle / debris use. Supports sphere queries, AABB queries, neighbor queries, k-nearest queries, cell iteration, and a zero-GC broad-phase collision-candidate collector that pairs directly with `070_dynamic-bvh.js`. All primitive positions are stored as parallel SoA typed arrays using `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap). The grid hash uses a fixed 32-bit integer kernel (`Math.imul`) for JIT speed, open-addressing with tombstone deletion for correct O(1) removal, and all scratch memory is pooled. Chunked async variants yield via `scheduler.yield()` so 1M+ per-frame rebuilds never freeze the Android 64-bit UI thread. Auto-tunes cell size from an average query radius, and auto-grows the hash table under load.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. Every spatial query writes into a caller-provided `Uint32Array` buffer and returns only an integer count (blueprint §42 correction). The broad-phase pair collector uses the standard 13-forward-neighbor uniform-grid scheme so each candidate pair is emitted exactly once with NO dedupe bitset and NO per-primitive temporary arrays (the previous version allocated an O(n²) seen-bitset and a per-primitive `nb` array). `GridPool` uses a plain object keyed by capacity (no `Map`). Chunked async kernels inline their loops (no per-call callbacks). All allocations occur exclusively at module init / pool growth.
//Corrections : ESM imports/exports only (no require/exports). Fixed dozens of corrupted bit-shift operators (`> > >`, `< <`, `& &`) in the hash kernel; removed the forbidden `Map` from `GridPool` (now a plain object); removed the `Set` + `forEach` precision listener from `DynamicGridBatchState`; converted `querySphere` / `queryAABB` / `queryNeighbors` from JS-array `push` returns to caller-provided `Uint32Array` + integer-count returns; replaced the O(n²)-memory `_pairsSeen` dedupe bitset and per-primitive `nb` array in `collectPairs` with a zero-GC 13-forward-neighbor sweep; added open-addressing tombstone deletion so `remove` no longer corrupts probe chains; stored per-slot cell coordinates to enable neighbor lookups; inlined the `_growPrims` closure helpers; fixed the broken yield logic in `rebuildFromSOAAsync`; and removed the unused `NumericalStability` import.
//Added : Tombstone-based safe deletion, per-slot cell-coordinate storage, `collectNeighbors` (zero-GC buffer-based neighbor query), `cellOfInto`, `soaUpdateAll` / `soaUpdateAllChunked` for incremental per-frame position updates, `soaQueryAABBChunked`, and a growable shared query scratch for the SOA query batches.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — sibling files within the 54-file math topology)
// ============================================================================
import { common, getArrayType, onPrecisionChange, createVec3SOA } from './000_Math_module.js';

// ============================================================================
// Variable Declarations — constants and module scratch (init-time only)
// ============================================================================
const DEFAULT_CELL_SIZE   = 1;
const DEFAULT_LOAD_FACTOR = 0.7;
const MIN_HASH_CAP        = 16;

// Cell hash multipliers (same as 066_hash-functions for consistency).
const HX = 0x1B873593 | 0;
const HY = 0xCC9E2D51 | 0;
const HZ = 0x85EBCA77 | 0;

const EPSILON = 1e-9;

// Hash slot states.
const SLOT_EMPTY = 0;
const SLOT_USED  = 1;
const SLOT_TOMB  = 2;

// The 13 forward-neighbor offsets used by the broad-phase pair collector.
// Combined with same-cell pairs, this emits every unordered neighbor pair
// exactly once without any dedupe structure.
const FWD_NEIGHBOR_OFFSETS = new Int32Array([
     1,  0,  0,
     1,  1,  0,
     1, -1,  0,
     1,  0,  1,
     1,  0, -1,
     1,  1,  1,
     1,  1, -1,
     1, -1,  1,
     1, -1, -1,
     0,  1,  0,
     0,  1,  1,
     0,  1, -1,
     0,  0,  1
]);
const FWD_NEIGHBOR_COUNT = 13;

// Growable shared scratch for SOA query batches (amortized zero-GC).
let _qTmp = null, _qTmpCap = 0;
function _ensureQTmp(n) {
    if (n > _qTmpCap) { _qTmp = new Uint32Array(n); _qTmpCap = n; }
    return _qTmp;
}

// ============================================================================
// Class Declarations — DynamicGrid
// ============================================================================
/**
 * DynamicGrid — uniform hash grid with per-cell linked lists.
 * Storage model (all SoA):
 *   primX/Y/Z     : float arrays holding primitive positions
 *   primNext      : Int32Array, linked-list pointer per prim (-1 = end)
 *   primActive    : Uint8Array, 1 = inserted
 *   primCellHash  : Int32Array, cached cell hash per prim (for O(1) remove)
 *   hashKey       : Int32Array, per-slot cell hash
 *   hashValue     : Int32Array, per-slot head prim id (-1 = empty)
 *   hashState     : Uint8Array, per-slot state (empty/used/tombstone)
 *   hashCx/Cy/Cz  : Int32Array, per-slot cell coordinates
 * Hot paths are O(1) for insert/remove, O(k + m) for range queries
 * (k = prims in queried cells, m = cells in range).
 * Use `rebuildFromSOA` for fluids / particles where every prim moves each
 * frame — it is a clear + insertMany in one tight loop.
 */
class DynamicGrid {
    constructor(maxPrims, options) {
        options = options || {};
        maxPrims = maxPrims || 1024;

        this.cellSize    = options.cellSize !== undefined ? options.cellSize : DEFAULT_CELL_SIZE;
        this.invCellSize = 1 / this.cellSize;
        this.loadFactor  = options.loadFactor !== undefined ? options.loadFactor : DEFAULT_LOAD_FACTOR;

        const T = getArrayType();
        this.maxPrims     = maxPrims;
        this.primX        = new T(maxPrims);
        this.primY        = new T(maxPrims);
        this.primZ        = new T(maxPrims);
        this.primNext     = new Int32Array(maxPrims).fill(-1);
        this.primActive   = new Uint8Array(maxPrims);
        this.primCellHash = new Int32Array(maxPrims);
        this.primCount    = 0;

        let cap = MIN_HASH_CAP;
        const target = Math.max(MIN_HASH_CAP, Math.ceil((maxPrims * 2) / this.loadFactor));
        while (cap < target) cap <<= 1;
        this.hashCap   = cap;
        this.hashMask  = cap - 1;
        this.hashKey   = new Int32Array(cap);
        this.hashValue = new Int32Array(cap).fill(-1);
        this.hashState = new Uint8Array(cap);
        this.hashCx    = new Int32Array(cap);
        this.hashCy    = new Int32Array(cap);
        this.hashCz    = new Int32Array(cap);
        this.hashUsed  = 0;   // occupied cells
        this.hashFilled = 0;  // occupied + tombstones (drives growth)
    }

    // --------------------------------------------------------------
    // Hash
    // --------------------------------------------------------------
    _hash(cx, cy, cz) {
        let h = (Math.imul(cx | 0, HX) ^ 0x9E3779B9) >>> 0;
        h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(cy | 0, HY)) >>> 0;
        h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35) + Math.imul(cz | 0, HZ)) >>> 0;
        h = (h ^ (h >>> 16)) >>> 0;
        return h || 1; // never 0 (0 is the empty sentinel)
    }

    _findSlotRead(h) {
        let i = h & this.hashMask;
        while (true) {
            const st = this.hashState[i];
            if (st === SLOT_EMPTY) return -1;
            if (st === SLOT_USED && this.hashKey[i] === h) return i;
            i = (i + 1) & this.hashMask;
        }
    }

    _findSlotWrite(h) {
        let i = h & this.hashMask;
        let firstTomb = -1;
        while (true) {
            const st = this.hashState[i];
            if (st === SLOT_EMPTY) return firstTomb !== -1 ? firstTomb : i;
            if (st === SLOT_TOMB && firstTomb === -1) firstTomb = i;
            else if (st === SLOT_USED && this.hashKey[i] === h) return i;
            i = (i + 1) & this.hashMask;
        }
    }

    _growHash(newCap) {
        const oldKey = this.hashKey, oldValue = this.hashValue, oldState = this.hashState;
        const oldCx = this.hashCx, oldCy = this.hashCy, oldCz = this.hashCz;
        const oldCap = this.hashCap;
        this.hashCap   = newCap;
        this.hashMask  = newCap - 1;
        this.hashKey   = new Int32Array(newCap);
        this.hashValue = new Int32Array(newCap).fill(-1);
        this.hashState = new Uint8Array(newCap);
        this.hashCx    = new Int32Array(newCap);
        this.hashCy    = new Int32Array(newCap);
        this.hashCz    = new Int32Array(newCap);
        this.hashUsed  = 0;
        this.hashFilled = 0;
        for (let s = 0; s < oldCap; s++) {
            if (oldState[s] !== SLOT_USED) continue;
            const h = oldKey[s];
            const slot = this._findSlotWrite(h);
            this.hashState[slot] = SLOT_USED;
            this.hashKey[slot]   = h;
            this.hashCx[slot] = oldCx[s];
            this.hashCy[slot] = oldCy[s];
            this.hashCz[slot] = oldCz[s];
            this.hashValue[slot] = oldValue[s];
            this.hashUsed++;
            this.hashFilled++;
        }
    }

    _growPrims(newCap) {
        if (newCap <= this.maxPrims) return;
        const T = this.primX.constructor;

        const nX = new T(newCap); nX.set(this.primX); this.primX = nX;
        const nY = new T(newCap); nY.set(this.primY); this.primY = nY;
        const nZ = new T(newCap); nZ.set(this.primZ); this.primZ = nZ;

        const nNext = new Int32Array(newCap); nNext.fill(-1); nNext.set(this.primNext);
        this.primNext = nNext;

        const nActive = new Uint8Array(newCap); nActive.set(this.primActive);
        this.primActive = nActive;

        const nHash = new Int32Array(newCap); nHash.set(this.primCellHash);
        this.primCellHash = nHash;

        this.maxPrims = newCap;
    }

    // --------------------------------------------------------------
    // Insert / remove / update
    // --------------------------------------------------------------
    insert(primId, x, y, z) {
        if (primId >= this.maxPrims) this._growPrims(primId + 1);
        if (this.primActive[primId]) this.remove(primId);

        const inv = this.invCellSize;
        const cx = Math.floor(x * inv);
        const cy = Math.floor(y * inv);
        const cz = Math.floor(z * inv);
        const h = this._hash(cx, cy, cz);

        if (this.hashFilled + 1 > this.hashCap * this.loadFactor) {
            this._growHash(this.hashCap * 2);
        }

        const slot = this._findSlotWrite(h);
        if (this.hashState[slot] === SLOT_USED && this.hashKey[slot] === h) {
            // Existing cell — prepend to linked list.
            this.primNext[primId] = this.hashValue[slot];
            this.hashValue[slot] = primId;
        } else {
            // New cell (empty or tombstone).
            if (this.hashState[slot] === SLOT_EMPTY) this.hashFilled++;
            this.hashState[slot] = SLOT_USED;
            this.hashKey[slot] = h;
            this.hashCx[slot] = cx;
            this.hashCy[slot] = cy;
            this.hashCz[slot] = cz;
            this.hashValue[slot] = primId;
            this.primNext[primId] = -1;
            this.hashUsed++;
        }

        this.primX[primId] = x;
        this.primY[primId] = y;
        this.primZ[primId] = z;
        this.primCellHash[primId] = h;
        this.primActive[primId] = 1;
        this.primCount++;
        return true;
    }

    remove(primId) {
        if (!this.primActive[primId]) return false;
        const h = this.primCellHash[primId];
        const slot = this._findSlotRead(h);
        if (slot === -1) {
            this.primActive[primId] = 0;
            this.primCellHash[primId] = 0;
            this.primCount--;
            return false;
        }
        let cur = this.hashValue[slot];
        let prev = -1;
        while (cur !== -1) {
            if (cur === primId) {
                if (prev === -1) this.hashValue[slot] = this.primNext[cur];
                else this.primNext[prev] = this.primNext[cur];
                break;
            }
            prev = cur;
            cur = this.primNext[cur];
        }
        if (this.hashValue[slot] === -1) {
            this.hashState[slot] = SLOT_TOMB;
            this.hashUsed--;
        }
        this.primActive[primId] = 0;
        this.primNext[primId] = -1;
        this.primCellHash[primId] = 0;
        this.primCount--;
        return true;
    }

    update(primId, x, y, z) {
        if (!this.primActive[primId]) return this.insert(primId, x, y, z);
        const inv = this.invCellSize;
        const cx = Math.floor(x * inv);
        const cy = Math.floor(y * inv);
        const cz = Math.floor(z * inv);
        const h = this._hash(cx, cy, cz);
        this.primX[primId] = x;
        this.primY[primId] = y;
        this.primZ[primId] = z;
        if (h === this.primCellHash[primId]) return true; // same cell
        this.remove(primId);
        return this.insert(primId, x, y, z);
    }

    insertMany(primIds, xs, ys, zs, count) {
        count = count === undefined ? primIds.length : count;
        for (let i = 0; i < count; i++) {
            this.insert(primIds[i], xs[i], ys[i], zs[i]);
        }
        return count;
    }

    clear() {
        this.hashKey.fill(0);
        this.hashValue.fill(-1);
        this.hashState.fill(SLOT_EMPTY);
        this.hashUsed = 0;
        this.hashFilled = 0;
        this.primCount = 0;
        this.primActive.fill(0);
        this.primNext.fill(-1);
        return this;
    }

    // --------------------------------------------------------------
    // Queries (write into caller buffers, return count)
    // --------------------------------------------------------------
    querySphere(px, py, pz, radius, outIds) {
        const maxOut = outIds.length;
        let count = 0;
        const inv = this.invCellSize;
        const r2 = radius * radius;
        const minCx = Math.floor((px - radius) * inv);
        const maxCx = Math.floor((px + radius) * inv);
        const minCy = Math.floor((py - radius) * inv);
        const maxCy = Math.floor((py + radius) * inv);
        const minCz = Math.floor((pz - radius) * inv);
        const maxCz = Math.floor((pz + radius) * inv);
        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                for (let cx = minCx; cx <= maxCx; cx++) {
                    const slot = this._findSlotRead(this._hash(cx, cy, cz));
                    if (slot === -1) continue;
                    let cur = this.hashValue[slot];
                    while (cur !== -1) {
                        const dx = this.primX[cur] - px;
                        const dy = this.primY[cur] - py;
                        const dz = this.primZ[cur] - pz;
                        if (dx * dx + dy * dy + dz * dz <= r2) {
                            if (count >= maxOut) return count;
                            outIds[count++] = cur;
                        }
                        cur = this.primNext[cur];
                    }
                }
            }
        }
        return count;
    }

    queryAABB(minX, minY, minZ, maxX, maxY, maxZ, outIds) {
        const maxOut = outIds.length;
        let count = 0;
        const inv = this.invCellSize;
        const minCx = Math.floor(minX * inv);
        const maxCx = Math.floor(maxX * inv);
        const minCy = Math.floor(minY * inv);
        const maxCy = Math.floor(maxY * inv);
        const minCz = Math.floor(minZ * inv);
        const maxCz = Math.floor(maxZ * inv);
        for (let cz = minCz; cz <= maxCz; cz++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                for (let cx = minCx; cx <= maxCx; cx++) {
                    const slot = this._findSlotRead(this._hash(cx, cy, cz));
                    if (slot === -1) continue;
                    let cur = this.hashValue[slot];
                    while (cur !== -1) {
                        const x = this.primX[cur];
                        const y = this.primY[cur];
                        const z = this.primZ[cur];
                        if (x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ) {
                            if (count >= maxOut) return count;
                            outIds[count++] = cur;
                        }
                        cur = this.primNext[cur];
                    }
                }
            }
        }
        return count;
    }

    queryNeighbors(px, py, pz, selfId, outIds) {
        const maxOut = outIds.length;
        let count = 0;
        const inv = this.invCellSize;
        const cx = Math.floor(px * inv);
        const cy = Math.floor(py * inv);
        const cz = Math.floor(pz * inv);
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const slot = this._findSlotRead(this._hash(cx + dx, cy + dy, cz + dz));
                    if (slot === -1) continue;
                    let cur = this.hashValue[slot];
                    while (cur !== -1) {
                        if (cur !== selfId) {
                            if (count >= maxOut) return count;
                            outIds[count++] = cur;
                        }
                        cur = this.primNext[cur];
                    }
                }
            }
        }
        return count;
    }

    /** Zero-GC neighbor collection around an existing primitive. */
    collectNeighbors(selfId, outIds) {
        if (!this.primActive[selfId]) return 0;
        return this.queryNeighbors(this.primX[selfId], this.primY[selfId], this.primZ[selfId], selfId, outIds);
    }

    /**
     * Callback-based neighbor iteration (convenience API). Prefer
     * `collectNeighbors` in hot loops to avoid a caller closure.
     */
    forEachNeighbor(selfId, fn) {
        if (!this.primActive[selfId]) return 0;
        const px = this.primX[selfId];
        const py = this.primY[selfId];
        const pz = this.primZ[selfId];
        const inv = this.invCellSize;
        const cx = Math.floor(px * inv);
        const cy = Math.floor(py * inv);
        const cz = Math.floor(pz * inv);
        let count = 0;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const slot = this._findSlotRead(this._hash(cx + dx, cy + dy, cz + dz));
                    if (slot === -1) continue;
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
     * k-nearest neighbors — writes ids into outIds and squared distances into
     * outDists, returns the number written. Uses expanding cell rings.
     */
    kNearest(px, py, pz, k, outIds, outDists) {
        let bestCount = 0;
        const inv = this.invCellSize;
        const cx = Math.floor(px * inv);
        const cy = Math.floor(py * inv);
        const cz = Math.floor(pz * inv);
        const maxRing = 8;
        for (let ring = 0; ring <= maxRing; ring++) {
            for (let dz = -ring; dz <= ring; dz++) {
                for (let dy = -ring; dy <= ring; dy++) {
                    for (let dx = -ring; dx <= ring; dx++) {
                        if (ring > 0 &&
                            Math.abs(dx) !== ring &&
                            Math.abs(dy) !== ring &&
                            Math.abs(dz) !== ring) continue;
                        const slot = this._findSlotRead(this._hash(cx + dx, cy + dy, cz + dz));
                        if (slot === -1) continue;
                        let cur = this.hashValue[slot];
                        while (cur !== -1) {
                            const ddx = this.primX[cur] - px;
                            const ddy = this.primY[cur] - py;
                            const ddz = this.primZ[cur] - pz;
                            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                            if (bestCount < k) {
                                outIds[bestCount] = cur;
                                outDists[bestCount] = d2;
                                bestCount++;
                            } else {
                                let worstIdx = 0, worstDist = outDists[0];
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
        if (bestCount > 1) {
            for (let i = 1; i < bestCount; i++) {
                const di = outDists[i], ii = outIds[i];
                let j = i - 1;
                while (j >= 0 && outDists[j] > di) {
                    outDists[j + 1] = outDists[j];
                    outIds[j + 1] = outIds[j];
                    j--;
                }
                outDists[j + 1] = di;
                outIds[j + 1] = ii;
            }
        }
        return bestCount;
    }

    /** Callback-based occupied-cell iteration (convenience API). */
    forEachCell(fn) {
        for (let slot = 0; slot < this.hashCap; slot++) {
            if (this.hashState[slot] !== SLOT_USED) continue;
            const h = this.hashKey[slot];
            let cur = this.hashValue[slot];
            while (cur !== -1) {
                fn(cur, h);
                cur = this.primNext[cur];
            }
        }
    }

    /**
     * Broad-phase collision candidate pairs. Uses the 13-forward-neighbor
     * scheme so every unordered pair is emitted exactly once with no dedupe
     * bitset and no temporary arrays. Writes flat [a,b,a,b,...] into
     * `outPairs` and returns the pair count.
     */
    collectPairs(outPairs, maxPairs) {
        const maxPairCount = maxPairs === undefined ? (outPairs.length >> 1) : maxPairs;
        let pairCount = 0;
        for (let slot = 0; slot < this.hashCap && pairCount < maxPairCount; slot++) {
            if (this.hashState[slot] !== SLOT_USED) continue;
            const cx = this.hashCx[slot], cy = this.hashCy[slot], cz = this.hashCz[slot];
            // Same-cell pairs.
            let a = this.hashValue[slot];
            while (a !== -1 && pairCount < maxPairCount) {
                let b = this.primNext[a];
                while (b !== -1 && pairCount < maxPairCount) {
                    outPairs[pairCount * 2] = a;
                    outPairs[pairCount * 2 + 1] = b;
                    pairCount++;
                    b = this.primNext[b];
                }
                a = this.primNext[a];
            }
            // Forward-neighbor cell pairs.
            for (let f = 0; f < FWD_NEIGHBOR_COUNT && pairCount < maxPairCount; f++) {
                const ox = FWD_NEIGHBOR_OFFSETS[f * 3];
                const oy = FWD_NEIGHBOR_OFFSETS[f * 3 + 1];
                const oz = FWD_NEIGHBOR_OFFSETS[f * 3 + 2];
                const nslot = this._findSlotRead(this._hash(cx + ox, cy + oy, cz + oz));
                if (nslot === -1) continue;
                let p = this.hashValue[slot];
                while (p !== -1 && pairCount < maxPairCount) {
                    let q = this.hashValue[nslot];
                    while (q !== -1 && pairCount < maxPairCount) {
                        outPairs[pairCount * 2] = p;
                        outPairs[pairCount * 2 + 1] = q;
                        pairCount++;
                        q = this.primNext[q];
                    }
                    p = this.primNext[p];
                }
            }
        }
        return pairCount;
    }

    // --------------------------------------------------------------
    // Rebuild (fluids / particles — rebuild every frame)
    // --------------------------------------------------------------
    rebuildFromSOA(positions, count) {
        count = count === undefined ? positions.count : count;
        this.clear();
        const px = positions.x, py = positions.y, pz = positions.z;
        for (let i = 0; i < count; i++) this.insert(i, px[i], py[i], pz[i]);
        return this;
    }

    async rebuildFromSOAAsync(positions, count, options) {
        options = options || {};
        const chunkSize  = options.chunkSize  || common.CHUNK_SIZE;
        const yieldEvery = options.yieldEvery || common.CHUNK_YIELD_EVERY;
        count = count === undefined ? positions.count : count;
        this.clear();
        const px = positions.x, py = positions.y, pz = positions.z;
        let start = 0, c = 0;
        while (start < count) {
            const end = Math.min(start + chunkSize, count);
            for (let i = start; i < end; i++) this.insert(i, px[i], py[i], pz[i]);
            start = end;
            if (start >= count) break;
            if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
        }
        return this;
    }

    rebuildFromArrays(xs, ys, zs, count) {
        this.clear();
        for (let i = 0; i < count; i++) this.insert(i, xs[i], ys[i], zs[i]);
        return this;
    }

    // --------------------------------------------------------------
    // Stats
    // --------------------------------------------------------------
    stats() {
        let maxCell = 0, sumCell = 0, occupied = 0;
        for (let slot = 0; slot < this.hashCap; slot++) {
            if (this.hashState[slot] !== SLOT_USED) continue;
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
            load:        this.hashCap > 0 ? this.hashFilled / this.hashCap : 0
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

function querySphere(grid, px, py, pz, radius, outIds) {
    return grid.querySphere(px, py, pz, radius, outIds);
}
function queryAABB(grid, minX, minY, minZ, maxX, maxY, maxZ, outIds) {
    return grid.queryAABB(minX, minY, minZ, maxX, maxY, maxZ, outIds);
}
function queryNeighbors(grid, px, py, pz, selfId, outIds) {
    return grid.queryNeighbors(px, py, pz, selfId, outIds);
}
function collectNeighbors(grid, selfId, outIds) {
    return grid.collectNeighbors(selfId, outIds);
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
/** Free-function cell hash from integer cell coords (same kernel as grid). */
function cellHash(cx, cy, cz) {
    let h = (Math.imul(cx | 0, HX) ^ 0x9E3779B9) >>> 0;
    h = (Math.imul(h ^ (h >>> 16), 0x85EBCA6B) + Math.imul(cy | 0, HY)) >>> 0;
    h = (Math.imul(h ^ (h >>> 13), 0xC2B2AE35) + Math.imul(cz | 0, HZ)) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h || 1;
}

/** Cell coordinates into `out[0..2]` (zero-GC). */
function cellOfInto(out, x, y, z, cellSize) {
    const inv = 1 / cellSize;
    out[0] = Math.floor(x * inv);
    out[1] = Math.floor(y * inv);
    out[2] = Math.floor(z * inv);
    return out;
}

/** Convenience object-returning version (analysis-time). */
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
 * cellSize = 2 × averageQueryRadius.
 */
function suggestCellSize(avgQueryRadius) {
    return avgQueryRadius * 2;
}

/** Resize the underlying hash table to a larger power-of-2 capacity. */
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
/** Batch insert from a vec3 SOA. Each prim is inserted with id = its index. */
function soaInsertAll(grid, positions, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) grid.insert(i, px[i], py[i], pz[i]);
    return count;
}

/** Batch in-place update from a vec3 SOA (id = index). */
function soaUpdateAll(grid, positions, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) grid.update(i, px[i], py[i], pz[i]);
    return count;
}

/**
 * Batch sphere queries — one query per element of `queries` SOA. Writes the
 * hit count per query into `outCounts` and, if `outIds` is provided, the ids
 * sequentially with `outStride` per query.
 */
function soaQuerySphere(grid, queries, radii, outCounts, outIds, outStride) {
    const n = queries.count;
    const qx = queries.x, qy = queries.y, qz = queries.z;
    const tmp = _ensureQTmp(outStride);
    for (let i = 0; i < n; i++) {
        const count = grid.querySphere(qx[i], qy[i], qz[i], radii[i], tmp);
        outCounts[i] = count;
        if (outIds) {
            const base = i * outStride;
            const lim = count < outStride ? count : outStride;
            for (let k = 0; k < lim; k++) outIds[base + k] = tmp[k];
        }
    }
    return outCounts;
}

/** Batch AABB queries — same shape as `soaQuerySphere`. */
function soaQueryAABB(grid, queries, outCounts, outIds, outStride) {
    const n = queries.count;
    const qminX = queries.minX, qminY = queries.minY, qminZ = queries.minZ;
    const qmaxX = queries.maxX, qmaxY = queries.maxY, qmaxZ = queries.maxZ;
    const tmp = _ensureQTmp(outStride);
    for (let i = 0; i < n; i++) {
        const count = grid.queryAABB(qminX[i], qminY[i], qminZ[i], qmaxX[i], qmaxY[i], qmaxZ[i], tmp);
        outCounts[i] = count;
        if (outIds) {
            const base = i * outStride;
            const lim = count < outStride ? count : outStride;
            for (let k = 0; k < lim; k++) outIds[base + k] = tmp[k];
        }
    }
    return outCounts;
}

/** Batch pair collection (broad phase). Returns pair count. */
function soaCollectPairs(grid, outPairs, maxPairs) {
    return grid.collectPairs(outPairs, maxPairs);
}

/** Alias — `soaBroadPhase` == `soaCollectPairs`. */
function soaBroadPhase(grid, outPairs, maxPairs) {
    return grid.collectPairs(outPairs, maxPairs);
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
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

async function soaUpdateAllChunked(grid, positions, count, chunkSize, yieldEvery) {
    count = count === undefined ? positions.count : count;
    chunkSize  = chunkSize  || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const px = positions.x, py = positions.y, pz = positions.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) grid.update(i, px[i], py[i], pz[i]);
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
    const tmp = _ensureQTmp(outStride);
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) {
            const count = grid.querySphere(qx[i], qy[i], qz[i], radii[i], tmp);
            outCounts[i] = count;
            if (outIds) {
                const base = i * outStride;
                const lim = count < outStride ? count : outStride;
                for (let k = 0; k < lim; k++) outIds[base + k] = tmp[k];
            }
        }
        start = end;
        if (start >= n) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outCounts;
}

async function soaQueryAABBChunked(grid, queries, outCounts, outIds, outStride, chunkSize, yieldEvery) {
    const n = queries.count;
    chunkSize  = chunkSize  || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const qminX = queries.minX, qminY = queries.minY, qminZ = queries.minZ;
    const qmaxX = queries.maxX, qmaxY = queries.maxY, qmaxZ = queries.maxZ;
    const tmp = _ensureQTmp(outStride);
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) {
            const count = grid.queryAABB(qminX[i], qminY[i], qminZ[i], qmaxX[i], qmaxY[i], qmaxZ[i], tmp);
            outCounts[i] = count;
            if (outIds) {
                const base = i * outStride;
                const lim = count < outStride ? count : outStride;
                for (let k = 0; k < lim; k++) outIds[base + k] = tmp[k];
            }
        }
        start = end;
        if (start >= n) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outCounts;
}

async function soaCollectPairsChunked(grid, outPairs, maxPairs, chunkSize, yieldEvery) {
    // Pair collection is a single O(occupied cells) sweep; yield around it.
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
const _gridPoolByCapacity = Object.create(null);

/**
 * GridPool — pooled DynamicGrid instances keyed by capacity. When you release
 * a grid, its typed arrays are preserved so the next acquire of a similar
 * size reuses them without allocation. Uses a plain object (no Map).
 */
class GridPool {
    static acquire(maxPrims, options) {
        const bucket = _gridPoolByCapacity[maxPrims];
        if (bucket && bucket.length > 0) return bucket.pop();
        return new DynamicGrid(maxPrims, options);
    }
    static release(grid) {
        if (!grid) return;
        grid.clear();
        const key = grid.maxPrims;
        let bucket = _gridPoolByCapacity[key];
        if (!bucket) { bucket = []; _gridPoolByCapacity[key] = bucket; }
        if (bucket.length < 4) bucket.push(grid);
    }
}

function acquireDynamicGrid(maxPrims, options) {
    return GridPool.acquire(maxPrims, options);
}
function releaseDynamicGrid(grid) {
    GridPool.release(grid);
}

// ============================================================================
// Class Declarations — Batch state
// ============================================================================
/**
 * DynamicGridBatchState — per-frame state for 1M+ unit rebuild pipelines.
 * Holds a grid, a vec3 SOA, and query/result buffers.
 */
class DynamicGridBatchState {
    constructor(count, options) {
        this.count     = count;
        this.grid      = new DynamicGrid(count, options);
        this.positions = createVec3SOA(count);
        this.queryBuf  = new Uint32Array(count);
        this.pairBuf   = new Uint32Array(count * 2);
        this.pairCount = 0;
    }
    rebuild() {
        this.grid.rebuildFromSOA(this.positions, this.count);
        return this;
    }
    async rebuildChunked(cs, ye) {
        return this.grid.rebuildFromSOAAsync(this.positions, this.count, { chunkSize: cs, yieldEvery: ye });
    }
    updateAll() {
        return soaUpdateAll(this.grid, this.positions, this.count);
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
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    core: {
        DynamicGrid,
        createDynamicGrid,
        insert, remove, update, insertMany, clear
    },
    query: {
        querySphere, queryAABB, queryNeighbors, collectNeighbors,
        forEachNeighbor, kNearest, forEachCell, collectPairs
    },
    rebuild: {
        fromSOA: rebuildFromSOA,
        fromSOAAsync: rebuildFromSOAAsync,
        fromArrays: rebuildFromArrays
    },
    util: {
        cellHash, cellOf, cellOfInto, suggestCellSize, stats, resizeHash
    },
    pool: {
        GridPool, acquireDynamicGrid, releaseDynamicGrid
    },
    batch: {
        State: DynamicGridBatchState,
        create: createDynamicGridBatch,
        insertAll: soaInsertAll,
        insertAllChunked: soaInsertAllChunked,
        updateAll: soaUpdateAll,
        updateAllChunked: soaUpdateAllChunked,
        querySphere: soaQuerySphere,
        querySphereChunked: soaQuerySphereChunked,
        queryAABB: soaQueryAABB,
        queryAABBChunked: soaQueryAABBChunked,
        collectPairs: soaCollectPairs,
        collectPairsChunked: soaCollectPairsChunked,
        broadPhase: soaBroadPhase,
        rebuildChunked: soaRebuildChunked
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing DynamicGrid instances keep their current buffer types; new grids
// created after a precision change use the live array type.
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Core classes
    DynamicGrid,
    createDynamicGrid,
    // Insert / remove / update
    insert, remove, update, insertMany, clear,
    // Queries
    querySphere, queryAABB, queryNeighbors, collectNeighbors,
    forEachNeighbor, kNearest, forEachCell, collectPairs,
    // Rebuild
    rebuildFromSOA, rebuildFromSOAAsync, rebuildFromArrays,
    // Utilities
    cellHash, cellOf, cellOfInto, suggestCellSize, stats, resizeHash,
    // SOA (sync)
    soaInsertAll, soaUpdateAll,
    soaQuerySphere, soaQueryAABB, soaCollectPairs, soaBroadPhase,
    // SOA (chunked async)
    soaInsertAllChunked, soaUpdateAllChunked,
    soaQuerySphereChunked, soaQueryAABBChunked,
    soaCollectPairsChunked, soaRebuildChunked,
    // Pools
    GridPool, acquireDynamicGrid, releaseDynamicGrid,
    // Batch
    DynamicGridBatchState, createDynamicGridBatch,
    // Namespaces
    namespace
};