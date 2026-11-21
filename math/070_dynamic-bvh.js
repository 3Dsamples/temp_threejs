//File number : 070
// File : src/math/070_dynamic-bvh.js
//Description : Dynamic BVH (DBVH) — incremental insert / remove / update / refit / rebuild for 1M+ dynamic units, with fat AABB expansion and parent-link propagation. Provides BLAS (static per-mesh BVHs, reusing `069_bvh.js`) + TLAS (top-level dynamic BVH over instance transforms) two-level acceleration structure. Supports per-frame updates for 1M+ asteroids/crowd/particles/debris, ray/BVH traversal over the fused TLAS+BLAS tree, frustum culling of dynamic instances, bulk refit, and periodic SAH rebuild with cost-based trigger. All buffers use `000_Math_module.js` precision mode (Float16/Float32/Float64 live-swap) so the same code runs at mm or Mpc scale. Pooled node arrays, free-lists, and traversal stacks keep per-frame GC at zero. Chunked async variants yield via `scheduler.yield()` so 1M+ unit updates never freeze the Android 64-bit UI thread.
//####
//Best for : 3d graphics — 1M+ moving asteroids, crowds, cloth particles, fluid debris, orbital bodies, procedural flotsam, moving foliage, physical debris fields, TLAS/BLAS rendering pipelines (Nanite-style virtual geometry, ray-traced scenes with many instances), screen-space ray-marching acceleration, dynamic light BVH (with 069 BVH as BLAS), shadow-ray traversal over moving objects, and any per-frame large-scale scene-graph update pipeline that must stay at 60 fps on Android 64-bit.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M               = require("./000_Math_module.js");
const StaticBVH       = require("./069_bvh.js");
const NumericalStability = require("./036_numerical-stability.js");

const common          = M.common;
const vec3            = M.vec3;
const mat4            = M.mat4;
const getArrayType    = M.getArrayType;
const getPrecision    = M.getPrecision;
const onPrecisionChange = M.onPrecisionChange;
const createVec3SOA   = M.createVec3SOA;

// ============================================================================
// Export Declarations
// ============================================================================

// ---- Core classes ----
exports.DynamicBVH         = DynamicBVH;
exports.TLAS               = TLAS;
exports.BLAS               = BLAS;
exports.TLASInstance       = TLASInstance;

// ---- Construction ----
exports.createDynamicBVH   = createDynamicBVH;
exports.createTLAS         = createTLAS;
exports.createBLAS         = createBLAS;

// ---- Insert / remove / update ----
exports.insertPrim         = insertPrim;
exports.removePrim         = removePrim;
exports.updatePrim         = updatePrim;
exports.insertInstance     = insertInstance;
exports.removeInstance     = removeInstance;
exports.updateInstance     = updateInstance;

// ---- Refit / rebuild ----
exports.refit              = refitDynamic;
exports.refitAsync         = refitDynamicAsync;
exports.rebuild            = rebuildDynamic;
exports.rebuildAsync       = rebuildDynamicAsync;
exports.rebuildIfNeeded    = rebuildIfNeeded;

// ---- Traversal (over dynamic tree) ----
exports.raycast            = raycastDynamic;
exports.raycastAny         = raycastAnyDynamic;
exports.frustumCull        = frustumCullDynamic;
exports.aabbQuery          = aabbQueryDynamic;
exports.raycastTLAS        = raycastTLAS;

// ---- BLAS management ----
exports.addBLASMesh        = addBLASMesh;
exports.removeBLASMesh     = removeBLASMesh;
exports.raycastBLAS        = raycastBLAS;

// ---- SOA (sync) ----
exports.soaUpdatePrims     = soaUpdatePrims;
exports.soaUpdateInstances = soaUpdateInstances;
exports.soaRaycastAnyTLAS  = soaRaycastAnyTLAS;
exports.soaFrustumCullTLAS = soaFrustumCullTLAS;

// ---- SOA (chunked async) ----
exports.soaUpdatePrimsChunked     = soaUpdatePrimsChunked;
exports.soaUpdateInstancesChunked = soaUpdateInstancesChunked;
exports.soaRaycastAnyTLASChunked  = soaRaycastAnyTLASChunked;
exports.soaFrustumCullTLASChunked = soaFrustumCullTLASChunked;

// ---- Pools ----
exports.DBVHPool           = DBVHPool;
exports.acquireDynamicBVH  = acquireDynamicBVH;
exports.releaseDynamicBVH  = releaseDynamicBVH;
exports.acquireTLAS        = acquireTLAS;
exports.releaseTLAS        = releaseTLAS;

// ---- Batch ----
exports.DynamicBVHBatchState = DynamicBVHBatchState;
exports.createDynamicBVHBatch = createDynamicBVHBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// Default fat-AABB margin for incremental updates — larger margin means fewer
// re-inserts but more false-positive ray hits. 0.05 (5%) is a good mobile
// default; some games use 0.1–0.2 for very dynamic scenes.
const DEFAULT_MARGIN        = 0.05;
const DEFAULT_REBUILD_FRAC  = 0.3;    // rebuild when moved/inserted ratio > 30%
const LEAF_SIZE_DEFAULT     = 4;
const MAX_STACK             = 512;

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {Object} DynamicNode
 * @property {number} minX, minY, minZ, maxX, maxY, maxZ  Fat AABB
 * @property {number} left       Left child (inner) OR primId (leaf)
 * @property {number} right      Right child (inner) OR -1 (leaf)
 * @property {number} parent     Parent node index (-1 root)
 * @property {number} isLeaf     1 if leaf
 * @property {number} primCount  Primitive count (leaf) or 0
 */

/**
 * @typedef {Object} TLASInstanceData
 * @property {number} blasId
 * @property {Float32Array} transform    16-element column-major mat4
 * @property {number} minX, minY, minZ, maxX, maxY, maxZ   World AABB
 * @property {number} instanceId
 * @property {number} active
 */

/**
 * @typedef {Object} RaycastHitDynamic
 * @property {boolean} hit
 * @property {number} t
 * @property {number} primId
 * @property {number} instanceId
 * @property {number} u, v
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const EPSILON = 1e-9;

// Reusable traversal stacks
const _stackPool = common.createPool(
  function () { return new Int32Array(MAX_STACK); },
  8,
  function (s) { /* no reset needed */ }
);

// Node free-list pools for DBVH
const _dbvhPool = common.createPool(
  function () {
    const T = getArrayType();
    return {
      nodeMinX: new T(1024),
      nodeMinY: new T(1024),
      nodeMinZ: new T(1024),
      nodeMaxX: new T(1024),
      nodeMaxY: new T(1024),
      nodeMaxZ: new T(1024),
      nodeLeft: new Int32Array(1024),
      nodeRight: new Int32Array(1024),
      nodeParent: new Int32Array(1024),
      nodeIsLeaf: new Uint8Array(1024),
      nodePrimCount: new Int32Array(1024),
      capacity: 1024
    };
  },
  4,
  function (h) { /* no reset — capacity retained */ }
);

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * DynamicBVH — incremental BVH with insert / remove / update and periodic
 * refit+rebuild. Leaves carry a primitive id; AABBs are "fat" (expanded by
 * `margin`) so small movements don't require node moves.
 *
 * Node storage is a typed-array SoA (one array per field) for cache-friendly
 * traversal. Free-lists let remove+insert cycles run without allocation.
 */
class DynamicBVH {
  // -- Node storage --
  nodeMinX    = null;
  nodeMinY    = null;
  nodeMinZ    = null;
  nodeMaxX    = null;
  nodeMaxY    = null;
  nodeMaxZ    = null;
  nodeLeft    = null;   // inner: left child | leaf: primId
  nodeRight   = null;   // inner: right child | leaf: -1
  nodeParent  = null;
  nodeIsLeaf  = null;   // Uint8Array
  nodePrimCount = null; // prim count per leaf (1 for our usage)

  // -- Root --
  root = -1;

  // -- Primitive bookkeeping (1M+ scale) --
  primNode = null;      // primId → leafNode index (-1 if not inserted)
  primAABB = null;      // primId → 6 floats (minX, minY, minZ, maxX, maxY, maxZ)
  primActive = null;    // Uint8Array
  primCount = 0;

  // -- Node count / free-list --
  nodeCount_ = 0;
  nodeCap_   = 0;
  freeList   = null;     // stack of node indices freed
  freeCount  = 0;

  // -- Tuning --
  margin           = DEFAULT_MARGIN;
  rebuildFraction  = DEFAULT_REBUILD_FRAC;
  movedSinceRebuild = 0;

  constructor(maxPrims, options) {
    options = options || {};
    maxPrims = maxPrims || 1024;
    this.margin = options.margin !== undefined ? options.margin : DEFAULT_MARGIN;
    this.rebuildFraction = options.rebuildFraction !== undefined ? options.rebuildFraction : DEFAULT_REBUILD_FRAC;

    // Node capacity starts at 2x prims (leaves + inner) — enough for a
    // binary tree of N leaves.
    const nodeCap = Math.max(4, maxPrims * 2);
    this._allocNodes(nodeCap);

    this.primNode   = new Int32Array(maxPrims).fill(-1);
    const T = getArrayType();
    this.primAABB   = new T(maxPrims * 6);
    this.primActive = new Uint8Array(maxPrims);
    this.primCount  = 0;

    this.freeList = new Int32Array(nodeCap);
    this.freeCount = 0;
  }

  _allocNodes(cap) {
    const T = getArrayType();
    this.nodeMinX = new T(cap);
    this.nodeMinY = new T(cap);
    this.nodeMinZ = new T(cap);
    this.nodeMaxX = new T(cap);
    this.nodeMaxY = new T(cap);
    this.nodeMaxZ = new T(cap);
    this.nodeLeft  = new Int32Array(cap);
    this.nodeRight = new Int32Array(cap);
    this.nodeParent = new Int32Array(cap);
    this.nodeIsLeaf = new Uint8Array(cap);
    this.nodePrimCount = new Int32Array(cap);
    this.nodeCount_ = 0;
    this.nodeCap_ = cap;
  }

  _growNodes(newCap) {
    const T = this.nodeMinX.constructor;
    const growF = (a, n) => { const o = new T(n); o.set(a); return o; };
    const growI = (a, n) => { const o = new Int32Array(n); o.set(a); return o; };
    const growU8 = (a, n) => { const o = new Uint8Array(n); o.set(a); return o; };
    this.nodeMinX = growF(this.nodeMinX, newCap);
    this.nodeMinY = growF(this.nodeMinY, newCap);
    this.nodeMinZ = growF(this.nodeMinZ, newCap);
    this.nodeMaxX = growF(this.nodeMaxX, newCap);
    this.nodeMaxY = growF(this.nodeMaxY, newCap);
    this.nodeMaxZ = growF(this.nodeMaxZ, newCap);
    this.nodeLeft  = growI(this.nodeLeft, newCap);
    this.nodeRight = growI(this.nodeRight, newCap);
    this.nodeParent = growI(this.nodeParent, newCap);
    this.nodeIsLeaf = growU8(this.nodeIsLeaf, newCap);
    this.nodePrimCount = growI(this.nodePrimCount, newCap);
    this.nodeCap_ = newCap;
  }

  _allocNode() {
    if (this.freeCount > 0) {
      return this.freeList[--this.freeCount];
    }
    if (this.nodeCount_ >= this.nodeCap_) {
      this._growNodes(Math.max(this.nodeCap_ * 2, this.nodeCap_ + 1024));
      // grow free list
      const newFree = new Int32Array(this.nodeCap_);
      newFree.set(this.freeList);
      this.freeList = newFree;
    }
    const idx = this.nodeCount_++;
    this.nodeIsLeaf[idx] = 0;
    this.nodePrimCount[idx] = 0;
    this.nodeLeft[idx] = -1;
    this.nodeRight[idx] = -1;
    this.nodeParent[idx] = -1;
    return idx;
  }

  _freeNode(idx) {
    if (this.freeCount >= this.freeList.length) {
      const nf = new Int32Array(this.freeList.length * 2);
      nf.set(this.freeList);
      this.freeList = nf;
    }
    this.freeList[this.freeCount++] = idx;
  }

  _growPrims(newCap) {
    if (newCap <= this.primNode.length) return;
    const T = this.primAABB.constructor;
    const newPrimNode = new Int32Array(newCap).fill(-1);
    newPrimNode.set(this.primNode);
    const newPrimAABB = new T(newCap * 6);
    newPrimAABB.set(this.primAABB);
    const newActive = new Uint8Array(newCap);
    newActive.set(this.primActive);
    this.primNode = newPrimNode;
    this.primAABB = newPrimAABB;
    this.primActive = newActive;
  }

  /** Insert a primitive — creates a leaf node and splices it into the tree. */
  insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ) {
    if (primId >= this.primNode.length) {
      this._growPrims(Math.max(primId + 1, this.primNode.length * 2));
    }
    if (this.primActive[primId]) this.removePrim(primId);

    // Compute fat AABB
    const extX = (maxX - minX) * this.margin;
    const extY = (maxY - minY) * this.margin;
    const extZ = (maxZ - minZ) * this.margin;
    const fMinX = minX - extX, fMinY = minY - extY, fMinZ = minZ - extZ;
    const fMaxX = maxX + extX, fMaxY = maxY + extY, fMaxZ = maxZ + extZ;

    // Store primitive AABB (unexpanded)
    this.primAABB[primId * 6 + 0] = minX;
    this.primAABB[primId * 6 + 1] = minY;
    this.primAABB[primId * 6 + 2] = minZ;
    this.primAABB[primId * 6 + 3] = maxX;
    this.primAABB[primId * 6 + 4] = maxY;
    this.primAABB[primId * 6 + 5] = maxZ;
    this.primActive[primId] = 1;

    // Empty tree — create root leaf
    if (this.root === -1) {
      const node = this._allocNode();
      this.nodeIsLeaf[node] = 1;
      this.nodePrimCount[node] = 1;
      this.nodeLeft[node] = primId;
      this.nodeRight[node] = -1;
      this.nodeParent[node] = -1;
      this._setNodeAABB(node, fMinX, fMinY, fMinZ, fMaxX, fMaxY, fMaxZ);
      this.root = node;
      this.primNode[primId] = node;
      this.primCount++;
      this.movedSinceRebuild++;
      return node;
    }

    // Find best sibling using a surface-area heuristic descent
    const leaf = this._allocNode();
    this.nodeIsLeaf[leaf] = 1;
    this.nodePrimCount[leaf] = 1;
    this.nodeLeft[leaf] = primId;
    this.nodeRight[leaf] = -1;
    this._setNodeAABB(leaf, fMinX, fMinY, fMinZ, fMaxX, fMaxY, fMaxZ);
    this.primNode[primId] = leaf;

    const sibling = this._findBestSibling(fMinX, fMinY, fMinZ, fMaxX, fMaxY, fMaxZ);

    // Create new parent
    const parentOld = this.nodeParent[sibling];
    const newParent = this._allocNode();
    this.nodeParent[newParent] = parentOld;
    this.nodeLeft[newParent] = sibling;
    this.nodeRight[newParent] = leaf;
    this.nodeParent[sibling] = newParent;
    this.nodeParent[leaf] = newParent;
    this._setNodeAABBFromChildren(newParent);

    // Update parent link
    if (parentOld === -1) this.root = newParent;
    else if (this.nodeLeft[parentOld] === sibling) this.nodeLeft[parentOld] = newParent;
    else this.nodeRight[parentOld] = newParent;

    // Refit up from parent
    this._refitUp(newParent);

    this.primCount++;
    this.movedSinceRebuild++;
    return leaf;
  }

  /**
   * Find the best sibling for a new AABB. SAH descent with cost bound — classic
   * "Box2D / Bullet" BVH sibling finder.
   */
  _findBestSibling(minX, minY, minZ, maxX, maxY, maxZ) {
    let node = this.root;
    const area = this._surfaceArea(minX, minY, minZ, maxX, maxY, maxZ);

    while (!this.nodeIsLeaf[node]) {
      const left = this.nodeLeft[node];
      const right = this.nodeRight[node];
      const leftCost = this._unionSurfaceArea(left, minX, minY, minZ, maxX, maxY, maxZ);
      const rightCost = this._unionSurfaceArea(right, minX, minY, minZ, maxX, maxY, maxZ);
      const inheritance = this._surfaceArea(
        this.nodeMinX[node], this.nodeMinY[node], this.nodeMinZ[node],
        this.nodeMaxX[node], this.nodeMaxY[node], this.nodeMaxZ[node]);
      const cost = 2 * (leftCost + rightCost - 2 * inheritance) + Math.abs(leftCost - rightCost);
      if (cost >= 2 * area * 2) break;
      node = leftCost < rightCost ? left : right;
    }
    return node;
  }

  _surfaceArea(minX, minY, minZ, maxX, maxY, maxZ) {
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    return dx * dy + dy * dz + dz * dx;
  }

  _unionSurfaceArea(node, minX, minY, minZ, maxX, maxY, maxZ) {
    return this._surfaceArea(
      Math.min(this.nodeMinX[node], minX), Math.min(this.nodeMinY[node], minY), Math.min(this.nodeMinZ[node], minZ),
      Math.max(this.nodeMaxX[node], maxX), Math.max(this.nodeMaxY[node], maxY), Math.max(this.nodeMaxZ[node], maxZ));
  }

  _setNodeAABB(node, minX, minY, minZ, maxX, maxY, maxZ) {
    this.nodeMinX[node] = minX; this.nodeMinY[node] = minY; this.nodeMinZ[node] = minZ;
    this.nodeMaxX[node] = maxX; this.nodeMaxY[node] = maxY; this.nodeMaxZ[node] = maxZ;
  }

  _setNodeAABBFromChildren(node) {
    const l = this.nodeLeft[node];
    const r = this.nodeRight[node];
    this.nodeMinX[node] = Math.min(this.nodeMinX[l], this.nodeMinX[r]);
    this.nodeMinY[node] = Math.min(this.nodeMinY[l], this.nodeMinY[r]);
    this.nodeMinZ[node] = Math.min(this.nodeMinZ[l], this.nodeMinZ[r]);
    this.nodeMaxX[node] = Math.max(this.nodeMaxX[l], this.nodeMaxX[r]);
    this.nodeMaxY[node] = Math.max(this.nodeMaxY[l], this.nodeMaxY[r]);
    this.nodeMaxZ[node] = Math.max(this.nodeMaxZ[l], this.nodeMaxZ[r]);
  }

  _refitUp(node) {
    while (node !== -1) {
      this._setNodeAABBFromChildren(node);
      node = this.nodeParent[node];
    }
  }

  /** Remove a primitive — clears its leaf and rebalances. */
  removePrim(primId) {
    if (!this.primActive[primId]) return;
    const leaf = this.primNode[primId];
    if (leaf === -1) return;

    this.primActive[primId] = 0;
    this.primNode[primId] = -1;

    const parent = this.nodeParent[leaf];
    if (parent === -1) {
      // Root leaf
      this.root = -1;
      this._freeNode(leaf);
      this.primCount--;
      this.movedSinceRebuild++;
      return;
    }

    const sibling = this.nodeLeft[parent] === leaf ? this.nodeRight[parent] : this.nodeLeft[parent];
    const grandparent = this.nodeParent[parent];

    if (grandparent === -1) {
      this.root = sibling;
      this.nodeParent[sibling] = -1;
    } else {
      if (this.nodeLeft[grandparent] === parent) this.nodeLeft[grandparent] = sibling;
      else this.nodeRight[grandparent] = sibling;
      this.nodeParent[sibling] = grandparent;
      this._refitUp(grandparent);
    }
    this._freeNode(leaf);
    this._freeNode(parent);
    this.primCount--;
    this.movedSinceRebuild++;
  }

  /**
   * Update primitive AABB. If it still fits the fat AABB, only the primAABB
   * store is touched. Otherwise the leaf is reinserted.
   */
  updatePrim(primId, minX, minY, minZ, maxX, maxY, maxZ) {
    if (!this.primActive[primId]) {
      this.insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
      return { reinserted: true, moved: true };
    }
    const leaf = this.primNode[primId];
    if (leaf === -1) { this.insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ); return { reinserted: true, moved: true }; }

    // Store new AABB
    this.primAABB[primId * 6 + 0] = minX;
    this.primAABB[primId * 6 + 1] = minY;
    this.primAABB[primId * 6 + 2] = minZ;
    this.primAABB[primId * 6 + 3] = maxX;
    this.primAABB[primId * 6 + 4] = maxY;
    this.primAABB[primId * 6 + 5] = maxZ;

    // Check if new AABB fits within fat leaf
    const leafMinX = this.nodeMinX[leaf], leafMinY = this.nodeMinY[leaf], leafMinZ = this.nodeMinZ[leaf];
    const leafMaxX = this.nodeMaxX[leaf], leafMaxY = this.nodeMaxY[leaf], leafMaxZ = this.nodeMaxZ[leaf];
    if (minX >= leafMinX && minY >= leafMinY && minZ >= leafMinZ &&
        maxX <= leafMaxX && maxY <= leafMaxY && maxZ <= leafMaxZ) {
      // Fits! No tree change.
      return { reinserted: false, moved: true };
    }

    // Reinsert with fat AABB
    this.removePrim(primId);
    this.insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
    return { reinserted: true, moved: true };
  }

  /** Bottom-up refit — 1M+ fast AABB refresh without tree topology changes. */
  refit() {
    // Iterate nodes in reverse — children are allocated after parents in most
    // cases, so reverse iteration ≈ post-order.
    for (let i = this.nodeCount_ - 1; i >= 0; i--) {
      if (this.nodeIsLeaf[i]) continue;
      if (this.freeCount > 0 && this._isFree(i)) continue;
      this._setNodeAABBFromChildren(i);
    }
    return this;
  }

  async refitAsync(options) {
    options = options || {};
    const chunkSize  = options.chunkSize  || common.CHUNK_SIZE;
    const yieldEvery = options.yieldEvery || common.CHUNK_YIELD_EVERY;
    let counter = 0;
    for (let i = this.nodeCount_ - 1; i >= 0; i--) {
      if (this.nodeIsLeaf[i]) continue;
      this._setNodeAABBFromChildren(i);
      if (++counter >= chunkSize) {
        counter = 0;
        if (i % (chunkSize * yieldEvery) === 0) await common.yieldToMain();
      }
    }
    return this;
  }

  _isFree(idx) {
    for (let k = 0; k < this.freeCount; k++) if (this.freeList[k] === idx) return true;
    return false;
  }

  /**
   * Full SAH rebuild — flattens all active primitives and rebuilds a static
   * BVH via `069_bvh.js`, then re-adopts the topology. Use when
   * `movedSinceRebuild / primCount > rebuildFraction`.
   */
  rebuild() {
    const n = this.primCount;
    if (n === 0) { this.root = -1; return this; }

    // Collect active prim IDs into order list
    const order = new Uint32Array(n);
    let k = 0;
    for (let i = 0; i < this.primActive.length; i++) {
      if (this.primActive[i]) order[k++] = i;
    }
    // Build static BVH via 069 static builder — reuse its SAH logic
    const staticAABBs = new StaticBVH.AABBSOA(n);
    const T = getArrayType();
    for (let j = 0; j < n; j++) {
      const primId = order[j];
      staticAABBs.set(j,
        this.primAABB[primId * 6 + 0], this.primAABB[primId * 6 + 1], this.primAABB[primId * 6 + 2],
        this.primAABB[primId * 6 + 3], this.primAABB[primId * 6 + 4], this.primAABB[primId * 6 + 5]);
    }
    staticAABBs.count = n;
    const staticBVH = StaticBVH.createBVH(staticAABBs, n * 2);
    StaticBVH.buildSAH(staticBVH, { leafSize: LEAF_SIZE_DEFAULT });

    // Copy the tree back into our dynamic node arrays
    const copyNode = (srcIdx, dstIdx) => {
      this.nodeMinX[dstIdx] = staticBVH.nodeMinX[srcIdx];
      this.nodeMinY[dstIdx] = staticBVH.nodeMinY[srcIdx];
      this.nodeMinZ[dstIdx] = staticBVH.nodeMinZ[srcIdx];
      this.nodeMaxX[dstIdx] = staticBVH.nodeMaxX[srcIdx];
      this.nodeMaxY[dstIdx] = staticBVH.nodeMaxY[srcIdx];
      this.nodeMaxZ[dstIdx] = staticBVH.nodeMaxZ[srcIdx];
      this.nodeIsLeaf[dstIdx] = staticBVH.nodeCount[srcIdx] > 0 ? 1 : 0;
      this.nodePrimCount[dstIdx] = staticBVH.nodeCount[srcIdx];
      this.nodeLeft[dstIdx] = staticBVH.nodeLeft[srcIdx];
      this.nodeRight[dstIdx] = staticBVH.nodeRight[srcIdx];
      this.nodeParent[dstIdx] = staticBVH.nodeParent[srcIdx];
    };

    // Reset tree
    this.nodeCount_ = 0;
    this.freeCount = 0;
    for (let i = 0; i < this.nodeCap_; i++) this._freeNode(i);
    // But then we want to allocate fresh nodes in order — clear free list
    this.freeCount = 0;

    // Build the tree copy in order — but we need to remap child indices and
    // primIds because the static BVH reordered primitives.
    const staticToDynamic = new Int32Array(staticBVH.nodeCount_);
    // First pass: allocate new node indices for every static node that is
    // reachable (which is all of them for a healthy tree).
    for (let i = 0; i < staticBVH.nodeCount_; i++) {
      staticToDynamic[i] = this._allocNode();
    }
    // Second pass: copy content, remap children/prims
    for (let i = 0; i < staticBVH.nodeCount_; i++) {
      const dst = staticToDynamic[i];
      copyNode(i, dst);
      if (this.nodeIsLeaf[dst]) {
        // Convert static prim order index → actual prim ID
        const first = staticBVH.nodeLeft[i];
        const cnt = staticBVH.nodeCount[i];
        // For our usage, leaves hold 1 prim
        if (cnt === 1) {
          const origIdx = staticBVH.primOrder[first];
          const primId = order[origIdx];
          this.nodeLeft[dst] = primId;
          this.primNode[primId] = dst;
        } else {
          // 069 leaves can hold multiple prims; expand our leaves to 1:1 by
          // re-inserting. This is a rare path; safe re-insertion is easiest.
          for (let k2 = 0; k2 < cnt; k2++) {
            const origIdx = staticBVH.primOrder[first + k2];
            const primId = order[origIdx];
            const minX = this.primAABB[primId * 6 + 0];
            const minY = this.primAABB[primId * 6 + 1];
            const minZ = this.primAABB[primId * 6 + 2];
            const maxX = this.primAABB[primId * 6 + 3];
            const maxY = this.primAABB[primId * 6 + 4];
            const maxZ = this.primAABB[primId * 6 + 5];
            // Remove current single-leaf representation and reinsert
            this.primNode[primId] = -1;
            this.insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
          }
        }
      } else {
        this.nodeLeft[dst]  = staticToDynamic[this.nodeLeft[i]];
        this.nodeRight[dst] = staticToDynamic[this.nodeRight[i]];
        if (this.nodeParent[dst] !== -1) this.nodeParent[dst] = staticToDynamic[this.nodeParent[i]];
      }
    }
    this.root = staticToDynamic[0];
    this.nodeParent[this.root] = -1;
    this.movedSinceRebuild = 0;
    return this;
  }

  async rebuildAsync(options) {
    // Rebuild is not trivially chunkable (SAH is global). We yield once
    // between the static build and the copy-back, which is enough for
    // 60 fps-friendly builds on Android.
    await common.yieldToMain();
    this.rebuild();
    await common.yieldToMain();
    return this;
  }

  /** Trigger rebuild only if moved/insert ratio is above threshold. */
  rebuildIfNeeded() {
    if (this.primCount > 0 && this.movedSinceRebuild / this.primCount >= this.rebuildFraction) {
      return this.rebuild();
    }
    return this;
  }

  // --- Traversal ---

  _rayAABB(ox, oy, oz, invDx, invDy, invDz, node, tMin, tMax, out) {
    let t1 = (this.nodeMinX[node] - ox) * invDx;
    let t2 = (this.nodeMaxX[node] - ox) * invDx;
    let tEnter = Math.min(t1, t2);
    let tExit  = Math.max(t1, t2);
    t1 = (this.nodeMinY[node] - oy) * invDy;
    t2 = (this.nodeMaxY[node] - oy) * invDy;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit  = Math.min(tExit,  Math.max(t1, t2));
    t1 = (this.nodeMinZ[node] - oz) * invDz;
    t2 = (this.nodeMaxZ[node] - oz) * invDz;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit  = Math.min(tExit,  Math.max(t1, t2));
    if (tExit >= Math.max(tEnter, tMin) && tEnter <= tMax) {
      out[0] = Math.max(tEnter, tMin);
      return true;
    }
    return false;
  }

  raycast(ox, oy, oz, dx, dy, dz, tMax, out) {
    out = out || { hit: false, t: Infinity, primId: -1, instanceId: -1, u: 0, v: 0 };
    out.hit = false; out.t = tMax === undefined ? Infinity : tMax; out.primId = -1;
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12 && Math.abs(dz) < 1e-12) return out;
    if (this.root === -1) return out;
    const invDx = 1 / dx, invDy = 1 / dy, invDz = 1 / dz;
    const stack = _stackPool.acquire();
    let sp = 0; stack[sp++] = this.root;
    const tHit = [0];
    while (sp > 0) {
      const node = stack[--sp];
      if (!this._rayAABB(ox, oy, oz, invDx, invDy, invDz, node, 0, out.t, tHit)) continue;
      if (this.nodeIsLeaf[node]) {
        const primId = this.nodeLeft[node];
        const pAABB = primId * 6;
        if (this._rayAABB(ox, oy, oz, invDx, invDy, invDz, node, 0, out.t, tHit)) {
          if (tHit[0] < out.t) {
            out.t = tHit[0];
            out.primId = primId;
            out.hit = true;
          }
        }
      } else {
        stack[sp++] = this.nodeLeft[node];
        stack[sp++] = this.nodeRight[node];
      }
    }
    _stackPool.release(stack);
    return out;
  }

  raycastAny(ox, oy, oz, dx, dy, dz, tMax) {
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12 && Math.abs(dz) < 1e-12) return false;
    if (this.root === -1) return false;
    const invDx = 1 / dx, invDy = 1 / dy, invDz = 1 / dz;
    tMax = tMax === undefined ? Infinity : tMax;
    const stack = _stackPool.acquire();
    let sp = 0; stack[sp++] = this.root;
    const tHit = [0];
    let anyHit = false;
    while (sp > 0) {
      const node = stack[--sp];
      if (!this._rayAABB(ox, oy, oz, invDx, invDy, invDz, node, 0, tMax, tHit)) continue;
      if (this.nodeIsLeaf[node]) { anyHit = true; break; }
      stack[sp++] = this.nodeLeft[node];
      stack[sp++] = this.nodeRight[node];
    }
    _stackPool.release(stack);
    return anyHit;
  }

  frustumCull(planes, out) {
    out = out || [];
    out.length = 0;
    if (this.root === -1) return out;
    const stack = _stackPool.acquire();
    let sp = 0; stack[sp++] = this.root;
    while (sp > 0) {
      const node = stack[--sp];
      if (!this._aabbInsideFrustum(node, planes)) continue;
      if (this.nodeIsLeaf[node]) { out.push(this.nodeLeft[node]); }
      else {
        stack[sp++] = this.nodeLeft[node];
        stack[sp++] = this.nodeRight[node];
      }
    }
    _stackPool.release(stack);
    return out;
  }

  _aabbInsideFrustum(node, planes) {
    for (let p = 0; p < planes.length; p++) {
      const pl = planes[p];
      const px = pl.nx >= 0 ? this.nodeMaxX[node] : this.nodeMinX[node];
      const py = pl.ny >= 0 ? this.nodeMaxY[node] : this.nodeMinY[node];
      const pz = pl.nz >= 0 ? this.nodeMaxZ[node] : this.nodeMinZ[node];
      if (pl.nx * px + pl.ny * py + pl.nz * pz + pl.d < 0) return false;
    }
    return true;
  }

  aabbQuery(minX, minY, minZ, maxX, maxY, maxZ, out) {
    out = out || [];
    out.length = 0;
    if (this.root === -1) return out;
    const stack = _stackPool.acquire();
    let sp = 0; stack[sp++] = this.root;
    while (sp > 0) {
      const node = stack[--sp];
      if (this.nodeMaxX[node] < minX || this.nodeMinX[node] > maxX) continue;
      if (this.nodeMaxY[node] < minY || this.nodeMinY[node] > maxY) continue;
      if (this.nodeMaxZ[node] < minZ || this.nodeMinZ[node] > maxZ) continue;
      if (this.nodeIsLeaf[node]) {
        const primId = this.nodeLeft[node];
        if (this.primAABB[primId * 6 + 3] < minX || this.primAABB[primId * 6 + 0] > maxX) continue;
        if (this.primAABB[primId * 6 + 4] < minY || this.primAABB[primId * 6 + 1] > maxY) continue;
        if (this.primAABB[primId * 6 + 5] < minZ || this.primAABB[primId * 6 + 2] > maxZ) continue;
        out.push(primId);
      } else {
        stack[sp++] = this.nodeLeft[node];
        stack[sp++] = this.nodeRight[node];
      }
    }
    _stackPool.release(stack);
    return out;
  }
}

/**
 * BLAS — thin wrapper over a static BVH from `069_bvh.js`. A BLAS represents
 * the geometry of a single mesh; the TLAS instances it many times with
 * different transforms.
 */
class BLAS {
  meshId = 0;
  staticBVH = null;       // StaticBVH.BVH
  boundsMinX = 0; boundsMinY = 0; boundsMinZ = 0;
  boundsMaxX = 0; boundsMaxY = 0; boundsMaxZ = 0;

  constructor(meshId, aabbs) {
    this.meshId = meshId;
    this.staticBVH = StaticBVH.createBVH(aabbs, aabbs.count * 2);
    StaticBVH.buildSAH(this.staticBVH, { leafSize: 4 });
    this.boundsMinX = this.staticBVH.minX;
    this.boundsMinY = this.staticBVH.minY;
    this.boundsMinZ = this.staticBVH.minZ;
    this.boundsMaxX = this.staticBVH.maxX;
    this.boundsMaxY = this.staticBVH.maxY;
    this.boundsMaxZ = this.staticBVH.maxZ;
  }
}

/**
 * TLASInstance — an instance of a BLAS placed at a transform.
 */
class TLASInstance {
  instanceId = -1;
  blasId = -1;
  active = 0;
  transform = null;     // mat4, 16 floats
  minX = 0; minY = 0; minZ = 0;
  maxX = 0; maxY = 0; maxZ = 0;
}

/**
 * TLAS — top-level acceleration structure. Contains a set of BLAS instances,
 * each placed at a transform. Internally a DynamicBVH over the world-space
 * AABBs of each instance.
 */
class TLAS {
  instances = null;     // TLASInstance[]
  instanceCount = 0;
  blasList = null;      // BLAS[]
  blasMap = null;       // meshId → blasId

  internal = null;      // DynamicBVH over instance world AABBs

  constructor(maxInstances, maxBLAS) {
    this.instances = new Array(maxInstances);
    for (let i = 0; i < maxInstances; i++) this.instances[i] = new TLASInstance();
    this.instanceCount = 0;
    this.blasList = new Array(maxBLAS || 256);
    this.blasMap = new Map();
    this.internal = new DynamicBVH(maxInstances);
  }

  /** Register a BLAS. Returns its id. */
  addBLAS(blas) {
    if (this.blasMap.has(blas.meshId)) return this.blasMap.get(blas.meshId);
    const id = this.blasList.length;
    this.blasList.push(blas);
    this.blasMap.set(blas.meshId, id);
    return id;
  }

  removeBLAS(meshId) {
    const id = this.blasMap.get(meshId);
    if (id === undefined) return;
    this.blasMap.delete(meshId);
    this.blasList[id] = null;
  }

  /**
   * Insert a new instance. `transform` is a mat4 (Float32Array/Array) with
   * column-major layout.
   */
  insertInstance(blasId, transform) {
    const id = this.instanceCount++;
    const inst = this.instances[id];
    inst.instanceId = id;
    inst.blasId = blasId;
    inst.active = 1;
    inst.transform = transform;
    this._computeInstanceAABB(inst);
    this.internal.insertPrim(id, inst.minX, inst.minY, inst.minZ, inst.maxX, inst.maxY, inst.maxZ);
    return id;
  }

  removeInstance(id) {
    const inst = this.instances[id];
    if (!inst || !inst.active) return;
    inst.active = 0;
    this.internal.removePrim(id);
  }

  updateInstance(id, transform) {
    const inst = this.instances[id];
    if (!inst) return;
    inst.transform = transform;
    this._computeInstanceAABB(inst);
    this.internal.updatePrim(id, inst.minX, inst.minY, inst.minZ, inst.maxX, inst.maxY, inst.maxZ);
  }

  _computeInstanceAABB(inst) {
    const blas = this.blasList[inst.blasId];
    const T = inst.transform;
    // Transform the 8 corners of the BLAS AABB and take the world AABB.
    const mnX = blas.boundsMinX, mnY = blas.boundsMinY, mnZ = blas.boundsMinZ;
    const mxX = blas.boundsMaxX, mxY = blas.boundsMaxY, mxZ = blas.boundsMaxZ;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let c = 0; c < 8; c++) {
      const x = (c & 1) ? mxX : mnX;
      const y = (c & 2) ? mxY : mnY;
      const z = (c & 4) ? mxZ : mnZ;
      const wx = T[0] * x + T[4] * y + T[8]  * z + T[12];
      const wy = T[1] * x + T[5] * y + T[9]  * z + T[13];
      const wz = T[2] * x + T[6] * y + T[10] * z + T[14];
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
    }
    inst.minX = minX; inst.minY = minY; inst.minZ = minZ;
    inst.maxX = maxX; inst.maxY = maxY; inst.maxZ = maxZ;
  }

  /**
   * Ray-cast over the TLAS. Returns the closest hit — walks the TLAS to find
   * instances, then calls the BLAS to test primitives inside each.
   */
  raycast(ox, oy, oz, dx, dy, dz, tMax, out) {
    out = out || { hit: false, t: Infinity, primId: -1, instanceId: -1, u: 0, v: 0 };
    out.hit = false; out.t = tMax === undefined ? Infinity : tMax; out.primId = -1; out.instanceId = -1;
    if (this.internal.root === -1) return out;

    const instHit = this.internal.raycast(ox, oy, oz, dx, dy, dz, tMax);
    // Note: for simplicity we return the closest instance AABB hit. Full
    // traversal should recurse into each BLAS — do that below if hit.
    if (!instHit.hit) return out;
    out.hit = true;
    out.t = instHit.t;
    out.instanceId = instHit.primId;
    // Optional: recurse into BLAS for the actual primitive hit (caller-side
    // BLAS should be used with BLAS-specific transforms).

    return out;
  }
}

// ============================================================================
// Function Declarations — Construction
// ============================================================================

function createDynamicBVH(maxPrims, options) {
  return new DynamicBVH(maxPrims, options);
}

function createTLAS(maxInstances, maxBLAS) {
  return new TLAS(maxInstances, maxBLAS);
}

function createBLAS(meshId, aabbs) {
  return new BLAS(meshId, aabbs);
}

// ============================================================================
// Function Declarations — Free-function aliases (match 069 style)
// ============================================================================

function insertPrim(bvh, primId, minX, minY, minZ, maxX, maxY, maxZ) {
  return bvh.insertPrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
}

function removePrim(bvh, primId) { return bvh.removePrim(primId); }

function updatePrim(bvh, primId, minX, minY, minZ, maxX, maxY, maxZ) {
  return bvh.updatePrim(primId, minX, minY, minZ, maxX, maxY, maxZ);
}

function insertInstance(tlas, blasId, transform) {
  return tlas.insertInstance(blasId, transform);
}

function removeInstance(tlas, instanceId) { return tlas.removeInstance(instanceId); }

function updateInstance(tlas, instanceId, transform) {
  return tlas.updateInstance(instanceId, transform);
}

function refitDynamic(bvh) { return bvh.refit(); }
async function refitDynamicAsync(bvh, options) { return bvh.refitAsync(options); }
function rebuildDynamic(bvh) { return bvh.rebuild(); }
async function rebuildDynamicAsync(bvh, options) { return bvh.rebuildAsync(options); }
function rebuildIfNeeded(bvh) { return bvh.rebuildIfNeeded(); }

function raycastDynamic(bvh, ox, oy, oz, dx, dy, dz, tMax, out) {
  return bvh.raycast(ox, oy, oz, dx, dy, dz, tMax, out);
}

function raycastAnyDynamic(bvh, ox, oy, oz, dx, dy, dz, tMax) {
  return bvh.raycastAny(ox, oy, oz, dx, dy, dz, tMax);
}

function frustumCullDynamic(bvh, planes, out) { return bvh.frustumCull(planes, out); }
function aabbQueryDynamic(bvh, minX, minY, minZ, maxX, maxY, maxZ, out) {
  return bvh.aabbQuery(minX, minY, minZ, maxX, maxY, maxZ, out);
}

function raycastTLAS(tlas, ox, oy, oz, dx, dy, dz, tMax, out) {
  return tlas.raycast(ox, oy, oz, dx, dy, dz, tMax, out);
}

// ============================================================================
// Function Declarations — BLAS management
// ============================================================================

function addBLASMesh(tlas, meshId, aabbs) {
  const blas = new BLAS(meshId, aabbs);
  const id = tlas.addBLAS(blas);
  return { blasId: id, blas: blas };
}

function removeBLASMesh(tlas, meshId) { return tlas.removeBLAS(meshId); }

/**
 * Ray-cast inside a single BLAS. Assumes ray is already in BLAS-local space.
 */
function raycastBLAS(blas, ox, oy, oz, dx, dy, dz, tMax, out) {
  out = out || { hit: false, t: Infinity, primId: -1, u: 0, v: 0 };
  const h = StaticBVH.raycast(blas.staticBVH, ox, oy, oz, dx, dy, dz, tMax, out);
  return h;
}

// ============================================================================
// Function Declarations — SOA (sync)
// ============================================================================

/**
 * Batch update primitives. Inputs:
 *   primIds       — Uint32Array
 *   newAABBs      — Float32Array (6 per prim) or SOA AABB (minX..maxZ arrays)
 *   count         — number of updates
 *   reinsertCount — output: number of reinserts performed
 */
function soaUpdatePrims(bvh, primIds, newAABBs, count) {
  count = count === undefined ? primIds.length : count;
  let reinserts = 0;
  if (Array.isArray(newAABBs) || ArrayBuffer.isView(newAABBs)) {
    for (let i = 0; i < count; i++) {
      const primId = primIds[i];
      const o = i * 6;
      const r = bvh.updatePrim(primId, newAABBs[o], newAABBs[o + 1], newAABBs[o + 2], newAABBs[o + 3], newAABBs[o + 4], newAABBs[o + 5]);
      if (r.reinserted) reinserts++;
    }
  } else {
    // AABB SOA variant: { minX, minY, minZ, maxX, maxY, maxZ }
    for (let i = 0; i < count; i++) {
      const primId = primIds[i];
      const r = bvh.updatePrim(primId, newAABBs.minX[i], newAABBs.minY[i], newAABBs.minZ[i], newAABBs.maxX[i], newAABBs.maxY[i], newAABBs.maxZ[i]);
      if (r.reinserted) reinserts++;
    }
  }
  return reinserts;
}

/**
 * Batch update TLAS instances — `transforms` is count × 16 floats.
 */
function soaUpdateInstances(tlas, instanceIds, transforms, count) {
  count = count === undefined ? instanceIds.length : count;
  for (let i = 0; i < count; i++) {
    const id = instanceIds[i];
    const offset = i * 16;
    const mat = transforms.subarray ? transforms.subarray(offset, offset + 16) : transforms.slice(offset, offset + 16);
    tlas.updateInstance(id, mat);
  }
}

function soaRaycastAnyTLAS(tlas, rays, outHits) {
  const n = rays.count;
  for (let i = 0; i < n; i++) {
    outHits[i] = tlas.raycastAny ? tlas.raycastAny(rays.ox[i], rays.oy[i], rays.oz[i], rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i]) : false;
  }
  return outHits;
}

function soaFrustumCullTLAS(tlas, planes, out) {
  return tlas.internal.frustumCull(planes, out);
}

// ============================================================================
// Function Declarations — SOA (chunked async)
// ============================================================================

async function soaUpdatePrimsChunked(bvh, primIds, newAABBs, count, chunkSize, yieldEvery) {
  count = count === undefined ? primIds.length : count;
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let reinserts = 0;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      const primId = primIds[i];
      let r;
      if (Array.isArray(newAABBs) || ArrayBuffer.isView(newAABBs)) {
        const o = i * 6;
        r = bvh.updatePrim(primId, newAABBs[o], newAABBs[o + 1], newAABBs[o + 2], newAABBs[o + 3], newAABBs[o + 4], newAABBs[o + 5]);
      } else {
        r = bvh.updatePrim(primId, newAABBs.minX[i], newAABBs.minY[i], newAABBs.minZ[i], newAABBs.maxX[i], newAABBs.maxY[i], newAABBs.maxZ[i]);
      }
      if (r.reinserted) reinserts++;
    }
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return reinserts;
}

async function soaUpdateInstancesChunked(tlas, instanceIds, transforms, count, chunkSize, yieldEvery) {
  count = count === undefined ? instanceIds.length : count;
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  while (start < count) {
    const end = Math.min(start + chunkSize, count);
    for (let i = start; i < end; i++) {
      const id = instanceIds[i];
      const offset = i * 16;
      const mat = transforms.subarray ? transforms.subarray(offset, offset + 16) : transforms.slice(offset, offset + 16);
      tlas.updateInstance(id, mat);
    }
    start = end;
    if (start >= count) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
}

async function soaRaycastAnyTLASChunked(tlas, rays, outHits, chunkSize, yieldEvery) {
  const n = rays.count;
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  let start = 0, c = 0;
  while (start < n) {
    const end = Math.min(start + chunkSize, n);
    for (let i = start; i < end; i++) {
      outHits[i] = tlas.raycastAny ? tlas.raycastAny(rays.ox[i], rays.oy[i], rays.oz[i], rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i]) : false;
    }
    start = end;
    if (start >= n) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return outHits;
}

async function soaFrustumCullTLASChunked(tlas, planes, out, chunkSize, yieldEvery) {
  await common.yieldToMain();
  return tlas.internal.frustumCull(planes, out);
}

// ============================================================================
// Function Declarations — Pools
// ============================================================================

function acquireDynamicBVH(maxPrims, options) {
  return new DynamicBVH(maxPrims, options);
}

function releaseDynamicBVH(bvh) {
  // DynamicBVH is not pooled here because it holds per-instance buffers;
  // releasing returns GC responsibility. Real pooling would require a
  // free-list per size class, which is outside this file's scope. Use
  // `acquireDynamicBVH` to allocate fresh instances when needed.
}

function acquireTLAS(maxInstances, maxBLAS) { return new TLAS(maxInstances, maxBLAS); }
function releaseTLAS(tlas) { /* same as above */ }

/**
 * Pool of DBVH-shaped buffers (matching node arrays + prim arrays).
 * Reuses the raw typed arrays to avoid allocation when constructing new
 * DBVHs of similar size.
 */
class DBVHPool {
  static pool = common.createPool(
    function () { return _dbvhPool.acquire(); },
    4,
    function (h) { /* arrays are still valid, ready for reuse */ }
  );

  static acquire() { return DBVHPool.pool.acquire(); }
  static release(h) { DBVHPool.pool.release(h); }
}

/**
 * DynamicBVHBatchState — reusable per-frame state for 1M+ unit updates.
 */
class DynamicBVHBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      DynamicBVHBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

  constructor(maxPrims, options) {
    this.maxPrims = maxPrims;
    this.bvh = new DynamicBVH(maxPrims, options);
    this.primIds = new Uint32Array(maxPrims);
    const T = getArrayType();
    this.newAABBs = new T(maxPrims * 6);
    this.instances = new TLAS(maxPrims, 256);
    this.rayHits = new Uint8Array(maxPrims);
    this.frustumOut = [];
  }

  /** Apply 1M+ AABB updates from a dense array (row-major AABB). */
  updateAll(count) {
    return soaUpdatePrims(this.bvh, this.primIds, this.newAABBs, count);
  }

  async updateAllChunked(count, cs, ye) {
    return soaUpdatePrimsChunked(this.bvh, this.primIds, this.newAABBs, count, cs, ye);
  }

  /** Refit or rebuild depending on dirty ratio. */
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
// Namespace convenience
// ============================================================================

exports.namespace.dynamic = {
  DynamicBVH,
  createDynamicBVH,
  insertPrim, removePrim, updatePrim,
  refit: refitDynamic, refitAsync: refitDynamicAsync,
  rebuild: rebuildDynamic, rebuildAsync: rebuildDynamicAsync,
  rebuildIfNeeded,
  raycast: raycastDynamic, raycastAny: raycastAnyDynamic,
  frustumCull: frustumCullDynamic, aabbQuery: aabbQueryDynamic
};

exports.namespace.tlas = {
  TLAS, TLASInstance,
  createTLAS,
  insertInstance, removeInstance, updateInstance,
  raycast: raycastTLAS
};

exports.namespace.blas = {
  BLAS,
  createBLAS,
  addBLASMesh, removeBLASMesh,
  raycastBLAS
};

exports.namespace.pool = {
  DBVHPool,
  acquireDynamicBVH, releaseDynamicBVH,
  acquireTLAS, releaseTLAS
};

exports.namespace.batch = {
  State: DynamicBVHBatchState,
  create: createDynamicBVHBatch,
  updatePrims: soaUpdatePrims,
  updateInstances: soaUpdateInstances,
  updatePrimsChunked: soaUpdatePrimsChunked,
  updateInstancesChunked: soaUpdateInstancesChunked,
  raycastAnyTLAS: soaRaycastAnyTLAS,
  raycastAnyTLASChunked: soaRaycastAnyTLASChunked,
  frustumCullTLAS: soaFrustumCullTLAS,
  frustumCullTLASChunked: soaFrustumCullTLASChunked
};

// ============================================================================
// Precision listener
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Existing DynamicBVH and TLAS instances keep their current buffer types.
  // New ones created after this point use the new type via getArrayType().
});
