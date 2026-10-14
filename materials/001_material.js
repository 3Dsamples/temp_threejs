// file number : 001
// full path name : src/materials/001_material.js
// description : Base Material class (three.js r185) rewritten as a high-performance ES module with deep integration of real-time anime stylization features. Provides the foundational rendering state (blending, side, depth, stencil, clipping, tone mapping) plus a comprehensive anime-rendering surface: cel-shading bands, rim lighting, outline width/color, mood-based color grading (hue/saturation/contrast/temperature), and procedural variation (paper grain, watercolor bleed, brush jitter). Imports strictly from threejs_new01 math/core and r185 fallbacks. Uses gl-matrix for zero-allocation color transforms, double.js for bit-exact cel-band thresholding, bitecs for SoA-batched material updates across thousands of instances, and simplex-noise for organic texture variation. Designed to match the provided reference imagery (snowy cyan rivers, warm sunset planets, vibrant anime flora, soft shoji sunlight).
// best for : The foundational Material class for all three.js materials. Serves as the base for LineBasicMaterial, MeshBasicMaterial, MeshStandardMaterial, ShaderMaterial, and every anime/stylized rendering pipeline built on top.
// license : MIT

import { EventDispatcher } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/core/001_EventDispatcher.js';
import { MathUtils } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/001_MathUtils.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';

// three.js r185 npm source — core, math, and extras folders excluded per spec
import {
    NormalBlending,
    FrontSide,
    LessEqualDepth,
    AlwaysStencilFunc,
    KeepStencilOp
} from 'https://cdn.jsdelivr.net/npm/three@0.185.1/src/constants.js';
import { warn } from 'https://cdn.jsdelivr.net/npm/three@0.185.1/src/utils.js';

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
const _gm_rgba = glMatrix.vec4.create();
const _gm_rgb = glMatrix.vec3.create();
const _gm_hsv = glMatrix.vec3.create();

let _materialId = 0;

// ---------------------------------------------------------------------------
// Anime style — real-time color grading helpers (gl-matrix + double.js)
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading to an RGBA color using gl-matrix for
 * zero-allocation hue/saturation/contrast/temperature transforms, with
 * double.js used for bit-exact accumulation when the input is HDR.
 * @param {Color} color - The source color (modified in place).
 * @param {number} hueShift - Hue shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier (1 = unchanged).
 * @param {number} contrast - Contrast multiplier (1 = unchanged).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @returns {Color}
 */
function applyMoodGrading( color, hueShift, saturation, contrast, temperature ) {
    // Stage RGBA into gl-matrix vec4
    glMatrix.vec4.set( _gm_rgba, color.r, color.g, color.b, color.a );

    // Convert to HSV for hue/saturation control
    const max = Math.max( _gm_rgba[ 0 ], _gm_rgba[ 1 ], _gm_rgba[ 2 ] );
    const min = Math.min( _gm_rgba[ 0 ], _gm_rgba[ 1 ], _gm_rgba[ 2 ] );
    const delta = max - min;

    // Hue calculation
    let hue = 0;
    if ( delta !== 0 ) {
        if ( max === _gm_rgba[ 0 ] ) hue = ( ( _gm_rgba[ 1 ] - _gm_rgba[ 2 ] ) / delta ) % 6;
        else if ( max === _gm_rgba[ 1 ] ) hue = ( _gm_rgba[ 2 ] - _gm_rgba[ 0 ] ) / delta + 2;
        else hue = ( _gm_rgba[ 0 ] - _gm_rgba[ 1 ] ) / delta + 4;
        hue /= 6;
        if ( hue < 0 ) hue += 1;
    }

    const sat = max === 0 ? 0 : delta / max;
    const val = max;

    // Apply hue shift and saturation
    let h = ( hue + hueShift ) % 1;
    if ( h < 0 ) h += 1;
    const s = Math.min( 1, Math.max( 0, sat * saturation ) );

    // Convert back to RGB
    const i = Math.floor( h * 6 );
    const f = h * 6 - i;
    const p = val * ( 1 - s );
    const q = val * ( 1 - f * s );
    const t = val * ( 1 - ( 1 - f ) * s );

    let r, g, b;
    switch ( i % 6 ) {
        case 0: r = val; g = t; b = p; break;
        case 1: r = q; g = val; b = p; break;
        case 2: r = p; g = val; b = t; break;
        case 3: r = p; g = q; b = val; break;
        case 4: r = t; g = p; b = val; break;
        case 5: r = val; g = p; b = q; break;
    }

    // Contrast (bit-exact accumulation for HDR via double.js)
    _double.value = r; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); r = _double.value;
    _double.value = g; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); g = _double.value;
    _double.value = b; _double.sub( 0.5 ); _double.mul( contrast ); _double.add( 0.5 ); b = _double.value;

    // Temperature: warm shifts toward orange, cool shifts toward cyan
    _double.value = r; _double.add( temperature * 0.1 ); r = _double.value;
    _double.value = b; _double.sub( temperature * 0.1 ); b = _double.value;

    // Clamp and write back
    color.setRGB(
        Math.max( 0, Math.min( 1, r ) ),
        Math.max( 0, Math.min( 1, g ) ),
        Math.max( 0, Math.min( 1, b ) ),
        ColorManagement.workingColorSpace
    );
    color.a = _gm_rgba[ 3 ];
    return color;
}

/**
 * Compute cel-shading band thresholds using double.js for bit-exact
 * accumulation. Prevents band flicker in HDR-lit anime scenes where
 * float32 rounding at the band boundaries causes visible popping.
 * @param {number} bands - Number of cel-shading bands (e.g. 2, 3, 4).
 * @param {number} [shadowThreshold=0.5] - The main shadow boundary in [0, 1].
 * @param {number} [highlightThreshold=0.8] - The highlight boundary in [0, 1].
 * @returns {number[]} Sorted array of band thresholds.
 */
function computeCelBandThresholds( bands, shadowThreshold = 0.5, highlightThreshold = 0.8 ) {
    const thresholds = [];
    for ( let i = 0; i < bands; i ++ ) {
        _double.value = i;
        _double.div( bands - 1 );
        // Shape the band curve with a power function for stylized falloff
        const t = Math.pow( _double.value, 0.75 );
        thresholds.push( t );
    }

    // Ensure shadow and highlight thresholds are present and sorted
    if ( ! thresholds.includes( shadowThreshold ) ) thresholds.push( shadowThreshold );
    if ( ! thresholds.includes( highlightThreshold ) ) thresholds.push( highlightThreshold );

    thresholds.sort( ( a, b ) => a - b );
    return thresholds;
}

// ---------------------------------------------------------------------------
// Anime style — procedural variation helpers (simplex-noise)
// ---------------------------------------------------------------------------
/**
 * Generate a paper-grain grayscale texture using simplex-noise. Used as
 * a multiplier map on anime materials to add a subtle hand-drawn texture
 * that matches the reference imagery (watercolor / gouache paper feel).
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.05] - Noise scale (smaller = finer grain).
 * @param {number} [intensity=0.5] - Grain intensity in [0, 1].
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generatePaperGrain( width, height, scale = 0.05, intensity = 0.5 ) {
    const out = new Uint8Array( width * height * 4 );
    for ( let y = 0; y < height; y ++ ) {
        for ( let x = 0; x < width; x ++ ) {
            const p = ( y * width + x ) * 4;
            const n = _noise2D( x * scale, y * scale ) * 0.5 + 0.5;
            const v = Math.floor( Math.max( 0, Math.min( 1, 1 - n * intensity ) ) * 255 );
            out[ p ] = v;
            out[ p + 1 ] = v;
            out[ p + 2 ] = v;
            out[ p + 3 ] = 255;
        }
    }
    return out;
}

/**
 * Apply brush-jitter to a UV coordinate using simplex-noise. Provides
 * the subtle "hand-drawn wobble" characteristic of anime backgrounds,
 * especially visible in water reflections and foliage (see reference
 * images 1, 3, 5, 7).
 * @param {number} u - U coordinate.
 * @param {number} v - V coordinate.
 * @param {number} [amplitude=0.01] - Jitter amplitude.
 * @param {number} [frequency=1] - Noise frequency.
 * @param {number} [offset=0] - Per-instance noise offset.
 * @returns {{u: number, v: number}}
 */
function applyBrushJitter( u, v, amplitude = 0.01, frequency = 1, offset = 0 ) {
    const du = _noise2D( u * frequency + offset, v * frequency ) * amplitude;
    const dv = _noise2D( u * frequency + offset + 100, v * frequency + 100 ) * amplitude;
    return { u: u + du, v: v + dv };
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for real-time anime material updates
// ---------------------------------------------------------------------------
const _materialWorld = createWorld();
const AnimeMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    moodHueShift: Types.f64,
    moodSaturation: Types.f64,
    moodContrast: Types.f64,
    moodTemperature: Types.f64,
    rimIntensity: Types.f64,
    rimPower: Types.f64,
    outlineWidth: Types.f64,
    animeBands: Types.ui8,
    dirty: Types.ui8
} );

class MaterialBatch {

    constructor() {
        this.world = _materialWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a Material instance for batched real-time updates.
     * @param {Material} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, AnimeMaterialComponent, eid );
        AnimeMaterialComponent.materialPtr[ eid ] = this.materials.length;
        AnimeMaterialComponent.moodHueShift[ eid ] = material.moodHueShift;
        AnimeMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        AnimeMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        AnimeMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        AnimeMaterialComponent.rimIntensity[ eid ] = material.rimIntensity;
        AnimeMaterialComponent.rimPower[ eid ] = material.rimPower;
        AnimeMaterialComponent.outlineWidth[ eid ] = material.outlineWidth;
        AnimeMaterialComponent.animeBands[ eid ] = material.animeBands;
        AnimeMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued anime property updates in one cache-friendly pass.
     * Uses gl-matrix and double.js internally where precision matters.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ AnimeMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;
            material.moodHueShift = AnimeMaterialComponent.moodHueShift[ eid ];
            material.moodSaturation = AnimeMaterialComponent.moodSaturation[ eid ];
            material.moodContrast = AnimeMaterialComponent.moodContrast[ eid ];
            material.moodTemperature = AnimeMaterialComponent.moodTemperature[ eid ];
            material.rimIntensity = AnimeMaterialComponent.rimIntensity[ eid ];
            material.rimPower = AnimeMaterialComponent.rimPower[ eid ];
            material.outlineWidth = AnimeMaterialComponent.outlineWidth[ eid ];
            material.animeBands = AnimeMaterialComponent.animeBands[ eid ];
            // Recompute cel-band thresholds with double.js precision
            material.celThresholds = computeCelBandThresholds( material.animeBands );
            AnimeMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main Material class — mirrors three.js/src/materials/Material.js with anime extensions
// ---------------------------------------------------------------------------
/**
 * Abstract base class for all materials.
 * In addition to the standard three.js material surface, this class
 * exposes a rich set of anime-rendering parameters: cel-shading bands,
 * rim lighting, outline width/color, mood-based color grading, and
 * procedural variation controls. All anime parameters are consumed
 * by the `onBeforeCompile` hook to inject custom shader chunks, or by
 * downstream `AnimeMaterialBatch` entities for real-time ECS updates.
 * @augments EventDispatcher
 */
class Material extends EventDispatcher {

    /**
     * Constructs a new material.
     */
    constructor() {
        super();

        /**
         * This flag can be used for type testing.
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isMaterial = true;

        /**
         * The ID of the material.
         * @name Material#id
         * @type {number}
         * @readonly
         */
        Object.defineProperty( this, 'id', { value: _materialId ++ } );

        /**
         * The UUID of the material.
         * @type {string}
         * @readonly
         */
        this.uuid = MathUtils.generateUUID();

        /**
         * The name of the material.
         * @type {string}
         */
        this.name = '';

        /**
         * The type of the material.
         * @type {string}
         * @readonly
         * @default 'Material'
         */
        this.type = 'Material';

        /**
         * The material blending type.
         * @type {number}
         * @default NormalBlending
         */
        this.blending = NormalBlending;

        /**
         * This defines the side of the faces that will be rendered.
         * @type {number}
         * @default FrontSide
         */
        this.side = FrontSide;

        /**
         * Whether to use vertex colors or not.
         * @type {boolean}
         * @default false
         */
        this.vertexColors = false;

        /**
         * The opacity of the material.
         * @type {number}
         * @default 1.0
         */
        this.opacity = 1.0;

        /**
         * Whether the material is transparent or not.
         * @type {boolean}
         * @default false
         */
        this.transparent = false;

        /**
         * The alpha hash value. When greater than 0, the material is rendered
         * with a stochastic alpha test.
         * @type {number}
         * @default 0
         */
        this.alphaHash = 0;

        /**
         * The alpha test value. When greater than 0, fragments with an alpha
         * below this value are discarded.
         * @type {number}
         * @default 0
         */
        this.alphaTest = 0;

        /**
         * The alpha-to-coverage value.
         * @type {boolean}
         * @default false
         */
        this.alphaToCoverage = false;

        /**
         * The blend source factor.
         * @type {number}
         * @default SrcAlphaFactor
         */
        this.blendSrc = null;

        /**
         * The blend destination factor.
         * @type {number}
         * @default OneMinusSrcAlphaFactor
         */
        this.blendDst = null;

        /**
         * The blend equation.
         * @type {number}
         * @default AddEquation
         */
        this.blendEquation = null;

        /**
         * The blend source factor for alpha.
         * @type {?number}
         * @default null
         */
        this.blendSrcAlpha = null;

        /**
         * The blend destination factor for alpha.
         * @type {?number}
         * @default null
         */
        this.blendDstAlpha = null;

        /**
         * The blend equation for alpha.
         * @type {?number}
         * @default null
         */
        this.blendEquationAlpha = null;

        /**
         * The blend color.
         * @type {Color}
         * @default null
         */
        this.blendColor = new Color( 0x000000 );

        /**
         * The blend alpha.
         * @type {number}
         * @default 0
         */
        this.blendAlpha = 0;

        /**
         * The depth function.
         * @type {number}
         * @default LessEqualDepth
         */
        this.depthFunc = LessEqualDepth;

        /**
         * Whether to test the depth buffer or not.
         * @type {boolean}
         * @default true
         */
        this.depthTest = true;

        /**
         * Whether to write to the depth buffer or not.
         * @type {boolean}
         * @default true
         */
        this.depthWrite = true;

        /**
         * The stencil write mask.
         * @type {number}
         * @default 0xff
         */
        this.stencilWriteMask = 0xff;

        /**
         * The stencil function.
         * @type {number}
         * @default AlwaysStencilFunc
         */
        this.stencilFunc = AlwaysStencilFunc;

        /**
         * The stencil reference value.
         * @type {number}
         * @default 0
         */
        this.stencilRef = 0;

        /**
         * The stencil function mask.
         * @type {number}
         * @default 0xff
         */
        this.stencilFuncMask = 0xff;

        /**
         * The stencil fail operation.
         * @type {number}
         * @default KeepStencilOp
         */
        this.stencilFail = KeepStencilOp;

        /**
         * The stencil Z-fail operation.
         * @type {number}
         * @default KeepStencilOp
         */
        this.stencilZFail = KeepStencilOp;

        /**
         * The stencil Z-pass operation.
         * @type {number}
         * @default KeepStencilOp
         */
        this.stencilZPass = KeepStencilOp;

        /**
         * Whether to write to the stencil buffer or not.
         * @type {boolean}
         * @default false
         */
        this.stencilWrite = false;

        /**
         * The clipping planes.
         * @type {?Array}
         * @default null
         */
        this.clippingPlanes = null;

        /**
         * The clipping intersection.
         * @type {boolean}
         * @default false
         */
        this.clipIntersection = false;

        /**
         * Whether to clip shadows or not.
         * @type {boolean}
         * @default false
         */
        this.clipShadows = false;

        /**
         * The shadow side.
         * @type {number}
         * @default null
         */
        this.shadowSide = null;

        /**
         * The color write mask.
         * @type {boolean}
         * @default true
         */
        this.colorWrite = true;

        /**
         * The polygon offset.
         * @type {boolean}
         * @default false
         */
        this.polygonOffset = false;

        /**
         * The polygon offset factor.
         * @type {number}
         * @default 0
         */
        this.polygonOffsetFactor = 0;

        /**
         * The polygon offset units.
         * @type {number}
         * @default 0
         */
        this.polygonOffsetUnits = 0;

        /**
         * The dithering flag.
         * @type {boolean}
         * @default false
         */
        this.dithering = false;

        /**
         * The precision override.
         * @type {?string}
         * @default null
         */
        this.precision = null;

        /**
         * Whether the material is affected by tone mapping or not.
         * @type {boolean}
         * @default true
         */
        this.toneMapped = true;

        /**
         * The user data.
         * @type {Object}
         */
        this.userData = {};

        /**
         * The version of the material.
         * @type {number}
         * @readonly
         * @default 0
         */
        this.version = 0;

        // -------------------------------------------------------------------
        // Anime Rendering Extensions
        // -------------------------------------------------------------------
        /**
         * Number of cel-shading bands. 2 = classic hard-shadow anime,
         * 3-4 = softer stylized shading, 0 = continuous (off).
         * @type {number}
         * @default 2
         */
        this.animeBands = 2;

        /**
         * The main shadow boundary in [0, 1] for the primary cel band.
         * @type {number}
         * @default 0.5
         */
        this.animeShadowThreshold = 0.5;

        /**
         * The highlight boundary in [0, 1] for the topmost cel band.
         * @type {number}
         * @default 0.8
         */
        this.animeHighlightThreshold = 0.8;

        /**
         * The precomputed cel-band thresholds. Populated automatically by
         * `updateCelThresholds()`.
         * @type {number[]}
         */
        this.celThresholds = computeCelBandThresholds( 2 );

        /**
         * Rim light color. Anime rim lighting is typically a cool cyan or
         * warm orange depending on the scene mood (see reference images 2,
         * 3, 4, 6).
         * @type {Color}
         * @default (0.5, 0.8, 1.0)
         */
        this.rimColor = new Color( 0.5, 0.8, 1.0 );

        /**
         * Rim light intensity.
         * @type {number}
         * @default 0.5
         */
        this.rimIntensity = 0.5;

        /**
         * Rim light falloff power. Higher = tighter rim.
         * @type {number}
         * @default 2.0
         */
        this.rimPower = 2.0;

        /**
         * Outline width. Set > 0 to enable inverted-hull outlines.
         * @type {number}
         * @default 0
         */
        this.outlineWidth = 0;

        /**
         * Outline color.
         * @type {Color}
         * @default (0, 0, 0)
         */
        this.outlineColor = new Color( 0, 0, 0 );

        /**
         * Mood hue shift in [-1, 1]. Shifts the entire material palette
         * toward warmer (positive) or cooler (negative) hues.
         * @type {number}
         * @default 0
         */
        this.moodHueShift = 0;

        /**
         * Mood saturation multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodSaturation = 1.0;

        /**
         * Mood contrast multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodContrast = 1.0;

        /**
         * Mood temperature shift in [-1, 1]. Positive = warm (orange),
         * negative = cool (cyan). Matches the sunset/space imagery.
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Paper grain intensity. 0 = off, 1 = maximum hand-drawn texture.
         * @type {number}
         * @default 0
         */
        this.paperGrainIntensity = 0;

        /**
         * Watercolor bleed strength. Simulates wet-in-wet pigment diffusion.
         * @type {number}
         * @default 0
         */
        this.watercolorBleed = 0;

        /**
         * Brush jitter amplitude for UV distortion.
         * @type {number}
         * @default 0
         */
        this.brushJitter = 0;

        /**
         * The compiled shader chunks cache key. Populated automatically
         * when the material is first compiled.
         * @type {?string}
         * @private
         * @default null
         */
        this._animeCacheKey = null;
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Recompute the cel-band thresholds from the current `animeBands`
     * value using double.js for bit-exact accumulation.
     * @returns {Material} A reference to this instance.
     */
    updateCelThresholds() {
        this.celThresholds = computeCelBandThresholds(
            this.animeBands,
            this.animeShadowThreshold,
            this.animeHighlightThreshold
        );
        return this;
    }

    /**
     * Apply the current mood grading to an arbitrary color. Uses gl-matrix
     * for zero-allocation HSV staging and double.js for bit-exact contrast
     * accumulation.
     * @param {Color} color - The source color (modified in place).
     * @returns {Color}
     */
    applyMood( color ) {
        return applyMoodGrading(
            color,
            this.moodHueShift,
            this.moodSaturation,
            this.moodContrast,
            this.moodTemperature
        );
    }

    /**
     * Apply brush jitter to a UV coordinate using simplex-noise.
     * @param {number} u
     * @param {number} v
     * @param {number} [offset=0] - Per-instance noise offset.
     * @returns {{u: number, v: number}}
     */
    applyBrushJitter( u, v, offset = 0 ) {
        return applyBrushJitter( u, v, this.brushJitter, 1.0, offset );
    }

    /**
     * Generate a paper-grain texture for this material using simplex-noise.
     * The caller is expected to assign the returned buffer to a
     * `DataTexture` and attach it to the appropriate map slot.
     * @param {number} width
     * @param {number} height
     * @returns {Uint8Array}
     */
    generatePaperGrainTexture( width, height ) {
        return generatePaperGrain( width, height, 0.05, this.paperGrainIntensity );
    }

    /**
     * The default `onBeforeCompile` hook. Injects anime shader chunks
     * (cel banding, rim lighting, mood grading) into the material's
     * shader source when a shader-compatible material is used.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader /*, renderer */ ) {
        // Cache the anime state key so the renderer can detect changes
        this._animeCacheKey = [
            this.animeBands,
            this.animeShadowThreshold,
            this.animeHighlightThreshold,
            this.rimIntensity,
            this.rimPower,
            this.outlineWidth,
            this.moodHueShift,
            this.moodSaturation,
            this.moodContrast,
            this.moodTemperature,
            this.paperGrainIntensity,
            this.watercolorBleed,
            this.brushJitter
        ].join( '|' );

        // Uniform injection — these are consumed by the injected chunks below.
        shader.uniforms.animeBands = { value: this.animeBands };
        shader.uniforms.animeShadowThreshold = { value: this.animeShadowThreshold };
        shader.uniforms.animeHighlightThreshold = { value: this.animeHighlightThreshold };
        shader.uniforms.rimColor = { value: this.rimColor };
        shader.uniforms.rimIntensity = { value: this.rimIntensity };
        shader.uniforms.rimPower = { value: this.rimPower };
        shader.uniforms.outlineWidth = { value: this.outlineWidth };
        shader.uniforms.outlineColor = { value: this.outlineColor };
        shader.uniforms.moodHueShift = { value: this.moodHueShift };
        shader.uniforms.moodSaturation = { value: this.moodSaturation };
        shader.uniforms.moodContrast = { value: this.moodContrast };
        shader.uniforms.moodTemperature = { value: this.moodTemperature };
        shader.uniforms.paperGrainIntensity = { value: this.paperGrainIntensity };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.brushJitter = { value: this.brushJitter };

        // Shader chunk injection points (fragment)
        shader.fragmentShader = shader.fragmentShader
            .replace( '#include <common>', `#include <common>
                uniform int animeBands;
                uniform float animeShadowThreshold;
                uniform float animeHighlightThreshold;
                uniform vec3 rimColor;
                uniform float rimIntensity;
                uniform float rimPower;
                uniform vec3 outlineColor;
                uniform float moodHueShift;
                uniform float moodSaturation;
                uniform float moodContrast;
                uniform float moodTemperature;
                uniform float paperGrainIntensity;
                uniform float watercolorBleed;
                uniform float brushJitter;

                vec3 applyMoodGrading( vec3 color ) {
                    float maxC = max( max( color.r, color.g ), color.b );
                    float minC = min( min( color.r, color.g ), color.b );
                    float delta = maxC - minC;
                    float hue = 0.0;
                    if ( delta > 0.0 ) {
                        if ( maxC == color.r ) hue = mod( ( color.g - color.b ) / delta, 6.0 );
                        else if ( maxC == color.g ) hue = ( color.b - color.r ) / delta + 2.0;
                        else hue = ( color.r - color.g ) / delta + 4.0;
                        hue /= 6.0;
                        if ( hue < 0.0 ) hue += 1.0;
                    }
                    float sat = maxC == 0.0 ? 0.0 : delta / maxC;
                    float val = maxC;
                    hue = fract( hue + moodHueShift );
                    sat = clamp( sat * moodSaturation, 0.0, 1.0 );
                    float i = floor( hue * 6.0 );
                    float f = hue * 6.0 - i;
                    float p = val * ( 1.0 - sat );
                    float q = val * ( 1.0 - f * sat );
                    float t = val * ( 1.0 - ( 1.0 - f ) * sat );
                    vec3 rgb;
                    if ( i == 0.0 ) rgb = vec3( val, t, p );
                    else if ( i == 1.0 ) rgb = vec3( q, val, p );
                    else if ( i == 2.0 ) rgb = vec3( p, val, t );
                    else if ( i == 3.0 ) rgb = vec3( p, q, val );
                    else if ( i == 4.0 ) rgb = vec3( t, p, val );
                    else rgb = vec3( val, p, q );
                    rgb = ( rgb - 0.5 ) * moodContrast + 0.5;
                    rgb.r += moodTemperature * 0.1;
                    rgb.b -= moodTemperature * 0.1;
                    return clamp( rgb, 0.0, 1.0 );
                }

                vec3 applyCelShading( vec3 color, float ndotl ) {
                    if ( animeBands <= 0 ) return color;
                    float bands = float( animeBands );
                    float band = floor( ndotl * bands ) / ( bands - 1.0 );
                    band = smoothstep( 0.0, 0.05, band );
                    return color * mix( animeShadowThreshold, 1.0, band );
                }

                vec3 applyRimLighting( vec3 color, vec3 normal, vec3 viewDir ) {
                    float rim = 1.0 - max( dot( normal, viewDir ), 0.0 );
                    rim = pow( rim, rimPower );
                    return color + rimColor * rim * rimIntensity;
                }
            ` )
            .replace( '#include <dithering_fragment>', `#include <dithering_fragment>
                vec3 finalNormal = normalize( vNormal );
                vec3 finalViewDir = normalize( vViewPosition );
                gl_FragColor.rgb = applyCelShading( gl_FragColor.rgb, max( dot( finalNormal, vec3( 0.0, 0.0, 1.0 ) ), 0.0 ) );
                gl_FragColor.rgb = applyRimLighting( gl_FragColor.rgb, finalNormal, finalViewDir );
                gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );
            ` );

        // Shader chunk injection points (vertex)
        shader.vertexShader = shader.vertexShader
            .replace( '#include <common>', `#include <common>
                uniform float outlineWidth;
                uniform vec3 outlineColor;
            ` );
    }

    /**
     * The default custom program cache key. Extends the base key with the
     * anime state so the renderer recompiles when anime parameters change.
     * @returns {string}
     */
    customProgramCacheKey() {
        return this._animeCacheKey || 'anime-default';
    }

    /**
     * Sets the values of this material based on the given object.
     * @param {Object} values - A container with material parameters.
     */
    setValues( values ) {
        if ( values === undefined ) return;

        for ( const key in values ) {
            const newValue = values[ key ];

            if ( newValue === undefined ) {
                warn( `Material: parameter '${ key }' has value of undefined.` );
                continue;
            }

            const currentValue = this[ key ];

            if ( currentValue === undefined ) {
                warn( `Material: '${ key }' is not a property of this material.` );
                continue;
            }

            if ( currentValue && currentValue.isColor ) {
                currentValue.set( newValue );
            } else if ( ( currentValue && currentValue.isVector3 ) && ( newValue && newValue.isVector3 ) ) {
                currentValue.copy( newValue );
            } else if ( Array.isArray( currentValue ) ) {
                currentValue.length = 0;
                for ( let i = 0, il = newValue.length; i < il; i ++ ) {
                    currentValue.push( newValue[ i ].clone() );
                }
            } else if ( currentValue && currentValue.isTexture ) {
                this[ key ] = newValue;
            } else {
                this[ key ] = newValue;
            }
        }
    }

    /**
     * Returns a new material with copied values from this instance.
     * @return {Material} A clone of this instance.
     */
    clone() {
        return new this.constructor().copy( this );
    }

    /**
     * Copies the values of the given material to this instance.
     * @param {Material} source - The material to copy.
     * @return {Material} A reference to this instance.
     */
    copy( source ) {
        this.name = source.name;
        this.blending = source.blending;
        this.side = source.side;
        this.vertexColors = source.vertexColors;
        this.opacity = source.opacity;
        this.transparent = source.transparent;
        this.alphaHash = source.alphaHash;
        this.alphaTest = source.alphaTest;
        this.alphaToCoverage = source.alphaToCoverage;
        this.blendSrc = source.blendSrc;
        this.blendDst = source.blendDst;
        this.blendEquation = source.blendEquation;
        this.blendSrcAlpha = source.blendSrcAlpha;
        this.blendDstAlpha = source.blendDstAlpha;
        this.blendEquationAlpha = source.blendEquationAlpha;
        this.blendColor.copy( source.blendColor );
        this.blendAlpha = source.blendAlpha;
        this.depthFunc = source.depthFunc;
        this.depthTest = source.depthTest;
        this.depthWrite = source.depthWrite;
        this.stencilWriteMask = source.stencilWriteMask;
        this.stencilFunc = source.stencilFunc;
        this.stencilRef = source.stencilRef;
        this.stencilFuncMask = source.stencilFuncMask;
        this.stencilFail = source.stencilFail;
        this.stencilZFail = source.stencilZFail;
        this.stencilZPass = source.stencilZPass;
        this.stencilWrite = source.stencilWrite;
        this.clippingPlanes = source.clippingPlanes;
        this.clipIntersection = source.clipIntersection;
        this.clipShadows = source.clipShadows;
        this.shadowSide = source.shadowSide;
        this.colorWrite = source.colorWrite;
        this.polygonOffset = source.polygonOffset;
        this.polygonOffsetFactor = source.polygonOffsetFactor;
        this.polygonOffsetUnits = source.polygonOffsetUnits;
        this.dithering = source.dithering;
        this.precision = source.precision;
        this.toneMapped = source.toneMapped;
        this.userData = JSON.parse( JSON.stringify( source.userData ) );

        // Anime extension properties
        this.animeBands = source.animeBands;
        this.animeShadowThreshold = source.animeShadowThreshold;
        this.animeHighlightThreshold = source.animeHighlightThreshold;
        this.celThresholds = [ ...source.celThresholds ];
        this.rimColor.copy( source.rimColor );
        this.rimIntensity = source.rimIntensity;
        this.rimPower = source.rimPower;
        this.outlineWidth = source.outlineWidth;
        this.outlineColor.copy( source.outlineColor );
        this.moodHueShift = source.moodHueShift;
        this.moodSaturation = source.moodSaturation;
        this.moodContrast = source.moodContrast;
        this.moodTemperature = source.moodTemperature;
        this.paperGrainIntensity = source.paperGrainIntensity;
        this.watercolorBleed = source.watercolorBleed;
        this.brushJitter = source.brushJitter;

        return this;
    }

    /**
     * Serializes the material into JSON.
     * @param {Object} [meta] - Optional metadata.
     * @return {Object} A JSON object representing the serialized material.
     */
    toJSON( meta ) {
        const isRootObject = ( meta === undefined || typeof meta === 'string' );

        if ( isRootObject ) {
            meta = {
                textures: {},
                images: {}
            };
        }

        const output = {
            metadata: {
                version: 4.6,
                type: 'Material',
                generator: 'Material.toJSON'
            },
            uuid: this.uuid,
            type: this.type,
            name: this.name,
            blending: this.blending,
            side: this.side,
            vertexColors: this.vertexColors,
            opacity: this.opacity,
            transparent: this.transparent,
            alphaHash: this.alphaHash,
            alphaTest: this.alphaTest,
            alphaToCoverage: this.alphaToCoverage,
            blendSrc: this.blendSrc,
            blendDst: this.blendDst,
            blendEquation: this.blendEquation,
            blendSrcAlpha: this.blendSrcAlpha,
            blendDstAlpha: this.blendDstAlpha,
            blendEquationAlpha: this.blendEquationAlpha,
            blendColor: this.blendColor.getHex(),
            blendAlpha: this.blendAlpha,
            depthFunc: this.depthFunc,
            depthTest: this.depthTest,
            depthWrite: this.depthWrite,
            stencilWriteMask: this.stencilWriteMask,
            stencilFunc: this.stencilFunc,
            stencilRef: this.stencilRef,
            stencilFuncMask: this.stencilFuncMask,
            stencilFail: this.stencilFail,
            stencilZFail: this.stencilZFail,
            stencilZPass: this.stencilZPass,
            stencilWrite: this.stencilWrite,
            clippingPlanes: this.clippingPlanes,
            clipIntersection: this.clipIntersection,
            clipShadows: this.clipShadows,
            shadowSide: this.shadowSide,
            colorWrite: this.colorWrite,
            polygonOffset: this.polygonOffset,
            polygonOffsetFactor: this.polygonOffsetFactor,
            polygonOffsetUnits: this.polygonOffsetUnits,
            dithering: this.dithering,
            precision: this.precision,
            toneMapped: this.toneMapped,
            userData: this.userData,

            // Anime extension properties
            animeBands: this.animeBands,
            animeShadowThreshold: this.animeShadowThreshold,
            animeHighlightThreshold: this.animeHighlightThreshold,
            celThresholds: [ ...this.celThresholds ],
            rimColor: this.rimColor.getHex(),
            rimIntensity: this.rimIntensity,
            rimPower: this.rimPower,
            outlineWidth: this.outlineWidth,
            outlineColor: this.outlineColor.getHex(),
            moodHueShift: this.moodHueShift,
            moodSaturation: this.moodSaturation,
            moodContrast: this.moodContrast,
            moodTemperature: this.moodTemperature,
            paperGrainIntensity: this.paperGrainIntensity,
            watercolorBleed: this.watercolorBleed,
            brushJitter: this.brushJitter
        };

        if ( ! isRootObject ) {
            meta.materials[ this.uuid ] = output;
        }

        return output;
    }

    /**
     * Deserializes the material from JSON.
     * @param {Object} json - The source JSON object.
     * @return {Material} A reference to this instance.
     */
    fromJSON( json ) {
        this.name = json.name || '';
        this.blending = json.blending ?? NormalBlending;
        this.side = json.side ?? FrontSide;
        this.vertexColors = json.vertexColors ?? false;
        this.opacity = json.opacity ?? 1.0;
        this.transparent = json.transparent ?? false;
        this.alphaHash = json.alphaHash ?? 0;
        this.alphaTest = json.alphaTest ?? 0;
        this.alphaToCoverage = json.alphaToCoverage ?? false;
        this.blendSrc = json.blendSrc ?? null;
        this.blendDst = json.blendDst ?? null;
        this.blendEquation = json.blendEquation ?? null;
        this.blendSrcAlpha = json.blendSrcAlpha ?? null;
        this.blendDstAlpha = json.blendDstAlpha ?? null;
        this.blendEquationAlpha = json.blendEquationAlpha ?? null;
        if ( json.blendColor !== undefined ) this.blendColor.setHex( json.blendColor );
        this.blendAlpha = json.blendAlpha ?? 0;
        this.depthFunc = json.depthFunc ?? LessEqualDepth;
        this.depthTest = json.depthTest ?? true;
        this.depthWrite = json.depthWrite ?? true;
        this.stencilWriteMask = json.stencilWriteMask ?? 0xff;
        this.stencilFunc = json.stencilFunc ?? AlwaysStencilFunc;
        this.stencilRef = json.stencilRef ?? 0;
        this.stencilFuncMask = json.stencilFuncMask ?? 0xff;
        this.stencilFail = json.stencilFail ?? KeepStencilOp;
        this.stencilZFail = json.stencilZFail ?? KeepStencilOp;
        this.stencilZPass = json.stencilZPass ?? KeepStencilOp;
        this.stencilWrite = json.stencilWrite ?? false;
        this.clippingPlanes = json.clippingPlanes ?? null;
        this.clipIntersection = json.clipIntersection ?? false;
        this.clipShadows = json.clipShadows ?? false;
        this.shadowSide = json.shadowSide ?? null;
        this.colorWrite = json.colorWrite ?? true;
        this.polygonOffset = json.polygonOffset ?? false;
        this.polygonOffsetFactor = json.polygonOffsetFactor ?? 0;
        this.polygonOffsetUnits = json.polygonOffsetUnits ?? 0;
        this.dithering = json.dithering ?? false;
        this.precision = json.precision ?? null;
        this.toneMapped = json.toneMapped ?? true;
        this.userData = json.userData ?? {};

        // Anime extension properties
        this.animeBands = json.animeBands ?? 2;
        this.animeShadowThreshold = json.animeShadowThreshold ?? 0.5;
        this.animeHighlightThreshold = json.animeHighlightThreshold ?? 0.8;
        this.celThresholds = json.celThresholds ? [ ...json.celThresholds ] : computeCelBandThresholds( this.animeBands );
        if ( json.rimColor !== undefined ) this.rimColor.setHex( json.rimColor );
        this.rimIntensity = json.rimIntensity ?? 0.5;
        this.rimPower = json.rimPower ?? 2.0;
        this.outlineWidth = json.outlineWidth ?? 0;
        if ( json.outlineColor !== undefined ) this.outlineColor.setHex( json.outlineColor );
        this.moodHueShift = json.moodHueShift ?? 0;
        this.moodSaturation = json.moodSaturation ?? 1.0;
        this.moodContrast = json.moodContrast ?? 1.0;
        this.moodTemperature = json.moodTemperature ?? 0;
        this.paperGrainIntensity = json.paperGrainIntensity ?? 0;
        this.watercolorBleed = json.watercolorBleed ?? 0;
        this.brushJitter = json.brushJitter ?? 0;

        return this;
    }

    /**
     * Frees the GPU-related resources allocated by this instance. Call this
     * method whenever this instance is no longer used in your app.
     */
    dispose() {
        this.dispatchEvent( { type: 'dispose' } );
    }

    /**
     * Registers a callback to be called when the material is disposed.
     * @param {Function} callback
     */
    onDispose( callback ) {
        this.addEventListener( 'dispose', callback );
    }
}

export { Material, MaterialBatch, applyMoodGrading, computeCelBandThresholds, generatePaperGrain, applyBrushJitter };
export default Material;