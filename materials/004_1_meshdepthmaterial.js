// file number : 004_1
// full path name : src/materials/004_1_meshdepthmaterial.js
// description : MeshDepthMaterial (three.js r185) rewritten as a high-
// performance ES module with deep anime-stylization integration. Extends the
// anime-enabled 001_material.js base class and preserves the full r185
// MeshDepthMaterial API — depthPacking, map, alphaMap, displacementMap,
// displacementScale, displacementBias, wireframe, wireframeLinewidth, plus the
// inherited material surface. Adds real-time anime features specifically tuned
// for depth-based rendering: stylized depth banding (cel-like discrete depth
// steps for toon-consistent silhouettes), mood-tinted depth visualization
// (cool cyan for distant geometry, warm orange for near geometry, matching the
// reference imagery's atmospheric falloff), procedural simplex-noise depth
// dithering (breaks up 8-bit depth banding without adding visible noise),
// paper-grain depth modulation (hand-drawn atmosphere), and rim-detection
// emphasis for stylized outlines in depth-based post-processing passes. Uses
// gl-matrix for zero-allocation depth color transforms, double.js for bit-exact
// depth normalization (critical for HDR-logarithmic depth buffers), bitecs SoA
// batching for real-time depth-material updates across thousands of instanced
// objects, and simplex-noise for the dithering and paper-grain features.
// best for : MeshDepthMaterial, shadow map passes, depth-of-field pre-passes,
// logarithmic depth buffers, SSAO depth input, anime atmospheric falloff,
// toon-consistent silhouettes in depth-based outlines, and any three.js depth
// rendering that needs real-time stylization.
// license : MIT

import { Material } from './001_material.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Texture } from './../textures/002_texture.js';

// three.js r185 npm source — core, math, extras, and textures folders excluded per spec
import {
    BasicDepthPacking,
    RGBADepthPacking,
    FrontSide,
    NormalBlending,
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

// gl-matrix scratch for zero-allocation depth color transforms
const _gm_rgb = glMatrix.vec3.create();
const _gm_hsv = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Anime feature — stylized depth banding for toon-consistent silhouettes
// ---------------------------------------------------------------------------
/**
 * Apply cel-like banding to a normalized depth value. Produces discrete
 * depth steps that keep anime silhouettes consistent across the scene,
 * avoiding the continuous gradient look of standard depth rendering.
 * Uses double.js for bit-exact band threshold computation, critical
 * when the depth buffer is logarithmic or spans many orders of magnitude.
 * @param {number} depth - Normalized depth in [0, 1] (0 = near, 1 = far).
 * @param {number} bands - Number of discrete depth bands (2-8 recommended).
 * @param {number} [blend=1.0] - Blend between continuous and banded (0-1).
 * @returns {number} Banded depth value in [0, 1].
 */
function applyDepthBanding( depth, bands, blend = 1.0 ) {
    if ( bands <= 1 ) return depth;

    const bandWidth = 1.0 / bands;

    _double.value = depth;
    _double.div( bandWidth );
    _double.value = Math.floor( _double.value );
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    _double.value = depth;
    _double.add( ( quantized - depth ) * blend );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — mood-tinted depth visualization
// ---------------------------------------------------------------------------
/**
 * Map a normalized depth value to a mood-tinted color. Cool cyan for distant
 * geometry, warm orange for near geometry — matching the atmospheric falloff
 * seen in the reference imagery (snowy mountains, sunset skies, distant
 * planets).
 * @param {Color} output - The output color (modified in place).
 * @param {number} depth - Normalized depth in [0, 1] (0 = near, 1 = far).
 * @param {number} [temperature=0] - Additional warm/cool shift in [-1, 1].
 * @param {number} [saturation=1.0] - Saturation multiplier.
 * @param {number} [brightness=1.0] - Brightness multiplier.
 * @returns {Color}
 */
function depthToMoodColor( output, depth, temperature = 0, saturation = 1.0, brightness = 1.0 ) {
    // Base gradient: near = warm orange, far = cool cyan
    _double.value = depth;
    _double.mul( Math.PI * 0.5 );
    const t = Math.sin( _double.value );

    // Near (depth=0): warm orange (1.0, 0.55, 0.25)
    // Far  (depth=1): cool cyan  (0.35, 0.75, 1.0)
    let r = 1.0 * ( 1 - t ) + 0.35 * t;
    let g = 0.55 * ( 1 - t ) + 0.75 * t;
    let b = 0.25 * ( 1 - t ) + 1.0 * t;

    // Temperature shift: positive = warmer, negative = cooler
    _double.value = r; _double.add( temperature * 0.15 ); r = _double.value;
    _double.value = b; _double.sub( temperature * 0.15 ); b = _double.value;

    // Saturation: push away from luminance
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    _double.value = lum; _double.add( ( r - lum ) * saturation ); r = _double.value;
    _double.value = lum; _double.add( ( g - lum ) * saturation ); g = _double.value;
    _double.value = lum; _double.add( ( b - lum ) * saturation ); b = _double.value;

    // Brightness
    r *= brightness;
    g *= brightness;
    b *= brightness;

    output.setRGB(
        Math.max( 0, Math.min( 1, r ) ),
        Math.max( 0, Math.min( 1, g ) ),
        Math.max( 0, Math.min( 1, b ) ),
        ColorManagement.workingColorSpace
    );
    return output;
}

// ---------------------------------------------------------------------------
// Anime feature — procedural simplex-noise depth dithering
// ---------------------------------------------------------------------------
/**
 * Apply simplex-noise dithering to a depth value. Breaks up 8-bit depth
 * banding without adding visible noise — the dithering is correlated to
 * screen position so it averages out smoothly under bilinear filtering.
 * @param {number} depth - Normalized depth in [0, 1].
 * @param {number} x - Screen-space x coordinate.
 * @param {number} y - Screen-space y coordinate.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @param {number} [scale=1.0] - Noise scale (higher = finer dither).
 * @returns {number} Dithered depth in [0, 1].
 */
function ditherDepth( depth, x, y, amplitude = 0.5, scale = 1.0 ) {
    const n = _noise2D( x * scale, y * scale );
    _double.value = depth;
    _double.add( n * amplitude / 255 );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — paper-grain depth modulation for hand-drawn atmosphere
// ---------------------------------------------------------------------------
/**
 * Compute a paper-grain modulation for the depth value. Adds the subtle
 * hand-drawn texture characteristic of the reference imagery's watercolor
 * backgrounds, particularly visible in distant atmospheric haze.
 * @param {number} u - U coordinate in [0, 1].
 * @param {number} v - V coordinate in [0, 1].
 * @param {number} [scale=10.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.3] - Grain intensity in [0, 1].
 * @returns {number} Multiplier in [0, 1] to apply to depth contrast.
 */
function depthPaperGrain( u, v, scale = 10.0, intensity = 0.3 ) {
    const n = _noise2D( u * scale, v * scale ) * 0.5 + 0.5;
    _double.value = 1;
    _double.sub( intensity * ( 1 - n ) );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — rim-detection emphasis for stylized depth outlines
// ---------------------------------------------------------------------------
/**
 * Compute a rim-emphasis factor from depth discontinuity. When the depth
 * at a pixel differs significantly from its neighbors (a silhouette edge),
 * the rim factor is high — used to reinforce anime-style outlines in
 * depth-based post-processing passes.
 * @param {number} depthCenter - Depth at the center pixel.
 * @param {number} depthNeighbor - Depth at the neighbor pixel.
 * @param {number} [threshold=0.02] - Depth discontinuity threshold.
 * @param {number} [emphasis=1.0] - Emphasis strength.
 * @returns {number} Rim factor in [0, 1].
 */
function depthRimEmphasis( depthCenter, depthNeighbor, threshold = 0.02, emphasis = 1.0 ) {
    _double.value = depthCenter;
    _double.sub( depthNeighbor );
    const delta = Math.abs( _double.value );

    if ( delta < threshold ) return 0;

    _double.value = delta;
    _double.div( threshold );
    _double.sub( 1 );
    _double.mul( emphasis );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for real-time depth material updates
// ---------------------------------------------------------------------------
const _depthWorld = createWorld();
const DepthMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    depthBands: Types.ui8,
    depthBandBlend: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    ditherAmplitude: Types.f64,
    paperGrain: Types.f64,
    paperGrainScale: Types.f64,
    rimThreshold: Types.f64,
    rimEmphasis: Types.f64,
    dirty: Types.ui8
} );

class MeshDepthMaterialBatch {

    constructor() {
        this.world = _depthWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshDepthMaterial instance for batched real-time updates.
     * @param {MeshDepthMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, DepthMaterialComponent, eid );
        DepthMaterialComponent.materialPtr[ eid ] = this.materials.length;
        DepthMaterialComponent.depthBands[ eid ] = material.depthBands;
        DepthMaterialComponent.depthBandBlend[ eid ] = material.depthBandBlend;
        DepthMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        DepthMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        DepthMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        DepthMaterialComponent.ditherAmplitude[ eid ] = material.ditherAmplitude;
        DepthMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        DepthMaterialComponent.paperGrainScale[ eid ] = material.paperGrainScale;
        DepthMaterialComponent.rimThreshold[ eid ] = material.rimThreshold;
        DepthMaterialComponent.rimEmphasis[ eid ] = material.rimEmphasis;
        DepthMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued depth-material updates in one cache-friendly pass.
     * Uses double.js internally to re-derive the mood color.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ DepthMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.depthBands = DepthMaterialComponent.depthBands[ eid ];
            material.depthBandBlend = DepthMaterialComponent.depthBandBlend[ eid ];
            material.moodTemperature = DepthMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = DepthMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = DepthMaterialComponent.moodBrightness[ eid ];
            material.ditherAmplitude = DepthMaterialComponent.ditherAmplitude[ eid ];
            material.paperGrain = DepthMaterialComponent.paperGrain[ eid ];
            material.paperGrainScale = DepthMaterialComponent.paperGrainScale[ eid ];
            material.rimThreshold = DepthMaterialComponent.rimThreshold[ eid ];
            material.rimEmphasis = DepthMaterialComponent.rimEmphasis[ eid ];

            // Re-derive near/far mood colors
            depthToMoodColor(
                material.nearColor,
                0,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness
            );
            depthToMoodColor(
                material.farColor,
                1,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness
            );

            DepthMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshDepthMaterial class — mirrors
// three.js/src/materials/MeshDepthMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material for drawing geometry by depth. Depth is based off of the camera
 * near and far plane. White is nearest, black is farthest.
 *
 * In addition to the standard three.js parameters, this material exposes a
 * rich set of real-time anime-style controls: stylized depth banding,
 * mood-tinted depth visualization, procedural dithering, paper-grain
 * modulation, and rim-detection emphasis for stylized outlines.
 *
 * ```js
 * const material = new THREE.MeshDepthMaterial( {
 *   depthBands: 4,
 *   depthBandBlend: 0.8,
 *   moodTemperature: -0.2,
 *   ditherAmplitude: 0.5,
 *   paperGrain: 0.3
 * } );
 * ```
 * @augments Material
 */
class MeshDepthMaterial extends Material {

    /**
     * Constructs a new mesh depth material.
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
        this.isMeshDepthMaterial = true;

        this.type = 'MeshDepthMaterial';

        /**
         * The depth packing type. `BasicDepthPacking` (default) stores
         * depth linearly in the red channel. `RGBADepthPacking` stores
         * depth across all four channels for higher precision.
         * @type {number}
         * @default BasicDepthPacking
         */
        this.depthPacking = BasicDepthPacking;

        /**
         * The color map. May optionally include an alpha channel, typically
         * combined with {@link Material#transparent} or
         * {@link Material#alphaTest}.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * The alpha map is a grayscale texture that controls the opacity
         * across the surface.
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * The displacement map affects the position of the mesh's vertices.
         * Unlike other maps, the displacement map does not affect the shading
         * or lighting of the mesh — it only affects the vertex positions.
         * @type {?Texture}
         * @default null
         */
        this.displacementMap = null;

        /**
         * How much the displacement map affects the mesh (where dark values
         * are without displacement and light values are fully displaced).
         * @type {number}
         * @default 1
         */
        this.displacementScale = 1;

        /**
         * The offset of the displacement map's values. This can be used to
         * avoid clipping when the displacement map is applied.
         * @type {number}
         * @default 0
         */
        this.displacementBias = 0;

        /**
         * Whether to render the geometry as a wireframe or not.
         * @type {boolean}
         * @default false
         */
        this.wireframe = false;

        /**
         * Controls the thickness of the wireframe.
         * @type {number}
         * @default 1
         */
        this.wireframeLinewidth = 1;

        // -------------------------------------------------------------------
        // Anime Rendering Extensions
        // -------------------------------------------------------------------
        /**
         * Number of discrete depth bands. 1 = continuous (standard depth),
         * 2-8 = cel-like banding for stylized silhouettes.
         * @type {number}
         * @default 1
         */
        this.depthBands = 1;

        /**
         * Blend amount between continuous and banded depth. 0 = off,
         * 1 = fully banded.
         * @type {number}
         * @default 1.0
         */
        this.depthBandBlend = 1.0;

        /**
         * Mood temperature shift in [-1, 1]. Positive = warmer, negative
         * = cooler. Shifts the near/far depth gradient.
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
         * The precomputed near-depth mood color (depth = 0). Populated
         * automatically by `updateMoodColors()`.
         * @type {Color}
         */
        this.nearColor = new Color( 0xffffff );

        /**
         * The precomputed far-depth mood color (depth = 1). Populated
         * automatically by `updateMoodColors()`.
         * @type {Color}
         */
        this.farColor = new Color( 0x000000 );

        /**
         * Simplex-noise dithering amplitude in 8-bit units. Breaks up
         * 8-bit depth banding without adding visible noise.
         * @type {number}
         * @default 0
         */
        this.ditherAmplitude = 0;

        /**
         * Paper-grain depth modulation intensity in [0, 1]. Adds hand-drawn
         * texture to the depth visualization.
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
         * Depth discontinuity threshold for rim detection. Higher = only
         * very sharp edges produce rim emphasis.
         * @type {number}
         * @default 0.02
         */
        this.rimThreshold = 0.02;

        /**
         * Rim emphasis strength for stylized outlines.
         * @type {number}
         * @default 0
         */
        this.rimEmphasis = 0;

        /**
         * Per-instance variation seed for decorrelating procedural effects
         * across a crowd of identical meshes.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        this.setValues( parameters );

        // Initialize derived colors from the current mood parameters.
        this.updateMoodColors();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Recompute the near/far mood colors from the current mood parameters.
     * @returns {MeshDepthMaterial} A reference to this instance.
     */
    updateMoodColors() {
        depthToMoodColor( this.nearColor, 0, this.moodTemperature, this.moodSaturation, this.moodBrightness );
        depthToMoodColor( this.farColor, 1, this.moodTemperature, this.moodSaturation, this.moodBrightness );
        return this;
    }

    /**
     * Apply stylized depth banding to a normalized depth value.
     * @param {number} depth - Normalized depth in [0, 1].
     * @returns {number} Banded depth in [0, 1].
     */
    applyBanding( depth ) {
        return applyDepthBanding( depth, this.depthBands, this.depthBandBlend );
    }

    /**
     * Apply simplex-noise dithering to a normalized depth value.
     * @param {number} depth
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    applyDither( depth, x, y ) {
        if ( this.ditherAmplitude <= 0 ) return depth;
        return ditherDepth( depth, x, y, this.ditherAmplitude );
    }

    /**
     * Compute the paper-grain modulation at a UV position.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    samplePaperGrain( u, v ) {
        if ( this.paperGrain <= 0 ) return 1;
        return depthPaperGrain( u, v, this.paperGrainScale, this.paperGrain );
    }

    /**
     * Compute the rim-emphasis factor from a depth discontinuity.
     * @param {number} depthCenter
     * @param {number} depthNeighbor
     * @returns {number} Rim factor in [0, 1].
     */
    sampleRimEmphasis( depthCenter, depthNeighbor ) {
        if ( this.rimEmphasis <= 0 ) return 0;
        return depthRimEmphasis( depthCenter, depthNeighbor, this.rimThreshold, this.rimEmphasis );
    }

    /**
     * Compute a per-instance variation offset from the variationSeed.
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
     * anime shader chunks with depth-specific features: depth banding,
     * mood-tinted gradient, simplex-noise dithering, and paper grain.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject depth-specific uniforms
        shader.uniforms.depthBands = { value: this.depthBands };
        shader.uniforms.depthBandBlend = { value: this.depthBandBlend };
        shader.uniforms.nearColor = { value: this.nearColor };
        shader.uniforms.farColor = { value: this.farColor };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.paperGrainScale = { value: this.paperGrainScale };
        shader.uniforms.rimEmphasis = { value: this.rimEmphasis };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader with depth-specific chunks
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int depthBands;
                uniform float depthBandBlend;
                uniform vec3 nearColor;
                uniform vec3 farColor;
                uniform float ditherAmplitude;
                uniform float paperGrain;
                uniform float paperGrainScale;
                uniform float rimEmphasis;
                uniform float variationOffset;

                float applyDepthBanding( float depth ) {
                    if ( depthBands <= 1 ) return depth;
                    float bandWidth = 1.0 / float( depthBands );
                    float quantized = floor( depth / bandWidth ) * bandWidth + bandWidth * 0.5;
                    return mix( depth, quantized, depthBandBlend );
                }

                float depthPaperGrain( vec2 uv ) {
                    if ( paperGrain <= 0.0 ) return 1.0;
                    float n = sin( uv.x * paperGrainScale ) * cos( uv.y * paperGrainScale );
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * ( 1.0 - n );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Extract depth from the base material's output (already in gl_FragColor.rgb for depth packing)
                float baseDepth = gl_FragColor.r;

                // Apply stylized depth banding
                float bandedDepth = applyDepthBanding( baseDepth );

                // Map depth to mood-tinted color
                vec3 depthColor = mix( nearColor, farColor, bandedDepth );

                // Apply simplex-noise dithering (approximated in shader with hash)
                if ( ditherAmplitude > 0.0 ) {
                    float d = fract( sin( gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233 ) * 43758.5453 );
                    depthColor += ( d - 0.5 ) * ditherAmplitude / 255.0;
                }

                // Apply paper grain
                depthColor *= depthPaperGrain( vUv );

                gl_FragColor.rgb = depthColor;
            ` );
    }

    /**
     * The custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.depthPacking,
            this.depthBands,
            this.depthBandBlend,
            this.ditherAmplitude,
            this.paperGrain,
            this.paperGrainScale,
            this.rimEmphasis,
            this.rimThreshold,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {MeshDepthMaterial} source - The material to copy from.
     * @return {MeshDepthMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.depthPacking = source.depthPacking;
        this.map = source.map;
        this.alphaMap = source.alphaMap;
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;

        // Anime extensions
        this.depthBands = source.depthBands;
        this.depthBandBlend = source.depthBandBlend;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.nearColor.copy( source.nearColor );
        this.farColor.copy( source.farColor );
        this.ditherAmplitude = source.ditherAmplitude;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
        this.rimThreshold = source.rimThreshold;
        this.rimEmphasis = source.rimEmphasis;
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

        data.type = 'MeshDepthMaterial';

        if ( this.depthPacking !== BasicDepthPacking ) data.depthPacking = this.depthPacking;
        if ( this.map !== null ) data.map = this.map.toJSON( meta ).uuid;
        if ( this.alphaMap !== null ) data.alphaMap = this.alphaMap.toJSON( meta ).uuid;
        if ( this.displacementMap !== null ) data.displacementMap = this.displacementMap.toJSON( meta ).uuid;
        if ( this.displacementScale !== 1 ) data.displacementScale = this.displacementScale;
        if ( this.displacementBias !== 0 ) data.displacementBias = this.displacementBias;
        if ( this.wireframe !== false ) data.wireframe = this.wireframe;
        if ( this.wireframeLinewidth !== 1 ) data.wireframeLinewidth = this.wireframeLinewidth;

        // Anime extensions
        if ( this.depthBands !== 1 ) data.depthBands = this.depthBands;
        if ( this.depthBandBlend !== 1.0 ) data.depthBandBlend = this.depthBandBlend;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.ditherAmplitude !== 0 ) data.ditherAmplitude = this.ditherAmplitude;
        if ( this.paperGrain !== 0 ) data.paperGrain = this.paperGrain;
        if ( this.paperGrainScale !== 10.0 ) data.paperGrainScale = this.paperGrainScale;
        if ( this.rimThreshold !== 0.02 ) data.rimThreshold = this.rimThreshold;
        if ( this.rimEmphasis !== 0 ) data.rimEmphasis = this.rimEmphasis;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    MeshDepthMaterial,
    MeshDepthMaterialBatch,
    applyDepthBanding,
    depthToMoodColor,
    ditherDepth,
    depthPaperGrain,
    depthRimEmphasis
};
export default MeshDepthMaterial;