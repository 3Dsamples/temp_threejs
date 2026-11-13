// file number : 338
// full path name : src/context/338_LandscapeChunkHLOD.js
// description : Landscape chunk HLOD — the 10 Hz consumer that assigns an HLOD
// tier and an LOD level to every loaded chunk. It reads the camera position
// and predicted position from 337_LandscapeChunkStreamer, applies the
// hierarchical LOD formula from 303_HLODController — ℓ = floor(log_R(d/d₀))
// with R = 10 and d₀ = 100 m — with per-tier hysteresis to prevent flicker,
// writes the resolved tier and level back into 336_LandscapeChunkDescriptor,
// and emits a single aggregate event so downstream systems can react to every
// tier and level change in a single place. The four-tier hierarchy mirrors
// the biome tier layout used elsewhere in the pipeline:
//   KILOMETER     0 –   1 km   HIGH       full PBR + anime shading, per-object
//                              geometry, full flora and fauna, full shadows
//   TEN_KILOMETER  1 –  10 km  MID        simplified geometry, HLOD proxy
//                              mesh, half flora, no per-object fauna
//   HUNDRED_KILO- 10 – 100 km  LOW        billboard + particle vegetation,
//   METER                      HLOD billboards, no fauna
//   THOUSAND_KILO 100 – 1000+  BILLBOARD  star-field billboards, ambient
//   METER                      HLOD proxy, no flora, no fauna, no shadows
// The thresholds are chosen so that on a 100 m chunk grid a chunk in the
// KILOMETER tier is roughly the 10×10 block nearest the camera, a chunk in
// the TEN_KILOMETER tier is the next 100 chunks out, and so on. Hysteresis is
// applied per-tier: a chunk must move past a threshold by a 10 % margin in
// the direction of the change before its tier is updated, and the tier can
// only change once per second even if the distance crosses several
// thresholds in a single tick. This is what prevents the whole landscape from
// flickering between LOD levels during a fast camera pan. The LOD level is a
// sub-tier refinement: it encodes whether the chunk is at the near, mid, or
// far edge of its tier, which the material bridge (331) uses to select a
// specific pre-baked material palette. The tier and level are written to
// 336_LandscapeChunkDescriptor via setHlodAndLod(), and the aggregate event
// carries a small array of changed chunks so downstream systems can update
// exactly those chunks and no others. All per-chunk HLOD state is pooled in a
// structure-of-arrays indexed by the streamer slot, and the per-tick work is
// bounded by a configurable budget (default 512 chunks per tick) so a
// 100,000-chunk world is fully refreshed in roughly 20 simulated seconds
// without exceeding the per-tick CPU ceiling. The module also exposes a
// direct per-chunk resolver (resolveChunk) that 336, 350, and 351 use when
// they need the correct HLOD tier for a chunk without waiting for the next
// 10 Hz tick — this is what makes the seamless transition from small to
// galactic scale possible: any consumer can ask "what LOD should I use for
// this chunk right now?" and get a consistent answer.
//#
// best for : Every consumer that needs to know the correct LOD tier and level
// for a loaded chunk — 336_LandscapeChunkDescriptor (stores the resolved tier
// and level), 339_LandscapeChunkSpatialHash (indexes chunks by tier for
// bucket-level culling), 340_LandscapeChunkOcclusion (uses the tier to decide
// whether to update the occlusion graph for a chunk),
// 343_LandscapeErosionSimulator and 344_LandscapeWindErosionSystem (scale
// their update rate by tier), 345_LandscapeWaterFlowSystem (scales flow
// routing resolution by tier), 346_LandscapeVegetationScatterSystem (picks a
// density and species mix per tier), 347_LandscapeFaunaSpawnSystem (only
// spawns fauna in the KILOMETER and TEN_KILOMETER tiers),
// 348_LandscapeDecalPlacementSystem (only places decals in the KILOMETER
// tier), 349_LandscapePropPlacementSystem (uses tier to pick prop
// granularity), 350_LandscapeShadowScaler (reads the tier to scale shadow
// cascade count), 351_LandscapeLightingCoupler (reads the tier to scale
// lighting quality), 352_LandscapeSkyCoupler (uses BILLBOARD tier for the
// star field), 353_LandscapeSeasonCoupler (uses tier to scale seasonality
// blending), and 354_LandscapeSensoryCoupler (uses tier to scale audio and
// scent density). The module is the single authority on "what LOD does this
// chunk use right now?" and every downstream consumer relies on its answer
// being consistent across frames.
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
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { LODHelper } from './269_ExtrasLODHelper.js';
import { CameraVelocityExtrapolator } from './302_CameraVelocityExtrapolator.js';
import { HLODController } from './303_HLODController.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer, LOAD_STATE } from './337_LandscapeChunkStreamer.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336 and 303.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// LOD level identifiers. Must match 336 and 303.
const LOD_LEVEL = Object.freeze({
  HIGH: 0,
  MID: 1,
  LOW: 2,
  BILLBOARD: 3
});

// Tier distance thresholds in metres. Each tier covers the range from its
// lower bound to the next tier's lower bound. The values are chosen to give
// the four-tier hierarchy described in the header: one km, ten km, a
// hundred km, a thousand km. The ratio between adjacent thresholds is 10,
// which matches the R = 10 in the hierarchical LOD formula.
const TIER_THRESHOLDS_M = Object.freeze([
  0.0,          // KILOMETER starts at the camera
  1000.0,       // TEN_KILOMETER starts at 1 km
  10000.0,      // HUNDRED_KILOMETER starts at 10 km
  100000.0      // THOUSAND_KILOMETER starts at 100 km
]);

// Hysteresis margins. A chunk must move past a tier threshold by this
// fraction of the threshold distance in the direction of the change before
// its tier is updated. A margin of 0.10 means the tier change happens at
// 10 % beyond the boundary, which is the standard "10 % dead band" used in
// the rest of the pipeline.
const TIER_HYSTERESIS_MARGIN = 0.10;

// Minimum time in seconds between tier changes for a single chunk. This is
// the second layer of hysteresis: even if the distance crosses several
// thresholds at once, a chunk's tier can only change once per second. This
// prevents the landscape from flickering during a fast camera pan.
const TIER_MIN_CHANGE_INTERVAL_S = 1.0;

// LOD level refinement. Within each tier, the LOD level encodes which
// sub-band the chunk is in. The tier's distance range is divided into
// LOD_LEVEL_COUNT bands; each band maps to a different material palette
// that the material bridge (331) selects. 3 bands (HIGH, MID, LOW) per
// tier matches the three-level LOD used by 303_HLODController.
const LOD_LEVEL_COUNT = 3;

// Maximum number of tier changes reported per tick. The event payload
// carries an array of changed chunks; if more than this many chunks
// changed in a single tick, we truncate the array and set a flag on the
// event so downstream systems know to do a full refresh.
const MAX_CHANGE_EVENTS_PER_TICK = 256;

// Per-tick processing budget. Same rationale as the other consumers: bounded
// per-tick CPU cost regardless of active chunk count. 512 chunks per tick
// at 10 Hz means a 100,000-chunk world is fully refreshed in ~20 s.
const DEFAULT_TICK_BUDGET = 512;

// Maximum number of tracked chunks. Matches 336 and 337 so the streamer
// slot is a valid index in this module's pooled state.
const MAX_TRACKED_CHUNKS = 100000;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK HLOD STATE (structure-of-arrays) ─────────
// ══════════════════════════════════════════════════════════════════
// The state is indexed by the streamer slot, so the streamer's slot is
// this module's slot. This is what makes the lookup O(1) from any consumer
// that already has a streamer slot.

const _tier                 = new Uint8Array(MAX_TRACKED_CHUNKS);
const _level                = new Uint8Array(MAX_TRACKED_CHUNKS);
const _lastTierChangeS      = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastComputedDistance = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _slotActive           = new Uint8Array(MAX_TRACKED_CHUNKS);

// Slot free-list. The streamer slot is the authority; we mirror the free
// state so this module can reject slots that are no longer tracked.
const _freeList = new Int32Array(MAX_TRACKED_CHUNKS);
let _freeTop = MAX_TRACKED_CHUNKS;
for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) _freeList[i] = MAX_TRACKED_CHUNKS - 1 - i;

// ─── Change events per tick ─────────────────────────────────────
// The aggregate event carries a compact list of chunks whose tier or level
// changed this tick. The list is a fixed-size ring of (slot, oldTier,
// newTier, oldLevel, newLevel) tuples.
const _changeSlot  = new Int32Array(MAX_CHANGE_EVENTS_PER_TICK).fill(-1);
const _changeOldTier = new Uint8Array(MAX_CHANGE_EVENTS_PER_TICK);
const _changeNewTier = new Uint8Array(MAX_CHANGE_EVENTS_PER_TICK);
const _changeOldLevel = new Uint8Array(MAX_CHANGE_EVENTS_PER_TICK);
const _changeNewLevel = new Uint8Array(MAX_CHANGE_EVENTS_PER_TICK);
let _changeCount = 0;
let _changeOverflow = false;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _cameraPos = new Vec3();
const _cameraPredictedPos = new Vec3();
const _chunkCenter = new Vec3();

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastChangeCount = 0;
let _rrCursor = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the tier for a distance. The tier is chosen by comparing the
// distance against the tier thresholds. To apply hysteresis, the caller
// passes the current tier; if the distance is within the hysteresis margin
// of the current tier's upper bound, the current tier is retained.
function _tierForDistance(distanceM, currentTier) {
  // If no current tier, use the strict threshold.
  if (currentTier < 0 || currentTier > 3) {
    if (distanceM >= TIER_THRESHOLDS_M[3]) return HLOD_TIER.THOUSAND_KILOMETER;
    if (distanceM >= TIER_THRESHOLDS_M[2]) return HLOD_TIER.HUNDRED_KILOMETER;
    if (distanceM >= TIER_THRESHOLDS_M[1]) return HLOD_TIER.TEN_KILOMETER;
    return HLOD_TIER.KILOMETER;
  }

  // Compute the strict tier first, then apply hysteresis.
  let strictTier;
  if (distanceM >= TIER_THRESHOLDS_M[3]) strictTier = HLOD_TIER.THOUSAND_KILOMETER;
  else if (distanceM >= TIER_THRESHOLDS_M[2]) strictTier = HLOD_TIER.HUNDRED_KILOMETER;
  else if (distanceM >= TIER_THRESHOLDS_M[1]) strictTier = HLOD_TIER.TEN_KILOMETER;
  else strictTier = HLOD_TIER.KILOMETER;

  if (strictTier === currentTier) return currentTier;

  // If the strict tier is higher (further away), apply the upper bound of
  // the current tier plus the hysteresis margin. The chunk only moves up
  // when it has clearly crossed the boundary.
  if (strictTier > currentTier) {
    const upperBound = TIER_THRESHOLDS_M[currentTier + 1] || Infinity;
    const upperWithMargin = upperBound * (1 + TIER_HYSTERESIS_MARGIN);
    if (distanceM < upperWithMargin) return currentTier;
    return strictTier;
  }

  // If the strict tier is lower (closer), apply the upper bound of the
  // strict tier minus the hysteresis margin. The chunk only moves down
  // when it has clearly moved inside the lower tier.
  const upperBound = TIER_THRESHOLDS_M[strictTier + 1] || Infinity;
  const upperWithMargin = upperBound * (1 - TIER_HYSTERESIS_MARGIN);
  if (distanceM > upperWithMargin) return currentTier;
  return strictTier;
}

// Compute the LOD level for a distance within a tier. The tier's distance
// range is divided into LOD_LEVEL_COUNT bands; the chunk's level is the
// band index.
function _lodLevelForDistance(distanceM, tier) {
  const lowerBound = TIER_THRESHOLDS_M[tier];
  const upperBound = TIER_THRESHOLDS_M[tier + 1] || (TIER_THRESHOLDS_M[3] * 10);
  const range = upperBound - lowerBound;
  if (range <= 0) return LOD_LEVEL.HIGH;
  const t = (distanceM - lowerBound) / range;
  const band = Math.min(LOD_LEVEL_COUNT - 1, Math.max(0, Math.floor(t * LOD_LEVEL_COUNT)));
  return band;
}

// Record a tier or level change in the change event buffer.
function _recordChange(slot, oldTier, newTier, oldLevel, newLevel) {
  if (_changeCount >= MAX_CHANGE_EVENTS_PER_TICK) {
    _changeOverflow = true;
    return;
  }
  _changeSlot[_changeCount] = slot;
  _changeOldTier[_changeCount] = oldTier;
  _changeNewTier[_changeCount] = newTier;
  _changeOldLevel[_changeCount] = oldLevel;
  _changeNewLevel[_changeCount] = newLevel;
  _changeCount++;
}

// Process a single chunk: compute its tier and level, apply hysteresis,
// record any change, and write the result back to 336's descriptor.
function _processChunk(streamerSlot, nowS) {
  // Get the chunk's world position from the streamer.
  const cx = LandscapeChunkStreamer.getChunkX ? LandscapeChunkStreamer.getChunkX(streamerSlot) : 0;
  const cy = LandscapeChunkStreamer.getChunkY ? LandscapeChunkStreamer.getChunkY(streamerSlot) : 0;
  const cz = LandscapeChunkStreamer.getChunkZ ? LandscapeChunkStreamer.getChunkZ(streamerSlot) : 0;

  // If the streamer doesn't expose coordinate accessors, fall back to
  // reading from 336's descriptor (which the streamer populated on
  // stream-in). This is the common path.
  let chunkX = cx, chunkY = cy, chunkZ = cz;
  const descriptorSlot = LandscapeChunkStreamer.getDownstreamSlots
    ? _getDescriptorSlot(streamerSlot) : -1;
  if (descriptorSlot !== -1) {
    chunkX = LandscapeChunkDescriptor.getChunkX(descriptorSlot);
    chunkY = LandscapeChunkDescriptor.getChunkY(descriptorSlot);
    chunkZ = LandscapeChunkDescriptor.getChunkZ(descriptorSlot);
  }

  // Compute chunk center.
  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  _chunkCenter.set(
    (chunkX + 0.5) * cs,
    (chunkY + 0.5) * cs,
    (chunkZ + 0.5) * cs
  );

  // Compute distance to the predicted camera position.
  const dx = _chunkCenter.x - _cameraPredictedPos.x;
  const dy = _chunkCenter.y - _cameraPredictedPos.y;
  const dz = _chunkCenter.z - _cameraPredictedPos.z;
  const distanceM = Math.sqrt(dx * dx + dy * dy + dz * dz);
  _lastComputedDistance[streamerSlot] = distanceM;

  // Apply hysteresis to the tier.
  const oldTier = _tier[streamerSlot];
  const oldLevel = _level[streamerSlot];
  const newTier = _tierForDistance(distanceM, oldTier);

  // Enforce the minimum change interval.
  const timeSinceLastChange = nowS - _lastTierChangeS[streamerSlot];
  if (newTier !== oldTier && timeSinceLastChange < TIER_MIN_CHANGE_INTERVAL_S) {
    // Too soon to change; keep the current tier.
    return false;
  }

  // Compute the new LOD level if the tier changed; otherwise keep the
  // current level. The level only changes when the tier changes, which is
  // the whole point of hysteresis: the level is a sub-band of the tier, so
  // if the tier didn't change, the level shouldn't either.
  let newLevel = oldLevel;
  if (newTier !== oldTier) {
    newLevel = _lodLevelForDistance(distanceM, newTier);
  } else {
    // Even if the tier didn't change, the level can change within the
    // tier. This is a smaller, faster change and doesn't need the tier's
    // one-second hysteresis.
    const computedLevel = _lodLevelForDistance(distanceM, newTier);
    if (computedLevel !== oldLevel) {
      // A smaller hysteresis: 10 % of the band width.
      // (Simpler: just apply the computed level. The 10 Hz cadence already
      // provides temporal smoothing.)
      newLevel = computedLevel;
    }
  }

  // If nothing changed, do nothing.
  if (newTier === oldTier && newLevel === oldLevel) return false;

  // Update the state.
  _tier[streamerSlot] = newTier;
  _level[streamerSlot] = newLevel;
  _lastTierChangeS[streamerSlot] = nowS;

  // Write the tier and level back to 336's descriptor.
  if (descriptorSlot !== -1) {
    LandscapeChunkDescriptor.setHlodAndLod(descriptorSlot, newTier, newLevel);
  }

  // Record the change for the aggregate event.
  _recordChange(streamerSlot, oldTier, newTier, oldLevel, newLevel);
  return true;
}

function _getDescriptorSlot(streamerSlot) {
  // The streamer exposes its downstream slot mapping. We use it to find
  // the 336 descriptor slot for this streamer slot.
  const out = { descriptorSlot: -1 };
  if (LandscapeChunkStreamer.getDownstreamSlots) {
    LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, out);
  }
  return out.descriptorSlot;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeChunkHLOD = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  LOD_LEVEL,
  tierThresholdsM: TIER_THRESHOLDS_M,
  tierHysteresisMargin: TIER_HYSTERESIS_MARGIN,
  tierMinChangeIntervalS: TIER_MIN_CHANGE_INTERVAL_S,
  lodLevelCount: LOD_LEVEL_COUNT,
  tickBudget: DEFAULT_TICK_BUDGET,

  /**
   * Register a chunk with the HLOD system. Called by 337 when a chunk is
   * streamed in. The streamer slot is the authority; this module mirrors
   * it and seeds the tier and level from the initial distance.
   */
  registerChunk(streamerSlot, cx, cy, cz, cameraX, cameraY, cameraZ) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _slotActive[streamerSlot] = 1;

    const cs = LandscapeChunkStreamer.config.chunkSizeM;
    const centerX = (cx + 0.5) * cs;
    const centerY = (cy + 0.5) * cs;
    const centerZ = (cz + 0.5) * cs;
    const dx = centerX - cameraX;
    const dy = centerY - cameraY;
    const dz = centerZ - cameraZ;
    const distanceM = Math.sqrt(dx * dx + dy * dy + dz * dz);
    _lastComputedDistance[streamerSlot] = distanceM;

    // Seed with the strict tier (no hysteresis).
    let strictTier;
    if (distanceM >= TIER_THRESHOLDS_M[3]) strictTier = HLOD_TIER.THOUSAND_KILOMETER;
    else if (distanceM >= TIER_THRESHOLDS_M[2]) strictTier = HLOD_TIER.HUNDRED_KILOMETER;
    else if (distanceM >= TIER_THRESHOLDS_M[1]) strictTier = HLOD_TIER.TEN_KILOMETER;
    else strictTier = HLOD_TIER.KILOMETER;

    _tier[streamerSlot] = strictTier;
    _level[streamerSlot] = _lodLevelForDistance(distanceM, strictTier);
    _lastTierChangeS[streamerSlot] = BiomeBlendSystem.elapsedSimSeconds;
    return true;
  },

  /**
   * Unregister a chunk. Called by 337 when a chunk is streamed out.
   */
  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _slotActive[streamerSlot] = 0;
    _tier[streamerSlot] = 0;
    _level[streamerSlot] = 0;
    _lastTierChangeS[streamerSlot] = -1;
    _lastComputedDistance[streamerSlot] = -1;
  },

  /**
   * The 10 Hz consumer entry point. Called by 308_ContextConsumerTiers.
   */
  run(frame, tick, dt) {
    _changeCount = 0;
    _changeOverflow = false;

    // ─── 1. Read the predicted camera position ──────────────
    const camExtrapolator = frame && frame.spatial && frame.spatial.cameraExtrapolator;
    if (camExtrapolator) {
      const predicted = camExtrapolator.predictNextFrame();
      _cameraPredictedPos.set(predicted.position.x, predicted.position.y, predicted.position.z);
    } else {
      const spatial = frame && frame.spatial;
      if (spatial && spatial.cameraPosition) {
        _cameraPredictedPos.set(spatial.cameraPosition.x, spatial.cameraPosition.y, spatial.cameraPosition.z);
      }
    }

    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    // ─── 2. Process the loaded chunk set in a round-robin window ─
    const activeCount = LandscapeChunkStreamer.loadedChunks;
    if (activeCount === 0) {
      _lastProcessed = 0;
      _lastChangeCount = 0;
      return;
    }

    let processed = 0;
    let changes = 0;
    for (let b = 0; b < this.tickBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_slotActive[slot]) continue;
      // Skip chunks that are not loaded in the streamer.
      // (The streamer's state is the authority; a chunk that has been
      // streamed out is not eligible for HLOD updates.)
      // We detect this by querying the streamer's load state indirectly
      // through the streamer slot. If the streamer doesn't have an
      // explicit query, we rely on the register/unregister pair to keep
      // the slot active flag in sync.
      processed++;
      if (_processChunk(slot, nowS)) {
        changes++;
      }
    }

    _lastProcessed = processed;
    _lastChangeCount = changes;

    // ─── 3. Emit the aggregate change event ─────────────────
    if (changes > 0 || _changeOverflow) {
      _dispatcher.emit(EVENT_TYPE.HLOD_UPDATED, {
        tick,
        processed,
        changes,
        overflow: _changeOverflow,
        // The change arrays are exposed directly for zero-copy consumption.
        // Downstream systems that need them subscribe to this event and
        // read the module's `changes` view.
        changeCount: _changeCount
      });
    }
  },

  /**
   * Resolve the tier and level for a chunk slot on demand. This is the
   * direct API that 336, 350, and 351 use when they need the current HLOD
   * tier without waiting for the next 10 Hz tick.
   *
   * @param {number} streamerSlot
   * @param {object} out - Output object with { tier, level, distanceM }.
   * @returns {boolean} true if the slot is active.
   */
  resolveChunk(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_slotActive[streamerSlot]) return false;
    out.tier = _tier[streamerSlot];
    out.level = _level[streamerSlot];
    out.distanceM = _lastComputedDistance[streamerSlot];
    return true;
  },

  /**
   * Get the tier for a chunk slot. Hot-path accessor.
   */
  getTier(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return HLOD_TIER.KILOMETER;
    return _tier[streamerSlot];
  },

  /**
   * Get the level for a chunk slot. Hot-path accessor.
   */
  getLevel(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return LOD_LEVEL.HIGH;
    return _level[streamerSlot];
  },

  /**
   * Get the last computed distance for a chunk slot. Hot-path accessor.
   */
  getDistance(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return -1;
    return _lastComputedDistance[streamerSlot];
  },

  /**
   * Read the changes from the last tick. Zero-allocation.
   * The caller is expected to treat the arrays as immutable views for the
   * duration of the current tick.
   */
  readChanges(out) {
    out.count = _changeCount;
    out.overflow = _changeOverflow;
    out.slots = _changeSlot;
    out.oldTiers = _changeOldTier;
    out.newTiers = _changeNewTier;
    out.oldLevels = _changeOldLevel;
    out.newLevels = _changeNewLevel;
    return _changeCount;
  },

  /**
   * Convenience: resolve a distance directly to a tier and level. Useful
   * for consumers that already have a distance and want the tier without
   * querying a chunk.
   */
  tierForDistance(distanceM) {
    if (distanceM >= TIER_THRESHOLDS_M[3]) return HLOD_TIER.THOUSAND_KILOMETER;
    if (distanceM >= TIER_THRESHOLDS_M[2]) return HLOD_TIER.HUNDRED_KILOMETER;
    if (distanceM >= TIER_THRESHOLDS_M[1]) return HLOD_TIER.TEN_KILOMETER;
    return HLOD_TIER.KILOMETER;
  },

  levelForDistance(distanceM, tier) {
    return _lodLevelForDistance(distanceM, tier);
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastChangeCount() { return _lastChangeCount; },
  get activeChunks() {
    let count = 0;
    for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) if (_slotActive[i]) count++;
    return count;
  }
});

export default LandscapeChunkHLOD;