// file number : 014_15
// full path name : src/objects/014_15_BoneDistanceCulling.js
// description : Per-bone distance culling that deactivates bones whose influence radius does not intersect the camera frustum, while keeping their parents active so the hierarchy stays coherent. Works with 014_14_BoneLODSelection to produce the final active-bone set. Uses gl-matrix for sphere-frustum tests and double.js for high-precision radii on large worlds. Respects the FreezeWakeLOD state so fully frozen rigs report zero active bones. Uses bitecs SoA for per-skeleton and per-bone culling state, and simplex-noise for deterministic tie-breaking so replays produce identical active-bone sets across Android 64-bit devices (Adreno 5xx–7xx, Mali-G5x–G7xx).
// best for : Interior scenes with many rigged props, large crowds outside the frustum, VR frustum optimization, reducing per-frame CPU cost of rig bookkeeping on Android 64-bit, deterministic replay of distance-culled rigs, coupling with 014_14 for final active set.
// license : MIT

import { Skeleton } from './008_Skeleton.js';
import { Bone } from './001_Bone.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Sphere } from '../math/001_Sphere.js';
import { Frustum } from '../math/006_Frustum.js';

import { SkinnedMeshDefaults, SkinnedMeshCaps } from './014_0_SkinnedMeshDefaults.js';
import { SkinningTier, getCurrentPreset } from './014_13_SkinningPresets.js';
import { BoneLODSelectionSoA, BoneSelectionMode, DistanceBand, getSelectionBitset } from './014_14_BoneLODSelection.js';
import { FreezeWakeLOD, FreezeState } from './007_16_FreezeWake_LOD.js';
import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';
import { SkinningCostMultiplierLOD } from './007_12_SkinningCostMultiplier_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec4B = new Float64Array( 4 );
const _scratchVec4C = new Float64Array( 4 );
const _scratchVec4D = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchVec3C = new Float64Array( 3 );
const _scratchMat4 = new Float64Array( 16 );
const _scratchPlane = new Float64Array( 4 );
const _scratchSphere = new Float64Array( 4 );
const _noise3D = createNoise3D();

const _scratchSphereObject = /*@__PURE__*/ new Sphere();
const _scratchFrustum = /*@__PURE__*/ new Frustum();

// ─── ECS world + BoneDistanceCulling SoA component (bitecs). ────────────────
const _boneCullWorld = createWorld();

const BoneDistanceCullingSoA = defineComponent( {
    skeletonId: Types.i32,
    skeletonUuidHash: Types.i32,
    boneCount: Types.i32,

    // Culling state
    activeBoneCount: Types.i32,
    culledBoneCount: Types.i32,
    parentRetainedCount: Types.i32,
    cullingEnabled: Types.ui8,
    lastCullFrame: Types.i32,

    // Culling parameters
    minBoneRadius: Types.f64,
    maxBoneRadius: Types.f64,
    avgBoneRadius: Types.f64,
    radiusPadding: Types.f64,
    frustumPadding: Types.f64,

    // Frustum state
    inFrustum: Types.ui8,
    boneInFrustumCount: Types.i32,
    boneOutOfFrustumCount: Types.i32,

    // Freeze integration
    freezeState: Types.i32,
    frozenSkipCount: Types.i64,
    culledDuringFreeze: Types.i32,

    // Perf
    lastCullMs: Types.f64,
    avgCullMsEMA: Types.f64,
    lastRadiusComputeMs: Types.f64,

    // Determinism
    determinismSeed: Types.ui32,
    cullingSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    registered: Types.ui8,
    active: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Reusable culling result record. ───────────────────────────────────────
const _cullResult = {
    skeletonId: - 1,
    boneCount: 0,
    activeBoneCount: 0,
    culledBoneCount: 0,
    parentRetainedCount: 0,
    inFrustum: true,
    boneInFrustumCount: 0,
    boneOutOfFrustumCount: 0,
    cullMs: 0.0
};

// ─── Reusable defaults. ────────────────────────────────────────────────────
const BoneCullingDefaults = {
    // Whether to enable per-bone distance culling by default.
    enabledByDefault: true,

    // Padding added to each bone's influence radius before the frustum test.
    radiusPadding: 0.1,

    // Padding added to the frustum test sphere.
    frustumPadding: 0.05,

    // Minimum bone radius (world units).
    minBoneRadius: 0.05,

    // Maximum bone radius (world units).
    maxBoneRadius: 8.0,

    // Whether to keep parents active when children are culled.
    keepParentsActive: true,

    // Whether to keep children active when parents are culled.
    keepChildrenActive: false,

    // Whether to skip culling for skeletons entirely outside the frustum.
    skipWhenOutOfFrustum: true,

    // Whether to respect the FreezeWakeLOD freeze state.
    respectFreezeState: true,

    // Whether to skip culling entirely when frozen.
    skipWhenFrozen: true,

    // Whether to reuse the frustum from a shared source (e.g. 007_5).
    useSharedFrustum: true,

    // Whether to recompute bone radii at register time.
    computeRadiiAtRegister: true,

    // Whether to emit deterministic dither for tie-breaking.
    emitDither: true,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F,

    // Maximum frame stride for bone updates when the culling is stable.
    // 1 = every frame, 2 = every other frame, etc.
    updateStride: 1
};

// ─── Bone radii cache (skeletonHash -> Float32Array of radii). ─────────────
const _boneRadiiBySkeleton = new Map();

// ─── Per-bone world positions cache (skeletonHash -> Float32Array). ────────
const _bonePositionsBySkeleton = new Map();

// ─── Bone parent index cache (skeletonHash -> Int32Array). ─────────────────
const _boneParentIndexBySkeleton = new Map();

// ─── Per-bone cull bitset (skeletonHash -> Uint32Array). ───────────────────
const _cullBitsetBySkeleton = new Map();

// ─── ECS entity cache (skeletonHash -> eid). ───────────────────────────────
const _ecsCullByHash = new Map();

// ─── Public API: register. ─────────────────────────────────────────────────

/**
 * Registers a skeleton for per-bone distance culling.
 *
 * @param {Skeleton} skeleton
 * @param {object} [options]
 * @param {number} [options.frameIndex=0]
 * @param {number} [options.skeletonHash=0]
 * @return {number} The ECS entity id for the skeleton.
 */
function registerSkeleton( skeleton, options = {} ) {
    if ( skeleton === undefined || skeleton === null ) return - 1;

    const uuid = skeleton.uuid !== undefined ? skeleton.uuid : '';
    const skeletonHash = options.skeletonHash !== undefined && options.skeletonHash !== 0
        ? options.skeletonHash
        : _hashString( uuid );

    let eid = _ecsCullByHash.get( skeletonHash );

    if ( eid === undefined ) {
        eid = addEntity( _boneCullWorld );
        addComponent( _boneCullWorld, BoneDistanceCullingSoA, eid );
        _ecsCullByHash.set( skeletonHash, eid );
    }

    const boneCount = skeleton.bones !== undefined ? skeleton.bones.length : 0;

    BoneDistanceCullingSoA.skeletonId[ eid ] = eid;
    BoneDistanceCullingSoA.skeletonUuidHash[ eid ] = skeletonHash;
    BoneDistanceCullingSoA.boneCount[ eid ] = boneCount;
    BoneDistanceCullingSoA.activeBoneCount[ eid ] = boneCount;
    BoneDistanceCullingSoA.culledBoneCount[ eid ] = 0;
    BoneDistanceCullingSoA.parentRetainedCount[ eid ] = 0;
    BoneDistanceCullingSoA.cullingEnabled[ eid ] = BoneCullingDefaults.enabledByDefault ? 1 : 0;
    BoneDistanceCullingSoA.lastCullFrame[ eid ] = - 1;
    BoneDistanceCullingSoA.minBoneRadius[ eid ] = BoneCullingDefaults.minBoneRadius;
    BoneDistanceCullingSoA.maxBoneRadius[ eid ] = BoneCullingDefaults.maxBoneRadius;
    BoneDistanceCullingSoA.avgBoneRadius[ eid ] = BoneCullingDefaults.minBoneRadius;
    BoneDistanceCullingSoA.radiusPadding[ eid ] = BoneCullingDefaults.radiusPadding;
    BoneDistanceCullingSoA.frustumPadding[ eid ] = BoneCullingDefaults.frustumPadding;
    BoneDistanceCullingSoA.inFrustum[ eid ] = 1;
    BoneDistanceCullingSoA.boneInFrustumCount[ eid ] = 0;
    BoneDistanceCullingSoA.boneOutOfFrustumCount[ eid ] = 0;
    BoneDistanceCullingSoA.freezeState[ eid ] = FreezeState.AWAKE;
    BoneDistanceCullingSoA.frozenSkipCount[ eid ] = 0;
    BoneDistanceCullingSoA.culledDuringFreeze[ eid ] = 0;
    BoneDistanceCullingSoA.lastCullMs[ eid ] = 0.0;
    BoneDistanceCullingSoA.avgCullMsEMA[ eid ] = 0.0;
    BoneDistanceCullingSoA.lastRadiusComputeMs[ eid ] = 0.0;
    BoneDistanceCullingSoA.determinismSeed[ eid ] = _mix32( skeletonHash ^ BoneCullingDefaults.determinismSeed );
    BoneDistanceCullingSoA.cullingSeed[ eid ] = 0;
    BoneDistanceCullingSoA.ditherSample[ eid ] = 0.0;
    BoneDistanceCullingSoA.registered[ eid ] = 1;
    BoneDistanceCullingSoA.active[ eid ] = 1;
    BoneDistanceCullingSoA.lastFrameIndex[ eid ] = options.frameIndex | 0;

    // ── 1. Compute per-bone radii and parent indices. ──────────────────
    if ( BoneCullingDefaults.computeRadiiAtRegister ) {
        _buildBoneRadii( skeleton, skeletonHash );
        _buildParentIndices( skeleton, skeletonHash );
    }

    // ── 2. Allocate the cull bitset (all-active by default). ───────────
    _ensureCullBitset( skeletonHash, boneCount );

    return eid;
}

/**
 * Unregisters a skeleton.
 * @param {number} eid
 * @return {boolean}
 */
function unregisterSkeleton( eid ) {
    if ( eid < 0 ) return false;

    BoneDistanceCullingSoA.registered[ eid ] = 0;
    BoneDistanceCullingSoA.active[ eid ] = 0;

    for ( const [ hash, id ] of _ecsCullByHash ) {
        if ( id === eid ) {
            _ecsCullByHash.delete( hash );
            _boneRadiiBySkeleton.delete( hash );
            _bonePositionsBySkeleton.delete( hash );
            _boneParentIndexBySkeleton.delete( hash );
            _cullBitsetBySkeleton.delete( hash );
            break;
        }
    }

    return true;
}

// ─── Public API: cull. ────────────────────────────────────────────────────

/**
 * Runs per-bone distance culling for the given skeleton.
 *
 * @param {number} eid
 * @param {Skeleton} skeleton
 * @param {object} context
 * @param {Frustum} context.frustum - A THREE.Frustum (prefer 007_5 cache).
 * @param {number} [context.frameIndex=0]
 * @param {boolean} [context.skeletonInFrustum=true]
 * @return {object} The culling result record.
 */
function cull( eid, skeleton, context ) {
    const t0 = _nowMs();

    _cullResult.skeletonId = eid;
    _cullResult.boneCount = 0;
    _cullResult.activeBoneCount = 0;
    _cullResult.culledBoneCount = 0;
    _cullResult.parentRetainedCount = 0;
    _cullResult.inFrustum = true;
    _cullResult.boneInFrustumCount = 0;
    _cullResult.boneOutOfFrustumCount = 0;
    _cullResult.cullMs = 0.0;

    if ( eid < 0 ) {
        _cullResult.cullMs = _nowMs() - t0;
        return _cullResult;
    }

    if ( skeleton === undefined || skeleton === null ) {
        _cullResult.cullMs = _nowMs() - t0;
        return _cullResult;
    }

    if ( BoneDistanceCullingSoA.cullingEnabled[ eid ] !== 1 ) {
        _cullResult.cullMs = _nowMs() - t0;
        return _cullResult;
    }

    const frameIndex = context.frameIndex | 0;
    const skeletonInFrustum = context.skeletonInFrustum !== false;

    const skeletonHash = BoneDistanceCullingSoA.skeletonUuidHash[ eid ];
    const boneCount = BoneDistanceCullingSoA.boneCount[ eid ];

    _cullResult.boneCount = boneCount;
    _cullResult.inFrustum = skeletonInFrustum;

    if ( boneCount === 0 ) {
        _cullResult.cullMs = _nowMs() - t0;
        return _cullResult;
    }

    // ── 1. Respect the freeze / wake state. ─────────────────────────────
    if ( BoneCullingDefaults.respectFreezeState ) {
        const fs = BoneDistanceCullingSoA.freezeState[ eid ];

        if ( BoneCullingDefaults.skipWhenFrozen && ( fs === FreezeState.HARD_FROZEN || fs === FreezeState.COLD_FROZEN ) ) {
            BoneDistanceCullingSoA.frozenSkipCount[ eid ] ++;
            BoneDistanceCullingSoA.culledDuringFreeze[ eid ] = boneCount;
            BoneDistanceCullingSoA.activeBoneCount[ eid ] = 0;
            BoneDistanceCullingSoA.culledBoneCount[ eid ] = boneCount;
            BoneDistanceCullingSoA.lastFrameIndex[ eid ] = frameIndex;

            _cullResult.activeBoneCount = 0;
            _cullResult.culledBoneCount = boneCount;
            _cullResult.cullMs = _nowMs() - t0;

            return _cullResult;
        }
    }

    // ── 2. Skip everything if the entire skeleton is out of frustum. ────
    if ( BoneCullingDefaults.skipWhenOutOfFrustum && ! skeletonInFrustum ) {
        BoneDistanceCullingSoA.inFrustum[ eid ] = 0;
        BoneDistanceCullingSoA.activeBoneCount[ eid ] = 0;
        BoneDistanceCullingSoA.culledBoneCount[ eid ] = boneCount;
        BoneDistanceCullingSoA.boneInFrustumCount[ eid ] = 0;
        BoneDistanceCullingSoA.boneOutOfFrustumCount[ eid ] = boneCount;

        // Zero out the cull bitset.
        const bitset = _ensureCullBitset( skeletonHash, boneCount );
        for ( let i = 0; i < bitset.length; i ++ ) bitset[ i ] = 0;

        BoneDistanceCullingSoA.lastCullMs[ eid ] = _nowMs() - t0;
        BoneDistanceCullingSoA.avgCullMsEMA[ eid ] = BoneDistanceCullingSoA.avgCullMsEMA[ eid ] * 0.9 + BoneDistanceCullingSoA.lastCullMs[ eid ] * 0.1;
        BoneDistanceCullingSoA.lastFrameIndex[ eid ] = frameIndex;

        _cullResult.activeBoneCount = 0;
        _cullResult.culledBoneCount = boneCount;
        _cullResult.cullMs = BoneDistanceCullingSoA.lastCullMs[ eid ];

        return _cullResult;
    }

    // ── 3. Frustum update. ──────────────────────────────────────────────
    const frustum = context.frustum;

    if ( frustum === undefined || frustum === null ) {
        // No frustum available: keep all bones active.
        _cullResult.activeBoneCount = boneCount;
        _cullResult.cullMs = _nowMs() - t0;

        BoneDistanceCullingSoA.lastFrameIndex[ eid ] = frameIndex;

        return _cullResult;
    }

    // ── 4. Extract per-bone world positions via gl-matrix. ─────────────
    const tRadius = _nowMs();
    const bonePositions = _updateBonePositions( skeleton, skeletonHash );
    const boneRadii = _boneRadiiBySkeleton.get( skeletonHash );
    const parentIndices = _boneParentIndexBySkeleton.get( skeletonHash );
    BoneDistanceCullingSoA.lastRadiusComputeMs[ eid ] = _nowMs() - tRadius;

    if ( bonePositions === null || boneRadii === null ) {
        // Positions cache missing: keep all bones active.
        _cullResult.activeBoneCount = boneCount;
        _cullResult.cullMs = _nowMs() - t0;

        return _cullResult;
    }

    // ── 5. Iterate bones and test each one against the frustum. ────────
    const bitset = _ensureCullBitset( skeletonHash, boneCount );

    // Clear the bitset.
    for ( let i = 0; i < bitset.length; i ++ ) bitset[ i ] = 0;

    const frustumPlanes = frustum.planes;

    let inFrustumCount = 0;
    let outOfFrustumCount = 0;
    let activeCount = 0;

    const radiusPadding = BoneDistanceCullingSoA.radiusPadding[ eid ];
    const frustumPadding = BoneDistanceCullingSoA.frustumPadding[ eid ];

    for ( let b = 0; b < boneCount; b ++ ) {
        // ── 5a. World position of the bone. ─────────────────────────────
        const px = bonePositions[ b * 3 + 0 ];
        const py = bonePositions[ b * 3 + 1 ];
        const pz = bonePositions[ b * 3 + 2 ];

        glMatrix.vec3.set( _scratchVec3A, px, py, pz );

        // ── 5b. Influence radius with padding. ──────────────────────────
        let radius = boneRadii[ b ] + radiusPadding;

        if ( radius < BoneCullingDefaults.minBoneRadius ) radius = BoneCullingDefaults.minBoneRadius;
        if ( radius > BoneCullingDefaults.maxBoneRadius ) radius = BoneCullingDefaults.maxBoneRadius;

        // ── 5c. Sphere-plane test against all six frustum planes. ──────
        const sphereRadius = radius + frustumPadding;

        const inside = _isSphereInsideFrustum( frustumPlanes, _scratchVec3A, sphereRadius );

        if ( inside ) {
            const word = b >>> 5;
            const bit = b & 31;

            if ( word < bitset.length ) {
                bitset[ word ] |= ( 1 << bit );
                activeCount ++;
                inFrustumCount ++;
            }
        } else {
            outOfFrustumCount ++;
        }
    }

    // ── 6. Keep parents active when requested. ─────────────────────────
    if ( BoneCullingDefaults.keepParentsActive && parentIndices !== null ) {
        let parentRetained = 0;

        for ( let b = 0; b < boneCount; b ++ ) {
            const word = b >>> 5;
            const bit = b & 31;

            if ( word >= bitset.length ) continue;

            if ( ( bitset[ word ] & ( 1 << bit ) ) !== 0 ) continue;

            // Bone is culled. Walk up the parent chain and activate parents.
            let p = parentIndices[ b ];

            while ( p >= 0 ) {
                const pWord = p >>> 5;
                const pBit = p & 31;

                if ( pWord >= bitset.length ) break;

                if ( ( bitset[ pWord ] & ( 1 << pBit ) ) !== 0 ) break;

                bitset[ pWord ] |= ( 1 << pBit );
                activeCount ++;
                parentRetained ++;

                p = parentIndices[ p ];
            }
        }

        BoneDistanceCullingSoA.parentRetainedCount[ eid ] = parentRetained;
        _cullResult.parentRetainedCount = parentRetained;
    }

    // ── 7. Intersect with 014_14's selection bitset if present. ────────
    const lodBitset = getSelectionBitset( skeletonHash );

    if ( lodBitset !== null && lodBitset !== undefined ) {
        for ( let i = 0; i < bitset.length; i ++ ) {
            bitset[ i ] &= lodBitset[ i ];
        }

        // Re-count active bones.
        activeCount = 0;

        for ( let b = 0; b < boneCount; b ++ ) {
            const word = b >>> 5;
            const bit = b & 31;

            if ( word >= bitset.length ) continue;

            if ( ( bitset[ word ] & ( 1 << bit ) ) !== 0 ) activeCount ++;
        }
    }

    // ── 8. Compute deterministic culling seed for telemetry. ──────────
    const cullingSeed = _mix32(
        ( skeletonHash ^ ( frameIndex * 0x9E3779B9 ) ^ ( activeCount * 0x85EBCA6B ) ) >>> 0
    );

    BoneDistanceCullingSoA.cullingSeed[ eid ] = cullingSeed;
    BoneDistanceCullingSoA.ditherSample[ eid ] = _noise3D( cullingSeed * 1e-6, frameIndex * 0.02, boneCount );

    // ── 9. Update ECS state. ───────────────────────────────────────────
    BoneDistanceCullingSoA.activeBoneCount[ eid ] = activeCount;
    BoneDistanceCullingSoA.culledBoneCount[ eid ] = boneCount - activeCount;
    BoneDistanceCullingSoA.inFrustum[ eid ] = skeletonInFrustum ? 1 : 0;
    BoneDistanceCullingSoA.boneInFrustumCount[ eid ] = inFrustumCount;
    BoneDistanceCullingSoA.boneOutOfFrustumCount[ eid ] = outOfFrustumCount;
    BoneDistanceCullingSoA.lastCullFrame[ eid ] = frameIndex;
    BoneDistanceCullingSoA.lastCullMs[ eid ] = _nowMs() - t0;
    BoneDistanceCullingSoA.avgCullMsEMA[ eid ] = BoneDistanceCullingSoA.avgCullMsEMA[ eid ] * 0.9 + BoneDistanceCullingSoA.lastCullMs[ eid ] * 0.1;
    BoneDistanceCullingSoA.lastFrameIndex[ eid ] = frameIndex;

    // ── 10. Report. ────────────────────────────────────────────────────
    _cullResult.activeBoneCount = activeCount;
    _cullResult.culledBoneCount = boneCount - activeCount;
    _cullResult.boneInFrustumCount = inFrustumCount;
    _cullResult.boneOutOfFrustumCount = outOfFrustumCount;
    _cullResult.cullMs = BoneDistanceCullingSoA.lastCullMs[ eid ];

    return _cullResult;
}

// ─── Internal: bone radii computation. ────────────────────────────────────

function _buildBoneRadii( skeleton, skeletonHash ) {
    const bones = skeleton.bones;

    if ( bones === undefined || bones.length === 0 ) {
        _boneRadiiBySkeleton.set( skeletonHash, new Float32Array( 0 ) );
        return;
    }

    const boneCount = bones.length;
    const radii = new Float32Array( boneCount );

    let minR = Number.MAX_VALUE;
    let maxR = 0.0;
    let sumR = 0.0;

    for ( let i = 0; i < boneCount; i ++ ) {
        const bone = bones[ i ];

        if ( bone === undefined || bone === null ) {
            radii[ i ] = BoneCullingDefaults.minBoneRadius;
            continue;
        }

        // ── 1. User override via userData.skinRadius. ───────────────────
        if ( bone.userData !== undefined && bone.userData.skinRadius !== undefined ) {
            radii[ i ] = Math.max( BoneCullingDefaults.minBoneRadius, bone.userData.skinRadius );
            continue;
        }

        // ── 2. Compute the segment length to the first child. ──────────
        bone.updateMatrixWorld( true );

        const mw = bone.matrixWorld.elements;

        const ax = mw[ 12 ];
        const ay = mw[ 13 ];
        const az = mw[ 14 ];

        let bx = ax;
        let by = ay;
        let bz = az;

        const children = bone.children;

        if ( children.length > 0 ) {
            const child = children[ 0 ];
            child.updateMatrixWorld( true );

            const cmw = child.matrixWorld.elements;
            bx = cmw[ 12 ];
            by = cmw[ 13 ];
            bz = cmw[ 14 ];
        }

        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;

        const length = Math.hypot( dx, dy, dz );

        // ── 3. Radius = half the segment length, clamped. ───────────────
        let r = length * 0.5;

        if ( r < BoneCullingDefaults.minBoneRadius ) r = BoneCullingDefaults.minBoneRadius;
        if ( r > BoneCullingDefaults.maxBoneRadius ) r = BoneCullingDefaults.maxBoneRadius;

        radii[ i ] = r;

        if ( r < minR ) minR = r;
        if ( r > maxR ) maxR = r;
        sumR += r;
    }

    _boneRadiiBySkeleton.set( skeletonHash, radii );

    // ── 4. Update the per-skeleton ECS entry with the radii stats. ─────
    const eid = _ecsCullByHash.get( skeletonHash );

    if ( eid !== undefined ) {
        BoneDistanceCullingSoA.minBoneRadius[ eid ] = minR === Number.MAX_VALUE ? 0.0 : minR;
        BoneDistanceCullingSoA.maxBoneRadius[ eid ] = maxR;
        BoneDistanceCullingSoA.avgBoneRadius[ eid ] = boneCount > 0 ? sumR / boneCount : 0.0;
    }
}

// ─── Internal: parent index computation. ──────────────────────────────────

function _buildParentIndices( skeleton, skeletonHash ) {
    const bones = skeleton.bones;

    if ( bones === undefined || bones.length === 0 ) {
        _boneParentIndexBySkeleton.set( skeletonHash, new Int32Array( 0 ) );
        return;
    }

    const boneCount = bones.length;
    const parentIndices = new Int32Array( boneCount );

    // Build a bone -> index map.
    const indexMap = new Map();

    for ( let i = 0; i < boneCount; i ++ ) {
        indexMap.set( bones[ i ], i );
    }

    for ( let i = 0; i < boneCount; i ++ ) {
        const bone = bones[ i ];
        const parent = bone.parent;

        if ( parent === null || parent === undefined || parent.isBone !== true ) {
            parentIndices[ i ] = - 1;
            continue;
        }

        const pi = indexMap.get( parent );

        parentIndices[ i ] = pi !== undefined ? pi : - 1;
    }

    _boneParentIndexBySkeleton.set( skeletonHash, parentIndices );
}

// ─── Internal: bone position cache update. ─────────────────────────────────

function _updateBonePositions( skeleton, skeletonHash ) {
    const bones = skeleton.bones;

    if ( bones === undefined || bones.length === 0 ) return null;

    const boneCount = bones.length;

    let positions = _bonePositionsBySkeleton.get( skeletonHash );

    if ( positions === undefined || positions.length !== boneCount * 3 ) {
        positions = new Float32Array( boneCount * 3 );
        _bonePositionsBySkeleton.set( skeletonHash, positions );
    }

    // Read the world positions via gl-matrix (matrixWorld translation).
    for ( let i = 0; i < boneCount; i ++ ) {
        const bone = bones[ i ];

        if ( bone === undefined || bone === null ) {
            positions[ i * 3 + 0 ] = 0.0;
            positions[ i * 3 + 1 ] = 0.0;
            positions[ i * 3 + 2 ] = 0.0;
            continue;
        }

        const e = bone.matrixWorld.elements;

        positions[ i * 3 + 0 ] = e[ 12 ];
        positions[ i * 3 + 1 ] = e[ 13 ];
        positions[ i * 3 + 2 ] = e[ 14 ];
    }

    return positions;
}

// ─── Internal: frustum sphere test. ───────────────────────────────────────

function _isSphereInsideFrustum( planes, center, radius ) {
    for ( let i = 0; i < 6; i ++ ) {
        const b = i * 4;

        const nx = planes[ b ];
        const ny = planes[ b + 1 ];
        const nz = planes[ b + 2 ];
        const d = planes[ b + 3 ];

        // Distance from center to plane.
        const dist = nx * center[ 0 ] + ny * center[ 1 ] + nz * center[ 2 ] + d;

        if ( dist < - radius ) return false;
    }

    return true;
}

// ─── Internal: cull bitset management. ────────────────────────────────────

function _ensureCullBitset( skeletonHash, boneCount ) {
    const wordCount = ( boneCount + 31 ) >>> 5;

    let bitset = _cullBitsetBySkeleton.get( skeletonHash );

    if ( bitset === undefined || bitset.length !== wordCount ) {
        bitset = new Uint32Array( wordCount );

        // Default to all-active.
        for ( let i = 0; i < wordCount; i ++ ) bitset[ i ] = 0xFFFFFFFF;

        // Clear trailing bits beyond boneCount.
        const lastWord = wordCount - 1;
        const trailingBits = boneCount & 31;

        if ( trailingBits !== 0 ) {
            bitset[ lastWord ] &= ( 1 << trailingBits ) - 1;
        }

        _cullBitsetBySkeleton.set( skeletonHash, bitset );
    }

    return bitset;
}

// ─── Public API: query. ────────────────────────────────────────────────────

/**
 * Returns the cull bitset for a given skeleton.
 * @param {number} skeletonHash
 * @return {Uint32Array|null}
 */
function getCullBitset( skeletonHash ) {
    const bitset = _cullBitsetBySkeleton.get( skeletonHash );
    return bitset !== undefined ? bitset : null;
}

/**
 * Returns whether a specific bone is active (not culled).
 * @param {number} skeletonHash
 * @param {number} boneIndex
 * @return {boolean}
 */
function isBoneActive( skeletonHash, boneIndex ) {
    const bitset = _cullBitsetBySkeleton.get( skeletonHash );

    if ( bitset === undefined ) return true;

    const word = boneIndex >>> 5;
    const bit = boneIndex & 31;

    if ( word >= bitset.length ) return false;

    return ( bitset[ word ] & ( 1 << bit ) ) !== 0;
}

/**
 * Returns the last culling result record.
 * @return {object}
 */
function getLastCullResult() {
    return _cullResult;
}

// ─── Public API: freeze integration. ──────────────────────────────────────

/**
 * Publishes the freeze state for a given skeleton.
 * @param {number} eid
 * @param {number} freezeState
 */
function setFreezeState( eid, freezeState ) {
    if ( eid < 0 ) return;

    BoneDistanceCullingSoA.freezeState[ eid ] = freezeState | 0;
}

// ─── Public API: high-precision helpers. ──────────────────────────────────

/**
 * Returns a high-precision ratio of active bones to total bones.
 * @param {number} eid
 * @return {number}
 */
function computeActiveRatioHighPrecision( eid ) {
    if ( eid < 0 ) return 0.0;

    const active = new Double( BoneDistanceCullingSoA.activeBoneCount[ eid ] );
    const total = new Double( Math.max( 1, BoneDistanceCullingSoA.boneCount[ eid ] ) );

    return active.div( total ).valueOf();
}

/**
 * Returns a high-precision ratio of bones that were retained because a
 * child was culled (parents kept active for coherence).
 * @param {number} eid
 * @return {number}
 */
function computeParentRetentionRatioHighPrecision( eid ) {
    if ( eid < 0 ) return 0.0;

    const retained = new Double( BoneDistanceCullingSoA.parentRetainedCount[ eid ] );
    const active = new Double( Math.max( 1, BoneDistanceCullingSoA.activeBoneCount[ eid ] ) );

    return retained.div( active ).valueOf();
}

/**
 * Returns a high-precision scene-wide estimate of the bones culled per frame.
 * @return {number}
 */
function computeSceneCullSavingsHighPrecision() {
    let totalCulled = new Double( 0 );

    const q = query( _boneCullWorld, [ BoneDistanceCullingSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( BoneDistanceCullingSoA.registered[ eid ] !== 1 ) continue;

        const culled = BoneDistanceCullingSoA.culledBoneCount[ eid ];
        const cullMs = BoneDistanceCullingSoA.avgCullMsEMA[ eid ];

        totalCulled = new Double( totalCulled.valueOf() + culled * cullMs );
    }

    return totalCulled.valueOf();
}

// ─── Public API: aggregated stats. ────────────────────────────────────────

/**
 * Returns aggregated bone-culling statistics across the scene.
 * @return {object}
 */
function getAggregatedStats() {
    let totalSkeletons = 0;
    let totalBones = 0;
    let totalActiveBones = 0;
    let totalCulledBones = 0;
    let totalParentRetained = 0;
    let frozenSkeletons = 0;
    let totalCullMs = 0.0;

    const q = query( _boneCullWorld, [ BoneDistanceCullingSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( BoneDistanceCullingSoA.registered[ eid ] !== 1 ) continue;

        totalSkeletons ++;
        totalBones += BoneDistanceCullingSoA.boneCount[ eid ];
        totalActiveBones += BoneDistanceCullingSoA.activeBoneCount[ eid ];
        totalCulledBones += BoneDistanceCullingSoA.culledBoneCount[ eid ];
        totalParentRetained += BoneDistanceCullingSoA.parentRetainedCount[ eid ];
        totalCullMs += BoneDistanceCullingSoA.avgCullMsEMA[ eid ];

        if ( BoneDistanceCullingSoA.freezeState[ eid ] === FreezeState.HARD_FROZEN ||
             BoneDistanceCullingSoA.freezeState[ eid ] === FreezeState.COLD_FROZEN ) {
            frozenSkeletons ++;
        }
    }

    const cullRatio = totalBones > 0 ? totalCulledBones / totalBones : 0.0;
    const ms = new Double( totalCullMs );

    return {
        totalSkeletons: totalSkeletons,
        totalBones: totalBones,
        totalActiveBones: totalActiveBones,
        totalCulledBones: totalCulledBones,
        totalParentRetained: totalParentRetained,
        cullRatio: cullRatio,
        frozenSkeletons: frozenSkeletons,
        totalCullMs: ms.valueOf()
    };
}

// ─── gl-matrix packing for telemetry. ─────────────────────────────────────

/**
 * Packs cull telemetry into a vec4.
 * Layout: (boneCount, activeBoneCount, culledBoneCount, parentRetainedCount)
 * @param {number} eid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packCullVec4( eid, out ) {
    const v = out || _scratchVec4;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        BoneDistanceCullingSoA.boneCount[ eid ],
        BoneDistanceCullingSoA.activeBoneCount[ eid ],
        BoneDistanceCullingSoA.culledBoneCount[ eid ],
        BoneDistanceCullingSoA.parentRetainedCount[ eid ]
    );
    return v;
}

/**
 * Packs frustum telemetry into a vec4.
 * Layout: (inFrustum, boneInFrustumCount, boneOutOfFrustumCount, freezeState)
 * @param {number} eid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packFrustumVec4( eid, out ) {
    const v = out || _scratchVec4B;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        BoneDistanceCullingSoA.inFrustum[ eid ],
        BoneDistanceCullingSoA.boneInFrustumCount[ eid ],
        BoneDistanceCullingSoA.boneOutOfFrustumCount[ eid ],
        BoneDistanceCullingSoA.freezeState[ eid ]
    );
    return v;
}

/**
 * Packs radii statistics into a vec4.
 * Layout: (minBoneRadius, maxBoneRadius, avgBoneRadius, radiusPadding)
 * @param {number} eid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packRadiiVec4( eid, out ) {
    const v = out || _scratchVec4C;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        BoneDistanceCullingSoA.minBoneRadius[ eid ],
        BoneDistanceCullingSoA.maxBoneRadius[ eid ],
        BoneDistanceCullingSoA.avgBoneRadius[ eid ],
        BoneDistanceCullingSoA.radiusPadding[ eid ]
    );
    return v;
}

/**
 * Packs timing telemetry into a vec4.
 * Layout: (lastCullMs, avgCullMsEMA, lastRadiusComputeMs, frozenSkipCount)
 * @param {number} eid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packTimingVec4( eid, out ) {
    const v = out || _scratchVec4D;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        BoneDistanceCullingSoA.lastCullMs[ eid ],
        BoneDistanceCullingSoA.avgCullMsEMA[ eid ],
        BoneDistanceCullingSoA.lastRadiusComputeMs[ eid ],
        BoneDistanceCullingSoA.frozenSkipCount[ eid ]
    );
    return v;
}

// ─── Public API: deterministic dither sampling. ───────────────────────────

/**
 * Returns a deterministic dither sample for the given entity / frame.
 * @param {number} eid
 * @param {number} frameIndex
 * @return {number}
 */
function sampleCullDither( eid, frameIndex ) {
    if ( eid < 0 ) return 0.0;

    const seed = ( BoneDistanceCullingSoA.determinismSeed[ eid ] ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, BoneDistanceCullingSoA.boneCount[ eid ] );
}

// ─── Public API: frame lifecycle. ─────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all culling entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _boneCullWorld, [ BoneDistanceCullingSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        BoneDistanceCullingSoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
    }
}

// ─── Public API: enable / disable. ────────────────────────────────────────

/**
 * Enables or disables per-bone culling for a given skeleton.
 * @param {number} eid
 * @param {boolean} [enabled=true]
 */
function setCullingEnabled( eid, enabled = true ) {
    if ( eid < 0 ) return;

    BoneDistanceCullingSoA.cullingEnabled[ eid ] = enabled ? 1 : 0;
}

/**
 * Returns whether culling is enabled for a given skeleton.
 * @param {number} eid
 * @return {boolean}
 */
function isCullingEnabled( eid ) {
    if ( eid < 0 ) return false;

    return BoneDistanceCullingSoA.cullingEnabled[ eid ] === 1;
}

// ─── Utilities. ───────────────────────────────────────────────────────────

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

void Bone;
void Vector3;
void Matrix4;
void Sphere;
void Frustum;
void SkinnedMeshDefaults;
void SkinnedMeshCaps;
void SkinningTier;
void getCurrentPreset;
void BoneLODSelectionSoA;
void BoneSelectionMode;
void DistanceBand;
void FreezeWakeLOD;
void DeterminismSeedLOD;
void SeedStream;
void SkinningCostMultiplierLOD;
void _scratchVec3B;
void _scratchVec3C;
void _scratchMat4;
void _scratchPlane;
void _scratchSphere;
void _scratchSphereObject;
void _scratchFrustum;

export {
    BoneCullingDefaults,
    BoneDistanceCullingSoA,
    registerSkeleton,
    unregisterSkeleton,
    cull,
    getCullBitset,
    isBoneActive,
    getLastCullResult,
    setFreezeState,
    computeActiveRatioHighPrecision,
    computeParentRetentionRatioHighPrecision,
    computeSceneCullSavingsHighPrecision,
    getAggregatedStats,
    packCullVec4,
    packFrustumVec4,
    packRadiiVec4,
    packTimingVec4,
    sampleCullDither,
    beginFrame,
    setCullingEnabled,
    isCullingEnabled
};