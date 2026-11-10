// file number : 099
// full path name : src/core/099_InterleavedBuffer.js
// description : High-performance InterleavedBuffer rewritten as a pure ES module with zero CDN imports. Provides the base class for InstancedInterleavedBuffer (096), storing multiple vertex attributes in a single typed array with a fixed stride. Adds pooled instance management, zero-allocation setArray/setStride/copyAt/clear, updateRange support, Vec4/Mat4 header packing via the project's native math primitives, high-precision byte accounting through JS Float64 (no double.js), SimplexNoise procedural utilities, and a BitECS SoA bridge. Designed for 10k+ entities on Android 64-bit without GC pressure.
// best for : Single-buffer vertex storage with manual stride layout (positions+normals+UV in one array), morph-target packing, GPU-friendlier VBO layouts, and any ECS-driven geometry pipeline that must minimise draw calls while scaling from local props to galactic-scale scenes.
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

// ---------------------------------------------------------------------------
// Static pool for InterleavedBuffer instances – recycled to eliminate
// per-geometry allocation churn when 10k+ entities spawn/despawn in an ECS.
// ---------------------------------------------------------------------------
const _interleavedPool = [];

/**
 * Acquire an InterleavedBuffer from the pool (reset to default state).
 * @returns {InterleavedBuffer}
 */
function acquireInterleaved() {
  const b = _interleavedPool.pop();
  if (b) {
    b.array = null;
    b.stride = 1;
    b.count = 0;
    b.usage = Constants.StaticDrawUsage;
    b.updateRange.offset = 0;
    b.updateRange.count = -1;
    b.updateRanges.length = 0;
    b.version = 0;
    b._needsUpdate = false;
    b.uuid = '';
    return b;
  }
  return new InterleavedBuffer(new Float32Array(0), 1);
}

/**
 * Return an InterleavedBuffer to the pool. Caller must not use it afterward.
 * @param {InterleavedBuffer} b
 */
function releaseInterleaved(b) {
  if (_interleavedPool.length < 128) _interleavedPool.push(b);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _scratchVec4 = new Float32Array(4);
const _scratchMat4 = new Float32Array(16);

let _id = 0;

// Simple UUID v4 generator (no CDN, no crypto requirement, deterministic
// per-instance uniqueness sufficient for renderer bookkeeping).
function generateUUID() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      s += '-';
    } else if (i === 14) {
      s += '4';
    } else if (i === 19) {
      s += hex[(Math.random() * 4 | 0) + 8];
    } else {
      s += hex[(Math.random() * 16) | 0];
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Utility surface – bridges to Vec4/Mat4, SimplexNoise, and BitECS.
// All helpers are allocation-free unless they explicitly create a pooled array.
// ---------------------------------------------------------------------------
const InterleavedBufferUtils = {
  /**
   * Clamp a stride to a valid positive integer using Common.clamp.
   * @param {number} value
   * @returns {number}
   */
  clampStride(value) {
    return Common.clamp(Math.floor(value), 1, Infinity);
  },

  /**
   * Pack (stride, count, byteLength, version) into a Vec4 using the
   * project's native Vec4 + Mat4 primitives (replaces gl-matrix).
   * @param {Float32Array} [out] – length 4 output buffer
   * @param {number} stride
   * @param {number} count
   * @param {number} byteLength
   * @param {number} version
   * @returns {Float32Array}
   */
  packHeaderToVec4(out, stride, count, byteLength, version) {
    const o = out || _scratchVec4;
    Mat4.identity(_scratchMat4);
    Vec4.set(o, stride, count, byteLength, version);
    Vec4.transformMat4(o, o, _scratchMat4);
    return o;
  },

  /**
   * High-precision total byte length of the underlying typed array.
   * JS Float64 is IEEE-754 double precision, so no double.js dependency.
   * @param {TypedArray} array
   * @returns {number}
   */
  totalBytes(array) {
    if (!array) return 0;
    const bytesPerElement = array.BYTES_PER_ELEMENT || 4;
    return array.length * bytesPerElement;
  },

  /**
   * Register a BitECS SoA component column set for interleaved buffer state.
   * @param {string} name
   * @param {number} count
   * @param {number} stride
   * @returns {{ name: string, column: Float32Array, stride: number, count: number }}
   */
  registerComponent(name, count, stride) {
    return {
      name,
      column: new Float32Array(count * stride),
      stride,
      count,
    };
  },

  // --- SimplexNoise bridges (procedural interleaved data) ----------------

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
 * InterleavedBuffer
 * A typed array where multiple vertex attributes share a single buffer with
 * a fixed stride. Each attribute consumes `stride` elements per vertex, and
 * attribute offsets are provided at attribute-construction time (typically
 * by InterleavedBufferAttribute, the companion class).
 *
 * Features:
 * – Pooled instances (acquire / release).
 * – Zero-allocation setArray / setStride / copyAt / clear / setUsage.
 * – Vec4 header packing via the project's native math modules (no gl-matrix).
 * – High-precision byte accounting via JS Float64 (no double.js).
 * – BitECS SoA bridge: asBitecsComponent(name, count) produces a Float32Array.
 * – SimplexNoise utilities for procedural interleaved data.
 * – UUID for renderer bookkeeping without external crypto dependencies.
 * – No static server, no bundler, no CDN dependency.
 */
class InterleavedBuffer {
  /**
   * @param {TypedArray} array – the interleaved data
   * @param {number} stride – number of typed-array elements per vertex
   */
  constructor(array, stride) {
    this.isInterleavedBuffer = true;
    Object.defineProperty(this, 'id', { value: _id++ });

    this.array = array;
    this.stride = stride;
    this.count = array !== undefined ? array.length / stride : 0;

    this.usage = Constants.StaticDrawUsage;

    this.updateRange = { offset: 0, count: -1 };
    this.updateRanges = [];

    this.version = 0;
    this._needsUpdate = false;

    this.uuid = generateUUID();
  }

  // --- Array management ---------------------------------------------------

  /**
   * Set the typed array and recompute count. Throws if a regular Array is
   * passed.
   * @param {TypedArray} array
   * @returns {this}
   */
  setArray(array) {
    if (Array.isArray(array)) {
      throw new TypeError('THREE.InterleavedBuffer: array should be a Typed Array.');
    }
    this.count = array !== undefined ? array.length / this.stride : 0;
    this.array = array;
    return this;
  }

  /**
   * Change the usage pattern (StaticDrawUsage, DynamicDrawUsage, etc.).
   * @param {number} value
   * @returns {this}
   */
  setUsage(value) {
    this.usage = value;
    return this;
  }

  /**
   * Change the stride and recompute count. The array is preserved.
   * @param {number} stride
   * @returns {this}
   */
  setStride(stride) {
    const s = InterleavedBufferUtils.clampStride(stride);
    this.stride = s;
    this.count = this.array !== undefined ? this.array.length / s : 0;
    return this;
  }

  // --- Update lifecycle ---------------------------------------------------

  /** @returns {number} */
  get needsUpdate() { return this._needsUpdate; }

  set needsUpdate(v) {
    if (v) {
      this.version++;
      this._needsUpdate = true;
    } else {
      this._needsUpdate = false;
    }
  }

  // --- Copy methods -------------------------------------------------------

  /**
   * Copy a single interleaved vertex from another InterleavedBuffer.
   * @param {number} index1 – destination vertex index
   * @param {InterleavedBuffer} interleavedBuffer – source buffer
   * @param {number} index2 – source vertex index
   * @returns {this}
   */
  copyAt(index1, interleavedBuffer, index2) {
    const dst = this.array;
    const src = interleavedBuffer.array;
    const stride = this.stride;

    let i = index1 * stride;
    let j = index2 * stride;

    for (let k = 0; k < stride; k++) {
      dst[i++] = src[j++];
    }
    return this;
  }

  /**
   * Copy an entire array into the underlying typed array.
   * @param {Array|TypedArray} array
   * @returns {this}
   */
  copyArray(array) {
    this.array.set(array);
    return this;
  }

  /**
   * Copy all vertices from another InterleavedBuffer (must match array type).
   * @param {InterleavedBuffer} source
   * @returns {this}
   */
  copy(source) {
    this.array = new source.array.constructor(source.array);
    this.stride = source.stride;
    this.count = source.count;
    this.usage = source.usage;
    this.version = source.version;
    return this;
  }

  // --- Update ranges ------------------------------------------------------

  /**
   * Add an update range (r185 multiple-update-range support).
   * @param {number} start
   * @param {number} count
   * @returns {this}
   */
  addUpdateRange(start, count) {
    this.updateRanges.push({ start, count });
    return this;
  }

  /**
   * Clear all update ranges.
   * @returns {this}
   */
  clearUpdateRanges() {
    this.updateRanges.length = 0;
    return this;
  }

  // --- Convenience accessors ---------------------------------------------

  /**
   * Pack (stride, count, byteLength, version) into a Vec4 for shader uniforms.
   * @param {Float32Array} [out]
   * @returns {Float32Array}
   */
  packHeaderToVec4(out) {
    return InterleavedBufferUtils.packHeaderToVec4(
      out,
      this.stride,
      this.count,
      InterleavedBufferUtils.totalBytes(this.array),
      this.version,
    );
  }

  /**
   * Return the total byte length of the underlying typed array.
   * @returns {number}
   */
  getTotalBytes() {
    return InterleavedBufferUtils.totalBytes(this.array);
  }

  /**
   * Produce a BitECS SoA component column filled with this buffer's data.
   * @param {string} name
   * @returns {{ name: string, column: Float32Array, stride: number, count: number }}
   */
  asBitecsComponent(name) {
    const comp = InterleavedBufferUtils.registerComponent(name, this.count, this.stride);
    const col = comp.column;
    const src = this.array;
    const len = Math.min(col.length, src.length);
    for (let i = 0; i < len; i++) col[i] = src[i];
    return comp;
  }

  // --- Disposal -----------------------------------------------------------

  /**
   * Clear this buffer's data (does not return the instance to the pool –
   * call release() for that).
   */
  clear() {
    this.array = null;
    this.stride = 1;
    this.count = 0;
    this.updateRange.offset = 0;
    this.updateRange.count = -1;
    this.updateRanges.length = 0;
    this.version = 0;
    this._needsUpdate = false;
  }

  // --- Pooling ------------------------------------------------------------

  /**
   * Acquire a pooled InterleavedBuffer instance (empty).
   * @returns {InterleavedBuffer}
   */
  static acquire() {
    return acquireInterleaved();
  }

  /**
   * Return this InterleavedBuffer to the pool. Caller must not use it
   * afterward.
   */
  release() {
    releaseInterleaved(this);
  }

  /**
   * Clear the global InterleavedBuffer pool.
   */
  static clearPool() {
    _interleavedPool.length = 0;
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = InterleavedBufferUtils;
}

export { InterleavedBuffer, InterleavedBufferUtils };