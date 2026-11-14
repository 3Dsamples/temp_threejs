// file number : 382
// full path name : src/context/382_TerrainPipelineIndex.js
//### Description : Canonical barrel export for the complete seamless 2D/3D
//###               terrain pipeline. Aggregates every public symbol from files
//###               373 through 381 — the shared types module, the heightmap
//###               tile class, the quantized-mesh tile class, the quadtree
//###               node, the viewport selection adapter, the tileset
//###               container, the streaming queue, the terrain source
//###               hierarchy (base class + procedural/heightmap/quantized-mesh
//###               implementations), and the per-tick reconciler — into a single
//###               stable import surface. Guarantees that downstream files never
//###               reach into internal module paths, which prevents accidental
//###               circular imports and lets the runtime swap implementations
//###               without touching consumers. Pure re-export: zero runtime
//###               overhead, zero allocations, zero side effects. No external
//###               loader, no CDN access, no static server. The barrel is
//###               idempotent and tree-shake-friendly — only the symbols a
//###               caller actually uses end up in the final Android arm64
//###               bundle.
//### Best for : Any consumer that needs to interact with the seamless terrain
//###            pipeline — the runtime orchestration loop, the render dispatch
//###            stage, the material painter, the vegetation scatter system, and
//###            external tools. Importing everything from this one file keeps
//###            the dependency graph flat and makes the module boundaries
//###            explicit: 373 is shared types, 374 is heightmap tiles, 375 is
//###            quantized-mesh tiles, 376 is quadtree nodes, 377 is selection,
//###            378 is the tileset container, 379 is the 2D tileset barrel,
//###            380 is the source hierarchy, 381 is the reconciler.
//### License : MIT

// ---------------------------------------------------------------------------
// 1. RE-EXPORTS FROM 373 – shared types, ECS schemas, math helpers
// ---------------------------------------------------------------------------

export {
  // Enums
  TilesetSourceFormat,
  TileState,
  TileRefinement,
  BoundingVolumeKind,
  TileEventType,
  SeamEdge,

  // ECS component schemas
  TilesetComponent,
  TileComponent,
  BoundingVolumeComponent,

  // Structure-of-arrays container factory
  createTileContainer,
  tileContainerAlloc,
  tileContainerRelease,
  tileContainerResetSlot,

  // Bounding volume helpers
  extractFrustumPlanes,
  isSphereOutsideFrustum,
  isBoxOutsideFrustum,
  distanceToSphereSquared,
  computeScreenSpaceError,

  // LOD selection helpers
  computeLodIndex,
  computeLodBlendAlpha,
  computeTilePriority,

  // Tile-key helpers
  packTileKey,
  stringTileKey,
  fnv1aHash,

  // Seam helpers
  hasSeam,
  oppositeEdge,

  // Quadtree navigation helpers
  computeChildTileCoords,
  computeParentTileCoord,
  computeTileNeighbors,

  // Streaming helpers
  compareTilePriority,

  // Default options
  DEFAULT_TILESET_OPTIONS,

  // Validation helpers
  isValidTilesetSourceFormat,
  isValidTileState,
  isValidBoundingVolumeKind,
  isValidRefinement
} from './373_Tileset2DTypes.js';

// ---------------------------------------------------------------------------
// 2. RE-EXPORTS FROM 374 – HeightmapTerrain tiles
// ---------------------------------------------------------------------------

export {
  HeightmapTerrain,
  HeightmapTileComponent,
  HeightmapSeamComponent,
  HeightmapTerrainRegistry,
  computeHeightmapBoundingBox,
  computeHeightmapBoundingSphere
} from './374_TerrainHeightmapTile.js';

// ---------------------------------------------------------------------------
// 3. RE-EXPORTS FROM 375 – QuantizedMeshTerrain tiles
// ---------------------------------------------------------------------------

export {
  QuantizedMeshTerrain,
  QuantizedMeshComponent,
  QuantizedMeshSeamComponent,
  TerrainParseQuantizedMesh
} from './375_TerrainParseQuantizedMesh.js';

// ---------------------------------------------------------------------------
// 4. RE-EXPORTS FROM 376 – Quadtree node (Tile2DHeader)
// ---------------------------------------------------------------------------

export {
  Tile2DHeader,
  Tile2DHeaderComponent,
  Tile2DHeaderPool,
  buildChildCoords,
  rootTileCoord,
  areQuadtreeAdjacent,
  sharedEdge
} from './376_Tile2DHeader.js';

// ---------------------------------------------------------------------------
// 5. RE-EXPORTS FROM 377 – Viewport selection adapter
// ---------------------------------------------------------------------------

export {
  Tileset2DAdapter,
  ViewportState,
  createTerrainAdapter
} from './377_Tileset2DAdapter.js';

// ---------------------------------------------------------------------------
// 6. RE-EXPORTS FROM 378 – Tileset container + streaming queue + factories
// ---------------------------------------------------------------------------

export {
  Tileset2D,
  StreamingQueue,
  createHeightmapTileset,
  createMeshTileset
} from './378_Tileset2D.js';

// ---------------------------------------------------------------------------
// 7. RE-EXPORTS FROM 379 – 2D tileset barrel (convenience re-export)
// ---------------------------------------------------------------------------

export { default as Tileset2DIndex } from './379_Tileset2DIndex.js';

// ---------------------------------------------------------------------------
// 8. RE-EXPORTS FROM 380 – Terrain source hierarchy
// ---------------------------------------------------------------------------

export {
  TerrainSource,
  ProceduralTerrainSource,
  HeightmapTerrainSource,
  QuantizedMeshTerrainSource,
  createProceduralTerrainSource,
  createHeightmapTerrainSource,
  createQuantizedMeshTerrainSource
} from './380_TerrainSource.js';

// ---------------------------------------------------------------------------
// 9. RE-EXPORTS FROM 381 – Reconciler
// ---------------------------------------------------------------------------

export {
  TerrainTileReconciler,
  createTerrainTileReconciler
} from './381_ReconcileTerrainTiles.js';

// ---------------------------------------------------------------------------
// 10. CONVENIENCE NAMESPACE DEFAULT EXPORT
// ---------------------------------------------------------------------------

/**
 * Default namespace export — useful for `import TerrainPipeline from './382_TerrainPipelineIndex.js'`
 * and then `TerrainPipeline.createTerrainTileReconciler(...)`.
 *
 * The namespace intentionally mirrors the source modules so readers can
 * discover where each symbol lives just by looking at the group name.
 */
import * as Types from './373_Tileset2DTypes.js';
import * as HeightmapTile from './374_TerrainHeightmapTile.js';
import * as QuantizedMeshTile from './375_TerrainParseQuantizedMesh.js';
import * as Header from './376_Tile2DHeader.js';
import * as Adapter from './377_Tileset2DAdapter.js';
import * as Tileset from './378_Tileset2D.js';
import * as TilesetIndex from './379_Tileset2DIndex.js';
import * as Source from './380_TerrainSource.js';
import * as Reconciler from './381_ReconcileTerrainTiles.js';

export default {
  // Module groups (for introspection / tooling)
  Types,
  HeightmapTile,
  QuantizedMeshTile,
  Header,
  Adapter,
  Tileset,
  TilesetIndex,
  Source,
  Reconciler,

  // ---- Top-level factories (most frequent entry points) ----

  // Reconciler — the primary entry point the runtime calls per tick.
  createTerrainTileReconciler: Reconciler.createTerrainTileReconciler,

  // Sources — the payload producers.
  createProceduralTerrainSource: Source.createProceduralTerrainSource,
  createHeightmapTerrainSource: Source.createHeightmapTerrainSource,
  createQuantizedMeshTerrainSource: Source.createQuantizedMeshTerrainSource,

  // Tilesets — the container the reconciler drives.
  createHeightmapTileset: Tileset.createHeightmapTileset,
  createMeshTileset: Tileset.createMeshTileset,

  // Adapter — the viewport selection engine.
  createTerrainAdapter: Adapter.createTerrainAdapter,

  // ---- Class surfaces (all the public classes) ----

  // Reconciler
  TerrainTileReconciler: Reconciler.TerrainTileReconciler,

  // Sources
  TerrainSource: Source.TerrainSource,
  ProceduralTerrainSource: Source.ProceduralTerrainSource,
  HeightmapTerrainSource: Source.HeightmapTerrainSource,
  QuantizedMeshTerrainSource: Source.QuantizedMeshTerrainSource,

  // Tileset & streaming
  Tileset2D: Tileset.Tileset2D,
  StreamingQueue: Tileset.StreamingQueue,

  // Adapter & viewport
  Tileset2DAdapter: Adapter.Tileset2DAdapter,
  ViewportState: Adapter.ViewportState,

  // Quadtree node
  Tile2DHeader: Header.Tile2DHeader,
  Tile2DHeaderPool: Header.Tile2DHeaderPool,

  // Tile classes
  HeightmapTerrain: HeightmapTile.HeightmapTerrain,
  HeightmapTerrainRegistry: HeightmapTile.HeightmapTerrainRegistry,
  QuantizedMeshTerrain: QuantizedMeshTile.QuantizedMeshTerrain,
  TerrainParseQuantizedMesh: QuantizedMeshTile.TerrainParseQuantizedMesh,

  // ---- Enum surfaces ----
  TilesetSourceFormat: Types.TilesetSourceFormat,
  TileState: Types.TileState,
  TileRefinement: Types.TileRefinement,
  BoundingVolumeKind: Types.BoundingVolumeKind,
  TileEventType: Types.TileEventType,
  SeamEdge: Types.SeamEdge,

  // ---- Default options ----
  DEFAULT_TILESET_OPTIONS: Types.DEFAULT_TILESET_OPTIONS,

  // ---- Utility helpers (frequently used by downstream systems) ----
  stringTileKey: Types.stringTileKey,
  packTileKey: Types.packTileKey,
  fnv1aHash: Types.fnv1aHash,
  computeLodIndex: Types.computeLodIndex,
  computeLodBlendAlpha: Types.computeLodBlendAlpha,
  computeTilePriority: Types.computeTilePriority,
  extractFrustumPlanes: Types.extractFrustumPlanes,
  isBoxOutsideFrustum: Types.isBoxOutsideFrustum,
  isSphereOutsideFrustum: Types.isSphereOutsideFrustum,
  distanceToSphereSquared: Types.distanceToSphereSquared,
  computeScreenSpaceError: Types.computeScreenSpaceError,
  computeTileNeighbors: Types.computeTileNeighbors,
  computeChildTileCoords: Types.computeChildTileCoords,
  computeParentTileCoord: Types.computeParentTileCoord,
  hasSeam: Types.hasSeam,
  oppositeEdge: Types.oppositeEdge
};