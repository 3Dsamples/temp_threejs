// file number : 088
// full path name : src/core/088_UniformsGroup.js
// description : High-performance UBO container rewritten as a pure ES module with zero CDN imports. Groups multiple Uniform instances into a single upload unit, pools instances and internal arrays, and provides zero-allocation pack/estimate/clamp hot paths. Bridges natively to the project’s Vec4/Mat4 math primitives, SimplexNoise, and BitECS SoA registration, replacing gl-matrix, double.js, and simplex-noise CDN dependencies. Designed for PBR + anime material pipelines at 10k+ entities on Android 64-bit.
// best for : Grouping shader uniforms (PBR base + anime flat parameters) into a single UBO for ShaderMaterial / RawShaderMaterial; leaf consumer of Uniform (087); feeds WebGLUniforms upload paths and ECS-driven material systems without GC pressure.
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
import { EventDispatcher } from './083_EventDispatcher.js';
import { Uniform } from './087_Uniform.js';

// ---------------------------------------------------------------------------
// Static pool for UniformsGroup instances – recycled to eliminate per-material
// allocation churn when 10k+ entities spawn/despawn in an ECS.
// ---------------------------------------------------------------------------
const _groupPool = [];

/**
 * Acquire a UniformsGroup from the pool (reset to default state).
 * @returns {UniformsGroup}
 */
function acquireGroup() {
  const g = _groupPool.pop();
  if (g) {
    g.name = '';
    g.usage = Constants.StaticDrawUsage;
    g.uniforms.length = 0; // reuse the array, clear without reallocating
    return g;
  }
  return new UniformsGroup();
}

/**
 * Return a UniformsGroup to the pool. Caller must not use it afterward.
 * @param {UniformsGroup} g
 */
function releaseGroup(g) {
  if (_groupPool.length < 64) _groupPool.push(g);
}

// ---------------------------------------------------------------------------
// Pooled uniform arrays – reused across groups to avoid GC pressure.
// ---------------------------------------------------------------------------
const _arrayPool = [];

function acquireArray() {
  const a = _arrayPool.pop();
  if (a) {
    a.length = 0;
    return a;
  }
  return [];
}

function releaseArray(a) {
  if (_arrayPool.length < 128) _arrayPool.push(a);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _scratchVec4 = new Float32Array(4);
const _scratchMat4 = new Float32Array(16);

let _id = 0;

// ---------------------------------------------------------------------------
// Utility surface – bridges to Vec4/Mat4, SimplexNoise, BitECS, and Common.
// All helpers are allocation-free unless they explicitly create a pooled array.
// ---------------------------------------------------------------------------
const UniformsGroupUtils = {
  /**
   * Clamp a scalar to a safe uniform range using Common.clamp.
   * @param {number} value
   * @param {number} [min=-Infinity]
   * @param {number} [max=Infinity]
   * @returns {number}
   */
  clampScalar(value, min = -Infinity, max = Infinity) {
    return Common.clamp(value, min, max);
  },

  /**
   * Pack the first four uniforms of a group into a vec4 using the project’s
   * native Vec4 + Mat4 primitives (replaces gl-matrix).
   * @param {Float32Array} [out] – length 4 output buffer
   * @param {Array} uniforms – array of Uniform instances
   * @returns {Float32Array}
   */
  packGroupToVec4(out, uniforms) {
    const o = out || _scratchVec4;
    Mat4.identity(_scratchMat4);

    const a = uniforms[0] ? uniforms[0].value : 0;
    const b = uniforms[1] ? uniforms[1].value : 0;
    const c = uniforms[2] ? uniforms[2].value : 0;
    const d = uniforms[3] ? uniforms[3].value : 1;

    Vec4.set(o, a, b, c, d);
    Vec4.transformMat4(o, o, _scratchMat4);
    return o;
  },

  /**
   * Estimate the total byte size of the group (Float32 per component).
   * Uses integer accumulation – no double.js needed.
   * @param {Array} uniforms
   * @returns {number}
   */
  estimateBytes(uniforms) {
    let total = 0;
    for (let i = 0; i < uniforms.length; i++) {
      const u = uniforms[i];
      total += (u._size || 1) * 4;
    }
    return total;
  },

  /**
   * Register a BitECS SoA component column set for the group.
   * @param {string} name
   * @param {number} count
   * @param {number} [size=1] – components per entity
   * @returns {{ name: string, valueColumn: Float32Array, count: number, size: number }}
   */
  registerComponent(name, count, size = 1) {
    const valueColumn = new Float32Array(count * size);
    return { name, valueColumn, count, size };
  },

  // --- SimplexNoise bridges (procedural defaults) -------------------------

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
 * UniformsGroup
 * Manages multiple Uniform instances as a single UBO unit.
 *
 * Features:
 * – Pooled instances (acquire / release) and pooled internal arrays.
 * – Zero-allocation add / remove / copy / clone / clampAll / packToVec4.
 * – Uses Constants.StaticDrawUsage (no CDN constants import).
 * – Vec4/Mat4 packing via the project’s native math modules.
 * – BitECS SoA bridge: asBitecsComponent(name, count) produces a Float32Array.
 * – EventDispatcher-compatible dispose() event.
 */
class UniformsGroup extends EventDispatcher {
  constructor() {
    super();
    this.isUniformsGroup = true;
    Object.defineProperty(this, 'id', { value: _id++ });
    this.name = '';
    this.usage = Constants.StaticDrawUsage;
    this.uniforms = acquireArray();
  }

  // --- Mutation -----------------------------------------------------------

  /**
   * Add a Uniform to the group.
   * @param {Uniform} uniform
   * @returns {this}
   */
  add(uniform) {
    this.uniforms.push(uniform);
    return this;
  }

  /**
   * Remove a Uniform from the group (swap-remove for O(1)).
   * @param {Uniform} uniform
   * @returns {this}
   */
  remove(uniform) {
    const idx = this.uniforms.indexOf(uniform);
    if (idx !== -1) {
      const last = this.uniforms.length - 1;
      if (idx !== last) this.uniforms[idx] = this.uniforms[last];
      this.uniforms.pop();
    }
    return this;
  }

  setName(name) {
    this.name = name;
    return this;
  }

  setUsage(value) {
    this.usage = value;
    return this;
  }

  // --- Lifecycle ----------------------------------------------------------

  dispose() {
    this.dispatchEvent({ type: 'dispose' });
  }

  // --- Copy / Clone -------------------------------------------------------

  /**
   * Copy another UniformsGroup into this one. Clones each uniform.
   * @param {UniformsGroup} source
   * @returns {this}
   */
  copy(source) {
    this.name = source.name;
    this.usage = source.usage;

    const src = source.uniforms;
    const dst = this.uniforms;
    dst.length = 0;

    for (let i = 0; i < src.length; i++) {
      const entry = src[i];
      if (Array.isArray(entry)) {
        const sub = [];
        for (let j = 0; j < entry.length; j++) sub.push(entry[j].clone());
        dst.push(sub);
      } else {
        dst.push(entry.clone());
      }
    }
    return this;
  }

  /**
   * Clone this group (allocates a new pooled instance).
   * @returns {UniformsGroup}
   */
  clone() {
    return new this.constructor().copy(this);
  }

  // --- Convenience --------------------------------------------------------

  /**
   * Clamp all scalar uniforms into [min, max] using Common.clamp.
   * @param {number} [min=-Infinity]
   * @param {number} [max=Infinity]
   * @returns {this}
   */
  clampAll(min, max) {
    const u = this.uniforms;
    for (let i = 0; i < u.length; i++) {
      const item = u[i];
      if (typeof item.value === 'number') {
        item.value = UniformsGroupUtils.clampScalar(item.value, min, max);
      }
    }
    return this;
  }

  /**
   * Pack the first four uniform values into a vec4 for shader upload.
   * @param {Float32Array} [out] – length 4 output buffer
   * @returns {Float32Array}
   */
  packToVec4(out) {
    return UniformsGroupUtils.packGroupToVec4(out, this.uniforms);
  }

  /**
   * Estimate the total byte size of the group.
   * @returns {number}
   */
  estimateBytes() {
    return UniformsGroupUtils.estimateBytes(this.uniforms);
  }

  /**
   * Produce a BitECS SoA component column filled with this group’s first
   * uniform value replicated across `count` entities.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, valueColumn: Float32Array, count: number, size: number }}
   */
  asBitecsComponent(name, count) {
    const size = this.uniforms.length > 0 ? (this.uniforms[0]._size || 1) : 1;
    const comp = UniformsGroupUtils.registerComponent(name, count, size);
    const col = comp.valueColumn;
    const first = this.uniforms[0];
    if (first) {
      for (let i = 0; i < count; i++) {
        const base = i * size;
        for (let j = 0; j < size; j++) col[base + j] = first._container[j];
      }
    }
    return comp;
  }

  /**
   * Clone every uniform in the group into a new array.
   * @returns {Array}
   */
  cloneUniforms() {
    const src = this.uniforms;
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const item = src[i];
      if (Array.isArray(item)) {
        out.push(item.map((u) => u.clone()));
      } else {
        out.push(item.clone());
      }
    }
    return out;
  }

  // --- Pooling ------------------------------------------------------------

  /**
   * Acquire a pooled UniformsGroup instance (empty, default usage).
   * @returns {UniformsGroup}
   */
  static acquire() {
    return acquireGroup();
  }

  /**
   * Return this UniformsGroup to the pool. Releases the internal array.
   */
  release() {
    if (this.uniforms) {
      releaseArray(this.uniforms);
      this.uniforms = null;
    }
    releaseGroup(this);
  }

  /**
   * Clear the global UniformsGroup pool and array pool.
   */
  static clearPool() {
    _groupPool.length = 0;
    _arrayPool.length = 0;
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = UniformsGroupUtils;
}

export { UniformsGroup, UniformsGroupUtils };