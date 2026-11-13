// file number : 357
// full path name : src/context/357_LandscapeEventBudget.js
// description : Landscape event budget — the 10 Hz consumer that collapses and
// coalesces procedural events so a single physical event (a fireball striking
// a forest, a meteor impact, a large erosion event, a storm surge, a volcanic
// eruption, or a lightning strike) generates one causal event with a
// scheduled spread over time rather than fifty independent events. It
// enforces the blueprint's "a fireball hitting a forest generates one causal
// event, not fifty" rule, and it implements the blueprint's spread formula
//   dr/dt = c · D(τ) · φ_biome
// where c is the per-event spread coefficient, D(τ) is the exponential decay
// of the event's freshness (D(τ) = exp(-τ/τ_event)), and φ_biome is the
// biome's own spread propensity (rainforest spreads fast, desert spreads
// slowly, water suppresses spread entirely). The system maintains a pooled
// set of active spread events, each with a centroid, a radius, an age, a
// biome-weighted spread coefficient, and a list of affected chunk slots.
// Every tick it advances each active event's radius by the spread formula,
// queries which loaded chunks the new radius covers, and emits one
// consolidated CAUSAL_EVENT per event per tick rather than one per chunk.
// The result is that a fireball hitting a forest produces exactly one event
// stream whose downstream consumers (316_EcologyResponseSystem for ignition,
// 343/344 for erosion, 348 for decals, 349 for prop damage, 351 for lighting
// flash, 352 for smoke plume, 354 for sensory cue) all read from the same
// event, so the world reacts to the fireball as a single coherent phenomenon
// rather than as fifty independent notifications. The system is fully
// tier-aware: the spread computation runs at every tier, but the per-tick
// chunk-query radius is capped per tier so a spread event that reaches the
// THOUSAND_KILOMETER tier does not force the system to enumerate every
// chunk in that ring. Events that reach their per-event maximum age are
// retired, and events that have fully consumed their affected chunk list are
// also retired. The per-tick work is bounded by both an event budget (default
// 16 active spread events) and a per-tick CPU budget (default 1.0 ms).
// Material and lighting parameters are integrated first-class: the system
// tracks the event's fire emissive, smoke emissive, dust emissive, and
// lighting flash intensity, and it writes them into a per-event material and
// lighting record that 331_BiomeBlendMaterialBridge and
// 351_LandscapeLightingCoupler read to apply the correct post-event material
// and lighting state to every chunk inside the event's radius. A fireball's
// flash on a distant mountainside and its scorch on a nearby tree are the
// same event, and they are driven by the same material and lighting record.
// Every per-event buffer is preallocated, every hot-path computation is
// zero-allocation, and the system works identically on WebGL1 and WebGL2
// because all of its output is consumed through the standard material and
// lighting pipelines.
//#
// best for : Every consumer that reacts to large-scale procedural events —
// 300_ImpactEventCoordinator (records the single consolidated event instead
// of fifty), 316_EcologyResponseSystem (reads the event's fire emissive to
// ignite vegetation), 343_LandscapeErosionSimulator and
// 344_LandscapeWindErosionSystem (read the event's force to apply erosion),
// 345_LandscapeWaterFlowSystem (reads the event to trigger a flood or
// drought), 346_LandscapeVegetationScatterSystem (reads the event to
// suppress vegetation in the affected chunks),
// 347_LandscapeFaunaSpawnSystem (reads the event to scatter fauna from the
// affected chunks), 348_LandscapeDecalPlacementSystem (places the event's
// crater and scorch decals), 349_LandscapePropPlacementSystem (damages
// props inside the event radius), 350_LandscapeShadowScaler (reads the
// event to decide whether the affected chunks need their shadows rebuilt),
// 351_LandscapeLightingCoupler (reads the event's lighting flash to
// briefly brighten the affected chunks), 352_LandscapeSkyCoupler (reads
// the event's smoke and dust emissive to drive the sky's haze),
// 353_LandscapeSeasonCoupler (reads the event to trigger a post-fire
// successional reset), 354_LandscapeSensoryCoupler (reads the event to
// emit a single loud bang / flash / roar rather than fifty overlapping
// ones), 355_LandscapePerformanceGovernor (uses the active event count to
// arbitrate the event budget), and 356_LandscapeRebuildDeferral (uses the
// event's chunk list to schedule rebuilds behind the camera rather than
// in front of it). The event budget is the single authority on how many
// consolidated causal events exist at any time, and every consumer that
// reacts to a large-scale procedural event asks it.
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
  WebGLRenderer, WebGL2Renderer,
  Color,
  PCFSoftShadowMap, PCFShadowMap, VSMShadowMap, BasicShadowMap
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';
import { LandscapeErosionSimulator } from './343_LandscapeErosionSimulator.js';
import { LandscapeWindErosionSystem } from './344_LandscapeWindErosionSystem.js';
import { LandscapeWaterFlowSystem } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem } from './346_LandscapeVegetationScatterSystem.js';
import { LandscapeFaunaSpawnSystem } from './347_LandscapeFaunaSpawnSystem.js';
import { LandscapeDecalPlacementSystem, DECAL_TYPE } from './348_LandscapeDecalPlacementSystem.js';
import { LandscapePropPlacementSystem } from './349_LandscapePropPlacementSystem.js';
import { LandscapeShadowScaler } from './350_LandscapeShadowScaler.js';
import { LandscapeLightingCoupler } from './351_LandscapeLightingCoupler.js';
import { LandscapeSkyCoupler } from './352_LandscapeSkyCoupler.js';
import { LandscapeSeasonCoupler } from './353_LandscapeSeasonCoupler.js';
import { LandscapeSensoryCoupler } from './354_LandscapeSensoryCoupler.js';
import { LandscapePerformanceGovernor } from './355_LandscapePerformanceGovernor.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–356.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Event type identifiers. These are the "high-level" event types that are
// coalesced. Each underlying low-level event (impact, ignition, splash,
// etc.) is mapped to one of these before the budget system sees it.
const COALESCED_EVENT_TYPE = Object.freeze({
  FIREBALL: 0,
  METEOR_IMPACT: 1,
  VOLCANIC_ERUPTION: 2,
  STORM_SURGE: 3,
  LIGHTNING_STRIKE: 4,
  LANDSLIDE: 5,
  FLOOD: 6,
  DROUGHT: 7,
  MASS_EROSION: 8,
  WILDFIRE: 9,
  RESERVED_10: 10,
  RESERVED_11: 11,
  RESERVED_12: 12,
  RESERVED_13: 13,
  RESERVED_14: 14,
  RESERVED_15: 15
});

// Maximum number of simultaneously active spread events. Each event is a
// self-contained state machine with its own radius, age, and affected chunk
// list.
const MAX_ACTIVE_EVENTS = 16;

// Maximum number of affected chunks per event. When an event's radius
// grows to cover more chunks than this, the system stops tracking
// individual chunks and switches the event to "radius-only" mode — it
// continues to emit a single CAUSAL_EVENT per tick but stops enumerating
// the chunk list. This bounds the per-event memory and per-tick cost.
const MAX_CHUNKS_PER_EVENT = 512;

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Per-tick event budget — maximum number of active events advanced per tick.
const DEFAULT_TICK_EVENT_BUDGET = 16;

// Per-tick CPU budget in milliseconds.
const DEFAULT_TICK_CPU_BUDGET_MS = 1.0;

// Maximum age of an event before it is retired, in simulated seconds. The
// blueprint specifies a ten-second spread window; we allow up to
// EVENT_MAX_AGE_S to accommodate large events that need more time to
// settle.
const EVENT_MAX_AGE_S = 30.0;

// Spread timing. Events spread over the first SPREAD_WINDOW_S seconds, and
// then the event "settles" over the remaining EVENT_MAX_AGE_S seconds.
const SPREAD_WINDOW_S = 10.0;

// ─── Spread formula constants ───────────────────────────────
// dr/dt = c · D(τ) · φ_biome
// where:
//   c        — per-event spread coefficient (m/s)
//   D(τ)     — exponential decay of freshness: exp(-τ / τ_event)
//   φ_biome  — biome-weighted spread propensity in [0, 1]
const SPREAD_TAU_DECAY_S = 5.0;

// Per-event-type base spread coefficient (m/s). These are tuned so a
// wildfire spreads through a rainforest in a few seconds of simulated
// time, a flood spreads across a river delta in tens of seconds, and a
// meteor impact spreads its crater in a fraction of a second.
const EVENT_BASE_SPREAD_RATE = Object.freeze([
  8.0,     // FIREBALL           — fast
  15.0,    // METEOR_IMPACT      — very fast
  12.0,    // VOLCANIC_ERUPTION  — fast
  6.0,     // STORM_SURGE        — moderate
  20.0,    // LIGHTNING_STRIKE   — very fast (initial flash)
  3.0,     // LANDSLIDE          — slow
  4.0,     // FLOOD              — slow
  2.0,     // DROUGHT            — very slow
  5.0,     // MASS_EROSION       — moderate
  10.0,    // WILDFIRE           — fast
  5.0, 5.0, 5.0, 5.0, 5.0, 5.0   // reserved types
]);

// Per-biome spread propensity. Rainforest spreads fire fast; desert
// suppresses fire but spreads dust; aquatic biomes suppress fire but
// spread flood fast; tundra spreads slowly due to cold and permafrost.
const BIOME_SPREAD_PROPENSITY = Object.freeze({
  tropical_rainforest: 0.9,
  temperate_deciduous_forest: 0.7,
  taiga_boreal_forest: 0.6,
  taiga_boreal_coniferous_forest: 0.6,
  grassland_savanna: 0.85,   // savanna fires spread very fast
  desert: 0.3,
  tundra: 0.2,
  alpine: 0.15,
  aquatic_freshwater: 0.1,
  aquatic_marine: 0.05,
  wetland_marsh_swamp: 0.3,
  mediterranean_chaparral: 0.9,  // chaparral fires spread extremely fast
  steppe_prairie: 0.8,
  savanna_woodland: 0.85,
  mangrove_coastal: 0.2,
  temperate_rainforest: 0.5,
  subtropical_humid_forest: 0.7,
  flooding_pampa_grassland: 0.5,
  campos_grassland: 0.75,
  cerrado_savanna: 0.9,
  andean_puna_grassland: 0.15,
  canyonlands: 0.2,
  mountain_lake_valley: 0.15,
  river_delta_estuary: 0.2,
  badlands_eroded_hills: 0.1
});

// ─── Per-tier chunk-query radius cap ───────────────────────
// When an event's radius exceeds this cap for a given tier, the system
// stops querying that tier's spatial hash. This bounds the per-tick chunk
// enumeration cost regardless of how large the event gets.
const TIER_QUERY_RADIUS_CAP_M = Object.freeze([
  2000.0,    // KILOMETER
  5000.0,    // TEN_KILOMETER
  20000.0,   // HUNDRED_KILOMETER
  0.0        // THOUSAND_KILOMETER (never enumerated — too coarse)
]);

// ─── Material and lighting override constants ──────────────
// When an event is emitted, it carries a material and lighting override
// record that downstream consumers apply. The override record has 16 floats
// for material and 8 floats for lighting (matching 331 and 351 layouts).

// Fire emissive intensity per event type.
const FIRE_EMISSIVE_FIREBALL = 2.5;
const FIRE_EMISSIVE_METEOR = 3.5;
const FIRE_EMISSIVE_VOLCANO = 4.0;
const FIRE_EMISSIVE_LIGHTNING = 5.0;
const FIRE_EMISSIVE_WILDFIRE = 1.5;

// Dust emissive intensity per event type.
const DUST_EMISSIVE_METEOR = 2.0;
const DUST_EMISSIVE_LANDSLIDE = 1.5;
const DUST_EMISSIVE_EROSION = 1.0;

// Water splash intensity per event type.
const SPLASH_EMISSIVE_STORM = 1.5;
const SPLASH_EMISSIVE_FLOOD = 1.0;

// Lighting flash intensity per event type.
const LIGHTING_FLASH_FIREBALL = 3.0;
const LIGHTING_FLASH_METEOR = 5.0;
const LIGHTING_FLASH_LIGHTNING = 8.0;

// ─── Event state enum ──────────────────────────────────────
const EVENT_STATE = Object.freeze({
  INACTIVE: 0,
  SPREADING: 1,
  SETTLING: 2,
  RETIRED: 3
});

// ══════════════════════════════════════════════════════════════════
// ─── POOLED EVENT STATE (structure-of-arrays) ──────────────────
// ══════════════════════════════════════════════════════════════════

// Per-event state.
const _eventActive           = new Uint8Array(MAX_ACTIVE_EVENTS);
const _eventState            = new Uint8Array(MAX_ACTIVE_EVENTS);
const _eventType             = new Uint8Array(MAX_ACTIVE_EVENTS);

// Per-event centroid and radius.
const _eventCenterX          = new Float32Array(MAX_ACTIVE_EVENTS);
const _eventCenterY          = new Float32Array(MAX_ACTIVE_EVENTS);
const _eventCenterZ          = new Float32Array(MAX_ACTIVE_EVENTS);
const _eventRadiusM          = new Float32Array(MAX_ACTIVE_EVENTS);
const _eventMaxRadiusM       = new Float32Array(MAX_ACTIVE_EVENTS);

// Per-event timing.
const _eventStartS           = new Float32Array(MAX_ACTIVE_EVENTS).fill(-1);
const _eventLastEmitS        = new Float32Array(MAX_ACTIVE_EVENTS).fill(-1);

// Per-event spread coefficient (base rate × biome propensity).
const _eventSpreadCoeff      = new Float32Array(MAX_ACTIVE_EVENTS);

// Per-event initial force and severity.
const _eventInitialForce     = new Float32Array(MAX_ACTIVE_EVENTS);
const _eventInitialSeverity  = new Float32Array(MAX_ACTIVE_EVENTS);

// Per-event material override record (16 floats, layout matches 331).
const _eventMaterialOverride = new Float32Array(MAX_ACTIVE_EVENTS * 16);

// Per-event lighting override record (8 floats, layout matches 351).
const _eventLightingOverride = new Float32Array(MAX_ACTIVE_EVENTS * 8);

// Per-event affected chunk list. Each event owns a slice of the
// _eventAffectedChunks array of size MAX_CHUNKS_PER_EVENT. -1 entries
// indicate unused slots.
const _eventAffectedChunks   = new Int32Array(MAX_ACTIVE_EVENTS * MAX_CHUNKS_PER_EVENT).fill(-1);
const _eventAffectedCount    = new Uint16Array(MAX_ACTIVE_EVENTS);

// Per-event radius-only mode flag. When an event's radius has grown past
// MAX_CHUNKS_PER_EVENT chunks, this flag is set and the system stops
// enumerating chunks.
const _eventRadiusOnlyMode   = new Uint8Array(MAX_ACTIVE_EVENTS);

// Free list for event slots.
const _eventFreeStack        = new Int32Array(MAX_ACTIVE_EVENTS);
let _eventFreeTop            = MAX_ACTIVE_EVENTS;
for (let i = 0; i < MAX_ACTIVE_EVENTS; i++) _eventFreeStack[i] = MAX_ACTIVE_EVENTS - 1 - i;

// Active event count.
let _activeEventCount        = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Blended biome weights for the event centroid.
const _blendIdsScratch = new Int16Array(4).fill(-1);
const _blendWeightsScratch = new Float32Array(4);

// Bucket query results.
const _bucketSlots = new Int32Array(2048);

// Chunk slots in a bucket.
const _chunkSlots = new Int32Array(64);

// Scratch material override that is emitted per tick.
const _scratchMaterialOverride = new Float32Array(16);
const _scratchLightingOverride = new Float32Array(8);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastEmittedCount = 0;
let _lastRetiredCount = 0;
let _lastTickDurationMs = 0;
let _totalSpawned = 0;
let _totalEmitted = 0;
let _totalRetired = 0;

// ══════════════════════════════════════════════════════════════════
// ─── EVENT SLOT LIFECYCLE ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _allocEventSlot() {
  if (_eventFreeTop === 0) return -1;
  return _eventFreeStack[--_eventFreeTop];
}

function _freeEventSlot(slot) {
  if (slot < 0 || slot >= MAX_ACTIVE_EVENTS) return;
  _eventActive[slot] = 0;
  _eventState[slot] = EVENT_STATE.RETIRED;
  _eventAffectedCount[slot] = 0;
  _eventRadiusOnlyMode[slot] = 0;
  // Clear the affected chunk list.
  const base = slot * MAX_CHUNKS_PER_EVENT;
  for (let i = 0; i < MAX_CHUNKS_PER_EVENT; i++) _eventAffectedChunks[base + i] = -1;
  _activeEventCount = Math.max(0, _activeEventCount - 1);
  if (_eventFreeTop < MAX_ACTIVE_EVENTS) {
    _eventFreeStack[_eventFreeTop++] = slot;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── BIOME PROPENSITY AT A WORLD POINT ────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the biome-weighted spread propensity at the event's centroid.
// Queries the blend field for the nearest loaded chunk and blends the
// biome propensities by weight.
function _computeBiomePropensity(worldX, worldY, worldZ) {
  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const cx = Math.floor(worldX / cs);
  const cy = Math.floor(worldY / cs);
  const cz = Math.floor(worldZ / cs);
  const slot = LandscapeChunkStreamer.getStreamerSlot(cx, cy, cz);
  if (slot === -1) return 0.5;   // default if chunk is not loaded

  const n = BiomeBlendSystem.readBlendedWeights(slot, _blendIdsScratch, _blendWeightsScratch);
  let propensity = 0;
  let totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const biome = BiomeRegistry.getBiome(_blendIdsScratch[i]);
    if (!biome) continue;
    const p = BIOME_SPREAD_PROPENSITY[biome.name];
    if (p === undefined) continue;
    propensity += p * _blendWeightsScratch[i];
    totalWeight += _blendWeightsScratch[i];
  }
  if (totalWeight > 0) propensity /= totalWeight;
  else propensity = 0.5;
  return Math.max(0.05, Math.min(1.0, propensity));
}

// ══════════════════════════════════════════════════════════════════
// ─── MATERIAL AND LIGHTING OVERRIDE BUILDERS ──────────────────
// ══════════════════════════════════════════════════════════════════

// Build the material override record for an event slot based on its type
// and initial force. Writes into the event's material override sub-array.
function _buildEventMaterialOverride(eventSlot, eventType, initialForce) {
  const base = eventSlot * 16;
  const f = Math.min(1.0, initialForce);

  // Zero the record.
  for (let i = 0; i < 16; i++) _eventMaterialOverride[base + i] = 0;

  // Albedo delta (darkening for scorch, lightening for dust).
  let albedoDelta = 0;
  let roughnessIncrease = 0;
  let fireEmissive = 0;
  let moss = 0;
  let snow = 0;
  let damage = 0;
  let emissiveR = 0;
  let emissiveG = 0;
  let emissiveB = 0;
  let subsurface = 0;

  switch (eventType) {
    case COALESCED_EVENT_TYPE.FIREBALL:
      albedoDelta = -0.20 * f;
      roughnessIncrease = 0.10 * f;
      fireEmissive = FIRE_EMISSIVE_FIREBALL * f;
      damage = 0.5 * f;
      emissiveR = 1.0 * f;
      emissiveG = 0.55 * f;
      emissiveB = 0.20 * f;
      break;
    case COALESCED_EVENT_TYPE.METEOR_IMPACT:
      albedoDelta = -0.30 * f;
      roughnessIncrease = 0.15 * f;
      fireEmissive = FIRE_EMISSIVE_METEOR * f;
      damage = 0.8 * f;
      emissiveR = 1.0 * f;
      emissiveG = 0.60 * f;
      emissiveB = 0.25 * f;
      break;
    case COALESCED_EVENT_TYPE.VOLCANIC_ERUPTION:
      albedoDelta = -0.25 * f;
      roughnessIncrease = 0.12 * f;
      fireEmissive = FIRE_EMISSIVE_VOLCANO * f;
      damage = 0.6 * f;
      emissiveR = 1.0 * f;
      emissiveG = 0.40 * f;
      emissiveB = 0.10 * f;
      break;
    case COALESCED_EVENT_TYPE.STORM_SURGE:
      albedoDelta = -0.15 * f;
      roughnessIncrease = 0.05 * f;
      fireEmissive = 0;
      damage = 0.2 * f;
      subsurface = 0.15 * f;
      break;
    case COALESCED_EVENT_TYPE.LIGHTNING_STRIKE:
      albedoDelta = -0.20 * f;
      roughnessIncrease = 0.08 * f;
      fireEmissive = FIRE_EMISSIVE_LIGHTNING * f;
      damage = 0.4 * f;
      emissiveR = 1.0 * f;
      emissiveG = 0.9 * f;
      emissiveB = 0.7 * f;
      break;
    case COALESCED_EVENT_TYPE.LANDSLIDE:
      albedoDelta = -0.10 * f;
      roughnessIncrease = 0.20 * f;
      fireEmissive = 0;
      damage = 0.5 * f;
      break;
    case COALESCED_EVENT_TYPE.FLOOD:
      albedoDelta = -0.10 * f;
      roughnessIncrease = -0.05 * f;
      fireEmissive = 0;
      damage = 0.15 * f;
      subsurface = 0.20 * f;
      break;
    case COALESCED_EVENT_TYPE.DROUGHT:
      albedoDelta = 0.10 * f;
      roughnessIncrease = 0.05 * f;
      fireEmissive = 0;
      damage = 0.10 * f;
      break;
    case COALESCED_EVENT_TYPE.MASS_EROSION:
      albedoDelta = -0.15 * f;
      roughnessIncrease = 0.15 * f;
      fireEmissive = 0;
      damage = 0.4 * f;
      break;
    case COALESCED_EVENT_TYPE.WILDFIRE:
      albedoDelta = -0.25 * f;
      roughnessIncrease = 0.10 * f;
      fireEmissive = FIRE_EMISSIVE_WILDFIRE * f;
      damage = 0.6 * f;
      emissiveR = 1.0 * f;
      emissiveG = 0.45 * f;
      emissiveB = 0.15 * f;
      break;
    default:
      albedoDelta = -0.10 * f;
      roughnessIncrease = 0.05 * f;
      break;
  }

  // Fill the material override layout (matches 331's first 16 floats).
  _eventMaterialOverride[base + 0] = albedoDelta;   // albedo delta R
  _eventMaterialOverride[base + 1] = albedoDelta;   // albedo delta G
  _eventMaterialOverride[base + 2] = albedoDelta;   // albedo delta B
  _eventMaterialOverride[base + 3] = roughnessIncrease;
  _eventMaterialOverride[base + 4] = 0;             // metalness
  _eventMaterialOverride[base + 5] = 0;             // transmission
  _eventMaterialOverride[base + 6] = fireEmissive;
  _eventMaterialOverride[base + 7] = moss;
  _eventMaterialOverride[base + 8] = snow;
  _eventMaterialOverride[base + 9] = damage;
  _eventMaterialOverride[base + 10] = 0;            // frost
  _eventMaterialOverride[base + 11] = subsurface;
  _eventMaterialOverride[base + 12] = emissiveR;
  _eventMaterialOverride[base + 13] = emissiveG;
  _eventMaterialOverride[base + 14] = emissiveB;
  _eventMaterialOverride[base + 15] = 0;            // reserved
}

// Build the lighting override record for an event slot.
function _buildEventLightingOverride(eventSlot, eventType, initialForce) {
  const base = eventSlot * 8;
  const f = Math.min(1.0, initialForce);

  // Zero the record.
  for (let i = 0; i < 8; i++) _eventLightingOverride[base + i] = 0;

  let sunDiffuseIncrease = 0;
  let fogDensityIncrease = 0;
  let shadowSoftnessIncrease = 0;
  let flashR = 0, flashG = 0, flashB = 0;

  switch (eventType) {
    case COALESCED_EVENT_TYPE.FIREBALL:
      sunDiffuseIncrease = 0.20 * f;
      fogDensityIncrease = 0.05 * f;
      flashR = LIGHTING_FLASH_FIREBALL * f;
      flashG = LIGHTING_FLASH_FIREBALL * 0.6 * f;
      flashB = LIGHTING_FLASH_FIREBALL * 0.3 * f;
      break;
    case COALESCED_EVENT_TYPE.METEOR_IMPACT:
      sunDiffuseIncrease = 0.35 * f;
      fogDensityIncrease = 0.10 * f;
      shadowSoftnessIncrease = 0.25 * f;
      flashR = LIGHTING_FLASH_METEOR * f;
      flashG = LIGHTING_FLASH_METEOR * 0.7 * f;
      flashB = LIGHTING_FLASH_METEOR * 0.4 * f;
      break;
    case COALESCED_EVENT_TYPE.VOLCANIC_ERUPTION:
      sunDiffuseIncrease = 0.40 * f;
      fogDensityIncrease = 0.15 * f;
      shadowSoftnessIncrease = 0.20 * f;
      flashR = 2.5 * f;
      flashG = 1.2 * f;
      flashB = 0.4 * f;
      break;
    case COALESCED_EVENT_TYPE.LIGHTNING_STRIKE:
      sunDiffuseIncrease = 0.10 * f;
      flashR = LIGHTING_FLASH_LIGHTNING * f;
      flashG = LIGHTING_FLASH_LIGHTNING * 0.9 * f;
      flashB = LIGHTING_FLASH_LIGHTNING * 0.8 * f;
      break;
    case COALESCED_EVENT_TYPE.WILDFIRE:
      sunDiffuseIncrease = 0.30 * f;
      fogDensityIncrease = 0.10 * f;
      shadowSoftnessIncrease = 0.15 * f;
      flashR = 1.5 * f;
      flashG = 0.6 * f;
      flashB = 0.2 * f;
      break;
    case COALESCED_EVENT_TYPE.STORM_SURGE:
    case COALESCED_EVENT_TYPE.FLOOD:
      sunDiffuseIncrease = 0.25 * f;
      fogDensityIncrease = 0.08 * f;
      break;
    case COALESCED_EVENT_TYPE.DROUGHT:
      sunDiffuseIncrease = -0.10 * f;
      break;
    case COALESCED_EVENT_TYPE.LANDSLIDE:
    case COALESCED_EVENT_TYPE.MASS_EROSION:
      sunDiffuseIncrease = 0.15 * f;
      fogDensityIncrease = 0.12 * f;
      shadowSoftnessIncrease = 0.10 * f;
      break;
    default:
      sunDiffuseIncrease = 0.10 * f;
      break;
  }

  // Fill the lighting override layout (matches 351's first 8 floats).
  _eventLightingOverride[base + 0] = sunDiffuseIncrease;
  _eventLightingOverride[base + 1] = 0;             // sun intensity (unchanged)
  _eventLightingOverride[base + 2] = flashR;        // sun color R flash
  _eventLightingOverride[base + 3] = flashG;        // sun color G flash
  _eventLightingOverride[base + 4] = flashB;        // sun color B flash
  _eventLightingOverride[base + 5] = 0;             // sky tint (unchanged)
  _eventLightingOverride[base + 6] = shadowSoftnessIncrease;
  _eventLightingOverride[base + 7] = fogDensityIncrease;
}

// ══════════════════════════════════════════════════════════════════
// ─── EVENT SPAWNING ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Spawn a new coalesced event. Called by the runtime when a large-scale
// procedural event occurs. The system collapses the many low-level events
// (impacts, ignitions, splashes) into this single event.
function _spawnEvent(eventType, worldX, worldY, worldZ, initialForce, initialSeverity) {
  if (_eventFreeTop === 0) return -1;
  if (_activeEventCount >= MAX_ACTIVE_EVENTS) return -1;

  const slot = _allocEventSlot();
  if (slot === -1) return -1;

  _eventActive[slot] = 1;
  _eventState[slot] = EVENT_STATE.SPREADING;
  _eventType[slot] = eventType;
  _eventCenterX[slot] = worldX;
  _eventCenterY[slot] = worldY;
  _eventCenterZ[slot] = worldZ;
  _eventRadiusM[slot] = 0;
  _eventStartS[slot] = BiomeBlendSystem.elapsedSimSeconds;
  _eventLastEmitS[slot] = -1;
  _eventInitialForce[slot] = initialForce;
  _eventInitialSeverity[slot] = initialSeverity;

  // Compute the spread coefficient from the event type and the biome
  // propensity at the centroid.
  const baseRate = EVENT_BASE_SPREAD_RATE[eventType] || 5.0;
  const biomePropensity = _computeBiomePropensity(worldX, worldY, worldZ);
  _eventSpreadCoeff[slot] = baseRate * biomePropensity;

  // Compute the maximum radius. Events stop spreading once they reach
  // this radius. The radius depends on the event type and the initial
  // force. A fireball with force 1.0 covers ~500 m; a meteor impact
  // covers ~1.5 km; a volcanic eruption covers ~5 km.
  let maxRadius = 500.0;
  switch (eventType) {
    case COALESCED_EVENT_TYPE.FIREBALL: maxRadius = 500.0; break;
    case COALESCED_EVENT_TYPE.METEOR_IMPACT: maxRadius = 1500.0; break;
    case COALESCED_EVENT_TYPE.VOLCANIC_ERUPTION: maxRadius = 5000.0; break;
    case COALESCED_EVENT_TYPE.STORM_SURGE: maxRadius = 3000.0; break;
    case COALESCED_EVENT_TYPE.LIGHTNING_STRIKE: maxRadius = 100.0; break;
    case COALESCED_EVENT_TYPE.LANDSLIDE: maxRadius = 800.0; break;
    case COALESCED_EVENT_TYPE.FLOOD: maxRadius = 3000.0; break;
    case COALESCED_EVENT_TYPE.DROUGHT: maxRadius = 10000.0; break;
    case COALESCED_EVENT_TYPE.MASS_EROSION: maxRadius = 1000.0; break;
    case COALESCED_EVENT_TYPE.WILDFIRE: maxRadius = 2000.0; break;
  }
  _eventMaxRadiusM[slot] = maxRadius * Math.min(1.0, initialForce);

  // Build the material and lighting overrides.
  _buildEventMaterialOverride(slot, eventType, initialForce);
  _buildEventLightingOverride(slot, eventType, initialForce);

  _activeEventCount++;
  _totalSpawned++;

  _dispatcher.emit(EVENT_TYPE.COALESCED_EVENT_SPAWNED, {
    slot,
    eventType,
    x: worldX, y: worldY, z: worldZ,
    initialForce,
    initialSeverity,
    spreadCoeff: _eventSpreadCoeff[slot],
    biomePropensity,
    maxRadiusM: _eventMaxRadiusM[slot]
  });

  return slot;
}

// ══════════════════════════════════════════════════════════════════
// ─── EVENT ADVANCEMENT ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Advance a single event one tick. Updates its radius via the spread
// formula, enumerates the newly-affected chunks, and emits one consolidated
// CAUSAL_EVENT.
function _advanceEvent(eventSlot, nowS) {
  if (!_eventActive[eventSlot]) return false;
  if (_eventState[eventSlot] === EVENT_STATE.RETIRED) return false;

  const ageS = nowS - _eventStartS[eventSlot];

  // ─── 1. Retire if aged out ─────────────────────────────
  if (ageS >= EVENT_MAX_AGE_S) {
    _retireEvent(eventSlot, nowS);
    return true;
  }

  // ─── 2. Update the state ───────────────────────────────
  if (ageS > SPREAD_WINDOW_S && _eventState[eventSlot] === EVENT_STATE.SPREADING) {
    _eventState[eventSlot] = EVENT_STATE.SETTLING;
  }

  // ─── 3. Compute the new radius ─────────────────────────
  // dr/dt = c · D(τ) · φ_biome
  // We integrate this over the tick's dt. Since D(τ) changes over the tick,
  // we approximate with the average over the tick.
  if (_eventState[eventSlot] === EVENT_STATE.SPREADING) {
    const tau = ageS;
    const D = Math.exp(-tau / SPREAD_TAU_DECAY_S);
    const dR = _eventSpreadCoeff[eventSlot] * D * (1.0 / 10.0);  // dt = 0.1 s at 10 Hz
    _eventRadiusM[eventSlot] = Math.min(_eventMaxRadiusM[eventSlot],
      _eventRadiusM[eventSlot] + dR);
  }

  // ─── 4. Enumerate newly-affected chunks ────────────────
  // We query the spatial hash for buckets intersecting the event's radius,
  // then for each chunk in those buckets, check whether it is inside the
  // radius. Chunks that are already in the affected list are skipped.
  // Because the enumeration is amortized across the whole radius, the
  // per-tick cost is proportional to the number of new chunks, not the
  // total number.
  if (!_eventRadiusOnlyMode[eventSlot]) {
    _enumerateAffectedChunks(eventSlot, nowS);
  }

  // ─── 5. Emit the consolidated event ────────────────────
  // The event carries the full material and lighting override record, plus
  // the current radius and state.
  const materialBase = eventSlot * 16;
  const lightingBase = eventSlot * 8;
  for (let i = 0; i < 16; i++) _scratchMaterialOverride[i] = _eventMaterialOverride[materialBase + i];
  for (let i = 0; i < 8; i++) _scratchLightingOverride[i] = _eventLightingOverride[lightingBase + i];

  _dispatcher.emit(EVENT_TYPE.COALESCED_CAUSAL_EVENT, {
    slot: eventSlot,
    eventType: _eventType[eventSlot],
    state: _eventState[eventSlot],
    x: _eventCenterX[eventSlot],
    y: _eventCenterY[eventSlot],
    z: _eventCenterZ[eventSlot],
    radiusM: _eventRadiusM[eventSlot],
    ageS,
    affectedChunkCount: _eventAffectedCount[eventSlot],
    radiusOnlyMode: _eventRadiusOnlyMode[eventSlot] === 1,
    materialOverride: _scratchMaterialOverride,
    lightingOverride: _scratchLightingOverride
  });

  _eventLastEmitS[eventSlot] = nowS;
  _totalEmitted++;
  return true;
}

// Enumerate the chunks inside the event's radius and add any new ones to
// the event's affected list. Uses the spatial hash's tier-appropriate
// bucket query.
function _enumerateAffectedChunks(eventSlot, nowS) {
  if (_eventAffectedCount[eventSlot] >= MAX_CHUNKS_PER_EVENT) {
    _eventRadiusOnlyMode[eventSlot] = 1;
    return;
  }

  const cx = _eventCenterX[eventSlot];
  const cy = _eventCenterY[eventSlot];
  const cz = _eventCenterZ[eventSlot];
  const radiusM = _eventRadiusM[eventSlot];

  // Choose the coarsest tier whose query radius cap allows the current
  // event radius.
  let tier = HLOD_TIER.KILOMETER;
  for (let t = 0; t < 4; t++) {
    if (TIER_QUERY_RADIUS_CAP_M[t] > 0 && radiusM <= TIER_QUERY_RADIUS_CAP_M[t]) {
      tier = t;
      break;
    }
  }
  if (TIER_QUERY_RADIUS_CAP_M[tier] === 0 || radiusM > TIER_QUERY_RADIUS_CAP_M[tier]) {
    // Radius exceeds every tier's cap — switch to radius-only mode.
    _eventRadiusOnlyMode[eventSlot] = 1;
    return;
  }

  const bucketCount = LandscapeChunkSpatialHash.queryRadius(
    tier, cx, cy, cz, radiusM, _bucketSlots, _bucketSlots.length
  );

  const base = eventSlot * MAX_CHUNKS_PER_EVENT;
  for (let b = 0; b < bucketCount; b++) {
    const bucketSlot = _bucketSlots[b];
    if (bucketSlot === -1) continue;
    const chunkCount = LandscapeChunkSpatialHash.queryBucketChunks(
      tier, bucketSlot, _chunkSlots, _chunkSlots.length
    );
    for (let c = 0; c < chunkCount; c++) {
      const streamerSlot = _chunkSlots[c];
      if (streamerSlot === -1) continue;

      // Is this chunk already in the list?
      let alreadyPresent = false;
      const count = _eventAffectedCount[eventSlot];
      for (let i = 0; i < count; i++) {
        if (_eventAffectedChunks[base + i] === streamerSlot) {
          alreadyPresent = true;
          break;
        }
      }
      if (alreadyPresent) continue;

      // Add the chunk.
      if (count >= MAX_CHUNKS_PER_EVENT) {
        _eventRadiusOnlyMode[eventSlot] = 1;
        return;
      }
      _eventAffectedChunks[base + count] = streamerSlot;
      _eventAffectedCount[eventSlot] = count + 1;

      // Emit a per-chunk notification so the consumer systems can react.
      _dispatcher.emit(EVENT_TYPE.COALESCED_CHUNK_REACHED, {
        eventSlot,
        eventType: _eventType[eventSlot],
        streamerSlot,
        radiusM,
        tick: nowS
      });
    }
  }
}

// Retire an event.
function _retireEvent(eventSlot, nowS) {
  _eventState[eventSlot] = EVENT_STATE.RETIRED;
  _dispatcher.emit(EVENT_TYPE.COALESCED_EVENT_RETIRED, {
    slot: eventSlot,
    eventType: _eventType[eventSlot],
    affectedChunkCount: _eventAffectedCount[eventSlot],
    totalRadiusM: _eventRadiusM[eventSlot],
    ageS: nowS - _eventStartS[eventSlot]
  });
  _freeEventSlot(eventSlot);
  _totalRetired++;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeEventBudget = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  COALESCED_EVENT_TYPE,
  EVENT_STATE,
  maxActiveEvents: MAX_ACTIVE_EVENTS,
  maxChunksPerEvent: MAX_CHUNKS_PER_EVENT,
  tickEventBudget: DEFAULT_TICK_EVENT_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  spreadWindowS: SPREAD_WINDOW_S,
  eventMaxAgeS: EVENT_MAX_AGE_S,

  /**
   * Spawn a new coalesced event. Called by the runtime (or by
   * 300_ImpactEventCoordinator, 316_EcologyResponseSystem, etc.) when a
   * large-scale procedural event occurs. Returns the event slot, or -1 if
   * the pool is exhausted.
   */
  spawnEvent(eventType, worldX, worldY, worldZ, initialForce, initialSeverity) {
    return _spawnEvent(eventType, worldX, worldY, worldZ, initialForce, initialSeverity);
  },

  /**
   * The 10 Hz consumer entry point. Called by 308_ContextConsumerTiers.
   */
  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    // Determine the effective per-tick event budget from the governor.
    let budget = this.tickEventBudget;
    if (LandscapePerformanceGovernor && typeof LandscapePerformanceGovernor.getDegradationState === 'function') {
      const state = LandscapePerformanceGovernor.getDegradationState();
      const factor = 0.5 + state * 0.5;
      budget = Math.max(1, Math.floor(budget * factor));
    }

    let processed = 0;
    let emitted = 0;
    let retired = 0;

    // Walk all active events.
    for (let slot = 0; slot < MAX_ACTIVE_EVENTS; slot++) {
      if (!_eventActive[slot]) continue;
      processed++;

      if (_advanceEvent(slot, nowS)) {
        emitted++;
        if (!_eventActive[slot]) retired++;   // event was retired during advance
      }

      if (processed >= budget) break;
      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = tick;
    _lastEmittedCount = emitted;
    _lastRetiredCount = retired;
    _lastTickDurationMs = performanceNow() - t0;

    if (emitted > 0 || retired > 0) {
      _dispatcher.emit(EVENT_TYPE.EVENT_BUDGET_UPDATED, {
        tick,
        processed,
        emitted,
        retired,
        activeEvents: _activeEventCount,
        durationMs: _lastTickDurationMs
      });
    }
  },

  /**
   * Force-retire all events. Used by the runtime during shutdown or a
   * world reset.
   */
  retireAll() {
    for (let slot = 0; slot < MAX_ACTIVE_EVENTS; slot++) {
      if (_eventActive[slot]) _retireEvent(slot, BiomeBlendSystem.elapsedSimSeconds);
    }
  },

  /**
   * Query the current state of an event.
   */
  readEvent(eventSlot, out) {
    if (eventSlot < 0 || eventSlot >= MAX_ACTIVE_EVENTS) return false;
    if (!_eventActive[eventSlot]) return false;
    out.state = _eventState[eventSlot];
    out.type = _eventType[eventSlot];
    out.x = _eventCenterX[eventSlot];
    out.y = _eventCenterY[eventSlot];
    out.z = _eventCenterZ[eventSlot];
    out.radiusM = _eventRadiusM[eventSlot];
    out.maxRadiusM = _eventMaxRadiusM[eventSlot];
    out.ageS = BiomeBlendSystem.elapsedSimSeconds - _eventStartS[eventSlot];
    out.spreadCoeff = _eventSpreadCoeff[eventSlot];
    out.affectedChunkCount = _eventAffectedCount[eventSlot];
    out.radiusOnlyMode = _eventRadiusOnlyMode[eventSlot] === 1;
    return true;
  },

  /**
   * Get the event's material override record. Zero-allocation (returns a
   * subarray view).
   */
  getMaterialOverride(eventSlot) {
    if (eventSlot < 0 || eventSlot >= MAX_ACTIVE_EVENTS) return null;
    if (!_eventActive[eventSlot]) return null;
    const base = eventSlot * 16;
    return _eventMaterialOverride.subarray(base, base + 16);
  },

  /**
   * Get the event's lighting override record. Zero-allocation.
   */
  getLightingOverride(eventSlot) {
    if (eventSlot < 0 || eventSlot >= MAX_ACTIVE_EVENTS) return null;
    if (!_eventActive[eventSlot]) return null;
    const base = eventSlot * 8;
    return _eventLightingOverride.subarray(base, base + 8);
  },

  /**
   * Query the list of chunks affected by an event.
   */
  getAffectedChunks(eventSlot, outSlots, maxCount) {
    if (eventSlot < 0 || eventSlot >= MAX_ACTIVE_EVENTS) return 0;
    if (!_eventActive[eventSlot]) return 0;
    const count = Math.min(_eventAffectedCount[eventSlot], maxCount);
    const base = eventSlot * MAX_CHUNKS_PER_EVENT;
    for (let i = 0; i < count; i++) {
      outSlots[i] = _eventAffectedChunks[base + i];
    }
    return count;
  },

  /**
   * Query whether a chunk is affected by any active event of a given type.
   * Returns the event slot, or -1 if the chunk is not affected.
   */
  findAffectingEvent(streamerSlot, eventType) {
    for (let slot = 0; slot < MAX_ACTIVE_EVENTS; slot++) {
      if (!_eventActive[slot]) continue;
      if (eventType !== undefined && _eventType[slot] !== eventType) continue;
      const count = _eventAffectedCount[slot];
      const base = slot * MAX_CHUNKS_PER_EVENT;
      for (let i = 0; i < count; i++) {
        if (_eventAffectedChunks[base + i] === streamerSlot) return slot;
      }
    }
    return -1;
  },

  // ─── Direct accessors ────────────────────────────────────
  getActiveEventCount() { return _activeEventCount; },
  getEventRadiusM(eventSlot) {
    if (eventSlot < 0 || eventSlot >= MAX_ACTIVE_EVENTS) return 0;
    return _eventRadiusM[eventSlot];
  },
  getEventState(eventSlot) {
    if (eventSlot < 0 || eventSlot >= MAX_ACTIVE_EVENTS) return EVENT_STATE.INACTIVE;
    return _eventState[eventSlot];
  },
  getEventAgeS(eventSlot) {
    if (eventSlot < 0 || eventSlot >= MAX_ACTIVE_EVENTS) return 0;
    if (!_eventActive[eventSlot]) return 0;
    return BiomeBlendSystem.elapsedSimSeconds - _eventStartS[eventSlot];
  },
  getFreeSlots() { return _eventFreeTop; },
  getCapacity() { return MAX_ACTIVE_EVENTS; },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastEmittedCount() { return _lastEmittedCount; },
  get lastRetiredCount() { return _lastRetiredCount; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get totalSpawned() { return _totalSpawned; },
  get totalEmitted() { return _totalEmitted; },
  get totalRetired() { return _totalRetired; },
  get activeEvents() { return _activeEventCount; }
});

function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default LandscapeEventBudget;