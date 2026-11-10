// file number : 100
// full path name : src/core/100_InterleavedBufferAttribute.js
// description : High-performance InterleavedBufferAttribute rewritten as a pure ES module with zero CDN imports. Provides the per-attribute view into an InterleavedBuffer (099), exposing stride-aware get/set accessors, offset indexing, applyMatrix4/applyNormalMatrix via the project's native Mat3/Mat4 modules, and a BitECS SoA bridge. Adds pooled instances, zero-allocation hot paths, SimplexNoise procedural utilities, and backward compatibility with BufferAttribute's public surface. Designed for 10k+ entities on Android 64-bit without GC pressure.
// best for : Interleaved vertex layouts (positions+normals+UVs in one buffer), instanced attributes, morph-target packing, and any ECS-driven geometry pipeline that must minimise draw calls while scaling from local props to galactic-scale scenes.
// license : MIT

import { Constants } from '../math/002_Constants.js';
import { Common } from '../math/003_Common.js';
import { Precision } from '../math/004_Precision.js';
import { Vec2 } from '../math/005_Vec2.js';
import { Vec3 } from '../math/006_Vec3.js';
import { Vec4 } from '../math/007_Vec4.js';
import { Mat2 } from '../math/008_Mat2.js';
import { Mat3 } from '../math/009_Mat3.js';
import { Mat4 } from '../math/010_Mat4.js';
import { Quat } from '../math/011_Quat.js';
import { Quat2 } from '../math/012_Quat2.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';
import { BitECS } from '../ecs/014_BitECS.js';
import { World } from '../ecs/015_World.js';
import { Components } from '../ecs/016_Components.js';
import { Systems } from '../ecs/017_Systems.js';
import { BufferAttribute } from './094_BufferAttribute.js';
import { InterleavedBuffer } from './099_InterleavedBuffer.js';

// ---------------------------------------------------------------------------
// Static pool for InterleavedBufferAttribute instances – recycled to
// eliminate per-geometry allocation churn when 10k+ entities spawn/despawn.
// ---------------------------------------------------------------------------
const _ibaPool = [];

/**
 * Acquire an InterleavedBufferAttribute from the pool (reset to default state).
 * @returns {InterleavedBufferAttribute}
 */
function acquireIBA() {
  const a = _ibaPool.pop();
  if (a) {
    a.data = null;
    a.itemSize = 1;
    a.offset = 0;
    a.normalized = false;
    a.name = '';
    a._version = 0;
    a._needsUpdate = false;
    return a;
  }
  return new InterleavedBufferAttribute(new InterleavedBuffer(new Float32Array(0), 1), 1, 0, false);
}

/**
 * Return an InterleavedBufferAttribute to the pool. Caller must not use it
 * afterward.
 * @param {InterleavedBufferAttribute} a
 */
function releaseIBA(a) {
  if (_ibaPool.length < 128) _ibaPool.push(a);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _vec3 = new Float32Array(3);
const _vec4 = new Float32Array(4);

// ---------------------------------------------------------------------------
// Utility surface – bridges to Vec3/Vec4/Mat3/Mat4, SimplexNoise, and BitECS.
// All helpers are allocation-free unless they explicitly create a pooled array.
// ---------------------------------------------------------------------------
const InterleavedBufferAttributeUtils = {
  /**
   * Normalize a scalar value into [0,1] using Common.clamp.
   * @param {number} value
   * @returns {number}
   */
  normalizeScalar(value) {
    return Common.clamp(value, 0, 1);
  },

  /**
   * Denormalize a normalized value back to its integer range.
   * @param {number} value
   * @param {number} maxValue
   * @returns {number}
   */
  denormalizeScalar(value, maxValue) {
    return value * maxValue;
  },

  /**
   * Compute the normalization scale for a given typed-array constructor.
   * @param {Function} arrayType
   * @returns {number}
   */
  getNormalizationScale(arrayType) {
    if (arrayType === Uint8Array) return 255;
    if (arrayType === Uint16Array) return 65535;
    if (arrayType === Uint32Array) return 4294967295;
    if (arrayType === Int8Array) return 127;
    if (arrayType === Int16Array) return 32767;
    return 1;
  },

  /**
   * Pack a Vec3-like value into a Float32Array using the project's native
   * Vec3 module.
   * @param {Float32Array} [out]
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {Float32Array}
   */
  packVec3(out, x, y, z) {
    const o = out || _vec3;
    Vec3.set(o, x, y, z);
    return o;
  },

  /**
   * Pack a Vec4-like value into a Float32Array using the project's native
   * Vec4 module.
   * @param {Float32Array} [out]
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} w
   * @returns {Float32Array}
   */
  packVec4(out, x, y, z, w) {
    const o = out || _vec4;
    Vec4.set(o, x, y, z, w);
    return o;
  },

  /**
   * Register a BitECS SoA component column set for an interleaved attribute.
   * @param {string} name
   * @param {number} count
   * @param {number} itemSize
   * @returns {{ name: string, column: Float32Array, count: number, itemSize: number }}
   */
  registerComponent(name, count, itemSize) {
    return {
      name,
      column: new Float32Array(count * itemSize),
      count,
      itemSize,
    };
  },

  // --- SimplexNoise bridges (procedural attribute jitter) ----------------

  noise2D: (x, y) => SimplexNoise.noise2D(x, y),
  noise3D: (x, y, z) => SimplexNoise.noise3D(x, y, z),
  noise4D: (x, y, z, w) => SimplexNoise.noise4D(x, y, z, w),

  // --- BitECS surface -----------------------------------------------------

  BitECS,
  World,
  Components,
  Systems,
};

/**
 * InterleavedBufferAttribute
 * A per-attribute view into an InterleavedBuffer. Each attribute reads and
 * writes its components at `index * data.stride + offset` within the shared
 * buffer, allowing multiple attributes to share a single typed array.
 *
 * Features:
 * – Pooled instances (acquire / release).
 * – Zero-allocation getX/setX/getY/setY/getZ/setZ/getW/setW with stride-aware
 *   indexing and optional normalization.
 * – Zero-allocation setXY/setXYZ/setXYZW, getComponent, setComponent.
 * – applyMatrix4 and applyNormalMatrix via the project's Mat3/Mat4 modules
 *   (no gl-matrix).
 * – BitECS bridge: asBitecsComponent(name, count) produces a Float32Array.
 * – Native Common.clamp for normalization helpers (no MathUtils dependency).
 * – SimplexNoise utilities for procedural attribute data.
 * – Backward-compatible with BufferAttribute's public surface.
 * – No static server, no bundler, no CDN dependency.
 */
class InterleavedBufferAttribute {
  /**
   * @param {InterleavedBuffer} interleavedBuffer – the shared buffer
   * @param {number} itemSize – components per vertex
   * @param {number} offset – offset into the interleaved buffer
   * @param {boolean} [normalized=false] – whether integer data is normalized
   */
  constructor(interleavedBuffer, itemSize, offset, normalized = false) {
    this.isInterleavedBufferAttribute = true;

    this.name = '';

    this.data = interleavedBuffer;
    this.itemSize = itemSize;
    this.offset = offset;
    this.normalized = normalized;

    this._version = 0;
    this._needsUpdate = false;
  }

  // --- Core accessors -----------------------------------------------------

  /** @returns {TypedArray} the underlying interleaved array */
  get array() {
    return this.data.array;
  }

  /** @returns {number} the number of vertices */
  get count() {
    return this.data.count;
  }

  // --- Update lifecycle ---------------------------------------------------

  /** @returns {boolean} */
  get needsUpdate() {
    return this.data.needsUpdate;
  }

  set needsUpdate(v) {
    this.data.needsUpdate = v;
  }

  /** @returns {number} */
  get version() {
    return this.data.version;
  }

  // --- Get accessors ------------------------------------------------------

  getX(index) {
    let x = this.data.array[index * this.data.stride + this.offset];
    if (this.normalized) x = this.denormalize(x);
    return x;
  }

  getY(index) {
    let y = this.data.array[index * this.data.stride + this.offset + 1];
    if (this.normalized) y = this.denormalize(y);
    return y;
  }

  getZ(index) {
    let z = this.data.array[index * this.data.stride + this.offset + 2];
    if (this.normalized) z = this.denormalize(z);
    return z;
  }

  getW(index) {
    let w = this.data.array[index * this.data.stride + this.offset + 3];
    if (this.normalized) w = this.denormalize(w);
    return w;
  }

  /**
   * Return the given component of the vector at the given index.
   * @param {number} index
   * @param {number} component
   * @returns {number}
   */
  getComponent(index, component) {
    let value = this.data.array[index * this.data.stride + this.offset + component];
    if (this.normalized) value = this.denormalize(value);
    return value;
  }

  // --- Set accessors ------------------------------------------------------

  setX(index, x) {
    if (this.normalized) x = this.normalize(x);
    this.data.array[index * this.data.stride + this.offset] = x;
    return this;
  }

  setY(index, y) {
    if (this.normalized) y = this.normalize(y);
    this.data.array[index * this.data.stride + this.offset + 1] = y;
    return this;
  }

  setZ(index, z) {
    if (this.normalized) z = this.normalize(z);
    this.data.array[index * this.data.stride + this.offset + 2] = z;
    return this;
  }

  setW(index, w) {
    if (this.normalized) w = this.normalize(w);
    this.data.array[index * this.data.stride + this.offset + 3] = w;
    return this;
  }

  setXY(index, x, y) {
    if (this.normalized) { x = this.normalize(x); y = this.normalize(y); }
    const i = index * this.data.stride + this.offset;
    this.data.array[i + 0] = x;
    this.data.array[i + 1] = y;
    return this;
  }

  setXYZ(index, x, y, z) {
    if (this.normalized) { x = this.normalize(x); y = this.normalize(y); z = this.normalize(z); }
    const i = index * this.data.stride + this.offset;
    this.data.array[i + 0] = x;
    this.data.array[i + 1] = y;
    this.data.array[i + 2] = z;
    return this;
  }

  setXYZW(index, x, y, z, w) {
    if (this.normalized) {
      x = this.normalize(x); y = this.normalize(y);
      z = this.normalize(z); w = this.normalize(w);
    }
    const i = index * this.data.stride + this.offset;
    this.data.array[i + 0] = x;
    this.data.array[i + 1] = y;
    this.data.array[i + 2] = z;
    this.data.array[i + 3] = w;
    return this;
  }

  /**
   * Set the given component of the vector at the given index.
   * @param {number} index
   * @param {number} component
   * @param {number} value
   * @returns {this}
   */
  setComponent(index, component, value) {
    if (this.normalized) value = this.normalize(value);
    this.data.array[index * this.data.stride + this.offset + component] = value;
    return this;
  }

  // --- Normalization helpers ---------------------------------------------

  normalize(value) {
    return InterleavedBufferAttributeUtils.normalizeScalar(value);
  }

  denormalize(value) {
    const max = InterleavedBufferAttributeUtils.getNormalizationScale(this.data.array.constructor);
    return InterleavedBufferAttributeUtils.denormalizeScalar(value, max);
  }

  // --- Matrix application ------------------------------------------------

  /**
   * Apply a 4×4 matrix to every Vec3 element of this attribute.
   * Only works with itemSize === 3.
   * @param {Float32Array} m – length 16 column-major Mat4
   * @returns {this}
   */
  applyMatrix4(m) {
    if (this.itemSize !== 3) return this;

    const v = _vec3;
    for (let i = 0; i < this.count; i++) {
      Vec3.set(v, this.getX(i), this.getY(i), this.getZ(i));
      Vec3.transformMat4(v, v, m);
      this.setXYZ(i, v[0], v[1], v[2]);
    }
    return this;
  }

  /**
   * Apply a 3×3 normal matrix to every Vec3 element of this attribute.
   * Only works with itemSize === 3. The result is NOT normalized (matching
   * three.js behaviour).
   * @param {Float32Array} m – length 9 row-major Mat3
   * @returns {this}
   */
  applyNormalMatrix(m) {
    if (this.itemSize !== 3) return this;

    const v = _vec3;
    for (let i = 0; i < this.count; i++) {
      Vec3.set(v, this.getX(i), this.getY(i), this.getZ(i));
      Vec3.transformMat3(v, v, m);
      this.setXYZ(i, v[0], v[1], v[2]);
    }
    return this;
  }

  // --- Clone / Serialization ---------------------------------------------

  /**
   * Return a new BufferAttribute (de-interleaved) or a new
   * InterleavedBufferAttribute (interleaved) depending on the `data` argument.
   * @param {object} [data] – optional serialization context
   * @returns {BufferAttribute|InterleavedBufferAttribute}
   */
  clone(data) {
    if (data === undefined) {
      // De-interleave into a plain BufferAttribute
      const array = [];
      for (let i = 0; i < this.count; i++) {
        const index = i * this.data.stride + this.offset;
        for (let j = 0; j < this.itemSize; j++) {
          array.push(this.data.array[index + j]);
        }
      }
      return new BufferAttribute(
        new this.data.array.constructor(array),
        this.itemSize,
        this.normalized,
      );
    }

    // Retain interleaved structure
    if (data.interleavedBuffers === undefined) {
      data.interleavedBuffers = {};
    }
    if (data.interleavedBuffers[this.data.uuid] === undefined) {
      data.interleavedBuffers[this.data.uuid] = this.data.clone(data);
    }
    return new InterleavedBufferAttribute(
      data.interleavedBuffers[this.data.uuid],
      this.itemSize,
      this.offset,
      this.normalized,
    );
  }

  /**
   * Serialize to JSON. De-interleaves into a plain object when `data` is
   * omitted, matching three.js r185 behaviour.
   * @param {object} [data]
   * @returns {object}
   */
  toJSON(data) {
    if (data === undefined) {
      const array = [];
      for (let i = 0; i < this.count; i++) {
        const index = i * this.data.stride + this.offset;
        for (let j = 0; j < this.itemSize; j++) {
          array.push(this.data.array[index + j]);
        }
      }
      return {
        itemSize: this.itemSize,
        type: this.data.array.constructor.name,
        array,
        normalized: this.normalized,
      };
    }

    if (data.interleavedBuffers === undefined) {
      data.interleavedBuffers = {};
    }
    if (data.interleavedBuffers[this.data.uuid] === undefined) {
      data.interleavedBuffers[this.data.uuid] = this.data.toJSON(data);
    }
    return {
      isInterleavedBufferAttribute: true,
      itemSize: this.itemSize,
      data: this.data.uuid,
      offset: this.offset,
      normalized: this.normalized,
    };
  }

  // --- Copy --------------------------------------------------------------

  /**
   * Copy another InterleavedBufferAttribute into this one.
   * @param {InterleavedBufferAttribute} source
   * @returns {this}
   */
  copy(source) {
    this.name = source.name;
    this.data = source.data;
    this.itemSize = source.itemSize;
    this.offset = source.offset;
    this.normalized = source.normalized;
    return this;
  }

  // --- BitECS bridge ------------------------------------------------------

  /**
   * Produce a BitECS SoA component column filled with this attribute's data
   * (de-interleaved into a contiguous Float32Array).
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, column: Float32Array, count: number, itemSize: number }}
   */
  asBitecsComponent(name, count) {
    const comp = InterleavedBufferAttributeUtils.registerComponent(name, count, this.itemSize);
    const col = comp.column;
    const size = this.itemSize;
    const limit = Math.min(count, this.count);
    const stride = this.data.stride;
    const off = this.offset;
    const arr = this.data.array;

    for (let i = 0; i < limit; i++) {
      const srcBase = i * stride + off;
      const dstBase = i * size;
      for (let j = 0; j < size; j++) {
        col[dstBase + j] = arr[srcBase + j];
      }
    }
    return comp;
  }

  // --- Pooling ------------------------------------------------------------

  /**
   * Acquire a pooled InterleavedBufferAttribute instance (empty).
   * @returns {InterleavedBufferAttribute}
   */
  static acquire() {
    return acquireIBA();
  }

  /**
   * Return this InterleavedBufferAttribute to the pool. Caller must not use
   * it afterward.
   */
  release() {
    releaseIBA(this);
  }

  /**
   * Clear the global InterleavedBufferAttribute pool.
   */
  static clearPool() {
    _ibaPool.length = 0;
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = InterleavedBufferAttributeUtils;
}

export { InterleavedBufferAttribute, InterleavedBufferAttributeUtils };