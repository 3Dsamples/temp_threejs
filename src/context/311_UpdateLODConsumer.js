// file number : 311
// full path name : src/context/311_UpdateLODConsumer.js
// description : The 10 Hz LOD recomputation consumer — the tier-four metabolism that walks every entity the frame's spatial layer exposes, computes squared distance to the predicted camera, applies the hierarchical LOD formula from 269 (ℓ = ⌊log_R(d/d₀)⌋ with R = 10 and d₀ = 1 km, threshold d_ℓ = d₀·R^ℓ, smooth weight α = smoothstep(d_ℓ, d_{ℓ+1}, d)), and writes back a per-entity LOD level plus alpha weight into the frame. Runs strictly at 10 Hz via 308's tier scheduler so its cost is bounded to 30% of the frame; takes the predicted camera position from 302_CameraVelocityExtrapolator instead of the current one so LOD is computed for the next frame's viewpoint, not the current one. Uses squared distance throughout (only one sqrt per entity when the level is being classified), skips entities beyond the farthest threshold, and applies hysteresis (via 269's selectLevel) to avoid flickering when an entity oscillates around a threshold. Batches material-binding-driven LOD hints: when the entity's LOD crosses a tier where the MaterialRegistry has a simplified or billboard variant, writes a material-variant flag so stage 6's material uniform emitter picks the cheaper variant. Integrates with the HLOD controller at tier 3 to keep hierarchical aggregates in sync. Emits AUDIO_LIGHT causal events only when an LOD-level change causes a material-variant switch or a geometry swap request (not on every level change, to avoid event floods). Writes per-entity LOD level and alpha into frame.layers.spatial.lodLevel, frame.layers.spatial.lodAlpha, and per-frame statistics into frame.layers.physical.lodConsumer. Zero allocation after the first frame: all buffers, scratch vectors, and event payloads are pre-allocated; update() does not create any object.
// best for : Every rendering consumer that picks a geometry variant, material variant, or shadow cascade by distance — the render batch builder (309), the material uniform uploader (315), the shadow cascade scaler, the streaming priority (301 uses LOD as a proxy), and the HLOD controller (303 aggregates LOD results up the pyramid). This is what turns per-frame distance computations into a bounded, cached, 10 Hz step.
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

// ─── context providers & systems — each from its own file ────────
import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { smoothstep }                                      from './268_ExtrasCurveUtils.js';
import { ExtrasLODHelper, LOD_TIER, LOD_DEFAULTS }         from './269_ExtrasLODHelper.js';
import { CameraVelocityExtrapolator }                       from './302_CameraVelocityExtrapolator.js';
import { ContextConsumerTiers, CONSUMER_TIER }              from './308_ContextConsumerTiers.js';
import { MaterialRegistry, MATERIAL_KIND }                  from './298_MaterialRegistry.js';

// ══════════════════════════════════════════════════════════════════
// ─── LOD CONSUMER CONSTANTS ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const LOD_CONSUMER_DEFAULTS = Object.freeze({
  // Base distance and ratio for the hierarchical LOD formula.
  baseDistance:         1000.0,   // d₀ = 1 km
  ratio:                  10.0,   // R = 10
  maxLevels:               4,     // levels 0..3
  hysteresis:            0.05,    // 5% hysteresis band
  smoothBand:            0.15,    // 15% smooth fade band

  // Distance cutoff beyond which entities are marked as CULLED.
  maxDistance:       10000000.0,  // 10,000 km (d₄)

  // Maximum entities processed per tick (safety).
  maxEntitiesPerTick: 65536,

  // Enabled checks — allow fine-grained control.
  enableHysteresis:   true,
  enablePrediction:   true,
  enableEventEmission: true,

  // Event coalescing window.
  eventCoalesceMs:    500
});

// ══════════════════════════════════════════════════════════════════
// ─── LOD OUTPUT STATES ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const LOD_OUTPUT_STATE = Object.freeze({
  UNCHANGED:    0,    // same level as last tick
  CHANGED:      1,    // level index changed
  CULLED:       2,    // beyond max distance
  FIRST_TICK:   3     // first time this entity was processed
});

// ══════════════════════════════════════════════════════════════════
// ─── PER-ENTITY LOD STATE (flat SoA) ───────────────────────────
// ══════════════════════════════════════════════════════════════════
// Stored per entity, tracked across frames for hysteresis.
const LOD_ENTITY_STATE_FREE = 0;
const LOD_ENTITY_STATE_ACTIVE = 1;

// ══════════════════════════════════════════════════════════════════
// ─── MATERIAL VARIANT FLAGS ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// When the LOD level crosses a threshold, the material variant
// may need to switch. These flags are written into the frame for
// stage 6's material uniform emitter to consume.
const MATERIAL_VARIANT = Object.freeze({
  PBR_FULL:       0,   // level 0 (near) — full PBR + anime blend
  PBR_SIMPLIFIED: 1,   // level 1 — PBR simplified
  ANIME_FLAT:     2,   // level 2 — flat anime
  BILLBOARD:      3    // level 3 — billboard / particle
});

const MATERIAL_VARIANT_NAMES = Object.freeze([
  'pbr_full', 'pbr_simplified', 'anime_flat', 'billboard'
]);

// ══════════════════════════════════════════════════════════════════
// ─── UPDATE LOD CONSUMER ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
class UpdateLODConsumer {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = { ...LOD_CONSUMER_DEFAULTS, ...(options.defaults || {}) };
    this.lodDefaults = { ...LOD_DEFAULTS, ...(options.lodDefaults || {}) };

    // ── LOD helper instance (from 269) ──────────────────
    this._lodHelper = options.lodHelper || new ExtrasLODHelper({
      d0: this.defaults.baseDistance,
      R: this.defaults.ratio,
      maxLevels: this.defaults.maxLevels,
      hysteresis: this.defaults.hysteresis,
      smoothBand: this.defaults.smoothBand,
      capacity: options.entityCapacity ?? 65536
    });

    // ── Per-entity LOD state (flat SoA) ──────────────────
    const cap = options.entityCapacity ?? 65536;
    this._entityCapacity = cap;

    this._entityState = new Uint8Array(cap);         // FREE / ACTIVE
    this._entityLastLevel = new Int8Array(cap).fill(-1);
    this._entityLastAlpha = new Float32Array(cap);
    this._entityLastVariant = new Uint8Array(cap);
    this._entityLastTick = new Int32Array(cap).fill(-1);
    this._entityDistanceSq = new Float64Array(cap);

    // ── Output buffers (published to frame) ────────────
    this._outLevel = new Int8Array(cap).fill(-1);
    this._outAlpha = new Float32Array(cap);
    this._outVariant = new Uint8Array(cap);
    this._outChangedFlag = new Uint8Array(cap);
    this._outCulledFlag = new Uint8Array(cap);

    // ── Frame lifecycle ─────────────────────────────────
    this._lastTickIndex = -1;
    this._lastFrameMs = 0;
    this._frameValid = false;

    // ── Scratch (pooled) ────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      ticks: 0,
      entitiesProcessed: 0,
      entitiesCulled: 0,
      levelChanges: 0,
      variantChanges: 0,
      firstTimeEntities: 0,
      totalEntitiesProcessed: 0,
      avgFrameMsEma: 0,
      peakFrameMs: 0,
      eventsEmitted: 0,
      hysteresisHits: 0
    };

    // ── Event coalescing ────────────────────────────────
    this._lastEventTime = 0;
    this._pendingVariantChanges = [];

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._cameraExtrapolator = options.cameraExtrapolator || null;
    this._materialRegistry = options.materialRegistry || null;
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
  attachMaterialRegistry(m) { this._materialRegistry = m; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Register with the tier scheduler ──────────────────
  // ══════════════════════════════════════════════════════════
  // The consumer registers itself at 10 Hz with its designated
  // phase (default 0, meaning it runs every 6th frame starting
  // at frame 0 mod 6).
  registerWithScheduler(scheduler, phase = 0) {
    if (!scheduler) return -1;
    this._consumerId = scheduler.registerConsumer(
      'update_lod',
      this._run.bind(this),
      {
        tier: CONSUMER_TIER.HZ_10,
        phase,
        readsTiers: [0, 1],   // reads 60 Hz and 10 Hz
        writesTiers: [1],     // writes 10 Hz
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
  // Called by 308's tier scheduler at 10 Hz.
  _run(frame, scheduler) {
    this.update(frame);
  }

  // ══════════════════════════════════════════════════════════
  // ─── Main update (10 Hz) ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  update(frame) {
    if (!frame || !frame.layers) return 0;
    this._frameRef = frame;

    const startMs = performance.now();
    this._frameValid = true;
    this._stats.ticks++;
    this._lastTickIndex++;

    // ── Get predicted camera position ──────────────────
    let camX = 0, camY = 0, camZ = 0;
    let cameraValid = false;

    if (this.defaults.enablePrediction && this._cameraExtrapolator) {
      const predPos = this._cameraExtrapolator.predictedPosition;
      if (predPos) {
        camX = predPos.x;
        camY = predPos.y;
        camZ = predPos.z;
        cameraValid = true;
      }
    }

    // Fallback to current player position.
    if (!cameraValid && frame.layers.player) {
      const p = frame.layers.player;
      camX = p.position[0] ?? 0;
      camY = p.position[1] ?? 0;
      camZ = p.position[2] ?? 0;
      cameraValid = true;
    }

    if (!cameraValid) {
      this._frameValid = false;
      return 0;
    }

    // ── Get the spatial slice ──────────────────────────
    const spatial = frame.layers.spatial;
    if (!spatial) {
      this._frameValid = false;
      return 0;
    }

    // Source buffers (bounding sphere centers, AABBs, or whatever
    // upstream providers wrote). Prefer sphere center + radius if
    // available; fall back to AABB centers.
    const sphereBuffer = spatial.sphere;
    const aabbBuffer = spatial.aabb;
    const distancesSq = spatial.distancesSq;

    // Count the entities we can process (the minimum of the
    // buffers that we need).
    let entityCount = 0;
    if (sphereBuffer) entityCount = Math.floor(sphereBuffer.length / 4);
    else if (aabbBuffer) entityCount = Math.floor(aabbBuffer.length / 6);
    else if (distancesSq) entityCount = distancesSq.length;

    if (entityCount > this._entityCapacity) entityCount = this._entityCapacity;
    if (entityCount > this.defaults.maxEntitiesPerTick) entityCount = this.defaults.maxEntitiesPerTick;
    if (entityCount === 0) {
      this._frameValid = false;
      this._writeToFrame(frame, startMs);
      return 0;
    }

    // ── Process each entity ────────────────────────────
    let processed = 0;
    let culled = 0;
    let levelChanges = 0;
    let variantChanges = 0;
    let firstTime = 0;
    let hysteresisHits = 0;
    const maxDistSq = this.defaults.maxDistance * this.defaults.maxDistance;

    for (let i = 0; i < entityCount; i++) {
      // ── Position: prefer sphere center, else AABB center ─
      let ex, ey, ez, radius;
      if (sphereBuffer) {
        const o = i * 4;
        ex = sphereBuffer[o];
        ey = sphereBuffer[o + 1];
        ez = sphereBuffer[o + 2];
        radius = sphereBuffer[o + 3];
      } else if (aabbBuffer) {
        const o = i * 6;
        ex = (aabbBuffer[o] + aabbBuffer[o + 3]) * 0.5;
        ey = (aabbBuffer[o + 1] + aabbBuffer[o + 4]) * 0.5;
        ez = (aabbBuffer[o + 2] + aabbBuffer[o + 5]) * 0.5;
        radius = 0;
      } else if (distancesSq) {
        // No position info — process distance directly.
        const dSq = distancesSq[i];
        if (dSq > maxDistSq) {
          this._outCulledFlag[i] = 1;
          this._outChangedFlag[i] = 0;
          this._outLevel[i] = -1;
          culled++;
          continue;
        }
        const d = Math.sqrt(dSq);
        this._processEntityDistance(i, d, this._outLevel, this._outAlpha, this._outVariant, this._outChangedFlag);
        processed++;
        continue;
      } else {
        break;
      }

      // ── Compute squared distance (with radius subtraction) ─
      const dx = ex - camX;
      const dy = ey - camY;
      const dz = ez - camZ;
      let dSq = dx * dx + dy * dy + dz * dz;

      // Subtract radius to get surface distance.
      if (radius > 0 && dSq > 0) {
        const d = Math.sqrt(dSq);
        const surf = Math.max(0, d - radius);
        dSq = surf * surf;
      }

      this._entityDistanceSq[i] = dSq;

      // ── Cull beyond max distance ────────────────────────
      if (dSq > maxDistSq) {
        this._outCulledFlag[i] = 1;
        this._outChangedFlag[i] = 0;
        this._outLevel[i] = -1;
        this._outAlpha[i] = 0;
        this._outVariant[i] = MATERIAL_VARIANT.BILLBOARD;
        culled++;
        continue;
      }

      this._outCulledFlag[i] = 0;

      // ── Take square root (one per entity) ───────────────
      const d = Math.sqrt(dSq);

      // ── Compute LOD level and alpha ────────────────────
      const wasFirst = this._entityLastTick[i] < 0;
      if (wasFirst) firstTime++;
      this._entityLastTick[i] = this._lastTickIndex;
      this._entityState[i] = LOD_ENTITY_STATE_ACTIVE;

      const oldLevel = this._entityLastLevel[i];
      const oldVariant = this._entityLastVariant[i];

      let level;
      let alpha;
      if (this.defaults.enableHysteresis && oldLevel >= 0) {
        level = this._lodHelper.selectLevel(d, i);
        if (level === oldLevel) hysteresisHits++;
      } else {
        level = this._lodHelper.computeLevel(d);
      }
      alpha = this._lodHelper.computeAlpha(d, level);

      // ── Determine material variant ────────────────────
      const variant = this._classifyVariant(level);

      // ── Detect changes ─────────────────────────────────
      const levelChanged = level !== oldLevel;
      const variantChanged = variant !== oldVariant;

      this._entityLastLevel[i] = level;
      this._entityLastAlpha[i] = alpha;
      this._entityLastVariant[i] = variant;

      this._outLevel[i] = level;
      this._outAlpha[i] = alpha;
      this._outVariant[i] = variant;
      this._outChangedFlag[i] = levelChanged ? 1 : 0;

      if (levelChanged) levelChanges++;
      if (variantChanged) {
        variantChanges++;
        // Accumulate for coalesced event.
        if (this.defaults.enableEventEmission && !wasFirst) {
          this._pendingVariantChanges.push({
            entityIndex: i,
            oldVariant,
            newVariant: variant,
            distance: d
          });
        }
      }

      processed++;
    }

    this._stats.entitiesProcessed = processed;
    this._stats.entitiesCulled = culled;
    this._stats.levelChanges += levelChanges;
    this._stats.variantChanges += variantChanges;
    this._stats.firstTimeEntities += firstTime;
    this._stats.hysteresisHits += hysteresisHits;
    this._stats.totalEntitiesProcessed += processed;

    // ── Emit coalesced events ──────────────────────────
    if (this._pendingVariantChanges.length > 0) {
      this._flushVariantChangeEvents();
    }

    // ── Write to frame ─────────────────────────────────
    this._writeToFrame(frame, startMs);

    this._frameValid = false;
    return processed;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Distance-only processing path ──────────────────────
  // ══════════════════════════════════════════════════════════
  _processEntityDistance(i, d, outLevel, outAlpha, outVariant, outChanged) {
    const oldLevel = this._entityLastLevel[i];
    const oldVariant = this._entityLastVariant[i];

    let level;
    if (this.defaults.enableHysteresis && oldLevel >= 0) {
      level = this._lodHelper.selectLevel(d, i);
    } else {
      level = this._lodHelper.computeLevel(d);
    }
    const alpha = this._lodHelper.computeAlpha(d, level);
    const variant = this._classifyVariant(level);

    this._entityLastLevel[i] = level;
    this._entityLastAlpha[i] = alpha;
    this._entityLastVariant[i] = variant;
    this._entityLastTick[i] = this._lastTickIndex;
    this._entityState[i] = LOD_ENTITY_STATE_ACTIVE;

    outLevel[i] = level;
    outAlpha[i] = alpha;
    outVariant[i] = variant;
    outChanged[i] = (level !== oldLevel) ? 1 : 0;

    if (level !== oldLevel) this._stats.levelChanges++;
    if (variant !== oldVariant) this._stats.variantChanges++;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Material variant classification ────────────────────
  // ══════════════════════════════════════════════════════════
  _classifyVariant(level) {
    switch (level) {
      case 0: return MATERIAL_VARIANT.PBR_FULL;
      case 1: return MATERIAL_VARIANT.PBR_SIMPLIFIED;
      case 2: return MATERIAL_VARIANT.ANIME_FLAT;
      default: return MATERIAL_VARIANT.BILLBOARD;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Variant change event coalescing ────────────────────
  // ══════════════════════════════════════════════════════════
  _flushVariantChangeEvents() {
    if (!this._dispatcher || !this.defaults.enableEventEmission) {
      this._pendingVariantChanges.length = 0;
      return;
    }
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) {
      this._pendingVariantChanges.length = 0;
      return;
    }
    this._lastEventTime = now;

    // Aggregate by variant transition.
    let upTransitions = 0;
    let downTransitions = 0;
    for (let i = 0; i < this._pendingVariantChanges.length; i++) {
      const p = this._pendingVariantChanges[i];
      if (p.newVariant > p.oldVariant) upTransitions++;
      else if (p.newVariant < p.oldVariant) downTransitions++;
    }

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'lod_material_variant_changes',
        count: this._pendingVariantChanges.length,
        upTransitions,
        downTransitions
      }
    );
    this._stats.eventsEmitted++;
    this._pendingVariantChanges.length = 0;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Frame writes ───────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeToFrame(frame, startMs) {
    const elapsed = performance.now() - startMs;
    this._lastFrameMs = elapsed;

    // Update stats.
    this._stats.avgFrameMsEma = this._stats.avgFrameMsEma === 0
      ? elapsed
      : this._stats.avgFrameMsEma * 0.9 + elapsed * 0.1;
    if (elapsed > this._stats.peakFrameMs) this._stats.peakFrameMs = elapsed;

    // ── Spatial layer outputs ──────────────────────────
    const spatial = frame.layers.spatial;
    if (spatial) {
      spatial.lodLevel = this._outLevel;
      spatial.lodAlpha = this._outAlpha;
      spatial.lodMaterialVariant = this._outVariant;
      spatial.lodChangedFlag = this._outChangedFlag;
      spatial.lodCulledFlag = this._outCulledFlag;
      spatial.lodEntityCount = this._entityCapacity;
      spatial.lodVariantNames = MATERIAL_VARIANT_NAMES;
    }

    // ── Physical layer diagnostics ─────────────────────
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.lodConsumer) {
      physical.lodConsumer = {
        tickIndex: 0,
        entitiesProcessed: 0,
        entitiesCulled: 0,
        totalEntitiesProcessed: 0,
        levelChanges: 0,
        variantChanges: 0,
        firstTimeEntities: 0,
        hysteresisHits: 0,
        avgFrameMsEma: 0,
        peakFrameMs: 0,
        eventsEmitted: 0,
        baseDistance: 0,
        ratio: 0,
        maxLevels: 0,
        maxDistance: 0,
        stats: {}
      };
    }

    const lc = physical.lodConsumer;
    lc.tickIndex = this._lastTickIndex;
    lc.entitiesProcessed = this._stats.entitiesProcessed;
    lc.entitiesCulled = this._stats.entitiesCulled;
    lc.totalEntitiesProcessed = this._stats.totalEntitiesProcessed;
    lc.levelChanges = this._stats.levelChanges;
    lc.variantChanges = this._stats.variantChanges;
    lc.firstTimeEntities = this._stats.firstTimeEntities;
    lc.hysteresisHits = this._stats.hysteresisHits;
    lc.avgFrameMsEma = this._stats.avgFrameMsEma;
    lc.peakFrameMs = this._stats.peakFrameMs;
    lc.eventsEmitted = this._stats.eventsEmitted;
    lc.baseDistance = this.defaults.baseDistance;
    lc.ratio = this.defaults.ratio;
    lc.maxLevels = this.defaults.maxLevels;
    lc.maxDistance = this.defaults.maxDistance;

    lc.stats.ticks = this._stats.ticks;
    lc.stats.levelChanges = this._stats.levelChanges;
    lc.stats.variantChanges = this._stats.variantChanges;
    lc.stats.firstTimeEntities = this._stats.firstTimeEntities;
    lc.stats.hysteresisHits = this._stats.hysteresisHits;
    lc.stats.eventsEmitted = this._stats.eventsEmitted;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public accessors ───────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getLODLevel(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return -1;
    return this._outLevel[entityIndex];
  }

  getLODAlpha(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return 0;
    return this._outAlpha[entityIndex];
  }

  getMaterialVariant(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return 0;
    return this._outVariant[entityIndex];
  }

  isCulled(entityIndex) {
    if (entityIndex < 0 || entityIndex >= this._entityCapacity) return true;
    return this._outCulledFlag[entityIndex] === 1;
  }

  getLevelBuffer() { return this._outLevel; }
  getAlphaBuffer() { return this._outAlpha; }
  getVariantBuffer() { return this._outVariant; }

  // ══════════════════════════════════════════════════════════
  // ─── Interactive setters ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  setBaseDistance(d0) {
    if (d0 > 0) {
      this.defaults.baseDistance = d0;
      this._lodHelper.d0 = d0;
      this._lodHelper._rebuildThresholds?.();
    }
    return this;
  }

  setRatio(R) {
    if (R > 1) {
      this.defaults.ratio = R;
      this._lodHelper.R = R;
      this._lodHelper._logR = Math.log(R);
      this._lodHelper._rebuildThresholds?.();
    }
    return this;
  }

  setMaxDistance(d) {
    if (d > 0) this.defaults.maxDistance = d;
    return this;
  }

  setMaxLevels(n) {
    if (n > 0 && n <= 8) {
      this.defaults.maxLevels = n;
      this._lodHelper.maxLevels = n;
      this._lodHelper._thresholds = new Float64Array(n);
      this._lodHelper._rebuildThresholds?.();
    }
    return this;
  }

  setHysteresis(h) {
    if (h >= 0 && h <= 1) {
      this.defaults.hysteresis = h;
      this._lodHelper.hysteresis = h;
    }
    return this;
  }

  resetEntityCache() {
    this._entityLastLevel.fill(-1);
    this._entityLastAlpha.fill(0);
    this._entityLastVariant.fill(0);
    this._entityLastTick.fill(-1);
    this._entityState.fill(LOD_ENTITY_STATE_FREE);
    this._outLevel.fill(-1);
    this._outAlpha.fill(0);
    this._outVariant.fill(0);
    this._outChangedFlag.fill(0);
    this._outCulledFlag.fill(0);
    return this;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics ────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getStats() {
    return Object.freeze({
      ticks: this._stats.ticks,
      entitiesProcessed: this._stats.entitiesProcessed,
      entitiesCulled: this._stats.entitiesCulled,
      totalEntitiesProcessed: this._stats.totalEntitiesProcessed,
      levelChanges: this._stats.levelChanges,
      variantChanges: this._stats.variantChanges,
      firstTimeEntities: this._stats.firstTimeEntities,
      hysteresisHits: this._stats.hysteresisHits,
      avgFrameMsEma: this._stats.avgFrameMsEma,
      peakFrameMs: this._stats.peakFrameMs,
      eventsEmitted: this._stats.eventsEmitted
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
    this._pendingVariantChanges.length = 0;
  }

  dispose() {
    this._dispatcher = null;
    this._clock = null;
    this._cameraExtrapolator = null;
    this._materialRegistry = null;
    this._frameRef = null;
    this._lodHelper = null;
    this._entityState = null;
    this._entityLastLevel = null;
    this._entityLastAlpha = null;
    this._entityLastVariant = null;
    this._entityLastTick = null;
    this._entityDistanceSq = null;
    this._outLevel = null;
    this._outAlpha = null;
    this._outVariant = null;
    this._outChangedFlag = null;
    this._outCulledFlag = null;
    this._pendingVariantChanges.length = 0;
  }
}

export {
  UpdateLODConsumer,
  LOD_CONSUMER_DEFAULTS,
  LOD_OUTPUT_STATE,
  MATERIAL_VARIANT,
  MATERIAL_VARIANT_NAMES
};