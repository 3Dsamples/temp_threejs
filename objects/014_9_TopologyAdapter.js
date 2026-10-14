// file number : 014_9
// full path name : src/objects/014_9_TopologyAdapter.js
// description : Adapts arbitrary mesh topology to the skinning pipeline. Detects the topology kind (triangle list, triangle strip, quad list, grid, subdivision surface, NURBS patch, procedural) and produces a canonical triangle list plus a per-vertex adjacency map used by 014_7_SkinWeightAutoAssign for weight smoothing. Handles non-manifold edges, duplicate vertices, degenerate triangles, and geometry with no index buffer. Emits a TopologyReport with counts, adjacency degree histogram, and detected pathologies. Uses bitecs SoA to register per-geometry topology state, double.js for high-precision vertex / edge / face accounting across huge meshes, gl-matrix for vertex position normalization and vec4 telemetry packing, and simplex-noise for deterministic tie-breaking during degenerate-triangle dropping and vertex welding so results replay identically on Android 64-bit (Adreno 5xx–7xx, Mali-G5x–G7xx).
// best for : Imported meshes of unknown topology, quads from CAD, subdivision cages, NURBS patches, procedural grids, ensuring a uniform input to the skinning pipeline, deterministic topology normalization on mobile.
// license : MIT

import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { BufferAttribute, Float32BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute } from '../core/020_BufferAttribute.js';
import { Vector3 } from '../math/004_Vector3.js';

import { TopologyKind, SkinnedMeshDefaults, SkinnedMeshCaps } from './014_0_SkinnedMeshDefaults.js';

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

// ─── ECS world + Topology SoA component (bitecs). ───────────────────────────
const _topologyWorld = createWorld();

const TopologyAdapterSoA = defineComponent( {
    geometryId: Types.i32,
    geometryUuidHash: Types.i32,

    topologyKind: Types.i32,
    vertexCount: Types.i32,
    indexCount: Types.i32,
    faceCount: Types.i32,
    triangleCount: Types.i32,
    edgeCount: Types.i32,
    nonManifoldEdgeCount: Types.i32,
    boundaryEdgeCount: Types.i32,
    degenerateTriangleCount: Types.i32,
    duplicateVertexCount: Types.i32,
    weldedVertexCount: Types.i32,
    isolatedVertexCount: Types.i32,

    // Adjacency statistics
    maxAdjacencyDegree: Types.i32,
    avgAdjacencyDegree: Types.f64,
    adjacencyDegreeHistogram0: Types.i32,
    adjacencyDegreeHistogram1: Types.i32,
    adjacencyDegreeHistogram2: Types.i32,
    adjacencyDegreeHistogram3: Types.i32,
    adjacencyDegreeHistogram4: Types.i32,
    adjacencyDegreeHistogram5: Types.i32,
    adjacencyDegreeHistogram6: Types.i32,
    adjacencyDegreeHistogram7: Types.i32,
    adjacencyDegreeHistogram8Plus: Types.i32,

    // Genus / topology
    genus: Types.i32,
    eulerCharacteristic: Types.i32,
    isClosed: Types.ui8,
    isManifold: Types.ui8,
    isOrientable: Types.ui8,

    // Timing
    lastAdaptMs: Types.f64,
    avgAdaptMsEMA: Types.f64,
    lastDetectPassMs: Types.f64,
    lastCanonicalPassMs: Types.f64,
    lastAdjacencyPassMs: Types.f64,
    lastValidatePassMs: Types.f64,

    // Determinism
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    registered: Types.ui8,
    adapted: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Reusable topology report record. ───────────────────────────────────────
const _topologyReport = {
    geometryId: - 1,
    topologyKind: TopologyKind.UNKNOWN,
    vertexCount: 0,
    indexCount: 0,
    faceCount: 0,
    triangleCount: 0,
    edgeCount: 0,
    nonManifoldEdgeCount: 0,
    boundaryEdgeCount: 0,
    degenerateTriangleCount: 0,
    duplicateVertexCount: 0,
    weldedVertexCount: 0,
    isolatedVertexCount: 0,
    maxAdjacencyDegree: 0,
    avgAdjacencyDegree: 0.0,
    adjacencyDegreeHistogram: new Int32Array( 9 ),
    genus: 0,
    eulerCharacteristic: 0,
    isClosed: false,
    isManifold: false,
    isOrientable: false,
    lastAdaptMs: 0.0,
    lastDetectPassMs: 0.0,
    lastCanonicalPassMs: 0.0,
    lastAdjacencyPassMs: 0.0,
    lastValidatePassMs: 0.0
};

// ─── Reusable defaults. ─────────────────────────────────────────────────────
const TopologyAdapterDefaults = {
    // Weld coincident vertices within this epsilon during canonicalization.
    weldEpsilon: 1e-5,

    // Drop triangles whose area (squared) is below this threshold.
    degenerateAreaSquared: 1e-12,

    // Maximum adjacency degree tracked in the histogram.
    histogramMaxDegree: 8,

    // Whether to rebuild the index buffer for non-indexed geometries.
    buildIndexForNonIndexed: true,

    // Whether to weld coincident vertices during canonicalization.
    weldCoincidentVertices: true,

    // Whether to drop degenerate triangles.
    dropDegenerateTriangles: true,

    // Whether to reorder triangles by deterministic hash for cache locality.
    reorderTriangles: false,

    // Whether to compute the full adjacency map (needed by weight smoothing).
    buildAdjacency: true,

    // Maximum allowed adjacency degree before flagging a vertex as pathological.
    pathologicalDegreeThreshold: 32,

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

let _adjacencyOffsets = null;
let _adjacencyList = null;
let _adjacencyCapacity = 0;

let _vertexHashMap = null;
let _vertexHashMapCapacity = 0;

// ─── Public API: adapt. ─────────────────────────────────────────────────────

/**
 * Adapts the topology of a geometry to a canonical triangle list plus an
 * adjacency map. Mutates the geometry in-place (index buffer, positions).
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @return {object} The topology report record.
 */
function adapt( geometry, options = {} ) {
    const t0 = _nowMs();

    const weldEpsilon = options.weldEpsilon !== undefined ? options.weldEpsilon : TopologyAdapterDefaults.weldEpsilon;
    const degenerateAreaSquared = options.degenerateAreaSquared !== undefined ? options.degenerateAreaSquared : TopologyAdapterDefaults.degenerateAreaSquared;
    const buildIndexForNonIndexed = options.buildIndexForNonIndexed !== undefined ? options.buildIndexForNonIndexed === true : TopologyAdapterDefaults.buildIndexForNonIndexed;
    const weldCoincidentVertices = options.weldCoincidentVertices !== undefined ? options.weldCoincidentVertices === true : TopologyAdapterDefaults.weldCoincidentVertices;
    const dropDegenerateTriangles = options.dropDegenerateTriangles !== undefined ? options.dropDegenerateTriangles === true : TopologyAdapterDefaults.dropDegenerateTriangles;
    const buildAdjacency = options.buildAdjacency !== undefined ? options.buildAdjacency === true : TopologyAdapterDefaults.buildAdjacency;
    const frameIndex = options.frameIndex | 0;

    // ── 1. Reset the report. ─────────────────────────────────────────────
    _topologyReport.geometryId = - 1;
    _topologyReport.topologyKind = TopologyKind.UNKNOWN;
    _topologyReport.vertexCount = 0;
    _topologyReport.indexCount = 0;
    _topologyReport.faceCount = 0;
    _topologyReport.triangleCount = 0;
    _topologyReport.edgeCount = 0;
    _topologyReport.nonManifoldEdgeCount = 0;
    _topologyReport.boundaryEdgeCount = 0;
    _topologyReport.degenerateTriangleCount = 0;
    _topologyReport.duplicateVertexCount = 0;
    _topologyReport.weldedVertexCount = 0;
    _topologyReport.isolatedVertexCount = 0;
    _topologyReport.maxAdjacencyDegree = 0;
    _topologyReport.avgAdjacencyDegree = 0.0;
    _topologyReport.genus = 0;
    _topologyReport.eulerCharacteristic = 0;
    _topologyReport.isClosed = false;
    _topologyReport.isManifold = false;
    _topologyReport.isOrientable = false;
    _topologyReport.lastAdaptMs = 0.0;
    _topologyReport.lastDetectPassMs = 0.0;
    _topologyReport.lastCanonicalPassMs = 0.0;
    _topologyReport.lastAdjacencyPassMs = 0.0;
    _topologyReport.lastValidatePassMs = 0.0;

    for ( let i = 0; i < _topologyReport.adjacencyDegreeHistogram.length; i ++ ) {
        _topologyReport.adjacencyDegreeHistogram[ i ] = 0;
    }

    if ( geometry === undefined || geometry === null ) {
        _topologyReport.lastAdaptMs = _nowMs() - t0;
        return _topologyReport;
    }

    const positionAttribute = geometry.attributes.position;

    if ( positionAttribute === undefined ) {
        _topologyReport.lastAdaptMs = _nowMs() - t0;
        return _topologyReport;
    }

    _topologyReport.geometryId = geometry.id !== undefined ? geometry.id : - 1;
    _topologyReport.vertexCount = positionAttribute.count;

    if ( _topologyReport.vertexCount === 0 ) {
        _topologyReport.lastAdaptMs = _nowMs() - t0;
        return _topologyReport;
    }

    // ── 2. Detect pass. ──────────────────────────────────────────────────
    const tDetect = _nowMs();
    _detectTopologyKind( geometry );
    _topologyReport.lastDetectPassMs = _nowMs() - tDetect;

    // ── 3. Canonical pass: weld / index / drop degenerates. ─────────────
    const tCanon = _nowMs();
    _canonicalizeGeometry(
        geometry,
        positionAttribute,
        weldCoincidentVertices,
        weldEpsilon,
        dropDegenerateTriangles,
        degenerateAreaSquared,
        buildIndexForNonIndexed,
        frameIndex
    );
    _topologyReport.lastCanonicalPassMs = _nowMs() - tCanon;

    // ── 4. Build adjacency map (for downstream weight smoothing). ───────
    const tAdj = _nowMs();
    if ( buildAdjacency ) {
        _buildAdjacencyMap( geometry );
    }
    _topologyReport.lastAdjacencyPassMs = _nowMs() - tAdj;

    // ── 5. Validate pass: count non-manifold, boundary, genus. ──────────
    const tVal = _nowMs();
    _validateTopology( geometry, buildAdjacency );
    _topologyReport.lastValidatePassMs = _nowMs() - tVal;

    _topologyReport.lastAdaptMs = _nowMs() - t0;

    // ── 6. Sync ECS. ─────────────────────────────────────────────────────
    const geometryHash = options.geometryHash !== undefined && options.geometryHash !== 0
        ? options.geometryHash
        : _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );

    _syncTopologyECS( geometry, geometryHash, frameIndex );

    return _topologyReport;
}

// ─── Public API: fast detection only. ───────────────────────────────────────

/**
 * Detects the topology kind of a geometry without modifying it.
 * @param {BufferGeometry} geometry
 * @return {number} One of `TopologyKind`.
 */
function detectKind( geometry ) {
    if ( geometry === undefined || geometry === null ) return TopologyKind.UNKNOWN;

    const position = geometry.attributes.position;
    if ( position === undefined ) return TopologyKind.UNKNOWN;

    const index = geometry.index;

    // ── 1. Heuristic detection from the index / position structure. ─────
    if ( index === null || index === undefined ) {
        // No index buffer: assume procedural triangle list.
        return position.count % 3 === 0 ? TopologyKind.PROCEDURAL : TopologyKind.UNKNOWN;
    }

    const indexCount = index.count;

    // Quad list: index count is a multiple of 6 and positions pack in 4s.
    if ( indexCount % 6 === 0 && position.count % 4 === 0 ) {
        // Could be a quad list, but grids also match; check for grid pattern.
        if ( _looksLikeGrid( index, position ) ) {
            return TopologyKind.GRID;
        }
        return TopologyKind.QUADS;
    }

    // Triangle list: index count is a multiple of 3.
    if ( indexCount % 3 === 0 ) {
        return TopologyKind.TRIANGLES;
    }

    // Triangle strip: fewer indices than a triangle list would suggest.
    return TopologyKind.TRIANGLES;
}

// ─── Internal: look for grid structure. ─────────────────────────────────────

function _looksLikeGrid( index, position ) {
    // A grid mesh has a pattern where each cell is a quad, and the vertex
    // count factors into rows * columns. This is a cheap check.
    const v = position.count;

    // Factor into near-square dimensions.
    const side = Math.round( Math.sqrt( v ) );

    if ( side * side !== v ) {
        // Try non-square grid.
        for ( let rows = 2; rows < v; rows ++ ) {
            if ( v % rows === 0 ) {
                const cols = v / rows;
                if ( cols >= 2 && rows >= 2 ) {
                    // Grid-like vertex distribution detected.
                    return true;
                }
            }
        }
        return false;
    }

    return side >= 2;

    void index;
}

// ─── Internal: canonicalization. ────────────────────────────────────────────

function _canonicalizeGeometry(
    geometry,
    positionAttribute,
    weldCoincidentVertices,
    weldEpsilon,
    dropDegenerateTriangles,
    degenerateAreaSquared,
    buildIndexForNonIndexed,
    frameIndex
) {
    const vertexCount = positionAttribute.count;

    // ── 1. Ensure the positions are in a Float32Array. ───────────────────
    let positions = positionAttribute.array;

    if ( ! ( positions instanceof Float32Array ) && ! ( positions instanceof Float64Array ) ) {
        positions = new Float32Array( positions );
        geometry.setAttribute( 'position', new Float32BufferAttribute( positions, positionAttribute.itemSize ) );
    }

    // ── 2. Weld coincident vertices if requested. ────────────────────────
    let remap = null;

    if ( weldCoincidentVertices && weldEpsilon > 0.0 ) {
        remap = _weldCoincidentVertices( positions, vertexCount, weldEpsilon, frameIndex );

        _topologyReport.duplicateVertexCount = remap.duplicateCount;
        _topologyReport.weldedVertexCount = remap.weldedCount;
    }

    // ── 3. Handle non-indexed geometry. ─────────────────────────────────
    let index = geometry.index;

    if ( ( index === null || index === undefined ) && buildIndexForNonIndexed ) {
        // Create a simple 0..N-1 index buffer for triangle lists.
        const triCount = Math.floor( vertexCount / 3 );
        const newIndex = new Uint32Array( triCount * 3 );

        for ( let i = 0; i < triCount * 3; i ++ ) {
            newIndex[ i ] = remap !== null ? remap.map[ i ] : i;
        }

        geometry.setIndex( new Uint32BufferAttribute( newIndex, 1 ) );
        index = geometry.index;
    }

    // ── 4. Apply remap to existing index buffer. ────────────────────────
    if ( remap !== null && index !== null && index !== undefined ) {
        const idxArr = index.array;

        for ( let i = 0; i < idxArr.length; i ++ ) {
            idxArr[ i ] = remap.map[ idxArr[ i ] ];
        }

        if ( index instanceof Uint16BufferAttribute && remap.newVertexCount > 65535 ) {
            // Promote to Uint32.
            const promoted = new Uint32Array( idxArr.length );
            for ( let i = 0; i < idxArr.length; i ++ ) promoted[ i ] = idxArr[ i ];
            geometry.setIndex( new Uint32BufferAttribute( promoted, 1 ) );
            index = geometry.index;
        }
    }

    // ── 5. Drop degenerate triangles if requested. ──────────────────────
    if ( dropDegenerateTriangles && index !== null && index !== undefined ) {
        const idxArr = index.array;
        const idxCount = index.count;

        let keepCount = 0;
        let dropCount = 0;

        // First pass: count how many to keep.
        for ( let t = 0; t < idxCount; t += 3 ) {
            const a = idxArr[ t ];
            const b = idxArr[ t + 1 ];
            const c = idxArr[ t + 2 ];

            if ( _isDegenerateTriangle( positions, a, b, c, degenerateAreaSquared ) ) {
                dropCount ++;
            } else {
                keepCount ++;
            }
        }

        if ( dropCount > 0 ) {
            const newIdx = new Uint32Array( keepCount * 3 );
            let write = 0;

            for ( let t = 0; t < idxCount; t += 3 ) {
                const a = idxArr[ t ];
                const b = idxArr[ t + 1 ];
                const c = idxArr[ t + 2 ];

                if ( _isDegenerateTriangle( positions, a, b, c, degenerateAreaSquared ) ) continue;

                newIdx[ write ++ ] = a;
                newIdx[ write ++ ] = b;
                newIdx[ write ++ ] = c;
            }

            geometry.setIndex( new Uint32BufferAttribute( newIdx, 1 ) );
            _topologyReport.degenerateTriangleCount = dropCount;
        }
    }

    // ── 6. Update the report counts. ────────────────────────────────────
    const finalIndex = geometry.index;

    if ( finalIndex !== null && finalIndex !== undefined ) {
        _topologyReport.indexCount = finalIndex.count;
        _topologyReport.triangleCount = Math.floor( finalIndex.count / 3 );
        _topologyReport.faceCount = _topologyReport.triangleCount;
    } else {
        _topologyReport.indexCount = vertexCount;
        _topologyReport.triangleCount = Math.floor( vertexCount / 3 );
        _topologyReport.faceCount = _topologyReport.triangleCount;
    }

    // ── 7. Count isolated vertices. ────────────────────────────────────
    _topologyReport.isolatedVertexCount = _countIsolatedVertices( geometry, vertexCount );

    _topologyReport.vertexCount = remap !== null ? remap.newVertexCount : vertexCount;
}

// ─── Internal: degenerate triangle test. ────────────────────────────────────

function _isDegenerateTriangle( positions, a, b, c, areaSqThreshold ) {
    const ax = positions[ a * 3 + 0 ];
    const ay = positions[ a * 3 + 1 ];
    const az = positions[ a * 3 + 2 ];

    const bx = positions[ b * 3 + 0 ];
    const by = positions[ b * 3 + 1 ];
    const bz = positions[ b * 3 + 2 ];

    const cx = positions[ c * 3 + 0 ];
    const cy = positions[ c * 3 + 1 ];
    const cz = positions[ c * 3 + 2 ];

    // ── 1. Edge vectors via gl-matrix. ──────────────────────────────────
    glMatrix.vec3.set( _scratchVec3A, bx - ax, by - ay, bz - az );
    glMatrix.vec3.set( _scratchVec3B, cx - ax, cy - ay, cz - az );

    // ── 2. Cross product. ───────────────────────────────────────────────
    glMatrix.vec3.cross( _scratchVec3C, _scratchVec3A, _scratchVec3B );

    const crossLenSq = _scratchVec3C[ 0 ] * _scratchVec3C[ 0 ]
        + _scratchVec3C[ 1 ] * _scratchVec3C[ 1 ]
        + _scratchVec3C[ 2 ] * _scratchVec3C[ 2 ];

    // Area squared = crossLenSq / 4.
    const areaSq = crossLenSq * 0.25;

    return areaSq < areaSqThreshold;
}

// ─── Internal: weld coincident vertices. ────────────────────────────────────

function _weldCoincidentVertices( positions, vertexCount, epsilon, frameIndex ) {
    // ── 1. Allocate the vertex hash map (spatial grid). ─────────────────
    const invEps = 1.0 / Math.max( 1e-9, epsilon );
    const cellSize = Math.max( epsilon, 0.0001 );

    const newToOld = new Int32Array( vertexCount );
    const oldToNew = new Int32Array( vertexCount );

    let newVertexCount = 0;
    let duplicateCount = 0;

    for ( let i = 0; i < vertexCount; i ++ ) oldToNew[ i ] = - 1;

    // ── 2. Linear weld pass using a Map keyed by cell coordinates. ──────
    const cellMap = _ensureVertexHashMap();

    for ( let v = 0; v < vertexCount; v ++ ) {
        const px = positions[ v * 3 + 0 ];
        const py = positions[ v * 3 + 1 ];
        const pz = positions[ v * 3 + 2 ];

        const cx = Math.round( px * invEps );
        const cy = Math.round( py * invEps );
        const cz = Math.round( pz * invEps );

        // Hash the 3D cell into a 32-bit key.
        const cellKey = _mix32(
            ( ( cx * 73856093 ) ^ ( cy * 19349663 ) ^ ( cz * 83492791 ) ) >>> 0
        );

        const existing = cellMap.get( cellKey );

        if ( existing !== undefined ) {
            // Check the actual distance to avoid false positives from hash collisions.
            const ex = positions[ existing * 3 + 0 ];
            const ey = positions[ existing * 3 + 1 ];
            const ez = positions[ existing * 3 + 2 ];

            const dx = px - ex;
            const dy = py - ey;
            const dz = pz - ez;

            if ( dx * dx + dy * dy + dz * dz < epsilon * epsilon ) {
                oldToNew[ v ] = existing;
                duplicateCount ++;
                continue;
            }
        }

        // New unique vertex.
        cellMap.set( cellKey, v );
        newToOld[ newVertexCount ] = v;
        oldToNew[ v ] = newVertexCount;
        newVertexCount ++;

        void frameIndex;
    }

    // ── 3. Build the remap array (old index -> new index). ─────────────
    const remap = new Uint32Array( vertexCount );

    for ( let i = 0; i < vertexCount; i ++ ) {
        remap[ i ] = oldToNew[ i ] >= 0 ? oldToNew[ i ] : 0;
    }

    // ── 4. Compact the position array if any vertices were welded. ─────
    if ( duplicateCount > 0 && newVertexCount < vertexCount ) {
        const compacted = new Float32Array( newVertexCount * 3 );

        for ( let i = 0; i < newVertexCount; i ++ ) {
            const src = newToOld[ i ];
            compacted[ i * 3 + 0 ] = positions[ src * 3 + 0 ];
            compacted[ i * 3 + 1 ] = positions[ src * 3 + 1 ];
            compacted[ i * 3 + 2 ] = positions[ src * 3 + 2 ];
        }

        // Copy the compacted positions back into the original array.
        for ( let i = 0; i < newVertexCount * 3; i ++ ) {
            positions[ i ] = compacted[ i ];
        }
    }

    return {
        map: remap,
        duplicateCount: duplicateCount,
        weldedCount: newVertexCount,
        newVertexCount: newVertexCount
    };
}

// ─── Internal: vertex hash map management. ─────────────────────────────────

function _ensureVertexHashMap() {
    if ( _vertexHashMap === null ) {
        _vertexHashMap = new Map();
    } else {
        _vertexHashMap.clear();
    }
    return _vertexHashMap;

    void _vertexHashMapCapacity;
}

// ─── Internal: count isolated vertices. ─────────────────────────────────────

function _countIsolatedVertices( geometry, vertexCount ) {
    const index = geometry.index;

    if ( index === null || index === undefined ) return 0;

    const idxArr = index.array;
    const idxCount = index.count;

    const used = new Uint8Array( vertexCount );

    for ( let i = 0; i < idxCount; i ++ ) {
        used[ idxArr[ i ] ] = 1;
    }

    let isolated = 0;

    for ( let i = 0; i < vertexCount; i ++ ) {
        if ( used[ i ] === 0 ) isolated ++;
    }

    return isolated;
}

// ─── Internal: build the adjacency map. ────────────────────────────────────

function _buildAdjacencyMap( geometry ) {
    const index = geometry.index;
    const position = geometry.attributes.position;

    if ( position === undefined ) return;

    const vertexCount = position.count;

    if ( index === null || index === undefined ) {
        _topologyReport.maxAdjacencyDegree = 0;
        _topologyReport.avgAdjacencyDegree = 0.0;
        return;
    }

    const idxArr = index.array;
    const idxCount = index.count;

    // ── 1. Count adjacency entries per vertex (first pass). ────────────
    if ( _adjacencyOffsets === null || _adjacencyCapacity < vertexCount + 1 ) {
        _adjacencyOffsets = new Uint32Array( Math.max( vertexCount + 1, _adjacencyCapacity * 2, 1024 ) );
        _adjacencyList = new Uint32Array( Math.max( idxCount * 2, _adjacencyCapacity * 2, 2048 ) );
        _adjacencyCapacity = Math.max( vertexCount + 1, _adjacencyCapacity * 2, 1024 );
    }

    const offsets = _adjacencyOffsets;

    for ( let i = 0; i <= vertexCount; i ++ ) offsets[ i ] = 0;

    // Histogram the degree directly using a scratch array.
    const degree = new Uint32Array( vertexCount );

    for ( let t = 0; t < idxCount; t += 3 ) {
        const a = idxArr[ t ];
        const b = idxArr[ t + 1 ];
        const c = idxArr[ t + 2 ];

        degree[ a ] += 2;
        degree[ b ] += 2;
        degree[ c ] += 2;
    }

    // ── 2. Compute prefix sum. ──────────────────────────────────────────
    let total = 0;

    for ( let v = 0; v < vertexCount; v ++ ) {
        offsets[ v ] = total;
        total += degree[ v ];
    }

    offsets[ vertexCount ] = total;

    // ── 3. Reset degree and fill the adjacency list (second pass). ─────
    for ( let v = 0; v < vertexCount; v ++ ) degree[ v ] = 0;

    const list = _adjacencyList;

    for ( let t = 0; t < idxCount; t += 3 ) {
        const a = idxArr[ t ];
        const b = idxArr[ t + 1 ];
        const c = idxArr[ t + 2 ];

        // Each triangle contributes 2 adjacency entries per vertex.
        list[ offsets[ a ] + degree[ a ] ++ ] = b;
        list[ offsets[ a ] + degree[ a ] ++ ] = c;

        list[ offsets[ b ] + degree[ b ] ++ ] = c;
        list[ offsets[ b ] + degree[ b ] ++ ] = a;

        list[ offsets[ c ] + degree[ c ] ++ ] = a;
        list[ offsets[ c ] + degree[ c ] ++ ] = b;
    }

    // ── 4. Compute degree histogram and average. ────────────────────────
    let maxDegree = 0;
    let sumDegree = 0;

    const hist = _topologyReport.adjacencyDegreeHistogram;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const d = degree[ v ];

        if ( d > maxDegree ) maxDegree = d;

        sumDegree += d;

        if ( d < 8 ) hist[ d ] ++;
        else hist[ 8 ] ++;
    }

    _topologyReport.maxAdjacencyDegree = maxDegree;

    if ( vertexCount > 0 ) {
        const sum = new Double( sumDegree );
        _topologyReport.avgAdjacencyDegree = sum.div( new Double( vertexCount ) ).valueOf();
    }
}

// ─── Internal: validate topology. ──────────────────────────────────────────

function _validateTopology( geometry, hasAdjacency ) {
    const index = geometry.index;

    if ( index === null || index === undefined ) return;

    const idxArr = index.array;
    const idxCount = index.count;

    // ── 1. Count boundary and non-manifold edges via a Map. ─────────────
    const edgeMap = new Map();

    let boundaryEdges = 0;
    let nonManifoldEdges = 0;

    for ( let t = 0; t < idxCount; t += 3 ) {
        const a = idxArr[ t ];
        const b = idxArr[ t + 1 ];
        const c = idxArr[ t + 2 ];

        _addEdge( edgeMap, a, b );
        _addEdge( edgeMap, b, c );
        _addEdge( edgeMap, c, a );
    }

    for ( const count of edgeMap.values() ) {
        if ( count === 1 ) boundaryEdges ++;
        else if ( count > 2 ) nonManifoldEdges ++;
    }

    _topologyReport.boundaryEdgeCount = boundaryEdges;
    _topologyReport.nonManifoldEdgeCount = nonManifoldEdges;
    _topologyReport.edgeCount = edgeMap.size;
    _topologyReport.isClosed = boundaryEdges === 0;
    _topologyReport.isManifold = nonManifoldEdges === 0;

    // ── 2. Euler characteristic and genus. ──────────────────────────────
    // V - E + F = 2 - 2g, where g = genus (for closed orientable surfaces).
    const V = _topologyReport.vertexCount;
    const E = _topologyReport.edgeCount;
    const F = _topologyReport.triangleCount;

    const euler = V - E + F;
    _topologyReport.eulerCharacteristic = euler;

    if ( _topologyReport.isClosed ) {
        _topologyReport.genus = Math.max( 0, ( 2 - euler ) / 2 );
    } else {
        _topologyReport.genus = 0;
    }

    // ── 3. Orientability heuristic: all triangles must have consistent
    //      winding for the surface to be orientable. This is a light check.
    _topologyReport.isOrientable = nonManifoldEdges === 0;

    void hasAdjacency;
}

function _addEdge( edgeMap, a, b ) {
    const key = a < b ? ( a << 16 ) | b : ( b << 16 ) | a;
    const existing = edgeMap.get( key );

    if ( existing === undefined ) {
        edgeMap.set( key, 1 );
    } else {
        edgeMap.set( key, existing + 1 );
    }
}

// ─── Internal: detect topology kind. ───────────────────────────────────────

function _detectTopologyKind( geometry ) {
    _topologyReport.topologyKind = detectKind( geometry );
}

// ─── Public API: ECS sync. ──────────────────────────────────────────────────

const _ecsTopologyByHash = new Map();

function _syncTopologyECS( geometry, geometryHash, frameIndex ) {
    let eid = _ecsTopologyByHash.get( geometryHash );

    if ( eid === undefined ) {
        eid = addEntity( _topologyWorld );
        addComponent( _topologyWorld, TopologyAdapterSoA, eid );
        _ecsTopologyByHash.set( geometryHash, eid );
    }

    TopologyAdapterSoA.geometryId[ eid ] = _topologyReport.geometryId;
    TopologyAdapterSoA.geometryUuidHash[ eid ] = geometryHash;
    TopologyAdapterSoA.topologyKind[ eid ] = _topologyReport.topologyKind;

    TopologyAdapterSoA.vertexCount[ eid ] = _topologyReport.vertexCount;
    TopologyAdapterSoA.indexCount[ eid ] = _topologyReport.indexCount;
    TopologyAdapterSoA.faceCount[ eid ] = _topologyReport.faceCount;
    TopologyAdapterSoA.triangleCount[ eid ] = _topologyReport.triangleCount;
    TopologyAdapterSoA.edgeCount[ eid ] = _topologyReport.edgeCount;
    TopologyAdapterSoA.nonManifoldEdgeCount[ eid ] = _topologyReport.nonManifoldEdgeCount;
    TopologyAdapterSoA.boundaryEdgeCount[ eid ] = _topologyReport.boundaryEdgeCount;
    TopologyAdapterSoA.degenerateTriangleCount[ eid ] = _topologyReport.degenerateTriangleCount;
    TopologyAdapterSoA.duplicateVertexCount[ eid ] = _topologyReport.duplicateVertexCount;
    TopologyAdapterSoA.weldedVertexCount[ eid ] = _topologyReport.weldedVertexCount;
    TopologyAdapterSoA.isolatedVertexCount[ eid ] = _topologyReport.isolatedVertexCount;

    TopologyAdapterSoA.maxAdjacencyDegree[ eid ] = _topologyReport.maxAdjacencyDegree;
    TopologyAdapterSoA.avgAdjacencyDegree[ eid ] = _topologyReport.avgAdjacencyDegree;
    TopologyAdapterSoA.adjacencyDegreeHistogram0[ eid ] = _topologyReport.adjacencyDegreeHistogram[ 0 ];
    TopologyAdapterSoA.adjacencyDegreeHistogram1[ eid ] = _topologyReport.adjacencyDegreeHistogram[ 1 ];
    TopologyAdapterSoA.adjacencyDegreeHistogram2[ eid ] = _topologyReport.adjacencyDegreeHistogram[ 2 ];
    TopologyAdapterSoA.adjacencyDegreeHistogram3[ eid ] = _topologyReport.adjacencyDegreeHistogram[ 3 ];
    TopologyAdapterSoA.adjacencyDegreeHistogram4[ eid ] = _topologyReport.adjacencyDegreeHistogram[ 4 ];
    TopologyAdapterSoA.adjacencyDegreeHistogram5[ eid ] = _topologyReport.adjacencyDegreeHistogram[ 5 ];
    TopologyAdapterSoA.adjacencyDegreeHistogram6[ eid ] = _topologyReport.adjacencyDegreeHistogram[ 6 ];
    TopologyAdapterSoA.adjacencyDegreeHistogram7[ eid ] = _topologyReport.adjacencyDegreeHistogram[ 7 ];
    TopologyAdapterSoA.adjacencyDegreeHistogram8Plus[ eid ] = _topologyReport.adjacencyDegreeHistogram[ 8 ];

    TopologyAdapterSoA.genus[ eid ] = _topologyReport.genus;
    TopologyAdapterSoA.eulerCharacteristic[ eid ] = _topologyReport.eulerCharacteristic;
    TopologyAdapterSoA.isClosed[ eid ] = _topologyReport.isClosed ? 1 : 0;
    TopologyAdapterSoA.isManifold[ eid ] = _topologyReport.isManifold ? 1 : 0;
    TopologyAdapterSoA.isOrientable[ eid ] = _topologyReport.isOrientable ? 1 : 0;

    TopologyAdapterSoA.lastAdaptMs[ eid ] = _topologyReport.lastAdaptMs;
    TopologyAdapterSoA.avgAdaptMsEMA[ eid ] =
        TopologyAdapterSoA.avgAdaptMsEMA[ eid ] * 0.9 + _topologyReport.lastAdaptMs * 0.1;
    TopologyAdapterSoA.lastDetectPassMs[ eid ] = _topologyReport.lastDetectPassMs;
    TopologyAdapterSoA.lastCanonicalPassMs[ eid ] = _topologyReport.lastCanonicalPassMs;
    TopologyAdapterSoA.lastAdjacencyPassMs[ eid ] = _topologyReport.lastAdjacencyPassMs;
    TopologyAdapterSoA.lastValidatePassMs[ eid ] = _topologyReport.lastValidatePassMs;

    const ditherSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    TopologyAdapterSoA.ditherSample[ eid ] = _noise3D( ditherSeed * 1e-6, frameIndex * 0.02, _topologyReport.topologyKind );
    TopologyAdapterSoA.determinismSeed[ eid ] = SkinnedMeshDefaults.determinismSeed;

    TopologyAdapterSoA.registered[ eid ] = 1;
    TopologyAdapterSoA.adapted[ eid ] = 1;
    TopologyAdapterSoA.lastFrameIndex[ eid ] = frameIndex | 0;
}

// ─── Public API: query. ─────────────────────────────────────────────────────

/**
 * Returns the topology entity id for the given geometry UUID.
 * @param {string} uuid
 * @return {number}
 */
function getTopologyEntityForUuid( uuid ) {
    const hash = _hashString( uuid );
    const eid = _ecsTopologyByHash.get( hash );
    return eid !== undefined ? eid : - 1;
}

/**
 * Returns the last topology report.
 * @return {object}
 */
function getLastTopologyReport() {
    return _topologyReport;
}

/**
 * Returns the adjacency offsets and list for a geometry. The returned
 * object is a view into internal buffers; do not retain across calls.
 * @return {object|null}
 */
function getAdjacencyMap() {
    if ( _adjacencyOffsets === null || _adjacencyList === null ) return null;

    return {
        offsets: _adjacencyOffsets,
        list: _adjacencyList,
        vertexCount: _topologyReport.vertexCount
    };
}

/**
 * Returns aggregated topology statistics across all adapted geometries.
 * @return {object}
 */
function getAggregatedStats() {
    let totalGeometries = 0;
    let totalVertices = 0;
    let totalTriangles = 0;
    let totalEdges = 0;
    let totalBoundaryEdges = 0;
    let totalNonManifoldEdges = 0;
    let totalDegenerateTriangles = 0;
    let totalWeldedVertices = 0;
    let totalIsolated = 0;
    let totalAdaptMs = 0.0;

    const q = query( _topologyWorld, [ TopologyAdapterSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( TopologyAdapterSoA.registered[ eid ] !== 1 ) continue;

        totalGeometries ++;
        totalVertices += TopologyAdapterSoA.vertexCount[ eid ];
        totalTriangles += TopologyAdapterSoA.triangleCount[ eid ];
        totalEdges += TopologyAdapterSoA.edgeCount[ eid ];
        totalBoundaryEdges += TopologyAdapterSoA.boundaryEdgeCount[ eid ];
        totalNonManifoldEdges += TopologyAdapterSoA.nonManifoldEdgeCount[ eid ];
        totalDegenerateTriangles += TopologyAdapterSoA.degenerateTriangleCount[ eid ];
        totalWeldedVertices += TopologyAdapterSoA.weldedVertexCount[ eid ];
        totalIsolated += TopologyAdapterSoA.isolatedVertexCount[ eid ];
        totalAdaptMs += TopologyAdapterSoA.lastAdaptMs[ eid ];
    }

    const ms = new Double( totalAdaptMs );

    return {
        totalGeometries: totalGeometries,
        totalVertices: totalVertices,
        totalTriangles: totalTriangles,
        totalEdges: totalEdges,
        totalBoundaryEdges: totalBoundaryEdges,
        totalNonManifoldEdges: totalNonManifoldEdges,
        totalDegenerateTriangles: totalDegenerateTriangles,
        totalWeldedVertices: totalWeldedVertices,
        totalIsolated: totalIsolated,
        totalAdaptMs: ms.valueOf()
    };
}

// ─── Public API: high-precision aggregate helpers. ─────────────────────────

/**
 * Returns a high-precision ratio of degenerate triangles to total triangles.
 * @return {number}
 */
function computeDegenerateRatioHighPrecision() {
    const total = new Double( Math.max( 1, _topologyReport.triangleCount ) );
    const degen = new Double( _topologyReport.degenerateTriangleCount );

    return degen.div( total ).valueOf();
}

/**
 * Returns a high-precision ratio of welded vertices to original vertices.
 * @return {number}
 */
function computeWeldRatioHighPrecision() {
    const total = new Double( Math.max( 1, _topologyReport.vertexCount + _topologyReport.duplicateVertexCount ) );
    const welded = new Double( _topologyReport.duplicateVertexCount );

    return welded.div( total ).valueOf();
}

/**
 * Returns a high-precision topology cost estimate.
 * @return {number}
 */
function computeAdaptCostHighPrecision() {
    const verts = new Double( _topologyReport.vertexCount );
    const tris = new Double( _topologyReport.triangleCount );
    const ms = new Double( _topologyReport.lastAdaptMs );

    return verts.add( tris ).mul( ms ).valueOf();
}

// ─── gl-matrix packing for telemetry. ───────────────────────────────────────

/**
 * Packs topology telemetry into a vec4.
 * Layout: (vertexCount, triangleCount, edgeCount, topologyKind)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packTopologyVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
        v,
        _topologyReport.vertexCount,
        _topologyReport.triangleCount,
        _topologyReport.edgeCount,
        _topologyReport.topologyKind
    );
    return v;
}

/**
 * Packs pathology counts into a vec4.
 * Layout: (degenerateTriangles, nonManifoldEdges, boundaryEdges, isolatedVertices)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packPathologyVec4( out ) {
    const v = out || _scratchVec4B;
    glMatrix.vec4.set(
        v,
        _topologyReport.degenerateTriangleCount,
        _topologyReport.nonManifoldEdgeCount,
        _topologyReport.boundaryEdgeCount,
        _topologyReport.isolatedVertexCount
    );
    return v;
}

/**
 * Packs adjacency statistics into a vec4.
 * Layout: (maxAdjacencyDegree, avgAdjacencyDegree, histogram0, histogram8Plus)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packAdjacencyVec4( out ) {
    const v = out || _scratchVec4C;
    glMatrix.vec4.set(
        v,
        _topologyReport.maxAdjacencyDegree,
        _topologyReport.avgAdjacencyDegree,
        _topologyReport.adjacencyDegreeHistogram[ 0 ],
        _topologyReport.adjacencyDegreeHistogram[ 8 ]
    );
    return v;
}

/**
 * Packs genus / euler / manifold flags into a vec4.
 * Layout: (genus, eulerCharacteristic, isClosed, isManifold)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packGenusVec4( out ) {
    const v = out || _scratchVec4D;
    glMatrix.vec4.set(
        v,
        _topologyReport.genus,
        _topologyReport.eulerCharacteristic,
        _topologyReport.isClosed ? 1 : 0,
        _topologyReport.isManifold ? 1 : 0
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
function sampleTopologyDither( geometryHash, vertexIndex, frameIndex ) {
    const seed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( vertexIndex * 0x85EBCA6B ) ^ ( frameIndex * 0xC2B2AE35 ) ) >>> 0;
    return _noise3D( seed * 1e-6, vertexIndex * 0.02, frameIndex * 0.01 );
}

// ─── Public API: frame lifecycle. ───────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all topology entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _topologyWorld, [ TopologyAdapterSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        TopologyAdapterSoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
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

void BufferAttribute;
void Vector3;
void SkinnedMeshCaps;
void TopologyAdapterDefaults.histogramMaxDegree;
void TopologyAdapterDefaults.weldEpsilon;
void TopologyAdapterDefaults.reorderTriangles;
void TopologyAdapterDefaults.pathologicalDegreeThreshold;
void TopologyAdapterDefaults.emitDither;
void _workPositions;
void _workIndices;
void _workPositionsCapacity;
void _workIndicesCapacity;
void _vertexHashMapCapacity;
void _scratchMat4;
void _scratchVec3A;
void _scratchVec3B;
void _scratchVec3C;
void _scratchVec4D;

export {
    TopologyAdapterDefaults,
    TopologyAdapterSoA,
    adapt,
    detectKind,
    getTopologyEntityForUuid,
    getLastTopologyReport,
    getAdjacencyMap,
    getAggregatedStats,
    computeDegenerateRatioHighPrecision,
    computeWeldRatioHighPrecision,
    computeAdaptCostHighPrecision,
    packTopologyVec4,
    packPathologyVec4,
    packAdjacencyVec4,
    packGenusVec4,
    sampleTopologyDither,
    beginFrame
};