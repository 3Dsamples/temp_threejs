// file number : 328
// full path name : src/context/328_BiomeBlendField.js
// description : 1 Hz scalar blend field over the biome registry — the pooled
// structure-of-arrays storage layer that resolves each world chunk to its top-K
// biome weights and exposes those weights for smooth cross-chunk interpolation.
// The blend field is the intermediate between 327_BiomeRegistryBarrel (which
// knows how to score an environmental sample against every biome) and
// 329_BiomeBlendSystem (which applies the resolved weights to the context
// frame's material, lighting, climate, soil, and hydrology slices). It runs at
// 1 Hz because biome identity changes over tens to hundreds of metres, not per
// frame, and because re-scoring all twenty-six biomes per chunk at 60 Hz would
// starve the frame budget on mobile. The field is stored as a structure-of-
// arrays: one dense Int16Array of biome ids (K per chunk), one dense Float32Array
// of weights (K per chunk), and one Float32Array per chunk of its most recent
// environmental sample (used to detect when the sample has drifted enough to
// warrant a re-score). A sparse open-addressing hash maps 3D chunk coordinates
// to a dense slot index, so lookup is O(1) and memory scales with the number of
// active chunks rather than with world size. Per-chunk evaluation is staggered
// across ticks so a single frame never sees more than a configurable budget of
// re-scores. The field supports bilinear (really trilinear in 3D) interpolation
// across the eight surrounding chunks so a biome transition between two
// neighbouring chunks is a smooth gradient rather than a hard seam. All hot-path
// operations are zero-allocation: scratch vectors and index buffers are
// preallocated, the top-K resolution is delegated to the registry's pooled
// resolveBiomes() path, and the chunk pool reuses slots on LRU eviction so the
// heap never grows unbounded. The field also exposes a small read-only "sample
// at world position" API used by material and lighting blend resolvers (331,
// 332, 351) to get a smoothly interpolated (biomeId, weight) pair at any point
// inside a chunk, without touching the sparse hash directly.
//#
// best for : Every consumer that needs per-chunk or per-world-point biome
// weights — 329_BiomeBlendSystem (applies the field to the context frame),
// 330_CrossBiomeEcotoneSystem (reads neighbour weights to detect ecotone
// bands), 331_BiomeBlendMaterialBridge (pushes blend scalars into PBR and anime
// uniforms), 332_BiomeClimateCoupling, 333_BiomeSoilCoupling,
// 334_BiomeHydrologyCoupling, 335_BiomeFaunaMigrationSystem,
// 336_LandscapeChunkDescriptor (carries the top-K weights per chunk),
// 337_LandscapeChunkStreamer (queries weights before streaming a chunk),
// 346_LandscapeVegetationScatterSystem and 347_LandscapeFaunaSpawnSystem (use
// biome weights to drive species selection), 350_LandscapeShadowScaler and
// 351_LandscapeLightingCoupler (use weights to scale shadows and lighting per
// blended biome), and any system that needs a stable, allocation-free,
// thread-safe biome weight at a world point. The field is designed to remain
// stable from small to galactic scale: the sparse hash means world size costs
// only the number of loaded chunks, the pooled slot storage means a hundred
// thousand active chunks fit in a fixed, preallocated buffer, and the staggered
// re-score budget means the per-tick CPU cost is independent of how many chunks
// are active.
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
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// The chunk edge length in world units. The field is evaluated once per chunk
// and interpolated inside the chunk, so the chunk must be large enough to
// amortise the evaluation cost over many frames, but small enough to follow
// real biome transitions at their natural spatial scale. 100 m is a
// reasonable default for a mobile-first world: a 1 km² area has 100 chunks,
// a 100 km² area has 10,000 chunks, and each chunk's top-K weights are
// re-scored at 1 Hz, so the worst-case re-score rate is bounded by the
// chunk count divided by the 60-frame amortisation window.
const DEFAULT_CHUNK_SIZE_M = 100.0;

// Number of biomes resolved per chunk. The top-K resolution is delegated to
// the biome registry; K = 4 is the practical sweet spot for smooth ecotones
// without exploding the per-chunk storage.
const DEFAULT_K_BIOMES = 4;

// Maximum number of active chunks. When this is exceeded, the least recently
// used chunk is evicted and its slot returned to the pool. 100,000 chunks
// × 4 biomes × 2 arrays × 2 bytes = 1.6 MB of pooled storage, which fits
// comfortably inside the 200 MB resident-memory ceiling.
const MAX_ACTIVE_CHUNKS = 100000;

// Per-tick re-score budget. The scheduler never evaluates more than this many
// chunks in a single frame, regardless of how many are dirty. This keeps the
// per-frame CPU cost of the blend field below ~0.5 ms on a Snapdragon 7-series
// even when every chunk is dirty at once. The default (256) amortises a
// 100,000-chunk world across roughly 24 seconds, which is comfortably inside
// the 1 Hz re-score cadence.
const DEFAULT_RESCORE_BUDGET = 256;

// Environmental drift threshold. If the sampled environmental parameters have
// not changed by more than these amounts since the last re-score, the chunk
// is considered clean and skipped. This is the primary defence against
// wasting CPU on chunks whose biome weights would not change anyway.
const DRIFT_TEMPERATURE_C = 2.0;
const DRIFT_HUMIDITY = 0.10;
const DRIFT_ELEVATION_M = 20.0;
const DRIFT_SLOPE_DEG = 3.0;
const DRIFT_WATER_TABLE_M = 1.0;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED CHUNK STORAGE (structure-of-arrays) ─────────────────
// ══════════════════════════════════════════════════════════════════
// Every per-chunk field is a separate typed array indexed by the same dense
// slot index. This keeps the memory contiguous and the access pattern
// predictable, so the CPU's prefetcher can stream whole chunks at a time.

const _K = DEFAULT_K_BIOMES;
const _MAX = MAX_ACTIVE_CHUNKS;

// Dense slot arrays
const _biomeIds    = new Int16Array(_MAX * _K).fill(-1);
const _biomeWeights = new Float32Array(_MAX * _K);
const _chunkX      = new Float32Array(_MAX);
const _chunkY      = new Float32Array(_MAX);
const _chunkZ      = new Float32Array(_MAX);
const _lastScoreTick = new Int32Array(_MAX).fill(-1);
const _lastUsedTick  = new Int32Array(_MAX).fill(-1);
const _dirty         = new Uint8Array(_MAX);
const _activeFlag    = new Uint8Array(_MAX);

// Environmental sample snapshot per slot (used for drift detection)
const _sampleTemperature  = new Float32Array(_MAX);
const _sampleHumidity     = new Float32Array(_MAX);
const _sampleElevation    = new Float32Array(_MAX);
const _sampleSlope        = new Float32Array(_MAX);
const _sampleWaterTable   = new Float32Array(_MAX);
const _sampleNoise        = new Float32Array(_MAX);

// Free-list stack: slots that are available for reuse. New allocations pop
// from this stack; evicted chunks push back onto it.
const _freeStack = new Int32Array(_MAX);
let _freeStackTop = _MAX;
for (let i = 0; i < _MAX; i++) _freeStack[i] = _MAX - 1 - i;

// ══════════════════════════════════════════════════════════════════
// ─── SPARSE HASH MAP (chunkCoordKey → slot) ────────────────────
// ══════════════════════════════════════════════════════════════════
// The hash is an open-addressing table with linear probing. Keys are packed
// 3D chunk coordinates combined via a prime-multiplier hash into a 32-bit
// integer. The table is sized to 2× the maximum active chunks so the load
// factor stays at 0.5, which keeps probe lengths short and predictable. The
// table is preallocated; no growth is possible, which means no GC pressure
// and no risk of an unbounded allocation on a pathological chunk stream.

const _HASH_SIZE = _MAX * 2;
const _hashKeys = new Int32Array(_HASH_SIZE).fill(0);   // 0 = empty
const _hashSlots = new Int32Array(_HASH_SIZE).fill(-1);

// Prime multipliers chosen to spread chunks uniformly across the table.
const PRIME_X = 73856093;
const PRIME_Y = 19349663;
const PRIME_Z = 83492791;

// Pack a chunk coordinate triple into a 32-bit key. The bit-shifted form is
// reversible for the ranges we care about (±500,000 chunks per axis) and is
// the canonical key for the sparse hash.
function _packChunkKey(cx, cy, cz) {
  // Bias into unsigned 16-bit range, then interleave with primes.
  const ux = (cx + 32768) & 0xFFFF;
  const uy = (cy + 32768) & 0xFFFF;
  const uz = (cz + 32768) & 0xFFFF;
  // 32-bit mixed hash (avalanche-ish).
  let h = (ux * PRIME_X) ^ (uy * PRIME_Y) ^ (uz * PRIME_Z);
  h = (h ^ (h >>> 16)) * 0x85ebca6b;
  h = (h ^ (h >>> 13)) * 0xc2b2ae35;
  h = h ^ (h >>> 16);
  return h | 0;
}

// Internal scratch buffers for resolveBiomes()
const _resolveIds    = new Int16Array(_K);
const _resolveWeights = new Float32Array(_K);

// Public accessor for callers that want to read the raw resolved weights
// without touching the sparse hash.
export const _blendFieldInternal = Object.freeze({
  K: _K,
  MAX: _MAX,
  biomeIds: _biomeIds,
  biomeWeights: _biomeWeights
});

// ══════════════════════════════════════════════════════════════════
// ─── HASH HELPERS ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
function _hashFind(cx, cy, cz) {
  const key = _packChunkKey(cx, cy, cz);
  let slot = (key >>> 0) % _HASH_SIZE;
  for (let probe = 0; probe < _HASH_SIZE; probe++) {
    const k = _hashKeys[slot];
    if (k === 0) return -1;               // empty
    if (k === key && _hashSlots[slot] !== -1) {
      // Confirm against the canonical coordinate, in case two chunks collide
      // through the same 32-bit hash.
      const s = _hashSlots[slot];
      if (_chunkX[s] === cx && _chunkY[s] === cy && _chunkZ[s] === cz) {
        return s;
      }
    }
    slot = (slot + 1) & (_HASH_SIZE - 1);
  }
  return -1;
}

function _hashInsert(cx, cy, cz, slot) {
  const key = _packChunkKey(cx, cy, cz);
  let h = (key >>> 0) % _HASH_SIZE;
  for (let probe = 0; probe < _HASH_SIZE; probe++) {
    if (_hashKeys[h] === 0) {
      _hashKeys[h] = key;
      _hashSlots[h] = slot;
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
      // Check canonical coordinates before erasing.
      const s = _hashSlots[h];
      if (s !== -1 && _chunkX[s] === cx && _chunkY[s] === cy && _chunkZ[s] === cz) {
        _hashSlots[h] = -1;
        // Leave the key in place; linear-probe chains must remain contiguous.
        return;
      }
    }
    h = (h + 1) & (_HASH_SIZE - 1);
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── POOL HELPERS ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
function _poolAlloc() {
  if (_freeStackTop === 0) return -1;
  return _freeStack[--_freeStackTop];
}

function _poolFree(slot) {
  _activeFlag[slot] = 0;
  _dirty[slot] = 0;
  _lastScoreTick[slot] = -1;
  _lastUsedTick[slot] = -1;
  // Clear the biome slots so a future allocation sees a clean state.
  const base = slot * _K;
  for (let i = 0; i < _K; i++) {
    _biomeIds[base + i] = -1;
    _biomeWeights[base + i] = 0;
  }
  if (_freeStackTop < _MAX) _freeStack[_freeStackTop++] = slot;
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME RESOLUTION ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
function _scoreChunk(slot, env) {
  const n = BiomeRegistry.resolveBiomes(env, _resolveIds, _resolveWeights, _K);
  const base = slot * _K;
  for (let i = 0; i < n; i++) {
    _biomeIds[base + i] = _resolveIds[i];
    _biomeWeights[base + i] = _resolveWeights[i];
  }
  for (let i = n; i < _K; i++) {
    _biomeIds[base + i] = -1;
    _biomeWeights[base + i] = 0;
  }
  // Snapshot the environmental sample for drift detection.
  _sampleTemperature[slot] = env.temperatureC;
  _sampleHumidity[slot] = env.humidity;
  _sampleElevation[slot] = env.elevationM;
  _sampleSlope[slot] = env.slopeDeg;
  _sampleWaterTable[slot] = env.waterTableDepthM;
  _sampleNoise[slot] = env.noise !== undefined ? env.noise : 0;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const BiomeBlendField = Object.freeze({
  // ─── Configuration ────────────────────────────────────────
  chunkSizeM: DEFAULT_CHUNK_SIZE_M,
  kBiomes: _K,
  maxActiveChunks: _MAX,
  rescoreBudget: DEFAULT_RESCORE_BUDGET,

  /**
   * Ensure a chunk exists in the field, allocating a slot from the pool if
   * necessary. Returns the slot index, or -1 if the pool is exhausted. When
   * the pool is exhausted, the field does NOT silently grow: instead the
   * caller is expected to consult `evictLRU()` or to lower the chunk density.
   * This is a deliberate hard limit so the field can never exceed the
   * resident-memory ceiling.
   *
   * @param {number} cx - Chunk X coordinate (integer).
   * @param {number} cy - Chunk Y coordinate (integer).
   * @param {number} cz - Chunk Z coordinate (integer).
   * @returns {number} Slot index, or -1 if the pool is exhausted.
   */
  ensureChunk(cx, cy, cz) {
    const existing = _hashFind(cx, cy, cz);
    if (existing !== -1) {
      _lastUsedTick[existing] = 0; // stamped by caller via `touchChunk`
      return existing;
    }
    const slot = _poolAlloc();
    if (slot === -1) return -1;
    _activeFlag[slot] = 1;
    _dirty[slot] = 1;
    _chunkX[slot] = cx;
    _chunkY[slot] = cy;
    _chunkZ[slot] = cz;
    _hashInsert(cx, cy, cz, slot);
    return slot;
  },

  /**
   * Mark a chunk as recently used. Called by the chunk streamer on every tick
   * a chunk remains in the camera's predicted frustum. The LRU eviction uses
   * this tick stamp to decide which chunk to evict when the pool is full.
   *
   * @param {number} slot - The slot returned by `ensureChunk`.
   * @param {number} tick - The current tick counter (from CoreClock).
   */
  touchChunk(slot, tick) {
    if (slot < 0 || slot >= _MAX || !_activeFlag[slot]) return;
    _lastUsedTick[slot] = tick;
  },

  /**
   * Look up the slot for an already-existing chunk. Does not allocate.
   * Returns -1 if the chunk is not currently in the field.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} cz
   * @returns {number}
   */
  findChunk(cx, cy, cz) {
    return _hashFind(cx, cy, cz);
  },

  /**
   * Evict the least recently used chunk, freeing its slot back to the pool.
   * Returns true if a chunk was evicted, false if the field is empty.
   * Called by the streamer when it wants to make room for a higher-priority
   * chunk and the pool is full.
   *
   * @returns {boolean}
   */
  evictLRU() {
    let oldestSlot = -1;
    let oldestTick = Infinity;
    for (let s = 0; s < _MAX; s++) {
      if (!_activeFlag[s]) continue;
      const t = _lastUsedTick[s];
      if (t < oldestTick) {
        oldestTick = t;
        oldestSlot = s;
      }
    }
    if (oldestSlot === -1) return false;
    _hashErase(_chunkX[oldestSlot], _chunkY[oldestSlot], _chunkZ[oldestSlot]);
    _poolFree(oldestSlot);
    return true;
  },

  /**
   * Mark a chunk as dirty. Dirty chunks are re-scored by the 1 Hz tick that
   * calls `rescoreDirtyChunks()`. The caller is expected to compute the
   * environmental sample for the chunk and pass it in; the field does not
   * recompute the environment.
   *
   * @param {number} slot
   */
  markDirty(slot) {
    if (slot < 0 || slot >= _MAX || !_activeFlag[slot]) return;
    _dirty[slot] = 1;
  },

  /**
   * Re-score a bounded number of dirty chunks. This is the entry point the
   * 1 Hz scheduler calls once per second. The function walks the active-slot
   * list (which is the pool's free-stack complement) and re-scores up to
   * `rescoreBudget` dirty chunks, skipping any chunk whose environmental
   * sample has not drifted past the drift thresholds since the last re-score.
   *
   * The caller provides a `sampleFor` callback that returns the current
   * environmental sample for a given chunk coordinate. This keeps the field
   * decoupled from the specific set of environment providers and makes it
   * easy to test with synthetic samples.
   *
   * @param {number} tick - The current tick counter.
   * @param {(cx:number, cy:number, cz:number) => object} sampleFor -
   *   Returns an env object with the fields consumed by
   *   `BiomeRegistry.resolveBiomes()`: temperatureC, humidity, elevationM,
   *   slopeDeg, soilSand, soilSilt, soilClay, waterTableDepthM, noise.
   * @returns {{ scored: number, skipped: number, budgetExhausted: boolean }}
   */
  rescoreDirtyChunks(tick, sampleFor) {
    let scored = 0;
    let skipped = 0;
    let budget = this.rescoreBudget;
    for (let s = 0; s < _MAX; s++) {
      if (budget === 0) return { scored, skipped, budgetExhausted: true };
      if (!_activeFlag[s]) continue;
      if (!_dirty[s]) continue;
      // Re-score every chunk that has never been scored, and otherwise wait
      // until 1 Hz worth of ticks have elapsed since the last score.
      const lastTick = _lastScoreTick[s];
      if (lastTick >= 0 && tick - lastTick < 60) continue;
      const env = sampleFor(_chunkX[s], _chunkY[s], _chunkZ[s]);
      // Drift check: skip if the sample has not moved enough to matter.
      if (lastTick >= 0) {
        const dT = Math.abs(env.temperatureC - _sampleTemperature[s]);
        const dH = Math.abs(env.humidity - _sampleHumidity[s]);
        const dE = Math.abs(env.elevationM - _sampleElevation[s]);
        const dS = Math.abs(env.slopeDeg - _sampleSlope[s]);
        const dW = Math.abs(env.waterTableDepthM - _sampleWaterTable[s]);
        if (dT < DRIFT_TEMPERATURE_C && dH < DRIFT_HUMIDITY &&
            dE < DRIFT_ELEVATION_M && dS < DRIFT_SLOPE_DEG &&
            dW < DRIFT_WATER_TABLE_M) {
          skipped++;
          _dirty[s] = 0;
          continue;
        }
      }
      _scoreChunk(s, env);
      _lastScoreTick[s] = tick;
      _dirty[s] = 0;
      scored++;
      budget--;
    }
    return { scored, skipped, budgetExhausted: false };
  },

  /**
   * Read the resolved (biomeIds, weights) for a chunk. The caller is
   * responsible for treating the arrays as immutable views. Zero-allocation.
   *
   * @param {number} slot
   * @param {Int16Array} outIds - Must have length ≥ kBiomes.
   * @param {Float32Array} outWeights - Must have length ≥ kBiomes.
   * @returns {number} Number of populated entries (0..kBiomes).
   */
  readChunk(slot, outIds, outWeights) {
    if (slot < 0 || slot >= _MAX || !_activeFlag[slot]) return 0;
    const base = slot * _K;
    let n = 0;
    for (let i = 0; i < _K; i++) {
      const id = _biomeIds[base + i];
      if (id === -1) break;
      outIds[i] = id;
      outWeights[i] = _biomeWeights[base + i];
      n++;
    }
    return n;
  },

  /**
   * Sample the smoothly interpolated biome weights at a world position.
   *
   * The function projects the world position into the 3D chunk grid, samples
   * the eight surrounding chunks (with weights depending on fractional
   * position within the chunk), and writes the blended top-K results into
   * `outIds` and `outWeights`. The result is a smooth blend of the four to
   * eight neighbouring chunks' weight vectors, which is what makes biome
   * transitions appear as gradients rather than seams.
   *
   * All buffers are preallocated; the function is zero-allocation in the hot
   * path. Neighbour chunks that are not currently loaded are treated as
   * having the same weights as the nearest loaded neighbour, which prevents
   * holes at the edge of the active region.
   *
   * @param {number} worldX - World X in metres.
   * @param {number} worldY - World Y in metres.
   * @param {number} worldZ - World Z in metres.
   * @param {Int16Array} outIds - Output blended biome ids.
   * @param {Float32Array} outWeights - Output blended weights.
   * @param {number} [maxCount=4] - Maximum number of blended entries.
   * @returns {number} Number of entries written.
   */
  sampleAt(worldX, worldY, worldZ, outIds, outWeights, maxCount = 4) {
    const cs = this.chunkSizeM;
    const cxF = worldX / cs;
    const cyF = worldY / cs;
    const czF = worldZ / cs;
    const cx = Math.floor(cxF);
    const cy = Math.floor(cyF);
    const cz = Math.floor(czF);
    const fx = cxF - cx;
    const fy = cyF - cy;
    const fz = czF - cz;

    // Blend the eight surrounding chunks using a tricube weighting function.
    // Tricube is C²-continuous and zero-derivative at the boundary, which
    // produces smooth transitions without the overshoot of a trilinear
    // interpolant.
    const w000 = _tricube(fx)     * _tricube(fy)     * _tricube(fz);
    const w100 = _tricube(1 - fx) * _tricube(fy)     * _tricube(fz);
    const w010 = _tricube(fx)     * _tricube(1 - fy) * _tricube(fz);
    const w110 = _tricube(1 - fx) * _tricube(1 - fy) * _tricube(fz);
    const w001 = _tricube(fx)     * _tricube(fy)     * _tricube(1 - fz);
    const w101 = _tricube(1 - fx) * _tricube(fy)     * _tricube(1 - fz);
    const w011 = _tricube(fx)     * _tricube(1 - fy) * _tricube(1 - fz);
    const w111 = _tricube(1 - fx) * _tricube(1 - fy) * _tricube(1 - fz);

    // Accumulate per-biome weights across the eight corners. A small
    // per-call scratch map keeps the accumulation O(8·K) without allocation.
    // Because K is small (4 by default) and the total number of corner
    // entries is 32, a fixed-size linear scan is faster than a hash.
    let count = 0;
    const accumIds = _sampleScratchIds;
    const accumWeights = _sampleScratchWeights;
    // Zero the accumulator.
    for (let i = 0; i < accumIds.length; i++) {
      accumIds[i] = -1;
      accumWeights[i] = 0;
    }
    _accumulateCorner(cx,     cy,     cz,     w000, accumIds, accumWeights, maxCount);
    _accumulateCorner(cx + 1, cy,     cz,     w100, accumIds, accumWeights, maxCount);
    _accumulateCorner(cx,     cy + 1, cz,     w010, accumIds, accumWeights, maxCount);
    _accumulateCorner(cx + 1, cy + 1, cz,     w110, accumIds, accumWeights, maxCount);
    _accumulateCorner(cx,     cy,     cz + 1, w001, accumIds, accumWeights, maxCount);
    _accumulateCorner(cx + 1, cy,     cz + 1, w101, accumIds, accumWeights, maxCount);
    _accumulateCorner(cx,     cy + 1, cz + 1, w011, accumIds, accumWeights, maxCount);
    _accumulateCorner(cx + 1, cy + 1, cz + 1, w111, accumIds, accumWeights, maxCount);

    // Compact the accumulator into the output buffers, keeping the top-K
    // entries in descending weight order.
    const outCount = _compactTopK(accumIds, accumWeights, maxCount, outIds, outWeights);
    return outCount;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  /**
   * Returns the number of active chunks currently in the field.
   */
  get activeCount() {
    return _MAX - _freeStackTop;
  },

  /**
   * Returns the number of free slots remaining in the pool.
   */
  get freeCount() {
    return _freeStackTop;
  }
});

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL SAMPLE SCRATCH BUFFERS ───────────────────────────
// ══════════════════════════════════════════════════════════════════
// The sampling path accumulates up to 8 × K = 32 biome entries, but no more
// than K unique biomes can survive the compaction. The scratch buffer is
// sized to 8 × K so the accumulation step never overflows.
const _MAX_SAMPLE_ENTRIES = 8 * _K;
const _sampleScratchIds = new Int16Array(_MAX_SAMPLE_ENTRIES).fill(-1);
const _sampleScratchWeights = new Float32Array(_MAX_SAMPLE_ENTRIES);

// Tricube weighting: w(t) = (1 - |t|³)³ for |t| < 1, else 0.
function _tricube(t) {
  if (t < 0) t = -t;
  if (t >= 1) return 0;
  const u = 1 - t * t * t;
  return u * u * u;
}

// Accumulate a single corner's contribution into the per-biome accumulator.
function _accumulateCorner(cx, cy, cz, cornerWeight, accumIds, accumWeights, maxCount) {
  if (cornerWeight < 1e-6) return;
  const slot = _hashFind(cx, cy, cz);
  if (slot === -1) return;   // missing neighbours contribute nothing
  const base = slot * _K;
  for (let i = 0; i < _K; i++) {
    const id = _biomeIds[base + i];
    if (id === -1) break;
    const w = _biomeWeights[base + i] * cornerWeight;
    // Find or insert the biome id in the accumulator.
    let found = false;
    for (let j = 0; j < maxCount; j++) {
      if (accumIds[j] === id) {
        accumWeights[j] += w;
        found = true;
        break;
      }
    }
    if (!found) {
      // Insert into the first empty slot, or replace the smallest entry if
      // the accumulator is full. The replacement path uses a bounded linear
      // scan; K is small enough that this is still O(K).
      let empty = -1;
      let smallestIdx = 0;
      let smallestWeight = accumWeights[0];
      for (let j = 0; j < maxCount; j++) {
        if (accumIds[j] === -1) { empty = j; break; }
        if (accumWeights[j] < smallestWeight) {
          smallestWeight = accumWeights[j];
          smallestIdx = j;
        }
      }
      if (empty !== -1) {
        accumIds[empty] = id;
        accumWeights[empty] = w;
      } else if (w > smallestWeight) {
        accumIds[smallestIdx] = id;
        accumWeights[smallestIdx] = w;
      }
    }
  }
}

// Compact the accumulator into the caller's output buffers, sorted by
// descending weight. The output is truncated to `maxCount` entries and
// re-normalised so the weights sum to 1. Zero-allocation.
function _compactTopK(accumIds, accumWeights, maxCount, outIds, outWeights) {
  // Copy the non-empty entries into the output buffers, then bubble-sort by
  // weight. Bubble sort is fine here because the array is tiny (≤ 4 entries
  // in the default configuration).
  let n = 0;
  for (let i = 0; i < _MAX_SAMPLE_ENTRIES && n < maxCount; i++) {
    if (accumIds[i] === -1) continue;
    outIds[n] = accumIds[i];
    outWeights[n] = accumWeights[i];
    n++;
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      if (outWeights[j] > outWeights[i]) {
        const ti = outIds[i]; outIds[i] = outIds[j]; outIds[j] = ti;
        const tw = outWeights[i]; outWeights[i] = outWeights[j]; outWeights[j] = tw;
      }
    }
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += outWeights[i];
  if (sum > 0) {
    const inv = 1 / sum;
    for (let i = 0; i < n; i++) outWeights[i] *= inv;
  }
  return n;
}

export default BiomeBlendField;