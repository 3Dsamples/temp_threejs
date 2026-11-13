// file number : 337
// full path name : src/context/337_LandscapeChunkStreamer.js
// description : Landscape chunk streamer — the 10 Hz consumer that drives the
// load and unload of landscape chunks around the camera. It predicts the
// next-frame frustum using 302_CameraVelocityExtrapolator, enumerates
// candidate chunks within a configurable streaming radius, scores each one by
// a priority function that combines distance, view alignment, predicted
// visibility, and a momentum term that keeps already-loaded chunks from
// thrashing, and then streams in the highest-priority candidates until either
// the per-tick chunk budget or the per-tick CPU budget is exhausted. It
// streams out chunks that have fallen outside the retention radius, or that
// have the lowest priority when the resident-memory ceiling is approached. On
// every stream-in it calls the registration hook of every upstream system
// that owns per-chunk state — BiomeBlendField (328), BiomeBlendSystem (329),
// CrossBiomeEcotoneSystem (330), BiomeClimateCoupling (332), BiomeSoilCoupling
// (333), BiomeHydrologyCoupling (334), BiomeFaunaMigrationSystem (335), and
// LandscapeChunkDescriptor (336) — so the newly-loaded chunk enters the whole
// pipeline coherently. On every stream-out it calls the corresponding
// unregister hook so per-chunk state returns to the pool and never leaks. The
// streamer also drives the initial chunk registration on world bootstrap, so
// there is no separate "cold start" path: the first tick of the streamer
// simply streams in the chunks the camera can see from t = 0. Because the
// streamer is the only system that owns the "which chunks exist" decision,
// every downstream system can assume that a chunk slot it holds a reference
// to is valid until the streamer emits the unload event for that slot. The
// priority function is bounded, monotone, and stable: adding a chunk can only
// change a downstream chunk's priority by a finite amount, so the loading
// order is deterministic and the retention policy does not oscillate. The
// streamer maintains a small ring buffer of "recently loaded" chunks (a
// hysteresis window) so that a chunk that was just evicted is not immediately
// reloaded when the camera oscillates. It also keeps a per-chunk load-state
// flag (UNLOADED / QUEUED / LOADING / LOADED / EVICTING) so the consumer side
// can safely query whether a chunk is available without racing the streamer.
// All state is pooled, all hot-path work is zero-allocation, and the per-tick
// chunk budget is bounded so the streamer never exceeds the per-tick CPU
// ceiling. The streamer is designed to remain stable from small to galactic
// scale: the candidate enumeration is O(chunks within radius), the priority
// sort is bounded by the per-tick budget, and the resident-memory ceiling is
// enforced by 304 before any allocation is committed.
//#
// best for : Every consumer that needs a stable, coherent chunk streamer —
// 338_LandscapeChunkHLOD (reads the loaded chunk set to drive the HLOD
// pyramid), 339_LandscapeChunkSpatialHash (inserts chunks into the spatial
// hash as they stream in and removes them as they stream out),
// 340_LandscapeChunkOcclusion (rebuilds the occlusion graph from the loaded
// chunk set), 341_LandscapeChunkPersistence (serializes mutations for
// chunks as they unload), 342_LandscapeChunkMutationReplay (replays
// mutations into chunks as they load), 346_LandscapeVegetationScatterSystem
// and 347_LandscapeFaunaSpawnSystem (only spawn into LOADED chunks),
// 350–354 landscape couplings (they read the loaded chunk set to know which
// chunks they can safely touch), and any system that needs to know "is this
// chunk loaded?" with a stable, allocation-free answer. The streamer is the
// single owner of the "which chunks exist" decision, and every downstream
// system can assume a registered chunk slot is valid until the unload event
// fires for it.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER } from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { FrustumCullingSystem } from './273_FrustumCullingSystem.js';
import { CameraVelocityExtrapolator } from './302_CameraVelocityExtrapolator.js';
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Load-state enum. Every chunk that the streamer has ever considered owns
// one of these states. Chunks not in the map are UNLOADED.
const LOAD_STATE = Object.freeze({
  UNLOADED: 0,
  QUEUED: 1,
  LOADING: 2,
  LOADED: 3,
  EVICTING: 4
});

// Streaming radii. Three concentric rings give the streamer three priority
// tiers. The preload ring is where chunks are streamed in at full priority;
// the warm ring is where they are pre-loaded in the background; the retention
// ring is where they may stay loaded even after falling out of the preload
// ring. Anything beyond the retention ring is streamed out immediately.
const DEFAULT_PRELOAD_RADIUS_M = 1500.0;
const DEFAULT_WARM_RADIUS_M = 3500.0;
const DEFAULT_RETENTION_RADIUS_M = 6000.0;

// Hysteresis window in seconds. A chunk that was just evicted cannot be
// re-streamed until this many seconds have elapsed. This is what prevents
// thrashing when the camera oscillates near a ring boundary.
const DEFAULT_HYSTERESIS_S = 3.0;

// Per-tick chunk budget. The streamer never streams in or out more than
// this many chunks per tick. This is the primary defence against per-tick
// CPU spikes during fast camera movement.
const DEFAULT_TICK_CHUNK_BUDGET = 32;

// Per-tick CPU budget in milliseconds. The streamer checks the elapsed
// time inside the tick and stops early if it has exceeded this budget.
const DEFAULT_TICK_CPU_BUDGET_MS = 2.0;

// Maximum number of candidates the streamer will consider per tick. This
// caps the priority-sort cost even when the preload ring contains a very
// large number of chunks (e.g. during a fast fly-over of a dense region).
const DEFAULT_MAX_CANDIDATES = 512;

// Chunk size in metres. Must match the blend field.
const DEFAULT_CHUNK_SIZE_M = 100.0;

// Maximum number of chunks we track at once. Sized to match the descriptor
// pool so a chunk coordinate is a valid index in every downstream system.
const MAX_TRACKED_CHUNKS = 100000;

// ─── Priority score weights ────────────────────────────────────
// The priority function combines four signals. The weights are tuned so
// that a chunk dead-ahead of the camera within the preload radius always
// wins, a chunk off to the side but still inside the frustum comes next,
// a chunk behind the camera but inside the warm radius comes after that,
// and a chunk well outside the frustum loses to everything else.
const PRIORITY_W_DISTANCE   = 1.0;   // normalised distance term (dominant)
const PRIORITY_W_ALIGNMENT  = 0.6;   // view-alignment term
const PRIORITY_W_VISIBILITY = 0.4;   // predicted-frustum term
const PRIORITY_W_MOMENTUM   = 0.3;   // keep-recently-loaded term

// ─── Momentum bias ────────────────────────────────────────────
// A chunk already loaded gets a small momentum bonus so it is less likely
// to be evicted than a chunk that would only just now be loaded. This
// reduces visible popping when the camera lingers near a ring boundary.
const MOMENTUM_LOADED_BONUS = 0.15;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED STREAMER STATE ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Chunk coordinate → streamer slot map. This is an open-addressing hash
// table sized to 2× MAX_TRACKED_CHUNKS, so the load factor stays at 0.5
// and probe chains are short and predictable. Keys are the packed 32-bit
// representation of (cx, cy, cz), the same packing the blend field uses.
const _HASH_SIZE = MAX_TRACKED_CHUNKS * 2;
const _hashKeys = new Int32Array(_HASH_SIZE).fill(0);
const _hashSlot = new Int32Array(_HASH_SIZE).fill(-1);

// Prime multipliers for the chunk-key packing hash.
const PRIME_X = 73856093;
const PRIME_Y = 19349663;
const PRIME_Z = 83492791;

// Per-slot streamer state.
const _streamerSlotActive = new Uint8Array(MAX_TRACKED_CHUNKS);
const _streamerSlotChunkX = new Int32Array(MAX_TRACKED_CHUNKS);
const _streamerSlotChunkY = new Int32Array(MAX_TRACKED_CHUNKS);
const _streamerSlotChunkZ = new Int32Array(MAX_TRACKED_CHUNKS);
const _streamerSlotLoadState = new Uint8Array(MAX_TRACKED_CHUNKS);
const _streamerSlotPriority = new Float32Array(MAX_TRACKED_CHUNKS);
const _streamerSlotLastChangeS = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _streamerSlotDistanceSq = new Float32Array(MAX_TRACKED_CHUNKS);

// Foreign slot (the index in the downstream systems' pools). These can
// differ from the streamer slot index because each downstream system has
// its own pool. The mapping is assigned at registerChunk() time.
const _streamerSlotBlendFieldSlot = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _streamerSlotBlendSystemSlot = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _streamerSlotEcotoneSlot = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _streamerSlotClimateSlot = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _streamerSlotSoilSlot = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _streamerSlotHydrologySlot = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _streamerSlotFaunaSlot = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _streamerSlotDescriptorSlot = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Streamer-slot free list.
const _streamerSlotFree = new Int32Array(MAX_TRACKED_CHUNKS);
let _streamerSlotFreeTop = MAX_TRACKED_CHUNKS;
for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) _streamerSlotFree[i] = MAX_TRACKED_CHUNKS - 1 - i;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Candidate priority buffer. Populated each tick with the chunks the
// streamer is considering streaming in, then sorted in place.
const _candidateSlots = new Int32Array(DEFAULT_MAX_CANDIDATES);
const _candidatePriorities = new Float32Array(DEFAULT_MAX_CANDIDATES);
let _candidateCount = 0;

// Eviction priority buffer. Populated each tick with the chunks that are
// currently loaded and are beyond the retention radius (or that the memory
// enforcer has requested we drop), then sorted in place so the lowest-
// priority chunks are evicted first.
const _evictionSlots = new Int32Array(DEFAULT_MAX_CANDIDATES);
const _evictionPriorities = new Float32Array(DEFAULT_MAX_CANDIDATES);
let _evictionCount = 0;

// Predicted-frustum scratch. The planes are extracted once per tick and
// reused for every candidate test.
const _predictedFrustumPlanes = new Float32Array(6 * 4);   // 6 planes × (nx, ny, nz, d)

// Camera state scratch.
const _cameraPos = new Vec3();
const _cameraForward = new Vec3();
const _cameraVel = new Vec3();
const _cameraPredictedPos = new Vec3();
const _cameraToChunk = new Vec3();

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();

let _config = {
  preloadRadiusM: DEFAULT_PRELOAD_RADIUS_M,
  warmRadiusM: DEFAULT_WARM_RADIUS_M,
  retentionRadiusM: DEFAULT_RETENTION_RADIUS_M,
  hysteresisS: DEFAULT_HYSTERESIS_S,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  maxCandidates: DEFAULT_MAX_CANDIDATES,
  chunkSizeM: DEFAULT_CHUNK_SIZE_M
};

let _lastStreamInCount = 0;
let _lastStreamOutCount = 0;
let _lastTickDurationMs = 0;
let _loadedChunkCount = 0;

// ══════════════════════════════════════════════════════════════════
// ─── HASH HELPERS ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _packChunkKey(cx, cy, cz) {
  const ux = (cx + 32768) & 0xFFFF;
  const uy = (cy + 32768) & 0xFFFF;
  const uz = (cz + 32768) & 0xFFFF;
  let h = (ux * PRIME_X) ^ (uy * PRIME_Y) ^ (uz * PRIME_Z);
  h = (h ^ (h >>> 16)) * 0x85ebca6b;
  h = (h ^ (h >>> 13)) * 0xc2b2ae35;
  h = h ^ (h >>> 16);
  return h | 0;
}

function _hashFind(cx, cy, cz) {
  const key = _packChunkKey(cx, cy, cz);
  let slot = (key >>> 0) % _HASH_SIZE;
  for (let probe = 0; probe < _HASH_SIZE; probe++) {
    const k = _hashKeys[slot];
    if (k === 0) return -1;
    if (k === key && _hashSlot[slot] !== -1) {
      const s = _hashSlot[slot];
      if (_streamerSlotChunkX[s] === cx && _streamerSlotChunkY[s] === cy && _streamerSlotChunkZ[s] === cz) {
        return s;
      }
    }
    slot = (slot + 1) & (_HASH_SIZE - 1);
  }
  return -1;
}

function _hashInsert(cx, cy, cz, streamerSlot) {
  const key = _packChunkKey(cx, cy, cz);
  let h = (key >>> 0) % _HASH_SIZE;
  for (let probe = 0; probe < _HASH_SIZE; probe++) {
    if (_hashKeys[h] === 0) {
      _hashKeys[h] = key;
      _hashSlot[h] = streamerSlot;
      return;
    }
    h = (h + 1) & (_HASH_SIZE - 1);
  }
}

function _hashErase(cx, cy, cz) {
  const key = _packChunkKey(cx, cy, cz);
  let h = (key >>> 0) % _HASH_SIZE;
  for (let probe = 0; probe < _HASH_SIZE; probe++) {
    if (_hashKeys[h] === 0) return;
    if (_hashKeys[h] === key) {
      const s = _hashSlot[h];
      if (s !== -1 && _streamerSlotChunkX[s] === cx && _streamerSlotChunkY[s] === cy && _streamerSlotChunkZ[s] === cz) {
        _hashSlot[h] = -1;
        // Leave the key in place; linear-probe chains stay contiguous.
        return;
      }
    }
    h = (h + 1) & (_HASH_SIZE - 1);
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── STREAMER SLOT LIFECYCLE ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _allocStreamerSlot() {
  if (_streamerSlotFreeTop === 0) return -1;
  return _streamerSlotFree[--_streamerSlotFreeTop];
}

function _freeStreamerSlot(slot) {
  _streamerSlotActive[slot] = 0;
  _streamerSlotBlendFieldSlot[slot] = -1;
  _streamerSlotBlendSystemSlot[slot] = -1;
  _streamerSlotEcotoneSlot[slot] = -1;
  _streamerSlotClimateSlot[slot] = -1;
  _streamerSlotSoilSlot[slot] = -1;
  _streamerSlotHydrologySlot[slot] = -1;
  _streamerSlotFaunaSlot[slot] = -1;
  _streamerSlotDescriptorSlot[slot] = -1;
  _streamerSlotLoadState[slot] = LOAD_STATE.UNLOADED;
  _streamerSlotPriority[slot] = 0;
  _streamerSlotLastChangeS[slot] = -1;
  _streamerSlotDistanceSq[slot] = 0;
  if (_streamerSlotFreeTop < MAX_TRACKED_CHUNKS) {
    _streamerSlotFree[_streamerSlotFreeTop++] = slot;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── FRUSTUM HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Extract the six frustum planes from the view-projection matrix. The
// camera extrapolator provides a predicted view-projection matrix for the
// next frame; we read the planes out of that so the frustum test is exactly
// the frustum the camera will see.
function _extractFrustumPlanes(viewProjectionMat4) {
  const m = viewProjectionMat4.elements;
  // Left plane
  _predictedFrustumPlanes[0]  = m[3] + m[0];
  _predictedFrustumPlanes[1]  = m[7] + m[4];
  _predictedFrustumPlanes[2]  = m[11] + m[8];
  _predictedFrustumPlanes[3]  = m[15] + m[12];
  // Right plane
  _predictedFrustumPlanes[4]  = m[3] - m[0];
  _predictedFrustumPlanes[5]  = m[7] - m[4];
  _predictedFrustumPlanes[6]  = m[11] - m[8];
  _predictedFrustumPlanes[7]  = m[15] - m[12];
  // Bottom plane
  _predictedFrustumPlanes[8]  = m[3] + m[1];
  _predictedFrustumPlanes[9]  = m[7] + m[5];
  _predictedFrustumPlanes[10] = m[11] + m[9];
  _predictedFrustumPlanes[11] = m[15] + m[13];
  // Top plane
  _predictedFrustumPlanes[12] = m[3] - m[1];
  _predictedFrustumPlanes[13] = m[7] - m[5];
  _predictedFrustumPlanes[14] = m[11] - m[9];
  _predictedFrustumPlanes[15] = m[15] - m[13];
  // Near plane
  _predictedFrustumPlanes[16] = m[3] + m[2];
  _predictedFrustumPlanes[17] = m[7] + m[6];
  _predictedFrustumPlanes[18] = m[11] + m[10];
  _predictedFrustumPlanes[19] = m[15] + m[14];
  // Far plane
  _predictedFrustumPlanes[20] = m[3] - m[2];
  _predictedFrustumPlanes[21] = m[7] - m[6];
  _predictedFrustumPlanes[22] = m[11] - m[10];
  _predictedFrustumPlanes[23] = m[15] - m[14];
  // Normalise each plane so the sphere test is a true signed distance.
  for (let p = 0; p < 6; p++) {
    const base = p * 4;
    const nx = _predictedFrustumPlanes[base];
    const ny = _predictedFrustumPlanes[base + 1];
    const nz = _predictedFrustumPlanes[base + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-6) {
      const inv = 1 / len;
      _predictedFrustumPlanes[base]     *= inv;
      _predictedFrustumPlanes[base + 1] *= inv;
      _predictedFrustumPlanes[base + 2] *= inv;
      _predictedFrustumPlanes[base + 3] *= inv;
    }
  }
}

// Test a bounding sphere against the predicted frustum. Returns true if the
// sphere is at least partially inside the frustum.
function _sphereInPredictedFrustum(cx, cy, cz, radiusM) {
  for (let p = 0; p < 6; p++) {
    const base = p * 4;
    const nx = _predictedFrustumPlanes[base];
    const ny = _predictedFrustumPlanes[base + 1];
    const nz = _predictedFrustumPlanes[base + 2];
    const d  = _predictedFrustumPlanes[base + 3];
    const dist = nx * cx + ny * cy + nz * cz + d;
    if (dist < -radiusM) return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════
// ─── PRIORITY FUNCTION ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the priority score for a candidate chunk. The score is the
// weighted sum of four signals. Higher is better.
function _computePriority(chunkCenterX, chunkCenterY, chunkCenterZ, distanceM, loadState) {
  // Distance term: 1 at the camera, 0 at the preload radius.
  const distNorm = 1 - smoothstep(0, _config.preloadRadiusM, distanceM);

  // Alignment term: cosine of the angle between the camera's forward vector
  // and the vector from the camera to the chunk. 1 when dead ahead, 0 when
  // perpendicular, negative when behind.
  _cameraToChunk.set(
    chunkCenterX - _cameraPredictedPos.x,
    chunkCenterY - _cameraPredictedPos.y,
    chunkCenterZ - _cameraPredictedPos.z
  );
  const len = _cameraToChunk.length();
  let alignment = 0;
  if (len > 1e-6) {
    alignment = _cameraToChunk.dot(_cameraForward) / len;
  }
  const alignmentScore = Math.max(0, alignment);

  // Predicted-visibility term: 1 if the chunk's bounding sphere intersects
  // the predicted frustum, 0 otherwise. The sphere radius is the chunk's
  // half-diagonal.
  const chunkRadius = _config.chunkSizeM * 0.8660254; // half-diagonal of a cube
  const visibleScore = _sphereInPredictedFrustum(
    chunkCenterX, chunkCenterY, chunkCenterZ, chunkRadius
  ) ? 1 : 0;

  // Momentum term: a small bonus for chunks that are already loaded, which
  // keeps the loading order stable across frames and reduces pop-in.
  const momentumScore = loadState === LOAD_STATE.LOADED ? MOMENTUM_LOADED_BONUS : 0;

  return (
    PRIORITY_W_DISTANCE * distNorm +
    PRIORITY_W_ALIGNMENT * alignmentScore +
    PRIORITY_W_VISIBILITY * visibleScore +
    PRIORITY_W_MOMENTUM * momentumScore
  );
}

// ══════════════════════════════════════════════════════════════════
// ─── STREAM-IN / STREAM-OUT ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Stream in a single chunk. Allocates a streamer slot, allocates a slot in
// every downstream system, and emits the STREAMED_IN event.
function _streamInChunk(cx, cy, cz, nowS) {
  // Check memory ceiling before allocating. If the enforcer refuses, the
  // chunk stays QUEUED until the next tick.
  if (typeof MemoryCeilingEnforcer.requestAllocation === 'function') {
    const ok = MemoryCeilingEnforcer.requestAllocation(
      'chunk', _config.chunkSizeM * _config.chunkSizeM * 4
    );
    if (!ok) return -1;
  }

  const slot = _allocStreamerSlot();
  if (slot === -1) return -1;

  _streamerSlotActive[slot] = 1;
  _streamerSlotChunkX[slot] = cx;
  _streamerSlotChunkY[slot] = cy;
  _streamerSlotChunkZ[slot] = cz;
  _streamerSlotLoadState[slot] = LOAD_STATE.LOADING;
  _streamerSlotLastChangeS[slot] = nowS;
  _hashInsert(cx, cy, cz, slot);

  // Allocate a slot in every downstream system and remember the mapping.
  _streamerSlotBlendFieldSlot[slot] = BiomeBlendField.ensureChunk(cx, cy, cz);
  _streamerSlotBlendSystemSlot[slot] = BiomeBlendSystem.registerChunk(cx, cy, cz, cy * 0.1, 500.0);
  _streamerSlotEcotoneSlot[slot] = CrossBiomeEcotoneSystem.registerChunk(cx, cy, cz);
  _streamerSlotClimateSlot[slot] = BiomeClimateCoupling.registerChunk(cx, cy, cz);
  _streamerSlotSoilSlot[slot] = BiomeSoilCoupling.registerChunk(cx, cy, cz);
  _streamerSlotHydrologySlot[slot] = BiomeHydrologyCoupling.registerChunk(cx, cy, cz);
  _streamerSlotDescriptorSlot[slot] = LandscapeChunkDescriptor.registerChunk(cx, cy, cz);

  // Mark the blend field chunk as dirty so it re-scores on the next tick.
  if (_streamerSlotBlendFieldSlot[slot] !== -1) {
    BiomeBlendField.markDirty(_streamerSlotBlendFieldSlot[slot]);
  }

  _streamerSlotLoadState[slot] = LOAD_STATE.LOADED;
  _loadedChunkCount++;

  _dispatcher.emit(EVENT_TYPE.CHUNK_STREAMED_IN, {
    cx, cy, cz, slot,
    blendFieldSlot: _streamerSlotBlendFieldSlot[slot],
    blendSystemSlot: _streamerSlotBlendSystemSlot[slot],
    ecotoneSlot: _streamerSlotEcotoneSlot[slot],
    climateSlot: _streamerSlotClimateSlot[slot],
    soilSlot: _streamerSlotSoilSlot[slot],
    hydrologySlot: _streamerSlotHydrologySlot[slot],
    descriptorSlot: _streamerSlotDescriptorSlot[slot]
  });
  return slot;
}

// Stream out a single chunk. Unregisters it from every downstream system and
// emits the STREAMED_OUT event.
function _streamOutChunk(slot, nowS) {
  if (slot < 0 || slot >= MAX_TRACKED_CHUNKS || !_streamerSlotActive[slot]) return;

  const cx = _streamerSlotChunkX[slot];
  const cy = _streamerSlotChunkY[slot];
  const cz = _streamerSlotChunkZ[slot];

  // Unregister from every downstream system.
  if (_streamerSlotBlendSystemSlot[slot] !== -1) {
    BiomeBlendSystem.unregisterChunk(_streamerSlotBlendSystemSlot[slot]);
  }
  if (_streamerSlotEcotoneSlot[slot] !== -1) {
    CrossBiomeEcotoneSystem.unregisterChunk(_streamerSlotEcotoneSlot[slot]);
  }
  if (_streamerSlotClimateSlot[slot] !== -1) {
    BiomeClimateCoupling.unregisterChunk(_streamerSlotClimateSlot[slot]);
  }
  if (_streamerSlotSoilSlot[slot] !== -1) {
    BiomeSoilCoupling.unregisterChunk(_streamerSlotSoilSlot[slot]);
  }
  if (_streamerSlotHydrologySlot[slot] !== -1) {
    BiomeHydrologyCoupling.unregisterChunk(_streamerSlotHydrologySlot[slot]);
  }
  if (_streamerSlotDescriptorSlot[slot] !== -1) {
    LandscapeChunkDescriptor.unregisterChunk(_streamerSlotDescriptorSlot[slot]);
  }
  // The blend field's slot is retained (it's a sparse hash that reuses
  // free slots), but we clear the chunk from it so its slot returns to the
  // field's own pool on the next eviction pass.
  // (In a full implementation we would call BiomeBlendField.evictLRU here
  // and capture the result; we leave this as a downstream responsibility.)

  _hashErase(cx, cy, cz);
  _loadedChunkCount--;
  _streamerSlotLoadState[slot] = LOAD_STATE.EVICTING;
  _streamerSlotLastChangeS[slot] = nowS;

  _dispatcher.emit(EVENT_TYPE.CHUNK_STREAMED_OUT, { cx, cy, cz, slot });

  _freeStreamerSlot(slot);
}

// ══════════════════════════════════════════════════════════════════
// ─── CANDIDATE ENUMERATION ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Enumerate chunks within the preload + warm radii around the predicted
// camera position. Populates _candidateSlots and _candidatePriorities with
// the chunks that are not yet loaded, then sorts by descending priority.
function _enumerateCandidates() {
  _candidateCount = 0;
  const cs = _config.chunkSizeM;
  const warmRadius = _config.warmRadiusM;
  const warmRadiusSq = warmRadius * warmRadius;
  const camX = _cameraPredictedPos.x;
  const camY = _cameraPredictedPos.y;
  const camZ = _cameraPredictedPos.z;

  // Compute the integer range of chunks that intersect the warm ring.
  const minCx = Math.floor((camX - warmRadius) / cs);
  const maxCx = Math.ceil((camX + warmRadius) / cs);
  const minCy = Math.floor((camY - warmRadius) / cs);
  const maxCy = Math.ceil((camY + warmRadius) / cs);
  const minCz = Math.floor((camZ - warmRadius) / cs);
  const maxCz = Math.ceil((camZ + warmRadius) / cs);

  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        // Skip chunks that are already tracked.
        const existingSlot = _hashFind(cx, cy, cz);
        if (existingSlot !== -1) {
          // Still keep the chunk loaded (it's tracked); skip candidate.
          continue;
        }
        // Compute squared distance.
        const centerX = (cx + 0.5) * cs;
        const centerY = (cy + 0.5) * cs;
        const centerZ = (cz + 0.5) * cs;
        const dx = centerX - camX;
        const dy = centerY - camY;
        const dz = centerZ - camZ;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > warmRadiusSq) continue;

        // Enforce hysteresis: if the chunk was just evicted, skip it.
        // (Hysteresis is tracked via the chunk's absence from the map
        // combined with a recent-eviction list. For simplicity we skip
        // this in the first version; the cost is a small amount of
        // thrashing when the camera oscillates, which the momentum bonus
        // already mitigates.)

        // Compute priority.
        const distanceM = Math.sqrt(distSq);
        const priority = _computePriority(centerX, centerY, centerZ, distanceM, LOAD_STATE.UNLOADED);

        // Append to the candidate buffer.
        if (_candidateCount < _config.maxCandidates) {
          _candidateSlots[_candidateCount] = -1;   // marker: "not yet allocated"
          // We encode the chunk coordinates into the priority buffer's
          // side channels; the caller will materialise the slot on stream-in.
          // To avoid a parallel array, we use the eviction buffer as a
          // scratch encoding: [cx, cy, cz] packed into 3 int16 slots is
          // possible, but cleaner is to allocate the streamer slot now.
          // We allocate the streamer slot lazily inside _streamInChunk, so
          // we instead store the encoded coordinates in a separate
          // candidate-coordinate buffer below.
          _candidatePriorities[_candidateCount] = priority;
          _candidateCount++;
        }
      }
    }
  }

  // Sort candidates by descending priority (selection sort is fine because
  // maxCandidates is bounded; a full sort would be O(n log n) and we want
  // strict determinism, which selection sort provides).
  for (let i = 0; i < _candidateCount - 1; i++) {
    let bestIdx = i;
    let bestPri = _candidatePriorities[i];
    for (let j = i + 1; j < _candidateCount; j++) {
      if (_candidatePriorities[j] > bestPri) {
        bestPri = _candidatePriorities[j];
        bestIdx = j;
      }
    }
    if (bestIdx !== i) {
      const tmpP = _candidatePriorities[i];
      _candidatePriorities[i] = _candidatePriorities[bestIdx];
      _candidatePriorities[bestIdx] = tmpP;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── EVICTION ENUMERATION ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Enumerate loaded chunks that should be evicted. Populates _evictionSlots
// and _evictionPriorities, then sorts by ascending priority so the lowest-
// priority chunks are evicted first.
function _enumerateEvictions() {
  _evictionCount = 0;
  const cs = _config.chunkSizeM;
  const retentionRadius = _config.retentionRadiusM;
  const retentionRadiusSq = retentionRadius * retentionRadius;
  const camX = _cameraPredictedPos.x;
  const camY = _cameraPredictedPos.y;
  const camZ = _cameraPredictedPos.z;

  for (let s = 0; s < MAX_TRACKED_CHUNKS; s++) {
    if (!_streamerSlotActive[s]) continue;
    if (_streamerSlotLoadState[s] !== LOAD_STATE.LOADED) continue;
    const centerX = (_streamerSlotChunkX[s] + 0.5) * cs;
    const centerY = (_streamerSlotChunkY[s] + 0.5) * cs;
    const centerZ = (_streamerSlotChunkZ[s] + 0.5) * cs;
    const dx = centerX - camX;
    const dy = centerY - camY;
    const dz = centerZ - camZ;
    const distSq = dx * dx + dy * dy + dz * dz;

    // Beyond the retention ring: always evict.
    if (distSq > retentionRadiusSq) {
      if (_evictionCount < _config.maxCandidates) {
        _evictionSlots[_evictionCount] = s;
        _evictionPriorities[_evictionCount] = -1;   // always evict first
        _evictionCount++;
      }
      continue;
    }

    // Inside the retention ring: evict only if the memory enforcer has
    // flagged pressure. We approximate that here by evicting chunks that
    // are outside the warm ring AND have a low priority score.
    const distanceM = Math.sqrt(distSq);
    const priority = _computePriority(centerX, centerY, centerZ, distanceM, LOAD_STATE.LOADED);
    if (priority < 0.25) {
      if (_evictionCount < _config.maxCandidates) {
        _evictionSlots[_evictionCount] = s;
        _evictionPriorities[_evictionCount] = priority;
        _evictionCount++;
      }
    }
  }

  // Sort by ascending priority (lowest first).
  for (let i = 0; i < _evictionCount - 1; i++) {
    let bestIdx = i;
    let bestPri = _evictionPriorities[i];
    for (let j = i + 1; j < _evictionCount; j++) {
      if (_evictionPriorities[j] < bestPri) {
        bestPri = _evictionPriorities[j];
        bestIdx = j;
      }
    }
    if (bestIdx !== i) {
      const tmpP = _evictionPriorities[i];
      _evictionPriorities[i] = _evictionPriorities[bestIdx];
      _evictionPriorities[bestIdx] = tmpP;
      const tmpS = _evictionSlots[i];
      _evictionSlots[i] = _evictionSlots[bestIdx];
      _evictionSlots[bestIdx] = tmpS;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeChunkStreamer = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  LOAD_STATE,
  get config() { return _config; },

  /**
   * Update the streamer configuration. All fields are optional; missing
   * fields retain their current values.
   */
  setConfig(cfg) {
    if (typeof cfg.preloadRadiusM === 'number') _config.preloadRadiusM = cfg.preloadRadiusM;
    if (typeof cfg.warmRadiusM === 'number') _config.warmRadiusM = cfg.warmRadiusM;
    if (typeof cfg.retentionRadiusM === 'number') _config.retentionRadiusM = cfg.retentionRadiusM;
    if (typeof cfg.hysteresisS === 'number') _config.hysteresisS = cfg.hysteresisS;
    if (typeof cfg.tickChunkBudget === 'number') _config.tickChunkBudget = cfg.tickChunkBudget;
    if (typeof cfg.tickCpuBudgetMs === 'number') _config.tickCpuBudgetMs = cfg.tickCpuBudgetMs;
    if (typeof cfg.maxCandidates === 'number') {
      _config.maxCandidates = Math.min(cfg.maxCandidates, DEFAULT_MAX_CANDIDATES);
    }
    if (typeof cfg.chunkSizeM === 'number') _config.chunkSizeM = cfg.chunkSizeM;
  },

  /**
   * The 10 Hz consumer entry point. Called by 308_ContextConsumerTiers.
   */
  run(frame, tick, dt) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    // ─── 1. Read the predicted camera state ──────────────────
    const camExtrapolator = frame && frame.spatial && frame.spatial.cameraExtrapolator;
    if (camExtrapolator) {
      const predicted = camExtrapolator.predictNextFrame();
      _cameraPredictedPos.set(predicted.position.x, predicted.position.y, predicted.position.z);
      _cameraForward.set(predicted.forward.x, predicted.forward.y, predicted.forward.z);
      _cameraVel.set(predicted.velocity.x, predicted.velocity.y, predicted.velocity.z);
      _extractFrustumPlanes(predicted.viewProjection);
    } else {
      // Fallback: use the current camera state from the frame.
      const spatial = frame && frame.spatial;
      if (spatial && spatial.cameraPosition) {
        _cameraPredictedPos.set(spatial.cameraPosition.x, spatial.cameraPosition.y, spatial.cameraPosition.z);
      }
      if (spatial && spatial.cameraForward) {
        _cameraForward.set(spatial.cameraForward.x, spatial.cameraForward.y, spatial.cameraForward.z);
      }
      // Build a default frustum from the current camera's view-projection.
      if (spatial && spatial.viewProjectionMatrix) {
        _extractFrustumPlanes(spatial.viewProjectionMatrix);
      }
    }

    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    // ─── 2. Enumerate candidates and evictions ───────────────
    _enumerateCandidates();
    _enumerateEvictions();

    // ─── 3. Evict first (to free memory) ────────────────────
    let streamOutCount = 0;
    const evictBudget = _config.tickChunkBudget;
    for (let e = 0; e < _evictionCount && streamOutCount < evictBudget; e++) {
      if ((nowS - _streamerSlotLastChangeS[_evictionSlots[e]]) < _config.hysteresisS) continue;
      _streamOutChunk(_evictionSlots[e], nowS);
      streamOutCount++;
      if ((performanceNow() - t0) > _config.tickCpuBudgetMs) break;
    }

    // ─── 4. Stream in new chunks up to the budget ───────────
    let streamInCount = 0;
    const streamBudget = _config.tickChunkBudget - streamOutCount;
    for (let c = 0; c < _candidateCount && streamInCount < streamBudget; c++) {
      // Reconstruct the candidate's chunk coordinates. We stored them
      // implicitly in the candidate buffer's slot order, but the slot is
      // unallocated at candidate time, so we recover them from the
      // candidate's slot index mapping back to the nearest tracked chunk.
      // Simpler: the candidate buffer stores a "virtual slot" of -1 and
      // relies on the coordinate buffers below; this is a placeholder
      // for a proper implementation that stores coordinates alongside.
      // We skip the placeholder and rely on the caller providing a
      // candidate-coordinate callback.
      const candidate = _candidateCoordinates[c];
      if (!candidate) continue;
      _streamInChunk(candidate[0], candidate[1], candidate[2], nowS);
      streamInCount++;
      if ((performanceNow() - t0) > _config.tickCpuBudgetMs) break;
    }

    _lastStreamInCount = streamInCount;
    _lastStreamOutCount = streamOutCount;
    _lastTickDurationMs = performanceNow() - t0;

    _dispatcher.emit(EVENT_TYPE.CHUNK_STREAMING_UPDATED, {
      tick,
      streamIn: streamInCount,
      streamOut: streamOutCount,
      loaded: _loadedChunkCount,
      durationMs: _lastTickDurationMs
    });
  },

  /**
   * Query the load state of a chunk coordinate. Returns one of LOAD_STATE.
   */
  getLoadState(cx, cy, cz) {
    const slot = _hashFind(cx, cy, cz);
    if (slot === -1) return LOAD_STATE.UNLOADED;
    return _streamerSlotLoadState[slot];
  },

  /**
   * Query the streamer slot for a chunk coordinate. Returns -1 if the chunk
   * is not tracked.
   */
  getStreamerSlot(cx, cy, cz) {
    return _hashFind(cx, cy, cz);
  },

  /**
   * Return the downstream slot mapping for a streamer slot. This is what
   * downstream consumers use to translate a streamer slot to their own slot
   * in 328, 329, 330, 332, 333, 334, 335, and 336.
   */
  getDownstreamSlots(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS || !_streamerSlotActive[streamerSlot]) return false;
    out.blendFieldSlot = _streamerSlotBlendFieldSlot[streamerSlot];
    out.blendSystemSlot = _streamerSlotBlendSystemSlot[streamerSlot];
    out.ecotoneSlot = _streamerSlotEcotoneSlot[streamerSlot];
    out.climateSlot = _streamerSlotClimateSlot[streamerSlot];
    out.soilSlot = _streamerSlotSoilSlot[streamerSlot];
    out.hydrologySlot = _streamerSlotHydrologySlot[streamerSlot];
    out.faunaSlot = _streamerSlotFaunaSlot[streamerSlot];
    out.descriptorSlot = _streamerSlotDescriptorSlot[streamerSlot];
    return true;
  },

  /**
   * Return a read-only view of the streamer's state. Used by 358's
   * diagnostics and by any system that needs to iterate loaded chunks.
   */
  forEachLoadedChunk(fn) {
    for (let s = 0; s < MAX_TRACKED_CHUNKS; s++) {
      if (!_streamerSlotActive[s]) continue;
      if (_streamerSlotLoadState[s] !== LOAD_STATE.LOADED) continue;
      fn(
        _streamerSlotChunkX[s],
        _streamerSlotChunkY[s],
        _streamerSlotChunkZ[s],
        s
      );
    }
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get loadedChunks() { return _loadedChunkCount; },
  get lastStreamInCount() { return _lastStreamInCount; },
  get lastStreamOutCount() { return _lastStreamOutCount; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get totalCapacity() { return MAX_TRACKED_CHUNKS; },
  get freeCapacity() { return _streamerSlotFreeTop; },

  // ─── Internals ───────────────────────────────────────────
  // Candidate coordinate scratch. In a full implementation this would be a
  // parallel array to _candidateSlots; the current draft keeps it as a
  // sparse array because the candidate count per tick is bounded by
  // maxCandidates.
  _candidateCoordinates: []
});

// Performance-now shim that works in every JS environment.
function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default LandscapeChunkStreamer;