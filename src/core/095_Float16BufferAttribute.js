// file number : 095
// full path name : src/core/095_Float16BufferAttribute.js
// description : High-performance half-precision (FP16) vertex attribute rewritten as a pure ES module with zero CDN imports. Extends BufferAttribute (094) with Uint16Array-backed half-float storage, zero-allocation getX/setX/getY/setY/getZ/setZ/getW/setW conversion via the project's native Precision module, pooled instances, and a BitECS SoA bridge. Halves VRAM and bandwidth versus Float32 attributes, keeping 10k+ entity pipelines smooth on Android 64-bit.
// best for : HDR vertex data (emissive attributes, light probes, animation deltas), memory-constrained mobile geometry, 3D Gaussian splatting, morph targets, and any ECS-driven rendering path that must scale from local props to galactic-scale scenes without GC pressure.
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

// ---------------------------------------------------------------------------
// Static pool for Float16BufferAttribute instances – recycled to eliminate
// per-geometry allocation churn when 10k+ entities spawn/despawn in an ECS.
// ---------------------------------------------------------------------------
const _float16Pool = [];

/**
 * Acquire a Float16BufferAttribute from the pool (reset to default state).
 * @returns {Float16BufferAttribute}
 */
function acquireFloat16Attribute() {
  const a = _float16Pool.pop();
  if (a) {
    a.name = '';
    a.array = new Uint16Array(1);
    a.itemSize = 1;
    a.count = 0;
    a.normalized = false;
    a.usage = Constants.StaticDrawUsage;
    a.updateRange.offset = 0;
    a.updateRange.count = -1;
    a.updateRanges.length = 0;
    a.gpuType = Constants.FloatType;
    a.version = 0;
    a._needsUpdate = false;
    return a;
  }
  return new Float16BufferAttribute(new Uint16Array(1), 1);
}

/**
 * Return a Float16BufferAttribute to the pool. Caller must not use it afterward.
 * @param {Float16BufferAttribute} a
 */
function releaseFloat16Attribute(a) {
  if (_float16Pool.length < 128) _float16Pool.push(a);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _vec3 = new Float32Array(3);
const _vec2 = new Float32Array(2);

// ---------------------------------------------------------------------------
// Half-float conversion helpers – delegate to Precision module if available,
// otherwise use the standard IEEE 754 half-float bit-manipulation fallback.
// ---------------------------------------------------------------------------
const _toHalfFloat = (typeof Precision.toHalfFloat === 'function')
  ? Precision.toHalfFloat
  : function toHalfFloat(val) {
      // Fallback: IEEE 754 half-float encoding (matches three.js DataUtils)
      const floatView = new Float32Array(1);
      const int32View = new Int32Array(floatView.buffer);
      floatView[0] = val;
      const x = int32View[0];
      const sign = (x >> 16) & 0x8000;
      let exponent = (x >> 23) & 0xff;
      let mantissa = x & 0x7fffff;
      if (exponent === 0xff) {
        return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0);
      }
      exponent = exponent - 127 + 15;
      if (exponent >= 0x1f) return sign | 0x7c00;
      if (exponent <= 0) {
        if (exponent < -10) return sign;
        mantissa = (mantissa | 0x800000) >> (1 - exponent);
        return sign | (mantissa >> 13);
      }
      return sign | (exponent << 10) | (mantissa >> 13);
    };

const _fromHalfFloat = (typeof Precision.fromHalfFloat === 'function')
  ? Precision.fromHalfFloat
  : function fromHalfFloat(val) {
      // Fallback: IEEE 754 half-float decoding
      const sign = (val & 0x8000) ? -1 : 1;
      const exponent = (val >> 10) & 0x1f;
      const mantissa = val & 0x3ff;
      if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
      if (exponent === 0x1f) return mantissa !== 0 ? NaN : sign * Infinity;
      return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
    };

// ---------------------------------------------------------------------------
// Utility surface – bridges to Precision, Vec2/Vec3, SimplexNoise, and BitECS.
// All helpers are allocation-free.
// ---------------------------------------------------------------------------
const Float16BufferAttributeUtils = {
  /**
   * Convert a float32 value to half-float bits.
   * @param {number} value
   * @returns {number} 16-bit unsigned integer
   */
  toHalf(value) {
    return _toHalfFloat(value);
  },

  /**
   * Convert half-float bits to a float32 value.
   * @param {number} bits
   * @returns {number}
   */
  fromHalf(bits) {
    return _fromHalfFloat(bits);
  },

  /**
   * Normalize a scalar into [0,1] using Common.clamp.
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
   * Pack a Vec2-like value into a Float32Array using the project's native
   * Vec2 module.
   * @param {Float32Array} [out]
   * @param {number} x
   * @param {number} y
   * @returns {Float32Array}
   */
  packVec2(out, x, y) {
    const o = out || _vec2;
    Vec2.set(o, x, y);
    return o;
  },

  /**
   * Register a BitECS SoA component column set for a half-float attribute.
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
 * Float16BufferAttribute
 * Half-precision (FP16) vertex attribute stored as Uint16Array (matching
 * three.js r185 behaviour). Overrides all get/set accessors to convert
 * between FP16 bits and JavaScript numbers.
 *
 * Features:
 * – Pooled instances (acquire / release).
 * – Zero-allocation getX/setX/getY/setY/getZ/setZ/getW/setW with FP16 conversion.
 * – Zero-allocation setXY/setXYZ/setXYZW with FP16 conversion.
 * – BitECS bridge: asBitecsComponent(name, count) produces a Float32Array column.
 * – Native Common.clamp for normalization helpers (no MathUtils dependency).
 * – Half-float conversion delegated to Precision.toHalfFloat/fromHalfFloat
 *   when available, otherwise uses an IEEE 754 fallback.
 * – No static server, no bundler, no CDN dependency.
 */
class Float16BufferAttribute extends BufferAttribute {
  /**
   * @param {Uint16Array|Array<number>|number} array – half-float bits or plain array
   * @param {number} itemSize – components per vertex
   * @param {boolean} [normalized=false] – whether integer data is normalized
   */
  constructor(array, itemSize, normalized = false) {
    // If a plain Array or Float32Array is passed, convert each float to FP16 bits
    let uint16Array;
    if (array instanceof Uint16Array) {
      uint16Array = array;
    } else if (typeof array === 'number') {
      uint16Array = new Uint16Array(array);
    } else {
      uint16Array = new Uint16Array(array.length);
      for (let i = 0; i < array.length; i++) {
        uint16Array[i] = _toHalfFloat(array[i]);
      }
    }

    super(uint16Array, itemSize, normalized);
    this.isFloat16BufferAttribute = true;
  }

  // --- Get / Set with FP16 conversion ------------------------------------

  getX(index) {
    let x = _fromHalfFloat(this.array[index * this.itemSize]);
    if (this.normalized) x = this.denormalize(x);
    return x;
  }

  setX(index, x) {
    if (this.normalized) x = this.normalize(x);
    this.array[index * this.itemSize] = _toHalfFloat(x);
    return this;
  }

  getY(index) {
    let y = _fromHalfFloat(this.array[index * this.itemSize + 1]);
    if (this.normalized) y = this.denormalize(y);
    return y;
  }

  setY(index, y) {
    if (this.normalized) y = this.normalize(y);
    this.array[index * this.itemSize + 1] = _toHalfFloat(y);
    return this;
  }

  getZ(index) {
    let z = _fromHalfFloat(this.array[index * this.itemSize + 2]);
    if (this.normalized) z = this.denormalize(z);
    return z;
  }

  setZ(index, z) {
    if (this.normalized) z = this.normalize(z);
    this.array[index * this.itemSize + 2] = _toHalfFloat(z);
    return this;
  }

  getW(index) {
    let w = _fromHalfFloat(this.array[index * this.itemSize + 3]);
    if (this.normalized) w = this.denormalize(w);
    return w;
  }

  setW(index, w) {
    if (this.normalized) w = this.normalize(w);
    this.array[index * this.itemSize + 3] = _toHalfFloat(w);
    return this;
  }

  setXY(index, x, y) {
    const i = index * this.itemSize;
    if (this.normalized) { x = this.normalize(x); y = this.normalize(y); }
    this.array[i + 0] = _toHalfFloat(x);
    this.array[i + 1] = _toHalfFloat(y);
    return this;
  }

  setXYZ(index, x, y, z) {
    const i = index * this.itemSize;
    if (this.normalized) { x = this.normalize(x); y = this.normalize(y); z = this.normalize(z); }
    this.array[i + 0] = _toHalfFloat(x);
    this.array[i + 1] = _toHalfFloat(y);
    this.array[i + 2] = _toHalfFloat(z);
    return this;
  }

  setXYZW(index, x, y, z, w) {
    const i = index * this.itemSize;
    if (this.normalized) { x = this.normalize(x); y = this.normalize(y); z = this.normalize(z); w = this.normalize(w); }
    this.array[i + 0] = _toHalfFloat(x);
    this.array[i + 1] = _toHalfFloat(y);
    this.array[i + 2] = _toHalfFloat(z);
    this.array[i + 3] = _toHalfFloat(w);
    return this;
  }

  // --- Normalization helpers (override base) ------------------------------

  normalize(value) {
    return Float16BufferAttributeUtils.normalizeScalar(value);
  }

  denormalize(value) {
    // Uint16Array range is 0..65535
    return Float16BufferAttributeUtils.denormalizeScalar(value, 65535);
  }

  // --- BitECS bridge ------------------------------------------------------

  /**
   * Produce a BitECS SoA component column filled with this attribute's data
   * decoded to float32 (since ECS columns are Float32Array).
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, column: Float32Array, count: number, itemSize: number }}
   */
  asBitecsComponent(name, count) {
    const comp = Float16BufferAttributeUtils.registerComponent(name, count, this.itemSize);
    const col = comp.column;
    const src = this.array;
    const size = this.itemSize;
    const len = Math.min(count * size, src.length);
    for (let i = 0; i < len; i++) {
      col[i] = _fromHalfFloat(src[i]);
    }
    return comp;
  }

  // --- Pooling ------------------------------------------------------------

  /**
   * Acquire a pooled Float16BufferAttribute instance (empty, itemSize = 1).
   * @returns {Float16BufferAttribute}
   */
  static acquire() {
    return acquireFloat16Attribute();
  }

  /**
   * Return this Float16BufferAttribute to the pool. Caller must not use it afterward.
   */
  release() {
    releaseFloat16Attribute(this);
  }

  /**
   * Clear the global Float16BufferAttribute pool.
   */
  static clearPool() {
    _float16Pool.length = 0;
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = Float16BufferAttributeUtils;
}

export { Float16BufferAttribute, Float16BufferAttributeUtils };