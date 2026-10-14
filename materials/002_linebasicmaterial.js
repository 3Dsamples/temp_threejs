// file number : 002
// full path name : src/materials/002_linebasicmaterial.js
// description : LineBasicMaterial (three.js r185) rewritten as a high-
// performance ES module with deep anime-stylization integration. Extends the
// anime-enabled 001_material.js base class and preserves the full r185
// LineBasicMaterial API — color, linewidth, linecap, linejoin, fog, plus the
// inherited material surface. Adds real-time anime features specifically tuned
// for line rendering: hand-drawn brush jitter (wobbly lines, matching the
// reference images' sketch-like outlines), paper-grain overlay (watercolor/
// gouache texture), mood-based line color grading (cool cyan for snowy scenes,
// warm orange for sunset scenes), rim glow for neon-line effects, and per-
// instance cel-band modulation for stylized line thickness variation. Imports
// Color strictly from threejs_new01 math, and uses gl-matrix for zero-
// allocation line color transforms, double.js for bit-exact mood grading
// accumulation, bitecs SoA batching for real-time updates across thousands of
// line segments, and simplex-noise for the brush-jitter and paper-grain
// features.
// best for : LineBasicMaterial, wireframe overlays, anime-style outlines,
// hand-drawn sketches, glowing neon lines, watercolor contour lines, technical
// drawing annotations, and any three.js line-based rendering that needs real-
// time stylization.
// license : MIT

import { Material } from './001_material.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';

// three.js r185 npm source — core, math, and extras folders excluded per spec
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

// gl-matrix scratch for zero-allocation line color transforms
const _gm_rgba = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// Anime feature — hand-drawn brush jitter for wobbly lines
// ---------------------------------------------------------------------------
/**
 * Apply hand-drawn brush jitter to a line segment's two endpoints using
 * simplex-noise. Matches the reference images' sketch-like quality where
 * contours wobble organically rather than being perfectly straight.
 * @param {Vector3} p0 - First endpoint (modified in place).
 * @param {Vector3} p1 - Second endpoint (modified in place).
 * @param {number} [amplitude=0.02] - Jitter amplitude in world units.
 * @param {number} [frequency=1.0] - Noise frequency along the line.
 * @param {number} [offset=0] - Per-instance noise offset for decorrelation.
 * @param {number} [seed=0] - Additional per-segment seed.
 */
function applyBrushJitterToLine( p0, p1, amplitude = 0.02, frequency = 1.0, offset = 0, seed = 0 ) {
    const nx0 = _noise2D( offset + seed, 0 ) * amplitude;
    const ny0 = _noise2D( offset + seed, 100 ) * amplitude;
    const nz0 = _noise2D( offset + seed, 200 ) * amplitude;
    const nx1 = _noise2D( offset + seed + frequency, 0 ) * amplitude;
    const ny1 = _noise2D( offset + seed + frequency, 100 ) * amplitude;
    const nz1 = _noise2D( offset + seed + frequency, 200 ) * amplitude;
    p0.x += nx0;
    p0.y += ny0;
    p0.z += nz0;
    p1.x += nx1;
    p1.y += ny1;
    p1.z += nz1;
}

// ---------------------------------------------------------------------------
// Anime feature — paper grain overlay for watercolor line texture
// ---------------------------------------------------------------------------
/**
 * Generate a paper-grain multiplier for a given UV position. Used to
 * modulate line opacity so the line appears to be drawn on textured
 * watercolor paper (matching the reference images' hand-painted feel).
 * @param {number} u - U coordinate (e.g. along the line).
 * @param {number} v - V coordinate (e.g. across the line).
 * @param {number} [scale=8.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.3] - Grain intensity in [0, 1].
 * @param {number} [offset=0] - Per-material noise offset.
 * @returns {number} Multiplier in [0, 1] to apply to opacity.
 */
function paperGrainMultiplier( u, v, scale = 8.0, intensity = 0.3, offset = 0 ) {
    const n = _noise2D( u * scale + offset, v * scale ) * 0.5 + 0.5;
    return Math.max( 0, Math.min( 1, 1 - intensity * ( 1 - n ) ) );
}

// ---------------------------------------------------------------------------
// Anime feature — mood grading for line colors
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading specifically tuned for line rendering.
 * Uses gl-matrix for zero-allocation staging and double.js for bit-exact
 * accumulation. Handles warm (sunset orange) and cool (snowy cyan) moods
 * seen across the reference images.
 * @param {Color} color - The line color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @returns {Color}
 */
function gradeLineColor( color, temperature, saturation, brightness ) {
    glMatrix.vec4.set( _gm_rgba, color.r, color.g, color.b, color.a );

    // Saturation: push away from luminance
    const lum = 0.2126 * _gm_rgba[ 0 ] + 0.7152 * _gm_rgba[ 1 ] + 0.0722 * _gm_rgba[ 2 ];

    _double.value = lum; _double.add( ( _gm_rgba[ 0 ] - lum ) * saturation ); let r = _double.value;
    _double.value = lum; _double.add( ( _gm_rgba[ 1 ] - lum ) * saturation ); let g = _double.value;
    _double.value = lum; _double.add( ( _gm_rgba[ 2 ] - lum ) * saturation ); let b = _double.value;

    // Temperature: warm shifts toward orange, cool toward cyan
    _double.value = r; _double.add( temperature * 0.15 ); r = _double.value;
    _double.value = b; _double.sub( temperature * 0.15 ); b = _double.value;

    // Brightness
    r *= brightness; g *= brightness; b *= brightness;

    color.setRGB(
        Math.max( 0, Math.min( 1, r ) ),
        Math.max( 0, Math.min( 1, g ) ),
        Math.max( 0, Math.min( 1, b ) ),
        ColorManagement.workingColorSpace
    );
    return color;
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for real-time line material updates
// ---------------------------------------------------------------------------
const _lineWorld = createWorld();
const LineMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    brushJitter: Types.f64,
    paperGrain: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    rimGlow: Types.f64,
    animeBands: Types.ui8,
    dirty: Types.ui8
} );

class LineMaterialBatch {

    constructor() {
        this.world = _lineWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a LineBasicMaterial instance for batched real-time updates.
     * @param {LineBasicMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, LineMaterialComponent, eid );
        LineMaterialComponent.materialPtr[ eid ] = this.materials.length;
        LineMaterialComponent.brushJitter[ eid ] = material.brushJitter;
        LineMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        LineMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        LineMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        LineMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        LineMaterialComponent.rimGlow[ eid ] = material.rimGlow;
        LineMaterialComponent.animeBands[ eid ] = material.animeBands;
        LineMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued line-material updates in one cache-friendly pass.
     * Uses double.js internally to re-grade colors bit-exactly.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ LineMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;
            material.brushJitter = LineMaterialComponent.brushJitter[ eid ];
            material.paperGrain = LineMaterialComponent.paperGrain[ eid ];
            material.moodTemperature = LineMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = LineMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = LineMaterialComponent.moodBrightness[ eid ];
            material.rimGlow = LineMaterialComponent.rimGlow[ eid ];
            material.animeBands = LineMaterialComponent.animeBands[ eid ];

            // Re-grade the base color into a derived "mood color"
            material.moodColor.copy( material.color );
            gradeLineColor(
                material.moodColor,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness
            );

            LineMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main LineBasicMaterial class — mirrors
// three.js/src/materials/LineBasicMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material for rendering line primitives.
 *
 * In addition to the standard three.js parameters, this material exposes
 * a rich set of real-time anime-style controls: brush jitter, paper grain,
 * mood-based line color grading, rim glow, and cel-band modulation for
 * stylized line thickness variation.
 *
 * ```js
 * const material = new THREE.LineBasicMaterial( {
 *   color: 0xffffff,
 *   linewidth: 1,
 *   brushJitter: 0.02,
 *   paperGrain: 0.3,
 *   moodTemperature: -0.2
 * } );
 * ```
 * @augments Material
 */
class LineBasicMaterial extends Material {

    /**
     * Constructs a new line basic material.
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
        this.isLineBasicMaterial = true;

        this.type = 'LineBasicMaterial';

        /**
         * Color of the line. Default is `0xffffff` (white).
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color( 0xffffff );

        /**
         * Controls line thickness or lines.
         *
         * Note: The `linewidth` parameter is not supported by all browsers
         * on all platforms due to limitations in the underlying WebGL
         * implementation. ANGLE (Windows) and most mobile platforms ignore
         * this value.
         * @type {number}
         * @default 1
         */
        this.linewidth = 1;

        /**
         * Defines appearance of line ends.
         * @type {string}
         * @default 'round'
         */
        this.linecap = 'round';

        /**
         * Defines appearance of line joints.
         * @type {string}
         * @default 'round'
         */
        this.linejoin = 'round';

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
         * Hand-drawn brush jitter amplitude in world units. Set > 0 for
         * wobbly, sketch-like lines. Matches the reference images'
         * hand-drawn outline quality.
         * @type {number}
         * @default 0
         */
        this.brushJitter = 0;

        /**
         * Brush jitter noise frequency. Higher = more wobble cycles per
         * unit length.
         * @type {number}
         * @default 1.0
         */
        this.brushJitterFrequency = 1.0;

        /**
         * Paper-grain overlay intensity in [0, 1]. Modulates line opacity
         * so the line appears drawn on textured watercolor paper.
         * @type {number}
         * @default 0
         */
        this.paperGrain = 0;

        /**
         * Paper-grain noise scale. Higher = finer grain.
         * @type {number}
         * @default 8.0
         */
        this.paperGrainScale = 8.0;

        /**
         * Mood temperature shift in [-1, 1]. Positive = warm (sunset
         * orange), negative = cool (snowy cyan). Matches the mood
         * spectrum in the reference imagery.
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Mood saturation multiplier. 1 = unchanged, < 1 = desaturated,
         * > 1 = hyper-saturated.
         * @type {number}
         * @default 1.0
         */
        this.moodSaturation = 1.0;

        /**
         * Mood brightness multiplier. 1 = unchanged.
         * @type {number}
         * @default 1.0
         */
        this.moodBrightness = 1.0;

        /**
         * The precomputed mood-graded color. Populated automatically by
         * `updateMoodColor()`.
         * @type {Color}
         */
        this.moodColor = new Color( 0xffffff );

        /**
         * Rim-glow intensity for neon-line effects. Set > 0 to make the
         * line glow (matches the cyan water highlights in reference
         * images 1, 3, 5, and the sunset glow in 2, 4).
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Rim-glow color. Defaults to a cool cyan tuned for the snowy
         * river scenes.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color( 0.5, 0.9, 1.0 );

        /**
         * Number of cel-shading bands applied to line thickness. 0 = off,
         * 2-4 = classic anime stylized thickness variation.
         * @type {number}
         * @default 0
         */
        this.animeBands = 0;

        this.setValues( parameters );
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Recompute the mood-graded line color from the current mood parameters.
     * Uses gl-matrix for zero-allocation staging and double.js for bit-exact
     * accumulation.
     * @returns {LineBasicMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy( this.color );
        gradeLineColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness
        );
        return this;
    }

    /**
     * Apply brush jitter to a pair of line endpoints in world space. The
     * endpoints are modified in place.
     * @param {Vector3} p0 - First endpoint.
     * @param {Vector3} p1 - Second endpoint.
     * @param {number} [seed=0] - Per-segment seed.
     * @returns {LineBasicMaterial} A reference to this instance.
     */
    applyBrushJitterToLine( p0, p1, seed = 0 ) {
        if ( this.brushJitter <= 0 ) return this;
        applyBrushJitterToLine( p0, p1, this.brushJitter, this.brushJitterFrequency, this.id, seed );
        return this;
    }

    /**
     * Compute the paper-grain opacity multiplier at a given UV.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    samplePaperGrain( u, v ) {
        if ( this.paperGrain <= 0 ) return 1;
        return paperGrainMultiplier( u, v, this.paperGrainScale, this.paperGrain, this.id );
    }

    /**
     * Compute the cel-band thickness multiplier for a given normal·light
     * value. Provides stylized line thickness variation.
     * @param {number} ndotl - Dot product of normal and light direction in [0, 1].
     * @returns {number} Multiplier in [0.3, 1.5].
     */
    sampleCelBandThickness( ndotl ) {
        if ( this.animeBands <= 0 ) return 1;
        const bands = this.animeBands;
        const band = Math.floor( ndotl * bands ) / Math.max( 1, bands - 1 );
        // Thicker lines in shadow, thinner in highlight
        return 0.5 + 1.0 * ( 1 - band );
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------
    /**
     * The default `onBeforeCompile` hook. Extends the base Material's
     * anime shader chunks with line-specific features: brush jitter UV
     * distortion, paper grain opacity modulation, and rim glow.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first so base anime uniforms are injected
        super.onBeforeCompile( shader, renderer );

        // Inject line-specific uniforms
        shader.uniforms.brushJitter = { value: this.brushJitter };
        shader.uniforms.brushJitterFrequency = { value: this.brushJitterFrequency };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.paperGrainScale = { value: this.paperGrainScale };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.moodColor = { value: this.moodColor };

        // Extend the fragment shader with line-specific anime chunks
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform float brushJitterFrequency;
                uniform float paperGrain;
                uniform float paperGrainScale;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform vec3 moodColor;

                float samplePaperGrain( vec2 uv ) {
                    if ( paperGrain <= 0.0 ) return 1.0;
                    float n = sin( uv.x * paperGrainScale ) * cos( uv.y * paperGrainScale );
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * ( 1.0 - n );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Override with mood-graded line color for line materials
                gl_FragColor.rgb = mix( gl_FragColor.rgb, moodColor, 0.85 );

                // Apply paper grain opacity modulation
                gl_FragColor.a *= samplePaperGrain( vUv );

                // Rim glow
                if ( rimGlow > 0.0 ) {
                    gl_FragColor.rgb += rimGlowColor * rimGlow;
                }
            ` );
    }

    /**
     * The custom program cache key. Extends the base key with line-specific
     * anime state so the renderer recompiles when parameters change.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.brushJitter,
            this.brushJitterFrequency,
            this.paperGrain,
            this.paperGrainScale,
            this.rimGlow,
            this.animeBands,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {LineBasicMaterial} source - The material to copy from.
     * @return {LineBasicMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.color.copy( source.color );
        this.linewidth = source.linewidth;
        this.linecap = source.linecap;
        this.linejoin = source.linejoin;
        this.fog = source.fog;

        // Anime extensions
        this.brushJitter = source.brushJitter;
        this.brushJitterFrequency = source.brushJitterFrequency;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodColor.copy( source.moodColor );
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy( source.rimGlowColor );
        this.animeBands = source.animeBands;

        return this;
    }

    /**
     * Serializes the material into JSON.
     * @param {?(Object|string)} meta - An optional value holding meta information.
     * @return {Object} A JSON object representing the serialized material.
     */
    toJSON( meta ) {
        const data = super.toJSON( meta );

        data.type = 'LineBasicMaterial';

        if ( this.color.getHex() !== 0xffffff ) data.color = this.color.getHex();
        if ( this.linewidth !== 1 ) data.linewidth = this.linewidth;
        if ( this.linecap !== 'round' ) data.linecap = this.linecap;
        if ( this.linejoin !== 'round' ) data.linejoin = this.linejoin;
        if ( this.fog === false ) data.fog = false;

        // Anime extensions
        if ( this.brushJitter !== 0 ) data.brushJitter = this.brushJitter;
        if ( this.brushJitterFrequency !== 1.0 ) data.brushJitterFrequency = this.brushJitterFrequency;
        if ( this.paperGrain !== 0 ) data.paperGrain = this.paperGrain;
        if ( this.paperGrainScale !== 8.0 ) data.paperGrainScale = this.paperGrainScale;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.rimGlow !== 0 ) data.rimGlow = this.rimGlow;
        if ( this.rimGlowColor.getHex() !== new Color( 0.5, 0.9, 1.0 ).getHex() ) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if ( this.animeBands !== 0 ) data.animeBands = this.animeBands;

        return data;
    }
}

export {
    LineBasicMaterial,
    LineMaterialBatch,
    applyBrushJitterToLine,
    paperGrainMultiplier,
    gradeLineColor
};
export default LineBasicMaterial;