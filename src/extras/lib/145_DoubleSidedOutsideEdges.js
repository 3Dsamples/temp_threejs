// file number : 145
// full path name : src/extras/lib/145_DoubleSidedOutsideEdges.js
// description : Double-sided outside edge geometry rewritten as a pure ES module with zero CDN imports. Extends OutsideEdgesGeometry (129) with a doubleSided flag that emits both (a, b) and (b, a) edges for meshes rendered with side: DoubleSide. Standard OutsideEdgesGeometry relies on winding-based parity to identify unshared edges — which fails on double-sided geometry because both front and back faces produce the same edge pairs with opposite winding, causing every interior edge to incorrectly cancel out and every silhouette edge to disappear. This variant detects the double-sided case via a configurable windingMode ('auto', 'single', 'double') and, in 'double' mode, emits both orientations for every unshared edge so silhouettes on foliage, cloth, and other DoubleSide surfaces render correctly. Uses the same flat typed-array edge-map architecture as 129 with integer keys, pooled instances via acquire()/release(), and a BitECS SoA bridge exposing per-mode edge counts. Uses the project's BufferGeometry (097), BufferAttribute (094), Vec3 (006), Common (003), and Constants (002) modules. Designed for 10k+ double-sided meshes on Android 64-bit.
// best for : Double-sided foliage and cloth with visible silhouettes, thin-walled geometry rendered with side: DoubleSide, single-sided meshes that must render as double-sided without losing their outline, anime hair and clothing outlines, virtual reality immersive surfaces, and any ECS-driven living-world pipeline that needs correct double-sided silhouettes at 10k+ entity scale on Android 64-bit.
// license : MIT — architecture based on gkjohnson/threejs-sandbox (conditional-lines)

import { Constants } from '../../core/002_Constants.js';
import { Common } from '../../core/003_Common.js';
import { Precision } from '../../core/004_Precision.js';
import { Vec2 } from '../../math/005_Vec2.js';
import { Vec3 } from '../../math/006_Vec3.js';
import { Vec4 } from '../../math/007_Vec4.js';
import { Mat2 } from '../../math/008_Mat2.js';
import { Mat3 } from '../../math/009_Mat3.js';
import { Mat4 } from '../../math/010_Mat4.js';
import { Quat } from '../../math/011_Quat.js';
import { Quat2 } from '../../math/012_Quat2.js';
import { SimplexNoise } from '../../math/013_SimplexNoise.js';
import { BitECS } from '../../ecs/014_BitECS.js';
import { World } from '../../ecs/015_World.js';
import { Components } from '../../ecs/016_Components.js';
import { Systems } from '../../ecs/017_Systems.js';
import { BufferGeometry } from '../../core/097_BufferGeometry.js';
import { BufferAttribute } from '../../core/094_BufferAttribute.js';

// ---------------------------------------------------------------------------
// Winding mode constants — how the mesh's triangle winding is interpreted.
// ---------------------------------------------------------------------------
const WindingMode = {
  AUTO: 0,     // detect by inspecting winding consistency
  SINGLE: 1,   // treat as single-sided (same as 129)
  DOUBLE: 2,   // treat as double-sided — emit both (a,b) and (b,a) for unshared edges
};

// ---------------------------------------------------------------------------
// Static pool for DoubleSidedOutsideEdges instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle double-sided outlines at
// runtime.
// ---------------------------------------------------------------------------
const _geometryPool = [];

function _acquireGeometry() {
  const g = _geometryPool.pop();
  if (g) {
    for (const key in g.attributes) delete g.attributes[key];
    g.index = null;
    g.groups.length = 0;
    g.boundingBox = null;
    g.boundingSphere = null;
    g.userData = {};
    g.version = 0;
    g._needsUpdate = false;
    g._edgeCount = 0;
    g._windingMode = WindingMode.AUTO;
    g._resolvedMode = WindingMode.SINGLE;
    g._skippedInterior = 0;
    return g;
  }
  return new DoubleSidedOutsideEdges();
}

function _releaseGeometry(g) {
  if (_geometryPool.length < 64) _geometryPool.push(g);
}

// ---------------------------------------------------------------------------
// DoubleSidedOutsideEdges — emits unshared edges for single- and double-sided
// meshes.
//
// Standard OutsideEdgesGeometry (129) algorithm:
//   For each directed edge (a, b), if the reverse (b, a) is present in the
//   edge map, delete it (interior edge); otherwise keep it (outside edge).
//
// Why this fails on double-sided meshes:
//   A mesh rendered with side: DoubleSide is composed of triangles whose
//   winding, from the renderer's perspective, is BOTH front-facing and
//   back-facing. In practice, the geometry has:
//     – Some triangles ordered CCW (front face)
//     – Some triangles ordered CW (back face)
//   For a closed double-sided mesh, EVERY interior edge appears twice with
//   opposite winding — so the standard algorithm correctly cancels it. But
//   the SILHOUETTE edges also appear twice (once from front, once from back)
//   with opposite winding, so the standard algorithm also cancels them —
//   leaving nothing visible.
//
// Fix in DOUBLE mode:
//   Skip the reverse-edge deletion step entirely. Every directed edge that
//   appears only once in a given winding direction is an outside edge. Emit
//   BOTH (a, b) and (b, a) for edges that would otherwise be cancelled — so
//   the silhouette is always visible from either side.
//
// WindingMode.AUTO:
//   Count total directed edges and unique undirected edges. If
//   uniqueUndirectedEdges > 0 and totalDirectedEdges / uniqueUndirectedEdges
//   is close to 1.0 (i.e. most edges appear in only one winding direction),
//   the mesh is single-sided → resolve to SINGLE. If the ratio is close to
//   2.0 (i.e. most edges appear in both windings), the mesh is double-sided
//   → resolve to DOUBLE.
// ---------------------------------------------------------------------------
class DoubleSidedOutsideEdges extends BufferGeometry {
  /**
   * @param {BufferGeometry} [geometry] — source geometry
   * @param {object} [options={}]
   * @param {number} [options.windingMode=WindingMode.AUTO]
   */
  constructor(geometry, options = {}) {
    super();

    this.isDoubleSidedOutsideEdges = true;
    this.type = 'DoubleSidedOutsideEdges';

    this._edgeCount = 0;
    this._windingMode = options.windingMode !== undefined
      ? options.windingMode
      : WindingMode.AUTO;
    this._resolvedMode = WindingMode.SINGLE;
    this._skippedInterior = 0;

    if (geometry) {
      this.fromGeometry(geometry, options);
    }
  }

  // -----------------------------------------------------------------------
  // Main entry point
  // -----------------------------------------------------------------------

  /**
   * Rebuild this geometry from a source BufferGeometry.
   *
   * @param {BufferGeometry} geometry
   * @param {object} [options={}]
   * @param {number} [options.windingMode=this._windingMode]
   * @returns {this}
   */
  fromGeometry(geometry, options = {}) {
    if (!geometry || !geometry.attributes || !geometry.attributes.position) {
      throw new Error('DoubleSidedOutsideEdges.fromGeometry: source geometry has no position attribute.');
    }

    // Clear previous output
    for (const key in this.attributes) delete this.attributes[key];
    this.index = null;
    this.groups.length = 0;

    this._edgeCount = 0;
    this._skippedInterior = 0;

    if (options.windingMode !== undefined) {
      this._windingMode = options.windingMode;
    }

    const position = geometry.attributes.position;
    const posArr = position.array;
    const stride = position.itemSize || 3;
    const vertexCount = position.count;

    // ---------------------------------------------------------------------
    // 1. Build flat index array (indexed or non-indexed input).
    // ---------------------------------------------------------------------
    let idx;
    let numTris;
    if (geometry.index) {
      idx = geometry.index.array;
      numTris = Math.floor(geometry.index.count / 3);
    } else {
      idx = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) idx[i] = i;
      numTris = Math.floor(vertexCount / 3);
    }

    if (numTris === 0) {
      this._emitEmpty();
      this._resolvedMode = this._resolveMode(WindingMode.SINGLE, 0, 0);
      return this;
    }

    // ---------------------------------------------------------------------
    // 2. Resolve the winding mode (AUTO / SINGLE / DOUBLE)
    // ---------------------------------------------------------------------
    const resolved = this._resolveModeFromGeometry(geometry, idx, numTris);
    this._resolvedMode = resolved;

    // ---------------------------------------------------------------------
    // 3. Build the edge map.
    //    SINGLE mode: standard parity cancellation (same as 129).
    //    DOUBLE mode: emit both (a,b) and (b,a) for every directed edge
    //                 that appears exactly once in its winding direction.
    // ---------------------------------------------------------------------
    const edgeMap = new Map();

    let edgeCap = Math.max(64, (numTris * 3) >> 1);
    let recIndex0 = new Int32Array(edgeCap);
    let recIndex1 = new Int32Array(edgeCap);
    let edgeCount = 0;

    const grow = () => {
      edgeCap *= 2;
      const a = new Int32Array(edgeCap); a.set(recIndex0); recIndex0 = a;
      const b = new Int32Array(edgeCap); b.set(recIndex1); recIndex1 = b;
    };

    if (resolved === WindingMode.DOUBLE) {
      // -------------------------------------------------------------------
      // DOUBLE mode: emit both windings for every directed edge that appears
      // exactly once. This preserves silhouettes when the mesh has mixed
      // winding (front + back faces) that would otherwise cancel out.
      // -------------------------------------------------------------------
      // First pass: count directed edge occurrences.
      const directedCount = new Map();

      for (let t = 0; t < numTris; t++) {
        const i0 = idx[t * 3 + 0];
        const i1 = idx[t * 3 + 1];
        const i2 = idx[t * 3 + 2];

        // Directed key = (a, b) — direction matters
        this._incrementDirected(directedCount, i0, i1, vertexCount);
        this._incrementDirected(directedCount, i1, i2, vertexCount);
        this._incrementDirected(directedCount, i2, i0, vertexCount);
      }

      // Second pass: for each directed edge, if count === 1, emit both
      // (a, b) and (b, a).
      for (let t = 0; t < numTris; t++) {
        const i0 = idx[t * 3 + 0];
        const i1 = idx[t * 3 + 1];
        const i2 = idx[t * 3 + 2];

        this._maybeEmitDouble(directedCount, i0, i1, vertexCount, grow, () => edgeCount, (v) => edgeCount = v, recIndex0, recIndex1);
        this._maybeEmitDouble(directedCount, i1, i2, vertexCount, grow, () => edgeCount, (v) => edgeCount = v, recIndex0, recIndex1);
        this._maybeEmitDouble(directedCount, i2, i0, vertexCount, grow, () => edgeCount, (v) => edgeCount = v, recIndex0, recIndex1);
      }

      // Suppress unused-variable warning for edgeMap
      void edgeMap;
    } else {
      // -------------------------------------------------------------------
      // SINGLE mode: standard parity cancellation (identical to 129).
      // -------------------------------------------------------------------
      for (let t = 0; t < numTris; t++) {
        const i0 = idx[t * 3 + 0];
        const i1 = idx[t * 3 + 1];
        const i2 = idx[t * 3 + 2];

        for (let j = 0; j < 3; j++) {
          const a = j === 0 ? i0 : j === 1 ? i1 : i2;
          const b = j === 0 ? i1 : j === 1 ? i2 : i0;

          const minAB = a < b ? a : b;
          const maxAB = a < b ? b : a;
          const key = minAB * vertexCount + maxAB;

          const existing = edgeMap.get(key);
          if (existing !== undefined) {
            // Interior edge — cancel
            const last = --edgeCount;
            if (existing !== last) {
              recIndex0[existing] = recIndex0[last];
              recIndex1[existing] = recIndex1[last];
              edgeMap.set(recIndex0[existing] * vertexCount + recIndex1[existing], existing);
            }
            edgeMap.delete(key);
            this._skippedInterior += 2;
          } else {
            if (edgeCount >= edgeCap) grow();
            recIndex0[edgeCount] = a;
            recIndex1[edgeCount] = b;
            edgeMap.set(key, edgeCount);
            edgeCount++;
          }
        }
      }
    }

    // ---------------------------------------------------------------------
    // 4. Allocate exact output buffer (2 vertices per surviving edge)
    // ---------------------------------------------------------------------
    const outVertexCount = edgeCount * 2;
    const outPosition = new Float32Array(outVertexCount * 3);

    // ---------------------------------------------------------------------
    // 5. Fill the output buffer
    // ---------------------------------------------------------------------
    let o = 0;

    for (let e = 0; e < edgeCount; e++) {
      const i0 = recIndex0[e];
      const i1 = recIndex1[e];

      // Vertex A
      outPosition[o + 0] = posArr[i0 * stride + 0];
      outPosition[o + 1] = posArr[i0 * stride + 1];
      outPosition[o + 2] = posArr[i0 * stride + 2];
      o += 3;

      // Vertex B
      outPosition[o + 0] = posArr[i1 * stride + 0];
      outPosition[o + 1] = posArr[i1 * stride + 1];
      outPosition[o + 2] = posArr[i1 * stride + 2];
      o += 3;
    }

    // ---------------------------------------------------------------------
    // 6. Attach the position attribute
    // ---------------------------------------------------------------------
    this.setAttribute('position', new BufferAttribute(outPosition, 3, false));

    this._edgeCount = edgeCount;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Internal: winding mode resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve the winding mode from the source geometry.
   * @private
   */
  _resolveModeFromGeometry(geometry, idx, numTris) {
    if (this._windingMode !== WindingMode.AUTO) {
      return this._windingMode;
    }

    // Sample up to 1000 triangles for a fast estimate
    const sampleSize = Math.min(numTris, 1000);
    const vertexCount = geometry.attributes.position.count;

    const directedCount = new Map();
    let totalDirected = 0;

    const step = Math.max(1, Math.floor(numTris / sampleSize));
    for (let t = 0; t < numTris; t += step) {
      const i0 = idx[t * 3 + 0];
      const i1 = idx[t * 3 + 1];
      const i2 = idx[t * 3 + 2];

      this._incrementDirected(directedCount, i0, i1, vertexCount);
      this._incrementDirected(directedCount, i1, i2, vertexCount);
      this._incrementDirected(directedCount, i2, i0, vertexCount);
      totalDirected += 3;
    }

    // Count undirected (canonical min,max) edges
    const undirectedSet = new Set();
    for (const key of directedCount.keys()) {
      const a = Math.floor(key / vertexCount);
      const b = key % vertexCount;
      const minAB = a < b ? a : b;
      const maxAB = a < b ? b : a;
      undirectedSet.add(minAB * vertexCount + maxAB);
    }

    const uniqueUndirected = undirectedSet.size;
    if (uniqueUndirected === 0) return WindingMode.SINGLE;

    const ratio = totalDirected / uniqueUndirected;
    // ratio ≈ 1.0 → single-sided (each edge appears once)
    // ratio ≈ 2.0 → double-sided (each edge appears twice, both windings)
    if (ratio >= 1.8) return WindingMode.DOUBLE;
    return WindingMode.SINGLE;
  }

  /**
   * Resolve a mode from precomputed counts (used for the empty case).
   * @private
   */
  _resolveMode(requested, totalDirected, uniqueUndirected) {
    if (requested !== WindingMode.AUTO) return requested;
    if (uniqueUndirected === 0) return WindingMode.SINGLE;
    const ratio = totalDirected / uniqueUndirected;
    return ratio >= 1.8 ? WindingMode.DOUBLE : WindingMode.SINGLE;
  }

  /**
   * Increment a directed edge count in the map.
   * @private
   */
  _incrementDirected(map, a, b, vertexCount) {
    if (a === b) return; // skip self-edges
    const key = a * vertexCount + b;
    map.set(key, (map.get(key) || 0) + 1);
  }

  /**
   * Emit both (a,b) and (b,a) for a directed edge if it appears exactly once.
   * @private
   */
  _maybeEmitDouble(directedCount, a, b, vertexCount, grow, getEdgeCount, setEdgeCount, recIndex0, recIndex1) {
    if (a === b) return;
    const keyAB = a * vertexCount + b;
    const countAB = directedCount.get(keyAB) || 0;

    // Only emit when this directed edge appears exactly once
    if (countAB !== 1) return;

    let edgeCount = getEdgeCount();

    // Emit (a, b)
    if (edgeCount >= recIndex0.length) grow();
    recIndex0[edgeCount] = a;
    recIndex1[edgeCount] = b;
    edgeCount++;

    // Emit (b, a)
    if (edgeCount >= recIndex0.length) grow();
    recIndex0[edgeCount] = b;
    recIndex1[edgeCount] = a;
    edgeCount++;

    setEdgeCount(edgeCount);
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** @returns {number} — number of outside edges emitted */
  get edgeCount() { return this._edgeCount; }

  /** @returns {number} — requested winding mode */
  get windingMode() { return this._windingMode; }
  set windingMode(v) { this._windingMode = v; }

  /** @returns {number} — resolved winding mode after AUTO detection */
  get resolvedMode() { return this._resolvedMode; }

  /** @returns {number} — number of interior edges cancelled (SINGLE mode only) */
  get skippedInterior() { return this._skippedInterior; }

  /**
   * Emit empty attributes.
   * @private
   */
  _emitEmpty() {
    this.setAttribute('position', new BufferAttribute(new Float32Array(0), 3, false));
    this.needsUpdate = true;
  }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose the geometry state as flat typed-array columns for ECS systems
   * that drive per-mesh silhouette toggling or LOD selection.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const posAttr = this.attributes.position;

    return {
      name,
      edgeCount: this._edgeCount,
      vertexCount: posAttr ? posAttr.count : 0,
      position: posAttr ? posAttr.array : null,
      windingMode: this._windingMode,
      resolvedMode: this._resolvedMode,
      isDoubleSided: this._resolvedMode === WindingMode.DOUBLE ? 1 : 0,
      skippedInterior: this._skippedInterior,
    };
  }

  // -----------------------------------------------------------------------
  // Disposal
  // -----------------------------------------------------------------------

  dispose() {
    super.dispose();
    this._edgeCount = 0;
    this._skippedInterior = 0;
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled DoubleSidedOutsideEdges instance (empty, AUTO mode).
   * @returns {DoubleSidedOutsideEdges}
   */
  static acquire() {
    return _acquireGeometry();
  }

  /**
   * Return this geometry to the pool. Caller must not use it afterward.
   */
  release() {
    for (const key in this.attributes) delete this.attributes[key];
    this._edgeCount = 0;
    this._skippedInterior = 0;
    _releaseGeometry(this);
  }

  /**
   * Clear the global DoubleSidedOutsideEdges pool.
   */
  static clearPool() {
    _geometryPool.length = 0;
  }
}

export { DoubleSidedOutsideEdges, WindingMode };
export default DoubleSidedOutsideEdges;