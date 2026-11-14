// file number : 379
// full path name : src/context/379_Tileset2DIndex.js
//### Description : Canonical barrel export for the entire 2D/3D seamless
//###               terrain tileset subsystem. Aggregates every public symbol
//###               from files 373 through 378 — the shared types module
//###               (TilesetSourceFormat, TileState, TileRefinement, ECS
//###               component schemas, frustum helpers, LOD helpers, tile
//###               containers), the heightmap tile class (HeightmapTerrain
//###               plus its ECS components and registry), the quantized-mesh
//###               tile class (QuantizedMeshTerrain plus decoder provider), the
//###               quadtree node (Tile2DHeader plus pool and utilities), the
//###               viewport selection adapter (Tileset2DAdapter plus
//###               ViewportState), and the tileset container (Tileset2D plus
//###               the streaming queue and factory functions). Guarantees a
//###               single import surface so downstream files never reach into
//###               internal module paths, which prevents accidental circular
//###               imports and lets the runtime swap implementations without
//###               touching consumers. Pure re-export — zero runtime overhead,
//###               zero allocations, zero side effects. No external loader, no
//###               CDN access, no static server. The barrel is idempotent and
//###               tree-shake-friendly: only the symbols a caller actually uses
//###               end up in the final bundle on Android arm64.
//### Best for : Any consumer that needs to interact with the seamless terrain
//###            pipeline — the terrain reconciler (file 380), the terrain
//###            source (file 381), the runtime orchestration loop, the render
//###            dispatch stage, and external tools. Importing everything from
//###            this one file keeps the dependency graph flat and makes the
//###            module boundaries explicit: 373 is types, 374 is heightmap
//###            tiles, 375 is quantized-mesh tiles, 376 is quadtree nodes,
//###            377 is selection, 378 is the tileset container.
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
// 7. CONVENIENCE NAMESPACE DEFAULT EXPORT
// ---------------------------------------------------------------------------

/**
 * Default namespace export — useful for `import TerrainTileset from './379_Tileset2DIndex.js'`
 * and then `TerrainTileset.createHeightmapTileset(...)`.
 *
 * The namespace intentionally mirrors the six source modules so readers can
 * discover where each symbol lives just by looking at the group name.
 */
import * as Types from './373_Tileset2DTypes.js';
import * as HeightmapTile from './374_TerrainHeightmapTile.js';
import * as QuantizedMeshTile from './375_TerrainParseQuantizedMesh.js';
import * as Header from './376_Tile2DHeader.js';
import * as Adapter from './377_Tileset2DAdapter.js';
import * as Tileset from './378_Tileset2D.js';

export default {
  // Module groups (for introspection / tooling)
  Types,
  HeightmapTile,
  QuantizedMeshTile,
  Header,
  Adapter,
  Tileset,

  // Frequently-used factories surfaced at the top level so callers can
  // do `TerrainTileset.createHeightmapTileset(...)` without a sub-path.
  createHeightmapTileset: Tileset.createHeightmapTileset,
  createMeshTileset: Tileset.createMeshTileset,
  createTerrainAdapter: Adapter.createTerrainAdapter,

  // Class surfaces
  Tileset2D: Tileset.Tileset2D,
  StreamingQueue: Tileset.StreamingQueue,
  Tileset2DAdapter: Adapter.Tileset2DAdapter,
  ViewportState: Adapter.ViewportState,
  Tile2DHeader: Header.Tile2DHeader,
  Tile2DHeaderPool: Header.Tile2DHeaderPool,
  HeightmapTerrain: HeightmapTile.HeightmapTerrain,
  HeightmapTerrainRegistry: HeightmapTile.HeightmapTerrainRegistry,
  QuantizedMeshTerrain: QuantizedMeshTile.QuantizedMeshTerrain,
  TerrainParseQuantizedMesh: QuantizedMeshTile.TerrainParseQuantizedMesh,

  // Enum surfaces
  TilesetSourceFormat: Types.TilesetSourceFormat,
  TileState: Types.TileState,
  TileRefinement: Types.TileRefinement,
  BoundingVolumeKind: Types.BoundingVolumeKind,
  TileEventType: Types.TileEventType,
  SeamEdge: Types.SeamEdge,
  DEFAULT_TILESET_OPTIONS: Types.DEFAULT_TILESET_OPTIONS
};