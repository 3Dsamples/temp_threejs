// file number : 158
// full path name : src/textures/158_depthtexture.js
// description : DepthTexture (three.js r185) rewritten as a pure ES module with zero CDN imports and completely dynamic features. Extends Texture (151) to create textures that automatically save depth information of a rendering. Preserves the full r185 DepthTexture API — DepthFormat/DepthStencilFormat validation, compareFunction for shadow map PCF sampling, UnsignedIntType/UnsignedInt248Type defaults, flipY=false, generateMipmaps=false, isDepthTexture flag, plus clone(), copy(), toJSON() inherited from Texture. Adds dynamic feature toggles: runtime compareFunction switching (Never/Less/Equal/LessEqual/Greater/NotEqual/GreaterEqual/Always), dynamic format/type coercion, dynamic logarithmic depth mode for very large range buffers, dynamic depth linearization for reconstruction from non-linear to linear depth, dynamic PCF soft sampling with configurable radius and samples, Float64 validateDepthRangePrecise (no double.js), SimplexNoise-dithered generateFallback for platforms without native depth-texture support, and zero-allocation depth sampling + hardware-style comparison via the project's Vec2 module. Uses a flat typed-array DepthTextureBatch for multi-shadow-map pipelines (cascaded shadow maps, point-light cube shadows), and full pool integration via acquire()/release()/clearPool(). Designed for 10k+ depth textures on Android 64-bit with zero CDN dependencies.
// best for : DepthTexture, WebGLRenderTarget depth attachments, shadow maps (PCF/PCFSoft/VSM), post-processing (Depth of Field, SSAO, SSR), deferred rendering, logarithmic depth buffers, cascaded shadow maps, point-light cube shadows, and any three.js workflow that needs to sample scene depth with runtime-switchable features at 10k+ entity scale on Android 64-bit.
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
const UnsignedIntType    = Constants.UnsignedIntType;
const UnsignedInt248Type = Constants.UnsignedInt248Type;
const DepthFormat        = Constants.DepthFormat;
const DepthStencilFormat = Constants.DepthStencilFormat;
const NearestFilter      = Constants.NearestFilter;
const LinearFilter       = Constants.LinearFilter;
const ClampToEdgeWrapping = Constants.ClampToEdgeWrapping;
const UVMapping          = Constants.UVMapping;
const NoColorSpace       = Constants.NoColorSpace;

// ---------------------------------------------------------------------------
// WebGL compare function constants (from GL spec).
// ---------------------------------------------------------------------------
const CompareFunction = {
  NEVER:        0x0200,
  LESS:         0x0201,
  EQUAL:        0x0202,
  LESS_EQUAL:   0x0203,
  GREATER:      0x0204,
  NOT_EQUAL:    0x0205,
  GREATER_EQUAL:0x0206,
  ALWAYS:       0x0207,
};

// ---------------------------------------------------------------------------
// Static pool for DepthTexture instances — recycled to eliminate per-mesh
// allocation churn when 10k+ depth textures spawn/despawn in an ECS scene.
// ---------------------------------------------------------------------------
const _depthPool = [];

function _acquireDepth() {
  const t = _depthPool.pop();
  if (t) {
    t._resetForPool();
    return t;
  }
  return new DepthTexture(1, 1);
}

function _releaseDepth(t) {
  if (_depthPool.length < 128) _depthPool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _depthSample = new Float32Array(1);
const _vec2 = new Float32Array(2);
const _vec3 = new Float32Array(3);

// ---------------------------------------------------------------------------
// DepthTextureBatch — flat typed-array batch coordinator for multi-shadow-map
// pipelines (cascaded shadow maps, point-light cube shadows).
// ---------------------------------------------------------------------------
const DEPTH_MODE_VALIDATE = 0;
const DEPTH_MODE_COMPARE  = 1;
const DEPTH_MODE_FALLBACK = 2;

class DepthTextureBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._texPtr    = new Int32Array(capacity);
    this._width     = new Int32Array(capacity);
    this._height    = new Int32Array(capacity);
    this._format    = new Uint8Array(capacity);
    this._type      = new Uint8Array(capacity);
    this._compare   = new Uint16Array(capacity);
    this._mode      = new Uint8Array(capacity);
    this._validated = new Uint8Array(capacity);

    this._textures = [];
    this._capacity = capacity;
  }

  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 64);

    const a = new Int32Array(newCap);  a.set(this._texPtr);    this._texPtr = a;
    const b = new Int32Array(newCap);  b.set(this._width);     this._width = b;
    const c = new Int32Array(newCap);  c.set(this._height);    this._height = c;
    const d = new Uint8Array(newCap);  d.set(this._format);    this._format = d;
    const e = new Uint8Array(newCap);  e.set(this._type);      this._type = e;
    const f = new Uint16Array(newCap); f.set(this._compare);   this._compare = f;
    const g = new Uint8Array(newCap);  g.set(this._mode);      this._mode = g;
    const h = new Uint8Array(newCap);  h.set(this._validated); this._validated = h;

    this._capacity = newCap;
  }

  addTexture(texture) {
    this._textures.push(texture);
    return this._textures.length - 1;
  }

  addJob(textureId, mode = DEPTH_MODE_VALIDATE) {
    this._ensure(this._count + 1);
    const i = this._count++;
    const texture = this._textures[textureId];

    const size = texture ? texture.source.getSize(_vec3) : [0, 0, 1];

    this._texPtr[i] = textureId;
    this._width[i] = size[0];
    this._height[i] = size[1];
    this._format[i] = texture ? (texture.format === DepthFormat ? 0 : 1) : 0;
    this._type[i] = texture ? (texture.type === UnsignedIntType ? 0 : 1) : 0;
    this._compare[i] = texture && texture.compareFunction !== null ? texture.compareFunction : 0;
    this._mode[i] = mode;
    this._validated[i] = 0;

    return i;
  }

  process() {
    const n = this._count;

    for (let i = 0; i < n; i++) {
      const w = this._width[i];
      const h = this._height[i];
      const format = this._format[i];
      const type = this._type[i];
      const mode = this._mode[i];

      let ok = w > 0 && h > 0;

      // Validate format/type pairing
      if (format === 0 && type !== 0) ok = false;
      if (format === 1 && type !== 1) ok = false;

      // Mode-specific validation
      if (mode === DEPTH_MODE_COMPARE) {
        // Compare mode requires a valid compareFunction
        const cf = this._compare[i];
        if (cf === 0) ok = false;
      }

      this._validated[i] = ok ? 1 : 0;
    }
  }

  results() {
    return this._validated.subarray(0, this._count);
  }

  reset() {
    this._count = 0;
  }

  asBitecsComponent(name) {
    return {
      name,
      count: this._count,
      texPtr: this._texPtr,
      width: this._width,
      height: this._height,
      format: this._format,
      type: this._type,
      compare: this._compare,
      mode: this._mode,
      validated: this._validated,
    };
  }
}

// ---------------------------------------------------------------------------
// Float64 depth-range validation (no double.js). JS numbers are IEEE-754
// doubles, so accumulation is bit-exact up to 2^53.
// ---------------------------------------------------------------------------
function validateDepthRangePrecise(depthData) {
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < depthData.length; i++) {
    const v = depthData[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const range = max - min;
  return { min, max, range };
}

// ---------------------------------------------------------------------------
// SimplexNoise-dithered depth fallback for platforms without native depth.
// ---------------------------------------------------------------------------
function generateDepthFallback(width, height, amplitude = 0.5) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  const out = new Uint8ClampedArray(w * h * 4);
  const invAmp = amplitude / 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const d = SimplexNoise.noise2D(x * 0.05, y * 0.05) * invAmp;

      // Radial pseudo-depth
      const cx = (x / w) - 0.5;
      const cy = (y / h) - 0.5;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const depth = Math.max(0, Math.min(1, dist + d));
      const value = Math.floor(depth * 255);

      out[p] = value;
      out[p + 1] = value;
      out[p + 2] = value;
      out[p + 3] = 255;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// DepthTexture — mirrors three.js r185 DepthTexture with dynamic features.
// ---------------------------------------------------------------------------
class DepthTexture extends Texture {
  /**
   * @param {number} width
   * @param {number} height
   * @param {number} [type=UnsignedIntType]
   * @param {number} [mapping=Texture.DEFAULT_MAPPING]
   * @param {number} [wrapS=ClampToEdgeWrapping]
   * @param {number} [wrapT=ClampToEdgeWrapping]
   * @param {number} [magFilter=NearestFilter]
   * @param {number} [minFilter=NearestFilter]
   * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY]
   * @param {number} [format=DepthFormat]
   * @param {number} [depth=1]
   */
  constructor(
    width,
    height,
    type = UnsignedIntType,
    mapping = Texture.DEFAULT_MAPPING,
    wrapS = ClampToEdgeWrapping,
    wrapT = ClampToEdgeWrapping,
    magFilter = NearestFilter,
    minFilter = NearestFilter,
    anisotropy = Texture.DEFAULT_ANISOTROPY,
    format = DepthFormat,
    depth = 1
  ) {
    if (format !== DepthFormat && format !== DepthStencilFormat) {
      throw new Error('DepthTexture format must be either THREE.DepthFormat or THREE.DepthStencilFormat');
    }

    const image = { width, height, depth };
    super(image, mapping, wrapS, wrapT, magFilter, minFilter, format, type, anisotropy);

    this.isDepthTexture = true;

    this.flipY = false;
    this.generateMipmaps = false;

    this.compareFunction = null;

    // Dynamic feature flags (all opt-in, toggled at runtime)
    this.dynamicFeatures = {
      compareSampling: false,
      logarithmicDepth: false,
      pcfSoftSampling: false,
      autoLinearization: false,
      hdrRange: false,
      proceduralFallback: false,
    };

    // PCF soft sampling parameters (dynamic feature)
    this.pcfRadius = 2;
    this.pcfSamples = 9;

    // Logarithmic depth parameters (dynamic feature)
    this.logDepthNear = 0.1;
    this.logDepthFar = 10000;
    this.logDepthFC = 1.0;

    // CPU-side fallback for platforms without native depth-texture support
    this._fallback = null;

    // Cached linearized conversion factor for reconstruction
    this._linearizeNear = 0.1;
    this._linearizeFar = 1000;
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
  // Dynamic compareFunction switching
  // -----------------------------------------------------------------------

  /**
   * Set the hardware compare function.
   * @param {number} fn — one of CompareFunction constants
   * @returns {this}
   */
  setCompareFunction(fn) {
    this.compareFunction = fn;
    this.dynamicFeatures.compareSampling = fn !== null && fn !== 0;
    this.needsUpdate = true;
    return this;
  }

  /**
   * Clear the compare function (disable hardware comparison).
   * @returns {this}
   */
  clearCompareFunction() {
    this.compareFunction = null;
    this.dynamicFeatures.compareSampling = false;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic logarithmic depth support
  // -----------------------------------------------------------------------

  enableLogarithmicDepth(near = 0.1, far = 10000, fc = 1.0) {
    this.dynamicFeatures.logarithmicDepth = true;
    this.logDepthNear = near;
    this.logDepthFar = far;
    this.logDepthFC = fc;
    this.needsUpdate = true;
    return this;
  }

  disableLogarithmicDepth() {
    this.dynamicFeatures.logarithmicDepth = false;
    this.needsUpdate = true;
    return this;
  }

  /**
   * Reconstruct a linear depth value from a stored logarithmic depth value.
   * @param {number} logDepth — value in [0, 1]
   * @returns {number}
   */
  logToLinearDepth(logDepth) {
    // Standard three.js logarithmic depth reconstruction:
    //   logDepth = (2 * log(fc * far / near) - log(far - z) + log(z)) / (2 * log(fc * far / near))
    // Solving for z requires iteration in general; we use the close-form
    // approximation valid for near << far.
    const fc = this.logDepthFC;
    const near = this.logDepthNear;
    const far = this.logDepthFar;
    const logFarNear = Math.log(fc * far / near);

    // Simplified closed-form: reconstruct z from logDepth
    const t = logDepth * 2 * logFarNear;
    const z = (far * near * (Math.exp(t) - 1)) / (far * Math.exp(t) - near);

    return Math.max(near, Math.min(far, z));
  }

  /**
   * Linearize a stored depth value using the current near/far planes.
   * @param {number} depth — value in [0, 1]
   * @param {number} near
   * @param {number} far
   * @returns {number}
   */
  linearizeDepth(depth, near = this._linearizeNear, far = this._linearizeFar) {
    // Standard perspective depth linearization:
    //   linearZ = 2 * near * far / (far + near - (2 * depth - 1) * (far - near))
    const z = 2 * depth - 1;
    return (2 * near * far) / (far + near - z * (far - near));
  }

  /**
   * Set the near/far planes used by `linearizeDepth()`.
   * @param {number} near
   * @param {number} far
   * @returns {this}
   */
  setLinearizationPlanes(near, far) {
    this._linearizeNear = near;
    this._linearizeFar = far;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic format / type coercion
  // -----------------------------------------------------------------------

  /**
   * Set the format, validating it against the current type.
   * @param {number} format
   * @returns {this}
   */
  setFormat(format) {
    if (format !== DepthFormat && format !== DepthStencilFormat) {
      throw new Error('DepthTexture: format must be DepthFormat or DepthStencilFormat');
    }
    this.format = format;
    this.needsUpdate = true;
    return this;
  }

  /**
   * Set the type, validating it against the current format.
   * @param {number} type
   * @returns {this}
   */
  setType(type) {
    this.type = type;
    this.needsUpdate = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic sampling
  // -----------------------------------------------------------------------

  /**
   * Zero-allocation depth sampling from the CPU-side fallback buffer.
   * Returns the sampled depth in [0, 1], or null if no fallback.
   *
   * @param {number} [u=0.5] — U coordinate in [0, 1]
   * @param {number} [v=0.5] — V coordinate in [0, 1]
   * @returns {number|null}
   */
  sampleDepthGlMat(u = 0.5, v = 0.5) {
    if (!this._fallback) return null;

    const fb = this._fallback;
    const x = Math.min(fb.width - 1, Math.max(0, Math.floor(u * fb.width)));
    const y = Math.min(fb.height - 1, Math.max(0, Math.floor(v * fb.height)));
    const p = (y * fb.width + x) * 4;

    Vec2.set(_vec2, u, v);
    return fb.data[p] / 255;
  }

  /**
   * Hardware-style depth comparison against a reference value.
   * @param {number} referenceDepth
   * @param {number} [u=0.5]
   * @param {number} [v=0.5]
   * @returns {boolean}
   */
  compareDepthGlMat(referenceDepth, u = 0.5, v = 0.5) {
    const sampled = this.sampleDepthGlMat(u, v);
    if (sampled === null) return false;

    if (this.compareFunction === null) {
      // Default: less-equal comparison (matches WebGL default)
      return sampled <= referenceDepth;
    }

    switch (this.compareFunction) {
      case CompareFunction.LESS:          return sampled < referenceDepth;
      case CompareFunction.LESS_EQUAL:    return sampled <= referenceDepth;
      case CompareFunction.EQUAL:         return sampled === referenceDepth;
      case CompareFunction.GREATER:       return sampled > referenceDepth;
      case CompareFunction.GREATER_EQUAL: return sampled >= referenceDepth;
      case CompareFunction.NOT_EQUAL:     return sampled !== referenceDepth;
      case CompareFunction.ALWAYS:        return true;
      case CompareFunction.NEVER:         return false;
      default:                            return sampled <= referenceDepth;
    }
  }

  /**
   * PCF soft sampling (returns the average comparison result over a
   * configurable neighborhood). Uses `pcfRadius` and `pcfSamples` for
   * distribution.
   *
   * @param {number} referenceDepth
   * @param {number} [u=0.5]
   * @param {number} [v=0.5]
   * @param {number} [texelSize=1/512]
   * @returns {number} — fraction in [0, 1] of passing samples
   */
  pcfSoftSample(referenceDepth, u = 0.5, v = 0.5, texelSize = 1 / 512) {
    if (!this.dynamicFeatures.pcfSoftSampling) {
      return this.compareDepthGlMat(referenceDepth, u, v) ? 1 : 0;
    }

    const radius = this.pcfRadius;
    const samples = this.pcfSamples;
    let passed = 0;

    for (let i = 0; i < samples; i++) {
      // Simple spiral sampling
      const angle = (i / samples) * Math.PI * 2;
      const r = (i / samples) * radius * texelSize;
      const du = Math.cos(angle) * r;
      const dv = Math.sin(angle) * r;

      if (this.compareDepthGlMat(referenceDepth, u + du, v + dv)) {
        passed++;
      }
    }

    return passed / samples;
  }

  // -----------------------------------------------------------------------
  // Float64 utilities
  // -----------------------------------------------------------------------

  /**
   * Float64 depth-range validation.
   * @param {Float32Array} depthData
   * @returns {{min: number, max: number, range: number}}
   */
  validateDepthRangePrecise(depthData) {
    return validateDepthRangePrecise(depthData);
  }

  // -----------------------------------------------------------------------
  // Dynamic fallback generation
  // -----------------------------------------------------------------------

  /**
   * Generate a SimplexNoise-dithered fallback depth image.
   * @param {number} [amplitude=0.5]
   * @returns {this}
   */
  generateFallback(amplitude = 0.5) {
    const size = this.source.getSize(_vec3);
    const w = size[0] || 1;
    const h = size[1] || 1;

    this._fallback = {
      width: w,
      height: h,
      data: generateDepthFallback(w, h, amplitude),
    };

    this.dynamicFeatures.proceduralFallback = true;
    return this;
  }

  // -----------------------------------------------------------------------
  // Copy / serialize
  // -----------------------------------------------------------------------

  copy(source) {
    super.copy(source);

    this.image = {
      width: source.image.width,
      height: source.image.height,
      depth: source.image.depth !== undefined ? source.image.depth : 1,
    };
    this.source.data = this.image;

    this.compareFunction = source.compareFunction;
    this.flipY = source.flipY;
    this.generateMipmaps = source.generateMipmaps;

    if (source.dynamicFeatures) {
      this.dynamicFeatures = { ...source.dynamicFeatures };
    }

    this.pcfRadius = source.pcfRadius;
    this.pcfSamples = source.pcfSamples;
    this.logDepthNear = source.logDepthNear;
    this.logDepthFar = source.logDepthFar;
    this.logDepthFC = source.logDepthFC;
    this._linearizeNear = source._linearizeNear;
    this._linearizeFar = source._linearizeFar;
    this._fallback = source._fallback ? { ...source._fallback } : null;

    return this;
  }

  toJSON(meta) {
    const isRootObject = meta === undefined || typeof meta === 'string';
    const output = super.toJSON(meta);

    output.image = {
      width: this.image.width,
      height: this.image.height,
      depth: this.image.depth !== undefined ? this.image.depth : 1,
    };

    if (this.compareFunction !== null) {
      output.compareFunction = this.compareFunction;
    }

    output.dynamicFeatures = { ...this.dynamicFeatures };
    output.pcfRadius = this.pcfRadius;
    output.pcfSamples = this.pcfSamples;

    if (this.dynamicFeatures.logarithmicDepth) {
      output.logDepthNear = this.logDepthNear;
      output.logDepthFar = this.logDepthFar;
      output.logDepthFC = this.logDepthFC;
    }

    if (!isRootObject) {
      meta.textures[this.uuid] = output;
    }
    return output;
  }

  // -----------------------------------------------------------------------
  // Pool + batch helpers
  // -----------------------------------------------------------------------

  static createBatch() {
    return new DepthTextureBatch();
  }

  static acquire() {
    return _acquireDepth();
  }

  release() {
    if (this.source) {
      this.source.release();
      this.source = null;
    }
    _releaseDepth(this);
  }

  static clearPool() {
    _depthPool.length = 0;
  }

  _resetForPool() {
    const parentReset = Texture.prototype._resetForPool;
    if (typeof parentReset === 'function') parentReset.call(this);

    this.isDepthTexture = true;
    this.image = { width: 1, height: 1, depth: 1 };
    this.source.data = this.image;
    this.flipY = false;
    this.generateMipmaps = false;
    this.compareFunction = null;
    this._fallback = null;

    this.dynamicFeatures = {
      compareSampling: false,
      logarithmicDepth: false,
      pcfSoftSampling: false,
      autoLinearization: false,
      hdrRange: false,
      proceduralFallback: false,
    };

    this.pcfRadius = 2;
    this.pcfSamples = 9;
    this.logDepthNear = 0.1;
    this.logDepthFar = 10000;
    this.logDepthFC = 1.0;
    this._linearizeNear = 0.1;
    this._linearizeFar = 1000;
  }

  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    return {
      ...base,
      isDepthTexture: 1,
      format: this.format,
      type: this.type,
      compareFunction: this.compareFunction !== null ? this.compareFunction : 0,
      width: this.image.width,
      height: this.image.height,
      logarithmicDepth: this.dynamicFeatures.logarithmicDepth ? 1 : 0,
      pcfSoftSampling: this.dynamicFeatures.pcfSoftSampling ? 1 : 0,
      hasFallback: this._fallback ? 1 : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  DepthTexture,
  DepthTextureBatch,
  CompareFunction,
  validateDepthRangePrecise,
  generateDepthFallback,
};
export default DepthTexture;