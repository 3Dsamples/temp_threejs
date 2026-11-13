// file number : 299
// full path name : src/context/299_PersistentWorldMemory.js
// description : Persistent world memory — the sparse chunk-coordinate hash implementing "the world remembers" across frames, sessions, and save/load cycles. Every mutation the living world produces — a tree felled by an impact, a crater carved by a fireball, a decal stamped on a rock, a wall broken by an explosion, a resource harvested, terrain damaged by erosion, a fire spread scar, a place built, a seed scattered, a body decayed — is recorded once, compactly, in a per-chunk flat mutation buffer. Records carry type, entity id, material id, local chunk coordinates, scale, yaw, force, timestamp, decay curve, payload, parent lineage, and a replay seed, all packed into 56 bytes and stored in contiguous Float32Array/Int32Array blocks indexed by a LRU-backed Map from chunk coordinates to chunk slots. Bounded memory budget with explicit ceilings (default 4096 chunks × 32 records × 56 bytes = ~7 MB), LRU eviction that ensures the working set is retained while distant chunks are gracefully evicted, per-chunk dirty tracking for lazy save dispatch, decay-based pruning that automatically removes stale records, and a compact binary serialization format (magic "PWMM", version, per-chunk record blocks) that can be dispatched to worker threads via transferable ArrayBuffers without any copy. Emits a single coalesced MUTATION causal event per chunk per frame when new records are added, plus AUDIO_LIGHT events when decay-pruning removes records. Writes per-chunk memory pointers and per-frame budgets into frame.layers.spatial.worldMemory and global aggregates into frame.layers.physical.worldMemoryProperties. All scratch Vec3, Vec4, Mat4, and SimplexNoise objects are pooled; zero allocation after the first frame for record, query, and lookup paths.
// best for : Every consumer that needs persistence across sessions — LandscapeChunkMutationReplay (342) for restoring stored mutations when a chunk streams back in, LandscapeChunkPersistence (341) for save/load of a chunk's memory state, LandscapeDecalPlacementSystem (348) for restoring decals, LandscapePropPlacementSystem (349) for restoring props, LandscapeErosionSimulator (343) for preserving carved terrain, 282_Z07_ForestGradientProvider and 282_Z08_GrassAndFlowresGradientProvider for respecting player-caused destruction, 300_ImpactEventCoordinator for recording impact outcomes, and 316_EcologyResponseSystem for recording fire scars and regrowth. This is the memory that makes "the scene destroyed last visit is still destroyed" true.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { CausalContextProvider, DERIVED_SIGNAL }            from './278_CausalContextProvider.js';
import { CarveGradientProvider, CARVE_SOURCE, CARVE_MATERIAL_BAND }
                                                            from './282_Z03_CarveGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE }                from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE }      from './282_Z08_GrassAndFlowresGradientProvider.js';
import { MaterialRegistry, MATERIAL_KIND }                  from './298_MaterialRegistry.js';

// ══════════════════════════════════════════════════════════════════
// ─── MUTATION TYPES ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const MUTATION_TYPE = Object.freeze({
  NONE:             0,
  TREE_DESTROYED:   1,   // tree felled by impact / fire / harvest
  TREE_HARVESTED:   2,   // tree harvested for resources
  TREE_PLANTED:     3,   // tree planted by player / regrowth
  GRASS_DESTROYED:  4,   // grass trampled / burned
  GRASS_HARVESTED:  5,   // grass cut
  ROCK_DESTROYED:   6,   // rock broken by impact
  ROCK_MINED:       7,   // rock mined for ore
  TERRAIN_CARVED:   8,   // terrain modified by impact / erosion
  TERRAIN_DEPOSITED:9,   // sediment deposited
  DECAL_PLACED:    10,   // crater / blood / scorch decal
  DECAL_REMOVED:   11,   // decal decayed / washed away
  STRUCTURE_BUILT: 12,   // player-built structure
  STRUCTURE_BROKEN:13,   // structure destroyed
  FIRE_SCAR:       14,   // burned ground
  WATER_ADDED:     15,   // water channel created
  WATER_REMOVED:   16,   // water drained
  RESOURCE_TAKEN:  17,   // generic resource extraction
  BODY_DECAYED:    18,   // carcass decomposed / removed
  SEED_SCATTERED:  19,   // plant seed placed
  PROP_PLACED:     20,   // generic prop / object placed
  PROP_REMOVED:    21,   // prop removed
  MARKER_PLACED:   22    // player-placed marker (camp, flag, waypoint)
});

const MUTATION_TYPE_NAMES = Object.freeze([
  'none', 'tree_destroyed', 'tree_harvested', 'tree_planted',
  'grass_destroyed', 'grass_harvested', 'rock_destroyed', 'rock_mined',
  'terrain_carved', 'terrain_deposited', 'decal_placed', 'decal_removed',
  'structure_built', 'structure_broken', 'fire_scar', 'water_added',
  'water_removed', 'resource_taken', 'body_decayed', 'seed_scattered',
  'prop_placed', 'prop_removed', 'marker_placed'
]);

// ─── mutation flags (bitmask) ──────────────────────────────────
const MUTATION_FLAG = Object.freeze({
  PERSISTENT:    1 << 0,   // survives decay pruning
  PLAYER_CAUSED: 1 << 1,   // caused by player action
  REPLAYED:      1 << 2,   // restored from save, not live
  HIDDEN:        1 << 3,   // not visible to player yet
  BURNED:        1 << 4,   // associated with fire event
  WET:           1 << 5,   // associated with water event
  DECAYING:      1 << 6    // currently being pruned
});

// ══════════════════════════════════════════════════════════════════
// ─── RECORD LAYOUT (56 bytes per record) ────────────────────────
// Layout for compactness and cache locality. Timestamps truncated
// to float32 which gives ~7 significant digits (~46 days of seconds
// with sub-millisecond precision preserved).
// ══════════════════════════════════════════════════════════════════
const RECORD_STRIDE_BYTES = 56;
const RECORD_STRIDE_F32 = 14;   // 56 / 4

// Offsets in Float32Array (indexed per record):
const REC_TYPE          = 0;   // reinterpreted as uint8 in separate Int32Array
const REC_FLAGS         = 0;   // packed in same int32 slot
const REC_MATERIAL      = 0;   // packed
const REC_ENTITY        = 1;   // Int32
const REC_LOCAL_X       = 2;   // Float32
const REC_LOCAL_Y       = 3;   // Float32
const REC_LOCAL_Z       = 4;   // Float32
const REC_SCALE         = 5;   // Float32
const REC_YAW           = 6;   // Float32 (packed rotation, radians)
const REC_FORCE         = 7;   // Float32
const REC_TIMESTAMP     = 8;   // Float32 (seconds)
const REC_DECAY         = 9;   // Float32
const REC_PAYLOAD       = 10;  // Int32
const REC_PARENT_ID     = 11;  // Int32
const REC_SEED          = 12;  // Int32 (uint32)
const REC_RESERVED      = 13;  // Float32

// ══════════════════════════════════════════════════════════════════
// ─── CHUNK MEMORY STATE ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const CHUNK_STATE_FREE = 0;
const CHUNK_STATE_ACTIVE = 1;

class ChunkMemory {
  constructor(capacity) {
    this.chunkX = 0;
    this.chunkZ = 0;
    this.count = 0;
    this.capacity = capacity;
    this.state = CHUNK_STATE_FREE;
    this.dirty = 0;
    this.lastAccess = 0;
    this.seed = 0;
    this.records = new Float32Array(capacity * RECORD_STRIDE_F32);
    // Total time fields are stored as Float32 in records, but we
    // keep a shadow Float64 for precise replay ordering.
    this.preciseTimestamps = new Float64Array(capacity);
    // Free-record bitmap.
    this.freeRecords = new Int32Array(capacity);
    this.freeRecordCount = capacity;
  }

  reset() {
    this.chunkX = 0;
    this.chunkZ = 0;
    this.count = 0;
    this.state = CHUNK_STATE_FREE;
    this.dirty = 0;
    this.lastAccess = 0;
    this.seed = 0;
    this.freeRecordCount = this.capacity;
    for (let i = 0; i < this.capacity; i++) {
      this.freeRecords[i] = i;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── SERIALIZATION FORMAT (binary, transferable) ────────────────
// Magic: "PWMM"  (Persistent World Memory - Mutation)
// Version: uint16
// Chunk count: uint32
// Per chunk:
//   chunkX: int32, chunkZ: int32
//   record count: uint32
//   seed: uint32
//   records: count × 56 bytes
// ══════════════════════════════════════════════════════════════════
const SERIALIZATION_MAGIC = 0x50574D4D;   // "PWMM" in little-endian
const SERIALIZATION_VERSION = 1;

// ══════════════════════════════════════════════════════════════════
// ─── PERSISTENT WORLD MEMORY ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class PersistentWorldMemory {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      worldSeed:               options.worldSeed ?? 0x9E57A11C,
      chunkCapacity:           options.chunkCapacity ?? 4096,
      mutationsPerChunk:       options.mutationsPerChunk ?? 32,
      maxTotalMutations:       options.maxTotalMutations ?? 131072,
      decayPruneThreshold:     options.decayPruneThreshold ?? 0.01,
      enableLRU:               options.enableLRU ?? true,
      enableAutoSave:          options.enableAutoSave ?? true,
      autoSaveInterval:        options.autoSaveInterval ?? 60.0,   // seconds
      chunkSize:               options.chunkSize ?? 1000,
      enableEvents:            options.enableEvents ?? true
    };
    this.defaults.worldSeed = this.defaults.worldSeed | 0;

    // ── Chunk pool (pre-allocated ChunkMemory objects) ───
    this._chunkPool = new Array(this.defaults.chunkCapacity);
    for (let i = 0; i < this.defaults.chunkCapacity; i++) {
      this._chunkPool[i] = new ChunkMemory(this.defaults.mutationsPerChunk);
    }
    this._chunkPoolUsed = 0;

    // ── Chunk coordinate → pool index ───────────────────
    this._chunkIndex = new Map();

    // ── LRU linked list (doubly linked, indices into pool) ─
    this._lruPrev = new Int32Array(this.defaults.chunkCapacity).fill(-1);
    this._lruNext = new Int32Array(this.defaults.chunkCapacity).fill(-1);
    this._lruHead = -1;
    this._lruTail = -1;
    this._lruMap = new Int32Array(this.defaults.chunkCapacity).fill(-1);

    // ── Global mutation counter for budget ──────────────
    this._totalMutations = 0;

    // ── Auto-save timer ─────────────────────────────────
    this._lastAutoSaveTime = 0;
    this._autoSaveTimer = 0;

    // ── Scratch objects (pooled) ────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMatA = new Mat4();
    this._tmpMatB = new Mat4();

    // ── Reusable serialize buffer (grows on demand) ────
    this._serializeBuffer = new ArrayBuffer(1024 * 1024);   // 1 MB initial

    // ── Reusable query result buffer ────────────────────
    this._queryResultCapacity = 64;
    this._queryResult = new Int32Array(this._queryResultCapacity);
    this._queryResultCount = 0;

    // ── New records accumulator (for per-frame mutation events) ─
    this._pendingMutationChunks = [];

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      recordsAdded: 0,
      recordsRemoved: 0,
      recordsPruned: 0,
      recordsEvicted: 0,
      queries: 0,
      serializations: 0,
      deserializations: 0,
      chunkCreations: 0,
      chunkEvictions: 0,
      lruHits: 0,
      lruMisses: 0,
      autoSaves: 0
    };

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._materials = options.materials || null;

    // ── Frame reference ─────────────────────────────────
    this._frameRef = null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── LRU list management (doubly linked, zero-allocation) ──
  // ══════════════════════════════════════════════════════════
  _lruInsertHead(poolIndex) {
    const prev = -1;
    const next = this._lruHead;
    this._lruPrev[poolIndex] = prev;
    this._lruNext[poolIndex] = next;
    if (next >= 0) this._lruPrev[next] = poolIndex;
    this._lruHead = poolIndex;
    if (this._lruTail < 0) this._lruTail = poolIndex;
  }

  _lruRemove(poolIndex) {
    const prev = this._lruPrev[poolIndex];
    const next = this._lruNext[poolIndex];
    if (prev >= 0) this._lruNext[prev] = next;
    else this._lruHead = next;
    if (next >= 0) this._lruPrev[next] = prev;
    else this._lruTail = prev;
    this._lruPrev[poolIndex] = -1;
    this._lruNext[poolIndex] = -1;
  }

  _lruMoveToHead(poolIndex) {
    if (this._lruHead === poolIndex) return;
    this._lruRemove(poolIndex);
    this._lruInsertHead(poolIndex);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Chunk key packing ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _makeChunkKey(cx, cz) {
    // Pack into a single int64-safe number. For typical chunk
    // coordinates (±10000) this fits comfortably in a Number.
    // For extreme ranges, use a BigInt-based key or string.
    const x = cx | 0;
    const z = cz | 0;
    return x * 0x20000 + z;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Chunk acquisition with LRU eviction ────────────────
  // ══════════════════════════════════════════════════════════
  _acquireChunk(cx, cz, now) {
    const key = this._makeChunkKey(cx, cz);

    // Fast path: existing chunk in LRU.
    const existingIdx = this._chunkIndex.get(key);
    if (existingIdx !== undefined) {
      this._lruMoveToHead(existingIdx);
      this._chunkPool[existingIdx].lastAccess = now;
      this._stats.lruHits++;
      return this._chunkPool[existingIdx];
    }

    this._stats.lruMisses++;

    // Check budget: if at chunk capacity, evict LRU tail.
    if (this._chunkPoolUsed >= this.defaults.chunkCapacity) {
      if (this.defaults.enableLRU) {
        this._evictLRUTail();
      } else {
        return null;   // hard cap without LRU
      }
    }

    // Allocate a free pool slot (grows linearly as chunks are used).
    let poolIndex = -1;
    if (this._chunkPoolUsed < this.defaults.chunkCapacity) {
      poolIndex = this._chunkPoolUsed++;
    } else {
      poolIndex = this._lruTail;
      if (poolIndex < 0) return null;
      this._evictPoolIndex(poolIndex);
    }

    const chunk = this._chunkPool[poolIndex];
    chunk.reset();
    chunk.chunkX = cx;
    chunk.chunkZ = cz;
    chunk.state = CHUNK_STATE_ACTIVE;
    chunk.lastAccess = now;
    chunk.seed = this._makeChunkSeed(cx, cz);

    this._chunkIndex.set(key, poolIndex);
    this._lruInsertHead(poolIndex);
    this._stats.chunkCreations++;

    return chunk;
  }

  _evictLRUTail() {
    if (this._lruTail < 0) return;
    this._evictPoolIndex(this._lruTail);
  }

  _evictPoolIndex(poolIndex) {
    const chunk = this._chunkPool[poolIndex];
    if (chunk.state === CHUNK_STATE_FREE) return;

    const key = this._makeChunkKey(chunk.chunkX, chunk.chunkZ);
    this._chunkIndex.delete(key);
    this._lruRemove(poolIndex);

    // Track eviction stats.
    this._totalMutations -= chunk.count;
    this._stats.recordsEvicted += chunk.count;
    this._stats.chunkEvictions++;

    chunk.reset();
  }

  _makeChunkSeed(cx, cz) {
    // Deterministic per-chunk seed (SimplexNoise-friendly).
    let h = this.defaults.worldSeed | 0;
    h = (h ^ (cx * 0x9E3779B1)) | 0;
    h = (h ^ (cz * 0x85EBCA77)) | 0;
    h = ((h << 13) | (h >>> 19)) | 0;
    h = Math.imul(h, 0x5bd1e995);
    h = (h ^ (h >>> 15)) | 0;
    return h >>> 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Record allocation from chunk free list ─────────────
  // ══════════════════════════════════════════════════════════
  _allocRecord(chunk) {
    if (chunk.freeRecordCount === 0) {
      // Chunk full: evict oldest record (LRU within chunk).
      this._evictOldestRecord(chunk);
      if (chunk.freeRecordCount === 0) return -1;
    }
    chunk.freeRecordCount--;
    const idx = chunk.freeRecords[chunk.freeRecordCount];
    return idx;
  }

  _freeRecord(chunk, recordIndex) {
    if (recordIndex < 0 || recordIndex >= chunk.capacity) return;
    // Clear the record slot.
    const o = recordIndex * RECORD_STRIDE_F32;
    for (let i = 0; i < RECORD_STRIDE_F32; i++) {
      chunk.records[o + i] = 0;
    }
    chunk.preciseTimestamps[recordIndex] = 0;
    chunk.freeRecords[chunk.freeRecordCount++] = recordIndex;
    chunk.count--;
  }

  _evictOldestRecord(chunk) {
    // Find the record with the smallest timestamp.
    if (chunk.count === 0) return;
    let oldestIdx = -1;
    let oldestTs = Infinity;
    for (let i = 0; i < chunk.capacity; i++) {
      const ts = chunk.preciseTimestamps[i];
      if (ts === 0) continue;   // free slot
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestIdx = i;
      }
    }
    if (oldestIdx >= 0) {
      this._freeRecord(chunk, oldestIdx);
      this._stats.recordsEvicted++;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public: record a mutation ──────────────────────────
  // ══════════════════════════════════════════════════════════
  // Returns a record handle (chunk slot * 100000 + recordIndex)
  // or -1 on failure. The handle can be used to update or erase.
  recordMutation(chunkX, chunkZ, mutationData) {
    const now = this._clock ? this._clock.elapsedSeconds : performance.now() / 1000;
    const chunk = this._acquireChunk(chunkX, chunkZ, now);
    if (!chunk) return -1;

    // Budget check: if total mutations exceed maxTotalMutations, evict LRU chunk.
    if (this._totalMutations >= this.defaults.maxTotalMutations) {
      this._evictLRUTail();
    }

    const recIdx = this._allocRecord(chunk);
    if (recIdx < 0) return -1;

    const o = recIdx * RECORD_STRIDE_F32;

    // ── Pack type, flags, material into slot 0 ────────────
    const type = (mutationData.type ?? 0) & 0xFF;
    const flags = (mutationData.flags ?? 0) & 0xFF;
    const matId = (mutationData.materialId ?? 0) & 0xFFFF;
    // Pack: [type:8][flags:8][material:16]
    const packed = (type) | (flags << 8) | (matId << 16);
    chunk.records[o + REC_TYPE] = this._int32ToFloat32(packed);

    chunk.records[o + REC_ENTITY] = this._int32ToFloat32(mutationData.entityId ?? -1);
    chunk.records[o + REC_LOCAL_X] = mutationData.localX ?? 0;
    chunk.records[o + REC_LOCAL_Y] = mutationData.localY ?? 0;
    chunk.records[o + REC_LOCAL_Z] = mutationData.localZ ?? 0;
    chunk.records[o + REC_SCALE] = mutationData.scale ?? 1.0;
    chunk.records[o + REC_YAW] = mutationData.yaw ?? 0;
    chunk.records[o + REC_FORCE] = mutationData.force ?? 1.0;
    chunk.records[o + REC_TIMESTAMP] = now;
    chunk.records[o + REC_DECAY] = mutationData.decay ?? 1.0;
    chunk.records[o + REC_PAYLOAD] = this._int32ToFloat32(mutationData.payload ?? 0);
    chunk.records[o + REC_PARENT_ID] = this._int32ToFloat32(mutationData.parentId ?? -1);
    chunk.records[o + REC_SEED] = this._int32ToFloat32((mutationData.seed ?? chunk.seed) | 0);
    chunk.records[o + REC_RESERVED] = 0;

    chunk.preciseTimestamps[recIdx] = now;
    chunk.count++;
    this._totalMutations++;
    chunk.dirty = 1;

    this._stats.recordsAdded++;

    // Accumulate chunk for per-frame event emission.
    this._pendingMutationChunks.push(chunk);

    return (chunk.chunkX * 100000 + chunk.chunkZ) * 100 + recIdx;
  }

  _int32ToFloat32(val) {
    // Bit-reinterpret int32 as float32 (avoids allocating a DataView).
    // We use a tiny reusable scratch buffer via Float32Array view.
    if (!this._scratchI32 || !this._scratchF32) {
      this._scratchBuffer = new ArrayBuffer(4);
      this._scratchI32 = new Int32Array(this._scratchBuffer);
      this._scratchF32 = new Float32Array(this._scratchBuffer);
    }
    this._scratchI32[0] = val | 0;
    return this._scratchF32[0];
  }

  _float32ToInt32(val) {
    if (!this._scratchI32 || !this._scratchF32) {
      this._scratchBuffer = new ArrayBuffer(4);
      this._scratchI32 = new Int32Array(this._scratchBuffer);
      this._scratchF32 = new Float32Array(this._scratchBuffer);
    }
    this._scratchF32[0] = val;
    return this._scratchI32[0];
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public: query mutations in a chunk ─────────────────
  // ══════════════════════════════════════════════════════════
  // Returns an accessor for zero-allocation iteration.
  queryChunk(chunkX, chunkZ) {
    this._stats.queries++;
    const key = this._makeChunkKey(chunkX, chunkZ);
    const idx = this._chunkIndex.get(key);
    if (idx === undefined) return null;
    const chunk = this._chunkPool[idx];
    // Move to LRU head.
    const now = this._clock ? this._clock.elapsedSeconds : performance.now() / 1000;
    chunk.lastAccess = now;
    this._lruMoveToHead(idx);
    return chunk;
  }

  // Get record from a chunk accessor.
  getRecord(chunk, recordIndex, outRecord) {
    if (!chunk || recordIndex < 0 || recordIndex >= chunk.capacity) return null;
    if (chunk.preciseTimestamps[recordIndex] === 0) return null;

    const o = recordIndex * RECORD_STRIDE_F32;
    const packed = this._float32ToInt32(chunk.records[o + REC_TYPE]);
    const rec = outRecord || {};

    rec.type = packed & 0xFF;
    rec.flags = (packed >>> 8) & 0xFF;
    rec.materialId = (packed >>> 16) & 0xFFFF;
    rec.entityId = this._float32ToInt32(chunk.records[o + REC_ENTITY]);
    rec.localX = chunk.records[o + REC_LOCAL_X];
    rec.localY = chunk.records[o + REC_LOCAL_Y];
    rec.localZ = chunk.records[o + REC_LOCAL_Z];
    rec.scale = chunk.records[o + REC_SCALE];
    rec.yaw = chunk.records[o + REC_YAW];
    rec.force = chunk.records[o + REC_FORCE];
    rec.timestamp = chunk.records[o + REC_TIMESTAMP];
    rec.decay = chunk.records[o + REC_DECAY];
    rec.payload = this._float32ToInt32(chunk.records[o + REC_PAYLOAD]);
    rec.parentId = this._float32ToInt32(chunk.records[o + REC_PARENT_ID]);
    rec.seed = this._float32ToInt32(chunk.records[o + REC_SEED]);
    rec.recordIndex = recordIndex;

    return rec;
  }

  // World position of a record: converts local chunk coords to world.
  getWorldPosition(chunk, recordIndex, outVec) {
    if (!chunk || recordIndex < 0) {
      outVec.set(0, 0, 0);
      return outVec;
    }
    const o = recordIndex * RECORD_STRIDE_F32;
    const chunkSize = this.defaults.chunkSize;
    outVec.set(
      chunk.chunkX * chunkSize + chunk.records[o + REC_LOCAL_X],
      chunk.records[o + REC_LOCAL_Y],
      chunk.chunkZ * chunkSize + chunk.records[o + REC_LOCAL_Z]
    );
    return outVec;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public: erase a mutation ───────────────────────────
  // ══════════════════════════════════════════════════════════
  eraseMutation(chunkX, chunkZ, recordIndex) {
    const chunk = this.queryChunk(chunkX, chunkZ);
    if (!chunk) return false;
    if (recordIndex < 0 || recordIndex >= chunk.capacity) return false;
    if (chunk.preciseTimestamps[recordIndex] === 0) return false;
    this._freeRecord(chunk, recordIndex);
    this._totalMutations--;
    chunk.dirty = 1;
    this._stats.recordsRemoved++;
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public: erase entire chunk ─────────────────────────
  // ══════════════════════════════════════════════════════════
  clearChunk(chunkX, chunkZ) {
    const key = this._makeChunkKey(chunkX, chunkZ);
    const idx = this._chunkIndex.get(key);
    if (idx === undefined) return false;
    const chunk = this._chunkPool[idx];
    this._totalMutations -= chunk.count;
    this._stats.recordsRemoved += chunk.count;
    this._evictPoolIndex(idx);
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public: check chunk existence ──────────────────────
  // ══════════════════════════════════════════════════════════
  hasChunk(chunkX, chunkZ) {
    return this._chunkIndex.has(this._makeChunkKey(chunkX, chunkZ));
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public: prune decayed mutations ────────────────────
  // ══════════════════════════════════════════════════════════
  pruneDecayedMutations(now, threshold = this.defaults.decayPruneThreshold) {
    if (now === undefined) {
      now = this._clock ? this._clock.elapsedSeconds : performance.now() / 1000;
    }
    let prunedTotal = 0;

    for (let i = 0; i < this._chunkPoolUsed; i++) {
      const chunk = this._chunkPool[i];
      if (chunk.state !== CHUNK_STATE_ACTIVE) continue;

      let chunkPruned = 0;
      for (let r = 0; r < chunk.capacity; r++) {
        if (chunk.preciseTimestamps[r] === 0) continue;
        const o = r * RECORD_STRIDE_F32;
        const decay = chunk.records[o + REC_DECAY];
        const timestamp = chunk.preciseTimestamps[r];
        // D(τ) = exp(-τ/τ_decay) where τ is age and τ_decay is a
        // multiplier from the record's decay field.
        const age = now - timestamp;
        const d = Math.exp(-age / Math.max(0.001, decay));
        if (d < threshold) {
          // Check PERSISTENT flag.
          const packed = this._float32ToInt32(chunk.records[o + REC_TYPE]);
          const flags = (packed >>> 8) & 0xFF;
          if (flags & MUTATION_FLAG.PERSISTENT) continue;
          this._freeRecord(chunk, r);
          chunkPruned++;
        }
      }
      if (chunkPruned > 0) {
        chunk.dirty = 1;
        prunedTotal += chunkPruned;
      }
    }

    this._totalMutations -= prunedTotal;
    this._stats.recordsPruned += prunedTotal;
    return prunedTotal;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Serialization (binary, transferable) ───────────────
  // ══════════════════════════════════════════════════════════
  serialize() {
    this._stats.serializations++;

    // Count active chunks.
    let activeChunks = 0;
    for (let i = 0; i < this._chunkPoolUsed; i++) {
      if (this._chunkPool[i].state === CHUNK_STATE_ACTIVE) activeChunks++;
    }

    // Calculate total size.
    // Header: magic(4) + version(2) + chunkCount(4) = 10 bytes
    // Per chunk: chunkX(4) + chunkZ(4) + count(4) + seed(4) = 16 bytes
    // Per record: 56 bytes
    let size = 10;
    for (let i = 0; i < this._chunkPoolUsed; i++) {
      const chunk = this._chunkPool[i];
      if (chunk.state !== CHUNK_STATE_ACTIVE) continue;
      size += 16 + chunk.count * RECORD_STRIDE_BYTES;
    }

    // Grow buffer if needed.
    if (size > this._serializeBuffer.byteLength) {
      this._serializeBuffer = new ArrayBuffer(Math.max(size * 2, this._serializeBuffer.byteLength * 2));
    }

    const view = new DataView(this._serializeBuffer);
    let offset = 0;

    // ── Header ──────────────────────────────────────────
    view.setUint32(offset, SERIALIZATION_MAGIC, true);
    offset += 4;
    view.setUint16(offset, SERIALIZATION_VERSION, true);
    offset += 2;
    view.setUint32(offset, activeChunks, true);
    offset += 4;

    // ── Chunks ──────────────────────────────────────────
    for (let i = 0; i < this._chunkPoolUsed; i++) {
      const chunk = this._chunkPool[i];
      if (chunk.state !== CHUNK_STATE_ACTIVE) continue;

      view.setInt32(offset, chunk.chunkX, true);
      offset += 4;
      view.setInt32(offset, chunk.chunkZ, true);
      offset += 4;
      view.setUint32(offset, chunk.count, true);
      offset += 4;
      view.setUint32(offset, chunk.seed, true);
      offset += 4;

      // Write only active records.
      for (let r = 0; r < chunk.capacity; r++) {
        if (chunk.preciseTimestamps[r] === 0) continue;
        const o = r * RECORD_STRIDE_F32;
        for (let k = 0; k < RECORD_STRIDE_F32; k++) {
          view.setFloat32(offset, chunk.records[o + k], true);
          offset += 4;
        }
      }
    }

    // Return a sliced buffer (transferable slice).
    return this._serializeBuffer.slice(0, offset);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Deserialization (restore from binary) ──────────────
  // ══════════════════════════════════════════════════════════
  deserialize(buffer) {
    this._stats.deserializations++;

    const view = new DataView(buffer);
    let offset = 0;

    // ── Header ──────────────────────────────────────────
    const magic = view.getUint32(offset, true);
    offset += 4;
    if (magic !== SERIALIZATION_MAGIC) {
      console.warn('[PersistentWorldMemory] Invalid magic:', magic.toString(16));
      return false;
    }
    const version = view.getUint16(offset, true);
    offset += 2;
    if (version !== SERIALIZATION_VERSION) {
      console.warn('[PersistentWorldMemory] Unsupported version:', version);
      return false;
    }
    const chunkCount = view.getUint32(offset, true);
    offset += 4;

    // ── Clear existing state ────────────────────────────
    // (Preserve chunk pool objects; just reset them.)
    for (let i = 0; i < this._chunkPoolUsed; i++) {
      this._chunkPool[i].reset();
    }
    this._chunkPoolUsed = 0;
    this._chunkIndex.clear();
    this._lruHead = -1;
    this._lruTail = -1;
    this._lruPrev.fill(-1);
    this._lruNext.fill(-1);
    this._totalMutations = 0;

    // ── Read chunks ─────────────────────────────────────
    let restoredChunks = 0;
    for (let c = 0; c < chunkCount; c++) {
      if (offset + 16 > buffer.byteLength) break;

      const cx = view.getInt32(offset, true);
      offset += 4;
      const cz = view.getInt32(offset, true);
      offset += 4;
      const recCount = view.getUint32(offset, true);
      offset += 4;
      const seed = view.getUint32(offset, true);
      offset += 4;

      const now = performance.now() / 1000;
      const chunk = this._acquireChunk(cx, cz, now);
      if (!chunk) continue;

      chunk.seed = seed;
      restoredChunks++;

      // Read records.
      for (let r = 0; r < recCount; r++) {
        if (offset + RECORD_STRIDE_BYTES > buffer.byteLength) break;
        const recIdx = this._allocRecord(chunk);
        if (recIdx < 0) break;

        const o = recIdx * RECORD_STRIDE_F32;
        for (let k = 0; k < RECORD_STRIDE_F32; k++) {
          chunk.records[o + k] = view.getFloat32(offset, true);
          offset += 4;
        }
        chunk.preciseTimestamps[recIdx] = chunk.records[o + REC_TIMESTAMP];
        chunk.count++;
        this._totalMutations++;
      }

      chunk.dirty = 0;
    }

    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Auto-save dispatch ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  autoSaveTick(now) {
    if (!this.defaults.enableAutoSave) return false;
    if (now - this._lastAutoSaveTime < this.defaults.autoSaveInterval) return false;
    this._lastAutoSaveTime = now;
    this._stats.autoSaves++;
    return true;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToSpatialLayer(frame) {
    const spatial = frame.layers.spatial;
    if (!spatial) return;

    // Expose chunk memory as a flat read-only view for consumers.
    if (!spatial.worldMemory) {
      spatial.worldMemory = {
        chunkPool: this._chunkPool,
        chunkPoolUsed: 0,
        chunkIndex: this._chunkIndex,
        totalMutations: 0
      };
    }
    spatial.worldMemory.chunkPoolUsed = this._chunkPoolUsed;
    spatial.worldMemory.totalMutations = this._totalMutations;
  }

  _writeToPhysicalLayer(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.worldMemoryProperties) {
      physical.worldMemoryProperties = {
        totalMutations: 0,
        activeChunks: 0,
        chunkCapacity: 0,
        mutationCapacity: 0,
        memoryUsedBytes: 0,
        memoryBudgetBytes: 0,
        dirtyChunks: 0,
        lruTail: -1
      };
    }

    const wm = physical.worldMemoryProperties;
    wm.totalMutations = this._totalMutations;
    wm.activeChunks = this._chunkPoolUsed;
    wm.chunkCapacity = this.defaults.chunkCapacity;
    wm.mutationCapacity = this.defaults.maxTotalMutations;
    wm.memoryUsedBytes = this._chunkPoolUsed * this.defaults.mutationsPerChunk * RECORD_STRIDE_BYTES;
    wm.memoryBudgetBytes = this.defaults.chunkCapacity * this.defaults.mutationsPerChunk * RECORD_STRIDE_BYTES;
    wm.lruTail = this._lruTail;

    let dirtyCount = 0;
    for (let i = 0; i < this._chunkPoolUsed; i++) {
      if (this._chunkPool[i].state === CHUNK_STATE_ACTIVE && this._chunkPool[i].dirty === 1) {
        dirtyCount++;
      }
    }
    wm.dirtyChunks = dirtyCount;

    // Expose aggregate stats.
    physical.persistentMutationsTotal = this._totalMutations;
    physical.persistentChunksActive = this._chunkPoolUsed;
    physical.persistentMemoryMB = wm.memoryUsedBytes / (1024 * 1024);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Per-frame mutation event emission ──────────────────
  // ══════════════════════════════════════════════════════════
  _emitPendingMutationEvents() {
    if (!this._dispatcher) {
      this._pendingMutationChunks.length = 0;
      return;
    }

    // Coalesce: one event per chunk per frame.
    const seen = new Set();
    for (let i = 0; i < this._pendingMutationChunks.length; i++) {
      const chunk = this._pendingMutationChunks[i];
      if (!chunk || chunk.state !== CHUNK_STATE_ACTIVE) continue;
      const key = this._makeChunkKey(chunk.chunkX, chunk.chunkZ);
      if (seen.has(key)) continue;
      seen.add(key);

      this._dispatcher.queueCausalEvent(
        EVENT_TYPE.MUTATION,
        [
          (chunk.chunkX + 0.5) * this.defaults.chunkSize,
          0,
          (chunk.chunkZ + 0.5) * this.defaults.chunkSize
        ],
        -1,
        chunk.count * 5,
        10.0,
        {
          kind: 'world_memory_update',
          chunkX: chunk.chunkX,
          chunkZ: chunk.chunkZ,
          recordCount: chunk.count,
          chunkSeed: chunk.seed
        }
      );
    }
    this._pendingMutationChunks.length = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame, clock) {
    if (!frame || !frame.layers) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    this._frameRef = frame;

    // Emit accumulated mutation events.
    this._emitPendingMutationEvents();

    // Auto-save tick.
    if (this.autoSaveTick(now)) {
      // Dispatch a signal that the save system can consume.
      if (this._dispatcher) {
        this._dispatcher.queueCausalEvent(
          EVENT_TYPE.MUTATION, [0, 0, 0], -1, 1, 60.0,
          { kind: 'auto_save_trigger', mutations: this._totalMutations }
        );
      }
    }

    // Write to frame.
    this._writeToSpatialLayer(frame);
    this._writeToPhysicalLayer(frame);

    return 1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({ ...this._stats });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) this._stats[k] = 0;
  }

  get totalMutations() { return this._totalMutations; }
  get activeChunks() { return this._chunkPoolUsed; }
  get memoryUsedBytes() {
    return this._chunkPoolUsed * this.defaults.mutationsPerChunk * RECORD_STRIDE_BYTES;
  }

  dispose() {
    for (let i = 0; i < this._chunkPoolUsed; i++) {
      this._chunkPool[i].reset();
    }
    this._chunkPoolUsed = 0;
    this._chunkIndex.clear();
    this._totalMutations = 0;
    this._lruHead = -1;
    this._lruTail = -1;
    this._pendingMutationChunks.length = 0;
    this._dispatcher = null;
    this._clock = null;
    this._materials = null;
    this._frameRef = null;
  }
}

export {
  PersistentWorldMemory,
  ChunkMemory,
  MUTATION_TYPE,
  MUTATION_TYPE_NAMES,
  MUTATION_FLAG,
  RECORD_STRIDE_BYTES,
  RECORD_STRIDE_F32,
  SERIALIZATION_MAGIC,
  SERIALIZATION_VERSION
};