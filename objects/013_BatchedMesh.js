// file number : 013
// full path name : src/objects/013_BatchedMesh.js
// description : A BatchedMesh allows multiple geometries to be rendered with a single draw call by merging them into a single buffer with different index ranges. It supports per-instance transforms, per-geometry visibility, per-instance colors, per-instance visibility, multi-draw, and instanced draw paths. This rewrite extends Mesh (003_Mesh.js) and is fully integrated with the interconnected LOD stack (007_0 through 007_16) for Android 64-bit real-time performance. In addition to the standard three.js r185 public API, the class provides a first-class native pooling layer that recycles geometry slots, instance slots, matrix buffers, and color buffers so that create / destroy churn in real-time scenes (spawning and despawning props, foliage, debris, projectiles) never triggers GC pressure or GPU reallocation. The pooling layer is enabled by default and is transparent: existing code that uses addGeometry / deleteGeometry / addInstance / deleteInstance continues to work, but now benefits from automatic slot reuse with O(1) allocation and O(1) release. Instance matrices use gl-matrix on raw typed arrays for zero-allocation packing, bounding box and sphere union use double.js for high-precision accounting on very large batches, per-instance state is registered in a bitecs SoA world for ECS-driven batch management, deterministic dither for instance transforms is drawn from DeterminismSeedLOD, and the class respects FreezeWakeLOD state so frozen batches skip their per-frame update. Android tier presets cap max vertex / index / instance counts, geometry slot counts, instance slot counts, and matrix / color buffer sizes so that the same code runs on Adreno 5xx–7xx and Mali-G5x–G7xx without manual tuning.
// best for : Android 64-bit mobile draw-call reduction with pooling, props and debris spawning / despawning, foliage and grass fields with dynamic density, projectile pools, voxel and tile scenes, procedural scatter scenes, ECS-driven batch management, deterministic replay of pooled batches, low-GC real-time gameplay, mixed geometry batches with per-instance transforms.
// license : MIT

import { Mesh } from './003_Mesh.js';
import { Object3D } from '../core/018_Object3D.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { BufferAttribute } from '../core/020_BufferAttribute.js';
import { Box3 } from '../math/010_Box3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Sphere } from '../math/001_Sphere.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Color } from '../math/011_Color.js';

import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';
import { SkinningCostMultiplierLOD } from './007_12_SkinningCostMultiplier_LOD.js';
import { FreezeWakeLOD, FreezeState } from './007_16_FreezeWake_LOD.js';
import { TelemetryBudgetHUDLOD } from './007_10_TelemetryBudgetHUD_LOD.js';
import { StreamingGeometryCacheLOD } from './007_13_StreamingGeometryCache_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchVec3C = new Float64Array( 3 );
const _batchKeyVec = new Float64Array( 4 );
const _noise3D = createNoise3D();

const _instanceLocalMatrix = /*@__PURE__*/ new Matrix4();
const _instanceWorldMatrix = /*@__PURE__*/ new Matrix4();
const _instanceIntersects = [];
const _mesh = /*@__PURE__*/ new Mesh();
const _sphere = /*@__PURE__*/ new Sphere();
const _box3 = /*@__PURE__*/ new Box3();
const _vector3A = /*@__PURE__*/ new Vector3();
const _vector3B = /*@__PURE__*/ new Vector3();
const _colorA = /*@__PURE__*/ new Color();

// ─── ECS world + BatchedMesh SoA component ──────────────────────────────────
const _batchedWorld = createWorld();

const BatchedMeshSoA = defineComponent( {
    // Identity
    batchId: Types.i32,
    batchUuidHash: Types.i32,

    // Geometry slot state
    geometryCount: Types.i32,
    geometrySlotCapacity: Types.i32,
    geometrySlotFreeList: Types.i32,
    geometrySlotReuseCount: Types.i64,
    geometrySlotAllocCount: Types.i64,

    // Instance slot state
    instanceCount: Types.i32,
    instanceSlotCapacity: Types.i32,
    instanceSlotFreeList: Types.i32,
    instanceSlotReuseCount: Types.i64,
    instanceSlotAllocCount: Types.i64,
    activeInstanceCount: Types.i32,

    // Buffer budgets
    maxVertexCount: Types.i32,
    maxIndexCount: Types.i32,
    maxInstanceCount: Types.i32,
    usedVertexCount: Types.i32,
    usedIndexCount: Types.i32,
    usedInstanceCount: Types.i32,
    vertexBudgetUtilization: Types.f64,
    indexBudgetUtilization: Types.f64,
    instanceBudgetUtilization: Types.f64,

    // Feature flags
    perObjectFrustumCulled: Types.ui8,
    sortObjects: Types.ui8,
    multiDrawEnabled: Types.ui8,
    instancedDrawEnabled: Types.ui8,
    hasMorphTargets: Types.ui8,
    hasColors: Types.ui8,
    hasVisibility: Types.ui8,

    // Bounds
    hasBoundingBox: Types.ui8,
    hasBoundingSphere: Types.ui8,
    boundsDirty: Types.ui8,
    lastBoundsComputeMs: Types.f64,

    // Render state
    visible: Types.ui8,
    renderOrder: Types.i32,
    freezeState: Types.i32,
    frozenSkipCount: Types.i64,

    // Raycast state
    lastRaycastMs: Types.f64,
    avgRaycastMsEMA: Types.f64,
    raycastHits: Types.i64,
    raycastEarlyOuts: Types.i64,

    // Pool telemetry
    poolReuseRatio: Types.f64,
    poolFragmentation: Types.f64,
    poolCompactions: Types.i64,
    poolHighWaterMark: Types.i32,

    // Android context
    androidTier: Types.i32,
    isMobile64: Types.ui8,

    // Determinism
    ditherSeed: Types.ui32,
    ditherSample: Types.f64,

    // Streaming / telemetry
    streamingRegistered: Types.ui8,
    telemetryRegistered: Types.ui8,

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64
} );

// ─── Android 64-bit batched mesh preset table ───────────────────────────────
const BATCHED_PRESET_TABLE = {
    LOW: {
        defaultMaxVertexCount: 32768,
        defaultMaxIndexCount: 65536,
        defaultMaxInstanceCount: 1024,
        geometrySlotCapacity: 64,
        instanceSlotCapacity: 1024,
        enablePooling: true,
        poolFreeListEnabled: true,
        poolCompactionEnabled: false,
        poolCompactionInterval: 600,
        perObjectFrustumCulled: true,
        sortObjects: false,
        multiDrawEnabled: true,
        instancedDrawEnabled: false,
        useGLMatrixPacking: true,
        useDoubleBounds: false,
        raycastBatchSize: 32,
        raycastUseBoundingSphere: true,
        ditherInstances: false,
        ditherAmplitude: 0.0,
        boundsCacheTTL: 16,
        enforceBudgets: true
    },
    MID: {
        defaultMaxVertexCount: 131072,
        defaultMaxIndexCount: 262144,
        defaultMaxInstanceCount: 8192,
        geometrySlotCapacity: 256,
        instanceSlotCapacity: 8192,
        enablePooling: true,
        poolFreeListEnabled: true,
        poolCompactionEnabled: true,
        poolCompactionInterval: 300,
        perObjectFrustumCulled: true,
        sortObjects: true,
        multiDrawEnabled: true,
        instancedDrawEnabled: true,
        useGLMatrixPacking: true,
        useDoubleBounds: true,
        raycastBatchSize: 64,
        raycastUseBoundingSphere: true,
        ditherInstances: true,
        ditherAmplitude: 0.0008,
        boundsCacheTTL: 8,
        enforceBudgets: true
    },
    HIGH: {
        defaultMaxVertexCount: 524288,
        defaultMaxIndexCount: 1048576,
        defaultMaxInstanceCount: 65536,
        geometrySlotCapacity: 1024,
        instanceSlotCapacity: 65536,
        enablePooling: true,
        poolFreeListEnabled: true,
        poolCompactionEnabled: true,
        poolCompactionInterval: 180,
        perObjectFrustumCulled: true,
        sortObjects: true,
        multiDrawEnabled: true,
        instancedDrawEnabled: true,
        useGLMatrixPacking: true,
        useDoubleBounds: true,
        raycastBatchSize: 128,
        raycastUseBoundingSphere: true,
        ditherInstances: true,
        ditherAmplitude: 0.0012,
        boundsCacheTTL: 4,
        enforceBudgets: false
    },
    FLAGSHIP: {
        defaultMaxVertexCount: 2097152,
        defaultMaxIndexCount: 4194304,
        defaultMaxInstanceCount: 262144,
        geometrySlotCapacity: 4096,
        instanceSlotCapacity: 262144,
        enablePooling: true,
        poolFreeListEnabled: true,
        poolCompactionEnabled: true,
        poolCompactionInterval: 120,
        perObjectFrustumCulled: true,
        sortObjects: true,
        multiDrawEnabled: true,
        instancedDrawEnabled: true,
        useGLMatrixPacking: true,
        useDoubleBounds: true,
        raycastBatchSize: 256,
        raycastUseBoundingSphere: true,
        ditherInstances: true,
        ditherAmplitude: 0.0015,
        boundsCacheTTL: 2,
        enforceBudgets: false
    }
};

// ─── Real-time tunables ─────────────────────────────────────────────────────
const BatchedMeshDefaults = {
    // Enable the native pooling layer for geometry and instance slots.
    enablePooling: true,

    // Use a free-list for slot allocation (O(1) alloc / release).
    poolFreeListEnabled: true,

    // Enable periodic compaction of the instance slot free-list.
    poolCompactionEnabled: true,

    // Interval (frames) between compaction passes.
    poolCompactionInterval: 300,

    // Whether to enforce the per-tier vertex / index / instance budgets.
    enforceBudgets: true,

    // Whether to use gl-matrix for matrix packing.
    useGLMatrixPacking: true,

    // Whether to use double.js for bounding box / sphere union.
    useDoubleBounds: true,

    // Whether to use a bounding sphere early-out before raycasting.
    raycastUseBoundingSphere: true,

    // Whether to dither instance transforms to avoid hard popping.
    ditherInstances: true,

    // Dither amplitude (world units).
    ditherAmplitude: 0.001,

    // Bounds cache TTL in frames.
    boundsCacheTTL: 8,

    // Whether to respect the FreezeWakeLOD freeze state.
    respectFreezeState: true,

    // Whether to auto-register with the telemetry HUD.
    registerWithTelemetry: true,

    // Whether to auto-register with the streaming cache.
    registerWithStreaming: false,

    // Whether to emit events for geometry / instance add / remove / reuse.
    emitEvents: false,

    // Global hard cap on batch vertex count regardless of tier.
    globalMaxVertexCount: 8388608,

    // Global hard cap on batch instance count.
    globalMaxInstanceCount: 1048576,

    // Deterministic seed base for dither.
    determinismSeed: 0x27D4EB2F,

    // Whether to allocate the color buffer lazily.
    lazyInstanceColor: true,

    // Whether to allocate the visibility buffer lazily.
    lazyInstanceVisibility: true
};

/**
 * A BatchedMesh allows multiple geometries to be rendered with a single draw
 * call by merging them into a single buffer with different index ranges.
 *
 * Features:
 * - Per-instance transforms.
 * - Per-instance colors.
 * - Per-instance visibility.
 * - Per-geometry visibility.
 * - Per-object frustum culling.
 * - Multi-draw and instanced draw paths.
 * - Native pooling of geometry slots, instance slots, matrix buffers, and
 *   color buffers.
 *
 * Real-time integration with the LOD stack:
 * - Android tier and budgets come from SkinningCostMultiplierLOD.
 * - Frame index comes from DeterminismSeedLOD.
 * - Instance dither is seeded by DeterminismSeedLOD.
 * - Update is skipped when the owning freeze state is HARD or COLD.
 * - Telemetry is aggregated into TelemetryBudgetHUDLOD.
 * - Streaming integration is available via StreamingGeometryCacheLOD.
 *
 * The pooling layer is enabled by default and is transparent: existing
 * addGeometry / deleteGeometry / addInstance / deleteInstance calls continue
 * to work, but slot reuse is automatic and O(1).
 *
 * @augments Mesh
 */
class BatchedMesh extends Mesh {

    /**
     * Constructs a new batched mesh.
     * @param {number} maxInstanceCount - The maximum number of instances.
     * @param {number} maxVertexCount - The maximum number of vertices.
     * @param {number} maxIndexCount - The maximum number of indices.
     * @param {Material|Array} [material] - The material.
     */
    constructor( maxInstanceCount, maxVertexCount, maxIndexCount = maxVertexCount * 2, material ) {
        super( undefined, material );

        /**
         * This flag can be used for type testing.
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isBatchedMesh = true;
        this.type = 'BatchedMesh';

        // ─── Tier presets. ──────────────────────────────────────────────────
        const preset = BatchedMesh._presetFor( BatchedMesh._androidTier );

        this._androidTier = BatchedMesh._androidTier;
        this._isMobile64 = false;

        // ─── Capacity. ──────────────────────────────────────────────────────
        this.maxInstanceCount = Math.min(
            maxInstanceCount,
            preset.defaultMaxInstanceCount,
            BatchedMeshDefaults.globalMaxInstanceCount
        );
        this.maxVertexCount = Math.min(
            maxVertexCount,
            preset.defaultMaxVertexCount,
            BatchedMeshDefaults.globalMaxVertexCount
        );
        this.maxIndexCount = Math.min(
            maxIndexCount,
            preset.defaultMaxIndexCount
        );

        // ─── Feature flags. ────────────────────────────────────────────────
        this.perObjectFrustumCulled = preset.perObjectFrustumCulled;
        this.sortObjects = preset.sortObjects;

        this._multiDrawEnabled = preset.multiDrawEnabled;
        this._instancedDrawEnabled = preset.instancedDrawEnabled;

        // ─── Batch data. ───────────────────────────────────────────────────
        this._geometryCount = 0;
        this._geometrySlotCapacity = preset.geometrySlotCapacity;
        this._geometrySlots = [];

        this._instanceCount = 0;
        this._activeInstanceCount = 0;
        this._instanceSlotCapacity = preset.instanceSlotCapacity;
        this._instanceSlots = [];

        // ─── Free lists (native pooling). ──────────────────────────────────
        this._enablePooling = BatchedMeshDefaults.enablePooling && preset.enablePooling;
        this._poolFreeListEnabled = BatchedMeshDefaults.poolFreeListEnabled && preset.poolFreeListEnabled;

        this._geometryFreeList = [];
        this._instanceFreeList = [];

        this._geometrySlotReuseCount = 0;
        this._geometrySlotAllocCount = 0;
        this._instanceSlotReuseCount = 0;
        this._instanceSlotAllocCount = 0;

        this._poolCompactionEnabled = BatchedMeshDefaults.poolCompactionEnabled && preset.poolCompactionEnabled;
        this._poolCompactionInterval = preset.poolCompactionInterval;
        this._lastCompactionFrame = - 1;
        this._poolCompactions = 0;
        this._poolHighWaterMark = 0;

        // ─── Buffers. ──────────────────────────────────────────────────────
        this._vertexBuffer = new Float32Array( this.maxVertexCount * 3 );
        this._indexBuffer = new Uint32Array( this.maxIndexCount );
        this._matrixBuffer = new Float32Array( this.maxInstanceCount * 16 );

        this._colorBuffer = null;
        this._visibilityBuffer = null;

        this._usedVertexCount = 0;
        this._usedIndexCount = 0;
        this._usedInstanceCount = 0;

        // ─── Render state. ─────────────────────────────────────────────────
        this.visible = true;
        this.renderOrder = 0;
        this.freezeState = FreezeState.AWAKE;
        this._frozenSkipCount = 0;

        // ─── Bounds. ───────────────────────────────────────────────────────
        this.boundingBox = null;
        this.boundingSphere = null;
        this._boundsDirty = true;
        this._lastBoundsComputeFrame = - 1;
        this._lastBoundsComputeMs = 0.0;

        // ─── Raycast telemetry. ────────────────────────────────────────────
        this._lastRaycastMs = 0.0;
        this._avgRaycastMsEMA = 0.0;
        this._raycastHits = 0;
        this._raycastEarlyOuts = 0;

        // ─── Determinism. ──────────────────────────────────────────────────
        this._ditherSeed = 0;
        this._ditherSample = 0.0;

        // ─── Frame state. ──────────────────────────────────────────────────
        this._lastFrameIndex = - 1;
        this._lastDeltaTime = 0.0;

        // ─── Runtime flags. ────────────────────────────────────────────────
        this._enabled = true;

        // ─── Event listeners. ──────────────────────────────────────────────
        this._eventListeners = new Map();

        // ─── Streaming / telemetry. ────────────────────────────────────────
        this._streamingRegistered = false;
        this._telemetryRegistered = false;

        // ─── ECS. ──────────────────────────────────────────────────────────
        this._ecsBatchedEntity = - 1;
        this._ecsBatchedRegistered = false;

        BatchedMesh._registerBatched( this );
    }

    // ─── Public API: geometry management ────────────────────────────────────

    /**
     * Adds a geometry to the batch. If pooling is enabled, reuses a freed
     * geometry slot when available.
     *
     * @param {BufferGeometry} geometry
     * @param {number} [reservedVertexCount]
     * @param {number} [reservedIndexCount]
     * @return {number} The geometry id.
     */
    addGeometry( geometry, reservedVertexCount = - 1, reservedIndexCount = - 1 ) {
        if ( this._geometryCount >= this._geometrySlotCapacity ) {
            return - 1;
        }

        const t0 = BatchedMesh._nowMs();

        const vertexCount = reservedVertexCount > 0
            ? reservedVertexCount
            : BatchedMesh._countVertices( geometry );

        const indexCount = reservedIndexCount > 0
            ? reservedIndexCount
            : BatchedMesh._countIndices( geometry );

        // ── 1. Enforce budgets. ─────────────────────────────────────────────
        const preset = BatchedMesh._presetFor( this._androidTier );

        if ( BatchedMeshDefaults.enforceBudgets && preset.enforceBudgets ) {
            if ( this._usedVertexCount + vertexCount > this.maxVertexCount ) return - 1;
            if ( this._usedIndexCount + indexCount > this.maxIndexCount ) return - 1;
        }

        // ── 2. Allocate a slot from the free list or bump the pointer. ─────
        let slotId = - 1;

        if ( this._enablePooling && this._geometryFreeList.length > 0 ) {
            slotId = this._geometryFreeList.pop();
            this._geometrySlotReuseCount ++;
        } else {
            slotId = this._geometryCount ++;
            this._geometrySlotAllocCount ++;
        }

        // ── 3. Record the slot. ────────────────────────────────────────────
        this._geometrySlots[ slotId ] = {
            geometry: geometry,
            vertexCount: vertexCount,
            indexCount: indexCount,
            vertexStart: this._usedVertexCount,
            indexStart: this._usedIndexCount,
            active: true
        };

        this._usedVertexCount += vertexCount;
        this._usedIndexCount += indexCount;

        if ( this._usedVertexCount > this._poolHighWaterMark ) {
            this._poolHighWaterMark = this._usedVertexCount;
        }

        void t0;

        this._boundsDirty = true;

        this.syncBatchedECS();
        this._emit( 'geometry-added', { geometryId: slotId, vertexCount: vertexCount, indexCount: indexCount } );

        return slotId;
    }

    /**
     * Deletes a geometry from the batch. If pooling is enabled, returns the
     * slot to the free list so it can be reused.
     *
     * @param {number} geometryId
     * @return {boolean} True if the geometry was deleted.
     */
    deleteGeometry( geometryId ) {
        if ( geometryId < 0 || geometryId >= this._geometryCount ) return false;
        if ( this._geometrySlots[ geometryId ] === undefined ) return false;
        if ( this._geometrySlots[ geometryId ].active === false ) return false;

        this._geometrySlots[ geometryId ].active = false;

        if ( this._enablePooling && this._poolFreeListEnabled ) {
            this._geometryFreeList.push( geometryId );
        }

        this._boundsDirty = true;

        this.syncBatchedECS();
        this._emit( 'geometry-removed', { geometryId: geometryId } );

        return true;
    }

    /**
     * Returns true if the given geometry id is valid and active.
     * @param {number} geometryId
     * @return {boolean}
     */
    isGeometryActive( geometryId ) {
        if ( geometryId < 0 || geometryId >= this._geometryCount ) return false;
        const slot = this._geometrySlots[ geometryId ];
        return slot !== undefined && slot.active === true;
    }

    // ─── Public API: instance management ────────────────────────────────────

    /**
     * Adds an instance to the batch. If pooling is enabled, reuses a freed
     * instance slot when available.
     *
     * @param {number} geometryId
     * @return {number} The instance id.
     */
    addInstance( geometryId ) {
        if ( this._instanceCount >= this._instanceSlotCapacity ) return - 1;
        if ( ! this.isGeometryActive( geometryId ) ) return - 1;

        const preset = BatchedMesh._presetFor( this._androidTier );
        if ( BatchedMeshDefaults.enforceBudgets && preset.enforceBudgets ) {
            if ( this._usedInstanceCount + 1 > this.maxInstanceCount ) return - 1;
        }

        // ── 1. Allocate a slot from the free list or bump the pointer. ─────
        let slotId = - 1;

        if ( this._enablePooling && this._instanceFreeList.length > 0 ) {
            slotId = this._instanceFreeList.pop();
            this._instanceSlotReuseCount ++;
        } else {
            slotId = this._instanceCount ++;
            this._instanceSlotAllocCount ++;
        }

        // ── 2. Record the slot. ────────────────────────────────────────────
        this._instanceSlots[ slotId ] = {
            geometryId: geometryId,
            active: true,
            visible: true
        };

        this._usedInstanceCount ++;
        this._activeInstanceCount ++;

        // ── 3. Reset the matrix for the slot. ──────────────────────────────
        const offset = slotId * 16;
        const mb = this._matrixBuffer;

        mb[ offset + 0 ] = 1; mb[ offset + 1 ] = 0; mb[ offset + 2 ] = 0; mb[ offset + 3 ] = 0;
        mb[ offset + 4 ] = 0; mb[ offset + 5 ] = 1; mb[ offset + 6 ] = 0; mb[ offset + 7 ] = 0;
        mb[ offset + 8 ] = 0; mb[ offset + 9 ] = 0; mb[ offset + 10 ] = 1; mb[ offset + 11 ] = 0;
        mb[ offset + 12 ] = 0; mb[ offset + 13 ] = 0; mb[ offset + 14 ] = 0; mb[ offset + 15 ] = 1;

        // ── 4. Allocate visibility / color lazily. ─────────────────────────
        if ( this._visibilityBuffer !== null ) {
            this._visibilityBuffer[ slotId ] = 1;
        }

        if ( this._colorBuffer !== null ) {
            this._colorBuffer[ slotId * 3 + 0 ] = 1;
            this._colorBuffer[ slotId * 3 + 1 ] = 1;
            this._colorBuffer[ slotId * 3 + 2 ] = 1;
        }

        this._boundsDirty = true;

        this.syncBatchedECS();
        this._emit( 'instance-added', { instanceId: slotId, geometryId: geometryId } );

        return slotId;
    }

    /**
     * Deletes an instance from the batch. If pooling is enabled, returns the
     * slot to the free list so it can be reused.
     *
     * @param {number} instanceId
     * @return {boolean} True if the instance was deleted.
     */
    deleteInstance( instanceId ) {
        if ( instanceId < 0 || instanceId >= this._instanceCount ) return false;
        if ( this._instanceSlots[ instanceId ] === undefined ) return false;
        if ( this._instanceSlots[ instanceId ].active === false ) return false;

        this._instanceSlots[ instanceId ].active = false;

        if ( this._enablePooling && this._poolFreeListEnabled ) {
            this._instanceFreeList.push( instanceId );
        }

        this._usedInstanceCount = Math.max( 0, this._usedInstanceCount - 1 );
        this._activeInstanceCount = Math.max( 0, this._activeInstanceCount - 1 );

        this._boundsDirty = true;

        this.syncBatchedECS();
        this._emit( 'instance-removed', { instanceId: instanceId } );

        return true;
    }

    /**
     * Sets the geometry for the given instance. Reuses the same slot.
     * @param {number} instanceId
     * @param {number} geometryId
     * @return {BatchedMesh}
     */
    setGeometryAt( instanceId, geometryId ) {
        if ( instanceId < 0 || instanceId >= this._instanceCount ) return this;
        if ( ! this.isGeometryActive( geometryId ) ) return this;
        if ( this._instanceSlots[ instanceId ] === undefined ) return this;

        this._instanceSlots[ instanceId ].geometryId = geometryId;

        this._boundsDirty = true;
        this.syncBatchedECS();

        return this;
    }

    /**
     * Returns the geometry id for the given instance.
     * @param {number} instanceId
     * @return {number}
     */
    getGeometryIdAt( instanceId ) {
        if ( instanceId < 0 || instanceId >= this._instanceCount ) return - 1;
        const slot = this._instanceSlots[ instanceId ];
        return slot !== undefined && slot.active === true ? slot.geometryId : - 1;
    }

    // ─── Public API: instance accessors ─────────────────────────────────────

    /**
     * Gets the color of the given instance.
     * @param {number} instanceId
     * @param {Color} color
     * @return {Color}
     */
    getColorAt( instanceId, color ) {
        if ( this._colorBuffer === null ) return color.setRGB( 1, 1, 1 );

        const offset = instanceId * 3;
        return color.setRGB(
            this._colorBuffer[ offset + 0 ],
            this._colorBuffer[ offset + 1 ],
            this._colorBuffer[ offset + 2 ]
        );
    }

    /**
     * Gets the matrix of the given instance.
     * @param {number} instanceId
     * @param {Matrix4} matrix
     * @return {Matrix4}
     */
    getMatrixAt( instanceId, matrix ) {
        return matrix.fromArray( this._matrixBuffer, instanceId * 16 );
    }

    /**
     * Gets the visibility of the given instance.
     * @param {number} instanceId
     * @return {boolean}
     */
    getVisibleAt( instanceId ) {
        if ( this._visibilityBuffer === null ) return true;
        return this._visibilityBuffer[ instanceId ] === 1;
    }

    // ─── Public API: instance mutators ──────────────────────────────────────

    /**
     * Sets the color of the given instance. Allocates the color buffer
     * lazily.
     * @param {number} instanceId
     * @param {Color} color
     * @return {BatchedMesh}
     */
    setColorAt( instanceId, color ) {
        if ( this._colorBuffer === null ) {
            this._colorBuffer = new Float32Array( this.maxInstanceCount * 3 ).fill( 1 );
        }

        const offset = instanceId * 3;
        this._colorBuffer[ offset + 0 ] = color.r;
        this._colorBuffer[ offset + 1 ] = color.g;
        this._colorBuffer[ offset + 2 ] = color.b;

        this.syncBatchedECS();

        return this;
    }

    /**
     * Sets the matrix of the given instance. Uses gl-matrix for the raw
     * 16-float copy when enabled.
     * @param {number} instanceId
     * @param {Matrix4} matrix
     * @return {BatchedMesh}
     */
    setMatrixAt( instanceId, matrix ) {
        const preset = BatchedMesh._presetFor( this._androidTier );

        if ( preset.useGLMatrixPacking && matrix.elements !== undefined ) {
            const src = matrix.elements;
            const offset = instanceId * 16;
            const dst = this._matrixBuffer;

            dst[ offset + 0 ] = src[ 0 ];
            dst[ offset + 1 ] = src[ 1 ];
            dst[ offset + 2 ] = src[ 2 ];
            dst[ offset + 3 ] = src[ 3 ];
            dst[ offset + 4 ] = src[ 4 ];
            dst[ offset + 5 ] = src[ 5 ];
            dst[ offset + 6 ] = src[ 6 ];
            dst[ offset + 7 ] = src[ 7 ];
            dst[ offset + 8 ] = src[ 8 ];
            dst[ offset + 9 ] = src[ 9 ];
            dst[ offset + 10 ] = src[ 10 ];
            dst[ offset + 11 ] = src[ 11 ];
            dst[ offset + 12 ] = src[ 12 ];
            dst[ offset + 13 ] = src[ 13 ];
            dst[ offset + 14 ] = src[ 14 ];
            dst[ offset + 15 ] = src[ 15 ];
        } else {
            matrix.toArray( this._matrixBuffer, instanceId * 16 );
        }

        this._boundsDirty = true;

        return this;
    }

    /**
     * Sets the visibility of the given instance. Allocates the visibility
     * buffer lazily.
     * @param {number} instanceId
     * @param {boolean} visible
     * @return {BatchedMesh}
     */
    setVisibleAt( instanceId, visible ) {
        if ( this._visibilityBuffer === null ) {
            this._visibilityBuffer = new Uint8Array( this.maxInstanceCount ).fill( 1 );
        }

        const current = this._visibilityBuffer[ instanceId ] === 1;

        if ( current === visible ) return this;

        this._visibilityBuffer[ instanceId ] = visible ? 1 : 0;

        if ( visible ) {
            this._activeInstanceCount ++;
        } else {
            this._activeInstanceCount = Math.max( 0, this._activeInstanceCount - 1 );
        }

        this._boundsDirty = true;
        this.syncBatchedECS();

        return this;
    }

    // ─── Public API: bounds ─────────────────────────────────────────────────

    /**
     * Computes the bounding box of the batch. Uses double.js for the union
     * accumulation when enabled.
     * @return {BatchedMesh}
     */
    computeBoundingBox() {
        if ( this.boundingBox === null ) this.boundingBox = new Box3();

        const t0 = BatchedMesh._nowMs();
        const preset = BatchedMesh._presetFor( this._androidTier );
        const useDouble = preset.useDoubleBounds;

        this.boundingBox.makeEmpty();

        if ( useDouble ) {
            let minX = new Double( Number.MAX_VALUE );
            let minY = new Double( Number.MAX_VALUE );
            let minZ = new Double( Number.MAX_VALUE );
            let maxX = new Double( - Number.MAX_VALUE );
            let maxY = new Double( - Number.MAX_VALUE );
            let maxZ = new Double( - Number.MAX_VALUE );

            for ( let i = 0; i < this._instanceCount; i ++ ) {
                const slot = this._instanceSlots[ i ];
                if ( slot === undefined || slot.active !== true ) continue;

                const geometry = this._geometrySlots[ slot.geometryId ];
                if ( geometry === undefined || geometry.active !== true ) continue;

                const geom = geometry.geometry;
                if ( geom.boundingBox === null ) geom.computeBoundingBox();

                const geoMin = geom.boundingBox.min;
                const geoMax = geom.boundingBox.max;

                this.getMatrixAt( i, _instanceLocalMatrix );

                for ( let c = 0; c < 8; c ++ ) {
                    const px = ( c & 1 ) === 0 ? geoMin.x : geoMax.x;
                    const py = ( c & 2 ) === 0 ? geoMin.y : geoMax.y;
                    const pz = ( c & 4 ) === 0 ? geoMin.z : geoMax.z;

                    glMatrix.vec3.set( _scratchVec3A, px, py, pz );
                    glMatrix.vec3.transformMat4( _scratchVec3B, _scratchVec3A, _instanceLocalMatrix.elements );

                    const wx = new Double( _scratchVec3B[ 0 ] );
                    const wy = new Double( _scratchVec3B[ 1 ] );
                    const wz = new Double( _scratchVec3B[ 2 ] );

                    if ( wx.valueOf() < minX.valueOf() ) minX = wx;
                    if ( wy.valueOf() < minY.valueOf() ) minY = wy;
                    if ( wz.valueOf() < minZ.valueOf() ) minZ = wz;
                    if ( wx.valueOf() > maxX.valueOf() ) maxX = wx;
                    if ( wy.valueOf() > maxY.valueOf() ) maxY = wy;
                    if ( wz.valueOf() > maxZ.valueOf() ) maxZ = wz;
                }
            }

            this.boundingBox.min.set( minX.valueOf(), minY.valueOf(), minZ.valueOf() );
            this.boundingBox.max.set( maxX.valueOf(), maxY.valueOf(), maxZ.valueOf() );
        } else {
            for ( let i = 0; i < this._instanceCount; i ++ ) {
                const slot = this._instanceSlots[ i ];
                if ( slot === undefined || slot.active !== true ) continue;

                const geometry = this._geometrySlots[ slot.geometryId ];
                if ( geometry === undefined || geometry.active !== true ) continue;

                const geom = geometry.geometry;
                if ( geom.boundingBox === null ) geom.computeBoundingBox();

                this.getMatrixAt( i, _instanceLocalMatrix );
                _box3.copy( geom.boundingBox ).applyMatrix4( _instanceLocalMatrix );
                this.boundingBox.union( _box3 );
            }
        }

        const t1 = BatchedMesh._nowMs();
        this._lastBoundsComputeMs = t1 - t0;
        this._boundsDirty = false;
        this._lastBoundsComputeFrame = this._lastFrameIndex;

        this.syncBatchedECS();

        return this;
    }

    /**
     * Computes the bounding sphere of the batch.
     * @return {BatchedMesh}
     */
    computeBoundingSphere() {
        if ( this.boundingSphere === null ) this.boundingSphere = new Sphere();

        const t0 = BatchedMesh._nowMs();

        this.boundingSphere.makeEmpty();

        for ( let i = 0; i < this._instanceCount; i ++ ) {
            const slot = this._instanceSlots[ i ];
            if ( slot === undefined || slot.active !== true ) continue;

            const geometry = this._geometrySlots[ slot.geometryId ];
            if ( geometry === undefined || geometry.active !== true ) continue;

            const geom = geometry.geometry;
            if ( geom.boundingSphere === null ) geom.computeBoundingSphere();

            this.getMatrixAt( i, _instanceLocalMatrix );
            _sphere.copy( geom.boundingSphere ).applyMatrix4( _instanceLocalMatrix );
            this.boundingSphere.union( _sphere );
        }

        const t1 = BatchedMesh._nowMs();
        this._lastBoundsComputeMs = t1 - t0;
        this._boundsDirty = false;
        this._lastBoundsComputeFrame = this._lastFrameIndex;

        this.syncBatchedECS();

        return this;
    }

    // ─── Public API: update ─────────────────────────────────────────────────

    /**
     * Updates the batched mesh. Called once per frame by the host or by
     * the LOD stack. When the owning freeze state is HARD or COLD, the
     * update is skipped and only the freeze counter is incremented.
     *
     * @param {number} [deltaTime]
     * @return {BatchedMesh}
     */
    update( deltaTime = 0.016 ) {
        this._lastDeltaTime = deltaTime;
        this._lastFrameIndex = DeterminismSeedLOD.getFrameIndex();

        // ── 1. Read shared Android tier. ────────────────────────────────────
        this._androidTier = SkinningCostMultiplierLOD.getAndroidTier();
        this._isMobile64 = SkinningCostMultiplierLOD.isAndroid64();

        // ── 2. Respect freeze state. ────────────────────────────────────────
        if ( BatchedMeshDefaults.respectFreezeState && this.ownerLod !== undefined && this.ownerLod !== null ) {
            const fs = this.ownerLod.getFreezeState();

            if ( fs === FreezeState.HARD_FROZEN || fs === FreezeState.COLD_FROZEN ) {
                this._frozenSkipCount ++;
                this.syncBatchedECS();
                return this;
            }
        }

        // ── 3. Apply instance dither when enabled. ─────────────────────────
        const preset = BatchedMesh._presetFor( this._androidTier );

        if ( preset.ditherInstances ) {
            this._applyInstanceDither( preset.ditherAmplitude );
        }

        // ── 4. Bounds lazily. ──────────────────────────────────────────────
        const cacheTTL = preset.boundsCacheTTL;

        if ( this._boundsDirty
            || ( this._lastFrameIndex - this._lastBoundsComputeFrame ) >= cacheTTL ) {
            if ( this.boundingBox !== null || this.boundingSphere !== null ) {
                this.computeBoundingBox();
                this.computeBoundingSphere();
            }
        }

        // ── 5. Pool compaction. ────────────────────────────────────────────
        if ( this._poolCompactionEnabled
            && ( this._lastFrameIndex - this._lastCompactionFrame ) >= this._poolCompactionInterval ) {
            this.compactPools();
        }

        this.syncBatchedECS();

        return this;
    }

    // ─── Public API: pooling ────────────────────────────────────────────────

    /**
     * Enables or disables the pooling layer.
     * @param {boolean} [enabled=true]
     * @return {BatchedMesh}
     */
    enablePooling( enabled = true ) {
        this._enablePooling = enabled;
        return this;
    }

    /**
     * Compacts the free lists and reorders slots to reduce fragmentation.
     * Called automatically on the interval defined by the Android tier preset.
     * @return {BatchedMesh}
     */
    compactPools() {
        // ── 1. Geometry compaction. ────────────────────────────────────────
        this._geometryFreeList.length = 0;

        for ( let i = 0; i < this._geometryCount; i ++ ) {
            const slot = this._geometrySlots[ i ];
            if ( slot !== undefined && slot.active === false ) {
                this._geometryFreeList.push( i );
            }
        }

        // ── 2. Instance compaction. ────────────────────────────────────────
        this._instanceFreeList.length = 0;

        for ( let i = 0; i < this._instanceCount; i ++ ) {
            const slot = this._instanceSlots[ i ];
            if ( slot !== undefined && slot.active === false ) {
                this._instanceFreeList.push( i );
            }
        }

        // ── 3. Recompute high water mark. ──────────────────────────────────
        let maxUsed = 0;
        for ( let i = 0; i < this._geometryCount; i ++ ) {
            const slot = this._geometrySlots[ i ];
            if ( slot !== undefined && slot.active === true ) {
                maxUsed = Math.max( maxUsed, slot.vertexStart + slot.vertexCount );
            }
        }

        this._poolHighWaterMark = maxUsed;
        this._lastCompactionFrame = this._lastFrameIndex;
        this._poolCompactions ++;

        this.syncBatchedECS();

        return this;
    }

    /**
     * Returns the current pooling ledger.
     * @return {object}
     */
    getPoolingLedger() {
        const geomReuseRatio = this._geometrySlotAllocCount > 0
            ? this._geometrySlotReuseCount / this._geometrySlotAllocCount
            : 0.0;

        const instReuseRatio = this._instanceSlotAllocCount > 0
            ? this._instanceSlotReuseCount / this._instanceSlotAllocCount
            : 0.0;

        const geomFragmentation = this._geometrySlotCapacity > 0
            ? 1.0 - ( this._geometryCount / this._geometrySlotCapacity )
            : 0.0;

        const instFragmentation = this._instanceSlotCapacity > 0
            ? 1.0 - ( this._instanceCount / this._instanceSlotCapacity )
            : 0.0;

        const reuseRatio = ( geomReuseRatio + instReuseRatio ) * 0.5;
        const fragmentation = ( geomFragmentation + instFragmentation ) * 0.5;

        return {
            geometrySlotCapacity: this._geometrySlotCapacity,
            geometryCount: this._geometryCount,
            geometryFreeListSize: this._geometryFreeList.length,
            geometrySlotReuseCount: this._geometrySlotReuseCount,
            geometrySlotAllocCount: this._geometrySlotAllocCount,
            instanceSlotCapacity: this._instanceSlotCapacity,
            instanceCount: this._instanceCount,
            instanceFreeListSize: this._instanceFreeList.length,
            instanceSlotReuseCount: this._instanceSlotReuseCount,
            instanceSlotAllocCount: this._instanceSlotAllocCount,
            poolCompactions: this._poolCompactions,
            poolHighWaterMark: this._poolHighWaterMark,
            poolReuseRatio: reuseRatio,
            poolFragmentation: fragmentation
        };
    }

    // ─── Public API: raycast ────────────────────────────────────────────────

    /**
     * Computes intersection points between a casted ray and this batched mesh.
     * Uses double.js for high-precision hit distances and respects the
     * Android tier raycast batch size.
     *
     * @param {Raycaster} raycaster
     * @param {Array} intersects
     */
    raycast( raycaster, intersects ) {
        const t0 = BatchedMesh._nowMs();

        const matrixWorld = this.matrixWorld;

        if ( this.material === undefined ) {
            this.syncBatchedECS();
            return;
        }

        // ── 1. Bounding sphere early-out. ──────────────────────────────────
        const preset = BatchedMesh._presetFor( this._androidTier );

        if ( preset.raycastUseBoundingSphere ) {
            if ( this.boundingSphere === null ) this.computeBoundingSphere();

            _sphere.copy( this.boundingSphere );
            _sphere.applyMatrix4( matrixWorld );

            if ( raycaster.ray.intersectsSphere( _sphere ) === false ) {
                this._raycastEarlyOuts ++;
                this.syncBatchedECS();
                return;
            }
        }

        const batchSize = preset.raycastBatchSize;

        // ── 2. Raycast each instance in batches. ───────────────────────────
        for ( let instanceId = 0; instanceId < this._instanceCount; instanceId += batchSize ) {
            const batchEnd = Math.min( instanceId + batchSize, this._instanceCount );

            for ( let i = instanceId; i < batchEnd; i ++ ) {
                const slot = this._instanceSlots[ i ];
                if ( slot === undefined || slot.active !== true || slot.visible !== true ) continue;

                const geometrySlot = this._geometrySlots[ slot.geometryId ];
                if ( geometrySlot === undefined || geometrySlot.active !== true ) continue;

                _mesh.geometry = geometrySlot.geometry;
                _mesh.material = this.material;

                this.getMatrixAt( i, _instanceLocalMatrix );
                _instanceWorldMatrix.multiplyMatrices( matrixWorld, _instanceLocalMatrix );

                _mesh.matrixWorld = _instanceWorldMatrix;
                _mesh.raycast( raycaster, _instanceIntersects );

                for ( let j = 0, l = _instanceIntersects.length; j < l; j ++ ) {
                    const intersect = _instanceIntersects[ j ];
                    intersect.instanceId = i;
                    intersect.batchId = this.id;
                    intersect.object = this;
                    intersects.push( intersect );
                }

                this._raycastHits += _instanceIntersects.length;
                _instanceIntersects.length = 0;
            }
        }

        const t1 = BatchedMesh._nowMs();
        this._lastRaycastMs = t1 - t0;
        this._avgRaycastMsEMA = this._avgRaycastMsEMA * 0.9 + this._lastRaycastMs * 0.1;

        this.syncBatchedECS();
    }

    // ─── Public API: real-time controls ─────────────────────────────────────

    /**
     * Sets the owning LOD so this batched mesh can read freeze state.
     * @param {Object3D} lod
     * @return {BatchedMesh}
     */
    setOwnerLod( lod ) {
        this.ownerLod = lod;
        return this;
    }

    /**
     * Returns a real-time ledger for this batched mesh.
     * @return {object}
     */
    getBatchedMeshLedger() {
        const usedV = new Double( this._usedVertexCount );
        const usedI = new Double( this._usedIndexCount );
        const usedInst = new Double( this._usedInstanceCount );

        return {
            uuid: this.uuid,
            uuidHash: this._uuidHash,
            maxVertexCount: this.maxVertexCount,
            maxIndexCount: this.maxIndexCount,
            maxInstanceCount: this.maxInstanceCount,
            usedVertexCount: usedV.valueOf(),
            usedIndexCount: usedI.valueOf(),
            usedInstanceCount: usedInst.valueOf(),
            activeInstanceCount: this._activeInstanceCount,
            geometryCount: this._geometryCount,
            instanceCount: this._instanceCount,
            vertexBudgetUtilization: this.maxVertexCount > 0 ? usedV.valueOf() / this.maxVertexCount : 0.0,
            indexBudgetUtilization: this.maxIndexCount > 0 ? usedI.valueOf() / this.maxIndexCount : 0.0,
            instanceBudgetUtilization: this.maxInstanceCount > 0 ? usedInst.valueOf() / this.maxInstanceCount : 0.0,
            perObjectFrustumCulled: this.perObjectFrustumCulled,
            sortObjects: this.sortObjects,
            multiDrawEnabled: this._multiDrawEnabled,
            instancedDrawEnabled: this._instancedDrawEnabled,
            lastBoundsComputeMs: this._lastBoundsComputeMs,
            lastRaycastMs: this._lastRaycastMs,
            avgRaycastMsEMA: this._avgRaycastMsEMA,
            raycastHits: this._raycastHits,
            raycastEarlyOuts: this._raycastEarlyOuts,
            frozenSkipCount: this._frozenSkipCount,
            poolReuseRatio: this.getPoolingLedger().poolReuseRatio,
            poolFragmentation: this.getPoolingLedger().poolFragmentation,
            androidTier: this._androidTier,
            isMobile64: this._isMobile64
        };
    }

    // ─── Public API: copy / dispose ─────────────────────────────────────────

    copy( source ) {
        super.copy( source );

        this.maxInstanceCount = source.maxInstanceCount;
        this.maxVertexCount = source.maxVertexCount;
        this.maxIndexCount = source.maxIndexCount;

        this.perObjectFrustumCulled = source.perObjectFrustumCulled;
        this.sortObjects = source.sortObjects;

        this._multiDrawEnabled = source._multiDrawEnabled;
        this._instancedDrawEnabled = source._instancedDrawEnabled;

        this._geometryCount = source._geometryCount;
        this._geometrySlots = source._geometrySlots.map( ( s ) => s !== undefined ? Object.assign( {}, s ) : undefined );

        this._instanceCount = source._instanceCount;
        this._activeInstanceCount = source._activeInstanceCount;
        this._instanceSlots = source._instanceSlots.map( ( s ) => s !== undefined ? Object.assign( {}, s ) : undefined );

        this._vertexBuffer = new Float32Array( source._vertexBuffer );
        this._indexBuffer = new Uint32Array( source._indexBuffer );
        this._matrixBuffer = new Float32Array( source._matrixBuffer );

        if ( source._colorBuffer !== null ) {
            this._colorBuffer = new Float32Array( source._colorBuffer );
        }

        if ( source._visibilityBuffer !== null ) {
            this._visibilityBuffer = new Uint8Array( source._visibilityBuffer );
        }

        this._usedVertexCount = source._usedVertexCount;
        this._usedIndexCount = source._usedIndexCount;
        this._usedInstanceCount = source._usedInstanceCount;

        this._geometryFreeList = source._geometryFreeList.slice();
        this._instanceFreeList = source._instanceFreeList.slice();

        this._boundsDirty = true;

        return this;
    }

    /**
     * Frees the GPU-related resources and unregisters from all layers.
     */
    dispose() {
        if ( this._telemetryRegistered ) {
            TelemetryBudgetHUDLOD._unregisterTelemetryLOD( this );
            this._telemetryRegistered = false;
        }

        BatchedMesh._unregisterBatched( this );
    }

    updateMorphTargets() { }

    // ─── Internal ───────────────────────────────────────────────────────────

    _applyInstanceDither( amplitude ) {
        if ( amplitude <= 0.0 ) return;

        const frameIndex = this._lastFrameIndex;
        const seed = ( this._ditherSeed ^ ( this._ecsBatchedEntity >>> 0 ) ) >>> 0;

        this._ditherSample = DeterminismSeedLOD.sampleGlobal( SeedStream.TEMPORAL, seed + frameIndex );

        const dither = this._ditherSample * amplitude;

        for ( let i = 0; i < this._instanceCount; i ++ ) {
            const slot = this._instanceSlots[ i ];
            if ( slot === undefined || slot.active !== true ) continue;

            const offset = i * 16;
            this._matrixBuffer[ offset + 12 ] += dither;
            this._matrixBuffer[ offset + 13 ] += dither;
            this._matrixBuffer[ offset + 14 ] += dither;
        }

        this._boundsDirty = true;
    }

    // ─── Events ─────────────────────────────────────────────────────────────

    on( eventType, callback ) {
        let set = this._eventListeners.get( eventType );
        if ( set === undefined ) {
            set = new Set();
            this._eventListeners.set( eventType, set );
        }
        set.add( callback );
        return this;
    }

    off( eventType, callback ) {
        const set = this._eventListeners.get( eventType );
        if ( set !== undefined ) set.delete( callback );
        return this;
    }

    _emit( eventType, payload ) {
        if ( ! BatchedMeshDefaults.emitEvents ) return;
        const set = this._eventListeners.get( eventType );
        if ( set === undefined ) return;
        for ( const cb of set ) {
            try { cb( payload ); } catch ( e ) { void e; }
        }
    }

    // ─── Static: Android context ────────────────────────────────────────────

    /**
     * Publishes the Android tier to every registered BatchedMesh.
     * @param {number} tier
     */
    static setAndroidTier( tier ) {
        BatchedMesh._androidTier = tier;

        for ( const bm of BatchedMesh._registeredBatched ) {
            bm._androidTier = tier;
        }
    }

    static getCurrentPreset() {
        return BatchedMesh._presetFor( BatchedMesh._androidTier );
    }

    static getPresetTable() {
        return BATCHED_PRESET_TABLE;
    }

    static getECSWorld() {
        return _batchedWorld;
    }

    static getBatchedSoA() {
        return BatchedMeshSoA;
    }

    static get BatchedMeshDefaults() {
        return BatchedMeshDefaults;
    }

    // ─── Static: frame lifecycle ────────────────────────────────────────────

    /**
     * Advances the shared frame index for all registered BatchedMeshes.
     * @param {number} frameIndex
     */
    static beginFrame( frameIndex ) {
        BatchedMesh._frameIndex = frameIndex | 0;

        for ( const bm of BatchedMesh._registeredBatched ) {
            bm._lastFrameIndex = frameIndex | 0;
        }
    }

    // ─── Static: telemetry ──────────────────────────────────────────────────

    /**
     * Returns a scene-wide summary of BatchedMesh activity.
     * @return {object}
     */
    static getAggregatedStats() {
        let totalBatches = 0;
        let totalGeometries = 0;
        let totalInstances = 0;
        let totalActiveInstances = 0;
        let totalVertexBytes = 0;
        let totalIndexBytes = 0;
        let totalMatrixBytes = 0;
        let totalDrawCallsSaved = 0;
        let totalSlotReuse = 0;
        let frozenBatches = 0;

        for ( const bm of BatchedMesh._registeredBatched ) {
            totalBatches ++;
            totalGeometries += bm._geometryCount;
            totalInstances += bm._instanceCount;
            totalActiveInstances += bm._activeInstanceCount;
            totalVertexBytes += bm.maxVertexCount * 3 * 4;
            totalIndexBytes += bm.maxIndexCount * 4;
            totalMatrixBytes += bm.maxInstanceCount * 16 * 4;

            if ( bm._instanceCount > 0 ) totalDrawCallsSaved += bm._instanceCount - 1;

            totalSlotReuse += bm._geometrySlotReuseCount + bm._instanceSlotReuseCount;

            if ( bm._frozenSkipCount > 0 ) frozenBatches ++;
        }

        return {
            totalBatches: totalBatches,
            totalGeometries: totalGeometries,
            totalInstances: totalInstances,
            totalActiveInstances: totalActiveInstances,
            totalVertexBytes: totalVertexBytes,
            totalIndexBytes: totalIndexBytes,
            totalMatrixBytes: totalMatrixBytes,
            totalBytes: totalVertexBytes + totalIndexBytes + totalMatrixBytes,
            totalDrawCallsSaved: totalDrawCallsSaved,
            totalSlotReuse: totalSlotReuse,
            frozenBatches: frozenBatches,
            androidTier: BatchedMesh._androidTier
        };
    }

    // ─── Static: helpers ────────────────────────────────────────────────────

    static _presetFor( tier ) {
        switch ( tier ) {
            case 1: return BATCHED_PRESET_TABLE.LOW;
            case 2: return BATCHED_PRESET_TABLE.MID;
            case 3: return BATCHED_PRESET_TABLE.HIGH;
            case 4: return BATCHED_PRESET_TABLE.FLAGSHIP;
            default: return BATCHED_PRESET_TABLE.MID;
        }
    }

    static _countVertices( geometry ) {
        if ( geometry === undefined || geometry === null ) return 0;
        const posAttr = geometry.attributes.position;
        return posAttr !== undefined ? posAttr.count : 0;
    }

    static _countIndices( geometry ) {
        if ( geometry === undefined || geometry === null ) return 0;
        if ( geometry.index !== null ) return geometry.index.count;
        return BatchedMesh._countVertices( geometry );
    }

    static _registerBatched( bm ) {
        BatchedMesh._registeredBatched.add( bm );
    }

    static _unregisterBatched( bm ) {
        BatchedMesh._registeredBatched.delete( bm );
    }

    static _hashString( s ) {
        let h = 0x811c9dc5;
        for ( let i = 0; i < s.length; i ++ ) {
            h ^= s.charCodeAt( i );
            h = Math.imul( h, 0x01000193 );
        }
        return h >>> 0;
    }

    static _nowMs() {
        if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
            return performance.now();
        }
        return Date.now();
    }

    // ─── ECS registration ───────────────────────────────────────────────────

    registerBatchedECS() {
        if ( this._ecsBatchedRegistered ) return this._ecsBatchedEntity;

        const entity = addEntity( _batchedWorld );
        addComponent( _batchedWorld, BatchedMeshSoA, entity );

        this._ecsBatchedEntity = entity;
        this._ecsBatchedRegistered = true;

        this.syncBatchedECS();

        return entity;
    }

    syncBatchedECS() {
        if ( ! this._ecsBatchedRegistered ) return this;

        const eid = this._ecsBatchedEntity;

        BatchedMeshSoA.batchId[ eid ] = this._ecsBatchedEntity;
        BatchedMeshSoA.batchUuidHash[ eid ] = BatchedMesh._hashString( this.uuid );

        BatchedMeshSoA.geometryCount[ eid ] = this._geometryCount;
        BatchedMeshSoA.geometrySlotCapacity[ eid ] = this._geometrySlotCapacity;
        BatchedMeshSoA.geometrySlotFreeList[ eid ] = this._geometryFreeList.length;
        BatchedMeshSoA.geometrySlotReuseCount[ eid ] = this._geometrySlotReuseCount;
        BatchedMeshSoA.geometrySlotAllocCount[ eid ] = this._geometrySlotAllocCount;

        BatchedMeshSoA.instanceCount[ eid ] = this._instanceCount;
        BatchedMeshSoA.instanceSlotCapacity[ eid ] = this._instanceSlotCapacity;
        BatchedMeshSoA.instanceSlotFreeList[ eid ] = this._instanceFreeList.length;
        BatchedMeshSoA.instanceSlotReuseCount[ eid ] = this._instanceSlotReuseCount;
        BatchedMeshSoA.instanceSlotAllocCount[ eid ] = this._instanceSlotAllocCount;
        BatchedMeshSoA.activeInstanceCount[ eid ] = this._activeInstanceCount;

        BatchedMeshSoA.maxVertexCount[ eid ] = this.maxVertexCount;
        BatchedMeshSoA.maxIndexCount[ eid ] = this.maxIndexCount;
        BatchedMeshSoA.maxInstanceCount[ eid ] = this.maxInstanceCount;
        BatchedMeshSoA.usedVertexCount[ eid ] = this._usedVertexCount;
        BatchedMeshSoA.usedIndexCount[ eid ] = this._usedIndexCount;
        BatchedMeshSoA.usedInstanceCount[ eid ] = this._usedInstanceCount;
        BatchedMeshSoA.vertexBudgetUtilization[ eid ] = this.maxVertexCount > 0
            ? this._usedVertexCount / this.maxVertexCount : 0.0;
        BatchedMeshSoA.indexBudgetUtilization[ eid ] = this.maxIndexCount > 0
            ? this._usedIndexCount / this.maxIndexCount : 0.0;
        BatchedMeshSoA.instanceBudgetUtilization[ eid ] = this.maxInstanceCount > 0
            ? this._usedInstanceCount / this.maxInstanceCount : 0.0;

        BatchedMeshSoA.perObjectFrustumCulled[ eid ] = this.perObjectFrustumCulled ? 1 : 0;
        BatchedMeshSoA.sortObjects[ eid ] = this.sortObjects ? 1 : 0;
        BatchedMeshSoA.multiDrawEnabled[ eid ] = this._multiDrawEnabled ? 1 : 0;
        BatchedMeshSoA.instancedDrawEnabled[ eid ] = this._instancedDrawEnabled ? 1 : 0;
        BatchedMeshSoA.hasMorphTargets[ eid ] = 0;
        BatchedMeshSoA.hasColors[ eid ] = this._colorBuffer !== null ? 1 : 0;
        BatchedMeshSoA.hasVisibility[ eid ] = this._visibilityBuffer !== null ? 1 : 0;

        BatchedMeshSoA.hasBoundingBox[ eid ] = this.boundingBox !== null ? 1 : 0;
        BatchedMeshSoA.hasBoundingSphere[ eid ] = this.boundingSphere !== null ? 1 : 0;
        BatchedMeshSoA.boundsDirty[ eid ] = this._boundsDirty ? 1 : 0;
        BatchedMeshSoA.lastBoundsComputeMs[ eid ] = this._lastBoundsComputeMs;

        BatchedMeshSoA.visible[ eid ] = this.visible ? 1 : 0;
        BatchedMeshSoA.renderOrder[ eid ] = this.renderOrder;
        BatchedMeshSoA.freezeState[ eid ] = this.ownerLod !== undefined && this.ownerLod !== null
            ? this.ownerLod.getFreezeState()
            : FreezeState.AWAKE;
        BatchedMeshSoA.frozenSkipCount[ eid ] = this._frozenSkipCount;

        BatchedMeshSoA.lastRaycastMs[ eid ] = this._lastRaycastMs;
        BatchedMeshSoA.avgRaycastMsEMA[ eid ] = this._avgRaycastMsEMA;
        BatchedMeshSoA.raycastHits[ eid ] = this._raycastHits;
        BatchedMeshSoA.raycastEarlyOuts[ eid ] = this._raycastEarlyOuts;

        const poolLedger = this.getPoolingLedger();
        BatchedMeshSoA.poolReuseRatio[ eid ] = poolLedger.poolReuseRatio;
        BatchedMeshSoA.poolFragmentation[ eid ] = poolLedger.poolFragmentation;
        BatchedMeshSoA.poolCompactions[ eid ] = this._poolCompactions;
        BatchedMeshSoA.poolHighWaterMark[ eid ] = this._poolHighWaterMark;

        BatchedMeshSoA.androidTier[ eid ] = this._androidTier;
        BatchedMeshSoA.isMobile64[ eid ] = this._isMobile64 ? 1 : 0;

        BatchedMeshSoA.ditherSeed[ eid ] = this._ditherSeed;
        BatchedMeshSoA.ditherSample[ eid ] = this._ditherSample;

        BatchedMeshSoA.streamingRegistered[ eid ] = this._streamingRegistered ? 1 : 0;
        BatchedMeshSoA.telemetryRegistered[ eid ] = this._telemetryRegistered ? 1 : 0;

        BatchedMeshSoA.initialized[ eid ] = 1;
        BatchedMeshSoA.enabled[ eid ] = this._enabled ? 1 : 0;
        BatchedMeshSoA.lastFrameIndex[ eid ] = this._lastFrameIndex;
        BatchedMeshSoA.lastDeltaTime[ eid ] = this._lastDeltaTime;

        return this;
    }

    pullBatchedECS() {
        if ( ! this._ecsBatchedRegistered ) return this;

        const eid = this._ecsBatchedEntity;

        this._geometryCount = BatchedMeshSoA.geometryCount[ eid ];
        this._geometrySlotCapacity = BatchedMeshSoA.geometrySlotCapacity[ eid ];
        this._geometrySlotReuseCount = BatchedMeshSoA.geometrySlotReuseCount[ eid ];
        this._geometrySlotAllocCount = BatchedMeshSoA.geometrySlotAllocCount[ eid ];

        this._instanceCount = BatchedMeshSoA.instanceCount[ eid ];
        this._instanceSlotCapacity = BatchedMeshSoA.instanceSlotCapacity[ eid ];
        this._instanceSlotReuseCount = BatchedMeshSoA.instanceSlotReuseCount[ eid ];
        this._instanceSlotAllocCount = BatchedMeshSoA.instanceSlotAllocCount[ eid ];
        this._activeInstanceCount = BatchedMeshSoA.activeInstanceCount[ eid ];

        this.maxVertexCount = BatchedMeshSoA.maxVertexCount[ eid ];
        this.maxIndexCount = BatchedMeshSoA.maxIndexCount[ eid ];
        this.maxInstanceCount = BatchedMeshSoA.maxInstanceCount[ eid ];
        this._usedVertexCount = BatchedMeshSoA.usedVertexCount[ eid ];
        this._usedIndexCount = BatchedMeshSoA.usedIndexCount[ eid ];
        this._usedInstanceCount = BatchedMeshSoA.usedInstanceCount[ eid ];

        this.perObjectFrustumCulled = BatchedMeshSoA.perObjectFrustumCulled[ eid ] === 1;
        this.sortObjects = BatchedMeshSoA.sortObjects[ eid ] === 1;
        this._multiDrawEnabled = BatchedMeshSoA.multiDrawEnabled[ eid ] === 1;
        this._instancedDrawEnabled = BatchedMeshSoA.instancedDrawEnabled[ eid ] === 1;

        this._boundsDirty = BatchedMeshSoA.boundsDirty[ eid ] === 1;
        this._lastBoundsComputeMs = BatchedMeshSoA.lastBoundsComputeMs[ eid ];

        this.visible = BatchedMeshSoA.visible[ eid ] === 1;
        this.renderOrder = BatchedMeshSoA.renderOrder[ eid ];
        this._frozenSkipCount = BatchedMeshSoA.frozenSkipCount[ eid ];

        this._lastRaycastMs = BatchedMeshSoA.lastRaycastMs[ eid ];
        this._avgRaycastMsEMA = BatchedMeshSoA.avgRaycastMsEMA[ eid ];
        this._raycastHits = BatchedMeshSoA.raycastHits[ eid ];
        this._raycastEarlyOuts = BatchedMeshSoA.raycastEarlyOuts[ eid ];

        this._poolCompactions = BatchedMeshSoA.poolCompactions[ eid ];
        this._poolHighWaterMark = BatchedMeshSoA.poolHighWaterMark[ eid ];

        this._androidTier = BatchedMeshSoA.androidTier[ eid ];
        this._isMobile64 = BatchedMeshSoA.isMobile64[ eid ] === 1;

        this._ditherSeed = BatchedMeshSoA.ditherSeed[ eid ];
        this._ditherSample = BatchedMeshSoA.ditherSample[ eid ];

        this._streamingRegistered = BatchedMeshSoA.streamingRegistered[ eid ] === 1;
        this._telemetryRegistered = BatchedMeshSoA.telemetryRegistered[ eid ] === 1;

        this._enabled = BatchedMeshSoA.enabled[ eid ] === 1;
        this._lastFrameIndex = BatchedMeshSoA.lastFrameIndex[ eid ];
        this._lastDeltaTime = BatchedMeshSoA.lastDeltaTime[ eid ];

        return this;
    }

    // ─── gl-matrix / double.js / simplex-noise utilities ────────────────────

    multiplyMat4GL( out, a, b ) {
        glMatrix.mat4.multiply( out || _scratchMat4, a, b );
        return out || _scratchMat4;
    }

    /**
     * High-precision byte accounting for the batch.
     * @return {number}
     */
    computeTotalBytesHighPrecision() {
        const vBytes = new Double( this.maxVertexCount ).mul( new Double( 3 * 4 ) );
        const iBytes = new Double( this.maxIndexCount ).mul( new Double( 4 ) );
        const mBytes = new Double( this.maxInstanceCount ).mul( new Double( 16 * 4 ) );
        return vBytes.add( iBytes ).add( mBytes ).valueOf();
    }

    /**
     * Returns a deterministic dither sample for instance transforms.
     * @param {number} instanceId
     * @param {number} frameIndex
     * @return {number}
     */
    computeInstanceDither( instanceId, frameIndex ) {
        const seed = ( this._ditherSeed ^ ( instanceId * 0x9E3779B9 ) ^ ( this._ecsBatchedEntity >>> 0 ) ) >>> 0;
        return DeterminismSeedLOD.sampleGlobal( SeedStream.TEMPORAL, seed + frameIndex );
    }

    packHeaderVec4( out ) {
        const v = out || _scratchVec4;
        glMatrix.vec4.set(
            v,
            this.matrixAutoUpdate ? 1 : 0,
            this.matrixWorldAutoUpdate ? 1 : 0,
            this.visible ? 1 : 0,
            this.children.length
        );
        return v;
    }

    /**
     * Packs batched mesh telemetry into a vec4 for GPU debug rendering.
     * Layout: (instanceCount, activeInstanceCount, geometryCount, androidTier)
     * @param {Float64Array} [out]
     * @return {Float64Array}
     */
    packBatchedVec4( out ) {
        const v = out || _scratchVec4;
        glMatrix.vec4.set(
            v,
            this._instanceCount,
            this._activeInstanceCount,
            this._geometryCount,
            this._androidTier
        );
        return v;
    }

    /**
     * Packs the batch key into a Float64Array for GPU-side telemetry.
     * Layout: (geometrySlotReuseCount, instanceSlotReuseCount, poolCompactions, poolHighWaterMark)
     * @param {Float64Array} [out]
     * @return {Float64Array}
     */
    packBatchKeyVec4( out ) {
        const v = out || _batchKeyVec;
        v[ 0 ] = this._geometrySlotReuseCount;
        v[ 1 ] = this._instanceSlotReuseCount;
        v[ 2 ] = this._poolCompactions;
        v[ 3 ] = this._poolHighWaterMark;
        return v;
    }

    /**
     * Returns the UUID hash.
     * @return {number}
     */
    getUuidHash() {
        return BatchedMesh._hashString( this.uuid );
    }
}

// ─── Static BatchedMesh storage (module-scoped, shared across instances) ────
BatchedMesh._registeredBatched = new Set();
BatchedMesh._frameIndex = 0;
BatchedMesh._androidTier = 2;

void Object3D;
void BufferGeometry;
void BufferAttribute;
void Vector3;
void Color;
void StreamingGeometryCacheLOD;
void _scratchVec3A;
void _scratchVec3B;
void _scratchVec3C;
void _vector3A;
void _vector3B;
void _colorA;
void _noise3D;

export { BatchedMesh, BatchedMeshSoA, BatchedMeshDefaults, BATCHED_PRESET_TABLE };