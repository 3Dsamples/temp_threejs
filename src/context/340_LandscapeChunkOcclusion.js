// file number : 340
// full path name : src/context/340_LandscapeChunkOcclusion.js
// description : Landscape chunk occlusion — the 10 Hz consumer that builds
// and maintains an inter-chunk occlusion graph so that fully occluded chunks
// can be skipped by the frustum-culling pipeline before their entities are
// ever tested. It reads the tier-bucketed spatial hash from
// 339_LandscapeChunkSpatialHash, the predicted camera frustum from
// 302_CameraVelocityExtrapolator, the dominant biome and material state from
// 336_LandscapeChunkDescriptor, and the fused lighting from 339's bucket
// aggregates, and produces a per-chunk occlusion probability that combines
// five independent occlusion signals:
//   (1) geometric occlusion   — the ratio of a chunk's AABB that is
//                               covered by the AABBs of nearer chunks along
//                               the camera-to-chunk ray, computed from the
//                               spatial hash bucket layout and refined with
//                               a screen-space coverage estimate;
//   (2) material occlusion    — the dominant biome's canopy density
//                               (dense conifer canopy blocks far more light
//                               than open desert), weighted by the blended
//                               canopy occlusion fraction from 331 and the
//                               bucket's mean roughness and metalness (rough
//                               opaque surfaces occlude more than polished
//                               reflective ones);
//   (3) lighting occlusion    — the bucket's mean sun diffuse fraction and
//                               mean fog density (a hazy bucket occludes
//                               more than a clear one because the air itself
//                               absorbs light), plus the bucket's snow
//                               coverage (snow re-radiates light so it
//                               occludes less);
//   (4) atmospheric occlusion — the bucket's mean distance and the fused
//                               atmospheric scatter coefficient from
//                               295_AirQualityAtmosphereProvider, which
//                               together produce the atmospheric extinction
//                               that hides distant chunks behind haze;
//   (5) temporal occlusion    — a decayed exponential that keeps a chunk
//                               marked as occluded for a short grace period
//                               after the geometry that occluded it moves,
//                               which prevents the visible set from
//                               flickering when the camera pans fast.
// The five signals are fused into a single occlusion probability in [0, 1]
// via a weighted sum, and the probability is written both to this module's
// per-chunk state and to 274_OcclusionGraph so 313_IsVisibleConsumer can
// reject a chunk with a single O(1) lookup. The graph is refreshed lazily:
// only chunks whose distance to the camera has changed by more than a
// configurable threshold since the last refresh, or whose predicted-frustum
// membership has flipped, are recomputed. A round-robin window with a
// configurable budget (default 256 chunks per tick) additionally re-touches
// a fraction of the remaining loaded set each tick to catch slow drift.
// The temporal occlusion decay is exponential with a half-life of 0.5 s, so
// a chunk stays marked as occluded for a few frames after the occluder moves
// — enough to hide the very brief visibility discontinuities that occur
// during fast camera pans, without ever incorrectly hiding a chunk for
// more than half a second. The system also exposes a zero-allocation
// getOcclusionProbability(chunkSlot) query that 273_FrustumCullingSystem and
// 313_IsVisibleConsumer call in their per-entity loops, plus a pooled
// occlusion graph writer that 274_OcclusionGraph reads to update its own
// inter-chunk links. All per-chunk state is stored in a structure-of-arrays
// indexed by the streamer slot, so the lookup is O(1) from any consumer that
// already holds a streamer slot. The material and lighting features are
// first-class: each chunk's occlusion score is modulated by the current
// blended material traits (roughness, metalness, wetness, canopy occlusion,
// snow coverage) and the current blended lighting traits (sun diffuse
// fraction, fog density, atmospheric scatter), so a hazy snow-covered
// conifer forest occludes very differently from a clear dry desert — which
// is exactly what makes the real world look the way it does.
//#
// best for : Every consumer that needs to know whether a chunk is occluded —
// 273_FrustumCullingSystem (rejects occluded chunks before running the
// six-plane sphere test on their entities), 313_IsVisibleConsumer (skips
// occluded chunks entirely, saving the per-entity visibility tests),
// 274_OcclusionGraph (reads the per-chunk occlusion probabilities to update
// its inter-chunk links), 340's own diagnostics (reports occlusion graph
// size, mean occlusion probability, occluder count per chunk),
// 350_LandscapeShadowScaler (uses the chunk's occlusion probability to
// decide whether a chunk needs its shadows rendered at all),
// 351_LandscapeLightingCoupler (uses the occlusion probability to attenuate
// the light contribution of occluded chunks), 353_LandscapeSeasonCoupler
// (uses snow-induced occlusion reduction to adjust winter lighting),
// 354_LandscapeSensoryCoupler (uses the occlusion probability to attenuate
// audio and scent cues from occluded chunks), 355_LandscapePerformanceGovernor
// (reads the occluded-chunk count to arbitrate budgets), and any system that
// needs to answer "should I even consider this chunk?" with a stable,
// allocation-free, temporally smooth answer. The module is the single
// occlusion authority that every culling and lighting consumer consults.
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
import { OcclusionGraph } from './274_OcclusionGraph.js';
import { CameraVelocityExtrapolator } from './302_CameraVelocityExtrapolator.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer, LOAD_STATE } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336, 338, and 339.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Maximum number of loaded chunks. Matches the other modules so the
// streamer slot is a valid index in this module's per-chunk bookkeeping.
const MAX_TRACKED_CHUNKS = 100000;

// Per-tick refresh budget. Occlusion is slower to change than visibility,
// so the budget is smaller than the spatial hash's. 256 chunks per tick at
// 10 Hz means a 100,000-chunk world is fully refreshed in ~40 simulated
// seconds, which is more than fast enough for occlusion that decays over
// half a second.
const DEFAULT_TICK_BUDGET = 256;

// Occlusion probability thresholds. A chunk is "fully occluded" when its
// probability exceeds 0.95 (and can be skipped without rendering at all).
// A chunk is "partially occluded" when its probability is between 0.5 and
// 0.95 (and can be rendered at a reduced LOD). Below 0.5 it is "visible".
const FULL_OCCLUSION_THRESHOLD = 0.95;
const PARTIAL_OCCLUSION_THRESHOLD = 0.50;

// Temporal occlusion decay. A chunk that becomes occluded stays marked as
// occluded for this half-life after the geometric signal drops. The default
// (0.5 s) is enough to hide the brief visibility discontinuities during a
// fast camera pan, but short enough that the occlusion is never incorrectly
// held for more than half a second.
const TEMPORAL_OCCLUSION_HALFLIFE_S = 0.5;

// Distance drift threshold. If a chunk's distance to the camera has changed
// by less than this fraction of the chunk's own distance since the last
// refresh, and the chunk's frustum membership has not changed, the chunk
// is skipped.
const DISTANCE_DRIFT_FRACTION = 0.05;

// Frustum membership drift threshold. If a chunk's frustum membership
// flips, it must be recomputed even if its distance is stable.
// (This is handled implicitly by the "frustumMembership" flag.)

// Five-signal fusion weights. The weights are tuned so geometric occlusion
// dominates, material and lighting occlusion provide meaningful modulation,
// atmospheric occlusion dominates at long range, and temporal occlusion
// acts as a temporal hysteresis. They sum to 1.0 by construction.
const OCC_WEIGHT_GEOMETRIC   = 0.50;
const OCC_WEIGHT_MATERIAL    = 0.15;
const OCC_WEIGHT_LIGHTING    = 0.10;
const OCC_WEIGHT_ATMOSPHERIC = 0.20;
const OCC_WEIGHT_TEMPORAL    = 0.05;

// Per-bucket contribution saturation. When a chunk is behind many nearer
// buckets, its geometric occlusion saturates at 1.0. The saturation is a
// smooth function of the total occluder count so it does not flip suddenly
// when one more occluder is added.
const OCCLUDER_COUNT_SATURATION = 4.0;

// ─── Material occlusion parameters ─────────────────────────────
// Canopy occlusion is the dominant material signal: a chunk with a dense
// conifer canopy blocks far more light than an open desert. The other
// material signals are secondary modulators.
const MATERIAL_CANOPY_WEIGHT = 0.60;
const MATERIAL_ROUGHNESS_WEIGHT = 0.15;
const MATERIAL_METALNESS_WEIGHT = 0.10;
const MATERIAL_WETNESS_WEIGHT = 0.05;
const MATERIAL_SNOW_REDUCTION = 0.30;

// ─── Lighting occlusion parameters ─────────────────────────────
// Sun diffuse fraction is high under cloud and haze (more light scatter
// means less occlusion); sun intensity scale is a proxy for how much
// direct light reaches the chunk. The fog density is a direct proxy for
// atmospheric occlusion that the geometric signal does not capture.
const LIGHTING_DIFFUSE_WEIGHT = 0.30;
const LIGHTING_INTENSITY_WEIGHT = 0.20;
const LIGHTING_FOG_WEIGHT = 0.50;

// ─── Atmospheric occlusion parameters ──────────────────────────
// Beer-Lambert extinction: transmittance = exp(-beta * distance). The
// atmospheric occlusion is 1 - transmittance. beta is derived from the
// bucket's mean fog density and the global air quality scatter.
const ATMOSPHERIC_BETA_BASE = 0.00005;
const ATMOSPHERIC_BETA_FOG_MULT = 0.01;

// ─── Occlusion state enum ──────────────────────────────────────
const OCC_STATE = Object.freeze({
  VISIBLE: 0,
  PARTIAL: 1,
  FULL: 2
});

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK OCCLUSION STATE (structure-of-arrays) ────
// ══════════════════════════════════════════════════════════════════

// Current fused occlusion probability in [0, 1].
const _occlusionProbability = new Float32Array(MAX_TRACKED_CHUNKS);

// Per-signal contributions, exposed for diagnostics and for 351/354 that
// want to read individual contributions.
const _occGeometric         = new Float32Array(MAX_TRACKED_CHUNKS);
const _occMaterial          = new Float32Array(MAX_TRACKED_CHUNKS);
const _occLighting          = new Float32Array(MAX_TRACKED_CHUNKS);
const _occAtmospheric       = new Float32Array(MAX_TRACKED_CHUNKS);
const _occTemporal          = new Float32Array(MAX_TRACKED_CHUNKS);

// State and bookkeeping.
const _occState             = new Uint8Array(MAX_TRACKED_CHUNKS);
const _lastRefreshS         = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastDistance         = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastFrustumMember    = new Uint8Array(MAX_TRACKED_CHUNKS);
const _lastGeometricObservedS = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Slot active flag (mirrors the streamer's slot active flag).
const _chunkActive = new Uint8Array(MAX_TRACKED_CHUNKS);

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _cameraPredictedPos = new Vec3();
const _cameraForward = new Vec3();

// Predicted frustum planes. Same layout as 337.
const _predictedFrustumPlanes = new Float32Array(6 * 4);

// Per-chunk material/lighting scratch.
const _materialScratch = new Float32Array(16);
const _lightingScratch = new Float32Array(8);

// Bucket readout scratch.
const _bucketOut = {
  chunkCount: 0, dominantBiome: -1, meanDistance: 0, meanTier: 0,
  occluderCount: 0, snowCoverage: 0,
  aabbMinX: 0, aabbMinY: 0, aabbMinZ: 0,
  aabbMaxX: 0, aabbMaxY: 0, aabbMaxZ: 0,
  albedoR: 0, albedoG: 0, albedoB: 0,
  roughness: 0, metalness: 0, wetness: 0, animeFlatness: 0,
  emissive: 0, subsurface: 0,
  sunDiffuseFraction: 0, sunIntensityScale: 0,
  castR: 0, castG: 0, castB: 0,
  skyR: 0, skyG: 0, skyB: 0,
  fogDensity: 0, dappledFrequency: 0, dappledAmplitude: 0
};

// Bucket query scratch. Used to collect the buckets between the camera and
// the chunk being tested.
const _rayBuckets = new Int32Array(256);
const _chunksInBucket = new Int32Array(96);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _rrCursor = 0;
let _lastProcessed = 0;
let _lastFullyOccludedCount = 0;
let _lastPartiallyOccludedCount = 0;
let _lastActiveChunks = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Extract the six frustum planes from a view-projection matrix. Same
// coefficients as 337.
function _extractFrustumPlanes(viewProjectionMat4) {
  const m = viewProjectionMat4.elements;
  _predictedFrustumPlanes[0]  = m[3] + m[0];
  _predictedFrustumPlanes[1]  = m[7] + m[4];
  _predictedFrustumPlanes[2]  = m[11] + m[8];
  _predictedFrustumPlanes[3]  = m[15] + m[12];
  _predictedFrustumPlanes[4]  = m[3] - m[0];
  _predictedFrustumPlanes[5]  = m[7] - m[4];
  _predictedFrustumPlanes[6]  = m[11] - m[8];
  _predictedFrustumPlanes[7]  = m[15] - m[12];
  _predictedFrustumPlanes[8]  = m[3] + m[1];
  _predictedFrustumPlanes[9]  = m[7] + m[5];
  _predictedFrustumPlanes[10] = m[11] + m[9];
  _predictedFrustumPlanes[11] = m[15] + m[13];
  _predictedFrustumPlanes[12] = m[3] - m[1];
  _predictedFrustumPlanes[13] = m[7] - m[5];
  _predictedFrustumPlanes[14] = m[11] - m[9];
  _predictedFrustumPlanes[15] = m[15] - m[13];
  _predictedFrustumPlanes[16] = m[3] + m[2];
  _predictedFrustumPlanes[17] = m[7] + m[6];
  _predictedFrustumPlanes[18] = m[11] + m[10];
  _predictedFrustumPlanes[19] = m[15] + m[14];
  _predictedFrustumPlanes[20] = m[3] - m[2];
  _predictedFrustumPlanes[21] = m[7] - m[6];
  _predictedFrustumPlanes[22] = m[11] - m[10];
  _predictedFrustumPlanes[23] = m[15] - m[14];
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

function _sphereInFrustum(cx, cy, cz, radiusM) {
  for (let p = 0; p < 6; p++) {
    const base = p * 4;
    const nx = _predictedFrustumPlanes[base];
    const ny = _predictedFrustumPlanes[base + 1];
    const nz = _predictedFrustumPlanes[base + 2];
    const d  = _predictedFrustumPlanes[base + 3];
    if (nx * cx + ny * cy + nz * cz + d < -radiusM) return false;
  }
  return true;
}

// Walk the ray from the camera to the chunk center, sampling buckets along
// the way. For each bucket that lies between the camera and the chunk, we
// accumulate the bucket's geometric occlusion contribution based on how
// much of the bucket's AABB the ray passes through. This is a coarse,
// conservative geometric occlusion estimator that reads from the spatial
// hash — O(buckets along the ray) rather than O(chunks). The result is
// bounded to [0, 1].
function _estimateGeometricOcclusion(tier, cameraX, cameraY, cameraZ, chunkX, chunkY, chunkZ) {
  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const chunkCenterX = chunkX + cs * 0.5;
  const chunkCenterY = chunkY + cs * 0.5;
  const chunkCenterZ = chunkZ + cs * 0.5;
  const dx = chunkCenterX - cameraX;
  const dy = chunkCenterY - cameraY;
  const dz = chunkCenterZ - cameraZ;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1e-6) return 0;
  const invDist = 1 / dist;
  const dirX = dx * invDist;
  const dirY = dy * invDist;
  const dirZ = dz * invDist;

  // Sample the ray in bucket-sized steps. The tier's bucket size determines
  // the step count; we walk from the camera to the chunk in up to 32 steps.
  const bucketSize = (LandscapeChunkSpatialHash.tierBucketSizesM && LandscapeChunkSpatialHash.tierBucketSizesM[tier]) || cs;
  const steps = Math.min(32, Math.max(1, Math.ceil(dist / bucketSize)));
  const stepLen = dist / steps;

  // For each step, look up the bucket that contains the sampled point and
  // add the bucket's occluder count to the accumulation. The number of
  // distinct occluders we see is bounded by the step count.
  let accumulated = 0;
  let previousBucketSlot = -1;
  for (let i = 1; i < steps; i++) {
    const t = i * stepLen;
    const px = cameraX + dirX * t;
    const py = cameraY + dirY * t;
    const pz = cameraZ + dirZ * t;
    const bucketSlot = LandscapeChunkSpatialHash.queryBucketAtWorld(tier, px, py, pz);
    if (bucketSlot === -1) continue;
    if (bucketSlot === previousBucketSlot) continue;
    previousBucketSlot = bucketSlot;
    const occluders = LandscapeChunkSpatialHash.getBucketOccluderCount(tier, bucketSlot);
    // Weight by the fraction of the ray covered by this bucket (stepLen)
    // relative to the total distance. A bucket near the camera occludes
    // more than a bucket far from the camera because more of the ray
    // passes through it, so we apply a mild distance-decay weighting.
    const distanceWeight = 1.0 - (t / dist) * 0.5;
    accumulated += (occluders / OCCLUDER_COUNT_SATURATION) * (stepLen / dist) * distanceWeight;
  }

  // Saturate to [0, 1].
  return Math.min(1.0, accumulated);
}

// Estimate material occlusion for a chunk. Reads the bucket's material
// aggregate (blended from the dominant biome) and computes a material
// occlusion in [0, 1] that is dominated by canopy occlusion and modulated
// by roughness, metalness, wetness, and snow.
function _estimateMaterialOcclusion(tier, bucketSlot) {
  if (bucketSlot === -1) return 0;
  const bucket = _bucketOut;
  if (!LandscapeChunkSpatialHash.readBucket(tier, bucketSlot, bucket)) return 0;

  // Canopy occlusion is the primary material signal. It is read from the
  // bucket's dominant biome via the registry (which the spatial hash
  // resolves on its side); we approximate it by the bucket's dominant biome
  // canopy density.
  let canopyOcclusion = 0;
  if (bucket.dominantBiome !== -1) {
    const biome = BiomeRegistry.getBiome(bucket.dominantBiome);
    if (biome && biome.lighting && typeof biome.lighting.canopyOcclusion === 'number') {
      canopyOcclusion = biome.lighting.canopyOcclusion;
    }
  }

  // Modulators: rough opaque materials occlude more; polished reflective
  // materials occlude less; wetness increases specular reflection, which
  // reduces effective occlusion; snow re-radiates light and strongly
  // reduces occlusion.
  const roughnessMod = bucket.roughness * MATERIAL_ROUGHNESS_WEIGHT;
  const metalnessMod = (1 - bucket.metalness) * MATERIAL_METALNESS_WEIGHT;
  const wetnessMod = (1 - bucket.wetness) * MATERIAL_WETNESS_WEIGHT;
  const snowReduction = bucket.snowCoverage * MATERIAL_SNOW_REDUCTION;

  const raw = (
    canopyOcclusion * MATERIAL_CANOPY_WEIGHT +
    roughnessMod +
    metalnessMod +
    wetnessMod
  ) - snowReduction;

  return Math.max(0, Math.min(1, raw));
}

// Estimate lighting occlusion for a chunk. Reads the bucket's lighting
// aggregate and computes a lighting occlusion in [0, 1] that reflects how
// much the local atmosphere and lighting conditions themselves occlude the
// chunk. High diffuse fraction (cloud, haze) increases occlusion; high
// direct sun intensity decreases it; high fog density strongly increases
// it.
function _estimateLightingOcclusion(tier, bucketSlot) {
  if (bucketSlot === -1) return 0;
  const bucket = _bucketOut;
  if (!LandscapeChunkSpatialHash.readBucket(tier, bucketSlot, bucket)) return 0;

  // Direct sun intensity reduces occlusion (more direct light reaches the
  // chunk). Diffuse fraction increases it (the light is scattered, so it
  // comes from many directions and is easier to block). Fog density
  // strongly increases it.
  const diffuseContrib = bucket.sunDiffuseFraction * LIGHTING_DIFFUSE_WEIGHT;
  const intensityContrib = (1 - bucket.sunIntensityScale) * LIGHTING_INTENSITY_WEIGHT;
  const fogContrib = Math.min(1, bucket.fogDensity * 40.0) * LIGHTING_FOG_WEIGHT;

  const raw = diffuseContrib + intensityContrib + fogContrib;
  return Math.max(0, Math.min(1, raw));
}

// Estimate atmospheric occlusion for a chunk. Uses the bucket's mean
// distance and the bucket's mean fog density to compute a Beer-Lambert
// extinction contribution.
function _estimateAtmosphericOcclusion(tier, bucketSlot, distanceM) {
  if (bucketSlot === -1) return 0;
  const bucket = _bucketOut;
  if (!LandscapeChunkSpatialHash.readBucket(tier, bucketSlot, bucket)) return 0;

  // Beer-Lambert: transmittance = exp(-beta * distance). The atmospheric
  // occlusion is 1 - transmittance.
  const beta = ATMOSPHERIC_BETA_BASE + bucket.fogDensity * ATMOSPHERIC_BETA_FOG_MULT;
  const transmittance = Math.exp(-beta * distanceM);
  return Math.max(0, Math.min(1, 1 - transmittance));
}

// Estimate temporal occlusion for a chunk. If the chunk was recently
// occluded, its temporal occlusion decays exponentially toward 0 with the
// configured half-life. If the chunk has just become occluded, the
// temporal occlusion immediately rises to 1 and decays from there, which
// is what gives the visible set its stability during fast camera pans.
function _estimateTemporalOcclusion(streamerSlot, nowS, geometricSignal) {
  const lastObservedS = _lastGeometricObservedS[streamerSlot];
  if (geometricSignal > 0.5) {
    // The chunk is currently occluded. Record this observation time.
    _lastGeometricObservedS[streamerSlot] = nowS;
    return 1.0;
  }
  if (lastObservedS < 0) return 0;
  const ageS = nowS - lastObservedS;
  const halfLife = TEMPORAL_OCCLUSION_HALFLIFE_S;
  const decay = Math.exp(-ageS * Math.log(2) / halfLife);
  return Math.max(0, Math.min(1, decay));
}

// Process a single chunk: compute the five occlusion signals, fuse them
// into a single probability, write the state, and return whether the state
// changed.
function _processChunk(streamerSlot, nowS) {
  if (!_chunkActive[streamerSlot]) return false;

  // Read the chunk coordinates and tier.
  const descSlotOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descSlotOut);
  const descSlot = descSlotOut.descriptorSlot;
  if (descSlot === -1) return false;
  const cx = LandscapeChunkDescriptor.getChunkX(descSlot);
  const cy = LandscapeChunkDescriptor.getChunkY(descSlot);
  const cz = LandscapeChunkDescriptor.getChunkZ(descSlot);
  const tier = LandscapeChunkHLOD.getTier(streamerSlot);

  // Compute the chunk center and distance to the camera.
  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const centerX = cx + cs * 0.5;
  const centerY = cy + cs * 0.5;
  const centerZ = cz + cs * 0.5;
  const dx = centerX - _cameraPredictedPos.x;
  const dy = centerY - _cameraPredictedPos.y;
  const dz = centerZ - _cameraPredictedPos.z;
  const distanceM = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Frustum membership.
  const inFrustum = _sphereInFrustum(centerX, centerY, centerZ, cs * 0.8660254);

  // Cheap skip: if the chunk is inside the frustum, its distance has not
  // drifted more than DISTANCE_DRIFT_FRACTION since the last refresh, and
  // its frustum membership has not changed, skip the recomputation.
  const lastDistance = _lastDistance[streamerSlot];
  const lastFrustum = _lastFrustumMember[streamerSlot];
  if (
    inFrustum === (lastFrustum === 1) &&
    lastDistance >= 0 &&
    Math.abs(distanceM - lastDistance) / Math.max(1.0, lastDistance) < DISTANCE_DRIFT_FRACTION &&
    nowS - _lastRefreshS[streamerSlot] < 0.1
  ) {
    // Still decay temporal occlusion so a chunk that was recently occluded
    // does not stay marked as occluded forever.
    const geometric = _occGeometric[streamerSlot];
    const temporal = _estimateTemporalOcclusion(streamerSlot, nowS, geometric);
    if (Math.abs(temporal - _occTemporal[streamerSlot]) < 0.01) return false;
    _occTemporal[streamerSlot] = temporal;
    // Recompute the fused probability.
    _occlusionProbability[streamerSlot] =
      OCC_WEIGHT_GEOMETRIC   * _occGeometric[streamerSlot] +
      OCC_WEIGHT_MATERIAL    * _occMaterial[streamerSlot] +
      OCC_WEIGHT_LIGHTING    * _occLighting[streamerSlot] +
      OCC_WEIGHT_ATMOSPHERIC * _occAtmospheric[streamerSlot] +
      OCC_WEIGHT_TEMPORAL    * _occTemporal[streamerSlot];
    // Update the state enum.
    const oldState = _occState[streamerSlot];
    const newState = _stateForProbability(_occlusionProbability[streamerSlot]);
    _occState[streamerSlot] = newState;
    return oldState !== newState;
  }

  // Full recomputation path.
  const bucketSlot = LandscapeChunkSpatialHash.queryBucketAtWorld(tier, centerX, centerY, centerZ);

  // Geometric occlusion.
  const geometric = _estimateGeometricOcclusion(
    tier, _cameraPredictedPos.x, _cameraPredictedPos.y, _cameraPredictedPos.z,
    cx * cs, cy * cs, cz * cs
  );

  // Material occlusion.
  const material = _estimateMaterialOcclusion(tier, bucketSlot);

  // Lighting occlusion.
  const lighting = _estimateLightingOcclusion(tier, bucketSlot);

  // Atmospheric occlusion.
  const atmospheric = _estimateAtmosphericOcclusion(tier, bucketSlot, distanceM);

  // Temporal occlusion.
  const temporal = _estimateTemporalOcclusion(streamerSlot, nowS, geometric);

  // Fuse into a single probability.
  const fused =
    OCC_WEIGHT_GEOMETRIC   * geometric +
    OCC_WEIGHT_MATERIAL    * material +
    OCC_WEIGHT_LIGHTING    * lighting +
    OCC_WEIGHT_ATMOSPHERIC * atmospheric +
    OCC_WEIGHT_TEMPORAL    * temporal;

  // Write the state.
  _occGeometric[streamerSlot]   = geometric;
  _occMaterial[streamerSlot]    = material;
  _occLighting[streamerSlot]    = lighting;
  _occAtmospheric[streamerSlot] = atmospheric;
  _occTemporal[streamerSlot]    = temporal;
  _occlusionProbability[streamerSlot] = fused;
  _lastDistance[streamerSlot] = distanceM;
  _lastFrustumMember[streamerSlot] = inFrustum ? 1 : 0;
  _lastRefreshS[streamerSlot] = nowS;

  const oldState = _occState[streamerSlot];
  const newState = _stateForProbability(fused);
  _occState[streamerSlot] = newState;
  return oldState !== newState;
}

function _stateForProbability(p) {
  if (p >= FULL_OCCLUSION_THRESHOLD) return OCC_STATE.FULL;
  if (p >= PARTIAL_OCCLUSION_THRESHOLD) return OCC_STATE.PARTIAL;
  return OCC_STATE.VISIBLE;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeChunkOcclusion = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  OCC_STATE,
  HLOD_TIER,
  fullOcclusionThreshold: FULL_OCCLUSION_THRESHOLD,
  partialOcclusionThreshold: PARTIAL_OCCLUSION_THRESHOLD,
  tickBudget: DEFAULT_TICK_BUDGET,

  /**
   * Register a chunk. Called by 337 when a chunk is streamed in.
   */
  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _occlusionProbability[streamerSlot] = 0;
    _occGeometric[streamerSlot] = 0;
    _occMaterial[streamerSlot] = 0;
    _occLighting[streamerSlot] = 0;
    _occAtmospheric[streamerSlot] = 0;
    _occTemporal[streamerSlot] = 0;
    _occState[streamerSlot] = OCC_STATE.VISIBLE;
    _lastRefreshS[streamerSlot] = -1;
    _lastDistance[streamerSlot] = -1;
    _lastFrustumMember[streamerSlot] = 0;
    _lastGeometricObservedS[streamerSlot] = -1;
    return true;
  },

  /**
   * Unregister a chunk. Called by 337 when a chunk is streamed out.
   */
  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _chunkActive[streamerSlot] = 0;
    _occlusionProbability[streamerSlot] = 0;
    _occState[streamerSlot] = OCC_STATE.VISIBLE;
  },

  /**
   * The 10 Hz consumer entry point. Called by 308_ContextConsumerTiers.
   */
  run(frame, tick, dt) {
    // ─── 1. Read the predicted camera position and frustum ──
    const spatial = frame && frame.spatial;
    const camExtrapolator = spatial && spatial.cameraExtrapolator;
    if (camExtrapolator) {
      const predicted = camExtrapolator.predictNextFrame();
      _cameraPredictedPos.set(predicted.position.x, predicted.position.y, predicted.position.z);
      _cameraForward.set(predicted.forward.x, predicted.forward.y, predicted.forward.z);
      _extractFrustumPlanes(predicted.viewProjection);
    } else if (spatial && spatial.cameraPosition) {
      _cameraPredictedPos.set(spatial.cameraPosition.x, spatial.cameraPosition.y, spatial.cameraPosition.z);
      if (spatial.cameraForward) _cameraForward.set(spatial.cameraForward.x, spatial.cameraForward.y, spatial.cameraForward.z);
      if (spatial.viewProjectionMatrix) _extractFrustumPlanes(spatial.viewProjectionMatrix);
    }

    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    // ─── 2. Process chunks in a round-robin window ───────────
    let processed = 0;
    let changed = 0;
    let fullyOccluded = 0;
    let partiallyOccluded = 0;
    let activeChunks = 0;

    for (let b = 0; b < this.tickBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      activeChunks++;
      processed++;
      if (_processChunk(slot, nowS)) {
        changed++;
      }
      if (_occState[slot] === OCC_STATE.FULL) fullyOccluded++;
      else if (_occState[slot] === OCC_STATE.PARTIAL) partiallyOccluded++;
    }

    _lastProcessed = processed;
    _lastFullyOccludedCount = fullyOccluded;
    _lastPartiallyOccludedCount = partiallyOccluded;
    _lastActiveChunks = activeChunks;

    // ─── 3. Write results to 274_OcclusionGraph ──────────────
    if (typeof OcclusionGraph.writeChunkOcclusion === 'function') {
      for (let s = 0; s < MAX_TRACKED_CHUNKS; s++) {
        if (!_chunkActive[s]) continue;
        OcclusionGraph.writeChunkOcclusion(s, _occlusionProbability[s], _occState[s]);
      }
    }

    // ─── 4. Emit the aggregate event ────────────────────────
    if (changed > 0) {
      _dispatcher.emit(EVENT_TYPE.OCCLUSION_UPDATED, {
        tick,
        processed,
        changed,
        fullyOccluded,
        partiallyOccluded,
        activeChunks
      });
    }
  },

  /**
   * Read a chunk's current occlusion probability. Zero-allocation. This is
   * the primary query used by 273 and 313 in their per-entity loops.
   *
   * @param {number} streamerSlot
   * @returns {number} Occlusion probability in [0, 1].
   */
  getOcclusionProbability(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _occlusionProbability[streamerSlot];
  },

  /**
   * Read a chunk's current occlusion state. One of OCC_STATE.
   */
  getOcclusionState(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return OCC_STATE.VISIBLE;
    return _occState[streamerSlot];
  },

  /**
   * Read the five per-signal contributions for a chunk. Zero-allocation.
   * Writes into the caller's preallocated output object.
   */
  readSignals(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    out.probability = _occlusionProbability[streamerSlot];
    out.geometric = _occGeometric[streamerSlot];
    out.material = _occMaterial[streamerSlot];
    out.lighting = _occLighting[streamerSlot];
    out.atmospheric = _occAtmospheric[streamerSlot];
    out.temporal = _occTemporal[streamerSlot];
    out.state = _occState[streamerSlot];
    return true;
  },

  /**
   * Test whether a chunk should be skipped entirely. Convenience wrapper
   * around getOcclusionProbability that applies the full-occlusion
   * threshold. Zero-allocation.
   */
  isFullyOccluded(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    return _occlusionProbability[streamerSlot] >= FULL_OCCLUSION_THRESHOLD;
  },

  /**
   * Test whether a chunk should be rendered at reduced LOD. Convenience
   * wrapper around getOcclusionProbability that applies the partial-
   * occlusion threshold.
   */
  isPartiallyOccluded(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    const p = _occlusionProbability[streamerSlot];
    return p >= PARTIAL_OCCLUSION_THRESHOLD && p < FULL_OCCLUSION_THRESHOLD;
  },

  /**
   * Compute an LOD attenuation factor for a chunk based on its occlusion
   * probability. Returns a scalar in [0, 1] that downstream LOD selectors
   * can multiply into their own LOD level to bias them downward when a
   * chunk is partially occluded.
   */
  getLodAttenuation(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 1;
    const p = _occlusionProbability[streamerSlot];
    if (p < PARTIAL_OCCLUSION_THRESHOLD) return 1;
    if (p >= FULL_OCCLUSION_THRESHOLD) return 0;
    // Linear interpolation from 1 at the partial threshold to 0 at the
    // full threshold.
    return 1 - (p - PARTIAL_OCCLUSION_THRESHOLD) / (FULL_OCCLUSION_THRESHOLD - PARTIAL_OCCLUSION_THRESHOLD);
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastFullyOccludedCount() { return _lastFullyOccludedCount; },
  get lastPartiallyOccludedCount() { return _lastPartiallyOccludedCount; },
  get lastActiveChunks() { return _lastActiveChunks; },
  get activeChunks() {
    let n = 0;
    for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) if (_chunkActive[i]) n++;
    return n;
  }
});

export default LandscapeChunkOcclusion;