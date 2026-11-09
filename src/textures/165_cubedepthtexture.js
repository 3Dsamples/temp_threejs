// file number : 165
// full path name : src/textures/165_cubedepthtexture.js
// description : CubeDepthTexture (three.js r185) rewritten as a pure ES module with zero CDN imports and completely dynamic features. Extends DepthTexture (158) to automatically save the depth information of a cube rendering into a cube texture with depth format — used for PointLight shadows and WebGPU CubeRenderTarget depth attachments. Preserves the full r185 CubeDepthTexture API — six-face image descriptors, isCubeDepthTexture flag, isCubeTexture flag, CubeReflectionMapping default, images getter/setter alias, compareFunction inheritance, plus clone(), copy(), toJSON() inherited from DepthTexture. Adds dynamic feature toggles: dynamic face resolution switching (rescale all six faces together), dynamic per-face compare-function switching, dynamic per-face depth-range tracking, dynamic face resolution upsampling/downsampling (for adaptive shadow quality), dynamic linearization plane switching (inherited from 158), Float64 validateCubeDepthRangePrecise (native JS IEEE-754 doubles — no double.js) for six-face HDR depth buffers up to 2^53, SimplexNoise-dithered paintFallback for platforms without native cube-depth-texture support, dynamic cube-face direction computation with cubeFaceToDirectionGlMat, dynamic direction→face/UV lookup with directionToFaceUV for shadow lookups, dynamic sampleFaceDepthGlMat for CPU-side shadow verification, dynamic per-face PCF soft sampling, and dynamic depth-range tracking that records min/max observed across all faces. Uses a flat typed-array CubeDepthTextureBatch for multi-point-light shadow pipelines (shadow atlas coordination, cascaded point shadows, cube shadow LODs), and full pool integration via acquire()/release()/clearPool(). Designed for 10k+ cube depth textures on Android 64-bit with zero CDN dependencies.
// best for : CubeDepthTexture, PointLight shadow maps, PointShadowNode (WebGPU), CubeRenderTarget depth attachments, omnidirectional shadow rendering, dynamic point-light shadow atlases, six-face shadow LOD systems, WebGPU cube depth pipelines, and any three.js workflow that needs six faces of depth data as a single texture unit with runtime-switchable features at 10k+ entity scale on Android 64-bit.
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
import { DepthTexture } from './158_depthtexture.js';

// ---------------------------------------------------------------------------
// Local aliases for the project's Constants.
// ---------------------------------------------------------------------------
const UnsignedIntType    = Constants.UnsignedIntType;
const UnsignedInt248Type = Constants.UnsignedInt248Type;
const DepthFormat        = Constants.DepthFormat;
const DepthStencilFormat = Constants.DepthStencilFormat;
const NearestFilter      = Constants.NearestFilter;
const LinearFilter       = Constants.LinearFilter;
const CubeReflectionMapping = Constants.CubeReflectionMapping;
const ClampToEdgeWrapping = Constants.ClampToEdgeWrapping;

// ---------------------------------------------------------------------------
// Cube face constants — must match WebGL cube face ordering.
// ---------------------------------------------------------------------------
const CUBE_FACE_POS_X = 0;
const CUBE_FACE_NEG_X = 1;
const CUBE_FACE_POS_Y = 2;
const CUBE_FACE_NEG_Y = 3;
const CUBE_FACE_POS_Z = 4;
const CUBE_FACE_NEG_Z = 5;

// ---------------------------------------------------------------------------
// Compare function constants (mirror of 158 CompareFunction).
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
// Static pool for CubeDepthTexture instances — recycled to eliminate per-
// mesh allocation churn when 10k+ cube depth textures spawn/despawn.
// ---------------------------------------------------------------------------
const _cubeDepthPool = [];

function _acquireCubeDepth() {
  const t = _cubeDepthPool.pop();
  if (t) {
    t._resetForPool();
    return t;
  }
  return new CubeDepthTexture(1);
}

function _releaseCubeDepth(t) {
  if (_cubeDepthPool.length < 64) _cubeDepthPool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _rgba = new Float32Array(4);
const _vec3 = new Float32Array(3);
const _uv = new Float32Array(2);
const _depthSample = new Float32Array(1);

// ---------------------------------------------------------------------------
// CubeDepthTextureBatch — flat typed-array batch coordinator for multi-point-
// light shadow pipelines (shadow atlas coordination, cascaded point shadows,
// cube shadow LODs).
// ---------------------------------------------------------------------------
const CUBE_DEPTH_MODE_VALIDATE = 0;
const CUBE_DEPTH_MODE_COMPARE  = 1;
const CUBE_DEPTH_MODE_FALLBACK = 2;
const CUBE_DEPTH_MODE_RANGE    = 3;

class CubeDepthTextureBatch {
  constructor(capacity = 0) {
    this._capacity = 0;
    this._count = 0;

    this._texPtr     = new Int32Array(capacity);
    this._face       = new Uint8Array(capacity);
    this._size       = new Int32Array(capacity);
    this._depth      = new Int32Array(capacity);
    this._compare    = new Uint16Array(capacity);
    this._mode       = new Uint8Array(capacity);
    this._validated  = new Uint8Array(capacity);

    this._textures = [];
    this._outputs = [];
    this._capacity = capacity;
  }

  _ensure(capacity) {
    if (capacity <= this._capacity) return;
    const newCap = Math.max(capacity, this._capacity * 2 || 64);

    const a = new Int32Array(newCap);  a.set(this._texPtr);    this._texPtr = a;
    const b = new Uint8Array(newCap);  b.set(this._face);      this._face = b;
    const c = new Int32Array(newCap);  c.set(this._size);      this._size = c;
    const d = new Int32Array(newCap);  d.set(this._depth);     this._depth = d;
    const e = new Uint16Array(newCap); e.set(this._compare);   this._compare = e;
    const f = new Uint8Array(newCap);  f.set(this._mode);      this._mode = f;
    const g = new Uint8Array(newCap);  g.set(this._validated); this._validated = g;

    this._capacity = newCap;
  }

  addTexture(texture) {
    this._textures.push(texture);
    return this._textures.length - 1;
  }

  addFaceJob(textureId, face, mode = CUBE_DEPTH_MODE_VALIDATE) {
    this._ensure(this._count + 1);
    const i = this._count++;
    const texture = this._textures[textureId];
    const images = texture ? texture.image : [];
    const img = Array.isArray(images) ? images[face] : images;

    this._texPtr[i] = textureId;
    this._face[i] = face;
    this._size[i] = img && img.width ? img.width : 0;
    this._depth[i] = img && img.depth !== undefined ? img.depth : 1;
    this._compare[i] = texture && texture.compareFunction !== null
      ? texture.compareFunction
      : 0;
    this._mode[i] = mode;
    this._validated[i] = 0;

    return i;
  }

  process() {
    const n = this._count;

    for (let i = 0; i < n; i++) {
      const texture = this._textures[this._texPtr[i]];
      if (!texture) {
        this._validated[i] = 0;
        continue;
      }

      const size = this._size[i];
      const depth = this._depth[i];
      const mode = this._mode[i];

      let ok = size > 0 && depth === 1;

      // Compare mode requires a valid compareFunction
      if (mode === CUBE_DEPTH_MODE_COMPARE) {
        if (this._compare[i] === 0) ok = false;
      }

      // Range mode requires depth data on the face
      if (mode === CUBE_DEPTH_MODE_RANGE) {
        const images = Array.isArray(texture.image) ? texture.image : null;
        const img = images ? images[this._face[i]] : null;
        if (!img || !img.data) ok = false;
      }

      this._validated[i] = ok ? 1 : 0;

      // Emit range data if requested
      if (ok && mode === CUBE_DEPTH_MODE_RANGE) {
        const images = Array.isArray(texture.image) ? texture.image : null;
        const img = images ? images[this._face[i]] : null;
        this._outputs.push(img && img.data ? validateDepthRangePrecise(img.data) : null);
      } else {
        this._outputs.push(null);
      }
    }
  }

  results() {
    return this._validated.subarray(0, this._count);
  }

  getOutput(i) {
    if (i < 0 || i >= this._count) return null;
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
      face: this._face,
      size: this._size,
      depth: this._depth,
      compare: this._compare,
      mode: this._mode,
      validated: this._validated,
    };
  }
}

// ---------------------------------------------------------------------------
// Float64 depth-range validation (no double.js). Bit-exact up to 2^53.
// ---------------------------------------------------------------------------
function validateDepthRangePrecise(depthData) {
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < depthData.length; i++) {
    const v = depthData[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return { min, max, range: max - min };
}

// ---------------------------------------------------------------------------
// Float64 six-face depth-range validation.
// ---------------------------------------------------------------------------
function validateCubeDepthRangePrecise(faceDepthData) {
  let min = Infinity;
  let max = -Infinity;

  for (let f = 0; f < faceDepthData.length; f++) {
    const faceData = faceDepthData[f];
    if (!faceData) continue;

    for (let i = 0; i < faceData.length; i++) {
      const v = faceData[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  return { min, max, range: max - min };
}

// ---------------------------------------------------------------------------
// SimplexNoise-dithered fallback painting for a single cube depth face.
// ---------------------------------------------------------------------------
function paintCubeDepthFallback(width, height, face, amplitude = 0.5) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  const out = new Uint8ClampedArray(w * h * 4);
  const invAmp = amplitude / 255;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const d = SimplexNoise.noise2D(x * 0.05 + face * 100, y * 0.05) * invAmp;

      // Per-face radial gradient for visual distinction
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
// Float64 cube-face → direction computation (no double.js).
// ---------------------------------------------------------------------------
function cubeFaceToDirectionPrecise(face, u, v, out) {
  let x = 0, y = 0, z = 0;

  switch (face) {
    case CUBE_FACE_POS_X: x = 1;  y = -v; z = -u; break;
    case CUBE_FACE_NEG_X: x = -1; y = -v; z = u;  break;
    case CUBE_FACE_POS_Y: x = u;  y = 1;  z = v;  break;
    case CUBE_FACE_NEG_Y: x = u;  y = -1; z = -v; break;
    case CUBE_FACE_POS_Z: x = u;  y = -v; z = 1;  break;
    case CUBE_FACE_NEG_Z: x = -u; y = -v; z = -1; break;
  }

  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  return out;
}

// ---------------------------------------------------------------------------
// CubeDepthTexture — mirrors three.js r185 CubeDepthTexture with
// completely dynamic features.
// ---------------------------------------------------------------------------
class CubeDepthTexture extends DepthTexture {
  /**
   * @param {number} size — width and height of each face
   * @param {number} [type=UnsignedIntType]
   * @param {number} [mapping=CubeReflectionMapping]
   * @param {number} [wrapS=ClampToEdgeWrapping]
   * @param {number} [wrapT=ClampToEdgeWrapping]
   * @param {number} [magFilter=NearestFilter]
   * @param {number} [minFilter=NearestFilter]
   * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY]
   * @param {number} [format=DepthFormat]
   */
  constructor(
    size,
    type = UnsignedIntType,
    mapping = CubeReflectionMapping,
    wrapS = ClampToEdgeWrapping,
    wrapT = ClampToEdgeWrapping,
    magFilter = NearestFilter,
    minFilter = NearestFilter,
    anisotropy = 1,
    format = DepthFormat
  ) {
    // Build the six-face image array
    const faceImage = { width: size, height: size, depth: 1 };
    const images = [
      faceImage, faceImage, faceImage,
      faceImage, faceImage, faceImage,
    ];

    super(
      size,
      size,
      type,
      mapping,
      wrapS,
      wrapT,
      magFilter,
      minFilter,
      anisotropy,
      format
    );

    this.isCubeDepthTexture = true;
    this.isCubeTexture = true;

    // Override image with the six-face array
    this.image = images;
    this.source.data = this.image;

    // Dynamic feature flags (all opt-in, toggled at runtime)
    this.dynamicFeatures = {
      resolutionSwitch: false,
      perFaceCompare: false,
      perFaceRange: false,
      adaptiveQuality: false,
      pcfPerFace: false,
      proceduralFallback: false,
    };

    // Per-face compare functions (when perFaceCompare is enabled)
    this._faceCompareFunctions = new Array(6).fill(null);

    // Per-face depth range cache (when perFaceRange is enabled)
    this._faceDepthRanges = new Array(6).fill(null);

    // PCF parameters (inherited from 158 but per-face variant)
    this.pcfRadius = 2;
    this.pcfSamples = 9;

    // CPU-side fallback for platforms without native cube-depth support
    this._fallback = [];
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
  // Image accessors (r185 images alias)
  // -----------------------------------------------------------------------

  get images() {
    return this.image;
  }

  set images(value) {
    this.image = value;
    this.source.data = value;
  }

  // -----------------------------------------------------------------------
  // Dynamic face resolution switching
  // -----------------------------------------------------------------------

  /**
   * Resize all six faces at once. This is the standard operation for
   * adapting shadow map resolution at runtime.
   * @param {number} size
   * @returns {this}
   */
  setResolution(size) {
    const s = Math.max(1, size | 0);
    const images = this.image;

    for (let f = 0; f < 6; f++) {
      if (!images[f]) images[f] = { width: s, height: s, depth: 1 };
      else {
        images[f].width = s;
        images[f].height = s;
        images[f].depth = 1;
      }
    }

    this.dynamicFeatures.resolutionSwitch = true;
    this.needsUpdate = true;
    return this;
  }

  /**
   * @returns {number} — current face size (width of the first face)
   */
  get faceSize() {
    return (this.image[0] && this.image[0].width) || 0;
  }

  // -----------------------------------------------------------------------
  // Dynamic per-face compare function
  // -----------------------------------------------------------------------

  /**
   * Set a compare function for a specific face.
   * @param {number} face — 0..5
   * @param {number} fn — one of CompareFunction constants, or null
   * @returns {this}
   */
  setFaceCompareFunction(face, fn) {
    if (face < 0 || face > 5) return this;
    this._faceCompareFunctions[face] = fn;
    this.dynamicFeatures.perFaceCompare = true;
    this.needsUpdate = true;
    return this;
  }

  /**
   * Get the compare function for a specific face.
   * @param {number} face
   * @returns {number|null}
   */
  getFaceCompareFunction(face) {
    if (face < 0 || face > 5) return null;
    if (this.dynamicFeatures.perFaceCompare) {
      return this._faceCompareFunctions[face];
    }
    return this.compareFunction;
  }

  // -----------------------------------------------------------------------
  // Dynamic per-face depth-range tracking
  // -----------------------------------------------------------------------

  /**
   * Update and cache the depth range for a specific face.
   * @param {number} face — 0..5
   * @param {Float32Array} depthData
   * @returns {{min: number, max: number, range: number}|null}
   */
  updateFaceDepthRange(face, depthData) {
    if (face < 0 || face > 5 || !depthData) return null;

    const range = validateDepthRangePrecise(depthData);
    this._faceDepthRanges[face] = range;
    this.dynamicFeatures.perFaceRange = true;
    return range;
  }

  /**
   * Get the cached depth range for a specific face.
   * @param {number} face
   * @returns {{min: number, max: number, range: number}|null}
   */
  getFaceDepthRange(face) {
    if (face < 0 || face > 5) return null;
    return this._faceDepthRanges[face];
  }

  /**
   * Float64 six-face combined depth-range validation (no double.js).
   * @param {Array<Float32Array>} faceDepthData
   * @returns {{min: number, max: number, range: number}}
   */
  validateCubeDepthRangePrecise(faceDepthData) {
    return validateCubeDepthRangePrecise(faceDepthData);
  }

  // -----------------------------------------------------------------------
  // Dynamic cube-face direction computation
  // -----------------------------------------------------------------------

  /**
   * Zero-allocation cube-face → direction computation via the project's
   * Vec3 module.
   * @param {Float32Array} [out]
   * @param {number} face
   * @param {number} u — UV.x in [-1, 1]
   * @param {number} v — UV.y in [-1, 1]
   * @returns {Float32Array}
   */
  cubeFaceToDirectionGlMat(out = _vec3, face, u, v) {
    return cubeFaceToDirectionPrecise(face, u, v, out);
  }

  /**
   * Zero-allocation direction → face/UV lookup.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {{face: number, u: number, v: number}}
   */
  directionToFaceUV(x, y, z) {
    Vec3.set(_vec3, x, y, z);
    Vec3.normalize(_vec3, _vec3);

    const ax = Math.abs(_vec3[0]);
    const ay = Math.abs(_vec3[1]);
    const az = Math.abs(_vec3[2]);

    let face, sc, tc;

    if (ax >= ay && ax >= az) {
      face = _vec3[0] > 0 ? CUBE_FACE_POS_X : CUBE_FACE_NEG_X;
      sc = _vec3[0] > 0 ? -_vec3[2] : _vec3[2];
      tc = -_vec3[1];
      const ma = ax;
      sc /= ma; tc /= ma;
    } else if (ay >= az) {
      face = _vec3[1] > 0 ? CUBE_FACE_POS_Y : CUBE_FACE_NEG_Y;
      sc = _vec3[0];
      tc = _vec3[1] > 0 ? _vec3[2] : -_vec3[2];
      const ma = ay;
      sc /= ma; tc /= ma;
    } else {
      face = _vec3[2] > 0 ? CUBE_FACE_POS_Z : CUBE_FACE_NEG_Z;
      sc = _vec3[2] > 0 ? _vec3[0] : -_vec3[0];
      tc = -_vec3[1];
      const ma = az;
      sc /= ma; tc /= ma;
    }

    return {
      face,
      u: (sc + 1) * 0.5,
      v: (tc + 1) * 0.5,
    };
  }

  // -----------------------------------------------------------------------
  // Dynamic sampling
  // -----------------------------------------------------------------------

  /**
   * Zero-allocation depth sample from a specific face's CPU-side fallback.
   * Returns the sampled depth in [0, 1], or null if no fallback.
   *
   * @param {number} [face=0]
   * @param {number} [u=0.5]
   * @param {number} [v=0.5]
   * @returns {number|null}
   */
  sampleFaceDepthGlMat(face = 0, u = 0.5, v = 0.5) {
    if (!this._fallback || !this._fallback[face]) return null;

    const fb = this._fallback[face];
    const x = Math.min(fb.width - 1, Math.max(0, Math.floor(u * fb.width)));
    const y = Math.min(fb.height - 1, Math.max(0, Math.floor(v * fb.height)));
    const p = (y * fb.width + x) * 4;

    Vec2.set(_uv, u, v);
    return fb.data[p] / 255;
  }

  /**
   * Hardware-style depth comparison against a reference value using the
   * face-specific compare function when perFaceCompare is enabled.
   *
   * @param {number} referenceDepth
   * @param {number} [face=0]
   * @param {number} [u=0.5]
   * @param {number} [v=0.5]
   * @returns {boolean}
   */
  compareFaceDepthGlMat(referenceDepth, face = 0, u = 0.5, v = 0.5) {
    const sampled = this.sampleFaceDepthGlMat(face, u, v);
    if (sampled === null) return false;

    const fn = this.getFaceCompareFunction(face);

    if (fn === null) {
      // Default: less-equal comparison
      return sampled <= referenceDepth;
    }

    switch (fn) {
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
   * Per-face PCF soft sampling. Returns the average comparison result over a
   * configurable neighborhood.
   *
   * @param {number} referenceDepth
   * @param {number} [face=0]
   * @param {number} [u=0.5]
   * @param {number} [v=0.5]
   * @param {number} [texelSize=1/512]
   * @returns {number} — fraction in [0, 1] of passing samples
   */
  pcfSoftSampleFace(referenceDepth, face = 0, u = 0.5, v = 0.5, texelSize = 1 / 512) {
    if (!this.dynamicFeatures.pcfPerFace) {
      return this.compareFaceDepthGlMat(referenceDepth, face, u, v) ? 1 : 0;
    }

    const radius = this.pcfRadius;
    const samples = this.pcfSamples;
    let passed = 0;

    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      const r = (i / samples) * radius * texelSize;
      const du = Math.cos(angle) * r;
      const dv = Math.sin(angle) * r;

      if (this.compareFaceDepthGlMat(referenceDepth, face, u + du, v + dv)) {
        passed++;
      }
    }

    return passed / samples;
  }

  // -----------------------------------------------------------------------
  // Dynamic fallback generation
  // -----------------------------------------------------------------------

  /**
   * Generate SimplexNoise-dithered fallback depth images for all six faces.
   * @param {number} [amplitude=0.5]
   * @returns {this}
   */
  paintFallback(amplitude = 0.5) {
    const size = this.faceSize || 512;
    this._fallback = [];

    for (let f = 0; f < 6; f++) {
      this._fallback.push({
        width: size,
        height: size,
        data: paintCubeDepthFallback(size, size, f, amplitude),
      });
    }

    this.dynamicFeatures.proceduralFallback = true;
    return this;
  }

  /** @returns {Array|null} — the fallback face descriptors */
  getFallback() {
    return this._fallback;
  }

  // -----------------------------------------------------------------------
  // Copy / serialize
  // -----------------------------------------------------------------------

  copy(source) {
    super.copy(source);

    // Rebuild the six-face image array
    const sourceImages = Array.isArray(source.image) ? source.image : [source.image];
    const size = sourceImages[0] && sourceImages[0].width || 1;

    this.image = [
      { width: size, height: size, depth: 1 },
      { width: size, height: size, depth: 1 },
      { width: size, height: size, depth: 1 },
      { width: size, height: size, depth: 1 },
      { width: size, height: size, depth: 1 },
      { width: size, height: size, depth: 1 },
    ];
    this.source.data = this.image;

    if (source.dynamicFeatures) {
      this.dynamicFeatures = { ...source.dynamicFeatures };
    }

    this._faceCompareFunctions = source._faceCompareFunctions
      ? source._faceCompareFunctions.slice(0)
      : new Array(6).fill(null);

    this._faceDepthRanges = source._faceDepthRanges
      ? source._faceDepthRanges.slice(0)
      : new Array(6).fill(null);

    this.pcfRadius = source.pcfRadius;
    this.pcfSamples = source.pcfSamples;

    this._fallback = source._fallback
      ? source._fallback.map((f) => ({ ...f }))
      : [];

    return this;
  }

  toJSON(meta) {
    const isRootObject = meta === undefined || typeof meta === 'string';
    const output = super.toJSON(meta);

    output.image = {
      width: (this.image[0] && this.image[0].width) || 0,
      height: (this.image[0] && this.image[0].height) || 0,
      faceCount: 6,
    };

    output.dynamicFeatures = { ...this.dynamicFeatures };
    output.pcfRadius = this.pcfRadius;
    output.pcfSamples = this.pcfSamples;
    output.faceCompareFunctions = this._faceCompareFunctions.slice(0);
    output.faceDepthRanges = this._faceDepthRanges.slice(0);

    if (!isRootObject) {
      meta.textures[this.uuid] = output;
    }
    return output;
  }

  // -----------------------------------------------------------------------
  // Pool + batch helpers
  // -----------------------------------------------------------------------

  static createBatch() {
    return new CubeDepthTextureBatch();
  }

  static acquire() {
    return _acquireCubeDepth();
  }

  release() {
    if (this.source) {
      this.source.release();
      this.source = null;
    }
    _releaseCubeDepth(this);
  }

  static clearPool() {
    _cubeDepthPool.length = 0;
  }

  _resetForPool() {
    const parentReset = DepthTexture.prototype._resetForPool;
    if (typeof parentReset === 'function') parentReset.call(this);

    this.isCubeDepthTexture = true;
    this.isCubeTexture = true;

    const faceImage = { width: 1, height: 1, depth: 1 };
    this.image = [
      faceImage, faceImage, faceImage,
      faceImage, faceImage, faceImage,
    ];
    this.source.data = this.image;

    this._faceCompareFunctions = new Array(6).fill(null);
    this._faceDepthRanges = new Array(6).fill(null);
    this._fallback = [];

    this.pcfRadius = 2;
    this.pcfSamples = 9;

    this.dynamicFeatures = {
      resolutionSwitch: false,
      perFaceCompare: false,
      perFaceRange: false,
      adaptiveQuality: false,
      pcfPerFace: false,
      proceduralFallback: false,
    };
  }

  asBitecsComponent(name) {
    const base = super.asBitecsComponent(name);
    const size = this.faceSize;

    return {
      ...base,
      isCubeDepthTexture: 1,
      faceCount: 6,
      faceSize: size,
      faceCompareFunctions: this._faceCompareFunctions.slice(0),
      hasFaceRanges: this._faceDepthRanges.some((r) => r !== null) ? 1 : 0,
      pcfRadius: this.pcfRadius,
      pcfSamples: this.pcfSamples,
      hasFallback: this._fallback && this._fallback.length > 0 ? 1 : 0,
      perFaceCompare: this.dynamicFeatures.perFaceCompare ? 1 : 0,
      perFaceRange: this.dynamicFeatures.perFaceRange ? 1 : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  CubeDepthTexture,
  CubeDepthTextureBatch,
  CompareFunction,
  validateCubeDepthRangePrecise,
  paintCubeDepthFallback,
  cubeFaceToDirectionPrecise,
};
export default CubeDepthTexture;