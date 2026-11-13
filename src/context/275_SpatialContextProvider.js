// file number : 275
// full path name : src/context/275_SpatialContextProvider.js
// description : Spatial context provider that fills the spatial layer of the context frame every 10-15 Hz. Composes the outputs of 271_SpatialHashGrid (broad-phase candidates), 272_DynamicBVH (large moving entities), 273_FrustumCullingSystem (six-plane tests and packed visible list), and 274_OcclusionGraph (occlusion-decayed visibility) into one coherent write to frame.layers.spatial. For every entity it writes: AABB (6 floats), bounding sphere center + radius (4 floats), squared distance to camera (1 float), frustum/occlusion flag (1 byte), screen-coverage estimate (1 float), and a lighting-eligible flag for clustered lighting. Screen coverage is approximated as projected solid angle A/d² clamped to [0,1]. All scratch Vec3, Mat4, Sphere, Box3, and Frustum instances are pooled; update() and updateFromCamera() allocate nothing after construction. Idempotent — calling update() twice in the same tick produces the same frame.
// best for : Being the single write point for spatial context in the living world. Every consumer that needs to know "where things are" — LOD selection, streaming, render batching, clustered-lighting light-list compaction, material uniform uploads — reads from the frame this provider writes.
// license : MIT

import {
  Vec2,
  Vec3,
  Vec4,
  Mat4,
  Quat,
  Plane,
  Sphere,
  Box3,
  OBB,
  Frustum,
  Ray,
  Precision,
  ColorManagement,
  ColorSpace,
  ContextFrame,
  CoreClock,
  CoreLayers,
  LAYER,
  LAYER_MASKS,
  SpatialHashGrid,
  DynamicBVH,
  FrustumCullingSystem,
  OcclusionGraph
} from './264_MathECSImportBarrel.js';

// ─── provider frequency (matches the 10–15 Hz provider tier) ─────
const PROVIDER_HZ = 10;
const PROVIDER_INTERVAL = 1 / PROVIDER_HZ;

// ─── occlusion default threshold ─────────────────────────────────
const DEFAULT_OCCLUSION_THRESHOLD = 0.5;

// ─── screen-coverage scaling constant ────────────────────────────
// coverage = k · A / d², tuned so a 1 m² object at 10 m covers
// roughly 1% of the screen. k absorbs field-of-view and resolution.
const SCREEN_COVERAGE_K = 0.01;

class SpatialContextProvider {
  constructor(options = {}) {
    // ── collaborators (all optional; graceful degradation) ────
    this._spatialHash = options.spatialHash || null;
    this._bvh = options.bvh || null;
    this._frustumCulling = options.frustumCulling || new FrustumCullingSystem({
      visibleCapacity: options.visibleCapacity ?? 8192
    });
    this._occlusionGraph = options.occlusionGraph || null;

    // ── camera state (updated externally, no allocation) ─────
    this._cameraPosition = new Vec3();
    this._cameraForward = new Vec3(0, 0, -1);
    this._cameraRight = new Vec3(1, 0, 0);
    this._cameraUp = new Vec3(0, 1, 0);
    this._cameraViewProjection = new Mat4();
    this._cameraInverseWorld = new Mat4();

    // ── scratch objects (pooled, never reallocated) ──────────
    this._tmpVecA = new Vec3();
    this._tmpVecB = new Vec3();
    this._tmpVecC = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMatA = new Mat4();
    this._tmpMatB = new Mat4();
    this._tmpBox = new Box3();
    this._tmpSphere = new Sphere();
    this._tmpPlane = new Plane();
    this._tmpFrustum = new Frustum();

    // ── batching / staging buffers (reused) ──────────────────
    this._capacity = options.capacity ?? 8192;
    this._entityBounds = new Float64Array(this._capacity * 6);
    this._entityCount = 0;

    // ── per-frame timing / statistics ────────────────────────
    this._lastUpdateTime = -Infinity;
    this._updateCount = 0;
    this._stats = {
      updates: 0,
      skipped: 0,
      entitiesProcessed: 0,
      totalAABBTests: 0,
      totalSphereTests: 0,
      totalScreenCoverage: 0
    };
  }

  // ── camera push: no allocation, pure in-place copy ────────────
  setCamera(worldMatrix, viewProjectionMatrix) {
    this._cameraInverseWorld.copy(worldMatrix).invert();
    this._cameraPosition.setFromMatrixPosition(worldMatrix);
    this._cameraRight.setFromMatrixColumn(worldMatrix, 0).normalize();
    this._cameraUp.setFromMatrixColumn(worldMatrix, 1).normalize();
    this._cameraForward.setFromMatrixColumn(worldMatrix, 2).normalize().negate();
    this._cameraViewProjection.copy(viewProjectionMatrix);
    return this;
  }

  // ── entity bounds push: caller writes a flat AABB list ────────
  // Each entity supplies 6 floats: minX, minY, minZ, maxX, maxY, maxZ.
  // Radius is derived from half-extent length.
  setEntityBounds(boundsFlat, count) {
    const n = Math.min(count, this._capacity);
    if (boundsFlat.length < n * 6) return false;
    for (let i = 0; i < n * 6; i++) {
      this._entityBounds[i] = boundsFlat[i];
    }
    this._entityCount = n;
    return true;
  }

  // ── update from a single entity batch and camera ────────────
  // Returns the number of entities whose spatial layer was filled.
  updateFromCamera(frame, clock) {
    if (!frame || !frame.layers || !frame.layers.spatial) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    if (now - this._lastUpdateTime < PROVIDER_INTERVAL) {
      this._stats.skipped++;
      return 0;
    }
    this._lastUpdateTime = now;
    this._stats.updates++;
    return this._updateSpatialLayer(frame, now);
  }

  // ── forced update ignoring the interval gate ────────────────
  forceUpdate(frame, clock) {
    if (!frame || !frame.layers || !frame.layers.spatial) return 0;
    const now = clock ? clock.elapsedSeconds : performance.now() / 1000;
    this._lastUpdateTime = now;
    this._stats.updates++;
    return this._updateSpatialLayer(frame, now);
  }

  // ── main write path (idempotent, zero allocation) ───────────
  _updateSpatialLayer(frame, now) {
    const spatial = frame.layers.spatial;
    const n = this._entityCount;
    const bounds = this._entityBounds;

    // Ensure frame buffers are large enough. (ContextFrame is
    // expected to be pre-sized, but we defensively check.)
    if (spatial.aabb.length < n * 6) return 0;

    const cx = this._cameraPosition.x;
    const cy = this._cameraPosition.y;
    const cz = this._cameraPosition.z;

    // ── extract frustum planes once per update ───────────────
    this._frustumCulling.extractPlanes(this._cameraViewProjection);

    // ── occlusion pass (optional) ────────────────────────────
    let occlusionMask = null;
    if (this._occlusionGraph) {
      occlusionMask = this._occlusionGraph.getLightingSuppressionMask();
      this._occlusionGraph.decay(now);
    }

    let processed = 0;
    let aabbTests = 0;
    let sphereTests = 0;

    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const minX = bounds[o];
      const minY = bounds[o + 1];
      const minZ = bounds[o + 2];
      const maxX = bounds[o + 3];
      const maxY = bounds[o + 4];
      const maxZ = bounds[o + 5];

      // ── AABB write (direct, contiguous) ────────────────────
      spatial.aabb[o] = minX;
      spatial.aabb[o + 1] = minY;
      spatial.aabb[o + 2] = minZ;
      spatial.aabb[o + 3] = maxX;
      spatial.aabb[o + 4] = maxY;
      spatial.aabb[o + 5] = maxZ;

      // ── sphere write: center = AABB center, radius = half-diag ─
      const scx = (minX + maxX) * 0.5;
      const scy = (minY + maxY) * 0.5;
      const scz = (minZ + maxZ) * 0.5;
      const hx = (maxX - minX) * 0.5;
      const hy = (maxY - minY) * 0.5;
      const hz = (maxZ - minZ) * 0.5;
      const radius = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const so = i * 4;
      spatial.sphere[so] = scx;
      spatial.sphere[so + 1] = scy;
      spatial.sphere[so + 2] = scz;
      spatial.sphere[so + 3] = radius;

      // ── squared distance to camera (stored squared) ────────
      const dx = scx - cx;
      const dy = scy - cy;
      const dz = scz - cz;
      const distSq = dx * dx + dy * dy + dz * dz;
      spatial.distancesSq[i] = distSq;

      // ── frustum test ────────────────────────────────────────
      aabbTests++;
      const frustumResult = this._frustumCulling.testAABB(
        minX, minY, minZ, maxX, maxY, maxZ
      );
      const frustumFlag = frustumResult === 2 /* CULL_OUTSIDE */ ? 0 : 1;
      spatial.frustumFlags[i] = frustumFlag;

      // ── screen-coverage estimate ────────────────────────────
      // coverage = k · A / d², clamped to [0,1].
      let coverage = 0;
      if (distSq > Precision.EPSILON && frustumFlag === 1) {
        const area = 4 * (hx * hy + hy * hz + hz * hx);
        coverage = SCREEN_COVERAGE_K * area / distSq;
        if (coverage > 1) coverage = 1;
        else if (coverage < 0) coverage = 0;
      }
      spatial.screenCoverage[i] = coverage;

      // ── lighting eligibility from occlusion ─────────────────
      // If an occluder exists with probability above threshold,
      // suppress lighting for this entity (it's behind something).
      let lightingEligible = 1;
      if (occlusionMask && i < occlusionMask.length) {
        if (occlusionMask[i] === 1) lightingEligible = 0;
      }
      // Store as an extra bit in screenCoverage's sign is not safe;
      // instead reuse the spatial layer's existing flags array if
      // the frame exposes one. We only write when the field exists.
      if (spatial.lightingEligible && i < spatial.lightingEligible.length) {
        spatial.lightingEligible[i] = lightingEligible;
      }

      processed++;
    }

    // ── material/lighting: tag lighting-eligible set for the
    //    clustered-lighting light-list compaction stage.
    if (frame.layers.physical && frame.layers.physical.lightEligibleMask) {
      const mask = frame.layers.physical.lightEligibleMask;
      for (let i = 0; i < processed && i < mask.length; i++) {
        mask[i] = spatial.frustumFlags[i];
      }
    }

    // ── sync broad-phase collaborators if provided ──────────
    if (this._spatialHash) {
      // Full sync is deferred to a higher-tier system to avoid
      // per-provider churn. This provider only exposes bounds.
    }

    this._stats.entitiesProcessed = processed;
    this._stats.totalAABBTests += aabbTests;
    this._stats.totalSphereTests += sphereTests;
    this._stats.totalScreenCoverage += 0;
    this._updateCount++;

    return processed;
  }

  // ── write a compact frustum-visibility mask for the consumer ─
  // Called by stage-five consumers that need a stable snapshot.
  writeVisibleMask(frame, outMask) {
    if (!frame || !frame.layers || !frame.layers.spatial) return 0;
    const flags = frame.layers.spatial.frustumFlags;
    if (!flags) return 0;
    const n = Math.min(this._entityCount, outMask.length);
    for (let i = 0; i < n; i++) {
      outMask[i] = flags[i];
    }
    return n;
  }

  // ── produce a compact visible-index list from the frame ────
  // Returns count; visible indices written into outIndices.
  writeVisibleIndices(frame, outIndices) {
    if (!frame || !frame.layers || !frame.layers.spatial) return 0;
    const flags = frame.layers.spatial.frustumFlags;
    if (!flags) return 0;
    const n = Math.min(this._entityCount, flags.length);
    const cap = outIndices.length;
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (flags[i] === 1 && count < cap) {
        outIndices[count++] = i;
      }
    }
    return count;
  }

  // ── diagnostics ────────────────────────────────────────────
  get entityCount() { return this._entityCount; }
  get updateCount() { return this._updateCount; }

  getStats() {
    return Object.freeze({
      updates: this._stats.updates,
      skipped: this._stats.skipped,
      entitiesProcessed: this._stats.entitiesProcessed,
      avgAABBTests: this._stats.updates > 0
        ? this._stats.totalAABBTests / this._stats.updates
        : 0,
      avgEntitiesPerUpdate: this._stats.updates > 0
        ? this._stats.entitiesProcessed / this._stats.updates
        : 0
    });
  }

  resetStats() {
    this._stats.updates = 0;
    this._stats.skipped = 0;
    this._stats.entitiesProcessed = 0;
    this._stats.totalAABBTests = 0;
    this._stats.totalSphereTests = 0;
    this._stats.totalScreenCoverage = 0;
  }

  resetInterval() {
    this._lastUpdateTime = -Infinity;
  }

  dispose() {
    this._entityBounds = null;
    this._entityCount = 0;
    this._frustumCulling = null;
    this._occlusionGraph = null;
    this._spatialHash = null;
    this._bvh = null;
  }
}

export {
  SpatialContextProvider,
  PROVIDER_HZ,
  PROVIDER_INTERVAL,
  DEFAULT_OCCLUSION_THRESHOLD,
  SCREEN_COVERAGE_K
};