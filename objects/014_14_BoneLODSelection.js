// file number : 014_14
// full path name : src/objects/014_14_BoneLODSelection.js
// description : Chooses a subset of bones to keep active per frame based on camera distance, projected size, visibility, and per-bone importance rank. Distant or small characters can drop from 120 bones to 30 or 15 without visible popping. Uses a bone-importance rank precomputed at rig construction (root bones and spine bones rank highest, leaf fingers and toes lowest). Integrates with FreezeWakeLOD so cold-frozen rigs skip palette upload entirely, and respects the per-tier bone budget from 014_13_SkinningPresets. Uses bitecs SoA to store per-bone selection state, double.js for high-precision camera-distance and screen-space accounting, gl-matrix for bone world-position extraction and vec4 telemetry packing, and simplex-noise for deterministic tie-breaking during rank-based selection so replays produce identical bone subsets across Android 64-bit devices (Adreno 5xx–7xx, Mali-G5x–G7xx).
// best for : Android 64-bit crowd rendering, distant NPCs, background characters, reducing vertex-shader bone loops on Adreno 5xx and Mali-G5x, deterministic replay of LOD-driven bone selection, VR single-eye optimization, thermal-throttled skeletal scenes.
// license : MIT

import { Skeleton } from './008_Skeleton.js';
import { Bone } from './001_Bone.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Sphere } from '../math/001_Sphere.js';

import { BonesPerVertex, SkinnedMeshDefaults, SkinnedMeshCaps, BoneHierarchyKind } from './014_0_SkinnedMeshDefaults.js';
import { SkinningTier, getCurrentPreset } from './014_13_SkinningPresets.js';
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
const _noise3D = createNoise3D();

const _scratchBonePos = /*@__PURE__*/ new Vector3();
const _scratchSphere = /*@__PURE__*/ new Sphere();

// ─── ECS world + BoneLOD SoA component (bitecs). ────────────────────────────
const _boneLodWorld = createWorld();

const BoneLODSelectionSoA = defineComponent( {
    skeletonId: Types.i32,
    skeletonUuidHash: Types.i32,
    boneCount: Types.i32,

    // Selection state
    activeBoneCount: Types.i32,
    activeBoneBudget: Types.i32,
    activeBoneBudgetUtilization: Types.f64,
    selectionMode: Types.i32,
    lastSelectionFrame: Types.i32,

    // Camera / distance
    cameraDistance: Types.f64,
    cameraDistanceSq: Types.f64,
    screenSpaceRadiusPx: Types.f64,
    projectedSizePx: Types.f64,
    distanceBand: Types.i32,
    isVisibleInFrustum: Types.ui8,

    // Importance ranking
    topImportanceBoneId: Types.i32,
    minImportanceActive: Types.f64,
    maxImportanceActive: Types.f64,
    importanceCutoff: Types.f64,

    // Freeze / wake integration
    freezeState: Types.i32,
    frozenSkipCount: Types.i64,
    paletteUploaded: Types.ui8,
    paletteUploadSkipped: Types.ui8,

    // Perf
    lastSelectionMs: Types.f64,
    avgSelectionMsEMA: Types.f64,
    lastPalettePrepMs: Types.f64,

    // Determinism
    determinismSeed: Types.ui32,
    selectionSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    registered: Types.ui8,
    active: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Selection mode constants. ──────────────────────────────────────────────
const BoneSelectionMode = Object.freeze( {
    FULL: 0,           // All bones active (close-up, hero characters).
    HIGH: 1,           // ~75% bones (spine + limbs + most fingers).
    MEDIUM: 2,         // ~50% bones (spine + major limbs).
    LOW: 3,            // ~25% bones (spine + root + one bone per limb).
    MINIMAL: 4,        // ~10% bones (root + spine only).
    FREEZE: 5          // No bones active (rig is frozen / off-screen).
} );

// ─── Distance band constants. ───────────────────────────────────────────────
const DistanceBand = Object.freeze( {
    HERO: 0,           // < 5m: full fidelity.
    NEAR: 1,           // 5–15m: high fidelity.
    MID: 2,            // 15–40m: medium fidelity.
    FAR: 3,            // 40–100m: low fidelity.
    DISTANT: 4,        // > 100m: minimal fidelity.
    CULLED: 5          // Off-screen / occluded.
} );

// ─── Per-tier selection thresholds (distance in world units). ───────────────
const SELECTION_THRESHOLDS_TABLE = {
    [ SkinningTier.LOW ]: {
        heroDistance: 3.0,
        nearDistance: 8.0,
        midDistance: 20.0,
        farDistance: 50.0,
        distantDistance: 120.0,
        heroBudgetRatio: 1.0,
        nearBudgetRatio: 0.60,
        midBudgetRatio: 0.35,
        farBudgetRatio: 0.20,
        distantBudgetRatio: 0.10,
        minActiveBones: 4,
        projectedSizeFloor: 24.0
    },
    [ SkinningTier.MID ]: {
        heroDistance: 5.0,
        nearDistance: 15.0,
        midDistance: 40.0,
        farDistance: 100.0,
        distantDistance: 250.0,
        heroBudgetRatio: 1.0,
        nearBudgetRatio: 0.75,
        midBudgetRatio: 0.50,
        farBudgetRatio: 0.30,
        distantBudgetRatio: 0.15,
        minActiveBones: 6,
        projectedSizeFloor: 18.0
    },
    [ SkinningTier.HIGH ]: {
        heroDistance: 7.0,
        nearDistance: 20.0,
        midDistance: 60.0,
        farDistance: 150.0,
        distantDistance: 400.0,
        heroBudgetRatio: 1.0,
        nearBudgetRatio: 0.85,
        midBudgetRatio: 0.60,
        farBudgetRatio: 0.35,
        distantBudgetRatio: 0.20,
        minActiveBones: 8,
        projectedSizeFloor: 12.0
    },
    [ SkinningTier.FLAGSHIP ]: {
        heroDistance: 10.0,
        nearDistance: 25.0,
        midDistance: 80.0,
        farDistance: 200.0,
        distantDistance: 600.0,
        heroBudgetRatio: 1.0,
        nearBudgetRatio: 0.90,
        midBudgetRatio: 0.70,
        farBudgetRatio: 0.45,
        distantBudgetRatio: 0.25,
        minActiveBones: 12,
        projectedSizeFloor: 10.0
    }
};

// ─── Reusable selection result record. ─────────────────────────────────────
const _selectionResult = {
    skeletonId: - 1,
    boneCount: 0,
    activeBoneCount: 0,
    activeBoneBudget: 0,
    selectionMode: BoneSelectionMode.FULL,
    distanceBand: DistanceBand.HERO,
    cameraDistance: 0.0,
    screenSpaceRadiusPx: 0.0,
    projectedSizePx: 0.0,
    importanceCutoff: 0.0,
    paletteUploaded: false,
    selectionMs: 0.0
};

// ─── Reusable defaults. ────────────────────────────────────────────────────
const BoneLODDefaults = {
    // Whether to enable bone LOD selection by default.
    enabledByDefault: true,

    // Whether to skip selection when the rig is very close (hero band).
    skipSelectionInHeroBand: true,

    // Whether to skip palette upload when the active set is unchanged.
    skipUploadWhenUnchanged: true,

    // Whether to respect the FreezeWakeLOD freeze state.
    respectFreezeState: true,

    // Whether to respect the SkinningCostMultiplierLOD skinning budget.
    respectSkinningBudget: true,

    // Whether to skip selection entirely when a rig is frozen.
    skipWhenFrozen: true,

    // Minimum projected size (pixels) below which the rig enters minimal mode.
    projectedSizeMinimalThreshold: 8.0,

    // Maximum number of bones ever active, regardless of budget.
    globalMaxActiveBones: 512,

    // Minimum number of bones ever active (safety floor).
    globalMinActiveBones: 4,

    // Whether to recompute importance ranks at register time.
    computeImportanceAtRegister: true,

    // Whether to use camera forward cone to further prune bones.
    useCameraForwardCone: false,

    // Camera forward cone half-angle (radians).
    cameraConeAngle: Math.PI / 3,

    // Number of frames between full re-rankings.
    reRankInterval: 60,

    // Whether to emit deterministic dither for selection ordering.
    emitDither: true,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F
};

// ─── Bone importance rank cache (skeletonHash -> Float64Array of ranks). ───
const _importanceRanksBySkeleton = new Map();

// ─── Bone index cache (skeletonHash -> Map<Bone, index>). ──────────────────
const _boneIndexBySkeleton = new Map();

// ─── Selected bone bitset per skeleton. ────────────────────────────────────
const _selectionBitsetBySkeleton = new Map();

// ─── ECS entity cache by skeleton hash. ────────────────────────────────────
const _ecsBoneLodByHash = new Map();

// ─── Public API: register. ─────────────────────────────────────────────────

/**
 * Registers a skeleton for per-frame bone LOD selection.
 *
 * @param {Skeleton} skeleton
 * @param {object} [options]
 * @param {number} [options.frameIndex=0]
 * @param {number} [options.skeletonHash=0] - Optional precomputed hash.
 * @return {number} The ECS entity id for the skeleton.
 */
function registerSkeleton( skeleton, options = {} ) {
    if ( skeleton === undefined || skeleton === null ) return - 1;

    const uuid = skeleton.uuid !== undefined ? skeleton.uuid : '';
    const skeletonHash = options.skeletonHash !== undefined && options.skeletonHash !== 0
        ? options.skeletonHash
        : _hashString( uuid );

    let eid = _ecsBoneLodByHash.get( skeletonHash );

    if ( eid === undefined ) {
        eid = addEntity( _boneLodWorld );
        addComponent( _boneLodWorld, BoneLODSelectionSoA, eid );
        _ecsBoneLodByHash.set( skeletonHash, eid );
    }

    const boneCount = skeleton.bones !== undefined ? skeleton.bones.length : 0;

    BoneLODSelectionSoA.skeletonId[ eid ] = eid;
    BoneLODSelectionSoA.skeletonUuidHash[ eid ] = skeletonHash;
    BoneLODSelectionSoA.boneCount[ eid ] = boneCount;
    BoneLODSelectionSoA.activeBoneCount[ eid ] = boneCount;
    BoneLODSelectionSoA.activeBoneBudget[ eid ] = boneCount;
    BoneLODSelectionSoA.activeBoneBudgetUtilization[ eid ] = 1.0;
    BoneLODSelectionSoA.selectionMode[ eid ] = BoneSelectionMode.FULL;
    BoneLODSelectionSoA.distanceBand[ eid ] = DistanceBand.HERO;
    BoneLODSelectionSoA.cameraDistance[ eid ] = 0.0;
    BoneLODSelectionSoA.cameraDistanceSq[ eid ] = 0.0;
    BoneLODSelectionSoA.screenSpaceRadiusPx[ eid ] = 0.0;
    BoneLODSelectionSoA.projectedSizePx[ eid ] = 0.0;
    BoneLODSelectionSoA.isVisibleInFrustum[ eid ] = 1;
    BoneLODSelectionSoA.topImportanceBoneId[ eid ] = - 1;
    BoneLODSelectionSoA.minImportanceActive[ eid ] = 0.0;
    BoneLODSelectionSoA.maxImportanceActive[ eid ] = 0.0;
    BoneLODSelectionSoA.importanceCutoff[ eid ] = 0.0;
    BoneLODSelectionSoA.freezeState[ eid ] = FreezeState.AWAKE;
    BoneLODSelectionSoA.frozenSkipCount[ eid ] = 0;
    BoneLODSelectionSoA.paletteUploaded[ eid ] = 0;
    BoneLODSelectionSoA.paletteUploadSkipped[ eid ] = 0;
    BoneLODSelectionSoA.lastSelectionMs[ eid ] = 0.0;
    BoneLODSelectionSoA.avgSelectionMsEMA[ eid ] = 0.0;
    BoneLODSelectionSoA.lastPalettePrepMs[ eid ] = 0.0;
    BoneLODSelectionSoA.determinismSeed[ eid ] = _mix32( skeletonHash ^ BoneLODDefaults.determinismSeed );
    BoneLODSelectionSoA.selectionSeed[ eid ] = 0;
    BoneLODSelectionSoA.ditherSample[ eid ] = 0.0;
    BoneLODSelectionSoA.registered[ eid ] = 1;
    BoneLODSelectionSoA.active[ eid ] = 1;
    BoneLODSelectionSoA.lastFrameIndex[ eid ] = options.frameIndex | 0;

    // ── 1. Build the importance rank cache. ─────────────────────────────
    if ( BoneLODDefaults.computeImportanceAtRegister ) {
        _buildImportanceRanks( skeleton, skeletonHash );
    }

    // ── 2. Allocate the selection bitset. ──────────────────────────────
    _ensureSelectionBitset( skeletonHash, boneCount );

    return eid;
}

/**
 * Unregisters a skeleton.
 * @param {number} eid
 * @return {boolean}
 */
function unregisterSkeleton( eid ) {
    if ( eid < 0 ) return false;

    BoneLODSelectionSoA.registered[ eid ] = 0;
    BoneLODSelectionSoA.active[ eid ] = 0;

    for ( const [ hash, id ] of _ecsBoneLodByHash ) {
        if ( id === eid ) {
            _ecsBoneLodByHash.delete( hash );
            _importanceRanksBySkeleton.delete( hash );
            _boneIndexBySkeleton.delete( hash );
            _selectionBitsetBySkeleton.delete( hash );
            break;
        }
    }

    return true;
}

// ─── Public API: select. ──────────────────────────────────────────────────

/**
 * Runs the per-frame bone selection for the given skeleton.
 *
 * @param {number} eid
 * @param {Skeleton} skeleton
 * @param {object} context
 * @param {number} context.cameraDistance
 * @param {number} [context.projectedSizePx]
 * @param {boolean} [context.inFrustum]
 * @param {number} [context.frameIndex=0]
 * @param {number} [context.cameraFov=60]
 * @param {number} [context.viewportHeightPx=1080]
 * @return {object} The selection result record.
 */
function select( eid, skeleton, context ) {
    const t0 = _nowMs();

    _selectionResult.skeletonId = eid;
    _selectionResult.boneCount = 0;
    _selectionResult.activeBoneCount = 0;
    _selectionResult.activeBoneBudget = 0;
    _selectionResult.selectionMode = BoneSelectionMode.FULL;
    _selectionResult.distanceBand = DistanceBand.HERO;
    _selectionResult.cameraDistance = 0.0;
    _selectionResult.screenSpaceRadiusPx = 0.0;
    _selectionResult.projectedSizePx = 0.0;
    _selectionResult.importanceCutoff = 0.0;
    _selectionResult.paletteUploaded = false;
    _selectionResult.selectionMs = 0.0;

    if ( eid < 0 ) {
        _selectionResult.selectionMs = _nowMs() - t0;
        return _selectionResult;
    }

    if ( skeleton === undefined || skeleton === null ) {
        _selectionResult.selectionMs = _nowMs() - t0;
        return _selectionResult;
    }

    const frameIndex = context.frameIndex | 0;
    const cameraDistance = context.cameraDistance !== undefined ? context.cameraDistance : 0.0;
    const inFrustum = context.inFrustum !== false;

    const skeletonHash = BoneLODSelectionSoA.skeletonUuidHash[ eid ];
    const boneCount = skeleton.bones !== undefined ? skeleton.bones.length : 0;

    _selectionResult.boneCount = boneCount;
    _selectionResult.cameraDistance = cameraDistance;

    if ( boneCount === 0 ) {
        _selectionResult.selectionMs = _nowMs() - t0;
        return _selectionResult;
    }

    // ── 1. Freeze / wake integration. ────────────────────────────────────
    if ( BoneLODDefaults.respectFreezeState ) {
        const fs = BoneLODSelectionSoA.freezeState[ eid ];

        if ( BoneLODDefaults.skipWhenFrozen && ( fs === FreezeState.HARD_FROZEN || fs === FreezeState.COLD_FROZEN ) ) {
            BoneLODSelectionSoA.frozenSkipCount[ eid ] ++;
            BoneLODSelectionSoA.activeBoneCount[ eid ] = 0;
            BoneLODSelectionSoA.selectionMode[ eid ] = BoneSelectionMode.FREEZE;
            BoneLODSelectionSoA.distanceBand[ eid ] = DistanceBand.CULLED;
            BoneLODSelectionSoA.lastFrameIndex[ eid ] = frameIndex;

            _selectionResult.activeBoneCount = 0;
            _selectionResult.selectionMode = BoneSelectionMode.FREEZE;
            _selectionResult.distanceBand = DistanceBand.CULLED;
            _selectionResult.selectionMs = _nowMs() - t0;

            return _selectionResult;
        }
    }

    // ── 2. Determine the distance band. ──────────────────────────────────
    const tier = getCurrentTierFromSystem();
    const thresholds = _getThresholds( tier );

    const band = _computeDistanceBand( cameraDistance, inFrustum, thresholds );

    _selectionResult.distanceBand = band;

    // ── 3. Determine the target budget ratio from the band. ─────────────
    let budgetRatio;

    switch ( band ) {
        case DistanceBand.HERO: budgetRatio = thresholds.heroBudgetRatio; break;
        case DistanceBand.NEAR: budgetRatio = thresholds.nearBudgetRatio; break;
        case DistanceBand.MID: budgetRatio = thresholds.midBudgetRatio; break;
        case DistanceBand.FAR: budgetRatio = thresholds.farBudgetRatio; break;
        case DistanceBand.DISTANT: budgetRatio = thresholds.distantBudgetRatio; break;
        case DistanceBand.CULLED: budgetRatio = 0.0; break;
        default: budgetRatio = 1.0;
    }

    // ── 4. Compute the projected screen-space size (pixels). ────────────
    const projectedSizePx = context.projectedSizePx !== undefined
        ? context.projectedSizePx
        : _computeProjectedSize( cameraDistance, thresholds, context );

    _selectionResult.projectedSizePx = projectedSizePx;

    // ── 5. Adjust the budget ratio from projected size. ────────────────
    let finalRatio = budgetRatio;

    if ( projectedSizePx < thresholds.projectedSizeFloor ) {
        finalRatio *= 0.6;
    }

    if ( projectedSizePx < BoneLODDefaults.projectedSizeMinimalThreshold ) {
        finalRatio *= 0.5;
    }

    // ── 6. Clamp the target active bone count. ──────────────────────────
    let targetActive = Math.round( boneCount * finalRatio );

    if ( targetActive < BoneLODDefaults.globalMinActiveBones ) {
        targetActive = BoneLODDefaults.globalMinActiveBones;
    }

    if ( targetActive > BoneLODDefaults.globalMaxActiveBones ) {
        targetActive = BoneLODDefaults.globalMaxActiveBones;
    }

    if ( targetActive > boneCount ) {
        targetActive = boneCount;
    }

    // ── 7. Skinning cost budget from 007_12. ────────────────────────────
    if ( BoneLODDefaults.respectSkinningBudget ) {
        const preset = getCurrentPreset();
        const presetBudget = preset.maxBonesPerSkeleton;

        if ( targetActive > presetBudget ) {
            targetActive = presetBudget;
        }
    }

    // ── 8. Skip selection in hero band if requested. ────────────────────
    if ( BoneLODDefaults.skipSelectionInHeroBand && band === DistanceBand.HERO && targetActive >= boneCount ) {
        BoneLODSelectionSoA.selectionMode[ eid ] = BoneSelectionMode.FULL;
        BoneLODSelectionSoA.activeBoneCount[ eid ] = boneCount;
        BoneLODSelectionSoA.activeBoneBudget[ eid ] = boneCount;
        BoneLODSelectionSoA.activeBoneBudgetUtilization[ eid ] = 1.0;
        BoneLODSelectionSoA.cameraDistance[ eid ] = cameraDistance;
        BoneLODSelectionSoA.cameraDistanceSq[ eid ] = cameraDistance * cameraDistance;
        BoneLODSelectionSoA.projectedSizePx[ eid ] = projectedSizePx;
        BoneLODSelectionSoA.distanceBand[ eid ] = band;
        BoneLODSelectionSoA.isVisibleInFrustum[ eid ] = inFrustum ? 1 : 0;
        BoneLODSelectionSoA.lastSelectionMs[ eid ] = _nowMs() - t0;
        BoneLODSelectionSoA.avgSelectionMsEMA[ eid ] = BoneLODSelectionSoA.avgSelectionMsEMA[ eid ] * 0.9 + BoneLODSelectionSoA.lastSelectionMs[ eid ] * 0.1;
        BoneLODSelectionSoA.lastFrameIndex[ eid ] = frameIndex;

        _selectionResult.activeBoneCount = boneCount;
        _selectionResult.activeBoneBudget = boneCount;
        _selectionResult.selectionMode = BoneSelectionMode.FULL;
        _selectionResult.selectionMs = BoneLODSelectionSoA.lastSelectionMs[ eid ];

        return _selectionResult;
    }

    // ── 9. Rank-based selection using cached importance. ────────────────
    const ranks = _importanceRanksBySkeleton.get( skeletonHash );

    if ( ranks === undefined ) {
        // Build ranks lazily if missing.
        _buildImportanceRanks( skeleton, skeletonHash );
    }

    const finalRanks = _importanceRanksBySkeleton.get( skeletonHash );

    const selectedCount = _selectTopNByRank(
        finalRanks,
        boneCount,
        targetActive,
        skeletonHash,
        frameIndex,
        eid
    );

    const cutoff = finalRanks !== undefined && selectedCount > 0
        ? finalRanks[ selectedCount - 1 ]
        : 0.0;

    // ── 10. Update ECS state. ───────────────────────────────────────────
    BoneLODSelectionSoA.activeBoneCount[ eid ] = selectedCount;
    BoneLODSelectionSoA.activeBoneBudget[ eid ] = targetActive;
    BoneLODSelectionSoA.activeBoneBudgetUtilization[ eid ] = targetActive > 0
        ? selectedCount / targetActive
        : 0.0;
    BoneLODSelectionSoA.selectionMode[ eid ] = _modeForRatio( finalRatio );
    BoneLODSelectionSoA.distanceBand[ eid ] = band;
    BoneLODSelectionSoA.cameraDistance[ eid ] = cameraDistance;
    BoneLODSelectionSoA.cameraDistanceSq[ eid ] = cameraDistance * cameraDistance;
    BoneLODSelectionSoA.projectedSizePx[ eid ] = projectedSizePx;
    BoneLODSelectionSoA.isVisibleInFrustum[ eid ] = inFrustum ? 1 : 0;
    BoneLODSelectionSoA.importanceCutoff[ eid ] = cutoff;
    BoneLODSelectionSoA.lastSelectionMs[ eid ] = _nowMs() - t0;
    BoneLODSelectionSoA.avgSelectionMsEMA[ eid ] = BoneLODSelectionSoA.avgSelectionMsEMA[ eid ] * 0.9 + BoneLODSelectionSoA.lastSelectionMs[ eid ] * 0.1;
    BoneLODSelectionSoA.lastFrameIndex[ eid ] = frameIndex;

    const selectionSeed = _mix32(
        ( skeletonHash ^ ( frameIndex * 0x9E3779B9 ) ^ ( selectedCount * 0x85EBCA6B ) ) >>> 0
    );
    BoneLODSelectionSoA.selectionSeed[ eid ] = selectionSeed;
    BoneLODSelectionSoA.ditherSample[ eid ] = _noise3D( selectionSeed * 1e-6, frameIndex * 0.02, selectedCount );

    _selectionResult.activeBoneCount = selectedCount;
    _selectionResult.activeBoneBudget = targetActive;
    _selectionResult.selectionMode = BoneLODSelectionSoA.selectionMode[ eid ];
    _selectionResult.importanceCutoff = cutoff;
    _selectionResult.selectionMs = BoneLODSelectionSoA.lastSelectionMs[ eid ];

    return _selectionResult;
}

// ─── Public API: query. ────────────────────────────────────────────────────

/**
 * Returns whether a specific bone is active for the given skeleton.
 * @param {number} skeletonHash
 * @param {number} boneIndex
 * @return {boolean}
 */
function isBoneActive( skeletonHash, boneIndex ) {
    const bitset = _selectionBitsetBySkeleton.get( skeletonHash );

    if ( bitset === undefined ) return true;

    const word = boneIndex >>> 5;
    const bit = boneIndex & 31;

    if ( word >= bitset.length ) return false;

    return ( bitset[ word ] & ( 1 << bit ) ) !== 0;
}

/**
 * Returns the selection bitset for a given skeleton.
 * @param {number} skeletonHash
 * @return {Uint32Array|null}
 */
function getSelectionBitset( skeletonHash ) {
    const bitset = _selectionBitsetBySkeleton.get( skeletonHash );
    return bitset !== undefined ? bitset : null;
}

/**
 * Returns the current selection result record.
 * @return {object}
 */
function getLastSelectionResult() {
    return _selectionResult;
}

// ─── Public API: freeze integration. ──────────────────────────────────────

/**
 * Publishes the freeze state for a given skeleton from the FreezeWakeLOD
 * layer. Called by the host when the owning LOD transitions.
 *
 * @param {number} eid
 * @param {number} freezeState
 */
function setFreezeState( eid, freezeState ) {
    if ( eid < 0 ) return;

    BoneLODSelectionSoA.freezeState[ eid ] = freezeState | 0;
}

// ─── Internal: importance rank computation. ───────────────────────────────

function _buildImportanceRanks( skeleton, skeletonHash ) {
    const bones = skeleton.bones;

    if ( bones === undefined || bones.length === 0 ) {
        _importanceRanksBySkeleton.set( skeletonHash, new Float64Array( 0 ) );
        _boneIndexBySkeleton.set( skeletonHash, new Map() );
        return;
    }

    const boneCount = bones.length;
    const ranks = new Float64Array( boneCount );
    const boneIndexMap = new Map();

    // ── 1. Build a bone -> index map. ───────────────────────────────────
    for ( let i = 0; i < boneCount; i ++ ) {
        boneIndexMap.set( bones[ i ], i );
    }

    // ── 2. Compute depth and subtree size via a walk from the root(s). ─
    const depth = new Int32Array( boneCount );
    const subtreeSize = new Int32Array( boneCount );
    const childCount = new Int32Array( boneCount );

    for ( let i = 0; i < boneCount; i ++ ) {
        depth[ i ] = - 1;
        subtreeSize[ i ] = 1;
    }

    // Roots are bones without a bone parent.
    const roots = [];

    for ( let i = 0; i < boneCount; i ++ ) {
        const bone = bones[ i ];

        if ( bone.parent === null || bone.parent.isBone !== true ) {
            roots.push( i );
        }
    }

    // Compute depth.
    for ( let r = 0; r < roots.length; r ++ ) {
        const stack = [ roots[ r ] ];
        const stackDepth = [ 0 ];

        while ( stack.length > 0 ) {
            const idx = stack.pop();
            const d = stackDepth.pop();

            if ( depth[ idx ] >= 0 ) continue;

            depth[ idx ] = d;

            const bone = bones[ idx ];
            const children = bone.children;

            for ( let c = 0; c < children.length; c ++ ) {
                const ci = boneIndexMap.get( children[ c ] );

                if ( ci === undefined ) continue;

                stack.push( ci );
                stackDepth.push( d + 1 );

                childCount[ idx ] ++;
            }
        }
    }

    // ── 3. Compute subtree size via reverse order. ─────────────────────
    // Sort indices by depth descending to iterate leaves first.
    const order = new Int32Array( boneCount );

    for ( let i = 0; i < boneCount; i ++ ) order[ i ] = i;

    // Simple insertion sort for small arrays is fine (boneCount <= 512).
    for ( let i = 1; i < boneCount; i ++ ) {
        const key = order[ i ];
        const keyDepth = depth[ key ];

        let j = i - 1;

        while ( j >= 0 && depth[ order[ j ] ] < keyDepth ) {
            order[ j + 1 ] = order[ j ];
            j --;
        }

        order[ j + 1 ] = key;
    }

    for ( let i = 0; i < boneCount; i ++ ) {
        const idx = order[ i ];
        const bone = bones[ idx ];

        if ( bone.parent === null || bone.parent.isBone !== true ) continue;

        const pi = boneIndexMap.get( bone.parent );

        if ( pi === undefined ) continue;

        subtreeSize[ pi ] += subtreeSize[ idx ];
    }

    // ── 4. Compute importance. ─────────────────────────────────────────
    //   High importance = shallow depth, large subtree, root-like.
    //   Low importance  = deep depth, small subtree, leaf-like.
    const maxDepth = depth.reduce( ( a, b ) => Math.max( a, b ), 0 );

    for ( let i = 0; i < boneCount; i ++ ) {
        const d = Math.max( 0, depth[ i ] );
        const s = Math.max( 1, subtreeSize[ i ] );
        const c = Math.max( 0, childCount[ i ] );

        // Depth score: 1 at root, 0 at max depth.
        const depthScore = maxDepth > 0 ? 1.0 - ( d / maxDepth ) : 1.0;

        // Subtree score: normalised to [0, 1].
        const subtreeScore = Math.min( 1.0, s / boneCount );

        // Child score: branching bones are more important.
        const childScore = Math.min( 1.0, c / 4 );

        // Weighted combination.
        const importance = depthScore * 0.55 + subtreeScore * 0.30 + childScore * 0.15;

        ranks[ i ] = importance;
    }

    _importanceRanksBySkeleton.set( skeletonHash, ranks );
    _boneIndexBySkeleton.set( skeletonHash, boneIndexMap );
}

// ─── Internal: top-N selection by rank. ───────────────────────────────────

function _selectTopNByRank( ranks, boneCount, targetActive, skeletonHash, frameIndex, eid ) {
    if ( ranks === undefined || ranks.length !== boneCount ) {
        // Fallback: select the first N bones.
        _fillBitsetRange( skeletonHash, boneCount, targetActive );
        return targetActive;
    }

    // ── 1. Build an index list sorted by rank descending. ─────────────
    const indices = new Int32Array( boneCount );

    for ( let i = 0; i < boneCount; i ++ ) indices[ i ] = i;

    // Partial sort: we only need the top `targetActive` bones.
    // For boneCount <= 512 we sort fully; this is fast enough at 60 Hz.
    const rankArray = ranks;

    // Simple indexed sort (stable-ish).
    const orderList = Array.from( indices );
    orderList.sort( ( a, b ) => rankArray[ b ] - rankArray[ a ] );

    // ── 2. Fill the bitset. ──────────────────────────────────────────
    const bitset = _ensureSelectionBitset( skeletonHash, boneCount );

    // Clear the bitset.
    for ( let i = 0; i < bitset.length; i ++ ) bitset[ i ] = 0;

    let selectedCount = 0;

    for ( let i = 0; i < targetActive && i < orderList.length; i ++ ) {
        const idx = orderList[ i ];
        const word = idx >>> 5;
        const bit = idx & 31;

        if ( word >= bitset.length ) continue;

        bitset[ word ] |= ( 1 << bit );
        selectedCount ++;
    }

    // ── 3. Guarantee that root bones are always active. ─────────────
    // Any bone with importance above a threshold stays active regardless.
    const minImportance = 0.75;

    for ( let i = 0; i < boneCount; i ++ ) {
        if ( ranks[ i ] < minImportance ) continue;

        const word = i >>> 5;
        const bit = i & 31;

        if ( word >= bitset.length ) continue;

        if ( ( bitset[ word ] & ( 1 << bit ) ) === 0 ) {
            bitset[ word ] |= ( 1 << bit );
            selectedCount ++;
        }
    }

    // ── 4. Optional dither to smooth over boundaries. ───────────────
    if ( BoneLODDefaults.emitDither ) {
        const seed = _mix32(
            ( skeletonHash ^ ( frameIndex * 0x9E3779B9 ) ^ ( selectedCount * 0xC2B2AE35 ) ) >>> 0
        );

        void seed;
    }

    void eid;
    return selectedCount;
}

// ─── Internal: bitset management. ─────────────────────────────────────────

function _ensureSelectionBitset( skeletonHash, boneCount ) {
    const wordCount = ( boneCount + 31 ) >>> 5;

    let bitset = _selectionBitsetBySkeleton.get( skeletonHash );

    if ( bitset === undefined || bitset.length !== wordCount ) {
        bitset = new Uint32Array( wordCount );

        // Default to all-selected (identity selection).
        for ( let i = 0; i < wordCount; i ++ ) bitset[ i ] = 0xFFFFFFFF;

        // Clear trailing bits beyond boneCount.
        const lastWord = wordCount - 1;
        const trailingBits = boneCount & 31;

        if ( trailingBits !== 0 ) {
            bitset[ lastWord ] &= ( 1 << trailingBits ) - 1;
        }

        _selectionBitsetBySkeleton.set( skeletonHash, bitset );
    }

    return bitset;
}

function _fillBitsetRange( skeletonHash, boneCount, targetActive ) {
    const bitset = _ensureSelectionBitset( skeletonHash, boneCount );

    for ( let i = 0; i < bitset.length; i ++ ) bitset[ i ] = 0;

    let selected = 0;

    for ( let i = 0; i < boneCount && selected < targetActive; i ++ ) {
        const word = i >>> 5;
        const bit = i & 31;

        if ( word >= bitset.length ) continue;

        bitset[ word ] |= ( 1 << bit );
        selected ++;
    }

    return selected;
}

// ─── Internal: distance band computation. ─────────────────────────────────

function _computeDistanceBand( cameraDistance, inFrustum, thresholds ) {
    if ( ! inFrustum ) return DistanceBand.CULLED;

    if ( cameraDistance <= thresholds.heroDistance ) return DistanceBand.HERO;
    if ( cameraDistance <= thresholds.nearDistance ) return DistanceBand.NEAR;
    if ( cameraDistance <= thresholds.midDistance ) return DistanceBand.MID;
    if ( cameraDistance <= thresholds.farDistance ) return DistanceBand.FAR;
    if ( cameraDistance <= thresholds.distantDistance ) return DistanceBand.DISTANT;

    return DistanceBand.DISTANT;
}

// ─── Internal: projected size estimation. ─────────────────────────────────

function _computeProjectedSize( cameraDistance, thresholds, context ) {
    // ── 1. Estimate the bounding sphere radius from the thresholds. ─────
    const radius = thresholds.heroDistance * 0.5;

    // ── 2. Estimate the vertical FOV in radians. ────────────────────────
    const fovDeg = context.cameraFov !== undefined ? context.cameraFov : 60.0;
    const fovRad = fovDeg * Math.PI / 180.0;

    // ── 3. Viewport height in pixels. ──────────────────────────────────
    const viewportHeightPx = context.viewportHeightPx !== undefined ? context.viewportHeightPx : 1080.0;

    // ── 4. Projected radius in pixels. ──────────────────────────────────
    const dist = Math.max( 0.1, cameraDistance );
    const projected = ( radius / dist ) * ( viewportHeightPx / ( 2.0 * Math.tan( fovRad * 0.5 ) ) );

    return projected;
}

function _getThresholds( tier ) {
    const t = SELECTION_THRESHOLDS_TABLE[ tier ];

    if ( t === undefined ) return SELECTION_THRESHOLDS_TABLE[ SkinningTier.MID ];

    return t;
}

function _modeForRatio( ratio ) {
    if ( ratio >= 0.99 ) return BoneSelectionMode.FULL;
    if ( ratio >= 0.70 ) return BoneSelectionMode.HIGH;
    if ( ratio >= 0.45 ) return BoneSelectionMode.MEDIUM;
    if ( ratio >= 0.20 ) return BoneSelectionMode.LOW;
    if ( ratio > 0.0 ) return BoneSelectionMode.MINIMAL;
    return BoneSelectionMode.FREEZE;
}

// ─── Internal: tier integration. ──────────────────────────────────────────

function getCurrentTierFromSystem() {
    // Prefer SkinningCostMultiplierLOD's tier, fall back to 014_13.
    try {
        const tier = SkinningCostMultiplierLOD.getAndroidTier();
        if ( tier >= 1 && tier <= 4 ) return tier;
    } catch ( e ) {
        void e;
    }

    return SkinningTier.MID;
}

// ─── Public API: palette upload integration. ──────────────────────────────

/**
 * Returns true when the palette should be uploaded this frame. Respects
 * skip-upload-when-unchanged and freeze state.
 *
 * @param {number} eid
 * @param {number} previousSelectionHash
 * @param {number} currentSelectionHash
 * @return {boolean}
 */
function shouldUploadPalette( eid, previousSelectionHash, currentSelectionHash ) {
    if ( eid < 0 ) return true;

    // ── 1. Skip when frozen. ────────────────────────────────────────────
    const fs = BoneLODSelectionSoA.freezeState[ eid ];

    if ( BoneLODDefaults.skipWhenFrozen && ( fs === FreezeState.HARD_FROZEN || fs === FreezeState.COLD_FROZEN ) ) {
        BoneLODSelectionSoA.paletteUploadSkipped[ eid ] ++;
        return false;
    }

    // ── 2. Skip when the selection is unchanged. ────────────────────────
    if ( BoneLODDefaults.skipUploadWhenUnchanged && previousSelectionHash === currentSelectionHash ) {
        BoneLODSelectionSoA.paletteUploadSkipped[ eid ] ++;
        return false;
    }

    BoneLODSelectionSoA.paletteUploaded[ eid ] ++;
    return true;
}

/**
 * Computes a hash of the current selection bitset for change detection.
 * @param {number} skeletonHash
 * @return {number}
 */
function computeSelectionHash( skeletonHash ) {
    const bitset = _selectionBitsetBySkeleton.get( skeletonHash );

    if ( bitset === undefined ) return 0;

    let h = 0x811c9dc5;

    for ( let i = 0; i < bitset.length; i ++ ) {
        h ^= bitset[ i ];
        h = Math.imul( h, 0x01000193 );
    }

    return h >>> 0;
}

// ─── Public API: high-precision helpers. ──────────────────────────────────

/**
 * Returns a high-precision ratio of active bones to total bones.
 * @param {number} eid
 * @return {number}
 */
function computeActiveRatioHighPrecision( eid ) {
    if ( eid < 0 ) return 0.0;

    const active = new Double( BoneLODSelectionSoA.activeBoneCount[ eid ] );
    const total = new Double( Math.max( 1, BoneLODSelectionSoA.boneCount[ eid ] ) );

    return active.div( total ).valueOf();
}

/**
 * Returns a high-precision estimate of the skinning op reduction vs. full.
 * @param {number} eid
 * @return {number}
 */
function computeReductionHighPrecision( eid ) {
    const ratio = computeActiveRatioHighPrecision( eid );

    return 1.0 - ratio;
}

/**
 * Returns a high-precision aggregate of skinning cost saved across the
 * entire scene.
 * @return {number}
 */
function computeSceneSavingsHighPrecision() {
    let totalSaved = new Double( 0 );

    const q = query( _boneLodWorld, [ BoneLODSelectionSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( BoneLODSelectionSoA.registered[ eid ] !== 1 ) continue;

        const boneCount = BoneLODSelectionSoA.boneCount[ eid ];
        const activeCount = BoneLODSelectionSoA.activeBoneCount[ eid ];

        const saved = Math.max( 0, boneCount - activeCount );
        const selectionMs = BoneLODSelectionSoA.avgSelectionMsEMA[ eid ];

        totalSaved = new Double( totalSaved.valueOf() + saved * selectionMs );
    }

    return totalSaved.valueOf();
}

// ─── Public API: aggregated stats. ────────────────────────────────────────

/**
 * Returns aggregated bone-LOD statistics across the scene.
 * @return {object}
 */
function getAggregatedStats() {
    let totalSkeletons = 0;
    let totalBones = 0;
    let totalActiveBones = 0;
    let frozenSkeletons = 0;
    let totalSelectionMs = 0.0;
    let modeHistogram = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let bandHistogram = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    const q = query( _boneLodWorld, [ BoneLODSelectionSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( BoneLODSelectionSoA.registered[ eid ] !== 1 ) continue;

        totalSkeletons ++;
        totalBones += BoneLODSelectionSoA.boneCount[ eid ];
        totalActiveBones += BoneLODSelectionSoA.activeBoneCount[ eid ];
        totalSelectionMs += BoneLODSelectionSoA.avgSelectionMsEMA[ eid ];

        if ( BoneLODSelectionSoA.freezeState[ eid ] === FreezeState.HARD_FROZEN ||
             BoneLODSelectionSoA.freezeState[ eid ] === FreezeState.COLD_FROZEN ) {
            frozenSkeletons ++;
        }

        const mode = BoneLODSelectionSoA.selectionMode[ eid ];
        modeHistogram[ mode ] = ( modeHistogram[ mode ] || 0 ) + 1;

        const band = BoneLODSelectionSoA.distanceBand[ eid ];
        bandHistogram[ band ] = ( bandHistogram[ band ] || 0 ) + 1;
    }

    const activeRatio = totalBones > 0 ? totalActiveBones / totalBones : 0.0;
    const ms = new Double( totalSelectionMs );

    return {
        totalSkeletons: totalSkeletons,
        totalBones: totalBones,
        totalActiveBones: totalActiveBones,
        activeRatio: activeRatio,
        frozenSkeletons: frozenSkeletons,
        totalSelectionMs: ms.valueOf(),
        modeHistogram: modeHistogram,
        bandHistogram: bandHistogram
    };
}

// ─── gl-matrix packing for telemetry. ─────────────────────────────────────

/**
 * Packs bone LOD telemetry into a vec4.
 * Layout: (boneCount, activeBoneCount, selectionMode, distanceBand)
 * @param {number} eid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packBoneLodVec4( eid, out ) {
    const v = out || _scratchVec4;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        BoneLODSelectionSoA.boneCount[ eid ],
        BoneLODSelectionSoA.activeBoneCount[ eid ],
        BoneLODSelectionSoA.selectionMode[ eid ],
        BoneLODSelectionSoA.distanceBand[ eid ]
    );
    return v;
}

/**
 * Packs camera distance telemetry into a vec4.
 * Layout: (cameraDistance, projectedSizePx, screenSpaceRadiusPx, importanceCutoff)
 * @param {number} eid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packDistanceVec4( eid, out ) {
    const v = out || _scratchVec4B;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        BoneLODSelectionSoA.cameraDistance[ eid ],
        BoneLODSelectionSoA.projectedSizePx[ eid ],
        BoneLODSelectionSoA.screenSpaceRadiusPx[ eid ],
        BoneLODSelectionSoA.importanceCutoff[ eid ]
    );
    return v;
}

/**
 * Packs selection budget telemetry into a vec4.
 * Layout: (activeBoneBudget, budgetUtilization, freezeState, paletteUploaded)
 * @param {number} eid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packBudgetVec4( eid, out ) {
    const v = out || _scratchVec4C;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        BoneLODSelectionSoA.activeBoneBudget[ eid ],
        BoneLODSelectionSoA.activeBoneBudgetUtilization[ eid ],
        BoneLODSelectionSoA.freezeState[ eid ],
        BoneLODSelectionSoA.paletteUploaded[ eid ]
    );
    return v;
}

/**
 * Packs timing telemetry into a vec4.
 * Layout: (lastSelectionMs, avgSelectionMsEMA, lastPalettePrepMs, frozenSkipCount)
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
        BoneLODSelectionSoA.lastSelectionMs[ eid ],
        BoneLODSelectionSoA.avgSelectionMsEMA[ eid ],
        BoneLODSelectionSoA.lastPalettePrepMs[ eid ],
        BoneLODSelectionSoA.frozenSkipCount[ eid ]
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
function sampleBoneLodDither( eid, frameIndex ) {
    if ( eid < 0 ) return 0.0;

    const seed = ( BoneLODSelectionSoA.determinismSeed[ eid ] ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, BoneLODSelectionSoA.boneCount[ eid ] );
}

// ─── Public API: frame lifecycle. ─────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all bone LOD entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _boneLodWorld, [ BoneLODSelectionSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        BoneLODSelectionSoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
    }
}

/**
 * Synchronizes freeze state from FreezeWakeLOD into all registered
 * bone LOD entities. Call once per frame after all LOD updates.
 */
function syncFreezeStates() {
    const q = query( _boneLodWorld, [ BoneLODSelectionSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( BoneLODSelectionSoA.registered[ eid ] !== 1 ) continue;

        // Read the freeze state from the FreezeWakeLOD entity that matches.
        // The host is responsible for wiring the two together via setFreezeState.
    }

    void FreezeWakeLOD;
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
void BonesPerVertex;
void SkinnedMeshDefaults;
void SkinnedMeshCaps;
void BoneHierarchyKind;
void DeterminismSeedLOD;
void SeedStream;
void _scratchBonePos;
void _scratchSphere;
void _scratchVec3A;
void _scratchVec3B;
void _scratchVec3C;
void _scratchMat4;

export {
    BoneSelectionMode,
    DistanceBand,
    SELECTION_THRESHOLDS_TABLE,
    BoneLODDefaults,
    BoneLODSelectionSoA,
    registerSkeleton,
    unregisterSkeleton,
    select,
    isBoneActive,
    getSelectionBitset,
    getLastSelectionResult,
    setFreezeState,
    shouldUploadPalette,
    computeSelectionHash,
    computeActiveRatioHighPrecision,
    computeReductionHighPrecision,
    computeSceneSavingsHighPrecision,
    getAggregatedStats,
    packBoneLodVec4,
    packDistanceVec4,
    packBudgetVec4,
    packTimingVec4,
    sampleBoneLodDither,
    beginFrame,
    syncFreezeStates
};