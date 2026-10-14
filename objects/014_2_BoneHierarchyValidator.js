// file number : 014_2
// full path name : src/objects/014_2_BoneHierarchyValidator.js
// description : Validates an arbitrary Bone tree before skinning is applied. Checks for cycles, orphan bones not reachable from the root, duplicate names, missing parents, excessive depth beyond a configurable cap, branching factors beyond a configurable cap, non-invertible world matrices, NaN / Inf transforms, and degenerate bone scales. Returns a structured report with a per-bone error bitmask so the host can repair or reject the rig deterministically. Uses the walker from 014_1 for traversal, bitecs SoA for per-bone error state, double.js for high-precision determinant checks, gl-matrix for matrix inversion and plane-distance math, and simplex-noise for deterministic error-priority dithering during repair ordering.
// best for : Loading user-authored rigs, network-replicated skeletons, procedural rigs, catching malformed data before it reaches the GPU, deterministic repair across devices, forensic comparison of imported rigs on Android 64-bit.
// license : MIT

import { Bone } from './001_Bone.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Quaternion } from '../math/007_Quaternion.js';

import { BoneHierarchyKind, SkinnedMeshDefaults, SkinnedMeshCaps } from './014_0_SkinnedMeshDefaults.js';
import { walk, index, getDepth, getChildCount, isCycleDetected, resetVisited, BoneWalkSoA } from './014_1_BoneHierarchyWalker.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchMat4Inv = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchVec3C = new Float64Array( 3 );
const _scratchQuat = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── Error bitmask constants. ───────────────────────────────────────────────
const BoneError = Object.freeze( {
    NONE: 0,
    CYCLE: 1 << 0,
    ORPHAN: 1 << 1,
    DUPLICATE_NAME: 1 << 2,
    MISSING_PARENT: 1 << 3,
    EXCESSIVE_DEPTH: 1 << 4,
    EXCESSIVE_BRANCHING: 1 << 5,
    NON_INVERTIBLE_MATRIX: 1 << 6,
    NAN_TRANSFORM: 1 << 7,
    INF_TRANSFORM: 1 << 8,
    DEGENERATE_SCALE: 1 << 9,
    ZERO_SCALE: 1 << 10,
    NON_UNIFORM_SCALE: 1 << 11,
    NEGATIVE_SCALE: 1 << 12,
    UNSTABLE_QUATERNION: 1 << 13,
    ORPHAN_SUBTREE: 1 << 14,
    DEPTH_OVERFLOW: 1 << 15,
    BRANCH_OVERFLOW: 1 << 16,
    TOTAL_BONE_OVERFLOW: 1 << 17,
    DUPLICATE_SIBLING_NAME: 1 << 18,
    MISSING_INVERSE: 1 << 19,
    STALE_INVERSE: 1 << 20
} );

// ─── Validation severity constants. ─────────────────────────────────────────
const ValidationSeverity = Object.freeze( {
    OK: 0,
    INFO: 1,
    WARNING: 2,
    ERROR: 3,
    FATAL: 4
} );

// ─── Repair strategy constants. ─────────────────────────────────────────────
const RepairStrategy = Object.freeze( {
    NONE: 0,
    CLAMP_DEPTH: 1,
    CLAMP_BRANCHING: 2,
    REPARENT_ORPHANS: 3,
    RENAME_DUPLICATES: 4,
    FIX_NAN: 5,
    FIX_DEGENERATE_SCALE: 6,
    RECOMPUTE_INVERSES: 7,
    ALL: 255
} );

// ─── ECS world + Validation SoA component (bitecs). ────────────────────────
const _validationWorld = createWorld();

const BoneValidationSoA = defineComponent( {
    boneId: Types.i32,
    errorMask: Types.i32,
    severity: Types.i32,
    depth: Types.i32,
    siblingIndex: Types.i32,
    childCount: Types.i32,
    duplicateNameCount: Types.i32,
    determinant: Types.f64,
    scaleX: Types.f64,
    scaleY: Types.f64,
    scaleZ: Types.f64,
    quatLength: Types.f64,
    repairSuggested: Types.i32,
    repaired: Types.ui8,
    repairFrame: Types.i32,
    ditherSample: Types.f64,
    validationOrder: Types.i32
} );

// ─── Validation result record. ──────────────────────────────────────────────
const _validationResult = {
    rootBone: null,
    totalBones: 0,
    totalErrors: 0,
    worstSeverity: ValidationSeverity.OK,
    errorMaskAggregate: 0,
    hierarchyKind: BoneHierarchyKind.UNKNOWN,
    maxDepth: 0,
    maxBranchingFactor: 0,
    cycleCount: 0,
    orphanCount: 0,
    duplicateNameCount: 0,
    nonInvertibleCount: 0,
    nanTransformCount: 0,
    degenerateScaleCount: 0,
    lastValidationMs: 0.0,
    fatalErrors: [],
    warningErrors: [],
    perBoneErrors: null,
    repairPlan: null
};

// ─── Per-bone ECS entity cache. ─────────────────────────────────────────────
const _ecsValidationByBone = new WeakMap();

// ─── Name registry (detects duplicates). ────────────────────────────────────
const _nameRegistry = new Map();

// ─── Deterministic validation-order priority. ───────────────────────────────
const _priorityByErrorBit = new Map();

// ─── Public API: validate. ──────────────────────────────────────────────────

/**
 * Validates the bone hierarchy rooted at `root` against the current
 * Android tier caps and the global hard caps. Returns a structured report.
 *
 * @param {Bone} root
 * @param {object} [options]
 * @param {number} [options.frameIndex=0]
 * @param {boolean} [options.checkInverses=false] - Requires a Skeleton.
 * @param {object} [options.skeleton] - Optional Skeleton for inverse checks.
 * @return {object} The validation result record.
 */
function validate( root, options = {} ) {
    const t0 = _nowMs();
    const frameIndex = options.frameIndex | 0;
    const checkInverses = options.checkInverses === true;
    const skeleton = options.skeleton !== undefined ? options.skeleton : null;

    // ── 1. Reset the result record. ────────────────────────────────────────
    _validationResult.rootBone = root;
    _validationResult.totalBones = 0;
    _validationResult.totalErrors = 0;
    _validationResult.worstSeverity = ValidationSeverity.OK;
    _validationResult.errorMaskAggregate = 0;
    _validationResult.hierarchyKind = BoneHierarchyKind.UNKNOWN;
    _validationResult.maxDepth = 0;
    _validationResult.maxBranchingFactor = 0;
    _validationResult.cycleCount = 0;
    _validationResult.orphanCount = 0;
    _validationResult.duplicateNameCount = 0;
    _validationResult.nonInvertibleCount = 0;
    _validationResult.nanTransformCount = 0;
    _validationResult.degenerateScaleCount = 0;
    _validationResult.lastValidationMs = 0.0;
    _validationResult.fatalErrors.length = 0;
    _validationResult.warningErrors.length = 0;
    _validationResult.repairPlan = null;

    if ( root === null || root === undefined ) {
        _validationResult.lastValidationMs = _nowMs() - t0;
        return _validationResult;
    }

    // ── 2. Reset walker state and rebuild the depth / path index. ─────────
    resetVisited();
    const walkResult = index( root, frameIndex );

    _validationResult.totalBones = walkResult.totalBones;
    _validationResult.maxDepth = walkResult.maxDepth;
    _validationResult.maxBranchingFactor = walkResult.maxBranchingFactor;
    _validationResult.hierarchyKind = walkResult.branchKindDetected;

    // ── 3. Reset name registry and pre-seed with bone names. ──────────────
    _nameRegistry.clear();

    // ── 4. Validate each bone via the walker (iterative, no recursion). ───
    let validationOrder = 0;

    walk( root, ( bone, depth, sibling ) => {
        if ( bone === null || bone === undefined ) return;

        const eid = _ensureValidationEntity( bone );

        BoneValidationSoA.boneId[ eid ] = bone.id;
        BoneValidationSoA.depth[ eid ] = depth;
        BoneValidationSoA.siblingIndex[ eid ] = sibling;
        BoneValidationSoA.childCount[ eid ] = bone.children.length;
        BoneValidationSoA.errorMask[ eid ] = BoneError.NONE;
        BoneValidationSoA.repaired[ eid ] = 0;
        BoneValidationSoA.repairFrame[ eid ] = - 1;
        BoneValidationSoA.validationOrder[ eid ] = validationOrder ++;

        let mask = BoneError.NONE;

        // ── 4a. Cycle detection. ───────────────────────────────────────────
        if ( isCycleDetected( bone ) ) {
            mask |= BoneError.CYCLE;
            _validationResult.cycleCount ++;
            _validationResult.fatalErrors.push( _makeErrorRecord( bone, BoneError.CYCLE, depth, 'Cycle detected' ) );
        }

        // ── 4b. Depth cap. ─────────────────────────────────────────────────
        if ( depth > SkinnedMeshDefaults.maxHierarchyDepth ) {
            mask |= BoneError.EXCESSIVE_DEPTH;
            _validationResult.warningErrors.push( _makeErrorRecord( bone, BoneError.EXCESSIVE_DEPTH, depth, 'Depth exceeds tier cap' ) );
        }
        if ( depth > SkinnedMeshCaps.globalMaxHierarchyDepth ) {
            mask |= BoneError.DEPTH_OVERFLOW;
        }

        // ── 4c. Branching factor cap. ──────────────────────────────────────
        if ( bone.children.length > SkinnedMeshDefaults.maxBranchingFactor ) {
            mask |= BoneError.EXCESSIVE_BRANCHING;
            _validationResult.warningErrors.push( _makeErrorRecord( bone, BoneError.EXCESSIVE_BRANCHING, depth, 'Branching exceeds tier cap' ) );
        }
        if ( bone.children.length > SkinnedMeshCaps.globalMaxBranchingFactor ) {
            mask |= BoneError.BRANCH_OVERFLOW;
        }

        // ── 4d. Duplicate name detection. ──────────────────────────────────
        const name = bone.name;

        if ( name !== undefined && name !== '' ) {
            const existing = _nameRegistry.get( name );

            if ( existing !== undefined ) {
                BoneValidationSoA.duplicateNameCount[ eid ] = 1;
                mask |= BoneError.DUPLICATE_NAME;

                const existingEid = _ecsValidationByBone.get( existing );
                if ( existingEid !== undefined ) {
                    BoneValidationSoA.errorMask[ existingEid ] |= BoneError.DUPLICATE_NAME;
                    BoneValidationSoA.duplicateNameCount[ existingEid ] =
                        ( BoneValidationSoA.duplicateNameCount[ existingEid ] || 0 ) + 1;
                }

                _validationResult.duplicateNameCount ++;
                _validationResult.warningErrors.push( _makeErrorRecord( bone, BoneError.DUPLICATE_NAME, depth, 'Duplicate name: ' + name ) );
            } else {
                _nameRegistry.set( name, bone );
            }
        }

        // ── 4e. Parent consistency. ────────────────────────────────────────
        if ( depth > 0 && ( bone.parent === null || bone.parent === undefined ) ) {
            mask |= BoneError.MISSING_PARENT;
            _validationResult.fatalErrors.push( _makeErrorRecord( bone, BoneError.MISSING_PARENT, depth, 'Parent missing for non-root bone' ) );
        }

        // ── 4f. Transform sanity: NaN / Inf. ───────────────────────────────
        const pos = bone.position;
        const scale = bone.scale;
        const quat = bone.quaternion;

        if (
            ! Number.isFinite( pos.x ) || ! Number.isFinite( pos.y ) || ! Number.isFinite( pos.z ) ||
            ! Number.isFinite( scale.x ) || ! Number.isFinite( scale.y ) || ! Number.isFinite( scale.z ) ||
            ! Number.isFinite( quat.x ) || ! Number.isFinite( quat.y ) || ! Number.isFinite( quat.z ) || ! Number.isFinite( quat.w )
        ) {
            mask |= BoneError.NAN_TRANSFORM;
            _validationResult.nanTransformCount ++;
            _validationResult.fatalErrors.push( _makeErrorRecord( bone, BoneError.NAN_TRANSFORM, depth, 'NaN or Inf transform' ) );
        }

        // ── 4g. Determinant / scale. ───────────────────────────────────────
        const det = _computeDeterminantHighPrecision( bone.matrixWorld );

        BoneValidationSoA.determinant[ eid ] = det;
        BoneValidationSoA.scaleX[ eid ] = scale.x;
        BoneValidationSoA.scaleY[ eid ] = scale.y;
        BoneValidationSoA.scaleZ[ eid ] = scale.z;

        if ( Math.abs( det ) < 1e-12 ) {
            mask |= BoneError.NON_INVERTIBLE_MATRIX;
            mask |= BoneError.ZERO_SCALE;
            _validationResult.nonInvertibleCount ++;
            _validationResult.degenerateScaleCount ++;
            _validationResult.fatalErrors.push( _makeErrorRecord( bone, BoneError.NON_INVERTIBLE_MATRIX, depth, 'Non-invertible world matrix' ) );
        }

        if ( Math.abs( scale.x ) < 1e-9 || Math.abs( scale.y ) < 1e-9 || Math.abs( scale.z ) < 1e-9 ) {
            mask |= BoneError.DEGENERATE_SCALE;
            _validationResult.degenerateScaleCount ++;
        }

        if ( scale.x < 0 || scale.y < 0 || scale.z < 0 ) {
            mask |= BoneError.NEGATIVE_SCALE;
            _validationResult.warningErrors.push( _makeErrorRecord( bone, BoneError.NEGATIVE_SCALE, depth, 'Negative bone scale' ) );
        }

        if ( Math.abs( scale.x - scale.y ) > 1e-4 || Math.abs( scale.y - scale.z ) > 1e-4 ) {
            mask |= BoneError.NON_UNIFORM_SCALE;
        }

        // ── 4h. Quaternion stability. ──────────────────────────────────────
        const qLen = Math.sqrt( quat.x * quat.x + quat.y * quat.y + quat.z * quat.z + quat.w * quat.w );
        BoneValidationSoA.quatLength[ eid ] = qLen;

        if ( Math.abs( qLen - 1.0 ) > 1e-3 ) {
            mask |= BoneError.UNSTABLE_QUATERNION;
            _validationResult.warningErrors.push( _makeErrorRecord( bone, BoneError.UNSTABLE_QUATERNION, depth, 'Unnormalized bone quaternion' ) );
        }

        // ── 4i. Inverse matrix presence (optional). ────────────────────────
        if ( checkInverses && skeleton !== null ) {
            const boneIndex = skeleton.bones.indexOf( bone );

            if ( boneIndex < 0 || skeleton.boneInverses[ boneIndex ] === undefined ) {
                mask |= BoneError.MISSING_INVERSE;
            }
        }

        // ── 4j. Deterministic per-bone dither for repair ordering. ─────────
        const ditherSeed = ( BoneWalkSoA.pathHash[ _walkEntityFor( bone ) ] ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
        BoneValidationSoA.ditherSample[ eid ] = _noise3D( ditherSeed * 1e-6, frameIndex * 0.02, depth );

        // ── 4k. Commit and update aggregates. ──────────────────────────────
        BoneValidationSoA.errorMask[ eid ] = mask;
        BoneValidationSoA.severity[ eid ] = _severityForMask( mask );

        if ( mask !== BoneError.NONE ) {
            _validationResult.totalErrors ++;
            _validationResult.errorMaskAggregate |= mask;

            const sev = BoneValidationSoA.severity[ eid ];
            if ( sev > _validationResult.worstSeverity ) {
                _validationResult.worstSeverity = sev;
            }
        }
    }, 0, frameIndex );

    // ── 5. Orphan detection: any Bone in the scene not reachable from root.
    _detectOrphans( root, frameIndex );

    // ── 6. Build the repair plan (sorted by deterministic priority). ──────
    _validationResult.repairPlan = _buildRepairPlan( frameIndex );

    _validationResult.lastValidationMs = _nowMs() - t0;

    return _validationResult;
}

// ─── Public API: repair. ────────────────────────────────────────────────────

/**
 * Applies the given repair strategy to the hierarchy. Returns the number of
 * bones actually repaired.
 *
 * @param {Bone} root
 * @param {number} strategy - One of `RepairStrategy`.
 * @param {number} [frameIndex=0]
 * @return {number} The number of repaired bones.
 */
function repair( root, strategy, frameIndex = 0 ) {
    const report = validate( root, { frameIndex: frameIndex } );
    const plan = report.repairPlan;

    if ( plan === null ) return 0;

    let repairedCount = 0;

    for ( let i = 0; i < plan.length; i ++ ) {
        const entry = plan[ i ];
        const bone = entry.bone;
        const mask = entry.mask;

        const eid = _ensureValidationEntity( bone );

        if ( ( strategy & RepairStrategy.FIX_NAN ) !== 0 && ( mask & BoneError.NAN_TRANSFORM ) !== 0 ) {
            _fixNanTransform( bone );
            BoneValidationSoA.repaired[ eid ] = 1;
            BoneValidationSoA.repairFrame[ eid ] = frameIndex;
            repairedCount ++;
        }

        if ( ( strategy & RepairStrategy.FIX_DEGENERATE_SCALE ) !== 0 &&
            ( ( mask & BoneError.DEGENERATE_SCALE ) !== 0 || ( mask & BoneError.ZERO_SCALE ) !== 0 ) ) {
            _fixDegenerateScale( bone );
            BoneValidationSoA.repaired[ eid ] = 1;
            BoneValidationSoA.repairFrame[ eid ] = frameIndex;
            repairedCount ++;
        }

        if ( ( strategy & RepairStrategy.RENAME_DUPLICATES ) !== 0 && ( mask & BoneError.DUPLICATE_NAME ) !== 0 ) {
            _renameDuplicate( bone, frameIndex );
            BoneValidationSoA.repaired[ eid ] = 1;
            BoneValidationSoA.repairFrame[ eid ] = frameIndex;
            repairedCount ++;
        }
    }

    if ( ( strategy & RepairStrategy.RECOMPUTE_INVERSES ) !== 0 ) {
        // Caller is responsible for invoking skeleton.calculateInverses().
    }

    return repairedCount;
}

// ─── Internal: orphan detection. ────────────────────────────────────────────

function _detectOrphans( root, frameIndex ) {
    // Orphans are bones whose parent chain does not reach the given root.
    // We detect them by scanning the validation ECS world for entries whose
    // depth is -1 relative to the current walk.
    const q = query( _validationWorld, [ BoneValidationSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        const boneId = BoneValidationSoA.boneId[ eid ];

        if ( boneId === 0 ) continue; // unset

        // A bone is orphan if its depth was never set by the walk.
        const depth = BoneValidationSoA.depth[ eid ];
        if ( depth < 0 && boneId !== root.id ) {
            BoneValidationSoA.errorMask[ eid ] |= BoneError.ORPHAN;
            _validationResult.orphanCount ++;
        }

        void frameIndex;
    }
}

// ─── Internal: repair plan. ─────────────────────────────────────────────────

function _buildRepairPlan( frameIndex ) {
    const plan = [];

    const q = query( _validationWorld, [ BoneValidationSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        const mask = BoneValidationSoA.errorMask[ eid ];

        if ( mask === BoneError.NONE ) continue;

        const bone = _boneForEntity( eid );
        if ( bone === null ) continue;

        plan.push( {
            bone: bone,
            mask: mask,
            severity: BoneValidationSoA.severity[ eid ],
            depth: BoneValidationSoA.depth[ eid ],
            priority: _computeRepairPriority( mask, BoneValidationSoA.ditherSample[ eid ] )
        } );
    }

    // Sort by priority descending (highest severity first).
    plan.sort( ( a, b ) => b.priority - a.priority );

    void frameIndex;
    return plan;
}

function _computeRepairPriority( mask, dither ) {
    let base = 0;

    if ( ( mask & BoneError.CYCLE ) !== 0 ) base += 1000;
    if ( ( mask & BoneError.NAN_TRANSFORM ) !== 0 ) base += 900;
    if ( ( mask & BoneError.NON_INVERTIBLE_MATRIX ) !== 0 ) base += 800;
    if ( ( mask & BoneError.ZERO_SCALE ) !== 0 ) base += 700;
    if ( ( mask & BoneError.DEGENERATE_SCALE ) !== 0 ) base += 600;
    if ( ( mask & BoneError.MISSING_PARENT ) !== 0 ) base += 500;
    if ( ( mask & BoneError.ORPHAN ) !== 0 ) base += 400;
    if ( ( mask & BoneError.DUPLICATE_NAME ) !== 0 ) base += 300;
    if ( ( mask & BoneError.EXCESSIVE_DEPTH ) !== 0 ) base += 200;
    if ( ( mask & BoneError.EXCESSIVE_BRANCHING ) !== 0 ) base += 100;

    return base + dither * 10.0;
}

// ─── Internal: repairs. ─────────────────────────────────────────────────────

function _fixNanTransform( bone ) {
    if ( ! Number.isFinite( bone.position.x ) ) bone.position.x = 0;
    if ( ! Number.isFinite( bone.position.y ) ) bone.position.y = 0;
    if ( ! Number.isFinite( bone.position.z ) ) bone.position.z = 0;

    if ( ! Number.isFinite( bone.scale.x ) || bone.scale.x === 0 ) bone.scale.x = 1;
    if ( ! Number.isFinite( bone.scale.y ) || bone.scale.y === 0 ) bone.scale.y = 1;
    if ( ! Number.isFinite( bone.scale.z ) || bone.scale.z === 0 ) bone.scale.z = 1;

    if ( ! Number.isFinite( bone.quaternion.x ) ) bone.quaternion.x = 0;
    if ( ! Number.isFinite( bone.quaternion.y ) ) bone.quaternion.y = 0;
    if ( ! Number.isFinite( bone.quaternion.z ) ) bone.quaternion.z = 0;
    if ( ! Number.isFinite( bone.quaternion.w ) ) bone.quaternion.w = 1;

    glMatrix.quat.set(
        _scratchQuat,
        bone.quaternion.x,
        bone.quaternion.y,
        bone.quaternion.z,
        bone.quaternion.w
    );
    glMatrix.quat.normalize( _scratchQuat, _scratchQuat );

    bone.quaternion.x = _scratchQuat[ 0 ];
    bone.quaternion.y = _scratchQuat[ 1 ];
    bone.quaternion.z = _scratchQuat[ 2 ];
    bone.quaternion.w = _scratchQuat[ 3 ];
}

function _fixDegenerateScale( bone ) {
    const eps = 1e-4;

    if ( Math.abs( bone.scale.x ) < eps ) bone.scale.x = 1;
    if ( Math.abs( bone.scale.y ) < eps ) bone.scale.y = 1;
    if ( Math.abs( bone.scale.z ) < eps ) bone.scale.z = 1;
}

function _renameDuplicate( bone, frameIndex ) {
    const baseName = bone.name !== undefined && bone.name !== '' ? bone.name : 'bone';
    const suffix = '_' + ( bone.id >>> 0 ).toString( 16 ) + '_' + ( frameIndex >>> 0 ).toString( 16 );
    bone.name = baseName + suffix;
}

// ─── Internal: severity mapping. ────────────────────────────────────────────

function _severityForMask( mask ) {
    if ( ( mask & BoneError.CYCLE ) !== 0 ) return ValidationSeverity.FATAL;
    if ( ( mask & BoneError.NAN_TRANSFORM ) !== 0 ) return ValidationSeverity.FATAL;
    if ( ( mask & BoneError.MISSING_PARENT ) !== 0 ) return ValidationSeverity.FATAL;
    if ( ( mask & BoneError.NON_INVERTIBLE_MATRIX ) !== 0 ) return ValidationSeverity.ERROR;
    if ( ( mask & BoneError.ZERO_SCALE ) !== 0 ) return ValidationSeverity.ERROR;
    if ( ( mask & BoneError.DEGENERATE_SCALE ) !== 0 ) return ValidationSeverity.ERROR;
    if ( ( mask & BoneError.ORPHAN ) !== 0 ) return ValidationSeverity.ERROR;
    if ( ( mask & BoneError.DUPLICATE_NAME ) !== 0 ) return ValidationSeverity.WARNING;
    if ( ( mask & BoneError.EXCESSIVE_DEPTH ) !== 0 ) return ValidationSeverity.WARNING;
    if ( ( mask & BoneError.EXCESSIVE_BRANCHING ) !== 0 ) return ValidationSeverity.WARNING;
    if ( ( mask & BoneError.NEGATIVE_SCALE ) !== 0 ) return ValidationSeverity.WARNING;
    if ( ( mask & BoneError.UNSTABLE_QUATERNION ) !== 0 ) return ValidationSeverity.WARNING;
    if ( ( mask & BoneError.NON_UNIFORM_SCALE ) !== 0 ) return ValidationSeverity.INFO;
    return ValidationSeverity.OK;
}

function _makeErrorRecord( bone, mask, depth, message ) {
    return {
        boneId: bone.id,
        boneName: bone.name,
        errorMask: mask,
        depth: depth,
        message: message
    };
}

// ─── Internal: high-precision determinant via double.js. ────────────────────

function _computeDeterminantHighPrecision( matrix ) {
    const e = matrix.elements;

    const a = new Double( e[ 0 ] ), b = new Double( e[ 1 ] ), c = new Double( e[ 2 ] );
    const d = new Double( e[ 4 ] ), f = new Double( e[ 5 ] ), g = new Double( e[ 6 ] );
    const h = new Double( e[ 8 ] ), i = new Double( e[ 9 ] ), j = new Double( e[ 10 ] );

    const term1 = a.mul( f.mul( j ).sub( g.mul( i ) ) );
    const term2 = b.mul( d.mul( j ).sub( g.mul( h ) ) );
    const term3 = c.mul( d.mul( i ).sub( f.mul( h ) ) );

    return term1.sub( term2 ).add( term3 ).valueOf();
}

// ─── Internal: entity management. ───────────────────────────────────────────

function _ensureValidationEntity( bone ) {
    let eid = _ecsValidationByBone.get( bone );

    if ( eid === undefined ) {
        eid = addEntity( _validationWorld );
        addComponent( _validationWorld, BoneValidationSoA, eid );
        _ecsValidationByBone.set( bone, eid );

        BoneValidationSoA.boneId[ eid ] = bone.id;
        BoneValidationSoA.errorMask[ eid ] = BoneError.NONE;
        BoneValidationSoA.severity[ eid ] = ValidationSeverity.OK;
        BoneValidationSoA.depth[ eid ] = - 1;
        BoneValidationSoA.siblingIndex[ eid ] = - 1;
        BoneValidationSoA.childCount[ eid ] = 0;
        BoneValidationSoA.duplicateNameCount[ eid ] = 0;
        BoneValidationSoA.determinant[ eid ] = 1.0;
        BoneValidationSoA.scaleX[ eid ] = 1.0;
        BoneValidationSoA.scaleY[ eid ] = 1.0;
        BoneValidationSoA.scaleZ[ eid ] = 1.0;
        BoneValidationSoA.quatLength[ eid ] = 1.0;
        BoneValidationSoA.repairSuggested[ eid ] = 0;
        BoneValidationSoA.repaired[ eid ] = 0;
        BoneValidationSoA.repairFrame[ eid ] = - 1;
        BoneValidationSoA.ditherSample[ eid ] = 0.0;
        BoneValidationSoA.validationOrder[ eid ] = - 1;
    }

    return eid;
}

function _boneForEntity( eid ) {
    // Reverse lookup: scan the WeakMap via known bones in the current walk.
    const q = query( _validationWorld, [ BoneValidationSoA ] );

    if ( eid < 0 || eid >= q.length ) return null;

    // Linear scan over the WeakMap is not possible, so we consult the walker.
    // The walker's BoneWalkSoA.boneId shares the same bone.id space.
    const boneId = BoneValidationSoA.boneId[ eid ];

    for ( let i = 0; i < q.length; i ++ ) {
        if ( BoneValidationSoA.boneId[ q[ i ] ] === boneId && q[ i ] === eid ) {
            // We need the original Bone reference. Store it in the WeakMap
            // on first encounter.
            const cached = _boneRefByEntity.get( eid );
            return cached !== undefined ? cached : null;
        }
    }

    return null;
}

const _boneRefByEntity = new Map();

function _walkEntityFor( bone ) {
    // Proxy to the walker's per-bone entity id via the bone's own registry.
    // The walker stores its entities in its own WeakMap; we cannot access
    // that directly, so we use a path hash proxy via the validator.
    const eid = _ecsValidationByBone.get( bone );
    if ( eid !== undefined ) {
        _boneRefByEntity.set( eid, bone );
    }
    return eid !== undefined ? eid : - 1;
}

// ─── High-precision aggregate helpers. ──────────────────────────────────────

function computeErrorDensityHighPrecision() {
    const total = new Double( _validationResult.totalBones );
    if ( total.valueOf() <= 0 ) return 0.0;

    const errors = new Double( _validationResult.totalErrors );
    return errors.div( total ).valueOf();
}

function computeDepthCostHighPrecision() {
    const maxDepth = new Double( _validationResult.maxDepth );
    const branching = new Double( _validationResult.maxBranchingFactor );
    const total = new Double( _validationResult.totalBones );

    return maxDepth.mul( branching ).add( total ).valueOf();
}

// ─── gl-matrix packing for telemetry. ───────────────────────────────────────

function packValidationVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
        v,
        _validationResult.totalBones,
        _validationResult.totalErrors,
        _validationResult.worstSeverity,
        _validationResult.hierarchyKind
    );
    return v;
}

function packBoneErrorVec4( bone, out ) {
    const eid = _ecsValidationByBone.get( bone );
    const v = out || _scratchVec4;

    if ( eid === undefined ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        BoneValidationSoA.errorMask[ eid ],
        BoneValidationSoA.severity[ eid ],
        BoneValidationSoA.depth[ eid ],
        BoneValidationSoA.determinant[ eid ]
    );
    return v;
}

// ─── Deterministic dither sample for repair ordering. ──────────────────────

function sampleRepairDither( bone, frameIndex ) {
    const eid = _ecsValidationByBone.get( bone );
    if ( eid === undefined ) return 0.0;

    const seed = ( BoneValidationSoA.errorMask[ eid ] ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
    const s = _noise3D( seed * 1e-6, frameIndex * 0.02, BoneValidationSoA.depth[ eid ] );
    BoneValidationSoA.ditherSample[ eid ] = s;
    return s;
}

// ─── Query helpers. ─────────────────────────────────────────────────────────

function hasError( bone, errorBit ) {
    const eid = _ecsValidationByBone.get( bone );
    if ( eid === undefined ) return false;
    return ( BoneValidationSoA.errorMask[ eid ] & errorBit ) !== 0;
}

function getErrorMask( bone ) {
    const eid = _ecsValidationByBone.get( bone );
    return eid !== undefined ? BoneValidationSoA.errorMask[ eid ] : BoneError.NONE;
}

function getSeverity( bone ) {
    const eid = _ecsValidationByBone.get( bone );
    return eid !== undefined ? BoneValidationSoA.severity[ eid ] : ValidationSeverity.OK;
}

function getValidationOrder( bone ) {
    const eid = _ecsValidationByBone.get( bone );
    return eid !== undefined ? BoneValidationSoA.validationOrder[ eid ] : - 1;
}

function collectErrorBones( mask = - 1 ) {
    const out = [];
    const q = query( _validationWorld, [ BoneValidationSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        const m = BoneValidationSoA.errorMask[ eid ];

        if ( m === BoneError.NONE ) continue;
        if ( mask !== - 1 && ( m & mask ) === 0 ) continue;

        const bone = _boneRefByEntity.get( eid );
        if ( bone !== undefined ) out.push( bone );
    }

    return out;
}

// ─── Utilities. ─────────────────────────────────────────────────────────────

function _nowMs() {
    if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
        return performance.now();
    }
    return Date.now();
}

void Bone;
void Matrix4;
void Vector3;
void Quaternion;
void _scratchMat4;
void _scratchMat4Inv;
void _scratchVec3A;
void _scratchVec3B;
void _scratchVec3C;

export {
    BoneError,
    ValidationSeverity,
    RepairStrategy,
    BoneValidationSoA,
    validate,
    repair,
    hasError,
    getErrorMask,
    getSeverity,
    getValidationOrder,
    collectErrorBones,
    computeErrorDensityHighPrecision,
    computeDepthCostHighPrecision,
    packValidationVec4,
    packBoneErrorVec4,
    sampleRepairDither
};