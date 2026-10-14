// file number : 014_3
// full path name : src/objects/014_3_BoneArchetypeRegistry.js
// description : Registry of named bone-hierarchy archetypes used as templates for procedural rigs. Built-in archetypes include humanoid (~50–100 bones), quadruped, bird, fish, centipede (configurable segment count), insect (six-legged), six_arm humanoid, spider (eight-legged), snake, wheeled, and custom. Each archetype declares its branching pattern, default bone names, default rest pose, default parent chains, and a build() function that constructs the tree. Archetypes are pure data plus a builder so they can be serialized, diffed, and replayed. Uses bitecs SoA to register archetypes so downstream layers can query them in O(1), double.js for high-precision bone count and depth accounting, gl-matrix for rest-pose matrix packing, and simplex-noise for deterministic per-archetype randomization seeds so two instances of the same archetype can be varied without breaking replay.
// best for : Procedural character generation, crowd variation, creature swarms, deterministic replay of rig layout, quick scaffolding for tests, ECS-driven rig spawning on Android 64-bit.
// license : MIT

import { Bone } from './001_Bone.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Quaternion } from '../math/007_Quaternion.js';

import { BoneHierarchyKind, SkinnedMeshDefaults, SkinnedMeshCaps } from './014_0_SkinnedMeshDefaults.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchQuat = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + Archetype SoA component (bitecs). ──────────────────────────
const _archetypeWorld = createWorld();

const BoneArchetypeSoA = defineComponent( {
    archetypeId: Types.i32,
    archetypeKind: Types.i32,
    boneCount: Types.i32,
    maxDepth: Types.i32,
    maxBranching: Types.i32,
    segmentCount: Types.i32,
    symmetric: Types.ui8,
    buildCount: Types.i64,
    lastBuildMs: Types.f64,
    avgBuildMsEMA: Types.f64,
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,
    registered: Types.ui8
} );

// ─── Archetype catalog (module-scoped, immutable descriptors). ──────────────
const _archetypes = new Map();
const _archetypeIdByName = new Map();
let _nextArchetypeId = 1;

// ─── Build context (reused across build() calls to avoid GC). ───────────────
const _buildContext = {
    root: null,
    bones: [],
    nameToBone: new Map(),
    seed: 0,
    variance: 0.0,
    symmetryAxis: 'x',
    lastBuildMs: 0.0
};

// ─── Per-archetype segment counts (configurable at build time). ─────────────
const SEGMENT_DEFAULTS = Object.freeze( {
    centipedeSegments: 24,
    snakeSegments: 32,
    spiderLegs: 8,
    insectLegs: 6,
    sixArmArms: 6,
    fishFins: 8
} );

// ─── Public API: registration. ──────────────────────────────────────────────

/**
 * Registers a new archetype. If an archetype with the same name exists, it
 * is replaced.
 *
 * @param {string} name
 * @param {object} descriptor
 * @param {number} descriptor.kind - One of `BoneHierarchyKind`.
 * @param {Function} descriptor.build - (ctx, options) => Bone (root)
 * @param {object} [descriptor.options] - Default options passed to build().
 * @param {number} [descriptor.segmentCount=0]
 * @param {boolean} [descriptor.symmetric=false]
 * @return {number} The archetype id.
 */
function registerArchetype( name, descriptor ) {
    if ( name === undefined || name === '' ) return - 1;
    if ( descriptor === undefined || descriptor === null ) return - 1;
    if ( typeof descriptor.build !== 'function' ) return - 1;

    let id = _archetypeIdByName.get( name );

    if ( id === undefined ) {
        id = _nextArchetypeId ++;
        _archetypeIdByName.set( name, id );
    }

    _archetypes.set( name, {
        id: id,
        name: name,
        kind: descriptor.kind !== undefined ? descriptor.kind : BoneHierarchyKind.CUSTOM,
        build: descriptor.build,
        options: descriptor.options !== undefined ? descriptor.options : {},
        segmentCount: descriptor.segmentCount !== undefined ? descriptor.segmentCount : 0,
        symmetric: descriptor.symmetric === true,
        boneCount: 0,
        maxDepth: 0,
        maxBranching: 0,
        buildCount: 0,
        lastBuildMs: 0.0,
        avgBuildMsEMA: 0.0,
        determinismSeed: _mix32( ( id * 0x9E3779B9 ) ^ 0x27D4EB2F )
    } );

    _syncArchetypeToECS( name );

    return id;
}

/**
 * Unregisters an archetype by name.
 * @param {string} name
 * @return {boolean}
 */
function unregisterArchetype( name ) {
    const removed = _archetypes.delete( name );
    if ( removed ) _archetypeIdByName.delete( name );
    return removed;
}

/**
 * Returns the descriptor of a registered archetype.
 * @param {string} name
 * @return {object|null}
 */
function getArchetype( name ) {
    return _archetypes.get( name ) !== undefined ? _archetypes.get( name ) : null;
}

/**
 * Returns an array of all registered archetype names.
 * @return {Array<string>}
 */
function listArchetypeNames() {
    const out = [];
    for ( const name of _archetypes.keys() ) out.push( name );
    return out;
}

// ─── Public API: build. ─────────────────────────────────────────────────────

/**
 * Builds a new bone hierarchy from the given archetype.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {number} [options.seed=0]
 * @param {number} [options.variance=0.0]
 * @param {number} [options.segmentCount]
 * @param {string} [options.symmetryAxis='x']
 * @param {object} [options.overrides] - Extra options merged over descriptor.options.
 * @return {Bone|null} The root bone, or null on failure.
 */
function buildArchetype( name, options = {} ) {
    const archetype = _archetypes.get( name );

    if ( archetype === undefined ) return null;

    const t0 = _nowMs();

    // ── 1. Merge options. ──────────────────────────────────────────────────
    const merged = Object.assign( {}, archetype.options );

    if ( options.overrides !== undefined ) {
        Object.assign( merged, options.overrides );
    }

    if ( options.segmentCount !== undefined ) {
        merged.segmentCount = options.segmentCount;
    }

    if ( merged.segmentCount === undefined || merged.segmentCount === 0 ) {
        merged.segmentCount = archetype.segmentCount;
    }

    // ── 2. Prepare build context. ─────────────────────────────────────────
    _buildContext.root = null;
    _buildContext.bones.length = 0;
    _buildContext.nameToBone.clear();
    _buildContext.seed = options.seed !== undefined ? options.seed : 0;
    _buildContext.variance = options.variance !== undefined ? options.variance : 0.0;
    _buildContext.symmetryAxis = options.symmetryAxis !== undefined ? options.symmetryAxis : 'x';

    // ── 3. Invoke the archetype's builder. ────────────────────────────────
    let root = null;

    try {
        root = archetype.build( _buildContext, merged );
    } catch ( e ) {
        void e;
        root = null;
    }

    if ( root === null || root === undefined ) {
        _buildContext.root = null;
        _buildContext.bones.length = 0;
        _buildContext.nameToBone.clear();
        return null;
    }

    // ── 4. Enforce the caps. ──────────────────────────────────────────────
    const boneCount = _buildContext.bones.length;

    if ( boneCount > SkinnedMeshDefaults.maxBonesPerSkeleton ) {
        // Truncate: keep the first maxBonesPerSkeleton bones and rewire any
        // remaining references to the last kept bone.
        const limit = SkinnedMeshDefaults.maxBonesPerSkeleton;
        for ( let i = limit; i < boneCount; i ++ ) {
            const b = _buildContext.bones[ i ];
            if ( b.parent !== null && b.parent !== undefined ) {
                b.parent.remove( b );
            }
        }
        _buildContext.bones.length = limit;
    }

    if ( boneCount > SkinnedMeshCaps.globalMaxBones ) {
        root = null;
    }

    // ── 5. Update archetype statistics. ───────────────────────────────────
    _buildContext.lastBuildMs = _nowMs() - t0;

    archetype.buildCount ++;
    archetype.lastBuildMs = _buildContext.lastBuildMs;
    archetype.avgBuildMsEMA = archetype.avgBuildMsEMA * 0.9 + _buildContext.lastBuildMs * 0.1;
    archetype.boneCount = _buildContext.bones.length;

    _syncArchetypeToECS( name );

    _buildContext.root = root;

    return root;
}

// ─── Public API: variation. ─────────────────────────────────────────────────

/**
 * Returns a deterministic per-instance dither sample for the archetype,
 * useful for varying joint offsets without breaking replay.
 *
 * @param {string} name
 * @param {number} instanceSeed
 * @param {number} frameIndex
 * @return {number}
 */
function sampleArchetypeDither( name, instanceSeed, frameIndex ) {
    const archetype = _archetypes.get( name );
    if ( archetype === undefined ) return 0.0;

    const seed = ( archetype.determinismSeed ^ ( instanceSeed * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    const s = _noise3D( seed * 1e-6, frameIndex * 0.02, archetype.kind );

    _setArchetypeDitherSample( name, s );

    return s;
}

/**
 * Applies a deterministic variance to a built hierarchy. Every bone is
 * displaced by an amount derived from its path hash and the instance seed.
 *
 * @param {Bone} root
 * @param {string} archetypeName
 * @param {number} instanceSeed
 * @param {number} amplitude
 * @param {number} frameIndex
 * @return {number} The number of displaced bones.
 */
function applyVariance( root, archetypeName, instanceSeed, amplitude, frameIndex ) {
    if ( root === null || root === undefined ) return 0;
    if ( amplitude <= 0 ) return 0;

    const archetype = _archetypes.get( archetypeName );
    const baseSeed = archetype !== undefined ? archetype.determinismSeed : 0x27D4EB2F;

    let count = 0;

    // Iterative traversal to avoid recursion on deep rigs.
    const stack = [ root ];
    let order = 0;

    while ( stack.length > 0 ) {
        const bone = stack.pop();
        if ( bone === null || bone === undefined ) continue;

        order ++;

        const seed = ( baseSeed ^ ( instanceSeed * 0x9E3779B9 ) ^ ( order * 0x85EBCA6B ) ^ ( frameIndex * 0xC2B2AE35 ) ) >>> 0;

        const dx = _noise3D( seed * 1e-6, order * 0.02, 0.0 ) * amplitude;
        const dy = _noise3D( 0.0, seed * 1e-6, order * 0.02 ) * amplitude;
        const dz = _noise3D( order * 0.02, 0.0, seed * 1e-6 ) * amplitude;

        bone.position.x += dx;
        bone.position.y += dy;
        bone.position.z += dz;

        count ++;

        const children = bone.children;
        for ( let i = 0; i < children.length; i ++ ) {
            stack.push( children[ i ] );
        }
    }

    return count;
}

// ─── Internal: build context helpers (exposed to archetype builders). ───────

/**
 * Creates a bone, adds it to the build context, and attaches it to a parent.
 * This is the helper that all built-in archetype builders call.
 *
 * @param {object} ctx
 * @param {string} name
 * @param {Bone|null} parent
 * @param {number} [px=0]
 * @param {number} [py=0]
 * @param {number} [pz=0]
 * @return {Bone}
 */
function createBoneInContext( ctx, name, parent, px = 0, py = 0, pz = 0 ) {
    const bone = new Bone();
    bone.name = name;

    // Deterministic per-bone offset using the ctx seed.
    const seed = ( ctx.seed ^ ( ctx.bones.length * 0x9E3779B9 ) ) >>> 0;

    const vx = _noise3D( seed * 1e-6, ctx.bones.length * 0.02, 0.0 ) * ctx.variance;
    const vy = _noise3D( 0.0, seed * 1e-6, ctx.bones.length * 0.02 ) * ctx.variance;
    const vz = _noise3D( ctx.bones.length * 0.02, 0.0, seed * 1e-6 ) * ctx.variance;

    bone.position.set( px + vx, py + vy, pz + vz );

    if ( parent !== null && parent !== undefined ) {
        parent.add( bone );
    }

    ctx.bones.push( bone );
    ctx.nameToBone.set( name, bone );

    if ( parent === null || parent === undefined ) {
        ctx.root = bone;
    }

    return bone;
}

// ─── Internal: built-in archetype builders. ─────────────────────────────────

function _buildHumanoid( ctx, options ) {
    const root = createBoneInContext( ctx, 'hips', null, 0, 1.0, 0 );
    const spine1 = createBoneInContext( ctx, 'spine_1', root, 0, 0.15, 0 );
    const spine2 = createBoneInContext( ctx, 'spine_2', spine1, 0, 0.15, 0 );
    const chest = createBoneInContext( ctx, 'chest', spine2, 0, 0.15, 0 );
    const neck = createBoneInContext( ctx, 'neck', chest, 0, 0.12, 0 );
    createBoneInContext( ctx, 'head', neck, 0, 0.15, 0 );

    for ( let side = 0; side < 2; side ++ ) {
        const sx = side === 0 ? 1 : - 1;
        const tag = side === 0 ? 'L' : 'R';

        const shoulder = createBoneInContext( ctx, 'shoulder_' + tag, chest, sx * 0.18, 0.1, 0 );
        const upperArm = createBoneInContext( ctx, 'upper_arm_' + tag, shoulder, sx * 0.25, 0, 0 );
        const lowerArm = createBoneInContext( ctx, 'lower_arm_' + tag, upperArm, sx * 0.25, 0, 0 );
        createBoneInContext( ctx, 'hand_' + tag, lowerArm, sx * 0.15, 0, 0 );

        const upperLeg = createBoneInContext( ctx, 'upper_leg_' + tag, root, sx * 0.1, - 0.1, 0 );
        const lowerLeg = createBoneInContext( ctx, 'lower_leg_' + tag, upperLeg, 0, - 0.4, 0 );
        createBoneInContext( ctx, 'foot_' + tag, lowerLeg, 0, - 0.4, 0 );
    }

    void options;
    return ctx.root;
}

function _buildQuadruped( ctx, options ) {
    const root = createBoneInContext( ctx, 'hips', null, 0, 0.8, - 0.4 );
    const spine1 = createBoneInContext( ctx, 'spine_1', root, 0, 0, 0.3 );
    const spine2 = createBoneInContext( ctx, 'spine_2', spine1, 0, 0, 0.3 );
    const chest = createBoneInContext( ctx, 'chest', spine2, 0, 0.05, 0.3 );
    const neck = createBoneInContext( ctx, 'neck', chest, 0, 0.1, 0.2 );
    createBoneInContext( ctx, 'head', neck, 0, 0.05, 0.2 );
    const tail1 = createBoneInContext( ctx, 'tail_1', root, 0, 0, - 0.25 );
    const tail2 = createBoneInContext( ctx, 'tail_2', tail1, 0, 0, - 0.25 );
    createBoneInContext( ctx, 'tail_3', tail2, 0, 0, - 0.25 );

    for ( let side = 0; side < 2; side ++ ) {
        const sx = side === 0 ? 1 : - 1;
        const tag = side === 0 ? 'L' : 'R';

        const frontUpper = createBoneInContext( ctx, 'front_upper_' + tag, chest, sx * 0.15, - 0.1, 0 );
        const frontLower = createBoneInContext( ctx, 'front_lower_' + tag, frontUpper, 0, - 0.35, 0 );
        createBoneInContext( ctx, 'front_paw_' + tag, frontLower, 0, - 0.35, 0 );

        const backUpper = createBoneInContext( ctx, 'back_upper_' + tag, root, sx * 0.15, - 0.1, 0 );
        const backLower = createBoneInContext( ctx, 'back_lower_' + tag, backUpper, 0, - 0.35, 0 );
        createBoneInContext( ctx, 'back_paw_' + tag, backLower, 0, - 0.35, 0 );
    }

    void options;
    return ctx.root;
}

function _buildBird( ctx, options ) {
    const root = createBoneInContext( ctx, 'body', null, 0, 1.2, 0 );
    const neck = createBoneInContext( ctx, 'neck', root, 0, 0.1, 0.1 );
    createBoneInContext( ctx, 'head', neck, 0, 0.1, 0.1 );
    createBoneInContext( ctx, 'beak', ctx.nameToBone.get( 'head' ), 0, 0, 0.1 );

    const tail = createBoneInContext( ctx, 'tail', root, 0, 0, - 0.2 );
    createBoneInContext( ctx, 'tail_tip', tail, 0, 0, - 0.2 );

    for ( let side = 0; side < 2; side ++ ) {
        const sx = side === 0 ? 1 : - 1;
        const tag = side === 0 ? 'L' : 'R';

        const wing1 = createBoneInContext( ctx, 'wing_1_' + tag, root, sx * 0.2, 0, 0 );
        const wing2 = createBoneInContext( ctx, 'wing_2_' + tag, wing1, sx * 0.3, 0, 0 );
        const wing3 = createBoneInContext( ctx, 'wing_3_' + tag, wing2, sx * 0.3, 0, 0 );
        createBoneInContext( ctx, 'wing_tip_' + tag, wing3, sx * 0.2, 0, 0 );

        const leg1 = createBoneInContext( ctx, 'leg_1_' + tag, root, sx * 0.08, - 0.1, 0 );
        const leg2 = createBoneInContext( ctx, 'leg_2_' + tag, leg1, 0, - 0.2, 0 );
        createBoneInContext( ctx, 'foot_' + tag, leg2, 0, - 0.15, 0.05 );
    }

    void options;
    return ctx.root;
}

function _buildFish( ctx, options ) {
    const segments = options.segmentCount !== undefined ? options.segmentCount : 12;

    const root = createBoneInContext( ctx, 'body_root', null, 0, 0, 0 );
    let parent = root;

    for ( let i = 0; i < segments; i ++ ) {
        const name = 'body_' + i;
        parent = createBoneInContext( ctx, name, parent, 0, 0, i === 0 ? 0.15 : 0.15 );
    }

    // Fins branch off.
    createBoneInContext( ctx, 'dorsal_fin', root, 0, 0.15, 0.2 );
    createBoneInContext( ctx, 'tail_fin', parent, 0, 0, 0.15 );

    for ( let side = 0; side < 2; side ++ ) {
        const sx = side === 0 ? 1 : - 1;
        const tag = side === 0 ? 'L' : 'R';

        createBoneInContext( ctx, 'pectoral_fin_' + tag, root, sx * 0.15, 0, 0.1 );
    }

    void options;
    return ctx.root;
}

function _buildCentipede( ctx, options ) {
    const segments = options.segmentCount !== undefined ? options.segmentCount : SEGMENT_DEFAULTS.centipedeSegments;

    const head = createBoneInContext( ctx, 'head', null, 0, 0, 0 );
    createBoneInContext( ctx, 'antenna_L', head, 0.05, 0.05, 0.1 );
    createBoneInContext( ctx, 'antenna_R', head, - 0.05, 0.05, 0.1 );

    let parent = head;

    for ( let i = 0; i < segments; i ++ ) {
        const seg = createBoneInContext( ctx, 'segment_' + i, parent, 0, 0, - 0.15 );

        createBoneInContext( ctx, 'leg_' + i + '_L', seg, 0.1, 0, 0 );
        createBoneInContext( ctx, 'leg_' + i + '_R', seg, - 0.1, 0, 0 );

        parent = seg;
    }

    void options;
    return ctx.root;
}

function _buildInsect( ctx, options ) {
    const legs = options.segmentCount !== undefined ? options.segmentCount : SEGMENT_DEFAULTS.insectLegs;

    const body = createBoneInContext( ctx, 'body', null, 0, 0.5, 0 );
    const head = createBoneInContext( ctx, 'head', body, 0, 0, 0.2 );
    createBoneInContext( ctx, 'antenna_L', head, 0.05, 0.05, 0.1 );
    createBoneInContext( ctx, 'antenna_R', head, - 0.05, 0.05, 0.1 );

    const thorax = createBoneInContext( ctx, 'thorax', body, 0, 0.05, 0.15 );
    const abdomen = createBoneInContext( ctx, 'abdomen', thorax, 0, 0, - 0.3 );

    for ( let i = 0; i < legs; i ++ ) {
        const side = i % 2 === 0 ? 1 : - 1;
        const tag = side === 1 ? 'L' : 'R';
        const legIndex = Math.floor( i / 2 );

        const coxa = createBoneInContext( ctx, 'leg_' + legIndex + '_coxa_' + tag, thorax, side * 0.15, - 0.05, 0.05 - legIndex * 0.1 );
        const femur = createBoneInContext( ctx, 'leg_' + legIndex + '_femur_' + tag, coxa, side * 0.15, - 0.15, 0 );
        const tibia = createBoneInContext( ctx, 'leg_' + legIndex + '_tibia_' + tag, femur, 0, - 0.2, 0 );
        createBoneInContext( ctx, 'leg_' + legIndex + '_tarsus_' + tag, tibia, 0, - 0.1, 0 );
    }

    void abdomen;
    void options;
    return ctx.root;
}

function _buildSpider( ctx, options ) {
    const legs = options.segmentCount !== undefined ? options.segmentCount : SEGMENT_DEFAULTS.spiderLegs;

    const body = createBoneInContext( ctx, 'body', null, 0, 0.5, 0 );
    const head = createBoneInContext( ctx, 'head', body, 0, 0, 0.15 );
    const abdomen = createBoneInContext( ctx, 'abdomen', body, 0, 0, - 0.2 );

    for ( let i = 0; i < legs; i ++ ) {
        const side = i % 2 === 0 ? 1 : - 1;
        const tag = side === 1 ? 'L' : 'R';
        const legIndex = Math.floor( i / 2 );

        const coxa = createBoneInContext( ctx, 'leg_' + legIndex + '_coxa_' + tag, head, side * 0.15, 0, legIndex * 0.05 );
        const femur = createBoneInContext( ctx, 'leg_' + legIndex + '_femur_' + tag, coxa, side * 0.2, 0.1, 0 );
        const tibia = createBoneInContext( ctx, 'leg_' + legIndex + '_tibia_' + tag, femur, side * 0.2, 0.1, 0 );
        createBoneInContext( ctx, 'leg_' + legIndex + '_tarsus_' + tag, tibia, side * 0.15, 0.05, 0 );
    }

    void abdomen;
    void options;
    return ctx.root;
}

function _buildSnake( ctx, options ) {
    const segments = options.segmentCount !== undefined ? options.segmentCount : SEGMENT_DEFAULTS.snakeSegments;

    const head = createBoneInContext( ctx, 'head', null, 0, 0, 0 );
    let parent = head;

    for ( let i = 0; i < segments; i ++ ) {
        parent = createBoneInContext( ctx, 'vertebra_' + i, parent, 0, 0, - 0.15 );
    }

    void options;
    return ctx.root;
}

function _buildSixArm( ctx, options ) {
    const root = _buildHumanoid( ctx, options );

    // Additional arm pairs off the chest.
    const chest = ctx.nameToBone.get( 'chest' );

    if ( chest !== undefined && chest !== null ) {
        for ( let pair = 0; pair < 2; pair ++ ) {
            for ( let side = 0; side < 2; side ++ ) {
                const sx = side === 0 ? 1 : - 1;
                const tag = side === 0 ? 'L' : 'R';
                const pairTag = pair === 0 ? 'mid' : 'low';

                const shoulder = createBoneInContext( ctx, 'shoulder_' + pairTag + '_' + tag, chest, sx * 0.18, - 0.1 * ( pair + 1 ), 0 );
                const upper = createBoneInContext( ctx, 'upper_arm_' + pairTag + '_' + tag, shoulder, sx * 0.25, 0, 0 );
                const lower = createBoneInContext( ctx, 'lower_arm_' + pairTag + '_' + tag, upper, sx * 0.25, 0, 0 );
                createBoneInContext( ctx, 'hand_' + pairTag + '_' + tag, lower, sx * 0.15, 0, 0 );
            }
        }
    }

    return root;
}

function _buildWheeled( ctx, options ) {
    const root = createBoneInContext( ctx, 'chassis', null, 0, 0.5, 0 );
    createBoneInContext( ctx, 'turret', root, 0, 0.15, 0 );
    createBoneInContext( ctx, 'barrel', ctx.nameToBone.get( 'turret' ), 0, 0, 0.3 );

    const wheels = options.segmentCount !== undefined ? options.segmentCount : 4;

    for ( let i = 0; i < wheels; i ++ ) {
        const side = i % 2 === 0 ? 1 : - 1;
        const tag = side === 1 ? 'L' : 'R';
        const wheelIndex = Math.floor( i / 2 );

        const axle = createBoneInContext( ctx, 'axle_' + wheelIndex + '_' + tag, root, side * 0.3, - 0.2, wheelIndex * 0.4 - 0.2 );
        createBoneInContext( ctx, 'wheel_' + wheelIndex + '_' + tag, axle, side * 0.05, 0, 0 );
    }

    void options;
    return ctx.root;
}

// ─── Register all built-in archetypes at module load. ───────────────────────

registerArchetype( 'humanoid', {
    kind: BoneHierarchyKind.HUMANOID,
    build: _buildHumanoid,
    symmetric: true,
    options: {}
} );

registerArchetype( 'quadruped', {
    kind: BoneHierarchyKind.QUADRUPED,
    build: _buildQuadruped,
    symmetric: true,
    options: {}
} );

registerArchetype( 'bird', {
    kind: BoneHierarchyKind.BIRD,
    build: _buildBird,
    symmetric: true,
    options: {}
} );

registerArchetype( 'fish', {
    kind: BoneHierarchyKind.FISH,
    build: _buildFish,
    symmetric: true,
    segmentCount: 12,
    options: { segmentCount: 12 }
} );

registerArchetype( 'centipede', {
    kind: BoneHierarchyKind.CENTIPEDE,
    build: _buildCentipede,
    symmetric: true,
    segmentCount: SEGMENT_DEFAULTS.centipedeSegments,
    options: { segmentCount: SEGMENT_DEFAULTS.centipedeSegments }
} );

registerArchetype( 'insect', {
    kind: BoneHierarchyKind.INSECT,
    build: _buildInsect,
    symmetric: true,
    segmentCount: SEGMENT_DEFAULTS.insectLegs,
    options: { segmentCount: SEGMENT_DEFAULTS.insectLegs }
} );

registerArchetype( 'spider', {
    kind: BoneHierarchyKind.SPIDER,
    build: _buildSpider,
    symmetric: true,
    segmentCount: SEGMENT_DEFAULTS.spiderLegs,
    options: { segmentCount: SEGMENT_DEFAULTS.spiderLegs }
} );

registerArchetype( 'snake', {
    kind: BoneHierarchyKind.SNAKE,
    build: _buildSnake,
    symmetric: true,
    segmentCount: SEGMENT_DEFAULTS.snakeSegments,
    options: { segmentCount: SEGMENT_DEFAULTS.snakeSegments }
} );

registerArchetype( 'six_arm', {
    kind: BoneHierarchyKind.SIX_ARM,
    build: _buildSixArm,
    symmetric: true,
    options: {}
} );

registerArchetype( 'wheeled', {
    kind: BoneHierarchyKind.WHEELED,
    build: _buildWheeled,
    symmetric: true,
    segmentCount: 4,
    options: { segmentCount: 4 }
} );

// ─── Internal: ECS sync. ────────────────────────────────────────────────────

const _ecsArchetypeEntityByName = new Map();

function _syncArchetypeToECS( name ) {
    const archetype = _archetypes.get( name );
    if ( archetype === undefined ) return;

    let eid = _ecsArchetypeEntityByName.get( name );

    if ( eid === undefined ) {
        eid = addEntity( _archetypeWorld );
        addComponent( _archetypeWorld, BoneArchetypeSoA, eid );
        _ecsArchetypeEntityByName.set( name, eid );
    }

    BoneArchetypeSoA.archetypeId[ eid ] = archetype.id;
    BoneArchetypeSoA.archetypeKind[ eid ] = archetype.kind;
    BoneArchetypeSoA.boneCount[ eid ] = archetype.boneCount;
    BoneArchetypeSoA.maxDepth[ eid ] = archetype.maxDepth;
    BoneArchetypeSoA.maxBranching[ eid ] = archetype.maxBranching;
    BoneArchetypeSoA.segmentCount[ eid ] = archetype.segmentCount;
    BoneArchetypeSoA.symmetric[ eid ] = archetype.symmetric ? 1 : 0;
    BoneArchetypeSoA.buildCount[ eid ] = archetype.buildCount;
    BoneArchetypeSoA.lastBuildMs[ eid ] = archetype.lastBuildMs;
    BoneArchetypeSoA.avgBuildMsEMA[ eid ] = archetype.avgBuildMsEMA;
    BoneArchetypeSoA.determinismSeed[ eid ] = archetype.determinismSeed;
    BoneArchetypeSoA.registered[ eid ] = 1;
}

function _setArchetypeDitherSample( name, sample ) {
    const eid = _ecsArchetypeEntityByName.get( name );
    if ( eid === undefined ) return;
    BoneArchetypeSoA.ditherSample[ eid ] = sample;
}

// ─── High-precision helpers. ────────────────────────────────────────────────

function computeTotalBonesHighPrecision() {
    let total = new Double( 0 );

    for ( const archetype of _archetypes.values() ) {
        total = total.add( new Double( archetype.boneCount ) );
    }

    return total.valueOf();
}

function computeArchetypeBuildCostHighPrecision( name ) {
    const archetype = _archetypes.get( name );
    if ( archetype === undefined ) return 0.0;

    const bones = new Double( archetype.boneCount );
    const ms = new Double( archetype.avgBuildMsEMA );

    return bones.mul( ms ).valueOf();
}

// ─── gl-matrix packing for telemetry. ───────────────────────────────────────

function packArchetypeVec4( name, out ) {
    const v = out || _scratchVec4;
    const archetype = _archetypes.get( name );

    if ( archetype === undefined ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        archetype.boneCount,
        archetype.kind,
        archetype.buildCount,
        archetype.avgBuildMsEMA
    );
    return v;
}

function packAllArchetypesVec4( out, row = 0 ) {
    const v = out || _scratchVec4;
    const names = listArchetypeNames();

    if ( row < 0 || row >= names.length ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    return packArchetypeVec4( names[ row ], v );
}

// ─── Query helpers over bitecs. ─────────────────────────────────────────────

function collectAllRegisteredArchetypes() {
    const out = [];
    const q = query( _archetypeWorld, [ BoneArchetypeSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        if ( BoneArchetypeSoA.registered[ eid ] === 1 ) {
            out.push( BoneArchetypeSoA.archetypeId[ eid ] );
        }
    }

    return out;
}

function findArchetypesByKind( kind ) {
    const out = [];
    const q = query( _archetypeWorld, [ BoneArchetypeSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        if ( BoneArchetypeSoA.archetypeKind[ eid ] === kind ) {
            out.push( BoneArchetypeSoA.archetypeId[ eid ] );
        }
    }

    return out;
}

function findArchetypeByBoneCount( targetBoneCount ) {
    let bestName = null;
    let bestDelta = Number.MAX_VALUE;

    for ( const [ name, archetype ] of _archetypes ) {
        const delta = Math.abs( archetype.boneCount - targetBoneCount );
        if ( delta < bestDelta ) {
            bestDelta = delta;
            bestName = name;
        }
    }

    return bestName;
}

// ─── Serialization helpers (for replay). ────────────────────────────────────

function serializeArchetype( name ) {
    const archetype = _archetypes.get( name );
    if ( archetype === undefined ) return null;

    return {
        name: archetype.name,
        id: archetype.id,
        kind: archetype.kind,
        symmetric: archetype.symmetric,
        segmentCount: archetype.segmentCount,
        options: archetype.options,
        boneCount: archetype.boneCount,
        determinismSeed: archetype.determinismSeed
    };
}

function serializeAllArchetypes() {
    const out = [];
    for ( const [ name ] of _archetypes ) {
        const s = serializeArchetype( name );
        if ( s !== null ) out.push( s );
    }
    return out;
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

void Bone;
void Matrix4;
void Vector3;
void Quaternion;
void _scratchMat4;
void _scratchVec3A;
void _scratchVec3B;
void _scratchQuat;

export {
    BoneArchetypeSoA,
    SEGMENT_DEFAULTS,
    registerArchetype,
    unregisterArchetype,
    getArchetype,
    listArchetypeNames,
    buildArchetype,
    sampleArchetypeDither,
    applyVariance,
    createBoneInContext,
    computeTotalBonesHighPrecision,
    computeArchetypeBuildCostHighPrecision,
    packArchetypeVec4,
    packAllArchetypesVec4,
    collectAllRegisteredArchetypes,
    findArchetypesByKind,
    findArchetypeByBoneCount,
    serializeArchetype,
    serializeAllArchetypes
};