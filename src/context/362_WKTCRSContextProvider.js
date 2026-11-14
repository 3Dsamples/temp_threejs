// file number : 362
// full path name : src/context/362_WKTCRSContextProvider.js
//### Description : Context-aware WKT-CRS provider. Parses Well-Known Text
//###               coordinate reference system definitions (WKT1, WKT2:2015,
//###               WKT2:2019, GDAL, ESRI) into a value-preserving AST off the main
//###               thread, extracts authority codes (EPSG, ESRI, OGC), and streams
//###               a CRS registry into the context frame’s physical channel. Supports
//###               EPSG-code resolution by authority, datum/ellipsoid parameter
//###               extraction for terrain heightfield alignment, and ECS injection
//###               so every spatial entity can carry its CRS provenance. Uses a
//###               priority-based worker pool with cancellation and backpressure.
//###               Results are merged only into the next frame’s build stage, never
//###               the current one. Designed for Android arm64 under the 8 ms per-tick
//###               CPU ceiling and 200 MB resident memory cap.
//### Best for : Ingesting .prj files, PostGIS spatial_ref_sys rows, and GeoPackage
//###            CRS metadata for terrain tiles, procedural biome masks, and galactic-
//###            scale streaming pipelines where every chunk must know its coordinate
//###            reference before geometry is placed.
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
  // textures (procedural masks for CRS-aware terrain if needed)
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
// 1. ECS COMPONENT – CRS provenance for spatial entities
// ---------------------------------------------------------------------------

/**
 * CRSComponent — stored per-entity when a geometry is tagged with a CRS.
 * Authority and code allow the runtime to resolve ellipsoid parameters.
 */
export class CRSComponent {
  static schema = {
    authority:   { type: 'u16' }, // 0=none, 1=EPSG, 2=ESRI, 3=OGC, 4=custom
    code:        { type: 'u32' },
    datumType:   { type: 'u8' },  // 0=unknown, 1=geographic, 2=projected, 3=compound
    ellipsoidA:  { type: 'f64' }, // semi-major axis in metres
    ellipsoidInvF:{ type: 'f64' }, // inverse flattening
    hasZ:        { type: 'u8' }
  };
}

// ---------------------------------------------------------------------------
// 2. WKT-CRS WORKER – tokenizer + recursive-descent AST parser (off main thread)
// ---------------------------------------------------------------------------

const WKTCRS_WORKER_SOURCE = `
  // Value-preserving WKT-CRS parser.
  // Supports WKT1, WKT2:2015, WKT2:2019, GDAL, and ESRI extensions.
  // Produces a nested AST that retains keyword spelling, bracket delimiters,
  // and numeric lexemes. Extracts authority codes and ellipsoid parameters.

  const CRS_ROOT_KEYWORDS = new Set([
    'PROJCS', 'GEOGCS', 'GEOCCS', 'COMPD_CS', 'VERT_CS', 'LOCAL_CS',
    'PROJCRS', 'GEOGCRS', 'GEODCRS', 'COMPOUNDCRS', 'VERTCRS', 'ENGCRS',
    'BOUNDCRS', 'DERIVEDPROJCRS', 'CONVERSION'
  ]);

  self.onmessage = function (e) {
    const { id, text, profile } = e.data;
    try {
      const result = parseWKTCRS(text, profile);
      self.postMessage({ id, result });
    } catch (err) {
      self.postMessage({ id, error: err.message });
    }
  };

  function parseWKTCRS(text, profile) {
    let i = 0;
    const len = text.length;

    // Tokenizer
    function skipWS() {
      while (i < len && /\\s/.test(text[i])) i++;
    }
    function readWord() {
      skipWS();
      const start = i;
      while (i < len && /[A-Za-z_]/.test(text[i])) i++;
      return text.slice(start, i);
    }
    function readQuoted() {
      skipWS();
      if (text[i] !== '"') throw new Error('Expected quoted string at ' + i);
      i++;
      const start = i;
      while (i < len && text[i] !== '"') i++;
      const str = text.slice(start, i);
      i++; // closing quote
      return str;
    }
    function readNumber() {
      skipWS();
      const start = i;
      if (text[i] === '-' || text[i] === '+') i++;
      while (i < len && /[0-9.eE+\\-]/.test(text[i])) i++;
      const raw = text.slice(start, i);
      return { raw, value: parseFloat(raw) };
    }
    function peekChar() {
      skipWS();
      return text[i];
    }
    function expectChar(ch) {
      skipWS();
      if (text[i] !== ch) throw new Error('Expected "' + ch + '" at ' + i + ' but got "' + text[i] + '"');
      i++;
    }

    // AST node types
    function makeNode(keyword, bracket) {
      return { type: 'node', keyword, bracket, values: [] };
    }

    function parseValue() {
      skipWS();
      const c = text[i];
      if (c === '"') return { type: 'string', value: readQuoted() };
      if (c === '[' || c === '(') {
        const open = c;
        const close = open === '[' ? ']' : ')';
        i++; // consume open
        const inner = [];
        skipWS();
        if (text[i] !== close) {
          while (true) {
            inner.push(parseValue());
            skipWS();
            if (text[i] === ',') { i++; continue; }
            break;
          }
        }
        skipWS();
        expectChar(close);
        return { type: 'array', bracket: open, values: inner };
      }
      // Try number first
      if (/[0-9.\\-+eE]/.test(c)) {
        const num = readNumber();
        return { type: 'number', raw: num.raw, value: num.value };
      }
      // Bare word (enumeration)
      const word = readWord();
      if (word) return { type: 'enum', value: word };
      throw new Error('Unexpected character "' + c + '" at ' + i);
    }

    function parseNode() {
      skipWS();
      if (i >= len) return null;
      const keyword = readWord();
      if (!keyword) return null;
      skipWS();
      const open = text[i];
      if (open !== '[' && open !== '(') {
        // Not a node; treat as bare value (should not happen at top level)
        return { type: 'enum', value: keyword };
      }
      const close = open === '[' ? ']' : ')';
      i++; // consume open
      const node = makeNode(keyword, open);
      skipWS();
      if (text[i] !== close) {
        while (true) {
          const value = parseValue();
          node.values.push(value);
          skipWS();
          if (text[i] === ',') { i++; continue; }
          break;
        }
      }
      skipWS();
      expectChar(close);
      return node;
    }

    // Entry
    skipWS();
    const root = parseNode();
    skipWS();
    if (i < len && text[i] === ';') i++;

    // Extract authority and ellipsoid parameters
    const extracted = extractCRSMetadata(root);

    return {
      root,
      authority: extracted.authority,
      code: extracted.code,
      datumType: extracted.datumType,
      ellipsoidA: extracted.ellipsoidA,
      ellipsoidInvF: extracted.ellipsoidInvF,
      profile: profile || 'auto'
    };
  }

  // -------------------------------------------------------------------------
  // Metadata extraction – walks the AST for authority codes and ellipsoid
  // -------------------------------------------------------------------------

  function extractCRSMetadata(node) {
    let authority = 0; // 0=none
    let code = 0;
    let datumType = 0; // 1=geographic, 2=projected, 3=compound
    let ellipsoidA = 6378137; // WGS84 default
    let ellipsoidInvF = 298.257223563;

    function walk(n) {
      if (!n || n.type !== 'node') return;
      const kw = n.keyword.toUpperCase();

      // Root type detection
      if (kw === 'GEOGCS' || kw === 'GEOGCRS' || kw === 'GEODCRS') datumType = 1;
      if (kw === 'PROJCS' || kw === 'PROJCRS' || kw === 'DERIVEDPROJCRS') datumType = 2;
      if (kw === 'COMPD_CS' || kw === 'COMPOUNDCRS') datumType = 3;

      // Authority extraction: ID["EPSG",4326] or AUTHORITY["EPSG","4326"]
      if (kw === 'ID' || kw === 'AUTHORITY') {
        const vals = n.values;
        if (vals.length >= 2) {
          let authStr = '', codeVal = 0;
          if (vals[0].type === 'string') authStr = vals[0].value;
          else if (vals[0].type === 'enum') authStr = vals[0].value;
          if (vals[1].type === 'number') codeVal = vals[1].value;
          else if (vals[1].type === 'string') codeVal = parseInt(vals[1].value, 10);
          if (authStr.toUpperCase() === 'EPSG') authority = 1;
          else if (authStr.toUpperCase() === 'ESRI') authority = 2;
          else if (authStr.toUpperCase() === 'OGC') authority = 3;
          else authority = 4; // custom
          code = codeVal;
        }
      }

      // Ellipsoid: SPHEROID["WGS 84",6378137,298.257223563] or ELLIPSOID[...]
      if (kw === 'SPHEROID' || kw === 'ELLIPSOID') {
        const vals = n.values;
        if (vals.length >= 3) {
          if (vals[1].type === 'number') ellipsoidA = vals[1].value;
          if (vals[2].type === 'number') ellipsoidInvF = vals[2].value;
        }
      }

      // Recurse into nested values
      for (const v of n.values) {
        if (v.type === 'node') walk(v);
        else if (v.type === 'array') {
          for (const inner of v.values) {
            if (inner.type === 'node') walk(inner);
          }
        }
      }
    }

    walk(node);
    return { authority, code, datumType, ellipsoidA, ellipsoidInvF };
  }
`;

// ---------------------------------------------------------------------------
// 3. WORKER POOL – priority queue, cancellation, backpressure
// ---------------------------------------------------------------------------

class WKTCRSWorkerPool {
  constructor(maxWorkers = 1) {
    this.maxWorkers = maxWorkers;
    this.workers = [];
    this.queue = [];
    this.activeJobs = new Map();
    this.nextJobId = 1;
    this._init();
  }

  _init() {
    const blob = new Blob([WKTCRS_WORKER_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    for (let i = 0; i < this.maxWorkers; i++) {
      const w = new Worker(url);
      w.onmessage = (e) => this._onWorkerMessage(w, e.data);
      w.onerror = (e) => this._onWorkerError(w, e);
      this.workers.push({ worker: w, busy: false, currentJobId: null });
    }
    URL.revokeObjectURL(url);
  }

  enqueue(text, profile = 'auto', priority = 0) {
    return new Promise((resolve, reject) => {
      const id = this.nextJobId++;
      this.queue.push({ id, text, profile, priority, resolve, reject });
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
      slot.worker.postMessage({ id: job.id, text: job.text, profile: job.profile });
    }
  }

  _onWorkerMessage(slot, data) {
    const job = this.activeJobs.get(data.id);
    if (!job) return;
    this.activeJobs.delete(data.id);
    slot.busy = false;
    slot.currentJobId = null;
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.result);
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
    const blob = new Blob([WKTCRS_WORKER_SOURCE], { type: 'application/javascript' });
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
// 4. CONTEXT PROVIDER – fills physical CRS registry at 1 Hz, ECS-aware
// ---------------------------------------------------------------------------

const AUTHORITY_NAMES = { 0: 'none', 1: 'EPSG', 2: 'ESRI', 3: 'OGC', 4: 'custom' };

export class WKTCRSContextProvider {
  constructor(options = {}) {
    this.options = {
      maxWorkers: options.maxWorkers ?? 1,
      maxPendingJobs: options.maxPendingJobs ?? 32,
      targetHz: options.targetHz ?? 1, // CRS definitions change rarely
      defaultProfile: options.defaultProfile ?? 'auto',
      maxCacheSize: options.maxCacheSize ?? 256,
      ...options
    };

    this.pool = new WKTCRSWorkerPool(this.options.maxWorkers);
    this.pendingJobs = new Map();
    this.resolvedQueue = [];
    this.nextInternalId = 1;

    // Resolved CRS cache: key = "authority:code" (e.g. "1:4326")
    this.crsCache = new Map();

    this.frame = null;
    this.ecsWorld = null;
    this.lastTick = 0;
    this._accumulator = 0;
    this._lastCleanupTick = 0;

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

    // Merge resolved CRS definitions into the frame’s physical channel.
    this._mergeResolved(tick);

    // Periodic cache cleanup (every 60 seconds of simulated time).
    if (tick - this._lastCleanupTick > 60) {
      this._cleanupCache();
      this._lastCleanupTick = tick;
    }
  }

  /**
   * Public entry point (blueprint step 34): ingest a WKT-CRS definition.
   * Returns a promise that resolves with the cache key when merged.
   */
  ingest(wktText, profile = null, priority = 0) {
    if (this.pendingJobs.size >= this.options.maxPendingJobs) {
      return Promise.reject(new Error('WKT-CRS ingest queue full (backpressure)'));
    }

    const effectiveProfile = profile ?? this.options.defaultProfile;
    const internalId = this.nextInternalId++;

    const promise = this.pool.enqueue(wktText, effectiveProfile, priority)
      .then(result => {
        this.pendingJobs.delete(internalId);
        this.resolvedQueue.push({ internalId, result });
        return internalId;
      })
      .catch(err => {
        this.pendingJobs.delete(internalId);
        throw err;
      });

    this.pendingJobs.set(internalId, {
      wktText,
      profile: effectiveProfile,
      priority,
      promise
    });
    return promise;
  }

  /**
   * Resolve a CRS definition by authority and code.
   * Authority: 1=EPSG, 2=ESRI, 3=OGC, 4=custom.
   * Returns the cached AST or null if not yet ingested.
   */
  resolve(authority, code) {
    const key = `${authority}:${code}`;
    return this.crsCache.get(key) ?? null;
  }

  /**
   * Resolve by EPSG code (convenience).
   */
  resolveEPSG(code) {
    return this.resolve(1, code);
  }

  cancel(internalId) {
    if (!this.pendingJobs.has(internalId)) return false;
    this.pendingJobs.delete(internalId);
    return true;
  }

  _mergeResolved(tick) {
    if (!this.frame?.layers.physical) return;
    const physical = this.frame.layers.physical;

    // Ensure the CRS registry exists in the physical channel.
    if (!physical.crsRegistry) {
      physical.crsRegistry = new Map();
      physical.crsAuthorityNames = AUTHORITY_NAMES;
      physical.crsEntityBindings = []; // SoA: entityId, crsKey
    }

    for (const entry of this.resolvedQueue) {
      const { result } = entry;
      const auth = result.authority;
      const code = result.code;
      const key = `${auth}:${code}`;

      // Evict oldest entries if cache exceeds max size.
      if (this.crsCache.size >= this.options.maxCacheSize) {
        const oldestKey = this.crsCache.keys().next().value;
        this.crsCache.delete(oldestKey);
        physical.crsRegistry.delete(oldestKey);
      }

      // Store in provider cache and frame registry.
      this.crsCache.set(key, result);
      physical.crsRegistry.set(key, {
        authority: auth,
        code,
        authorityName: AUTHORITY_NAMES[auth] || 'unknown',
        datumType: result.datumType,
        ellipsoidA: result.ellipsoidA,
        ellipsoidInvF: result.ellipsoidInvF,
        hasZ: false, // updated when geometry with Z is merged
        ast: result.root
      });

      // ECS: if a World is bound, create a CRSComponent-bearing entity
      // (or tag an existing entity if the caller supplies an entityId).
      // For standalone ingestion, we create a lightweight entity to hold
      // the CRS component so ECS queries can enumerate available CRSs.
      if (this.ecsWorld) {
        const entityId = this.ecsWorld.createEntity?.() ?? -1;
        if (entityId >= 0) {
          this.ecsWorld.addComponent(entityId, CRSComponent, {
            authority: auth,
            code,
            datumType: result.datumType,
            ellipsoidA: result.ellipsoidA,
            ellipsoidInvF: result.ellipsoidInvF,
            hasZ: 0
          });
        }
      }
    }
    this.resolvedQueue.length = 0;
  }

  _cleanupCache() {
    // Evict entries not accessed in the last 60 seconds (simple LRU approximation).
    // In production, track last-access ticks per entry.
    // For brevity, we keep entries as-is; the maxCacheSize eviction in
    // _mergeResolved already bounds memory.
  }

  /**
   * Retrieve a CRS AST for re-encoding or inspection.
   * Returns the cached AST or null.
   */
  getAST(authority, code) {
    const entry = this.resolve(authority, code);
    return entry?.ast ?? null;
  }

  dispose() {
    this.pool.dispose();
    this.pendingJobs.clear();
    this.resolvedQueue.length = 0;
    this.crsCache.clear();
  }
}

export default WKTCRSContextProvider;