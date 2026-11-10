// file number : 153
// full path name : src/textures/153_compressedtexture.js
// description : CompressedTexture (three.js r185) rewritten as a pure ES module with zero CDN imports. Extends Texture (151) and stores pre-compressed mipmaps (KTX, KTX2, DDS, Basis, ASTC, ETC, PVR) instead of a single image source. Preserves the full r185 CompressedTexture API — mipmaps array, image proxy with {width, height, depth}, generateMipmaps=false, flipY=false, unpackAlignment=1, needsUpdate=true on construction, plus clone(), copy(), toJSON() inherited from Texture. Adds zero-allocation mip sampling via the project's Vec4 module, a flat typed-array CompressedTextureBatch for multi-KTX pipelines (batch-loading compressed texture atlases), Float64 computeMipChainBytesPrecise using native JS IEEE-754 doubles (no double.js), SimplexNoise-dithered generateFallbackImage for platforms lacking native compression, and full pool integration via acquire()/release()/clearPool(). Integrates Source (150) for data provenance and Constants (002) for format defaults. Designed for 10k+ compressed textures on Android 64-bit with zero CDN dependencies.
// best for : CompressedTexture, KTX/KTX2/DDS/Basis/ASTC/ETC/PVR loaders, GPU compressed texture pipelines, memory-constrained mobile/VR rendering, texture atlases, GPU memory budgeting, and any three.js workflow that streams pre-compressed texture data at 10k+ entity scale on Android 64-bit.
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
const NoColorSpace            = Constants.NoColorSpace;
const LinearFilter            = Constants.LinearFilter;
const LinearMipmapLinearFilter = Constants.LinearMipmapLinearFilter;
const RGBAFormat              = Constants.RGBAFormat;
const UnsignedByteType        = Constants.UnsignedByteType;
const UVMapping               = Constants.UVMapping;
const ClampToEdgeWrapping     = Constants.ClampToEdgeWrapping;

// ---------------------------------------------------------------------------
// Static pool for CompressedTexture instances — recycled to eliminate per-
// material allocation churn when 10k+ compressed textures spawn/despawn in
// an ECS-driven scene.
// ---------------------------------------------------------------------------
const _compressedPool = [];

function _acquireCompressed() {
  const t = _compressedPool.pop();
  if (t) {
    t._resetForPool();
    return t;
  }
  return new CompressedTexture();
}

function _releaseCompressed(t) {
  if (_compressedPool.length < 64) _compressedPool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _rgba = new Float32Array(4);
const _vec3 = new Float32Array(3);

// ---------------------------------------------------------------------------
// CompressedTextureBatch — flat typed-array batch coordinator for multi-KTX
// pipelines. Replaces the original per-entity bitecs layout, eliminating
// entity allocation and improving cache locality for 10k+ textures.
// ---------------------------------------------------------------------------
class CompressedTextureBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._texPtr    = new Int32Array(capacity);
    this._mipLevel  = new Uint16Array(capacity);
    this._width     = new Int32Array(capacity);
    this._height    = new Int32Array(capacity);
    this._depth     = new Int32Array(capacity);
    this._byteLen   = new Float64Array(capacity);
    this._validated = new Uint8Array(capacity);

    this._textures = [];
    this._capacity = capacity;
  }

  /**
   * Grow internal arrays to hold at least `capacity` mip records.
   * @private
   */
  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 64);

    const a = new Int32Array(newCap);   a.set(this._texPtr);    this._texPtr = a;
    const b = new Uint16Array(newCap);  b.set(this._mipLevel);  this._mipLevel = b;
    const c = new Int32Array(newCap);   c.set(this._width);     this._width = c;
    const d = new Int32Array(newCap);   d.set(this._height);    this._height = d;
    const e = new Int32Array(newCap);   e.set(this._depth);     this._depth = e;
    const f = new Float64Array(newCap); f.set(this._byteLen);   this._byteLen = f;
    const g = new Uint8Array(newCap);   g.set(this._validated); this._validated = g;

    this._capacity = newCap;
  }

  /**
   * Register a CompressedTexture instance for batched validation.
   *
   * @param {CompressedTexture} texture
   * @returns {number} texture index
   */
  addTexture(texture) {
    this._textures.push(texture);
    return this._textures.length - 1;
  }

  /**
   * Enumerate all mip levels of a registered compressed texture and queue
   * one validation job per mip.
   *
   * @param {number} textureId
   * @returns {number} first mip index created
   */
  enumerateMips(textureId) {
    const texture = this._textures[textureId];
    if (!texture) return -1;

    const mipmaps = texture.mipmaps || [];
    const firstIndex = this._count;

    for (let m = 0; m < mipmaps.length; m++) {
      const mip = mipmaps[m];
      if (!mip) continue;

      this._ensure(this._count + 1);
      const i = this._count++;

      this._texPtr[i] = textureId;
      this._mipLevel[i] = m;
      this._width[i] = mip.width || 0;
      this._height[i] = mip.height || 0;
      this._depth[i] = mip.depth !== undefined ? mip.depth : 1;
      this._byteLen[i] = mip.data && mip.data.byteLength !== undefined
        ? mip.data.byteLength
        : (mip.width || 0) * (mip.height || 0) * 4;
      this._validated[i] = 0;
    }

    return firstIndex;
  }

  /**
   * Validate all queued mip levels in one cache-friendly pass. Each mip's
   * dimensions must be exactly half of its parent (in both width and
   * height) to form a valid GPU-compressed mip chain.
   */
  process() {
    const n = this._count;

    // mip 0 is always valid
    for (let i = 0; i < n; i++) {
      if (this._mipLevel[i] === 0) {
        this._validated[i] = 1;
      }
    }

    // mip 1+ must match parent/2
    for (let i = 0; i < n; i++) {
      const m = this._mipLevel[i];
      if (m === 0) continue;

      const texPtr = this._texPtr[i];

      // Find parent mip
      let parentIdx = -1;
      for (let j = 0; j < n; j++) {
        if (this._texPtr[j] === texPtr && this._mipLevel[j] === m - 1) {
          parentIdx = j;
          break;
        }
      }

      if (parentIdx === -1) {
        this._validated[i] = 0;
        continue;
      }

      const expectedW = Math.max(1, this._width[parentIdx] >> 1);
      const expectedH = Math.max(1, this._height[parentIdx] >> 1);

      const ok = this._width[i] === expectedW && this._height[i] === expectedH;
      this._validated[i] = ok ? 1 : 0;
    }
  }

  /**
   * Retrieve validation results as a Uint8Array (1 = valid, 0 = invalid).
   * @returns {Uint8Array}
   */
  results() {
    return this._validated.subarray(0, this._count);
  }

  /**
   * Reset for reuse (keeps internal capacity and registered textures).
   */
  reset() {
    this._count = 0;
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
      texPtr: this._texPtr,
      mipLevel: this._mipLevel,
      width: this._width,
      height: this._height,
      depth: this._depth,
      byteLen: this._byteLen,
      validated: this._validated,
    };
  }
}

// ---------------------------------------------------------------------------
// Float64 mip-chain byte length — JS numbers are IEEE-754 doubles, so no
// double.js is needed. Preserves bit-exact accumulation up to 2^53 bytes.
// ---------------------------------------------------------------------------
function computeMipChainBytesPrecise(mipmaps) {
  let total = 0;
  for (let i = 0, l = mipmaps.length; i < l; i++) {
    const mip = mipmaps[i];
    if (!mip) continue;

    if (mip.data && mip.data.byteLength !== undefined) {
      total += mip.data.byteLength;
    } else {
      total += (mip.width || 0) * (mip.height || 0) * 4;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// SimplexNoise-dithered fallback image for platforms without native
// compression support.
// ---------------------------------------------------------------------------
function generateFallbackImage(width, height, amplitude = 0.5) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  const out = new Uint8ClampedArray(w * h * 4);
  const invAmp = amplitude / 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const d = SimplexNoise.noise2D(x * 0.05, y * 0.05) * invAmp;
      const check = ((x >> 4) ^ (y >> 4)) & 1;

      out[p]     = Math.max(0, Math.min(255, (check ? 0.6 : 0.4) * 255 + d * 255));
      out[p + 1] = Math.max(0, Math.min(255, 0.3 * 255 + d * 255));
      out[p + 2] = Math.max(0, Math.min(255, 0.7 * 255 + d * 255));
      out[p + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CompressedTexture — mirrors three.js r185 CompressedTexture
// ---------------------------------------------------------------------------
class CompressedTexture extends Texture {
  /**
   * @param {Array} [mipmaps=[]] — array of mip descriptors, each with
   *   `data`, `width`, `height`, optional `depth`
   * @param {number} [width=1]
   * @param {number} [height=1]
   * @param {number} [format=RGBAFormat]
   * @param {number} [type=UnsignedByteType]
   * @param {number} [mapping=Texture.DEFAULT_MAPPING]
   * @param {number} [wrapS=ClampToEdgeWrapping]
   * @param {number} [wrapT=ClampToEdgeWrapping]
   * @param {number} [magFilter=LinearFilter]
   * @param {number} [minFilter=LinearMipmapLinearFilter]
   * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY]
   * @param {string} [colorSpace=NoColorSpace]
   */
  constructor(
    mipmaps = [],
    width = 1,
    height = 1,
    format = RGBAFormat,
    type = UnsignedByteType,
    mapping = Texture.DEFAULT_MAPPING,
    wrapS = ClampToEdgeWrapping,
    wrapT = ClampToEdgeWrapping,
    magFilter = LinearFilter,
    minFilter = LinearMipmapLinearFilter,
    anisotropy = Texture.DEFAULT_ANISOTROPY,
    colorSpace = NoColorSpace
  ) {
    super(
      null,
      mapping,
      wrapS,
      wrapT,
      magFilter,
      minFilter,
      format,
      type,
      anisotropy,
      colorSpace
    );

    this.isCompressedTexture = true;

    // Override the image placeholder with the compressed dimensions
    this.source.data = { width, height, depth: 1 };

    // Mipmaps array — each entry: { data, width, height, depth? }
    this.mipmaps = mipmaps;

    // Compressed textures manage their own GPU state
    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 1;

    // Mark for immediate upload
    this.needsUpdate = true;

    // Optional CPU-side fallback for platforms without native compression
    this._fallback = null;
  }

  // -----------------------------------------------------------------------
  // Accelerated extensions
  // -----------------------------------------------------------------------

  /**
   * Zero-allocation pixel sample from the CPU-side fallback buffer (if any).
   * Compressed textures normally have no CPU-readable pixels.
   *
   * @param {Float32Array} [out] — length-4 output buffer
   * @param {number} [u=0.5] — U coordinate in [0, 1]
   * @param {number} [v=0.5] — V coordinate in [0, 1]
   * @returns {Float32Array|null}
   */
  sampleGlMat(out = _rgba, u = 0.5, v = 0.5) {
    if (!this._fallback) return null;

    const fb = this._fallback;
    const x = Math.min(fb.width - 1, Math.max(0, Math.floor(u * fb.width)));
    const y = Math.min(fb.height - 1, Math.max(0, Math.floor(v * fb.height)));
    const p = (y * fb.width + x) * 4;

    Vec4.set(
      out,
      fb.data[p] / 255,
      fb.data[p + 1] / 255,
      fb.data[p + 2] / 255,
      fb.data[p + 3] / 255
    );
    return out;
  }

  /**
   * Float64 total mip-chain byte length (no double.js). Preserves bit-exact
   * accumulation up to 2^53 bytes.
   *
   * @returns {number}
   */
  getMipChainBytesPrecise() {
    return computeMipChainBytesPrecise(this.mipmaps);
  }

  /**
   * Generate a SimplexNoise-dithered fallback image for platforms without
   * native support for this compression format.
   *
   * @param {number} [amplitude=0.5]
   * @returns {this}
   */
  generateFallback(amplitude = 0.5) {
    const size = this.source.getSize(_vec3);
    this._fallback = {
      width: size[0] || 1,
      height: size[1] || 1,
      data: generateFallbackImage(size[0] || 1, size[1] || 1, amplitude),
    };
    return this;
  }

  // -----------------------------------------------------------------------
  // Copy / serialize
  // -----------------------------------------------------------------------

  /**
   * Copy another CompressedTexture into this one.
   * @param {CompressedTexture} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);

    this.mipmaps = source.mipmaps.slice(0);
    this.source.data = {
      width: source.source.data.width,
      height: source.source.data.height,
      depth: source.source.data.depth !== undefined ? source.source.data.depth : 1,
    };

    return this;
  }

  /**
   * Serialize to JSON. Compressed pixel data is not serialized — only
   * structural metadata is preserved.
   *
   * @param {?(object|string)} meta
   * @returns {object}
   */
  toJSON(meta) {
    const isRootObject = meta === undefined || typeof meta === 'string';
    const output = super.toJSON(meta);

    output.image = {
      width: this.source.data.width,
      height: this.source.data.height,
      depth: this.source.data.depth !== undefined ? this.source.data.depth : 1,
    };

    output.mipmaps = this.mipmaps.map((mip) => ({
      width: mip.width || 0,
      height: mip.height || 0,
      depth: mip.depth !== undefined ? mip.depth : 1,
      byteLength: mip.data ? mip.data.byteLength : 0,
    }));

    if (!isRootObject) {
      meta.textures[this.uuid] = output;
    }
    return output;
  }

  // -----------------------------------------------------------------------
  // Pool + batch helpers
  // -----------------------------------------------------------------------

  /**
   * Create a flat typed-array batch coordinator for N compressed textures.
   * @returns {CompressedTextureBatch}
   */
  static createBatch() {
    return new CompressedTextureBatch();
  }

  /**
   * Acquire a pooled CompressedTexture instance.
   * @returns {CompressedTexture}
   */
  static acquire() {
    return _acquireCompressed();
  }

  /**
   * Return this CompressedTexture to the pool. Caller must not use it
   * afterward.
   */
  release() {
    if (this.source) {
      this.source.release();
      this.source = null;
    }
    _releaseCompressed(this);
  }

  /**
   * Clear the global CompressedTexture pool.
   */
  static clearPool() {
    _compressedPool.length = 0;
  }

  /**
   * Reset internal state for pool re-use.
   * @private
   */
  _resetForPool() {
    // Reuse the base Texture pool reset via direct call
    const parentReset = Texture.prototype._resetForPool;
    if (typeof parentReset === 'function') parentReset.call(this);

    this.isCompressedTexture = true;
    this.source.data = { width: 1, height: 1, depth: 1 };
    this.mipmaps = [];
    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 1;
    this.needsUpdate = true;
    this._fallback = null;
  }

  /**
   * Expose this CompressedTexture's state as flat typed-array columns for
   * ECS-driven texture-management systems.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    return {
      ...base,
      isCompressedTexture: 1,
      mipCount: this.mipmaps.length,
      mipChainBytes: this.getMipChainBytesPrecise(),
      hasFallback: this._fallback ? 1 : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  CompressedTexture,
  CompressedTextureBatch,
  computeMipChainBytesPrecise,
  generateFallbackImage,
};
export default CompressedTexture;