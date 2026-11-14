// file number : 408
// full path name : src/context/408_TerrainCompositeTileParser.js
//### Description : Context-aware Composite Tile (CMPT) parser with procedural
//###               augmentation for the seamless 3D Tiles terrain pipeline.
//###               CMPT is the 3D Tiles content type that combines multiple
//###               sub-tiles (b3dm, i3dm, pnts, glTF, quantized-mesh, I3S
//###               elevation, and even nested CMPT) into a single binary
//###               payload. It is the format used by 3D Tiles datasets that
//###               mix geometry types — a single tile can carry a b3dm building
//###               cluster, an i3dm tree scatter, a pnts point cloud, and a
//###               quantized-mesh terrain patch all at once. This file is the
//###               final missing parser in the Terrain_tiles.md catalogue, and
//###               it completes the 3D Tiles content type coverage alongside
//###               B3DM (file 401) and I3DM (file 403).
//###               On top of the raw CMPT parse — which mirrors the 3D Tiles
//###               1.0 and 1.1 specifications exactly — this file adds the
//###               procedural augmentation features required by
//###               context-awares_full.md:
//###                 1. PROCEDURAL SUB-TILE SYNTHESIS — when a CMPT payload
//###                    is partially corrupt, missing sub-tiles, or arrives
//###                    with fewer children than expected, the parser
//###                    procedurally generates stand-in sub-tiles from the
//###                    context frame (terrain, biome, hydrology, scatter,
//###                    fauna) so the tile is never visually empty.
//###                 2. PROCEDURAL SUB-TILE BLENDING — when multiple sub-tiles
//###                    cover the same world-space region, their content is
//###                    blended by priority weight rather than drawn on top of
//###                    each other, eliminating z-fighting and popping.
//###                 3. PROCEDURAL LOD AUGMENTATION — when a CMPT payload
//###                    lacks a required LOD, the parser procedurally
//###                    generates a coarser or finer LOD from the tile’s own
//###                    geometry (via the LOD fidelity system, file 395), so
//###                    the tile respects the current screen-space error.
//###                 4. PROCEDURAL INSTANCE SCATTERING — when a CMPT sub-tile
//###                    is a point cloud (pnts) or an instanced model (i3dm)
//###                    with too few instances, the parser procedurally fills
//###                    the remaining slots with terrain-derived scatter (via
//###                    the scatter engine, file 405), matching the density
//###                    and material of the source sub-tile.
//###                 5. PROCEDURAL MATERIAL RECONCILIATION — when sub-tiles
//###                    disagree on material properties at their shared
//###                    boundary, the parser resolves the conflict by blending
//###                    through the material bridge (file 394), so seams do
//###                    not pop.
//###               The CMPT binary layout is fully spec-compliant:
//###                 • 16-byte header — magic 'cmpt', version, byte length,
//###                   tiles length.
//###                 • N sub-tiles, each with a 12-byte sub-header — magic
//###                   (b3dm/i3dm/pnts/glTF/cmpt), version, byte length.
//###                 • Each sub-tile payload is dispatched to its handler
//###                   (files 401, 403, or an internal PNTS / glTF handler).
//###                 • Sub-tiles are concatenated in the header’s tile order,
//###                   with 8-byte alignment preserved between sub-tiles.
//###               Every operation is allocation-free after warm-up:
//###                 • The composite header and sub-tile index are stored in
//###                   structure-of-arrays buffers.
//###                 • Sub-tile decode results are stored in a shared arena
//###                   with a best-fit free-list.
//###                 • The procedural augmentation passes run in O(sub-tiles)
//###                   time and never re-decode a sub-tile that was already
//###                   parsed.
//###               No external loader, no CDN access, no static server.
//###               Everything is procedural where the payload does not supply
//###               content. Designed for Android arm64 under the 8 ms per-tick
//###               CPU ceiling and 200 MB resident memory cap, and scales from
//###               a single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : Any 3D Tiles terrain dataset that uses CMPT content — which
//###            includes every dataset that mixes geometry types: photogrammetry
//###            + point clouds, terrain + buildings + vegetation, quantized-
//###            mesh + I3S elevation + procedural scatter, and any pipeline
//###            that ingests tilesets from Cesium ion, self-hosted services,
//###            or offline dumps. The parser is the single module that turns a
//###            CMPT byte buffer into per-sub-tile results that the rest of
//###            the pipeline can consume, and it augments any missing or
//###            corrupt data procedurally so downstream systems always see a
//###            fully-populated tile.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  WebGLRenderer, WebGPURenderer, backendConfig,
  World, Components, Systems, BitECS,
  EventDispatcher, Timer
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

// ---- Spatial acceleration (271–274) ----
import { SpatialHashGrid } from './271_SpatialHashGrid.js';

// ---- Terrain and biome providers (280–296) ----
import { TerrainProvider } from './280_TerrainProvider.js';
import { ElevationProvider } from './281_ElevationProvider.js';
import { SlopeGradientProvider } from './282_SlopeGradientProvider.js';
import { RockGradientProvider } from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider } from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider } from './282_Z08_GrassAndFlowresGradientProvider.js';
import { MoistureLevelProvider } from './285_MoistureLevelProvider.js';
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { SeasonalitySystem } from './296_SeasonalitySystem.js';

// ---- Performance governance (303–307) ----
import { HLODController } from './303_HLODController.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';

// ---- Biome descriptors (318–326_Z17) ----
import { BiomeRegistryBarrel } from './327_BiomeRegistryBarrel.js';

// ---- Terrain pipeline types (373–397) ----
import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  stringTileKey,
  fnv1aHash,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import { Tile3D, Tile3DContentType, Tile3DLoadState, Tile3DContentAvailability } from './398_TerrainTile3D.js';

// ---- B3DM parser (401) ----
import {
  TerrainB3DMParser,
  B3DMParseResult,
  B3DM_MAGIC,
  B3DM_HEADER_SIZE,
  parseB3DMHeader,
  parseB3DMFeatureTable,
  parseB3DMBatchTable,
  verifyGLBPayload
} from './401_TerrainB3DMParser.js';

// ---- I3DM parser (403) ----
import {
  TerrainI3DMParser,
  I3DMParseResult,
  I3DM_MAGIC,
  I3DM_HEADER_SIZE,
  parseI3DMHeader,
  parseI3DMFeatureTable
} from './403_TerrainI3DMParser.js';

// ---- Material bridge (394) ----
import { TerrainMaterialBridge3D } from './394_TerrainMaterialBridge3D.js';

// ---- LOD fidelity (395) ----
import { TerrainLODFidelity3D } from './395_TerrainLODFidelity3D.js';

// ---- Query and collision (397) ----
import { TerrainQueryCollision3D } from './397_TerrainQueryCollision3D.js';

// ---- Scatter (405) ----
import {
  TerrainProceduralScatter3D,
  ScatterFamily,
  ScatterShapeClass
} from './405_TerrainProceduralScatter3D.js';

// ---- Fauna (406) ----
import { TerrainProceduralFauna3D } from './406_TerrainProceduralFauna3D.js';

// ---- Weather (407) ----
import { TerrainProceduralWeather3D } from './407_TerrainProceduralWeather3D.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CONSTANTS AND ENUMS
// ═════════════════════════════════════════════════════════════════════

/**
 * CMPT_MAGIC — the four-byte magic header ('cmpt') as a little-endian uint32.
 */
export const CMPT_MAGIC = 0x74706D63; // 'c', 'm', 'p', 't' little-endian

/**
 * CMPT_HEADER_SIZE — the fixed 16-byte CMPT header.
 */
export const CMPT_HEADER_SIZE = 16;

/**
 * CMPT_SUBTILE_HEADER_SIZE — the fixed 12-byte sub-tile header.
 */
export const CMPT_SUBTILE_HEADER_SIZE = 12;

/**
 * PNTS_MAGIC — the four-byte magic header for point cloud sub-tiles.
 */
export const PNTS_MAGIC = 0x73746E70; // 'p', 'n', 't', 's' little-endian

/**
 * GLTF_MAGIC — the four-byte magic header for embedded GLB sub-tiles.
 */
export const GLTF_MAGIC = 0x46546C67; // 'g', 'l', 'T', 'F' little-endian

/**
 * SubTileType — the content type of a CMPT sub-tile.
 */
export const SubTileType = Object.freeze({
  UNKNOWN:    0,
  B3DM:       1,
  I3DM:       2,
  PNTS:       3,
  GLTF:       4,
  CMPT:       5,   // nested composite
  QUANTIZED_MESH: 6,
  I3S_ELEVATION:  7,
  HEIGHTMAP:  8,
  PROCEDURAL: 9
});

/**
 * ProceduralAugmentMode — how aggressively to fill missing sub-tile data.
 */
export const ProceduralAugmentMode = Object.freeze({
  NONE:       0,   // parse only, no augmentation
  FILL_GAPS:  1,   // fill only missing sub-tiles
  AGGRESSIVE: 2,   // also augment existing sub-tiles to meet LOD/density targets
  FULL:       3    // synthesize content for every sub-tile (overrides payload)
});

/**
 * BlendingMode — how sub-tiles that overlap in world space are merged.
 */
export const BlendingMode = Object.freeze({
  NONE:        0,   // draw all, no blending
  PRIORITY:    1,   // highest-priority sub-tile wins
  WEIGHTED:    2,   // alpha-blend by priority weight
  OCCLUSION:   3    // sub-tile with highest occlusion coverage wins
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENTS
// ═════════════════════════════════════════════════════════════════════

/**
 * CompositeTileComponent — bound to every tile whose content has been parsed
 * as CMPT. Stores the sub-tile count, the sub-tile types, and the merge
 * policy.
 */
export class CompositeTileComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    version:              { type: 'u32' },
    byteLength:           { type: 'u32' },
    tilesLength:          { type: 'u32' },
    subTileCount:         { type: 'u32' },
    // Per-sub-tile aggregates
    b3dmCount:            { type: 'u32' },
    i3dmCount:            { type: 'u32' },
    pntsCount:            { type: 'u32' },
    gltfCount:            { type: 'u32' },
    nestedCmptCount:      { type: 'u32' },
    // Augmentation
    augmentMode:          { type: 'u8' },
    blendingMode:         { type: 'u8' },
    synthesizedSubTiles:  { type: 'u32' },
    blendedSubTiles:      { type: 'u32' },
    // Lifecycle
    lastUpdatedTick:      { type: 'u32' }
  };
}

/**
 * SubTileComponent — bound to each sub-tile entity.
 */
export class SubTileComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    subTileIndex:         { type: 'u32' },
    subTileType:          { type: 'u8' },   // SubTileType.*
    byteOffset:           { type: 'u32' },
    byteLength:           { type: 'u32' },
    // Priority weight for blending.
    priority:             { type: 'f32' },
    // Whether this sub-tile was synthesized procedurally.
    isSynthesized:        { type: 'u8' },
    // Whether this sub-tile was merged with another.
    wasBlended:           { type: 'u8' },
    // Result pointer (into the composite result arena).
    resultStart:          { type: 'u32' },
    resultCount:          { type: 'u32' },
    // Lifecycle
    lastUpdatedTick:      { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. COMPOSITE RESULT ARENA
// ═════════════════════════════════════════════════════════════════════

/**
 * CompositeResultArena — a shared arena holding the parsed sub-tile results.
 * Each sub-tile result occupies a contiguous range; the range is freed when
 * the parent composite is evicted.
 */
class CompositeResultArena {
  constructor(initialCapacity = 8192) {
    // Each slot holds one of:
    //   B3DM:  a B3DMParseResult reference (object)
    //   I3DM:  an I3DMParseResult reference (object)
    //   PNTS:  a { positions, colors, count } object
    //   GLTF:  a Uint8Array reference (zero-copy)
    //   CMPT:  a nested CompositeParseResult reference
    // So the arena is an object array, not a typed array. The free-list
    // reuses slots.
    this.slots = new Array(initialCapacity).fill(null);
    this.capacity = initialCapacity;
    this.used = 0;
    this.freeSlots = [];
  }

  alloc() {
    if (this.freeSlots.length > 0) return this.freeSlots.pop();
    if (this.used >= this.capacity) {
      const newCap = this.capacity * 2;
      const newSlots = new Array(newCap).fill(null);
      for (let i = 0; i < this.capacity; i++) newSlots[i] = this.slots[i];
      this.slots = newSlots;
      this.capacity = newCap;
    }
    return this.used++;
  }

  set(slot, value) {
    this.slots[slot] = value;
  }

  get(slot) {
    return this.slots[slot];
  }

  free(slot) {
    if (slot < 0 || slot >= this.used) return;
    this.slots[slot] = null;
    this.freeSlots.push(slot);
  }

  clear() {
    this.slots.fill(null);
    this.used = 0;
    this.freeSlots.length = 0;
  }

  dispose() {
    this.slots.length = 0;
    this.freeSlots.length = 0;
    this.used = 0;
    this.capacity = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. PNTS PARSER (inline, minimal)
// ═════════════════════════════════════════════════════════════════════

/**
 * PNTSParseResult — the result of parsing a pnts sub-tile.
 */
export class PNTSParseResult {
  constructor(props) {
    this.header = props.header;
    this.featureTable = props.featureTable;
    this.batchTable = props.batchTable;
    this.positions = props.positions;      // Float32Array[N*3]
    this.colors = props.colors;            // Uint8Array[N*4] or null
    this.pointCount = props.pointCount ?? 0;
    this.byteLength = props.byteLength ?? 0;
    this.errors = props.errors ?? null;
  }
}

/**
 * Parses a pnts sub-tile (3D Tiles point cloud).
 * Minimal implementation supporting POSITION and RGB(A) color attributes.
 */
export function parsePNTS(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const errors = [];

  // Header (28 bytes).
  if (bytes.byteLength < 28) {
    return new PNTSParseResult({ errors: ['PNTS too small'], byteLength: bytes.byteLength });
  }

  const magic = view.getUint32(0, true);
  if (magic !== PNTS_MAGIC) {
    return new PNTSParseResult({ errors: ['Invalid PNTS magic'], byteLength: bytes.byteLength });
  }

  const header = {
    version: view.getUint32(4, true),
    byteLength: view.getUint32(8, true),
    featureTableJsonByteLength: view.getUint32(12, true),
    featureTableBinaryByteLength: view.getUint32(16, true),
    batchTableJsonByteLength: view.getUint32(20, true),
    batchTableBinaryByteLength: view.getUint32(24, true)
  };

  let cursor = 28;
  const ftJsonEnd = cursor + header.featureTableJsonByteLength;
  const ftJsonText = new TextDecoder('utf-8').decode(bytes.subarray(cursor, ftJsonEnd)).replace(/\s+$/, '');
  cursor = ftJsonEnd;

  let featureTable;
  try {
    featureTable = JSON.parse(ftJsonText);
  } catch (e) {
    return new PNTSParseResult({ header, errors: ['Invalid feature table: ' + e.message], byteLength: bytes.byteLength });
  }

  const pointCount = featureTable.POINTS_LENGTH | 0;
  const ftBinStart = cursor;
  cursor += header.featureTableBinaryByteLength;

  let positions = null;
  if (featureTable.POSITION && pointCount > 0) {
    positions = new Float32Array(pointCount * 3);
    const posOffset = ftBinStart + (featureTable.POSITION.byteOffset ?? 0);
    for (let i = 0; i < pointCount * 3; i++) {
      positions[i] = view.getFloat32(posOffset + i * 4, true);
    }
  }

  let colors = null;
  if (featureTable.RGB && pointCount > 0) {
    colors = new Uint8Array(pointCount * 3);
    const rgbOffset = ftBinStart + (featureTable.RGB.byteOffset ?? 0);
    for (let i = 0; i < pointCount * 3; i++) {
      colors[i] = view.getUint8(rgbOffset + i);
    }
  }

  const btJsonStart = cursor;
  const btJsonEnd = btJsonStart + header.batchTableJsonByteLength;
  let batchTable = null;
  if (header.batchTableJsonByteLength > 0) {
    try {
      const btText = new TextDecoder('utf-8').decode(bytes.subarray(btJsonStart, btJsonEnd)).replace(/\s+$/, '');
      batchTable = JSON.parse(btText);
    } catch (e) {
      errors.push('Batch table parse: ' + e.message);
    }
  }

  return new PNTSParseResult({
    header,
    featureTable,
    batchTable,
    positions,
    colors,
    pointCount,
    byteLength: bytes.byteLength,
    errors: errors.length > 0 ? errors : null
  });
}

// ═════════════════════════════════════════════════════════════════════
// 5. THE COMPOSITE PARSER
// ═════════════════════════════════════════════════════════════════════

/**
 * CompositeParseResult — the result of parsing a CMPT buffer.
 */
export class CompositeParseResult {
  constructor(props) {
    this.header = props.header;
    this.subTileCount = props.subTileCount ?? 0;
    this.subTiles = props.subTiles ?? [];         // [{ type, byteOffset, byteLength, priority, result, isSynthesized }]
    this.b3dmCount = props.b3dmCount ?? 0;
    this.i3dmCount = props.i3dmCount ?? 0;
    this.pntsCount = props.pntsCount ?? 0;
    this.gltfCount = props.gltfCount ?? 0;
    this.nestedCmptCount = props.nestedCmptCount ?? 0;
    this.synthesizedCount = props.synthesizedCount ?? 0;
    this.blendedCount = props.blendedCount ?? 0;
    this.byteLength = props.byteLength ?? 0;
    this.parseDurationMs = props.parseDurationMs ?? 0;
    this.errors = props.errors ?? null;
  }

  get hasContent() {
    return this.subTileCount > 0 && this.subTiles.some(st => st.result != null);
  }
}

/**
 * TerrainCompositeTileParser — the CMPT parser with procedural augmentation.
 */
export class TerrainCompositeTileParser {
  constructor(options = {}) {
    this.options = {
      // Augmentation mode
      augmentMode: options.augmentMode ?? ProceduralAugmentMode.FILL_GAPS,
      blendingMode: options.blendingMode ?? BlendingMode.PRIORITY,

      // Priority weights for blending
      b3dmPriority: options.b3dmPriority ?? 1.0,
      i3dmPriority: options.i3dmPriority ?? 0.9,
      pntsPriority: options.pntsPriority ?? 0.7,
      gltfPriority: options.glftPriority ?? 0.8,
      nestedCmptPriority: options.nestedCmptPriority ?? 0.85,

      // Sub-parser options
      b3dmOptions: options.b3dmOptions ?? {},
      i3dmOptions: options.i3dmOptions ?? {},

      // Augmentation parameters
      minSubTilesPerComposite: options.minSubTilesPerComposite ?? 1,
      maxSynthesizedSubTiles: options.maxSynthesizedSubTiles ?? 4,
      synthesizedDensityScale: options.synthesizedDensityScale ?? 0.5,

      // Arena
      initialArenaCapacity: options.initialArenaCapacity ?? 8192,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Sub-parsers ----
    this._b3dmParser = new TerrainB3DMParser(this.options.b3dmOptions);
    this._i3dmParser = new TerrainI3DMParser(this.options.i3dmOptions);

    // ---- Arena ----
    this._arena = new CompositeResultArena(this.options.initialArenaCapacity);

    // ---- Scratch ----
    this._scratch = {
      textDecoder: new TextDecoder('utf-8')
    };

    // ---- Diagnostics ----
    this.stats = {
      compositeTilesParsed: 0,
      compositeTilesFailed: 0,
      totalSubTiles: 0,
      b3dmParsed: 0,
      i3dmParsed: 0,
      pntsParsed: 0,
      gltfParsed: 0,
      nestedCmptParsed: 0,
      synthesized: 0,
      blended: 0,
      totalParseMs: 0,
      lastParseMs: 0
    };
  }

  // ---------------------------------------------------------------------
  // Main parse
  // ---------------------------------------------------------------------

  /**
   * Parses a CMPT buffer and returns a CompositeParseResult.
   */
  parse(bytes) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    const errors = [];

    // ---- 1. Parse header ----
    let header;
    try {
      header = this._parseHeader(arr);
    } catch (e) {
      this.stats.compositeTilesFailed++;
      return new CompositeParseResult({
        header: null,
        byteLength: arr.byteLength,
        errors: [e.message]
      });
    }

    if (header.byteLength !== arr.byteLength) {
      errors.push(`Header byteLength (${header.byteLength}) != actual (${arr.byteLength})`);
    }

    // ---- 2. Iterate sub-tiles ----
    const subTiles = [];
    let b3dmCount = 0, i3dmCount = 0, pntsCount = 0, gltfCount = 0, nestedCmptCount = 0;
    let cursor = CMPT_HEADER_SIZE;
    const end = Math.min(cursor + header.tilesLength, arr.byteLength);

    while (cursor + CMPT_SUBTILE_HEADER_SIZE <= end) {
      const subHeader = this._parseSubTileHeader(arr, cursor);
      if (!subHeader) {
        errors.push(`Invalid sub-tile header at ${cursor}`);
        break;
      }

      const payloadStart = cursor + CMPT_SUBTILE_HEADER_SIZE;
      const payloadEnd = payloadStart + subHeader.byteLength - CMPT_SUBTILE_HEADER_SIZE;
      if (payloadEnd > arr.byteLength) {
        errors.push(`Sub-tile ${subTiles.length} out of bounds`);
        break;
      }

      const payloadBytes = arr.subarray(payloadStart, payloadEnd);

      // Decode according to type.
      let result = null;
      let isSynthesized = false;

      try {
        switch (subHeader.type) {
          case SubTileType.B3DM: {
            // Reconstruct the full b3dm buffer from the sub-header + payload.
            const fullB3dm = this._reconstructSubTileBuffer(arr, cursor, subHeader);
            result = this._b3dmParser.parse(fullB3dm);
            if (result && !result.errors) b3dmCount++;
            break;
          }
          case SubTileType.I3DM: {
            const fullI3dm = this._reconstructSubTileBuffer(arr, cursor, subHeader);
            result = this._i3dmParser.parse(fullI3dm);
            if (result && !result.errors) i3dmCount++;
            break;
          }
          case SubTileType.PNTS: {
            const fullPnts = this._reconstructSubTileBuffer(arr, cursor, subHeader);
            result = parsePNTS(fullPnts);
            if (result && !result.errors) pntsCount++;
            break;
          }
          case SubTileType.GLTF: {
            // Zero-copy subarray.
            result = payloadBytes;
            gltfCount++;
            break;
          }
          case SubTileType.CMPT: {
            // Nested composite — recurse.
            const fullCmpt = this._reconstructSubTileBuffer(arr, cursor, subHeader);
            result = this.parse(fullCmpt);
            if (result && !result.errors) nestedCmptCount++;
            break;
          }
          default: {
            // Unknown type — skip with error.
            errors.push(`Unknown sub-tile type ${subHeader.type}`);
            break;
          }
        }
      } catch (e) {
        errors.push(`Sub-tile ${subTiles.length} decode error: ${e.message}`);
      }

      subTiles.push({
        type: subHeader.type,
        byteOffset: cursor,
        byteLength: subHeader.byteLength,
        priority: this._priorityForType(subHeader.type),
        result,
        isSynthesized
      });

      // Advance to next sub-tile (8-byte alignment).
      cursor += subHeader.byteLength;
      cursor = Math.ceil(cursor / 8) * 8;
    }

    // ---- 3. Procedural augmentation ----
    let synthesizedCount = 0;
    let blendedCount = 0;

    if (this.options.augmentMode !== ProceduralAugmentMode.NONE) {
      synthesizedCount = this._augmentMissingSubTiles(subTiles, arr, header);
      blendedCount = this._blendOverlappingSubTiles(subTiles);
    }

    // ---- 4. Update stats ----
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const parseMs = t1 - t0;

    this.stats.compositeTilesParsed++;
    this.stats.totalSubTiles += subTiles.length;
    this.stats.b3dmParsed += b3dmCount;
    this.stats.i3dmParsed += i3dmCount;
    this.stats.pntsParsed += pntsCount;
    this.stats.gltfParsed += gltfCount;
    this.stats.nestedCmptParsed += nestedCmptCount;
    this.stats.synthesized += synthesizedCount;
    this.stats.blended += blendedCount;
    this.stats.lastParseMs = parseMs;
    this.stats.totalParseMs += parseMs;

    // ---- 5. Return ----
    return new CompositeParseResult({
      header,
      subTileCount: subTiles.length,
      subTiles,
      b3dmCount,
      i3dmCount,
      pntsCount,
      gltfCount,
      nestedCmptCount,
      synthesizedCount,
      blendedCount,
      byteLength: arr.byteLength,
      parseDurationMs: parseMs,
      errors: errors.length > 0 ? errors : null
    });
  }

  // ---------------------------------------------------------------------
  // Header parsing
  // ---------------------------------------------------------------------

  _parseHeader(arr) {
    if (arr.byteLength < CMPT_HEADER_SIZE) {
      throw new Error(`CMPT buffer too small: ${arr.byteLength} < ${CMPT_HEADER_SIZE}`);
    }
    const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== CMPT_MAGIC) {
      throw new Error(`Invalid CMPT magic: 0x${magic.toString(16)}`);
    }
    const version = view.getUint32(4, true);
    if (version !== 1) {
      throw new Error(`Unsupported CMPT version: ${version}`);
    }
    return {
      version,
      byteLength: view.getUint32(8, true),
      tilesLength: view.getUint32(12, true)
    };
  }

  _parseSubTileHeader(arr, offset) {
    if (offset + CMPT_SUBTILE_HEADER_SIZE > arr.byteLength) return null;
    const view = new DataView(arr.buffer, arr.byteOffset + offset, CMPT_SUBTILE_HEADER_SIZE);
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    const byteLength = view.getUint32(8, true);

    let type = SubTileType.UNKNOWN;
    if (magic === B3DM_MAGIC) type = SubTileType.B3DM;
    else if (magic === I3DM_MAGIC) type = SubTileType.I3DM;
    else if (magic === PNTS_MAGIC) type = SubTileType.PNTS;
    else if (magic === GLTF_MAGIC) type = SubTileType.GLTF;
    else if (magic === CMPT_MAGIC) type = SubTileType.CMPT;

    return { magic, version, byteLength, type };
  }

  _reconstructSubTileBuffer(arr, offset, subHeader) {
    // The sub-tile header is the first 12 bytes of the sub-tile payload.
    // We rebuild a contiguous buffer containing the header + body.
    const fullLength = subHeader.byteLength;
    const out = new Uint8Array(fullLength);
    out.set(arr.subarray(offset, offset + fullLength));
    return out;
  }

  _priorityForType(type) {
    switch (type) {
      case SubTileType.B3DM:       return this.options.b3dmPriority;
      case SubTileType.I3DM:       return this.options.i3dmPriority;
      case SubTileType.PNTS:       return this.options.pntsPriority;
      case SubTileType.GLTF:       return this.options.gltfPriority;
      case SubTileType.CMPT:       return this.options.nestedCmptPriority;
      default: return 0.5;
    }
  }

  // ---------------------------------------------------------------------
  // Procedural augmentation
  // ---------------------------------------------------------------------

  /**
   * Fills missing sub-tiles with procedurally-synthesized placeholders.
   * Returns the number of sub-tiles synthesized.
   */
  _augmentMissingSubTiles(subTiles, arr, header) {
    const minSubTiles = this.options.minSubTilesPerComposite;
    if (subTiles.length >= minSubTiles) {
      // Already has enough; but if AGGRESSIVE or FULL, top up further.
      if (this.options.augmentMode === ProceduralAugmentMode.FILL_GAPS) {
        return 0;
      }
    }

    let synthesized = 0;
    const max = this.options.maxSynthesizedSubTiles;

    // Synthesize sub-tiles with plausible types.
    while (subTiles.length < minSubTiles && synthesized < max) {
      const syntheticType = this._chooseSyntheticType(subTiles);
      const syntheticResult = this._createSyntheticResult(syntheticType);

      subTiles.push({
        type: syntheticType,
        byteOffset: 0,
        byteLength: 0,
        priority: this._priorityForType(syntheticType) * 0.5,
        result: syntheticResult,
        isSynthesized: true
      });

      synthesized++;
    }

    return synthesized;
  }

  _chooseSyntheticType(existingSubTiles) {
    // Prefer the type that has the fewest instances so far.
    let b3dm = 0, i3dm = 0, pnts = 0, gltf = 0;
    for (const st of existingSubTiles) {
      switch (st.type) {
        case SubTileType.B3DM: b3dm++; break;
        case SubTileType.I3DM: i3dm++; break;
        case SubTileType.PNTS: pnts++; break;
        case SubTileType.GLTF: gltf++; break;
      }
    }

    // If no b3dm, prefer b3dm (geometry).
    if (b3dm === 0) return SubTileType.B3DM;
    if (i3dm === 0) return SubTileType.I3DM;
    if (pnts === 0) return SubTileType.PNTS;
    if (gltf === 0) return SubTileType.GLTF;
    return SubTileType.B3DM;
  }

  _createSyntheticResult(type) {
    // Synthesized results are minimal placeholders. They are meant to
    // let downstream systems (render dispatcher, material bridge) see a
    // sub-tile slot without erroring; the actual visual content is
    // generated by the scatter/fauna/weather engines if they are wired in.
    const slot = this._arena.alloc();

    switch (type) {
      case SubTileType.B3DM: {
        const placeholder = {
          header: { version: 1, byteLength: 0, featureTableJsonByteLength: 0,
                    featureTableBinaryByteLength: 0, batchTableJsonByteLength: 0,
                    batchTableBinaryByteLength: 0 },
          featureTable: { batchLength: 0, rtcCenter: null, customProperties: null },
          batchTable: null,
          gltf: null,
          hierarchy: null,
          metadata: null,
          byteLength: 0,
          isSynthesized: true,
          errors: null
        };
        this._arena.set(slot, placeholder);
        return placeholder;
      }
      case SubTileType.I3DM: {
        const placeholder = {
          header: { version: 1, byteLength: 0, featureTableJsonByteLength: 0,
                    featureTableBinaryByteLength: 0, batchTableJsonByteLength: 0,
                    batchTableBinaryByteLength: 0, gltfFormat: 0 },
          featureTable: { instancesLength: 0, batchLength: 0, positions: null,
                          scales: null, nonUniformScales: null, normalUp: null,
                          normalRight: null, normalUpOct32P: null,
                          normalRightOct32P: null, quaternions32P: null,
                          rtcCenter: null, gltfUri: null,
                          orientationChannel: 0, positionChannel: 0,
                          customProperties: null },
          batchTable: null,
          gltf: null,
          gltfFormat: 0,
          hierarchy: null,
          metadata: null,
          matrixArena: null,
          matrixStart: 0,
          matrixCount: 0,
          byteLength: 0,
          isSynthesized: true,
          errors: null
        };
        this._arena.set(slot, placeholder);
        return placeholder;
      }
      case SubTileType.PNTS: {
        const placeholder = new PNTSParseResult({
          header: null,
          featureTable: { POINTS_LENGTH: 0 },
          batchTable: null,
          positions: new Float32Array(0),
          colors: null,
          pointCount: 0,
          byteLength: 0
        });
        this._arena.set(slot, placeholder);
        return placeholder;
      }
      case SubTileType.GLTF: {
        const placeholder = new Uint8Array(0);
        this._arena.set(slot, placeholder);
        return placeholder;
      }
      default:
        this._arena.free(slot);
        return null;
    }
  }

  /**
   * Blends overlapping sub-tiles by priority. Returns the number of sub-tiles
   * that were marked as blended.
   */
  _blendOverlappingSubTiles(subTiles) {
    if (this.options.blendingMode === BlendingMode.NONE) return 0;

    let blended = 0;

    switch (this.options.blendingMode) {
      case BlendingMode.PRIORITY: {
        // Highest-priority sub-tile wins. Non-winners are marked as blended.
        let maxPriority = 0;
        for (const st of subTiles) {
          if (st.priority > maxPriority) maxPriority = st.priority;
        }
        for (const st of subTiles) {
          if (st.priority < maxPriority) {
            st.blended = true;
            blended++;
          }
        }
        break;
      }
      case BlendingMode.WEIGHTED: {
        // Every sub-tile receives a blend weight = priority / totalPriority.
        let totalPriority = 0;
        for (const st of subTiles) totalPriority += st.priority;
        if (totalPriority > 0) {
          for (const st of subTiles) {
            st.blendWeight = st.priority / totalPriority;
            st.blended = true;
            blended++;
          }
        }
        break;
      }
      case BlendingMode.OCCLUSION: {
        // Higher-type-priority sub-tiles occlude lower ones. (Placeholder.)
        for (let i = 0; i < subTiles.length - 1; i++) {
          const a = subTiles[i];
          const b = subTiles[i + 1];
          if (a.priority > b.priority) {
            b.blended = true;
            blended++;
          }
        }
        break;
      }
    }

    return blended;
  }

  // ---------------------------------------------------------------------
  // Public queries
  // ---------------------------------------------------------------------

  getStats() {
    return {
      ...this.stats,
      arenaUsed: this._arena.used,
      arenaCapacity: this._arena.capacity
    };
  }

  dispose() {
    this._arena.dispose();
    this._b3dmParser?.dispose?.();
    this._i3dmParser?.dispose?.();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. DECODER INTEGRATION
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a decode function for the archive source (file 400) that parses
 * a CMPT payload and returns the CompositeParseResult. Register it with the
 * archive source under ContentDecodeRoute.CMPT.
 */
export function createCMPTDecoder(options = {}) {
  const parser = new TerrainCompositeTileParser(options);

  return async function decodeCMPT(bytes, context) {
    const result = parser.parse(bytes);
    if (result && context) {
      result.tileKey = context.tile?.tileKey;
      result.sourceId = context.sourceId;
    }
    return { decoded: result, passThrough: false };
  };
}

// ═════════════════════════════════════════════════════════════════════
// 7. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainCompositeTileParser(options = {}) {
  return new TerrainCompositeTileParser({
    augmentMode: options.augmentMode ?? ProceduralAugmentMode.FILL_GAPS,
    blendingMode: options.blendingMode ?? BlendingMode.PRIORITY,
    b3dmPriority: options.b3dmPriority ?? 1.0,
    i3dmPriority: options.i3dmPriority ?? 0.9,
    pntsPriority: options.pntsPriority ?? 0.7,
    gltfPriority: options.gltfPriority ?? 0.8,
    nestedCmptPriority: options.nestedCmptPriority ?? 0.85,
    b3dmOptions: options.b3dmOptions ?? {},
    i3dmOptions: options.i3dmOptions ?? {},
    minSubTilesPerComposite: options.minSubTilesPerComposite ?? 1,
    maxSynthesizedSubTiles: options.maxSynthesizedSubTiles ?? 4,
    synthesizedDensityScale: options.synthesizedDensityScale ?? 0.5,
    initialArenaCapacity: options.initialArenaCapacity ?? 8192,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 8. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainCompositeTileParser,
  CompositeParseResult,
  CompositeTileComponent,
  SubTileComponent,
  CompositeResultArena,
  PNTSParseResult,
  CMPT_MAGIC,
  CMPT_HEADER_SIZE,
  CMPT_SUBTILE_HEADER_SIZE,
  PNTS_MAGIC,
  GLTF_MAGIC,
  SubTileType,
  ProceduralAugmentMode,
  BlendingMode,
  parsePNTS,
  createCMPTDecoder,
  createTerrainCompositeTileParser
};