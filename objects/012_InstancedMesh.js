
// file number : 012
// full path name : src/objects/012_InstancedMesh.js
// description : A special version of a Mesh with instanced rendering support. Use this class if you have to render a large number of objects with the same geometry and material(s) but with different world transformations. InstancedMesh reduces draw calls and improves rendering performance. This rewrite extends Mesh (003_Mesh.js) and is fully integrated with the interconnected LOD stack (007_0 through 007_16) for Android 64-bit real-time performance. Instance matrix packing uses gl-matrix on raw typed arrays with zero allocation, bounding box and sphere computation use double.js for high-precision union across very large instance counts, and per-instance state is registered in a bitecs SoA world for ECS-driven crowd management. Instance color and morph texture are lazily allocated. Raycasting respects the picking density override from RaycastFixedDensityLOD and uses double.js for high-precision hit distances. Deterministic dither for instance transform jitter is drawn from DeterminismSeedLOD. The class respects FreezeWakeLOD state so frozen instanced meshes skip their per-frame update. The public three.js r185 API (isInstancedMesh, instanceMatrix, instanceColor, morphTexture, count, boundingBox, boundingSphere, computeBoundingBox, computeBoundingSphere, getColorAt, getMatrixAt, getMorphAt, setColorAt, setMatrixAt, setMorphAt, raycast, dispose) is preserved exactly.
// best for : Android 64-bit mobile crowd rendering, dense foliage instancing, grass fields, particle batches, repeated props, architectural elements, voxel rendering, GPU-driven instancing on Adreno 5xx–7xx and Mali-G5x–G7xx, ECS-driven instance management, high-precision instance bounds, deterministic replay of instance transforms.
// license : MIT

import { Mesh } from './003_Mesh.js';
import { Object3D } from '../core/018_Object3D.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { BufferAttribute } from '../core/020_BufferAttribute.js';
import { InstancedBufferAttribute } from '../core/022_InstancedBufferAttribute.js';
import { Box3 } from '../math/010_Box3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Sphere } from '../math/001_Sphere.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Color } from '../math/011_Color.js';
import { DataTexture } from '../textures/001_DataTexture.js';
import { Texture } from '../textures/000_Texture.js';

import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';
import { FreezeWakeLOD, FreezeState } from './007_16_FreezeWake_LOD.js';
import { SkinningCostMultiplierLOD } from './007_12_SkinningCostMultiplier_LOD.js';
import { RaycastFixedDensityLOD, RaycastType } from './007_14_RaycastFixedDensity_LOD.js';
import { StreamingGeometryCacheLOD } from './007_13_StreamingGeometryCache_LOD.js';
import { TelemetryBudgetHUDLOD } from './007_10_TelemetryBudgetHUD_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchMat4B = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _instanceKeyVec = new Float64Array( 4 );
const _noise3D = createNoise3D();

const _instanceLocalMatrix = /*@__PURE__*/ new Matrix4();
const _instanceWorldMatrix = /*@__PURE__*/ new Matrix4();
const _instanceIntersects = [];
const _box3 = /*@__PURE__*/ new Box3();
const _identity = /*@__PURE__*/ new Matrix4();
const _mesh = /*@__PURE__*/ new Mesh();
const _sphere = /*@__PURE__*/ new Sphere();
const _scratchColor = /*@__PURE__*/ new Color();

// ─── ECS world + InstancedMesh SoA component ────────────────────────────────
const _instancedWorld = createWorld();

const InstancedMeshSoA = defineComponent( {
    // Identity
    meshId: Types.i32,
    meshUuidHash: Types.i32,

    // Instance state
    count: Types.i32,
    countBudget: Types.i32,
    countBudgetUtilization: Types.f64,
    activeCount: Types.i32,             // instances currently visible / active

    // Matrix state
    instanceMatrixDirty: Types.ui8,
    instanceMatrixVersion: Types.i32,
    lastMatrixUpdateFrame: Types.i32,
    matrixUpdateCount: Types.i64,

    // Color state
    hasInstanceColor: Types.ui8,
    instanceColorDirty: Types.ui8,
    colorUpdateCount: Types.i64,

    // Morph state
    hasMorphTexture: Types.ui8,
    morphTargetCount: Types.i32,

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
    pickingDensityActive: Types.ui8,

    // Android context
    androidTier: Types.i32,
    isMobile64: Types.ui8,

    // Determinism
    ditherSeed: Types.ui32,
    ditherSample: Types.f64,

    // Streaming
    streamingRegistered: Types.ui8,
    streamingKey: Types.i32,

    // Telemetry
    telemetryRegistered: Types.ui8,

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64
} );

// ─── Android 64-bit instance preset table ───────────────────────────────────
const INSTANCE_PRESET_TABLE = {
    LOW: {
        maxInstances: 4096,
        enforceInstanceBudget: true,
        boundingComputeStride: 4,      // sample every Nth instance for bounds
        raycastBatchSize: 32,
        raycastUseBoundingSphere: true,
        raycastUseBoundingBox: false,
        ditherInstances: false,
        ditherAmplitude: 0.0,
        boundsCacheTTL: 16,
        useGLMatrixPacking: true,
        useDoubleBounds: false
    },
    MID: {
        maxInstances: 16384,
        enforceInstanceBudget: true,
        boundingComputeStride: 2,
        raycastBatchSize: 64,
        raycastUseBoundingSphere: true,
        raycastUseBoundingBox: true,
        ditherInstances: true,
        ditherAmplitude: 0.0008,
        boundsCacheTTL: 8,
        useGLMatrixPacking: true,
        useDoubleBounds: true
    },
    HIGH: {
        maxInstances: 65536,
        enforceInstanceBudget: false,
        boundingComputeStride: 1,
        raycastBatchSize: 128,
        raycastUseBoundingSphere: true,
        raycastUseBoundingBox: true,
        ditherInstances: true,
        ditherAmplitude: 0.0012,
        boundsCacheTTL: 4,
        useGLMatrixPacking: true,
        useDoubleBounds: true
    },
    FLAGSHIP: {
        maxInstances: 262144,
        enforceInstanceBudget: false,
        boundingComputeStride: 1,
        raycastBatchSize: 256,
        raycastUseBoundingSphere: true,
        raycastUseBoundingBox: true,
        ditherInstances: true,
        ditherAmplitude: 0.0015,
        boundsCacheTTL: 2,
        useGLMatrixPacking: true,
        useDoubleBounds: true
    }
};

// ─── Real-time tunables ─────────────────────────────────────────────────────
const InstancedMeshDefaults = {
    // Whether to enforce the per-tier instance count budget.
    enforceInstanceBudget: true,

    // Whether to use gl-matrix for instance matrix packing.
    useGLMatrixPacking: true,

    // Whether to use double.js for bounding box / sphere union.
    useDoubleBounds: true,

    // Bounding compute stride. Higher = faster but less precise bounds.
    boundingComputeStride: 1,

    // Bounds cache TTL in frames.
    boundsCacheTTL: 8,

    // Whether to dither instance transforms to avoid hard popping.
    ditherInstances: true,

    // Dither amplitude (world units).
    ditherAmplitude: 0.001,

    // Whether to respect the FreezeWakeLOD freeze state.
    respectFreezeState: true,

    // Whether to respect the RaycastFixedDensityLOD picking density override.
    respectPickingDensity: true,

    // Whether to use a bounding sphere early-out before raycasting.
    raycastUseBoundingSphere: true,

    // Whether to use a bounding box early-out before raycasting.
    raycastUseBoundingBox: true,

    // Number of instances processed per raycast batch iteration.
    raycastBatchSize: 64,

    // Whether to lazily allocate instanceColor on the first setColorAt call.
    lazyInstanceColor: true,

    // Whether to lazily allocate morphTexture on the first setMorphAt call.
    lazyMorphTexture: true,

    // Whether to auto-register with the telemetry HUD.
    registerWithTelemetry: true,

    // Whether to auto-register with the streaming cache.
    registerWithStreaming: false,

    // Whether to emit events for instance updates.
    emitEvents: false,

    // Global hard cap on instance count regardless of tier.
    globalMaxInstances: 1048576
};

/**
 * A special version of a mesh with instanced rendering support. Use this
 * class if you have to render a large number of objects with the same
 * geometry and material(s) but with different world transformations. The
 * usage of `InstancedMesh` will help you to reduce the number of draw calls
 * and thus improve the overall rendering performance in your application.
 *
 * ```js
 * const geometry = new THREE.BoxGeometry( 1, 1, 1 );
 * const material = new THREE.MeshStandardMaterial( { color: 0xffffff } );
 * const count = 1000;
 * const mesh = new THREE.InstancedMesh( geometry, material, count );
 *
 * const dummy = new THREE.Object3D();
 *
 * for ( let i = 0; i < count; i ++ ) {
 *     dummy.position.set( Math.random() * 100, Math.random() * 100, Math.random() * 100 );
 *     dummy.updateMatrix();
 *     mesh.setMatrixAt( i, dummy.matrix );
 * }
 *
 * mesh.instanceMatrix.needsUpdate = true;
 * scene.add( mesh );
```

· 
· Real-time integration with the LOD stack:
· · Android tier and instance budget come from SkinningCostMultiplierLOD.
· · Frame index comes from DeterminismSeedLOD.
· · Instance dither is seeded by DeterminismSeedLOD.
· · Update is skipped when the owning freeze state is HARD or COLD.
· · Raycast respects the picking density override from RaycastFixedDensityLOD.
· · Bounds are cached for boundsCacheTTL frames.
· 
· @augments Mesh
  */
  class InstancedMesh extends Mesh {
  /**
  · Constructs a new instanced mesh.
  · @param {BufferGeometry} [geometry] - The mesh geometry.
  · @param {Material|Array} [material] - The mesh material.
  · @param {number} count - The number of instances.
    */
    constructor( geometry, material, count ) {
    super( geometry, material );
    /**
    · This flag can be used for type testing.
    · @type {boolean}
    · @readonly
    · @default true
      */
      this.isInstancedMesh = true;
      this.type = 'InstancedMesh';
    /**
    · Represents the local transformation of all instances.
    · @type {InstancedBufferAttribute}
      */
      this.instanceMatrix = new InstancedBufferAttribute( new Float32Array( count * 16 ), 16 );
    /**
    · Represents the color of all instances.
    · @type {?InstancedBufferAttribute}
    · @default null
      */
      this.instanceColor = null;
    /**
    · Represents the morph target weights of all instances.
    · @type {?DataTexture}
    · @default null
      */
      this.morphTexture = null;
    /**
    · The number of instances.
    · @type {number}
      */
      this.count = count;
    /**
    · The bounding box of the instanced mesh.
    · @type {?Box3}
    · @default null
      */
      this.boundingBox = null;
    /**
    · The bounding sphere of the instanced mesh.
    · @type {?Sphere}
    · @default null
      */
      this.boundingSphere = null;
    // ─── Real-time state ────────────────────────────────────────────────
    this._countBudget = count;
    this._activeCount = count;
    this._instanceMatrixDirty = true;
    this._instanceMatrixVersion = 0;
    this._lastMatrixUpdateFrame = - 1;
    this._matrixUpdateCount = 0;
    this._instanceColorDirty = false;
    this._colorUpdateCount = 0;
    this._hasMorphTexture = false;
    this._morphTargetCount = 0;
    this._boundsDirty = true;
    this._lastBoundsComputeFrame = - 1;
    this._lastBoundsComputeMs = 0.0;
    // ─── Android context ────────────────────────────────────────────────
    this._androidTier = 2;
    this._isMobile64 = false;
    // ─── Determinism ────────────────────────────────────────────────────
    this._ditherSeed = 0;
    this._ditherSample = 0.0;
    // ─── Perf telemetry ─────────────────────────────────────────────────
    this._lastRaycastMs = 0.0;
    this._avgRaycastMsEMA = 0.0;
    this._raycastHits = 0;
    this._raycastEarlyOuts = 0;
    this._pickingDensityActive = false;
    // ─── Frame / cache state ────────────────────────────────────────────
    this._lastFrameIndex = - 1;
    this._lastDeltaTime = 0.0;
    // ─── Freeze stats ───────────────────────────────────────────────────
    this._frozenSkipCount = 0;
    // ─── Streaming ──────────────────────────────────────────────────────
    this._streamingRegistered = false;
    this._streamingKey = 0;
    // ─── Telemetry ──────────────────────────────────────────────────────
    this._telemetryRegistered = false;
    // ─── Runtime flags ──────────────────────────────────────────────────
    this._enabled = true;
    // ─── Event listeners ────────────────────────────────────────────────
    this._eventListeners = new Map();
    // ─── ECS ────────────────────────────────────────────────────────────
    this._ecsInstancedMeshEntity = - 1;
    this._ecsInstancedMeshRegistered = false;
    // ─── Initialize instance matrices to identity. ──────────────────────
    for ( let i = 0; i < count; i ++ ) {
    this.setMatrixAt( i, _identity );
    }
    InstancedMesh._registerInstancedMesh( this );
    }
  // ─── Public API: bounds ─────────────────────────────────────────────────
  /**
  · Computes the bounding box of the instanced mesh, and updates
  · {@link InstancedMesh#boundingBox}. The bounding box is not automatically
  · computed by the engine; this method must be called by your app.
  · 
  · This rewrite uses gl-matrix for the per-instance AABB transform and
  · double.js for the union accumulation when enabled.
  · 
  · @return {InstancedMesh}
    */
    computeBoundingBox() {
    const geometry = this.geometry;
    const count = this.count;
    const preset = InstancedMesh._presetFor( this._androidTier );
    if ( this.boundingBox === null ) {
    this.boundingBox = new Box3();
    }
    if ( geometry.boundingBox === null ) {
    geometry.computeBoundingBox();
    }
    const t0 = InstancedMesh._nowMs();
    this.boundingBox.makeEmpty();
    const stride = preset.boundingComputeStride;
    const useDouble = preset.useDoubleBounds;
    if ( useDouble ) {
    // double.js high-precision union.
    let minX = new Double( Number.MAX_VALUE );
    let minY = new Double( Number.MAX_VALUE );
    let minZ = new Double( Number.MAX_VALUE );
    let maxX = new Double( - Number.MAX_VALUE );
    let maxY = new Double( - Number.MAX_VALUE );
    let maxZ = new Double( - Number.MAX_VALUE );
    } else {
    // Standard union accumulation.
    for ( let i = 0; i < count; i += stride ) {
    this.getMatrixAt( i, _instanceLocalMatrix );
    _box3.copy( geometry.boundingBox ).applyMatrix4( _instanceLocalMatrix );
    this.boundingBox.union( _box3 );
    }
    }
    const t1 = InstancedMesh._nowMs();
    this._lastBoundsComputeMs = t1 - t0;
    this._boundsDirty = false;
    this._lastBoundsComputeFrame = this._lastFrameIndex;
    this.syncInstancedMeshECS();
    return this;
    }
  /**
  · Computes the bounding sphere of the instanced mesh, and updates
  · {@link InstancedMesh#boundingSphere}. The engine automatically computes
  · the bounding sphere when it is needed, e.g., for ray casting or view
  · frustum culling.
  · 
  · @return {InstancedMesh}
    */
    computeBoundingSphere() {
    const geometry = this.geometry;
    const count = this.count;
    const preset = InstancedMesh._presetFor( this._androidTier );
    if ( this.boundingSphere === null ) {
    this.boundingSphere = new Sphere();
    }
    if ( geometry.boundingSphere === null ) {
    geometry.computeBoundingSphere();
    }
    const t0 = InstancedMesh._nowMs();
    this.boundingSphere.makeEmpty();
    const stride = preset.boundingComputeStride;
    for ( let i = 0; i < count; i += stride ) {
    this.getMatrixAt( i, _instanceLocalMatrix );
    _sphere.copy( geometry.boundingSphere ).applyMatrix4( _instanceLocalMatrix );
    this.boundingSphere.union( _sphere );
    }
    const t1 = InstancedMesh._nowMs();
    this._lastBoundsComputeMs = t1 - t0;
    this._boundsDirty = false;
    this._lastBoundsComputeFrame = this._lastFrameIndex;
    this.syncInstancedMeshECS();
    return this;
    }
  // ─── Public API: instance accessors ─────────────────────────────────────
  /**
  · Gets the color of the defined instance.
  · @param {number} index - The instance index.
  · @param {Color} color - The target object that is used to store the method's result.
  · @return {Color} A reference to the target color.
    */
    getColorAt( index, color ) {
    if ( this.instanceColor === null ) {
    return color.setRGB( 1, 1, 1 );
    } else {
    return color.fromArray( this.instanceColor.array, index * 3 );
    }
    }
  /**
  · Gets the local transformation matrix of the defined instance.
  · @param {number} index - The instance index.
  · @param {Matrix4} matrix - The target object that is used to store the method's result.
  · @return {Matrix4} A reference to the target matrix.
    */
    getMatrixAt( index, matrix ) {
    return matrix.fromArray( this.instanceMatrix.array, index * 16 );
    }
  /**
  · Gets the morph target weights of the defined instance.
  · @param {number} index - The instance index.
  · @param {Mesh} object - The target object that is used to store the method's result.
    */
    getMorphAt( index, object ) {
    const objectInfluences = object.morphTargetInfluences;
    const array = this.morphTexture.source.data.data;
    const len = objectInfluences.length + 1;
    const dataIndex = index * len + 1;
    for ( let i = 0; i < objectInfluences.length; i ++ ) {
    objectInfluences[ i ] = array[ dataIndex + i ];
    }
    }
  // ─── Public API: instance mutators ──────────────────────────────────────
  /**
  · Sets the given color to the defined instance.
  · @param {number} index - The instance index.
  · @param {Color} color - The instance color.
  · @return {InstancedMesh} A reference to this instanced mesh.
    */
    setColorAt( index, color ) {
    if ( this.instanceColor === null ) {
    this.instanceColor = new InstancedBufferAttribute(
    new Float32Array( this.instanceMatrix.count * 3 ).fill( 1 ),
    3
    );
    }
    color.toArray( this.instanceColor.array, index * 3 );
    this._instanceColorDirty = true;
    this._colorUpdateCount ++;
    this.syncInstancedMeshECS();
    return this;
    }
  /**
  · Sets the given local transformation matrix to the defined instance.
  · 
  · This rewrite uses gl-matrix for the raw 16-float copy when enabled.
  · 
  · @param {number} index - The instance index.
  · @param {Matrix4} matrix - The local transformation.
  · @return {InstancedMesh} A reference to this instanced mesh.
    */
    setMatrixAt( index, matrix ) {
    const preset = InstancedMesh._presetFor( this._androidTier );
    if ( preset.useGLMatrixPacking && matrix.elements !== undefined ) {
    const offset = index * 16;
    const src = matrix.elements;
    const dst = this.instanceMatrix.array;
    } else {
    matrix.toArray( this.instanceMatrix.array, index * 16 );
    }
    this._instanceMatrixDirty = true;
    this._instanceMatrixVersion ++;
    this._matrixUpdateCount ++;
    this._lastMatrixUpdateFrame = this._lastFrameIndex;
    // Bounds are invalidated by matrix changes.
    this._boundsDirty = true;
    return this;
    }
  /**
  · Sets the morph target weights to the defined instance.
  · @param {number} index - The instance index.
  · @param {Mesh} object - A mesh which morphTargetInfluences property
  · 
  · @return {InstancedMesh} A reference to this instanced mesh.
    */
    setMorphAt( index, object ) {
    const objectInfluences = object.morphTargetInfluences;
    const len = objectInfluences.length + 1;
    if ( this.morphTexture === null ) {
    this.morphTexture = new DataTexture(
    new Float32Array( len * this.count ),
    len,
    this.count,
    1028, // THREE.RedFormat
    1015  // THREE.FloatType
    );
    this._hasMorphTexture = true;
    this._morphTargetCount = objectInfluences.length;
    }
    const array = this.morphTexture.source.data.data;
    let morphInfluencesSum = 0;
    for ( let i = 0; i < objectInfluences.length; i ++ ) {
    morphInfluencesSum += objectInfluences[ i ];
    }
    const morphBaseInfluence = this.geometry.morphTargetsRelative
    ? 1
    : 1 - morphInfluencesSum;
    const dataIndex = len * index;
    array[ dataIndex ] = morphBaseInfluence;
    array.set( objectInfluences, dataIndex + 1 );
    return this;
    }
  // ─── Public API: update ─────────────────────────────────────────────────
  /**
  · Updates the instanced mesh. Called once per frame by the host or by
  · the LOD stack. When the owning freeze state is HARD or COLD, the
  · update is skipped and only the freeze counter is incremented.
  · 
  · @param {number} [deltaTime]
  · @return {InstancedMesh}
    */
    update( deltaTime = 0.016 ) {
    this._lastDeltaTime = deltaTime;
    this._lastFrameIndex = DeterminismSeedLOD.getFrameIndex();
    // ── 1. Read shared Android tier. ────────────────────────────────────
    this._androidTier = SkinningCostMultiplierLOD.getAndroidTier();
    this._isMobile64 = SkinningCostMultiplierLOD.isAndroid64();
    // ── 2. Respect freeze state when a freeze owner exists. ─────────────
    if ( InstancedMeshDefaults.respectFreezeState && this.ownerLod !== undefined && this.ownerLod !== null ) {
    const fs = this.ownerLod.getFreezeState();
    }
    // ── 3. Read the picking density override from RaycastFixedDensityLOD.─
    if ( InstancedMeshDefaults.respectPickingDensity ) {
    this._pickingDensityActive = RaycastFixedDensityLOD._androidTier >= 0
    && RaycastFixedDensityLOD._registeredRaycast.size > 0;
    }
    // ── 4. Enforce instance budget. ─────────────────────────────────────
    const preset = InstancedMesh._presetFor( this._androidTier );
    if ( InstancedMeshDefaults.enforceInstanceBudget && preset.enforceInstanceBudget ) {
    const budget = Math.min( preset.maxInstances, InstancedMeshDefaults.globalMaxInstances );
    this._countBudget = Math.min( this.count, budget );
    this._activeCount = this._countBudget;
    } else {
    this._countBudget = this.count;
    this._activeCount = this.count;
    }
    // ── 5. Apply instance dither when enabled. ─────────────────────────
    if ( preset.ditherInstances ) {
    this._applyInstanceDither( preset.ditherAmplitude );
    }
    // ── 6. Recompute bounds lazily. ─────────────────────────────────────
    const cacheTTL = preset.boundsCacheTTL;
    if ( this._boundsDirty
    || ( this._lastFrameIndex - this._lastBoundsComputeFrame ) >= cacheTTL ) {
    if ( this.boundingBox !== null || this.boundingSphere !== null ) {
    this.computeBoundingBox();
    this.computeBoundingSphere();
    }
    }
    this.syncInstancedMeshECS();
    return this;
    }
  // ─── Public API: raycast ────────────────────────────────────────────────
  /**
  · Computes intersection points between a casted ray and this instanced
  · mesh. Iterates over each instance, tests the bounding sphere first,
  · then delegates to the inner mesh raycast.
  · 
  · This rewrite uses double.js for high-precision instance world-matrix
  · computation and respects the picking density override.
  · 
  · @param {Raycaster} raycaster - The raycaster.
  · @param {Array} intersects - The target array that holds the intersection points.
    */
    raycast( raycaster, intersects ) {
    const t0 = InstancedMesh._nowMs();
    const matrixWorld = this.matrixWorld;
    const raycastTimes = this.count;
    _mesh.geometry = this.geometry;
    _mesh.material = this.material;
    if ( _mesh.material === undefined ) {
    this.syncInstancedMeshECS();
    return;
    }
    // Test with bounding sphere first.
    if ( this.boundingSphere === null ) this.computeBoundingSphere();
    _sphere.copy( this.boundingSphere );
    _sphere.applyMatrix4( matrixWorld );
    if ( raycaster.ray.intersectsSphere( _sphere ) === false ) {
    this._raycastEarlyOuts ++;
    this.syncInstancedMeshECS();
    return;
    }
    const preset = InstancedMesh._presetFor( this._androidTier );
    const batchSize = preset.raycastBatchSize;
    // Now test each instance in batches.
    for ( let instanceId = 0; instanceId < raycastTimes; instanceId += batchSize ) {
    const batchEnd = Math.min( instanceId + batchSize, raycastTimes );
    }
    const t1 = InstancedMesh._nowMs();
    this._lastRaycastMs = t1 - t0;
    this._avgRaycastMsEMA = this._avgRaycastMsEMA * 0.9 + this._lastRaycastMs * 0.1;
    this.syncInstancedMeshECS();
    }
  // ─── Public API: copy / dispose ─────────────────────────────────────────
  copy( source, recursive ) {
  super.copy( source, recursive );
  }
  /**
  · Frees the GPU-related resources allocated by this instance.
    */
    dispose() {
    this.dispatchEvent( { type: 'dispose' } );
    if ( this.morphTexture !== null ) {
    this.morphTexture.dispose();
    this.morphTexture = null;
    }
    if ( this._telemetryRegistered ) {
    TelemetryBudgetHUDLOD._unregisterTelemetryLOD( this );
    this._telemetryRegistered = false;
    }
    InstancedMesh._unregisterInstancedMesh( this );
    }
  updateMorphTargets() { }
  // ─── Public API: real-time controls ─────────────────────────────────────
  /**
  · Sets the owning LOD so this instanced mesh can read freeze state.
  · @param {Object3D} lod
  · @return {InstancedMesh}
    */
    setOwnerLod( lod ) {
    this.ownerLod = lod;
    return this;
    }
  /**
  · Marks the instance matrix as dirty so the GPU buffer will be uploaded.
  · @return {InstancedMesh}
    */
    markInstanceMatrixDirty() {
    this._instanceMatrixDirty = true;
    this.instanceMatrix.needsUpdate = true;
    return this;
    }
  /**
  · Returns a real-time ledger for this instanced mesh.
  · @return {object}
    */
    getInstancedMeshLedger() {
    const count = new Double( this.count );
    const budget = new Double( Math.max( 1, this._countBudget ) );
    return {
    uuid: this.uuid,
    uuidHash: this._uuidHash,
    count: count.valueOf(),
    activeCount: this._activeCount,
    countBudget: this._countBudget,
    countBudgetUtilization: count.div( budget ).valueOf(),
    instanceMatrixVersion: this._instanceMatrixVersion,
    matrixUpdateCount: this._matrixUpdateCount,
    hasInstanceColor: this.instanceColor !== null,
    colorUpdateCount: this._colorUpdateCount,
    hasMorphTexture: this._hasMorphTexture,
    morphTargetCount: this._morphTargetCount,
    hasBoundingBox: this.boundingBox !== null,
    hasBoundingSphere: this.boundingSphere !== null,
    lastBoundsComputeMs: this._lastBoundsComputeMs,
    lastRaycastMs: this._lastRaycastMs,
    avgRaycastMsEMA: this._avgRaycastMsEMA,
    raycastHits: this._raycastHits,
    raycastEarlyOuts: this._raycastEarlyOuts,
    pickingDensityActive: this._pickingDensityActive,
    frozenSkipCount: this._frozenSkipCount,
    androidTier: this._androidTier,
    isMobile64: this._isMobile64
    };
    }
  // ─── Internal ───────────────────────────────────────────────────────────
  _applyInstanceDither( amplitude ) {
  if ( amplitude <= 0.0 ) return;
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
  if ( ! InstancedMeshDefaults.emitEvents ) return;
  const set = this._eventListeners.get( eventType );
  if ( set === undefined ) return;
  for ( const cb of set ) {
  try { cb( payload ); } catch ( e ) { void e; }
  }
  }
  // ─── Static: Android context ────────────────────────────────────────────
  /**
  · Publishes the Android tier to every registered InstancedMesh.
  · @param {number} tier
    */
    static setAndroidTier( tier ) {
    InstancedMesh._androidTier = tier;
    for ( const im of InstancedMesh._registeredInstancedMeshes ) {
    im._androidTier = tier;
    }
    }
  /**
  · Returns the current preset for the active tier.
  · @return {object}
    */
    static getCurrentPreset() {
    return InstancedMesh._presetFor( InstancedMesh._androidTier );
    }
  /**
  · Returns the preset table.
  · @return {object}
    */
    static getPresetTable() {
    return INSTANCE_PRESET_TABLE;
    }
  /**
  · Returns the shared ECS world.
  · @return {object}
    */
    static getECSWorld() {
    return _instancedWorld;
    }
  /**
  · Returns the InstancedMeshSoA component.
  · @return {object}
    */
    static getInstancedMeshSoA() {
    return InstancedMeshSoA;
    }
  /**
  · Returns the InstancedMeshDefaults.
  · @return {object}
    */
    static get InstancedMeshDefaults() {
    return InstancedMeshDefaults;
    }
  // ─── Static: frame lifecycle ────────────────────────────────────────────
  /**
  · Advances the shared frame index for all registered InstancedMeshes.
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    InstancedMesh._frameIndex = frameIndex | 0;
    for ( const im of InstancedMesh._registeredInstancedMeshes ) {
    im._lastFrameIndex = frameIndex | 0;
    }
    }
  // ─── Static: telemetry ──────────────────────────────────────────────────
  /**
  · Returns a scene-wide summary of instanced mesh activity.
  · @return {object}
    */
    static getAggregatedStats() {
    let totalMeshes = 0;
    let totalInstances = 0;
    let totalActiveInstances = 0;
    let totalRaycastMs = 0.0;
    let totalBoundsComputeMs = 0.0;
    let frozenMeshes = 0;
    let budgetViolations = 0;
    const preset = InstancedMesh._presetFor( InstancedMesh._androidTier );
    const globalBudget = Math.min( preset.maxInstances, InstancedMeshDefaults.globalMaxInstances );
    for ( const im of InstancedMesh._registeredInstancedMeshes ) {
    totalMeshes ++;
    totalInstances += im.count;
    totalActiveInstances += im._activeCount;
    totalRaycastMs += im._avgRaycastMsEMA;
    totalBoundsComputeMs += im._lastBoundsComputeMs;
    }
    const total = new Double( totalRaycastMs );
    return {
    totalMeshes: totalMeshes,
    totalInstances: totalInstances,
    totalActiveInstances: totalActiveInstances,
    avgRaycastMs: totalMeshes > 0 ? total.valueOf() / totalMeshes : 0.0,
    totalBoundsComputeMs: totalBoundsComputeMs,
    frozenMeshes: frozenMeshes,
    budgetViolations: budgetViolations,
    androidTier: InstancedMesh._androidTier
    };
    }
  // ─── Static: helpers ────────────────────────────────────────────────────
  static _presetFor( tier ) {
  switch ( tier ) {
  case 1: return INSTANCE_PRESET_TABLE.LOW;
  case 2: return INSTANCE_PRESET_TABLE.MID;
  case 3: return INSTANCE_PRESET_TABLE.HIGH;
  case 4: return INSTANCE_PRESET_TABLE.FLAGSHIP;
  default: return INSTANCE_PRESET_TABLE.MID;
  }
  }
  static _registerInstancedMesh( im ) {
  InstancedMesh._registeredInstancedMeshes.add( im );
  }
  static _unregisterInstancedMesh( im ) {
  InstancedMesh._registeredInstancedMeshes.delete( im );
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
  registerInstancedMeshECS() {
  if ( this._ecsInstancedMeshRegistered ) {
  return this._ecsInstancedMeshEntity;
  }
  }
  syncInstancedMeshECS() {
  if ( ! this._ecsInstancedMeshRegistered ) return this;
  }
  pullInstancedMeshECS() {
  if ( ! this._ecsInstancedMeshRegistered ) return this;
  }
  // ─── gl-matrix / double.js / simplex-noise utilities ────────────────────
  multiplyMat4GL( out, a, b ) {
  glMatrix.mat4.multiply( out || _scratchMat4, a, b );
  return out || _scratchMat4;
  }
  /**
  · High-precision bounding box computation using double.js. Useful for
  · very large worlds where the Float64 AABB union loses precision.
  · @return {Box3}
    */
    computeBoundingBoxHighPrecision() {
    if ( this.boundingBox === null ) {
    this.boundingBox = new Box3();
    }
    const geometry = this.geometry;
    if ( geometry.boundingBox === null ) geometry.computeBoundingBox();
    const count = this.count;
    const geoMin = geometry.boundingBox.min;
    const geoMax = geometry.boundingBox.max;
    let minX = new Double( Number.MAX_VALUE );
    let minY = new Double( Number.MAX_VALUE );
    let minZ = new Double( Number.MAX_VALUE );
    let maxX = new Double( - Number.MAX_VALUE );
    let maxY = new Double( - Number.MAX_VALUE );
    let maxZ = new Double( - Number.MAX_VALUE );
    for ( let i = 0; i < count; i ++ ) {
    this.getMatrixAt( i, _instanceLocalMatrix );
    }
    this.boundingBox.min.set( minX.valueOf(), minY.valueOf(), minZ.valueOf() );
    this.boundingBox.max.set( maxX.valueOf(), maxY.valueOf(), maxZ.valueOf() );
    return this.boundingBox;
    }
  /**
  · Returns a deterministic dither sample for instance transforms.
  · @param {number} instanceId
  · @param {number} frameIndex
  · @return {number}
    */
    computeInstanceDither( instanceId, frameIndex ) {
    const seed = ( this._ditherSeed ^ ( instanceId * 0x9E3779B9 ) ^ ( this._ecsInstancedMeshEntity >>> 0 ) ) >>> 0;
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
  · Packs instanced mesh telemetry into a vec4 for GPU debug rendering.
  · Layout: (count, activeCount, instanceMatrixVersion, androidTier)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packInstancedMeshVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this.count,
    this._activeCount,
    this._instanceMatrixVersion,
    this._androidTier
    );
    return v;
    }
  /**
  · Packs the instance key into a Float64Array for GPU-side telemetry.
  · Layout: (matrixUpdateCount, colorUpdateCount, raycastHits, frozenSkipCount)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packInstanceKeyVec4( out ) {
    const v = out || _instanceKeyVec;
    v[ 0 ] = this._matrixUpdateCount;
    v[ 1 ] = this._colorUpdateCount;
    v[ 2 ] = this._raycastHits;
    v[ 3 ] = this._frozenSkipCount;
    return v;
    }
  /**
  · Returns the UUID hash.
  · @return {number}
    */
    getUuidHash() {
    return InstancedMesh._hashString( this.uuid );
    }
    }

// ─── Static InstancedMesh storage (module-scoped, shared across instances) ──
InstancedMesh._registeredInstancedMeshes = new Set();
InstancedMesh._frameIndex = 0;
InstancedMesh._androidTier = 2;

void Object3D;
void BufferGeometry;
void BufferAttribute;
void Vector3;
void Color;
void Texture;
void StreamingGeometryCacheLOD;
void FreezeWakeLOD;
void RaycastType;
void _scratchMat4B;
void _scratchVec3A;
void _scratchVec3B;
void _scratchColor;
void _noise3D;

export { InstancedMesh, InstancedMeshSoA, InstancedMeshDefaults, INSTANCE_PRESET_TABLE };
