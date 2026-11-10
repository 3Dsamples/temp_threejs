// file number : 106
// full path name : src/extras/lib/106_datautils.js
// description : Binary data conversion utilities (half-float ↔ float32, normalized integer ↔ float) rewritten as a pure ES module with zero CDN imports. Uses the project's Precision module for toHalfFloat/fromHalfFloat, precomputed 65536-entry LUTs for bulk conversion, zero-allocation per-value paths, and a HalfFloatBatch that processes N values in a single cache-friendly pass. Includes optional SimplexNoise-based dithering for half-float texture packing to avoid banding. Removes the original's gl-matrix/double.js/bitecs-CDN dependencies and integrates with the project's Common/Constants modules.
// best for : DataTexture with HalfFloatType, packed vertex attributes (HDR emissive, light probes), binary buffer conversion in GPGPU pipelines, terrain heightfields, and any three.js path that must stay bit-exact across Android 64-bit while handling 10k+ entities without GC pressure.
// license : MIT

import { Constants } from '../../math/002_Constants.js';
import { Common } from '../../math/003_Common.js';
import { Precision } from '../../math/004_Precision.js';
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

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _floatView = new Float32Array(1);
const _int32View = new Int32Array(_floatView.buffer);

// ---------------------------------------------------------------------------
// Precomputed 65536-entry LUT for fromHalfFloat. This is the same memory
// footprint as the original but eliminates per-value branching entirely.
// ---------------------------------------------------------------------------
const _halfFloatTable = new Float32Array(65536);

(function buildHalfFloatTable() {
  for (let i = 0; i < 65536; i++) {
    const s = (i & 0x8000) >> 15;
    const e = (i & 0x7C00) >> 10;
    const f = i & 0x03FF;

    if (e === 0) {
      _halfFloatTable[i] = (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    } else if (e === 0x1F) {
      _halfFloatTable[i] = f ? NaN : (s ? -Infinity : Infinity);
    } else {
      _halfFloatTable[i] = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    }
  }
})();

// ---------------------------------------------------------------------------
// toHalfFloat — delegates to Precision when available, otherwise uses an
// IEEE-754 fallback identical to three.js r185's DataUtils.
// ---------------------------------------------------------------------------
const _precisionToHalf = (typeof Precision.toHalfFloat === 'function')
  ? Precision.toHalfFloat
  : function toHalfFloatFallback(val) {
      _floatView[0] = val;
      const x = _int32View[0];
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

const _precisionFromHalf = (typeof Precision.fromHalfFloat === 'function')
  ? Precision.fromHalfFloat
  : function fromHalfFloatFallback(bits) {
      return _halfFloatTable[bits & 0xFFFF];
    };

/**
 * Convert a float32 value to its 16-bit half-float bit representation.
 *
 * @param {number} val
 * @returns {number} 16-bit unsigned integer
 */
function toHalfFloat(val) {
  return _precisionToHalf(val);
}

/**
 * Convert a 16-bit half-float bit representation to a float32 value.
 *
 * @param {number} val
 * @returns {number}
 */
function fromHalfFloat(val) {
  return _precisionFromHalf(val);
}

// ---------------------------------------------------------------------------
// Normalized integer conversion helpers.
// ---------------------------------------------------------------------------

/**
 * Convert a normalized float in [0, 1] into an integer in [0, size - 1].
 *
 * @param {number} val
 * @param {number} size
 * @returns {number}
 */
function toNormalized(val, size) {
  if (val < 0) return 0;
  if (val > 1) return size - 1;
  return Math.round(val * (size - 1));
}

/**
 * Convert an integer in [0, size - 1] back into a normalized float in [0, 1].
 *
 * @param {number} val
 * @param {number} size
 * @returns {number}
 */
function fromNormalized(val, size) {
  if (val < 0) return 0;
  if (val > size - 1) return 1;
  return val / (size - 1);
}

// ---------------------------------------------------------------------------
// Bulk typed-array conversion (zero-allocation if output buffer is provided).
// ---------------------------------------------------------------------------

/**
 * Convert a Float32Array of values into a Uint16Array of half-float bits.
 *
 * @param {Float32Array} src
 * @param {Uint16Array} [dst] – optional output buffer (must match length)
 * @returns {Uint16Array}
 */
function toHalfFloatArray(src, dst) {
  const n = src.length;
  const out = dst && dst.length === n ? dst : new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = _precisionToHalf(src[i]);
  }
  return out;
}

/**
 * Convert a Uint16Array of half-float bits into a Float32Array.
 *
 * @param {Uint16Array} src
 * @param {Float32Array} [dst] – optional output buffer (must match length)
 * @returns {Float32Array}
 */
function fromHalfFloatArray(src, dst) {
  const n = src.length;
  const out = dst && dst.length === n ? dst : new Float32Array(n);
  // Batch LUT lookup — no branching, no function calls
  for (let i = 0; i < n; i++) {
    out[i] = _halfFloatTable[src[i]];
  }
  return out;
}

/**
 * Convert a Vec3 of normalized floats in [0, 1] into integer values.
 *
 * @param {Float32Array} out – length-3 output
 * @param {Float32Array} v – length-3 input
 * @param {number} size
 * @returns {Float32Array} out
 */
function toNormalizedVec3(out, v, size) {
  const s = size - 1;
  Vec3.set(out,
    Math.max(0, Math.min(s, Math.round(v[0] * s))),
    Math.max(0, Math.min(s, Math.round(v[1] * s))),
    Math.max(0, Math.min(s, Math.round(v[2] * s)))
  );
  return out;
}

/**
 * Convert a Vec3 of integer values back into normalized floats.
 *
 * @param {Float32Array} out – length-3 output
 * @param {Float32Array} v – length-3 input
 * @param {number} size
 * @returns {Float32Array} out
 */
function fromNormalizedVec3(out, v, size) {
  const s = size - 1;
  Vec3.set(out, v[0] / s, v[1] / s, v[2] / s);
  return out;
}

// ---------------------------------------------------------------------------
// HalfFloatBatch — process N values in a single cache-friendly pass using
// flat typed arrays. Replaces the original's per-entity bitecs layout.
// ---------------------------------------------------------------------------
class HalfFloatBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;
    this._input = new Float64Array(capacity);
    this._output = new Uint16Array(capacity);
    this._capacity = capacity;
  }

  /**
   * Grow internal buffers to hold at least `capacity` values.
   * @private
   */
  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 64);

    const ni = new Float64Array(newCap); ni.set(this._input); this._input = ni;
    const no = new Uint16Array(newCap);  no.set(this._output); this._output = no;

    this._capacity = newCap;
  }

  /**
   * Queue a float value for conversion.
   * @param {number} value
   * @returns {number} index
   */
  add(value) {
    this._ensure(this._count + 1);
    const i = this._count++;
    this._input[i] = value;
    this._output[i] = 0;
    return i;
  }

  /**
   * Process all queued values in one pass.
   */
  process() {
    const n = this._count;
    const input = this._input;
    const output = this._output;
    for (let i = 0; i < n; i++) {
      output[i] = _precisionToHalf(input[i]);
    }
  }

  /**
   * Return the output as a Uint16Array view.
   * @returns {Uint16Array}
   */
  results() {
    return this._output.subarray(0, this._count);
  }

  /**
   * Reset for reuse (keeps internal capacity).
   */
  reset() {
    this._count = 0;
  }

  /**
   * Expose the batch as a flat BitECS-compatible SoA snapshot.
   * @param {string} name
   * @returns {{ name: string, count: number, input: Float64Array, output: Uint16Array }}
   */
  asBitecsComponent(name) {
    return {
      name,
      count: this._count,
      input: this._input,
      output: this._output,
    };
  }
}

// ---------------------------------------------------------------------------
// Dithering helper — uses SimplexNoise to break up banding when packing
// low-precision half-float textures.
// ---------------------------------------------------------------------------

/**
 * Apply a simplex-noise offset to a scalar value before half-float
 * quantization.
 *
 * @param {number} value
 * @param {number} [x=0]
 * @param {number} [y=0]
 * @param {number} [amplitude=1/2048]
 * @returns {number}
 */
function ditherHalfFloat(value, x = 0, y = 0, amplitude = 1 / 2048) {
  return value + SimplexNoise.noise2D(x, y) * amplitude;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export {
  toHalfFloat,
  fromHalfFloat,
  toNormalized,
  fromNormalized,
  toHalfFloatArray,
  fromHalfFloatArray,
  toNormalizedVec3,
  fromNormalizedVec3,
  HalfFloatBatch,
  ditherHalfFloat,
};

export default {
  toHalfFloat,
  fromHalfFloat,
  toNormalized,
  fromNormalized,
  toHalfFloatArray,
  fromHalfFloatArray,
  toNormalizedVec3,
  fromNormalizedVec3,
  HalfFloatBatch,
  ditherHalfFloat,
};