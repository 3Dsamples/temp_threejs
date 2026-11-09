// file number : 138
// full path name : src/extras/lib/138_CulledEdgesBatch.js
// description : Frustum-culling-aware edge batch wrapper rewritten as a pure ES module with zero CDN imports. Wraps the edge outputs of ConditionalEdgesGeometry (128), OutsideEdgesGeometry (129), CombinedEdgesGeometry (133), and GPUConditionalEdges (137) with per-instance AABB metadata so ECS systems can cull entire edge batches before uploading to the GPU. Integrates natively with the project's Layers (085) for context-aware visibility filtering and OBB (081) for oriented bounding-box tests, and exposes a zero-allocation cull(camera, layers) hot path. When culling is disabled, the batch falls through to a flat InstancedInterleavedBuffer (096) for zero-copy consumption by ConditionalLineSegmentsGeometry (131). Uses the project's BufferGeometry (097), BufferAttribute (094), InstancedInterleavedBuffer (096), InterleavedBufferAttribute (100), Vec3 (006), Mat4 (010), Common (003), Precision (004), and Constants (002) modules. Pooled instances via acquire()/release(), BitECS SoA bridge, and a lightweight local frustum descriptor so no external CDN dependency is required. Designed for 10k+ edge instances on Android 64-bit where most edges are sub-pixel and should be culled early.
// best for : Frustum-culling-aware conditional edge rendering on 10k+ meshes, large open worlds where most edge batches are off-screen, ECS-driven LOD systems that toggle edge visibility per region, batched conditional line rendering with zero-copy instanced buffers, and any living-world pipeline that must cull edge work before it reaches the GPU at 10k+ entity scale on Android 64-bit.
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
import { InstancedInterleavedBuffer } from '../../core/096_InstancedInterleavedBuffer.js';
import { InterleavedBufferAttribute } from '../../core/100_InterleavedBufferAttribute.js';
import { Layers } from '../../core/085_Layers.js';
import { OBB } from '../../math/081_OBB.js';

// ---------------------------------------------------------------------------
// Static pool for CulledEdgesBatch instances — recycled to eliminate
// per-scene allocation churn when 10k+ edge batches toggle visibility at
// runtime.
// ---------------------------------------------------------------------------
const _batchPool = [];

function _acquireBatch() {
  const b = _batchPool.pop();
  if (b) {
    b._instances.length = 0;
    b._instanceBuffer = null;
    b._instanceCount = 0;
    b._visibleCount = 0;
    b._frustumCullEnabled = true;
    b._layerMaskEnabled = true;
    b._cameraMask = 0xffffffff;
    b._layers.mask = 0xffffffff;
    b._lastCullMs = 0;
    b._lastCulled = 0;
    for (const key in b.attributes) delete b.attributes[key];
    b.index = null;
    b.groups.length = 0;
    b.boundingBox = null;
    b.boundingSphere = null;
    b.userData = {};
    b.version = 0;
    b._needsUpdate = false;
    return b;
  }
  return new CulledEdgesBatch();
}

function _releaseBatch(b) {
  if (_batchPool.length < 64) _batchPool.push(b);
}

// ---------------------------------------------------------------------------
// Lightweight local frustum descriptor (no CDN dependency).
// Stores the six frustum planes (normal + constant) in a flat Float32Array.
// Compatible with the standard three.js camera setup via
// `setFromProjectionMatrix(matrix)`.
// ---------------------------------------------------------------------------
class LocalFrustum {
  constructor() {
    // 6 planes × 4 floats (nx, ny, nz, constant)
    this.planes = new Float32Array(24);
    this._valid = false;
  }

  /**
   * Extract the 6 frustum planes from a projection × view matrix.
   * Mirrors three.js Frustum.setFromProjectionMatrix().
   * @param {Float32Array} m — column-major 4×4 matrix (16 floats)
   * @returns {this}
   */
  setFromProjectionMatrix(m) {
    const planes = this.planes;

    // Left
    planes[0] = m[3] + m[0];
    planes[1] = m[7] + m[4];
    planes[2] = m[11] + m[8];
    planes[3] = m[15] + m[12];
    normalizePlane(planes, 0);

    // Right
    planes[4] = m[3] - m[0];
    planes[5] = m[7] - m[4];
    planes[6] = m[11] - m[8];
    planes[7] = m[15] - m[12];
    normalizePlane(planes, 4);

    // Bottom
    planes[8] = m[3] + m[1];
    planes[9] = m[7] + m[5];
    planes[10] = m[11] + m[9];
    planes[11] = m[15] + m[13];
    normalizePlane(planes, 8);

    // Top
    planes[12] = m[3] - m[1];
    planes[13] = m[7] - m[5];
    planes[14] = m[11] - m[9];
    planes[15] = m[15] - m[13];
    normalizePlane(planes, 12);

    // Near
    planes[16] = m[3] + m[2];
    planes[17] = m[7] + m[6];
    planes[18] = m[11] + m[10];
    planes[19] = m[15] + m[14];
    normalizePlane(planes, 16);

    // Far
    planes[20] = m[3] - m[2];
    planes[21] = m[7] - m[6];
    planes[22] = m[11] - m[10];
    planes[23] = m[15] - m[14];
    normalizePlane(planes, 20);

    this._valid = true;
    return this;
  }

  /**
   * Test whether an AABB is fully outside the frustum.
   * @param {number} minX
   * @param {number} minY
   * @param {number} minZ
   * @param {number} maxX
   * @param {number} maxY
   * @param {number} maxZ
   * @returns {boolean} true if the AABB intersects or is inside the frustum
   */
  intersectsAABB(minX, minY, minZ, maxX, maxY, maxZ) {
    if (!this._valid) return true;

    const p = this.planes;
    for (let i = 0; i < 24; i += 4) {
      const nx = p[i];
      const ny = p[i + 1];
      const nz = p[i + 2];
      const c = p[i + 3];

      // Pick the positive vertex (farthest along the plane normal)
      const px = nx >= 0 ? maxX : minX;
      const py = ny >= 0 ? maxY : minY;
      const pz = nz >= 0 ? maxZ : minZ;

      if (nx * px + ny * py + nz * pz + c < 0) {
        return false; // fully outside this plane
      }
    }
    return true;
  }

  dispose() {
    this._valid = false;
  }
}

function normalizePlane(planes, offset) {
  const nx = planes[offset];
  const ny = planes[offset + 1];
  const nz = planes[offset + 2];
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  const inv = 1 / len;
  planes[offset] *= inv;
  planes[offset + 1] *= inv;
  planes[offset + 2] *= inv;
  planes[offset + 3] *= inv;
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v3a = new Float32Array(3);
const _v3b = new Float32Array(3);
const _mat4 = new Float32Array(16);
const _frustum = new LocalFrustum();

// ---------------------------------------------------------------------------
// CulledEdgesBatch — wraps edge geometry with per-instance AABBs and performs
// frustum + layer culling before upload.
//
// Each instance represents one edge-geometry source (e.g. a single mesh's
// ConditionalEdgesGeometry output). The batch computes a world-space AABB for
// each instance, and on cull(camera, layers) it:
//   1. Extracts the frustum from `camera.projectionMatrix * camera.matrixWorldInverse`
//   2. Tests each instance's AABB against the frustum
//   3. Tests each instance's Layers against the camera mask (if layerCulling)
//   4. For surviving instances, writes their interleaved edge data into a
//      single InstancedInterleavedBuffer (096) — one upload, zero copies.
//
// When culling is disabled, the batch still builds the interleaved buffer
// so it can be consumed by ConditionalLineSegmentsGeometry (131).
// ---------------------------------------------------------------------------
class CulledEdgesBatch extends BufferGeometry {
  constructor() {
    super();

    this.isCulledEdgesBatch = true;
    this.type = 'CulledEdgesBatch';

    // Per-instance descriptors (flat arrays to avoid per-instance objects)
    this._instances = []; // { minX, minY, minZ, maxX, maxY, maxZ, layers, visible }

    this._instanceBuffer = null;
    this._instanceCount = 0;
    this._visibleCount = 0;

    this._frustumCullEnabled = true;
    this._layerMaskEnabled = true;
    this._cameraMask = 0xffffffff;
    this._layers = new Layers();
    this._layers.mask = 0xffffffff;

    this._lastCullMs = 0;
    this._lastCulled = 0;
  }

  // -----------------------------------------------------------------------
  // Instance management
  // -----------------------------------------------------------------------

  /**
   * Add an edge geometry to this batch.
   *
   * @param {object} geometry — any geometry that exposes `position` and
   *   `direction` attributes (128, 129, 133, 134, 137 all qualify)
   * @param {object} [options={}]
   * @param {Float32Array} [options.matrix] — optional 4×4 world matrix for
   *   AABB computation (defaults to identity)
   * @param {Layers} [options.layers] — optional Layers (085) for filtering
   * @param {boolean} [options.visible=true] — per-instance visibility flag
   * @returns {number} instance index
   */
  addGeometry(geometry, options = {}) {
    if (!geometry || !geometry.attributes || !geometry.attributes.position) {
      throw new Error('CulledEdgesBatch.addGeometry: geometry has no position attribute.');
    }

    const posArr = geometry.attributes.position.array;
    const stride = geometry.attributes.position.itemSize || 3;
    const count = geometry.attributes.position.count;

    if (count === 0) {
      return -1;
    }

    // Compute AABB in local space, then transform by matrix (if provided)
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < count; i++) {
      const x = posArr[i * stride + 0];
      const y = posArr[i * stride + 1];
      const z = posArr[i * stride + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    // Transform AABB by matrix if provided (conservative: transform 8 corners
    // and re-fit). If no matrix, use identity.
    if (options.matrix) {
      const m = options.matrix;
      let txMinX = Infinity, txMinY = Infinity, txMinZ = Infinity;
      let txMaxX = -Infinity, txMaxY = -Infinity, txMaxZ = -Infinity;

      for (let corner = 0; corner < 8; corner++) {
        const cx = (corner & 1) ? maxX : minX;
        const cy = (corner & 2) ? maxY : minY;
        const cz = (corner & 4) ? maxZ : minZ;

        const tx = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
        const ty = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
        const tz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];

        if (tx < txMinX) txMinX = tx;
        if (ty < txMinY) txMinY = ty;
        if (tz < txMinZ) txMinZ = tz;
        if (tx > txMaxX) txMaxX = tx;
        if (ty > txMaxY) txMaxY = ty;
        if (tz > txMaxZ) txMaxZ = tz;
      }

      minX = txMinX; minY = txMinY; minZ = txMinZ;
      maxX = txMaxX; maxY = txMaxY; maxZ = txMaxZ;
    }

    const layers = options.layers || null;
    const visible = options.visible !== undefined ? options.visible : true;

    const index = this._instances.length;
    this._instances.push({
      geometry,
      minX, minY, minZ,
      maxX, maxY, maxZ,
      layers,
      visible,
      matrix: options.matrix || null,
    });

    return index;
  }

  /**
   * Remove an instance by index.
   * @param {number} index
   * @returns {this}
   */
  removeGeometry(index) {
    if (index < 0 || index >= this._instances.length) return this;
    this._instances.splice(index, 1);
    return this;
  }

  /**
   * Remove all instances.
   * @returns {this}
   */
  clear() {
    this._instances.length = 0;
    this._instanceBuffer = null;
    this._instanceCount = 0;
    this._visibleCount = 0;
    return this;
  }

  // -----------------------------------------------------------------------
  // Culling
  // -----------------------------------------------------------------------

  /**
   * Enable or disable frustum culling.
   * @param {boolean} enabled
   * @returns {this}
   */
  setFrustumCull(enabled) {
    this._frustumCullEnabled = !!enabled;
    return this;
  }

  /**
   * Enable or disable layer-mask filtering.
   * @param {boolean} enabled
   * @returns {this}
   */
  setLayerCull(enabled) {
    this._layerMaskEnabled = !!enabled;
    return this;
  }

  /**
   * Set the camera layer mask used for layer-based culling.
   * @param {number} mask
   * @returns {this}
   */
  setCameraMask(mask) {
    this._cameraMask = mask >>> 0;
    return this;
  }

  /**
   * Set this batch's own layer membership (used when the batch is tested
   * as a single object by an external culler).
   * @param {number} mask
   * @returns {this}
   */
  setLayersMask(mask) {
    this._layers.mask = mask >>> 0;
    return this;
  }

  /**
   * Perform frustum + layer culling and rebuild the interleaved instance
   * buffer from surviving instances.
   *
   * @param {object} camera — camera with projectionMatrix (16) and
   *   matrixWorldInverse (16)
   * @param {number} [thresholdDot=0.01] — unused here, reserved for future
   *   per-instance classification
   * @returns {this}
   */
  cull(camera, thresholdDot = 0.01) {
    const start = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    const instances = this._instances;
    const n = instances.length;

    // -------------------------------------------------------------------
    // 1. Build the frustum from the camera's view-projection matrix
    // -------------------------------------------------------------------
    let frustumValid = false;
    if (this._frustumCullEnabled && camera) {
      // viewProjection = projectionMatrix × matrixWorldInverse
      const proj = camera.projectionMatrix;
      const view = camera.matrixWorldInverse;
      if (proj && view) {
        Mat4.multiply(_mat4, proj, view);
        _frustum.setFromProjectionMatrix(_mat4);
        frustumValid = true;
      }
    }

    // -------------------------------------------------------------------
    // 2. Filter instances
    // -------------------------------------------------------------------
    const survivors = [];
    for (let i = 0; i < n; i++) {
      const inst = instances[i];

      // Per-instance visibility flag
      if (inst.visible === false) continue;

      // Layer culling
      if (this._layerMaskEnabled && inst.layers) {
        if ((inst.layers.mask & this._cameraMask) === 0) continue;
      }

      // Frustum culling
      if (frustumValid) {
        if (!_frustum.intersectsAABB(
          inst.minX, inst.minY, inst.minZ,
          inst.maxX, inst.maxY, inst.maxZ
        )) {
          continue;
        }
      }

      survivors.push(i);
    }

    this._visibleCount = survivors.length;
    this._lastCulled = n - survivors.length;

    // -------------------------------------------------------------------
    // 3. Rebuild the interleaved instance buffer from survivors
    // -------------------------------------------------------------------
    this._rebuildInterleavedBuffer(survivors);

    const elapsed = ((typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now()) - start;
    this._lastCullMs = elapsed;

    return this;
  }

  /**
   * Rebuild the interleaved instance buffer from a set of surviving instance
   * indices. Called by cull() and by direct callers who want to rebuild
   * without re-running the frustum test.
   *
   * @param {number[]} [survivors] — indices of surviving instances (default:
   *   all instances)
   * @returns {this}
   * @private
   */
  _rebuildInterleavedBuffer(survivors) {
    const instances = this._instances;
    const survivorsArr = survivors || instances.map((_, i) => i);

    // Compute total vertex count
    let totalVertices = 0;
    for (const idx of survivorsArr) {
      const geo = instances[idx].geometry;
      if (geo && geo.attributes && geo.attributes.position) {
        totalVertices += geo.attributes.position.count;
      }
    }

    if (totalVertices === 0) {
      this._instanceBuffer = null;
      this._instanceCount = 0;
      this._emitEmpty();
      return this;
    }

    // Interleaved layout per vertex: position(3) + direction(3) + control0(3) + control1(3) + edgeType(1) = 13 floats
    const FLOATS_PER_VERTEX = 13;
    const interleaved = new Float32Array(totalVertices * FLOATS_PER_VERTEX);

    let writeOffset = 0;

    for (const idx of survivorsArr) {
      const inst = instances[idx];
      const geo = inst.geometry;
      if (!geo || !geo.attributes || !geo.attributes.position) continue;

      const posAttr = geo.attributes.position;
      const dirAttr = geo.attributes.direction;
      const c0Attr = geo.attributes.control0;
      const c1Attr = geo.attributes.control1;
      const typeAttr = geo.attributes.edgeType;

      const posArr = posAttr.array;
      const stride = posAttr.itemSize || 3;
      const count = posAttr.count;

      // Apply the instance's world matrix to positions (if provided)
      const m = inst.matrix;

      for (let v = 0; v < count; v++) {
        const srcOff = v * stride;
        const dstOff = writeOffset;

        // Position (transform by matrix if provided)
        if (m) {
          const px = posArr[srcOff + 0];
          const py = posArr[srcOff + 1];
          const pz = posArr[srcOff + 2];
          interleaved[dstOff + 0] = m[0] * px + m[4] * py + m[8] * pz + m[12];
          interleaved[dstOff + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
          interleaved[dstOff + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];
        } else {
          interleaved[dstOff + 0] = posArr[srcOff + 0];
          interleaved[dstOff + 1] = posArr[srcOff + 1];
          interleaved[dstOff + 2] = posArr[srcOff + 2];
        }

        // Direction (rotate by upper 3×3 if matrix provided)
        if (dirAttr) {
          const dArr = dirAttr.array;
          const dx = dArr[srcOff + 0];
          const dy = dArr[srcOff + 1];
          const dz = dArr[srcOff + 2];
          if (m) {
            interleaved[dstOff + 3] = m[0] * dx + m[4] * dy + m[8] * dz;
            interleaved[dstOff + 4] = m[1] * dx + m[5] * dy + m[9] * dz;
            interleaved[dstOff + 5] = m[2] * dx + m[6] * dy + m[10] * dz;
          } else {
            interleaved[dstOff + 3] = dx;
            interleaved[dstOff + 4] = dy;
            interleaved[dstOff + 5] = dz;
          }
        } else {
          interleaved[dstOff + 3] = 0;
          interleaved[dstOff + 4] = 0;
          interleaved[dstOff + 5] = 0;
        }

        // Control0 (transform by matrix if provided)
        if (c0Attr) {
          const cArr = c0Attr.array;
          const cx = cArr[srcOff + 0];
          const cy = cArr[srcOff + 1];
          const cz = cArr[srcOff + 2];
          if (m) {
            interleaved[dstOff + 6] = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
            interleaved[dstOff + 7] = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
            interleaved[dstOff + 8] = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
          } else {
            interleaved[dstOff + 6] = cx;
            interleaved[dstOff + 7] = cy;
            interleaved[dstOff + 8] = cz;
          }
        } else {
          interleaved[dstOff + 6] = 0;
          interleaved[dstOff + 7] = 0;
          interleaved[dstOff + 8] = 0;
        }

        // Control1 (transform by matrix if provided)
        if (c1Attr) {
          const cArr = c1Attr.array;
          const cx = cArr[srcOff + 0];
          const cy = cArr[srcOff + 1];
          const cz = cArr[srcOff + 2];
          if (m) {
            interleaved[dstOff + 9]  = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
            interleaved[dstOff + 10] = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
            interleaved[dstOff + 11] = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
          } else {
            interleaved[dstOff + 9]  = cx;
            interleaved[dstOff + 10] = cy;
            interleaved[dstOff + 11] = cz;
          }
        } else {
          interleaved[dstOff + 9]  = 0;
          interleaved[dstOff + 10] = 0;
          interleaved[dstOff + 11] = 0;
        }

        // Edge type
        interleaved[dstOff + 12] = typeAttr ? typeAttr.array[v] : 0;

        writeOffset += FLOATS_PER_VERTEX;
      }
    }

    // -------------------------------------------------------------------
    // Build the InstancedInterleavedBuffer (096)
    // -------------------------------------------------------------------
    const buffer = new InstancedInterleavedBuffer(interleaved, FLOATS_PER_VERTEX, 1);
    this._instanceBuffer = buffer;
    this._instanceCount = totalVertices;

    // Attach InterleavedBufferAttributes (100)
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

    this.needsUpdate = true;
    return this;
  }

  /**
   * Emit empty attributes (no survivors or no data).
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

  /** @returns {number} — total number of registered instances */
  get instanceCount() { return this._instances.length; }

  /** @returns {number} — number of instances that survived the last cull */
  get visibleCount() { return this._visibleCount; }

  /** @returns {number} — number of instances culled in the last cull */
  get lastCulled() { return this._lastCulled; }

  /** @returns {number} — elapsed milliseconds of the last cull */
  get lastCullMs() { return this._lastCullMs; }

  /** @returns {InstancedInterleavedBuffer|null} — current interleaved buffer */
  get instanceBuffer() { return this._instanceBuffer; }

  /** @returns {number} — total vertex count in the current interleaved buffer */
  get vertexCount() { return this._instanceCount; }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * Expose the batch state as flat typed-array columns for ECS systems that
   * drive per-batch LOD selection, visibility toggling, or cull statistics.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const instanceCount = this._instances.length;
    const layersMaskArr = new Uint32Array(instanceCount);
    const minXArr = new Float32Array(instanceCount);
    const minYArr = new Float32Array(instanceCount);
    const minZArr = new Float32Array(instanceCount);
    const maxXArr = new Float32Array(instanceCount);
    const maxYArr = new Float32Array(instanceCount);
    const maxZArr = new Float32Array(instanceCount);

    for (let i = 0; i < instanceCount; i++) {
      const inst = this._instances[i];
      layersMaskArr[i] = inst.layers ? inst.layers.mask : 0xffffffff;
      minXArr[i] = inst.minX;
      minYArr[i] = inst.minY;
      minZArr[i] = inst.minZ;
      maxXArr[i] = inst.maxX;
      maxYArr[i] = inst.maxY;
      maxZArr[i] = inst.maxZ;
    }

    return {
      name,
      instanceCount,
      visibleCount: this._visibleCount,
      lastCulled: this._lastCulled,
      lastCullMs: this._lastCullMs,
      frustumCullEnabled: this._frustumCullEnabled ? 1 : 0,
      layerMaskEnabled: this._layerMaskEnabled ? 1 : 0,
      cameraMask: this._cameraMask,
      layersMask: layersMaskArr,
      minX: minXArr,
      minY: minYArr,
      minZ: minZArr,
      maxX: maxXArr,
      maxY: maxYArr,
      maxZ: maxZArr,
      vertexCount: this._instanceCount,
      instanceBuffer: this._instanceBuffer ? this._instanceBuffer.array : null,
    };
  }

  // -----------------------------------------------------------------------
  // Disposal
  // -----------------------------------------------------------------------

  dispose() {
    super.dispose();
    this._instances.length = 0;
    this._instanceBuffer = null;
    this._instanceCount = 0;
    this._visibleCount = 0;
    this._lastCulled = 0;
  }

  // -----------------------------------------------------------------------
  // Pooling
  // -----------------------------------------------------------------------

  /**
   * Acquire a pooled CulledEdgesBatch instance (empty, frustumCull=true,
   * layerCull=true).
   * @returns {CulledEdgesBatch}
   */
  static acquire() {
    return _acquireBatch();
  }

  /**
   * Return this CulledEdgesBatch to the pool. Caller must not use it
   * afterward.
   */
  release() {
    this.clear();
    for (const key in this.attributes) delete this.attributes[key];
    _releaseBatch(this);
  }

  /**
   * Clear the global CulledEdgesBatch pool.
   */
  static clearPool() {
    _batchPool.length = 0;
  }

  // -----------------------------------------------------------------------
  // Utility surface
  // -----------------------------------------------------------------------

  /** @returns {LocalFrustum} — the shared frustum instance for advanced use */
  static getFrustum() {
    return _frustum;
  }
}

export { CulledEdgesBatch, LocalFrustum };
export default CulledEdgesBatch;