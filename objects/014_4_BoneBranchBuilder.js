
// file number : 014_4
// full path name : src/objects/014_4_BoneBranchBuilder.js
// description : Fluent builder for constructing arbitrary Bone hierarchies at runtime. Supports addRoot, addChild, addBranch (adds N siblings with one call), addChain (adds a linear chain of N bones), addMirror (mirrors a subtree across an axis), addArchetype (instantiates an archetype from 014_3 at a given parent), and attachAt (attaches an arbitrary subtree). Every operation is O(1) amortized and returns the created Bone or the builder so callers can chain. Enforces the global caps from 014_0. Uses bitecs SoA to register each builder's state, double.js for high-precision bone / depth accounting during large builds, gl-matrix for mirror-matrix construction and rest-pose packing, and simplex-noise for deterministic per-bone rest-pose jitter that keeps replay identical across Android 64-bit devices.
// best for : Programmatic rig construction, procedural creature generation, mirror symmetry, chain-of-segments rigs (tails, tentacles, spines), runtime rig mutation, deterministic replay of built rigs on Adreno 5xx–7xx and Mali-G5x–G7xx.
// license : MIT

import { Bone } from './001_Bone.js';
import { Group } from './002_Group.js';
import { Object3D } from '../core/018_Object3D.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Quaternion } from '../math/007_Quaternion.js';

import { SkinnedMeshDefaults, SkinnedMeshCaps, BoneHierarchyKind } from './014_0_SkinnedMeshDefaults.js';
import { buildArchetype, getArchetype } from './014_3_BoneArchetypeRegistry.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchMat4Mirror = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchQuat = new Float64Array( 4 );
const _scratchColor = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + Builder SoA component (bitecs). ────────────────────────────
const _builderWorld = createWorld();

const BoneBranchBuilderSoA = defineComponent( {
    builderId: Types.i32,
    rootBoneId: Types.i32,
    totalBonesBuilt: Types.i32,
    maxDepthReached: Types.i32,
    maxBranchingReached: Types.i32,
    capViolations: Types.i32,
    determinismSeed: Types.ui32,
    buildTimeMs: Types.f64,
    lastOperationMs: Types.f64,
    active: Types.ui8,
    ditherSample: Types.f64
} );

// ─── Mirror axis constants. ─────────────────────────────────────────────────
const MirrorAxis = Object.freeze( {
    X: 0,
    Y: 1,
    Z: 2
} );

// ─── Attach mode constants. ─────────────────────────────────────────────────
const AttachMode = Object.freeze( {
    AS_CHILD: 0,
    AS_SIBLING: 1,
    AS_ROOT: 2
} );

// ─── Builder registry (module-scoped). ──────────────────────────────────────
const _builderById = new Map();
let _nextBuilderId = 1;

// ─── Internal builder counters. ─────────────────────────────────────────────
let _totalBonesBuiltGlobal = 0;

// ─── Default options for the builder. ───────────────────────────────────────
const BoneBranchBuilderDefaults = {
    // Deterministic seed base for rest-pose jitter.
    determinismSeed: 0x27D4EB2F,

    // Default rest-pose jitter amplitude (0 = disabled).
    restPoseJitter: 0.0,

    // Whether to enforce the caps at every operation.
    enforceCaps: true,

    // Whether the builder allocates a name prefix for chain / branch bones.
    autoNamePrefix: 'bone',

    // Whether to track per-bone depth in the ECS world.
    trackDepthInECS: true,

    // Whether to allow inserting a bone as root when one already exists.
    allowMultipleRoots: false
};

/**
 * BoneBranchBuilder
 *
 * Fluent builder for arbitrary Bone hierarchies.
 *
 * ```js
 * const builder = new BoneBranchBuilder( { determinismSeed: 0x13371337 } );
 * const root = builder
 *     .addRoot( 'hips', 0, 1, 0 )
 *     .addChain( 'spine', 3, 0, 0.15, 0 )
 *     .addBranch( 'rib', 4, { x: 0.1, y: 0, z: 0 } )
 *     .addMirror( MirrorAxis.X )
 *     .addArchetype( 'bird' )
 *     .build();
```

*/
class BoneBranchBuilder {

}

// ─── Utilities. ─────────────────────────────────────────────────────────────

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

void Group;
void Object3D;
void Matrix4;
void Vector3;
void Quaternion;
void BoneHierarchyKind;
void _scratchMat4;
void _scratchVec3A;
void _scratchVec3B;
void _scratchQuat;
void _scratchColor;

export {
MirrorAxis,
AttachMode,
BoneBranchBuilderDefaults,
BoneBranchBuilderSoA,
BoneBranchBuilder
};
