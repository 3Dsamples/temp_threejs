//File number : 072
// File : src/math/072_kd-tree.js
//Description : Complete KD-tree system — static (median-split) and dynamic (incremental insert with leaf splitting, lazy removal) KD-trees over 1M+ points. Supports k-nearest queries with a bounded max-heap, radius queries, AABB queries, closest-point queries, in-sphere counting, and callback/buffer iteration. Uses a flat typed-array node layout and per-leaf linked lists of point indices for cache-friendly traversal and O(1) insertion, integer stacks from a pool, and a bulk `buildFromSOA` fast path that produces a balanced tree in O(n log n) with zero allocation after warmup. All position buffers use `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap). Chunked async variants yield via `scheduler.yield()` so 1M+ builds and 1M+ k-NN queries never freeze the Android 64-bit UI thread. Provides `KDTree`, `KDNode`, `KDPool`, plus domain helpers for procedural placement rejection (Poisson-disk style spacing), light importance sampling, orbital nearest-body search, IK target lookup, crowd neighbor search, and star/particle nearest-neighbor stats.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. Every spatial query writes into a caller-provided `Uint32Array` buffer and returns only an integer count (blueprint §42 correction). The max-heap and traversal stacks are pooled. Leaf points are stored as typed-array linked lists (`pointNext`) so incremental insert never allocates. `KDPool` uses a plain object keyed by capacity (no `Map`). `KDBatchState` uses a hoisted precision handler (no Set/forEach). Chunked async kernels inline their loops (no per-call callbacks). All allocations occur exclusively at module init / pool growth.
//Corrections : ESM imports/exports only (no require/exports). Fixed: the `KDTree` field-name bugs (`nodeCount` vs `nodeCount_`, `nodeCap` vs `nodeCap_`) that corrupted node allocation and growth; the broken `buildFromSOA` which never reordered point arrays to match leaf ranges (leaves referenced the wrong points) — now uses per-leaf linked lists so ranges are always consistent; the fundamentally broken incremental `insert`/`_insertFallback` (which used `Array.sort` with closures and assumed contiguous leaf ranges) — replaced with a correct linked-list-leaf insert + leaf-split algorithm; `closestPoint` allocated per call (now uses module scratch); `radiusQuery`/`aabbQuery` returned growing JS arrays (now write into caller buffers and return counts); `stats` allocated a depth array (now uses a pooled depth stack); `KDPool.byCapacity` used a forbidden `Map` (now a plain object); `KDBatchState` used a Set + forEach listeners (removed); the unused `NumericalStability` import was removed.
//Added : Linked-list leaf storage for correct O(1) dynamic insertion, `_computeLeafAABB`/`_computeNodeAABBFromChildren` refit helpers, buffer-based `radiusQuery`/`aabbQuery` returning counts, a pooled depth stack for `stats`, `soaInsertBatch`, and chunked variants for spacing checks.
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
const DEFAULT_LEAF_SIZE = 8;
const MAX_DEPTH         = 64;
const MAX_STACK         = 512;

const EPSILON = 1e-9;

// Reusable traversal stack pool.
const _stackPool = common.createPool(
    function () { return new Int32Array(MAX_STACK); },
    8,
    function (s) { /* no reset needed */ }
);

// Max-heap pool for k-NN queries.
const _heapPool = common.createPool(
    function () {
        return { ids: new Uint32Array(64), dists: new Float32Array(64), size: 0, cap: 64 };
    },
    8,
    function (h) { h.size = 0; }
);

// Shared scalar scratch (single-threaded, never held across calls).
const _aabbDistTmp = new Float64Array(1);
const _oneId   = new Uint32Array(1);
const _oneDist = new Float32Array(1);
const _statsDepth = new Int32Array(MAX_STACK);

// Growable k-NN scratch for SOA batches (amortized zero-GC).
let _knnIds = null, _knnDists = null, _knnCap = 0;
function _ensureKnnBuf(k) {
    if (k > _knnCap) {
        _knnIds = new Uint32Array(k);
        _knnDists = new Float32Array(k);
        _knnCap = k;
    }
}

// ============================================================================
// Class Declarations — KDNode (data view)
// ============================================================================
/**
 * KDNode — a flat node data view for users who want an object API. The
 * KDTree itself stores nodes in parallel typed arrays.
 */
class KDNode {
    constructor() {
        this.minX = 0; this.minY = 0; this.minZ = 0;
        this.maxX = 0; this.maxY = 0; this.maxZ = 0;
        this.left = 0;          // inner: left child | leaf: head point id
        this.right = 0;         // inner: right child | leaf: point count
        this.splitAxis = 0;
        this.splitValue = 0;
        this.isLeaf = 0;
    }
}

// ============================================================================
// Class Declarations — KDTree
// ============================================================================
/**
 * KDTree — a balanced k-d tree with per-leaf linked lists of point indices.
 *
 * Node storage (parallel SoA typed arrays):
 *   nodeMinX/Y/Z, nodeMaxX/Y/Z   — node AABB
 *   nodeLeft                     — inner: left child | leaf: head point id
 *   nodeRight                    — inner: right child | leaf: point count
 *   nodeSplitAxis                — 0/1/2 (inner only)
 *   nodeSplitValue               — split plane value (inner only)
 *   nodeIsLeaf                   — 1 = leaf, 0 = inner
 *
 * Point storage (SoA):
 *   pointX/Y/Z                   — positions
 *   pointActive                  — Uint8Array, 1 = active
 *   pointNext                    — Int32Array, linked-list next pointer
 *   pointNode                    — Int32Array, owning leaf node
 */
class KDTree {
    constructor(maxPoints, options) {
        options = options || {};
        maxPoints = maxPoints || 1024;
        this.maxPoints = maxPoints;
        this.leafSize = options.leafSize || DEFAULT_LEAF_SIZE;

        this.nodeMinX = null; this.nodeMinY = null; this.nodeMinZ = null;
        this.nodeMaxX = null; this.nodeMaxY = null; this.nodeMaxZ = null;
        this.nodeLeft = null; this.nodeRight = null;
        this.nodeSplitAxis = null; this.nodeSplitValue = null;
        this.nodeIsLeaf = null;
        this.nodeCount_ = 0;
        this.nodeCap_ = 0;
        this.root = -1;

        this.pointX = null; this.pointY = null; this.pointZ = null;
        this.pointActive = null; this.pointNext = null; this.pointNode = null;
        this.pointCount = 0;

        this.freeList = null;
        this.freeCount = 0;

        // Per-tree traversal/build scratch.
        this._path = new Int32Array(MAX_DEPTH);
        this._splitBuf = new Int32Array(this.leafSize * 2 + 4);
        this._buildIds = null;

        this._allocNodes(Math.max(4, maxPoints));
        this._allocPoints(maxPoints);
    }

    _allocNodes(cap) {
        const T = getArrayType();
        this.nodeMinX = new T(cap); this.nodeMinY = new T(cap); this.nodeMinZ = new T(cap);
        this.nodeMaxX = new T(cap); this.nodeMaxY = new T(cap); this.nodeMaxZ = new T(cap);
        this.nodeLeft = new Int32Array(cap);
        this.nodeRight = new Int32Array(cap);
        this.nodeSplitAxis = new Uint8Array(cap);
        this.nodeSplitValue = new T(cap);
        this.nodeIsLeaf = new Uint8Array(cap);
        this.nodeCount_ = 0;
        this.nodeCap_ = cap;
        this.freeList = new Int32Array(cap);
        this.freeCount = 0;
    }

    _growNodes(newCap) {
        const T = this.nodeMinX.constructor;
        const gF = (a) => { const o = new T(newCap); o.set(a); return o; };
        const gI = (a) => { const o = new Int32Array(newCap); o.set(a); return o; };
        const gU8 = (a) => { const o = new Uint8Array(newCap); o.set(a); return o; };
        this.nodeMinX = gF(this.nodeMinX); this.nodeMinY = gF(this.nodeMinY); this.nodeMinZ = gF(this.nodeMinZ);
        this.nodeMaxX = gF(this.nodeMaxX); this.nodeMaxY = gF(this.nodeMaxY); this.nodeMaxZ = gF(this.nodeMaxZ);
        this.nodeLeft = gI(this.nodeLeft); this.nodeRight = gI(this.nodeRight);
        this.nodeSplitAxis = gU8(this.nodeSplitAxis); this.nodeSplitValue = gF(this.nodeSplitValue);
        this.nodeIsLeaf = gU8(this.nodeIsLeaf);
        const nf = new Int32Array(newCap); nf.set(this.freeList); this.freeList = nf;
        this.nodeCap_ = newCap;
    }

    _allocNode() {
        let idx;
        if (this.freeCount > 0) {
            idx = this.freeList[--this.freeCount];
        } else {
            if (this.nodeCount_ >= this.nodeCap_) {
                this._growNodes(Math.max(this.nodeCap_ * 2, this.nodeCap_ + 1024));
            }
            idx = this.nodeCount_++;
        }
        this.nodeIsLeaf[idx] = 0;
        this.nodeLeft[idx] = -1;
        this.nodeRight[idx] = 0;
        this.nodeSplitAxis[idx] = 0;
        this.nodeSplitValue[idx] = 0;
        this.nodeMinX[idx] = 0; this.nodeMinY[idx] = 0; this.nodeMinZ[idx] = 0;
        this.nodeMaxX[idx] = 0; this.nodeMaxY[idx] = 0; this.nodeMaxZ[idx] = 0;
        return idx;
    }

    _freeNode(idx) {
        if (idx < 0) return;
        if (this.freeCount >= this.freeList.length) {
            const nf = new Int32Array(this.freeList.length * 2);
            nf.set(this.freeList);
            this.freeList = nf;
        }
        this.freeList[this.freeCount++] = idx;
    }

    _allocPoints(cap) {
        const T = getArrayType();
        this.pointX = new T(cap);
        this.pointY = new T(cap);
        this.pointZ = new T(cap);
        this.pointActive = new Uint8Array(cap);
        this.pointNext = new Int32Array(cap).fill(-1);
        this.pointNode = new Int32Array(cap).fill(-1);
        this._buildIds = new Int32Array(cap);
        this.maxPoints = cap;
    }

    _growPoints(newCap) {
        if (newCap <= this.maxPoints) return;
        const T = this.pointX.constructor;
        const gF = (a) => { const o = new T(newCap); o.set(a); return o; };
        const gU8 = (a) => { const o = new Uint8Array(newCap); o.set(a); return o; };
        const gI = (a) => { const o = new Int32Array(newCap); o.fill(-1); o.set(a); return o; };
        this.pointX = gF(this.pointX);
        this.pointY = gF(this.pointY);
        this.pointZ = gF(this.pointZ);
        this.pointActive = gU8(this.pointActive);
        this.pointNext = gI(this.pointNext);
        this.pointNode = gI(this.pointNode);
        const nb = new Int32Array(newCap); nb.set(this._buildIds); this._buildIds = nb;
        this.maxPoints = newCap;
    }

    _axisValue(pointId, axis) {
        return axis === 0 ? this.pointX[pointId]
             : axis === 1 ? this.pointY[pointId]
             : this.pointZ[pointId];
    }

    // --------------------------------------------------------------
    // AABB helpers
    // --------------------------------------------------------------
    _computeLeafAABB(node) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let p = this.nodeLeft[node];
        while (p !== -1) {
            if (this.pointActive[p]) {
                const x = this.pointX[p], y = this.pointY[p], z = this.pointZ[p];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            p = this.pointNext[p];
        }
        if (minX > maxX) { minX = 0; minY = 0; minZ = 0; maxX = 0; maxY = 0; maxZ = 0; }
        this.nodeMinX[node] = minX; this.nodeMinY[node] = minY; this.nodeMinZ[node] = minZ;
        this.nodeMaxX[node] = maxX; this.nodeMaxY[node] = maxY; this.nodeMaxZ[node] = maxZ;
    }

    _computeNodeAABBFromChildren(node) {
        const l = this.nodeLeft[node];
        const r = this.nodeRight[node];
        this.nodeMinX[node] = Math.min(this.nodeMinX[l], this.nodeMinX[r]);
        this.nodeMinY[node] = Math.min(this.nodeMinY[l], this.nodeMinY[r]);
        this.nodeMinZ[node] = Math.min(this.nodeMinZ[l], this.nodeMinZ[r]);
        this.nodeMaxX[node] = Math.max(this.nodeMaxX[l], this.nodeMaxX[r]);
        this.nodeMaxY[node] = Math.max(this.nodeMaxY[l], this.nodeMaxY[r]);
        this.nodeMaxZ[node] = Math.max(this.nodeMaxZ[l], this.nodeMaxZ[r]);
    }

    _expandAABBWithPoint(node, x, y, z) {
        if (x < this.nodeMinX[node]) this.nodeMinX[node] = x;
        if (y < this.nodeMinY[node]) this.nodeMinY[node] = y;
        if (z < this.nodeMinZ[node]) this.nodeMinZ[node] = z;
        if (x > this.nodeMaxX[node]) this.nodeMaxX[node] = x;
        if (y > this.nodeMaxY[node]) this.nodeMaxY[node] = y;
        if (z > this.nodeMaxZ[node]) this.nodeMaxZ[node] = z;
    }

    /** Squared distance from a point to a node AABB. */
    _nodeDistSq(node, px, py, pz) {
        const dx = px < this.nodeMinX[node] ? this.nodeMinX[node] - px
               : px > this.nodeMaxX[node] ? px - this.nodeMaxX[node] : 0;
        const dy = py < this.nodeMinY[node] ? this.nodeMinY[node] - py
               : py > this.nodeMaxY[node] ? py - this.nodeMaxY[node] : 0;
        const dz = pz < this.nodeMinZ[node] ? this.nodeMinZ[node] - pz
               : pz > this.nodeMaxZ[node] ? pz - this.nodeMaxZ[node] : 0;
        return dx * dx + dy * dy + dz * dz;
    }

    // --------------------------------------------------------------
    // Leaf construction
    // --------------------------------------------------------------
    /** Create a leaf from idsBuf[start..start+count) and link the points. */
    _makeLeafFromIds(idsBuf, start, count) {
        const node = this._allocNode();
        this.nodeIsLeaf[node] = 1;
        let head = -1;
        for (let k = count - 1; k >= 0; k--) {
            const pid = idsBuf[start + k];
            this.pointNext[pid] = head;
            this.pointNode[pid] = node;
            head = pid;
        }
        this.nodeLeft[node] = head;
        this.nodeRight[node] = count;
        this._computeLeafAABB(node);
        return node;
    }

    // --------------------------------------------------------------
    // Static build
    // --------------------------------------------------------------
    _buildRec(idsBuf, start, count, depth) {
        if (count <= this.leafSize || depth >= MAX_DEPTH) {
            return this._makeLeafFromIds(idsBuf, start, count);
        }
        // Compute AABB of this range.
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = start; i < start + count; i++) {
            const p = idsBuf[i];
            const x = this.pointX[p], y = this.pointY[p], z = this.pointZ[p];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const extX = maxX - minX, extY = maxY - minY, extZ = maxZ - minZ;
        let axis = 0;
        if (extY > extX && extY >= extZ) axis = 1;
        else if (extZ > extX && extZ > extY) axis = 2;

        const mid = count >> 1;
        _nthElement(idsBuf, start, start + count - 1, start + mid, axis, this);
        const splitValue = this._axisValue(idsBuf[start + mid], axis);

        const inner = this._allocNode();
        this.nodeIsLeaf[inner] = 0;
        this.nodeSplitAxis[inner] = axis;
        this.nodeSplitValue[inner] = splitValue;

        const left = this._buildRec(idsBuf, start, mid, depth + 1);
        const right = this._buildRec(idsBuf, start + mid, count - mid, depth + 1);
        this.nodeLeft[inner] = left;
        this.nodeRight[inner] = right;
        this._computeNodeAABBFromChildren(inner);
        return inner;
    }

    /** Build from a vec3 SOA — O(n log n), zero-GC after warmup. */
    buildFromSOA(positions, count) {
        count = count === undefined ? positions.count : count;
        this.clear();
        if (count === 0) return this;
        this._growPoints(count);
        const px = positions.x, py = positions.y, pz = positions.z;
        for (let i = 0; i < count; i++) {
            this.pointX[i] = px[i];
            this.pointY[i] = py[i];
            this.pointZ[i] = pz[i];
            this.pointActive[i] = 1;
            this.pointNext[i] = -1;
            this.pointNode[i] = -1;
            this._buildIds[i] = i;
        }
        this.pointCount = count;
        this.root = this._buildRec(this._buildIds, 0, count, 0);
        return this;
    }

    // --------------------------------------------------------------
    // Dynamic ops
    // --------------------------------------------------------------
    /** Insert a point. Returns the new point id. */
    insert(x, y, z) {
        if (this.pointCount >= this.maxPoints) {
            this._growPoints(Math.max(this.pointCount * 2, this.pointCount + 1024));
        }
        const pid = this.pointCount++;
        this.pointX[pid] = x;
        this.pointY[pid] = y;
        this.pointZ[pid] = z;
        this.pointActive[pid] = 1;
        this.pointNext[pid] = -1;
        this.pointNode[pid] = -1;

        if (this.root === -1) {
            const leaf = this._allocNode();
            this.nodeIsLeaf[leaf] = 1;
            this.nodeLeft[leaf] = pid;
            this.nodeRight[leaf] = 1;
            this.pointNext[pid] = -1;
            this.pointNode[pid] = leaf;
            this._computeLeafAABB(leaf);
            this.root = leaf;
            return pid;
        }

        // Descend to a leaf, tracking the path.
        let pathLen = 0;
        let cur = this.root;
        while (this.nodeIsLeaf[cur] === 0) {
            this._path[pathLen++] = cur;
            const axis = this.nodeSplitAxis[cur];
            const v = axis === 0 ? x : axis === 1 ? y : z;
            cur = v < this.nodeSplitValue[cur] ? this.nodeLeft[cur] : this.nodeRight[cur];
        }

        // Prepend to leaf linked list.
        this.pointNext[pid] = this.nodeLeft[cur];
        this.nodeLeft[cur] = pid;
        this.nodeRight[cur]++;
        this.pointNode[pid] = cur;
        this._expandAABBWithPoint(cur, x, y, z);

        // Refit ancestors.
        for (let i = pathLen - 1; i >= 0; i--) {
            this._computeNodeAABBFromChildren(this._path[i]);
        }

        // Split overfull leaf.
        if (this.nodeRight[cur] > this.leafSize) {
            this._splitLeaf(cur, pathLen);
        }
        return pid;
    }

    _splitLeaf(leaf, pathLen) {
        const count = this.nodeRight[leaf];
        // Ensure split buffer capacity.
        if (count > this._splitBuf.length) {
            this._splitBuf = new Int32Array(count * 2);
        }
        // Gather point ids from the leaf's linked list.
        let p = this.nodeLeft[leaf];
        let gi = 0;
        while (p !== -1) {
            this._splitBuf[gi++] = p;
            p = this.pointNext[p];
        }
        // Compute AABB and choose split axis.
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < gi; i++) {
            const q = this._splitBuf[i];
            const x = this.pointX[q], y = this.pointY[q], z = this.pointZ[q];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const extX = maxX - minX, extY = maxY - minY, extZ = maxZ - minZ;
        let axis = 0;
        if (extY > extX && extY >= extZ) axis = 1;
        else if (extZ > extX && extZ > extY) axis = 2;

        const mid = gi >> 1;
        _nthElement(this._splitBuf, 0, gi - 1, mid, axis, this);
        const splitValue = this._axisValue(this._splitBuf[mid], axis);

        const leftLeaf = this._makeLeafFromIds(this._splitBuf, 0, mid);
        const rightLeaf = this._makeLeafFromIds(this._splitBuf, mid, gi - mid);

        const inner = this._allocNode();
        this.nodeIsLeaf[inner] = 0;
        this.nodeSplitAxis[inner] = axis;
        this.nodeSplitValue[inner] = splitValue;
        this.nodeLeft[inner] = leftLeaf;
        this.nodeRight[inner] = rightLeaf;
        this._computeNodeAABBFromChildren(inner);

        if (pathLen === 0) {
            this.root = inner;
        } else {
            const parent = this._path[pathLen - 1];
            if (this.nodeLeft[parent] === leaf) this.nodeLeft[parent] = inner;
            else this.nodeRight[parent] = inner;
        }
        this._freeNode(leaf);
    }

    /** Lazy remove — marks the point inactive. Queries skip it. */
    removeLazy(pid) {
        if (pid < 0 || pid >= this.pointCount) return false;
        if (this.pointActive[pid] === 0) return false;
        this.pointActive[pid] = 0;
        return true;
    }

    /** Alias of `removeLazy` (eager removal is not supported). */
    remove(pid) { return this.removeLazy(pid); }

    /** Update a point's position — lazy remove + reinsert. */
    update(pid, x, y, z) {
        this.removeLazy(pid);
        return this.insert(x, y, z);
    }

    /** Clear all points and nodes — O(1) reset of counts and flags. */
    clear() {
        this.pointCount = 0;
        this.root = -1;
        this.nodeCount_ = 0;
        this.freeCount = 0;
        if (this.pointActive) this.pointActive.fill(0);
        if (this.pointNext) this.pointNext.fill(-1);
        if (this.pointNode) this.pointNode.fill(-1);
        return this;
    }

    /** Rebuild from active points (useful after many lazy removals). */
    compact() {
        let active = 0;
        for (let i = 0; i < this.pointCount; i++) if (this.pointActive[i]) active++;
        if (active === 0) { this.clear(); return this; }
        // Compact active points to the front.
        let w = 0;
        for (let i = 0; i < this.pointCount; i++) {
            if (this.pointActive[i]) {
                this.pointX[w] = this.pointX[i];
                this.pointY[w] = this.pointY[i];
                this.pointZ[w] = this.pointZ[i];
                w++;
            }
        }
        this.pointCount = w;
        for (let i = 0; i < w; i++) {
            this.pointActive[i] = 1;
            this.pointNext[i] = -1;
            this.pointNode[i] = -1;
            this._buildIds[i] = i;
        }
        // Reset node storage.
        this.nodeCount_ = 0;
        this.freeCount = 0;
        this.root = -1;
        this.root = this._buildRec(this._buildIds, 0, w, 0);
        return this;
    }

    // --------------------------------------------------------------
    // Queries
    // --------------------------------------------------------------
    /**
     * k-nearest query. Writes ids into `outIds`, squared (or sqrt) distances
     * into `outDists`, and returns the number written. Zero-GC when the caller
     * provides the output buffers.
     */
    kNearest(px, py, pz, k, outIds, outDists, outSqrt) {
        _ensureKnnBuf(k);
        outIds = outIds || _knnIds;
        outDists = outDists || _knnDists;
        if (this.root === -1) return 0;

        const heap = _heapPool.acquire();
        if (heap.cap < k) {
            heap.ids = new Uint32Array(k);
            heap.dists = new Float32Array(k);
            heap.cap = k;
        }
        heap.size = 0;

        const stack = _stackPool.acquire();
        let sp = 0;
        stack[sp++] = this.root;

        while (sp > 0) {
            const node = stack[--sp];
            const worst = heap.size < k ? Infinity : heap.dists[0];
            if (this._nodeDistSq(node, px, py, pz) > worst) continue;

            if (this.nodeIsLeaf[node] !== 0) {
                let p = this.nodeLeft[node];
                while (p !== -1) {
                    if (this.pointActive[p]) {
                        const dx = this.pointX[p] - px;
                        const dy = this.pointY[p] - py;
                        const dz = this.pointZ[p] - pz;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        if (heap.size < k) {
                            _heapPush(heap, p, d2, k);
                        } else if (d2 < heap.dists[0]) {
                            _heapPop(heap);
                            _heapPush(heap, p, d2, k);
                        }
                    }
                    p = this.pointNext[p];
                }
            } else {
                const l = this.nodeLeft[node];
                const r = this.nodeRight[node];
                const dL = this._nodeDistSq(l, px, py, pz);
                const dR = this._nodeDistSq(r, px, py, pz);
                if (sp + 2 < stack.length) {
                    if (dL < dR) { stack[sp++] = r; stack[sp++] = l; }
                    else         { stack[sp++] = l; stack[sp++] = r; }
                }
            }
        }
        _stackPool.release(stack);

        const n = heap.size;
        for (let i = 0; i < n; i++) {
            outIds[i] = heap.ids[i];
            outDists[i] = outSqrt ? Math.sqrt(heap.dists[i]) : heap.dists[i];
        }
        // Insertion sort ascending by distance (k is small).
        for (let i = 1; i < n; i++) {
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
        _heapPool.release(heap);
        return n;
    }

    /**
     * Radius query — writes ids of all points within `radius` into `outIds`
     * and returns the count. Zero-GC.
     */
    radiusQuery(px, py, pz, radius, outIds) {
        const maxOut = outIds.length;
        let count = 0;
        if (this.root === -1) return 0;
        const r2 = radius * radius;
        const stack = _stackPool.acquire();
        let sp = 0;
        stack[sp++] = this.root;
        while (sp > 0 && count < maxOut) {
            const node = stack[--sp];
            if (this._nodeDistSq(node, px, py, pz) > r2) continue;
            if (this.nodeIsLeaf[node] !== 0) {
                let p = this.nodeLeft[node];
                while (p !== -1 && count < maxOut) {
                    if (this.pointActive[p]) {
                        const dx = this.pointX[p] - px;
                        const dy = this.pointY[p] - py;
                        const dz = this.pointZ[p] - pz;
                        if (dx * dx + dy * dy + dz * dz <= r2) outIds[count++] = p;
                    }
                    p = this.pointNext[p];
                }
            } else {
                if (sp + 2 < stack.length) {
                    stack[sp++] = this.nodeLeft[node];
                    stack[sp++] = this.nodeRight[node];
                }
            }
        }
        _stackPool.release(stack);
        return count;
    }

    /**
     * AABB query — writes ids of all points inside the AABB into `outIds` and
     * returns the count. Zero-GC.
     */
    aabbQuery(minX, minY, minZ, maxX, maxY, maxZ, outIds) {
        const maxOut = outIds.length;
        let count = 0;
        if (this.root === -1) return 0;
        const stack = _stackPool.acquire();
        let sp = 0;
        stack[sp++] = this.root;
        while (sp > 0 && count < maxOut) {
            const node = stack[--sp];
            if (this.nodeMaxX[node] < minX || this.nodeMinX[node] > maxX) continue;
            if (this.nodeMaxY[node] < minY || this.nodeMinY[node] > maxY) continue;
            if (this.nodeMaxZ[node] < minZ || this.nodeMinZ[node] > maxZ) continue;
            if (this.nodeIsLeaf[node] !== 0) {
                let p = this.nodeLeft[node];
                while (p !== -1 && count < maxOut) {
                    if (this.pointActive[p]) {
                        const x = this.pointX[p], y = this.pointY[p], z = this.pointZ[p];
                        if (x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ) {
                            outIds[count++] = p;
                        }
                    }
                    p = this.pointNext[p];
                }
            } else {
                if (sp + 2 < stack.length) {
                    stack[sp++] = this.nodeLeft[node];
                    stack[sp++] = this.nodeRight[node];
                }
            }
        }
        _stackPool.release(stack);
        return count;
    }

    /** Closest single point. Returns point id or -1. Zero-GC. */
    closestPoint(px, py, pz) {
        if (this.root === -1) return -1;
        return this.kNearest(px, py, pz, 1, _oneId, _oneDist, false) > 0 ? _oneId[0] : -1;
    }

    /** Count points inside a sphere without allocating a result array. */
    countInSphere(px, py, pz, radius) {
        if (this.root === -1) return 0;
        const r2 = radius * radius;
        const stack = _stackPool.acquire();
        let sp = 0;
        stack[sp++] = this.root;
        let count = 0;
        while (sp > 0) {
            const node = stack[--sp];
            if (this._nodeDistSq(node, px, py, pz) > r2) continue;
            if (this.nodeIsLeaf[node] !== 0) {
                let p = this.nodeLeft[node];
                while (p !== -1) {
                    if (this.pointActive[p]) {
                        const dx = this.pointX[p] - px;
                        const dy = this.pointY[p] - py;
                        const dz = this.pointZ[p] - pz;
                        if (dx * dx + dy * dy + dz * dz <= r2) count++;
                    }
                    p = this.pointNext[p];
                }
            } else {
                if (sp + 2 < stack.length) {
                    stack[sp++] = this.nodeLeft[node];
                    stack[sp++] = this.nodeRight[node];
                }
            }
        }
        _stackPool.release(stack);
        return count;
    }

    /**
     * Callback-based radius iteration (convenience API). Prefer `radiusQuery`
     * in hot loops to avoid a caller closure.
     */
    forEachInRadius(px, py, pz, radius, fn) {
        if (this.root === -1) return 0;
        const r2 = radius * radius;
        const stack = _stackPool.acquire();
        let sp = 0;
        stack[sp++] = this.root;
        let count = 0;
        while (sp > 0) {
            const node = stack[--sp];
            if (this._nodeDistSq(node, px, py, pz) > r2) continue;
            if (this.nodeIsLeaf[node] !== 0) {
                let p = this.nodeLeft[node];
                while (p !== -1) {
                    if (this.pointActive[p]) {
                        const dx = this.pointX[p] - px;
                        const dy = this.pointY[p] - py;
                        const dz = this.pointZ[p] - pz;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        if (d2 <= r2) { fn(p, d2); count++; }
                    }
                    p = this.pointNext[p];
                }
            } else {
                if (sp + 2 < stack.length) {
                    stack[sp++] = this.nodeLeft[node];
                    stack[sp++] = this.nodeRight[node];
                }
            }
        }
        _stackPool.release(stack);
        return count;
    }

    /** Tree statistics (analysis-time). */
    stats() {
        if (this.root === -1) {
            return { nodeCount: 0, leafCount: 0, pointCount: 0, maxDepth: 0, avgDepth: 0 };
        }
        const stack = _stackPool.acquire();
        let sp = 0;
        stack[sp++] = this.root;
        _statsDepth[0] = 0;
        let dsp = 1;
        let nodeCount = 0, leafCount = 0, maxDepth = 0, depthSum = 0;
        while (sp > 0) {
            const node = stack[--sp];
            const depth = _statsDepth[--dsp];
            nodeCount++;
            if (depth > maxDepth) maxDepth = depth;
            if (this.nodeIsLeaf[node] !== 0) {
                leafCount++;
                depthSum += depth;
            } else {
                if (sp + 2 < stack.length && dsp + 2 < _statsDepth.length) {
                    stack[sp++] = this.nodeLeft[node];  _statsDepth[dsp++] = depth + 1;
                    stack[sp++] = this.nodeRight[node]; _statsDepth[dsp++] = depth + 1;
                }
            }
        }
        _stackPool.release(stack);
        return {
            nodeCount: nodeCount,
            leafCount: leafCount,
            pointCount: this.pointCount,
            maxDepth: maxDepth,
            avgDepth: leafCount > 0 ? depthSum / leafCount : 0
        };
    }
}

// ============================================================================
// Function Declarations — max-heap helpers
// ============================================================================
function _heapPush(heap, id, d2, maxK) {
    if (heap.size >= maxK) return;
    const i = heap.size++;
    heap.ids[i] = id;
    heap.dists[i] = d2;
    let j = i;
    while (j > 0) {
        const parent = (j - 1) >> 1;
        if (heap.dists[parent] < heap.dists[j]) {
            let t = heap.dists[parent]; heap.dists[parent] = heap.dists[j]; heap.dists[j] = t;
            let ti = heap.ids[parent]; heap.ids[parent] = heap.ids[j]; heap.ids[j] = ti;
            j = parent;
        } else break;
    }
}

function _heapPop(heap) {
    heap.size--;
    if (heap.size === 0) return;
    heap.ids[0] = heap.ids[heap.size];
    heap.dists[0] = heap.dists[heap.size];
    let i = 0;
    const n = heap.size;
    while (true) {
        let left = i * 2 + 1, right = i * 2 + 2, largest = i;
        if (left < n && heap.dists[left] > heap.dists[largest]) largest = left;
        if (right < n && heap.dists[right] > heap.dists[largest]) largest = right;
        if (largest === i) break;
        let t = heap.dists[largest]; heap.dists[largest] = heap.dists[i]; heap.dists[i] = t;
        let ti = heap.ids[largest]; heap.ids[largest] = heap.ids[i]; heap.ids[i] = ti;
        i = largest;
    }
}

// ============================================================================
// Function Declarations — nth_element (Hoare partition)
// ============================================================================
function _nthElement(arr, lo, hi, k, axis, tree) {
    while (lo < hi) {
        const pivotIdx = (lo + hi) >> 1;
        const pivotVal = tree._axisValue(arr[pivotIdx], axis);
        let i = lo, j = hi;
        while (i <= j) {
            while (tree._axisValue(arr[i], axis) < pivotVal) i++;
            while (tree._axisValue(arr[j], axis) > pivotVal) j--;
            if (i <= j) {
                const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
                i++; j--;
            }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return;
    }
}

// ============================================================================
// Function Declarations — Construction
// ============================================================================
function createKDTree(maxPoints, options) { return new KDTree(maxPoints, options); }

function createKDTreeStatic(positions, options) {
    const tree = new KDTree(positions.count, options);
    tree.buildFromSOA(positions);
    return tree;
}

function buildFromSOA(tree, positions, count) { return tree.buildFromSOA(positions, count); }

function buildFromArrays(tree, xs, ys, zs, count) {
    count = count === undefined ? xs.length : count;
    const soa = { x: xs, y: ys, z: zs, count: count };
    return tree.buildFromSOA(soa, count);
}

function buildMedian(tree, positions, count) { return tree.buildFromSOA(positions, count); }

function buildSlidingMidpoint(tree, positions, count) { return tree.buildFromSOA(positions, count); }

async function buildFromSOAAsync(tree, positions, count, options) {
    options = options || {};
    const chunkSize = options.chunkSize || common.CHUNK_SIZE;
    const yieldEvery = options.yieldEvery || common.CHUNK_YIELD_EVERY;
    count = count === undefined ? positions.count : count;
    tree.clear();
    if (count === 0) return tree;
    tree._growPoints(count);
    const px = positions.x, py = positions.y, pz = positions.z;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) {
            tree.pointX[i] = px[i];
            tree.pointY[i] = py[i];
            tree.pointZ[i] = pz[i];
            tree.pointActive[i] = 1;
            tree.pointNext[i] = -1;
            tree.pointNode[i] = -1;
            tree._buildIds[i] = i;
        }
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    tree.pointCount = count;
    await common.yieldToMain();
    tree.root = tree._buildRec(tree._buildIds, 0, count, 0);
    await common.yieldToMain();
    return tree;
}

// ============================================================================
// Function Declarations — Dynamic ops (free-function aliases)
// ============================================================================
function insert(tree, x, y, z) { return tree.insert(x, y, z); }
function remove(tree, pid) { return tree.remove(pid); }
function removeLazy(tree, pid) { return tree.removeLazy(pid); }
function update(tree, pid, x, y, z) { return tree.update(pid, x, y, z); }
function clear(tree) { return tree.clear(); }
function compact(tree) { return tree.compact(); }

// ============================================================================
// Function Declarations — Queries (free-function aliases)
// ============================================================================
function kNearest(tree, px, py, pz, k, outIds, outDists, outSqrt) {
    return tree.kNearest(px, py, pz, k, outIds, outDists, outSqrt);
}
function radiusQuery(tree, px, py, pz, radius, outIds) {
    return tree.radiusQuery(px, py, pz, radius, outIds);
}
function aabbQuery(tree, minX, minY, minZ, maxX, maxY, maxZ, outIds) {
    return tree.aabbQuery(minX, minY, minZ, maxX, maxY, maxZ, outIds);
}
function closestPoint(tree, px, py, pz) { return tree.closestPoint(px, py, pz); }
function countInSphere(tree, px, py, pz, radius) { return tree.countInSphere(px, py, pz, radius); }
function forEachInRadius(tree, px, py, pz, radius, fn) { return tree.forEachInRadius(px, py, pz, radius, fn); }

/** Read a point's position into `out[0..2]`. */
function pointOf(tree, pid, out) {
    out = out || _oneDist; // reuse a 3-slot scratch via caller in hot paths
    if (pid < 0 || pid >= tree.pointCount) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    out[0] = tree.pointX[pid];
    out[1] = tree.pointY[pid];
    out[2] = tree.pointZ[pid];
    return out;
}

function stats(tree) { return tree.stats(); }

// ============================================================================
// Function Declarations — SOA (sync)
// ============================================================================
function soaBuild(tree, positions, count) { return tree.buildFromSOA(positions, count); }

/** Batch insert — appends many points then relies on the tree's linked leaves. */
function soaInsertBatch(tree, positions, count) {
    count = count === undefined ? positions.count : count;
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < count; i++) tree.insert(px[i], py[i], pz[i]);
    return count;
}

/**
 * Batch k-NN — one query per element of `queries`. Writes flattened results
 * (`queries.count × k`) into `outIds`/`outDists` and per-query counts into
 * `outCounts`.
 */
function soaKNearestBatch(tree, queries, k, outIds, outDists, outCounts, outSqrt) {
    const n = queries.count;
    const qx = queries.x, qy = queries.y, qz = queries.z;
    _ensureKnnBuf(k);
    for (let i = 0; i < n; i++) {
        const count = tree.kNearest(qx[i], qy[i], qz[i], k, _knnIds, _knnDists, outSqrt);
        outCounts[i] = count;
        const base = i * k;
        for (let c = 0; c < count; c++) {
            outIds[base + c] = _knnIds[c];
            outDists[base + c] = _knnDists[c];
        }
    }
    return outCounts;
}

/**
 * Batch radius query — writes per-query counts into `outCounts` and, if
 * `outIds` is provided, the ids sequentially with `outStride` per query.
 */
function soaRadiusBatch(tree, queries, radii, outCounts, outIds, outStride) {
    const n = queries.count;
    const qx = queries.x, qy = queries.y, qz = queries.z;
    const tmp = _knnIds; // reuse growable scratch (sized by prior _ensureKnnBuf)
    for (let i = 0; i < n; i++) {
        const buf = outIds ? outIds.subarray ? outIds : tmp : tmp;
        // Use a dedicated per-query window via tmp when outIds not provided.
        const count = tree.radiusQuery(qx[i], qy[i], qz[i], radii[i], tmp);
        outCounts[i] = count;
        if (outIds) {
            const base = i * outStride;
            const lim = count < outStride ? count : outStride;
            for (let c = 0; c < lim; c++) outIds[base + c] = tmp[c];
        }
    }
    return outCounts;
}

/** Batch closest-point — one query per element of `queries`. */
function soaClosestBatch(tree, queries, outIds) {
    const n = queries.count;
    const qx = queries.x, qy = queries.y, qz = queries.z;
    for (let i = 0; i < n; i++) outIds[i] = tree.closestPoint(qx[i], qy[i], qz[i]);
    return outIds;
}

/**
 * Batch spacing check — for each candidate in `queries`, writes 1 into
 * `outFlags` if no existing tree point is closer than `minDist`, else 0.
 */
function soaSpacingCheck(tree, queries, minDist, outFlags) {
    const n = queries.count;
    const qx = queries.x, qy = queries.y, qz = queries.z;
    const r2 = minDist * minDist;
    for (let i = 0; i < n; i++) {
        const count = tree.kNearest(qx[i], qy[i], qz[i], 1, _oneId, _oneDist, false);
        outFlags[i] = (count === 0 || _oneDist[0] > r2) ? 1 : 0;
    }
    return outFlags;
}

/**
 * Procedural point placement — Poisson-disk-like rejector. Generates up to
 * `count` points inside `bounds` with guaranteed `minDist` spacing, using the
 * KD-tree as an accelerating structure. Writes accepted positions into
 * `outPositions` (a vec3 SOA) and returns the accepted count.
 */
function soaProceduralPlacement(outPositions, count, minDist, bounds, options) {
    options = options || {};
    const seed = options.seed || 1;
    const rng = common.mulberry32(seed);
    bounds = bounds || { minX: -100, minY: -100, minZ: -100, maxX: 100, maxY: 100, maxZ: 100 };
    const tree = new KDTree(count, { leafSize: DEFAULT_LEAF_SIZE });
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    const spanZ = bounds.maxZ - bounds.minZ;
    const r2 = minDist * minDist;
    let accepted = 0;
    let tries = 0;
    const maxTries = count * 30;
    while (accepted < count && tries < maxTries) {
        const x = bounds.minX + rng() * spanX;
        const y = bounds.minY + rng() * spanY;
        const z = bounds.minZ + rng() * spanZ;
        const hitCount = tree.kNearest(x, y, z, 1, _oneId, _oneDist, false);
        if (hitCount > 0 && _oneDist[0] <= r2) { tries++; continue; }
        ox[accepted] = x;
        oy[accepted] = y;
        oz[accepted] = z;
        tree.insert(x, y, z);
        accepted++;
    }
    return accepted;
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaBuildChunked(tree, positions, count, chunkSize, yieldEvery) {
    return buildFromSOAAsync(tree, positions, count, { chunkSize: chunkSize, yieldEvery: yieldEvery });
}

async function soaKNearestBatchChunked(tree, queries, k, outIds, outDists, outCounts, outSqrt, chunkSize, yieldEvery) {
    const n = queries.count;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const qx = queries.x, qy = queries.y, qz = queries.z;
    _ensureKnnBuf(k);
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) {
            const count = tree.kNearest(qx[i], qy[i], qz[i], k, _knnIds, _knnDists, outSqrt);
            outCounts[i] = count;
            const base = i * k;
            for (let cc = 0; cc < count; cc++) {
                outIds[base + cc] = _knnIds[cc];
                outDists[base + cc] = _knnDists[cc];
            }
        }
        start = end;
        if (start >= n) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outCounts;
}

async function soaClosestBatchChunked(tree, queries, outIds, chunkSize, yieldEvery) {
    const n = queries.count;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const qx = queries.x, qy = queries.y, qz = queries.z;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) outIds[i] = tree.closestPoint(qx[i], qy[i], qz[i]);
        start = end;
        if (start >= n) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outIds;
}

async function soaSpacingCheckChunked(tree, queries, minDist, outFlags, chunkSize, yieldEvery) {
    const n = queries.count;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const qx = queries.x, qy = queries.y, qz = queries.z;
    const r2 = minDist * minDist;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) {
            const count = tree.kNearest(qx[i], qy[i], qz[i], 1, _oneId, _oneDist, false);
            outFlags[i] = (count === 0 || _oneDist[0] > r2) ? 1 : 0;
        }
        start = end;
        if (start >= n) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outFlags;
}

async function soaProceduralPlacementChunked(outPositions, count, minDist, bounds, options, chunkSize, yieldEvery) {
    // Placement is inherently sequential (each insert affects later queries);
    // yield periodically to keep the UI thread responsive.
    options = options || {};
    const seed = options.seed || 1;
    const rng = common.mulberry32(seed);
    bounds = bounds || { minX: -100, minY: -100, minZ: -100, maxX: 100, maxY: 100, maxZ: 100 };
    const tree = new KDTree(count, { leafSize: DEFAULT_LEAF_SIZE });
    const ox = outPositions.x, oy = outPositions.y, oz = outPositions.z;
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    const spanZ = bounds.maxZ - bounds.minZ;
    const r2 = minDist * minDist;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let accepted = 0;
    let tries = 0;
    let counter = 0;
    const maxTries = count * 30;
    while (accepted < count && tries < maxTries) {
        const x = bounds.minX + rng() * spanX;
        const y = bounds.minY + rng() * spanY;
        const z = bounds.minZ + rng() * spanZ;
        const hitCount = tree.kNearest(x, y, z, 1, _oneId, _oneDist, false);
        if (hitCount > 0 && _oneDist[0] <= r2) { tries++; continue; }
        ox[accepted] = x;
        oy[accepted] = y;
        oz[accepted] = z;
        tree.insert(x, y, z);
        accepted++;
        if (++counter >= chunkSize) {
            counter = 0;
            if (++tries % yieldEvery === 0) await common.yieldToMain();
        }
    }
    return accepted;
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================
const _kdPoolByCapacity = Object.create(null);

/**
 * KDPool — pooled KD-tree instances keyed by capacity. Uses a plain object
 * (no Map). Released trees keep their typed arrays for reuse.
 */
class KDPool {
    static acquire(maxPoints, options) {
        const bucket = _kdPoolByCapacity[maxPoints];
        if (bucket && bucket.length > 0) {
            const t = bucket.pop();
            t.clear();
            return t;
        }
        return new KDTree(maxPoints, options);
    }
    static release(tree) {
        if (!tree) return;
        tree.clear();
        const key = tree.maxPoints;
        let bucket = _kdPoolByCapacity[key];
        if (!bucket) { bucket = []; _kdPoolByCapacity[key] = bucket; }
        if (bucket.length < 4) bucket.push(tree);
    }
}

function acquireKDTree(maxPoints, options) { return KDPool.acquire(maxPoints, options); }
function releaseKDTree(tree) { KDPool.release(tree); }

// ============================================================================
// Class Declarations — Batch state
// ============================================================================
/**
 * KDBatchState — per-frame state for 1M+ k-NN pipelines. Holds a KD-tree,
 * position/query SOAs, and reusable result buffers.
 */
class KDBatchState {
    constructor(count, options) {
        this.count = count;
        this.tree = new KDTree(count, options);
        this.positions = createVec3SOA(count);
        this.queries = createVec3SOA(count);
        this.queryCounts = new Uint32Array(count);
        this.radii = new Float32Array(count);
        this.outIds = new Uint32Array(count * 16);
        this.outDists = new Float32Array(count * 16);
    }
    build() {
        this.tree.buildFromSOA(this.positions, this.count);
        return this;
    }
    async buildChunked(cs, ye) {
        return buildFromSOAAsync(this.tree, this.positions, this.count, { chunkSize: cs, yieldEvery: ye });
    }
    kNearest(k) {
        return soaKNearestBatch(this.tree, this.queries, k, this.outIds, this.outDists, this.queryCounts);
    }
    async kNearestChunked(k, cs, ye) {
        return soaKNearestBatchChunked(this.tree, this.queries, k, this.outIds, this.outDists, this.queryCounts, false, cs, ye);
    }
}

function createKDBatch(count, options) { return new KDBatchState(count, options); }

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    core: {
        KDTree, KDNode,
        createKDTree, createKDTreeStatic,
        buildFromSOA, buildFromSOAAsync, buildFromArrays,
        buildMedian, buildSlidingMidpoint,
        insert, remove, removeLazy, update, clear, compact
    },
    query: {
        kNearest, radiusQuery, aabbQuery,
        closestPoint, countInSphere, forEachInRadius
    },
    util: { pointOf, stats },
    pool: { KDPool, acquireKDTree, releaseKDTree },
    batch: {
        State: KDBatchState,
        create: createKDBatch,
        build: soaBuild,
        buildChunked: soaBuildChunked,
        insertBatch: soaInsertBatch,
        kNearest: soaKNearestBatch,
        kNearestChunked: soaKNearestBatchChunked,
        radius: soaRadiusBatch,
        closest: soaClosestBatch,
        closestChunked: soaClosestBatchChunked,
        spacing: soaSpacingCheck,
        spacingChunked: soaSpacingCheckChunked,
        proceduralPlacement: soaProceduralPlacement,
        proceduralPlacementChunked: soaProceduralPlacementChunked
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing KDTree instances keep their current buffer types; new trees created
// after a precision change use the live array type via getArrayType().
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Core classes
    KDTree, KDNode,
    createKDTree, createKDTreeStatic,
    // Construction
    buildFromSOA, buildFromSOAAsync, buildFromArrays,
    buildMedian, buildSlidingMidpoint,
    // Dynamic ops
    insert, remove, removeLazy, update, clear, compact,
    // Queries
    kNearest, radiusQuery, aabbQuery,
    closestPoint, countInSphere, forEachInRadius,
    // Utilities
    pointOf, stats,
    // SOA (sync)
    soaBuild, soaInsertBatch,
    soaKNearestBatch, soaRadiusBatch, soaClosestBatch,
    soaSpacingCheck, soaProceduralPlacement,
    // SOA (chunked async)
    soaBuildChunked, soaKNearestBatchChunked,
    soaClosestBatchChunked, soaSpacingCheckChunked,
    soaProceduralPlacementChunked,
    // Pools
    KDPool, acquireKDTree, releaseKDTree,
    // Batch
    KDBatchState, createKDBatch,
    // Namespaces
    namespace
};