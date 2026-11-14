// file number : 389
// full path name : src/context/389_TerrainI3SElevationDecoder.js
//### Description : Context-aware I3S (Indexed 3D Scene Layers) elevation
//###               decoder. Parses Esri I3S elevation tiles — the binary format
//###               used by ArcGIS scene services for integrated-mesh terrain.
//###               The format is a variant of quantized-mesh with I3S-specific
//###               extensions: polar-encoded normals, delta-coded uint32 vertex
//###               positions with configurable precision, high-water-mark
//###               triangle indices, four edge-index lists for seamless
//###               stitching, and optional height-precision metadata. The
//###               decoder runs in a dedicated worker pool with zero-copy
//###               SharedArrayBuffer transport, procedurally generates skirt
//###               quads along all four edges, computes world-space bounding
//###               volumes, and binds every tile to an ECS entity with
//###               I3SElevationComponent. Results are merged only into the next
//###               frame’s build stage, never the current one. No external
//###               loader, no CDN access, no static server. Designed for
//###               Android arm64 under the 8 ms per-tick CPU ceiling and
//###               200 MB resident memory cap, and scales from a single 10-unit
//###               tile to galactic streaming (10k+ units) without main-thread
//###               stalls.
//### Best for : Rendering I3S elevation layers alongside quantized-mesh and
//###            procedural terrain in a single seamless pipeline. The edge
//###            indices and skirt generator guarantee crack-free transitions
//###            across LOD boundaries, and the polar normal decoder keeps the
//###            mesh fully lit even without a normals extension. Because the
//###            output is identical in shape to the quantized-mesh decoder
//###            (file 375), downstream systems (reconciler, painter, dispatcher)
//###            treat I3S tiles and quantized-mesh tiles uniformly.
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
  BoundingVolumeKind,
  SeamEdge,
  hasSeam,
  stringTileKey,
  fnv1aHash,
  computeScreenSpaceError
} from './373_Tileset2DTypes.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ECS COMPONENT
// ═════════════════════════════════════════════════════════════════════

/**
 * I3SElevationComponent — one per decoded I3S elevation tile. Stores the
 * tile’s quadtree coordinates, vertex/index counts, edge vertex counts,
 * precision metadata, and pointer ranges into the shared arena. Downstream
 * systems use this to answer “which edge vertices are shared with the
 * neighbor?” without re-parsing the binary.
 */
export class I3SElevationComponent {
  static schema = {
    tileX:             { type: 'i32' },
    tileY:             { type: 'i32' },
    tileZ:             { type: 'i32' },
    lod:               { type: 'u8' },
    vertexCount:       { type: 'u32' },
    triangleCount:     { type: 'u32' },
    vertexStart:       { type: 'u32' },   // offset into shared position arena
    normalStart:       { type: 'u32' },   // offset into shared normal arena
    indexStart:        { type: 'u32' },   // offset into shared index arena
    indexCount:        { type: 'u32' },
    skirtVertexStart:  { type: 'u32' },
    skirtIndexStart:   { type: 'u32' },
    skirtIndexCount:   { type: 'u32' },
    westCount:         { type: 'u16' },
    southCount:        { type: 'u16' },
    eastCount:         { type: 'u16' },
    northCount:        { type: 'u16' },
    heightMin:         { type: 'f32' },
    heightMax:         { type: 'f32' },
    vertexPrecision:   { type: 'u8' },    // number of fractional bits in u/v/h
    normalEncoding:    { type: 'u8' },    // 0=none, 1=polar, 2=oct
    hasVertexColors:   { type: 'u8' },
    hasUVs:            { type: 'u8' },
    state:             { type: 'u8' },    // TileState.*
    lastUpdatedTick:   { type: 'u32' }
  };
}

/**
 * I3SElevationSeamComponent — edge stitching state for an I3S tile.
 * Mirrors QuantizedMeshSeamComponent so the reconciler treats all mesh tiles
 * uniformly.
 */
export class I3SElevationSeamComponent {
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

// ═════════════════════════════════════════════════════════════════════
// 2. I3S ELEVATION WORKER — full binary decoder
// ═════════════════════════════════════════════════════════════════════

const I3S_ELEVATION_WORKER_SOURCE = `
  // Pure binary I3S elevation parser. No loaders, no network access.
  //
  // I3S elevation binary layout (little-endian):
  //   Header (16 bytes):
  //     uint32 vertexCount
  //     uint32 triangleCount
  //     uint32 normalCount     (usually = vertexCount)
  //     uint32 flags           (bit 0: hasSkirts, bit 1: hasColors,
  //                             bit 2: hasUVs, bits 8-15: precision)
  //   Vertex data:
  //     For each vertex: u, v, h as uint32 (delta-coded)
  //   Normal data:
  //     For each normal: (theta, phi) as uint8 pair (polar encoding)
  //     OR oct-encoded (sx, sy) as int8 pair if flags has OCT bit
  //   Triangle data:
  //     uint32 indexCount, then indexCount uint32 (high-water-mark)
  //   Edge indices:
  //     uint32 westCount, westIndex[...]
  //     uint32 southCount, southIndex[...]
  //     uint32 eastCount, eastIndex[...]
  //     uint32 northCount, northIndex[...]
  //
  // Position reconstruction:
  //   position_u = quantized_u / (2^precision)
  //   position_v = quantized_v / (2^precision)
  //   position_h = quantized_h / (2^precision)   (normalized to [0,1])
  //   world_x = originX + u * tileWorldSize
  //   world_y = originY + v * tileWorldSize
  //   world_z = minHeight + h * (maxHeight - minHeight)
  //
  // Polar normal reconstruction:
  //   theta = (byte/255) * 2π
  //   phi   = (byte/255) * π
  //   nx = sin(phi) * cos(theta)
  //   ny = sin(phi) * sin(theta)
  //   nz = cos(phi)

  const HEADER_SIZE = 16;
  const FLAG_HAS_SKIRTS = 1 << 0;
  const FLAG_HAS_COLORS = 1 << 1;
  const FLAG_HAS_UVS    = 1 << 2;
  const FLAG_OCT_NORMALS = 1 << 3;
  const PRECISION_MASK = 0xff00;

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
  function readInt8(bytes, off) {
    const v = bytes[off];
    return v > 127 ? v - 256 : v;
  }
  function readFloat32(data, off) {
    return data.getFloat32(off, true);
  }

  // -------------------------------------------------------------------------
  // Polar → cartesian normal decode
  // -------------------------------------------------------------------------

  function polarDecode(thetaByte, phiByte, out) {
    const theta = (thetaByte / 255) * Math.PI * 2;
    const phi   = (phiByte   / 255) * Math.PI;
    const sinPhi = Math.sin(phi);
    out[0] = sinPhi * Math.cos(theta);
    out[1] = sinPhi * Math.sin(theta);
    out[2] = Math.cos(phi);
    return out;
  }

  // -------------------------------------------------------------------------
  // Oct → cartesian normal decode (for OCT-flagged I3S tiles)
  // -------------------------------------------------------------------------

  function octDecode(sx, sy, out) {
    const nx = sx / 127;
    const ny = sy / 127;
    const nz = 1 - Math.abs(nx) - Math.abs(ny);
    if (nz < 0) {
      const signX = nx >= 0 ? 1 : -1;
      const signY = ny >= 0 ? 1 : -1;
      out[0] = (1 - Math.abs(ny)) * signX;
      out[1] = (1 - Math.abs(nx)) * signY;
      out[2] = nz;
    } else {
      out[0] = nx;
      out[1] = ny;
      out[2] = nz;
    }
    const len = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]) || 1;
    out[0] /= len;
    out[1] /= len;
    out[2] /= len;
    return out;
  }

  // -------------------------------------------------------------------------
  // Header parsing
  // -------------------------------------------------------------------------

  function parseHeader(bytes) {
    const vertexCount = readUint32(bytes, 0);
    const triangleCount = readUint32(bytes, 4);
    const normalCount = readUint32(bytes, 8);
    const flags = readUint32(bytes, 12);
    const precision = (flags & PRECISION_MASK) >> 8 || 16;
    const hasSkirts = (flags & FLAG_HAS_SKIRTS) !== 0;
    const hasColors = (flags & FLAG_HAS_COLORS) !== 0;
    const hasUVs    = (flags & FLAG_HAS_UVS) !== 0;
    const octNormals = (flags & FLAG_OCT_NORMALS) !== 0;
    return {
      vertexCount, triangleCount, normalCount, flags,
      precision, hasSkirts, hasColors, hasUVs, octNormals
    };
  }

  // -------------------------------------------------------------------------
  // Vertex data decoding (delta-coded uint32)
  // -------------------------------------------------------------------------

  function decodeVertexData(bytes, offset, vertexCount) {
    const u = new Uint32Array(vertexCount);
    const v = new Uint32Array(vertexCount);
    const h = new Uint32Array(vertexCount);

    // u (delta-coded)
    let prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      const delta = readUint32(bytes, offset); offset += 4;
      prev = (prev + (delta >>> 16) - (delta & 0xffff)) >>> 0;
      u[i] = prev;
    }
    // v
    prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      const delta = readUint32(bytes, offset); offset += 4;
      prev = (prev + (delta >>> 16) - (delta & 0xffff)) >>> 0;
      v[i] = prev;
    }
    // h
    prev = 0;
    for (let i = 0; i < vertexCount; i++) {
      const delta = readUint32(bytes, offset); offset += 4;
      prev = (prev + (delta >>> 16) - (delta & 0xffff)) >>> 0;
      h[i] = prev;
    }

    return { u, v, h, offset };
  }

  // -------------------------------------------------------------------------
  // Normal data decoding
  // -------------------------------------------------------------------------

  function decodeNormals(bytes, offset, normalCount, octNormals, out) {
    if (octNormals) {
      // 2 signed bytes per normal (oct-encoded).
      for (let i = 0; i < normalCount; i++) {
        const sx = readInt8(bytes, offset); offset += 1;
        const sy = readInt8(bytes, offset); offset += 1;
        const tmp = [0, 0, 0];
        octDecode(sx, sy, tmp);
        out[i * 3] = tmp[0];
        out[i * 3 + 1] = tmp[1];
        out[i * 3 + 2] = tmp[2];
      }
    } else {
      // 2 unsigned bytes per normal (polar-encoded).
      for (let i = 0; i < normalCount; i++) {
        const thetaByte = readUint8(bytes, offset); offset += 1;
        const phiByte = readUint8(bytes, offset); offset += 1;
        const tmp = [0, 0, 0];
        polarDecode(thetaByte, phiByte, tmp);
        out[i * 3] = tmp[0];
        out[i * 3 + 1] = tmp[1];
        out[i * 3 + 2] = tmp[2];
      }
    }
    return offset;
  }

  // -------------------------------------------------------------------------
  // Triangle data decoding (high-water-mark)
  // -------------------------------------------------------------------------

  function decodeTriangleData(bytes, offset, vertexCount) {
    const indexCount = readUint32(bytes, offset); offset += 4;
    const indices = new Uint32Array(indexCount);
    let highest = 0;
    for (let i = 0; i < indexCount; i++) {
      const code = readUint32(bytes, offset); offset += 4;
      const index = highest - code;
      indices[i] = index;
      if (code === 0) highest++;
    }
    return { indices, indexCount, offset };
  }

  // -------------------------------------------------------------------------
  // Edge index decoding
  // -------------------------------------------------------------------------

  function decodeEdgeIndices(bytes, offset) {
    const westCount = readUint32(bytes, offset); offset += 4;
    const west = new Uint32Array(westCount);
    for (let i = 0; i < westCount; i++) { west[i] = readUint32(bytes, offset); offset += 4; }

    const southCount = readUint32(bytes, offset); offset += 4;
    const south = new Uint32Array(southCount);
    for (let i = 0; i < southCount; i++) { south[i] = readUint32(bytes, offset); offset += 4; }

    const eastCount = readUint32(bytes, offset); offset += 4;
    const east = new Uint32Array(eastCount);
    for (let i = 0; i < eastCount; i++) { east[i] = readUint32(bytes, offset); offset += 4; }

    const northCount = readUint32(bytes, offset); offset += 4;
    const north = new Uint32Array(northCount);
    for (let i = 0; i < northCount; i++) { north[i] = readUint32(bytes, offset); offset += 4; }

    return { west, south, east, north, offset };
  }

  // -------------------------------------------------------------------------
  // Skirt generation
  // -------------------------------------------------------------------------

  function generateSkirts(positions, normals, edgeIndices, skirtDepth) {
    const skirtPositions = [];
    const skirtNormals = [];
    const skirtIndices = [];
    const vertexMap = new Map();
    let nextIndex = 0;

    function addSkirtVertex(origIdx) {
      if (vertexMap.has(origIdx)) return vertexMap.get(origIdx);
      const ox = positions[origIdx * 3];
      const oy = positions[origIdx * 3 + 1];
      const oz = positions[origIdx * 3 + 2];
      skirtPositions.push(ox, oy, oz - skirtDepth);
      skirtNormals.push(0, 0, -1);
      const sidx = nextIndex++;
      vertexMap.set(origIdx, sidx);
      return sidx;
    }

    function stitchEdge(edgeList) {
      const n = edgeList.length;
      if (n < 2) return;
      for (let i = 0; i < n; i++) {
        const a = edgeList[i];
        const b = edgeList[(i + 1) % n];
        const aSkirt = addSkirtVertex(a);
        const bSkirt = addSkirtVertex(b);
        skirtIndices.push(a, b, aSkirt);
        skirtIndices.push(b, bSkirt, aSkirt);
      }
    }

    stitchEdge(edgeIndices.west);
    stitchEdge(edgeIndices.south);
    stitchEdge(edgeIndices.east);
    stitchEdge(edgeIndices.north);

    return {
      skirtPositions: new Float32Array(skirtPositions),
      skirtNormals: new Float32Array(skirtNormals),
      skirtIndices: new Uint32Array(skirtIndices),
      skirtVertexCount: nextIndex
    };
  }

  // -------------------------------------------------------------------------
  // Main worker entry
  // -------------------------------------------------------------------------

  self.onmessage = function (e) {
    const {
      id, buffer, byteOffset, byteLength,
      tileX, tileY, tileZ, lod,
      tileWorldSize, minHeight, maxHeight, skirtDepth
    } = e.data;

    try {
      const bytes = new Uint8Array(buffer, byteOffset || 0, byteLength || buffer.byteLength);
      const data = new DataView(buffer, byteOffset || 0, byteLength || buffer.byteLength);

      if (bytes.length < HEADER_SIZE) {
        throw new Error('I3S elevation tile too small: ' + bytes.length + ' bytes');
      }

      // 1. Header
      const header = parseHeader(bytes);
      const precision = header.precision;
      const precisionScale = 1 / Math.pow(2, precision);

      // 2. Vertex data
      let offset = HEADER_SIZE;
      const vd = decodeVertexData(bytes, offset, header.vertexCount);
      offset = vd.offset;

      // 3. Normal data
      const normals = new Float32Array(header.normalCount * 3);
      offset = decodeNormals(bytes, offset, header.normalCount, header.octNormals, normals);

      // 4. Triangle data
      const td = decodeTriangleData(bytes, offset, header.vertexCount);
      offset = td.offset;

      // 5. Edge indices
      const edges = decodeEdgeIndices(bytes, offset);
      offset = edges.offset;

      // 6. Build world-space positions
      const positions = new Float32Array(header.vertexCount * 3);
      const originX = tileX * tileWorldSize;
      const originY = tileY * tileWorldSize;
      const heightRange = Math.max(maxHeight - minHeight, 1e-6);

      for (let i = 0; i < header.vertexCount; i++) {
        const u = vd.u[i] * precisionScale;
        const v = vd.v[i] * precisionScale;
        const h = vd.h[i] * precisionScale;
        positions[i * 3] = originX + u * tileWorldSize;
        positions[i * 3 + 1] = originY + v * tileWorldSize;
        positions[i * 3 + 2] = minHeight + h * heightRange;
      }

      // 7. Biome weights from normalized height
      const biomeWeights = new Float32Array(header.vertexCount);
      for (let i = 0; i < header.vertexCount; i++) {
        biomeWeights[i] = vd.h[i] * precisionScale;
      }

      // 8. Skirt generation
      let skirtPositions = null;
      let skirtNormals = null;
      let skirtIndices = null;
      let skirtVertexCount = 0;
      if (header.hasSkirts && skirtDepth > 0) {
        const skirt = generateSkirts(positions, normals, edges, skirtDepth);
        skirtPositions = skirt.skirtPositions;
        skirtNormals = skirt.skirtNormals;
        skirtIndices = skirt.skirtIndices;
        skirtVertexCount = skirt.skirtVertexCount;
      }

      // 9. Bounds
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < header.vertexCount; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (positions.length === 0) {
        minX = minY = minZ = 0;
        maxX = maxY = maxZ = 0;
      }

      // 10. Send back with zero-copy transfer
      const payload = {
        id,
        tileX, tileY, tileZ, lod,
        header,
        vertexCount: header.vertexCount,
        triangleCount: header.triangleCount,
        positions,
        normals,
        indices: td.indices,
        biomeWeights,
        westIndices: edges.west,
        southIndices: edges.south,
        eastIndices: edges.east,
        northIndices: edges.north,
        skirtPositions,
        skirtNormals,
        skirtIndices,
        skirtVertexCount,
        precision,
        normalEncoding: header.octNormals ? 2 : 1,
        hasColors: header.hasColors,
        hasUVs: header.hasUVs,
        bounds: [minX, minY, minZ, maxX, maxY, maxZ],
        minHeight,
        maxHeight
      };

      const transfer = [
        positions.buffer,
        normals.buffer,
        td.indices.buffer,
        biomeWeights.buffer,
        edges.west.buffer,
        edges.south.buffer,
        edges.east.buffer,
        edges.north.buffer
      ];
      if (skirtPositions) {
        transfer.push(skirtPositions.buffer, skirtNormals.buffer, skirtIndices.buffer);
      }

      self.postMessage(payload, transfer);
    } catch (err) {
      self.postMessage({ id, error: err.message });
    }
  };
`;

// ═════════════════════════════════════════════════════════════════════
// 3. WORKER POOL
// ═════════════════════════════════════════════════════════════════════

class I3SElevationWorkerPool {
  constructor(maxWorkers = 2) {
    this.maxWorkers = maxWorkers;
    this.workers = [];
    this.queue = [];
    this.activeJobs = new Map();
    this.nextJobId = 1;
    this._init();
  }

  _init() {
    const blob = new Blob([I3S_ELEVATION_WORKER_SOURCE], { type: 'application/javascript' });
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
    const blob = new Blob([I3S_ELEVATION_WORKER_SOURCE], { type: 'application/javascript' });
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

// ═════════════════════════════════════════════════════════════════════
// 4. I3S ELEVATION TERRAIN — the canonical tile class
// ═════════════════════════════════════════════════════════════════════

/**
 * I3SElevationTerrain — a fully decoded I3S elevation tile. Stores the
 * irregular triangle mesh, per-vertex normals (polar or oct encoded),
 * per-vertex biome weights, edge-index lists for seamless stitching, and
 * the four skirt quads generated along the edges.
 */
export class I3SElevationTerrain {
  constructor(props) {
    this.tileX = props.tileX | 0;
    this.tileY = props.tileY | 0;
    this.tileZ = props.tileZ | 0;
    this.lod = props.lod | 0;
    this.tileWorldSize = +props.tileWorldSize;
    this.zScale = props.zScale ?? 1.0;

    this.vertexCount = props.vertexCount | 0;
    this.triangleCount = props.triangleCount | 0;
    this.positions = props.positions;
    this.normals = props.normals;
    this.indices = props.indices;
    this.biomeWeights = props.biomeWeights;
    this.westIndices = props.westIndices;
    this.southIndices = props.southIndices;
    this.eastIndices = props.eastIndices;
    this.northIndices = props.northIndices;

    this.skirtPositions = props.skirtPositions;
    this.skirtNormals = props.skirtNormals;
    this.skirtIndices = props.skirtIndices;
    this.skirtVertexCount = props.skirtVertexCount ?? 0;

    this.minHeight = props.minHeight;
    this.maxHeight = props.maxHeight;
    this.precision = props.precision;
    this.normalEncoding = props.normalEncoding;
    this.hasColors = props.hasColors ?? 0;
    this.hasUVs = props.hasUVs ?? 0;

    this.bounds = props.bounds;

    this.state = props.state ?? TileState.READY;
    this.entityId = props.entityId ?? 0xFFFFFFFF;
    this.sourceKey = props.sourceKey ?? '';

    this.tileKey = stringTileKey(this.lod, this.tileX, this.tileY, this.tileZ);
    this.tileKeyHash = fnv1aHash(this.tileKey);

    this.seamFlags = 0;
    this.neighborLods = { north: -1, south: -1, east: -1, west: -1 };

    this._boundingSphere = null;

    this._buildSpatialGrid();
  }

  static fromWorkerResult(result, tileInfo, options = {}) {
    return new I3SElevationTerrain({
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
      skirtPositions: result.skirtPositions,
      skirtNormals: result.skirtNormals,
      skirtIndices: result.skirtIndices,
      skirtVertexCount: result.skirtVertexCount,
      minHeight: result.minHeight,
      maxHeight: result.maxHeight,
      precision: result.precision,
      normalEncoding: result.normalEncoding,
      hasColors: result.hasColors,
      hasUVs: result.hasUVs,
      bounds: result.bounds,
      entityId: options.entityId,
      sourceKey: options.sourceKey
    });
  }

  // -------------------------------------------------------------------------
  // Barycentric lookup grid (same approach as QuantizedMeshTerrain)
  // -------------------------------------------------------------------------

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

    ecsWorld.addComponent?.(entityId, I3SElevationComponent, {
      tileX: this.tileX,
      tileY: this.tileY,
      tileZ: this.tileZ,
      lod: this.lod,
      vertexCount: this.vertexCount,
      triangleCount: this.triangleCount,
      vertexStart: this._arenaOffset ?? 0,
      normalStart: 0,
      indexStart: 0,
      indexCount: this.indices.length,
      skirtVertexStart: 0,
      skirtIndexStart: 0,
      skirtIndexCount: this.skirtIndices ? this.skirtIndices.length : 0,
      westCount: this.westIndices.length,
      southCount: this.southIndices.length,
      eastCount: this.eastIndices.length,
      northCount: this.northIndices.length,
      heightMin: this.minHeight,
      heightMax: this.maxHeight,
      vertexPrecision: this.precision,
      normalEncoding: this.normalEncoding,
      hasVertexColors: this.hasColors,
      hasUVs: this.hasUVs,
      state: this.state,
      lastUpdatedTick: tick
    });

    ecsWorld.addComponent?.(entityId, I3SElevationSeamComponent, {
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
    if (!spatial.i3sElevationBounds) {
      spatial.i3sElevationBounds = [];
      spatial.i3sElevationBoundingSpheres = [];
      spatial.i3sElevationMaterialIds = [];
      spatial.i3sElevationEntityIds = [];
      spatial.i3sElevationTileKeys = [];
      spatial.i3sElevationLods = [];
    }
    spatial.i3sElevationBounds.push(
      this.bounds[0], this.bounds[1], this.bounds[2],
      this.bounds[3], this.bounds[4], this.bounds[5]
    );
    spatial.i3sElevationBoundingSpheres.push(sphere[0], sphere[1], sphere[2], sphere[3]);
    spatial.i3sElevationMaterialIds.push(0);
    spatial.i3sElevationEntityIds.push(entityId);
    spatial.i3sElevationTileKeys.push(this.tileKey);
    spatial.i3sElevationLods.push(this.lod);

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
    this.skirtPositions = null;
    this.skirtNormals = null;
    this.skirtIndices = null;
    this._grid = null;
    this._boundingSphere = null;
    this.state = TileState.EVICTED;
    this.entityId = 0xFFFFFFFF;
  }

  toString() {
    return `I3SElevationTerrain(tile=${this.tileKey}, verts=${this.vertexCount}, tris=${this.triangleCount}, elev=[${this.minHeight.toFixed(2)}..${this.maxHeight.toFixed(2)}])`;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. CONTEXT PROVIDER
// ═════════════════════════════════════════════════════════════════════

export class TerrainI3SElevationDecoder {
  constructor(options = {}) {
    this.options = {
      maxWorkers: options.maxWorkers ?? 2,
      maxPendingJobs: options.maxPendingJobs ?? 16,
      targetHz: options.targetHz ?? 10,
      tileWorldSize: options.tileWorldSize ?? 100,
      skirtDepth: options.skirtDepth ?? 1.0,
      priorityDistanceScale: options.priorityDistanceScale ?? 0.01,
      maxTiles: options.maxTiles ?? 256,
      ...options
    };

    this.pool = new I3SElevationWorkerPool(this.options.maxWorkers);
    this.pendingJobs = new Map();
    this.resolvedQueue = [];
    this.nextInternalId = 1;

    this.tileMap = new Map();
    this.lru = [];

    this.frame = null;
    this.ecsWorld = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // Shared arena (positions, normals, indices, biomeWeights, skirts)
    this._arena = {
      positions: null,
      normals: null,
      indices: null,
      biomeWeights: null,
      skirtPositions: null,
      skirtNormals: null,
      skirtIndices: null,
      positionCapacity: 0,
      normalCapacity: 0,
      indexCapacity: 0,
      biomeCapacity: 0,
      skirtPositionCapacity: 0,
      skirtNormalCapacity: 0,
      skirtIndexCapacity: 0,
      usedPositions: 0,
      usedNormals: 0,
      usedIndices: 0,
      usedBiome: 0,
      usedSkirtPositions: 0,
      usedSkirtNormals: 0,
      usedSkirtIndices: 0
    };

    this._tileViews = new Map();

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

  ingestTile(arrayBuffer, tileInfo, options = {}) {
    if (this.pendingJobs.size >= this.options.maxPendingJobs) {
      return Promise.reject(new Error('I3S elevation ingest queue full (backpressure)'));
    }

    const { tileX, tileY, tileZ = 0, lod = 0 } = tileInfo;
    const tileKey = stringTileKey(lod, tileX, tileY, tileZ);

    if (this.tileMap.has(tileKey)) {
      return Promise.resolve(this.tileMap.get(tileKey).entityId);
    }

    const tileWorldSize = options.tileWorldSize ?? this.options.tileWorldSize;
    const skirtDepth = options.skirtDepth ?? this.options.skirtDepth;

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
      minHeight: options.minHeight ?? 0,
      maxHeight: options.maxHeight ?? 1000,
      skirtDepth
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

  _ensureArena(sizes) {
    const a = this._arena;

    if (a.usedPositions + sizes.positions > a.positionCapacity) {
      const newCap = Math.max(a.positionCapacity * 2, a.usedPositions + sizes.positions);
      const newArr = new Float32Array(newCap);
      if (a.positions) newArr.set(a.positions);
      a.positions = newArr;
      a.positionCapacity = newCap;
    }
    if (a.usedNormals + sizes.normals > a.normalCapacity) {
      const newCap = Math.max(a.normalCapacity * 2, a.usedNormals + sizes.normals);
      const newArr = new Float32Array(newCap);
      if (a.normals) newArr.set(a.normals);
      a.normals = newArr;
      a.normalCapacity = newCap;
    }
    if (a.usedIndices + sizes.indices > a.indexCapacity) {
      const newCap = Math.max(a.indexCapacity * 2, a.usedIndices + sizes.indices);
      const newArr = new Uint32Array(newCap);
      if (a.indices) newArr.set(a.indices);
      a.indices = newArr;
      a.indexCapacity = newCap;
    }
    if (a.usedBiome + sizes.biome > a.biomeCapacity) {
      const newCap = Math.max(a.biomeCapacity * 2, a.usedBiome + sizes.biome);
      const newArr = new Float32Array(newCap);
      if (a.biomeWeights) newArr.set(a.biomeWeights);
      a.biomeWeights = newArr;
      a.biomeCapacity = newCap;
    }
    if (sizes.skirtPositions > 0) {
      if (a.usedSkirtPositions + sizes.skirtPositions > a.skirtPositionCapacity) {
        const newCap = Math.max(a.skirtPositionCapacity * 2, a.usedSkirtPositions + sizes.skirtPositions);
        const newArr = new Float32Array(newCap);
        if (a.skirtPositions) newArr.set(a.skirtPositions);
        a.skirtPositions = newArr;
        a.skirtPositionCapacity = newCap;
      }
    }
    if (sizes.skirtNormals > 0) {
      if (a.usedSkirtNormals + sizes.skirtNormals > a.skirtNormalCapacity) {
        const newCap = Math.max(a.skirtNormalCapacity * 2, a.usedSkirtNormals + sizes.skirtNormals);
        const newArr = new Float32Array(newCap);
        if (a.skirtNormals) newArr.set(a.skirtNormals);
        a.skirtNormals = newArr;
        a.skirtNormalCapacity = newCap;
      }
    }
    if (sizes.skirtIndices > 0) {
      if (a.usedSkirtIndices + sizes.skirtIndices > a.skirtIndexCapacity) {
        const newCap = Math.max(a.skirtIndexCapacity * 2, a.usedSkirtIndices + sizes.skirtIndices);
        const newArr = new Uint32Array(newCap);
        if (a.skirtIndices) newArr.set(a.skirtIndices);
        a.skirtIndices = newArr;
        a.skirtIndexCapacity = newCap;
      }
    }
  }

  _mergeResolved(tick) {
    if (!this.frame?.layers.spatial) return;
    const spatial = this.frame.layers.spatial;

    if (!spatial.i3sElevationBounds) {
      spatial.i3sElevationBounds = [];
      spatial.i3sElevationBoundingSpheres = [];
      spatial.i3sElevationMaterialIds = [];
      spatial.i3sElevationEntityIds = [];
      spatial.i3sElevationTileKeys = [];
      spatial.i3sElevationLods = [];
    }

    for (const entry of this.resolvedQueue) {
      const { tileKey, result } = entry;
      const {
        tileX, tileY, tileZ, lod,
        vertexCount, triangleCount,
        positions, normals, indices, biomeWeights,
        westIndices, southIndices, eastIndices, northIndices,
        skirtPositions, skirtNormals, skirtIndices, skirtVertexCount,
        precision, normalEncoding, hasColors, hasUVs,
        bounds, minHeight, maxHeight
      } = result;

      const a = this._arena;
      const posStart = a.usedPositions;
      const normStart = a.usedNormals;
      const idxStart = a.usedIndices;
      const biomeStart = a.usedBiome;
      const skirtPosStart = a.usedSkirtPositions;
      const skirtNormStart = a.usedSkirtNormals;
      const skirtIdxStart = a.usedSkirtIndices;

      this._ensureArena({
        positions: positions.length,
        normals: normals.length,
        indices: indices.length,
        biome: biomeWeights.length,
        skirtPositions: skirtPositions ? skirtPositions.length : 0,
        skirtNormals: skirtNormals ? skirtNormals.length : 0,
        skirtIndices: skirtIndices ? skirtIndices.length : 0
      });

      a.positions.set(positions, posStart);
      a.usedPositions += positions.length;
      a.normals.set(normals, normStart);
      a.usedNormals += normals.length;
      a.indices.set(indices, idxStart);
      a.usedIndices += indices.length;
      a.biomeWeights.set(biomeWeights, biomeStart);
      a.usedBiome += biomeWeights.length;

      if (skirtPositions) {
        a.skirtPositions.set(skirtPositions, skirtPosStart);
        a.usedSkirtPositions += skirtPositions.length;
        a.skirtNormals.set(skirtNormals, skirtNormStart);
        a.usedSkirtNormals += skirtNormals.length;
        a.skirtIndices.set(skirtIndices, skirtIdxStart);
        a.usedSkirtIndices += skirtIndices.length;
      }

      const [minX, minY, minZ, maxX, maxY, maxZ] = bounds;
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      const dx = maxX - cx, dy = maxY - cy, dz = maxZ - cz;
      const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 1.05;

      const entityId = this.ecsWorld?.createEntity?.() ?? 0xFFFFFFFF;
      if (this.ecsWorld && entityId !== 0xFFFFFFFF) {
        this.ecsWorld.addComponent?.(entityId, I3SElevationComponent, {
          tileX, tileY, tileZ, lod,
          vertexCount, triangleCount,
          vertexStart: posStart,
          normalStart: normStart,
          indexStart: idxStart,
          indexCount: indices.length,
          skirtVertexStart: skirtPosStart,
          skirtIndexStart: skirtIdxStart,
          skirtIndexCount: skirtIndices ? skirtIndices.length : 0,
          westCount: westIndices.length,
          southCount: southIndices.length,
          eastCount: eastIndices.length,
          northCount: northIndices.length,
          heightMin: minHeight,
          heightMax: maxHeight,
          vertexPrecision: precision,
          normalEncoding,
          hasVertexColors: hasColors,
          hasUVs,
          state: TileState.READY,
          lastUpdatedTick: tick
        });
      }

      spatial.i3sElevationBounds.push(minX, minY, minZ, maxX, maxY, maxZ);
      spatial.i3sElevationBoundingSpheres.push(cx, cy, cz, radius);
      spatial.i3sElevationMaterialIds.push(0);
      spatial.i3sElevationEntityIds.push(entityId);
      spatial.i3sElevationTileKeys.push(tileKey);
      spatial.i3sElevationLods.push(lod);

      this.tileMap.set(tileKey, {
        entityId, lod, tileX, tileY, tileZ,
        vertexCount,
        vertexStart: posStart,
        normalStart: normStart,
        indexStart: idxStart,
        indexCount: indices.length,
        biomeStart,
        skirtVertexStart: skirtPosStart,
        skirtNormalStart: skirtNormStart,
        skirtIndexStart: skirtIdxStart,
        skirtIndexCount: skirtIndices ? skirtIndices.length : 0,
        westIndices, southIndices, eastIndices, northIndices,
        bounds, minHeight, maxHeight,
        boundingSphere: [cx, cy, cz, radius],
        precision, normalEncoding, hasColors, hasUVs
      });

      this._tileViews.set(tileKey, {
        vertexStart: posStart,
        vertexCount,
        normalStart: normStart,
        indexStart: idxStart,
        indexCount: indices.length,
        biomeStart,
        skirtVertexStart: skirtPosStart,
        skirtNormalStart: skirtNormStart,
        skirtIndexStart: skirtIdxStart,
        skirtIndexCount: skirtIndices ? skirtIndices.length : 0
      });

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
        const [sx, sy] = rec.boundingSphere;
        const safeRadius = this.options.tileWorldSize * 2;
        if ((sx - px) ** 2 + (sy - py) ** 2 < safeRadius * safeRadius) {
          this.lru.push(oldest);
          break;
        }
      }
      this.tileMap.delete(oldest);
      this._tileViews.delete(oldest);
    }
  }

  getArena() { return this._arena; }
  getTileView(tileKey) { return this._tileViews.get(tileKey) ?? null; }
  getTileRecord(tileKey) { return this.tileMap.get(tileKey) ?? null; }
  getTerrainObject(tileKey) { return this.tileMap.get(tileKey)?.terrainObject ?? null; }

  dispose() {
    this.pool.dispose();
    this.pendingJobs.clear();
    this.resolvedQueue.length = 0;
    this.tileMap.clear();
    this.lru.length = 0;
    this._tileViews.clear();
    const a = this._arena;
    a.positions = null; a.normals = null; a.indices = null; a.biomeWeights = null;
    a.skirtPositions = null; a.skirtNormals = null; a.skirtIndices = null;
    a.usedPositions = a.usedNormals = a.usedIndices = a.usedBiome = 0;
    a.usedSkirtPositions = a.usedSkirtNormals = a.usedSkirtIndices = 0;
    a.positionCapacity = a.normalCapacity = a.indexCapacity = a.biomeCapacity = 0;
    a.skirtPositionCapacity = a.skirtNormalCapacity = a.skirtIndexCapacity = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainI3SElevationDecoder(options = {}) {
  return new TerrainI3SElevationDecoder({
    maxWorkers: options.maxWorkers ?? 2,
    maxPendingJobs: options.maxPendingJobs ?? 16,
    targetHz: options.targetHz ?? 10,
    tileWorldSize: options.tileWorldSize ?? 100,
    skirtDepth: options.skirtDepth ?? 1.0,
    priorityDistanceScale: options.priorityDistanceScale ?? 0.01,
    maxTiles: options.maxTiles ?? 256,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 7. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainI3SElevationDecoder,
  I3SElevationTerrain,
  I3SElevationComponent,
  I3SElevationSeamComponent,
  createTerrainI3SElevationDecoder
};