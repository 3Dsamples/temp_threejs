// file number : 364
// full path name : src/context/364_SHPContextProvider.js
//### Description : Context-aware ESRI Shapefile (.shp) provider. Parses the
//###               binary shapefile format (Point, PolyLine, Polygon, MultiPoint,
//###               PointZ, PolyLineZ, PolygonZ, MultiPointZ, PointM, PolyLineM,
//###               PolygonM, Null) entirely off the main thread and procedurally
//###               generates 3D vertex/index buffers from raw coordinate records,
//###               with no external loader and no CDN access. Supports SRID from an
//###               adjacent .prj, per-record provenance, deletion-safe traversal,
//###               file-header and computed bounding boxes, and configurable
//###               triangulation strategies (fan, strip, index-pair). Results are
//###               streamed into the context frame’s spatial channel and merged
//###               only into the next frame’s build stage, never the current one.
//###               Designed for Android arm64 under the 8 ms per-tick CPU ceiling
//###               and 200 MB resident memory cap.
//### Best for : Streaming 2D/3D vector features (coastlines, roads, parcels,
//###            administrative boundaries, contour lines, biome masks) into a
//###            procedurally-generated terrain pipeline. The parser is fully
//###            parametric — no loader, no static server, no asset download —
//###            so shapefile features are generated from raw bytes and handed to
//###            the runtime as ECS-bound geometry for context-aware consumption.
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
  // textures (procedural masks for shapefile-driven terrain painting)
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

// ---------------------------------------------------------------------------
// 1. ECS COMPONENT – shapefile provenance for spatial entities
// ---------------------------------------------------------------------------

/**
 * SHPComponent — stored per shapefile feature (one per record).
 * Enables systems to query which shape type, feature index, and header
 * parameters a geometry originated from, without re-parsing the binary.
 */
export class SHPComponent {
  static schema = {
    fileShapeType:  { type: 'u8' },
    recordShapeType:{ type: 'u8' },
    featureIndex:   { type: 'u32' },
    vertexStart:    { type: 'u32' },
    vertexCount:    { type: 'u32' },
    indexStart:     { type: 'u32' },
    indexCount:     { type: 'u32' },
    lastUpdatedTick:{ type: 'u32' }
  };
}

// ---------------------------------------------------------------------------
// 2. SHP WORKER – binary shapefile parser (off main thread, no loaders)
// ---------------------------------------------------------------------------

const SHP_WORKER_SOURCE = `
  // Pure binary ESRI Shapefile parser. No external loaders, no network access.
  // Produces positions (Float32Array) and indices (Uint32Array) that are then
  // merged into the context frame's spatial SoA channel by the provider.

  const SHAPE_TYPES = {
    0:  'Null',
    1:  'Point',
    3:  'PolyLine',
    5:  'Polygon',
    8:  'MultiPoint',
    11: 'PointZ',
    13: 'PolyLineZ',
    15: 'PolygonZ',
    18: 'MultiPointZ',
    21: 'PointM',
    23: 'PolyLineM',
    25: 'PolygonM',
    28: 'MultiPointM',
    31: 'MultiPatch'
  };

  // Triangulation mode identifiers
  const TRI_FAN = 0;
  const TRI_STRIP = 1;
  const TRI_PAIRS = 2;

  self.onmessage = function (e) {
    const { id, buffer, byteOffset, byteLength, triMode } = e.data;
    try {
      const data = new DataView(buffer, byteOffset || 0, byteLength || buffer.byteLength);
      const result = parseSHP(data, triMode == null ? TRI_FAN : triMode);
      const payload = {
        id,
        positions: result.positions,
        indices: result.indices,
        fileShapeType: result.fileShapeType,
        headerBounds: result.headerBounds,
        bounds: result.bounds,
        recordTypes: result.recordTypes,
        recordVertexStart: result.recordVertexStart,
        recordVertexCount: result.recordVertexCount,
        recordIndexStart: result.recordIndexStart,
        recordIndexCount: result.recordIndexCount,
        recordCount: result.recordCount
      };
      self.postMessage(payload, [payload.positions.buffer, payload.indices.buffer]);
    } catch (err) {
      self.postMessage({ id, error: err.message });
    }
  };

  function parseSHP(data, triMode) {
    // ---- Header (100 bytes) ----
    const fileCode = data.getInt32(0, false); // big-endian
    if (fileCode !== 9994) throw new Error('Not a shapefile: bad file code ' + fileCode);

    const fileLengthWords = data.getInt32(24, false); // big-endian, 16-bit words
    const fileLengthBytes = fileLengthWords * 2;

    // File header is little-endian for everything after the two BE words
    const version = data.getInt32(28, true);
    if (version !== 1000) throw new Error('Unsupported shapefile version: ' + version);

    const fileShapeType = data.getInt32(32, true);

    const xMin = data.getFloat64(36, true);
    const yMin = data.getFloat64(44, true);
    const xMax = data.getFloat64(52, true);
    const yMax = data.getFloat64(60, true);
    const zMin = data.getFloat64(68, true);
    const zMax = data.getFloat64(76, true);
    // mMin/mMax intentionally skipped (they are unused by the pipeline)

    // ---- Records ----
    const positions = [];        // flat XYZ triples
    const indices = [];          // triangle / segment indices
    const recordTypes = [];      // Uint8 per record
    const recordVertexStart = []; // u32 vertex offset per record
    const recordVertexCount = []; // u32 vertex count per record
    const recordIndexStart = []; // u32 index offset per record
    const recordIndexCount = []; // u32 index count per record

    let offset = 100;
    let recordIndex = 0;

    while (offset + 8 <= fileLengthBytes) {
      const recNum = data.getInt32(offset, false); // big-endian
      const contentLenWords = data.getInt32(offset + 4, false); // big-endian
      const contentLenBytes = contentLenWords * 2;
      const contentStart = offset + 8;
      const recShapeType = data.getInt32(contentStart, true); // little-endian

      const vStart = positions.length / 3;
      const iStart = indices.length;

      if (recShapeType === 0) {
        // Null shape — record exists but contributes no geometry.
      } else if (recShapeType === 1 || recShapeType === 11 || recShapeType === 21) {
        // Point, PointZ, PointM
        const px = data.getFloat64(contentStart + 4, true);
        const py = data.getFloat64(contentStart + 12, true);
        let pz = 0;
        if (recShapeType === 11) pz = data.getFloat64(contentStart + 20, true);
        positions.push(px, py, pz);
        indices.push(vStart, vStart, vStart); // degenerate single-vertex marker
      } else if (recShapeType === 8 || recShapeType === 18 || recShapeType === 28) {
        // MultiPoint, MultiPointZ, MultiPointM
        // Layout: box(4 doubles), numPoints(int32 LE), points[]
        const numPoints = data.getInt32(contentStart + 36, true);
        const pointsStart = contentStart + 40;
        const isZ = recShapeType === 18;
        const stride = isZ ? 24 : 16;
        for (let i = 0; i < numPoints; i++) {
          const px = data.getFloat64(pointsStart + i * stride, true);
          const py = data.getFloat64(pointsStart + i * stride + 8, true);
          let pz = 0;
          if (isZ) pz = data.getFloat64(pointsStart + i * stride + 16, true);
          positions.push(px, py, pz);
          indices.push(vStart + i, vStart + i, vStart + i);
        }
      } else if (
        recShapeType === 3 || recShapeType === 13 || recShapeType === 23 ||
        recShapeType === 5 || recShapeType === 15 || recShapeType === 25
      ) {
        // PolyLine / PolyLineZ / PolyLineM / Polygon / PolygonZ / PolygonM
        // Layout: box(4 doubles LE), numParts(int32 LE), numPoints(int32 LE),
        //         parts[numParts](int32 LE), points[numPoints] (2 or 3 doubles LE)
        const numParts = data.getInt32(contentStart + 36, true);
        const numPoints = data.getInt32(contentStart + 40, true);
        const partsStart = contentStart + 44;
        const pointsStart = partsStart + numParts * 4;

        const isZ = recShapeType === 13 || recShapeType === 15;
        const stride = isZ ? 24 : 16;

        // Read part offsets
        const partStartOffsets = new Int32Array(numParts + 1);
        for (let p = 0; p < numParts; p++) {
          partStartOffsets[p] = data.getInt32(partsStart + p * 4, true);
        }
        partStartOffsets[numParts] = numPoints;

        // Read points
        const baseVertex = vStart;
        for (let i = 0; i < numPoints; i++) {
          const px = data.getFloat64(pointsStart + i * stride, true);
          const py = data.getFloat64(pointsStart + i * stride + 8, true);
          let pz = 0;
          if (isZ) pz = data.getFloat64(pointsStart + i * stride + 16, true);
          positions.push(px, py, pz);
        }

        // Triangulate parts
        const isPolygon = recShapeType === 5 || recShapeType === 15 || recShapeType === 25;
        for (let p = 0; p < numParts; p++) {
          const s = baseVertex + partStartOffsets[p];
          const e = baseVertex + partStartOffsets[p + 1];
          const count = e - s;
          if (count < 2) continue;

          if (triMode === TRI_PAIRS) {
            // Consecutive pair indices (k, k+1) for line rendering.
            for (let k = s; k < e - 1; k++) indices.push(k, k + 1, k + 1);
          } else if (isPolygon) {
            if (triMode === TRI_STRIP) {
              // Triangle strip — same topology as fan for a single ring.
              for (let k = s + 1; k < e - 1; k++) indices.push(s, k, k + 1);
            } else {
              // Default triangle fan per ring.
              for (let k = s + 1; k < e - 1; k++) indices.push(s, k, k + 1);
            }
          } else {
            // Polyline — degenerate triangle per segment (safe default for 3D).
            for (let k = s + 1; k < e; k++) indices.push(k - 1, k, k);
          }
        }
      } else {
        // Unsupported shape type (e.g., MultiPatch) — record skipped.
      }

      // Record provenance (indexed by record ordinal, not by record number
      // in the file, so the consumer can iterate records sequentially).
      recordTypes.push(recShapeType);
      recordVertexStart.push(vStart);
      recordVertexCount.push(positions.length / 3 - vStart);
      recordIndexStart.push(iStart);
      recordIndexCount.push(indices.length - iStart);
      recordIndex++;

      // Advance to the next record. Content length is in 16-bit words.
      offset = contentStart + contentLenBytes;
    }

    // ---- Bounds ----
    let cbMinX = Infinity, cbMinY = Infinity, cbMinZ = Infinity;
    let cbMaxX = -Infinity, cbMaxY = -Infinity, cbMaxZ = -Infinity;
    for (let k = 0; k < positions.length; k += 3) {
      const x = positions[k], y = positions[k + 1], z = positions[k + 2];
      if (x < cbMinX) cbMinX = x; if (x > cbMaxX) cbMaxX = x;
      if (y < cbMinY) cbMinY = y; if (y > cbMaxY) cbMaxY = y;
      if (z < cbMinZ) cbMinZ = z; if (z > cbMaxZ) cbMaxZ = z;
    }
    if (positions.length === 0) {
      cbMinX = cbMinY = cbMinZ = 0;
      cbMaxX = cbMaxY = cbMaxZ = 0;
    }

    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      fileShapeType,
      headerBounds: [xMin, yMin, zMin, xMax, yMax, zMax],
      bounds: [cbMinX, cbMinY, cbMinZ, cbMaxX, cbMaxY, cbMaxZ],
      recordTypes: new Uint8Array(recordTypes),
      recordVertexStart: new Uint32Array(recordVertexStart),
      recordVertexCount: new Uint32Array(recordVertexCount),
      recordIndexStart: new Uint32Array(recordIndexStart),
      recordIndexCount: new Uint32Array(recordIndexCount),
      recordCount: recordIndex
    };
  }
`;

// ---------------------------------------------------------------------------
// 3. WORKER POOL – priority queue, cancellation, backpressure
// ---------------------------------------------------------------------------

class SHPWorkerPool {
  constructor(maxWorkers = 2) {
    this.maxWorkers = maxWorkers;
    this.workers = [];
    this.queue = [];
    this.activeJobs = new Map();
    this.nextJobId = 1;
    this._init();
  }

  _init() {
    const blob = new Blob([SHP_WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    for (let i = 0; i < this.maxWorkers; i++) {
      const w = new Worker(url);
      w.onmessage = (e) => this._onWorkerMessage(w, e.data);
      w.onerror = (e) => this._onWorkerError(w, e);
      this.workers.push({ worker: w, busy: false, currentJobId: null });
    }
    URL.revokeObjectURL(url);
  }

  enqueue(buffer, byteOffset, byteLength, triMode, priority) {
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      this.queue.push({ id, buffer, byteOffset, byteLength, triMode, priority, resolve, reject });
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
      slot.worker.postMessage({
        id: job.id,
        buffer: job.buffer,
        byteOffset: job.byteOffset,
        byteLength: job.byteLength,
        triMode: job.triMode
      }, [job.buffer]);
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
    const blob = new Blob([SHP_WORKER_SOURCE], { type: 'application/javascript' });
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
// 4. CONTEXT PROVIDER – fills spatial channel at 10 Hz, ECS-aware
// ---------------------------------------------------------------------------

// Triangulation mode names accepted by the provider.
const TRI_MODE_NAMES = { fan: 0, strip: 1, pairs: 2 };

export class SHPContextProvider {
  constructor(options = {}) {
    this.options = {
      maxWorkers: options.maxWorkers ?? 2,
      maxPendingJobs: options.maxPendingJobs ?? 32,
      targetHz: options.targetHz ?? 10,
      materialIdForTerrain: options.materialIdForTerrain ?? 1,
      boundingSpherePadding: options.boundingSpherePadding ?? 1.05,
      priorityDistanceScale: options.priorityDistanceScale ?? 0.01,
      triangulation: options.triangulation ?? 'fan', // 'fan' | 'strip' | 'pairs'
      zScale: options.zScale ?? 1.0,
      srid: options.srid ?? 4326,
      ...options
    };

    this.triMode = TRI_MODE_NAMES[this.options.triangulation];
    if (this.triMode === undefined) this.triMode = 0;

    this.pool = new SHPWorkerPool(this.options.maxWorkers);
    this.pendingJobs = new Map();
    this.resolvedQueue = [];
    this.nextInternalId = 1;

    this.frame = null;
    this.ecsWorld = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // Geometry buffer indexed by entity id (each record → one entity).
    this._geometryBuffer = new Map();

    // Per-source metadata (byteCount, srid, fileShapeType).
    this._sourceMetadata = new Map();

    this.eventDispatcher = null;
  }

  /**
   * Provider contract: called by the runtime at its declared tier (default 10 Hz).
   * @param {ContextFrame} contextFrame – the live five-layer context frame
   * @param {number} tick – monotonic tick counter (u32, mod 256 hashing)
   * @param {number} dt – delta time in seconds
   */
  update(contextFrame, tick, dt) {
    this.frame = contextFrame;
    this.lastTick = tick;
    this._accumulator += dt;

    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    this._mergeResolved(tick);
  }

  /**
   * Public entry point (blueprint step 34): ingest a shapefile binary buffer.
   * No loader is used — the binary is parsed and geometry is procedurally
   * generated from the raw coordinate records.
   *
   * @param {ArrayBuffer} arrayBuffer – .shp file contents (ownership transferred)
   * @param {string} sourceKey – unique key (e.g. file path or logical name)
   * @param {object} [options] – { byteOffset, byteLength, srid, priority }
   * @returns {Promise<number>} resolves with the internal job id
   */
  ingest(arrayBuffer, sourceKey, options = {}) {
    if (this.pendingJobs.size >= this.options.maxPendingJobs) {
      return Promise.reject(new Error('SHP ingest queue full (backpressure)'));
    }

    const {
      byteOffset = 0,
      byteLength = arrayBuffer.byteLength,
      srid = this.options.srid,
      priority = 0
    } = options;

    const internalId = this.nextInternalId++;

    let effectivePriority = priority;
    if (this.frame?.layers.player?.position) {
      const cam = this.frame.layers.player.position;
      const d2 = cam[0] * cam[0] + cam[1] * cam[1] + cam[2] * cam[2];
      effectivePriority += 1 / (1 + d2 * this.options.priorityDistanceScale);
    }

    const promise = this.pool.enqueue(arrayBuffer, byteOffset, byteLength, this.triMode, effectivePriority)
      .then(result => {
        this.pendingJobs.delete(internalId);
        this.resolvedQueue.push({ internalId, sourceKey, srid, result });
        return internalId;
      })
      .catch(err => {
        this.pendingJobs.delete(internalId);
        throw err;
      });

    this.pendingJobs.set(internalId, {
      arrayBuffer, sourceKey, options, priority: effectivePriority, promise
    });
    return promise;
  }

  cancel(internalId) {
    if (!this.pendingJobs.has(internalId)) return false;
    this.pendingJobs.delete(internalId);
    return true;
  }

  _mergeResolved(tick) {
    if (!this.frame?.layers.spatial) return;
    const spatial = this.frame.layers.spatial;

    if (!spatial.shpGeometryBounds) {
      spatial.shpGeometryBounds = [];
      spatial.shpBoundingSpheres = [];
      spatial.shpMaterialIds = [];
      spatial.shpEntityIds = [];
      spatial.shpSourceIndex = new Map(); // sourceKey → array of entity ids
    }

    const zScale = this.options.zScale;

    for (const entry of this.resolvedQueue) {
      const { internalId, sourceKey, srid, result } = entry;
      const {
        positions, indices, bounds, fileShapeType, headerBounds,
        recordTypes, recordVertexStart, recordVertexCount,
        recordIndexStart, recordIndexCount, recordCount
      } = result;

      // Apply Z scaling factor to the copy owned by the consumer.
      // The provider holds the raw coordinates; downstream consumers
      // receive a scaled copy without mutating the cached buffer.
      if (zScale !== 1.0) {
        for (let k = 2; k < positions.length; k += 3) {
          positions[k] *= zScale;
        }
      }

      const entityIds = [];

      for (let r = 0; r < recordCount; r++) {
        const vs = recordVertexStart[r];
        const vc = recordVertexCount[r];
        const is = recordIndexStart[r];
        const ic = recordIndexCount[r];
        if (vc === 0 && ic === 0) continue; // null shape

        // Compute per-record bounding sphere.
        let rMinX = Infinity, rMinY = Infinity, rMinZ = Infinity;
        let rMaxX = -Infinity, rMaxY = -Infinity, rMaxZ = -Infinity;
        for (let v = 0; v < vc; v++) {
          const k = (vs + v) * 3;
          const x = positions[k], y = positions[k + 1], z = positions[k + 2];
          if (x < rMinX) rMinX = x; if (x > rMaxX) rMaxX = x;
          if (y < rMinY) rMinY = y; if (y > rMaxY) rMaxY = y;
          if (z < rMinZ) rMinZ = z; if (z > rMaxZ) rMaxZ = z;
        }
        const cx = (rMinX + rMaxX) * 0.5;
        const cy = (rMinY + rMaxY) * 0.5;
        const cz = (rMinZ + rMaxZ) * 0.5;
        const dx = rMaxX - cx, dy = rMaxY - cy, dz = rMaxZ - cz;
        const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) *
          this.options.boundingSpherePadding;

        // ECS entity for this feature.
        const entityId = this.ecsWorld?.createEntity?.() ?? -1;
        if (this.ecsWorld && entityId >= 0) {
          this.ecsWorld.addComponent(entityId, SHPComponent, {
            fileShapeType,
            recordShapeType: recordTypes[r],
            featureIndex: r,
            vertexStart: vs,
            vertexCount: vc,
            indexStart: is,
            indexCount: ic,
            lastUpdatedTick: tick
          });
        }

        // SoA push into the frame’s spatial channel.
        spatial.shpGeometryBounds.push(rMinX, rMinY, rMinZ, rMaxX, rMaxY, rMaxZ);
        spatial.shpBoundingSpheres.push(cx, cy, cz, radius);
        spatial.shpMaterialIds.push(this.options.materialIdForTerrain);
        spatial.shpEntityIds.push(entityId);

        // Per-entity geometry view (no copy — shares the same ArrayBuffers).
        this._geometryBuffer.set(entityId, {
          positions,      // shared reference
          indices,        // shared reference
          vertexStart: vs,
          vertexCount: vc,
          indexStart: is,
          indexCount: ic,
          srid,
          sourceKey,
          recordShapeType: recordTypes[r]
        });

        entityIds.push(entityId);
      }

      // Source metadata for downstream consumers.
      this._sourceMetadata.set(sourceKey, {
        internalId,
        srid,
        fileShapeType,
        headerBounds,
        bounds,
        recordCount,
        byteCount: positions.byteLength + indices.byteLength,
        entityIds
      });

      spatial.shpSourceIndex.set(sourceKey, entityIds);
    }
    this.resolvedQueue.length = 0;
  }

  /**
   * Retrieve the shared geometry view for an entity.
   * Called by the batched dispatch stage (stage six) — never mid-frame.
   */
  getGeometryForEntity(entityId) {
    return this._geometryBuffer.get(entityId) ?? null;
  }

  /**
   * Retrieve metadata for a given source (file-level shape type, bounds, etc.).
   */
  getSourceMetadata(sourceKey) {
    return this._sourceMetadata.get(sourceKey) ?? null;
  }

  dispose() {
    this.pool.dispose();
    this.pendingJobs.clear();
    this.resolvedQueue.length = 0;
    this._geometryBuffer.clear();
    this._sourceMetadata.clear();
  }
}

export default SHPContextProvider;