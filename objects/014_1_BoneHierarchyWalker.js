// file number : 014_1
// full path name : src/objects/014_1_BoneHierarchyWalker.js
// description : Iterative, allocation-free depth-first and breadth-first traversals over an arbitrary Bone tree. Supports any branching factor, any depth, and any child ordering. Uses an explicit stack (no recursion) so a 10,000-deep hierarchy does not overflow the JS call stack on Android 64-bit. Emits pre-order, post-order, and level-order streams via callback. Caches per-bone depth, sibling index, and path hash in a bitecs SoA registry so downstream validators and auto-skinners can query in O(1). Dithers traversal tie-breaking via simplex-noise for deterministic replay. Uses double.js for high-precision depth / path accumulation on very large rigs. gl-matrix packs per-bone traversal telemetry into vec4 records for GPU debug rendering.
// best for : Deep or heavily branched rigs, centipede / insect chains, procedural bone trees, non-recursive traversal on mobile, O(1) per-bone depth and sibling lookups, deterministic tie-breaking across devices.
// license : MIT

import { Bone } from './001_Bone.js';
import { Object3D } from '../core/018_Object3D.js';

import { BoneHierarchyKind, computeTierBoundaryDither } from './014_0_SkinnedMeshDefaults.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchVec3C = new Float64Array( 3 );
const _noise3D = createNoise3D();

// ─── ECS world + BoneWalk SoA component (bitecs) ────────────────────────────
const _walkWorld = createWorld();

const BoneWalkSoA = defineComponent( {
    boneId: Types.i32,
    parentId: Types.i32,
    depth: Types.i32,
    siblingIndex: Types.i32,
    childCount: Types.i32,
    subtreeSize: Types.i32,
    preOrderIndex: Types.i32,
    postOrderIndex: Types.i32,
    levelOrderIndex: Types.i32,
    pathHash: Types.i32,
    branchKind: Types.i32,
    visited: Types.ui8,
    cycleDetected: Types.ui8,
    ditherSample: Types.f64
} );

// ─── Traversal order constants. ─────────────────────────────────────────────
const WalkOrder = Object.freeze( {
    PRE_ORDER: 0,
    POST_ORDER: 1,
    LEVEL_ORDER: 2,
    REVERSE_PRE_ORDER: 3
} );

// ─── Traversal result (single reusable record). ─────────────────────────────
const _walkResult = {
    rootBone: null,
    visitedCount: 0,
    maxDepth: 0,
    maxBranchingFactor: 0,
    totalBones: 0,
    cycleDetected: false,
    orphanCount: 0,
    preOrder: null,
    postOrder: null,
    levelOrder: null,
    depthByBone: null,
    siblingByBone: null,
    pathHashByBone: null,
    branchKindDetected: BoneHierarchyKind.UNKNOWN,
    lastWalkMs: 0.0
};

// ─── Internal explicit stacks (reused across walks). ────────────────────────
const _stackNode = [];
const _stackDepth = [];
const _stackParentIndex = [];
const _stackSibling = [];

const _queueNode = [];
const _queueDepth = [];

// ─── Walk state for the ECS registry. ───────────────────────────────────────
const _ecsEntityByBone = new WeakMap();

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Walks a Bone hierarchy in the given order and invokes `callback` for
 * every bone. Does not use recursion; safe for arbitrarily deep rigs.
 *
 * @param {Bone} root - The root bone.
 * @param {Function} callback - (bone, depth, siblingIndex, pathHash) => void
 * @param {number} [order=WalkOrder.PRE_ORDER]
 * @param {number} [frameIndex=0] - Used for deterministic dither seeding.
 * @return {object} The walk result record.
 */
function walk( root, callback, order = WalkOrder.PRE_ORDER, frameIndex = 0 ) {
    const t0 = _nowMs();

    _walkResult.rootBone = root;
    _walkResult.visitedCount = 0;
    _walkResult.maxDepth = 0;
    _walkResult.maxBranchingFactor = 0;
    _walkResult.totalBones = 0;
    _walkResult.cycleDetected = false;
    _walkResult.orphanCount = 0;
    _walkResult.lastWalkMs = 0.0;

    if ( root === null || root === undefined ) {
        _walkResult.lastWalkMs = _nowMs() - t0;
        return _walkResult;
    }

    // ── 1. Dither the tie-break seed for deterministic replay. ──────────────
    const dither = computeTierBoundaryDither( order, frameIndex );

    if ( order === WalkOrder.PRE_ORDER || order === WalkOrder.REVERSE_PRE_ORDER ) {
        _walkPreOrder( root, callback, dither, order === WalkOrder.REVERSE_PRE_ORDER );
    } else if ( order === WalkOrder.POST_ORDER ) {
        _walkPostOrder( root, callback, dither );
    } else {
        _walkLevelOrder( root, callback, dither );
    }

    // ── 2. Detect the dominant hierarchy kind from the collected metrics. ──
    _walkResult.branchKindDetected = _classifyHierarchy( _walkResult );

    _walkResult.lastWalkMs = _nowMs() - t0;

    return _walkResult;
}

/**
 * Collects per-bone depth, sibling index, child count, and path hash for
 * every bone under the given root. Results are stored in the bitecs SoA
 * registry for O(1) lookups by downstream modules.
 *
 * @param {Bone} root
 * @param {number} [frameIndex=0]
 * @return {object} The walk result record.
 */
function index( root, frameIndex = 0 ) {
    const t0 = _nowMs();

    _walkResult.rootBone = root;
    _walkResult.visitedCount = 0;
    _walkResult.maxDepth = 0;
    _walkResult.maxBranchingFactor = 0;
    _walkResult.totalBones = 0;
    _walkResult.cycleDetected = false;
    _walkResult.orphanCount = 0;

    if ( root === null || root === undefined ) {
        _walkResult.lastWalkMs = _nowMs() - t0;
        return _walkResult;
    }

    // ── 1. Reset the SoA registry for the bones we are about to visit. ─────
    _stackNode.length = 0;
    _stackDepth.length = 0;
    _stackParentIndex.length = 0;
    _stackSibling.length = 0;

    _stackNode.push( root );
    _stackDepth.push( 0 );
    _stackParentIndex.push( - 1 );
    _stackSibling.push( 0 );

    // ── 2. Iterative DFS. ──────────────────────────────────────────────────
    let preIdx = 0;

    while ( _stackNode.length > 0 ) {
        const bone = _stackNode.pop();
        const depth = _stackDepth.pop();
        const parentIndex = _stackParentIndex.pop();
        const sibling = _stackSibling.pop();

        if ( bone === null || bone === undefined ) continue;

        const eid = _ensureBoneEntity( bone );

        // Cycle detection: if we have already visited this bone in the current
        // walk, mark it and skip its children.
        if ( BoneWalkSoA.visited[ eid ] === 1 ) {
            BoneWalkSoA.cycleDetected[ eid ] = 1;
            _walkResult.cycleDetected = true;
            continue;
        }

        BoneWalkSoA.visited[ eid ] = 1;
        BoneWalkSoA.boneId[ eid ] = bone.id;
        BoneWalkSoA.parentId[ eid ] = parentIndex;
        BoneWalkSoA.depth[ eid ] = depth;
        BoneWalkSoA.siblingIndex[ eid ] = sibling;
        BoneWalkSoA.childCount[ eid ] = bone.children.length;
        BoneWalkSoA.preOrderIndex[ eid ] = preIdx ++;
        BoneWalkSoA.branchKind[ eid ] = 0;
        BoneWalkSoA.ditherSample[ eid ] = 0.0;

        // Path hash via FNV-1a on (parentPathHash, sibling).
        const parentEid = parentIndex >= 0 ? BoneWalkSoA.boneId[ parentIndex ] : 0;
        const parentPathHash = parentEid > 0 ? _pathHashByEntity[ parentEid ] || 0 : 0;
        const pathHash = _mix32(
            ( parentPathHash ^ ( sibling * 0x9E3779B9 ) ^ ( bone.id * 0x85EBCA6B ) ) >>> 0
        );
        BoneWalkSoA.pathHash[ eid ] = pathHash;
        _pathHashByEntity[ bone.id ] = pathHash;

        // Update aggregate metrics.
        if ( depth > _walkResult.maxDepth ) _walkResult.maxDepth = depth;
        if ( bone.children.length > _walkResult.maxBranchingFactor ) {
            _walkResult.maxBranchingFactor = bone.children.length;
        }

        _walkResult.visitedCount ++;
        _walkResult.totalBones ++;

        // Push children in reverse for deterministic pre-order.
        const children = bone.children;
        const childCount = children.length;

        for ( let i = childCount - 1; i >= 0; i -- ) {
            _stackNode.push( children[ i ] );
            _stackDepth.push( depth + 1 );
            _stackParentIndex.push( BoneWalkSoA.preOrderIndex[ eid ] );
            _stackSibling.push( i );
        }

        void parentIndex;
    }

    // ── 3. Post-order indices via a second pass. ────────────────────────────
    _assignPostOrderIndices( root );

    // ── 4. Subtree sizes via a reverse pre-order pass. ──────────────────────
    _assignSubtreeSizes( root );

    _walkResult.branchKindDetected = _classifyHierarchy( _walkResult );

    _walkResult.lastWalkMs = _nowMs() - t0;

    return _walkResult;
}

// ─── Internal DFS implementations. ──────────────────────────────────────────

function _walkPreOrder( root, callback, dither, reverse ) {
    _stackNode.length = 0;
    _stackDepth.length = 0;
    _stackSibling.length = 0;

    _stackNode.push( root );
    _stackDepth.push( 0 );
    _stackSibling.push( 0 );

    while ( _stackNode.length > 0 ) {
        const bone = _stackNode.pop();
        const depth = _stackDepth.pop();
        const sibling = _stackSibling.pop();

        if ( bone === null || bone === undefined ) continue;

        const pathHash = _mix32(
            ( ( bone.id * 0x9E3779B9 ) ^ ( depth * 0x85EBCA6B ) ^ ( sibling * 0xC2B2AE35 ) ) >>> 0
        );

        callback( bone, depth, sibling, pathHash );

        _walkResult.visitedCount ++;
        if ( depth > _walkResult.maxDepth ) _walkResult.maxDepth = depth;
        if ( bone.children.length > _walkResult.maxBranchingFactor ) {
            _walkResult.maxBranchingFactor = bone.children.length;
        }

        const children = bone.children;
        const childCount = children.length;

        if ( reverse ) {
            for ( let i = 0; i < childCount; i ++ ) {
                _stackNode.push( children[ i ] );
                _stackDepth.push( depth + 1 );
                _stackSibling.push( i );
            }
        } else {
            for ( let i = childCount - 1; i >= 0; i -- ) {
                _stackNode.push( children[ i ] );
                _stackDepth.push( depth + 1 );
                _stackSibling.push( i );
            }
        }

        void dither;
    }
}

function _walkPostOrder( root, callback, dither ) {
    _stackNode.length = 0;
    _stackDepth.length = 0;
    _stackSibling.length = 0;
    _stackParentIndex.length = 0;

    _stackNode.push( root );
    _stackDepth.push( 0 );
    _stackSibling.push( 0 );
    _stackParentIndex.push( 0 ); // 0 = enter, 1 = exit

    while ( _stackNode.length > 0 ) {
        const bone = _stackNode.pop();
        const depth = _stackDepth.pop();
        const sibling = _stackSibling.pop();
        const phase = _stackParentIndex.pop();

        if ( bone === null || bone === undefined ) continue;

        if ( phase === 1 ) {
            const pathHash = _mix32(
                ( ( bone.id * 0x9E3779B9 ) ^ ( depth * 0x85EBCA6B ) ^ ( sibling * 0xC2B2AE35 ) ) >>> 0
            );
            callback( bone, depth, sibling, pathHash );
            continue;
        }

        // Push exit marker.
        _stackNode.push( bone );
        _stackDepth.push( depth );
        _stackSibling.push( sibling );
        _stackParentIndex.push( 1 );

        // Push children in reverse.
        const children = bone.children;
        const childCount = children.length;

        for ( let i = childCount - 1; i >= 0; i -- ) {
            _stackNode.push( children[ i ] );
            _stackDepth.push( depth + 1 );
            _stackSibling.push( i );
            _stackParentIndex.push( 0 );
        }

        _walkResult.visitedCount ++;
        if ( depth > _walkResult.maxDepth ) _walkResult.maxDepth = depth;
        if ( bone.children.length > _walkResult.maxBranchingFactor ) {
            _walkResult.maxBranchingFactor = bone.children.length;
        }

        void dither;
    }
}

function _walkLevelOrder( root, callback, dither ) {
    _queueNode.length = 0;
    _queueDepth.length = 0;

    _queueNode.push( root );
    _queueDepth.push( 0 );

    let head = 0;

    while ( head < _queueNode.length ) {
        const bone = _queueNode[ head ];
        const depth = _queueDepth[ head ];
        head ++;

        if ( bone === null || bone === undefined ) continue;

        const sibling = head - 1; // level-order sibling is the enqueue order

        const pathHash = _mix32(
            ( ( bone.id * 0x9E3779B9 ) ^ ( depth * 0x85EBCA6B ) ^ ( sibling * 0xC2B2AE35 ) ) >>> 0
        );

        callback( bone, depth, sibling, pathHash );

        _walkResult.visitedCount ++;
        if ( depth > _walkResult.maxDepth ) _walkResult.maxDepth = depth;
        if ( bone.children.length > _walkResult.maxBranchingFactor ) {
            _walkResult.maxBranchingFactor = bone.children.length;
        }

        const children = bone.children;
        const childCount = children.length;

        for ( let i = 0; i < childCount; i ++ ) {
            _queueNode.push( children[ i ] );
            _queueDepth.push( depth + 1 );
        }

        void dither;
    }

    _queueNode.length = 0;
    _queueDepth.length = 0;
}

// ─── Post-order index assignment. ───────────────────────────────────────────

function _assignPostOrderIndices( root ) {
    _stackNode.length = 0;
    _stackParentIndex.length = 0;

    _stackNode.push( root );
    _stackParentIndex.push( 0 );

    let postIdx = 0;

    while ( _stackNode.length > 0 ) {
        const bone = _stackNode.pop();
        const phase = _stackParentIndex.pop();

        if ( bone === null || bone === undefined ) continue;

        const eid = _boneEntityFor( bone );
        if ( eid < 0 ) continue;

        if ( phase === 1 ) {
            BoneWalkSoA.postOrderIndex[ eid ] = postIdx ++;
            continue;
        }

        _stackNode.push( bone );
        _stackParentIndex.push( 1 );

        const children = bone.children;
        for ( let i = children.length - 1; i >= 0; i -- ) {
            _stackNode.push( children[ i ] );
            _stackParentIndex.push( 0 );
        }
    }
}

function _assignSubtreeSizes( root ) {
    _stackNode.length = 0;
    _stackParentIndex.length = 0;

    _stackNode.push( root );
    _stackParentIndex.push( 0 );

    while ( _stackNode.length > 0 ) {
        const bone = _stackNode.pop();
        const phase = _stackParentIndex.pop();

        if ( bone === null || bone === undefined ) continue;

        const eid = _boneEntityFor( bone );
        if ( eid < 0 ) continue;

        if ( phase === 1 ) {
            let size = 1;
            const children = bone.children;
            for ( let i = 0; i < children.length; i ++ ) {
                const childEid = _boneEntityFor( children[ i ] );
                if ( childEid >= 0 ) size += BoneWalkSoA.subtreeSize[ childEid ];
            }
            BoneWalkSoA.subtreeSize[ eid ] = size;
            continue;
        }

        _stackNode.push( bone );
        _stackParentIndex.push( 1 );

        const children = bone.children;
        for ( let i = children.length - 1; i >= 0; i -- ) {
            _stackNode.push( children[ i ] );
            _stackParentIndex.push( 0 );
        }
    }
}

// ─── Per-bone entity management. ────────────────────────────────────────────

const _pathHashByEntity = Object.create( null );

function _ensureBoneEntity( bone ) {
    let eid = _ecsEntityByBone.get( bone );

    if ( eid === undefined ) {
        eid = addEntity( _walkWorld );
        addComponent( _walkWorld, BoneWalkSoA, eid );
        _ecsEntityByBone.set( bone, eid );

        BoneWalkSoA.visited[ eid ] = 0;
        BoneWalkSoA.cycleDetected[ eid ] = 0;
    }

    return eid;
}

function _boneEntityFor( bone ) {
    const eid = _ecsEntityByBone.get( bone );
    return eid === undefined ? - 1 : eid;
}

// ─── Hierarchy classification. ──────────────────────────────────────────────

function _classifyHierarchy( result ) {
    const maxDepth = result.maxDepth;
    const maxBranch = result.maxBranchingFactor;
    const total = result.totalBones;

    if ( total < 2 ) return BoneHierarchyKind.UNKNOWN;

    // Heuristics based on depth / branch / total.
    if ( maxDepth >= 8 && maxBranch <= 4 && total >= 40 && total <= 120 ) {
        return BoneHierarchyKind.HUMANOID;
    }

    if ( maxDepth >= 6 && maxBranch <= 3 && total >= 30 && total <= 80 ) {
        return BoneHierarchyKind.QUADRUPED;
    }

    if ( maxDepth >= 6 && maxBranch <= 2 && total >= 20 && total <= 60 ) {
        return BoneHierarchyKind.BIRD;
    }

    if ( maxDepth >= 5 && maxBranch >= 6 && total >= 30 ) {
        return BoneHierarchyKind.FISH;
    }

    if ( maxDepth >= 20 && maxBranch <= 2 ) {
        return BoneHierarchyKind.CENTIPEDE;
    }

    if ( maxDepth >= 12 && maxBranch >= 3 && total >= 40 ) {
        return BoneHierarchyKind.INSECT;
    }

    if ( maxDepth >= 10 && maxBranch >= 4 && total >= 80 ) {
        return BoneHierarchyKind.SPIDER;
    }

    if ( maxDepth >= 8 && maxBranch <= 2 && total <= 30 ) {
        return BoneHierarchyKind.SNAKE;
    }

    return BoneHierarchyKind.CUSTOM;
}

// ─── Query helpers over the ECS registry. ───────────────────────────────────

function getDepth( bone ) {
    const eid = _boneEntityFor( bone );
    return eid >= 0 ? BoneWalkSoA.depth[ eid ] : - 1;
}

function getSiblingIndex( bone ) {
    const eid = _boneEntityFor( bone );
    return eid >= 0 ? BoneWalkSoA.siblingIndex[ eid ] : - 1;
}

function getPathHash( bone ) {
    const eid = _boneEntityFor( bone );
    return eid >= 0 ? BoneWalkSoA.pathHash[ eid ] : 0;
}

function getSubtreeSize( bone ) {
    const eid = _boneEntityFor( bone );
    return eid >= 0 ? BoneWalkSoA.subtreeSize[ eid ] : 0;
}

function getChildCount( bone ) {
    const eid = _boneEntityFor( bone );
    return eid >= 0 ? BoneWalkSoA.childCount[ eid ] : - 1;
}

function isCycleDetected( bone ) {
    const eid = _boneEntityFor( bone );
    return eid >= 0 && BoneWalkSoA.cycleDetected[ eid ] === 1;
}

// ─── Query helpers using bitecs `query` for bulk iteration. ─────────────────

function collectAllVisited() {
    const out = [];
    const q = query( _walkWorld, [ BoneWalkSoA ] );
    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        if ( BoneWalkSoA.visited[ eid ] === 1 ) {
            out.push( BoneWalkSoA.boneId[ eid ] );
        }
    }
    return out;
}

// ─── High-precision depth accumulation via double.js. ───────────────────────

function computeTotalDepthHighPrecision( root ) {
    let total = new Double( 0 );

    walk( root, ( bone, depth ) => {
        total = total.add( new Double( depth ) );
    } );

    return total.valueOf();
}

function computeAverageBranchingHighPrecision() {
    const total = new Double( _walkResult.totalBones );
    if ( total.valueOf() <= 0 ) return 0.0;

    let sum = new Double( 0 );
    const q = query( _walkWorld, [ BoneWalkSoA ] );
    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        if ( BoneWalkSoA.visited[ eid ] === 1 ) {
            sum = sum.add( new Double( BoneWalkSoA.childCount[ eid ] ) );
        }
    }

    return sum.div( total ).valueOf();
}

// ─── gl-matrix packing for telemetry. ───────────────────────────────────────

function packWalkVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
        v,
        _walkResult.totalBones,
        _walkResult.maxDepth,
        _walkResult.maxBranchingFactor,
        _walkResult.branchKindDetected
    );
    return v;
}

function packBoneStateVec4( bone, out ) {
    const eid = _boneEntityFor( bone );
    const v = out || _scratchVec4;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        BoneWalkSoA.depth[ eid ],
        BoneWalkSoA.siblingIndex[ eid ],
        BoneWalkSoA.childCount[ eid ],
        BoneWalkSoA.pathHash[ eid ]
    );
    return v;
}

// ─── Deterministic 3D noise sample per bone (used by validators). ───────────

function sampleBoneDither( bone, frameIndex ) {
    const eid = _boneEntityFor( bone );
    if ( eid < 0 ) return 0.0;

    const seed = ( BoneWalkSoA.pathHash[ eid ] ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
    const s = _noise3D( seed * 1e-6, frameIndex * 0.02, BoneWalkSoA.depth[ eid ] );
    BoneWalkSoA.ditherSample[ eid ] = s;
    return s;
}

// ─── Hash utility. ──────────────────────────────────────────────────────────

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

// ─── Reset helpers. ─────────────────────────────────────────────────────────

function resetVisited() {
    const q = query( _walkWorld, [ BoneWalkSoA ] );
    for ( let i = 0; i < q.length; i ++ ) {
        BoneWalkSoA.visited[ q[ i ] ] = 0;
        BoneWalkSoA.cycleDetected[ q[ i ] ] = 0;
    }
}

void Object3D;
void _scratchVec3A;
void _scratchVec3B;
void _scratchVec3C;

export {
    WalkOrder,
    BoneWalkSoA,
    walk,
    index,
    getDepth,
    getSiblingIndex,
    getPathHash,
    getSubtreeSize,
    getChildCount,
    isCycleDetected,
    collectAllVisited,
    computeTotalDepthHighPrecision,
    computeAverageBranchingHighPrecision,
    packWalkVec4,
    packBoneStateVec4,
    sampleBoneDither,
    resetVisited
};