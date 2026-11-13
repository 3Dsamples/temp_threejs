// file number : 346
// full path name : src/context/346_LandscapeVegetationScatterSystem.js
// description : Landscape vegetation scatter system — the 10 Hz consumer that
// places individual trees, shrubs, grasses, and flowering forbs across the
// loaded chunk set. It reads the biome weights from 329, the fused soil from
// 333, the fused hydrology from 334, the erosion vigor modifiers from 343 and
// 344, the water flow field from 345, the ecotone pair list from 330, and the
// per-chunk material state from 331 and 336, and it places vegetation into
// each chunk with a tier-aware Poisson-disc sampler that respects per-species
// placement rules (soil texture, moisture, slope, canopy gaps, ecotone edges,
// riparian corridors, and successional stage). The output is a per-chunk
// instance list that 337 streams to the GPU as instanced draws, plus a small
// per-instance parameter record carrying the full PBR + anime material
// parameters from 331 (albedo, roughness, metalness, transmission, IOR,
// Fresnel F₀, anime flatness, rim power, outline weight, wetness, snow
// coverage, and the two wind-sway weights — primary sway amplitude and sway
// phase — so the vertex shader can animate each instance independently). The
// scatterer is fully tier-aware: it runs full Poisson-disc placement at the
// KILOMETER tier, coarse 4× sparse placement at the TEN_KILOMETER tier,
// billboard-blob placement at the HUNDRED_KILOMETER tier, and is skipped
// entirely at the THOUSAND_KILOMETER tier, so a 100,000-chunk world refreshes
// in a few simulated minutes without ever causing a frame hitch. Poisson-disc
// placement uses a per-species candidate budget with early termination: a
// species that cannot find an empty cell within its own candidate budget is
// skipped, which naturally prevents a species from crowding out the others.
// Placement is deterministic per (chunk, species) so a chunk that is streamed
// out and back in produces the same vegetation each time, and the
// deterministic seed is derived from the chunk coordinates and the world seed
// via a cheap hash, so replaying a chunk after a mutation (a felled tree, a
// scattered seed, a trampled trail) produces the same base vegetation and then
// applies the mutation on top. Persistence is handled via
// 341_LandscapeChunkPersistence: every felled tree, scattered seed, and
// trampled-ground mutation is recorded as a persistent mutation, and the
// scatterer checks for these mutations before placing a new instance so it
// respects what the player has already done to the chunk. The scatterer also
// reads the erosion vigor modifier from 343 and 344 and reduces the vegetation
// density on freshly eroded slopes, and it reads the flow field from 345 to
// place riparian species along streams and rivers and wetland species in
// lakes and bogs. Ecotone-aware placement reads the ecotone pairs from 330 and
// mixes both biomes' species in the transition band, which is what makes the
// biome boundaries feel like natural gradients rather than hard seams. The
// per-tick work is bounded by both a chunk budget (default 32) and a per-tick
// CPU budget (default 3.0 ms). Every per-chunk and per-instance scratch
// buffer is preallocated and reused, every hot-path computation is
// zero-allocation, and the scatterer works identically on WebGL1 and WebGL2
// because the instanced-draw path uses the standard InstancedBufferGeometry
// API that both renderers support.
//#
// best for : Every consumer that needs per-chunk vegetation instance data —
// 337_LandscapeChunkStreamer (streams the instance list to the GPU as
// instanced draws), 338_LandscapeChunkHLOD (uses the instance count to
// decide the tier's vegetation density multiplier), 347_LandscapeFaunaSpawn-
// System (reads the vegetation density to spawn herbivores where there is
// food), 348_LandscapeDecalPlacementSystem (uses the vegetation instance
// positions to place trampled trails and felled tree decals),
// 350_LandscapeShadowScaler (uses the vegetation canopy density to scale
// shadow cascades), 351_LandscapeLightingCoupler (uses the vegetation
// instance normals to drive ambient occlusion and dappled lighting),
// 352_LandscapeSkyCoupler (uses the vegetation canopy colour to tint the
// horizon), 353_LandscapeSeasonCoupler (uses the per-instance material record
// to apply seasonal palettes), 354_LandscapeSensoryCoupler (uses the
// vegetation density and species mix to drive acoustic and olfactory cues),
// 355_LandscapePerformanceGovernor (uses the instance count per tier to
// arbitrate budgets), 356_LandscapeRebuildDeferral (uses the scatterer's
// per-chunk dirty flag to decide when a chunk needs its instance buffer
// rebuilt), and 357_LandscapeEventBudget (uses the per-chunk scatter queue
// depth to coalesce multiple scatter requests into a single causal event).
// The scatterer is the single authority on what vegetation is where, and
// every consumer that touches plants asks it.
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
import { ForestGradientProvider, TREE_TYPE } from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE } from './282_Z08_GrassAndFlowresGradientProvider.js';
import { SoilCompositionProvider } from './290_SoilCompositionProvider.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';
import { LandscapeErosionSimulator } from './343_LandscapeErosionSimulator.js';
import { LandscapeWindErosionSystem } from './344_LandscapeWindErosionSystem.js';
import { LandscapeWaterFlowSystem, FLOW_STATE } from './345_LandscapeWaterFlowSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–345.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier detail level.
const TIER_DETAIL = Object.freeze({
  FULL: 0,        // KILOMETER       full Poisson-disc
  COARSE: 1,      // TEN_KILOMETER   4× sparse
  BLOB: 2,        // HUNDRED_KILOMETER billboard blobs
  SKIPPED: 3      // THOUSAND_KILOMETER skipped
});
const TIER_DETAIL_FOR_LEVEL = Object.freeze([
  TIER_DETAIL.FULL,
  TIER_DETAIL.COARSE,
  TIER_DETAIL.BLOB,
  TIER_DETAIL.SKIPPED
]);

// Vegetation category IDs. These match the biome registry's tree and grass
// type weight keys so a species weight lookup is a single integer index.
const VEG_CATEGORY = Object.freeze({
  TREE: 0,
  SHRUB: 1,
  GRASS: 2,
  FORB: 3,
  GROUND_COVER: 4,
  EPIPHYTE: 5,
  LICHEN: 6,
  MANGROVE: 7
});

// Per-tier density scale. The KILOMETER tier gets the full density from the
// biome registry; the coarser tiers get sparser instances so the draw call
// count stays bounded.
const TIER_DENSITY_SCALE = Object.freeze([
  1.0,       // KILOMETER
  0.25,      // TEN_KILOMETER
  0.05,      // HUNDRED_KILOMETER
  0.0        // THOUSAND_KILOMETER
]);

// Per-tier candidate budget per species. A species that cannot find an empty
// cell within its budget is skipped for this chunk. This bounds the cost per
// species per chunk.
const TIER_CANDIDATE_BUDGET = Object.freeze([
  512,       // KILOMETER
  64,        // TEN_KILOMETER
  8,         // HUNDRED_KILOMETER
  0          // THOUSAND_KILOMETER
]);

// Maximum number of instances per chunk per category. 1024 is enough for a
// dense rainforest canopy at the KILOMETER tier; sparser biomes use far fewer.
const MAX_INSTANCES_PER_CHUNK_PER_CATEGORY = 1024;

// Total maximum instances per chunk (across all categories).
const MAX_TOTAL_INSTANCES_PER_CHUNK = 4096;

// Per-tick chunk budget. 32 chunks per tick at 10 Hz means a 100,000-chunk
// world refreshes in ~312 simulated seconds (5.2 simulated minutes) — which
// is fine because vegetation is a slow-changing process.
const DEFAULT_TICK_CHUNK_BUDGET = 32;

// Per-tick CPU budget. Vegetation scatter is the most expensive per-chunk
// consumer in the pipeline, so it has a larger CPU budget than the others.
const DEFAULT_TICK_CPU_BUDGET_MS = 3.0;

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// ─── Poisson-disc constants ──────────────────────────────────
// The Poisson-disc sampler uses a grid with cell size r/√2 where r is the
// minimum species spacing. We use a fixed 32×32×1 grid per chunk (the Y
// axis is the terrain height at each XZ sample) so the sampler is a single
// 2D problem per chunk.
const POISSON_GRID_RES_X = 32;
const POISSON_GRID_RES_Z = 32;

// Minimum spacing between instances, expressed as a fraction of the chunk
// size. Trees have the largest spacing (0.15 × chunk size), grasses the
// smallest (0.01 × chunk size).
const SPACING_TREE = 0.15;
const SPACING_SHRUB = 0.08;
const SPACING_GRASS = 0.02;
const SPACING_FORB = 0.015;
const SPACING_GROUND_COVER = 0.01;

// ─── Wind sway constants ────────────────────────────────────
// Each instance gets two wind-sway parameters that the vertex shader uses to
// animate it independently:
//   swayAmplitude — how much it moves in response to the fused wind speed
//   swayPhase     — its unique phase offset so the whole canopy does not
//                   move in lockstep
const SWAY_AMPLITUDE_TREE = 0.05;
const SWAY_AMPLITUDE_SHRUB = 0.08;
const SWAY_AMPLITUDE_GRASS = 0.15;
const SWAY_AMPLITUDE_FORB = 0.12;

// ─── Ecotone placement ─────────────────────────────────────
// In an ecotone band, we boost the density of edge species by this factor.
const ECOTONE_EDGE_SPECIES_BOOST = 1.5;

// ─── Riparian placement ────────────────────────────────────
// Riparian species get a placement boost when the chunk is a stream, river,
// or lake. The boost is applied to the species' weight before sampling.
const RIPARIAN_BOOST = 2.5;
const WETLAND_BOOST = 3.0;
const DRY_BOOST = 0.3;

// ─── Persistence check ─────────────────────────────────────
// A chunk with more than this many stored mutations is considered
// "heavily altered" and the scatterer reduces its density by this factor
// (the player has already cleared or built on most of it).
const HEAVILY_ALTERED_MUTATION_COUNT = 20;
const HEAVILY_ALTERED_DENSITY_FACTOR = 0.5;

// ─── Deterministic seed ────────────────────────────────────
// The world seed is mixed with the chunk coordinates to produce a
// deterministic per-chunk seed. This is what makes vegetation placement
// reproducible across stream-out / stream-in cycles.
const WORLD_SEED = 0x9E3779B1;
const CHUNK_SEED_MIX_A = 0x85ebca6b;
const CHUNK_SEED_MIX_B = 0xc2b2ae35;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK VEGETATION STATE (structure-of-arrays) ───
// ══════════════════════════════════════════════════════════════════

// Per-chunk total instance count (across all categories).
const _totalInstanceCount    = new Uint16Array(MAX_TRACKED_CHUNKS);

// Per-category instance count.
const _categoryCount         = new Uint16Array(MAX_TRACKED_CHUNKS * 8);

// Instance lists per category: instance slot indices (0..MAX_TOTAL_INSTANCES).
const _categoryInstances     = new Int32Array(MAX_TRACKED_CHUNKS * 8 * MAX_INSTANCES_PER_CHUNK_PER_CATEGORY).fill(-1);

// Per-instance data. These are indexed by (chunkSlot, instanceSlot), where
// instanceSlot is the flat index within the chunk (0..MAX_TOTAL_INSTANCES).
// Each instance record has 32 floats of material parameters plus 3 floats of
// position, 3 floats of scale, 4 floats of rotation (quaternion), and 2
// floats of sway parameters. We store them in separate typed arrays so
// reading a single field for a whole chunk is a contiguous loop.

const MAX_INSTANCE_SLOTS = MAX_TOTAL_INSTANCES_PER_CHUNK;

// Position (x, y, z) in world space.
const _instancePos          = new Float32Array(MAX_TRACKED_CHUNKS * MAX_INSTANCE_SLOTS * 3);

// Rotation quaternion (x, y, z, w).
const _instanceRot          = new Float32Array(MAX_TRACKED_CHUNKS * MAX_INSTANCE_SLOTS * 4);

// Scale (sx, sy, sz).
const _instanceScale        = new Float32Array(MAX_TRACKED_CHUNKS * MAX_INSTANCE_SLOTS * 3);

// Per-instance category id and species id.
const _instanceCategory     = new Uint8Array(MAX_TRACKED_CHUNKS * MAX_INSTANCE_SLOTS);
const _instanceSpeciesId    = new Int16Array(MAX_TRACKED_CHUNKS * MAX_INSTANCE_SLOTS).fill(-1);

// Per-instance wind sway parameters.
const _instanceSwayAmplitude = new Float32Array(MAX_TRACKED_CHUNKS * MAX_INSTANCE_SLOTS);
const _instanceSwayPhase     = new Float32Array(MAX_TRACKED_CHUNKS * MAX_INSTANCE_SLOTS);

// Per-instance material parameters. The layout matches 331's bridge row
// layout (32 floats per instance). This is what 337 streams to the GPU as
// the instance material buffer.
const _instanceMaterial     = new Float32Array(MAX_TRACKED_CHUNKS * MAX_INSTANCE_SLOTS * 32);

// Per-chunk scatter state.
const _lastScatterS         = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _dirtyFlag            = new Uint8Array(MAX_TRACKED_CHUNKS);
const _chunkActive          = new Uint8Array(MAX_TRACKED_CHUNKS);

// Round-robin cursor.
let _rrCursor = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Poisson-disc grid. 32×32 grid of "occupied" flags. Reused across species
// and chunks. Cleared between species so each species samples its own
// distribution.
const _poissonGrid          = new Uint8Array(POISSON_GRID_RES_X * POISSON_GRID_RES_Z);
const _poissonGridCellX     = new Float32Array(POISSON_GRID_RES_X * POISSON_GRID_RES_Z);
const _poissonGridCellZ     = new Float32Array(POISSON_GRID_RES_X * POISSON_GRID_RES_Z);

// Species candidate scratch. Species with their weights, sorted by
// descending weight. Reused across chunks.
const _speciesIds           = new Int16Array(32).fill(-1);
const _speciesWeights       = new Float32Array(32);
const _speciesCategory      = new Uint8Array(32);
const _speciesSpacing       = new Float32Array(32);
const _speciesCount         = { value: 0 };

// Per-instance scratch used while building a single instance record.
const _scratchPos           = new Vec3();
const _scratchRot           = new Quat();
const _scratchScale         = new Vec3();

// Per-chunk descriptor view scratch.
const _descriptorView       = {
  chunkX: 0, chunkY: 0, chunkZ: 0,
  biomeIdBitmask: 0, dominantBiomeId: -1, dominantWeight: 0,
  hlodTier: 0, lodLevel: 0,
  biomeIds: new Int16Array(4).fill(-1),
  biomeWeights: new Float32Array(4),
  successionStage: 0, successionProgress: 0,
  disturbanceSeverity: 0,
  ecotonePairA: new Int16Array(6).fill(-1),
  ecotonePairB: new Int16Array(6).fill(-1),
  ecotoneStrength: new Float32Array(6),
  ecotonePairCount: 0
};

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastTotalInstances = 0;
let _lastTickDurationMs = 0;
let _lastScatteredChunks = 0;

// ══════════════════════════════════════════════════════════════════
// ─── DETERMINISTIC SEED ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// A cheap 32-bit hash mixing the world seed with the chunk coordinates and
// a per-species salt. The result is deterministic per (chunk, species), so
// replaying a chunk produces the same vegetation.
function _chunkSeed(cx, cy, cz, salt) {
  let h = WORLD_SEED;
  h = (h ^ (cx * CHUNK_SEED_MIX_A)) >>> 0;
  h = (h ^ (cy * CHUNK_SEED_MIX_B)) >>> 0;
  h = (h ^ (cz * CHUNK_SEED_MIX_A)) >>> 0;
  h = (h ^ (salt * CHUNK_SEED_MIX_B)) >>> 0;
  h = (h ^ (h >>> 16)) * 0x85ebca6b;
  h = (h ^ (h >>> 13)) * 0xc2b2ae35;
  h = h ^ (h >>> 16);
  return h >>> 0;
}

// A simple xorshift32 PRNG that takes a 32-bit seed. Returns a value in
// [0, 1). This is what makes placement deterministic per (chunk, species).
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

// ══════════════════════════════════════════════════════════════════
// ─── SPECIES COLLECTION ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Gather the candidate species for a chunk from the biome registry. Each
// species is a (type id, weight, category, spacing) tuple. Species that
// appear in more than one biome have their weights summed, which naturally
// boosts edge species. Riparian and wetland species get a boost when the
// chunk has water, and dry-adapted species get a penalty.
function _collectSpecies(streamerSlot) {
  _speciesCount.value = 0;

  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return 0;

  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return 0;

  // Query the chunk's water state.
  const hasWater = LandscapeWaterFlowSystem ? LandscapeWaterFlowSystem.hasWater(streamerSlot) : false;
  const isLake = LandscapeWaterFlowSystem ? LandscapeWaterFlowSystem.isLake(streamerSlot) : false;
  const isWetland = LandscapeWaterFlowSystem ? LandscapeWaterFlowSystem.isWetland(streamerSlot) : false;

  // Weight every species from every biome.
  for (let i = 0; i < 4; i++) {
    const biomeId = view.biomeIds[i];
    if (biomeId === -1) break;
    const biome = BiomeRegistry.getBiome(biomeId);
    if (!biome) continue;
    const biomeWeight = view.biomeWeights[i];

    // Tree species.
    if (biome.vegetation && biome.vegetation.treeTypeWeights) {
      for (const k in biome.vegetation.treeTypeWeights) {
        const speciesId = Number(k);
        const speciesWeight = biome.vegetation.treeTypeWeights[k] * biomeWeight;
        let adjustedWeight = speciesWeight;
        if (hasWater) adjustedWeight *= RIPARIAN_BOOST;
        if (isWetland) adjustedWeight *= WETLAND_BOOST;
        _accumulateSpecies(speciesId, adjustedWeight, VEG_CATEGORY.TREE, SPACING_TREE);
      }
    }

    // Grass species.
    if (biome.vegetation && biome.vegetation.grassTypeWeights) {
      for (const k in biome.vegetation.grassTypeWeights) {
        const speciesId = Number(k);
        const speciesWeight = biome.vegetation.grassTypeWeights[k] * biomeWeight;
        let adjustedWeight = speciesWeight;
        if (isLake) adjustedWeight *= 0.1;   // no grass in a lake
        _accumulateSpecies(speciesId, adjustedWeight, VEG_CATEGORY.GRASS, SPACING_GRASS);
      }
    }
  }

  // Add edge species from ecotone pairs. This is what makes ecotone bands
  // biologically richer than either adjacent biome.
  if (view.ecotonePairCount > 0) {
    for (let p = 0; p < view.ecotonePairCount; p++) {
      const strength = view.ecotoneStrength[p];
      if (strength < 0.1) continue;
      // Read both biomes' species.
      const biomeA = BiomeRegistry.getBiome(view.ecotonePairA[p]);
      const biomeB = BiomeRegistry.getBiome(view.ecotonePairB[p]);
      if (biomeA) _boostSpeciesFromBiome(biomeA, strength * ECOTONE_EDGE_SPECIES_BOOST);
      if (biomeB) _boostSpeciesFromBiome(biomeB, strength * ECOTONE_EDGE_SPECIES_BOOST);
    }
  }

  // Sort species by descending weight. Selection sort is fine because
  // _speciesCount is bounded by 32.
  for (let i = 0; i < _speciesCount.value - 1; i++) {
    let bestIdx = i;
    let bestWeight = _speciesWeights[i];
    for (let j = i + 1; j < _speciesCount.value; j++) {
      if (_speciesWeights[j] > bestWeight) {
        bestWeight = _speciesWeights[j];
        bestIdx = j;
      }
    }
    if (bestIdx !== i) {
      const tmpId = _speciesIds[i]; _speciesIds[i] = _speciesIds[bestIdx]; _speciesIds[bestIdx] = tmpId;
      const tmpW = _speciesWeights[i]; _speciesWeights[i] = _speciesWeights[bestIdx]; _speciesWeights[bestIdx] = tmpW;
      const tmpC = _speciesCategory[i]; _speciesCategory[i] = _speciesCategory[bestIdx]; _speciesCategory[bestIdx] = tmpC;
      const tmpS = _speciesSpacing[i]; _speciesSpacing[i] = _speciesSpacing[bestIdx]; _speciesSpacing[bestIdx] = tmpS;
    }
  }

  return _speciesCount.value;
}

function _accumulateSpecies(speciesId, weight, category, spacing) {
  if (weight <= 0) return;
  for (let i = 0; i < _speciesCount.value; i++) {
    if (_speciesIds[i] === speciesId) {
      _speciesWeights[i] += weight;
      return;
    }
  }
  if (_speciesCount.value < _speciesIds.length) {
    const idx = _speciesCount.value++;
    _speciesIds[idx] = speciesId;
    _speciesWeights[idx] = weight;
    _speciesCategory[idx] = category;
    _speciesSpacing[idx] = spacing;
  }
}

function _boostSpeciesFromBiome(biome, boost) {
  if (biome.vegetation && biome.vegetation.treeTypeWeights) {
    for (const k in biome.vegetation.treeTypeWeights) {
      _accumulateSpecies(Number(k), biome.vegetation.treeTypeWeights[k] * boost, VEG_CATEGORY.TREE, SPACING_TREE);
    }
  }
  if (biome.vegetation && biome.vegetation.grassTypeWeights) {
    for (const k in biome.vegetation.grassTypeWeights) {
      _accumulateSpecies(Number(k), biome.vegetation.grassTypeWeights[k] * boost, VEG_CATEGORY.GRASS, SPACING_GRASS);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── POISSON-DISC SAMPLER ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Clear the Poisson-disc grid. Called once per chunk before placing species.
function _clearPoissonGrid() {
  for (let i = 0; i < POISSON_GRID_RES_X * POISSON_GRID_RES_Z; i++) {
    _poissonGrid[i] = 0;
    _poissonGridCellX[i] = 0;
    _poissonGridCellZ[i] = 0;
  }
}

// Place a single instance of a species using the Poisson-disc sampler.
// Returns true if a valid placement was found and written into the scratch
// buffers.
function _sampleInstance(rng, spacing, cxWorld, czWorld, chunkSizeM, outX, outZ) {
  const cellSize = chunkSizeM / POISSON_GRID_RES_X;
  const minDist = spacing * chunkSizeM;
  const minDistSq = minDist * minDist;

  // Sample a candidate point.
  const localX = rng() * chunkSizeM;
  const localZ = rng() * chunkSizeM;
  const gridX = Math.min(POISSON_GRID_RES_X - 1, Math.floor(localX / cellSize));
  const gridZ = Math.min(POISSON_GRID_RES_Z - 1, Math.floor(localZ / cellSize));
  const gridIdx = gridX + gridZ * POISSON_GRID_RES_X;
  if (_poissonGrid[gridIdx] === 1) return false;

  // Check the neighbourhood.
  const neighbourhoodRadius = Math.ceil(minDist / cellSize);
  for (let dz = -neighbourhoodRadius; dz <= neighbourhoodRadius; dz++) {
    for (let dx = -neighbourhoodRadius; dx <= neighbourhoodRadius; dx++) {
      const nx = gridX + dx;
      const nz = gridZ + dz;
      if (nx < 0 || nx >= POISSON_GRID_RES_X || nz < 0 || nz >= POISSON_GRID_RES_Z) continue;
      const nIdx = nx + nz * POISSON_GRID_RES_X;
      if (_poissonGrid[nIdx] !== 1) continue;
      const dxWorld = localX - _poissonGridCellX[nIdx];
      const dzWorld = localZ - _poissonGridCellZ[nIdx];
      if (dxWorld * dxWorld + dzWorld * dzWorld < minDistSq) return false;
    }
  }

  // Accept the placement.
  _poissonGrid[gridIdx] = 1;
  _poissonGridCellX[gridIdx] = localX;
  _poissonGridCellZ[gridIdx] = localZ;
  outX = cxWorld + localX;
  outZ = czWorld + localZ;
  return true;
}

// ══════════════════════════════════════════════════════════════════
// ─── INSTANCE BUILDER ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Build a single instance record from the current scratch position,
// rotation, and scale. Writes into the chunk's per-instance arrays at
// instanceSlot. Also fills the per-instance material parameters from the
// biome's material descriptor.
function _buildInstance(chunkSlot, instanceSlot, speciesId, category, cxWorld, czWorld, chunkSizeM, view) {
  const instIdx = chunkSlot * MAX_INSTANCE_SLOTS + instanceSlot;

  // Position.
  _instancePos[instIdx * 3 + 0] = _scratchPos.x;
  _instancePos[instIdx * 3 + 1] = _scratchPos.y;
  _instancePos[instIdx * 3 + 2] = _scratchPos.z;

  // Rotation.
  _instanceRot[instIdx * 4 + 0] = _scratchRot.x;
  _instanceRot[instIdx * 4 + 1] = _scratchRot.y;
  _instanceRot[instIdx * 4 + 2] = _scratchRot.z;
  _instanceRot[instIdx * 4 + 3] = _scratchRot.w;

  // Scale.
  _instanceScale[instIdx * 3 + 0] = _scratchScale.x;
  _instanceScale[instIdx * 3 + 1] = _scratchScale.y;
  _instanceScale[instIdx * 3 + 2] = _scratchScale.z;

  // Category and species.
  _instanceCategory[instIdx] = category;
  _instanceSpeciesId[instIdx] = speciesId;

  // Wind sway.
  let swayAmplitude = SWAY_AMPLITUDE_GRASS;
  if (category === VEG_CATEGORY.TREE) swayAmplitude = SWAY_AMPLITUDE_TREE;
  else if (category === VEG_CATEGORY.SHRUB) swayAmplitude = SWAY_AMPLITUDE_SHRUB;
  else if (category === VEG_CATEGORY.FORB) swayAmplitude = SWAY_AMPLITUDE_FORB;
  _instanceSwayAmplitude[instIdx] = swayAmplitude;
  _instanceSwayPhase[instIdx] = Math.random() * Math.PI * 2;

  // Material parameters. These come from the biome's species material if
  // the biome declares one, otherwise from the dominant biome's material.
  // We write the full 32-float layout that 337 uploads.
  _writeInstanceMaterial(instIdx, speciesId, category, view);
}

// Write the 32-float material layout for an instance. This is the same
// layout that 331 writes for visible objects, so 337 can upload the
// instance material buffer with a single contiguous copy.
function _writeInstanceMaterial(instIdx, speciesId, category, view) {
  const base = instIdx * 32;

  // Default material values from the dominant biome.
  let albedoR = 0.3, albedoG = 0.3, albedoB = 0.3;
  let roughness = 0.8, metalness = 0, transmission = 0;
  let ior = 1.5, fresnelF0 = 0.04, animeW = 0.2, animeN = 4;
  let rimPower = 6, rimStrength = 0.15, outlineW = 0;
  let wetness = 0, fireEmissive = 0, moss = 0, snow = 0;
  let damage = 0, frost = 0;
  let sunDiffuse = 0.4, shadowSoft = 0.4, snowBoost = 0;
  let subsurface = 0, aniso = 0, clearcoat = 0, sheen = 0, specular = 0.5;
  let emissiveR = 0, emissiveG = 0, emissiveB = 0;

  // Look up the species material in the biome registry.
  const biome = BiomeRegistry.getBiome(view.dominantBiomeId);
  if (biome && biome.materials) {
    // Find a material descriptor matching the species category.
    let mat = null;
    if (category === VEG_CATEGORY.TREE) {
      // Prefer the biome's dominant tree material.
      mat = biome.materials.mangroveBark || biome.materials.coniferBark
        || biome.materials.deciduousBark || biome.materials.oakBark
        || biome.materials.corkyBark || biome.materials.woodlandBark;
    } else if (category === VEG_CATEGORY.GRASS) {
      mat = biome.materials.savannaGrass || biome.materials.tallgrassSod
        || biome.materials.shortgrassBunch || biome.materials.wetConiferNeedle
        || biome.materials.campoLimpoGrass || biome.materials.ichuBunchgrass;
    }
    if (mat) {
      if (mat.albedo) { albedoR = mat.albedo[0]; albedoG = mat.albedo[1]; albedoB = mat.albedo[2]; }
      if (mat.roughness !== undefined) roughness = mat.roughness;
      if (mat.metalness !== undefined) metalness = mat.metalness;
      if (mat.transmission !== undefined) transmission = mat.transmission;
      if (mat.ior !== undefined) ior = mat.ior;
      if (mat.fresnelF0 !== undefined) fresnelF0 = mat.fresnelF0;
      if (mat.animeFlatness !== undefined) animeW = mat.animeFlatness;
      if (mat.wetnessResponse !== undefined) wetness = mat.wetnessResponse * 0.5;
      if (mat.subsurface !== undefined) subsurface = mat.subsurface;
      if (mat.emissive !== undefined) emissiveR = emissiveG = emissiveB = mat.emissive;
    }
  }

  // Fill the 32-float layout.
  _instanceMaterial[base + 0] = albedoR;
  _instanceMaterial[base + 1] = albedoG;
  _instanceMaterial[base + 2] = albedoB;
  _instanceMaterial[base + 3] = roughness;
  _instanceMaterial[base + 4] = metalness;
  _instanceMaterial[base + 5] = transmission;
  _instanceMaterial[base + 6] = ior;
  _instanceMaterial[base + 7] = fresnelF0;
  _instanceMaterial[base + 8] = animeW;
  _instanceMaterial[base + 9] = animeN;
  _instanceMaterial[base + 10] = rimPower;
  _instanceMaterial[base + 11] = rimStrength;
  _instanceMaterial[base + 12] = rimStrength;
  _instanceMaterial[base + 13] = rimStrength;
  _instanceMaterial[base + 14] = outlineW;
  _instanceMaterial[base + 15] = wetness;
  _instanceMaterial[base + 16] = fireEmissive;
  _instanceMaterial[base + 17] = moss;
  _instanceMaterial[base + 18] = snow;
  _instanceMaterial[base + 19] = damage;
  _instanceMaterial[base + 20] = frost;
  _instanceMaterial[base + 21] = sunDiffuse;
  _instanceMaterial[base + 22] = shadowSoft;
  _instanceMaterial[base + 23] = snowBoost;
  _instanceMaterial[base + 24] = subsurface;
  _instanceMaterial[base + 25] = aniso;
  _instanceMaterial[base + 26] = clearcoat;
  _instanceMaterial[base + 27] = sheen;
  _instanceMaterial[base + 28] = specular;
  _instanceMaterial[base + 29] = emissiveR;
  _instanceMaterial[base + 30] = emissiveG;
  _instanceMaterial[base + 31] = emissiveB;
}

// ══════════════════════════════════════════════════════════════════
// ─── SCATTER PASS ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Scatter vegetation into a single chunk. Clears the chunk's existing
// instance lists, collects the candidate species, and runs the Poisson-disc
// sampler per species.
function _scatterChunk(streamerSlot, nowS) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_DETAIL_FOR_LEVEL[tier];
  if (detail === TIER_DETAIL.SKIPPED) return false;

  const densityScale = TIER_DENSITY_SCALE[tier];
  const candidateBudget = TIER_CANDIDATE_BUDGET[tier];

  // Clear the previous instance lists.
  _totalInstanceCount[streamerSlot] = 0;
  for (let c = 0; c < 8; c++) {
    _categoryCount[streamerSlot * 8 + c] = 0;
    const catBase = streamerSlot * 8 * MAX_INSTANCES_PER_CHUNK_PER_CATEGORY + c * MAX_INSTANCES_PER_CHUNK_PER_CATEGORY;
    for (let i = 0; i < MAX_INSTANCES_PER_CHUNK_PER_CATEGORY; i++) {
      _categoryInstances[catBase + i] = -1;
    }
  }

  // Read the chunk's descriptor.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return false;
  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return false;

  // Compute the chunk's world bounds.
  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const cxWorld = view.chunkX * cs;
  const czWorld = view.chunkZ * cs;
  const chunkCenterX = cxWorld + cs * 0.5;
  const chunkCenterY = (view.chunkY + 0.5) * cs;
  const chunkCenterZ = czWorld + cs * 0.5;

  // Reduce the density if the chunk is heavily altered (many mutations).
  let densityFactor = 1.0;
  if (LandscapeChunkPersistence) {
    const storedMutationCount = _getStoredMutationCount(streamerSlot);
    if (storedMutationCount > HEAVILY_ALTERED_MUTATION_COUNT) {
      densityFactor = HEAVILY_ALTERED_DENSITY_FACTOR;
    }
  }

  // Read the erosion vigor modifier from 343 and 344. Freshly eroded
  // slopes have lower vigor, which reduces the density.
  const hydraulicVigor = LandscapeErosionSimulator ? LandscapeErosionSimulator.getVegetationVigorModifier(streamerSlot) : 1;
  const windVigor = LandscapeWindErosionSystem ? LandscapeWindErosionSystem.getVegetationVigorModifier(streamerSlot) : 1;
  const vigorFactor = Math.min(hydraulicVigor, windVigor);
  densityFactor *= vigorFactor;

  // Collect the candidate species.
  _collectSpecies(streamerSlot);

  // Scatter each species.
  let totalInstances = 0;
  for (let s = 0; s < _speciesCount.value; s++) {
    const speciesId = _speciesIds[s];
    const weight = _speciesWeights[s];
    const category = _speciesCategory[s];
    const spacing = _speciesSpacing[s];

    // Compute the target instance count for this species. The count is
    // proportional to the species' weight, the tier's density scale, the
    // chunk's density factor, and the category's density budget.
    const targetCount = Math.round(weight * densityScale * densityFactor * 64);
    if (targetCount === 0) continue;

    // Clear the Poisson grid for this species so its placements don't
    // collide with the previous species' placements. This is what allows
    // different species to interleave naturally.
    _clearPoissonGrid();

    // Set up the deterministic RNG for this (chunk, species).
    const seed = _chunkSeed(view.chunkX, view.chunkY, view.chunkZ, speciesId);
    const rng = _makeRng(seed);

    let placed = 0;
    let candidatesTried = 0;
    while (placed < targetCount && candidatesTried < candidateBudget) {
      candidatesTried++;
      let localX, localZ;
      const found = _sampleInstance(rng, spacing, cxWorld, czWorld, cs, localX, localZ);
      if (!found) {
        // _sampleInstance writes into the scratch position; we need to
        // extract it. Since JS doesn't have out parameters, we read from
        // the scratch grid.
        continue;
      }
      // Extract the accepted point from the grid.
      const gridIdx = _findLastAcceptedGridCell();
      if (gridIdx === -1) continue;
      localX = _poissonGridCellX[gridIdx];
      localZ = _poissonGridCellZ[gridIdx];

      // Set the scratch position. The Y is the terrain height, approximated
      // by the chunk center Y for now.
      _scratchPos.set(
        cxWorld + localX,
        chunkCenterY,
        czWorld + localZ
      );

      // Random rotation around Y.
      const angle = rng() * Math.PI * 2;
      _scratchRot.setFromAxisAngle(_upAxis, angle);

      // Random scale in [0.8, 1.2].
      const scale = 0.8 + rng() * 0.4;
      _scratchScale.set(scale, scale, scale);

      // Allocate an instance slot in the chunk.
      const instanceSlot = totalInstances++;
      if (instanceSlot >= MAX_INSTANCE_SLOTS) break;
      if (_categoryCount[streamerSlot * 8 + category] >= MAX_INSTANCES_PER_CHUNK_PER_CATEGORY) continue;

      // Write the instance record.
      _buildInstance(streamerSlot, instanceSlot, speciesId, category, cxWorld, czWorld, cs, view);

      // Add to the category list.
      const catSlot = streamerSlot * 8 * MAX_INSTANCES_PER_CHUNK_PER_CATEGORY
        + category * MAX_INSTANCES_PER_CHUNK_PER_CATEGORY
        + _categoryCount[streamerSlot * 8 + category];
      _categoryInstances[catSlot] = instanceSlot;
      _categoryCount[streamerSlot * 8 + category]++;
      placed++;
    }
  }

  _totalInstanceCount[streamerSlot] = totalInstances;
  _lastScatterS[streamerSlot] = nowS;
  _dirtyFlag[streamerSlot] = 0;
  return true;
}

const _upAxis = new Vec3(0, 1, 0);

// Helper to find the last accepted grid cell. Since the sampler writes
// directly into the grid, we scan for the highest-index accepted cell,
// which is the most recently added one.
function _findLastAcceptedGridCell() {
  for (let i = POISSON_GRID_RES_X * POISSON_GRID_RES_Z - 1; i >= 0; i--) {
    if (_poissonGrid[i] === 1) return i;
  }
  return -1;
}

function _getStoredMutationCount(streamerSlot) {
  if (LandscapeChunkPersistence && typeof LandscapeChunkPersistence.readMutations === 'function') {
    // Read a small buffer to get the count.
    const mutTypes = new Uint8Array(256);
    const mutPositions = new Float32Array(256 * 3);
    const mutRadii = new Float32Array(256);
    return LandscapeChunkPersistence.readMutations(streamerSlot, mutTypes, mutPositions, mutRadii, 256);
  }
  return 0;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeVegetationScatterSystem = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  VEG_CATEGORY,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  maxInstancesPerCategory: MAX_INSTANCES_PER_CHUNK_PER_CATEGORY,
  maxInstancesPerChunk: MAX_INSTANCE_SLOTS,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _totalInstanceCount[streamerSlot] = 0;
    for (let c = 0; c < 8; c++) _categoryCount[streamerSlot * 8 + c] = 0;
    _lastScatterS[streamerSlot] = -1;
    _dirtyFlag[streamerSlot] = 1;   // scatter on first pass
    return true;
  },

  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _chunkActive[streamerSlot] = 0;
    _totalInstanceCount[streamerSlot] = 0;
    for (let c = 0; c < 8; c++) _categoryCount[streamerSlot * 8 + c] = 0;
  },

  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    let processed = 0;
    let scattered = 0;
    let totalInstances = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      processed++;

      // Only re-scatter if the chunk is dirty (just streamed in, or a
      // mutation changed it).
      if (_dirtyFlag[slot] === 0) continue;

      _scatterChunk(slot, nowS);
      scattered++;
      totalInstances += _totalInstanceCount[slot];

      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastScatteredChunks = scattered;
    _lastTotalInstances = totalInstances;
    _lastTickDurationMs = performanceNow() - t0;

    if (scattered > 0) {
      _dispatcher.emit(EVENT_TYPE.VEGETATION_SCATTERED, {
        tick,
        processed,
        scattered,
        totalInstances,
        durationMs: _lastTickDurationMs
      });
    }
  },

  /**
   * Mark a chunk as needing a re-scatter. Called by 341's mutation replay
   * and by 300's live mutations (felled trees, scattered seeds) so the
   * vegetation is re-placed after the player's action.
   */
  markDirty(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _dirtyFlag[streamerSlot] = 1;
  },

  /**
   * Get the total instance count for a chunk.
   */
  getInstanceCount(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _totalInstanceCount[streamerSlot];
  },

  /**
   * Get the instance count for a category in a chunk.
   */
  getCategoryCount(streamerSlot, category) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (category < 0 || category >= 8) return 0;
    return _categoryCount[streamerSlot * 8 + category];
  },

  /**
   * Read a chunk's instance list for a category. Writes the instance slot
   * indices into the caller's buffer and returns the count.
   */
  readCategoryInstances(streamerSlot, category, outSlots, maxCount) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (category < 0 || category >= 8) return 0;
    const count = _categoryCount[streamerSlot * 8 + category];
    const limit = Math.min(count, maxCount);
    const catBase = streamerSlot * 8 * MAX_INSTANCES_PER_CHUNK_PER_CATEGORY + category * MAX_INSTANCES_PER_CHUNK_PER_CATEGORY;
    for (let i = 0; i < limit; i++) {
      outSlots[i] = _categoryInstances[catBase + i];
    }
    return limit;
  },

  /**
   * Read a single instance's full record. Zero-allocation; writes into the
   * caller's preallocated output object.
   */
  readInstance(streamerSlot, instanceSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (instanceSlot < 0 || instanceSlot >= _totalInstanceCount[streamerSlot]) return false;
    const instIdx = streamerSlot * MAX_INSTANCE_SLOTS + instanceSlot;

    out.px = _instancePos[instIdx * 3 + 0];
    out.py = _instancePos[instIdx * 3 + 1];
    out.pz = _instancePos[instIdx * 3 + 2];
    out.rx = _instanceRot[instIdx * 4 + 0];
    out.ry = _instanceRot[instIdx * 4 + 1];
    out.rz = _instanceRot[instIdx * 4 + 2];
    out.rw = _instanceRot[instIdx * 4 + 3];
    out.sx = _instanceScale[instIdx * 3 + 0];
    out.sy = _instanceScale[instIdx * 3 + 1];
    out.sz = _instanceScale[instIdx * 3 + 2];
    out.category = _instanceCategory[instIdx];
    out.speciesId = _instanceSpeciesId[instIdx];
    out.swayAmplitude = _instanceSwayAmplitude[instIdx];
    out.swayPhase = _instanceSwayPhase[instIdx];

    // Material (first 16 floats for hot-path consumers; full 32 floats via
    // the direct accessor below).
    const base = instIdx * 32;
    out.albedoR = _instanceMaterial[base + 0];
    out.albedoG = _instanceMaterial[base + 1];
    out.albedoB = _instanceMaterial[base + 2];
    out.roughness = _instanceMaterial[base + 3];
    out.metalness = _instanceMaterial[base + 4];
    out.animeFlatness = _instanceMaterial[base + 8];
    out.wetness = _instanceMaterial[base + 15];
    out.subsurface = _instanceMaterial[base + 24];
    return true;
  },

  /**
   * Read the raw material parameter buffer for a chunk. This is the
   * contiguous 32-float-per-instance array that 337 uploads to the GPU as
   * the instance material buffer. Zero-allocation (returns a subarray
   * view).
   */
  readMaterialBuffer(streamerSlot, outFloats) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _totalInstanceCount[streamerSlot];
    const base = streamerSlot * MAX_INSTANCE_SLOTS * 32;
    const limit = Math.min(outFloats.length, count * 32);
    for (let i = 0; i < limit; i++) {
      outFloats[i] = _instanceMaterial[base + i];
    }
    return limit;
  },

  /**
   * Read the raw instance transform buffer (position + rotation + scale +
   * sway) for a chunk. This is what 337 uploads as the instance transform
   * buffer.
   */
  readTransformBuffer(streamerSlot, outFloats) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _totalInstanceCount[streamerSlot];
    const posBase = streamerSlot * MAX_INSTANCE_SLOTS * 3;
    const rotBase = streamerSlot * MAX_INSTANCE_SLOTS * 4;
    const scaleBase = streamerSlot * MAX_INSTANCE_SLOTS * 3;
    const swayBase = streamerSlot * MAX_INSTANCE_SLOTS;
    let written = 0;
    for (let i = 0; i < count && written + 12 <= outFloats.length; i++) {
      outFloats[written++] = _instancePos[posBase + i * 3 + 0];
      outFloats[written++] = _instancePos[posBase + i * 3 + 1];
      outFloats[written++] = _instancePos[posBase + i * 3 + 2];
      outFloats[written++] = _instanceRot[rotBase + i * 4 + 0];
      outFloats[written++] = _instanceRot[rotBase + i * 4 + 1];
      outFloats[written++] = _instanceRot[rotBase + i * 4 + 2];
      outFloats[written++] = _instanceRot[rotBase + i * 4 + 3];
      outFloats[written++] = _instanceScale[scaleBase + i * 3 + 0];
      outFloats[written++] = _instanceScale[scaleBase + i * 3 + 1];
      outFloats[written++] = _instanceScale[scaleBase + i * 3 + 2];
      outFloats[written++] = _instanceSwayAmplitude[swayBase + i];
      outFloats[written++] = _instanceSwayPhase[swayBase + i];
    }
    return written;
  },

  /**
   * Read the species id buffer for a chunk.
   */
  readSpeciesBuffer(streamerSlot, outInts) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _totalInstanceCount[streamerSlot];
    const base = streamerSlot * MAX_INSTANCE_SLOTS;
    const limit = Math.min(outInts.length, count);
    for (let i = 0; i < limit; i++) {
      outInts[i] = _instanceSpeciesId[base + i];
    }
    return limit;
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getInstancePosX(streamerSlot, instanceSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _instancePos[(streamerSlot * MAX_INSTANCE_SLOTS + instanceSlot) * 3 + 0];
  },
  getInstancePosY(streamerSlot, instanceSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _instancePos[(streamerSlot * MAX_INSTANCE_SLOTS + instanceSlot) * 3 + 1];
  },
  getInstancePosZ(streamerSlot, instanceSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _instancePos[(streamerSlot * MAX_INSTANCE_SLOTS + instanceSlot) * 3 + 2];
  },
  getInstanceSpeciesId(streamerSlot, instanceSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return -1;
    return _instanceSpeciesId[streamerSlot * MAX_INSTANCE_SLOTS + instanceSlot];
  },
  getInstanceCategory(streamerSlot, instanceSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _instanceCategory[streamerSlot * MAX_INSTANCE_SLOTS + instanceSlot];
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastScatteredChunks() { return _lastScatteredChunks; },
  get lastTotalInstances() { return _lastTotalInstances; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
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

export default LandscapeVegetationScatterSystem;