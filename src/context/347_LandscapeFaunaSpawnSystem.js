// file number : 347
// full path name : src/context/347_LandscapeFaunaSpawnSystem.js
// description : Landscape fauna spawn system — the 10 Hz consumer that spawns
// individual animals into the loaded chunk set. It reads the per-chunk fauna
// presence field from 335_BiomeFaunaMigrationSystem (cohort positions and
// populations), the vegetation instance data from 346 (food, cover, and
// perch opportunities), the water flow field from 345 (drinking water and
// aquatic habitat), the biome blend from 329 (species mix), the fused climate
// from 332, and the per-chunk descriptor from 336, and it places individual
// animals with a tier-aware density budget. Where 335 models animal
// populations as continuous cohorts that migrate across the map, 347 places
// the discrete individuals those cohorts are made of: a cohort of 200
// wildebeest is rendered as 200 individual animals whose positions are
// scattered around the cohort's centroid with a Gaussian distribution, whose
// orientations are aligned with the cohort's velocity, and whose material
// parameters are blended from the biome's animal fur descriptor and the
// per-chunk state. Each spawned animal carries the full PBR + anime parameter
// set from 331: fur albedo in linear RGB, roughness, metalness, transmission
// for translucent ears and fins, IOR, Fresnel F₀, anime flatness weight,
// rim power, outline weight, wetness (from rain and from proximity to water),
// snow coverage (from the fused snow water equivalent), damage (from recent
// predator contact), frost, and the two locomotion parameters that the
// vertex shader uses to animate the gait — stride phase and gait frequency —
// so each animal walks with its own phase offset and looks alive. The
// spawner is fully tier-aware: full per-animal spawning at the KILOMETER
// tier, 4× sparse spawning at the TEN_KILOMETER tier, single-instance-per-
// cohort spawning at the HUNDRED_KILOMETER tier, and no spawning at the
// THOUSAND_KILOMETER tier, so a 100,000-chunk world with hundreds of
// thousands of cohorts still spawns no more than a few thousand individual
// animals per tier. The per-tick work is bounded by both a chunk budget
// (default 48) and a per-tick CPU budget (default 2.0 ms). Every per-chunk
// and per-animal scratch buffer is preallocated and reused, every hot-path
// computation is zero-allocation, and the spawner works identically on
// WebGL1 and WebGL2 because the instanced-draw path uses the standard
// InstancedBufferGeometry API that both renderers support. Fauna presence is
// written back to 335's per-chunk field so a cohort whose population has been
// fully spawned into individual animals is accurately reflected in the
// migration system, and spawned animals are removed when the chunk is
// streamed out so the individual animal pool never grows unbounded.
//#
// best for : Every consumer that needs per-chunk individual animal instance
// data — 337_LandscapeChunkStreamer (streams the animal instance list to
// the GPU as instanced draws), 338_LandscapeChunkHLOD (uses the animal count
// to decide the tier's fauna density multiplier),
// 350_LandscapeShadowScaler (uses the animal count to scale shadow
// cascades), 351_LandscapeLightingCoupler (uses the animal normals to
// drive ambient occlusion), 353_LandscapeSeasonCoupler (uses the animal
// material record to apply seasonal fur palettes),
// 354_LandscapeSensoryCoupler (uses the animal density and species mix to
// drive acoustic and olfactory cues — bird calls, hoofbeats, musky scents),
// 355_LandscapePerformanceGovernor (uses the animal count per tier to
// arbitrate budgets), 356_LandscapeRebuildDeferral (uses the spawner's
// per-chunk dirty flag to decide when a chunk needs its instance buffer
// rebuilt), and 357_LandscapeEventBudget (uses the per-chunk spawn queue
// depth to coalesce multiple spawn requests into a single causal event).
// The spawner is the single authority on individual animal placement, and
// every consumer that touches animals asks it.
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
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeWaterFlowSystem, FLOW_STATE } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem } from './346_LandscapeVegetationScatterSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–346.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier detail level.
const TIER_DETAIL = Object.freeze({
  FULL: 0,        // KILOMETER       one animal per population unit
  COARSE: 1,      // TEN_KILOMETER   1/4 density
  SPARSE: 2,      // HUNDRED_KILOMETER 1 instance per cohort
  SKIPPED: 3      // THOUSAND_KILOMETER skipped
});
const TIER_DETAIL_FOR_LEVEL = Object.freeze([
  TIER_DETAIL.FULL,
  TIER_DETAIL.COARSE,
  TIER_DETAIL.SPARSE,
  TIER_DETAIL.SKIPPED
]);

// Fauna guild ids. Match 335's guild encoding.
const FAUNA_GUILD = Object.freeze({
  LARGE_HERBIVORE: 0,
  SMALL_HERBIVORE: 1,
  LARGE_PREDATOR: 2,
  SMALL_PREDATOR: 3,
  AMPHIBIAN: 4,
  WATERFOWL: 5,
  INSECTIVORE: 6,
  DEFAULT: 7
});

// Per-tier animal density scale. The KILOMETER tier gets one animal per
// population unit; the coarser tiers get sparser representations.
const TIER_ANIMAL_DENSITY = Object.freeze([
  1.0,        // KILOMETER
  0.25,       // TEN_KILOMETER
  0.02,       // HUNDRED_KILOMETER (one instance per cohort)
  0.0         // THOUSAND_KILOMETER
]);

// Maximum number of individual animals per chunk.
const MAX_ANIMALS_PER_CHUNK = 1024;

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Maximum total animal slots across all chunks.
const MAX_TOTAL_ANIMALS = 65536;

// Per-tick chunk budget. 48 chunks per tick at 10 Hz means a 100,000-chunk
// world refreshes in ~208 simulated seconds (3.5 simulated minutes) — which
// is fine because individual animal placement is a fast process.
const DEFAULT_TICK_CHUNK_BUDGET = 48;

// Per-tick CPU budget. Animal spawn is moderately expensive per chunk, so
// it has a slightly larger CPU budget than the simple couplings.
const DEFAULT_TICK_CPU_BUDGET_MS = 2.0;

// ─── Animal scatter parameters ────────────────────────────────
// A cohort of N animals is rendered as K individuals, where K is
// min(N, MAX_ANIMALS_PER_COHORT). The individuals are scattered around
// the cohort's centroid with a Gaussian distribution whose standard
// deviation is COHORT_SCATTER_RADIUS_M.
const COHORT_SCATTER_RADIUS_M = 15.0;
const MAX_ANIMALS_PER_COHORT = 64;
const MIN_ANIMALS_PER_COHORT = 1;

// ─── Gait animation ───────────────────────────────────────────
// Each animal's locomotion is driven by two parameters:
//   gaitPhase     — the current phase of its stride cycle
//   gaitFrequency — the frequency of the stride cycle in Hz
// A grazing herbivore has a slow gait (0.5 Hz); a fleeing predator has a
// fast gait (2.5 Hz).
const GAIT_FREQ_HERBIVORE = 0.6;
const GAIT_FREQ_PREDATOR = 1.8;
const GAIT_FREQ_BIRD = 3.0;
const GAIT_FREQ_AMPHIBIAN = 0.8;

// ─── Species material defaults ────────────────────────────────
// Used when a biome does not declare a specific fur/feather/skin material
// for a species. These are sensible defaults that look alive on screen.
const DEFAULT_FUR_ALBEDO = Object.freeze([0.35, 0.25, 0.15]);
const DEFAULT_SCALE_ALBEDO = Object.freeze([0.25, 0.30, 0.20]);
const DEFAULT_FEATHER_ALBEDO = Object.freeze([0.55, 0.50, 0.40]);
const DEFAULT_SKIN_ALBEDO = Object.freeze([0.20, 0.15, 0.12]);

// ─── Wind sway for animals ────────────────────────────────────
// Animals (unlike vegetation) do not sway in the wind, but their fur/skin
// does move slightly. We apply a small wind-sway factor for fur.
const ANIMAL_FUR_SWAY = 0.02;

// ─── State enum ──────────────────────────────────────────────
const ANIMAL_STATE = Object.freeze({
  IDLE: 0,
  GRAZING: 1,
  WALKING: 2,
  RUNNING: 3,
  DRINKING: 4,
  FLYING: 5,
  SWIMMING: 6,
  RESTING: 7
});

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK ANIMAL STATE (structure-of-arrays) ───────
// ══════════════════════════════════════════════════════════════════

// Per-chunk animal count.
const _animalCount          = new Uint16Array(MAX_TRACKED_CHUNKS);

// Per-chunk scratch arrays. These are reused across ticks for the current
// batch of animals in the chunk.
const _animalState          = new Uint8Array(MAX_TRACKED_CHUNKS * MAX_ANIMALS_PER_CHUNK);

// Slot active flag.
const _chunkActive          = new Uint8Array(MAX_TRACKED_CHUNKS);

// Per-chunk dirty flag. Set when the chunk is streamed in or when a
// mutation changes the animal population.
const _dirtyFlag            = new Uint8Array(MAX_TRACKED_CHUNKS);

// ─── Global animal pool ─────────────────────────────────────
// Individual animal records are stored in a global pool indexed by
// animalSlot (0..MAX_TOTAL_ANIMALS). Each animal's chunkSlot is stored
// separately so we can find its neighbours in O(1).

const _animalSlotChunk      = new Int32Array(MAX_TOTAL_ANIMALS).fill(-1);
const _animalSlotSpecies    = new Int16Array(MAX_TOTAL_ANIMALS).fill(-1);
const _animalSlotGuild      = new Int16Array(MAX_TOTAL_ANIMALS).fill(-1);
const _animalSlotState      = new Uint8Array(MAX_TOTAL_ANIMALS);
const _animalSlotPos        = new Float32Array(MAX_TOTAL_ANIMALS * 3);
const _animalSlotRot        = new Float32Array(MAX_TOTAL_ANIMALS * 4);
const _animalSlotScale      = new Float32Array(MAX_TOTAL_ANIMALS * 3);
const _animalSlotGaitPhase  = new Float32Array(MAX_TOTAL_ANIMALS);
const _animalSlotGaitFreq   = new Float32Array(MAX_TOTAL_ANIMALS);
const _animalSlotMaterial   = new Float32Array(MAX_TOTAL_ANIMALS * 32);

// Free list for animal slots.
const _animalFreeStack      = new Int32Array(MAX_TOTAL_ANIMALS);
let _animalFreeTop          = MAX_TOTAL_ANIMALS;
for (let i = 0; i < MAX_TOTAL_ANIMALS; i++) _animalFreeStack[i] = MAX_TOTAL_ANIMALS - 1 - i;

// Per-chunk animal slot list (up to MAX_ANIMALS_PER_CHUNK per chunk).
const _chunkAnimalSlots     = new Int32Array(MAX_TRACKED_CHUNKS * MAX_ANIMALS_PER_CHUNK).fill(-1);

// Round-robin cursor.
let _rrCursor               = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _scratchPos           = new Vec3();
const _scratchRot           = new Quat();
const _scratchScale         = new Vec3();
const _scratchMaterial      = new Float32Array(32);

// Cohort read scratch.
const _cohortScratch = {
  speciesId: -1, guildId: 0,
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  population: 0, health: 0, age: 0
};

// Presence field read scratch.
const _presenceGrid = new Float32Array(64);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastTotalAnimals = 0;
let _lastTickDurationMs = 0;
let _lastSpawnedChunks = 0;

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

// Gaussian noise using the Box–Muller transform. Uses the provided RNG.
function _gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ══════════════════════════════════════════════════════════════════
// ─── ANIMAL SLOT LIFECYCLE ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _allocAnimalSlot() {
  if (_animalFreeTop === 0) return -1;
  return _animalFreeStack[--_animalFreeTop];
}

function _freeAnimalSlot(slot) {
  if (slot < 0 || slot >= MAX_TOTAL_ANIMALS) return;
  _animalSlotChunk[slot] = -1;
  _animalSlotSpecies[slot] = -1;
  _animalSlotGuild[slot] = -1;
  if (_animalFreeTop < MAX_TOTAL_ANIMALS) {
    _animalFreeStack[_animalFreeTop++] = slot;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── SPECIES MATERIAL ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Build the 32-float material layout for an animal of a given species in a
// given biome. Uses the biome's declared animal material if available;
// otherwise falls back to sensible defaults by guild.
function _buildAnimalMaterial(animalSlot, speciesId, guildId, biomeId, nowS) {
  const base = animalSlot * 32;

  // Default by guild.
  let albedoR = DEFAULT_FUR_ALBEDO[0];
  let albedoG = DEFAULT_FUR_ALBEDO[1];
  let albedoB = DEFAULT_FUR_ALBEDO[2];
  let roughness = 0.85, metalness = 0.0, transmission = 0.0;
  let ior = 1.4, fresnelF0 = 0.04, animeW = 0.2, animeN = 4;
  let rimPower = 6.0, rimStrength = 0.10, outlineW = 0.0;
  let wetness = 0.0, fireEmissive = 0.0, moss = 0.0, snow = 0.0;
  let damage = 0.0, frost = 0.0;
  let sunDiffuse = 0.4, shadowSoft = 0.4, snowBoost = 0.0;
  let subsurface = 0.0, aniso = 0.0, clearcoat = 0.0, sheen = 0.0, specular = 0.3;
  let emissiveR = 0, emissiveG = 0, emissiveB = 0;

  // Look up the biome's animal material descriptor. Biomes do not typically
  // declare per-species materials; they declare per-guild materials when
  // they have one at all. We fall back to the guild defaults.
  const biome = BiomeRegistry.getBiome(biomeId);
  if (biome && biome.materials) {
    let mat = null;
    if (guildId === FAUNA_GUILD.LARGE_HERBIVORE || guildId === FAUNA_GUILD.SMALL_HERBIVORE) {
      mat = biome.materials.herbivoreFur || biome.materials.fur;
    } else if (guildId === FAUNA_GUILD.LARGE_PREDATOR || guildId === FAUNA_GUILD.SMALL_PREDATOR) {
      mat = biome.materials.predatorFur || biome.materials.fur;
    } else if (guildId === FAUNA_GUILD.WATERFOWL) {
      mat = biome.materials.feathers || biome.materials.waterfowl;
    } else if (guildId === FAUNA_GUILD.AMPHIBIAN) {
      mat = biome.materials.amphibianSkin || biome.materials.wetSkin;
    }
    if (mat) {
      if (mat.albedo) { albedoR = mat.albedo[0]; albedoG = mat.albedo[1]; albedoB = mat.albedo[2]; }
      if (mat.roughness !== undefined) roughness = mat.roughness;
      if (mat.metalness !== undefined) metalness = mat.metalness;
      if (mat.transmission !== undefined) transmission = mat.transmission;
      if (mat.ior !== undefined) ior = mat.ior;
      if (mat.fresnelF0 !== undefined) fresnelF0 = mat.fresnelF0;
      if (mat.animeFlatness !== undefined) animeW = mat.animeFlatness;
      if (mat.subsurface !== undefined) subsurface = mat.subsurface;
    }
  } else {
    // Guild-specific fallbacks.
    if (guildId === FAUNA_GUILD.WATERFOWL) {
      albedoR = DEFAULT_FEATHER_ALBEDO[0];
      albedoG = DEFAULT_FEATHER_ALBEDO[1];
      albedoB = DEFAULT_FEATHER_ALBEDO[2];
    } else if (guildId === FAUNA_GUILD.AMPHIBIAN) {
      albedoR = DEFAULT_SCALE_ALBEDO[0];
      albedoG = DEFAULT_SCALE_ALBEDO[1];
      albedoB = DEFAULT_SCALE_ALBEDO[2];
      wetness = 0.5;
      subsurface = 0.15;
    }
  }

  // Fill the layout.
  _animalSlotMaterial[base + 0] = albedoR;
  _animalSlotMaterial[base + 1] = albedoG;
  _animalSlotMaterial[base + 2] = albedoB;
  _animalSlotMaterial[base + 3] = roughness;
  _animalSlotMaterial[base + 4] = metalness;
  _animalSlotMaterial[base + 5] = transmission;
  _animalSlotMaterial[base + 6] = ior;
  _animalSlotMaterial[base + 7] = fresnelF0;
  _animalSlotMaterial[base + 8] = animeW;
  _animalSlotMaterial[base + 9] = animeN;
  _animalSlotMaterial[base + 10] = rimPower;
  _animalSlotMaterial[base + 11] = rimStrength;
  _animalSlotMaterial[base + 12] = rimStrength;
  _animalSlotMaterial[base + 13] = rimStrength;
  _animalSlotMaterial[base + 14] = outlineW;
  _animalSlotMaterial[base + 15] = wetness;
  _animalSlotMaterial[base + 16] = fireEmissive;
  _animalSlotMaterial[base + 17] = moss;
  _animalSlotMaterial[base + 18] = snow;
  _animalSlotMaterial[base + 19] = damage;
  _animalSlotMaterial[base + 20] = frost;
  _animalSlotMaterial[base + 21] = sunDiffuse;
  _animalSlotMaterial[base + 22] = shadowSoft;
  _animalSlotMaterial[base + 23] = snowBoost;
  _animalSlotMaterial[base + 24] = subsurface;
  _animalSlotMaterial[base + 25] = aniso;
  _animalSlotMaterial[base + 26] = clearcoat;
  _animalSlotMaterial[base + 27] = sheen;
  _animalSlotMaterial[base + 28] = specular;
  _animalSlotMaterial[base + 29] = emissiveR;
  _animalSlotMaterial[base + 30] = emissiveG;
  _animalSlotMaterial[base + 31] = emissiveB;
}

// ══════════════════════════════════════════════════════════════════
// ─── GAIT PARAMETERS ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _gaitFrequencyForGuild(guildId) {
  switch (guildId) {
    case FAUNA_GUILD.LARGE_HERBIVORE: return GAIT_FREQ_HERBIVORE;
    case FAUNA_GUILD.SMALL_HERBIVORE: return GAIT_FREQ_HERBIVORE * 1.4;
    case FAUNA_GUILD.LARGE_PREDATOR: return GAIT_FREQ_PREDATOR;
    case FAUNA_GUILD.SMALL_PREDATOR: return GAIT_FREQ_PREDATOR * 1.3;
    case FAUNA_GUILD.AMPHIBIAN: return GAIT_FREQ_AMPHIBIAN;
    case FAUNA_GUILD.WATERFOWL: return GAIT_FREQ_BIRD;
    case FAUNA_GUILD.INSECTIVORE: return GAIT_FREQ_BIRD;
    default: return GAIT_FREQ_HERBIVORE;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── ANIMAL SPAWNING ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Spawn one animal into the given chunk. Returns the animal slot, or -1
// if the pool is exhausted.
function _spawnAnimal(chunkSlot, cohort, rng, biomeId, chunkCenterX, chunkCenterY, chunkCenterZ, nowS) {
  const slot = _allocAnimalSlot();
  if (slot === -1) return -1;

  _animalSlotChunk[slot] = chunkSlot;
  _animalSlotSpecies[slot] = cohort.speciesId;
  _animalSlotGuild[slot] = cohort.guildId;

  // Scatter position around the cohort centroid.
  const scatterX = _gaussian(rng) * COHORT_SCATTER_RADIUS_M;
  const scatterZ = _gaussian(rng) * COHORT_SCATTER_RADIUS_M;
  const scatterY = Math.abs(_gaussian(rng)) * 0.5;

  _animalSlotPos[slot * 3 + 0] = cohort.x + scatterX;
  _animalSlotPos[slot * 3 + 1] = chunkCenterY + scatterY;
  _animalSlotPos[slot * 3 + 2] = cohort.z + scatterZ;

  // Orientation: face along the cohort's velocity vector.
  const vx = cohort.vx;
  const vz = cohort.vz;
  const vLen = Math.sqrt(vx * vx + vz * vz);
  const angle = vLen > 1e-3 ? Math.atan2(vz, vx) : rng() * Math.PI * 2;
  _scratchRot.setFromAxisAngle(_upAxis, -angle);
  _animalSlotRot[slot * 4 + 0] = _scratchRot.x;
  _animalSlotRot[slot * 4 + 1] = _scratchRot.y;
  _animalSlotRot[slot * 4 + 2] = _scratchRot.z;
  _animalSlotRot[slot * 4 + 3] = _scratchRot.w;

  // Scale: 0.85–1.15.
  const scale = 0.85 + rng() * 0.30;
  _animalSlotScale[slot * 3 + 0] = scale;
  _animalSlotScale[slot * 3 + 1] = scale;
  _animalSlotScale[slot * 3 + 2] = scale;

  // Gait parameters.
  _animalSlotGaitPhase[slot] = rng() * Math.PI * 2;
  _animalSlotGaitFreq[slot] = _gaitFrequencyForGuild(cohort.guildId);

  // State.
  _animalSlotState[slot] = _initialStateForGuild(cohort.guildId);

  // Material.
  _buildAnimalMaterial(slot, cohort.speciesId, cohort.guildId, biomeId, nowS);

  // Add to the chunk's animal list.
  const chunkCount = _animalCount[chunkSlot];
  if (chunkCount < MAX_ANIMALS_PER_CHUNK) {
    _chunkAnimalSlots[chunkSlot * MAX_ANIMALS_PER_CHUNK + chunkCount] = slot;
    _animalCount[chunkSlot] = chunkCount + 1;
  }

  return slot;
}

const _upAxis = new Vec3(0, 1, 0);

function _initialStateForGuild(guildId) {
  switch (guildId) {
    case FAUNA_GUILD.LARGE_HERBIVORE:
    case FAUNA_GUILD.SMALL_HERBIVORE:
      return ANIMAL_STATE.GRAZING;
    case FAUNA_GUILD.LARGE_PREDATOR:
    case FAUNA_GUILD.SMALL_PREDATOR:
      return ANIMAL_STATE.WALKING;
    case FAUNA_GUILD.WATERFOWL:
      return ANIMAL_STATE.FLYING;
    case FAUNA_GUILD.AMPHIBIAN:
      return ANIMAL_STATE.RESTING;
    default:
      return ANIMAL_STATE.IDLE;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── CHUNK SPAWN PASS ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Despawn all animals in a chunk. Called before re-spawning.
function _despawnChunkAnimals(chunkSlot) {
  const count = _animalCount[chunkSlot];
  for (let i = 0; i < count; i++) {
    const animalSlot = _chunkAnimalSlots[chunkSlot * MAX_ANIMALS_PER_CHUNK + i];
    if (animalSlot !== -1) _freeAnimalSlot(animalSlot);
    _chunkAnimalSlots[chunkSlot * MAX_ANIMALS_PER_CHUNK + i] = -1;
  }
  _animalCount[chunkSlot] = 0;
}

// Spawn animals into a chunk based on the cohort field from 335. The chunk
// can hold up to MAX_ANIMALS_PER_CHUNK animals; the density is determined
// by the tier, the cohort populations in and around the chunk, and the
// habitat suitability.
function _spawnChunk(streamerSlot, nowS) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_DETAIL_FOR_LEVEL[tier];
  if (detail === TIER_DETAIL.SKIPPED) return false;

  const densityScale = TIER_ANIMAL_DENSITY[tier];

  // Clear the previous animal list.
  _despawnChunkAnimals(streamerSlot);

  // Read the chunk's descriptor for world coordinates and biome.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return false;
  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return false;

  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const chunkCenterX = (view.chunkX + 0.5) * cs;
  const chunkCenterY = (view.chunkY + 0.5) * cs;
  const chunkCenterZ = (view.chunkZ + 0.5) * cs;

  // Read the per-chunk presence field to find cohorts in this chunk.
  // The presence field from 335 tells us how much of each cohort is in this
  // chunk, so we can spawn that fraction of the cohort's individuals.
  const presenceCells = LandscapeChunkDescriptor.readFaunaPresenceGrid
    ? LandscapeChunkDescriptor.readFaunaPresenceGrid(descOut.descriptorSlot, _presenceGrid)
    : 0;

  // The fauna migration system (335) tracks cohorts by slot. We iterate its
  // cohort list and, for each cohort whose centroid lies inside this chunk,
  // spawn a fraction of its individuals.
  let spawned = 0;
  for (let c = 0; c < BiomeFaunaMigrationSystem.maxCohorts; c++) {
    if (!BiomeFaunaMigrationSystem.readCohort(c, _cohortScratch)) continue;
    if (_cohortScratch.speciesId === -1) continue;

    // Is the cohort's centroid inside this chunk?
    const cohortCx = Math.floor(_cohortScratch.x / cs);
    const cohortCy = Math.floor(_cohortScratch.y / cs);
    const cohortCz = Math.floor(_cohortScratch.z / cs);
    if (cohortCx !== view.chunkX || cohortCy !== view.chunkY || cohortCz !== view.chunkZ) continue;

    // How many individuals to spawn?
    const targetCount = Math.min(
      MAX_ANIMALS_PER_COHORT,
      Math.max(MIN_ANIMALS_PER_COHORT, Math.round(_cohortScratch.population * densityScale))
    );
    if (targetCount === 0) continue;

    // Deterministic RNG per (chunk, cohort).
    const seed = _chunkSeed(view.chunkX, view.chunkY, view.chunkZ, c);
    const rng = _makeRng(seed);

    // Spawn.
    for (let i = 0; i < targetCount; i++) {
      if (spawned >= MAX_ANIMALS_PER_CHUNK) break;
      _spawnAnimal(
        streamerSlot, _cohortScratch, rng, view.dominantBiomeId,
        chunkCenterX, chunkCenterY, chunkCenterZ, nowS
      );
      spawned++;
    }
    if (spawned >= MAX_ANIMALS_PER_CHUNK) break;
  }

  _dirtyFlag[streamerSlot] = 0;
  return true;
}

// Deterministic seed based on chunk coordinates and cohort index.
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
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeFaunaSpawnSystem = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  FAUNA_GUILD,
  ANIMAL_STATE,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  maxAnimalsPerChunk: MAX_ANIMALS_PER_CHUNK,
  maxTotalAnimals: MAX_TOTAL_ANIMALS,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _animalCount[streamerSlot] = 0;
    _dirtyFlag[streamerSlot] = 1;
    return true;
  },

  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _despawnChunkAnimals(streamerSlot);
    _chunkActive[streamerSlot] = 0;
  },

  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    let processed = 0;
    let spawned = 0;
    let totalAnimals = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      processed++;

      // Only re-spawn if the chunk is dirty.
      if (_dirtyFlag[slot] === 0) continue;

      _spawnChunk(slot, nowS);
      spawned++;
      totalAnimals += _animalCount[slot];

      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastSpawnedChunks = spawned;
    _lastTotalAnimals = totalAnimals;
    _lastTickDurationMs = performanceNow() - t0;

    if (spawned > 0) {
      _dispatcher.emit(EVENT_TYPE.FAUNA_SPAWNED, {
        tick,
        processed,
        spawned,
        totalAnimals,
        durationMs: _lastTickDurationMs
      });
    }
  },

  /**
   * Mark a chunk as needing a re-spawn. Called by 341's mutation replay and
   * by 335 when the cohort field changes.
   */
  markDirty(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _dirtyFlag[streamerSlot] = 1;
  },

  /**
   * Get the animal count for a chunk.
   */
  getAnimalCount(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _animalCount[streamerSlot];
  },

  /**
   * Read the animal slot list for a chunk. Writes the animal slot indices
   * into the caller's buffer and returns the count.
   */
  readChunkAnimalSlots(streamerSlot, outSlots, maxCount) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _animalCount[streamerSlot];
    const limit = Math.min(count, maxCount);
    const base = streamerSlot * MAX_ANIMALS_PER_CHUNK;
    for (let i = 0; i < limit; i++) {
      outSlots[i] = _chunkAnimalSlots[base + i];
    }
    return limit;
  },

  /**
   * Read a single animal's full record. Zero-allocation.
   */
  readAnimal(animalSlot, out) {
    if (animalSlot < 0 || animalSlot >= MAX_TOTAL_ANIMALS) return false;
    if (_animalSlotChunk[animalSlot] === -1) return false;
    out.chunkSlot = _animalSlotChunk[animalSlot];
    out.speciesId = _animalSlotSpecies[animalSlot];
    out.guildId = _animalSlotGuild[animalSlot];
    out.state = _animalSlotState[animalSlot];
    out.px = _animalSlotPos[animalSlot * 3 + 0];
    out.py = _animalSlotPos[animalSlot * 3 + 1];
    out.pz = _animalSlotPos[animalSlot * 3 + 2];
    out.rx = _animalSlotRot[animalSlot * 4 + 0];
    out.ry = _animalSlotRot[animalSlot * 4 + 1];
    out.rz = _animalSlotRot[animalSlot * 4 + 2];
    out.rw = _animalSlotRot[animalSlot * 4 + 3];
    out.sx = _animalSlotScale[animalSlot * 3 + 0];
    out.sy = _animalSlotScale[animalSlot * 3 + 1];
    out.sz = _animalSlotScale[animalSlot * 3 + 2];
    out.gaitPhase = _animalSlotGaitPhase[animalSlot];
    out.gaitFreq = _animalSlotGaitFreq[animalSlot];
    return true;
  },

  /**
   * Read the raw material buffer for a chunk's animals. This is the
   * contiguous 32-float-per-animal array that 337 uploads to the GPU as
   * the instance material buffer.
   */
  readMaterialBuffer(streamerSlot, outFloats) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _animalCount[streamerSlot];
    const base = streamerSlot * MAX_ANIMALS_PER_CHUNK;
    let written = 0;
    for (let i = 0; i < count && written + 32 <= outFloats.length; i++) {
      const animalSlot = _chunkAnimalSlots[base + i];
      if (animalSlot === -1) continue;
      const matBase = animalSlot * 32;
      for (let k = 0; k < 32; k++) {
        outFloats[written++] = _animalSlotMaterial[matBase + k];
      }
    }
    return written;
  },

  /**
   * Read the raw transform buffer for a chunk's animals. This is the
   * per-animal position, rotation, scale, and gait parameters that 337
   * uploads as the instance transform buffer.
   */
  readTransformBuffer(streamerSlot, outFloats) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _animalCount[streamerSlot];
    const base = streamerSlot * MAX_ANIMALS_PER_CHUNK;
    let written = 0;
    for (let i = 0; i < count && written + 15 <= outFloats.length; i++) {
      const animalSlot = _chunkAnimalSlots[base + i];
      if (animalSlot === -1) continue;
      outFloats[written++] = _animalSlotPos[animalSlot * 3 + 0];
      outFloats[written++] = _animalSlotPos[animalSlot * 3 + 1];
      outFloats[written++] = _animalSlotPos[animalSlot * 3 + 2];
      outFloats[written++] = _animalSlotRot[animalSlot * 4 + 0];
      outFloats[written++] = _animalSlotRot[animalSlot * 4 + 1];
      outFloats[written++] = _animalSlotRot[animalSlot * 4 + 2];
      outFloats[written++] = _animalSlotRot[animalSlot * 4 + 3];
      outFloats[written++] = _animalSlotScale[animalSlot * 3 + 0];
      outFloats[written++] = _animalSlotScale[animalSlot * 3 + 1];
      outFloats[written++] = _animalSlotScale[animalSlot * 3 + 2];
      outFloats[written++] = _animalSlotGaitPhase[animalSlot];
      outFloats[written++] = _animalSlotGaitFreq[animalSlot];
      outFloats[written++] = _animalSlotState[animalSlot];
      outFloats[written++] = _animalSlotSpecies[animalSlot];
      outFloats[written++] = _animalSlotGuild[animalSlot];
    }
    return written;
  },

  /**
   * Force an immediate spawn into a chunk. Used by 341's mutation replay
   * and by 335's cohort spawn logic when a new cohort is created.
   */
  forceSpawn(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    _dirtyFlag[streamerSlot] = 1;
    _spawnChunk(streamerSlot, BiomeBlendSystem.elapsedSimSeconds);
    return true;
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getAnimalPosX(animalSlot) {
    if (animalSlot < 0 || animalSlot >= MAX_TOTAL_ANIMALS) return 0;
    return _animalSlotPos[animalSlot * 3 + 0];
  },
  getAnimalPosY(animalSlot) {
    if (animalSlot < 0 || animalSlot >= MAX_TOTAL_ANIMALS) return 0;
    return _animalSlotPos[animalSlot * 3 + 1];
  },
  getAnimalPosZ(animalSlot) {
    if (animalSlot < 0 || animalSlot >= MAX_TOTAL_ANIMALS) return 0;
    return _animalSlotPos[animalSlot * 3 + 2];
  },
  getAnimalSpecies(animalSlot) {
    if (animalSlot < 0 || animalSlot >= MAX_TOTAL_ANIMALS) return -1;
    return _animalSlotSpecies[animalSlot];
  },
  getAnimalGuild(animalSlot) {
    if (animalSlot < 0 || animalSlot >= MAX_TOTAL_ANIMALS) return -1;
    return _animalSlotGuild[animalSlot];
  },
  getAnimalState(animalSlot) {
    if (animalSlot < 0 || animalSlot >= MAX_TOTAL_ANIMALS) return ANIMAL_STATE.IDLE;
    return _animalSlotState[animalSlot];
  },
  getAnimalChunk(animalSlot) {
    if (animalSlot < 0 || animalSlot >= MAX_TOTAL_ANIMALS) return -1;
    return _animalSlotChunk[animalSlot];
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastSpawnedChunks() { return _lastSpawnedChunks; },
  get lastTotalAnimals() { return _lastTotalAnimals; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get freeAnimalSlots() { return _animalFreeTop; },
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

export default LandscapeFaunaSpawnSystem;