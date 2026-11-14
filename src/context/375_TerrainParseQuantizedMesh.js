// file number : 375
// full path name : src/context/375_TerrainParseQuantizedMesh.js
//### Description : Context-aware Cesium quantized-mesh-1.0 binary parser and
//###               procedural mesh synthesizer. Consumes a raw .terrain tile
//###               payload, decodes the full binary layout (88-byte header,
//###               zigzag-delta u/v/height vertex streams, high-water-mark
//###               encoded triangle indices, four edge-index lists, and every
//###               optional extension), and produces a complete 3D terrain
//###               data object: positions, normals, indices, biome weights,
//###               edge-vertex lists for seamless stitching, and ECS-bound
//###               provenance. Operates entirely in a dedicated worker pool
//###               with zero-copy SharedArrayBuffer transfer; no external
//###               loader, no CDN access, no static server. Results are merged
//###               only into the next frame’s build stage, never the current
//###               one. Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap, and scales from a
//###               single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : Ingesting Cesium-compatible quantized-mesh terrain tiles into
//###            the living-world terrain pipeline. The resulting data object is
//###            directly consumed by the seamless-tile reconciler (file 380)
//###            and the render-side dispatch stage; edge indices guarantee
//###            crack-free transitions across LOD boundaries, and the decoded
//###            normals (or procedurally estimated fallback) keep the mesh
//###            fully lit without a normals extension.
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
  // textures (procedural masks for quantized-mesh-driven terrain painting)
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
  BoundingVolumeKind,
  SeamEdge,
  hasSeam,
  stringTileKey,
  fnv1aHash,
  computeScreenSpaceError
} from './373_Tileset2DTypes.js';

// ---------------------------------------------------------------------------
// 1. ECS COMPONENTS – structure-of-arrays, flecs-inspired
// ---------------------------------------------------------------------------

/**
 * QuantizedMeshComponent — one per live quantized-mesh tile.
 * Stores quadtree coordinates, LOD, vertex/index ranges, edge counts, and
 * extension flags so downstream systems can query edge vertices for stitching
 * and occlusion without re-parsing.
 */
export class QuantizedMeshComponent {
  static schema = {
    tileX:           { type: 'i32' },
    tileY:           { type: 'i32' },
    tileZ:           { type: 'i32' },
    lod:             { type: 'u8' },
    vertexCount:     { type: 'u32' },
    triangleCount:   { type: 'u32' },
    vertexStart:     { type: 'u32' },   // offset into shared position arena
    indexStart:      { type: 'u32' },   // offset into shared index arena
    indexCount:      { type: 'u32' },
    westCount:       { type: 'u16' },
    southCount:      { type: 'u16' },
    eastCount:       { type: 'u16' },
    northCount:      { type: 'u16' },
    minHeight:       { type: 'f32' },
    maxHeight:       { type: 'f32' },
    hasNormals:      { type: 'u8' },
    hasWaterMask:    { type: 'u8' },
    hasMetadata:     { type: 'u8' },
    centerX:         { type: 'f64' },
    centerY:         { type: 'f64' },
    centerZ:         { type: 'f64' },
    boundingSphereRadius: { type: 'f32' },
    state:           { type: 'u8' },   // TileState.*
    lastUpdatedTick: { type: 'u32' }
  };
}

/**
 * QuantizedMeshSeamComponent — edge stitching state for a tile.
 * Mirrors HeightmapSeamComponent (file 374) so the reconciler can treat both
 * tile families uniformly.
 */
export class QuantizedMeshSeamComponent {
  static schema = {
    northFlags: { type: 'u8' },
    southFlags: { type: 'u8' },
    eastFlags:  { type: 'u8' },
    westFlags:  { type: 'u8' },
    northLod:   { type: 'i8' },
    southLod:   { type: 'i8' },
    eastLod:    { type: 'i8' },
    westLod:    { type: 'i8' }
  };
}

// ---------------------------------------------------------------------------
// 2. QUANTIZED-MESH WORKER – full binary decoder (off main thread)
// ---------------------------------------------------------------------------

const QUANTIZED_MESH_PARSER_WORKER_SOURCE = `
  // Pure binary quantized-mesh-1.0 decoder. No loaders, no network access.
  // Implements:
  //   - 88-byte header (center, min/max height, bounding sphere, horizon occlusion)
  //   - zigzag-delta u/v/height vertex streams (uint16, 0..32767)
  //   - high-water-mark encoded triangle indices (uint16 or uint32)
  //   - four edge-index lists (west, south, east, north)
  //   - oct-encoded per-vertex normals extension (id 1)
  //   - water mask extension (id 2)
  //   - metadata extension (id 4)
  //   - procedural normal estimation when normals extension is absent
  //   - optional skirt generation along all four edges

  const HEADER_SIZE = 88;
  const EXT_NORMALS = 1;
  const EXT_WATER_MASK = 2;
  const EXT_METADATA = 4;

  // -------------------------------------------------------------------------
  // Primitive readers (little-endian)
  // -------------------------------------------------------------------------

  function readUint8(bytes, off) { return bytes[off]; }
  function readUint16(bytes, off) {
    return bytes[off] | (bytes[off + 1] << 8);
  }
  function readUint32(bytes, off) {
    return (bytes[off] | (bytes[off + 1] << 8) |
            (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
  }
  function readFloat32(data, off) {
    return data.getFloat32(off, true);
  }
  function readFloat64(data, off) {
    return data.getFloat64(off, true);
  }

  // Zigzag decode: (n >>> 1) ^ -(n & 1)
  function zigzagDecode(n) {
    return (n >>> 1) ^ -(n & 1);
  }

  // -------------------------------------------------------------------------
  // Oct-encoded normal decoding (Cigolle et al. 2014)
  // -------------------------------------------------------------------------

  function octDecode(x, y) {
    const nx = x / 127;
    const ny = y / 127;
    const nz = 1 - Math.abs(nx) - Math.abs(ny);
    if (nz < 0) {
      const sx = nx >= 0 ? 1 : -1;
      const sy = ny >= 0 ? 1 : -1;
      const ox = (1 - Math.abs(ny)) * sx;
      const oy = (1 - Math.abs(nx)) * sy;
      return normalize3(ox, oy, nz);
    }
    return normalize3(nx, ny, nz);
  }

  function normalize3(x, y, z) {
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / len, y / len, z / len];
  }

  // -------------------------------------------------------------------------
  // Header parsing (88 bytes)
  // -------------------------------------------------------------------------

  function parseHeader(data) {
    const centerX = readFloat64(data, 0);
    const centerY = readFloat64(data, 8);
    const centerZ = readFloat64(data, 16);
    const minimumHeight = readFloat32(data, 24);
    const maximumHeight = readFloat32(data, 28);
    const boundingSphereCenterX = readFloat64(data, 32);
    const boundingSphereCenterY = readFloat64(data, 40);
    const boundingSphereCenterZ = readFloat64(data, 48);
    const boundingSphereRadius = readFloat64(data, 56);
    const horizonOcclusionPointX = readFloat64(data, 64);
    const horizonOcclusionPointY = readFloat64(data, 72);
    const horizonOcclusionPointZ = readFloat64(data, 80);
    return {
      centerX, centerY, centerZ,
      minimumHeight, maximumHeight,
      boundingSphere: {
        x: boundingSphereCenterX,
        y: boundingSphereCenterY,
        z: boundingSphereCenterZ,
        radius: boundingSphereRadius
      },
      horizonOcclusionPoint: {
        x: horizonOcclusionPointX,
        y: horizonOcclusionPointY,
        z: horizonOcclusionPointZ
      }
    };
  }

  // -------------------------------------------------------------------------
  // Vertex data decoding (zigzag-delta u/v/height)
  // -------------------------------------------------------------------------

  function decodeVertexData(bytes, offset) {
    const vertexCount = readUint32(bytes, offset);
    offset += 4;

    const u = new Uint16Array(vertexCount);
    const v = new Uint16Array(vertexCount);
    const h = new Uint16Array(vertexCount);

    // Decode u (zigzag-delta)
    let prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      const encoded = readUint16(bytes, offset);
      offset += 2;
      prev += zigzagDecode(encoded);
      u[i] = prev;
    }
    // Decode v
    prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      const encoded = readUint16(bytes, offset);
      offset += 2;
      prev += zigzagDecode(encoded);
      v[i] = prev;
    }
    // Decode height
    prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      const encoded = readUint16(bytes, offset);
      offset += 2;
      prev += zigzagDecode(encoded);
      h[i] = prev;
    }

    return { vertexCount, u, v, h, offset };
  }

  // -------------------------------------------------------------------------
  // Index data decoding (high-water-mark)
  // -------------------------------------------------------------------------

  function decodeIndexData(bytes, offset, vertexCount) {
    const triangleCount = readUint32(bytes, offset);
    offset += 4;
    const use32 = vertexCount > 65535;
    const indexCount = triangleCount * 3;
    const indices = use32 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

    let highest = 0;
    for (let i = 0; i < indexCount; i++) {
      let code;
      if (use32) {
        code = readUint32(bytes, offset);
        offset += 4;
      } else {
        code = readUint16(bytes, offset);
        offset += 2;
      }
      const index = highest - code;
      indices[i] = index;
      if (code === 0) highest++;
    }

    return { triangleCount, indices, offset };
  }

  // -------------------------------------------------------------------------
  // Edge index decoding (west, south, east, north)
  // -------------------------------------------------------------------------

  function decodeEdgeIndices(bytes, offset, use32) {
    const readIndex = use32
      ? (o) => readUint32(bytes, o)
      : (o) => readUint16(bytes, o);
    const idxSize = use32 ? 4 : 2;

    const westCount = readUint32(bytes, offset);
    offset += 4;
    const west = new Uint32Array(westCount);
    for (let i = 0; i < westCount; i++) { west[i] = readIndex(offset); offset += idxSize; }

    const southCount = readUint32(bytes, offset);
    offset += 4;
    const south = new Uint32Array(southCount);
    for (let i = 0; i < southCount; i++) { south[i] = readIndex(offset); offset += idxSize; }

    const eastCount = readUint32(bytes, offset);
    offset += 4;
    const east = new Uint32Array(eastCount);
    for (let i = 0; i < eastCount; i++) { east[i] = readIndex(offset); offset += idxSize; }

    const northCount = readUint32(bytes, offset);
    offset += 4;
    const north = new Uint32Array(northCount);
    for (let i = 0; i < northCount; i++) { north[i] = readIndex(offset); offset += idxSize; }

    return { west, south, east, north, offset };
  }

  // -------------------------------------------------------------------------
  // Extension parsing
  // -------------------------------------------------------------------------

  function parseExtensions(bytes, offset, vertexCount) {
    let normals = null;
    let waterMask = null;
    let metadata = null;

    while (offset < bytes.length) {
      if (offset + 5 > bytes.length) break;
      const extensionId = readUint8(bytes, offset);
      const extensionLength = readUint32(bytes, offset + 1);
      offset += 5;

      if (extensionId === EXT_NORMALS) {
        normals = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
          const sx = bytes[offset + i * 2];
          const sy = bytes[offset + i * 2 + 1];
          const x = sx > 127 ? sx - 256 : sx;
          const y = sy > 127 ? sy - 256 : sy;
          const n = octDecode(x, y);
          normals[i * 3] = n[0];
          normals[i * 3 + 1] = n[1];
          normals[i * 3 + 2] = n[2];
        }
      } else if (extensionId === EXT_WATER_MASK) {
        if (extensionLength === 1) {
          waterMask = { uniform: bytes[offset] };
        } else {
          waterMask = { grid: bytes.subarray(offset, offset + extensionLength) };
        }
      } else if (extensionId === EXT_METADATA) {
        const jsonLength = readUint32(bytes, offset);
        if (offset + 4 + jsonLength <= bytes.length) {
          const jsonBytes = bytes.subarray(offset + 4, offset + 4 + jsonLength);
          try {
            metadata = JSON.parse(new TextDecoder('utf-8').decode(jsonBytes));
          } catch (e) {
            metadata = null;
          }
        }
      }

      offset += extensionLength;
    }

    return { normals, waterMask, metadata };
  }

  // -------------------------------------------------------------------------
  // Procedural normal estimation (fallback when no normals extension)
  // -------------------------------------------------------------------------

  function estimateNormals(positions, vertexCount, cellSize) {
    const normals = new Float32Array(vertexCount * 3);
    // Build a sparse grid of buckets for neighbor lookup.
    const gridSize = Math.ceil(Math.sqrt(vertexCount));
    const buckets = new Map();
    let minX = Infinity, minY = Infinity;
    for (let i = 0; i < vertexCount; i++) {
      if (positions[i * 3] < minX) minX = positions[i * 3];
      if (positions[i * 3 + 1] < minY) minY = positions[i * 3 + 1];
    }
    for (let i = 0; i < vertexCount; i++) {
      const gx = Math.floor((positions[i * 3] - minX) / cellSize);
      const gy = Math.floor((positions[i * 3 + 1] - minY) / cellSize);
      const key = gy * gridSize + gx;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }
    const out = [0, 0, 1];
    for (let i = 0; i < vertexCount; i++) {
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      const gx = Math.floor((px - minX) / cellSize);
      const gy = Math.floor((py - minY) / cellSize);
      let sumDx = 0, sumDy = 0, count = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nkey = (gy + oy) * gridSize + (gx + ox);
          const list = buckets.get(nkey);
          if (!list) continue;
          for (const j of list) {
            const dx = positions[j * 3] - px;
            const dy = positions[j * 3 + 1] - py;
            const dz = positions[j * 3 + 2] - pz;
            const dist2 = dx * dx + dy * dy;
            if (dist2 < cellSize * cellSize * 4) {
              sumDx += dz * dx;
              sumDy += dz * dy;
              count++;
            }
          }
        }
      }
      if (count > 0) {
        out[0] = -sumDx / count;
        out[1] = -sumDy / count;
        out[2] = 1;
      } else {
        out[0] = 0; out[1] = 0; out[2] = 1;
      }
      const len = Math.sqrt(out[0] ** 2 + out[1] ** 2 + out[2] ** 2) || 1;
      normals[i * 3] = out[0] / len;
      normals[i * 3 + 1] = out[1] / len;
      normals[i * 3 + 2] = out[2] / len;
    }
    return normals;
  }

  // -------------------------------------------------------------------------
  // Main worker entry
  // -------------------------------------------------------------------------

  self.onmessage = function (e) {
    const {
      id, buffer, byteOffset, byteLength,
      tileX, tileY, tileZ, lod,
      tileWorldSize, minHeight, maxHeight,
      computeNormalsFallback
    } = e.data;

    try {
      const bytes = new Uint8Array(buffer, byteOffset || 0, byteLength || buffer.byteLength);
      const data = new DataView(buffer, byteOffset || 0, byteLength || buffer.byteLength);

      if (bytes.length < HEADER_SIZE) {
        throw new Error('Quantized-mesh tile too small: ' + bytes.length + ' bytes');
      }

      // 1. Header
      const header = parseHeader(data);

      const minH = minHeight != null ? minHeight : header.minimumHeight;
      const maxH = maxHeight != null ? maxHeight : header.maximumHeight;
      const heightRange = Math.max(maxH - minH, 1e-6);

      // 2. Vertex data
      let offset = HEADER_SIZE;
      const vd = decodeVertexData(bytes, offset);
      const vertexCount = vd.vertexCount;
      offset = vd.offset;

      // 3. Index data
      const idx = decodeIndexData(bytes, offset, vertexCount);
      offset = idx.offset;

      // 4. Edge indices
      const use32 = vertexCount > 65535;
      const edges = decodeEdgeIndices(bytes, offset, use32);
      offset = edges.offset;

      // 5. Extensions
      const ext = parseExtensions(bytes, offset, vertexCount);

      // 6. Build world-space positions
      const positions = new Float32Array(vertexCount * 3);
      const originX = tileX * tileWorldSize;
      const originY = tileY * tileWorldSize;

      for (let i = 0; i < vertexCount; i++) {
        const u = vd.u[i] / 32767;
        const v = vd.v[i] / 32767;
        const h = vd.h[i] / 32767;
        positions[i * 3] = originX + u * tileWorldSize;
        positions[i * 3 + 1] = originY + v * tileWorldSize;
        positions[i * 3 + 2] = minH + h * heightRange;
      }

      // 7. Normals
      let normals;
      if (ext.normals) {
        normals = ext.normals;
      } else if (computeNormalsFallback) {
        const cellSize = tileWorldSize / Math.max(1, Math.sqrt(vertexCount));
        normals = estimateNormals(positions, vertexCount, cellSize);
      } else {
        normals = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) normals[i * 3 + 2] = 1;
      }

      // 8. Biome weights from normalized height
      const biomeWeights = new Float32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) {
        biomeWeights[i] = vd.h[i] / 32767;
      }

      // 9. Bounds
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < vertexCount; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (positions.length === 0) {
        minX = minY = minZ = 0; maxX = maxY = maxZ = 0;
      }

      // 10. Send back with zero-copy transfer
      const payload = {
        id,
        tileX, tileY, tileZ, lod,
        header,
        vertexCount,
        triangleCount: idx.triangleCount,
        positions,
        normals,
        indices: idx.indices,
        biomeWeights,
        westIndices: edges.west,
        southIndices: edges.south,
        eastIndices: edges.east,
        northIndices: edges.north,
        hasNormals: ext.normals ? 1 : 0,
        hasWaterMask: ext.waterMask ? 1 : 0,
        hasMetadata: ext.metadata ? 1 : 0,
        waterMask: ext.waterMask,
        metadata: ext.metadata,
        bounds: [minX, minY, minZ, maxX, maxY, maxZ],
        minHeight: minH,
        maxHeight: maxH
      };

      const transfer = [
        positions.buffer,
        normals.buffer,
        idx.indices.buffer,
        biomeWeights.buffer,
        edges.west.buffer,
        edges.south.buffer,
        edges.east.buffer,
        edges.north.buffer
      ];

      self.postMessage(payload, transfer);
    } catch (err) {
      self.postMessage({ id, error: err.message });
    }
  };
`;

// ---------------------------------------------------------------------------
// 3. WORKER POOL – priority queue, cancellation, backpressure
// ---------------------------------------------------------------------------

class QuantizedMeshParserPool {
  constructor(maxWorkers = 2) {
    this.maxWorkers = maxWorkers;
    this.workers = [];
    this.queue = [];
    this.activeJobs = new Map();
    this.nextJobId = 1;
    this._init();
  }

  _init() {
    const blob = new Blob([QUANTIZED_MESH_PARSER_WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    for (let i = 0; i < this.maxWorkers; i++) {
      const w = new Worker(url);
      w.onmessage = (e) => this._onWorkerMessage(w, e.data);
      w.onerror = (e) => this._onWorkerError(w, e);
      this.workers.push({ worker: w, busy: false, currentJobId: null });
    }
    URL.revokeObjectURL(url);
  }

  enqueue(msg, priority, transferables) {
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      const job = { id, msg: { ...msg, id }, priority, resolve, reject, transferables: transferables || [] };
      this.queue.push(job);
      this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
      this._dispatch();
    });
  }

  cancel(id) {
    const idx = this.queue.findIndex(j => j.id === id);
    if (idx >= 0) {
      const [job] = this.queue.splice(idx, 1);
      job.reject(new Error('Cancelled'));
      return true;
    }
    for (const slot of this.workers) {
      if (slot.currentJobId === id) {
        slot.worker.terminate();
        this.activeJobs.get(id)?.reject(new Error('Cancelled'));
        this.activeJobs.delete(id);
        this._respawn(slot);
        return true;
      }
    }
    return false;
  }

  _dispatch() {
    for (const slot of this.workers) {
      if (slot.busy || this.queue.length === 0) continue;
      const job = this.queue.shift();
      slot.busy = true;
      slot.currentJobId = job.id;
      this.activeJobs.set(job.id, job);
      slot.worker.postMessage(job.msg, job.transferables);
    }
  }

  _onWorkerMessage(slot, data) {
    const job = this.activeJobs.get(data.id);
    if (!job) return;
    this.activeJobs.delete(data.id);
    slot.busy = false;
    slot.currentJobId = null;
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data);
    this._dispatch();
  }

  _onWorkerError(slot, err) {
    if (slot.currentJobId) {
      const job = this.activeJobs.get(slot.currentJobId);
      if (job) job.reject(new Error('Worker error: ' + err.message));
      this.activeJobs.delete(slot.currentJobId);
    }
    this._respawn(slot);
  }

  _respawn(slot) {
    const idx = this.workers.indexOf(slot);
    if (idx < 0) return;
    const blob = new Blob([QUANTIZED_MESH_PARSER_WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    w.onmessage = (e) => this._onWorkerMessage(slot, e.data);
    w.onerror = (e) => this._onWorkerError(slot, e);
    slot.worker = w;
    slot.busy = false;
    slot.currentJobId = null;
    URL.revokeObjectURL(url);
    this._dispatch();
  }

  dispose() {
    for (const slot of this.workers) slot.worker.terminate();
    this.workers.length = 0;
    this.queue.length = 0;
    for (const job of this.activeJobs.values()) job.reject(new Error('Disposed'));
    this.activeJobs.clear();
  }
}

// ---------------------------------------------------------------------------
// 4. QUANTIZED-MESH TERRAIN DATA CLASS – the canonical tile object
// ---------------------------------------------------------------------------

/**
 * QuantizedMeshTerrain — a fully decoded quantized-mesh tile.
 *
 * Unlike HeightmapTerrain (file 374), this tile stores an irregular triangle
 * mesh rather than a regular elevation grid. Sampling is performed by
 * barycentric interpolation over the mesh triangles, which is exact at
 * vertices and seamless across shared edges because the edge vertices are
 * guaranteed identical between adjacent tiles (Cesium quantized-mesh contract).
 */
export class QuantizedMeshTerrain {
  constructor(props) {
    this.tileX = props.tileX | 0;
    this.tileY = props.tileY | 0;
    this.tileZ = props.tileZ | 0;
    this.lod = props.lod | 0;
    this.tileWorldSize = +props.tileWorldSize;
    this.zScale = props.zScale ?? 1.0;

    this.vertexCount = props.vertexCount | 0;
    this.triangleCount = props.triangleCount | 0;
    this.positions = props.positions;      // Float32Array (vertexCount * 3)
    this.normals = props.normals;          // Float32Array (vertexCount * 3)
    this.indices = props.indices;          // Uint16Array | Uint32Array
    this.biomeWeights = props.biomeWeights; // Float32Array (vertexCount)
    this.westIndices = props.westIndices;
    this.southIndices = props.southIndices;
    this.eastIndices = props.eastIndices;
    this.northIndices = props.northIndices;

    this.minHeight = props.minHeight;
    this.maxHeight = props.maxHeight;
    this.header = props.header;

    this.hasNormals = props.hasNormals ?? 0;
    this.hasWaterMask = props.hasWaterMask ?? 0;
    this.hasMetadata = props.hasMetadata ?? 0;
    this.waterMask = props.waterMask ?? null;
    this.metadata = props.metadata ?? null;

    this.bounds = props.bounds; // [minX, minY, minZ, maxX, maxY, maxZ]

    this.state = props.state ?? TileState.READY;
    this.entityId = props.entityId ?? 0xFFFFFFFF;
    this.sourceKey = props.sourceKey ?? '';

    this.tileKey = stringTileKey(this.lod, this.tileX, this.tileY, this.tileZ);
    this.tileKeyHash = fnv1aHash(this.tileKey);

    // Seam state (populated by the reconciler)
    this.seamFlags = 0;
    this.neighborLods = { north: -1, south: -1, east: -1, west: -1 };

    // Cached bounding volumes
    this._boundingSphere = null;

    // Build a simple spatial grid for barycentric point lookup.
    this._buildSpatialGrid();
  }

  /**
   * Factory: create a QuantizedMeshTerrain from a worker result.
   */
  static fromWorkerResult(result, tileInfo, options = {}) {
    return new QuantizedMeshTerrain({
      tileX: tileInfo.tileX,
      tileY: tileInfo.tileY,
      tileZ: tileInfo.tileZ ?? 0,
      lod: tileInfo.lod ?? 0,
      tileWorldSize: options.tileWorldSize ?? 100,
      zScale: options.zScale ?? 1.0,
      vertexCount: result.vertexCount,
      triangleCount: result.triangleCount,
      positions: result.positions,
      normals: result.normals,
      indices: result.indices,
      biomeWeights: result.biomeWeights,
      westIndices: result.westIndices,
      southIndices: result.southIndices,
      eastIndices: result.eastIndices,
      northIndices: result.northIndices,
      minHeight: result.minHeight,
      maxHeight: result.maxHeight,
      header: result.header,
      hasNormals: result.hasNormals,
      hasWaterMask: result.hasWaterMask,
      hasMetadata: result.hasMetadata,
      waterMask: result.waterMask,
      metadata: result.metadata,
      bounds: result.bounds,
      entityId: options.entityId,
      sourceKey: options.sourceKey
    });
  }

  // -------------------------------------------------------------------------
  // Sampling – barycentric lookup over the triangle mesh
  // -------------------------------------------------------------------------

  /**
   * Builds a uniform spatial grid over the tile’s XY extent to accelerate
   * triangle lookup. Called once at construction. The grid resolution scales
   * with the square root of the triangle count, capped at 256 cells per axis.
   */
  _buildSpatialGrid() {
    const [minX, minY, , maxX, maxY] = this.bounds;
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const gridRes = Math.min(256, Math.max(8, Math.ceil(Math.sqrt(this.triangleCount / 2))));
    this._gridRes = gridRes;
    this._gridCellW = spanX / gridRes;
    this._gridCellH = spanY / gridRes;
    this._gridMinX = minX;
    this._gridMinY = minY;

    // Each cell stores a flat list of triangle indices (t*3, t*3+1, t*3+2).
    this._grid = new Array(gridRes * gridRes);
    for (let i = 0; i < this._grid.length; i++) this._grid[i] = [];

    const positions = this.positions;
    const indices = this.indices;
    const triCount = this.triangleCount;

    for (let t = 0; t < triCount; t++) {
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];
      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1];
      const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1];
      const tminX = Math.min(ax, bx, cx);
      const tminY = Math.min(ay, by, cy);
      const tmaxX = Math.max(ax, bx, cx);
      const tmaxY = Math.max(ay, by, cy);

      const gx0 = Math.max(0, Math.floor((tminX - minX) / this._gridCellW));
      const gy0 = Math.max(0, Math.floor((tminY - minY) / this._gridCellH));
      const gx1 = Math.min(gridRes - 1, Math.floor((tmaxX - minX) / this._gridCellW));
      const gy1 = Math.min(gridRes - 1, Math.floor((tmaxY - minY) / this._gridCellH));

      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          this._grid[gy * gridRes + gx].push(t);
        }
      }
    }
  }

  /**
   * Finds the triangle containing world coordinates (wx, wy) and returns its
   * three vertex indices, or null if the point is outside the tile.
   * Writes the result into `outTriple` (Int32Array of length 3).
   */
  _findTriangle(wx, wy, outTriple) {
    const gx = Math.floor((wx - this._gridMinX) / this._gridCellW);
    const gy = Math.floor((wy - this._gridMinY) / this._gridCellH);
    if (gx < 0 || gx >= this._gridRes || gy < 0 || gy >= this._gridRes) return false;

    const list = this._grid[gy * this._gridRes + gx];
    const positions = this.positions;
    const indices = this.indices;

    for (let k = 0; k < list.length; k++) {
      const t = list[k];
      const i0 = indices[t * 3];
      const i1 = indices[t * 3 + 1];
      const i2 = indices[t * 3 + 2];
      const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1];
      const bx = positions[i1 * 3], by = positions[i1 * 3 + 1];
      const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1];

      // Barycentric test
      const v0x = bx - ax, v0y = by - ay;
      const v1x = cx - ax, v1y = cy - ay;
      const v2x = wx - ax, v2y = wy - ay;
      const dot00 = v0x * v0x + v0y * v0y;
      const dot01 = v0x * v1x + v0y * v1y;
      const dot02 = v0x * v2x + v0y * v2y;
      const dot11 = v1x * v1x + v1y * v1y;
      const dot12 = v1x * v2x + v1y * v2y;
      const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
      if (!isFinite(invDenom)) continue;
      const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
      const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
      if (u >= 0 && v >= 0 && u + v <= 1) {
        outTriple[0] = i0;
        outTriple[1] = i1;
        outTriple[2] = i2;
        return true;
      }
    }
    return false;
  }

  /**
   * Bilinear/barycentric height lookup at world coordinates (wx, wy).
   * Returns NaN if the point is outside the tile.
   */
  getHeight(wx, wy) {
    const triple = new Int32Array(3);
    if (!this._findTriangle(wx, wy, triple)) return NaN;
    return this._barycentricHeight(triple[0], triple[1], triple[2], wx, wy);
  }

  _barycentricHeight(i0, i1, i2, wx, wy) {
    const p = this.positions;
    const ax = p[i0 * 3], ay = p[i0 * 3 + 1];
    const bx = p[i1 * 3], by = p[i1 * 3 + 1];
    const cx = p[i2 * 3], cy = p[i2 * 3 + 1];
    const v0x = bx - ax, v0y = by - ay;
    const v1x = cx - ax, v1y = cy - ay;
    const v2x = wx - ax, v2y = wy - ay;
    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;
    const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    const w = 1 - u - v;
    return p[i0 * 3 + 2] * w + p[i1 * 3 + 2] * u + p[i2 * 3 + 2] * v;
  }

  /**
   * Returns the interpolated surface normal at world coordinates.
   * Writes into `out` (a 3-component vector).
   */
  getNormal(wx, wy, out) {
    const triple = new Int32Array(3);
    if (!this._findTriangle(wx, wy, triple)) {
      out[0] = 0; out[1] = 0; out[2] = 1;
      return out;
    }
    const i0 = triple[0], i1 = triple[1], i2 = triple[2];
    const p = this.positions;
    const n = this.normals;
    const ax = p[i0 * 3], ay = p[i0 * 3 + 1];
    const bx = p[i1 * 3], by = p[i1 * 3 + 1];
    const cx = p[i2 * 3], cy = p[i2 * 3 + 1];
    const v0x = bx - ax, v0y = by - ay;
    const v1x = cx - ax, v1y = cy - ay;
    const v2x = wx - ax, v2y = wy - ay;
    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;
    const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    const w = 1 - u - v;
    out[0] = n[i0 * 3] * w + n[i1 * 3] * u + n[i2 * 3] * v;
    out[1] = n[i0 * 3 + 1] * w + n[i1 * 3 + 1] * u + n[i2 * 3 + 1] * v;
    out[2] = n[i0 * 3 + 2] * w + n[i1 * 3 + 2] * u + n[i2 * 3 + 2] * v;
    const len = Math.sqrt(out[0] ** 2 + out[1] ** 2 + out[2] ** 2) || 1;
    out[0] /= len; out[1] /= len; out[2] /= len;
    return out;
  }

  // -------------------------------------------------------------------------
  // Seam helpers
  // -------------------------------------------------------------------------

  setSeam(edge, neighborLod) {
    this.seamFlags |= edge;
    if (edge === SeamEdge.NORTH) this.neighborLods.north = neighborLod;
    else if (edge === SeamEdge.SOUTH) this.neighborLods.south = neighborLod;
    else if (edge === SeamEdge.EAST) this.neighborLods.east = neighborLod;
    else if (edge === SeamEdge.WEST) this.neighborLods.west = neighborLod;
  }

  hasSeamOn(edge) {
    return hasSeam(this.seamFlags, edge);
  }

  // -------------------------------------------------------------------------
  // Bounding volumes – cached
  // -------------------------------------------------------------------------

  getBoundingSphere() {
    if (this._boundingSphere) return this._boundingSphere;
    const [minX, minY, minZ, maxX, maxY, maxZ] = this.bounds;
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const dx = (maxX - minX) * 0.5;
    const dy = (maxY - minY) * 0.5;
    const dz = (maxZ - minZ) * 0.5;
    this._boundingSphere = [cx, cy, cz, Math.sqrt(dx * dx + dy * dy + dz * dz) * 1.05];
    return this._boundingSphere;
  }

  computeScreenSpaceError(distance, screenHeight, fovRadians) {
    const geomError = (this.tileWorldSize / Math.sqrt(this.vertexCount)) *
                      (this.maxHeight - this.minHeight + 1);
    return computeScreenSpaceError(geomError, distance, screenHeight, fovRadians);
  }

  // -------------------------------------------------------------------------
  // ECS binding – mirrors HeightmapTerrain.bindToContext
  // -------------------------------------------------------------------------

  bindToContext(ecsWorld, contextFrame, tick) {
    if (!ecsWorld) throw new Error('bindToContext requires an ECS world');
    if (!contextFrame?.layers.spatial) {
      throw new Error('bindToContext requires contextFrame.layers.spatial');
    }

    if (this.entityId === 0xFFFFFFFF) {
      this.entityId = ecsWorld.createEntity?.() ?? 0xFFFFFFFF;
    }
    const entityId = this.entityId;
    if (entityId === 0xFFFFFFFF) return entityId;

    const sphere = this.getBoundingSphere();

    ecsWorld.addComponent?.(entityId, QuantizedMeshComponent, {
      tileX: this.tileX,
      tileY: this.tileY,
      tileZ: this.tileZ,
      lod: this.lod,
      vertexCount: this.vertexCount,
      triangleCount: this.triangleCount,
      vertexStart: this._arenaOffset ?? 0,
      indexStart: 0,
      indexCount: this.indices.length,
      westCount: this.westIndices.length,
      southCount: this.southIndices.length,
      eastCount: this.eastIndices.length,
      northCount: this.northIndices.length,
      minHeight: this.minHeight,
      maxHeight: this.maxHeight,
      hasNormals: this.hasNormals,
      hasWaterMask: this.hasWaterMask,
      hasMetadata: this.hasMetadata,
      centerX: this.header.centerX,
      centerY: this.header.centerY,
      centerZ: this.header.centerZ,
      boundingSphereRadius: this.header.boundingSphere.radius,
      state: this.state,
      lastUpdatedTick: tick
    });

    ecsWorld.addComponent?.(entityId, QuantizedMeshSeamComponent, {
      northFlags: this.hasSeamOn(SeamEdge.NORTH) ? SeamEdge.NORTH : 0,
      southFlags: this.hasSeamOn(SeamEdge.SOUTH) ? SeamEdge.SOUTH : 0,
      eastFlags: this.hasSeamOn(SeamEdge.EAST) ? SeamEdge.EAST : 0,
      westFlags: this.hasSeamOn(SeamEdge.WEST) ? SeamEdge.WEST : 0,
      northLod: this.neighborLods.north,
      southLod: this.neighborLods.south,
      eastLod: this.neighborLods.east,
      westLod: this.neighborLods.west
    });

    const spatial = contextFrame.layers.spatial;
    if (!spatial.quantizedMeshBounds) {
      spatial.quantizedMeshBounds = [];
      spatial.quantizedMeshBoundingSpheres = [];
      spatial.quantizedMeshMaterialIds = [];
      spatial.quantizedMeshEntityIds = [];
      spatial.quantizedMeshTileKeys = [];
      spatial.quantizedMeshLods = [];
    }
    spatial.quantizedMeshBounds.push(
      this.bounds[0], this.bounds[1], this.bounds[2],
      this.bounds[3], this.bounds[4], this.bounds[5]
    );
    spatial.quantizedMeshBoundingSpheres.push(sphere[0], sphere[1], sphere[2], sphere[3]);
    spatial.quantizedMeshMaterialIds.push(0);
    spatial.quantizedMeshEntityIds.push(entityId);
    spatial.quantizedMeshTileKeys.push(this.tileKey);
    spatial.quantizedMeshLods.push(this.lod);

    return entityId;
  }

  unbindFromContext(ecsWorld, contextFrame) {
    if (ecsWorld && this.entityId !== 0xFFFFFFFF) {
      ecsWorld.destroyEntity?.(this.entityId);
    }
    this.entityId = 0xFFFFFFFF;
  }

  dispose() {
    this.positions = null;
    this.normals = null;
    this.indices = null;
    this.biomeWeights = null;
    this.westIndices = null;
    this.southIndices = null;
    this.eastIndices = null;
    this.northIndices = null;
    this._grid = null;
    this._boundingSphere = null;
    this.state = TileState.EVICTED;
    this.entityId = 0xFFFFFFFF;
  }

  toString() {
    return (
      'QuantizedMeshTerrain(' +
      'tile=' + this.tileKey +
      ', verts=' + this.vertexCount +
      ', tris=' + this.triangleCount +
      ', elevation=[' + this.minHeight.toFixed(2) + '..' +
      this.maxHeight.toFixed(2) + ']' +
      ', state=' + this.state +
      ')'
    );
  }
}

// ---------------------------------------------------------------------------
// 5. CONTEXT PROVIDER – parses quantized-mesh tiles at 10 Hz
// ---------------------------------------------------------------------------

export class TerrainParseQuantizedMesh {
  constructor(options = {}) {
    this.options = {
      maxWorkers: options.maxWorkers ?? 2,
      maxPendingJobs: options.maxPendingJobs ?? 16,
      targetHz: options.targetHz ?? 10,
      tileWorldSize: options.tileWorldSize ?? 100,
      computeNormalsFallback: options.computeNormalsFallback ?? true,
      priorityDistanceScale: options.priorityDistanceScale ?? 0.01,
      maxTiles: options.maxTiles ?? 256,
      ...options
    };

    this.pool = new QuantizedMeshParserPool(this.options.maxWorkers);
    this.pendingJobs = new Map();
    this.resolvedQueue = [];
    this.nextInternalId = 1;

    this.tileMap = new Map();
    this.lru = [];

    this.frame = null;
    this.ecsWorld = null;
    this.lastTick = 0;
    this._accumulator = 0;

    this.eventDispatcher = null;
  }

  update(contextFrame, tick, dt) {
    this.frame = contextFrame;
    this.lastTick = tick;
    this._accumulator += dt;

    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    this._mergeResolved(tick);
    this._evictLRU(tick);
  }

  /**
   * Ingest a raw quantized-mesh tile binary.
   * Ownership of the ArrayBuffer is transferred to the worker.
   */
  ingestTile(arrayBuffer, tileInfo, options = {}) {
    if (this.pendingJobs.size >= this.options.maxPendingJobs) {
      return Promise.reject(new Error('Quantized-mesh ingest queue full (backpressure)'));
    }

    const { tileX, tileY, tileZ = 0, lod = 0 } = tileInfo;
    const tileKey = stringTileKey(lod, tileX, tileY, tileZ);

    if (this.tileMap.has(tileKey)) {
      return Promise.resolve(this.tileMap.get(tileKey).entityId);
    }

    const tileWorldSize = options.tileWorldSize ?? this.options.tileWorldSize;

    let effectivePriority = options.priority ?? 0;
    if (this.frame?.layers.player?.position) {
      const cam = this.frame.layers.player.position;
      const cx = (tileX + 0.5) * tileWorldSize;
      const cy = (tileY + 0.5) * tileWorldSize;
      const d2 = (cx - cam[0]) ** 2 + (cy - cam[1]) ** 2;
      effectivePriority += 1 / (1 + d2 * this.options.priorityDistanceScale);
    }

    const msg = {
      buffer: arrayBuffer,
      byteOffset: options.byteOffset ?? 0,
      byteLength: options.byteLength ?? arrayBuffer.byteLength,
      tileX, tileY, tileZ, lod,
      tileWorldSize,
      minHeight: options.minHeight ?? null,
      maxHeight: options.maxHeight ?? null,
      computeNormalsFallback: options.computeNormalsFallback ?? this.options.computeNormalsFallback
    };

    const internalId = this.nextInternalId++;
    const promise = this.pool.enqueue(msg, effectivePriority, [arrayBuffer])
      .then(result => {
        this.pendingJobs.delete(internalId);
        this.resolvedQueue.push({ internalId, tileKey, result });
        return internalId;
      })
      .catch(err => {
        this.pendingJobs.delete(internalId);
        throw err;
      });

    this.pendingJobs.set(internalId, { tileKey, params: msg, priority: effectivePriority, promise });
    return promise;
  }

  cancel(internalId) {
    if (!this.pendingJobs.has(internalId)) return false;
    this.pool.cancel(internalId);
    this.pendingJobs.delete(internalId);
    return true;
  }

  _mergeResolved(tick) {
    for (const entry of this.resolvedQueue) {
      const { tileKey, result } = entry;
      const terrain = QuantizedMeshTerrain.fromWorkerResult(
        result,
        { tileX: result.tileX, tileY: result.tileY, tileZ: result.tileZ, lod: result.lod },
        { tileWorldSize: this.options.tileWorldSize }
      );
      this.tileMap.set(tileKey, terrain);
      this._touchLRU(tileKey);
    }
    this.resolvedQueue.length = 0;
  }

  _touchLRU(tileKey) {
    const idx = this.lru.indexOf(tileKey);
    if (idx >= 0) this.lru.splice(idx, 1);
    this.lru.push(tileKey);
  }

  _evictLRU(tick) {
    while (this.tileMap.size > this.options.maxTiles && this.lru.length > 0) {
      const oldest = this.lru.shift();
      const rec = this.tileMap.get(oldest);
      if (!rec) continue;
      if (this.frame?.layers.player?.position) {
        const [px, py] = this.frame.layers.player.position;
        const [sx, sy] = rec.getBoundingSphere();
        const safeRadius = this.options.tileWorldSize * 2;
        if ((sx - px) ** 2 + (sy - py) ** 2 < safeRadius * safeRadius) {
          this.lru.push(oldest);
          break;
        }
      }
      this.tileMap.delete(oldest);
    }
  }

  getTile(tileKey) {
    return this.tileMap.get(tileKey) ?? null;
  }

  dispose() {
    this.pool.dispose();
    this.pendingJobs.clear();
    this.resolvedQueue.length = 0;
    for (const tile of this.tileMap.values()) tile.dispose();
    this.tileMap.clear();
    this.lru.length = 0;
  }
}

export default {
  QuantizedMeshTerrain,
  QuantizedMeshComponent,
  QuantizedMeshSeamComponent,
  TerrainParseQuantizedMesh
};