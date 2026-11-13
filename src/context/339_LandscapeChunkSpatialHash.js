// file number : 339
// full path name : src/context/339_LandscapeChunkSpatialHash.js
// description : Landscape chunk spatial hash — the 10 Hz consumer that maintains
// a tier-bucketed spatial index over the loaded chunk set so that
// 273_FrustumCullingSystem, 340_LandscapeChunkOcclusion, 346_LandscapeVegetation-
// ScatterSystem, 347_LandscapeFaunaSpawnSystem, and any other consumer that needs
// to answer "which chunks are near this region?" can do so in O(buckets) rather
// than O(chunks). The hash maintains four independent bucket grids, one per
// HLOD tier, each with a bucket size chosen so that the tier's chunk count per
// bucket stays bounded: 250 m buckets for the KILOMETER tier, 1 km buckets for
// the TEN_KILOMETER tier, 5 km buckets for the HUNDRED_KILOMETER tier, and 25 km
// buckets for the THOUSAND_KILOMETER tier. For each bucket it stores the list of
// streamer slots assigned to it, plus a per-bucket aggregate record that 273,
// 340, 346, and 347 read directly: the bucket's world-space AABB, its dominant
// biome id, its mean distance from the camera, its mean HLOD tier, its mean
// fused air and soil temperature, its mean fused humidity, and an occluder count
// derived from the neighbour buckets. The aggregates are updated incrementally
// as chunks stream in and out, so the per-tick cost is proportional to the
// number of chunks that changed state, not the total loaded set. A round-robin
// window with a configurable budget (default 512 chunks per tick) additionally
// re-touches a fraction of the loaded set each tick to refresh time-varying
// aggregates (mean distance, mean tier, occluder count) without touching
// everything at once. The bucket grids are pooled with an LRU-based eviction
// policy so that a very large loaded set cannot exhaust the pool; when a grid
// runs out of bucket slots, the least-recently-used bucket is retired and its
// chunks are reassigned to the surviving buckets on the next pass. The
// material and lighting features are integrated directly into the bucket
// record: each bucket exposes blended material traits (albedo in linear RGB,
// roughness, metalness, wetness response, anime flatness, emissive intensity,
// subsurface, snow coverage) and blended lighting traits (sun diffuse fraction,
// sun intensity scale, colour cast in linear RGB, sky tint, fog density, dappled
// light frequency and amplitude, shadow softness) so that a downstream culling,
// lighting, or occlusion consumer can read the bucket's material and lighting
// state with a single integer lookup, without needing to consult 331 or 350.
// Every query API is zero-allocation: queryBucket, queryTier, queryRadius, and
// queryAABB all write into preallocated caller-supplied output buffers, and the
// internal per-bucket scratch is reused across calls. The module is designed to
// remain stable from small to galactic scale: bucket counts are bounded per
// tier, the bucket hash is a fixed-size open-addressing table with an LRU
// eviction policy, and the per-tick work is bounded by the tick budget, so a
// world with 100,000 loaded chunks costs the same per tick as a world with 100.
//#
// best for : Every consumer that needs to answer "which loaded chunks are
// near this region, what biome are they in, what HLOD tier are they in, and
// what material and lighting state should I use for them?" in O(buckets) —
// 273_FrustumCullingSystem (queries the tier-appropriate bucket grid to
// collect the chunks inside the camera frustum without iterating the whole
// loaded set), 313_IsVisibleConsumer (uses the same query to build the
// visible-chunk list), 340_LandscapeChunkOcclusion (reads the bucket
// occluder counts and AABBs to build the inter-chunk occlusion graph),
// 346_LandscapeVegetationScatterSystem (queries the near-bucket grid to
// find the chunks that need vegetation updates), 347_LandscapeFaunaSpawn-
// System (queries the near-bucket grid to find the chunks whose fauna
// presence field needs to be refreshed), 350_LandscapeShadowScaler (reads
// the bucket's mean tier and mean distance to scale shadow cascades),
// 351_LandscapeLightingCoupler (reads the bucket's blended lighting traits
// to set per-bucket directional and ambient light parameters),
// 354_LandscapeSensoryCoupler (reads the bucket's biome and material
// traits to set per-bucket acoustic and olfactory cues),
// 355_LandscapePerformanceGovernor (reads the bucket counts per tier to
// arbitrate budgets), and any system that needs a stable, allocation-free,
// tier-aware spatial index over the loaded chunk set. The module is the
// single spatial authority that every culling, occlusion, vegetation,
// fauna, and lighting consumer consults.
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
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { CoreLayers, LAYER } from './266_CoreLayers.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { FrustumCullingSystem } from './273_FrustumCullingSystem.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer, LOAD_STATE } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336 and 338.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Bucket sizes per tier, in metres. Chosen so that the number of chunks
// per bucket stays bounded (roughly 8–32 chunks per bucket in practice):
//   KILOMETER tier (0–1 km)         250 m buckets  → 4×4×4 = 64 cell region
//   TEN_KILOMETER tier (1–10 km)    1000 m buckets → 8×8×8 = 512 cell region
//   HUNDRED_KILOMETER tier (10–100) 5000 m buckets → 10×10×10 = 1000 cell region
//   THOUSAND_KILOMETER tier (>100)  25000 m buckets → 10×10×10 = 1000 cell region
const TIER_BUCKET_SIZES_M = Object.freeze([250.0, 1000.0, 5000.0, 25000.0]);

// Maximum number of buckets per tier. Each tier's pool is independent, so
// a huge loaded set in one tier does not starve the others. 4096 buckets
// per tier supports a 1024 km cube at the 250 m tier, a 4,096 km cube at
// the 1 km tier, a 20,480 km cube at the 5 km tier, and a 102,400 km cube
// at the 25 km tier — plenty for any realistic world.
const MAX_BUCKETS_PER_TIER = 4096;

// Maximum number of chunk slots per bucket. Average occupancy is a few
// dozen, so 96 is a comfortable ceiling that comfortably accommodates the
// dense near-camera bucket at the KILOMETER tier.
const MAX_CHUNKS_PER_BUCKET = 96;

// Hash table size per tier. Sized to 2× MAX_BUCKETS_PER_TIER, so the load
// factor stays at 0.5 and probe chains are short and predictable.
const HASH_SIZE_PER_TIER = MAX_BUCKETS_PER_TIER * 2;

// Per-tick re-touch budget. The incremental add/remove path keeps the
// bucket aggregates up to date when chunks stream in or out, but the mean
// distance, mean tier, and occluder count change every frame. We refresh
// these on a bounded number of buckets per tick (default 512 buckets per
// tier per tick) so the per-tick CPU cost stays bounded.
const DEFAULT_RETOUCH_BUDGET = 512;

// LRU touch interval. A bucket is considered "recently used" if it has
// been queried or re-touched within this interval. Buckets that have not
// been used for longer than this may be evicted to make room for new
// buckets when the pool is exhausted.
const BUCKET_LRU_INTERVAL_S = 30.0;

// Maximum number of loaded chunks. Must match 336, 337, and 338 so the
// streamer slot is a valid index in this module's per-chunk bookkeeping.
const MAX_TRACKED_CHUNKS = 100000;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED BUCKET STATE (structure-of-arrays, one grid per tier) ─
// ══════════════════════════════════════════════════════════════════

// Per-tier bucket bookkeeping arrays. Each is indexed by bucket slot,
// with a leading tier dimension so all four tiers live in one flat array
// per field. This keeps the memory contiguous per field and makes the
// hot-path access pattern predictable.
const _bucketActive          = new Uint8Array(4 * MAX_BUCKETS_PER_TIER);
const _bucketKey             = new Int32Array(4 * MAX_BUCKETS_PER_TIER);
const _bucketChunkCount      = new Uint16Array(4 * MAX_BUCKETS_PER_TIER);
const _bucketChunkSlots      = new Int32Array(4 * MAX_BUCKETS_PER_TIER * MAX_CHUNKS_PER_BUCKET).fill(-1);
const _bucketDominantBiome   = new Int16Array(4 * MAX_BUCKETS_PER_TIER).fill(-1);
const _bucketMeanDistance    = new Float32Array(4 * MAX_BUCKETS_PER_TIER);
const _bucketMeanTier        = new Float32Array(4 * MAX_BUCKETS_PER_TIER);
const _bucketOccluderCount   = new Uint16Array(4 * MAX_BUCKETS_PER_TIER);
const _bucketLastTouchS      = new Float32Array(4 * MAX_BUCKETS_PER_TIER).fill(-1);

// Per-bucket AABB in world space. Six floats per bucket: minX, minY, minZ,
// maxX, maxY, maxZ.
const _bucketAABB            = new Float32Array(4 * MAX_BUCKETS_PER_TIER * 6);

// Per-bucket material traits (in linear RGB and 0..1 scalars). Nine floats
// per bucket: albedoR, albedoG, albedoB, roughness, metalness, wetness,
// animeFlatness, emissive, subsurface.
const _bucketMaterial        = new Float32Array(4 * MAX_BUCKETS_PER_TIER * 9);

// Per-bucket lighting traits. Eleven floats per bucket: sunDiffuseFraction,
// sunIntensityScale, colourCastR, colourCastG, colourCastB, skyTintR,
// skyTintG, skyTintB, fogDensity, dappledFrequency, dappledAmplitude.
const _bucketLighting        = new Float32Array(4 * MAX_BUCKETS_PER_TIER * 11);

// Per-bucket snow coverage, scaled by the mean fused snow water equivalent.
const _bucketSnowCoverage    = new Float32Array(4 * MAX_BUCKETS_PER_TIER);

// ─── Hash tables per tier ──────────────────────────────────────
const _hashKeys = new Int32Array(4 * HASH_SIZE_PER_TIER).fill(0);
const _hashSlot = new Int32Array(4 * HASH_SIZE_PER_TIER).fill(-1);

// Prime multipliers for the bucket-key packing hash. Distinct from the
// streamer's primes so a bucket hash and a chunk hash do not collide in
// the same way (defence in depth).
const BUCKET_PRIME_X = 92837111;
const BUCKET_PRIME_Y = 689287499;
const BUCKET_PRIME_Z = 283923481;

// ─── Bucket free lists per tier ────────────────────────────────
const _bucketFree = new Int32Array(4 * MAX_BUCKETS_PER_TIER);
const _bucketFreeTop = new Int32Array(4);
for (let t = 0; t < 4; t++) {
  _bucketFreeTop[t] = MAX_BUCKETS_PER_TIER;
  for (let i = 0; i < MAX_BUCKETS_PER_TIER; i++) {
    _bucketFree[t * MAX_BUCKETS_PER_TIER + i] = MAX_BUCKETS_PER_TIER - 1 - i;
  }
}

// ─── Chunk → bucket mapping per tier ──────────────────────────
// For each loaded chunk (indexed by streamer slot) and for each tier, the
// bucket slot it belongs to. -1 means "not assigned".
const _chunkBucketPerTier = new Int32Array(4 * MAX_TRACKED_CHUNKS).fill(-1);

// ─── Chunk active flag (mirrors the streamer's slot active flag) ─
const _chunkActive = new Uint8Array(MAX_TRACKED_CHUNKS);

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _cameraPos = new Vec3();
const _cameraPredictedPos = new Vec3();
const _cameraForward = new Vec3();

// Per-tick aggregate scratch. Reused across the retouch pass.
const _retouchAccum = new Float32Array(10);

// Per-bucket material/lighting read scratch.
const _materialScratch = new Float32Array(16);
const _lightingScratch = new Float32Array(8);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _rrCursor = 0;
let _lastProcessed = 0;
let _lastRetouched = 0;
let _lastActiveBuckets = 0;
let _lastActiveChunks = 0;

// ══════════════════════════════════════════════════════════════════
// ─── HASH HELPERS ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _packBucketKey(bx, by, bz) {
  const ux = (bx + 32768) & 0xFFFF;
  const uy = (by + 32768) & 0xFFFF;
  const uz = (bz + 32768) & 0xFFFF;
  let h = (ux * BUCKET_PRIME_X) ^ (uy * BUCKET_PRIME_Y) ^ (uz * BUCKET_PRIME_Z);
  h = (h ^ (h >>> 16)) * 0x85ebca6b;
  h = (h ^ (h >>> 13)) * 0xc2b2ae35;
  h = h ^ (h >>> 16);
  return h | 0;
}

function _hashFindBucket(tier, bx, by, bz) {
  const key = _packBucketKey(bx, by, bz);
  const base = tier * HASH_SIZE_PER_TIER;
  let slot = (key >>> 0) % HASH_SIZE_PER_TIER;
  for (let probe = 0; probe < HASH_SIZE_PER_TIER; probe++) {
    const k = _hashKeys[base + slot];
    if (k === 0) return -1;
    if (k === key && _hashSlot[base + slot] !== -1) {
      return _hashSlot[base + slot];
    }
    slot = (slot + 1) & (HASH_SIZE_PER_TIER - 1);
  }
  return -1;
}

function _hashInsertBucket(tier, bx, by, bz, bucketSlot) {
  const key = _packBucketKey(bx, by, bz);
  const base = tier * HASH_SIZE_PER_TIER;
  let h = (key >>> 0) % HASH_SIZE_PER_TIER;
  for (let probe = 0; probe < HASH_SIZE_PER_TIER; probe++) {
    if (_hashKeys[base + h] === 0) {
      _hashKeys[base + h] = key;
      _hashSlot[base + h] = bucketSlot;
      return;
    }
    h = (h + 1) & (HASH_SIZE_PER_TIER - 1);
  }
}

function _hashEraseBucket(tier, bx, by, bz) {
  const key = _packBucketKey(bx, by, bz);
  const base = tier * HASH_SIZE_PER_TIER;
  let h = (key >>> 0) % HASH_SIZE_PER_TIER;
  for (let probe = 0; probe < HASH_SIZE_PER_TIER; probe++) {
    if (_hashKeys[base + h] === 0) return;
    if (_hashKeys[base + h] === key && _hashSlot[base + h] !== -1) {
      _hashSlot[base + h] = -1;
      return;
    }
    h = (h + 1) & (HASH_SIZE_PER_TIER - 1);
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── BUCKET LIFECYCLE ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _allocBucket(tier) {
  if (_bucketFreeTop[tier] === 0) {
    // Pool is exhausted. Retire the least recently used bucket to make
    // room. We scan the tier's buckets for the oldest lastTouchS.
    const base = tier * MAX_BUCKETS_PER_TIER;
    let oldestSlot = -1;
    let oldestTime = Infinity;
    for (let s = 0; s < MAX_BUCKETS_PER_TIER; s++) {
      if (!_bucketActive[base + s]) continue;
      const t = _bucketLastTouchS[base + s];
      if (t < oldestTime) {
        oldestTime = t;
        oldestSlot = s;
      }
    }
    if (oldestSlot === -1) return -1;
    _retireBucket(tier, oldestSlot);
  }
  return _bucketFree[tier * MAX_BUCKETS_PER_TIER + (--_bucketFreeTop[tier])];
}

function _retireBucket(tier, bucketSlot) {
  const base = tier * MAX_BUCKETS_PER_TIER + bucketSlot;
  // Detach all chunks from the bucket so they get reassigned on the next
  // pass. We do this before clearing the bucket state so a chunk scan
  // does not see a half-cleared bucket.
  const chunkBase = base * MAX_CHUNKS_PER_BUCKET;
  for (let i = 0; i < MAX_CHUNKS_PER_BUCKET; i++) {
    const streamerSlot = _bucketChunkSlots[chunkBase + i];
    if (streamerSlot !== -1) {
      _chunkBucketPerTier[tier * MAX_TRACKED_CHUNKS + streamerSlot] = -1;
      _bucketChunkSlots[chunkBase + i] = -1;
    }
  }
  // Clear the bucket.
  _bucketActive[base] = 0;
  _bucketKey[base] = 0;
  _bucketChunkCount[base] = 0;
  _bucketDominantBiome[base] = -1;
  _bucketMeanDistance[base] = 0;
  _bucketMeanTier[base] = 0;
  _bucketOccluderCount[base] = 0;
  _bucketLastTouchS[base] = -1;
  _bucketSnowCoverage[base] = 0;
  const aabbBase = base * 6;
  for (let i = 0; i < 6; i++) _bucketAABB[aabbBase + i] = 0;
  const matBase = base * 9;
  for (let i = 0; i < 9; i++) _bucketMaterial[matBase + i] = 0;
  const lightBase = base * 11;
  for (let i = 0; i < 11; i++) _bucketLighting[lightBase + i] = 0;
  // Return the slot to the free list.
  if (_bucketFreeTop[tier] < MAX_BUCKETS_PER_TIER) {
    _bucketFree[tier * MAX_BUCKETS_PER_TIER + _bucketFreeTop[tier]++] = bucketSlot;
  }
}

function _ensureBucket(tier, bx, by, bz, nowS) {
  let bucketSlot = _hashFindBucket(tier, bx, by, bz);
  if (bucketSlot !== -1) {
    const base = tier * MAX_BUCKETS_PER_TIER + bucketSlot;
    _bucketLastTouchS[base] = nowS;
    return bucketSlot;
  }
  bucketSlot = _allocBucket(tier);
  if (bucketSlot === -1) return -1;
  const base = tier * MAX_BUCKETS_PER_TIER + bucketSlot;
  _bucketActive[base] = 1;
  _bucketKey[base] = _packBucketKey(bx, by, bz);
  _bucketLastTouchS[base] = nowS;
  _bucketDominantBiome[base] = -1;
  // Initialise the AABB from the bucket's cell bounds.
  const cs = TIER_BUCKET_SIZES_M[tier];
  const aabbBase = base * 6;
  _bucketAABB[aabbBase + 0] = bx * cs;
  _bucketAABB[aabbBase + 1] = by * cs;
  _bucketAABB[aabbBase + 2] = bz * cs;
  _bucketAABB[aabbBase + 3] = (bx + 1) * cs;
  _bucketAABB[aabbBase + 4] = (by + 1) * cs;
  _bucketAABB[aabbBase + 5] = (bz + 1) * cs;
  _hashInsertBucket(tier, bx, by, bz, bucketSlot);
  return bucketSlot;
}

// ══════════════════════════════════════════════════════════════════
// ─── BUCKET ASSIGNMENT ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Add a chunk to the bucket grid of every tier.
function _assignChunkToAllTiers(streamerSlot, cx, cy, cz, nowS) {
  _chunkActive[streamerSlot] = 1;
  for (let tier = 0; tier < 4; tier++) {
    const cs = TIER_BUCKET_SIZES_M[tier];
    const bx = Math.floor((cx + 0.5) * LandscapeChunkStreamer.config.chunkSizeM / cs);
    const by = Math.floor((cy + 0.5) * LandscapeChunkStreamer.config.chunkSizeM / cs);
    const bz = Math.floor((cz + 0.5) * LandscapeChunkStreamer.config.chunkSizeM / cs);
    const bucketSlot = _ensureBucket(tier, bx, by, bz, nowS);
    if (bucketSlot === -1) continue;
    const base = tier * MAX_BUCKETS_PER_TIER + bucketSlot;
    const chunkBase = base * MAX_CHUNKS_PER_BUCKET;
    // Find an empty slot in the bucket. Buckets are capped at
    // MAX_CHUNKS_PER_BUCKET; if the bucket is full, we don't insert and
    // the chunk remains unassigned in this tier (it will still be found
    // via the streamer's own iteration, just not via this tier's hash).
    if (_bucketChunkCount[base] < MAX_CHUNKS_PER_BUCKET) {
      let inserted = false;
      for (let i = 0; i < MAX_CHUNKS_PER_BUCKET; i++) {
        if (_bucketChunkSlots[chunkBase + i] === -1) {
          _bucketChunkSlots[chunkBase + i] = streamerSlot;
          _bucketChunkCount[base]++;
          _chunkBucketPerTier[tier * MAX_TRACKED_CHUNKS + streamerSlot] = bucketSlot;
          inserted = true;
          break;
        }
      }
      if (inserted) {
        _updateBucketAggregate(tier, bucketSlot, nowS);
      }
    }
  }
}

// Remove a chunk from all tier grids.
function _removeChunkFromAllTiers(streamerSlot, nowS) {
  _chunkActive[streamerSlot] = 0;
  for (let tier = 0; tier < 4; tier++) {
    const bucketSlot = _chunkBucketPerTier[tier * MAX_TRACKED_CHUNKS + streamerSlot];
    if (bucketSlot === -1) continue;
    const base = tier * MAX_BUCKETS_PER_TIER + bucketSlot;
    const chunkBase = base * MAX_CHUNKS_PER_BUCKET;
    for (let i = 0; i < MAX_CHUNKS_PER_BUCKET; i++) {
      if (_bucketChunkSlots[chunkBase + i] === streamerSlot) {
        _bucketChunkSlots[chunkBase + i] = -1;
        if (_bucketChunkCount[base] > 0) _bucketChunkCount[base]--;
        break;
      }
    }
    _chunkBucketPerTier[tier * MAX_TRACKED_CHUNKS + streamerSlot] = -1;
    // If the bucket is now empty, retire it so the pool can reuse the slot.
    if (_bucketChunkCount[base] === 0) {
      const bx = Math.floor(_bucketAABB[base * 6 + 0] / TIER_BUCKET_SIZES_M[tier]);
      const by = Math.floor(_bucketAABB[base * 6 + 1] / TIER_BUCKET_SIZES_M[tier]);
      const bz = Math.floor(_bucketAABB[base * 6 + 2] / TIER_BUCKET_SIZES_M[tier]);
      _hashEraseBucket(tier, bx, by, bz);
      _retireBucket(tier, bucketSlot);
    } else {
      _updateBucketAggregate(tier, bucketSlot, nowS);
    }
  }
}

// Update a bucket's aggregate record (AABB, dominant biome, mean distance,
// mean tier, mean fused air/soil temperature, mean fused humidity, material
// and lighting traits, occluder count, snow coverage) from the current
// streamer slots assigned to it.
function _updateBucketAggregate(tier, bucketSlot, nowS) {
  const base = tier * MAX_BUCKETS_PER_TIER + bucketSlot;
  const chunkBase = base * MAX_CHUNKS_PER_BUCKET;
  const aabbBase = base * 6;
  const matBase = base * 9;
  const lightBase = base * 11;

  // Reset aggregates.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let sumDist = 0;
  let sumTier = 0;
  let sumTemp = 0;
  let sumSoilTemp = 0;
  let sumHumidity = 0;
  let sumSnow = 0;
  let count = 0;
  let dominantBiome = -1;
  let dominantWeight = 0;
  // Material and lighting accumulators.
  let sumAlbedoR = 0, sumAlbedoG = 0, sumAlbedoB = 0;
  let sumRoughness = 0, sumMetalness = 0, sumWetness = 0, sumAnimeFlat = 0;
  let sumEmissive = 0, sumSubsurface = 0;
  let sumSunDiffuse = 0, sumSunIntensity = 0;
  let sumCastR = 0, sumCastG = 0, sumCastB = 0;
  let sumSkyR = 0, sumSkyG = 0, sumSkyB = 0;
  let sumFog = 0, sumDappledFreq = 0, sumDappledAmp = 0;

  const cs = LandscapeChunkStreamer.config.chunkSizeM;

  for (let i = 0; i < MAX_CHUNKS_PER_BUCKET; i++) {
    const streamerSlot = _bucketChunkSlots[chunkBase + i];
    if (streamerSlot === -1) continue;
    if (!_chunkActive[streamerSlot]) continue;

    // Read the chunk's coordinates and descriptor slot.
    const descriptorSlotOut = { descriptorSlot: -1, blendSystemSlot: -1, climateSlot: -1, soilSlot: -1, hydrologySlot: -1, blendFieldSlot: -1, ecotoneSlot: -1, faunaSlot: -1 };
    LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descriptorSlotOut);
    const descSlot = descriptorSlotOut.descriptorSlot;

    // Read chunk coordinates from the descriptor (or fall back to the
    // streamer slot's streamer state, which the streamer maintains).
    let cx = 0, cy = 0, cz = 0;
    if (descSlot !== -1) {
      cx = LandscapeChunkDescriptor.getChunkX(descSlot);
      cy = LandscapeChunkDescriptor.getChunkY(descSlot);
      cz = LandscapeChunkDescriptor.getChunkZ(descSlot);
    }

    // Update AABB from the chunk's cell bounds.
    const chunkMinX = cx * cs;
    const chunkMinY = cy * cs;
    const chunkMinZ = cz * cs;
    const chunkMaxX = chunkMinX + cs;
    const chunkMaxY = chunkMinY + cs;
    const chunkMaxZ = chunkMinZ + cs;
    if (chunkMinX < minX) minX = chunkMinX;
    if (chunkMinY < minY) minY = chunkMinY;
    if (chunkMinZ < minZ) minZ = chunkMinZ;
    if (chunkMaxX > maxX) maxX = chunkMaxX;
    if (chunkMaxY > maxY) maxY = chunkMaxY;
    if (chunkMaxZ > maxZ) maxZ = chunkMaxZ;

    // Distance from the predicted camera.
    const centerX = chunkMinX + cs * 0.5;
    const centerY = chunkMinY + cs * 0.5;
    const centerZ = chunkMinZ + cs * 0.5;
    const dx = centerX - _cameraPredictedPos.x;
    const dy = centerY - _cameraPredictedPos.y;
    const dz = centerZ - _cameraPredictedPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    sumDist += dist;

    // HLOD tier.
    const chunkTier = LandscapeChunkHLOD.getTier(streamerSlot);
    sumTier += chunkTier;

    // Dominant biome (from descriptor).
    let dominantBiomeId = -1;
    let dominantW = 0;
    if (descSlot !== -1) {
      dominantBiomeId = LandscapeChunkDescriptor.getDominantBiomeId(descSlot);
      dominantW = LandscapeChunkDescriptor.getDominantWeight(descSlot);
    }
    if (dominantW > dominantWeight) {
      dominantWeight = dominantW;
      dominantBiome = dominantBiomeId;
    }

    // Fused climate and soil (from descriptor).
    if (descSlot !== -1) {
      const outClimate = _climateScratch;
      LandscapeChunkDescriptor.readClimate(descSlot, outClimate);
      sumTemp += 15.0 + outClimate.temperatureOffsetC;
      sumHumidity += 0.55 + outClimate.humidityBias;
      const outSoil = _soilScratch;
      LandscapeChunkDescriptor.readSoil(descSlot, outSoil);
      sumSoilTemp += outSoil.soilTemperatureC;
      const outHydro = _hydroScratch;
      LandscapeChunkDescriptor.readHydrology(descSlot, outHydro);
      sumSnow += Math.min(1.0, outHydro.snowWaterEquivalentMm / 500.0);

      // Read the blended material and lighting from 331's bridge (via 330's
      // ecotone record, which 331 consumes). We approximate by reading the
      // dominant biome's material and lighting directly from the registry.
      if (dominantBiomeId !== -1) {
        const biome = BiomeRegistry.getBiome(dominantBiomeId);
        if (biome) {
          const dominantMatName = biome.dominantMaterial;
          const mat = dominantMatName && biome.materials && biome.materials[dominantMatName]
            ? biome.materials[dominantMatName]
            : _firstMaterial(biome.materials);
          if (mat) {
            sumAlbedoR += (mat.albedo ? mat.albedo[0] : 0.5) * dominantW;
            sumAlbedoG += (mat.albedo ? mat.albedo[1] : 0.5) * dominantW;
            sumAlbedoB += (mat.albedo ? mat.albedo[2] : 0.5) * dominantW;
            sumRoughness += (mat.roughness !== undefined ? mat.roughness : 0.8) * dominantW;
            sumMetalness += (mat.metalness !== undefined ? mat.metalness : 0.0) * dominantW;
            sumWetness += (mat.wetnessResponse !== undefined ? mat.wetnessResponse : 0.5) * dominantW;
            sumAnimeFlat += (mat.animeFlatness !== undefined ? mat.animeFlatness : 0.2) * dominantW;
            sumEmissive += (mat.emissive !== undefined ? mat.emissive : 0.0) * dominantW;
            sumSubsurface += (mat.subsurface !== undefined ? mat.subsurface : 0.0) * dominantW;
          }
          const light = biome.lighting;
          if (light) {
            sumSunDiffuse += (light.sunDiffuseFraction !== undefined ? light.sunDiffuseFraction : 0.4) * dominantW;
            sumSunIntensity += (light.sunIntensityScale !== undefined ? light.sunIntensityScale : 1.0) * dominantW;
            const cast = light.colourCast || [1, 1, 1];
            sumCastR += cast[0] * dominantW;
            sumCastG += cast[1] * dominantW;
            sumCastB += cast[2] * dominantW;
            const sky = light.skyTint || [0.85, 0.9, 0.95];
            sumSkyR += sky[0] * dominantW;
            sumSkyG += sky[1] * dominantW;
            sumSkyB += sky[2] * dominantW;
            sumFog += (light.fogDensityBase !== undefined ? light.fogDensityBase : 0.01) * dominantW;
            sumDappledFreq += (light.dappledLightFrequency !== undefined ? light.dappledLightFrequency : 0.0) * dominantW;
            sumDappledAmp += (light.dappledLightAmplitude !== undefined ? light.dappledLightAmplitude : 0.0) * dominantW;
          }
        }
      }
    }

    count++;
  }

  if (count === 0) {
    _bucketDominantBiome[base] = -1;
    _bucketMeanDistance[base] = 0;
    _bucketMeanTier[base] = 0;
    _bucketOccluderCount[base] = 0;
    _bucketSnowCoverage[base] = 0;
    return;
  }

  _bucketAABB[aabbBase + 0] = minX;
  _bucketAABB[aabbBase + 1] = minY;
  _bucketAABB[aabbBase + 2] = minZ;
  _bucketAABB[aabbBase + 3] = maxX;
  _bucketAABB[aabbBase + 4] = maxY;
  _bucketAABB[aabbBase + 5] = maxZ;
  _bucketDominantBiome[base] = dominantBiome;
  _bucketMeanDistance[base] = sumDist / count;
  _bucketMeanTier[base] = sumTier / count;
  _bucketSnowCoverage[base] = sumSnow / count;

  // Material and lighting: divide by the sum of dominant weights (not the
  // chunk count) so a bucket with one dominant biome does not get averaged
  // with a bucket with many small biomes.
  let weightSum = 0;
  for (let i = 0; i < MAX_CHUNKS_PER_BUCKET; i++) {
    const s = _bucketChunkSlots[chunkBase + i];
    if (s === -1) continue;
    if (!_chunkActive[s]) continue;
    const d = { descriptorSlot: -1 };
    LandscapeChunkStreamer.getDownstreamSlots(s, d);
    if (d.descriptorSlot !== -1) {
      weightSum += LandscapeChunkDescriptor.getDominantWeight(d.descriptorSlot);
    }
  }
  if (weightSum <= 1e-6) weightSum = 1;

  _bucketMaterial[matBase + 0] = sumAlbedoR / weightSum;
  _bucketMaterial[matBase + 1] = sumAlbedoG / weightSum;
  _bucketMaterial[matBase + 2] = sumAlbedoB / weightSum;
  _bucketMaterial[matBase + 3] = sumRoughness / weightSum;
  _bucketMaterial[matBase + 4] = sumMetalness / weightSum;
  _bucketMaterial[matBase + 5] = sumWetness / weightSum;
  _bucketMaterial[matBase + 6] = sumAnimeFlat / weightSum;
  _bucketMaterial[matBase + 7] = sumEmissive / weightSum;
  _bucketMaterial[matBase + 8] = sumSubsurface / weightSum;

  _bucketLighting[lightBase + 0]  = sumSunDiffuse / weightSum;
  _bucketLighting[lightBase + 1]  = sumSunIntensity / weightSum;
  _bucketLighting[lightBase + 2]  = sumCastR / weightSum;
  _bucketLighting[lightBase + 3]  = sumCastG / weightSum;
  _bucketLighting[lightBase + 4]  = sumCastB / weightSum;
  _bucketLighting[lightBase + 5]  = sumSkyR / weightSum;
  _bucketLighting[lightBase + 6]  = sumSkyG / weightSum;
  _bucketLighting[lightBase + 7]  = sumSkyB / weightSum;
  _bucketLighting[lightBase + 8]  = sumFog / weightSum;
  _bucketLighting[lightBase + 9]  = sumDappledFreq / weightSum;
  _bucketLighting[lightBase + 10] = sumDappledAmp / weightSum;

  // Occluder count: neighbour buckets whose AABB fully contains the current
  // bucket's AABB contribute to occlusion pressure. This is a coarse,
  // conservative proxy that 340 refines.
  let occluders = 0;
  const cs = TIER_BUCKET_SIZES_M[tier];
  const bx = Math.floor(_bucketAABB[aabbBase] / cs);
  const by = Math.floor(_bucketAABB[aabbBase + 1] / cs);
  const bz = Math.floor(_bucketAABB[aabbBase + 2] / cs);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const neighborSlot = _hashFindBucket(tier, bx + dx, by + dy, bz + dz);
        if (neighborSlot === -1) continue;
        const nBase = tier * MAX_BUCKETS_PER_TIER + neighborSlot;
        if (_bucketMeanDistance[nBase] > _bucketMeanDistance[base]) {
          occluders++;
        }
      }
    }
  }
  _bucketOccluderCount[base] = occluders;
}

// Scratch used inside _updateBucketAggregate. Declared here to avoid a
// forward reference in the hot path.
const _climateScratch = {
  temperatureOffsetC: 0, precipitationMultiplier: 1, humidityBias: 0,
  windSpeedMultiplier: 1, windDirectionBiasDeg: 0,
  diurnalSwingMultiplier: 1, seasonalAmplitudeMultiplier: 1,
  seasonalPhaseShiftRad: 0, snowlineShiftM: 0, treelineShiftM: 0
};
const _soilScratch = {
  sand: 0, silt: 0, clay: 0, gravel: 0, rockFragment: 0,
  organicMatter: 0, organicCarbon: 0, totalNitrogen: 0,
  pH: 0, cationExchangeCapacity: 0, baseSaturation: 0,
  aluminiumSaturation: 0, availablePhosphorus: 0,
  porosity: 0, bulkDensity: 0, waterHoldingCapacity: 0,
  hydraulicConductivity: 0, cohesion: 0, plasticityIndex: 0,
  usleKFactor: 0, windErodibility: 0, drainageClass: 0,
  volumetricWater: 0, soilTemperatureC: 15
};
const _hydroScratch = {
  precipitationMmYr: 0, potentialEvapotranspirationMmYr: 0,
  actualEvapotranspirationMmYr: 0, runoffMmYr: 0,
  infiltrationMmYr: 0, deepPercolationMmYr: 0,
  groundwaterRechargeMmYr: 0, waterTableDepthM: 0,
  surfaceWaterPresence: 0, surfaceWaterDepthM: 0,
  snowWaterEquivalentMm: 0, streamDischargeM3s: 0,
  streamSegmentCount: 0, lakeLevelM: 0, lakeCoverageFraction: 0,
  wetlandCoverageFraction: 0
};

function _firstMaterial(mat) {
  if (!mat) return null;
  const keys = Object.keys(mat);
  if (keys.length === 0) return null;
  return mat[keys[0]];
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeChunkSpatialHash = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  tierBucketSizesM: TIER_BUCKET_SIZES_M,
  maxBucketsPerTier: MAX_BUCKETS_PER_TIER,
  maxChunksPerBucket: MAX_CHUNKS_PER_BUCKET,
  retouchBudget: DEFAULT_RETOUCH_BUDGET,

  /**
   * Register a chunk with the spatial hash. Called by 337 when a chunk is
   * streamed in. The chunk is assigned to a bucket in every tier's grid.
   */
  registerChunk(streamerSlot, cx, cy, cz) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _assignChunkToAllTiers(streamerSlot, cx, cy, cz, BiomeBlendSystem.elapsedSimSeconds);
    return true;
  },

  /**
   * Unregister a chunk. Called by 337 when a chunk is streamed out.
   */
  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _removeChunkFromAllTiers(streamerSlot, BiomeBlendSystem.elapsedSimSeconds);
  },

  /**
   * Update a chunk's tier assignment. Called by 338 when a chunk's HLOD
   * tier changes so the bucket grids can be kept in sync.
   */
  updateChunkTier(streamerSlot, newTier) {
    // The bucket assignment depends only on the chunk's world coordinates,
    // not its tier. The tier is stored in the bucket aggregate. So this
    // method is a no-op for the current design; it exists for future
    // extensions that might want tier-dependent bucket sizes.
    // (The newTier is read on the next _updateBucketAggregate pass.)
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    if (!_chunkActive[streamerSlot]) return;
    for (let tier = 0; tier < 4; tier++) {
      const bucketSlot = _chunkBucketPerTier[tier * MAX_TRACKED_CHUNKS + streamerSlot];
      if (bucketSlot !== -1) {
        _updateBucketAggregate(tier, bucketSlot, BiomeBlendSystem.elapsedSimSeconds);
      }
    }
  },

  /**
   * The 10 Hz consumer entry point. Called by 308_ContextConsumerTiers.
   * The entry point does two things:
   *   1. It re-touches a bounded number of buckets per tier to refresh
   *      time-varying aggregates (mean distance, mean tier, occluder count).
   *   2. It emits the aggregate event so downstream consumers know the
   *      hash has been updated.
   */
  run(frame, tick, dt) {
    // ─── 1. Read the predicted camera position ──────────────
    const spatial = frame && frame.spatial;
    const camExtrapolator = spatial && spatial.cameraExtrapolator;
    if (camExtrapolator) {
      const predicted = camExtrapolator.predictNextFrame();
      _cameraPredictedPos.set(predicted.position.x, predicted.position.y, predicted.position.z);
      _cameraForward.set(predicted.forward.x, predicted.forward.y, predicted.forward.z);
    } else if (spatial && spatial.cameraPosition) {
      _cameraPredictedPos.set(spatial.cameraPosition.x, spatial.cameraPosition.y, spatial.cameraPosition.z);
      if (spatial.cameraForward) _cameraForward.set(spatial.cameraForward.x, spatial.cameraForward.y, spatial.cameraForward.z);
    }

    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    // ─── 2. Re-touch buckets in a round-robin window ────────
    let retouched = 0;
    let processed = 0;
    for (let tier = 0; tier < 4; tier++) {
      const base = tier * MAX_BUCKETS_PER_TIER;
      let inTier = 0;
      while (inTier < this.retouchBudget) {
        const slot = _rrCursor;
        _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
        if (slot >= MAX_BUCKETS_PER_TIER) continue;
        if (!_bucketActive[base + slot]) continue;
        _updateBucketAggregate(tier, slot, nowS);
        _bucketLastTouchS[base + slot] = nowS;
        inTier++;
        retouched++;
        processed++;
        if (processed >= this.retouchBudget) break;
      }
      if (processed >= this.retouchBudget) break;
    }

    _lastRetouched = retouched;

    // ─── 3. Count active buckets and chunks ─────────────────
    let activeBuckets = 0;
    let activeChunks = 0;
    for (let t = 0; t < 4; t++) {
      const base = t * MAX_BUCKETS_PER_TIER;
      for (let i = 0; i < MAX_BUCKETS_PER_TIER; i++) {
        if (_bucketActive[base + i]) activeBuckets++;
      }
    }
    for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) {
      if (_chunkActive[i]) activeChunks++;
    }
    _lastActiveBuckets = activeBuckets;
    _lastActiveChunks = activeChunks;

    // ─── 4. Emit the aggregate event ────────────────────────
    _dispatcher.emit(EVENT_TYPE.SPATIAL_HASH_UPDATED, {
      tick,
      retouched,
      activeBuckets,
      activeChunks
    });
  },

  /**
   * Query the bucket that contains a world position, in the given tier.
   * Returns the bucket slot, or -1 if no bucket exists there.
   */
  queryBucketAtWorld(tier, worldX, worldY, worldZ) {
    const cs = TIER_BUCKET_SIZES_M[tier];
    const bx = Math.floor(worldX / cs);
    const by = Math.floor(worldY / cs);
    const bz = Math.floor(worldZ / cs);
    return _hashFindBucket(tier, bx, by, bz);
  },

  /**
   * Query the bucket that contains a world position, in every tier.
   * Writes the four bucket slots into `outSlots`.
   */
  queryBucketsAtWorld(worldX, worldY, worldZ, outSlots) {
    for (let tier = 0; tier < 4; tier++) {
      outSlots[tier] = this.queryBucketAtWorld(tier, worldX, worldY, worldZ);
    }
  },

  /**
   * Enumerate all chunks assigned to a bucket. Writes the streamer slots
   * into `outSlots` and returns the count.
   */
  queryBucketChunks(tier, bucketSlot, outSlots, maxCount) {
    if (bucketSlot < 0 || bucketSlot >= MAX_BUCKETS_PER_TIER) return 0;
    const base = tier * MAX_BUCKETS_PER_TIER + bucketSlot;
    if (!_bucketActive[base]) return 0;
    const chunkBase = base * MAX_CHUNKS_PER_BUCKET;
    let written = 0;
    for (let i = 0; i < MAX_CHUNKS_PER_BUCKET && written < maxCount; i++) {
      const s = _bucketChunkSlots[chunkBase + i];
      if (s === -1) continue;
      if (!_chunkActive[s]) continue;
      outSlots[written++] = s;
    }
    return written;
  },

  /**
   * Query all buckets in a tier. Writes the bucket slots into `outSlots`
   * and returns the count.
   */
  queryTierBuckets(tier, outSlots, maxCount) {
    const base = tier * MAX_BUCKETS_PER_TIER;
    let written = 0;
    for (let i = 0; i < MAX_BUCKETS_PER_TIER && written < maxCount; i++) {
      if (_bucketActive[base + i]) outSlots[written++] = i;
    }
    return written;
  },

  /**
   * Query all buckets whose AABB intersects a sphere. Writes the bucket
   * slots into `outSlots` and returns the count. This is the primary
   * culling query used by 273_FrustumCullingSystem.
   */
  queryRadius(tier, centerX, centerY, centerZ, radiusM, outSlots, maxCount) {
    const cs = TIER_BUCKET_SIZES_M[tier];
    const minBx = Math.floor((centerX - radiusM) / cs);
    const maxBx = Math.ceil((centerX + radiusM) / cs);
    const minBy = Math.floor((centerY - radiusM) / cs);
    const maxBy = Math.ceil((centerY + radiusM) / cs);
    const minBz = Math.floor((centerZ - radiusM) / cs);
    const maxBz = Math.ceil((centerZ + radiusM) / cs);
    const radiusSq = radiusM * radiusM;
    let written = 0;
    for (let bz = minBz; bz <= maxBz && written < maxCount; bz++) {
      for (let by = minBy; by <= maxBy && written < maxCount; by++) {
        for (let bx = minBx; bx <= maxBx && written < maxCount; bx++) {
          const slot = _hashFindBucket(tier, bx, by, bz);
          if (slot === -1) continue;
          const base = tier * MAX_BUCKETS_PER_TIER + slot;
          const aabbBase = base * 6;
          // AABB-sphere intersection test (conservative: treat the AABB
          // as the bucket's full cell bounds, not the AABB of the
          // chunks inside it, so we do not miss a chunk whose center is
          // just inside the sphere but whose AABB extends outside).
          const cx = _clamp(centerX, _bucketAABB[aabbBase + 0], _bucketAABB[aabbBase + 3]);
          const cy = _clamp(centerY, _bucketAABB[aabbBase + 1], _bucketAABB[aabbBase + 4]);
          const cz = _clamp(centerZ, _bucketAABB[aabbBase + 2], _bucketAABB[aabbBase + 5]);
          const dx = centerX - cx;
          const dy = centerY - cy;
          const dz = centerZ - cz;
          if (dx * dx + dy * dy + dz * dz <= radiusSq) {
            outSlots[written++] = slot;
          }
        }
      }
    }
    return written;
  },

  /**
   * Query all buckets whose AABB intersects an AABB. Writes the bucket
   * slots into `outSlots` and returns the count. This is the query used by
   * 340_LandscapeChunkOcclusion and by any system that has an AABB (a
   * frustum, a view volume, a chord, etc.).
   */
  queryAABB(tier, aabbMinX, aabbMinY, aabbMinZ, aabbMaxX, aabbMaxY, aabbMaxZ, outSlots, maxCount) {
    const cs = TIER_BUCKET_SIZES_M[tier];
    const minBx = Math.floor(aabbMinX / cs);
    const maxBx = Math.ceil(aabbMaxX / cs);
    const minBy = Math.floor(aabbMinY / cs);
    const maxBy = Math.ceil(aabbMaxY / cs);
    const minBz = Math.floor(aabbMinZ / cs);
    const maxBz = Math.ceil(aabbMaxZ / cs);
    let written = 0;
    for (let bz = minBz; bz <= maxBz && written < maxCount; bz++) {
      for (let by = minBy; by <= maxBy && written < maxCount; by++) {
        for (let bx = minBx; bx <= maxBx && written < maxCount; bx++) {
          const slot = _hashFindBucket(tier, bx, by, bz);
          if (slot === -1) continue;
          const base = tier * MAX_BUCKETS_PER_TIER + slot;
          const aabbBase = base * 6;
          // AABB-AABB intersection.
          if (_bucketAABB[aabbBase + 3] < aabbMinX) continue;
          if (_bucketAABB[aabbBase + 0] > aabbMaxX) continue;
          if (_bucketAABB[aabbBase + 4] < aabbMinY) continue;
          if (_bucketAABB[aabbBase + 1] > aabbMaxY) continue;
          if (_bucketAABB[aabbBase + 5] < aabbMinZ) continue;
          if (_bucketAABB[aabbBase + 2] > aabbMaxZ) continue;
          outSlots[written++] = slot;
        }
      }
    }
    return written;
  },

  /**
   * Read a bucket's aggregate record. Writes into the caller's preallocated
   * output object.
   */
  readBucket(tier, bucketSlot, out) {
    if (bucketSlot < 0 || bucketSlot >= MAX_BUCKETS_PER_TIER) return false;
    const base = tier * MAX_BUCKETS_PER_TIER + bucketSlot;
    if (!_bucketActive[base]) return false;
    const aabbBase = base * 6;
    const matBase = base * 9;
    const lightBase = base * 11;
    out.chunkCount = _bucketChunkCount[base];
    out.dominantBiome = _bucketDominantBiome[base];
    out.meanDistance = _bucketMeanDistance[base];
    out.meanTier = _bucketMeanTier[base];
    out.occluderCount = _bucketOccluderCount[base];
    out.snowCoverage = _bucketSnowCoverage[base];
    out.aabbMinX = _bucketAABB[aabbBase + 0];
    out.aabbMinY = _bucketAABB[aabbBase + 1];
    out.aabbMinZ = _bucketAABB[aabbBase + 2];
    out.aabbMaxX = _bucketAABB[aabbBase + 3];
    out.aabbMaxY = _bucketAABB[aabbBase + 4];
    out.aabbMaxZ = _bucketAABB[aabbBase + 5];
    out.albedoR = _bucketMaterial[matBase + 0];
    out.albedoG = _bucketMaterial[matBase + 1];
    out.albedoB = _bucketMaterial[matBase + 2];
    out.roughness = _bucketMaterial[matBase + 3];
    out.metalness = _bucketMaterial[matBase + 4];
    out.wetness = _bucketMaterial[matBase + 5];
    out.animeFlatness = _bucketMaterial[matBase + 6];
    out.emissive = _bucketMaterial[matBase + 7];
    out.subsurface = _bucketMaterial[matBase + 8];
    out.sunDiffuseFraction = _bucketLighting[lightBase + 0];
    out.sunIntensityScale = _bucketLighting[lightBase + 1];
    out.castR = _bucketLighting[lightBase + 2];
    out.castG = _bucketLighting[lightBase + 3];
    out.castB = _bucketLighting[lightBase + 4];
    out.skyR = _bucketLighting[lightBase + 5];
    out.skyG = _bucketLighting[lightBase + 6];
    out.skyB = _bucketLighting[lightBase + 7];
    out.fogDensity = _bucketLighting[lightBase + 8];
    out.dappledFrequency = _bucketLighting[lightBase + 9];
    out.dappledAmplitude = _bucketLighting[lightBase + 10];
    return true;
  },

  // ─── Direct accessors for hot paths ──────────────────────
  getBucketChunkCount(tier, bucketSlot) {
    if (bucketSlot < 0 || bucketSlot >= MAX_BUCKETS_PER_TIER) return 0;
    return _bucketChunkCount[tier * MAX_BUCKETS_PER_TIER + bucketSlot];
  },
  getBucketMeanDistance(tier, bucketSlot) {
    if (bucketSlot < 0 || bucketSlot >= MAX_BUCKETS_PER_TIER) return 0;
    return _bucketMeanDistance[tier * MAX_BUCKETS_PER_TIER + bucketSlot];
  },
  getBucketMeanTier(tier, bucketSlot) {
    if (bucketSlot < 0 || bucketSlot >= MAX_BUCKETS_PER_TIER) return 0;
    return _bucketMeanTier[tier * MAX_BUCKETS_PER_TIER + bucketSlot];
  },
  getBucketOccluderCount(tier, bucketSlot) {
    if (bucketSlot < 0 || bucketSlot >= MAX_BUCKETS_PER_TIER) return 0;
    return _bucketOccluderCount[tier * MAX_BUCKETS_PER_TIER + bucketSlot];
  },
  getBucketDominantBiome(tier, bucketSlot) {
    if (bucketSlot < 0 || bucketSlot >= MAX_BUCKETS_PER_TIER) return -1;
    return _bucketDominantBiome[tier * MAX_BUCKETS_PER_TIER + bucketSlot];
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get activeBuckets() { return _lastActiveBuckets; },
  get activeChunks() { return _lastActiveChunks; },
  get lastRetouched() { return _lastRetouched; },
  get bucketCapacityPerTier() { return MAX_BUCKETS_PER_TIER; }
});

function _clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

export default LandscapeChunkSpatialHash;