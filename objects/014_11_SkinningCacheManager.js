// file number : 014_11
// full path name : src/objects/014_11_SkinningCacheManager.js
// description : Caches the derived skinning artifacts (bone palettes, inverse matrices, normalized weights, topology adjacency, compressed weights, subdivision results, layout conversions, and auto-assign metadata) in a shared LRU keyed by (Skeleton.uuid, geometry.uuid, bonesPerVertex, layout). When a SkinnedMesh is created from a rig that has already been processed, the cache is hit and construction is O(1) instead of re-walking the entire hierarchy and re-normalizing weights. Cache eviction respects the Android tier memory budget from 014_13_SkinningPresets and can be flushed under thermal / battery / memory pressure. Uses bitecs SoA to register every cache entry for O(1) query, double.js for high-precision byte accounting across hundreds of MB of cached rigs, gl-matrix for vec4 telemetry packing, and simplex-noise for deterministic eviction tie-breaking so replays produce identical cache layouts across Android 64-bit devices (Adreno 5xx–7xx, Mali-G5x–G7xx).
// best for : Dense crowds that reuse the same rig, respawning NPCs, scene reloads, streaming character switching, avoiding redundant per-instance work on Android 64-bit, cross-system cache coordination (weights / layout / topology / palette), deterministic replay of cache state.
// license : MIT

import { Skeleton } from './008_Skeleton.js';
import { Bone } from './001_Bone.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';

import { BonesPerVertex, SkinWeightLayout, SkinnedMeshDefaults, SkinnedMeshCaps } from './014_0_SkinnedMeshDefaults.js';
import { ATTR_SKIN_INDEX, ATTR_SKIN_WEIGHT, getLayoutEntityForUuid } from './014_6_SkinWeightLayout.js';
import { SkinWeightNormalizerSoA } from './014_5_SkinWeightNormalizer.js';
import { SkinWeightAutoAssignSoA } from './014_7_SkinWeightAutoAssign.js';
import { SkinWeightAdjacentOverlapSoA } from './014_7_5_SkinWeightAdjacentOverlap.js';
import { SkinWeightCompressorSoA } from './014_8_SkinWeightCompressor.js';
import { TopologyAdapterSoA } from './014_9_TopologyAdapter.js';
import { ArbitraryTopologySoA } from './014_10_ArbitraryTopologySupport.js';

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

// ─── ECS world + CacheEntry SoA component (bitecs). ─────────────────────────
const _cacheWorld = createWorld();

const SkinningCacheEntrySoA = defineComponent( {
    entryId: Types.i32,
    cacheKeyHash: Types.i32,
    skeletonUuidHash: Types.i32,
    geometryUuidHash: Types.i32,
    bonesPerVertex: Types.i32,
    layout: Types.i32,

    // Category bitmask of cached artifacts.
    cachedCategories: Types.i32,

    // Resident byte accounting.
    bonePaletteBytes: Types.f64,
    inverseMatricesBytes: Types.f64,
    normalizedWeightsBytes: Types.f64,
    topologyAdjacencyBytes: Types.f64,
    compressedWeightsBytes: Types.f64,
    autoAssignBytes: Types.f64,
    overlapBytes: Types.f64,
    subdivisionBytes: Types.f64,
    totalBytes: Types.f64,

    // Cache bookkeeping.
    hitCount: Types.i64,
    missCount: Types.i64,
    lastAccessFrame: Types.i32,
    lastInsertFrame: Types.i32,
    lastEvictFrame: Types.i32,
    refCount: Types.i32,
    pinned: Types.ui8,
    invalidated: Types.ui8,

    // Determinism / eviction ordering.
    determinismSeed: Types.ui32,
    evictionScore: Types.f64,
    ditherSample: Types.f64,

    // State.
    registered: Types.ui8,
    resident: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Cache category bitmask constants. ─────────────────────────────────────
const CacheCategory = Object.freeze( {
    NONE: 0,
    BONE_PALETTE: 1 << 0,
    INVERSE_MATRICES: 1 << 1,
    NORMALIZED_WEIGHTS: 1 << 2,
    TOPOLOGY_ADJACENCY: 1 << 3,
    COMPRESSED_WEIGHTS: 1 << 4,
    AUTO_ASSIGN: 1 << 5,
    OVERLAP: 1 << 6,
    SUBDIVISION: 1 << 7,
    ALL: 0xFF
} );

// ─── Reusable cache statistics record. ─────────────────────────────────────
const _cacheStats = {
    entryCount: 0,
    residentCount: 0,
    pinnedCount: 0,
    invalidatedCount: 0,
    totalBytes: 0.0,
    totalHits: 0,
    totalMisses: 0,
    hitRatio: 0.0,
    memoryBudget: 0.0,
    memoryUtilization: 0.0,
    lastEvictionMs: 0.0,
    lastInsertMs: 0.0
};

// ─── Reusable defaults. ────────────────────────────────────────────────────
const SkinningCacheDefaults = {
    // Default cache memory budget (bytes). Overridden by the tier preset.
    defaultBudgetBytes: 96 * 1024 * 1024,

    // Maximum number of cache entries.
    maxEntries: 4096,

    // Budget fraction above which eviction begins.
    evictionStartFraction: 0.85,

    // Budget fraction at which eviction becomes critical.
    evictionCriticalFraction: 0.95,

    // Fraction of the budget to leave free after eviction.
    evictionTargetFraction: 0.75,

    // Number of frames a cache entry is protected from eviction after
    // its most recent access (LRU with recency guard).
    recencyGuardFrames: 30,

    // Whether to enable thermal-pressure eviction.
    thermalPressureEviction: true,

    // Thermal pressure above which aggressive eviction begins.
    thermalEvictionThreshold: 0.75,

    // Whether to enable battery-pressure eviction.
    batteryPressureEviction: true,

    // Battery pressure above which aggressive eviction begins.
    batteryEvictionThreshold: 0.75,

    // Whether to enable memory-pressure eviction.
    memoryPressureEviction: true,

    // Memory pressure above which aggressive eviction begins.
    memoryEvictionThreshold: 0.70,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F,

    // Whether to allow the cache to persist across scene reloads.
    persistAcrossReloads: false,

    // Whether to reuse cache entries across different SkinnedMesh instances.
    shareAcrossInstances: true,

    // Whether to track per-entry hit / miss counters.
    trackHits: true,

    // Whether to emit per-entry dither for telemetry.
    emitDither: true
};

// ─── Cache storage. ────────────────────────────────────────────────────────
const _cacheEntries = new Map();
const _cacheEcsByKeyHash = new Map();
let _nextCacheEntryId = 1;

// ─── Global memory / pressure state. ───────────────────────────────────────
let _currentBudgetBytes = SkinningCacheDefaults.defaultBudgetBytes;
let _currentTotalBytes = 0.0;
let _currentThermalPressure = 0.0;
let _currentBatteryPressure = 0.0;
let _currentMemoryPressure = 0.0;

// ─── Public API: key construction. ─────────────────────────────────────────

/**
 * Builds a cache key from a Skeleton and a geometry.
 * @param {Skeleton} skeleton
 * @param {BufferGeometry} geometry
 * @param {number} bonesPerVertex
 * @param {number} layout
 * @return {object}
 */
function makeCacheKey( skeleton, geometry, bonesPerVertex, layout ) {
    const skelUuid = skeleton !== undefined && skeleton !== null && skeleton.uuid !== undefined ? skeleton.uuid : '';
    const geomUuid = geometry !== undefined && geometry !== null && geometry.uuid !== undefined ? geometry.uuid : '';

    const skelHash = _hashString( skelUuid );
    const geomHash = _hashString( geomUuid );

    const combined = _mix32(
        ( skelHash ^ ( geomHash * 0x9E3779B9 ) ^ ( bonesPerVertex * 0x85EBCA6B ) ^ ( layout * 0xC2B2AE35 ) ) >>> 0
    );

    return {
        hash: combined,
        skeletonUuidHash: skelHash,
        geometryUuidHash: geomHash,
        bonesPerVertex: bonesPerVertex | 0,
        layout: layout | 0,
        skeleton: skeleton,
        geometry: geometry
    };
}

// ─── Public API: lookup. ───────────────────────────────────────────────────

/**
 * Looks up a cache entry by key. Returns null on miss.
 * @param {object} key - From `makeCacheKey`.
 * @param {number} [frameIndex=0]
 * @return {object|null}
 */
function lookup( key, frameIndex = 0 ) {
    const entry = _cacheEntries.get( key.hash );

    if ( entry === undefined ) {
        _cacheStats.totalMisses ++;
        return null;
    }

    if ( entry.invalidated ) {
        _cacheStats.totalMisses ++;
        return null;
    }

    // ── 1. Update access statistics. ──────────────────────────────────────
    if ( SkinningCacheDefaults.trackHits ) {
        entry.hitCount ++;
        _cacheStats.totalHits ++;
    }

    entry.lastAccessFrame = frameIndex;

    // ── 2. Sync back to ECS. ──────────────────────────────────────────────
    _syncCacheEntryECS( entry, frameIndex );

    return entry;
}

// ─── Public API: store. ────────────────────────────────────────────────────

/**
 * Stores a cache entry. Any existing entry with the same key is replaced.
 *
 * @param {object} key - From `makeCacheKey`.
 * @param {object} payload - The cached artifacts.
 * @param {number} [frameIndex=0]
 * @return {object} The stored cache entry record.
 */
function store( key, payload, frameIndex = 0 ) {
    const t0 = _nowMs();

    // ── 1. Remove any existing entry. ─────────────────────────────────────
    const existing = _cacheEntries.get( key.hash );

    if ( existing !== undefined ) {
        _subtractEntryBytes( existing );
        _cacheEntries.delete( key.hash );
    }

    // ── 2. Build the new entry record. ────────────────────────────────────
    const entry = {
        entryId: _nextCacheEntryId ++,
        hash: key.hash,
        skeletonUuidHash: key.skeletonUuidHash,
        geometryUuidHash: key.geometryUuidHash,
        bonesPerVertex: key.bonesPerVertex,
        layout: key.layout,
        skeleton: key.skeleton,
        geometry: key.geometry,

        cachedCategories: CacheCategory.NONE,

        bonePalette: null,
        inverseMatrices: null,
        normalizedWeights: null,
        topologyAdjacency: null,
        compressedWeights: null,
        autoAssign: null,
        overlap: null,
        subdivision: null,

        bonePaletteBytes: 0.0,
        inverseMatricesBytes: 0.0,
        normalizedWeightsBytes: 0.0,
        topologyAdjacencyBytes: 0.0,
        compressedWeightsBytes: 0.0,
        autoAssignBytes: 0.0,
        overlapBytes: 0.0,
        subdivisionBytes: 0.0,
        totalBytes: 0.0,

        hitCount: 0,
        missCount: 0,
        lastAccessFrame: frameIndex,
        lastInsertFrame: frameIndex,
        lastEvictFrame: - 1,
        refCount: 0,
        pinned: false,
        invalidated: false,

        determinismSeed: _mix32( key.hash ^ SkinningCacheDefaults.determinismSeed ),
        evictionScore: 0.0,
        ditherSample: 0.0
    };

    // ── 3. Attach the payload and compute byte counts. ────────────────────
    if ( payload !== undefined && payload !== null ) {
        if ( payload.bonePalette !== undefined && payload.bonePalette !== null ) {
            entry.bonePalette = payload.bonePalette;
            entry.bonePaletteBytes = _estimateBonePaletteBytes( payload.bonePalette );
            entry.cachedCategories |= CacheCategory.BONE_PALETTE;
        }

        if ( payload.inverseMatrices !== undefined && payload.inverseMatrices !== null ) {
            entry.inverseMatrices = payload.inverseMatrices;
            entry.inverseMatricesBytes = _estimateInverseMatricesBytes( payload.inverseMatrices );
            entry.cachedCategories |= CacheCategory.INVERSE_MATRICES;
        }

        if ( payload.normalizedWeights !== undefined && payload.normalizedWeights !== null ) {
            entry.normalizedWeights = payload.normalizedWeights;
            entry.normalizedWeightsBytes = _estimateNormalizedWeightsBytes( payload.normalizedWeights );
            entry.cachedCategories |= CacheCategory.NORMALIZED_WEIGHTS;
        }

        if ( payload.topologyAdjacency !== undefined && payload.topologyAdjacency !== null ) {
            entry.topologyAdjacency = payload.topologyAdjacency;
            entry.topologyAdjacencyBytes = _estimateTopologyAdjacencyBytes( payload.topologyAdjacency );
            entry.cachedCategories |= CacheCategory.TOPOLOGY_ADJACENCY;
        }

        if ( payload.compressedWeights !== undefined && payload.compressedWeights !== null ) {
            entry.compressedWeights = payload.compressedWeights;
            entry.compressedWeightsBytes = _estimateCompressedWeightsBytes( payload.compressedWeights );
            entry.cachedCategories |= CacheCategory.COMPRESSED_WEIGHTS;
        }

        if ( payload.autoAssign !== undefined && payload.autoAssign !== null ) {
            entry.autoAssign = payload.autoAssign;
            entry.autoAssignBytes = _estimateAutoAssignBytes( payload.autoAssign );
            entry.cachedCategories |= CacheCategory.AUTO_ASSIGN;
        }

        if ( payload.overlap !== undefined && payload.overlap !== null ) {
            entry.overlap = payload.overlap;
            entry.overlapBytes = _estimateOverlapBytes( payload.overlap );
            entry.cachedCategories |= CacheCategory.OVERLAP;
        }

        if ( payload.subdivision !== undefined && payload.subdivision !== null ) {
            entry.subdivision = payload.subdivision;
            entry.subdivisionBytes = _estimateSubdivisionBytes( payload.subdivision );
            entry.cachedCategories |= CacheCategory.SUBDIVISION;
        }
    }

    entry.totalBytes = entry.bonePaletteBytes
        + entry.inverseMatricesBytes
        + entry.normalizedWeightsBytes
        + entry.topologyAdjacencyBytes
        + entry.compressedWeightsBytes
        + entry.autoAssignBytes
        + entry.overlapBytes
        + entry.subdivisionBytes;

    // ── 4. Deterministic eviction score. ─────────────────────────────────
    const ditherSeed = ( entry.determinismSeed ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;
    entry.ditherSample = _noise3D( ditherSeed * 1e-6, frameIndex * 0.02, entry.bonesPerVertex );

    // Score = bytes * recency weight * dither jitter.
    // Higher score = more likely to be evicted.
    const recencyWeight = 1.0;
    entry.evictionScore = entry.totalBytes * recencyWeight * ( 0.5 + entry.ditherSample * 0.5 );

    // ── 5. Insert into storage. ──────────────────────────────────────────
    _cacheEntries.set( key.hash, entry );
    _addEntryBytes( entry );

    // ── 6. Sync to ECS. ──────────────────────────────────────────────────
    _ensureCacheEntryECS( entry, frameIndex );

    _cacheStats.lastInsertMs = _nowMs() - t0;

    // ── 7. Trigger eviction if the budget is tight. ─────────────────────
    _evictIfNeeded();

    return entry;
}

// ─── Public API: invalidate. ───────────────────────────────────────────────

/**
 * Invalidates a cache entry by key.
 * @param {object} key
 * @return {boolean}
 */
function invalidate( key ) {
    const entry = _cacheEntries.get( key.hash );

    if ( entry === undefined ) return false;

    entry.invalidated = true;

    _syncCacheEntryECS( entry, entry.lastFrameIndex );

    return true;
}

/**
 * Invalidates all cache entries that reference a given geometry UUID.
 * @param {string} geometryUuid
 * @return {number} The number of invalidated entries.
 */
function invalidateByGeometry( geometryUuid ) {
    const geomHash = _hashString( geometryUuid );
    let count = 0;

    for ( const entry of _cacheEntries.values() ) {
        if ( entry.geometryUuidHash === geomHash ) {
            entry.invalidated = true;
            _syncCacheEntryECS( entry, entry.lastFrameIndex );
            count ++;
        }
    }

    return count;
}

/**
 * Invalidates all cache entries that reference a given skeleton UUID.
 * @param {string} skeletonUuid
 * @return {number} The number of invalidated entries.
 */
function invalidateBySkeleton( skeletonUuid ) {
    const skelHash = _hashString( skeletonUuid );
    let count = 0;

    for ( const entry of _cacheEntries.values() ) {
        if ( entry.skeletonUuidHash === skelHash ) {
            entry.invalidated = true;
            _syncCacheEntryECS( entry, entry.lastFrameIndex );
            count ++;
        }
    }

    return count;
}

// ─── Public API: ref counting. ─────────────────────────────────────────────

/**
 * Increments the reference count on a cache entry. Pinned entries are not
 * evicted until their refCount returns to zero.
 * @param {object} key
 */
function retain( key ) {
    const entry = _cacheEntries.get( key.hash );
    if ( entry === undefined ) return;

    entry.refCount ++;
    entry.pinned = entry.refCount > 0;
}

/**
 * Decrements the reference count on a cache entry.
 * @param {object} key
 */
function release( key ) {
    const entry = _cacheEntries.get( key.hash );
    if ( entry === undefined ) return;

    entry.refCount = Math.max( 0, entry.refCount - 1 );
    entry.pinned = entry.refCount > 0;
}

// ─── Public API: eviction. ─────────────────────────────────────────────────

/**
 * Runs the eviction pass. Called automatically on store and can be called
 * manually from the host.
 * @param {number} [frameIndex=0]
 * @return {number} The number of evicted entries.
 */
function evict( frameIndex = 0 ) {
    const t0 = _nowMs();

    const budget = _currentBudgetBytes;
    const startFraction = SkinningCacheDefaults.evictionStartFraction;
    const criticalFraction = SkinningCacheDefaults.evictionCriticalFraction;
    const targetFraction = SkinningCacheDefaults.evictionTargetFraction;

    const utilization = budget > 0 ? _currentTotalBytes / budget : 0.0;

    if ( utilization < startFraction ) {
        _cacheStats.lastEvictionMs = _nowMs() - t0;
        return 0;
    }

    // ── 1. Compute the target byte count. ────────────────────────────────
    const targetBytes = budget * targetFraction;

    // ── 2. Build the eviction candidate list (sorted by score, pinned last).
    const candidates = [];

    for ( const entry of _cacheEntries.values() ) {
        if ( entry.pinned ) continue;
        if ( entry.invalidated ) continue;

        // Recency guard: skip entries accessed within the guard window.
        const age = frameIndex - entry.lastAccessFrame;

        if ( age < SkinningCacheDefaults.recencyGuardFrames && utilization < criticalFraction ) {
            continue;
        }

        candidates.push( entry );
    }

    // Sort by eviction score descending.
    candidates.sort( ( a, b ) => b.evictionScore - a.evictionScore );

    // ── 3. Evict until the target byte count is reached. ────────────────
    let evicted = 0;
    let currentBytes = _currentTotalBytes;

    for ( let i = 0; i < candidates.length; i ++ ) {
        if ( currentBytes <= targetBytes ) break;

        const entry = candidates[ i ];

        _subtractEntryBytes( entry );
        entry.invalidated = true;
        entry.lastEvictFrame = frameIndex;

        _cacheEntries.delete( entry.hash );
        _removeCacheEntryECS( entry );

        currentBytes -= entry.totalBytes;
        evicted ++;

        _syncCacheEntryECS( entry, frameIndex );
    }

    _cacheStats.lastEvictionMs = _nowMs() - t0;

    return evicted;
}

// ─── Internal: eviction trigger. ───────────────────────────────────────────

function _evictIfNeeded() {
    const budget = _currentBudgetBytes;
    if ( budget <= 0 ) return;

    const utilization = _currentTotalBytes / budget;

    // ── 1. Pressure-driven aggressive eviction. ──────────────────────────
    const thermalTrigger = SkinningCacheDefaults.thermalPressureEviction
        && _currentThermalPressure >= SkinningCacheDefaults.thermalEvictionThreshold;

    const batteryTrigger = SkinningCacheDefaults.batteryPressureEviction
        && _currentBatteryPressure >= SkinningCacheDefaults.batteryEvictionThreshold;

    const memoryTrigger = SkinningCacheDefaults.memoryPressureEviction
        && _currentMemoryPressure >= SkinningCacheDefaults.memoryEvictionThreshold;

    if ( thermalTrigger || batteryTrigger || memoryTrigger ) {
        // Aggressive: target 60% of budget.
        _evictToFraction( 0.60 );
        return;
    }

    // ── 2. Budget-driven eviction. ───────────────────────────────────────
    if ( utilization >= SkinningCacheDefaults.evictionStartFraction ) {
        evict();
    }
}

function _evictToFraction( fraction ) {
    const targetBytes = _currentBudgetBytes * fraction;

    if ( _currentTotalBytes <= targetBytes ) return;

    const candidates = [];

    for ( const entry of _cacheEntries.values() ) {
        if ( entry.pinned ) continue;
        if ( entry.invalidated ) continue;
        candidates.push( entry );
    }

    candidates.sort( ( a, b ) => b.evictionScore - a.evictionScore );

    let currentBytes = _currentTotalBytes;

    for ( let i = 0; i < candidates.length; i ++ ) {
        if ( currentBytes <= targetBytes ) break;

        const entry = candidates[ i ];

        _subtractEntryBytes( entry );
        entry.invalidated = true;
        entry.lastEvictFrame = _frameIndex;

        _cacheEntries.delete( entry.hash );
        _removeCacheEntryECS( entry );

        currentBytes -= entry.totalBytes;
    }
}

// ─── Public API: pressure setters. ────────────────────────────────────────

/**
 * Publishes thermal pressure to the cache.
 * @param {number} pressure
 */
function setThermalPressure( pressure ) {
    _currentThermalPressure = Math.min( 1.0, Math.max( 0.0, pressure ) );

    if ( SkinningCacheDefaults.thermalPressureEviction ) {
        _evictIfNeeded();
    }
}

/**
 * Publishes battery pressure to the cache.
 * @param {number} pressure
 */
function setBatteryPressure( pressure ) {
    _currentBatteryPressure = Math.min( 1.0, Math.max( 0.0, pressure ) );

    if ( SkinningCacheDefaults.batteryPressureEviction ) {
        _evictIfNeeded();
    }
}

/**
 * Publishes memory pressure to the cache.
 * @param {number} pressure
 */
function setMemoryPressure( pressure ) {
    _currentMemoryPressure = Math.min( 1.0, Math.max( 0.0, pressure ) );

    if ( SkinningCacheDefaults.memoryPressureEviction ) {
        _evictIfNeeded();
    }
}

// ─── Public API: budget management. ───────────────────────────────────────

/**
 * Sets the cache memory budget.
 * @param {number} bytes
 */
function setBudget( bytes ) {
    _currentBudgetBytes = Math.max( 0, bytes );

    _evictIfNeeded();
}

/**
 * Returns the current cache memory budget.
 * @return {number}
 */
function getBudget() {
    return _currentBudgetBytes;
}

// ─── Public API: byte accounting. ─────────────────────────────────────────

function _addEntryBytes( entry ) {
    _currentTotalBytes += entry.totalBytes;
}

function _subtractEntryBytes( entry ) {
    _currentTotalBytes = Math.max( 0, _currentTotalBytes - entry.totalBytes );
}

function _estimateBonePaletteBytes( palette ) {
    if ( palette === undefined || palette === null ) return 0;
    if ( palette.byteLength !== undefined ) return palette.byteLength;
    if ( palette.boneMatrices !== undefined && palette.boneMatrices.byteLength !== undefined ) {
        return palette.boneMatrices.byteLength;
    }
    return 0;
}

function _estimateInverseMatricesBytes( matrices ) {
    if ( matrices === undefined || matrices === null ) return 0;
    if ( matrices.byteLength !== undefined ) return matrices.byteLength;
    if ( Array.isArray( matrices ) ) return matrices.length * 64;
    return 0;
}

function _estimateNormalizedWeightsBytes( weights ) {
    if ( weights === undefined || weights === null ) return 0;
    if ( weights.byteLength !== undefined ) return weights.byteLength;
    return 0;
}

function _estimateTopologyAdjacencyBytes( adj ) {
    if ( adj === undefined || adj === null ) return 0;

    let bytes = 0;

    if ( adj.offsets !== undefined && adj.offsets.byteLength !== undefined ) {
        bytes += adj.offsets.byteLength;
    }
    if ( adj.list !== undefined && adj.list.byteLength !== undefined ) {
        bytes += adj.list.byteLength;
    }

    return bytes;
}

function _estimateCompressedWeightsBytes( compressed ) {
    if ( compressed === undefined || compressed === null ) return 0;
    if ( compressed.byteLength !== undefined ) return compressed.byteLength;
    if ( compressed.data !== undefined && compressed.data.byteLength !== undefined ) {
        return compressed.data.byteLength;
    }
    return 0;
}

function _estimateAutoAssignBytes( autoAssign ) {
    if ( autoAssign === undefined || autoAssign === null ) return 0;
    if ( autoAssign.byteLength !== undefined ) return autoAssign.byteLength;
    return 0;
}

function _estimateOverlapBytes( overlap ) {
    if ( overlap === undefined || overlap === null ) return 0;
    if ( overlap.byteLength !== undefined ) return overlap.byteLength;
    return 0;
}

function _estimateSubdivisionBytes( subdivision ) {
    if ( subdivision === undefined || subdivision === null ) return 0;
    if ( subdivision.byteLength !== undefined ) return subdivision.byteLength;
    if ( subdivision.positions !== undefined && subdivision.positions.byteLength !== undefined ) {
        return subdivision.positions.byteLength;
    }
    return 0;
}

// ─── Public API: statistics. ──────────────────────────────────────────────

/**
 * Returns the current cache statistics.
 * @return {object}
 */
function getStats() {
    let resident = 0;
    let pinned = 0;
    let invalidated = 0;
    let totalBytes = 0.0;
    let totalHits = 0;
    let totalMisses = 0;

    for ( const entry of _cacheEntries.values() ) {
        if ( entry.invalidated ) invalidated ++;
        else resident ++;

        if ( entry.pinned ) pinned ++;

        totalBytes += entry.totalBytes;
        totalHits += entry.hitCount;
        totalMisses += entry.missCount;
    }

    _cacheStats.entryCount = _cacheEntries.size;
    _cacheStats.residentCount = resident;
    _cacheStats.pinnedCount = pinned;
    _cacheStats.invalidatedCount = invalidated;
    _cacheStats.totalBytes = totalBytes;
    _cacheStats.totalHits = totalHits;
    _cacheStats.totalMisses = totalMisses;

    const total = totalHits + totalMisses;
    _cacheStats.hitRatio = total > 0 ? totalHits / total : 0.0;

    _cacheStats.memoryBudget = _currentBudgetBytes;
    _cacheStats.memoryUtilization = _currentBudgetBytes > 0
        ? totalBytes / _currentBudgetBytes
        : 0.0;

    return _cacheStats;
}

/**
 * Returns a high-precision byte accounting for the entire cache.
 * @return {number}
 */
function computeTotalBytesHighPrecision() {
    let total = new Double( 0 );

    for ( const entry of _cacheEntries.values() ) {
        total = new Double( total.valueOf() + entry.totalBytes );
    }

    return total.valueOf();
}

/**
 * Returns a high-precision hit ratio.
 * @return {number}
 */
function computeHitRatioHighPrecision() {
    let hits = 0;
    let misses = 0;

    for ( const entry of _cacheEntries.values() ) {
        hits += entry.hitCount;
        misses += entry.missCount;
    }

    const total = new Double( Math.max( 1, hits + misses ) );
    const h = new Double( hits );

    return h.div( total ).valueOf();
}

// ─── Public API: clearing. ────────────────────────────────────────────────

/**
 * Clears all cache entries.
 */
function clear() {
    for ( const entry of _cacheEntries.values() ) {
        _removeCacheEntryECS( entry );
    }

    _cacheEntries.clear();
    _currentTotalBytes = 0.0;
}

/**
 * Clears only the invalidated entries.
 * @return {number} The number of cleared entries.
 */
function clearInvalidated() {
    let count = 0;

    for ( const [ hash, entry ] of _cacheEntries ) {
        if ( entry.invalidated ) {
            _subtractEntryBytes( entry );
            _removeCacheEntryECS( entry );
            _cacheEntries.delete( hash );
            count ++;
        }
    }

    return count;
}

// ─── Public API: ECS sync. ────────────────────────────────────────────────

function _ensureCacheEntryECS( entry, frameIndex ) {
    let eid = _cacheEcsByKeyHash.get( entry.hash );

    if ( eid === undefined ) {
        eid = addEntity( _cacheWorld );
        addComponent( _cacheWorld, SkinningCacheEntrySoA, eid );
        _cacheEcsByKeyHash.set( entry.hash, eid );
    }

    _syncCacheEntryECS( entry, frameIndex );
}

function _removeCacheEntryECS( entry ) {
    const eid = _cacheEcsByKeyHash.get( entry.hash );
    if ( eid === undefined ) return;

    // Reset the SoA slot to a benign state; bitecs does not expose a
    // removeComponent that is portable across versions, so we clear the
    // fields instead and unregister the mapping.
    SkinningCacheEntrySoA.registered[ eid ] = 0;
    SkinningCacheEntrySoA.resident[ eid ] = 0;

    _cacheEcsByKeyHash.delete( entry.hash );
}

function _syncCacheEntryECS( entry, frameIndex ) {
    const eid = _cacheEcsByKeyHash.get( entry.hash );
    if ( eid === undefined ) return;

    SkinningCacheEntrySoA.entryId[ eid ] = entry.entryId;
    SkinningCacheEntrySoA.cacheKeyHash[ eid ] = entry.hash;
    SkinningCacheEntrySoA.skeletonUuidHash[ eid ] = entry.skeletonUuidHash;
    SkinningCacheEntrySoA.geometryUuidHash[ eid ] = entry.geometryUuidHash;
    SkinningCacheEntrySoA.bonesPerVertex[ eid ] = entry.bonesPerVertex;
    SkinningCacheEntrySoA.layout[ eid ] = entry.layout;
    SkinningCacheEntrySoA.cachedCategories[ eid ] = entry.cachedCategories;

    SkinningCacheEntrySoA.bonePaletteBytes[ eid ] = entry.bonePaletteBytes;
    SkinningCacheEntrySoA.inverseMatricesBytes[ eid ] = entry.inverseMatricesBytes;
    SkinningCacheEntrySoA.normalizedWeightsBytes[ eid ] = entry.normalizedWeightsBytes;
    SkinningCacheEntrySoA.topologyAdjacencyBytes[ eid ] = entry.topologyAdjacencyBytes;
    SkinningCacheEntrySoA.compressedWeightsBytes[ eid ] = entry.compressedWeightsBytes;
    SkinningCacheEntrySoA.autoAssignBytes[ eid ] = entry.autoAssignBytes;
    SkinningCacheEntrySoA.overlapBytes[ eid ] = entry.overlapBytes;
    SkinningCacheEntrySoA.subdivisionBytes[ eid ] = entry.subdivisionBytes;
    SkinningCacheEntrySoA.totalBytes[ eid ] = entry.totalBytes;

    SkinningCacheEntrySoA.hitCount[ eid ] = entry.hitCount;
    SkinningCacheEntrySoA.missCount[ eid ] = entry.missCount;
    SkinningCacheEntrySoA.lastAccessFrame[ eid ] = entry.lastAccessFrame;
    SkinningCacheEntrySoA.lastInsertFrame[ eid ] = entry.lastInsertFrame;
    SkinningCacheEntrySoA.lastEvictFrame[ eid ] = entry.lastEvictFrame;
    SkinningCacheEntrySoA.refCount[ eid ] = entry.refCount;
    SkinningCacheEntrySoA.pinned[ eid ] = entry.pinned ? 1 : 0;
    SkinningCacheEntrySoA.invalidated[ eid ] = entry.invalidated ? 1 : 0;

    SkinningCacheEntrySoA.determinismSeed[ eid ] = entry.determinismSeed;
    SkinningCacheEntrySoA.evictionScore[ eid ] = entry.evictionScore;
    SkinningCacheEntrySoA.ditherSample[ eid ] = entry.ditherSample;

    SkinningCacheEntrySoA.registered[ eid ] = 1;
    SkinningCacheEntrySoA.resident[ eid ] = entry.invalidated ? 0 : 1;
    SkinningCacheEntrySoA.lastFrameIndex[ eid ] = frameIndex | 0;
}

// ─── Public API: query helpers over bitecs. ───────────────────────────────

/**
 * Returns the ECS entity id for a cache key hash.
 * @param {number} hash
 * @return {number}
 */
function getCacheEntryEntityForHash( hash ) {
    const eid = _cacheEcsByKeyHash.get( hash );
    return eid !== undefined ? eid : - 1;
}

/**
 * Collects all resident cache entry hashes.
 * @return {Array<number>}
 */
function collectResidentEntryHashes() {
    const out = [];
    const q = query( _cacheWorld, [ SkinningCacheEntrySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        if ( SkinningCacheEntrySoA.resident[ eid ] === 1 ) {
            out.push( SkinningCacheEntrySoA.cacheKeyHash[ eid ] );
        }
    }

    return out;
}

/**
 * Collects cache entries that have a given category cached.
 * @param {number} category - One of `CacheCategory`.
 * @return {Array<number>}
 */
function collectEntriesWithCategory( category ) {
    const out = [];
    const q = query( _cacheWorld, [ SkinningCacheEntrySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        if ( ( SkinningCacheEntrySoA.cachedCategories[ eid ] & category ) !== 0 ) {
            out.push( SkinningCacheEntrySoA.cacheKeyHash[ eid ] );
        }
    }

    return out;
}

// ─── Public API: aggregated stats. ────────────────────────────────────────

/**
 * Returns aggregated cache statistics across all registered entries.
 * @return {object}
 */
function getAggregatedStats() {
    let totalEntries = 0;
    let totalResident = 0;
    let totalBytes = 0.0;
    let totalHits = 0;
    let totalMisses = 0;
    let totalEvicted = 0;
    let totalPinned = 0;

    const q = query( _cacheWorld, [ SkinningCacheEntrySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinningCacheEntrySoA.registered[ eid ] !== 1 ) continue;

        totalEntries ++;

        if ( SkinningCacheEntrySoA.resident[ eid ] === 1 ) totalResident ++;
        if ( SkinningCacheEntrySoA.pinned[ eid ] === 1 ) totalPinned ++;

        totalBytes += SkinningCacheEntrySoA.totalBytes[ eid ];
        totalHits += SkinningCacheEntrySoA.hitCount[ eid ];
        totalMisses += SkinningCacheEntrySoA.missCount[ eid ];

        if ( SkinningCacheEntrySoA.lastEvictFrame[ eid ] >= 0 ) totalEvicted ++;
    }

    const total = totalHits + totalMisses;
    const hitRatio = total > 0 ? totalHits / total : 0.0;

    const bytes = new Double( totalBytes );

    return {
        totalEntries: totalEntries,
        totalResident: totalResident,
        totalPinned: totalPinned,
        totalBytes: bytes.valueOf(),
        totalHits: totalHits,
        totalMisses: totalMisses,
        totalEvicted: totalEvicted,
        hitRatio: hitRatio,
        memoryBudget: _currentBudgetBytes,
        memoryUtilization: _currentBudgetBytes > 0 ? totalBytes / _currentBudgetBytes : 0.0
    };
}

// ─── Public API: tier integration. ────────────────────────────────────────

/**
 * Applies the Android tier cache budget.
 * @param {number} tier
 */
function applyAndroidTierBudget( tier ) {
    let budget;

    switch ( tier ) {
        case 1: budget = 32 * 1024 * 1024; break;
        case 2: budget = 96 * 1024 * 1024; break;
        case 3: budget = 224 * 1024 * 1024; break;
        case 4: budget = 384 * 1024 * 1024; break;
        default: budget = SkinningCacheDefaults.defaultBudgetBytes;
    }

    setBudget( budget );
}

// ─── gl-matrix packing for telemetry. ─────────────────────────────────────

/**
 * Packs cache statistics into a vec4.
 * Layout: (entryCount, residentCount, totalBytes, memoryUtilization)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packCacheStatsVec4( out ) {
    const v = out || _scratchVec4;
    const stats = getStats();

    glMatrix.vec4.set(
        v,
        stats.entryCount,
        stats.residentCount,
        stats.totalBytes,
        stats.memoryUtilization
    );
    return v;
}

/**
 * Packs hit / miss statistics into a vec4.
 * Layout: (totalHits, totalMisses, hitRatio, pinnedCount)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packCacheHitVec4( out ) {
    const v = out || _scratchVec4B;
    const stats = getStats();

    glMatrix.vec4.set(
        v,
        stats.totalHits,
        stats.totalMisses,
        stats.hitRatio,
        stats.pinnedCount
    );
    return v;
}

/**
 * Packs a cache entry's telemetry into a vec4.
 * Layout: (totalBytes, hitCount, cachedCategories, evictionScore)
 * @param {number} hash
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packCacheEntryVec4( hash, out ) {
    const v = out || _scratchVec4C;
    const eid = getCacheEntryEntityForHash( hash );

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinningCacheEntrySoA.totalBytes[ eid ],
        SkinningCacheEntrySoA.hitCount[ eid ],
        SkinningCacheEntrySoA.cachedCategories[ eid ],
        SkinningCacheEntrySoA.evictionScore[ eid ]
    );
    return v;
}

/**
 * Packs memory budget and pressure into a vec4.
 * Layout: (budget, totalBytes, thermalPressure, memoryPressure)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packBudgetVec4( out ) {
    const v = out || _scratchVec4D;

    glMatrix.vec4.set(
        v,
        _currentBudgetBytes,
        _currentTotalBytes,
        _currentThermalPressure,
        _currentMemoryPressure
    );
    return v;
}

// ─── Public API: deterministic dither sampling. ──────────────────────────

/**
 * Returns a deterministic dither sample for the given cache key / frame.
 * @param {number} hash
 * @param {number} frameIndex
 * @return {number}
 */
function sampleCacheDither( hash, frameIndex ) {
    const seed = ( SkinningCacheDefaults.determinismSeed ^ ( hash * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, 0 );
}

// ─── Public API: frame lifecycle. ─────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all cache entries.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _cacheWorld, [ SkinningCacheEntrySoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        SkinningCacheEntrySoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
    }

    // ── 1. Recompute eviction scores for resident entries. ────────────────
    for ( const entry of _cacheEntries.values() ) {
        const recency = Math.max( 1, _frameIndex - entry.lastAccessFrame );
        const recencyWeight = 1.0 / Math.sqrt( recency );

        const ditherSeed = ( entry.determinismSeed ^ ( _frameIndex * 0x9E3779B9 ) ) >>> 0;
        entry.ditherSample = _noise3D( ditherSeed * 1e-6, _frameIndex * 0.02, entry.bonesPerVertex );

        entry.evictionScore = entry.totalBytes * recencyWeight * ( 0.5 + entry.ditherSample * 0.5 );
    }
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
void Matrix4;
void BufferGeometry;
void BonesPerVertex;
void SkinWeightLayout;
void SkinnedMeshDefaults;
void SkinnedMeshCaps;
void ATTR_SKIN_INDEX;
void ATTR_SKIN_WEIGHT;
void getLayoutEntityForUuid;
void SkinWeightNormalizerSoA;
void SkinWeightAutoAssignSoA;
void SkinWeightAdjacentOverlapSoA;
void SkinWeightCompressorSoA;
void TopologyAdapterSoA;
void ArbitraryTopologySoA;
void _scratchVec3A;
void _scratchMat4;

export {
    CacheCategory,
    SkinningCacheDefaults,
    SkinningCacheEntrySoA,
    makeCacheKey,
    lookup,
    store,
    invalidate,
    invalidateByGeometry,
    invalidateBySkeleton,
    retain,
    release,
    evict,
    setBudget,
    getBudget,
    setThermalPressure,
    setBatteryPressure,
    setMemoryPressure,
    getStats,
    computeTotalBytesHighPrecision,
    computeHitRatioHighPrecision,
    clear,
    clearInvalidated,
    getCacheEntryEntityForHash,
    collectResidentEntryHashes,
    collectEntriesWithCategory,
    getAggregatedStats,
    applyAndroidTierBudget,
    packCacheStatsVec4,
    packCacheHitVec4,
    packCacheEntryVec4,
    packBudgetVec4,
    sampleCacheDither,
    beginFrame
};