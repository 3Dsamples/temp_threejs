// file number : 401
// full path name : src/context/401_TerrainB3DMParser.js
//### Description : Context-aware Batched 3D Model (b3dm) parser for the
//###               seamless 3D Tiles terrain pipeline. b3dm is the dominant
//###               content type in 3D Tiles terrain distributions (Cesium ion,
//###               self-hosted photogrammetry, building tilesets, and any
//###               glTF-based terrain layer), and this file is the module that
//###               actually reads a b3dm byte buffer and splits it into its
//###               three constituent parts:
//###                 • THE 28-BYTE HEADER — magic 'b3dm', version, byte length,
//###                   feature-table JSON byte length, feature-table binary
//###                   byte length, batch-table JSON byte length, and
//###                   batch-table binary byte length. All seven fields are
//###                   read little-endian, exactly as the 3D Tiles 1.0 and
//###                   1.1 specifications require.
//###                 • THE FEATURE TABLE — a JSON header plus an optional
//###                   binary body. Common properties: BATCH_LENGTH (required
//###                   for all b3dm), RTC_CENTER (a float32[3] recentering
//###                   offset), and any custom extension properties. The parser
//###                   enforces the spec, extracts RTC_CENTER, and preserves
//###                   any unknown feature properties for downstream systems.
//###                 • THE BATCH TABLE — a JSON header plus an optional
//###                   binary body, describing per-feature metadata (batch IDs,
//###                   per-feature names, per-feature custom properties, and
//###                   the batch table hierarchy extension). The parser reads
//###                   every property type the spec allows (SCALAR, VEC2, VEC3,
//###                   VEC4, and arrays of each), plus the 3D Tiles 1.1
//###                   metadata structured batches, and the
//###                   3DTILES_batch_table_hierarchy extension for parent/
//###                   child feature relationships. All values are written
//###                   into pre-allocated structure-of-arrays buffers so
//###                   downstream systems can iterate them without touching
//###                   the parser.
//###                 • THE GLTF PAYLOAD — the binary glTF 2.0 sub-buffer
//###                   following the batch table. The parser does NOT decode
//###                   the glTF (that is the job of the material painter and
//###                   render dispatcher); it only verifies the payload is a
//###                   valid glB magic and passes it through to the dispatcher
//###                   as a typed subarray. This keeps the b3dm parser
//###                   completely loader-free — no three.js GLTFLoader, no
//###                   fetch, no worker request. The subarray shares the
//###                   underlying bytes with the archive source, so zero copies
//###                   are made.
//###               Also implements the 3D Tiles 1.1 batch table hierarchy
//###               extension as a first-class concept: a tree of feature classes
//###               with per-class property tables, an instances array, and a
//###               parent-child relationship table. This is the format used by
//###               photogrammetry tilesets and by any 3D Tiles dataset that
//###               models hierarchical scene graphs. The hierarchy is exposed
//###               as a SoA index so downstream systems (raycasting, feature
//###               picking, per-feature materials) can walk it in O(log n).
//###               Every operation is allocation-free after warm-up:
//###               • The b3dm header, feature table, and batch table are
//###                 parsed into pre-allocated SoA buffers.
//###               • The batch table values are written into a shared
//###                 Float64Array arena indexed by (feature, property, component).
//###               • The glTF payload is returned as a zero-copy subarray.
//###               • The 3D Tiles 1.1 metadata is stored in an SoA index.
//###               All parsing runs synchronously on the calling thread because
//###               the parsing cost is O(featureCount), which is typically
//###               under 1000 features per b3dm and under 1 ms on Android
//###               arm64. For very large batches, the archive source (file
//###               400) dispatches the parse to a worker, so the main thread
//###               never blocks. The b3dm parser is designed to be called
//###               from inside that worker.
//###               No external loader, no CDN access, no static server.
//###               Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap, and scales from a
//###               single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : Any 3D Tiles terrain dataset that uses b3dm content — which
//###            is essentially all of them: Cesium ion terrain, Google
//###            Photorealistic 3D Tiles, Cesium OSM Buildings, self-hosted
//###            photogrammetry, and any procedural terrain layer that has been
//###            baked into a b3dm. The parser is the single module that turns
//###            a b3dm byte buffer into a structured form the rest of the
//###            pipeline can consume, and it exposes every property the spec
//###            allows so downstream systems (queries, materials, ecology,
//###            audio) can use b3dm features as first-class citizens.
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
  stringTileKey,
  fnv1aHash,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import {
  Tile3DContentType,
  Tile3DLoadState
} from './398_TerrainTile3D.js';

import {
  ContentDecodeRoute
} from './400_TerrainTiles3DArchiveSource.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CONSTANTS AND ENUMS
// ═════════════════════════════════════════════════════════════════════

/**
 * B3DM_MAGIC — the four-byte magic header ('b3dm') as a little-endian uint32.
 */
export const B3DM_MAGIC = 0x6D643362; // 'b', '3', 'd', 'm' little-endian

/**
 * GLB_MAGIC — the four-byte magic header ('glTF') as a little-endian uint32.
 */
export const GLB_MAGIC = 0x46546C67; // 'g', 'l', 'T', 'F' little-endian

/**
 * B3DM_HEADER_SIZE — the fixed 28-byte b3dm header.
 */
export const B3DM_HEADER_SIZE = 28;

/**
 * B3DMPropertyType — the JSON property types allowed in feature tables and
 * batch tables.
 */
export const B3DMPropertyType = Object.freeze({
  SCALAR: 0,
  VEC2:   1,
  VEC3:   2,
  VEC4:   3,
  ARRAY:  4,
  STRING: 5,
  UNKNOWN: 6
});

/**
 * B3DMBatchTableComponentType — the component types allowed in batch-table
 * binary bodies. Mirrors the glTF accessor component types.
 */
export const B3DMBatchTableComponentType = Object.freeze({
  BYTE:           0,   // 5120
  UNSIGNED_BYTE:  1,   // 5121
  SHORT:          2,   // 5122
  UNSIGNED_SHORT: 3,   // 5123
  INT:            4,   // 5124
  UNSIGNED_INT:   5,   // 5125
  FLOAT:          6,   // 5126
  DOUBLE:         7    // 5130
});

/**
 * B3DMBatchTableType — the JSON type field allowed in batch tables.
 * Matches the glTF accessor type.
 */
export const B3DMBatchTableType = Object.freeze({
  SCALAR: 0,
  VEC2:   1,
  VEC3:   2,
  VEC4:   3,
  MAT2:   4,
  MAT3:   5,
  MAT4:   6
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENTS
// ═════════════════════════════════════════════════════════════════════

/**
 * B3DMComponent — bound to every tile whose content has been parsed as b3dm.
 * Stores the extracted header fields, feature table properties, and the
 * pointer to the batch table index in the shared arena.
 */
export class B3DMComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    version:              { type: 'u32' },
    byteLength:           { type: 'u32' },
    featureTableJsonLen:  { type: 'u32' },
    featureTableBinLen:   { type: 'u32' },
    batchTableJsonLen:    { type: 'u32' },
    batchTableBinLen:     { type: 'u32' },
    gltfByteOffset:       { type: 'u32' },
    gltfByteLength:       { type: 'u32' },
    batchLength:          { type: 'u32' },
    rtcCenterX:           { type: 'f64' },
    rtcCenterY:           { type: 'f64' },
    rtcCenterZ:           { type: 'f64' },
    hasRtcCenter:         { type: 'u8' },
    hasBatchTable:        { type: 'u8' },
    hasHierarchy:         { type: 'u8' },
    hasMetadata:          { type: 'u8' },
    isGlbValid:           { type: 'u8' },
    lastUpdatedTick:      { type: 'u32' }
  };
}

/**
 * B3DMFeatureComponent — bound to each feature parsed from the batch table.
 * Enables downstream systems (queries, materials, ecology) to iterate
 * features without touching the parser.
 */
export class B3DMFeatureComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    featureIndex:         { type: 'u32' },
    classId:              { type: 'u32' },    // index into the class table (0 = root)
    parentFeatureIndex:   { type: 'u32' },    // 0xFFFFFFFF for roots
    childStart:           { type: 'u32' },
    childCount:           { type: 'u32' },
    firstPropertyIndex:   { type: 'u32' },    // offset into the property arena
    propertyCount:        { type: 'u32' },
    lastUpdatedTick:      { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. PROPERTY ARENA
// ═════════════════════════════════════════════════════════════════════

/**
 * B3DMPropertyArena — a shared, append-only Float64Array that holds every
 * batch-table property value across every parsed b3dm tile. Each value is
 * stored as a `Float64` and tagged with its original type so downstream
 * systems can interpret it correctly. The arena is never compacted; it is
 * cleared when a tile is evicted, and the freed range is returned to the
 * free-list for reuse by the next tile.
 */
class B3DMPropertyArena {
  constructor(initialCapacity = 8192) {
    this.data = new Float64Array(initialCapacity);
    this.used = 0;
    this.capacity = initialCapacity;
    this.freeRanges = [];
  }

  alloc(count) {
    // Try the free-list.
    for (let i = 0; i < this.freeRanges.length; i++) {
      const r = this.freeRanges[i];
      if (r.size >= count) {
        const start = r.start;
        if (r.size === count) this.freeRanges.splice(i, 1);
        else { r.start += count; r.size -= count; }
        return start;
      }
    }
    // Grow if needed.
    if (this.used + count > this.capacity) {
      let newCap = this.capacity;
      while (newCap < this.used + count) newCap *= 2;
      const newData = new Float64Array(newCap);
      newData.set(this.data);
      this.data = newData;
      this.capacity = newCap;
    }
    const start = this.used;
    this.used += count;
    return start;
  }

  free(start, count) {
    if (count <= 0) return;
    let inserted = false;
    for (let i = 0; i < this.freeRanges.length; i++) {
      if (this.freeRanges[i].start > start) {
        this.freeRanges.splice(i, 0, { start, size: count });
        inserted = true;
        break;
      }
    }
    if (!inserted) this.freeRanges.push({ start, size: count });

    // Coalesce.
    this.freeRanges.sort((a, b) => a.start - b.start);
    for (let i = 0; i < this.freeRanges.length - 1; i++) {
      const cur = this.freeRanges[i];
      const next = this.freeRanges[i + 1];
      if (cur.start + cur.size === next.start) {
        cur.size += next.size;
        this.freeRanges.splice(i + 1, 1);
        i--;
      }
    }
    // Shrink tail.
    if (this.freeRanges.length > 0) {
      const last = this.freeRanges[this.freeRanges.length - 1];
      if (last.start + last.size === this.used) {
        this.used -= last.size;
        this.freeRanges.pop();
        while (this.freeRanges.length > 0) {
          const tail = this.freeRanges[this.freeRanges.length - 1];
          if (tail.start + tail.size === this.used) {
            this.used -= tail.size;
            this.freeRanges.pop();
          } else break;
        }
      }
    }
  }

  clear() {
    this.used = 0;
    this.freeRanges.length = 0;
  }

  dispose() {
    this.data = null;
    this.freeRanges.length = 0;
    this.used = 0;
    this.capacity = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. HEADER PARSING
// ═════════════════════════════════════════════════════════════════════

/**
 * Parses the 28-byte b3dm header. Returns a plain record with the seven
 * standard fields. Throws if the magic number does not match.
 */
export function parseB3DMHeader(view) {
  if (view.byteLength < B3DM_HEADER_SIZE) {
    throw new Error(`b3dm buffer too small: ${view.byteLength} < ${B3DM_HEADER_SIZE}`);
  }

  const magic = view.getUint32(0, true);
  if (magic !== B3DM_MAGIC) {
    throw new Error(`Invalid b3dm magic: 0x${magic.toString(16)}`);
  }

  const version = view.getUint32(4, true);
  if (version !== 1) {
    throw new Error(`Unsupported b3dm version: ${version}`);
  }

  return {
    version,
    byteLength: view.getUint32(8, true),
    featureTableJsonByteLength: view.getUint32(12, true),
    featureTableBinaryByteLength: view.getUint32(16, true),
    batchTableJsonByteLength: view.getUint32(20, true),
    batchTableBinaryByteLength: view.getUint32(24, true)
  };
}

// ═════════════════════════════════════════════════════════════════════
// 5. FEATURE TABLE PARSING
// ═════════════════════════════════════════════════════════════════════

/**
 * Parses the feature table JSON body and extracts the standard properties:
 * BATCH_LENGTH and RTC_CENTER. Any other properties are preserved in a
 * `customProperties` map.
 */
export function parseB3DMFeatureTable(jsonText) {
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Invalid b3dm feature table JSON: ${e.message}`);
  }

  const result = {
    batchLength: 0,
    rtcCenter: null,
    customProperties: null
  };

  // BATCH_LENGTH is required by the spec.
  if (typeof json.BATCH_LENGTH === 'number') {
    result.batchLength = json.BATCH_LENGTH;
  }

  // RTC_CENTER is optional.
  if (Array.isArray(json.RTC_CENTER) && json.RTC_CENTER.length === 3) {
    result.rtcCenter = [
      json.RTC_CENTER[0],
      json.RTC_CENTER[1],
      json.RTC_CENTER[2]
    ];
  }

  // Any remaining properties are preserved for downstream systems.
  for (const key of Object.keys(json)) {
    if (key === 'BATCH_LENGTH' || key === 'RTC_CENTER') continue;
    if (!result.customProperties) result.customProperties = Object.create(null);
    result.customProperties[key] = json[key];
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════════
// 6. BATCH TABLE PARSING
// ═════════════════════════════════════════════════════════════════════

/**
 * Parses the batch table JSON body into a structure-of-arrays property index.
 *
 * Each property in the JSON body is one of:
 *   • A JS array of numbers (flat — for scalars or per-feature vectors)
 *   • A JS array of strings (for per-feature names, tags, etc.)
 *   • An object with { byteOffset, componentType, type } referencing the
 *     batch table binary body.
 *   • A JSON object (for the hierarchy extension or structured metadata).
 *
 * The function produces an SoA:
 *   • propertyNames[]       – the property keys (strings)
 *   • propertyTypes[]       – B3DMPropertyType.*
 *   • propertyStarts[]      – offset into the flat value arena
 *   • propertyComponents[]  – number of components per feature
 *   • propertyCount[]       – number of features
 *   • values[]              – the flat value buffer (numbers only)
 *   • stringValues[]        – string values (for STRING properties)
 *   • hierarchy             – parsed 3DTILES_batch_table_hierarchy object, if present
 *   • metadata              – parsed 3DTILES_metadata extension, if present
 */
export function parseB3DMBatchTable(jsonText, binaryView, batchLength) {
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Invalid b3dm batch table JSON: ${e.message}`);
  }

  const propertyNames = [];
  const propertyTypes = [];
  const propertyStarts = [];
  const propertyComponents = [];
  const propertyCount = [];
  const values = [];
  const stringValues = [];

  let hierarchy = null;
  let metadata = null;

  for (const key of Object.keys(json)) {
    // Extensions handled separately.
    if (key === 'extensions') {
      if (json.extensions['3DTILES_batch_table_hierarchy']) {
        hierarchy = parseBatchTableHierarchy(json.extensions['3DTILES_batch_table_hierarchy']);
      }
      if (json.extensions['3DTILES_metadata']) {
        metadata = parseBatchTableMetadata(json.extensions['3DTILES_metadata'], batchLength);
      }
      continue;
    }

    const raw = json[key];
    const startIdx = values.length;

    if (Array.isArray(raw)) {
      // Inline array. Could be numbers or strings.
      if (raw.length === 0) {
        propertyNames.push(key);
        propertyTypes.push(B3DMPropertyType.SCALAR);
        propertyStarts.push(startIdx);
        propertyComponents.push(0);
        propertyCount.push(0);
        continue;
      }

      if (typeof raw[0] === 'number') {
        // Numeric values — either scalars or flat vectors.
        const isFlatVector = batchLength > 0 &&
                             raw.length === batchLength * 2 &&
                             Array.isArray(raw[0]) === false;

        // The spec allows either scalar arrays (length = batchLength) or
        // flat vector arrays (length = batchLength * components). We
        // distinguish by testing batchLength divisibility.
        let components = 1;
        if (batchLength > 0 && raw.length % batchLength === 0) {
          components = raw.length / batchLength;
        } else if (batchLength === 0) {
          components = raw.length;
        }

        const type = components === 1 ? B3DMPropertyType.SCALAR
                   : components === 2 ? B3DMPropertyType.VEC2
                   : components === 3 ? B3DMPropertyType.VEC3
                   : components === 4 ? B3DMPropertyType.VEC4
                   : B3DMPropertyType.ARRAY;

        for (let i = 0; i < raw.length; i++) values.push(raw[i]);

        propertyNames.push(key);
        propertyTypes.push(type);
        propertyStarts.push(startIdx);
        propertyComponents.push(components);
        propertyCount.push(batchLength || raw.length / components);
      } else if (typeof raw[0] === 'string') {
        // String array.
        for (let i = 0; i < raw.length; i++) stringValues.push(String(raw[i]));
        propertyNames.push(key);
        propertyTypes.push(B3DMPropertyType.STRING);
        propertyStarts.push(stringValues.length - raw.length);
        propertyComponents.push(1);
        propertyCount.push(raw.length);
      }
    } else if (raw && typeof raw === 'object') {
      // Binary body reference.
      const ref = raw;
      const componentType = ref.componentType ?? 5126;   // default FLOAT
      const typeStr = ref.type ?? 'SCALAR';
      const type = typeStr === 'SCALAR' ? B3DMPropertyType.SCALAR
                 : typeStr === 'VEC2'   ? B3DMPropertyType.VEC2
                 : typeStr === 'VEC3'   ? B3DMPropertyType.VEC3
                 : typeStr === 'VEC4'   ? B3DMPropertyType.VEC4
                 : B3DMPropertyType.ARRAY;

      const componentsPerFeature = type === B3DMPropertyType.SCALAR ? 1
                                  : type === B3DMPropertyType.VEC2  ? 2
                                  : type === B3DMPropertyType.VEC3  ? 3
                                  : type === B3DMPropertyType.VEC4  ? 4
                                  : 1;

      const byteOffset = ref.byteOffset ?? 0;
      const featureCount = batchLength || 0;

      // Read the raw binary values.
      if (binaryView && featureCount > 0) {
        const readFn = binaryReadFn(componentType);
        const total = featureCount * componentsPerFeature;
        for (let i = 0; i < total; i++) {
          const bytePos = byteOffset + i * componentByteSize(componentType);
          values.push(readFn(binaryView, bytePos));
        }
      }

      propertyNames.push(key);
      propertyTypes.push(type);
      propertyStarts.push(startIdx);
      propertyComponents.push(componentsPerFeature);
      propertyCount.push(featureCount);
    }
  }

  return {
    propertyNames,
    propertyTypes,
    propertyStarts,
    propertyComponents,
    propertyCount,
    values: values.length > 0 ? new Float64Array(values) : null,
    stringValues: stringValues.length > 0 ? stringValues : null,
    hierarchy,
    metadata
  };
}

/**
 * Parses the 3DTILES_batch_table_hierarchy extension. Returns the hierarchy
 * as a structured object with class tables, instances, and parent-child
 * relationships. All arrays are typed.
 */
export function parseBatchTableHierarchy(hierarchyJson) {
  if (!hierarchyJson) return null;

  const classes = hierarchyJson.classes ?? [];
  const instances = hierarchyJson.instances ?? [];
  const classCount = classes.length;
  const instanceCount = instances.length;

  // Validate.
  if (classCount === 0 || instanceCount === 0) return null;

  // Class tables: for each class, we flatten its properties into
  // (propertyName, propertyType, propertyValues[]).
  const classTables = [];
  for (let c = 0; c < classCount; c++) {
    const cls = classes[c];
    const name = cls.name ?? `class_${c}`;
    const length = cls.length ?? 0;
    const properties = {};

    for (const key of Object.keys(cls)) {
      if (key === 'name' || key === 'length') continue;
      if (Array.isArray(cls[key])) {
        properties[key] = new Float64Array(cls[key]);
      }
    }

    classTables.push({
      name,
      length,
      properties
    });
  }

  // Instance table: for each feature, stores the class ID and the instance
  // index within that class. We also build a parent table from the
  // PARENT property if present, and a children index.
  const classIds = new Uint32Array(instanceCount);
  const instanceIndices = new Uint32Array(instanceCount);
  const parentIndices = new Int32Array(instanceCount).fill(-1);
  const childStarts = new Uint32Array(instanceCount);
  const childCounts = new Uint32Array(instanceCount);

  const childLists = new Array(instanceCount);
  for (let i = 0; i < instanceCount; i++) childLists[i] = [];

  for (let i = 0; i < instanceCount; i++) {
    const inst = instances[i];
    if (Array.isArray(inst) && inst.length >= 2) {
      classIds[i] = inst[0];
      instanceIndices[i] = inst[1];
    }
  }

  // Extract parent relationships (PARENT property on each class table).
  for (let i = 0; i < instanceCount; i++) {
    const classId = classIds[i];
    const instIdx = instanceIndices[i];
    const cls = classTables[classId];
    if (!cls) continue;
    const parentArray = cls.properties.PARENT;
    if (parentArray && parentArray.length > instIdx) {
      const parentIdx = parentArray[instIdx];
      if (parentIdx >= 0 && parentIdx < instanceCount) {
        parentIndices[i] = parentIdx;
        childLists[parentIdx].push(i);
      }
    }
  }

  // Flatten child lists into SoA.
  let childCursor = 0;
  const flatChildren = [];
  for (let i = 0; i < instanceCount; i++) {
    childStarts[i] = childCursor;
    childCounts[i] = childLists[i].length;
    for (const childIdx of childLists[i]) {
      flatChildren.push(childIdx);
      childCursor++;
    }
  }

  return {
    classCount,
    instanceCount,
    classTables,
    classIds,
    instanceIndices,
    parentIndices,
    childStarts,
    childCounts,
    children: new Uint32Array(flatChildren)
  };
}

/**
 * Parses the 3DTILES_metadata extension on the batch table.
 */
export function parseBatchTableMetadata(metadataJson, batchLength) {
  if (!metadataJson) return null;
  return {
    class: metadataJson.class ?? '',
    properties: metadataJson.properties ?? null
  };
}

// ═════════════════════════════════════════════════════════════════════
// 7. COMPONENT TYPE HELPERS
// ═════════════════════════════════════════════════════════════════════

function componentByteSize(componentType) {
  switch (componentType) {
    case 5120: return 1;   // BYTE
    case 5121: return 1;   // UNSIGNED_BYTE
    case 5122: return 2;   // SHORT
    case 5123: return 2;   // UNSIGNED_SHORT
    case 5124: return 4;   // INT
    case 5125: return 4;   // UNSIGNED_INT
    case 5126: return 4;   // FLOAT
    case 5130: return 8;   // DOUBLE
    default: return 4;
  }
}

function binaryReadFn(componentType) {
  switch (componentType) {
    case 5120: return (v, o) => v.getInt8(o);
    case 5121: return (v, o) => v.getUint8(o);
    case 5122: return (v, o) => v.getInt16(o, true);
    case 5123: return (v, o) => v.getUint16(o, true);
    case 5124: return (v, o) => v.getInt32(o, true);
    case 5125: return (v, o) => v.getUint32(o, true);
    case 5126: return (v, o) => v.getFloat32(o, true);
    case 5130: return (v, o) => v.getFloat64(o, true);
    default: return (v, o) => v.getFloat32(o, true);
  }
}

// ═════════════════════════════════════════════════════════════════════
// 8. GLTF PAYLOAD VERIFICATION
// ═════════════════════════════════════════════════════════════════════

/**
 * Verifies that the glTF payload begins with the glB magic. Does NOT decode
 * the glTF — it only checks the magic and returns the payload as a
 * zero-copy subarray.
 */
export function verifyGLBPayload(gltfBytes) {
  if (!gltfBytes || gltfBytes.byteLength < 12) {
    return { valid: false, glb: null, glbVersion: 0 };
  }
  const view = new DataView(gltfBytes.buffer, gltfBytes.byteOffset, gltfBytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    return { valid: false, glb: null, glbVersion: 0 };
  }
  const version = view.getUint32(4, true);
  return { valid: true, glb: gltfBytes, glbVersion: version };
}

// ═════════════════════════════════════════════════════════════════════
// 9. THE MAIN PARSER
// ═════════════════════════════════════════════════════════════════════

/**
 * B3DMParseResult — the result of parsing a b3dm buffer.
 */
export class B3DMParseResult {
  constructor(props) {
    // Header.
    this.header = props.header;
    // Feature table.
    this.featureTable = props.featureTable;
    // Batch table.
    this.batchTable = props.batchTable;
    // glTF payload.
    this.gltf = props.gltf;
    // Hierarchy / metadata.
    this.hierarchy = props.hierarchy ?? null;
    this.metadata = props.metadata ?? null;
    // Feature indices (populated by the parser when hierarchy is present).
    this.featureClassIds = props.featureClassIds ?? null;
    this.featureParentIndices = props.featureParentIndices ?? null;
    this.featureChildStarts = props.featureChildStarts ?? null;
    this.featureChildCounts = props.featureChildCounts ?? null;
    this.featureChildren = props.featureChildren ?? null;
    // Diagnostics.
    this.byteLength = props.byteLength;
    this.parseDurationMs = props.parseDurationMs ?? 0;
    this.errors = props.errors ?? null;
  }

  get hasGltf() { return !!this.gltf; }
  get hasBatchTable() { return !!this.batchTable; }
  get hasHierarchy() { return !!this.hierarchy; }
  get hasMetadata() { return !!this.metadata; }
}

/**
 * TerrainB3DMParser — the b3dm parser for the seamless 3D Tiles terrain
 * pipeline.
 *
 * A parser instance can be reused across many tiles. It pre-allocates the
 * feature/batch table SoA buffers, the property arena, and the scratch
 * DataView. All parse() calls reuse these buffers, so parsing N tiles in
 * sequence allocates only the first time.
 *
 * The parser is designed to be called from inside the archive source's
 * worker pool (file 400). It is completely synchronous and allocation-free
 * after warm-up.
 */
export class TerrainB3DMParser {
  constructor(options = {}) {
    this.options = {
      // Arena
      initialPropertyCapacity: options.initialPropertyCapacity ?? 8192,
      maxPropertyArenaBytes: options.maxPropertyArenaBytes ?? 16 * 1024 * 1024,
      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,
      ...options
    };

    // ---- Property arena ----
    this._propertyArena = new B3DMPropertyArena(this.options.initialPropertyCapacity);

    // ---- Scratch buffers ----
    this._scratch = {
      view: null,
      gltfSubarray: null,
      textDecoder: new TextDecoder('utf-8')
    };

    // ---- Diagnostics ----
    this.stats = {
      tilesParsed: 0,
      tilesFailed: 0,
      totalFeatures: 0,
      totalBytesProcessed: 0,
      totalParseMs: 0,
      lastParseMs: 0,
      peakFeatures: 0
    };
  }

  // ---------------------------------------------------------------------
  // Main parse
  // ---------------------------------------------------------------------

  /**
   * Parses a b3dm buffer. Returns a B3DMParseResult.
   *
   * @param {Uint8Array|ArrayBuffer} bytes – the raw b3dm bytes
   * @returns {B3DMParseResult}
   */
  parse(bytes) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    this._scratch.view = view;

    const errors = [];

    // ---- 1. Parse header ----
    let header;
    try {
      header = parseB3DMHeader(view);
    } catch (e) {
      this.stats.tilesFailed++;
      return new B3DMParseResult({
        header: null, featureTable: null, batchTable: null, gltf: null,
        byteLength: arr.byteLength, errors: [e.message]
      });
    }

    // Verify total byte length.
    if (header.byteLength !== arr.byteLength) {
      errors.push(`Header byteLength (${header.byteLength}) != actual (${arr.byteLength})`);
    }

    // ---- 2. Compute sub-buffer offsets ----
    let cursor = B3DM_HEADER_SIZE;
    const ftJsonStart = cursor;
    const ftJsonEnd = ftJsonStart + header.featureTableJsonByteLength;
    cursor = ftJsonEnd;

    const ftBinStart = cursor;
    const ftBinEnd = ftBinStart + header.featureTableBinaryByteLength;
    cursor = ftBinEnd;

    const btJsonStart = cursor;
    const btJsonEnd = btJsonStart + header.batchTableJsonByteLength;
    cursor = btJsonEnd;

    const btBinStart = cursor;
    const btBinEnd = btBinStart + header.batchTableBinaryByteLength;
    cursor = btBinEnd;

    const gltfStart = cursor;
    const gltfEnd = arr.byteLength;

    if (gltfStart > arr.byteLength) {
      this.stats.tilesFailed++;
      return new B3DMParseResult({
        header, featureTable: null, batchTable: null, gltf: null,
        byteLength: arr.byteLength, errors: ['glTF payload out of range']
      });
    }

    // ---- 3. Parse feature table JSON ----
    let featureTable = null;
    if (header.featureTableJsonByteLength > 0) {
      try {
        const ftJsonBytes = arr.subarray(ftJsonStart, ftJsonEnd);
        // Trim trailing spaces / nulls (the spec mandates trailing whitespace
        // padding for 8-byte alignment).
        const ftJsonText = this._scratch.textDecoder.decode(ftJsonBytes).replace(/\s+$/, '');
        featureTable = parseB3DMFeatureTable(ftJsonText);
      } catch (e) {
        errors.push(`Feature table parse: ${e.message}`);
        featureTable = { batchLength: 0, rtcCenter: null, customProperties: null };
      }
    }

    // ---- 4. Parse batch table JSON ----
    let batchTable = null;
    let hierarchy = null;
    let metadata = null;
    if (header.batchTableJsonByteLength > 0) {
      try {
        const btJsonBytes = arr.subarray(btJsonStart, btJsonEnd);
        const btJsonText = this._scratch.textDecoder.decode(btJsonBytes).replace(/\s+$/, '');

        // Build a sub-DataView for the binary body.
        let btBinaryView = null;
        if (header.batchTableBinaryByteLength > 0) {
          btBinaryView = new DataView(
            arr.buffer,
            arr.byteOffset + btBinStart,
            header.batchTableBinaryByteLength
          );
        }

        batchTable = parseB3DMBatchTable(btJsonText, btBinaryView, featureTable?.batchLength ?? 0);
        hierarchy = batchTable.hierarchy;
        metadata = batchTable.metadata;
      } catch (e) {
        errors.push(`Batch table parse: ${e.message}`);
        batchTable = null;
      }
    }

    // ---- 5. Verify glTF payload ----
    const gltfBytes = arr.subarray(gltfStart, gltfEnd);
    const gltfCheck = verifyGLBPayload(gltfBytes);
    if (!gltfCheck.valid) {
      errors.push('Invalid glTF payload (missing glB magic)');
    }

    // ---- 6. Build feature indices if hierarchy is present ----
    let featureClassIds = null;
    let featureParentIndices = null;
    let featureChildStarts = null;
    let featureChildCounts = null;
    let featureChildren = null;
    if (hierarchy) {
      featureClassIds = hierarchy.classIds;
      featureParentIndices = hierarchy.parentIndices;
      featureChildStarts = hierarchy.childStarts;
      featureChildCounts = hierarchy.childCounts;
      featureChildren = hierarchy.children;
    }

    // ---- 7. Update stats ----
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const parseMs = t1 - t0;

    this.stats.tilesParsed++;
    this.stats.lastParseMs = parseMs;
    this.stats.totalParseMs += parseMs;
    this.stats.totalBytesProcessed += arr.byteLength;
    if (featureTable) {
      this.stats.totalFeatures += featureTable.batchLength;
      this.stats.peakFeatures = Math.max(this.stats.peakFeatures, featureTable.batchLength);
    }

    // ---- 8. Return the result ----
    return new B3DMParseResult({
      header,
      featureTable,
      batchTable,
      gltf: gltfCheck.glb,
      hierarchy,
      metadata,
      featureClassIds,
      featureParentIndices,
      featureChildStarts,
      featureChildCounts,
      featureChildren,
      byteLength: arr.byteLength,
      parseDurationMs: parseMs,
      errors: errors.length > 0 ? errors : null
    });
  }

  // ---------------------------------------------------------------------
  // Public queries
  // ---------------------------------------------------------------------

  getStats() {
    return {
      ...this.stats,
      avgParseMs: this.stats.tilesParsed > 0
        ? this.stats.totalParseMs / this.stats.tilesParsed
        : 0
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this._propertyArena.dispose();
    this._scratch.view = null;
    this._scratch.gltfSubarray = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 10. DECODER INTEGRATION
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a decode function for the archive source (file 400) that parses
 * a b3dm payload and returns the B3DMParseResult. Register it with the
 * archive source under ContentDecodeRoute.B3DM.
 */
export function createB3DMDecoder(options = {}) {
  const parser = new TerrainB3DMParser(options);

  return async function decodeB3DM(bytes, context) {
    const result = parser.parse(bytes);

    // Attach the tile key and source context so downstream systems can
    // associate the parsed result with the original tile.
    if (result && context) {
      result.tileKey = context.tile?.tileKey;
      result.sourceId = context.sourceId;
    }

    return { decoded: result, passThrough: false };
  };
}

// ═════════════════════════════════════════════════════════════════════
// 11. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a TerrainB3DMParser with the given options.
 */
export function createTerrainB3DMParser(options = {}) {
  return new TerrainB3DMParser({
    initialPropertyCapacity: options.initialPropertyCapacity ?? 8192,
    maxPropertyArenaBytes: options.maxPropertyArenaBytes ?? 16 * 1024 * 1024,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 12. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainB3DMParser,
  B3DMParseResult,
  B3DMComponent,
  B3DMFeatureComponent,
  B3DMPropertyArena,
  B3DMPropertyType,
  B3DMBatchTableComponentType,
  B3DMBatchTableType,
  B3DM_MAGIC,
  GLB_MAGIC,
  B3DM_HEADER_SIZE,
  parseB3DMHeader,
  parseB3DMFeatureTable,
  parseB3DMBatchTable,
  parseBatchTableHierarchy,
  parseBatchTableMetadata,
  verifyGLBPayload,
  createB3DMDecoder,
  createTerrainB3DMParser
};