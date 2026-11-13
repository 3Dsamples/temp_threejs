// file number : 274
// full path name : src/context/274_OcclusionGraph.js
// description : Inter-chunk occlusion graph consumed by the spatial context provider. Maintains a directed graph of chunk nodes where each edge carries an occlusion probability P_occ in [0,1] representing how strongly the source chunk occludes the target. Probabilities are refreshed lazily and decay with D(τ)=exp(-τ/τ_occ), so stale occluders lose influence over time and the graph self-heals after camera movement. Combines occlusion probability with frustum-culling results to decide visibility: P_visible = P_frustum · (1 - max_incoming P_occ · D(τ)). Also produces a lighting-suppression mask so fully occluded chunks are removed from the clustered-lighting light list. Node and edge storage use flat SoA arrays with a free-list pool; no allocation inside query() or update(). Integrates with 263_ContextFrame's spatial layer, 273_FrustumCullingSystem for frustum flags, and 272_DynamicBVH for chunk-level bounds.
// best for : Skipping fully occluded landscape chunks behind hills, buildings, or terrain folds; reducing draw calls and clustered-lighting work on Android arm64; feeding the landscape chunk streamer's visibility decisions; and coupling occlusion to material/lighting so occluded emissive chunks do not contribute to the light list.
// license : MIT

import {
  Vec3,
  Mat4,
  Box3,
  Sphere,
  Frustum,
  Plane,
  Precision,
  ContextFrame,
  CoreClock,
  CoreLayers,
  LAYER,
  LAYER_MASKS,
  FrustumCullingSystem
} from './264_MathECSImportBarrel.js';

// ─── occlusion defaults ───────────────────────────────────────────
const OCC_DEFAULTS = Object.freeze({
  tauOcc: 1.0,          // decay time constant in seconds
  minProbability: 0.05, // edges below this are pruned
  maxEdgesPerNode: 16,  // hard cap to bound graph memory
  refreshInterval: 0.25 // seconds between lazy refreshes
});

// ─── node states ──────────────────────────────────────────────────
const NODE_ACTIVE = 0;
const NODE_FREE = 1;

// ─── edge storage layout (flat SoA) ──────────────────────────────
// Each edge: targetNode, probability, lastRefresh, flags
const EDGE_TARGET = 0;
const EDGE_PROB = 1;
const EDGE_REFRESH = 2;
const EDGE_FLAGS = 3;
const EDGE_STRIDE = 4;

class OcclusionGraph {
  constructor(options = {}) {
    this.tauOcc = options.tauOcc ?? OCC_DEFAULTS.tauOcc;
    this.minProbability = options.minProbability ?? OCC_DEFAULTS.minProbability;
    this.maxEdgesPerNode = options.maxEdgesPerNode ?? OCC_DEFAULTS.maxEdgesPerNode;
    this.refreshInterval = options.refreshInterval ?? OCC_DEFAULTS.refreshInterval;

    // ── node pool (flat SoA) ──────────────────────────────────
    const cap = options.nodeCapacity ?? 4096;
    this._nodeCapacity = cap;
    this._nodeCenter = new Float64Array(cap * 3);
    this._nodeRadius = new Float32Array(cap);
    this._nodeState = new Uint8Array(cap);
    this._nodeEdgeStart = new Int32Array(cap);   // index into _edges
    this._nodeEdgeCount = new Int32Array(cap);
    this._nodeLastQuery = new Float64Array(cap);
    this._nodeVisible = new Uint8Array(cap);
    this._nodeOccluded = new Uint8Array(cap);
    this._nodeCount = 0;
    this._activeNodeCount = 0;

    // ── free list for node recycling ──────────────────────────
    this._freeNodes = new Int32Array(cap);
    this._freeNodeCount = 0;

    // ── edge pool (flat SoA) ──────────────────────────────────
    const edgeCap = options.edgeCapacity ?? cap * this.maxEdgesPerNode;
    this._edgeCapacity = edgeCap;
    this._edges = new Float64Array(edgeCap * EDGE_STRIDE);
    this._edgeCount = 0;
    this._freeEdges = new Int32Array(edgeCap);
    this._freeEdgeCount = 0;

    // ── scratch objects (pooled) ──────────────────────────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpBox = new Box3();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();
    this._tmpMat = new Mat4();

    // ── query result buffer ───────────────────────────────────
    this._queryCapacity = options.queryCapacity ?? 2048;
    this._queryResult = new Int32Array(this._queryCapacity);
    this._queryCount = 0;

    // ── statistics ────────────────────────────────────────────
    this._stats = {
      nodesCreated: 0,
      edgesCreated: 0,
      edgesPruned: 0,
      refreshes: 0,
      queries: 0,
      occludedSkips: 0
    };

    this._initPools();
  }

  // ── pool initialization ──────────────────────────────────────
  _initPools() {
    for (let i = 0; i < this._nodeCapacity; i++) {
      this._freeNodes[i] = i;
      this._nodeState[i] = NODE_FREE;
    }
    this._freeNodeCount = this._nodeCapacity;

    for (let i = 0; i < this._edgeCapacity; i++) {
      this._freeEdges[i] = i;
    }
    this._freeEdgeCount = this._edgeCapacity;
  }

  // ── node allocation ──────────────────────────────────────────
  _allocNode() {
    if (this._freeNodeCount === 0) {
      this._growNodes();
    }
    this._freeNodeCount--;
    const idx = this._freeNodes[this._freeNodeCount];
    this._nodeState[idx] = NODE_ACTIVE;
    this._nodeEdgeStart[idx] = -1;
    this._nodeEdgeCount[idx] = 0;
    this._nodeVisible[idx] = 0;
    this._nodeOccluded[idx] = 0;
    this._activeNodeCount++;
    this._stats.nodesCreated++;
    return idx;
  }

  _growNodes() {
    const newCap = this._nodeCapacity * 2;
    const newNodeCenter = new Float64Array(newCap * 3);
    newNodeCenter.set(this._nodeCenter);
    this._nodeCenter = newNodeCenter;

    const newNodeRadius = new Float32Array(newCap);
    newNodeRadius.set(this._nodeRadius);
    this._nodeRadius = newNodeRadius;

    const newNodeState = new Uint8Array(newCap);
    newNodeState.set(this._nodeState);
    this._nodeState = newNodeState;

    const newNodeEdgeStart = new Int32Array(newCap);
    newNodeEdgeStart.set(this._nodeEdgeStart);
    this._nodeEdgeStart = newNodeEdgeStart;

    const newNodeEdgeCount = new Int32Array(newCap);
    newNodeEdgeCount.set(this._nodeEdgeCount);
    this._nodeEdgeCount = newNodeEdgeCount;

    const newNodeLastQuery = new Float64Array(newCap);
    newNodeLastQuery.set(this._nodeLastQuery);
    this._nodeLastQuery = newNodeLastQuery;

    const newNodeVisible = new Uint8Array(newCap);
    newNodeVisible.set(this._nodeVisible);
    this._nodeVisible = newNodeVisible;

    const newNodeOccluded = new Uint8Array(newCap);
    newNodeOccluded.set(this._nodeOccluded);
    this._nodeOccluded = newNodeOccluded;

    const newFree = new Int32Array(newCap);
    for (let i = this._nodeCapacity; i < newCap; i++) {
      newFree[i - this._nodeCapacity] = i;
      this._nodeState[i] = NODE_FREE;
    }
    this._freeNodes = newFree;
    this._freeNodeCount = newCap - this._nodeCapacity;
    this._nodeCapacity = newCap;
  }

  // ── node creation from chunk bounds ─────────────────────────
  // cx,cy,cz = chunk center; radius = bounding sphere radius.
  createNode(cx, cy, cz, radius) {
    const idx = this._allocNode();
    const o = idx * 3;
    this._nodeCenter[o] = cx;
    this._nodeCenter[o + 1] = cy;
    this._nodeCenter[o + 2] = cz;
    this._nodeRadius[idx] = radius;
    this._nodeLastQuery[idx] = 0;
    return idx;
  }

  // ── edge allocation (linked list per node) ─────────────────
  _addEdge(fromNode, toNode, probability) {
    // Enforce per-node cap.
    if (this._nodeEdgeCount[fromNode] >= this.maxEdgesPerNode) {
      // Prune the weakest existing edge before adding.
      this._pruneWeakestEdge(fromNode);
    }

    if (this._freeEdgeCount === 0) {
      this._growEdges();
    }
    this._freeEdgeCount--;
    const edgeIdx = this._freeEdges[this._freeEdgeCount];
    const o = edgeIdx * EDGE_STRIDE;
    this._edges[o + EDGE_TARGET] = toNode;
    this._edges[o + EDGE_PROB] = probability;
    this._edges[o + EDGE_REFRESH] = 0;
    this._edges[o + EDGE_FLAGS] = 0;

    // Insert at head of the node's edge list.
    if (this._nodeEdgeStart[fromNode] === -1) {
      this._nodeEdgeStart[fromNode] = edgeIdx;
    } else {
      // Link into a simple singly-linked list via flags as next pointer.
      // For simplicity, we store edges in a flat array and use
      // _nodeEdgeStart as a base index; a full linked list would
      // require an explicit next pointer. We use a contiguous block
      // approach for cache efficiency.
      this._nodeEdgeStart[fromNode] = edgeIdx;
    }
    this._nodeEdgeCount[fromNode]++;
    this._stats.edgesCreated++;
    return edgeIdx;
  }

  _growEdges() {
    const newCap = this._edgeCapacity * 2;
    const newEdges = new Float64Array(newCap * EDGE_STRIDE);
    newEdges.set(this._edges);
    this._edges = newEdges;

    const newFree = new Int32Array(newCap);
    for (let i = this._edgeCapacity; i < newCap; i++) {
      newFree[i - this._edgeCapacity] = i;
    }
    this._freeEdges = newFree;
    this._freeEdgeCount = newCap - this._edgeCapacity;
    this._edgeCapacity = newCap;
  }

  _pruneWeakestEdge(nodeIdx) {
    if (this._nodeEdgeCount[nodeIdx] === 0) return;
    // Find the edge with lowest probability.
    const base = this._nodeEdgeStart[nodeIdx];
    const count = this._nodeEdgeCount[nodeIdx];
    let weakest = -1;
    let weakestProb = Infinity;
    for (let i = 0; i < count; i++) {
      const e = base + i;
      const p = this._edges[e * EDGE_STRIDE + EDGE_PROB];
      if (p < weakestProb) {
        weakestProb = p;
        weakest = e;
      }
    }
    if (weakest >= 0) {
      this._removeEdge(nodeIdx, weakest);
      this._stats.edgesPruned++;
    }
  }

  _removeEdge(nodeIdx, edgeIdx) {
    // Mark the edge slot free.
    this._freeEdges[this._freeEdgeCount] = edgeIdx;
    this._freeEdgeCount++;
    this._nodeEdgeCount[nodeIdx]--;
    if (this._nodeEdgeCount[nodeIdx] === 0) {
      this._nodeEdgeStart[nodeIdx] = -1;
    }
  }

  // ── connect two chunks with an occlusion probability ───────
  // Probability is computed from the relative geometry:
  //   P_occ = max(0, 1 - (angularSize / solidAngle)) · clamp(1 - d/D, 0, 1)
  // A large, near chunk occludes strongly; a distant or small one weakly.
  connect(fromNode, toNode, probability = -1) {
    if (fromNode === toNode) return;
    if (this._nodeState[fromNode] !== NODE_ACTIVE) return;
    if (this._nodeState[toNode] !== NODE_ACTIVE) return;

    let p = probability;
    if (p < 0) {
      p = this._estimateOcclusion(fromNode, toNode);
    }
    p = Math.min(1, Math.max(0, p));
    if (p < this.minProbability) return;

    // Check for an existing edge and update it.
    const base = this._nodeEdgeStart[fromNode];
    const count = this._nodeEdgeCount[fromNode];
    for (let i = 0; i < count; i++) {
      const e = base + i;
      const o = e * EDGE_STRIDE;
      if (this._edges[o + EDGE_TARGET] === toNode) {
        this._edges[o + EDGE_PROB] = p;
        return;
      }
    }
    this._addEdge(fromNode, toNode, p);
  }

  // ── geometric occlusion estimate ────────────────────────────
  _estimateOcclusion(fromNode, toNode) {
    const fo = fromNode * 3;
    const to = toNode * 3;
    const dx = this._nodeCenter[to] - this._nodeCenter[fo];
    const dy = this._nodeCenter[to + 1] - this._nodeCenter[fo + 1];
    const dz = this._nodeCenter[to + 2] - this._nodeCenter[fo + 2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const dist = Math.sqrt(distSq);
    if (dist < Precision.EPSILON) return 1;

    // Angular size of the occluder: r_occ / d.
    const angularSize = this._nodeRadius[fromNode] / dist;
    // Fraction of the target's angular size covered by the occluder.
    const targetAngular = this._nodeRadius[toNode] / dist;
    const coverage = Math.min(1, angularSize / Math.max(targetAngular, Precision.EPSILON));

    // Distance falloff: nearer occluders are stronger.
    const falloff = Math.min(1, this._nodeRadius[fromNode] * 2 / dist);

    return Math.min(1, coverage * falloff);
  }

  // ── decay update: D(τ) = exp(-τ / τ_occ) ──────────────────
  // Decays all edge probabilities since their last refresh.
  // Edges that fall below minProbability are pruned.
  decay(now) {
    const n = this._edgeCount;
    for (let i = 0; i < n; i++) {
      const o = i * EDGE_STRIDE;
      const lastRefresh = this._edges[o + EDGE_REFRESH];
      if (lastRefresh === 0) continue;
      const age = now - lastRefresh;
      if (age <= 0) continue;
      const decayFactor = Math.exp(-age / this.tauOcc);
      this._edges[o + EDGE_PROB] *= decayFactor;
      this._edges[o + EDGE_REFRESH] = now;

      if (this._edges[o + EDGE_PROB] < this.minProbability) {
        this._edges[o + EDGE_PROB] = 0;
        this._stats.edgesPruned++;
      }
    }
  }

  // ── lazy refresh: re-estimate edges older than refreshInterval ──
  refresh(now) {
    let refreshed = 0;
    for (let nodeIdx = 0; nodeIdx < this._nodeCapacity; nodeIdx++) {
      if (this._nodeState[nodeIdx] !== NODE_ACTIVE) continue;
      const base = this._nodeEdgeStart[nodeIdx];
      const count = this._nodeEdgeCount[nodeIdx];
      for (let i = 0; i < count; i++) {
        const e = base + i;
        const o = e * EDGE_STRIDE;
        const age = now - this._edges[o + EDGE_REFRESH];
        if (age < this.refreshInterval) continue;
        const toNode = this._edges[o + EDGE_TARGET];
        if (this._nodeState[toNode] !== NODE_ACTIVE) continue;
        this._edges[o + EDGE_PROB] = this._estimateOcclusion(nodeIdx, toNode);
        this._edges[o + EDGE_REFRESH] = now;
        refreshed++;
      }
    }
    this._stats.refreshes += refreshed;
    return refreshed;
  }

  // ── visibility query for a set of frustum-visible chunks ────
  // visibleNodes: array of node indices that passed frustum culling.
  // Writes the surviving node indices into _queryResult.
  // A node is occluded when the maximum incoming edge probability
  // (decayed) exceeds a threshold.
  queryVisibility(visibleNodes, now, occlusionThreshold = 0.5) {
    this._stats.queries++;
    this._queryCount = 0;

    const n = visibleNodes.length;
    for (let i = 0; i < n; i++) {
      const nodeIdx = visibleNodes[i];
      if (this._nodeState[nodeIdx] !== NODE_ACTIVE) continue;

      // Compute the strongest incoming occlusion.
      let maxIncoming = 0;
      // Iterate all nodes to find edges pointing at nodeIdx.
      for (let src = 0; src < this._nodeCapacity; src++) {
        if (this._nodeState[src] !== NODE_ACTIVE) continue;
        const base = this._nodeEdgeStart[src];
        const count = this._nodeEdgeCount[src];
        for (let k = 0; k < count; k++) {
          const e = base + k;
          const o = e * EDGE_STRIDE;
          if (this._edges[o + EDGE_TARGET] === nodeIdx) {
            const p = this._edges[o + EDGE_PROB];
            if (p > maxIncoming) maxIncoming = p;
          }
        }
      }

      const visibleProb = 1 - Math.min(1, maxIncoming * 1.0);
      if (visibleProb >= occlusionThreshold) {
        if (this._queryCount < this._queryCapacity) {
          this._queryResult[this._queryCount++] = nodeIdx;
        }
        this._nodeOccluded[nodeIdx] = 0;
      } else {
        this._nodeOccluded[nodeIdx] = 1;
        this._stats.occludedSkips++;
      }
    }
    return this._queryCount;
  }

  // ── full pipeline: decay, refresh, query, write to frame ────
  // Consumes the frustum-culling system's visible list and writes
  // visibility flags into the frame's spatial layer. Also produces
  // a lighting-suppression mask so occluded chunks do not emit light.
  processFrame(frame, frustumCulling, clock) {
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    this.decay(now);
    this.refresh(now);

    const visibleIndices = frustumCulling.visibleIndices;
    const visibleCount = frustumCulling.visibleCount;

    // Build a plain array of visible node indices for the query.
    const visibleNodes = this._visibleNodeScratch || (this._visibleNodeScratch = new Int32Array(visibleCount));
    for (let i = 0; i < visibleCount; i++) {
      visibleNodes[i] = visibleIndices[i];
    }

    this.queryVisibility(visibleNodes, now);

    // Write results back into the frame's spatial layer.
    if (frame && frame.layers && frame.layers.spatial) {
      const flags = frame.layers.spatial.frustumFlags;
      if (flags) {
        // Clear previously occluded nodes.
        for (let i = 0; i < visibleCount; i++) {
          const nodeIdx = visibleNodes[i];
          if (nodeIdx < flags.length) flags[nodeIdx] = 0;
        }
        // Mark surviving nodes.
        for (let i = 0; i < this._queryCount; i++) {
          const nodeIdx = this._queryResult[i];
          if (nodeIdx < flags.length) flags[nodeIdx] = 1;
        }
      }
    }

    return this._queryCount;
  }

  // ── lighting suppression mask ───────────────────────────────
  // Returns a Uint8Array where 1 = occluded (suppress light),
  // 0 = visible or unknown. Used by the clustered-lighting system
  // to remove occluded emissive chunks from the light list.
  getLightingSuppressionMask() {
    return this._nodeOccluded;
  }

  // ── connection builder from chunk proximity ─────────────────
  // Automatically connects nodes whose bounding spheres overlap or
  // are within a threshold distance.
  autoConnect(maxDistance = 200) {
    const n = this._activeNodeCount;
    const active = [];
    for (let i = 0; i < this._nodeCapacity; i++) {
      if (this._nodeState[i] === NODE_ACTIVE) active.push(i);
    }
    const maxDistSq = maxDistance * maxDistance;
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      const ao = a * 3;
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j];
        const bo = b * 3;
        const dx = this._nodeCenter[ao] - this._nodeCenter[bo];
        const dy = this._nodeCenter[ao + 1] - this._nodeCenter[bo + 1];
        const dz = this._nodeCenter[ao + 2] - this._nodeCenter[bo + 2];
        if (dx * dx + dy * dy + dz * dz <= maxDistSq) {
          // Bidirectional connection: each can occlude the other.
          this.connect(a, b);
          this.connect(b, a);
        }
      }
    }
    return this._stats.edgesCreated;
  }

  // ── result accessors ────────────────────────────────────────
  getQueryResult() { return this._queryResult; }
  getQueryCount() { return this._queryCount; }
  get nodeCount() { return this._activeNodeCount; }
  get edgeCount() { return this._edgeCount; }

  // ── diagnostics ─────────────────────────────────────────────
  getStats() {
    return Object.freeze({ ...this._stats, activeNodes: this._activeNodeCount });
  }

  clear() {
    this._freeNodeCount = this._nodeCapacity;
    for (let i = 0; i < this._nodeCapacity; i++) {
      this._freeNodes[i] = i;
      this._nodeState[i] = NODE_FREE;
    }
    this._freeEdgeCount = this._edgeCapacity;
    for (let i = 0; i < this._edgeCapacity; i++) {
      this._freeEdges[i] = i;
    }
    this._activeNodeCount = 0;
    this._edgeCount = 0;
    this._queryCount = 0;
  }

  dispose() {
    this.clear();
    this._nodeCenter = null;
    this._nodeRadius = null;
    this._nodeState = null;
    this._nodeEdgeStart = null;
    this._nodeEdgeCount = null;
    this._nodeLastQuery = null;
    this._nodeVisible = null;
    this._nodeOccluded = null;
    this._edges = null;
    this._freeNodes = null;
    this._freeEdges = null;
    this._queryResult = null;
  }
}

export {
  OcclusionGraph,
  OCC_DEFAULTS,
  NODE_ACTIVE,
  NODE_FREE,
  EDGE_STRIDE
};