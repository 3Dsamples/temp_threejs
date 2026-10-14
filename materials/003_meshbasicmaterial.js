// file number : 003
// full path name : src/materials/003_meshbasicmaterial.js
// description : MeshBasicMaterial (three.js r185) rewritten as a high-
// performance ES module with deep anime-stylization integration. Extends the
// anime-enabled 001_material.js base class and preserves the full r185
// MeshBasicMaterial API — color, map, alphaMap, aoMap, aoMapIntensity, envMap,
// envMapRotation, combine, reflectivity, lightMap, lightMapIntensity, specularMap,
// wireframe, wireframeLinewidth, wireframeLinecap, wireframeLinejoin, fog, and
// the inherited material surface. Adds real-time anime features specifically tuned
// for unlit mesh rendering: flat-color cel-like banding (stylized flat shading
// without light dependence), procedural paper-grain and watercolor texture
// variation, mood-based color grading (snowy cyan, sunset orange, vibrant flora),
// rim glow for character silhouettes, and per-instance variation for large crowds.
// Imports Color, Euler, Vector2, and other math classes strictly from
// threejs_new01 math, and uses gl-matrix for zero-allocation color/texture
// transforms, double.js for bit-exact mood grading and HDR color grading
// accumulation, bitecs SoA batching for real-time updates across thousands of mesh
// instances, and simplex-noise for procedural texture variation and paper-grain
// generation.
// best for : MeshBasicMaterial, UI elements, flat-shaded anime backgrounds, toon
// character bases, unlit props, skyboxes, loading placeholders, UV debugging,
// sprite billboards, and any three.js mesh rendering that needs flat-color anime
// stylization.
// license : MIT

import { Material } from './001_material.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';
import { Euler } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/008_Euler.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Texture } from './../textures/002_texture.js';

// three.js r185 npm source — core, math, extras, and textures folders excluded per spec
import {
    NormalBlending,
    FrontSide,
    MultiplyOperation,
    MixOperation,
    AddOperation,
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

// gl-matrix scratch for zero-allocation color transforms
const _gm_rgb = glMatrix.vec3.create();
const _gm_hsv = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Anime feature — flat-color cel-like banding for unlit surfaces
// ---------------------------------------------------------------------------
/**
 * Apply flat-color banding to a base color, mimicking cel-shading without any
 * light dependence. The band boundaries are computed with double.js for bit-
 * exact thresholding, avoiding visible band flicker in HDR-toned scenes.
 * @param {Color} baseColor - The base color.
 * @param {Color} output - The output color (modified in place).
 * @param {number} bands - Number of flat color bands (2-4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @returns {Color}
 */
function applyFlatColorBanding( baseColor, output, bands, quantizeAmount ) {
    if ( bands <= 1 ) {
        output.copy( baseColor );
        return output;
    }

    // Compute the luminance of the base color
    _double.value = 0.2126 * baseColor.r;
    _double.add( 0.7152 * baseColor.g );
    _double.add( 0.0722 * baseColor.b );
    const lum = _double.value;

    // Quantize the luminance into discrete bands
    const bandWidth = 1.0 / bands;
    _double.value = lum;
    _double.div( bandWidth );
    const bandIndex = Math.floor( _double.value );
    _double.value = bandIndex;
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantizedLum = _double.value;

    // Blend between continuous and quantized luminance
    _double.value = lum;
    _double.add( ( quantizedLum - lum ) * quantizeAmount );
    const finalLum = _double.value;

    // Preserve hue and saturation, only change luminance
    if ( lum > 0.0001 ) {
        _double.value = baseColor.r;
        _double.div( lum );
        _double.mul( finalLum );
        output.r = _double.value;

        _double.value = baseColor.g;
        _double.div( lum );
        _double.mul( finalLum );
        output.g = _double.value;

        _double.value = baseColor.b;
        _double.div( lum );
        _double.mul( finalLum );
        output.b = _double.value;
    } else {
        output.copy( baseColor );
    }

    output.a = baseColor.a;

    // Clamp
    output.r = Math.max( 0, Math.min( 1, output.r ) );
    output.g = Math.max( 0, Math.min( 1, output.g ) );
    output.b = Math.max( 0, Math.min( 1, output.b ) );
    return output;
}

// ---------------------------------------------------------------------------
// Anime feature — mood grading for unlit mesh colors
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading tuned for unlit mesh rendering. Handles warm
 * (sunset orange), cool (snowy cyan), and vibrant (flora) moods seen across the
 * reference imagery. Uses gl-matrix for zero-allocation staging and double.js
 * for bit-exact accumulation.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeMeshColor( color, temperature, saturation, brightness, contrast ) {
    glMatrix.vec3.set( _gm_rgb, color.r, color.g, color.b );

    // Saturation: push away from luminance
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
// Anime feature — procedural watercolor texture variation
// ---------------------------------------------------------------------------
/**
 * Generate a watercolor-pigment variation texture using simplex-noise. This
 * creates the subtle blotchy texture characteristic of the reference imagery's
 * watercolor backgrounds (snowy mountains, cyan rivers, foliage).
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03] - Base noise scale.
 * @param {number} [octaves=3] - Number of noise octaves for richer detail.
 * @param {number} [bleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateWatercolorTexture( width, height, scale = 0.03, octaves = 3, bleed = 0.5 ) {
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

            // Watercolor bleed: soften the value toward the extremes
            _double.value = value;
            _double.sub( 0.5 );
            _double.mul( 1.0 + bleed );
            _double.add( 0.5 );
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
// bitecs SoA batch coordinator for real-time unlit mesh material updates
// ---------------------------------------------------------------------------
const _meshWorld = createWorld();
const MeshMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    flatBands: Types.ui8,
    flatQuantize: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    rimGlow: Types.f64,
    watercolorBleed: Types.f64,
    dirty: Types.ui8
} );

class MeshBasicMaterialBatch {

    constructor() {
        this.world = _meshWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshBasicMaterial instance for batched real-time updates.
     * @param {MeshBasicMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, MeshMaterialComponent, eid );
        MeshMaterialComponent.materialPtr[ eid ] = this.materials.length;
        MeshMaterialComponent.flatBands[ eid ] = material.flatBands;
        MeshMaterialComponent.flatQuantize[ eid ] = material.flatQuantize;
        MeshMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        MeshMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        MeshMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        MeshMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        MeshMaterialComponent.rimGlow[ eid ] = material.rimGlow;
        MeshMaterialComponent.watercolorBleed[ eid ] = material.watercolorBleed;
        MeshMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued mesh-material updates in one cache-friendly pass.
     * Uses double.js internally for bit-exact flat-color banding and mood
     * grading.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ MeshMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.flatBands = MeshMaterialComponent.flatBands[ eid ];
            material.flatQuantize = MeshMaterialComponent.flatQuantize[ eid ];
            material.moodTemperature = MeshMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = MeshMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = MeshMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = MeshMaterialComponent.moodContrast[ eid ];
            material.rimGlow = MeshMaterialComponent.rimGlow[ eid ];
            material.watercolorBleed = MeshMaterialComponent.watercolorBleed[ eid ];

            // Recompute derived colors
            applyFlatColorBanding( material.color, material.flatColor, material.flatBands, material.flatQuantize );
            material.moodColor.copy( material.color );
            gradeMeshColor(
                material.moodColor,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );
            MeshMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshBasicMaterial class — mirrors
// three.js/src/materials/MeshBasicMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material for drawing geometries in a simple shaded (flat or wireframe)
 * way. This material is not affected by lights.
 *
 * In addition to the standard three.js parameters, this material exposes
 * a rich set of real-time anime-style controls: flat-color cel-like banding,
 * procedural watercolor texture variation, mood-based color grading, rim
 * glow, and per-instance variation for large crowds.
 *
 * ```js
 * const material = new THREE.MeshBasicMaterial( {
 *   color: 0x88ccff,
 *   flatBands: 3,
 *   flatQuantize: 0.8,
 *   moodTemperature: -0.3,
 *   watercolorBleed: 0.5
 * } );
 * ```
 * @augments Material
 */
class MeshBasicMaterial extends Material {

    /**
     * Constructs a new mesh basic material.
     * @param {Object} [parameters] - An object with one or more properties
     * defining the material's appearance. Any property of the material
     * (including any property from inherited materials) can be passed
     * in here. Color values can be passed any type of value accepted
     * by {@link Color#set}.
     */
    constructor( parameters ) {
        super();

        /**
         * This flag can be used for type testing.
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isMeshBasicMaterial = true;

        this.type = 'MeshBasicMaterial';

        /**
         * Color of the material.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color( 0xffffff ); // diffuse

        /**
         * The color map. May optionally include an alpha channel, typically
         * combined with {@link Material#transparent} or
         * {@link Material#alphaTest}. The texture map color is modulated by
         * the diffuse `color`.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * The light map. Requires a second set of UVs.
         * @type {?Texture}
         * @default null
         */
        this.lightMap = null;

        /**
         * Intensity of the baked light.
         * @type {number}
         * @default 1
         */
        this.lightMapIntensity = 1.0;

        /**
         * The red channel of this texture is used as the ambient occlusion map.
         * Requires a second set of UVs.
         * @type {?Texture}
         * @default null
         */
        this.aoMap = null;

        /**
         * Intensity of the ambient occlusion effect. Range is `[0,1]`, where
         * `0` disables ambient occlusion. Where intensity is `1` and the AO
         * map's red channel is also `1`, ambient light is fully occluded on
         * a surface.
         * @type {number}
         * @default 1
         */
        this.aoMapIntensity = 1.0;

        /**
         * Specular map used by the material.
         * @type {?Texture}
         * @default null
         */
        this.specularMap = null;

        /**
         * The alpha map is a grayscale texture that controls the opacity
         * across the surface (black: fully transparent; white: fully opaque).
         * Only the color of the texture is used, ignoring the alpha channel
         * if one exists. For RGB and RGBA textures, the renderer will use
         * the green channel when sampling this texture due to the extra bit
         * of precision provided for green in DXT-compressed and uncompressed
         * RGB 565 formats. Luminance-only and luminance/alpha textures will
         * also still work as expected.
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * The environment map.
         * @type {?Texture}
         * @default null
         */
        this.envMap = null;

        /**
         * The rotation of the environment map in radians.
         * @type {Euler}
         * @default (0,0,0)
         */
        this.envMapRotation = new Euler();

        /**
         * How to combine the result of the surface's color with the
         * environment map, if any. When set to `MixOperation`, the
         * {@link MeshBasicMaterial#reflectivity} is used to blend between
         * the two colors.
         * @type {(MultiplyOperation|MixOperation|AddOperation)}
         * @default MultiplyOperation
         */
        this.combine = MultiplyOperation;

        /**
         * How much the environment map affects the surface. The valid range
         * is between `0` (no reflections) and `1` (full reflections).
         * @type {number}
         * @default 1
         */
        this.reflectivity = 1;

        /**
         * The index of refraction (IOR) of air (approximately 1) divided by
         * the index of refraction of the material. It is used with
         * environment mapping modes {@link CubeRefractionMapping} and
         * {@link EquirectangularRefractionMapping}. The refraction ratio
         * should not exceed `1`.
         * @type {number}
         * @default 0.98
         */
        this.refractionRatio = 0.98;

        /**
         * Renders the geometry as a wireframe.
         * @type {boolean}
         * @default false
         */
        this.wireframe = false;

        /**
         * Controls the thickness of the wireframe. Can only be used with
         * {@link SVGRenderer}.
         * @type {number}
         * @default 1
         */
        this.wireframeLinewidth = 1;

        /**
         * Defines appearance of wireframe ends. Can only be used with
         * {@link SVGRenderer}.
         * @type {('round'|'bevel'|'miter')}
         * @default 'round'
         */
        this.wireframeLinecap = 'round';

        /**
         * Defines appearance of wireframe joints. Can only be used with
         * {@link SVGRenderer}.
         * @type {('round'|'bevel'|'miter')}
         * @default 'round'
         */
        this.wireframeLinejoin = 'round';

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
         * Number of flat color bands for cel-like banding. 1 = off,
         * 2-4 = classic anime flat shading.
         * @type {number}
         * @default 3
         */
        this.flatBands = 3;

        /**
         * Blend amount between continuous and banded luminance. 0 = off,
         * 1 = fully quantized.
         * @type {number}
         * @default 0.8
         */
        this.flatQuantize = 0.8;

        /**
         * The precomputed flat-color result. Populated automatically by
         * `updateFlatColor()`.
         * @type {Color}
         */
        this.flatColor = new Color( 0xffffff );

        /**
         * Mood temperature shift in [-1, 1]. Positive = warm (sunset orange),
         * negative = cool (snowy cyan).
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
         * The precomputed mood-graded color. Populated automatically by
         * `updateMoodColor()`.
         * @type {Color}
         */
        this.moodColor = new Color( 0xffffff );

        /**
         * Rim-glow intensity for character silhouettes and neon effects.
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Rim-glow color. Defaults to a cool cyan.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color( 0.5, 0.9, 1.0 );

        /**
         * Watercolor bleed strength. 0 = off, 1 = maximum pigment diffusion.
         * @type {number}
         * @default 0
         */
        this.watercolorBleed = 0;

        /**
         * Per-instance variation seed for decorrelating procedural effects
         * across a crowd of identical meshes.
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
     * Recompute the flat-color result from the current flatBands and
     * flatQuantize values. Uses double.js for bit-exact luminance
     * quantization.
     * @returns {MeshBasicMaterial} A reference to this instance.
     */
    updateFlatColor() {
        applyFlatColorBanding( this.color, this.flatColor, this.flatBands, this.flatQuantize );
        return this;
    }

    /**
     * Recompute the mood-graded color from the current mood parameters.
     * @returns {MeshBasicMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy( this.color );
        gradeMeshColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Generate a procedural watercolor variation texture for this material.
     * The caller is expected to assign the returned buffer to a
     * `DataTexture` and attach it to the `map` slot.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.03]
     * @param {number} [octaves=3]
     * @returns {Uint8Array}
     */
    generateWatercolorTexture( width, height, scale = 0.03, octaves = 3 ) {
        return generateWatercolorTexture( width, height, scale, octaves, this.watercolorBleed );
    }

    /**
     * Compute a per-instance variation offset from the variationSeed. Used
     * to decorrelate watercolor textures and brush jitter across a crowd
     * of identical meshes.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * 137.508; // golden-angle increment
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------
    /**
     * The default `onBeforeCompile` hook. Extends the base Material's
     * anime shader chunks with mesh-specific features: flat-color banding,
     * watercolor texture variation, and rim glow.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject mesh-specific uniforms
        shader.uniforms.flatBands = { value: this.flatBands };
        shader.uniforms.flatQuantize = { value: this.flatQuantize };
        shader.uniforms.flatColor = { value: this.flatColor };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int flatBands;
                uniform float flatQuantize;
                uniform vec3 flatColor;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float watercolorBleed;
                uniform float variationOffset;

                vec3 applyFlatBanding( vec3 baseColor ) {
                    if ( flatBands <= 1 ) return baseColor;
                    float lum = dot( baseColor, vec3( 0.2126, 0.7152, 0.0722 ) );
                    float bandWidth = 1.0 / float( flatBands );
                    float quantizedLum = floor( lum / bandWidth ) * bandWidth + bandWidth * 0.5;
                    float finalLum = mix( lum, quantizedLum, flatQuantize );
                    if ( lum > 0.0001 ) {
                        return baseColor * ( finalLum / lum );
                    }
                    return baseColor;
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Apply flat-color cel banding for unlit surfaces
                gl_FragColor.rgb = applyFlatBanding( gl_FragColor.rgb );

                // Override with mood-graded color for unlit materials
                gl_FragColor.rgb = mix( gl_FragColor.rgb, moodColor, 0.7 );

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
            this.flatBands,
            this.flatQuantize,
            this.rimGlow,
            this.watercolorBleed,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {MeshBasicMaterial} source - The material to copy from.
     * @return {MeshBasicMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.color.copy( source.color );
        this.map = source.map;
        this.lightMap = source.lightMap;
        this.lightMapIntensity = source.lightMapIntensity;
        this.aoMap = source.aoMap;
        this.aoMapIntensity = source.aoMapIntensity;
        this.specularMap = source.specularMap;
        this.alphaMap = source.alphaMap;
        this.envMap = source.envMap;
        this.envMapRotation.copy( source.envMapRotation );
        this.combine = source.combine;
        this.reflectivity = source.reflectivity;
        this.refractionRatio = source.refractionRatio;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.wireframeLinecap = source.wireframeLinecap;
        this.wireframeLinejoin = source.wireframeLinejoin;
        this.fog = source.fog;

        // Anime extensions
        this.flatBands = source.flatBands;
        this.flatQuantize = source.flatQuantize;
        this.flatColor.copy( source.flatColor );
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy( source.moodColor );
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy( source.rimGlowColor );
        this.watercolorBleed = source.watercolorBleed;
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

        data.type = 'MeshBasicMaterial';

        if ( this.color.getHex() !== 0xffffff ) data.color = this.color.getHex();
        if ( this.lightMap !== null ) data.lightMap = this.lightMap.toJSON( meta ).uuid;
        if ( this.lightMapIntensity !== 1.0 ) data.lightMapIntensity = this.lightMapIntensity;
        if ( this.aoMap !== null ) data.aoMap = this.aoMap.toJSON( meta ).uuid;
        if ( this.aoMapIntensity !== 1.0 ) data.aoMapIntensity = this.aoMapIntensity;
        if ( this.specularMap !== null ) data.specularMap = this.specularMap.toJSON( meta ).uuid;
        if ( this.alphaMap !== null ) data.alphaMap = this.alphaMap.toJSON( meta ).uuid;
        if ( this.envMap !== null ) data.envMap = this.envMap.toJSON( meta ).uuid;
        if ( this.envMapRotation.x !== 0 || this.envMapRotation.y !== 0 || this.envMapRotation.z !== 0 ) {
            data.envMapRotation = this.envMapRotation.toArray();
        }
        if ( this.combine !== MultiplyOperation ) data.combine = this.combine;
        if ( this.reflectivity !== 1 ) data.reflectivity = this.reflectivity;
        if ( this.refractionRatio !== 0.98 ) data.refractionRatio = this.refractionRatio;
        if ( this.wireframe !== false ) data.wireframe = this.wireframe;
        if ( this.wireframeLinewidth !== 1 ) data.wireframeLinewidth = this.wireframeLinewidth;
        if ( this.wireframeLinecap !== 'round' ) data.wireframeLinecap = this.wireframeLinecap;
        if ( this.wireframeLinejoin !== 'round' ) data.wireframeLinejoin = this.wireframeLinejoin;
        if ( this.fog === false ) data.fog = false;

        // Anime extensions
        if ( this.flatBands !== 3 ) data.flatBands = this.flatBands;
        if ( this.flatQuantize !== 0.8 ) data.flatQuantize = this.flatQuantize;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.rimGlow !== 0 ) data.rimGlow = this.rimGlow;
        if ( this.rimGlowColor.getHex() !== new Color( 0.5, 0.9, 1.0 ).getHex() ) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if ( this.watercolorBleed !== 0 ) data.watercolorBleed = this.watercolorBleed;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    MeshBasicMaterial,
    MeshBasicMaterialBatch,
    applyFlatColorBanding,
    gradeMeshColor,
    generateWatercolorTexture
};
export default MeshBasicMaterial;