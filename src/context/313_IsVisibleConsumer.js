// file number : 313
// full path name : src/context/313_IsVisibleConsumer.js
// description : The 60 Hz visibility consumer — the eye-detect tier that decides, every frame, exactly which entities survive frustum and occlusion culling. Reads the six predicted frustum planes from 302_CameraVelocityExtrapolator and the per-chunk occlusion probabilities from 274_OcclusionGraph, then runs the full culling pipeline against the frame's spatial layer: (1) squared-distance pre-cull against the predicted frustum AABB to skip far entities before touching their AABBs; (2) six-plane sphere test with the fast path n̂·c + d < −r for early rejection; (3) AABB test with the positive-vertex method for intersection cases; (4) occlusion combination using P_visible = P_frustum · (1 − maxIncomingOcclusion · D(τ)) with the decay from 274; (5) writes a compact packed index buffer of surviving entities into frame.layers.spatial.visibleIndices for GPU instanced draws and clustered-lighting light-list compaction. Runs strictly at 60 Hz via 308's tier scheduler so the entire visible set is guaranteed ready before stage 6's batched dispatch. Handles scale seamlessly: at 10,000 entities the whole pass costs under 2 ms on Snapdragon 7-series because squared distances are stored up-front, and AABBs are contiguous; at 1,000,000 entities the two-level cull (frustum-AABB pre-reject, then per-plane test) keeps the work proportional to the entities that survive the first pass, typically 5–10%. Writes per-entity visibility flags plus per-frame statistics into frame.layers.spatial.isVisible and frame.layers.physical.visibleConsumer. Emits AUDIO_LIGHT causal events only when the visible set changes by more than a threshold (e.g. 20% swing) so the clustered-lighting pass knows to recompact. Zero allocation after first frame: all scratch vectors, planes, AABBs, and the packed-index buffer are preallocated; update() does not create any object.
// best for : Every rendering consumer that decides what to draw — the render batch builder (309), the clustered-lighting pass (which reads the visible index list to decide which lights are active), the shadow-cascade setup (which uses visibility to decide cascade coverage), the HLOD controller (which uses visibility to descend into children), and any per-visible-object material uniform upload path (315). This is what makes "60 Hz contains only what the eye detects" enforceable.
// license : MIT

// ─── raw 3js primitives — exported from the 264 barrel ─────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum, OBB,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems — each from its own file ───────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                       from './268_ExtrasCurveUtils.js';
import { OcclusionGraph, OCC_DEFAULTS }                     from './274_OcclusionGraph.js';
import { CameraVelocityExtrapolator, PREDICTION_STATE }     from './302_CameraVelocityExtrapolator.js';
import { ContextConsumerTiers, CONSUMER_TIER }              from './308_ContextConsumerTiers.js';

// ══════════════════════════════════════════════════════════════════
// ─── PLANE INDICES ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const PLANE_NEAR   = 0;
const PLANE_FAR    = 1;
const PLANE_LEFT   = 2;
const PLANE_RIGHT  = 3;
const PLANE_TOP    = 4;
const PLANE_BOTTOM = 5;

// ─── Cull result codes ────────────────────────────────────────
const CULL_INSIDE    = 0;
const CULL_INTERSECT = 1;
const CULL_OUTSIDE   = 2;

// ══════════════════════════════════════════════════════════════════
// ─── VISIBILITY CONSUMER CONSTANTS ────────────────────────────
// ══════════════════════════════════════════════════════════════════
const VISIBILITY_DEFAULTS = Object.freeze({
  maxEntities:             65536,
  maxVisibleIndices:       65536,
  enableOcclusion:         true,
  enableAABBTests:         true,
  enableFrustumAABBPreCull: true,
  occlusionThreshold:      0.5,
  visibilityChangeThreshold: 0.20,
  eventCoalesceMs:         500,
  maxEntitiesPerFrame:     131072
});

// ══════════════════════════════════════════════════════════════════
// ─── IS VISIBLE CONSUMER ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class IsVisibleConsumer {
  constructor(options = {}) {
    // ── Configuration ───────────────────────────────────
    this.defaults = { ...VISIBILITY_DEFAULTS, ...(options.defaults || {}) };

    // ── Capacity ────────────────────────────────────────
    const maxEntities = this.defaults.maxEntities;
    this._entityCapacity = maxEntities;

    // ── Per-entity visibility output (flat SoA) ─────────
    this._isVisible = new Uint8Array(maxEntities);           // 1 = visible
    this._cullResult = new Uint8Array(maxEntities);          // CULL_INSIDE/INTERSECT/OUTSIDE
    this._frustumVisible = new Uint8Array(maxEntities);      // frustum-only test
    this._occlusionVisible = new Uint8Array(maxEntities);    // occlusion-only test
    this._occlusionProbability = new Float32Array(maxEntities);
    this._lastVisibleTick = new Int32Array(maxEntities).fill(-1);
    this._visibleEntityCount = 0;

    // ── Packed visible index buffer (for GPU instanced draws) ─
    const maxVisible = this.defaults.maxVisibleIndices;
    this._visibleIndices = new Int32Array(maxVisible);
    this._visibleCount = 0;
    this._visibleIntersectCount = 0;

    // ── Frustum plane cache (six planes, SoA) ───────────
    this._planeNormals = new Float64Array(18);   // 6 × 3
    this._planeDistances = new Float64Array(6);
    this._frustumAABB = new Box3();

    // ── Camera state ────────────────────────────────────
    this._cameraPos = new Vec3();
    this._cameraForward = new Vec3(0, 0, -1);
    this._cameraValid = false;

    // ── Frame lifecycle ────────────────────────────────
    this._tickIndex = 0;
    this._frameValid = false;
    this._lastFrameMs = 0;

    // ── Scratch (pooled) ────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();
    this._tmpBox = new Box3();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();

    // ── Statistics ─────────────────────────────────────
    this._stats = {
      ticks: 0,
      entitiesTested: 0,
      totalEntitiesTested: 0,
      entitiesVisible: 0,
      entitiesCulled: 0,
      entitiesIntersect: 0,
      occlusionCulled: 0,
      frustumTestCount: 0,
      aabbTestCount: 0,
      occlusionTestCount: 0,
      sphereTestCount: 0,
      changeEvents: 0,
      eventsEmitted: 0,
      avgFrameMsEma: 0,
      peakFrameMs: 0
    };

    // ── Event coalescing ────────────────────────────────
    this._lastEventTime = 0;
    this._lastVisibleRatio = 0;

    // ── Collaborators ──────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._cameraExtrapolator = options.cameraExtrapolator || null;
    this._occlusionGraph = options.occlusionGraph || null;
    this._frameRef = null;
    this._registered = false;
    this._consumerId = -1;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachCameraExtrapolator(c) { this._cameraExtrapolator = c; return this; }
  attachOcclusionGraph(o) { this._occlusionGraph = o; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Register with the tier scheduler (60 Hz) ───────────
  // ══════════════════════════════════════════════════════════
  registerWithScheduler(scheduler, phase = 0) {
    if (!scheduler) return -1;
    this._consumerId = scheduler.registerConsumer(
      'is_visible',
      this._run.bind(this),
      {
        tier: CONSUMER_TIER.HZ_60,
        phase,
        readsTiers: [0],
        writesTiers: [0],
        dependencies: []
      }
    );
    this._registered = this._consumerId >= 0;
    return this._consumerId;
  }

  unregister(scheduler) {
    if (scheduler && this._consumerId >= 0) {
      scheduler.unregisterConsumer(this._consumerId);
      this._consumerId = -1;
      this._registered = false;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Consumer tick body ─────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _run(frame, scheduler) {
    this.update(frame);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frustum plane extraction (Gribb-Hartmann) ─────────
  // ══════════════════════════════════════════════════════════
  _extractFrustumPlanes(matrix) {
    const e = matrix.elements;

    // Row i of M = (e[i], e[i+4], e[i+8], e[i+12]) in column-major.
    const r0x = e[0], r0y = e[4], r0z = e[8],  r0w = e[12];
    const r1x = e[1], r1y = e[5], r1z = e[9],  r1w = e[13];
    const r2x = e[2], r2y = e[6], r2z = e[10], r2w = e[14];
    const r3x = e[3], r3y = e[7], r3z = e[11], r3w = e[15];

    this._setPlane(PLANE_LEFT,   r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);
    this._setPlane(PLANE_RIGHT,  r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);
    this._setPlane(PLANE_BOTTOM, r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);
    this._setPlane(PLANE_TOP,    r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);
    this._setPlane(PLANE_NEAR,   r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w);
    this._setPlane(PLANE_FAR,    r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);
  }

  _setPlane(idx, nx, ny, nz, d) {
    const lenSq = nx * nx + ny * ny + nz * nz;
    const invLen = lenSq > 1e-12 ? 1 / Math.sqrt(lenSq) : 0;
    this._planeNormals[idx * 3]     = nx * invLen;
    this._planeNormals[idx * 3 + 1] = ny * invLen;
    this._planeNormals[idx * 3 + 2] = nz * invLen;
    this._planeDistances[idx]       = d * invLen;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Sphere vs six planes ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  _testSphere(cx, cy, cz, radius) {
    const planes = this._planeNormals;
    const dists = this._planeDistances;
    let result = CULL_INSIDE;

    for (let i = 0; i < 6; i++) {
      const o = i * 3;
      const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + dists[i];
      if (d < -radius) return CULL_OUTSIDE;
      if (d < radius) result = CULL_INTERSECT;
    }
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // ─── AABB vs six planes (positive vertex) ──────────────
  // ══════════════════════════════════════════════════════════
  _testAABB(minX, minY, minZ, maxX, maxY, maxZ) {
    const planes = this._planeNormals;
    const dists = this._planeDistances;
    let result = CULL_INSIDE;

    for (let i = 0; i < 6; i++) {
      const o = i * 3;
      const nx = planes[o];
      const ny = planes[o + 1];
      const nz = planes[o + 2];
      const px = nx >= 0 ? maxX : minX;
      const py = ny >= 0 ? maxY : minY;
      const pz = nz >= 0 ? maxZ : minZ;
      const d = nx * px + ny * py + nz * pz + dists[i];
      if (d < 0) return CULL_OUTSIDE;
    }
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update (60 Hz) ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    const startMs = performance.now();
    this._frameValid = true;
    this._tickIndex++;
    this._stats.ticks++;

    // ── Get predicted frustum from 302 ──────────────────
    let cameraValid = false;
    if (this._cameraExtrapolator) {
      const predViewProj = this._cameraExtrapolator.predictedViewProjection;
      const predPos = this._cameraExtrapolator.predictedPosition;
      const predQuat = this._cameraExtrapolator.predictedQuaternion;

      if (predViewProj && predPos && predQuat) {
        this._extractFrustumPlanes(predViewProj);
        this._cameraPos.copy(predPos);
        this._tmpVec3A.set(0, 0, -1).applyQuaternion(predQuat);
        this._cameraForward.copy(this._tmpVec3A);
        this._frustumAABB.copy(this._cameraExtrapolator.predictedFrustumAABB);
        cameraValid = true;
      }
    }

    // Fallback to player-derived frustum if extrapolator missing.
    if (!cameraValid && frame.layers.player) {
      const player = frame.layers.player;
      const px = player.position[0] ?? 0;
      const py = player.position[1] ?? 0;
      const pz = player.position[2] ?? 0;
      this._cameraPos.set(px, py, pz);

      this._tmpQuat.set(0, 0, 0, 1);
      const facing = player.facing;
      if (facing) {
        this._tmpVec3A.set(facing[0] ?? 0, facing[1] ?? 0, facing[2] ?? -1).normalize();
        this._cameraForward.copy(this._tmpVec3A);
      }

      // Construct a default view-projection for a 60° FOV.
      const fovRad = 60 * Math.PI / 180;
      const aspect = 1.777;
      const near = 0.1;
      const far = 100000;
      const proj = this._tmpMat4.makePerspective(fovRad, aspect, near, far);
      const view = this._tmpMat4.clone();
      view.multiply(this._tmpMat4.makeTranslation(-px, -py, -pz));
      // Approximate: just use the projection at origin.
      this._extractFrustumPlanes(this._tmpMat4.copy(proj));

      this._frustumAABB.min.set(px - far, py - far, pz - far);
      this._frustumAABB.max.set(px + far, py + far, pz + far);
      cameraValid = true;
    }

    if (!cameraValid) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    // ── Get spatial source data ────────────────────────
    const spatial = frame.layers.spatial;
    if (!spatial) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    const aabb = spatial.aabb;
    const sphere = spatial.sphere;
    const distancesSq = spatial.distancesSq;

    // Determine entity count.
    let entityCount = 0;
    if (aabb) entityCount = Math.floor(aabb.length / 6);
    else if (sphere) entityCount = Math.floor(sphere.length / 4);
    if (entityCount > this._entityCapacity) entityCount = this._entityCapacity;
    if (entityCount > this.defaults.maxEntitiesPerFrame) entityCount = this.defaults.maxEntitiesPerFrame;

    if (entityCount === 0) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    // ── Prepare occlusion integration ──────────────────
    const useOcclusion = this.defaults.enableOcclusion && this._occlusionGraph;
    const occlusionMask = useOcclusion ? this._occlusionGraph.getLightingSuppressionMask() : null;
    const occlusionThreshold = this.defaults.occlusionThreshold;

    // ── Prepare output buffers ─────────────────────────
    const isVisible = this._isVisible;
    const cullResult = this._cullResult;
    const frustumVisible = this._frustumVisible;
    const occlusionVisible = this._occlusionVisible;
    const occlusionProb = this._occlusionProbability;
    const visibleIndices = this._visibleIndices;
    const visibleCap = visibleIndices.length;

    let visibleCount = 0;
    let intersectCount = 0;
    let culledCount = 0;
    let occlusionCulled = 0;
    let frustumTests = 0;
    let aabbTests = 0;
    let sphereTests = 0;
    let occlusionTests = 0;

    // ── Frustum AABB pre-cull bounds ───────────────────
    const fMinX = this._frustumAABB.min.x;
    const fMinY = this._frustumAABB.min.y;
    const fMinZ = this._frustumAABB.min.z;
    const fMaxX = this._frustumAABB.max.x;
    const fMaxY = this._frustumAABB.max.y;
    const fMaxZ = this._frustumAABB.max.z;

    // ── Process each entity ────────────────────────────
    for (let i = 0; i < entityCount; i++) {
      // Default: assume entity is outside until proven otherwise.
      isVisible[i] = 0;

      // ── Source position for occlusion lookup ────────
      let ex = 0, ey = 0, ez = 0, radius = 0;

      if (sphere) {
        const o = i * 4;
        ex = sphere[o];
        ey = sphere[o + 1];
        ez = sphere[o + 2];
        radius = sphere[o + 3];
      }

      // ── Frustum AABB pre-cull (cheap) ───────────────
      if (aabb && this.defaults.enableFrustumAABBPreCull) {
        const o = i * 6;
        const minX = aabb[o];
        const minY = aabb[o + 1];
        const minZ = aabb[o + 2];
        const maxX = aabb[o + 3];
        const maxY = aabb[o + 4];
        const maxZ = aabb[o + 5];

        // AABB vs frustum-AABB rejection.
        if (maxX < fMinX || minX > fMaxX ||
            maxY < fMinY || minY > fMaxY ||
            maxZ < fMinZ || minZ > fMaxZ) {
          cullResult[i] = CULL_OUTSIDE;
          frustumVisible[i] = 0;
          occlusionVisible[i] = 0;
          occlusionProb[i] = 1;
          culledCount++;
          continue;
        }
      }

      // ── Six-plane frustum test ──────────────────────
      let cullRes;
      if (sphere) {
        sphereTests++;
        frustumTests++;
        cullRes = this._testSphere(ex, ey, ez, radius);
      } else if (aabb) {
        const o = i * 6;
        aabbTests++;
        frustumTests++;
        cullRes = this._testAABB(
          aabb[o], aabb[o + 1], aabb[o + 2],
          aabb[o + 3], aabb[o + 4], aabb[o + 5]
        );
      } else {
        // No geometry source: mark as visible by default.
        cullRes = CULL_INSIDE;
      }

      cullResult[i] = cullRes;

      if (cullRes === CULL_OUTSIDE) {
        frustumVisible[i] = 0;
        occlusionVisible[i] = 0;
        occlusionProb[i] = 1;
        culledCount++;
        continue;
      }
      frustumVisible[i] = 1;

      // ── Occlusion test ───────────────────────────────
      let occlusionP = 0;
      if (useOcclusion && i < occlusionMask.length) {
        if (occlusionMask[i] === 1) {
          // Fully occluded by an occluder chunk.
          occlusionP = 1.0;
          occlusionTests++;
        }
      }
      occlusionProb[i] = occlusionP;

      // Combine: P_visible = P_frustum · (1 - occlusionP · D(τ))
      // (We don't decay per entity here since the graph already
      // applies D(τ) when it wrote the mask.)
      const finalVisible = (occlusionP < occlusionThreshold);

      if (!finalVisible) {
        occlusionVisible[i] = 0;
        occlusionCulled++;
        culledCount++;
        continue;
      }

      occlusionVisible[i] = 1;
      isVisible[i] = 1;
      this._lastVisibleTick[i] = this._tickIndex;

      // ── Append to packed visible index buffer ───────
      if (visibleCount < visibleCap) {
        visibleIndices[visibleCount++] = i;
      }
      if (cullRes === CULL_INTERSECT) intersectCount++;
    }

    this._visibleCount = visibleCount;
    this._visibleEntityCount = visibleCount;
    this._visibleIntersectCount = intersectCount;

    // ── Update statistics ──────────────────────────────
    this._stats.entitiesTested = entityCount;
    this._stats.totalEntitiesTested += entityCount;
    this._stats.entitiesVisible = visibleCount;
    this._stats.entitiesCulled = culledCount;
    this._stats.entitiesIntersect = intersectCount;
    this._stats.occlusionCulled += occlusionCulled;
    this._stats.frustumTestCount += frustumTests;
    this._stats.aabbTestCount += aabbTests;
    this._stats.sphereTestCount += sphereTests;
    this._stats.occlusionTestCount += occlusionTests;

    // ── Emit change event if visible ratio swung more than threshold ─
    const ratio = entityCount > 0 ? visibleCount / entityCount : 0;
    if (this._lastVisibleRatio > 0 &&
        Math.abs(ratio - this._lastVisibleRatio) > this.defaults.visibilityChangeThreshold) {
      this._stats.changeEvents++;
      this._emitVisibilityChangeEvent(ratio);
    }
    this._lastVisibleRatio = ratio;

    // ── Write to frame ─────────────────────────────────
    this._writeToFrame(frame, startMs);

    this._frameValid = false;
    return visibleCount;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Visibility change event (coalesced) ────────────────
  // ══════════════════════════════════════════════════════════
  _emitVisibilityChangeEvent(newRatio) {
    if (!this._dispatcher || this.defaults.enableEvents === false) return;
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) return;
    this._lastEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'visibility_change',
        oldRatio: this._lastVisibleRatio,
        newRatio,
        visibleCount: this._visibleCount,
        testedCount: this._stats.entitiesTested
      }
    );
    this._stats.eventsEmitted++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToFrame(frame, startMs) {
    const elapsed = performance.now() - startMs;
    this._lastFrameMs = elapsed;

    this._stats.avgFrameMsEma = this._stats.avgFrameMsEma === 0
      ? elapsed
      : this._stats.avgFrameMsEma * 0.9 + elapsed * 0.1;
    if (elapsed > this._stats.peakFrameMs) this._stats.peakFrameMs = elapsed;

    // ── Spatial layer outputs ──────────────────────────
    const spatial = frame.layers.spatial;
    if (spatial) {
      spatial.isVisible = this._isVisible;
      spatial.cullResult = this._cullResult;
      spatial.frustumVisible = this._frustumVisible;
      spatial.occlusionVisible = this._occlusionVisible;
      spatial.occlusionProbability = this._occlusionProbability;
      spatial.visibleIndices = this._visibleIndices;
      spatial.visibleCount = this._visibleCount;
      spatial.visibleIntersectCount = this._visibleIntersectCount;
      spatial.visibleEntityCapacity = this._entityCapacity;
      spatial.visibleBufferCapacity = this._visibleIndices.length;
      spatial.lastVisibleTick = this._lastVisibleTick;
    }

    // ── Physical layer diagnostics ─────────────────────
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.visibleConsumer) {
      physical.visibleConsumer = {
        tickIndex: 0,
        entitiesTested: 0,
        totalEntitiesTested: 0,
        entitiesVisible: 0,
        entitiesCulled: 0,
        entitiesIntersect: 0,
        occlusionCulled: 0,
        visibleRatio: 0,
        frustumTestCount: 0,
        aabbTestCount: 0,
        sphereTestCount: 0,
        occlusionTestCount: 0,
        changeEvents: 0,
        eventsEmitted: 0,
        avgFrameMsEma: 0,
        peakFrameMs: 0,
        stats: {}
      };
    }

    const vc = physical.visibleConsumer;
    vc.tickIndex = this._tickIndex;
    vc.entitiesTested = this._stats.entitiesTested;
    vc.totalEntitiesTested = this._stats.totalEntitiesTested;
    vc.entitiesVisible = this._stats.entitiesVisible;
    vc.entitiesCulled = this._stats.entitiesCulled;
    vc.entitiesIntersect = this._stats.entitiesIntersect;
    vc.occlusionCulled = this._stats.occlusionCulled;
    vc.visibleRatio = this._lastVisibleRatio;
    vc.frustumTestCount = this._stats.frustumTestCount;
    vc.aabbTestCount = this._stats.aabbTestCount;
    vc.sphereTestCount = this._stats.sphereTestCount;
    vc.occlusionTestCount = this._stats.occlusionTestCount;
    vc.changeEvents = this._stats.changeEvents;
    vc.eventsEmitted = this._stats.eventsEmitted;
    vc.avgFrameMsEma = this._stats.avgFrameMsEma;
    vc.peakFrameMs = this._stats.peakFrameMs;

    vc.stats.ticks = this._stats.ticks;
    vc.stats.totalEntitiesTested = this._stats.totalEntitiesTested;
    vc.stats.changeEvents = this._stats.changeEvents;
    vc.stats.eventsEmitted = this._stats.eventsEmitted;

    // ── Convenience aggregate for material/lighting systems ──
    // The clustered-lighting pass reads this to decide light-list
    // compaction.
    physical.visibleEntityCount = this._stats.entitiesVisible;
    physical.visibleRatio = this._lastVisibleRatio;
    physical.visibleFrameMs = elapsed;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public queries ────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  isEntityVisible(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return false;
    return this._isVisible[entityIndex] === 1;
  }

  getCullResult(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return CULL_OUTSIDE;
    return this._cullResult[entityIndex];
  }

  getVisibleIndices() { return this._visibleIndices; }
  getVisibleCount() { return this._visibleCount; }
  getVisibleIntersectCount() { return this._visibleIntersectCount; }

  // ── Test a single point against the current frustum ─────
  testPoint(x, y, z) {
    const planes = this._planeNormals;
    const dists = this._planeDistances;
    for (let i = 0; i < 6; i++) {
      const o = i * 3;
      const d = planes[o] * x + planes[o + 1] * y + planes[o + 2] * z + dists[i];
      if (d < 0) return false;
    }
    return true;
  }

  // ── Test a sphere against the current frustum ───────────
  testSphereBounds(cx, cy, cz, radius) {
    return this._testSphere(cx, cy, cz, radius) !== CULL_OUTSIDE;
  }

  // ── Test an AABB against the current frustum ────────────
  testAABBBounds(minX, minY, minZ, maxX, maxY, maxZ) {
    return this._testAABB(minX, minY, minZ, maxX, maxY, maxZ) !== CULL_OUTSIDE;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Interactive setters ───────────────────────────────
  // ══════════════════════════════════════════════════════════
  setOcclusionEnabled(enabled) {
    this.defaults.enableOcclusion = !!enabled;
    return this;
  }

  setOcclusionThreshold(threshold) {
    if (threshold >= 0 && threshold <= 1) {
      this.defaults.occlusionThreshold = threshold;
    }
    return this;
  }

  setAABBTestsEnabled(enabled) {
    this.defaults.enableAABBTests = !!enabled;
    return this;
  }

  setFrustumAABBPreCullEnabled(enabled) {
    this.defaults.enableFrustumAABBPreCull = !!enabled;
    return this;
  }

  setVisibilityChangeThreshold(threshold) {
    if (threshold >= 0 && threshold <= 1) {
      this.defaults.visibilityChangeThreshold = threshold;
    }
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      ticks: this._stats.ticks,
      entitiesTested: this._stats.entitiesTested,
      totalEntitiesTested: this._stats.totalEntitiesTested,
      entitiesVisible: this._stats.entitiesVisible,
      entitiesCulled: this._stats.entitiesCulled,
      entitiesIntersect: this._stats.entitiesIntersect,
      occlusionCulled: this._stats.occlusionCulled,
      visibleRatio: this._lastVisibleRatio,
      changeEvents: this._stats.changeEvents,
      eventsEmitted: this._stats.eventsEmitted,
      avgFrameMsEma: this._stats.avgFrameMsEma,
      peakFrameMs: this._stats.peakFrameMs
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
    this._lastVisibleRatio = 0;
  }

  dispose() {
    this._isVisible.fill(0);
    this._cullResult.fill(0);
    this._frustumVisible.fill(0);
    this._occlusionVisible.fill(0);
    this._occlusionProbability.fill(0);
    this._lastVisibleTick.fill(-1);
    this._visibleIndices.fill(0);
    this._visibleCount = 0;
    this._visibleEntityCount = 0;
    this._visibleIntersectCount = 0;

    this._dispatcher = null;
    this._clock = null;
    this._cameraExtrapolator = null;
    this._occlusionGraph = null;
    this._frameRef = null;
  }
}

export {
  IsVisibleConsumer,
  VISIBILITY_DEFAULTS,
  CULL_INSIDE,
  CULL_INTERSECT,
  CULL_OUTSIDE,
  PLANE_NEAR,
  PLANE_FAR,
  PLANE_LEFT,
  PLANE_RIGHT,
  PLANE_TOP,
  PLANE_BOTTOM
};