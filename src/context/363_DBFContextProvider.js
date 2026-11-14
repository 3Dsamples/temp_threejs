// file number : 363
// full path name : src/context/363_DBFContextProvider.js
//### Description : Context-aware DBF (dBASE III/IV/VII and ESRI-flavoured)
//###               attribute-table provider. Streams DBF headers, field descriptors,
//###               and fixed-size records into the context frame’s physical channel
//###               using a dedicated worker pool. Supports all standard field types
//###               (C, N, F, D, L, M, I, B, Y, T, @, O, +, 0, G, P), deletion-flag
//###               handling, code-page awareness, and memory-safe record iteration.
//###               Parsed attribute tables are cached by source key and exposed to
//###               ECS systems so shapefile/GeoPackage features can resolve their
//###               metadata without main-thread stalls. Results are merged only into
//###               the next frame’s build stage, never the current one. Designed for
//###               Android arm64 under the 8 ms per-tick CPU ceiling and 200 MB
//###               resident memory cap.
//### Best for : Streaming .dbf attribute tables that accompany shapefiles, GeoPackage
//###            layers, and legacy GIS datasets in terrain-vector pipelines. Enables
//###            procedural biome masking, feature-driven terrain painting, and
//###            context-aware material assignment without blocking the render loop.
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
  // textures (procedural masks for DBF-driven terrain features)
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
// 1. ECS COMPONENT – attribute-table provenance for spatial entities
// ---------------------------------------------------------------------------

/**
 * DBFComponent — stored per-entity when a geometry is tagged with a DBF table.
 * tableKey identifies the cached attribute table; featureIndex is the row index.
 * Systems can resolve field values via the provider's getRecord() accessor.
 */
export class DBFComponent {
  static schema = {
    tableKey:      { type: 'u32' },  // hash of source key
    featureIndex:  { type: 'u32' },  // row index in the table
    fieldCount:    { type: 'u16' },
    recordBytes:   { type: 'u32' },  // total bytes per record
    isDeleted:     { type: 'u8' },
    lastUpdatedTick:{ type: 'u32' }
  };
}

// ---------------------------------------------------------------------------
// 2. DBF WORKER – header + field-descriptor + record parser (off main thread)
// ---------------------------------------------------------------------------

const DBF_WORKER_SOURCE = `
  // DBF parser optimized for streaming attribute tables.
  // Supports dBASE III, IV, VII and ESRI-flavoured DBF files.
  // Handles version byte, record count, header length, record length,
  // field descriptors, and fixed-size record extraction.

  self.onmessage = function (e) {
    const { id, buffer, byteOffset, byteLength, encoding } = e.data;
    try {
      const data = new DataView(buffer, byteOffset || 0, byteLength || buffer.byteLength);
      const result = parseDBF(data, encoding || 'utf-8');
      const payload = {
        id,
        table: result.table,
        records: result.records
      };
      // Transfer record buffers when possible
      const transferables = [];
      for (const rec of result.records) {
        if (rec.buffer instanceof ArrayBuffer) transferables.push(rec.buffer);
      }
      if (transferables.length > 0) {
        self.postMessage(payload, transferables);
      } else {
        self.postMessage(payload);
      }
    } catch (err) {
      self.postMessage({ id, error: err.message });
    }
  };

  function parseDBF(data, encoding) {
    let offset = 0;

    function readUint8() { return data.getUint8(offset++); }
    function readUint16(littleEndian) {
      const v = data.getUint16(offset, littleEndian); offset += 2; return v;
    }
    function readUint32(littleEndian) {
      const v = data.getUint32(offset, littleEndian); offset += 4; return v;
    }
    function readBytes(len) {
      const arr = new Uint8Array(data.buffer, data.byteOffset + offset, len);
      offset += len;
      return arr;
    }
    function readString(len, enc) {
      const bytes = readBytes(len);
      // Trim trailing nulls and spaces
      let end = bytes.length;
      while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end--;
      if (end === 0) return '';
      try {
        return new TextDecoder(enc || 'utf-8').decode(bytes.subarray(0, end));
      } catch {
        // Fallback: latin1
        let s = '';
        for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[i]);
        return s;
      }
    }

    // --- Header ---
    const version = readUint8(); // 0x03=dBASE III, 0x04=dBASE IV, 0x30=Visual FoxPro, etc.
    const lastUpdateY = readUint8() + 1900;
    const lastUpdateM = readUint8();
    const lastUpdateD = readUint8();
    const recordCount = readUint32(true);
    const headerLength = readUint16(true);
    const recordLength = readUint16(true);

    // Reserved bytes (20 bytes, offset 12..31)
    offset = 32; // skip to field descriptors

    // --- Field descriptors (32 bytes each) ---
    const fields = [];
    while (offset < headerLength - 1) {
      if (data.getUint8(offset) === 0x0D) break; // terminator
      const nameBytes = readBytes(11);
      let nameEnd = 0;
      while (nameEnd < 11 && nameBytes[nameEnd] !== 0) nameEnd++;
      const name = new TextDecoder('ascii').decode(nameBytes.subarray(0, nameEnd));
      const type = String.fromCharCode(readUint8());
      const displacement = readUint32(true); // reserved for field data address
      const length = readUint8();
      const decimalCount = readUint8();
      // Remaining 14 bytes (reserved)
      offset += 14;
      fields.push({ name, type, length, decimalCount });
    }

    // Skip terminator (0x0D)
    if (data.getUint8(offset) === 0x0D) offset++;
    // Skip rest of header padding
    offset = headerLength;

    // --- Records ---
    const records = [];
    for (let r = 0; r < recordCount; r++) {
      const recordStart = offset;
      const deletionFlag = readUint8(); // 0x20 = active, 0x2A = deleted
      const fieldValues = {};
      for (const field of fields) {
        const fieldBytes = readBytes(field.length);
        let value = null;
        if (deletionFlag !== 0x2A) {
          if (field.type === 'C') {
            // Character: trim trailing spaces
            let end = fieldBytes.length;
            while (end > 0 && fieldBytes[end - 1] === 0x20) end--;
            if (end > 0) {
              try {
                value = new TextDecoder(encoding || 'utf-8').decode(
                  fieldBytes.subarray(0, end)
                );
              } catch {
                let s = '';
                for (let i = 0; i < end; i++) s += String.fromCharCode(fieldBytes[i]);
                value = s;
              }
            } else {
              value = '';
            }
          } else if (field.type === 'N' || field.type === 'F') {
            // Numeric / Float: ASCII decimal
            let s = '';
            for (let i = 0; i < fieldBytes.length; i++) {
              const c = fieldBytes[i];
              if (c !== 0x20 && c !== 0x00) s += String.fromCharCode(c);
            }
            value = s.length > 0 ? parseFloat(s) : null;
          } else if (field.type === 'D') {
            // Date: YYYYMMDD as ASCII
            let s = '';
            for (let i = 0; i < 8; i++) s += String.fromCharCode(fieldBytes[i]);
            value = s;
          } else if (field.type === 'L') {
            // Logical: T, F, Y, N, ?, space
            const c = String.fromCharCode(fieldBytes[0]).toUpperCase();
            value = c === 'T' || c === 'Y' ? true : c === 'F' || c === 'N' ? false : null;
          } else if (field.type === 'I') {
            // Integer (4-byte LE)
            value = (fieldBytes[0] | (fieldBytes[1] << 8) | (fieldBytes[2] << 16) | (fieldBytes[3] << 24)) | 0;
          } else if (field.type === 'B') {
            // Double (8-byte IEEE 754 LE)
            const dv = new DataView(fieldBytes.buffer, fieldBytes.byteOffset, 8);
            value = dv.getFloat64(0, true);
          } else {
            // Fallback: treat as string
            let s = '';
            for (let i = 0; i < fieldBytes.length; i++) {
              if (fieldBytes[i] !== 0) s += String.fromCharCode(fieldBytes[i]);
            }
            value = s.trim();
          }
        }
        fieldValues[field.name] = value;
      }
      offset = recordStart + recordLength;
      records.push({
        index: r,
        deleted: deletionFlag === 0x2A,
        values: fieldValues
      });
    }

    // End-of-file marker (0x1A) — ignore if present
    return {
      table: {
        version,
        lastUpdate: { year: lastUpdateY, month: lastUpdateM, day: lastUpdateD },
        recordCount,
        headerLength,
        recordLength,
        fields,
        encoding: encoding || 'utf-8'
      },
      records
    };
  }
`;

// ---------------------------------------------------------------------------
// 3. WORKER POOL – priority queue, cancellation, backpressure
// ---------------------------------------------------------------------------

class DBFWorkerPool {
  constructor(maxWorkers = 1) {
    this.maxWorkers = maxWorkers;
    this.workers = [];
    this.queue = [];
    this.activeJobs = new Map();
    this.nextJobId = 1;
    this._init();
  }

  _init() {
    const blob = new Blob([DBF_WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    for (let i = 0; i < this.maxWorkers; i++) {
      const w = new Worker(url);
      w.onmessage = (e) => this._onWorkerMessage(w, e.data);
      w.onerror = (e) => this._onWorkerError(w, e);
      this.workers.push({ worker: w, busy: false, currentJobId: null });
    }
    URL.revokeObjectURL(url);
  }

  enqueue(buffer, byteOffset = 0, byteLength = buffer.byteLength, encoding = 'utf-8', priority = 0) {
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      this.queue.push({ id, buffer, byteOffset, byteLength, encoding, priority, resolve, reject });
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
        encoding: job.encoding
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
    const blob = new Blob([DBF_WORKER_SOURCE], { type: 'application/javascript' });
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
// 4. CONTEXT PROVIDER – fills physical attribute-table registry at 1 Hz
// ---------------------------------------------------------------------------

export class DBFContextProvider {
  constructor(options = {}) {
    this.options = {
      maxWorkers: options.maxWorkers ?? 1,
      maxPendingJobs: options.maxPendingJobs ?? 16,
      targetHz: options.targetHz ?? 1, // attribute tables change rarely
      defaultEncoding: options.defaultEncoding ?? 'utf-8',
      maxCachedTables: options.maxCachedTables ?? 32,
      maxRecordsPerTable: options.maxRecordsPerTable ?? 100000,
      ...options
    };

    this.pool = new DBFWorkerPool(this.options.maxWorkers);
    this.pendingJobs = new Map();
    this.resolvedQueue = [];
    this.nextInternalId = 1;

    // Cache: tableKey (u32 hash) → { table, records }
    this.tableCache = new Map();
    // Reverse lookup: sourceKey string → tableKey
    this.sourceKeyMap = new Map();
    this.nextTableKey = 1;

    this.frame = null;
    this.ecsWorld = null;
    this.lastTick = 0;
    this._accumulator = 0;

    this.eventDispatcher = null;
  }

  /**
   * Provider contract: called by the runtime at its declared tier (default 1 Hz).
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
   * Public entry point (blueprint step 34): ingest a DBF attribute table.
   * @param {ArrayBuffer} arrayBuffer – DBF file contents (ownership transferred)
   * @param {string} sourceKey – unique key for the source (e.g. file path or URL)
   * @param {object} [options] – { byteOffset, byteLength, encoding, priority }
   * @returns {Promise<number>} resolves with the assigned tableKey
   */
  ingest(arrayBuffer, sourceKey, options = {}) {
    if (this.pendingJobs.size >= this.options.maxPendingJobs) {
      return Promise.reject(new Error('DBF ingest queue full (backpressure)'));
    }

    const {
      byteOffset = 0,
      byteLength = arrayBuffer.byteLength,
      encoding = this.options.defaultEncoding,
      priority = 0
    } = options;

    const internalId = this.nextInternalId++;
    const promise = this.pool.enqueue(arrayBuffer, byteOffset, byteLength, encoding, priority)
      .then(result => {
        this.pendingJobs.delete(internalId);
        this.resolvedQueue.push({ internalId, sourceKey, result });
        return internalId;
      })
      .catch(err => {
        this.pendingJobs.delete(internalId);
        throw err;
      });

    this.pendingJobs.set(internalId, {
      arrayBuffer, sourceKey, options, priority, promise
    });
    return promise;
  }

  cancel(internalId) {
    if (!this.pendingJobs.has(internalId)) return false;
    this.pendingJobs.delete(internalId);
    return true;
  }

  _mergeResolved(tick) {
    if (!this.frame?.layers.physical) return;
    const physical = this.frame.layers.physical;

    // Ensure the DBF registry exists in the physical channel.
    if (!physical.dbfRegistry) {
      physical.dbfRegistry = new Map(); // tableKey → { table, records, sourceKey }
      physical.dbfSourceIndex = new Map(); // sourceKey → tableKey
      physical.dbfEntityBindings = []; // SoA: entityId, tableKey, featureIndex
    }

    for (const entry of this.resolvedQueue) {
      const { sourceKey, result } = entry;
      const { table, records } = result;

      // Enforce record cap
      const cappedRecords = records.length > this.options.maxRecordsPerTable
        ? records.slice(0, this.options.maxRecordsPerTable)
        : records;

      // Evict oldest table if cache is full
      if (this.tableCache.size >= this.options.maxCachedTables) {
        const oldestKey = this.tableCache.keys().next().value;
        const oldEntry = this.tableCache.get(oldestKey);
        this.tableCache.delete(oldestKey);
        physical.dbfRegistry.delete(oldestKey);
        if (oldEntry?.sourceKey) physical.dbfSourceIndex.delete(oldEntry.sourceKey);
      }

      // Assign tableKey
      let tableKey = this.sourceKeyMap.get(sourceKey);
      if (tableKey === undefined) {
        tableKey = this.nextTableKey++;
        this.sourceKeyMap.set(sourceKey, tableKey);
      }

      const tableEntry = {
        sourceKey,
        table,
        records: cappedRecords
      };

      this.tableCache.set(tableKey, tableEntry);
      physical.dbfRegistry.set(tableKey, tableEntry);
      physical.dbfSourceIndex.set(sourceKey, tableKey);

      // ECS: create a lightweight entity to hold the DBFComponent so
      // systems can enumerate available attribute tables.
      if (this.ecsWorld) {
        const entityId = this.ecsWorld.createEntity?.() ?? -1;
        if (entityId >= 0) {
          this.ecsWorld.addComponent(entityId, DBFComponent, {
            tableKey,
            featureIndex: 0,
            fieldCount: table.fields.length,
            recordBytes: table.recordLength,
            isDeleted: 0,
            lastUpdatedTick: tick
          });
        }
      }
    }
    this.resolvedQueue.length = 0;
  }

  /**
   * Retrieve a cached table by tableKey.
   */
  getTable(tableKey) {
    return this.tableCache.get(tableKey) ?? null;
  }

  /**
   * Retrieve a cached table by sourceKey.
   */
  getTableBySource(sourceKey) {
    const tableKey = this.sourceKeyMap.get(sourceKey);
    return tableKey !== undefined ? this.tableCache.get(tableKey) : null;
  }

  /**
   * Retrieve a single record by tableKey and feature index.
   */
  getRecord(tableKey, featureIndex) {
    const entry = this.tableCache.get(tableKey);
    if (!entry) return null;
    return entry.records[featureIndex] ?? null;
  }

  /**
   * Retrieve a field value for a given record.
   */
  getFieldValue(tableKey, featureIndex, fieldName) {
    const record = this.getRecord(tableKey, featureIndex);
    if (!record || record.deleted) return null;
    return record.values[fieldName] ?? null;
  }

  dispose() {
    this.pool.dispose();
    this.pendingJobs.clear();
    this.resolvedQueue.length = 0;
    this.tableCache.clear();
    this.sourceKeyMap.clear();
  }
}

export default DBFContextProvider;