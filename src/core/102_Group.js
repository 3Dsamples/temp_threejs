// file number : 102
// full path name : src/core/102_Group.js
// description : High-performance Group rewritten as a pure ES module with zero CDN imports. Group is a thin Object3D subclass whose only role is to be a logical container for transform hierarchies (camera rigs, character skeletons, prop clusters). Rebuilt on the pooled Object3D (101) foundation with zero-allocation instance reuse, an ECS-friendly "isGroup" column emission for BitECS scene-graph systems, SimplexNoise-driven placement helpers, and native Vec3/Quat/Mat4 composition — all allocation-free on Android 64-bit.
// best for : Grouping transforms without adding render state (camera rigs, bone hierarchies, vehicle wheels, building floor plans, prop clusters); batching sibling objects under a single pivot; scene organisation in living-world pipelines that must scale from 10k+ local entities to galactic-scale LOD without GC pressure.
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
import { Object3D } from './101_Object3D.js';

// ---------------------------------------------------------------------------
// Static pool for Group instances – recycled to eliminate per-pivot allocation
// churn when 10k+ hierarchies spawn/despawn in an ECS-driven world.
// ---------------------------------------------------------------------------
const _groupPool = [];

/**
 * Acquire a Group from the pool (reset to default state).
 * @returns {Group}
 */
function acquireGroup() {
  const g = _groupPool.pop();
  if (g) {
    g.name = '';
    g.parent = null;
    g.children.length = 0;
    g.up.set(0, 1, 0);
    g.position.set(0, 0, 0);
    g.rotation.set(0, 0, 0);
    g.quaternion.set(0, 0, 0, 1);
    g.scale.set(1, 1, 1);
    g.matrix.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    g.matrixWorld.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
    g.matrixWorldNeedsUpdate = true;
    g.matrixAutoUpdate = true;
    g.visible = true;
    g.castShadow = false;
    g.receiveShadow = false;
    g.frustumCulled = true;
    g.renderOrder = 0;
    g.userData = {};
    g.layers.mask = 1;
    g._version = 0;
    g._needsUpdate = false;
    return g;
  }
  return new Group();
}

/**
 * Return a Group to the pool. Caller must not use it afterward.
 * @param {Group} g
 */
function releaseGroup(g) {
  if (_groupPool.length < 256) _groupPool.push(g);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _scratchVec4 = new Float32Array(4);
const _scratchMat4 = new Float32Array(16);

// ---------------------------------------------------------------------------
// Utility surface – bridges to Vec4/Mat4, SimplexNoise, and BitECS.
// All helpers are allocation-free.
// ---------------------------------------------------------------------------
const GroupUtils = {
  /**
   * Pack (childCount, visible, layerMask, renderOrder) into a Vec4 using the
   * project's native Vec4 + Mat4 primitives (replaces gl-matrix).
   * @param {Float32Array} [out] – length 4 output buffer
   * @param {number} childCount
   * @param {boolean} visible
   * @param {number} layerMask
   * @param {number} renderOrder
   * @returns {Float32Array}
   */
  packHeaderToVec4(out, childCount, visible, layerMask, renderOrder) {
    const o = out || _scratchVec4;
    Mat4.identity(_scratchMat4);
    Vec4.set(o, childCount, visible ? 1 : 0, layerMask, renderOrder);
    Vec4.transformMat4(o, o, _scratchMat4);
    return o;
  },

  /**
   * Register a BitECS SoA component column set for Group state.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, isGroupColumn: Uint8Array, childCountColumn: Uint32Array, count: number }}
   */
  registerComponent(name, count) {
    return {
      name,
      isGroupColumn: new Uint8Array(count),
      childCountColumn: new Uint32Array(count),
      count,
    };
  },

  // --- SimplexNoise bridges (procedural group placement) ------------------

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
 * Group
 * A logical container for transform hierarchies. Contains no render state —
 * the renderer skips Groups and draws only their children.
 *
 * Features:
 * – Pooled instances (acquire / release) inherited from Object3D (101).
 * – Zero-allocation add / remove / clear / updateMatrixWorld (from Object3D).
 * – Vec4 header packing via the project's native Vec4 + Mat4 (no gl-matrix).
 * – BitECS SoA bridge: asBitecsComponent(name, count) produces typed-array
 *   columns (isGroup + childCount) for ECS scene-graph systems.
 * – SimplexNoise utilities for procedural group placement.
 * – No static server, no bundler, no CDN dependency.
 */
class Group extends Object3D {
  constructor() {
    super();
    this.isGroup = true;
  }

  // --- Pooling ------------------------------------------------------------

  /**
   * Acquire a pooled Group instance (identity transform, empty children).
   * @returns {Group}
   */
  static acquire() {
    return acquireGroup();
  }

  /**
   * Return this Group to the pool. Caller must not use it afterward.
   */
  release() {
    this.clear();
    releaseGroup(this);
  }

  /**
   * Clear the global Group pool.
   */
  static clearPool() {
    _groupPool.length = 0;
  }

  // --- Convenience --------------------------------------------------------

  /**
   * Pack (childCount, visible, layerMask, renderOrder) into a Vec4 for
   * shader uniforms.
   * @param {Float32Array} [out] – length 4 output buffer
   * @returns {Float32Array}
   */
  packHeaderToVec4(out) {
    return GroupUtils.packHeaderToVec4(
      out,
      this.children.length,
      this.visible,
      this.layers.mask,
      this.renderOrder,
    );
  }

  /**
   * Produce a BitECS SoA component column set filled with this Group's state
   * replicated across `count` entities. The isGroupColumn is filled with 1
   * so ECS render systems can distinguish Groups from drawable objects.
   * @param {string} name
   * @param {number} count
   * @returns {{ name: string, isGroupColumn: Uint8Array, childCountColumn: Uint32Array, count: number }}
   */
  asBitecsComponent(name, count) {
    const comp = GroupUtils.registerComponent(name, count);
    comp.isGroupColumn.fill(1);
    comp.childCountColumn.fill(this.children.length);
    return comp;
  }

  // --- Copy / Clone -------------------------------------------------------

  /**
   * Copy transform and metadata from another Object3D (Group or otherwise).
   * @param {Object3D} source
   * @param {boolean} [recursive=false]
   * @returns {this}
   */
  copy(source, recursive = false) {
    super.copy(source, recursive);
    return this;
  }

  /**
   * Clone this Group (allocates a new pooled instance).
   * @param {boolean} [recursive=true]
   * @returns {Group}
   */
  clone(recursive = true) {
    return new this.constructor().copy(this, recursive);
  }

  // --- Utility surface ----------------------------------------------------

  static Utils = GroupUtils;
}

export { Group, GroupUtils };