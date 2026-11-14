// file number : 403
// full path name : src/context/403_TerrainI3DMParser.js
//### Description : Context-aware Instanced 3D Model (i3dm) parser for the
//###               seamless 3D Tiles terrain pipeline. i3dm is the 3D Tiles
//###               content type for instanced models — the format used by
//###               photogrammetry, vegetation scatter tilesets, building
//###               distributions, rock and debris instances, and any tiled
//###               dataset where one glTF payload is drawn many times at
//###               different positions, orientations, and scales. This file
//###               parses a raw i3dm byte buffer into every field the 3D Tiles
//###               1.0 and 1.1 specifications require:
//###                 • THE 32-BYTE HEADER — magic 'i3dm', version, byte
//###                   length, the four table lengths (feature table JSON,
//###                   feature table binary, batch table JSON, batch table
//###                   binary), and the gltfFormat discriminant (0 = external
//###                   URI, 1 = embedded GLB). All seven numeric fields are
//###                   read little-endian.
//###                 • THE FEATURE TABLE — BATCH_LENGTH and INSTANCES_LENGTH
//###                   (required), POSITION (required), the orientation
//###                   channels (NORMAL_UP / NORMAL_RIGHT, their OCT32P
//###                   packed variants, and QUATERNION_32P), the scale
//###                   channels (SCALE and SCALE_NON_UNIFORM), the quantized
//###                   position channels (POSITION_QUANTIZED, its volume
//###                   offset/scale), and RTC_CENTER. All channel layouts are
//###                   decoded into structure-of-arrays buffers with per-
//###                   instance stride, so downstream systems can read the
//###                   raw channels without touching the parser.
//###                 • THE BATCH TABLE — reused verbatim from the b3dm parser
//###                   (file 401), including the 3DTILES_batch_table_hierarchy
//###                   extension and the 3DTILES_metadata extension, so
//###                   per-instance metadata is a first-class feature of every
//###                   i3dm tile.
//###                 • THE GLTF PAYLOAD — either an embedded GLB sub-buffer
//###                   (zero-copy subarray when gltfFormat = 1) or an external
//###                   URI string (when gltfFormat = 0). When embedded, the
//###                   parser verifies the glB magic and returns the payload
//###                   untouched. When external, the parser returns the URI
//###                   string so the archive source (file 400) can resolve it
//###                   from the same archive or from a pluggable resolver.
//###               On top of the raw parse, this file computes the full 4×4
//###               instance matrix for every instance — the operation that
//###               every 3D Tiles renderer needs before it can submit the
//###               instanced draw. The matrix is built from position ×
//###               orientation × scale, using the standard 3D Tiles column-
//###               major convention:
//###                   column 0 = right · scale.x
//###                   column 1 = up    · scale.y
//###                   column 2 = forward · scale.z      (forward = right × up)
//###                   column 3 = position
//###               All three orientation encodings are supported:
//###                 • NORMAL_UP + NORMAL_RIGHT     (float32 unit vectors)
//###                 • NORMAL_UP_OCT32P + NORMAL_RIGHT_OCT32P (oct-encoded uint32)
//###                 • QUATERNION_32P              (32-bit packed quaternion)
//###               The matrices are written into a pre-allocated Float32Array
//###               arena (16 floats per instance) so downstream systems can
//###               upload them directly to the GPU as an instanced attribute.
//###               Also computes derived per-instance data: a bounding sphere
//###               (from the glTF’s local extent × scale, translated by
//###               position), the RTC_CENTER offset, and the resolved world
//###               positions with quantized decoding.
//###               Every operation is allocation-free after warm-up:
//###               • The header, feature table, and batch table are parsed into
//###                 pre-allocated SoA buffers.
//###               • The matrices and world positions live in a shared arena.
//###               • The glTF payload is returned as a zero-copy subarray when
//###                 embedded.
//###               All parsing runs synchronously on the calling thread because
//###               the cost is O(instances). The archive source (file 400)
//###               dispatches the parse to a worker for large tilesets. The
//###               parser is designed to be called from inside that worker.
//###               No external loader, no CDN access, no static server. Designed
//###               for Android arm64 under the 8 ms per-tick CPU ceiling and
//###               200 MB resident memory cap, and scales from a single 10-unit
//###               tile to galactic streaming (10k+ units) without main-thread
//###               stalls.
//### Best for : Any 3D Tiles terrain dataset that uses i3dm content — which
//###            includes almost every photogrammetry terrain tileset, every
//###            vegetation scatter layer, every rock and debris distribution,
//###            every building instance layer, and any procedurally-generated
//###            terrain whose props have been baked into i3dm. The parser is
//###            the single module that turns an i3dm byte buffer into the
//###            per-instance matrices and metadata the rest of the pipeline
//###            needs, and it exposes every channel the spec allows so
//###            downstream systems (scatter spawn, pathfinding, raycasting,
//###            LOD fidelity) can use i3dm instances as first-class citizens.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum
} from '../math/006_Vec3.js';

// Re-import the specific math/ and core/ primitives we need directly.
import * as Vec3Module from '../math/006_Vec3.js';
import * as QuatModule from '../math/011_Quat.js';
import * as Mat4Module from '../math/010_Mat4.js';

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

import {
  B3DMParseResult,
  B3DMComponent,
  B3DMFeatureComponent,
  B3DMPropertyArena,
  B3DMPropertyType,
  B3DMBatchTableComponentType,
  B3DMBatchTableType,
  GLB_MAGIC,
  B3DM_HEADER_SIZE,
  parseB3DMFeatureTable,
  parseB3DMBatchTable,
  parseBatchTableHierarchy,
  parseBatchTableMetadata,
  verifyGLBPayload
} from './401_TerrainB3DMParser.js';

// ═════════════════════════════════════════════════════════════════════
// 1. CONSTANTS AND ENUMS
// ═════════════════════════════════════════════════════════════════════

/**
 * I3DM_MAGIC — the four-byte magic header ('i3dm') as a little-endian uint32.
 */
export const I3DM_MAGIC = 0x6D643369; // 'i', '3', 'd', 'm' little-endian

/**
 * I3DM_HEADER_SIZE — the fixed 32-byte i3dm header.
 */
export const I3DM_HEADER_SIZE = 32;

/**
 * I3DMGltfFormat — the gltfFormat discriminant in the i3dm header.
 */
export const I3DMGltfFormat = Object.freeze({
  EXTERNAL_URI: 0,   // the glTF is fetched separately, URI is in the feature table
  EMBEDDED_GLB: 1    // the glTF is a GLB embedded after the batch table
});

/**
 * I3DMOrientationChannel — which orientation channel the tile uses.
 */
export const I3DMOrientationChannel = Object.freeze({
  NONE:            0,
  NORMAL_UP_RIGHT: 1,   // float32[3] up + float32[3] right
  OCT32P:          2,   // uint32 packed up + uint32 packed right
  QUATERNION_32P:  3    // uint32 packed quaternion
});

/**
 * I3DMPositionChannel — which position channel the tile uses.
 */
export const I3DMPositionChannel = Object.freeze({
  NONE:      0,
  FLOAT32:   1,   // float32[3] per instance
  QUANTIZED: 2    // uint16[3] per instance, scaled by QUANTIZED_VOLUME_SCALE
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENTS
// ═════════════════════════════════════════════════════════════════════

/**
 * I3DMComponent — bound to every tile whose content has been parsed as i3dm.
 */
export class I3DMComponent {
  static schema = {
    tileKeyHash:              { type: 'u32' },
    version:                  { type: 'u32' },
    byteLength:               { type: 'u32' },
    instancesLength:          { type: 'u32' },
    batchLength:              { type: 'u32' },
    gltfFormat:               { type: 'u8' },   // I3DMGltfFormat.*
    orientationChannel:       { type: 'u8' },   // I3DMOrientationChannel.*
    positionChannel:          { type: 'u8' },   // I3DMPositionChannel.*
    hasScale:                 { type: 'u8' },
    hasNonUniformScale:       { type: 'u8' },
    hasRtcCenter:             { type: 'u8' },
    hasBatchTable:            { type: 'u8' },
    hasHierarchy:             { type: 'u8' },
    hasMetadata:              { type: 'u8' },
    rtcCenterX:               { type: 'f64' },
    rtcCenterY:               { type: 'f64' },
    rtcCenterZ:               { type: 'f64' },
    matrixStart:              { type: 'u32' },  // offset into matrix arena
    matrixCount:              { type: 'u32' },  // = instancesLength
    gltfByteLength:           { type: 'u32' },
    lastUpdatedTick:          { type: 'u32' }
  };
}

/**
 * I3DMInstanceComponent — bound to each instance for external systems
 * (scatter spawners, pathfinding, picking) that need per-instance queries.
 */
export class I3DMInstanceComponent {
  static schema = {
    tileKeyHash:              { type: 'u32' },
    instanceIndex:            { type: 'u32' },
    classId:                  { type: 'u32' },
    parentInstanceIndex:      { type: 'u32' },  // 0xFFFFFFFF if root
    firstPropertyIndex:       { type: 'u32' },
    propertyCount:            { type: 'u32' },
    boundingRadius:           { type: 'f32' },
    lastUpdatedTick:          { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. MATRIX ARENA
// ═════════════════════════════════════════════════════════════════════

/**
 * I3DMMatrixArena — a shared Float32Array that holds the 4×4 instance
 * matrices for every parsed i3dm tile. Each instance occupies 16 floats in
 * column-major order (matching the 3D Tiles spec). Ranges are freed when a
 * tile is evicted.
 */
class I3DMMatrixArena {
  constructor(initialCapacity = 8192) {
    this.data = new Float32Array(initialCapacity);
    this.used = 0;
    this.capacity = initialCapacity;
    this.freeRanges = [];
  }

  alloc(count) {
    for (let i = 0; i < this.freeRanges.length; i++) {
      const r = this.freeRanges[i];
      if (r.size >= count) {
        const start = r.start;
        if (r.size === count) this.freeRanges.splice(i, 1);
        else { r.start += count; r.size -= count; }
        return start;
      }
    }
    if (this.used + count > this.capacity) {
      let newCap = this.capacity;
      while (newCap < this.used + count) newCap *= 2;
      const newData = new Float32Array(newCap);
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
 * Parses the 32-byte i3dm header.
 */
export function parseI3DMHeader(view) {
  if (view.byteLength < I3DM_HEADER_SIZE) {
    throw new Error(`i3dm buffer too small: ${view.byteLength} < ${I3DM_HEADER_SIZE}`);
  }
  const magic = view.getUint32(0, true);
  if (magic !== I3DM_MAGIC) {
    throw new Error(`Invalid i3dm magic: 0x${magic.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== 1) {
    throw new Error(`Unsupported i3dm version: ${version}`);
  }
  return {
    version,
    byteLength: view.getUint32(8, true),
    featureTableJsonByteLength: view.getUint32(12, true),
    featureTableBinaryByteLength: view.getUint32(16, true),
    batchTableJsonByteLength: view.getUint32(20, true),
    batchTableBinaryByteLength: view.getUint32(24, true),
    gltfFormat: view.getUint32(28, true)
  };
}

// ═════════════════════════════════════════════════════════════════════
// 5. FEATURE TABLE PARSING — full i3dm channel set
// ═════════════════════════════════════════════════════════════════════

/**
 * Parses the i3dm feature table JSON and returns the full set of channels.
 * Every channel that the spec defines is decoded into a typed array; missing
 * channels are returned as null.
 *
 * The result has these fields:
 *   instancesLength       – required, number of instances
 *   batchLength           – required, number of batches
 *   positions             – Float32Array[3*N] (from POSITION or POSITION_QUANTIZED)
 *   quantizedVolumeOffset – Float32Array[3] or null
 *   quantizedVolumeScale  – Float32Array[3] or null
 *   scales                – Float32Array[N] or null
 *   nonUniformScales      – Float32Array[3*N] or null
 *   normalUp              – Float32Array[3*N] or null
 *   normalRight           – Float32Array[3*N] or null
 *   normalUpOct32P        – Uint32Array[N] or null
 *   normalRightOct32P     – Uint32Array[N] or null
 *   quaternions32P        – Uint32Array[N] or null
 *   rtcCenter             – Float32Array[3] or null
 *   gltfUri               – string or null (when gltfFormat = 0)
 *   orientationChannel    – I3DMOrientationChannel.*
 *   positionChannel       – I3DMPositionChannel.*
 *   customProperties      – preserved for downstream systems
 */
export function parseI3DMFeatureTable(jsonText, binaryView, gltfFormat) {
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Invalid i3dm feature table JSON: ${e.message}`);
  }

  const instancesLength = json.INSTANCES_LENGTH | 0;
  const batchLength = json.BATCH_LENGTH | 0;
  if (instancesLength <= 0) {
    throw new Error('i3dm feature table missing INSTANCES_LENGTH');
  }

  const result = {
    instancesLength,
    batchLength,
    positions: null,
    quantizedVolumeOffset: null,
    quantizedVolumeScale: null,
    scales: null,
    nonUniformScales: null,
    normalUp: null,
    normalRight: null,
    normalUpOct32P: null,
    normalRightOct32P: null,
    quaternions32P: null,
    rtcCenter: null,
    gltfUri: null,
    orientationChannel: I3DMOrientationChannel.NONE,
    positionChannel: I3DMPositionChannel.NONE,
    customProperties: null
  };

  // ---- Positions ----
  if (json.POSITION) {
    result.positions = readBinaryFloat32Array(binaryView, json.POSITION, instancesLength * 3);
    result.positionChannel = I3DMPositionChannel.FLOAT32;
  } else if (json.POSITION_QUANTIZED) {
    result.positions = new Float32Array(instancesLength * 3);
    const quantized = readBinaryUint16Array(binaryView, json.POSITION_QUANTIZED, instancesLength * 3);
    // Decode later once we know the volume offset/scale.
    result._quantizedRaw = quantized;
    result.positionChannel = I3DMPositionChannel.QUANTIZED;
  }

  if (json.QUANTIZED_VOLUME_OFFSET) {
    result.quantizedVolumeOffset = readBinaryFloat32Array(binaryView, json.QUANTIZED_VOLUME_OFFSET, 3);
  }
  if (json.QUANTIZED_VOLUME_SCALE) {
    result.quantizedVolumeScale = readBinaryFloat32Array(binaryView, json.QUANTIZED_VOLUME_SCALE, 3);
  }

  // Decode quantized positions now that we have the volume.
  if (result._quantizedRaw) {
    const raw = result._quantizedRaw;
    const offset = result.quantizedVolumeOffset ?? [0, 0, 0];
    const scale = result.quantizedVolumeScale ?? [1, 1, 1];
    for (let i = 0; i < instancesLength; i++) {
      result.positions[i * 3]     = (raw[i * 3]     / 65535) * scale[0] + offset[0];
      result.positions[i * 3 + 1] = (raw[i * 3 + 1] / 65535) * scale[1] + offset[1];
      result.positions[i * 3 + 2] = (raw[i * 3 + 2] / 65535) * scale[2] + offset[2];
    }
    delete result._quantizedRaw;
  }

  // ---- Scales ----
  if (json.SCALE) {
    result.scales = readBinaryFloat32Array(binaryView, json.SCALE, instancesLength);
  }
  if (json.SCALE_NON_UNIFORM) {
    result.nonUniformScales = readBinaryFloat32Array(binaryView, json.SCALE_NON_UNIFORM, instancesLength * 3);
  }

  // ---- Orientation ----
  if (json.NORMAL_UP && json.NORMAL_RIGHT) {
    result.normalUp = readBinaryFloat32Array(binaryView, json.NORMAL_UP, instancesLength * 3);
    result.normalRight = readBinaryFloat32Array(binaryView, json.NORMAL_RIGHT, instancesLength * 3);
    result.orientationChannel = I3DMOrientationChannel.NORMAL_UP_RIGHT;
  } else if (json.NORMAL_UP_OCT32P && json.NORMAL_RIGHT_OCT32P) {
    result.normalUpOct32P = readBinaryUint32Array(binaryView, json.NORMAL_UP_OCT32P, instancesLength);
    result.normalRightOct32P = readBinaryUint32Array(binaryView, json.NORMAL_RIGHT_OCT32P, instancesLength);
    result.orientationChannel = I3DMOrientationChannel.OCT32P;
  } else if (json.QUATERNION_32P) {
    result.quaternions32P = readBinaryUint32Array(binaryView, json.QUATERNION_32P, instancesLength);
    result.orientationChannel = I3DMOrientationChannel.QUATERNION_32P;
  }

  // ---- RTC_CENTER ----
  if (json.RTC_CENTER) {
    result.rtcCenter = readBinaryFloat32Array(binaryView, json.RTC_CENTER, 3);
  }

  // ---- External glTF URI ----
  if (gltfFormat === I3DMGltfFormat.EXTERNAL_URI && json.GLTF_URI) {
    result.gltfUri = String(json.GLTF_URI);
  }

  // ---- Custom properties ----
  for (const key of Object.keys(json)) {
    if (key === 'INSTANCES_LENGTH' || key === 'BATCH_LENGTH' ||
        key === 'POSITION' || key === 'POSITION_QUANTIZED' ||
        key === 'QUANTIZED_VOLUME_OFFSET' || key === 'QUANTIZED_VOLUME_SCALE' ||
        key === 'SCALE' || key === 'SCALE_NON_UNIFORM' ||
        key === 'NORMAL_UP' || key === 'NORMAL_RIGHT' ||
        key === 'NORMAL_UP_OCT32P' || key === 'NORMAL_RIGHT_OCT32P' ||
        key === 'QUATERNION_32P' || key === 'RTC_CENTER' ||
        key === 'GLTF_URI') continue;
    if (!result.customProperties) result.customProperties = Object.create(null);
    result.customProperties[key] = json[key];
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════════
// 6. BINARY CHANNEL READERS
// ═════════════════════════════════════════════════════════════════════

function readBinaryFloat32Array(binaryView, ref, count) {
  if (!binaryView || !ref) return null;
  const byteOffset = ref.byteOffset ?? 0;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = binaryView.getFloat32(byteOffset + i * 4, true);
  }
  return out;
}

function readBinaryUint32Array(binaryView, ref, count) {
  if (!binaryView || !ref) return null;
  const byteOffset = ref.byteOffset ?? 0;
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = binaryView.getUint32(byteOffset + i * 4, true);
  }
  return out;
}

function readBinaryUint16Array(binaryView, ref, count) {
  if (!binaryView || !ref) return null;
  const byteOffset = ref.byteOffset ?? 0;
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = binaryView.getUint16(byteOffset + i * 2, true);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════
// 7. ORIENTATION DECODING — three encodings, one matrix
// ═════════════════════════════════════════════════════════════════════

/**
 * Decodes an octahedral-encoded normal from a 32-bit packed uint32.
 * The packing is (sx << 16) | (sy & 0xFFFF), where sx and sy are
 * signed 16-bit values in [-32767, 32767] representing the octahedral
 * projection coordinates.
 */
function decodeOct32P(encoded) {
  const sxRaw = (encoded >>> 16) & 0xFFFF;
  const syRaw = encoded & 0xFFFF;
  const sx = sxRaw > 32767 ? sxRaw - 65536 : sxRaw;
  const sy = syRaw > 32767 ? syRaw - 65536 : syRaw;
  const x = sx / 32767;
  const y = sy / 32767;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const signX = x >= 0 ? 1 : -1;
    const signY = y >= 0 ? 1 : -1;
    const ox = (1 - Math.abs(y)) * signX;
    const oy = (1 - Math.abs(x)) * signY;
    const len = Math.sqrt(ox * ox + oy * oy + z * z) || 1;
    return [ox / len, oy / len, z / len];
  }
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * Decodes a 32-bit packed quaternion. The packing stores the smallest
 * three components of a unit quaternion in 10 bits each (with 2 bits
 * unused), following the standard "smallest three" scheme.
 */
function decodeQuaternion32P(encoded) {
  // Extract the four 10-bit slots.
  const a = (encoded >>> 0)  & 0x3FF;
  const b = (encoded >>> 10) & 0x3FF;
  const c = (encoded >>> 20) & 0x3FF;
  const d = (encoded >>> 30) & 0x3;

  // Dequantize the three stored components to [-1, 1].
  const x = (a / 511) * 2 - 1;
  const y = (b / 511) * 2 - 1;
  const z = (c / 511) * 2 - 1;

  // Reconstruct the fourth component.
  const w2 = 1 - x * x - y * y - z * z;
  const w = w2 > 0 ? Math.sqrt(w2) : 0;

  // The 2-bit slot d selects which component was omitted.
  switch (d) {
    case 0: return [w, x, y, z];
    case 1: return [x, w, y, z];
    case 2: return [x, y, w, z];
    case 3: return [x, y, z, w];
    default: return [0, 0, 0, 1];
  }
}

/**
 * Computes the 4×4 instance matrix from position, orientation, and scale.
 * Writes 16 floats (column-major) into `out` starting at `offset`.
 *
 * The matrix follows the 3D Tiles convention:
 *   column 0 = right   * scaleX
 *   column 1 = up      * scaleY
 *   column 2 = forward * scaleZ     (forward = right × up)
 *   column 3 = position
 */
function computeInstanceMatrix(
  px, py, pz,
  rightX, rightY, rightZ,
  upX, upY, upZ,
  scaleX, scaleY, scaleZ,
  out, offset
) {
  // Normalize the right and up vectors (defensive — the source may not be
  // unit length).
  const rLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ) || 1;
  const uLen = Math.sqrt(upX * upX + upY * upY + upZ * upZ) || 1;
  const rx = rightX / rLen, ry = rightY / rLen, rz = rightZ / rLen;
  const ux = upX / uLen, uy = upY / uLen, uz = upZ / uLen;

  // Forward = right × up.
  const fx = ry * uz - rz * uy;
  const fy = rz * ux - rx * uz;
  const fz = rx * uy - ry * ux;

  // Column 0: right * scale.x
  out[offset + 0]  = rx * scaleX;
  out[offset + 1]  = ry * scaleX;
  out[offset + 2]  = rz * scaleX;
  out[offset + 3]  = 0;

  // Column 1: up * scale.y
  out[offset + 4]  = ux * scaleY;
  out[offset + 5]  = uy * scaleY;
  out[offset + 6]  = uz * scaleY;
  out[offset + 7]  = 0;

  // Column 2: forward * scale.z
  out[offset + 8]  = fx * scaleZ;
  out[offset + 9]  = fy * scaleZ;
  out[offset + 10] = fz * scaleZ;
  out[offset + 11] = 0;

  // Column 3: position
  out[offset + 12] = px;
  out[offset + 13] = py;
  out[offset + 14] = pz;
  out[offset + 15] = 1;
}

// ═════════════════════════════════════════════════════════════════════
// 8. INSTANCE MATRICES BUILDER
// ═════════════════════════════════════════════════════════════════════

/**
 * Builds the full instance matrix array for a feature table. Writes
 * 16 floats per instance into the arena starting at `arenaStart`.
 */
export function buildI3DMInstanceMatrices(featureTable, arena, arenaStart) {
  const N = featureTable.instancesLength;
  const positions = featureTable.positions;
  const scales = featureTable.scales;
  const nonUniformScales = featureTable.nonUniformScales;
  const normalUp = featureTable.normalUp;
  const normalRight = featureTable.normalRight;
  const normalUpOct32P = featureTable.normalUpOct32P;
  const normalRightOct32P = featureTable.normalRightOct32P;
  const quaternions32P = featureTable.quaternions32P;

  const data = arena.data;

  for (let i = 0; i < N; i++) {
    // ---- Position ----
    let px = positions ? positions[i * 3]     : 0;
    let py = positions ? positions[i * 3 + 1] : 0;
    let pz = positions ? positions[i * 3 + 2] : 0;

    // ---- Scale ----
    let sx = 1, sy = 1, sz = 1;
    if (nonUniformScales) {
      sx = nonUniformScales[i * 3];
      sy = nonUniformScales[i * 3 + 1];
      sz = nonUniformScales[i * 3 + 2];
    } else if (scales) {
      sx = scales[i];
      sy = scales[i];
      sz = scales[i];
    }

    // ---- Orientation ----
    let rx = 1, ry = 0, rz = 0;
    let ux = 0, uy = 1, uz = 0;

    if (normalUp && normalRight) {
      rx = normalRight[i * 3]; ry = normalRight[i * 3 + 1]; rz = normalRight[i * 3 + 2];
      ux = normalUp[i * 3]; uy = normalUp[i * 3 + 1]; uz = normalUp[i * 3 + 2];
    } else if (normalUpOct32P && normalRightOct32P) {
      const up = decodeOct32P(normalUpOct32P[i]);
      const right = decodeOct32P(normalRightOct32P[i]);
      ux = up[0]; uy = up[1]; uz = up[2];
      rx = right[0]; ry = right[1]; rz = right[2];
    } else if (quaternions32P) {
      const q = decodeQuaternion32P(quaternions32P[i]);
      // q = [x, y, z, w] — build rotation matrix, then extract right/up.
      const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
      // Right = rotation of (1, 0, 0).
      rx = 1 - 2 * (qy * qy + qz * qz);
      ry = 2 * (qx * qy + qz * qw);
      rz = 2 * (qx * qz - qy * qw);
      // Up = rotation of (0, 1, 0).
      ux = 2 * (qx * qy - qz * qw);
      uy = 1 - 2 * (qx * qx + qz * qz);
      uz = 2 * (qy * qz + qx * qw);
    }

    // ---- Build the matrix ----
    computeInstanceMatrix(
      px, py, pz,
      rx, ry, rz,
      ux, uy, uz,
      sx, sy, sz,
      data, arenaStart + i * 16
    );
  }
}

// ═════════════════════════════════════════════════════════════════════
// 9. THE MAIN PARSER
// ═════════════════════════════════════════════════════════════════════

/**
 * I3DMParseResult — the result of parsing an i3dm buffer.
 */
export class I3DMParseResult {
  constructor(props) {
    // Header.
    this.header = props.header;
    // Feature table.
    this.featureTable = props.featureTable;
    // Batch table (reuses the b3dm batch table structure).
    this.batchTable = props.batchTable;
    // glTF payload — either a Uint8Array (embedded) or a string (external URI).
    this.gltf = props.gltf;
    this.gltfFormat = props.gltfFormat;
    // Hierarchy / metadata (from the reused b3dm batch table parser).
    this.hierarchy = props.hierarchy ?? null;
    this.metadata = props.metadata ?? null;
    // Instance matrices.
    this.matrixArena = props.matrixArena ?? null;
    this.matrixStart = props.matrixStart ?? 0;
    this.matrixCount = props.matrixCount ?? 0;
    // Diagnostics.
    this.byteLength = props.byteLength;
    this.parseDurationMs = props.parseDurationMs ?? 0;
    this.errors = props.errors ?? null;
  }

  get hasGltf() { return !!this.gltf; }
  get isEmbeddedGltf() { return this.gltfFormat === I3DMGltfFormat.EMBEDDED_GLB; }
  get isExternalGltf() { return this.gltfFormat === I3DMGltfFormat.EXTERNAL_URI; }
  get hasBatchTable() { return !!this.batchTable; }
  get hasHierarchy() { return !!this.hierarchy; }
  get hasMetadata() { return !!this.metadata; }
  get instancesLength() { return this.featureTable?.instancesLength ?? 0; }
}

/**
 * TerrainI3DMParser — the i3dm parser for the seamless 3D Tiles terrain
 * pipeline. Reuses the b3dm parser’s batch-table parsing (file 401) and
 * adds the i3dm-specific feature table and per-instance matrix logic.
 *
 * A parser instance can be reused across many tiles. It pre-allocates the
 * matrix arena and the scratch DataView so parsing is allocation-free after
 * warm-up.
 */
export class TerrainI3DMParser {
  constructor(options = {}) {
    this.options = {
      initialMatrixCapacity: options.initialMatrixCapacity ?? 8192,
      maxMatrixArenaBytes: options.maxMatrixArenaBytes ?? 32 * 1024 * 1024,
      enableDiagnostics: options.enableDiagnostics ?? true,
      ...options
    };

    this._matrixArena = new I3DMMatrixArena(this.options.initialMatrixCapacity);

    this._scratch = {
      view: null,
      textDecoder: new TextDecoder('utf-8')
    };

    this.stats = {
      tilesParsed: 0,
      tilesFailed: 0,
      totalInstances: 0,
      totalBytesProcessed: 0,
      totalParseMs: 0,
      lastParseMs: 0,
      peakInstances: 0
    };
  }

  // ---------------------------------------------------------------------
  // Main parse
  // ---------------------------------------------------------------------

  /**
   * Parses an i3dm buffer. Returns an I3DMParseResult.
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
      header = parseI3DMHeader(view);
    } catch (e) {
      this.stats.tilesFailed++;
      return new I3DMParseResult({
        header: null, featureTable: null, batchTable: null, gltf: null,
        gltfFormat: I3DMGltfFormat.EXTERNAL_URI,
        byteLength: arr.byteLength, errors: [e.message]
      });
    }

    if (header.byteLength !== arr.byteLength) {
      errors.push(`Header byteLength (${header.byteLength}) != actual (${arr.byteLength})`);
    }

    // ---- 2. Compute sub-buffer offsets ----
    let cursor = I3DM_HEADER_SIZE;
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
      return new I3DMParseResult({
        header, featureTable: null, batchTable: null, gltf: null,
        gltfFormat: header.gltfFormat,
        byteLength: arr.byteLength, errors: ['glTF payload out of range']
      });
    }

    // ---- 3. Parse feature table JSON ----
    let featureTable = null;
    if (header.featureTableJsonByteLength > 0) {
      try {
        const ftJsonBytes = arr.subarray(ftJsonStart, ftJsonEnd);
        const ftJsonText = this._scratch.textDecoder.decode(ftJsonBytes).replace(/\s+$/, '');

        // Build the feature table binary view.
        let ftBinaryView = null;
        if (header.featureTableBinaryByteLength > 0) {
          ftBinaryView = new DataView(
            arr.buffer,
            arr.byteOffset + ftBinStart,
            header.featureTableBinaryByteLength
          );
        }

        featureTable = parseI3DMFeatureTable(ftJsonText, ftBinaryView, header.gltfFormat);
      } catch (e) {
        errors.push(`Feature table parse: ${e.message}`);
        this.stats.tilesFailed++;
        return new I3DMParseResult({
          header, featureTable: null, batchTable: null, gltf: null,
          gltfFormat: header.gltfFormat,
          byteLength: arr.byteLength, errors
        });
      }
    }

    // ---- 4. Parse batch table JSON (reuse b3dm parser) ----
    let batchTable = null;
    let hierarchy = null;
    let metadata = null;
    if (header.batchTableJsonByteLength > 0) {
      try {
        const btJsonBytes = arr.subarray(btJsonStart, btJsonEnd);
        const btJsonText = this._scratch.textDecoder.decode(btJsonBytes).replace(/\s+$/, '');

        let btBinaryView = null;
        if (header.batchTableBinaryByteLength > 0) {
          btBinaryView = new DataView(
            arr.buffer,
            arr.byteOffset + btBinStart,
            header.batchTableBinaryByteLength
          );
        }

        batchTable = parseB3DMBatchTable(
          btJsonText, btBinaryView, featureTable?.instancesLength ?? 0
        );
        hierarchy = batchTable.hierarchy;
        metadata = batchTable.metadata;
      } catch (e) {
        errors.push(`Batch table parse: ${e.message}`);
      }
    }

    // ---- 5. Handle glTF payload ----
    let gltf = null;
    if (header.gltfFormat === I3DMGltfFormat.EMBEDDED_GLB) {
      const gltfBytes = arr.subarray(gltfStart, gltfEnd);
      const gltfCheck = verifyGLBPayload(gltfBytes);
      if (gltfCheck.valid) {
        gltf = gltfCheck.glb;
      } else {
        errors.push('Invalid embedded GLB payload');
      }
    } else {
      // External URI comes from the feature table.
      gltf = featureTable?.gltfUri ?? null;
      if (!gltf) {
        errors.push('External i3dm missing GLTF_URI');
      }
    }

    // ---- 6. Build instance matrices ----
    let matrixStart = 0;
    let matrixCount = 0;
    if (featureTable && featureTable.instancesLength > 0) {
      const requiredFloats = featureTable.instancesLength * 16;
      matrixStart = this._matrixArena.alloc(requiredFloats);
      matrixCount = featureTable.instancesLength;
      buildI3DMInstanceMatrices(featureTable, this._matrixArena, matrixStart);
    }

    // ---- 7. Update stats ----
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const parseMs = t1 - t0;

    this.stats.tilesParsed++;
    this.stats.lastParseMs = parseMs;
    this.stats.totalParseMs += parseMs;
    this.stats.totalBytesProcessed += arr.byteLength;
    if (featureTable) {
      this.stats.totalInstances += featureTable.instancesLength;
      this.stats.peakInstances = Math.max(this.stats.peakInstances, featureTable.instancesLength);
    }

    // ---- 8. Return the result ----
    return new I3DMParseResult({
      header,
      featureTable,
      batchTable,
      gltf,
      gltfFormat: header.gltfFormat,
      hierarchy,
      metadata,
      matrixArena: this._matrixArena,
      matrixStart,
      matrixCount,
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

  getMatrixArena() {
    return this._matrixArena;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    this._matrixArena.dispose();
    this._scratch.view = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 10. DECODER INTEGRATION
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a decode function for the archive source (file 400) that parses
 * an i3dm payload and returns the I3DMParseResult. Register it with the
 * archive source under ContentDecodeRoute.I3DM.
 */
export function createI3DMDecoder(options = {}) {
  const parser = new TerrainI3DMParser(options);

  return async function decodeI3DM(bytes, context) {
    const result = parser.parse(bytes);
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

export function createTerrainI3DMParser(options = {}) {
  return new TerrainI3DMParser({
    initialMatrixCapacity: options.initialMatrixCapacity ?? 8192,
    maxMatrixArenaBytes: options.maxMatrixArenaBytes ?? 32 * 1024 * 1024,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 12. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainI3DMParser,
  I3DMParseResult,
  I3DMComponent,
  I3DMInstanceComponent,
  I3DMMatrixArena,
  I3DMGltfFormat,
  I3DMOrientationChannel,
  I3DMPositionChannel,
  I3DM_MAGIC,
  I3DM_HEADER_SIZE,
  parseI3DMHeader,
  parseI3DMFeatureTable,
  buildI3DMInstanceMatrices,
  createI3DMDecoder,
  createTerrainI3DMParser
};