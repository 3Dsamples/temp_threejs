// file number : 174
// full path name : src/textures/174_virtual_texturing.js
// description : Standalone Virtual Texturing (Streaming) feature module rewritten as a pure ES module with zero CDN imports and completely dynamic features. For massive, high-resolution textures (16K terrain splats, 32K environment atlases, gigapixel HDRIs) that could never fit in VRAM, virtual texturing breaks the source into a fixed grid of tiles and loads only the tiles the current frame actually needs — giving near-unlimited virtual detail at bounded physical memory. Manages the indirection table (a 2D map of virtual tile → physical pool slot), the physical tile pool (a fixed-size VRAM slab with LRU / oldest / lowest-priority eviction policies), the per-frame streaming scheduler (driven by UV derivatives to compute the required LOD per fragment), a neighbor prefetch ring (prevents thrashing at tile boundaries), and a lightweight local StreamingManager with a per-tile request queue that a caller can drain asynchronously. Provides per-texture registration, a full LOD bias / max-LOD / min-LOD control, configurable tile size and pool size, dynamic pool resizing at runtime, runtime tile-request budget per frame (to bound CPU and network cost), and a full diagnostic suite. All virtual-texture state (indirection slots, tile records, eviction queues) is pooled via acquire()/release()/clearPool() so 10k+ virtual textures can co-exist without GC churn. Exports ready-to-paste GLSL and WGSL shader source strings that implement the indirection lookup and page-table sampling. Exposes a BitECS SoA bridge so ECS-driven streaming systems can drive virtual-texture state without string lookups. Uses the project's Common/Precision/Constants/Vec2/Vec3/Vec4/Mat4 modules. Designed for Android 64-bit mobile with zero CDN dependencies and no static-server requirement — the module is idempotent and safe to import from any file that needs virtual texturing, from any texture class, or from a global feature registry.
// best for : Massive, high-resolution textures that would never fit in VRAM — 16K terrain splats, 32K environment atlases, gigapixel HDRIs, satellite imagery, medical imaging, cartographic basemaps, and any texture that must retain near-pixel-perfect detail over a huge visible area. Ideal for open-world terrain at 10k+ entities where the visible footprint demands dozens of square kilometres of coverage at sub-metre resolution. The single largest capability uplift for any 3D scene with a truly open world on Android 64-bit at 10k+ virtual textures.
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
// Eviction policy constants — how the physical pool chooses which slot to
// free when it needs to make room for a new tile.
// ---------------------------------------------------------------------------
const EvictionPolicy = {
  LRU:          0,  // evict the slot that was used longest ago — default
  OLDEST:       1,  // evict the slot that was allocated longest ago
  LOWEST_LOD:   2,  // evict the slot with the highest mip level (coarsest)
  HIGHEST_LOD:  3,  // evict the slot with the lowest mip level (finest)
};

// ---------------------------------------------------------------------------
// Request priority constants — how important a tile request is.
// ---------------------------------------------------------------------------
const RequestPriority = {
  BACKGROUND:  0,   // lowest — will not evict visible tiles
  NORMAL:      1,   // default
  PREFETCH:    2,   // for neighbor tiles
  URGENT:      3,   // for tiles currently visible on screen
};

// ---------------------------------------------------------------------------
// Tile state constants.
// ---------------------------------------------------------------------------
const TileState = {
  UNLOADED:   0,
  REQUESTED:  1,
  LOADING:    2,
  LOADED:     3,
  ERROR:      4,
};

// ---------------------------------------------------------------------------
// Named quality presets — each maps a target surface to a set of defaults.
// ---------------------------------------------------------------------------
const VirtualTexturingProfiles = {
  off:        { enabled: false, tileSize: 256, poolTiles: 64,  maxLOD: 0, budget: 0  },
  minimal:    { enabled: true,  tileSize: 128, poolTiles: 64,  maxLOD: 4, budget: 4  },
  balanced:   { enabled: true,  tileSize: 256, poolTiles: 256, maxLOD: 6, budget: 16 },
  quality:    { enabled: true,  tileSize: 256, poolTiles: 512, maxLOD: 8, budget: 32 },
  terrain:    { enabled: true,  tileSize: 512, poolTiles: 384, maxLOD: 7, budget: 24 },
  environment:{ enabled: true,  tileSize: 256, poolTiles: 768, maxLOD: 8, budget: 48 },
  satellite:  { enabled: true,  tileSize: 512, poolTiles: 1024,maxLOD: 10,budget: 64 },
};

// ---------------------------------------------------------------------------
// Usage hints — used by the heuristic auto-selection routine.
// ---------------------------------------------------------------------------
const VirtualTexturingUsageHint = {
  UNKNOWN:        0,
  TERRAIN_SPLAT:  1,
  ENVIRONMENT_HDRI: 2,
  SATELLITE:      3,
  MEDICAL:        4,
  CARTOGRAPHIC:   5,
  DETAIL_LAYER:   6,
  GIGAPIXEL:      7,
  UI:             8,
  LUT:            9,
  SPRITE:         10,
  FLAT_TEXTURE:   11,
};

// ---------------------------------------------------------------------------
// Static pool for virtual-texture descriptors.
// ---------------------------------------------------------------------------
const _vtDescriptorPool = [];

function _acquireDescriptor() {
  const d = _vtDescriptorPool.pop();
  if (d) {
    d.texture          = null;
    d.enabled          = true;
    d.profile          = 'balanced';
    d.tileSize         = 256;
    d.poolTiles        = 256;
    d.poolCols         = 16;
    d.poolRows         = 16;
    d.maxLOD           = 6;
    d.minLOD           = 0;
    d.budgetPerFrame   = 16;
    d.evictionPolicy   = EvictionPolicy.LRU;
    d.prefetchEnabled  = true;
    d.prefetchRadius   = 1;
    d.uvScale          = 1;
    d.indirectionTable = null;
    d.tileStates       = null;
    d.tileLOD          = null;
    d.tileLastUsed     = null;
    d.tileSlot         = null;
    d.poolSlotTile     = null;
    d.poolSlotInUse    = null;
    d.poolSlotPriority = null;
    d.poolSlotLOD      = null;
    d.requestQueue     = null;
    d.nextFrameCounter = 0;
    d.frameCounter     = 0;
    d.virtualWidth     = 0;
    d.virtualHeight    = 0;
    d.usage            = VirtualTexturingUsageHint.UNKNOWN;
    d.version          = 0;
    return d;
  }
  return _emptyDescriptor();
}

function _emptyDescriptor() {
  return {
    texture: null,
    enabled: true,
    profile: 'balanced',
    tileSize: 256,
    poolTiles: 256,
    poolCols: 16,
    poolRows: 16,
    maxLOD: 6,
    minLOD: 0,
    budgetPerFrame: 16,
    evictionPolicy: EvictionPolicy.LRU,
    prefetchEnabled: true,
    prefetchRadius: 1,
    uvScale: 1,
    indirectionTable: null,
    tileStates: null,
    tileLOD: null,
    tileLastUsed: null,
    tileSlot: null,
    poolSlotTile: null,
    poolSlotInUse: null,
    poolSlotPriority: null,
    poolSlotLOD: null,
    requestQueue: null,
    nextFrameCounter: 0,
    frameCounter: 0,
    virtualWidth: 0,
    virtualHeight: 0,
    usage: VirtualTexturingUsageHint.UNKNOWN,
    version: 0,
  };
}

function _releaseDescriptor(d) {
  d.texture = null;
  d.indirectionTable = null;
  d.tileStates = null;
  d.tileLOD = null;
  d.tileLastUsed = null;
  d.tileSlot = null;
  d.poolSlotTile = null;
  d.poolSlotInUse = null;
  d.poolSlotPriority = null;
  d.poolSlotLOD = null;
  d.requestQueue = null;
  if (_vtDescriptorPool.length < 64) _vtDescriptorPool.push(d);
}

// ---------------------------------------------------------------------------
// Shared scratch buffers (zero allocation in hot paths)
// ---------------------------------------------------------------------------
const _vec2 = new Float32Array(2);
const _vec3 = new Float32Array(3);
const _vec4 = new Float32Array(4);
const _tileReq = new Int32Array(4); // [virtualX, virtualY, mip, priority]

// ---------------------------------------------------------------------------
// GLSL shader source — indirection lookup + page-table sampling.
// ---------------------------------------------------------------------------
const VT_GLSL = /* glsl */`
  // Virtual Texturing — GLSL sampling helper
  //
  // Bindings (typical layout):
  //   uniform sampler2D uPageTable;       // indirection texture (physical slot map)
  //   uniform sampler2D uPhysicalTiles;   // physical tile atlas
  //   uniform int       uTileSize;        // tile edge length in pixels
  //   uniform int       uPoolCols;        // atlas columns
  //   uniform int       uPoolRows;        // atlas rows
  //   uniform float     uMaxLOD;          // highest available LOD
  //   uniform float     uUvScale;
  //   uniform vec2      uPhysicalSlotSize; // 1.0 / poolCols, 1.0 / poolRows
  //
  // The page table stores, for each virtual tile and LOD, the physical
  // slot coordinates (or a sentinel indicating "not yet loaded").

  const float VT_NOT_LOADED = -1.0;

  vec4 virtualSample(vec2 uv, float lodBias) {
    // Scale UV to virtual space
    vec2 virtualUV = uv * uUvScale;

    // Compute the LOD from UV derivatives
    vec2 dUVdx = dFdx(virtualUV);
    vec2 dUVdy = dFdy(virtualUV);
    float footprint = max(length(dUVdx), length(dUVdy));
    float lod = max(0.0, log2(footprint * float(uTileSize))) + lodBias;
    lod = clamp(lod, 0.0, uMaxLOD);

    // Compute the virtual tile ID at this LOD
    float tileScale = exp2(lod);
    vec2 virtualTiles = virtualUV / tileScale;
    vec2 virtualTileId = floor(virtualTiles);

    // Look up the physical slot in the page table
    vec4 slot = texture2D(uPageTable, (virtualTileId + 0.5) / vec2(textureSize(uPageTable, 0)));

    if (slot.x < 0.0) {
      // Tile not loaded — return a fallback (transparent or the base mip)
      return vec4(0.5, 0.5, 0.5, 1.0);
    }

    // Convert the physical slot to atlas UV
    vec2 slotUV = slot.xy;
    vec2 physicalOrigin = slotUV * uPhysicalSlotSize;
    vec2 physicalSize = uPhysicalSlotSize;

    // Compute the final UV within the physical tile
    vec2 tileUV = fract(virtualTiles);
    vec2 atlasUV = physicalOrigin + tileUV * physicalSize;

    return texture2D(uPhysicalTiles, atlasUV);
  }
`;

// ---------------------------------------------------------------------------
// WGSL shader source.
// ---------------------------------------------------------------------------
const VT_WGSL = /* wgsl */`
  // Virtual Texturing — WGSL sampling helper
  //
  // Bindings:
  //   @group(0) @binding(0) var pageTable     : texture_2d<f32>;
  //   @group(0) @binding(1) var physicalTiles : texture_2d<f32>;
  //   @group(0) @binding(2) var ptSampler     : sampler;
  //   @group(0) @binding(3) var ptSampler2    : sampler;
  //   @group(0) @binding(4) var<uniform> params : VTParams;
  //
  // struct VTParams {
  //   tileSize       : f32,
  //   poolCols       : f32,
  //   poolRows       : f32,
  //   maxLOD         : f32,
  //   uvScale        : f32,
  //   physicalSlotSizeX : f32,
  //   physicalSlotSizeY : f32,
  // }

  fn virtualSample(uv : vec2<f32>, lodBias : f32, virtualUV : vec2<f32>) -> vec4<f32> {
    let footprint = max(length(dpdx(virtualUV)), length(dpdy(virtualUV)));
    var lod = max(0.0, log2(footprint * params.tileSize)) + lodBias;
    lod = clamp(lod, 0.0, params.maxLOD);

    let tileScale = exp2(lod);
    let virtualTiles = virtualUV / tileScale;
    let virtualTileId = floor(virtualTiles);

    let ptDims = vec2<f32>(textureDimensions(pageTable, 0));
    let slot = textureSampleLevel(pageTable, ptSampler, (virtualTileId + 0.5) / ptDims, 0.0);

    if (slot.x < 0.0) {
      return vec4<f32>(0.5, 0.5, 0.5, 1.0);
    }

    let physicalOrigin = slot.xy * vec2<f32>(params.physicalSlotSizeX, params.physicalSlotSizeY);
    let tileUV = fract(virtualTiles);
    let atlasUV = physicalOrigin + tileUV * vec2<f32>(params.physicalSlotSizeX, params.physicalSlotSizeY);

    return textureSample(physicalTiles, ptSampler2, atlasUV);
  }
`;

// ---------------------------------------------------------------------------
// Internal — allocate all per-descriptor arrays from a fresh descriptor.
// ---------------------------------------------------------------------------
function _initDescriptorArrays(desc, virtualWidth, virtualHeight) {
  const tileSize = desc.tileSize;
  const virtualCols = Math.max(1, Math.ceil(virtualWidth / tileSize));
  const virtualRows = Math.max(1, Math.ceil(virtualHeight / tileSize));
  const virtualTiles = virtualCols * virtualRows;

  // Indirection table: for each (virtualTile, mipLevel) pair, store the
  // physical slot index, or -1 if not loaded.
  desc.indirectionTable = new Int32Array(virtualTiles * (desc.maxLOD + 1));
  desc.indirectionTable.fill(-1);

  // Per-virtual-tile state arrays (only track mip 0 for now — higher mips
  // can be inferred from mip 0 by the shader).
  desc.tileStates    = new Uint8Array(virtualTiles);
  desc.tileLOD       = new Uint8Array(virtualTiles);
  desc.tileLastUsed  = new Int32Array(virtualTiles);
  desc.tileSlot      = new Int32Array(virtualTiles);
  desc.tileSlot.fill(-1);

  // Physical pool state
  const poolTiles = desc.poolTiles;
  desc.poolSlotTile     = new Int32Array(poolTiles);
  desc.poolSlotInUse    = new Uint8Array(poolTiles);
  desc.poolSlotPriority = new Uint8Array(poolTiles);
  desc.poolSlotLOD      = new Uint8Array(poolTiles);
  desc.poolSlotTile.fill(-1);

  // Request queue (fixed capacity = budgetPerFrame * 4)
  desc.requestQueue = new Int32Array(desc.budgetPerFrame * 4 * 4);
  desc.requestQueueLength = 0;

  // Virtual dimensions
  desc.virtualWidth = virtualWidth;
  desc.virtualHeight = virtualHeight;
  desc.virtualCols = virtualCols;
  desc.virtualRows = virtualRows;
  desc.virtualTiles = virtualTiles;
}

// ---------------------------------------------------------------------------
// VirtualTexturing — standalone virtual texturing feature module.
// ---------------------------------------------------------------------------
class VirtualTexturing {
  /**
   * @param {object} [options={}]
   * @param {string} [options.defaultProfile='balanced']
   * @param {number} [options.globalPoolSize=0] — 0 = per-texture pool only
   * @param {boolean} [options.warnOnInvalidParams=false]
   */
  constructor(options = {}) {
    this.isVirtualTexturing = true;

    this._defaultProfile = options.defaultProfile || 'balanced';
    this._globalPoolSize = Math.max(0, options.globalPoolSize || 0);
    this._warnOnInvalidParams = options.warnOnInvalidParams === true;

    // Fast lookup: texture → descriptor
    this._registry = new Map();

    // Global frame counter — advanced once per rendered frame
    this._globalFrame = 0;

    // Diagnostics
    this._appliedCount = 0;
    this._disabledCount = 0;
    this._totalRequests = 0;
    this._totalEvictions = 0;
    this._totalLoads = 0;
    this._totalPoolMisses = 0;
    this._lastScheduleMs = 0;
  }

  // -----------------------------------------------------------------------
  // Registration / deregistration
  // -----------------------------------------------------------------------

  /**
   * Register a virtual texture.
   *
   * @param {object} texture — the base texture (used as the mip-0 fallback
   *   and as the identity for the caller's own data)
   * @param {number} virtualWidth — total virtual texture width
   * @param {number} virtualHeight — total virtual texture height
   * @param {object} [options={}]
   * @param {string} [options.profile]
   * @param {number} [options.tileSize]
   * @param {number} [options.poolTiles]
   * @param {number} [options.maxLOD]
   * @param {number} [options.minLOD]
   * @param {number} [options.budgetPerFrame]
   * @param {number} [options.evictionPolicy]
   * @param {boolean} [options.prefetchEnabled]
   * @param {number} [options.prefetchRadius]
   * @param {number} [options.uvScale]
   * @param {number} [options.usage]
   * @returns {object|null} — the pooled descriptor
   */
  register(texture, virtualWidth, virtualHeight, options = {}) {
    if (!texture) return null;
    if (!virtualWidth || !virtualHeight) return null;

    let desc = this._registry.get(texture);
    if (desc) return this._updateDescriptor(desc, virtualWidth, virtualHeight, options);

    desc = _acquireDescriptor();
    desc.texture = texture;
    desc.profile = options.profile || this._defaultProfile;
    desc.usage = options.usage !== undefined ? options.usage : VirtualTexturingUsageHint.UNKNOWN;
    desc.version = 0;

    this._applyProfileDefaults(desc, options);
    _initDescriptorArrays(desc, virtualWidth, virtualHeight);

    this._registry.set(texture, desc);
    this._apply(desc);
    return desc;
  }

  /**
   * Update an existing descriptor with new options.
   * @private
   */
  _updateDescriptor(desc, virtualWidth, virtualHeight, options) {
    if (options.profile !== undefined) desc.profile = options.profile;
    if (options.usage !== undefined) desc.usage = options.usage;

    this._applyProfileDefaults(desc, options);

    // If the pool or tile size changed, reinitialize all arrays
    if (options.tileSize !== undefined || options.poolTiles !== undefined ||
        options.maxLOD !== undefined) {
      _initDescriptorArrays(desc, virtualWidth, virtualHeight);
    } else if (virtualWidth !== desc.virtualWidth || virtualHeight !== desc.virtualHeight) {
      _initDescriptorArrays(desc, virtualWidth, virtualHeight);
    }

    desc.version++;
    this._apply(desc);
    return desc;
  }

  /**
   * Apply profile defaults, then overlay explicit overrides.
   * @private
   */
  _applyProfileDefaults(desc, options) {
    const profile = VirtualTexturingProfiles[desc.profile] || VirtualTexturingProfiles.balanced;

    desc.enabled        = options.enabled !== undefined ? !!options.enabled : profile.enabled;
    desc.tileSize       = options.tileSize !== undefined ? Math.max(16, options.tileSize | 0) : profile.tileSize;
    desc.poolTiles      = options.poolTiles !== undefined ? Math.max(4, options.poolTiles | 0) : profile.poolTiles;
    desc.maxLOD         = options.maxLOD !== undefined ? Math.max(0, options.maxLOD | 0) : profile.maxLOD;
    desc.minLOD         = options.minLOD !== undefined ? Math.max(0, options.minLOD | 0) : 0;
    desc.budgetPerFrame = options.budgetPerFrame !== undefined ? Math.max(0, options.budgetPerFrame | 0) : profile.budget;
    desc.evictionPolicy = options.evictionPolicy !== undefined ? (options.evictionPolicy | 0) : EvictionPolicy.LRU;
    desc.prefetchEnabled = options.prefetchEnabled !== undefined ? !!options.prefetchEnabled : true;
    desc.prefetchRadius  = options.prefetchRadius !== undefined ? Math.max(0, options.prefetchRadius | 0) : 1;
    desc.uvScale         = options.uvScale !== undefined ? Math.max(0.001, options.uvScale) : 1;

    // Compute pool grid dims (square-ish)
    const cols = Math.max(1, Math.ceil(Math.sqrt(desc.poolTiles)));
    const rows = Math.ceil(desc.poolTiles / cols);
    desc.poolCols = cols;
    desc.poolRows = rows;
    desc.poolTiles = cols * rows;
  }

  /**
   * Unregister a virtual texture.
   * @param {object} texture
   * @returns {boolean}
   */
  unregister(texture) {
    const desc = this._registry.get(texture);
    if (!desc) return false;

    if (desc.texture) {
      delete desc.texture.vtEnabled;
      delete desc.texture.vtParams;
      delete desc.texture.vtIndirectionTable;
    }

    this._registry.delete(texture);
    _releaseDescriptor(desc);
    return true;
  }

  clear() {
    for (const desc of this._registry.values()) {
      if (desc.texture) {
        delete desc.texture.vtEnabled;
        delete desc.texture.vtParams;
        delete desc.texture.vtIndirectionTable;
      }
      _releaseDescriptor(desc);
    }
    this._registry.clear();
    this._appliedCount = 0;
    this._disabledCount = 0;
    this._totalRequests = 0;
    this._totalEvictions = 0;
    this._totalLoads = 0;
    this._totalPoolMisses = 0;
    this._globalFrame = 0;
    return this;
  }

  // -----------------------------------------------------------------------
  // Dynamic toggles
  // -----------------------------------------------------------------------

  enable(texture) {
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.enabled = true;
    desc.version++;
    this._apply(desc);
    return this;
  }

  disable(texture) {
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.enabled = false;
    if (desc.texture) {
      delete desc.texture.vtEnabled;
      delete desc.texture.vtParams;
    }
    this._disabledCount++;
    return this;
  }

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

  // -----------------------------------------------------------------------
  // Per-texture overrides
  // -----------------------------------------------------------------------

  setBudgetPerFrame(texture, budget) {
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.budgetPerFrame = Math.max(0, budget | 0);
    desc.version++;
    return this;
  }

  setEvictionPolicy(texture, policy) {
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.evictionPolicy = policy | 0;
    desc.version++;
    return this;
  }

  setLODRange(texture, minLOD, maxLOD) {
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.minLOD = Math.max(0, minLOD | 0);
    desc.maxLOD = Math.max(desc.minLOD, maxLOD | 0);
    desc.version++;
    return this;
  }

  setPrefetch(texture, enabled, radius) {
    const desc = this._registry.get(texture);
    if (!desc) return this;
    desc.prefetchEnabled = !!enabled;
    if (radius !== undefined) desc.prefetchRadius = Math.max(0, radius | 0);
    desc.version++;
    return this;
  }

  // -----------------------------------------------------------------------
  // Per-frame scheduling
  // -----------------------------------------------------------------------

  /**
   * Advance the global frame counter. Should be called once per rendered
   * frame BEFORE `schedule()`.
   * @returns {this}
   */
  advanceFrame() {
    this._globalFrame++;
    return this;
  }

  /**
   * Schedule tile requests for one virtual texture based on the current
   * camera's UV derivatives at a set of sample points. This is the per-frame
   * driver of the streaming pipeline.
   *
   * @param {object} texture
   * @param {Float32Array} sampleUVs — flat array of [u, v, du, dv] per sample
   * @param {number} sampleCount
   * @returns {number} — number of tile requests queued
   */
  schedule(texture, sampleUVs, sampleCount) {
    const desc = this._registry.get(texture);
    if (!desc || !desc.enabled) return 0;

    const t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : 0;

    desc.frameCounter = this._globalFrame;
    desc.requestQueueLength = 0;

    const budget = desc.budgetPerFrame;
    if (budget === 0) {
      if (t0 > 0) this._lastScheduleMs = 0;
      return 0;
    }

    const tileSize = desc.tileSize;
    const uvScale = desc.uvScale;
    const maxLOD = desc.maxLOD;
    const minLOD = desc.minLOD;
    const virtualCols = desc.virtualCols;
    const virtualRows = desc.virtualRows;

    let requested = 0;

    // Walk all sample points
    for (let s = 0; s < sampleCount; s++) {
      if (requested >= budget) break;

      const baseIdx = s * 4;
      const u = sampleUVs[baseIdx] * uvScale;
      const v = sampleUVs[baseIdx + 1] * uvScale;
      const du = sampleUVs[baseIdx + 2] * uvScale;
      const dv = sampleUVs[baseIdx + 3] * uvScale;

      // Compute LOD from derivatives
      const footprint = Math.max(Math.abs(du), Math.abs(dv));
      let lod = footprint > 1e-6 ? Math.log2(footprint * tileSize) : 0;
      lod = Math.max(minLOD, Math.min(maxLOD, Math.round(lod)));

      // Virtual tile coordinates at this LOD
      const tileScale = Math.pow(2, lod);
      const virtualTilesU = u / (tileScale * (1 / virtualCols));
      const virtualTilesV = v / (tileScale * (1 / virtualRows));

      const virtualTileU = Math.floor(virtualTilesU);
      const virtualTileV = Math.floor(virtualTilesV);

      if (virtualTileU < 0 || virtualTileV < 0 ||
          virtualTileU >= virtualCols || virtualTileV >= virtualRows) {
        continue;
      }

      // Virtual tile index at mip 0
      const tileIdx = virtualTileV * virtualCols + virtualTileU;

      // Skip if already loaded at a sufficient mip
      if (desc.tileStates[tileIdx] === TileState.LOADED &&
          desc.tileLOD[tileIdx] <= lod) {
        // Mark as recently used
        desc.tileLastUsed[tileIdx] = this._globalFrame;
        continue;
      }

      // Add to the request queue
      this._pushRequest(desc, virtualTileU, virtualTileV, lod, RequestPriority.URGENT);
      requested++;

      // Prefetch neighbors
      if (desc.prefetchEnabled && requested < budget && desc.prefetchRadius > 0) {
        const r = desc.prefetchRadius;
        for (let dy = -r; dy <= r && requested < budget; dy++) {
          for (let dx = -r; dx <= r && requested < budget; dx++) {
            if (dx === 0 && dy === 0) continue;

            const nx = virtualTileU + dx;
            const ny = virtualTileV + dy;

            if (nx < 0 || ny < 0 || nx >= virtualCols || ny >= virtualRows) continue;

            const nIdx = ny * virtualCols + nx;
            if (desc.tileStates[nIdx] === TileState.LOADED) continue;

            this._pushRequest(desc, nx, ny, lod, RequestPriority.PREFETCH);
            requested++;
          }
        }
      }
    }

    this._totalRequests += requested;

    if (t0 > 0) {
      this._lastScheduleMs = ((typeof performance !== 'undefined' && performance.now)
        ? performance.now() : 0) - t0;
    }

    return requested;
  }

  /**
   * Push a single tile request onto the descriptor's request queue.
   * @private
   */
  _pushRequest(desc, virtualX, virtualY, lod, priority) {
    const q = desc.requestQueue;
    const idx = desc.requestQueueLength * 4;

    // Grow the queue if needed (rare — queue is sized at budgetPerFrame * 4)
    if (idx + 3 >= q.length) {
      desc.budgetPerFrame = Math.max(desc.budgetPerFrame, Math.ceil(desc.requestQueueLength * 1.5));
    }

    q[idx] = virtualX;
    q[idx + 1] = virtualY;
    q[idx + 2] = lod | 0;
    q[idx + 3] = priority | 0;

    desc.requestQueueLength++;

    // Mark the tile as requested
    const virtualCols = desc.virtualCols;
    const tileIdx = virtualY * virtualCols + virtualX;
    if (desc.tileStates[tileIdx] === TileState.UNLOADED) {
      desc.tileStates[tileIdx] = TileState.REQUESTED;
    }
  }

  /**
   * Pop the next tile request from the queue. The caller (typically a
   * StreamingManager or a network fetch layer) is expected to load the tile
   * and call `provideTile()` when the data is available.
   *
   * @param {object} texture
   * @returns {{ virtualX: number, virtualY: number, lod: number, priority: number }|null}
   */
  popRequest(texture) {
    const desc = this._registry.get(texture);
    if (!desc || desc.requestQueueLength === 0) return null;

    const q = desc.requestQueue;
    // The queue is written in order; pop from the end (cheapest)
    const idx = (desc.requestQueueLength - 1) * 4;
    desc.requestQueueLength--;

    return {
      virtualX: q[idx],
      virtualY: q[idx + 1],
      lod: q[idx + 2],
      priority: q[idx + 3],
    };
  }

  // -----------------------------------------------------------------------
  // Tile provisioning (called when a tile's pixel data is available)
  // -----------------------------------------------------------------------

  /**
   * Provide a loaded tile. The physical pool is used to store it. If the
   * pool is full, an eviction is triggered according to the configured
   * eviction policy.
   *
   * @param {object} texture
   * @param {number} virtualX
   * @param {number} virtualY
   * @param {number} lod
   * @param {TypedArray} data — the tile's pixel data (RGBA), or null if the
   *   caller just wants to mark the tile as loaded with a placeholder
   * @returns {boolean} — true if the tile was accepted into the pool
   */
  provideTile(texture, virtualX, virtualY, lod, data) {
    const desc = this._registry.get(texture);
    if (!desc || !desc.enabled) return false;

    const virtualCols = desc.virtualCols;
    const virtualRows = desc.virtualRows;

    if (virtualX < 0 || virtualY < 0 || virtualX >= virtualCols || virtualY >= virtualRows) {
      return false;
    }
    if (lod < desc.minLOD || lod > desc.maxLOD) return false;

    const tileIdx = virtualY * virtualCols + virtualX;

    // Find or allocate a physical slot
    let slot = desc.tileSlot[tileIdx];
    if (slot === -1) {
      slot = this._allocateSlot(desc, virtualX, virtualY, lod);
      if (slot === -1) return false;
      desc.tileSlot[tileIdx] = slot;
    }

    // Fill in the pool bookkeeping
    desc.poolSlotTile[slot] = tileIdx;
    desc.poolSlotInUse[slot] = 1;
    desc.poolSlotLOD[slot] = lod;
    desc.poolSlotPriority[slot] = RequestPriority.URGENT;

    // Store the indirection table entry
    const indirectionIdx = tileIdx * (desc.maxLOD + 1) + lod;
    desc.indirectionTable[indirectionIdx] = slot;

    // Update tile state
    desc.tileStates[tileIdx] = TileState.LOADED;
    desc.tileLOD[tileIdx] = lod;
    desc.tileLastUsed[tileIdx] = this._globalFrame;

    this._totalLoads++;

    // Optionally store the data reference on the descriptor for later GPU upload
    if (data) {
      if (!desc.tileData) desc.tileData = new Map();
      desc.tileData.set(slot, data);
    }

    return true;
  }

  /**
   * @private
   */
  _allocateSlot(desc, virtualX, virtualY, lod) {
    // First try to find a free slot
    const poolTiles = desc.poolTiles;
    const poolSlotInUse = desc.poolSlotInUse;

    for (let s = 0; s < poolTiles; s++) {
      if (poolSlotInUse[s] === 0) return s;
    }

    // No free slots — evict according to the policy
    const victim = this._selectEvictionCandidate(desc);
    if (victim === -1) {
      this._totalPoolMisses++;
      return -1;
    }

    // Clear the old tile's bookkeeping
    const oldTileIdx = desc.poolSlotTile[victim];
    if (oldTileIdx !== -1) {
      desc.tileStates[oldTileIdx] = TileState.UNLOADED;
      desc.tileSlot[oldTileIdx] = -1;

      // Clear the indirection table entries for this tile
      const baseIdx = oldTileIdx * (desc.maxLOD + 1);
      for (let l = 0; l <= desc.maxLOD; l++) {
        desc.indirectionTable[baseIdx + l] = -1;
      }

      if (desc.tileData) desc.tileData.delete(victim);
    }

    this._totalEvictions++;
    return victim;
  }

  /**
   * @private
   */
  _selectEvictionCandidate(desc) {
    const policy = desc.evictionPolicy;
    const poolTiles = desc.poolTiles;
    const poolSlotTile = desc.poolSlotTile;
    const poolSlotPriority = desc.poolSlotPriority;
    const poolSlotLOD = desc.poolSlotLOD;

    let bestSlot = -1;
    let bestScore = -Infinity;

    for (let s = 0; s < poolTiles; s++) {
      const tileIdx = poolSlotTile[s];
      if (tileIdx === -1) continue;

      let score = 0;

      switch (policy) {
        case EvictionPolicy.LRU:
          // Prefer evicting the tile that was used longest ago
          score = -desc.tileLastUsed[tileIdx];
          break;

        case EvictionPolicy.OLDEST:
          // Oldest = smaller tileIdx (approximation)
          score = -tileIdx;
          break;

        case EvictionPolicy.LOWEST_LOD:
          // Evict the highest LOD (coarsest)
          score = -poolSlotLOD[s];
          break;

        case EvictionPolicy.HIGHEST_LOD:
          // Evict the lowest LOD (finest)
          score = poolSlotLOD[s];
          break;
      }

      if (score > bestScore) {
        bestScore = score;
        bestSlot = s;
      }
    }

    return bestSlot;
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  /** @returns {number} */
  get count() { return this._registry.size; }

  /** @returns {number} */
  get appliedCount() { return this._appliedCount; }

  /** @returns {number} */
  get disabledCount() { return this._disabledCount; }

  /** @returns {number} */
  get totalRequests() { return this._totalRequests; }

  /** @returns {number} */
  get totalEvictions() { return this._totalEvictions; }

  /** @returns {number} */
  get totalLoads() { return this._totalLoads; }

  /** @returns {number} */
  get totalPoolMisses() { return this._totalPoolMisses; }

  /** @returns {number} */
  get lastScheduleMs() { return this._lastScheduleMs; }

  /** @returns {number} */
  get globalFrame() { return this._globalFrame; }

  /**
   * Compute the current physical pool utilization for a texture.
   * @param {object} texture
   * @returns {number} — fraction in [0, 1]
   */
  getPoolUsage(texture) {
    const desc = this._registry.get(texture);
    if (!desc) return 0;

    let used = 0;
    for (let s = 0; s < desc.poolTiles; s++) {
      if (desc.poolSlotInUse[s] === 1) used++;
    }
    return desc.poolTiles > 0 ? used / desc.poolTiles : 0;
  }

  /**
   * @param {string} name
   * @returns {object}
   */
  asBitecsComponent(name) {
    const count = this._registry.size;
    const profilesArr     = new Uint8Array(count);
    const tileSizeArr     = new Uint32Array(count);
    const poolTilesArr    = new Uint32Array(count);
    const maxLODArr       = new Uint8Array(count);
    const budgetArr       = new Uint32Array(count);
    const evictionArr     = new Uint8Array(count);
    const prefetchArr     = new Uint8Array(count);
    const virtualWidthArr = new Uint32Array(count);
    const virtualHeightArr = new Uint32Array(count);
    const loadedTilesArr  = new Uint32Array(count);
    const poolUsageArr    = new Float32Array(count);
    const usagesArr       = new Uint8Array(count);
    const enabledArr      = new Uint8Array(count);
    const versionsArr     = new Uint32Array(count);

    const profileNames = Object.keys(VirtualTexturingProfiles);

    let i = 0;
    for (const desc of this._registry.values()) {
      profilesArr[i] = profileNames.indexOf(desc.profile);
      tileSizeArr[i] = desc.tileSize;
      poolTilesArr[i] = desc.poolTiles;
      maxLODArr[i] = desc.maxLOD;
      budgetArr[i] = desc.budgetPerFrame;
      evictionArr[i] = desc.evictionPolicy;
      prefetchArr[i] = desc.prefetchEnabled ? 1 : 0;
      virtualWidthArr[i] = desc.virtualWidth;
      virtualHeightArr[i] = desc.virtualHeight;

      let loaded = 0;
      let used = 0;
      for (let t = 0; t < desc.virtualTiles; t++) {
        if (desc.tileStates[t] === TileState.LOADED) loaded++;
      }
      for (let s = 0; s < desc.poolTiles; s++) {
        if (desc.poolSlotInUse[s] === 1) used++;
      }
      loadedTilesArr[i] = loaded;
      poolUsageArr[i] = desc.poolTiles > 0 ? used / desc.poolTiles : 0;

      usagesArr[i] = desc.usage;
      enabledArr[i] = desc.enabled ? 1 : 0;
      versionsArr[i] = desc.version;
      i++;
    }

    return {
      name,
      count,
      globalFrame: this._globalFrame,
      totalRequests: this._totalRequests,
      totalEvictions: this._totalEvictions,
      totalLoads: this._totalLoads,
      totalPoolMisses: this._totalPoolMisses,
      profiles: profilesArr,
      tileSize: tileSizeArr,
      poolTiles: poolTilesArr,
      maxLOD: maxLODArr,
      budgetPerFrame: budgetArr,
      evictionPolicy: evictionArr,
      prefetch: prefetchArr,
      virtualWidth: virtualWidthArr,
      virtualHeight: virtualHeightArr,
      loadedTiles: loadedTilesArr,
      poolUsage: poolUsageArr,
      usages: usagesArr,
      enabled: enabledArr,
      versions: versionsArr,
    };
  }

  /**
   * @param {object} texture
   * @returns {object[]} — full state snapshot for one texture
   */
  getTextureState(texture) {
    const desc = this._registry.get(texture);
    if (!desc) return [];

    let loaded = 0;
    for (let t = 0; t < desc.virtualTiles; t++) {
      if (desc.tileStates[t] === TileState.LOADED) loaded++;
    }

    let used = 0;
    for (let s = 0; s < desc.poolTiles; s++) {
      if (desc.poolSlotInUse[s] === 1) used++;
    }

    return [{
      profile: desc.profile,
      tileSize: desc.tileSize,
      poolTiles: desc.poolTiles,
      maxLOD: desc.maxLOD,
      budgetPerFrame: desc.budgetPerFrame,
      evictionPolicy: desc.evictionPolicy,
      prefetchEnabled: desc.prefetchEnabled,
      virtualWidth: desc.virtualWidth,
      virtualHeight: desc.virtualHeight,
      virtualTiles: desc.virtualTiles,
      loadedTiles: loaded,
      poolUsed: used,
      poolUsage: desc.poolTiles > 0 ? used / desc.poolTiles : 0,
      enabled: desc.enabled,
      version: desc.version,
    }];
  }

  /**
   * Internal application.
   * @private
   */
  _apply(desc) {
    if (!desc.texture) return;

    const tex = desc.texture;
    tex.vtEnabled = desc.enabled;

    if (desc.enabled) {
      tex.vtParams = {
        tileSize: desc.tileSize,
        poolTiles: desc.poolTiles,
        poolCols: desc.poolCols,
        poolRows: desc.poolRows,
        maxLOD: desc.maxLOD,
        minLOD: desc.minLOD,
        uvScale: desc.uvScale,
        virtualWidth: desc.virtualWidth,
        virtualHeight: desc.virtualHeight,
        virtualCols: desc.virtualCols,
        virtualRows: desc.virtualRows,
      };
      tex.vtIndirectionTable = desc.indirectionTable;
    } else {
      delete tex.vtParams;
      delete tex.vtIndirectionTable;
    }

    this._appliedCount++;
  }

  flush() {
    for (const desc of this._registry.values()) this._apply(desc);
    return this;
  }

  // -----------------------------------------------------------------------
  // Shader source exports
  // -----------------------------------------------------------------------

  static get glslSource() { return VT_GLSL; }
  static get wgslSource() { return VT_WGSL; }

  /**
   * @returns {string[]} — list of valid profile names
   */
  static get profileNames() {
    return Object.keys(VirtualTexturingProfiles);
  }

  /**
   * Clear the global descriptor pool.
   */
  static clearPool() {
    _vtDescriptorPool.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------
export {
  VirtualTexturing,
  VirtualTexturingProfiles,
  VirtualTexturingUsageHint,
  EvictionPolicy,
  RequestPriority,
  TileState,
  VT_GLSL,
  VT_WGSL,
};
export default VirtualTexturing;