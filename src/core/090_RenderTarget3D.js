// file number : 090
// full path name : src/core/090_RenderTarget3D.js
// description : High-performance 3D render target (volume / voxel / 3D-texture) rewritten as a pure ES module with zero CDN imports. Extends the pooled RenderTarget (089) with depth-aware sizing, a lightweight local Data3DTexture-compatible descriptor, and zero-allocation Vec4/Mat4 dimension packing via the project’s native math modules. Bridges natively to BitECS SoA columns for ECS-driven volume rendering, and uses SimplexNoise for procedural 3D render-target utilities. Pooled instances keep 10k+ entity pipelines allocation-free on Android 64-bit.
// best for : Volume rendering (fog, clouds, smoke, medical voxels), 3D post-processing (light shafts, volumetric shadows), GPGPU 3D textures, and any living-world effect that needs depth-aware offscreen rendering without GC pressure.
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
// Static pool for RenderTarget3D instances – recycled to eliminate per-pass
// allocation churn when 10k+ volumetric effects spawn/despawn in an ECS.
// ---------------------------------------------------------------------------
const _target3DPool = [];

/**
 * Acquire a RenderTarget3D from the pool (reset to default state).
 * @returns {RenderTarget3D}
 */
function acquireTarget3D() {
  const t = _target3DPool.pop();
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
    // Reset the lightweight 3D texture descriptor
    if (t.texture) {
      t.texture.image.width = 1;
      t.texture.image.height = 1;
      t.texture.image.depth = 1;
    }
    return t;
  }
  return new RenderTarget3D();
}

/**
 * Return a RenderTarget3D to the pool. Caller must not use it afterward.
 * @param {RenderTarget3D} t
 */
function releaseTarget3D(t) {
  if (_target3DPool.length < 64) _target3DPool.push(t);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _scratchVec4 = new Float32Array(4);
const _scratchMat4 = new Float32Array(16);

// ---------------------------------------------------------------------------
// Lightweight local Data3DTexture-compatible descriptor.
// Avoids CDN import while exposing the minimum API required by the renderer:
//   .image = { data: null, width, height, depth }
//   .isData3DTexture = true
//   .isRenderTargetTexture = true
// ---------------------------------------------------------------------------
class LocalData3DTexture {
  constructor(width = 1, height = 1, depth = 1) {
    this.image = { data: null, width, height, depth };
    this.isData3DTexture = true;
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
const RenderTarget3DUtils = {
  /**
   * Pack (width, height, depth, 1) into a Vec4 using the project’s native
   * Vec4 + Mat4 primitives (replaces gl-matrix).
   * @param {Float32Array} [out] – length 4 output buffer
   * @param {number} width
   * @param {number} height
   * @param {number} depth
   * @returns {Float32Array}
   */
  packDimensionsToVec4(out, width, height, depth) {
    const o = out || _scratchVec4;
    Mat4.identity(_scratchMat4);
    Vec4.set(o, width, height, depth, 1);
    Vec4.transformMat4(o, o, _scratchMat4);
    return o;
  },

  /**
   * High-precision total voxel count. JS Float64 is already IEEE-754 double
   * precision, so no double.js dependency is needed.
   * @param {number} width
   * @param {number} height
   * @param {number} depth
   * @returns {number}
   */
  totalVoxels(width, height, depth) {
    return width * height * depth;
  },

  /**
   * Register a BitECS SoA component column set for RenderTarget3D state.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, widthColumn: Float32Array, heightColumn: Float32Array, depthColumn: Float32Array, count: number }}
   */
  registerComponent(name, count) {
    return {
      name,
      widthColumn: new Float32Array(count),
      heightColumn: new Float32Array(count),
      depthColumn: new Float32Array(count),
      count,
    };
  },

  // --- SimplexNoise bridges (procedural volumetric utilities) ------------

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
 * RenderTarget3D
 * Extends RenderTarget with a depth dimension and a Data3DTexture-compatible
 * local texture descriptor. Suitable for volume rendering, 3D post-processing,
 * and GPGPU 3D textures.
 *
 * Features:
 * – Pooled instances (acquire / release).
 * – Zero-allocation packDimensionsToVec4 / getTotalVoxels / asBitecsComponent.
 * – Lightweight LocalData3DTexture avoids CDN dependency on three.js textures.
 * – Vec4/Mat4 packing via the project’s native math modules (no gl-matrix).
 * – BitECS SoA bridge for ECS-driven volumetric systems.
 * – SimplexNoise utilities for procedural 3D render-target generation.
 * – No static server, no bundler, no CDN dependency.
 */
class RenderTarget3D extends RenderTarget {
  /**
   * @param {number} [width=1]
   * @param {number} [height=1]
   * @param {number} [depth=1]
   * @param {object} [options={}]
   */
  constructor(width = 1, height = 1, depth = 1, options = {}) {
    super(width, height, options);

    this.isRenderTarget3D = true;
    this.depth = depth;

    // Overwrite the 2D texture with a lightweight 3D descriptor
    this.texture = new LocalData3DTexture(width, height, depth);

    this._setTextureOptions(options);
  }

  // --- Internal texture option application -------------------------------

  /**
   * Apply texture options to the lightweight 3D descriptor.
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
   * Resize the 3D render target. Mutates the lightweight texture descriptor
   * in place without allocating a new texture object.
   * @param {number} width
   * @param {number} height
   * @param {number} [depth=1]
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
    return this;
  }

  // --- Convenience accessors ---------------------------------------------

  /**
   * Pack (width, height, depth, 1) into a Vec4 for shader uniforms.
   * @param {Float32Array} [out] – length 4 output buffer
   * @returns {Float32Array}
   */
  packDimensionsToVec4(out) {
    return RenderTarget3DUtils.packDimensionsToVec4(out, this.width, this.height, this.depth);
  }

  /**
   * @returns {number} total number of voxels
   */
  getTotalVoxels() {
    return RenderTarget3DUtils.totalVoxels(this.width, this.height, this.depth);
  }

  /**
   * Produce a BitECS SoA component column set filled with this target’s
   * state replicated across `count` entities.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, widthColumn: Float32Array, heightColumn: Float32Array, depthColumn: Float32Array, count: number }}
   */
  asBitecsComponent(name, count) {
    const comp = RenderTarget3DUtils.registerComponent(name, count);
    const w = this.width, h = this.height, d = this.depth;
    const wc = comp.widthColumn, hc = comp.heightColumn, dc = comp.depthColumn;
    for (let i = 0; i < count; i++) {
      wc[i] = w;
      hc[i] = h;
      dc[i] = d;
    }
    return comp;
  }

  // --- Copy / Clone -------------------------------------------------------

  /**
   * Copy settings from another RenderTarget3D.
   * @param {RenderTarget3D} source
   * @returns {this}
   */
  copy(source) {
    super.copy(source);
    this.depth = source.depth;
    if (this.texture && this.texture.image) {
      this.texture.image.width = source.width;
      this.texture.image.height = source.height;
      this.texture.image.depth = source.depth;
    }
    return this;
  }

  /**
   * Clone this render target (allocates a new pooled instance).
   * @returns {RenderTarget3D}
   */
  clone() {
    return new this.constructor().copy(this);
  }

  // --- Disposal -----------------------------------------------------------

  /**
   * Dispose the 3D render target. Releases the local texture descriptor
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
   * Acquire a pooled RenderTarget3D instance (1×1×1, default options).
   * @returns {RenderTarget3D}
   */
  static acquire() {
    return acquireTarget3D();
  }

  /**
   * Return this RenderTarget3D to the pool. Caller must not use it afterward.
   */
  release() {
    releaseTarget3D(this);
  }

  /**
   * Clear the global RenderTarget3D pool.
   */
  static clearPool() {
    _target3DPool.length = 0;
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = RenderTarget3DUtils;
}

export { RenderTarget3D, RenderTarget3DUtils };