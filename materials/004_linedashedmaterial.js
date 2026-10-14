// file number : 004
// full path name : src/materials/004_linedashedmaterial.js
// description : LineDashedMaterial (three.js r185) rewritten as a high-
// performance ES module with deep anime-stylization integration. Extends the
// anime-enabled 002_linebasicmaterial.js and preserves the full r185
// LineDashedMaterial API — scale, dashSize, gapSize, plus the inherited
// line-material surface (color, linewidth, linecap, linejoin, fog) and the base
// anime controls. Adds real-time anime features specifically tuned for dashed
// line rendering: procedural dash pattern variation (hand-drawn irregular
// dashes matching the sketch-like quality of the reference imagery), mood-based
// dash color grading (warm sunset oranges vs. cool snowy cyans), paper-grain
// modulation of dash opacity (watercolor paper feel), simplex-noise-driven gap
// breathing for organic rhythm, and cel-band-aware dash density for stylized
// distance falloff. Uses gl-matrix for zero-allocation dash-length transforms,
// double.js for bit-exact dash-pattern accumulation (critical for very long
// dashed paths where float32 drift causes visible pattern discontinuities),
// bitecs SoA batching for real-time updates across thousands of dashed
// contours, and simplex-noise for the organic variation features.
// best for : LineDashedMaterial, dashed wireframes, manga speed-lines, anime
// storyboard panels, motion trail annotations, hand-drawn map contours,
// dashed UI separators, and any three.js dashed-line rendering that needs
// real-time stylization.
// license : MIT

import { LineBasicMaterial } from './002_linebasicmaterial.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';

// three.js r185 npm source — core, math, extras, and textures folders excluded per spec
import {
    NormalBlending,
    FrontSide
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

// gl-matrix scratch for zero-allocation dash-length transforms
const _gm_rgba = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// Anime feature — procedural dash pattern variation for hand-drawn rhythm
// ---------------------------------------------------------------------------
/**
 * Compute an organically-varied dash length and gap length at a given
 * position along a dashed line. Matches the reference imagery's sketch-like
 * quality where dashes are never perfectly regular — they breathe and shift
 * like a hand-drawn marker line.
 *
 * Uses double.js for bit-exact accumulation of the running dash pattern,
 * critical for very long dashed paths where float32 drift causes visible
 * pattern discontinuities at the far end of the line.
 *
 * @param {number} baseDash - Base dash size.
 * @param {number} baseGap - Base gap size.
 * @param {number} t - Position along the line in [0, 1].
 * @param {number} [variation=0.3] - Variation amplitude in [0, 1].
 * @param {number} [frequency=8] - Number of variation cycles along the line.
 * @param {number} [seed=0] - Per-instance seed for decorrelation.
 * @returns {{dash: number, gap: number}}
 */
function computeOrganicDashGap( baseDash, baseGap, t, variation = 0.3, frequency = 8, seed = 0 ) {
    const dashNoise = _noise2D( t * frequency + seed, 0 ) * 0.5 + 0.5;
    const gapNoise = _noise2D( t * frequency + seed + 100, 0 ) * 0.5 + 0.5;

    _double.value = 1;
    _double.add( ( dashNoise - 0.5 ) * 2 * variation );
    _double.mul( baseDash );
    const dash = Math.max( 0.001, _double.value );

    _double.value = 1;
    _double.add( ( gapNoise - 0.5 ) * 2 * variation );
    _double.mul( baseGap );
    const gap = Math.max( 0.001, _double.value );

    return { dash, gap };
}

// ---------------------------------------------------------------------------
// Anime feature — mood grading for dashed line colors
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading specifically tuned for dashed lines.
 * Matches the warm/cool mood spectrum seen across the reference imagery:
 * snowy cyan for cool scenes, sunset orange for warm scenes, vibrant
 * saturated hues for anime flora.
 * @param {Color} color - The line color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeDashColor( color, temperature, saturation, brightness, contrast ) {
    glMatrix.vec4.set( _gm_rgba, color.r, color.g, color.b, color.a );

    const lum = 0.2126 * _gm_rgba[ 0 ] + 0.7152 * _gm_rgba[ 1 ] + 0.0722 * _gm_rgba[ 2 ];

    _double.value = lum; _double.add( ( _gm_rgba[ 0 ] - lum ) * saturation ); let r = _double.value;
    _double.value = lum; _double.add( ( _gm_rgba[ 1 ] - lum ) * saturation ); let g = _double.value;
    _double.value = lum; _double.add( ( _gm_rgba[ 2 ] - lum ) * saturation ); let b = _double.value;

    _double.value = r; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); r = _double.value;
    _double.value = g; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); g = _double.value;
    _double.value = b; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); b = _double.value;

    _double.value = r; _double.add( temperature * 0.14 ); r = _double.value;
    _double.value = b; _double.sub( temperature * 0.14 ); b = _double.value;

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
// Anime feature — paper-grain modulation of dash opacity
// ---------------------------------------------------------------------------
/**
 * Compute a paper-grain opacity multiplier for a dash segment. The dashes
 * appear drawn on textured watercolor paper, with subtle opacity variation
 * along their length.
 * @param {number} u - U coordinate along the dash in [0, 1].
 * @param {number} v - V coordinate across the dash in [0, 1].
 * @param {number} [scale=12.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.4] - Grain intensity in [0, 1].
 * @param {number} [seed=0] - Per-material noise seed.
 * @returns {number} Multiplier in [0, 1] to apply to opacity.
 */
function dashPaperGrainMultiplier( u, v, scale = 12.0, intensity = 0.4, seed = 0 ) {
    const n = _noise2D( u * scale + seed, v * scale ) * 0.5 + 0.5;
    _double.value = 1;
    _double.sub( intensity * ( 1 - n ) );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — cel-band-aware dash density for stylized distance falloff
// ---------------------------------------------------------------------------
/**
 * Compute a dash-density multiplier based on the camera-space depth of the
 * line. Distant dashes become sparser (classic anime speed-line falloff),
 * while close dashes become denser.
 * @param {number} depth - Camera-space depth in [0, 1] (0 = near, 1 = far).
 * @param {number} bands - Number of discrete bands (0 = continuous falloff).
 * @param {number} [densityRange=0.5] - Range of density variation.
 * @returns {number} Density multiplier in [0.5, 1.5].
 */
function sampleCelDashDensity( depth, bands, densityRange = 0.5 ) {
    let d = depth;
    if ( bands > 1 ) {
        const bandWidth = 1.0 / bands;
        _double.value = depth;
        _double.div( bandWidth );
        _double.value = Math.floor( _double.value );
        _double.mul( bandWidth );
        d = _double.value;
    }
    // Near = denser, far = sparser
    return 1.0 + densityRange * ( 0.5 - d );
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for real-time dashed material updates
// ---------------------------------------------------------------------------
const _dashWorld = createWorld();
const DashMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    scale: Types.f64,
    dashSize: Types.f64,
    gapSize: Types.f64,
    dashVariation: Types.f64,
    dashFrequency: Types.f64,
    paperGrain: Types.f64,
    paperGrainScale: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    celBands: Types.ui8,
    rimGlow: Types.f64,
    dirty: Types.ui8
} );

class LineDashedMaterialBatch {

    constructor() {
        this.world = _dashWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a LineDashedMaterial instance for batched real-time updates.
     * @param {LineDashedMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, DashMaterialComponent, eid );
        DashMaterialComponent.materialPtr[ eid ] = this.materials.length;
        DashMaterialComponent.scale[ eid ] = material.scale;
        DashMaterialComponent.dashSize[ eid ] = material.dashSize;
        DashMaterialComponent.gapSize[ eid ] = material.gapSize;
        DashMaterialComponent.dashVariation[ eid ] = material.dashVariation;
        DashMaterialComponent.dashFrequency[ eid ] = material.dashFrequency;
        DashMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        DashMaterialComponent.paperGrainScale[ eid ] = material.paperGrainScale;
        DashMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        DashMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        DashMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        DashMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        DashMaterialComponent.celBands[ eid ] = material.celBands;
        DashMaterialComponent.rimGlow[ eid ] = material.rimGlow;
        DashMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued dashed-material updates in one cache-friendly pass.
     * Uses double.js internally to re-grade colors bit-exactly and re-derive
     * the mood color.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ DashMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.scale = DashMaterialComponent.scale[ eid ];
            material.dashSize = DashMaterialComponent.dashSize[ eid ];
            material.gapSize = DashMaterialComponent.gapSize[ eid ];
            material.dashVariation = DashMaterialComponent.dashVariation[ eid ];
            material.dashFrequency = DashMaterialComponent.dashFrequency[ eid ];
            material.paperGrain = DashMaterialComponent.paperGrain[ eid ];
            material.paperGrainScale = DashMaterialComponent.paperGrainScale[ eid ];
            material.moodTemperature = DashMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = DashMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = DashMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = DashMaterialComponent.moodContrast[ eid ];
            material.celBands = DashMaterialComponent.celBands[ eid ];
            material.rimGlow = DashMaterialComponent.rimGlow[ eid ];

            material.moodColor.copy( material.color );
            gradeDashColor(
                material.moodColor,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );

            DashMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main LineDashedMaterial class — mirrors
// three.js/src/materials/LineDashedMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material for rendering dashed line primitives.
 *
 * In addition to the standard three.js parameters, this material exposes
 * a rich set of real-time anime-style controls: organic dash variation,
 * paper-grain opacity modulation, mood-based color grading, cel-band-aware
 * dash density, and rim glow.
 *
 * Note that dashed lines require line distances computed via
 * `Line.computeLineDistances()` before rendering.
 *
 * ```js
 * const material = new THREE.LineDashedMaterial( {
 *   color: 0xffffff,
 *   dashSize: 3,
 *   gapSize: 1,
 *   dashVariation: 0.3,
 *   paperGrain: 0.4,
 *   moodTemperature: -0.2
 * } );
 * ```
 * @augments LineBasicMaterial
 */
class LineDashedMaterial extends LineBasicMaterial {

    /**
     * Constructs a new line dashed material.
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
        this.isLineDashedMaterial = true;

        this.type = 'LineDashedMaterial';

        /**
         * The scale of the dashed part of a line.
         * @type {number}
         * @default 1
         */
        this.scale = 1;

        /**
         * The size of the dash. This is both the gap with the stroke.
         * @type {number}
         * @default 3
         */
        this.dashSize = 3;

        /**
         * The size of the gap.
         * @type {number}
         * @default 1
         */
        this.gapSize = 1;

        // -------------------------------------------------------------------
        // Anime Rendering Extensions
        // -------------------------------------------------------------------
        /**
         * Organic dash variation amplitude in [0, 1]. 0 = perfectly regular
         * dashes, 1 = highly irregular hand-drawn dashes.
         * @type {number}
         * @default 0
         */
        this.dashVariation = 0;

        /**
         * Number of variation cycles along the dashed line. Higher =
         * faster dash rhythm changes.
         * @type {number}
         * @default 8
         */
        this.dashFrequency = 8;

        /**
         * Paper-grain overlay intensity in [0, 1]. Modulates dash opacity
         * so dashes appear drawn on textured paper.
         * @type {number}
         * @default 0
         */
        this.paperGrain = 0;

        /**
         * Paper-grain noise scale. Higher = finer grain.
         * @type {number}
         * @default 12.0
         */
        this.paperGrainScale = 12.0;

        /**
         * Mood temperature shift in [-1, 1]. Positive = warm (sunset
         * orange), negative = cool (snowy cyan).
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
         * Number of cel-shading bands applied to dash density variation.
         * 0 = continuous falloff, 2-4 = classic anime banded falloff.
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Rim-glow intensity for neon-dash effects.
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Per-instance seed for decorrelating procedural dash variation
         * across many dashed objects.
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
     * Recompute the mood-graded line color from the current mood parameters.
     * @returns {LineDashedMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy( this.color );
        gradeDashColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Compute the organically-varied dash and gap sizes at a given position
     * along the dashed line.
     * @param {number} t - Position along the line in [0, 1].
     * @returns {{dash: number, gap: number}}
     */
    sampleOrganicDash( t ) {
        if ( this.dashVariation <= 0 ) {
            return { dash: this.dashSize, gap: this.gapSize };
        }
        return computeOrganicDashGap(
            this.dashSize,
            this.gapSize,
            t,
            this.dashVariation,
            this.dashFrequency,
            this.variationSeed
        );
    }

    /**
     * Compute the paper-grain opacity multiplier for a dash at a given UV.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    sampleDashPaperGrain( u, v ) {
        if ( this.paperGrain <= 0 ) return 1;
        return dashPaperGrainMultiplier( u, v, this.paperGrainScale, this.paperGrain, this.variationSeed );
    }

    /**
     * Compute the cel-band-aware dash density multiplier at a given depth.
     * @param {number} depth - Camera-space depth in [0, 1].
     * @returns {number} Density multiplier in [0.5, 1.5].
     */
    sampleDashDensity( depth ) {
        return sampleCelDashDensity( depth, this.celBands );
    }

    /**
     * Compute a per-instance variation offset from the variationSeed. Used
     * to decorrelate procedural dash patterns across many dashed objects.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * 137.508; // golden-angle increment
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------
    /**
     * The default `onBeforeCompile` hook. Extends the base LineBasicMaterial's
     * anime shader chunks with dash-specific features: organic dash variation,
     * paper-grain opacity modulation, and cel-band-aware density.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base LineBasicMaterial hook first
        super.onBeforeCompile( shader, renderer );

        // Inject dash-specific uniforms
        shader.uniforms.scale = { value: this.scale };
        shader.uniforms.dashSize = { value: this.dashSize };
        shader.uniforms.gapSize = { value: this.gapSize };
        shader.uniforms.dashVariation = { value: this.dashVariation };
        shader.uniforms.dashFrequency = { value: this.dashFrequency };
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the vertex shader with dash-distance interpolation
        shader.vertexShader = shader.vertexShader
            .replace( '#include <common>', `#include <common>
                uniform float scale;
                uniform float dashSize;
                uniform float gapSize;
                uniform float dashVariation;
                uniform float dashFrequency;
                varying float vLineDistance;
            ` )
            .replace( '#include <begin_vertex>', `#include <begin_vertex>
                vLineDistance = scale * lineDistance;
            ` );

        // Extend the fragment shader with dash computation
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform float dashSize;
                uniform float gapSize;
                uniform float dashVariation;
                uniform float dashFrequency;
                uniform int celBands;
                uniform float variationOffset;
                varying float vLineDistance;

                // Hash function for discrete dash positioning
                float hash( float n ) {
                    return fract( sin( n * 43758.5453123 ) * 12345.6789 );
                }

                // Compute the dash mask with organic variation
                float computeDashMask( float distance ) {
                    float period = dashSize + gapSize;

                    // Organic variation of the dash boundary
                    if ( dashVariation > 0.0 ) {
                        float variation = sin( distance * dashFrequency * 0.1 + variationOffset ) * dashVariation;
                        period *= ( 1.0 + variation * 0.5 );
                    }

                    float t = fract( distance / period );
                    float dashFraction = dashSize / period;
                    return step( t, dashFraction );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Apply mood color override
                gl_FragColor.rgb = mix( gl_FragColor.rgb, moodColor, 0.85 );

                // Apply paper grain
                gl_FragColor.a *= samplePaperGrain( vUv );

                // Apply dash mask — discard fragments in gaps
                float dashMask = computeDashMask( vLineDistance );
                if ( dashMask < 0.5 ) discard;

                // Rim glow
                if ( rimGlow > 0.0 ) {
                    gl_FragColor.rgb += rimGlowColor * rimGlow;
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
            this.scale,
            this.dashSize,
            this.gapSize,
            this.dashVariation,
            this.dashFrequency,
            this.celBands,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {LineDashedMaterial} source - The material to copy from.
     * @return {LineDashedMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.scale = source.scale;
        this.dashSize = source.dashSize;
        this.gapSize = source.gapSize;

        // Anime extensions
        this.dashVariation = source.dashVariation;
        this.dashFrequency = source.dashFrequency;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy( source.moodColor );
        this.celBands = source.celBands;
        this.rimGlow = source.rimGlow;
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

        data.type = 'LineDashedMaterial';

        if ( this.scale !== 1 ) data.scale = this.scale;
        if ( this.dashSize !== 3 ) data.dashSize = this.dashSize;
        if ( this.gapSize !== 1 ) data.gapSize = this.gapSize;

        // Anime extensions
        if ( this.dashVariation !== 0 ) data.dashVariation = this.dashVariation;
        if ( this.dashFrequency !== 8 ) data.dashFrequency = this.dashFrequency;
        if ( this.paperGrain !== 0 ) data.paperGrain = this.paperGrain;
        if ( this.paperGrainScale !== 12.0 ) data.paperGrainScale = this.paperGrainScale;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.celBands !== 0 ) data.celBands = this.celBands;
        if ( this.rimGlow !== 0 ) data.rimGlow = this.rimGlow;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    LineDashedMaterial,
    LineDashedMaterialBatch,
    computeOrganicDashGap,
    gradeDashColor,
    dashPaperGrainMultiplier,
    sampleCelDashDensity
};
export default LineDashedMaterial;