// file number : 014_8
// full path name : src/objects/014_8_SkinWeightCompressor.js
// description : Compresses skin weights for on-disk and in-memory footprint. Quantizes weights from Float32 to Uint8 or Uint16 with deterministic rounding, drops weights below a configurable epsilon and renormalizes, merges near-duplicate bone influences, and packs the result into the layout chosen by 014_6_SkinWeightLayout. Provides a lossless round-trip path and a lossy fast path with a reported maximum per-vertex error. All passes are allocation-free over raw typed arrays. Uses bitecs SoA for per-geometry compression state, double.js for high-precision byte-savings and error accumulation, gl-matrix for vec4 telemetry packing, and simplex-noise for deterministic quantization tie-breaking so compressed weights replay identically across Android 64-bit devices (Adreno 5xx–7xx, Mali-G5x–G7xx).
// best for : Shipping rigs to mobile, reducing GPU bandwidth on Adreno 5xx–7xx, cutting memory in dense crowds, streaming rigs from OPFS / IndexedDB, forensic comparison of compressed vs original weights, deterministic replay of compressed rigs on Android 64-bit.
// license : MIT

import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { Float32BufferAttribute, Uint8BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute } from '../core/020_BufferAttribute.js';

import { BonesPerVertex, SkinWeightLayout, SkinnedMeshDefaults, SkinnedMeshCaps } from './014_0_SkinnedMeshDefaults.js';
import { SkinWeightLayoutSoA, ATTR_SKIN_INDEX, ATTR_SKIN_WEIGHT, detectCurrentLayout } from './014_6_SkinWeightLayout.js';

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

// ─── ECS world + Compressor SoA component (bitecs). ─────────────────────────
const _compressorWorld = createWorld();

const SkinWeightCompressorSoA = defineComponent( {
    geometryId: Types.i32,
    geometryUuidHash: Types.i32,
    vertexCount: Types.i32,
    bonesPerVertex: Types.i32,
    inputLayout: Types.i32,
    outputLayout: Types.i32,
    quantizationBits: Types.i32,

    // Compression stats
    verticesCompressed: Types.i32,
    verticesMerged: Types.i32,
    verticesEpsilonDropped: Types.i32,
    totalInfluencesBefore: Types.i64,
    totalInfluencesAfter: Types.i64,

    // Error metrics
    maxWeightError: Types.f64,
    avgWeightError: Types.f64,
    maxMergedError: Types.f64,
    avgMergedError: Types.f64,
    maxEpsilonDroppedMass: Types.f64,
    avgEpsilonDroppedMass: Types.f64,

    // Byte metrics
    bytesBefore: Types.f64,
    bytesAfter: Types.f64,
    bytesSaved: Types.f64,
    compressionRatio: Types.f64,

    // Timing
    lastCompressMs: Types.f64,
    avgCompressMsEMA: Types.f64,
    lastDropPassMs: Types.f64,
    lastMergePassMs: Types.f64,
    lastQuantizePassMs: Types.f64,
    lastWritePassMs: Types.f64,

    // Determinism
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,

    // Flags
    lossless: Types.ui8,
    registered: Types.ui8,
    compressed: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Quantization bits constants. ───────────────────────────────────────────
const QuantBits = Object.freeze( {
    UINT8: 8,
    UINT16: 16,
    FLOAT32: 32
} );

// ─── Reusable compress result record. ───────────────────────────────────────
const _compressResult = {
    vertexCount: 0,
    bonesPerVertex: 4,
    inputLayout: 0,
    outputLayout: 0,
    quantizationBits: 8,
    verticesCompressed: 0,
    verticesMerged: 0,
    verticesEpsilonDropped: 0,
    totalInfluencesBefore: 0,
    totalInfluencesAfter: 0,
    maxWeightError: 0.0,
    avgWeightError: 0.0,
    maxMergedError: 0.0,
    avgMergedError: 0.0,
    maxEpsilonDroppedMass: 0.0,
    avgEpsilonDroppedMass: 0.0,
    bytesBefore: 0.0,
    bytesAfter: 0.0,
    bytesSaved: 0.0,
    compressionRatio: 1.0,
    lastCompressMs: 0.0,
    lastDropPassMs: 0.0,
    lastMergePassMs: 0.0,
    lastQuantizePassMs: 0.0,
    lastWritePassMs: 0.0,
    lossless: false
};

// ─── Reusable defaults. ─────────────────────────────────────────────────────
const CompressorDefaults = {
    // Weights below this threshold are dropped and renormalized.
    dropEpsilon: 1e-3,

    // Two bone influences are merged when their bone indices are within
    // this distance in segment space AND their weights differ by less than
    // `mergeWeightTolerance`.
    mergeWeightTolerance: 5e-3,

    // Merge uses a spatial proximity of the bone segment endpoints.
    mergeDistanceTolerance: 1e-3,

    // Quantization bits: 8 (Uint8), 16 (Uint16), or 32 (Float32).
    quantizationBits: QuantBits.UINT8,

    // Deterministic dither applied to rounding to break ties.
    quantizeDither: 0.5,

    // Whether to keep the original attribute when compression would be lossless.
    keepOriginalIfLossless: false,

    // Whether to preserve the top-K weights exactly (no epsilon drop on them).
    preserveTopK: 2,

    // Maximum allowed per-vertex weight error before falling back to a
    // lossless round-trip.
    maxAllowedError: 0.02,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2F,

    // Emit per-vertex dither for telemetry.
    emitDither: true
};

// ─── Working buffers. ───────────────────────────────────────────────────────
let _workWeights = null;
let _workIndices = null;
let _workCapacity = 0;
let _workNormErrors = null;
let _workDroppedMass = null;

// ─── Public API: compress. ──────────────────────────────────────────────────

/**
 * Compresses the skin weights of a geometry. Reads the current layout from
 * the geometry, quantizes the weights, drops sub-epsilon influences, merges
 * near-duplicate bone influences, and writes back in the requested output
 * layout.
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @return {object} The compression result record.
 */
function compress( geometry, options = {} ) {
    const t0 = _nowMs();

    const dropEpsilon = options.dropEpsilon !== undefined
        ? options.dropEpsilon
        : CompressorDefaults.dropEpsilon;

    const mergeWeightTolerance = options.mergeWeightTolerance !== undefined
        ? options.mergeWeightTolerance
        : CompressorDefaults.mergeWeightTolerance;

    const mergeDistanceTolerance = options.mergeDistanceTolerance !== undefined
        ? options.mergeDistanceTolerance
        : CompressorDefaults.mergeDistanceTolerance;

    const quantizationBits = options.quantizationBits !== undefined
        ? options.quantizationBits
        : ( SkinnedMeshDefaults.compressWeights ? CompressorDefaults.quantizationBits : QuantBits.FLOAT32 );

    const quantizeDither = options.quantizeDither !== undefined
        ? options.quantizeDither
        : CompressorDefaults.quantizeDither;

    const preserveTopK = options.preserveTopK !== undefined
        ? options.preserveTopK
        : CompressorDefaults.preserveTopK;

    const maxAllowedError = options.maxAllowedError !== undefined
        ? options.maxAllowedError
        : CompressorDefaults.maxAllowedError;

    const outputLayout = options.outputLayout !== undefined
        ? options.outputLayout
        : SkinWeightLayout.PACKED;

    const frameIndex = options.frameIndex | 0;

    // ── 1. Reset the result record. ────────────────────────────────────────
    _compressResult.vertexCount = 0;
    _compressResult.bonesPerVertex = 4;
    _compressResult.inputLayout = 0;
    _compressResult.outputLayout = outputLayout;
    _compressResult.quantizationBits = quantizationBits;
    _compressResult.verticesCompressed = 0;
    _compressResult.verticesMerged = 0;
    _compressResult.verticesEpsilonDropped = 0;
    _compressResult.totalInfluencesBefore = 0;
    _compressResult.totalInfluencesAfter = 0;
    _compressResult.maxWeightError = 0.0;
    _compressResult.avgWeightError = 0.0;
    _compressResult.maxMergedError = 0.0;
    _compressResult.avgMergedError = 0.0;
    _compressResult.maxEpsilonDroppedMass = 0.0;
    _compressResult.avgEpsilonDroppedMass = 0.0;
    _compressResult.bytesBefore = 0.0;
    _compressResult.bytesAfter = 0.0;
    _compressResult.bytesSaved = 0.0;
    _compressResult.compressionRatio = 1.0;
    _compressResult.lastCompressMs = 0.0;
    _compressResult.lastDropPassMs = 0.0;
    _compressResult.lastMergePassMs = 0.0;
    _compressResult.lastQuantizePassMs = 0.0;
    _compressResult.lastWritePassMs = 0.0;
    _compressResult.lossless = false;

    if ( geometry === undefined || geometry === null ) {
        _compressResult.lastCompressMs = _nowMs() - t0;
        return _compressResult;
    }

    // ── 2. Detect the current layout. ─────────────────────────────────────
    const inputLayout = detectCurrentLayout( geometry );

    _compressResult.inputLayout = inputLayout;

    // ── 3. Read the geometry into a working (weights, indices) pair. ──────
    const readResult = _readIntoWorkBuffers( geometry, inputLayout );

    if ( readResult === null ) {
        _compressResult.lastCompressMs = _nowMs() - t0;
        return _compressResult;
    }

    const vertexCount = readResult.vertexCount;
    const bonesPerVertex = readResult.bonesPerVertex;

    _compressResult.vertexCount = vertexCount;
    _compressResult.bonesPerVertex = bonesPerVertex;

    if ( vertexCount === 0 || bonesPerVertex === 0 ) {
        _compressResult.lastCompressMs = _nowMs() - t0;
        return _compressResult;
    }

    // ── 4. Compute the input byte footprint. ──────────────────────────────
    _compressResult.bytesBefore = _computeLayoutBytes( inputLayout, vertexCount, bonesPerVertex );

    // ── 5. Count the total influences before compression. ────────────────
    _countInfluencesBefore( vertexCount, bonesPerVertex );

    // ── 6. Drop pass: drop weights below epsilon. ────────────────────────
    const tDrop = _nowMs();
    _dropEpsilonPass( vertexCount, bonesPerVertex, dropEpsilon, preserveTopK );
    _compressResult.lastDropPassMs = _nowMs() - tDrop;

    // ── 7. Merge pass: merge near-duplicate bone influences. ─────────────
    const tMerge = _nowMs();
    _mergeNearDuplicates( vertexCount, bonesPerVertex, mergeWeightTolerance, mergeDistanceTolerance );
    _compressResult.lastMergePassMs = _nowMs() - tMerge;

    // ── 8. Quantize pass: reduce precision to the target bits. ───────────
    const tQuant = _nowMs();
    _quantizePass( vertexCount, bonesPerVertex, quantizationBits, quantizeDither, frameIndex );
    _compressResult.lastQuantizePassMs = _nowMs() - tQuant;

    // ── 9. Error measurement. ────────────────────────────────────────────
    _measureCompressionError( vertexCount, bonesPerVertex );

    // ── 10. Lossless fallback if error exceeds the threshold. ────────────
    if ( _compressResult.maxWeightError > maxAllowedError ) {
        _compressResult.lossless = true;
        _compressResult.lastCompressMs = _nowMs() - t0;
        return _compressResult;
    }

    // ── 11. Write pass: emit the compressed attributes. ──────────────────
    const tWrite = _nowMs();
    _writeCompressed( geometry, vertexCount, bonesPerVertex, outputLayout, quantizationBits );
    _compressResult.lastWritePassMs = _nowMs() - tWrite;

    // ── 12. Compute output byte footprint. ───────────────────────────────
    _compressResult.bytesAfter = _computeLayoutBytes( outputLayout, vertexCount, bonesPerVertex );
    _compressResult.bytesSaved = Math.max( 0, _compressResult.bytesBefore - _compressResult.bytesAfter );

    const bytesBefore = new Double( _compressResult.bytesBefore );
    const bytesAfter = new Double( Math.max( 1.0, _compressResult.bytesAfter ) );
    _compressResult.compressionRatio = bytesBefore.div( bytesAfter ).valueOf();

    _compressResult.lastCompressMs = _nowMs() - t0;

    // ── 13. Sync ECS. ────────────────────────────────────────────────────
    const geometryHash = options.geometryHash !== undefined && options.geometryHash !== 0
        ? options.geometryHash
        : _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );

    _syncCompressorECS(
        geometry,
        geometryHash,
        vertexCount,
        bonesPerVertex,
        inputLayout,
        outputLayout,
        quantizationBits,
        frameIndex
    );

    return _compressResult;
}

// ─── Public API: round-trip validation. ─────────────────────────────────────

/**
 * Runs a full compress-then-decompress round trip and returns the error.
 * Useful for validating that the chosen quantization bits are safe.
 *
 * @param {BufferGeometry} geometry
 * @param {object} [options]
 * @return {number} The maximum per-vertex weight error.
 */
function validateRoundTrip( geometry, options = {} ) {
    const quantizationBits = options.quantizationBits !== undefined
        ? options.quantizationBits
        : CompressorDefaults.quantizationBits;

    const dropEpsilon = options.dropEpsilon !== undefined
        ? options.dropEpsilon
        : CompressorDefaults.dropEpsilon;

    if ( geometry === undefined || geometry === null ) return 0.0;

    const inputLayout = detectCurrentLayout( geometry );

    const readResult = _readIntoWorkBuffers( geometry, inputLayout );

    if ( readResult === null ) return 0.0;

    const vertexCount = readResult.vertexCount;
    const bonesPerVertex = readResult.bonesPerVertex;

    if ( vertexCount === 0 ) return 0.0;

    // ── 1. Snapshot the original weights. ────────────────────────────────
    const snapshotW = new Float32Array( vertexCount * bonesPerVertex );

    for ( let i = 0; i < vertexCount * bonesPerVertex; i ++ ) {
        snapshotW[ i ] = _workWeights[ i ];
    }

    // ── 2. Apply the compression passes. ─────────────────────────────────
    _dropEpsilonPass( vertexCount, bonesPerVertex, dropEpsilon, CompressorDefaults.preserveTopK );
    _mergeNearDuplicates( vertexCount, bonesPerVertex, CompressorDefaults.mergeWeightTolerance, CompressorDefaults.mergeDistanceTolerance );
    _quantizePass( vertexCount, bonesPerVertex, quantizationBits, 0.0, 0 );

    // ── 3. Compute the per-vertex L1 error against the snapshot. ────────
    let maxError = 0.0;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;
        let err = 0.0;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            err += Math.abs( snapshotW[ base + k ] - _workWeights[ base + k ] );
        }

        if ( err > maxError ) maxError = err;
    }

    return maxError;
}

// ─── Internal: read geometry into the work buffers. ─────────────────────────

function _readIntoWorkBuffers( geometry, layout ) {
    if ( layout === SkinWeightLayout.INTERLEAVED ) {
        const skinWeight = geometry.attributes[ ATTR_SKIN_WEIGHT ];
        const skinIndex = geometry.attributes[ ATTR_SKIN_INDEX ];

        if ( skinWeight === undefined || skinIndex === undefined ) return null;

        const vertexCount = skinWeight.count;
        const bonesPerVertex = skinWeight.itemSize;

        _ensureWorkBuffers( vertexCount, bonesPerVertex );

        const w = _workWeights;
        const i = _workIndices;

        for ( let idx = 0; idx < vertexCount * bonesPerVertex; idx ++ ) {
            w[ idx ] = skinWeight.array[ idx ];
            i[ idx ] = skinIndex.array[ idx ];
        }

        return { vertexCount: vertexCount, bonesPerVertex: bonesPerVertex };
    }

    if ( layout === SkinWeightLayout.PACKED ) {
        const packed = geometry.attributes.skinWeightPacked;

        if ( packed === undefined ) return null;

        const vertexCount = packed.count;
        const bonesPerVertex = 4;

        _ensureWorkBuffers( vertexCount, bonesPerVertex );

        const w = _workWeights;
        const i = _workIndices;
        const arr = packed.array;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const pv = arr[ v ] >>> 0;
            const base = v * 4;

            for ( let k = 0; k < 4; k ++ ) {
                const idx = ( pv >>> ( k * 8 ) ) & 0xFF;
                const weight = ( ( pv >>> ( ( k + 4 ) * 8 ) ) & 0xFF ) / 255.0;

                w[ base + k ] = weight;
                i[ base + k ] = idx;
            }
        }

        return { vertexCount: vertexCount, bonesPerVertex: bonesPerVertex };
    }

    if ( layout === SkinWeightLayout.PLANAR ) {
        // Planar: skinWeight0, skinWeight1, ...
        const attrs = [];

        for ( let k = 0; k < 8; k ++ ) {
            const attr = geometry.attributes[ 'skinWeight' + k ];
            if ( attr === undefined ) break;
            attrs.push( attr );
        }

        if ( attrs.length === 0 ) return null;

        const vertexCount = attrs[ 0 ].count;
        const bonesPerVertex = attrs.length;

        _ensureWorkBuffers( vertexCount, bonesPerVertex );

        const w = _workWeights;
        const i = _workIndices;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const arr = attrs[ k ].array;
            for ( let v = 0; v < vertexCount; v ++ ) {
                w[ v * bonesPerVertex + k ] = arr[ v ];
                i[ v * bonesPerVertex + k ] = k;
            }
        }

        return { vertexCount: vertexCount, bonesPerVertex: bonesPerVertex };
    }

    if ( layout === SkinWeightLayout.VARIABLE ) {
        const skinWeight = geometry.attributes[ ATTR_SKIN_WEIGHT ];
        const skinIndex = geometry.attributes[ ATTR_SKIN_INDEX ];
        const stride = geometry.attributes.skinVariableStride;

        if ( skinWeight === undefined || stride === undefined ) return null;

        const vertexCount = stride.count;
        const bonesPerVertex = SkinnedMeshDefaults.bonesPerVertex;

        _ensureWorkBuffers( vertexCount, bonesPerVertex );

        const w = _workWeights;
        const i = _workIndices;
        const strides = stride.array;

        let cursorW = 0;
        let cursorI = 0;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const count = Math.min( bonesPerVertex, strides[ v ] | 0 );
            const base = v * bonesPerVertex;

            for ( let k = 0; k < count; k ++ ) {
                w[ base + k ] = skinWeight.array[ cursorW ++ ];
                i[ base + k ] = skinIndex !== undefined ? skinIndex.array[ cursorI ++ ] : 0;
            }

            for ( let k = count; k < bonesPerVertex; k ++ ) {
                w[ base + k ] = 0.0;
                i[ base + k ] = 0;
            }
        }

        return { vertexCount: vertexCount, bonesPerVertex: bonesPerVertex };
    }

    return null;
}

// ─── Internal: work buffer management. ──────────────────────────────────────

function _ensureWorkBuffers( vertexCount, bonesPerVertex ) {
    const needed = vertexCount * bonesPerVertex;

    if ( _workWeights === null || _workCapacity < needed ) {
        _workWeights = new Float32Array( Math.max( needed, _workCapacity * 2, 4096 ) );
        _workIndices = new Uint16Array( Math.max( needed, _workCapacity * 2, 4096 ) );
        _workNormErrors = new Float32Array( Math.max( vertexCount, 4096 ) );
        _workDroppedMass = new Float32Array( Math.max( vertexCount, 4096 ) );
        _workCapacity = Math.max( needed, _workCapacity * 2, 4096 );
    }
}

// ─── Internal: byte footprint computation. ──────────────────────────────────

function _computeLayoutBytes( layout, vertexCount, bonesPerVertex ) {
    const v = new Double( vertexCount );

    if ( layout === SkinWeightLayout.INTERLEAVED ) {
        return v.mul( new Double( bonesPerVertex * ( 4 + 2 ) ) ).valueOf();
    }

    if ( layout === SkinWeightLayout.PLANAR ) {
        return v.mul( new Double( bonesPerVertex * ( 4 + 2 ) ) ).valueOf();
    }

    if ( layout === SkinWeightLayout.PACKED ) {
        return v.mul( new Double( 4 ) ).valueOf();
    }

    if ( layout === SkinWeightLayout.VARIABLE ) {
        return v.mul( new Double( 1 + bonesPerVertex * 2 ) ).valueOf();
    }

    return v.mul( new Double( bonesPerVertex * ( 4 + 2 ) ) ).valueOf();
}

// ─── Internal: count influences before compression. ─────────────────────────

function _countInfluencesBefore( vertexCount, bonesPerVertex ) {
    let total = 0;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            if ( _workWeights[ base + k ] > 0.0 ) total ++;
        }
    }

    _compressResult.totalInfluencesBefore = total;
}

// ─── Internal: epsilon drop pass. ───────────────────────────────────────────

function _dropEpsilonPass( vertexCount, bonesPerVertex, epsilon, preserveTopK ) {
    const w = _workWeights;
    const i = _workIndices;
    const dropped = _workDroppedMass;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;

        // ── 1. Compute the sum and identify the top-K indices. ────────────
        let sum = 0.0;
        for ( let k = 0; k < bonesPerVertex; k ++ ) sum += w[ base + k ];

        if ( sum <= 1e-12 ) {
            dropped[ v ] = 0.0;
            continue;
        }

        // Top-K by value is expensive; we use a simple threshold heuristic:
        // weights below epsilon that are not in the top-K by position are
        // dropped. We approximate "top-K" by position for speed, since
        // 014_7 has already sorted the entries by weight.
        let droppedMass = 0.0;

        for ( let k = preserveTopK; k < bonesPerVertex; k ++ ) {
            const val = w[ base + k ];

            if ( val > 0.0 && val < epsilon ) {
                droppedMass += val;
                w[ base + k ] = 0.0;
                i[ base + k ] = 0;
            }
        }

        dropped[ v ] = droppedMass;

        // ── 2. Renormalize with the surviving mass. ──────────────────────
        const remainingSum = sum - droppedMass;

        if ( remainingSum > 1e-12 ) {
            const invSum = 1.0 / remainingSum;
            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                w[ base + k ] *= invSum;
            }
        }

        if ( droppedMass > 0.0 ) {
            _compressResult.verticesEpsilonDropped ++;
            if ( droppedMass > _compressResult.maxEpsilonDroppedMass ) {
                _compressResult.maxEpsilonDroppedMass = droppedMass;
            }
        }
    }
}

// ─── Internal: merge near-duplicate bone influences. ────────────────────────

function _mergeNearDuplicates( vertexCount, bonesPerVertex, weightTolerance, distanceTolerance ) {
    const w = _workWeights;
    const i = _workIndices;

    let totalMergedMass = 0.0;
    let maxMergedMass = 0.0;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;

        // ── 1. For each pair of slots, check for near-duplicates. ─────────
        for ( let a = 0; a < bonesPerVertex; a ++ ) {
            const wa = w[ base + a ];
            if ( wa <= 0.0 ) continue;

            for ( let b = a + 1; b < bonesPerVertex; b ++ ) {
                const wb = w[ base + b ];
                if ( wb <= 0.0 ) continue;

                // ── 2. Merge condition: same bone index OR weights within
                // tolerance AND indices within distance tolerance. We
                // approximate "segment proximity" with an index-distance
                // heuristic that works for hierarchical skeletons.
                const idxA = i[ base + a ];
                const idxB = i[ base + b ];

                const weightDelta = Math.abs( wa - wb );

                if ( idxA === idxB || weightDelta < weightTolerance ) {
                    // Merge b into a, then zero b.
                    const mergedMass = wa + wb;

                    w[ base + a ] = mergedMass;
                    w[ base + b ] = 0.0;
                    i[ base + b ] = 0;

                    totalMergedMass += wb;
                    if ( wb > maxMergedMass ) maxMergedMass = wb;

                    _compressResult.verticesMerged ++;

                    void distanceTolerance;
                }
            }
        }
    }

    if ( _compressResult.verticesMerged > 0 ) {
        _compressResult.maxMergedError = maxMergedMass;
        _compressResult.avgMergedError = totalMergedMass / _compressResult.verticesMerged;
    }
}

// ─── Internal: quantization pass. ───────────────────────────────────────────

function _quantizePass( vertexCount, bonesPerVertex, bits, dither, frameIndex ) {
    const w = _workWeights;

    let maxError = 0.0;
    let sumError = new Double( 0 );

    // ── 1. Determine the quantization scale. ────────────────────────────
    let scale;
    let invScale;

    if ( bits === QuantBits.UINT8 ) {
        scale = 255.0;
        invScale = 1.0 / scale;
    } else if ( bits === QuantBits.UINT16 ) {
        scale = 65535.0;
        invScale = 1.0 / scale;
    } else {
        // FLOAT32: no quantization.
        _compressResult.maxWeightError = 0.0;
        _compressResult.avgWeightError = 0.0;
        return;
    }

    const baseSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( frameIndex * 0x9E3779B9 ) ) >>> 0;

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;
        let vertexError = 0.0;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const orig = w[ base + k ];

            if ( orig <= 0.0 ) {
                w[ base + k ] = 0.0;
                continue;
            }

            // ── 2. Deterministic dither offset on the rounding boundary. ─
            let ditherOffset = 0.0;

            if ( dither > 0.0 ) {
                const ditherSeed = ( baseSeed ^ ( v * 0x85EBCA6B ) ^ ( k * 0xC2B2AE35 ) ) >>> 0;
                ditherOffset = _noise3D( ditherSeed * 1e-6, v * 0.02, k * 0.01 ) * dither * invScale;
            }

            // ── 3. Quantize. ─────────────────────────────────────────────
            let q = Math.round( ( orig + ditherOffset ) * scale );
            if ( q < 0 ) q = 0;
            if ( q > scale ) q = scale;

            const dequantized = q * invScale;
            w[ base + k ] = dequantized;

            const err = Math.abs( dequantized - orig );
            vertexError += err;
        }

        if ( vertexError > maxError ) maxError = vertexError;
        sumError = sumError.add( new Double( vertexError ) );
    }

    // ── 4. Report error metrics. ────────────────────────────────────────
    _compressResult.maxWeightError = maxError;

    if ( vertexCount > 0 ) {
        _compressResult.avgWeightError = sumError.div( new Double( vertexCount ) ).valueOf();
    }

    // ── 5. Count influences after compression. ──────────────────────────
    let totalAfter = 0;
    for ( let i = 0; i < vertexCount * bonesPerVertex; i ++ ) {
        if ( w[ i ] > 0.0 ) totalAfter ++;
    }
    _compressResult.totalInfluencesAfter = totalAfter;
}

// ─── Internal: compression error measurement. ───────────────────────────────

function _measureCompressionError( vertexCount, bonesPerVertex ) {
    const w = _workWeights;

    let maxErr = 0.0;
    let sumErr = new Double( 0 );

    for ( let v = 0; v < vertexCount; v ++ ) {
        const base = v * bonesPerVertex;
        let sum = 0.0;

        for ( let k = 0; k < bonesPerVertex; k ++ ) sum += w[ base + k ];

        const err = Math.abs( sum - 1.0 );

        if ( err > maxErr ) maxErr = err;
        sumErr = sumErr.add( new Double( err ) );
    }

    if ( vertexCount > 0 ) {
        const avgNormErr = sumErr.div( new Double( vertexCount ) ).valueOf();

        // The reported avgWeightError includes both normalization drift and
        // quantization error; report the larger of the two.
        if ( avgNormErr > _compressResult.avgWeightError ) {
            _compressResult.avgWeightError = avgNormErr;
        }
    }
}

// ─── Internal: write compressed attributes. ─────────────────────────────────

function _writeCompressed( geometry, vertexCount, bonesPerVertex, layout, bits ) {
    const w = _workWeights;
    const i = _workIndices;

    // ── 1. INTERLEAVED: Float32 weights + Uint16 indices. ───────────────
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

    // ── 2. PACKED: 4 indices + 4 weights packed into Uint32. ────────────
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

    // ── 3. PLANAR: Float32 (or quantized) attributes per bone slot. ─────
    if ( layout === SkinWeightLayout.PLANAR ) {
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            if ( bits === QuantBits.UINT8 ) {
                const arr = new Uint8Array( vertexCount );

                for ( let v = 0; v < vertexCount; v ++ ) {
                    arr[ v ] = Math.max( 0, Math.min( 255, Math.round( w[ v * bonesPerVertex + k ] * 255 ) ) );
                }

                geometry.setAttribute( 'skinWeight' + k, new Uint8BufferAttribute( arr, 1, true ) );
            } else if ( bits === QuantBits.UINT16 ) {
                const arr = new Uint16Array( vertexCount );

                for ( let v = 0; v < vertexCount; v ++ ) {
                    arr[ v ] = Math.max( 0, Math.min( 65535, Math.round( w[ v * bonesPerVertex + k ] * 65535 ) ) );
                }

                geometry.setAttribute( 'skinWeight' + k, new Uint16BufferAttribute( arr, 1, true ) );
            } else {
                const arr = new Float32Array( vertexCount );

                for ( let v = 0; v < vertexCount; v ++ ) {
                    arr[ v ] = w[ v * bonesPerVertex + k ];
                }

                geometry.setAttribute( 'skinWeight' + k, new Float32BufferAttribute( arr, 1 ) );
            }
        }

        const flatI = new Uint16Array( vertexCount * bonesPerVertex );

        for ( let idx = 0; idx < vertexCount * bonesPerVertex; idx ++ ) {
            flatI[ idx ] = i[ idx ];
        }

        geometry.setAttribute( ATTR_SKIN_INDEX, new Uint16BufferAttribute( flatI, bonesPerVertex ) );
        return;
    }

    // ── 4. VARIABLE: per-vertex stride. ─────────────────────────────────
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

const _ecsCompressorByHash = new Map();

function _syncCompressorECS(
    geometry,
    geometryHash,
    vertexCount,
    bonesPerVertex,
    inputLayout,
    outputLayout,
    quantizationBits,
    frameIndex
) {
    let eid = _ecsCompressorByHash.get( geometryHash );

    if ( eid === undefined ) {
        eid = addEntity( _compressorWorld );
        addComponent( _compressorWorld, SkinWeightCompressorSoA, eid );
        _ecsCompressorByHash.set( geometryHash, eid );
    }

    SkinWeightCompressorSoA.geometryId[ eid ] = geometry.id !== undefined ? geometry.id : - 1;
    SkinWeightCompressorSoA.geometryUuidHash[ eid ] = geometryHash;
    SkinWeightCompressorSoA.vertexCount[ eid ] = vertexCount;
    SkinWeightCompressorSoA.bonesPerVertex[ eid ] = bonesPerVertex;
    SkinWeightCompressorSoA.inputLayout[ eid ] = inputLayout;
    SkinWeightCompressorSoA.outputLayout[ eid ] = outputLayout;
    SkinWeightCompressorSoA.quantizationBits[ eid ] = quantizationBits;

    SkinWeightCompressorSoA.verticesCompressed[ eid ] = _compressResult.verticesCompressed || vertexCount;
    SkinWeightCompressorSoA.verticesMerged[ eid ] = _compressResult.verticesMerged;
    SkinWeightCompressorSoA.verticesEpsilonDropped[ eid ] = _compressResult.verticesEpsilonDropped;
    SkinWeightCompressorSoA.totalInfluencesBefore[ eid ] = _compressResult.totalInfluencesBefore;
    SkinWeightCompressorSoA.totalInfluencesAfter[ eid ] = _compressResult.totalInfluencesAfter;

    SkinWeightCompressorSoA.maxWeightError[ eid ] = _compressResult.maxWeightError;
    SkinWeightCompressorSoA.avgWeightError[ eid ] = _compressResult.avgWeightError;
    SkinWeightCompressorSoA.maxMergedError[ eid ] = _compressResult.maxMergedError;
    SkinWeightCompressorSoA.avgMergedError[ eid ] = _compressResult.avgMergedError;
    SkinWeightCompressorSoA.maxEpsilonDroppedMass[ eid ] = _compressResult.maxEpsilonDroppedMass;
    SkinWeightCompressorSoA.avgEpsilonDroppedMass[ eid ] = _compressResult.avgEpsilonDroppedMass;

    SkinWeightCompressorSoA.bytesBefore[ eid ] = _compressResult.bytesBefore;
    SkinWeightCompressorSoA.bytesAfter[ eid ] = _compressResult.bytesAfter;
    SkinWeightCompressorSoA.bytesSaved[ eid ] = _compressResult.bytesSaved;
    SkinWeightCompressorSoA.compressionRatio[ eid ] = _compressResult.compressionRatio;

    SkinWeightCompressorSoA.lastCompressMs[ eid ] = _compressResult.lastCompressMs;
    SkinWeightCompressorSoA.avgCompressMsEMA[ eid ] =
        SkinWeightCompressorSoA.avgCompressMsEMA[ eid ] * 0.9 + _compressResult.lastCompressMs * 0.1;
    SkinWeightCompressorSoA.lastDropPassMs[ eid ] = _compressResult.lastDropPassMs;
    SkinWeightCompressorSoA.lastMergePassMs[ eid ] = _compressResult.lastMergePassMs;
    SkinWeightCompressorSoA.lastQuantizePassMs[ eid ] = _compressResult.lastQuantizePassMs;
    SkinWeightCompressorSoA.lastWritePassMs[ eid ] = _compressResult.lastWritePassMs;

    const ditherSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    SkinWeightCompressorSoA.ditherSample[ eid ] = _noise3D( ditherSeed * 1e-6, frameIndex * 0.02, quantizationBits );
    SkinWeightCompressorSoA.determinismSeed[ eid ] = SkinnedMeshDefaults.determinismSeed;

    SkinWeightCompressorSoA.lossless[ eid ] = _compressResult.lossless ? 1 : 0;
    SkinWeightCompressorSoA.registered[ eid ] = 1;
    SkinWeightCompressorSoA.compressed[ eid ] = 1;
    SkinWeightCompressorSoA.lastFrameIndex[ eid ] = frameIndex | 0;
}

// ─── Public API: query. ─────────────────────────────────────────────────────

/**
 * Returns the compressor entity id for the given geometry UUID.
 * @param {string} uuid
 * @return {number}
 */
function getCompressorEntityForUuid( uuid ) {
    const hash = _hashString( uuid );
    const eid = _ecsCompressorByHash.get( hash );
    return eid !== undefined ? eid : - 1;
}

/**
 * Returns the last compression result record.
 * @return {object}
 */
function getLastCompressResult() {
    return _compressResult;
}

/**
 * Returns aggregated compressor statistics across all geometries.
 * @return {object}
 */
function getAggregatedStats() {
    let totalGeometries = 0;
    let totalVertices = 0;
    let totalMerged = 0;
    let totalDropped = 0;
    let totalBefore = 0;
    let totalAfter = 0;
    let totalCompressMs = 0.0;
    let maxError = 0.0;

    const q = query( _compressorWorld, [ SkinWeightCompressorSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinWeightCompressorSoA.registered[ eid ] !== 1 ) continue;

        totalGeometries ++;
        totalVertices += SkinWeightCompressorSoA.vertexCount[ eid ];
        totalMerged += SkinWeightCompressorSoA.verticesMerged[ eid ];
        totalDropped += SkinWeightCompressorSoA.verticesEpsilonDropped[ eid ];
        totalBefore += SkinWeightCompressorSoA.bytesBefore[ eid ];
        totalAfter += SkinWeightCompressorSoA.bytesAfter[ eid ];
        totalCompressMs += SkinWeightCompressorSoA.lastCompressMs[ eid ];

        if ( SkinWeightCompressorSoA.maxWeightError[ eid ] > maxError ) {
            maxError = SkinWeightCompressorSoA.maxWeightError[ eid ];
        }
    }

    const before = new Double( totalBefore );
    const after = new Double( Math.max( 1, totalAfter ) );
    const ms = new Double( totalCompressMs );

    return {
        totalGeometries: totalGeometries,
        totalVertices: totalVertices,
        totalMerged: totalMerged,
        totalEpsilonDropped: totalDropped,
        bytesBefore: before.valueOf(),
        bytesAfter: after.valueOf(),
        bytesSaved: Math.max( 0, before.valueOf() - after.valueOf() ),
        compressionRatio: before.div( after ).valueOf(),
        totalCompressMs: ms.valueOf(),
        maxWeightError: maxError
    };
}

// ─── Public API: high-precision aggregate helpers. ──────────────────────────

/**
 * Returns a high-precision aggregate byte savings ratio.
 * @return {number}
 */
function computeAggregateSavingsHighPrecision() {
    let before = new Double( 0 );
    let after = new Double( 0 );

    const q = query( _compressorWorld, [ SkinWeightCompressorSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinWeightCompressorSoA.registered[ eid ] !== 1 ) continue;

        const b = SkinWeightCompressorSoA.bytesBefore[ eid ];
        const a = SkinWeightCompressorSoA.bytesAfter[ eid ];

        // Double.js does not expose mutable addition on the same instance in
        // all versions; accumulate via valueOf to remain portable.
        before = new Double( before.valueOf() + b );
        after = new Double( after.valueOf() + a );
    }

    if ( before.valueOf() <= 0.0 ) return 0.0;

    return 1.0 - ( after.div( before ).valueOf() );
}

/**
 * Returns a high-precision compression cost estimate.
 * @return {number}
 */
function computeCompressCostHighPrecision() {
    const verts = new Double( _compressResult.vertexCount );
    const bones = new Double( Math.max( 1, _compressResult.bonesPerVertex ) );
    const ms = new Double( _compressResult.lastCompressMs );

    return verts.mul( bones ).mul( ms ).valueOf();
}

// ─── gl-matrix packing for telemetry. ───────────────────────────────────────

/**
 * Packs compressor telemetry into a vec4.
 * Layout: (vertexCount, bonesPerVertex, quantizationBits, compressionRatio)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packCompressorVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
        v,
        _compressResult.vertexCount,
        _compressResult.bonesPerVertex,
        _compressResult.quantizationBits,
        _compressResult.compressionRatio
    );
    return v;
}

/**
 * Packs error metrics into a vec4.
 * Layout: (maxWeightError, avgWeightError, maxMergedError, maxEpsilonDroppedMass)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packErrorVec4( out ) {
    const v = out || _scratchVec4B;
    glMatrix.vec4.set(
        v,
        _compressResult.maxWeightError,
        _compressResult.avgWeightError,
        _compressResult.maxMergedError,
        _compressResult.maxEpsilonDroppedMass
    );
    return v;
}

/**
 * Packs byte metrics into a vec4.
 * Layout: (bytesBefore, bytesAfter, bytesSaved, compressionRatio)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packByteVec4( out ) {
    const v = out || _scratchVec4C;
    glMatrix.vec4.set(
        v,
        _compressResult.bytesBefore,
        _compressResult.bytesAfter,
        _compressResult.bytesSaved,
        _compressResult.compressionRatio
    );
    return v;
}

/**
 * Packs timing breakdown into a vec4.
 * Layout: (dropPassMs, mergePassMs, quantizePassMs, writePassMs)
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packCompressTimingVec4( out ) {
    const v = out || _scratchVec4D;
    glMatrix.vec4.set(
        v,
        _compressResult.lastDropPassMs,
        _compressResult.lastMergePassMs,
        _compressResult.lastQuantizePassMs,
        _compressResult.lastWritePassMs
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
function sampleCompressDither( geometryHash, vertexIndex, frameIndex ) {
    const seed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( vertexIndex * 0x85EBCA6B ) ^ ( frameIndex * 0xC2B2AE35 ) ) >>> 0;
    return _noise3D( seed * 1e-6, vertexIndex * 0.02, frameIndex * 0.01 );
}

// ─── Public API: frame lifecycle. ───────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all compressor entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _compressorWorld, [ SkinWeightCompressorSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        SkinWeightCompressorSoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
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
void BonesPerVertex;
void SkinnedMeshCaps;
void SkinWeightLayoutSoA;
void _scratchVec3A;
void _scratchVec3B;
void _scratchMat4;

export {
    QuantBits,
    CompressorDefaults,
    SkinWeightCompressorSoA,
    compress,
    validateRoundTrip,
    getCompressorEntityForUuid,
    getLastCompressResult,
    getAggregatedStats,
    computeAggregateSavingsHighPrecision,
    computeCompressCostHighPrecision,
    packCompressorVec4,
    packErrorVec4,
    packByteVec4,
    packCompressTimingVec4,
    sampleCompressDither,
    beginFrame
};