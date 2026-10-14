// file number : 014_16
// full path name : src/objects/014_16_SkinnedMeshBridge.js
// description : Thin facade that 014_SkinnedMesh.js imports. Re-exports the entire companion set (014_0 through 014_15) as a single namespaced object so SkinnedMesh only needs one import statement, and provides the wiring helpers that SkinnedMesh calls during construction (buildHierarchy, validateHierarchy, chooseLayout, assignWeights, compressWeights, selectBonesForLOD, cullBonesByDistance, registerWithTelemetry, registerWithCache). Also exposes a single SkinnedMeshDefaults facade that merges 014_0 and 014_13 for the currently active Android tier. Uses bitecs SoA to register per-SkinnedMesh lifecycle state so the bridge can track wiring progress, double.js for high-precision byte and op accounting during construction, gl-matrix for vec4 telemetry packing, and simplex-noise for deterministic construction-order tie-breaking so replayable rig construction produces identical results across Android 64-bit devices (Adreno 5xx–7xx, Mali-G5x–G7xx).
// best for : Keeping 014_SkinnedMesh.js focused on the three.js-compatible public API, avoiding sixteen import statements in one file, single call-site for optional subsystems, easy swapping of any subsystem for tests, deterministic replay of rig construction, on-device telemetry of construction cost.
// license : MIT

import { Bone } from './001_Bone.js';
import { Skeleton } from './008_Skeleton.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Vector3 } from '../math/004_Vector3.js';

// ─── Import every companion module for re-export. ───────────────────────────
import * as Defaults from './014_0_SkinnedMeshDefaults.js';
import * as Walker from './014_1_BoneHierarchyWalker.js';
import * as Validator from './014_2_BoneHierarchyValidator.js';
import * as Archetypes from './014_3_BoneArchetypeRegistry.js';
import * as Builder from './014_4_BoneBranchBuilder.js';
import * as Normalizer from './014_5_SkinWeightNormalizer.js';
import * as Layout from './014_6_SkinWeightLayout.js';
import * as AutoAssign from './014_7_SkinWeightAutoAssign.js';
import * as Overlap from './014_7_5_SkinWeightAdjacentOverlap.js';
import * as Compressor from './014_8_SkinWeightCompressor.js';
import * as Topology from './014_9_TopologyAdapter.js';
import * as ArbitraryTopology from './014_10_ArbitraryTopologySupport.js';
import * as CacheManager from './014_11_SkinningCacheManager.js';
import * as SkinningTelemetry from './014_12_SkinningTelemetry.js';
import * as Presets from './014_13_SkinningPresets.js';
import * as BoneLOD from './014_14_BoneLODSelection.js';
import * as BoneCulling from './014_15_BoneDistanceCulling.js';

// ─── Cross-system integration (LOD stack). ──────────────────────────────────
import { SkinningCostMultiplierLOD } from './007_12_SkinningCostMultiplier_LOD.js';
import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';
import { FreezeWakeLOD, FreezeState } from './007_16_FreezeWake_LOD.js';
import { TelemetryBudgetHUDLOD } from './007_10_TelemetryBudgetHUD_LOD.js';
import { StreamingGeometryCacheLOD } from './007_13_StreamingGeometryCache_LOD.js';

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
const _scratchMat4 = new Float64Array( 16 );
const _noise3D = createNoise3D();

// ─── ECS world + Bridge SoA component (bitecs). ─────────────────────────────
const _bridgeWorld = createWorld();

const SkinnedMeshBridgeSoA = defineComponent( {
    meshId: Types.i32,
    geometryUuidHash: Types.i32,
    skeletonUuidHash: Types.i32,

    // Wiring steps completed (bitmask).
    wiringSteps: Types.i32,

    // Wiring outcome flags.
    hierarchyBuilt: Types.ui8,
    hierarchyValidated: Types.ui8,
    layoutChosen: Types.ui8,
    weightsAssigned: Types.ui8,
    weightsNormalized: Types.ui8,
    overlapApplied: Types.ui8,
    weightsCompressed: Types.ui8,
    topologyAdapted: Types.ui8,
    telemetryRegistered: Types.ui8,
    cacheRegistered: Types.ui8,
    boneLODRegistered: Types.ui8,
    boneCullRegistered: Types.ui8,

    // Telemetry.
    constructionMs: Types.f64,
    assemblyMs: Types.f64,
    validationMs: Types.f64,
    weightMs: Types.f64,
    compressionMs: Types.f64,
    topologyMs: Types.f64,
    registrationMs: Types.f64,

    // Byte / op estimates.
    estimatedTotalBytes: Types.f64,
    estimatedBoneOps: Types.f64,
    estimatedVertexOps: Types.f64,

    // Determinism.
    determinismSeed: Types.ui32,
    constructionSeed: Types.ui32,
    ditherSample: Types.f64,

    // State.
    registered: Types.ui8,
    wired: Types.ui8,
    failed: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Wiring step bitmask constants. ─────────────────────────────────────────
const WiringStep = Object.freeze( {
    NONE: 0,
    BUILD_HIERARCHY: 1 << 0,
    VALIDATE_HIERARCHY: 1 << 1,
    CHOOSE_LAYOUT: 1 << 2,
    ADAPT_TOPOLOGY: 1 << 3,
    ASSIGN_WEIGHTS: 1 << 4,
    NORMALIZE_WEIGHTS: 1 << 5,
    APPLY_OVERLAP: 1 << 6,
    COMPRESS_WEIGHTS: 1 << 7,
    REGISTER_TELEMETRY: 1 << 8,
    REGISTER_CACHE: 1 << 9,
    REGISTER_BONE_LOD: 1 << 10,
    REGISTER_BONE_CULL: 1 << 11,
    ALL: 0xFFF
} );

// ─── Reusable assembly result record. ──────────────────────────────────────
const _assemblyResult = {
    meshId: - 1,
    geometryUuidHash: 0,
    skeletonUuidHash: 0,
    wiringSteps: 0,
    hierarchyBuilt: false,
    hierarchyValidated: false,
    layoutChosen: false,
    weightsAssigned: false,
    weightsNormalized: false,
    overlapApplied: false,
    weightsCompressed: false,
    topologyAdapted: false,
    telemetryRegistered: false,
    cacheRegistered: false,
    boneLODRegistered: false,
    boneCullRegistered: false,
    constructionMs: 0.0,
    assemblyMs: 0.0,
    validationMs: 0.0,
    weightMs: 0.0,
    compressionMs: 0.0,
    topologyMs: 0.0,
    registrationMs: 0.0,
    estimatedTotalBytes: 0.0,
    estimatedBoneOps: 0.0,
    estimatedVertexOps: 0.0,
    failed: false
};

// ─── Reusable defaults. ────────────────────────────────────────────────────
const SkinnedMeshBridgeDefaults = {
    // Whether to run the full wiring pipeline on construction.
    wireOnConstruct: true,

    // Whether to validate the hierarchy before wiring.
    validateOnConstruct: true,

    // Whether to adapt the topology before wiring.
    adaptTopologyOnConstruct: true,

    // Whether to auto-assign weights when the geometry has none.
    autoAssignWhenMissing: true,

    // Whether to apply the adjacent overlap pass after auto-assign.
    applyOverlapAfterAssign: true,

    // Whether to normalize weights before compression.
    normalizeBeforeCompress: true,

    // Whether to compress weights according to the tier preset.
    compressPerTier: true,

    // Whether to register with the telemetry HUD.
    registerTelemetry: true,

    // Whether to register with the cache manager.
    registerCache: true,

    // Whether to register with the bone LOD selection system.
    registerBoneLOD: true,

    // Whether to register with the bone distance culling system.
    registerBoneCull: true,

    // Whether to abort wiring when a step fails.
    abortOnFailure: true,

    // Whether to emit construction events.
    emitEvents: false,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F,

    // Emit construction dither sample for telemetry.
    emitDither: true
};

// ─── ECS entity cache (meshId -> eid). ────────────────────────────────────
const _ecsBridgeByMeshId = new Map();

// ─── Public API: assemble (main wiring entry point). ──────────────────────

/**
 * Runs the full SkinnedMesh assembly pipeline on a geometry + skeleton pair.
 * Called by 014_SkinnedMesh.js during construction, or by the host for
 * procedural rigs that need the same wiring.
 *
 * @param {object} mesh - A SkinnedMesh or compatible object with .id, .geometry, .skeleton.
 * @param {BufferGeometry} geometry
 * @param {Skeleton} skeleton
 * @param {object} [options]
 * @return {object} The assembly result record.
 */
function assemble( mesh, geometry, skeleton, options = {} ) {
    const tAssemblyStart = _nowMs();

    _resetAssemblyResult();

    if ( mesh === undefined || mesh === null ) {
        _assemblyResult.failed = true;
        _assemblyResult.assemblyMs = _nowMs() - tAssemblyStart;
        return _assemblyResult;
    }

    const meshId = mesh.id !== undefined ? mesh.id : - 1;
    const frameIndex = options.frameIndex | 0;

    _assemblyResult.meshId = meshId;

    // ── 1. Determine the geometry and skeleton hashes. ─────────────────
    const geometryUuid = geometry !== undefined && geometry !== null && geometry.uuid !== undefined ? geometry.uuid : '';
    const skeletonUuid = skeleton !== undefined && skeleton !== null && skeleton.uuid !== undefined ? skeleton.uuid : '';

    const geometryHash = _hashString( geometryUuid );
    const skeletonHash = _hashString( skeletonUuid );

    _assemblyResult.geometryUuidHash = geometryHash;
    _assemblyResult.skeletonUuidHash = skeletonHash;

    // ── 2. Register the bridge entry. ──────────────────────────────────
    const eid = _ensureBridgeEntity( meshId, geometryHash, skeletonHash, frameIndex );

    SkinnedMeshBridgeSoA.determinismSeed[ eid ] = _mix32( geometryHash ^ skeletonHash ^ SkinningPresetsDefaultsSeed() );
    SkinnedMeshBridgeSoA.constructionSeed[ eid ] = _mix32( SkinnedMeshBridgeSoA.determinismSeed[ eid ] ^ ( frameIndex * 0x9E3779B9 ) );
    SkinnedMeshBridgeSoA.ditherSample[ eid ] = _noise3D(
        SkinnedMeshBridgeSoA.constructionSeed[ eid ] * 1e-6,
        frameIndex * 0.02,
        meshId
    );

    const tier = _getCurrentTier();
    const preset = Presets.getCurrentPreset();

    // ── 3. Build the hierarchy (usually already built). ────────────────
    const tBuild = _nowMs();

    if ( options.buildHierarchy === true && skeleton !== undefined && skeleton !== null ) {
        // Nothing to do: the hierarchy is already constructed.
    }

    SkinnedMeshBridgeSoA.hierarchyBuilt[ eid ] = 1;
    SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.BUILD_HIERARCHY;
    _assemblyResult.hierarchyBuilt = true;
    _assemblyResult.wiringSteps |= WiringStep.BUILD_HIERARCHY;

    SkinnedMeshBridgeSoA.assemblyMs[ eid ] = _nowMs() - tBuild;
    _assemblyResult.assemblyMs = SkinnedMeshBridgeSoA.assemblyMs[ eid ];

    // ── 4. Validate the hierarchy. ────────────────────────────────────
    if ( SkinnedMeshBridgeDefaults.validateOnConstruct && skeleton !== undefined && skeleton !== null ) {
        const tValidate = _nowMs();

        const report = Validator.validate( skeleton.bones !== undefined && skeleton.bones.length > 0 ? skeleton.bones[ 0 ] : null, {
            frameIndex: frameIndex
        } );

        SkinnedMeshBridgeSoA.validationMs[ eid ] = _nowMs() - tValidate;
        _assemblyResult.validationMs = SkinnedMeshBridgeSoA.validationMs[ eid ];

        if ( report.worstSeverity >= 3 ) {
            // Serious errors detected; try a repair.
            Validator.repair(
                skeleton.bones !== undefined && skeleton.bones.length > 0 ? skeleton.bones[ 0 ] : null,
                Validator.RepairStrategy.ALL,
                frameIndex
            );
        }

        SkinnedMeshBridgeSoA.hierarchyValidated[ eid ] = 1;
        SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.VALIDATE_HIERARCHY;
        _assemblyResult.hierarchyValidated = true;
        _assemblyResult.wiringSteps |= WiringStep.VALIDATE_HIERARCHY;
    }

    // ── 5. Adapt the topology if requested. ───────────────────────────
    if ( SkinnedMeshBridgeDefaults.adaptTopologyOnConstruct && geometry !== undefined && geometry !== null ) {
        const tTopo = _nowMs();

        Topology.adapt( geometry, { frameIndex: frameIndex } );

        SkinnedMeshBridgeSoA.topologyMs[ eid ] = _nowMs() - tTopo;
        _assemblyResult.topologyMs = SkinnedMeshBridgeSoA.topologyMs[ eid ];

        SkinnedMeshBridgeSoA.topologyAdapted[ eid ] = 1;
        SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.ADAPT_TOPOLOGY;
        _assemblyResult.topologyAdapted = true;
        _assemblyResult.wiringSteps |= WiringStep.ADAPT_TOPOLOGY;
    }

    // ── 6. Choose the weight layout. ──────────────────────────────────
    const tLayout = _nowMs();

    const vertexCount = geometry !== undefined && geometry !== null && geometry.attributes.position !== undefined
        ? geometry.attributes.position.count
        : 0;

    const bonesPerVertex = preset.bonesPerVertex;

    const layoutValue = Layout.chooseLayout(
        vertexCount,
        bonesPerVertex,
        Layout.LayoutPolicy.LOWEST_MEMORY,
        frameIndex
    );

    SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.CHOOSE_LAYOUT;
    _assemblyResult.layoutChosen = true;
    _assemblyResult.wiringSteps |= WiringStep.CHOOSE_LAYOUT;

    void tLayout;

    // ── 7. Auto-assign weights when missing. ──────────────────────────
    const hasSkinWeights = geometry !== undefined && geometry !== null &&
        geometry.attributes[ Layout.ATTR_SKIN_WEIGHT ] !== undefined;

    if ( ! hasSkinWeights && SkinnedMeshBridgeDefaults.autoAssignWhenMissing && skeleton !== undefined && skeleton !== null && geometry !== undefined && geometry !== null ) {
        const tWeight = _nowMs();

        const assignResult = AutoAssign.assign( geometry, skeleton.bones, {
            strategy: AutoAssign.AssignStrategy.DISTANCE_FALLOFF,
            bonesPerVertex: bonesPerVertex,
            frameIndex: frameIndex,
            layout: layoutValue,
            skeletonId: skeleton.uuid !== undefined ? _hashString( skeleton.uuid ) : - 1
        } );

        SkinnedMeshBridgeSoA.weightsAssigned[ eid ] = 1;
        SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.ASSIGN_WEIGHTS;
        _assemblyResult.weightsAssigned = true;
        _assemblyResult.wiringSteps |= WiringStep.ASSIGN_WEIGHTS;

        // ── 7a. Apply the adjacent overlap pass. ──────────────────────
        if ( SkinnedMeshBridgeDefaults.applyOverlapAfterAssign ) {
            Overlap.applyAdjacentOverlap( geometry, skeleton.bones, {
                bonesPerVertex: bonesPerVertex,
                layout: layoutValue,
                frameIndex: frameIndex,
                skeletonId: skeleton.uuid !== undefined ? _hashString( skeleton.uuid ) : - 1
            } );

            SkinnedMeshBridgeSoA.overlapApplied[ eid ] = 1;
            SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.APPLY_OVERLAP;
            _assemblyResult.overlapApplied = true;
            _assemblyResult.wiringSteps |= WiringStep.APPLY_OVERLAP;
        }

        SkinnedMeshBridgeSoA.weightMs[ eid ] = _nowMs() - tWeight;
        _assemblyResult.weightMs = SkinnedMeshBridgeSoA.weightMs[ eid ];

        void assignResult;
    }

    // ── 8. Normalize weights. ─────────────────────────────────────────
    if ( SkinnedMeshBridgeDefaults.normalizeBeforeCompress && geometry !== undefined && geometry !== null ) {
        const tNorm = _nowMs();

        Normalizer.normalizeGeometry( geometry, {
            bonesPerVertex: bonesPerVertex,
            layout: layoutValue,
            frameIndex: frameIndex
        } );

        SkinnedMeshBridgeSoA.weightsNormalized[ eid ] = 1;
        SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.NORMALIZE_WEIGHTS;
        _assemblyResult.weightsNormalized = true;
        _assemblyResult.wiringSteps |= WiringStep.NORMALIZE_WEIGHTS;

        void tNorm;
    }

    // ── 9. Compress weights per tier. ─────────────────────────────────
    if ( SkinnedMeshBridgeDefaults.compressPerTier && geometry !== undefined && geometry !== null ) {
        const tComp = _nowMs();

        const bits = preset.compressWeights ? preset.quantizationBits : Compressor.QuantBits.FLOAT32;

        Compressor.compress( geometry, {
            quantizationBits: bits,
            dropEpsilon: preset.dropEpsilon,
            outputLayout: layoutValue,
            frameIndex: frameIndex
        } );

        SkinnedMeshBridgeSoA.compressionMs[ eid ] = _nowMs() - tComp;
        _assemblyResult.compressionMs = SkinnedMeshBridgeSoA.compressionMs[ eid ];

        SkinnedMeshBridgeSoA.weightsCompressed[ eid ] = 1;
        SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.COMPRESS_WEIGHTS;
        _assemblyResult.weightsCompressed = true;
        _assemblyResult.wiringSteps |= WiringStep.COMPRESS_WEIGHTS;
    }

    // ── 10. Register with the telemetry HUD. ──────────────────────────
    if ( SkinnedMeshBridgeDefaults.registerTelemetry ) {
        const tReg = _nowMs();

        SkinningTelemetry.registerMesh( mesh, skeleton, geometry, { frameIndex: frameIndex } );

        SkinnedMeshBridgeSoA.telemetryRegistered[ eid ] = 1;
        SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.REGISTER_TELEMETRY;
        _assemblyResult.telemetryRegistered = true;
        _assemblyResult.wiringSteps |= WiringStep.REGISTER_TELEMETRY;

        void tReg;
    }

    // ── 11. Register with the cache manager. ──────────────────────────
    if ( SkinnedMeshBridgeDefaults.registerCache ) {
        const key = CacheManager.makeCacheKey( skeleton, geometry, bonesPerVertex, layoutValue );

        CacheManager.store( key, {
            normalizedWeights: geometry.attributes[ Layout.ATTR_SKIN_WEIGHT ] !== undefined
                ? geometry.attributes[ Layout.ATTR_SKIN_WEIGHT ].array
                : null
        }, frameIndex );

        SkinnedMeshBridgeSoA.cacheRegistered[ eid ] = 1;
        SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.REGISTER_CACHE;
        _assemblyResult.cacheRegistered = true;
        _assemblyResult.wiringSteps |= WiringStep.REGISTER_CACHE;
    }

    // ── 12. Register with the bone LOD selection system. ──────────────
    if ( SkinnedMeshBridgeDefaults.registerBoneLOD && skeleton !== undefined && skeleton !== null ) {
        const boneEid = BoneLOD.registerSkeleton( skeleton, {
            skeletonHash: skeletonHash,
            frameIndex: frameIndex
        } );

        if ( boneEid >= 0 ) {
            SkinnedMeshBridgeSoA.boneLODRegistered[ eid ] = 1;
            SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.REGISTER_BONE_LOD;
            _assemblyResult.boneLODRegistered = true;
            _assemblyResult.wiringSteps |= WiringStep.REGISTER_BONE_LOD;
        }
    }

    // ── 13. Register with the bone distance culling system. ──────────
    if ( SkinnedMeshBridgeDefaults.registerBoneCull && skeleton !== undefined && skeleton !== null ) {
        const cullEid = BoneCulling.registerSkeleton( skeleton, {
            skeletonHash: skeletonHash,
            frameIndex: frameIndex
        } );

        if ( cullEid >= 0 ) {
            SkinnedMeshBridgeSoA.boneCullRegistered[ eid ] = 1;
            SkinnedMeshBridgeSoA.wiringSteps[ eid ] |= WiringStep.REGISTER_BONE_CULL;
            _assemblyResult.boneCullRegistered = true;
            _assemblyResult.wiringSteps |= WiringStep.REGISTER_BONE_CULL;
        }
    }

    // ── 14. Compute byte and op estimates. ────────────────────────────
    _computeEstimates( eid, vertexCount, bonesPerVertex, skeleton );

    // ── 15. Update construction timing. ───────────────────────────────
    SkinnedMeshBridgeSoA.constructionMs[ eid ] = _nowMs() - tAssemblyStart;
    _assemblyResult.constructionMs = SkinnedMeshBridgeSoA.constructionMs[ eid ];

    SkinnedMeshBridgeSoA.registered[ eid ] = 1;
    SkinnedMeshBridgeSoA.wired[ eid ] = 1;
    SkinnedMeshBridgeSoA.lastFrameIndex[ eid ] = frameIndex;

    _assemblyResult.estimatedTotalBytes = SkinnedMeshBridgeSoA.estimatedTotalBytes[ eid ];
    _assemblyResult.estimatedBoneOps = SkinnedMeshBridgeSoA.estimatedBoneOps[ eid ];
    _assemblyResult.estimatedVertexOps = SkinnedMeshBridgeSoA.estimatedVertexOps[ eid ];

    _assemblyResult.assemblyMs = _nowMs() - tAssemblyStart;

    void tier;

    return _assemblyResult;
}

// ─── Public API: per-frame update. ────────────────────────────────────────

/**
 * Runs the per-frame bridge update for a SkinnedMesh.
 * @param {object} mesh
 * @param {Skeleton} skeleton
 * @param {object} context
 * @return {object} A merged ledger from all systems.
 */
function update( mesh, skeleton, context = {} ) {
    const meshId = mesh !== undefined && mesh.id !== undefined ? mesh.id : - 1;
    const eid = _ecsBridgeByMeshId.get( meshId );

    if ( eid === undefined ) {
        return _emptyLedger();
    }

    const frameIndex = context.frameIndex | 0;

    SkinnedMeshBridgeSoA.lastFrameIndex[ eid ] = frameIndex;

    // ── 1. Publish freeze state to downstream systems. ────────────────
    const freezeState = context.freezeState !== undefined ? context.freezeState : FreezeState.AWAKE;

    BoneLOD.setFreezeState( BoneLOD.getLastSelectionResult().skeletonId, freezeState );
    BoneCulling.setFreezeState( BoneCulling.getLastCullResult().skeletonId, freezeState );

    // ── 2. Run bone LOD selection. ────────────────────────────────────
    const skeletonHash = SkinnedMeshBridgeSoA.skeletonUuidHash[ eid ];

    let selectionResult = null;
    let cullResult = null;

    if ( skeleton !== undefined && skeleton !== null ) {
        // Look up the LOD selection ECS entity via the shared registry.
        const lodEid = BoneLOD.getLastSelectionResult().skeletonId;

        selectionResult = BoneLOD.select( lodEid, skeleton, {
            cameraDistance: context.cameraDistance !== undefined ? context.cameraDistance : 0.0,
            projectedSizePx: context.projectedSizePx,
            inFrustum: context.inFrustum !== false,
            frameIndex: frameIndex,
            cameraFov: context.cameraFov,
            viewportHeightPx: context.viewportHeightPx
        } );

        // Look up the culling ECS entity via the shared registry.
        const cullEid = BoneCulling.getLastCullResult().skeletonId;

        if ( context.frustum !== undefined ) {
            cullResult = BoneCulling.cull( cullEid, skeleton, {
                frustum: context.frustum,
                frameIndex: frameIndex,
                skeletonInFrustum: context.inFrustum !== false
            } );
        }
    }

    // ── 3. Return merged ledger. ──────────────────────────────────────
    return {
        selection: selectionResult,
        cull: cullResult,
        bridge: getBridgeLedger( eid ),
        skeletonHash: skeletonHash
    };
}

/**
 * Runs the per-frame end-of-frame update for the SkinnedMesh telemetry.
 * @param {object} mesh
 * @param {number} [frameIndex=0]
 */
function endFrame( mesh, frameIndex = 0 ) {
    const meshId = mesh !== undefined && mesh.id !== undefined ? mesh.id : - 1;
    const eid = _ecsBridgeByMeshId.get( meshId );

    if ( eid === undefined ) return;

    SkinnedMeshBridgeSoA.lastFrameIndex[ eid ] = frameIndex;
}

// ─── Internal: compute estimates. ─────────────────────────────────────────

function _computeEstimates( eid, vertexCount, bonesPerVertex, skeleton ) {
    const boneCount = skeleton !== undefined && skeleton !== null && skeleton.bones !== undefined
        ? skeleton.bones.length
        : 0;

    // ── 1. Byte estimate. ──────────────────────────────────────────────
    const paletteBytes = new Double( boneCount ).mul( new Double( 16 * 4 ) );
    const weightBytes = new Double( vertexCount ).mul( new Double( bonesPerVertex * 2 ) );
    const indexBytes = new Double( vertexCount ).mul( new Double( 4 ) );
    const totalBytes = paletteBytes.add( weightBytes ).add( indexBytes );

    SkinnedMeshBridgeSoA.estimatedTotalBytes[ eid ] = totalBytes.valueOf();

    // ── 2. Bone ops estimate. ──────────────────────────────────────────
    const boneOps = new Double( boneCount ).mul( new Double( 16 ) ).mul( new Double( 60 ) );
    SkinnedMeshBridgeSoA.estimatedBoneOps[ eid ] = boneOps.valueOf();

    // ── 3. Vertex ops estimate. ────────────────────────────────────────
    const vertexOps = new Double( vertexCount ).mul( new Double( bonesPerVertex ) ).mul( new Double( 4 ) );
    SkinnedMeshBridgeSoA.estimatedVertexOps[ eid ] = vertexOps.valueOf();
}

// ─── Public API: query. ────────────────────────────────────────────────────

/**
 * Returns the bridge ledger for a given mesh id.
 * @param {number} eid
 * @return {object}
 */
function getBridgeLedger( eid ) {
    if ( eid < 0 ) return _emptyLedger();

    return {
        meshId: SkinnedMeshBridgeSoA.meshId[ eid ],
        geometryUuidHash: SkinnedMeshBridgeSoA.geometryUuidHash[ eid ],
        skeletonUuidHash: SkinnedMeshBridgeSoA.skeletonUuidHash[ eid ],
        wiringSteps: SkinnedMeshBridgeSoA.wiringSteps[ eid ],
        hierarchyBuilt: SkinnedMeshBridgeSoA.hierarchyBuilt[ eid ] === 1,
        hierarchyValidated: SkinnedMeshBridgeSoA.hierarchyValidated[ eid ] === 1,
        layoutChosen: SkinnedMeshBridgeSoA.layoutChosen[ eid ] === 1,
        weightsAssigned: SkinnedMeshBridgeSoA.weightsAssigned[ eid ] === 1,
        weightsNormalized: SkinnedMeshBridgeSoA.weightsNormalized[ eid ] === 1,
        overlapApplied: SkinnedMeshBridgeSoA.overlapApplied[ eid ] === 1,
        weightsCompressed: SkinnedMeshBridgeSoA.weightsCompressed[ eid ] === 1,
        topologyAdapted: SkinnedMeshBridgeSoA.topologyAdapted[ eid ] === 1,
        telemetryRegistered: SkinnedMeshBridgeSoA.telemetryRegistered[ eid ] === 1,
        cacheRegistered: SkinnedMeshBridgeSoA.cacheRegistered[ eid ] === 1,
        boneLODRegistered: SkinnedMeshBridgeSoA.boneLODRegistered[ eid ] === 1,
        boneCullRegistered: SkinnedMeshBridgeSoA.boneCullRegistered[ eid ] === 1,
        constructionMs: SkinnedMeshBridgeSoA.constructionMs[ eid ],
        assemblyMs: SkinnedMeshBridgeSoA.assemblyMs[ eid ],
        validationMs: SkinnedMeshBridgeSoA.validationMs[ eid ],
        weightMs: SkinnedMeshBridgeSoA.weightMs[ eid ],
        compressionMs: SkinnedMeshBridgeSoA.compressionMs[ eid ],
        topologyMs: SkinnedMeshBridgeSoA.topologyMs[ eid ],
        registrationMs: SkinnedMeshBridgeSoA.registrationMs[ eid ],
        estimatedTotalBytes: SkinnedMeshBridgeSoA.estimatedTotalBytes[ eid ],
        estimatedBoneOps: SkinnedMeshBridgeSoA.estimatedBoneOps[ eid ],
        estimatedVertexOps: SkinnedMeshBridgeSoA.estimatedVertexOps[ eid ],
        determinismSeed: SkinnedMeshBridgeSoA.determinismSeed[ eid ],
        constructionSeed: SkinnedMeshBridgeSoA.constructionSeed[ eid ],
        ditherSample: SkinnedMeshBridgeSoA.ditherSample[ eid ],
        wired: SkinnedMeshBridgeSoA.wired[ eid ] === 1,
        failed: SkinnedMeshBridgeSoA.failed[ eid ] === 1
    };
}

/**
 * Returns the bridge ledger for a mesh id (lookup helper).
 * @param {number} meshId
 * @return {object}
 */
function getLedgerForMeshId( meshId ) {
    const eid = _ecsBridgeByMeshId.get( meshId );

    if ( eid === undefined ) return _emptyLedger();

    return getBridgeLedger( eid );
}

/**
 * Returns the ECS entity id for a given mesh id.
 * @param {number} meshId
 * @return {number}
 */
function getBridgeEntityForMeshId( meshId ) {
    const eid = _ecsBridgeByMeshId.get( meshId );
    return eid !== undefined ? eid : - 1;
}

// ─── Public API: high-precision helpers. ──────────────────────────────────

/**
 * Returns a high-precision construction cost estimate for a mesh.
 * @param {number} meshId
 * @return {number}
 */
function computeConstructionCostHighPrecision( meshId ) {
    const eid = _ecsBridgeByMeshId.get( meshId );
    if ( eid === undefined ) return 0.0;

    const ms = new Double( SkinnedMeshBridgeSoA.constructionMs[ eid ] );
    const bytes = new Double( SkinnedMeshBridgeSoA.estimatedTotalBytes[ eid ] );

    return ms.mul( bytes ).valueOf();
}

/**
 * Returns a high-precision aggregate of the estimated bytes across all
 * registered meshes.
 * @return {number}
 */
function computeSceneBytesHighPrecision() {
    let total = new Double( 0 );

    const q = query( _bridgeWorld, [ SkinnedMeshBridgeSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinnedMeshBridgeSoA.registered[ eid ] !== 1 ) continue;

        total = new Double( total.valueOf() + SkinnedMeshBridgeSoA.estimatedTotalBytes[ eid ] );
    }

    return total.valueOf();
}

/**
 * Returns a high-precision aggregate of the estimated vertex ops across
 * all registered meshes.
 * @return {number}
 */
function computeSceneVertexOpsHighPrecision() {
    let total = new Double( 0 );

    const q = query( _bridgeWorld, [ SkinnedMeshBridgeSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinnedMeshBridgeSoA.registered[ eid ] !== 1 ) continue;

        total = new Double( total.valueOf() + SkinnedMeshBridgeSoA.estimatedVertexOps[ eid ] );
    }

    return total.valueOf();
}

// ─── Public API: aggregated stats. ────────────────────────────────────────

/**
 * Returns aggregated bridge statistics across the scene.
 * @return {object}
 */
function getAggregatedStats() {
    let totalMeshes = 0;
    let totalWired = 0;
    let totalFailed = 0;
    let totalBytes = 0.0;
    let totalBoneOps = 0.0;
    let totalVertexOps = 0.0;
    let totalConstructionMs = 0.0;
    let totalWeightMs = 0.0;
    let totalCompressionMs = 0.0;

    const q = query( _bridgeWorld, [ SkinnedMeshBridgeSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinnedMeshBridgeSoA.registered[ eid ] !== 1 ) continue;

        totalMeshes ++;

        if ( SkinnedMeshBridgeSoA.wired[ eid ] === 1 ) totalWired ++;
        if ( SkinnedMeshBridgeSoA.failed[ eid ] === 1 ) totalFailed ++;

        totalBytes += SkinnedMeshBridgeSoA.estimatedTotalBytes[ eid ];
        totalBoneOps += SkinnedMeshBridgeSoA.estimatedBoneOps[ eid ];
        totalVertexOps += SkinnedMeshBridgeSoA.estimatedVertexOps[ eid ];
        totalConstructionMs += SkinnedMeshBridgeSoA.constructionMs[ eid ];
        totalWeightMs += SkinnedMeshBridgeSoA.weightMs[ eid ];
        totalCompressionMs += SkinnedMeshBridgeSoA.compressionMs[ eid ];
    }

    const bytes = new Double( totalBytes );
    const boneOps = new Double( totalBoneOps );
    const vertexOps = new Double( totalVertexOps );
    const ms = new Double( totalConstructionMs );

    return {
        totalMeshes: totalMeshes,
        totalWired: totalWired,
        totalFailed: totalFailed,
        totalBytes: bytes.valueOf(),
        totalBoneOps: boneOps.valueOf(),
        totalVertexOps: vertexOps.valueOf(),
        totalConstructionMs: ms.valueOf(),
        totalWeightMs: totalWeightMs,
        totalCompressionMs: totalCompressionMs
    };
}

// ─── Public API: merged defaults facade. ──────────────────────────────────

/**
 * Returns a merged view of the defaults from 014_0 and the current tier
 * preset from 014_13. This is what SkinnedMesh exposes as
 * `SkinnedMesh.DEFAULTS`.
 * @return {object}
 */
function getSkinnedMeshDefaults() {
    const preset = Presets.getCurrentPreset();

    return {
        // From 014_0
        bonesPerVertex: preset.bonesPerVertex,
        quality: preset.quality,
        weightLayout: preset.weightLayout,
        androidTier: Presets.getCurrentTier(),

        // From the preset
        maxBonesPerSkeleton: preset.maxBonesPerSkeleton,
        maxHierarchyDepth: preset.maxHierarchyDepth,
        maxBranchingFactor: preset.maxBranchingFactor,
        maxVertexCount: preset.maxVertexCount,

        compressWeights: preset.compressWeights,
        quantizationBits: preset.quantizationBits,
        dropEpsilon: preset.dropEpsilon,

        autoAssignWeights: preset.autoAssignWeights,
        autoAssignStrategy: preset.autoAssignStrategy,
        falloffExponent: preset.falloffExponent,
        cutoffRadius: preset.cutoffRadius,

        parentOverlapFactor: preset.parentOverlapFactor,
        childOverlapFactor: preset.childOverlapFactor,
        siblingOverlapFactor: preset.siblingOverlapFactor,
        falloffKernel: preset.falloffKernel,

        allowSubdivision: preset.allowSubdivision,
        subdivisionMode: preset.subdivisionMode,
        subdivisionLevel: preset.subdivisionLevel,
        adaptiveMaxLevel: preset.adaptiveMaxLevel,
        triangulationMode: preset.triangulationMode,
        weldEpsilon: preset.weldEpsilon,

        cacheBytes: preset.cacheBytes,
        maxCacheEntries: preset.maxCacheEntries,

        telemetryFrameRingLength: preset.telemetryFrameRingLength,
        trackCacheTelemetry: preset.trackCacheTelemetry
    };
}

// ─── Public API: tier change notification. ────────────────────────────────

/**
 * Called when the Android tier changes. Propagates the new tier to all
 * downstream SkinnedMesh systems via 014_13's applyTier.
 *
 * @param {number} tier - One of `SkinningTier`.
 * @param {number} [frameIndex=0]
 * @return {object} The applied preset.
 */
function notifyTierChange( tier, frameIndex = 0 ) {
    return Presets.applyTier( tier, frameIndex );
}

/**
 * Publishes pressure signals to the skinning subsystem.
 * @param {number} thermal
 * @param {number} battery
 * @param {number} memory
 */
function notifyPressure( thermal, battery, memory ) {
    CacheManager.setThermalPressure( thermal );
    CacheManager.setBatteryPressure( battery );
    CacheManager.setMemoryPressure( memory );
}

// ─── Public API: freeze integration. ──────────────────────────────────────

/**
 * Called when the owning LOD's freeze state changes.
 * @param {number} meshId
 * @param {number} freezeState
 */
function notifyFreezeState( meshId, freezeState ) {
    const eid = _ecsBridgeByMeshId.get( meshId );

    if ( eid === undefined ) return;

    // Forward to the bone LOD and cull systems.
    const lodEid = BoneLOD.getLastSelectionResult().skeletonId;
    const cullEid = BoneCulling.getLastCullResult().skeletonId;

    BoneLOD.setFreezeState( lodEid, freezeState );
    BoneCulling.setFreezeState( cullEid, freezeState );
}

// ─── Public API: frame lifecycle. ─────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index across the bridge and all downstream
 * skinning subsystems. Call once per frame before any SkinnedMesh updates.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    Defaults.applyAndroidTier( Presets.getCurrentTier() );
    Presets.beginFrame( frameIndex );
    Normalizer.beginFrame( frameIndex );
    AutoAssign.beginFrame( frameIndex );
    Overlap.beginFrame( frameIndex );
    Compressor.beginFrame( frameIndex );
    Topology.beginFrame( frameIndex );
    ArbitraryTopology.beginFrame( frameIndex );
    CacheManager.beginFrame( frameIndex );
    SkinningTelemetry.beginFrame( frameIndex );
    BoneLOD.beginFrame( frameIndex );
    BoneCulling.beginFrame( frameIndex );

    const q = query( _bridgeWorld, [ SkinnedMeshBridgeSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        SkinnedMeshBridgeSoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
    }
}

/**
 * Finalizes the frame across the bridge and all downstream subsystems.
 * @param {number} [frameIndex=0]
 */
function endFrameAll( frameIndex = 0 ) {
    SkinningTelemetry.endFrame( frameIndex );
}

// ─── Public API: ECS sync. ────────────────────────────────────────────────

function _ensureBridgeEntity( meshId, geometryHash, skeletonHash, frameIndex ) {
    let eid = _ecsBridgeByMeshId.get( meshId );

    if ( eid === undefined ) {
        eid = addEntity( _bridgeWorld );
        addComponent( _bridgeWorld, SkinnedMeshBridgeSoA, eid );
        _ecsBridgeByMeshId.set( meshId, eid );

        SkinnedMeshBridgeSoA.meshId[ eid ] = meshId;
        SkinnedMeshBridgeSoA.geometryUuidHash[ eid ] = geometryHash;
        SkinnedMeshBridgeSoA.skeletonUuidHash[ eid ] = skeletonHash;
        SkinnedMeshBridgeSoA.wiringSteps[ eid ] = 0;
        SkinnedMeshBridgeSoA.hierarchyBuilt[ eid ] = 0;
        SkinnedMeshBridgeSoA.hierarchyValidated[ eid ] = 0;
        SkinnedMeshBridgeSoA.layoutChosen[ eid ] = 0;
        SkinnedMeshBridgeSoA.weightsAssigned[ eid ] = 0;
        SkinnedMeshBridgeSoA.weightsNormalized[ eid ] = 0;
        SkinnedMeshBridgeSoA.overlapApplied[ eid ] = 0;
        SkinnedMeshBridgeSoA.weightsCompressed[ eid ] = 0;
        SkinnedMeshBridgeSoA.topologyAdapted[ eid ] = 0;
        SkinnedMeshBridgeSoA.telemetryRegistered[ eid ] = 0;
        SkinnedMeshBridgeSoA.cacheRegistered[ eid ] = 0;
        SkinnedMeshBridgeSoA.boneLODRegistered[ eid ] = 0;
        SkinnedMeshBridgeSoA.boneCullRegistered[ eid ] = 0;
        SkinnedMeshBridgeSoA.constructionMs[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.assemblyMs[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.validationMs[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.weightMs[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.compressionMs[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.topologyMs[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.registrationMs[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.estimatedTotalBytes[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.estimatedBoneOps[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.estimatedVertexOps[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.determinismSeed[ eid ] = 0;
        SkinnedMeshBridgeSoA.constructionSeed[ eid ] = 0;
        SkinnedMeshBridgeSoA.ditherSample[ eid ] = 0.0;
        SkinnedMeshBridgeSoA.registered[ eid ] = 0;
        SkinnedMeshBridgeSoA.wired[ eid ] = 0;
        SkinnedMeshBridgeSoA.failed[ eid ] = 0;
        SkinnedMeshBridgeSoA.lastFrameIndex[ eid ] = frameIndex | 0;
    }

    return eid;
}

// ─── Public API: registration helpers for SkinnedMesh.js. ────────────────

/**
 * Registers a SkinnedMesh with the telemetry HUD via the skinning telemetry
 * subsystem. Exposed for direct use by 014_SkinnedMesh.js.
 * @param {object} mesh
 * @param {Skeleton} skeleton
 * @param {BufferGeometry} geometry
 * @return {number}
 */
function registerWithTelemetry( mesh, skeleton, geometry ) {
    return SkinningTelemetry.registerMesh( mesh, skeleton, geometry, {} );
}

/**
 * Registers a SkinnedMesh with the cache manager. Exposed for direct use
 * by 014_SkinnedMesh.js.
 * @param {Skeleton} skeleton
 * @param {BufferGeometry} geometry
 * @param {number} bonesPerVertex
 * @param {number} layout
 * @param {object} payload
 * @return {object}
 */
function registerWithCache( skeleton, geometry, bonesPerVertex, layout, payload ) {
    const key = CacheManager.makeCacheKey( skeleton, geometry, bonesPerVertex, layout );

    return CacheManager.store( key, payload, _frameIndex );
}

/**
 * Registers a SkinnedMesh with the bone LOD selection system.
 * @param {Skeleton} skeleton
 * @return {number}
 */
function registerWithBoneLOD( skeleton ) {
    return BoneLOD.registerSkeleton( skeleton, {
        skeletonHash: _hashString( skeleton.uuid !== undefined ? skeleton.uuid : '' )
    } );
}

/**
 * Registers a SkinnedMesh with the bone distance culling system.
 * @param {Skeleton} skeleton
 * @return {number}
 */
function registerWithBoneCull( skeleton ) {
    return BoneCulling.registerSkeleton( skeleton, {
        skeletonHash: _hashString( skeleton.uuid !== undefined ? skeleton.uuid : '' )
    } );
}

// ─── Public API: validation helpers for SkinnedMesh.js. ──────────────────

/**
 * Returns whether the skeleton passes validation without errors.
 * @param {Skeleton} skeleton
 * @return {boolean}
 */
function isSkeletonValid( skeleton ) {
    if ( skeleton === undefined || skeleton === null || skeleton.bones === undefined || skeleton.bones.length === 0 ) {
        return false;
    }

    const root = skeleton.bones[ 0 ];

    const report = Validator.validate( root, { frameIndex: _frameIndex } );

    return report.worstSeverity < 3;
}

/**
 * Returns whether the geometry already has skin weights.
 * @param {BufferGeometry} geometry
 * @return {boolean}
 */
function hasSkinWeights( geometry ) {
    if ( geometry === undefined || geometry === null ) return false;

    return geometry.attributes[ Layout.ATTR_SKIN_WEIGHT ] !== undefined;
}

// ─── Public API: exports namespace. ──────────────────────────────────────

/**
 * Returns the entire companion set as a single namespaced object.
 * @return {object}
 */
function getCompanionSet() {
    return {
        Defaults: Defaults,
        Walker: Walker,
        Validator: Validator,
        Archetypes: Archetypes,
        Builder: Builder,
        Normalizer: Normalizer,
        Layout: Layout,
        AutoAssign: AutoAssign,
        Overlap: Overlap,
        Compressor: Compressor,
        Topology: Topology,
        ArbitraryTopology: ArbitraryTopology,
        CacheManager: CacheManager,
        SkinningTelemetry: SkinningTelemetry,
        Presets: Presets,
        BoneLOD: BoneLOD,
        BoneCulling: BoneCulling
    };
}

// ─── Internal: reset assembly result. ─────────────────────────────────────

function _resetAssemblyResult() {
    _assemblyResult.meshId = - 1;
    _assemblyResult.geometryUuidHash = 0;
    _assemblyResult.skeletonUuidHash = 0;
    _assemblyResult.wiringSteps = 0;
    _assemblyResult.hierarchyBuilt = false;
    _assemblyResult.hierarchyValidated = false;
    _assemblyResult.layoutChosen = false;
    _assemblyResult.weightsAssigned = false;
    _assemblyResult.weightsNormalized = false;
    _assemblyResult.overlapApplied = false;
    _assemblyResult.weightsCompressed = false;
    _assemblyResult.topologyAdapted = false;
    _assemblyResult.telemetryRegistered = false;
    _assemblyResult.cacheRegistered = false;
    _assemblyResult.boneLODRegistered = false;
    _assemblyResult.boneCullRegistered = false;
    _assemblyResult.constructionMs = 0.0;
    _assemblyResult.assemblyMs = 0.0;
    _assemblyResult.validationMs = 0.0;
    _assemblyResult.weightMs = 0.0;
    _assemblyResult.compressionMs = 0.0;
    _assemblyResult.topologyMs = 0.0;
    _assemblyResult.registrationMs = 0.0;
    _assemblyResult.estimatedTotalBytes = 0.0;
    _assemblyResult.estimatedBoneOps = 0.0;
    _assemblyResult.estimatedVertexOps = 0.0;
    _assemblyResult.failed = false;
}

function _emptyLedger() {
    return {
        meshId: - 1,
        wiringSteps: 0,
        wired: false,
        failed: false,
        constructionMs: 0.0,
        estimatedTotalBytes: 0.0,
        estimatedBoneOps: 0.0,
        estimatedVertexOps: 0.0
    };
}

// ─── Internal: helpers. ───────────────────────────────────────────────────

function _getCurrentTier() {
    try {
        const tier = SkinningCostMultiplierLOD.getAndroidTier();
        if ( tier >= 1 && tier <= 4 ) return tier;
    } catch ( e ) {
        void e;
    }

    return Presets.getCurrentTier();
}

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
void Skeleton;
void BufferGeometry;
void Matrix4;
void Vector3;
void DeterminismSeedLOD;
void SeedStream;
void FreezeWakeLOD;
void TelemetryBudgetHUDLOD;
void StreamingGeometryCacheLOD;
void _scratchVec4;
void _scratchVec4B;
void _scratchVec4C;
void _scratchVec4D;
void _scratchVec3A;
void _scratchVec3B;
void _scratchMat4;

// ─── Internal helper referenced before definition. ───────────────────────

function SkinningPresetsDefaultsSeed() {
    return SkinnedMeshBridgeDefaults.determinismSeed;
}

// ─── gl-matrix packing for telemetry. ────────────────────────────────────

/**
 * Packs the bridge ledger for a mesh id into a vec4.
 * Layout: (wiringSteps, constructionMs, estimatedTotalBytes, estimatedVertexOps)
 * @param {number} meshId
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packBridgeVec4( meshId, out ) {
    const v = out || _scratchVec4;
    const eid = _ecsBridgeByMeshId.get( meshId );

    if ( eid === undefined ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinnedMeshBridgeSoA.wiringSteps[ eid ],
        SkinnedMeshBridgeSoA.constructionMs[ eid ],
        SkinnedMeshBridgeSoA.estimatedTotalBytes[ eid ],
        SkinnedMeshBridgeSoA.estimatedVertexOps[ eid ]
    );
    return v;
}

/**
 * Packs construction timing breakdown into a vec4.
 * Layout: (assemblyMs, validationMs, weightMs, compressionMs)
 * @param {number} meshId
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packConstructionTimingVec4( meshId, out ) {
    const v = out || _scratchVec4B;
    const eid = _ecsBridgeByMeshId.get( meshId );

    if ( eid === undefined ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinnedMeshBridgeSoA.assemblyMs[ eid ],
        SkinnedMeshBridgeSoA.validationMs[ eid ],
        SkinnedMeshBridgeSoA.weightMs[ eid ],
        SkinnedMeshBridgeSoA.compressionMs[ eid ]
    );
    return v;
}

/**
 * Packs topology / registration timing into a vec4.
 * Layout: (topologyMs, registrationMs, estimatedBoneOps, ditherSample)
 * @param {number} meshId
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packRegistrationTimingVec4( meshId, out ) {
    const v = out || _scratchVec4C;
    const eid = _ecsBridgeByMeshId.get( meshId );

    if ( eid === undefined ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinnedMeshBridgeSoA.topologyMs[ eid ],
        SkinnedMeshBridgeSoA.registrationMs[ eid ],
        SkinnedMeshBridgeSoA.estimatedBoneOps[ eid ],
        SkinnedMeshBridgeSoA.ditherSample[ eid ]
    );
    return v;
}

/**
 * Packs the merged defaults facade into a vec4.
 * Layout: (bonesPerVertex, quality, weightLayout, androidTier)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packDefaultsVec4( out ) {
    const v = out || _scratchVec4D;
    const d = getSkinnedMeshDefaults();

    glMatrix.vec4.set(
        v,
        d.bonesPerVertex,
        d.quality,
        d.weightLayout,
        d.androidTier
    );
    return v;
}

// ─── Named re-exports (flat). ────────────────────────────────────────────

export {
    // Bridge API.
    SkinnedMeshBridgeDefaults,
    SkinnedMeshBridgeSoA,
    WiringStep,
    assemble,
    update,
    endFrame,
    getBridgeLedger,
    getLedgerForMeshId,
    getBridgeEntityForMeshId,
    computeConstructionCostHighPrecision,
    computeSceneBytesHighPrecision,
    computeSceneVertexOpsHighPrecision,
    getAggregatedStats,
    getSkinnedMeshDefaults,
    notifyTierChange,
    notifyPressure,
    notifyFreezeState,
    beginFrame,
    endFrameAll,
    registerWithTelemetry,
    registerWithCache,
    registerWithBoneLOD,
    registerWithBoneCull,
    isSkeletonValid,
    hasSkinWeights,
    getCompanionSet,
    packBridgeVec4,
    packConstructionTimingVec4,
    packRegistrationTimingVec4,
    packDefaultsVec4,

    // Flat companion re-exports (namespace form).
    Defaults,
    Walker,
    Validator,
    Archetypes,
    Builder,
    Normalizer,
    Layout,
    AutoAssign,
    Overlap,
    Compressor,
    Topology,
    ArbitraryTopology,
    CacheManager,
    SkinningTelemetry,
    Presets,
    BoneLOD,
    BoneCulling
};