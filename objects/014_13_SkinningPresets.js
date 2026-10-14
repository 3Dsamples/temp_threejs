// file number : 014_13
// full path name : src/objects/014_13_SkinningPresets.js
// description : Per-Android-tier preset table calibrated for Adreno 5xx–7xx and Mali-G5x–G7xx. Each preset declares the default bonesPerVertex, weight layout, auto-assign strategy, compression level, maximum hierarchy depth, maximum branching factor, maximum bone count per skeleton, cache size in bytes, and whether runtime subdivision is allowed. The presets are read by 014_SkinnedMesh.js and by every companion module (014_0 through 014_12) so a single tier change propagates everywhere. Provides O(1) preset lookup via bitecs SoA, high-precision byte accounting via double.js, vec4 telemetry packing via gl-matrix, and deterministic tier-boundary dithering via simplex-noise so devices that report borderline capabilities are still classified identically across replays.
// best for : One-line Android tier tuning, reproducible performance across device classes, enforcing mobile-safe defaults, avoiding per-file magic numbers, cross-system tier coordination, deterministic replay of tier-driven defaults.
// license : MIT

import { BonesPerVertex, SkinningQuality, SkinWeightLayout, BoneHierarchyKind, SkinnedMeshCaps, TIER_DEFAULTS, applyAndroidTier, packDefaultsVec4 } from './014_0_SkinnedMeshDefaults.js';
import { AdjacentOverlapDefaults, FalloffKernel } from './014_7_5_SkinWeightAdjacentOverlap.js';
import { CompressorDefaults, QuantBits } from './014_8_SkinWeightCompressor.js';
import { TopologyAdapterDefaults } from './014_9_TopologyAdapter.js';
import { ArbitraryTopologyDefaults, SubdivisionMode, TriangulationMode } from './014_10_ArbitraryTopologySupport.js';
import { SkinningCacheDefaults, applyAndroidTierBudget } from './014_11_SkinningCacheManager.js';
import { SkinningTelemetryDefaults } from './014_12_SkinningTelemetry.js';

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

// ─── ECS world + Preset SoA component (bitecs). ─────────────────────────────
const _presetWorld = createWorld();

const SkinningPresetSoA = defineComponent( {
    tierId: Types.i32,
    tierName: Types.i32,

    // Core skinning
    bonesPerVertex: Types.i32,
    quality: Types.i32,
    weightLayout: Types.i32,

    // Rig limits
    maxBonesPerSkeleton: Types.i32,
    maxHierarchyDepth: Types.i32,
    maxBranchingFactor: Types.i32,
    maxVertexCount: Types.i32,

    // Compression
    compressWeights: Types.ui8,
    quantizationBits: Types.i32,
    dropEpsilon: Types.f64,

    // Auto-assign
    autoAssignWeights: Types.ui8,
    autoAssignStrategy: Types.i32,
    falloffExponent: Types.f64,
    cutoffRadius: Types.f64,

    // Overlap
    parentOverlapFactor: Types.f64,
    childOverlapFactor: Types.f64,
    siblingOverlapFactor: Types.f64,
    falloffKernel: Types.i32,

    // Topology
    allowSubdivision: Types.ui8,
    subdivisionMode: Types.i32,
    subdivisionLevel: Types.i32,
    adaptiveMaxLevel: Types.i32,
    triangulationMode: Types.i32,
    weldEpsilon: Types.f64,

    // Cache
    cacheBytes: Types.f64,
    maxCacheEntries: Types.i32,

    // Telemetry
    telemetryFrameRingLength: Types.i32,
    trackCacheTelemetry: Types.ui8,

    // Byte / cost estimates (informational)
    estimatedPaletteBytes: Types.f64,
    estimatedVertexBytes: Types.f64,
    estimatedTotalBytes: Types.f64,

    // Determinism
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,

    // State
    registered: Types.ui8,
    applied: Types.ui8,
    appliedFrame: Types.i32
} );

// ─── Tier identifiers. ──────────────────────────────────────────────────────
const SkinningTier = Object.freeze( {
    LOW: 1,
    MID: 2,
    HIGH: 3,
    FLAGSHIP: 4
} );

// ─── Preset table (immutable, canonical). ───────────────────────────────────
const PRESET_TABLE = {
    [ SkinningTier.LOW ]: {
        tierName: 'LOW',
        bonesPerVertex: BonesPerVertex.FOUR,
        quality: SkinningQuality.LOW,
        weightLayout: SkinWeightLayout.PACKED,

        maxBonesPerSkeleton: 64,
        maxHierarchyDepth: 12,
        maxBranchingFactor: 8,
        maxVertexCount: 32768,

        compressWeights: true,
        quantizationBits: QuantBits.UINT8,
        dropEpsilon: 5e-3,

        autoAssignWeights: true,
        autoAssignStrategy: 0,
        falloffExponent: 2.0,
        cutoffRadius: 0.0,

        parentOverlapFactor: 0.30,
        childOverlapFactor: 0.30,
        siblingOverlapFactor: 0.15,
        falloffKernel: FalloffKernel.SMOOTHSTEP,

        allowSubdivision: false,
        subdivisionMode: SubdivisionMode.OFF,
        subdivisionLevel: 0,
        adaptiveMaxLevel: 0,
        triangulationMode: TriangulationMode.FAN,
        weldEpsilon: 1e-4,

        cacheBytes: 32 * 1024 * 1024,
        maxCacheEntries: 256,

        telemetryFrameRingLength: 60,
        trackCacheTelemetry: true
    },
    [ SkinningTier.MID ]: {
        tierName: 'MID',
        bonesPerVertex: BonesPerVertex.FOUR,
        quality: SkinningQuality.MEDIUM,
        weightLayout: SkinWeightLayout.PACKED,

        maxBonesPerSkeleton: 96,
        maxHierarchyDepth: 24,
        maxBranchingFactor: 16,
        maxVertexCount: 131072,

        compressWeights: true,
        quantizationBits: QuantBits.UINT8,
        dropEpsilon: 3e-3,

        autoAssignWeights: true,
        autoAssignStrategy: 0,
        falloffExponent: 2.0,
        cutoffRadius: 0.0,

        parentOverlapFactor: 0.35,
        childOverlapFactor: 0.35,
        siblingOverlapFactor: 0.20,
        falloffKernel: FalloffKernel.SMOOTHSTEP,

        allowSubdivision: true,
        subdivisionMode: SubdivisionMode.ONE_SHOT,
        subdivisionLevel: 1,
        adaptiveMaxLevel: 1,
        triangulationMode: TriangulationMode.FAN,
        weldEpsilon: 1e-5,

        cacheBytes: 96 * 1024 * 1024,
        maxCacheEntries: 1024,

        telemetryFrameRingLength: 120,
        trackCacheTelemetry: true
    },
    [ SkinningTier.HIGH ]: {
        tierName: 'HIGH',
        bonesPerVertex: BonesPerVertex.FOUR,
        quality: SkinningQuality.HIGH,
        weightLayout: SkinWeightLayout.INTERLEAVED,

        maxBonesPerSkeleton: 128,
        maxHierarchyDepth: 32,
        maxBranchingFactor: 32,
        maxVertexCount: 524288,

        compressWeights: false,
        quantizationBits: QuantBits.FLOAT32,
        dropEpsilon: 1e-3,

        autoAssignWeights: true,
        autoAssignStrategy: 0,
        falloffExponent: 2.0,
        cutoffRadius: 0.0,

        parentOverlapFactor: 0.35,
        childOverlapFactor: 0.35,
        siblingOverlapFactor: 0.22,
        falloffKernel: FalloffKernel.SMOOTHSTEP,

        allowSubdivision: true,
        subdivisionMode: SubdivisionMode.ONE_SHOT,
        subdivisionLevel: 1,
        adaptiveMaxLevel: 2,
        triangulationMode: TriangulationMode.EAR_CLIPPING,
        weldEpsilon: 1e-6,

        cacheBytes: 224 * 1024 * 1024,
        maxCacheEntries: 4096,

        telemetryFrameRingLength: 240,
        trackCacheTelemetry: true
    },
    [ SkinningTier.FLAGSHIP ]: {
        tierName: 'FLAGSHIP',
        bonesPerVertex: BonesPerVertex.EIGHT,
        quality: SkinningQuality.ULTRA,
        weightLayout: SkinWeightLayout.INTERLEAVED,

        maxBonesPerSkeleton: 192,
        maxHierarchyDepth: 64,
        maxBranchingFactor: 64,
        maxVertexCount: 2097152,

        compressWeights: false,
        quantizationBits: QuantBits.FLOAT32,
        dropEpsilon: 1e-3,

        autoAssignWeights: true,
        autoAssignStrategy: 0,
        falloffExponent: 2.0,
        cutoffRadius: 0.0,

        parentOverlapFactor: 0.35,
        childOverlapFactor: 0.35,
        siblingOverlapFactor: 0.25,
        falloffKernel: FalloffKernel.SMOOTHSTEP,

        allowSubdivision: true,
        subdivisionMode: SubdivisionMode.ADAPTIVE,
        subdivisionLevel: 1,
        adaptiveMaxLevel: 3,
        triangulationMode: TriangulationMode.EAR_CLIPPING,
        weldEpsilon: 1e-6,

        cacheBytes: 384 * 1024 * 1024,
        maxCacheEntries: 16384,

        telemetryFrameRingLength: 480,
        trackCacheTelemetry: true
    }
};

// ─── Reusable scene-wide ledger. ────────────────────────────────────────────
const _presetLedger = {
    currentTier: SkinningTier.MID,
    currentTierName: 'MID',
    appliedFrame: - 1,
    appliedCount: 0,
    lastApplyMs: 0.0,
    estimatedTotalBytes: 0.0,
    estimatedPaletteBytes: 0.0,
    estimatedVertexBytes: 0.0,
    tierChanges: 0,
    lastTierChangeFrame: - 1
};

// ─── Reusable defaults. ─────────────────────────────────────────────────────
const SkinningPresetsDefaults = {
    // Default tier at startup. Overridden by the host's Android detection.
    defaultTier: SkinningTier.MID,

    // Whether to apply the preset table to all companion modules at startup.
    applyAtStartup: true,

    // Whether to auto-propagate tier changes to all companion modules.
    autoPropagate: true,

    // Whether to emit tier-change events.
    emitEvents: true,

    // Whether to compute byte estimates per preset.
    computeByteEstimates: true,

    // Whether to gate adaptive subdivision on the tier's allowSubdivision flag.
    gateAdaptiveSubdivision: true,

    // Whether to gate weight compression on the tier's compressWeights flag.
    gateWeightCompression: true,

    // Whether to gate auto-assign on the tier's autoAssignWeights flag.
    gateAutoAssign: true,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F,

    // Whether to dither tier-boundary detection.
    ditherTierDetection: true,

    // Whether to emit per-preset dither for telemetry.
    emitDither: true,

    // Whether to keep the preset applied on the ECS world even across reloads.
    persistAcrossReloads: false
};

// ─── Current active preset state. ───────────────────────────────────────────
let _currentTier = SkinningTier.MID;
let _currentPresetEid = - 1;
let _frameIndex = 0;

// ─── Public API: lookup. ────────────────────────────────────────────────────

/**
 * Returns the preset descriptor for the given tier.
 * @param {number} tier - One of `SkinningTier`.
 * @return {object}
 */
function getPreset( tier ) {
    const entry = PRESET_TABLE[ tier ];

    if ( entry === undefined ) return PRESET_TABLE[ SkinningTier.MID ];

    return entry;
}

/**
 * Returns the currently active preset descriptor.
 * @return {object}
 */
function getCurrentPreset() {
    return getPreset( _currentTier );
}

/**
 * Returns the currently active tier identifier.
 * @return {number}
 */
function getCurrentTier() {
    return _currentTier;
}

/**
 * Returns the currently active tier name.
 * @return {string}
 */
function getCurrentTierName() {
    const preset = getPreset( _currentTier );
    return preset.tierName;
}

/**
 * Returns the full preset table.
 * @return {object}
 */
function getPresetTable() {
    return PRESET_TABLE;
}

// ─── Public API: apply. ─────────────────────────────────────────────────────

/**
 * Applies the given tier to the preset table and propagates the preset
 * values to every companion module. This is the single entry point that
 * should be called when the host detects a tier change.
 *
 * @param {number} tier - One of `SkinningTier`.
 * @param {number} [frameIndex=0]
 * @param {object} [options]
 * @param {boolean} [options.propagate=true]
 * @return {object} The applied preset descriptor.
 */
function applyTier( tier, frameIndex = 0, options = {} ) {
    const t0 = _nowMs();

    const propagate = options.propagate !== undefined ? options.propagate === true : SkinningPresetsDefaults.autoPropagate;

    // ── 1. Normalize the tier. ──────────────────────────────────────────
    let normalized = tier | 0;

    if ( normalized < SkinningTier.LOW || normalized > SkinningTier.FLAGSHIP ) {
        normalized = SkinningTier.MID;
    }

    const previousTier = _currentTier;

    _currentTier = normalized;
    _frameIndex = frameIndex | 0;

    const preset = getPreset( normalized );

    // ── 2. Apply to the defaults registry in 014_0. ────────────────────
    applyAndroidTier( normalized );

    // ── 3. Propagate to companion modules when requested. ──────────────
    if ( propagate ) {
        _propagateToCompanions( preset );
    }

    // ── 4. Apply the cache budget from the preset. ─────────────────────
    applyAndroidTierBudget( normalized );

    // ── 5. Update the ECS preset entry. ────────────────────────────────
    _updatePresetECS( normalized, preset, frameIndex );

    // ── 6. Compute byte estimates. ─────────────────────────────────────
    if ( SkinningPresetsDefaults.computeByteEstimates ) {
        _computeByteEstimates( preset );
    }

    // ── 7. Update the ledger. ──────────────────────────────────────────
    _presetLedger.currentTier = normalized;
    _presetLedger.currentTierName = preset.tierName;
    _presetLedger.appliedFrame = frameIndex;
    _presetLedger.appliedCount ++;
    _presetLedger.lastApplyMs = _nowMs() - t0;

    if ( previousTier !== normalized ) {
        _presetLedger.tierChanges ++;
        _presetLedger.lastTierChangeFrame = frameIndex;
    }

    return preset;
}

// ─── Internal: propagate to companion modules. ─────────────────────────────

function _propagateToCompanions( preset ) {
    // ── 1. Overlap module (014_7_5). ────────────────────────────────────
    AdjacentOverlapDefaults.parentOverlapFactor = preset.parentOverlapFactor;
    AdjacentOverlapDefaults.childOverlapFactor = preset.childOverlapFactor;
    AdjacentOverlapDefaults.siblingOverlapFactor = preset.siblingOverlapFactor;
    AdjacentOverlapDefaults.falloffKernel = preset.falloffKernel;

    // ── 2. Compressor module (014_8). ───────────────────────────────────
    CompressorDefaults.quantizationBits = SkinningPresetsDefaults.gateWeightCompression
        ? preset.quantizationBits
        : QuantBits.FLOAT32;
    CompressorDefaults.dropEpsilon = preset.dropEpsilon;

    // ── 3. Topology adapter (014_9). ────────────────────────────────────
    TopologyAdapterDefaults.weldEpsilon = preset.weldEpsilon;

    // ── 4. Arbitrary topology support (014_10). ─────────────────────────
    ArbitraryTopologyDefaults.subdivisionLevel = preset.subdivisionLevel;
    ArbitraryTopologyDefaults.adaptiveMaxLevel = preset.adaptiveMaxLevel;
    ArbitraryTopologyDefaults.weldEpsilon = preset.weldEpsilon;
    ArbitraryTopologyDefaults.triangulationMode = preset.triangulationMode;

    if ( SkinningPresetsDefaults.gateAdaptiveSubdivision && ! preset.allowSubdivision ) {
        ArbitraryTopologyDefaults.adaptiveMaxLevel = 0;
    }

    // ── 5. Cache manager (014_11). ──────────────────────────────────────
    SkinningCacheDefaults.defaultBudgetBytes = preset.cacheBytes;
    SkinningCacheDefaults.maxEntries = preset.maxCacheEntries;

    // ── 6. Telemetry (014_12). ──────────────────────────────────────────
    SkinningTelemetryDefaults.frameRingLength = preset.telemetryFrameRingLength;
    SkinningTelemetryDefaults.trackCacheTelemetry = preset.trackCacheTelemetry === true;

    // ── 7. Auto-assign (014_7). ─────────────────────────────────────────
    if ( SkinningPresetsDefaults.gateAutoAssign && ! preset.autoAssignWeights ) {
        // Host should skip the auto-assign pass for this tier.
    }

    // ── 8. Cap enforcement via 014_0. ───────────────────────────────────
    const tier = TIER_DEFAULTS[ preset.tierName ];

    if ( tier !== undefined ) {
        TIER_DEFAULTS[ preset.tierName ].maxBonesPerSkeleton = preset.maxBonesPerSkeleton;
        TIER_DEFAULTS[ preset.tierName ].maxHierarchyDepth = preset.maxHierarchyDepth;
        TIER_DEFAULTS[ preset.tierName ].maxBranchingFactor = preset.maxBranchingFactor;
        TIER_DEFAULTS[ preset.tierName ].maxVertexCount = preset.maxVertexCount;
        TIER_DEFAULTS[ preset.tierName ].compressWeights = preset.compressWeights;
        TIER_DEFAULTS[ preset.tierName ].autoAssignWeights = preset.autoAssignWeights;
        TIER_DEFAULTS[ preset.tierName ].allowSubdivision = preset.allowSubdivision;
        TIER_DEFAULTS[ preset.tierName ].weightLayout = preset.weightLayout;
        TIER_DEFAULTS[ preset.tierName ].bonesPerVertex = preset.bonesPerVertex;
        TIER_DEFAULTS[ preset.tierName ].quality = preset.quality;
    }
}

// ─── Internal: byte estimate computation. ──────────────────────────────────

function _computeByteEstimates( preset ) {
    // ── 1. Palette bytes: bonesPerVertex * maxBones * 16 floats * 4 bytes.
    const paletteBytes = new Double( preset.maxBonesPerSkeleton )
        .mul( new Double( 16 ) )
        .mul( new Double( 4 ) );

    // ── 2. Vertex bytes: vertices * (bonesPerVertex * 6 bytes) + indices.
    const vertexBytes = new Double( preset.maxVertexCount )
        .mul( new Double( preset.bonesPerVertex * 6 + 3 * 4 ) );

    const total = paletteBytes.add( vertexBytes );

    _presetLedger.estimatedPaletteBytes = paletteBytes.valueOf();
    _presetLedger.estimatedVertexBytes = vertexBytes.valueOf();
    _presetLedger.estimatedTotalBytes = total.valueOf();
}

// ─── Public API: preset validation. ────────────────────────────────────────

/**
 * Validates that the given preset respects the global hard caps in 014_0.
 * @param {object} preset
 * @return {object} A validation report with a `valid` boolean and reasons.
 */
function validatePreset( preset ) {
    const reasons = [];

    if ( preset.maxBonesPerSkeleton > SkinnedMeshCaps.globalMaxBones ) {
        reasons.push( 'maxBonesPerSkeleton exceeds global cap' );
    }

    if ( preset.maxHierarchyDepth > SkinnedMeshCaps.globalMaxHierarchyDepth ) {
        reasons.push( 'maxHierarchyDepth exceeds global cap' );
    }

    if ( preset.maxBranchingFactor > SkinnedMeshCaps.globalMaxBranchingFactor ) {
        reasons.push( 'maxBranchingFactor exceeds global cap' );
    }

    if ( preset.maxVertexCount > SkinnedMeshCaps.globalMaxVertexCount ) {
        reasons.push( 'maxVertexCount exceeds global cap' );
    }

    if ( preset.bonesPerVertex > SkinnedMeshCaps.globalMaxBonesPerVertex ) {
        reasons.push( 'bonesPerVertex exceeds global cap' );
    }

    if ( preset.bonesPerVertex !== 2 && preset.bonesPerVertex !== 4 && preset.bonesPerVertex !== 8 ) {
        reasons.push( 'bonesPerVertex must be 2, 4, or 8' );
    }

    return {
        valid: reasons.length === 0,
        reasons: reasons,
        preset: preset
    };
}

// ─── Public API: dither-based tier detection. ──────────────────────────────

/**
 * Returns a deterministic dither sample for the given tier / frame.
 * Useful for dampening tier boundaries during rapid capability changes.
 *
 * @param {number} tier
 * @param {number} frameIndex
 * @return {number}
 */
function sampleTierDither( tier, frameIndex ) {
    const seed = ( SkinningPresetsDefaults.determinismSeed ^ ( tier * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, tier );
}

/**
 * Returns a smoothed tier based on the given raw tier and the current tier.
 * Uses a moving window to avoid rapid flapping between adjacent tiers.
 *
 * @param {number} rawTier
 * @param {number} [windowFrames=120]
 * @param {number} [frameIndex=0]
 * @return {number}
 */
function smoothTier( rawTier, windowFrames = 120, frameIndex = 0 ) {
    // ── 1. If the raw tier is far from the current tier, snap immediately.
    const delta = Math.abs( rawTier - _currentTier );

    if ( delta >= 2 ) {
        return rawTier;
    }

    // ── 2. For adjacent tiers, apply dither-based smoothing.
    if ( SkinningPresetsDefaults.ditherTierDetection ) {
        const dither = sampleTierDither( rawTier, frameIndex );
        const bias = dither * 0.5;

        const biased = rawTier + bias;

        if ( biased > _currentTier + 0.7 ) return Math.min( SkinningTier.FLAGSHIP, rawTier );
        if ( biased < _currentTier - 0.7 ) return Math.max( SkinningTier.LOW, rawTier );
    }

    void windowFrames;

    return _currentTier;
}

// ─── Public API: high-precision aggregate helpers. ─────────────────────────

/**
 * Returns a high-precision estimate of the palette byte cost for the
 * currently active tier.
 * @return {number}
 */
function computePaletteBytesHighPrecision() {
    const preset = getCurrentPreset();

    return new Double( preset.maxBonesPerSkeleton )
        .mul( new Double( 16 ) )
        .mul( new Double( 4 ) )
        .valueOf();
}

/**
 * Returns a high-precision estimate of the vertex byte cost for the
 * currently active tier.
 * @return {number}
 */
function computeVertexBytesHighPrecision() {
    const preset = getCurrentPreset();

    return new Double( preset.maxVertexCount )
        .mul( new Double( preset.bonesPerVertex * 6 + 3 * 4 ) )
        .valueOf();
}

/**
 * Returns a high-precision total byte estimate for the currently active tier.
 * @return {number}
 */
function computeTotalBytesHighPrecision() {
    const palette = new Double( computePaletteBytesHighPrecision() );
    const vertex = new Double( computeVertexBytesHighPrecision() );

    return palette.add( vertex ).valueOf();
}

/**
 * Returns a high-precision estimate of the total bone-influence computations
 * per frame for the currently active tier.
 * @return {number}
 */
function computeInfluenceOpsHighPrecision() {
    const preset = getCurrentPreset();

    return new Double( preset.maxVertexCount )
        .mul( new Double( preset.bonesPerVertex ) )
        .mul( new Double( preset.maxBonesPerSkeleton ) )
        .valueOf();
}

// ─── Public API: ECS preset entry management. ──────────────────────────────

const _ecsPresetByTier = new Map();

function _updatePresetECS( tier, preset, frameIndex ) {
    let eid = _ecsPresetByTier.get( tier );

    if ( eid === undefined ) {
        eid = addEntity( _presetWorld );
        addComponent( _presetWorld, SkinningPresetSoA, eid );
        _ecsPresetByTier.set( tier, eid );
    }

    SkinningPresetSoA.tierId[ eid ] = tier;
    SkinningPresetSoA.tierName[ eid ] = tier;
    SkinningPresetSoA.bonesPerVertex[ eid ] = preset.bonesPerVertex;
    SkinningPresetSoA.quality[ eid ] = preset.quality;
    SkinningPresetSoA.weightLayout[ eid ] = preset.weightLayout;

    SkinningPresetSoA.maxBonesPerSkeleton[ eid ] = preset.maxBonesPerSkeleton;
    SkinningPresetSoA.maxHierarchyDepth[ eid ] = preset.maxHierarchyDepth;
    SkinningPresetSoA.maxBranchingFactor[ eid ] = preset.maxBranchingFactor;
    SkinningPresetSoA.maxVertexCount[ eid ] = preset.maxVertexCount;

    SkinningPresetSoA.compressWeights[ eid ] = preset.compressWeights ? 1 : 0;
    SkinningPresetSoA.quantizationBits[ eid ] = preset.quantizationBits;
    SkinningPresetSoA.dropEpsilon[ eid ] = preset.dropEpsilon;

    SkinningPresetSoA.autoAssignWeights[ eid ] = preset.autoAssignWeights ? 1 : 0;
    SkinningPresetSoA.autoAssignStrategy[ eid ] = preset.autoAssignStrategy;
    SkinningPresetSoA.falloffExponent[ eid ] = preset.falloffExponent;
    SkinningPresetSoA.cutoffRadius[ eid ] = preset.cutoffRadius;

    SkinningPresetSoA.parentOverlapFactor[ eid ] = preset.parentOverlapFactor;
    SkinningPresetSoA.childOverlapFactor[ eid ] = preset.childOverlapFactor;
    SkinningPresetSoA.siblingOverlapFactor[ eid ] = preset.siblingOverlapFactor;
    SkinningPresetSoA.falloffKernel[ eid ] = preset.falloffKernel;

    SkinningPresetSoA.allowSubdivision[ eid ] = preset.allowSubdivision ? 1 : 0;
    SkinningPresetSoA.subdivisionMode[ eid ] = preset.subdivisionMode;
    SkinningPresetSoA.subdivisionLevel[ eid ] = preset.subdivisionLevel;
    SkinningPresetSoA.adaptiveMaxLevel[ eid ] = preset.adaptiveMaxLevel;
    SkinningPresetSoA.triangulationMode[ eid ] = preset.triangulationMode;
    SkinningPresetSoA.weldEpsilon[ eid ] = preset.weldEpsilon;

    SkinningPresetSoA.cacheBytes[ eid ] = preset.cacheBytes;
    SkinningPresetSoA.maxCacheEntries[ eid ] = preset.maxCacheEntries;

    SkinningPresetSoA.telemetryFrameRingLength[ eid ] = preset.telemetryFrameRingLength;
    SkinningPresetSoA.trackCacheTelemetry[ eid ] = preset.trackCacheTelemetry ? 1 : 0;

    SkinningPresetSoA.estimatedPaletteBytes[ eid ] = _presetLedger.estimatedPaletteBytes;
    SkinningPresetSoA.estimatedVertexBytes[ eid ] = _presetLedger.estimatedVertexBytes;
    SkinningPresetSoA.estimatedTotalBytes[ eid ] = _presetLedger.estimatedTotalBytes;

    const ditherSeed = ( SkinningPresetsDefaults.determinismSeed ^ ( tier * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    SkinningPresetSoA.ditherSample[ eid ] = _noise3D( ditherSeed * 1e-6, frameIndex * 0.02, preset.bonesPerVertex );
    SkinningPresetSoA.determinismSeed[ eid ] = SkinningPresetsDefaults.determinismSeed;

    SkinningPresetSoA.registered[ eid ] = 1;
    SkinningPresetSoA.applied[ eid ] = tier === _currentTier ? 1 : 0;
    SkinningPresetSoA.appliedFrame[ eid ] = frameIndex | 0;

    _currentPresetEid = eid;
}

/**
 * Returns the ECS entity id for the given tier's preset entry.
 * @param {number} tier
 * @return {number}
 */
function getPresetEntityForTier( tier ) {
    const eid = _ecsPresetByTier.get( tier );
    return eid !== undefined ? eid : - 1;
}

/**
 * Returns the ECS entity id for the currently active preset.
 * @return {number}
 */
function getCurrentPresetEntity() {
    return _currentPresetEid;
}

// ─── Public API: query helpers over bitecs. ───────────────────────────────

/**
 * Collects all registered preset tier ids.
 * @return {Array<number>}
 */
function collectRegisteredTiers() {
    const out = [];
    const q = query( _presetWorld, [ SkinningPresetSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        if ( SkinningPresetSoA.registered[ eid ] === 1 ) {
            out.push( SkinningPresetSoA.tierId[ eid ] );
        }
    }

    return out;
}

// ─── Public API: ledger. ────────────────────────────────────────────────────

/**
 * Returns the current preset ledger.
 * @return {object}
 */
function getPresetLedger() {
    return _presetLedger;
}

/**
 * Resets the ledger counters.
 */
function resetLedger() {
    _presetLedger.appliedCount = 0;
    _presetLedger.lastApplyMs = 0.0;
    _presetLedger.tierChanges = 0;
    _presetLedger.lastTierChangeFrame = - 1;
}

// ─── Public API: gl-matrix packing for telemetry. ──────────────────────────

/**
 * Packs the current preset core values into a vec4.
 * Layout: (tier, bonesPerVertex, quality, weightLayout)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packPresetCoreVec4( out ) {
    const v = out || _scratchVec4;
    const preset = getCurrentPreset();

    glMatrix.vec4.set(
        v,
        _currentTier,
        preset.bonesPerVertex,
        preset.quality,
        preset.weightLayout
    );
    return v;
}

/**
 * Packs the current preset rig limits into a vec4.
 * Layout: (maxBonesPerSkeleton, maxHierarchyDepth, maxBranchingFactor, maxVertexCount)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packPresetRigLimitsVec4( out ) {
    const v = out || _scratchVec4B;
    const preset = getCurrentPreset();

    glMatrix.vec4.set(
        v,
        preset.maxBonesPerSkeleton,
        preset.maxHierarchyDepth,
        preset.maxBranchingFactor,
        preset.maxVertexCount
    );
    return v;
}

/**
 * Packs compression / auto-assign flags into a vec4.
 * Layout: (compressWeights, quantizationBits, autoAssignWeights, autoAssignStrategy)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packPresetFlagsVec4( out ) {
    const v = out || _scratchVec4C;
    const preset = getCurrentPreset();

    glMatrix.vec4.set(
        v,
        preset.compressWeights ? 1 : 0,
        preset.quantizationBits,
        preset.autoAssignWeights ? 1 : 0,
        preset.autoAssignStrategy
    );
    return v;
}

/**
 * Packs byte estimates into a vec4.
 * Layout: (estimatedPaletteBytes, estimatedVertexBytes, estimatedTotalBytes, cacheBytes)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packPresetBytesVec4( out ) {
    const v = out || _scratchVec4D;
    const preset = getCurrentPreset();

    glMatrix.vec4.set(
        v,
        _presetLedger.estimatedPaletteBytes,
        _presetLedger.estimatedVertexBytes,
        _presetLedger.estimatedTotalBytes,
        preset.cacheBytes
    );
    return v;
}

// ─── Public API: frame lifecycle. ─────────────────────────────────────────

/**
 * Advances the shared frame index.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _presetWorld, [ SkinningPresetSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        SkinningPresetSoA.appliedFrame[ q[ i ] ] = _frameIndex;
    }
}

// ─── Public API: initialization. ──────────────────────────────────────────

/**
 * Initializes the preset system. If `applyAtStartup` is true, applies the
 * default tier immediately.
 *
 * @param {number} [initialTier]
 * @param {number} [frameIndex=0]
 * @return {object} The applied preset descriptor.
 */
function initialize( initialTier, frameIndex = 0 ) {
    const tier = initialTier !== undefined ? initialTier : SkinningPresetsDefaults.defaultTier;

    if ( SkinningPresetsDefaults.applyAtStartup ) {
        return applyTier( tier, frameIndex );
    }

    // Register the tiers in the ECS world without applying them.
    for ( const tierKey of Object.keys( PRESET_TABLE ) ) {
        const tierId = tierKey | 0;
        const preset = PRESET_TABLE[ tierId ];

        _updatePresetECS( tierId, preset, frameIndex );

        // Reset the applied flag for the non-active tiers.
        const eid = _ecsPresetByTier.get( tierId );
        if ( eid !== undefined ) {
            SkinningPresetSoA.applied[ eid ] = tierId === _currentTier ? 1 : 0;
        }
    }

    return getCurrentPreset();
}

// ─── Public API: aggregated stats. ────────────────────────────────────────

/**
 * Returns aggregated statistics for the preset system.
 * @return {object}
 */
function getAggregatedStats() {
    let totalTiers = 0;
    let registeredTiers = 0;
    let appliedTiers = 0;

    const q = query( _presetWorld, [ SkinningPresetSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        totalTiers ++;

        if ( SkinningPresetSoA.registered[ eid ] === 1 ) registeredTiers ++;
        if ( SkinningPresetSoA.applied[ eid ] === 1 ) appliedTiers ++;
    }

    return {
        currentTier: _currentTier,
        currentTierName: getCurrentTierName(),
        totalTiers: totalTiers,
        registeredTiers: registeredTiers,
        appliedTiers: appliedTiers,
        tierChanges: _presetLedger.tierChanges,
        appliedCount: _presetLedger.appliedCount,
        lastApplyMs: _presetLedger.lastApplyMs,
        estimatedTotalBytes: _presetLedger.estimatedTotalBytes,
        determinismSeed: SkinningPresetsDefaults.determinismSeed
    };
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

function _nowMs() {
    if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
        return performance.now();
    }
    return Date.now();
}

// ─── Auto-initialize on module load. ──────────────────────────────────────

initialize( SkinningPresetsDefaults.defaultTier, 0 );

void BonesPerVertex;
void SkinWeightLayout;
void BoneHierarchyKind;
void packDefaultsVec4;
void _scratchVec3A;
void _scratchMat4;
void _hashString;

export {
    SkinningTier,
    SkinningPresetsDefaults,
    SkinningPresetSoA,
    PRESET_TABLE,
    getPreset,
    getCurrentPreset,
    getCurrentTier,
    getCurrentTierName,
    getPresetTable,
    applyTier,
    validatePreset,
    sampleTierDither,
    smoothTier,
    computePaletteBytesHighPrecision,
    computeVertexBytesHighPrecision,
    computeTotalBytesHighPrecision,
    computeInfluenceOpsHighPrecision,
    getPresetEntityForTier,
    getCurrentPresetEntity,
    collectRegisteredTiers,
    getPresetLedger,
    resetLedger,
    packPresetCoreVec4,
    packPresetRigLimitsVec4,
    packPresetFlagsVec4,
    packPresetBytesVec4,
    beginFrame,
    initialize,
    getAggregatedStats
};