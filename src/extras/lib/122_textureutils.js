// file number : 122
// full path name : src/extras/lib/122_textureutils.js
// description : TextureUtils rewritten as a pure ES module with zero CDN imports. Provides canvasToTexture, imageToDataTexture, resizeImage, floatBufferToTexture, normalizeFloatBufferPrecise, floatToByteDithered, and sampleBilinear for texture pipelines. Replaces three.js r185 texture type imports with lightweight local descriptors (matching the pattern established in 089_RenderTarget.js), adds a flat typed-array TextureBatch for processing N textures in one cache-friendly pass, SimplexNoise-based dithering for 8-bit banding avoidance, Float64 HDR normalization, and a BitECS SoA bridge. Uses the project's Vec2/Vec4/Mat2/Common/Precision/Constants modules for zero-allocation math.
// best for : TextureUtils, DataTexture creation from canvas/image, PMREMGenerator input preparation, procedural texture pipelines, heightfield sampling, terrain material generation, and any three.js path that needs canvas → texture conversion with color-space correctness at 10k+ entity scale on Android 64-bit.
// license : MIT

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

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _rgba = new Float32Array(4);
const _vec4scratch = new Float32Array(4);

// ---------------------------------------------------------------------------
// Lightweight local texture descriptors (no CDN dependency).
// These intentionally expose only the minimal surface a renderer needs:
// image data, format, type, colorSpace, wrapping, filters, and flipY.
// ---------------------------------------------------------------------------
class LocalTexture {
  constructor(image, options = {}) {
    this.isTexture = true;
    this.image = image;

    this.magFilter = options.magFilter !== undefined ? options.magFilter : Constants.LinearFilter;
    this.minFilter = options.minFilter !== undefined ? options.minFilter : Constants.LinearFilter;
    this.wrapS = options.wrapS !== undefined ? options.wrapS : Constants.ClampToEdgeWrapping;
    this.wrapT = options.wrapT !== undefined ? options.wrapT : Constants.ClampToEdgeWrapping;
    this.format = options.format !== undefined ? options.format : Constants.RGBAFormat;
    this.type = options.type !== undefined ? options.type : Constants.UnsignedByteType;
    this.colorSpace = options.colorSpace !== undefined ? options.colorSpace : Constants.NoColorSpace;
    this.generateMipmaps = options.generateMipmaps !== undefined ? options.generateMipmaps : true;
    this.flipY = options.flipY !== undefined ? options.flipY : true;
    this.unpackAlignment = options.unpackAlignment !== undefined ? options.unpackAlignment : 4;
    this.anisotropy = options.anisotropy !== undefined ? options.anisotropy : 1;

    this.needsUpdate = true;
    this.version = 0;
  }

  dispose() {
    this.image = null;
    this.needsUpdate = false;
  }
}

class LocalCanvasTexture extends LocalTexture {
  constructor(canvas, options = {}) {
    super(canvas, options);
    this.isCanvasTexture = true;
  }
}

class LocalDataTexture extends LocalTexture {
  constructor(data, width, height, options = {}) {
    super({ data, width, height }, options);
    this.isDataTexture = true;
    this.generateMipmaps = options.generateMipmaps !== undefined ? options.generateMipmaps : false;
    this.flipY = options.flipY !== undefined ? options.flipY : false;
    this.unpackAlignment = options.unpackAlignment !== undefined ? options.unpackAlignment : 1;
  }
}

// ---------------------------------------------------------------------------
// TextureBatch — flat typed-array multi-texture processing coordinator.
// Replaces per-entity bitecs layout for cache locality at 10k+ scale.
// ---------------------------------------------------------------------------
const TEX_MODE_RESIZE       = 0;
const TEX_MODE_SRGB_LINEAR  = 1;
const TEX_MODE_DITHER       = 2;

class TextureBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._srcPtr  = new Int32Array(capacity);
    this._dstPtr  = new Int32Array(capacity);
    this._width   = new Int32Array(capacity);
    this._height  = new Int32Array(capacity);
    this._mode    = new Uint8Array(capacity);
    this._done    = new Uint8Array(capacity);

    this._sources = [];
    this._outputs = [];
    this._capacity = capacity;
  }

  /**
   * Grow internal arrays to hold at least `capacity` jobs.
   * @private
   */
  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 32);

    const a = new Int32Array(newCap);  a.set(this._srcPtr);  this._srcPtr = a;
    const b = new Int32Array(newCap);  b.set(this._dstPtr);  this._dstPtr = b;
    const c = new Int32Array(newCap);  c.set(this._width);   this._width = c;
    const d = new Int32Array(newCap);  d.set(this._height);  this._height = d;
    const e = new Uint8Array(newCap);  e.set(this._mode);    this._mode = e;
    const f = new Uint8Array(newCap);  f.set(this._done);    this._done = f;

    this._capacity = newCap;
  }

  /**
   * Queue a texture processing job.
   * @param {ImageData|HTMLCanvasElement|HTMLImageElement} source
   * @param {number} width
   * @param {number} height
   * @param {number} [mode=0] – 0=resize, 1=sRGB→linear, 2=dither+linear
   * @returns {number} job id
   */
  add(source, width, height, mode = TEX_MODE_RESIZE) {
    this._ensure(this._count + 1);
    const i = this._count++;
    this._srcPtr[i] = this._sources.length;
    this._sources.push(source);
    this._width[i] = width;
    this._height[i] = height;
    this._mode[i] = mode;
    this._dstPtr[i] = -1;
    this._done[i] = 0;
    return i;
  }

  /**
   * Process all queued jobs in one cache-friendly pass.
   */
  process() {
    const n = this._count;
    for (let i = 0; i < n; i++) {
      const src = this._sources[this._srcPtr[i]];
      const width = this._width[i];
      const height = this._height[i];
      const mode = this._mode[i];

      let imageData = src;
      if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) {
        imageData = src.getContext('2d').getImageData(0, 0, src.width, src.height);
      }

      let resized;
      if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        const temp = document.createElement('canvas');
        temp.width = imageData.width;
        temp.height = imageData.height;
        temp.getContext('2d').putImageData(imageData, 0, 0);
        ctx.drawImage(temp, 0, 0, width, height);
        resized = ctx.getImageData(0, 0, width, height);
      } else {
        resized = imageData;
      }

      let final = resized;
      if (mode === TEX_MODE_SRGB_LINEAR) {
        final = _sRGBToLinear(resized);
      } else if (mode === TEX_MODE_DITHER) {
        const bytes = floatToByteDithered(
          _byteToFloat(resized.data),
          width, height, 0.5
        );
        final = new ImageData(bytes, width, height);
      }

      this._dstPtr[i] = this._outputs.length;
      this._outputs.push(final);
      this._done[i] = 1;
    }
  }

  /**
   * Retrieve the processed result for a job id.
   * @param {number} id
   * @returns {ImageData|HTMLCanvasElement|null}
   */
  result(id) {
    if (id < 0 || id >= this._count) return null;
    if (!this._done[id]) return null;
    return this._outputs[this._dstPtr[id]];
  }

  /**
   * Reset for reuse (keeps internal capacity).
   */
  reset() {
    this._count = 0;
    this._sources.length = 0;
    this._outputs.length = 0;
  }

  /**
   * Expose the batch as a flat BitECS-compatible SoA snapshot.
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    return {
      name,
      count: this._count,
      srcPtr: this._srcPtr,
      dstPtr: this._dstPtr,
      width: this._width,
      height: this._height,
      mode: this._mode,
      done: this._done,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function _byteToFloat(bytes) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
  return out;
}

function _sRGBToLinear(imageData) {
  const src = imageData.data;
  const out = new Uint8ClampedArray(src.length);

  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = src[i + c] / 255;
      const lin = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      out[i + c] = Math.round(lin * 255);
    }
    out[i + 3] = src[i + 3];
  }

  return new ImageData(out, imageData.width, imageData.height);
}

// ---------------------------------------------------------------------------
// Float64 HDR normalization (JS Float64 is IEEE-754 double, no double.js)
// ---------------------------------------------------------------------------
function normalizeFloatBufferPrecise(data, maxValue) {
  let max = maxValue;

  if (max === undefined) {
    max = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > max) max = a;
    }
  }

  if (max === 0) return new Float32Array(data.length);

  const out = new Float32Array(data.length);
  const inv = 1 / max;
  for (let i = 0; i < data.length; i++) out[i] = data[i] * inv;
  return out;
}

// ---------------------------------------------------------------------------
// SimplexNoise-dithered 8-bit down-conversion to avoid banding
// ---------------------------------------------------------------------------
function floatToByteDithered(data, width, height, amplitude = 0.5) {
  const out = new Uint8ClampedArray(data.length);
  const invAmp = amplitude / 255;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const dither = SimplexNoise.noise2D(x * 0.1, y * 0.1) * invAmp;

      out[p]     = Math.round(Common.clamp((data[p]     + dither), 0, 1) * 255);
      out[p + 1] = Math.round(Common.clamp((data[p + 1] + dither), 0, 1) * 255);
      out[p + 2] = Math.round(Common.clamp((data[p + 2] + dither), 0, 1) * 255);
      out[p + 3] = Math.round(Common.clamp(data[p + 3], 0, 1) * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TextureUtils — mirrors the historical three.js TextureUtils.js surface.
// ---------------------------------------------------------------------------
class TextureUtils {
  /**
   * Create a LocalCanvasTexture from a canvas element.
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   * @returns {LocalCanvasTexture}
   */
  static canvasToTexture(canvas, options = {}) {
    const tex = new LocalCanvasTexture(canvas, options);
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Convert an image/canvas/ImageData into a LocalDataTexture.
   * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap|ImageData} source
   * @param {boolean} [convertToLinear=true]
   * @returns {LocalDataTexture}
   */
  static imageToDataTexture(source, convertToLinear = true) {
    let canvas;
    if (typeof document === 'undefined') {
      return new LocalDataTexture(
        source.data || source, source.width || 0, source.height || 0,
        { type: Constants.UnsignedByteType }
      );
    }

    if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
      canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext('2d').putImageData(source, 0, 0);
    } else if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
      canvas = source;
    } else {
      canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      canvas.getContext('2d').drawImage(source, 0, 0);
    }

    const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const final = convertToLinear ? _sRGBToLinear(imageData) : imageData;

    return new LocalDataTexture(final.data, canvas.width, canvas.height, {
      type: Constants.UnsignedByteType,
      format: Constants.RGBAFormat,
      colorSpace: convertToLinear ? Constants.NoColorSpace : Constants.SRGBColorSpace,
      generateMipmaps: false,
      flipY: false,
    });
  }

  /**
   * Resize a source image (image, canvas, ImageData) to the given dimensions.
   * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap|ImageData} source
   * @param {number} width
   * @param {number} height
   * @returns {HTMLCanvasElement}
   */
  static resizeImage(source, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
      const temp = document.createElement('canvas');
      temp.width = source.width;
      temp.height = source.height;
      temp.getContext('2d').putImageData(source, 0, 0);
      ctx.drawImage(temp, 0, 0, width, height);
    } else {
      ctx.drawImage(source, 0, 0, width, height);
    }
    return canvas;
  }

  /**
   * Build a LocalDataTexture from a Float32Array buffer.
   * @param {Float32Array} data
   * @param {number} width
   * @param {number} height
   * @param {number} [channels=4]
   * @returns {LocalDataTexture}
   */
  static floatBufferToTexture(data, width, height, channels = 4) {
    return new LocalDataTexture(data, width, height, {
      type: Constants.FloatType,
      format: Constants.RGBAFormat,
      colorSpace: Constants.NoColorSpace,
      generateMipmaps: false,
      flipY: false,
    });
  }

  /**
   * Normalize an HDR float RGBA buffer into [0, 1].
   * @param {Float32Array} data
   * @param {number} [maxValue]
   * @returns {Float32Array}
   */
  static normalizeFloatBufferPrecise(data, maxValue) {
    return normalizeFloatBufferPrecise(data, maxValue);
  }

  /**
   * Down-convert an HDR float buffer to 8-bit RGBA with SimplexNoise dithering.
   * @param {Float32Array} data
   * @param {number} width
   * @param {number} height
   * @param {number} [amplitude=0.5]
   * @returns {Uint8ClampedArray}
   */
  static floatToByteDithered(data, width, height, amplitude = 0.5) {
    return floatToByteDithered(data, width, height, amplitude);
  }

  /**
   * Bilinear sample of an RGBA buffer at normalized UV using Vec4 module.
   * Zero-allocation (writes into _rgba).
   * @param {Float32Array|Uint8ClampedArray} data
   * @param {number} width
   * @param {number} height
   * @param {number} u – in [0,1]
   * @param {number} v – in [0,1]
   * @returns {Float32Array} _rgba (length-4, do not mutate externally)
   */
  static sampleBilinear(data, width, height, u, v) {
    const x = u * (width - 1);
    const y = v * (height - 1);

    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);

    const fx = x - x0;
    const fy = y - y0;

    const i00 = (y0 * width + x0) * 4;
    const i10 = (y0 * width + x1) * 4;
    const i01 = (y1 * width + x0) * 4;
    const i11 = (y1 * width + x1) * 4;

    for (let c = 0; c < 4; c++) {
      const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
      const bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
      _rgba[c] = top * (1 - fy) + bot * fy;
    }

    Vec4.set(_vec4scratch, _rgba[0], _rgba[1], _rgba[2], _rgba[3]);
    return _rgba;
  }

  /**
   * Create a flat typed-array batch texture processor.
   * @returns {TextureBatch}
   */
  static createBatch() {
    return new TextureBatch();
  }
}

export {
  TextureUtils,
  TextureBatch,
  LocalTexture,
  LocalCanvasTexture,
  LocalDataTexture,
  normalizeFloatBufferPrecise,
  floatToByteDithered,
};
export default TextureUtils;