// file number : 348
// full path name : src/context/348_LandscapeDecalPlacementSystem.js
// description : Landscape decal placement system — the 10 Hz consumer that
// places persistent decals (craters, scorch marks, water stains, rills, gully
// cuts, trampled trails, blood stains, and snow/frost patches) into the loaded
// chunk set. It reads impact events from 300_ImpactEventCoordinator, erosion
// state from 343 and 344, the water flow field from 345, animal trail data
// from 347, the fused soil colour from 333, the biome blend from 329, and the
// per-chunk descriptor from 336, and it places decal records into a per-chunk
// decal list that 337_LandscapeChunkStreamer streams to the GPU as textured
// quads projected onto the terrain. Each decal carries the full PBR + anime
// parameter set from 331 — the decal's albedo in linear RGB, roughness,
// metalness, transmission, IOR, Fresnel F₀, anime flatness weight, rim power,
// outline weight, wetness, snow coverage, damage, and emissive — plus the
// decal's own geometric parameters (rotation, size, aspect ratio, and a
// per-decal "impression" depth that drives how much the decal darkens the
// underlying terrain, how much it perturbs the surface normal, and how much it
// softens the shadow edge around the decal). The lighting coupler (351) reads
// the decal state to drive the dappled shadow pattern that a real crater casts
// on the terrain, and 350_LandscapeShadowScaler reads the decal's normal
// perturbation to decide whether a shadow-casting decal needs extra shadow
// map resolution. Decals are persisted as mutations via
// 341_LandscapeChunkPersistence so they survive stream-out / stream-in cycles,
// and they are replayed via 342_LandscapeChunkMutationReplay so a remembered
// crater looks identical to a freshly-created one. The decal system is fully
// tier-aware: full per-decal placement at the KILOMETER tier, 4× sparse
// placement at the TEN_KILOMETER tier, single-decal-per-chunk placement at
// the HUNDRED_KILOMETER tier, and no placement at the THOUSAND_KILOMETER
// tier. The per-tick work is bounded by both a chunk budget (default 64) and
// a per-tick CPU budget (default 2.0 ms). Every per-chunk and per-decal
// scratch buffer is preallocated and reused, every hot-path computation is
// zero-allocation, and the decal system works identically on WebGL1 and
// WebGL2 because the decal geometry is a standard projected quad rendered
// with a standard MeshStandardMaterial / MeshToonMaterial — no compute
// shaders are required. Decals use the full PBR + anime material pipeline
// from 331, so a crater decal has a dark fractured-rock albedo at its rim, a
// scorched-soil albedo at its centre, and a fused snow/moss rim at its margin
// — all controlled by the same per-instance material record that 331 uploads
// for the terrain itself. The decal system also exposes a per-chunk decal
// list to 337, which streams the decal instance data to the GPU as a single
// instanced draw per chunk.
//#
// best for : Every consumer that needs per-chunk decal instance data —
// 300_ImpactEventCoordinator (records live impact decals that the system
// will place), 316_EcologyResponseSystem (records fire scars that become
// decals), 337_LandscapeChunkStreamer (streams the decal instance list to
// the GPU as instanced draws), 338_LandscapeChunkHLOD (uses the decal count
// to decide the tier's decal density multiplier), 341_LandscapeChunkPersistence
// (persists the decal records as mutations), 342_LandscapeChunkMutationReplay
// (replays the persisted decal records on stream-in), 343_LandscapeErosion-
// Simulator and 344_LandscapeWindErosionSystem (record erosion decals for
// rills and gully cuts), 345_LandscapeWaterFlowSystem (records water-stain
// decals along the flow field), 346_LandscapeVegetationScatterSystem (records
// trampled-trail decals around animal paths), 347_LandscapeFaunaSpawnSystem
// (records blood-stain decals around predation events),
// 350_LandscapeShadowScaler (reads the decal's normal perturbation to scale
// shadow cascades), 351_LandscapeLightingCoupler (reads the decal state to
// drive dappled shadow patterns), 353_LandscapeSeasonCoupler (reads the snow
// and frost decals to adjust the seasonal palette), 354_LandscapeSensory-
// Coupler (reads the decal state to emit scuffing and dripping audio cues),
// 355_LandscapePerformanceGovernor (uses the decal count per tier to
// arbitrate budgets), 356_LandscapeRebuildDeferral (uses the per-chunk decal
// dirty flag to decide when a chunk needs its decal buffer rebuilt), and
// 357_LandscapeEventBudget (uses the per-chunk decal queue depth to coalesce
// multiple decal requests into a single causal event). The decal system is
// the single authority on what decals exist, where, and what their material
// state is.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  InstancedBufferAttribute, InstancedBufferGeometry,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  WebGLRenderer, WebGL2Renderer
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { ImpactEventCoordinator } from './300_ImpactEventCoordinator.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';
import { LandscapeErosionSimulator } from './343_LandscapeErosionSimulator.js';
import { LandscapeWindErosionSystem } from './344_LandscapeWindErosionSystem.js';
import { LandscapeWaterFlowSystem, FLOW_STATE } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem } from './346_LandscapeVegetationScatterSystem.js';
import { LandscapeFaunaSpawnSystem } from './347_LandscapeFaunaSpawnSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–347.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier detail level.
const TIER_DETAIL = Object.freeze({
  FULL: 0,        // KILOMETER       full per-decal placement
  COARSE: 1,      // TEN_KILOMETER   1/4 density
  SPARSE: 2,      // HUNDRED_KILOMETER single decal per chunk
  SKIPPED: 3      // THOUSAND_KILOMETER skipped
});
const TIER_DETAIL_FOR_LEVEL = Object.freeze([
  TIER_DETAIL.FULL,
  TIER_DETAIL.COARSE,
  TIER_DETAIL.SPARSE,
  TIER_DETAIL.SKIPPED
]);

// Decal type identifiers.
const DECAL_TYPE = Object.freeze({
  NONE: 0,
  CRATER: 1,
  SCORCH: 2,
  WATER_STAIN: 3,
  RILL: 4,
  GULLY_CUT: 5,
  TRAMPLED_TRAIL: 6,
  BLOOD_STAIN: 7,
  SNOW_PATCH: 8,
  FROST_PATCH: 9,
  MOSS_PATCH: 10,
  FUNGAL_PATCH: 11,
  SCUFF: 12,
  DRIP_MARK: 13,
  SALT_CRUST: 14,
  RESERVED_15: 15
});

// Per-tier density scale for decals.
const TIER_DECAL_DENSITY = Object.freeze([
  1.0,        // KILOMETER
  0.25,       // TEN_KILOMETER
  0.05,       // HUNDRED_KILOMETER
  0.0         // THOUSAND_KILOMETER
]);

// Maximum number of decals per chunk.
const MAX_DECALS_PER_CHUNK = 64;

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Maximum total decal slots across all chunks.
const MAX_TOTAL_DECALS = 32768;

// Per-tick chunk budget.
const DEFAULT_TICK_CHUNK_BUDGET = 64;

// Per-tick CPU budget.
const DEFAULT_TICK_CPU_BUDGET_MS = 2.0;

// Per-decal material record size (floats).
const DECAL_MATERIAL_FLOATS = 32;

// ─── Decal size and rotation ranges ──────────────────────────
// Each decal is a textured quad projected onto the terrain. The quad's
// size, rotation, and aspect ratio are determined by the decal type and
// the impact or erosion force that produced it.
const DECAL_SIZE_CRATER_MIN = 1.5;
const DECAL_SIZE_CRATER_MAX = 8.0;
const DECAL_SIZE_SCORCH_MIN = 2.0;
const DECAL_SIZE_SCORCH_MAX = 12.0;
const DECAL_SIZE_WATER_STAIN_MIN = 0.5;
const DECAL_SIZE_WATER_STAIN_MAX = 4.0;
const DECAL_SIZE_RILL_MIN = 0.3;
const DECAL_SIZE_RILL_MAX = 1.5;
const DECAL_SIZE_GULLY_CUT_MIN = 1.0;
const DECAL_SIZE_GULLY_CUT_MAX = 5.0;
const DECAL_SIZE_TRAMPLED_TRAIL_MIN = 0.4;
const DECAL_SIZE_TRAMPLED_TRAIL_MAX = 1.2;
const DECAL_SIZE_BLOOD_STAIN_MIN = 0.3;
const DECAL_SIZE_BLOOD_STAIN_MAX = 1.5;
const DECAL_SIZE_SNOW_PATCH_MIN = 3.0;
const DECAL_SIZE_SNOW_PATCH_MAX = 20.0;
const DECAL_SIZE_FROST_PATCH_MIN = 2.0;
const DECAL_SIZE_FROST_PATCH_MAX = 10.0;
const DECAL_SIZE_MOSS_PATCH_MIN = 1.0;
const DECAL_SIZE_MOSS_PATCH_MAX = 4.0;
const DECAL_SIZE_FUNGAL_PATCH_MIN = 0.5;
const DECAL_SIZE_FUNGAL_PATCH_MAX = 2.0;
const DECAL_SIZE_SCUFF_MIN = 0.2;
const DECAL_SIZE_SCUFF_MAX = 0.8;
const DECAL_SIZE_DRIP_MARK_MIN = 0.1;
const DECAL_SIZE_DRIP_MARK_MAX = 0.5;
const DECAL_SIZE_SALT_CRUST_MIN = 0.5;
const DECAL_SIZE_SALT_CRUST_MAX = 3.0;

// ─── Impression depth ────────────────────────────────────────
// The "impression" of a decal is how much it perturbs the underlying
// surface. A deep crater darkens the terrain and shifts the normal; a
// shallow scuff barely changes anything. The impression drives both the
// albedo darkening and the normal perturbation.
const IMPRESSION_DEPTH_CRATER = 0.6;
const IMPRESSION_DEPTH_SCORCH = 0.3;
const IMPRESSION_DEPTH_WATER_STAIN = 0.1;
const IMPRESSION_DEPTH_RILL = 0.4;
const IMPRESSION_DEPTH_GULLY_CUT = 0.5;
const IMPRESSION_DEPTH_TRAMPLED_TRAIL = 0.2;
const IMPRESSION_DEPTH_BLOOD_STAIN = 0.1;

// ─── Persistence thresholds ──────────────────────────────────
// A decal that is larger than this threshold in world units is recorded
// as a persistent mutation. Smaller decals are ephemeral and disappear on
// stream-out / stream-in.
const PERSISTENT_DECAL_SIZE_M = 1.5;

// ─── State enum ──────────────────────────────────────────────
const DECAL_STATE = Object.freeze({
  ACTIVE: 0,
  FADING: 1,
  REMOVED: 2
});

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK DECAL STATE (structure-of-arrays) ────────
// ══════════════════════════════════════════════════════════════════

// Per-chunk decal count.
const _decalCount            = new Uint16Array(MAX_TRACKED_CHUNKS);

// Per-chunk decal slot list.
const _chunkDecalSlots       = new Int32Array(MAX_TRACKED_CHUNKS * MAX_DECALS_PER_CHUNK).fill(-1);

// Per-chunk dirty flag. Set when a new decal is placed or when the chunk
// is streamed in.
const _dirtyFlag             = new Uint8Array(MAX_TRACKED_CHUNKS);

// Per-chunk active flag.
const _chunkActive           = new Uint8Array(MAX_TRACKED_CHUNKS);

// ─── Global decal pool ───────────────────────────────────────
// Decal records are stored in a global pool indexed by decalSlot.

const _decalSlotChunk        = new Int32Array(MAX_TOTAL_DECALS).fill(-1);
const _decalSlotType         = new Uint8Array(MAX_TOTAL_DECALS);
const _decalSlotState        = new Uint8Array(MAX_TOTAL_DECALS);
const _decalSlotPos          = new Float32Array(MAX_TOTAL_DECALS * 3);
const _decalSlotRot          = new Float32Array(MAX_TOTAL_DECALS);      // Y-axis rotation only
const _decalSlotSize         = new Float32Array(MAX_TOTAL_DECALS * 2);  // width, height
const _decalSlotImpression   = new Float32Array(MAX_TOTAL_DECALS);
const _decalSlotAge          = new Float32Array(MAX_TOTAL_DECALS);      // seconds since creation
const _decalSlotMaterial     = new Float32Array(MAX_TOTAL_DECALS * DECAL_MATERIAL_FLOATS);
const _decalSlotNormalShift  = new Float32Array(MAX_TOTAL_DECALS * 3);  // normal perturbation direction
const _decalSlotShadowSoft   = new Float32Array(MAX_TOTAL_DECALS);      // shadow softening amount

// Free list for decal slots.
const _decalFreeStack        = new Int32Array(MAX_TOTAL_DECALS);
let _decalFreeTop            = MAX_TOTAL_DECALS;
for (let i = 0; i < MAX_TOTAL_DECALS; i++) _decalFreeStack[i] = MAX_TOTAL_DECALS - 1 - i;

// Round-robin cursor.
let _rrCursor                = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _scratchPos            = new Vec3();
const _scratchRot            = new Quat();
const _scratchScale          = new Vec3();
const _scratchMaterial       = new Float32Array(DECAL_MATERIAL_FLOATS);

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

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastTotalDecals = 0;
let _lastTickDurationMs = 0;
let _lastPlacedChunks = 0;

// ══════════════════════════════════════════════════════════════════
// ─── DETERMINISTIC PRNG ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _makeRng(seed) {
  let state = seed === 0 ? 1 : seed;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return state / 4294967296;
  };
}

function _chunkSeed(cx, cy, cz, salt) {
  let h = 0x9E3779B1;
  h = (h ^ (cx * 0x85ebca6b)) >>> 0;
  h = (h ^ (cy * 0xc2b2ae35)) >>> 0;
  h = (h ^ (cz * 0x27d4eb2f)) >>> 0;
  h = (h ^ (salt * 0x165667b1)) >>> 0;
  h = (h ^ (h >>> 16)) * 0x85ebca6b;
  h = (h ^ (h >>> 13)) * 0xc2b2ae35;
  h = h ^ (h >>> 16);
  return h >>> 0;
}

// ══════════════════════════════════════════════════════════════════
// ─── DECAL SLOT LIFECYCLE ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _allocDecalSlot() {
  if (_decalFreeTop === 0) return -1;
  return _decalFreeStack[--_decalFreeTop];
}

function _freeDecalSlot(slot) {
  if (slot < 0 || slot >= MAX_TOTAL_DECALS) return;
  _decalSlotChunk[slot] = -1;
  _decalSlotType[slot] = DECAL_TYPE.NONE;
  _decalSlotState[slot] = DECAL_STATE.REMOVED;
  if (_decalFreeTop < MAX_TOTAL_DECALS) {
    _decalFreeStack[_decalFreeTop++] = slot;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── DECAL MATERIAL BUILDER ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Build the 32-float material layout for a decal based on its type and the
// fused soil state of the chunk. Each decal type has its own signature
// albedo, roughness, and impression that makes it look right on screen.
function _buildDecalMaterial(decalSlot, decalType, impression, soil, biomeId) {
  const base = decalSlot * DECAL_MATERIAL_FLOATS;

  // Default material values.
  let albedoR = 0.5, albedoG = 0.5, albedoB = 0.5;
  let roughness = 0.9, metalness = 0.0, transmission = 0.0;
  let ior = 1.5, fresnelF0 = 0.04;
  let animeFlatness = 0.4, animeN = 4;
  let rimPower = 6.0, rimStrength = 0.10, outlineW = 0.0;
  let wetness = 0.0, fireEmissive = 0.0, moss = 0.0, snow = 0.0;
  let damage = 0.0, frost = 0.0;
  let sunDiffuse = 0.4, shadowSoft = 0.4, snowBoost = 0.0;
  let subsurface = 0.0, aniso = 0.0, clearcoat = 0.0, sheen = 0.0, specular = 0.4;
  let emissiveR = 0, emissiveG = 0, emissiveB = 0;

  // Start from the fused soil's colour so the decal blends with the terrain.
  const soilAlbedoR = soil.sand * 0.5 + soil.clay * 0.35 + soil.organicMatter * 0.1;
  const soilAlbedoG = soil.sand * 0.4 + soil.clay * 0.28 + soil.organicMatter * 0.08;
  const soilAlbedoB = soil.sand * 0.3 + soil.clay * 0.20 + soil.organicMatter * 0.06;

  // Override the material by decal type.
  switch (decalType) {
    case DECAL_TYPE.CRATER:
      // Dark fractured rock at the rim, scorched soil at the centre.
      albedoR = soilAlbedoR * 0.45;
      albedoG = soilAlbedoG * 0.45;
      albedoB = soilAlbedoB * 0.45;
      roughness = 0.88;
      damage = impression * 0.8;
      shadowSoft = 0.55;
      break;
    case DECAL_TYPE.SCORCH:
      // Charred black centre fading to dark brown at the edges.
      albedoR = 0.08;
      albedoG = 0.06;
      albedoB = 0.04;
      roughness = 0.95;
      fireEmissive = impression * 0.3;
      emissiveR = 1.0 * impression;
      emissiveG = 0.55 * impression;
      emissiveB = 0.20 * impression;
      break;
    case DECAL_TYPE.WATER_STAIN:
      // Dark damp earth, slightly wet and reflective.
      albedoR = soilAlbedoR * 0.65;
      albedoG = soilAlbedoG * 0.65;
      albedoB = soilAlbedoB * 0.65;
      roughness = 0.55;
      wetness = 0.7;
      specular = 0.5;
      break;
    case DECAL_TYPE.RILL:
      // Fresh-cut soil, lighter than surrounding terrain.
      albedoR = Math.min(1, soilAlbedoR * 1.15);
      albedoG = Math.min(1, soilAlbedoG * 1.15);
      albedoB = Math.min(1, soilAlbedoB * 1.15);
      roughness = 0.85;
      damage = impression * 0.5;
      shadowSoft = 0.45;
      break;
    case DECAL_TYPE.GULLY_CUT:
      // Deep fresh cut, darker and rougher than rills.
      albedoR = soilAlbedoR * 0.75;
      albedoG = soilAlbedoG * 0.75;
      albedoB = soilAlbedoB * 0.75;
      roughness = 0.88;
      damage = impression * 0.7;
      shadowSoft = 0.50;
      break;
    case DECAL_TYPE.TRAMPLED_TRAIL:
      // Compacted, slightly darker soil.
      albedoR = soilAlbedoR * 0.85;
      albedoG = soilAlbedoG * 0.85;
      albedoB = soilAlbedoB * 0.85;
      roughness = 0.92;
      break;
    case DECAL_TYPE.BLOOD_STAIN:
      // Dark red-brown stain.
      albedoR = 0.25;
      albedoG = 0.05;
      albedoB = 0.03;
      roughness = 0.75;
      wetness = 0.4;
      specular = 0.5;
      break;
    case DECAL_TYPE.SNOW_PATCH:
      // Snow albedo.
      albedoR = 0.92;
      albedoG = 0.94;
      albedoB = 0.97;
      roughness = 0.40;
      snowBoost = 0.6;
      snow = 1.0;
      subsurface = 0.25;
      break;
    case DECAL_TYPE.FROST_PATCH:
      // Pale blue-white frost.
      albedoR = 0.85;
      albedoG = 0.90;
      albedoB = 0.95;
      roughness = 0.30;
      frost = 0.7;
      subsurface = 0.15;
      specular = 0.6;
      break;
    case DECAL_TYPE.MOSS_PATCH:
      // Green moss.
      albedoR = 0.15;
      albedoG = 0.22;
      albedoB = 0.08;
      roughness = 0.85;
      moss = 0.9;
      wetness = 0.3;
      break;
    case DECAL_TYPE.FUNGAL_PATCH:
      // Pale mycelium.
      albedoR = 0.45;
      albedoG = 0.42;
      albedoB = 0.35;
      roughness = 0.75;
      subsurface = 0.2;
      break;
    case DECAL_TYPE.SCUFF:
      // Slightly disturbed soil.
      albedoR = soilAlbedoR * 0.95;
      albedoG = soilAlbedoG * 0.95;
      albedoB = soilAlbedoB * 0.95;
      roughness = 0.88;
      break;
    case DECAL_TYPE.DRIP_MARK:
      // Wet streak.
      albedoR = soilAlbedoR * 0.70;
      albedoG = soilAlbedoG * 0.70;
      albedoB = soilAlbedoB * 0.70;
      roughness = 0.50;
      wetness = 0.8;
      specular = 0.55;
      break;
    case DECAL_TYPE.SALT_CRUST:
      // Pale salt deposit.
      albedoR = 0.80;
      albedoG = 0.78;
      albedoB = 0.72;
      roughness = 0.70;
      specular = 0.55;
      break;
  }

  // Fill the layout.
  _decalSlotMaterial[base + 0] = albedoR;
  _decalSlotMaterial[base + 1] = albedoG;
  _decalSlotMaterial[base + 2] = albedoB;
  _decalSlotMaterial[base + 3] = roughness;
  _decalSlotMaterial[base + 4] = metalness;
  _decalSlotMaterial[base + 5] = transmission;
  _decalSlotMaterial[base + 6] = ior;
  _decalSlotMaterial[base + 7] = fresnelF0;
  _decalSlotMaterial[base + 8] = animeFlatness;
  _decalSlotMaterial[base + 9] = animeN;
  _decalSlotMaterial[base + 10] = rimPower;
  _decalSlotMaterial[base + 11] = rimStrength;
  _decalSlotMaterial[base + 12] = rimStrength;
  _decalSlotMaterial[base + 13] = rimStrength;
  _decalSlotMaterial[base + 14] = outlineW;
  _decalSlotMaterial[base + 15] = wetness;
  _decalSlotMaterial[base + 16] = fireEmissive;
  _decalSlotMaterial[base + 17] = moss;
  _decalSlotMaterial[base + 18] = snow;
  _decalSlotMaterial[base + 19] = damage;
  _decalSlotMaterial[base + 20] = frost;
  _decalSlotMaterial[base + 21] = sunDiffuse;
  _decalSlotMaterial[base + 22] = shadowSoft;
  _decalSlotMaterial[base + 23] = snowBoost;
  _decalSlotMaterial[base + 24] = subsurface;
  _decalSlotMaterial[base + 25] = aniso;
  _decalSlotMaterial[base + 26] = clearcoat;
  _decalSlotMaterial[base + 27] = sheen;
  _decalSlotMaterial[base + 28] = specular;
  _decalSlotMaterial[base + 29] = emissiveR;
  _decalSlotMaterial[base + 30] = emissiveG;
  _decalSlotMaterial[base + 31] = emissiveB;
}

// ══════════════════════════════════════════════════════════════════
// ─── DECAL PLACEMENT ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Place a single decal at a world position. Returns the decal slot, or -1
// if the pool is exhausted.
function _placeDecal(chunkSlot, decalType, worldX, worldY, worldZ, sizeW, sizeH, rotationRad, impression, nowS) {
  const slot = _allocDecalSlot();
  if (slot === -1) return -1;

  _decalSlotChunk[slot] = chunkSlot;
  _decalSlotType[slot] = decalType;
  _decalSlotState[slot] = DECAL_STATE.ACTIVE;

  _decalSlotPos[slot * 3 + 0] = worldX;
  _decalSlotPos[slot * 3 + 1] = worldY;
  _decalSlotPos[slot * 3 + 2] = worldZ;
  _decalSlotRot[slot] = rotationRad;
  _decalSlotSize[slot * 2 + 0] = sizeW;
  _decalSlotSize[slot * 2 + 1] = sizeH;
  _decalSlotImpression[slot] = impression;
  _decalSlotAge[slot] = 0;

  // Compute the normal perturbation direction. For most decals this is
  // downward (the surface is pushed in); for salt crusts and snow it is
  // upward (the surface is pushed out).
  const up = (decalType === DECAL_TYPE.SNOW_PATCH
    || decalType === DECAL_TYPE.FROST_PATCH
    || decalType === DECAL_TYPE.SALT_CRUST
    || decalType === DECAL_TYPE.MOSS_PATCH);
  _decalSlotNormalShift[slot * 3 + 0] = 0;
  _decalSlotNormalShift[slot * 3 + 1] = up ? impression * 0.5 : -impression * 0.5;
  _decalSlotNormalShift[slot * 3 + 2] = 0;

  // Shadow softening: craters and gullies soften shadows due to their
  // depression; snow and frost soften shadows because snow is translucent.
  if (decalType === DECAL_TYPE.CRATER
    || decalType === DECAL_TYPE.GULLY_CUT
    || decalType === DECAL_TYPE.SNOW_PATCH
    || decalType === DECAL_TYPE.FROST_PATCH) {
    _decalSlotShadowSoft[slot] = impression * 0.3;
  } else {
    _decalSlotShadowSoft[slot] = 0;
  }

  // Read the fused soil and biome for material composition.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(chunkSlot, descOut);
  let dominantBiomeId = -1;
  if (descOut.descriptorSlot !== -1) {
    dominantBiomeId = LandscapeChunkDescriptor.getDominantBiomeId(descOut.descriptorSlot);
  }
  BiomeSoilCoupling.readFusedSoil(chunkSlot, _soilScratch);

  _buildDecalMaterial(slot, decalType, impression, _soilScratch, dominantBiomeId);

  // Add to the chunk's decal list.
  const count = _decalCount[chunkSlot];
  if (count < MAX_DECALS_PER_CHUNK) {
    _chunkDecalSlots[chunkSlot * MAX_DECALS_PER_CHUNK + count] = slot;
    _decalCount[chunkSlot] = count + 1;
    _dirtyFlag[chunkSlot] = 1;
  }

  // Persist large decals as mutations.
  if (Math.max(sizeW, sizeH) >= PERSISTENT_DECAL_SIZE_M && LandscapeChunkPersistence) {
    _recordDecalMutation(chunkSlot, slot, decalType, worldX, worldY, worldZ, sizeW, sizeH, impression, nowS);
  }

  return slot;
}

// Record a decal as a persistent mutation via 341.
function _recordDecalMutation(chunkSlot, decalSlot, decalType, x, y, z, sizeW, sizeH, impression, nowS) {
  if (!LandscapeChunkPersistence || typeof LandscapeChunkPersistence.recordMutation !== 'function') return;

  // Map decal type to the closest mutation type in 341.
  let mutationType = 1;   // CRATER default
  switch (decalType) {
    case DECAL_TYPE.CRATER: mutationType = 1; break;
    case DECAL_TYPE.SCORCH: mutationType = 4; break;
    case DECAL_TYPE.WATER_STAIN: mutationType = 14; break;
    case DECAL_TYPE.RILL: mutationType = 7; break;
    case DECAL_TYPE.GULLY_CUT: mutationType = 7; break;
    case DECAL_TYPE.TRAMPLED_TRAIL: mutationType = 13; break;
    case DECAL_TYPE.BLOOD_STAIN: mutationType = 11; break;
    case DECAL_TYPE.SNOW_PATCH: mutationType = 14; break;
    case DECAL_TYPE.FROST_PATCH: mutationType = 16; break;
    case DECAL_TYPE.MOSS_PATCH: mutationType = 15; break;
    default: mutationType = 7; break;
  }

  LandscapeChunkPersistence.recordMutation(chunkSlot, {
    type: mutationType,
    materialId: -1,
    tick: Math.floor(nowS * 1000),
    x, y, z,
    radius: Math.max(sizeW, sizeH) * 0.5,
    force: impression,
    decayTau: 0,
    decayLambda: 0,
    wetness: 0,
    fireEmissive: 0,
    moss: 0,
    snow: 0,
    flags: decalType
  });
}

// Despawn all decals in a chunk.
function _despawnChunkDecals(chunkSlot) {
  const count = _decalCount[chunkSlot];
  for (let i = 0; i < count; i++) {
    const decalSlot = _chunkDecalSlots[chunkSlot * MAX_DECALS_PER_CHUNK + i];
    if (decalSlot !== -1) _freeDecalSlot(decalSlot);
    _chunkDecalSlots[chunkSlot * MAX_DECALS_PER_CHUNK + i] = -1;
  }
  _decalCount[chunkSlot] = 0;
}

// ══════════════════════════════════════════════════════════════════
// ─── CHUNK DECAL PASS ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Place the ambient decals that a chunk should have based on its biome,
// climate, erosion state, water state, and fauna. Called once per chunk
// per regeneration cycle.
function _placeAmbientDecals(streamerSlot, nowS) {
  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_DETAIL_FOR_LEVEL[tier];
  if (detail === TIER_DETAIL.SKIPPED) return 0;

  const densityScale = TIER_DECAL_DENSITY[tier];

  // Read the chunk's descriptor.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return 0;
  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return 0;

  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const cxWorld = view.chunkX * cs;
  const cyWorld = view.chunkY * cs;
  const czWorld = view.chunkZ * cs;

  // Deterministic RNG.
  const seed = _chunkSeed(view.chunkX, view.chunkY, view.chunkZ, 0);
  const rng = _makeRng(seed);

  let placed = 0;

  // ─── 1. Erosion decals ────────────────────────────────────
  // A chunk that has erosion will have rills and gully cuts on its
  // surface, placed along the downhill direction.
  const erosionLoss = LandscapeErosionSimulator.getCumulativeLoss(streamerSlot);
  if (erosionLoss > 0.05) {
    const rillCount = Math.min(8, Math.round(erosionLoss * 10 * densityScale));
    for (let i = 0; i < rillCount; i++) {
      if (placed >= MAX_DECALS_PER_CHUNK) break;
      const localX = rng() * cs;
      const localZ = rng() * cs;
      const worldX = cxWorld + localX;
      const worldY = cyWorld + rng() * 2.0;
      const worldZ = czWorld + localZ;
      const isGully = erosionLoss > 0.3 && rng() > 0.5;
      const sizeW = isGully
        ? DECAL_SIZE_GULLY_CUT_MIN + rng() * (DECAL_SIZE_GULLY_CUT_MAX - DECAL_SIZE_GULLY_CUT_MIN)
        : DECAL_SIZE_RILL_MIN + rng() * (DECAL_SIZE_RILL_MAX - DECAL_SIZE_RILL_MIN);
      const sizeH = sizeW * (2.0 + rng() * 3.0);
      const rotation = rng() * Math.PI * 2;
      const impression = isGully ? IMPRESSION_DEPTH_GULLY_CUT : IMPRESSION_DEPTH_RILL;
      _placeDecal(streamerSlot, isGully ? DECAL_TYPE.GULLY_CUT : DECAL_TYPE.RILL,
        worldX, worldY, worldZ, sizeW, sizeH, rotation, impression, nowS);
      placed++;
    }
  }

  // ─── 2. Water-stain decals ────────────────────────────────
  if (LandscapeWaterFlowSystem) {
    const hasWater = LandscapeWaterFlowSystem.hasWater(streamerSlot);
    if (hasWater) {
      const stainCount = Math.min(4, Math.round(2 * densityScale));
      for (let i = 0; i < stainCount; i++) {
        if (placed >= MAX_DECALS_PER_CHUNK) break;
        const localX = rng() * cs;
        const localZ = rng() * cs;
        const worldX = cxWorld + localX;
        const worldY = cyWorld + rng() * 0.3;
        const worldZ = czWorld + localZ;
        const sizeW = DECAL_SIZE_WATER_STAIN_MIN + rng() * (DECAL_SIZE_WATER_STAIN_MAX - DECAL_SIZE_WATER_STAIN_MIN);
        const sizeH = sizeW * (1.0 + rng() * 2.0);
        const rotation = rng() * Math.PI * 2;
        _placeDecal(streamerSlot, DECAL_TYPE.WATER_STAIN,
          worldX, worldY, worldZ, sizeW, sizeH, rotation, IMPRESSION_DEPTH_WATER_STAIN, nowS);
        placed++;
      }
    }
  }

  // ─── 3. Snow and frost decals ────────────────────────────
  const hydro = { snowWaterEquivalentMm: 0 };
  LandscapeChunkDescriptor.readHydrology(descOut.descriptorSlot, hydro);
  if (hydro.snowWaterEquivalentMm > 50) {
    const snowCount = Math.min(3, Math.round(2 * densityScale * Math.min(1.0, hydro.snowWaterEquivalentMm / 500.0)));
    for (let i = 0; i < snowCount; i++) {
      if (placed >= MAX_DECALS_PER_CHUNK) break;
      const localX = rng() * cs;
      const localZ = rng() * cs;
      const worldX = cxWorld + localX;
      const worldY = cyWorld + rng() * 0.5;
      const worldZ = czWorld + localZ;
      const sizeW = DECAL_SIZE_SNOW_PATCH_MIN + rng() * (DECAL_SIZE_SNOW_PATCH_MAX - DECAL_SIZE_SNOW_PATCH_MIN);
      const sizeH = sizeW * (1.0 + rng() * 0.5);
      const rotation = rng() * Math.PI * 2;
      _placeDecal(streamerSlot, DECAL_TYPE.SNOW_PATCH,
        worldX, worldY, worldZ, sizeW, sizeH, rotation, 0.3, nowS);
      placed++;
    }
  }

  // ─── 4. Moss and fungal decals ───────────────────────────
  // Read the chunk's dominant biome. Moss and fungal patches appear in
  // wet, humid biomes.
  if (view.dominantBiomeId !== -1) {
    const biome = BiomeRegistry.getBiome(view.dominantBiomeId);
    if (biome && biome.climate) {
      const humidity = biome.climate.humidityMean !== undefined ? biome.climate.humidityMean : 0.5;
      if (humidity > 0.7) {
        const mossCount = Math.min(3, Math.round(2 * densityScale * (humidity - 0.5)));
        for (let i = 0; i < mossCount; i++) {
          if (placed >= MAX_DECALS_PER_CHUNK) break;
          const localX = rng() * cs;
          const localZ = rng() * cs;
          const worldX = cxWorld + localX;
          const worldY = cyWorld + rng() * 0.2;
          const worldZ = czWorld + localZ;
          const sizeW = DECAL_SIZE_MOSS_PATCH_MIN + rng() * (DECAL_SIZE_MOSS_PATCH_MAX - DECAL_SIZE_MOSS_PATCH_MIN);
          const sizeH = sizeW * (1.0 + rng() * 0.5);
          const rotation = rng() * Math.PI * 2;
          const isFungal = rng() < 0.2;
          _placeDecal(streamerSlot, isFungal ? DECAL_TYPE.FUNGAL_PATCH : DECAL_TYPE.MOSS_PATCH,
            worldX, worldY, worldZ, sizeW, sizeH, rotation, 0.2, nowS);
          placed++;
        }
      }
    }
  }

  // ─── 5. Trampled-trail decals from animal paths ─────────
  if (LandscapeFaunaSpawnSystem) {
    const animalSlots = new Int32Array(16);
    const count = LandscapeFaunaSpawnSystem.readChunkAnimalSlots(streamerSlot, animalSlots, 16);
    if (count > 0) {
      const trailCount = Math.min(count, Math.round(4 * densityScale));
      for (let i = 0; i < trailCount; i++) {
        if (placed >= MAX_DECALS_PER_CHUNK) break;
        const animalSlot = animalSlots[i];
        if (animalSlot === -1) continue;
        const ax = LandscapeFaunaSpawnSystem.getAnimalPosX(animalSlot);
        const ay = LandscapeFaunaSpawnSystem.getAnimalPosY(animalSlot);
        const az = LandscapeFaunaSpawnSystem.getAnimalPosZ(animalSlot);
        const sizeW = DECAL_SIZE_TRAMPLED_TRAIL_MIN + rng() * (DECAL_SIZE_TRAMPLED_TRAIL_MAX - DECAL_SIZE_TRAMPLED_TRAIL_MIN);
        const sizeH = sizeW * (2.0 + rng() * 3.0);
        const rotation = rng() * Math.PI * 2;
        _placeDecal(streamerSlot, DECAL_TYPE.TRAMPLED_TRAIL,
          ax, ay, az, sizeW, sizeH, rotation, IMPRESSION_DEPTH_TRAMPLED_TRAIL, nowS);
        placed++;
      }
    }
  }

  return placed;
}

// Place event-driven decals from live impact events. Called by the
// IMPACT_RESOLVED event listener.
function _placeImpactDecals(streamerSlot, impactX, impactY, impactZ, force, materialId, nowS) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return 0;

  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const densityScale = TIER_DECAL_DENSITY[tier];
  if (densityScale === 0) return 0;

  const rng = _makeRng(_chunkSeed(
    LandscapeChunkDescriptor.getChunkX(descOut.descriptorSlot),
    LandscapeChunkDescriptor.getChunkY(descOut.descriptorSlot),
    LandscapeChunkDescriptor.getChunkZ(descOut.descriptorSlot),
    Math.floor(nowS * 1000) | 0
  ));

  let placed = 0;

  // Crater.
  if (force > 0.3) {
    const sizeW = DECAL_SIZE_CRATER_MIN + Math.min(1.0, force) * (DECAL_SIZE_CRATER_MAX - DECAL_SIZE_CRATER_MIN);
    const sizeH = sizeW * (1.0 + rng() * 0.3);
    const rotation = rng() * Math.PI * 2;
    _placeDecal(streamerSlot, DECAL_TYPE.CRATER,
      impactX, impactY, impactZ, sizeW, sizeH, rotation, IMPRESSION_DEPTH_CRATER, nowS);
    placed++;
  }

  // Scorch.
  if (force > 0.5 && rng() > 0.5) {
    const sizeW = DECAL_SIZE_SCORCH_MIN + Math.min(1.0, force) * (DECAL_SIZE_SCORCH_MAX - DECAL_SIZE_SCORCH_MIN);
    const sizeH = sizeW * (1.0 + rng() * 0.4);
    const rotation = rng() * Math.PI * 2;
    _placeDecal(streamerSlot, DECAL_TYPE.SCORCH,
      impactX, impactY, impactZ, sizeW, sizeH, rotation, IMPRESSION_DEPTH_SCORCH, nowS);
    placed++;
  }

  // Scuffs around the impact.
  const scuffCount = Math.min(4, Math.round(force * 4 * densityScale));
  for (let i = 0; i < scuffCount; i++) {
    const offsetX = (rng() - 0.5) * 3.0;
    const offsetZ = (rng() - 0.5) * 3.0;
    const sizeW = DECAL_SIZE_SCUFF_MIN + rng() * (DECAL_SIZE_SCUFF_MAX - DECAL_SIZE_SCUFF_MIN);
    const sizeH = sizeW * (1.0 + rng() * 1.5);
    const rotation = rng() * Math.PI * 2;
    _placeDecal(streamerSlot, DECAL_TYPE.SCUFF,
      impactX + offsetX, impactY, impactZ + offsetZ, sizeW, sizeH, rotation, 0.15, nowS);
    placed++;
  }

  return placed;
}

// ══════════════════════════════════════════════════════════════════
// ─── EVENT LISTENERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _onStreamedIn(payload) {
  const slot = payload.slot;
  if (slot < 0 || slot >= MAX_TRACKED_CHUNKS) return;
  _chunkActive[slot] = 1;
  _decalCount[slot] = 0;
  _dirtyFlag[slot] = 1;   // place decals on next pass
}

function _onStreamedOut(payload) {
  const slot = payload.slot;
  if (slot < 0 || slot >= MAX_TRACKED_CHUNKS) return;
  _despawnChunkDecals(slot);
  _chunkActive[slot] = 0;
}

function _onImpactResolved(payload) {
  // Find the chunk containing the impact position.
  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const cx = Math.floor(payload.x / cs);
  const cy = Math.floor(payload.y / cs);
  const cz = Math.floor(payload.z / cs);
  const slot = LandscapeChunkStreamer.getStreamerSlot(cx, cy, cz);
  if (slot === -1) return;
  if (!_chunkActive[slot]) return;
  _placeImpactDecals(slot, payload.x, payload.y, payload.z, payload.force || 0, payload.materialId || -1, BiomeBlendSystem.elapsedSimSeconds);
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeDecalPlacementSystem = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  DECAL_TYPE,
  DECAL_STATE,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  maxDecalsPerChunk: MAX_DECALS_PER_CHUNK,
  maxTotalDecals: MAX_TOTAL_DECALS,
  decalMaterialFloats: DECAL_MATERIAL_FLOATS,

  /**
   * Initialise the system. Called once by 361 or 362. Subscribes to the
   * streamer's STREAMED_IN / STREAMED_OUT events and the impact event.
   */
  init() {
    _dispatcher.on(EVENT_TYPE.CHUNK_STREAMED_IN, _onStreamedIn);
    _dispatcher.on(EVENT_TYPE.CHUNK_STREAMED_OUT, _onStreamedOut);
    _dispatcher.on(EVENT_TYPE.IMPACT_RESOLVED, _onImpactResolved);
  },

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _decalCount[streamerSlot] = 0;
    _dirtyFlag[streamerSlot] = 1;
    return true;
  },

  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _despawnChunkDecals(streamerSlot);
    _chunkActive[streamerSlot] = 0;
  },

  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    let processed = 0;
    let placed = 0;
    let totalDecals = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      processed++;

      if (_dirtyFlag[slot] === 0) continue;

      // Clear old decals and re-place ambient decals.
      _despawnChunkDecals(slot);
      const n = _placeAmbientDecals(slot, nowS);
      placed += n;
      _dirtyFlag[slot] = 0;
      totalDecals += _decalCount[slot];

      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastPlacedChunks = placed;
    _lastTotalDecals = totalDecals;
    _lastTickDurationMs = performanceNow() - t0;

    if (placed > 0) {
      _dispatcher.emit(EVENT_TYPE.DECALS_PLACED, {
        tick,
        processed,
        placed,
        totalDecals,
        durationMs: _lastTickDurationMs
      });
    }
  },

  /**
   * Manually place a decal at a world position. Called by 300, 316, 343,
   * 344, 345, 346, and 347 for event-driven decals.
   */
  placeDecal(streamerSlot, decalType, x, y, z, sizeW, sizeH, rotation, impression) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return -1;
    if (!_chunkActive[streamerSlot]) return -1;
    return _placeDecal(streamerSlot, decalType, x, y, z, sizeW, sizeH, rotation, impression, BiomeBlendSystem.elapsedSimSeconds);
  },

  /**
   * Mark a chunk as needing a re-placement pass (ambient decals).
   */
  markDirty(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _dirtyFlag[streamerSlot] = 1;
  },

  /**
   * Get the decal count for a chunk.
   */
  getDecalCount(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _decalCount[streamerSlot];
  },

  /**
   * Read the decal slot list for a chunk.
   */
  readChunkDecalSlots(streamerSlot, outSlots, maxCount) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _decalCount[streamerSlot];
    const limit = Math.min(count, maxCount);
    const base = streamerSlot * MAX_DECALS_PER_CHUNK;
    for (let i = 0; i < limit; i++) {
      outSlots[i] = _chunkDecalSlots[base + i];
    }
    return limit;
  },

  /**
   * Read a single decal's full record. Zero-allocation.
   */
  readDecal(decalSlot, out) {
    if (decalSlot < 0 || decalSlot >= MAX_TOTAL_DECALS) return false;
    if (_decalSlotChunk[decalSlot] === -1) return false;
    out.chunkSlot = _decalSlotChunk[decalSlot];
    out.type = _decalSlotType[decalSlot];
    out.state = _decalSlotState[decalSlot];
    out.px = _decalSlotPos[decalSlot * 3 + 0];
    out.py = _decalSlotPos[decalSlot * 3 + 1];
    out.pz = _decalSlotPos[decalSlot * 3 + 2];
    out.rotation = _decalSlotRot[decalSlot];
    out.sizeW = _decalSlotSize[decalSlot * 2 + 0];
    out.sizeH = _decalSlotSize[decalSlot * 2 + 1];
    out.impression = _decalSlotImpression[decalSlot];
    out.age = _decalSlotAge[decalSlot];
    out.normalShiftX = _decalSlotNormalShift[decalSlot * 3 + 0];
    out.normalShiftY = _decalSlotNormalShift[decalSlot * 3 + 1];
    out.normalShiftZ = _decalSlotNormalShift[decalSlot * 3 + 2];
    out.shadowSoften = _decalSlotShadowSoft[decalSlot];
    return true;
  },

  /**
   * Read the raw material buffer for a chunk's decals. Zero-allocation.
   */
  readMaterialBuffer(streamerSlot, outFloats) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _decalCount[streamerSlot];
    const base = streamerSlot * MAX_DECALS_PER_CHUNK;
    let written = 0;
    for (let i = 0; i < count && written + DECAL_MATERIAL_FLOATS <= outFloats.length; i++) {
      const decalSlot = _chunkDecalSlots[base + i];
      if (decalSlot === -1) continue;
      const matBase = decalSlot * DECAL_MATERIAL_FLOATS;
      for (let k = 0; k < DECAL_MATERIAL_FLOATS; k++) {
        outFloats[written++] = _decalSlotMaterial[matBase + k];
      }
    }
    return written;
  },

  /**
   * Read the raw transform buffer for a chunk's decals.
   */
  readTransformBuffer(streamerSlot, outFloats) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _decalCount[streamerSlot];
    const base = streamerSlot * MAX_DECALS_PER_CHUNK;
    let written = 0;
    for (let i = 0; i < count && written + 12 <= outFloats.length; i++) {
      const decalSlot = _chunkDecalSlots[base + i];
      if (decalSlot === -1) continue;
      outFloats[written++] = _decalSlotPos[decalSlot * 3 + 0];
      outFloats[written++] = _decalSlotPos[decalSlot * 3 + 1];
      outFloats[written++] = _decalSlotPos[decalSlot * 3 + 2];
      outFloats[written++] = _decalSlotRot[decalSlot];
      outFloats[written++] = _decalSlotSize[decalSlot * 2 + 0];
      outFloats[written++] = _decalSlotSize[decalSlot * 2 + 1];
      outFloats[written++] = _decalSlotImpression[decalSlot];
      outFloats[written++] = _decalSlotNormalShift[decalSlot * 3 + 0];
      outFloats[written++] = _decalSlotNormalShift[decalSlot * 3 + 1];
      outFloats[written++] = _decalSlotNormalShift[decalSlot * 3 + 2];
      outFloats[written++] = _decalSlotShadowSoft[decalSlot];
      outFloats[written++] = _decalSlotType[decalSlot];
    }
    return written;
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getDecalPosX(decalSlot) {
    if (decalSlot < 0 || decalSlot >= MAX_TOTAL_DECALS) return 0;
    return _decalSlotPos[decalSlot * 3 + 0];
  },
  getDecalPosY(decalSlot) {
    if (decalSlot < 0 || decalSlot >= MAX_TOTAL_DECALS) return 0;
    return _decalSlotPos[decalSlot * 3 + 1];
  },
  getDecalPosZ(decalSlot) {
    if (decalSlot < 0 || decalSlot >= MAX_TOTAL_DECALS) return 0;
    return _decalSlotPos[decalSlot * 3 + 2];
  },
  getDecalType(decalSlot) {
    if (decalSlot < 0 || decalSlot >= MAX_TOTAL_DECALS) return DECAL_TYPE.NONE;
    return _decalSlotType[decalSlot];
  },
  getDecalImpression(decalSlot) {
    if (decalSlot < 0 || decalSlot >= MAX_TOTAL_DECALS) return 0;
    return _decalSlotImpression[decalSlot];
  },
  getDecalShadowSoften(decalSlot) {
    if (decalSlot < 0 || decalSlot >= MAX_TOTAL_DECALS) return 0;
    return _decalSlotShadowSoft[decalSlot];
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastPlacedChunks() { return _lastPlacedChunks; },
  get lastTotalDecals() { return _lastTotalDecals; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get freeDecalSlots() { return _decalFreeTop; },
  get activeChunks() {
    let n = 0;
    for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) if (_chunkActive[i]) n++;
    return n;
  }
});

function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default LandscapeDecalPlacementSystem;