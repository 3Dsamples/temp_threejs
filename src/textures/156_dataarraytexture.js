// file number : 156
// full path name : src/textures/156_dataarraytexture.js
// description : DataArrayTexture (three.js r185) rewritten as a pure ES module with zero CDN imports and completely dynamic features. Extends Texture (151) to create 2D-array (layered) textures directly from raw typed arrays. Preserves the full r185 DataArrayTexture API — image proxy with {data, width, height, depth}, layerUpdates Set, generateMipmaps=false, flipY=false, unpackAlignment=1, NearestFilter defaults, isDataArrayTexture flag, addLayerUpdate(), clearLayerUpdates(), plus clone(), copy(), toJSON() inherited from Texture. Adds dynamic feature toggles: per-layer dirty tracking, dynamic depth/format coercion, layer-by-layer extraction/insertion, dynamic channel reshaping per layer, dynamic 2×/4× upsampling and downsampling, dynamic layer swizzling (RGBA↔RGB↔Red↔RG), dynamic HDR/LDR switching, and dynamic procedural layer generators (noise, gradient, checkerboard, voxel field). Uses the project's Vec4/Vec3 modules for zero-allocation sampling, a flat typed-array DataArrayTextureBatch for multi-layer uploads (morph target textures, texture atlases, volumetric slicing), Float64 layerByteOffsetPrecise (native JS IEEE-754 doubles — no double.js), SimplexNoise-dithered quantizeLayerDithered for LDR conversion, and full pool integration via acquire()/release()/clearPool(). Designed for 10k+ layered textures on Android 64-bit with zero CDN dependencies.
// best for : DataArrayTexture, WebGLMorphtargets, morph-target data textures, layered texture atlases, volumetric slicing, sprite sheets with per-layer updates, terrain splat maps, texture arrays for material stacking, GPU 2D array textures, and any three.js workflow that needs multiple texture layers addressable by a single layer index at 10k+ entity scale on Android 64-bit.
// license : MIT

import { Constants } from '../core/002_Constants.js';
import { Common } from '../core/003_Common.js';
import { Precision } from '../core/004_Precision.js';
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
import { Texture } from './151_texture.js';

// ---------------------------------------------------------------------------
// Local aliases for the project's Constants.
// ---------------------------------------------------------------------------
const NearestFilter  = Constants.NearestFilter;
const LinearFilter   = Constants.LinearFilter;
const RGBAFormat     = Constants.RGBAFormat;
const RGBFormat      = Constants.RGBFormat;
const RedFormat      = Constants.RedFormat;
const RGFormat       = Constants.RGFormat;
const UnsignedByteType = Constants.UnsignedByteType;
const UnsignedShortType = Constants.UnsignedShortType;
const HalfFloatType  = Constants.HalfFloatType;
const FloatType      = Constants.FloatType;
const NoColorSpace   = Constants.NoColorSpace;
const UVMapping      = Constants.UVMapping;
const ClampToEdgeWrapping = Constants.ClampToEdgeWrapping;

// ---------------------------------------------------------------------------
// Static pool for DataArrayTexture instances — recycled to eliminate
// per-mesh allocation churn when 10k+ layered textures spawn/despawn.
// ---------------------------------------------------------------------------
const _arrayPool = [];

function _acquireArray() {
  const t = _arrayPool.pop();
  if (t) {
    t._resetForPool();
    return t;
  }
  return new DataArrayTexture();
}

function _releaseArray(t) {
  if (_arrayPool.length < 128) _arrayPool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _rgba = new Float32Array(4);
const _rgb  = new Float32Array(3);
const _vec3 = new Float32Array(3);

// ---------------------------------------------------------------------------
// Format → channel count map (dynamic feature).
// ---------------------------------------------------------------------------
const FORMAT_CHANNELS = new Map([
  [RedFormat, 1],
  [RGFormat, 2],
  [RGBFormat, 3],
  [RGBAFormat, 4],
]);

// ---------------------------------------------------------------------------
// Type → normalized scale map (dynamic feature).
// ---------------------------------------------------------------------------
const TYPE_SCALE = new Map([
  [UnsignedByteType, 1 / 255],
  [UnsignedShortType, 1 / 65535],
  [HalfFloatType, 1],
  [FloatType, 1],
]);

// ---------------------------------------------------------------------------
// DataArrayTextureBatch — flat typed-array batch coordinator for multi-layer
// uploads (morph target textures, texture atlases, volumetric slicing).
// ---------------------------------------------------------------------------
const ARRAY_MODE_RAW          = 0;
const ARRAY_MODE_NORMALIZE    = 1;
const ARRAY_MODE_DITHER       = 2;
const ARRAY_MODE_EXTRACT      = 3;
const ARRAY_MODE_SWIZZLE_RGBA = 4;
const ARRAY_MODE_SWIZZLE_RGB  = 5;
const ARRAY_MODE_UPSAMPLE     = 6;
const ARRAY_MODE_DOWNSAMPLE   = 7;

class DataArrayTextureBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._texPtr   = new Int32Array(capacity);
    this._layer    = new Int32Array(capacity);
    this._width    = new Int32Array(capacity);
    this._height   = new Int32Array(capacity);
    this._channels = new Uint8Array(capacity);
    this._mode     = new Uint8Array(capacity);
    this._done     = new Uint8Array(capacity);

    this._textures = [];
    this._outputs = [];
    this._capacity = capacity;
  }

  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 64);

    const a = new Int32Array(newCap); a.set(this._texPtr);   this._texPtr = a;
    const b = new Int32Array(newCap); b.set(this._layer);    this._layer = b;
    const c = new Int32Array(newCap); c.set(this._width);    this._width = c;
    const d = new Int32Array(newCap); d.set(this._height);   this._height = d;
    const e = new Uint8Array(newCap); e.set(this._channels); this._channels = e;
    const f = new Uint8Array(newCap); f.set(this._mode);     this._mode = f;
    const g = new Uint8Array(newCap); g.set(this._done);     this._done = g;

    this._capacity = newCap;
  }

  addTexture(texture) {
    this._textures.push(texture);
    return this._textures.length - 1;
  }

  addLayerJob(textureId, layer, mode = ARRAY_MODE_RAW) {
    this._ensure(this._count + 1);
    const i = this._count++;
    const texture = this._textures[textureId];
    const image = texture ? texture.image : null;
    const fmt = texture ? texture.format : RGBAFormat;

    this._texPtr[i] = textureId;
    this._layer[i] = layer;
    this._width[i] = image ? image.width : 0;
    this._height[i] = image ? image.height : 0;
    this._channels[i] = FORMAT_CHANNELS.get(fmt) || 4;
    this._mode[i] = mode;
    this._done[i] = 0;

    return i;
  }

  process() {
    const n = this._count;

    for (let i = 0; i < n; i++) {
      const texture = this._textures[this._texPtr[i]];
      if (!texture || !texture.image || !texture.image.data) {
        this._outputs.push(null);
        this._done[i] = 1;
        continue;
      }

      const data = texture.image.data;
      const layer = this._layer[i];
      const w = this._width[i];
      const h = this._height[i];
      const channels = this._channels[i];
      const layerSize = w * h * channels;
      const layerOffset = layer * layerSize;

      let result = null;
      const mode = this._mode[i];

      switch (mode) {
        case ARRAY_MODE_RAW: {
          result = data.slice(layerOffset, layerOffset + layerSize);
          break;
        }

        case ARRAY_MODE_NORMALIZE: {
          if (data instanceof Float32Array) {
            const layerData = data.slice(layerOffset, layerOffset + layerSize);
            result = _normalizeFloat(layerData);
          } else {
            result = data.slice(layerOffset, layerOffset + layerSize);
          }
          break;
        }

        case ARRAY_MODE_DITHER: {
          const layerData = data.slice(layerOffset, layerOffset + layerSize);
          if (layerData instanceof Float32Array) {
            result = _quantizeDithered(layerData, 0.5);
          } else if (layerData instanceof Uint8Array || layerData instanceof Uint8ClampedArray) {
            const float = new Float32Array(layerData.length);
            for (let k = 0; k < layerData.length; k++) float[k] = layerData[k] / 255;
            result = _quantizeDithered(float, 0.5);
          } else {
            result = layerData;
          }
          break;
        }

        case ARRAY_MODE_EXTRACT: {
          // Return the raw slice for this layer (no processing).
          result = data.slice(layerOffset, layerOffset + layerSize);
          break;
        }

        case ARRAY_MODE_SWIZZLE_RGBA: {
          const layerData = data.slice(layerOffset, layerOffset + layerSize);
          result = _swizzle(layerData, channels, 4);
          break;
        }

        case ARRAY_MODE_SWIZZLE_RGB: {
          const layerData = data.slice(layerOffset, layerOffset + layerSize);
          result = _swizzle(layerData, channels, 3);
          break;
        }

        case ARRAY_MODE_UPSAMPLE: {
          const layerData = data.slice(layerOffset, layerOffset + layerSize);
          result = _upsample(layerData, w, h, channels, 2);
          break;
        }

        case ARRAY_MODE_DOWNSAMPLE: {
          const layerData = data.slice(layerOffset, layerOffset + layerSize);
          result = _downsample(layerData, w, h, channels, 2);
          break;
        }

        default:
          result = data.slice(layerOffset, layerOffset + layerSize);
      }

      this._outputs.push(result);
      this._done[i] = 1;
    }
  }

  result(i) {
    if (i < 0 || i >= this._count) return null;
    if (!this._done[i]) return null;
    return this._outputs[i];
  }

  reset() {
    this._count = 0;
    this._outputs.length = 0;
  }

  asBitecsComponent(name) {
    return {
      name,
      count: this._count,
      texPtr: this._texPtr,
      layer: this._layer,
      width: this._width,
      height: this._height,
      channels: this._channels,
      mode: this._mode,
      done: this._done,
    };
  }
}

// ---------------------------------------------------------------------------
// Dynamic feature helpers.
// ---------------------------------------------------------------------------

/**
 * Normalize a Float32Array into [0, 1] using JS Float64 (no double.js).
 */
function _normalizeFloat(data, maxValue) {
  const out = new Float32Array(data.length);
  let max = maxValue;

  if (max === undefined) {
    max = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > max) max = a;
    }
  }

  if (max === 0) return out;

  const inv = 1 / max;
  for (let i = 0; i < data.length; i++) out[i] = data[i] * inv;
  return out;
}

/**
 * SimplexNoise-dithered 8-bit quantization of a float buffer.
 */
function _quantizeDithered(data, amplitude = 0.5) {
  const out = new Uint8ClampedArray(data.length);
  const invAmp = amplitude / 255;

  for (let i = 0; i < data.length; i++) {
    const d = SimplexNoise.noise2D(i * 0.01, 0) * invAmp;
    out[i] = Math.floor(Math.max(0, Math.min(1, data[i] + d)) * 255);
  }
  return out;
}

function quantizeLayerDithered(layerData, layer, amplitude = 0.5) {
  const out = new Uint8ClampedArray(layerData.length);
  const invAmp = amplitude / 255;

  for (let i = 0; i < layerData.length; i++) {
    const d = SimplexNoise.noise2D(i * 0.01, layer) * invAmp;
    out[i] = Math.floor(Math.max(0, Math.min(1, layerData[i] + d)) * 255);
  }
  return out;
}

/**
 * Dynamic channel swizzle.
 */
function _swizzle(data, srcChannels, dstChannels) {
  if (srcChannels === dstChannels) return data;

  const pixelCount = Math.floor(data.length / srcChannels);
  const out = new data.constructor(pixelCount * dstChannels);
  const isUint = out.constructor === Uint8Array || out.constructor === Uint8ClampedArray;
  const maxVal = isUint ? 255 : 1;

  if (dstChannels > srcChannels) {
    for (let p = 0; p < pixelCount; p++) {
      const srcBase = p * srcChannels;
      const dstBase = p * dstChannels;

      if (srcChannels === 1) {
        const v = data[srcBase];
        out[dstBase] = v;
        out[dstBase + 1] = v;
        out[dstBase + 2] = v;
        out[dstBase + 3] = maxVal;
      } else if (srcChannels === 2) {
        out[dstBase] = data[srcBase];
        out[dstBase + 1] = data[srcBase + 1];
        out[dstBase + 2] = 0;
        out[dstBase + 3] = maxVal;
      } else if (srcChannels === 3) {
        out[dstBase] = data[srcBase];
        out[dstBase + 1] = data[srcBase + 1];
        out[dstBase + 2] = data[srcBase + 2];
        out[dstBase + 3] = maxVal;
      }
    }
  } else {
    for (let p = 0; p < pixelCount; p++) {
      const srcBase = p * srcChannels;
      const dstBase = p * dstChannels;
      for (let c = 0; c < dstChannels; c++) {
        out[dstBase + c] = data[srcBase + c];
      }
    }
  }
  return out;
}

/**
 * Dynamic 2× upsample via nearest-neighbour.
 */
function _upsample(data, w, h, channels, factor) {
  const nw = w * factor;
  const nh = h * factor;
  const out = new data.constructor(nw * nh * channels);

  for (let y = 0; y < nh; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < nw; x++) {
      const sx = Math.floor(x / factor);
      const srcBase = (sy * w + sx) * channels;
      const dstBase = (y * nw + x) * channels;
      for (let c = 0; c < channels; c++) {
        out[dstBase + c] = data[srcBase + c];
      }
    }
  }
  return out;
}

/**
 * Dynamic 2× downsample via box filter.
 */
function _downsample(data, w, h, channels, factor) {
  const nw = Math.max(1, Math.floor(w / factor));
  const nh = Math.max(1, Math.floor(h / factor));
  const out = new data.constructor(nw * nh * channels);
  const samples = factor * factor;

  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const dstBase = (y * nw + x) * channels;
      for (let c = 0; c < channels; c++) out[dstBase + c] = 0;

      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= w || sy >= h) continue;
          const srcBase = (sy * w + sx) * channels;
          for (let c = 0; c < channels; c++) {
            out[dstBase + c] += data[srcBase + c];
          }
        }
      }

      for (let c = 0; c < channels; c++) {
        out[dstBase + c] = Math.floor(out[dstBase + c] / samples);
      }
    }
  }
  return out;
}

/**
 * Float64 layer byte offset. JS numbers are IEEE-754 doubles — no double.js.
 * Preserves bit-exact accumulation up to 2^53 bytes.
 */
function layerByteOffsetPrecise(width, height, depth, layer) {
  return width * height * 4 * layer;
}

// ---------------------------------------------------------------------------
// DataArrayTexture — mirrors three.js r185 DataArrayTexture with dynamic
// features.
// ---------------------------------------------------------------------------
class DataArrayTexture extends Texture {
  /**
   * @param {?TypedArray} [data=null]
   * @param {number} [width=1]
   * @param {number} [height=1]
   * @param {number} [depth=1]
   */
  constructor(data = null, width = 1, height = 1, depth = 1) {
    super();

    this.isDataArrayTexture = true;

    this.image = { data, width, height, depth };
    this.source.data = this.image;

    this.magFilter = NearestFilter;
    this.minFilter = NearestFilter;

    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 1;

    this.layerUpdates = new Set();

    // Dynamic feature flags (all opt-in, toggled at runtime)
    this.dynamicFeatures = {
      autoChannelDetection: false,
      autoTypeCoercion: false,
      autoUpdateRanges: false,
      hdrMode: false,
      proceduralGenerators: false,
      lazyUpload: false,
      perLayerUpdates: true,
    };

    // Optional per-layer pending range accumulator (dynamic feature)
    this._pendingLayers = new Set();
  }

  // -----------------------------------------------------------------------
  // Dynamic feature toggles
  // -----------------------------------------------------------------------

  setFeature(name, enabled = true) {
    if (this.dynamicFeatures.hasOwnProperty(name)) {
      this.dynamicFeatures[name] = !!enabled;
      this.needsUpdate = true;
    }
    return this;
  }

  toggleFeature(name) {
    if (!this.dynamicFeatures.hasOwnProperty(name)) return false;
    this.dynamicFeatures[name] = !this.dynamicFeatures[name];
    this.needsUpdate = true;
    return this.dynamicFeatures[name];
  }

  hasFeature(name) {
    return this.dynamicFeatures[name] === true;
  }

  // -----------------------------------------------------------------------
  // r185 layer update API
  // -----------------------------------------------------------------------

  /**
   * Describes that a specific layer of the texture needs to be updated.
   * @param {number} layer
   */
  addLayerUpdate(layer) {
    this.layerUpdates.add(layer);
    if (this.dynamicFeatures.perLayerUpdates) {
      this._pendingLayers.add(layer);
    }
  }

  /**
   * Clears the layer updates.
   */
  clearLayerUpdates() {
    this.layerUpdates.clear();
    this._pendingLayers.clear();
  }

  /**
   * Flush pending layer updates (dynamic extension of r185 API).
   * @returns {this}
   */
  flushLayerUpdates() {
    for (const layer of this._pendingLayers) {
      this.layerUpdates.add(layer);
    }
    this._pendingLayers.clear();
    this.needsUpdate = true;
    return this;
  }

  /**
   * @returns {number} — number of pending (not yet flushed) layers
   */
  get pendingLayerCount() {
    return this._pendingLayers.size;
  }

  // -----------------------------------------------------------------------
  // Dynamic channel detection / reshaping
  // -----------------------------------------------------------------------

  detectChannels() {
    return FORMAT_CHANNELS.get(this.format) || 4;
  }

  reshapeChannels(dstChannels) {
    const srcChannels = this.detectChannels();
    if (srcChannels === dstChannels) return this;

    const data = this.image.data;
    if (!data) return this;

    const { width, height, depth } = this.image;
    const layerSize = width * height * srcChannels;
    const newLayerSize = width * height * dstChannels;
    const out = new data.constructor(width * height * dstChannels * depth);

    for (let layer = 0; layer < depth; layer++) {
      const srcBase = layer * layerSize;
      const dstBase = layer * newLayerSize;
      const swizzled = _swizzle(
        data.slice(srcBase, srcBase + layerSize),
        srcChannels,
        dstChannels
      );
      out.set(swizzled, dstBase);
    }

    this.image.data = out;
    switch (dstChannels) {
      case 1: this.format = RedFormat; break;
      case 2: this.format = RGFormat; break;
      case 3: this.format = RGBFormat; break;
      case 4: this.format = RGBAFormat; break;
    }

    this.needsUpdate = true;
    return this;
  }

  coerceType(TypedArrayCtor) {
    const data = this.image.data;
    if (!data) return this;
    if (data.constructor === TypedArrayCtor) return this;

    const srcIsInt = data.constructor === Uint8Array || data.constructor === Uint8ClampedArray ||
                     data.constructor === Uint16Array;
    const dstIsInt = TypedArrayCtor === Uint8Array || TypedArrayCtor === Uint8ClampedArray ||
                     TypedArrayCtor === Uint16Array;

    const out = new TypedArrayCtor(data.length);

    if (srcIsInt && !dstIsInt) {
      const srcScale = TYPE_SCALE.get(this.type) || 1 / 255;
      for (let i = 0; i < data.length; i++) out[i] = data[i] * srcScale;
    } else if (!srcIsInt && dstIsInt) {
      const dstMax = TypedArrayCtor === Uint8Array || TypedArrayCtor === Uint8ClampedArray ? 255 : 65535;
      for (let i = 0; i < data.length; i++) out[i] = Math.round(data[i] * dstMax);
    } else {
      for (let i = 0; i < data.length; i++) out[i] = data[i];
    }

    this.image.data = out;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic HDR / LDR switching
  // -----------------------------------------------------------------------

  enableHDR() {
    this.dynamicFeatures.hdrMode = true;
    this.coerceType(Float32Array);
    this.type = FloatType;
    this.magFilter = LinearFilter;
    this.minFilter = LinearFilter;
    this.needsUpdate = true;
    return this;
  }

  enableLDR() {
    this.dynamicFeatures.hdrMode = false;
    this.coerceType(Uint8Array);
    this.type = UnsignedByteType;
    this.magFilter = NearestFilter;
    this.minFilter = NearestFilter;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic layer extraction / insertion
  // -----------------------------------------------------------------------

  /**
   * Extract a specific layer's raw data into a new typed array.
   * @param {number} layer
   * @returns {TypedArray|null}
   */
  extractLayer(layer) {
    const { data, width, height, depth } = this.image;
    if (!data || layer >= depth) return null;

    const channels = this.detectChannels();
    const layerSize = width * height * channels;
    const offset = layer * layerSize;

    return data.slice(offset, offset + layerSize);
  }

  /**
   * Insert raw layer data into a specific layer.
   * @param {number} layer
   * @param {TypedArray} layerData
   * @returns {this}
   */
  insertLayer(layer, layerData) {
    const { data, width, height, depth } = this.image;
    if (!data || layer >= depth || !layerData) return this;

    const channels = this.detectChannels();
    const layerSize = width * height * channels;
    const offset = layer * layerSize;

    for (let i = 0; i < layerSize; i++) {
      data[offset + i] = layerData[i];
    }

    this.addLayerUpdate(layer);
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic per-layer sampling
  // -----------------------------------------------------------------------

  /**
   * Zero-allocation RGBA sample from a specific layer.
   * @param {Float32Array} [out]
   * @param {number} [layer=0]
   * @param {number} [u=0.5]
   * @param {number} [v=0.5]
   * @returns {Float32Array|null}
   */
  sampleLayerGlMat(out = _rgba, layer = 0, u = 0.5, v = 0.5) {
    const { data, width, height, depth } = this.image;
    if (!data || !width || !height || layer >= depth) return null;

    const channels = this.detectChannels();
    const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));

    const layerSize = width * height * channels;
    const p = layer * layerSize + (y * width + x) * channels;

    const scale = TYPE_SCALE.get(this.type) || 1;

    const r = data[p] * scale;
    const g = channels > 1 ? data[p + 1] * scale : r;
    const b = channels > 2 ? data[p + 2] * scale : r;
    const a = channels > 3 ? data[p + 3] * scale : 1;

    Vec4.set(out, r, g, b, a);
    return out;
  }

  /**
   * Zero-allocation RGB sample from a specific layer.
   * @param {Float32Array} [out]
   * @param {number} [layer=0]
   * @param {number} [u=0.5]
   * @param {number} [v=0.5]
   * @returns {Float32Array|null}
   */
  sampleLayerRgbGlMat(out = _rgb, layer = 0, u = 0.5, v = 0.5) {
    const { data, width, height, depth } = this.image;
    if (!data || !width || !height || layer >= depth) return null;

    const channels = this.detectChannels();
    const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));

    const layerSize = width * height * channels;
    const p = layer * layerSize + (y * width + x) * channels;

    const scale = TYPE_SCALE.get(this.type) || 1;

    const r = data[p] * scale;
    const g = channels > 1 ? data[p + 1] * scale : r;
    const b = channels > 2 ? data[p + 2] * scale : r;

    Vec3.set(out, r, g, b);
    return out;
  }

  /**
   * Float64 layer byte offset (no double.js).
   * @param {number} layer
   * @returns {number}
   */
  layerByteOffsetPrecise(layer) {
    return layerByteOffsetPrecise(this.image.width, this.image.height, this.image.depth, layer);
  }

  /**
   * SimplexNoise-dithered 8-bit quantization of a specific layer.
   * @param {number} layer
   * @param {number} [amplitude=0.5]
   * @returns {Uint8ClampedArray|null}
   */
  quantizeLayerDithered(layer, amplitude = 0.5) {
    if (!(this.image.data instanceof Float32Array)) return null;

    const { width, height } = this.image;
    const channels = this.detectChannels();
    const layerSize = width * height * channels;
    const layerData = this.image.data.slice(
      layer * layerSize,
      layer * layerSize + layerSize
    );

    return quantizeLayerDithered(layerData, layer, amplitude);
  }

  // -----------------------------------------------------------------------
  // Dynamic procedural layer generators
  // -----------------------------------------------------------------------

  /**
   * Generate a SimplexNoise pattern across all layers.
   * @param {number} [frequency=0.05]
   * @param {number} [amplitude=0.5]
   * @returns {this}
   */
  generateNoise(frequency = 0.05, amplitude = 0.5) {
    const { width, height, depth } = this.image;
    const channels = this.detectChannels();
    const layerSize = width * height * channels;

    const isFloat = this.type === FloatType || this.type === HalfFloatType;
    const out = isFloat ? new Float32Array(layerSize * depth) : new Uint8ClampedArray(layerSize * depth);
    const invAmp = amplitude / 255;

    for (let layer = 0; layer < depth; layer++) {
      const zOffset = layer * 1000;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = layer * layerSize + (y * width + x) * channels;
          const n = (SimplexNoise.noise2D(x * frequency, y * frequency + zOffset) + 1) * 0.5;
          const d = SimplexNoise.noise2D(x * 0.1, y * 0.1 + layer * 0.1) * invAmp;
          const v = Math.max(0, Math.min(1, n + d));

          if (isFloat) {
            for (let c = 0; c < channels; c++) out[p + c] = v;
          } else {
            const byte = Math.floor(v * 255);
            for (let c = 0; c < channels; c++) out[p + c] = byte;
          }
        }
      }
    }

    this.image.data = out;
    this.needsUpdate = true;
    return this;
  }

  /**
   * Generate a gradient across all layers.
   * @param {number[]} [colorA=[0,0,0,1]]
   * @param {number[]} [colorB=[1,1,1,1]]
   * @param {'horizontal'|'vertical'|'layer'} [direction='horizontal']
   * @returns {this}
   */
  generateGradient(colorA = [0, 0, 0, 1], colorB = [1, 1, 1, 1], direction = 'horizontal') {
    const { width, height, depth } = this.image;
    const channels = this.detectChannels();
    const layerSize = width * height * channels;

    const isFloat = this.type === FloatType || this.type === HalfFloatType;
    const out = isFloat ? new Float32Array(layerSize * depth) : new Uint8ClampedArray(layerSize * depth);

    for (let layer = 0; layer < depth; layer++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let t;
          if (direction === 'vertical') t = y / Math.max(1, height - 1);
          else if (direction === 'layer') t = layer / Math.max(1, depth - 1);
          else t = x / Math.max(1, width - 1);

          const p = layer * layerSize + (y * width + x) * channels;
          for (let c = 0; c < channels; c++) {
            const a = colorA[c] !== undefined ? colorA[c] : 0;
            const b = colorB[c] !== undefined ? colorB[c] : 0;
            const v = a + (b - a) * t;
            out[p + c] = isFloat ? v : Math.floor(v * 255);
          }
        }
      }
    }

    this.image.data = out;
    this.needsUpdate = true;
    return this;
  }

  /**
   * Generate a checkerboard across all layers.
   * @param {number} [cellSize=8]
   * @param {number[]} [colorA=[0,0,0,1]]
   * @param {number[]} [colorB=[1,1,1,1]]
   * @returns {this}
   */
  generateCheckerboard(cellSize = 8, colorA = [0, 0, 0, 1], colorB = [1, 1, 1, 1]) {
    const { width, height, depth } = this.image;
    const channels = this.detectChannels();
    const layerSize = width * height * channels;

    const isFloat = this.type === FloatType || this.type === HalfFloatType;
    const out = isFloat ? new Float32Array(layerSize * depth) : new Uint8ClampedArray(layerSize * depth);

    for (let layer = 0; layer < depth; layer++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const check = ((x / cellSize | 0) ^ (y / cellSize | 0) ^ layer) & 1;
          const color = check ? colorB : colorA;
          const p = layer * layerSize + (y * width + x) * channels;

          for (let c = 0; c < channels; c++) {
            const v = color[c] !== undefined ? color[c] : 0;
            out[p + c] = isFloat ? v : Math.floor(v * 255);
          }
        }
      }
    }

    this.image.data = out;
    this.needsUpdate = true;
    return this;
  }

  /**
   * Generate a voxel field (3D noise) across all layers.
   * @param {number} [frequency=0.05]
   * @returns {this}
   */
  generateVoxelField(frequency = 0.05) {
    const { width, height, depth } = this.image;
    const channels = this.detectChannels();
    const layerSize = width * height * channels;

    const isFloat = this.type === FloatType || this.type === HalfFloatType;
    const out = isFloat ? new Float32Array(layerSize * depth) : new Uint8ClampedArray(layerSize * depth);

    for (let layer = 0; layer < depth; layer++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const n1 = SimplexNoise.noise2D(x * frequency, y * frequency + layer * 10);
          const n2 = SimplexNoise.noise2D(x * frequency + layer * 10, y * frequency);
          const v = Math.max(0, Math.min(1, ((n1 + n2) * 0.5 + 1) * 0.5));
          const p = layer * layerSize + (y * width + x) * channels;

          if (isFloat) {
            for (let c = 0; c < channels; c++) out[p + c] = v;
          } else {
            const byte = Math.floor(v * 255);
            for (let c = 0; c < channels; c++) out[p + c] = byte;
          }
        }
      }
    }

    this.image.data = out;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Copy / serialize
  // -----------------------------------------------------------------------

  copy(source) {
    super.copy(source);

    this.image = {
      data: source.image.data ? source.image.data.slice(0) : null,
      width: source.image.width,
      height: source.image.height,
      depth: source.image.depth,
    };
    this.source.data = this.image;

    this.magFilter = source.magFilter;
    this.minFilter = source.minFilter;

    this.generateMipmaps = source.generateMipmaps;
    this.flipY = source.flipY;
    this.unpackAlignment = source.unpackAlignment;

    this.layerUpdates.clear();
    for (const layer of source.layerUpdates) this.layerUpdates.add(layer);

    if (source.dynamicFeatures) {
      this.dynamicFeatures = { ...source.dynamicFeatures };
    }

    return this;
  }

  toJSON(meta) {
    const isRootObject = meta === undefined || typeof meta === 'string';
    const output = super.toJSON(meta);

    output.image = {
      width: this.image.width,
      height: this.image.height,
      depth: this.image.depth,
      dataType: this.image.data ? this.image.data.constructor.name : null,
      byteLength: this.image.data ? this.image.data.byteLength : 0,
    };

    output.dynamicFeatures = { ...this.dynamicFeatures };

    if (!isRootObject) {
      meta.textures[this.uuid] = output;
    }
    return output;
  }

  // -----------------------------------------------------------------------
  // Pool + batch helpers
  // -----------------------------------------------------------------------

  static createBatch() {
    return new DataArrayTextureBatch();
  }

  static acquire() {
    return _acquireArray();
  }

  release() {
    if (this.source) {
      this.source.release();
      this.source = null;
    }
    _releaseArray(this);
  }

  static clearPool() {
    _arrayPool.length = 0;
  }

  _resetForPool() {
    const parentReset = Texture.prototype._resetForPool;
    if (typeof parentReset === 'function') parentReset.call(this);

    this.isDataArrayTexture = true;
    this.image = { data: null, width: 1, height: 1, depth: 1 };
    this.source.data = this.image;
    this.magFilter = NearestFilter;
    this.minFilter = NearestFilter;
    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 1;
    this.layerUpdates.clear();
    this._pendingLayers.clear();

    this.dynamicFeatures = {
      autoChannelDetection: false,
      autoTypeCoercion: false,
      autoUpdateRanges: false,
      hdrMode: false,
      proceduralGenerators: false,
      lazyUpload: false,
      perLayerUpdates: true,
    };
  }

  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    return {
      ...base,
      isDataArrayTexture: 1,
      channels: this.detectChannels(),
      depth: this.image.depth,
      byteLength: this.image.data ? this.image.data.byteLength : 0,
      pendingLayers: this._pendingLayers.size,
      layerUpdateCount: this.layerUpdates.size,
      hdrMode: this.dynamicFeatures.hdrMode ? 1 : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  DataArrayTexture,
  DataArrayTextureBatch,
  layerByteOffsetPrecise,
  quantizeLayerDithered,
};
export default DataArrayTexture;