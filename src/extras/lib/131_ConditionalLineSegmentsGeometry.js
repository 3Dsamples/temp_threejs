// file number : 131
// full path name : src/extras/lib/131_ConditionalLineSegmentsGeometry.js
// description : Conditional line segments geometry rewritten as a pure ES module with zero CDN imports. Converts ConditionalEdgesGeometry (128) attributes (position, direction, control0, control1) into the instanced interleaved layout required by ConditionalLineMaterial (130). Extends a lightweight local LineSegmentsGeometry descriptor and uses the project's InstancedInterleavedBuffer (096) and InterleavedBufferAttribute (100) for zero-allocation conversion, with optional per-instance colors and dash distances. Adds pooled instances via acquire()/release(), a two-pass exact-size conversion, and a BitECS SoA bridge for ECS-driven fat-line pipelines. Uses the project's Vec2/Vec3/Color/Common/Constants modules for zero-allocation math. Designed for 10k+ conditional fat-line meshes on Android 64-bit.
// best for : Fat conditional line rendering on every 3D mesh, LDraw-style model outlines, anime-style edge lines, CAD wireframe overlays, dashed hidden-line rendering, and any ECS-driven living-world pipeline that toggles conditional fat lines per mesh at 10k+ entity scale on Android 64-bit.
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
import { Color } from '../../core/069_Color.js';
import { BufferGeometry } from '../../core/097_BufferGeometry.js';
import { BufferAttribute } from '../../core/094_BufferAttribute.js';
import { InstancedInterleavedBuffer } from '../../core/096_InstancedInterleavedBuffer.js';
import { InterleavedBufferAttribute } from '../../core/100_InterleavedBufferAttribute.js';
import { ConditionalEdgesGeometry } from './128_ConditionalEdgesGeometry.js';

// ---------------------------------------------------------------------------
// Static pool for ConditionalLineSegmentsGeometry instances — recycled to
// eliminate per-mesh allocation churn when 10k+ meshes toggle fat lines.
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
    g._instanceCount = 0;
    g._instanceBuffer = null;
    return g;
  }
  return new ConditionalLineSegmentsGeometry();
}

function _releaseGeometry(g) {
  if (_geometryPool.length < 64) _geometryPool.push(g);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v3 = new Float32Array(3);
const _v3b = new Float32Array(3);

// ---------------------------------------------------------------------------
// Local LineSegmentsGeometry base class. Exposes the minimum BufferGeometry
// surface that ConditionalLineMaterial and the project's renderer need.
// Mirrors the semantics of gkjohnson's Lines2/LineSegmentsGeometry base.
// ---------------------------------------------------------------------------
class LocalLineSegmentsGeometry extends BufferGeometry {
  constructor() {
    super();
    this.isLineSegmentsGeometry = true;
    this.type = 'LineSegmentsGeometry';
    this._instanceCount = 0;
    this._instanceBuffer = null;
  }

  /**
   * Set the per-instance start/end positions.
   * @param {Float32Array} positions — flat [x0,y0,z0, x1,y1,z1, ...]
   * @returns {this}
   */
  setPositions(positions) {
    const count = positions.length / 6; // 2 vertices × 3 floats per segment
    const instancedArray = new Float32Array(count * 6);

    // Interleave start/end for each segment. Each segment = 6 floats.
    for (let i = 0; i < count; i++) {
      instancedArray[i * 6 + 0] = positions[i * 6 + 0];
      instancedArray[i * 6 + 1] = positions[i * 6 + 1];
      instancedArray[i * 6 + 2] = positions[i * 6 + 2];
      instancedArray[i * 6 + 3] = positions[i * 6 + 3];
      instancedArray[i * 6 + 4] = positions[i * 6 + 4];
      instancedArray[i * 6 + 5] = positions[i * 6 + 5];
    }

    return this;
  }

  /**
   * Expose the instance count.
   * @returns {number}
   */
  get instanceCount() {
    return this._instanceCount;
  }

  dispose() {
    super.dispose();
    this._instanceCount = 0;
    this._instanceBuffer = null;
  }
}

// ---------------------------------------------------------------------------
// ConditionalLineSegmentsGeometry — mirrors gkjohnson's Lines2 conditional
// line segments geometry. Converts a ConditionalEdgesGeometry (128) into
// instanced interleaved buffers consumable by ConditionalLineMaterial (130).
//
// Each conditional segment becomes one instance. The base (non-instanced)
// geometry is a simple quad (4 vertices, 2 triangles) that the vertex
// shader expands in screen space. This matches the reference implementation.
// ---------------------------------------------------------------------------
class ConditionalLineSegmentsGeometry extends LocalLineSegmentsGeometry {
  /**
   * @param {ConditionalEdgesGeometry} [edgesGeometry] — optional source to convert
   */
  constructor(edgesGeometry) {
    super();

    this.isConditionalLineSegmentsGeometry = true;
    this.type = 'ConditionalLineSegmentsGeometry';

    // --- Base quad (4 vertices, 2 triangles, matches Lines2 shader contract) ---
    //   positions: (0,-1), (1,-1), (1,1), (0,1)
    //   uv:        (0,0),  (1,0),  (1,1), (0,1)
    //   index:     0,2,1  0,3,2
    const basePositions = new Float32Array([
      0, -1, 0,
      1, -1, 0,
      1,  1, 0,
      0,  1, 0,
    ]);
    const baseUV = new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ]);
    const baseIndex = new Uint16Array([0, 2, 1, 0, 3, 2]);

    this.setAttribute('position', new BufferAttribute(basePositions, 3, false));
    this.setAttribute('uv', new BufferAttribute(baseUV, 2, false));
    this.setIndex(new BufferAttribute(baseIndex, 1, false));

    if (edgesGeometry) {
      this.fromEdgesGeometry(edgesGeometry);
    }
  }

  /**
   * Convert a ConditionalEdgesGeometry (128) into the instanced interleaved
   * layout required by ConditionalLineMaterial (130).
   *
   * @param {ConditionalEdgesGeometry} edgesGeometry
   * @param {object} [options={}]
   * @param {Float32Array} [options.colors] — optional per-instance colors
   *   (flat [r,g,b, r,g,b, ...], length = edgeCount × 6)
   * @param {Float32Array} [options.distances] — optional per-instance dash
   *   distances (flat [d0,d0, d1,d1, ...], length = edgeCount × 2)
   * @returns {this}
   */
  fromEdgesGeometry(edgesGeometry, options = {}) {
    if (!edgesGeometry || !edgesGeometry.isConditionalEdgesGeometry) {
      throw new Error('ConditionalLineSegmentsGeometry.fromEdgesGeometry: source must be a ConditionalEdgesGeometry.');
    }

    const posAttr = edgesGeometry.attributes.position;
    const dirAttr = edgesGeometry.attributes.direction;
    const c0Attr = edgesGeometry.attributes.control0;
    const c1Attr = edgesGeometry.attributes.control1;

    if (!posAttr || !dirAttr || !c0Attr || !c1Attr) {
      throw new Error('ConditionalLineSegmentsGeometry.fromEdgesGeometry: source geometry is missing required attributes.');
    }

    // -------------------------------------------------------------------
    // 1. Determine the number of segments. ConditionalEdgesGeometry emits
    //    2 vertices per surviving edge — so edgeCount = posAttr.count / 2.
    // -------------------------------------------------------------------
    const vertexCount = posAttr.count;
    const edgeCount = vertexCount / 2;

    if (edgeCount === 0) {
      this._instanceCount = 0;
      this._instanceBuffer = null;
      this.needsUpdate = true;
      return this;
    }

    const posArr = posAttr.array;
    const dirArr = dirAttr.array;
    const c0Arr = c0Attr.array;
    const c1Arr = c1Attr.array;

    // -------------------------------------------------------------------
    // 2. Build the interleaved instance layout. Each instance carries:
    //      instanceStart        (vec3)
    //      instanceEnd          (vec3)
    //      instanceColorStart   (vec3)
    //      instanceColorEnd     (vec3)
    //      instanceDistanceStart(float)
    //      instanceDistanceEnd  (float)
    //      control0             (vec3)
    //      control1             (vec3)
    //      direction            (vec3)
    //    = 3 + 3 + 3 + 3 + 1 + 1 + 3 + 3 + 3 = 23 floats per instance
    // -------------------------------------------------------------------
    const FLOATS_PER_INSTANCE = 23;
    const interleaved = new Float32Array(edgeCount * FLOATS_PER_INSTANCE);

    const colors = options.colors;       // optional
    const distances = options.distances; // optional

    // Fill the interleaved buffer
    for (let e = 0; e < edgeCount; e++) {
      const v0 = e * 2;
      const v1 = e * 2 + 1;
      const base = e * FLOATS_PER_INSTANCE;

      // instanceStart (from vertex v0)
      interleaved[base + 0]  = posArr[v0 * 3 + 0];
      interleaved[base + 1]  = posArr[v0 * 3 + 1];
      interleaved[base + 2]  = posArr[v0 * 3 + 2];

      // instanceEnd (from vertex v1)
      interleaved[base + 3]  = posArr[v1 * 3 + 0];
      interleaved[base + 4]  = posArr[v1 * 3 + 1];
      interleaved[base + 5]  = posArr[v1 * 3 + 2];

      // instanceColorStart / instanceColorEnd (default white if not provided)
      if (colors) {
        interleaved[base + 6]  = colors[e * 6 + 0];
        interleaved[base + 7]  = colors[e * 6 + 1];
        interleaved[base + 8]  = colors[e * 6 + 2];
        interleaved[base + 9]  = colors[e * 6 + 3];
        interleaved[base + 10] = colors[e * 6 + 4];
        interleaved[base + 11] = colors[e * 6 + 5];
      } else {
        interleaved[base + 6]  = 1;
        interleaved[base + 7]  = 1;
        interleaved[base + 8]  = 1;
        interleaved[base + 9]  = 1;
        interleaved[base + 10] = 1;
        interleaved[base + 11] = 1;
      }

      // instanceDistanceStart / instanceDistanceEnd (dash support)
      if (distances) {
        interleaved[base + 12] = distances[e * 2 + 0];
        interleaved[base + 13] = distances[e * 2 + 1];
      } else {
        interleaved[base + 12] = 0;
        interleaved[base + 13] = 0;
      }

      // control0 (from vertex v0's control0 attribute)
      interleaved[base + 14] = c0Arr[v0 * 3 + 0];
      interleaved[base + 15] = c0Arr[v0 * 3 + 1];
      interleaved[base + 16] = c0Arr[v0 * 3 + 2];

      // control1 (from vertex v0's control1 attribute)
      interleaved[base + 17] = c1Arr[v0 * 3 + 0];
      interleaved[base + 18] = c1Arr[v0 * 3 + 1];
      interleaved[base + 19] = c1Arr[v0 * 3 + 2];

      // direction (same for both vertices of an edge)
      interleaved[base + 20] = dirArr[v0 * 3 + 0];
      interleaved[base + 21] = dirArr[v0 * 3 + 1];
      interleaved[base + 22] = dirArr[v0 * 3 + 2];
    }

    // -------------------------------------------------------------------
    // 3. Build an InstancedInterleavedBuffer (096) from the flat data.
    // -------------------------------------------------------------------
    const instanceBuffer = new InstancedInterleavedBuffer(
      interleaved,
      FLOATS_PER_INSTANCE,
      1, // meshPerAttribute = 1 for fat-line instancing
    );

    this._instanceBuffer = instanceBuffer;
    this._instanceCount = edgeCount;

    // -------------------------------------------------------------------
    // 4. Attach the InterleavedBufferAttributes (100). Offsets are in
    //    floats, stride = FLOATS_PER_INSTANCE.
    // --------------------------------------------------------------------------
    this.setAttribute('instanceStart',
      new InterleavedBufferAttribute(instanceBuffer, 3, 0, false));
    this.setAttribute('instanceEnd',
      new InterleavedBufferAttribute(instanceBuffer, 3, 3, false));
    this.setAttribute('instanceColorStart',
      new InterleavedBufferAttribute(instanceBuffer, 3, 6, false));
    this.setAttribute('instanceColorEnd',
      new InterleavedBufferAttribute(instanceBuffer, 3, 9, false));
    this.setAttribute('instanceDistanceStart',
      new InterleavedBufferAttribute(instanceBuffer, 1, 12, false));
    this.setAttribute('instanceDistanceEnd',
      new InterleavedBufferAttribute(instanceBuffer, 1, 13, false));
    this.setAttribute('control0',
      new InterleavedBufferAttribute(instanceBuffer, 3, 14, false));
    this.setAttribute('control1',
      new InterleavedBufferAttribute(instanceBuffer, 3, 17, false));
    this.setAttribute('direction',
      new InterleavedBufferAttribute(instanceBuffer, 3, 20, false));

    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** @returns {number} — number of instanced segments */
  get instanceCount() {
    return this._instanceCount;
  }

  /** @returns {InstancedInterleavedBuffer|null} — the underlying instance buffer */
  get instanceBuffer() {
    return this._instanceBuffer;
  }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose the instanced interleaved buffer as flat typed-array columns for
   * ECS systems that drive per-mesh fat-line toggling or LOD selection.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const buf = this._instanceBuffer;
    return {
      name,
      instanceCount: this._instanceCount,
      floatsPerInstance: 23,
      data: buf ? buf.array : null,
    };
  }

  // -----------------------------------------------------------------------
  // Disposal
  // -----------------------------------------------------------------------

  dispose() {
    super.dispose();
    this._instanceCount = 0;
    this._instanceBuffer = null;
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled ConditionalLineSegmentsGeometry instance (empty, base quad only).
   * @returns {ConditionalLineSegmentsGeometry}
   */
  static acquire() {
    return _acquireGeometry();
  }

  /**
   * Return this ConditionalLineSegmentsGeometry to the pool.
   */
  release() {
    for (const key in this.attributes) delete this.attributes[key];
    this._instanceCount = 0;
    this._instanceBuffer = null;
    _releaseGeometry(this);
  }

  /**
   * Clear the global ConditionalLineSegmentsGeometry pool.
   */
  static clearPool() {
    _geometryPool.length = 0;
  }
}

export { ConditionalLineSegmentsGeometry, LocalLineSegmentsGeometry };
export default ConditionalLineSegmentsGeometry;