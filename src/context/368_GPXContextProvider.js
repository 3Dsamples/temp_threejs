// file number : 368
// full path name : src/context/368_GPXContextProvider.js
//### Description : Context-aware GPX provider. Parses GPX 1.0 and 1.1 XML
//###               streams entirely off the main thread using a self-contained
//###               streaming XML tokenizer (no DOMParser, no external loader,
//###               no CDN access, no static server). Reconstructs waypoints,
//###               routes, and track segments as procedural 3D line geometries
//###               with per-vertex elevation and time stamps, procedurally
//###               generating all vertex, index, and timing data from the raw
//###               XML parameters. Every track segment inherits its track name
//###               (hashed for ECS provenance), and every feature is bound to
//###               an ECS entity so the living world can animate it, query it,
//###               and react to it. Supports optional latitude/longitude →
//###               world-unit scaling, elevation Z-scaling, and a timeline
//###               attachment model where each vertex carries a Unix-epoch
//###               timestamp for temporal-layer integration. Results are merged
//###               only into the next frame’s build stage, never the current
//###               one. Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap, and scales from a
//###               single 10-unit waypoint to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : Streaming GPS tracks, routes, and waypoints into a procedurally-
//###            generated terrain world. Ideal for athletic trails, vehicle
//###            paths, drone routes, migratory corridors, patrol circuits, and
//###            any timeline-driven feature where elevation and time matter.
//###            The track timeline integrates directly with the living world’s
//###            temporal channel, enabling replay, prediction, and procedural
//###            reaction to movement events.
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
  // textures (procedural masks if a GPX feature drives terrain painting)
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
// 1. ECS COMPONENT – GPX feature provenance
// ---------------------------------------------------------------------------

/**
 * GPXComponent — one per GPX feature (waypoint, route, or track segment).
 * Stores feature kind, vertex/index ranges, name hash, elevation presence,
 * timeline presence, and time start/end in seconds since Unix epoch.
 */
export class GPXComponent {
  static schema = {
    featureKind:     { type: 'u8' },    // 0=waypoint, 1=route, 2=track segment
    featureIndex:    { type: 'u32' },
    vertexStart:     { type: 'u32' },
    vertexCount:     { type: 'u32' },
    indexStart:      { type: 'u32' },
    indexCount:      { type: 'u32' },
    nameHash:        { type: 'u32' },
    hasElevation:    { type: 'u8' },
    hasTime:         { type: 'u8' },
    timeStart:       { type: 'f64' },  // seconds, Unix epoch
    timeEnd:         { type: 'f64' },
    lastUpdatedTick: { type: 'u32' }
  };
}

// Feature kind enum, matching the ECS schema.
const GPX_KIND = { WAYPOINT: 0, ROUTE: 1, TRACK_SEGMENT: 2 };

// ---------------------------------------------------------------------------
// 2. GPX WORKER – streaming XML tokenizer + procedural geometry builder
// ---------------------------------------------------------------------------

const GPX_WORKER_SOURCE = `
  // Self-contained streaming GPX parser. No DOM, no external loader.
  // Tokenizes XML by scanning for '<' and '>' bytes, then walks a finite
  // state machine that emits waypoints, routes, and track segments.
  // Every vertex carries (x, y, z, time) where x=lon, y=lat (scaled),
  // z=elevation (scaled), and time=Unix-epoch seconds (0 if absent).

  const GPX_KIND = { WAYPOINT: 0, ROUTE: 1, TRACK_SEGMENT: 2 };

  self.onmessage = function (e) {
    const { id, text, zScale, coordScale, outputKind } = e.data;
    try {
      const result = parseGPX(text, zScale || 1.0, coordScale || 1.0, outputKind || 7);
      const payload = {
        id,
        positions: result.positions,
        indices: result.indices,
        times: result.times,
        bounds: result.bounds,
        featureKind: result.featureKind,
        featureVertexStart: result.featureVertexStart,
        featureVertexCount: result.featureVertexCount,
        featureIndexStart: result.featureIndexStart,
        featureIndexCount: result.featureIndexCount,
        featureNameHash: result.featureNameHash,
        featureHasElevation: result.featureHasElevation,
        featureHasTime: result.featureHasTime,
        featureTimeStart: result.featureTimeStart,
        featureTimeEnd: result.featureTimeEnd,
        featureCount: result.featureCount
      };
      const transfer = [
        payload.positions.buffer,
        payload.indices.buffer,
        payload.times.buffer,
        payload.featureVertexStart.buffer,
        payload.featureVertexCount.buffer,
        payload.featureIndexStart.buffer,
        payload.featureIndexCount.buffer,
        payload.featureNameHash.buffer,
        payload.featureHasElevation.buffer,
        payload.featureHasTime.buffer,
        payload.featureTimeStart.buffer,
        payload.featureTimeEnd.buffer
      ];
      self.postMessage(payload, transfer);
    } catch (err) {
      self.postMessage({ id, error: err.message });
    }
  };

  function parseGPX(text, zScale, coordScale, outputKind) {
    const positions = [];
    const indices = [];
    const times = [];

    const featureKind = [];
    const featureVertexStart = [];
    const featureVertexCount = [];
    const featureIndexStart = [];
    const featureIndexCount = [];
    const featureNameHash = [];
    const featureHasElevation = [];
    const featureHasTime = [];
    const featureTimeStart = [];
    const featureTimeEnd = [];

    let currentKind = -1;
    let currentPoints = [];
    let currentName = '';
    let currentPoint = null;
    let inEle = false;
    let inTime = false;
    let inName = false;
    let inTrackName = false;
    let trackName = '';
    let inTrk = false;

    function flushFeature() {
      if (currentPoints.length === 0) {
        currentPoints = [];
        currentName = '';
        return;
      }
      // Honor outputKind filter (bitmask: 1=waypoint, 2=route, 4=track)
      const mask = currentKind === 0 ? 1 : currentKind === 1 ? 2 : 4;
      if ((outputKind & mask) === 0) {
        currentPoints = [];
        currentName = '';
        return;
      }
      const vStart = positions.length / 3;
      const iStart = indices.length;
      let hasEle = false, hasTime = false;
      let minT = Infinity, maxT = -Infinity;
      for (let k = 0; k < currentPoints.length; k++) {
        const p = currentPoints[k];
        positions.push(p.x, p.y, p.z);
        times.push(p.time || 0);
        if (p.z !== 0) hasEle = true;
        if (p.time > 0) {
          hasTime = true;
          if (p.time < minT) minT = p.time;
          if (p.time > maxT) maxT = p.time;
        }
      }
      if (currentPoints.length === 1) {
        // Degenerate single-vertex marker for point rendering.
        indices.push(vStart, vStart, vStart);
      } else {
        // Line segments encoded as degenerate triangle pairs
        // (v_i, v_{i+1}, v_{i+1}) so consumers can render either as
        // LineSegments (stride 2) or as triangle-pair line shader.
        for (let k = 1; k < currentPoints.length; k++) {
          indices.push(vStart + k - 1, vStart + k, vStart + k);
        }
      }
      featureVertexStart.push(vStart);
      featureVertexCount.push(currentPoints.length);
      featureIndexStart.push(iStart);
      featureIndexCount.push(indices.length - iStart);
      featureKind.push(currentKind);
      featureHasElevation.push(hasEle ? 1 : 0);
      featureHasTime.push(hasTime ? 1 : 0);
      featureTimeStart.push(hasTime ? minT : 0);
      featureTimeEnd.push(hasTime ? maxT : 0);
      // FNV-1a hash of the feature name.
      let h = 2166136261 >>> 0;
      for (let k = 0; k < currentName.length; k++) {
        h ^= currentName.charCodeAt(k);
        h = (h * 16777619) >>> 0;
      }
      featureNameHash.push(h);
      currentPoints = [];
      currentName = '';
    }

    function parseLatLon(tagBody) {
      const latMatch = tagBody.match(/lat\\s*=\\s*"([^"]+)"/);
      const lonMatch = tagBody.match(/lon\\s*=\\s*"([^"]+)"/);
      return {
        x: (lonMatch ? parseFloat(lonMatch[1]) : 0) * coordScale,
        y: (latMatch ? parseFloat(latMatch[1]) : 0) * coordScale,
        z: 0,
        time: 0
      };
    }

    const len = text.length;
    let i = 0;

    while (i < len) {
      // ---- Text content between tags ----
      if (text.charCodeAt(i) !== 60) { // not '<'
        let nextLt = text.indexOf('<', i);
        if (nextLt < 0) nextLt = len;
        const txt = text.slice(i, nextLt);
        i = nextLt;
        if (inEle && currentPoint) {
          const v = parseFloat(txt);
          if (!isNaN(v)) currentPoint.z = v * zScale;
          inEle = false;
        } else if (inTime && currentPoint) {
          const t = Date.parse(txt);
          if (!isNaN(t)) currentPoint.time = t / 1000;
          inTime = false;
        } else if (inName) {
          currentName = txt.trim();
          inName = false;
        } else if (inTrackName) {
          trackName = txt.trim();
          inTrackName = false;
        }
        continue;
      }

      // ---- Tag parsing ----
      const tagEnd = text.indexOf('>', i);
      if (tagEnd < 0) break;
      const tagBody = text.slice(i + 1, tagEnd);
      i = tagEnd + 1;

      // Skip XML declarations, comments, CDATA, processing instructions.
      if (tagBody.startsWith('?') || tagBody.startsWith('!')) continue;

      const isClosing = tagBody[0] === '/';
      const selfClose = tagBody[tagBody.length - 1] === '/';

      let nameStart = isClosing ? 1 : 0;
      let nameEnd = nameStart;
      while (nameEnd < tagBody.length && !/[\\s>\\/]/.test(tagBody[nameEnd])) nameEnd++;
      let tagName = tagBody.slice(nameStart, nameEnd);
      const colon = tagName.indexOf(':');
      if (colon >= 0) tagName = tagName.slice(colon + 1); // strip namespace

      if (isClosing) {
        if (tagName === 'wpt') {
          if (currentPoint) currentPoints.push(currentPoint);
          currentPoint = null;
          flushFeature();
          currentKind = -1;
        } else if (tagName === 'rte') {
          flushFeature();
          currentKind = -1;
        } else if (tagName === 'trkseg') {
          flushFeature();
          currentKind = -1;
        } else if (tagName === 'trk') {
          inTrk = false;
          trackName = '';
        } else if (tagName === 'rtept' || tagName === 'trkpt') {
          if (currentPoint) currentPoints.push(currentPoint);
          currentPoint = null;
        }
      } else {
        if (tagName === 'wpt') {
          currentKind = GPX_KIND.WAYPOINT;
          currentPoints = [];
          currentName = '';
          currentPoint = parseLatLon(tagBody);
          if (selfClose) {
            currentPoints.push(currentPoint);
            currentPoint = null;
            flushFeature();
            currentKind = -1;
          }
        } else if (tagName === 'rte') {
          currentKind = GPX_KIND.ROUTE;
          currentPoints = [];
          currentName = '';
        } else if (tagName === 'trk') {
          inTrk = true;
          trackName = '';
        } else if (tagName === 'trkseg') {
          currentKind = GPX_KIND.TRACK_SEGMENT;
          currentPoints = [];
          currentName = trackName;
        } else if (tagName === 'rtept' || tagName === 'trkpt') {
          currentPoint = parseLatLon(tagBody);
          if (selfClose) {
            currentPoints.push(currentPoint);
            currentPoint = null;
          }
        } else if (tagName === 'ele') {
          inEle = true;
        } else if (tagName === 'time') {
          inTime = true;
        } else if (tagName === 'name') {
          if (currentKind === GPX_KIND.WAYPOINT || currentKind === GPX_KIND.ROUTE) {
            inName = true;
          } else if (inTrk && currentKind === -1) {
            inTrackName = true;
          }
        }
      }
    }

    // Flush any trailing feature (defensive).
    if (currentPoints.length > 0) flushFeature();

    // ---- Compute bounds ----
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < positions.length; k += 3) {
      const x = positions[k], y = positions[k + 1], z = positions[k + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (positions.length === 0) {
      minX = minY = minZ = 0;
      maxX = maxY = maxZ = 0;
    }

    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      times: new Float64Array(times),
      bounds: [minX, minY, minZ, maxX, maxY, maxZ],
      featureKind: new Uint8Array(featureKind),
      featureVertexStart: new Uint32Array(featureVertexStart),
      featureVertexCount: new Uint32Array(featureVertexCount),
      featureIndexStart: new Uint32Array(featureIndexStart),
      featureIndexCount: new Uint32Array(featureIndexCount),
      featureNameHash: new Uint32Array(featureNameHash),
      featureHasElevation: new Uint8Array(featureHasElevation),
      featureHasTime: new Uint8Array(featureHasTime),
      featureTimeStart: new Float64Array(featureTimeStart),
      featureTimeEnd: new Float64Array(featureTimeEnd),
      featureCount: featureVertexStart.length
    };
  }
`;

// ---------------------------------------------------------------------------
// 3. WORKER POOL – priority queue, cancellation, backpressure
// ---------------------------------------------------------------------------

class GPXWorkerPool {
  constructor(maxWorkers = 2) {
    this.maxWorkers = maxWorkers;
    this.workers = [];
    this.queue = [];
    this.activeJobs = new Map();
    this.nextJobId = 1;
    this._init();
  }

  _init() {
    const blob = new Blob([GPX_WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    for (let i = 0; i < this.maxWorkers; i++) {
      const w = new Worker(url);
      w.onmessage = (e) => this._onWorkerMessage(w, e.data);
      w.onerror = (e) => this._onWorkerError(w, e);
      this.workers.push({ worker: w, busy: false, currentJobId: null });
    }
    URL.revokeObjectURL(url);
  }

  enqueue(text, zScale, coordScale, outputKind, priority) {
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      this.queue.push({ id, text, zScale, coordScale, outputKind, priority, resolve, reject });
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
        text: job.text,
        zScale: job.zScale,
        coordScale: job.coordScale,
        outputKind: job.outputKind
      });
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
    const blob = new Blob([GPX_WORKER_SOURCE], { type: 'application/javascript' });
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

const OUTPUT_KIND_NAMES = {
  all: 7,
  waypoints: 1,
  routes: 2,
  tracks: 4
};

export class GPXContextProvider {
  constructor(options = {}) {
    this.options = {
      maxWorkers: options.maxWorkers ?? 2,
      maxPendingJobs: options.maxPendingJobs ?? 32,
      targetHz: options.targetHz ?? 10,
      materialIdForTerrain: options.materialIdForTerrain ?? 1,
      boundingSpherePadding: options.boundingSpherePadding ?? 1.05,
      priorityDistanceScale: options.priorityDistanceScale ?? 0.01,
      zScale: options.zScale ?? 1.0,
      coordScale: options.coordScale ?? 1.0,
      outputKind: options.outputKind ?? 'all',
      ...options
    };

    this.outputKindMask = OUTPUT_KIND_NAMES[this.options.outputKind];
    if (this.outputKindMask === undefined) this.outputKindMask = 7;

    this.pool = new GPXWorkerPool(this.options.maxWorkers);
    this.pendingJobs = new Map();
    this.resolvedQueue = [];
    this.nextInternalId = 1;

    this.frame = null;
    this.ecsWorld = null;
    this.lastTick = 0;
    this._accumulator = 0;

    this._geometryBuffer = new Map(); // entityId → geometry view
    this._sourceMetadata = new Map(); // sourceKey → header metadata

    this.eventDispatcher = null;
  }

  /**
   * Provider contract: called by the runtime at its declared tier (10 Hz).
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
   * Public entry point (blueprint step 34): ingest a GPX XML document.
   * No loader is used — the XML is tokenized and geometry is procedurally
   * reconstructed from the raw parameters.
   *
   * @param {string|ArrayBuffer|Uint8Array} input – GPX XML text or bytes
   * @param {string} sourceKey – unique key (e.g. file path or logical name)
   * @param {object} [options] – { zScale, coordScale, outputKind, priority }
   * @returns {Promise<number>} resolves with the internal job id
   */
  ingest(input, sourceKey, options = {}) {
    if (this.pendingJobs.size >= this.options.maxPendingJobs) {
      return Promise.reject(new Error('GPX ingest queue full (backpressure)'));
    }

    let text;
    if (typeof input === 'string') {
      text = input;
    } else if (input instanceof ArrayBuffer) {
      text = new TextDecoder('utf-8').decode(new Uint8Array(input));
    } else if (input instanceof Uint8Array) {
      text = new TextDecoder('utf-8').decode(input);
    } else {
      return Promise.reject(new Error('GPX ingest expects string, ArrayBuffer, or Uint8Array'));
    }

    const {
      zScale = this.options.zScale,
      coordScale = this.options.coordScale,
      outputKind = this.outputKindMask,
      priority = 0
    } = options;

    const internalId = this.nextInternalId++;

    let effectivePriority = priority;
    if (this.frame?.layers.player?.position) {
      const cam = this.frame.layers.player.position;
      const d2 = cam[0] * cam[0] + cam[1] * cam[1] + cam[2] * cam[2];
      effectivePriority += 1 / (1 + d2 * this.options.priorityDistanceScale);
    }

    const promise = this.pool.enqueue(text, zScale, coordScale, outputKind, effectivePriority)
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
      sourceKey, options, priority: effectivePriority, promise
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

    if (!spatial.gpxGeometryBounds) {
      spatial.gpxGeometryBounds = [];
      spatial.gpxBoundingSpheres = [];
      spatial.gpxMaterialIds = [];
      spatial.gpxEntityIds = [];
      spatial.gpxSourceIndex = new Map();
      spatial.gpxFeatureKind = [];
    }

    for (const entry of this.resolvedQueue) {
      const { sourceKey, result } = entry;
      const {
        positions, indices, times, bounds, featureCount,
        featureKind, featureVertexStart, featureVertexCount,
        featureIndexStart, featureIndexCount,
        featureNameHash, featureHasElevation, featureHasTime,
        featureTimeStart, featureTimeEnd
      } = result;

      const [gMinX, gMinY, gMinZ, gMaxX, gMaxY, gMaxZ] = bounds;
      const entityIds = [];

      for (let f = 0; f < featureCount; f++) {
        const vs = featureVertexStart[f];
        const vc = featureVertexCount[f];
        const is = featureIndexStart[f];
        const ic = featureIndexCount[f];
        if (vc === 0 && ic === 0) continue;

        // Per-feature bounding sphere.
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
          this.ecsWorld.addComponent(entityId, GPXComponent, {
            featureKind: featureKind[f],
            featureIndex: f,
            vertexStart: vs,
            vertexCount: vc,
            indexStart: is,
            indexCount: ic,
            nameHash: featureNameHash[f],
            hasElevation: featureHasElevation[f],
            hasTime: featureHasTime[f],
            timeStart: featureTimeStart[f],
            timeEnd: featureTimeEnd[f],
            lastUpdatedTick: tick
          });
        }

        // Push into the frame's spatial SoA.
        spatial.gpxGeometryBounds.push(rMinX, rMinY, rMinZ, rMaxX, rMaxY, rMaxZ);
        spatial.gpxBoundingSpheres.push(cx, cy, cz, radius);
        spatial.gpxMaterialIds.push(this.options.materialIdForTerrain);
        spatial.gpxEntityIds.push(entityId);
        spatial.gpxFeatureKind.push(featureKind[f]);

        // Per-entity geometry view (shared references into worker buffers).
        this._geometryBuffer.set(entityId, {
          positions,
          indices,
          times,
          vertexStart: vs,
          vertexCount: vc,
          indexStart: is,
          indexCount: ic,
          featureKind: featureKind[f],
          hasElevation: featureHasElevation[f] === 1,
          hasTime: featureHasTime[f] === 1,
          timeStart: featureTimeStart[f],
          timeEnd: featureTimeEnd[f],
          nameHash: featureNameHash[f],
          sourceKey
        });

        entityIds.push(entityId);
      }

      // Source metadata.
      this._sourceMetadata.set(sourceKey, {
        featureCount,
        bounds,
        entityIds,
        globalBounds: [gMinX, gMinY, gMinZ, gMaxX, gMaxY, gMaxZ]
      });

      spatial.gpxSourceIndex.set(sourceKey, entityIds);
    }
    this.resolvedQueue.length = 0;
  }

  /**
   * Retrieve the shared geometry view for a GPX feature entity.
   * Called by the batched dispatch stage (stage six) — never mid-frame.
   */
  getGeometryForEntity(entityId) {
    return this._geometryBuffer.get(entityId) ?? null;
  }

  /**
   * Retrieve metadata for a given source.
   */
  getSourceMetadata(sourceKey) {
    return this._sourceMetadata.get(sourceKey) ?? null;
  }

  /**
   * Sample the position of a feature at a given Unix-epoch timestamp (seconds).
   * Performs linear interpolation between vertices by time. Returns null if the
   * feature has no time data or the timestamp is outside the feature's range.
   */
  sampleAtTime(entityId, unixTimeSeconds) {
    const geom = this._geometryBuffer.get(entityId);
    if (!geom || !geom.hasTime) return null;
    if (unixTimeSeconds < geom.timeStart || unixTimeSeconds > geom.timeEnd) return null;

    const vs = geom.vertexStart;
    const vc = geom.vertexCount;
    const { positions, times } = geom;

    // Binary search over the feature's time range.
    let lo = vs, hi = vs + vc - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < unixTimeSeconds) lo = mid;
      else hi = mid;
    }
    const t0 = times[lo], t1 = times[hi];
    const alpha = (t1 > t0) ? (unixTimeSeconds - t0) / (t1 - t0) : 0;

    const x = positions[lo * 3] + (positions[hi * 3] - positions[lo * 3]) * alpha;
    const y = positions[lo * 3 + 1] + (positions[hi * 3 + 1] - positions[lo * 3 + 1]) * alpha;
    const z = positions[lo * 3 + 2] + (positions[hi * 3 + 2] - positions[lo * 3 + 2]) * alpha;

    return { x, y, z, alpha };
  }

  dispose() {
    this.pool.dispose();
    this.pendingJobs.clear();
    this.resolvedQueue.length = 0;
    this._geometryBuffer.clear();
    this._sourceMetadata.clear();
  }
}

export default GPXContextProvider;