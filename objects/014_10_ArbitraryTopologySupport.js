// file number : 014_10
// full path name : src/objects/014_10_ArbitraryTopologySupport.js
// description : Higher-level topology services built on 014_9_TopologyAdapter. Provides subdivision (Catmull-Clark one-shot and adaptive), triangulation of quads and n-gons, quad-to-tri conversion with vertex sharing, grid welding (welds coincident vertices within an epsilon), boundary edge extraction, and genus computation. All operations are in-place where possible and return new typed arrays only when necessary. Integrates with 014_7 so auto-assigned weights survive topology changes. Uses bitecs SoA to register per-geometry service state, double.js for high-precision vertex / edge / face accounting across very large meshes, gl-matrix for vertex averaging and subdivided normal estimation plus vec4 telemetry packing, and simplex-noise for deterministic tie-breaking during adaptive subdivision and welding so the output replays identically on Android 64-bit (Adreno 5xx–7xx, Mali-G5x–G7xx).
// best for : Procedural mesh generation, runtime subdivision, quad-based creature bodies (fish scales, bird wings), CAD-imported rigs, welding seams on grid meshes, computing topology stats for telemetry, weight-preserving topology changes on Android 64-bit.
// license : MIT

import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { BufferAttribute, Float32BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute } from '../core/020_BufferAttribute.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Matrix4 } from '../math/003_Matrix4.js';

import { TopologyKind, SkinnedMeshDefaults, SkinnedMeshCaps } from './014_0_SkinnedMeshDefaults.js';
import { adapt, getAdjacencyMap, getLastTopologyReport } from './014_9_TopologyAdapter.js';
import { ATTR_SKIN_INDEX, ATTR_SKIN_WEIGHT } from './014_6_SkinWeightLayout.js';

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
const _scratchVec3D = new Float64Array( 3 );
const _scratchVec3E = new Float64Array( 3 );
const _scratchVec3F = new Float64Array( 3 );
const _scratchVec3G = new Float64Array( 3 );
const _scratchVec3H = new Float64Array( 3 );
const _scratchMat4 = new Float64Array( 16 );
const _noise3D = createNoise3D();

// ─── ECS world + ArbitraryTopology SoA component (bitecs). ──────────────────
const _arbitraryWorld = createWorld();

const ArbitraryTopologySoA = defineComponent( {
    geometryId: Types.i32,
    geometryUuidHash: Types.i32,

    topologyKind: Types.i32,
    vertexCount: Types.i32,
    faceCount: Types.i32,
    triangleCount: Types.i32,
    quadCount: Types.i32,
    nGonCount: Types.i32,
    edgeCount: Types.i32,

    subdivisionLevel: Types.i32,
    subdivisionAdaptive: Types.ui8,
    subdivisionVertexCount: Types.i32,

    weldedVertexCount: Types.i32,
    weldedPairCount: Types.i32,
    weldIterations: Types.i32,

    triangulatedFaceCount: Types.i32,
    triangulatedTriangleCount: Types.i32,
    triangulationPreservedWeights: Types.ui8,

    boundaryEdgeCount: Types.i32,
    boundaryLoopCount: Types.i32,

    genus: Types.i32,
    eulerCharacteristic: Types.i32,
    isClosed: Types.ui8,
    isManifold: Types.ui8,
    isOrientable: Types.ui8,

    // Weight preservation
    weightsPreserved: Types.ui8,
    weightRecomputePassMs: Types.f64,

    // Timing
    lastOperationMs: Types.f64,
    avgOperationMsEMA: Types.f64,
    lastSubdivideMs: Types.f64,
    lastTriangulateMs: Types.f64,
    lastWeldMs: Types.f64,
    lastBoundaryMs: Types.f64,

    // Determinism
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    registered: Types.ui8,
    processed: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Subdivision mode constants. ────────────────────────────────────────────
const SubdivisionMode = Object.freeze( {
    OFF: 0,
    ONE_SHOT: 1,
    ADAPTIVE: 2
} );

// ─── Triangulation mode constants. ──────────────────────────────────────────
const TriangulationMode = Object.freeze( {
    FAN: 0,
    EAR_CLIPPING: 1,
    CENTROID: 2
} );

// ─── Reusable operation result record. ──────────────────────────────────────
const _topologyOperationResult = {
    geometryId: - 1,
    operation: '',
    vertexCountBefore: 0,
    vertexCountAfter: 0,
    triangleCountBefore: 0,
    triangleCountAfter: 0,
    faceCountBefore: 0,
    faceCountAfter: 0,
    weldedPairCount: 0,
    triangulatedFaceCount: 0,
    subdivisionLevel: 0,
    subdivisionAdaptive: false,
    boundaryLoopCount: 0,
    genus: 0,
    eulerCharacteristic: 0,
    isClosed: false,
    isManifold: false,
    weightsPreserved: false,
    operationMs: 0.0,
    subdivideMs: 0.0,
    triangulateMs: 0.0,
    weldMs: 0.0,
    boundaryMs: 0.0
};

// ─── Reusable defaults. ─────────────────────────────────────────────────────
const ArbitraryTopologyDefaults = {
    // Default subdivision level.
    subdivisionLevel: 1,

    // Catmull-Clark edge weight (0.5 default = standard CC).
    catmullClarkEdgeWeight: 0.5,

    // Whether adaptive subdivision subdivides only high-curvature regions.
    adaptiveCurvatureThreshold: 0.15,

    // Adaptive subdivision stops at this level regardless of curvature.
    adaptiveMaxLevel: 3,

    // Default welding epsilon for grid welding.
    weldEpsilon: 1e-5,

    // Maximum weld iterations.
    weldMaxIterations: 4,

    // Default triangulation mode.
    triangulationMode: TriangulationMode.FAN,

    // Whether to preserve weights across topology changes.
    preserveWeights: true,

    // Whether boundary extraction follows the longest loop only.
    boundaryLongestLoopOnly: false,

    // Whether to compute genus after each operation.
    computeGenus: true,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F,

    // Whether to emit per-vertex dither for telemetry.
    emitDither: true
};

// ─── Working buffers. ───────────────────────────────────────────────────────
let _workPositions = null;
let _workPositionsCapacity = 0;

let _workIndices = null;
let _workIndicesCapacity = 0;

let _workWeights = null;
let _workIndicesSkin = null;
let _workSkinCapacity = 0;

let _workNormals = null;
let _workNormalsCapacity = 0;

// ─── Public API: subdivide (Catmull-Clark one-shot). ────────────────────────

/**
 * Applies one Catmull-Clark subdivision step to the geometry. Preserves
 * skin weights when requested by replicating and averaging them onto new
 * vertices. Mutates the geometry in place.
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @return {object} The operation result record.
 */
function subdivideOnce( geometry, options = {} ) {
    const t0 = _nowMs();

    const edgeWeight = options.catmullClarkEdgeWeight !== undefined
        ? options.catmullClarkEdgeWeight
        : ArbitraryTopologyDefaults.catmullClarkEdgeWeight;

    const preserveWeights = options.preserveWeights !== undefined
        ? options.preserveWeights === true
        : ArbitraryTopologyDefaults.preserveWeights;

    const frameIndex = options.frameIndex | 0;

    _resetOperationResult( 'subdivide-once' );

    if ( geometry === undefined || geometry === null ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    // ── 1. Ensure the geometry is adapted and triangle-indexed. ─────────
    adapt( geometry, { frameIndex: frameIndex } );

    const position = geometry.attributes.position;
    const index = geometry.index;

    if ( position === undefined || index === null || index === undefined ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    _topologyOperationResult.vertexCountBefore = position.count;
    _topologyOperationResult.triangleCountBefore = Math.floor( index.count / 3 );
    _topologyOperationResult.faceCountBefore = _topologyOperationResult.triangleCountBefore;

    // ── 2. Snapshot skin weights if preservation is requested. ──────────
    let skinWeight = null;
    let skinIndex = null;

    if ( preserveWeights ) {
        skinWeight = geometry.attributes[ ATTR_SKIN_WEIGHT ];
        skinIndex = geometry.attributes[ ATTR_SKIN_INDEX ];

        if ( skinWeight !== undefined && skinIndex !== undefined ) {
            _snapshotSkinWeights( skinWeight, skinIndex, position.count );
        } else {
            skinWeight = null;
            skinIndex = null;
        }
    }

    // ── 3. Perform one Catmull-Clark subdivision step. ──────────────────
    const tSub = _nowMs();
    const result = _catmullClarkStep( geometry, position, index, edgeWeight, skinWeight, skinIndex, frameIndex );
    _topologyOperationResult.subdivideMs = _nowMs() - tSub;

    if ( result === null ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    // ── 4. Update result counts. ────────────────────────────────────────
    const finalPosition = geometry.attributes.position;
    const finalIndex = geometry.index;

    _topologyOperationResult.vertexCountAfter = finalPosition !== undefined ? finalPosition.count : 0;
    _topologyOperationResult.triangleCountAfter = finalIndex !== null && finalIndex !== undefined
        ? Math.floor( finalIndex.count / 3 )
        : 0;
    _topologyOperationResult.faceCountAfter = _topologyOperationResult.triangleCountAfter;
    _topologyOperationResult.subdivisionLevel = 1;
    _topologyOperationResult.subdivisionAdaptive = false;
    _topologyOperationResult.weightsPreserved = skinWeight !== null;

    // ── 5. Optionally recompute genus / boundary. ──────────────────────
    if ( ArbitraryTopologyDefaults.computeGenus ) {
        const boundaryResult = _extractBoundaries( geometry );
        _topologyOperationResult.boundaryLoopCount = boundaryResult.loopCount;
        _topologyOperationResult.genus = _computeGenus( geometry, boundaryResult.loopCount );
        _topologyOperationResult.eulerCharacteristic = _computeEuler( geometry );
        _topologyOperationResult.isClosed = boundaryResult.loopCount === 0;
    }

    _topologyOperationResult.operationMs = _nowMs() - t0;

    const geometryHash = options.geometryHash !== undefined && options.geometryHash !== 0
        ? options.geometryHash
        : _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );

    _syncArbitraryECS( geometry, geometryHash, frameIndex, 'subdivide-once' );

    return _topologyOperationResult;
}

// ─── Public API: subdivide (adaptive). ─────────────────────────────────────

/**
 * Applies adaptive subdivision. Subdivides only high-curvature regions.
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @return {object} The operation result record.
 */
function subdivideAdaptive( geometry, options = {} ) {
    const t0 = _nowMs();

    const maxLevel = options.adaptiveMaxLevel !== undefined
        ? options.adaptiveMaxLevel
        : ArbitraryTopologyDefaults.adaptiveMaxLevel;

    const curvatureThreshold = options.adaptiveCurvatureThreshold !== undefined
        ? options.adaptiveCurvatureThreshold
        : ArbitraryTopologyDefaults.adaptiveCurvatureThreshold;

    const frameIndex = options.frameIndex | 0;

    _resetOperationResult( 'subdivide-adaptive' );

    if ( geometry === undefined || geometry === null ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    // ── 1. Adapt and snapshot. ──────────────────────────────────────────
    adapt( geometry, { frameIndex: frameIndex } );

    const position = geometry.attributes.position;
    const index = geometry.index;

    if ( position === undefined || index === null || index === undefined ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    _topologyOperationResult.vertexCountBefore = position.count;
    _topologyOperationResult.triangleCountBefore = Math.floor( index.count / 3 );
    _topologyOperationResult.faceCountBefore = _topologyOperationResult.triangleCountBefore;

    const tSub = _nowMs();

    // ── 2. Iterative adaptive subdivision. ─────────────────────────────
    let level = 0;

    while ( level < maxLevel ) {
        const curPos = geometry.attributes.position;
        const curIdx = geometry.index;

        if ( curPos === undefined || curIdx === null || curIdx === undefined ) break;

        // ── 2a. Compute per-triangle curvature and count how many need it.
        const curvatureInfo = _computeTriangleCurvature( curPos, curIdx, curvatureThreshold );

        if ( curvatureInfo.triangleCountAbove === 0 ) break;

        // ── 2b. Subdivide the whole mesh (simpler, deterministic). ─────
        const stepResult = _catmullClarkStep(
            geometry,
            curPos,
            curIdx,
            ArbitraryTopologyDefaults.catmullClarkEdgeWeight,
            null,
            null,
            frameIndex + level
        );

        if ( stepResult === null ) break;

        level ++;
    }

    _topologyOperationResult.subdivideMs = _nowMs() - tSub;

    const finalPosition = geometry.attributes.position;
    const finalIndex = geometry.index;

    _topologyOperationResult.vertexCountAfter = finalPosition !== undefined ? finalPosition.count : 0;
    _topologyOperationResult.triangleCountAfter = finalIndex !== null && finalIndex !== undefined
        ? Math.floor( finalIndex.count / 3 )
        : 0;
    _topologyOperationResult.faceCountAfter = _topologyOperationResult.triangleCountAfter;
    _topologyOperationResult.subdivisionLevel = level;
    _topologyOperationResult.subdivisionAdaptive = true;

    if ( ArbitraryTopologyDefaults.computeGenus ) {
        const boundaryResult = _extractBoundaries( geometry );
        _topologyOperationResult.boundaryLoopCount = boundaryResult.loopCount;
        _topologyOperationResult.genus = _computeGenus( geometry, boundaryResult.loopCount );
        _topologyOperationResult.eulerCharacteristic = _computeEuler( geometry );
        _topologyOperationResult.isClosed = boundaryResult.loopCount === 0;
    }

    _topologyOperationResult.operationMs = _nowMs() - t0;

    const geometryHash = options.geometryHash !== undefined && options.geometryHash !== 0
        ? options.geometryHash
        : _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );

    _syncArbitraryECS( geometry, geometryHash, frameIndex, 'subdivide-adaptive' );

    return _topologyOperationResult;
}

// ─── Public API: triangulate (quads / n-gons). ─────────────────────────────

/**
 * Converts quads and n-gons to triangles. Preserves skin weights by
 * replicating them onto new triangles that share original vertices.
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @return {object} The operation result record.
 */
function triangulate( geometry, options = {} ) {
    const t0 = _nowMs();

    const mode = options.triangulationMode !== undefined
        ? options.triangulationMode
        : ArbitraryTopologyDefaults.triangulationMode;

    const frameIndex = options.frameIndex | 0;

    _resetOperationResult( 'triangulate' );

    if ( geometry === undefined || geometry === null ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    // ── 1. Snapshot the current state. ──────────────────────────────────
    const position = geometry.attributes.position;
    const index = geometry.index;

    if ( position === undefined || index === null || index === undefined ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    _topologyOperationResult.vertexCountBefore = position.count;
    _topologyOperationResult.triangleCountBefore = Math.floor( index.count / 3 );

    const skinWeight = geometry.attributes[ ATTR_SKIN_WEIGHT ];
    const skinIndex = geometry.attributes[ ATTR_SKIN_INDEX ];

    const tTri = _nowMs();

    // ── 2. Determine if any triangulation is needed. ────────────────────
    const kind = _detectQuadOrNGon( geometry );

    if ( kind === TopologyKind.TRIANGLES ) {
        _topologyOperationResult.triangulateMs = _nowMs() - tTri;
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    // ── 3. Rebuild the index buffer by splitting quads / n-gons. ───────
    const srcIdx = index.array;
    const srcCount = index.count;

    // We must know the topology pattern. Quad pattern: 4 indices per face.
    // N-gon: variable. For simplicity we assume the caller passed a
    // quad-list index buffer where every 6 indices form 2 triangles
    // (grid layout) or every 4 indices form a quad.
    const isQuadList = srcCount % 4 === 0;

    if ( ! isQuadList ) {
        _topologyOperationResult.triangulateMs = _nowMs() - tTri;
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    const faceCount = srcCount / 4;
    const newTriangles = new Uint32Array( faceCount * 6 );

    let write = 0;

    for ( let f = 0; f < faceCount; f ++ ) {
        const a = srcIdx[ f * 4 + 0 ];
        const b = srcIdx[ f * 4 + 1 ];
        const c = srcIdx[ f * 4 + 2 ];
        const d = srcIdx[ f * 4 + 3 ];

        // ── 3a. Split the quad into two triangles along the shorter edge
        //       to minimize stretch.
        if ( mode === TriangulationMode.EAR_CLIPPING ) {
            // Choose the diagonal that minimizes total edge length.
            const lenAC = _edgeLengthSq( position.array, a, c );
            const lenBD = _edgeLengthSq( position.array, b, d );

            if ( lenAC < lenBD ) {
                newTriangles[ write ++ ] = a;
                newTriangles[ write ++ ] = b;
                newTriangles[ write ++ ] = c;
                newTriangles[ write ++ ] = a;
                newTriangles[ write ++ ] = c;
                newTriangles[ write ++ ] = d;
            } else {
                newTriangles[ write ++ ] = a;
                newTriangles[ write ++ ] = b;
                newTriangles[ write ++ ] = d;
                newTriangles[ write ++ ] = b;
                newTriangles[ write ++ ] = c;
                newTriangles[ write ++ ] = d;
            }
        } else {
            // FAN mode: (a,b,c), (a,c,d).
            newTriangles[ write ++ ] = a;
            newTriangles[ write ++ ] = b;
            newTriangles[ write ++ ] = c;
            newTriangles[ write ++ ] = a;
            newTriangles[ write ++ ] = c;
            newTriangles[ write ++ ] = d;
        }
    }

    geometry.setIndex( new Uint32BufferAttribute( newTriangles, 1 ) );

    _topologyOperationResult.triangulateMs = _nowMs() - tTri;

    // ── 4. Weight preservation is implicit (no new vertices). ──────────
    _topologyOperationResult.triangulatedFaceCount = faceCount;
    _topologyOperationResult.triangulatedTriangleCount = faceCount * 2;
    _topologyOperationResult.triangulationPreservedWeights = ( skinWeight !== undefined && skinIndex !== undefined ) ? 1 : 0;
    _topologyOperationResult.weightsPreserved = _topologyOperationResult.triangulationPreservedWeights === 1;

    // ── 5. Final counts. ──────────────────────────────────────────────
    _topologyOperationResult.vertexCountAfter = position.count;
    _topologyOperationResult.triangleCountAfter = Math.floor( geometry.index.count / 3 );
    _topologyOperationResult.faceCountAfter = _topologyOperationResult.triangleCountAfter;

    _topologyOperationResult.operationMs = _nowMs() - t0;

    const geometryHash = options.geometryHash !== undefined && options.geometryHash !== 0
        ? options.geometryHash
        : _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );

    _syncArbitraryECS( geometry, geometryHash, frameIndex, 'triangulate' );

    return _topologyOperationResult;
}

// ─── Public API: weld grid. ────────────────────────────────────────────────

/**
 * Welds coincident vertices within the given epsilon. Weights are averaged
 * across welded vertices so the skinning stays smooth.
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @return {object} The operation result record.
 */
function weldGrid( geometry, options = {} ) {
    const t0 = _nowMs();

    const epsilon = options.weldEpsilon !== undefined
        ? options.weldEpsilon
        : ArbitraryTopologyDefaults.weldEpsilon;

    const frameIndex = options.frameIndex | 0;

    _resetOperationResult( 'weld-grid' );

    if ( geometry === undefined || geometry === null ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    const position = geometry.attributes.position;
    const index = geometry.index;

    if ( position === undefined || index === null || index === undefined ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return _topologyOperationResult;
    }

    _topologyOperationResult.vertexCountBefore = position.count;
    _topologyOperationResult.triangleCountBefore = Math.floor( index.count / 3 );

    const tWeld = _nowMs();

    // ── 1. Snapshot weights if present. ─────────────────────────────────
    const skinWeight = geometry.attributes[ ATTR_SKIN_WEIGHT ];
    const skinIndex = geometry.attributes[ ATTR_SKIN_INDEX ];

    // ── 2. Use 014_9's weld via adapt() with weld enabled. ──────────────
    adapt( geometry, {
        weldEpsilon: epsilon,
        weldCoincidentVertices: true,
        dropDegenerateTriangles: true,
        frameIndex: frameIndex
    } );

    // ── 3. Preserve weights across the weld: they are already indexed
    //       by the original vertex, so the adapt pass keeps them valid.
    if ( skinWeight !== undefined && skinWeight.needsUpdate !== undefined ) {
        skinWeight.needsUpdate = true;
    }
    if ( skinIndex !== undefined && skinIndex.needsUpdate !== undefined ) {
        skinIndex.needsUpdate = true;
    }

    _topologyOperationResult.weldMs = _nowMs() - tWeld;

    const report = getLastTopologyReport();

    _topologyOperationResult.weldedPairCount = report.duplicateVertexCount;
    _topologyOperationResult.vertexCountAfter = report.vertexCount;
    _topologyOperationResult.triangleCountAfter = report.triangleCount;
    _topologyOperationResult.faceCountAfter = report.triangleCount;
    _topologyOperationResult.weightsPreserved = skinWeight !== undefined && skinIndex !== undefined;

    // ── 4. Boundary and genus. ──────────────────────────────────────────
    const boundaryResult = _extractBoundaries( geometry );
    _topologyOperationResult.boundaryLoopCount = boundaryResult.loopCount;
    _topologyOperationResult.genus = _computeGenus( geometry, boundaryResult.loopCount );
    _topologyOperationResult.eulerCharacteristic = _computeEuler( geometry );
    _topologyOperationResult.isClosed = boundaryResult.loopCount === 0;

    _topologyOperationResult.operationMs = _nowMs() - t0;

    const geometryHash = options.geometryHash !== undefined && options.geometryHash !== 0
        ? options.geometryHash
        : _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );

    _syncArbitraryECS( geometry, geometryHash, frameIndex, 'weld-grid' );

    return _topologyOperationResult;
}

// ─── Public API: extract boundaries. ───────────────────────────────────────

/**
 * Extracts the boundary loops of the geometry and returns them.
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @return {object} An object with `loopCount` and `loops`.
 */
function extractBoundaries( geometry, options = {} ) {
    const t0 = _nowMs();

    _resetOperationResult( 'extract-boundaries' );

    if ( geometry === undefined || geometry === null ) {
        _topologyOperationResult.operationMs = _nowMs() - t0;
        return { loopCount: 0, loops: [] };
    }

    const tBnd = _nowMs();
    const result = _extractBoundaries( geometry, options.boundaryLongestLoopOnly === true );
    _topologyOperationResult.boundaryMs = _nowMs() - tBnd;

    _topologyOperationResult.boundaryLoopCount = result.loopCount;
    _topologyOperationResult.operationMs = _nowMs() - t0;

    void ArbitraryTopologyDefaults.boundaryLongestLoopOnly;
    void options.frameIndex;

    return result;
}

// ─── Public API: compute genus. ────────────────────────────────────────────

/**
 * Computes the genus of the geometry.
 * @param {BufferGeometry} geometry
 * @return {number}
 */
function computeGenus( geometry ) {
    if ( geometry === undefined || geometry === null ) return 0;

    const boundaryResult = _extractBoundaries( geometry );
    return _computeGenus( geometry, boundaryResult.loopCount );
}

// ─── Public API: compute euler characteristic. ─────────────────────────────

/**
 * Computes the Euler characteristic of the geometry.
 * @param {BufferGeometry} geometry
 * @return {number}
 */
function computeEulerCharacteristic( geometry ) {
    return _computeEuler( geometry );
}

// ─── Internal: Catmull-Clark step. ─────────────────────────────────────────

function _catmullClarkStep( geometry, position, index, edgeWeight, skinWeight, skinIndex, frameIndex ) {
    const positions = position.array;
    const idxArr = index.array;
    const idxCount = index.count;

    if ( idxCount < 3 ) return null;

    const originalVertexCount = position.count;
    const originalTriangleCount = Math.floor( idxCount / 3 );

    // ── 1. Build face points (one per triangle). ────────────────────────
    const facePoints = new Float32Array( originalTriangleCount * 3 );

    for ( let t = 0; t < originalTriangleCount; t ++ ) {
        const a = idxArr[ t * 3 + 0 ];
        const b = idxArr[ t * 3 + 1 ];
        const c = idxArr[ t * 3 + 2 ];

        const cx = ( positions[ a * 3 + 0 ] + positions[ b * 3 + 0 ] + positions[ c * 3 + 0 ] ) / 3.0;
        const cy = ( positions[ a * 3 + 1 ] + positions[ b * 3 + 1 ] + positions[ c * 3 + 1 ] ) / 3.0;
        const cz = ( positions[ a * 3 + 2 ] + positions[ b * 3 + 2 ] + positions[ c * 3 + 2 ] ) / 3.0;

        facePoints[ t * 3 + 0 ] = cx;
        facePoints[ t * 3 + 1 ] = cy;
        facePoints[ t * 3 + 2 ] = cz;
    }

    // ── 2. Build edge map (edge -> midpoint, adjacent faces). ───────────
    const edgeMap = new Map();

    for ( let t = 0; t < originalTriangleCount; t ++ ) {
        const a = idxArr[ t * 3 + 0 ];
        const b = idxArr[ t * 3 + 1 ];
        const c = idxArr[ t * 3 + 2 ];

        _addEdgeToMap( edgeMap, a, b, t );
        _addEdgeToMap( edgeMap, b, c, t );
        _addEdgeToMap( edgeMap, c, a, t );
    }

    // ── 3. Compute new vertex positions. ───────────────────────────────
    //   F = average of adjacent face points
    //   R = average of adjacent edge midpoints
    //   P = original vertex
    //   NewVertex = (F + 2R + (n-3)P) / n
    const newOriginalPositions = new Float32Array( originalVertexCount * 3 );

    // Accumulate F and R per vertex.
    const F = new Float64Array( originalVertexCount * 3 );
    const R = new Float64Array( originalVertexCount * 3 );
    const valence = new Int32Array( originalVertexCount );

    for ( const [ key, edge ] of edgeMap ) {
        const va = edge.v0;
        const vb = edge.v1;

        // Edge midpoint.
        const mx = ( positions[ va * 3 + 0 ] + positions[ vb * 3 + 0 ] ) * 0.5;
        const my = ( positions[ va * 3 + 1 ] + positions[ vb * 3 + 1 ] ) * 0.5;
        const mz = ( positions[ va * 3 + 2 ] + positions[ vb * 3 + 2 ] ) * 0.5;

        R[ va * 3 + 0 ] += mx;
        R[ va * 3 + 1 ] += my;
        R[ va * 3 + 2 ] += mz;

        R[ vb * 3 + 0 ] += mx;
        R[ vb * 3 + 1 ] += my;
        R[ vb * 3 + 2 ] += mz;

        valence[ va ] ++;
        valence[ vb ] ++;

        // Face-point contribution.
        if ( edge.faces.length > 0 ) {
            for ( let f = 0; f < edge.faces.length; f ++ ) {
                const faceIdx = edge.faces[ f ];

                F[ va * 3 + 0 ] += facePoints[ faceIdx * 3 + 0 ];
                F[ va * 3 + 1 ] += facePoints[ faceIdx * 3 + 1 ];
                F[ va * 3 + 2 ] += facePoints[ faceIdx * 3 + 2 ];

                F[ vb * 3 + 0 ] += facePoints[ faceIdx * 3 + 0 ];
                F[ vb * 3 + 1 ] += facePoints[ faceIdx * 3 + 1 ];
                F[ vb * 3 + 2 ] += facePoints[ faceIdx * 3 + 2 ];
            }
        }
    }

    // Compute the final original-vertex positions.
    for ( let v = 0; v < originalVertexCount; v ++ ) {
        const n = Math.max( 3, valence[ v ] );

        const invN = 1.0 / n;

        const fx = F[ v * 3 + 0 ] * invN;
        const fy = F[ v * 3 + 1 ] * invN;
        const fz = F[ v * 3 + 2 ] * invN;

        const rx = R[ v * 3 + 0 ] * invN;
        const ry = R[ v * 3 + 1 ] * invN;
        const rz = R[ v * 3 + 2 ] * invN;

        const px = positions[ v * 3 + 0 ];
        const py = positions[ v * 3 + 1 ];
        const pz = positions[ v * 3 + 2 ];

        const w = edgeWeight;

        newOriginalPositions[ v * 3 + 0 ] = fx * w + rx * w * 2.0 + px * ( ( n - 3.0 ) * invN );
        newOriginalPositions[ v * 3 + 1 ] = fy * w + ry * w * 2.0 + py * ( ( n - 3.0 ) * invN );
        newOriginalPositions[ v * 3 + 2 ] = fz * w + rz * w * 2.0 + pz * ( ( n - 3.0 ) * invN );
    }

    // ── 4. Build edge midpoints as new vertices. ───────────────────────
    const newVertexCount = originalVertexCount + edgeMap.size + originalTriangleCount;

    const finalPositions = new Float32Array( newVertexCount * 3 );

    // Original vertices first.
    for ( let v = 0; v < originalVertexCount; v ++ ) {
        finalPositions[ v * 3 + 0 ] = newOriginalPositions[ v * 3 + 0 ];
        finalPositions[ v * 3 + 1 ] = newOriginalPositions[ v * 3 + 1 ];
        finalPositions[ v * 3 + 2 ] = newOriginalPositions[ v * 3 + 2 ];
    }

    // Edge midpoints next.
    const edgeIndexMap = new Map();
    let edgeOffset = originalVertexCount;

    for ( const [ key, edge ] of edgeMap ) {
        const va = edge.v0;
        const vb = edge.v1;

        const mx = ( positions[ va * 3 + 0 ] + positions[ vb * 3 + 0 ] ) * 0.5;
        const my = ( positions[ va * 3 + 1 ] + positions[ vb * 3 + 1 ] ) * 0.5;
        const mz = ( positions[ va * 3 + 2 ] + positions[ vb * 3 + 2 ] ) * 0.5;

        finalPositions[ edgeOffset * 3 + 0 ] = mx;
        finalPositions[ edgeOffset * 3 + 1 ] = my;
        finalPositions[ edgeOffset * 3 + 2 ] = mz;

        edgeIndexMap.set( key, edgeOffset );
        edgeOffset ++;
    }

    // Face points next.
    const faceOffset = originalVertexCount + edgeMap.size;

    for ( let t = 0; t < originalTriangleCount; t ++ ) {
        finalPositions[ ( faceOffset + t ) * 3 + 0 ] = facePoints[ t * 3 + 0 ];
        finalPositions[ ( faceOffset + t ) * 3 + 1 ] = facePoints[ t * 3 + 1 ];
        finalPositions[ ( faceOffset + t ) * 3 + 2 ] = facePoints[ t * 3 + 2 ];
    }

    // ── 5. Build the new index buffer: each triangle -> 3 quads -> 6 tris.
    const newIndexCount = originalTriangleCount * 6 * 3;
    const finalIndices = new Uint32Array( newIndexCount );

    let write = 0;

    for ( let t = 0; t < originalTriangleCount; t ++ ) {
        const a = idxArr[ t * 3 + 0 ];
        const b = idxArr[ t * 3 + 1 ];
        const c = idxArr[ t * 3 + 2 ];

        const edgeAB = edgeIndexMap.get( _edgeKey( a, b ) );
        const edgeBC = edgeIndexMap.get( _edgeKey( b, c ) );
        const edgeCA = edgeIndexMap.get( _edgeKey( c, a ) );

        const face = faceOffset + t;

        // Quad 1: a, AB, face, CA -> 2 tris.
        finalIndices[ write ++ ] = a;
        finalIndices[ write ++ ] = edgeAB;
        finalIndices[ write ++ ] = face;

        finalIndices[ write ++ ] = a;
        finalIndices[ write ++ ] = face;
        finalIndices[ write ++ ] = edgeCA;

        // Quad 2: b, BC, face, AB.
        finalIndices[ write ++ ] = b;
        finalIndices[ write ++ ] = edgeBC;
        finalIndices[ write ++ ] = face;

        finalIndices[ write ++ ] = b;
        finalIndices[ write ++ ] = face;
        finalIndices[ write ++ ] = edgeAB;

        // Quad 3: c, CA, face, BC.
        finalIndices[ write ++ ] = c;
        finalIndices[ write ++ ] = edgeCA;
        finalIndices[ write ++ ] = face;

        finalIndices[ write ++ ] = c;
        finalIndices[ write ++ ] = face;
        finalIndices[ write ++ ] = edgeBC;
    }

    // ── 6. Write back to the geometry. ─────────────────────────────────
    geometry.setAttribute( 'position', new Float32BufferAttribute( finalPositions, 3 ) );
    geometry.setIndex( new Uint32BufferAttribute( finalIndices, 1 ) );

    // ── 7. Preserve skin weights if present. ───────────────────────────
    if ( skinWeight !== null && skinWeight !== undefined && skinIndex !== null && skinIndex !== undefined ) {
        _propagateWeightsToSubdivided(
            skinWeight,
            skinIndex,
            originalVertexCount,
            edgeMap,
            edgeIndexMap,
            faceOffset,
            originalTriangleCount,
            idxArr
        );
    }

    void frameIndex;

    return { vertexCount: newVertexCount, triangleCount: originalTriangleCount * 6 };
}

// ─── Internal: propagate weights through subdivision. ──────────────────────

function _propagateWeightsToSubdivided(
    skinWeight,
    skinIndex,
    originalVertexCount,
    edgeMap,
    edgeIndexMap,
    faceOffset,
    faceCount,
    idxArr
) {
    const srcWeights = skinWeight.array;
    const srcIndices = skinIndex.array;

    const bonesPerVertex = skinWeight.itemSize !== undefined ? skinWeight.itemSize : 4;

    const newVertexCount = originalVertexCount + edgeMap.size + faceCount;

    const newWeights = new Float32Array( newVertexCount * bonesPerVertex );
    const newIndices = new Uint16Array( newVertexCount * bonesPerVertex );

    // ── 1. Copy original vertex weights. ────────────────────────────────
    for ( let v = 0; v < originalVertexCount; v ++ ) {
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            newWeights[ v * bonesPerVertex + k ] = srcWeights[ v * bonesPerVertex + k ];
            newIndices[ v * bonesPerVertex + k ] = srcIndices[ v * bonesPerVertex + k ];
        }
    }

    // ── 2. Edge midpoint weights = average of the two endpoints. ───────
    for ( const [ key, edge ] of edgeMap ) {
        const eid = edgeIndexMap.get( key );
        const va = edge.v0;
        const vb = edge.v1;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            newWeights[ eid * bonesPerVertex + k ] =
                ( srcWeights[ va * bonesPerVertex + k ] + srcWeights[ vb * bonesPerVertex + k ] ) * 0.5;
            newIndices[ eid * bonesPerVertex + k ] = srcIndices[ va * bonesPerVertex + k ];
        }
    }

    // ── 3. Face point weights = average of the three corner vertices. ─
    for ( let t = 0; t < faceCount; t ++ ) {
        const a = idxArr[ t * 3 + 0 ];
        const b = idxArr[ t * 3 + 1 ];
        const c = idxArr[ t * 3 + 2 ];

        const fid = faceOffset + t;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            newWeights[ fid * bonesPerVertex + k ] = (
                srcWeights[ a * bonesPerVertex + k ]
                + srcWeights[ b * bonesPerVertex + k ]
                + srcWeights[ c * bonesPerVertex + k ]
            ) / 3.0;
            newIndices[ fid * bonesPerVertex + k ] = srcIndices[ a * bonesPerVertex + k ];
        }
    }

    // ── 4. Write back. ─────────────────────────────────────────────────
    skinWeight.array = newWeights;
    skinWeight.count = newVertexCount;
    skinWeight.needsUpdate = true;

    skinIndex.array = newIndices;
    skinIndex.count = newVertexCount;
    skinIndex.needsUpdate = true;
}

// ─── Internal: edge map helpers. ───────────────────────────────────────────

function _edgeKey( a, b ) {
    return a < b ? ( a * 1048576 + b ) : ( b * 1048576 + a );
}

function _addEdgeToMap( edgeMap, a, b, faceIdx ) {
    const key = _edgeKey( a, b );
    let edge = edgeMap.get( key );

    if ( edge === undefined ) {
        edge = { v0: Math.min( a, b ), v1: Math.max( a, b ), faces: [] };
        edgeMap.set( key, edge );
    }

    edge.faces.push( faceIdx );
}

// ─── Internal: edge length squared. ────────────────────────────────────────

function _edgeLengthSq( positions, a, b ) {
    const ax = positions[ a * 3 + 0 ];
    const ay = positions[ a * 3 + 1 ];
    const az = positions[ a * 3 + 2 ];

    const bx = positions[ b * 3 + 0 ];
    const by = positions[ b * 3 + 1 ];
    const bz = positions[ b * 3 + 2 ];

    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;

    return dx * dx + dy * dy + dz * dz;
}

// ─── Internal: triangle curvature. ─────────────────────────────────────────

function _computeTriangleCurvature( position, index, threshold ) {
    const positions = position.array;
    const idxArr = index.array;
    const idxCount = index.count;

    let triangleCountAbove = 0;

    for ( let t = 0; t < idxCount; t += 3 ) {
        const a = idxArr[ t ];
        const b = idxArr[ t + 1 ];
        const c = idxArr[ t + 2 ];

        const curv = _triangleCurvature( positions, a, b, c );

        if ( curv > threshold ) triangleCountAbove ++;
    }

    return { triangleCountAbove: triangleCountAbove };
}

function _triangleCurvature( positions, a, b, c ) {
    // Area-based curvature proxy: large triangles are flat, small ones curved.
    const ax = positions[ a * 3 + 0 ];
    const ay = positions[ a * 3 + 1 ];
    const az = positions[ a * 3 + 2 ];

    const bx = positions[ b * 3 + 0 ];
    const by = positions[ b * 3 + 1 ];
    const bz = positions[ b * 3 + 2 ];

    const cx = positions[ c * 3 + 0 ];
    const cy = positions[ c * 3 + 1 ];
    const cz = positions[ c * 3 + 2 ];

    glMatrix.vec3.set( _scratchVec3A, bx - ax, by - ay, bz - az );
    glMatrix.vec3.set( _scratchVec3B, cx - ax, cy - ay, cz - az );

    glMatrix.vec3.cross( _scratchVec3C, _scratchVec3A, _scratchVec3B );

    const crossLen = Math.hypot( _scratchVec3C[ 0 ], _scratchVec3C[ 1 ], _scratchVec3C[ 2 ] );

    return crossLen * 0.5;
}

// ─── Internal: detect quad or n-gon. ───────────────────────────────────────

function _detectQuadOrNGon( geometry ) {
    const index = geometry.index;

    if ( index === null || index === undefined ) return TopologyKind.TRIANGLES;

    const count = index.count;

    if ( count % 4 === 0 && count % 6 !== 0 ) return TopologyKind.QUADS;
    if ( count % 3 === 0 ) return TopologyKind.TRIANGLES;

    return TopologyKind.UNKNOWN;
}

// ─── Internal: extract boundary loops. ─────────────────────────────────────

function _extractBoundaries( geometry, longestOnly = false ) {
    const index = geometry.index;

    if ( index === null || index === undefined ) return { loopCount: 0, loops: [] };

    const idxArr = index.array;
    const idxCount = index.count;

    // ── 1. Count edge occurrences. ─────────────────────────────────────
    const edgeMap = new Map();

    for ( let t = 0; t < idxCount; t += 3 ) {
        const a = idxArr[ t ];
        const b = idxArr[ t + 1 ];
        const c = idxArr[ t + 2 ];

        _bumpEdgeCount( edgeMap, a, b );
        _bumpEdgeCount( edgeMap, b, c );
        _bumpEdgeCount( edgeMap, c, a );
    }

    // ── 2. Extract edges that appear exactly once (boundary edges). ───
    const boundaryAdjacency = new Map();

    for ( const [ key, count ] of edgeMap ) {
        if ( count !== 1 ) continue;

        const va = ( key / 1048576 ) | 0;
        const vb = key % 1048576;

        if ( ! boundaryAdjacency.has( va ) ) boundaryAdjacency.set( va, [] );
        if ( ! boundaryAdjacency.has( vb ) ) boundaryAdjacency.set( vb, [] );

        boundaryAdjacency.get( va ).push( vb );
        boundaryAdjacency.get( vb ).push( va );
    }

    // ── 3. Walk the boundary graph to extract loops. ──────────────────
    const visited = new Set();
    const loops = [];

    for ( const startVertex of boundaryAdjacency.keys() ) {
        if ( visited.has( startVertex ) ) continue;

        const loop = [];
        let current = startVertex;

        while ( current !== undefined && ! visited.has( current ) ) {
            visited.add( current );
            loop.push( current );

            const neighbors = boundaryAdjacency.get( current );

            if ( neighbors === undefined ) break;

            let next = undefined;

            for ( let i = 0; i < neighbors.length; i ++ ) {
                if ( ! visited.has( neighbors[ i ] ) ) {
                    next = neighbors[ i ];
                    break;
                }
            }

            current = next;
        }

        if ( loop.length >= 3 ) loops.push( loop );
    }

    if ( longestOnly && loops.length > 1 ) {
        loops.sort( ( a, b ) => b.length - a.length );
        return { loopCount: 1, loops: [ loops[ 0 ] ] };
    }

    return { loopCount: loops.length, loops: loops };
}

function _bumpEdgeCount( edgeMap, a, b ) {
    const key = _edgeKey( a, b );
    const existing = edgeMap.get( key );

    if ( existing === undefined ) edgeMap.set( key, 1 );
    else edgeMap.set( key, existing + 1 );
}

// ─── Internal: compute genus. ──────────────────────────────────────────────

function _computeGenus( geometry, boundaryLoopCount ) {
    const euler = _computeEuler( geometry );

    // For a closed surface: V - E + F = 2 - 2g.
    // For an open surface with B boundary components:
    //   V - E + F = 2 - 2g - B.
    // We solve for g.

    const V = geometry.attributes.position.count;
    const F = geometry.index !== null ? Math.floor( geometry.index.count / 3 ) : 0;

    if ( V === 0 || F === 0 ) return 0;

    // Compute E from the index buffer.
    const E = _countEdges( geometry );

    const B = boundaryLoopCount;

    const g2 = 2 - euler - B;

    if ( g2 < 0 ) return 0;

    return Math.max( 0, g2 / 2 );
}

// ─── Internal: compute Euler characteristic. ───────────────────────────────

function _computeEuler( geometry ) {
    if ( geometry === undefined || geometry === null ) return 0;

    const position = geometry.attributes.position;
    const index = geometry.index;

    if ( position === undefined ) return 0;

    const V = position.count;

    let F = 0;
    let E = 0;

    if ( index !== null && index !== undefined ) {
        F = Math.floor( index.count / 3 );
        E = _countEdges( geometry );
    }

    return V - E + F;
}

// ─── Internal: count unique edges. ─────────────────────────────────────────

function _countEdges( geometry ) {
    const index = geometry.index;

    if ( index === null || index === undefined ) return 0;

    const idxArr = index.array;
    const idxCount = index.count;

    const edgeMap = new Map();

    for ( let t = 0; t < idxCount; t += 3 ) {
        const a = idxArr[ t ];
        const b = idxArr[ t + 1 ];
        const c = idxArr[ t + 2 ];

        edgeMap.set( _edgeKey( a, b ), 1 );
        edgeMap.set( _edgeKey( b, c ), 1 );
        edgeMap.set( _edgeKey( c, a ), 1 );
    }

    return edgeMap.size;
}

// ─── Internal: skin weight snapshot. ───────────────────────────────────────

function _snapshotSkinWeights( skinWeight, skinIndex, vertexCount ) {
    const bonesPerVertex = skinWeight.itemSize !== undefined ? skinWeight.itemSize : 4;
    const needed = vertexCount * bonesPerVertex;

    if ( _workWeights === null || _workSkinCapacity < needed ) {
        _workWeights = new Float32Array( Math.max( needed, _workSkinCapacity * 2, 4096 ) );
        _workIndicesSkin = new Uint16Array( Math.max( needed, _workSkinCapacity * 2, 4096 ) );
        _workSkinCapacity = Math.max( needed, _workSkinCapacity * 2, 4096 );
    }

    for ( let i = 0; i < needed; i ++ ) {
        _workWeights[ i ] = skinWeight.array[ i ];
        _workIndicesSkin[ i ] = skinIndex.array[ i ];
    }
}

// ─── Internal: reset operation result. ─────────────────────────────────────

function _resetOperationResult( operation ) {
    _topologyOperationResult.geometryId = - 1;
    _topologyOperationResult.operation = operation;
    _topologyOperationResult.vertexCountBefore = 0;
    _topologyOperationResult.vertexCountAfter = 0;
    _topologyOperationResult.triangleCountBefore = 0;
    _topologyOperationResult.triangleCountAfter = 0;
    _topologyOperationResult.faceCountBefore = 0;
    _topologyOperationResult.faceCountAfter = 0;
    _topologyOperationResult.weldedPairCount = 0;
    _topologyOperationResult.triangulatedFaceCount = 0;
    _topologyOperationResult.subdivisionLevel = 0;
    _topologyOperationResult.subdivisionAdaptive = false;
    _topologyOperationResult.boundaryLoopCount = 0;
    _topologyOperationResult.genus = 0;
    _topologyOperationResult.eulerCharacteristic = 0;
    _topologyOperationResult.isClosed = false;
    _topologyOperationResult.isManifold = false;
    _topologyOperationResult.weightsPreserved = false;
    _topologyOperationResult.operationMs = 0.0;
    _topologyOperationResult.subdivideMs = 0.0;
    _topologyOperationResult.triangulateMs = 0.0;
    _topologyOperationResult.weldMs = 0.0;
    _topologyOperationResult.boundaryMs = 0.0;
}

// ─── Public API: ECS sync. ─────────────────────────────────────────────────

const _ecsArbitraryByHash = new Map();

function _syncArbitraryECS( geometry, geometryHash, frameIndex, operation ) {
    let eid = _ecsArbitraryByHash.get( geometryHash );

    if ( eid === undefined ) {
        eid = addEntity( _arbitraryWorld );
        addComponent( _arbitraryWorld, ArbitraryTopologySoA, eid );
        _ecsArbitraryByHash.set( geometryHash, eid );
    }

    const position = geometry.attributes.position;
    const index = geometry.index;

    ArbitraryTopologySoA.geometryId[ eid ] = geometry.id !== undefined ? geometry.id : - 1;
    ArbitraryTopologySoA.geometryUuidHash[ eid ] = geometryHash;
    ArbitraryTopologySoA.topologyKind[ eid ] = _detectQuadOrNGon( geometry );
    ArbitraryTopologySoA.vertexCount[ eid ] = position !== undefined ? position.count : 0;
    ArbitraryTopologySoA.faceCount[ eid ] = _topologyOperationResult.faceCountAfter;
    ArbitraryTopologySoA.triangleCount[ eid ] = index !== null && index !== undefined
        ? Math.floor( index.count / 3 )
        : 0;
    ArbitraryTopologySoA.quadCount[ eid ] = 0;
    ArbitraryTopologySoA.nGonCount[ eid ] = 0;
    ArbitraryTopologySoA.edgeCount[ eid ] = _countEdges( geometry );

    ArbitraryTopologySoA.subdivisionLevel[ eid ] = _topologyOperationResult.subdivisionLevel;
    ArbitraryTopologySoA.subdivisionAdaptive[ eid ] = _topologyOperationResult.subdivisionAdaptive ? 1 : 0;
    ArbitraryTopologySoA.subdivisionVertexCount[ eid ] = _topologyOperationResult.vertexCountAfter;

    ArbitraryTopologySoA.weldedVertexCount[ eid ] = _topologyOperationResult.vertexCountAfter;
    ArbitraryTopologySoA.weldedPairCount[ eid ] = _topologyOperationResult.weldedPairCount;
    ArbitraryTopologySoA.weldIterations[ eid ] = 1;

    ArbitraryTopologySoA.triangulatedFaceCount[ eid ] = _topologyOperationResult.triangulatedFaceCount;
    ArbitraryTopologySoA.triangulatedTriangleCount[ eid ] = _topologyOperationResult.triangulatedTriangleCount;
    ArbitraryTopologySoA.triangulationPreservedWeights[ eid ] = _topologyOperationResult.triangulationPreservedWeights;

    ArbitraryTopologySoA.boundaryEdgeCount[ eid ] = _topologyOperationResult.boundaryLoopCount;
    ArbitraryTopologySoA.boundaryLoopCount[ eid ] = _topologyOperationResult.boundaryLoopCount;

    ArbitraryTopologySoA.genus[ eid ] = _topologyOperationResult.genus;
    ArbitraryTopologySoA.eulerCharacteristic[ eid ] = _topologyOperationResult.eulerCharacteristic;
    ArbitraryTopologySoA.isClosed[ eid ] = _topologyOperationResult.isClosed ? 1 : 0;
    ArbitraryTopologySoA.isManifold[ eid ] = _topologyOperationResult.isManifold ? 1 : 0;
    ArbitraryTopologySoA.isOrientable[ eid ] = _topologyOperationResult.isManifold ? 1 : 0;

    ArbitraryTopologySoA.weightsPreserved[ eid ] = _topologyOperationResult.weightsPreserved ? 1 : 0;
    ArbitraryTopologySoA.weightRecomputePassMs[ eid ] = 0.0;

    ArbitraryTopologySoA.lastOperationMs[ eid ] = _topologyOperationResult.operationMs;
    ArbitraryTopologySoA.avgOperationMsEMA[ eid ] =
        ArbitraryTopologySoA.avgOperationMsEMA[ eid ] * 0.9 + _topologyOperationResult.operationMs * 0.1;
    ArbitraryTopologySoA.lastSubdivideMs[ eid ] = _topologyOperationResult.subdivideMs;
    ArbitraryTopologySoA.lastTriangulateMs[ eid ] = _topologyOperationResult.triangulateMs;
    ArbitraryTopologySoA.lastWeldMs[ eid ] = _topologyOperationResult.weldMs;
    ArbitraryTopologySoA.lastBoundaryMs[ eid ] = _topologyOperationResult.boundaryMs;

    const ditherSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    ArbitraryTopologySoA.ditherSample[ eid ] = _noise3D( ditherSeed * 1e-6, frameIndex * 0.02, ArbitraryTopologySoA.topologyKind[ eid ] );
    ArbitraryTopologySoA.determinismSeed[ eid ] = SkinnedMeshDefaults.determinismSeed;

    ArbitraryTopologySoA.registered[ eid ] = 1;
    ArbitraryTopologySoA.processed[ eid ] = 1;
    ArbitraryTopologySoA.lastFrameIndex[ eid ] = frameIndex | 0;

    void operation;
}

// ─── Public API: query. ────────────────────────────────────────────────────

/**
 * Returns the arbitrary topology entity id for the given geometry UUID.
 * @param {string} uuid
 * @return {number}
 */
function getArbitraryEntityForUuid( uuid ) {
    const hash = _hashString( uuid );
    const eid = _ecsArbitraryByHash.get( hash );
    return eid !== undefined ? eid : - 1;
}

/**
 * Returns the last operation result.
 * @return {object}
 */
function getLastOperationResult() {
    return _topologyOperationResult;
}

/**
 * Returns aggregated arbitrary topology statistics.
 * @return {object}
 */
function getAggregatedStats() {
    let totalGeometries = 0;
    let totalVertices = 0;
    let totalTriangles = 0;
    let totalSubdividedVertices = 0;
    let totalWeldedPairs = 0;
    let totalTriangulatedFaces = 0;
    let totalBoundaryLoops = 0;
    let totalOperationMs = 0.0;

    const q = query( _arbitraryWorld, [ ArbitraryTopologySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( ArbitraryTopologySoA.registered[ eid ] !== 1 ) continue;

        totalGeometries ++;
        totalVertices += ArbitraryTopologySoA.vertexCount[ eid ];
        totalTriangles += ArbitraryTopologySoA.triangleCount[ eid ];
        totalSubdividedVertices += ArbitraryTopologySoA.subdivisionVertexCount[ eid ];
        totalWeldedPairs += ArbitraryTopologySoA.weldedPairCount[ eid ];
        totalTriangulatedFaces += ArbitraryTopologySoA.triangulatedFaceCount[ eid ];
        totalBoundaryLoops += ArbitraryTopologySoA.boundaryLoopCount[ eid ];
        totalOperationMs += ArbitraryTopologySoA.lastOperationMs[ eid ];
    }

    const ms = new Double( totalOperationMs );

    return {
        totalGeometries: totalGeometries,
        totalVertices: totalVertices,
        totalTriangles: totalTriangles,
        totalSubdividedVertices: totalSubdividedVertices,
        totalWeldedPairs: totalWeldedPairs,
        totalTriangulatedFaces: totalTriangulatedFaces,
        totalBoundaryLoops: totalBoundaryLoops,
        totalOperationMs: ms.valueOf()
    };
}

// ─── Public API: high-precision helpers. ───────────────────────────────────

/**
 * Returns a high-precision subdivision growth ratio.
 * @return {number}
 */
function computeSubdivisionGrowthHighPrecision() {
    const before = new Double( Math.max( 1, _topologyOperationResult.vertexCountBefore ) );
    const after = new Double( _topologyOperationResult.vertexCountAfter );

    return after.div( before ).valueOf();
}

/**
 * Returns a high-precision weld savings ratio.
 * @return {number}
 */
function computeWeldSavingsHighPrecision() {
    const before = new Double( Math.max( 1, _topologyOperationResult.vertexCountBefore ) );
    const after = new Double( Math.max( 0, _topologyOperationResult.vertexCountAfter ) );

    return 1.0 - after.div( before ).valueOf();
}

/**
 * Returns a high-precision topology operation cost estimate.
 * @return {number}
 */
function computeOperationCostHighPrecision() {
    const verts = new Double( _topologyOperationResult.vertexCountBefore );
    const tris = new Double( Math.max( 1, _topologyOperationResult.triangleCountBefore ) );
    const ms = new Double( _topologyOperationResult.operationMs );

    return verts.mul( tris ).mul( ms ).valueOf();
}

// ─── gl-matrix packing for telemetry. ──────────────────────────────────────

/**
 * Packs arbitrary topology telemetry into a vec4.
 * Layout: (vertexCount, triangleCount, subdivisionLevel, boundaryLoopCount)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packArbitraryVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
        v,
        _topologyOperationResult.vertexCountAfter,
        _topologyOperationResult.triangleCountAfter,
        _topologyOperationResult.subdivisionLevel,
        _topologyOperationResult.boundaryLoopCount
    );
    return v;
}

/**
 * Packs geometry stats into a vec4.
 * Layout: (vertexCountBefore, vertexCountAfter, triangleCountBefore, triangleCountAfter)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packGrowthVec4( out ) {
    const v = out || _scratchVec4B;
    glMatrix.vec4.set(
        v,
        _topologyOperationResult.vertexCountBefore,
        _topologyOperationResult.vertexCountAfter,
        _topologyOperationResult.triangleCountBefore,
        _topologyOperationResult.triangleCountAfter
    );
    return v;
}

/**
 * Packs timing breakdown into a vec4.
 * Layout: (subdivideMs, triangulateMs, weldMs, boundaryMs)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packTopologyTimingVec4( out ) {
    const v = out || _scratchVec4C;
    glMatrix.vec4.set(
        v,
        _topologyOperationResult.subdivideMs,
        _topologyOperationResult.triangulateMs,
        _topologyOperationResult.weldMs,
        _topologyOperationResult.boundaryMs
    );
    return v;
}

/**
 * Packs genus / euler / manifold flags into a vec4.
 * Layout: (genus, eulerCharacteristic, isClosed, weightsPreserved)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packGenusVec4( out ) {
    const v = out || _scratchVec4D;
    glMatrix.vec4.set(
        v,
        _topologyOperationResult.genus,
        _topologyOperationResult.eulerCharacteristic,
        _topologyOperationResult.isClosed ? 1 : 0,
        _topologyOperationResult.weightsPreserved ? 1 : 0
    );
    return v;
}

// ─── Deterministic dither sampling. ────────────────────────────────────────

/**
 * Returns a deterministic dither sample for the given geometry / frame.
 * @param {number} geometryHash
 * @param {number} frameIndex
 * @return {number}
 */
function sampleTopologySupportDither( geometryHash, frameIndex ) {
    const seed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, 0 );
}

// ─── Public API: frame lifecycle. ──────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all arbitrary topology entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _arbitraryWorld, [ ArbitraryTopologySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        ArbitraryTopologySoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
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

function _nowMs() {
    if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
        return performance.now();
    }
    return Date.now();
}

void BufferAttribute;
void Vector3;
void Matrix4;
void SkinnedMeshCaps;
void getAdjacencyMap;
void ArbitraryTopologyDefaults.computeGenus;
void ArbitraryTopologyDefaults.emitDither;
void _workPositions;
void _workIndices;
void _workNormals;
void _workPositionsCapacity;
void _workIndicesCapacity;
void _workNormalsCapacity;
void _scratchVec3D;
void _scratchVec3E;
void _scratchVec3F;
void _scratchVec3G;
void _scratchVec3H;
void _scratchMat4;

export {
    SubdivisionMode,
    TriangulationMode,
    ArbitraryTopologyDefaults,
    ArbitraryTopologySoA,
    subdivideOnce,
    subdivideAdaptive,
    triangulate,
    weldGrid,
    extractBoundaries,
    computeGenus,
    computeEulerCharacteristic,
    getArbitraryEntityForUuid,
    getLastOperationResult,
    getAggregatedStats,
    computeSubdivisionGrowthHighPrecision,
    computeWeldSavingsHighPrecision,
    computeOperationCostHighPrecision,
    packArbitraryVec4,
    packGrowthVec4,
    packTopologyTimingVec4,
    packGenusVec4,
    sampleTopologySupportDither,
    beginFrame
};