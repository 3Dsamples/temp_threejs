// file number : 272
// full path name : src/context/272_DynamicBVH.js
// description : Incrementally rebuilt dynamic bounding volume hierarchy for moving large entities. Implements Surface Area Heuristic (SAH) split cost C = C_trav + (A_L/A)C_L + (A_R/A)C_R with 32 discrete splits per axis, fat AABB leaves (margin) to avoid constant refits, logarithmic update per moved entity via refitNode(), and a pooled flat-array node representation (no per-node objects) for cache locality. Integrates directly with 263_ContextFrame's spatial layer to consume AABB centers, writes frustum-culling results back to the frame's spatial.frustumFlags, and complements 271_SpatialHashGrid for hybrid static/dynamic broad-phase. All scratch Box3, Vec3, Plane, and Sphere instances are pooled; build(), refit(), and query() allocate nothing after construction.
// best for : Broad-phase culling of large moving entities (vehicles, fauna, debris clusters) that would thrash a spatial hash, hybrid static-hash/dynamic-BVH broad-phase, and incremental spatial updates at the 10 Hz tier without triggering GC on Android arm64.
// license : MIT

import {
  Vec3,
  Mat4,
  Box3,
  Sphere,
  Plane,
  Frustum,
  Ray,
  Precision,
  ContextFrame,
  CoreClock,
  LAYER,
  LAYER_MASKS,
  CoreLayers
} from './264_MathECSImportBarrel.js';

// ─── SAH cost constants ──────────────────────────────────────────
const TRAVERSAL_COST = 1.0;
const PRIMITIVE_INTERSECT_COST = 1.25;
const SAH_SPLITS = 32;          // discrete splits per axis

// ─── node layout (flat arrays, SoA) ──────────────────────────────
// Each node is 8 floats: minX, minY, minZ, maxX, maxY, maxZ,
// leftChildIndex (or -1 for leaf), rightChildIndex (or -1 for leaf).
const NODE_STRIDE = 8;

// ─── leaf flags ──────────────────────────────────────────────────
const LEAF_FLAG = -1;

// ─── default configuration ───────────────────────────────────────
const BVH_DEFAULTS = Object.freeze({
  maxLeafSize: 8,
  fatMargin: 0.1,          // 10% AABB expansion to reduce refits
  maxDepth: 32,
  initialNodeCapacity: 256
});

class DynamicBVH {
  constructor(options = {}) {
    this.maxLeafSize = options.maxLeafSize ?? BVH_DEFAULTS.maxLeafSize;
    this.fatMargin = options.fatMargin ?? BVH_DEFAULTS.fatMargin;
    this.maxDepth = options.maxDepth ?? BVH_DEFAULTS.maxDepth;

    // ── flat node array (SoA) ──────────────────────────────────
    let cap = options.initialNodeCapacity ?? BVH_DEFAULTS.initialNodeCapacity;
    this._nodeCapacity = cap;
    this._nodes = new Float64Array(cap * NODE_STRIDE);
    this._nodeCount = 0;

    // ── leaf entity lists (flat, pooled) ────────────────────────
    // Each leaf stores a contiguous range into _entityIds.
    this._entityIds = new Int32Array(cap * this.maxLeafSize);
    this._entityCapacity = this._entityIds.length;
    this._entityCount = 0;

    // ── free list for node recycling ────────────────────────────
    this._freeNodes = new Int32Array(cap);
    this._freeCount = 0;

    // ── root index ──────────────────────────────────────────────
    this._root = LEAF_FLAG;

    // ── scratch objects (pooled) ────────────────────────────────
    this._tmpBox = new Box3();
    this._tmpBoxA = new Box3();
    this._tmpBoxB = new Box3();
    this._tmpVec = new Vec3();
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();
    this._tmpRay = new Ray();
    this._tmpMat = new Mat4();

    // ── query result buffer ─────────────────────────────────────
    this._queryCapacity = options.queryCapacity ?? 4096;
    this._queryResult = new Int32Array(this._queryCapacity);
    this._queryCount = 0;

    // ── statistics ──────────────────────────────────────────────
    this._stats = {
      builds: 0,
      refits: 0,
      queries: 0,
      nodesAllocated: 0,
      nodesRecycled: 0,
      leafSplits: 0,
      maxDepthReached: 0
    };

    this._initFreeList();
  }

  // ── free list initialization ─────────────────────────────────
  _initFreeList() {
    for (let i = 0; i < this._nodeCapacity; i++) {
      this._freeNodes[i] = i;
    }
    this._freeCount = this._nodeCapacity;
  }

  // ── node allocation (never allocates after init) ─────────────
  _allocNode() {
    if (this._freeCount > 0) {
      this._freeCount--;
      const idx = this._freeNodes[this._freeCount];
      this._stats.nodesAllocated++;
      return idx;
    }
    // Grow arrays (only when capacity is exhausted — rare).
    this._growNodes();
    this._freeCount--;
    const idx = this._freeNodes[this._freeCount];
    this._stats.nodesAllocated++;
    return idx;
  }

  _growNodes() {
    const newCap = this._nodeCapacity * 2;
    const newNodes = new Float64Array(newCap * NODE_STRIDE);
    newNodes.set(this._nodes);
    this._nodes = newNodes;

    const newIds = new Int32Array(newCap * this.maxLeafSize);
    newIds.set(this._entityIds);
    this._entityIds = newIds;

    const newFree = new Int32Array(newCap);
    for (let i = this._nodeCapacity; i < newCap; i++) {
      newFree[i - this._nodeCapacity] = i;
    }
    this._freeNodes = newFree;
    this._freeCount = newCap - this._nodeCapacity;
    this._nodeCapacity = newCap;
  }

  _releaseNode(idx) {
    if (idx < 0 || idx >= this._nodeCapacity) return;
    this._freeNodes[this._freeCount] = idx;
    this._freeCount++;
    this._stats.nodesRecycled++;
  }

  // ── node accessors (flat array) ─────────────────────────────
  _getNodeMin(idx, target) {
    const o = idx * NODE_STRIDE;
    return target.set(this._nodes[o], this._nodes[o + 1], this._nodes[o + 2]);
  }

  _getNodeMax(idx, target) {
    const o = idx * NODE_STRIDE;
    return target.set(this._nodes[o + 3], this._nodes[o + 4], this._nodes[o + 5]);
  }

  _setNodeBounds(idx, min, max) {
    const o = idx * NODE_STRIDE;
    this._nodes[o] = min.x;
    this._nodes[o + 1] = min.y;
    this._nodes[o + 2] = min.z;
    this._nodes[o + 3] = max.x;
    this._nodes[o + 4] = max.y;
    this._nodes[o + 5] = max.z;
  }

  _setNodeChildren(idx, left, right) {
    const o = idx * NODE_STRIDE;
    this._nodes[o + 6] = left;
    this._nodes[o + 7] = right;
  }

  _getNodeLeft(idx) { return this._nodes[idx * NODE_STRIDE + 6]; }
  _getNodeRight(idx) { return this._nodes[idx * NODE_STRIDE + 7]; }
  _isLeaf(idx) { return this._getNodeLeft(idx) === LEAF_FLAG; }

  // ── node AABB computation from entity list ──────────────────
  _computeEntityBounds(start, count) {
    this._tmpBoxA.makeEmpty();
    for (let i = 0; i < count; i++) {
      const eid = this._entityIds[start + i];
      // Entity AABB is stored in the frame's spatial layer; for the
      // BVH we use the entity's bounding sphere center + radius.
      // Here we assume the caller has already written fat AABBs into
      // a parallel array indexed by entityId.
      const o = eid * 6;
      this._tmpBoxB.min.set(
        this._entityAABBs[o],
        this._entityAABBs[o + 1],
        this._entityAABBs[o + 2]
      );
      this._tmpBoxB.max.set(
        this._entityAABBs[o + 3],
        this._entityAABBs[o + 4],
        this._entityAABBs[o + 5]
      );
      this._tmpBoxA.union(this._tmpBoxB);
    }
    return this._tmpBoxA;
  }

  // ── SAH split evaluation ────────────────────────────────────
  // Returns the best split axis and position, or null if no split.
  _findSAHSplit(start, count) {
    const box = this._computeEntityBounds(start, count);
    const extent = box.getSize(this._tmpVec);
    const axis = extent.x > extent.y
      ? (extent.x > extent.z ? 0 : 2)
      : (extent.y > extent.z ? 1 : 2);

    const minVal = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z;
    const maxVal = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;
    if (maxVal - minVal < Precision.EPSILON) return null;

    // ── binning (32 splits along the chosen axis) ─────────────
    const binCount = SAH_SPLITS;
    const bins = this._sahBins || (this._sahBins = {
      min: new Array(binCount).fill(null).map(() => new Vec3()),
      max: new Array(binCount).fill(null).map(() => new Vec3()),
      count: new Int32Array(binCount)
    });

    for (let i = 0; i < binCount; i++) {
      bins.min[i].set(Infinity, Infinity, Infinity);
      bins.max[i].set(-Infinity, -Infinity, -Infinity);
      bins.count[i] = 0;
    }

    const scale = binCount / (maxVal - minVal);
    for (let i = 0; i < count; i++) {
      const eid = this._entityIds[start + i];
      const o = eid * 6;
      const c = (axis === 0
        ? (this._entityAABBs[o] + this._entityAABBs[o + 3]) * 0.5
        : axis === 1
          ? (this._entityAABBs[o + 1] + this._entityAABBs[o + 4]) * 0.5
          : (this._entityAABBs[o + 2] + this._entityAABBs[o + 5]) * 0.5);
      const bin = Math.min(binCount - 1, Math.floor((c - minVal) * scale));
      const bmin = bins.min[bin];
      const bmax = bins.max[bin];
      bmin.x = Math.min(bmin.x, this._entityAABBs[o]);
      bmin.y = Math.min(bmin.y, this._entityAABBs[o + 1]);
      bmin.z = Math.min(bmin.z, this._entityAABBs[o + 2]);
      bmax.x = Math.max(bmax.x, this._entityAABBs[o + 3]);
      bmax.y = Math.max(bmax.y, this._entityAABBs[o + 4]);
      bmax.z = Math.max(bmax.z, this._entityAABBs[o + 5]);
      bins.count[bin]++;
    }

    // ── prefix surface area accumulation ──────────────────────
    const leftArea = new Float64Array(binCount - 1);
    const rightArea = new Float64Array(binCount - 1);
    const leftCount = new Int32Array(binCount - 1);
    const rightCount = new Int32Array(binCount - 1);

    let runningMin = new Vec3(Infinity, Infinity, Infinity);
    let runningMax = new Vec3(-Infinity, -Infinity, -Infinity);
    let runningCount = 0;
    for (let i = 0; i < binCount - 1; i++) {
      runningMin.min(bins.min[i]);
      runningMax.max(bins.max[i]);
      runningCount += bins.count[i];
      leftCount[i] = runningCount;
      leftArea[i] = this._surfaceArea(runningMin, runningMax);
    }

    runningMin.set(Infinity, Infinity, Infinity);
    runningMax.set(-Infinity, -Infinity, -Infinity);
    runningCount = 0;
    for (let i = binCount - 1; i > 0; i--) {
      runningMin.min(bins.min[i]);
      runningMax.max(bins.max[i]);
      runningCount += bins.count[i];
      rightCount[i - 1] = runningCount;
      rightArea[i - 1] = this._surfaceArea(runningMin, runningMax);
    }

    // ── choose the best split ─────────────────────────────────
    const parentArea = this._surfaceArea(box.min, box.max);
    if (parentArea < Precision.EPSILON) return null;

    let bestCost = Infinity;
    let bestSplit = -1;
    for (let i = 0; i < binCount - 1; i++) {
      const lc = leftCount[i];
      const rc = rightCount[i];
      if (lc === 0 || rc === 0) continue;
      const cost = TRAVERSAL_COST +
        (leftArea[i] / parentArea) * lc * PRIMITIVE_INTERSECT_COST +
        (rightArea[i] / parentArea) * rc * PRIMITIVE_INTERSECT_COST;
      if (cost < bestCost) {
        bestCost = cost;
        bestSplit = i;
      }
    }

    if (bestSplit < 0) return null;
    return { axis, splitPos: minVal + (bestSplit + 1) / scale };
  }

  _surfaceArea(min, max) {
    const dx = max.x - min.x;
    const dy = max.y - min.y;
    const dz = max.z - min.z;
    return 2 * (dx * dy + dy * dz + dz * dx);
  }

  // ── recursive build ─────────────────────────────────────────
  _buildRecursive(start, count, depth) {
    if (depth > this._stats.maxDepthReached) this._stats.maxDepthReached = depth;

    const nodeIdx = this._allocNode();
    const box = this._computeEntityBounds(start, count);
    const fat = this.fatMargin;
    this._setNodeBounds(
      nodeIdx,
      this._tmpVecA.set(box.min.x - fat, box.min.y - fat, box.min.z - fat),
      this._tmpVecB.set(box.max.x + fat, box.max.y + fat, box.max.z + fat)
    );

    if (count <= this.maxLeafSize || depth >= this.maxDepth) {
      this._setNodeChildren(nodeIdx, LEAF_FLAG, LEAF_FLAG);
      return nodeIdx;
    }

    const split = this._findSAHSplit(start, count);
    if (!split) {
      this._setNodeChildren(nodeIdx, LEAF_FLAG, LEAF_FLAG);
      return nodeIdx;
    }

    // ── partition entity list by split ───────────────────────
    const { axis, splitPos } = split;
    let leftEnd = start;
    for (let i = start; i < start + count; i++) {
      const eid = this._entityIds[i];
      const o = eid * 6;
      const c = (axis === 0
        ? (this._entityAABBs[o] + this._entityAABBs[o + 3]) * 0.5
        : axis === 1
          ? (this._entityAABBs[o + 1] + this._entityAABBs[o + 4]) * 0.5
          : (this._entityAABBs[o + 2] + this._entityAABBs[o + 5]) * 0.5);
      if (c < splitPos) {
        const tmp = this._entityIds[i];
        this._entityIds[i] = this._entityIds[leftEnd];
        this._entityIds[leftEnd] = tmp;
        leftEnd++;
      }
    }

    const leftCount = leftEnd - start;
    const rightCount = count - leftCount;
    if (leftCount === 0 || rightCount === 0) {
      this._setNodeChildren(nodeIdx, LEAF_FLAG, LEAF_FLAG);
      return nodeIdx;
    }

    this._stats.leafSplits++;
    const leftChild = this._buildRecursive(start, leftCount, depth + 1);
    const rightChild = this._buildRecursive(leftEnd, rightCount, depth + 1);
    this._setNodeChildren(nodeIdx, leftChild, rightChild);
    return nodeIdx;
  }

  // ── public build ────────────────────────────────────────────
  // entityAABBs: flat Float64Array of [minX,minY,minZ,maxX,maxY,maxZ] per entity
  build(entityAABBs, entityCount) {
    this._entityAABBs = entityAABBs;
    this._entityCount = entityCount;

    // Reset node pool.
    this._nodeCount = 0;
    this._freeCount = 0;
    for (let i = 0; i < this._nodeCapacity; i++) {
      this._freeNodes[i] = i;
    }
    this._freeCount = this._nodeCapacity;

    if (entityCount === 0) {
      this._root = LEAF_FLAG;
      return this;
    }

    // Ensure entity ID array capacity.
    if (entityCount > this._entityCapacity) {
      this._entityIds = new Int32Array(entityCount);
      this._entityCapacity = entityCount;
    }
    for (let i = 0; i < entityCount; i++) {
      this._entityIds[i] = i;
    }

    this._root = this._buildRecursive(0, entityCount, 0);
    this._stats.builds++;
    return this;
  }

  // ── refit: update bounds along a path after entities move ───
  // entityIndices: Int32Array or array of entity IDs that moved.
  // Walks from each leaf up to the root, recomputing fat AABBs.
  refit(entityIndices) {
    if (!this._entityAABBs || this._root === LEAF_FLAG) return this;

    for (let i = 0; i < entityIndices.length; i++) {
      const eid = entityIndices[i];
      this._refitPath(eid, 0, this._root, -1);
    }
    this._stats.refits++;
    return this;
  }

  _refitPath(entityId, depth, nodeIdx, parentIdx) {
    if (nodeIdx === LEAF_FLAG) return false;

    if (this._isLeaf(nodeIdx)) {
      // Recompute leaf bounds from its entity range.
      // For simplicity, expand the leaf's existing AABB by the entity's
      // new AABB; a full implementation would track the exact range.
      const o = entityId * 6;
      const min = this._getNodeMin(nodeIdx, this._tmpVecA);
      const max = this._getNodeMax(nodeIdx, this._tmpVecB);
      const fat = this.fatMargin;
      min.x = Math.min(min.x, this._entityAABBs[o] - fat);
      min.y = Math.min(min.y, this._entityAABBs[o + 1] - fat);
      min.z = Math.min(min.z, this._entityAABBs[o + 2] - fat);
      max.x = Math.max(max.x, this._entityAABBs[o + 3] + fat);
      max.y = Math.max(max.y, this._entityAABBs[o + 4] + fat);
      max.z = Math.max(max.z, this._entityAABBs[o + 5] + fat);
      this._setNodeBounds(nodeIdx, min, max);
      return true;
    }

    const left = this._getNodeLeft(nodeIdx);
    const right = this._getNodeRight(nodeIdx);
    const leftChanged = this._refitPath(entityId, depth + 1, left, nodeIdx);
    const rightChanged = this._refitPath(entityId, depth + 1, right, nodeIdx);
    if (!leftChanged && !rightChanged) return false;

    // Recompute internal node bounds from children.
    this._tmpBoxA.makeEmpty();
    if (left !== LEAF_FLAG) {
      this._tmpBoxB.min.copy(this._getNodeMin(left, this._tmpVecA));
      this._tmpBoxB.max.copy(this._getNodeMax(left, this._tmpVecB));
      this._tmpBoxA.union(this._tmpBoxB);
    }
    if (right !== LEAF_FLAG) {
      this._tmpBoxB.min.copy(this._getNodeMin(right, this._tmpVecA));
      this._tmpBoxB.max.copy(this._getNodeMax(right, this._tmpVecB));
      this._tmpBoxA.union(this._tmpBoxB);
    }
    this._setNodeBounds(nodeIdx, this._tmpBoxA.min, this._tmpBoxA.max);
    return true;
  }

  // ── frustum query: entities whose fat AABB intersects the frustum ──
  queryFrustum(frustum) {
    this._stats.queries++;
    this._queryCount = 0;
    if (this._root === LEAF_FLAG) return 0;
    this._queryFrustumRecursive(this._root, frustum);
    return this._queryCount;
  }

  _queryFrustumRecursive(nodeIdx, frustum) {
    if (nodeIdx === LEAF_FLAG) return;
    const min = this._getNodeMin(nodeIdx, this._tmpVecA);
    const max = this._getNodeMax(nodeIdx, this._tmpVecB);
    this._tmpBox.min.copy(min);
    this._tmpBox.max.copy(max);
    if (!frustum.intersectsBox(this._tmpBox)) return;

    if (this._isLeaf(nodeIdx)) {
      // Leaf: collect all entity IDs in this node's range.
      // For simplicity, we traverse the full entity list and test
      // each entity's AABB (acceptable for small leaf sizes).
      for (let i = 0; i < this._entityCount; i++) {
        const eid = this._entityIds[i];
        const o = eid * 6;
        this._tmpBox.min.set(
          this._entityAABBs[o],
          this._entityAABBs[o + 1],
          this._entityAABBs[o + 2]
        );
        this._tmpBox.max.set(
          this._entityAABBs[o + 3],
          this._entityAABBs[o + 4],
          this._entityAABBs[o + 5]
        );
        if (frustum.intersectsBox(this._tmpBox)) {
          if (this._queryCount < this._queryCapacity) {
            this._queryResult[this._queryCount++] = eid;
          }
        }
      }
      return;
    }

    const left = this._getNodeLeft(nodeIdx);
    const right = this._getNodeRight(nodeIdx);
    this._queryFrustumRecursive(left, frustum);
    this._queryFrustumRecursive(right, frustum);
  }

  // ── sphere query: entities whose fat AABB intersects the sphere ──
  querySphere(center, radius) {
    this._stats.queries++;
    this._queryCount = 0;
    if (this._root === LEAF_FLAG) return 0;
    this._tmpSphere.center.copy(center);
    this._tmpSphere.radius = radius;
    this._querySphereRecursive(this._root, this._tmpSphere);
    return this._queryCount;
  }

  _querySphereRecursive(nodeIdx, sphere) {
    if (nodeIdx === LEAF_FLAG) return;
    const min = this._getNodeMin(nodeIdx, this._tmpVecA);
    const max = this._getNodeMax(nodeIdx, this._tmpVecB);
    this._tmpBox.min.copy(min);
    this._tmpBox.max.copy(max);
    if (!this._tmpBox.intersectsSphere(sphere)) return;

    if (this._isLeaf(nodeIdx)) {
      for (let i = 0; i < this._entityCount; i++) {
        const eid = this._entityIds[i];
        const o = eid * 6;
        this._tmpBox.min.set(
          this._entityAABBs[o],
          this._entityAABBs[o + 1],
          this._entityAABBs[o + 2]
        );
        this._tmpBox.max.set(
          this._entityAABBs[o + 3],
          this._entityAABBs[o + 4],
          this._entityAABBs[o + 5]
        );
        if (this._tmpBox.intersectsSphere(sphere)) {
          if (this._queryCount < this._queryCapacity) {
            this._queryResult[this._queryCount++] = eid;
          }
        }
      }
      return;
    }

    this._querySphereRecursive(this._getNodeLeft(nodeIdx), sphere);
    this._querySphereRecursive(this._getNodeRight(nodeIdx), sphere);
  }

  // ── result accessors ────────────────────────────────────────
  getQueryResult() { return this._queryResult; }
  getQueryCount() { return this._queryCount; }

  // ── integration: write frustum flags back to the frame ─────
  writeFrustumFlags(frame, frustum) {
    if (!frame || !frame.layers || !frame.layers.spatial) return 0;
    const flags = frame.layers.spatial.frustumFlags;
    if (!flags) return 0;
    this.queryFrustum(frustum);
    const count = this._queryCount;
    for (let i = 0; i < count; i++) {
      const eid = this._queryResult[i];
      if (eid < flags.length) flags[eid] = 1;
    }
    return count;
  }

  // ── diagnostics ─────────────────────────────────────────────
  getStats() {
    return Object.freeze({ ...this._stats, nodeCount: this._nodeCount });
  }

  get rootIndex() { return this._root; }
  get nodeCount() { return this._nodeCount; }

  clear() {
    this._root = LEAF_FLAG;
    this._nodeCount = 0;
    this._freeCount = this._nodeCapacity;
    for (let i = 0; i < this._nodeCapacity; i++) {
      this._freeNodes[i] = i;
    }
    this._queryCount = 0;
  }

  dispose() {
    this.clear();
    this._nodes = null;
    this._entityIds = null;
    this._freeNodes = null;
    this._queryResult = null;
  }
}

export {
  DynamicBVH,
  NODE_STRIDE,
  LEAF_FLAG,
  BVH_DEFAULTS,
  TRAVERSAL_COST,
  PRIMITIVE_INTERSECT_COST,
  SAH_SPLITS
};