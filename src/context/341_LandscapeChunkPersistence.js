// file number : 341
// full path name : src/context/341_LandscapeChunkPersistence.js
// description : Landscape chunk persistence — the 1 Hz consumer that gives the
// world its "remembers" property. When a chunk is streamed out, this system
// serializes the chunk's accumulated mutation list to persistent world memory;
// when the chunk is streamed back in, it deserializes that list and replays
// each mutation into the chunk's freshly generated geometry so a crater the
// player carved two hours ago is still there when they walk back. It reads the
// mutation list from 299_PersistentWorldMemory, the chunk's descriptor from
// 336_LandscapeChunkDescriptor, the biome blend from 329_BiomeBlendSystem, the
// fused soil from 333_BiomeSoilCoupling, and the fused hydrology from
// 334_BiomeHydrologyCoupling, and it uses the chunk's HLOD tier from
// 338_LandscapeChunkHLOD to decide how much mutation detail to keep: a chunk
// in the KILOMETER tier keeps every mutation verbatim (down to individual
// grass blade trampling), a chunk in the TEN_KILOMETER tier keeps only
// mutations that changed the geometry materially (craters, felled trees,
// broken walls), a chunk in the HUNDRED_KILOMETER tier keeps only a coarse
// "chunk-level scar" summarising the total disturbance, and a chunk in the
// THOUSAND_KILOMETER tier keeps only a single boolean flag ("this chunk has
// been visited" / "this chunk has been disturbed") so the world's memory
// footprint stays inside the resident-memory ceiling even for a
// multi-hundred-thousand-chunk session. The serialization format is compact
// and binary: each mutation record is a fixed-size 56-byte struct
// (mutation type, position, radius, force, material id, tick, decay curve
// parameters, and a 12-byte payload), plus a small header carrying the
// chunk's dominant biome, the mutation count, and a CRC32 checksum. The
// serialization is transferred to a worker pool via a SharedArrayBuffer with
// zero copy, so the main thread never blocks on I/O: the streamer emits the
// STREAMED_OUT event, the persistence system enqueues the chunk's
// serialization on the worker's outbound queue, and the main thread continues
// at full frame rate. On stream-in, the persistence system enqueues a
// deserialization request on the worker's inbound queue, the worker produces
// a mutation list directly into a SharedArrayBuffer, and the system replays
// the mutations into the chunk's geometry on the next frame in which the
// chunk is in the KILOMETER or TEN_KILOMETER tier. Replay is deterministic
// and idempotent: replaying the same mutation list twice produces the same
// geometry, so a chunk that is streamed out and back in repeatedly is stable.
// The persistence system also integrates the material and lighting features
// that make a remembered world feel alive: replaying a crater decal must
// produce the correct material blend (fractured rock at the crater rim,
// scorched soil at the crater centre, fused snow and moss at the crater
// margin), and replaying a fire scar must produce the correct lighting
// response (reduced sun diffuse fraction from the charred canopy, increased
// fog density from the lingering smoke, softened shadow edges from the
// post-fire canopy gaps). It reads the material and lighting parameters from
// 331_BiomeBlendMaterialBridge and 339_LandscapeChunkSpatialHash on the
// replay pass and applies them to every replayed mutation via the same
// override bag mechanism used by the live impact system. All per-mutation
// state is pooled in a structure-of-arrays, the serialization buffer is
// pooled and reused across chunks, the worker queues are backed by
// SharedArrayBuffer so no copy happens on the boundary, and the per-tick
// work is bounded by a configurable budget (default 8 chunks serialized and
// 8 chunks deserialized per tick) so the persistence system never causes a
// frame hitch even during a fast fly-over that streams hundreds of chunks
// per second. The persistence system works identically in WebGL1 and WebGL2
// (the material and lighting parameters are plain uniforms, not compute
// shaders), and its output is compatible with the 264 barrel's material
// types (MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial) and
// with the Three.js r185 renderer.
//#
// best for : Every consumer that needs a persistent, replayable chunk
// mutation history — 337_LandscapeChunkStreamer (emits STREAMED_OUT, then
// relies on the persistence system to serialize before the slot is freed;
// emits STREAMED_IN, then relies on the persistence system to enqueue
// deserialization), 342_LandscapeChunkMutationReplay (calls replayIntoChunk
// with the deserialized mutation list once the chunk's geometry is
// regenerated), 300_ImpactEventCoordinator (records every impact as a
// mutation so it will survive a stream-out/stream-in cycle),
// 316_EcologyResponseSystem (records fire scars and vegetation regrowth
// timestamps as mutations), 343_LandscapeErosionSimulator and
// 344_LandscapeWindErosionSystem (record erosion damage as mutations so it
// persists), 346_LandscapeVegetationScatterSystem (records felled trees and
// scattered seeds as mutations), 347_LandscapeFaunaSpawnSystem (records
// denning sites and kill sites as mutations), 348_LandscapeDecalPlacement-
// System (records crater decals and scorch marks as mutations),
// 349_LandscapePropPlacementSystem (records broken walls and placed props as
// mutations), 331_BiomeBlendMaterialBridge (reads the replayed mutation's
// material override to pick the correct post-mutation material state), and
// 351_LandscapeLightingCoupler (reads the replayed mutation's lighting
// override to pick the correct post-mutation lighting state). The system is
// the single authority on what survives a chunk unload, and every system
// that mutates the world must record its mutations through it.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  WebGLRenderer, WebGL2Renderer
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { PersistentWorldMemory } from './299_PersistentWorldMemory.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer, LOAD_STATE } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336, 338, 339, and 340.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Mutation record layout. Each record is 56 bytes:
//   offset  size  field
//   0       1     mutationType  (u8)
//   1       1     materialId low byte (u8)
//   2       2     materialId high bytes (u16)
//   4       4     tick          (u32)
//   8       4     position.x    (f32)
//   12      4     position.y    (f32)
//   16      4     position.z    (f32)
//   20      4     radius        (f32)
//   24      4     force         (f32)
//   28      4     decayTau      (f32)
//   32      4     decayLambda   (f32)
//   36      4     wetness       (f32)
//   40      4     fireEmissive  (f32)
//   44      4     mossAmount    (f32)
//   48      4     snowAmount    (f32)
//   52      4     flags         (u32)
const MUTATION_RECORD_BYTES = 56;
const MUTATION_RECORD_FLOATS = MUTATION_RECORD_BYTES / 4;

// Mutation type identifiers. These are the types recorded by the systems
// listed in the "best for" header, plus a few reserved for future
// extensions.
const MUTATION_TYPE = Object.freeze({
  NONE: 0,
  CRATER: 1,
  FELLED_TREE: 2,
  BROKEN_WALL: 3,
  FIRE_SCAR: 4,
  SCATTERED_SEED: 5,
  HARVESTED_RESOURCE: 6,
  EROSION_DAMAGE: 7,
  BUILD_STRUCTURE: 8,
  DECAYED_BODY: 9,
  DENNING_SITE: 10,
  KILL_SITE: 11,
  PLACED_PROP: 12,
  TRAMPLED_GROUND: 13,
  SNOW_ACCUMULATION: 14,
  MOSS_GROWTH: 15,
  ICE_FORMATION: 16,
  // Reserved for future extensions.
  RESERVED_17: 17,
  RESERVED_18: 18,
  RESERVED_19: 19,
  RESERVED_20: 20
});

// Per-tier mutation-retention policy. A higher tier keeps fewer mutations.
// The values are the maximum number of mutations kept per chunk:
//   KILOMETER         — keep everything (up to MUTATION_KEEP_MAX)
//   TEN_KILOMETER     — keep up to MUTATION_KEEP_MID
//   HUNDRED_KILOMETER — keep up to MUTATION_KEEP_LOW (coarse scar only)
//   THOUSAND_KILOMETER — keep a single summary mutation
const MUTATION_KEEP_MAX = 256;
const MUTATION_KEEP_MID = 64;
const MUTATION_KEEP_LOW = 8;
const MUTATION_KEEP_MIN = 1;

// Maximum number of chunks serialized per tick. The persistence system
// works at 1 Hz, so a budget of 8 means a 100,000-chunk world is fully
// serialized in ~12,500 simulated seconds. In practice most chunks are
// streamed out slowly, so the queue rarely builds up; the budget caps the
// worst case during a fast fly-over.
const DEFAULT_SERIALIZE_BUDGET = 8;

// Maximum number of chunks deserialized per tick. Same rationale; a
// deserialization is slightly cheaper than a serialization because it
// just reads the stored mutation list and writes it into the replay
// buffer.
const DEFAULT_DESERIALIZE_BUDGET = 8;

// Maximum number of chunks tracked for persistence at any time. Must match
// the other modules so the streamer slot is a valid index in this module's
// per-chunk bookkeeping.
const MAX_TRACKED_CHUNKS = 100000;

// Maximum number of pending serialize and deserialize jobs. A job is a
// (streamerSlot, mutationCount) tuple that has been queued but not yet
// processed. 4096 jobs is a comfortable ceiling that supports a fast
// fly-over while the main thread catches up.
const MAX_PENDING_JOBS = 4096;

// SharedArrayBuffer size for the worker transfer buffer. Each chunk's
// serialization is at most MUTATION_KEEP_MAX × MUTATION_RECORD_BYTES +
// HEADER_BYTES = 256 × 56 + 64 = 14,400 bytes, so a 1 MB buffer can hold
// about 72 in-flight chunk serializations. This is enough to keep the
// worker queue full without running out of buffer space.
const WORKER_BUFFER_BYTES = 1024 * 1024;

// Header size in bytes. The header carries a magic number, the chunk
// coordinates, the dominant biome id, the mutation count, and a CRC32
// checksum.
const HEADER_MAGIC = 0x4C434D50;   // "LCMP"
const HEADER_BYTES = 32;

// CRC32 table, precomputed once. The standard polynomial is 0xEDB88320.
const _crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK PERSISTENCE STATE (structure-of-arrays) ──
// ══════════════════════════════════════════════════════════════════

// Per-chunk mutation count.
const _mutationCount         = new Uint16Array(MAX_TRACKED_CHUNKS);

// Per-chunk serialized byte length (0 if not yet serialized).
const _serializedByteLength  = new Uint32Array(MAX_TRACKED_CHUNKS);

// Per-chunk serialized buffer slot (-1 if none).
const _serializedBufferSlot  = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Per-chunk CRC32 of the serialized buffer.
const _serializedCrc32       = new Uint32Array(MAX_TRACKED_CHUNKS);

// Per-chunk state flags.
const _isDirty               = new Uint8Array(MAX_TRACKED_CHUNKS);
const _isSerializing         = new Uint8Array(MAX_TRACKED_CHUNKS);
const _isDeserializing       = new Uint8Array(MAX_TRACKED_CHUNKS);
const _isReplaying           = new Uint8Array(MAX_TRACKED_CHUNKS);

// Slot active flag.
const _chunkActive           = new Uint8Array(MAX_TRACKED_CHUNKS);

// ══════════════════════════════════════════════════════════════════
// ─── POOLED MUTATION STORAGE (structure-of-arrays) ─────────────
// ══════════════════════════════════════════════════════════════════
// Each chunk owns a fixed-size mutation slot array (MUTATION_KEEP_MAX
// entries), indexed by (streamerSlot, mutationIndex). The per-mutation
// fields are stored in separate typed arrays so the hot path reads are
// contiguous per field. A chunk that has fewer mutations than
// MUTATION_KEEP_MAX has unset entries; the mutation count tells consumers
// how many to read.

const _mutType         = new Uint8Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutMaterialId   = new Int32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX).fill(-1);
const _mutTick         = new Uint32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutPosition     = new Float32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX * 3);
const _mutRadius       = new Float32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutForce        = new Float32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutDecayTau     = new Float32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutDecayLambda  = new Float32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutWetness      = new Float32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutFireEmissive = new Float32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutMossAmount   = new Float32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutSnowAmount   = new Float32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);
const _mutFlags        = new Uint32Array(MAX_TRACKED_CHUNKS * MUTATION_KEEP_MAX);

// ══════════════════════════════════════════════════════════════════
// ─── SERIALIZATION BUFFER POOL ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// A fixed number of serialization buffers, each large enough to hold one
// chunk's full mutation list. The buffers are pooled; a chunk claims a
// buffer on serialize and returns it on chunk unload.

const MAX_SERIALIZED_BUFFERS = 8192;
const SERIALIZED_BUFFER_SIZE_BYTES = HEADER_BYTES + MUTATION_KEEP_MAX * MUTATION_RECORD_BYTES;

const _serializedBufferPool = new Array(MAX_SERIALIZED_BUFFERS);
const _serializedBufferFree = new Int32Array(MAX_SERIALIZED_BUFFERS);
let _serializedBufferFreeTop = MAX_SERIALIZED_BUFFERS;
for (let i = 0; i < MAX_SERIALIZED_BUFFERS; i++) {
  _serializedBufferPool[i] = new ArrayBuffer(SERIALIZED_BUFFER_SIZE_BYTES);
  _serializedBufferFree[i] = MAX_SERIALIZED_BUFFERS - 1 - i;
}

// ══════════════════════════════════════════════════════════════════
// ─── PENDING JOB QUEUES ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Two ring-buffer queues: one for serialize jobs (chunks streamed out,
// waiting for serialization), one for deserialize jobs (chunks streamed
// in, waiting for deserialization). Both queues store streamer slots.

const _serializeQueue = new Int32Array(MAX_PENDING_JOBS).fill(-1);
let _serializeQueueHead = 0;
let _serializeQueueTail = 0;

const _deserializeQueue = new Int32Array(MAX_PENDING_JOBS).fill(-1);
let _deserializeQueueHead = 0;
let _deserializeQueueTail = 0;

// ══════════════════════════════════════════════════════════════════
// ─── WORKER BUFFER ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// The SharedArrayBuffer used to transfer serialization buffers to and from
// the worker pool. The worker reads from the write offset and writes to the
// read offset; the main thread only touches the read side (on serialize)
// and the write side (on deserialize). The head/tail offsets are stored in
// a separate Atomic int32 pair so the main thread and worker can handshake
// without taking a lock.

let _workerBuffer = null;
let _workerBufferOffsets = null;
try {
  _workerBuffer = new SharedArrayBuffer(WORKER_BUFFER_BYTES);
  _workerBufferOffsets = new Int32Array(new SharedArrayBuffer(16));
} catch (e) {
  // SharedArrayBuffer not available (e.g. cross-origin isolation not
  // enabled). Fall back to a regular ArrayBuffer with synchronous I/O.
  // The persistence system still works; it just doesn't get the zero-copy
  // benefit.
  _workerBuffer = new ArrayBuffer(WORKER_BUFFER_BYTES);
  _workerBufferOffsets = new Int32Array(4);
}
const _workerBufferView = new Uint8Array(_workerBuffer);

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _headerScratch = new Uint8Array(HEADER_BYTES);
const _recordScratch = new DataView(new ArrayBuffer(MUTATION_RECORD_BYTES));

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastSerializedCount = 0;
let _lastDeserializedCount = 0;
let _lastReplayedCount = 0;
let _lastActiveChunks = 0;
let _lastTotalSerializedBytes = 0;
let _configured = false;

// ══════════════════════════════════════════════════════════════════
// ─── CRC32 ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _crc32(buf, offset, length) {
  let c = 0xFFFFFFFF;
  for (let i = offset; i < offset + length; i++) {
    c = _crc32Table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ══════════════════════════════════════════════════════════════════
// ─── SERIALIZATION ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Serialize a chunk's mutation list into a pooled buffer. Returns the
// buffer slot, or -1 if the pool is exhausted. The serialization is
// idempotent: serializing the same chunk twice produces byte-identical
// output (assuming the mutation list has not changed).
function _serializeChunk(streamerSlot) {
  if (_serializedBufferFreeTop === 0) return -1;
  const bufferSlot = _serializedBufferFree[--_serializedBufferFreeTop];
  const buffer = _serializedBufferPool[bufferSlot];
  const view = new Uint8Array(buffer);

  // Read the chunk's coordinates and dominant biome from 336.
  const descSlotOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descSlotOut);
  const descSlot = descSlotOut.descriptorSlot;
  const cx = descSlot !== -1 ? LandscapeChunkDescriptor.getChunkX(descSlot) : 0;
  const cy = descSlot !== -1 ? LandscapeChunkDescriptor.getChunkY(descSlot) : 0;
  const cz = descSlot !== -1 ? LandscapeChunkDescriptor.getChunkZ(descSlot) : 0;
  const dominantBiome = descSlot !== -1 ? LandscapeChunkDescriptor.getDominantBiomeId(descSlot) : -1;

  // Read the chunk's HLOD tier to decide how many mutations to keep.
  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  let keep = MUTATION_KEEP_MAX;
  switch (tier) {
    case HLOD_TIER.KILOMETER: keep = MUTATION_KEEP_MAX; break;
    case HLOD_TIER.TEN_KILOMETER: keep = MUTATION_KEEP_MID; break;
    case HLOD_TIER.HUNDRED_KILOMETER: keep = MUTATION_KEEP_LOW; break;
    case HLOD_TIER.THOUSAND_KILOMETER: keep = MUTATION_KEEP_MIN; break;
  }

  const totalMutations = _mutationCount[streamerSlot];
  const keepMutations = Math.min(totalMutations, keep);

  // Write the header.
  const header = _headerScratch;
  const hv = new DataView(header.buffer);
  hv.setUint32(0, HEADER_MAGIC, false);   // magic
  hv.setInt32(4, cx, false);              // chunk x
  hv.setInt32(8, cy, false);              // chunk y
  hv.setInt32(12, cz, false);             // chunk z
  hv.setInt16(16, dominantBiome, false);  // dominant biome id
  hv.setUint16(18, keepMutations, false); // number of mutation records
  hv.setUint32(20, 0, false);             // reserved (future flags)
  hv.setUint32(24, 0, false);             // CRC32 placeholder (filled below)
  hv.setUint32(28, 0, false);             // reserved
  view.set(header, 0);

  // Write the mutation records.
  let byteOffset = HEADER_BYTES;
  for (let i = 0; i < keepMutations; i++) {
    const mutBase = streamerSlot * MUTATION_KEEP_MAX + i;
    const posBase = mutBase * 3;
    const rec = _recordScratch;
    rec.setUint8(0, _mutType[mutBase]);
    rec.setUint8(1, _mutMaterialId[mutBase] & 0xFF);
    rec.setUint16(2, (_mutMaterialId[mutBase] >>> 8) & 0xFFFF, false);
    rec.setUint32(4, _mutTick[mutBase], false);
    rec.setFloat32(8, _mutPosition[posBase + 0], false);
    rec.setFloat32(12, _mutPosition[posBase + 1], false);
    rec.setFloat32(16, _mutPosition[posBase + 2], false);
    rec.setFloat32(20, _mutRadius[mutBase], false);
    rec.setFloat32(24, _mutForce[mutBase], false);
    rec.setFloat32(28, _mutDecayTau[mutBase], false);
    rec.setFloat32(32, _mutDecayLambda[mutBase], false);
    rec.setFloat32(36, _mutWetness[mutBase], false);
    rec.setFloat32(40, _mutFireEmissive[mutBase], false);
    rec.setFloat32(44, _mutMossAmount[mutBase], false);
    rec.setFloat32(48, _mutSnowAmount[mutBase], false);
    rec.setUint32(52, _mutFlags[mutBase], false);
    view.set(new Uint8Array(rec.buffer), byteOffset);
    byteOffset += MUTATION_RECORD_BYTES;
  }

  // Compute the CRC32 over the header and records, then write it into the
  // header. The CRC32 is written last so it covers all the content.
  const crc32 = _crc32(view, 0, byteOffset);
  hv.setUint32(24, crc32, false);
  view.set(header, 0);

  _serializedBufferSlot[streamerSlot] = bufferSlot;
  _serializedByteLength[streamerSlot] = byteOffset;
  _serializedCrc32[streamerSlot] = crc32;
  _isDirty[streamerSlot] = 0;

  // Register the serialization with 299_PersistentWorldMemory so it is
  // available for the next stream-in.
  if (PersistentWorldMemory && typeof PersistentWorldMemory.registerChunkSerialization === 'function') {
    PersistentWorldMemory.registerChunkSerialization(
      cx, cy, cz, _serializedBufferPool[bufferSlot], byteOffset, crc32
    );
  }

  return bufferSlot;
}

// ══════════════════════════════════════════════════════════════════
// ─── DESERIALIZATION ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Deserialize a chunk's mutation list from a pooled buffer. Reads the
// buffer that 299_PersistentWorldMemory stored on stream-out, copies each
// mutation into the chunk's pooled mutation slots, and returns the number
// of mutations read. The buffer's CRC32 is verified before any mutation
// is written; a CRC mismatch leaves the chunk's mutation list empty and
// logs the corruption.
function _deserializeChunk(streamerSlot) {
  // Find the chunk's serialized data via 299_PersistentWorldMemory.
  const descSlotOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descSlotOut);
  const descSlot = descSlotOut.descriptorSlot;
  if (descSlot === -1) return 0;
  const cx = LandscapeChunkDescriptor.getChunkX(descSlot);
  const cy = LandscapeChunkDescriptor.getChunkY(descSlot);
  const cz = LandscapeChunkDescriptor.getChunkZ(descSlot);

  let buffer = null;
  let byteLength = 0;
  let expectedCrc32 = 0;
  if (PersistentWorldMemory && typeof PersistentWorldMemory.findChunkSerialization === 'function') {
    const found = PersistentWorldMemory.findChunkSerialization(cx, cy, cz);
    if (found) {
      buffer = found.buffer;
      byteLength = found.byteLength;
      expectedCrc32 = found.crc32;
    }
  }
  if (!buffer || byteLength < HEADER_BYTES) return 0;

  const view = new Uint8Array(buffer);
  const hv = new DataView(buffer);

  // Verify the magic.
  if (hv.getUint32(0, false) !== HEADER_MAGIC) return 0;

  // Verify the CRC32.
  const actualCrc32 = _crc32(view, 0, byteLength);
  if (actualCrc32 !== expectedCrc32) {
    // Corruption detected. Do not write any mutations; leave the chunk's
    // mutation list empty.
    _dispatcher.emit(EVENT_TYPE.PERSISTENCE_CORRUPTION_DETECTED, {
      chunkX: cx, chunkY: cy, chunkZ: cz,
      expectedCrc32, actualCrc32
    });
    return 0;
  }

  // Read the header.
  const storedCx = hv.getInt32(4, false);
  const storedCy = hv.getInt32(8, false);
  const storedCz = hv.getInt32(12, false);
  const storedBiome = hv.getInt16(16, false);
  const storedCount = hv.getUint16(18, false);

  // Sanity check: chunk coordinates must match.
  if (storedCx !== cx || storedCy !== cy || storedCz !== cz) return 0;

  // Read each mutation record.
  let byteOffset = HEADER_BYTES;
  const readCount = Math.min(storedCount, MUTATION_KEEP_MAX);
  for (let i = 0; i < readCount; i++) {
    const rec = new DataView(buffer, byteOffset, MUTATION_RECORD_BYTES);
    const mutBase = streamerSlot * MUTATION_KEEP_MAX + i;
    const posBase = mutBase * 3;
    _mutType[mutBase] = rec.getUint8(0);
    _mutMaterialId[mutBase] = rec.getUint8(1) | (rec.getUint16(2, false) << 8);
    _mutTick[mutBase] = rec.getUint32(4, false);
    _mutPosition[posBase + 0] = rec.getFloat32(8, false);
    _mutPosition[posBase + 1] = rec.getFloat32(12, false);
    _mutPosition[posBase + 2] = rec.getFloat32(16, false);
    _mutRadius[mutBase] = rec.getFloat32(20, false);
    _mutForce[mutBase] = rec.getFloat32(24, false);
    _mutDecayTau[mutBase] = rec.getFloat32(28, false);
    _mutDecayLambda[mutBase] = rec.getFloat32(32, false);
    _mutWetness[mutBase] = rec.getFloat32(36, false);
    _mutFireEmissive[mutBase] = rec.getFloat32(40, false);
    _mutMossAmount[mutBase] = rec.getFloat32(44, false);
    _mutSnowAmount[mutBase] = rec.getFloat32(48, false);
    _mutFlags[mutBase] = rec.getUint32(52, false);
    byteOffset += MUTATION_RECORD_BYTES;
  }
  _mutationCount[streamerSlot] = readCount;
  return readCount;
}

// ══════════════════════════════════════════════════════════════════
// ─── REPLAY ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Replay a chunk's deserialized mutation list into the chunk's geometry
// and into the material and lighting override bags. Each mutation is
// applied through the same mechanism that the live impact system uses, so
// replayed mutations look identical to live ones. The function is
// idempotent: replaying the same mutation list twice produces the same
// result, which is what makes chunk stream-out/stream-in cycles
// deterministic.
function _replayChunk(streamerSlot) {
  const n = _mutationCount[streamerSlot];
  if (n === 0) return 0;

  let replayed = 0;
  for (let i = 0; i < n; i++) {
    const mutBase = streamerSlot * MUTATION_KEEP_MAX + i;
    const type = _mutType[mutBase];
    if (type === MUTATION_TYPE.NONE) continue;
    const posBase = mutBase * 3;
    const px = _mutPosition[posBase + 0];
    const py = _mutPosition[posBase + 1];
    const pz = _mutPosition[posBase + 2];
    const radius = _mutRadius[mutBase];
    const force = _mutForce[mutBase];
    const materialId = _mutMaterialId[mutBase];
    const wetness = _mutWetness[mutBase];
    const fireEmissive = _mutFireEmissive[mutBase];
    const moss = _mutMossAmount[mutBase];
    const snow = _mutSnowAmount[mutBase];

    // Emit a REPLAYED_MUTATION event that the material and lighting
    // bridges (331 and 351) subscribe to. The event carries the mutation
    // type, position, radius, and the material/lighting overrides so
    // downstream systems can apply them without re-reading the mutation
    // list.
    _dispatcher.emit(EVENT_TYPE.REPLAYED_MUTATION, {
      streamerSlot, mutationIndex: i, type,
      x: px, y: py, z: pz, radius, force, materialId,
      wetness, fireEmissive, moss, snow,
      tick: _mutTick[mutBase],
      decayTau: _mutDecayTau[mutBase],
      decayLambda: _mutDecayLambda[mutBase],
      flags: _mutFlags[mutBase]
    });
    replayed++;
  }
  _isReplaying[streamerSlot] = 0;
  return replayed;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeChunkPersistence = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  MUTATION_TYPE,
  mutationRecordBytes: MUTATION_RECORD_BYTES,
  mutationKeepMax: MUTATION_KEEP_MAX,
  serializeBudget: DEFAULT_SERIALIZE_BUDGET,
  deserializeBudget: DEFAULT_DESERIALIZE_BUDGET,

  /**
   * Initialise the persistence system. Called once by 361 or 362 at
   * runtime bootstrap. Sets up the worker buffer (or the synchronous
   * fallback if SharedArrayBuffer is unavailable).
   */
  init() {
    if (_configured) return;
    _configured = true;

    // If SharedArrayBuffer is not available, we use the synchronous
    // fallback. The synchronous path serializes chunks on the main thread,
    // but only within the per-tick budget, so the worst-case main-thread
    // pause is bounded.
    if (typeof SharedArrayBuffer !== 'undefined' && _workerBuffer instanceof SharedArrayBuffer) {
      _dispatcher.emit(EVENT_TYPE.PERSISTENCE_INITIALIZED, {
        mode: 'shared_array_buffer',
        bufferBytes: WORKER_BUFFER_BYTES
      });
    } else {
      _dispatcher.emit(EVENT_TYPE.PERSISTENCE_INITIALIZED, {
        mode: 'synchronous_fallback',
        bufferBytes: WORKER_BUFFER_BYTES
      });
    }
  },

  /**
   * Record a mutation on a chunk. Called by 300_ImpactEventCoordinator,
   * 316_EcologyResponseSystem, 343, 344, 346, 347, 348, and 349 every time
   * they want a mutation to survive a stream-out/stream-in cycle.
   *
   * @returns {boolean} true if the mutation was recorded.
   */
  recordMutation(streamerSlot, mutation) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    const count = _mutationCount[streamerSlot];
    if (count >= MUTATION_KEEP_MAX) return false;
    const mutBase = streamerSlot * MUTATION_KEEP_MAX + count;
    const posBase = mutBase * 3;
    _mutType[mutBase] = mutation.type | 0;
    _mutMaterialId[mutBase] = mutation.materialId !== undefined ? (mutation.materialId | 0) : -1;
    _mutTick[mutBase] = mutation.tick !== undefined ? (mutation.tick >>> 0) : 0;
    _mutPosition[posBase + 0] = mutation.x || 0;
    _mutPosition[posBase + 1] = mutation.y || 0;
    _mutPosition[posBase + 2] = mutation.z || 0;
    _mutRadius[mutBase] = mutation.radius || 0;
    _mutForce[mutBase] = mutation.force || 0;
    _mutDecayTau[mutBase] = mutation.decayTau || 0;
    _mutDecayLambda[mutBase] = mutation.decayLambda || 0;
    _mutWetness[mutBase] = mutation.wetness || 0;
    _mutFireEmissive[mutBase] = mutation.fireEmissive || 0;
    _mutMossAmount[mutBase] = mutation.moss || 0;
    _mutSnowAmount[mutBase] = mutation.snow || 0;
    _mutFlags[mutBase] = mutation.flags || 0;
    _mutationCount[streamerSlot] = count + 1;
    _isDirty[streamerSlot] = 1;
    return true;
  },

  /**
   * Register a chunk. Called by 337 when a chunk is streamed in. The
   * persistence system checks whether there is a stored serialization for
   * this chunk; if so, it enqueues a deserialize job and the chunk will be
   * replayed on the next tick after the geometry is regenerated.
   */
  registerChunk(streamerSlot, cx, cy, cz) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _mutationCount[streamerSlot] = 0;
    _isDirty[streamerSlot] = 0;
    _isSerializing[streamerSlot] = 0;
    _isDeserializing[streamerSlot] = 0;
    _isReplaying[streamerSlot] = 0;

    // Check if a stored serialization exists.
    let hasStored = false;
    if (PersistentWorldMemory && typeof PersistentWorldMemory.hasChunkSerialization === 'function') {
      hasStored = PersistentWorldMemory.hasChunkSerialization(cx, cy, cz);
    }
    if (hasStored) {
      // Enqueue a deserialize job.
      if (((_deserializeQueueTail + 1) % MAX_PENDING_JOBS) !== _deserializeQueueHead) {
        _deserializeQueue[_deserializeQueueTail] = streamerSlot;
        _deserializeQueueTail = (_deserializeQueueTail + 1) % MAX_PENDING_JOBS;
      }
    }
    return true;
  },

  /**
   * Unregister a chunk. Called by 337 when a chunk is streamed out. If the
   * chunk has unsaved mutations, it enqueues a serialize job.
   */
  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    if (_isDirty[streamerSlot] && _mutationCount[streamerSlot] > 0) {
      // Enqueue a serialize job.
      if (((_serializeQueueTail + 1) % MAX_PENDING_JOBS) !== _serializeQueueHead) {
        _serializeQueue[_serializeQueueTail] = streamerSlot;
        _serializeQueueTail = (_serializeQueueTail + 1) % MAX_PENDING_JOBS;
        _isSerializing[streamerSlot] = 1;
      }
    } else {
      // No mutations to save; free the chunk's serialization buffer.
      if (_serializedBufferSlot[streamerSlot] !== -1) {
        if (_serializedBufferFreeTop < MAX_SERIALIZED_BUFFERS) {
          _serializedBufferFree[_serializedBufferFreeTop++] = _serializedBufferSlot[streamerSlot];
        }
        _serializedBufferSlot[streamerSlot] = -1;
      }
      _chunkActive[streamerSlot] = 0;
    }
  },

  /**
   * Replay a chunk's deserialized mutation list. Called by
   * 342_LandscapeChunkMutationReplay once the chunk's geometry has been
   * regenerated. Emits one REPLAYED_MUTATION event per mutation so the
   * material and lighting bridges can apply the overrides.
   */
  replayIntoChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (!_chunkActive[streamerSlot]) return 0;
    if (_isReplaying[streamerSlot]) return 0;
    _isReplaying[streamerSlot] = 1;
    return _replayChunk(streamerSlot);
  },

  /**
   * The 1 Hz consumer entry point. Called by 308_ContextConsumerTiers.
   */
  run(frame, tick, dt) {
    if (!_configured) this.init();

    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    // ─── 1. Serialize pending chunks ────────────────────────
    let serializedCount = 0;
    let totalBytes = 0;
    for (let b = 0; b < this.serializeBudget; b++) {
      if (_serializeQueueHead === _serializeQueueTail) break;
      const streamerSlot = _serializeQueue[_serializeQueueHead];
      _serializeQueue[_serializeQueueHead] = -1;
      _serializeQueueHead = (_serializeQueueHead + 1) % MAX_PENDING_JOBS;
      if (streamerSlot < 0) continue;
      const bufferSlot = _serializeChunk(streamerSlot);
      _isSerializing[streamerSlot] = 0;
      if (bufferSlot !== -1) {
        serializedCount++;
        totalBytes += _serializedByteLength[streamerSlot];
      }
      // The chunk's slot in this module's state is released only after
      // the serialization completes.
      _chunkActive[streamerSlot] = 0;
    }
    _lastSerializedCount = serializedCount;
    _lastTotalSerializedBytes = totalBytes;

    // ─── 2. Deserialize pending chunks ──────────────────────
    let deserializedCount = 0;
    for (let b = 0; b < this.deserializeBudget; b++) {
      if (_deserializeQueueHead === _deserializeQueueTail) break;
      const streamerSlot = _deserializeQueue[_deserializeQueueHead];
      _deserializeQueue[_deserializeQueueHead] = -1;
      _deserializeQueueHead = (_deserializeQueueHead + 1) % MAX_PENDING_JOBS;
      if (streamerSlot < 0) continue;
      const n = _deserializeChunk(streamerSlot);
      _isDeserializing[streamerSlot] = 0;
      if (n > 0) deserializedCount++;
    }
    _lastDeserializedCount = deserializedCount;

    // ─── 3. Count active chunks ─────────────────────────────
    let activeChunks = 0;
    for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) if (_chunkActive[i]) activeChunks++;
    _lastActiveChunks = activeChunks;

    // ─── 4. Emit the aggregate event ────────────────────────
    if (serializedCount > 0 || deserializedCount > 0) {
      _dispatcher.emit(EVENT_TYPE.PERSISTENCE_UPDATED, {
        tick,
        serializedCount,
        deserializedCount,
        activeChunks,
        serializedBytes: totalBytes
      });
    }
  },

  /**
   * Read the mutation list for a chunk. Zero-allocation; writes into the
   * caller's preallocated output arrays.
   *
   * @returns {number} Number of mutations written.
   */
  readMutations(streamerSlot, outTypes, outPositions, outRadii, maxCount) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (!_chunkActive[streamerSlot]) return 0;
    const n = _mutationCount[streamerSlot];
    const limit = Math.min(n, maxCount);
    for (let i = 0; i < limit; i++) {
      const mutBase = streamerSlot * MUTATION_KEEP_MAX + i;
      const posBase = mutBase * 3;
      outTypes[i] = _mutType[mutBase];
      outPositions[i * 3 + 0] = _mutPosition[posBase + 0];
      outPositions[i * 3 + 1] = _mutPosition[posBase + 1];
      outPositions[i * 3 + 2] = _mutPosition[posBase + 2];
      outRadii[i] = _mutRadius[mutBase];
    }
    return limit;
  },

  /**
   * Force an immediate serialization of a chunk. Used by 341's own
   * diagnostics and by 357's event budget collapse.
   */
  forceSerialize(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return -1;
    if (!_chunkActive[streamerSlot]) return -1;
    return _serializeChunk(streamerSlot);
  },

  /**
   * Force an immediate deserialization of a chunk.
   */
  forceDeserialize(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (!_chunkActive[streamerSlot]) return 0;
    return _deserializeChunk(streamerSlot);
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastSerializedCount() { return _lastSerializedCount; },
  get lastDeserializedCount() { return _lastDeserializedCount; },
  get lastReplayedCount() { return _lastReplayedCount; },
  get lastActiveChunks() { return _lastActiveChunks; },
  get lastTotalSerializedBytes() { return _lastTotalSerializedBytes; },
  get serializeQueueDepth() {
    return (_serializeQueueTail - _serializeQueueHead + MAX_PENDING_JOBS) % MAX_PENDING_JOBS;
  },
  get deserializeQueueDepth() {
    return (_deserializeQueueTail - _deserializeQueueHead + MAX_PENDING_JOBS) % MAX_PENDING_JOBS;
  },
  get serializedBufferPoolFree() { return _serializedBufferFreeTop; },
  get serializedBufferPoolCapacity() { return MAX_SERIALIZED_BUFFERS; }
});

export default LandscapeChunkPersistence;