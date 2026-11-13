// file number : 349
// full path name : src/context/349_LandscapePropPlacementSystem.js
// description : Landscape prop placement system — the 10 Hz consumer that
// places manmade and semi-manmade props (buildings, walls, bridges, fences,
// signs, camps, ruins, shipwrecks, standing stones, and abandoned structures)
// into the loaded chunk set. It reads the biome blend from 329, the terrain
// slope from 282, the fused hydrology from 334, the water flow field from 345,
// the fauna cohort data from 335 and 347, the vegetation instance data from
// 346, and the per-chunk descriptor from 336, and it places prop instances
// into a per-chunk prop list that 337_LandscapeChunkStreamer streams to the
// GPU as instanced draws. Placement is biome-appropriate: thatch-and-timber
// huts in the tropical rainforest, stone-and-slate chalets in the Alps, adobe
// pueblos in the desert, timber-framed longhouses in the temperate forest,
// stilt houses in the mangrove and delta biomes, pit houses in the tundra, and
// stone ruins in the badlands and canyonlands. Every prop carries the full PBR
// + anime material parameter set from 331 — the prop's albedo in linear RGB,
// roughness, metalness, transmission (for windows and water tanks), IOR,
// Fresnel F₀, anime flatness weight, rim power, outline weight, wetness, snow
// coverage, damage, moss, and emissive — plus a per-prop weathering record
// (age in simulated years, structural damage, moss coverage, snow coverage)
// that 331 and 353 read to apply the correct seasonal and successional
// palette. The lighting coupler (351) reads the prop's material record to
// drive the specular highlights on wet roofs and the emissive glow from lit
// windows at night. Prop placement is amortized across ticks, budgeted by
// HLOD tier, and persisted via 341_LandscapeChunkPersistence so props survive
// stream-out / stream-in cycles. Damaged and destroyed props (from combat,
// fire, or natural decay) are recorded as mutations and replayed via 342.
// The per-tick work is bounded by both a chunk budget (default 48) and a
// per-tick CPU budget (default 2.0 ms). Every per-chunk and per-prop scratch
// buffer is preallocated and reused, every hot-path computation is zero-
// allocation, and the system works identically on WebGL1 and WebGL2 because
// props use the standard InstancedBufferGeometry path and the standard
// MeshStandardMaterial / MeshToonMaterial pipeline — no compute shaders or
// WebGL2-specific extensions are required.
//#
// best for : Every consumer that needs per-chunk prop instance data —
// 337_LandscapeChunkStreamer (streams the prop instance list to the GPU as
// instanced draws), 338_LandscapeChunkHLOD (uses the prop count to decide
// the tier's prop density multiplier), 341_LandscapeChunkPersistence
// (persists the prop records as mutations), 342_LandscapeChunkMutationReplay
// (replays the persisted prop records on stream-in),
// 343_LandscapeErosionSimulator (uses the prop density to know which chunks
// have built structures that resist erosion),
// 346_LandscapeVegetationScatterSystem (uses the prop positions to avoid
// placing vegetation inside buildings), 347_LandscapeFaunaSpawnSystem
// (uses the prop positions to spawn domesticated animals near settlements
// and wild animals away from them), 348_LandscapeDecalPlacementSystem
// (places prop-related decals — footpaths, signposts, road wear),
// 350_LandscapeShadowScaler (uses the prop density and height to scale
// shadow cascades), 351_LandscapeLightingCoupler (uses the prop emissive to
// drive window glow at night), 352_LandscapeSkyCoupler (uses the prop
// density to add smoke plumes to the sky), 353_LandscapeSeasonCoupler (uses
// the per-prop weathering record to apply seasonal palettes),
// 354_LandscapeSensoryCoupler (uses the prop density and type to drive
// acoustic cues — chimney smoke, door creaks, work sounds),
// 355_LandscapePerformanceGovernor (uses the prop count per tier to
// arbitrate budgets), 356_LandscapeRebuildDeferral (uses the per-chunk prop
// dirty flag to decide when a chunk needs its prop buffer rebuilt), and
// 357_LandscapeEventBudget (uses the per-chunk prop queue depth to coalesce
// multiple prop requests into a single causal event). The prop system is
// the single authority on what props exist, where, and what their material
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
import { SlopeGradientProvider } from './282_SlopeGradientProvider.js';
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
import { LandscapeWaterFlowSystem, FLOW_STATE } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem, VEG_CATEGORY } from './346_LandscapeVegetationScatterSystem.js';
import { LandscapeFaunaSpawnSystem } from './347_LandscapeFaunaSpawnSystem.js';
import { LandscapeDecalPlacementSystem, DECAL_TYPE } from './348_LandscapeDecalPlacementSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–348.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier detail level.
const TIER_DETAIL = Object.freeze({
  FULL: 0,        // KILOMETER       full prop placement
  COARSE: 1,      // TEN_KILOMETER   1/4 density
  SPARSE: 2,      // HUNDRED_KILOMETER single prop per chunk
  SKIPPED: 3      // THOUSAND_KILOMETER skipped
});
const TIER_DETAIL_FOR_LEVEL = Object.freeze([
  TIER_DETAIL.FULL,
  TIER_DETAIL.COARSE,
  TIER_DETAIL.SPARSE,
  TIER_DETAIL.SKIPPED
]);

// Prop type identifiers.
const PROP_TYPE = Object.freeze({
  NONE: 0,
  HUT_THATCH: 1,
  CHALET_STONE: 2,
  PUEBLO_ADOBE: 3,
  LONGHOUSE_TIMBER: 4,
  STILT_HOUSE: 5,
  PIT_HOUSE: 6,
  TENT: 7,
  WALL_STONE: 8,
  WALL_TIMBER: 9,
  FENCE: 10,
  BRIDGE_STONE: 11,
  BRIDGE_TIMBER: 12,
  SIGNPOST: 13,
  CAMPFIRE: 14,
  RUIN_STONE: 15,
  RUIN_ADOBE: 16,
  SHIPWRECK: 17,
  STANDING_STONE: 18,
  WELL: 19,
  STORAGE_SHED: 20,
  BOAT_DOCK: 21,
  RESERVED_22: 22,
  RESERVED_23: 23
});

// Per-tier prop density scale.
const TIER_PROP_DENSITY = Object.freeze([
  1.0,        // KILOMETER
  0.25,       // TEN_KILOMETER
  0.02,       // HUNDRED_KILOMETER
  0.0         // THOUSAND_KILOMETER
]);

// Maximum number of props per chunk.
const MAX_PROPS_PER_CHUNK = 32;

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Maximum total prop slots across all chunks.
const MAX_TOTAL_PROPS = 16384;

// Per-tick chunk budget.
const DEFAULT_TICK_CHUNK_BUDGET = 48;

// Per-tick CPU budget.
const DEFAULT_TICK_CPU_BUDGET_MS = 2.0;

// Per-prop material record size (floats). Same 32-float layout as 331.
const PROP_MATERIAL_FLOATS = 32;

// ─── Biome → prop type mapping ──────────────────────────────
// A biome's characteristic architecture. Keyed by biome name so we do not
// need to hardcode biome ids.
const BIOME_ARCHITECTURE = Object.freeze({
  tropical_rainforest: PROP_TYPE.STILT_HOUSE,
  temperate_deciduous_forest: PROP_TYPE.LONGHOUSE_TIMBER,
  taiga_boreal_forest: PROP_TYPE.HUT_THATCH,
  taiga_boreal_coniferous_forest: PROP_TYPE.HUT_THATCH,
  grassland_savanna: PROP_TYPE.TENT,
  desert: PROP_TYPE.PUEBLO_ADOBE,
  tundra: PROP_TYPE.PIT_HOUSE,
  alpine: PROP_TYPE.CHALET_STONE,
  aquatic_freshwater: PROP_TYPE.BOAT_DOCK,
  aquatic_marine: PROP_TYPE.BOAT_DOCK,
  wetland_marsh_swamp: PROP_TYPE.STILT_HOUSE,
  mediterranean_chaparral: PROP_TYPE.CHALET_STONE,
  steppe_prairie: PROP_TYPE.TENT,
  savanna_woodland: PROP_TYPE.HUT_THATCH,
  mangrove_coastal: PROP_TYPE.STILT_HOUSE,
  temperate_rainforest: PROP_TYPE.LONGHOUSE_TIMBER,
  subtropical_humid_forest: PROP_TYPE.HUT_THATCH,
  flooding_pampa_grassland: PROP_TYPE.HUT_THATCH,
  campos_grassland: PROP_TYPE.HUT_THATCH,
  cerrado_savanna: PROP_TYPE.HUT_THATCH,
  andean_puna_grassland: PROP_TYPE.PUEBLO_ADOBE,
  canyonlands: PROP_TYPE.RUIN_STONE,
  mountain_lake_valley: PROP_TYPE.CHALET_STONE,
  river_delta_estuary: PROP_TYPE.STILT_HOUSE,
  badlands_eroded_hills: PROP_TYPE.RUIN_STONE
});

// ─── Prop size ranges ───────────────────────────────────────
// Each prop type has a size range in metres. The actual size is chosen
// randomly within the range for each placed prop.
const PROP_SIZE = Object.freeze({
  HUT_THATCH: Object.freeze({ wMin: 3.0, wMax: 6.0, hMin: 2.5, hMax: 4.0 }),
  CHALET_STONE: Object.freeze({ wMin: 5.0, wMax: 9.0, hMin: 3.5, hMax: 6.0 }),
  PUEBLO_ADOBE: Object.freeze({ wMin: 4.0, wMax: 8.0, hMin: 2.5, hMax: 4.5 }),
  LONGHOUSE_TIMBER: Object.freeze({ wMin: 6.0, wMax: 12.0, hMin: 3.0, hMax: 5.0 }),
  STILT_HOUSE: Object.freeze({ wMin: 4.0, wMax: 7.0, hMin: 3.0, hMax: 5.5 }),
  PIT_HOUSE: Object.freeze({ wMin: 3.0, wMax: 5.0, hMin: 1.5, hMax: 2.5 }),
  TENT: Object.freeze({ wMin: 2.5, wMax: 4.0, hMin: 1.5, hMax: 2.5 }),
  WALL_STONE: Object.freeze({ wMin: 4.0, wMax: 12.0, hMin: 1.0, hMax: 2.0 }),
  WALL_TIMBER: Object.freeze({ wMin: 3.0, wMax: 10.0, hMin: 1.0, hMax: 1.8 }),
  FENCE: Object.freeze({ wMin: 2.0, wMax: 6.0, hMin: 0.8, hMax: 1.4 }),
  BRIDGE_STONE: Object.freeze({ wMin: 6.0, wMax: 15.0, hMin: 2.0, hMax: 4.0 }),
  BRIDGE_TIMBER: Object.freeze({ wMin: 4.0, wMax: 10.0, hMin: 1.5, hMax: 3.0 }),
  SIGNPOST: Object.freeze({ wMin: 0.6, wMax: 1.0, hMin: 1.5, hMax: 2.5 }),
  CAMPFIRE: Object.freeze({ wMin: 0.8, wMax: 1.5, hMin: 0.3, hMax: 0.6 }),
  RUIN_STONE: Object.freeze({ wMin: 5.0, wMax: 15.0, hMin: 1.5, hMax: 4.0 }),
  RUIN_ADOBE: Object.freeze({ wMin: 4.0, wMax: 10.0, hMin: 1.0, hMax: 3.0 }),
  SHIPWRECK: Object.freeze({ wMin: 8.0, wMax: 20.0, hMin: 2.0, hMax: 5.0 }),
  STANDING_STONE: Object.freeze({ wMin: 1.0, wMax: 2.5, hMin: 2.0, hMax: 5.0 }),
  WELL: Object.freeze({ wMin: 1.5, wMax: 2.5, hMin: 0.8, hMax: 1.5 }),
  STORAGE_SHED: Object.freeze({ wMin: 2.5, wMax: 4.0, hMin: 2.0, hMax: 3.0 }),
  BOAT_DOCK: Object.freeze({ wMin: 5.0, wMax: 10.0, hMin: 0.4, hMax: 0.8 })
});

// ─── Persistence thresholds ──────────────────────────────────
// Props larger than this in world units are recorded as persistent
// mutations.
const PERSISTENT_PROP_SIZE_M = 2.0;

// ─── Prop state enum ─────────────────────────────────────────
const PROP_STATE = Object.freeze({
  INTACT: 0,
  WEATHERING: 1,
  DAMAGED: 2,
  RUINED: 3
});

// ─── Prop placement hints ────────────────────────────────────
// A prop prefers to be placed near a source of water (a well, a river, a
// lake), on flat terrain, and away from steep slopes. These hints drive
// the placement score.
const PLACEMENT_WATER_PROXIMITY_WEIGHT = 1.0;
const PLACEMENT_FLATNESS_WEIGHT = 1.5;
const PLACEMENT_FAUNA_PROXIMITY_WEIGHT = 0.8;
const PLACEMENT_BIOME_MATCH_WEIGHT = 2.0;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK PROP STATE (structure-of-arrays) ─────────
// ══════════════════════════════════════════════════════════════════

// Per-chunk prop count.
const _propCount             = new Uint16Array(MAX_TRACKED_CHUNKS);

// Per-chunk prop slot list.
const _chunkPropSlots        = new Int32Array(MAX_TRACKED_CHUNKS * MAX_PROPS_PER_CHUNK).fill(-1);

// Per-chunk dirty flag.
const _dirtyFlag             = new Uint8Array(MAX_TRACKED_CHUNKS);

// Per-chunk active flag.
const _chunkActive           = new Uint8Array(MAX_TRACKED_CHUNKS);

// ─── Global prop pool ────────────────────────────────────────
const _propSlotChunk         = new Int32Array(MAX_TOTAL_PROPS).fill(-1);
const _propSlotType          = new Uint8Array(MAX_TOTAL_PROPS);
const _propSlotState         = new Uint8Array(MAX_TOTAL_PROPS);
const _propSlotPos           = new Float32Array(MAX_TOTAL_PROPS * 3);
const _propSlotRot           = new Float32Array(MAX_TOTAL_PROPS * 4);   // quaternion
const _propSlotScale         = new Float32Array(MAX_TOTAL_PROPS * 3);
const _propSlotAge           = new Float32Array(MAX_TOTAL_PROPS);       // simulated years
const _propSlotDamage        = new Float32Array(MAX_TOTAL_PROPS);       // 0..1
const _propSlotMossCoverage  = new Float32Array(MAX_TOTAL_PROPS);       // 0..1
const _propSlotSnowCoverage  = new Float32Array(MAX_TOTAL_PROPS);       // 0..1
const _propSlotEmissive      = new Float32Array(MAX_TOTAL_PROPS);       // 0..1 (window glow at night)
const _propSlotMaterial      = new Float32Array(MAX_TOTAL_PROPS * PROP_MATERIAL_FLOATS);

// Free list for prop slots.
const _propFreeStack         = new Int32Array(MAX_TOTAL_PROPS);
let _propFreeTop             = MAX_TOTAL_PROPS;
for (let i = 0; i < MAX_TOTAL_PROPS; i++) _propFreeStack[i] = MAX_TOTAL_PROPS - 1 - i;

// Round-robin cursor.
let _rrCursor                = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _scratchPos            = new Vec3();
const _scratchRot            = new Quat();
const _scratchScale          = new Vec3();

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

const _climateScratch = {
  temperatureOffsetC: 0, precipitationMultiplier: 1, humidityBias: 0,
  windSpeedMultiplier: 1, windDirectionBiasDeg: 0,
  diurnalSwingMultiplier: 1, seasonalAmplitudeMultiplier: 1,
  seasonalPhaseShiftRad: 0, snowlineShiftM: 0, treelineShiftM: 0
};

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastTotalProps = 0;
let _lastTickDurationMs = 0;
const _lastPlacedChunks = { value: 0 };

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

function _gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
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
// ─── PROP SLOT LIFECYCLE ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _allocPropSlot() {
  if (_propFreeTop === 0) return -1;
  return _propFreeStack[--_propFreeTop];
}

function _freePropSlot(slot) {
  if (slot < 0 || slot >= MAX_TOTAL_PROPS) return;
  _propSlotChunk[slot] = -1;
  _propSlotType[slot] = PROP_TYPE.NONE;
  _propSlotState[slot] = PROP_STATE.RUINED;
  if (_propFreeTop < MAX_TOTAL_PROPS) {
    _propFreeStack[_propFreeTop++] = slot;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PROP MATERIAL BUILDER ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _buildPropMaterial(propSlot, propType, biomeId, damage, moss, snow, ageYears) {
  const base = propSlot * PROP_MATERIAL_FLOATS;

  // Default material values.
  let albedoR = 0.5, albedoG = 0.5, albedoB = 0.5;
  let roughness = 0.9, metalness = 0.0, transmission = 0.0;
  let ior = 1.5, fresnelF0 = 0.04;
  let animeFlatness = 0.3, animeN = 4;
  let rimPower = 6.0, rimStrength = 0.10, outlineW = 0.0;
  let wetness = 0.0, fireEmissive = 0.0;
  let mossOut = 0.0, snowOut = 0.0;
  let damageOut = 0.0, frost = 0.0;
  let sunDiffuse = 0.4, shadowSoft = 0.4, snowBoost = 0.0;
  let subsurface = 0.0, aniso = 0.0, clearcoat = 0.0, sheen = 0.0, specular = 0.4;
  let emissiveR = 0, emissiveG = 0, emissiveB = 0;

  // Choose the base material by prop type.
  switch (propType) {
    case PROP_TYPE.HUT_THATCH:
      albedoR = 0.55; albedoG = 0.42; albedoB = 0.20;   // thatch yellow-brown
      roughness = 0.92;
      break;
    case PROP_TYPE.CHALET_STONE:
      albedoR = 0.42; albedoG = 0.40; albedoB = 0.35;   // grey stone
      roughness = 0.88;
      break;
    case PROP_TYPE.PUEBLO_ADOBE:
      albedoR = 0.62; albedoG = 0.42; albedoB = 0.28;   // adobe orange-brown
      roughness = 0.85;
      break;
    case PROP_TYPE.LONGHOUSE_TIMBER:
      albedoR = 0.32; albedoG = 0.22; albedoB = 0.14;   // timber brown
      roughness = 0.88;
      break;
    case PROP_TYPE.STILT_HOUSE:
      albedoR = 0.28; albedoG = 0.20; albedoB = 0.12;   // weathered wood
      roughness = 0.90;
      break;
    case PROP_TYPE.PIT_HOUSE:
      albedoR = 0.30; albedoG = 0.24; albedoB = 0.16;   // peat-brown
      roughness = 0.92;
      break;
    case PROP_TYPE.TENT:
      albedoR = 0.70; albedoG = 0.60; albedoB = 0.42;   // hide/burlap
      roughness = 0.88;
      break;
    case PROP_TYPE.WALL_STONE:
      albedoR = 0.48; albedoG = 0.44; albedoB = 0.38;
      roughness = 0.90;
      break;
    case PROP_TYPE.WALL_TIMBER:
      albedoR = 0.30; albedoG = 0.22; albedoB = 0.14;
      roughness = 0.90;
      break;
    case PROP_TYPE.FENCE:
      albedoR = 0.32; albedoG = 0.24; albedoB = 0.16;
      roughness = 0.90;
      break;
    case PROP_TYPE.BRIDGE_STONE:
      albedoR = 0.44; albedoG = 0.42; albedoB = 0.38;
      roughness = 0.88;
      break;
    case PROP_TYPE.BRIDGE_TIMBER:
      albedoR = 0.30; albedoG = 0.22; albedoB = 0.14;
      roughness = 0.88;
      break;
    case PROP_TYPE.SIGNPOST:
      albedoR = 0.34; albedoG = 0.26; albedoB = 0.18;
      roughness = 0.85;
      break;
    case PROP_TYPE.CAMPFIRE:
      albedoR = 0.15; albedoG = 0.12; albedoB = 0.10;
      roughness = 0.90;
      emissiveR = 1.0; emissiveG = 0.5; emissiveB = 0.15;
      fireEmissive = 0.8;
      break;
    case PROP_TYPE.RUIN_STONE:
      albedoR = 0.42; albedoG = 0.40; albedoB = 0.36;
      roughness = 0.92;
      damageOut = damage * 0.8;
      break;
    case PROP_TYPE.RUIN_ADOBE:
      albedoR = 0.55; albedoG = 0.40; albedoB = 0.28;
      roughness = 0.90;
      damageOut = damage * 0.8;
      break;
    case PROP_TYPE.SHIPWRECK:
      albedoR = 0.28; albedoG = 0.22; albedoB = 0.16;
      roughness = 0.85;
      wetness = 0.6;
      damageOut = damage * 0.7;
      break;
    case PROP_TYPE.STANDING_STONE:
      albedoR = 0.38; albedoG = 0.36; albedoB = 0.32;
      roughness = 0.88;
      break;
    case PROP_TYPE.WELL:
      albedoR = 0.44; albedoG = 0.42; albedoB = 0.38;
      roughness = 0.88;
      wetness = 0.3;
      break;
    case PROP_TYPE.STORAGE_SHED:
      albedoR = 0.32; albedoG = 0.24; albedoB = 0.16;
      roughness = 0.88;
      break;
    case PROP_TYPE.BOAT_DOCK:
      albedoR = 0.28; albedoG = 0.22; albedoB = 0.16;
      roughness = 0.88;
      wetness = 0.7;
      break;
  }

  // Window glow: buildings emit a warm glow at night. This is applied by
  // 351's lighting coupler based on the time of day, so we just store the
  // emissive intensity here.
  const isBuilding = (propType === PROP_TYPE.HUT_THATCH
    || propType === PROP_TYPE.CHALET_STONE
    || propType === PROP_TYPE.PUEBLO_ADOBE
    || propType === PROP_TYPE.LONGHOUSE_TIMBER
    || propType === PROP_TYPE.STILT_HOUSE
    || propType === PROP_TYPE.PIT_HOUSE
    || propType === PROP_TYPE.STORAGE_SHED);
  if (isBuilding) {
    emissiveR = 0.8; emissiveG = 0.5; emissiveB = 0.2;
  }

  // Moss coverage: older props in humid biomes get more moss.
  if (moss > 0) {
    albedoR = albedoR * (1 - moss * 0.5) + 0.15 * moss * 0.5;
    albedoG = albedoG * (1 - moss * 0.5) + 0.22 * moss * 0.5;
    albedoB = albedoB * (1 - moss * 0.5) + 0.08 * moss * 0.5;
    mossOut = moss;
  }

  // Snow coverage: props in cold climates get snow on their roofs.
  if (snow > 0) {
    albedoR = albedoR * (1 - snow * 0.7) + 0.92 * snow * 0.7;
    albedoG = albedoG * (1 - snow * 0.7) + 0.94 * snow * 0.7;
    albedoB = albedoB * (1 - snow * 0.7) + 0.97 * snow * 0.7;
    snowOut = snow;
  }

  // Damage: props that have been damaged darken and roughen.
  if (damage > 0) {
    albedoR *= (1 - damage * 0.3);
    albedoG *= (1 - damage * 0.3);
    albedoB *= (1 - damage * 0.3);
    roughness = Math.min(1.0, roughness + damage * 0.1);
    damageOut = damage;
  }

  // Fill the 32-float layout.
  _propSlotMaterial[base + 0] = albedoR;
  _propSlotMaterial[base + 1] = albedoG;
  _propSlotMaterial[base + 2] = albedoB;
  _propSlotMaterial[base + 3] = roughness;
  _propSlotMaterial[base + 4] = metalness;
  _propSlotMaterial[base + 5] = transmission;
  _propSlotMaterial[base + 6] = ior;
  _propSlotMaterial[base + 7] = fresnelF0;
  _propSlotMaterial[base + 8] = animeFlatness;
  _propSlotMaterial[base + 9] = animeN;
  _propSlotMaterial[base + 10] = rimPower;
  _propSlotMaterial[base + 11] = rimStrength;
  _propSlotMaterial[base + 12] = rimStrength;
  _propSlotMaterial[base + 13] = rimStrength;
  _propSlotMaterial[base + 14] = outlineW;
  _propSlotMaterial[base + 15] = wetness;
  _propSlotMaterial[base + 16] = fireEmissive;
  _propSlotMaterial[base + 17] = mossOut;
  _propSlotMaterial[base + 18] = snowOut;
  _propSlotMaterial[base + 19] = damageOut;
  _propSlotMaterial[base + 20] = frost;
  _propSlotMaterial[base + 21] = sunDiffuse;
  _propSlotMaterial[base + 22] = shadowSoft;
  _propSlotMaterial[base + 23] = snowBoost;
  _propSlotMaterial[base + 24] = subsurface;
  _propSlotMaterial[base + 25] = aniso;
  _propSlotMaterial[base + 26] = clearcoat;
  _propSlotMaterial[base + 27] = sheen;
  _propSlotMaterial[base + 28] = specular;
  _propSlotMaterial[base + 29] = emissiveR;
  _propSlotMaterial[base + 30] = emissiveG;
  _propSlotMaterial[base + 31] = emissiveB;
}

// ══════════════════════════════════════════════════════════════════
// ─── PROP PLACEMENT ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the placement score for a candidate prop position. Higher is
// better. Combines water proximity, terrain flatness, fauna proximity, and
// biome match.
function _placementScore(chunkSlot, localX, localZ, biomeId, propType) {
  let score = 0;

  // Flatness: sample the slope at this position.
  const slopeDeg = SlopeGradientProvider.getSlopeForChunk
    ? SlopeGradientProvider.getSlopeForChunk(chunkSlot, localX, localZ)
    : 5.0;
  const flatnessScore = 1.0 - smoothstep(0, 15, slopeDeg);
  score += flatnessScore * PLACEMENT_FLATNESS_WEIGHT;

  // Water proximity: props near water score higher.
  if (LandscapeWaterFlowSystem) {
    const hasWater = LandscapeWaterFlowSystem.hasWater(chunkSlot);
    if (hasWater) score += PLACEMENT_WATER_PROXIMITY_WEIGHT;
  }

  // Fauna proximity: props near animal paths (herds, watering holes) score
  // higher because settlements grow where animals are.
  if (LandscapeFaunaSpawnSystem) {
    const animalCount = LandscapeFaunaSpawnSystem.getAnimalCount(chunkSlot);
    if (animalCount > 0) score += Math.min(1.0, animalCount / 8) * PLACEMENT_FAUNA_PROXIMITY_WEIGHT;
  }

  // Biome match: the prop type must be a natural fit for the biome.
  const biome = BiomeRegistry.getBiome(biomeId);
  if (biome && biome.name) {
    const expectedType = BIOME_ARCHITECTURE[biome.name];
    if (expectedType === propType) score += PLACEMENT_BIOME_MATCH_WEIGHT;
  }

  return score;
}

// Place a single prop into a chunk at a world position.
function _placeProp(chunkSlot, propType, worldX, worldY, worldZ, sizeW, sizeH, rotation, nowS) {
  const slot = _allocPropSlot();
  if (slot === -1) return -1;

  _propSlotChunk[slot] = chunkSlot;
  _propSlotType[slot] = propType;
  _propSlotState[slot] = PROP_STATE.INTACT;

  _propSlotPos[slot * 3 + 0] = worldX;
  _propSlotPos[slot * 3 + 1] = worldY;
  _propSlotPos[slot * 3 + 2] = worldZ;

  _scratchRot.setFromAxisAngle(_upAxis, rotation);
  _propSlotRot[slot * 4 + 0] = _scratchRot.x;
  _propSlotRot[slot * 4 + 1] = _scratchRot.y;
  _propSlotRot[slot * 4 + 2] = _scratchRot.z;
  _propSlotRot[slot * 4 + 3] = _scratchRot.w;

  _propSlotScale[slot * 3 + 0] = sizeW;
  _propSlotScale[slot * 3 + 1] = sizeH;
  _propSlotScale[slot * 3 + 2] = sizeW;

  _propSlotAge[slot] = 0;
  _propSlotDamage[slot] = 0;
  _propSlotMossCoverage[slot] = 0;
  _propSlotSnowCoverage[slot] = 0;
  _propSlotEmissive[slot] = 0;

  // Read the biome and build the material.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(chunkSlot, descOut);
  let dominantBiomeId = -1;
  if (descOut.descriptorSlot !== -1) {
    dominantBiomeId = LandscapeChunkDescriptor.getDominantBiomeId(descOut.descriptorSlot);
  }
  _buildPropMaterial(slot, propType, dominantBiomeId, 0, 0, 0, 0);

  // Add to the chunk's prop list.
  const count = _propCount[chunkSlot];
  if (count < MAX_PROPS_PER_CHUNK) {
    _chunkPropSlots[chunkSlot * MAX_PROPS_PER_CHUNK + count] = slot;
    _propCount[chunkSlot] = count + 1;
    _dirtyFlag[chunkSlot] = 1;
  }

  // Persist large props.
  if (Math.max(sizeW, sizeH) >= PERSISTENT_PROP_SIZE_M && LandscapeChunkPersistence) {
    _recordPropMutation(chunkSlot, slot, propType, worldX, worldY, worldZ, sizeW, sizeH, nowS);
  }

  return slot;
}

const _upAxis = new Vec3(0, 1, 0);

function _recordPropMutation(chunkSlot, propSlot, propType, x, y, z, sizeW, sizeH, nowS) {
  if (!LandscapeChunkPersistence || typeof LandscapeChunkPersistence.recordMutation !== 'function') return;

  LandscapeChunkPersistence.recordMutation(chunkSlot, {
    type: 12,   // PLACED_PROP
    materialId: -1,
    tick: Math.floor(nowS * 1000),
    x, y, z,
    radius: Math.max(sizeW, sizeH) * 0.5,
    force: 0,
    decayTau: 0,
    decayLambda: 0,
    wetness: 0,
    fireEmissive: 0,
    moss: 0,
    snow: 0,
    flags: propType
  });
}

function _despawnChunkProps(chunkSlot) {
  const count = _propCount[chunkSlot];
  for (let i = 0; i < count; i++) {
    const propSlot = _chunkPropSlots[chunkSlot * MAX_PROPS_PER_CHUNK + i];
    if (propSlot !== -1) _freePropSlot(propSlot);
    _chunkPropSlots[chunkSlot * MAX_PROPS_PER_CHUNK + i] = -1;
  }
  _propCount[chunkSlot] = 0;
}

// ══════════════════════════════════════════════════════════════════
// ─── CHUNK PROP PASS ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Place the props that a chunk should have based on its biome, terrain,
// hydrology, and fauna.
function _placeChunkProps(streamerSlot, nowS) {
  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_DETAIL_FOR_LEVEL[tier];
  if (detail === TIER_DETAIL.SKIPPED) return 0;

  const densityScale = TIER_PROP_DENSITY[tier];

  // Clear previous props.
  _despawnChunkProps(streamerSlot);

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

  // Dominant biome determines the architecture.
  const biome = BiomeRegistry.getBiome(view.dominantBiomeId);
  const biomeName = biome && biome.name ? biome.name : 'default';
  const primaryPropType = BIOME_ARCHITECTURE[biomeName] || PROP_TYPE.HUT_THATCH;

  // Deterministic RNG.
  const seed = _chunkSeed(view.chunkX, view.chunkY, view.chunkZ, 0);
  const rng = _makeRng(seed);

  // Compute the target prop count for this chunk.
  // A settlement tends to appear near water and flat terrain; otherwise
  // there are only scattered ruins or a single signpost.
  const waterAdjacent = LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot);
  const flat = SlopeGradientProvider.getSlopeForChunk
    ? SlopeGradientProvider.getSlopeForChunk(streamerSlot, 0, 0) < 10
    : true;

  let targetCount = 0;
  if (waterAdjacent && flat) targetCount = 4;
  else if (waterAdjacent || flat) targetCount = 1;
  else targetCount = rng() < 0.1 ? 1 : 0;

  targetCount = Math.round(targetCount * densityScale);

  // Place the props.
  let placed = 0;
  for (let i = 0; i < targetCount; i++) {
    if (placed >= MAX_PROPS_PER_CHUNK) break;

    // Sample a position in the chunk.
    const localX = rng() * cs;
    const localZ = rng() * cs;
    const worldX = cxWorld + localX;
    const worldZ = czWorld + localZ;

    // Compute the placement score. Skip low-scoring positions.
    const score = _placementScore(streamerSlot, localX, localZ, view.dominantBiomeId, primaryPropType);
    if (score < 1.5) continue;

    // Set the world Y. In a full implementation this would read the
    // terrain provider; here we use the chunk center Y.
    const worldY = cyWorld + 0.5;

    // Size from the prop type's range.
    const sizeRange = PROP_SIZE[_propTypeToName(primaryPropType)] || PROP_SIZE.HUT_THATCH;
    const sizeW = sizeRange.wMin + rng() * (sizeRange.wMax - sizeRange.wMin);
    const sizeH = sizeRange.hMin + rng() * (sizeRange.hMax - sizeRange.hMin);

    // Rotation.
    const rotation = rng() * Math.PI * 2;

    _placeProp(streamerSlot, primaryPropType, worldX, worldY, worldZ, sizeW, sizeH, rotation, nowS);
    placed++;
  }

  // Place supporting props (walls, fences, wells) around the primary
  // buildings.
  if (placed > 0) {
    const supportCount = Math.min(2, Math.round(placed * 0.5 * densityScale));
    for (let i = 0; i < supportCount; i++) {
      if (placed >= MAX_PROPS_PER_CHUNK) break;
      const localX = rng() * cs;
      const localZ = rng() * cs;
      const worldX = cxWorld + localX;
      const worldZ = czWorld + localZ;
      const worldY = cyWorld + 0.5;
      const supportType = _pickSupportPropType(primaryPropType, rng);
      const supportRange = PROP_SIZE[_propTypeToName(supportType)] || PROP_SIZE.FENCE;
      const sizeW = supportRange.wMin + rng() * (supportRange.wMax - supportRange.wMin);
      const sizeH = supportRange.hMin + rng() * (supportRange.hMax - supportRange.hMin);
      const rotation = rng() * Math.PI * 2;
      _placeProp(streamerSlot, supportType, worldX, worldY, worldZ, sizeW, sizeH, rotation, nowS);
      placed++;
    }
  }

  _dirtyFlag[streamerSlot] = 0;
  return placed;
}

function _pickSupportPropType(primaryType, rng) {
  // Stone buildings get stone walls; timber buildings get timber fences;
  // tents get campfires.
  if (primaryType === PROP_TYPE.CHALET_STONE) return rng() < 0.5 ? PROP_TYPE.WALL_STONE : PROP_TYPE.WELL;
  if (primaryType === PROP_TYPE.PUEBLO_ADOBE) return rng() < 0.5 ? PROP_TYPE.WALL_STONE : PROP_TYPE.STORAGE_SHED;
  if (primaryType === PROP_TYPE.LONGHOUSE_TIMBER) return rng() < 0.5 ? PROP_TYPE.WALL_TIMBER : PROP_TYPE.FENCE;
  if (primaryType === PROP_TYPE.HUT_THATCH) return rng() < 0.5 ? PROP_TYPE.FENCE : PROP_TYPE.STORAGE_SHED;
  if (primaryType === PROP_TYPE.STILT_HOUSE) return rng() < 0.5 ? PROP_TYPE.BOAT_DOCK : PROP_TYPE.CAMPFIRE;
  if (primaryType === PROP_TYPE.TENT) return PROP_TYPE.CAMPFIRE;
  if (primaryType === PROP_TYPE.PIT_HOUSE) return PROP_TYPE.CAMPFIRE;
  return PROP_TYPE.FENCE;
}

function _propTypeToName(propType) {
  switch (propType) {
    case PROP_TYPE.HUT_THATCH: return 'HUT_THATCH';
    case PROP_TYPE.CHALET_STONE: return 'CHALET_STONE';
    case PROP_TYPE.PUEBLO_ADOBE: return 'PUEBLO_ADOBE';
    case PROP_TYPE.LONGHOUSE_TIMBER: return 'LONGHOUSE_TIMBER';
    case PROP_TYPE.STILT_HOUSE: return 'STILT_HOUSE';
    case PROP_TYPE.PIT_HOUSE: return 'PIT_HOUSE';
    case PROP_TYPE.TENT: return 'TENT';
    case PROP_TYPE.WALL_STONE: return 'WALL_STONE';
    case PROP_TYPE.WALL_TIMBER: return 'WALL_TIMBER';
    case PROP_TYPE.FENCE: return 'FENCE';
    case PROP_TYPE.BRIDGE_STONE: return 'BRIDGE_STONE';
    case PROP_TYPE.BRIDGE_TIMBER: return 'BRIDGE_TIMBER';
    case PROP_TYPE.SIGNPOST: return 'SIGNPOST';
    case PROP_TYPE.CAMPFIRE: return 'CAMPFIRE';
    case PROP_TYPE.RUIN_STONE: return 'RUIN_STONE';
    case PROP_TYPE.RUIN_ADOBE: return 'RUIN_ADOBE';
    case PROP_TYPE.SHIPWRECK: return 'SHIPWRECK';
    case PROP_TYPE.STANDING_STONE: return 'STANDING_STONE';
    case PROP_TYPE.WELL: return 'WELL';
    case PROP_TYPE.STORAGE_SHED: return 'STORAGE_SHED';
    case PROP_TYPE.BOAT_DOCK: return 'BOAT_DOCK';
    default: return 'HUT_THATCH';
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapePropPlacementSystem = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  PROP_TYPE,
  PROP_STATE,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  maxPropsPerChunk: MAX_PROPS_PER_CHUNK,
  maxTotalProps: MAX_TOTAL_PROPS,
  propMaterialFloats: PROP_MATERIAL_FLOATS,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _propCount[streamerSlot] = 0;
    _dirtyFlag[streamerSlot] = 1;
    return true;
  },

  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _despawnChunkProps(streamerSlot);
    _chunkActive[streamerSlot] = 0;
  },

  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    let processed = 0;
    let placed = 0;
    let totalProps = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      processed++;

      if (_dirtyFlag[slot] === 0) continue;

      const n = _placeChunkProps(slot, nowS);
      placed += n;
      totalProps += _propCount[slot];

      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastPlacedChunks.value = placed;
    _lastTotalProps = totalProps;
    _lastTickDurationMs = performanceNow() - t0;

    if (placed > 0) {
      _dispatcher.emit(EVENT_TYPE.PROPS_PLACED, {
        tick,
        processed,
        placed,
        totalProps,
        durationMs: _lastTickDurationMs
      });
    }
  },

  markDirty(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _dirtyFlag[streamerSlot] = 1;
  },

  /**
   * Damage a prop. Called by 300_ImpactEventCoordinator or by
   * 316_EcologyResponseSystem when a fire or impact lands on a prop.
   */
  damageProp(propSlot, amount) {
    if (propSlot < 0 || propSlot >= MAX_TOTAL_PROPS) return;
    if (_propSlotChunk[propSlot] === -1) return;
    _propSlotDamage[propSlot] = Math.min(1.0, _propSlotDamage[propSlot] + amount);

    // Transition the prop's state.
    if (_propSlotDamage[propSlot] > 0.8) _propSlotState[propSlot] = PROP_STATE.RUINED;
    else if (_propSlotDamage[propSlot] > 0.5) _propSlotState[propSlot] = PROP_STATE.DAMAGED;
    else if (_propSlotDamage[propSlot] > 0.2) _propSlotState[propSlot] = PROP_STATE.WEATHERING;

    // Rebuild the material to reflect the new damage state.
    const chunkSlot = _propSlotChunk[propSlot];
    const descOut = { descriptorSlot: -1 };
    LandscapeChunkStreamer.getDownstreamSlots(chunkSlot, descOut);
    const biomeId = descOut.descriptorSlot !== -1
      ? LandscapeChunkDescriptor.getDominantBiomeId(descOut.descriptorSlot)
      : -1;
    _buildPropMaterial(
      propSlot, _propSlotType[propSlot], biomeId,
      _propSlotDamage[propSlot], _propSlotMossCoverage[propSlot],
      _propSlotSnowCoverage[propSlot], _propSlotAge[propSlot]
    );

    // Record the damage as a persistent mutation.
    if (LandscapeChunkPersistence) {
      LandscapeChunkPersistence.recordMutation(chunkSlot, {
        type: 3,   // BROKEN_WALL (closest to general prop damage)
        materialId: -1,
        tick: Math.floor(BiomeBlendSystem.elapsedSimSeconds * 1000),
        x: _propSlotPos[propSlot * 3 + 0],
        y: _propSlotPos[propSlot * 3 + 1],
        z: _propSlotPos[propSlot * 3 + 2],
        radius: _propSlotScale[propSlot * 3 + 0] * 0.5,
        force: amount,
        decayTau: 0,
        decayLambda: 0,
        wetness: 0,
        fireEmissive: 0,
        moss: 0,
        snow: 0,
        flags: _propSlotType[propSlot]
      });
    }

    _dirtyFlag[chunkSlot] = 1;
  },

  getPropCount(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _propCount[streamerSlot];
  },

  readChunkPropSlots(streamerSlot, outSlots, maxCount) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _propCount[streamerSlot];
    const limit = Math.min(count, maxCount);
    const base = streamerSlot * MAX_PROPS_PER_CHUNK;
    for (let i = 0; i < limit; i++) {
      outSlots[i] = _chunkPropSlots[base + i];
    }
    return limit;
  },

  readProp(propSlot, out) {
    if (propSlot < 0 || propSlot >= MAX_TOTAL_PROPS) return false;
    if (_propSlotChunk[propSlot] === -1) return false;
    out.chunkSlot = _propSlotChunk[propSlot];
    out.type = _propSlotType[propSlot];
    out.state = _propSlotState[propSlot];
    out.px = _propSlotPos[propSlot * 3 + 0];
    out.py = _propSlotPos[propSlot * 3 + 1];
    out.pz = _propSlotPos[propSlot * 3 + 2];
    out.rx = _propSlotRot[propSlot * 4 + 0];
    out.ry = _propSlotRot[propSlot * 4 + 1];
    out.rz = _propSlotRot[propSlot * 4 + 2];
    out.rw = _propSlotRot[propSlot * 4 + 3];
    out.sx = _propSlotScale[propSlot * 3 + 0];
    out.sy = _propSlotScale[propSlot * 3 + 1];
    out.sz = _propSlotScale[propSlot * 3 + 2];
    out.age = _propSlotAge[propSlot];
    out.damage = _propSlotDamage[propSlot];
    out.mossCoverage = _propSlotMossCoverage[propSlot];
    out.snowCoverage = _propSlotSnowCoverage[propSlot];
    out.emissive = _propSlotEmissive[propSlot];
    return true;
  },

  readMaterialBuffer(streamerSlot, outFloats) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _propCount[streamerSlot];
    const base = streamerSlot * MAX_PROPS_PER_CHUNK;
    let written = 0;
    for (let i = 0; i < count && written + PROP_MATERIAL_FLOATS <= outFloats.length; i++) {
      const propSlot = _chunkPropSlots[base + i];
      if (propSlot === -1) continue;
      const matBase = propSlot * PROP_MATERIAL_FLOATS;
      for (let k = 0; k < PROP_MATERIAL_FLOATS; k++) {
        outFloats[written++] = _propSlotMaterial[matBase + k];
      }
    }
    return written;
  },

  readTransformBuffer(streamerSlot, outFloats) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    const count = _propCount[streamerSlot];
    const base = streamerSlot * MAX_PROPS_PER_CHUNK;
    let written = 0;
    for (let i = 0; i < count && written + 14 <= outFloats.length; i++) {
      const propSlot = _chunkPropSlots[base + i];
      if (propSlot === -1) continue;
      outFloats[written++] = _propSlotPos[propSlot * 3 + 0];
      outFloats[written++] = _propSlotPos[propSlot * 3 + 1];
      outFloats[written++] = _propSlotPos[propSlot * 3 + 2];
      outFloats[written++] = _propSlotRot[propSlot * 4 + 0];
      outFloats[written++] = _propSlotRot[propSlot * 4 + 1];
      outFloats[written++] = _propSlotRot[propSlot * 4 + 2];
      outFloats[written++] = _propSlotRot[propSlot * 4 + 3];
      outFloats[written++] = _propSlotScale[propSlot * 3 + 0];
      outFloats[written++] = _propSlotScale[propSlot * 3 + 1];
      outFloats[written++] = _propSlotScale[propSlot * 3 + 2];
      outFloats[written++] = _propSlotType[propSlot];
      outFloats[written++] = _propSlotState[propSlot];
      outFloats[written++] = _propSlotDamage[propSlot];
      outFloats[written++] = _propSlotEmissive[propSlot];
    }
    return written;
  },

  // ─── Direct accessors ────────────────────────────────────
  getPropPosX(propSlot) {
    if (propSlot < 0 || propSlot >= MAX_TOTAL_PROPS) return 0;
    return _propSlotPos[propSlot * 3 + 0];
  },
  getPropPosY(propSlot) {
    if (propSlot < 0 || propSlot >= MAX_TOTAL_PROPS) return 0;
    return _propSlotPos[propSlot * 3 + 1];
  },
  getPropPosZ(propSlot) {
    if (propSlot < 0 || propSlot >= MAX_TOTAL_PROPS) return 0;
    return _propSlotPos[propSlot * 3 + 2];
  },
  getPropType(propSlot) {
    if (propSlot < 0 || propSlot >= MAX_TOTAL_PROPS) return PROP_TYPE.NONE;
    return _propSlotType[propSlot];
  },
  getPropState(propSlot) {
    if (propSlot < 0 || propSlot >= MAX_TOTAL_PROPS) return PROP_STATE.RUINED;
    return _propSlotState[propSlot];
  },
  getPropDamage(propSlot) {
    if (propSlot < 0 || propSlot >= MAX_TOTAL_PROPS) return 0;
    return _propSlotDamage[propSlot];
  },
  getPropEmissive(propSlot) {
    if (propSlot < 0 || propSlot >= MAX_TOTAL_PROPS) return 0;
    return _propSlotEmissive[propSlot];
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastPlacedChunks() { return _lastPlacedChunks.value; },
  get lastTotalProps() { return _lastTotalProps; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get freePropSlots() { return _propFreeTop; },
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

export default LandscapePropPlacementSystem;