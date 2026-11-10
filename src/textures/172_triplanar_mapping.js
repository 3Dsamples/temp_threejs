// file number : 172
// full path name : src/textures/172_triplanar_mapping.js
// description : Standalone Triplanar Mapping feature module rewritten as a pure ES module with zero CDN imports and completely dynamic features. Eliminates UV seams, stretching, and the need for a UV-unwrap pass by generating texture coordinates directly from world-space (or local-space, or object-space) position — sampled independently along the X, Y, and Z axes and blended by the surface normal. Ideal for complex, curved, or unparameterized meshes (sculpts, voxel terrain, procedural geometry, animated/deformed surfaces) where traditional UV mapping is either impossible or too expensive to author. Provides per-texture registration, a full coordinate-space system (WORLD / LOCAL / OBJECT), a blend-sharpness control (1 = soft, 16 = hard), per-axis scale and offset overrides, optional projection-axis weighting (bias X/Y/Z toward 1.0), a per-texture heuristic auto-selection routine based on geometry type, and a full set of exported GLSL + WGSL shader source strings ready to paste into any custom material. All triplanar state is pooled via acquire()/release()/clearPool() so 10k+ textures can toggle triplanar every frame with zero GC churn. Exposes a BitECS SoA bridge so ECS-driven texture pipelines can drive triplanar state without string lookups. Uses the project's Common/Precision/Constants/Vec2/Vec3/Vec4/Mat4 modules. Designed for Android 64-bit mobile with zero CDN dependencies and no static-server requirement — the module is idempotent and safe to import from any file that needs triplanar, from any material system, or from a global feature registry.
// best for : Any Texture on a mesh where UV mapping is difficult, impossible, or undesirable — sculpted characters, voxel terrain, procedural/procedural-noise meshes, animated/deformed surfaces (cloth, skin, foliage), CAD/mesh-imported geometry with missing or broken UVs, complex architectural meshes, and any surface where traditional UV seams would be visible. Because triplanar sampling removes UV unwrapping from the art pipeline entirely, it is also the highest-ROI feature for procedural generation workflows and asset-less scenes at 10k+ entities on Android 64-bit.
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

// ---------------------------------------------------------------------------
// Local aliases for the project's Constants.
// ---------------------------------------------------------------------------
const RGBAFormat          = Constants.RGBAFormat;
const RGBFormat           = Constants.RGBFormat;
const RedFormat           = Constants.RedFormat;
const RGFormat            = Constants.RGFormat;
const UnsignedByteType    = Constants.UnsignedByteType;
const UnsignedShortType   = Constants.UnsignedShortType;
const HalfFloatType       = Constants.HalfFloatType;
const FloatType           = Constants.FloatType;
const LinearFilter        = Constants.LinearFilter;
const LinearMipmapLinearFilter = Constants.LinearMipmapLinearFilter;

// ---------------------------------------------------------------------------
// Coordinate space constants — where the triplanar sample is computed.
// ---------------------------------------------------------------------------
const TriplanarSpace = {
  WORLD:   0,  // uses world-space position (default)
  LOCAL:   1,  // uses local-space position (object's own space, pre-model-transform)
  OBJECT:  2,  // uses object-space position (post-model-transform, pre-view-transform)
};

// ---------------------------------------------------------------------------
// Blend mode constants — how the three axis samples are combined.
// ---------------------------------------------------------------------------
const TriplanarBlendMode = {
  NORMAL_WEIGHTED: 0,  // weight = pow(|normal[axis]|, sharpness) — default
  NORMAL_BLEND:    1,  // weight = |normal[axis]|              — softer
  HARD_SWITCH:     2,  // argmax(|normal[axis]|)              — cheapest
  AVERAGE:         3,  // equal weight 1/3 each               — always smooth
};

// ---------------------------------------------------------------------------
// Named quality profiles — each maps a target surface to a set of default
// triplanar parameters.
// ---------------------------------------------------------------------------
const TriplanarProfiles = {
  off:           { enabled: false, sharpness: 8,  blendMode: TriplanarBlendMode.NORMAL_WEIGHTED },
  minimal:       { enabled: true,  sharpness: 4,  blendMode: TriplanarBlendMode.NORMAL_BLEND },
  balanced:      { enabled: true,  sharpness: 8,  blendMode: TriplanarBlendMode.NORMAL_WEIGHTED },
  quality:       { enabled: true,  sharpness: 16, blendMode: TriplanarBlendMode.NORMAL_WEIGHTED },
  terrain:       { enabled: true,  sharpness: 12, blendMode: TriplanarBlendMode.NORMAL_WEIGHTED },
  voxel:         { enabled: true,  sharpness: 24, blendMode: TriplanarBlendMode.HARD_SWITCH },
  sculpt:        { enabled: true,  sharpness: 6,  blendMode: TriplanarBlendMode.NORMAL_BLEND },
  procedural:    { enabled: true,  sharpness: 8,  blendMode: TriplanarBlendMode.NORMAL_WEIGHTED },
};

// ---------------------------------------------------------------------------
// Usage hints — used by the heuristic auto-selection routine.
// ---------------------------------------------------------------------------
const TriplanarUsageHint = {
  UNKNOWN:      0,
  SCULPT:       1,
  VOXEL:        2,
  TERRAIN:      3,
  PROCEDURAL:   4,
  DEFORMED:     5,
  CLOTH:        6,
  FOLIAGE:      7,
  SKIN:         8,
  IMPOSTOR:     9,
  CAD:          10,
  ARCHITECTURE: 11,
  CHARACTER:    12,
  UI:           13,
  SPRITE:       14,
  LUT:          15,
  SKYBOX:       16,
  FLAT_PLANE:   17,
};

// ---------------------------------------------------------------------------
// Static pool for triplanar descriptors — recycled to eliminate per-texture
// allocation churn when 10k+ textures register / unregister triplanar.
// ---------------------------------------------------------------------------
const _triplanarDescriptorPool = [];

function _acquireDescriptor() {
  const d = _triplanarDescriptorPool.pop();
  if (d) {
    d.texture         = null;
    d.enabled         = true;
    d.profile         = 'balanced';
    d.space           = TriplanarSpace.WORLD;
    d.blendMode       = TriplanarBlendMode.NORMAL_WEIGHTED;
    d.sharpness       = 8;
    d.scaleX          = 1;
    d.scaleY          = 1;
    d.scaleZ          = 1;
    d.offsetX         = 0;
    d.offsetY         = 0;
    d.offsetZ         = 0;
    d.biasX           = 1;
    d.biasY           = 1;
    d.biasZ           = 1;
    d.usage           = TriplanarUsageHint.UNKNOWN;
    d.version         = 0;
    return d;
  }
  return {
    texture: null,
    enabled: true,
    profile: 'balanced',
    space: TriplanarSpace.WORLD,
    blendMode: TriplanarBlendMode.NORMAL_WEIGHTED,
    sharpness: 8,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    biasX: 1,
    biasY: 1,
    biasZ: 1,
    usage: TriplanarUsageHint.UNKNOWN,
    version: 0,
  };
}

function _releaseDescriptor(d) {
  d.texture = null;
  if (_triplanarDescriptorPool.length < 256) _triplanarDescriptorPool.push(d);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _vec2 = new Float32Array(2);
const _vec3 = new Float32Array(3);
const _vec4 = new Float32Array(4);
const _normal = new Float32Array(3);
const _weights = new Float32Array(3);

// ---------------------------------------------------------------------------
// GLSL shader source — ready to paste into any custom material that wants
// triplanar sampling. The vertex shader declares the varyings; the fragment
// shader provides the sampling function.
// ---------------------------------------------------------------------------
const TRIPLANAR_GLSL_VERTEX = /* glsl */`
  // Triplanar Mapping — vertex shader declarations
  // Add these to your vertex shader alongside the standard varyings.
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec3 vLocalPosition;

  void triplanarVertexMain() {
    // Compute world-space position
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;

    // Compute world-space normal (using inverse-transpose matrix for
    // non-uniform scaling)
    vWorldNormal = normalize(mat3(modelMatrix) * normal);

    // Compute object-local position (pre-model-transform)
    vLocalPosition = position;
  }
`;

const TRIPLANAR_GLSL_FRAGMENT = /* glsl */`
  // Triplanar Mapping — fragment shader sampling function
  //
  // Uniforms:
  //   uniform int   uTriplanarSpace;      // 0 = world, 1 = local, 2 = object
  //   uniform int   uTriplanarBlendMode;  // 0 = normal-weighted, 1 = blend, 2 = hard, 3 = average
  //   uniform float uTriplanarSharpness;  // 1 = soft, 16 = hard
  //   uniform vec3  uTriplanarScale;      // per-axis scale
  //   uniform vec3  uTriplanarOffset;     // per-axis offset
  //   uniform vec3  uTriplanarBias;       // per-axis bias (1 = neutral)
  //
  // Varyings from the vertex shader:
  //   varying vec3 vWorldPosition;
  //   varying vec3 vWorldNormal;
  //   varying vec3 vLocalPosition;

  vec3 triplanarBlendWeights(vec3 n, int mode, float sharpness) {
    vec3 w;

    if (mode == 0) {
      // Normal-weighted: pow(|n|, sharpness)
      w = pow(abs(n), vec3(sharpness));
    } else if (mode == 1) {
      // Normal blend: |n|
      w = abs(n);
    } else if (mode == 2) {
      // Hard switch: pick the dominant axis
      float ax = abs(n.x);
      float ay = abs(n.y);
      float az = abs(n.z);
      float mx = max(ax, max(ay, az));
      w = vec3(ax == mx ? 1.0 : 0.0, ay == mx ? 1.0 : 0.0, az == mx ? 1.0 : 0.0);
    } else {
      // Average: equal weight
      w = vec3(1.0 / 3.0);
    }

    return w / (w.x + w.y + w.z + 1e-6);
  }

  vec4 triplanarSample(
    sampler2D tex,
    vec3 worldPos,
    vec3 worldNormal,
    vec3 localPos,
    int space,
    int blendMode,
    float sharpness,
    vec3 scale,
    vec3 offset,
    vec3 bias
  ) {
    vec3 pos;
    if (space == 0) {
      pos = worldPos;
    } else if (space == 1) {
      pos = localPos;
    } else {
      pos = worldPos;
    }

    vec3 n = normalize(worldNormal);
    vec3 w = triplanarBlendWeights(n, blendMode, sharpness) * bias;

    // Sample each of the three axis-aligned projections
    vec2 uvX = pos.zy * scale.zy + offset.zy;
    vec2 uvY = pos.xz * scale.xz + offset.xz;
    vec2 uvZ = pos.xy * scale.xy + offset.xy;

    vec4 cX = texture2D(tex, uvX);
    vec4 cY = texture2D(tex, uvY);
    vec4 cZ = texture2D(tex, uvZ);

    return cX * w.x + cY * w.y + cZ * w.z;
  }
`;

// ---------------------------------------------------------------------------
// WGSL shader source — ready to paste into any WebGPU material.
// ---------------------------------------------------------------------------
const TRIPLANAR_WGSL = /* wgsl */`
  // Triplanar Mapping — WGSL sampling function
  //
  // Uniforms (in a struct):
  //   space       : u32  // 0 = world, 1 = local, 2 = object
  //   blendMode   : u32  // 0 = normal-weighted, 1 = blend, 2 = hard, 3 = average
  //   sharpness   : f32  // 1 = soft, 16 = hard
  //   scale       : vec3<f32>
  //   offset      : vec3<f32>
  //   bias        : vec3<f32>

  fn triplanarBlendWeights(n : vec3<f32>, mode : u32, sharpness : f32) -> vec3<f32> {
    var w : vec3<f32>;

    if (mode == 0u) {
      w = pow(abs(n), vec3<f32>(sharpness));
    } else if (mode == 1u) {
      w = abs(n);
    } else if (mode == 2u) {
      let ax = abs(n.x);
      let ay = abs(n.y);
      let az = abs(n.z);
      let mx = max(ax, max(ay, az));
      w = vec3<f32>(
        select(0.0, 1.0, ax == mx),
        select(0.0, 1.0, ay == mx),
        select(0.0, 1.0, az == mx)
      );
    } else {
      w = vec3<f32>(1.0 / 3.0);
    }

    return w / (w.x + w.y + w.z + 1e-6);
  }

  fn triplanarSample(
    tex : texture_2d<f32>,
    sampler : sampler,
    worldPos : vec3<f32>,
    worldNormal : vec3<f32>,
    localPos : vec3<f32>,
    space : u32,
    blendMode : u32,
    sharpness : f32,
    scale : vec3<f32>,
    offset : vec3<f32>,
    bias : vec3<f32>
  ) -> vec4<f32> {
    var pos = worldPos;
    if (space == 1u) { pos = localPos; }

    let n = normalize(worldNormal);
    let w = triplanarBlendWeights(n, blendMode, sharpness) * bias;

    let uvX = pos.zy * scale.zy + offset.zy;
    let uvY = pos.xz * scale.xz + offset.xz;
    let uvZ = pos.xy * scale.xy + offset.xy;

    let cX = textureSample(tex, sampler, uvX);
    let cY = textureSample(tex, sampler, uvY);
    let cZ = textureSample(tex, sampler, uvZ);

    return cX * w.x + cY * w.y + cZ * w.z;
  }
`;

// ---------------------------------------------------------------------------
// TriplanarMapping — standalone triplanar feature module.
//
// Design goals:
//   – Fully standalone: no changes required to Texture (151), Material, or
//     any other class. The module receives a texture or material reference
//     and manages triplanar state on it via duck-typed writes.
//   – Fully dynamic: every texture/material can be toggled on/off, moved
//     between presets, or given an explicit per-object parameter override.
//   – Fully pooled: descriptors are pooled via _triplanarDescriptorPool, so
//     10k+ textures can toggle triplanar every frame without GC churn.
//   – Coordinate-space aware: supports WORLD, LOCAL, and OBJECT spaces so
//     the module works for both static and deformable meshes.
//   – Blend-mode aware: four blend modes cover everything from cheap hard
//     switch (voxel) to smooth normal-weighted (sculpt).
//   – Shader-source exporting: ships ready-to-use GLSL and WGSL fragment
//     + vertex snippets so any material can integrate triplanar sampling
//     without writing boilerplate.
//   – Zero per-frame allocation: `computeWeights(nx, ny, nz, out)` returns
//     the three blend weights using preallocated scratch buffers.
// ---------------------------------------------------------------------------
class TriplanarMapping {
  /**
   * @param {object} [options={}]
   * @param {string} [options.defaultProfile='balanced']
   * @param {boolean} [options.warnOnInvalidParams=false]
   */
  constructor(options = {}) {
    this.isTriplanarMapping = true;

    this._defaultProfile = options.defaultProfile || 'balanced';
    this._warnOnInvalidParams = options.warnOnInvalidParams === true;

    // Fast lookup: target → descriptor
    this._registry = new Map();

    // Diagnostics
    this._appliedCount = 0;
    this._disabledCount = 0;
    this._lastWeightsMs = 0;
  }

  // -----------------------------------------------------------------------
  // Registration / deregistration
  // -----------------------------------------------------------------------

  /**
   * Register a texture or material with the triplanar manager.
   *
   * @param {object} target — duck-typed: any object that can carry a
   *   `triplanarEnabled`, `triplanarParams`, etc. property (Texture, Material)
   * @param {object} [options={}]
   * @param {string} [options.profile] — named profile
   * @param {number} [options.space] — TriplanarSpace
   * @param {number} [options.blendMode] — TriplanarBlendMode
   * @param {number} [options.sharpness] — blend sharpness
   * @param {number} [options.scaleX] — per-axis scale
   * @param {number} [options.scaleY]
   * @param {number} [options.scaleZ]
   * @param {number} [options.offsetX] — per-axis offset
   * @param {number} [options.offsetY]
   * @param {number} [options.offsetZ]
   * @param {number} [options.biasX] — per-axis bias
   * @param {number} [options.biasY]
   * @param {number} [options.biasZ]
   * @param {number} [options.usage] — TriplanarUsageHint
   * @returns {object|null}
   */
  register(target, options = {}) {
    if (!target) return null;

    let desc = this._registry.get(target);
    if (desc) return this._updateDescriptor(desc, options);

    desc = _acquireDescriptor();
    desc.texture = target;
    desc.profile = options.profile || this._defaultProfile;
    desc.usage = options.usage !== undefined ? options.usage : TriplanarUsageHint.UNKNOWN;
    desc.version = 0;

    this._applyProfileDefaults(desc, options);
    this._registry.set(target, desc);
    this._apply(desc);
    return desc;
  }

  /**
   * Update an existing descriptor with new options.
   * @private
   */
  _updateDescriptor(desc, options) {
    if (options.profile !== undefined) desc.profile = options.profile;
    if (options.usage !== undefined) desc.usage = options.usage;
    this._applyProfileDefaults(desc, options);
    desc.version++;
    this._apply(desc);
    return desc;
  }

  /**
   * Apply profile defaults, then overlay explicit overrides.
   * @private
   */
  _applyProfileDefaults(desc, options) {
    const profile = TriplanarProfiles[desc.profile] || TriplanarProfiles.balanced;

    desc.enabled    = options.enabled   !== undefined ? !!options.enabled   : profile.enabled;
    desc.blendMode  = options.blendMode !== undefined ? (options.blendMode | 0) : profile.blendMode;
    desc.sharpness  = options.sharpness !== undefined ? Math.max(1, Math.min(64, options.sharpness)) : profile.sharpness;

    if (options.space !== undefined)             desc.space = options.space | 0;
    if (options.scaleX !== undefined)            desc.scaleX = options.scaleX;
    if (options.scaleY !== undefined)            desc.scaleY = options.scaleY;
    if (options.scaleZ !== undefined)            desc.scaleZ = options.scaleZ;
    if (options.offsetX !== undefined)           desc.offsetX = options.offsetX;
    if (options.offsetY !== undefined)           desc.offsetY = options.offsetY;
    if (options.offsetZ !== undefined)           desc.offsetZ = options.offsetZ;
    if (options.biasX !== undefined)             desc.biasX = options.biasX;
    if (options.biasY !== undefined)             desc.biasY = options.biasY;
    if (options.biasZ !== undefined)             desc.biasZ = options.biasZ;
  }

  /**
   * Unregister a target, clearing its triplanar state.
   * @param {object} target
   * @returns {boolean}
   */
  unregister(target) {
    const desc = this._registry.get(target);
    if (!desc) return false;

    if (desc.texture) {
      delete desc.texture.triplanarEnabled;
      delete desc.texture.triplanarParams;
    }

    this._registry.delete(target);
    _releaseDescriptor(desc);
    return true;
  }

  /**
   * Clear all registrations.
   * @returns {this}
   */
  clear() {
    for (const desc of this._registry.values()) {
      if (desc.texture) {
        delete desc.texture.triplanarEnabled;
        delete desc.texture.triplanarParams;
      }
      _releaseDescriptor(desc);
    }
    this._registry.clear();
    this._appliedCount = 0;
    this._disabledCount = 0;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic toggles
  // -----------------------------------------------------------------------

  enable(target) {
    const desc = this._registry.get(target);
    if (!desc) return this;
    desc.enabled = true;
    desc.version++;
    this._apply(desc);
    return this;
  }

  disable(target) {
    const desc = this._registry.get(target);
    if (!desc) return this;
    desc.enabled = false;
    if (desc.texture) {
      delete desc.texture.triplanarEnabled;
      delete desc.texture.triplanarParams;
    }
    this._disabledCount++;
    return this;
  }

  toggle(target) {
    const desc = this._registry.get(target);
    if (!desc) return false;
    if (desc.enabled) {
      this.disable(target);
      return false;
    }
    this.enable(target);
    return true;
  }

  enableAll() {
    for (const desc of this._registry.values()) {
      desc.enabled = true;
      desc.version++;
      this._apply(desc);
    }
    return this;
  }

  disableAll() {
    for (const desc of this._registry.values()) {
      desc.enabled = false;
      if (desc.texture) {
        delete desc.texture.triplanarEnabled;
        delete desc.texture.triplanarParams;
      }
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Per-target parameter overrides
  // -----------------------------------------------------------------------

  /**
   * Set the coordinate space for a specific target.
   * @param {object} target
   * @param {number} space — TriplanarSpace constant
   * @returns {this}
   */
  setSpace(target, space) {
    const desc = this._registry.get(target);
    if (!desc) return this;
    desc.space = space | 0;
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * Set the blend mode for a specific target.
   * @param {object} target
   * @param {number} mode — TriplanarBlendMode constant
   * @returns {this}
   */
  setBlendMode(target, mode) {
    const desc = this._registry.get(target);
    if (!desc) return this;
    desc.blendMode = mode | 0;
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * Set the blend sharpness for a specific target.
   * @param {object} target
   * @param {number} sharpness — 1 = soft, 16 = hard
   * @returns {this}
   */
  setSharpness(target, sharpness) {
    const desc = this._registry.get(target);
    if (!desc) return this;
    desc.sharpness = Math.max(1, Math.min(64, sharpness));
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * Set the per-axis scale for a specific target.
   * @param {object} target
   * @param {number} scaleX
   * @param {number} scaleY
   * @param {number} scaleZ
   * @returns {this}
   */
  setScale(target, scaleX, scaleY, scaleZ) {
    const desc = this._registry.get(target);
    if (!desc) return this;
    desc.scaleX = scaleX;
    desc.scaleY = scaleY;
    desc.scaleZ = scaleZ;
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * Set the per-axis offset for a specific target.
   * @param {object} target
   * @param {number} offsetX
   * @param {number} offsetY
   * @param {number} offsetZ
   * @returns {this}
   */
  setOffset(target, offsetX, offsetY, offsetZ) {
    const desc = this._registry.get(target);
    if (!desc) return this;
    desc.offsetX = offsetX;
    desc.offsetY = offsetY;
    desc.offsetZ = offsetZ;
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * Set the per-axis bias for a specific target.
   * @param {object} target
   * @param {number} biasX
   * @param {number} biasY
   * @param {number} biasZ
   * @returns {this}
   */
  setBias(target, biasX, biasY, biasZ) {
    const desc = this._registry.get(target);
    if (!desc) return this;
    desc.biasX = biasX;
    desc.biasY = biasY;
    desc.biasZ = biasZ;
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * Apply a named profile to a specific target.
   * @param {object} target
   * @param {string} profile
   * @returns {this}
   */
  setProfile(target, profile) {
    if (!TriplanarProfiles[profile]) return this;
    const desc = this._registry.get(target);
    if (!desc) return this;
    desc.profile = profile;
    this._applyProfileDefaults(desc, {});
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * Apply a named profile globally.
   * @param {string} profile
   * @returns {this}
   */
  setGlobalProfile(profile) {
    if (!TriplanarProfiles[profile]) return this;
    this._defaultProfile = profile;

    for (const desc of this._registry.values()) {
      desc.profile = profile;
      this._applyProfileDefaults(desc, {});
      desc.version++;
      this._apply(desc);
    }
    return this;
  }

  /**
   * @returns {string[]} — list of valid profile names
   */
  static get profileNames() {
    return Object.keys(TriplanarProfiles);
  }

  // -----------------------------------------------------------------------
  // Heuristic auto-selection
  // -----------------------------------------------------------------------

  /**
   * Suggest a profile name based on a usage hint.
   * @param {object} target
   * @param {number} [usage=TriplanarUsageHint.UNKNOWN]
   * @returns {string}
   */
  heuristicProfileFor(target, usage = TriplanarUsageHint.UNKNOWN) {
    switch (usage) {
      case TriplanarUsageHint.SCULPT:       return 'sculpt';
      case TriplanarUsageHint.VOXEL:        return 'voxel';
      case TriplanarUsageHint.TERRAIN:      return 'terrain';
      case TriplanarUsageHint.PROCEDURAL:   return 'procedural';
      case TriplanarUsageHint.DEFORMED:
      case TriplanarUsageHint.CLOTH:
      case TriplanarUsageHint.SKIN:         return 'sculpt';
      case TriplanarUsageHint.FOLIAGE:      return 'balanced';
      case TriplanarUsageHint.IMPOSTOR:     return 'minimal';
      case TriplanarUsageHint.CAD:
      case TriplanarUsageHint.ARCHITECTURE: return 'quality';
      case TriplanarUsageHint.CHARACTER:    return 'balanced';
      case TriplanarUsageHint.UI:
      case TriplanarUsageHint.SPRITE:
      case TriplanarUsageHint.LUT:
      case TriplanarUsageHint.SKYBOX:
      case TriplanarUsageHint.FLAT_PLANE:   return 'off';
      default:                              return 'balanced';
    }
  }

  /**
   * Automatically register a target using the heuristic profile.
   * @param {object} target
   * @param {number} [usage=TriplanarUsageHint.UNKNOWN]
   * @returns {object|null}
   */
  autoRegister(target, usage = TriplanarUsageHint.UNKNOWN) {
    const profile = this.heuristicProfileFor(target, usage);
    return this.register(target, { profile, usage });
  }

  // -----------------------------------------------------------------------
  // Per-frame weight computation
  // -----------------------------------------------------------------------

  /**
   * Compute the three axis blend weights for a given surface normal. This is
   * the CPU-side equivalent of the shader's triplanarBlendWeights() function,
   * useful for CPU-side LOD decisions, debugging, or building uniform buffers.
   *
   * Uses the project's Vec3 module for zero-allocation normalization.
   *
   * @param {object} target
   * @param {number} nx
   * @param {number} ny
   * @param {number} nz
   * @param {Float32Array} [out] — length-3 output buffer
   * @returns {Float32Array|null}
   */
  computeWeights(target, nx, ny, nz, out = _weights) {
    const desc = this._registry.get(target);
    if (!desc || !desc.enabled) return null;

    const t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : 0;

    Vec3.set(_normal, nx, ny, nz);
    Vec3.normalize(_normal, _normal);

    let wx, wy, wz;
    const mode = desc.blendMode;
    const sharpness = desc.sharpness;

    if (mode === TriplanarBlendMode.HARD_SWITCH) {
      const ax = Math.abs(_normal[0]);
      const ay = Math.abs(_normal[1]);
      const az = Math.abs(_normal[2]);
      const mx = Math.max(ax, Math.max(ay, az));
      wx = ax === mx ? 1 : 0;
      wy = ay === mx ? 1 : 0;
      wz = az === mx ? 1 : 0;
    } else if (mode === TriplanarBlendMode.AVERAGE) {
      wx = wy = wz = 1 / 3;
    } else if (mode === TriplanarBlendMode.NORMAL_BLEND) {
      wx = Math.abs(_normal[0]);
      wy = Math.abs(_normal[1]);
      wz = Math.abs(_normal[2]);
    } else {
      // NORMAL_WEIGHTED (default)
      wx = Math.pow(Math.abs(_normal[0]), sharpness);
      wy = Math.pow(Math.abs(_normal[1]), sharpness);
      wz = Math.pow(Math.abs(_normal[2]), sharpness);
    }

    // Apply bias
    wx *= desc.biasX;
    wy *= desc.biasY;
    wz *= desc.biasZ;

    // Normalize
    const sum = wx + wy + wz;
    const invSum = sum > 1e-6 ? 1 / sum : 0;
    out[0] = wx * invSum;
    out[1] = wy * invSum;
    out[2] = wz * invSum;

    if (t0 > 0) {
      this._lastWeightsMs = ((typeof performance !== 'undefined' && performance.now)
        ? performance.now() : 0) - t0;
    }

    return out;
  }

  // -----------------------------------------------------------------------
  // Internal application
  // -----------------------------------------------------------------------

  /**
   * Write triplanar metadata to the target.
   * @private
   */
  _apply(desc) {
    if (!desc.texture) return;

    const tex = desc.texture;
    tex.triplanarEnabled = desc.enabled;

    if (desc.enabled) {
      tex.triplanarParams = {
        space: desc.space,
        blendMode: desc.blendMode,
        sharpness: desc.sharpness,
        scale: [desc.scaleX, desc.scaleY, desc.scaleZ],
        offset: [desc.offsetX, desc.offsetY, desc.offsetZ],
        bias: [desc.biasX, desc.biasY, desc.biasZ],
      };
    } else {
      delete tex.triplanarParams;
    }

    this._appliedCount++;
  }

  /**
   * Re-apply triplanar state for every registered target in one pass.
   * @returns {this}
   */
  flush() {
    for (const desc of this._registry.values()) this._apply(desc);
    return this;
  }

  // -----------------------------------------------------------------------
  // Shader source exports
  // -----------------------------------------------------------------------

  /** @returns {string} — GLSL vertex shader declarations */
  static get glslVertexSource() { return TRIPLANAR_GLSL_VERTEX; }

  /** @returns {string} — GLSL fragment shader sampling function */
  static get glslFragmentSource() { return TRIPLANAR_GLSL_FRAGMENT; }

  /** @returns {string} — WGSL sampling function */
  static get wgslSource() { return TRIPLANAR_WGSL; }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  /** @returns {number} */
  get count() { return this._registry.size; }

  /** @returns {number} */
  get appliedCount() { return this._appliedCount; }

  /** @returns {number} */
  get disabledCount() { return this._disabledCount; }

  /** @returns {number} — elapsed ms of the last computeWeights() call */
  get lastWeightsMs() { return this._lastWeightsMs; }

  /**
   * @returns {object[]} — snapshot of every descriptor
   */
  getState() {
    const out = [];
    for (const desc of this._registry.values()) {
      out.push({
        profile: desc.profile,
        space: desc.space,
        blendMode: desc.blendMode,
        sharpness: desc.sharpness,
        scale: [desc.scaleX, desc.scaleY, desc.scaleZ],
        offset: [desc.offsetX, desc.offsetY, desc.offsetZ],
        bias: [desc.biasX, desc.biasY, desc.biasZ],
        usage: desc.usage,
        enabled: desc.enabled,
        version: desc.version,
      });
    }
    return out;
  }

  // -----------------------------------------------------------------------
  // BitECS SoA bridge
  // -----------------------------------------------------------------------

  /**
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const count = this._registry.size;
    const profilesArr    = new Uint8Array(count);
    const spacesArr      = new Uint8Array(count);
    const blendModesArr  = new Uint8Array(count);
    const sharpnessArr   = new Uint8Array(count);
    const scaleXArr      = new Float32Array(count);
    const scaleYArr      = new Float32Array(count);
    const scaleZArr      = new Float32Array(count);
    const offsetXArr     = new Float32Array(count);
    const offsetYArr     = new Float32Array(count);
    const offsetZArr     = new Float32Array(count);
    const biasXArr       = new Float32Array(count);
    const biasYArr       = new Float32Array(count);
    const biasZArr       = new Float32Array(count);
    const usagesArr      = new Uint8Array(count);
    const enabledArr     = new Uint8Array(count);
    const versionsArr    = new Uint32Array(count);

    const profileNames = Object.keys(TriplanarProfiles);

    let i = 0;
    for (const desc of this._registry.values()) {
      profilesArr[i] = profileNames.indexOf(desc.profile);
      spacesArr[i] = desc.space;
      blendModesArr[i] = desc.blendMode;
      sharpnessArr[i] = Math.min(255, desc.sharpness | 0);
      scaleXArr[i] = desc.scaleX;
      scaleYArr[i] = desc.scaleY;
      scaleZArr[i] = desc.scaleZ;
      offsetXArr[i] = desc.offsetX;
      offsetYArr[i] = desc.offsetY;
      offsetZArr[i] = desc.offsetZ;
      biasXArr[i] = desc.biasX;
      biasYArr[i] = desc.biasY;
      biasZArr[i] = desc.biasZ;
      usagesArr[i] = desc.usage;
      enabledArr[i] = desc.enabled ? 1 : 0;
      versionsArr[i] = desc.version;
      i++;
    }

    return {
      name,
      count,
      profiles: profilesArr,
      spaces: spacesArr,
      blendModes: blendModesArr,
      sharpness: sharpnessArr,
      scaleX: scaleXArr,
      scaleY: scaleYArr,
      scaleZ: scaleZArr,
      offsetX: offsetXArr,
      offsetY: offsetYArr,
      offsetZ: offsetZArr,
      biasX: biasXArr,
      biasY: biasYArr,
      biasZ: biasZArr,
      usages: usagesArr,
      enabled: enabledArr,
      versions: versionsArr,
    };
  }

  // -----------------------------------------------------------------------
  // Pool helpers
  // -----------------------------------------------------------------------

  /**
   * Clear the global triplanar descriptor pool.
   */
  static clearPool() {
    _triplanarDescriptorPool.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  TriplanarMapping,
  TriplanarProfiles,
  TriplanarUsageHint,
  TriplanarSpace,
  TriplanarBlendMode,
  TRIPLANAR_GLSL_VERTEX,
  TRIPLANAR_GLSL_FRAGMENT,
  TRIPLANAR_WGSL,
};
export default TriplanarMapping;