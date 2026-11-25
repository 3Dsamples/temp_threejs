//File number : 070
// File : src/math/070_dynamic-bvh.js
//Description : Dynamic BVH (DBVH) — incremental insert / remove / update / refit / rebuild for 1M+ dynamic units, with fat AABB expansion and parent-link propagation. Provides BLAS (static per-mesh BVHs, reusing `069_bvh.js`) + TLAS (top-level dynamic BVH over instance transforms) two-level acceleration structure. Supports per-frame updates for 1M+ asteroids/crowd/particles/debris, ray/BVH traversal over the fused TLAS+BLAS tree, frustum culling of dynamic instances, bulk refit, and periodic SAH/median rebuild with cost-based trigger. All buffers use `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap) so the same code runs at mm or Mpc scale. Every mutable structure is stored as parallel SoA typed arrays. Pools, free-lists, and traversal stacks keep per-frame GC at zero. Chunked async variants yield via `scheduler.yield()` so 1M+ unit updates never freeze the Android 64-bit UI thread.
// Zero-GC Compliance : Strict adherence to the Enhanced Zero-GC ECS mandate. No closures, no array literals, no Map/Set, and no dynamic allocations in any hot loop. Spatial queries write into caller-provided `Uint32Array` buffers and return only an integer count (blueprint §42 correction). Traversal uses per-BVH preallocated stacks/order buffers. TLAS instance transforms are stored as 16 parallel SoA arrays. Chunked async kernels inline their loops (no per-call callbacks). All allocations occur exclusively at module init / pool growth / documented init-time builds.
//Corrections : ESM imports/exports only (no require/exports). Fixed corrupted identifiers/operators (`nodeCount` scalar overwritten by the node-count array, `nodeCap` vs `nodeCap_`, `le t`, `con st`, `Mat h`, `bvh.nod eMaxX`, broken SAH prefix code, and `Array.sort` comparator closures); removed the forbidden `Map` used for BLAS lookup; replaced object-returning query APIs with count-returning SoA out-buffer APIs; removed per-primitive array/object allocation in `updatePrim`; made primitive storage fully SoA (`primMinX..primMaxZ` via `AABBSOA`) instead of a flat 6-float AoS; rebuilt the dynamic tree refit with an explicit iterative post-order buffer instead of an O(freeCount) free-node scan; implemented a correct iterative median rebuild with in-place quickselect; fixed TLAS instance AABB generation to read SoA transform arrays; implemented true TLAS→BLAS ray transformation with a generic 4×4 inverse; removed the Set/forEach precision listener; removed all inline async closures.
//Added : SoA primitive insert/remove/update batches (`soaInsertPrims`, `soaRemovePrims`, `soaUpdatePrims` + chunked), SoA TLAS instance insert/update batches (`soaInsertInstances`, `soaUpdateInstances` + chunked), count-returning frustum/AABB queries, fused TLAS+BLAS closest-hit and any-hit raycasts, chunked refit/rebuild, and a zero-GC generic 4×4 inverse for instance ray transformation.
//License : MIT
// ============================================================================
// Directive Prologues
// ============================================================================
"use strict";

// ============================================================================
// Import (ES Modules — sibling files within the 54-file math topology)
// ============================================================================
import { common, getArrayType, onPrecisionChange } from './000_Math_module.js';
import {
    AABBSOA,
    createBVH,
    buildSAH,
    raycast as staticRaycast,
    raycastAny as staticRaycastAny
} from './069_bvh.js';

// ============================================================================
// Variable Declarations — constants and module scratch (init-time only)
// ============================================================================
const DEFAULT_MARGIN       = 0.05;
const DEFAULT_REBUILD_FRAC = 0.3;
const EPSILON              = 1e-12;
const BIG_INV              = 1e30;

// Shared traversal / math scratch (single-threaded, never held across calls).
const _aabbTmp  = new Float64Array(6);
const _fatTmp   = new Float64Array(6);
const _rangeTmp = new Float64Array(6);

const _rayTNode  = new Float64Array(1);
const _rayTLeaf  = new Float64Array(1);
const _rayTLeft  = new Float64Array(1);
const _rayTRight = new Float64Array(1);

const _m16   = new Float64Array(16);
const _inv16 = new Float64Array(16);
const _p3    = new Float64Array(3);
const _d3    = new Float64Array(3);

const _dynamicHit = { hit: false, t: Infinity, primId: -1, instanceId: -1, u: 0, v: 0 };
const _blasHit    = { hit: false, t: Infinity, primId: -1, u: 0, v: 0 };

// ============================================================================
// Function Declarations — internal scalar helpers
// ============================================================================
function _safeInv(d) {
    if (d === 0) return BIG_INV;
    return 1 / d;
}

function _surfaceArea(minX, minY, minZ, maxX, maxY, maxZ) {
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    return 2 * (dx * dy + dy * dz + dz * dx);
}

function _nodeArea(bvh, node) {
    return _surfaceArea(
        bvh.nodeMinX[node], bvh.nodeMinY[node], bvh.nodeMinZ[node],
        bvh.nodeMaxX[node], bvh.nodeMaxY[node], bvh.nodeMaxZ[node]
    );
}

function _unionAreaWithAABB(bvh, node, minX, minY, minZ, maxX, maxY, maxZ) {
    const mnx = bvh.nodeMinX[node] < minX ? bvh.nodeMinX[node] : minX;
    const mny = bvh.nodeMinY[node] < minY ? bvh.nodeMinY[node] : minY;
    const mnz = bvh.nodeMinZ[node] < minZ ? bvh.nodeMinZ[node] : minZ;
    const mxx = bvh.nodeMaxX[node] > maxX ? bvh.nodeMaxX[node] : maxX;
    const mxy = bvh.nodeMaxY[node] > maxY ? bvh.nodeMaxY[node] : maxY;
    const mxz = bvh.nodeMaxZ[node] > maxZ ? bvh.nodeMaxZ[node] : maxZ;
    return _surfaceArea(mnx, mny, mnz, mxx, mxy, mxz);
}

function _primFatInto(bvh, primId, out) {
    const a = bvh.primAabbs;
    const minX = a.minX[primId], minY = a.minY[primId], minZ = a.minZ[primId];
    const maxX = a.maxX[primId], maxY = a.maxY[primId], maxZ = a.maxZ[primId];
    const mx = (maxX - minX) * bvh.margin;
    const my = (maxY - minY) * bvh.margin;
    const mz = (maxZ - minZ) * bvh.margin;
    out[0] = minX - mx; out[1] = minY - my; out[2] = minZ - mz;
    out[3] = maxX + mx; out[4] = maxY + my; out[5] = maxZ + mz;
    return out;
}

function _setLeafFat(bvh, node, primId) {
    _primFatInto(bvh, primId, _fatTmp);
    bvh.nodeMinX[node] = _fatTmp[0]; bvh.nodeMinY[node] = _fatTmp[1]; bvh.nodeMinZ[node] = _fatTmp[2];
    bvh.nodeMaxX[node] = _fatTmp[3]; bvh.nodeMaxY[node] = _fatTmp[4]; bvh.nodeMaxZ[node] = _fatTmp[5];
}

function _setNodeAABBFromChildren(bvh, node) {
    const l = bvh.nodeLeft[node];
    const r = bvh.nodeRight[node];
    bvh.nodeMinX[node] = bvh.nodeMinX[l] < bvh.nodeMinX[r] ? bvh.nodeMinX[l] : bvh.nodeMinX[r];
    bvh.nodeMinY[node] = bvh.nodeMinY[l] < bvh.nodeMinY[r] ? bvh.nodeMinY[l] : bvh.nodeMinY[r];
    bvh.nodeMinZ[node] = bvh.nodeMinZ[l] < bvh.nodeMinZ[r] ? bvh.nodeMinZ[l] : bvh.nodeMinZ[r];
    bvh.nodeMaxX[node] = bvh.nodeMaxX[l] > bvh.nodeMaxX[r] ? bvh.nodeMaxX[l] : bvh.nodeMaxX[r];
    bvh.nodeMaxY[node] = bvh.nodeMaxY[l] > bvh.nodeMaxY[r] ? bvh.nodeMaxY[l] : bvh.nodeMaxY[r];
    bvh.nodeMaxZ[node] = bvh.nodeMaxZ[l] > bvh.nodeMaxZ[r] ? bvh.nodeMaxZ[l] : bvh.nodeMaxZ[r];
}

function _setNodeAABBFromTmp(bvh, node) {
    bvh.nodeMinX[node] = _rangeTmp[0]; bvh.nodeMinY[node] = _rangeTmp[1]; bvh.nodeMinZ[node] = _rangeTmp[2];
    bvh.nodeMaxX[node] = _rangeTmp[3]; bvh.nodeMaxY[node] = _rangeTmp[4]; bvh.nodeMaxZ[node] = _rangeTmp[5];
}

function _updateRootBounds(bvh) {
    const root = bvh.root;
    if (root < 0) {
        bvh.minX = 0; bvh.minY = 0; bvh.minZ = 0;
        bvh.maxX = 0; bvh.maxY = 0; bvh.maxZ = 0;
        return;
    }
    bvh.minX = bvh.nodeMinX[root]; bvh.minY = bvh.nodeMinY[root]; bvh.minZ = bvh.nodeMinZ[root];
    bvh.maxX = bvh.nodeMaxX[root]; bvh.maxY = bvh.nodeMaxY[root]; bvh.maxZ = bvh.nodeMaxZ[root];
}

function _refitUp(bvh, node) {
    while (node >= 0) {
        if (bvh.nodeAlive[node] !== 0 && bvh.nodeIsLeaf[node] === 0) {
            _setNodeAABBFromChildren(bvh, node);
        }
        node = bvh.nodeParent[node];
    }
}

function _rayAABB(ox, oy, oz, invDx, invDy, invDz, minX, minY, minZ, maxX, maxY, maxZ, tMax, outT) {
    let t1 = (minX - ox) * invDx;
    let t2 = (maxX - ox) * invDx;
    let tEnter = t1 < t2 ? t1 : t2;
    let tExit  = t1 > t2 ? t1 : t2;

    t1 = (minY - oy) * invDy; t2 = (maxY - oy) * invDy;
    const mnY = t1 < t2 ? t1 : t2;
    const mxY = t1 > t2 ? t1 : t2;
    if (mnY > tEnter) tEnter = mnY;
    if (mxY < tExit) tExit = mxY;

    t1 = (minZ - oz) * invDz; t2 = (maxZ - oz) * invDz;
    const mnZ = t1 < t2 ? t1 : t2;
    const mxZ = t1 > t2 ? t1 : t2;
    if (mnZ > tEnter) tEnter = mnZ;
    if (mxZ < tExit) tExit = mxZ;

    const lower = tEnter > 0 ? tEnter : 0;
    if (tExit >= lower && tEnter <= tMax) {
        outT[0] = lower;
        return true;
    }
    return false;
}

function _centroidOfPrim(bvh, primId, axis) {
    const a = bvh.primAabbs;
    return axis === 0 ? a.cx[primId] : axis === 1 ? a.cy[primId] : a.cz[primId];
}

function _quickselectActive(bvh, lo, hi, k, axis) {
    const ids = bvh.activeIds;
    while (hi > lo) {
        const mid = (lo + hi) >> 1;
        if (_centroidOfPrim(bvh, ids[mid], axis) < _centroidOfPrim(bvh, ids[lo], axis)) {
            let t = ids[lo]; ids[lo] = ids[mid]; ids[mid] = t;
        }
        if (_centroidOfPrim(bvh, ids[hi], axis) < _centroidOfPrim(bvh, ids[lo], axis)) {
            let t = ids[lo]; ids[lo] = ids[hi]; ids[hi] = t;
        }
        if (_centroidOfPrim(bvh, ids[hi], axis) < _centroidOfPrim(bvh, ids[mid], axis)) {
            let t = ids[mid]; ids[mid] = ids[hi]; ids[hi] = t;
        }
        const pivot = _centroidOfPrim(bvh, ids[mid], axis);
        let i = lo, j = hi;
        while (i <= j) {
            while (_centroidOfPrim(bvh, ids[i], axis) < pivot) i++;
            while (_centroidOfPrim(bvh, ids[j], axis) > pivot) j--;
            if (i <= j) {
                let t = ids[i]; ids[i] = ids[j]; ids[j] = t;
                i++; j--;
            }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return;
    }
}

function _rangeFatAABB(bvh, first, count, out) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const ids = bvh.activeIds;
    for (let k = 0; k < count; k++) {
        _primFatInto(bvh, ids[first + k], _fatTmp);
        if (_fatTmp[0] < minX) minX = _fatTmp[0];
        if (_fatTmp[1] < minY) minY = _fatTmp[1];
        if (_fatTmp[2] < minZ) minZ = _fatTmp[2];
        if (_fatTmp[3] > maxX) maxX = _fatTmp[3];
        if (_fatTmp[4] > maxY) maxY = _fatTmp[4];
        if (_fatTmp[5] > maxZ) maxZ = _fatTmp[5];
    }
    out[0] = minX; out[1] = minY; out[2] = minZ;
    out[3] = maxX; out[4] = maxY; out[5] = maxZ;
    return out;
}

function _buildRefitOrder(bvh) {
    const root = bvh.root;
    if (root < 0) return 0;
    const stack = bvh._stack;
    const order = bvh._order;
    let sp = 0;
    stack[sp++] = root;
    let orderCount = 0;
    while (sp > 0) {
        const node = stack[--sp];
        if (bvh.nodeAlive[node] === 0) continue;
        order[orderCount++] = node;
        if (bvh.nodeIsLeaf[node] === 0) {
            if (sp + 2 < stack.length) {
                stack[sp++] = bvh.nodeLeft[node];
                stack[sp++] = bvh.nodeRight[node];
            }
        }
    }
    return orderCount;
}

function _nodeInsideFrustum(bvh, node, planes) {
    const pn = planes.nx.length;
    for (let p = 0; p < pn; p++) {
        const nx = planes.nx[p], ny = planes.ny[p], nz = planes.nz[p], d = planes.d[p];
        const px = nx >= 0 ? bvh.nodeMaxX[node] : bvh.nodeMinX[node];
        const py = ny >= 0 ? bvh.nodeMaxY[node] : bvh.nodeMinY[node];
        const pz = nz >= 0 ? bvh.nodeMaxZ[node] : bvh.nodeMinZ[node];
        if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
}

function _primInsideFrustum(bvh, primId, planes) {
    const a = bvh.primAabbs;
    const pn = planes.nx.length;
    for (let p = 0; p < pn; p++) {
        const nx = planes.nx[p], ny = planes.ny[p], nz = planes.nz[p], d = planes.d[p];
        const px = nx >= 0 ? a.maxX[primId] : a.minX[primId];
        const py = ny >= 0 ? a.maxY[primId] : a.minY[primId];
        const pz = nz >= 0 ? a.maxZ[primId] : a.minZ[primId];
        if (nx * px + ny * py + nz * pz + d < 0) return false;
    }
    return true;
}

function _primIntersectsAABB(bvh, primId, minX, minY, minZ, maxX, maxY, maxZ) {
    const a = bvh.primAabbs;
    return !(a.maxX[primId] < minX || a.minX[primId] > maxX ||
             a.maxY[primId] < minY || a.minY[primId] > maxY ||
             a.maxZ[primId] < minZ || a.minZ[primId] > maxZ);
}

function _mat4Invert(out, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return false;
    det = 1 / det;

    out[0]  = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1]  = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2]  = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3]  = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4]  = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5]  = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6]  = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7]  = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8]  = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9]  = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return true;
}

function _transformPoint(out, m, x, y, z) {
    out[0] = m[0] * x + m[4] * y + m[8]  * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9]  * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
}

function _transformDir(out, m, x, y, z) {
    out[0] = m[0] * x + m[4] * y + m[8]  * z;
    out[1] = m[1] * x + m[5] * y + m[9]  * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
    return out;
}

// ============================================================================
// Class Declarations — DynamicBVH (flat SoA nodes, fat AABBs, free-list)
// ============================================================================
/**
 * DynamicBVH — incremental BVH with insert/remove/update/refit/rebuild.
 * Node and primitive data are stored as parallel SoA typed arrays. Leaves hold
 * exactly one primitive; internal nodes hold two children. Fat AABBs reduce
 * reinsertions for small movements.
 */
class DynamicBVH {
    constructor(maxPrims, options) {
        options = options || {};
        maxPrims = maxPrims > 0 ? maxPrims : 1024;

        this.margin = options.margin !== undefined ? options.margin : DEFAULT_MARGIN;
        this.rebuildFraction = options.rebuildFraction !== undefined ? options.rebuildFraction : DEFAULT_REBUILD_FRAC;

        this.root = -1;
        this.minX = 0; this.minY = 0; this.minZ = 0;
        this.maxX = 0; this.maxY = 0; this.maxZ = 0;

        this.primCapacity = maxPrims;
        this.primCount = 0;
        this.movedSinceRebuild = 0;

        this.primAabbs = new AABBSOA(maxPrims);
        this.primNode = new Int32Array(maxPrims);
        this.primActive = new Uint8Array(maxPrims);
        this.activeIds = new Uint32Array(maxPrims);
        this.primNode.fill(-1);

        this.nodeMinX = null; this.nodeMinY = null; this.nodeMinZ = null;
        this.nodeMaxX = null; this.nodeMaxY = null; this.nodeMaxZ = null;
        this.nodeLeft = null; this.nodeRight = null; this.nodeParent = null;
        this.nodePrimCount = null;
        this.nodeIsLeaf = null; this.nodeAlive = null;
        this.nodeCount_ = 0; this.nodeCap_ = 0;

        this._stack = null;
        this._order = null;
        this._workNode = null;
        this._workFirst = null;
        this._workCount = null;

        this.freeList = new Int32Array(maxPrims * 2 + 4);
        this.freeCount = 0;

        this._allocNodeArrays(maxPrims * 2 + 4);
    }

    _allocNodeArrays(cap) {
        const T = getArrayType();
        this.nodeMinX = new T(cap);
        this.nodeMinY = new T(cap);
        this.nodeMinZ = new T(cap);
        this.nodeMaxX = new T(cap);
        this.nodeMaxY = new T(cap);
        this.nodeMaxZ = new T(cap);

        this.nodeLeft = new Int32Array(cap);
        this.nodeRight = new Int32Array(cap);
        this.nodeParent = new Int32Array(cap);
        this.nodePrimCount = new Int32Array(cap);

        this.nodeIsLeaf = new Uint8Array(cap);
        this.nodeAlive = new Uint8Array(cap);

        this._stack = new Int32Array(cap);
        this._order = new Int32Array(cap);
        this._workNode = new Int32Array(cap);
        this._workFirst = new Int32Array(cap);
        this._workCount = new Int32Array(cap);

        this.nodeCap_ = cap;
        this.nodeCount_ = 0;
    }

    _growNodes(newCap) {
        const T = this.nodeMinX.constructor;
        const growF = (old) => { const a = new T(newCap); a.set(old); return a; };
        const growI = (old) => { const a = new Int32Array(newCap); a.set(old); return a; };
        const growU8 = (old) => { const a = new Uint8Array(newCap); a.set(old); return a; };

        this.nodeMinX = growF(this.nodeMinX);
        this.nodeMinY = growF(this.nodeMinY);
        this.nodeMinZ = growF(this.nodeMinZ);
        this.nodeMaxX = growF(this.nodeMaxX);
        this.nodeMaxY = growF(this.nodeMaxY);
        this.nodeMaxZ = growF(this.nodeMaxZ);

        this.nodeLeft = growI(this.nodeLeft);
        this.nodeRight = growI(this.nodeRight);
        this.nodeParent = growI(this.nodeParent);
        this.nodePrimCount = growI(this.nodePrimCount);

        this.nodeIsLeaf = growU8(this.nodeIsLeaf);
        this.nodeAlive = growU8(this.nodeAlive);

        this._stack = growI(this._stack);
        this._order = growI(this._order);
        this._workNode = growI(this._workNode);
        this._workFirst = growI(this._workFirst);
        this._workCount = growI(this._workCount);

        this.nodeCap_ = newCap;
    }

    _ensureNodeCap(needed) {
        if (needed <= this.nodeCap_) return;
        let newCap = this.nodeCap_;
        while (newCap < needed) newCap *= 2;
        this._growNodes(newCap);
    }

    _allocNode() {
        let idx;
        if (this.freeCount > 0) {
            idx = this.freeList[--this.freeCount];
        } else {
            this._ensureNodeCap(this.nodeCount_ + 1);
            idx = this.nodeCount_++;
        }
        this.nodeAlive[idx] = 1;
        this.nodeIsLeaf[idx] = 0;
        this.nodePrimCount[idx] = 0;
        this.nodeLeft[idx] = -1;
        this.nodeRight[idx] = -1;
        this.nodeParent[idx] = -1;
        this.nodeMinX[idx] = 0; this.nodeMinY[idx] = 0; this.nodeMinZ[idx] = 0;
        this.nodeMaxX[idx] = 0; this.nodeMaxY[idx] = 0; this.nodeMaxZ[idx] = 0;
        return idx;
    }

    _freeNode(idx) {
        if (idx < 0) return;
        this.nodeAlive[idx] = 0;
        if (this.freeCount >= this.freeList.length) {
            const nf = new Int32Array(this.freeList.length * 2);
            nf.set(this.freeList);
            this.freeList = nf;
        }
        this.freeList[this.freeCount++] = idx;
    }

    _growPrims(newCap) {
        this.primAabbs.resize(newCap);

        const newPrimNode = new Int32Array(newCap);
        newPrimNode.fill(-1);
        newPrimNode.set(this.primNode);
        this.primNode = newPrimNode;

        const newActive = new Uint8Array(newCap);
        newActive.set(this.primActive);
        this.primActive = newActive;

        const newIds = new Uint32Array(newCap);
        newIds.set(this.activeIds);
        this.activeIds = newIds;

        this.primCapacity = newCap;
    }

    _ensurePrimCap(primId) {
        if (primId < this.primCapacity) return;
        let newCap = this.primCapacity;
        while (newCap <= primId) newCap *= 2;
        this._growPrims(newCap);
    }

    /** Insert primitive. Returns leaf node index. */
    insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ) {
        this._ensurePrimCap(primId);
        if (this.primActive[primId] !== 0) this.removePrim(primId);

        this.primAabbs.set(primId, minX, minY, minZ, maxX, maxY, maxZ);
        this.primActive[primId] = 1;
        this.primCount++;
        this.movedSinceRebuild++;

        _primFatInto(this, primId, _fatTmp);

        if (this.root < 0) {
            const leaf = this._allocNode();
            this.nodeIsLeaf[leaf] = 1;
            this.nodePrimCount[leaf] = 1;
            this.nodeLeft[leaf] = primId;
            this.nodeRight[leaf] = -1;
            this.nodeParent[leaf] = -1;
            this.nodeMinX[leaf] = _fatTmp[0]; this.nodeMinY[leaf] = _fatTmp[1]; this.nodeMinZ[leaf] = _fatTmp[2];
            this.nodeMaxX[leaf] = _fatTmp[3]; this.nodeMaxY[leaf] = _fatTmp[4]; this.nodeMaxZ[leaf] = _fatTmp[5];
            this.root = leaf;
            this.primNode[primId] = leaf;
            _updateRootBounds(this);
            return leaf;
        }

        const leaf = this._allocNode();
        this.nodeIsLeaf[leaf] = 1;
        this.nodePrimCount[leaf] = 1;
        this.nodeLeft[leaf] = primId;
        this.nodeRight[leaf] = -1;
        this.nodeMinX[leaf] = _fatTmp[0]; this.nodeMinY[leaf] = _fatTmp[1]; this.nodeMinZ[leaf] = _fatTmp[2];
        this.nodeMaxX[leaf] = _fatTmp[3]; this.nodeMaxY[leaf] = _fatTmp[4]; this.nodeMaxZ[leaf] = _fatTmp[5];
        this.primNode[primId] = leaf;

        let sibling = this.root;
        while (this.nodeIsLeaf[sibling] === 0) {
            const left = this.nodeLeft[sibling];
            const right = this.nodeRight[sibling];
            const areaL = _nodeArea(this, left);
            const areaR = _nodeArea(this, right);
            const costL = _unionAreaWithAABB(this, left, _fatTmp[0], _fatTmp[1], _fatTmp[2], _fatTmp[3], _fatTmp[4], _fatTmp[5]) - areaL;
            const costR = _unionAreaWithAABB(this, right, _fatTmp[0], _fatTmp[1], _fatTmp[2], _fatTmp[3], _fatTmp[4], _fatTmp[5]) - areaR;
            sibling = costL <= costR ? left : right;
        }

        const oldParent = this.nodeParent[sibling];
        const newParent = this._allocNode();
        this.nodeIsLeaf[newParent] = 0;
        this.nodePrimCount[newParent] = 0;
        this.nodeParent[newParent] = oldParent;
        this.nodeLeft[newParent] = sibling;
        this.nodeRight[newParent] = leaf;
        this.nodeParent[sibling] = newParent;
        this.nodeParent[leaf] = newParent;

        const mnx = this.nodeMinX[sibling] < this.nodeMinX[leaf] ? this.nodeMinX[sibling] : this.nodeMinX[leaf];
        const mny = this.nodeMinY[sibling] < this.nodeMinY[leaf] ? this.nodeMinY[sibling] : this.nodeMinY[leaf];
        const mnz = this.nodeMinZ[sibling] < this.nodeMinZ[leaf] ? this.nodeMinZ[sibling] : this.nodeMinZ[leaf];
        const mxx = this.nodeMaxX[sibling] > this.nodeMaxX[leaf] ? this.nodeMaxX[sibling] : this.nodeMaxX[leaf];
        const mxy = this.nodeMaxY[sibling] > this.nodeMaxY[leaf] ? this.nodeMaxY[sibling] : this.nodeMaxY[leaf];
        const mxz = this.nodeMaxZ[sibling] > this.nodeMaxZ[leaf] ? this.nodeMaxZ[sibling] : this.nodeMaxZ[leaf];
        this.nodeMinX[newParent] = mnx; this.nodeMinY[newParent] = mny; this.nodeMinZ[newParent] = mnz;
        this.nodeMaxX[newParent] = mxx; this.nodeMaxY[newParent] = mxy; this.nodeMaxZ[newParent] = mxz;

        if (oldParent < 0) {
            this.root = newParent;
        } else {
            if (this.nodeLeft[oldParent] === sibling) this.nodeLeft[oldParent] = newParent;
            else this.nodeRight[oldParent] = newParent;
            _refitUp(this, oldParent);
        }

        _updateRootBounds(this);
        return leaf;
    }

    /** Remove primitive. */
    removePrim(primId) {
        if (primId < 0 || primId >= this.primCapacity) return;
        if (this.primActive[primId] === 0) return;
        const leaf = this.primNode[primId];
        if (leaf < 0) return;

        this.primActive[primId] = 0;
        this.primNode[primId] = -1;
        this.primCount--;
        this.movedSinceRebuild++;

        if (this.root === leaf) {
            this._freeNode(leaf);
            this.root = -1;
            _updateRootBounds(this);
            return;
        }

        const parent = this.nodeParent[leaf];
        const sibling = this.nodeLeft[parent] === leaf ? this.nodeRight[parent] : this.nodeLeft[parent];
        const grand = this.nodeParent[parent];

        if (grand < 0) {
            this.root = sibling;
            this.nodeParent[sibling] = -1;
        } else {
            if (this.nodeLeft[grand] === parent) this.nodeLeft[grand] = sibling;
            else this.nodeRight[grand] = sibling;
            this.nodeParent[sibling] = grand;
            _refitUp(this, grand);
        }

        this._freeNode(leaf);
        this._freeNode(parent);
        _updateRootBounds(this);
    }

    /**
     * Update primitive AABB. Returns `true` if the leaf was reinserted,
     * `false` if the primitive stayed inside its fat leaf.
     */
    updatePrim(primId, minX, minY, minZ, maxX, maxY, maxZ) {
        if (primId < 0 || primId >= this.primCapacity || this.primActive[primId] === 0) {
            this.insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
            return true;
        }

        this.primAabbs.set(primId, minX, minY, minZ, maxX, maxY, maxZ);
        const leaf = this.primNode[primId];
        if (leaf < 0) {
            this.insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
            return true;
        }

        _primFatInto(this, primId, _fatTmp);
        if (_fatTmp[0] >= this.nodeMinX[leaf] &&
            _fatTmp[1] >= this.nodeMinY[leaf] &&
            _fatTmp[2] >= this.nodeMinZ[leaf] &&
            _fatTmp[3] <= this.nodeMaxX[leaf] &&
            _fatTmp[4] <= this.nodeMaxY[leaf] &&
            _fatTmp[5] <= this.nodeMaxZ[leaf]) {
            this.movedSinceRebuild++;
            return false;
        }

        this.removePrim(primId);
        this.insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
        return true;
    }

    /** Bottom-up refit without changing topology. */
    refit() {
        const orderCount = _buildRefitOrder(this);
        for (let i = orderCount - 1; i >= 0; i--) {
            const node = this._order[i];
            if (this.nodeIsLeaf[node] === 0) _setNodeAABBFromChildren(this, node);
        }
        _updateRootBounds(this);
        return this;
    }

    async refitAsync(options) {
        options = options || {};
        const chunkSize = options.chunkSize || common.CHUNK_SIZE;
        const orderCount = _buildRefitOrder(this);
        let c = 0;
        for (let i = orderCount - 1; i >= 0; i--) {
            const node = this._order[i];
            if (this.nodeIsLeaf[node] === 0) _setNodeAABBFromChildren(this, node);
            if (++c >= chunkSize) {
                c = 0;
                await common.yieldToMain();
            }
        }
        _updateRootBounds(this);
        return this;
    }

    /** Full median rebuild from active primitives. */
    rebuild() {
        let activeCount = 0;
        const ids = this.activeIds;
        for (let p = 0; p < this.primCapacity; p++) {
            if (this.primActive[p] !== 0) ids[activeCount++] = p;
        }

        this.nodeCount_ = 0;
        this.freeCount = 0;
        this.root = -1;

        if (activeCount === 0) {
            _updateRootBounds(this);
            this.movedSinceRebuild = 0;
            return this;
        }

        const workNode = this._workNode;
        const workFirst = this._workFirst;
        const workCount = this._workCount;

        const root = this._allocNode();
        this.nodeParent[root] = -1;
        let sp = 0;
        workNode[sp] = root; workFirst[sp] = 0; workCount[sp] = activeCount; sp++;

        while (sp > 0) {
            sp--;
            const node = workNode[sp];
            const first = workFirst[sp];
            const count = workCount[sp];

            if (count <= 1) {
                const prim = ids[first];
                this.nodeIsLeaf[node] = 1;
                this.nodePrimCount[node] = 1;
                this.nodeLeft[node] = prim;
                this.nodeRight[node] = -1;
                this.primNode[prim] = node;
                _setLeafFat(this, node, prim);
                continue;
            }

            _rangeFatAABB(this, first, count, _rangeTmp);
            _setNodeAABBFromTmp(this, node);
            this.nodeIsLeaf[node] = 0;
            this.nodePrimCount[node] = 0;

            const extX = _rangeTmp[3] - _rangeTmp[0];
            const extY = _rangeTmp[4] - _rangeTmp[1];
            const extZ = _rangeTmp[5] - _rangeTmp[2];
            let axis = 0;
            if (extY > extX && extY >= extZ) axis = 1;
            else if (extZ > extX && extZ > extY) axis = 2;

            const mid = count >> 1;
            _quickselectActive(this, first, first + count - 1, first + mid, axis);

            const left = this._allocNode();
            const right = this._allocNode();
            this.nodeLeft[node] = left;
            this.nodeRight[node] = right;
            this.nodeParent[left] = node;
            this.nodeParent[right] = node;

            if (sp + 2 < workNode.length) {
                workNode[sp] = right; workFirst[sp] = first + mid; workCount[sp] = count - mid; sp++;
                workNode[sp] = left;  workFirst[sp] = first;       workCount[sp] = mid;       sp++;
            }
        }

        this.root = root;
        _updateRootBounds(this);
        this.movedSinceRebuild = 0;
        return this;
    }

    async rebuildAsync(options) {
        options = options || {};
        const chunkSize = options.chunkSize || common.CHUNK_SIZE;
        const yieldEvery = options.yieldEvery || common.CHUNK_YIELD_EVERY;

        let activeCount = 0;
        const ids = this.activeIds;
        let c = 0;
        for (let p = 0; p < this.primCapacity; p++) {
            if (this.primActive[p] !== 0) ids[activeCount++] = p;
            if (++c >= chunkSize) {
                c = 0;
                await common.yieldToMain();
            }
        }

        this.nodeCount_ = 0;
        this.freeCount = 0;
        this.root = -1;

        if (activeCount === 0) {
            _updateRootBounds(this);
            this.movedSinceRebuild = 0;
            return this;
        }

        const workNode = this._workNode;
        const workFirst = this._workFirst;
        const workCount = this._workCount;

        const root = this._allocNode();
        this.nodeParent[root] = -1;
        let sp = 0;
        workNode[sp] = root; workFirst[sp] = 0; workCount[sp] = activeCount; sp++;
        c = 0;

        while (sp > 0) {
            sp--;
            const node = workNode[sp];
            const first = workFirst[sp];
            const count = workCount[sp];

            if (count <= 1) {
                const prim = ids[first];
                this.nodeIsLeaf[node] = 1;
                this.nodePrimCount[node] = 1;
                this.nodeLeft[node] = prim;
                this.nodeRight[node] = -1;
                this.primNode[prim] = node;
                _setLeafFat(this, node, prim);
            } else {
                _rangeFatAABB(this, first, count, _rangeTmp);
                _setNodeAABBFromTmp(this, node);
                this.nodeIsLeaf[node] = 0;
                this.nodePrimCount[node] = 0;

                const extX = _rangeTmp[3] - _rangeTmp[0];
                const extY = _rangeTmp[4] - _rangeTmp[1];
                const extZ = _rangeTmp[5] - _rangeTmp[2];
                let axis = 0;
                if (extY > extX && extY >= extZ) axis = 1;
                else if (extZ > extX && extZ > extY) axis = 2;

                const mid = count >> 1;
                _quickselectActive(this, first, first + count - 1, first + mid, axis);

                const left = this._allocNode();
                const right = this._allocNode();
                this.nodeLeft[node] = left;
                this.nodeRight[node] = right;
                this.nodeParent[left] = node;
                this.nodeParent[right] = node;

                if (sp + 2 < workNode.length) {
                    workNode[sp] = right; workFirst[sp] = first + mid; workCount[sp] = count - mid; sp++;
                    workNode[sp] = left;  workFirst[sp] = first;       workCount[sp] = mid;       sp++;
                }
            }

            if (++c >= yieldEvery) {
                c = 0;
                await common.yieldToMain();
            }
        }

        this.root = root;
        _updateRootBounds(this);
        this.movedSinceRebuild = 0;
        return this;
    }

    /** Rebuild only when the moved/insert ratio crosses the threshold. */
    rebuildIfNeeded() {
        if (this.primCount > 0 && this.movedSinceRebuild >= this.primCount * this.rebuildFraction) {
            return this.rebuild();
        }
        return this;
    }

    /** Closest-hit raycast over the dynamic tree. */
    raycast(ox, oy, oz, dx, dy, dz, tMax, out) {
        out = out || _dynamicHit;
        out.hit = false;
        out.t = tMax === undefined ? Infinity : tMax;
        out.primId = -1;
        out.instanceId = -1;
        out.u = 0; out.v = 0;
        if (this.root < 0) return out;
        if (dx === 0 && dy === 0 && dz === 0) return out;

        const invDx = _safeInv(dx), invDy = _safeInv(dy), invDz = _safeInv(dz);
        const stack = this._stack;
        let sp = 0;
        stack[sp++] = this.root;

        while (sp > 0) {
            const node = stack[--sp];
            if (this.nodeAlive[node] === 0) continue;
            if (!_rayAABB(ox, oy, oz, invDx, invDy, invDz,
                          this.nodeMinX[node], this.nodeMinY[node], this.nodeMinZ[node],
                          this.nodeMaxX[node], this.nodeMaxY[node], this.nodeMaxZ[node],
                          out.t, _rayTNode)) continue;

            if (this.nodeIsLeaf[node] !== 0) {
                const prim = this.nodeLeft[node];
                const a = this.primAabbs;
                if (_rayAABB(ox, oy, oz, invDx, invDy, invDz,
                             a.minX[prim], a.minY[prim], a.minZ[prim],
                             a.maxX[prim], a.maxY[prim], a.maxZ[prim],
                             out.t, _rayTLeaf)) {
                    if (_rayTLeaf[0] < out.t) {
                        out.t = _rayTLeaf[0];
                        out.hit = true;
                        out.primId = prim;
                    }
                }
            } else {
                const left = this.nodeLeft[node];
                const right = this.nodeRight[node];
                const hitL = _rayAABB(ox, oy, oz, invDx, invDy, invDz,
                                      this.nodeMinX[left], this.nodeMinY[left], this.nodeMinZ[left],
                                      this.nodeMaxX[left], this.nodeMaxY[left], this.nodeMaxZ[left],
                                      out.t, _rayTLeft);
                const hitR = _rayAABB(ox, oy, oz, invDx, invDy, invDz,
                                      this.nodeMinX[right], this.nodeMinY[right], this.nodeMinZ[right],
                                      this.nodeMaxX[right], this.nodeMaxY[right], this.nodeMaxZ[right],
                                      out.t, _rayTRight);
                if (sp + 2 < stack.length) {
                    if (hitL && hitR) {
                        if (_rayTLeft[0] < _rayTRight[0]) {
                            stack[sp++] = right;
                            stack[sp++] = left;
                        } else {
                            stack[sp++] = left;
                            stack[sp++] = right;
                        }
                    } else if (hitL) stack[sp++] = left;
                    else if (hitR) stack[sp++] = right;
                }
            }
        }
        return out;
    }

    /** Any-hit raycast (shadow / occlusion). */
    raycastAny(ox, oy, oz, dx, dy, dz, tMax) {
        if (this.root < 0) return false;
        if (dx === 0 && dy === 0 && dz === 0) return false;
        tMax = tMax === undefined ? Infinity : tMax;
        const invDx = _safeInv(dx), invDy = _safeInv(dy), invDz = _safeInv(dz);
        const stack = this._stack;
        let sp = 0;
        stack[sp++] = this.root;

        while (sp > 0) {
            const node = stack[--sp];
            if (this.nodeAlive[node] === 0) continue;
            if (!_rayAABB(ox, oy, oz, invDx, invDy, invDz,
                          this.nodeMinX[node], this.nodeMinY[node], this.nodeMinZ[node],
                          this.nodeMaxX[node], this.nodeMaxY[node], this.nodeMaxZ[node],
                          tMax, _rayTNode)) continue;
            if (this.nodeIsLeaf[node] !== 0) {
                const prim = this.nodeLeft[node];
                const a = this.primAabbs;
                if (_rayAABB(ox, oy, oz, invDx, invDy, invDz,
                             a.minX[prim], a.minY[prim], a.minZ[prim],
                             a.maxX[prim], a.maxY[prim], a.maxZ[prim],
                             tMax, _rayTLeaf)) return true;
            } else {
                if (sp + 2 < stack.length) {
                    stack[sp++] = this.nodeLeft[node];
                    stack[sp++] = this.nodeRight[node];
                }
            }
        }
        return false;
    }

    /**
     * Frustum cull. `planes` is an SoA object `{ nx, ny, nz, d }`.
     * Writes visible primitive IDs into `outIds` and returns the count.
     */
    frustumCull(planes, outIds) {
        const maxOut = outIds.length;
        let count = 0;
        if (this.root < 0) return 0;
        const stack = this._stack;
        let sp = 0;
        stack[sp++] = this.root;

        while (sp > 0 && count < maxOut) {
            const node = stack[--sp];
            if (this.nodeAlive[node] === 0) continue;
            if (!_nodeInsideFrustum(this, node, planes)) continue;
            if (this.nodeIsLeaf[node] !== 0) {
                const prim = this.nodeLeft[node];
                if (_primInsideFrustum(this, prim, planes)) outIds[count++] = prim;
            } else {
                if (sp + 2 < stack.length) {
                    stack[sp++] = this.nodeLeft[node];
                    stack[sp++] = this.nodeRight[node];
                }
            }
        }
        return count;
    }

    /**
     * AABB range query. Writes overlapping primitive IDs into `outIds` and
     * returns the count.
     */
    aabbQuery(minX, minY, minZ, maxX, maxY, maxZ, outIds) {
        const maxOut = outIds.length;
        let count = 0;
        if (this.root < 0) return 0;
        const stack = this._stack;
        let sp = 0;
        stack[sp++] = this.root;

        while (sp > 0 && count < maxOut) {
            const node = stack[--sp];
            if (this.nodeAlive[node] === 0) continue;
            if (this.nodeMaxX[node] < minX || this.nodeMinX[node] > maxX) continue;
            if (this.nodeMaxY[node] < minY || this.nodeMinY[node] > maxY) continue;
            if (this.nodeMaxZ[node] < minZ || this.nodeMinZ[node] > maxZ) continue;

            if (this.nodeIsLeaf[node] !== 0) {
                const prim = this.nodeLeft[node];
                if (_primIntersectsAABB(this, prim, minX, minY, minZ, maxX, maxY, maxZ)) {
                    outIds[count++] = prim;
                }
            } else {
                if (sp + 2 < stack.length) {
                    stack[sp++] = this.nodeLeft[node];
                    stack[sp++] = this.nodeRight[node];
                }
            }
        }
        return count;
    }
}

// ============================================================================
// Class Declarations — BLAS / TLAS (SoA instances)
// ============================================================================
/**
 * BLAS — static bottom-level acceleration structure for one mesh. Wraps a
 * static BVH from `069_bvh.js`.
 */
class BLAS {
    constructor(meshId, aabbs) {
        this.meshId = meshId;
        this.staticBVH = createBVH(aabbs, aabbs.count * 2);
        buildSAH(this.staticBVH, { leafSize: 4, bins: 16 });
        this.boundsMinX = this.staticBVH.minX;
        this.boundsMinY = this.staticBVH.minY;
        this.boundsMinZ = this.staticBVH.minZ;
        this.boundsMaxX = this.staticBVH.maxX;
        this.boundsMaxY = this.staticBVH.maxY;
        this.boundsMaxZ = this.staticBVH.maxZ;
    }
}

/**
 * TLAS — top-level acceleration structure over dynamic instances.
 * Instance transforms are stored as 16 parallel SoA arrays (column-major).
 */
class TLAS {
    constructor(maxInstances, maxBlas) {
        maxInstances = maxInstances > 0 ? maxInstances : 1024;
        maxBlas = maxBlas > 0 ? maxBlas : 256;

        this.capacity = maxInstances;
        this.instanceCount_ = 0;
        this.activeCount = 0;

        const T = getArrayType();
        this.m0  = new T(maxInstances); this.m1  = new T(maxInstances);
        this.m2  = new T(maxInstances); this.m3  = new T(maxInstances);
        this.m4  = new T(maxInstances); this.m5  = new T(maxInstances);
        this.m6  = new T(maxInstances); this.m7  = new T(maxInstances);
        this.m8  = new T(maxInstances); this.m9  = new T(maxInstances);
        this.m10 = new T(maxInstances); this.m11 = new T(maxInstances);
        this.m12 = new T(maxInstances); this.m13 = new T(maxInstances);
        this.m14 = new T(maxInstances); this.m15 = new T(maxInstances);

        this.minX = new T(maxInstances); this.minY = new T(maxInstances); this.minZ = new T(maxInstances);
        this.maxX = new T(maxInstances); this.maxY = new T(maxInstances); this.maxZ = new T(maxInstances);

        this.instanceBlas = new Int32Array(maxInstances);
        this.instanceActive = new Uint8Array(maxInstances);
        this.freeInstances = new Int32Array(maxInstances);
        this.freeCount = 0;

        this.blasList = new Array(maxBlas);
        this.blasCount = 0;
        this.blasIdByMeshId = Object.create(null);

        this.internal = new DynamicBVH(maxInstances);
    }

    _growInstances(newCap) {
        const T = this.m0.constructor;
        const growF = (old) => { const a = new T(newCap); a.set(old); return a; };
        const growI = (old) => { const a = new Int32Array(newCap); a.set(old); return a; };
        const growU8 = (old) => { const a = new Uint8Array(newCap); a.set(old); return a; };

        this.m0 = growF(this.m0); this.m1 = growF(this.m1);
        this.m2 = growF(this.m2); this.m3 = growF(this.m3);
        this.m4 = growF(this.m4); this.m5 = growF(this.m5);
        this.m6 = growF(this.m6); this.m7 = growF(this.m7);
        this.m8 = growF(this.m8); this.m9 = growF(this.m9);
        this.m10 = growF(this.m10); this.m11 = growF(this.m11);
        this.m12 = growF(this.m12); this.m13 = growF(this.m13);
        this.m14 = growF(this.m14); this.m15 = growF(this.m15);

        this.minX = growF(this.minX); this.minY = growF(this.minY); this.minZ = growF(this.minZ);
        this.maxX = growF(this.maxX); this.maxY = growF(this.maxY); this.maxZ = growF(this.maxZ);

        this.instanceBlas = growI(this.instanceBlas);
        this.instanceActive = growU8(this.instanceActive);
        this.freeInstances = growI(this.freeInstances);

        this.capacity = newCap;
    }

    _allocInstance() {
        let id;
        if (this.freeCount > 0) {
            id = this.freeInstances[--this.freeCount];
        } else {
            if (this.instanceCount_ >= this.capacity) {
                this._growInstances(this.capacity * 2);
            }
            id = this.instanceCount_++;
        }
        this.instanceActive[id] = 1;
        this.activeCount++;
        return id;
    }

    _freeInstance(id) {
        if (id < 0 || id >= this.capacity) return;
        if (this.instanceActive[id] === 0) return;
        this.instanceActive[id] = 0;
        this.activeCount--;
        if (this.freeCount < this.freeInstances.length) {
            this.freeInstances[this.freeCount++] = id;
        }
    }

    addBLAS(blas) {
        const existing = this.blasIdByMeshId[blas.meshId];
        if (existing !== undefined) return existing;
        if (this.blasCount >= this.blasList.length) {
            const old = this.blasList;
            this.blasList = new Array(old.length * 2);
            for (let i = 0; i < old.length; i++) this.blasList[i] = old[i];
        }
        const id = this.blasCount++;
        this.blasList[id] = blas;
        this.blasIdByMeshId[blas.meshId] = id;
        return id;
    }

    removeBLAS(meshId) {
        const id = this.blasIdByMeshId[meshId];
        if (id === undefined) return;
        this.blasList[id] = null;
        delete this.blasIdByMeshId[meshId];
    }
}

// ============================================================================
// Function Declarations — Construction
// ============================================================================
function createDynamicBVH(maxPrims, options) {
    return new DynamicBVH(maxPrims, options);
}

function createTLAS(maxInstances, maxBlas) {
    return new TLAS(maxInstances, maxBlas);
}

function createBLAS(meshId, aabbs) {
    return new BLAS(meshId, aabbs);
}

function addBLASMesh(tlas, meshId, aabbs) {
    const blas = new BLAS(meshId, aabbs);
    return tlas.addBLAS(blas);
}

function removeBLASMesh(tlas, meshId) {
    tlas.removeBLAS(meshId);
}

// ============================================================================
// Function Declarations — DynamicBVH primitive operations
// ============================================================================
function insertPrim(bvh, primId, minX, minY, minZ, maxX, maxY, maxZ) {
    return bvh.insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
}

function removePrim(bvh, primId) {
    bvh.removePrim(primId);
}

/** Returns true if the primitive was reinserted. */
function updatePrim(bvh, primId, minX, minY, minZ, maxX, maxY, maxZ) {
    return bvh.updatePrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
}

function refitDynamic(bvh) {
    return bvh.refit();
}

async function refitDynamicAsync(bvh, options) {
    return bvh.refitAsync(options);
}

function rebuildDynamic(bvh) {
    return bvh.rebuild();
}

async function rebuildDynamicAsync(bvh, options) {
    return bvh.rebuildAsync(options);
}

function rebuildIfNeeded(bvh) {
    return bvh.rebuildIfNeeded();
}

// ============================================================================
// Function Declarations — DynamicBVH traversal
// ============================================================================
function raycastDynamic(bvh, ox, oy, oz, dx, dy, dz, tMax, out) {
    return bvh.raycast(ox, oy, oz, dx, dy, dz, tMax, out);
}

function raycastAnyDynamic(bvh, ox, oy, oz, dx, dy, dz, tMax) {
    return bvh.raycastAny(ox, oy, oz, dx, dy, dz, tMax);
}

/** Writes visible primitive IDs into outIds; returns count. */
function frustumCullDynamic(bvh, planes, outIds) {
    return bvh.frustumCull(planes, outIds);
}

/** Writes overlapping primitive IDs into outIds; returns count. */
function aabbQueryDynamic(bvh, minX, minY, minZ, maxX, maxY, maxZ, outIds) {
    return bvh.aabbQuery(minX, minY, minZ, maxX, maxY, maxZ, outIds);
}

// ============================================================================
// Function Declarations — TLAS instance operations
// ============================================================================
function _copyTransformFlat(tlas, id, transform) {
    tlas.m0[id] = transform[0];  tlas.m1[id] = transform[1];
    tlas.m2[id] = transform[2];  tlas.m3[id] = transform[3];
    tlas.m4[id] = transform[4];  tlas.m5[id] = transform[5];
    tlas.m6[id] = transform[6];  tlas.m7[id] = transform[7];
    tlas.m8[id] = transform[8];  tlas.m9[id] = transform[9];
    tlas.m10[id] = transform[10]; tlas.m11[id] = transform[11];
    tlas.m12[id] = transform[12]; tlas.m13[id] = transform[13];
    tlas.m14[id] = transform[14]; tlas.m15[id] = transform[15];
}

function _copyTransformSOA(tlas, id, src, srcIndex) {
    tlas.m0[id] = src.m0[srcIndex];  tlas.m1[id] = src.m1[srcIndex];
    tlas.m2[id] = src.m2[srcIndex];  tlas.m3[id] = src.m3[srcIndex];
    tlas.m4[id] = src.m4[srcIndex];  tlas.m5[id] = src.m5[srcIndex];
    tlas.m6[id] = src.m6[srcIndex];  tlas.m7[id] = src.m7[srcIndex];
    tlas.m8[id] = src.m8[srcIndex];  tlas.m9[id] = src.m9[srcIndex];
    tlas.m10[id] = src.m10[srcIndex]; tlas.m11[id] = src.m11[srcIndex];
    tlas.m12[id] = src.m12[srcIndex]; tlas.m13[id] = src.m13[srcIndex];
    tlas.m14[id] = src.m14[srcIndex]; tlas.m15[id] = src.m15[srcIndex];
}

function _computeInstanceAABB(tlas, id) {
    const blas = tlas.blasList[tlas.instanceBlas[id]];
    if (!blas) {
        tlas.minX[id] = 0; tlas.minY[id] = 0; tlas.minZ[id] = 0;
        tlas.maxX[id] = 0; tlas.maxY[id] = 0; tlas.maxZ[id] = 0;
        return;
    }

    const mnX = blas.boundsMinX, mnY = blas.boundsMinY, mnZ = blas.boundsMinZ;
    const mxX = blas.boundsMaxX, mxY = blas.boundsMaxY, mxZ = blas.boundsMaxZ;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const m0 = tlas.m0[id], m1 = tlas.m1[id], m2 = tlas.m2[id];
    const m4 = tlas.m4[id], m5 = tlas.m5[id], m6 = tlas.m6[id];
    const m8 = tlas.m8[id], m9 = tlas.m9[id], m10 = tlas.m10[id];
    const m12 = tlas.m12[id], m13 = tlas.m13[id], m14 = tlas.m14[id];

    for (let c = 0; c < 8; c++) {
        const x = (c & 1) !== 0 ? mxX : mnX;
        const y = (c & 2) !== 0 ? mxY : mnY;
        const z = (c & 4) !== 0 ? mxZ : mnZ;
        const wx = m0 * x + m4 * y + m8 * z + m12;
        const wy = m1 * x + m5 * y + m9 * z + m13;
        const wz = m2 * x + m6 * y + m10 * z + m14;
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wz < minZ) minZ = wz;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
        if (wz > maxZ) maxZ = wz;
    }

    tlas.minX[id] = minX; tlas.minY[id] = minY; tlas.minZ[id] = minZ;
    tlas.maxX[id] = maxX; tlas.maxY[id] = maxY; tlas.maxZ[id] = maxZ;
}

function insertInstance(tlas, blasId, transform) {
    const id = tlas._allocInstance();
    tlas.instanceBlas[id] = blasId;
    _copyTransformFlat(tlas, id, transform);
    _computeInstanceAABB(tlas, id);
    tlas.internal.insertPrim(id, tlas.minX[id], tlas.minY[id], tlas.minZ[id],
                                  tlas.maxX[id], tlas.maxY[id], tlas.maxZ[id]);
    return id;
}

function insertInstanceSOA(tlas, blasId, transformSOA, srcIndex) {
    const id = tlas._allocInstance();
    tlas.instanceBlas[id] = blasId;
    _copyTransformSOA(tlas, id, transformSOA, srcIndex);
    _computeInstanceAABB(tlas, id);
    tlas.internal.insertPrim(id, tlas.minX[id], tlas.minY[id], tlas.minZ[id],
                                  tlas.maxX[id], tlas.maxY[id], tlas.maxZ[id]);
    return id;
}

function updateInstance(tlas, instanceId, transform) {
    if (instanceId < 0 || instanceId >= tlas.capacity) return false;
    if (tlas.instanceActive[instanceId] === 0) return false;
    _copyTransformFlat(tlas, instanceId, transform);
    _computeInstanceAABB(tlas, instanceId);
    tlas.internal.updatePrim(instanceId, tlas.minX[instanceId], tlas.minY[instanceId], tlas.minZ[instanceId],
                                         tlas.maxX[instanceId], tlas.maxY[instanceId], tlas.maxZ[instanceId]);
    return true;
}

function updateInstanceSOA(tlas, instanceId, transformSOA, srcIndex) {
    if (instanceId < 0 || instanceId >= tlas.capacity) return false;
    if (tlas.instanceActive[instanceId] === 0) return false;
    _copyTransformSOA(tlas, instanceId, transformSOA, srcIndex);
    _computeInstanceAABB(tlas, instanceId);
    tlas.internal.updatePrim(instanceId, tlas.minX[instanceId], tlas.minY[instanceId], tlas.minZ[instanceId],
                                         tlas.maxX[instanceId], tlas.maxY[instanceId], tlas.maxZ[instanceId]);
    return true;
}

function removeInstance(tlas, instanceId) {
    if (instanceId < 0 || instanceId >= tlas.capacity) return;
    if (tlas.instanceActive[instanceId] === 0) return;
    tlas.internal.removePrim(instanceId);
    tlas._freeInstance(instanceId);
}

// ============================================================================
// Function Declarations — TLAS traversal
// ============================================================================
function _fillTransform16(tlas, id) {
    _m16[0] = tlas.m0[id];  _m16[1] = tlas.m1[id];
    _m16[2] = tlas.m2[id];  _m16[3] = tlas.m3[id];
    _m16[4] = tlas.m4[id];  _m16[5] = tlas.m5[id];
    _m16[6] = tlas.m6[id];  _m16[7] = tlas.m7[id];
    _m16[8] = tlas.m8[id];  _m16[9] = tlas.m9[id];
    _m16[10] = tlas.m10[id]; _m16[11] = tlas.m11[id];
    _m16[12] = tlas.m12[id]; _m16[13] = tlas.m13[id];
    _m16[14] = tlas.m14[id]; _m16[15] = tlas.m15[id];
}

/**
 * Closest-hit TLAS raycast. Traverses the dynamic TLAS, transforms the ray
 * into each instance's BLAS local space, and tests the static BLAS.
 */
function raycastTLAS(tlas, ox, oy, oz, dx, dy, dz, tMax, out) {
    out = out || _dynamicHit;
    out.hit = false;
    out.t = tMax === undefined ? Infinity : tMax;
    out.primId = -1;
    out.instanceId = -1;
    out.u = 0; out.v = 0;

    const internal = tlas.internal;
    if (internal.root < 0) return out;
    if (dx === 0 && dy === 0 && dz === 0) return out;

    const invDx = _safeInv(dx), invDy = _safeInv(dy), invDz = _safeInv(dz);
    const stack = internal._stack;
    let sp = 0;
    stack[sp++] = internal.root;

    while (sp > 0) {
        const node = stack[--sp];
        if (internal.nodeAlive[node] === 0) continue;
        if (!_rayAABB(ox, oy, oz, invDx, invDy, invDz,
                      internal.nodeMinX[node], internal.nodeMinY[node], internal.nodeMinZ[node],
                      internal.nodeMaxX[node], internal.nodeMaxY[node], internal.nodeMaxZ[node],
                      out.t, _rayTNode)) continue;

        if (internal.nodeIsLeaf[node] !== 0) {
            const inst = internal.nodeLeft[node];
            if (inst >= 0 && tlas.instanceActive[inst] !== 0) {
                const blas = tlas.blasList[tlas.instanceBlas[inst]];
                if (blas) {
                    _fillTransform16(tlas, inst);
                    if (_mat4Invert(_inv16, _m16)) {
                        _transformPoint(_p3, _inv16, ox, oy, oz);
                        _transformDir(_d3, _inv16, dx, dy, dz);
                        staticRaycast(blas.staticBVH, _p3[0], _p3[1], _p3[2],
                                      _d3[0], _d3[1], _d3[2], out.t, _blasHit);
                        if (_blasHit.hit && _blasHit.t < out.t) {
                            out.hit = true;
                            out.t = _blasHit.t;
                            out.instanceId = inst;
                            out.primId = _blasHit.primId;
                            out.u = _blasHit.u;
                            out.v = _blasHit.v;
                        }
                    }
                }
            }
        } else {
            if (sp + 2 < stack.length) {
                stack[sp++] = internal.nodeLeft[node];
                stack[sp++] = internal.nodeRight[node];
            }
        }
    }

    return out;
}

/** Any-hit TLAS raycast. */
function raycastAnyTLAS(tlas, ox, oy, oz, dx, dy, dz, tMax) {
    const internal = tlas.internal;
    if (internal.root < 0) return false;
    if (dx === 0 && dy === 0 && dz === 0) return false;
    tMax = tMax === undefined ? Infinity : tMax;

    const invDx = _safeInv(dx), invDy = _safeInv(dy), invDz = _safeInv(dz);
    const stack = internal._stack;
    let sp = 0;
    stack[sp++] = internal.root;

    while (sp > 0) {
        const node = stack[--sp];
        if (internal.nodeAlive[node] === 0) continue;
        if (!_rayAABB(ox, oy, oz, invDx, invDy, invDz,
                      internal.nodeMinX[node], internal.nodeMinY[node], internal.nodeMinZ[node],
                      internal.nodeMaxX[node], internal.nodeMaxY[node], internal.nodeMaxZ[node],
                      tMax, _rayTNode)) continue;

        if (internal.nodeIsLeaf[node] !== 0) {
            const inst = internal.nodeLeft[node];
            if (inst >= 0 && tlas.instanceActive[inst] !== 0) {
                const blas = tlas.blasList[tlas.instanceBlas[inst]];
                if (blas) {
                    _fillTransform16(tlas, inst);
                    if (_mat4Invert(_inv16, _m16)) {
                        _transformPoint(_p3, _inv16, ox, oy, oz);
                        _transformDir(_d3, _inv16, dx, dy, dz);
                        if (staticRaycastAny(blas.staticBVH, _p3[0], _p3[1], _p3[2],
                                             _d3[0], _d3[1], _d3[2], tMax)) return true;
                    }
                }
            }
        } else {
            if (sp + 2 < stack.length) {
                stack[sp++] = internal.nodeLeft[node];
                stack[sp++] = internal.nodeRight[node];
            }
        }
    }

    return false;
}

/** TLAS frustum cull. Writes visible instance IDs into outIds; returns count. */
function frustumCullTLAS(tlas, planes, outIds) {
    return tlas.internal.frustumCull(planes, outIds);
}

/** BLAS local-space raycast. */
function raycastBLAS(blas, ox, oy, oz, dx, dy, dz, tMax, out) {
    return staticRaycast(blas.staticBVH, ox, oy, oz, dx, dy, dz, tMax, out);
}

// ============================================================================
// Function Declarations — SoA batch operations (sync)
// ============================================================================
/** Batch insert primitives from SoA AABBs. */
function soaInsertPrims(bvh, primIds, aabbs, count) {
    count = count === undefined ? primIds.length : count;
    for (let i = 0; i < count; i++) {
        const id = primIds[i];
        bvh.insertPrim(id, aabbs.minX[i], aabbs.minY[i], aabbs.minZ[i],
                           aabbs.maxX[i], aabbs.maxY[i], aabbs.maxZ[i]);
    }
    return count;
}

/** Batch remove primitives. */
function soaRemovePrims(bvh, primIds, count) {
    count = count === undefined ? primIds.length : count;
    for (let i = 0; i < count; i++) bvh.removePrim(primIds[i]);
    return count;
}

/** Batch update primitives. Returns the number of reinsertions. */
function soaUpdatePrims(bvh, primIds, aabbs, count) {
    count = count === undefined ? primIds.length : count;
    let reinserts = 0;
    for (let i = 0; i < count; i++) {
        const id = primIds[i];
        if (bvh.updatePrim(id, aabbs.minX[i], aabbs.minY[i], aabbs.minZ[i],
                               aabbs.maxX[i], aabbs.maxY[i], aabbs.maxZ[i])) reinserts++;
    }
    return reinserts;
}

/** Batch insert TLAS instances from SoA transforms. Writes IDs into outIds. */
function soaInsertInstances(outIds, tlas, blasIds, transformSOA, count) {
    count = count === undefined ? blasIds.length : count;
    for (let i = 0; i < count; i++) {
        outIds[i] = insertInstanceSOA(tlas, blasIds[i], transformSOA, i);
    }
    return count;
}

/** Batch update TLAS instances from SoA transforms. */
function soaUpdateInstances(tlas, instanceIds, transformSOA, count) {
    count = count === undefined ? instanceIds.length : count;
    for (let i = 0; i < count; i++) {
        updateInstanceSOA(tlas, instanceIds[i], transformSOA, i);
    }
    return count;
}

/** Batch remove TLAS instances. */
function soaRemoveInstances(tlas, instanceIds, count) {
    count = count === undefined ? instanceIds.length : count;
    for (let i = 0; i < count; i++) removeInstance(tlas, instanceIds[i]);
    return count;
}

/** Batch any-hit TLAS rays. */
function soaRaycastAnyTLAS(tlas, rays, outHits) {
    const n = rays.count;
    const tArr = rays.tMax;
    for (let i = 0; i < n; i++) {
        outHits[i] = raycastAnyTLAS(tlas, rays.ox[i], rays.oy[i], rays.oz[i],
                                    rays.dx[i], rays.dy[i], rays.dz[i],
                                    tArr ? tArr[i] : Infinity) ? 1 : 0;
    }
    return outHits;
}

/** Batch closest-hit TLAS rays. */
function soaRaycastTLAS(tlas, rays, outT, outInstance, outPrim) {
    const n = rays.count;
    const tArr = rays.tMax;
    for (let i = 0; i < n; i++) {
        raycastTLAS(tlas, rays.ox[i], rays.oy[i], rays.oz[i],
                    rays.dx[i], rays.dy[i], rays.dz[i],
                    tArr ? tArr[i] : Infinity, _dynamicHit);
        outT[i] = _dynamicHit.hit ? _dynamicHit.t : Infinity;
        outInstance[i] = _dynamicHit.instanceId;
        outPrim[i] = _dynamicHit.primId;
    }
    return outT;
}

/** Batch TLAS frustum cull. Returns visible instance count. */
function soaFrustumCullTLAS(tlas, planes, outIds) {
    return frustumCullTLAS(tlas, planes, outIds);
}

// ============================================================================
// Function Declarations — SoA batch operations (chunked async)
// ============================================================================
async function soaInsertPrimsChunked(bvh, primIds, aabbs, count, chunkSize, yieldEvery) {
    count = count === undefined ? primIds.length : count;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) {
            const id = primIds[i];
            bvh.insertPrim(id, aabbs.minX[i], aabbs.minY[i], aabbs.minZ[i],
                               aabbs.maxX[i], aabbs.maxY[i], aabbs.maxZ[i]);
        }
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return count;
}

async function soaRemovePrimsChunked(bvh, primIds, count, chunkSize, yieldEvery) {
    count = count === undefined ? primIds.length : count;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) bvh.removePrim(primIds[i]);
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return count;
}

async function soaUpdatePrimsChunked(bvh, primIds, aabbs, count, chunkSize, yieldEvery) {
    count = count === undefined ? primIds.length : count;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let reinserts = 0;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) {
            const id = primIds[i];
            if (bvh.updatePrim(id, aabbs.minX[i], aabbs.minY[i], aabbs.minZ[i],
                                   aabbs.maxX[i], aabbs.maxY[i], aabbs.maxZ[i])) reinserts++;
        }
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return reinserts;
}

async function soaUpdateInstancesChunked(tlas, instanceIds, transformSOA, count, chunkSize, yieldEvery) {
    count = count === undefined ? instanceIds.length : count;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    let start = 0, c = 0;
    while (start < count) {
        const end = Math.min(start + chunkSize, count);
        for (let i = start; i < end; i++) {
            updateInstanceSOA(tlas, instanceIds[i], transformSOA, i);
        }
        start = end;
        if (start >= count) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return count;
}

async function soaRaycastAnyTLASChunked(tlas, rays, outHits, chunkSize, yieldEvery) {
    const n = rays.count;
    chunkSize = chunkSize || common.CHUNK_SIZE;
    yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
    const tArr = rays.tMax;
    let start = 0, c = 0;
    while (start < n) {
        const end = Math.min(start + chunkSize, n);
        for (let i = start; i < end; i++) {
            outHits[i] = raycastAnyTLAS(tlas, rays.ox[i], rays.oy[i], rays.oz[i],
                                        rays.dx[i], rays.dy[i], rays.dz[i],
                                        tArr ? tArr[i] : Infinity) ? 1 : 0;
        }
        start = end;
        if (start >= n) break;
        if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
    }
    return outHits;
}

async function soaFrustumCullTLASChunked(tlas, planes, outIds, chunkSize, yieldEvery) {
    // Single BVH traversal; yield around it to keep the scheduler contract.
    await common.yieldToMain();
    return frustumCullTLAS(tlas, planes, outIds);
}

// ============================================================================
// Function Declarations — batch state
// ============================================================================
/**
 * DynamicBVHBatchState — reusable per-frame state for 1M+ unit updates.
 */
class DynamicBVHBatchState {
    constructor(maxPrims, options) {
        this.maxPrims = maxPrims;
        this.bvh = new DynamicBVH(maxPrims, options);
        this.primIds = new Uint32Array(maxPrims);
        this.aabbs = new AABBSOA(maxPrims);
        this.rayHits = new Uint8Array(maxPrims);
        this.queryIds = new Uint32Array(maxPrims);
    }

    insertAll(count) {
        return soaInsertPrims(this.bvh, this.primIds, this.aabbs, count);
    }

    updateAll(count) {
        return soaUpdatePrims(this.bvh, this.primIds, this.aabbs, count);
    }

    async updateAllChunked(count, cs, ye) {
        return soaUpdatePrimsChunked(this.bvh, this.primIds, this.aabbs, count, cs, ye);
    }

    finalize() {
        this.bvh.rebuildIfNeeded();
        this.bvh.refit();
        return this;
    }
}

function createDynamicBVHBatch(maxPrims, options) {
    return new DynamicBVHBatchState(maxPrims, options);
}

// ============================================================================
// Namespace convenience (init-time object graph only)
// ============================================================================
const namespace = {
    dynamic: {
        DynamicBVH,
        createDynamicBVH,
        insertPrim, removePrim, updatePrim,
        refit: refitDynamic, refitAsync: refitDynamicAsync,
        rebuild: rebuildDynamic, rebuildAsync: rebuildDynamicAsync,
        rebuildIfNeeded,
        raycast: raycastDynamic, raycastAny: raycastAnyDynamic,
        frustumCull: frustumCullDynamic, aabbQuery: aabbQueryDynamic
    },
    tlas: {
        TLAS,
        createTLAS,
        insertInstance, insertInstanceSOA,
        updateInstance, updateInstanceSOA,
        removeInstance,
        raycast: raycastTLAS,
        raycastAny: raycastAnyTLAS,
        frustumCull: frustumCullTLAS
    },
    blas: {
        BLAS,
        createBLAS,
        addBLASMesh, removeBLASMesh,
        raycastBLAS
    },
    batch: {
        State: DynamicBVHBatchState,
        create: createDynamicBVHBatch,
        insertPrims: soaInsertPrims,
        removePrims: soaRemovePrims,
        updatePrims: soaUpdatePrims,
        insertPrimsChunked: soaInsertPrimsChunked,
        removePrimsChunked: soaRemovePrimsChunked,
        updatePrimsChunked: soaUpdatePrimsChunked,
        insertInstances: soaInsertInstances,
        updateInstances: soaUpdateInstances,
        removeInstances: soaRemoveInstances,
        updateInstancesChunked: soaUpdateInstancesChunked,
        raycastAnyTLAS: soaRaycastAnyTLAS,
        raycastTLAS: soaRaycastTLAS,
        raycastAnyTLASChunked: soaRaycastAnyTLASChunked,
        frustumCullTLAS: soaFrustumCullTLAS,
        frustumCullTLASChunked: soaFrustumCullTLASChunked
    }
};

// ============================================================================
// Precision listener — hoisted named handler (no closure allocation).
// Existing DynamicBVH and TLAS structures keep their current buffer types.
// New ones created after a precision change use the live array type.
// ============================================================================
function _handlePrecisionChange(mode, oldMode) { /* retention policy: no-op */ }
onPrecisionChange(_handlePrecisionChange);

// ============================================================================
// Export Declarations (ES Modules)
// ============================================================================
export {
    // Core classes
    DynamicBVH, TLAS, BLAS,

    // Construction
    createDynamicBVH, createTLAS, createBLAS,

    // Dynamic primitive operations
    insertPrim, removePrim, updatePrim,

    // Refit / rebuild
    refitDynamic, refitDynamicAsync,
    rebuildDynamic, rebuildDynamicAsync,
    rebuildIfNeeded,

    // Dynamic traversal
    raycastDynamic, raycastAnyDynamic,
    frustumCullDynamic, aabbQueryDynamic,

    // BLAS management
    addBLASMesh, removeBLASMesh, raycastBLAS,

    // TLAS instance operations
    insertInstance, insertInstanceSOA,
    updateInstance, updateInstanceSOA,
    removeInstance,

    // TLAS traversal
    raycastTLAS, raycastAnyTLAS, frustumCullTLAS,

    // SoA batch operations (sync)
    soaInsertPrims, soaRemovePrims, soaUpdatePrims,
    soaInsertInstances, soaUpdateInstances, soaRemoveInstances,
    soaRaycastAnyTLAS, soaRaycastTLAS, soaFrustumCullTLAS,

    // SoA batch operations (chunked async)
    soaInsertPrimsChunked, soaRemovePrimsChunked, soaUpdatePrimsChunked,
    soaUpdateInstancesChunked,
    soaRaycastAnyTLASChunked, soaFrustumCullTLASChunked,

    // Batch state
    DynamicBVHBatchState, createDynamicBVHBatch,

    // Namespaces
    namespace
};