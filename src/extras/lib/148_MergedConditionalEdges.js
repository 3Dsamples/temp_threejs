// file number : 148
// full path name : src/extras/lib/148_MergedConditionalEdges.js
// description : Merged conditional edges batch rewritten as a pure ES module with zero CDN imports. Accepts N conditional-edge geometries from any generator in the pipeline (128, 129, 133, 134, 137, 141, 145, or the baked output of 147) and folds them into a single flat interleaved buffer — one InstancedInterleavedBuffer (096) consumed by a single draw call through ConditionalLineMaterial (130) or its subclasses (135, 136, 140, 142). Per-source transforms (4×4 matrix) allow world-space merging of props whose edges are stored in local space. Two accumulate modes: addSource(geometry, options) for live edge geometries with per-vertex attributes; addBaked(geometry) for the simplified output of ConditionalEdgesBaker (147) that carries only position + optional color. Preserves per-vertex edgeType values (0/1/2 from 133/141), plus optional per-source per-instance colours (instanceColorStart / instanceColorEnd from 131) when the source carries them. All temporary storage uses flat typed arrays with amortised O(n) growth; no per-source object allocation in the accumulate path. Exposes finalize() returning the merged buffer, clear() for reuse, and a BitECS SoA bridge exposing per-source vertex counts and the merged buffer handle. Uses BufferGeometry (097), BufferAttribute (094), InstancedInterleavedBuffer (096), InterleavedBufferAttribute (100), Vec3 (006), Common (003), Constants (002), Color (069). Pooled instances via acquire()/release(). Designed for 10k+ conditional edge sources on Android 64-bit where draw-call reduction is critical.
// best for : ECS worlds where hundreds of props share a single outline material, merged conditional edge rendering with zero per-mesh draw calls, batch upload of conditional lines after frustum culling (138), merged baked edges from 147 for mobile exports, and any living-world pipeline that needs to collapse many conditional-edge sources into one draw call at 10k+ entity scale on Android 64-bit.
// license : MIT — architecture inspired by gkjohnson/threejs-sandbox (conditional-lines)

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
import { InstancedInterleavedBuffer } from '../../core/096_InstancedInterleavedBuffer.js';
import { InterleavedBufferAttribute } from '../../core/100_InterleavedBufferAttribute.js';
import { Color } from '../../core/069_Color.js';

// ---------------------------------------------------------------------------
// Static pool for MergedConditionalEdges instances — recycled to eliminate
// per-scene allocation churn when 10k+ merged batches rebuild every frame.
// ---------------------------------------------------------------------------
const _mergedPool = [];

function _acquireMerged() {
  const m = _mergedPool.pop();
  if (m) {
    m._sources.length = 0;
    m._instanceBuffer = null;
    m._instanceCount = 0;
    m._sourceCount = 0;
    m._lastMergeMs = 0;
    m._preservedEdgeTypes = 0;
    m._preservedColors = 0;
    if (m._uniformsCache) m._uniformsCache.release();
    m._uniformsCache = null;
    for (const key in m.attributes) delete m.attributes[key];
    m.index = null;
    m.groups.length = 0;
    m.boundingBox = null;
    m.boundingSphere = null;
    m.userData = {};
    m.version = 0;
    m._needsUpdate = false;
    return m;
  }
  return new MergedConditionalEdges();
}

function _releaseMerged(m) {
  if (_mergedPool.length < 32) _mergedPool.push(m);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v3 = new Float32Array(3);
const _v4 = new Float32Array(4);
const _mat4 = new Float32Array(16);

// ---------------------------------------------------------------------------
// MergedConditionalEdges — folds N conditional-edge sources into a single
// flat interleaved buffer consumable by 130 / 135 / 136 / 140 / 142 in one
// draw call.
//
// Interleaved layout per instance (vertex):
//   position          (3 floats)
//   direction         (3 floats)
//   control0          (3 floats)
//   control1          (3 floats)
//   edgeType          (1 float)
//   instanceColorStart(3 floats, optional — only if any source provides)
//   instanceColorEnd  (3 floats, optional — only if any source provides)
//
// Base layout = 13 floats. Colours add 6 floats when present → 19 floats.
//
// `addSource(geometry, options)` accepts full conditional-edge geometries
// (128, 129, 133, 134, 137, 141, 145). `addBaked(geometry)` accepts the
// reduced geometry produced by 147 (only position + optional color), folding
// it into the merged buffer with zero edge-type attribution.
// ---------------------------------------------------------------------------
class MergedConditionalEdges extends BufferGeometry {
  constructor() {
    super();

    this.isMergedConditionalEdges = true;
    this.type = 'MergedConditionalEdges';

    // Accumulator — populated by addSource()/addBaked(), consumed by finalize()
    this._sources = [];
    this._sourceCount = 0;

    // Output
    this._instanceBuffer = null;
    this._instanceCount = 0;

    // Stats
    this._lastMergeMs = 0;
    this._preservedEdgeTypes = 0;
    this._preservedColors = 0;

    // Lazily built uniforms cache (reserved for future per-batch uniforms)
    this._uniformsCache = null;
  }

  // -----------------------------------------------------------------------
  // Source accumulation — conditional edge geometries with all attributes
  // -----------------------------------------------------------------------

  /**
   * Add a conditional-edge source (full attribute layout).
   *
   * Accepts any of 128, 129, 133, 134, 137, 141, 145 — anything that exposes
   * a `position` attribute and, optionally, `direction` / `control0` /
   * `control1` / `edgeType` / `instanceColorStart` / `instanceColorEnd`.
   *
   * @param {BufferGeometry} geometry
   * @param {object} [options={}]
   * @param {Float32Array} [options.matrix] — 4×4 world matrix applied to
   *   positions, directions, and controls
   * @param {boolean} [options.isBaked=false] — set true when the source has
   *   no direction/control attributes (e.g. the output of 147). The merged
   *   buffer will still emit the vertex, but with zeroed direction/controls
   *   unless the caller supplies synthetic ones.
   * @returns {number} source index
   */
  addSource(geometry, options = {}) {
    if (!geometry || !geometry.attributes || !geometry.attributes.position) {
      throw new Error('MergedConditionalEdges.addSource: geometry has no position attribute.');
    }

    const isBaked = options.isBaked === true;

    const index = this._sources.length;
    this._sources.push({
      geometry,
      isBaked,
      matrix: options.matrix || null,
      kind: 'source',
    });

    return index;
  }

  // -----------------------------------------------------------------------
  // Source accumulation — pre-baked LineSegments output from 147
  // -----------------------------------------------------------------------

  /**
   * Add a pre-baked geometry (from ConditionalEdgesBaker.bake() in 147).
   * Baked geometries carry only `position` (and optionally `color`) — there
   * are no direction/control attributes, so the merged instance will use
   * zeroed direction/control attributes. This is fine when the merged
   * buffer feeds a plain LineSegments material rather than a conditional
   * fat-line material; when it feeds 130, the shader will see zeroed
   * direction/controls and will render the segment as a simple straight
   * line (which is the correct visual result for a baked edge).
   *
   * @param {BufferGeometry} bakedGeometry — output of 147.bake()
   * @param {object} [options={}]
   * @param {Float32Array} [options.matrix]
   * @returns {number} source index
   */
  addBaked(bakedGeometry, options = {}) {
    if (!bakedGeometry || !bakedGeometry.attributes || !bakedGeometry.attributes.position) {
      throw new Error('MergedConditionalEdges.addBaked: baked geometry has no position attribute.');
    }

    const index = this._sources.length;
    this._sources.push({
      geometry: bakedGeometry,
      isBaked: true,
      matrix: options.matrix || null,
      kind: 'baked',
    });

    return index;
  }

  /**
   * Remove a source by index (O(n) — callers rarely need this).
   * @param {number} index
   * @returns {this}
   */
  removeSource(index) {
    if (index < 0 || index >= this._sources.length) return this;
    this._sources.splice(index, 1);
    return this;
  }

  /**
   * Clear all accumulated sources.
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
    this._instanceBuffer = null;
    this._instanceCount = 0;
    this._preservedEdgeTypes = 0;
    this._preservedColors = 0;
    for (const key in this.attributes) delete this.attributes[key];
    this.index = null;
    this.groups.length = 0;
    return this;
  }

  // -----------------------------------------------------------------------
  // finalize — build the merged buffer
  // -----------------------------------------------------------------------

  /**
   * Merge all accumulated sources into a single InstancedInterleavedBuffer
   * (096) and attach it as the geometry's attributes for zero-copy
   * consumption by 130 / 135 / 136 / 140 / 142.
   *
   * @returns {this}
   */
  finalize() {
    const start = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    // Reset output
    for (const key in this.attributes) delete this.attributes[key];
    this.index = null;
    this.groups.length = 0;

    const sources = this._sources;
    const sourceCount = sources.length;

    this._sourceCount = sourceCount;
    this._preservedEdgeTypes = 0;
    this._preservedColors = 0;

    if (sourceCount === 0) {
      this._instanceBuffer = null;
      this._instanceCount = 0;
      this._emitEmpty();
      this._lastMergeMs = 0;
      return this;
    }

    // -------------------------------------------------------------------
    // 1. Pass 1 — count total vertices and detect colour presence
    // -------------------------------------------------------------------
    let totalVertices = 0;
    let hasColors = false;

    for (let s = 0; s < sourceCount; s++) {
      const { geometry } = sources[s];
      const posAttr = geometry.attributes.position;
      if (posAttr && posAttr.count > 0) {
        totalVertices += posAttr.count;
      }
      if (geometry.attributes.instanceColorStart && geometry.attributes.instanceColorEnd) {
        hasColors = true;
      }
    }

    if (totalVertices === 0) {
      this._instanceBuffer = null;
      this._instanceCount = 0;
      this._emitEmpty();
      this._lastMergeMs = 0;
      return this;
    }

    // Interleaved layout
    const FLOATS_BASE = 13;              // position(3) + direction(3) + control0(3) + control1(3) + edgeType(1)
    const FLOATS_COLORS = 6;             // instanceColorStart(3) + instanceColorEnd(3)
    const FLOATS_PER_INSTANCE = FLOATS_BASE + (hasColors ? FLOATS_COLORS : 0);

    const interleaved = new Float32Array(totalVertices * FLOATS_PER_INSTANCE);

    // -------------------------------------------------------------------
    // 2. Pass 2 — copy + transform + tag
    // -------------------------------------------------------------------
    let write = 0;

    for (let s = 0; s < sourceCount; s++) {
      const { geometry, isBaked, matrix } = sources[s];
      const attrs = geometry.attributes;
      const posAttr = attrs.position;
      if (!posAttr || posAttr.count === 0) continue;

      const posArr = posAttr.array;
      const posStride = posAttr.itemSize || 3;
      const vertexCount = posAttr.count;

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

      const colorStartAttr = attrs.instanceColorStart;
      const colorStartArr = colorStartAttr ? colorStartAttr.array : null;
      const colorEndAttr = attrs.instanceColorEnd;
      const colorEndArr = colorEndAttr ? colorEndAttr.array : null;

      const m = matrix;
      let anyType = false;

      for (let i = 0; i < vertexCount; i++) {
        const ps = i * posStride;

        // --- Position ---
        let px, py, pz;
        if (m) {
          const sx = posArr[ps + 0];
          const sy = posArr[ps + 1];
          const sz = posArr[ps + 2];
          px = m[0] * sx + m[4] * sy + m[8] * sz + m[12];
          py = m[1] * sx + m[5] * sy + m[9] * sz + m[13];
          pz = m[2] * sx + m[6] * sy + m[10] * sz + m[14];
        } else {
          px = posArr[ps + 0];
          py = posArr[ps + 1];
          pz = posArr[ps + 2];
        }

        interleaved[write + 0] = px;
        interleaved[write + 1] = py;
        interleaved[write + 2] = pz;

        // --- Direction ---
        if (dirArr) {
          const ds = i * dirStride;
          const dx = dirArr[ds + 0];
          const dy = dirArr[ds + 1];
          const dz = dirArr[ds + 2];
          if (m) {
            interleaved[write + 3] = m[0] * dx + m[4] * dy + m[8] * dz;
            interleaved[write + 4] = m[1] * dx + m[5] * dy + m[9] * dz;
            interleaved[write + 5] = m[2] * dx + m[6] * dy + m[10] * dz;
          } else {
            interleaved[write + 3] = dx;
            interleaved[write + 4] = dy;
            interleaved[write + 5] = dz;
          }
        } else {
          interleaved[write + 3] = 0;
          interleaved[write + 4] = 0;
          interleaved[write + 5] = 0;
        }

        // --- Control0 ---
        if (c0Arr) {
          const cs = i * c0Stride;
          const cx = c0Arr[cs + 0];
          const cy = c0Arr[cs + 1];
          const cz = c0Arr[cs + 2];
          if (m) {
            interleaved[write + 6] = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
            interleaved[write + 7] = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
            interleaved[write + 8] = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
          } else {
            interleaved[write + 6] = cx;
            interleaved[write + 7] = cy;
            interleaved[write + 8] = cz;
          }
        } else {
          // Fallback: use the vertex itself (forces the conditional test to
          // always draw — matching the HARD/SILHOUETTE behaviour in 133).
          interleaved[write + 6] = px;
          interleaved[write + 7] = py;
          interleaved[write + 8] = pz;
        }

        // --- Control1 ---
        if (c1Arr) {
          const cs = i * c1Stride;
          const cx = c1Arr[cs + 0];
          const cy = c1Arr[cs + 1];
          const cz = c1Arr[cs + 2];
          if (m) {
            interleaved[write + 9]  = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
            interleaved[write + 10] = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
            interleaved[write + 11] = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
          } else {
            interleaved[write + 9]  = cx;
            interleaved[write + 10] = cy;
            interleaved[write + 11] = cz;
          }
        } else {
          interleaved[write + 9]  = px;
          interleaved[write + 10] = py;
          interleaved[write + 11] = pz;
        }

        // --- Edge type ---
        if (typeArr) {
          interleaved[write + 12] = typeArr[i];
          anyType = true;
        } else {
          // Default: use SMOOTH (0) for conditional edges, HARD (1) for baked
          interleaved[write + 12] = isBaked ? 1 : 0;
        }

        // --- Optional per-instance colours ---
        if (hasColors) {
          if (colorStartArr && colorEndArr) {
            interleaved[write + 13] = colorStartArr[i * 3 + 0];
            interleaved[write + 14] = colorStartArr[i * 3 + 1];
            interleaved[write + 15] = colorStartArr[i * 3 + 2];
            interleaved[write + 16] = colorEndArr[i * 3 + 0];
            interleaved[write + 17] = colorEndArr[i * 3 + 1];
            interleaved[write + 18] = colorEndArr[i * 3 + 2];
          } else {
            // Default white
            interleaved[write + 13] = 1;
            interleaved[write + 14] = 1;
            interleaved[write + 15] = 1;
            interleaved[write + 16] = 1;
            interleaved[write + 17] = 1;
            interleaved[write + 18] = 1;
          }
        }

        write += FLOATS_PER_INSTANCE;
      }

      if (anyType) this._preservedEdgeTypes++;
      if (colorStartArr) this._preservedColors++;
    }

    // -------------------------------------------------------------------
    // 3. Build InstancedInterleavedBuffer (096)
    // -------------------------------------------------------------------
    const buffer = new InstancedInterleavedBuffer(interleaved, FLOATS_PER_INSTANCE, 1);
    this._instanceBuffer = buffer;
    this._instanceCount = totalVertices;

    // -------------------------------------------------------------------
    // 4. Attach InterleavedBufferAttributes (100)
    // -------------------------------------------------------------------
    this.setAttribute('position',
      new InterleavedBufferAttribute(buffer, 3, 0, false));
    this.setAttribute('direction',
      new InterleavedBufferAttribute(buffer, 3, 3, false));
    this.setAttribute('control0',
      new InterleavedBufferAttribute(buffer, 3, 6, false));
    this.setAttribute('control1',
      new InterleavedBufferAttribute(buffer, 3, 9, false));
    this.setAttribute('edgeType',
      new InterleavedBufferAttribute(buffer, 1, 12, false));

    if (hasColors) {
      this.setAttribute('instanceColorStart',
        new InterleavedBufferAttribute(buffer, 3, 13, false));
      this.setAttribute('instanceColorEnd',
        new InterleavedBufferAttribute(buffer, 3, 16, false));
    }

    this.needsUpdate = true;

    const elapsed = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()) - start;
    this._lastMergeMs = elapsed;

    return this;
  }

  /**
   * Emit empty attributes.
   * @private
   */
  _emitEmpty() {
    const empty3 = new BufferAttribute(new Float32Array(0), 3, false);
    const empty1 = new BufferAttribute(new Float32Array(0), 1, false);
    this.setAttribute('position', empty3);
    this.setAttribute('direction', new BufferAttribute(new Float32Array(0), 3, false));
    this.setAttribute('control0', new BufferAttribute(new Float32Array(0), 3, false));
    this.setAttribute('control1', new BufferAttribute(new Float32Array(0), 3, false));
    this.setAttribute('edgeType', empty1);
    this.needsUpdate = true;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** @returns {number} — number of accumulated sources */
  get sourceCount() { return this._sourceCount; }

  /** @returns {number} — total merged vertex count */
  get vertexCount() { return this._instanceCount; }

  /** @returns {number} — merged edge count (vertexCount / 2) */
  get edgeCount() { return Math.floor(this._instanceCount / 2); }

  /** @returns {InstancedInterleavedBuffer|null} — the merged buffer */
  get instanceBuffer() { return this._instanceBuffer; }

  /** @returns {number} — elapsed milliseconds of the last finalize() */
  get lastMergeMs() { return this._lastMergeMs; }

  /** @returns {number} — sources that carried edgeType */
  get preservedEdgeTypes() { return this._preservedEdgeTypes; }

  /** @returns {number} — sources that carried per-instance colours */
  get preservedColors() { return this._preservedColors; }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose merged batch state as flat typed-array columns for ECS-driven
   * draw-call scheduling, per-source toggling, or LOD systems.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const sourceCount = this._sources.length;
    const sourceVertexCounts = new Int32Array(sourceCount);
    const sourceIsBaked = new Uint8Array(sourceCount);

    for (let i = 0; i < sourceCount; i++) {
      const src = this._sources[i];
      const posAttr = src.geometry && src.geometry.attributes
        ? src.geometry.attributes.position
        : null;
      sourceVertexCounts[i] = posAttr ? posAttr.count : 0;
      sourceIsBaked[i] = src.isBaked ? 1 : 0;
    }

    return {
      name,
      sourceCount,
      vertexCount: this._instanceCount,
      edgeCount: this.edgeCount,
      sourceVertexCounts,
      sourceIsBaked,
      preservedEdgeTypes: this._preservedEdgeTypes,
      preservedColors: this._preservedColors,
      lastMergeMs: this._lastMergeMs,
      instanceBuffer: this._instanceBuffer ? this._instanceBuffer.array : null,
      floatsPerInstance: this._instanceBuffer ? this._instanceBuffer.stride : 0,
    };
  }

  // -----------------------------------------------------------------------
  // Disposal
  // -----------------------------------------------------------------------

  dispose() {
    super.dispose();
    this.clear();
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled MergedConditionalEdges instance (empty).
   * @returns {MergedConditionalEdges}
   */
  static acquire() {
    return _acquireMerged();
  }

  /**
   * Return this merged batch to the pool. Caller must not use it afterward.
   */
  release() {
    this.clear();
    _releaseMerged(this);
  }

  /**
   * Clear the global MergedConditionalEdges pool.
   */
  static clearPool() {
    _mergedPool.length = 0;
  }
}

export { MergedConditionalEdges };
export default MergedConditionalEdges;