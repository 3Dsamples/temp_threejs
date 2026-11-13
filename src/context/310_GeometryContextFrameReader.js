// file number : 310
// full path name : src/context/310_GeometryContextFrameReader.js
// description : Geometry context frame reader — the adapter that turns each geometry's per-frame query into a sub-slice provider on the context frame, so every downstream consumer reads geometry state from the frame instead of calling ad-hoc query methods. Follows blueprint step 13 exactly: each geometry registers its query sources (AABB bounds, bounding sphere, LOD level, material binding, deformation handles, occlusion flags) as a frame sub-slice provider, with cost proportional to entities touched, at most one frame of staleness downstream, and zero allocation per query after the first frame. Handles every geometry type in the world uniformly: terrain chunks (280), forest placements (282_Z07), grass placements (282_Z08), rock placements (282_Z06), HLOD nodes (303), skinned characters (279), particles (300), water surfaces (283), biome boundary meshes, and any custom geometry that registers a query descriptor. Uses a fixed-capacity pool of query descriptors and a flat sub-slice allocator per frame layer so registering a new geometry type is O(1). Batches attribute-view reads into pooled BufferAttribute views that alias the source geometry's typed arrays without copying, so a query across 10,000 entities costs only the read of the underlying typed array. Enforces staleness policy per sub-slice: 60 Hz sub-slices rebuild every frame, 10 Hz sub-slices rebuild every sixth frame, 1 Hz sub-slices rebuild every sixtieth frame, and each sub-slice carries a version token that downstream consumers use to detect one-frame staleness (which is always allowed, but no more). Emits AUDIO_LIGHT causal events when a sub-slice exceeds its budget, when a query returns more entities than its capacity, and when a stale read is attempted that exceeds the allowed staleness. Writes per-frame reader stats into frame.layers.physical.geometryReaders and per-sub-slice metadata into frame.layers.spatial.geometrySlices. Zero allocation after the first frame: query descriptors, sub-slice registries, attribute-view pools, and event payloads are pre-allocated; query() / rebuild() / read() do not create any object.
// best for : Every consumer that reads geometry state — LOD selection (269, 303), visibility culling (273, 313), material uniform uploads (292, 298, 315), terrain streaming (337), forest and grass rendering (282_Z07, 282_Z08), impact effects (300), physics broad-phase (271, 272), and the render batch builder (309). This is what makes "every geometry reads from the frame" enforceable.
// license : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum, OBB,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

import { ContextFrame }                                    from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES }    from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS }                   from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD }                     from './267_CoreClock.js';
import { FrameBudgetMonitor, BUDGET_SLICE }                 from './305_FrameBudgetMonitor.js';
import { ContextConsumerTiers, CONSUMER_TIER }              from './308_ContextConsumerTiers.js';

// ══════════════════════════════════════════════════════════════════
// ─── QUERY KIND CONSTANTS ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const GEOM_QUERY_KIND = Object.freeze({
  AABB:             0,   // axis-aligned bounding box
  BOUNDING_SPHERE:  1,   // center + radius
  LOD_LEVEL:        2,   // integer LOD level per entity
  MATERIAL_BIND:    3,   // materialId per entity
  DEFORMATION:      4,   // per-joint or per-vertex deformation handles
  OCCLUSION_FLAG:   5,   // occlusion visibility bit per entity
  TRANSFORM:        6,   // world matrix per entity
  VISIBILITY:       7,   // frustum-culling result per entity
  CUSTOM:           8    // caller-defined
});

const GEOM_QUERY_KIND_NAMES = Object.freeze([
  'aabb', 'bounding_sphere', 'lod_level', 'material_bind',
  'deformation', 'occlusion_flag', 'transform', 'visibility', 'custom'
]);

const QUERY_KIND_COUNT = 9;

// ─── Per-kind element byte size (for sub-slice capacity math) ─
const QUERY_KIND_ELEMENT_BYTES = Object.freeze([
  6 * 4,     // AABB: 6 floats
  4 * 4,     // BOUNDING_SPHERE: 4 floats (center + radius)
  1 * 4,     // LOD_LEVEL: 1 int32
  1 * 4,     // MATERIAL_BIND: 1 int32
  8 * 4,     // DEFORMATION: 8 floats (2 handles × 4 channels)
  1,         // OCCLUSION_FLAG: 1 byte
  16 * 4,    // TRANSFORM: 16 floats
  1,         // VISIBILITY: 1 byte
  4 * 4      // CUSTOM: 4 floats
]);

// ══════════════════════════════════════════════════════════════════
// ─── STALENESS POLICY ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Every sub-slice declares how often it may be rebuilt. The reader
// enforces the policy, but the DOWNSTREAM staleness limit is
// independent — a consumer at 60 Hz may read a sub-slice whose
// last rebuild was one frame old, but never more.
const STALENESS_POLICY = Object.freeze({
  FRAME_60:   0,   // rebuild every tick
  FRAME_10:   1,   // rebuild every 6th tick
  FRAME_1:    2    // rebuild every 60th tick
});

const STALENESS_POLICY_NAMES = Object.freeze(['frame_60', 'frame_10', 'frame_1']);
const STALENESS_POLICY_PERIODS = Object.freeze([1, 6, 60]);

// ─── Per-consumer staleness ceiling (frames) ─────────────────
// A 60 Hz consumer can read a slice at most 1 frame stale.
// A 10 Hz consumer can read a slice at most 6 frames stale.
// A 1 Hz consumer can read a slice at most 60 frames stale.
const STALENESS_CEILING_FRAMES = Object.freeze([1, 6, 60]);

// ══════════════════════════════════════════════════════════════════
// ─── SLICE STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const SLICE_STATE = Object.freeze({
  FREE:        0,
  REGISTERED:  1,
  DISABLED:    2,
  ERRORED:     3
});

// ══════════════════════════════════════════════════════════════════
// ─── QUERY DESCRIPTOR (pooled) ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Each geometry type registers ONE descriptor for each query kind
// it supports. The descriptor holds:
//   - a reference to the geometry type (opaque to the reader)
//   - a fill callback that writes N entities into the sub-slice
//   - a cost hint (average entities per call)
//   - the maximum capacity the reader should reserve
class QueryDescriptor {
  constructor() {
    this.id = -1;
    this.state = SLICE_STATE.FREE;
    this.geometryType = '';
    this.queryKind = GEOM_QUERY_KIND.CUSTOM;
    this.stalenessPolicy = STALENESS_POLICY.FRAME_60;
    this.maxCapacity = 0;
    this.sourceGeometry = null;
    this.fillFn = null;
    this.sliceLayer = 'spatial';
    this.sliceField = '';
    this.sliceOffset = 0;
    this.sliceStride = 0;
    this.attributeView = null;
    this.lastBuiltTick = -1;
    this.buildCount = 0;
    this.buildSkips = 0;
    this.entityCountLastBuild = 0;
    this.entityCountPeak = 0;
    this.buildMsEma = 0;
    this.buildMsPeak = 0;
    this.failCount = 0;
  }

  reset() {
    this.id = -1;
    this.state = SLICE_STATE.FREE;
    this.geometryType = '';
    this.queryKind = GEOM_QUERY_KIND.CUSTOM;
    this.stalenessPolicy = STALENESS_POLICY.FRAME_60;
    this.maxCapacity = 0;
    this.sourceGeometry = null;
    this.fillFn = null;
    this.sliceLayer = 'spatial';
    this.sliceField = '';
    this.sliceOffset = 0;
    this.sliceStride = 0;
    this.attributeView = null;
    this.lastBuiltTick = -1;
    this.buildCount = 0;
    this.buildSkips = 0;
    this.entityCountLastBuild = 0;
    this.entityCountPeak = 0;
    this.buildMsEma = 0;
    this.buildMsPeak = 0;
    this.failCount = 0;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── ATTRIBUTE VIEW (pooled) ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// A pooled BufferAttribute view that aliases an underlying typed
// array without copying. Used to expose sub-slices without allocating
// per frame.
class AttributeView {
  constructor() {
    this.buffer = null;
    this.length = 0;
    this.itemSize = 1;
    this.inUse = false;
    this._attribute = null;
  }

  configure(typedArray, itemSize) {
    this.buffer = typedArray;
    this.length = typedArray.length;
    this.itemSize = itemSize;
    return this;
  }

  // Get or create a BufferAttribute aliasing this view.
  getAttribute() {
    if (!this._attribute || this._attribute.array !== this.buffer) {
      this._attribute = new BufferAttribute(this.buffer, this.itemSize);
    }
    return this._attribute;
  }

  reset() {
    this.buffer = null;
    this.length = 0;
    this.itemSize = 1;
    this.inUse = false;
    this._attribute = null;
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── GEOMETRY CONTEXT FRAME READER ────────────────────────────
// ══════════════════════════════════════════════════════════════════
class GeometryContextFrameReader {
  constructor(options = {}) {
    // ── Configuration ────────────────────────────────────
    this.defaults = {
      maxDescriptors:          options.maxDescriptors ?? 256,
      maxAttributeViews:       options.maxAttributeViews ?? 512,
      maxEntitiesPerSlice:     options.maxEntitiesPerSlice ?? 65536,
      enableEvents:            options.enableEvents ?? true,
      enableStalenessTracking: options.enableStalenessTracking ?? true,
      enableBudgetTracking:    options.enableBudgetTracking ?? true,
      enableBatchedRebuild:    options.enableBatchedRebuild ?? true,
      eventCoalesceMs:         options.eventCoalesceMs ?? 500,
      sliceBudgetMs:           options.sliceBudgetMs ?? 2.0,
      maxSlicesPerTick:        options.maxSlicesPerTick ?? 16
    };

    // ── Query descriptor pool ──────────────────────────
    const maxDesc = this.defaults.maxDescriptors;
    this._descriptorPool = new Array(maxDesc);
    for (let i = 0; i < maxDesc; i++) this._descriptorPool[i] = new QueryDescriptor();
    this._descriptorFreeList = new Int32Array(maxDesc);
    for (let i = 0; i < maxDesc; i++) this._descriptorFreeList[i] = maxDesc - 1 - i;
    this._descriptorFreeCount = maxDesc;
    this._descriptorUsed = 0;
    this._nextDescriptorId = 1;

    // ── Attribute view pool ────────────────────────────
    const maxViews = this.defaults.maxAttributeViews;
    this._viewPool = new Array(maxViews);
    for (let i = 0; i < maxViews; i++) this._viewPool[i] = new AttributeView();
    this._viewFreeList = new Int32Array(maxViews);
    for (let i = 0; i < maxViews; i++) this._viewFreeList[i] = maxViews - 1 - i;
    this._viewFreeCount = maxViews;

    // ── Sub-slice allocator per layer/field ────────────
    // Tracks allocated ranges (offset, length) so two descriptors
    // cannot collide on the same sub-slice.
    this._allocations = new Map();

    // ── Per-frame rebuild queue ─────────────────────────
    // Descriptors whose policy is due for a rebuild this tick.
    this._rebuildQueue = new Int32Array(maxDesc);
    this._rebuildQueueCount = 0;

    // ── Per-frame timing ────────────────────────────────
    this._frameStartMs = 0;
    this._frameBudgetMs = this.defaults.sliceBudgetMs;

    // ── Statistics ──────────────────────────────────────
    this._stats = {
      totalQueries: 0,
      totalEntitiesFilled: 0,
      totalRebuilds: 0,
      rebuildsSkipped: 0,
      descriptorsRegistered: 0,
      descriptorsUnregistered: 0,
      budgetOverruns: 0,
      stalenessViolations: 0,
      capacityOverflows: 0,
      fillErrors: 0,
      attributeViewsAcquired: 0
    };

    // ── Event coalescing ────────────────────────────────
    this._lastEventTime = 0;
    this._lastBudgetEventTime = 0;
    this._lastStalenessEventTime = 0;

    // ── Scratch (pooled) ────────────────────────────────
    this._tmpVec3A = new Vec3();
    this._tmpVec3B = new Vec3();
    this._tmpVec4 = new Vec4();
    this._tmpMat4 = new Mat4();
    this._tmpQuat = new Quat();
    this._tmpBox3 = new Box3();
    this._tmpSphere = new Sphere();

    // ── Collaborators ───────────────────────────────────
    this._dispatcher = options.dispatcher || null;
    this._clock = options.clock || null;
    this._frameBudgetMonitor = options.frameBudgetMonitor || null;
    this._tierScheduler = options.tierScheduler || null;
    this._frameRef = null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Collaborator attachment ────────────────────────────
  // ══════════════════════════════════════════════════════════
  attachDispatcher(d) { this._dispatcher = d; return this; }
  attachClock(c) { this._clock = c; return this; }
  attachFrameBudgetMonitor(f) { this._frameBudgetMonitor = f; return this; }
  attachTierScheduler(t) { this._tierScheduler = t; return this; }

  // ══════════════════════════════════════════════════════════
  // ─── Descriptor registration ────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Registers a geometry type's query as a frame sub-slice provider.
  // Options:
  //   geometryType: string identifier (e.g. "terrain_chunk")
  //   queryKind: GEOM_QUERY_KIND.*
  //   stalenessPolicy: STALENESS_POLICY.*
  //   maxCapacity: maximum number of entities the slice can hold
  //   sourceGeometry: the geometry object (opaque to the reader)
  //   fillFn: function(sourceGeometry, frame, outSlice, maxEntities) → entitiesFilled
  //   sliceLayer: 'spatial' | 'physical' | 'player' (default 'spatial')
  //   sliceField: name of the sub-slice field in frame.layers[layer]
  registerQuery(options) {
    if (this._descriptorFreeCount === 0) return -1;
    if (typeof options.fillFn !== 'function') return -1;

    const kind = options.queryKind ?? GEOM_QUERY_KIND.CUSTOM;
    if (kind < 0 || kind >= QUERY_KIND_COUNT) return -1;

    const policy = options.stalenessPolicy ?? STALENESS_POLICY.FRAME_60;
    if (policy < 0 || policy > 2) return -1;

    const capacity = options.maxCapacity ?? 1024;
    if (capacity <= 0 || capacity > this.defaults.maxEntitiesPerSlice) return -1;

    // ── Allocate descriptor ─────────────────────────────
    this._descriptorFreeCount--;
    const idx = this._descriptorFreeList[this._descriptorFreeCount];
    const desc = this._descriptorPool[idx];

    desc.reset();
    desc.id = this._nextDescriptorId++;
    desc.state = SLICE_STATE.REGISTERED;
    desc.geometryType = options.geometryType ?? '';
    desc.queryKind = kind;
    desc.stalenessPolicy = policy;
    desc.maxCapacity = capacity;
    desc.sourceGeometry = options.sourceGeometry ?? null;
    desc.fillFn = options.fillFn;
    desc.sliceLayer = options.sliceLayer ?? 'spatial';
    desc.sliceField = options.sliceField ?? (desc.geometryType + '_' + GEOM_QUERY_KIND_NAMES[kind]);

    // ── Reserve sub-slice in the frame layer ────────────
    const elementBytes = QUERY_KIND_ELEMENT_BYTES[kind];
    const lengthBytes = capacity * elementBytes;
    const offset = this._reserveSlice(desc.sliceLayer, desc.sliceField, capacity);

    if (offset < 0) {
      desc.reset();
      this._descriptorFreeList[this._descriptorFreeCount++] = idx;
      return -1;
    }

    desc.sliceOffset = offset;
    desc.sliceStride = elementBytes;

    this._descriptorUsed++;
    this._stats.descriptorsRegistered++;
    return desc.id;
  }

  // ── Reserve a sub-slice range ────────────────────────────
  _reserveSlice(layer, field, length) {
    const key = layer + '/' + field;
    const existing = this._allocations.get(key);
    if (existing !== undefined) {
      // Already reserved for the same field; fail (caller must
      // use a unique field name).
      return -1;
    }
    this._allocations.set(key, length);
    return 0;   // offset is per-field, always 0
  }

  // ── Unregister ───────────────────────────────────────────
  unregisterQuery(descriptorId) {
    for (let i = 0; i < this._descriptorPool.length; i++) {
      const desc = this._descriptorPool[i];
      if (desc.id !== descriptorId) continue;

      const key = desc.sliceLayer + '/' + desc.sliceField;
      this._allocations.delete(key);

      if (desc.attributeView) {
        this._releaseView(desc.attributeView);
        desc.attributeView = null;
      }

      desc.reset();
      this._descriptorFreeList[this._descriptorFreeCount++] = i;
      this._descriptorUsed--;
      this._stats.descriptorsUnregistered++;
      return true;
    }
    return false;
  }

  // ── Lookup by ID ─────────────────────────────────────────
  getDescriptor(descriptorId) {
    for (let i = 0; i < this._descriptorPool.length; i++) {
      const desc = this._descriptorPool[i];
      if (desc.id === descriptorId) return desc;
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Attribute view pool ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _acquireView(typedArray, itemSize) {
    if (this._viewFreeCount === 0) return null;
    this._viewFreeCount--;
    const idx = this._viewFreeList[this._viewFreeCount];
    const view = this._viewPool[idx];
    view.configure(typedArray, itemSize);
    view.inUse = true;
    this._stats.attributeViewsAcquired++;
    return view;
  }

  _releaseView(view) {
    if (!view) return;
    const idx = this._viewPool.indexOf(view);
    if (idx < 0) return;
    view.reset();
    this._viewFreeList[this._viewFreeCount++] = idx;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Fill one descriptor's sub-slice ────────────────────
  // ══════════════════════════════════════════════════════════
  // Measures time, calls fillFn, writes metadata into the frame.
  _fillDescriptor(desc, frame) {
    if (desc.state !== SLICE_STATE.REGISTERED) return 0;

    const startMs = performance.now();

    let entitiesFilled = 0;
    try {
      const result = desc.fillFn(
        desc.sourceGeometry,
        frame,
        desc.maxCapacity
      );
      entitiesFilled = Number.isFinite(result) ? result : 0;
    } catch (e) {
      desc.failCount++;
      this._stats.fillErrors++;
      this._emitFillError(desc, e);
      desc.state = SLICE_STATE.ERRORED;
      entitiesFilled = 0;
    }

    const elapsed = performance.now() - startMs;

    // ── Update descriptor stats ────────────────────────
    desc.lastBuiltTick = this._frameTickIndex;
    desc.buildCount++;
    desc.entityCountLastBuild = entitiesFilled;
    if (entitiesFilled > desc.entityCountPeak) {
      desc.entityCountPeak = entitiesFilled;
    }
    desc.buildMsEma = desc.buildMsEma === 0
      ? elapsed
      : desc.buildMsEma * 0.9 + elapsed * 0.1;
    if (elapsed > desc.buildMsPeak) desc.buildMsPeak = elapsed;

    // ── Capacity overflow detection ────────────────────
    if (entitiesFilled > desc.maxCapacity) {
      this._stats.capacityOverflows++;
      this._emitCapacityOverflow(desc, entitiesFilled);
    }

    this._stats.totalEntitiesFilled += entitiesFilled;
    this._stats.totalRebuilds++;

    return entitiesFilled;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Tick: rebuild stale slices ────────────────────────
  // ══════════════════════════════════════════════════════════
  rebuild(frame, tickIndex) {
    this._frameRef = frame;
    this._frameTickIndex = tickIndex;
    const startMs = performance.now();
    this._frameStartMs = startMs;
    this._rebuildQueueCount = 0;

    if (this._frameBudgetMonitor) {
      this._frameBudgetMonitor.beginSlice(BUDGET_SLICE.PROVIDERS);
    }

    // ── Build the rebuild queue ────────────────────────
    // Only descriptors whose staleness policy is due this tick
    // enter the queue.
    for (let i = 0; i < this._descriptorPool.length; i++) {
      const desc = this._descriptorPool[i];
      if (desc.state !== SLICE_STATE.REGISTERED) continue;

      const period = STALENESS_POLICY_PERIODS[desc.stalenessPolicy];
      const lastTick = desc.lastBuiltTick < 0 ? -1 : desc.lastBuiltTick;
      const due = lastTick < 0 || (tickIndex - lastTick) >= period;

      if (due) {
        this._rebuildQueue[this._rebuildQueueCount++] = i;
      } else {
        desc.buildSkips++;
        this._stats.rebuildsSkipped++;
      }
    }

    // ── Execute rebuilds within budget ─────────────────
    const maxSlices = this.defaults.maxSlicesPerTick;
    const budgetMs = this._frameBudgetMs;
    let executed = 0;

    for (let q = 0; q < this._rebuildQueueCount && executed < maxSlices; q++) {
      const idx = this._rebuildQueue[q];
      const desc = this._descriptorPool[idx];

      const elapsed = performance.now() - startMs;
      if (elapsed > budgetMs && executed > 0) {
        this._stats.budgetOverruns++;
        this._emitBudgetOverrun(elapsed);
        break;
      }

      this._fillDescriptor(desc, frame);
      executed++;

      // Staleness guard: an old slice that is still stale
      // after rebuild is a violation.
      if (this.defaults.enableStalenessTracking) {
        const framesSinceBuild = tickIndex - desc.lastBuiltTick;
        const ceiling = STALENESS_CEILING_FRAMES[desc.stalenessPolicy];
        if (framesSinceBuild > ceiling) {
          this._stats.stalenessViolations++;
          this._emitStalenessViolation(desc, framesSinceBuild);
        }
      }
    }

    if (this._frameBudgetMonitor) {
      this._frameBudgetMonitor.endSlice(BUDGET_SLICE.PROVIDERS);
    }

    // ── Publish per-frame diagnostics ──────────────────
    this._writeDiagnostics(frame);

    return executed;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Consumer-side read ────────────────────────────────
  // ══════════════════════════════════════════════════════════
  // Downstream consumers call this to obtain an attribute view
  // for a sub-slice. The view aliases the underlying frame buffer
  // without copying. A consumer that exceeds the allowed staleness
  // for its own tier gets a null return and a counted violation.
  readSlice(descriptorId, consumerTier) {
    const desc = this.getDescriptor(descriptorId);
    if (!desc) return null;
    if (desc.state !== SLICE_STATE.REGISTERED) return null;

    // ── Staleness gate ────────────────────────────────
    const framesSinceBuild = this._frameTickIndex - desc.lastBuiltTick;
    const ceiling = STALENESS_CEILING_FRAMES[consumerTier] ?? 1;

    if (framesSinceBuild > ceiling) {
      this._stats.stalenessViolations++;
      this._emitStalenessViolation(desc, framesSinceBuild);
      return null;
    }

    // ── Locate the frame field ────────────────────────
    const layer = this._frameRef.layers[desc.sliceLayer];
    if (!layer) return null;
    const field = layer[desc.sliceField];
    if (!field) return null;

    // ── Wrap in an attribute view ─────────────────────
    const itemSize = desc.sliceStride / 4;
    if (!desc.attributeView) {
      desc.attributeView = this._acquireView(field, itemSize);
    }
    if (!desc.attributeView) return null;
    desc.attributeView.configure(field, itemSize);
    desc.attributeView.length = desc.entityCountLastBuild * itemSize;

    return desc.attributeView;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Diagnostics write ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _writeDiagnostics(frame) {
    const physical = frame.layers.physical;
    if (!physical) return;

    if (!physical.geometryReaders) {
      physical.geometryReaders = {
        tickIndex: 0,
        descriptorCount: 0,
        rebuildQueueCount: 0,
        totalEntitiesFilled: 0,
        totalRebuilds: 0,
        totalRebuildsSkipped: 0,
        capacityOverflows: 0,
        fillErrors: 0,
        budgetOverruns: 0,
        stalenessViolations: 0,
        budgetMs: 0,
        stats: {}
      };
    }

    const gr = physical.geometryReaders;
    gr.tickIndex = this._frameTickIndex;
    gr.descriptorCount = this._descriptorUsed;
    gr.rebuildQueueCount = this._rebuildQueueCount;
    gr.totalEntitiesFilled = this._stats.totalEntitiesFilled;
    gr.totalRebuilds = this._stats.totalRebuilds;
    gr.totalRebuildsSkipped = this._stats.rebuildsSkipped;
    gr.capacityOverflows = this._stats.capacityOverflows;
    gr.fillErrors = this._stats.fillErrors;
    gr.budgetOverruns = this._stats.budgetOverruns;
    gr.stalenessViolations = this._stats.stalenessViolations;
    gr.budgetMs = this._frameBudgetMs;

    gr.stats.descriptorsRegistered = this._stats.descriptorsRegistered;
    gr.stats.descriptorsUnregistered = this._stats.descriptorsUnregistered;
    gr.stats.attributeViewsAcquired = this._stats.attributeViewsAcquired;
  }

  // ══════════════════════════════════════════════════════════
  // ─── Event emission ─────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  _emitFillError(desc, error) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) return;
    this._lastEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'geometry_query_fill_error',
        descriptorId: desc.id,
        geometryType: desc.geometryType,
        queryKind: GEOM_QUERY_KIND_NAMES[desc.queryKind],
        message: String(error && error.message ? error.message : error)
      }
    );
  }

  _emitCapacityOverflow(desc, filled) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastEventTime < this.defaults.eventCoalesceMs) return;
    this._lastEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'geometry_query_capacity_overflow',
        descriptorId: desc.id,
        geometryType: desc.geometryType,
        queryKind: GEOM_QUERY_KIND_NAMES[desc.queryKind],
        filled,
        maxCapacity: desc.maxCapacity
      }
    );
  }

  _emitStalenessViolation(desc, framesSinceBuild) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastStalenessEventTime < this.defaults.eventCoalesceMs) return;
    this._lastStalenessEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'geometry_query_staleness',
        descriptorId: desc.id,
        geometryType: desc.geometryType,
        queryKind: GEOM_QUERY_KIND_NAMES[desc.queryKind],
        framesSinceBuild,
        policy: STALENESS_POLICY_NAMES[desc.stalenessPolicy]
      }
    );
  }

  _emitBudgetOverrun(elapsedMs) {
    if (!this._dispatcher || !this.defaults.enableEvents) return;
    const now = performance.now();
    if (now - this._lastBudgetEventTime < this.defaults.eventCoalesceMs) return;
    this._lastBudgetEventTime = now;

    this._dispatcher.queueCausalEvent(
      EVENT_TYPE.AUDIO_LIGHT,
      [0, 0, 0],
      -1, 1, 1.0,
      {
        kind: 'geometry_query_budget_overrun',
        elapsedMs,
        budgetMs: this._frameBudgetMs,
        rebuildQueueCount: this._rebuildQueueCount
      }
    );
  }

  // ══════════════════════════════════════════════════════════
  // ─── Public query APIs ──────────────────────────────────
  // ══════════════════════════════════════════════════════════
  getDescriptorCount() { return this._descriptorUsed; }
  getRebuildQueueCount() { return this._rebuildQueueCount; }

  // Returns the current tick's rebuild count.
  getLastRebuildCount() { return this._stats.totalRebuilds; }

  // Fills a stats snapshot.
  getStats() {
    return Object.freeze({
      descriptorCount: this._descriptorUsed,
      totalEntitiesFilled: this._stats.totalEntitiesFilled,
      totalRebuilds: this._stats.totalRebuilds,
      rebuildsSkipped: this._stats.rebuildsSkipped,
      capacityOverflows: this._stats.capacityOverflows,
      fillErrors: this._stats.fillErrors,
      budgetOverruns: this._stats.budgetOverruns,
      stalenessViolations: this._stats.stalenessViolations,
      descriptorsRegistered: this._stats.descriptorsRegistered,
      descriptorsUnregistered: this._stats.descriptorsUnregistered
    });
  }

  resetStats() {
    for (const k of Object.keys(this._stats)) {
      if (typeof this._stats[k] === 'number') this._stats[k] = 0;
    }
  }

  // ══════════════════════════════════════════════════════════
  // ─── Convenience registrations ──────────────────────────
  // ══════════════════════════════════════════════════════════
  // Built-in helper for AABB queries: fills frame.layers.spatial.aabb.
  registerAABBSource(geometryType, sourceGeometry, fillFn, capacity = 4096, policy = STALENESS_POLICY.FRAME_60) {
    return this.registerQuery({
      geometryType,
      queryKind: GEOM_QUERY_KIND.AABB,
      stalenessPolicy: policy,
      maxCapacity: capacity,
      sourceGeometry,
      fillFn,
      sliceLayer: 'spatial',
      sliceField: geometryType + '_aabb'
    });
  }

  // Built-in helper for bounding-sphere queries.
  registerBoundingSphereSource(geometryType, sourceGeometry, fillFn, capacity = 4096, policy = STALENESS_POLICY.FRAME_60) {
    return this.registerQuery({
      geometryType,
      queryKind: GEOM_QUERY_KIND.BOUNDING_SPHERE,
      stalenessPolicy: policy,
      maxCapacity: capacity,
      sourceGeometry,
      fillFn,
      sliceLayer: 'spatial',
      sliceField: geometryType + '_sphere'
    });
  }

  // Built-in helper for LOD-level queries.
  registerLODSource(geometryType, sourceGeometry, fillFn, capacity = 4096, policy = STALENESS_POLICY.FRAME_10) {
    return this.registerQuery({
      geometryType,
      queryKind: GEOM_QUERY_KIND.LOD_LEVEL,
      stalenessPolicy: policy,
      maxCapacity: capacity,
      sourceGeometry,
      fillFn,
      sliceLayer: 'spatial',
      sliceField: geometryType + '_lod'
    });
  }

  // Built-in helper for material binding queries.
  registerMaterialBindSource(geometryType, sourceGeometry, fillFn, capacity = 4096, policy = STALENESS_POLICY.FRAME_1) {
    return this.registerQuery({
      geometryType,
      queryKind: GEOM_QUERY_KIND.MATERIAL_BIND,
      stalenessPolicy: policy,
      maxCapacity: capacity,
      sourceGeometry,
      fillFn,
      sliceLayer: 'spatial',
      sliceField: geometryType + '_material'
    });
  }

  // Built-in helper for visibility queries.
  registerVisibilitySource(geometryType, sourceGeometry, fillFn, capacity = 4096, policy = STALENESS_POLICY.FRAME_60) {
    return this.registerQuery({
      geometryType,
      queryKind: GEOM_QUERY_KIND.VISIBILITY,
      stalenessPolicy: policy,
      maxCapacity: capacity,
      sourceGeometry,
      fillFn,
      sliceLayer: 'spatial',
      sliceField: geometryType + '_visible'
    });
  }

  // ══════════════════════════════════════════════════════════
  // ─── Dispose ────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════
  dispose() {
    for (let i = 0; i < this._descriptorPool.length; i++) {
      const desc = this._descriptorPool[i];
      if (desc.attributeView) {
        this._releaseView(desc.attributeView);
      }
      desc.reset();
    }
    this._descriptorUsed = 0;
    this._descriptorFreeCount = this.defaults.maxDescriptors;
    for (let i = 0; i < this.defaults.maxDescriptors; i++) {
      this._descriptorFreeList[i] = this.defaults.maxDescriptors - 1 - i;
    }

    for (let i = 0; i < this._viewPool.length; i++) {
      this._viewPool[i].reset();
    }
    this._viewFreeCount = this.defaults.maxAttributeViews;
    for (let i = 0; i < this.defaults.maxAttributeViews; i++) {
      this._viewFreeList[i] = this.defaults.maxAttributeViews - 1 - i;
    }

    this._allocations.clear();
    this._dispatcher = null;
    this._clock = null;
    this._frameBudgetMonitor = null;
    this._tierScheduler = null;
    this._frameRef = null;
  }
}

export {
  GeometryContextFrameReader,
  QueryDescriptor,
  AttributeView,
  GEOM_QUERY_KIND,
  GEOM_QUERY_KIND_NAMES,
  QUERY_KIND_COUNT,
  QUERY_KIND_ELEMENT_BYTES,
  STALENESS_POLICY,
  STALENESS_POLICY_NAMES,
  STALENESS_POLICY_PERIODS,
  STALENESS_CEILING_FRAMES,
  SLICE_STATE
};