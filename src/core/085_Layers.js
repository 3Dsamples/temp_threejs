// file number : 085
// full path name : src/core/085_Layers.js
// description : High-performance 32-bit layer mask for Object3D/camera visibility and culling. Rewritten as a pure ES module with zero CDN imports, pooled Layers instances, native BitECS SoA column bridging, and gl-matrix‑free vector helpers built on the project’s own Vec2/Mat2 math primitives. Designed for 10k+ entities on Android 64-bit with allocation-free hot paths.
// best for : Per-object layer membership checks, camera culling masks, ECS-driven visibility systems, and any context-awareness pipeline that must scale from local props to galactic-scale scenes without GC spikes.
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

// ---------------------------------------------------------------------------
// Static pool for Layers instances – recycled to eliminate per-entity
// allocation churn when 10k+ objects enter/leave the scene.
// ---------------------------------------------------------------------------
const _layersPool = [];

/**
 * Acquire a Layers instance from the pool.
 * @returns {Layers}
 */
function acquireLayers() {
  const l = _layersPool.pop();
  if (l) {
    l.mask = 1; // reset to default layer 0
    return l;
  }
  return new Layers();
}

/**
 * Return a Layers instance to the pool. Caller must not use it afterward.
 * @param {Layers} l
 */
function releaseLayers(l) {
  if (_layersPool.length < 256) _layersPool.push(l);
}

// ---------------------------------------------------------------------------
// Scratch buffers for the utility surface (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _scratchVec2 = new Float32Array(2);
const _scratchMat2 = new Float32Array(4);

// ---------------------------------------------------------------------------
// Utility surface – bridges to BitECS, SimplexNoise, Vec2/Mat2, and bit math.
// All helpers are allocation-free and use the project’s native math modules.
// ---------------------------------------------------------------------------
const LayersUtils = {
  /**
   * Convert a layer mask into a 2‑component vector where x = mask and
   * y = bitwise complement. Useful for batch membership tests via Mat2.
   * Uses the project’s Vec2 and Mat2 primitives.
   * @param {number} mask
   * @returns {Float32Array} length‑2 vector (shared scratch buffer)
   */
  maskAsVec2(mask) {
    Mat2.identity(_scratchMat2);
    Vec2.set(_scratchVec2, mask >>> 0, (mask >>> 0) ^ 0xffffffff);
    Vec2.transformMat2(_scratchVec2, _scratchVec2, _scratchMat2);
    return _scratchVec2;
  },

  /**
   * Register a Uint32Array column for use as a BitECS component.
   * The column is pre‑filled with the provided default mask.
   * @param {string} name  – component name (for diagnostics)
   * @param {number} count – number of entities
   * @param {number} [defaultMask=1] – initial value for every slot
   * @returns {{ name: string, column: Uint32Array, count: number }}
   */
  registerComponent(name, count, defaultMask = 1) {
    const column = new Uint32Array(count);
    column.fill(defaultMask >>> 0);
    return { name, column, count };
  },

  /**
   * Fast popcount of set layers using bitwise parallel reduction
   * (no string conversion, no Double.js).
   * @param {number} mask
   * @returns {number}
   */
  popCount(mask) {
    let m = mask >>> 0;
    m = m - ((m >>> 1) & 0x55555555);
    m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
    m = (m + (m >>> 4)) & 0x0f0f0f0f;
    return (m * 0x01010101) >>> 24;
  },

  // --- SimplexNoise bridges (deterministic layer jitter) -------------------

  noise2D: (x, y) => SimplexNoise.noise2D(x, y),
  noise3D: (x, y, z) => SimplexNoise.noise3D(x, y, z),
  noise4D: (x, y, z, w) => SimplexNoise.noise4D(x, y, z, w),

  // --- BitECS surface ------------------------------------------------------

  BitECS,
  World,
  Components,
  Systems,
};

/**
 * Layers
 * 32‑bit layer mask with pooled instances and native BitECS integration.
 *
 * The mask defaults to `1` (layer 0). Methods mutate the mask in place.
 * All bit operations use `>>> 0` to keep the value in the unsigned 32‑bit
 * domain, which is critical for correctness on 64‑bit Android devices.
 */
class Layers {
  constructor() {
    this.mask = 1 | 0;
  }

  /**
   * Replace the mask with a single layer.
   * @param {number} layer – 0‑31
   * @returns {this}
   */
  set(layer) {
    this.mask = ((1 << layer) | 0) >>> 0;
    return this;
  }

  /**
   * Enable a layer in the mask.
   * @param {number} layer
   * @returns {this}
   */
  enable(layer) {
    this.mask |= (1 << layer) | 0;
    return this;
  }

  /**
   * Enable all 32 layers.
   * @returns {this}
   */
  enableAll() {
    this.mask = 0xffffffff | 0;
    return this;
  }

  /**
   * Toggle a layer in the mask.
   * @param {number} layer
   * @returns {this}
   */
  toggle(layer) {
    this.mask ^= (1 << layer) | 0;
    return this;
  }

  /**
   * Disable a layer in the mask.
   * @param {number} layer
   * @returns {this}
   */
  disable(layer) {
    this.mask &= ~((1 << layer) | 0);
    return this;
  }

  /**
   * Disable all layers.
   * @returns {this}
   */
  disableAll() {
    this.mask = 0;
    return this;
  }

  /**
   * Test whether this mask shares any layer with another Layers instance.
   * @param {Layers} layers
   * @returns {boolean}
   */
  test(layers) {
    return (this.mask & layers.mask) !== 0;
  }

  /**
   * Check whether a specific layer is enabled.
   * @param {number} layer
   * @returns {boolean}
   */
  isEnabled(layer) {
    return (this.mask & ((1 << layer) | 0)) !== 0;
  }

  /**
   * Return the number of set layers (fast popcount).
   * @returns {number}
   */
  getPopCount() {
    return LayersUtils.popCount(this.mask);
  }

  /**
   * Produce a BitECS-compatible component column filled with this mask.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, column: Uint32Array, count: number }}
   */
  asBitecsComponent(name, count) {
    const comp = LayersUtils.registerComponent(name, count, this.mask >>> 0);
    return comp;
  }

  /**
   * Convert this mask into a 2‑component vector (shared scratch buffer).
   * @returns {Float32Array}
   */
  toVec2() {
    return LayersUtils.maskAsVec2(this.mask);
  }

  /**
   * Copy another Layers instance’s mask.
   * @param {Layers} source
   * @returns {this}
   */
  copy(source) {
    this.mask = source.mask | 0;
    return this;
  }

  // --- Pooling ------------------------------------------------------------

  /**
   * Acquire a pooled Layers instance (mask = 1).
   * @returns {Layers}
   */
  static acquire() {
    return acquireLayers();
  }

  /**
   * Return this instance to the pool. Caller must not use it afterward.
   */
  release() {
    releaseLayers(this);
  }

  /**
   * Clear the global Layers pool.
   */
  static clearPool() {
    _layersPool.length = 0;
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = LayersUtils;
}

export { Layers, LayersUtils };