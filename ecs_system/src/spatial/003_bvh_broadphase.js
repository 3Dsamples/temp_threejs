// file number : 003
// full path name : src/spatial/003_bvh_broadphase.js
// description : Dynamic AABB tree broadphase for 1M+ entities. Implements
//               Box2D-style fat AABBs (b2_fatAABBFactor), incremental insert/
//               remove, O(log n) refit (three-mesh-bvh style), and queries:
//               raycast, frustum culling, and collision pairs. All node data
//               is packed into typed arrays (SoA) for cache efficiency and
//               zero per-node object allocation.
// best for : Broadphase collision detection, frustum culling, raycasting,
//            CSG operand culling, IK target selection, and any spatial query
//            over 1M+ entities on mobile 64-bit.
// license : MIT

import {
  $internal,
  query,
  addComponent,
  hasComponent,
  getId,
} from '../ecs/001_ecs_core.js';

import {
  WorldTransformF32,
  HierarchyDepth,
} from '../transform/002_transform_hierarchy.js';

import {
  vec3,
  mat4,
} from '../000_math_links.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const MAX_NODES = 2 * 1_000_000;   // leaves + internal nodes
const NULL_NODE = -1;
const FAT_AABB_FACTOR = 0.1;       // Box2D b2_fatAABBFactor — 10% margin
const AABB_EPSILON = 1e-6;

// Node layout (SoA, packed):
//   aabb: [minX, minY, minZ, maxX, maxY, maxZ] × 6 floats per node
//   parent, child1, child2, height, userData: Int32 per node
export const BVHNodes = {
  aabb: new Float32Array(MAX_NODES * 6),   // minXYZ, maxXYZ
  parent: new Int32Array(MAX_NODES),
  child1: new Int32Array(MAX_NODES),
  child2: new Int32Array(MAX_NODES),
  height: new Int32Array(MAX_NODES),
  userData: new Int32Array(MAX_NODES),     // entity id (leaf only)
  nextFree: new Int32Array(MAX_NODES),
};

export const BVHState = {
  root: NULL_NODE,
  nodeCount: 0,
  freeList: NULL_NODE,
  proxyCount: 0,
  // entityId -> leaf node index (for O(1) remove/refit)
  entityToLeaf: new Map(),
};

// ═══════════════════════════════════════════════════════════════════════
// NODE ALLOCATION (free‑list, no GC)
// ═══════════════════════════════════════════════════════════════════════

function allocNode() {
  let node;
  if (BVHState.freeList !== NULL_NODE) {
    node = BVHState.freeList;
    BVHState.freeList = BVHNodes.nextFree[node];
  } else {
    node = BVHState.nodeCount++;
    if (node >= MAX_NODES) throw new Error('BVH: node capacity exceeded');
  }
  BVHNodes.parent[node] = NULL_NODE;
  BVHNodes.child1[node] = NULL_NODE;
  BVHNodes.child2[node] = NULL_NODE;
  BVHNodes.height[node] = 0;
  BVHNodes.userData[node] = NULL_NODE;
  return node;
}

function freeNode(node) {
  BVHNodes.nextFree[node] = BVHState.freeList;
  BVHState.freeList = node;
}

// ═══════════════════════════════════════════════════════════════════════
// AABB HELPERS (flat float triples — no Vector3 allocation)
// ═══════════════════════════════════════════════════════════════════════

function setAABB(node, minX, minY, minZ, maxX, maxY, maxZ) {
  const off = node * 6;
  const A = BVHNodes.aabb;
  A[off] = minX;     A[off + 1] = minY;     A[off + 2] = minZ;
  A[off + 3] = maxX; A[off + 4] = maxY;     A[off + 5] = maxZ;
}

function getAABBMin(node, out) {
  const off = node * 6;
  out[0] = BVHNodes.aabb[off];
  out[1] = BVHNodes.aabb[off + 1];
  out[2] = BVHNodes.aabb[off + 2];
  return out;
}

function getAABBMax(node, out) {
  const off = node * 6;
  out[0] = BVHNodes.aabb[off + 3];
  out[1] = BVHNodes.aabb[off + 4];
  out[2] = BVHNodes.aabb[off + 5];
  return out;
}

function combineAABB(outNode, a, b) {
  const oa = outNode * 6;
  const aa = a * 6;
  const ba = b * 6;
  const A = BVHNodes.aabb;
  A[oa]     = Math.min(A[aa],     A[ba]);
  A[oa + 1] = Math.min(A[aa + 1], A[ba + 1]);
  A[oa + 2] = Math.min(A[aa + 2], A[ba + 2]);
  A[oa + 3] = Math.max(A[aa + 3], A[ba + 3]);
  A[oa + 4] = Math.max(A[aa + 4], A[ba + 4]);
  A[oa + 5] = Math.max(A[aa + 5], A[ba + 5]);
}

function aabbPerimeter(node) {
  const off = node * 6;
  const A = BVHNodes.aabb;
  const dx = A[off + 3] - A[off];
  const dy = A[off + 4] - A[off + 1];
  const dz = A[off + 5] - A[off + 2];
  return 2 * (dx * dy + dy * dz + dz * dx);
}

function aabbOverlaps(a, b) {
  const aa = a * 6, ba = b * 6;
  const A = BVHNodes.aabb;
  return A[aa]     <= A[ba + 3] && A[aa + 3] >= A[ba] &&
         A[aa + 1] <= A[ba + 4] && A[aa + 4] >= A[ba + 1] &&
         A[aa + 2] <= A[ba + 5] && A[aa + 5] >= A[ba + 2];
}

function aabbContains(outer, inner) {
  const oa = outer * 6, ia = inner * 6;
  const A = BVHNodes.aabb;
  return A[oa]     <= A[ia]     && A[oa + 1] <= A[ia + 1] && A[oa + 2] <= A[ia + 2] &&
         A[oa + 3] >= A[ia + 3] && A[oa + 4] >= A[ia + 4] && A[oa + 5] >= A[ia + 5];
}

// ═══════════════════════════════════════════════════════════════════════
// INSERT (Box2D incremental insertion — greedy best‑sibling search)
// ═══════════════════════════════════════════════════════════════════════

function insertLeaf(leaf) {
  if (BVHState.root === NULL_NODE) {
    BVHState.root = leaf;
    BVHNodes.parent[leaf] = NULL_NODE;
    return;
  }

  // Phase 1: find best sibling using surface‑area heuristic (perimeter).
  let sibling = BVHState.root;
  while (BVHNodes.child1[sibling] !== NULL_NODE) {
    const c1 = BVHNodes.child1[sibling];
    const c2 = BVHNodes.child2[sibling];

    const perimeter = aabbPerimeter(sibling);
    const combined = allocNode();
    combineAABB(combined, sibling, leaf);
    const combinedPerimeter = aabbPerimeter(combined);
    freeNode(combined);

    const cost = 2 * combinedPerimeter;
    const inheritance = 2 * (combinedPerimeter - perimeter);

    const cost1 = aabbPerimeter(c1) + inheritance;
    const cost2 = aabbPerimeter(c2) + inheritance;

    if (cost < cost1 && cost < cost2) break;
    sibling = cost1 < cost2 ? c1 : c2;
  }

  // Phase 2: create new parent.
  const oldParent = BVHNodes.parent[sibling];
  const newParent = allocNode();
  BVHNodes.parent[newParent] = oldParent;
  BVHNodes.child1[newParent] = sibling;
  BVHNodes.child2[newParent] = leaf;
  BVHNodes.parent[sibling] = newParent;
  BVHNodes.parent[leaf] = newParent;
  BVHNodes.height[newParent] = BVHNodes.height[sibling] + 1;
  combineAABB(newParent, sibling, leaf);

  if (oldParent !== NULL_NODE) {
    if (BVHNodes.child1[oldParent] === sibling) BVHNodes.child1[oldParent] = newParent;
    else BVHNodes.child2[oldParent] = newParent;
  } else {
    BVHState.root = newParent;
  }

  // Phase 3: refit ancestors (three-mesh-bvh style — O(log n)).
  let index = BVHNodes.parent[leaf];
  while (index !== NULL_NODE) {
    index = balanceAndRefit(index);
    index = BVHNodes.parent[index];
  }
}

function balanceAndRefit(index) {
  const c1 = BVHNodes.child1[index];
  const c2 = BVHNodes.child2[index];
  if (c1 === NULL_NODE || c2 === NULL_NODE) return index;

  BVHNodes.height[index] = 1 + Math.max(BVHNodes.height[c1], BVHNodes.height[c2]);
  combineAABB(index, c1, c2);
  return index;
}

// ═══════════════════════════════════════════════════════════════════════
// REMOVE (Box2D style — swap parent with sibling)
// ═══════════════════════════════════════════════════════════════════════

function removeLeaf(leaf) {
  if (leaf === BVHState.root) {
    BVHState.root = NULL_NODE;
    return;
  }
  const parent = BVHNodes.parent[leaf];
  const grandParent = BVHNodes.parent[parent];
  const sibling = BVHNodes.child1[parent] === leaf
    ? BVHNodes.child2[parent]
    : BVHNodes.child1[parent];

  if (grandParent !== NULL_NODE) {
    if (BVHNodes.child1[grandParent] === parent) BVHNodes.child1[grandParent] = sibling;
    else BVHNodes.child2[grandParent] = sibling;
    BVHNodes.parent[sibling] = grandParent;
    freeNode(parent);

    let index = grandParent;
    while (index !== NULL_NODE) {
      index = balanceAndRefit(index);
      index = BVHNodes.parent[index];
    }
  } else {
    BVHState.root = sibling;
    BVHNodes.parent[sibling] = NULL_NODE;
    freeNode(parent);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PROXY MANAGEMENT — create / move / destroy per entity
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract world AABB for entity from WorldTransformF32 column‑major matrix.
 * Uses the translation column (12,13,14) as center and a unit half‑extent
 * scaled by the matrix’s scale approximation. For precise bounds, attach a
 * LocalBoundsF32 component (file 004) to override.
 */
function computeEntityAABB(eid, outMin, outMax) {
  const id = getId(eid);
  const off = id * 16;
  const M = WorldTransformF32.m;
  const cx = M[off + 12];
  const cy = M[off + 13];
  const cz = M[off + 14];
  // Approximate extent from matrix column lengths (scale).
  const sx = Math.hypot(M[off], M[off + 1], M[off + 2]);
  const sy = Math.hypot(M[off + 4], M[off + 5], M[off + 6]);
  const sz = Math.hypot(M[off + 8], M[off + 9], M[off + 10]);
  const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;

  // Fat AABB (Box2D b2_fatAABBFactor).
  const fx = hx * (1 + FAT_AABB_FACTOR);
  const fy = hy * (1 + FAT_AABB_FACTOR);
  const fz = hz * (1 + FAT_AABB_FACTOR);

  outMin[0] = cx - fx; outMin[1] = cy - fy; outMin[2] = cz - fz;
  outMax[0] = cx + fx; outMax[1] = cy + fy; outMax[2] = cz + fz;
}

const _min = vec3.create();
const _max = vec3.create();

export function bvhCreateProxy(eid) {
  if (BVHState.entityToLeaf.has(eid)) return BVHState.entityToLeaf.get(eid);

  computeEntityAABB(eid, _min, _max);
  const leaf = allocNode();
  setAABB(leaf, _min[0], _min[1], _min[2], _max[0], _max[1], _max[2]);
  BVHNodes.userData[leaf] = eid;
  BVHNodes.height[leaf] = 0;
  insertLeaf(leaf);
  BVHState.entityToLeaf.set(eid, leaf);
  BVHState.proxyCount++;
  return leaf;
}

export function bvhDestroyProxy(eid) {
  const leaf = BVHState.entityToLeaf.get(eid);
  if (leaf === undefined) return;
  removeLeaf(leaf);
  freeNode(leaf);
  BVHState.entityToLeaf.delete(eid);
  BVHState.proxyCount--;
}

/**
 * Refit a single proxy after transform change. If the new AABB is fully
 * contained in the fat AABB, skip (Box2D fat‑AABB hysteresis). Otherwise
 * remove and re‑insert.
 */
export function bvhMoveProxy(eid) {
  const leaf = BVHState.entityToLeaf.get(eid);
  if (leaf === undefined) return bvhCreateProxy(eid);

  computeEntityAABB(eid, _min, _max);
  const off = leaf * 6;
  const A = BVHNodes.aabb;

  if (A[off] <= _min[0] && A[off + 1] <= _min[1] && A[off + 2] <= _min[2] &&
      A[off + 3] >= _max[0] && A[off + 4] >= _max[1] && A[off + 5] >= _max[2]) {
    return leaf; // still inside fat AABB — no work
  }

  setAABB(leaf, _min[0], _min[1], _min[2], _max[0], _max[1], _max[2]);
  removeLeaf(leaf);
  insertLeaf(leaf);
  return leaf;
}

// ═══════════════════════════════════════════════════════════════════════
// REFIT SYSTEM — call after systemPropagateTransforms (file 002)
// ═══════════════════════════════════════════════════════════════════════

export function systemRefitBVH(world) {
  const eids = query(world, [WorldTransformF32]);
  for (let i = 0, n = eids.length; i < n; i++) {
    const eid = eids[i];
    if (BVHState.entityToLeaf.has(eid)) bvhMoveProxy(eid);
    else bvhCreateProxy(eid);
  }
  return world;
}

// ═══════════════════════════════════════════════════════════════════════
// RAYCAST — three-mesh-bvh acceleratedRaycast style
// ═══════════════════════════════════════════════════════════════════════

const _rayMin = vec3.create();
const _rayMax = vec3.create();

/**
 * Ray‑AABB slab test. Returns tMin >= 0 if hit, Infinity otherwise.
 * `dir` should be normalized; `invDir` precomputed for speed.
 */
function rayAABB(ox, oy, oz, invDx, invDy, invDz, node, tMax) {
  const off = node * 6;
  const A = BVHNodes.aabb;
  let t1 = (A[off]     - ox) * invDx;
  let t2 = (A[off + 3] - ox) * invDx;
  let tmin = Math.min(t1, t2);
  let tmaxLocal = Math.max(t1, t2);

  t1 = (A[off + 1] - oy) * invDy;
  t2 = (A[off + 4] - oy) * invDy;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmaxLocal = Math.min(tmaxLocal, Math.max(t1, t2));

  t1 = (A[off + 2] - oz) * invDz;
  t2 = (A[off + 5] - oz) * invDz;
  tmin = Math.max(tmin, Math.min(t1, t2));
  tmaxLocal = Math.min(tmaxLocal, Math.max(t1, t2));

  if (tmaxLocal < Math.max(tmin, 0) || tmin > tMax) return Infinity;
  return tmin < 0 ? 0 : tmin;
}

/**
 * Traverse BVH for ray hits. Returns array of entity IDs sorted by t.
 * `firstHitOnly` stops at the closest hit (three-mesh-bvh raycastFirst).
 */
export function bvhRaycast(origin, direction, maxDistance = Infinity, firstHitOnly = false) {
  const results = [];
  if (BVHState.root === NULL_NODE) return results;

  const ox = origin[0], oy = origin[1], oz = origin[2];
  const dx = direction[0], dy = direction[1], dz = direction[2];
  const invDx = 1 / (dx || AABB_EPSILON);
  const invDy = 1 / (dy || AABB_EPSILON);
  const invDz = 1 / (dz || AABB_EPSILON);

  const stack = [BVHState.root];
  let closestT = maxDistance;

  while (stack.length > 0) {
    const node = stack.pop();
    const t = rayAABB(ox, oy, oz, invDx, invDy, invDz, node, closestT);
    if (t === Infinity) continue;

    if (BVHNodes.child1[node] === NULL_NODE) {
      // Leaf
      results.push({ eid: BVHNodes.userData[node], t });
      if (firstHitOnly) closestT = Math.min(closestT, t);
    } else {
      stack.push(BVHNodes.child1[node], BVHNodes.child2[node]);
    }
  }

  results.sort((a, b) => a.t - b.t);
  if (firstHitOnly && results.length > 0) return [results[0]];
  return results;
}

// ═══════════════════════════════════════════════════════════════════════
// FRUSTUM CULLING — three-sketches style
// ═══════════════════════════════════════════════════════════════════════

const _frustumPlanes = new Float32Array(6 * 4); // 6 planes × (a,b,c,d)

/**
 * Extract 6 frustum planes from a Three.js projectionMatrix × viewMatrix.
 * `projView` is a column‑major mat4 (gl-matrix).
 */
export function extractFrustumPlanes(projView, out = _frustumPlanes) {
  const m = projView;
  // Left, Right, Bottom, Top, Near, Far
  const planes = [
    [m[3] + m[0], m[7] + m[4], m[11] + m[8],  m[15] + m[12]],
    [m[3] - m[0], m[7] - m[4], m[11] - m[8],  m[15] - m[12]],
    [m[3] + m[1], m[7] + m[5], m[11] + m[9],  m[15] + m[13]],
    [m[3] - m[1], m[7] - m[5], m[11] - m[9],  m[15] - m[13]],
    [m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]],
    [m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]],
  ];
  for (let i = 0; i < 6; i++) {
    const [a, b, c, d] = planes[i];
    const len = Math.hypot(a, b, c) || 1;
    out[i * 4]     = a / len;
    out[i * 4 + 1] = b / len;
    out[i * 4 + 2] = c / len;
    out[i * 4 + 3] = d / len;
  }
  return out;
}

function aabbInFrustum(node, planes) {
  const off = node * 6;
  const A = BVHNodes.aabb;
  // 8 corners of AABB
  const minX = A[off], minY = A[off + 1], minZ = A[off + 2];
  const maxX = A[off + 3], maxY = A[off + 4], maxZ = A[off + 5];

  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4], b = planes[i * 4 + 1];
    const c = planes[i * 4 + 2], d = planes[i * 4 + 3];
    // Positive vertex (farthest along normal)
    const px = a >= 0 ? maxX : minX;
    const py = b >= 0 ? maxY : minY;
    const pz = c >= 0 ? maxZ : minZ;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/**
 * Return entity IDs whose AABB intersects the frustum.
 * `planes` from extractFrustumPlanes().
 */
export function bvhFrustumCull(planes) {
  const visible = [];
  if (BVHState.root === NULL_NODE) return visible;

  const stack = [BVHState.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!aabbInFrustum(node, planes)) continue;

    if (BVHNodes.child1[node] === NULL_NODE) {
      visible.push(BVHNodes.userData[node]);
    } else {
      stack.push(BVHNodes.child1[node], BVHNodes.child2[node]);
    }
  }
  return visible;
}

// ═══════════════════════════════════════════════════════════════════════
// COLLISION PAIRS — broadphase pair reporting
// ═══════════════════════════════════════════════════════════════════════

/**
 * Self‑overlap traversal: returns candidate pairs [eidA, eidB].
 * Does NOT narrowphase; file 006 (2D physics) or 007 (3D) consumes these.
 */
export function bvhCollisionPairs() {
  const pairs = [];
  if (BVHState.root === NULL_NODE) return pairs;

  const stack = [[BVHState.root, BVHState.root]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    if (!aabbOverlaps(a, b)) continue;

    const aLeaf = BVHNodes.child1[a] === NULL_NODE;
    const bLeaf = BVHNodes.child1[b] === NULL_NODE;

    if (aLeaf && bLeaf) {
      const eidA = BVHNodes.userData[a];
      const eidB = BVHNodes.userData[b];
      if (eidA !== eidB) pairs.push([eidA, eidB]);
    } else if (aLeaf || (!bLeaf && BVHNodes.height[b] > BVHNodes.height[a])) {
      stack.push([a, BVHNodes.child1[b]], [a, BVHNodes.child2[b]]);
    } else {
      stack.push([BVHNodes.child1[a], b], [BVHNodes.child2[a], b]);
    }
  }
  return pairs;
}

// ═══════════════════════════════════════════════════════════════════════
// ECS INTEGRATION — register a BroadphaseTag component
// ═══════════════════════════════════════════════════════════════════════

export const BroadphaseTag = {}; // marker component

export function addBroadphase(world, eid) {
  addComponent(world, eid, BroadphaseTag);
  bvhCreateProxy(eid);
}

export function removeBroadphase(world, eid) {
  bvhDestroyProxy(eid);
}

// ═══════════════════════════════════════════════════════════════════════
// STATS / DEBUG
// ═══════════════════════════════════════════════════════════════════════

export function bvhStats() {
  return {
    proxyCount: BVHState.proxyCount,
    nodeCount: BVHState.nodeCount,
    freeNodes: BVHState.freeList === NULL_NODE ? 0 : countFreeList(),
    root: BVHState.root,
    maxHeight: BVHState.root === NULL_NODE ? 0 : BVHNodes.height[BVHState.root],
  };
}

function countFreeList() {
  let n = 0;
  let node = BVHState.freeList;
  while (node !== NULL_NODE) {
    n++;
    node = BVHNodes.nextFree[node];
  }
  return n;
}

export function resetBVH() {
  BVHState.root = NULL_NODE;
  BVHState.nodeCount = 0;
  BVHState.freeList = NULL_NODE;
  BVHState.proxyCount = 0;
  BVHState.entityToLeaf.clear();
  BVHNodes.parent.fill(NULL_NODE);
  BVHNodes.child1.fill(NULL_NODE);
  BVHNodes.child2.fill(NULL_NODE);
  BVHNodes.height.fill(0);
  BVHNodes.userData.fill(NULL_NODE);
}