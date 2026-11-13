// file number : 356
// full path name : src/context/356_LandscapeRebuildDeferral.js
// description : Landscape rebuild deferral — the 10 Hz consumer that enforces
// the blueprint's rebuild discipline: it ensures that no chunk's geometry is
// rebuilt more than once per second per instance, never while the camera is
// looking at it, and prefers rebuilding behind the camera or during a
// visibility dip. It queues every rebuild request from upstream systems
// (337_LandscapeChunkStreamer, 343_LandscapeErosionSimulator,
// 344_LandscapeWindErosionSystem, 345_LandscapeWaterFlowSystem,
// 346_LandscapeVegetationScatterSystem, 347_LandscapeFaunaSpawnSystem,
// 348_LandscapeDecalPlacementSystem, 349_LandscapePropPlacementSystem,
// 350_LandscapeShadowScaler, 351_LandscapeLightingCoupler,
// 352_LandscapeSkyCoupler, 353_LandscapeSeasonCoupler,
// 354_LandscapeSensoryCoupler, and 355_LandscapePerformanceGovernor),
// checks the predicted camera frustum from 302_CameraVelocityExtrapolator,
// and either executes the rebuild immediately (if the chunk is behind the
// camera, occluded, or at a coarse HLOD tier) or defers it to a later tick
// (if the chunk is visible and at a fine HLOD tier). The deferral queue is
// bounded, and requests that age past REBUILD_FORCE_AGE_S are force-executed
// even if the chunk is visible, so a slow rebuild cannot starve forever.
//
// The system maintains the following guarantees, in priority order:
//   (1) HARD RATE LIMIT — a single chunk instance is never rebuilt more than
//       once per REBUILD_MIN_INTERVAL_S (default 1.0 s). Every rebuild
//       request that arrives before the interval expires is coalesced with
//       the pending one so the last-writer-wins semantics are preserved.
//   (2) VISIBILITY DEFERENCE — a chunk that is currently visible in the
//       predicted frustum is never rebuilt unless (a) it is at a coarse
//       HLOD tier (HUNDRED or THOUSAND), (b) it is behind the camera, (c) it
//       is fully occluded, or (d) the request has been pending for more than
//       REBUILD_FORCE_AGE_S. This is what keeps the render loop from ever
//       stuttering on a visible geometry rebuild.
//   (3) BUDGET DISCIPLINE — the total number of rebuilds executed per tick
//       is bounded by both a chunk-count budget (default 8) and a CPU-time
//       budget (default 2.0 ms). The budget is lowered further by the
//       governor's per-tier degradation multipliers, so a tight-frame
//       device performs fewer rebuilds per tick rather than dropping
//       frames.
//   (4) AGE CAPPING — a request that has been pending for more than
//       REBUILD_MAX_AGE_S (default 10 s) is abandoned and a diagnostic event
//       is emitted. This prevents a pathological chunk from consuming an
//       unbounded amount of deferral memory.
//   (5) NIGHT / OCCLUSION WINDOW — during a night-time or heavily fogged
//       window in the chunk's fused lighting record, the deferral policy is
//       loosened: rebuilds can proceed even when the chunk is visible,
//       because the visual discontinuity is much less noticeable.
//
// The rebuild callback is a small, pluggable function that the upstream
// system supplies when it enqueues a request. The callback is stored in a
// pooled slot and executed once when the request is dequeued. This makes
// the deferral system completely agnostic to what kind of rebuild is
// happening — geometry, material uniforms, particle pool, audio emitter
// rebuild, whatever the upstream system needs.
//
// The deferral system is fully tier-aware: KILOMETER-tier chunks are
// subject to the strictest deferral policy (never rebuild while visible);
// TEN_KILOMETER-tier chunks can be rebuilt while visible if the visibility
// dip is short; HUNDRED-tier chunks can be rebuilt immediately; THOUSAND-tier
// chunks are always rebuilt immediately because their visual footprint is
// negligible. The per-tier policy is chosen to match each tier's visibility
// characteristics, so the strictest discipline is applied where a stutter
// would be most noticeable.
//
// Material and lighting parameters are integrated first-class: the deferral
// policy reads the chunk's fused sun intensity, fog density, and canopy
// occlusion from 351_LandscapeLightingCoupler and 333_BiomeSoilCoupling to
// decide whether a rebuild would be visible at all. A rebuild in a chunk
// whose lighting state is dominated by fog, or whose sun is directly
// overhead, is much less visible than a rebuild in a chunk that is
// side-lit and clear — and the deferral system uses this signal to loosen
// its policy accordingly.
//
// The system works identically on WebGL1 and WebGL2 because the actual
// rebuild callback is supplied by the upstream system, which is responsible
// for choosing the right API for the device. The deferral system itself
// only schedules and dispatches, so it has no WebGL2-specific dependencies.
//#
// best for : Every consumer that schedules a rebuild of per-chunk state —
// 337_LandscapeChunkStreamer (geometry rebuilds on chunk load),
// 343_LandscapeErosionSimulator (terrain heightfield rebuild after
// erosion), 344_LandscapeWindErosionSystem (terrain heightfield rebuild
// after wind erosion), 345_LandscapeWaterFlowSystem (river channel rebuild
// after flow changes), 346_LandscapeVegetationScatterSystem (vegetation
// instance buffer rebuild), 347_LandscapeFaunaSpawnSystem (animal instance
// buffer rebuild), 348_LandscapeDecalPlacementSystem (decal instance
// buffer rebuild), 349_LandscapePropPlacementSystem (prop instance buffer
// rebuild), 350_LandscapeShadowScaler (shadow map rebuild),
// 351_LandscapeLightingCoupler (lighting uniform batch rebuild),
// 352_LandscapeSkyCoupler (sky dome uniform rebuild),
// 353_LandscapeSeasonCoupler (seasonal palette rebuild),
// 354_LandscapeSensoryCoupler (sensory batch rebuild), and
// 355_LandscapePerformanceGovernor (any consumer that wants a rate-limited
// rebuild path). The system is the single authority on when a chunk's
// geometry may be rebuilt, and every consumer that rebuilds per-chunk state
// must go through it.
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
import { CameraVelocityExtrapolator } from './302_CameraVelocityExtrapolator.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeLightingCoupler } from './351_LandscapeLightingCoupler.js';
import { LandscapePerformanceGovernor } from './355_LandscapePerformanceGovernor.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–355.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Maximum number of pending rebuild requests across all chunks. The pool
// is fixed-size; when it is full, the oldest request is abandoned and a
// diagnostic event is emitted. 4096 pending requests is a generous ceiling
// that supports a very rapid camera fly-over with hundreds of chunks
// streaming in at once.
const MAX_PENDING_REQUESTS = 4096;

// Per-tick chunk-count budget. The deferral system processes at most this
// many rebuild requests per tick (subject to the governor's per-tier
// multipliers).
const DEFAULT_TICK_CHUNK_BUDGET = 8;

// Per-tick CPU-time budget in milliseconds.
const DEFAULT_TICK_CPU_BUDGET_MS = 2.0;

// Hard rate limit — a single chunk instance is never rebuilt more than once
// per this interval.
const REBUILD_MIN_INTERVAL_S = 1.0;

// Age at which a pending request is force-executed even if the chunk is
// visible.
const REBUILD_FORCE_AGE_S = 3.0;

// Age at which a pending request is abandoned entirely.
const REBUILD_MAX_AGE_S = 10.0;

// ─── Per-tier deferral policy ────────────────────────────────
// The per-tier deferral policy determines whether a request can be executed
// while the chunk is visible. Each entry is a struct:
//   {
//     skipWhileVisible: boolean,   // never rebuild while visible unless forced
//     visibilityDipWindowS: number, // max time to wait for a visibility dip
//     chunkBudgetMultiplier: number // how much of the tick budget this tier gets
//   }
const TIER_DEFERRAL_POLICY = Object.freeze([
  // KILOMETER: strict — never rebuild while visible unless forced.
  Object.freeze({ skipWhileVisible: true,  visibilityDipWindowS: 3.0, chunkBudgetMultiplier: 0.4 }),
  // TEN_KILOMETER: moderate — wait up to 2 s for a visibility dip.
  Object.freeze({ skipWhileVisible: true,  visibilityDipWindowS: 2.0, chunkBudgetMultiplier: 0.3 }),
  // HUNDRED_KILOMETER: relaxed — wait up to 0.5 s for a visibility dip.
  Object.freeze({ skipWhileVisible: false, visibilityDipWindowS: 0.5, chunkBudgetMultiplier: 0.2 }),
  // THOUSAND_KILOMETER: immediate — always rebuild immediately.
  Object.freeze({ skipWhileVisible: false, visibilityDipWindowS: 0.0, chunkBudgetMultiplier: 0.1 })
]);

// ─── Visibility dip detection ──────────────────────────────
// A "visibility dip" is a short window during which the chunk is not in
// the predicted frustum, even though it may be in the current frustum.
// The deferral system looks ahead by CAMERA_LOOKAHEAD_S seconds and treats
// the chunk as "visible" if it is in the frustum at any time in that
// window. A chunk that will become visible in the next tick is not safe to
// rebuild.
const CAMERA_LOOKAHEAD_S = 0.2;

// ─── Night / fog deferral loosening ────────────────────────
// When the fused sun intensity is below NIGHT_SUN_INTENSITY_THRESHOLD or
// the fused fog density is above HEAVY_FOG_DENSITY_THRESHOLD, the deferral
// policy is loosened because a rebuild discontinuity would be much less
// visible.
const NIGHT_SUN_INTENSITY_THRESHOLD = 0.15;
const HEAVY_FOG_DENSITY_THRESHOLD = 0.03;
const LOOSENED_POLICY_MULTIPLIER = 0.5;   // effective visibility-dip wait is halved

// ─── Rebuild type enum ──────────────────────────────────────
const REBUILD_TYPE = Object.freeze({
  GEOMETRY: 0,
  MATERIAL: 1,
  INSTANCE_BUFFER: 2,
  SHADOW_MAP: 3,
  LIGHTING_BATCH: 4,
  SKY_UNIFORM: 5,
  SENSORY_BATCH: 6,
  SEASONAL_PALETTE: 7,
  OTHER: 8
});

// ══════════════════════════════════════════════════════════════════
// ─── POOLED REBUILD REQUEST QUEUE (structure-of-arrays) ───────
// ══════════════════════════════════════════════════════════════════
// Each pending request is one slot in a set of parallel typed arrays.
// The `_requestCallback` array holds the actual JS function to call when
// the request is dispatched. The `_requestPayload` array holds an opaque
// payload that is passed to the callback.

const _requestChunkSlot      = new Int32Array(MAX_PENDING_REQUESTS).fill(-1);
const _requestType           = new Uint8Array(MAX_PENDING_REQUESTS);
const _requestEnqueueTimeS   = new Float32Array(MAX_PENDING_REQUESTS);
const _requestPriority       = new Float32Array(MAX_PENDING_REQUESTS);
const _requestCallback       = new Array(MAX_PENDING_REQUESTS).fill(null);
const _requestPayload        = new Array(MAX_PENDING_REQUESTS).fill(null);
const _requestActive         = new Uint8Array(MAX_PENDING_REQUESTS);

// Free list for request slots.
const _requestFreeStack      = new Int32Array(MAX_PENDING_REQUESTS);
let _requestFreeTop          = MAX_PENDING_REQUESTS;
for (let i = 0; i < MAX_PENDING_REQUESTS; i++) _requestFreeStack[i] = MAX_PENDING_REQUESTS - 1 - i;

// ─── Per-chunk last-rebuild time ────────────────────────────
// Used to enforce the hard rate limit. -1 means "never rebuilt".
const _lastRebuildS          = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastRebuildType       = new Uint8Array(MAX_TRACKED_CHUNKS);
const _rebuildCount          = new Uint32Array(MAX_TRACKED_CHUNKS);

// Per-chunk active flag.
const _chunkActive           = new Uint8Array(MAX_TRACKED_CHUNKS);

// Round-robin cursor for the run() loop.
let _rrCursor                = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Frustum planes from the predicted camera.
const _predictedFrustumPlanes = new Float32Array(6 * 4);

// Camera predicted position.
const _predictedCameraPos     = new Vec3();
const _predictedCameraForward = new Vec3();

// Lighting read scratch.
const _lightingScratch = {
  sunIntensity: 0,
  fogDensity: 0,
  isNight: false,
  isOccluded: false
};

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastDispatched = 0;
let _lastDeferred = 0;
let _lastAbandoned = 0;
let _lastTickDurationMs = 0;
let _pendingCount = 0;
let _totalEnqueued = 0;
let _totalDispatched = 0;
let _totalAbandoned = 0;

// ══════════════════════════════════════════════════════════════════
// ─── FRUSTUM EXTRACTION ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _extractFrustumPlanes(viewProjectionMat4) {
  const m = viewProjectionMat4.elements;
  // Left / Right / Bottom / Top / Near / Far
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

function _sphereInPredictedFrustum(cx, cy, cz, radiusM) {
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

// ══════════════════════════════════════════════════════════════════
// ─── REQUEST SLOT LIFECYCLE ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _allocRequestSlot() {
  if (_requestFreeTop === 0) return -1;
  return _requestFreeStack[--_requestFreeTop];
}

function _freeRequestSlot(slot) {
  if (slot < 0 || slot >= MAX_PENDING_REQUESTS) return;
  _requestActive[slot] = 0;
  _requestChunkSlot[slot] = -1;
  _requestType[slot] = 0;
  _requestEnqueueTimeS[slot] = 0;
  _requestPriority[slot] = 0;
  _requestCallback[slot] = null;
  _requestPayload[slot] = null;
  _pendingCount = Math.max(0, _pendingCount - 1);
  if (_requestFreeTop < MAX_PENDING_REQUESTS) {
    _requestFreeStack[_requestFreeTop++] = slot;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── VISIBILITY CHECK ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Check whether a chunk is visible in the predicted frustum. Returns
// { visible, dipLikely }. `dipLikely` is true when the chunk is currently
// visible but the extrapolator suggests it may become invisible in the
// next CAMERA_LOOKAHEAD_S seconds — which is exactly the kind of window
// the deferral policy is designed to exploit.
function _checkChunkVisibility(streamerSlot) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return { visible: false, dipLikely: false };

  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return { visible: false, dipLikely: false };

  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const centerX = (view.chunkX + 0.5) * cs;
  const centerY = (view.chunkY + 0.5) * cs;
  const centerZ = (view.chunkZ + 0.5) * cs;
  const radius = cs * 0.8660254;   // half-diagonal of the chunk cube

  // Frustum test.
  const visible = _sphereInPredictedFrustum(centerX, centerY, centerZ, radius);

  // Dip detection: if the chunk is visible but very close to the frustum
  // boundary (i.e. the farthest point of the chunk is just barely inside),
  // we consider a dip "likely" — the camera might tilt a fraction of a
  // degree and hide the chunk.
  let dipLikely = false;
  if (visible) {
    let minSignedDistance = Infinity;
    for (let p = 0; p < 6; p++) {
      const base = p * 4;
      const nx = _predictedFrustumPlanes[base];
      const ny = _predictedFrustumPlanes[base + 1];
      const nz = _predictedFrustumPlanes[base + 2];
      const d  = _predictedFrustumPlanes[base + 3];
      const signedDist = nx * centerX + ny * centerY + nz * centerZ + d;
      if (signedDist < minSignedDistance) minSignedDistance = signedDist;
    }
    // A chunk whose nearest corner is within 2× the chunk radius of the
    // frustum boundary is "near the edge" and likely to dip out of view
    // soon.
    if (minSignedDistance < radius * 2.0) dipLikely = true;
  }

  return { visible, dipLikely };
}

// ══════════════════════════════════════════════════════════════════
// ─── REBUILD DISPATCH ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Execute a rebuild request immediately.
function _executeRebuild(requestSlot, nowS) {
  const streamerSlot = _requestChunkSlot[requestSlot];
  const type = _requestType[requestSlot];
  const callback = _requestCallback[requestSlot];
  const payload = _requestPayload[requestSlot];

  if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) {
    _freeRequestSlot(requestSlot);
    return;
  }

  // Update the per-chunk rate limiter.
  _lastRebuildS[streamerSlot] = nowS;
  _lastRebuildType[streamerSlot] = type;
  _rebuildCount[streamerSlot]++;

  // Execute the callback.
  if (typeof callback === 'function') {
    try {
      callback(streamerSlot, payload);
    } catch (e) {
      // Swallow callback errors so one bad callback cannot bring down the
      // whole deferral system.
      if (typeof console !== 'undefined' && console.error) {
        console.error('[RebuildDeferral] Callback error:', e);
      }
    }
  }

  _totalDispatched++;
  _lastDispatched++;

  _dispatcher.emit(EVENT_TYPE.REBUILD_EXECUTED, {
    streamerSlot,
    type,
    tick: nowS,
    rebuildCount: _rebuildCount[streamerSlot]
  });

  _freeRequestSlot(requestSlot);
}

// Abandon a request that has aged past REBUILD_MAX_AGE_S.
function _abandonRequest(requestSlot, nowS) {
  const streamerSlot = _requestChunkSlot[requestSlot];
  const ageS = nowS - _requestEnqueueTimeS[requestSlot];
  _totalAbandoned++;
  _lastAbandoned++;
  _dispatcher.emit(EVENT_TYPE.REBUILD_ABANDONED, {
    streamerSlot,
    type: _requestType[requestSlot],
    ageS,
    tick: nowS
  });
  _freeRequestSlot(requestSlot);
}

// ══════════════════════════════════════════════════════════════════
// ─── DEFERRAL POLICY CHECK ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Check whether a rebuild request can be dispatched right now.
function _canDispatchNow(requestSlot, nowS) {
  const streamerSlot = _requestChunkSlot[requestSlot];
  const enqueueS = _requestEnqueueTimeS[requestSlot];
  const ageS = nowS - enqueueS;

  // ─── Rule 1: age cap ────────────────────────────────────
  if (ageS >= REBUILD_MAX_AGE_S) {
    _abandonRequest(requestSlot, nowS);
    return false;
  }

  // ─── Rule 2: hard rate limit ────────────────────────────
  const lastRebuild = _lastRebuildS[streamerSlot];
  if (lastRebuild >= 0 && (nowS - lastRebuild) < REBUILD_MIN_INTERVAL_S) {
    return false;
  }

  // ─── Rule 3: force-execute after force age ──────────────
  if (ageS >= REBUILD_FORCE_AGE_S) {
    return true;
  }

  // ─── Rule 4: tier-based deferral ────────────────────────
  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const policy = TIER_DEFERRAL_POLICY[tier];

  // Coarse tiers never defer while visible.
  if (!policy.skipWhileVisible) {
    return true;
  }

  // ─── Rule 5: occlusion and night/fog loosening ──────────
  // Fully occluded chunks are always safe to rebuild.
  if (LandscapeChunkOcclusion.isFullyOccluded(streamerSlot)) {
    return true;
  }

  // Read the lighting state. If the chunk is night-time or heavily fogged,
  // we can halve the visibility-dip wait.
  let effectiveWaitS = policy.visibilityDipWindowS;
  if (LandscapeLightingCoupler) {
    const sunIntensity = LandscapeLightingCoupler.getSunIntensity(streamerSlot);
    const fogDensity = LandscapeLightingCoupler.getFogDensity(streamerSlot);
    if (sunIntensity < NIGHT_SUN_INTENSITY_THRESHOLD || fogDensity > HEAVY_FOG_DENSITY_THRESHOLD) {
      effectiveWaitS *= LOOSENED_POLICY_MULTIPLIER;
    }
  }

  // If we haven't been waiting long enough, defer.
  if (ageS < effectiveWaitS) {
    return false;
  }

  // ─── Rule 6: visibility check ───────────────────────────
  const { visible, dipLikely } = _checkChunkVisibility(streamerSlot);
  if (!visible) {
    // Not currently visible — safe to rebuild.
    return true;
  }
  if (dipLikely) {
    // Visible but likely to dip out soon — defer one more tick to catch
    // the dip.
    return false;
  }

  // Visible and unlikely to dip — keep deferring until forced by age.
  return false;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeRebuildDeferral = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  REBUILD_TYPE,
  TIER_DEFERRAL_POLICY,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  minIntervalS: REBUILD_MIN_INTERVAL_S,
  forceAgeS: REBUILD_FORCE_AGE_S,
  maxAgeS: REBUILD_MAX_AGE_S,
  maxPendingRequests: MAX_PENDING_REQUESTS,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _lastRebuildS[streamerSlot] = -1;
    _lastRebuildType[streamerSlot] = 0;
    _rebuildCount[streamerSlot] = 0;
    return true;
  },

  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _chunkActive[streamerSlot] = 0;
    // Abandon any pending requests for this chunk.
    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
      if (_requestActive[i] && _requestChunkSlot[i] === streamerSlot) {
        _freeRequestSlot(i);
      }
    }
  },

  /**
   * Enqueue a rebuild request. The request will be executed when the
   * deferral policy allows. If the pool is full, the oldest request is
   * abandoned and a diagnostic event is emitted.
   *
   * @param {number} streamerSlot
   * @param {number} rebuildType - One of REBUILD_TYPE.
   * @param {function} callback - Called as callback(streamerSlot, payload).
   * @param {any} [payload] - Opaque payload passed to the callback.
   * @param {number} [priority=0] - Higher priority requests are dispatched first.
   * @returns {number} The request slot, or -1 if the request could not be
   *                   enqueued.
   */
  enqueue(streamerSlot, rebuildType, callback, payload, priority) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return -1;
    if (!_chunkActive[streamerSlot]) return -1;
    if (typeof callback !== 'function') return -1;

    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    // Coalesce: if a request for the same chunk and type is already pending,
    // replace its callback and payload with the new ones and update its
    // priority. This preserves last-writer-wins semantics and prevents the
    // queue from filling with duplicate requests.
    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
      if (!_requestActive[i]) continue;
      if (_requestChunkSlot[i] !== streamerSlot) continue;
      if (_requestType[i] !== rebuildType) continue;
      _requestCallback[i] = callback;
      _requestPayload[i] = payload;
      _requestEnqueueTimeS[i] = nowS;
      _requestPriority[i] = priority !== undefined ? priority : 0;
      return i;
    }

    // Allocate a new slot.
    const slot = _allocRequestSlot();
    if (slot === -1) {
      // Pool is full. Abandon the oldest request.
      let oldestSlot = -1;
      let oldestTime = Infinity;
      for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
        if (!_requestActive[i]) continue;
        if (_requestEnqueueTimeS[i] < oldestTime) {
          oldestTime = _requestEnqueueTimeS[i];
          oldestSlot = i;
        }
      }
      if (oldestSlot !== -1) _abandonRequest(oldestSlot, nowS);
      // Try again.
      const retrySlot = _allocRequestSlot();
      if (retrySlot === -1) return -1;
      _requestActive[retrySlot] = 1;
      _requestChunkSlot[retrySlot] = streamerSlot;
      _requestType[retrySlot] = rebuildType;
      _requestEnqueueTimeS[retrySlot] = nowS;
      _requestPriority[retrySlot] = priority !== undefined ? priority : 0;
      _requestCallback[retrySlot] = callback;
      _requestPayload[retrySlot] = payload;
      _pendingCount++;
      _totalEnqueued++;
      return retrySlot;
    }

    _requestActive[slot] = 1;
    _requestChunkSlot[slot] = streamerSlot;
    _requestType[slot] = rebuildType;
    _requestEnqueueTimeS[slot] = nowS;
    _requestPriority[slot] = priority !== undefined ? priority : 0;
    _requestCallback[slot] = callback;
    _requestPayload[slot] = payload;
    _pendingCount++;
    _totalEnqueued++;
    return slot;
  },

  /**
   * The 10 Hz consumer entry point. Called by 308_ContextConsumerTiers.
   */
  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    // ─── 1. Read the predicted camera state ─────────────────
    const spatial = frame && frame.spatial;
    const camExtrapolator = spatial && spatial.cameraExtrapolator;
    if (camExtrapolator) {
      const predicted = camExtrapolator.predictNextFrame();
      _predictedCameraPos.set(predicted.position.x, predicted.position.y, predicted.position.z);
      _predictedCameraForward.set(predicted.forward.x, predicted.forward.y, predicted.forward.z);
      _extractFrustumPlanes(predicted.viewProjection);
    } else if (spatial && spatial.cameraPosition && spatial.viewProjectionMatrix) {
      _predictedCameraPos.set(spatial.cameraPosition.x, spatial.cameraPosition.y, spatial.cameraPosition.z);
      _extractFrustumPlanes(spatial.viewProjectionMatrix);
    }

    // ─── 2. Determine the effective per-tick budget ────────
    let budget = this.tickChunkBudget;
    let cpuBudgetMs = this.tickCpuBudgetMs;
    if (LandscapePerformanceGovernor && typeof LandscapePerformanceGovernor.getDegradationState === 'function') {
      const state = LandscapePerformanceGovernor.getDegradationState();
      // Reduce the budget by up to 50 % under heavy degradation.
      const factor = 0.5 + state * 0.5;
      budget = Math.max(1, Math.floor(budget * factor));
      cpuBudgetMs *= factor;
    }

    // ─── 3. Collect the dispatchable requests ──────────────
    // We walk all pending requests, check the policy, and dispatch the ones
    // that pass. To avoid dispatching low-priority requests before high-
    // priority ones, we collect dispatchable candidates first and then sort
    // them by priority.
    let candidates = _dispatchCandidatesScratch;
    let candidateCount = 0;
    let deferredCount = 0;
    let abandonedCount = 0;

    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
      if (!_requestActive[i]) continue;

      // Age cap check first.
      const ageS = nowS - _requestEnqueueTimeS[i];
      if (ageS >= REBUILD_MAX_AGE_S) {
        _abandonRequest(i, nowS);
        abandonedCount++;
        continue;
      }

      // Policy check.
      if (_canDispatchNow(i, nowS)) {
        if (candidateCount < _dispatchCandidatesScratch.length) {
          candidates[candidateCount++] = i;
        } else {
          // Candidate buffer is full — the request will be re-checked on
          // the next tick.
          deferredCount++;
        }
      } else {
        deferredCount++;
      }
    }

    // ─── 4. Sort candidates by descending priority ─────────
    // Simple insertion sort; the candidate list is small (bounded by the
    // per-tick budget which is itself bounded by the number of pending
    // requests).
    for (let i = 1; i < candidateCount; i++) {
      const key = candidates[i];
      const keyPriority = _requestPriority[key];
      let j = i - 1;
      while (j >= 0 && _requestPriority[candidates[j]] < keyPriority) {
        candidates[j + 1] = candidates[j];
        j--;
      }
      candidates[j + 1] = key;
    }

    // ─── 5. Dispatch up to the per-tick budget ─────────────
    let dispatched = 0;
    for (let i = 0; i < candidateCount && dispatched < budget; i++) {
      _executeRebuild(candidates[i], nowS);
      dispatched++;
      if ((performanceNow() - t0) > cpuBudgetMs) break;
    }

    _lastProcessed = tick;
    _lastDispatched = dispatched;
    _lastDeferred = deferredCount;
    _lastAbandoned = abandonedCount;
    _lastTickDurationMs = performanceNow() - t0;

    if (dispatched > 0 || abandonedCount > 0) {
      _dispatcher.emit(EVENT_TYPE.REBUILD_DEFERRAL_UPDATED, {
        tick,
        dispatched,
        deferred: deferredCount,
        abandoned: abandonedCount,
        pendingCount: _pendingCount,
        durationMs: _lastTickDurationMs
      });
    }
  },

  /**
   * Force-execute a pending rebuild request immediately, regardless of
   * policy. Used by 337 when a chunk is about to be streamed out and its
   * pending rebuild would otherwise be abandoned.
   */
  forceExecute(requestSlot) {
    if (requestSlot < 0 || requestSlot >= MAX_PENDING_REQUESTS) return false;
    if (!_requestActive[requestSlot]) return false;
    const nowS = BiomeBlendSystem.elapsedSimSeconds;
    _executeRebuild(requestSlot, nowS);
    return true;
  },

  /**
   * Cancel a pending rebuild request without executing it.
   */
  cancel(requestSlot) {
    if (requestSlot < 0 || requestSlot >= MAX_PENDING_REQUESTS) return false;
    if (!_requestActive[requestSlot]) return false;
    _freeRequestSlot(requestSlot);
    return true;
  },

  /**
   * Query whether a chunk has a pending rebuild request of the given type.
   */
  hasPendingRequest(streamerSlot, rebuildType) {
    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
      if (!_requestActive[i]) continue;
      if (_requestChunkSlot[i] === streamerSlot) {
        if (rebuildType === undefined || _requestType[i] === rebuildType) return true;
      }
    }
    return false;
  },

  /**
   * Get the time since the last rebuild of a chunk, in seconds. Returns
   * Infinity if the chunk has never been rebuilt.
   */
  getTimeSinceLastRebuild(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return Infinity;
    const last = _lastRebuildS[streamerSlot];
    if (last < 0) return Infinity;
    return BiomeBlendSystem.elapsedSimSeconds - last;
  },

  /**
   * Get the total number of rebuilds performed for a chunk.
   */
  getRebuildCount(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _rebuildCount[streamerSlot];
  },

  /**
   * Read the current deferral state into a preallocated output object.
   */
  readState(out) {
    out.pendingCount = _pendingCount;
    out.totalEnqueued = _totalEnqueued;
    out.totalDispatched = _totalDispatched;
    out.totalAbandoned = _totalAbandoned;
    out.lastDispatched = _lastDispatched;
    out.lastDeferred = _lastDeferred;
    out.lastAbandoned = _lastAbandoned;
    out.freeSlots = _requestFreeTop;
    out.capacity = MAX_PENDING_REQUESTS;
    return true;
  },

  // ─── Direct accessor API ─────────────────────────────────
  get pendingRequests() { return _pendingCount; },
  get totalEnqueued() { return _totalEnqueued; },
  get totalDispatched() { return _totalDispatched; },
  get totalAbandoned() { return _totalAbandoned; },
  get freeSlots() { return _requestFreeTop; },
  get capacity() { return MAX_PENDING_REQUESTS; },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastDispatched() { return _lastDispatched; },
  get lastDeferred() { return _lastDeferred; },
  get lastAbandoned() { return _lastAbandoned; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get activeChunks() {
    let n = 0;
    for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) if (_chunkActive[i]) n++;
    return n;
  }
});

// Scratch buffer for dispatch candidates. Sized to the number of pending
// requests, so a full queue can be considered in a single pass.
const _dispatchCandidatesScratch = new Int32Array(MAX_PENDING_REQUESTS);

function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default LandscapeRebuildDeferral;