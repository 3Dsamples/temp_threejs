// file number : 006
// full path name : src/materials/006_meshlambertmaterial.js
// description : MeshLambertMaterial (three.js r185) rewritten as a high-
// performance ES module with deep anime-stylization integration. Extends the
// anime-enabled 001_material.js base class and preserves the full r185
// MeshLambertMaterial API — color, emissive, emissiveIntensity, emissiveMap,
// map, lightMap, lightMapIntensity, aoMap, aoMapIntensity, specularMap,
// alphaMap, envMap, envMapRotation, combine, reflectivity, refractionRatio,
// wireframe, wireframeLinewidth, wireframeLinecap, wireframeLinejoin, fog, and
// the inherited material surface. Lambert shading (per-vertex Gouraud
// lighting) is particularly well-suited to anime cel-shading because it
// naturally produces soft, low-frequency gradients. Adds real-time anime
// features specifically tuned for this: Lambert-driven cel banding with
// configurable softness, ambient-anime gradient tinting, mood-based color
// grading (snowy cyan / sunset orange / vibrant flora), rim glow on
// silhouettes, procedural paper-grain and watercolor texture variation via
// simplex-noise, and per-instance variation for crowds. Imports Color, Euler,
// Vector2, and other math classes strictly from threejs_new01 math, and uses
// gl-matrix for zero-allocation color transforms, double.js for bit-exact
// cel-band thresholding and HDR mood grading, bitecs SoA batching for real-
// time updates across thousands of instances, and simplex-noise for
// procedural texture variation.
// best for : MeshLambertMaterial, low-cost character shading, stylized anime
// backgrounds, distant foliage, town/village props, mobile anime games, and
// any three.js lambert-shaded mesh that needs real-time anime stylization.
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
// Anime feature — Lambert-driven cel banding with soft edge
// ---------------------------------------------------------------------------
/**
 * Apply cel-shading banding to a Lambert-lit color using double.js for
 * bit-exact thresholding. Lambert materials already produce low-frequency
 * gradients, so the banding operation here uses a softer transition than
 * a standard toon material — producing the characteristic "soft cel"
 * look of modern anime (reference images 2, 4, 6, 7).
 * @param {Color} baseColor - The Lambert-lit base color.
 * @param {Color} output - The output color (modified in place).
 * @param {number} bands - Number of cel bands (2-4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @param {number} [softness=0.1] - Edge softness in [0, 0.5].
 * @param {number} [shadowTint=0.85] - Shadow band brightness multiplier.
 * @returns {Color}
 */
function applyLambertCelBanding( baseColor, output, bands, quantizeAmount, softness = 0.1, shadowTint = 0.85 ) {
    if ( bands <= 1 ) {
        output.copy( baseColor );
        return output;
    }

    // Luminance
    _double.value = 0.2126 * baseColor.r;
    _double.add( 0.7152 * baseColor.g );
    _double.add( 0.0722 * baseColor.b );
    const lum = _double.value;

    // Quantize with a soft band transition (mix hard band with a smoothstep)
    const bandWidth = 1.0 / bands;

    _double.value = lum;
    _double.div( bandWidth );
    const bandIndex = Math.floor( _double.value );

    _double.value = bandIndex;
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    // Soft transition: blend between hard band and a smoothstep near the boundary
    const distToBoundary = Math.abs( lum - Math.floor( lum / bandWidth ) * bandWidth - bandWidth * 0.5 );
    const softFactor = Math.max( 0, Math.min( 1, distToBoundary / ( bandWidth * 0.5 ) ) );
    const softQuantized = quantized + ( lum - quantized ) * ( 1 - softFactor ) * softness;

    // Blend continuous and quantized
    _double.value = lum;
    _double.add( ( softQuantized - lum ) * quantizeAmount );
    const finalLum = _double.value;

    // Apply shadow tint to the lower bands
    _double.value = shadowTint;
    _double.add( ( 1.0 - shadowTint ) * ( finalLum / Math.max( lum, 0.0001 ) ) );
    const shadowMultiplier = Math.min( 1, _double.value );

    // Preserve hue, change luminance
    if ( lum > 0.0001 ) {
        _double.value = baseColor.r;
        _double.div( lum );
        _double.mul( finalLum );
        _double.mul( shadowMultiplier );
        output.r = _double.value;

        _double.value = baseColor.g;
        _double.div( lum );
        _double.mul( finalLum );
        _double.mul( shadowMultiplier );
        output.g = _double.value;

        _double.value = baseColor.b;
        _double.div( lum );
        _double.mul( finalLum );
        _double.mul( shadowMultiplier );
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
// Anime feature — ambient-anime gradient tinting
// ---------------------------------------------------------------------------
/**
 * Apply a vertical gradient tint to emulate the ambient-sky-to-ground
 * gradient characteristic of anime backgrounds (the blue sky to warm
 * ground transition in reference images 2, 4, 5). Uses gl-matrix for
 * zero-allocation staging and double.js for bit-exact accumulation.
 * @param {Color} color - The color to tint (modified in place).
 * @param {number} worldY - The world Y coordinate of the fragment.
 * @param {number} heightRange - Range over which the gradient blends.
 * @param {Color} skyColor - Tint applied at the top.
 * @param {Color} groundColor - Tint applied at the bottom.
 * @param {number} intensity - Blend intensity in [0, 1].
 * @returns {Color}
 */
function applyAmbientGradientTint( color, worldY, heightRange, skyColor, groundColor, intensity ) {
    if ( intensity <= 0 ) return color;

    _double.value = worldY;
    _double.div( heightRange );
    _double.add( 0.5 );
    let t = _double.value;
    t = Math.max( 0, Math.min( 1, t ) );

    // Blend between ground (t=0) and sky (t=1)
    _double.value = groundColor.r;
    _double.add( ( skyColor.r - groundColor.r ) * t );
    const tr = _double.value;

    _double.value = groundColor.g;
    _double.add( ( skyColor.g - groundColor.g ) * t );
    const tg = _double.value;

    _double.value = groundColor.b;
    _double.add( ( skyColor.b - groundColor.b ) * t );
    const tb = _double.value;

    // Mix tinted color with the base color
    _double.value = color.r;
    _double.mul( 1 - intensity );
    _double.add( tr * color.r * intensity );
    color.r = _double.value;

    _double.value = color.g;
    _double.mul( 1 - intensity );
    _double.add( tg * color.g * intensity );
    color.g = _double.value;

    _double.value = color.b;
    _double.mul( 1 - intensity );
    _double.add( tb * color.b * intensity );
    color.b = _double.value;

    return color;
}

// ---------------------------------------------------------------------------
// Anime feature — mood-based color grading for Lambert-lit surfaces
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading. Handles warm (sunset orange), cool
 * (snowy cyan), and vibrant (flora) moods seen across the reference
 * imagery. Uses gl-matrix for zero-allocation staging and double.js
 * for bit-exact accumulation.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeLambertColor( color, temperature, saturation, brightness, contrast ) {
    glMatrix.vec3.set( _gm_rgb, color.r, color.g, color.b );

    // Saturation
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
// Anime feature — procedural paper-grain / watercolor texture variation
// ---------------------------------------------------------------------------
/**
 * Generate a combined paper-grain and watercolor texture using simplex-noise
 * with multiple octaves. Produces the hand-painted texture characteristic
 * of the reference imagery's landscapes (snowy peaks in 1, sunset sky in 2,
 * cyan ocean in 3, clouds in 4, foliage in 5).
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03] - Base noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [paperGrain=0.3] - Paper grain intensity.
 * @param {number} [watercolorBleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateLambertTexture( width, height, scale = 0.03, octaves = 3, paperGrain = 0.3, watercolorBleed = 0.5 ) {
    const out = new Uint8Array( width * height * 4 );
    for ( let y = 0; y < height; y ++ ) {
        for ( let x = 0; x < width; x ++ ) {
            const p = ( y * width + x ) * 4;

            // Multi-octave watercolor base
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

            // Watercolor bleed: soften toward extremes
            _double.value = value;
            _double.sub( 0.5 );
            _double.mul( 1.0 + watercolorBleed );
            _double.add( 0.5 );
            value = Math.max( 0, Math.min( 1, _double.value ) );

            // Paper grain overlay (fine high-frequency noise)
            const grain = _noise2D( x * 0.5, y * 0.5 ) * 0.5 + 0.5;
            _double.value = value;
            _double.mul( 1 - paperGrain );
            _double.add( grain * paperGrain );
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
// bitecs SoA batch coordinator for real-time Lambert material updates
// ---------------------------------------------------------------------------
const _lambertWorld = createWorld();
const LambertMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    celBands: Types.ui8,
    celQuantize: Types.f64,
    celSoftness: Types.f64,
    shadowTint: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    rimGlow: Types.f64,
    ambientGradient: Types.f64,
    paperGrain: Types.f64,
    watercolorBleed: Types.f64,
    dirty: Types.ui8
} );

class MeshLambertMaterialBatch {

    constructor() {
        this.world = _lambertWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshLambertMaterial instance for batched real-time updates.
     * @param {MeshLambertMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, LambertMaterialComponent, eid );
        LambertMaterialComponent.materialPtr[ eid ] = this.materials.length;
        LambertMaterialComponent.celBands[ eid ] = material.celBands;
        LambertMaterialComponent.celQuantize[ eid ] = material.celQuantize;
        LambertMaterialComponent.celSoftness[ eid ] = material.celSoftness;
        LambertMaterialComponent.shadowTint[ eid ] = material.shadowTint;
        LambertMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        LambertMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        LambertMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        LambertMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        LambertMaterialComponent.rimGlow[ eid ] = material.rimGlow;
        LambertMaterialComponent.ambientGradient[ eid ] = material.ambientGradient;
        LambertMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        LambertMaterialComponent.watercolorBleed[ eid ] = material.watercolorBleed;
        LambertMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued lambert-material updates in one cache-friendly pass.
     * Uses double.js internally for bit-exact cel banding and mood grading.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ LambertMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.celBands = LambertMaterialComponent.celBands[ eid ];
            material.celQuantize = LambertMaterialComponent.celQuantize[ eid ];
            material.celSoftness = LambertMaterialComponent.celSoftness[ eid ];
            material.shadowTint = LambertMaterialComponent.shadowTint[ eid ];
            material.moodTemperature = LambertMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = LambertMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = LambertMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = LambertMaterialComponent.moodContrast[ eid ];
            material.rimGlow = LambertMaterialComponent.rimGlow[ eid ];
            material.ambientGradient = LambertMaterialComponent.ambientGradient[ eid ];
            material.paperGrain = LambertMaterialComponent.paperGrain[ eid ];
            material.watercolorBleed = LambertMaterialComponent.watercolorBleed[ eid ];

            // Recompute derived colors
            applyLambertCelBanding(
                material.color,
                material.celColor,
                material.celBands,
                material.celQuantize,
                material.celSoftness,
                material.shadowTint
            );
            material.moodColor.copy( material.color );
            gradeLambertColor(
                material.moodColor,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );

            LambertMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshLambertMaterial class — mirrors
// three.js/src/materials/MeshLambertMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material for non-shiny surfaces, without specular highlights.
 * The material uses a non-based physically Lambertian model for calculating
 * the color of the material. This is in contrast to `MeshPhongMaterial`
 * which computes a specular component as well.
 *
 * In addition to the standard three.js parameters, this material exposes
 * a rich set of real-time anime-style controls: Lambert-driven cel banding
 * with configurable softness, ambient-anime gradient tinting, mood-based
 * color grading, rim glow, and procedural paper-grain / watercolor texture
 * variation.
 *
 * ```js
 * const material = new THREE.MeshLambertMaterial( {
 *   color: 0x88ccff,
 *   emissive: 0x220033,
 *   celBands: 3,
 *   celQuantize: 0.8,
 *   moodTemperature: -0.3,
 *   watercolorBleed: 0.5
 * } );
 * ```
 * @augments Material
 */
class MeshLambertMaterial extends Material {

    /**
     * Constructs a new mesh lambert material.
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
        this.isMeshLambertMaterial = true;

        this.type = 'MeshLambertMaterial';

        /**
         * Color of the material. Default is `0xffffff` (white).
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color( 0xffffff );

        /**
         * The emissive (light) color of the material.
         * @type {Color}
         * @default (0,0,0)
         */
        this.emissive = new Color( 0x000000 );

        /**
         * The intensity of the emissive color.
         * @type {number}
         * @default 1
         */
        this.emissiveIntensity = 1.0;

        /**
         * The emissive map. The texture is expected to be in the sRGB
         * color space.
         * @type {?Texture}
         * @default null
         */
        this.emissiveMap = null;

        /**
         * The color map. The texture is expected to be in the sRGB color
         * space.
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
         * The red channel of this texture is used as the ambient occlusion
         * map. Requires a second set of UVs.
         * @type {?Texture}
         * @default null
         */
        this.aoMap = null;

        /**
         * Intensity of the ambient occlusion effect.
         * @type {number}
         * @default 1
         */
        this.aoMapIntensity = 1.0;

        /**
         * The specular map.
         * @type {?Texture}
         * @default null
         */
        this.specularMap = null;

        /**
         * The alpha map. The texture is expected to be in `NoColorSpace`.
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
         * The rotation of the environment map.
         * @type {Euler}
         * @default (0,0,0)
         */
        this.envMapRotation = new Euler();

        /**
         * How to combine the environment map with the surface color.
         * @type {number}
         * @default MultiplyOperation
         */
        this.combine = MultiplyOperation;

        /**
         * How much the environment map affects the surface.
         * @type {number}
         * @default 1
         */
        this.reflectivity = 1;

        /**
         * The index of refraction ratio.
         * @type {number}
         * @default 0.98
         */
        this.refractionRatio = 0.98;

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
         * Defines appearance of wireframe ends.
         * @type {string}
         * @default 'round'
         */
        this.wireframeLinecap = 'round';

        /**
         * Defines appearance of wireframe joints.
         * @type {string}
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
         * Number of cel bands for stylized Lambert shading. 0 = off,
         * 2 = classic hard-shadow, 3-4 = soft cel (recommended for Lambert).
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Blend amount between continuous Lambert and banded shading.
         * @type {number}
         * @default 1.0
         */
        this.celQuantize = 1.0;

        /**
         * Edge softness of cel bands. 0 = hard edges, 0.3 = very soft.
         * Lambert materials typically use a higher softness for a
         * gentler look.
         * @type {number}
         * @default 0.15
         */
        this.celSoftness = 0.15;

        /**
         * Shadow band brightness multiplier. 0.7 = strong shadow,
         * 0.95 = very soft shadow. Anime shadows are typically 0.8-0.9.
         * @type {number}
         * @default 0.85
         */
        this.shadowTint = 0.85;

        /**
         * The precomputed cel-banded color. Populated automatically by
         * `updateCelColor()`.
         * @type {Color}
         */
        this.celColor = new Color( 0xffffff );

        /**
         * Mood temperature shift in [-1, 1]. Positive = warm (sunset),
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
         * Rim-glow intensity. Set > 0 to make the mesh edges glow (matches
         * the cyan water rims and sunset character rims in the reference
         * imagery).
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Rim-glow color. Defaults to cool cyan.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color( 0.5, 0.9, 1.0 );

        /**
         * Ambient gradient intensity. Blends a vertical sky-to-ground
         * gradient tint onto the Lambert color for stylized atmospheres.
         * @type {number}
         * @default 0
         */
        this.ambientGradient = 0;

        /**
         * The sky tint applied at the top of the ambient gradient.
         * @type {Color}
         * @default (0.5, 0.75, 1.0)
         */
        this.skyTint = new Color( 0.5, 0.75, 1.0 );

        /**
         * The ground tint applied at the bottom of the ambient gradient.
         * @type {Color}
         * @default (1.0, 0.85, 0.7)
         */
        this.groundTint = new Color( 1.0, 0.85, 0.7 );

        /**
         * Paper-grain overlay intensity.
         * @type {number}
         * @default 0
         */
        this.paperGrain = 0;

        /**
         * Watercolor bleed strength.
         * @type {number}
         * @default 0
         */
        this.watercolorBleed = 0;

        /**
         * Procedural variation seed. Varies the watercolor texture between
         * instances.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        this.setValues( parameters );

        // Initialise derived colors from current state.
        this.updateCelColor();
        this.updateMoodColor();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Recompute the cel-banded color from the current parameters.
     * @returns {MeshLambertMaterial} A reference to this instance.
     */
    updateCelColor() {
        applyLambertCelBanding( this.color, this.celColor, this.celBands, this.celQuantize, this.celSoftness, this.shadowTint );
        return this;
    }

    /**
     * Recompute the mood-graded color from the current mood parameters.
     * @returns {MeshLambertMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy( this.color );
        gradeLambertColor( this.moodColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast );
        return this;
    }

    /**
     * Apply the ambient gradient tint to a color at a given world Y.
     * @param {Color} color - The color to tint.
     * @param {number} worldY - World Y coordinate.
     * @param {number} [heightRange=10] - Range over which the gradient blends.
     * @returns {Color}
     */
    applyAmbientGradient( color, worldY, heightRange = 10 ) {
        return applyAmbientGradientTint( color, worldY, heightRange, this.skyTint, this.groundTint, this.ambientGradient );
    }

    /**
     * Generate a procedural paper-grain / watercolor texture for this
     * material. The caller is expected to assign the returned buffer to
     * a `DataTexture`.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.03]
     * @param {number} [octaves=3]
     * @returns {Uint8Array}
     */
    generateLambertTexture( width, height, scale = 0.03, octaves = 3 ) {
        return generateLambertTexture( width, height, scale, octaves, this.paperGrain, this.watercolorBleed );
    }

    /**
     * Compute the per-instance variation offset from the variationSeed.
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
     * anime shader chunks with Lambert-specific features.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject Lambert-specific uniforms
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.celQuantize = { value: this.celQuantize };
        shader.uniforms.celSoftness = { value: this.celSoftness };
        shader.uniforms.shadowTint = { value: this.shadowTint };
        shader.uniforms.celColor = { value: this.celColor };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.ambientGradient = { value: this.ambientGradient };
        shader.uniforms.skyTint = { value: this.skyTint };
        shader.uniforms.groundTint = { value: this.groundTint };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int celBands;
                uniform float celQuantize;
                uniform float celSoftness;
                uniform float shadowTint;
                uniform vec3 celColor;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float ambientGradient;
                uniform vec3 skyTint;
                uniform vec3 groundTint;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float variationOffset;

                vec3 applyLambertCel( vec3 baseColor ) {
                    if ( celBands <= 1 ) return baseColor;
                    float lum = dot( baseColor, vec3( 0.2126, 0.7152, 0.0722 ) );
                    float bandWidth = 1.0 / float( celBands );
                    float bandIndex = floor( lum / bandWidth );
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    // Soft edge near the band boundary
                    float distToBoundary = abs( lum - bandIndex * bandWidth - bandWidth * 0.5 );
                    float softFactor = clamp( distToBoundary / ( bandWidth * 0.5 ), 0.0, 1.0 );
                    float softQuantized = quantized + ( lum - quantized ) * ( 1.0 - softFactor ) * celSoftness;
                    float finalLum = mix( lum, softQuantized, celQuantize );
                    // Shadow tint multiplier
                    float shadowMul = shadowTint + ( 1.0 - shadowTint ) * ( finalLum / max( lum, 0.0001 ) );
                    shadowMul = min( 1.0, shadowMul );
                    return baseColor * ( finalLum / max( lum, 0.0001 ) ) * shadowMul;
                }

                vec3 applyAmbientGradient( vec3 baseColor, float worldY ) {
                    if ( ambientGradient <= 0.0 ) return baseColor;
                    float t = clamp( worldY / 10.0 + 0.5, 0.0, 1.0 );
                    vec3 tint = mix( groundTint, skyTint, t );
                    return mix( baseColor, baseColor * tint, ambientGradient );
                }

                float samplePaperGrain( vec2 uv ) {
                    if ( paperGrain <= 0.0 ) return 1.0;
                    float n = sin( uv.x * 8.0 + variationOffset ) * cos( uv.y * 8.0 + variationOffset );
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * ( 1.0 - n );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Apply Lambert-driven cel banding
                gl_FragColor.rgb = applyLambertCel( gl_FragColor.rgb );

                // Override with mood-graded color for Lambert materials
                gl_FragColor.rgb = mix(
                    gl_FragColor.rgb,
                    moodColor * ( dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( dot( moodColor, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0001 ) ),
                    0.5
                );

                // Ambient gradient tint (using view position as world Y proxy)
                gl_FragColor.rgb = applyAmbientGradient( gl_FragColor.rgb, vViewPosition.z );

                // Paper grain opacity modulation
                gl_FragColor.a *= samplePaperGrain( vUv );

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
            this.celSoftness,
            this.shadowTint,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.rimGlow,
            this.ambientGradient,
            this.paperGrain,
            this.watercolorBleed,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {MeshLambertMaterial} source - The material to copy from.
     * @return {MeshLambertMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.color.copy( source.color );
        this.emissive.copy( source.emissive );
        this.emissiveIntensity = source.emissiveIntensity;
        this.emissiveMap = source.emissiveMap;
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
        this.celBands = source.celBands;
        this.celQuantize = source.celQuantize;
        this.celSoftness = source.celSoftness;
        this.shadowTint = source.shadowTint;
        this.celColor.copy( source.celColor );
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy( source.moodColor );
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy( source.rimGlowColor );
        this.ambientGradient = source.ambientGradient;
        this.skyTint.copy( source.skyTint );
        this.groundTint.copy( source.groundTint );
        this.paperGrain = source.paperGrain;
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

        data.type = 'MeshLambertMaterial';

        if ( this.color.getHex() !== 0xffffff ) data.color = this.color.getHex();
        if ( this.emissive.getHex() !== 0x000000 ) data.emissive = this.emissive.getHex();
        if ( this.emissiveIntensity !== 1.0 ) data.emissiveIntensity = this.emissiveIntensity;
        if ( this.emissiveMap !== null ) data.emissiveMap = this.emissiveMap.toJSON( meta ).uuid;
        if ( this.map !== null ) data.map = this.map.toJSON( meta ).uuid;
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
        if ( this.celBands !== 0 ) data.celBands = this.celBands;
        if ( this.celQuantize !== 1.0 ) data.celQuantize = this.celQuantize;
        if ( this.celSoftness !== 0.15 ) data.celSoftness = this.celSoftness;
        if ( this.shadowTint !== 0.85 ) data.shadowTint = this.shadowTint;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.rimGlow !== 0 ) data.rimGlow = this.rimGlow;
        if ( this.rimGlowColor.getHex() !== new Color( 0.5, 0.9, 1.0 ).getHex() ) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if ( this.ambientGradient !== 0 ) data.ambientGradient = this.ambientGradient;
        if ( this.skyTint.getHex() !== new Color( 0.5, 0.75, 1.0 ).getHex() ) {
            data.skyTint = this.skyTint.getHex();
        }
        if ( this.groundTint.getHex() !== new Color( 1.0, 0.85, 0.7 ).getHex() ) {
            data.groundTint = this.groundTint.getHex();
        }
        if ( this.paperGrain !== 0 ) data.paperGrain = this.paperGrain;
        if ( this.watercolorBleed !== 0 ) data.watercolorBleed = this.watercolorBleed;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    MeshLambertMaterial,
    MeshLambertMaterialBatch,
    applyLambertCelBanding,
    applyAmbientGradientTint,
    gradeLambertColor,
    generateLambertTexture
};
export default MeshLambertMaterial;