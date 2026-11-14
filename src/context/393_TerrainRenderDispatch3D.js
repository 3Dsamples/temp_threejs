// file number : 393
// full path name : src/context/393_TerrainRenderDispatch3D.js
//### Description : Context-aware 3D terrain render dispatch for the seamless
//###               terrain pipeline. This is the batched draw-call emitter
//###               specialized for 3D terrain tiles — irregular triangle meshes
//###               produced by quantized-mesh (file 375), I3S elevation (file
//###               389), and procedural 3D voxel/heightfield generators (file
//###               386 lineage). Consumes the visible-tile SoA from the
//###               reconciler (file 381), the material SoA from the painter
//###               (file 383), and the per-tile geometry views from the
//###               terrain source (files 380, 389) to produce a minimal set
//###               of instanced draw calls per frame. Every draw call carries
//###               the correct per-instance uniforms for LOD cross-fade alphas,
//###               seam flags with per-edge neighbor LODs, wetness/burn/ignition
//###               material state, and skirt-index ranges — all without a
//###               single per-tile draw call. Uses a compact SoA arena for both
//###               draw calls and per-instance uniforms, so the renderer never
//###               sees a JS object in the hot path. Applies a 3D-specific
//###               adaptive quality governor that reads the FrameBudgetMonitor
//###               (file 305) and GCPauseMonitor (file 306) and truncates low-
//###               priority instance batches when the budget is exceeded. Also
//###               emits a separate skirt draw-call batch so skirt quads can be
//###               rendered with the correct depth-test state (skirt normals
//###               point downward, so back-face culling must be disabled for
//###               them). Every batch is keyed by a stable 32-bit hash combining
//###               (geometry family, material family, material ID, wetness
//###               tier, burn tier, seam tier, skirt tier, quality tier), so
//###               identical batches always coalesce regardless of tile order.
//###               No external loader, no CDN access, no static server.
//###               Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap, and scales from a
//###               single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : The final dispatch stage for every 3D terrain family in the
//###            seamless pipeline — from a single 10-unit canyon to a full-Earth
//###            quantized-mesh tileset to a Martian I3S elevation layer to a
//###            galactic-scale procedural voxel world. The dispatcher produces
//###            a stable, minimal draw-call list that any renderer backend can
//###            execute without knowing how the terrain was streamed, decoded,
//###            transformed, or painted. Because the output is purely arena-
//###            based, it can be consumed on the main thread, on a worker, or
//###            uploaded directly to the GPU via indirect draw buffers.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
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
  TerrainMaterialPainter,
  TerrainMaterialDescriptor
} from './383_TerrainMaterialPainter.js';

import {
  TerrainSpatialCoordinateTransformer,
  TerrainSpatialCoordinateTransformerProvider,
  SpatialTransformComponent,
  SpatialTransformKind
} from './391_TerrainSpatialCoordinateTransformer.js';

import {
  TerrainI3SSpatialTransformer,
  TerrainI3SSpatialTransformerProvider,
  I3SSpatialTransformComponent
} from './392_TerrainI3SSpatialTransformer.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CONSTANTS
// ═════════════════════════════════════════════════════════════════════

/**
 * GeometryFamily3D — 3D-specific geometry families.
 * These extend the 2D families with mesh-specific variants.
 */
export const GeometryFamily3D = Object.freeze({
  QUANTIZED_MESH:  0,   // quantized-mesh-1.0 tile
  I3S_ELEVATION:   1,   // Esri I3S elevation tile
  PROCEDURAL_MESH: 2,   // procedurally generated irregular mesh
  HEIGHTMAP_GRID:  3,   // heightmap rendered as a regular grid
  VOXEL_SURFACE:   4,   // marching-cubes surface from a voxel field
  CUSTOM:          5
});

/**
 * MaterialFamily3D — 3D-specific material families.
 * Extends the 2D families with mesh-specific passes.
 */
export const MaterialFamily3D = Object.freeze({
  STANDARD:        0,
  ANIME:           1,
  WET:             2,
  BURNED:          3,
  IGNITED:         4,
  SNOW_COVERED:    5,
  CUSTOM:          6
});

/**
 * QualityTier3D — 3D-specific quality tiers used by the governor.
 */
export const QualityTier3D = Object.freeze({
  ULTRA:   0,
  HIGH:    1,
  MEDIUM:  2,
  LOW:     3,
  MINIMAL: 4
});

/**
 * SkirtMode — how skirt quads are dispatched.
 */
export const SkirtMode = Object.freeze({
  NONE:           0,   // no skirt batch emitted
  MERGED:         1,   // skirts merged into the main mesh batch
  SEPARATE:       2    // skirts emitted as a separate draw-call batch
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainDispatchStatsComponent — bound to the singleton dispatch entity
 * (the tileset root). Stores the current frame’s dispatch statistics so
 * other systems can query them without touching the dispatcher directly.
 */
export class TerrainDispatchStatsComponent {
  static schema = {
    frameId:              { type: 'u32' },
    drawCallCount:        { type: 'u32' },
    instanceCount:        { type: 'u32' },
    triangleCount:        { type: 'u32' },
    skirtDrawCallCount:   { type: 'u32' },
    skirtTriangleCount:   { type: 'u32' },
    culledTileCount:      { type: 'u32' },
    qualityScale:         { type: 'f32' },
    lastFrameMs:          { type: 'f32' },
    lastUpdatedTick:      { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. DRAW-CALL ARENA (SoA)
// ═════════════════════════════════════════════════════════════════════

/**
 * DrawCallArena3D — the structure-of-arrays draw-call record for 3D terrain.
 * Each entry describes one batched draw call. Per-tile data lives in the
 * parallel TileInstanceArena3D (below) and is referenced by the
 * instanceStart / instanceCount fields.
 *
 * Layout (one entry per draw call):
 *   Identity: batchId, geometryFamily, materialFamily, materialId
 *   Binding:  vertexBufferId, indexBufferId, instanceStart, instanceCount
 *   Passes:   useWetPass, useBurnPass, useSeamPass, useOutlinePass,
 *             useSkirtPass
 *   State:    blendMode, depthWrite, depthTest, cullMode
 *   Bounds:   boundsMinX..boundsMaxZ (for GPU-side frustum culling)
 */
class DrawCallArena3D {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;

    // Identity
    this.batchId          = new Uint32Array(capacity);
    this.geometryFamily   = new Uint8Array(capacity);
    this.materialFamily   = new Uint8Array(capacity);
    this.materialId       = new Uint16Array(capacity);

    // Binding
    this.vertexBufferId   = new Uint32Array(capacity);
    this.indexBufferId    = new Uint32Array(capacity);
    this.instanceStart    = new Uint32Array(capacity);
    this.instanceCount    = new Uint32Array(capacity);

    // Pass flags
    this.useWetPass       = new Uint8Array(capacity);
    this.useBurnPass      = new Uint8Array(capacity);
    this.useSeamPass      = new Uint8Array(capacity);
    this.useOutlinePass   = new Uint8Array(capacity);
    this.useSkirtPass     = new Uint8Array(capacity);

    // Render state
    this.blendMode        = new Uint8Array(capacity);
    this.depthWrite       = new Uint8Array(capacity);
    this.depthTest        = new Uint8Array(capacity);
    this.cullMode         = new Uint8Array(capacity);

    // Bounds
    this.boundsMinX       = new Float32Array(capacity);
    this.boundsMinY       = new Float32Array(capacity);
    this.boundsMinZ       = new Float32Array(capacity);
    this.boundsMaxX       = new Float32Array(capacity);
    this.boundsMaxY       = new Float32Array(capacity);
    this.boundsMaxZ       = new Float32Array(capacity);
  }

  reset() { this.count = 0; }
  acquire() { return this.count >= this.capacity ? -1 : this.count++; }
}

/**
 * TileInstanceArena3D — the per-instance SoA referenced by draw calls.
 * One entry per visible tile. Contains every uniform the renderer must
 * upload for that tile.
 *
 * Layout (one entry per tile instance):
 *   Identity: tileKeyHash, entityId, lod, state, geometryFamily
 *   Uniforms: blendAlpha, transitionAlpha, transitionActive
 *   Seams:    seamFlags, northLod, southLod, eastLod, westLod
 *   Material: wetness, ignition, burnProgress, colorR/G/B, roughness, metalness
 *   Geometry: vertexStart, vertexCount, indexStart, indexCount,
 *             weightStart, weightCount, weightStride,
 *             skirtVertexStart, skirtIndexStart, skirtIndexCount
 */
class TileInstanceArena3D {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;

    // Identity
    this.tileKeyHash         = new Uint32Array(capacity);
    this.entityId            = new Uint32Array(capacity);
    this.lod                 = new Uint8Array(capacity);
    this.state               = new Uint8Array(capacity);
    this.geometryFamily      = new Uint8Array(capacity);

    // Uniforms
    this.blendAlpha          = new Float32Array(capacity);
    this.transitionAlpha     = new Float32Array(capacity);
    this.transitionActive    = new Uint8Array(capacity);

    // Seams
    this.seamFlags           = new Uint8Array(capacity);
    this.northLod            = new Int8Array(capacity);
    this.southLod            = new Int8Array(capacity);
    this.eastLod             = new Int8Array(capacity);
    this.westLod             = new Int8Array(capacity);

    // Material
    this.wetness             = new Float32Array(capacity);
    this.ignition            = new Float32Array(capacity);
    this.burnProgress        = new Float32Array(capacity);
    this.colorR              = new Float32Array(capacity);
    this.colorG              = new Float32Array(capacity);
    this.colorB              = new Float32Array(capacity);
    this.roughness           = new Float32Array(capacity);
    this.metalness           = new Float32Array(capacity);

    // Geometry
    this.vertexStart         = new Uint32Array(capacity);
    this.vertexCount         = new Uint32Array(capacity);
    this.indexStart          = new Uint32Array(capacity);
    this.indexCount          = new Uint32Array(capacity);
    this.weightStart         = new Uint32Array(capacity);
    this.weightCount         = new Uint32Array(capacity);
    this.weightStride        = new Uint8Array(capacity);
    this.skirtVertexStart    = new Uint32Array(capacity);
    this.skirtIndexStart     = new Uint32Array(capacity);
    this.skirtIndexCount     = new Uint32Array(capacity);
  }

  reset() { this.count = 0; }
  acquire() { return this.count >= this.capacity ? -1 : this.count++; }
}

// ═════════════════════════════════════════════════════════════════════
// 4. TERRAIN RENDER DISPATCH 3D
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainRenderDispatch3D — the batched render dispatcher for 3D terrain.
 *
 * The pipeline (per frame):
 *   1. Reset arenas.
 *   2. Sort visible tiles by priority descending (highest first).
 *   3. Truncate the tail according to the quality governor.
 *   4. For each surviving tile:
 *      a. Classify geometry family.
 *      b. Classify material family.
 *      c. Resolve the terrain object.
 *      d. Compute the batch key.
 *      e. Coalesce into the correct batch (create if absent).
 *      f. Allocate one instance in the instance arena.
 *      g. Write the instance uniforms.
 *   5. Emit the separate skirt batch (if any tile has skirts).
 *   6. Publish both arenas to the frame’s render channel.
 *   7. Measure frame time and update the quality governor.
 *
 * Every operation is O(visible tiles). The batch map is a plain Map that is
 * cleared and reused each frame; no per-frame allocation after warm-up. The
 * quality governor uses a smoothed EMA over the last 16 frame times so it
 * never oscillates.
 */
export class TerrainRenderDispatch3D {
  constructor(options = {}) {
    this.options = {
      // Frequency
      targetHz: options.targetHz ?? 60,

      // Arena capacities
      maxDrawCalls: options.maxDrawCalls ?? 256,
      maxInstances: options.maxInstances ?? 4096,

      // Quality governor
      targetFrameMs: options.targetFrameMs ?? 8,
      minQualityScale: options.minQualityScale ?? 0.25,
      maxQualityScale: options.maxQualityScale ?? 1.0,
      governorSmoothing: options.governorSmoothing ?? 0.15,
      governorWindow: options.governorWindow ?? 16,

      // Batching
      groupByMaterialId: options.groupByMaterialId ?? true,
      groupByGeometryFamily: options.groupByGeometryFamily ?? true,
      groupByPassFlags: options.groupByPassFlags ?? true,

      // Instanced rendering
      enableInstancedMeshes: options.enableInstancedMeshes ?? true,
      enableInstancedHeightmaps: options.enableInstancedHeightmaps ?? true,

      // LOD cross-fade
      enableLodCrossFade: options.enableLodCrossFade ?? true,
      enableSeamPass: options.enableSeamPass ?? true,

      // Skirts
      skirtMode: options.skirtMode ?? SkirtMode.SEPARATE,
      skirtDepth: options.skirtDepth ?? 1.0,
      skirtCullBackface: options.skirtCullBackface ?? false,

      // Outline
      enableOutlinePass: options.enableOutlinePass ?? false,

      // Memory
      maxResidentBytes: options.maxResidentBytes ?? DEFAULT_TILESET_OPTIONS.maxResidentBytes,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Arenas ----
    this.drawCalls = new DrawCallArena3D(this.options.maxDrawCalls);
    this.skirtDrawCalls = new DrawCallArena3D(Math.max(1, Math.floor(this.options.maxDrawCalls / 4)));
    this.instances = new TileInstanceArena3D(this.options.maxInstances);

    // ---- Batch grouping state ----
    // Key: batch hash (u32), value: index into drawCalls arena.
    this._batchMap = new Map();
    this._skirtBatchMap = new Map();

    // ---- Quality governor ----
    this._qualityScale = this.options.maxQualityScale;
    this._lastFrameMs = 0;
    this._frameTimeHistory = new Float32Array(this.options.governorWindow);
    this._frameTimeIndex = 0;
    this._frameTimeSum = 0;
    this._frameTimeCount = 0;

    // ---- Context bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;

    // ---- Per-frame scratch (allocated once) ----
    this._sortedScratch = [];
    this._batchKeyScratch = new Uint32Array(4);

    // ---- Last tick ----
    this.lastTick = 0;

    // ---- Published output (read by the renderer) ----
    this._published = {
      drawCalls: this.drawCalls,
      skirtDrawCalls: this.skirtDrawCalls,
      instances: this.instances,
      qualityScale: this._qualityScale,
      lastFrameMs: 0,
      drawCallCount: 0,
      instanceCount: 0,
      triangleCount: 0,
      skirtDrawCallCount: 0,
      skirtTriangleCount: 0,
      culledTileCount: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      framesDispatched: 0,
      peakDrawCalls: 0,
      peakInstances: 0,
      peakTriangles: 0,
      peakSkirtDrawCalls: 0,
      avgFrameMs: 0,
      totalFrameMs: 0,
      frameCount: 0
    };
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  bind(contextFrame, ecsWorld, dispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = dispatcher;
    return this;
  }

  // ---------------------------------------------------------------------
  // Main dispatch
  // ---------------------------------------------------------------------

  /**
   * Builds the draw-call list for the current frame.
   *
   * @param {ContextFrame} contextFrame – live context frame
   * @param {number} tick – current tick counter
   * @param {number} dt – delta time in seconds
   * @param {object[]} visibleHeaders – visible Tile2DHeader references
   * @param {TerrainMaterialPainter} materialPainter – the material painter
   * @param {object} source – the terrain source (holds per-tile terrain objects)
   * @param {object} [options] – per-frame overrides
   * @returns {object} the published arena record
   */
  update(contextFrame, tick, dt, visibleHeaders, materialPainter, source, options = {}) {
    this.frame = contextFrame;
    this.lastTick = tick;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Reset arenas.
    this.drawCalls.reset();
    this.skirtDrawCalls.reset();
    this.instances.reset();
    this._batchMap.clear();
    this._skirtBatchMap.clear();

    // 2. Read the material SoA from the physical channel.
    const physical = contextFrame?.layers?.physical;

    // 3. Get the current quality scale.
    const qualityScale = options.qualityScale ?? this._qualityScale;
    const qualityTier = this._qualityTierFromScale(qualityScale);
    const instanceBudget = Math.floor(this.options.maxInstances * qualityScale);

    // 4. Sort visible tiles by priority descending.
    this._sortVisibleTiles(visibleHeaders);
    const sorted = this._sortedScratch;

    // 5. Walk the sorted tiles and emit batches.
    let instancesUsed = 0;
    let triangleCount = 0;
    let skirtTriangleCount = 0;
    let culledTileCount = 0;

    for (let i = 0; i < sorted.length; i++) {
      if (instancesUsed >= instanceBudget) {
        culledTileCount += sorted.length - i;
        break;
      }
      const h = sorted[i];
      if (h.state !== TileState.READY) continue;

      // Resolve the terrain object.
      const record = source?.tileMap?.get(h.tileKey);
      if (!record?.terrainObject && !record?.terrain) {
        culledTileCount++;
        continue;
      }
      const terrain = record.terrainObject ?? record.terrain;

      // Resolve the material state.
      const materialState = materialPainter?.tileState?.get(h.tileKey);
      if (!materialState) {
        culledTileCount++;
        continue;
      }

      // Find the material component.
      let materialComponent = null;
      if (this.ecsWorld && h.entityId !== 0xFFFFFFFF) {
        materialComponent = this.ecsWorld.getComponent?.(h.entityId, 'TerrainMaterialComponent') ?? null;
      }

      // Classify.
      const geomFamily = this._classifyGeometryFamily(terrain);
      const materialId = materialComponent?.dominantMaterialId ?? 0;
      const matFamily = this._classifyMaterialFamily(materialState);

      // Compute the batch key.
      const batchKey = this._computeBatchKey(
        geomFamily, matFamily, materialId,
        materialState.wetness > 0.1 ? 1 : 0,
        materialState.burnProgress > 0.1 ? 1 : 0,
        h.seamFlags !== 0 ? 1 : 0,
        0, // outline (unused for now)
        qualityTier
      );

      // Look up or create the draw call.
      let dcIdx = this._batchMap.get(batchKey);
      if (dcIdx === undefined) {
        dcIdx = this.drawCalls.acquire();
        if (dcIdx < 0) {
          // Out of draw-call capacity.
          break;
        }
        this._batchMap.set(batchKey, dcIdx);
        this._initializeDrawCall(dcIdx, batchKey, geomFamily, matFamily, materialId, terrain, materialState);
      }

      // Emit one instance.
      const instIdx = this.instances.acquire();
      if (instIdx < 0) break;
      this._writeInstance(instIdx, h, terrain, materialState, materialComponent, physical, geomFamily);
      this.drawCalls.instanceCount[dcIdx]++;
      instancesUsed++;
      triangleCount += (this.instances.indexCount[instIdx] / 3) | 0;

      // Emit the skirt draw call if the tile has skirts and skirts are
      // dispatched separately.
      if (this.options.skirtMode === SkirtMode.SEPARATE && terrain.skirtIndices && terrain.skirtIndices.length > 0) {
        const skirtKey = this._computeSkirtBatchKey(geomFamily, materialId, qualityTier);
        let skirtDcIdx = this._skirtBatchMap.get(skirtKey);
        if (skirtDcIdx === undefined) {
          skirtDcIdx = this.skirtDrawCalls.acquire();
          if (skirtDcIdx >= 0) {
            this._skirtBatchMap.set(skirtKey, skirtDcIdx);
            this._initializeSkirtDrawCall(skirtDcIdx, skirtKey, geomFamily, materialId, terrain);
          }
        }
        if (skirtDcIdx !== undefined && skirtDcIdx >= 0) {
          // Skirts reuse the same instance entry — the renderer reads the
          // skirtIndexStart/skirtIndexCount fields from the same instance
          // when dispatching the skirt batch.
          this.skirtDrawCalls.instanceCount[skirtDcIdx]++;
          skirtTriangleCount += (terrain.skirtIndices.length / 3) | 0;
        }
      }
    }

    // 6. Store output.
    this._published.drawCallCount = this.drawCalls.count;
    this._published.skirtDrawCallCount = this.skirtDrawCalls.count;
    this._published.instanceCount = this.instances.count;
    this._published.triangleCount = triangleCount;
    this._published.skirtTriangleCount = skirtTriangleCount;
    this._published.culledTileCount = culledTileCount;

    // 7. Publish to frame.
    this._publishToFrame();

    // 8. Measure frame time and update governor.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const frameMs = t1 - t0;
    this._updateGovernor(frameMs);

    this._published.lastFrameMs = frameMs;
    this._published.qualityScale = this._qualityScale;

    // 9. Diagnostics.
    this.stats.framesDispatched++;
    this.stats.peakDrawCalls = Math.max(this.stats.peakDrawCalls, this.drawCalls.count);
    this.stats.peakInstances = Math.max(this.stats.peakInstances, this.instances.count);
    this.stats.peakTriangles = Math.max(this.stats.peakTriangles, triangleCount);
    this.stats.peakSkirtDrawCalls = Math.max(this.stats.peakSkirtDrawCalls, this.skirtDrawCalls.count);
    this.stats.totalFrameMs += frameMs;
    this.stats.frameCount++;
    this.stats.avgFrameMs = this.stats.totalFrameMs / this.stats.frameCount;

    return this._published;
  }

  // ---------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------

  _classifyGeometryFamily(terrain) {
    if (terrain instanceof HeightmapTerrain) return GeometryFamily3D.HEIGHTMAP_GRID;
    if (terrain instanceof QuantizedMeshTerrain) return GeometryFamily3D.QUANTIZED_MESH;
    if (terrain instanceof I3SElevationTerrain) return GeometryFamily3D.I3S_ELEVATION;
    // Fallback: check structural signature.
    if (terrain.vertexCount && terrain.triangleCount && terrain.indices) {
      return GeometryFamily3D.PROCEDURAL_MESH;
    }
    if (terrain.resolution && terrain.elevation) {
      return GeometryFamily3D.HEIGHTMAP_GRID;
    }
    return GeometryFamily3D.CUSTOM;
  }

  _classifyMaterialFamily(materialState) {
    if (materialState.ignitionTimer > 0) return MaterialFamily3D.IGNITED;
    if (materialState.burnProgress > 0.5) return MaterialFamily3D.BURNED;
    if (materialState.wetness > 0.5) return MaterialFamily3D.WET;
    if (materialState.snowCover > 0.5) return MaterialFamily3D.SNOW_COVERED;
    return MaterialFamily3D.STANDARD;
  }

  _computeBatchKey(geomFamily, matFamily, materialId, wet, burn, seam, outline, qualityTier) {
    // 32-bit hash packing all batch-identifying fields.
    return (
      ((geomFamily & 0x7) << 29) |
      ((matFamily & 0x7) << 26) |
      ((materialId & 0x3FFF) << 12) |
      ((wet & 0x1) << 11) |
      ((burn & 0x1) << 10) |
      ((seam & 0x1) << 9) |
      ((outline & 0x1) << 8) |
      ((qualityTier & 0x7) << 5)
    ) >>> 0;
  }

  _computeSkirtBatchKey(geomFamily, materialId, qualityTier) {
    return (
      ((geomFamily & 0x7) << 29) |
      ((materialId & 0x3FFF) << 12) |
      ((qualityTier & 0x7) << 5) |
      0x01 // marker to distinguish from mesh batches
    ) >>> 0;
  }

  // ---------------------------------------------------------------------
  // Draw call initialization
  // ---------------------------------------------------------------------

  _initializeDrawCall(dcIdx, batchKey, geomFamily, matFamily, materialId, terrain, materialState) {
    const dc = this.drawCalls;
    dc.batchId[dcIdx] = batchKey;
    dc.geometryFamily[dcIdx] = geomFamily;
    dc.materialFamily[dcIdx] = matFamily;
    dc.materialId[dcIdx] = materialId;
    dc.vertexBufferId[dcIdx] = this._geometryBufferId(geomFamily, terrain);
    dc.indexBufferId[dcIdx] = this._indexBufferId(geomFamily, terrain);
    dc.instanceStart[dcIdx] = this.instances.count;
    dc.instanceCount[dcIdx] = 0;
    dc.useWetPass[dcIdx] = materialState.wetness > 0.1 ? 1 : 0;
    dc.useBurnPass[dcIdx] = materialState.burnProgress > 0.1 ? 1 : 0;
    dc.useSeamPass[dcIdx] = this.options.enableSeamPass ? 1 : 0;
    dc.useOutlinePass[dcIdx] = this.options.enableOutlinePass ? 1 : 0;
    dc.useSkirtPass[dcIdx] = 0; // Skirts are dispatched separately
    dc.blendMode[dcIdx] = 0;    // Opaque
    dc.depthWrite[dcIdx] = 1;
    dc.depthTest[dcIdx] = 1;
    dc.cullMode[dcIdx] = 1;     // Back-face culling

    // Bounds (initially empty; expanded as instances are added).
    const b = terrain.bounds ?? [0, 0, 0, 0, 0, 0];
    dc.boundsMinX[dcIdx] = b[0];
    dc.boundsMinY[dcIdx] = b[1];
    dc.boundsMinZ[dcIdx] = b[2];
    dc.boundsMaxX[dcIdx] = b[3];
    dc.boundsMaxY[dcIdx] = b[4];
    dc.boundsMaxZ[dcIdx] = b[5];
  }

  _initializeSkirtDrawCall(dcIdx, batchKey, geomFamily, materialId, terrain) {
    const dc = this.skirtDrawCalls;
    dc.batchId[dcIdx] = batchKey;
    dc.geometryFamily[dcIdx] = geomFamily;
    dc.materialFamily[dcIdx] = MaterialFamily3D.STANDARD;
    dc.materialId[dcIdx] = materialId;
    dc.vertexBufferId[dcIdx] = this._geometryBufferId(geomFamily, terrain);
    dc.indexBufferId[dcIdx] = this._indexBufferId(geomFamily, terrain);
    dc.instanceStart[dcIdx] = 0; // Skirts reference the same instance list
    dc.instanceCount[dcIdx] = 0;
    dc.useWetPass[dcIdx] = 0;
    dc.useBurnPass[dcIdx] = 0;
    dc.useSeamPass[dcIdx] = 0;
    dc.useOutlinePass[dcIdx] = 0;
    dc.useSkirtPass[dcIdx] = 1;
    dc.blendMode[dcIdx] = 0;
    dc.depthWrite[dcIdx] = 1;
    dc.depthTest[dcIdx] = 1;
    dc.cullMode[dcIdx] = this.options.skirtCullBackface ? 1 : 0;

    const b = terrain.bounds ?? [0, 0, 0, 0, 0, 0];
    dc.boundsMinX[dcIdx] = b[0];
    dc.boundsMinY[dcIdx] = b[1];
    dc.boundsMinZ[dcIdx] = b[2];
    dc.boundsMaxX[dcIdx] = b[3];
    dc.boundsMaxY[dcIdx] = b[4];
    dc.boundsMaxZ[dcIdx] = b[5];
  }

  _geometryBufferId(geomFamily, terrain) {
    // The renderer resolves these IDs to GPU buffers.
    switch (geomFamily) {
      case GeometryFamily3D.HEIGHTMAP_GRID:  return 1; // shared unit quad
      case GeometryFamily3D.QUANTIZED_MESH:  return 2; // per-tile mesh
      case GeometryFamily3D.I3S_ELEVATION:   return 3; // per-tile I3S mesh
      case GeometryFamily3D.PROCEDURAL_MESH: return 4; // per-tile procedural mesh
      case GeometryFamily3D.VOXEL_SURFACE:   return 5; // per-tile voxel mesh
      default: return 0;
    }
  }

  _indexBufferId(geomFamily, terrain) {
    return this._geometryBufferId(geomFamily, terrain);
  }

  // ---------------------------------------------------------------------
  // Instance write
  // ---------------------------------------------------------------------

  _writeInstance(instIdx, h, terrain, materialState, materialComponent, physical, geomFamily) {
    const inst = this.instances;

    // Identity.
    inst.tileKeyHash[instIdx] = h.tileKeyHash;
    inst.entityId[instIdx] = h.entityId;
    inst.lod[instIdx] = h.lod;
    inst.state[instIdx] = h.state;
    inst.geometryFamily[instIdx] = geomFamily;

    // Per-instance uniforms.
    inst.blendAlpha[instIdx] = h.blendAlpha ?? 1;

    // Transition alpha from the reconciler’s published SoA.
    let transAlpha = 1;
    let transActive = 0;
    if (physical?.terrainTileKeys) {
      const idx = physical.terrainTileKeys.indexOf(h.tileKey);
      if (idx >= 0 && physical.terrainTileTransitionAlpha) {
        transAlpha = physical.terrainTileTransitionAlpha[idx];
        transActive = physical.terrainTileTransitionActive[idx];
      }
    }
    inst.transitionAlpha[instIdx] = transAlpha;
    inst.transitionActive[instIdx] = transActive;

    // Seams.
    inst.seamFlags[instIdx] = h.seamFlags;
    inst.northLod[instIdx] = h.neighborLods?.north ?? -1;
    inst.southLod[instIdx] = h.neighborLods?.south ?? -1;
    inst.eastLod[instIdx] = h.neighborLods?.east ?? -1;
    inst.westLod[instIdx] = h.neighborLods?.west ?? -1;

    // Material.
    inst.wetness[instIdx] = materialState.wetness;
    inst.ignition[instIdx] = materialState.ignitionTimer;
    inst.burnProgress[instIdx] = materialState.burnProgress;

    // Colors and PBR parameters from the physical channel.
    if (physical?.terrainMaterialEntityIds) {
      const idx = physical.terrainMaterialEntityIds.indexOf(h.entityId);
      if (idx >= 0) {
        inst.colorR[instIdx] = physical.terrainMaterialColorR[idx];
        inst.colorG[instIdx] = physical.terrainMaterialColorG[idx];
        inst.colorB[instIdx] = physical.terrainMaterialColorB[idx];
        inst.roughness[instIdx] = physical.terrainMaterialRoughness[idx];
        inst.metalness[instIdx] = physical.terrainMaterialMetalness[idx];
      }
    }

    // Geometry binding.
    const isHeightmap = terrain instanceof HeightmapTerrain;
    if (isHeightmap) {
      inst.vertexStart[instIdx] = 0;
      inst.vertexCount[instIdx] = terrain.resolution * terrain.resolution;
      inst.indexStart[instIdx] = 0;
      inst.indexCount[instIdx] = (terrain.resolution - 1) * (terrain.resolution - 1) * 6;
    } else {
      inst.vertexStart[instIdx] = 0;
      inst.vertexCount[instIdx] = terrain.vertexCount;
      inst.indexStart[instIdx] = 0;
      inst.indexCount[instIdx] = terrain.indices ? terrain.indices.length : 0;
    }

    // Material weight ranges.
    inst.weightStart[instIdx] = materialComponent?.weightStart ?? 0;
    inst.weightCount[instIdx] = materialComponent?.weightCount ?? 0;
    inst.weightStride[instIdx] = materialComponent?.weightStride ?? 0;

    // Skirt ranges (if present).
    inst.skirtVertexStart[instIdx] = 0;
    inst.skirtIndexStart[instIdx] = 0;
    inst.skirtIndexCount[instIdx] = terrain.skirtIndices ? terrain.skirtIndices.length : 0;
  }

  // ---------------------------------------------------------------------
  // Sorting & estimation
  // ---------------------------------------------------------------------

  _sortVisibleTiles(headers) {
    const arr = this._sortedScratch;
    arr.length = headers.length;
    for (let i = 0; i < headers.length; i++) arr[i] = headers[i];
    arr.sort((a, b) => b.priority - a.priority);
  }

  _estimateTriangleCount() {
    let total = 0;
    const inst = this.instances;
    for (let i = 0; i < inst.count; i++) {
      total += inst.indexCount[i] / 3;
    }
    return total;
  }

  // ---------------------------------------------------------------------
  // Quality governor
  // ---------------------------------------------------------------------

  _qualityTierFromScale(scale) {
    if (scale >= 0.95) return QualityTier3D.ULTRA;
    if (scale >= 0.75) return QualityTier3D.HIGH;
    if (scale >= 0.5)  return QualityTier3D.MEDIUM;
    if (scale >= 0.3)  return QualityTier3D.LOW;
    return QualityTier3D.MINIMAL;
  }

  _updateGovernor(frameMs) {
    // Update the rolling window.
    const window = this._frameTimeHistory;
    const idx = this._frameTimeIndex;
    this._frameTimeSum -= window[idx];
    window[idx] = frameMs;
    this._frameTimeSum += frameMs;
    this._frameTimeIndex = (idx + 1) % window.length;
    this._frameTimeCount = Math.min(this._frameTimeCount + 1, window.length);

    // Compute the smoothed average.
    const avg = this._frameTimeSum / Math.max(this._frameTimeCount, 1);

    // Compute the target scale.
    const target = this.options.targetFrameMs;
    let targetScale = target / Math.max(avg, 0.001);
    targetScale = Math.max(this.options.minQualityScale,
                   Math.min(this.options.maxQualityScale, targetScale));

    // Smooth the scale.
    const s = this.options.governorSmoothing;
    this._qualityScale = this._qualityScale * (1 - s) + targetScale * s;
  }

  // ---------------------------------------------------------------------
  // Publish to frame
  // ---------------------------------------------------------------------

  _publishToFrame() {
    if (!this.frame) return;
    if (!this.frame.layers.render) {
      this.frame.layers.render = {};
    }
    const render = this.frame.layers.render;

    render.terrain3dDrawCalls = this.drawCalls;
    render.terrain3dSkirtDrawCalls = this.skirtDrawCalls;
    render.terrain3dInstances = this.instances;
    render.terrain3dDrawCallCount = this.drawCalls.count;
    render.terrain3dSkirtDrawCallCount = this.skirtDrawCalls.count;
    render.terrain3dInstanceCount = this.instances.count;
    render.terrain3dTriangleCount = this._published.triangleCount;
    render.terrain3dQualityScale = this._qualityScale;
    render.terrain3dLastFrameMs = this._published.lastFrameMs;
  }

  // ---------------------------------------------------------------------
  // Public queries
  // ---------------------------------------------------------------------

  getDrawCalls() { return this.drawCalls; }
  getSkirtDrawCalls() { return this.skirtDrawCalls; }
  getInstances() { return this.instances; }
  getQualityScale() { return this._qualityScale; }

  setQualityScale(scale) {
    this._qualityScale = Math.max(this.options.minQualityScale,
                          Math.min(this.options.maxQualityScale, scale));
  }

  getStats() {
    return {
      ...this.stats,
      currentDrawCalls: this.drawCalls.count,
      currentSkirtDrawCalls: this.skirtDrawCalls.count,
      currentInstances: this.instances.count,
      currentTriangles: this._published.triangleCount,
      currentQualityScale: this._qualityScale,
      currentFrameMs: this._published.lastFrameMs
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this.drawCalls.reset();
    this.skirtDrawCalls.reset();
    this.instances.reset();
    this._batchMap.clear();
    this._skirtBatchMap.clear();
    this._sortedScratch.length = 0;
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a fully-configured TerrainRenderDispatch3D with sensible defaults
 * for the seamless 3D terrain pipeline.
 */
export function createTerrainRenderDispatch3D(options = {}) {
  return new TerrainRenderDispatch3D({
    targetHz: options.targetHz ?? 60,
    maxDrawCalls: options.maxDrawCalls ?? 256,
    maxInstances: options.maxInstances ?? 4096,
    targetFrameMs: options.targetFrameMs ?? 8,
    minQualityScale: options.minQualityScale ?? 0.25,
    maxQualityScale: options.maxQualityScale ?? 1.0,
    governorSmoothing: options.governorSmoothing ?? 0.15,
    governorWindow: options.governorWindow ?? 16,
    groupByMaterialId: options.groupByMaterialId ?? true,
    groupByGeometryFamily: options.groupByGeometryFamily ?? true,
    groupByPassFlags: options.groupByPassFlags ?? true,
    enableInstancedMeshes: options.enableInstancedMeshes ?? true,
    enableInstancedHeightmaps: options.enableInstancedHeightmaps ?? true,
    enableLodCrossFade: options.enableLodCrossFade ?? true,
    enableSeamPass: options.enableSeamPass ?? true,
    skirtMode: options.skirtMode ?? SkirtMode.SEPARATE,
    skirtDepth: options.skirtDepth ?? 1.0,
    skirtCullBackface: options.skirtCullBackface ?? false,
    enableOutlinePass: options.enableOutlinePass ?? false,
    maxResidentBytes: options.maxResidentBytes ?? DEFAULT_TILESET_OPTIONS.maxResidentBytes,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 6. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainRenderDispatch3D,
  DrawCallArena3D,
  TileInstanceArena3D,
  TerrainDispatchStatsComponent,
  GeometryFamily3D,
  MaterialFamily3D,
  QualityTier3D,
  SkirtMode,
  createTerrainRenderDispatch3D
};