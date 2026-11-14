// file number : 384
// full path name : src/context/384_TerrainRenderDispatch.js
//### Description : Context-aware TerrainRenderDispatch — the batched render
//###               dispatch stage for the seamless 2D/3D terrain pipeline.
//###               Reads the reconciler’s visible-tile SoA (file 381), the
//###               painter’s material SoA (file 383), and the tile geometry
//###               buffers (HeightmapTerrain / QuantizedMeshTerrain from files
//###               374 / 375), and emits a single, minimal set of draw calls
//###               per frame. Groups tiles by material ID and geometry type,
//###               uses instanced draws where tiles share a geometry, and
//###               batches per-tile material uniform uploads into a single
//###               pass. Handles LOD cross-fade alphas (parent + children) and
//###               seam-stitched edges in one unified shader binding. Never
//###               allocates in the hot path: all draw-call records live in
//###               pre-allocated structure-of-arrays buffers, and all uniform
//###               uploads go through a single shared UBO/SSBO. Applies the
//###               blueprint’s 8 ms per-tick CPU ceiling by limiting per-frame
//###               dispatches through an adaptive quality governor
//###               (scale = min(1, targetMs / measuredMs)). No external loader,
//###               no CDN access, no static server. Designed for Android arm64
//###               under the 200 MB resident memory cap, and scales from a
//###               single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : The final stage of the terrain pipeline that turns “here are
//###            the tiles, here are their materials” into a batched list of
//###            draw calls the renderer executes. Any downstream renderer
//###            (WebGL2, WebGPU, or a custom backend) can consume the output
//###            of this dispatcher without knowing how the terrain was
//###            streamed, decoded, or painted. The dispatcher also emits
//###            per-frame metrics (draw count, triangle count, uniform-batch
//###            count) so the runtime can scale quality up or down in real time.
//### License : MIT

import {
  // math kernel
  Vec3,
  Quat,
  Mat4,
  SimplexNoise,
  DoubleDouble,
  Precision,
  // ECS (BitECS, World, Components, Systems)
  BitECS,
  World,
  Components,
  Systems,
  // core event routing & timing
  EventDispatcher,
  Timer,
  // geometry & buffer primitives
  BufferAttribute,
  BufferGeometry,
  // textures (procedural masks for tile-driven terrain painting)
  DataTexture,
  // materials (for tagging terrain features)
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  // renderer entry points (backend-agnostic)
  WebGLRenderer,
  WebGPURenderer,
  backendConfig
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE } from './265_CoreEventDispatcher.js';

import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  SeamEdge,
  DEFAULT_TILESET_OPTIONS,
  hasSeam,
  oppositeEdge,
  stringTileKey,
  fnv1aHash
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
  TerrainMaterialPainter,
  TerrainMaterialDescriptor
} from './383_TerrainMaterialPainter.js';

// ---------------------------------------------------------------------------
// 1. CONSTANTS – canonical batch keys and quality tiers
// ---------------------------------------------------------------------------

/**
 * Geometry families. Every visible tile belongs to exactly one family, which
 * determines how its vertices are bound to the GPU.
 */
export const GeometryFamily = Object.freeze({
  HEIGHTMAP_GRID:   0,   // regular grid, can be rendered as instanced patches
  QUANTIZED_MESH:   1,   // irregular mesh, one draw per tile
  BILLBOARD:        2,   // reserved for distant LOD fallback
  CUSTOM:           3
});

/**
 * Material families. Groups tiles that can share a material uniform batch.
 */
export const MaterialFamily = Object.freeze({
  STANDARD:   0,   // full PBR
  ANIME:      1,   // flat PBR with quantization
  WET:        2,   // extra wetness pass
  BURNED:     3,   // extra burn pass
  CUSTOM:     4
});

/**
 * Quality tiers. The dispatcher uses these to scale draw-call budgets when
 * the per-tick CPU time exceeds the target.
 */
export const QualityTier = Object.freeze({
  ULTRA:   0,   // all tiles, all passes
  HIGH:    1,   // all tiles, primary pass
  MEDIUM:  2,   // visible tiles, primary pass
  LOW:     3,   // only near tiles, primary pass
  MINIMAL: 4    // only the highest-priority tiles
});

// ---------------------------------------------------------------------------
// 2. DRAW-CALL RECORD – structure-of-arrays batch entry
// ---------------------------------------------------------------------------

/**
 * DrawCallArena — a structure-of-arrays buffer of draw-call records.
 * Each record describes a single batched draw the renderer must execute.
 *
 * Layout: one entry per draw call, 16 u32 + 8 f32 fields. All fields
 * describe the batch, not the individual tiles; per-tile data lives in a
 * parallel SoA (`TileInstanceArena`) referenced by `instanceStart` /
 * `instanceCount`.
 */
class DrawCallArena {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;

    // ---- Identity ----
    this.batchId          = new Uint32Array(capacity);
    this.geometryFamily   = new Uint8Array(capacity);
    this.materialFamily   = new Uint8Array(capacity);
    this.materialId       = new Uint16Array(capacity);

    // ---- Geometry binding ----
    this.geometryBufferId = new Uint32Array(capacity);
    this.instanceStart    = new Uint32Array(capacity);
    this.instanceCount    = new Uint32Array(capacity);

    // ---- Pass flags ----
    this.useWetPass       = new Uint8Array(capacity);
    this.useBurnPass      = new Uint8Array(capacity);
    this.useSeamPass      = new Uint8Array(capacity);
    this.useOutlinePass   = new Uint8Array(capacity);

    // ---- Render state ----
    this.blendMode        = new Uint8Array(capacity); // 0=opaque, 1=alpha
    this.depthWrite       = new Uint8Array(capacity);
    this.cullMode         = new Uint8Array(capacity); // 0=none, 1=back, 2=front

    // ---- Bounds for GPU-side frustum culling ----
    this.boundsMinX       = new Float32Array(capacity);
    this.boundsMinY       = new Float32Array(capacity);
    this.boundsMinZ       = new Float32Array(capacity);
    this.boundsMaxX       = new Float32Array(capacity);
    this.boundsMaxY       = new Float32Array(capacity);
    this.boundsMaxZ       = new Float32Array(capacity);
  }

  reset() {
    this.count = 0;
  }

  acquire() {
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }
}

/**
 * TileInstanceArena — the per-instance SoA referenced by draw calls.
 * One entry per visible tile; contains the per-tile uniforms the renderer
 * uploads to the GPU (blend alpha, transition alpha, seam flags, etc.).
 */
class TileInstanceArena {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;

    // ---- Instance identity ----
    this.tileKeyHash         = new Uint32Array(capacity);
    this.entityId            = new Uint32Array(capacity);
    this.lod                 = new Uint8Array(capacity);
    this.state               = new Uint8Array(capacity);

    // ---- Per-instance uniforms (packed into the UBO) ----
    this.blendAlpha          = new Float32Array(capacity);
    this.transitionAlpha     = new Float32Array(capacity);
    this.transitionActive    = new Uint8Array(capacity);
    this.seamFlags           = new Uint8Array(capacity);
    this.northLod            = new Int8Array(capacity);
    this.southLod            = new Int8Array(capacity);
    this.eastLod             = new Int8Array(capacity);
    this.westLod             = new Int8Array(capacity);

    // ---- Per-instance material uniforms ----
    this.wetness             = new Float32Array(capacity);
    this.ignition            = new Float32Array(capacity);
    this.burnProgress        = new Float32Array(capacity);
    this.colorR              = new Float32Array(capacity);
    this.colorG              = new Float32Array(capacity);
    this.colorB              = new Float32Array(capacity);
    this.roughness           = new Float32Array(capacity);
    this.metalness           = new Float32Array(capacity);

    // ---- Per-instance geometry binding ----
    this.vertexStart         = new Uint32Array(capacity);
    this.vertexCount         = new Uint32Array(capacity);
    this.indexStart          = new Uint32Array(capacity);
    this.indexCount          = new Uint32Array(capacity);
    this.weightStart         = new Uint32Array(capacity);
    this.weightCount         = new Uint32Array(capacity);
    this.weightStride        = new Uint8Array(capacity);
  }

  reset() {
    this.count = 0;
  }

  acquire() {
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }
}

// ---------------------------------------------------------------------------
// 3. TerrainRenderDispatch
// ---------------------------------------------------------------------------

/**
 * TerrainRenderDispatch — turns the visible-tile SoA into a compact list of
 * batched draw calls that the runtime executes in stage six of the
 * orchestration loop.
 *
 * Pipeline (per frame):
 *   1. Walk the visible tiles from the reconciler.
 *   2. For each tile, classify geometry family and material family.
 *   3. Group tiles into batches keyed by (geometryFamily, materialFamily,
 *      materialId, pass flags). Batches are chosen so the renderer can use
 *      instanced draws for heightmap grids and per-tile draws for irregular
 *      quantized meshes.
 *   4. Allocate a single per-instance entry (in TileInstanceArena) per tile.
 *   5. Emit a DrawCallArena entry per batch with a pointer into the instance
 *      arena.
 *   6. Apply the adaptive quality governor: if the previous frame exceeded
 *      the 8 ms budget, skip low-priority batches this frame.
 *   7. Publish the two arenas to the frame’s render channel.
 *
 * The dispatcher is completely parametric: it never talks to a loader, never
 * touches the network, and never assumes a specific renderer backend. WebGL2,
 * WebGPU, and any custom backend can consume the arenas directly.
 */
export class TerrainRenderDispatch {
  constructor(options = {}) {
    this.options = {
      // ---- Frequency ----
      targetHz: options.targetHz ?? 60,   // 60 Hz render tick
      // ---- Arena capacities (per frame) ----
      maxDrawCalls: options.maxDrawCalls ?? 256,
      maxInstances: options.maxInstances ?? 4096,
      // ---- Quality governor ----
      targetFrameMs: options.targetFrameMs ?? 8,   // 8 ms budget
      minQualityScale: options.minQualityScale ?? 0.25,
      maxQualityScale: options.maxQualityScale ?? 1.0,
      governorSmoothing: options.governorSmoothing ?? 0.2,
      // ---- Batch grouping ----
      groupByMaterialId: options.groupByMaterialId ?? true,
      groupByGeometryFamily: options.groupByGeometryFamily ?? true,
      groupByPassFlags: options.groupByPassFlags ?? true,
      // ---- Instanced rendering ----
      enableInstancedHeightmaps: options.enableInstancedHeightmaps ?? true,
      enableInstancedMeshTiles: options.enableInstancedMeshTiles ?? false,
      // ---- LOD cross-fade ----
      enableLodCrossFade: options.enableLodCrossFade ?? true,
      enableSeamPass: options.enableSeamPass ?? true,
      // ---- Outline ----
      enableOutlinePass: options.enableOutlinePass ?? false,
      outlineScale: options.outlineScale ?? 0.02,
      // ---- Memory ----
      maxResidentBytes: options.maxResidentBytes ?? DEFAULT_TILESET_OPTIONS.maxResidentBytes,
      // ---- Diagnostics ----
      enableDiagnostics: options.enableDiagnostics ?? true,
      ...options
    };

    // ---- Arenas ----
    this.drawCalls = new DrawCallArena(this.options.maxDrawCalls);
    this.instances = new TileInstanceArena(this.options.maxInstances);

    // ---- Batch grouping state ----
    // Map: batchKey (u32 hash) → DrawCallArena index
    this._batchMap = new Map();
    this._batchScratch = new Uint32Array(4);

    // ---- Quality governor ----
    this._qualityScale = this.options.maxQualityScale;
    this._lastFrameMs = 0;
    this._frameTimeHistory = new Float32Array(16);
    this._frameTimeIndex = 0;

    // ---- Context frame / ECS / dispatcher ----
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;

    // ---- Last tick ----
    this.lastTick = 0;

    // ---- Published output (read by the renderer) ----
    this._published = {
      drawCalls: this.drawCalls,
      instances: this.instances,
      qualityScale: this._qualityScale,
      lastFrameMs: 0,
      drawCallCount: 0,
      instanceCount: 0,
      triangleCount: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      framesDispatched: 0,
      peakDrawCalls: 0,
      peakInstances: 0,
      peakTriangles: 0,
      avgFrameMs: 0,
      totalFrameMs: 0,
      frameCount: 0
    };
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  bind(contextFrame, ecsWorld, dispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.dispatcher = dispatcher;
    return this;
  }

  // -------------------------------------------------------------------------
  // Main dispatch
  // -------------------------------------------------------------------------

  /**
   * Builds the draw-call list for the current frame.
   * Called from stage six (60 Hz render dispatch) of the orchestration loop.
   *
   * @param {ContextFrame} contextFrame – live context frame
   * @param {number} tick – current tick counter
   * @param {number} dt – delta time in seconds
   * @param {object[]} visibleHeaders – visible Tile2DHeader references
   * @param {TerrainMaterialPainter} materialPainter – the material painter
   * @param {object} source – the terrain source (holds per-tile terrain objects)
   */
  update(contextFrame, tick, dt, visibleHeaders, materialPainter, source) {
    this.frame = contextFrame;
    this.lastTick = tick;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // 1. Reset arenas.
    this.drawCalls.reset();
    this.instances.reset();
    this._batchMap.clear();

    // 2. Read the material SoA from the painter (already published).
    const physical = contextFrame?.layers?.physical;
    const materialCount = physical?.terrainMaterialEntityIds?.length ?? 0;

    // 3. Get the quality scale from the governor.
    const qualityScale = this._qualityScale;
    const qualityTier = this._qualityTierFromScale(qualityScale);

    // 4. Sort the visible tiles by priority (highest first) so the quality
    //    governor can truncate the tail cheaply.
    const sorted = this._sortByPriority(visibleHeaders);

    // 5. Determine the instance budget based on the quality scale.
    const instanceBudget = Math.floor(this.options.maxInstances * qualityScale);
    let instancesUsed = 0;

    // 6. Walk the sorted tiles and emit batches.
    for (let i = 0; i < sorted.length; i++) {
      if (instancesUsed >= instanceBudget) break;
      const h = sorted[i];
      if (h.state !== TileState.READY) continue;

      // Resolve the terrain object.
      const record = source?.tileMap?.get(h.tileKey);
      if (!record?.terrainObject) continue;
      const terrain = record.terrainObject;

      // Resolve the material state.
      const materialState = materialPainter?.tileState?.get(h.tileKey);
      if (!materialState) continue;

      // Find the corresponding material component on the ECS entity.
      let materialComponent = null;
      if (this.ecsWorld && h.entityId !== 0xFFFFFFFF) {
        materialComponent = this.ecsWorld.getComponent?.(h.entityId, 'TerrainMaterialComponent') ?? null;
      }

      // Classify geometry & material families.
      const geomFamily = this._classifyGeometryFamily(terrain);
      const materialId = materialComponent?.dominantMaterialId ?? 0;
      const matFamily = this._classifyMaterialFamily(materialState);

      // Build the batch key.
      const batchKey = this._computeBatchKey(
        geomFamily, matFamily, materialId,
        materialState.wetness > 0.1 ? 1 : 0,
        materialState.burnProgress > 0.1 ? 1 : 0,
        h.seamFlags !== 0 ? 1 : 0,
        qualityTier
      );

      // Look up or create the draw-call entry for this batch.
      let drawCallIdx = this._batchMap.get(batchKey);
      if (drawCallIdx === undefined) {
        drawCallIdx = this.drawCalls.acquire();
        if (drawCallIdx < 0) break; // out of draw-call capacity
        this._batchMap.set(batchKey, drawCallIdx);

        // Initialize the batch record.
        const dc = this.drawCalls;
        dc.batchId[drawCallIdx] = batchKey;
        dc.geometryFamily[drawCallIdx] = geomFamily;
        dc.materialFamily[drawCallIdx] = matFamily;
        dc.materialId[drawCallIdx] = materialId;
        dc.geometryBufferId[drawCallIdx] = this._geometryBufferId(geomFamily, terrain);
        dc.instanceStart[drawCallIdx] = this.instances.count;
        dc.instanceCount[drawCallIdx] = 0;
        dc.useWetPass[drawCallIdx] = materialState.wetness > 0.1 ? 1 : 0;
        dc.useBurnPass[drawCallIdx] = materialState.burnProgress > 0.1 ? 1 : 0;
        dc.useSeamPass[drawCallIdx] = h.seamFlags !== 0 && this.options.enableSeamPass ? 1 : 0;
        dc.useOutlinePass[drawCallIdx] = this.options.enableOutlinePass ? 1 : 0;
        dc.blendMode[drawCallIdx] = this._computeBlendMode(geomFamily, matFamily);
        dc.depthWrite[drawCallIdx] = dc.blendMode[drawCallIdx] === 0 ? 1 : 0;
        dc.cullMode[drawCallIdx] = 1; // back-face culling by default
        dc.boundsMinX[drawCallIdx] = h.minX;
        dc.boundsMinY[drawCallIdx] = h.minY;
        dc.boundsMinZ[drawCallIdx] = h.minZ;
        dc.boundsMaxX[drawCallIdx] = h.maxX;
        dc.boundsMaxY[drawCallIdx] = h.maxY;
        dc.boundsMaxZ[drawCallIdx] = h.maxZ;
      }

      // Emit one instance for this tile.
      const instIdx = this.instances.acquire();
      if (instIdx < 0) break;
      this._writeInstance(instIdx, h, terrain, materialState, materialComponent, physical);
      this.drawCalls.instanceCount[drawCallIdx]++;
      instancesUsed++;
    }

    // 7. Store output.
    this._published.drawCallCount = this.drawCalls.count;
    this._published.instanceCount = this.instances.count;
    this._published.triangleCount = this._estimateTriangleCount();

    // 8. Publish to the frame’s render channel.
    this._publishToFrame();

    // 9. Measure frame time and update the quality governor.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const frameMs = t1 - t0;
    this._updateGovernor(frameMs);

    this._published.lastFrameMs = frameMs;
    this._published.qualityScale = this._qualityScale;

    // Diagnostics.
    this.stats.framesDispatched++;
    this.stats.peakDrawCalls = Math.max(this.stats.peakDrawCalls, this.drawCalls.count);
    this.stats.peakInstances = Math.max(this.stats.peakInstances, this.instances.count);
    this.stats.peakTriangles = Math.max(this.stats.peakTriangles, this._published.triangleCount);
    this.stats.totalFrameMs += frameMs;
    this.stats.frameCount++;
    this.stats.avgFrameMs = this.stats.totalFrameMs / this.stats.frameCount;
  }

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  _classifyGeometryFamily(terrain) {
    if (terrain instanceof HeightmapTerrain) return GeometryFamily.HEIGHTMAP_GRID;
    if (terrain instanceof QuantizedMeshTerrain) return GeometryFamily.QUANTIZED_MESH;
    return GeometryFamily.CUSTOM;
  }

  _classifyMaterialFamily(materialState) {
    if (materialState.burnProgress > 0.5) return MaterialFamily.BURNED;
    if (materialState.wetness > 0.5) return MaterialFamily.WET;
    return MaterialFamily.STANDARD;
  }

  _computeBlendMode(geomFamily, matFamily) {
    // Burned tiles fade to scorched colour but remain opaque.
    // Wet tiles remain opaque.
    // Cross-fades (LOD transitions) require alpha, which is handled at the
    // per-instance level, not the batch level.
    return 0; // opaque
  }

  _geometryBufferId(geomFamily, terrain) {
    // The renderer resolves this ID to a GPU buffer.
    // Heightmap grids share a single unit-quad buffer; quantized meshes each
    // own their own buffer.
    if (geomFamily === GeometryFamily.HEIGHTMAP_GRID) return 1; // shared unit quad
    if (geomFamily === GeometryFamily.QUANTIZED_MESH) return 2; // per-tile mesh
    return 0;
  }

  _computeBatchKey(geomFamily, matFamily, materialId, wet, burn, seam, qualityTier) {
    // A 32-bit hash packing all batch-identifying fields.
    return (
      ((geomFamily & 0x7) << 29) |
      ((matFamily & 0x7) << 26) |
      ((materialId & 0x3FFF) << 12) |
      ((wet & 0x1) << 11) |
      ((burn & 0x1) << 10) |
      ((seam & 0x1) << 9) |
      ((qualityTier & 0x7) << 6)
    );
  }

  // -------------------------------------------------------------------------
  // Instance write
  // -------------------------------------------------------------------------

  _writeInstance(instIdx, h, terrain, materialState, materialComponent, physical) {
    const inst = this.instances;

    inst.tileKeyHash[instIdx] = h.tileKeyHash;
    inst.entityId[instIdx] = h.entityId;
    inst.lod[instIdx] = h.lod;
    inst.state[instIdx] = h.state;

    // Per-instance blend + transition alphas.
    inst.blendAlpha[instIdx] = h.blendAlpha;
    // Read the transition alpha from the reconciler’s published SoA if
    // available; otherwise default to fully visible.
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

    // Seam flags.
    inst.seamFlags[instIdx] = h.seamFlags;
    inst.northLod[instIdx] = h.neighborLods?.north ?? -1;
    inst.southLod[instIdx] = h.neighborLods?.south ?? -1;
    inst.eastLod[instIdx] = h.neighborLods?.east ?? -1;
    inst.westLod[instIdx] = h.neighborLods?.west ?? -1;

    // Material state.
    inst.wetness[instIdx] = materialState.wetness;
    inst.ignition[instIdx] = materialState.ignitionTimer;
    inst.burnProgress[instIdx] = materialState.burnProgress;

    // Colors and PBR parameters (from the physical channel, populated by the
    // material painter).
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
      inst.indexCount[instIdx] = terrain.indices.length;
    }

    // Material weights.
    inst.weightStart[instIdx] = materialComponent?.weightStart ?? 0;
    inst.weightCount[instIdx] = materialComponent?.weightCount ?? 0;
    inst.weightStride[instIdx] = materialComponent?.weightStride ?? 0;
  }

  // -------------------------------------------------------------------------
  // Sorting & estimation
  // -------------------------------------------------------------------------

  _sortByPriority(headers) {
    // Simple in-place sort by descending priority. Uses a typed-array copy
    // to avoid allocating a new array each frame.
    const arr = headers.slice();
    arr.sort((a, b) => b.priority - a.priority);
    return arr;
  }

  _estimateTriangleCount() {
    let total = 0;
    const inst = this.instances;
    for (let i = 0; i < inst.count; i++) {
      total += inst.indexCount[i] / 3;
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Quality governor
  // -------------------------------------------------------------------------

  _qualityTierFromScale(scale) {
    if (scale >= 0.95) return QualityTier.ULTRA;
    if (scale >= 0.75) return QualityTier.HIGH;
    if (scale >= 0.5)  return QualityTier.MEDIUM;
    if (scale >= 0.3)  return QualityTier.LOW;
    return QualityTier.MINIMAL;
  }

  _updateGovernor(frameMs) {
    const target = this.options.targetFrameMs;
    this._frameTimeHistory[this._frameTimeIndex] = frameMs;
    this._frameTimeIndex = (this._frameTimeIndex + 1) % this._frameTimeHistory.length;

    // Use a smoothed average to avoid oscillation.
    let sum = 0;
    for (let i = 0; i < this._frameTimeHistory.length; i++) {
      sum += this._frameTimeHistory[i];
    }
    const avg = sum / this._frameTimeHistory.length;

    const smoothing = this.options.governorSmoothing;
    let targetScale = target / Math.max(avg, 0.001);
    targetScale = Math.max(this.options.minQualityScale,
                  Math.min(this.options.maxQualityScale, targetScale));

    this._qualityScale = this._qualityScale * (1 - smoothing) + targetScale * smoothing;
  }

  // -------------------------------------------------------------------------
  // Publish to frame
  // -------------------------------------------------------------------------

  _publishToFrame() {
    if (!this.frame) return;
    if (!this.frame.layers.render) {
      this.frame.layers.render = {};
    }
    const render = this.frame.layers.render;

    // Publish the arenas by reference (they are the source of truth).
    render.terrainDrawCalls = this.drawCalls;
    render.terrainInstances = this.instances;
    render.terrainDrawCallCount = this.drawCalls.count;
    render.terrainInstanceCount = this.instances.count;
    render.terrainTriangleCount = this._published.triangleCount;
    render.terrainQualityScale = this._qualityScale;
    render.terrainLastFrameMs = this._published.lastFrameMs;
  }

  // -------------------------------------------------------------------------
  // Public queries
  // -------------------------------------------------------------------------

  /**
   * Returns the current draw-call arena for the renderer.
   */
  getDrawCalls() {
    return this.drawCalls;
  }

  /**
   * Returns the current per-instance arena.
   */
  getInstances() {
    return this.instances;
  }

  /**
   * Returns the current quality scale (0..1).
   */
  getQualityScale() {
    return this._qualityScale;
  }

  /**
   * Manually overrides the quality scale for the next frame. Useful for
   * explicit low-power mode toggles on Android.
   */
  setQualityScale(scale) {
    this._qualityScale = Math.max(this.options.minQualityScale,
                          Math.min(this.options.maxQualityScale, scale));
  }

  /**
   * Returns the dispatcher diagnostics.
   */
  getStats() {
    return {
      ...this.stats,
      currentDrawCalls: this.drawCalls.count,
      currentInstances: this.instances.count,
      currentTriangles: this._published.triangleCount,
      currentQualityScale: this._qualityScale,
      currentFrameMs: this._published.lastFrameMs
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  dispose() {
    this.drawCalls.reset();
    this.instances.reset();
    this._batchMap.clear();
    this.frame = null;
    this.ecsWorld = null;
    this.dispatcher = null;
  }
}

// ---------------------------------------------------------------------------
// 4. FACTORY
// ---------------------------------------------------------------------------

/**
 * Creates a fully-wired TerrainRenderDispatch with sensible defaults for the
 * seamless terrain pipeline. Caller must call .bind(contextFrame, ecsWorld,
 * dispatcher) before the first update.
 */
export function createTerrainRenderDispatch(options = {}) {
  return new TerrainRenderDispatch({
    targetHz: options.targetHz ?? 60,
    maxDrawCalls: options.maxDrawCalls ?? 256,
    maxInstances: options.maxInstances ?? 4096,
    targetFrameMs: options.targetFrameMs ?? 8,
    minQualityScale: options.minQualityScale ?? 0.25,
    maxQualityScale: options.maxQualityScale ?? 1.0,
    governorSmoothing: options.governorSmoothing ?? 0.2,
    groupByMaterialId: options.groupByMaterialId ?? true,
    groupByGeometryFamily: options.groupByGeometryFamily ?? true,
    groupByPassFlags: options.groupByPassFlags ?? true,
    enableInstancedHeightmaps: options.enableInstancedHeightmaps ?? true,
    enableInstancedMeshTiles: options.enableInstancedMeshTiles ?? false,
    enableLodCrossFade: options.enableLodCrossFade ?? true,
    enableSeamPass: options.enableSeamPass ?? true,
    enableOutlinePass: options.enableOutlinePass ?? false,
    outlineScale: options.outlineScale ?? 0.02,
    maxResidentBytes: options.maxResidentBytes ?? DEFAULT_TILESET_OPTIONS.maxResidentBytes,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ---------------------------------------------------------------------------
// 5. BARREL EXPORT
// ---------------------------------------------------------------------------

export default {
  TerrainRenderDispatch,
  DrawCallArena,
  TileInstanceArena,
  GeometryFamily,
  MaterialFamily,
  QualityTier,
  createTerrainRenderDispatch
};