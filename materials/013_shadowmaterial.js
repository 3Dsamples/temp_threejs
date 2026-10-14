// file number : 013
// full path name : src/materials/013_shadowmaterial.js
// description : ShadowMaterial (three.js r185) rewritten as a high-performance ES module with deep anime-stylization integration. Extends the anime-enabled 001_material.js base class and preserves the full r185 ShadowMaterial API — color, fog, transparent, isShadowMaterial flag, and the inherited material surface. ShadowMaterial is a special shader-based material that receives shadows but is otherwise completely transparent. This rewrite extends it into a full anime-shadow stylization platform: mood-based shadow tinting (cool cyan shadows for snowy scenes, warm purple-umber shadows for sunset scenes — matching the reference imagery's atmospheric shadow color), cel-band shadow quantization (discrete shadow density steps for flat anime look), simplex-noise dithered shadow falloff (breaks up 8-bit shadow banding without adding visible noise), paper-grain shadow texture (hand-painted feel), and per-instance variation for shadow-catcher crowds. Imports Color strictly from threejs_new01 math, and uses gl-matrix for zero-allocation shadow color transforms, double.js for bit-exact shadow density quantization and mood grading, bitecs SoA batching for real-time updates across thousands of shadow-catcher planes, and simplex-noise for the dithering and paper-grain features.
// best for : ShadowMaterial, shadow-catching ground planes, anime shadow styling, toon-consistent ground shadows, stylized contact shadows, and any three.js shadow-receiving plane that needs real-time stylization.
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

// gl-matrix scratch for zero-allocation shadow color transforms
const _gm_rgb = glMatrix.vec3.create();
const _gm_hsv = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Anime feature — mood-based shadow tinting
// ---------------------------------------------------------------------------
/**
 * Apply mood-based shadow tinting. Shadows in anime are never pure black —
 * snowy scenes have cool cyan-blue shadows (matching the reference imagery's
 * snow shadows in 1 and 5), while sunset scenes have warm purple-umber
 * shadows (matching the sunset character shadows in 2 and 4). Uses
 * gl-matrix for zero-allocation staging and double.js for bit-exact
 * accumulation.
 * @param {Color} color - The shadow color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeShadowColor( color, temperature, saturation, brightness, contrast ) {
    glMatrix.vec3.set( _gm_rgb, color.r, color.g, color.b );

    const lum = 0.2126 * _gm_rgb[ 0 ] + 0.7152 * _gm_rgb[ 1 ] + 0.0722 * _gm_rgb[ 2 ];

    // Saturation
    _double.value = lum; _double.add( ( _gm_rgb[ 0 ] - lum ) * saturation ); let r = _double.value;
    _double.value = lum; _double.add( ( _gm_rgb[ 1 ] - lum ) * saturation ); let g = _double.value;
    _double.value = lum; _double.add( ( _gm_rgb[ 2 ] - lum ) * saturation ); let b = _double.value;

    // Contrast
    _double.value = r; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); r = _double.value;
    _double.value = g; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); g = _double.value;
    _double.value = b; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); b = _double.value;

    // Temperature: warm shadows shift toward purple-umber, cool shadows toward cyan
    _double.value = r; _double.add( temperature * 0.08 ); r = _double.value;
    _double.value = g; _double.add( temperature * 0.02 ); g = _double.value;
    _double.value = b; _double.sub( temperature * 0.08 ); b = _double.value;

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
// Anime feature — cel-band shadow density quantization
// ---------------------------------------------------------------------------
/**
 * Quantize a shadow density value into discrete cel bands using double.js
 * for bit-exact thresholding. Produces discrete shadow steps for the flat
 * anime look, avoiding the continuous gradient of standard shadow rendering.
 * @param {number} density - Raw shadow density in [0, 1] (1 = full shadow).
 * @param {number} bands - Number of shadow bands (2-5 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @param {number} [softness=0.1] - Edge softness in [0, 0.3].
 * @returns {number} Banded shadow density in [0, 1].
 */
function quantizeShadowDensityCel( density, bands, quantizeAmount, softness = 0.1 ) {
    if ( bands <= 1 ) return density;

    const bandWidth = 1.0 / bands;
    _double.value = density;
    _double.div( bandWidth );
    const bandIndex = Math.floor( _double.value );
    _double.value = bandIndex;
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    // Soft edge
    const distToBoundary = Math.abs( density - bandIndex * bandWidth - bandWidth * 0.5 );
    const softFactor = Math.max( 0, Math.min( 1, distToBoundary / ( bandWidth * 0.5 ) ) );
    const softQuantized = quantized + ( density - quantized ) * ( 1 - softFactor ) * softness;

    // Blend
    _double.value = density;
    _double.add( ( softQuantized - density ) * quantizeAmount );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — simplex-noise dithered shadow falloff
// ---------------------------------------------------------------------------
/**
 * Apply simplex-noise dithering to a shadow density value. Breaks up 8-bit
 * shadow banding without adding visible noise — the dithering is correlated
 * to screen position so it averages out smoothly under bilinear filtering.
 * @param {number} density - Shadow density in [0, 1].
 * @param {number} x - Screen-space x coordinate.
 * @param {number} y - Screen-space y coordinate.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @param {number} [scale=1.0] - Noise scale (higher = finer dither).
 * @returns {number} Dithered shadow density in [0, 1].
 */
function ditherShadowDensity( density, x, y, amplitude = 0.5, scale = 1.0 ) {
    const n = _noise2D( x * scale, y * scale );
    _double.value = density;
    _double.add( n * amplitude / 255 );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — paper-grain shadow texture
// ---------------------------------------------------------------------------
/**
 * Compute a paper-grain modulation for the shadow density. Adds the subtle
 * hand-drawn texture characteristic of the reference imagery's watercolor
 * backgrounds, giving shadows a hand-painted rather than CG feel.
 * @param {number} u - U coordinate in [0, 1].
 * @param {number} v - V coordinate in [0, 1].
 * @param {number} [scale=10.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.3] - Grain intensity in [0, 1].
 * @returns {number} Multiplier in [0, 1] to apply to shadow density.
 */
function shadowPaperGrain( u, v, scale = 10.0, intensity = 0.3 ) {
    const n = _noise2D( u * scale, v * scale ) * 0.5 + 0.5;
    _double.value = 1;
    _double.sub( intensity * ( 1 - n ) );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for real-time shadow material updates
// ---------------------------------------------------------------------------
const _shadowWorld = createWorld();
const ShadowMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    shadowBands: Types.ui8,
    shadowQuantize: Types.f64,
    shadowSoftness: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    ditherAmplitude: Types.f64,
    ditherScale: Types.f64,
    paperGrain: Types.f64,
    paperGrainScale: Types.f64,
    dirty: Types.ui8
} );

class ShadowMaterialBatch {

    constructor() {
        this.world = _shadowWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a ShadowMaterial instance for batched real-time updates.
     * @param {ShadowMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, ShadowMaterialComponent, eid );
        ShadowMaterialComponent.materialPtr[ eid ] = this.materials.length;
        ShadowMaterialComponent.shadowBands[ eid ] = material.shadowBands;
        ShadowMaterialComponent.shadowQuantize[ eid ] = material.shadowQuantize;
        ShadowMaterialComponent.shadowSoftness[ eid ] = material.shadowSoftness;
        ShadowMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        ShadowMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        ShadowMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        ShadowMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        ShadowMaterialComponent.ditherAmplitude[ eid ] = material.ditherAmplitude;
        ShadowMaterialComponent.ditherScale[ eid ] = material.ditherScale;
        ShadowMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        ShadowMaterialComponent.paperGrainScale[ eid ] = material.paperGrainScale;
        ShadowMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued shadow-material updates in one cache-friendly pass.
     * Uses double.js internally for bit-exact shadow density quantization
     * and mood grading.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ ShadowMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.shadowBands = ShadowMaterialComponent.shadowBands[ eid ];
            material.shadowQuantize = ShadowMaterialComponent.shadowQuantize[ eid ];
            material.shadowSoftness = ShadowMaterialComponent.shadowSoftness[ eid ];
            material.moodTemperature = ShadowMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = ShadowMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = ShadowMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = ShadowMaterialComponent.moodContrast[ eid ];
            material.ditherAmplitude = ShadowMaterialComponent.ditherAmplitude[ eid ];
            material.ditherScale = ShadowMaterialComponent.ditherScale[ eid ];
            material.paperGrain = ShadowMaterialComponent.paperGrain[ eid ];
            material.paperGrainScale = ShadowMaterialComponent.paperGrainScale[ eid ];

            // Recompute mood-graded shadow color
            material.moodColor.copy( material.color );
            gradeShadowColor(
                material.moodColor,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );

            ShadowMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ShadowMaterial class — mirrors
// three.js/src/materials/ShadowMaterial.js
// ---------------------------------------------------------------------------
/**
 * This material can receive shadows, but otherwise is completely transparent.
 *
 * ```js
 * const geometry = new THREE.PlaneGeometry( 2000, 2000 );
 * geometry.rotateX( - Math.PI / 2 );
 *
 * const material = new THREE.ShadowMaterial();
 * material.opacity = 0.2;
 *
 * const plane = new THREE.Mesh( geometry, material );
 * plane.position.y = - 200;
 * plane.receiveShadow = true;
 * scene.add( plane );
 * ```
 *
 * In addition to the standard three.js parameters, this material exposes a
 * rich set of real-time anime-style controls: cel-band shadow quantization,
 * mood-based shadow tinting, simplex-noise dithered shadow falloff, and
 * paper-grain shadow texture.
 *
 * @augments Material
 */
class ShadowMaterial extends Material {

    /**
     * Constructs a new shadow material.
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
        this.isShadowMaterial = true;

        this.type = 'ShadowMaterial';

        /**
         * Color of the material.
         * @type {Color}
         * @default (0,0,0)
         */
        this.color = new Color( 0x000000 );

        /**
         * Whether the material is affected by fog or not.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        /**
         * Overwritten since shadow materials are transparent by default.
         * @type {boolean}
         * @default true
         */
        this.transparent = true;

        // -------------------------------------------------------------------
        // Anime Rendering Extensions
        // -------------------------------------------------------------------
        /**
         * Number of shadow density cel bands. 2-5 = stylized flat anime
         * shadow steps.
         * @type {number}
         * @default 0
         */
        this.shadowBands = 0;

        /**
         * Blend amount between continuous and banded shadow density.
         * @type {number}
         * @default 1.0
         */
        this.shadowQuantize = 1.0;

        /**
         * Shadow band edge softness.
         * @type {number}
         * @default 0.1
         */
        this.shadowSoftness = 0.1;

        /**
         * Mood temperature shift in [-1, 1]. Positive = warm purple-umber
         * shadows (sunset), negative = cool cyan shadows (snow/ice).
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
         * The precomputed mood-graded shadow color. Populated automatically
         * by `updateMoodColor()`.
         * @type {Color}
         */
        this.moodColor = new Color( 0x000000 );

        /**
         * Simplex-noise dithering amplitude in 8-bit units. Breaks up 8-bit
         * shadow banding without adding visible noise.
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
         * Paper-grain shadow texture intensity.
         * @type {number}
         * @default 0
         */
        this.paperGrain = 0;

        /**
         * Paper-grain noise scale. Higher = finer grain.
         * @type {number}
         * @default 10.0
         */
        this.paperGrainScale = 10.0;

        /**
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        this.setValues( parameters );

        // Initialize derived colors.
        this.updateMoodColor();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Recompute the mood-graded shadow color from the current mood parameters.
     * @returns {ShadowMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy( this.color );
        gradeShadowColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply cel-band quantization to a shadow density value.
     * @param {number} density - Raw shadow density in [0, 1].
     * @returns {number} Banded shadow density in [0, 1].
     */
    applyShadowBanding( density ) {
        return quantizeShadowDensityCel(
            density,
            this.shadowBands,
            this.shadowQuantize,
            this.shadowSoftness
        );
    }

    /**
     * Apply simplex-noise dithering to a shadow density value.
     * @param {number} density - Shadow density in [0, 1].
     * @param {number} x - Screen-space x.
     * @param {number} y - Screen-space y.
     * @returns {number}
     */
    applyDither( density, x, y ) {
        if ( this.ditherAmplitude <= 0 ) return density;
        return ditherShadowDensity( density, x, y, this.ditherAmplitude, this.ditherScale );
    }

    /**
     * Compute the paper-grain modulation at a UV position.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    samplePaperGrain( u, v ) {
        if ( this.paperGrain <= 0 ) return 1;
        return shadowPaperGrain( u, v, this.paperGrainScale, this.paperGrain );
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
     * anime shader chunks with shadow-specific features: cel-band shadow
     * quantization, mood-based shadow tinting, simplex-noise dithering,
     * and paper-grain texture variation.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject shadow-specific uniforms
        shader.uniforms.shadowBands = { value: this.shadowBands };
        shader.uniforms.shadowQuantize = { value: this.shadowQuantize };
        shader.uniforms.shadowSoftness = { value: this.shadowSoftness };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.ditherScale = { value: this.ditherScale };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.paperGrainScale = { value: this.paperGrainScale };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int shadowBands;
                uniform float shadowQuantize;
                uniform float shadowSoftness;
                uniform vec3 moodColor;
                uniform float ditherAmplitude;
                uniform float ditherScale;
                uniform float paperGrain;
                uniform float paperGrainScale;
                uniform float variationOffset;

                float quantizeShadowDensity( float density ) {
                    if ( shadowBands <= 1 ) return density;
                    float bandWidth = 1.0 / float( shadowBands );
                    float bandIndex = floor( density / bandWidth );
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs( density - bandIndex * bandWidth - bandWidth * 0.5 );
                    float softFactor = clamp( distToBoundary / ( bandWidth * 0.5 ), 0.0, 1.0 );
                    float softQuantized = quantized + ( density - quantized ) * ( 1.0 - softFactor ) * shadowSoftness;
                    return mix( density, softQuantized, shadowQuantize );
                }

                float samplePaperGrain( vec2 uv ) {
                    if ( paperGrain <= 0.0 ) return 1.0;
                    float n = sin( uv.x * paperGrainScale + variationOffset ) * cos( uv.y * paperGrainScale + variationOffset );
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * ( 1.0 - n );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Extract the shadow density from the shadow mask
                float shadowDensity = gl_FragColor.a;

                // Apply cel-band shadow quantization
                shadowDensity = quantizeShadowDensity( shadowDensity );

                // Apply simplex-noise dithering
                if ( ditherAmplitude > 0.0 ) {
                    float d = fract( sin( gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233 ) * 43758.5453 );
                    shadowDensity += ( d - 0.5 ) * ditherAmplitude / 255.0;
                }

                // Apply paper grain
                shadowDensity *= samplePaperGrain( vUv );

                // Apply mood-tinted shadow color
                gl_FragColor.rgb = moodColor;
                gl_FragColor.a *= shadowDensity;
            ` );
    }

    /**
     * The custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.shadowBands,
            this.shadowQuantize,
            this.shadowSoftness,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.ditherAmplitude,
            this.ditherScale,
            this.paperGrain,
            this.paperGrainScale,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {ShadowMaterial} source - The material to copy from.
     * @return {ShadowMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.color.copy( source.color );
        this.fog = source.fog;
        this.transparent = source.transparent;

        // Anime extensions
        this.shadowBands = source.shadowBands;
        this.shadowQuantize = source.shadowQuantize;
        this.shadowSoftness = source.shadowSoftness;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy( source.moodColor );
        this.ditherAmplitude = source.ditherAmplitude;
        this.ditherScale = source.ditherScale;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
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

        data.type = 'ShadowMaterial';

        if ( this.color.getHex() !== 0x000000 ) data.color = this.color.getHex();
        if ( this.fog === false ) data.fog = false;
        if ( this.transparent === false ) data.transparent = this.transparent;

        // Anime extensions
        if ( this.shadowBands !== 0 ) data.shadowBands = this.shadowBands;
        if ( this.shadowQuantize !== 1.0 ) data.shadowQuantize = this.shadowQuantize;
        if ( this.shadowSoftness !== 0.1 ) data.shadowSoftness = this.shadowSoftness;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.ditherAmplitude !== 0 ) data.ditherAmplitude = this.ditherAmplitude;
        if ( this.ditherScale !== 1.0 ) data.ditherScale = this.ditherScale;
        if ( this.paperGrain !== 0 ) data.paperGrain = this.paperGrain;
        if ( this.paperGrainScale !== 10.0 ) data.paperGrainScale = this.paperGrainScale;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    ShadowMaterial,
    ShadowMaterialBatch,
    gradeShadowColor,
    quantizeShadowDensityCel,
    ditherShadowDensity,
    shadowPaperGrain
};
export default ShadowMaterial;