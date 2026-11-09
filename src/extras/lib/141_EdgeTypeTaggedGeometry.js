// file number : 141
// full path name : src/extras/lib/141_EdgeTypeTaggedGeometry.js
// description : Edge-type tagged geometry that normalises the outputs of ConditionalEdgesGeometry (128), OutsideEdgesGeometry (129), CombinedEdgesGeometry (133), TriangleIntersectionEdgesGeometry (134), and GPUConditionalEdges (137) into a single unified buffer where every vertex carries an explicit edgeType attribute — 0 for smooth interior edges, 1 for hard crease edges, 2 for silhouette edges. This is the geometry-side counterpart to VertexColorLineMaterial (140) and the pairing target for materials that apply different colours and widths per edge type — the classic thick-outer-contour / thin-inner-crease anime look. Two tagging modes: (a) ingest a source that already carries edgeType (133, 134) — pure pass-through with optional remapping, (b) ingest a source without edgeType (128, 129) — infer the type from a supplied classification map or default to a per-source default. Exposes re-tag from multiple sources in one call, per-type sub-range extraction so a material can render hard edges in one pass and smooth edges in another, pooled instances via acquire()/release(), and a BitECS SoA bridge exposing per-type vertex counts and the full edgeType array. Uses the project's BufferGeometry (097), BufferAttribute (094), Vec3 (006), Common (003), and Constants (002) modules. Designed for 10k+ conditional edge meshes on Android 64-bit where per-type draw-call separation enables the classic anime thick-outer/thin-inner line hierarchy.
// best for : Anime-flat conditional line rendering with per-type line hierarchy, silhouette-vs-interior line separation, CAD wireframe overlays where hard creases deserve thicker strokes than smooth fillets, LOD pipelines that toggle only silhouette edges at distance, multi-pass conditional line rendering where each edge type uses a distinct material, and any ECS-driven living-world pipeline that needs per-edge-type draw-call control at 10k+ entity scale on Android 64-bit.
// license : MIT — architecture ported from gkjohnson/threejs-sandbox (conditional-lines)

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
// Edge type constants — identical values to EdgeType from CombinedEdgesGeometry
// (133), so tagged geometries from either source are drop-in interchangeable.
// ---------------------------------------------------------------------------
const EdgeTypeTagged = {
  SMOOTH: 0,       // interior shared edge with dot >= thresholdDot — conditional
  HARD: 1,         // interior shared edge with dot <  thresholdDot — always drawn
  SILHOUETTE: 2,   // unshared (boundary) edge — always drawn
};

// ---------------------------------------------------------------------------
// Static pool for EdgeTypeTaggedGeometry instances — recycled to eliminate
// per-mesh allocation churn when 10k+ meshes toggle per-type line separation
// at runtime.
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
    g._sourceCount = 0;
    return g;
  }
  return new EdgeTypeTaggedGeometry();
}

function _releaseGeometry(g) {
  if (_geometryPool.length < 64) _geometryPool.push(g);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v3 = new Float32Array(3);

// ---------------------------------------------------------------------------
// EdgeTypeTaggedGeometry — normalises edge sources into a unified tagged
// buffer.
//
// Supported sources:
//   – CombinedEdgesGeometry (133)         → has edgeType (0/1/2), direct pass
//   – TriangleIntersectionEdgesGeometry (134) → has edgeType (=1 HARD), direct pass
//   – ConditionalEdgesGeometry (128)      → no edgeType, defaults to SMOOTH
//   – OutsideEdgesGeometry (129)          → no edgeType, defaults to SILHOUETTE
//   – GPUConditionalEdges (137)           → has edgeType (0/1/2), direct pass
//
// Usage:
//   tagged.addSource(combined133);            // pass-through, edgeType preserved
//   tagged.addSource(outside129);             // classified as SILHOUETTE
//   tagged.addSource(conditional128);         // classified as SMOOTH
//   tagged.addSource(intersection134);        // classified as HARD
//   tagged.finalize();
//
// Or single-source convenience:
//   tagged.fromSource(combined133);
//
// After finalize() you can call extractByType(EdgeTypeTagged.HARD) to get a
// sub-geometry containing only hard edges — useful for rendering hard creases
// with a different material than smooth interior edges.
// ---------------------------------------------------------------------------
class EdgeTypeTaggedGeometry extends BufferGeometry {
  constructor() {
    super();

    this.isEdgeTypeTaggedGeometry = true;
    this.type = 'EdgeTypeTaggedGeometry';

    // Accumulator — populated by addSource(), consumed by finalize()
    this._sources = [];
    this._sourceCount = 0;

    // Per-type counters (populated by finalize())
    this._smoothCount = 0;
    this._hardCount = 0;
    this._silhouetteCount = 0;
  }

  // -----------------------------------------------------------------------
  // Source accumulation
  // -----------------------------------------------------------------------

  /**
   * Add an edge geometry source to this tagged buffer.
   *
   * @param {object} source — any of 128, 129, 133, 134, 137 (or compatible)
   * @param {object} [options={}]
   * @param {number} [options.defaultType] — edge type to apply to vertices that
   *   lack an edgeType attribute. If omitted, defaults to SILHOUETTE for
   *   OutsideEdgesGeometry (129), HARD for TriangleIntersectionEdgesGeometry
   *   (134), and SMOOTH for ConditionalEdgesGeometry (128).
   * @param {Float32Array} [options.matrix] — optional 4×4 world matrix applied
   *   to positions, control0, control1, and direction
   * @param {number} [options.minType=SMOOTH] — inclusive lower bound on the
   *   edge types to include (used with maxType to skip ranges)
   * @param {number} [options.maxType=SILHOUETTE] — inclusive upper bound
   * @returns {this}
   */
  addSource(source, options = {}) {
    if (!source || !source.attributes || !source.attributes.position) {
      throw new Error('EdgeTypeTaggedGeometry.addSource: source geometry has no position attribute.');
    }

    this._sources.push({ source, options });
    return this;
  }

  /**
   * Clear all accumulated sources. Call before adding new sources to
   * rebuild from scratch.
   * @returns {this}
   */
  clearSources() {
    this._sources.length = 0;
    this._sourceCount = 0;
    return this;
  }

  /**
   * Clear everything — sources AND output attributes.
   * @returns {this}
   */
  clear() {
    this.clearSources();
    for (const key in this.attributes) delete this.attributes[key];
    this.index = null;
    this.groups.length = 0;
    this._smoothCount = 0;
    this._hardCount = 0;
    this._silhouetteCount = 0;
    return this;
  }

  // -----------------------------------------------------------------------
  // Single-source convenience
  // -----------------------------------------------------------------------

  /**
   * Rebuild this geometry from a single source. Equivalent to
   * clearSources() + addSource() + finalize().
   *
   * @param {object} source
   * @param {object} [options={}]
   * @returns {this}
   */
  fromSource(source, options = {}) {
    this.clearSources();
    this.addSource(source, options);
    return this.finalize();
  }

  // -----------------------------------------------------------------------
  // finalize — build the unified tagged output
  // -----------------------------------------------------------------------

  /**
   * Flatten all accumulated sources into a single unified tagged geometry.
   * Every output vertex carries edgeType in [0, 2].
   *
   * @returns {this}
   */
  finalize() {
    // Reset output + counters
    for (const key in this.attributes) delete this.attributes[key];
    this.index = null;
    this.groups.length = 0;
    this._smoothCount = 0;
    this._hardCount = 0;
    this._silhouetteCount = 0;

    const sources = this._sources;
    const sourceCount = sources.length;

    if (sourceCount === 0) {
      this._emitEmpty();
      this._sourceCount = 0;
      return this;
    }

    // -------------------------------------------------------------------
    // 1. First pass: count total vertices and total per-type vertices
    // -------------------------------------------------------------------
    let totalVertices = 0;
    let totalSmooth = 0;
    let totalHard = 0;
    let totalSilhouette = 0;

    for (let s = 0; s < sourceCount; s++) {
      const { source, options } = sources[s];
      const posAttr = source.attributes.position;
      const count = posAttr.count;

      if (count === 0) continue;

      const minType = options.minType !== undefined ? options.minType : EdgeTypeTagged.SMOOTH;
      const maxType = options.maxType !== undefined ? options.maxType : EdgeTypeTagged.SILHOUETTE;
      const typeAttr = source.attributes.edgeType;
      const defaultType = _resolveDefaultType(source, options);

      if (typeAttr) {
        // Already tagged — count by type
        const typeArr = typeAttr.array;
        for (let i = 0; i < count; i++) {
          const t = typeArr[i] | 0;
          if (t < minType || t > maxType) continue;
          totalVertices++;
          if (t === EdgeTypeTagged.SMOOTH) totalSmooth++;
          else if (t === EdgeTypeTagged.HARD) totalHard++;
          else if (t === EdgeTypeTagged.SILHOUETTE) totalSilhouette++;
        }
      } else {
        // Untagged — use default type
        const t = defaultType;
        if (t < minType || t > maxType) continue;
        totalVertices += count;
        if (t === EdgeTypeTagged.SMOOTH) totalSmooth += count;
        else if (t === EdgeTypeTagged.HARD) totalHard += count;
        else if (t === EdgeTypeTagged.SILHOUETTE) totalSilhouette += count;
      }
    }

    if (totalVertices === 0) {
      this._emitEmpty();
      this._sourceCount = sourceCount;
      return this;
    }

    // -------------------------------------------------------------------
    // 2. Allocate unified output buffers
    // -------------------------------------------------------------------
    const outPosition = new Float32Array(totalVertices * 3);
    const outDirection = new Float32Array(totalVertices * 3);
    const outControl0 = new Float32Array(totalVertices * 3);
    const outControl1 = new Float32Array(totalVertices * 3);
    const outEdgeType = new Float32Array(totalVertices);

    let o = 0;
    let vi = 0;

    // -------------------------------------------------------------------
    // 3. Second pass: copy + transform + tag
    // -------------------------------------------------------------------
    for (let s = 0; s < sourceCount; s++) {
      const { source, options } = sources[s];
      const attrs = source.attributes;
      const posAttr = attrs.position;
      const count = posAttr.count;
      if (count === 0) continue;

      const minType = options.minType !== undefined ? options.minType : EdgeTypeTagged.SMOOTH;
      const maxType = options.maxType !== undefined ? options.maxType : EdgeTypeTagged.SILHOUETTE;
      const defaultType = _resolveDefaultType(source, options);

      const posArr = posAttr.array;
      const posStride = posAttr.itemSize || 3;

      const dirAttr = attrs.direction;
      const dirArr = dirAttr ? dirAttr.array : null;
      const dirStride = dirAttr ? (dirAttr.itemSize || 3) : 3;

      const c0Attr = attrs.control0;
      const c0Arr = c0Attr ? c0Attr.array : null;
      const c0Stride = c0Attr ? (c0Attr.itemSize || 3) : 3;

      const c1Attr = attrs.control1;
      const c1Arr = c1Attr ? c1Attr.array : null;
      const c1Stride = c1Attr ? (c1Attr.itemSize || 3) : 3;

      const typeAttr = attrs.edgeType;
      const typeArr = typeAttr ? typeAttr.array : null;

      const m = options.matrix;

      for (let i = 0; i < count; i++) {
        // Determine the edge type for this vertex
        let t;
        if (typeArr) {
          t = typeArr[i] | 0;
        } else {
          t = defaultType;
        }
        if (t < minType || t > maxType) continue;

        // --- Position ---
        const ps = i * posStride;
        if (m) {
          const px = posArr[ps + 0];
          const py = posArr[ps + 1];
          const pz = posArr[ps + 2];
          outPosition[o + 0] = m[0] * px + m[4] * py + m[8] * pz + m[12];
          outPosition[o + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
          outPosition[o + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];
        } else {
          outPosition[o + 0] = posArr[ps + 0];
          outPosition[o + 1] = posArr[ps + 1];
          outPosition[o + 2] = posArr[ps + 2];
        }

        // --- Direction ---
        if (dirArr) {
          const ds = i * dirStride;
          const dx = dirArr[ds + 0];
          const dy = dirArr[ds + 1];
          const dz = dirArr[ds + 2];
          if (m) {
            outDirection[o + 0] = m[0] * dx + m[4] * dy + m[8] * dz;
            outDirection[o + 1] = m[1] * dx + m[5] * dy + m[9] * dz;
            outDirection[o + 2] = m[2] * dx + m[6] * dy + m[10] * dz;
          } else {
            outDirection[o + 0] = dx;
            outDirection[o + 1] = dy;
            outDirection[o + 2] = dz;
          }
        } else {
          outDirection[o + 0] = 0;
          outDirection[o + 1] = 0;
          outDirection[o + 2] = 0;
        }

        // --- Control0 ---
        if (c0Arr) {
          const cs = i * c0Stride;
          const cx = c0Arr[cs + 0];
          const cy = c0Arr[cs + 1];
          const cz = c0Arr[cs + 2];
          if (m) {
            outControl0[o + 0] = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
            outControl0[o + 1] = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
            outControl0[o + 2] = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
          } else {
            outControl0[o + 0] = cx;
            outControl0[o + 1] = cy;
            outControl0[o + 2] = cz;
          }
        } else {
          // Fallback: use the vertex itself (forces the conditional test to
          // always draw — matching the HARD/SILHOUETTE behaviour in 133).
          outControl0[o + 0] = outPosition[o + 0];
          outControl0[o + 1] = outPosition[o + 1];
          outControl0[o + 2] = outPosition[o + 2];
        }

        // --- Control1 ---
        if (c1Arr) {
          const cs = i * c1Stride;
          const cx = c1Arr[cs + 0];
          const cy = c1Arr[cs + 1];
          const cz = c1Arr[cs + 2];
          if (m) {
            outControl1[o + 0] = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
            outControl1[o + 1] = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
            outControl1[o + 2] = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
          } else {
            outControl1[o + 0] = cx;
            outControl1[o + 1] = cy;
            outControl1[o + 2] = cz;
          }
        } else {
          outControl1[o + 0] = outPosition[o + 0];
          outControl1[o + 1] = outPosition[o + 1];
          outControl1[o + 2] = outPosition[o + 2];
        }

        // --- Edge type ---
        outEdgeType[vi] = t;

        o += 3;
        vi++;
      }
    }

    // -------------------------------------------------------------------
    // 4. Attach attributes
    // -------------------------------------------------------------------
    this.setAttribute('position', new BufferAttribute(outPosition, 3, false));
    this.setAttribute('direction', new BufferAttribute(outDirection, 3, false));
    this.setAttribute('control0', new BufferAttribute(outControl0, 3, false));
    this.setAttribute('control1', new BufferAttribute(outControl1, 3, false));
    this.setAttribute('edgeType', new BufferAttribute(outEdgeType, 1, false));

    this._smoothCount = totalSmooth;
    this._hardCount = totalHard;
    this._silhouetteCount = totalSilhouette;
    this._sourceCount = sourceCount;

    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Per-type extraction — split into sub-geometries by edge type
  // -----------------------------------------------------------------------

  /**
   * Extract a sub-geometry containing only vertices of the given edge type.
   * Useful for rendering different edge types with distinct materials.
   *
   * @param {number} type — EdgeTypeTagged.SMOOTH, HARD, or SILHOUETTE
   * @returns {EdgeTypeTaggedGeometry} a new geometry (caller must release)
   */
  extractByType(type) {
    const posAttr = this.attributes.position;
    if (!posAttr) {
      const empty = EdgeTypeTaggedGeometry.acquire();
      empty._emitEmpty();
      return empty;
    }

    const typeAttr = this.attributes.edgeType;
    if (!typeAttr) {
      const empty = EdgeTypeTaggedGeometry.acquire();
      empty._emitEmpty();
      return empty;
    }

    const count = posAttr.count;
    const typeArr = typeAttr.array;

    // Count matching vertices
    let matchCount = 0;
    for (let i = 0; i < count; i++) {
      if ((typeArr[i] | 0) === type) matchCount++;
    }

    if (matchCount === 0) {
      const empty = EdgeTypeTaggedGeometry.acquire();
      empty._emitEmpty();
      return empty;
    }

    // Allocate output
    const outPos = new Float32Array(matchCount * 3);
    const outDir = new Float32Array(matchCount * 3);
    const outC0 = new Float32Array(matchCount * 3);
    const outC1 = new Float32Array(matchCount * 3);
    const outType = new Float32Array(matchCount);

    const posArr = posAttr.array;
    const dirArr = this.attributes.direction ? this.attributes.direction.array : null;
    const c0Arr = this.attributes.control0 ? this.attributes.control0.array : null;
    const c1Arr = this.attributes.control1 ? this.attributes.control1.array : null;

    let o = 0;
    for (let i = 0; i < count; i++) {
      if ((typeArr[i] | 0) !== type) continue;

      outPos[o + 0] = posArr[i * 3 + 0];
      outPos[o + 1] = posArr[i * 3 + 1];
      outPos[o + 2] = posArr[i * 3 + 2];

      if (dirArr) {
        outDir[o + 0] = dirArr[i * 3 + 0];
        outDir[o + 1] = dirArr[i * 3 + 1];
        outDir[o + 2] = dirArr[i * 3 + 2];
      }
      if (c0Arr) {
        outC0[o + 0] = c0Arr[i * 3 + 0];
        outC0[o + 1] = c0Arr[i * 3 + 1];
        outC0[o + 2] = c0Arr[i * 3 + 2];
      }
      if (c1Arr) {
        outC1[o + 0] = c1Arr[i * 3 + 0];
        outC1[o + 1] = c1Arr[i * 3 + 1];
        outC1[o + 2] = c1Arr[i * 3 + 2];
      }

      outType[o / 3] = type;
      o += 3;
    }

    const result = EdgeTypeTaggedGeometry.acquire();
    result.setAttribute('position', new BufferAttribute(outPos, 3, false));
    result.setAttribute('direction', new BufferAttribute(outDir, 3, false));
    result.setAttribute('control0', new BufferAttribute(outC0, 3, false));
    result.setAttribute('control1', new BufferAttribute(outC1, 3, false));
    result.setAttribute('edgeType', new BufferAttribute(outType, 1, false));

    if (type === EdgeTypeTagged.SMOOTH) result._smoothCount = matchCount;
    else if (type === EdgeTypeTagged.HARD) result._hardCount = matchCount;
    else if (type === EdgeTypeTagged.SILHOUETTE) result._silhouetteCount = matchCount;

    result.needsUpdate = true;
    return result;
  }

  /**
   * Emit empty attributes.
   * @private
   */
  _emitEmpty() {
    this.setAttribute('position', new BufferAttribute(new Float32Array(0), 3, false));
    this.setAttribute('direction', new BufferAttribute(new Float32Array(0), 3, false));
    this.setAttribute('control0', new BufferAttribute(new Float32Array(0), 3, false));
    this.setAttribute('control1', new BufferAttribute(new Float32Array(0), 3, false));
    this.setAttribute('edgeType', new BufferAttribute(new Float32Array(0), 1, false));
    this.needsUpdate = true;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** @returns {number} — number of SMOOTH (0) vertices */
  get smoothCount() { return this._smoothCount; }

  /** @returns {number} — number of HARD (1) vertices */
  get hardCount() { return this._hardCount; }

  /** @returns {number} — number of SILHOUETTE (2) vertices */
  get silhouetteCount() { return this._silhouetteCount; }

  /** @returns {number} — total emitted vertices */
  get totalVertexCount() {
    return this._smoothCount + this._hardCount + this._silhouetteCount;
  }

  /** @returns {number} — number of sources folded in */
  get sourceCount() { return this._sourceCount; }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose the tagged geometry as flat typed-array columns for ECS systems
   * that drive per-type draw-call separation, LOD selection, or per-material
   * line hierarchy.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const posAttr = this.attributes.position;
    const typeAttr = this.attributes.edgeType;

    return {
      name,
      smoothCount: this._smoothCount,
      hardCount: this._hardCount,
      silhouetteCount: this._silhouetteCount,
      totalVertexCount: this.totalVertexCount,
      sourceCount: this._sourceCount,
      vertexCount: posAttr ? posAttr.count : 0,
      position: posAttr ? posAttr.array : null,
      edgeType: typeAttr ? typeAttr.array : null,
    };
  }

  // -----------------------------------------------------------------------
  // Disposal
  // -----------------------------------------------------------------------

  dispose() {
    super.dispose();
    this._sources.length = 0;
    this._smoothCount = 0;
    this._hardCount = 0;
    this._silhouetteCount = 0;
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled EdgeTypeTaggedGeometry instance (empty).
   * @returns {EdgeTypeTaggedGeometry}
   */
  static acquire() {
    return _acquireGeometry();
  }

  /**
   * Return this EdgeTypeTaggedGeometry to the pool. Caller must not use it
   * afterward.
   */
  release() {
    this.clear();
    _releaseGeometry(this);
  }

  /**
   * Clear the global EdgeTypeTaggedGeometry pool.
   */
  static clearPool() {
    _geometryPool.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Internal helper: resolve the default edge type for a source that lacks an
// edgeType attribute. Matches the "recommended default" from the docstring
// of addSource().
// ---------------------------------------------------------------------------
function _resolveDefaultType(source, options) {
  if (options.defaultType !== undefined) {
    return options.defaultType | 0;
  }
  if (source.isOutsideEdgesGeometry) return EdgeTypeTagged.SILHOUETTE;
  if (source.isTriangleIntersectionEdgesGeometry) return EdgeTypeTagged.HARD;
  if (source.isCombinedEdgesGeometry) return EdgeTypeTagged.SMOOTH;
  if (source.isConditionalEdgesGeometry) return EdgeTypeTagged.SMOOTH;
  if (source.isGPUConditionalEdges) return EdgeTypeTagged.SMOOTH;
  // Default fallback for unrecognised sources
  return EdgeTypeTagged.SMOOTH;
}

export { EdgeTypeTaggedGeometry, EdgeTypeTagged };
export default EdgeTypeTaggedGeometry;