
// file number : 008
// full path name : src/objects/008_Skeleton.js
// description : A Skeleton manages the bone hierarchy and per-bone inverse matrices used by SkinnedMesh to deform geometry on the GPU. This rewrite is fully integrated with the interconnected LOD stack (007_0 through 007_16) and tuned for Android 64-bit real-time performance. Android tier, frame index, bone budget, freeze state, and determinism seeds are all read from the LOD stack instead of being duplicated. Bone matrix packing uses gl-matrix on raw typed arrays with zero allocation, the bone texture update path is dirty-flag driven, partial pose mode is enforced on LOW and MID tiers, and cold-frozen skeletons are fully quiesced. Sway is driven by DeterminismSeedLOD.sampleGlobal so it is replay-safe across Adreno 5xx–7xx and Mali-G5x–G7xx, and telemetry is aggregated into TelemetryBudgetHUDLOD instead of a parallel stats table.
// best for : Android 64-bit real-time skeletal animation, GPU bone textures, dense NPC crowds, procedural sway under determinism, freeze / wake-integrated skinned meshes, streaming-cache-backed bone textures, deterministic replay of skeletal motion.
// license : MIT

import { Bone } from './001_Bone.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Quaternion } from '../math/007_Quaternion.js';
import { DataTexture } from '../textures/001_DataTexture.js';
import { Texture } from '../textures/000_Texture.js';

import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';
import { SkinningCostMultiplierLOD } from './007_12_SkinningCostMultiplier_LOD.js';
import { FreezeWakeLOD, FreezeState } from './007_16_FreezeWake_LOD.js';
import { TelemetryBudgetHUDLOD } from './007_10_TelemetryBudgetHUD_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _noise3D = createNoise3D();

// ─── ECS world + Skeleton SoA component ─────────────────────────────────────
const _skeletonWorld = createWorld();

const SkeletonSoA = defineComponent( {
    skeletonId: Types.i32,
    skeletonUuidHash: Types.i32,

    boneCount: Types.i32,
    boneBudget: Types.i32,
    boneBudgetUtilization: Types.f64,
    partialPoseActive: Types.ui8,

    boneTextureWidth: Types.i32,
    boneTextureHeight: Types.i32,
    boneTextureSize: Types.i32,

    inversesDirty: Types.ui8,
    inverseFrame: Types.i32,
    poseFrame: Types.i32,
    lastUpdateFrame: Types.i32,
    textureDirty: Types.ui8,

    swayEnabled: Types.ui8,
    swayAmplitude: Types.f64,
    swayFrequency: Types.f64,
    swayPhase: Types.f64,

    lastUpdateMs: Types.f64,
    avgUpdateMsEMA: Types.f64,
    maxUpdateMs: Types.f64,

    androidTier: Types.i32,
    isMobile64: Types.ui8,

    freezeState: Types.i32,
    frozenSkipCount: Types.i64,
    frozenSkipFramesSaved: Types.i64,

    telemetryRegistered: Types.ui8,
    streamingRegistered: Types.ui8,

    initialized: Types.ui8,
    enabled: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Real-time tunables ─────────────────────────────────────────────────────
const SkeletonDefaults = {
    // Use a DataTexture for bone matrices (WebGL1 / WebGL2 bone texture path).
    useBoneTexture: true,

    // Auto-compute inverses at construction.
    autoCalculateInverses: true,

    // Enforce the per-tier bone budget from SkinningCostMultiplierLOD.
    enforceBoneBudget: true,

    // Allow partial pose when over budget (LOW / MID tiers).
    allowPartialPose: true,

    // Update the bone texture every frame when sway is active.
    updateTextureWhenSwaying: true,

    // Skip texture upload when the bone matrices did not change.
    skipTextureWhenClean: true,

    // Sway defaults (overridden by the Android tier preset).
    swayAmplitude: 0.005,
    swayFrequency: 1.2,
    swayPhase: 0.0,

    // Global hard cap on bone count.
    globalMaxBones: 256,

    // Whether to register with the telemetry HUD by default.
    registerWithTelemetry: true,

    // Whether to register the bone texture with the streaming cache.
    registerWithStreaming: false,

    // Whether to allow the LOD freeze / wake layer to quiesce this skeleton.
    respectFreezeState: true,

    // Cache TTL in frames for the bone texture (when not swaying).
    textureCacheTTL: 4,

    // Deterministic seed base for non-sway jitter.
    determinismSeed: 0x27D4EB2F,

    // Whether to emit events for pose / update / sway.
    emitEvents: false
};

/**
 * Skeleton
 *
 * Represents a hierarchy of Bones used by a SkinnedMesh.
 *
 * ```js
 * const bones = [];
 * const shoulder = new Bone();
 * const forearm = new Bone();
 * shoulder.add( forearm );
 * bones.push( shoulder );
 * bones.push( forearm );
 *
 * const skeleton = new Skeleton( bones );
```

· 
· Real-time integration with the LOD stack:
· · Android tier and bone budget come from SkinningCostMultiplierLOD.
· · Frame index comes from DeterminismSeedLOD.
· · Sway is driven by DeterminismSeedLOD.sampleGlobal( SeedStream.SKINNING ).
· · Update is skipped when the owning LOD is in HARD_FROZEN or COLD_FROZEN.
· · Telemetry is aggregated into TelemetryBudgetHUDLOD.
· · Bone texture updates are dirty-flag driven.
· · Partial pose mode is enforced on LOW / MID tiers.
· 
· The public three.js-compatible API is preserved.
  */
  class Skeleton {
  /**
  · Constructs a new skeleton.
  · @param {Array<Bone>} [bones]
  · @param {Array<Matrix4>} [boneInverses]
    */
    constructor( bones = [], boneInverses = [] ) {
    this.isSkeleton = true;
    this.type = 'Skeleton';
    this.uuid = Skeleton._generateUUID();
    this._uuidHash = Skeleton._hashString( this.uuid );
    this.bones = bones.slice( 0 );
    this.boneInverses = boneInverses;
    this.boneMatrices = null;
    this.boneMatricesPrev = null;
    this.boneTexture = null;
    this.boneTextureSize = 0;
    // ─── Integration state ──────────────────────────────────────────────
    this.ownerLod = null;
    this._telemetryRegistered = false;
    this._streamingRegistered = false;
    // ─── Sway state (values read from tier preset) ──────────────────────
    this._swayEnabled = false;
    this._swayAmplitude = SkeletonDefaults.swayAmplitude;
    this._swayFrequency = SkeletonDefaults.swayFrequency;
    this._swayPhase = SkeletonDefaults.swayPhase;
    // ─── Perf telemetry ─────────────────────────────────────────────────
    this._lastUpdateMs = 0.0;
    this._avgUpdateMsEMA = 0.0;
    this._maxUpdateMs = 0.0;
    // ─── Frame / cache state ────────────────────────────────────────────
    this._lastPoseFrame = - 1;
    this._lastUpdateFrame = - 1;
    this._inverseFrame = - 1;
    this._inversesDirty = true;
    this._textureDirty = true;
    // ─── Freeze stats ───────────────────────────────────────────────────
    this._frozenSkipCount = 0;
    this._frozenSkipFramesSaved = 0;
    // ─── Runtime flags ──────────────────────────────────────────────────
    this._enabled = true;
    // ─── Event listeners ────────────────────────────────────────────────
    this._eventListeners = new Map();
    // ─── ECS ────────────────────────────────────────────────────────────
    this._ecsSkeletonEntity = - 1;
    this._ecsSkeletonRegistered = false;
    // ─── Initialize ─────────────────────────────────────────────────────
    this.init();
    Skeleton._registerSkeleton( this );
    }
  // ─── Public API: three.js-compatible ────────────────────────────────────
  /**
  · Initializes the skeleton. Computes bone inverses if not provided and
  · allocates the flat boneMatrices array.
  · @return {Skeleton}
    */
    init() {
    if ( this.boneInverses.length === 0 && SkeletonDefaults.autoCalculateInverses ) {
    this.calculateInverses();
    } else {
    this._inversesDirty = false;
    }
    const boneCount = this.bones.length;
    if ( this.boneMatrices === null || this.boneMatrices.length !== boneCount * 16 ) {
    this.boneMatrices = new Float32Array( boneCount * 16 );
    this._textureDirty = true;
    }
    if ( this.boneMatricesPrev === null || this.boneMatricesPrev.length !== boneCount * 16 ) {
    this.boneMatricesPrev = new Float32Array( boneCount * 16 );
    }
    if ( SkeletonDefaults.useBoneTexture && boneCount > 0 && this.boneTexture === null ) {
    this.computeBoneTexture();
    }
    this._syncSwayFromTier();
    this.syncSkeletonECS();
    return this;
    }
  /**
  · Computes the bone inverses for the current bind pose.
  · @return {Skeleton}
    */
    calculateInverses() {
    this.boneInverses.length = 0;
    for ( let i = 0, il = this.bones.length; i < il; i ++ ) {
    const inverse = new Matrix4();
    }
    this._inversesDirty = false;
    this._inverseFrame = DeterminismSeedLOD.getFrameIndex();
    this._textureDirty = true;
    this.syncSkeletonECS();
    return this;
    }
  /**
  · Returns the skeleton to the bind pose.
  · @return {Skeleton}
    */
    pose() {
    const bones = this.bones;
    for ( let i = 0, il = bones.length; i < il; i ++ ) {
    const bone = bones[ i ];
    if ( bone === undefined || bone === null ) continue;
    bone.matrixWorld.copy( bone.matrix );
    }
    for ( let i = 0, il = bones.length; i < il; i ++ ) {
    const bone = bones[ i ];
    if ( bone === undefined || bone === null ) continue;
    if ( bone.parent !== null && bone.parent.isBone ) {
    bone.matrixWorld.premultiply( bone.parent.matrixWorld );
    }
    }
    this._lastPoseFrame = DeterminismSeedLOD.getFrameIndex();
    this._textureDirty = true;
    this._emit( 'pose', { skeleton: this } );
    return this;
    }
  /**
  · Updates boneMatrices from the current world matrices and uploads
  · the bone texture if dirty. This is the real-time hot path.
  · 
  · @return {Skeleton}
    */
    update() {
    if ( ! this._enabled ) return this;
    const frameIndex = DeterminismSeedLOD.getFrameIndex();
    // ── 1. Respect freeze / wake from the LOD stack. ────────────────────
    if ( SkeletonDefaults.respectFreezeState && this.ownerLod !== null ) {
    const fs = this.ownerLod.getFreezeState();
    }
    const t0 = Skeleton._nowMs();
    const bones = this.bones;
    const boneInverses = this.boneInverses;
    const boneMatrices = this.boneMatrices;
    const boneCount = bones.length;
    const preset = SkinningCostMultiplierLOD.getCurrentPreset();
    const budget = Math.min( preset.maxAffordableBones, SkeletonDefaults.globalMaxBones );
    const enforceBudget = SkeletonDefaults.enforceBoneBudget && budget > 0;
    const limit = enforceBudget ? Math.min( budget, boneCount ) : boneCount;
    const partial = limit < boneCount;
    // ── 2. Pack bone matrices with gl-matrix on raw typed arrays. ───────
    for ( let i = 0; i < limit; i ++ ) {
    const bone = bones[ i ];
    const inverse = boneInverses[ i ];
    }
    // ── 3. Partial pose: freeze the tail bones at their last value. ─────
    if ( partial && SkeletonDefaults.allowPartialPose && limit > 0 ) {
    const lastOffset = ( limit - 1 ) * 16;
    }
    // ── 4. Upload the bone texture only when needed. ────────────────────
    if ( this.boneTexture !== null ) {
    const shouldUpload = this._textureDirty
    || ( this._swayEnabled && SkeletonDefaults.updateTextureWhenSwaying )
    || ( ( frameIndex - this._lastUpdateFrame ) >= SkeletonDefaults.textureCacheTTL );
    }
    // ── 5. Telemetry. ───────────────────────────────────────────────────
    const t1 = Skeleton._nowMs();
    const dt = t1 - t0;
    this._lastUpdateMs = dt;
    this._avgUpdateMsEMA = this._avgUpdateMsEMA * 0.9 + dt * 0.1;
    if ( dt > this._maxUpdateMs ) this._maxUpdateMs = dt;
    this._lastUpdateFrame = frameIndex;
    this.syncSkeletonECS();
    return this;
    }
  /**
  · Clones this skeleton.
  · @return {Skeleton}
    */
    clone() {
    const bones = this.bones.slice();
    const boneInverses = [];
    for ( let i = 0, il = this.boneInverses.length; i < il; i ++ ) {
    const inverse = this.boneInverses[ i ];
    boneInverses.push( inverse !== undefined ? inverse.clone() : new Matrix4() );
    }
    const skeleton = new Skeleton( bones, boneInverses );
    // Copy sway configuration.
    skeleton._swayEnabled = this._swayEnabled;
    skeleton._swayAmplitude = this._swayAmplitude;
    skeleton._swayFrequency = this._swayFrequency;
    skeleton._swayPhase = this._swayPhase;
    skeleton.ownerLod = this.ownerLod;
    return skeleton;
    }
  /**
  · Computes the bone texture dimensions and allocates the texture.
  · @return {Skeleton}
    */
    computeBoneTexture() {
    const preset = SkinningCostMultiplierLOD.getCurrentPreset();
    const budget = Math.min( preset.maxAffordableBones, SkeletonDefaults.globalMaxBones );
    const boneCount = Math.min( this.bones.length, budget );
    let size = Math.sqrt( boneCount * 4 );
    size = Math.ceil( size / 4 ) * 4;
    size = Math.max( 4, Math.min( size, SkeletonDefaults.globalMaxBones ) );
    this.boneTextureSize = size * 4;
    const requiredLength = size * size * 4;
    if ( this.boneMatrices === null || this.boneMatrices.length !== requiredLength ) {
    const oldMatrices = this.boneMatrices;
    this.boneMatrices = new Float32Array( requiredLength );
    }
    if ( this.boneTexture === null ) {
    this.boneTexture = new DataTexture(
    this.boneMatrices,
    size,
    size,
    Skeleton._getTextureFormat(),
    Skeleton._getTextureType()
    );
    this.boneTexture.internalFormat = 'RGBA32F';
    this.boneTexture.needsUpdate = true;
    } else {
    this.boneTexture.image.data = this.boneMatrices;
    this.boneTexture.image.width = size;
    this.boneTexture.image.height = size;
    this.boneTexture.needsUpdate = true;
    }
    this._textureDirty = true;
    this.syncSkeletonECS();
    return this;
    }
  /**
  · Returns the bone with the given name, or undefined.
  · @param {string} name
  · @return {Bone|undefined}
    */
    getBoneByName( name ) {
    const bones = this.bones;
    for ( let i = 0, il = bones.length; i < il; i ++ ) {
    const bone = bones[ i ];
    if ( bone !== undefined && bone !== null && bone.name === name ) {
    return bone;
    }
    }
    return undefined;
    }
  /**
  · Frees GPU resources held by the bone texture.
    */
    dispose() {
    if ( this.boneTexture !== null ) {
    this.boneTexture.dispose();
    this.boneTexture = null;
    }
    if ( this._telemetryRegistered ) {
    TelemetryBudgetHUDLOD._unregisterTelemetryLOD( this );
    this._telemetryRegistered = false;
    }
    Skeleton._unregisterSkeleton( this );
    }
  /**
  · Serializes the skeleton to JSON.
  · @param {object} meta
  · @return {object}
    */
    toJSON( meta ) {
    const bones = this.bones;
    const boneInverses = this.boneInverses;
    const bonesData = [];
    const boneInversesData = [];
    for ( let i = 0, il = bones.length; i < il; i ++ ) {
    const bone = bones[ i ];
    }
    return {
    metadata: {
    version: 4.6,
    type: 'Skeleton',
    generator: 'Skeleton.toJSON'
    },
    uuid: this.uuid,
    bones: bonesData,
    boneInverses: boneInversesData
    };
    }
  // ─── Public API: procedural sway ────────────────────────────────────────
  /**
  · Enables or disables procedural bone sway.
  · @param {boolean} enabled
  · @param {number} [amplitude]
  · @param {number} [frequency]
  · @param {number} [phase]
  · @return {Skeleton}
    */
    enableSway( enabled, amplitude, frequency, phase ) {
    this._swayEnabled = enabled === true;
    if ( amplitude !== undefined ) this._swayAmplitude = amplitude;
    if ( frequency !== undefined ) this._swayFrequency = frequency;
    if ( phase !== undefined ) this._swayPhase = phase;
    this._textureDirty = true;
    return this;
    }
  /**
  · Applies procedural sway to leaf bones using the shared determinism
  · sampler from 007_15. Sample ids are derived from the bone index, so
  · sway is fully reproducible across frames, devices, and replays.
  · 
  · @param {number} time - Elapsed time in seconds.
  · @return {Skeleton}
    */
    applySway( time ) {
    if ( ! this._swayEnabled ) return this;
    const amplitude = this._swayAmplitude;
    const frequency = this._swayFrequency;
    const phase = this._swayPhase;
    const bones = this.bones;
    const swaySampleBase = ( time * frequency + phase ) * 1024;
    for ( let i = 0, il = bones.length; i < il; i ++ ) {
    const bone = bones[ i ];
    }
    this._textureDirty = true;
    return this;
    }
  // ─── Public API: LOD integration ────────────────────────────────────────
  /**
  · Sets the owning LOD so this skeleton can read freeze / wake state.
  · @param {Object} lod
  · @return {Skeleton}
    */
    setOwnerLod( lod ) {
    this.ownerLod = lod;
    return this;
    }
  /**
  · Registers this skeleton with the telemetry HUD.
  · @return {Skeleton}
    */
    registerWithTelemetry() {
    if ( this._telemetryRegistered ) return this;
    TelemetryBudgetHUDLOD._registerTelemetryLOD( this );
    this._telemetryRegistered = true;
    return this;
    }
  /**
  · Unregisters this skeleton from the telemetry HUD.
  · @return {Skeleton}
    */
    unregisterFromTelemetry() {
    if ( ! this._telemetryRegistered ) return this;
    TelemetryBudgetHUDLOD._unregisterTelemetryLOD( this );
    this._telemetryRegistered = false;
    return this;
    }
  /**
  · Returns a real-time ledger for this skeleton.
  · @return {object}
    */
    getSkeletonLedger() {
    const preset = SkinningCostMultiplierLOD.getCurrentPreset();
    const budget = Math.min( preset.maxAffordableBones, SkeletonDefaults.globalMaxBones );
    const boneCount = this.bones.length;
    const utilization = budget > 0 ? boneCount / budget : 0.0;
    return {
    uuid: this.uuid,
    uuidHash: this._uuidHash,
    boneCount: boneCount,
    boneBudget: budget,
    boneBudgetUtilization: utilization,
    partialPoseActive: boneCount > budget,
    boneTextureSize: this.boneTextureSize,
    swayEnabled: this._swayEnabled,
    swayAmplitude: this._swayAmplitude,
    swayFrequency: this._swayFrequency,
    lastUpdateMs: this._lastUpdateMs,
    avgUpdateMsEMA: this._avgUpdateMsEMA,
    maxUpdateMs: this._maxUpdateMs,
    frozenSkipCount: this._frozenSkipCount,
    frozenSkipFramesSaved: this._frozenSkipFramesSaved,
    androidTier: SkinningCostMultiplierLOD.getAndroidTier(),
    isMobile64: SkinningCostMultiplierLOD.isAndroid64()
    };
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
  if ( ! SkeletonDefaults.emitEvents ) return;
  const set = this._eventListeners.get( eventType );
  if ( set === undefined ) return;
  for ( const cb of set ) {
  try { cb( payload ); } catch ( e ) { void e; }
  }
  }
  // ─── Internal ───────────────────────────────────────────────────────────
  _uploadBoneTexture() {
  if ( this.boneTexture === null ) return;
  if ( this.boneTexture.image === undefined || this.boneTexture.image === null ) return;
  }
  _syncSwayFromTier() {
  const preset = SkinningCostMultiplierLOD.getCurrentPreset();
  }
  // ─── Static: frame lifecycle ────────────────────────────────────────────
  /**
  · Called once per frame by the host. Syncs sway config from the current
  · Android tier so that a mid-session tier change is picked up.
  · 
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    const tier = SkinningCostMultiplierLOD.getAndroidTier();
    for ( const sk of Skeleton._registeredSkeletons ) {
    if ( sk._lastUpdateFrame === frameIndex ) continue;
    sk._syncSwayFromTier();
    sk._androidTier = tier;
    }
    }
  // ─── Static: telemetry ──────────────────────────────────────────────────
  /**
  · Returns a scene-wide summary of skeleton activity, compatible with
  · the TelemetryBudgetHUDLOD aggregation.
  · @return {object}
    */
    static getAggregatedStats() {
    let totalSkeletons = 0;
    let totalBones = 0;
    let totalUpdateMs = 0.0;
    let maxUpdateMs = 0.0;
    let budgetViolations = 0;
    let frozenSkeletons = 0;
    const preset = SkinningCostMultiplierLOD.getCurrentPreset();
    const globalBudget = Math.min( preset.maxAffordableBones, SkeletonDefaults.globalMaxBones );
    for ( const sk of Skeleton._registeredSkeletons ) {
    totalSkeletons ++;
    totalBones += sk.bones.length;
    totalUpdateMs += sk._avgUpdateMsEMA;
    if ( sk._maxUpdateMs > maxUpdateMs ) maxUpdateMs = sk._maxUpdateMs;
    if ( sk.bones.length > globalBudget ) budgetViolations ++;
    }
    const total = new Double( totalUpdateMs );
    return {
    totalSkeletons: totalSkeletons,
    totalBones: totalBones,
    frozenSkeletons: frozenSkeletons,
    avgUpdateMs: totalSkeletons > 0 ? total.valueOf() / totalSkeletons : 0.0,
    maxUpdateMs: maxUpdateMs,
    budgetViolations: budgetViolations,
    androidTier: SkinningCostMultiplierLOD.getAndroidTier()
    };
    }
  // ─── Static: helpers ────────────────────────────────────────────────────
  static _getTextureFormat() {
  return 1023; // THREE.RGBAFormat
  }
  static _getTextureType() {
  return 1015; // THREE.FloatType
  }
  static _generateUUID() {
  const rnd = () => Math.floor( Math.random() * 0xFFFFFFFF );
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
  static _registerSkeleton( skeleton ) {
  Skeleton._registeredSkeletons.add( skeleton );
  }
  static _unregisterSkeleton( skeleton ) {
  Skeleton._registeredSkeletons.delete( skeleton );
  }
  /**
  · Returns the shared ECS world.
  · @return {object}
    */
    static getECSWorld() {
    return _skeletonWorld;
    }
  /**
  · Returns the SkeletonSoA component.
  · @return {object}
    */
    static getSkeletonSoA() {
    return SkeletonSoA;
    }
  /**
  · Returns the SkeletonDefaults.
  · @return {object}
    */
    static get SkeletonDefaults() {
    return SkeletonDefaults;
    }
  // ─── ECS registration ───────────────────────────────────────────────────
  registerSkeletonECS() {
  if ( this._ecsSkeletonRegistered ) {
  return this._ecsSkeletonEntity;
  }
  }
  syncSkeletonECS() {
  if ( ! this._ecsSkeletonRegistered ) return this;
  }
  pullSkeletonECS() {
  if ( ! this._ecsSkeletonRegistered ) return this;
  }
  // ─── gl-matrix / double.js / simplex-noise utilities ────────────────────
  /**
  · High-precision decomposition of a bone inverse matrix using double.js.
  · @param {number} boneIndex
  · @return {{x:number, y:number, z:number}}
    */
    decomposeBoneInverseHighPrecision( boneIndex ) {
    const inverse = this.boneInverses[ boneIndex ];
    if ( inverse === undefined ) return { x: 0, y: 0, z: 0 };
    const e = inverse.elements;
    const tx = new Double( e[ 12 ] );
    const ty = new Double( e[ 13 ] );
    const tz = new Double( e[ 14 ] );
    return {
    x: tx.valueOf(),
    y: ty.valueOf(),
    z: tz.valueOf()
    };
    }
  /**
  · Returns a deterministic sway sample for the given bone index using
  · the shared determinism source from 007_15.
  · @param {number} boneIndex
  · @param {number} time
  · @return {number}
    */
    computeSwaySample( boneIndex, time ) {
    const sampleId = ( ( time * this._swayFrequency + this._swayPhase ) * 1024 + boneIndex ) | 0;
    return DeterminismSeedLOD.sampleGlobal( SeedStream.SKINNING, sampleId );
    }
  /**
  · Packs a bone matrix into a Float64Array using gl-matrix conventions.
  · @param {number} boneIndex
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packBoneMatrix( boneIndex, out ) {
    const v = out || _scratchMat4;
    const offset = boneIndex * 16;
    v[ 0 ] = this.boneMatrices[ offset + 0 ];
    v[ 1 ] = this.boneMatrices[ offset + 1 ];
    v[ 2 ] = this.boneMatrices[ offset + 2 ];
    v[ 3 ] = this.boneMatrices[ offset + 3 ];
    v[ 4 ] = this.boneMatrices[ offset + 4 ];
    v[ 5 ] = this.boneMatrices[ offset + 5 ];
    v[ 6 ] = this.boneMatrices[ offset + 6 ];
    v[ 7 ] = this.boneMatrices[ offset + 7 ];
    v[ 8 ] = this.boneMatrices[ offset + 8 ];
    v[ 9 ] = this.boneMatrices[ offset + 9 ];
    v[ 10 ] = this.boneMatrices[ offset + 10 ];
    v[ 11 ] = this.boneMatrices[ offset + 11 ];
    v[ 12 ] = this.boneMatrices[ offset + 12 ];
    v[ 13 ] = this.boneMatrices[ offset + 13 ];
    v[ 14 ] = this.boneMatrices[ offset + 14 ];
    v[ 15 ] = this.boneMatrices[ offset + 15 ];
    return v;
    }
  packHeaderVec4( out ) {
  const v = out || _scratchVec4;
  glMatrix.vec4.set(
  v,
  this.bones.length,
  this._avgUpdateMsEMA,
  this._swayEnabled ? 1 : 0,
  SkinningCostMultiplierLOD.getAndroidTier()
  );
  return v;
  }
  /**
  · Packs skeleton telemetry into a vec4 for GPU debug rendering.
  · Layout: (boneCount, avgUpdateMs, swayEnabled, frozenSkipCount)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packSkeletonVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this.bones.length,
    this._avgUpdateMsEMA,
    this._swayEnabled ? 1 : 0,
    this._frozenSkipCount
    );
    return v;
    }
  /**
  · Returns the Skeleton UUID hash.
  · @return {number}
    */
    getUuidHash() {
    return this._uuidHash;
    }
    }

// ─── Static skeleton storage (module-scoped, shared across instances) ───────
Skeleton._registeredSkeletons = new Set();

void Bone;
void Vector3;
void Quaternion;
void Texture;
void _scratchVec3A;
void _noise3D;

export { Skeleton, SkeletonSoA, SkeletonDefaults };
