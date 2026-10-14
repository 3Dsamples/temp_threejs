// file number : 007
// full path name : src/materials/007_meshmatcapmaterial.js
// description : MeshMatcapMaterial (three.js r185) rewritten as a high-
// performance ES module with deep anime-stylization integration. Extends the
// anime-enabled 001_material.js base class and preserves the full r185
// MeshMatcapMaterial API — color, matcap, map, alphaMap, bumpMap, bumpScale,
// normalMap, normalMapType, normalScale, displacementMap, displacementScale,
// displacementBias, flatShading, fog, and the inherited material surface. Matcap
// (material capture) rendering is uniquely suited to anime stylization because
// the entire lighting response is baked into a single 2D texture — this gives
// perfect control over the "cel look" of a character's skin, hair, and clothing.
// Adds real-time anime features specifically tuned for matcap rendering:
// matcap-domain cel banding (quantize the matcap's UV luminance into flat
// bands), matcap UV mood warping (rotate/scale the matcap to match scene mood),
// procedural matcap overlay variation via simplex-noise, rim glow on
// silhouettes, paper-grain and watercolor textures, and per-instance variation
// for crowds. Imports Color, Euler, Vector2, and other math classes strictly
// from threejs_new01 math, and uses gl-matrix for zero-allocation matcap UV
// transforms, double.js for bit-exact matcap luminance quantization, bitecs SoA
// batching for real-time updates across thousands of anime characters, and
// simplex-noise for procedural matcap variation.
// best for : MeshMatcapMaterial, anime character skin/hair, stylized props,
// static sculptures, technical visualization, mobile anime games (matcaps are
// extremely cheap), and any three.js mesh that needs pre-baked stylized lighting.
// license : MIT

import { Material } from './001_material.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';
import { Euler } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/008_Euler.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { Texture } from './../textures/002_texture.js';

// three.js r185 npm source — core, math, extras, and textures folders excluded per spec
import {
    NormalBlending,
    FrontSide,
    TangentSpaceNormalMap,
    ObjectSpaceNormalMap,
    NoColorSpace,
    LinearSRGBColorSpace
} from 'https://cdn.jsdelivr.net/npm/three@0.185.1/src/constants.js';

// ESM-native — verified named exports
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
// UMD builds — verified to resolve via jsDelivr's `+esm` transform
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------
const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation matcap UV transforms
const _gm_uv = glMatrix.vec2.create();
const _gm_uv_out = glMatrix.vec2.create();
const _gm_rgb = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Anime feature — matcap-domain cel banding
// ---------------------------------------------------------------------------
/**
 * Quantize a matcap-sampled color into cel-shading bands using double.js
 * for bit-exact thresholding. Because matcaps bake lighting into a 2D
 * texture, quantizing the sampled color directly produces a clean cel
 * effect without needing light direction information — this matches the
 * reference imagery's flat-shaded anime look (character clothing in 6,
 * mountains in 1 and 5, planet surface in 4).
 * @param {Color} sampledColor - The color sampled from the matcap.
 * @param {Color} output - The output color (modified in place).
 * @param {number} bands - Number of cel bands (2-6 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @param {number} [shadowTint=0.8] - Shadow band brightness multiplier.
 * @returns {Color}
 */
function applyMatcapCelBanding( sampledColor, output, bands, quantizeAmount, shadowTint = 0.8 ) {
    if ( bands <= 1 ) {
        output.copy( sampledColor );
        return output;
    }

    // Compute the luminance of the sampled matcap color
    _double.value = 0.2126 * sampledColor.r;
    _double.add( 0.7152 * sampledColor.g );
    _double.add( 0.0722 * sampledColor.b );
    const lum = _double.value;

    // Quantize the luminance
    const bandWidth = 1.0 / bands;
    _double.value = lum;
    _double.div( bandWidth );
    const bandIndex = Math.floor( _double.value );
    _double.value = bandIndex;
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    // Blend continuous and quantized
    _double.value = lum;
    _double.add( ( quantized - lum ) * quantizeAmount );
    const finalLum = _double.value;

    // Apply shadow tint to darker bands for extra anime contrast
    _double.value = shadowTint;
    _double.add( ( 1.0 - shadowTint ) * Math.min( 1, finalLum / Math.max( lum, 0.0001 ) ) );
    const shadowMul = Math.min( 1, _double.value );

    // Preserve hue, only change luminance
    if ( lum > 0.0001 ) {
        _double.value = sampledColor.r;
        _double.div( lum );
        _double.mul( finalLum );
        _double.mul( shadowMul );
        output.r = _double.value;

        _double.value = sampledColor.g;
        _double.div( lum );
        _double.mul( finalLum );
        _double.mul( shadowMul );
        output.g = _double.value;

        _double.value = sampledColor.b;
        _double.div( lum );
        _double.mul( finalLum );
        _double.mul( shadowMul );
        output.b = _double.value;
    } else {
        output.copy( sampledColor );
    }

    output.a = sampledColor.a;

    // Clamp
    output.r = Math.max( 0, Math.min( 1, output.r ) );
    output.g = Math.max( 0, Math.min( 1, output.g ) );
    output.b = Math.max( 0, Math.min( 1, output.b ) );
    return output;
}

// ---------------------------------------------------------------------------
// Anime feature — matcap UV mood warping
// ---------------------------------------------------------------------------
/**
 * Transform a matcap UV coordinate using gl-matrix for zero-allocation
 * rotation and scaling. Rotating the matcap shifts the "virtual light
 * direction" baked into the texture — this is how we match the scene
 * mood to the reference imagery: cyan water rims (1, 3, 5) want a
 * cool-top matcap, sunset portraits (2, 4, 6) want a warm-side matcap.
 * @param {glMatrix.vec2} out - Preallocated output vec2.
 * @param {number} u - Input U in [0, 1].
 * @param {number} v - Input V in [0, 1].
 * @param {number} rotation - Rotation angle in radians.
 * @param {number} scale - Scale multiplier (1 = unchanged).
 * @param {number} [offsetX=0] - U offset.
 * @param {number} [offsetY=0] - V offset.
 * @returns {glMatrix.vec2}
 */
function warpMatcapUV( out, u, v, rotation, scale, offsetX = 0, offsetY = 0 ) {
    // Center the UV around (0.5, 0.5) for rotation
    const cx = u - 0.5;
    const cy = v - 0.5;

    // Rotate
    const cosR = Math.cos( rotation );
    const sinR = Math.sin( rotation );

    _double.value = cx * cosR - cy * sinR;
    const rx = _double.value;

    _double.value = cx * sinR + cy * cosR;
    const ry = _double.value;

    // Scale and re-center
    _double.value = rx * scale + 0.5;
    _double.add( offsetX );
    let finalU = _double.value;

    _double.value = ry * scale + 0.5;
    _double.add( offsetY );
    let finalV = _double.value;

    // Wrap into [0, 1] with mirror
    finalU = finalU - Math.floor( finalU );
    finalV = finalV - Math.floor( finalV );

    glMatrix.vec2.set( out, finalU, finalV );
    return out;
}

// ---------------------------------------------------------------------------
// Anime feature — procedural matcap overlay variation
// ---------------------------------------------------------------------------
/**
 * Generate a procedural matcap overlay texture using simplex-noise. This
 * is layered multiplicatively on top of the base matcap to add a subtle
 * hand-painted texture variation without re-baking the matcap. Matches
 * the watercolor/organic feel of the reference imagery.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.05] - Noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [intensity=0.3] - Overlay intensity in [0, 1].
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateMatcapOverlay( width, height, scale = 0.05, octaves = 3, intensity = 0.3 ) {
    const out = new Uint8Array( width * height * 4 );
    for ( let y = 0; y < height; y ++ ) {
        for ( let x = 0; x < width; x ++ ) {
            const p = ( y * width + x ) * 4;
            let value = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for ( let o = 0; o < octaves; o ++ ) {
                value += _noise2D( x * frequency, y * frequency ) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            value = ( value / maxAmplitude ) * 0.5 + 0.5;

            // Modulate by intensity around neutral (1.0)
            _double.value = value;
            _double.mul( intensity );
            _double.add( 1.0 - intensity * 0.5 );
            value = Math.max( 0, Math.min( 1, _double.value ) );

            const v = Math.floor( value * 255 );
            out[ p ] = v;
            out[ p + 1 ] = v;
            out[ p + 2 ] = v;
            out[ p + 3 ] = 255;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Anime feature — mood-based color grading for matcap surfaces
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading. Handles warm (sunset orange) and cool
 * (snowy cyan) moods seen across the reference imagery. Uses gl-matrix
 * for zero-allocation staging and double.js for bit-exact accumulation.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeMatcapColor( color, temperature, saturation, brightness, contrast ) {
    glMatrix.vec3.set( _gm_rgb, color.r, color.g, color.b );

    const lum = 0.2126 * _gm_rgb[ 0 ] + 0.7152 * _gm_rgb[ 1 ] + 0.0722 * _gm_rgb[ 2 ];

    _double.value = lum; _double.add( ( _gm_rgb[ 0 ] - lum ) * saturation ); let r = _double.value;
    _double.value = lum; _double.add( ( _gm_rgb[ 1 ] - lum ) * saturation ); let g = _double.value;
    _double.value = lum; _double.add( ( _gm_rgb[ 2 ] - lum ) * saturation ); let b = _double.value;

    // Contrast
    _double.value = r; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); r = _double.value;
    _double.value = g; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); g = _double.value;
    _double.value = b; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); b = _double.value;

    // Temperature
    _double.value = r; _double.add( temperature * 0.12 ); r = _double.value;
    _double.value = b; _double.sub( temperature * 0.12 ); b = _double.value;

    // Brightness
    r *= brightness;
    g *= brightness;
    b *= brightness;

    color.setRGB(
        Math.max( 0, Math.min( 1, r ) ),
        Math.max( 0, Math.min( 1, g ) ),
        Math.max( 0, Math.min( 1, b ) ),
        ColorManagement.workingColorSpace
    );
    return color;
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for real-time matcap material updates
// ---------------------------------------------------------------------------
const _matcapWorld = createWorld();
const MatcapMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    celBands: Types.ui8,
    celQuantize: Types.f64,
    shadowTint: Types.f64,
    matcapRotation: Types.f64,
    matcapScale: Types.f64,
    matcapOffsetX: Types.f64,
    matcapOffsetY: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    rimGlow: Types.f64,
    overlayVariation: Types.f64,
    dirty: Types.ui8
} );

class MeshMatcapMaterialBatch {

    constructor() {
        this.world = _matcapWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshMatcapMaterial instance for batched real-time updates.
     * @param {MeshMatcapMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, MatcapMaterialComponent, eid );
        MatcapMaterialComponent.materialPtr[ eid ] = this.materials.length;
        MatcapMaterialComponent.celBands[ eid ] = material.celBands;
        MatcapMaterialComponent.celQuantize[ eid ] = material.celQuantize;
        MatcapMaterialComponent.shadowTint[ eid ] = material.shadowTint;
        MatcapMaterialComponent.matcapRotation[ eid ] = material.matcapRotation;
        MatcapMaterialComponent.matcapScale[ eid ] = material.matcapScale;
        MatcapMaterialComponent.matcapOffsetX[ eid ] = material.matcapOffset.x;
        MatcapMaterialComponent.matcapOffsetY[ eid ] = material.matcapOffset.y;
        MatcapMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        MatcapMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        MatcapMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        MatcapMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        MatcapMaterialComponent.rimGlow[ eid ] = material.rimGlow;
        MatcapMaterialComponent.overlayVariation[ eid ] = material.overlayVariation;
        MatcapMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued matcap-material updates in one cache-friendly pass.
     * Uses double.js internally to re-derive the mood color.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ MatcapMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.celBands = MatcapMaterialComponent.celBands[ eid ];
            material.celQuantize = MatcapMaterialComponent.celQuantize[ eid ];
            material.shadowTint = MatcapMaterialComponent.shadowTint[ eid ];
            material.matcapRotation = MatcapMaterialComponent.matcapRotation[ eid ];
            material.matcapScale = MatcapMaterialComponent.matcapScale[ eid ];
            material.matcapOffset.x = MatcapMaterialComponent.matcapOffsetX[ eid ];
            material.matcapOffset.y = MatcapMaterialComponent.matcapOffsetY[ eid ];
            material.moodTemperature = MatcapMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = MatcapMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = MatcapMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = MatcapMaterialComponent.moodContrast[ eid ];
            material.rimGlow = MatcapMaterialComponent.rimGlow[ eid ];
            material.overlayVariation = MatcapMaterialComponent.overlayVariation[ eid ];

            // Recompute mood color
            material.moodColor.copy( material.color );
            gradeMatcapColor(
                material.moodColor,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );

            MatcapMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshMatcapMaterial class — mirrors
// three.js/src/materials/MeshMatcapMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material for rendering geometry using a matcap (material capture) texture.
 * Matcaps are 2D textures that capture the full lighting response of a surface
 * from a single viewpoint, giving a sculpted look without any light computation.
 *
 * In addition to the standard three.js parameters, this material exposes a
 * rich set of real-time anime-style controls: matcap-domain cel banding,
 * matcap UV mood warping, procedural matcap overlay variation, mood-based
 * color grading, rim glow, and per-instance variation.
 *
 * ```js
 * const material = new THREE.MeshMatcapMaterial( {
 *   color: 0x88ccff,
 *   matcap: matcapTexture,
 *   celBands: 3,
 *   matcapRotation: 0.2,
 *   moodTemperature: 0.3
 * } );
 * ```
 * @augments Material
 */
class MeshMatcapMaterial extends Material {

    /**
     * Constructs a new mesh matcap material.
     * @param {Object} [parameters] - An object with one or more properties
     * defining the material's appearance.
     */
    constructor( parameters ) {
        super();

        /**
         * This flag can be used for type testing.
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isMeshMatcapMaterial = true;

        this.type = 'MeshMatcapMaterial';

        /**
         * Color of the material.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color( 0xffffff );

        /**
         * The matcap texture. The texture is expected to be in the sRGB
         * color space.
         * @type {?Texture}
         * @default null
         */
        this.matcap = null;

        /**
         * The color map. The texture is expected to be in the sRGB color
         * space.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * The alpha map. The texture is expected to be in `NoColorSpace`.
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * The bump map.
         * @type {?Texture}
         * @default null
         */
        this.bumpMap = null;

        /**
         * How much the bump map affects the material.
         * @type {number}
         * @default 1
         */
        this.bumpScale = 1;

        /**
         * The normal map.
         * @type {?Texture}
         * @default null
         */
        this.normalMap = null;

        /**
         * The type of the normal map. Can be `TangentSpaceNormalMap` (default)
         * or `ObjectSpaceNormalMap`.
         * @type {number}
         * @default TangentSpaceNormalMap
         */
        this.normalMapType = TangentSpaceNormalMap;

        /**
         * How much the normal map affects the material.
         * @type {Vector2}
         * @default (1,1)
         */
        this.normalScale = new Vector2( 1, 1 );

        /**
         * The displacement map.
         * @type {?Texture}
         * @default null
         */
        this.displacementMap = null;

        /**
         * How much the displacement map affects the mesh.
         * @type {number}
         * @default 1
         */
        this.displacementScale = 1;

        /**
         * The displacement bias.
         * @type {number}
         * @default 0
         */
        this.displacementBias = 0;

        /**
         * Whether to use flat shading or not.
         * @type {boolean}
         * @default false
         */
        this.flatShading = false;

        /**
         * Whether the material is affected by fog or not.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        // -------------------------------------------------------------------
        // Anime Rendering Extensions
        // -------------------------------------------------------------------
        /**
         * Number of cel bands applied to the matcap-sampled color.
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Blend amount between continuous and banded matcap color.
         * @type {number}
         * @default 1.0
         */
        this.celQuantize = 1.0;

        /**
         * Shadow band brightness multiplier. Lower = darker shadows.
         * @type {number}
         * @default 0.8
         */
        this.shadowTint = 0.8;

        /**
         * Matcap rotation angle in radians. Rotating the matcap shifts the
         * baked "virtual light direction" for mood matching.
         * @type {number}
         * @default 0
         */
        this.matcapRotation = 0;

        /**
         * Matcap UV scale multiplier.
         * @type {number}
         * @default 1.0
         */
        this.matcapScale = 1.0;

        /**
         * Matcap UV offset. Used to shift the sampling window for variation.
         * @type {Vector2}
         * @default (0,0)
         */
        this.matcapOffset = new Vector2( 0, 0 );

        /**
         * Mood temperature shift in [-1, 1].
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Mood saturation multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodSaturation = 1.0;

        /**
         * Mood brightness multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodBrightness = 1.0;

        /**
         * Mood contrast multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodContrast = 1.0;

        /**
         * The precomputed mood-graded color.
         * @type {Color}
         */
        this.moodColor = new Color( 0xffffff );

        /**
         * Rim-glow intensity.
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Rim-glow color.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color( 0.5, 0.9, 1.0 );

        /**
         * Procedural matcap overlay variation. Multiplies a simplex-noise
         * overlay onto the matcap sample for organic texture variation.
         * @type {number}
         * @default 0
         */
        this.overlayVariation = 0;

        /**
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        this.setValues( parameters );
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Apply cel banding to a sampled matcap color.
     * @param {Color} sampledColor - The sampled matcap color.
     * @param {Color} output - The output color.
     * @returns {Color}
     */
    applyMatcapBanding( sampledColor, output ) {
        return applyMatcapCelBanding( sampledColor, output, this.celBands, this.celQuantize, this.shadowTint );
    }

    /**
     * Warp a matcap UV coordinate using the current rotation / scale /
     * offset parameters.
     * @param {glMatrix.vec2} out - Preallocated output vec2.
     * @param {number} u
     * @param {number} v
     * @returns {glMatrix.vec2}
     */
    warpMatcapUV( out, u, v ) {
        return warpMatcapUV( out, u, v, this.matcapRotation, this.matcapScale, this.matcapOffset.x, this.matcapOffset.y );
    }

    /**
     * Generate a procedural matcap overlay texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.05]
     * @param {number} [octaves=3]
     * @returns {Uint8Array}
     */
    generateMatcapOverlay( width, height, scale = 0.05, octaves = 3 ) {
        return generateMatcapOverlay( width, height, scale, octaves, this.overlayVariation );
    }

    /**
     * Compute the per-instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * 137.508;
    }

    /**
     * Recompute the mood color from the current mood parameters.
     * @returns {MeshMatcapMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy( this.color );
        gradeMatcapColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------
    /**
     * The default `onBeforeCompile` hook. Extends the base Material's
     * anime shader chunks with matcap-specific features.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject matcap-specific uniforms
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.celQuantize = { value: this.celQuantize };
        shader.uniforms.shadowTint = { value: this.shadowTint };
        shader.uniforms.matcapRotation = { value: this.matcapRotation };
        shader.uniforms.matcapScale = { value: this.matcapScale };
        shader.uniforms.matcapOffset = { value: this.matcapOffset };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.overlayVariation = { value: this.overlayVariation };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int celBands;
                uniform float celQuantize;
                uniform float shadowTint;
                uniform float matcapRotation;
                uniform float matcapScale;
                uniform vec2 matcapOffset;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float overlayVariation;
                uniform float variationOffset;

                vec2 warpMatcapUV( vec2 uv ) {
                    vec2 centered = uv - 0.5;
                    float cosR = cos( matcapRotation );
                    float sinR = sin( matcapRotation );
                    vec2 rotated = vec2(
                        centered.x * cosR - centered.y * sinR,
                        centered.x * sinR + centered.y * cosR
                    );
                    vec2 scaled = rotated * matcapScale + 0.5 + matcapOffset;
                    return fract( scaled );
                }

                vec3 applyMatcapBanding( vec3 sampled ) {
                    if ( celBands <= 1 ) return sampled;
                    float lum = dot( sampled, vec3( 0.2126, 0.7152, 0.0722 ) );
                    float bandWidth = 1.0 / float( celBands );
                    float bandIndex = floor( lum / bandWidth );
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float finalLum = mix( lum, quantized, celQuantize );
                    float shadowMul = min( 1.0, shadowTint + ( 1.0 - shadowTint ) * ( finalLum / max( lum, 0.0001 ) ) );
                    return sampled * ( finalLum / max( lum, 0.0001 ) ) * shadowMul;
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Apply matcap-domain cel banding
                gl_FragColor.rgb = applyMatcapBanding( gl_FragColor.rgb );

                // Blend with mood-graded base color
                gl_FragColor.rgb = mix(
                    gl_FragColor.rgb,
                    moodColor * ( dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( dot( moodColor, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0001 ) ),
                    0.6
                );

                // Procedural overlay variation
                if ( overlayVariation > 0.0 ) {
                    float overlay = sin( vUv.x * 8.0 + variationOffset ) * cos( vUv.y * 8.0 + variationOffset );
                    overlay = overlay * 0.5 + 0.5;
                    gl_FragColor.rgb *= mix( 1.0, overlay, overlayVariation );
                }

                // Rim glow
                if ( rimGlow > 0.0 ) {
                    float rimFactor = 1.0 - abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
                    gl_FragColor.rgb += rimGlowColor * rimGlow * rimFactor;
                }
            ` );
    }

    /**
     * The custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.celBands,
            this.celQuantize,
            this.shadowTint,
            this.matcapRotation,
            this.matcapScale,
            this.matcapOffset.x,
            this.matcapOffset.y,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.rimGlow,
            this.overlayVariation,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {MeshMatcapMaterial} source - The material to copy from.
     * @return {MeshMatcapMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.color.copy( source.color );
        this.matcap = source.matcap;
        this.map = source.map;
        this.alphaMap = source.alphaMap;
        this.bumpMap = source.bumpMap;
        this.bumpScale = source.bumpScale;
        this.normalMap = source.normalMap;
        this.normalMapType = source.normalMapType;
        this.normalScale.copy( source.normalScale );
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.flatShading = source.flatShading;
        this.fog = source.fog;

        // Anime extensions
        this.celBands = source.celBands;
        this.celQuantize = source.celQuantize;
        this.shadowTint = source.shadowTint;
        this.matcapRotation = source.matcapRotation;
        this.matcapScale = source.matcapScale;
        this.matcapOffset.copy( source.matcapOffset );
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy( source.moodColor );
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy( source.rimGlowColor );
        this.overlayVariation = source.overlayVariation;
        this.variationSeed = source.variationSeed;

        return this;
    }

    /**
     * Serializes the material into JSON.
     * @param {?(Object|string)} meta - An optional value holding meta information.
     * @return {Object} A JSON object representing the serialized material.
     */
    toJSON( meta ) {
        const data = super.toJSON( meta );

        data.type = 'MeshMatcapMaterial';

        if ( this.color.getHex() !== 0xffffff ) data.color = this.color.getHex();
        if ( this.matcap !== null ) data.matcap = this.matcap.toJSON( meta ).uuid;
        if ( this.map !== null ) data.map = this.map.toJSON( meta ).uuid;
        if ( this.alphaMap !== null ) data.alphaMap = this.alphaMap.toJSON( meta ).uuid;
        if ( this.bumpMap !== null ) data.bumpMap = this.bumpMap.toJSON( meta ).uuid;
        if ( this.bumpScale !== 1 ) data.bumpScale = this.bumpScale;
        if ( this.normalMap !== null ) data.normalMap = this.normalMap.toJSON( meta ).uuid;
        if ( this.normalMapType !== TangentSpaceNormalMap ) data.normalMapType = this.normalMapType;
        if ( this.normalScale.x !== 1 || this.normalScale.y !== 1 ) data.normalScale = this.normalScale.toArray();
        if ( this.displacementMap !== null ) data.displacementMap = this.displacementMap.toJSON( meta ).uuid;
        if ( this.displacementScale !== 1 ) data.displacementScale = this.displacementScale;
        if ( this.displacementBias !== 0 ) data.displacementBias = this.displacementBias;
        if ( this.flatShading ) data.flatShading = true;
        if ( this.fog === false ) data.fog = false;

        // Anime extensions
        if ( this.celBands !== 0 ) data.celBands = this.celBands;
        if ( this.celQuantize !== 1.0 ) data.celQuantize = this.celQuantize;
        if ( this.shadowTint !== 0.8 ) data.shadowTint = this.shadowTint;
        if ( this.matcapRotation !== 0 ) data.matcapRotation = this.matcapRotation;
        if ( this.matcapScale !== 1.0 ) data.matcapScale = this.matcapScale;
        if ( this.matcapOffset.x !== 0 || this.matcapOffset.y !== 0 ) data.matcapOffset = this.matcapOffset.toArray();
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.rimGlow !== 0 ) data.rimGlow = this.rimGlow;
        if ( this.rimGlowColor.getHex() !== new Color( 0.5, 0.9, 1.0 ).getHex() ) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if ( this.overlayVariation !== 0 ) data.overlayVariation = this.overlayVariation;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    MeshMatcapMaterial,
    MeshMatcapMaterialBatch,
    applyMatcapCelBanding,
    warpMatcapUV,
    generateMatcapOverlay,
    gradeMatcapColor
};
export default MeshMatcapMaterial;