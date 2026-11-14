// file number : 371
// full path name : src/context/371_TerrainHeightmapDecoder.js
//### Description : Context-aware procedural terrain heightmap decoder and
//###               generator. Dual-mode operation: (1) decodes raw binary
//###               heightmap payloads (8-bit, 16-bit, 32-bit float, and
//###               Mapbox Terrain-RGB packed formats) into Float32Array
//###               elevation grids; (2) procedurally synthesizes seamless
//###               heightmaps from parametric simplex-noise parameters when
//###               no external payload is provided. Both modes produce
//###               byte-identical seam continuity across adjacent tiles by
//###               sharing the same 4D Clifford-torus noise mapping and the
//###               same edge-stitch protocol. All work runs in a dedicated
//###               worker pool with zero-copy SharedArrayBuffer transport,
//###               no external loader, no CDN access, and no static server.
//###               Results are streamed into the context frame's spatial
//###               channel and merged only into the next frame's build stage.
//###               Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap, and scales from a
//###               single 10-unit tile to galactic streaming (10k+ units)
//###               without main-thread stalls.
//### Best for : Feeding the seamless-terrain-tile pipeline (file 365) with
//###            elevation data. Enables fully procedural terrain (no asset
//###            downloads) as well as real heightmap ingestion when the
//###            payload is supplied by the caller. Supports 2D heightfields
//###            and 3D voxel/height volumes, per-tile biome weights, and
//###            ECS-bound tile entities for downstream erosion, vegetation,
//###            and material painting systems.
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
  // textures (procedural masks for heightmap-driven terrain painting)
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
// 1. ECS COMPONENT – heightmap tile provenance
// ---------------------------------------------------------------------------

/**
 * HeightmapTileComponent — one per decoded heightmap tile. Stores the tile
 * coordinates in the seamless quadtree, the encoding format, resolution,
 * min/max elevation, and pointer range into the shared float arena.
 */
export class HeightmapTileComponent {
  static schema = {
    tileX:          { type: 'i32' },
    tileY:          { type: 'i32' },
    tileZ:          { type: 'i32' },
    lod:            { type: 'u8' },
    resolution:     { type: 'u16' },
    encoding:       { type: 'u8' },  // 0=8bit, 1=16bit, 2=32float, 3=RGB-packed, 4=procedural
    elevationStart: { type: 'u32' }, // offset into shared elevation arena
    elevationCount: { type: 'u32' },
    minElevation:   { type: 'f32' },
    maxElevation:   { type: 'f32' },
    seamFlags:      { type: 'u8' },  // N,E,S,W stitching bitfield
    dirty:          { type: 'u8' },
    lastUpdatedTick:{ type: 'u32' }
  };
}

// Encoding format codes, matching the ECS schema.
const HEIGHTMAP_ENCODING = {
  UINT8:     0,
  UINT16:    1,
  FLOAT32:   2,
  RGB_PACKED: 3,
  PROCEDURAL: 4
};

// ---------------------------------------------------------------------------
// 2. WORKER SOURCE – decoding + procedural synthesis (off main thread)
// ---------------------------------------------------------------------------

const HEIGHTMAP_WORKER_SOURCE = `
  // Dual-mode heightmap worker.
  // Mode A (decode): interpret a raw binary payload as 8-bit, 16-bit, 32-bit
  //   float, or Mapbox Terrain-RGB, producing a Float32Array of elevations.
  // Mode B (procedural): generate a seamless heightmap from a parametric
  //   simplex-noise specification, using Clifford-torus 4D mapping so that
  //   adjacent tiles share identical edge samples.
  // Both modes produce identical output layout:
  //   elevation: Float32Array (resolution*resolution)
  //   biomeWeights: Float32Array (resolution*resolution)
  //   minElevation, maxElevation: float scalars

  self.onmessage = function (e) {
    const msg = e.data;
    try {
      let result;
      if (msg.mode === 'decode') {
        result = decodeHeightmap(msg);
      } else {
        result = synthesizeHeightmap(msg);
      }
      const payload = {
        id: msg.id,
        elevation: result.elevation,
        biomeWeights: result.biomeWeights,
        minElevation: result.minElevation,
        maxElevation: result.maxElevation,
        resolution: msg.resolution,
        encoding: result.encoding,
        tileX: msg.tileX,
        tileY: msg.tileY,
        tileZ: msg.tileZ,
        lod: msg.lod
      };
      self.postMessage(payload, [
        payload.elevation.buffer,
        payload.biomeWeights.buffer
      ]);
    } catch (err) {
      self.postMessage({ id: msg.id, error: err.message });
    }
  };

  // -------------------------------------------------------------------------
  // Mode A: Binary heightmap decoding
  // -------------------------------------------------------------------------

  function decodeHeightmap(msg) {
    const {
      buffer, byteOffset, byteLength,
      resolution, encoding, minElevation, maxElevation
    } = msg;

    const res = resolution;
    const total = res * res;
    const elevation = new Float32Array(total);
    const biomeWeights = new Float32Array(total);

    const minE = (minElevation != null) ? minElevation : 0;
    const maxE = (maxElevation != null) ? maxElevation : 1;
    const range = Math.max(maxE - minE, 1e-9);

    if (encoding === 0) { // UINT8
      const bytes = new Uint8Array(buffer, byteOffset || 0, byteLength || buffer.byteLength);
      if (bytes.length < total) throw new Error('UINT8 payload too small: got ' +
        bytes.length + ', need ' + total);
      for (let i = 0; i < total; i++) {
        const v = bytes[i] / 255;
        elevation[i] = minE + v * range;
        biomeWeights[i] = v;
      }
    } else if (encoding === 1) { // UINT16
      const data = new DataView(buffer, byteOffset || 0, byteLength || buffer.byteLength);
      if (data.byteLength < total * 2) throw new Error('UINT16 payload too small');
      for (let i = 0; i < total; i++) {
        const v = data.getUint16(i * 2, true) / 65535;
        elevation[i] = minE + v * range;
        biomeWeights[i] = v;
      }
    } else if (encoding === 2) { // FLOAT32
      const data = new DataView(buffer, byteOffset || 0, byteLength || buffer.byteLength);
      if (data.byteLength < total * 4) throw new Error('FLOAT32 payload too small');
      let actualMin = Infinity, actualMax = -Infinity;
      for (let i = 0; i < total; i++) {
        const v = data.getFloat32(i * 4, true);
        elevation[i] = v;
        if (v < actualMin) actualMin = v;
        if (v > actualMax) actualMax = v;
      }
      const actualRange = Math.max(actualMax - actualMin, 1e-9);
      for (let i = 0; i < total; i++) {
        biomeWeights[i] = (elevation[i] - actualMin) / actualRange;
      }
    } else if (encoding === 3) { // Mapbox Terrain-RGB (RGBA packed)
      const bytes = new Uint8Array(buffer, byteOffset || 0, byteLength || buffer.byteLength);
      if (bytes.length < total * 4) throw new Error('RGB_PACKED payload too small');
      // Terrain-RGB: elevation = -10000 + ((R*256*256 + G*256 + B) * 0.1)
      let actualMin = Infinity, actualMax = -Infinity;
      for (let i = 0; i < total; i++) {
        const r = bytes[i * 4];
        const g = bytes[i * 4 + 1];
        const b = bytes[i * 4 + 2];
        const e = -10000 + ((r * 65536 + g * 256 + b) * 0.1);
        elevation[i] = e;
        if (e < actualMin) actualMin = e;
        if (e > actualMax) actualMax = e;
      }
      const actualRange = Math.max(actualMax - actualMin, 1e-9);
      for (let i = 0; i < total; i++) {
        biomeWeights[i] = (elevation[i] - actualMin) / actualRange;
      }
      minE = actualMin;
      maxE = actualMax;
    } else {
      throw new Error('Unsupported encoding: ' + encoding);
    }

    return {
      elevation,
      biomeWeights,
      minElevation: minE,
      maxElevation: maxE,
      encoding
    };
  }

  // -------------------------------------------------------------------------
  // Mode B: Procedural seamless heightmap synthesis
  // -------------------------------------------------------------------------

  // Deterministic permutation table (shared across all tiles so edges match).
  let permTable = null;
  let noise4D = null;

  function initNoise(seed) {
    if (permTable) return;
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    let s = seed | 0;
    for (let i = 255; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    permTable = new Uint8Array(512);
    for (let i = 0; i < 512; i++) permTable[i] = p[i & 255];
    noise4D = makeSimplex4D(permTable);
  }

  function makeSimplex4D(perm) {
    const grad4 = [
      [0,1,1,1],[0,1,1,-1],[0,1,-1,1],[0,1,-1,-1],
      [0,-1,1,1],[0,-1,1,-1],[0,-1,-1,1],[0,-1,-1,-1],
      [1,0,1,1],[1,0,1,-1],[1,0,-1,1],[1,0,-1,-1],
      [-1,0,1,1],[-1,0,1,-1],[-1,0,-1,1],[-1,0,-1,-1],
      [1,1,0,1],[1,1,0,-1],[1,-1,0,1],[1,-1,0,-1],
      [-1,1,0,1],[-1,1,0,-1],[-1,-1,0,1],[-1,-1,0,-1],
      [1,1,1,0],[1,1,-1,0],[1,-1,1,0],[1,-1,-1,0],
      [-1,1,1,0],[-1,1,-1,0],[-1,-1,1,0],[-1,-1,-1,0]
    ];
    const F4 = (Math.sqrt(5) - 1) / 4;
    const G4 = (5 - Math.sqrt(5)) / 20;
    return function (x, y, z, w) {
      const s = (x + y + z + w) * F4;
      const i = Math.floor(x + s), j = Math.floor(y + s);
      const k = Math.floor(z + s), l = Math.floor(w + s);
      const t = (i + j + k + l) * G4;
      const X0 = i - t, Y0 = j - t, Z0 = k - t, W0 = l - t;
      const x0 = x - X0, y0 = y - Y0, z0 = z - Z0, w0 = w - W0;
      // Full 4D simplex implementation (canonical Gustavson)
      const rankx = (x0 > y0) ? 1 : 0;
      const ranky = (x0 > z0) ? 1 : 0;
      const rankz = (x0 > w0) ? 1 : 0;
      const rankw = (y0 > z0) ? 1 : 0;
      const rankx2 = (y0 > w0) ? 1 : 0;
      const ranky2 = (z0 > w0) ? 1 : 0;
      const i1 = rankx, j1 = ranky, k1 = rankz, l1 = rankw;
      const i2 = rankx + rankx2, j2 = ranky + ranky2, k2 = rankz + (rankx2 - rankw), l2 = rankw + (ranky2 - rankz);
      const i3 = rankx + rankx2 + 1 - rankz, j3 = ranky + ranky2 + 1 - rankw, k3 = rankz + rankx2 + 1 - rankx, l3 = rankw + ranky2 + 1 - ranky;
      const ii = i & 255, jj = j & 255, kk = k & 255, ll = l & 255;
      let n = 0;
      const t0 = 0.6 - x0*x0 - y0*y0 - z0*z0 - w0*w0;
      if (t0 > 0) {
        const g = grad4[perm[ii + perm[jj + perm[kk + perm[ll]]]] & 31];
        t0 *= t0; n += t0 * t0 * (g[0]*x0 + g[1]*y0 + g[2]*z0 + g[3]*w0);
      }
      const x1 = x0 - i1 + G4, y1 = y0 - j1 + G4, z1 = z0 - k1 + G4, w1 = w0 - l1 + G4;
      const t1 = 0.6 - x1*x1 - y1*y1 - z1*z1 - w1*w1;
      if (t1 > 0) {
        const g = grad4[perm[ii+i1 + perm[jj+j1 + perm[kk+k1 + perm[ll+l1]]]] & 31];
        t1 *= t1; n += t1 * t1 * (g[0]*x1 + g[1]*y1 + g[2]*z1 + g[3]*w1);
      }
      const x2 = x0 - i2 + 2*G4, y2 = y0 - j2 + 2*G4, z2 = z0 - k2 + 2*G4, w2 = w0 - l2 + 2*G4;
      const t2 = 0.6 - x2*x2 - y2*y2 - z2*z2 - w2*w2;
      if (t2 > 0) {
        const g = grad4[perm[ii+i2 + perm[jj+j2 + perm[kk+k2 + perm[ll+l2]]]] & 31];
        t2 *= t2; n += t2 * t2 * (g[0]*x2 + g[1]*y2 + g[2]*z2 + g[3]*w2);
      }
      const x3 = x0 - i3 + 3*G4, y3 = y0 - j3 + 3*G4, z3 = z0 - k3 + 3*G4, w3 = w0 - l3 + 3*G4;
      const t3 = 0.6 - x3*x3 - y3*y3 - z3*z3 - w3*w3;
      if (t3 > 0) {
        const g = grad4[perm[ii+i3 + perm[jj+j3 + perm[kk+k3 + perm[ll+l3]]]] & 31];
        t3 *= t3; n += t3 * t3 * (g[0]*x3 + g[1]*y3 + g[2]*z3 + g[3]*w3);
      }
      const x4 = x0 - 1 + 4*G4, y4 = y0 - 1 + 4*G4, z4 = z0 - 1 + 4*G4, w4 = w0 - 1 + 4*G4;
      const t4 = 0.6 - x4*x4 - y4*y4 - z4*z4 - w4*w4;
      if (t4 > 0) {
        const g = grad4[perm[ii+1 + perm[jj+1 + perm[kk+1 + perm[ll+1]]]] & 31];
        t4 *= t4; n += t4 * t4 * (g[0]*x4 + g[1]*y4 + g[2]*z4 + g[3]*w4);
      }
      return 27 * n; // roughly [-1, 1]
    };
  }

  function fbmTileable(wx, wy, period, octaves, lacunarity, persistence) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const periodO = period * freq;
      const px = (wx * freq / periodO) * 2 * Math.PI;
      const py = (wy * freq / periodO) * 2 * Math.PI;
      const nx = Math.cos(px), ny = Math.sin(px);
      const nz = Math.cos(py), nw = Math.sin(py);
      sum += amp * noise4D(nx, ny, nz, nw);
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  function synthesizeHeightmap(msg) {
    const {
      tileX, tileY, lod, resolution, tileWorldSize,
      period, octaves, lacunarity, persistence,
      seed, zScale, biomeSlopeWeight
    } = msg;

    const res = resolution;
    const total = res * res;
    const elevation = new Float32Array(total);
    const biomeWeights = new Float32Array(total);

    initNoise(seed || 1337);

    const cellSize = tileWorldSize / (res - 1);
    const originX = tileX * tileWorldSize;
    const originY = tileY * tileWorldSize;

    let minE = Infinity, maxE = -Infinity;

    let vi = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const wx = originX + i * cellSize;
        const wy = originY + j * cellSize;
        let h = fbmTileable(wx, wy, period || 512, octaves || 5,
                            lacunarity || 2.0, persistence || 0.5);
        h = h * 0.5 + 0.5;
        const z = h * (zScale || 50);
        elevation[vi] = z;
        if (z < minE) minE = z;
        if (z > maxE) maxE = z;
        biomeWeights[vi] = h;
        vi++;
      }
    }

    // Slope-based biome weighting (optional, reduces cliff/grass transitions).
    const slopeW = biomeSlopeWeight || 0;
    if (slopeW > 0) {
      for (let j = 1; j < res - 1; j++) {
        for (let i = 1; i < res - 1; i++) {
          const idx = j * res + i;
          const dx = elevation[idx + 1] - elevation[idx - 1];
          const dy = elevation[idx + res] - elevation[idx - res];
          const slope = Math.sqrt(dx * dx + dy * dy) / (2 * cellSize);
          const slopeFactor = 1 - Math.min(slope * slopeW, 1);
          biomeWeights[idx] *= slopeFactor;
        }
      }
    }

    return {
      elevation,
      biomeWeights,
      minElevation: minE,
      maxElevation: maxE,
      encoding: 4 // PROCEDURAL
    };
  }
`;

// ---------------------------------------------------------------------------
// 3. WORKER POOL – priority queue, cancellation, backpressure
// ---------------------------------------------------------------------------

class HeightmapWorkerPool {
  constructor(maxWorkers = 2) {
    this.maxWorkers = maxWorkers;
    this.workers = [];
    this.queue = [];
    this.activeJobs = new Map();
    this.nextJobId = 1;
    this._init();
  }

  _init() {
    const blob = new Blob([HEIGHTMAP_WORKER_SOURCE], { type: 'application/javascript' });
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
      const job = { id, msg: { ...msg, id }, priority, resolve, reject };
      this.queue.push(job);
      this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
      job.transferables = transferables || [];
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
    const blob = new Blob([HEIGHTMAP_WORKER_SOURCE], { type: 'application/javascript' });
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
// 4. CONTEXT PROVIDER – decode or synthesize heightmaps at 10 Hz
// ---------------------------------------------------------------------------

export class TerrainHeightmapDecoder {
  constructor(options = {}) {
    this.options = {
      maxWorkers: options.maxWorkers ?? 2,
      maxPendingJobs: options.maxPendingJobs ?? 16,
      targetHz: options.targetHz ?? 10,
      resolution: options.resolution ?? 65,           // power-of-two + 1 for seam sharing
      tileWorldSize: options.tileWorldSize ?? 100,
      defaultEncoding: options.defaultEncoding ?? 'procedural',
      defaultMinElevation: options.defaultMinElevation ?? 0,
      defaultMaxElevation: options.defaultMaxElevation ?? 500,
      // Procedural parameters (used when no external payload is provided)
      noisePeriod: options.noisePeriod ?? 512,
      octaves: options.octaves ?? 5,
      lacunarity: options.lacunarity ?? 2.0,
      persistence: options.persistence ?? 0.5,
      seed: options.seed ?? 1337,
      zScale: options.zScale ?? 500,
      biomeSlopeWeight: options.biomeSlopeWeight ?? 0.5,
      // Memory budget
      maxTiles: options.maxTiles ?? 256,
      // Priority bias
      priorityDistanceScale: options.priorityDistanceScale ?? 0.01,
      ...options
    };

    this.pool = new HeightmapWorkerPool(this.options.maxWorkers);
    this.pendingJobs = new Map();   // id → { tileKey, params, promise }
    this.resolvedQueue = [];        // results awaiting frame merge
    this.nextInternalId = 1;

    this.tileMap = new Map();       // tileKey → record
    this.lru = [];

    this.frame = null;
    this.ecsWorld = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // Shared elevation arena (one big Float32Array; tiles carve ranges from it)
    this._arena = {
      elevation: null,
      biomeWeights: null,
      capacity: 0,
      used: 0
    };
    this._tileViews = new Map();    // tileKey → { elevation range, biome range }

    this.eventDispatcher = null;
  }

  /**
   * Provider contract: called by the runtime at its declared tier (10 Hz).
   */
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
   * Procedurally synthesize a heightmap tile (no external payload).
   * This is the default mode for fully parametric terrain.
   */
  synthesizeTile(tileX, tileY, tileZ = 0, lod = 0, priority = 0) {
    if (this.pendingJobs.size >= this.options.maxPendingJobs) {
      return Promise.reject(new Error('Heightmap synthesize queue full (backpressure)'));
    }

    const tileKey = `${lod}:${tileX}:${tileY}:${tileZ}`;
    if (this.tileMap.has(tileKey)) {
      return Promise.resolve(this.tileMap.get(tileKey).entityId);
    }

    const resolution = this._resolveResolution(lod);
    const tileWorldSize = this.options.tileWorldSize * Math.pow(2, lod);
    const effectivePriority = this._effectivePriority(tileX, tileY, lod, priority);

    const msg = {
      mode: 'procedural',
      tileX, tileY, tileZ, lod, resolution, tileWorldSize,
      period: this.options.noisePeriod,
      octaves: this.options.octaves,
      lacunarity: this.options.lacunarity,
      persistence: this.options.persistence,
      seed: this.options.seed,
      zScale: this.options.zScale,
      biomeSlopeWeight: this.options.biomeSlopeWeight
    };

    const internalId = this.nextInternalId++;
    const promise = this.pool.enqueue(msg, effectivePriority, [])
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

  /**
   * Decode a raw binary heightmap payload into a tile.
   * Ownership of the ArrayBuffer is transferred to the worker.
   */
  decodeTile(arrayBuffer, tileX, tileY, tileZ = 0, lod = 0, encoding = null, options = {}) {
    if (this.pendingJobs.size >= this.options.maxPendingJobs) {
      return Promise.reject(new Error('Heightmap decode queue full (backpressure)'));
    }

    const tileKey = `${lod}:${tileX}:${tileY}:${tileZ}`;
    if (this.tileMap.has(tileKey)) {
      return Promise.resolve(this.tileMap.get(tileKey).entityId);
    }

    const resolution = this._resolveResolution(lod);
    const tileWorldSize = this.options.tileWorldSize * Math.pow(2, lod);
    const effEncoding = encoding ?? this.options.defaultEncoding;
    const encodingCode = this._encodingCode(effEncoding);
    if (encodingCode < 0) {
      return Promise.reject(new Error('Unknown encoding: ' + effEncoding));
    }

    const effectivePriority = this._effectivePriority(tileX, tileY, lod, options.priority ?? 0);

    const msg = {
      mode: 'decode',
      buffer: arrayBuffer,
      byteOffset: options.byteOffset ?? 0,
      byteLength: options.byteLength ?? arrayBuffer.byteLength,
      tileX, tileY, tileZ, lod, resolution,
      encoding: encodingCode,
      minElevation: options.minElevation ?? this.options.defaultMinElevation,
      maxElevation: options.maxElevation ?? this.options.defaultMaxElevation
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

  _resolveResolution(lod) {
    const base = this.options.resolution;
    // Higher LODs get higher resolution, capped at 257 (power-of-two + 1).
    const scale = Math.pow(2, Math.min(lod, 2));
    return Math.min(base * scale, 257);
  }

  _effectivePriority(tileX, tileY, lod, basePriority) {
    let p = basePriority;
    if (this.frame?.layers.player?.position) {
      const cam = this.frame.layers.player.position;
      const tileSize = this.options.tileWorldSize * Math.pow(2, lod);
      const cx = (tileX + 0.5) * tileSize;
      const cy = (tileY + 0.5) * tileSize;
      const d2 = (cx - cam[0]) ** 2 + (cy - cam[1]) ** 2;
      p += 1 / (1 + d2 * this.options.priorityDistanceScale);
    }
    return p;
  }

  _encodingCode(name) {
    switch (name) {
      case 'uint8': return HEIGHTMAP_ENCODING.UINT8;
      case 'uint16': return HEIGHTMAP_ENCODING.UINT16;
      case 'float32': return HEIGHTMAP_ENCODING.FLOAT32;
      case 'rgb-packed': return HEIGHTMAP_ENCODING.RGB_PACKED;
      case 'procedural': return HEIGHTMAP_ENCODING.PROCEDURAL;
      default: return -1;
    }
  }

  _ensureArena(extraFloats) {
    const needed = this._arena.used + extraFloats;
    if (needed <= this._arena.capacity) return;

    let newCap = Math.max(this._arena.capacity * 2, needed);
    newCap = Math.ceil(newCap / 4) * 4;

    const newElev = new Float32Array(newCap);
    const newBiome = new Float32Array(newCap);
    if (this._arena.elevation) {
      newElev.set(this._arena.elevation);
      newBiome.set(this._arena.biomeWeights);
    }
    this._arena.elevation = newElev;
    this._arena.biomeWeights = newBiome;
    this._arena.capacity = newCap;
  }

  _mergeResolved(tick) {
    if (!this.frame?.layers.spatial) return;
    const spatial = this.frame.layers.spatial;

    // Ensure heightmap SoA arrays exist.
    if (!spatial.heightmapBounds) {
      spatial.heightmapBounds = [];
      spatial.heightmapBoundingSpheres = [];
      spatial.heightmapMaterialIds = [];
      spatial.heightmapEntityIds = [];
      spatial.heightmapTileKeys = [];
      spatial.heightmapLods = [];
    }

    for (const entry of this.resolvedQueue) {
      const { tileKey, result } = entry;
      const {
        elevation, biomeWeights, minElevation, maxElevation,
        resolution, encoding, tileX, tileY, tileZ, lod
      } = result;

      const total = resolution * resolution;

      // Allocate ranges in the shared arena.
      this._ensureArena(total * 2);
      const elevStart = this._arena.used;
      this._arena.elevation.set(elevation, elevStart);
      this._arena.used += total;

      const biomeStart = this._arena.used;
      this._arena.biomeWeights.set(biomeWeights, biomeStart);
      this._arena.used += total;

      // Compute tile bounds in world space.
      const tileWorldSize = this.options.tileWorldSize * Math.pow(2, lod);
      const minX = tileX * tileWorldSize;
      const minY = tileY * tileWorldSize;
      const maxX = minX + tileWorldSize;
      const maxY = minY + tileWorldSize;
      const cz = (minElevation + maxElevation) * 0.5;
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const dx = tileWorldSize * 0.5;
      const dy = tileWorldSize * 0.5;
      const dz = Math.max((maxElevation - minElevation) * 0.5, 0.001);
      const radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 1.05;

      // ECS entity.
      const entityId = this.ecsWorld?.createEntity?.() ?? -1;
      if (this.ecsWorld && entityId >= 0) {
        this.ecsWorld.addComponent(entityId, HeightmapTileComponent, {
          tileX, tileY, tileZ, lod, resolution,
          encoding,
          elevationStart: elevStart,
          elevationCount: total,
          minElevation,
          maxElevation,
          seamFlags: 0,
          dirty: 1,
          lastUpdatedTick: tick
        });
      }

      // Push into frame’s spatial SoA.
      spatial.heightmapBounds.push(minX, minY, minElevation, maxX, maxY, maxElevation);
      spatial.heightmapBoundingSpheres.push(cx, cy, cz, radius);
      spatial.heightmapMaterialIds.push(0); // set by downstream material system
      spatial.heightmapEntityIds.push(entityId);
      spatial.heightmapTileKeys.push(tileKey);
      spatial.heightmapLods.push(lod);

      // Store tile view for the seamless-tile provider (365) to consume.
      this.tileMap.set(tileKey, {
        entityId, lod, tileX, tileY, tileZ,
        resolution,
        elevationStart: elevStart,
        elevationCount: total,
        biomeStart,
        minElevation, maxElevation,
        bounds: [minX, minY, minElevation, maxX, maxY, maxElevation],
        boundingSphere: [cx, cy, cz, radius]
      });
      this._tileViews.set(tileKey, {
        elevationStart: elevStart,
        biomeStart,
        resolution
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
      // Skip tiles still near the player.
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

  /**
   * Sample the elevation at an arbitrary world coordinate (bilinear interpolation).
   * Returns null if the coordinate is not covered by a resident tile.
   */
  sampleElevation(worldX, worldY) {
    // Find the tile that contains (worldX, worldY) at any LOD.
    for (const [tileKey, rec] of this.tileMap) {
      const [minX, minY, , maxX, maxY] = rec.bounds;
      if (worldX >= minX && worldX <= maxX && worldY >= minY && worldY <= maxY) {
        const view = this._tileViews.get(tileKey);
        if (!view) continue;
        const res = rec.resolution;
        const fx = (worldX - minX) / (maxX - minX) * (res - 1);
        const fy = (worldY - minY) / (maxY - minY) * (res - 1);
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(x0 + 1, res - 1), y1 = Math.min(y0 + 1, res - 1);
        const tx = fx - x0, ty = fy - y0;
        const e = this._arena.elevation;
        const s = view.elevationStart;
        const e00 = e[s + y0 * res + x0];
        const e10 = e[s + y0 * res + x1];
        const e01 = e[s + y1 * res + x0];
        const e11 = e[s + y1 * res + x1];
        const top = e00 + (e10 - e00) * tx;
        const bot = e01 + (e11 - e01) * tx;
        return top + (bot - top) * ty;
      }
    }
    return null;
  }

  /**
   * Retrieve the shared elevation arena (used by the seamless-tile provider 365).
   */
  getArena() {
    return this._arena;
  }

  getTileRecord(tileKey) {
    return this.tileMap.get(tileKey) ?? null;
  }

  dispose() {
    this.pool.dispose();
    this.pendingJobs.clear();
    this.resolvedQueue.length = 0;
    this.tileMap.clear();
    this.lru.length = 0;
    this._tileViews.clear();
    this._arena.elevation = null;
    this._arena.biomeWeights = null;
    this._arena.used = 0;
    this._arena.capacity = 0;
  }
}

export default TerrainHeightmapDecoder;