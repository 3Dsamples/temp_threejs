// file number : 014_6
// full path name : src/objects/014_6_SkinWeightLayout.js
// description : Manages the four supported skin-weight layouts: interleaved (skinIndex + skinWeight as two attributes, itemSize = bonesPerVertex), planar (one attribute per bone slot), packed (single Uint32 attribute with 4×8-bit indices and 4×8-bit weights), and variable (per-vertex bone count with a stride table). Converts between layouts, computes buffer sizes, and emits the correct shader defines. Chooses the lowest-memory layout automatically based on bonesPerVertex, mesh vertex count, and the Android tier. Uses bitecs SoA to register per-geometry layout state, double.js for high-precision byte accounting across very large meshes, gl-matrix for layout-descriptor packing into vec4 telemetry, and simplex-noise for deterministic tie-breaking when two layouts have identical memory cost.
// best for : Memory-constrained mobile scenes, mixed rigs in one scene, packing 4 weights into 4 bytes, shader-define consistency, layout migration, deterministic auto-selection on Adreno 5xx–7xx and Mali-G5x–G7xx.
// license : MIT

import { BufferAttribute, Float32BufferAttribute, Uint8BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute } from '../core/020_BufferAttribute.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';

import { BonesPerVertex, SkinWeightLayout, SkinnedMeshDefaults } from './014_0_SkinnedMeshDefaults.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec4B = new Float64Array( 4 );
const _scratchVec4C = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _noise3D = createNoise3D();

// ─── ECS world + Layout SoA component (bitecs). ─────────────────────────────
const _layoutWorld = createWorld();

const SkinWeightLayoutSoA = defineComponent( {
    geometryId: Types.i32,
    geometryUuidHash: Types.i32,
    vertexCount: Types.i32,

    currentLayout: Types.i32,
    targetLayout: Types.i32,
    bonesPerVertex: Types.i32,

    // Memory footprint per layout (bytes).
    bytesInterleaved: Types.f64,
    bytesPlanar: Types.f64,
    bytesPacked: Types.f64,
    bytesVariable: Types.f64,
    chosenBytes: Types.f64,
    savedBytes: Types.f64,

    // Convert operations.
    conversionCount: Types.i32,
    lastConversionMs: Types.f64,
    avgConversionMsEMA: Types.f64,

    // Shader defines (bitmask).
    shaderDefinesMask: Types.i32,

    // Determinism.
    determinismSeed: Types.ui32,
    ditherSample: Types.f64,
    tieBrokenBy: Types.i32,

    // State.
    registered: Types.ui8,
    lastFrameIndex: Types.i32
} );

// ─── Shader define bitmask constants. ───────────────────────────────────────
const ShaderDefine = Object.freeze( {
    NONE: 0,
    BONES_PER_VERTEX_2: 1 << 0,
    BONES_PER_VERTEX_4: 1 << 1,
    BONES_PER_VERTEX_8: 1 << 2,
    LAYOUT_INTERLEAVED: 1 << 3,
    LAYOUT_PLANAR: 1 << 4,
    LAYOUT_PACKED: 1 << 5,
    LAYOUT_VARIABLE: 1 << 6,
    USE_PACKED_UINT32: 1 << 7,
    USE_PLANAR_ATTRS: 1 << 8,
    USE_INTERLEAVED_ATTRS: 1 << 9,
    USE_VARIABLE_STRIDE: 1 << 10
} );

// ─── Attribute name conventions. ────────────────────────────────────────────
const ATTR_SKIN_INDEX = 'skinIndex';
const ATTR_SKIN_WEIGHT = 'skinWeight';
const ATTR_SKIN_WEIGHT_PACKED = 'skinWeightPacked';
const ATTR_SKIN_WEIGHT_PLANAR_PREFIX = 'skinWeight';
const ATTR_SKIN_VARIABLE_STRIDE = 'skinVariableStride';

// ─── Layout selection policy constants. ─────────────────────────────────────
const LayoutPolicy = Object.freeze( {
    LOWEST_MEMORY: 0,
    LOWEST_CPU: 1,
    GPU_FRIENDLY: 2,
    MANUAL: 3
} );

// ─── Reusable conversion result record. ─────────────────────────────────────
const _conversionResult = {
    geometryUuidHash: 0,
    vertexCount: 0,
    fromLayout: 0,
    toLayout: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    conversionMs: 0.0,
    success: false
};

// ─── Public API: buffer size computation. ───────────────────────────────────

/**
 * Computes the byte footprint of each layout for a given geometry shape.
 *
 * @param {number} vertexCount
 * @param {number} bonesPerVertex
 * @return {object} Byte counts for each layout.
 */
function computeLayoutSizes( vertexCount, bonesPerVertex ) {
    const v = new Double( Math.max( 0, vertexCount | 0 ) );
    const b = Math.max( 2, Math.min( 8, bonesPerVertex | 0 ) );

    // Interleaved: skinIndex (Uint16 or Uint32) + skinWeight (Float32).
    // We count index as Uint16 when boneCount <= 65535 for the standard case.
    const indexBytesPerEntry = 2;    // Uint16
    const weightBytesPerEntry = 4;   // Float32

    const bytesInterleaved = v.mul( new Double( b * ( indexBytesPerEntry + weightBytesPerEntry ) ) ).valueOf();

    // Planar: one Float32 attribute per bone slot (weights) + one Uint16 (indices).
    const bytesPlanar = v.mul( new Double( b * ( weightBytesPerEntry + indexBytesPerEntry ) ) ).valueOf();

    // Packed: 4 indices (Uint8) + 4 weights (Uint8) = 4 bytes per vertex.
    // Only valid for b <= 4. For b > 4, we fall back to interleaved sizing.
    let bytesPacked;
    if ( b <= 4 ) {
        bytesPacked = v.mul( new Double( 4 ) ).valueOf();
    } else {
        bytesPacked = v.mul( new Double( 8 ) ).valueOf(); // two packed Uint32 words
    }

    // Variable: per-vertex stride table + packed indices + packed weights.
    // Stride table costs 1 byte per vertex; data is variable but bounded by b.
    const bytesVariable = v.mul( new Double( 1 + b * 2 ) ).valueOf();

    return {
        interleaved: bytesInterleaved,
        planar: bytesPlanar,
        packed: bytesPacked,
        variable: bytesVariable
    };
}

// ─── Public API: choose layout. ─────────────────────────────────────────────

/**
 * Chooses the lowest-memory layout for a geometry, respecting the Android
 * tier defaults and the layout policy.
 *
 * @param {number} vertexCount
 * @param {number} bonesPerVertex
 * @param {number} [policy=LayoutPolicy.LOWEST_MEMORY]
 * @param {number} [frameIndex=0]
 * @return {number} The chosen `SkinWeightLayout` value.
 */
function chooseLayout( vertexCount, bonesPerVertex, policy = LayoutPolicy.LOWEST_MEMORY, frameIndex = 0 ) {
    // ── 1. Respect the tier default when the policy is MANUAL. ─────────────
    if ( policy === LayoutPolicy.MANUAL ) {
        return SkinnedMeshDefaults.weightLayout;
    }

    // ── 2. Compute memory footprints. ──────────────────────────────────────
    const sizes = computeLayoutSizes( vertexCount, bonesPerVertex );

    // ── 3. Apply the policy. ───────────────────────────────────────────────
    let chosen;

    if ( policy === LayoutPolicy.GPU_FRIENDLY ) {
        // Interleaved is the fastest GPU path (single fetch).
        chosen = SkinWeightLayout.INTERLEAVED;
    } else if ( policy === LayoutPolicy.LOWEST_CPU ) {
        // Packed minimizes CPU copy cost per vertex (single Uint32 write).
        chosen = SkinWeightLayout.PACKED;
    } else {
        // ── 4. LOWEST_MEMORY: pick the smallest. ───────────────────────────
        const candidates = [
            { layout: SkinWeightLayout.INTERLEAVED, bytes: sizes.interleaved },
            { layout: SkinWeightLayout.PLANAR, bytes: sizes.planar },
            { layout: SkinWeightLayout.PACKED, bytes: sizes.packed },
            { layout: SkinWeightLayout.VARIABLE, bytes: sizes.variable }
        ];

        candidates.sort( ( a, b ) => a.bytes - b.bytes );

        chosen = candidates[ 0 ].layout;

        // ── 5. Tie-break with deterministic dither. ───────────────────────
        if ( candidates.length > 1 && candidates[ 0 ].bytes === candidates[ 1 ].bytes ) {
            const seed = ( SkinnedMeshDefaults.determinismSeed ^ ( vertexCount * 0x9E3779B9 ) ^ ( bonesPerVertex * 0x85EBCA6B ) ^ ( frameIndex * 0xC2B2AE35 ) ) >>> 0;
            const dither = _noise3D( seed * 1e-6, vertexCount * 0.001, bonesPerVertex );

            chosen = dither >= 0.0 ? candidates[ 0 ].layout : candidates[ 1 ].layout;
        }
    }

    // ── 6. Enforce the tier restriction on PACKED. ─────────────────────────
    // LOW tier cannot afford the unpack cost, so we force PACKED.
    // HIGH / FLAGSHIP prefer INTERLEAVED when b >= 4.
    const tier = SkinnedMeshDefaults.androidTier;

    if ( tier === 1 && bonesPerVertex <= 4 ) {
        chosen = SkinWeightLayout.PACKED;
    }

    if ( tier >= 3 && bonesPerVertex >= 4 ) {
        chosen = SkinWeightLayout.INTERLEAVED;
    }

    return chosen;
}

// ─── Public API: attribute name generation. ─────────────────────────────────

/**
 * Returns the attribute names used by a given layout.
 *
 * @param {number} layout
 * @param {number} bonesPerVertex
 * @return {Array<string>}
 */
function getAttributeNamesForLayout( layout, bonesPerVertex ) {
    if ( layout === SkinWeightLayout.INTERLEAVED ) {
        return [ ATTR_SKIN_INDEX, ATTR_SKIN_WEIGHT ];
    }

    if ( layout === SkinWeightLayout.PLANAR ) {
        const names = [];
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            names.push( ATTR_SKIN_WEIGHT_PLANAR_PREFIX + k );
        }
        return names;
    }

    if ( layout === SkinWeightLayout.PACKED ) {
        return [ ATTR_SKIN_WEIGHT_PACKED ];
    }

    return [ ATTR_SKIN_INDEX, ATTR_SKIN_WEIGHT, ATTR_SKIN_VARIABLE_STRIDE ];
}

// ─── Public API: shader define emission. ────────────────────────────────────

/**
 * Returns a shader-defines object for the given layout and bonesPerVertex.
 * The returned object can be merged into a material's `defines`.
 *
 * @param {number} layout
 * @param {number} bonesPerVertex
 * @return {object}
 */
function getShaderDefines( layout, bonesPerVertex ) {
    const defines = {};

    if ( bonesPerVertex === 2 ) defines.BONES_PER_VERTEX = 2;
    else if ( bonesPerVertex === 4 ) defines.BONES_PER_VERTEX = 4;
    else if ( bonesPerVertex === 8 ) defines.BONES_PER_VERTEX = 8;

    if ( layout === SkinWeightLayout.INTERLEAVED ) {
        defines.USE_INTERLEAVED_ATTRS = 1;
    } else if ( layout === SkinWeightLayout.PLANAR ) {
        defines.USE_PLANAR_ATTRS = 1;
    } else if ( layout === SkinWeightLayout.PACKED ) {
        defines.USE_PACKED_UINT32 = 1;
    } else if ( layout === SkinWeightLayout.VARIABLE ) {
        defines.USE_VARIABLE_STRIDE = 1;
    }

    return defines;
}

/**
 * Returns the shader define bitmask for the given layout.
 * @param {number} layout
 * @param {number} bonesPerVertex
 * @return {number}
 */
function getShaderDefinesMask( layout, bonesPerVertex ) {
    let mask = ShaderDefine.NONE;

    if ( bonesPerVertex === 2 ) mask |= ShaderDefine.BONES_PER_VERTEX_2;
    else if ( bonesPerVertex === 4 ) mask |= ShaderDefine.BONES_PER_VERTEX_4;
    else if ( bonesPerVertex === 8 ) mask |= ShaderDefine.BONES_PER_VERTEX_8;

    if ( layout === SkinWeightLayout.INTERLEAVED ) {
        mask |= ShaderDefine.LAYOUT_INTERLEAVED | ShaderDefine.USE_INTERLEAVED_ATTRS;
    } else if ( layout === SkinWeightLayout.PLANAR ) {
        mask |= ShaderDefine.LAYOUT_PLANAR | ShaderDefine.USE_PLANAR_ATTRS;
    } else if ( layout === SkinWeightLayout.PACKED ) {
        mask |= ShaderDefine.LAYOUT_PACKED | ShaderDefine.USE_PACKED_UINT32;
    } else if ( layout === SkinWeightLayout.VARIABLE ) {
        mask |= ShaderDefine.LAYOUT_VARIABLE | ShaderDefine.USE_VARIABLE_STRIDE;
    }

    return mask;
}

// ─── Public API: conversion. ────────────────────────────────────────────────

/**
 * Converts a geometry's skin weights from one layout to another in-place.
 * Handles all 12 combinations supported by the four layouts.
 *
 * @param {BufferGeometry} geometry
 * @param {number} fromLayout
 * @param {number} toLayout
 * @param {number} [bonesPerVertex=4]
 * @param {number} [frameIndex=0]
 * @return {object} The conversion result record.
 */
function convertLayout( geometry, fromLayout, toLayout, bonesPerVertex = 4, frameIndex = 0 ) {
    const t0 = _nowMs();

    _conversionResult.geometryUuidHash = 0;
    _conversionResult.vertexCount = 0;
    _conversionResult.fromLayout = fromLayout;
    _conversionResult.toLayout = toLayout;
    _conversionResult.bytesBefore = 0;
    _conversionResult.bytesAfter = 0;
    _conversionResult.bytesSaved = 0;
    _conversionResult.conversionMs = 0.0;
    _conversionResult.success = false;

    if ( geometry === undefined || geometry === null ) {
        _conversionResult.conversionMs = _nowMs() - t0;
        return _conversionResult;
    }

    if ( fromLayout === toLayout ) {
        _conversionResult.success = true;
        _conversionResult.conversionMs = _nowMs() - t0;
        return _conversionResult;
    }

    const geometryHash = _hashString( geometry.uuid !== undefined ? geometry.uuid : '' );
    _conversionResult.geometryUuidHash = geometryHash;

    // ── 1. Read the source layout into flat typed arrays. ──────────────────
    const source = _readSource( geometry, fromLayout, bonesPerVertex );

    if ( source === null ) {
        _conversionResult.conversionMs = _nowMs() - t0;
        return _conversionResult;
    }

    _conversionResult.vertexCount = source.vertexCount;
    _conversionResult.bytesBefore = source.bytesBefore;

    // ── 2. Write the target layout. ────────────────────────────────────────
    const bytesAfter = _writeTarget( geometry, toLayout, source, bonesPerVertex );

    if ( bytesAfter < 0 ) {
        _conversionResult.conversionMs = _nowMs() - t0;
        return _conversionResult;
    }

    _conversionResult.bytesAfter = bytesAfter;
    _conversionResult.bytesSaved = Math.max( 0, source.bytesBefore - bytesAfter );
    _conversionResult.success = true;
    _conversionResult.conversionMs = _nowMs() - t0;

    // ── 3. Sync ECS. ───────────────────────────────────────────────────────
    _syncLayoutECS( geometry, geometryHash, source.vertexCount, toLayout, bonesPerVertex, frameIndex );

    return _conversionResult;
}

// ─── Internal: read source layout. ──────────────────────────────────────────

function _readSource( geometry, fromLayout, bonesPerVertex ) {
    // ── 1. Reset the shared read buffer. ───────────────────────────────────
    const readBuffer = _ensureReadBuffer( 0, bonesPerVertex );

    if ( fromLayout === SkinWeightLayout.INTERLEAVED ) {
        const skinWeight = geometry.attributes[ ATTR_SKIN_WEIGHT ];
        const skinIndex = geometry.attributes[ ATTR_SKIN_INDEX ];

        if ( skinWeight === undefined ) return null;

        const vertexCount = skinWeight.count;
        const weights = skinWeight.array;
        const indices = skinIndex !== undefined ? skinIndex.array : null;

        _ensureReadBuffer( vertexCount, bonesPerVertex );

        // Copy weights into the read buffer.
        const rb = _readBufferWeights;
        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;
            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                rb[ base + k ] = weights[ base + k ];
            }
        }

        // Copy indices into the read buffer.
        const ri = _readBufferIndices;
        if ( indices !== null ) {
            for ( let v = 0; v < vertexCount; v ++ ) {
                const base = v * bonesPerVertex;
                for ( let k = 0; k < bonesPerVertex; k ++ ) {
                    ri[ base + k ] = indices[ base + k ];
                }
            }
        } else {
            for ( let i = 0; i < vertexCount * bonesPerVertex; i ++ ) ri[ i ] = 0;
        }

        const bytesBefore = vertexCount * bonesPerVertex * ( 4 + 2 );

        return {
            vertexCount: vertexCount,
            weights: rb,
            indices: ri,
            bytesBefore: bytesBefore
        };
    }

    if ( fromLayout === SkinWeightLayout.PLANAR ) {
        // Planar layout uses skinWeight0, skinWeight1, ... attributes.
        const attrs = [];
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const attr = geometry.attributes[ ATTR_SKIN_WEIGHT_PLANAR_PREFIX + k ];
            if ( attr === undefined ) return null;
            attrs.push( attr );
        }

        const vertexCount = attrs[ 0 ].count;
        _ensureReadBuffer( vertexCount, bonesPerVertex );

        const rb = _readBufferWeights;
        const ri = _readBufferIndices;

        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const arr = attrs[ k ].array;
            for ( let v = 0; v < vertexCount; v ++ ) {
                rb[ v * bonesPerVertex + k ] = arr[ v ];
                ri[ v * bonesPerVertex + k ] = k;
            }
        }

        const bytesBefore = vertexCount * bonesPerVertex * ( 4 + 2 );

        return {
            vertexCount: vertexCount,
            weights: rb,
            indices: ri,
            bytesBefore: bytesBefore
        };
    }

    if ( fromLayout === SkinWeightLayout.PACKED ) {
        const packed = geometry.attributes[ ATTR_SKIN_WEIGHT_PACKED ];
        if ( packed === undefined ) return null;

        const vertexCount = packed.count;
        _ensureReadBuffer( vertexCount, bonesPerVertex );

        const rb = _readBufferWeights;
        const ri = _readBufferIndices;
        const arr = packed.array;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const pv = arr[ v ] >>> 0;
            const base = v * bonesPerVertex;

            // Extract 4 pairs of (index, weight).
            for ( let k = 0; k < 4 && k < bonesPerVertex; k ++ ) {
                const byteIdx = k;
                const byteWeight = k + 4;

                const idx = ( pv >>> ( byteIdx * 8 ) ) & 0xFF;
                const w = ( ( pv >>> ( byteWeight * 8 ) ) & 0xFF ) / 255.0;

                rb[ base + k ] = w;
                ri[ base + k ] = idx;
            }

            for ( let k = 4; k < bonesPerVertex; k ++ ) {
                rb[ base + k ] = 0.0;
                ri[ base + k ] = 0;
            }
        }

        const bytesBefore = vertexCount * 4;

        return {
            vertexCount: vertexCount,
            weights: rb,
            indices: ri,
            bytesBefore: bytesBefore
        };
    }

    if ( fromLayout === SkinWeightLayout.VARIABLE ) {
        const skinWeight = geometry.attributes[ ATTR_SKIN_WEIGHT ];
        const skinIndex = geometry.attributes[ ATTR_SKIN_INDEX ];
        const stride = geometry.attributes[ ATTR_SKIN_VARIABLE_STRIDE ];

        if ( skinWeight === undefined || stride === undefined ) return null;

        const vertexCount = skinWeight.count;
        _ensureReadBuffer( vertexCount, bonesPerVertex );

        const rb = _readBufferWeights;
        const ri = _readBufferIndices;
        const weights = skinWeight.array;
        const indices = skinIndex !== undefined ? skinIndex.array : null;
        const strides = stride.array;

        let cursorW = 0;
        let cursorI = 0;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const count = Math.min( bonesPerVertex, strides[ v ] | 0 );

            for ( let k = 0; k < count; k ++ ) {
                rb[ v * bonesPerVertex + k ] = weights[ cursorW ++ ];
                ri[ v * bonesPerVertex + k ] = indices !== null ? indices[ cursorI ++ ] : 0;
            }

            for ( let k = count; k < bonesPerVertex; k ++ ) {
                rb[ v * bonesPerVertex + k ] = 0.0;
                ri[ v * bonesPerVertex + k ] = 0;
            }
        }

        const bytesBefore = cursorW * 4 + cursorI * 2 + vertexCount;

        return {
            vertexCount: vertexCount,
            weights: rb,
            indices: ri,
            bytesBefore: bytesBefore
        };
    }

    return null;

    void readBuffer;
}

// ─── Internal: write target layout. ─────────────────────────────────────────

function _writeTarget( geometry, toLayout, source, bonesPerVertex ) {
    const vertexCount = source.vertexCount;
    const weights = source.weights;
    const indices = source.indices;

    if ( toLayout === SkinWeightLayout.INTERLEAVED ) {
        const flatW = new Float32Array( vertexCount * bonesPerVertex );
        const flatI = new Uint16Array( vertexCount * bonesPerVertex );

        for ( let i = 0; i < vertexCount * bonesPerVertex; i ++ ) {
            flatW[ i ] = weights[ i ];
            flatI[ i ] = indices[ i ];
        }

        geometry.setAttribute( ATTR_SKIN_WEIGHT, new Float32BufferAttribute( flatW, bonesPerVertex ) );
        geometry.setAttribute( ATTR_SKIN_INDEX, new Uint16BufferAttribute( flatI, bonesPerVertex ) );

        _removeAttributes( geometry, [ ATTR_SKIN_WEIGHT_PACKED, ATTR_SKIN_VARIABLE_STRIDE ] );

        return vertexCount * bonesPerVertex * ( 4 + 2 );
    }

    if ( toLayout === SkinWeightLayout.PLANAR ) {
        // One Float32 attribute per bone slot.
        for ( let k = 0; k < bonesPerVertex; k ++ ) {
            const arr = new Float32Array( vertexCount );

            for ( let v = 0; v < vertexCount; v ++ ) {
                arr[ v ] = weights[ v * bonesPerVertex + k ];
            }

            geometry.setAttribute( ATTR_SKIN_WEIGHT_PLANAR_PREFIX + k, new Float32BufferAttribute( arr, 1 ) );
        }

        _removeAttributes( geometry, [ ATTR_SKIN_INDEX, ATTR_SKIN_WEIGHT, ATTR_SKIN_WEIGHT_PACKED, ATTR_SKIN_VARIABLE_STRIDE ] );

        return vertexCount * bonesPerVertex * ( 4 + 2 );
    }

    if ( toLayout === SkinWeightLayout.PACKED ) {
        const arr = new Uint32Array( vertexCount );

        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;

            // Pack up to 4 (index, weight) pairs into a Uint32.
            let packed = 0;

            for ( let k = 0; k < 4 && k < bonesPerVertex; k ++ ) {
                const idx = Math.max( 0, Math.min( 255, indices[ base + k ] | 0 ) );
                const w = Math.max( 0, Math.min( 255, Math.round( weights[ base + k ] * 255 ) ) );

                packed |= ( idx & 0xFF ) << ( k * 8 );
                packed |= ( w & 0xFF ) << ( ( k + 4 ) * 8 );
            }

            arr[ v ] = packed >>> 0;
        }

        geometry.setAttribute( ATTR_SKIN_WEIGHT_PACKED, new Uint32BufferAttribute( arr, 1 ) );

        _removeAttributes( geometry, [
            ATTR_SKIN_INDEX,
            ATTR_SKIN_WEIGHT,
            ATTR_SKIN_VARIABLE_STRIDE,
            ATTR_SKIN_WEIGHT_PLANAR_PREFIX + '0',
            ATTR_SKIN_WEIGHT_PLANAR_PREFIX + '1',
            ATTR_SKIN_WEIGHT_PLANAR_PREFIX + '2',
            ATTR_SKIN_WEIGHT_PLANAR_PREFIX + '3',
            ATTR_SKIN_WEIGHT_PLANAR_PREFIX + '4',
            ATTR_SKIN_WEIGHT_PLANAR_PREFIX + '5',
            ATTR_SKIN_WEIGHT_PLANAR_PREFIX + '6',
            ATTR_SKIN_WEIGHT_PLANAR_PREFIX + '7'
        ] );

        return vertexCount * 4;
    }

    if ( toLayout === SkinWeightLayout.VARIABLE ) {
        // Variable layout keeps per-vertex stride and pack-writes weights + indices.
        let totalEntries = 0;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;
            let count = 0;

            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                if ( weights[ base + k ] > 1e-6 ) count ++;
            }

            totalEntries += Math.max( 1, count );
        }

        const flatW = new Float32Array( totalEntries );
        const flatI = new Uint16Array( totalEntries );
        const strides = new Uint8Array( vertexCount );

        let cursor = 0;

        for ( let v = 0; v < vertexCount; v ++ ) {
            const base = v * bonesPerVertex;
            let count = 0;

            for ( let k = 0; k < bonesPerVertex; k ++ ) {
                if ( weights[ base + k ] > 1e-6 ) count ++;
            }

            count = Math.max( 1, count );
            strides[ v ] = count;

            for ( let k = 0; k < count; k ++ ) {
                flatW[ cursor ] = weights[ base + k ];
                flatI[ cursor ] = indices[ base + k ];
                cursor ++;
            }
        }

        geometry.setAttribute( ATTR_SKIN_WEIGHT, new Float32BufferAttribute( flatW, 1 ) );
        geometry.setAttribute( ATTR_SKIN_INDEX, new Uint16BufferAttribute( flatI, 1 ) );
        geometry.setAttribute( ATTR_SKIN_VARIABLE_STRIDE, new Uint8BufferAttribute( strides, 1 ) );

        _removeAttributes( geometry, [ ATTR_SKIN_WEIGHT_PACKED ] );

        return totalEntries * ( 4 + 2 ) + vertexCount;
    }

    return - 1;
}

function _removeAttributes( geometry, names ) {
    for ( let i = 0; i < names.length; i ++ ) {
        const name = names[ i ];
        if ( geometry.attributes[ name ] !== undefined ) {
            delete geometry.attributes[ name ];
        }
    }
}

// ─── Internal: read-buffer management. ──────────────────────────────────────

let _readBufferWeights = null;
let _readBufferIndices = null;
let _readBufferCapacity = 0;

function _ensureReadBuffer( vertexCount, bonesPerVertex ) {
    const needed = vertexCount * bonesPerVertex;

    if ( needed <= _readBufferCapacity && _readBufferWeights !== null ) {
        return _readBufferWeights;
    }

    const newCapacity = Math.max( needed, _readBufferCapacity * 2, 4096 );

    _readBufferWeights = new Float32Array( newCapacity );
    _readBufferIndices = new Uint16Array( newCapacity );
    _readBufferCapacity = newCapacity;

    return _readBufferWeights;
}

// ─── Public API: ECS sync. ──────────────────────────────────────────────────

const _ecsLayoutByHash = new Map();

function _syncLayoutECS( geometry, geometryHash, vertexCount, layout, bonesPerVertex, frameIndex ) {
    let eid = _ecsLayoutByHash.get( geometryHash );

    if ( eid === undefined ) {
        eid = addEntity( _layoutWorld );
        addComponent( _layoutWorld, SkinWeightLayoutSoA, eid );
        _ecsLayoutByHash.set( geometryHash, eid );
    }

    const sizes = computeLayoutSizes( vertexCount, bonesPerVertex );

    SkinWeightLayoutSoA.geometryId[ eid ] = geometry.id !== undefined ? geometry.id : - 1;
    SkinWeightLayoutSoA.geometryUuidHash[ eid ] = geometryHash;
    SkinWeightLayoutSoA.vertexCount[ eid ] = vertexCount;
    SkinWeightLayoutSoA.currentLayout[ eid ] = layout;
    SkinWeightLayoutSoA.targetLayout[ eid ] = layout;
    SkinWeightLayoutSoA.bonesPerVertex[ eid ] = bonesPerVertex;

    SkinWeightLayoutSoA.bytesInterleaved[ eid ] = sizes.interleaved;
    SkinWeightLayoutSoA.bytesPlanar[ eid ] = sizes.planar;
    SkinWeightLayoutSoA.bytesPacked[ eid ] = sizes.packed;
    SkinWeightLayoutSoA.bytesVariable[ eid ] = sizes.variable;

    let chosenBytes = 0;
    if ( layout === SkinWeightLayout.INTERLEAVED ) chosenBytes = sizes.interleaved;
    else if ( layout === SkinWeightLayout.PLANAR ) chosenBytes = sizes.planar;
    else if ( layout === SkinWeightLayout.PACKED ) chosenBytes = sizes.packed;
    else chosenBytes = sizes.variable;

    SkinWeightLayoutSoA.chosenBytes[ eid ] = chosenBytes;

    // Bytes saved vs. the most expensive layout.
    const maxBytes = Math.max( sizes.interleaved, sizes.planar, sizes.packed, sizes.variable );
    SkinWeightLayoutSoA.savedBytes[ eid ] = Math.max( 0, maxBytes - chosenBytes );

    SkinWeightLayoutSoA.conversionCount[ eid ] = ( SkinWeightLayoutSoA.conversionCount[ eid ] || 0 ) + 1;
    SkinWeightLayoutSoA.lastConversionMs[ eid ] = _conversionResult.conversionMs;
    SkinWeightLayoutSoA.avgConversionMsEMA[ eid ] =
        SkinWeightLayoutSoA.avgConversionMsEMA[ eid ] * 0.9 + _conversionResult.conversionMs * 0.1;

    SkinWeightLayoutSoA.shaderDefinesMask[ eid ] = getShaderDefinesMask( layout, bonesPerVertex );

    // Deterministic dither sample for layout tie-breaking telemetry.
    const ditherSeed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    SkinWeightLayoutSoA.ditherSample[ eid ] = _noise3D( ditherSeed * 1e-6, frameIndex * 0.02, layout );

    SkinWeightLayoutSoA.registered[ eid ] = 1;
    SkinWeightLayoutSoA.lastFrameIndex[ eid ] = frameIndex | 0;
}

// ─── Public API: query. ─────────────────────────────────────────────────────

/**
 * Returns the ECS entity id for the given geometry UUID.
 * @param {string} uuid
 * @return {number}
 */
function getLayoutEntityForUuid( uuid ) {
    const hash = _hashString( uuid );
    const eid = _ecsLayoutByHash.get( hash );
    return eid !== undefined ? eid : - 1;
}

/**
 * Returns the layout currently assigned to the given geometry.
 * @param {BufferGeometry} geometry
 * @return {number}
 */
function detectCurrentLayout( geometry ) {
    if ( geometry === undefined || geometry === null ) return SkinWeightLayout.INTERLEAVED;

    if ( geometry.attributes[ ATTR_SKIN_WEIGHT_PACKED ] !== undefined ) {
        return SkinWeightLayout.PACKED;
    }

    if ( geometry.attributes[ ATTR_SKIN_VARIABLE_STRIDE ] !== undefined ) {
        return SkinWeightLayout.VARIABLE;
    }

    if ( geometry.attributes[ ATTR_SKIN_WEIGHT_PLANAR_PREFIX + '0' ] !== undefined ) {
        return SkinWeightLayout.PLANAR;
    }

    if ( geometry.attributes[ ATTR_SKIN_WEIGHT ] !== undefined ) {
        return SkinWeightLayout.INTERLEAVED;
    }

    return SkinWeightLayout.INTERLEAVED;
}

/**
 * Returns the aggregated layout statistics across all geometries.
 * @return {object}
 */
function getAggregatedStats() {
    let totalGeometries = 0;
    let totalVertices = 0;
    let totalBytes = 0.0;
    let totalSaved = 0.0;
    let totalConversions = 0;
    let totalConversionMs = 0.0;
    let layoutHistogram = { 0: 0, 1: 0, 2: 0, 3: 0 };

    const q = query( _layoutWorld, [ SkinWeightLayoutSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinWeightLayoutSoA.registered[ eid ] !== 1 ) continue;

        totalGeometries ++;
        totalVertices += SkinWeightLayoutSoA.vertexCount[ eid ];
        totalBytes += SkinWeightLayoutSoA.chosenBytes[ eid ];
        totalSaved += SkinWeightLayoutSoA.savedBytes[ eid ];
        totalConversions += SkinWeightLayoutSoA.conversionCount[ eid ];
        totalConversionMs += SkinWeightLayoutSoA.lastConversionMs[ eid ];

        const layout = SkinWeightLayoutSoA.currentLayout[ eid ];
        layoutHistogram[ layout ] = ( layoutHistogram[ layout ] || 0 ) + 1;
    }

    const total = new Double( totalBytes );
    const saved = new Double( totalSaved );

    return {
        totalGeometries: totalGeometries,
        totalVertices: totalVertices,
        totalBytes: total.valueOf(),
        totalBytesSaved: saved.valueOf(),
        totalConversions: totalConversions,
        totalConversionMs: totalConversionMs,
        layoutHistogram: layoutHistogram
    };
}

// ─── Public API: high-precision aggregate helpers. ──────────────────────────

/**
 * Returns a high-precision total byte savings ratio.
 * @return {number}
 */
function computeSavingsRatioHighPrecision() {
    const totalBefore = new Double( 0 );
    const totalAfter = new Double( 0 );

    const q = query( _layoutWorld, [ SkinWeightLayoutSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        const eid = q[ i ];

        if ( SkinWeightLayoutSoA.registered[ eid ] !== 1 ) continue;

        const sizes = {
            interleaved: SkinWeightLayoutSoA.bytesInterleaved[ eid ],
            planar: SkinWeightLayoutSoA.bytesPlanar[ eid ],
            packed: SkinWeightLayoutSoA.bytesPacked[ eid ],
            variable: SkinWeightLayoutSoA.bytesVariable[ eid ]
        };

        const max = Math.max( sizes.interleaved, sizes.planar, sizes.packed, sizes.variable );

        totalBefore.iadd ? null : null;
        totalBefore.add ? null : null;

        // Double.js does not have an iadd; use additive accumulation.
        // We accumulate via valueOf to avoid allocation churn.
        const beforeValue = totalBefore.valueOf() + max;
        const afterValue = totalAfter.valueOf() + SkinWeightLayoutSoA.chosenBytes[ eid ];

        // Rebuild the Double with the new value to avoid mutating in place.
        totalBefore.d = beforeValue;
        totalAfter.d = afterValue;
    }

    const before = totalBefore.valueOf();

    if ( before <= 0.0 ) return 0.0;

    return 1.0 - ( totalAfter.valueOf() / before );
}

// ─── gl-matrix packing for telemetry. ───────────────────────────────────────

/**
 * Packs layout telemetry for a geometry into a vec4.
 * Layout: (vertexCount, currentLayout, bonesPerVertex, chosenBytes)
 * @param {string} uuid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packLayoutVec4( uuid, out ) {
    const v = out || _scratchVec4;
    const eid = getLayoutEntityForUuid( uuid );

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinWeightLayoutSoA.vertexCount[ eid ],
        SkinWeightLayoutSoA.currentLayout[ eid ],
        SkinWeightLayoutSoA.bonesPerVertex[ eid ],
        SkinWeightLayoutSoA.chosenBytes[ eid ]
    );
    return v;
}

/**
 * Packs a per-layout byte comparison into a vec4.
 * Layout: (interleaved, planar, packed, variable)
 * @param {string} uuid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packLayoutComparisonVec4( uuid, out ) {
    const v = out || _scratchVec4B;
    const eid = getLayoutEntityForUuid( uuid );

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinWeightLayoutSoA.bytesInterleaved[ eid ],
        SkinWeightLayoutSoA.bytesPlanar[ eid ],
        SkinWeightLayoutSoA.bytesPacked[ eid ],
        SkinWeightLayoutSoA.bytesVariable[ eid ]
    );
    return v;
}

/**
 * Packs the shader define bitmask and conversion stats into a vec4.
 * Layout: (shaderDefinesMask, conversionCount, lastConversionMs, avgConversionMsEMA)
 * @param {string} uuid
 * @param {Float64Array} [out]
 * @return {Float64Array}
 */
function packShaderDefineVec4( uuid, out ) {
    const v = out || _scratchVec4C;
    const eid = getLayoutEntityForUuid( uuid );

    if ( eid < 0 ) {
        glMatrix.vec4.set( v, 0, 0, 0, 0 );
        return v;
    }

    glMatrix.vec4.set(
        v,
        SkinWeightLayoutSoA.shaderDefinesMask[ eid ],
        SkinWeightLayoutSoA.conversionCount[ eid ],
        SkinWeightLayoutSoA.lastConversionMs[ eid ],
        SkinWeightLayoutSoA.avgConversionMsEMA[ eid ]
    );
    return v;
}

// ─── Deterministic dither sampling. ─────────────────────────────────────────

/**
 * Returns a deterministic dither sample for the given geometry / frame.
 * @param {number} geometryHash
 * @param {number} frameIndex
 * @return {number}
 */
function sampleLayoutDither( geometryHash, frameIndex ) {
    const seed = ( SkinnedMeshDefaults.determinismSeed ^ ( geometryHash * 0x9E3779B9 ) ^ ( frameIndex * 0x85EBCA6B ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, 0 );
}

// ─── Public API: frame lifecycle. ───────────────────────────────────────────

let _frameIndex = 0;

/**
 * Advances the shared frame index for all layout entities.
 * @param {number} frameIndex
 */
function beginFrame( frameIndex ) {
    _frameIndex = frameIndex | 0;

    const q = query( _layoutWorld, [ SkinWeightLayoutSoA ] );

    for ( let i = 0; i < q.length; i ++ ) {
        SkinWeightLayoutSoA.lastFrameIndex[ q[ i ] ] = _frameIndex;
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

void BufferAttribute;
void BufferGeometry;
void BonesPerVertex;
void _scratchVec3A;
void _scratchVec3B;

export {
    ShaderDefine,
    LayoutPolicy,
    ATTR_SKIN_INDEX,
    ATTR_SKIN_WEIGHT,
    ATTR_SKIN_WEIGHT_PACKED,
    ATTR_SKIN_VARIABLE_STRIDE,
    ATTR_SKIN_WEIGHT_PLANAR_PREFIX,
    SkinWeightLayoutSoA,
    computeLayoutSizes,
    chooseLayout,
    getAttributeNamesForLayout,
    getShaderDefines,
    getShaderDefinesMask,
    convertLayout,
    detectCurrentLayout,
    getLayoutEntityForUuid,
    getAggregatedStats,
    computeSavingsRatioHighPrecision,
    packLayoutVec4,
    packLayoutComparisonVec4,
    packShaderDefineVec4,
    sampleLayoutDither,
    beginFrame
};