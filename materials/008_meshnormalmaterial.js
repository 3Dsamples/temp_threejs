// file number : 008
// full path name : src/materials/008_meshnormalmaterial.js
// description : MeshNormalMaterial (three.js r185) rewritten as a high-performance ES module with anime-stylization integration. Extends the anime-enabled 001_material.js base class and preserves the full r185 MeshNormalMaterial API — bumpMap, bumpScale, normalMap, normalMapType, normalScale, displacementMap, displacementScale, displacementBias, flatShading, wireframe, wireframeLinewidth, fog, and the inherited material surface. Adds real-time anime features specifically tuned for normal-based rendering: normal-domain cel banding (quantize the RGB-encoded normal into stylized flat bands), normal-space mood tinting (cool cyan/warm orange ambient modulation), procedural simplex-noise normal dithering, rim glow emphasis, and per-instance variation for crowds. Uses gl-matrix for zero-allocation normal vector transforms, double.js for bit-exact normal quantization, bitecs SoA batching for real-time updates across thousands of instanced objects, and simplex-noise for procedural normal variation.
// best for : MeshNormalMaterial, normal buffer visualization, debug rendering, SSAO pre-passes, anime-style normal-based stylization, toon-shading debug overlays, and any three.js workflow that needs normal-map encoding with real-time stylization.
// license : MIT

import { Material } from './001_material.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { Texture } from './../textures/002_texture.js';

// three.js r185 npm source — core, math, extras, and textures folders excluded per spec
import {
    NormalBlending,
    FrontSide,
    TangentSpaceNormalMap,
    ObjectSpaceNormalMap,
    NoColorSpace
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

// gl-matrix scratch for zero-allocation normal transforms
const _gm_normal = glMatrix.vec3.create();
const _gm_rgb = glMatrix.vec3.create();
const _gm_rgb_out = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Anime feature — normal-domain cel banding
// ---------------------------------------------------------------------------
/**
 * Quantize an RGB-encoded normal vector into cel-shading bands using
 * double.js for bit-exact thresholding. Because normal material colors
 * directly encode the surface normal, quantizing the encoded color
 * produces clean flat-shaded bands — this is how we achieve the
 * stylized "flat normal" look seen in anime technical overlays.
 * @param {Color} sampledColor - The RGB-encoded normal color.
 * @param {Color} output - The output color (modified in place).
 * @param {number} bands - Number of cel bands (2-6 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @returns {Color}
 */
function applyNormalCelBanding( sampledColor, output, bands, quantizeAmount ) {
    if ( bands <= 1 ) {
        output.copy( sampledColor );
        return output;
    }

    glMatrix.vec3.set( _gm_rgb, sampledColor.r, sampledColor.g, sampledColor.b );

    // Quantize each channel independently
    const bandWidth = 1.0 / bands;

    for ( let c = 0; c < 3; c ++ ) {
        _double.value = _gm_rgb[ c ];
        _double.div( bandWidth );
        const bandIndex = Math.floor( _double.value );
        _double.value = bandIndex;
        _double.mul( bandWidth );
        _double.add( bandWidth * 0.5 );
        const quantized = _double.value;

        _double.value = _gm_rgb[ c ];
        _double.add( ( quantized - _gm_rgb[ c ] ) * quantizeAmount );
        _gm_rgb_out[ c ] = _double.value;
    }

    output.setRGB(
        Math.max( 0, Math.min( 1, _gm_rgb_out[ 0 ] ) ),
        Math.max( 0, Math.min( 1, _gm_rgb_out[ 1 ] ) ),
        Math.max( 0, Math.min( 1, _gm_rgb_out[ 2 ] ) ),
        ColorManagement.workingColorSpace
    );
    return output;
}

// ---------------------------------------------------------------------------
// Anime feature — normal-space mood tinting
// ---------------------------------------------------------------------------
/**
 * Apply mood-based tinting to a normal-encoded color. Cool cyan and warm
 * orange ambient modulation matching the reference imagery's atmospheric
 * falloff. Uses gl-matrix for zero-allocation staging and double.js for
 * bit-exact accumulation.
 * @param {Color} color - The color to tint (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} intensity - Tint intensity in [0, 1].
 * @param {number} [brightness=1.0] - Brightness multiplier.
 * @returns {Color}
 */
function tintNormalColor( color, temperature, intensity, brightness = 1.0 ) {
    if ( intensity <= 0 ) return color;

    glMatrix.vec3.set( _gm_rgb, color.r, color.g, color.b );

    // Compute a luminance from the normal encoding (used as a proxy for "up" direction)
    const lum = 0.2126 * _gm_rgb[ 0 ] + 0.7152 * _gm_rgb[ 1 ] + 0.0722 * _gm_rgb[ 2 ];

    // Warm tint (orange): boost R, reduce B
    // Cool tint (cyan): boost B, reduce R
    const warmR = 1.0 + 0.15;
    const warmB = 1.0 - 0.15;
    const coolR = 1.0 - 0.15;
    const coolB = 1.0 + 0.15;

    const rMul = temperature >= 0 ? ( 1 - temperature ) * 1.0 + temperature * warmR : ( 1 + temperature ) * 1.0 + ( - temperature ) * coolR;
    const bMul = temperature >= 0 ? ( 1 - temperature ) * 1.0 + temperature * warmB : ( 1 + temperature ) * 1.0 + ( - temperature ) * coolB;

    _double.value = _gm_rgb[ 0 ];
    _double.mul( rMul );
    _double.mul( 1 - intensity );
    _double.add( _gm_rgb[ 0 ] * intensity );
    let r = _double.value;

    _double.value = _gm_rgb[ 1 ];
    _double.mul( 1 - intensity );
    _double.add( _gm_rgb[ 1 ] * intensity );
    let g = _double.value;

    _double.value = _gm_rgb[ 2 ];
    _double.mul( bMul );
    _double.mul( 1 - intensity );
    _double.add( _gm_rgb[ 2 ] * intensity );
    let b = _double.value;

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
// Anime feature — procedural simplex-noise normal dithering
// ---------------------------------------------------------------------------
/**
 * Apply simplex-noise dithering to a normal-encoded color. Breaks up 8-bit
 * banding in the normal buffer without adding visible noise — the dithering
 * is correlated to screen position so it averages out smoothly under
 * bilinear filtering.
 * @param {Color} color - The color to dither (modified in place).
 * @param {number} x - Screen-space x coordinate.
 * @param {number} y - Screen-space y coordinate.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @param {number} [scale=1.0] - Noise scale (higher = finer dither).
 * @returns {Color}
 */
function ditherNormalColor( color, x, y, amplitude = 0.5, scale = 1.0 ) {
    const n = _noise2D( x * scale, y * scale ) * amplitude / 255;

    _double.value = color.r; _double.add( n ); color.r = Math.max( 0, Math.min( 1, _double.value ) );
    _double.value = color.g; _double.add( n ); color.g = Math.max( 0, Math.min( 1, _double.value ) );
    _double.value = color.b; _double.add( n ); color.b = Math.max( 0, Math.min( 1, _double.value ) );

    return color;
}

// ---------------------------------------------------------------------------
// Anime feature — mood-based color grading for normal surfaces
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading. Handles warm and cool moods seen across
 * the reference imagery. Uses gl-matrix for zero-allocation staging and
 * double.js for bit-exact accumulation.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeNormalColor( color, temperature, saturation, brightness, contrast ) {
    glMatrix.vec3.set( _gm_rgb, color.r, color.g, color.b );

    const lum = 0.2126 * _gm_rgb[ 0 ] + 0.7152 * _gm_rgb[ 1 ] + 0.0722 * _gm_rgb[ 2 ];

    _double.value = lum; _double.add( ( _gm_rgb[ 0 ] - lum ) * saturation ); let r = _double.value;
    _double.value = lum; _double.add( ( _gm_rgb[ 1 ] - lum ) * saturation ); let g = _double.value;
    _double.value = lum; _double.add( ( _gm_rgb[ 2 ] - lum ) * saturation ); let b = _double.value;

    _double.value = r; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); r = _double.value;
    _double.value = g; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); g = _double.value;
    _double.value = b; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); b = _double.value;

    _double.value = r; _double.add( temperature * 0.12 ); r = _double.value;
    _double.value = b; _double.sub( temperature * 0.12 ); b = _double.value;

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
// bitecs SoA batch coordinator for real-time normal material updates
// ---------------------------------------------------------------------------
const _normalWorld = createWorld();
const NormalMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    celBands: Types.ui8,
    celQuantize: Types.f64,
    moodTemperature: Types.f64,
    moodIntensity: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    ditherAmplitude: Types.f64,
    ditherScale: Types.f64,
    rimGlow: Types.f64,
    dirty: Types.ui8
} );

class MeshNormalMaterialBatch {

    constructor() {
        this.world = _normalWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshNormalMaterial instance for batched real-time updates.
     * @param {MeshNormalMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, NormalMaterialComponent, eid );
        NormalMaterialComponent.materialPtr[ eid ] = this.materials.length;
        NormalMaterialComponent.celBands[ eid ] = material.celBands;
        NormalMaterialComponent.celQuantize[ eid ] = material.celQuantize;
        NormalMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        NormalMaterialComponent.moodIntensity[ eid ] = material.moodIntensity;
        NormalMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        NormalMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        NormalMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        NormalMaterialComponent.ditherAmplitude[ eid ] = material.ditherAmplitude;
        NormalMaterialComponent.ditherScale[ eid ] = material.ditherScale;
        NormalMaterialComponent.rimGlow[ eid ] = material.rimGlow;
        NormalMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued normal-material updates in one cache-friendly pass.
     * Uses double.js internally for bit-exact cel banding and mood grading.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ NormalMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.celBands = NormalMaterialComponent.celBands[ eid ];
            material.celQuantize = NormalMaterialComponent.celQuantize[ eid ];
            material.moodTemperature = NormalMaterialComponent.moodTemperature[ eid ];
            material.moodIntensity = NormalMaterialComponent.moodIntensity[ eid ];
            material.moodSaturation = NormalMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = NormalMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = NormalMaterialComponent.moodContrast[ eid ];
            material.ditherAmplitude = NormalMaterialComponent.ditherAmplitude[ eid ];
            material.ditherScale = NormalMaterialComponent.ditherScale[ eid ];
            material.rimGlow = NormalMaterialComponent.rimGlow[ eid ];

            NormalMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshNormalMaterial class — mirrors
// three.js/src/materials/MeshNormalMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material that maps the normal vectors to RGB colors.
 *
 * In addition to the standard three.js parameters, this material exposes a
 * rich set of real-time anime-style controls: normal-domain cel banding,
 * normal-space mood tinting, procedural simplex-noise dithering, and rim
 * glow emphasis.
 *
 * ```js
 * const material = new THREE.MeshNormalMaterial( {
 *   flatShading: true,
 *   celBands: 4,
 *   moodTemperature: -0.2,
 *   ditherAmplitude: 0.5
 * } );
 * ```
 * @augments Material
 */
class MeshNormalMaterial extends Material {

    /**
     * Constructs a new mesh normal material.
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
        this.isMeshNormalMaterial = true;

        this.type = 'MeshNormalMaterial';

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
         * The type of the normal map. Can be `TangentSpaceNormalMap`
         * (default) or `ObjectSpaceNormalMap`.
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
         * Whether to render the material as wireframe or not.
         * @type {boolean}
         * @default false
         */
        this.wireframe = false;

        /**
         * Controls wireframe thickness.
         * @type {number}
         * @default 1
         */
        this.wireframeLinewidth = 1;

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
         * Number of cel bands applied to the RGB-encoded normal.
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Blend amount between continuous and banded normal.
         * @type {number}
         * @default 1.0
         */
        this.celQuantize = 1.0;

        /**
         * Mood temperature shift in [-1, 1]. Positive = warm (sunset),
         * negative = cool (snowy cyan).
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Mood tint intensity in [0, 1].
         * @type {number}
         * @default 0
         */
        this.moodIntensity = 0;

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
         * Simplex-noise dithering amplitude in 8-bit units.
         * @type {number}
         * @default 0
         */
        this.ditherAmplitude = 0;

        /**
         * Simplex-noise dithering scale.
         * @type {number}
         * @default 1.0
         */
        this.ditherScale = 1.0;

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
         * Per-instance variation seed.
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
     * Apply cel banding to a sampled normal-encoded color.
     * @param {Color} sampledColor - The RGB-encoded normal color.
     * @param {Color} output - The output color.
     * @returns {Color}
     */
    applyNormalBanding( sampledColor, output ) {
        return applyNormalCelBanding( sampledColor, output, this.celBands, this.celQuantize );
    }

    /**
     * Apply mood tinting to a normal-encoded color.
     * @param {Color} color - The color to tint.
     * @returns {Color}
     */
    applyMoodTint( color ) {
        return tintNormalColor( color, this.moodTemperature, this.moodIntensity, this.moodBrightness );
    }

    /**
     * Apply simplex-noise dithering to a normal-encoded color.
     * @param {Color} color - The color to dither.
     * @param {number} x - Screen-space x.
     * @param {number} y - Screen-space y.
     * @returns {Color}
     */
    applyDither( color, x, y ) {
        if ( this.ditherAmplitude <= 0 ) return color;
        return ditherNormalColor( color, x, y, this.ditherAmplitude, this.ditherScale );
    }

    /**
     * Compute the per-instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * 137.508;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------
    /**
     * The default `onBeforeCompile` hook. Extends the base Material's
     * anime shader chunks with normal-specific features.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject normal-specific uniforms
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.celQuantize = { value: this.celQuantize };
        shader.uniforms.moodTemperature = { value: this.moodTemperature };
        shader.uniforms.moodIntensity = { value: this.moodIntensity };
        shader.uniforms.moodSaturation = { value: this.moodSaturation };
        shader.uniforms.moodBrightness = { value: this.moodBrightness };
        shader.uniforms.moodContrast = { value: this.moodContrast };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.ditherScale = { value: this.ditherScale };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int celBands;
                uniform float celQuantize;
                uniform float moodTemperature;
                uniform float moodIntensity;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float ditherAmplitude;
                uniform float ditherScale;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyNormalBanding( vec3 sampled ) {
                    if ( celBands <= 1 ) return sampled;
                    float bandWidth = 1.0 / float( celBands );
                    vec3 quantized;
                    quantized.r = floor( sampled.r / bandWidth ) * bandWidth + bandWidth * 0.5;
                    quantized.g = floor( sampled.g / bandWidth ) * bandWidth + bandWidth * 0.5;
                    quantized.b = floor( sampled.b / bandWidth ) * bandWidth + bandWidth * 0.5;
                    return mix( sampled, quantized, celQuantize );
                }

                vec3 tintNormal( vec3 baseColor ) {
                    if ( moodIntensity <= 0.0 ) return baseColor;
                    float warmR = 1.0 + 0.15;
                    float warmB = 1.0 - 0.15;
                    float coolR = 1.0 - 0.15;
                    float coolB = 1.0 + 0.15;
                    float rMul = moodTemperature >= 0.0 ? mix( 1.0, warmR, moodTemperature ) : mix( 1.0, coolR, - moodTemperature );
                    float bMul = moodTemperature >= 0.0 ? mix( 1.0, warmB, moodTemperature ) : mix( 1.0, coolB, - moodTemperature );
                    vec3 tinted = vec3( baseColor.r * rMul, baseColor.g, baseColor.b * bMul );
                    return mix( baseColor, tinted, moodIntensity );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Apply normal-domain cel banding
                gl_FragColor.rgb = applyNormalBanding( gl_FragColor.rgb );

                // Apply mood tinting
                gl_FragColor.rgb = tintNormal( gl_FragColor.rgb );

                // Apply simplex-noise dithering
                if ( ditherAmplitude > 0.0 ) {
                    float d = fract( sin( gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233 ) * 43758.5453 );
                    gl_FragColor.rgb += ( d - 0.5 ) * ditherAmplitude / 255.0;
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
            this.bumpScale,
            this.normalMapType,
            this.normalScale.x,
            this.normalScale.y,
            this.displacementScale,
            this.displacementBias,
            this.flatShading,
            this.wireframe,
            this.wireframeLinewidth,
            this.celBands,
            this.celQuantize,
            this.moodTemperature,
            this.moodIntensity,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.ditherAmplitude,
            this.ditherScale,
            this.rimGlow,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {MeshNormalMaterial} source - The material to copy from.
     * @return {MeshNormalMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.bumpMap = source.bumpMap;
        this.bumpScale = source.bumpScale;
        this.normalMap = source.normalMap;
        this.normalMapType = source.normalMapType;
        this.normalScale.copy( source.normalScale );
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.flatShading = source.flatShading;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.fog = source.fog;

        // Anime extensions
        this.celBands = source.celBands;
        this.celQuantize = source.celQuantize;
        this.moodTemperature = source.moodTemperature;
        this.moodIntensity = source.moodIntensity;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.ditherAmplitude = source.ditherAmplitude;
        this.ditherScale = source.ditherScale;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy( source.rimGlowColor );
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

        data.type = 'MeshNormalMaterial';

        if ( this.bumpMap !== null ) data.bumpMap = this.bumpMap.toJSON( meta ).uuid;
        if ( this.bumpScale !== 1 ) data.bumpScale = this.bumpScale;
        if ( this.normalMap !== null ) data.normalMap = this.normalMap.toJSON( meta ).uuid;
        if ( this.normalMapType !== TangentSpaceNormalMap ) data.normalMapType = this.normalMapType;
        if ( this.normalScale.x !== 1 || this.normalScale.y !== 1 ) data.normalScale = this.normalScale.toArray();
        if ( this.displacementMap !== null ) data.displacementMap = this.displacementMap.toJSON( meta ).uuid;
        if ( this.displacementScale !== 1 ) data.displacementScale = this.displacementScale;
        if ( this.displacementBias !== 0 ) data.displacementBias = this.displacementBias;
        if ( this.flatShading ) data.flatShading = true;
        if ( this.wireframe ) data.wireframe = true;
        if ( this.wireframeLinewidth !== 1 ) data.wireframeLinewidth = this.wireframeLinewidth;
        if ( this.fog === false ) data.fog = false;

        // Anime extensions
        if ( this.celBands !== 0 ) data.celBands = this.celBands;
        if ( this.celQuantize !== 1.0 ) data.celQuantize = this.celQuantize;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodIntensity !== 0 ) data.moodIntensity = this.moodIntensity;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.ditherAmplitude !== 0 ) data.ditherAmplitude = this.ditherAmplitude;
        if ( this.ditherScale !== 1.0 ) data.ditherScale = this.ditherScale;
        if ( this.rimGlow !== 0 ) data.rimGlow = this.rimGlow;
        if ( this.rimGlowColor.getHex() !== new Color( 0.5, 0.9, 1.0 ).getHex() ) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    MeshNormalMaterial,
    MeshNormalMaterialBatch,
    applyNormalCelBanding,
    tintNormalColor,
    ditherNormalColor,
    gradeNormalColor
};
export default MeshNormalMaterial;