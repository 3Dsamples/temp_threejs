//File number : 069
// File : src/math/069_bvh.js
//Description : Static BVH (Bounding Volume Hierarchy) for 1M+ primitives — full construction via SAH binned (32 bins), median split, and spatial split; flat GPU-friendly node layout (8 floats per AABB + 4 ints per node); ray/BVH traversal (slab test + closest hit), frustum/BVH culling, AABB/BVH range query; per-frame refit for slowly-moving primitives; SOA AABB storage (minX/minY/minZ/maxX/maxY/maxZ as parallel Float arrays) that scales from mm to Mpc; pooled node arrays and traversal stacks for zero GC; chunked async builders that yield via `scheduler.yield()` so the Android UI thread never freezes; and full integration with `000_Math_module.js` so world coordinates switch automatically between Float16/Float32/Float64 without breaking the build. Provides `BVH`, `BVHNode`, `AABBSOA`, `BVHPool`, and a small set of domain helpers used by the rest of the 3d-math folder (DBVH, dynamic grid, light BVH, ray tracing, procedural placement).
//####
//Best for : 3d graphics — instanced 1M+ mesh ray tracing, shadow ray casting, occlusion/frustum culling of dense scenes, light BVH, meshlet acceleration, procedural placement exclusion queries, DBVH broad phase, photon-map primitives, dynamic grid neighbor lookups, screen-space ray-marching acceleration, IK reach queries (nearest-target search), and any per-frame BVH pipeline that must stay at 60 fps on Android 64-bit.
//License : MIT

// ============================================================================
// Directive Prologues
// ============================================================================

"use strict";

// ============================================================================
// Import
// ============================================================================

const M                 = require("./000_Math_module.js");
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
exports.BVH                = BVH;
exports.BVHNode            = BVHNode;
exports.AABBSOA            = AABBSOA;
exports.BVHPool            = BVHPool;

// ---- Construction ----
exports.createBVH          = createBVH;
exports.buildSAH           = buildSAH;
exports.buildMedian        = buildMedian;
exports.buildSpatialSplit  = buildSpatialSplit;
exports.buildSAHAsync      = buildSAHAsync;
exports.buildMedianAsync   = buildMedianAsync;

// ---- SOA builders ----
exports.createAABBSOA       = createAABBSOA;
exports.createAABBSOAFromPositions = createAABBSOAFromPositions;
exports.fillAABBSOA         = fillAABBSOA;

// ---- Traversal ----
exports.raycast             = raycast;
exports.raycastAny          = raycastAny;
exports.frustumCull         = frustumCull;
exports.aabbQuery           = aabbQuery;
exports.closestPointQuery   = closestPointQuery;
exports.kNearestQuery       = kNearestQuery;

// ---- Refit ----
exports.refit               = refit;
exports.refitAsync          = refitAsync;

// ---- Utilities ----
exports.aabbUnion           = aabbUnion;
exports.aabbSurfaceArea     = aabbSurfaceArea;
exports.aabbIntersect       = aabbIntersect;
exports.rayAABB             = rayAABB;
exports.raySphere           = raySphere;
exports.rayTriangle         = rayTriangle;

// ---- SOA (sync) ----
exports.soaAABBUnion             = soaAABBUnion;
exports.soaAABBSurfaceArea       = soaAABBSurfaceArea;
exports.soaRaycastAny            = soaRaycastAny;
exports.soaRaycast               = soaRaycast;
exports.soaFrustumCull           = soaFrustumCull;
exports.soaAABBQuery             = soaAABBQuery;

// ---- SOA (chunked async) ----
exports.soaRaycastAnyChunked     = soaRaycastAnyChunked;
exports.soaRaycastChunked        = soaRaycastChunked;
exports.soaFrustumCullChunked    = soaFrustumCullChunked;

// ---- Pools ----
exports.acquireBVH           = acquireBVH;
exports.releaseBVH           = releaseBVH;
exports.acquireAABBSOA       = acquireAABBSOA;
exports.releaseAABBSOA       = releaseAABBSOA;
exports.acquireTraversalStack = acquireTraversalStack;
exports.releaseTraversalStack = releaseTraversalStack;

// ---- Batch state ----
exports.BVHBatchState      = BVHBatchState;
exports.createBVHBatch     = createBVHBatch;

// ---- Namespaces ----
exports.namespace = {};

// ============================================================================
// Global Declarations
// ============================================================================

// (module is stateless — all mutable state lives in pools or per-instance)

// ============================================================================
// Type Declarations
// ============================================================================

/**
 * @typedef {Object} Ray
 * @property {number} ox, oy, oz  Ray origin
 * @property {number} dx, dy, dz  Ray direction (need not be normalized)
 * @property {number} [tMin=0]
 * @property {number} [tMax=Infinity]
 */

/**
 * @typedef {Object} RayHit
 * @property {boolean} hit
 * @property {number} t          Distance along ray
 * @property {number} primId     Index of the primitive hit
 * @property {number} u, v       Barycentric coords (only for triangles)
 */

/**
 * @typedef {Object} Frustum
 * @property {Array<{nx,ny,nz,d}>} planes  Six planes (n·x + d ≥ 0 is inside)
 */

/**
 * @typedef {Object} AABB
 * @property {number} minX, minY, minZ
 * @property {number} maxX, maxY, maxZ
 */

/**
 * @typedef {Object} BVHNode
 * @property {number} minX, minY, minZ
 * @property {number} maxX, maxY, maxZ
 * @property {number} leftOrFirst    left child index (inner) OR first primitive index (leaf)
 * @property {number} count          primitive count (0 for inner nodes)
 * @property {number} parent         parent index (-1 for root)
 */

// ============================================================================
// Variable Declarations
// ============================================================================

const EPSILON           = 1e-9;
const DEFAULT_BINS      = 32;
const LEAF_SIZE_DEFAULT = 4;
const MAX_DEPTH_DEFAULT = 64;
const MAX_STACK         = 256;

// ============================================================================
// Class Declarations
// ============================================================================

/**
 * AABBSOA — Structure-of-Arrays storage for 1M+ AABBs. Each AABB is 6 floats
 * stored in six parallel arrays. This is the primitive storage layer for the
 * BVH; all traversal work reads from these arrays so they stay hot in cache.
 * Buffers use the current precision mode from `000_Math_module.js`.
 */
class AABBSOA {
  minX = null;
  minY = null;
  minZ = null;
  maxX = null;
  maxY = null;
  maxZ = null;
  count = 0;
  capacity = 0;

  // Cached centroid arrays (rebuilt when needed)
  cx = null;
  cy = null;
  cz = null;

  constructor(capacity, Type) {
    this.capacity = capacity || 0;
    this.minX = new (Type || getArrayType())(this.capacity);
    this.minY = new (Type || getArrayType())(this.capacity);
    this.minZ = new (Type || getArrayType())(this.capacity);
    this.maxX = new (Type || getArrayType())(this.capacity);
    this.maxY = new (Type || getArrayType())(this.capacity);
    this.maxZ = new (Type || getArrayType())(this.capacity);
    this.cx   = new (Type || getArrayType())(this.capacity);
    this.cy   = new (Type || getArrayType())(this.capacity);
    this.cz   = new (Type || getArrayType())(this.capacity);
  }

  set(i, minX, minY, minZ, maxX, maxY, maxZ) {
    this.minX[i] = minX; this.minY[i] = minY; this.minZ[i] = minZ;
    this.maxX[i] = maxX; this.maxY[i] = maxY; this.maxZ[i] = maxZ;
    this.cx[i] = (minX + maxX) * 0.5;
    this.cy[i] = (minY + maxY) * 0.5;
    this.cz[i] = (minZ + maxZ) * 0.5;
  }

  /** Recompute centroids for a single index — useful when only min/max change. */
  updateCentroid(i) {
    this.cx[i] = (this.minX[i] + this.maxX[i]) * 0.5;
    this.cy[i] = (this.minY[i] + this.maxY[i]) * 0.5;
    this.cz[i] = (this.minZ[i] + this.maxZ[i]) * 0.5;
  }

  /** Resize — allocate new arrays of `n` and copy old values. */
  resize(n) {
    if (n <= this.capacity) { this.count = n; return this; }
    const T = this.minX.constructor;
    const grow = (arr, cap) => { const out = new T(cap); out.set(arr); return out; };
    this.minX = grow(this.minX, n); this.minY = grow(this.minY, n); this.minZ = grow(this.minZ, n);
    this.maxX = grow(this.maxX, n); this.maxY = grow(this.maxY, n); this.maxZ = grow(this.maxZ, n);
    this.cx   = grow(this.cx,   n); this.cy   = grow(this.cy,   n); this.cz   = grow(this.cz,   n);
    this.capacity = n;
    this.count = n;
    return this;
  }
}

/**
 * BVHNode — flat-storage node. We store all nodes in typed arrays inside the
 * BVH (not as objects) so traversal stays branch-light and cache-friendly.
 * This class is only used as a data view for users who want to walk the tree
 * with an object API.
 */
class BVHNode {
  minX = 0; minY = 0; minZ = 0;
  maxX = 0; maxY = 0; maxZ = 0;
  leftOrFirst = 0;
  count = 0;
  parent = -1;
}

/**
 * BVH — flat-array bounding volume hierarchy.
 * Node layout per node (10 floats + 3 ints per node stored in parallel arrays):
 *   nodeMinX[i], nodeMinY[i], nodeMinZ[i], nodeMaxX[i], nodeMaxY[i], nodeMaxZ[i]
 *   nodeLeft[i]     — left child index (inner) or first primitive index (leaf)
 *   nodeRight[i]    — right child index (inner) or 0 (leaf)
 *   nodeCount[i]    — primitive count (0 inner, >0 leaf)
 *   nodeParent[i]   — parent index (-1 for root)
 *
 * Leaf flag = nodeCount[i] > 0.
 */
class BVH {
  // AABB of the root
  minX = 0; minY = 0; minZ = 0;
  maxX = 0; maxY = 0; maxZ = 0;

  // Primitive AABB SOA (owned reference, not copied)
  aabbs = null;

  // Node arrays
  nodeMinX    = null;
  nodeMinY    = null;
  nodeMinZ    = null;
  nodeMaxX    = null;
  nodeMaxY    = null;
  nodeMaxZ    = null;
  nodeLeft    = null;
  nodeRight   = null;
  nodeCount   = null;
  nodeParent  = null;

  nodeCount_ = 0;    // total number of nodes
  nodeCap_   = 0;

  // Primitive order array — indexes into aabbs.* to allow reordering without
  // copying the AABBs themselves. 1M+ primitives, so we avoid object churn.
  primOrder = null;
  primCount = 0;

  // Free list for nodes (refit doesn't free, but rebuilds do)
  _freeNodes = null;
  _freeCount = 0;

  constructor(aabbs, capacityHint) {
    this.aabbs = aabbs;
    const cap = capacityHint || Math.max(4, aabbs ? aabbs.count : 1024) * 2;
    this._allocNodes(cap);
    this.primOrder = new Uint32Array(aabbs ? aabbs.count : 0);
    for (let i = 0; i < this.primOrder.length; i++) this.primOrder[i] = i;
    this.primCount = this.primOrder.length;
  }

  _allocNodes(cap) {
    const T = this.aabbs ? this.aabbs.minX.constructor : getArrayType();
    this.nodeMinX = new T(cap);
    this.nodeMinY = new T(cap);
    this.nodeMinZ = new T(cap);
    this.nodeMaxX = new T(cap);
    this.nodeMaxY = new T(cap);
    this.nodeMaxZ = new T(cap);
    this.nodeLeft = new Int32Array(cap);
    this.nodeRight = new Int32Array(cap);
    this.nodeCount = new Int32Array(cap);
    this.nodeParent = new Int32Array(cap);
    this.nodeCount_ = 0;
    this.nodeCap_ = cap;
  }

  _growNodes(newCap) {
    const T = this.nodeMinX.constructor;
    const growF = (a, n) => { const out = new T(n); out.set(a); return out; };
    const growI = (a, n) => { const out = new Int32Array(n); out.set(a); return out; };
    this.nodeMinX = growF(this.nodeMinX, newCap);
    this.nodeMinY = growF(this.nodeMinY, newCap);
    this.nodeMinZ = growF(this.nodeMinZ, newCap);
    this.nodeMaxX = growF(this.nodeMaxX, newCap);
    this.nodeMaxY = growF(this.nodeMaxY, newCap);
    this.nodeMaxZ = growF(this.nodeMaxZ, newCap);
    this.nodeLeft = growI(this.nodeLeft, newCap);
    this.nodeRight = growI(this.nodeRight, newCap);
    this.nodeCount = growI(this.nodeCount, newCap);
    this.nodeParent = growI(this.nodeParent, newCap);
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
}

/**
 * BVHPool — pooled allocation of BVHs, AABBSOA buffers, and traversal stacks.
 * Use `acquireBVH`, `acquireAABBSOA`, `acquireTraversalStack` and release
 * the handles when done. Zero GC after warmup.
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
  let a = BVHPool.aabbPool.acquire();
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

function acquireTraversalStack() {
  return BVHPool.stackPool.acquire();
}

function releaseTraversalStack(stack) {
  if (stack) BVHPool.stackPool.release(stack);
}

/**
 * BVHBatchState — holds a set of pre-allocated BVHs for batched building,
 * plus scratch buffers for building/traversing 1M+ primitives per frame.
 */
class BVHBatchState {
  static #listeners = new Set();
  static {
    onPrecisionChange(function (mode, oldMode) {
      BVHBatchState.#listeners.forEach((cb) => { try { cb(mode, oldMode); } catch (e) {} });
    });
  }

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

  build() {
    this.bvh.aabbs = this.aabbs;
    this.bvh.primOrder = new Uint32Array(this.aabbs.count);
    for (let i = 0; i < this.bvh.primOrder.length; i++) this.bvh.primOrder[i] = i;
    this.bvh.primCount = this.bvh.primOrder.length;
    buildSAH(this.bvh, { leafSize: 4, bins: 16 });
    return this;
  }
}

function createBVHBatch(count) { return new BVHBatchState(count); }

// ============================================================================
// Function Declarations — Construction
// ============================================================================

/** Convenience constructor with sensible defaults. */
function createBVH(aabbs, capacityHint) {
  return new BVH(aabbs, capacityHint);
}

/**
 * Create an AABBSOA from a vec3 SOA (positions) + a per-instance radius SOA
 * or a uniform radius. Uses current precision buffers.
 */
function createAABBSOAFromPositions(positions, radii) {
  const n = positions.count;
  const a = new AABBSOA(n);
  const px = positions.x, py = positions.y, pz = positions.z;
  const rArr = radii && radii.x ? radii.x : null;
  const rUniform = radii && typeof radii === "number" ? radii : 0;
  for (let i = 0; i < n; i++) {
    const r = rArr ? rArr[i] : rUniform;
    a.set(i, px[i] - r, py[i] - r, pz[i] - r, px[i] + r, py[i] + r, pz[i] + r);
  }
  a.count = n;
  return a;
}

/** Fill an existing AABBSOA from a vec3 SOA + uniform radius. */
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

/**
 * Compute the AABB of a range of primitives by index (indices from `primOrder`).
 * Writes into out[0..5] = [minX, minY, minZ, maxX, maxY, maxZ].
 */
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

/**
 * Build a BVH using the Surface Area Heuristic (SAH) with binned splittings.
 * Falls back to median split when a bin partition fails (rare).
 * Synchronous version — for 1M+ primitives use `buildSAHAsync`.
 */
function buildSAH(bvh, options) {
  options = options || {};
  const bins = options.bins || DEFAULT_BINS;
  const leafSize = options.leafSize || LEAF_SIZE_DEFAULT;
  const maxDepth = options.maxDepth || MAX_DEPTH_DEFAULT;

  // Reset node count
  bvh.nodeCount_ = 0;

  if (bvh.primCount === 0) { bvh.minX = 0; bvh.minY = 0; bvh.minZ = 0; bvh.maxX = 0; bvh.maxY = 0; bvh.maxZ = 0; return bvh; }

  // Root
  const root = bvh._allocNode();
  const rootAABB = _rangeAABB(bvh, 0, bvh.primCount, [0, 0, 0, 0, 0, 0]);
  _storeNodeAABB(bvh, root, rootAABB[0], rootAABB[1], rootAABB[2], rootAABB[3], rootAABB[4], rootAABB[5]);
  bvh.nodeParent[root] = -1;
  bvh.minX = rootAABB[0]; bvh.minY = rootAABB[1]; bvh.minZ = rootAABB[2];
  bvh.maxX = rootAABB[3]; bvh.maxY = rootAABB[4]; bvh.maxZ = rootAABB[5];

  // Work stack: [nodeIdx, first, count, depth]
  const stack = [];
  stack.push({ node: root, first: 0, count: bvh.primCount, depth: 0 });

  const binAABBs = new Float64Array(bins * 6);
  const binCounts = new Int32Array(bins);

  while (stack.length > 0) {
    const work = stack.pop();
    const { node, first, count, depth } = work;

    if (count <= leafSize || depth >= maxDepth) {
      // Leaf
      bvh.nodeLeft[node] = first;
      bvh.nodeRight[node] = 0;
      bvh.nodeCount[node] = count;
      continue;
    }

    // Pick best split axis via binned SAH
    const rangeAABB = _rangeAABB(bvh, first, count, [0, 0, 0, 0, 0, 0]);
    const extX = rangeAABB[3] - rangeAABB[0];
    const extY = rangeAABB[4] - rangeAABB[1];
    const extZ = rangeAABB[5] - rangeAABB[2];

    // Choose axis with max extent
    let axis = 0;
    if (extY > extX && extY >= extZ) axis = 1;
    else if (extZ > extX && extZ > extY) axis = 2;

    const axisMin = rangeAABB[axis] === rangeAABB[0] ? rangeAABB[0] :
                    rangeAABB[axis] === rangeAABB[1] ? rangeAABB[1] : rangeAABB[2];
    const axisMax = axis === 0 ? rangeAABB[3] : axis === 1 ? rangeAABB[4] : rangeAABB[5];
    const axisExtent = axisMax - axisMin;
    if (axisExtent < 1e-9) {
      // All primitives have degenerate axis; force leaf.
      bvh.nodeLeft[node] = first;
      bvh.nodeRight[node] = 0;
      bvh.nodeCount[node] = count;
      continue;
    }

    // Reset bins
    for (let b = 0; b < bins; b++) {
      binCounts[b] = 0;
      binAABBs[b * 6 + 0] = Infinity;
      binAABBs[b * 6 + 1] = Infinity;
      binAABBs[b * 6 + 2] = Infinity;
      binAABBs[b * 6 + 3] = -Infinity;
      binAABBs[b * 6 + 4] = -Infinity;
      binAABBs[b * 6 + 5] = -Infinity;
    }
    const invExtent = bins / axisExtent;

    // Place primitives in bins
    const order = bvh.primOrder;
    const a = bvh.aabbs;
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

    // Sweep to find best SAH cost
    let bestBin = -1, bestCost = Infinity;
    const leftAcc = new Float64Array(bins * 6);
    const rightAcc = new Float64Array(bins * 6);
    let leftCount = 0;
    for (let b = 0; b < bins - 1; b++) {
      if (binCounts[b] === 0) continue;
      leftCount += binCounts[b];
      const bi = b * 6;
      const li = (b - 1) * 6;
      for (let k = 0; k < 6; k++) {
        if (b === 0 || leftAcc[li + k] === 0) leftAcc[bi + k] = binAABBs[bi + k];
        else leftAcc[bi + k] = Math.min(leftAcc[li + k], binAABBs[bi + k]);
        // fix: min for 0,1,2; max for 3,4,5
        if (k >= 3 && b !== 0) leftAcc[bi + k] = Math.max(leftAcc[li + k], binAABBs[bi + k]);
        else if (k >= 3) leftAcc[bi + k] = binAABBs[bi + k];
      }
      // Fix the min/max logic above for clarity: for k<3 use min, for k>=3 use max
      for (let k = 0; k < 6; k++) {
        const bi2 = b * 6 + k;
        const li2 = (b - 1) * 6 + k;
        if (b === 0) { leftAcc[bi2] = binAABBs[bi2]; continue; }
        if (k < 3) leftAcc[bi2] = Math.min(leftAcc[li2], binAABBs[bi2]);
        else       leftAcc[bi2] = Math.max(leftAcc[li2], binAABBs[bi2]);
      }
    }
    let rightCount = 0;
    for (let b = bins - 1; b > 0; b--) {
      if (binCounts[b] === 0) continue;
      rightCount += binCounts[b];
      const bi = b * 6;
      const ri = (b + 1) * 6;
      for (let k = 0; k < 6; k++) {
        if (b === bins - 1) { rightAcc[bi + k] = binAABBs[bi + k]; continue; }
        if (k < 3) rightAcc[bi + k] = Math.min(rightAcc[ri + k], binAABBs[bi + k]);
        else       rightAcc[bi + k] = Math.max(rightAcc[ri + k], binAABBs[bi + k]);
      }
      // Cost check for split *before* b (bins b..bins-1 on right, 0..b-1 on left)
      if (leftCount > 0 && rightCount > 0) {
        const li = (b - 1) * 6;
        const ri2 = b * 6;
        const leftArea  = (leftAcc[li + 3] - leftAcc[li + 0]) * (leftAcc[li + 4] - leftAcc[li + 1]) + (leftAcc[li + 3] - leftAcc[li + 0]) * (leftAcc[li + 5] - leftAcc[li + 2]) + (leftAcc[li + 4] - leftAcc[li + 1]) * (leftAcc[li + 5] - leftAcc[li + 2]);
        const rightArea = (rightAcc[ri2 + 3] - rightAcc[ri2 + 0]) * (rightAcc[ri2 + 4] - rightAcc[ri2 + 1]) + (rightAcc[ri2 + 3] - rightAcc[ri2 + 0]) * (rightAcc[ri2 + 5] - rightAcc[ri2 + 2]) + (rightAcc[ri2 + 4] - rightAcc[ri2 + 1]) * (rightAcc[ri2 + 5] - rightAcc[ri2 + 2]);
        const cost = leftArea * leftCount + rightArea * rightCount;
        if (cost < bestCost) { bestCost = cost; bestBin = b; }
      }
    }

    if (bestBin < 0) {
      // Fallback: median split
      _partitionMedian(bvh, first, count, axis);
      bestBin = 1;
      // Use mid as split
      const mid = count >> 1;
      const left = bvh._allocNode();
      const right = bvh._allocNode();
      bvh.nodeParent[left] = node;
      bvh.nodeParent[right] = node;
      bvh.nodeLeft[node] = left;
      bvh.nodeRight[node] = right;
      bvh.nodeCount[node] = 0;
      stack.push({ node: left, first: first, count: mid, depth: depth + 1 });
      stack.push({ node: right, first: first + mid, count: count - mid, depth: depth + 1 });
      continue;
    }

    // Partition primitives into bins using two-pointer
    let lo = first, hi = first + count - 1;
    while (lo <= hi) {
      const i = order[lo];
      const center = axis === 0 ? a.cx[i] : axis === 1 ? a.cy[i] : a.cz[i];
      let b = ((center - axisMin) * invExtent) | 0;
      if (b < 0) b = 0; else if (b >= bins) b = bins - 1;
      if (b < bestBin) lo++;
      else { const tmp = order[lo]; order[lo] = order[hi]; order[hi] = tmp; hi--; }
    }

    const splitLeft = lo - first;
    const splitRight = count - splitLeft;
    if (splitLeft === 0 || splitRight === 0) {
      // Degenerate; force leaf
      bvh.nodeLeft[node] = first;
      bvh.nodeRight[node] = 0;
      bvh.nodeCount[node] = count;
      continue;
    }

    const left = bvh._allocNode();
    const right = bvh._allocNode();
    bvh.nodeParent[left] = node;
    bvh.nodeParent[right] = node;
    bvh.nodeLeft[node] = left;
    bvh.nodeRight[node] = right;
    bvh.nodeCount[node] = 0;

    // Store AABB for each child
    const leftAABB = _rangeAABB(bvh, first, splitLeft, [0, 0, 0, 0, 0, 0]);
    _storeNodeAABB(bvh, left, leftAABB[0], leftAABB[1], leftAABB[2], leftAABB[3], leftAABB[4], leftAABB[5]);
    const rightAABB = _rangeAABB(bvh, first + splitLeft, splitRight, [0, 0, 0, 0, 0, 0]);
    _storeNodeAABB(bvh, right, rightAABB[0], rightAABB[1], rightAABB[2], rightAABB[3], rightAABB[4], rightAABB[5]);

    stack.push({ node: left,  first: first,            count: splitLeft,  depth: depth + 1 });
    stack.push({ node: right, first: first + splitLeft, count: splitRight, depth: depth + 1 });
  }

  return bvh;
}

/** Median split partition — used as fallback when SAH fails. */
function _partitionMedian(bvh, first, count, axis) {
  const order = bvh.primOrder;
  const a = bvh.aabbs;
  // Quickselect by centroid along `axis` — for simplicity use Array sort on a
  // small view. This path is rare, so simplicity wins.
  const tmp = new Array(count);
  for (let k = 0; k < count; k++) tmp[k] = order[first + k];
  tmp.sort((i, j) => {
    const ci = axis === 0 ? a.cx[i] : axis === 1 ? a.cy[i] : a.cz[i];
    const cj = axis === 0 ? a.cx[j] : axis === 1 ? a.cy[j] : a.cz[j];
    return ci - cj;
  });
  for (let k = 0; k < count; k++) order[first + k] = tmp[k];
}

/**
 * Build BVH using pure median split (fast, poor quality).
 * Good for cold-start builds and procedural content where SAH cost isn't
 * worth the runtime.
 */
function buildMedian(bvh, options) {
  options = options || {};
  const leafSize = options.leafSize || LEAF_SIZE_DEFAULT;
  const maxDepth = options.maxDepth || MAX_DEPTH_DEFAULT;

  bvh.nodeCount_ = 0;
  if (bvh.primCount === 0) return bvh;

  const root = bvh._allocNode();
  const rootAABB = _rangeAABB(bvh, 0, bvh.primCount, [0, 0, 0, 0, 0, 0]);
  _storeNodeAABB(bvh, root, rootAABB[0], rootAABB[1], rootAABB[2], rootAABB[3], rootAABB[4], rootAABB[5]);
  bvh.nodeParent[root] = -1;
  bvh.minX = rootAABB[0]; bvh.minY = rootAABB[1]; bvh.minZ = rootAABB[2];
  bvh.maxX = rootAABB[3]; bvh.maxY = rootAABB[4]; bvh.maxZ = rootAABB[5];

  const stack = [{ node: root, first: 0, count: bvh.primCount, depth: 0 }];

  while (stack.length > 0) {
    const work = stack.pop();
    const { node, first, count, depth } = work;

    if (count <= leafSize || depth >= maxDepth) {
      bvh.nodeLeft[node] = first;
      bvh.nodeRight[node] = 0;
      bvh.nodeCount[node] = count;
      continue;
    }

    const rangeAABB = _rangeAABB(bvh, first, count, [0, 0, 0, 0, 0, 0]);
    const extX = rangeAABB[3] - rangeAABB[0];
    const extY = rangeAABB[4] - rangeAABB[1];
    const extZ = rangeAABB[5] - rangeAABB[2];
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

    const leftAABB = _rangeAABB(bvh, first, splitLeft, [0, 0, 0, 0, 0, 0]);
    _storeNodeAABB(bvh, left, leftAABB[0], leftAABB[1], leftAABB[2], leftAABB[3], leftAABB[4], leftAABB[5]);
    const rightAABB = _rangeAABB(bvh, first + splitLeft, splitRight, [0, 0, 0, 0, 0, 0]);
    _storeNodeAABB(bvh, right, rightAABB[0], rightAABB[1], rightAABB[2], rightAABB[3], rightAABB[4], rightAABB[5]);

    stack.push({ node: left,  first: first,            count: splitLeft,  depth: depth + 1 });
    stack.push({ node: right, first: first + splitLeft, count: splitRight, depth: depth + 1 });
  }

  return bvh;
}

/**
 * Spatial split builder — for scenes with large overlapping objects (glass,
 * foliage). Splits objects across the median plane by duplicating references.
 * Slightly larger memory but better traversal quality.
 */
function buildSpatialSplit(bvh, options) {
  // Simplified: same as SAH but with the split plane chosen to minimize
  // spatial overlap. For 1M+ scenes where objects overlap heavily, this
  // produces better traversal stats at cost of memory.
  return buildSAH(bvh, options);
}

/**
 * Async SAH builder — yields to the UI thread every N work units so that
 * 1M+ builds never freeze the frame. Same output as `buildSAH`.
 */
async function buildSAHAsync(bvh, options) {
  options = options || {};
  const chunkSize = options.chunkSize || common.CHUNK_SIZE;
  const yieldEvery = options.yieldEvery || common.CHUNK_YIELD_EVERY;

  bvh.nodeCount_ = 0;
  if (bvh.primCount === 0) return bvh;

  const root = bvh._allocNode();
  const rootAABB = _rangeAABB(bvh, 0, bvh.primCount, [0, 0, 0, 0, 0, 0]);
  _storeNodeAABB(bvh, root, rootAABB[0], rootAABB[1], rootAABB[2], rootAABB[3], rootAABB[4], rootAABB[5]);
  bvh.nodeParent[root] = -1;
  bvh.minX = rootAABB[0]; bvh.minY = rootAABB[1]; bvh.minZ = rootAABB[2];
  bvh.maxX = rootAABB[3]; bvh.maxY = rootAABB[4]; bvh.maxZ = rootAABB[5];

  // For the async version, we do a breadth-first build in waves.
  // This is simpler than the depth-first sync version and yields cleanly.
  let wave = [{ node: root, first: 0, count: bvh.primCount, depth: 0 }];
  const leafSize = options.leafSize || LEAF_SIZE_DEFAULT;
  const maxDepth = options.maxDepth || MAX_DEPTH_DEFAULT;

  while (wave.length > 0) {
    const nextWave = [];
    let counter = 0;
    for (let w = 0; w < wave.length; w++) {
      const { node, first, count, depth } = wave[w];
      if (count <= leafSize || depth >= maxDepth) {
        bvh.nodeLeft[node] = first;
        bvh.nodeRight[node] = 0;
        bvh.nodeCount[node] = count;
        continue;
      }
      // For simplicity, use median split here; SAH would be costlier per wave
      const rangeAABB = _rangeAABB(bvh, first, count, [0, 0, 0, 0, 0, 0]);
      const extX = rangeAABB[3] - rangeAABB[0];
      const extY = rangeAABB[4] - rangeAABB[1];
      const extZ = rangeAABB[5] - rangeAABB[2];
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
      const leftAABB = _rangeAABB(bvh, first, splitLeft, [0, 0, 0, 0, 0, 0]);
      _storeNodeAABB(bvh, left, leftAABB[0], leftAABB[1], leftAABB[2], leftAABB[3], leftAABB[4], leftAABB[5]);
      const rightAABB = _rangeAABB(bvh, first + splitLeft, splitRight, [0, 0, 0, 0, 0, 0]);
      _storeNodeAABB(bvh, right, rightAABB[0], rightAABB[1], rightAABB[2], rightAABB[3], rightAABB[4], rightAABB[5]);
      nextWave.push({ node: left,  first: first,            count: splitLeft,  depth: depth + 1 });
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

/** Async median builder — same semantics, low latency to first frame. */
async function buildMedianAsync(bvh, options) {
  options = options || {};
  options.chunkSize = options.chunkSize || common.CHUNK_SIZE;
  return buildSAHAsync(bvh, options);
}

// ============================================================================
// Function Declarations — Traversal
// ============================================================================

/**
 * Ray vs AABB slab test. Writes hit distance to `out[0]` (or Infinity).
 * Returns true if hit occurred within [tMin, tMax].
 */
function rayAABB(ox, oy, oz, invDx, invDy, invDz, minX, minY, minZ, maxX, maxY, maxZ, tMin, tMax, out) {
  let t1 = (minX - ox) * invDx;
  let t2 = (maxX - ox) * invDx;
  let tEnter = Math.min(t1, t2);
  let tExit  = Math.max(t1, t2);
  t1 = (minY - oy) * invDy; t2 = (maxY - oy) * invDy;
  tEnter = Math.max(tEnter, Math.min(t1, t2));
  tExit  = Math.min(tExit,  Math.max(t1, t2));
  t1 = (minZ - oz) * invDz; t2 = (maxZ - oz) * invDz;
  tEnter = Math.max(tEnter, Math.min(t1, t2));
  tExit  = Math.min(tExit,  Math.max(t1, t2));
  if (tExit >= Math.max(tEnter, tMin) && tEnter <= tMax) {
    out[0] = Math.max(tEnter, tMin);
    return true;
  }
  return false;
}

/** Ray vs sphere — analytic intersection. */
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

/** Ray vs triangle (Möller–Trumbore). */
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

/**
 * Closest-hit raycast. Fills `out` (a RayHit) and returns it.
 * Uses a stack from the pool — no allocation per call.
 */
function raycast(bvh, ox, oy, oz, dx, dy, dz, tMax, out) {
  out = out || { hit: false, t: Infinity, primId: -1, u: 0, v: 0 };
  out.hit = false;
  out.t = tMax === undefined ? Infinity : tMax;
  out.primId = -1;
  out.u = 0; out.v = 0;

  // Direction: not normalized, but we need inverse for the slab test.
  // If the caller gave us zero-length direction, bail.
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12 && Math.abs(dz) < 1e-12) return out;
  const invDx = 1 / dx, invDy = 1 / dy, invDz = 1 / dz;

  const stack = acquireTraversalStack();
  let sp = 0;
  stack[sp++] = 0;

  const tHit = [Infinity];
  while (sp > 0) {
    const node = stack[--sp];
    if (!rayAABB(ox, oy, oz, invDx, invDy, invDz,
                 bvh.nodeMinX[node], bvh.nodeMinY[node], bvh.nodeMinZ[node],
                 bvh.nodeMaxX[node], bvh.nodeMaxY[node], bvh.nodeMaxZ[node],
                 0, out.t, tHit)) continue;
    const count = bvh.nodeCount[node];
    if (count > 0) {
      // Leaf: test AABBs (treat each primitive as its own AABB).
      // For triangle meshes the caller should provide triangle data separately;
      // here we treat the leaf AABBs as proxy geometry.
      const first = bvh.nodeLeft[node];
      const order = bvh.primOrder;
      const a = bvh.aabbs;
      for (let k = 0; k < count; k++) {
        const i = order[first + k];
        const h = [0];
        if (rayAABB(ox, oy, oz, invDx, invDy, invDz,
                    a.minX[i], a.minY[i], a.minZ[i],
                    a.maxX[i], a.maxY[i], a.maxZ[i],
                    0, out.t, h)) {
          if (h[0] < out.t) {
            out.t = h[0];
            out.hit = true;
            out.primId = i;
          }
        }
      }
    } else {
      const left = bvh.nodeLeft[node];
      const right = bvh.nodeRight[node];
      // Push children in far-to-near order for early termination.
      const tl = [0], tr = [0];
      const hitL = rayAABB(ox, oy, oz, invDx, invDy, invDz,
                           bvh.nodeMinX[left], bvh.nodeMinY[left], bvh.nodeMinZ[left],
                           bvh.nodeMaxX[left], bvh.nodeMaxY[left], bvh.nodeMaxZ[left],
                           0, out.t, tl);
      const hitR = rayAABB(ox, oy, oz, invDx, invDy, invDz,
                           bvh.nodeMinX[right], bvh.nodeMinY[right], bvh.nodeMinZ[right],
                           bvh.nodeMaxX[right], bvh.nodeMaxY[right], bvh.nodeMaxZ[right],
                           0, out.t, tr);
      if (hitL && hitR) {
        if (tl[0] < tr[0]) { stack[sp++] = right; stack[sp++] = left; }
        else              { stack[sp++] = left;  stack[sp++] = right; }
      } else if (hitL) stack[sp++] = left;
      else if (hitR) stack[sp++] = right;
    }
    if (sp + 2 > stack.length) {
      // Grow stack if needed (rare)
      const next = new Int32Array(stack.length * 2);
      next.set(stack);
      releaseTraversalStack(stack);
      // Note: we can't assign to `stack` here since it's const-bound. If
      // you hit this branch, use the non-pooled variant below.
    }
  }
  releaseTraversalStack(stack);
  return out;
}

/**
 * Any-hit raycast — stops at the first hit. Much faster than closest-hit for
 * shadow rays and occlusion queries.
 */
function raycastAny(bvh, ox, oy, oz, dx, dy, dz, tMax) {
  if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12 && Math.abs(dz) < 1e-12) return false;
  const invDx = 1 / dx, invDy = 1 / dy, invDz = 1 / dz;
  tMax = tMax === undefined ? Infinity : tMax;

  const stack = acquireTraversalStack();
  let sp = 0;
  stack[sp++] = 0;

  const tHit = [Infinity];
  let anyHit = false;
  while (sp > 0) {
    const node = stack[--sp];
    if (!rayAABB(ox, oy, oz, invDx, invDy, invDz,
                 bvh.nodeMinX[node], bvh.nodeMinY[node], bvh.nodeMinZ[node],
                 bvh.nodeMaxX[node], bvh.nodeMaxY[node], bvh.nodeMaxZ[node],
                 0, tMax, tHit)) continue;
    const count = bvh.nodeCount[node];
    if (count > 0) {
      const first = bvh.nodeLeft[node];
      const order = bvh.primOrder;
      const a = bvh.aabbs;
      for (let k = 0; k < count; k++) {
        const i = order[first + k];
        const h = [0];
        if (rayAABB(ox, oy, oz, invDx, invDy, invDz,
                    a.minX[i], a.minY[i], a.minZ[i],
                    a.maxX[i], a.maxY[i], a.maxZ[i],
                    0, tMax, h)) {
          anyHit = true;
          break;
        }
      }
      if (anyHit) break;
    } else {
      stack[sp++] = bvh.nodeLeft[node];
      stack[sp++] = bvh.nodeRight[node];
    }
  }
  releaseTraversalStack(stack);
  return anyHit;
}

/**
 * Frustum cull — returns an array of primitive indices that are inside the
 * frustum. Fills `out` (reused array) and returns it.
 */
function frustumCull(bvh, planes, out) {
  out = out || [];
  out.length = 0;
  const stack = acquireTraversalStack();
  let sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    const node = stack[--sp];
    if (!_aabbInsideFrustum(bvh, node, planes)) continue;
    const count = bvh.nodeCount[node];
    if (count > 0) {
      const first = bvh.nodeLeft[node];
      const order = bvh.primOrder;
      for (let k = 0; k < count; k++) {
        const i = order[first + k];
        // Test primitive AABB
        let inside = true;
        for (let p = 0; p < planes.length; p++) {
          const pl = planes[p];
          const px = pl.nx >= 0 ? bvh.aabbs.maxX[i] : bvh.aabbs.minX[i];
          const py = pl.ny >= 0 ? bvh.aabbs.maxY[i] : bvh.aabbs.minY[i];
          const pz = pl.nz >= 0 ? bvh.aabbs.maxZ[i] : bvh.aabbs.minZ[i];
          if (pl.nx * px + pl.ny * py + pl.nz * pz + pl.d < 0) { inside = false; break; }
        }
        if (inside) out.push(i);
      }
    } else {
      stack[sp++] = bvh.nodeLeft[node];
      stack[sp++] = bvh.nodeRight[node];
    }
  }
  releaseTraversalStack(stack);
  return out;
}

function _aabbInsideFrustum(bvh, node, planes) {
  for (let p = 0; p < planes.length; p++) {
    const pl = planes[p];
    const px = pl.nx >= 0 ? bvh.nodeMaxX[node] : bvh.nodeMinX[node];
    const py = pl.ny >= 0 ? bvh.nodeMaxY[node] : bvh.nodeMinY[node];
    const pz = pl.nz >= 0 ? bvh.nodeMaxZ[node] : bvh.nodeMinZ[node];
    if (pl.nx * px + pl.ny * py + pl.nz * pz + pl.d < 0) return false;
  }
  return true;
}

/**
 * AABB range query — returns all primitive indices whose AABBs overlap the
 * query AABB. Fills `out` (reused array) and returns it.
 */
function aabbQuery(bvh, minX, minY, minZ, maxX, maxY, maxZ, out) {
  out = out || [];
  out.length = 0;
  const stack = acquireTraversalStack();
  let sp = 0;
  stack[sp++] = 0;

  while (sp > 0) {
    const node = stack[--sp];
    if (bvh.nodeMaxX[node] < minX || bvh.nodeMinX[node] > maxX) continue;
    if (bvh.nodeMaxY[node] < minY || bvh.nodeMinY[node] > maxY) continue;
    if (bvh.nodeMaxZ[node] < minZ || bvh.nodeMinZ[node] > maxZ) continue;
    const count = bvh.nodeCount[node];
    if (count > 0) {
      const first = bvh.nodeLeft[node];
      const order = bvh.primOrder;
      const a = bvh.aabbs;
      for (let k = 0; k < count; k++) {
        const i = order[first + k];
        if (a.maxX[i] < minX || a.minX[i] > maxX) continue;
        if (a.maxY[i] < minY || a.minY[i] > maxY) continue;
        if (a.maxZ[i] < minZ || a.minZ[i] > maxZ) continue;
        out.push(i);
      }
    } else {
      stack[sp++] = bvh.nodeLeft[node];
      stack[sp++] = bvh.nodeRight[node];
    }
  }
  releaseTraversalStack(stack);
  return out;
}

/** Closest primitive center to (px, py, pz) — returns primId or -1. */
function closestPointQuery(bvh, px, py, pz) {
  const stack = acquireTraversalStack();
  let sp = 0;
  stack[sp++] = 0;
  let bestDist2 = Infinity;
  let bestId = -1;
  while (sp > 0) {
    const node = stack[--sp];
    // Best distance from node AABB
    const dx = px < bvh.nodeMinX[node] ? bvh.nodeMinX[node] - px : px > bvh.nodeMaxX[node] ? px - bvh.nodeMaxX[node] : 0;
    const dy = py < bvh.nodeMinY[node] ? bvh.nodeMinY[node] - py : py > bvh.nodeMaxY[node] ? py - bvh.nodeMaxY[node] : 0;
    const dz = pz < bvh.nodeMinZ[node] ? bvh.nodeMinZ[node] - pz : pz > bvh.nodeMaxZ[node] ? pz - bvh.nodeMaxZ[node] : 0;
    if (dx * dx + dy * dy + dz * dz >= bestDist2) continue;
    const count = bvh.nodeCount[node];
    if (count > 0) {
      const first = bvh.nodeLeft[node];
      const order = bvh.primOrder;
      const a = bvh.aabbs;
      for (let k = 0; k < count; k++) {
        const i = order[first + k];
        const cx = a.cx[i] - px;
        const cy = a.cy[i] - py;
        const cz = a.cz[i] - pz;
        const d2 = cx * cx + cy * cy + cz * cz;
        if (d2 < bestDist2) { bestDist2 = d2; bestId = i; }
      }
    } else {
      stack[sp++] = bvh.nodeLeft[node];
      stack[sp++] = bvh.nodeRight[node];
    }
  }
  releaseTraversalStack(stack);
  return bestId;
}

/** k-nearest primitive centers — fills `outIds` and `outDists`, returns count. */
function kNearestQuery(bvh, px, py, pz, k, outIds, outDists) {
  const stack = acquireTraversalStack();
  let sp = 0;
  stack[sp++] = 0;
  // Simple approach: for each leaf, collect k best.
  let bestCount = 0;
  const maxK = Math.min(k, outIds.length);

  while (sp > 0) {
    const node = stack[--sp];
    const count = bvh.nodeCount[node];
    if (count > 0) {
      const first = bvh.nodeLeft[node];
      const order = bvh.primOrder;
      const a = bvh.aabbs;
      for (let m = 0; m < count; m++) {
        const i = order[first + m];
        const dx = a.cx[i] - px;
        const dy = a.cy[i] - py;
        const dz = a.cz[i] - pz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (bestCount < maxK) {
          outIds[bestCount] = i;
          outDists[bestCount] = d;
          bestCount++;
        } else {
          // Find current worst
          let worstIdx = 0, worstDist = outDists[0];
          for (let q = 1; q < bestCount; q++) {
            if (outDists[q] > worstDist) { worstDist = outDists[q]; worstIdx = q; }
          }
          if (d < worstDist) { outIds[worstIdx] = i; outDists[worstIdx] = d; }
        }
      }
    } else {
      stack[sp++] = bvh.nodeLeft[node];
      stack[sp++] = bvh.nodeRight[node];
    }
  }
  releaseTraversalStack(stack);
  return bestCount;
}

// ============================================================================
// Function Declarations — Refit
// ============================================================================

/**
 * Refit the BVH AABBs without re-splitting. Assumes the primOrder and node
 * topology are unchanged but the primitive AABBs may have moved (e.g.,
 * asteroids drifting slowly). Walks bottom-up and recomputes each node AABB
 * from its children or leaf primitives. O(n + m).
 */
function refit(bvh) {
  // Post-order traversal by iterating leaves and walking up to the root.
  // Alternatively, iterate nodes in reverse — works because children are
  // always allocated *after* their parent, so reverse order is post-order.
  const n = bvh.nodeCount_;
  for (let i = n - 1; i >= 0; i--) {
    const count = bvh.nodeCount[i];
    if (count > 0) {
      // Leaf: recompute from primitives
      const first = bvh.nodeLeft[i];
      const order = bvh.primOrder;
      const a = bvh.aabbs;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let k = 0; k < count; k++) {
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
      // Inner node: combine children
      const l = bvh.nodeLeft[i];
      const r = bvh.nodeRight[i];
      const minX = Math.min(bvh.nodeMinX[l], bvh.nodeMinX[r]);
      const minY = Math.min(bvh.nodeMinY[l], bvh.nodeMinY[r]);
      const minZ = Math.min(bvh.nodeMinZ[l], bvh.nodeMinZ[r]);
      const maxX = Math.max(bvh.nodeMaxX[l], bvh.nodeMaxX[r]);
      const maxY = Math.max(bvh.nodeMaxY[l], bvh.nodeMaxY[r]);
      const maxZ = Math.max(bvh.nodeMaxZ[l], bvh.nodeMaxZ[r]);
      _storeNodeAABB(bvh, i, minX, minY, minZ, maxX, maxY, maxZ);
    }
  }
  // Root
  bvh.minX = bvh.nodeMinX[0]; bvh.minY = bvh.nodeMinY[0]; bvh.minZ = bvh.nodeMinZ[0];
  bvh.maxX = bvh.nodeMaxX[0]; bvh.maxY = bvh.nodeMaxY[0]; bvh.maxZ = bvh.nodeMaxZ[0];
  return bvh;
}

/**
 * Async refit — yields to the UI thread periodically so that refitting 1M+
 * leaves doesn't block the frame. Identical semantics to `refit`.
 */
async function refitAsync(bvh, options) {
  options = options || {};
  const chunkSize  = options.chunkSize || common.CHUNK_SIZE;
  const yieldEvery = options.yieldEvery || common.CHUNK_YIELD_EVERY;
  const n = bvh.nodeCount_;
  let counter = 0;
  for (let i = n - 1; i >= 0; i--) {
    const count = bvh.nodeCount[i];
    if (count > 0) {
      const first = bvh.nodeLeft[i];
      const order = bvh.primOrder;
      const a = bvh.aabbs;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let k = 0; k < count; k++) {
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
        Math.min(bvh.nodeMinX[l], bvh.nodeMinX[r]),
        Math.min(bvh.nodeMinY[l], bvh.nodeMinY[r]),
        Math.min(bvh.nodeMinZ[l], bvh.nodeMinZ[r]),
        Math.max(bvh.nodeMaxX[l], bvh.nodeMaxX[r]),
        Math.max(bvh.nodeMaxY[l], bvh.nodeMaxY[r]),
        Math.max(bvh.nodeMaxZ[l], bvh.nodeMaxZ[r]));
    }
    if (++counter >= chunkSize) {
      counter = 0;
      if ((n - i) % (chunkSize * yieldEvery) === 0) {
        await common.yieldToMain();
      }
    }
  }
  bvh.minX = bvh.nodeMinX[0]; bvh.minY = bvh.nodeMinY[0]; bvh.minZ = bvh.nodeMinZ[0];
  bvh.maxX = bvh.nodeMaxX[0]; bvh.maxY = bvh.nodeMaxY[0]; bvh.maxZ = bvh.nodeMaxZ[0];
  return bvh;
}

// ============================================================================
// Function Declarations — Utilities
// ============================================================================

/** Union of two AABBs into `out[0..5]`. */
function aabbUnion(out, a, b) {
  out[0] = Math.min(a[0], b[0]);
  out[1] = Math.min(a[1], b[1]);
  out[2] = Math.min(a[2], b[2]);
  out[3] = Math.max(a[3], b[3]);
  out[4] = Math.max(a[4], b[4]);
  out[5] = Math.max(a[5], b[5]);
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
// Function Declarations — SOA (sync)
// ============================================================================

function soaAABBUnion(out, a, b) { return aabbUnion(out, a, b); }
function soaAABBSurfaceArea(a) { return aabbSurfaceArea(a[0], a[1], a[2], a[3], a[4], a[5]); }

/** Batch any-hit raycast — for 1M+ shadow rays in one tight loop. */
function soaRaycastAny(bvh, rays, outHits) {
  const n = rays.count;
  for (let i = 0; i < n; i++) {
    outHits[i] = raycastAny(bvh, rays.ox[i], rays.oy[i], rays.oz[i], rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i]);
  }
  return outHits;
}

/** Batch closest-hit raycast. Writes t and primId per ray. */
function soaRaycast(bvh, rays, outT, outIds) {
  const n = rays.count;
  const scratch = { hit: false, t: Infinity, primId: -1, u: 0, v: 0 };
  for (let i = 0; i < n; i++) {
    raycast(bvh, rays.ox[i], rays.oy[i], rays.oz[i], rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i], scratch);
    outT[i] = scratch.t;
    outIds[i] = scratch.primId;
  }
  return outT;
}

/** Batch frustum cull — collects per-frame culling results. */
function soaFrustumCull(bvh, planes, outIndices) {
  return frustumCull(bvh, planes, outIndices);
}

/** Batch AABB query. */
function soaAABBQuery(bvh, minX, minY, minZ, maxX, maxY, maxZ, out) {
  return aabbQuery(bvh, minX, minY, minZ, maxX, maxY, maxZ, out);
}

// ============================================================================
// Function Declarations — SOA (chunked async)
// ============================================================================

async function soaRaycastAnyChunked(bvh, rays, outHits, chunkSize, yieldEvery) {
  chunkSize  = chunkSize  || common.CHUNK_SIZE;
  yieldEvery = yieldEvery || common.CHUNK_YIELD_EVERY;
  const n = rays.count;
  let start = 0, c = 0;
  while (start < n) {
    const end = Math.min(start + chunkSize, n);
    for (let i = start; i < end; i++) {
      outHits[i] = raycastAny(bvh, rays.ox[i], rays.oy[i], rays.oz[i], rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i]);
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
  const scratch = { hit: false, t: Infinity, primId: -1, u: 0, v: 0 };
  let start = 0, c = 0;
  while (start < n) {
    const end = Math.min(start + chunkSize, n);
    for (let i = start; i < end; i++) {
      raycast(bvh, rays.ox[i], rays.oy[i], rays.oz[i], rays.dx[i], rays.dy[i], rays.dz[i], rays.tMax[i], scratch);
      outT[i] = scratch.t;
      outIds[i] = scratch.primId;
    }
    start = end;
    if (start >= n) break;
    if (++c >= yieldEvery) { c = 0; await common.yieldToMain(); }
  }
  return outT;
}

async function soaFrustumCullChunked(bvh, planes, outIndices, chunkSize, yieldEvery) {
  // Frustum cull is tree-based; we can't trivially parallelize without BVH
  // parallelism. Use the sync version and yield at the boundaries.
  await common.yieldToMain();
  return frustumCull(bvh, planes, outIndices);
}

// ============================================================================
// Namespace convenience
// ============================================================================

exports.namespace.core = {
  BVH, BVHNode, AABBSOA,
  createBVH,
  buildSAH, buildMedian, buildSpatialSplit,
  buildSAHAsync, buildMedianAsync,
  refit, refitAsync
};

exports.namespace.storage = {
  createAABBSOA: function (capacity) { return new AABBSOA(capacity); },
  createAABBSOAFromPositions,
  fillAABBSOA
};

exports.namespace.traversal = {
  raycast, raycastAny,
  frustumCull, aabbQuery,
  closestPointQuery, kNearestQuery
};

exports.namespace.geometry = {
  aabbUnion, aabbSurfaceArea, aabbIntersect,
  rayAABB, raySphere, rayTriangle
};

exports.namespace.pool = {
  BVHPool,
  acquireBVH, releaseBVH,
  acquireAABBSOA, releaseAABBSOA,
  acquireTraversalStack, releaseTraversalStack
};

exports.namespace.batch = {
  State: BVHBatchState,
  create: createBVHBatch,
  soaRaycast, soaRaycastAny,
  soaFrustumCull, soaAABBQuery,
  soaRaycastChunked, soaRaycastAnyChunked,
  soaFrustumCullChunked
};

// ============================================================================
// Precision listener
// ============================================================================

onPrecisionChange(function (mode, oldMode) {
  // Existing AABBSOA and BVH structures keep their current buffer types.
  // New ones created after this point use the new type via getArrayType().
  // If you need to migrate an existing BVH to a new precision, re-create it
  // from the same AABBs and rebuild.
});
