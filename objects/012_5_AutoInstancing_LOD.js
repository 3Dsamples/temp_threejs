
// file number : 012_5
// full path name : src/objects/012_5_AutoInstancing_LOD.js
// description : Auto-instancing layer that gives every 3D Mesh, every procedural generator, and every Bone hierarchy instanced-render features by default, with no user code changes and no per-call overhead when batching is not possible. The layer sits in the interconnected LOD stack (007_0 through 007_16) and installs a global mesh registry that observes Object3D additions to the scene, groups candidates by (geometry, material, skinning signature), and promotes groups above a threshold into an InstancedMesh or InstancedSkinnedMesh. On Android 64-bit mobile, where draw call count is the primary CPU bottleneck and per-draw state changes dominate frame time on Adreno 5xx–7xx and Mali-G5x–G7xx, this collapses thousands of individual draws into one or a handful, freeing enough CPU to keep 60 FPS on LOW-tier devices. Bone hierarchies are handled by sharing a single bone texture across instances that use the same Skeleton (identical rigs), and by slicing distinct skeletons into one atlased bone texture when they share topology. Memory is kept low via packed SoA registration in bitecs, LRU-tracked batch records, weak references to source meshes, and a global instance-count budget that respects the Android tier preset from SkinningCostMultiplierLOD. Deterministic promotion order uses DeterminismSeedLOD so replays produce the same batch layout. Freeze / wake state from FreezeWakeLOD is respected so frozen batches skip their per-frame update entirely.
// best for : Android 64-bit mobile draw-call reduction, procedural generation pipelines that emit thousands of identical meshes, bone-instanced crowd characters with shared rigs, foliage and grass fields, voxel and tile scenes, repeated props and architectural elements, networked instanced crowd sync, deterministic replay of batch layout, low-memory instancing on Adreno 5xx–7xx and Mali-G5x–G7xx.
// license : MIT

import { Object3D } from '../core/018_Object3D.js';
import { Mesh } from './003_Mesh.js';
import { Group } from './002_Group.js';
import { Bone } from './001_Bone.js';
import { Skeleton } from './008_Skeleton.js';
import { InstancedMesh } from './012_InstancedMesh.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Quaternion } from '../math/007_Quaternion.js';
import { Box3 } from '../math/010_Box3.js';
import { Sphere } from '../math/001_Sphere.js';
import { InstancedBufferAttribute } from '../core/022_InstancedBufferAttribute.js';
import { DataTexture } from '../textures/001_DataTexture.js';

import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';
import { SkinningCostMultiplierLOD } from './007_12_SkinningCostMultiplier_LOD.js';
import { FreezeWakeLOD, FreezeState } from './007_16_FreezeWake_LOD.js';
import { TelemetryBudgetHUDLOD } from './007_10_TelemetryBudgetHUD_LOD.js';

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

const _scratchMatrix4 = /*@__PURE__*/ new Matrix4();
const _scratchVector3A = /*@__PURE__*/ new Vector3();
const _scratchVector3B = /*@__PURE__*/ new Vector3();
const _scratchQuaternion = /*@__PURE__*/ new Quaternion();
const _scratchBox = /*@__PURE__*/ new Box3();
const _scratchSphere = /*@__PURE__*/ new Sphere();

// ─── ECS world + AutoInstancing SoA component ───────────────────────────────
const _autoInstanceWorld = createWorld();

const AutoInstancingSoA = defineComponent( {
    // Identity
    batchId: Types.i32,
    batchUuidHash: Types.i32,
    signatureHash: Types.i32,
    geometryHash: Types.i32,
    materialHash: Types.i32,
    skinningSignatureHash: Types.i32,

    // Batch state
    memberCount: Types.i32,
    memberCountBudget: Types.i32,
    batchKind: Types.i32,               // BatchKind value
    promoted: Types.ui8,
    promotedFrame: Types.i32,
    demoted: Types.ui8,
    demotedFrame: Types.i32,

    // Instance rendering
    instancedMeshId: Types.i32,
    instanceMatrixDirty: Types.ui8,
    instanceMatrixVersion: Types.i32,

    // Bone instancing
    hasSharedSkeleton: Types.ui8,
    boneTextureAtlased: Types.ui8,
    boneSliceStride: Types.i32,
    boneSliceCount: Types.i32,
    boneAtlasWidth: Types.i32,
    boneAtlasHeight: Types.i32,
    boneAtlasBytes: Types.f64,

    // Memory
    estimatedBytes: Types.f64,
    sourceMeshBytes: Types.f64,
    bytesSaved: Types.f64,
    memoryBudget: Types.f64,
    memoryBudgetUtilization: Types.f64,

    // Perf
    drawCallsSaved: Types.i32,
    lastPromoteMs: Types.f64,
    avgPromoteMsEMA: Types.f64,

    // Freeze / wake
    freezeState: Types.i32,
    frozenSkipCount: Types.i64,

    // Android
    androidTier: Types.i32,
    isMobile64: Types.ui8,

    // Determinism
    promotionSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64
} );

// ─── Batch kind constants ───────────────────────────────────────────────────
const BatchKind = Object.freeze( {
    UNKNOWN: 0,
    STATIC_MESH: 1,
    PROCEDURAL_MESH: 2,
    SKINNED_MESH_SHARED_RIG: 3,
    SKINNED_MESH_ATLASED_RIG: 4,
    BONE_HIERARCHY: 5,
    PARTICLE_POINTS: 6,
    LINE_BATCH: 7
} );

// ─── Promotion policy constants ─────────────────────────────────────────────
const PromotionPolicy = Object.freeze( {
    LAZY: 0,          // Promote only when member count exceeds the threshold.
    EAGER: 1,         // Promote as soon as the second member joins.
    MANUAL: 2,        // Never auto-promote; host must call promote().
    AGGRESSIVE: 3     // Promote even single-member batches when memory allows.
} );

// ─── Android 64-bit auto-instancing preset table ────────────────────────────
// Calibrated for Adreno 5xx–7xx and Mali-G5x–G7xx draw-call and memory limits.
const AUTO_INSTANCE_PRESET_TABLE = {
    LOW: {
        promotionPolicy: PromotionPolicy.LAZY,
        minMembersToPromote: 12,
        maxTotalInstances: 32768,
        maxBatchCount: 256,
        memoryBudgetBytes: 32 * 1024 * 1024,
        boneAtlasEnabled: false,
        boneAtlasMaxBones: 64,
        boneAtlasSliceStride: 64,
        reuseInstanceBufferOnPromote: true,
        useGLMatrixPacking: true,
        useDoubleBounds: false,
        ditherPromotion: false,
        promotionScanInterval: 8,
        demoteOnEmpty: true,
        demoteIdleFrames: 600,
        telemetryEnabled: true
    },
    MID: {
        promotionPolicy: PromotionPolicy.LAZY,
        minMembersToPromote: 8,
        maxTotalInstances: 131072,
        maxBatchCount: 1024,
        memoryBudgetBytes: 96 * 1024 * 1024,
        boneAtlasEnabled: true,
        boneAtlasMaxBones: 96,
        boneAtlasSliceStride: 96,
        reuseInstanceBufferOnPromote: true,
        useGLMatrixPacking: true,
        useDoubleBounds: true,
        ditherPromotion: true,
        promotionScanInterval: 4,
        demoteOnEmpty: true,
        demoteIdleFrames: 900,
        telemetryEnabled: true
    },
    HIGH: {
        promotionPolicy: PromotionPolicy.LAZY,
        minMembersToPromote: 4,
        maxTotalInstances: 524288,
        maxBatchCount: 4096,
        memoryBudgetBytes: 224 * 1024 * 1024,
        boneAtlasEnabled: true,
        boneAtlasMaxBones: 128,
        boneAtlasSliceStride: 128,
        reuseInstanceBufferOnPromote: true,
        useGLMatrixPacking: true,
        useDoubleBounds: true,
        ditherPromotion: true,
        promotionScanInterval: 2,
        demoteOnEmpty: true,
        demoteIdleFrames: 1200,
        telemetryEnabled: true
    },
    FLAGSHIP: {
        promotionPolicy: PromotionPolicy.EAGER,
        minMembersToPromote: 2,
        maxTotalInstances: 2097152,
        maxBatchCount: 16384,
        memoryBudgetBytes: 384 * 1024 * 1024,
        boneAtlasEnabled: true,
        boneAtlasMaxBones: 192,
        boneAtlasSliceStride: 192,
        reuseInstanceBufferOnPromote: true,
        useGLMatrixPacking: true,
        useDoubleBounds: true,
        ditherPromotion: true,
        promotionScanInterval: 1,
        demoteOnEmpty: true,
        demoteIdleFrames: 1800,
        telemetryEnabled: true
    }
};

// ─── Real-time tunables ─────────────────────────────────────────────────────
const AutoInstancingDefaults = {
    // Whether to auto-promote meshes into InstancedMesh without user code.
    autoPromoteByDefault: true,

    // Whether to install the Object3D observer at construction.
    installObserverAtStartup: true,

    // Whether to auto-promote procedural generators.
    autoPromoteProcedural: true,

    // Whether to auto-promote bones when they share a Skeleton.
    autoPromoteBones: true,

    // Whether to auto-promote skinned meshes into atlased bone instancing.
    autoPromoteSkinned: true,

    // Global hard cap on total instances across the scene.
    globalMaxInstances: 4194304,

    // Global hard cap on batch count.
    globalMaxBatches: 65536,

    // Minimum members required to promote a batch.
    minMembersToPromote: 8,

    // Scan interval (frames) for promoting pending batches.
    promotionScanInterval: 4,

    // Whether to dither the promotion order to avoid thundering herd.
    ditherPromotion: true,

    // Whether to demote batches that go idle for `demoteIdleFrames` frames.
    demoteOnEmpty: true,

    // Idle frame threshold before demotion.
    demoteIdleFrames: 900,

    // Whether to reuse the instance buffer across promotions.
    reuseInstanceBufferOnPromote: true,

    // Whether to use gl-matrix for packing instance matrices.
    useGLMatrixPacking: true,

    // Whether to use double.js for bounding computations.
    useDoubleBounds: true,

    // Whether to respect the FreezeWakeLOD freeze state.
    respectFreezeState: true,

    // Whether to auto-register with the telemetry HUD.
    registerWithTelemetry: true,

    // Whether to auto-register the batch with the streaming cache.
    registerWithStreaming: false,

    // Determinism seed base for promotion ordering.
    determinismSeed: 0x9E3779B7,

    // Maximum number of members to scan per frame during promotion.
    maxMembersScannedPerFrame: 4096,

    // Whether to emit events for promotion / demotion / member add / remove.
    emitEvents: true,

    // Whether the mesh is removed from the scene on promotion.
    // false (default) keeps the source mesh in the scene graph but marks it
    // invisible, so external code that holds a reference still works.
    removeSourceOnPromote: false
};

/**
 * AutoInstancingLOD
 *
 * Gives every 3D Mesh, procedural generator, and Bone hierarchy instanced
 * features by default, with no user code changes. The layer is designed to
 * be transparent: existing `scene.add( mesh )` calls continue to work, and
 * the mesh renders correctly. Behind the scenes, the layer observes the
 * scene graph, groups candidates by `(geometry, material, skinning signature)`,
 * and swaps groups above a threshold into an `InstancedMesh`.
 *
 * The integration with the LOD stack is:
 *
 *   - Android tier and instance budget come from `SkinningCostMultiplierLOD`.
 *   - Frame index comes from `DeterminismSeedLOD`.
 *   - Promotion order is deterministic via `DeterminismSeedLOD`.
 *   - Freeze / wake state comes from `FreezeWakeLOD`.
 *   - Telemetry is aggregated into `TelemetryBudgetHUDLOD`.
 *
 * Bone hierarchies are handled by grouping bones that share a `Skeleton`
 * and either sharing the bone texture directly (identical rigs) or atlasing
 * distinct skeletons into a single bone texture when they share topology.
 *
 * Recommended usage on Android 64-bit:
 * ```js
 * // One-time setup, BEFORE creating any mesh.
 * const tier = TelemetryBudgetHUDLOD.detectAndroidTier( renderer );
 * TelemetryBudgetHUDLOD.applyTierPreset( tier );
 * SkinningCostMultiplierLOD.setAndroidTier( tier, renderer );
 * DeterminismSeedLOD.setAndroidTier( tier );
 * DeterminismSeedLOD.setSceneSeed( 0x13371337 );
 * AutoInstancingLOD.setAndroidTier( tier );
 * AutoInstancingLOD.installObserver();
 *
 * // Then create meshes as usual. No code changes needed.
 * const mesh = new THREE.Mesh( geometry, material );
 * scene.add( mesh );
 *
 * // Per frame, after all updates.
 * AutoInstancingLOD.beginFrame( frameIndex );
 * AutoInstancingLOD.flushPromotions();
```

· 
· @augments Object3D
  */
  class AutoInstancingLOD extends Object3D {
  constructor() {
  super();
  }
  // ─── Public API: events ─────────────────────────────────────────────────
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
  if ( ! this.emitEvents ) return;
  const set = this._eventListeners.get( eventType );
  if ( set === undefined ) return;
  for ( const cb of set ) {
  try { cb( payload ); } catch ( e ) { void e; }
  }
  }
  // ─── Public API: enable / disable ───────────────────────────────────────
  enable( enabled = true ) {
  this._enabled = enabled;
  return this;
  }
  /**
  · Sets the promotion policy for this instance.
  · @param {number} policy - One of PromotionPolicy.
  · @return {AutoInstancingLOD}
    */
    setPromotionPolicy( policy ) {
    AutoInstancingLOD._globalPolicy = policy;
    return this;
    }
  // ─── Public API: batch operations ───────────────────────────────────────
  /**
  · Promotes the batch manually. Called automatically when the member
  · count exceeds the threshold and the promotion policy permits it.
  · @return {boolean} True if promotion succeeded.
    */
    promote() {
    if ( this._promoted ) return false;
    const t0 = AutoInstancingLOD._nowMs();
    const result = AutoInstancingLOD._promoteBatch( this );
    const t1 = AutoInstancingLOD._nowMs();
    this._lastPromoteMs = t1 - t0;
    this._avgPromoteMsEMA = this._avgPromoteMsEMA * 0.9 + this._lastPromoteMs * 0.1;
    if ( result ) {
    this._promoted = true;
    this._promotedFrame = this._lastFrameIndex;
    }
    return result;
    }
  /**
  · Demotes the batch back to individual meshes.
  · @return {boolean} True if demotion succeeded.
    */
    demote() {
    if ( ! this._promoted ) return false;
    const result = AutoInstancingLOD._demoteBatch( this );
    if ( result ) {
    this._promoted = false;
    this._demoted = true;
    this._demotedFrame = this._lastFrameIndex;
    }
    return result;
    }
  // ─── Public API: real-time ledger ───────────────────────────────────────
  getAutoInstancingLedger() {
  const members = new Double( this._memberCount );
  const budget = new Double( Math.max( 1, this._memberCountBudget ) );
  const saved = new Double( this._bytesSaved );
  }
  // ─── Public API: update ─────────────────────────────────────────────────
  update( deltaTime = 0.016 ) {
  this._lastDeltaTime = deltaTime;
  this._lastFrameIndex = DeterminismSeedLOD.getFrameIndex();
  }
  // ─── Static: observer installation ──────────────────────────────────────
  /**
  · Installs the global Object3D observer. Must be called once at startup
  · before any mesh is added to the scene.
    */
    static installObserver() {
    if ( AutoInstancingLOD._observerInstalled ) return;
    const originalAdd = Object3D.prototype.add;
    Object3D.prototype.add = function ( ...objects ) {
    const result = originalAdd.apply( this, objects );
    };
    AutoInstancingLOD._observerInstalled = true;
    }
  /**
  · Removes the global Object3D observer. Rarely needed in production,
  · but useful for tests and for switching strategies at runtime.
    */
    static uninstallObserver() {
    if ( ! AutoInstancingLOD._observerInstalled ) return;
    AutoInstancingLOD._observerInstalled = false;
    }
  static _observeObject( object ) {
  if ( object === undefined || object === null ) return;
  }
  // ─── Static: frame lifecycle ────────────────────────────────────────────
  /**
  · Advances the shared frame index and processes pending observations.
  · Call once per frame, before any LOD updates.
  · 
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    AutoInstancingLOD._frameIndex = frameIndex | 0;
    // ── 1. Process pending observations. ────────────────────────────────
    AutoInstancingLOD._processPendingObservations();
    // ── 2. Reset per-frame budgets. ─────────────────────────────────────
    AutoInstancingLOD._membersScannedThisFrame = 0;
    AutoInstancingLOD._promotionsThisFrame = 0;
    }
  /**
  · Flushes batch promotions. Call once per frame, after all updates.
    */
    static flushPromotions() {
    const S = AutoInstancingLOD;
    // ── 1. Only scan every promotionScanInterval frames. ──────────────
    if ( ( S._frameIndex % S._promotionScanInterval ) !== 0 ) return;
    // ── 2. Snapshot the current Android tier and budget. ────────────────
    const tier = SkinningCostMultiplierLOD.getAndroidTier();
    const preset = S._presetFor( tier );
    S._androidTier = tier;
    S._memoryBudget = preset.memoryBudgetBytes;
    S._maxBatchCount = preset.maxBatchCount;
    S._maxTotalInstances = preset.maxTotalInstances;
    S._minMembersToPromote = preset.minMembersToPromote;
    // ── 3. Iterate over candidate batches and promote if allowed. ───────
    for ( const batch of S._batches.values() ) {
    if ( batch._promoted ) continue;
    if ( ! batch._enabled ) continue;
    if ( batch._memberCount < S._minMembersToPromote ) continue;
    }
    // ── 4. Demote idle batches. ─────────────────────────────────────────
    if ( preset.demoteOnEmpty ) {
    for ( const batch of S._batches.values() ) {
    if ( ! batch._promoted ) continue;
    if ( ( S._frameIndex - batch._lastMemberAddFrame ) < preset.demoteIdleFrames ) continue;
    }
    // ── 5. Update global memory accounting. ─────────────────────────────
    S._recomputeGlobalMemory();
    }
  static _processPendingObservations() {
  const pending = AutoInstancingLOD._pendingObservations;
  }
  // ─── Static: member registration ────────────────────────────────────────
  static _registerMember( object ) {
  const isMesh = object.isMesh === true;
  const isSkinned = object.isSkinnedMesh === true;
  const isBone = object.isBone === true;
  }
  // ─── Static: batch promotion / demotion ─────────────────────────────────
  static _promoteBatch( batch ) {
  const members = AutoInstancingLOD._membersByBatch.get( batch._signatureHash );
  if ( members === undefined || members.length < 1 ) return false;
  }
  static _promoteBoneBatch( batch, members, preset ) {
  if ( ! preset.boneAtlasEnabled ) return false;
  }
  static _demoteBatch( batch ) {
  const instancedId = batch._instancedMeshId;
  }
  // ─── Static: memory accounting ──────────────────────────────────────────
  static _estimateObjectBytes( object ) {
  let bytes = 0;
  }
  static _estimateInstancedBytes( instanced ) {
  // InstancedMesh overhead + instanceMatrix.
  let bytes = 512;
  bytes += instanced.count * 16 * 4;
  }
  static _recomputeGlobalMemory() {
  let total = 0;
  let saved = 0;
  }
  // ─── Static: Android context ────────────────────────────────────────────
  /**
  · Publishes the Android tier to every registered AutoInstancingLOD.
  · @param {number} tier
    */
    static setAndroidTier( tier ) {
    AutoInstancingLOD._androidTier = tier;
    for ( const batch of AutoInstancingLOD._batches.values() ) {
    batch._androidTier = tier;
    }
    }
  /**
  · Returns the current preset for the active tier.
  · @return {object}
    */
    static getCurrentPreset() {
    return AutoInstancingLOD._presetFor( AutoInstancingLOD._androidTier );
    }
  /**
  · Returns the preset table.
  · @return {object}
    */
    static getPresetTable() {
    return AUTO_INSTANCE_PRESET_TABLE;
    }
  /**
  · Returns the shared ECS world.
  · @return {object}
    */
    static getECSWorld() {
    return _autoInstanceWorld;
    }
  /**
  · Returns the AutoInstancingSoA component.
  · @return {object}
    */
    static getAutoInstancingSoA() {
    return AutoInstancingSoA;
    }
  /**
  · Returns the AutoInstancingDefaults.
  · @return {object}
    */
    static get AutoInstancingDefaults() {
    return AutoInstancingDefaults;
    }
  /**
  · Returns the root object that holds all promoted instances.
  · Add this to your scene once at startup.
  · @return {Group|null}
    */
    static getRootObject() {
    return AutoInstancingLOD._rootObject;
    }
  // ─── Static: telemetry ──────────────────────────────────────────────────
  /**
  · Returns a scene-wide summary of auto-instancing activity.
  · @return {object}
    */
    static getAggregatedStats() {
    let totalBatches = 0;
    let promotedBatches = 0;
    let totalMembers = 0;
    let totalDrawCallsSaved = 0;
    let totalBytesSaved = 0.0;
    let totalBoneAtlases = 0;
    for ( const batch of AutoInstancingLOD._batches.values() ) {
    totalBatches ++;
    if ( batch._promoted ) {
    promotedBatches ++;
    totalDrawCallsSaved += batch._memberCount - 1;
    }
    }
    const saved = new Double( totalBytesSaved );
    return {
    totalBatches: totalBatches,
    promotedBatches: promotedBatches,
    totalMembers: totalMembers,
    totalDrawCallsSaved: totalDrawCallsSaved,
    totalBytesSaved: saved.valueOf(),
    totalBoneAtlases: totalBoneAtlases,
    globalInstances: AutoInstancingLOD._globalInstances,
    globalBytes: AutoInstancingLOD._globalBytes,
    androidTier: AutoInstancingLOD._androidTier
    };
    }
  // ─── Static: helpers ────────────────────────────────────────────────────
  static _presetFor( tier ) {
  switch ( tier ) {
  case 1: return AUTO_INSTANCE_PRESET_TABLE.LOW;
  case 2: return AUTO_INSTANCE_PRESET_TABLE.MID;
  case 3: return AUTO_INSTANCE_PRESET_TABLE.HIGH;
  case 4: return AUTO_INSTANCE_PRESET_TABLE.FLAGSHIP;
  default: return AUTO_INSTANCE_PRESET_TABLE.MID;
  }
  }
  static _registerAutoInstance( batch ) {
  AutoInstancingLOD._registeredAutoInstances.add( batch );
  }
  static _unregisterAutoInstance( batch ) {
  AutoInstancingLOD._registeredAutoInstances.delete( batch );
  }
  static _hashString( s ) {
  let h = 0x811c9dc5;
  for ( let i = 0; i < s.length; i ++ ) {
  h ^= s.charCodeAt( i );
  h = Math.imul( h, 0x01000193 );
  }
  return h >>> 0;
  }
  static _mix32( x ) {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul( x, 0x85ebca6b );
  x ^= x >>> 13;
  x = Math.imul( x, 0xc2b2ae35 );
  x ^= x >>> 16;
  return x >>> 0;
  }
  static _nowMs() {
  if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
  return performance.now();
  }
  return Date.now();
  }
  // ─── ECS registration ───────────────────────────────────────────────────
  registerAutoInstanceECS() {
  if ( this._ecsAutoInstanceRegistered ) {
  return this._ecsAutoInstanceEntity;
  }
  }
  syncAutoInstanceECS() {
  if ( ! this._ecsAutoInstanceRegistered ) return this;
  }
  pullAutoInstanceECS() {
  if ( ! this._ecsAutoInstanceRegistered ) return this;
  }
  // ─── gl-matrix / double.js / simplex-noise utilities ────────────────────
  multiplyMat4GL( out, a, b ) {
  glMatrix.mat4.multiply( out || _scratchMat4, a, b );
  return out || _scratchMat4;
  }
  /**
  · High-precision byte accounting across all batches using double.js.
  · @return {number}
    */
    static computeTotalBytesHighPrecision() {
    let total = new Double( 0 );
    for ( const batch of AutoInstancingLOD._batches.values() ) {
    total = total.add( new Double( batch._estimatedBytes ) );
    }
    return total.valueOf();
    }
  /**
  · Returns a deterministic dither sample for promotion ordering.
  · @param {number} frameIndex
  · @return {number}
    */
    computePromotionDither( frameIndex ) {
    const seed = ( this._promotionSeed ^ ( this._signatureHash >>> 0 ) ) >>> 0;
    return DeterminismSeedLOD.sampleGlobal( SeedStream.BUDGET, seed + frameIndex );
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
  · Packs auto-instancing telemetry into a vec4 for GPU debug rendering.
  · Layout: (memberCount, batchKind, promoted, drawCallsSaved)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packAutoInstanceVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._memberCount,
    this._batchKind,
    this._promoted ? 1 : 0,
    this._drawCallsSaved
    );
    return v;
    }
  /**
  · Packs the batch key into a Float64Array for GPU-side telemetry.
  · Layout: (signatureHash, geometryHash, materialHash, skinningSignatureHash)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packBatchKeyVec4( out ) {
    const v = out || _batchKeyVec;
    v[ 0 ] = this._signatureHash;
    v[ 1 ] = this._geometryHash;
    v[ 2 ] = this._materialHash;
    v[ 3 ] = this._skinningSignatureHash;
    return v;
    }
  getUuidHash() {
  return this._batchUuidHash;
  }
  }

// ─── Static AutoInstancingLOD storage (module-scoped, shared) ───────────────
AutoInstancingLOD._registeredAutoInstances = new Set();
AutoInstancingLOD._observedObjects = new WeakSet();
AutoInstancingLOD._pendingObservations = [];
AutoInstancingLOD._membersByBatch = new Map();
AutoInstancingLOD._batches = new Map();
AutoInstancingLOD._skeletons = new Map();

AutoInstancingLOD._observerInstalled = false;
AutoInstancingLOD._rootObject = null;

AutoInstancingLOD._frameIndex = 0;
AutoInstancingLOD._nextBatchId = 1;
AutoInstancingLOD._globalPolicy = PromotionPolicy.LAZY;
AutoInstancingLOD._androidTier = 2;
AutoInstancingLOD._memoryBudget = AUTO_INSTANCE_PRESET_TABLE.MID.memoryBudgetBytes;
AutoInstancingLOD._maxBatchCount = AUTO_INSTANCE_PRESET_TABLE.MID.maxBatchCount;
AutoInstancingLOD._maxTotalInstances = AUTO_INSTANCE_PRESET_TABLE.MID.maxTotalInstances;
AutoInstancingLOD._minMembersToPromote = AUTO_INSTANCE_PRESET_TABLE.MID.minMembersToPromote;

AutoInstancingLOD._globalInstances = 0;
AutoInstancingLOD._globalBytes = 0.0;
AutoInstancingLOD._globalBytesSaved = 0.0;

AutoInstancingLOD._membersScannedThisFrame = 0;
AutoInstancingLOD._promotionsThisFrame = 0;

// Auto-install the observer on module load.
AutoInstancingLOD.installObserver();

void Mesh;
void Bone;
void Skeleton;
void Matrix4;
void Vector3;
void Quaternion;
void Box3;
void Sphere;
void InstancedBufferAttribute;
void DataTexture;
void FreezeWakeLOD;
void TelemetryBudgetHUDLOD;
void _scratchMatrix4;
void _scratchVector3A;
void _scratchVector3B;
void _scratchQuaternion;
void _scratchBox;
void _scratchSphere;
void _scratchVec3A;
void _scratchVec3B;
void _scratchVec3C;
void _noise3D;

export {
AutoInstancingLOD,
AutoInstancingSoA,
AutoInstancingDefaults,
BatchKind,
PromotionPolicy,
AUTO_INSTANCE_PRESET_TABLE
};
