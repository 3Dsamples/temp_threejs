// file number : 014_7_5
// full path name : src/objects/014_7_5_SkinWeightAdjacentOverlap.js
// description : Guarantees that no bone in a skeleton is left without automatic influence and that every parent-child and sibling-adjacent bone overlaps its neighbors with a natural, seamless weight transition. Built directly on top of 014_7_SkinWeightAutoAssign: after the initial top-K assignment, this module runs an overlap expansion pass that injects a controlled amount of parent, child, and sibling influence into every vertex, so a joint like the Left Shoulder Lower always bleeds into the Left Lower Arm region and vice versa, while the boundary weight is smoothly faded rather than cut. Also closes dead zones where no bone reached the vertex by walking up the parent chain and injecting the nearest ancestor. Uses smoothstep / cubic falloff kernels instead of raw inverse-distance so the transition is organic, not linear. All passes are allocation-free over raw typed arrays. Uses bitecs SoA for per-mesh overlap state, double.js for high-precision weight-sum and coverage accounting, gl-matrix for smoothstep vector packing and radius projection into vec4 telemetry, and simplex-noise for deterministic tie-breaking when two adjacent bones compete for the same vertex.
// best for : Auto-rigged characters, procedural creature swarms, foliage-on-bone rigs, tails and tentacles where segments must chain smoothly, insect legs where coxa / femur / tibia must blend, humanoid joints (shoulder → elbow → wrist, hip → knee → ankle), filling gaps left by naive top-K assignment, guaranteeing seamless organic motion on Android 64-bit (Adreno 5xx–7xx, Mali-G5x–G7xx), deterministic replay of overlap passes.
// license : MIT

import { Bone } from './001_Bone.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { Float32BufferAttribute, Uint16BufferAttribute, Uint8BufferAttribute, Uint32BufferAttribute } from '../core/020_BufferAttribute.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Vector3 } from '../math/004_Vector3.js';

import { BonesPerVertex, SkinWeightLayout, SkinnedMeshDefaults, SkinnedMeshCaps } from './014_0_SkinnedMeshDefaults.js';
import { SkinWeightLayoutSoA, ATTR_SKIN_INDEX, ATTR_SKIN_WEIGHT } from './014_6_SkinWeightLayout.js';
import { getLastAssignResult } from './014_7_SkinWeightAutoAssign.js';

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

// ─── ECS world + AdjacentOverlap SoA component (bitecs). ────────────────────
const _overlapWorld = createWorld();

const SkinWeightAdjacentOverlapSoA = defineComponent( {
    geometryId: Types.i32,
    geometryUuidHash: Types.i32,
    skeletonId: Types.i32,
    vertexCount: Types.i32,
    boneCount: Types.i32,
    bonesPerVertex: Types.i32,

    // Overlap parameters
    parentOverlapFactor: Types.f64,
    childOverlapFactor: Types.f64,
    siblingOverlapFactor: Types.f64,
    coverageFallbackFactor: Types.f64,
    overlapRadiusScale: Types.f64,
    falloffKernel: Types.i32,

    // Statistics
    verticesExpandedWithParent: Types.i32,
    verticesExpandedWithChild: Types.i32,
    verticesExpandedWithSibling: Types.i32,
    verticesCoverageFallback: Types.i32,
    totalInjectedWeights: Types.i64,
    avgOverlapCount: Types.f64,
    maxOverlapCount: Types.i32,

    // Coverage guarantees
    deadZoneVerticesBefore: Types.i32,
    deadZoneVerticesAfter: Types.i32,
    coverageGuaranteed: Types.ui8,

    // Timing
    lastPassMs: Types.f64,
    avgPassMsEMA: Types.f64,
    lastExpandPassMs: Types.f64,
    lastCoveragePassMs: Types.f64,
    lastWritePassMs: Types.f64,

    // Determinism
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    registered: Types.ui8,
    applied: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Falloff kernel constants. ──────────────────────────────────────────────
const FalloffKernel = Object.freeze( {
    LINEAR: 0,
    SMOOTHSTEP: 1,
    CUBIC: 2,
    QUINTIC: 3
} );

// ─── Reusable overlap result record. ────────────────────────────────────────
const _overlapResult = {
    vertexCount: 0,
    boneCount: 0,
    bonesPerVertex: 4,
    verticesExpandedWithParent: 0,
    verticesExpandedWithChild: 0,
    verticesExpandedWithSibling: 0,
    verticesCoverageFallback: 0,
    totalInjectedWeights: 0,
    avgOverlapCount: 0.0,
    maxOverlapCount: 0,
    deadZoneVerticesBefore: 0,
    deadZoneVerticesAfter: 0,
    lastPassMs: 0.0,
    lastExpandPassMs: 0.0,
    lastCoveragePassMs: 0.0,
    lastWritePassMs: 0.0
};

// ─── Reusable default options. ──────────────────────────────────────────────
const AdjacentOverlapDefaults = {
    // Fraction of the parent bone's weight injected into each of its
    // children's vertices, producing a natural bleed at the joint.
    parentOverlapFactor: 0.35,

    // Fraction of the child bone's weight injected into its parent's vertices.
    childOverlapFactor: 0.35,

    // Fraction injected from sibling bones (same parent) at shared joints.
    siblingOverlapFactor: 0.20,

    // Fallback injection factor when a vertex has zero assigned influence.
    coverageFallbackFactor: 1.0,

    // Multiplier applied to the bone segment length to derive overlap radius.
    overlapRadiusScale: 1.5,

    // Falloff kernel used for overlap transitions.
    falloffKernel: FalloffKernel.SMOOTHSTEP,

    // Minimum total weight below which a vertex is treated as a dead zone.
    deadZoneWeightThreshold: 1e-4,

    // Maximum number of passes; one pass is usually enough.
    maxPasses: 1,

    // Whether to enforce coverage on every vertex after overlap.
    guaranteeCoverage: true,

    // Whether to apply sibling cross-blend at branch joints.
    crossSiblingBlend: true,

    // Whether to inject overlap into planar layouts too.
    supportPlanarLayouts: true,

    // Deterministic seed base for tie-breaking.
    determinismSeed: 0x27D4EB2F,

    // Emit per-vertex dither for telemetry.
    emitDither: true
};

// ─── Reusable per-vertex candidate buffer (top-K tracking). ─────────────────
let _overlapWeights = null;
let _overlapIndices = null;
let _overlapCapacity = 0;

// ─── Reusable bone segment cache (mirrors 014_7 layout). ────────────────────
let _boneSegA = null;
let _boneSegB = null;
let _boneRadius = null;
let _boneParentIdx = null;
let _boneChildStart = null;
let _boneChildCount = null;
let _boneChildrenFlat = null;
let _boneCapacity = 0;

// ─── Public API: apply. ─────────────────────────────────────────────────────

/**
 * Applies the adjacent-overlap pass to the geometry that was previously
 * processed by 014_7_SkinWeightAutoAssign. Guarantees seamless weight
 * transitions between every parent, child, and sibling bone pair.
 *
 * @param {BufferGeometry} geometry
 * @param {Array<Bone>} bones
 * @param {object} [options]
 * @return {object} The overlap result record.
 */
function applyAdjacentOverlap( geometry, bones, options = {} ) {
    const t0 = _nowMs();

    const parentOverlapFactor = options.parentOverlapFactor !== undefined
        ? options.parentOverlapFactor
        : AdjacentOverlapDefaults.parentOverlapFactor;

    const childOverlapFactor = options.childOverlapFactor !== undefined
        ? options.childOverlapFactor
        : AdjacentOverlapDefaults.childOverlapFactor;

    const siblingOverlapFactor = options.siblingOverlapFactor !== undefined
        ? options.siblingOverlapFactor
        : AdjacentOverlapDefaults.siblingOverlapFactor;

    const coverageFallbackFactor = options.coverageFallbackFactor !== undefined
        ? options.coverageFallbackFactor
        : AdjacentOverlapDefaults.coverageFallbackFactor;

    const overlapRadiusScale = options.overlapRadiusScale !== undefined
        ? options.overlapRadiusScale
        : AdjacentOverlapDefaults.overlapRadiusScale;

    const falloffKernel = options.falloffKernel !== undefined
        ? options.falloffKernel
        : AdjacentOverlapDefaults.falloffKernel;

    const deadZoneWeightThreshold = options.deadZoneWeightThreshold !== undefined
        ? options.deadZoneWeightThreshold
        : AdjacentOverlapDefaults.deadZoneWeightThreshold;

    const guaranteeCoverage = options.guaranteeCoverage !== undefined
        ? options.guaranteeCoverage === true
        : AdjacentOverlapDefaults.guaranteeCoverage;

    const crossSiblingBlend = options.crossSiblingBlend !== undefined
        ? options.crossSiblingBlend === true
        : AdjacentOverlapDefaults.crossSiblingBlend;

    const frameIndex = options.frameIndex | 0;
    const layout = options.layout !== undefined ? options.layout : SkinnedMeshDefaults.weightLayout;
    const bonesPerVertex = options.bonesPerVertex !== undefined
        ? options.bonesPerVertex
        : SkinnedMeshDefaults.bonesPerVertex;
    const skeletonId = options.skeletonId !== undefined ? options.skeletonId : - 1;

    // ── 1. Reset the result record. ────────────────────────────────────────
    _overlapResult.vertexCount = 0;
    _overlapResult.boneCount = 0;
    _overlapResult.bonesPerVertex = bonesPerVertex;
    _overlapResult.verticesExpandedWithParent = 0;
    _overlapResult.verticesExpandedWithChild = 0;
    _overlapResult.verticesExpandedWithSibling = 0;
    _overlapResult.verticesCoverageFallback = 0;
    _overlapResult.totalInjectedWeights = 0;
    _overlapResult.avgOverlapCount = 0.0;
    _overlapResult.maxOverlapCount = 0;
    _overlapResult.deadZoneVerticesBefore = 0;
    _overlapResult.deadZoneVerticesAfter = 0;
    _overlapResult.lastPassMs = 0.0;
    _overlapResult.lastExpandPassMs = 0.0;
    _overlapResult.lastCoveragePassMs = 0.0;
    _overlapResult.lastWritePassMs = 0.0;

    if ( geometry === undefined || geometry === null ) {
        _overlapResult.lastPassMs = _nowMs() - t0;
        return _overlapResult;
    }

    if ( bones === undefined || bones === null || bones.length === 0 ) {
        _overlapResult.lastPassMs = _nowMs() - t0;
        return _overlapResult;
    }

    const positionAttribute = geometry.attributes.position;
    const skinWeight = geometry.attributes[ ATTR_SKIN_WEIGHT ];
    const skinIndex = geometry.attributes[ ATTR_SKIN_INDEX ];

    if ( positionAttribute === undefined ) {
        _overlapResult.lastPassMs = _nowMs() - t0;
        return _overlapResult;
    }

    if ( skinWeight === undefined || skinIndex === undefined ) {
        _overlapResult.lastPassMs = _nowMs() - t0;
        return _overlapResult;
    }

    const vertexCount = positionAttribute.count;
    const boneCount = Math.min( bones.length, SkinnedMeshCaps.globalMaxBones );

    _overlapResult.vertexCount = vertexCount;
    _overlapResult.boneCount = boneCount;

    if ( vertexCount === 0 || boneCount === 0 ) {
        _overlapResult.lastPassMs = _nowMs() - t0;
        return _overlapResult;
    }

    // ── 2. Build the bone hierarchy index (parent, children, radius). ────
    _buildBoneHierarchyIndex( bones, boneCount, overlapRadiusScale );

    // ── 3. Allocate the working weight / index buffers. ──────────────────
    _ensureOverlapBuffers( vertexCount, bonesPerVertex );

    // ── 4. Load the current top-K weights / indices into the working set. ─
    _loadCurrentAssignment( skinWeight.array, skinIndex.array, vertexCount, bonesPerVertex );

    // ── 5. Count dead zones before the overlap pass (telemetry only). ────
    _countDeadZones( vertexCount, bonesPerVertex, deadZoneWeightThreshold, true );

    // ── 6. Expand pass: inject parent / child / sibling influence. ────────
    const tExpand = _nowMs();
    _expandWithAdjacent(
        positionAttribute.array,
        vertexCount,
        bonesPerVertex,
        parentOverlapFactor,
        childOverlapFactor,
        siblingOverlapFactor,
        overlapRadiusScale,
        falloffKernel,
        crossSiblingBlend,
        frameIndex
    );
    _overlapResult.lastExpandPassMs = _nowMs() - tExpand;

    // ── 7. Coverage pass: guarantee no vertex is left unweighted. ────────
    const tCoverage = _nowMs();
    if ( guaranteeCoverage ) {
        _guaranteeCoverage(
            positionAttribute.array,
            bones,
            vertexCount,
            bonesPerVertex,
            coverageFallbackFactor,
            deadZoneWeightThreshold,
            falloffKernel
        );
    }
    _overlapResult.lastCoveragePassMs = _nowMs() - tCoverage;

    // ── 8. Count dead zones after the overlap pass. ──────────────────────
    _countDeadZones( vertexCount, bonesPerVertex, deadZoneWeightThreshold, false );

    // ── 9. Write pass: emit attributes back to the geometry. ─────────────
    const tWrite = _nowMs();
    _writeOverlapResult( geometry, vertexCount, bonesPerVertex, layout );
    _overlapResult.lastWritePassMs = _nowMs() - tWrite;

    // ── 10. Update aggregate metrics via double.js. ──────────────────────
    if ( vertexCount > 0 ) {
        const totalOverlap = new Double( _overlapResult.totalInjectedWeights );
        _overlapResult.avgOverlapCount = totalOverlap.div( new Double( vertexCount ) ).valueOf();
    }

    _overlapResult.lastPassMs = _nowMs() - t0;

    // ── 11. Sync ECS state. ──────────────────────────────────────────────
    const geometryHash = options.geometryHash !== undefined && options.geometryHash !== 0
        ? options.geometryHash
        : _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );

    _syncOverlapECS(
        geometry,
        geometryHash,
        skeletonId,
        bonesPerVertex,
        parentOverlapFactor,
        childOverlapFactor,
        siblingOverlapFactor,
        coverageFallbackFactor,
        overlapRadiusScale,
        falloffKernel,
        frameIndex
    );

    return _overlapResult;
}

// ─── Internal: bone hierarchy index build. ──────────────────────────────────

function _buildBoneHierarchyIndex( bones, boneCount, overlapRadiusScale ) {
    const needed = boneCount * 3;

    if ( _boneSegA === null || _boneCapacity < needed ) {
        _boneSegA = new Float32Array( Math.max( needed, _boneCapacity * 2, 256 ) );
        _boneSegB = new Float32Array( Math.max( needed, _boneCapacity * 2, 256 ) );
        _boneRadius = new Float32Array( Math.max( boneCount, 32 ) );
        _boneParentIdx = new Int32Array( Math.max( boneCount, 32 ) );
        _boneChildStart = new Int32Array( Math.max( boneCount + 1, 33 ) );
        _boneChildCount = new Int32Array( Math.max( boneCount, 32 ) );
        _boneChildrenFlat = new Int32Array( Math.max( boneCount, 32 ) );
        _boneCapacity = Math.max( needed, _boneCapacity * 2, 256 );
    }

    const segA = _boneSegA;
    const segB = _boneSegB;
    const radii = _boneRadius;
    const parentIdx = _boneParentIdx;
    const childStart = _boneChildStart;
    const childCount = _boneChildCount;
    const childrenFlat = _boneChildrenFlat;

    // ── 1. Build a lookup from Bone reference to index. ──────────────────
    const boneIndexMap = new Map();

    for ( let i = 0; i < boneCount; i ++ ) {
        boneIndexMap.set( bones[ i ], i );
    }

    // ── 2. For each bone, cache its segment endpoints and radius. ────────
    for ( let i = 0; i < boneCount; i ++ ) {
        const bone = bones[ i ];

        bone.updateMatrixWorld( true );

        const mw = bone.matrixWorld.elements;
        segA[ i * 3 + 0 ] = mw[ 12 ];
        segA[ i * 3 + 1 ] = mw[ 13 ];
        segA[ i * 3 + 2 ] = mw[ 14 ];

        const children = bone.children;

        if ( children.length > 0 ) {
            const child = children[ 0 ];
            child.updateMatrixWorld( true );
            const cmw = child.matrixWorld.elements;
            segB[ i * 3 + 0 ] = cmw[ 12 ];
            segB[ i * 3 + 1 ] = cmw[ 13 ];
            segB[ i * 3 + 2 ] = cmw[ 14 ];
        } else {
            // Leaf bone: extend a short stub in the bone's own direction.
            const dx = mw[ 8 ];
            const dy = mw[ 9 ];
            const dz = mw[ 10 ];

            const stubLength = 0.05;

            segB[ i * 3 + 0 ] = mw[ 12 ] + dx * stubLength;
            segB[ i * 3 + 1 ] = mw[ 13 ] + dy * stubLength;
            segB[ i * 3 + 2 ] = mw[ 14 ] + dz * stubLength;
        }

        const dx = segB[ i * 3 + 0 ] - segA[ i * 3 + 0 ];
        const dy = segB[ i * 3 + 1 ] - segA[ i * 3 + 1 ];
        const dz = segB[ i * 3 + 2 ] - segA[ i * 3 + 2 ];

        const len = Math.hypot( dx, dy, dz );

        // Overlap radius derives from segment length * overlap factor.
        radii[ i ] = Math.max( 0.05, len * overlapRadiusScale );

        // Parent index.
        const parentBone = bone.parent;
        parentIdx[ i ] = ( parentBone !== null && parentBone !== undefined && boneIndexMap.has( parentBone ) )
            ? boneIndexMap.get( parentBone )
            : - 1;
    }

    // ── 3. Build the flat children array using a prefix-sum layout. ─────
    let totalChildren = 0;

    for ( let i = 0; i < boneCount; i ++ ) {
        childStart[ i ] = totalChildren;
        childCount[ i ] = 0;
    }

    for ( let i = 0; i < boneCount; i ++ ) {
        const parent = parentIdx[ i ];
        if ( parent >= 0 ) childCount[ parent ] ++;
    }

    for ( let i = 0; i < boneCount; i ++ ) {
        const count = childCount[ i ];
        childStart[ i ] = totalChildren;
        totalChildren += count;
    }

    childStart[ boneCount ] = totalChildren;

    // ── 4. Fill the flat children array. ─────────────────────────────────
    const cursor = new Int32Array( boneCount );
    for ( let i = 0; i < boneCount; i ++ ) cursor[ i ] = childStart[ i ];

    for ( let i = 0; i < boneCount; i ++ ) {
        const parent = parentIdx[ i ];
        if ( parent >= 0 ) {
            childrenFlat[ cursor[ parent ] ++ ] = i;
        }
    }
}

// ─── Internal: overlap buffer allocation. ───────────────────────────────────

function _ensureOverlapBuffers( vertexCount, bonesPerVertex ) {
    const needed = vertexCount * bonesPerVertex;

    if ( _overlapWeights === null || _overlapCapacity < needed ) {
        _overlapWeights = new Float32Array( Math.max( needed, _overlapCapacity * 2, 4096 ) );
        _overlapIndices = new Uint16Array( Math.max( needed, _overlapCapacity * 2, 4096 ) );
        _overlapCapacity = Math.max( needed, _overlapCapacity * 2, 4096 );
    }
}

// ─── Internal: load current assignment into the working set. ────────────────

function _loadCurrentAssignment( weights, indices, vertexCount, bonesPerVertex ) {
    const w = _overlapWeights;
    const i = _overlapIndices;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            w[ base + k ] = weights[ base + k ];
            i[ base + k ] = indices[ base + k ];
        }
    }
}

// ─── Internal: dead zone counter. ───────────────────────────────────────────

function _countDeadZones( vertexCount, bonesPerVertex, threshold, isBefore ) {
    const w = _overlapWeights;

    let count = 0;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;
        let sum = 0.0;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            sum += w[ base + k ];
        }

        if ( sum < threshold ) count ++;
    }

    if ( isBefore ) _overlapResult.deadZoneVerticesBefore = count;
    else _overlapResult.deadZoneVerticesAfter = count;
}

// ─── Internal: expand pass. ─────────────────────────────────────────────────

function _expandWithAdjacent(
    positions,
    vertexCount,
    bonesPerVertex,
    parentFactor,
    childFactor,
    siblingFactor,
    overlapRadiusScale,
    kernel,
    crossSiblingBlend,
    frameIndex
) {
    const w = _overlapWeights;
    const i = _overlapIndices;

    const segA = _boneSegA;
    const segB = _boneSegB;
    const radii = _boneRadius;
    const parentIdx = _boneParentIdx;
    const childStart = _boneChildStart;
    const childCount = _boneChildCount;
    const childrenFlat = _boneChildrenFlat;

    const boneCount = _overlapResult.boneCount;
    const baseSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;

    // Track which bone indices are already present in a vertex slot so we
    // do not double-inject the same bone into the same vertex.
    const presentMaskLo = new Uint32Array( boneCount >>> 5 || 1 );
    const presentMaskHi = new Uint32Array( boneCount >>> 5 || 1 );

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;

        // ── 1. Reset presence masks. ──────────────────────────────────────
        for ( let m = 0; m < presentMaskLo.length; m ++ ) {
            presentMaskLo[ m ] = 0;
            presentMaskHi[ m ] = 0;
        }

        // ── 2. Mark the currently assigned bones. ─────────────────────────
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const boneIdx = i[ base + k ];
            if ( w[ base + k ] > 0.0 ) {
                const word = boneIdx >>> 5;
                const bit = boneIdx & 31;
                if ( word < presentMaskLo.length ) {
                    presentMaskLo[ word ] |= ( 1 << bit );
                }
            }
        }

        // ── 3. Per-vertex world position for distance tests. ──────────────
        const px = positions[ v * 3 + 0 ];
        const py = positions[ v * 3 + 1 ];
        const pz = positions[ v * 3 + 2 ];

        // ── 4. For each currently assigned bone, inject its parent. ───────
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const boneIdx = i[ base + k ];
            const weight = w[ base + k ];

            if ( weight <= 0.0 ) continue;

            const parent = parentIdx[ boneIdx ];

            if ( parent >= 0 ) {
                const word = parent >>> 5;
                const bit = parent & 31;

                if ( word < presentMaskLo.length && ( presentMaskLo[ word ] & ( 1 << bit ) ) === 0 ) {
                    // ── 4a. Compute the smooth falloff factor. ────────────
                    const factor = _computeFalloffFactor(
                        px, py, pz,
                        parent,
                        segA, segB, radii,
                        kernel
                    );

                    const injected = weight * parentFactor * factor;

                    if ( injected > 1e-6 ) {
                        _injectWeight( base, bonesPerVertex, parent, injected );

                        presentMaskLo[ word ] |= ( 1 << bit );
                        _overlapResult.verticesExpandedWithParent ++;
                        _overlapResult.totalInjectedWeights ++;
                    }
                }
            }
        }

        // ── 5. For each currently assigned bone, inject its children. ─────
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const boneIdx = i[ base + k ];
            const weight = w[ base + k ];

            if ( weight <= 0.0 ) continue;

            const start = childStart[ boneIdx ];
            const count = childCount[ boneIdx ];

            for ( let c = 0; c < count; c ++ ) {
                const child = childrenFlat[ start + c ];

                const word = child >>> 5;
                const bit = child & 31;

                if ( word < presentMaskLo.length && ( presentMaskLo[ word ] & ( 1 << bit ) ) !== 0 ) continue;

                const factor = _computeFalloffFactor(
                    px, py, pz,
                    child,
                    segA, segB, radii,
                    kernel
                );

                const injected = weight * childFactor * factor;

                if ( injected > 1e-6 ) {
                    _injectWeight( base, bonesPerVertex, child, injected );

                    if ( word < presentMaskLo.length ) presentMaskLo[ word ] |= ( 1 << bit );
                    _overlapResult.verticesExpandedWithChild ++;
                    _overlapResult.totalInjectedWeights ++;
                }
            }
        }

        // ── 6. Cross-sibling blend at branch joints. ─────────────────────
        if ( crossSiblingBlend ) {
            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                const boneIdx = i[ base + k ];
                const weight = w[ base + k ];

                if ( weight <= 0.0 ) continue;

                const parent = parentIdx[ boneIdx ];
                if ( parent < 0 ) continue;

                const start = childStart[ parent ];
                const count = childCount[ parent ];

                if ( count < 2 ) continue;

                for ( let c = 0; c < count; c ++ ) {
                    const sibling = childrenFlat[ start + c ];

                    if ( sibling === boneIdx ) continue;

                    const word = sibling >>> 5;
                    const bit = sibling & 31;

                    if ( word < presentMaskLo.length && ( presentMaskLo[ word ] & ( 1 << bit ) ) !== 0 ) continue;

                    const factor = _computeFalloffFactor(
                        px, py, pz,
                        sibling,
                        segA, segB, radii,
                        kernel
                    );

                    const injected = weight * siblingFactor * factor;

                    if ( injected > 1e-6 ) {
                        _injectWeight( base, bonesPerVertex, sibling, injected );

                        if ( word < presentMaskLo.length ) presentMaskLo[ word ] |= ( 1 << bit );
                        _overlapResult.verticesExpandedWithSibling ++;
                        _overlapResult.totalInjectedWeights ++;
                    }
                }
            }
        }

        // ── 7. Renormalize the top-K. ─────────────────────────────────────
        _renormalizeTopK( base, bonesPerVertex, baseSeed, v );
    }
}

// ─── Internal: falloff kernel computation. ──────────────────────────────────

function _computeFalloffFactor( px, py, pz, boneIdx, segA, segB, radii, kernel ) {
    // ── 1. Closest point on the bone segment to the vertex. ──────────────
    const ax = segA[ boneIdx * 3 + 0 ];
    const ay = segA[ boneIdx * 3 + 1 ];
    const az = segA[ boneIdx * 3 + 2 ];

    const bx = segB[ boneIdx * 3 + 0 ];
    const by = segB[ boneIdx * 3 + 1 ];
    const bz = segB[ boneIdx * 3 + 2 ];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;

    const aqx = px - ax;
    const aqy = py - ay;
    const aqz = pz - az;

    const abLenSq = abx * abx + aby * aby + abz * abz;
    const invAbLenSq = abLenSq > 1e-12 ? 1.0 / abLenSq : 0.0;

    let t = ( aqx * abx + aqy * aby + aqz * abz ) * invAbLenSq;
    t = t < 0.0 ? 0.0 : ( t > 1.0 ? 1.0 : t );

    const projX = ax + abx * t;
    const projY = ay + aby * t;
    const projZ = az + abz * t;

    const ddx = px - projX;
    const ddy = py - projY;
    const ddz = pz - projZ;

    const dist = Math.sqrt( ddx * ddx + ddy * ddy + ddz * ddz );

    // ── 2. Normalize against the bone's overlap radius. ──────────────────
    const r = radii[ boneIdx ];
    let tNorm = r > 1e-9 ? dist / r : 1.0;

    if ( tNorm > 1.0 ) tNorm = 1.0;
    if ( tNorm < 0.0 ) tNorm = 0.0;

    // ── 3. Apply the falloff kernel. ─────────────────────────────────────
    let factor;

    if ( kernel === FalloffKernel.LINEAR ) {
        factor = 1.0 - tNorm;
    } else if ( kernel === FalloffKernel.CUBIC ) {
        const inv = 1.0 - tNorm;
        factor = inv * inv * inv;
    } else if ( kernel === FalloffKernel.QUINTIC ) {
        const inv = 1.0 - tNorm;
        factor = inv * inv * inv * ( inv * ( inv * 6.0 - 15.0 ) + 10.0 );
    } else {
        // Default: SMOOTHSTEP.
        factor = 1.0 - ( tNorm * tNorm * ( 3.0 - 2.0 * tNorm ) );
    }

    return factor;
}

// ─── Internal: weight injection with top-K replacement. ─────────────────────

function _injectWeight( base, bonesPerVertex, boneIdx, weight ) {
    const w = _overlapWeights;
    const i = _overlapIndices;

    // ── 1. Check if the bone is already present. ─────────────────────────
    for ( let k = 0; k < bonesPerVertex; k ++ ) {
        if ( i[ base + k ] === boneIdx && w[ base + k ] > 0.0 ) {
            w[ base + k ] += weight;
            return;
        }
    }

    // ── 2. Find the smallest-weight slot. ────────────────────────────────
    let minIdx = 0;
    let minWeight = w[ base + 0 ];

    for ( let k = 1; k < bonesPerVertex; k ++ ) {
        if ( w[ base + k ] < minWeight ) {
            minWeight = w[ base + k ];
            minIdx = k;
        }
    }

    // ── 3. Replace if the injection is meaningful. ───────────────────────
    if ( weight > minWeight ) {
        w[ base + minIdx ] = weight;
        i[ base + minIdx ] = boneIdx;
    }
}

// ─── Internal: top-K renormalization. ──────────────────────────────────────

function _renormalizeTopK( base, bonesPerVertex, seed, vertexIdx ) {
    const w = _overlapWeights;

    let sum = 0.0;

    for ( let k = 0; k < bonesPerVertex; k ++ ) {
        const val = w[ base + k ];
        if ( val > 0.0 ) sum += val;
    }

    // ── 1. Zero-sum fallback. ────────────────────────────────────────────
    if ( sum <= 1e-12 ) {
        // Deterministic dither to pick a slot — should rarely happen here
        // because the coverage pass runs afterward.
        const ditherSeed = ( seed ^ ( vertexIdx * 0x85EBCA6B ) ) >>> 0;
        const dither = _noise3D( ditherSeed * 1e-6, vertexIdx * 0.02, 0 );

        const chosen = dither >= 0.0 ? 0 : 1;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            w[ base + k ] = k === chosen ? 1.0 : 0.0;
        }
        return;
    }

    // ── 2. Normalize. ────────────────────────────────────────────────────
    const invSum = 1.0 / sum;

    for ( let k = 0; k < bonesPerVertex; k ++ ) {
        w[ base + k ] *= invSum;
    }
}

// ─── Internal: coverage pass. ───────────────────────────────────────────────

function _guaranteeCoverage(
    positions,
    bones,
    vertexCount,
    bonesPerVertex,
    fallbackFactor,
    threshold,
    kernel
) {
    const w = _overlapWeights;
    const i = _overlapIndices;

    const segA = _boneSegA;
    const segB = _boneSegB;
    const radii = _boneRadius;
    const parentIdx = _boneParentIdx;

    const boneCount = _overlapResult.boneCount;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;

        // ── 1. Sum the current weights. ──────────────────────────────────
        let sum = 0.0;
        for ( let k = 0; k < bonesPerVertex; k ++ ) sum += w[ base + k ];

        if ( sum >= threshold ) continue;

        // ── 2. Find the nearest bone to this vertex. ─────────────────────
        const px = positions[ v * 3 + 0 ];
        const py = positions[ v * 3 + 1 ];
        const pz = positions[ v * 3 + 2 ];

        let nearestBone = 0;
        let nearestDistSq = Number.MAX_VALUE;

        for ( let b = 0; b < boneCount; b ++ ) {
            const ax = segA[ b * 3 + 0 ];
            const ay = segA[ b * 3 + 1 ];
            const az = segA[ b * 3 + 2 ];

            const bx = segB[ b * 3 + 0 ];
            const by = segB[ b * 3 + 1 ];
            const bz = segB[ b * 3 + 2 ];

            const abx = bx - ax;
            const aby = by - ay;
            const abz = bz - az;

            const aqx = px - ax;
            const aqy = py - ay;
            const aqz = pz - az;

            const abLenSq = abx * abx + aby * aby + abz * abz;
            const invAbLenSq = abLenSq > 1e-12 ? 1.0 / abLenSq : 0.0;

            let t = ( aqx * abx + aqy * aby + aqz * abz ) * invAbLenSq;
            t = t < 0.0 ? 0.0 : ( t > 1.0 ? 1.0 : t );

            const projX = ax + abx * t;
            const projY = ay + aby * t;
            const projZ = az + abz * t;

            const ddx = px - projX;
            const ddy = py - projY;
            const ddz = pz - projZ;

            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;

            if ( distSq < nearestDistSq ) {
                nearestDistSq = distSq;
                nearestBone = b;
            }
        }

        // ── 3. Inject the nearest bone with full weight. ─────────────────
        w[ base + 0 ] = fallbackFactor;
        i[ base + 0 ] = nearestBone;

        for ( let k = 1; k < bonesPerVertex; k ++ ) {
            w[ base + k ] = 0.0;
            i[ base + k ] = 0;
        }

        // ── 4. Optionally inject the parent for a soft joint. ────────────
        const parent = parentIdx[ nearestBone ];

        if ( parent >= 0 && bonesPerVertex >= 2 ) {
            const factor = _computeFalloffFactor(
                px, py, pz,
                parent,
                segA, segB, radii,
                kernel
            );

            const injected = fallbackFactor * 0.5 * factor;

            if ( injected > 1e-6 ) {
                w[ base + 1 ] = injected;
                i[ base + 1 ] = parent;

                // Renormalize the pair.
                const pairSum = w[ base + 0 ] + w[ base + 1 ];
                const invPairSum = 1.0 / pairSum;

                w[ base + 0 ] *= invPairSum;
                w[ base + 1 ] *= invPairSum;
            }
        }

        _overlapResult.verticesCoverageFallback ++;
    }

    void bones;
}

// ─── Internal: write back the geometry attributes. ─────────────────────────

function _writeOverlapResult( geometry, vertexCount, bonesPerVertex, layout ) {
    const w = _overlapWeights;
    const i = _overlapIndices;

    // ── 1. INTERLEAVED / VARIABLE: write skinWeight + skinIndex. ─────────
    if ( layout === SkinWeightLayout.INTERLEAVED ) {
        const flatW = new Float32Array( vertexCount * bonesPerVertex );
        const flatI = new Uint16Array( vertexCount * bonesPerVertex );

        for ( let idx = 0; idx < vertexCount * bonesPerVertex; idx ++ ) {
            flatW[ idx ] = w[ idx ];
            flatI[ idx ] = i[ idx ];
        }

        geometry.setAttribute( ATTR_SKIN_WEIGHT, new Float32BufferAttribute( flatW, bonesPerVertex ) );
        geometry.setAttribute( ATTR_SKIN_INDEX, new Uint16BufferAttribute( flatI, bonesPerVertex ) );
        return;
    }

    // ── 2. PACKED: 4 indices + 4 weights into one Uint32. ────────────────
    if ( layout === SkinWeightLayout.PACKED ) {
        const arr = new Uint32Array( vertexCount );

        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;
            let packed = 0;

            for ( let k = 0; k < 4 && k < bonesPerVertex; k ++ ) {
                const idx = Math.max( 0, Math.min( 255, i[ base + k ] | 0 ) );
                const weight = Math.max( 0, Math.min( 255, Math.round( w[ base + k ] * 255 ) ) );

                packed |= ( idx & 0xFF ) << ( k * 8 );
                packed |= ( weight & 0xFF ) << ( ( k + 4 ) * 8 );
            }

            arr[ v ] = packed >>> 0;
        }

        geometry.setAttribute( 'skinWeightPacked', new Uint32BufferAttribute( arr, 1 ) );
        return;
    }

    // ── 3. PLANAR: one Float32 attribute per bone slot. ──────────────────
    if ( layout === SkinWeightLayout.PLANAR ) {
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const arr = new Float32Array( vertexCount );

            for ( let v = 0; v < vertexCount; v ++ ) {
                arr[ v ] = w[ v * bonesPerVertex + k ];
            }

            geometry.setAttribute( 'skinWeight' + k, new Float32BufferAttribute( arr, 1 ) );
        }

        const flatI = new Uint16Array( vertexCount * bonesPerVertex );
        for ( let idx = 0; idx < vertexCount * bonesPerVertex; idx ++ ) {
            flatI[ idx ] = i[ idx ];
        }
        geometry.setAttribute( ATTR_SKIN_INDEX, new Uint16BufferAttribute( flatI, bonesPerVertex ) );
        return;
    }

    // ── 4. VARIABLE: per-vertex stride. ──────────────────────────────────
    if ( layout === SkinWeightLayout.VARIABLE ) {
        const strides = new Uint8Array( vertexCount );

        let totalEntries = 0;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;
            let count = 0;

            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                if ( w[ base + k ] > 1e-6 ) count ++;
            }

            strides[ v ] = Math.max( 1, count );
            totalEntries += strides[ v ];
        }

        const flatW = new Float32Array( totalEntries );
        const flatI = new Uint16Array( totalEntries );

        let cursor = 0;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;
            const count = strides[ v ];

            for ( let k = 0; k < count; k ++ ) {
                flatW[ cursor ] = w[ base + k ];
                flatI[ cursor ] = i[ base + k ];
                cursor ++;
            }
        }

        geometry.setAttribute( ATTR_SKIN_WEIGHT, new Float32BufferAttribute( flatW, 1 ) );
        geometry.setAttribute( ATTR_SKIN_INDEX, new Uint16BufferAttribute( flatI, 1 ) );
        geometry.setAttribute( 'skinVariableStride', new Uint8BufferAttribute( strides, 1 ) );
        return;
    }
}

// ─── Public API: ECS sync. ──────────────────────────────────────────────────

const _ecsOverlapByHash = new Map();

function _syncOverlapECS(
    geometry,
    geometryHash,
    skeletonId,
    bonesPerVertex,
    parentFactor,
    childFactor,
    siblingFactor,
    coverageFallbackFactor,
    overlapRadiusScale,
    falloffKernel,
    frameIndex
) {
    let eid = _ecsOverlapByHash.get( geometryHash );

    if ( eid === undefined ) {
        eid = addEntity( _overlapWorld );
        addComponent( _overlapWorld, SkinWeightAdjacentOverlapSoA, eid );
        _ecsOverlapByHash.set( geometryHash, eid );
    }

    SkinWeightAdjacentOverlapSoA.geometryId[ eid ] = geometry.id !== undefined ? geometry.id : - 1;
    SkinWeightAdjacentOverlapSoA.geometryUuidHash[ eid ] = geometryHash;
    SkinWeightAdjacentOverlapSoA.skeletonId[ eid ] = skeletonId;
    SkinWeightAdjacentOverlapSoA.vertexCount[ eid ] = _overlapResult.vertexCount;
    SkinWeightAdjacentOverlapSoA.boneCount[ eid ] = _overlapResult.boneCount;
    SkinWeightAdjacentOverlapSoA.bonesPerVertex[ eid ] = bonesPerVertex;

    SkinWeightAdjacentOverlapSoA.parentOverlapFactor[ eid ] = parentFactor;
    SkinWeightAdjacentOverlapSoA.childOverlapFactor[ eid ] = childFactor;
    SkinWeightAdjacentOverlapSoA.siblingOverlapFactor[ eid ] = siblingFactor;
    SkinWeightAdjacentOverlapSoA.coverageFallbackFactor[ eid ] = coverageFallbackFactor;
    SkinWeightAdjacentOverlapSoA.overlapRadiusScale[ eid ] = overlapRadiusScale;
    SkinWeightAdjacentOverlapSoA.falloffKernel[ eid ] = falloffKernel;

    SkinWeightAdjacentOverlapSoA.verticesExpandedWithParent[ eid ] = _overlapResult.verticesExpandedWithParent;
    SkinWeightAdjacentOverlapSoA.verticesExpandedWithChild[ eid ] = _overlapResult.verticesExpandedWithChild;
    SkinWeightAdjacentOverlapSoA.verticesExpandedWithSibling[ eid ] = _overlapResult.verticesExpandedWithSibling;
    SkinWeightAdjacentOverlapSoA.verticesCoverageFallback[ eid ] = _overlapResult.verticesCoverageFallback;
    SkinWeightAdjacentOverlapSoA.totalInjectedWeights[ eid ] = _overlapResult.totalInjectedWeights;
    SkinWeightAdjacentOverlapSoA.avgOverlapCount[ eid ] = _overlapResult.avgOverlapCount;
    SkinWeightAdjacentOverlapSoA.maxOverlapCount[ eid ] = _overlapResult.maxOverlapCount;

    SkinWeightAdjacentOverlapSoA.deadZoneVerticesBefore[ eid ] = _overlapResult.deadZoneVerticesBefore;
    SkinWeightAdjacentOverlapSoA.deadZoneVerticesAfter[ eid ] = _overlapResult.deadZoneVerticesAfter;
    SkinWeightAdjacentOverlapSoA.coverageGuaranteed[ eid ] = _overlapResult.deadZoneVerticesAfter === 0 ? 1 : 0;

    SkinWeightAdjacentOverlapSoA.lastPassMs[ eid ] = _overlapResult.lastPassMs;
    SkinWeightAdjacentOverlapSoA.avgPassMsEMA[ eid ] =
        SkinWeightAdjacentOverlapSoA.avgPassMsEMA[ eid ] * 0.9 + _overlapResult.lastPassMs * 0.1;
    SkinWeightAdjacentOverlapSoA.lastExpandPassMs[ eid ] = _overlapResult.lastExpandPassMs;
    SkinWeightAdjacentOverlapSoA.lastCoveragePassMs[ eid ] = _overlapResult.lastCoveragePassMs;
    SkinWeightAdjacentOverlapSoA.lastWritePassMs[ eid ] = _overlapResult.lastWritePassMs;

    const ditherSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    SkinWeightAdjacentOverlapSoA.ditherSample[ eid ] = _noise3D( ditherSeed * 1e-6, frameIndex * 0.02, falloffKernel );
    SkinWeightAdjacentOverlapSoA.determinismSeed[ eid ] = SkinnedMeshDefaults.determinismSeed;

    SkinWeightAdjacentOverlapSoA.registered[ eid ] = 1;
    SkinWeightAdjacentOverlapSoA.applied[ eid ] = 1;
    SkinWeightAdjacentOverlapSoA.lastFrameIndex[ eid ] = frameIndex | 0;
}

// ─── Public API: query. ─────────────────────────────────────────────────────

/**
 * Returns the overlap entity id for the given geometry UUID.
 * @param {string} uuid
 * @return {number}
 */
function getOverlapEntityForUuid( uuid ) {
    const hash = _hashString( uuid );
    const eid = _ecsOverlapByHash.get( hash );
    return eid !== undefined ? eid : - 1;
}

/**
 * Returns the last overlap result record.
 * @return {object}
 */
function getLastOverlapResult() {
    return _overlapResult;
}

/**
 * Returns aggregated overlap statistics across all processed geometries.
 * @return {object}
 */
function getAggregatedStats() {
    let totalGeometries = 0;
    let totalVertices = 0;
    let totalExpandedParent = 0;
    let totalExpandedChild = 0;
    let totalExpandedSibling = 0;
    let totalCoverageFallback = 0;
    let totalInjected = 0;
    let totalPassMs = 0.0;
    let totalDeadBefore = 0;
    let totalDeadAfter = 0;

    const q = query( _overlapWorld, [ SkinWeightAdjacentOverlapSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinWeightAdjacentOverlapSoA.registered[ eid ] !== 1 ) continue;

        totalGeometries ++;
        totalVertices += SkinWeightAdjacentOverlapSoA.vertexCount[ eid ];
        totalExpandedParent += SkinWeightAdjacentOverlapSoA.verticesExpandedWithParent[ eid ];
        totalExpandedChild += SkinWeightAdjacentOverlapSoA.verticesExpandedWithChild[ eid ];
        totalExpandedSibling += SkinWeightAdjacentOverlapSoA.verticesExpandedWithSibling[ eid ];
        totalCoverageFallback += SkinWeightAdjacentOverlapSoA.verticesCoverageFallback[ eid ];
        totalInjected += SkinWeightAdjacentOverlapSoA.totalInjectedWeights[ eid ];
        totalPassMs += SkinWeightAdjacentOverlapSoA.lastPassMs[ eid ];
        totalDeadBefore += SkinWeightAdjacentOverlapSoA.deadZoneVerticesBefore[ eid ];
        totalDeadAfter += SkinWeightAdjacentOverlapSoA.deadZoneVerticesAfter[ eid ];
    }

    const total = new Double( totalPassMs );
    const injected = new Double( totalInjected );

    return {
        totalGeometries: totalGeometries,
        totalVertices: totalVertices,
        totalExpandedParent: totalExpandedParent,
        totalExpandedChild: totalExpandedChild,
        totalExpandedSibling: totalExpandedSibling,
        totalCoverageFallback: totalCoverageFallback,
        totalInjectedWeights: injected.valueOf(),
        totalPassMs: total.valueOf(),
        deadZonesBefore: totalDeadBefore,
        deadZonesAfter: totalDeadAfter,
        coverageGuaranteed: totalDeadAfter === 0
    };
}

// ─── Public API: high-precision aggregate helpers. ──────────────────────────

/**
 * Returns a high-precision ratio of vertices that required coverage fallback.
 * @return {number}
 */
function computeFallbackRatioHighPrecision() {
    const total = new Double( Math.max( 1, _overlapResult.vertexCount ) );
    const fallback = new Double( _overlapResult.verticesCoverageFallback );

    return fallback.div( total ).valueOf();
}

/**
 * Returns a high-precision estimate of the overlap pass cost.
 * @return {number}
 */
function computeOverlapCostHighPrecision() {
    const verts = new Double( _overlapResult.vertexCount );
    const bones = new Double( Math.max( 1, _overlapResult.boneCount ) );
    const ms = new Double( _overlapResult.lastPassMs );

    return verts.mul( bones ).mul( ms ).valueOf();
}

/**
 * Returns a high-precision dead-zone reduction ratio.
 * @return {number}
 */
function computeDeadZoneReductionHighPrecision() {
    const before = new Double( Math.max( 0, _overlapResult.deadZoneVerticesBefore ) );
    const after = new Double( Math.max( 0, _overlapResult.deadZoneVerticesAfter ) );

    if ( before.valueOf() <= 0 ) return 1.0;

    return 1.0 - after.div( before ).valueOf();
}

// ─── gl-matrix packing for telemetry. ───────────────────────────────────────

/**
 * Packs overlap telemetry into a vec4.
 * Layout: (vertexCount, boneCount, avgOverlapCount, maxOverlapCount)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packOverlapVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
        v,
        _overlapResult.vertexCount,
        _overlapResult.boneCount,
        _overlapResult.avgOverlapCount,
        _overlapResult.maxOverlapCount
    );
    return v;
}

/**
 * Packs per-geometry overlap stats into a vec4.
 * @param {string} uuid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packGeometryOverlapVec4( uuid, out ) {
    const v = out || _scratchVec4B;
    const eid = getOverlapEntityForUuid( uuid );

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinWeightAdjacentOverlapSoA.verticesExpandedWithParent[ eid ],
        SkinWeightAdjacentOverlapSoA.verticesExpandedWithChild[ eid ],
        SkinWeightAdjacentOverlapSoA.verticesExpandedWithSibling[ eid ],
        SkinWeightAdjacentOverlapSoA.verticesCoverageFallback[ eid ]
    );
    return v;
}

/**
 * Packs the timing breakdown into a vec4.
 * Layout: (expandPassMs, coveragePassMs, writePassMs, lastPassMs)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packOverlapTimingVec4( out ) {
    const v = out || _scratchVec4C;
    glMatrix.vec4.set(
        v,
        _overlapResult.lastExpandPassMs,
        _overlapResult.lastCoveragePassMs,
        _overlapResult.lastWritePassMs,
        _overlapResult.lastPassMs
    );
    return v;
}

/**
 * Packs dead-zone reduction into a vec4.
 * Layout: (deadBefore, deadAfter, fallbackCount, coverageGuaranteed)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packDeadZoneVec4( out ) {
    const v = out || _scratchVec4D;
    glMatrix.vec4.set(
        v,
        _overlapResult.deadZoneVerticesBefore,
        _overlapResult.deadZoneVerticesAfter,
        _overlapResult.verticesCoverageFallback,
        _overlapResult.deadZoneVerticesAfter === 0 ? 1 : 0
    );
    return v;
}

// ─── Deterministic dither sampling. ─────────────────────────────────────────

/**
 * Returns a deterministic dither sample for the given vertex / frame.
 * @param {number} geometryHash
 * @param {number} vertexIndex
 * @param {number} frameIndex
 * @return {number}
 */
function sampleOverlapDither( geometryHash, vertexIndex, frameIndex ) {
    const seed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( vertexIndex * 0x85EBCA6B ) ^ ( frameIndex * 0xC2B2AE35 ) ) >>> 0;
    return _noise3D( seed * 1e-6, vertexIndex * 0.02, frameIndex * 0.01 );
}

// ─── Public API: frame lifecycle. ───────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all overlap entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _overlapWorld, [ SkinWeightAdjacentOverlapSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        SkinWeightAdjacentOverlapSoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
    }
}

// ─── Utilities. ─────────────────────────────────────────────────────────────

function _hashString( s ) {
    let h = 0x811c9dc5;
    for ( let i = 0; i < s.length; i ++ ) {
        h ^= s.charCodeAt( i );
        h = Math.imul( h, 0x01000193 );
    }
    return h >>> 0;
}

function _nowMs() {
    if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
        return performance.now();
    }
    return Date.now();
}

void BufferGeometry;
void Matrix4;
void Vector3;
void BonesPerVertex;
void SkinnedMeshCaps;
void SkinWeightLayoutSoA;
void getLastAssignResult;
void _scratchVec3A;
void _scratchVec3B;
void _scratchVec3C;
void _scratchMat4;

export {
    FalloffKernel,
    AdjacentOverlapDefaults,
    SkinWeightAdjacentOverlapSoA,
    applyAdjacentOverlap,
    getOverlapEntityForUuid,
    getLastOverlapResult,
    getAggregatedStats,
    computeFallbackRatioHighPrecision,
    computeOverlapCostHighPrecision,
    computeDeadZoneReductionHighPrecision,
    packOverlapVec4,
    packGeometryOverlapVec4,
    packOverlapTimingVec4,
    packDeadZoneVec4,
    sampleOverlapDither,
    beginFrame
};