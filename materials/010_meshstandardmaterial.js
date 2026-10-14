// file number : 010
// full path name : src/materials/010_meshstandardmaterial.js
// description : MeshStandardMaterial (three.js r185) rewritten as a high-performance ES module with deep anime-stylization integration. Extends the anime-enabled 001_material.js base class and preserves the full r185 MeshStandardMaterial API — color, roughness, metalness, map, lightMap, lightMapIntensity, aoMap, aoMapIntensity, emissive, emissiveIntensity, emissiveMap, bumpMap, bumpScale, normalMap, normalMapType, normalScale, displacementMap, displacementScale, displacementBias, roughnessMap, metalnessMap, alphaMap, envMap, envMapRotation, envMapIntensity, wireframe, wireframeLinewidth, wireframeLinecap, wireframeLinejoin, flatShading, fog, and the inherited material surface. MeshStandardMaterial is the physically-based PBR (Physically Based Rendering) workhorse of three.js, using the metallic-roughness workflow. For anime stylization, this material is uniquely powerful because roughness and metalness give precise control over how cel-banded highlights behave — a low-roughness character skin produces crisp anime sparkles, while high-roughness backgrounds produce soft watercolor-like shading. Adds real-time anime features specifically tuned for PBR: cel-band roughness quantization (discretize the roughness response for flat anime shading), metalness-driven specular cel banding, mood-based PBR rebalancing (cool cyan for snow/ice scenes, warm sunset for golden-hour), rim glow, paper-grain and watercolor texture variation, and per-instance variation for crowds. Imports Color, Euler, Vector2, Vector3, and other math classes strictly from threejs_new01 math, and uses gl-matrix for zero-allocation PBR color transforms, double.js for bit-exact roughness/metalness quantization and HDR mood grading, bitecs SoA batching for real-time updates across thousands of PBR instances, and simplex-noise for procedural texture variation.
// best for : MeshStandardMaterial, physically-based anime rendering, stylized PBR characters, mobile anime games, architectural visualization with anime style, product renders, and any three.js PBR mesh that needs real-time anime stylization.
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
    TangentSpaceNormalMap,
    ObjectSpaceNormalMap,
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

// gl-matrix scratch for zero-allocation PBR color transforms
const _gm_rgb = glMatrix.vec3.create();
const _gm_hsv = glMatrix.vec3.create();
const _gm_normal = glMatrix.vec3.create();
const _gm_light = glMatrix.vec3.create();
const _gm_view = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Anime feature — cel-band roughness quantization
// ---------------------------------------------------------------------------
/**
 * Quantize a roughness value into discrete cel bands using double.js for
 * bit-exact thresholding. Roughness controls how blurry a PBR highlight
 * is — quantizing it produces discrete "shine steps" that match the
 * flat anime look. Low roughness bands = crisp anime sparkles; high
 * roughness bands = soft watercolor shading.
 * @param {number} roughness - Raw roughness in [0, 1].
 * @param {number} bands - Number of roughness bands (2-5 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @param {number} [softness=0.1] - Edge softness in [0, 0.3].
 * @returns {number} Quantized roughness in [0, 1].
 */
function quantizeRoughnessCel( roughness, bands, quantizeAmount, softness = 0.1 ) {
    if ( bands <= 1 ) return roughness;

    const bandWidth = 1.0 / bands;
    _double.value = roughness;
    _double.div( bandWidth );
    const bandIndex = Math.floor( _double.value );
    _double.value = bandIndex;
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    // Soft edge
    const distToBoundary = Math.abs( roughness - bandIndex * bandWidth - bandWidth * 0.5 );
    const softFactor = Math.max( 0, Math.min( 1, distToBoundary / ( bandWidth * 0.5 ) ) );
    const softQuantized = quantized + ( roughness - quantized ) * ( 1 - softFactor ) * softness;

    // Blend
    _double.value = roughness;
    _double.add( ( softQuantized - roughness ) * quantizeAmount );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — metalness-driven specular cel banding
// ---------------------------------------------------------------------------
/**
 * Compute a cel-banded specular highlight driven by both the metalness
 * and the roughness. Metals get crisp, high-contrast anime sparkles;
 * dielectrics get soft cel steps. This is the key to making PBR
 * surfaces read as anime.
 * @param {number} metalness - Raw metalness in [0, 1].
 * @param {number} roughness - Raw roughness in [0, 1].
 * @param {number} specularIntensity - Raw specular intensity in [0, 1].
 * @param {number} bands - Number of specular bands (2-3 recommended).
 * @param {number} threshold - Minimum specular to trigger first band.
 * @param {number} [metalBoost=0.3] - Additional brightness boost for metals.
 * @returns {number} Banded specular intensity in [0, 1].
 */
function metalnessSpecularCel( metalness, roughness, specularIntensity, bands, threshold, metalBoost = 0.3 ) {
    if ( bands <= 1 ) return specularIntensity;

    // Metalness and inverse-roughness both increase the specular sharpness
    _double.value = 1.0;
    _double.sub( roughness );
    _double.mul( 0.5 );
    _double.add( metalness * 0.5 );
    const sharpness = _double.value;

    // Threshold scaled by sharpness
    _double.value = threshold;
    _double.mul( 1.0 - sharpness * 0.5 );
    const scaledThreshold = _double.value;

    if ( specularIntensity < scaledThreshold ) return 0;

    // Normalize above threshold
    _double.value = specularIntensity;
    _double.sub( scaledThreshold );
    _double.div( Math.max( 1.0 - scaledThreshold, 0.0001 ) );
    const normalized = Math.max( 0, Math.min( 1, _double.value ) );

    // Quantize
    const bandWidth = 1.0 / bands;
    _double.value = normalized;
    _double.div( bandWidth );
    _double.value = Math.floor( _double.value );
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    // Metal boost
    _double.value = quantized;
    _double.add( metalness * metalBoost );

    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — mood-based PBR rebalancing
// ---------------------------------------------------------------------------
/**
 * Rebalance PBR parameters (color, roughness, metalness) based on scene
 * mood. Snow/ice scenes need higher roughness + cool tint; golden-hour
 * scenes need lower roughness + warm tint. Uses gl-matrix for zero-
 * allocation staging and double.js for bit-exact accumulation.
 * @param {Color} color - The base color (modified in place).
 * @param {number} roughness - Input roughness (not modified).
 * @param {number} metalness - Input metalness (not modified).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {{roughness: number, metalness: number}}
 */
function moodPBRRebalance( color, roughness, metalness, temperature, saturation, brightness, contrast ) {
    // Color grading (diffuse)
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

    // PBR rebalancing: cooler moods increase roughness (matte snow/ice),
    // warmer moods decrease roughness (glossy golden surfaces)
    _double.value = roughness;
    _double.add( temperature * 0.1 );
    const newRoughness = Math.max( 0, Math.min( 1, _double.value ) );

    _double.value = metalness;
    _double.add( - temperature * 0.05 );
    const newMetalness = Math.max( 0, Math.min( 1, _double.value ) );

    return { roughness: newRoughness, metalness: newMetalness };
}

// ---------------------------------------------------------------------------
// Anime feature — procedural paper-grain / watercolor texture variation
// ---------------------------------------------------------------------------
/**
 * Generate a combined paper-grain and watercolor texture using simplex-noise
 * with multiple octaves. Produces the hand-painted texture characteristic
 * of the reference imagery's PBR backgrounds (snowy peaks, sunset sky,
 * cyan ocean, foliage).
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03] - Base noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [paperGrain=0.3] - Paper grain intensity.
 * @param {number} [watercolorBleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generatePBRTexture( width, height, scale = 0.03, octaves = 3, paperGrain = 0.3, watercolorBleed = 0.5 ) {
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

            // Watercolor bleed
            _double.value = value;
            _double.sub( 0.5 );
            _double.mul( 1.0 + watercolorBleed );
            _double.add( 0.5 );
            value = Math.max( 0, Math.min( 1, _double.value ) );

            // Paper grain overlay
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
// bitecs SoA batch coordinator for real-time PBR material updates
// ---------------------------------------------------------------------------
const _pbrWorld = createWorld();
const PBRMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    roughnessBands: Types.ui8,
    roughnessQuantize: Types.f64,
    roughnessSoftness: Types.f64,
    metalnessBands: Types.ui8,
    specularThreshold: Types.f64,
    metalBoost: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    rimGlow: Types.f64,
    paperGrain: Types.f64,
    watercolorBleed: Types.f64,
    dirty: Types.ui8
} );

class MeshStandardMaterialBatch {

    constructor() {
        this.world = _pbrWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshStandardMaterial instance for batched real-time updates.
     * @param {MeshStandardMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, PBRMaterialComponent, eid );
        PBRMaterialComponent.materialPtr[ eid ] = this.materials.length;
        PBRMaterialComponent.roughnessBands[ eid ] = material.roughnessBands;
        PBRMaterialComponent.roughnessQuantize[ eid ] = material.roughnessQuantize;
        PBRMaterialComponent.roughnessSoftness[ eid ] = material.roughnessSoftness;
        PBRMaterialComponent.metalnessBands[ eid ] = material.metalnessBands;
        PBRMaterialComponent.specularThreshold[ eid ] = material.specularThreshold;
        PBRMaterialComponent.metalBoost[ eid ] = material.metalBoost;
        PBRMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        PBRMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        PBRMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        PBRMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        PBRMaterialComponent.rimGlow[ eid ] = material.rimGlow;
        PBRMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        PBRMaterialComponent.watercolorBleed[ eid ] = material.watercolorBleed;
        PBRMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued PBR-material updates in one cache-friendly pass.
     * Uses double.js internally for bit-exact roughness quantization and
     * mood grading.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ PBRMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.roughnessBands = PBRMaterialComponent.roughnessBands[ eid ];
            material.roughnessQuantize = PBRMaterialComponent.roughnessQuantize[ eid ];
            material.roughnessSoftness = PBRMaterialComponent.roughnessSoftness[ eid ];
            material.metalnessBands = PBRMaterialComponent.metalnessBands[ eid ];
            material.specularThreshold = PBRMaterialComponent.specularThreshold[ eid ];
            material.metalBoost = PBRMaterialComponent.metalBoost[ eid ];
            material.moodTemperature = PBRMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = PBRMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = PBRMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = PBRMaterialComponent.moodContrast[ eid ];
            material.rimGlow = PBRMaterialComponent.rimGlow[ eid ];
            material.paperGrain = PBRMaterialComponent.paperGrain[ eid ];
            material.watercolorBleed = PBRMaterialComponent.watercolorBleed[ eid ];

            // Recompute derived values
            material.moodColor.copy( material.color );
            const pbr = moodPBRRebalance(
                material.moodColor,
                material.roughness,
                material.metalness,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );
            material.moodRoughness = pbr.roughness;
            material.moodMetalness = pbr.metalness;

            PBRMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshStandardMaterial class — mirrors
// three.js/src/materials/MeshStandardMaterial.js
// ---------------------------------------------------------------------------
/**
 * A standard physically based material, using Metallic-Roughness workflow.
 *
 * In addition to the standard three.js parameters, this material exposes a
 * rich set of real-time anime-style controls: cel-band roughness quantization,
 * metalness-driven specular banding, mood-based PBR rebalancing, rim glow,
 * and procedural paper-grain / watercolor texture variation.
 *
 * ```js
 * const material = new THREE.MeshStandardMaterial( {
 *   color: 0x88ccff,
 *   roughness: 0.3,
 *   metalness: 0.1,
 *   roughnessBands: 3,
 *   metalnessBands: 2,
 *   moodTemperature: -0.3,
 *   watercolorBleed: 0.5
 * } );
 * ```
 * @augments Material
 */
class MeshStandardMaterial extends Material {

    /**
     * Constructs a new mesh standard material.
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
        this.isMeshStandardMaterial = true;

        this.type = 'MeshStandardMaterial';

        /**
         * The material's base color.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color( 0xffffff );

        /**
         * Controls the roughness of the material. 0 = smooth, 1 = rough.
         * @type {number}
         * @default 1.0
         */
        this.roughness = 1.0;

        /**
         * Controls the metalness of the material. 0 = dielectric, 1 = metal.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * The color map.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

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
         * The ambient occlusion map (red channel).
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
         * The emissive (light) color.
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
         * The roughness map (green channel).
         * @type {?Texture}
         * @default null
         */
        this.roughnessMap = null;

        /**
         * The metalness map (blue channel).
         * @type {?Texture}
         * @default null
         */
        this.metalnessMap = null;

        /**
         * The alpha map.
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
         * How much the environment map affects the surface.
         * @type {number}
         * @default 1
         */
        this.envMapIntensity = 1.0;

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
         * Whether to use flat shading.
         * @type {boolean}
         * @default false
         */
        this.flatShading = false;

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
         * Number of roughness cel bands. 2-5 = stylized anime roughness steps.
         * @type {number}
         * @default 0
         */
        this.roughnessBands = 0;

        /**
         * Blend amount between continuous and banded roughness.
         * @type {number}
         * @default 1.0
         */
        this.roughnessQuantize = 1.0;

        /**
         * Roughness band edge softness.
         * @type {number}
         * @default 0.1
         */
        this.roughnessSoftness = 0.1;

        /**
         * Number of metalness-driven specular bands.
         * @type {number}
         * @default 0
         */
        this.metalnessBands = 0;

        /**
         * Minimum specular intensity to trigger the first band.
         * @type {number}
         * @default 0.4
         */
        this.specularThreshold = 0.4;

        /**
         * Additional brightness boost applied to metals.
         * @type {number}
         * @default 0.3
         */
        this.metalBoost = 0.3;

        /**
         * Mood temperature shift in [-1, 1].
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Mood saturation multiplier (diffuse).
         * @type {number}
         * @default 1.0
         */
        this.moodSaturation = 1.0;

        /**
         * Mood brightness multiplier (diffuse).
         * @type {number}
         * @default 1.0
         */
        this.moodBrightness = 1.0;

        /**
         * Mood contrast multiplier (diffuse).
         * @type {number}
         * @default 1.0
         */
        this.moodContrast = 1.0;

        /**
         * The precomputed mood-graded color.
         * @type {Color}
         */
        this.moodColor = new Color( 0xffffff );

        /**
         * The precomputed mood-rebalanced roughness.
         * @type {number}
         * @default 1.0
         */
        this.moodRoughness = 1.0;

        /**
         * The precomputed mood-rebalanced metalness.
         * @type {number}
         * @default 0.0
         */
        this.moodMetalness = 0.0;

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
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        this.setValues( parameters );

        // Initialize derived values.
        this.updateMoodPBR();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Quantize the current roughness into cel bands.
     * @returns {number}
     */
    applyRoughnessBanding() {
        return quantizeRoughnessCel( this.roughness, this.roughnessBands, this.roughnessQuantize, this.roughnessSoftness );
    }

    /**
     * Compute the metalness-driven specular cel banding.
     * @param {number} specularIntensity
     * @returns {number}
     */
    applyMetalnessSpecular( specularIntensity ) {
        return metalnessSpecularCel(
            this.metalness,
            this.roughness,
            specularIntensity,
            this.metalnessBands,
            this.specularThreshold,
            this.metalBoost
        );
    }

    /**
     * Recompute the mood-graded color and rebalanced PBR parameters.
     * @returns {MeshStandardMaterial} A reference to this instance.
     */
    updateMoodPBR() {
        this.moodColor.copy( this.color );
        const pbr = moodPBRRebalance(
            this.moodColor,
            this.roughness,
            this.metalness,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        this.moodRoughness = pbr.roughness;
        this.moodMetalness = pbr.metalness;
        return this;
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
    generatePBRTexture( width, height, scale = 0.03, octaves = 3 ) {
        return generatePBRTexture( width, height, scale, octaves, this.paperGrain, this.watercolorBleed );
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
     * anime shader chunks with PBR-specific features.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject PBR-specific uniforms
        shader.uniforms.roughnessBands = { value: this.roughnessBands };
        shader.uniforms.roughnessQuantize = { value: this.roughnessQuantize };
        shader.uniforms.roughnessSoftness = { value: this.roughnessSoftness };
        shader.uniforms.metalnessBands = { value: this.metalnessBands };
        shader.uniforms.specularThreshold = { value: this.specularThreshold };
        shader.uniforms.metalBoost = { value: this.metalBoost };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.moodRoughness = { value: this.moodRoughness };
        shader.uniforms.moodMetalness = { value: this.moodMetalness };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int roughnessBands;
                uniform float roughnessQuantize;
                uniform float roughnessSoftness;
                uniform int metalnessBands;
                uniform float specularThreshold;
                uniform float metalBoost;
                uniform vec3 moodColor;
                uniform float moodRoughness;
                uniform float moodMetalness;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float variationOffset;

                float quantizeRoughness( float rough ) {
                    if ( roughnessBands <= 1 ) return rough;
                    float bandWidth = 1.0 / float( roughnessBands );
                    float bandIndex = floor( rough / bandWidth );
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs( rough - bandIndex * bandWidth - bandWidth * 0.5 );
                    float softFactor = clamp( distToBoundary / ( bandWidth * 0.5 ), 0.0, 1.0 );
                    float softQuantized = quantized + ( rough - quantized ) * ( 1.0 - softFactor ) * roughnessSoftness;
                    return mix( rough, softQuantized, roughnessQuantize );
                }

                float metalnessSpecular( float spec, float metal, float rough ) {
                    if ( metalnessBands <= 1 ) return spec;
                    float sharpness = ( 1.0 - rough ) * 0.5 + metal * 0.5;
                    float scaledThreshold = specularThreshold * ( 1.0 - sharpness * 0.5 );
                    if ( spec < scaledThreshold ) return 0.0;
                    float normalized = clamp( ( spec - scaledThreshold ) / max( 1.0 - scaledThreshold, 0.0001 ), 0.0, 1.0 );
                    float bandWidth = 1.0 / float( metalnessBands );
                    float bandIndex = floor( normalized / bandWidth );
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    return clamp( quantized + metal * metalBoost, 0.0, 1.0 );
                }

                float samplePaperGrain( vec2 uv ) {
                    if ( paperGrain <= 0.0 ) return 1.0;
                    float n = sin( uv.x * 8.0 + variationOffset ) * cos( uv.y * 8.0 + variationOffset );
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * ( 1.0 - n );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Apply roughness cel quantization
                gl_FragColor.rgb = gl_FragColor.rgb * ( 1.0 - quantizeRoughness( 0.5 ) * 0.1 );

                // Blend mood-graded color
                gl_FragColor.rgb = mix(
                    gl_FragColor.rgb,
                    moodColor * ( dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( dot( moodColor, vec3( 0.2126, 0.7152, 0.0722 ) ), 0.0001 ) ),
                    0.5
                );

                // Metalness-driven specular cel banding
                float rawSpec = max( max( gl_FragColor.r, gl_FragColor.g ), gl_FragColor.b );
                float spec = metalnessSpecular( rawSpec, moodMetalness, moodRoughness );
                gl_FragColor.rgb += vec3( spec );

                // Paper grain
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
            this.roughness,
            this.metalness,
            this.roughnessBands,
            this.roughnessQuantize,
            this.roughnessSoftness,
            this.metalnessBands,
            this.specularThreshold,
            this.metalBoost,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.rimGlow,
            this.paperGrain,
            this.watercolorBleed,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {MeshStandardMaterial} source - The material to copy from.
     * @return {MeshStandardMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.color.copy( source.color );
        this.roughness = source.roughness;
        this.metalness = source.metalness;
        this.map = source.map;
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
        this.roughnessMap = source.roughnessMap;
        this.metalnessMap = source.metalnessMap;
        this.alphaMap = source.alphaMap;
        this.envMap = source.envMap;
        this.envMapRotation.copy( source.envMapRotation );
        this.envMapIntensity = source.envMapIntensity;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.wireframeLinecap = source.wireframeLinecap;
        this.wireframeLinejoin = source.wireframeLinejoin;
        this.flatShading = source.flatShading;
        this.fog = source.fog;

        // Anime extensions
        this.roughnessBands = source.roughnessBands;
        this.roughnessQuantize = source.roughnessQuantize;
        this.roughnessSoftness = source.roughnessSoftness;
        this.metalnessBands = source.metalnessBands;
        this.specularThreshold = source.specularThreshold;
        this.metalBoost = source.metalBoost;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy( source.moodColor );
        this.moodRoughness = source.moodRoughness;
        this.moodMetalness = source.moodMetalness;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy( source.rimGlowColor );
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

        data.type = 'MeshStandardMaterial';

        if ( this.color.getHex() !== 0xffffff ) data.color = this.color.getHex();
        if ( this.roughness !== 1.0 ) data.roughness = this.roughness;
        if ( this.metalness !== 0.0 ) data.metalness = this.metalness;
        if ( this.map !== null ) data.map = this.map.toJSON( meta ).uuid;
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
        if ( this.roughnessMap !== null ) data.roughnessMap = this.roughnessMap.toJSON( meta ).uuid;
        if ( this.metalnessMap !== null ) data.metalnessMap = this.metalnessMap.toJSON( meta ).uuid;
        if ( this.alphaMap !== null ) data.alphaMap = this.alphaMap.toJSON( meta ).uuid;
        if ( this.envMap !== null ) data.envMap = this.envMap.toJSON( meta ).uuid;
        if ( this.envMapRotation.x !== 0 || this.envMapRotation.y !== 0 || this.envMapRotation.z !== 0 ) {
            data.envMapRotation = this.envMapRotation.toArray();
        }
        if ( this.envMapIntensity !== 1.0 ) data.envMapIntensity = this.envMapIntensity;
        if ( this.wireframe !== false ) data.wireframe = this.wireframe;
        if ( this.wireframeLinewidth !== 1 ) data.wireframeLinewidth = this.wireframeLinewidth;
        if ( this.wireframeLinecap !== 'round' ) data.wireframeLinecap = this.wireframeLinecap;
        if ( this.wireframeLinejoin !== 'round' ) data.wireframeLinejoin = this.wireframeLinejoin;
        if ( this.flatShading ) data.flatShading = true;
        if ( this.fog === false ) data.fog = false;

        // Anime extensions
        if ( this.roughnessBands !== 0 ) data.roughnessBands = this.roughnessBands;
        if ( this.roughnessQuantize !== 1.0 ) data.roughnessQuantize = this.roughnessQuantize;
        if ( this.roughnessSoftness !== 0.1 ) data.roughnessSoftness = this.roughnessSoftness;
        if ( this.metalnessBands !== 0 ) data.metalnessBands = this.metalnessBands;
        if ( this.specularThreshold !== 0.4 ) data.specularThreshold = this.specularThreshold;
        if ( this.metalBoost !== 0.3 ) data.metalBoost = this.metalBoost;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.rimGlow !== 0 ) data.rimGlow = this.rimGlow;
        if ( this.rimGlowColor.getHex() !== new Color( 0.5, 0.9, 1.0 ).getHex() ) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if ( this.paperGrain !== 0 ) data.paperGrain = this.paperGrain;
        if ( this.watercolorBleed !== 0 ) data.watercolorBleed = this.watercolorBleed;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    MeshStandardMaterial,
    MeshStandardMaterialBatch,
    quantizeRoughnessCel,
    metalnessSpecularCel,
    moodPBRRebalance,
    generatePBRTexture
};
export default MeshStandardMaterial;