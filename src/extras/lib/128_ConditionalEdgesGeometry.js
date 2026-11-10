// file number : 128
// full path name : src/extras/lib/128_ConditionalEdgesGeometry.js
// description : Conditional edge geometry generator rewritten as a pure ES module with zero CDN imports. Faithfully reproduces gkjohnson's original algorithm (control point selection from adjacent triangle's third vertex, face-normal dot-product threshold) but replaces the string-keyed edge hash with an integer-keyed Map and precomputes per-triangle normals once (3× fewer normal computations than the original). Uses flat typed arrays for edge records, two-pass exact sizing for output attributes, pooled instances via acquire()/release(), and a BitECS SoA bridge for ECS-driven edge toggling. Uses the project's BufferGeometry (097), BufferAttribute (094), Vec3 (006), Common (003), and Constants (002) modules. Designed for 10k+ meshes on Android 64-bit with zero CDN dependencies.
// best for : Conditional line rendering on every 3D mesh, LDraw-style model outlines, anime-style edge lines, CAD wireframe overlays, smooth-surface silhouette extraction, and any ECS-driven living-world pipeline that toggles conditional edges per mesh at 10k+ entity scale on Android 64-bit.
// license : MIT — algorithm ported from gkjohnson/threejs-sandbox (conditional-lines)

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
// Static pool for ConditionalEdgesGeometry instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle conditional edges at runtime.
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
    g._thresholdDot = 0.01;
    return g;
  }
  return new ConditionalEdgesGeometry();
}

function _releaseGeometry(g) {
  if (_geometryPool.length < 64) _geometryPool.push(g);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _va = new Float32Array(3);
const _vb = new Float32Array(3);
const _vc = new Float32Array(3);
const _e1 = new Float32Array(3);
const _e2 = new Float32Array(3);
const _n  = new Float32Array(3);

// ---------------------------------------------------------------------------
// ConditionalEdgesGeometry — mirrors gkjohnson's ConditionalEdgesGeometry.
//
// Algorithm (identical to the reference implementation):
//   1. Enumerate every triangle's three edges.
//   2. For each edge (a, b), store the triangle's third vertex as control0.
//   3. When the reverse edge (b, a) is later encountered, fill in control1
//      from the second triangle and mark both triangles as adjacent.
//   4. For each fully-adjacent edge, compute the dot product of the two
//      face normals. If dot < thresholdDot (hard edge), skip — the edge is
//      expected to be drawn by a separate EdgesGeometry pass.
//   5. Emit two vertices per surviving edge, each carrying:
//         position   = (edge endpoint)
//         direction  = control0 - control1 (edge axis for the conditional test)
//         control0   = first triangle's third vertex
//         control1   = second triangle's third vertex
//
// The accompanying 127_ConditionalEdgesShader.js collapses the segment in
// clip space when the two controls lie on opposite sides of the edge.
// ---------------------------------------------------------------------------
class ConditionalEdgesGeometry extends BufferGeometry {
  /**
   * @param {BufferGeometry} [geometry] — source geometry to extract edges from
   * @param {number} [thresholdDot=0.01] — dot-product threshold; edges with
   *   normal dot >= this value are treated as smooth and emitted. Default
   *   matches the reference implementation (0.01 ≈ 89.4° crease angle).
   */
  constructor(geometry, thresholdDot = 0.01) {
    super();

    this.isConditionalEdgesGeometry = true;
    this.type = 'ConditionalEdgesGeometry';

    this._edgeCount = 0;
    this._thresholdDot = thresholdDot;

    if (geometry) {
      this.fromGeometry(geometry, thresholdDot);
    }
  }

  /**
   * Rebuild this geometry from a source BufferGeometry.
   *
   * @param {BufferGeometry} geometry — source geometry
   * @param {number} [thresholdDot=this._thresholdDot]
   * @returns {this}
   */
  fromGeometry(geometry, thresholdDot = this._thresholdDot) {
    if (!geometry || !geometry.attributes || !geometry.attributes.position) {
      throw new Error('ConditionalEdgesGeometry.fromGeometry: source geometry has no position attribute.');
    }

    // Clear any previous attributes
    for (const key in this.attributes) delete this.attributes[key];
    this.index = null;
    this.groups.length = 0;

    this._thresholdDot = thresholdDot;

    const position = geometry.attributes.position;
    const posArr = position.array;
    const stride = position.itemSize || 3;
    const vertexCount = position.count;

    // ---------------------------------------------------------------------
    // 1. Build a flat index array (Uint32) for indexed or non-indexed input.
    // ---------------------------------------------------------------------
    let idx;
    let numTris;
    if (geometry.index) {
      idx = geometry.index.array;
      numTris = geometry.index.count / 3;
    } else {
      idx = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) idx[i] = i;
      numTris = vertexCount / 3;
    }

    if (numTris === 0) {
      this._edgeCount = 0;
      return this;
    }

    // ---------------------------------------------------------------------
    // 2. Precompute per-triangle normals once (the reference recomputes each
    //    triangle's normal up to 3× — once per incident edge).
    // ---------------------------------------------------------------------
    const triNormals = new Float32Array(numTris * 3);

    for (let t = 0; t < numTris; t++) {
      const i0 = idx[t * 3 + 0];
      const i1 = idx[t * 3 + 1];
      const i2 = idx[t * 3 + 2];

      const ax = posArr[i0 * stride + 0];
      const ay = posArr[i0 * stride + 1];
      const az = posArr[i0 * stride + 2];
      const bx = posArr[i1 * stride + 0];
      const by = posArr[i1 * stride + 1];
      const bz = posArr[i1 * stride + 2];
      const cx = posArr[i2 * stride + 0];
      const cy = posArr[i2 * stride + 1];
      const cz = posArr[i2 * stride + 2];

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len; ny /= len; nz /= len;

      triNormals[t * 3 + 0] = nx;
      triNormals[t * 3 + 1] = ny;
      triNormals[t * 3 + 2] = nz;
    }

    // ---------------------------------------------------------------------
    // 3. Build the edge adjacency map using an integer-keyed Map (no string
    //    concatenation). Key = min(a,b) * vertexCount + max(a,b) — safe for
    //    up to ~67M vertices per mesh (2^26).
    // ---------------------------------------------------------------------
    const edgeMap = new Map();

    let edgeCap = Math.min(numTris * 3, 1024);
    let recIndex0 = new Int32Array(edgeCap);
    let recIndex1 = new Int32Array(edgeCap);
    let recCtrl0  = new Int32Array(edgeCap);
    let recCtrl1  = new Int32Array(edgeCap);
    let recTri0   = new Int32Array(edgeCap);
    let recTri1   = new Int32Array(edgeCap);
    let edgeCount = 0;

    const grow = () => {
      edgeCap *= 2;
      const a = new Int32Array(edgeCap); a.set(recIndex0); recIndex0 = a;
      const b = new Int32Array(edgeCap); b.set(recIndex1); recIndex1 = b;
      const c = new Int32Array(edgeCap); c.set(recCtrl0);  recCtrl0  = c;
      const d = new Int32Array(edgeCap); d.set(recCtrl1);  recCtrl1  = d;
      const e = new Int32Array(edgeCap); e.set(recTri0);   recTri0   = e;
      const f = new Int32Array(edgeCap); f.set(recTri1);   recTri1   = f;
    };

    for (let t = 0; t < numTris; t++) {
      const i0 = idx[t * 3 + 0];
      const i1 = idx[t * 3 + 1];
      const i2 = idx[t * 3 + 2];

      for (let j = 0; j < 3; j++) {
        const a = j === 0 ? i0 : j === 1 ? i1 : i2;
        const b = j === 0 ? i1 : j === 1 ? i2 : i0;
        const ctrl = j === 0 ? i2 : j === 1 ? i0 : i1;

        const minAB = a < b ? a : b;
        const maxAB = a < b ? b : a;
        const key = minAB * vertexCount + maxAB;

        const existing = edgeMap.get(key);
        if (existing !== undefined) {
          // Reverse edge seen — fill tri1/ctrl1 (matches reference behaviour).
          recCtrl1[existing] = ctrl;
          recTri1[existing] = t;
        } else {
          if (edgeCount >= edgeCap) grow();
          recIndex0[edgeCount] = a;
          recIndex1[edgeCount] = b;
          recCtrl0[edgeCount] = ctrl;
          recCtrl1[edgeCount] = -1;
          recTri0[edgeCount] = t;
          recTri1[edgeCount] = -1;
          edgeMap.set(key, edgeCount);
          edgeCount++;
        }
      }
    }

    // ---------------------------------------------------------------------
    // 4. First pass: count edges that survive the dot-product threshold.
    // ---------------------------------------------------------------------
    const validIndices = new Int32Array(edgeCount);
    let validCount = 0;

    for (let e = 0; e < edgeCount; e++) {
      if (recTri1[e] === -1) continue; // no adjacent triangle

      const t0 = recTri0[e];
      const t1 = recTri1[e];
      const dot =
        triNormals[t0 * 3 + 0] * triNormals[t1 * 3 + 0] +
        triNormals[t0 * 3 + 1] * triNormals[t1 * 3 + 1] +
        triNormals[t0 * 3 + 2] * triNormals[t1 * 3 + 2];

      // Hard edges (dot < thresholdDot) are handled by a separate EdgesGeometry.
      if (dot < thresholdDot) continue;

      validIndices[validCount++] = e;
    }

    // ---------------------------------------------------------------------
    // 5. Allocate exact output buffers (2 vertices per surviving edge).
    // ---------------------------------------------------------------------
    const outVertexCount = validCount * 2;
    const outPosition = new Float32Array(outVertexCount * 3);
    const outDirection = new Float32Array(outVertexCount * 3);
    const outControl0 = new Float32Array(outVertexCount * 3);
    const outControl1 = new Float32Array(outVertexCount * 3);

    // ---------------------------------------------------------------------
    // 6. Second pass: fill the output buffers.
    // ---------------------------------------------------------------------
    let o = 0;

    for (let k = 0; k < validCount; k++) {
      const e = validIndices[k];
      const i0 = recIndex0[e];
      const i1 = recIndex1[e];
      const c0 = recCtrl0[e];
      const c1 = recCtrl1[e];

      const p0x = posArr[i0 * stride + 0];
      const p0y = posArr[i0 * stride + 1];
      const p0z = posArr[i0 * stride + 2];
      const p1x = posArr[i1 * stride + 0];
      const p1y = posArr[i1 * stride + 1];
      const p1z = posArr[i1 * stride + 2];
      const c0x = posArr[c0 * stride + 0];
      const c0y = posArr[c0 * stride + 1];
      const c0z = posArr[c0 * stride + 2];
      const c1x = posArr[c1 * stride + 0];
      const c1y = posArr[c1 * stride + 1];
      const c1z = posArr[c1 * stride + 2];

      // Direction: p0 - p1 (matches reference `vec2.subVectors(vec0, vec1)`)
      const dx = p0x - p1x;
      const dy = p0y - p1y;
      const dz = p0z - p1z;

      // Vertex A (p0)
      outPosition[o + 0] = p0x;
      outPosition[o + 1] = p0y;
      outPosition[o + 2] = p0z;
      outDirection[o + 0] = dx;
      outDirection[o + 1] = dy;
      outDirection[o + 2] = dz;
      outControl0[o + 0] = c0x;
      outControl0[o + 1] = c0y;
      outControl0[o + 2] = c0z;
      outControl1[o + 0] = c1x;
      outControl1[o + 1] = c1y;
      outControl1[o + 2] = c1z;
      o += 3;

      // Vertex B (p1)
      outPosition[o + 0] = p1x;
      outPosition[o + 1] = p1y;
      outPosition[o + 2] = p1z;
      outDirection[o + 0] = dx;
      outDirection[o + 1] = dy;
      outDirection[o + 2] = dz;
      outControl0[o + 0] = c0x;
      outControl0[o + 1] = c0y;
      outControl0[o + 2] = c0z;
      outControl1[o + 0] = c1x;
      outControl1[o + 1] = c1y;
      outControl1[o + 2] = c1z;
      o += 3;
    }

    // ---------------------------------------------------------------------
    // 7. Attach the four required attributes.
    // ---------------------------------------------------------------------
    this.setAttribute('position', new BufferAttribute(outPosition, 3, false));
    this.setAttribute('direction', new BufferAttribute(outDirection, 3, false));
    this.setAttribute('control0', new BufferAttribute(outControl0, 3, false));
    this.setAttribute('control1', new BufferAttribute(outControl1, 3, false));

    this._edgeCount = validCount;
    this.needsUpdate = true;

    return this;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** @returns {number} — number of surviving conditional edges */
  get edgeCount() {
    return this._edgeCount;
  }

  /** @returns {number} — dot-product threshold used by the last fromGeometry() */
  get thresholdDot() {
    return this._thresholdDot;
  }

  /**
   * Set the threshold from an angle in degrees. Edges whose adjacent
   * face normals are more than this angle apart are treated as hard edges.
   * @param {number} degrees
   * @returns {this}
   */
  setThresholdAngle(degrees) {
    this._thresholdDot = Math.cos(Common.clamp(degrees, 0, 180) * Math.PI / 180);
    return this;
  }

  /**
   * Get the threshold as an angle in degrees.
   * @returns {number}
   */
  getThresholdAngle() {
    return Math.acos(Common.clamp(this._thresholdDot, -1, 1)) * 180 / Math.PI;
  }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose the generated attributes as flat typed-array columns for use by
   * ECS systems that drive per-mesh edge toggling or LOD selection.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const posAttr = this.attributes.position;
    const dirAttr = this.attributes.direction;
    const c0Attr = this.attributes.control0;
    const c1Attr = this.attributes.control1;

    return {
      name,
      edgeCount: this._edgeCount,
      vertexCount: posAttr ? posAttr.count : 0,
      position: posAttr ? posAttr.array : null,
      direction: dirAttr ? dirAttr.array : null,
      control0: c0Attr ? c0Attr.array : null,
      control1: c1Attr ? c1Attr.array : null,
    };
  }

  // -----------------------------------------------------------------------
  // Disposal
  // -----------------------------------------------------------------------

  dispose() {
    super.dispose();
    this._edgeCount = 0;
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled ConditionalEdgesGeometry instance (empty, threshold 0.01).
   * @returns {ConditionalEdgesGeometry}
   */
  static acquire() {
    return _acquireGeometry();
  }

  /**
   * Return this ConditionalEdgesGeometry to the pool. Caller must not use it
   * afterward.
   */
  release() {
    for (const key in this.attributes) delete this.attributes[key];
    this._edgeCount = 0;
    _releaseGeometry(this);
  }

  /**
   * Clear the global ConditionalEdgesGeometry pool.
   */
  static clearPool() {
    _geometryPool.length = 0;
  }
}

export { ConditionalEdgesGeometry };
export default ConditionalEdgesGeometry;