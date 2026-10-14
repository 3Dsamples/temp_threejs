// file number : 014_0
// full path name : src/objects/014_0_SkinnedMeshDefaults.js
// description : Shared defaults, enums, and tunables for the entire SkinnedMesh companion set. Defines BonesPerVertex (2 / 4 / 8), SkinningQuality tiers, BoneHierarchyKind (humanoid, quadruped, bird, fish, centipede, insect, six_arm, spider, snake, wheeled, custom), SkinWeightLayout (interleaved, planar, packed, variable), TopologyKind (triangles, quads, grid, subdiv, nurbs, procedural), and the global hard caps used by every other 014_N_ module. Uses simplex-noise for tier boundary dithering, bitecs for SoA defaults registry, double.js for high-precision cap accounting, and gl-matrix for cap projection into vec4 telemetry.
// best for : Central tuning point for all skinning behavior, single source of truth for enums, prevents per-file duplication of magic numbers across the 014_N_ family.
// license : MIT

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

const _scratchVec4 = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── Bones per vertex. ──────────────────────────────────────────────────────
const BonesPerVertex = Object.freeze( {
    TWO: 2,
    FOUR: 4,
    EIGHT: 8
} );

// ─── Skinning quality tiers. ────────────────────────────────────────────────
const SkinningQuality = Object.freeze( {
    LOW: 0,
    MEDIUM: 1,
    HIGH: 2,
    ULTRA: 3
} );

// ─── Bone hierarchy archetypes. ─────────────────────────────────────────────
const BoneHierarchyKind = Object.freeze( {
    UNKNOWN: 0,
    HUMANOID: 1,
    QUADRUPED: 2,
    BIRD: 3,
    FISH: 4,
    CENTIPEDE: 5,
    INSECT: 6,
    SIX_ARM: 7,
    SPIDER: 8,
    SNAKE: 9,
    WHEELED: 10,
    CUSTOM: 11
} );

// ─── Skin weight layouts. ───────────────────────────────────────────────────
const SkinWeightLayout = Object.freeze( {
    INTERLEAVED: 0,
    PLANAR: 1,
    PACKED: 2,
    VARIABLE: 3
} );

// ─── Topology kinds. ────────────────────────────────────────────────────────
const TopologyKind = Object.freeze( {
    UNKNOWN: 0,
    TRIANGLES: 1,
    QUADS: 2,
    GRID: 3,
    SUBDIV: 4,
    NURBS: 5,
    PROCEDURAL: 6
} );

// ─── Global hard caps. ──────────────────────────────────────────────────────
const SkinnedMeshCaps = Object.freeze( {
    globalMaxBones: 512,
    globalMaxHierarchyDepth: 64,
    globalMaxBranchingFactor: 64,
    globalMaxBonesPerVertex: 8,
    globalMaxVertexCount: 4194304,
    globalMaxTopologyAdjacencyDegree: 32,
    globalMaxSubdivisionLevel: 4
} );

// ─── Per-tier defaults. ─────────────────────────────────────────────────────
const TIER_DEFAULTS = {
    LOW: {
        bonesPerVertex: BonesPerVertex.FOUR,
        quality: SkinningQuality.LOW,
        weightLayout: SkinWeightLayout.PACKED,
        maxBonesPerSkeleton: 64,
        maxHierarchyDepth: 12,
        maxBranchingFactor: 8,
        maxVertexCount: 32768,
        cacheBytes: 32 * 1024 * 1024,
        allowSubdivision: false,
        compressWeights: true,
        autoAssignWeights: true
    },
    MID: {
        bonesPerVertex: BonesPerVertex.FOUR,
        quality: SkinningQuality.MEDIUM,
        weightLayout: SkinWeightLayout.PACKED,
        maxBonesPerSkeleton: 96,
        maxHierarchyDepth: 24,
        maxBranchingFactor: 16,
        maxVertexCount: 131072,
        cacheBytes: 96 * 1024 * 1024,
        allowSubdivision: true,
        compressWeights: true,
        autoAssignWeights: true
    },
    HIGH: {
        bonesPerVertex: BonesPerVertex.FOUR,
        quality: SkinningQuality.HIGH,
        weightLayout: SkinWeightLayout.INTERLEAVED,
        maxBonesPerSkeleton: 128,
        maxHierarchyDepth: 32,
        maxBranchingFactor: 32,
        maxVertexCount: 524288,
        cacheBytes: 224 * 1024 * 1024,
        allowSubdivision: true,
        compressWeights: false,
        autoAssignWeights: true
    },
    FLAGSHIP: {
        bonesPerVertex: BonesPerVertex.EIGHT,
        quality: SkinningQuality.ULTRA,
        weightLayout: SkinWeightLayout.INTERLEAVED,
        maxBonesPerSkeleton: 192,
        maxHierarchyDepth: 64,
        maxBranchingFactor: 64,
        maxVertexCount: 2097152,
        cacheBytes: 384 * 1024 * 1024,
        allowSubdivision: true,
        compressWeights: false,
        autoAssignWeights: true
    }
};

// ─── ECS world + Defaults SoA registry (bitecs). ────────────────────────────
const _defaultsWorld = createWorld();

const SkinnedMeshDefaultsSoA = defineComponent( {
    androidTier: Types.i32,
    bonesPerVertex: Types.i32,
    quality: Types.i32,
    weightLayout: Types.i32,
    maxBonesPerSkeleton: Types.i32,
    maxHierarchyDepth: Types.i32,
    maxBranchingFactor: Types.i32,
    maxVertexCount: Types.i32,
    cacheBytes: Types.f64,
    allowSubdivision: Types.ui8,
    compressWeights: Types.ui8,
    autoAssignWeights: Types.ui8,
    tierName: Types.i32,
    ditherSample: Types.f64
} );

let _defaultsEntity = - 1;

function _ensureDefaultsEntity() {
    if ( _defaultsEntity >= 0 ) return _defaultsEntity;
    const e = addEntity( _defaultsWorld );
    addComponent( _defaultsWorld, SkinnedMeshDefaultsSoA, e );
    _defaultsEntity = e;
    return e;
}

// ─── Defaults state. ────────────────────────────────────────────────────────
const SkinnedMeshDefaults = {
    androidTier: 2,
    bonesPerVertex: BonesPerVertex.FOUR,
    quality: SkinningQuality.MEDIUM,
    weightLayout: SkinWeightLayout.PACKED,
    maxBonesPerSkeleton: 96,
    maxHierarchyDepth: 24,
    maxBranchingFactor: 16,
    maxVertexCount: 131072,
    cacheBytes: 96 * 1024 * 1024,
    allowSubdivision: true,
    compressWeights: true,
    autoAssignWeights: true,
    determinismSeed: 0x27D4EB2F
};

// ─── Tier application. ──────────────────────────────────────────────────────
function applyAndroidTier( tier ) {
    let key;
    switch ( tier ) {
        case 1: key = 'LOW'; break;
        case 2: key = 'MID'; break;
        case 3: key = 'HIGH'; break;
        case 4: key = 'FLAGSHIP'; break;
        default: key = 'MID';
    }

    const t = TIER_DEFAULTS[ key ];

    SkinnedMeshDefaults.androidTier = tier;
    SkinnedMeshDefaults.bonesPerVertex = t.bonesPerVertex;
    SkinnedMeshDefaults.quality = t.quality;
    SkinnedMeshDefaults.weightLayout = t.weightLayout;
    SkinnedMeshDefaults.maxBonesPerSkeleton = t.maxBonesPerSkeleton;
    SkinnedMeshDefaults.maxHierarchyDepth = t.maxHierarchyDepth;
    SkinnedMeshDefaults.maxBranchingFactor = t.maxBranchingFactor;
    SkinnedMeshDefaults.maxVertexCount = t.maxVertexCount;
    SkinnedMeshDefaults.cacheBytes = t.cacheBytes;
    SkinnedMeshDefaults.allowSubdivision = t.allowSubdivision;
    SkinnedMeshDefaults.compressWeights = t.compressWeights;
    SkinnedMeshDefaults.autoAssignWeights = t.autoAssignWeights;

    const eid = _ensureDefaultsEntity();

    SkinnedMeshDefaultsSoA.androidTier[ eid ] = tier;
    SkinnedMeshDefaultsSoA.bonesPerVertex[ eid ] = t.bonesPerVertex;
    SkinnedMeshDefaultsSoA.quality[ eid ] = t.quality;
    SkinnedMeshDefaultsSoA.weightLayout[ eid ] = t.weightLayout;
    SkinnedMeshDefaultsSoA.maxBonesPerSkeleton[ eid ] = t.maxBonesPerSkeleton;
    SkinnedMeshDefaultsSoA.maxHierarchyDepth[ eid ] = t.maxHierarchyDepth;
    SkinnedMeshDefaultsSoA.maxBranchingFactor[ eid ] = t.maxBranchingFactor;
    SkinnedMeshDefaultsSoA.maxVertexCount[ eid ] = t.maxVertexCount;
    SkinnedMeshDefaultsSoA.cacheBytes[ eid ] = t.cacheBytes;
    SkinnedMeshDefaultsSoA.allowSubdivision[ eid ] = t.allowSubdivision ? 1 : 0;
    SkinnedMeshDefaultsSoA.compressWeights[ eid ] = t.compressWeights ? 1 : 0;
    SkinnedMeshDefaultsSoA.autoAssignWeights[ eid ] = t.autoAssignWeights ? 1 : 0;
    SkinnedMeshDefaultsSoA.tierName[ eid ] = tier;

    return SkinnedMeshDefaults;
}

// ─── High-precision cap check via double.js. ────────────────────────────────
function exceedsGlobalCaps( boneCount, depth, branching, vertexCount ) {
    const b = new Double( boneCount );
    const d = new Double( depth );
    const br = new Double( branching );
    const v = new Double( vertexCount );

    if ( b.valueOf() > SkinnedMeshCaps.globalMaxBones ) return true;
    if ( d.valueOf() > SkinnedMeshCaps.globalMaxHierarchyDepth ) return true;
    if ( br.valueOf() > SkinnedMeshCaps.globalMaxBranchingFactor ) return true;
    if ( v.valueOf() > SkinnedMeshCaps.globalMaxVertexCount ) return true;

    return false;
}

// ─── Dither on the tier boundary via simplex-noise. ─────────────────────────
function computeTierBoundaryDither( tier, frameIndex ) {
    const seed = ( SkinnedMeshDefaults.determinismSeed ^ ( tier * 0x9E3779B9 ) ) >>> 0;
    const n = _noise3D( seed * 1e-6, frameIndex * 0.02, tier );
    const eid = _ensureDefaultsEntity();
    SkinnedMeshDefaultsSoA.ditherSample[ eid ] = n;
    return n;
}

// ─── Pack defaults into a vec4 via gl-matrix for telemetry. ─────────────────
function packDefaultsVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
        v,
        SkinnedMeshDefaults.bonesPerVertex,
        SkinnedMeshDefaults.quality,
        SkinnedMeshDefaults.weightLayout,
        SkinnedMeshDefaults.androidTier
    );
    return v;
}

// ─── Initialize defaults for MID tier at module load. ───────────────────────
applyAndroidTier( 2 );

export {
    BonesPerVertex,
    SkinningQuality,
    BoneHierarchyKind,
    SkinWeightLayout,
    TopologyKind,
    SkinnedMeshCaps,
    TIER_DEFAULTS,
    SkinnedMeshDefaults,
    SkinnedMeshDefaultsSoA,
    applyAndroidTier,
    exceedsGlobalCaps,
    computeTierBoundaryDither,
    packDefaultsVec4
};