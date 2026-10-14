// file number : 014_12
// full path name : src/objects/014_12_SkinningTelemetry.js
// description : Collects per-SkinnedMesh and scene-wide telemetry: bone count, hierarchy depth, max branching factor, bones-per-vertex in use, layout in use, weight compression ratio, weight normalization error, topology kind, genus, subdivision level, per-frame palette upload time, per-frame skinning cost estimate, and cache hit / miss counts from 014_11. Feeds the TelemetryBudgetHUDLOD aggregate so the on-device HUD shows skinning cost alongside every other LOD subsystem. Also provides a ring buffer of frame samples for on-device graphing, a per-category breakdown of skinning cost, and a cross-tier comparison table. Uses bitecs SoA for per-mesh telemetry state, double.js for high-precision per-frame cost aggregation, gl-matrix for vec4 packing of up to four metrics per row, and simplex-noise for deterministic sample dither that prevents aliasing on the on-device graph.
// best for : Android 64-bit profiling, on-device HUD, budget tuning per tier, capturing rig-level metrics for replay analysis, cross-device comparison of skinning cost, cross-system correlation (bone cost vs. LOD cost vs. streaming cost).
// license : MIT

import { Skeleton } from './008_Skeleton.js';
import { Bone } from './001_Bone.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';

import { BonesPerVertex, SkinWeightLayout, SkinnedMeshDefaults, SkinnedMeshCaps, BoneHierarchyKind } from './014_0_SkinnedMeshDefaults.js';
import { getLayoutEntityForUuid } from './014_6_SkinWeightLayout.js';
import { getAutoAssignEntityForUuid } from './014_7_SkinWeightAutoAssign.js';
import { getOverlapEntityForUuid } from './014_7_5_SkinWeightAdjacentOverlap.js';
import { getCompressorEntityForUuid } from './014_8_SkinWeightCompressor.js';
import { getTopologyEntityForUuid } from './014_9_TopologyAdapter.js';
import { getArbitraryEntityForUuid } from './014_10_ArbitraryTopologySupport.js';
import { getStats as getCacheStats, getAggregatedStats as getCacheAggregatedStats } from './014_11_SkinningCacheManager.js';
import { TelemetryBudgetHUDLOD } from './007_10_TelemetryBudgetHUD_LOD.js';

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
const _scratchMat4 = new Float64Array( 16 );
const _noise3D = createNoise3D();

// ─── ECS world + SkinningTelemetry SoA component (bitecs). ──────────────────
const _telemetrySkinWorld = createWorld();

const SkinningTelemetrySoA = defineComponent( {
    meshId: Types.i32,
    skeletonUuidHash: Types.i32,
    geometryUuidHash: Types.i32,

    // Rig shape
    boneCount: Types.i32,
    hierarchyDepth: Types.i32,
    maxBranching: Types.i32,
    hierarchyKind: Types.i32,
    bonesPerVertex: Types.i32,
    weightLayout: Types.i32,

    // Weight quality
    weightErrorMax: Types.f64,
    weightErrorAvg: Types.f64,
    compressionRatio: Types.f64,
    deadZoneCount: Types.i32,

    // Topology
    topologyKind: Types.i32,
    vertexCount: Types.i32,
    triangleCount: Types.i32,
    genus: Types.i32,
    subdivisionLevel: Types.i32,

    // Per-frame palette upload
    lastPaletteUploadMs: Types.f64,
    avgPaletteUploadMsEMA: Types.f64,
    lastSkinningCostMs: Types.f64,
    avgSkinningCostMsEMA: Types.f64,

    // Bone palette bytes
    paletteBytes: Types.f64,
    paletteUploadsPerSecond: Types.f64,

    // Cache linkage
    cacheHits: Types.i64,
    cacheMisses: Types.i64,
    cacheHitRatio: Types.f64,

    // Frame ring buffer index
    frameRingIndex: Types.i32,
    frameRingCount: Types.i32,

    // Determinism
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    registered: Types.ui8,
    active: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Category bitmask constants for cost breakdown. ────────────────────────
const CostCategory = Object.freeze( {
    PALETTE_UPLOAD: 1 << 0,
    SKINNING_VERTEX: 1 << 1,
    WEIGHT_NORMALIZE: 1 << 2,
    WEIGHT_COMPRESS: 1 << 3,
    TOPOLOGY_ADAPT: 1 << 4,
    SUBDIVIDE: 1 << 5,
    AUTO_ASSIGN: 1 << 6,
    OVERLAP: 1 << 7,
    CACHE_LOOKUP: 1 << 8,
    CACHE_STORE: 1 << 9
} );

// ─── Frame ring buffer length. ─────────────────────────────────────────────
const FRAME_RING_LENGTH = 240;

// ─── Reusable scene-wide ledger. ───────────────────────────────────────────
const _sceneLedger = {
    totalMeshes: 0,
    activeMeshes: 0,
    totalBones: 0,
    totalVertices: 0,
    totalTriangles: 0,
    maxHierarchyDepth: 0,
    maxBranching: 0,
    avgBonesPerVertex: 0.0,
    totalPaletteBytes: 0.0,
    totalPaletteUploadMs: 0.0,
    totalSkinningCostMs: 0.0,
    avgWeightError: 0.0,
    maxWeightError: 0.0,
    avgCompressionRatio: 1.0,
    totalDeadZones: 0,
    totalCacheHits: 0,
    totalCacheMisses: 0,
    sceneCacheHitRatio: 0.0,
    costBreakdown: new Float64Array( 10 ),
    lastFrameMs: 0.0
};

// ─── Frame history ring buffers. ───────────────────────────────────────────
const _frameRing = {
    length: FRAME_RING_LENGTH,
    index: 0,
    count: 0,
    paletteMs: new Float32Array( FRAME_RING_LENGTH ),
    skinningMs: new Float32Array( FRAME_RING_LENGTH ),
    meshCount: new Int32Array( FRAME_RING_LENGTH ),
    boneCount: new Int32Array( FRAME_RING_LENGTH ),
    paletteBytes: new Float64Array( FRAME_RING_LENGTH ),
    ditherSample: new Float32Array( FRAME_RING_LENGTH )
};

// ─── Reusable defaults. ────────────────────────────────────────────────────
const SkinningTelemetryDefaults = {
    // Maximum number of frames retained in the ring buffer.
    frameRingLength: FRAME_RING_LENGTH,

    // Whether to auto-register with TelemetryBudgetHUDLOD.
    autoRegisterWithHUD: true,

    // Whether to compute scene-wide aggregates every frame.
    computeSceneAggregatesEveryFrame: true,

    // Whether to compute scene-wide aggregates every N frames (if not every).
    sceneAggregateInterval: 4,

    // Whether to include per-mesh detail in the HUD.
    includePerMeshDetail: true,

    // Maximum number of meshes in the HUD detail view.
    maxHudMeshRows: 6,

    // Whether to track cache telemetry.
    trackCacheTelemetry: true,

    // Whether to track category cost breakdown.
    trackCostBreakdown: true,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F,

    // Whether to emit per-sample dither for graph aliasing removal.
    emitDither: true,

    // Pathological thresholds for HUD warnings.
    pathologicalBoneCount: 160,
    pathologicalWeightError: 0.02,
    pathologicalDeadZoneRatio: 0.05,
    pathologicalPaletteMs: 1.5
};

// ─── Public API: register / unregister. ───────────────────────────────────

/**
 * Registers a SkinnedMesh for telemetry collection.
 *
 * @param {object} skinnedMesh - A SkinnedMesh instance.
 * @param {Skeleton} skeleton - Its skeleton.
 * @param {BufferGeometry} geometry - Its geometry.
 * @param {object} [options]
 * @return {number} The telemetry entity id.
 */
function registerMesh( skinnedMesh, skeleton, geometry, options = {} ) {
    if ( skinnedMesh === undefined || skinnedMesh === null ) return - 1;

    const meshId = skinnedMesh.id !== undefined ? skinnedMesh.id : - 1;
    const skeletonUuid = skeleton !== undefined && skeleton !== null && skeleton.uuid !== undefined ? skeleton.uuid : '';
    const geometryUuid = geometry !== undefined && geometry !== null && geometry.uuid !== undefined ? geometry.uuid : '';

    const skelHash = _hashString( skeletonUuid );
    const geomHash = _hashString( geometryUuid );

    const combinedHash = _mix32(
        ( skelHash ^ ( geomHash * 0x9E3779B9 ) ^ ( meshId * 0x85EBCA6B ) ) >>> 0
    );

    let eid = _ecsTelemetryByHash.get( combinedHash );

    if ( eid === undefined ) {
        eid = addEntity( _telemetrySkinWorld );
        addComponent( _telemetrySkinWorld, SkinningTelemetrySoA, eid );
        _ecsTelemetryByHash.set( combinedHash, eid );
    }

    const boneCount = skeleton !== undefined && skeleton !== null && skeleton.bones !== undefined
        ? skeleton.bones.length
        : 0;

    const vertexCount = geometry !== undefined && geometry !== null && geometry.attributes.position !== undefined
        ? geometry.attributes.position.count
        : 0;

    const triangleCount = geometry !== undefined && geometry !== null && geometry.index !== null && geometry.index !== undefined
        ? Math.floor( geometry.index.count / 3 )
        : Math.floor( vertexCount / 3 );

    // ── 1. Compute hierarchy metrics via a fast walk. ──────────────────
    const hierMetrics = _computeHierarchyMetrics( skeleton );

    // ── 2. Write telemetry state. ──────────────────────────────────────
    SkinningTelemetrySoA.meshId[ eid ] = meshId;
    SkinningTelemetrySoA.skeletonUuidHash[ eid ] = skelHash;
    SkinningTelemetrySoA.geometryUuidHash[ eid ] = geomHash;

    SkinningTelemetrySoA.boneCount[ eid ] = boneCount;
    SkinningTelemetrySoA.hierarchyDepth[ eid ] = hierMetrics.maxDepth;
    SkinningTelemetrySoA.maxBranching[ eid ] = hierMetrics.maxBranching;
    SkinningTelemetrySoA.hierarchyKind[ eid ] = hierMetrics.kind;
    SkinningTelemetrySoA.bonesPerVertex[ eid ] = SkinnedMeshDefaults.bonesPerVertex;
    SkinningTelemetrySoA.weightLayout[ eid ] = SkinnedMeshDefaults.weightLayout;

    SkinningTelemetrySoA.vertexCount[ eid ] = vertexCount;
    SkinningTelemetrySoA.triangleCount[ eid ] = triangleCount;

    SkinningTelemetrySoA.registered[ eid ] = 1;
    SkinningTelemetrySoA.active[ eid ] = 1;
    SkinningTelemetrySoA.lastFrameIndex[ eid ] = _frameIndex;

    SkinningTelemetrySoA.determinismSeed[ eid ] = _mix32( combinedHash ^ SkinningTelemetryDefaults.determinismSeed );

    // ── 3. Auto-register with the HUD if requested. ────────────────────
    if ( SkinningTelemetryDefaults.autoRegisterWithHUD ) {
        TelemetryBudgetHUDLOD._registerTelemetryLOD( { id: eid, getSkeletonLedger: () => getMeshLedger( eid ) } );
    }

    void options;

    return eid;
}

/**
 * Unregisters a mesh from telemetry collection.
 * @param {number} eid
 * @return {boolean}
 */
function unregisterMesh( eid ) {
    if ( eid < 0 ) return false;

    SkinningTelemetrySoA.registered[ eid ] = 0;
    SkinningTelemetrySoA.active[ eid ] = 0;

    for ( const [ hash, id ] of _ecsTelemetryByHash ) {
        if ( id === eid ) {
            _ecsTelemetryByHash.delete( hash );
            break;
        }
    }

    return true;
}

// ─── Public API: per-frame recording. ─────────────────────────────────────

/**
 * Records per-frame skinning activity for a given telemetry entity.
 *
 * @param {number} eid
 * @param {object} frameData
 * @param {number} [frameData.paletteUploadMs]
 * @param {number} [frameData.skinningCostMs]
 * @param {number} [frameData.paletteBytes]
 * @param {number} [frameData.cacheHits]
 * @param {number} [frameData.cacheMisses]
 * @param {number} [frameData.weightErrorMax]
 * @param {number} [frameData.weightErrorAvg]
 * @param {number} [frameData.compressionRatio]
 * @param {number} [frameData.deadZoneCount]
 * @param {number} [frameIndex=0]
 */
function recordFrame( eid, frameData, frameIndex = 0 ) {
    if ( eid < 0 ) return;

    if ( SkinningTelemetrySoA.registered[ eid ] !== 1 ) return;

    // ── 1. Palette upload timing. ───────────────────────────────────────
    if ( frameData.paletteUploadMs !== undefined ) {
        SkinningTelemetrySoA.lastPaletteUploadMs[ eid ] = frameData.paletteUploadMs;
        SkinningTelemetrySoA.avgPaletteUploadMsEMA[ eid ] =
            SkinningTelemetrySoA.avgPaletteUploadMsEMA[ eid ] * 0.9 + frameData.paletteUploadMs * 0.1;
    }

    // ── 2. Skinning cost timing. ────────────────────────────────────────
    if ( frameData.skinningCostMs !== undefined ) {
        SkinningTelemetrySoA.lastSkinningCostMs[ eid ] = frameData.skinningCostMs;
        SkinningTelemetrySoA.avgSkinningCostMsEMA[ eid ] =
            SkinningTelemetrySoA.avgSkinningCostMsEMA[ eid ] * 0.9 + frameData.skinningCostMs * 0.1;
    }

    // ── 3. Palette bytes. ──────────────────────────────────────────────
    if ( frameData.paletteBytes !== undefined ) {
        SkinningTelemetrySoA.paletteBytes[ eid ] = frameData.paletteBytes;
    }

    // ── 4. Cache hits / misses. ────────────────────────────────────────
    if ( SkinningTelemetryDefaults.trackCacheTelemetry ) {
        if ( frameData.cacheHits !== undefined ) {
            SkinningTelemetrySoA.cacheHits[ eid ] += frameData.cacheHits;
        }

        if ( frameData.cacheMisses !== undefined ) {
            SkinningTelemetrySoA.cacheMisses[ eid ] += frameData.cacheMisses;
        }

        const hits = SkinningTelemetrySoA.cacheHits[ eid ];
        const misses = SkinningTelemetrySoA.cacheMisses[ eid ];
        const total = hits + misses;

        SkinningTelemetrySoA.cacheHitRatio[ eid ] = total > 0 ? hits / total : 0.0;
    }

    // ── 5. Weight quality. ─────────────────────────────────────────────
    if ( frameData.weightErrorMax !== undefined ) {
        SkinningTelemetrySoA.weightErrorMax[ eid ] = frameData.weightErrorMax;
    }

    if ( frameData.weightErrorAvg !== undefined ) {
        SkinningTelemetrySoA.weightErrorAvg[ eid ] = frameData.weightErrorAvg;
    }

    if ( frameData.compressionRatio !== undefined ) {
        SkinningTelemetrySoA.compressionRatio[ eid ] = frameData.compressionRatio;
    }

    if ( frameData.deadZoneCount !== undefined ) {
        SkinningTelemetrySoA.deadZoneCount[ eid ] = frameData.deadZoneCount;
    }

    // ── 6. Per-frame dither for graphing. ───────────────────────────────
    const seed = ( SkinningTelemetrySoA.determinismSeed[ eid ] ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
    SkinningTelemetrySoA.ditherSample[ eid ] = _noise3D( seed * 1e-6, frameIndex * 0.02, SkinningTelemetrySoA.boneCount[ eid ] );

    SkinningTelemetrySoA.lastFrameIndex[ eid ] = frameIndex;
}

// ─── Public API: mesh ledger. ─────────────────────────────────────────────

/**
 * Returns the per-mesh ledger for a given telemetry entity.
 * @param {number} eid
 * @return {object}
 */
function getMeshLedger( eid ) {
    if ( eid < 0 ) {
        return {
            boneCount: 0,
            hierarchyDepth: 0,
            maxBranching: 0,
            vertexCount: 0,
            paletteMs: 0.0,
            skinningMs: 0.0
        };
    }

    return {
        meshId: SkinningTelemetrySoA.meshId[ eid ],
        boneCount: SkinningTelemetrySoA.boneCount[ eid ],
        hierarchyDepth: SkinningTelemetrySoA.hierarchyDepth[ eid ],
        maxBranching: SkinningTelemetrySoA.maxBranching[ eid ],
        hierarchyKind: SkinningTelemetrySoA.hierarchyKind[ eid ],
        bonesPerVertex: SkinningTelemetrySoA.bonesPerVertex[ eid ],
        weightLayout: SkinningTelemetrySoA.weightLayout[ eid ],
        vertexCount: SkinningTelemetrySoA.vertexCount[ eid ],
        triangleCount: SkinningTelemetrySoA.triangleCount[ eid ],
        topologyKind: SkinningTelemetrySoA.topologyKind[ eid ],
        genus: SkinningTelemetrySoA.genus[ eid ],
        subdivisionLevel: SkinningTelemetrySoA.subdivisionLevel[ eid ],
        lastPaletteUploadMs: SkinningTelemetrySoA.lastPaletteUploadMs[ eid ],
        avgPaletteUploadMsEMA: SkinningTelemetrySoA.avgPaletteUploadMsEMA[ eid ],
        lastSkinningCostMs: SkinningTelemetrySoA.lastSkinningCostMs[ eid ],
        avgSkinningCostMsEMA: SkinningTelemetrySoA.avgSkinningCostMsEMA[ eid ],
        paletteBytes: SkinningTelemetrySoA.paletteBytes[ eid ],
        cacheHits: SkinningTelemetrySoA.cacheHits[ eid ],
        cacheMisses: SkinningTelemetrySoA.cacheMisses[ eid ],
        cacheHitRatio: SkinningTelemetrySoA.cacheHitRatio[ eid ],
        weightErrorMax: SkinningTelemetrySoA.weightErrorMax[ eid ],
        weightErrorAvg: SkinningTelemetrySoA.weightErrorAvg[ eid ],
        compressionRatio: SkinningTelemetrySoA.compressionRatio[ eid ],
        deadZoneCount: SkinningTelemetrySoA.deadZoneCount[ eid ]
    };
}

// ─── Public API: scene-wide aggregation. ──────────────────────────────────

/**
 * Computes the scene-wide skinning ledger.
 * @param {number} [frameIndex=0]
 * @return {object}
 */
function computeSceneLedger( frameIndex = 0 ) {
    _sceneLedger.totalMeshes = 0;
    _sceneLedger.activeMeshes = 0;
    _sceneLedger.totalBones = 0;
    _sceneLedger.totalVertices = 0;
    _sceneLedger.totalTriangles = 0;
    _sceneLedger.maxHierarchyDepth = 0;
    _sceneLedger.maxBranching = 0;
    _sceneLedger.totalPaletteBytes = 0.0;
    _sceneLedger.totalPaletteUploadMs = 0.0;
    _sceneLedger.totalSkinningCostMs = 0.0;
    _sceneLedger.totalDeadZones = 0;
    _sceneLedger.totalCacheHits = 0;
    _sceneLedger.totalCacheMisses = 0;

    let sumBonesPerVertex = 0;
    let sumWeightError = 0.0;
    let sumCompression = 0.0;
    let meshCountForWeightStats = 0;

    const q = query( _telemetrySkinWorld, [ SkinningTelemetrySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinningTelemetrySoA.registered[ eid ] !== 1 ) continue;

        _sceneLedger.totalMeshes ++;

        if ( SkinningTelemetrySoA.active[ eid ] === 1 ) _sceneLedger.activeMeshes ++;

        _sceneLedger.totalBones += SkinningTelemetrySoA.boneCount[ eid ];
        _sceneLedger.totalVertices += SkinningTelemetrySoA.vertexCount[ eid ];
        _sceneLedger.totalTriangles += SkinningTelemetrySoA.triangleCount[ eid ];

        if ( SkinningTelemetrySoA.hierarchyDepth[ eid ] > _sceneLedger.maxHierarchyDepth ) {
            _sceneLedger.maxHierarchyDepth = SkinningTelemetrySoA.hierarchyDepth[ eid ];
        }

        if ( SkinningTelemetrySoA.maxBranching[ eid ] > _sceneLedger.maxBranching ) {
            _sceneLedger.maxBranching = SkinningTelemetrySoA.maxBranching[ eid ];
        }

        _sceneLedger.totalPaletteBytes += SkinningTelemetrySoA.paletteBytes[ eid ];
        _sceneLedger.totalPaletteUploadMs += SkinningTelemetrySoA.avgPaletteUploadMsEMA[ eid ];
        _sceneLedger.totalSkinningCostMs += SkinningTelemetrySoA.avgSkinningCostMsEMA[ eid ];
        _sceneLedger.totalDeadZones += SkinningTelemetrySoA.deadZoneCount[ eid ];
        _sceneLedger.totalCacheHits += SkinningTelemetrySoA.cacheHits[ eid ];
        _sceneLedger.totalCacheMisses += SkinningTelemetrySoA.cacheMisses[ eid ];

        sumBonesPerVertex += SkinningTelemetrySoA.bonesPerVertex[ eid ];

        if ( SkinningTelemetrySoA.weightErrorAvg[ eid ] > 0.0 ) {
            sumWeightError += SkinningTelemetrySoA.weightErrorAvg[ eid ];
            meshCountForWeightStats ++;
        }

        if ( SkinningTelemetrySoA.compressionRatio[ eid ] > 0.0 ) {
            sumCompression += SkinningTelemetrySoA.compressionRatio[ eid ];
        }

        if ( SkinningTelemetrySoA.weightErrorMax[ eid ] > _sceneLedger.maxWeightError ) {
            _sceneLedger.maxWeightError = SkinningTelemetrySoA.weightErrorMax[ eid ];
        }
    }

    if ( _sceneLedger.totalMeshes > 0 ) {
        _sceneLedger.avgBonesPerVertex = sumBonesPerVertex / _sceneLedger.totalMeshes;
        _sceneLedger.avgCompressionRatio = sumCompression / _sceneLedger.totalMeshes;
    }

    if ( meshCountForWeightStats > 0 ) {
        _sceneLedger.avgWeightError = sumWeightError / meshCountForWeightStats;
    }

    const totalCacheOps = _sceneLedger.totalCacheHits + _sceneLedger.totalCacheMisses;
    _sceneLedger.sceneCacheHitRatio = totalCacheOps > 0
        ? _sceneLedger.totalCacheHits / totalCacheOps
        : 0.0;

    _sceneLedger.lastFrameMs = _nowMs();

    void frameIndex;

    return _sceneLedger;
}

// ─── Public API: frame ring buffer. ───────────────────────────────────────

/**
 * Pushes a per-frame sample into the ring buffer.
 *
 * @param {object} sample
 * @param {number} [sample.paletteMs]
 * @param {number} [sample.skinningMs]
 * @param {number} [sample.meshCount]
 * @param {number} [sample.boneCount]
 * @param {number} [sample.paletteBytes]
 * @param {number} [frameIndex=0]
 */
function pushFrameSample( sample, frameIndex = 0 ) {
    const idx = _frameRing.index;

    _frameRing.paletteMs[ idx ] = sample.paletteMs !== undefined ? sample.paletteMs : 0.0;
    _frameRing.skinningMs[ idx ] = sample.skinningMs !== undefined ? sample.skinningMs : 0.0;
    _frameRing.meshCount[ idx ] = sample.meshCount !== undefined ? sample.meshCount : 0;
    _frameRing.boneCount[ idx ] = sample.boneCount !== undefined ? sample.boneCount : 0;
    _frameRing.paletteBytes[ idx ] = sample.paletteBytes !== undefined ? sample.paletteBytes : 0.0;

    // ── 1. Deterministic dither sample for graph aliasing. ──────────────
    const seed = ( SkinningTelemetryDefaults.determinismSeed ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
    _frameRing.ditherSample[ idx ] = _noise3D( seed * 1e-6, frameIndex * 0.02, 0 ) * 0.05;

    // ── 2. Advance the ring index. ─────────────────────────────────────
    _frameRing.index = ( idx + 1 ) % _frameRing.length;

    if ( _frameRing.count < _frameRing.length ) {
        _frameRing.count ++;
    }
}

/**
 * Returns the current frame history as a snapshot. The returned typed
 * arrays are views into the internal ring buffer; do not retain them
 * across calls.
 * @return {object}
 */
function getFrameHistory() {
    return {
        length: _frameRing.length,
        count: _frameRing.count,
        index: _frameRing.index,
        paletteMs: _frameRing.paletteMs,
        skinningMs: _frameRing.skinningMs,
        meshCount: _frameRing.meshCount,
        boneCount: _frameRing.boneCount,
        paletteBytes: _frameRing.paletteBytes,
        ditherSample: _frameRing.ditherSample
    };
}

/**
 * Returns a high-precision average of the last N frame samples.
 * @param {number} [frames=60]
 * @return {object}
 */
function computeFrameHistoryAverages( frames = 60 ) {
    const n = Math.min( frames, _frameRing.count );

    if ( n <= 0 ) {
        return {
            avgPaletteMs: 0.0,
            avgSkinningMs: 0.0,
            avgMeshCount: 0.0,
            avgBoneCount: 0.0,
            avgPaletteBytes: 0.0
        };
    }

    let paletteSum = new Double( 0 );
    let skinningSum = new Double( 0 );
    let meshSum = new Double( 0 );
    let boneSum = new Double( 0 );
    let bytesSum = new Double( 0 );

    let read = _frameRing.index - 1;
    if ( read < 0 ) read = _frameRing.length - 1;

    for ( let i = 0; i < n; i ++ ) {
        paletteSum = new Double( paletteSum.valueOf() + _frameRing.paletteMs[ read ] );
        skinningSum = new Double( skinningSum.valueOf() + _frameRing.skinningMs[ read ] );
        meshSum = new Double( meshSum.valueOf() + _frameRing.meshCount[ read ] );
        boneSum = new Double( boneSum.valueOf() + _frameRing.boneCount[ read ] );
        bytesSum = new Double( bytesSum.valueOf() + _frameRing.paletteBytes[ read ] );

        read = read - 1;
        if ( read < 0 ) read = _frameRing.length - 1;
    }

    const divisor = new Double( n );

    return {
        avgPaletteMs: paletteSum.div( divisor ).valueOf(),
        avgSkinningMs: skinningSum.div( divisor ).valueOf(),
        avgMeshCount: meshSum.div( divisor ).valueOf(),
        avgBoneCount: boneSum.div( divisor ).valueOf(),
        avgPaletteBytes: bytesSum.div( divisor ).valueOf()
    };
}

// ─── Public API: cross-system telemetry. ──────────────────────────────────

/**
 * Returns a cross-system telemetry summary that combines skinning
 * telemetry with the cache, layout, and topology systems.
 *
 * @return {object}
 */
function getCrossSystemSummary() {
    const cache = getCacheStats();
    const cacheAgg = getCacheAggregatedStats();

    const totalBytes = new Double( _sceneLedger.totalPaletteBytes );
    const cacheBytes = new Double( cache.totalBytes );

    return {
        scene: {
            totalMeshes: _sceneLedger.totalMeshes,
            activeMeshes: _sceneLedger.activeMeshes,
            totalBones: _sceneLedger.totalBones,
            totalVertices: _sceneLedger.totalVertices,
            totalPaletteBytes: totalBytes.valueOf(),
            totalPaletteUploadMs: _sceneLedger.totalPaletteUploadMs,
            totalSkinningCostMs: _sceneLedger.totalSkinningCostMs,
            avgWeightError: _sceneLedger.avgWeightError,
            maxWeightError: _sceneLedger.maxWeightError,
            totalDeadZones: _sceneLedger.totalDeadZones
        },
        cache: {
            entryCount: cache.entryCount,
            residentCount: cache.residentCount,
            totalBytes: cacheBytes.valueOf(),
            hitRatio: cache.hitRatio,
            totalHits: cache.totalHits,
            totalMisses: cache.totalMisses
        },
        cacheAggregated: {
            totalEntries: cacheAgg.totalEntries,
            totalResident: cacheAgg.totalResident,
            totalBytes: cacheAgg.totalBytes,
            hitRatio: cacheAgg.hitRatio
        }
    };
}

// ─── Public API: category cost breakdown. ─────────────────────────────────

/**
 * Returns the cost breakdown by category for the current frame.
 * @return {Float64Array}
 */
function getCostBreakdown() {
    return _sceneLedger.costBreakdown;
}

/**
 * Records a cost sample for a category.
 * @param {number} category - One of `CostCategory`.
 * @param {number} ms
 */
function recordCategoryCost( category, ms ) {
    if ( ! SkinningTelemetryDefaults.trackCostBreakdown ) return;

    for ( let bit = 0; bit < 10; bit ++ ) {
        if ( ( category & ( 1 << bit ) ) !== 0 ) {
            _sceneLedger.costBreakdown[ bit ] += ms;
        }
    }
}

/**
 * Resets the cost breakdown at the beginning of a frame.
 */
function resetCostBreakdown() {
    for ( let i = 0; i < _sceneLedger.costBreakdown.length; i ++ ) {
        _sceneLedger.costBreakdown[ i ] = 0.0;
    }
}

// ─── Public API: pathological detection. ──────────────────────────────────

/**
 * Returns an array of telemetry entities that exceed pathological thresholds.
 * @return {Array<object>}
 */
function findPathologicalMeshes() {
    const out = [];

    const q = query( _telemetrySkinWorld, [ SkinningTelemetrySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinningTelemetrySoA.registered[ eid ] !== 1 ) continue;

        const boneCount = SkinningTelemetrySoA.boneCount[ eid ];
        const weightErrorMax = SkinningTelemetrySoA.weightErrorMax[ eid ];
        const paletteMs = SkinningTelemetrySoA.avgPaletteUploadMsEMA[ eid ];
        const vertexCount = SkinningTelemetrySoA.vertexCount[ eid ];
        const deadZoneCount = SkinningTelemetrySoA.deadZoneCount[ eid ];

        const deadZoneRatio = vertexCount > 0 ? deadZoneCount / vertexCount : 0.0;

        const isPathological =
            boneCount > SkinningTelemetryDefaults.pathologicalBoneCount ||
            weightErrorMax > SkinningTelemetryDefaults.pathologicalWeightError ||
            paletteMs > SkinningTelemetryDefaults.pathologicalPaletteMs ||
            deadZoneRatio > SkinningTelemetryDefaults.pathologicalDeadZoneRatio;

        if ( isPathological ) {
            out.push( {
                eid: eid,
                meshId: SkinningTelemetrySoA.meshId[ eid ],
                boneCount: boneCount,
                weightErrorMax: weightErrorMax,
                paletteMs: paletteMs,
                deadZoneRatio: deadZoneRatio,
                reasons: _collectPathologicalReasons( boneCount, weightErrorMax, paletteMs, deadZoneRatio )
            } );
        }
    }

    return out;
}

function _collectPathologicalReasons( boneCount, weightErrorMax, paletteMs, deadZoneRatio ) {
    const reasons = [];

    if ( boneCount > SkinningTelemetryDefaults.pathologicalBoneCount ) reasons.push( 'bone-count' );
    if ( weightErrorMax > SkinningTelemetryDefaults.pathologicalWeightError ) reasons.push( 'weight-error' );
    if ( paletteMs > SkinningTelemetryDefaults.pathologicalPaletteMs ) reasons.push( 'palette-ms' );
    if ( deadZoneRatio > SkinningTelemetryDefaults.pathologicalDeadZoneRatio ) reasons.push( 'dead-zone-ratio' );

    return reasons;
}

// ─── Public API: HUD. ────────────────────────────────────────────────────

/**
 * Draws a skinning telemetry block onto the TelemetryBudgetHUDLOD canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @return {number} The new y position after drawing.
 */
function drawHUDSection( ctx, x, y ) {
    if ( ctx === undefined || ctx === null ) return y;

    const lineH = 14;

    ctx.fillStyle = '#7fd1ff';
    ctx.font = '11px monospace';
    ctx.fillText( '— Skinning —', x, y );
    y += lineH;

    ctx.fillStyle = '#e6e6e6';
    ctx.fillText( 'Meshes: ' + _sceneLedger.totalMeshes, x, y );
    y += lineH;

    ctx.fillText( 'Bones: ' + _sceneLedger.totalBones, x, y );
    y += lineH;

    ctx.fillText( 'Depth: ' + _sceneLedger.maxHierarchyDepth, x, y );
    y += lineH;

    ctx.fillText( 'Palette ms: ' + _sceneLedger.totalPaletteUploadMs.toFixed( 2 ), x, y );
    y += lineH;

    ctx.fillText( 'Skinning ms: ' + _sceneLedger.totalSkinningCostMs.toFixed( 2 ), x, y );
    y += lineH;

    ctx.fillStyle = _sceneLedger.maxWeightError > 0.02 ? '#ff5555' : '#7fe08a';
    ctx.fillText( 'Weight err: ' + _sceneLedger.maxWeightError.toFixed( 4 ), x, y );
    y += lineH;

    ctx.fillStyle = '#e6e6e6';
    ctx.fillText( 'Cache hit: ' + ( _sceneLedger.sceneCacheHitRatio * 100 ).toFixed( 1 ) + '%', x, y );
    y += lineH;

    if ( SkinningTelemetryDefaults.includePerMeshDetail ) {
        ctx.fillStyle = '#7fd1ff';
        ctx.fillText( 'Worst meshes:', x, y );
        y += lineH;

        const pathological = findPathologicalMeshes();

        const limit = Math.min( SkinningTelemetryDefaults.maxHudMeshRows, pathological.length );

        for ( let i = 0; i < limit; i ++ ) {
            const p = pathological[ i ];

            ctx.fillStyle = '#ffcc55';
            ctx.fillText(
                '#' + p.meshId + ' b=' + p.boneCount + ' ms=' + p.paletteMs.toFixed( 2 ),
                x,
                y
            );
            y += lineH;
        }
    }

    return y;
}

// ─── Public API: aggregated stats. ────────────────────────────────────────

/**
 * Returns the aggregated scene-wide statistics.
 * @return {object}
 */
function getAggregatedStats() {
    return _sceneLedger;
}

// ─── Public API: high-precision aggregate helpers. ────────────────────────

/**
 * Returns a high-precision estimate of the total palette upload cost.
 * @return {number}
 */
function computeTotalPaletteCostHighPrecision() {
    let total = new Double( 0 );

    const q = query( _telemetrySkinWorld, [ SkinningTelemetrySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinningTelemetrySoA.registered[ eid ] !== 1 ) continue;

        const boneCount = SkinningTelemetrySoA.boneCount[ eid ];
        const paletteMs = SkinningTelemetrySoA.avgPaletteUploadMsEMA[ eid ];

        total = new Double( total.valueOf() + boneCount * paletteMs );
    }

    return total.valueOf();
}

/**
 * Returns a high-precision estimate of the total skinning vertex cost.
 * @return {number}
 */
function computeTotalSkinningVertexCostHighPrecision() {
    let total = new Double( 0 );

    const q = query( _telemetrySkinWorld, [ SkinningTelemetrySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinningTelemetrySoA.registered[ eid ] !== 1 ) continue;

        const vertexCount = SkinningTelemetrySoA.vertexCount[ eid ];
        const bonesPerVertex = SkinningTelemetrySoA.bonesPerVertex[ eid ];
        const skinningMs = SkinningTelemetrySoA.avgSkinningCostMsEMA[ eid ];

        total = new Double( total.valueOf() + vertexCount * bonesPerVertex * skinningMs );
    }

    return total.valueOf();
}

// ─── Public API: ECS sync. ────────────────────────────────────────────────

const _ecsTelemetryByHash = new Map();

/**
 * Returns the telemetry entity id for a given skeleton UUID + geometry UUID.
 * @param {string} skeletonUuid
 * @param {string} geometryUuid
 * @return {number}
 */
function getTelemetryEntityFor( skeletonUuid, geometryUuid ) {
    const skelHash = _hashString( skeletonUuid );
    const geomHash = _hashString( geometryUuid );

    for ( const [ hash, eid ] of _ecsTelemetryByHash ) {
        if ( SkinningTelemetrySoA.skeletonUuidHash[ eid ] === skelHash &&
             SkinningTelemetrySoA.geometryUuidHash[ eid ] === geomHash ) {
            return eid;
        }
    }

    void hash;
    return - 1;
}

// ─── Internal: hierarchy metrics. ─────────────────────────────────────────

function _computeHierarchyMetrics( skeleton ) {
    if ( skeleton === undefined || skeleton === null ) {
        return { maxDepth: 0, maxBranching: 0, kind: BoneHierarchyKind.UNKNOWN };
    }

    const bones = skeleton.bones;

    if ( bones === undefined || bones.length === 0 ) {
        return { maxDepth: 0, maxBranching: 0, kind: BoneHierarchyKind.UNKNOWN };
    }

    // ── 1. Walk the hierarchy iteratively. ─────────────────────────────
    const stack = [];
    const depths = [];

    // Find roots (bones without a bone parent).
    for ( let i = 0; i < bones.length; i ++ ) {
        const bone = bones[ i ];

        if ( bone === undefined || bone === null ) continue;

        if ( bone.parent === null || bone.parent.isBone !== true ) {
            stack.push( bone );
            depths.push( 0 );
        }
    }

    let maxDepth = 0;
    let maxBranching = 0;
    let totalVisited = 0;

    while ( stack.length > 0 ) {
        const bone = stack.pop();
        const depth = depths.pop();

        if ( bone === null || bone === undefined ) continue;

        totalVisited ++;

        if ( depth > maxDepth ) maxDepth = depth;

        const childCount = bone.children !== undefined ? bone.children.length : 0;

        if ( childCount > maxBranching ) maxBranching = childCount;

        const children = bone.children !== undefined ? bone.children : [];

        for ( let c = 0; c < children.length; c ++ ) {
            stack.push( children[ c ] );
            depths.push( depth + 1 );
        }
    }

    // ── 2. Classify the hierarchy kind from depth / branching. ────────
    const kind = _classifyHierarchy( maxDepth, maxBranching, totalVisited );

    return { maxDepth: maxDepth, maxBranching: maxBranching, kind: kind };
}

function _classifyHierarchy( maxDepth, maxBranching, total ) {
    if ( total < 2 ) return BoneHierarchyKind.UNKNOWN;

    if ( maxDepth >= 8 && maxBranching <= 4 && total >= 40 && total <= 120 ) return BoneHierarchyKind.HUMANOID;
    if ( maxDepth >= 6 && maxBranching <= 3 && total >= 30 && total <= 80 ) return BoneHierarchyKind.QUADRUPED;
    if ( maxDepth >= 6 && maxBranching <= 2 && total >= 20 && total <= 60 ) return BoneHierarchyKind.BIRD;
    if ( maxDepth >= 5 && maxBranching >= 6 && total >= 30 ) return BoneHierarchyKind.FISH;
    if ( maxDepth >= 20 && maxBranching <= 2 ) return BoneHierarchyKind.CENTIPEDE;
    if ( maxDepth >= 12 && maxBranching >= 3 && total >= 40 ) return BoneHierarchyKind.INSECT;
    if ( maxDepth >= 10 && maxBranching >= 4 && total >= 80 ) return BoneHierarchyKind.SPIDER;
    if ( maxDepth >= 8 && maxBranching <= 2 && total <= 30 ) return BoneHierarchyKind.SNAKE;

    return BoneHierarchyKind.CUSTOM;
}

// ─── gl-matrix packing for telemetry. ─────────────────────────────────────

/**
 * Packs the scene ledger into a vec4.
 * Layout: (totalMeshes, totalBones, totalPaletteUploadMs, totalSkinningCostMs)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packSceneLedgerVec4( out ) {
    const v = out || _scratchVec4;

    glMatrix.vec4.set(
        v,
        _sceneLedger.totalMeshes,
        _sceneLedger.totalBones,
        _sceneLedger.totalPaletteUploadMs,
        _sceneLedger.totalSkinningCostMs
    );
    return v;
}

/**
 * Packs scene-wide quality metrics into a vec4.
 * Layout: (avgWeightError, maxWeightError, avgCompressionRatio, sceneCacheHitRatio)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packSceneQualityVec4( out ) {
    const v = out || _scratchVec4B;

    glMatrix.vec4.set(
        v,
        _sceneLedger.avgWeightError,
        _sceneLedger.maxWeightError,
        _sceneLedger.avgCompressionRatio,
        _sceneLedger.sceneCacheHitRatio
    );
    return v;
}

/**
 * Packs per-mesh telemetry into a vec4.
 * Layout: (boneCount, hierarchyDepth, avgPaletteUploadMsEMA, avgSkinningCostMsEMA)
 * @param {number} eid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packMeshTelemetryVec4( eid, out ) {
    const v = out || _scratchVec4C;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinningTelemetrySoA.boneCount[ eid ],
        SkinningTelemetrySoA.hierarchyDepth[ eid ],
        SkinningTelemetrySoA.avgPaletteUploadMsEMA[ eid ],
        SkinningTelemetrySoA.avgSkinningCostMsEMA[ eid ]
    );
    return v;
}

/**
 * Packs per-mesh quality metrics into a vec4.
 * Layout: (weightErrorMax, weightErrorAvg, compressionRatio, deadZoneCount)
 * @param {number} eid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packMeshQualityVec4( eid, out ) {
    const v = out || _scratchVec4D;

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinningTelemetrySoA.weightErrorMax[ eid ],
        SkinningTelemetrySoA.weightErrorAvg[ eid ],
        SkinningTelemetrySoA.compressionRatio[ eid ],
        SkinningTelemetrySoA.deadZoneCount[ eid ]
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
function sampleTelemetryDither( eid, frameIndex ) {
    if ( eid < 0 ) return 0.0;

    const seed = ( SkinningTelemetrySoA.determinismSeed[ eid ] ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, SkinningTelemetrySoA.boneCount[ eid ] );
}

// ─── Public API: frame lifecycle. ─────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all telemetry entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _telemetrySkinWorld, [ SkinningTelemetrySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        SkinningTelemetrySoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
    }

    resetCostBreakdown();
}

/**
 * Called once per frame, after all meshes have recorded their frame data.
 * @param {number} [frameIndex=0]
 */
function endFrame( frameIndex = 0 ) {
    // ── 1. Refresh the scene-wide ledger. ───────────────────────────────
    if ( SkinningTelemetryDefaults.computeSceneAggregatesEveryFrame
        || ( frameIndex % SkinningTelemetryDefaults.sceneAggregateInterval ) === 0 ) {
        computeSceneLedger( frameIndex );
    }

    // ─── 2. Push a frame sample into the ring buffer. ──────────────────
    pushFrameSample( {
        paletteMs: _sceneLedger.totalPaletteUploadMs,
        skinningMs: _sceneLedger.totalSkinningCostMs,
        meshCount: _sceneLedger.totalMeshes,
        boneCount: _sceneLedger.totalBones,
        paletteBytes: _sceneLedger.totalPaletteBytes
    }, frameIndex );
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

void Skeleton;
void Bone;
void BufferGeometry;
void BonesPerVertex;
void SkinWeightLayout;
void SkinnedMeshCaps;
void getLayoutEntityForUuid;
void getAutoAssignEntityForUuid;
void getOverlapEntityForUuid;
void getCompressorEntityForUuid;
void getTopologyEntityForUuid;
void getArbitraryEntityForUuid;
void _scratchVec3A;
void _scratchMat4;

export {
    CostCategory,
    SkinningTelemetryDefaults,
    SkinningTelemetrySoA,
    FRAME_RING_LENGTH,
    registerMesh,
    unregisterMesh,
    recordFrame,
    getMeshLedger,
    computeSceneLedger,
    pushFrameSample,
    getFrameHistory,
    computeFrameHistoryAverages,
    getCrossSystemSummary,
    getCostBreakdown,
    recordCategoryCost,
    resetCostBreakdown,
    findPathologicalMeshes,
    drawHUDSection,
    getAggregatedStats,
    computeTotalPaletteCostHighPrecision,
    computeTotalSkinningVertexCostHighPrecision,
    getTelemetryEntityFor,
    packSceneLedgerVec4,
    packSceneQualityVec4,
    packMeshTelemetryVec4,
    packMeshQualityVec4,
    sampleTelemetryDither,
    beginFrame,
    endFrame
};