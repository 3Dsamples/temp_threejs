// file number : 151
// full path name : src/textures/151_texture.js
// description : Base class for all texture types (three.js r185) rewritten as a pure ES module with zero CDN imports. Extends the project's EventDispatcher (083) and imports Vector2, Vector3, Matrix3 from the project's math folder. Preserves the full r185 Texture API surface — mapping, wrapS/wrapT, magFilter/minFilter, format, type, offset/repeat/center/rotation, matrix, matrixAutoUpdate, generateMipmaps, premultiplyAlpha, flipY, unpackAlignment, colorSpace, userData, updateRanges, version, onUpdate, renderTarget, pmremVersion, normalized, width/height/depth getters, image getter/setter, updateMatrix(), addUpdateRange(), clearUpdateRanges(), clone(), copy(), setValues(), toJSON(), dispose(), transformUv(), plus the needsUpdate/needsPMREMUpdate setters. Adds Float64 UV transform precision using JS-native IEEE-754 doubles (no double.js), a flat typed-array TextureBatch for multi-texture parameter updates, SimplexNoise-based UV perturbation for procedural effects, and full pool integration via acquire()/release()/clearPool(). Integrates Source (150) for data provenance. Designed for 10k+ textures on Android 64-bit with zero CDN dependencies.
// best for : The foundational Texture class for CanvasTexture (152), CompressedTexture (153), CubeTexture (154), DataTexture (155), DataArrayTexture (156), Data3DTexture (157), DepthTexture (158), FramebufferTexture (159), VideoTexture (160), ExternalTexture (161), HTMLTexture (162), CompressedArrayTexture (163), CompressedCubeTexture (164), CubeDepthTexture (165), VideoFrameTexture (166), and every material that references a map at 10k+ entity scale on Android 64-bit.
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
import { EventDispatcher } from '../core/083_EventDispatcher.js';
import { Source } from './150_source.js';

// ---------------------------------------------------------------------------
// Local aliases for the project's Constants — keeps the file readable and
// avoids any external constant import.
// ---------------------------------------------------------------------------
const MirroredRepeatWrapping = Constants.MirroredRepeatWrapping;
const ClampToEdgeWrapping     = Constants.ClampToEdgeWrapping;
const RepeatWrapping          = Constants.RepeatWrapping;
const UnsignedByteType        = Constants.UnsignedByteType;
const RGBAFormat              = Constants.RGBAFormat;
const LinearMipmapLinearFilter = Constants.LinearMipmapLinearFilter;
const LinearFilter            = Constants.LinearFilter;
const UVMapping               = Constants.UVMapping;
const NoColorSpace            = Constants.NoColorSpace;

// ---------------------------------------------------------------------------
// Static pool for Texture instances — recycled to eliminate per-material
// allocation churn when 10k+ textures spawn/despawn in an ECS-driven scene.
// ---------------------------------------------------------------------------
const _texturePool = [];

function _acquireTexture() {
  const t = _texturePool.pop();
  if (t) {
    t._resetForPool();
    return t;
  }
  return new Texture();
}

function _releaseTexture(t) {
  if (_texturePool.length < 128) _texturePool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _v3 = new Float32Array(3);
const _uvA = new Float32Array(2);
const _uvB = new Float32Array(2);

let _textureId = 0;

// ---------------------------------------------------------------------------
// UUID generator — locally defined (no CDN, no crypto requirement).
// ---------------------------------------------------------------------------
function _generateUUID() {
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
// TextureBatch — flat typed-array batch coordinator for multi-texture
// parameter updates. Replaces the original per-entity bitecs layout,
// eliminating entity allocation and improving cache locality at 10k+ scale.
// ---------------------------------------------------------------------------
class TextureBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._texPtr     = new Int32Array(capacity);
    this._offsetX    = new Float64Array(capacity);
    this._offsetY    = new Float64Array(capacity);
    this._repeatX    = new Float64Array(capacity);
    this._repeatY    = new Float64Array(capacity);
    this._rotation   = new Float64Array(capacity);
    this._centerX    = new Float64Array(capacity);
    this._centerY    = new Float64Array(capacity);
    this._applied    = new Uint8Array(capacity);

    this._textures = [];
    this._capacity = capacity;
  }

  /**
   * Grow internal arrays to hold at least `capacity` textures.
   * @private
   */
  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 32);

    const a = new Int32Array(newCap);  a.set(this._texPtr);   this._texPtr = a;
    const b = new Float64Array(newCap); b.set(this._offsetX);  this._offsetX = b;
    const c = new Float64Array(newCap); c.set(this._offsetY);  this._offsetY = c;
    const d = new Float64Array(newCap); d.set(this._repeatX);  this._repeatX = d;
    const e = new Float64Array(newCap); e.set(this._repeatY);  this._repeatY = e;
    const f = new Float64Array(newCap); f.set(this._rotation); this._rotation = f;
    const g = new Float64Array(newCap); g.set(this._centerX);  this._centerX = g;
    const h = new Float64Array(newCap); h.set(this._centerY);  this._centerY = h;
    const i = new Uint8Array(newCap);   i.set(this._applied);  this._applied = i;

    this._capacity = newCap;
  }

  /**
   * Register a Texture instance for batched parameter updates.
   *
   * @param {Texture} texture
   * @returns {number} texture index
   */
  addTexture(texture) {
    this._textures.push(texture);
    return this._textures.length - 1;
  }

  /**
   * Queue a parameter update for a registered texture.
   *
   * @param {number} textureId
   * @param {object} [params={}] — offsetX, offsetY, repeatX, repeatY,
   *   rotation, centerX, centerY
   * @returns {number} update index
   */
  addUpdate(textureId, params = {}) {
    this._ensure(this._count + 1);
    const i = this._count++;

    this._texPtr[i] = textureId;
    this._offsetX[i] = params.offsetX !== undefined ? params.offsetX : 0;
    this._offsetY[i] = params.offsetY !== undefined ? params.offsetY : 0;
    this._repeatX[i] = params.repeatX !== undefined ? params.repeatX : 1;
    this._repeatY[i] = params.repeatY !== undefined ? params.repeatY : 1;
    this._rotation[i] = params.rotation !== undefined ? params.rotation : 0;
    this._centerX[i] = params.centerX !== undefined ? params.centerX : 0;
    this._centerY[i] = params.centerY !== undefined ? params.centerY : 0;
    this._applied[i] = 0;

    return i;
  }

  /**
   * Apply all queued parameter updates in one cache-friendly pass.
   */
  process() {
    const n = this._count;
    for (let i = 0; i < n; i++) {
      const texture = this._textures[this._texPtr[i]];
      if (!texture) continue;

      texture.offset[0] = this._offsetX[i];
      texture.offset[1] = this._offsetY[i];
      texture.repeat[0] = this._repeatX[i];
      texture.repeat[1] = this._repeatY[i];
      texture.center[0] = this._centerX[i];
      texture.center[1] = this._centerY[i];
      texture.rotation = this._rotation[i];

      if (texture.matrixAutoUpdate) texture.updateMatrix();

      this._applied[i] = 1;
    }
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
      offsetX: this._offsetX,
      offsetY: this._offsetY,
      repeatX: this._repeatX,
      repeatY: this._repeatY,
      rotation: this._rotation,
      centerX: this._centerX,
      centerY: this._centerY,
      applied: this._applied,
    };
  }
}

// ---------------------------------------------------------------------------
// Float64-precision UV transform for extreme tiling (repeat > 1e6).
// JS numbers are IEEE-754 doubles, so no double.js is needed.
// ---------------------------------------------------------------------------
function transformUvPrecise(texture, u, v) {
  if (texture.mapping !== UVMapping) return { u, v };

  const m = texture.matrix.elements;
  let outU = m[0] * u + m[3] * v + m[6];
  let outV = m[1] * u + m[4] * v + m[7];

  if (outU < 0 || outU > 1) {
    switch (texture.wrapS) {
      case RepeatWrapping:
        outU = outU - Math.floor(outU);
        break;
      case ClampToEdgeWrapping:
        outU = outU < 0 ? 0 : 1;
        break;
      case MirroredRepeatWrapping:
        if (Math.abs(Math.floor(outU) % 2) === 1) {
          outU = Math.ceil(outU) - outU;
        } else {
          outU = outU - Math.floor(outU);
        }
        break;
    }
  }

  if (outV < 0 || outV > 1) {
    switch (texture.wrapT) {
      case RepeatWrapping:
        outV = outV - Math.floor(outV);
        break;
      case ClampToEdgeWrapping:
        outV = outV < 0 ? 0 : 1;
        break;
      case MirroredRepeatWrapping:
        if (Math.abs(Math.floor(outV) % 2) === 1) {
          outV = Math.ceil(outV) - outV;
        } else {
          outV = outV - Math.floor(outV);
        }
        break;
    }
  }

  if (texture.flipY) outV = 1 - outV;

  return { u: outU, v: outV };
}

// ---------------------------------------------------------------------------
// SimplexNoise-dithered UV perturbation for procedural texture effects.
// ---------------------------------------------------------------------------
function perturbUvNoisy(texture, u, v, amplitude = 0.01, frequency = 1, offset = 0) {
  const du = SimplexNoise.noise2D(u * frequency + offset, v * frequency) * amplitude;
  const dv = SimplexNoise.noise2D(u * frequency + offset, v * frequency + 100) * amplitude;
  return transformUvPrecise(texture, u + du, v + dv);
}

// ---------------------------------------------------------------------------
// Texture — mirrors three.js r185 Texture
// ---------------------------------------------------------------------------
class Texture extends EventDispatcher {
  /**
   * @param {?Object} [image=null] — the image holding the texture data
   * @param {number} [mapping=UVMapping]
   * @param {number} [wrapS=ClampToEdgeWrapping]
   * @param {number} [wrapT=ClampToEdgeWrapping]
   * @param {number} [magFilter=LinearFilter]
   * @param {number} [minFilter=LinearMipmapLinearFilter]
   * @param {number} [format=RGBAFormat]
   * @param {number} [type=UnsignedByteType]
   * @param {number} [anisotropy=1]
   * @param {string} [colorSpace=NoColorSpace]
   */
  constructor(
    image = Texture.DEFAULT_IMAGE,
    mapping = Texture.DEFAULT_MAPPING,
    wrapS = ClampToEdgeWrapping,
    wrapT = ClampToEdgeWrapping,
    magFilter = LinearFilter,
    minFilter = LinearMipmapLinearFilter,
    format = RGBAFormat,
    type = UnsignedByteType,
    anisotropy = Texture.DEFAULT_ANISOTROPY,
    colorSpace = NoColorSpace
  ) {
    super();

    this.isTexture = true;
    Object.defineProperty(this, 'id', { value: _textureId++ });

    this.uuid = _generateUUID();
    this.name = '';

    this.source = new Source(image);

    this.mipmaps = [];

    this.mapping = mapping;
    this.channel = 0;

    this.wrapS = wrapS;
    this.wrapT = wrapT;

    this.magFilter = magFilter;
    this.minFilter = minFilter;

    this.anisotropy = anisotropy;

    this.format = format;
    this.internalFormat = null;
    this.type = type;

    this.offset = new Vec2(0, 0);
    this.repeat = new Vec2(1, 1);
    this.center = new Vec2(0, 0);
    this.rotation = 0;

    this.matrixAutoUpdate = true;
    this.matrix = new Mat3();

    this.generateMipmaps = true;
    this.premultiplyAlpha = false;
    this.flipY = true;
    this.unpackAlignment = 4;

    this.colorSpace = colorSpace;

    this.userData = {};

    this.updateRanges = [];

    this.version = 0;
    this.onUpdate = null;

    this.renderTarget = null;
    this.isRenderTargetTexture = false;

    this.isArrayTexture = image && image.depth && image.depth > 1 ? true : false;

    this.pmremVersion = 0;

    this.normalized = false;
  }

  // -----------------------------------------------------------------------
  // Size getters — delegate to Source.getSize()
  // -----------------------------------------------------------------------
  get width()  { this.source.getSize(_v3); return _v3[0]; }
  get height() { this.source.getSize(_v3); return _v3[1]; }
  get depth()  { this.source.getSize(_v3); return _v3[2]; }

  get image() { return this.source.data; }
  set image(value) { this.source.data = value; }

  // -----------------------------------------------------------------------
  // Matrix
  // -----------------------------------------------------------------------
  updateMatrix() {
    this.matrix.setUvTransform(
      this.offset[0],
      this.offset[1],
      this.repeat[0],
      this.repeat[1],
      this.rotation,
      this.center[0],
      this.center[1]
    );
  }

  // -----------------------------------------------------------------------
  // Update ranges
  // -----------------------------------------------------------------------
  addUpdateRange(start, count) {
    this.updateRanges.push({ start, count });
  }

  clearUpdateRanges() {
    this.updateRanges.length = 0;
  }

  // -----------------------------------------------------------------------
  // Copy / clone / serialize
  // -----------------------------------------------------------------------
  clone() {
    return new this.constructor().copy(this);
  }

  copy(source) {
    this.name = source.name;

    this.source = source.source;
    this.mipmaps = source.mipmaps.slice(0);

    this.mapping = source.mapping;
    this.channel = source.channel;

    this.wrapS = source.wrapS;
    this.wrapT = source.wrapT;

    this.magFilter = source.magFilter;
    this.minFilter = source.minFilter;

    this.anisotropy = source.anisotropy;

    this.format = source.format;
    this.internalFormat = source.internalFormat;
    this.type = source.type;

    this.normalized = source.normalized;

    this.offset[0] = source.offset[0];
    this.offset[1] = source.offset[1];
    this.repeat[0] = source.repeat[0];
    this.repeat[1] = source.repeat[1];
    this.center[0] = source.center[0];
    this.center[1] = source.center[1];
    this.rotation = source.rotation;

    this.matrixAutoUpdate = source.matrixAutoUpdate;
    this.matrix.copy(source.matrix);

    this.generateMipmaps = source.generateMipmaps;
    this.premultiplyAlpha = source.premultiplyAlpha;
    this.flipY = source.flipY;
    this.unpackAlignment = source.unpackAlignment;
    this.colorSpace = source.colorSpace;

    this.renderTarget = source.renderTarget;
    this.isRenderTargetTexture = source.isRenderTargetTexture;
    this.isArrayTexture = source.isArrayTexture;

    this.userData = JSON.parse(JSON.stringify(source.userData));

    this.needsUpdate = true;
    return this;
  }

  setValues(values) {
    for (const key in values) {
      const newValue = values[key];
      if (newValue === undefined) continue;

      const currentValue = this[key];

      if (currentValue && newValue && currentValue.isVector2 && newValue.isVector2) {
        currentValue.copy(newValue);
      } else if (currentValue && newValue && currentValue.isVector3 && newValue.isVector3) {
        currentValue.copy(newValue);
      } else if (currentValue && newValue && currentValue.isMatrix3 && newValue.isMatrix3) {
        currentValue.copy(newValue);
      } else {
        this[key] = newValue;
      }
    }
  }

  toJSON(meta) {
    const isRootObject = meta === undefined || typeof meta === 'string';

    if (!isRootObject && meta.textures[this.uuid] !== undefined) {
      return meta.textures[this.uuid];
    }

    const output = {
      metadata: { version: 4.7, type: 'Texture', generator: 'Texture.toJSON' },
      uuid: this.uuid,
      name: this.name,
      image: this.source.toJSON(meta).uuid,
      mapping: this.mapping,
      channel: this.channel,
      repeat: [this.repeat[0], this.repeat[1]],
      offset: [this.offset[0], this.offset[1]],
      center: [this.center[0], this.center[1]],
      rotation: this.rotation,
      wrap: [this.wrapS, this.wrapT],
      format: this.format,
      internalFormat: this.internalFormat,
      type: this.type,
      normalized: this.normalized,
      colorSpace: this.colorSpace,
      minFilter: this.minFilter,
      magFilter: this.magFilter,
      anisotropy: this.anisotropy,
      flipY: this.flipY,
      generateMipmaps: this.generateMipmaps,
      premultiplyAlpha: this.premultiplyAlpha,
      unpackAlignment: this.unpackAlignment,
    };

    if (Object.keys(this.userData).length > 0) output.userData = this.userData;

    if (!isRootObject) meta.textures[this.uuid] = output;

    return output;
  }

  // -----------------------------------------------------------------------
  // Dispose
  // -----------------------------------------------------------------------
  dispose() {
    this.dispatchEvent({ type: 'dispose' });
  }

  // -----------------------------------------------------------------------
  // UV transform
  // -----------------------------------------------------------------------
  transformUv(uv) {
    if (this.mapping !== UVMapping) return uv;

    uv.applyMatrix3(this.matrix);

    if (uv[0] < 0 || uv[0] > 1) {
      switch (this.wrapS) {
        case RepeatWrapping:
          uv[0] = uv[0] - Math.floor(uv[0]);
          break;
        case ClampToEdgeWrapping:
          uv[0] = uv[0] < 0 ? 0 : 1;
          break;
        case MirroredRepeatWrapping:
          if (Math.abs(Math.floor(uv[0]) % 2) === 1) {
            uv[0] = Math.ceil(uv[0]) - uv[0];
          } else {
            uv[0] = uv[0] - Math.floor(uv[0]);
          }
          break;
      }
    }

    if (uv[1] < 0 || uv[1] > 1) {
      switch (this.wrapT) {
        case RepeatWrapping:
          uv[1] = uv[1] - Math.floor(uv[1]);
          break;
        case ClampToEdgeWrapping:
          uv[1] = uv[1] < 0 ? 0 : 1;
          break;
        case MirroredRepeatWrapping:
          if (Math.abs(Math.floor(uv[1]) % 2) === 1) {
            uv[1] = Math.ceil(uv[1]) - uv[1];
          } else {
            uv[1] = uv[1] - Math.floor(uv[1]);
          }
          break;
      }
    }

    if (this.flipY) uv[1] = 1 - uv[1];

    return uv;
  }

  // -----------------------------------------------------------------------
  // Accelerated extensions
  // -----------------------------------------------------------------------

  /**
   * Zero-allocation UV transform via the project's Vec2 module.
   * @param {Float32Array} out — length-2 output buffer
   * @param {number} u
   * @param {number} v
   * @returns {Float32Array}
   */
  transformUvFast(out, u, v) {
    Vec2.set(_uvA, u, v);
    const result = this.transformUv(_uvA);
    Vec2.set(out, result[0], result[1]);
    return out;
  }

  /**
   * Float64-precision UV transform for extreme tiling (repeat > 1e6).
   * @param {number} u
   * @param {number} v
   * @returns {{u: number, v: number}}
   */
  transformUvPrecise(u, v) {
    return transformUvPrecise(this, u, v);
  }

  /**
   * SimplexNoise-dithered UV perturbation for procedural effects.
   * @param {number} u
   * @param {number} v
   * @param {number} [amplitude=0.01]
   * @param {number} [frequency=1]
   * @param {number} [offset=0]
   * @returns {{u: number, v: number}}
   */
  perturbUvNoisy(u, v, amplitude = 0.01, frequency = 1, offset = 0) {
    return perturbUvNoisy(this, u, v, amplitude, frequency, offset);
  }

  // -----------------------------------------------------------------------
  // Setters — mirror r185 semantics
  // -----------------------------------------------------------------------
  set needsUpdate(value) {
    if (value === true) {
      this.version++;
      this.source.needsUpdate = true;
    }
  }

  set needsPMREMUpdate(value) {
    if (value === true) {
      this.pmremVersion++;
    }
  }

  // -----------------------------------------------------------------------
  // Pool + batch helpers
  // -----------------------------------------------------------------------

  /**
   * Create a flat typed-array batch coordinator for N textures.
   * @returns {TextureBatch}
   */
  static createBatch() {
    return new TextureBatch();
  }

  /**
   * Acquire a pooled Texture instance (default state).
   * @returns {Texture}
   */
  static acquire() {
    return _acquireTexture();
  }

  /**
   * Return this Texture to the pool. Caller must not use it afterward.
   */
  release() {
    if (this.source) {
      this.source.release();
      this.source = null;
    }
    _releaseTexture(this);
  }

  /**
   * Clear the global Texture pool.
   */
  static clearPool() {
    _texturePool.length = 0;
  }

  /**
   * Reset internal state for pool re-use. Called internally when a pooled
   * instance is returned.
   * @private
   */
  _resetForPool() {
    this.name = '';
    this.uuid = _generateUUID();
    this.mipmaps = [];
    this.mapping = Texture.DEFAULT_MAPPING;
    this.channel = 0;
    this.wrapS = ClampToEdgeWrapping;
    this.wrapT = ClampToEdgeWrapping;
    this.magFilter = LinearFilter;
    this.minFilter = LinearMipmapLinearFilter;
    this.anisotropy = Texture.DEFAULT_ANISOTROPY;
    this.format = RGBAFormat;
    this.internalFormat = null;
    this.type = UnsignedByteType;
    this.normalized = false;
    this.offset[0] = 0; this.offset[1] = 0;
    this.repeat[0] = 1; this.repeat[1] = 1;
    this.center[0] = 0; this.center[1] = 0;
    this.rotation = 0;
    this.matrixAutoUpdate = true;
    this.matrix.identity();
    this.generateMipmaps = true;
    this.premultiplyAlpha = false;
    this.flipY = true;
    this.unpackAlignment = 4;
    this.colorSpace = NoColorSpace;
    this.userData = {};
    this.updateRanges.length = 0;
    this.version = 0;
    this.onUpdate = null;
    this.renderTarget = null;
    this.isRenderTargetTexture = false;
    this.isArrayTexture = false;
    this.pmremVersion = 0;
    this.source = new Source(null);
  }

  /**
   * Expose this Texture's state as a flat typed-array column set for
   * ECS-driven texture-management systems.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    return {
      name,
      id: this.id,
      uuid: this.uuid,
      version: this.version,
      pmremVersion: this.pmremVersion,
      width: this.width,
      height: this.height,
      depth: this.depth,
      mapping: this.mapping,
      wrapS: this.wrapS,
      wrapT: this.wrapT,
      magFilter: this.magFilter,
      minFilter: this.minFilter,
      format: this.format,
      type: this.type,
      offsetX: this.offset[0],
      offsetY: this.offset[1],
      repeatX: this.repeat[0],
      repeatY: this.repeat[1],
      rotation: this.rotation,
      generateMipmaps: this.generateMipmaps ? 1 : 0,
      flipY: this.flipY ? 1 : 0,
      colorSpace: this.colorSpace,
    };
  }
}

// ---------------------------------------------------------------------------
// Static defaults — mirrors r185
// ---------------------------------------------------------------------------
Texture.DEFAULT_IMAGE = null;
Texture.DEFAULT_MAPPING = UVMapping;
Texture.DEFAULT_ANISOTROPY = 1;

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  Texture,
  TextureBatch,
  transformUvPrecise,
  perturbUvNoisy,
};
export default Texture;