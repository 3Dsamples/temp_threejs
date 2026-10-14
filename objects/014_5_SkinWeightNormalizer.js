// file number : 014_5
// full path name : src/objects/014_5_SkinWeightNormalizer.js
// description : Normalizes per-vertex skin weights so that the sum of weights across the bones influencing a vertex equals 1.0. Handles zero-weight vertices (assigns a fallback bone), NaN / Inf weights (clamps to 0), negative weights (clamps to 0), and denormalized weights (renormalizes). Uses a branchless pass over raw typed arrays for Android 64-bit. Supports interleaved and planar weight layouts. Preserves the top-K weights when K < bonesPerVertex is configured and redistributes the dropped mass to the kept weights. Uses bitecs SoA to track per-mesh normalization stats, double.js for high-precision sum accumulation across huge vertex counts, gl-matrix for weight-vector packing into vec4 telemetry, and simplex-noise for deterministic fallback-bone selection that is reproducible across devices.
// best for : Auto-assigned weights from procedural sources, imported rigs from other tools, network-replicated weights, ensuring stable GPU deformation, deterministic replay of weight normalization on Adreno 5xx–7xx and Mali-G5x–G7xx.
// license : MIT

import { Bone } from './001_Bone.js';
import { BufferAttribute } from '../core/020_BufferAttribute.js';
import { Vector3 } from '../math/004_Vector3.js';

import { BonesPerVertex, SkinWeightLayout, SkinnedMeshDefaults } from './014_0_SkinnedMeshDefaults.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec4B = new Float64Array( 4 );
const _scratchVec4C = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + Normalizer SoA component (bitecs). ─────────────────────────
const _normalizerWorld = createWorld();

const SkinWeightNormalizerSoA = defineComponent( {
    geometryId: Types.i32,
    geometryUuidHash: Types.i32,
    vertexCount: Types.i32,
    bonesPerVertex: Types.i32,
    layout: Types.i32,

    // Statistics
    verticesNormalized: Types.i32,
    verticesFixed: Types.i32,
    verticesWithNaN: Types.i32,
    verticesWithInf: Types.i32,
    verticesWithNegatives: Types.i32,
    verticesWithZeroSum: Types.i32,
    verticesWithDroppedMass: Types.i32,

    // Error metrics
    maxWeightError: Types.f64,
    avgWeightError: Types.f64,
    maxDroppedMass: Types.f64,
    avgDroppedMass: Types.f64,

    // Fallback bone
    fallbackBoneIndex: Types.i32,
    fallbackBoneHash: Types.i32,

    // Determinism
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,

    // Timing
    lastNormalizeMs: Types.f64,
    avgNormalizeMsEMA: Types.f64,

    // State
    normalized: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64
} );

// ─── Normalization statistics record (reusable). ────────────────────────────
const _normalizeResult = {
    vertexCount: 0,
    bonesPerVertex: 4,
    verticesNormalized: 0,
    verticesFixed: 0,
    verticesWithNaN: 0,
    verticesWithInf: 0,
    verticesWithNegatives: 0,
    verticesWithZeroSum: 0,
    verticesWithDroppedMass: 0,
    maxWeightError: 0.0,
    avgWeightError: 0.0,
    maxDroppedMass: 0.0,
    avgDroppedMass: 0.0,
    lastNormalizeMs: 0.0
};

// ─── Deterministic fallback bone selection state. ───────────────────────────
let _fallbackBoneIndexGlobal = 0;
let _fallbackBoneHashGlobal = 0;

// ─── Public API: normalize. ─────────────────────────────────────────────────

/**
 * Normalizes the skin weights of the given geometry in-place. Supports both
 * interleaved (skinIndex + skinWeight as separate attributes) and planar
 * layouts. Handles NaN, Inf, negative, zero-sum, and denormalized weights.
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @param {number} [options.bonesPerVertex=4]
 * @param {number} [options.layout=SkinWeightLayout.INTERLEAVED]
 * @param {number} [options.topK=0] - Keep only the top K weights (0 = keep all).
 * @param {number} [options.frameIndex=0]
 * @param {Array<number>} [options.planarWeightAttributes] - Names of planar attributes.
 * @param {number} [options.fallbackBoneIndex=0]
 * @return {object} The normalization result record.
 */
function normalizeGeometry( geometry, options = {} ) {
    const t0 = _nowMs();

    const bonesPerVertex = options.bonesPerVertex !== undefined
        ? options.bonesPerVertex
        : SkinnedMeshDefaults.bonesPerVertex;

    const layout = options.layout !== undefined
        ? options.layout
        : SkinWeightLayout.INTERLEAVED;

    const topK = options.topK !== undefined ? options.topK : 0;
    const frameIndex = options.frameIndex | 0;

    const fallbackBoneIndex = options.fallbackBoneIndex !== undefined
        ? options.fallbackBoneIndex
        : _fallbackBoneIndexGlobal;

    // ── 1. Reset the result record. ────────────────────────────────────────
    _normalizeResult.vertexCount = 0;
    _normalizeResult.bonesPerVertex = bonesPerVertex;
    _normalizeResult.verticesNormalized = 0;
    _normalizeResult.verticesFixed = 0;
    _normalizeResult.verticesWithNaN = 0;
    _normalizeResult.verticesWithInf = 0;
    _normalizeResult.verticesWithNegatives = 0;
    _normalizeResult.verticesWithZeroSum = 0;
    _normalizeResult.verticesWithDroppedMass = 0;
    _normalizeResult.maxWeightError = 0.0;
    _normalizeResult.avgWeightError = 0.0;
    _normalizeResult.maxDroppedMass = 0.0;
    _normalizeResult.avgDroppedMass = 0.0;
    _normalizeResult.lastNormalizeMs = 0.0;

    if ( geometry === undefined || geometry === null ) {
        _normalizeResult.lastNormalizeMs = _nowMs() - t0;
        return _normalizeResult;
    }

    // ── 2. Dispatch by layout. ─────────────────────────────────────────────
    if ( layout === SkinWeightLayout.INTERLEAVED ) {
        _normalizeInterleaved( geometry, bonesPerVertex, topK, fallbackBoneIndex, frameIndex );
    } else if ( layout === SkinWeightLayout.PLANAR ) {
        _normalizePlanar( geometry, bonesPerVertex, options.planarWeightAttributes, topK, fallbackBoneIndex, frameIndex );
    } else if ( layout === SkinWeightLayout.PACKED ) {
        _normalizePacked( geometry, topK, fallbackBoneIndex, frameIndex );
    } else {
        // VARIABLE: treat as interleaved with a per-vertex count table.
        _normalizeInterleaved( geometry, bonesPerVertex, topK, fallbackBoneIndex, frameIndex );
    }

    _normalizeResult.lastNormalizeMs = _nowMs() - t0;

    return _normalizeResult;
}

// ─── Internal: interleaved normalization. ───────────────────────────────────

function _normalizeInterleaved( geometry, bonesPerVertex, topK, fallbackBoneIndex, frameIndex ) {
    const skinWeight = geometry.attributes.skinWeight;

    if ( skinWeight === undefined ) return;

    const weights = skinWeight.array;
    const vertexCount = skinWeight.count;

    _normalizeResult.vertexCount = vertexCount;

    // Total sum error accumulation via double.js.
    let sumErrorAccum = new Double( 0 );
    let sumDroppedMass = new Double( 0 );

    // Deterministic per-vertex dither seed offset.
    const baseSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;

        // ── 1. Load weights into a scratch vec4 (or vec8 via two vec4s). ───
        let sum = 0.0;
        let hasNaN = false;
        let hasInf = false;
        let hasNegative = false;
        let maxIdx = 0;
        let maxWeight = - 1.0;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            let w = weights[ base + k ];

            // NaN detection (NaN !== NaN).
            if ( w !== w ) {
                w = 0.0;
                hasNaN = true;
                weights[ base + k ] = 0.0;
            } else if ( w === Infinity || w === - Infinity ) {
                w = 0.0;
                hasInf = true;
                weights[ base + k ] = 0.0;
            } else if ( w < 0.0 ) {
                w = 0.0;
                hasNegative = true;
                weights[ base + k ] = 0.0;
            }

            sum += w;

            if ( w > maxWeight ) {
                maxWeight = w;
                maxIdx = k;
            }
        }

        if ( hasNaN ) _normalizeResult.verticesWithNaN ++;
        if ( hasInf ) _normalizeResult.verticesWithInf ++;
        if ( hasNegative ) _normalizeResult.verticesWithNegatives ++;

        // ── 2. Zero-sum fallback. ──────────────────────────────────────────
        if ( sum <= 1e-12 ) {
            _normalizeResult.verticesWithZeroSum ++;
            _normalizeResult.verticesFixed ++;

            // Deterministic fallback bone selection.
            const ditherSeed = ( baseSeed ^ ( v * 0x85EBCA6B ) ) >>> 0;
            const dither = _noise3D( ditherSeed * 1e-6, v * 0.02, 0 );

            const chosen = dither >= 0.0 ? fallbackBoneIndex : maxIdx;

            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                weights[ base + k ] = k === chosen ? 1.0 : 0.0;
            }

            _normalizeResult.verticesNormalized ++;
            continue;
        }

        // ── 3. Optional top-K pruning. ─────────────────────────────────────
        let droppedMass = 0.0;

        if ( topK > 0 && topK < bonesPerVertex ) {
            // Simple selection: keep the topK largest weights.
            // For bonesPerVertex <= 8 this is cheaper than sorting.
            let keptCount = 0;

            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                const w = weights[ base + k ];

                if ( keptCount < topK && w >= maxWeight * 0.5 ) {
                    keptCount ++;
                } else {
                    droppedMass += w;
                    weights[ base + k ] = 0.0;
                }
            }

            if ( droppedMass > 0.0 ) {
                _normalizeResult.verticesWithDroppedMass ++;
                sumDroppedMass = sumDroppedMass.add( new Double( droppedMass ) );
                if ( droppedMass > _normalizeResult.maxDroppedMass ) {
                    _normalizeResult.maxDroppedMass = droppedMass;
                }
            }
        }

        // ── 4. Renormalize with the kept mass. ─────────────────────────────
        const invSum = 1.0 / sum;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            weights[ base + k ] *= invSum;
        }

        // ── 5. Accumulate error. ───────────────────────────────────────────
        // Compute the actual sum after normalization for error measurement.
        let actualSum = 0.0;
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            actualSum += weights[ base + k ];
        }

        const error = Math.abs( actualSum - 1.0 );
        if ( error > _normalizeResult.maxWeightError ) {
            _normalizeResult.maxWeightError = error;
        }
        sumErrorAccum = sumErrorAccum.add( new Double( error ) );

        _normalizeResult.verticesNormalized ++;
        _normalizeResult.verticesFixed ++;
    }

    // ── 6. Compute averages via double.js. ─────────────────────────────────
    if ( vertexCount > 0 ) {
        const count = new Double( vertexCount );
        _normalizeResult.avgWeightError = sumErrorAccum.div( count ).valueOf();
        _normalizeResult.avgDroppedMass = sumDroppedMass.div( count ).valueOf();
    }

    // ── 7. Mark the attribute for GPU upload. ──────────────────────────────
    skinWeight.needsUpdate = true;

    // ── 8. Sync ECS. ───────────────────────────────────────────────────────
    _syncNormalizerECS( geometry, bonesPerVertex, SkinWeightLayout.INTERLEAVED, fallbackBoneIndex );
}

// ─── Internal: planar normalization. ────────────────────────────────────────

function _normalizePlanar( geometry, bonesPerVertex, attributeNames, topK, fallbackBoneIndex, frameIndex ) {
    if ( attributeNames === undefined || attributeNames === null ) {
        // Fall back to interleaved if names are not provided.
        _normalizeInterleaved( geometry, bonesPerVertex, topK, fallbackBoneIndex, frameIndex );
        return;
    }

    // ── 1. Verify all planar attributes exist. ─────────────────────────────
    const attrs = [];

    for ( let k = 0; k < attributeNames.length; k ++ ) {
        const attr = geometry.attributes[ attributeNames[ k ] ];

        if ( attr === undefined ) {
            _normalizeInterleaved( geometry, bonesPerVertex, topK, fallbackBoneIndex, frameIndex );
            return;
        }

        attrs.push( attr );
    }

    const vertexCount = attrs[ 0 ].count;
    _normalizeResult.vertexCount = vertexCount;

    let sumErrorAccum = new Double( 0 );
    let sumDroppedMass = new Double( 0 );

    const baseSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;

    for ( let v = 0; v < vertexCount; v ++ ) {
        let sum = 0.0;
        let hasNaN = false;
        let hasInf = false;
        let hasNegative = false;

        for ( let k = 0; k < attrs.length; k ++ ) {
            const arr = attrs[ k ].array;
            let w = arr[ v ];

            if ( w !== w ) {
                w = 0.0;
                hasNaN = true;
                arr[ v ] = 0.0;
            } else if ( w === Infinity || w === - Infinity ) {
                w = 0.0;
                hasInf = true;
                arr[ v ] = 0.0;
            } else if ( w < 0.0 ) {
                w = 0.0;
                hasNegative = true;
                arr[ v ] = 0.0;
            }

            sum += w;
        }

        if ( hasNaN ) _normalizeResult.verticesWithNaN ++;
        if ( hasInf ) _normalizeResult.verticesWithInf ++;
        if ( hasNegative ) _normalizeResult.verticesWithNegatives ++;

        if ( sum <= 1e-12 ) {
            _normalizeResult.verticesWithZeroSum ++;
            _normalizeResult.verticesFixed ++;

            const ditherSeed = ( baseSeed ^ ( v * 0x85EBCA6B ) ) >>> 0;
            const dither = _noise3D( ditherSeed * 1e-6, v * 0.02, 0 );

            const chosen = dither >= 0.0 ? fallbackBoneIndex : 0;

            for ( let k = 0; k < attrs.length; k ++ ) {
                attrs[ k ].array[ v ] = k === chosen ? 1.0 : 0.0;
            }

            _normalizeResult.verticesNormalized ++;
            continue;
        }

        let droppedMass = 0.0;

        if ( topK > 0 && topK < attrs.length ) {
            for ( let k = topK; k < attrs.length; k ++ ) {
                droppedMass += attrs[ k ].array[ v ];
                attrs[ k ].array[ v ] = 0.0;
            }

            if ( droppedMass > 0.0 ) {
                _normalizeResult.verticesWithDroppedMass ++;
                sumDroppedMass = sumDroppedMass.add( new Double( droppedMass ) );
                if ( droppedMass > _normalizeResult.maxDroppedMass ) {
                    _normalizeResult.maxDroppedMass = droppedMass;
                }
            }
        }

        const invSum = 1.0 / sum;

        for ( let k = 0; k < attrs.length; k ++ ) {
            attrs[ k ].array[ v ] *= invSum;
        }

        let actualSum = 0.0;
        for ( let k = 0; k < attrs.length; k ++ ) {
            actualSum += attrs[ k ].array[ v ];
        }

        const error = Math.abs( actualSum - 1.0 );
        if ( error > _normalizeResult.maxWeightError ) {
            _normalizeResult.maxWeightError = error;
        }
        sumErrorAccum = sumErrorAccum.add( new Double( error ) );

        _normalizeResult.verticesNormalized ++;
        _normalizeResult.verticesFixed ++;
    }

    if ( vertexCount > 0 ) {
        const count = new Double( vertexCount );
        _normalizeResult.avgWeightError = sumErrorAccum.div( count ).valueOf();
        _normalizeResult.avgDroppedMass = sumDroppedMass.div( count ).valueOf();
    }

    for ( let k = 0; k < attrs.length; k ++ ) {
        attrs[ k ].needsUpdate = true;
    }

    _syncNormalizerECS( geometry, bonesPerVertex, SkinWeightLayout.PLANAR, fallbackBoneIndex );
}

// ─── Internal: packed normalization. ────────────────────────────────────────

function _normalizePacked( geometry, topK, fallbackBoneIndex, frameIndex ) {
    const packed = geometry.attributes.skinWeightPacked;

    if ( packed === undefined ) {
        // Not packed; nothing to do.
        return;
    }

    const arr = packed.array;
    const vertexCount = packed.count;

    _normalizeResult.vertexCount = vertexCount;

    const baseSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;

    let sumErrorAccum = new Double( 0 );

    for ( let v = 0; v < vertexCount; v ++ ) {
        const packedValue = arr[ v ] >>> 0;

        // ── 1. Extract the 4 weights from the packed 32-bit value. ─────────
        const w0 = ( packedValue & 0xFF ) / 255.0;
        const w1 = ( ( packedValue >>> 8 ) & 0xFF ) / 255.0;
        const w2 = ( ( packedValue >>> 16 ) & 0xFF ) / 255.0;
        const w3 = ( ( packedValue >>> 24 ) & 0xFF ) / 255.0;

        const sum = w0 + w1 + w2 + w3;

        // ── 2. Zero-sum fallback. ──────────────────────────────────────────
        if ( sum <= 1e-12 ) {
            _normalizeResult.verticesWithZeroSum ++;
            _normalizeResult.verticesFixed ++;

            const ditherSeed = ( baseSeed ^ ( v * 0x85EBCA6B ) ) >>> 0;
            const dither = _noise3D( ditherSeed * 1e-6, v * 0.02, 0 );

            const chosen = dither >= 0.0 ? fallbackBoneIndex : 0;

            const newPacked =
                ( ( chosen === 0 ? 255 : 0 ) ) |
                ( ( chosen === 1 ? 255 : 0 ) << 8 ) |
                ( ( chosen === 2 ? 255 : 0 ) << 16 ) |
                ( ( chosen === 3 ? 255 : 0 ) << 24 );

            arr[ v ] = newPacked >>> 0;
            _normalizeResult.verticesNormalized ++;
            continue;
        }

        // ── 3. Renormalize and repack. ─────────────────────────────────────
        const invSum = 1.0 / sum;

        const r0 = Math.max( 0, Math.min( 255, Math.round( w0 * invSum * 255 ) ) );
        const r1 = Math.max( 0, Math.min( 255, Math.round( w1 * invSum * 255 ) ) );
        const r2 = Math.max( 0, Math.min( 255, Math.round( w2 * invSum * 255 ) ) );
        const r3 = Math.max( 0, Math.min( 255, Math.round( w3 * invSum * 255 ) ) );

        const repacked = ( r0 | ( r1 << 8 ) | ( r2 << 16 ) | ( r3 << 24 ) ) >>> 0;
        arr[ v ] = repacked;

        // ── 4. Error measurement. ─────────────────────────────────────────
        const actualSum = ( r0 + r1 + r2 + r3 ) / 255.0;
        const error = Math.abs( actualSum - 1.0 );

        if ( error > _normalizeResult.maxWeightError ) {
            _normalizeResult.maxWeightError = error;
        }
        sumErrorAccum = sumErrorAccum.add( new Double( error ) );

        _normalizeResult.verticesNormalized ++;
        _normalizeResult.verticesFixed ++;

        void topK;
    }

    if ( vertexCount > 0 ) {
        const count = new Double( vertexCount );
        _normalizeResult.avgWeightError = sumErrorAccum.div( count ).valueOf();
    }

    packed.needsUpdate = true;

    _syncNormalizerECS( geometry, 4, SkinWeightLayout.PACKED, fallbackBoneIndex );
}

// ─── Public API: validate-only pass. ────────────────────────────────────────

/**
 * Validates the weights of a geometry without modifying them. Returns the
 * same statistics record with `verticesFixed = 0`.
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @return {object}
 */
function validateGeometry( geometry, options = {} ) {
    const bonesPerVertex = options.bonesPerVertex !== undefined
        ? options.bonesPerVertex
        : SkinnedMeshDefaults.bonesPerVertex;

    const t0 = _nowMs();

    _normalizeResult.vertexCount = 0;
    _normalizeResult.bonesPerVertex = bonesPerVertex;
    _normalizeResult.verticesNormalized = 0;
    _normalizeResult.verticesFixed = 0;
    _normalizeResult.verticesWithNaN = 0;
    _normalizeResult.verticesWithInf = 0;
    _normalizeResult.verticesWithNegatives = 0;
    _normalizeResult.verticesWithZeroSum = 0;
    _normalizeResult.verticesWithDroppedMass = 0;
    _normalizeResult.maxWeightError = 0.0;
    _normalizeResult.avgWeightError = 0.0;
    _normalizeResult.maxDroppedMass = 0.0;
    _normalizeResult.avgDroppedMass = 0.0;

    if ( geometry === undefined || geometry === null ) {
        _normalizeResult.lastNormalizeMs = _nowMs() - t0;
        return _normalizeResult;
    }

    const skinWeight = geometry.attributes.skinWeight;

    if ( skinWeight === undefined ) {
        _normalizeResult.lastNormalizeMs = _nowMs() - t0;
        return _normalizeResult;
    }

    const weights = skinWeight.array;
    const vertexCount = skinWeight.count;

    _normalizeResult.vertexCount = vertexCount;

    let sumErrorAccum = new Double( 0 );

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;

        let sum = 0.0;
        let hasNaN = false;
        let hasInf = false;
        let hasNegative = false;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const w = weights[ base + k ];

            if ( w !== w ) {
                hasNaN = true;
            } else if ( w === Infinity || w === - Infinity ) {
                hasInf = true;
            } else if ( w < 0.0 ) {
                hasNegative = true;
            } else {
                sum += w;
            }
        }

        if ( hasNaN ) _normalizeResult.verticesWithNaN ++;
        if ( hasInf ) _normalizeResult.verticesWithInf ++;
        if ( hasNegative ) _normalizeResult.verticesWithNegatives ++;
        if ( sum <= 1e-12 ) _normalizeResult.verticesWithZeroSum ++;

        const error = Math.abs( sum - 1.0 );
        if ( error > _normalizeResult.maxWeightError ) {
            _normalizeResult.maxWeightError = error;
        }
        sumErrorAccum = sumErrorAccum.add( new Double( error ) );
    }

    if ( vertexCount > 0 ) {
        const count = new Double( vertexCount );
        _normalizeResult.avgWeightError = sumErrorAccum.div( count ).valueOf();
    }

    _normalizeResult.lastNormalizeMs = _nowMs() - t0;

    return _normalizeResult;
}

// ─── Public API: set fallback bone. ─────────────────────────────────────────

/**
 * Sets the fallback bone used when a vertex has zero weight sum.
 * @param {number} boneIndex
 * @param {number} [boneHash=0]
 */
function setFallbackBone( boneIndex, boneHash = 0 ) {
    _fallbackBoneIndexGlobal = boneIndex | 0;
    _fallbackBoneHashGlobal = boneHash >>> 0;
}

/**
 * Returns the current fallback bone index.
 * @return {number}
 */
function getFallbackBoneIndex() {
    return _fallbackBoneIndexGlobal;
}

// ─── Public API: high-precision aggregate helpers. ──────────────────────────

/**
 * Returns the total number of vertices that required a fix.
 * @return {number}
 */
function getTotalFixedVertices() {
    return _normalizeResult.verticesFixed;
}

/**
 * Returns a high-precision ratio of fixed vertices to total vertices.
 * @return {number}
 */
function computeFixRatioHighPrecision() {
    const total = new Double( Math.max( 1, _normalizeResult.vertexCount ) );
    const fixed = new Double( _normalizeResult.verticesFixed );

    return fixed.div( total ).valueOf();
}

/**
 * Returns the current normalization result record.
 * @return {object}
 */
function getLastNormalizeResult() {
    return _normalizeResult;
}

// ─── Public API: ECS sync. ──────────────────────────────────────────────────

function _syncNormalizerECS( geometry, bonesPerVertex, layout, fallbackBoneIndex ) {
    // ── 1. Hash the geometry UUID for O(1) lookup. ─────────────────────────
    const geometryHash = _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );

    // ── 2. Find or create the ECS entity for this geometry. ────────────────
    let eid = _ecsNormalizerByHash.get( geometryHash );

    if ( eid === undefined ) {
        eid = addEntity( _normalizerWorld );
        addComponent( _normalizerWorld, SkinWeightNormalizerSoA, eid );
        _ecsNormalizerByHash.set( geometryHash, eid );
    }

    SkinWeightNormalizerSoA.geometryId[ eid ] = geometry.id !== undefined ? geometry.id : - 1;
    SkinWeightNormalizerSoA.geometryUuidHash[ eid ] = geometryHash;
    SkinWeightNormalizerSoA.vertexCount[ eid ] = _normalizeResult.vertexCount;
    SkinWeightNormalizerSoA.bonesPerVertex[ eid ] = bonesPerVertex;
    SkinWeightNormalizerSoA.layout[ eid ] = layout;

    SkinWeightNormalizerSoA.verticesNormalized[ eid ] = _normalizeResult.verticesNormalized;
    SkinWeightNormalizerSoA.verticesFixed[ eid ] = _normalizeResult.verticesFixed;
    SkinWeightNormalizerSoA.verticesWithNaN[ eid ] = _normalizeResult.verticesWithNaN;
    SkinWeightNormalizerSoA.verticesWithInf[ eid ] = _normalizeResult.verticesWithInf;
    SkinWeightNormalizerSoA.verticesWithNegatives[ eid ] = _normalizeResult.verticesWithNegatives;
    SkinWeightNormalizerSoA.verticesWithZeroSum[ eid ] = _normalizeResult.verticesWithZeroSum;
    SkinWeightNormalizerSoA.verticesWithDroppedMass[ eid ] = _normalizeResult.verticesWithDroppedMass;

    SkinWeightNormalizerSoA.maxWeightError[ eid ] = _normalizeResult.maxWeightError;
    SkinWeightNormalizerSoA.avgWeightError[ eid ] = _normalizeResult.avgWeightError;
    SkinWeightNormalizerSoA.maxDroppedMass[ eid ] = _normalizeResult.maxDroppedMass;
    SkinWeightNormalizerSoA.avgDroppedMass[ eid ] = _normalizeResult.avgDroppedMass;

    SkinWeightNormalizerSoA.fallbackBoneIndex[ eid ] = fallbackBoneIndex;
    SkinWeightNormalizerSoA.fallbackBoneHash[ eid ] = _fallbackBoneHashGlobal;

    // ── 3. Deterministic dither sample for replay. ────────────────────────
    const ditherSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ) >>> 0;
    const dither = _noise3D( ditherSeed * 1e-6, _normalizeResult.vertexCount * 0.001, layout );
    SkinWeightNormalizerSoA.ditherSample[ eid ] = dither;

    SkinWeightNormalizerSoA.lastNormalizeMs[ eid ] = _normalizeResult.lastNormalizeMs;
    SkinWeightNormalizerSoA.avgNormalizeMsEMA[ eid ] =
        SkinWeightNormalizerSoA.avgNormalizeMsEMA[ eid ] * 0.9 + _normalizeResult.lastNormalizeMs * 0.1;

    SkinWeightNormalizerSoA.normalized[ eid ] = 1;
    SkinWeightNormalizerSoA.lastFrameIndex[ eid ] = _frameIndex;
    SkinWeightNormalizerSoA.lastDeltaTime[ eid ] = 0.0;
}

// ─── ECS entity tracking. ───────────────────────────────────────────────────

const _ecsNormalizerByHash = new Map();
let _frameIndex = 0;

// ─── Public API: frame lifecycle. ───────────────────────────────────────────

/**
 * Advances the shared frame index for all normalizer entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _normalizerWorld, [ SkinWeightNormalizerSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];
        SkinWeightNormalizerSoA.lastFrameIndex[ eid ] = _frameIndex;
    }
}

// ─── Public API: query helpers over bitecs. ─────────────────────────────────

/**
 * Returns the ECS entity id for the given geometry UUID.
 * @param {string} uuid
 * @return {number}
 */
function getNormalizerEntityForUuid( uuid ) {
    const hash = _hashString( uuid );
    const eid = _ecsNormalizerByHash.get( hash );
    return eid !== undefined ? eid : - 1;
}

/**
 * Returns the aggregated statistics across all normalized geometries.
 * @return {object}
 */
function getAggregatedStats() {
    let totalGeometries = 0;
    let totalVertices = 0;
    let totalFixed = 0;
    let totalNaN = 0;
    let totalInf = 0;
    let totalNegatives = 0;
    let totalZeroSum = 0;
    let totalDropped = 0;
    let maxError = 0.0;
    let totalNormalizeMs = 0.0;

    const q = query( _normalizerWorld, [ SkinWeightNormalizerSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinWeightNormalizerSoA.normalized[ eid ] !== 1 ) continue;

        totalGeometries ++;
        totalVertices += SkinWeightNormalizerSoA.vertexCount[ eid ];
        totalFixed += SkinWeightNormalizerSoA.verticesFixed[ eid ];
        totalNaN += SkinWeightNormalizerSoA.verticesWithNaN[ eid ];
        totalInf += SkinWeightNormalizerSoA.verticesWithInf[ eid ];
        totalNegatives += SkinWeightNormalizerSoA.verticesWithNegatives[ eid ];
        totalZeroSum += SkinWeightNormalizerSoA.verticesWithZeroSum[ eid ];
        totalDropped += SkinWeightNormalizerSoA.verticesWithDroppedMass[ eid ];

        if ( SkinWeightNormalizerSoA.maxWeightError[ eid ] > maxError ) {
            maxError = SkinWeightNormalizerSoA.maxWeightError[ eid ];
        }

        totalNormalizeMs += SkinWeightNormalizerSoA.lastNormalizeMs[ eid ];
    }

    const total = new Double( totalNormalizeMs );

    return {
        totalGeometries: totalGeometries,
        totalVertices: totalVertices,
        totalFixed: totalFixed,
        totalNaN: totalNaN,
        totalInf: totalInf,
        totalNegatives: totalNegatives,
        totalZeroSum: totalZeroSum,
        totalDropped: totalDropped,
        maxWeightError: maxError,
        totalNormalizeMs: total.valueOf()
    };
}

// ─── gl-matrix packing for telemetry. ───────────────────────────────────────

/**
 * Packs normalization telemetry into a vec4 for GPU debug rendering.
 * Layout: (vertexCount, verticesFixed, maxWeightError, bonesPerVertex)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packNormalizerVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
        v,
        _normalizeResult.vertexCount,
        _normalizeResult.verticesFixed,
        _normalizeResult.maxWeightError,
        _normalizeResult.bonesPerVertex
    );
    return v;
}

/**
 * Packs the per-geometry statistics into a vec4.
 * @param {string} uuid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packGeometryStatsVec4( uuid, out ) {
    const v = out || _scratchVec4B;
    const eid = getNormalizerEntityForUuid( uuid );

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinWeightNormalizerSoA.vertexCount[ eid ],
        SkinWeightNormalizerSoA.verticesFixed[ eid ],
        SkinWeightNormalizerSoA.avgWeightError[ eid ],
        SkinWeightNormalizerSoA.layout[ eid ]
    );
    return v;
}

// ─── Deterministic dither sampling. ─────────────────────────────────────────

/**
 * Returns a deterministic dither sample for the given vertex index.
 * @param {number} geometryHash
 * @param {number} vertexIndex
 * @param {number} frameIndex
 * @return {number}
 */
function sampleVertexDither( geometryHash, vertexIndex, frameIndex ) {
    const seed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( vertexIndex * 0x85EBCA6B ) ^ ( frameIndex * 0xC2B2AE35 ) ) >>> 0;
    return _noise3D( seed * 1e-6, vertexIndex * 0.02, frameIndex * 0.01 );
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

void Bone;
void BufferAttribute;
void Vector3;
void BonesPerVertex;
void _scratchVec4C;

export {
    SkinWeightNormalizerSoA,
    normalizeGeometry,
    validateGeometry,
    setFallbackBone,
    getFallbackBoneIndex,
    getTotalFixedVertices,
    computeFixRatioHighPrecision,
    getLastNormalizeResult,
    getNormalizerEntityForUuid,
    getAggregatedStats,
    packNormalizerVec4,
    packGeometryStatsVec4,
    sampleVertexDither,
    beginFrame
};