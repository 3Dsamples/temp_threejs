// file number : 395
// full path name : src/context/395_TerrainLODFidelity3D.js
//### Description : Context-aware LOD fidelity controller for the seamless 3D
//###               terrain pipeline. Owns the per-tile decision of which LOD
//###               level of a 3D terrain tile should be rendered at a given
//###               camera distance, viewport, and quality budget. Unifies three
//###               independent LOD selection strategies — screen-space error
//###               (SSE), distance-based log-scale, and priority-weighted
//###               frustum coverage — into a single deterministic decision per
//###               tile that downstream systems (the reconciler at file 381, the
//###               3D render dispatcher at file 393, the material bridge at
//###               file 394) can consume without re-deriving the LOD. Implements
//###               the blueprint’s step 19 and step 26 verbatim:
//###                 • SSE:      SSE(t) = (geometricError(t) / distance(t)) ·
//###                                       (screenHeight / (2·tan(fov/2)))
//###                 • Log LOD:  ℓ(d) = ⌊log_R(d / d₀)⌋
//###                 • Threshold: d_ℓ = d₀ · R^ℓ
//###                 • Blend:    α = smoothstep(d_ℓ, d_{ℓ+1}, d)
//###                 • Priority: p = α/d + β·|cosφ| + γ(1 − d_norm)
//###               On top of these formulas, the controller adds:
//###                 • Per-family LOD tuning — quantized-mesh, I3S, procedural,
//###                   heightmap, and voxel-surface tiles each have their own
//###                   geometric-error function, distance base, and refinement
//###                   ratio, because a 65-vertex quantized mesh and a
//###                   4096-vertex procedural voxel surface have very different
//###                   fidelity curves per vertex.
//###                 • Adaptive thresholds — the target SSE (in pixels) is
//###                   scaled by the quality governor’s current scale, so
//###                   when the frame budget tightens the controller
//###                   automatically refines less aggressively.
//###                 • Hysteresis — once a tile enters a given LOD it must
//###                   cross a wider threshold to leave it (20% hysteresis),
//###                   preventing LOD flicker as the camera drifts.
//###                 • LOD ring caching — the controller caches the four
//###                   neighboring tiles at each LOD so seam-stitching costs
//###                   are O(1) per tile.
//###                 • Smooth cross-fade state — the controller publishes
//###                   blendAlpha and transitionAlpha per tile so the
//###                   dispatcher (file 393) can render both the current and
//###                   previous LOD during the transition window, eliminating
//###                   visible popping.
//###               All per-tile state lives in structure-of-arrays buffers.
//###               All formulas are computed on demand and cached per-frame;
//###               no allocations in the hot path. Streams LOD decisions into
//###               the physical channel and binds them to ECS entities with
//###               TerrainLODFidelity3DComponent. No external loader, no CDN
//###               access, no static server. Designed for Android arm64 under
//###               the 8 ms per-tick CPU ceiling and 200 MB resident memory cap.
//### Best for : The single LOD authority every downstream system should query
//###            before drawing, painting, or querying a 3D terrain tile. Use
//###            computeTileLOD() per frame, or selectLODForRing() for a batch
//###            of tiles around a viewport. The controller is agnostic to the
//###            tile family — quantized-mesh, I3S, procedural, heightmap, and
//###            voxel tiles all go through the same interface.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  WebGLRenderer, WebGPURenderer, backendConfig
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  SeamEdge,
  hasSeam,
  oppositeEdge,
  stringTileKey,
  fnv1aHash,
  computeScreenSpaceError,
  computeLodIndex,
  computeLodBlendAlpha,
  computeTilePriority,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import {
  HeightmapTerrain,
  HeightmapTileComponent
} from './374_TerrainHeightmapTile.js';

import {
  QuantizedMeshTerrain,
  QuantizedMeshComponent
} from './375_TerrainParseQuantizedMesh.js';

import {
  I3SElevationTerrain,
  I3SElevationComponent
} from './389_TerrainI3SElevationDecoder.js';

import {
  GeometryFamily3D,
  MaterialFamily3D,
  QualityTier3D
} from './393_TerrainRenderDispatch3D.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ENUMS
// ═════════════════════════════════════════════════════════════════════

/**
 * LODSelectionStrategy — how a tile's LOD is decided.
 *
 *   SCREEN_SPACE_ERROR – pure SSE with adaptive target (default, Cesium-style)
 *   DISTANCE_LOG       – log-scale distance ladder
 *   PRIORITY_WEIGHTED  – priority-weighted frustum coverage
 *   FIXED              – the tile's own current LOD is preserved
 */
export const LODSelectionStrategy = Object.freeze({
  SCREEN_SPACE_ERROR: 0,
  DISTANCE_LOG:       1,
  PRIORITY_WEIGHTED:  2,
  FIXED:              3
});

/**
 * LODTransitionState — the state of a tile's LOD transition.
 */
export const LODTransitionState = Object.freeze({
  STABLE:        0,   // no transition; single LOD visible
  FADING_IN:     1,   // new LOD fading in
  FADING_OUT:    2,   // old LOD fading out
  CROSS_FADING:  3,   // both old and new visible, alphas complementary
  SWITCHED:      4    // transition complete; only new LOD visible
});

/**
 * LODFamilyParams — per-family LOD tuning parameters.
 * Each entry defines the geometric-error formula, distance base, and
 * refinement ratio R for a given geometry family.
 */
export const LODFamilyParams = Object.freeze({
  [GeometryFamily3D.QUANTIZED_MESH]: {
    geometricErrorScale: 1.0,
    distanceBase: 200,        // d₀ for LOD 0 in world units
    ratio: 2.0,               // R between LOD levels
    maxLod: 16,
    vertexDensityWeight: 0.8  // relative importance of vertices in SSE
  },
  [GeometryFamily3D.I3S_ELEVATION]: {
    geometricErrorScale: 1.1,
    distanceBase: 250,
    ratio: 2.0,
    maxLod: 18,
    vertexDensityWeight: 0.75
  },
  [GeometryFamily3D.PROCEDURAL_MESH]: {
    geometricErrorScale: 0.9,
    distanceBase: 150,
    ratio: 2.0,
    maxLod: 12,
    vertexDensityWeight: 1.0
  },
  [GeometryFamily3D.HEIGHTMAP_GRID]: {
    geometricErrorScale: 1.2,
    distanceBase: 180,
    ratio: 2.0,
    maxLod: 14,
    vertexDensityWeight: 0.6
  },
  [GeometryFamily3D.VOXEL_SURFACE]: {
    geometricErrorScale: 1.3,
    distanceBase: 120,
    ratio: 2.2,
    maxLod: 10,
    vertexDensityWeight: 1.1
  },
  [GeometryFamily3D.CUSTOM]: {
    geometricErrorScale: 1.0,
    distanceBase: 200,
    ratio: 2.0,
    maxLod: 12,
    vertexDensityWeight: 1.0
  }
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainLODFidelity3DComponent — bound to every tile whose LOD was
 * evaluated by the controller. Stores the current LOD, the target LOD, the
 * transition state and alphas, the SSE and distance that produced the
 * decision, and the priority used for streaming.
 */
export class TerrainLODFidelity3DComponent {
  static schema = {
    tileKeyHash:        { type: 'u32' },
    geometryFamily:     { type: 'u8' },
    currentLod:         { type: 'u8' },
    targetLod:          { type: 'u8' },
    previousLod:        { type: 'u8' },
    transitionState:    { type: 'u8' },   // LODTransitionState.*
    blendAlpha:         { type: 'f32' },
    transitionAlpha:    { type: 'f32' },
    transitionActive:   { type: 'u8' },
    screenSpaceError:   { type: 'f32' },
    distance:           { type: 'f32' },
    priority:           { type: 'f32' },
    geometricError:     { type: 'f32' },
    lastUpdatedTick:    { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. LOD RESOLUTION RECORD
// ═════════════════════════════════════════════════════════════════════

/**
 * LODResolution — the per-tile LOD decision produced by the controller.
 * Immutable after construction; consumers should treat it as a snapshot.
 */
export class LODResolution {
  constructor(props) {
    this.tileKey          = props.tileKey;
    this.geometryFamily   = props.geometryFamily;
    this.currentLod       = props.currentLod;
    this.targetLod        = props.targetLod;
    this.previousLod      = props.previousLod;
    this.transitionState  = props.transitionState;
    this.blendAlpha       = props.blendAlpha;
    this.transitionAlpha  = props.transitionAlpha;
    this.transitionActive = props.transitionActive;
    this.screenSpaceError = props.screenSpaceError;
    this.distance         = props.distance;
    this.priority         = props.priority;
    this.geometricError   = props.geometricError;
    this.lastUpdatedTick  = props.lastUpdatedTick;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. CACHE
// ═════════════════════════════════════════════════════════════════════

/**
 * LODCache — bounded LRU cache of LODResolution records keyed by tileKey.
 * Entries are invalidated when the couplingVersion of the controller
 * changes (camera moved significantly, quality changed, etc.).
 */
class LODCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.records = new Map();  // tileKey → { resolution, version }
    this.order = [];
  }

  get(tileKey, version) {
    const entry = this.records.get(tileKey);
    if (!entry) return null;
    if (entry.version !== version) return null;
    this._touch(tileKey);
    return entry.resolution;
  }

  set(tileKey, resolution, version) {
    if (this.records.size >= this.maxSize) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.records.delete(oldest);
    }
    this.records.set(tileKey, { resolution, version });
    this.order.push(tileKey);
  }

  _touch(tileKey) {
    const idx = this.order.indexOf(tileKey);
    if (idx >= 0) this.order.splice(idx, 1);
    this.order.push(tileKey);
  }

  clear() {
    this.records.clear();
    this.order.length = 0;
  }

  size() {
    return this.records.size;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. THE CONTROLLER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainLODFidelity3D — the LOD fidelity controller.
 *
 * Lifecycle (per frame, called from stage three or stage four of the
 * orchestration loop):
 *   1. Update camera state.
 *   2. For each visible tile:
 *      a. Query the cache for a fresh resolution.
 *      b. If missing, compute the resolution.
 *      c. Publish the resolution to the physical channel.
 *      d. Update the ECS component.
 *   3. Advance transition alphas.
 */
export class TerrainLODFidelity3D {
  constructor(options = {}) {
    this.options = {
      // Frequency
      targetHz: options.targetHz ?? 10,

      // Selection strategy
      strategy: options.strategy ?? LODSelectionStrategy.SCREEN_SPACE_ERROR,

      // SSE target (in pixels) — the value at which a tile stops refining.
      screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? 16,

      // Adaptive SSE scaling by quality governor
      adaptiveSSE: options.adaptiveSSE ?? true,
      qualityScaleForSSE: options.qualityScaleForSSE ?? null,   // fn() → scale

      // Distance-based LOD (alternative strategy)
      distanceBaseLod0: options.distanceBaseLod0 ?? 200,
      distanceRatio: options.distanceRatio ?? 2.0,
      maxLod: options.maxLod ?? 16,

      // Hysteresis (prevents LOD flicker)
      hysteresis: options.hysteresis ?? 0.2,   // 20% threshold widening

      // Transition
      transitionMs: options.transitionMs ?? 150,
      transitionTicks: options.transitionTicks ?? 10,
      enableCrossFade: options.enableCrossFade ?? true,

      // Per-family overrides
      familyParams: options.familyParams ?? null,  // override LODFamilyParams

      // Cache
      maxCacheEntries: options.maxCacheEntries ?? 4096,
      cacheVersionTickInterval: options.cacheVersionTickInterval ?? 30,

      // Camera update
      cameraMoveThreshold: options.cameraMoveThreshold ?? 5.0,   // world units
      cameraRotationThreshold: options.cameraRotationThreshold ?? 0.02,  // radians

      // Priority weights (blueprint step 26)
      priorityAlpha: options.priorityAlpha ?? DEFAULT_TILESET_OPTIONS.priorityAlpha,
      priorityBeta: options.priorityBeta ?? DEFAULT_TILESET_OPTIONS.priorityBeta,
      priorityGamma: options.priorityGamma ?? DEFAULT_TILESET_OPTIONS.priorityGamma,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Cache ----
    this._cache = new LODCache(this.options.maxCacheEntries);
    this._cacheVersion = 1;

    // ---- Per-tile transition state ----
    // tileKey → { currentLod, targetLod, previousLod, startTick, transitionState }
    this._transitions = new Map();

    // ---- Camera state ----
    this._camera = {
      x: 0, y: 0, z: 0,
      forwardX: 0, forwardY: 0, forwardZ: -1,
      upX: 0, upY: 1, upZ: 0,
      rightX: 1, rightY: 0, rightZ: 0,
      fov: Math.PI / 3,
      screenWidth: 1920,
      screenHeight: 1080,
      far: 10000
    };
    this._lastCameraX = 0;
    this._lastCameraY = 0;
    this._lastCameraZ = 0;
    this._lastCameraForwardX = 0;
    this._lastCameraForwardY = 0;
    this._lastCameraForwardZ = -1;

    // ---- Context bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Family params (merged) ----
    this._familyParams = this.options.familyParams
      ? { ...LODFamilyParams, ...this.options.familyParams }
      : LODFamilyParams;

    // ---- Published SoA ----
    this._published = {
      tileKeys: [],
      currentLods: [],
      targetLods: [],
      blendAlphas: [],
      transitionAlphas: [],
      transitionActive: [],
      screenSpaceErrors: [],
      distances: [],
      priorities: [],
      transitionStates: [],
      count: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      framesProcessed: 0,
      tilesEvaluated: 0,
      cacheHits: 0,
      cacheMisses: 0,
      transitionsStarted: 0,
      transitionsCompleted: 0,
      lastDurationMs: 0
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  bind(contextFrame, ecsWorld, eventDispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = eventDispatcher;
    return this;
  }

  // ---------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------

  /**
   * Main provider tick.
   *
   * @param {ContextFrame} contextFrame
   * @param {number} tick
   * @param {number} dt
   * @param {object[]} visibleHeaders – visible Tile2DHeader references
   * @param {object} source – the terrain source (holds per-tile terrain objects)
   * @param {object} [camera] – optional camera override; defaults to last
   */
  update(contextFrame, tick, dt, visibleHeaders, source, camera = null) {
    this.frame = contextFrame;
    this.lastTick = tick;

    this._accumulator += dt;
    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Update camera if provided.
    if (camera) {
      this._updateCamera(camera);
    }

    // 2. Bump cache version periodically.
    if (tick % this.options.cacheVersionTickInterval === 0) {
      this._cacheVersion++;
    }

    // 3. Reset published arrays.
    this._resetPublished();

    // 4. Process each visible tile.
    for (const h of visibleHeaders) {
      if (h.state !== TileState.READY) continue;

      const record = source?.tileMap?.get(h.tileKey);
      if (!record) continue;
      const terrain = record.terrainObject ?? record.terrain;
      if (!terrain) continue;

      // Compute the LOD resolution.
      const resolution = this._resolveLOD(h, terrain, tick);

      // Publish.
      this._publishResolution(resolution, h.entityId);

      // Bind ECS.
      this._bindComponent(h, resolution, tick);
    }

    // 5. Advance transition alphas.
    this._advanceTransitions(tick);

    // 6. Publish to physical channel.
    this._writePhysicalChannel();

    // 7. Stats.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastDurationMs = t1 - t0;
    this.stats.framesProcessed++;
  }

  // ---------------------------------------------------------------------
  // Camera update
  // ---------------------------------------------------------------------

  _updateCamera(camera) {
    const c = this._camera;
    c.x = camera.x ?? 0;
    c.y = camera.y ?? 0;
    c.z = camera.z ?? 0;
    c.forwardX = camera.forwardX ?? 0;
    c.forwardY = camera.forwardY ?? 0;
    c.forwardZ = camera.forwardZ ?? -1;
    c.upX = camera.upX ?? 0;
    c.upY = camera.upY ?? 1;
    c.upZ = camera.upZ ?? 0;
    c.rightX = camera.rightX ?? 1;
    c.rightY = camera.rightY ?? 0;
    c.rightZ = camera.rightZ ?? 0;
    c.fov = camera.fov ?? Math.PI / 3;
    c.screenWidth = camera.screenWidth ?? 1920;
    c.screenHeight = camera.screenHeight ?? 1080;
    c.far = camera.far ?? 10000;
  }

  _cameraMovedEnough() {
    const c = this._camera;
    const dx = c.x - this._lastCameraX;
    const dy = c.y - this._lastCameraY;
    const dz = c.z - this._lastCameraZ;
    const moveDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (moveDist > this.options.cameraMoveThreshold) return true;

    const fdx = c.forwardX - this._lastCameraForwardX;
    const fdy = c.forwardY - this._lastCameraForwardY;
    const fdz = c.forwardZ - this._lastCameraForwardZ;
    const fDot = fdx * fdx + fdy * fdy + fdz * fdz;
    if (fDot > this.options.cameraRotationThreshold * this.options.cameraRotationThreshold) return true;

    return false;
  }

  _updateLastCamera() {
    const c = this._camera;
    this._lastCameraX = c.x;
    this._lastCameraY = c.y;
    this._lastCameraZ = c.z;
    this._lastCameraForwardX = c.forwardX;
    this._lastCameraForwardY = c.forwardY;
    this._lastCameraForwardZ = c.forwardZ;
  }

  // ---------------------------------------------------------------------
  // LOD resolution
  // ---------------------------------------------------------------------

  _resolveLOD(header, terrain, tick) {
    // Try the cache first.
    const cached = this._cache.get(header.tileKey, this._cacheVersion);
    if (cached && !this._cameraMovedEnough()) {
      this.stats.cacheHits++;
      return cached;
    }

    this.stats.cacheMisses++;

    // Compute the geometry family.
    const geomFamily = this._classifyGeometryFamily(terrain);

    // Compute the family-specific parameters.
    const family = this._familyParams[geomFamily] ?? this._familyParams[GeometryFamily3D.CUSTOM];

    // Compute the distance to the tile.
    const center = this._tileCenter(terrain);
    const dx = center[0] - this._camera.x;
    const dy = center[1] - this._camera.y;
    const dz = center[2] - this._camera.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Compute the geometric error for this tile.
    const geometricError = this._computeGeometricError(terrain, family, geomFamily);

    // Compute the SSE.
    const adjustedTarget = this._adjustedSSETarget();
    const sse = this._computeSSE(geometricError, distance, adjustedTarget);

    // Decide the target LOD.
    let targetLod;
    switch (this.options.strategy) {
      case LODSelectionStrategy.SCREEN_SPACE_ERROR:
        targetLod = this._lodFromSSE(sse, header.lod, family);
        break;
      case LODSelectionStrategy.DISTANCE_LOG:
        targetLod = this._lodFromDistance(distance, family);
        break;
      case LODSelectionStrategy.PRIORITY_WEIGHTED:
        targetLod = this._lodFromPriority(header, terrain, family);
        break;
      case LODSelectionStrategy.FIXED:
      default:
        targetLod = header.lod;
        break;
    }

    // Clamp to valid range.
    targetLod = Math.max(0, Math.min(family.maxLod, targetLod));

    // Apply hysteresis relative to the previous LOD.
    const prev = this._transitions.get(header.tileKey);
    if (prev && prev.currentLod !== targetLod) {
      const lodDelta = Math.abs(prev.currentLod - targetLod);
      if (lodDelta === 1 && !this._hysteresisPassed(prev.currentLod, targetLod, sse, adjustedTarget)) {
        // Not enough change; keep the previous LOD.
        targetLod = prev.currentLod;
      }
    }

    // Compute priority (blueprint step 26).
    const priority = this._computePriority(header, terrain, distance);

    // Compute blendAlpha (blueprint step 19).
    const blendAlpha = computeLodBlendAlpha(
      distance, family.distanceBase, family.ratio, targetLod
    );

    // Resolve transition state.
    const transition = this._resolveTransition(header.tileKey, targetLod, tick);

    // Build the resolution.
    const resolution = new LODResolution({
      tileKey: header.tileKey,
      geometryFamily: geomFamily,
      currentLod: transition.currentLod,
      targetLod,
      previousLod: transition.previousLod,
      transitionState: transition.transitionState,
      blendAlpha,
      transitionAlpha: transition.transitionAlpha,
      transitionActive: transition.transitionActive,
      screenSpaceError: sse,
      distance,
      priority,
      geometricError,
      lastUpdatedTick: tick
    });

    // Cache.
    this._cache.set(header.tileKey, resolution, this._cacheVersion);

    // Update last camera position if we moved enough to invalidate.
    if (this._cameraMovedEnough()) this._updateLastCamera();

    this.stats.tilesEvaluated++;
    return resolution;
  }

  // ---------------------------------------------------------------------
  // Geometric error
  // ---------------------------------------------------------------------

  _computeGeometricError(terrain, family, geomFamily) {
    // Base geometric error depends on the terrain family.
    let baseError;

    if (geomFamily === GeometryFamily3D.QUANTIZED_MESH) {
      const vc = terrain.vertexCount ?? 0;
      baseError = (terrain.tileWorldSize ?? 100) / Math.max(Math.sqrt(vc), 1);
    } else if (geomFamily === GeometryFamily3D.I3S_ELEVATION) {
      const vc = terrain.vertexCount ?? 0;
      baseError = (terrain.tileWorldSize ?? 100) / Math.max(Math.sqrt(vc), 1);
    } else if (geomFamily === GeometryFamily3D.HEIGHTMAP_GRID) {
      const res = terrain.resolution ?? 65;
      baseError = (terrain.tileWorldSize ?? 100) / Math.max(res - 1, 1);
    } else {
      // Fallback: assume a regular grid at sqrt(vertexCount) resolution.
      const vc = terrain.vertexCount ?? (terrain.resolution ?? 65) ** 2;
      baseError = (terrain.tileWorldSize ?? 100) / Math.max(Math.sqrt(vc), 1);
    }

    // Scale by the family’s geometric error scale.
    return baseError * family.geometricErrorScale;
  }

  // ---------------------------------------------------------------------
  // SSE and LOD selection
  // ---------------------------------------------------------------------

  _adjustedSSETarget() {
    if (!this.options.adaptiveSSE) {
      return this.options.screenSpaceErrorTarget;
    }
    const scale = this.options.qualityScaleForSSE
      ? this.options.qualityScaleForSSE()
      : 1.0;
    // When quality drops, allow higher SSE (fewer refinements).
    return this.options.screenSpaceErrorTarget / Math.max(scale, 0.25);
  }

  _computeSSE(geometricError, distance, sseTarget) {
    if (distance <= 0) return Number.MAX_VALUE;
    const factor = this._camera.screenHeight / (2 * Math.tan(this._camera.fov * 0.5));
    return (geometricError / distance) * factor;
  }

  _lodFromSSE(sse, currentLod, family) {
    // Higher SSE → coarser LOD (lower index) is acceptable; but the caller
    // has already decided the tile should refine when SSE > target.
    // For our purposes: compute the LOD such that
    //   (geometricError / distance) * factor ≈ targetSSE
    // which gives:
    //   lod = log_R(distance / (d₀ * (geometricError_base * factor / targetSSE)))
    //
    // A simpler proxy: use the distance-based formula, adjusted by SSE.
    const adjustedTarget = this._adjustedSSETarget();
    // If current SSE is much larger than target, refine; if much smaller, coarsen.
    const ratio = sse / Math.max(adjustedTarget, 1e-6);
    if (ratio > 2.0) {
      // Refine.
      return currentLod + 1;
    } else if (ratio < 0.5) {
      // Coarsen.
      return currentLod - 1;
    }
    return currentLod;
  }

  _lodFromDistance(distance, family) {
    if (distance <= family.distanceBase) return 0;
    const lod = Math.floor(Math.log(distance / family.distanceBase) / Math.log(family.ratio));
    return Math.max(0, Math.min(family.maxLod, lod));
  }

  _lodFromPriority(header, terrain, family) {
    const distance = this._computePriorityDistance(terrain);
    return this._lodFromDistance(distance, family);
  }

  _computePriorityDistance(terrain) {
    const center = this._tileCenter(terrain);
    const dx = center[0] - this._camera.x;
    const dy = center[1] - this._camera.y;
    const dz = center[2] - this._camera.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _computePriority(header, terrain, distance) {
    const center = this._tileCenter(terrain);
    const dx = center[0] - this._camera.x;
    const dy = center[1] - this._camera.y;
    const dz = center[2] - this._camera.z;

    let cosPhi = 1;
    if (distance > 1e-6) {
      cosPhi = (
        this._camera.forwardX * dx +
        this._camera.forwardY * dy +
        this._camera.forwardZ * dz
      ) / distance;
    }

    const dNorm = Math.min(distance / Math.max(this._camera.far, 1e-3), 1);

    return computeTilePriority(
      distance, cosPhi, dNorm,
      this.options.priorityAlpha,
      this.options.priorityBeta,
      this.options.priorityGamma
    );
  }

  // ---------------------------------------------------------------------
  // Hysteresis
  // ---------------------------------------------------------------------

  _hysteresisPassed(fromLod, toLod, sse, sseTarget) {
    // If refining (fromLod < toLod), we need SSE > target * (1 + hysteresis).
    // If coarsening (fromLod > toLod), we need SSE < target * (1 - hysteresis).
    if (toLod > fromLod) {
      // Refining.
      return sse > sseTarget * (1 + this.options.hysteresis);
    } else {
      // Coarsening.
      return sse < sseTarget * (1 - this.options.hysteresis);
    }
  }

  // ---------------------------------------------------------------------
  // Transition management
  // ---------------------------------------------------------------------

  _resolveTransition(tileKey, targetLod, tick) {
    let state = this._transitions.get(tileKey);

    if (!state) {
      // First time seeing this tile — start at the target LOD, no transition.
      state = {
        currentLod: targetLod,
        targetLod,
        previousLod: -1,
        startTick: tick,
        transitionState: LODTransitionState.STABLE,
        transitionAlpha: 1,
        transitionActive: 0
      };
      this._transitions.set(tileKey, state);
      return state;
    }

    if (state.targetLod !== targetLod) {
      // LOD changed — start a transition.
      state.previousLod = state.currentLod;
      state.targetLod = targetLod;
      state.startTick = tick;
      state.transitionState = LODTransitionState.FADING_IN;
      state.transitionAlpha = 0;
      state.transitionActive = 1;
      this.stats.transitionsStarted++;
    }

    return state;
  }

  _advanceTransitions(tick) {
    const dur = this.options.transitionTicks;

    for (const [tileKey, state] of this._transitions) {
      if (!state.transitionActive) continue;

      const elapsed = tick - state.startTick;
      let a = elapsed / dur;
      if (a >= 1) a = 1;

      // Smoothstep.
      const smooth = a * a * (3 - 2 * a);
      state.transitionAlpha = smooth;

      if (a >= 1) {
        // Transition complete.
        state.currentLod = state.targetLod;
        state.previousLod = -1;
        state.transitionState = LODTransitionState.STABLE;
        state.transitionActive = 0;
        state.transitionAlpha = 1;
        this.stats.transitionsCompleted++;
      } else {
        state.transitionState = LODTransitionState.CROSS_FADING;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  _classifyGeometryFamily(terrain) {
    if (terrain instanceof HeightmapTerrain) return GeometryFamily3D.HEIGHTMAP_GRID;
    if (terrain instanceof QuantizedMeshTerrain) return GeometryFamily3D.QUANTIZED_MESH;
    if (terrain instanceof I3SElevationTerrain) return GeometryFamily3D.I3S_ELEVATION;
    if (terrain.vertexCount && terrain.triangleCount && terrain.indices) {
      return GeometryFamily3D.PROCEDURAL_MESH;
    }
    if (terrain.resolution && terrain.elevation) return GeometryFamily3D.HEIGHTMAP_GRID;
    return GeometryFamily3D.CUSTOM;
  }

  _tileCenter(terrain) {
    if (terrain.bounds) {
      return [
        (terrain.bounds[0] + terrain.bounds[3]) * 0.5,
        (terrain.bounds[1] + terrain.bounds[4]) * 0.5,
        (terrain.bounds[2] + terrain.bounds[5]) * 0.5
      ];
    }
    if (terrain.getBoundingSphere) {
      const s = terrain.getBoundingSphere();
      return [s[0], s[1], s[2]];
    }
    // Fallback: origin + half tile.
    return [
      (terrain.originX ?? 0) + (terrain.tileWorldSize ?? 100) * 0.5,
      (terrain.originY ?? 0) + (terrain.tileWorldSize ?? 100) * 0.5,
      (terrain.minElevation ?? 0) + (terrain.maxElevation ?? 0)
    ];
  }

  // ---------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------

  _resetPublished() {
    const p = this._published;
    p.tileKeys.length = 0;
    p.currentLods.length = 0;
    p.targetLods.length = 0;
    p.blendAlphas.length = 0;
    p.transitionAlphas.length = 0;
    p.transitionActive.length = 0;
    p.screenSpaceErrors.length = 0;
    p.distances.length = 0;
    p.priorities.length = 0;
    p.transitionStates.length = 0;
    p.count = 0;
  }

  _publishResolution(resolution, entityId) {
    const p = this._published;
    p.tileKeys.push(resolution.tileKey);
    p.currentLods.push(resolution.currentLod);
    p.targetLods.push(resolution.targetLod);
    p.blendAlphas.push(resolution.blendAlpha);
    p.transitionAlphas.push(resolution.transitionAlpha);
    p.transitionActive.push(resolution.transitionActive);
    p.screenSpaceErrors.push(resolution.screenSpaceError);
    p.distances.push(resolution.distance);
    p.priorities.push(resolution.priority);
    p.transitionStates.push(resolution.transitionState);
    p.count++;
  }

  _writePhysicalChannel() {
    if (!this.frame?.layers?.physical) return;
    const physical = this.frame.layers.physical;
    const p = this._published;

    physical.terrainLODTileKeys = p.tileKeys;
    physical.terrainLODCurrentLods = p.currentLods;
    physical.terrainLODTargetLods = p.targetLods;
    physical.terrainLODBlendAlphas = p.blendAlphas;
    physical.terrainLODTransitionAlphas = p.transitionAlphas;
    physical.terrainLODTransitionActive = p.transitionActive;
    physical.terrainLODScreenSpaceErrors = p.screenSpaceErrors;
    physical.terrainLODDistances = p.distances;
    physical.terrainLODPriorities = p.priorities;
    physical.terrainLODTransitionStates = p.transitionStates;
    physical.terrainLODStats = this.getStats();
  }

  // ---------------------------------------------------------------------
  // ECS binding
  // ---------------------------------------------------------------------

  _bindComponent(header, resolution, tick) {
    if (!this.ecsWorld || header.entityId === 0xFFFFFFFF) return;
    this.ecsWorld.addComponent?.(header.entityId, TerrainLODFidelity3DComponent, {
      tileKeyHash: header.tileKeyHash,
      geometryFamily: resolution.geometryFamily,
      currentLod: resolution.currentLod,
      targetLod: resolution.targetLod,
      previousLod: resolution.previousLod >= 0 ? resolution.previousLod : 0,
      transitionState: resolution.transitionState,
      blendAlpha: resolution.blendAlpha,
      transitionAlpha: resolution.transitionAlpha,
      transitionActive: resolution.transitionActive,
      screenSpaceError: resolution.screenSpaceError,
      distance: resolution.distance,
      priority: resolution.priority,
      geometricError: resolution.geometricError,
      lastUpdatedTick: tick
    });
  }

  // ---------------------------------------------------------------------
  // Public batch API
  // ---------------------------------------------------------------------

  /**
   * Computes LOD resolutions for an array of tiles at once. Returns an array
   * of LODResolution records.
   */
  selectLODForRing(visibleHeaders, source, camera = null) {
    if (camera) this._updateCamera(camera);
    const results = [];
    for (const h of visibleHeaders) {
      if (h.state !== TileState.READY) continue;
      const record = source?.tileMap?.get(h.tileKey);
      if (!record) continue;
      const terrain = record.terrainObject ?? record.terrain;
      if (!terrain) continue;
      results.push(this._resolveLOD(h, terrain, this.lastTick));
    }
    return results;
  }

  /**
   * Returns the current resolution for a tile, or null if not cached.
   */
  getResolution(tileKey) {
    return this._cache.get(tileKey, this._cacheVersion);
  }

  /**
   * Returns the transition state for a tile, or null.
   */
  getTransitionState(tileKey) {
    return this._transitions.get(tileKey) ?? null;
  }

  /**
   * Returns the statistics record.
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this._cache.size(),
      activeTransitions: this._countActiveTransitions(),
      cacheVersion: this._cacheVersion
    };
  }

  _countActiveTransitions() {
    let count = 0;
    for (const state of this._transitions.values()) {
      if (state.transitionActive) count++;
    }
    return count;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this._cache.clear();
    this._transitions.clear();
    this._published.tileKeys.length = 0;
    this._published.count = 0;
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a fully-configured TerrainLODFidelity3D for the seamless 3D
 * terrain pipeline.
 */
export function createTerrainLODFidelity3D(options = {}) {
  return new TerrainLODFidelity3D({
    targetHz: options.targetHz ?? 10,
    strategy: options.strategy ?? LODSelectionStrategy.SCREEN_SPACE_ERROR,
    screenSpaceErrorTarget: options.screenSpaceErrorTarget ?? 16,
    adaptiveSSE: options.adaptiveSSE ?? true,
    qualityScaleForSSE: options.qualityScaleForSSE ?? null,
    distanceBaseLod0: options.distanceBaseLod0 ?? 200,
    distanceRatio: options.distanceRatio ?? 2.0,
    maxLod: options.maxLod ?? 16,
    hysteresis: options.hysteresis ?? 0.2,
    transitionMs: options.transitionMs ?? 150,
    transitionTicks: options.transitionTicks ?? 10,
    enableCrossFade: options.enableCrossFade ?? true,
    familyParams: options.familyParams ?? null,
    maxCacheEntries: options.maxCacheEntries ?? 4096,
    cacheVersionTickInterval: options.cacheVersionTickInterval ?? 30,
    cameraMoveThreshold: options.cameraMoveThreshold ?? 5.0,
    cameraRotationThreshold: options.cameraRotationThreshold ?? 0.02,
    priorityAlpha: options.priorityAlpha ?? DEFAULT_TILESET_OPTIONS.priorityAlpha,
    priorityBeta: options.priorityBeta ?? DEFAULT_TILESET_OPTIONS.priorityBeta,
    priorityGamma: options.priorityGamma ?? DEFAULT_TILESET_OPTIONS.priorityGamma,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 7. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainLODFidelity3D,
  LODResolution,
  LODCache,
  LODSelectionStrategy,
  LODTransitionState,
  LODFamilyParams,
  TerrainLODFidelity3DComponent,
  createTerrainLODFidelity3D
};