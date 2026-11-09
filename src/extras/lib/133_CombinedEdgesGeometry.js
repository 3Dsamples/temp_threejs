// file number : 133
// full path name : src/extras/lib/133_CombinedEdgesGeometry.js
// description : Combined edges geometry that emits BOTH hard-crease edges and smooth conditional edges in a SINGLE triangle walk, tagging every emitted vertex with an edgeType attribute (0 = smooth conditional, 1 = hard crease, 2 = silhouette). Halves per-mesh geometry-generation cost versus running ConditionalEdgesGeometry (128) and EdgesGeometry separately, because it walks the triangle list only once and classifies all interior/silhouette edges in the same edge map. For hard and silhouette edges, control0 and control1 are both set to the edge's end vertex — this makes the conditional test in the canonical shader (127) evaluate to sign(d0) === sign(d1), so those segments are always drawn unconditionally. For smooth edges, the proper third vertices of each adjacent triangle are used, preserving the LDraw-style hidden-edge removal. Uses the project's BufferGeometry (097), BufferAttribute (094), Vec3 (006), Common (003), and Constants (002) modules with flat typed-array edge records, two-pass exact sizing, pooled instances via acquire()/release(), and a BitECS SoA bridge. Designed for 10k+ meshes on Android 64-bit with zero CDN dependencies.
// best for : Unified hard + smooth edge rendering on every 3D mesh, LDraw-style model outlines that also need visible hard creases (LEGO studs, mechanical panels), anime-style edge lines with mixed smooth/hard shading, CAD wireframe overlays, and any ECS-driven living-world pipeline that toggles combined edges per mesh at 10k+ entity scale on Android 64-bit.
// license : MIT — algorithm based on gkjohnson/threejs-sandbox (conditional-lines)

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
// Edge type constants — exported so materials (135, 136, 140, 141, 142) can
// branch on per-vertex type in the shader without magic numbers.
// ---------------------------------------------------------------------------
const EdgeType = {
  SMOOTH: 0,       // interior shared edge with dot >= thresholdDot — conditional
  HARD: 1,         // interior shared edge with dot <  thresholdDot — always drawn
  SILHOUETTE: 2,   // unshared (boundary) edge — always drawn
};

// ---------------------------------------------------------------------------
// Static pool for CombinedEdgesGeometry instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle combined edges at runtime.
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
    g._smoothCount = 0;
    g._hardCount = 0;
    g._silhouetteCount = 0;
    g._thresholdDot = 0.01;
    return g;
  }
  return new CombinedEdgesGeometry();
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

// ---------------------------------------------------------------------------
// CombinedEdgesGeometry — emits hard + smooth + silhouette edges in one pass.
//
// Algorithm outline (matches 128's triangle walk, extended with classification):
//   1. Single triangle walk — compute each triangle's face normal AND build
//      the edge adjacency map simultaneously (no second triangle loop).
//   2. Classify each unique edge:
//        recTri1 === -1                → SILHOUETTE (edge type 2)
//        dot(n0, n1) >= thresholdDot   → SMOOTH     (edge type 0)
//        dot(n0, n1) <  thresholdDot   → HARD       (edge type 1)
//   3. Emit two vertices per classified edge (2 per surviving edge):
//        position   = (p0 or p1)
//        direction  = p0 - p1 (same for both vertices, matching 128 / 127)
//        control0   = SMOOTH → third vertex of tri0
//                     HARD / SILHOUETTE → p1 (edge end)
//        control1   = SMOOTH → third vertex of tri1
//                     HARD / SILHOUETTE → p1 (edge end)
//        edgeType   = EdgeType constant above (same for both vertices)
//
// Setting control0 = control1 = p1 for HARD and SILHOUETTE forces
// sign(d0) === sign(d1) in the canonical shader (127), so those edges are
// drawn unconditionally — matching what a separate EdgesGeometry pass would
// have produced, but without the extra triangle walk.
// ---------------------------------------------------------------------------
class CombinedEdgesGeometry extends BufferGeometry {
  /**
   * @param {BufferGeometry} [geometry] — source geometry to extract edges from
   * @param {number} [thresholdDot=0.01] — dot-product threshold; interior
   *   edges with normal dot >= thresholdDot are treated as smooth. The
   *   default 0.01 corresponds to a crease angle of ~89.4°, matching 128.
   */
  constructor(geometry, thresholdDot = 0.01) {
    super();

    this.isCombinedEdgesGeometry = true;
    this.type = 'CombinedEdgesGeometry';

    this._smoothCount = 0;
    this._hardCount = 0;
    this._silhouetteCount = 0;
    this._thresholdDot = thresholdDot;

    if (geometry) {
      this.fromGeometry(geometry, thresholdDot);
    }
  }

  /**
   * Rebuild this geometry from a source BufferGeometry, emitting smooth,
   * hard, and silhouette edges in one pass.
   *
   * @param {BufferGeometry} geometry — source geometry
   * @param {number} [thresholdDot=this._thresholdDot]
   * @returns {this}
   */
  fromGeometry(geometry, thresholdDot = this._thresholdDot) {
    if (!geometry || !geometry.attributes || !geometry.attributes.position) {
      throw new Error('CombinedEdgesGeometry.fromGeometry: source geometry has no position attribute.');
    }

    // Clear previous output
    for (const key in this.attributes) delete this.attributes[key];
    this.index = null;
    this.groups.length = 0;

    this._thresholdDot = thresholdDot;
    this._smoothCount = 0;
    this._hardCount = 0;
    this._silhouetteCount = 0;

    const position = geometry.attributes.position;
    const posArr = position.array;
    const stride = position.itemSize || 3;
    const vertexCount = position.count;

    // ---------------------------------------------------------------------
    // 1. Build the flat index array (indexed or non-indexed input).
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
      this.setAttribute('position', new BufferAttribute(new Float32Array(0), 3, false));
      this.setAttribute('direction', new BufferAttribute(new Float32Array(0), 3, false));
      this.setAttribute('control0', new BufferAttribute(new Float32Array(0), 3, false));
      this.setAttribute('control1', new BufferAttribute(new Float32Array(0), 3, false));
      this.setAttribute('edgeType', new BufferAttribute(new Float32Array(0), 1, false));
      this.needsUpdate = true;
      return this;
    }

    // ---------------------------------------------------------------------
    // 2. Single triangle walk — compute normals AND build edge map together.
    // ---------------------------------------------------------------------
    const triNormals = new Float32Array(numTris * 3);
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

      // --- Compute face normal (skip degenerate triangles) ---------------
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
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nlen > 1e-12) {
        nx /= nlen; ny /= nlen; nz /= nlen;
      } else {
        // Degenerate — zero normal; downstream dot will be 0 (treated as hard)
        nx = ny = nz = 0;
      }
      triNormals[t * 3 + 0] = nx;
      triNormals[t * 3 + 1] = ny;
      triNormals[t * 3 + 2] = nz;

      // --- Add the triangle's 3 edges to the map -------------------------
      for (let j = 0; j < 3; j++) {
        const a = j === 0 ? i0 : j === 1 ? i1 : i2;
        const b = j === 0 ? i1 : j === 1 ? i2 : i0;
        const ctrl = j === 0 ? i2 : j === 1 ? i0 : i1;

        if (a === b) continue; // skip degenerate self-edge

        const minAB = a < b ? a : b;
        const maxAB = a < b ? b : a;
        const key = minAB * vertexCount + maxAB;

        const existing = edgeMap.get(key);
        if (existing !== undefined) {
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
    // 3. Classify each edge — count totals for exact output sizing.
    // ---------------------------------------------------------------------
    const classArr = new Uint8Array(edgeCount);
    const validArr = new Int32Array(edgeCount);
    let validCount = 0;

    for (let e = 0; e < edgeCount; e++) {
      const t1 = recTri1[e];
      let cls;

      if (t1 === -1) {
        cls = EdgeType.SILHOUETTE;
        this._silhouetteCount++;
      } else {
        const t0 = recTri0[e];
        const dot =
          triNormals[t0 * 3 + 0] * triNormals[t1 * 3 + 0] +
          triNormals[t0 * 3 + 1] * triNormals[t1 * 3 + 1] +
          triNormals[t0 * 3 + 2] * triNormals[t1 * 3 + 2];

        if (dot < thresholdDot) {
          cls = EdgeType.HARD;
          this._hardCount++;
        } else {
          cls = EdgeType.SMOOTH;
          this._smoothCount++;
        }
      }

      classArr[e] = cls;
      validArr[validCount++] = e;
    }

    // ---------------------------------------------------------------------
    // 4. Allocate exact output buffers (2 vertices per valid edge).
    // ---------------------------------------------------------------------
    const outVertexCount = validCount * 2;
    const outPosition = new Float32Array(outVertexCount * 3);
    const outDirection = new Float32Array(outVertexCount * 3);
    const outControl0 = new Float32Array(outVertexCount * 3);
    const outControl1 = new Float32Array(outVertexCount * 3);
    const outEdgeType = new Float32Array(outVertexCount);

    // ---------------------------------------------------------------------
    // 5. Emit — two vertices per edge with per-vertex edgeType tag.
    // ---------------------------------------------------------------------
    let o = 0;
    let oi = 0;

    for (let k = 0; k < validCount; k++) {
      const e = validArr[k];
      const cls = classArr[e];

      const i0 = recIndex0[e];
      const i1 = recIndex1[e];

      const p0x = posArr[i0 * stride + 0];
      const p0y = posArr[i0 * stride + 1];
      const p0z = posArr[i0 * stride + 2];
      const p1x = posArr[i1 * stride + 0];
      const p1y = posArr[i1 * stride + 1];
      const p1z = posArr[i1 * stride + 2];

      // direction = p0 - p1 (identical to 128 / 127)
      const dx = p0x - p1x;
      const dy = p0y - p1y;
      const dz = p0z - p1z;

      let c0x, c0y, c0z, c1x, c1y, c1z;

      if (cls === EdgeType.SMOOTH) {
        const c0i = recCtrl0[e];
        const c1i = recCtrl1[e];
        c0x = posArr[c0i * stride + 0];
        c0y = posArr[c0i * stride + 1];
        c0z = posArr[c0i * stride + 2];
        c1x = posArr[c1i * stride + 0];
        c1y = posArr[c1i * stride + 1];
        c1z = posArr[c1i * stride + 2];
      } else {
        // HARD or SILHOUETTE — set both controls to the end vertex so the
        // conditional test in 127 evaluates to sign(d0) === sign(d1) and the
        // segment is drawn unconditionally.
        c0x = c1x = p1x;
        c0y = c1y = p1y;
        c0z = c1z = p1z;
      }

      // --- Vertex A (p0) ---
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
      outEdgeType[oi] = cls;
      o += 3;
      oi += 1;

      // --- Vertex B (p1) ---
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
      outEdgeType[oi] = cls;
      o += 3;
      oi += 1;
    }

    // ---------------------------------------------------------------------
    // 6. Attach attributes.
    // ---------------------------------------------------------------------
    this.setAttribute('position', new BufferAttribute(outPosition, 3, false));
    this.setAttribute('direction', new BufferAttribute(outDirection, 3, false));
    this.setAttribute('control0', new BufferAttribute(outControl0, 3, false));
    this.setAttribute('control1', new BufferAttribute(outControl1, 3, false));
    this.setAttribute('edgeType', new BufferAttribute(outEdgeType, 1, false));

    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** @returns {number} — number of smooth conditional edges */
  get smoothCount() { return this._smoothCount; }

  /** @returns {number} — number of hard crease edges */
  get hardCount() { return this._hardCount; }

  /** @returns {number} — number of silhouette (boundary) edges */
  get silhouetteCount() { return this._silhouetteCount; }

  /** @returns {number} — total number of emitted edges */
  get totalEdgeCount() {
    return this._smoothCount + this._hardCount + this._silhouetteCount;
  }

  /** @returns {number} — dot-product threshold used by the last fromGeometry() */
  get thresholdDot() { return this._thresholdDot; }

  /**
   * Set the threshold from an angle in degrees.
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
   * Expose all attributes plus per-class counts as flat typed-array columns
   * for ECS systems that drive combined-edge toggling or LOD selection.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const posAttr = this.attributes.position;
    const dirAttr = this.attributes.direction;
    const c0Attr = this.attributes.control0;
    const c1Attr = this.attributes.control1;
    const typeAttr = this.attributes.edgeType;

    return {
      name,
      smoothCount: this._smoothCount,
      hardCount: this._hardCount,
      silhouetteCount: this._silhouetteCount,
      totalEdgeCount: this.totalEdgeCount,
      vertexCount: posAttr ? posAttr.count : 0,
      position: posAttr ? posAttr.array : null,
      direction: dirAttr ? dirAttr.array : null,
      control0: c0Attr ? c0Attr.array : null,
      control1: c1Attr ? c1Attr.array : null,
      edgeType: typeAttr ? typeAttr.array : null,
    };
  }

  // -----------------------------------------------------------------------
  // Disposal
  // -----------------------------------------------------------------------

  dispose() {
    super.dispose();
    this._smoothCount = 0;
    this._hardCount = 0;
    this._silhouetteCount = 0;
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled CombinedEdgesGeometry instance (empty, threshold 0.01).
   * @returns {CombinedEdgesGeometry}
   */
  static acquire() {
    return _acquireGeometry();
  }

  /**
   * Return this CombinedEdgesGeometry to the pool. Caller must not use it
   * afterward.
   */
  release() {
    for (const key in this.attributes) delete this.attributes[key];
    this._smoothCount = 0;
    this._hardCount = 0;
    this._silhouetteCount = 0;
    _releaseGeometry(this);
  }

  /**
   * Clear the global CombinedEdgesGeometry pool.
   */
  static clearPool() {
    _geometryPool.length = 0;
  }
}

export { CombinedEdgesGeometry, EdgeType };
export default CombinedEdgesGeometry;