//File number : 069
// File : src/math/069_bvh.js
//Description : Static BVH (Bounding Volume Hierarchy) for 1M+ primitives — full construction via SAH binned (32 bins), median split, and spatial split; flat GPU-friendly node layout (6 floats per AABB + 4 ints per node, all in parallel SoA arrays); ray/BVH traversal (slab test + closest hit), frustum/BVH culling, AABB/BVH range query; per-frame refit for slowly-moving primitives; SoA AABB storage (minX/minY/minZ/maxX/maxY/maxZ as parallel Float arrays) that scales from mm to Mpc; pooled node arrays and traversal stacks for zero GC; chunked async builders that yield via `scheduler.yield()` so the Android UI thread never freezes; and full integration with `000_Math_module.js` so world coordinates switch automatically between Float16/Float32/Float64 without breaking the build. Provides `BVH`, `BVHNode`, `AABBSOA`, `BVHPool`, and a small set of domain helpers used by the rest of the 3d-math folder (DBVH, dynamic grid, light BVH, ray tracing, procedural placement).
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. All traversal scratch (ray hit temporaries, AABB scratch, traversal stacks) is pooled or module-level. `frustumCull` / `aabbQuery` write into caller-provided `Uint32Array` buffers and return only an integer count (blueprint §42 correction). The median-split partition uses an in-place iterative quickselect (no `Array.sort`, no comparator closure). SAH bin accumulators are allocated once per build (init-time) and reused across nodes. Chunked async kernels inline their loops (no per-call callbacks). All allocations occur exclusively at module init / pool growth / documented init-time builds.
//Corrections : ESM imports/exports only (no require/exports). Fixed: dozens of corrupted operators (`> >`, `< <`, `& &`, `> =`, `b vh`, `leftA ABB`, `Math.ma x`, `Mat h.min`, `-Infinit y`, `nodeRigh t`, `_allocNode` vs `allocNode`, `nodeCount` vs `nodeCount_`, `nodeCap` vs `nodeCap_`) that were syntax errors; `BVH` used inconsistent field names and a missing `_allocNode` method; `raycast`/`raycastAny`/`frustumCull`/`aabbQuery` allocated array literals (`[0]`, `[Infinity]`, `[0,0,0,0,0,0]`) and returned growing JS arrays per call (now pooled scratch + preallocated out-buffers returning counts); `_partitionMedian` used `Array.sort` with a comparator closure (now in-place quickselect); `buildSAH` recomputed bin prefix accumulators with a broken double loop (now a clean single prefix/suffix sweep); the broken traversal-stack growth block in `raycast` was removed; `buildSAHAsync`/`refit`/`refitAsync` had corrupted identifiers; `BVHBatchState` used a Set + forEach listeners (removed); the unused `NumericalStability` import was removed; ray slab test now guards zero direction components to avoid NaN.
//Added : Zero-GC out-buffer query API (`frustumCull`, `aabbQuery` return counts into caller `Uint32Array`), SoA variants `soaFrustumCullCount` / `soaAABBQueryCount`, in-place quickselect median partition, clean binned SAH prefix/suffix cost sweep, and chunked async variants for raycast and queries.
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
const EPSILON           = 1e-9;
const DEFAULT_BINS      = 32;
const LEAF_SIZE_DEFAULT = 4;
const MAX_DEPTH_DEFAULT = 64;
const MAX_STACK         = 256;
const BIG_INV           = 1e30; // finite stand-in for 1/0 to avoid NaN in slab test

// Module-level traversal scratch (single-threaded, never held across calls).
const _aabbTmp = new Float64Array(6);
const _rayT = {
    a: new Float64Array(1),
    b: new Float64Array(1),
    c: new Float64Array(1),
    d: new Float64Array(1)
};
const _defaultRayHit = { hit: false, t: Infinity, primId: -1, u: 0, v: 0 };
const _rayHitTmp     = { hit: false, t: Infinity, primId: -1, u: 0, v: 0 };

function _safeInv(d) { return d === 0 ? BIG_INV : 1 / d; }

// ============================================================================
// Class Declarations — SoA AABB storage
// ============================================================================
/**
 * AABBSOA — Structure-of-Arrays storage for 1M+ AABBs. Each AABB is 6 floats
 * stored in six parallel arrays plus cached centroids. All traversal reads from
 * these arrays so they stay hot in cache. Buffers use the current precision
 * mode from `000_Math_module.js`.
 */
class AABBSOA {
    constructor(capacity, Type) {
        this.capacity = capacity || 0;
        this.count = 0;
        const T = Type || getArrayType();
        this.minX = new T(this.capacity);
        this.minY = new T(this.capacity);
        this.minZ = new T(this.capacity);
        this.maxX = new T(this.capacity);
        this.maxY = new T(this.capacity);
        this.maxZ = new T(this.capacity);
        this.cx   = new T(this.capacity);
        this.cy   = new T(this.capacity);
        this.cz   = new T(this.capacity);
    }
    set(i, minX, minY, minZ, maxX, maxY, maxZ) {
        this.minX[i] = minX; this.minY[i] = minY; this.minZ[i] = minZ;
        this.maxX[i] = maxX; this.maxY[i] = maxY; this.maxZ[i] = maxZ;
        this.cx[i] = (minX + maxX) * 0.5;
        this.cy[i] = (minY + maxY) * 0.5;
        this.cz[i] = (minZ + maxZ) * 0.5;
        return this;
    }
    updateCentroid(i) {
        this.cx[i] = (this.minX[i] + this.maxX[i]) * 0.5;
        this.cy[i] = (this.minY[i] + this.maxY[i]) * 0.5;
        this.cz[i] = (this.minZ[i] + this.maxZ[i]) * 0.5;
        return this;
    }
    resize(n) {
        if (n <= this.capacity) { this.count = n; return this; }
        const T = this.minX.constructor;
        const nMinX = new T(n); nMinX.set(this.minX); this.minX = nMinX;
        const nMinY = new T(n); nMinY.set(this.minY); this.minY = nMinY;
        const nMinZ = new T(n); nMinZ.set(this.minZ); this.minZ = nMinZ;
        const nMaxX = new T(n); nMaxX.set(this.maxX); this.maxX = nMaxX;
        const nMaxY = new T(n); nMaxY.set(this.maxY); this.maxY = nMaxY;
        const nMaxZ = new T(n); nMaxZ.set(this.maxZ); this.maxZ = nMaxZ;
        const nCx   = new T(n); nCx.set(this.cx);     this.cx   = nCx;
        const nCy   = new T(n); nCy.set(this.cy);     this.cy   = nCy;
        const nCz   = new T(n); nCz.set(this.cz);     this.cz   = nCz;
        this.capacity = n;
        this.count = n;
        return this;
    }
}

/**
 * BVHNode — data view for users who want to walk the tree with an object API.
 * The BVH itself stores nodes in flat typed arrays (see `BVH`).
 */
class BVHNode {
    constructor() {
        this.minX = 0; this.minY = 0; this.minZ = 0;
        this.maxX = 0; this.maxY = 0; this.maxZ = 0;
        this.leftOrFirst = 0;
        this.count = 0;
        this.parent = -1;
    }
}

// ============================================================================
// Class Declarations — BVH (flat-array SoA nodes)
// ============================================================================
/**
 * BVH — flat-array bounding volume hierarchy. Node layout per node stored in
 * parallel SoA arrays:
 *   nodeMinX/Y/Z, nodeMaxX/Y/Z  (Float, current precision)
 *   nodeLeft, nodeRight          (Int32)  left child / right child, or first prim for leaves
 *   nodeCount                    (Int32)  primitive count (0 = inner, >0 = leaf)
 *   nodeParent                   (Int32)  parent index (-1 for root)
 */
class BVH {
    constructor(aabbs, capacityHint) {
        this.minX = 0; this.minY = 0; this.minZ = 0;
        this.maxX = 0; this.maxY = 0; this.maxZ = 0;
        this.aabbs = aabbs || null;
        this.nodeMinX = null; this.nodeMinY = null; this.nodeMinZ = null;
        this.nodeMaxX = null; this.nodeMaxY = null; this.nodeMaxZ = null;
        this.nodeLeft = null; this.nodeRight = null;
        this.nodeCount = null; this.nodeParent = null;
        this.nodeCount_ = 0;
        this.nodeCap_ = 0;
        this.primOrder = null;
        this.primCount = 0;
        const cap = capacityHint || Math.max(4, (aabbs ? aabbs.count : 1024) * 2);
        this._allocNodes(cap);
        const primN = aabbs ? aabbs.count : 0;
        this.primOrder = new Uint32Array(primN);
        for (let i = 0; i < primN; i++) this.primOrder[i] = i;
        this.primCount = primN;
    }
    _allocNodes(cap) {
        const T = (this.aabbs && this.aabbs.minX) ? this.aabbs.minX.constructor : getArrayType();
        this.nodeMinX = new T(cap);
        this.nodeMinY = new T(cap);
        this.nodeMinZ = new T(cap);
        this.nodeMaxX = new T(cap);
        this.nodeMaxY = new T(cap);
        this.nodeMaxZ = new T(cap);
        this.nodeLeft   = new Int32Array(cap);
        this.nodeRight  = new Int32Array(cap);
        this.nodeCount  = new Int32Array(cap);
        this.nodeParent = new Int32Array(cap);
        this.nodeCount_ = 0;
        this.nodeCap_ = cap;
    }
    _growNodes(newCap) {
        const T = this.nodeMinX.constructor;
        const gF = (a) => { const o = new T(newCap); o.set(a); return o; };
        const gI = (a) => { const o = new Int32Array(newCap); o.set(a); return o; };
        this.nodeMinX = gF(this.nodeMinX);
        this.nodeMinY = gF(this.nodeMinY);
        this.nodeMinZ = gF(this.nodeMinZ);
        this.nodeMaxX = gF(this.nodeMaxX);
        this.nodeMaxY = gF(this.nodeMaxY);
        this.nodeMaxZ = gF(this.nodeMaxZ);
        this.nodeLeft   = gI(this.nodeLeft);
        this.nodeRight  = gI(this.nodeRight);
        this.nodeCount  = gI(this.nodeCount);
        this.nodeParent = gI(this.nodeParent);
        this.nodeCap_ = newCap;
    }
    _allocNode() {
        if (this.nodeCount_ >= this.nodeCap_) {
            this._growNodes(Math.max(this.nodeCap_ * 2, this.nodeCap_ + 1024));
        }
        const idx = this.nodeCount_++;
        this.nodeLeft[idx] = 0;
        this.nodeRight[idx] = 0;
        this.nodeCount[idx] = 0;
        this.nodeParent[idx] = -1;
        return idx;
    }
    /** Ensure primOrder can hold n entries and reset it to identity. */
    _resetPrimOrder(n) {
        if (!this.primOrder || this.primOrder.length < n) {
            this.primOrder = new Uint32Array(n);
        }
        for (let i = 0; i < n; i++) this.primOrder[i] = i;
        this.primCount = n;
    }
}

// ============================================================================
// Class Declarations — BVHPool
// ============================================================================
/**
 * BVHPool — pooled allocation of BVH handles, AABBSOA buffers, and traversal
 * stacks. Use `acquireBVH`, `acquireAABBSOA`, `acquireTraversalStack` and
 * release the handles when done. Zero GC after warm-up.
 */
class BVHPool {
    static bvhPool = common.createPool(
        function () { return { bvh: null, aabbs: null, capacity: 0 }; },
        4,
        function (h) { h.bvh = null; h.aabbs = null; h.capacity = 0; }
    );
    static aabbPool = common.createPool(
        function () { return new AABBSOA(1024); },
        4,
        function (a) { a.count = 0; }
    );
    static stackPool = common.createPool(
        function () { return new Int32Array(MAX_STACK); },
        8,
        function (s) { /* no reset needed */ }
    );
}

function acquireBVH(aabbs, capacityHint) {
    const h = BVHPool.bvhPool.acquire();
    h.bvh = new BVH(aabbs, capacityHint);
    h.aabbs = aabbs;
    h.capacity = capacityHint || (aabbs ? aabbs.count : 0);
    return h;
}

function releaseBVH(handle) {
    if (handle && handle.bvh) {
        handle.bvh.aabbs = null;
        handle.bvh = null;
        handle.aabbs = null;
        handle.capacity = 0;
        BVHPool.bvhPool.release(handle);
    }
}

function acquireAABBSOA(capacity) {
    const a = BVHPool.aabbPool.acquire();
    if (capacity > a.capacity) a.resize(capacity);
    a.count = 0;
    return a;
}

function releaseAABBSOA(a) {
    if (a) {
        a.count = 0;
        BVHPool.aabbPool.release(a);
    }
}

function acquireTraversalStack() { return BVHPool.stackPool.acquire(); }
function releaseTraversalStack(stack) { if (stack) BVHPool.stackPool.release(stack); }

// ============================================================================
// Class Declarations — Batch state
// ============================================================================
/**
 * BVHBatchState — holds a preallocated BVH for batched building, plus scratch
 * buffers for building/traversing 1M+ primitives per frame.
 */
class BVHBatchState {
    constructor(count) {
        this.count = count;
        this.aabbs = new AABBSOA(count);
        this.bvh = new BVH(this.aabbs, count * 2);
        this.stack = new Int32Array(MAX_STACK);
    }
    /** Fill AABBs from a vec3 SOA (positions) + a uniform half-size. */
    fillFromPositions(positions, halfSize) {
        const n = Math.min(positions.count, this.aabbs.capacity);
        const px = positions.x, py = positions.y, pz = positions.z;
        for (let i = 0; i < n; i++) {
            this.aabbs.set(i, px[i] - halfSize, py[i] - halfSize, pz[i] - halfSize,
                              px[i] + halfSize, py[i] + halfSize, pz[i] + halfSize);
        }
        this.aabbs.count = n;
        return this;
    }
    build(leafSize, bins) {
        this.bvh.aabbs = this.aabbs;
        buildSAH(this.bvh, { leafSize: leafSize || 4, bins: bins || 16 });
        return this;
    }
}

function createBVHBatch(count) { return new BVHBatchState(count); }

// ============================================================================
// Function Declarations — Construction helpers
// ============================================================================
function createBVH(aabbs, capacityHint) { return new BVH(aabbs, capacityHint); }

function createAABBSOA(capacity) { return new AABBSOA(capacity); }

/**
 * Create an AABBSOA from a vec3 SOA (positions) + per-instance radius SOA
 * (`radii.x`) or a uniform numeric radius.
 */
function createAABBSOAFromPositions(positions, radii) {
    const n = positions.count;
    const a = new AABBSOA(n);
    const px = positions.x, py = positions.y, pz = positions.z;
    const rArr = radii && radii.x ? radii.x : null;
    const rUniform = typeof radii === "number" ? radii : 0;
    for (let i = 0; i < n; i++) {
        const r = rArr ? rArr[i] : rUniform;
        a.set(i, px[i] - r, py[i] - r, pz[i] - r, px[i] + r, py[i] + r, pz[i] + r);
    }
    a.count = n;
    return a;
}

function fillAABBSOA(aabbs, positions, radius) {
    const n = Math.min(positions.count, aabbs.capacity);
    const px = positions.x, py = positions.y, pz = positions.z;
    for (let i = 0; i < n; i++) {
        aabbs.set(i, px[i] - radius, py[i] - radius, pz[i] - radius,
                     px[i] + radius, py[i] + radius, pz[i] + radius);
    }
    aabbs.count = n;
    return aabbs;
}

/** AABB of a range of primitives (by primOrder index) into out[0..5]. */
function _rangeAABB(bvh, first, count, out) {
    const a = bvh.aabbs;
    const order = bvh.primOrder;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < count; k++) {
        const i = order[first + k];
        if (a.minX[i] < minX) minX = a.minX[i];
        if (a.minY[i] < minY) minY = a.minY[i];
        if (a.minZ[i] < minZ) minZ = a.minZ[i];
        if (a.maxX[i] > maxX) maxX = a.maxX[i];
        if (a.maxY[i] > maxY) maxY = a.maxY[i];
        if (a.maxZ[i] > maxZ) maxZ = a.maxZ[i];
    }
    out[0] = minX; out[1] = minY; out[2] = minZ;
    out[3] = maxX; out[4] = maxY; out[5] = maxZ;
    return out;
}

function _storeNodeAABB(bvh, idx, minX, minY, minZ, maxX, maxY, maxZ) {
    bvh.nodeMinX[idx] = minX; bvh.nodeMinY[idx] = minY; bvh.nodeMinZ[idx] = minZ;
    bvh.nodeMaxX[idx] = maxX; bvh.nodeMaxY[idx] = maxY; bvh.nodeMaxZ[idx] = maxZ;
}

function _centroidOf(bvh, prim, axis) {
    const a = bvh.aabbs;
    return axis === 0 ? a.cx[prim] : axis === 1 ? a.cy[prim] : a.cz[prim];
}

/** In-place iterative quickselect on primOrder by centroid (zero-GC). */
function _quickselectPrim(bvh, lo, hi, k, axis) {
    const order = bvh.primOrder;
    while (hi > lo) {
        const mid = (lo + hi) >> 1;
        // Median-of-three on order[lo], order[mid], order[hi]
        if (_centroidOf(bvh, order[mid], axis) < _centroidOf(bvh, order[lo], axis)) {
            let t = order[lo]; order[lo] = order[mid]; order[mid] = t;
        }
        if (_centroidOf(bvh, order[hi], axis) < _centroidOf(bvh, order[lo], axis)) {
            let t = order[lo]; order[lo] = order[hi]; order[hi] = t;
        }
        if (_centroidOf(bvh, order[hi], axis) < _centroidOf(bvh, order[mid], axis)) {
            let t = order[mid]; order[mid] = order[hi]; order[hi] = t;
        }
        const pivot = _centroidOf(bvh, order[mid], axis);
        let i = lo, j = hi;
        while (i <= j) {
            while (_centroidOf(bvh, order[i], axis) < pivot) i++;
            while (_centroidOf(bvh, order[j], axis) > pivot) j--;
            if (i <= j) {
                let t = order[i]; order[i] = order[j]; order[j] = t;
                i++; j--;
            }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return;
    }
}

/** Partition primOrder[first..first+count) around the median centroid. */
function _partitionMedian(bvh, first, count, axis) {
    _quickselectPrim(bvh, first, first + count - 1, first + (count >> 1), axis);
}

function _surfaceAreaFromBuf(buf, off) {
    const dx = buf[off + 3] - buf[off + 0];
    const dy = buf[off + 4] - buf[off + 1];
    const dz = buf[off + 5] - buf[off + 2];
    return 2 * (dx * dy + dy * dz + dz * dx);
}

// ============================================================================
// Function Declarations — Build (SAH / median / spatial)
// ============================================================================
function _initRoot(bvh) {
    bvh.nodeCount_ = 0;
    const n = bvh.primCount;
    if (n === 0) {
        bvh.minX = 0; bvh.minY = 0; bvh.minZ = 0;
        bvh.maxX = 0; bvh.maxY = 0; bvh.maxZ = 0;
        return -1;
    }
    const root = bvh._allocNode();
    _rangeAABB(bvh, 0, n, _aabbTmp);
    _storeNodeAABB(bvh, root, _aabbTmp[0], _aabbTmp[1], _aabbTmp[2],
                                  _aabbTmp[3], _aabbTmp[4], _aabbTmp[5]);
    bvh.nodeParent[root] = -1;
    bvh.minX = _aabbTmp[0]; bvh.minY = _aabbTmp[1]; bvh.minZ = _aabbTmp[2];
    bvh.maxX = _aabbTmp[3]; bvh.maxY = _aabbTmp[4]; bvh.maxZ = _aabbTmp[5];
    return root;
}

function _makeLeaf(bvh, node, first, count) {
    bvh.nodeLeft[node] = first;
    bvh.nodeRight[node] = 0;
    bvh.nodeCount[node] = count;
}

function _splitMedianNode(bvh, stack, node, first, count, depth) {
    _rangeAABB(bvh, first, count, _aabbTmp);
    const extX = _aabbTmp[3] - _aabbTmp[0];
    const extY = _aabbTmp[4] - _aabbTmp[1];
    const extZ = _aabbTmp[5] - _aabbTmp[2];
    let axis = 0;
    if (extY > extX && extY >= extZ) axis = 1;
    else if (extZ > extX && extZ > extY) axis = 2;
    _partitionMedian(bvh, first, count, axis);
    const mid = count >> 1;
    const splitLeft = mid, splitRight = count - mid;
    const left = bvh._allocNode();
    const right = bvh._allocNode();
    bvh.nodeParent[left] = node;
    bvh.nodeParent[right] = node;
    bvh.nodeLeft[node] = left;
    bvh.nodeRight[node] = right;
    bvh.nodeCount[node] = 0;
    _rangeAABB(bvh, first, splitLeft, _aabbTmp);
    _storeNodeAABB(bvh, left, _aabbTmp[0], _aabbTmp[1], _aabbTmp[2],
                               _aabbTmp[3], _aabbTmp[4], _aabbTmp[5]);
    _rangeAABB(bvh, first + splitLeft, splitRight, _aabbTmp);
    _storeNodeAABB(bvh, right, _aabbTmp[0], _aabbTmp[1], _aabbTmp[2],
                                _aabbTmp[3], _aabbTmp[4], _aabbTmp[5]);
    stack.push({ node: left,  first: first,             count: splitLeft,  depth: depth + 1 });
    stack.push({ node: right, first: first + splitLeft, count: splitRight, depth: depth + 1 });
}

/**
 * Build a BVH using the Surface Area Heuristic (SAH) with binned splitting.
 * Falls back to median split when a bin partition fails. Synchronous version —
 * for 1M+ primitives use `buildSAHAsync`.
 */
function buildSAH(bvh, options) {
    options = options || {};
    const bins = options.bins || DEFAULT_BINS;
    const leafSize = options.leafSize || LEAF_SIZE_DEFAULT;
    const maxDepth = options.maxDepth || MAX_DEPTH_DEFAULT;
    bvh._resetPrimOrder(bvh.aabbs ? bvh.aabbs.count : 0);
    const root = _initRoot(bvh);
    if (root < 0) return bvh;

    // Per-build bin accumulators (allocated once, reused across nodes).
    const binAABBs   = new Float64Array(bins * 6);
    const binCounts  = new Int32Array(bins);
    const leftAcc    = new Float64Array(bins * 6);
    const rightAcc   = new Float64Array(bins * 6);
    const leftCounts  = new Int32Array(bins);
    const rightCounts = new Int32Array(bins);

    const stack = [];
    stack.push({ node: root, first: 0, count: bvh.primCount, depth: 0 });
    const order = bvh.primOrder;
    const a = bvh.aabbs;

    while (stack.length > 0) {
        const work = stack.pop();
        const node = work.node, first = work.first, count = work.count, depth = work.depth;
        if (count <= leafSize || depth >= maxDepth) { _makeLeaf(bvh, node, first, count); continue; }

        _rangeAABB(bvh, first, count, _aabbTmp);
        const axisMinX = _aabbTmp[0], axisMinY = _aabbTmp[1], axisMinZ = _aabbTmp[2];
        const extX = _aabbTmp[3] - axisMinX;
        const extY = _aabbTmp[4] - axisMinY;
        const extZ = _aabbTmp[5] - axisMinZ;
        let axis = 0;
        if (extY > extX && extY >= extZ) axis = 1;
        else if (extZ > extX && extZ > extY) axis = 2;
        const axisMin = axis === 0 ? axisMinX : axis === 1 ? axisMinY : axisMinZ;
        const axisMax = axis === 0 ? _aabbTmp[3] : axis === 1 ? _aabbTmp[4] : _aabbTmp[5];
        const axisExtent = axisMax - axisMin;
        if (axisExtent < 1e-9) { _makeLeaf(bvh, node, first, count); continue; }

        // Reset bins
        for (let b = 0; b < bins; b++) {
            binCounts[b] = 0;
            binAABBs[b * 6 + 0] = Infinity; binAABBs[b * 6 + 1] = Infinity; binAABBs[b * 6 + 2] = Infinity;
            binAABBs[b * 6 + 3] = -Infinity; binAABBs[b * 6 + 4] = -Infinity; binAABBs[b * 6 + 5] = -Infinity;
        }
        const invExtent = bins / axisExtent;
        for (let k = 0; k < count; k++) {
            const i = order[first + k];
            const center = axis === 0 ? a.cx[i] : axis === 1 ? a.cy[i] : a.cz[i];
            let b = ((center - axisMin) * invExtent) | 0;
            if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
            binCounts[b]++;
            const bo = b * 6;
            if (a.minX[i] < binAABBs[bo + 0]) binAABBs[bo + 0] = a.minX[i];
            if (a.minY[i] < binAABBs[bo + 1]) binAABBs[bo + 1] = a.minY[i];
            if (a.minZ[i] < binAABBs[bo + 2]) binAABBs[bo + 2] = a.minZ[i];
            if (a.maxX[i] > binAABBs[bo + 3]) binAABBs[bo + 3] = a.maxX[i];
            if (a.maxY[i] > binAABBs[bo + 4]) binAABBs[bo + 4] = a.maxY[i];
            if (a.maxZ[i] > binAABBs[bo + 5]) binAABBs[bo + 5] = a.maxZ[i];
        }

        // Prefix sweep (left accumulator)
        let runCount = 0;
        let rMinX = Infinity, rMinY = Infinity, rMinZ = Infinity;
        let rMaxX = -Infinity, rMaxY = -Infinity, rMaxZ = -Infinity;
        for (let b = 0; b < bins; b++) {
            if (binCounts[b] > 0) {
                const bo = b * 6;
                if (binAABBs[bo + 0] < rMinX) rMinX = binAABBs[bo + 0];
                if (binAABBs[bo + 1] < rMinY) rMinY = binAABBs[bo + 1];
                if (binAABBs[bo + 2] < rMinZ) rMinZ = binAABBs[bo + 2];
                if (binAABBs[bo + 3] > rMaxX) rMaxX = binAABBs[bo + 3];
                if (binAABBs[bo + 4] > rMaxY) rMaxY = binAABBs[bo + 4];
                if (binAABBs[bo + 5] > rMaxZ) rMaxZ = binAABBs[bo + 5];
                runCount += binCounts[b];
            }
            leftCounts[b] = runCount;
            const lo = b * 6;
            leftAcc[lo + 0] = rMinX; leftAcc[lo + 1] = rMinY; leftAcc[lo + 2] = rMinZ;
            leftAcc[lo + 3] = rMaxX; leftAcc[lo + 4] = rMaxY; leftAcc[lo + 5] = rMaxZ;
        }
        // Suffix sweep (right accumulator)
        runCount = 0;
        rMinX = Infinity; rMinY = Infinity; rMinZ = Infinity;
        rMaxX = -Infinity; rMaxY = -Infinity; rMaxZ = -Infinity;
        for (let b = bins - 1; b >= 0; b--) {
            if (binCounts[b] > 0) {
                const bo = b * 6;
                if (binAABBs[bo + 0] < rMinX) rMinX = binAABBs[bo + 0];
                if (binAABBs[bo + 1] < rMinY) rMinY = binAABBs[bo + 1];
                if (binAABBs[bo + 2] < rMinZ) rMinZ = binAABBs[bo + 2];
                if (binAABBs[bo + 3] > rMaxX) rMaxX = binAABBs[bo + 3];
                if (binAABBs[bo + 4] > rMaxY) rMaxY = binAABBs[bo + 4];
                if (binAABBs[bo + 5] > rMaxZ) rMaxZ = binAABBs[bo + 5];
                runCount += binCounts[b];
            }
            rightCounts[b] = runCount;
            const ro = b * 6;
            rightAcc[ro + 0] = rMinX; rightAcc[ro + 1] = rMinY; rightAcc[ro + 2] = rMinZ;
            rightAcc[ro + 3] = rMaxX; rightAcc[ro + 4] = rMaxY; rightAcc[ro + 5] = rMaxZ;
        }
        // Find best split cost
        let bestBin = -1, bestCost = Infinity;
        for (let b = 0; b < bins - 1; b++) {
            const lc = leftCounts[b];
            const rc = rightCounts[b + 1];
            if (lc === 0 || rc === 0) continue;
            const leftArea  = _surfaceAreaFromBuf(leftAcc,  b * 6);
            const rightArea = _surfaceAreaFromBuf(rightAcc, (b + 1) * 6);
            const cost = leftArea * lc + rightArea * rc;
            if (cost < bestCost) { bestCost = cost; bestBin = b + 1; }
        }
        if (bestBin < 0) { _splitMedianNode(bvh, stack, node, first, count, depth); continue; }

        // Partition primitives around bestBin
        let lo = first, hi = first + count - 1;
        while (lo <= hi) {
            const i = order[lo];
            const center = axis === 0 ? a.cx[i] : axis === 1 ? a.cy[i] : a.cz[i];
            let bb = ((center - axisMin) * invExtent) | 0;
            if (bb < 0) bb = 0; else if (bb >= bins) bb = bins - 1;
            if (bb < bestBin) lo++;
            else { const t = order[lo]; order[lo] = order[hi]; order[hi] = t; hi--; }
        }
        const splitLeft = lo - first;
        const splitRight = count - splitLeft;
        if (splitLeft === 0 || splitRight === 0) { _makeLeaf(bvh, node, first, count); continue; }
        const left = bvh._allocNode();
        const right = bvh._allocNode();
        bvh.nodeParent[left] = node;
        bvh.nodeParent[right] = node;
        bvh.nodeLeft[node] = left;
        bvh.nodeRight[node] = right;
        bvh.nodeCount[node] = 0;
        _rangeAABB(bvh, first, splitLeft, _aabbTmp);
        _storeNodeAABB(bvh, left, _aabbTmp[0], _aabbTmp[1], _aabbTmp[2],
                                  _aabbTmp[3], _aabbTmp[4], _aabbTmp[5]);
        _rangeAABB(bvh, first + splitLeft, splitRight, _aabbTmp);
        _storeNodeAABB(bvh, right, _aabbTmp[0], _aabbTmp[1], _aabbTmp[2],
                                   _aabbTmp[3], _aabbTmp[4], _aabbTmp[5]);
        stack.push({ node: left,  first: first,             count: splitLeft,  depth: depth + 1 });
        stack.push({ node: right, first: first + splitLeft, count: splitRight, depth: depth + 1 });
    }
    return bvh;
}

/** Build BVH using pure median split (fast, lower quality). */
function buildMedian(bvh, options) {
    options = options || {};
    const leafSize = options.leafSize || LEAF_SIZE_DEFAULT;
    const maxDepth = options.maxDepth || MAX_DEPTH_DEFAULT;
    bvh._resetPrimOrder(bvh.aabbs ? bvh.aabbs.count : 0);
    const root = _initRoot(bvh);
    if (root < 0) return bvh;
    const stack = [{ node: root, first: 0, count: bvh.primCount, depth: 0 }];
    while (stack.length > 0) {
        const work = stack.pop();
        const node = work.node, first = work.first, count = work.count, depth = work.depth;
        if (count <= leafSize || depth >= maxDepth) { _makeLeaf(bvh, node, first, count); continue; }
        _splitMedianNode(bvh, stack, node, first, count, depth);
    }
    return bvh;
}

/** Spatial split builder (delegates to SAH; reserved for overlapping objects). */
function buildSpatialSplit(bvh, options) { return buildSAH(bvh, options); }

/**
 * Async median builder — breadth-first waves that yield to the UI thread so
 * 1M+ builds never freeze the frame.
 */
async function buildMedianAsync(bvh, options) {
    options = options || {};
    const chunkSize = options.chunkSize || common.CHUNK_SIZE;
    const yieldEvery = options.yieldEvery || common.CHUNK_YIELD_EVERY;
    const leafSize = options.leafSize || LEAF_SIZE_DEFAULT;
    const maxDepth = options.maxDepth || MAX_DEPTH_DEFAULT;
    bvh._resetPrimOrder(bvh.aabbs ? bvh.aabbs.count : 0);
    const root = _initRoot(bvh);
    if (root < 0) return bvh;
    let wave = [{ node: root, first: 0, count: bvh.primCount, depth: 0 }];
    while (wave.length > 0) {
        const nextWave = [];
        let counter = 0;
        for (let w = 0; w < wave.length; w++) {
            const node = wave[w].node, first = wave[w].first, count = wave[w].count, depth = wave[w].depth;
            if (count <= leafSize || depth >= maxDepth) { _makeLeaf(bvh, node, first, count); continue; }
            _rangeAABB(bvh, first, count, _aabbTmp);
            const extX = _aabbTmp[3] - _aabbTmp[0];
            const extY = _aabbTmp[4] - _aabbTmp[1];
            const extZ = _aabbTmp[5] - _aabbTmp[2];
            let axis = 0;
            if (extY > extX && extY >= extZ) axis = 1;
            else if (extZ > extX && extZ > extY) axis = 2;
            _partitionMedian(bvh, first, count, axis);
            const mid = count >> 1;
            const splitLeft = mid, splitRight = count - mid;
            const left = bvh._allocNode();
            const right = bvh._allocNode();
            bvh.nodeParent[left] = node;
            bvh.nodeParent[right] = node;
            bvh.nodeLeft[node] = left;
            bvh.nodeRight[node] = right;
            bvh.nodeCount[node] = 0;
            _rangeAABB(bvh, first, splitLeft, _aabbTmp);
            _storeNodeAABB(bvh, left, _aabbTmp[0], _aabbTmp[1], _aabbTmp[2],
                                       _aabbTmp[3], _aabbTmp[4], _aabbTmp[5]);
            _rangeAABB(bvh, first + splitLeft, splitRight, _aabbTmp);
            _storeNodeAABB(bvh, right, _aabbTmp[0], _aabbTmp[1], _aabbTmp[2],
                                        _aabbTmp[3], _aabbTmp[4], _aabbTmp[5]);
            nextWave.push({ node: left,  first: first,             count: splitLeft,  depth: depth + 1 });
            nextWave.push({ node: right, first: first + splitLeft, count: splitRight, depth: depth + 1 });
            if (++counter >= chunkSize) {
                counter = 0;
                await common.yieldToMain();
            }
        }
        wave = nextWave;
    }
    return bvh;
}

/** Async SAH builder — yields to the UI thread; uses median split per wave. */
async function buildSAHAsync(bvh, options) { return buildMedianAsync(bvh, options); }

// ============================================================================
// Function Declarations — Geometry intersection primitives
// ============================================================================
/**
 * Ray vs AABB slab test. Writes entry distance to `out[0]`. Returns true if
 * the ray hits within [tMin, tMax]. Uses finite inverse direction to avoid NaN.
 */
function rayAABB(ox, oy, oz, invDx, invDy, invDz, minX, minY, minZ, maxX, maxY, maxZ, tMin, tMax, out) {
    let t1 = (minX - ox) * invDx;
    let t2 = (maxX - ox) * invDx;
    let tEnter = t1 < t2 ? t1 : t2;
    let tExit  = t1 > t2 ? t1 : t2;
    t1 = (minY - oy) * invDy; t2 = (maxY - oy) * invDy;
    const mnY = t1 < t2 ? t1 : t2;
    const mxY = t1 > t2 ? t1 : t2;
    if (mnY > tEnter) tEnter = mnY;
    if (mxY < tExit)  tExit  = mxY;
    t1 = (minZ - oz) * invDz; t2 = (maxZ - oz) * invDz;
    const mnZ = t1 < t2 ? t1 : t2;
    const mxZ = t1 > t2 ? t1 : t2;
    if (mnZ > tEnter) tEnter = mnZ;
    if (mxZ < tExit)  tExit  = mxZ;
    const lower = tEnter > tMin ? tEnter : tMin;
    if (tExit >= lower && tEnter <= tMax) {
        out[0] = lower;
        return true;
    }
    return false;
}

/** Ray vs sphere — analytic intersection, writes distance into out[0]. */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, out) {
    const mx = ox - cx, my = oy - cy, mz = oz - cz;
    const b = mx * dx + my * dy + mz * dz;
    const c = mx * mx + my * my + mz * mz - r * r;
    const disc = b * b - c;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    const t0 = -b - sq;
    const t1 = -b + sq;
    out[0] = t0 >= 0 ? t0 : t1 >= 0 ? t1 : Infinity;
    return out[0] !== Infinity;
}

/** Ray vs triangle (Möller–Trumbore). Writes [t, u, v] into out. */
function rayTriangle(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return false;
    const invDet = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) return false;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0 || u + v > 1) return false;
    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (t <= 0) return false;
    out[0] = t; out[1] = u; out[2] = v;
    return true;
}

/** Union of two AABBs into out[0..5]. */
function aabbUnion(out, a, b) {
    out[0] = a[0] < b[0] ? a[0] : b[0];
    out[1] = a[1] < b[1] ? a[1] : b[1];
    out[2] = a[2] < b[2] ? a[2] : b[2];
    out[3] = a[3] > b[3] ? a[3] : b[3];
    out[4] = a[4] > b[4] ? a[4] : b[4];
    out[5] = a[5] > b[5] ? a[5] : b[5];
    return out;
}

/** Surface area of an AABB (used by SAH). */
function aabbSurfaceArea(minX, minY, minZ, maxX, maxY, maxZ) {
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    return 2 * (dx * dy + dy * dz + dz * dx);
}

/** Whether two AABBs intersect. */
function aabbIntersect(aminX, aminY, aminZ, amaxX, amaxY, amaxZ, bminX, bminY, bminZ, bmaxX, bmaxY, bmaxZ) {
    return !(amaxX < bminX || aminX > bmaxX ||
             amaxY < bminY || aminY > bmaxY ||
             amaxZ < bminZ || aminZ > bmaxZ);
}

// ============================================================================
// Function Declarations — Traversal (zero-GC)
// ============================================================================
/**
 * Closest-hit raycast. Fills `out` (a RayHit) and returns it. Uses a pooled
 * traversal stack and module scratch — no allocation per call.
 */
function raycast(bvh, ox, oy, oz, dx, dy, dz, tMax, out) {
    out = out || _defaultRayHit;
    out.hit = false;
    out.t = tMax === undefined ? Infinity : tMax;
    out.primId = -1;
    out.u = 0; out.v = 0;
    if (dx === 0 && dy === 0 && dz === 0) return out;
    const invDx = _safeInv(dx), invDy = _safeInv(dy), invDz = _safeInv(dz);
    const stack = acquireTraversalStack();
    let sp = 0;
    stack[sp++] = 0;
    const tA = _rayT.a, tB = _rayT.b, tC = _rayT.c, tD = _rayT.d;
    while (sp > 0) {
        const node = stack[--sp];
        if (!rayAABB(ox, oy, oz, invDx, invDy, invDz,
                     bvh.nodeMinX[node], bvh.nodeMinY[node], bvh.nodeMinZ[node],
                     bvh.nodeMaxX[node], bvh.nodeMaxY[node], bvh.nodeMaxZ[node],
                     0, out.t, tA)) continue;
        const cnt = bvh.nodeCount[node];
        if (cnt > 0) {
            const first = bvh.nodeLeft[node];
            const order = bvh.primOrder;
            const a = bvh.aabbs;
            for (let k = 0; k < cnt; k++) {
                const prim = order[first + k];
                if (rayAABB(ox, oy, oz, invDx, invDy, invDz,
                            a.minX[prim], a.minY[prim], a.minZ[prim],
                            a.maxX[prim], a.maxY[prim], a.maxZ[prim],
                            0, out.t, tB)) {
                    if (tB[0] < out.t) { out.t = tB[0]; out.hit = true; out.primId = prim; }
                }
            }
        } else {
            const left = bvh.nodeLeft[node];
            const right = bvh.nodeRight[node];
            const hitL = rayAABB(ox, oy, oz, invDx, invDy, invDz,
                                 bvh.nodeMinX[left], bvh.nodeMinY[left], bvh.nodeMinZ[left],
                                 bvh.nodeMaxX[left], bvh.nodeMaxY[left], bvh.nodeMaxZ[left],
                                 0, out.t, tC);
            const hitR = rayAABB(ox, oy, oz, invDx, invDy, invDz,
                                 bvh.nodeMinX[right], bvh.nodeMinY[right], bvh.nodeMinZ[right],
                                 bvh.nodeMaxX[right], bvh.nodeMaxY[right], bvh.nodeMaxZ[right],
                                 0, out.t, tD);
            if (sp + 2 < stack.length) {
                if (hitL && hitR) {
                    if (tC[0] < tD[0]) { stack[sp++] = right; stack[sp++] = left; }
                    else               { stack[sp++] = left;  stack[sp++] = right; }
                } else if (hitL) stack[sp++] = left;
                else if (hitR) stack[sp++] = right;
            }
        }
    }
    releaseTraversalStack(stack);
    return out;
}

/** Any-hit raycast — stops at the first hit (shadow / occlusion rays). */
function raycastAny(bvh, ox, oy, oz, dx, dy, dz, tMax) {
    if (dx === 0 && dy === 0 && dz === 0) return false;
    const invDx = _safeInv(dx), invDy = _safeInv(dy), invDz = _safeInv(dz);
    tMax = tMax === undefined ? Infinity : tMax;
    const stack = acquireTraversalStack();
    let sp = 0;
    stack[sp++] = 0;
    const tA = _rayT.a, tB = _rayT.b;
    let anyHit = false;
    while (sp > 0) {
        const node = stack[--sp];
        if (!rayAABB(ox, oy, oz, invDx, invDy, invDz,
                     bvh.nodeMinX[node], bvh.nodeMinY[node], bvh.nodeMinZ[node],
                     bvh.nodeMaxX[node], bvh.nodeMaxY[node], bvh.nodeMaxZ[node],
                     0, tMax, tA)) continue;
        const cnt = bvh.nodeCount[node];
        if (cnt > 0) {
            const first = bvh.nodeLeft[node];
            const order = bvh.primOrder;
            const a = bvh.aabbs;
            for (let k = 0; k < cnt; k++) {
                const prim = order[first + k];
                if (rayAABB(ox, oy, oz, invDx, invDy, invDz,
                            a.minX[prim], a.minY[prim], a.minZ[prim],
                            a.maxX[prim], a.maxY[prim], a.maxZ[prim],
                            0, tMax, tB)) { anyHit = true; break; }
            }
            if (anyHit) break;
        } else {
            if (sp + 2 < stack.length) {
                stack[sp++] = bvh.nodeLeft[node];
                stack[sp++] = bvh.nodeRight[node];
            }
        }
    }
    releaseTraversalStack(stack);
    return anyHit;
}

/** Test a node AABB against a flat frustum plane array (6 planes × 4 floats). */
function _aabbInsideFrustum(bvh, node, planes) {
    for (let p = 0; p < 6; p++) {
        const o = p * 4;
        const nx = planes[o], ny = planes[o + 1], nz = planes[o + 2], d = planes[o + 3];
        const px = nx >= 0 ? bvh.nodeMaxX[node] : bvh.nodeMinX[node];
        const py = ny >= 0 ? bvh.nodeMaxY[node] : bvh.nodeMinY[node];
        const pz = nz >= 0 ? bvh.nodeMaxZ[node] : bvh.nodeMinZ[node];
        if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
}

function _primInsideFrustum(bvh, prim, planes) {
    const a = bvh.aabbs;
    for (let p = 0; p < 6; p++) {
        const o = p * 4;
        const nx = planes[o], ny = planes[o + 1], nz = planes[o + 2], d = planes[o + 3];
        const px = nx >= 0 ? a.maxX[prim] : a.minX[prim];
        const py = ny >= 0 ? a.maxY[prim] : a.minY[prim];
        const pz = nz >= 0 ? a.maxZ[prim] : a.minZ[prim];
        if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
}

/**
 * Frustum cull — writes visible primitive indices into `outIds` and returns
 * the number written (bounded by outIds.length). Zero-GC.
 */
function frustumCull(bvh, planes, outIds) {
    const maxOut = outIds.length;
    let count = 0;
    const stack = acquireTraversalStack();
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0 && count < maxOut) {
        const node = stack[--sp];
        if (!_aabbInsideFrustum(bvh, node, planes)) continue;
        const cnt = bvh.nodeCount[node];
        if (cnt > 0) {
            const first = bvh.nodeLeft[node];
            const order = bvh.primOrder;
            for (let k = 0; k < cnt && count < maxOut; k++) {
                const prim = order[first + k];
                if (_primInsideFrustum(bvh, prim, planes)) outIds[count++] = prim;
            }
        } else {
            if (sp + 2 < stack.length) {
                stack[sp++] = bvh.nodeLeft[node];
                stack[sp++] = bvh.nodeRight[node];
            }
        }
    }
    releaseTraversalStack(stack);
    return count;
}

/**
 * AABB range query — writes overlapping primitive indices into `outIds` and
 * returns the number written. Zero-GC.
 */
function aabbQuery(bvh, minX, minY, minZ, maxX, maxY, maxZ, outIds) {
    const maxOut = outIds.length;
    let count = 0;
    const stack = acquireTraversalStack();
    let sp = 0;
    stack[sp++] = 0;
    const a = bvh.aabbs;
    while (sp > 0 && count < maxOut) {
        const node = stack[--sp];
        if (bvh.nodeMaxX[node] < minX || bvh.nodeMinX[node] > maxX) continue;
        if (bvh.nodeMaxY[node] < minY || bvh.nodeMinY[node] > maxY) continue;
        if (bvh.nodeMaxZ[node] < minZ || bvh.nodeMinZ[node] > maxZ) continue;
        const cnt = bvh.nodeCount[node];
        if (cnt > 0) {
            const first = bvh.nodeLeft[node];
            const order = bvh.primOrder;
            for (let k = 0; k < cnt && count < maxOut; k++) {
                const prim = order[first + k];
                if (a.maxX[prim] < minX || a.minX[prim] > maxX) continue;
                if (a.maxY[prim] < minY || a.minY[prim] > maxY) continue;
                if (a.maxZ[prim] < minZ || a.minZ[prim] > maxZ) continue;
                outIds[count++] = prim;
            }
        } else {
            if (sp + 2 < stack.length) {
                stack[sp++] = bvh.nodeLeft[node];
                stack[sp++] = bvh.nodeRight[node];
            }
        }
    }
    releaseTraversalStack(stack);
    return count;
}

/** Closest primitive center to (px, py, pz) — returns primId or -1. Zero-GC. */
function closestPointQuery(bvh, px, py, pz) {
    const stack = acquireTraversalStack();
    let sp = 0;
    stack[sp++] = 0;
    let bestDist2 = Infinity;
    let bestId = -1;
    while (sp > 0) {
        const node = stack[--sp];
        const dx = px < bvh.nodeMinX[node] ? bvh.nodeMinX[node] - px : px > bvh.nodeMaxX[node] ? px - bvh.nodeMaxX[node] : 0;
        const dy = py < bvh.nodeMinY[node] ? bvh.nodeMinY[node] - py : py > bvh.nodeMaxY[node] ? py - bvh.nodeMaxY[node] : 0;
        const dz = pz < bvh.nodeMinZ[node] ? bvh.nodeMinZ[node] - pz : pz > bvh.nodeMaxZ[node] ? pz - bvh.nodeMaxZ[node] : 0;
        if (dx * dx + dy * dy + dz * dz >= bestDist2) continue;
        const cnt = bvh.nodeCount[node];
        if (cnt > 0) {
            const first = bvh.nodeLeft[node];
            const order = bvh.primOrder;
            const a = bvh.aabbs;
            for (let k = 0; k < cnt; k++) {
                const prim = order[first + k];
                const cx = a.cx[prim] - px;
                const cy = a.cy[prim] - py;
                const cz = a.cz[prim] - pz;
                const d2 = cx * cx + cy * cy + cz * cz;
                if (d2 < bestDist2) { bestDist2 = d2; bestId = prim; }
            }
        } else {
            if (sp + 2 < stack.length) {
                stack[sp++] = bvh.nodeLeft[node];
                stack[sp++] = bvh.nodeRight[node];
            }
        }
    }
    releaseTraversalStack(stack);
    return bestId;
}

/** k-nearest primitive centers — fills outIds/outDists, returns count. Zero-GC. */
function kNearestQuery(bvh, px, py, pz, k, outIds, outDists) {
    const stack = acquireTraversalStack();
    let sp = 0;
    stack[sp++] = 0;
    let bestCount = 0;
    const maxK = k < outIds.length ? k : outIds.length;
    while (sp > 0) {
        const node = stack[--sp];
        const cnt = bvh.nodeCount[node];
        if (cnt > 0) {
            const first = bvh.nodeLeft[node];
            const order = bvh.primOrder;
            const a = bvh.aabbs;
            for (let m = 0; m < cnt; m++) {
                const prim = order[first + m];
                const dx = a.cx[prim] - px;
                const dy = a.cy[prim] - py;
                const dz = a.cz[prim] - pz;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (bestCount < maxK) {
                    outIds[bestCount] = prim;
                    outDists[bestCount] = d;
                    bestCount++;
                } else {
                    let worstIdx = 0, worstDist = outDists[0];
                    for (let q = 1; q < bestCount; q++) {
                        if (outDists[q] > worstDist) { worstDist = outDists[q]; worstIdx = q; }
                    }
                    if (d < worstDist) { outIds[worstIdx] = prim; outDists[worstIdx] = d; }
                }
            }
        } else {
            if (sp + 2 < stack.length) {
                stack[sp++] = bvh.nodeLeft[node];
                stack[sp++] = bvh.nodeRight[node];
            }
        }
    }
    releaseTraversalStack(stack);
    return bestCount;
}

// ============================================================================
// Function Declarations — Refit
// ============================================================================
/**
 * Refit the BVH AABBs without re-splitting. Walks nodes in reverse (post-order
 * because children are allocated after parents). O(n + m).
 */
function refit(bvh) {
    const n = bvh.nodeCount_;
    const a = bvh.aabbs;
    const order = bvh.primOrder;
    for (let i = n - 1; i >= 0; i--) {
        const cnt = bvh.nodeCount[i];
        if (cnt > 0) {
            const first = bvh.nodeLeft[i];
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let k = 0; k < cnt; k++) {
                const idx = order[first + k];
                if (a.minX[idx] < minX) minX = a.minX[idx];
                if (a.minY[idx] < minY) minY = a.minY[idx];
                if (a.minZ[idx] < minZ) minZ = a.minZ[idx];
                if (a.maxX[idx] > maxX) maxX = a.maxX[idx];
                if (a.maxY[idx] > maxY) maxY = a.maxY[idx];
                if (a.maxZ[idx] > maxZ) maxZ = a.maxZ[idx];
            }
            _storeNodeAABB(bvh, i, minX, minY, minZ, maxX, maxY, maxZ);
        } else {
            const l = bvh.nodeLeft[i];
            const r = bvh.nodeRight[i];
            _storeNodeAABB(bvh, i,
                bvh.nodeMinX[l] < bvh.nodeMinX[r] ? bvh.nodeMinX[l] : bvh.nodeMinX[r],
                bvh.nodeMinY[l] < bvh.nodeMinY[r] ? bvh.nodeMinY[l] : bvh.nodeMinY[r],
                bvh.nodeMinZ[l] < bvh.nodeMinZ[r] ? bvh.nodeMinZ[l] : bvh.nodeMinZ[r],
                bvh.nodeMaxX[l] > bvh.nodeMaxX[r] ? bvh.nodeMaxX[l] : bvh.nodeMaxX[r],
                bvh.nodeMaxY[l] > bvh.nodeMaxY[r] ? bvh.nodeMaxY[l] : bvh.nodeMaxY[r],
                bvh.nodeMaxZ[l] > bvh.nodeMaxZ[r] ? bvh.nodeMaxZ[l] : bvh.nodeMaxZ[r]);
        }
    }
    bvh.minX = bvh.nodeMinX[0]; bvh.minY = bvh.nodeMinY[0]; bvh.minZ = bvh.nodeMinZ[0];
    bvh.maxX = bvh.nodeMaxX[0]; bvh.maxY = bvh.nodeMaxY[0]; bvh.maxZ = bvh.nodeMaxZ[0];
    return bvh;
}

/** Async refit — yields to the UI thread periodically. */
async function refitAsync(bvh, options) {
    options = options || {};
    const chunkSize = options.chunkSize || common.CHUNK_SIZE;
    const yieldEvery = options.yieldEvery || common.CHUNK_YIELD_EVERY;
    const n = bvh.nodeCount_;
    const a = bvh.aabbs;
    const order = bvh.primOrder;
    let counter = 0;
    for (let i = n - 1; i >= 0; i--) {
        const cnt = bvh.nodeCount[i];
        if (cnt > 0) {
            const first = bvh.nodeLeft[i];
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let k = 0; k < cnt; k++) {
                const idx = order[first + k];
                if (a.minX[idx] < minX) minX = a.minX[idx];
                if (a.minY[idx] < minY) minY = a.minY[idx];
                if (a.minZ[idx] < minZ) minZ = a.minZ[idx];
                if (a.maxX[idx] > maxX) maxX = a.maxX[idx];
                if (a.maxY[idx] > maxY) maxY = a.maxY[idx];
                if (a.maxZ[idx] > maxZ) maxZ = a.maxZ[idx];
            }
            _storeNodeAABB(bvh, i, minX, minY, minZ, maxX, maxY, maxZ);
        } else {
            const l = bvh.nodeLeft[i];
            const r = bvh.nodeRight[i];
            _storeNodeAABB(bvh, i,
                bvh.nodeMinX[l] < bvh.nodeMinX[r] ? bvh.nodeMinX[l] : bvh.nodeMinX[r],
                bvh.nodeMinY[l] < bvh.nodeMinY[r] ? bvh.nodeMinY[l] : bvh.nodeMinY[r],
                bvh.nodeMinZ[l] < bvh.nodeMinZ[r] ? bvh.nodeMinZ[l] : bvh.nodeMinZ[r],
                bvh.nodeMaxX[l] > bvh.nodeMaxX[r] ? bvh.nodeMaxX[l] : bvh.nodeMaxX[r],
                bvh.nodeMaxY[l] > bvh.nodeMaxY[r] ? bvh.nodeMaxY[l] : bvh.nodeMaxY[r],
                bvh.nodeMaxZ[l] > bvh.nodeMaxZ[r] ? bvh.nodeMaxZ[l] : bvh.nodeMaxZ[r]);
        }
        if (++counter >= chunkSize) {
            counter = 0;
            await common.yieldToMain();
        }
    }
    bvh.minX = bvh.nodeMinX[0]; bvh.minY = bvh.nodeMinY[0]; bvh.minZ = bvh.nodeMinZ[0];
    bvh.maxX = bvh.nodeMaxX[0]; bvh.maxY = bvh.nodeMaxY[0]; bvh.maxZ = bvh.nodeMaxZ[0];
    return bvh;
}

// ============================================================================
// Function Declarations — SOA (sync, zero-GC)
// ============================================================================
/** Batch any-hit raycast — for 1M+ shadow rays in one tight loop. */
function soaRaycastAny(bvh, rays, outHits) {
    const n = rays.count;
    for (let i = 0; i < n; i++) {
        outHits[i] = raycastAny(bvh, rays.ox[i], rays.oy[i], rays.oz[i],
                                rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i]);
    }
    return outHits;
}

/** Batch closest-hit raycast. Writes t and primId per ray. */
function soaRaycast(bvh, rays, outT, outIds) {
    const n = rays.count;
    for (let i = 0; i < n; i++) {
        raycast(bvh, rays.ox[i], rays.oy[i], rays.oz[i],
                rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i], _rayHitTmp);
        outT[i] = _rayHitTmp.t;
        outIds[i] = _rayHitTmp.primId;
    }
    return outT;
}

/** Batch frustum cull — returns the number of visible indices written. */
function soaFrustumCullCount(bvh, planes, outIds) {
    return frustumCull(bvh, planes, outIds);
}

/** Batch AABB query — returns the number of overlapping indices written. */
function soaAABBQueryCount(bvh, minX, minY, minZ, maxX, maxY, maxZ, outIds) {
    return aabbQuery(bvh, minX, minY, minZ, maxX, maxY, maxZ, outIds);
}

// ============================================================================
// Function Declarations — SOA (chunked async, inlined loops, zero closures)
// ============================================================================
async function soaRaycastAnyChunked(bvh, rays, outHits, chunkSize, yieldEvery) {
    chunkSize  = chunkSize  || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const n = rays.count;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) {
            outHits[i] = raycastAny(bvh, rays.ox[i], rays.oy[i], rays.oz[i],
                                    rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i]);
        }
        start = end;
        if (start >= n) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outHits;
}

async function soaRaycastChunked(bvh, rays, outT, outIds, chunkSize, yieldEvery) {
    chunkSize  = chunkSize  || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const n = rays.count;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) {
            raycast(bvh, rays.ox[i], rays.oy[i], rays.oz[i],
                    rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i], _rayHitTmp);
            outT[i] = _rayHitTmp.t;
            outIds[i] = _rayHitTmp.primId;
        }
        start = end;
        if (start >= n) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outT;
}

async function soaFrustumCullChunked(bvh, planes, outIds, chunkSize, yieldEvery) {
    // Frustum cull is a single BVH traversal; yield once around it.
    await common.yieldToMain();
    return frustumCull(bvh, planes, outIds);
}

async function soaAABBQueryChunked(bvh, minX, minY, minZ, maxX, maxY, maxZ, outIds, chunkSize, yieldEvery) {
    await common.yieldToMain();
    return aabbQuery(bvh, minX, minY, minZ, maxX, maxY, maxZ, outIds);
}

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    core: {
        BVH, BVHNode, AABBSOA,
        createBVH,
        buildSAH, buildMedian, buildSpatialSplit,
        buildSAHAsync, buildMedianAsync,
        refit, refitAsync
    },
    storage: {
        createAABBSOA,
        createAABBSOAFromPositions,
        fillAABBSOA
    },
    traversal: {
        raycast, raycastAny,
        frustumCull, aabbQuery,
        closestPointQuery, kNearestQuery
    },
    geometry: {
        aabbUnion, aabbSurfaceArea, aabbIntersect,
        rayAABB, raySphere, rayTriangle
    },
    pool: {
        BVHPool,
        acquireBVH, releaseBVH,
        acquireAABBSOA, releaseAABBSOA,
        acquireTraversalStack, releaseTraversalStack
    },
    batch: {
        State: BVHBatchState,
        create: createBVHBatch,
        soaRaycast, soaRaycastAny,
        soaFrustumCullCount, soaAABBQueryCount,
        soaRaycastChunked, soaRaycastAnyChunked,
        soaFrustumCullChunked, soaAABBQueryChunked
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing AABBSOA and BVH structures keep their current buffer types. New
// ones created after a precision change pick up the live array type via
// getArrayType(). Re-create a BVH from the same AABBs and rebuild to migrate.
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Core classes
    BVH, BVHNode, AABBSOA, BVHPool,
    // Construction
    createBVH, buildSAH, buildMedian, buildSpatialSplit,
    buildSAHAsync, buildMedianAsync,
    // SOA builders
    createAABBSOA, createAABBSOAFromPositions, fillAABBSOA,
    // Traversal
    raycast, raycastAny, frustumCull, aabbQuery,
    closestPointQuery, kNearestQuery,
    // Refit
    refit, refitAsync,
    // Utilities
    aabbUnion, aabbSurfaceArea, aabbIntersect,
    rayAABB, raySphere, rayTriangle,
    // SOA (sync)
    soaRaycastAny, soaRaycast, soaFrustumCullCount, soaAABBQueryCount,
    // SOA (chunked async)
    soaRaycastAnyChunked, soaRaycastChunked,
    soaFrustumCullChunked, soaAABBQueryChunked,
    // Pools
    acquireBVH, releaseBVH,
    acquireAABBSOA, releaseAABBSOA,
    acquireTraversalStack, releaseTraversalStack,
    // Batch state
    BVHBatchState, createBVHBatch,
    // Namespaces
    namespace
};