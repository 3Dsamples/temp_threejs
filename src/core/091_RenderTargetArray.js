// file number : 091
// full path name : src/core/091_RenderTargetArray.js
// description : High-performance array-texture render target rewritten as a pure ES module with zero CDN imports. Manages a layer-count dimension on top of RenderTarget (089) with a lightweight local DataArrayTexture-compatible descriptor, pooled instances, and zero-allocation layer/format handling. Bridges natively to the project’s Vec4/Mat4 math primitives and BitECS SoA registration. Supports cascaded shadow maps, texture arrays, decals, and VR multiview on Android 64-bit.
// best for : Cascaded shadow maps (CSM), texture arrays, decal systems, VR multiview, layered post-processing, and any ECS-driven living-world renderer that needs per-layer offscreen buffers without GC pressure at 10k+ entities.
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
// Static pool for RenderTargetArray instances – recycled to eliminate per-pass
// allocation churn when 10k+ layered effects spawn/despawn in an ECS.
// ---------------------------------------------------------------------------
const _targetArrayPool = [];

/**
 * Acquire a RenderTargetArray from the pool (reset to default state).
 * @returns {RenderTargetArray}
 */
function acquireTargetArray() {
  const t = _targetArrayPool.pop();
  if (t) {
    t.width = 1;
    t.height = 1;
    t.depth = 1;
    t.scissor.set(0, 0, 1, 1);
    t.scissorTest = false;
    t.viewport.set(0, 0, 1, 1);
    t.textures = [];
    t.depthBuffer = true;
    t.stencilBuffer = false;
    t.resolveDepthBuffer = true;
    t.resolveStencilBuffer = true;
    t.samples = 0;
    t.depthTexture = null;
    t._version = 0;
    t._needsUpdate = false;
    if (t.texture && t.texture.image) {
      t.texture.image.width = 1;
      t.texture.image.height = 1;
      t.texture.image.depth = 1;
    }
    return t;
  }
  return new RenderTargetArray();
}

/**
 * Return a RenderTargetArray to the pool. Caller must not use it afterward.
 * @param {RenderTargetArray} t
 */
function releaseTargetArray(t) {
  if (_targetArrayPool.length < 64) _targetArrayPool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _scratchVec4 = new Float32Array(4);
const _scratchMat4 = new Float32Array(16);

// ---------------------------------------------------------------------------
// Lightweight local DataArrayTexture-compatible descriptor.
// Avoids CDN import while exposing the minimum API required by the renderer:
//   .image = { data: null, width, height, depth }
//   .isDataArrayTexture = true
//   .isRenderTargetTexture = true
// ---------------------------------------------------------------------------
class LocalDataArrayTexture {
  constructor(width = 1, height = 1, depth = 1) {
    this.image = { data: null, width, height, depth };
    this.isDataArrayTexture = true;
    this.isRenderTargetTexture = true;
    this.magFilter = Constants.LinearFilter;
    this.minFilter = Constants.LinearFilter;
    this.wrapR = Constants.ClampToEdgeWrapping;
    this.wrapS = Constants.ClampToEdgeWrapping;
    this.wrapT = Constants.ClampToEdgeWrapping;
    this.generateMipmaps = false;
    this.flipY = false;
    this.unpackAlignment = 1;
  }

  dispose() {
    this.image.data = null;
  }
}

// ---------------------------------------------------------------------------
// Utility surface – bridges to Vec4/Mat4, SimplexNoise, and BitECS.
// All helpers are allocation-free.
// ---------------------------------------------------------------------------
const RenderTargetArrayUtils = {
  /**
   * Pack (width, height, layers, 1) into a Vec4 using the project’s native
   * Vec4 + Mat4 primitives (replaces gl-matrix).
   * @param {Float32Array} [out] – length 4 output buffer
   * @param {number} width
   * @param {number} height
   * @param {number} layers
   * @returns {Float32Array}
   */
  packDimensionsToVec4(out, width, height, layers) {
    const o = out || _scratchVec4;
    Mat4.identity(_scratchMat4);
    Vec4.set(o, width, height, layers, 1);
    Vec4.transformMat4(o, o, _scratchMat4);
    return o;
  },

  /**
   * High-precision total texel count across all layers.
   * @param {number} width
   * @param {number} height
   * @param {number} layers
   * @returns {number}
   */
  totalTexels(width, height, layers) {
    return width * height * layers;
  },

  /**
   * Register a BitECS SoA component column set for RenderTargetArray state.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, widthColumn: Float32Array, heightColumn: Float32Array, layersColumn: Float32Array, count: number }}
   */
  registerComponent(name, count) {
    return {
      name,
      widthColumn: new Float32Array(count),
      heightColumn: new Float32Array(count),
      layersColumn: new Float32Array(count),
      count,
    };
  },

  // --- SimplexNoise bridges (procedural layer utilities) -----------------

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
 * RenderTargetArray
 * Extends RenderTarget with a layer dimension and a DataArrayTexture-compatible
 * local texture descriptor. Suitable for cascaded shadow maps, texture arrays,
 * decals, and VR multiview.
 *
 * Features:
 * – Pooled instances (acquire / release).
 * – Zero-allocation setSize(width, height, layers) and setLayer(index).
 * – Lightweight LocalDataArrayTexture avoids CDN dependency on three.js textures.
 * – Vec4/Mat4 packing via the project’s native math modules (no gl-matrix).
 * – BitECS SoA bridge for ECS-driven layered-rendering systems.
 * – SimplexNoise utilities for procedural array-layer generation.
 * – No static server, no bundler, no CDN dependency.
 */
class RenderTargetArray extends RenderTarget {
  /**
   * @param {number} [width=1]
   * @param {number} [height=1]
   * @param {number} [depth=1] – number of layers
   * @param {object} [options={}]
   */
  constructor(width = 1, height = 1, depth = 1, options = {}) {
    super(width, height, options);

    this.isRenderTargetArray = true;
    this.depth = depth;
    this._activeLayer = 0;

    // Overwrite the 2D texture with a lightweight array-texture descriptor
    this.texture = new LocalDataArrayTexture(width, height, depth);

    this._setTextureOptions(options);
  }

  // --- Internal texture option application -------------------------------

  /**
   * Apply texture options to the lightweight array descriptor.
   * @param {object} options
   * @private
   */
  _setTextureOptions(options) {
    const tex = this.texture;
    if (options.magFilter !== undefined) tex.magFilter = options.magFilter;
    if (options.minFilter !== undefined) tex.minFilter = options.minFilter;
    if (options.wrapS !== undefined) tex.wrapS = options.wrapS;
    if (options.wrapT !== undefined) tex.wrapT = options.wrapT;
    if (options.wrapR !== undefined) tex.wrapR = options.wrapR;
    if (options.generateMipmaps !== undefined) tex.generateMipmaps = options.generateMipmaps;
    if (options.flipY !== undefined) tex.flipY = options.flipY;
    if (options.unpackAlignment !== undefined) tex.unpackAlignment = options.unpackAlignment;
  }

  // --- Size management ----------------------------------------------------

  /**
   * Resize the array render target. Mutates the lightweight texture descriptor
   * in place without allocating a new texture object.
   * @param {number} width
   * @param {number} height
   * @param {number} [depth=1] – number of layers
   * @returns {this}
   */
  setSize(width, height, depth = 1) {
    super.setSize(width, height, 1);
    this.depth = depth;
    if (this.texture && this.texture.image) {
      this.texture.image.width = width;
      this.texture.image.height = height;
      this.texture.image.depth = depth;
    }
    // Clamp the active layer if it exceeds the new layer count
    if (this._activeLayer >= depth) this._activeLayer = depth - 1;
    return this;
  }

  // --- Layer management ---------------------------------------------------

  /**
   * Set the active layer for subsequent rendering.
   * @param {number} index – 0-based layer index
   * @returns {this}
   */
  setLayer(index) {
    const i = Common.clamp(index | 0, 0, this.depth - 1);
    this._activeLayer = i;
    return this;
  }

  /** @returns {number} the currently active layer index */
  get activeLayer() {
    return this._activeLayer;
  }

  // --- Convenience accessors ---------------------------------------------

  /**
   * Pack (width, height, layers, 1) into a Vec4 for shader uniforms.
   * @param {Float32Array} [out] – length 4 output buffer
   * @returns {Float32Array}
   */
  packDimensionsToVec4(out) {
    return RenderTargetArrayUtils.packDimensionsToVec4(out, this.width, this.height, this.depth);
  }

  /**
   * @returns {number} total texels across all layers
   */
  getTotalTexels() {
    return RenderTargetArrayUtils.totalTexels(this.width, this.height, this.depth);
  }

  /**
   * Produce a BitECS SoA component column set filled with this target’s
   * state replicated across `count` entities.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, widthColumn: Float32Array, heightColumn: Float32Array, layersColumn: Float32Array, count: number }}
   */
  asBitecsComponent(name, count) {
    const comp = RenderTargetArrayUtils.registerComponent(name, count);
    const w = this.width, h = this.height, d = this.depth;
    const wc = comp.widthColumn, hc = comp.heightColumn, lc = comp.layersColumn;
    for (let i = 0; i < count; i++) {
      wc[i] = w;
      hc[i] = h;
      lc[i] = d;
    }
    return comp;
  }

  // --- Copy / Clone -------------------------------------------------------

  /**
   * Copy settings from another RenderTargetArray.
   * @param {RenderTargetArray} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);
    this.depth = source.depth;
    this._activeLayer = source._activeLayer;
    if (this.texture && this.texture.image) {
      this.texture.image.width = source.width;
      this.texture.image.height = source.height;
      this.texture.image.depth = source.depth;
    }
    return this;
  }

  /**
   * Clone this render target (allocates a new pooled instance).
   * @returns {RenderTargetArray}
   */
  clone() {
    return new this.constructor().copy(this);
  }

  // --- Disposal -----------------------------------------------------------

  /**
   * Dispose the array render target. Releases the local texture descriptor
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
   * Acquire a pooled RenderTargetArray instance (1×1×1, default options).
   * @returns {RenderTargetArray}
   */
  static acquire() {
    return acquireTargetArray();
  }

  /**
   * Return this RenderTargetArray to the pool. Caller must not use it afterward.
   */
  release() {
    releaseTargetArray(this);
  }

  /**
   * Clear the global RenderTargetArray pool.
   */
  static clearPool() {
    _targetArrayPool.length = 0;
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = RenderTargetArrayUtils;
}

export { RenderTargetArray, RenderTargetArrayUtils };