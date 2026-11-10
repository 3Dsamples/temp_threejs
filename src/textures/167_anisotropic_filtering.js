// file number : 167
// full path name : src/textures/167_anisotropic_filtering.js
// description : Standalone Anisotropic Filtering (AF) feature module rewritten as a pure ES module with zero CDN imports and completely dynamic features. Provides a fully self-contained manager that applies anisotropic filtering to any Texture-like object without modifying the base Texture class. Solves the single biggest quality gap for ground planes, roads, floors, and any surface viewed at shallow grazing angles — where standard trilinear mipmapping collapses to a blurry over-blurred result. Manages anisotropy levels (1×–16×) with graceful platform fallback via EXT_texture_filter_anisotropic detection, exposes named quality profiles (performance, balanced, quality, cinematic) and per-texture overrides, and includes a heuristic auto-selection routine based on texture type, size, and expected usage. All AF state is pooled via acquire()/release()/clearPool() to eliminate per-texture allocation churn at 10k+ textures. Exposes a BitECS SoA bridge so ECS-driven texture systems can drive AF state without string lookups. Uses the project's Common/Precision/Constants/Vec2 modules. Designed for Android 64-bit mobile with zero CDN dependencies and no static-server requirement — the module is idempotent and safe to import from any file that needs AF, from any texture class, or from a global feature registry.
// best for : Any Texture in a scene with large ground planes, roads, terrain, floors, indoor architecture, foliage on the ground, or any surface viewed at shallow angles. Best used globally by the renderer's texture pipeline to apply AF on every texture that supports it, or selectively by materials that need sharp ground detail (e.g. terrain, racing tracks, floor tiles). Because AF is the single biggest quality win for a few bytes of state, it's also the highest-ROI feature for mobile at 10k+ textures on Android 64-bit.
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
const LinearFilter             = Constants.LinearFilter;
const LinearMipmapLinearFilter = Constants.LinearMipmapLinearFilter;
const LinearMipmapNearestFilter = Constants.LinearMipmapNearestFilter;
const NearestFilter            = Constants.NearestFilter;
const NearestMipmapLinearFilter = Constants.NearestMipmapLinearFilter;
const NearestMipmapNearestFilter = Constants.NearestMipmapNearestFilter;

// ---------------------------------------------------------------------------
// Anisotropy constants — spec-allowed levels (must be powers of 2).
// ---------------------------------------------------------------------------
const ANISO_1X  = 1;
const ANISO_2X  = 2;
const ANISO_4X  = 4;
const ANISO_8X  = 8;
const ANISO_16X = 16;

// ---------------------------------------------------------------------------
// Named quality profiles — each maps a target surface usage to a preferred
// AF level and a suggested mip filter.
// ---------------------------------------------------------------------------
const AFProfiles = {
  performance:   { aniso: ANISO_2X,  minFilter: LinearMipmapNearestFilter },
  balanced:      { aniso: ANISO_4X,  minFilter: LinearMipmapLinearFilter },
  quality:       { aniso: ANISO_8X,  minFilter: LinearMipmapLinearFilter },
  cinematic:     { aniso: ANISO_16X, minFilter: LinearMipmapLinearFilter },
  pixelArt:      { aniso: ANISO_1X,  minFilter: NearestFilter },
  retro:         { aniso: ANISO_1X,  minFilter: NearestMipmapLinearFilter },
  retroSmooth:   { aniso: ANISO_2X,  minFilter: NearestMipmapLinearFilter },
};

// ---------------------------------------------------------------------------
// Texture usage hints — used by the heuristic auto-selection routine.
// ---------------------------------------------------------------------------
const UsageHint = {
  UNKNOWN:      0,
  GROUND_PLANE: 1,   // highest AF priority
  TERRAIN:      2,
  FLOOR:        3,
  WALL:         4,
  FOLIAGE:      5,
  CHARACTER:    6,
  UI:           7,   // no AF needed
  SPRITE:       8,   // no AF needed
  ENVIRONMENT:  9,
  SKYBOX:       10,  // no AF needed
  LUT:          11,  // no AF needed
  NORMAL_MAP:   12,
  ROUGHNESS:    13,
  METALLIC:     14,
  AO:           15,
  EMISSIVE:     16,
  DETAIL:       17,
};

// ---------------------------------------------------------------------------
// Static pool for AF descriptors — recycled to eliminate per-texture
// allocation churn when 10k+ textures register / unregister AF.
// ---------------------------------------------------------------------------
const _afDescriptorPool = [];

function _acquireDescriptor() {
  const d = _afDescriptorPool.pop();
  if (d) {
    d.texture       = null;
    d.anisoLevel    = ANISO_1X;
    d.originalMin   = LinearMipmapLinearFilter;
    d.originalAniso = 1;
    d.profile       = 'balanced';
    d.usage         = UsageHint.UNKNOWN;
    d.enabled       = true;
    d.version       = 0;
    return d;
  }
  return {
    texture: null,
    anisoLevel: ANISO_1X,
    originalMin: LinearMipmapLinearFilter,
    originalAniso: 1,
    profile: 'balanced',
    usage: UsageHint.UNKNOWN,
    enabled: true,
    version: 0,
  };
}

function _releaseDescriptor(d) {
  d.texture = null;
  if (_afDescriptorPool.length < 256) _afDescriptorPool.push(d);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _vec2 = new Float32Array(2);
const _vec3 = new Float32Array(3);

// ---------------------------------------------------------------------------
// AnisotropicFiltering — standalone AF feature module.
//
// Design goals:
//   – Fully standalone: no changes required to Texture (151) or any other
//     texture class. The module receives a texture reference and manages
//     anisotropy on it via duck-typed property writes.
//   – Fully dynamic: every texture can be toggled on/off at runtime, moved
//     between quality profiles, or given an explicit per-texture level.
//   – Fully pooled: descriptors are pooled via _afDescriptorPool, so 10k+
//     textures can be toggled every frame without GC churn.
//   – Platform-aware: queries EXT_texture_filter_anisotropic once via
//     detectMaxAnisotropy(), caches the result, and clamps all writes to
//     that maximum. On platforms without the extension, all AF is disabled
//     gracefully — no exceptions, no warnings on the hot path.
//   – Heuristic-aware: heuristicLevelFor(texture, usage) suggests an AF
//     level based on texture size, mip chain presence, and usage hint.
// ---------------------------------------------------------------------------
class AnisotropicFiltering {
  /**
   * @param {object} [options={}]
   * @param {number} [options.maxAnisotropy] — override the platform max
   *   (default: auto-detect via gl, or 1 if gl is unavailable)
   * @param {string} [options.defaultProfile='balanced']
   * @param {boolean} [options.warnOnMissingExtension=false]
   */
  constructor(options = {}) {
    this.isAnisotropicFiltering = true;

    this._maxAnisotropy = options.maxAnisotropy !== undefined
      ? Math.max(1, options.maxAnisotropy | 0)
      : 1;

    this._defaultProfile = options.defaultProfile || 'balanced';
    this._warnOnMissingExtension = options.warnOnMissingExtension === true;
    this._warnedOnce = false;

    // Fast lookup: texture → descriptor (Map keyed by object reference)
    this._registry = new Map();

    // Diagnostics
    this._appliedCount = 0;
    this._disabledCount = 0;
    this._lastApplyMs = 0;
  }

  // -----------------------------------------------------------------------
  // Platform capability detection
  // -----------------------------------------------------------------------

  /**
   * Detect the platform's maximum anisotropy by querying the WebGL
   * EXT_texture_filter_anisotropic extension. Caches the result.
   *
   * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
   * @returns {number} — platform max anisotropy (>= 1)
   */
  detectMaxAnisotropy(gl) {
    if (!gl) {
      if (this._warnOnMissingExtension && !this._warnedOnce) {
        this._warnedOnce = true;
        console.warn('[AnisotropicFiltering] No WebGL context supplied — anisotropy disabled.');
      }
      this._maxAnisotropy = 1;
      return 1;
    }

    const ext =
      gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
      gl.getExtension('MOZ_EXT_texture_filter_anisotropic');

    if (!ext) {
      if (this._warnOnMissingExtension && !this._warnedOnce) {
        this._warnedOnce = true;
        console.warn('[AnisotropicFiltering] EXT_texture_filter_anisotropic not available.');
      }
      this._maxAnisotropy = 1;
      return 1;
    }

    // Cache extension handle for later reference
    this._extension = ext;

    this._maxAnisotropy = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
    return this._maxAnisotropy;
  }

  /** @returns {number} — current platform max anisotropy */
  get maxAnisotropy() {
    return this._maxAnisotropy;
  }

  /**
   * Manually set the platform max anisotropy (useful in test environments
   * or when the caller already knows the platform capability).
   * @param {number} value
   * @returns {this}
   */
  setMaxAnisotropy(value) {
    this._maxAnisotropy = Math.max(1, value | 0);
    return this;
  }

  // -----------------------------------------------------------------------
  // Registration / deregistration
  // -----------------------------------------------------------------------

  /**
   * Register a texture with the AF manager. Captures the texture's current
   * `anisotropy` and `minFilter` so it can be restored on
   * `unregister()` or `disable()`.
   *
   * @param {object} texture — duck-typed: must have .anisotropy, .minFilter
   * @param {object} [options={}]
   * @param {number} [options.level] — explicit AF level
   * @param {string} [options.profile] — named profile
   * @param {number} [options.usage] — UsageHint
   * @returns {object|null} — the pooled descriptor, or null on failure
   */
  register(texture, options = {}) {
    if (!texture) return null;
    if (typeof texture.anisotropy === 'undefined') return null;

    let desc = this._registry.get(texture);
    if (desc) {
      // Already registered — refresh options
      return this._updateDescriptor(desc, options);
    }

    desc = _acquireDescriptor();
    desc.texture = texture;
    desc.originalAniso = texture.anisotropy | 0;
    desc.originalMin = texture.minFilter !== undefined
      ? texture.minFilter
      : LinearMipmapLinearFilter;
    desc.profile = options.profile || this._defaultProfile;
    desc.usage = options.usage !== undefined ? options.usage : UsageHint.UNKNOWN;
    desc.enabled = true;
    desc.version = 0;

    // Resolve the initial AF level
    desc.anisoLevel = this._resolveLevel(desc, options.level);

    this._registry.set(texture, desc);
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

    if (options.level !== undefined) {
      desc.anisoLevel = this._clampLevel(options.level);
    } else if (options.profile !== undefined || options.usage !== undefined) {
      desc.anisoLevel = this._resolveLevel(desc, undefined);
    }

    desc.version++;
    this._apply(desc);
    return desc;
  }

  /**
   * Unregister a texture, restoring its original AF level and minFilter.
   * @param {object} texture
   * @returns {boolean} — true if the texture was registered
   */
  unregister(texture) {
    const desc = this._registry.get(texture);
    if (!desc) return false;

    // Restore original state
    if (desc.texture) {
      desc.texture.anisotropy = desc.originalAniso;
      desc.texture.minFilter = desc.originalMin;
    }

    this._registry.delete(texture);
    _releaseDescriptor(desc);
    return true;
  }

  /**
   * Clear all registrations, restoring every texture's original state.
   * @returns {this}
   */
  clear() {
    for (const desc of this._registry.values()) {
      if (desc.texture) {
        desc.texture.anisotropy = desc.originalAniso;
        desc.texture.minFilter = desc.originalMin;
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

  /**
   * Enable AF for a specific texture.
   * @param {object} texture
   * @returns {this}
   */
  enable(texture) {
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.enabled = true;
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * Disable AF for a specific texture (restores original state).
   * @param {object} texture
   * @returns {this}
   */
  disable(texture) {
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.enabled = false;
    if (desc.texture) {
      desc.texture.anisotropy = desc.originalAniso;
      desc.texture.minFilter = desc.originalMin;
    }
    this._disabledCount++;
    return this;
  }

  /**
   * Toggle AF for a specific texture.
   * @param {object} texture
   * @returns {boolean} — the new enabled state
   */
  toggle(texture) {
    const desc = this._registry.get(texture);
    if (!desc) return false;
    if (desc.enabled) {
      this.disable(texture);
      return false;
    }
    this.enable(texture);
    return true;
  }

  /**
   * Enable AF globally (all registered textures).
   * @returns {this}
   */
  enableAll() {
    for (const desc of this._registry.values()) {
      desc.enabled = true;
      desc.version++;
      this._apply(desc);
    }
    return this;
  }

  /**
   * Disable AF globally (all registered textures).
   * @returns {this}
   */
  disableAll() {
    for (const desc of this._registry.values()) {
      desc.enabled = false;
      if (desc.texture) {
        desc.texture.anisotropy = desc.originalAniso;
        desc.texture.minFilter = desc.originalMin;
      }
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Per-texture level and profile
  // -----------------------------------------------------------------------

  /**
   * Set the AF level for a specific texture.
   * @param {object} texture
   * @param {number} level — 1, 2, 4, 8, or 16
   * @returns {this}
   */
  setLevel(texture, level) {
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.anisoLevel = this._clampLevel(level);
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * @param {object} texture
   * @returns {number} — current AF level for the texture
   */
  getLevel(texture) {
    const desc = this._registry.get(texture);
    return desc ? desc.anisoLevel : 1;
  }

  /**
   * Apply a named profile to a specific texture.
   * @param {object} texture
   * @param {string} profile
   * @returns {this}
   */
  setProfile(texture, profile) {
    if (!AFProfiles[profile]) return this;
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.profile = profile;
    desc.anisoLevel = this._clampLevel(AFProfiles[profile].aniso);
    desc.version++;
    this._apply(desc);
    return this;
  }

  /**
   * Apply a named profile to every registered texture.
   * @param {string} profile
   * @returns {this}
   */
  setGlobalProfile(profile) {
    if (!AFProfiles[profile]) return this;
    this._defaultProfile = profile;
    const targetLevel = this._clampLevel(AFProfiles[profile].aniso);

    for (const desc of this._registry.values()) {
      desc.profile = profile;
      desc.anisoLevel = targetLevel;
      desc.version++;
      this._apply(desc);
    }
    return this;
  }

  /**
   * @returns {string[]} — list of valid profile names
   */
  static get profileNames() {
    return Object.keys(AFProfiles);
  }

  // -----------------------------------------------------------------------
  // Heuristic auto-selection
  // -----------------------------------------------------------------------

  /**
   * Suggest an AF level for a texture based on its size and usage hint.
   * Small textures or non-AF-friendly usage types get lower levels to save
   * bandwidth; ground/terrain/floor textures get higher levels.
   *
   * @param {object} texture
   * @param {number} [usage=UsageHint.UNKNOWN]
   * @returns {number} — suggested AF level
   */
  heuristicLevelFor(texture, usage = UsageHint.UNKNOWN) {
    if (!texture) return ANISO_1X;

    // Usage-based override
    switch (usage) {
      case UsageHint.GROUND_PLANE:
      case UsageHint.TERRAIN:
      case UsageHint.FLOOR:
        return this._clampLevel(ANISO_16X);
      case UsageHint.ENVIRONMENT:
      case UsageHint.WALL:
      case UsageHint.FOLIAGE:
        return this._clampLevel(ANISO_8X);
      case UsageHint.CHARACTER:
      case UsageHint.NORMAL_MAP:
        return this._clampLevel(ANISO_4X);
      case UsageHint.ROUGHNESS:
      case UsageHint.METALLIC:
      case UsageHint.AO:
      case UsageHint.EMISSIVE:
      case UsageHint.DETAIL:
        return this._clampLevel(ANISO_2X);
      case UsageHint.UI:
      case UsageHint.SPRITE:
      case UsageHint.SKYBOX:
      case UsageHint.LUT:
        return ANISO_1X;
    }

    // Size-based heuristic
    const width = texture.width || 0;
    const height = texture.height || 0;
    const pixels = width * height;

    if (pixels >= 1024 * 1024) return this._clampLevel(ANISO_16X);
    if (pixels >= 512 * 512)   return this._clampLevel(ANISO_8X);
    if (pixels >= 256 * 256)   return this._clampLevel(ANISO_4X);
    if (pixels >= 128 * 128)   return this._clampLevel(ANISO_2X);
    return ANISO_1X;
  }

  /**
   * Automatically register a texture using the heuristic AF level for the
   * given usage hint. Convenience wrapper for register() with automatic
   * level selection.
   *
   * @param {object} texture
   * @param {number} [usage=UsageHint.UNKNOWN]
   * @returns {object|null} — the pooled descriptor
   */
  autoRegister(texture, usage = UsageHint.UNKNOWN) {
    const level = this.heuristicLevelFor(texture, usage);
    return this.register(texture, { level, usage });
  }

  // -----------------------------------------------------------------------
  // Internal application
  // -----------------------------------------------------------------------

  /**
   * Resolve the AF level from options, profile, or heuristic.
   * @private
   */
  _resolveLevel(desc, explicitLevel) {
    if (explicitLevel !== undefined) return this._clampLevel(explicitLevel);
    if (desc.profile && AFProfiles[desc.profile]) {
      return this._clampLevel(AFProfiles[desc.profile].aniso);
    }
    return this.heuristicLevelFor(desc.texture, desc.usage);
  }

  /**
   * Clamp an AF level to the platform max and to the spec-allowed values.
   * @private
   */
  _clampLevel(level) {
    const n = Math.max(1, level | 0);
    // Round down to nearest power of 2 (spec requirement)
    let p = 1;
    while (p * 2 <= n) p *= 2;
    return Math.min(p, this._maxAnisotropy);
  }

  /**
   * Write the AF level and matching minFilter to the texture.
   * @private
   */
  _apply(desc) {
    if (!desc.enabled || !desc.texture) return;

    const t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : 0;

    const tex = desc.texture;
    tex.anisotropy = desc.anisoLevel;

    // When AF is active, ensure the minFilter uses mipmaps (AF only works
    // with mipmapped textures). Respect pixelArt / retro profiles that
    // intentionally avoid linear mip filtering.
    if (desc.anisoLevel > 1 && tex.minFilter !== undefined) {
      const profile = AFProfiles[desc.profile];
      if (profile && profile.minFilter !== undefined) {
        tex.minFilter = profile.minFilter;
      } else if (tex.minFilter === NearestFilter ||
                 tex.minFilter === LinearFilter) {
        // Texture was non-mipmapped — switch to mipmapped filtering
        tex.minFilter = LinearMipmapLinearFilter;
      }
    }

    // Some texture implementations cache needsUpdate; bump it so the
    // renderer re-applies the AF state.
    if (tex.needsUpdate !== undefined && desc.version > 1) {
      tex.needsUpdate = true;
    }

    this._appliedCount++;

    if (t0 > 0) {
      this._lastApplyMs = ((typeof performance !== 'undefined' && performance.now)
        ? performance.now() : 0) - t0;
    }
  }

  // -----------------------------------------------------------------------
  // Batch apply (for 10k+ textures in one pass)
  // -----------------------------------------------------------------------

  /**
   * Re-apply AF state for every registered texture in one pass. Useful after
   * a global profile change or when the platform max changes.
   * @returns {this}
   */
  flush() {
    for (const desc of this._registry.values()) {
      this._apply(desc);
    }
    return this;
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  /** @returns {number} — number of registered textures */
  get count() { return this._registry.size; }

  /** @returns {number} — number of _apply calls since last reset */
  get appliedCount() { return this._appliedCount; }

  /** @returns {number} — number of disabled textures */
  get disabledCount() { return this._disabledCount; }

  /** @returns {number} — elapsed milliseconds of the last _apply() */
  get lastApplyMs() { return this._lastApplyMs; }

  /**
   * @returns {object[]} — snapshot of every descriptor (for inspection)
   */
  getState() {
    const out = [];
    for (const desc of this._registry.values()) {
      out.push({
        profile: desc.profile,
        anisoLevel: desc.anisoLevel,
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
   * Expose every registered descriptor as a flat typed-array column set.
   * Useful for ECS-driven texture pipelines that need AF state without
   * string lookups.
   *
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const count = this._registry.size;
    const anisoLevels = new Uint8Array(count);
    const profiles = new Uint8Array(count);
    const usages = new Uint8Array(count);
    const enabled = new Uint8Array(count);
    const versions = new Uint32Array(count);

    let i = 0;
    for (const desc of this._registry.values()) {
      anisoLevels[i] = desc.anisoLevel;
      profiles[i] = Object.keys(AFProfiles).indexOf(desc.profile);
      usages[i] = desc.usage;
      enabled[i] = desc.enabled ? 1 : 0;
      versions[i] = desc.version;
      i++;
    }

    return {
      name,
      count,
      maxAnisotropy: this._maxAnisotropy,
      anisoLevels,
      profiles,
      usages,
      enabled,
      versions,
    };
  }

  // -----------------------------------------------------------------------
  // Pool helpers
  // -----------------------------------------------------------------------

  /**
   * Clear the global AF descriptor pool. Useful for hard resets.
   */
  static clearPool() {
    _afDescriptorPool.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  AnisotropicFiltering,
  AFProfiles,
  UsageHint,
  ANISO_1X,
  ANISO_2X,
  ANISO_4X,
  ANISO_8X,
  ANISO_16X,
};
export default AnisotropicFiltering;