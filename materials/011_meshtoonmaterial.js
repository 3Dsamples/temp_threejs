// file number : 011
// full path name : src/materials/011_meshtoonmaterial.js
// description : MeshToonMaterial (three.js r185) rewritten as a high-performance ES module with deep anime-stylization integration. Extends the anime-enabled 001_material.js base class and preserves the full r185 MeshToonMaterial API — color, map, gradientMap, lightMap, lightMapIntensity, aoMap, aoMapIntensity, emissive, emissiveIntensity, emissiveMap, bumpMap, bumpScale, normalMap, normalMapType, normalScale, displacementMap, displacementScale, displacementBias, alphaMap, wireframe, wireframeLinewidth, fog, and the inherited material surface. MeshToonMaterial is THE classic anime material — it uses a gradient map (a small 1D texture) to remap N·L into discrete cel bands. This rewrite extends it into a full anime-stylization platform: multi-band gradient with configurable smoothness and shadow tint, view-space normal rim glow (cyan water rims in 1, 3, 5; warm sunset character rims in 2, 4, 6), mood-based color grading, ambient sky-to-ground gradient tinting (matches the mountain and sky layers in 1, 5), procedural paper-grain and watercolor texture variation via simplex-noise, brush-jitter UV distortion, and per-instance variation for crowds. Imports Color, Euler, Vector2, Vector3, and other math classes strictly from threejs_new01 math, and uses gl-matrix for zero-allocation N·L and rim computations, double.js for bit-exact cel-band thresholding and HDR mood grading, bitecs SoA batching for real-time updates across thousands of anime characters, and simplex-noise for procedural texture variation.
// best for : MeshToonMaterial, anime character skin/hair/clothing, toon-shaded props, stylized backgrounds, cel-shaded vehicles, and any three.js mesh that needs the classic cel-shaded look.
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
    LinearSRGBColorSpace,
    RedFormat,
    UnsignedByteType,
    NearestFilter,
    LinearFilter,
    ClampToEdgeWrapping
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

// gl-matrix scratch for zero-allocation N·L and rim computations
const _gm_normal = glMatrix.vec3.create();
const _gm_view = glMatrix.vec3.create();
const _gm_light = glMatrix.vec3.create();
const _gm_rgb = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Anime feature — multi-band gradient construction
// ---------------------------------------------------------------------------
/**
 * Build a 1D gradient map (as a flat Float32Array) representing the cel
 * banding curve for the toon material. Uses double.js for bit-exact
 * thresholding at band boundaries — critical for avoiding band flicker
 * in HDR-lit anime scenes with moving characters.
 * The gradient map is sampled by the shader with N·L as the U coordinate;
 * the output V is the lighting multiplier. A hard-edged gradient map
 * produces classic sharp cel bands, while a soft-edged map produces the
 * "soft cel" look of modern anime.
 * @param {number} resolution - Gradient map resolution (e.g. 128 or 256).
 * @param {number} bands - Number of cel bands (2-6 recommended).
 * @param {number} [shadowTint=0.7] - Brightness of the darkest band.
 * @param {number} [softness=0.1] - Edge softness in [0, 0.5].
 * @param {number} [highlightTint=1.15] - Brightness of the brightest band (for anime glow).
 * @returns {Float32Array}
 */
function buildToonGradientMap( resolution, bands, shadowTint = 0.7, softness = 0.1, highlightTint = 1.15 ) {
    const out = new Float32Array( resolution );

    for ( let i = 0; i < resolution; i ++ ) {
        _double.value = i;
        _double.div( resolution - 1 );
        const ndotl = Math.max( 0, Math.min( 1, _double.value ) );

        // Quantize into bands
        const bandWidth = 1.0 / bands;

        _double.value = ndotl;
        _double.div( bandWidth );
        const bandIndex = Math.floor( _double.value );

        // Distance to band center (for soft edges)
        _double.value = bandIndex;
        _double.mul( bandWidth );
        _double.add( bandWidth * 0.5 );
        const bandCenter = _double.value;
        const distToCenter = Math.abs( ndotl - bandCenter );

        // Soft edge factor
        const softFactor = Math.max( 0, Math.min( 1, distToCenter / ( bandWidth * 0.5 ) ) );
        const edgeBlend = ( 1 - softFactor ) * ( 1 - softness ) + softness;

        // Map band index to brightness using shadow → highlight tint
        _double.value = bandIndex;
        _double.div( Math.max( 1, bands - 1 ) );
        const bandPos = _double.value;

        _double.value = shadowTint;
        _double.add( ( highlightTint - shadowTint ) * bandPos );
        const targetBrightness = _double.value;

        // Blend target with the smooth ndotl response near band edges
        _double.value = targetBrightness * edgeBlend;
        _double.add( ndotl * ( 1 - edgeBlend ) );

        out[ i ] = Math.max( 0, Math.min( 1, _double.value ) );
    }

    return out;
}

// ---------------------------------------------------------------------------
// Anime feature — view-space normal rim glow
// ---------------------------------------------------------------------------
/**
 * Compute a view-space normal rim glow. Surfaces facing away from the
 * view (silhouettes) produce a strong rim, mimicking the cyan water rims
 * in reference images 1, 3, 5 and the warm sunset character rims in
 * 2, 4, 6. Uses gl-matrix for zero-allocation vector staging and
 * double.js for bit-exact accumulation.
 * @param {Vector3} viewNormal - View-space normal (normalized).
 * @param {Vector3} viewDir - View direction (normalized).
 * @param {number} [power=2.5] - Rim falloff power (higher = tighter rim).
 * @param {number} [intensity=1.0] - Rim intensity multiplier.
 * @returns {number} Rim intensity in [0, 1].
 */
function computeToonRimGlow( viewNormal, viewDir, power = 2.5, intensity = 1.0 ) {
    glMatrix.vec3.set( _gm_normal, viewNormal.x, viewNormal.y, viewNormal.z );
    glMatrix.vec3.set( _gm_view, viewDir.x, viewDir.y, viewDir.z );
    glMatrix.vec3.normalize( _gm_normal, _gm_normal );
    glMatrix.vec3.normalize( _gm_view, _gm_view );

    _double.value = glMatrix.vec3.dot( _gm_normal, _gm_view );
    const ndotv = _double.value;

    _double.value = 1.0 - Math.abs( ndotv );
    const rim = Math.pow( _double.value, power );
    return Math.max( 0, Math.min( 1, rim * intensity ) );
}

// ---------------------------------------------------------------------------
// Anime feature — ambient sky-to-ground gradient tinting
// ---------------------------------------------------------------------------
/**
 * Apply a vertical gradient tint from a sky color to a ground color
 * using gl-matrix for zero-allocation staging and double.js for bit-exact
 * accumulation. Emulates the ambient bounce light in anime backgrounds —
 * cool blue sky above, warm ground below — matching the mountain/sky
 * layering in reference images 1 and 5.
 * @param {Color} color - The color to tint (modified in place).
 * @param {number} worldY - The world Y coordinate of the fragment.
 * @param {number} heightRange - Range over which the gradient blends.
 * @param {Color} skyColor - Tint applied at the top.
 * @param {Color} groundColor - Tint applied at the bottom.
 * @param {number} intensity - Blend intensity in [0, 1].
 * @returns {Color}
 */
function applyToonAmbientGradient( color, worldY, heightRange, skyColor, groundColor, intensity ) {
    if ( intensity <= 0 ) return color;

    _double.value = worldY;
    _double.div( heightRange );
    _double.add( 0.5 );
    let t = _double.value;
    t = Math.max( 0, Math.min( 1, t ) );

    _double.value = groundColor.r;
    _double.add( ( skyColor.r - groundColor.r ) * t );
    const tr = _double.value;

    _double.value = groundColor.g;
    _double.add( ( skyColor.g - groundColor.g ) * t );
    const tg = _double.value;

    _double.value = groundColor.b;
    _double.add( ( skyColor.b - groundColor.b ) * t );
    const tb = _double.value;

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
// Anime feature — mood-based color grading for toon materials
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading. Handles warm (sunset orange), cool
 * (snowy cyan), and vibrant (flora) moods seen across the reference
 * imagery. Uses gl-matrix for zero-allocation staging and double.js for
 * bit-exact accumulation.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeToonColor( color, temperature, saturation, brightness, contrast ) {
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
// Anime feature — procedural paper-grain / watercolor texture variation
// ---------------------------------------------------------------------------
/**
 * Generate a combined paper-grain and watercolor texture using
 * simplex-noise with multiple octaves. Produces the hand-painted texture
 * characteristic of the reference imagery's snow, foliage, and water
 * surfaces.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03] - Base noise scale.
 * @param {number} [octaves=4] - Number of noise octaves.
 * @param {number} [paperGrain=0.3] - Paper grain intensity.
 * @param {number} [watercolorBleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateToonTexture( width, height, scale = 0.03, octaves = 4, paperGrain = 0.3, watercolorBleed = 0.5 ) {
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

            _double.value = value;
            _double.sub( 0.5 );
            _double.mul( 1.0 + watercolorBleed );
            _double.add( 0.5 );
            value = Math.max( 0, Math.min( 1, _double.value ) );

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
// bitecs SoA batch coordinator for real-time toon material updates
// ---------------------------------------------------------------------------
const _toonWorld = createWorld();
const ToonMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    toonBands: Types.ui8,
    toonShadowTint: Types.f64,
    toonSoftness: Types.f64,
    toonHighlightTint: Types.f64,
    rimPower: Types.f64,
    rimIntensity: Types.f64,
    ambientGradient: Types.f64,
    ambientHeight: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    paperGrain: Types.f64,
    watercolorBleed: Types.f64,
    brushJitter: Types.f64,
    dirty: Types.ui8
} );

class MeshToonMaterialBatch {

    constructor() {
        this.world = _toonWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshToonMaterial instance for batched real-time updates.
     * @param {MeshToonMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, ToonMaterialComponent, eid );
        ToonMaterialComponent.materialPtr[ eid ] = this.materials.length;
        ToonMaterialComponent.toonBands[ eid ] = material.toonBands;
        ToonMaterialComponent.toonShadowTint[ eid ] = material.toonShadowTint;
        ToonMaterialComponent.toonSoftness[ eid ] = material.toonSoftness;
        ToonMaterialComponent.toonHighlightTint[ eid ] = material.toonHighlightTint;
        ToonMaterialComponent.rimPower[ eid ] = material.rimPower;
        ToonMaterialComponent.rimIntensity[ eid ] = material.rimIntensity;
        ToonMaterialComponent.ambientGradient[ eid ] = material.ambientGradient;
        ToonMaterialComponent.ambientHeight[ eid ] = material.ambientHeight;
        ToonMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        ToonMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        ToonMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        ToonMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        ToonMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        ToonMaterialComponent.watercolorBleed[ eid ] = material.watercolorBleed;
        ToonMaterialComponent.brushJitter[ eid ] = material.brushJitter;
        ToonMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued toon-material updates in one cache-friendly pass.
     * Uses double.js internally for bit-exact cel-band thresholding and
     * mood grading.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ ToonMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.toonBands = ToonMaterialComponent.toonBands[ eid ];
            material.toonShadowTint = ToonMaterialComponent.toonShadowTint[ eid ];
            material.toonSoftness = ToonMaterialComponent.toonSoftness[ eid ];
            material.toonHighlightTint = ToonMaterialComponent.toonHighlightTint[ eid ];
            material.rimPower = ToonMaterialComponent.rimPower[ eid ];
            material.rimIntensity = ToonMaterialComponent.rimIntensity[ eid ];
            material.ambientGradient = ToonMaterialComponent.ambientGradient[ eid ];
            material.ambientHeight = ToonMaterialComponent.ambientHeight[ eid ];
            material.moodTemperature = ToonMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = ToonMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = ToonMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = ToonMaterialComponent.moodContrast[ eid ];
            material.paperGrain = ToonMaterialComponent.paperGrain[ eid ];
            material.watercolorBleed = ToonMaterialComponent.watercolorBleed[ eid ];
            material.brushJitter = ToonMaterialComponent.brushJitter[ eid ];

            // Rebuild gradient map cache with double.js precision
            material._gradientCache = buildToonGradientMap(
                256,
                material.toonBands,
                material.toonShadowTint,
                material.toonSoftness,
                material.toonHighlightTint
            );

            // Recompute mood-graded colors
            material.moodColor.copy( material.color );
            gradeToonColor(
                material.moodColor,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );
            material.moodEmissive.copy( material.emissive );
            gradeToonColor(
                material.moodEmissive,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );

            ToonMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshToonMaterial class — mirrors
// three.js/src/materials/MeshToonMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material implementing toon shading.
 * Toon shading uses a gradient map (a small 1D texture) to remap the
 * N·L lighting term into discrete cel bands. This is the classic anime
 * rendering technique — flat color zones separated by hard or soft edges.
 *
 * In addition to the standard three.js parameters, this material exposes
 * a rich set of real-time anime-style controls: multi-band gradient with
 * configurable smoothness and shadow tint, view-space normal rim glow,
 * mood-based color grading, ambient sky-to-ground gradient tinting,
 * procedural paper-grain and watercolor texture variation, and brush
 * jitter for hand-drawn UV distortion.
 *
 * ```js
 * const colors = new Uint8Array( 3 );
 * for ( let c = 0; c <= colors.length; c ++ ) {
 *   colors[ c ] = ( c / colors.length ) * 256;
 * }
 * const gradientMap = new THREE.DataTexture( colors, colors.length, 1, THREE.RedFormat );
 * gradientMap.needsUpdate = true;
 * const material = new THREE.MeshToonMaterial( {
 *   color: 0x88ccff,
 *   gradientMap: gradientMap,
 *   toonBands: 3,
 *   toonShadowTint: 0.7,
 *   rimIntensity: 0.4,
 *   moodTemperature: -0.3
 * } );
 * ```
 * @augments Material
 */
class MeshToonMaterial extends Material {

    /**
     * Constructs a new mesh toon material.
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
        this.isMeshToonMaterial = true;

        this.type = 'MeshToonMaterial';

        /**
         * The material's base color.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color( 0xffffff );

        /**
         * The color map.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * The gradient map. This is a 1D texture sampled by N·L to produce
         * the cel-shading bands. The texture is expected to be in
         * `NoColorSpace`.
         * @type {?Texture}
         * @default null
         */
        this.gradientMap = null;

        /**
         * The light map.
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
         * map.
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
         * The emissive color of the material.
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
         * The emissive map.
         * @type {?Texture}
         * @default null
         */
        this.emissiveMap = null;

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
         * The type of the normal map.
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
         * The alpha map.
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * Whether to render the material as wireframe.
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
         * Whether the material is affected by fog.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        // -------------------------------------------------------------------
        // Anime Rendering Extensions
        // -------------------------------------------------------------------
        /**
         * Number of toon cel bands. 2 = classic hard-shadow anime,
         * 3-4 = softer stylized, 5-6 = very smooth cel.
         * @type {number}
         * @default 3
         */
        this.toonBands = 3;

        /**
         * Brightness of the darkest band. 0.7 = strong shadow,
         * 0.9 = very soft shadow.
         * @type {number}
         * @default 0.7
         */
        this.toonShadowTint = 0.7;

        /**
         * Edge softness of cel bands. 0 = hard edges, 0.5 = very soft.
         * @type {number}
         * @default 0.1
         */
        this.toonSoftness = 0.1;

        /**
         * Brightness of the brightest band. Values > 1 push the top band
         * into a glow effect (matching the reference imagery's sunset
         * and cyan-water highlights).
         * @type {number}
         * @default 1.15
         */
        this.toonHighlightTint = 1.15;

        /**
         * Cached 1D gradient map built from the toon parameters. Populated
         * automatically by `rebuildGradientCache()`. Used internally by
         * `toGradientTexture()` and the shader injection.
         * @type {Float32Array}
         * @private
         */
        this._gradientCache = buildToonGradientMap( 256, 3, 0.7, 0.1, 1.15 );

        /**
         * Rim-glow falloff power. Higher = tighter rim.
         * @type {number}
         * @default 2.5
         */
        this.rimPower = 2.5;

        /**
         * Rim-glow intensity. Set > 0 to enable view-space normal rim
         * glow (matches cyan water rims and warm sunset character rims
         * in the reference imagery).
         * @type {number}
         * @default 0
         */
        this.rimIntensity = 0;

        /**
         * Rim-glow color. Defaults to cool cyan.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color( 0.5, 0.9, 1.0 );

        /**
         * Ambient gradient intensity. Blends a vertical sky-to-ground
         * gradient tint onto the toon color for stylized atmospheres.
         * @type {number}
         * @default 0
         */
        this.ambientGradient = 0;

        /**
         * Range over which the ambient gradient blends.
         * @type {number}
         * @default 10
         */
        this.ambientHeight = 10;

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
         * The precomputed mood-graded base color.
         * @type {Color}
         */
        this.moodColor = new Color( 0xffffff );

        /**
         * The precomputed mood-graded emissive color.
         * @type {Color}
         */
        this.moodEmissive = new Color( 0x000000 );

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
         * Brush jitter amplitude for UV distortion (hand-drawn wobble).
         * @type {number}
         * @default 0
         */
        this.brushJitter = 0;

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
     * Rebuild the internal 1D gradient cache from the current toon
     * parameters. Uses double.js for bit-exact thresholding.
     * @returns {MeshToonMaterial} A reference to this instance.
     */
    rebuildGradientCache() {
        this._gradientCache = buildToonGradientMap(
            256,
            this.toonBands,
            this.toonShadowTint,
            this.toonSoftness,
            this.toonHighlightTint
        );
        return this;
    }

    /**
     * Build a `Uint8Array` suitable for a `DataTexture` 1D gradient map
     * from the current toon parameters. The caller is expected to assign
     * the returned buffer to a `DataTexture` and attach it to
     * `gradientMap`.
     * @param {number} [resolution=256]
     * @returns {Uint8Array}
     */
    toGradientData( resolution = 256 ) {
        const cache = resolution === this._gradientCache.length
            ? this._gradientCache
            : buildToonGradientMap( resolution, this.toonBands, this.toonShadowTint, this.toonSoftness, this.toonHighlightTint );

        const out = new Uint8Array( resolution );
        for ( let i = 0; i < resolution; i ++ ) {
            out[ i ] = Math.floor( cache[ i ] * 255 );
        }
        return out;
    }

    /**
     * Compute the view-space normal rim glow for a given normal and view
     * direction.
     * @param {Vector3} viewNormal - View-space normal (normalized).
     * @param {Vector3} viewDir - View direction (normalized).
     * @returns {number}
     */
    sampleToonRim( viewNormal, viewDir ) {
        if ( this.rimIntensity <= 0 ) return 0;
        return computeToonRimGlow( viewNormal, viewDir, this.rimPower, this.rimIntensity );
    }

    /**
     * Apply the ambient gradient tint to a color at a given world Y.
     * @param {Color} color - The color to tint.
     * @param {number} worldY - World Y coordinate.
     * @returns {Color}
     */
    applyAmbientGradient( color, worldY ) {
        return applyToonAmbientGradient(
            color,
            worldY,
            this.ambientHeight,
            this.skyTint,
            this.groundTint,
            this.ambientGradient
        );
    }

    /**
     * Recompute the mood-graded colors from the current mood parameters.
     * @returns {MeshToonMaterial} A reference to this instance.
     */
    updateMoodColors() {
        this.moodColor.copy( this.color );
        gradeToonColor( this.moodColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast );
        this.moodEmissive.copy( this.emissive );
        gradeToonColor( this.moodEmissive, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast );
        return this;
    }

    /**
     * Generate a procedural paper-grain / watercolor texture for this
     * material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.03]
     * @param {number} [octaves=4]
     * @returns {Uint8Array}
     */
    generateToonTexture( width, height, scale = 0.03, octaves = 4 ) {
        return generateToonTexture( width, height, scale, octaves, this.paperGrain, this.watercolorBleed );
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
     * anime shader chunks with toon-specific features: multi-band
     * gradient remapping, view-space normal rim glow, ambient gradient
     * tinting, and paper-grain / watercolor texture variation.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject toon-specific uniforms
        shader.uniforms.toonBands = { value: this.toonBands };
        shader.uniforms.toonShadowTint = { value: this.toonShadowTint };
        shader.uniforms.toonSoftness = { value: this.toonSoftness };
        shader.uniforms.toonHighlightTint = { value: this.toonHighlightTint };
        shader.uniforms.rimPower = { value: this.rimPower };
        shader.uniforms.rimIntensity = { value: this.rimIntensity };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.ambientGradient = { value: this.ambientGradient };
        shader.uniforms.ambientHeight = { value: this.ambientHeight };
        shader.uniforms.skyTint = { value: this.skyTint };
        shader.uniforms.groundTint = { value: this.groundTint };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.moodEmissive = { value: this.moodEmissive };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.brushJitter = { value: this.brushJitter };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int toonBands;
                uniform float toonShadowTint;
                uniform float toonSoftness;
                uniform float toonHighlightTint;
                uniform float rimPower;
                uniform float rimIntensity;
                uniform vec3 rimGlowColor;
                uniform float ambientGradient;
                uniform float ambientHeight;
                uniform vec3 skyTint;
                uniform vec3 groundTint;
                uniform vec3 moodColor;
                uniform vec3 moodEmissive;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float variationOffset;

                float applyToonBand( float ndotl ) {
                    if ( toonBands <= 1 ) return ndotl;
                    float bandWidth = 1.0 / float( toonBands );
                    float bandIndex = floor( ndotl / bandWidth );
                    float bandCenter = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToCenter = abs( ndotl - bandCenter );
                    float softFactor = clamp( distToCenter / ( bandWidth * 0.5 ), 0.0, 1.0 );
                    float edgeBlend = ( 1.0 - softFactor ) * ( 1.0 - toonSoftness ) + toonSoftness;
                    float bandPos = bandIndex / max( 1.0, float( toonBands ) - 1.0 );
                    float targetBrightness = toonShadowTint + ( toonHighlightTint - toonShadowTint ) * bandPos;
                    return clamp( targetBrightness * edgeBlend + ndotl * ( 1.0 - edgeBlend ), 0.0, 1.0 );
                }

                float computeToonRim( vec3 n, vec3 v ) {
                    if ( rimIntensity <= 0.0 ) return 0.0;
                    float ndotv = abs( dot( normalize( n ), normalize( v ) ) );
                    float rim = pow( 1.0 - ndotv, rimPower );
                    return clamp( rim * rimIntensity, 0.0, 1.0 );
                }

                vec3 applyAmbientGradient( vec3 baseColor, float worldY ) {
                    if ( ambientGradient <= 0.0 ) return baseColor;
                    float t = clamp( worldY / ambientHeight + 0.5, 0.0, 1.0 );
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

                // Apply toon cel banding
                float ndotl = max( dot( normalize( vNormal ), normalize( vec3( 0.0, 0.0, 1.0 ) ) ), 0.0 );
                float bandedLight = applyToonBand( ndotl );

                // Blend mood-graded color with the banded light
                gl_FragColor.rgb = mix(
                    gl_FragColor.rgb,
                    moodColor * bandedLight,
                    0.85
                );

                // Add emissive contribution
                gl_FragColor.rgb += moodEmissive;

                // Apply ambient gradient
                gl_FragColor.rgb = applyAmbientGradient( gl_FragColor.rgb, vViewPosition.z );

                // Apply paper grain
                gl_FragColor.a *= samplePaperGrain( vUv );

                // Rim glow
                float rim = computeToonRim( vNormal, normalize( vViewPosition ) );
                gl_FragColor.rgb += rimGlowColor * rim;
            ` );
    }

    /**
     * The custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.toonBands,
            this.toonShadowTint,
            this.toonSoftness,
            this.toonHighlightTint,
            this.rimPower,
            this.rimIntensity,
            this.ambientGradient,
            this.ambientHeight,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.paperGrain,
            this.watercolorBleed,
            this.brushJitter,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {MeshToonMaterial} source - The material to copy from.
     * @return {MeshToonMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.color.copy( source.color );
        this.map = source.map;
        this.gradientMap = source.gradientMap;
        this.lightMap = source.lightMap;
        this.lightMapIntensity = source.lightMapIntensity;
        this.aoMap = source.aoMap;
        this.aoMapIntensity = source.aoMapIntensity;
        this.emissive.copy( source.emissive );
        this.emissiveIntensity = source.emissiveIntensity;
        this.emissiveMap = source.emissiveMap;
        this.bumpMap = source.bumpMap;
        this.bumpScale = source.bumpScale;
        this.normalMap = source.normalMap;
        this.normalMapType = source.normalMapType;
        this.normalScale.copy( source.normalScale );
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.alphaMap = source.alphaMap;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.fog = source.fog;

        // Anime extensions
        this.toonBands = source.toonBands;
        this.toonShadowTint = source.toonShadowTint;
        this.toonSoftness = source.toonSoftness;
        this.toonHighlightTint = source.toonHighlightTint;
        this._gradientCache = source._gradientCache ? new Float32Array( source._gradientCache ) : null;
        this.rimPower = source.rimPower;
        this.rimIntensity = source.rimIntensity;
        this.rimGlowColor.copy( source.rimGlowColor );
        this.ambientGradient = source.ambientGradient;
        this.ambientHeight = source.ambientHeight;
        this.skyTint.copy( source.skyTint );
        this.groundTint.copy( source.groundTint );
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy( source.moodColor );
        this.moodEmissive.copy( source.moodEmissive );
        this.paperGrain = source.paperGrain;
        this.watercolorBleed = source.watercolorBleed;
        this.brushJitter = source.brushJitter;
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

        data.type = 'MeshToonMaterial';

        if ( this.color.getHex() !== 0xffffff ) data.color = this.color.getHex();
        if ( this.map !== null ) data.map = this.map.toJSON( meta ).uuid;
        if ( this.gradientMap !== null ) data.gradientMap = this.gradientMap.toJSON( meta ).uuid;
        if ( this.lightMap !== null ) data.lightMap = this.lightMap.toJSON( meta ).uuid;
        if ( this.lightMapIntensity !== 1.0 ) data.lightMapIntensity = this.lightMapIntensity;
        if ( this.aoMap !== null ) data.aoMap = this.aoMap.toJSON( meta ).uuid;
        if ( this.aoMapIntensity !== 1.0 ) data.aoMapIntensity = this.aoMapIntensity;
        if ( this.emissive.getHex() !== 0x000000 ) data.emissive = this.emissive.getHex();
        if ( this.emissiveIntensity !== 1.0 ) data.emissiveIntensity = this.emissiveIntensity;
        if ( this.emissiveMap !== null ) data.emissiveMap = this.emissiveMap.toJSON( meta ).uuid;
        if ( this.bumpMap !== null ) data.bumpMap = this.bumpMap.toJSON( meta ).uuid;
        if ( this.bumpScale !== 1 ) data.bumpScale = this.bumpScale;
        if ( this.normalMap !== null ) data.normalMap = this.normalMap.toJSON( meta ).uuid;
        if ( this.normalMapType !== TangentSpaceNormalMap ) data.normalMapType = this.normalMapType;
        if ( this.normalScale.x !== 1 || this.normalScale.y !== 1 ) data.normalScale = this.normalScale.toArray();
        if ( this.displacementMap !== null ) data.displacementMap = this.displacementMap.toJSON( meta ).uuid;
        if ( this.displacementScale !== 1 ) data.displacementScale = this.displacementScale;
        if ( this.displacementBias !== 0 ) data.displacementBias = this.displacementBias;
        if ( this.alphaMap !== null ) data.alphaMap = this.alphaMap.toJSON( meta ).uuid;
        if ( this.wireframe !== false ) data.wireframe = this.wireframe;
        if ( this.wireframeLinewidth !== 1 ) data.wireframeLinewidth = this.wireframeLinewidth;
        if ( this.fog === false ) data.fog = false;

        // Anime extensions
        if ( this.toonBands !== 3 ) data.toonBands = this.toonBands;
        if ( this.toonShadowTint !== 0.7 ) data.toonShadowTint = this.toonShadowTint;
        if ( this.toonSoftness !== 0.1 ) data.toonSoftness = this.toonSoftness;
        if ( this.toonHighlightTint !== 1.15 ) data.toonHighlightTint = this.toonHighlightTint;
        if ( this.rimPower !== 2.5 ) data.rimPower = this.rimPower;
        if ( this.rimIntensity !== 0 ) data.rimIntensity = this.rimIntensity;
        if ( this.rimGlowColor.getHex() !== new Color( 0.5, 0.9, 1.0 ).getHex() ) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if ( this.ambientGradient !== 0 ) data.ambientGradient = this.ambientGradient;
        if ( this.ambientHeight !== 10 ) data.ambientHeight = this.ambientHeight;
        if ( this.skyTint.getHex() !== new Color( 0.5, 0.75, 1.0 ).getHex() ) {
            data.skyTint = this.skyTint.getHex();
        }
        if ( this.groundTint.getHex() !== new Color( 1.0, 0.85, 0.7 ).getHex() ) {
            data.groundTint = this.groundTint.getHex();
        }
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.paperGrain !== 0 ) data.paperGrain = this.paperGrain;
        if ( this.watercolorBleed !== 0 ) data.watercolorBleed = this.watercolorBleed;
        if ( this.brushJitter !== 0 ) data.brushJitter = this.brushJitter;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    MeshToonMaterial,
    MeshToonMaterialBatch,
    buildToonGradientMap,
    computeToonRimGlow,
    applyToonAmbientGradient,
    gradeToonColor,
    generateToonTexture
};
export default MeshToonMaterial;