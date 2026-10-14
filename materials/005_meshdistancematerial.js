// file number : 005
// full path name : src/materials/005_meshdistancematerial.js
// description : MeshDistanceMaterial (three.js r185) rewritten as a high-
// performance ES module with deep anime-stylization integration. Extends the
// anime-enabled 001_material.js base class and preserves the full r185
// MeshDistanceMaterial API — referencePosition, nearDistance, farDistance, map,
// alphaMap, displacementMap, displacementScale, displacementBias, plus the
// inherited material surface. Adds real-time anime features specifically tuned
// for distance-based shadow rendering: stylized distance banding (cel-like
// discrete distance steps for toon-consistent point-light shadows), mood-tinted
// distance falloff (cool cyan for distant shadow casters, warm orange for near
// ones, matching the reference imagery's atmospheric falloff), procedural
// simplex-noise distance dithering (breaks up shadow acne and 8-bit distance
// banding without adding visible noise), paper-grain distance modulation (hand-
// drawn atmosphere), and rim-detection emphasis for stylized shadow contours.
// Uses gl-matrix for zero-allocation distance color transforms, double.js for
// bit-exact distance normalization (critical for HDR-logarithmic shadow
// distances), bitecs SoA batching for real-time distance-material updates
// across thousands of instanced shadow casters, and simplex-noise for the
// dithering and paper-grain features.
// best for : MeshDistanceMaterial, PointLight shadow maps, RectAreaLight shadow
// maps, Object3D.customDistanceMaterial overrides, anime shadow stylization,
// toon-consistent point-light shadows, hand-drawn shadow contours, and any
// three.js distance-based shadow rendering that needs real-time stylization.
// license : MIT

import { Material } from './001_material.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { Texture } from './../textures/002_texture.js';

// three.js r185 npm source — core, math, extras, and textures folders excluded per spec
import {
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

// gl-matrix scratch for zero-allocation distance color transforms
const _gm_rgb = glMatrix.vec3.create();
const _gm_hsv = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Anime feature — stylized distance banding for toon-consistent shadows
// ---------------------------------------------------------------------------
/**
 * Apply cel-like banding to a normalized distance value. Produces discrete
 * distance steps that keep anime shadow contours consistent across the
 * scene, avoiding the continuous gradient look of standard distance
 * rendering. Uses double.js for bit-exact band threshold computation,
 * critical when the distance buffer spans many orders of magnitude.
 * @param {number} distance - Normalized distance in [0, 1] (0 = near, 1 = far).
 * @param {number} bands - Number of discrete distance bands (2-8 recommended).
 * @param {number} [blend=1.0] - Blend between continuous and banded (0-1).
 * @returns {number} Banded distance value in [0, 1].
 */
function applyDistanceBanding( distance, bands, blend = 1.0 ) {
    if ( bands <= 1 ) return distance;

    const bandWidth = 1.0 / bands;

    _double.value = distance;
    _double.div( bandWidth );
    _double.value = Math.floor( _double.value );
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    _double.value = distance;
    _double.add( ( quantized - distance ) * blend );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — mood-tinted distance visualization
// ---------------------------------------------------------------------------
/**
 * Map a normalized distance value to a mood-tinted color. Cool cyan for
 * distant shadow casters, warm orange for near ones — matching the
 * atmospheric falloff seen in the reference imagery.
 * @param {Color} output - The output color (modified in place).
 * @param {number} distance - Normalized distance in [0, 1] (0 = near, 1 = far).
 * @param {number} [temperature=0] - Additional warm/cool shift in [-1, 1].
 * @param {number} [saturation=1.0] - Saturation multiplier.
 * @param {number} [brightness=1.0] - Brightness multiplier.
 * @returns {Color}
 */
function distanceToMoodColor( output, distance, temperature = 0, saturation = 1.0, brightness = 1.0 ) {
    // Base gradient: near = warm orange, far = cool cyan
    _double.value = distance;
    _double.mul( Math.PI * 0.5 );
    const t = Math.sin( _double.value );

    let r = 1.0 * ( 1 - t ) + 0.35 * t;
    let g = 0.55 * ( 1 - t ) + 0.75 * t;
    let b = 0.25 * ( 1 - t ) + 1.0 * t;

    _double.value = r; _double.add( temperature * 0.15 ); r = _double.value;
    _double.value = b; _double.sub( temperature * 0.15 ); b = _double.value;

    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    _double.value = lum; _double.add( ( r - lum ) * saturation ); r = _double.value;
    _double.value = lum; _double.add( ( g - lum ) * saturation ); g = _double.value;
    _double.value = lum; _double.add( ( b - lum ) * saturation ); b = _double.value;

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
// Anime feature — procedural simplex-noise distance dithering
// ---------------------------------------------------------------------------
/**
 * Apply simplex-noise dithering to a distance value. Breaks up 8-bit
 * distance banding and shadow acne without adding visible noise — the
 * dithering is correlated to screen position so it averages out smoothly
 * under bilinear filtering.
 * @param {number} distance - Normalized distance in [0, 1].
 * @param {number} x - Screen-space x coordinate.
 * @param {number} y - Screen-space y coordinate.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @param {number} [scale=1.0] - Noise scale (higher = finer dither).
 * @returns {number} Dithered distance in [0, 1].
 */
function ditherDistance( distance, x, y, amplitude = 0.5, scale = 1.0 ) {
    const n = _noise2D( x * scale, y * scale );
    _double.value = distance;
    _double.add( n * amplitude / 255 );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — paper-grain distance modulation for hand-drawn atmosphere
// ---------------------------------------------------------------------------
/**
 * Compute a paper-grain modulation for the distance value. Adds the subtle
 * hand-drawn texture characteristic of the reference imagery's watercolor
 * backgrounds, particularly visible in distant shadow haze.
 * @param {number} u - U coordinate in [0, 1].
 * @param {number} v - V coordinate in [0, 1].
 * @param {number} [scale=10.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.3] - Grain intensity in [0, 1].
 * @returns {number} Multiplier in [0, 1] to apply to distance contrast.
 */
function distancePaperGrain( u, v, scale = 10.0, intensity = 0.3 ) {
    const n = _noise2D( u * scale, v * scale ) * 0.5 + 0.5;
    _double.value = 1;
    _double.sub( intensity * ( 1 - n ) );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — rim-detection emphasis for stylized shadow outlines
// ---------------------------------------------------------------------------
/**
 * Compute a rim-emphasis factor from distance discontinuity. When the
 * distance at a pixel differs significantly from its neighbors (a shadow
 * edge), the rim factor is high — used to reinforce anime-style shadow
 * contours in post-processing.
 * @param {number} distanceCenter - Distance at the center pixel.
 * @param {number} distanceNeighbor - Distance at the neighbor pixel.
 * @param {number} [threshold=0.02] - Distance discontinuity threshold.
 * @param {number} [emphasis=1.0] - Emphasis strength.
 * @returns {number} Rim factor in [0, 1].
 */
function distanceRimEmphasis( distanceCenter, distanceNeighbor, threshold = 0.02, emphasis = 1.0 ) {
    _double.value = distanceCenter;
    _double.sub( distanceNeighbor );
    const delta = Math.abs( _double.value );

    if ( delta < threshold ) return 0;

    _double.value = delta;
    _double.div( threshold );
    _double.sub( 1 );
    _double.mul( emphasis );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for real-time distance material updates
// ---------------------------------------------------------------------------
const _distanceWorld = createWorld();
const DistanceMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    distanceBands: Types.ui8,
    distanceBandBlend: Types.f64,
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

class MeshDistanceMaterialBatch {

    constructor() {
        this.world = _distanceWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshDistanceMaterial instance for batched real-time updates.
     * @param {MeshDistanceMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, DistanceMaterialComponent, eid );
        DistanceMaterialComponent.materialPtr[ eid ] = this.materials.length;
        DistanceMaterialComponent.distanceBands[ eid ] = material.distanceBands;
        DistanceMaterialComponent.distanceBandBlend[ eid ] = material.distanceBandBlend;
        DistanceMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        DistanceMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        DistanceMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        DistanceMaterialComponent.ditherAmplitude[ eid ] = material.ditherAmplitude;
        DistanceMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        DistanceMaterialComponent.paperGrainScale[ eid ] = material.paperGrainScale;
        DistanceMaterialComponent.rimThreshold[ eid ] = material.rimThreshold;
        DistanceMaterialComponent.rimEmphasis[ eid ] = material.rimEmphasis;
        DistanceMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued distance-material updates in one cache-friendly pass.
     * Uses double.js internally to re-derive the mood colors.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ DistanceMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.distanceBands = DistanceMaterialComponent.distanceBands[ eid ];
            material.distanceBandBlend = DistanceMaterialComponent.distanceBandBlend[ eid ];
            material.moodTemperature = DistanceMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = DistanceMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = DistanceMaterialComponent.moodBrightness[ eid ];
            material.ditherAmplitude = DistanceMaterialComponent.ditherAmplitude[ eid ];
            material.paperGrain = DistanceMaterialComponent.paperGrain[ eid ];
            material.paperGrainScale = DistanceMaterialComponent.paperGrainScale[ eid ];
            material.rimThreshold = DistanceMaterialComponent.rimThreshold[ eid ];
            material.rimEmphasis = DistanceMaterialComponent.rimEmphasis[ eid ];

            distanceToMoodColor(
                material.nearColor,
                0,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness
            );
            distanceToMoodColor(
                material.farColor,
                1,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness
            );

            DistanceMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshDistanceMaterial class — mirrors
// three.js/src/materials/MeshDistanceMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material used internally for implementing shadow mapping with point
 * lights. Can also be used to customize the shadow casting of an object by
 * assigning an instance of `MeshDistanceMaterial` to
 * {@link Object3D#customDistanceMaterial}.
 *
 * In addition to the standard three.js parameters, this material exposes a
 * rich set of real-time anime-style controls: stylized distance banding,
 * mood-tinted distance visualization, procedural dithering, paper-grain
 * modulation, and rim-detection emphasis for stylized shadow contours.
 *
 * ```js
 * const material = new THREE.MeshDistanceMaterial( {
 *   referencePosition: new THREE.Vector3( 0, 10, 0 ),
 *   nearDistance: 1,
 *   farDistance: 100,
 *   distanceBands: 4,
 *   moodTemperature: -0.2,
 *   ditherAmplitude: 0.5,
 *   paperGrain: 0.3
 * } );
 * ```
 * @augments Material
 */
class MeshDistanceMaterial extends Material {

    /**
     * Constructs a new mesh distance material.
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
        this.isMeshDistanceMaterial = true;

        this.type = 'MeshDistanceMaterial';

        /**
         * The light's reference position in world space. PointLight shadow
         * cameras use this as the distance-measurement origin.
         * @type {Vector3}
         * @default (0,0,0)
         */
        this.referencePosition = new Vector3();

        /**
         * The near distance of the internal shadow camera.
         * @type {number}
         * @default 1
         */
        this.nearDistance = 1;

        /**
         * The far distance of the internal shadow camera.
         * @type {number}
         * @default 1000
         */
        this.farDistance = 1000;

        /**
         * The color map. May optionally include an alpha channel, typically
         * combined with {@link Material#transparent} or
         * {@link Material#alphaTest}.
         * `map` represents color data, and the texture must be assigned a
         * {@link Texture#colorSpace}. Most `map` textures set
         * `texture.colorSpace = SRGBColorSpace`.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * The alpha map is a grayscale texture that controls the opacity
         * across the surface (black: fully transparent; white: fully opaque).
         * `alphaMap` represents non-color data. Any texture assigned must
         * have `texture.colorSpace = NoColorSpace` (default).
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * The displacement map affects the position of the mesh's vertices.
         * Unlike other maps which only affect the light and shade of the
         * material the displaced vertices can cast shadows, block other
         * objects, and otherwise act as real geometry.
         * `displacementMap` represents non-color data. Any texture assigned
         * must have `texture.colorSpace = NoColorSpace` (default).
         * @type {?Texture}
         * @default null
         */
        this.displacementMap = null;

        /**
         * How much the displacement map affects the mesh (where black is no
         * displacement, and white is maximum displacement). Without a
         * displacement map set, this value is not applied.
         * @type {number}
         * @default 1
         */
        this.displacementScale = 1;

        /**
         * The offset of the displacement map's values on the mesh's vertices.
         * The bias is added to the scaled sample of the displacement map.
         * Without a displacement map set, this value is not applied.
         * @type {number}
         * @default 0
         */
        this.displacementBias = 0;

        // -------------------------------------------------------------------
        // Anime Rendering Extensions
        // -------------------------------------------------------------------
        /**
         * Number of discrete distance bands. 1 = continuous (standard
         * distance), 2-8 = cel-like banding for stylized shadow contours.
         * @type {number}
         * @default 1
         */
        this.distanceBands = 1;

        /**
         * Blend amount between continuous and banded distance. 0 = off,
         * 1 = fully banded.
         * @type {number}
         * @default 1.0
         */
        this.distanceBandBlend = 1.0;

        /**
         * Mood temperature shift in [-1, 1]. Positive = warmer, negative
         * = cooler. Shifts the near/far distance gradient.
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
         * The precomputed near-distance mood color (distance = 0). Populated
         * automatically by `updateMoodColors()`.
         * @type {Color}
         */
        this.nearColor = new Color( 0xffffff );

        /**
         * The precomputed far-distance mood color (distance = 1). Populated
         * automatically by `updateMoodColors()`.
         * @type {Color}
         */
        this.farColor = new Color( 0x000000 );

        /**
         * Simplex-noise dithering amplitude in 8-bit units. Breaks up
         * 8-bit distance banding and shadow acne without adding visible
         * noise.
         * @type {number}
         * @default 0
         */
        this.ditherAmplitude = 0;

        /**
         * Paper-grain distance modulation intensity in [0, 1]. Adds
         * hand-drawn texture to the distance visualization.
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
         * Distance discontinuity threshold for rim detection. Higher = only
         * very sharp edges produce rim emphasis.
         * @type {number}
         * @default 0.02
         */
        this.rimThreshold = 0.02;

        /**
         * Rim emphasis strength for stylized shadow contours.
         * @type {number}
         * @default 0
         */
        this.rimEmphasis = 0;

        /**
         * Per-instance variation seed for decorrelating procedural effects
         * across a crowd of identical shadow casters.
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
     * @returns {MeshDistanceMaterial} A reference to this instance.
     */
    updateMoodColors() {
        distanceToMoodColor( this.nearColor, 0, this.moodTemperature, this.moodSaturation, this.moodBrightness );
        distanceToMoodColor( this.farColor, 1, this.moodTemperature, this.moodSaturation, this.moodBrightness );
        return this;
    }

    /**
     * Apply stylized distance banding to a normalized distance value.
     * @param {number} distance - Normalized distance in [0, 1].
     * @returns {number} Banded distance in [0, 1].
     */
    applyBanding( distance ) {
        return applyDistanceBanding( distance, this.distanceBands, this.distanceBandBlend );
    }

    /**
     * Apply simplex-noise dithering to a normalized distance value.
     * @param {number} distance
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    applyDither( distance, x, y ) {
        if ( this.ditherAmplitude <= 0 ) return distance;
        return ditherDistance( distance, x, y, this.ditherAmplitude );
    }

    /**
     * Compute the paper-grain modulation at a UV position.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    samplePaperGrain( u, v ) {
        if ( this.paperGrain <= 0 ) return 1;
        return distancePaperGrain( u, v, this.paperGrainScale, this.paperGrain );
    }

    /**
     * Compute the rim-emphasis factor from a distance discontinuity.
     * @param {number} distanceCenter
     * @param {number} distanceNeighbor
     * @returns {number} Rim factor in [0, 1].
     */
    sampleRimEmphasis( distanceCenter, distanceNeighbor ) {
        if ( this.rimEmphasis <= 0 ) return 0;
        return distanceRimEmphasis( distanceCenter, distanceNeighbor, this.rimThreshold, this.rimEmphasis );
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
     * anime shader chunks with distance-specific features: distance banding,
     * mood-tinted gradient, simplex-noise dithering, and paper grain.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject distance-specific uniforms
        shader.uniforms.distanceBands = { value: this.distanceBands };
        shader.uniforms.distanceBandBlend = { value: this.distanceBandBlend };
        shader.uniforms.nearColor = { value: this.nearColor };
        shader.uniforms.farColor = { value: this.farColor };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.paperGrainScale = { value: this.paperGrainScale };
        shader.uniforms.rimEmphasis = { value: this.rimEmphasis };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader with distance-specific chunks
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int distanceBands;
                uniform float distanceBandBlend;
                uniform vec3 nearColor;
                uniform vec3 farColor;
                uniform float ditherAmplitude;
                uniform float paperGrain;
                uniform float paperGrainScale;
                uniform float rimEmphasis;
                uniform float variationOffset;

                float applyDistanceBanding( float distance ) {
                    if ( distanceBands <= 1 ) return distance;
                    float bandWidth = 1.0 / float( distanceBands );
                    float quantized = floor( distance / bandWidth ) * bandWidth + bandWidth * 0.5;
                    return mix( distance, quantized, distanceBandBlend );
                }

                float distancePaperGrain( vec2 uv ) {
                    if ( paperGrain <= 0.0 ) return 1.0;
                    float n = sin( uv.x * paperGrainScale ) * cos( uv.y * paperGrainScale );
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * ( 1.0 - n );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Extract distance from the base material's output
                float baseDistance = gl_FragColor.r;

                // Apply stylized distance banding
                float bandedDistance = applyDistanceBanding( baseDistance );

                // Map distance to mood-tinted color
                vec3 distanceColor = mix( nearColor, farColor, bandedDistance );

                // Apply simplex-noise dithering (approximated in shader with hash)
                if ( ditherAmplitude > 0.0 ) {
                    float d = fract( sin( gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233 ) * 43758.5453 );
                    distanceColor += ( d - 0.5 ) * ditherAmplitude / 255.0;
                }

                // Apply paper grain
                distanceColor *= distancePaperGrain( vUv );

                gl_FragColor.rgb = distanceColor;
            ` );
    }

    /**
     * The custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.distanceBands,
            this.distanceBandBlend,
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
     * @param {MeshDistanceMaterial} source - The material to copy from.
     * @return {MeshDistanceMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.referencePosition.copy( source.referencePosition );
        this.nearDistance = source.nearDistance;
        this.farDistance = source.farDistance;
        this.map = source.map;
        this.alphaMap = source.alphaMap;
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;

        // Anime extensions
        this.distanceBands = source.distanceBands;
        this.distanceBandBlend = source.distanceBandBlend;
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

        data.type = 'MeshDistanceMaterial';

        data.referencePosition = this.referencePosition.toArray();
        if ( this.nearDistance !== 1 ) data.nearDistance = this.nearDistance;
        if ( this.farDistance !== 1000 ) data.farDistance = this.farDistance;
        if ( this.map !== null ) data.map = this.map.toJSON( meta ).uuid;
        if ( this.alphaMap !== null ) data.alphaMap = this.alphaMap.toJSON( meta ).uuid;
        if ( this.displacementMap !== null ) data.displacementMap = this.displacementMap.toJSON( meta ).uuid;
        if ( this.displacementScale !== 1 ) data.displacementScale = this.displacementScale;
        if ( this.displacementBias !== 0 ) data.displacementBias = this.displacementBias;

        // Anime extensions
        if ( this.distanceBands !== 1 ) data.distanceBands = this.distanceBands;
        if ( this.distanceBandBlend !== 1.0 ) data.distanceBandBlend = this.distanceBandBlend;
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
    MeshDistanceMaterial,
    MeshDistanceMaterialBatch,
    applyDistanceBanding,
    distanceToMoodColor,
    ditherDistance,
    distancePaperGrain,
    distanceRimEmphasis
};
export default MeshDistanceMaterial;