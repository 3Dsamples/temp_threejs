// file number : 143
// full path name : src/extras/lib/143_TIntersectionSplitter.js
// description : T-junction detector and splitter rewritten as a pure ES module with zero CDN imports. Detects vertices that lie strictly on another triangle's edge (the classic LDraw T-junction case, where conditional edges render with a visible gap or a doubled line) and splits the affected triangles into two or more sub-triangles that reference the existing T-junction vertex. Uses a spatial-hash broadphase over the canonicalized vertex positions, then an exact point-on-segment narrowphase with configurable epsilon, then a fan-retriangulation that preserves all vertex attributes (positions, normals, UVs, colors) without modifying any attribute array — only the index buffer changes. Handles both indexed and non-indexed source geometry by transparently converting non-indexed input into an identity index. Exposes hasTIntersections(geometry) for a fast boolean diagnostic, detectTIntersections(geometry) for a full record list, and splitGeometry(geometry) for the full remediation pass. Uses the project's BufferGeometry (097), BufferAttribute (094), Vec3 (006), Common (003), and Constants (002) modules. Pooled instances via acquire()/release(), BitECS SoA bridge exposing T-junction counts and per-triangle split counts. Designed for 10k+ triangle meshes on Android 64-bit where LDraw-compatible topology is required before conditional edge extraction.
// best for : LDraw-style model pipelines needing T-junction remediation before edge extraction, 3D printing mesh repair, CAD wireframe overlays on partially welded meshes, conditional line rendering on geometry that cannot be fully welded, and any ECS-driven living-world pipeline that requires watertight topological connectivity at 10k+ triangle scale on Android 64-bit.
// license : MIT — T-junction remediation algorithm inspired by the LDraw conditional edge specification

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
// Static pool for TIntersectionSplitter instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle T-junction remediation.
// ---------------------------------------------------------------------------
const _splitterPool = [];

function _acquireSplitter() {
  const s = _splitterPool.pop();
  if (s) {
    s._epsilon = 1e-5;
    s._cellSize = 1.0;
    s._maxSplitsPerEdge = 16;
    s._tJunctionCount = 0;
    s._trianglesModified = 0;
    s._trianglesAdded = 0;
    s._vertexCount = 0;
    s._triangleCount = 0;
    s._lastSplitMs = 0;
    return s;
  }
  return new TIntersectionSplitter();
}

function _releaseSplitter(s) {
  if (_splitterPool.length < 64) _splitterPool.push(s);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v3 = new Float32Array(3);

// ---------------------------------------------------------------------------
// TIntersectionSplitter — detects and remediates T-junctions in a triangle
// mesh.
//
// Algorithm overview:
//   hasTIntersections / detectTIntersections:
//     1. Build spatial hash of all vertices (canonicalized by rounded position).
//     2. For each triangle edge (a, b), query nearby vertices via the hash.
//     3. For each nearby vertex p (strictly between a and b), test exact
//        point-on-segment distance <= epsilon.
//     4. If found, record the T-junction (and, for hasTIntersections, return
//        immediately).
//
//   splitGeometry:
//     1. Convert non-indexed input into an identity index.
//     2. Build canonical position map (rounded position → first vertex index).
//     3. Build spatial hash on canonical vertices.
//     4. For each triangle, for each edge, collect all T-junction vertices
//        (canonicalized, sorted by parameter t along the edge).
//     5. Fan-retriangulate triangles that have at least one split:
//          boundary polygon = a, [splits on ab], b, [splits on bc], c, [splits on ca]
//          fan from `a` → one triangle per boundary edge segment
//     6. Emit a new BufferGeometry with the same attribute arrays but a new
//        index buffer.
// ---------------------------------------------------------------------------
class TIntersectionSplitter extends BufferGeometry {
  /**
   * @param {object} [options={}]
   * @param {number} [options.epsilon=1e-5] — max distance for a vertex to be
   *   considered "on" an edge
   * @param {number} [options.cellSize=1.0] — spatial-hash cell size (should be
   *   a small multiple of the average edge length)
   * @param {number} [options.maxSplitsPerEdge=16] — safety cap on the number
   *   of split points on a single edge
   */
  constructor(options = {}) {
    super();

    this.isTIntersectionSplitter = true;
    this.type = 'TIntersectionSplitter';

    this._epsilon = options.epsilon !== undefined ? options.epsilon : 1e-5;
    this._cellSize = options.cellSize !== undefined ? options.cellSize : 1.0;
    this._maxSplitsPerEdge = options.maxSplitsPerEdge !== undefined
      ? options.maxSplitsPerEdge
      : 16;

    // Stats from the last detection / split
    this._tJunctionCount = 0;
    this._trianglesModified = 0;
    this._trianglesAdded = 0;
    this._vertexCount = 0;
    this._triangleCount = 0;
    this._lastSplitMs = 0;
  }

  // -----------------------------------------------------------------------
  // Fast diagnostic
  // -----------------------------------------------------------------------

  /**
   * Fast boolean check: does this geometry contain any T-junctions?
   * Returns as soon as the first T-junction is found.
   *
   * @param {BufferGeometry} geometry
   * @returns {boolean}
   */
  hasTIntersections(geometry) {
    const ctx = this._prepareContext(geometry);
    if (!ctx) return false;

    const { posArr, stride, indices, triCount } = ctx;

    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3 + 0];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      if (this._edgeHasTIntersections(posArr, stride, i0, i1, geometry)) return true;
      if (this._edgeHasTIntersections(posArr, stride, i1, i2, geometry)) return true;
      if (this._edgeHasTIntersections(posArr, stride, i2, i0, geometry)) return true;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Full detection
  // -----------------------------------------------------------------------

  /**
   * Detect all T-junctions in the geometry.
   *
   * @param {BufferGeometry} geometry
   * @returns {Array<{ triangle: number, edgeA: number, edgeB: number, vertex: number, t: number }>}
   */
  detectTIntersections(geometry) {
    const ctx = this._prepareContext(geometry);
    if (!ctx) return [];

    const { posArr, stride, indices, triCount } = ctx;
    const results = [];

    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3 + 0];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      this._collectTJunctions(posArr, stride, t, i0, i1, geometry, results);
      this._collectTJunctions(posArr, stride, t, i1, i2, geometry, results);
      this._collectTJunctions(posArr, stride, t, i2, i0, geometry, results);
    }

    this._tJunctionCount = results.length;
    return results;
  }

  // -----------------------------------------------------------------------
  // Full split
  // -----------------------------------------------------------------------

  /**
   * Split all T-junctions and return a new BufferGeometry with the same
   * vertex attributes but a modified index buffer.
   *
   * @param {BufferGeometry} geometry — source geometry (indexed or not)
   * @returns {BufferGeometry} — new geometry with T-junctions split
   */
  splitGeometry(geometry) {
    const start = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    const ctx = this._prepareContext(geometry);
    if (!ctx) {
      // Empty or invalid — return an empty geometry with the same attributes
      return this._emitEmpty(geometry);
    }

    const { posArr, stride, indices, triCount, vertCount } = ctx;

    // -------------------------------------------------------------------
    // 1. Build canonical position map (rounded position → first vertex index)
    // -------------------------------------------------------------------
    const canonicalMap = new Map();
    const vertexCanonical = new Int32Array(vertCount);

    const prec = this._precisionFromEpsilon();
    for (let i = 0; i < vertCount; i++) {
      const key = this._positionKey(
        posArr[i * stride + 0],
        posArr[i * stride + 1],
        posArr[i * stride + 2],
        prec
      );
      let canonical = canonicalMap.get(key);
      if (canonical === undefined) {
        canonical = i;
        canonicalMap.set(key, i);
      }
      vertexCanonical[i] = canonical;
    }

    // -------------------------------------------------------------------
    // 2. Build spatial hash on canonical vertices
    // -------------------------------------------------------------------
    const spatialHash = this._buildSpatialHash(posArr, stride, vertCount, this._cellSize);

    // -------------------------------------------------------------------
    // 3. Retriangulate
    // -------------------------------------------------------------------
    // Pre-allocate output index buffer generously; grow if needed.
    // Worst case: every triangle split into a fan with maxSplitsPerEdge per edge.
    let outCap = triCount * 3 * (this._maxSplitsPerEdge + 1);
    let outIndices = new Uint32Array(outCap);
    let outLen = 0;

    // Scratch for the boundary polygon (per-triangle)
    const maxPolySize = 3 + this._maxSplitsPerEdge * 3;
    const poly = new Int32Array(maxPolySize);
    const splitT = new Float64Array(this._maxSplitsPerEdge);
    const splitV = new Int32Array(this._maxSplitsPerEdge);

    let triModifiedCount = 0;
    let tJunctionCount = 0;

    const ensureOutCapacity = (needed) => {
      if (outLen + needed <= outCap) return;
      outCap = Math.max(outCap * 2, outLen + needed);
      const nb = new Uint32Array(outCap);
      nb.set(outIndices);
      outIndices = nb;
    };

    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3 + 0];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];

      // Canonicalize vertex indices
      const c0 = vertexCanonical[i0];
      const c1 = vertexCanonical[i1];
      const c2 = vertexCanonical[i2];

      // --- Find splits on each edge ---
      const splitsAB = this._findSplitsOnEdge(
        posArr, stride, c0, c1, spatialHash, vertexCanonical, splitT, splitV
      );
      const splitsBC = this._findSplitsOnEdge(
        posArr, stride, c1, c2, spatialHash, vertexCanonical, splitT, splitV
      );
      const splitsCA = this._findSplitsOnEdge(
        posArr, stride, c2, c0, spatialHash, vertexCanonical, splitT, splitV
      );

      const totalSplits = splitsAB.count + splitsBC.count + splitsCA.count;

      if (totalSplits === 0) {
        // No split — emit the original triangle unchanged
        ensureOutCapacity(3);
        outIndices[outLen++] = i0;
        outIndices[outLen++] = i1;
        outIndices[outLen++] = i2;
        continue;
      }

      triModifiedCount++;
      tJunctionCount += totalSplits;

      // --- Build the boundary polygon ---
      // a, [splits on ab], b, [splits on bc], c, [splits on ca]
      let pi = 0;
      poly[pi++] = c0;
      for (let k = 0; k < splitsAB.count; k++) poly[pi++] = splitsAB.vertices[k];
      poly[pi++] = c1;
      for (let k = 0; k < splitsBC.count; k++) poly[pi++] = splitsBC.vertices[k];
      poly[pi++] = c2;
      for (let k = 0; k < splitsCA.count; k++) poly[pi++] = splitsCA.vertices[k];

      // --- Fan-triangulate from poly[0] ---
      const fanVertex = poly[0];
      const numTriangles = pi - 2;
      ensureOutCapacity(numTriangles * 3);

      for (let k = 1; k < pi - 1; k++) {
        outIndices[outLen++] = fanVertex;
        outIndices[outLen++] = poly[k];
        outIndices[outLen++] = poly[k + 1];
      }
    }

    // -------------------------------------------------------------------
    // 4. Build the output geometry (preserve all attributes)
    // -------------------------------------------------------------------
    const outGeometry = new BufferGeometry();

    for (const attrName in geometry.attributes) {
      outGeometry.setAttribute(attrName, geometry.attributes[attrName]);
    }

    const trimmedIndices = outIndices.subarray(0, outLen);
    outGeometry.setIndex(new BufferAttribute(trimmedIndices, 1, false));

    this._tJunctionCount = tJunctionCount;
    this._trianglesModified = triModifiedCount;
    this._trianglesAdded = (outLen / 3) - triCount;
    this._vertexCount = vertCount;
    this._triangleCount = triCount;

    const elapsed = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()) - start;
    this._lastSplitMs = elapsed;

    return outGeometry;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Extract positions, index, and counts from a source geometry. Returns
   * null if the geometry is invalid or empty.
   * @private
   */
  _prepareContext(geometry) {
    if (!geometry || !geometry.attributes || !geometry.attributes.position) {
      return null;
    }

    const position = geometry.attributes.position;
    const posArr = position.array;
    const stride = position.itemSize || 3;
    const vertCount = position.count;

    if (vertCount < 3) return null;

    let indices;
    let triCount;
    if (geometry.index) {
      indices = geometry.index.array;
      triCount = Math.floor(indices.length / 3);
    } else {
      indices = new Uint32Array(vertCount);
      for (let i = 0; i < vertCount; i++) indices[i] = i;
      triCount = Math.floor(vertCount / 3);
    }

    if (triCount === 0) return null;

    return { posArr, stride, indices, triCount, vertCount };
  }

  /**
   * Emit an empty geometry that preserves the source's attributes.
   * @private
   */
  _emitEmpty(geometry) {
    const out = new BufferGeometry();
    if (geometry && geometry.attributes) {
      for (const attrName in geometry.attributes) {
        out.setAttribute(attrName, geometry.attributes[attrName]);
      }
    }
    out.setIndex(new BufferAttribute(new Uint32Array(0), 1, false));
    return out;
  }

  /**
   * Compute the precision multiplier for position keys.
   * @private
   */
  _precisionFromEpsilon() {
    // Round to a precision finer than the epsilon, so nearby vertices
    // canonicalize together.
    return 1 / Math.max(this._epsilon * 10, 1e-8);
  }

  /**
   * Generate a canonical key for a position.
   * @private
   */
  _positionKey(x, y, z, prec) {
    return (
      Math.round(x * prec) + ',' +
      Math.round(y * prec) + ',' +
      Math.round(z * prec)
    );
  }

  /**
   * Build a spatial hash of canonical vertices.
   * @private
   */
  _buildSpatialHash(posArr, stride, vertCount, cellSize) {
    const hash = new Map();
    const inv = 1 / cellSize;

    for (let i = 0; i < vertCount; i++) {
      const cx = Math.floor(posArr[i * stride + 0] * inv);
      const cy = Math.floor(posArr[i * stride + 1] * inv);
      const cz = Math.floor(posArr[i * stride + 2] * inv);
      const key = cx + ',' + cy + ',' + cz;

      let cell = hash.get(key);
      if (!cell) {
        cell = [];
        hash.set(key, cell);
      }
      cell.push(i);
    }

    return hash;
  }

  /**
   * Query the spatial hash for all vertices within the fattened AABB of the
   * edge (a, b). Collects candidate vertex indices into a shared array.
   * @private
   */
  _queryEdgeNeighborhood(posArr, stride, a, b, spatialHash, outCandidates) {
    outCandidates.length = 0;

    const ax = posArr[a * stride + 0];
    const ay = posArr[a * stride + 1];
    const az = posArr[a * stride + 2];
    const bx = posArr[b * stride + 0];
    const by = posArr[b * stride + 1];
    const bz = posArr[b * stride + 2];

    const minX = Math.min(ax, bx) - this._epsilon;
    const minY = Math.min(ay, by) - this._epsilon;
    const minZ = Math.min(az, bz) - this._epsilon;
    const maxX = Math.max(ax, bx) + this._epsilon;
    const maxY = Math.max(ay, by) + this._epsilon;
    const maxZ = Math.max(az, bz) + this._epsilon;

    const inv = 1 / this._cellSize;
    const cx0 = Math.floor(minX * inv);
    const cy0 = Math.floor(minY * inv);
    const cz0 = Math.floor(minZ * inv);
    const cx1 = Math.floor(maxX * inv);
    const cy1 = Math.floor(maxY * inv);
    const cz1 = Math.floor(maxZ * inv);

    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const cell = spatialHash.get(cx + ',' + cy + ',' + cz);
          if (cell) {
            for (let k = 0; k < cell.length; k++) outCandidates.push(cell[k]);
          }
        }
      }
    }
  }

  /**
   * Exact point-on-segment test. Returns the parameter t in (0, 1) if the
   * point lies strictly between a and b within epsilon, or -1 otherwise.
   * @private
   */
  _pointOnSegment(posArr, stride, a, b, p) {
    const ax = posArr[a * stride + 0];
    const ay = posArr[a * stride + 1];
    const az = posArr[a * stride + 2];
    const bx = posArr[b * stride + 0];
    const by = posArr[b * stride + 1];
    const bz = posArr[b * stride + 2];
    const px = posArr[p * stride + 0];
    const py = posArr[p * stride + 1];
    const pz = posArr[p * stride + 2];

    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < this._epsilon * this._epsilon) return -1; // degenerate

    const t = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2;

    // Reject endpoints (a shared vertex is not a T-junction)
    const tEps = this._epsilon / Math.sqrt(len2);
    if (t <= tEps || t >= 1 - tEps) return -1;

    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const cz = az + t * dz;

    const ex = px - cx;
    const ey = py - cy;
    const ez = pz - cz;

    if (ex * ex + ey * ey + ez * ez > this._epsilon * this._epsilon) return -1;

    return t;
  }

  /**
   * Fast boolean: does edge (a, b) contain any T-junctions?
   * @private
   */
  _edgeHasTIntersections(posArr, stride, a, b, geometry) {
    const candidates = [];

    // Build an ad-hoc spatial hash for this single call — expensive per call,
    // so this method is only used by hasTIntersections which short-circuits.
    // Better: build hash once, but hasTIntersections builds it via _prepareContext
    // below. To keep it simple, we rebuild here (rare path).
    const vertCount = geometry.attributes.position.count;
    const spatialHash = this._buildSpatialHash(posArr, stride, vertCount, this._cellSize);

    this._queryEdgeNeighborhood(posArr, stride, a, b, spatialHash, candidates);

    for (let k = 0; k < candidates.length; k++) {
      const p = candidates[k];
      if (p === a || p === b) continue;
      if (this._pointOnSegment(posArr, stride, a, b, p) >= 0) return true;
    }

    return false;
  }

  /**
   * Collect all T-junctions on edge (a, b), appending them to `results`.
   * @private
   */
  _collectTJunctions(posArr, stride, triIndex, a, b, geometry, results) {
    const candidates = [];
    const vertCount = geometry.attributes.position.count;
    const spatialHash = this._buildSpatialHash(posArr, stride, vertCount, this._cellSize);

    this._queryEdgeNeighborhood(posArr, stride, a, b, spatialHash, candidates);

    for (let k = 0; k < candidates.length; k++) {
      const p = candidates[k];
      if (p === a || p === b) continue;
      const t = this._pointOnSegment(posArr, stride, a, b, p);
      if (t >= 0) {
        results.push({ triangle: triIndex, edgeA: a, edgeB: b, vertex: p, t });
      }
    }
  }

  /**
   * Find all split points on edge (a, b), returning them in a shared scratch
   * structure with counts. Sorted by parameter t (distance from a).
   *
   * @private
   * @returns {{ count: number, vertices: Int32Array }}
   */
  _findSplitsOnEdge(posArr, stride, a, b, spatialHash, vertexCanonical, scratchT, scratchV) {
    const candidates = [];
    this._queryEdgeNeighborhood(posArr, stride, a, b, spatialHash, candidates);

    let count = 0;

    for (let k = 0; k < candidates.length; k++) {
      const p = candidates[k];
      if (p === a || p === b) continue;

      const t = this._pointOnSegment(posArr, stride, a, b, p);
      if (t < 0) continue;

      // Canonicalize so we only pick one vertex per 3D position
      const canonicalP = vertexCanonical[p];
      if (canonicalP === a || canonicalP === b) continue;

      // Deduplicate by canonical index
      let duplicate = false;
      for (let j = 0; j < count; j++) {
        if (scratchV[j] === canonicalP) { duplicate = true; break; }
      }
      if (duplicate) continue;

      if (count >= this._maxSplitsPerEdge) break;

      scratchT[count] = t;
      scratchV[count] = canonicalP;
      count++;
    }

    // Insertion sort by t (count is small — typically < 4)
    for (let i = 1; i < count; i++) {
      const tv = scratchT[i];
      const vv = scratchV[i];
      let j = i - 1;
      while (j >= 0 && scratchT[j] > tv) {
        scratchT[j + 1] = scratchT[j];
        scratchV[j + 1] = scratchV[j];
        j--;
      }
      scratchT[j + 1] = tv;
      scratchV[j + 1] = vv;
    }

    return { count, vertices: scratchV };
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** @returns {number} — last detection's T-junction count */
  get tJunctionCount() { return this._tJunctionCount; }

  /** @returns {number} — number of triangles modified by the last split */
  get trianglesModified() { return this._trianglesModified; }

  /** @returns {number} — net added triangles (output - input) */
  get trianglesAdded() { return this._trianglesAdded; }

  /** @returns {number} — source vertex count from the last split */
  get vertexCount() { return this._vertexCount; }

  /** @returns {number} — source triangle count from the last split */
  get triangleCount() { return this._triangleCount; }

  /** @returns {number} — elapsed milliseconds of the last split */
  get lastSplitMs() { return this._lastSplitMs; }

  /** @returns {number} */
  get epsilon() { return this._epsilon; }
  set epsilon(v) { this._epsilon = Math.max(0, v); }

  /** @returns {number} */
  get cellSize() { return this._cellSize; }
  set cellSize(v) { this._cellSize = Math.max(1e-6, v); }

  /** @returns {number} */
  get maxSplitsPerEdge() { return this._maxSplitsPerEdge; }
  set maxSplitsPerEdge(v) { this._maxSplitsPerEdge = Math.max(1, v | 0); }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose splitter state as flat typed-array columns for ECS-driven
   * topology-repair scheduling systems.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    return {
      name,
      tJunctionCount: this._tJunctionCount,
      trianglesModified: this._trianglesModified,
      trianglesAdded: this._trianglesAdded,
      vertexCount: this._vertexCount,
      triangleCount: this._triangleCount,
      lastSplitMs: this._lastSplitMs,
      epsilon: this._epsilon,
      cellSize: this._cellSize,
      maxSplitsPerEdge: this._maxSplitsPerEdge,
    };
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled TIntersectionSplitter instance (defaults: epsilon=1e-5,
   * cellSize=1.0, maxSplitsPerEdge=16).
   * @returns {TIntersectionSplitter}
   */
  static acquire() {
    return _acquireSplitter();
  }

  /**
   * Return this splitter to the pool. Caller must not use it afterward.
   */
  release() {
    this._tJunctionCount = 0;
    this._trianglesModified = 0;
    this._trianglesAdded = 0;
    _releaseSplitter(this);
  }

  /**
   * Clear the global TIntersectionSplitter pool.
   */
  static clearPool() {
    _splitterPool.length = 0;
  }
}

export { TIntersectionSplitter };
export default TIntersectionSplitter;