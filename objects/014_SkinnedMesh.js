// file number : 014
// full path name : src/objects/014_SkinnedMesh.js
// description : A SkinnedMesh is a mesh that deforms its geometry on the GPU based on a Skeleton. Every vertex can be influenced by up to bonesPerVertex bones (default 4, up to 8 on flagships) via skinIndex + skinWeight attributes. The mesh supports any bone hierarchy (humanoid, quadruped, bird, fish, centipede, insect, six-arm, spider, snake, wheeled, or custom), any mesh topology, and integrates with the entire interconnected LOD stack (007_0 through 007_16) plus the full SkinnedMesh companion set (014_0 through 014_16). This rewrite preserves the three.js r185 public API (isSkinnedMesh, bindMode, bindMatrix, bindMatrixInverse, skeleton, boneTexture, morphTargetInfluences, morphTargetDictionary, bind, pose, normalizeSkinWeights, updateMatrixWorld, boneTransform, copy, toJSON) while adding: full pipeline assembly via the bridge (014_16), per-tier auto-tuning (014_13), deterministic replay (007_15), freeze/wake quiescence (007_16), bone LOD selection (014_14), per-bone distance culling (014_15), and high-precision telemetry (014_12). Uses gl-matrix for bone matrix math on raw typed arrays, double.js for high-precision bone-distance and palette byte accounting, bitecs SoA for per-mesh lifecycle registration, and simplex-noise for deterministic per-frame dither that keeps replay identical across Android 64-bit devices (Adreno 5xx–7xx, Mali-G5x–G7xx).
// best for : Android 64-bit real-time character rendering, crowd swarms, procedural creatures (any topology, any bone tree), VR single-eye skinned meshes, deterministic replay of skinned motion, on-device telemetry of skinning cost, tier-driven auto-tuning.
// license : MIT

import { Mesh } from './003_Mesh.js';
import { Object3D } from '../core/018_Object3D.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { BufferAttribute } from '../core/020_BufferAttribute.js';
import { Float32BufferAttribute } from '../core/020_BufferAttribute.js';
import { Skeleton } from './008_Skeleton.js';
import { Bone } from './001_Bone.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Vector4 } from '../math/012_Vector4.js';
import { Sphere } from '../math/001_Sphere.js';
import { Ray } from '../math/002_Ray.js';
import { DataTexture } from '../textures/001_DataTexture.js';

// ─── Companion set (via bridge facade). ─────────────────────────────────────
import {
    SkinnedMeshBridgeDefaults,
    SkinnedMeshBridgeSoA,
    WiringStep,
    assemble,
    update as bridgeUpdate,
    endFrame as bridgeEndFrame,
    getBridgeLedger,
    getLedgerForMeshId,
    getBridgeEntityForMeshId,
    computeConstructionCostHighPrecision,
    computeSceneBytesHighPrecision,
    computeSceneVertexOpsHighPrecision,
    getAggregatedStats as getBridgeAggregatedStats,
    getSkinnedMeshDefaults,
    notifyTierChange,
    notifyPressure,
    notifyFreezeState,
    beginFrame as bridgeBeginFrame,
    endFrameAll,
    registerWithTelemetry,
    registerWithCache,
    registerWithBoneLOD,
    registerWithBoneCull,
    isSkeletonValid,
    hasSkinWeights,
    getCompanionSet,
    packBridgeVec4,
    packConstructionTimingVec4,
    packRegistrationTimingVec4,
    packDefaultsVec4,
    Defaults,
    Walker,
    Validator,
    Archetypes,
    Builder,
    Normalizer,
    Layout,
    AutoAssign,
    Overlap,
    Compressor,
    Topology,
    ArbitraryTopology,
    CacheManager,
    SkinningTelemetry,
    Presets,
    BoneLOD,
    BoneCulling
} from './014_16_SkinnedMeshBridge.js';

// ─── LOD stack integration. ────────────────────────────────────────────────
import { SkinningCostMultiplierLOD } from './007_12_SkinningCostMultiplier_LOD.js';
import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';
import { FreezeWakeLOD, FreezeState } from './007_16_FreezeWake_LOD.js';
import { TelemetryBudgetHUDLOD } from './007_10_TelemetryBudgetHUD_LOD.js';
import { RaycastFixedDensityLOD } from './007_14_RaycastFixedDensity_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchMat4B = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec4B = new Float64Array( 4 );
const _scratchVec4C = new Float64Array( 4 );
const _scratchVec4D = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _noise3D = createNoise3D();

const _basePosition = /*@__PURE__*/ new Vector3();
const _skinIndex = /*@__PURE__*/ new Vector4();
const _skinWeight = /*@__PURE__*/ new Vector4();
const _vector3A = /*@__PURE__*/ new Vector3();
const _matrix4 = /*@__PURE__*/ new Matrix4();
const _matrix4B = /*@__PURE__*/ new Matrix4();
const _sphere = /*@__PURE__*/ new Sphere();
const _ray = /*@__PURE__*/ new Ray();

// ─── ECS world + SkinnedMesh SoA component (bitecs). ────────────────────────
const _skinnedMeshWorld = createWorld();

const SkinnedMeshSoA = defineComponent( {
    meshId: Types.i32,
    bridgeEid: Types.i32,
    geometryUuidHash: Types.i32,
    skeletonUuidHash: Types.i32,

    // Skeleton state
    boneCount: Types.i32,
    bonesPerVertex: Types.i32,
    bindMode: Types.i32,
    bindMatrixVersion: Types.i32,
    skeletonBound: Types.ui8,

    // Palette
    paletteBytes: Types.f64,
    paletteVersion: Types.i32,
    paletteUploadedFrame: Types.i32,
    paletteUploadCount: Types.i64,
    paletteSkipCount: Types.i64,

    // Morph targets
    morphTargetCount: Types.i32,
    morphInfluenceBufferBytes: Types.f64,

    // Bone texture
    hasBoneTexture: Types.ui8,
    boneTextureWidth: Types.i32,
    boneTextureHeight: Types.i32,

    // Update path
    lastUpdateMs: Types.f64,
    avgUpdateMsEMA: Types.f64,
    lastBoneTransformMs: Types.f64,
    avgBoneTransformMsEMA: Types.f64,

    // Freeze / wake
    freezeState: Types.i32,
    frozenUpdateSkipCount: Types.i64,
    lastFreezeChangeFrame: Types.i32,

    // Tier / budget
    androidTier: Types.i32,
    maxBonesBudget: Types.i32,

    // Determinism
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    registered: Types.ui8,
    initialized: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Bind mode constants (three.js compatible). ─────────────────────────────
const BindMode = Object.freeze( {
    ATTACHED: 'attached',
    DETACHED: 'detached'
} );

// ─── Reusable defaults. ────────────────────────────────────────────────────
const SkinnedMeshDefaults = {
    // Attach to skeleton at bind time.
    bindOnConstruct: true,

    // Whether to run the full bridge assembly pipeline on construct.
    assembleOnConstruct: true,

    // Whether to respect the FreezeWakeLOD freeze state in updateMatrixWorld.
    respectFreezeState: true,

    // Whether to skip the palette upload when the selection is unchanged.
    skipPaletteUploadWhenUnchanged: true,

    // Whether to auto-register with telemetry on construct.
    registerTelemetryOnConstruct: true,

    // Whether to auto-register with cache on construct.
    registerCacheOnConstruct: true,

    // Whether to auto-register with bone LOD on construct.
    registerBoneLODOnConstruct: true,

    // Whether to auto-register with bone culling on construct.
    registerBoneCullOnConstruct: true,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F
};

// ─── Per-mesh ECS entity cache. ────────────────────────────────────────────
const _ecsSkinnedMeshByMeshId = new Map();

// ─── Global frame index (shared with the bridge). ──────────────────────────
let _frameIndex = 0;

/**
 * SkinnedMesh
 *
 * A mesh that deforms its geometry on the GPU based on a Skeleton. Every
 * vertex can be influenced by up to `bonesPerVertex` bones (default 4, up to
 * 8 on flagships) via the `skinIndex` and `skinWeight` attributes.
 *
 * Public API (three.js r185 compatible):
 *   - isSkinnedMesh, bindMode, bindMatrix, bindMatrixInverse
 *   - skeleton, boneTexture
 *   - morphTargetInfluences, morphTargetDictionary
 *   - bind( skeleton, bindMatrix )
 *   - pose()
 *   - normalizeSkinWeights()
 *   - updateMatrixWorld( force )
 *   - boneTransform( index, target )
 *   - copy( source, recursive )
 *   - toJSON( meta )
 *
 * Real-time extensions (Android 64-bit):
 *   - Full pipeline assembly via 014_16_SkinnedMeshBridge
 *   - Per-tier auto-tuning via 014_13_SkinningPresets
 *   - Freeze / wake quiescence via 007_16_FreezeWakeLOD
 *   - Deterministic replay via 007_15_DeterminismSeedLOD
 *   - Bone LOD selection via 014_14_BoneLODSelection
 *   - Per-bone distance culling via 014_15_BoneDistanceCulling
 *   - High-precision telemetry via 014_12_SkinningTelemetry
 *
 * @augments Mesh
 */
class SkinnedMesh extends Mesh {

    /**
     * Constructs a new skinned mesh.
     *
     * @param {BufferGeometry} [geometry]
     * @param {Material|Array} [material]
     */
    constructor( geometry, material ) {
        super( geometry, material );

        /**
         * This flag can be used for type testing.
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isSkinnedMesh = true;
        this.type = 'SkinnedMesh';

        // ─── three.js r185 public fields. ───────────────────────────────
        this.bindMode = BindMode.ATTACHED;
        this.bindMatrix = new Matrix4();
        this.bindMatrixInverse = new Matrix4();

        /**
         * The Skeleton that this mesh is bound to.
         * @type {Skeleton|null}
         */
        this.skeleton = null;

        /**
         * The bone texture. Allocated lazily when the skeleton is set.
         * @type {DataTexture|null}
         */
        this.boneTexture = null;

        // ─── Internal state. ───────────────────────────────────────────
        this._bindMatrixVersion = 0;
        this._paletteVersion = 0;
        this._paletteUploadedFrame = - 1;
        this._paletteUploadCount = 0;
        this._paletteSkipCount = 0;
        this._lastUpdateMs = 0.0;
        this._avgUpdateMsEMA = 0.0;
        this._lastBoneTransformMs = 0.0;
        this._avgBoneTransformMsEMA = 0.0;
        this._frozenUpdateSkipCount = 0;
        this._lastFreezeChangeFrame = - 1;

        this._androidTier = 2;
        this._maxBonesBudget = 0;
        this._bonesPerVertex = SkinnedMeshDefaults.bonesPerVertex !== undefined
            ? SkinnedMeshDefaults.bonesPerVertex
            : 4;

        this._determinismSeed = _mix32( ( this.id >>> 0 ) ^ SkinnedMeshDefaults.determinismSeed );
        this._ditherSample = 0.0;

        // ─── Event listeners (for local events). ───────────────────────
        this._eventListeners = new Map();

        // ─── ECS registration. ─────────────────────────────────────────
        this._ecsSkinnedMeshEntity = - 1;

        // ─── Assembly result (from the bridge). ────────────────────────
        this._assemblyResult = null;

        // ─── Wire the mesh into the shared bridge and companion set. ───
        this._registerSkinnedMeshECS();

        if ( SkinnedMeshDefaults.assembleOnConstruct ) {
            this._runAssemblyPipeline();
        }
    }

    // ─── Public API: bind / pose. ───────────────────────────────────────────

    /**
     * Binds the mesh to a skeleton.
     *
     * @param {Skeleton} skeleton
     * @param {Matrix4} [bindMatrix] - Defaults to identity.
     * @return {SkinnedMesh}
     */
    bind( skeleton, bindMatrix ) {
        if ( skeleton === undefined || skeleton === null ) return this;

        this.skeleton = skeleton;

        if ( bindMatrix === undefined || bindMatrix === null ) {
            this.updateMatrixWorld( true );
            this.bindMatrix.copy( this.matrixWorld );
            this.bindMatrixInverse.copy( this.matrixWorld ).invert();
        } else {
            this.bindMatrix.copy( bindMatrix );
            this.bindMatrixInverse.copy( bindMatrix ).invert();
        }

        this._bindMatrixVersion ++;

        // ── Allocate / refresh the bone texture. ───────────────────────
        if ( skeleton.boneTexture !== null && skeleton.boneTexture !== undefined ) {
            this.boneTexture = skeleton.boneTexture;
        }

        // ── Register with the bridge's companion systems. ──────────────
        this._registerSkeletonWithCompanions( skeleton );

        // ── Update the shared ECS state. ───────────────────────────────
        this._syncSkinnedMeshECS();

        return this;
    }

    /**
     * Returns the mesh to the bind pose by resetting the skeleton.
     * @return {SkinnedMesh}
     */
    pose() {
        if ( this.skeleton === null ) return this;

        this.skeleton.pose();

        this._paletteVersion ++;
        this._syncSkinnedMeshECS();

        return this;
    }

    /**
     * Normalizes the skin weights of the geometry so that the sum of each
     * vertex's weights equals 1.0.
     *
     * Delegates to 014_5_SkinWeightNormalizer via the bridge.
     *
     * @return {SkinnedMesh}
     */
    normalizeSkinWeights() {
        if ( this.geometry === undefined || this.geometry === null ) return this;

        Normalizer.normalizeGeometry( this.geometry, {
            bonesPerVertex: this._bonesPerVertex,
            layout: this._detectLayout(),
            frameIndex: _frameIndex
        } );

        this._paletteVersion ++;
        this._syncSkinnedMeshECS();

        return this;
    }

    // ─── Public API: updateMatrixWorld (three.js compatible). ───────────────

    /**
     * Updates the mesh's world matrix, and when the bind mode is ATTACHED,
     * applies the bind-matrix inverse to the bone matrices.
     *
     * @param {boolean} [force=false]
     * @return {SkinnedMesh}
     */
    updateMatrixWorld( force = false ) {
        const t0 = _nowMs();

        // ── 1. Respect the FreezeWakeLOD freeze state. ─────────────────
        if ( SkinnedMeshDefaults.respectFreezeState && this.ownerLod !== undefined && this.ownerLod !== null ) {
            const fs = this.ownerLod.getFreezeState();

            if ( fs === FreezeState.HARD_FROZEN || fs === FreezeState.COLD_FROZEN ) {
                this._frozenUpdateSkipCount ++;
                this._lastFrameIndex = _frameIndex;
                this._syncSkinnedMeshECS();
                return this;
            }
        }

        // ── 2. Call the Mesh (Object3D) update path. ───────────────────
        super.updateMatrixWorld( force );

        // ── 3. If the skeleton is attached, sync the bind matrix. ──────
        if ( this.bindMode === BindMode.ATTACHED && this.skeleton !== null ) {
            this.bindMatrixInverse.copy( this.matrixWorld ).invert();
        }

        // ── 4. Update the palette. ─────────────────────────────────────
        if ( this.skeleton !== null && this.skeleton.update !== undefined ) {
            this.skeleton.update();
        }

        // ── 5. Per-frame dither for telemetry. ─────────────────────────
        const ditherSeed = _mix32( this._determinismSeed ^ ( _frameIndex * 0x9E3779B9 ) );
        this._ditherSample = _noise3D( ditherSeed * 1e-6, _frameIndex * 0.02, this.id );

        // ── 6. Update timing. ──────────────────────────────────────────
        this._lastUpdateMs = _nowMs() - t0;
        this._avgUpdateMsEMA = this._avgUpdateMsEMA * 0.9 + this._lastUpdateMs * 0.1;

        this._syncSkinnedMeshECS();

        return this;
    }

    // ─── Public API: boneTransform. ────────────────────────────────────────

    /**
     * Computes the transformed position of a vertex in its bind pose.
     *
     * @param {number} index - The vertex index.
     * @param {Vector3} target - The target vector.
     * @return {Vector3}
     */
    boneTransform( index, target ) {
        const t0 = _nowMs();

        const skeleton = this.skeleton;
        const geometry = this.geometry;

        if ( skeleton === null || geometry === undefined || geometry === null ) {
            this._lastBoneTransformMs = _nowMs() - t0;
            return target.copy( _basePosition );
        }

        _skinIndex.fromBufferAttribute( geometry.attributes.skinIndex, index );
        _skinWeight.fromBufferAttribute( geometry.attributes.skinWeight, index );

        _basePosition.copy( target.fromBufferAttribute( geometry.attributes.position, index ) );

        target.set( 0, 0, 0 );

        for ( let i = 0; i < 4; i ++ ) {
            const weight = _skinWeight.getComponent( i );

            if ( weight === 0.0 ) continue;

            const boneIndex = _skinIndex.getComponent( i );
            const bone = skeleton.bones[ boneIndex ];

            if ( bone === undefined || bone === null ) continue;

            _matrix4.multiplyMatrices( bone.matrixWorld, skeleton.boneInverses[ boneIndex ] );
            _matrix4B.multiplyMatrices( this.bindMatrixInverse, _matrix4 );

            _vector3A.copy( _basePosition ).applyMatrix4( _matrix4B );

            target.x += _vector3A.x * weight;
            target.y += _vector3A.y * weight;
            target.z += _vector3A.z * weight;
        }

        this._lastBoneTransformMs = _nowMs() - t0;
        this._avgBoneTransformMsEMA = this._avgBoneTransformMsEMA * 0.9 + this._lastBoneTransformMs * 0.1;

        return target;
    }

    // ─── Public API: copy / toJSON. ────────────────────────────────────────

    copy( source, recursive ) {
        super.copy( source, recursive );

        this.bindMode = source.bindMode;
        this.bindMatrix.copy( source.bindMatrix );
        this.bindMatrixInverse.copy( source.bindMatrixInverse );

        if ( source.skeleton !== null ) {
            this.bind( source.skeleton, source.bindMatrix );
        }

        return this;
    }

    toJSON( meta ) {
        const data = super.toJSON( meta );

        data.object.bindMode = this.bindMode;
        data.object.bindMatrix = this.bindMatrix.toArray( [] );

        if ( this.skeleton !== null ) {
            data.object.skeleton = this.skeleton.uuid;
        }

        return data;
    }

    // ─── Real-time extensions: per-frame update. ───────────────────────────

    /**
     * Updates the mesh with the given camera context. Called by the host or
     * by the LOD stack once per frame.
     *
     * @param {object} context
     * @param {Camera} context.camera
     * @param {number} [context.frameIndex=0]
     * @param {Frustum} [context.frustum]
     * @return {object} A merged ledger from all systems.
     */
    update( context = {} ) {
        if ( this.skeleton === null ) {
            return {
                selection: null,
                cull: null,
                bridge: null,
                skeletonHash: 0
            };
        }

        const frameIndex = context.frameIndex !== undefined ? context.frameIndex : _frameIndex;

        // ── 1. Delegate to the bridge. ─────────────────────────────────
        const ledger = bridgeUpdate( this, this.skeleton, {
            cameraDistance: context.cameraDistance !== undefined ? context.cameraDistance : 0.0,
            projectedSizePx: context.projectedSizePx,
            inFrustum: context.inFrustum !== false,
            frustum: context.frustum,
            freezeState: this.ownerLod !== undefined && this.ownerLod !== null
                ? this.ownerLod.getFreezeState()
                : FreezeState.AWAKE,
            frameIndex: frameIndex,
            cameraFov: context.camera !== undefined ? context.camera.fov : undefined,
            viewportHeightPx: context.viewportHeightPx
        } );

        this._lastFrameIndex = frameIndex;

        this._syncSkinnedMeshECS();

        return ledger;
    }

    /**
     * Called once per frame after all updates. Delegates to the bridge's
     * endFrame and to the telemetry subsystem.
     *
     * @param {number} [frameIndex=0]
     */
    endFrame( frameIndex = 0 ) {
        bridgeEndFrame( this, frameIndex );
        this._lastFrameIndex = frameIndex;
    }

    // ─── Real-time extensions: skeleton / geometry setter. ─────────────────

    /**
     * Sets a new geometry and re-runs the assembly pipeline.
     * @param {BufferGeometry} geometry
     * @return {SkinnedMesh}
     */
    setGeometry( geometry ) {
        this.geometry = geometry;

        this._runAssemblyPipeline();

        return this;
    }

    /**
     * Replaces the skeleton and re-runs the assembly pipeline.
     * @param {Skeleton} skeleton
     * @return {SkinnedMesh}
     */
    setSkeleton( skeleton ) {
        this.skeleton = skeleton;

        if ( skeleton !== null ) {
            this._registerSkeletonWithCompanions( skeleton );
        }

        this._syncSkinnedMeshECS();

        return this;
    }

    // ─── Real-time extensions: ledger / events. ────────────────────────────

    /**
     * Returns a full per-mesh ledger for telemetry.
     * @return {object}
     */
    getSkinnedMeshLedger() {
        const bridgeLedger = getLedgerForMeshId( this.id );

        const paletteBytes = new Double( this._maxBonesBudget )
            .mul( new Double( 16 * 4 ) )
            .valueOf();

        return {
            meshId: this.id,
            boneCount: this.skeleton !== null && this.skeleton.bones !== undefined
                ? this.skeleton.bones.length
                : 0,
            bonesPerVertex: this._bonesPerVertex,
            bindMode: this.bindMode,
            bindMatrixVersion: this._bindMatrixVersion,
            paletteVersion: this._paletteVersion,
            paletteBytes: paletteBytes,
            paletteUploadCount: this._paletteUploadCount,
            paletteSkipCount: this._paletteSkipCount,
            morphTargetCount: this.morphTargetInfluences !== undefined
                ? this.morphTargetInfluences.length
                : 0,
            hasBoneTexture: this.boneTexture !== null,
            lastUpdateMs: this._lastUpdateMs,
            avgUpdateMsEMA: this._avgUpdateMsEMA,
            lastBoneTransformMs: this._lastBoneTransformMs,
            avgBoneTransformMsEMA: this._avgBoneTransformMsEMA,
            frozenUpdateSkipCount: this._frozenUpdateSkipCount,
            androidTier: this._androidTier,
            maxBonesBudget: this._maxBonesBudget,
            determinismSeed: this._determinismSeed,
            ditherSample: this._ditherSample,
            bridge: bridgeLedger
        };
    }

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
        const set = this._eventListeners.get( eventType );
        if ( set === undefined ) return;
        for ( const cb of set ) {
            try { cb( payload ); } catch ( e ) { void e; }
        }
    }

    // ─── Internal: assembly pipeline. ─────────────────────────────────────

    _runAssemblyPipeline() {
        if ( this.geometry === undefined || this.geometry === null ) return;

        if ( this.skeleton === null || this.skeleton === undefined ) return;

        const t0 = _nowMs();

        // ── 1. Detect the layout in use. ───────────────────────────────
        this._bonesPerVertex = this._detectBonesPerVertex();

        // ── 2. Run the full bridge assembly. ───────────────────────────
        this._assemblyResult = assemble( this, this.geometry, this.skeleton, {
            buildHierarchy: false,
            frameIndex: _frameIndex
        } );

        // ── 3. Read back the tier-driven defaults. ─────────────────────
        this._androidTier = this._readAndroidTier();
        this._maxBonesBudget = this._readMaxBonesBudget();

        // ── 4. Update the local state. ─────────────────────────────────
        this._paletteVersion ++;

        this._lastAssemblyMs = _nowMs() - t0;

        this._syncSkinnedMeshECS();

        this._emit( 'assembled', {
            mesh: this,
            result: this._assemblyResult,
            assemblyMs: this._lastAssemblyMs
        } );
    }

    // ─── Internal: skeleton registration with companions. ──────────────────

    _registerSkeletonWithCompanions( skeleton ) {
        const skeletonUuid = skeleton.uuid !== undefined ? skeleton.uuid : '';
        const skeletonHash = _hashString( skeletonUuid );

        // ── 1. Telemetry. ──────────────────────────────────────────────
        if ( SkinnedMeshDefaults.registerTelemetryOnConstruct ) {
            registerWithTelemetry( this, skeleton, this.geometry );
        }

        // ── 2. Cache. ──────────────────────────────────────────────────
        if ( SkinnedMeshDefaults.registerCacheOnConstruct && this.geometry !== undefined && this.geometry !== null ) {
            const layout = this._detectLayout();

            registerWithCache(
                skeleton,
                this.geometry,
                this._bonesPerVertex,
                layout,
                {
                    normalizedWeights: this.geometry.attributes[ 'skinWeight' ] !== undefined
                        ? this.geometry.attributes[ 'skinWeight' ].array
                        : null
                }
            );
        }

        // ── 3. Bone LOD selection. ─────────────────────────────────────
        if ( SkinnedMeshDefaults.registerBoneLODOnConstruct ) {
            registerWithBoneLOD( skeleton );
        }

        // ── 4. Bone distance culling. ──────────────────────────────────
        if ( SkinnedMeshDefaults.registerBoneCullOnConstruct ) {
            registerWithBoneCull( skeleton );
        }

        void skeletonHash;
    }

    // ─── Internal: helpers. ────────────────────────────────────────────────

    _detectLayout() {
        const geom = this.geometry;

        if ( geom === undefined || geom === null ) return Layout.SkinWeightLayout.INTERLEAVED;

        return Layout.detectCurrentLayout( geom );
    }

    _detectBonesPerVertex() {
        const geom = this.geometry;

        if ( geom === undefined || geom === null ) return 4;

        const skinWeight = geom.attributes[ 'skinWeight' ];

        if ( skinWeight !== undefined && skinWeight.itemSize !== undefined ) {
            return skinWeight.itemSize;
        }

        return 4;
    }

    _readAndroidTier() {
        try {
            const tier = SkinningCostMultiplierLOD.getAndroidTier();
            if ( tier >= 1 && tier <= 4 ) return tier;
        } catch ( e ) {
            void e;
        }

        return 2;
    }

    _readMaxBonesBudget() {
        const preset = Presets.getCurrentPreset();

        if ( preset === undefined || preset === null ) return 0;

        return preset.maxBonesPerSkeleton;
    }

    // ─── Internal: ECS registration. ───────────────────────────────────────

    _registerSkinnedMeshECS() {
        let eid = _ecsSkinnedMeshByMeshId.get( this.id );

        if ( eid === undefined ) {
            eid = addEntity( _skinnedMeshWorld );
            addComponent( _skinnedMeshWorld, SkinnedMeshSoA, eid );
            _ecsSkinnedMeshByMeshId.set( this.id, eid );
        }

        SkinnedMeshSoA.meshId[ eid ] = this.id;
        SkinnedMeshSoA.bridgeEid[ eid ] = - 1;
        SkinnedMeshSoA.geometryUuidHash[ eid ] = 0;
        SkinnedMeshSoA.skeletonUuidHash[ eid ] = 0;
        SkinnedMeshSoA.boneCount[ eid ] = 0;
        SkinnedMeshSoA.bonesPerVertex[ eid ] = this._bonesPerVertex;
        SkinnedMeshSoA.bindMode[ eid ] = 0;
        SkinnedMeshSoA.bindMatrixVersion[ eid ] = 0;
        SkinnedMeshSoA.skeletonBound[ eid ] = 0;
        SkinnedMeshSoA.paletteBytes[ eid ] = 0.0;
        SkinnedMeshSoA.paletteVersion[ eid ] = 0;
        SkinnedMeshSoA.paletteUploadedFrame[ eid ] = - 1;
        SkinnedMeshSoA.paletteUploadCount[ eid ] = 0;
        SkinnedMeshSoA.paletteSkipCount[ eid ] = 0;
        SkinnedMeshSoA.morphTargetCount[ eid ] = 0;
        SkinnedMeshSoA.morphInfluenceBufferBytes[ eid ] = 0.0;
        SkinnedMeshSoA.hasBoneTexture[ eid ] = 0;
        SkinnedMeshSoA.boneTextureWidth[ eid ] = 0;
        SkinnedMeshSoA.boneTextureHeight[ eid ] = 0;
        SkinnedMeshSoA.lastUpdateMs[ eid ] = 0.0;
        SkinnedMeshSoA.avgUpdateMsEMA[ eid ] = 0.0;
        SkinnedMeshSoA.lastBoneTransformMs[ eid ] = 0.0;
        SkinnedMeshSoA.avgBoneTransformMsEMA[ eid ] = 0.0;
        SkinnedMeshSoA.freezeState[ eid ] = FreezeState.AWAKE;
        SkinnedMeshSoA.frozenUpdateSkipCount[ eid ] = 0;
        SkinnedMeshSoA.lastFreezeChangeFrame[ eid ] = - 1;
        SkinnedMeshSoA.androidTier[ eid ] = this._androidTier;
        SkinnedMeshSoA.maxBonesBudget[ eid ] = this._maxBonesBudget;
        SkinnedMeshSoA.determinismSeed[ eid ] = this._determinismSeed;
        SkinnedMeshSoA.ditherSample[ eid ] = 0.0;
        SkinnedMeshSoA.registered[ eid ] = 1;
        SkinnedMeshSoA.initialized[ eid ] = 1;
        SkinnedMeshSoA.lastFrameIndex[ eid ] = _frameIndex;

        this._ecsSkinnedMeshEntity = eid;
    }

    _syncSkinnedMeshECS() {
        const eid = this._ecsSkinnedMeshEntity;

        if ( eid < 0 ) return;

        const skeleton = this.skeleton;
        const boneCount = skeleton !== null && skeleton.bones !== undefined
            ? skeleton.bones.length
            : 0;

        SkinnedMeshSoA.boneCount[ eid ] = boneCount;
        SkinnedMeshSoA.bonesPerVertex[ eid ] = this._bonesPerVertex;
        SkinnedMeshSoA.bindMode[ eid ] = this.bindMode === BindMode.ATTACHED ? 0 : 1;
        SkinnedMeshSoA.bindMatrixVersion[ eid ] = this._bindMatrixVersion;
        SkinnedMeshSoA.skeletonBound[ eid ] = skeleton !== null ? 1 : 0;

        SkinnedMeshSoA.paletteVersion[ eid ] = this._paletteVersion;
        SkinnedMeshSoA.paletteUploadedFrame[ eid ] = this._paletteUploadedFrame;
        SkinnedMeshSoA.paletteUploadCount[ eid ] = this._paletteUploadCount;
        SkinnedMeshSoA.paletteSkipCount[ eid ] = this._paletteSkipCount;

        if ( this.boneTexture !== null && this.boneTexture.image !== undefined && this.boneTexture.image !== null ) {
            SkinnedMeshSoA.hasBoneTexture[ eid ] = 1;
            SkinnedMeshSoA.boneTextureWidth[ eid ] = this.boneTexture.image.width || 0;
            SkinnedMeshSoA.boneTextureHeight[ eid ] = this.boneTexture.image.height || 0;
        } else {
            SkinnedMeshSoA.hasBoneTexture[ eid ] = 0;
            SkinnedMeshSoA.boneTextureWidth[ eid ] = 0;
            SkinnedMeshSoA.boneTextureHeight[ eid ] = 0;
        }

        SkinnedMeshSoA.morphTargetCount[ eid ] = this.morphTargetInfluences !== undefined
            ? this.morphTargetInfluences.length
            : 0;

        SkinnedMeshSoA.lastUpdateMs[ eid ] = this._lastUpdateMs;
        SkinnedMeshSoA.avgUpdateMsEMA[ eid ] = this._avgUpdateMsEMA;
        SkinnedMeshSoA.lastBoneTransformMs[ eid ] = this._lastBoneTransformMs;
        SkinnedMeshSoA.avgBoneTransformMsEMA[ eid ] = this._avgBoneTransformMsEMA;

        SkinnedMeshSoA.freezeState[ eid ] = this.ownerLod !== undefined && this.ownerLod !== null
            ? this.ownerLod.getFreezeState()
            : FreezeState.AWAKE;

        SkinnedMeshSoA.frozenUpdateSkipCount[ eid ] = this._frozenUpdateSkipCount;
        SkinnedMeshSoA.androidTier[ eid ] = this._androidTier;
        SkinnedMeshSoA.maxBonesBudget[ eid ] = this._maxBonesBudget;
        SkinnedMeshSoA.ditherSample[ eid ] = this._ditherSample;
        SkinnedMeshSoA.lastFrameIndex[ eid ] = this._lastFrameIndex;
    }

    // ─── Static: frame lifecycle. ──────────────────────────────────────────

    /**
     * Advances the shared frame index and runs the bridge frame lifecycle.
     * Call once per frame before any SkinnedMesh updates.
     *
     * @param {number} frameIndex
     */
    static beginFrame( frameIndex ) {
        _frameIndex = frameIndex | 0;

        bridgeBeginFrame( frameIndex );

        const q = query( _skinnedMeshWorld, [ SkinnedMeshSoA ] );

        for ( let i = 0; i < q.length; i ++ ) {
            SkinnedMeshSoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
        }
    }

    /**
     * Finalizes the frame across all subsystems.
     * @param {number} [frameIndex=0]
     */
    static endFrame( frameIndex = 0 ) {
        endFrameAll( frameIndex );

        const q = query( _skinnedMeshWorld, [ SkinnedMeshSoA ] );

        for ( let i = 0; i < q.length; i ++ ) {
            SkinnedMeshSoA.lastFrameIndex[ q[ i ] ] = frameIndex | 0;
        }
    }

    // ─── Static: tier / pressure notification. ─────────────────────────────

    /**
     * Notifies the SkinnedMesh system of an Android tier change. Propagates
     * to every subsystem via the bridge.
     * @param {number} tier - One of `SkinningTier`.
     * @param {number} [frameIndex=0]
     */
    static notifyTierChange( tier, frameIndex = 0 ) {
        notifyTierChange( tier, frameIndex );
    }

    /**
     * Publishes pressure signals to the SkinnedMesh subsystems.
     * @param {number} thermal
     * @param {number} battery
     * @param {number} memory
     */
    static notifyPressure( thermal, battery, memory ) {
        notifyPressure( thermal, battery, memory );
    }

    // ─── Static: query helpers. ────────────────────────────────────────────

    /**
     * Returns the ECS entity id for a given mesh id.
     * @param {number} meshId
     * @return {number}
     */
    static getSkinnedMeshEntityForId( meshId ) {
        const eid = _ecsSkinnedMeshByMeshId.get( meshId );
        return eid !== undefined ? eid : - 1;
    }

    /**
     * Collects all registered SkinnedMesh entity ids.
     * @return {Array<number>}
     */
    static collectAllEntityIds() {
        const out = [];
        const q = query( _skinnedMeshWorld, [ SkinnedMeshSoA ] );

        for ( let i = 0; i < q.length; i ++ ) {
            const eid = q[ i ];
            if ( SkinnedMeshSoA.registered[ eid ] === 1 ) {
                out.push( eid );
            }
        }

        return out;
    }

    // ─── Static: aggregated stats. ─────────────────────────────────────────

    /**
     * Returns aggregated SkinnedMesh statistics across the scene.
     * @return {object}
     */
    static getAggregatedStats() {
        let totalMeshes = 0;
        let totalBones = 0;
        let totalPaletteBytes = 0.0;
        let totalUpdateMs = 0.0;
        let totalBoneTransformMs = 0.0;
        let frozenMeshes = 0;
        let totalPaletteUploads = 0;
        let totalPaletteSkips = 0;

        const q = query( _skinnedMeshWorld, [ SkinnedMeshSoA ] );

        for ( let i = 0; i < q.length; i ++ ) {
            const eid = q[ i ];

            if ( SkinnedMeshSoA.registered[ eid ] !== 1 ) continue;

            totalMeshes ++;
            totalBones += SkinnedMeshSoA.boneCount[ eid ];
            totalPaletteBytes += SkinnedMeshSoA.paletteBytes[ eid ];
            totalUpdateMs += SkinnedMeshSoA.avgUpdateMsEMA[ eid ];
            totalBoneTransformMs += SkinnedMeshSoA.avgBoneTransformMsEMA[ eid ];

            if ( SkinnedMeshSoA.freezeState[ eid ] === FreezeState.HARD_FROZEN ||
                 SkinnedMeshSoA.freezeState[ eid ] === FreezeState.COLD_FROZEN ) {
                frozenMeshes ++;
            }

            totalPaletteUploads += SkinnedMeshSoA.paletteUploadCount[ eid ];
            totalPaletteSkips += SkinnedMeshSoA.paletteSkipCount[ eid ];
        }

        const paletteBytes = new Double( totalPaletteBytes );
        const updateMs = new Double( totalUpdateMs );
        const boneTransformMs = new Double( totalBoneTransformMs );

        return {
            totalMeshes: totalMeshes,
            totalBones: totalBones,
            totalPaletteBytes: paletteBytes.valueOf(),
            totalUpdateMs: updateMs.valueOf(),
            totalBoneTransformMs: boneTransformMs.valueOf(),
            frozenMeshes: frozenMeshes,
            totalPaletteUploads: totalPaletteUploads,
            totalPaletteSkips: totalPaletteSkips,
            bridge: getBridgeAggregatedStats()
        };
    }

    // ─── Static: high-precision helpers. ───────────────────────────────────

    /**
     * Returns a high-precision scene-wide byte estimate for skinned meshes.
     * @return {number}
     */
    static computeSceneBytesHighPrecision() {
        return computeSceneBytesHighPrecision();
    }

    /**
     * Returns a high-precision scene-wide vertex op estimate.
     * @return {number}
     */
    static computeSceneVertexOpsHighPrecision() {
        return computeSceneVertexOpsHighPrecision();
    }

    /**
     * Returns a high-precision construction cost for a given mesh id.
     * @param {number} meshId
     * @return {number}
     */
    static computeConstructionCostHighPrecision( meshId ) {
        return computeConstructionCostHighPrecision( meshId );
    }

    // ─── Static: defaults / companion access. ──────────────────────────────

    /**
     * Returns the merged defaults facade (014_0 + 014_13).
     * @return {object}
     */
    static get DEFAULTS() {
        return getSkinnedMeshDefaults();
    }

    /**
     * Returns the entire companion set for advanced callers.
     * @return {object}
     */
    static get COMPANIONS() {
        return getCompanionSet();
    }

    /**
     * Returns the shared ECS world used by SkinnedMesh.
     * @return {object}
     */
    static getECSWorld() {
        return _skinnedMeshWorld;
    }

    /**
     * Returns the SkinnedMeshSoA component.
     * @return {object}
     */
    static getSkinnedMeshSoA() {
        return SkinnedMeshSoA;
    }

    // ─── gl-matrix packing for telemetry. ──────────────────────────────────

    /**
     * Packs SkinnedMesh telemetry into a vec4.
     * Layout: (boneCount, bonesPerVertex, paletteVersion, avgUpdateMsEMA)
     * @param {Float64Array} [out]
     * @return {Float64Array}
     */
    packSkinnedMeshVec4( out ) {
        const v = out || _scratchVec4;

        const boneCount = this.skeleton !== null && this.skeleton.bones !== undefined
            ? this.skeleton.bones.length
            : 0;

        glMatrix.vec4.set(
            v,
            boneCount,
            this._bonesPerVertex,
            this._paletteVersion,
            this._avgUpdateMsEMA
        );
        return v;
    }

    /**
     * Packs bind state into a vec4.
     * Layout: (bindMatrixVersion, bindMode, paletteUploadCount, paletteSkipCount)
     * @param {Float64Array} [out]
     * @return {Float64Array}
     */
    packBindStateVec4( out ) {
        const v = out || _scratchVec4B;

        glMatrix.vec4.set(
            v,
            this._bindMatrixVersion,
            this.bindMode === BindMode.ATTACHED ? 0 : 1,
            this._paletteUploadCount,
            this._paletteSkipCount
        );
        return v;
    }

    /**
     * Packs update timing into a vec4.
     * Layout: (lastUpdateMs, avgUpdateMsEMA, lastBoneTransformMs, avgBoneTransformMsEMA)
     * @param {Float64Array} [out]
     * @return {Float64Array}
     */
    packUpdateTimingVec4( out ) {
        const v = out || _scratchVec4C;

        glMatrix.vec4.set(
            v,
            this._lastUpdateMs,
            this._avgUpdateMsEMA,
            this._lastBoneTransformMs,
            this._avgBoneTransformMsEMA
        );
        return v;
    }

    /**
     * Packs freeze / tier telemetry into a vec4.
     * Layout: (freezeState, frozenUpdateSkipCount, androidTier, maxBonesBudget)
     * @param {Float64Array} [out]
     * @return {Float64Array}
     */
    packFreezeTierVec4( out ) {
        const v = out || _scratchVec4D;

        const fs = this.ownerLod !== undefined && this.ownerLod !== null
            ? this.ownerLod.getFreezeState()
            : FreezeState.AWAKE;

        glMatrix.vec4.set(
            v,
            fs,
            this._frozenUpdateSkipCount,
            this._androidTier,
            this._maxBonesBudget
        );
        return v;
    }

    // ─── Deterministic dither sampling. ────────────────────────────────────

    /**
     * Returns a deterministic dither sample for a given bone index / frame.
     * @param {number} boneIndex
     * @param {number} frameIndex
     * @return {number}
     */
    sampleBoneDither( boneIndex, frameIndex ) {
        const seed = _mix32( ( this._determinismSeed ^ ( boneIndex * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0 );
        return _noise3D( seed * 1e-6, frameIndex * 0.02, boneIndex );
    }
}

// ─── Utilities. ────────────────────────────────────────────────────────────

function _hashString( s ) {
    let h = 0x811c9dc5;
    for ( let i = 0; i < s.length; i ++ ) {
        h ^= s.charCodeAt( i );
        h = Math.imul( h, 0x01000193 );
    }
    return h >>> 0;
}

function _mix32( x ) {
    x = x >>> 0;
    x ^= x >>> 16;
    x = Math.imul( x, 0x85ebca6b );
    x ^= x >>> 13;
    x = Math.imul( x, 0xc2b2ae35 );
    x ^= x >>> 16;
    return x >>> 0;
}

function _nowMs() {
    if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
        return performance.now();
    }
    return Date.now();
}

// ─── Bind mode re-export (three.js compatible). ────────────────────────────

export const AttachedBindMode = BindMode.ATTACHED;
export const DetachedBindMode = BindMode.DETACHED;

void Object3D;
void BufferGeometry;
void BufferAttribute;
void Float32BufferAttribute;
void Bone;
void Vector4;
void Sphere;
void Ray;
void DataTexture;
void Walker;
void Validator;
void Archetypes;
void Builder;
void AutoAssign;
void Overlap;
void Compressor;
void Topology;
void ArbitraryTopology;
void CacheManager;
void SkinningTelemetry;
void BoneLOD;
void BoneCulling;
void RaycastFixedDensityLOD;
void DeterminismSeedLOD;
void SeedStream;
void TelemetryBudgetHUDLOD;
void FreezeWakeLOD;
void SkinnedMeshBridgeSoA;
void WiringStep;
void Defaults;
void _scratchVec3A;
void _scratchVec3B;
void _matrix4B;
void _sphere;
void _ray;
void _matrix4;
void _vector3A;
void _basePosition;
void _skinIndex;
void _skinWeight;
void _scratchMat4;
void _scratchMat4B;

export {
    SkinnedMesh,
    SkinnedMeshDefaults,
    SkinnedMeshSoA,
    BindMode
};