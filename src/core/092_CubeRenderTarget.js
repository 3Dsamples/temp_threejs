// file number : 092
// full path name : src/core/092_CubeRenderTarget.js
// description : High-performance six-face cube render target rewritten as a pure ES module with zero CDN imports. Extends RenderTarget (089) with a lightweight local CubeTexture-compatible descriptor, pooled instances, zero-allocation face-direction utilities, and Vec4/Mat4 packing via the project’s native math modules. Bridges natively to BitECS SoA columns for ECS-driven cube-map systems, and uses SimplexNoise for procedural environment utilities. Designed for dynamic reflections, environment capture, and point-light shadows at 10k+ entities on Android 64-bit.
// best for : Real-time environment capture (CubeCamera), dynamic reflections, point-light shadow cubemaps, IBL probes, and any ECS-driven living-world renderer that needs six-face offscreen rendering without GC pressure.
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
import { RenderTarget } from './089_RenderTarget.js';

// ---------------------------------------------------------------------------
// Static pool for CubeRenderTarget instances – recycled to eliminate per-probe
// allocation churn when 10k+ reflective entities spawn/despawn in an ECS.
// ---------------------------------------------------------------------------
const _cubePool = [];

/**
 * Acquire a CubeRenderTarget from the pool (reset to default state).
 * @returns {CubeRenderTarget}
 */
function acquireCubeTarget() {
  const t = _cubePool.pop();
  if (t) {
    t.width = 1;
    t.height = 1;
    t.scissor.set(0, 0, 1, 1);
    t.scissorTest = false;
    t.viewport.set(0, 0, 1, 1);
    t.textures = [];
    t.depthBuffer = true;
    t.stencilBuffer = false;
    t.samples = 0;
    t._version = 0;
    t._needsUpdate = false;
    if (t.texture && t.texture.image) {
      for (let i = 0; i < 6; i++) {
        t.texture.image[i].width = 1;
        t.texture.image[i].height = 1;
      }
    }
    return t;
  }
  return new CubeRenderTarget();
}

/**
 * Return a CubeRenderTarget to the pool. Caller must not use it afterward.
 * @param {CubeRenderTarget} t
 */
function releaseCubeTarget(t) {
  if (_cubePool.length < 64) _cubePool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _scratchVec3 = new Float32Array(3);
const _scratchVec4 = new Float32Array(4);
const _scratchMat4 = new Float32Array(16);

// ---------------------------------------------------------------------------
// Lightweight local CubeTexture-compatible descriptor.
// Avoids CDN import while exposing the minimum API required by the renderer:
//   .image = [6 faces of { width, height, depth }]
//   .isCubeTexture = true
//   .isRenderTargetTexture = true
// ---------------------------------------------------------------------------
class LocalCubeTexture {
  constructor(size = 1) {
    const image = { width: size, height: size, depth: 1 };
    this.image = [image, image, image, image, image, image];
    this.isCubeTexture = true;
    this.isRenderTargetTexture = true;
    this.magFilter = Constants.LinearFilter;
    this.minFilter = Constants.LinearFilter;
    this.wrapS = Constants.ClampToEdgeWrapping;
    this.wrapT = Constants.ClampToEdgeWrapping;
    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 1;
  }

  dispose() {
    for (let i = 0; i < 6; i++) this.image[i] = null;
  }
}

// ---------------------------------------------------------------------------
// Utility surface – bridges to Vec3/Vec4/Mat4, SimplexNoise, and BitECS.
// All helpers are allocation-free.
// ---------------------------------------------------------------------------
const CubeRenderTargetUtils = {
  /**
   * Return the unit direction vector for a cube face.
   * @param {number} faceIndex – 0..5 (+X, -X, +Y, -Y, +Z, -Z)
   * @param {Float32Array} [out] – length 3 output buffer
   * @returns {Float32Array}
   */
  faceDirection(faceIndex, out) {
    const d = out || _scratchVec3;
    switch (faceIndex) {
      case 0: d[0] = 1; d[1] = 0; d[2] = 0; break;   // +X
      case 1: d[0] = -1; d[1] = 0; d[2] = 0; break;  // -X
      case 2: d[0] = 0; d[1] = 1; d[2] = 0; break;   // +Y
      case 3: d[0] = 0; d[1] = -1; d[2] = 0; break;  // -Y
      case 4: d[0] = 0; d[1] = 0; d[2] = 1; break;   // +Z
      case 5: d[0] = 0; d[1] = 0; d[2] = -1; break;  // -Z
      default: d[0] = 0; d[1] = 0; d[2] = 0;
    }
    return d;
  },

  /**
   * Pack (size, size, faceIndex, 1) into a Vec4 using the project’s native
   * Vec4 + Mat4 primitives (replaces gl-matrix).
   * @param {Float32Array} [out] – length 4 output buffer
   * @param {number} size
   * @param {number} faceIndex
   * @returns {Float32Array}
   */
  packFaceToVec4(out, size, faceIndex) {
    const o = out || _scratchVec4;
    Mat4.identity(_scratchMat4);
    Vec4.set(o, size, size, faceIndex, 1);
    Vec4.transformMat4(o, o, _scratchMat4);
    return o;
  },

  /**
   * Transform a face direction by a Mat4 using the project’s native Vec3.
   * @param {Float32Array} [out] – length 3 output buffer
   * @param {Float32Array} dir
   * @param {Float32Array} [matrix] – length 16 column-major Mat4 (identity if omitted)
   * @returns {Float32Array}
   */
  transformFace(out, dir, matrix) {
    const o = out || _scratchVec3;
    Vec3.transformMat4(o, dir, matrix || _scratchMat4);
    return o;
  },

  /**
   * High-precision total texel count across all six faces.
   * JS Float64 is IEEE-754 double precision, so no double.js dependency.
   * @param {number} size
   * @returns {number}
   */
  totalTexels(size) {
    return size * size * 6;
  },

  /**
   * Register a BitECS SoA component column set for CubeRenderTarget state.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, sizeColumn: Float32Array, faceCountColumn: Uint8Array, count: number }}
   */
  registerComponent(name, count) {
    return {
      name,
      sizeColumn: new Float32Array(count),
      faceCountColumn: new Uint8Array(count),
      count,
    };
  },

  // --- SimplexNoise bridges (procedural cube-map utilities) ---------------

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
 * CubeRenderTarget
 * Six-face render target for environment capture, dynamic reflections,
 * and point-light shadows. Extends RenderTarget with a CubeTexture-compatible
 * local descriptor and pooled face management.
 *
 * Features:
 * – Pooled instances (acquire / release).
 * – Zero-allocation faceDirection / packFaceToVec4 / transformFace.
 * – Lightweight LocalCubeTexture avoids CDN dependency on three.js textures.
 * – Vec3/Vec4/Mat4 utilities via the project’s native math modules (no gl-matrix).
 * – BitECS SoA bridge: asBitecsComponent(name, count) produces typed-array columns.
 * – SimplexNoise utilities for procedural cube-map generation.
 * – No static server, no bundler, no CDN dependency.
 */
class CubeRenderTarget extends RenderTarget {
  /**
   * @param {number} [size=1] – face size (cube faces are size × size)
   * @param {object} [options={}]
   */
  constructor(size = 1, options = {}) {
    super(size, size, options);

    this.isCubeRenderTarget = true;
    this.width = size;
    this.height = size;

    // Overwrite the 2D texture with a lightweight cube-texture descriptor
    this.texture = new LocalCubeTexture(size);

    this._setTextureOptions(options);

    // By convention – likely based on the RenderMan spec from the 1990's –
    // cube maps are specified by WebGL (and three.js) in a coordinate system
    // in which positive-x is to the right when looking up the positive-z axis –
    // in other words, in a left-handed coordinate system. By continuing this
    // convention, preexisting cube maps continued to render correctly.
    // three.js uses a right-handed coordinate system. So environment maps
    // used in three.js appear to have px and nx swapped and the flag
    // isRenderTargetTexture controls this conversion. The flip is not required
    // when using CubeRenderTarget.texture as a cube texture (this is detected
    // when isRenderTargetTexture is set to true for cube textures).
    this.texture.isRenderTargetTexture = true;
  }

  // --- Internal texture option application -------------------------------

  /**
   * Apply texture options to the lightweight cube descriptor.
   * @param {object} options
   * @private
   */
  _setTextureOptions(options) {
    const tex = this.texture;
    if (options.magFilter !== undefined) tex.magFilter = options.magFilter;
    if (options.minFilter !== undefined) tex.minFilter = options.minFilter;
    if (options.wrapS !== undefined) tex.wrapS = options.wrapS;
    if (options.wrapT !== undefined) tex.wrapT = options.wrapT;
    if (options.generateMipmaps !== undefined) tex.generateMipmaps = options.generateMipmaps;
    if (options.flipY !== undefined) tex.flipY = options.flipY;
    if (options.unpackAlignment !== undefined) tex.unpackAlignment = options.unpackAlignment;
  }

  // --- Size management ----------------------------------------------------

  /**
   * Resize all six faces. Mutates the lightweight texture descriptor in place.
   * @param {number} size
   * @returns {this}
   */
  setSize(size) {
    const s = Common.clamp(Math.floor(size), 1, 8192);
    super.setSize(s, s, 1);
    if (this.texture && this.texture.image) {
      for (let i = 0; i < 6; i++) {
        this.texture.image[i].width = s;
        this.texture.image[i].height = s;
      }
    }
    return this;
  }

  // --- Convenience accessors ---------------------------------------------

  /**
   * Return the unit direction vector for a cube face.
   * @param {number} faceIndex
   * @param {Float32Array} [out]
   * @returns {Float32Array}
   */
  getFaceDirection(faceIndex, out) {
    return CubeRenderTargetUtils.faceDirection(faceIndex, out);
  }

  /**
   * Pack (size, size, faceIndex, 1) into a Vec4 for shader uniforms.
   * @param {Float32Array} [out]
   * @param {number} faceIndex
   * @returns {Float32Array}
   */
  packFaceToVec4(out, faceIndex) {
    return CubeRenderTargetUtils.packFaceToVec4(out, this.width, faceIndex);
  }

  /**
   * @returns {number} total texels across all six faces
   */
  getTotalTexels() {
    return CubeRenderTargetUtils.totalTexels(this.width);
  }

  /**
   * Produce a BitECS SoA component column set filled with this target’s
   * state replicated across `count` entities.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, sizeColumn: Float32Array, faceCountColumn: Uint8Array, count: number }}
   */
  asBitecsComponent(name, count) {
    const comp = CubeRenderTargetUtils.registerComponent(name, count);
    const s = this.width;
    const sc = comp.sizeColumn;
    const fc = comp.faceCountColumn;
    for (let i = 0; i < count; i++) {
      sc[i] = s;
      fc[i] = 6;
    }
    return comp;
  }

  // --- Placeholder for equirectangular → cube-map conversion -------------

  /**
   * Placeholder for equirectangular → cube-map conversion. The full
   * implementation requires a renderer instance and lives in the
   * renderer-specific subclass (e.g. WebGLCubeRenderTarget).
   * @param {object} renderer
   * @param {object} texture
   * @returns {this}
   */
  fromEquirectangularTexture(renderer, texture) {
    this.texture.type = texture.type;
    this.texture.colorSpace = texture.colorSpace;
    this.texture.generateMipmaps = texture.generateMipmaps;
    this.texture.minFilter = texture.minFilter;
    this.texture.magFilter = texture.magFilter;
    return this;
  }

  // --- Copy / Clone -------------------------------------------------------

  /**
   * Copy settings from another CubeRenderTarget.
   * @param {CubeRenderTarget} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);
    if (this.texture && this.texture.image) {
      for (let i = 0; i < 6; i++) {
        this.texture.image[i].width = source.width;
        this.texture.image[i].height = source.height;
      }
    }
    return this;
  }

  /**
   * Clone this cube render target (allocates a new pooled instance).
   * @returns {CubeRenderTarget}
   */
  clone() {
    return new this.constructor(this.width).copy(this);
  }

  // --- Disposal -----------------------------------------------------------

  /**
   * Dispose the cube render target. Releases the local texture descriptor
   * and dispatches a dispose event for GPU-side cleanup.
   */
  dispose() {
    this.dispatchEvent({ type: 'dispose' });
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
    this.textures.length = 0;
    this.depthTexture = null;
  }

  // --- Pooling ------------------------------------------------------------

  /**
   * Acquire a pooled CubeRenderTarget instance (1×1×6, default options).
   * @returns {CubeRenderTarget}
   */
  static acquire() {
    return acquireCubeTarget();
  }

  /**
   * Return this CubeRenderTarget to the pool. Caller must not use it afterward.
   */
  release() {
    releaseCubeTarget(this);
  }

  /**
   * Clear the global CubeRenderTarget pool.
   */
  static clearPool() {
    _cubePool.length = 0;
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = CubeRenderTargetUtils;
}

export { CubeRenderTarget, CubeRenderTargetUtils };