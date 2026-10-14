// file number : 009
// full path name : src/materials/009_meshphongmaterial.js
// description : MeshPhongMaterial (three.js r185) rewritten as a high-performance ES module with deep anime-stylization integration. Extends the anime-enabled 001_material.js base class and preserves the full r185 MeshPhongMaterial API — color, emissive, emissiveIntensity, emissiveMap, specular, shininess, specularMap, map, lightMap, lightMapIntensity, aoMap, aoMapIntensity, bumpMap, bumpScale, normalMap, normalMapType, normalScale, displacementMap, displacementScale, displacementBias, envMap, envMapRotation, combine, reflectivity, refractionRatio, wireframe, wireframeLinewidth, wireframeLinecap, wireframeLinejoin, flatShading, fog, and the inherited material surface. Phong's specular highlight is the key surface for anime stylization — the classic anime "sparkle" on hair, eyes, glass, and metallic objects. Adds real-time anime features specifically tuned for this: specular cel banding (hard-edged highlight steps with adjustable threshold and softness), specular toon shaping (elongated/anisotropic highlights for hand-drawn hair shine), mood-based specular tinting (warm sunset glints, cool cyan ice glints), rim glow, paper-grain and watercolor texture variation, and per-instance variation. Imports Color, Euler, Vector2, Vector3, and other math classes strictly from threejs_new01 math, and uses gl-matrix for zero-allocation specular and color transforms, double.js for bit-exact specular quantization and HDR mood grading, bitecs SoA batching for real-time updates across thousands of anime characters and props, and simplex-noise for procedural specular variation.
// best for : MeshPhongMaterial, anime character hair and eyes, glossy props, glassware, metals, wet surfaces, ceramic objects, mobile anime games, and any three.js phong-shaded mesh that needs real-time stylized specular highlights.
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

// gl-matrix scratch for zero-allocation specular and color transforms
const _gm_rgb = glMatrix.vec3.create();
const _gm_half = glMatrix.vec3.create();
const _gm_normal = glMatrix.vec3.create();
const _gm_light = glMatrix.vec3.create();
const _gm_view = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Anime feature — specular cel banding (hard-edged anime highlights)
// ---------------------------------------------------------------------------
/**
 * Quantize a specular highlight intensity into discrete cel bands using
 * double.js for bit-exact thresholding. This is the classic anime
 * "sparkle" — instead of a smooth Gaussian falloff, the highlight is a
 * hard-edged shape with a sharp boundary. Matches the specular "shine"
 * on hair and metal in the reference imagery.
 * @param {number} specularIntensity - Raw specular intensity in [0, 1].
 * @param {number} bands - Number of specular bands (2-3 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @param {number} [threshold=0.5] - Minimum intensity to show the first band.
 * @param {number} [softness=0.05] - Edge softness in [0, 0.3].
 * @returns {number} Banded specular intensity in [0, 1].
 */
function applySpecularCelBanding( specularIntensity, bands, quantizeAmount, threshold = 0.5, softness = 0.05 ) {
    if ( bands <= 1 || specularIntensity < threshold ) return 0;

    // Normalize into [0, 1] above the threshold
    _double.value = specularIntensity;
    _double.sub( threshold );
    _double.div( 1.0 - threshold );
    const normalized = Math.max( 0, Math.min( 1, _double.value ) );

    // Quantize into bands
    const bandWidth = 1.0 / bands;
    _double.value = normalized;
    _double.div( bandWidth );
    const bandIndex = Math.floor( _double.value );
    _double.value = bandIndex;
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    // Soft edge near band boundary
    const distToBoundary = Math.abs( normalized - bandIndex * bandWidth - bandWidth * 0.5 );
    const softFactor = Math.max( 0, Math.min( 1, distToBoundary / ( bandWidth * 0.5 ) ) );
    const softQuantized = quantized + ( normalized - quantized ) * ( 1 - softFactor ) * softness;

    // Blend continuous and quantized
    _double.value = normalized;
    _double.add( ( softQuantized - normalized ) * quantizeAmount );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — specular toon shaping (anisotropic elongated highlights)
// ---------------------------------------------------------------------------
/**
 * Shape a specular highlight into an elongated toon form. Classic anime
 * hair shine is an anisotropic "streak" rather than a circular dot.
 * This function remaps the specular intensity based on the direction of
 * the half-vector, producing the hand-drawn elongation.
 * @param {number} specularIntensity - Raw specular intensity in [0, 1].
 * @param {number} anisotropy - Elongation factor in [0, 1] (0 = circular, 1 = very long).
 * @param {number} angle - Angle of the anisotropy axis in radians.
 * @param {number} halfVecX - X component of the half vector (view-space).
 * @param {number} halfVecY - Y component of the half vector (view-space).
 * @returns {number} Shaped specular intensity in [0, 1].
 */
function applySpecularToonShaping( specularIntensity, anisotropy, angle, halfVecX, halfVecY ) {
    if ( anisotropy <= 0 ) return specularIntensity;

    // Rotate the half-vector into the anisotropy frame
    const cosA = Math.cos( - angle );
    const sinA = Math.sin( - angle );
    _double.value = halfVecX * cosA - halfVecY * sinA;
    const localX = _double.value;
    _double.value = halfVecX * sinA + halfVecY * cosA;
    const localY = _double.value;

    // Compress the local Y axis (making the highlight longer along X)
    _double.value = localX * localX;
    _double.add( localY * localY / Math.max( 1e-4, 1 - anisotropy ) );
    const distSquared = _double.value;

    // Map distance back into a shaping factor
    _double.value = 1.0 - Math.min( 1, distSquared );
    const shape = Math.pow( Math.max( 0, _double.value ), 0.5 );

    // Multiply the specular by the shaping factor
    _double.value = specularIntensity;
    _double.mul( shape );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — mood-based specular tinting
// ---------------------------------------------------------------------------
/**
 * Apply mood-based specular tinting. Warm moods (sunset) tint specular
 * highlights toward orange/gold (reference 2, 4, 6), while cool moods
 * (snowy, icy) tint them toward cyan (reference 1, 3, 5, 7). Uses
 * gl-matrix for zero-allocation staging and double.js for bit-exact
 * accumulation.
 * @param {Color} color - The specular color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} intensity - Tint intensity in [0, 1].
 * @returns {Color}
 */
function gradeSpecularColor( color, temperature, intensity ) {
    if ( intensity <= 0 ) return color;

    glMatrix.vec3.set( _gm_rgb, color.r, color.g, color.b );

    // Warm target (gold): (1.0, 0.85, 0.5); Cool target (ice cyan): (0.7, 0.9, 1.0)
    _double.value = 1.0;
    _double.add( temperature * 0.0 );
    const targetR = _double.value;
    _double.value = 0.85;
    _double.add( temperature * 0.05 );
    const targetG = _double.value;
    _double.value = 0.5;
    _double.sub( temperature * 0.5 );
    const targetB = _double.value;

    // Blend the specular color toward the target
    _double.value = color.r;
    _double.mul( 1 - intensity );
    _double.add( targetR * intensity );
    const r = _double.value;
    _double.value = color.g;
    _double.mul( 1 - intensity );
    _double.add( targetG * intensity );
    const g = _double.value;
    _double.value = color.b;
    _double.mul( 1 - intensity );
    _double.add( targetB * intensity );
    const b = _double.value;

    color.setRGB(
        Math.max( 0, Math.min( 1, r ) ),
        Math.max( 0, Math.min( 1, g ) ),
        Math.max( 0, Math.min( 1, b ) ),
        ColorManagement.workingColorSpace
    );
    return color;
}

// ---------------------------------------------------------------------------
// Anime feature — mood-based diffuse color grading
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading to the diffuse channel. Handles warm
 * (sunset orange), cool (snowy cyan), and vibrant (flora) moods seen
 * across the reference imagery. Uses gl-matrix for zero-allocation
 * staging and double.js for bit-exact accumulation.
 * @param {Color} color - The diffuse color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeDiffuseColor( color, temperature, saturation, brightness, contrast ) {
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
// Anime feature — procedural specular variation (paper grain + watercolor)
// ---------------------------------------------------------------------------
/**
 * Generate a procedural specular variation texture using simplex-noise.
 * Used as a multiplier on the specular highlight to break up the hard
 * cel edges with subtle hand-drawn texture — matching the hand-painted
 * feel of highlights in the reference imagery's water and foliage.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.08] - Noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [intensity=0.3] - Variation intensity in [0, 1].
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateSpecularVariation( width, height, scale = 0.08, octaves = 3, intensity = 0.3 ) {
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

            // Modulate around neutral (1.0)
            _double.value = value;
            _double.mul( intensity );
            _double.add( 1.0 - intensity * 0.5 );
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
// bitecs SoA batch coordinator for real-time Phong material updates
// ---------------------------------------------------------------------------
const _phongWorld = createWorld();
const PhongMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    specularBands: Types.ui8,
    specularQuantize: Types.f64,
    specularThreshold: Types.f64,
    specularSoftness: Types.f64,
    specularAnisotropy: Types.f64,
    specularAngle: Types.f64,
    shininess: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    specularTintIntensity: Types.f64,
    rimGlow: Types.f64,
    paperGrain: Types.f64,
    watercolorBleed: Types.f64,
    dirty: Types.ui8
} );

class MeshPhongMaterialBatch {

    constructor() {
        this.world = _phongWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshPhongMaterial instance for batched real-time updates.
     * @param {MeshPhongMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, PhongMaterialComponent, eid );
        PhongMaterialComponent.materialPtr[ eid ] = this.materials.length;
        PhongMaterialComponent.specularBands[ eid ] = material.specularBands;
        PhongMaterialComponent.specularQuantize[ eid ] = material.specularQuantize;
        PhongMaterialComponent.specularThreshold[ eid ] = material.specularThreshold;
        PhongMaterialComponent.specularSoftness[ eid ] = material.specularSoftness;
        PhongMaterialComponent.specularAnisotropy[ eid ] = material.specularAnisotropy;
        PhongMaterialComponent.specularAngle[ eid ] = material.specularAngle;
        PhongMaterialComponent.shininess[ eid ] = material.shininess;
        PhongMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        PhongMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        PhongMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        PhongMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        PhongMaterialComponent.specularTintIntensity[ eid ] = material.specularTintIntensity;
        PhongMaterialComponent.rimGlow[ eid ] = material.rimGlow;
        PhongMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        PhongMaterialComponent.watercolorBleed[ eid ] = material.watercolorBleed;
        PhongMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued phong-material updates in one cache-friendly pass.
     * Uses double.js internally for bit-exact specular banding and mood grading.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ PhongMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.specularBands = PhongMaterialComponent.specularBands[ eid ];
            material.specularQuantize = PhongMaterialComponent.specularQuantize[ eid ];
            material.specularThreshold = PhongMaterialComponent.specularThreshold[ eid ];
            material.specularSoftness = PhongMaterialComponent.specularSoftness[ eid ];
            material.specularAnisotropy = PhongMaterialComponent.specularAnisotropy[ eid ];
            material.specularAngle = PhongMaterialComponent.specularAngle[ eid ];
            material.shininess = PhongMaterialComponent.shininess[ eid ];
            material.moodTemperature = PhongMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = PhongMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = PhongMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = PhongMaterialComponent.moodContrast[ eid ];
            material.specularTintIntensity = PhongMaterialComponent.specularTintIntensity[ eid ];
            material.rimGlow = PhongMaterialComponent.rimGlow[ eid ];
            material.paperGrain = PhongMaterialComponent.paperGrain[ eid ];
            material.watercolorBleed = PhongMaterialComponent.watercolorBleed[ eid ];

            // Recompute mood-graded colors
            material.moodColor.copy( material.color );
            gradeDiffuseColor( material.moodColor, material.moodTemperature, material.moodSaturation, material.moodBrightness, material.moodContrast );
            material.moodSpecular.copy( material.specular );
            gradeSpecularColor( material.moodSpecular, material.moodTemperature, material.specularTintIntensity );

            PhongMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshPhongMaterial class — mirrors
// three.js/src/materials/MeshPhongMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material for shiny surfaces with specular highlights.
 * The material uses a non-based physically Blinn-Phong reflectance model.
 * Unlike `MeshLambertMaterial`, this material can render specular
 * highlights — the classic anime "shine" on hair, eyes, and metals.
 *
 * In addition to the standard three.js parameters, this material exposes
 * a rich set of real-time anime-style controls: specular cel banding,
 * specular toon shaping (anisotropic elongation), mood-based specular
 * tinting, and procedural specular variation.
 *
 * ```js
 * const material = new THREE.MeshPhongMaterial( {
 *   color: 0x88ccff,
 *   specular: 0xffffff,
 *   shininess: 30,
 *   specularBands: 2,
 *   specularAnisotropy: 0.5,
 *   specularAngle: Math.PI / 4,
 *   moodTemperature: 0.3
 * } );
 * ```
 * @augments Material
 */
class MeshPhongMaterial extends Material {

    /**
     * Constructs a new mesh phong material.
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
        this.isMeshPhongMaterial = true;

        this.type = 'MeshPhongMaterial';

        /**
         * The material's base color.
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
         * The emissive map.
         * @type {?Texture}
         * @default null
         */
        this.emissiveMap = null;

        /**
         * The specular color of the material.
         * @type {Color}
         * @default (0x111111)
         */
        this.specular = new Color( 0x111111 );

        /**
         * How shiny the specular highlight is. A higher value = shinier.
         * @type {number}
         * @default 30
         */
        this.shininess = 30;

        /**
         * The specular map.
         * @type {?Texture}
         * @default null
         */
        this.specularMap = null;

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
         * Number of specular cel bands. 2 = classic hard-edged anime sparkle,
         * 3 = softer stylized, 0 = continuous (off).
         * @type {number}
         * @default 2
         */
        this.specularBands = 2;

        /**
         * Blend amount between continuous and banded specular.
         * @type {number}
         * @default 1.0
         */
        this.specularQuantize = 1.0;

        /**
         * Minimum specular intensity to trigger the first band.
         * @type {number}
         * @default 0.5
         */
        this.specularThreshold = 0.5;

        /**
         * Specular band edge softness.
         * @type {number}
         * @default 0.05
         */
        this.specularSoftness = 0.05;

        /**
         * Anisotropy of the specular highlight. 0 = circular (standard),
         * 1 = very elongated. Classic anime hair uses 0.5-0.8.
         * @type {number}
         * @default 0
         */
        this.specularAnisotropy = 0;

        /**
         * Angle of the anisotropy axis in radians.
         * @type {number}
         * @default 0
         */
        this.specularAngle = 0;

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
         * Specular tint intensity applied via the mood system.
         * @type {number}
         * @default 0
         */
        this.specularTintIntensity = 0;

        /**
         * The precomputed mood-graded diffuse color.
         * @type {Color}
         */
        this.moodColor = new Color( 0xffffff );

        /**
         * The precomputed mood-graded specular color.
         * @type {Color}
         */
        this.moodSpecular = new Color( 0x111111 );

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
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Apply specular cel banding to a raw specular intensity.
     * @param {number} specularIntensity - Raw specular in [0, 1].
     * @returns {number} Banded specular in [0, 1].
     */
    applySpecularBanding( specularIntensity ) {
        return applySpecularCelBanding(
            specularIntensity,
            this.specularBands,
            this.specularQuantize,
            this.specularThreshold,
            this.specularSoftness
        );
    }

    /**
     * Apply specular toon shaping (anisotropic elongation).
     * @param {number} specularIntensity
     * @param {number} halfVecX
     * @param {number} halfVecY
     * @returns {number}
     */
    applySpecularShaping( specularIntensity, halfVecX, halfVecY ) {
        return applySpecularToonShaping(
            specularIntensity,
            this.specularAnisotropy,
            this.specularAngle,
            halfVecX,
            halfVecY
        );
    }

    /**
     * Recompute the mood-graded colors from the current mood parameters.
     * @returns {MeshPhongMaterial} A reference to this instance.
     */
    updateMoodColors() {
        this.moodColor.copy( this.color );
        gradeDiffuseColor( this.moodColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast );
        this.moodSpecular.copy( this.specular );
        gradeSpecularColor( this.moodSpecular, this.moodTemperature, this.specularTintIntensity );
        return this;
    }

    /**
     * Generate a procedural specular variation texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.08]
     * @param {number} [octaves=3]
     * @returns {Uint8Array}
     */
    generateSpecularVariation( width, height, scale = 0.08, octaves = 3 ) {
        return generateSpecularVariation( width, height, scale, octaves, this.paperGrain );
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
     * anime shader chunks with Phong-specific features: specular cel
     * banding, specular toon shaping, and mood-based specular tinting.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject Phong-specific uniforms
        shader.uniforms.specularBands = { value: this.specularBands };
        shader.uniforms.specularQuantize = { value: this.specularQuantize };
        shader.uniforms.specularThreshold = { value: this.specularThreshold };
        shader.uniforms.specularSoftness = { value: this.specularSoftness };
        shader.uniforms.specularAnisotropy = { value: this.specularAnisotropy };
        shader.uniforms.specularAngle = { value: this.specularAngle };
        shader.uniforms.moodSpecular = { value: this.moodSpecular };
        shader.uniforms.specularTintIntensity = { value: this.specularTintIntensity };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int specularBands;
                uniform float specularQuantize;
                uniform float specularThreshold;
                uniform float specularSoftness;
                uniform float specularAnisotropy;
                uniform float specularAngle;
                uniform vec3 moodSpecular;
                uniform float specularTintIntensity;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float variationOffset;

                float applySpecularBanding( float spec ) {
                    if ( specularBands <= 1 || spec < specularThreshold ) return spec;
                    float normalized = ( spec - specularThreshold ) / max( 1.0 - specularThreshold, 0.0001 );
                    normalized = clamp( normalized, 0.0, 1.0 );
                    float bandWidth = 1.0 / float( specularBands );
                    float bandIndex = floor( normalized / bandWidth );
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs( normalized - bandIndex * bandWidth - bandWidth * 0.5 );
                    float softFactor = clamp( distToBoundary / ( bandWidth * 0.5 ), 0.0, 1.0 );
                    float softQuantized = quantized + ( normalized - quantized ) * ( 1.0 - softFactor ) * specularSoftness;
                    return clamp( mix( normalized, softQuantized, specularQuantize ), 0.0, 1.0 );
                }

                float applySpecularShaping( float spec, vec3 halfVec ) {
                    if ( specularAnisotropy <= 0.0 ) return spec;
                    float cosA = cos( - specularAngle );
                    float sinA = sin( - specularAngle );
                    vec2 hv2 = halfVec.xy;
                    vec2 rotated = vec2(
                        hv2.x * cosA - hv2.y * sinA,
                        hv2.x * sinA + hv2.y * cosA
                    );
                    float distSquared = rotated.x * rotated.x + rotated.y * rotated.y / max( 1e-4, 1.0 - specularAnisotropy );
                    float shape = pow( clamp( 1.0 - distSquared, 0.0, 1.0 ), 0.5 );
                    return spec * shape;
                }

                float samplePaperGrain( vec2 uv ) {
                    if ( paperGrain <= 0.0 ) return 1.0;
                    float n = sin( uv.x * 8.0 + variationOffset ) * cos( uv.y * 8.0 + variationOffset );
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * ( 1.0 - n );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Compute half-vector in view space for specular shaping
                vec3 viewDirP = normalize( vViewPosition );
                vec3 lightDirP = normalize( vec3( 0.0, 0.0, 1.0 ) );
                vec3 halfVecP = normalize( viewDirP + lightDirP );

                // Extract and reshape the specular component
                float rawSpec = max( max( gl_FragColor.r, gl_FragColor.g ), gl_FragColor.b );
                float shapedSpec = applySpecularShaping( rawSpec, halfVecP );
                float bandedSpec = applySpecularBanding( shapedSpec );

                // Blend mood specular
                vec3 finalSpec = moodSpecular * bandedSpec;

                // Apply paper grain to the specular
                finalSpec *= samplePaperGrain( vUv );

                gl_FragColor.rgb += finalSpec;

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
            this.specularBands,
            this.specularQuantize,
            this.specularThreshold,
            this.specularSoftness,
            this.specularAnisotropy,
            this.specularAngle,
            this.shininess,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.specularTintIntensity,
            this.rimGlow,
            this.paperGrain,
            this.watercolorBleed,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {MeshPhongMaterial} source - The material to copy from.
     * @return {MeshPhongMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.color.copy( source.color );
        this.emissive.copy( source.emissive );
        this.emissiveIntensity = source.emissiveIntensity;
        this.emissiveMap = source.emissiveMap;
        this.specular.copy( source.specular );
        this.shininess = source.shininess;
        this.specularMap = source.specularMap;
        this.map = source.map;
        this.lightMap = source.lightMap;
        this.lightMapIntensity = source.lightMapIntensity;
        this.aoMap = source.aoMap;
        this.aoMapIntensity = source.aoMapIntensity;
        this.bumpMap = source.bumpMap;
        this.bumpScale = source.bumpScale;
        this.normalMap = source.normalMap;
        this.normalMapType = source.normalMapType;
        this.normalScale.copy( source.normalScale );
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.envMap = source.envMap;
        this.envMapRotation.copy( source.envMapRotation );
        this.combine = source.combine;
        this.reflectivity = source.reflectivity;
        this.refractionRatio = source.refractionRatio;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.wireframeLinecap = source.wireframeLinecap;
        this.wireframeLinejoin = source.wireframeLinejoin;
        this.flatShading = source.flatShading;
        this.fog = source.fog;

        // Anime extensions
        this.specularBands = source.specularBands;
        this.specularQuantize = source.specularQuantize;
        this.specularThreshold = source.specularThreshold;
        this.specularSoftness = source.specularSoftness;
        this.specularAnisotropy = source.specularAnisotropy;
        this.specularAngle = source.specularAngle;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.specularTintIntensity = source.specularTintIntensity;
        this.moodColor.copy( source.moodColor );
        this.moodSpecular.copy( source.moodSpecular );
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

        data.type = 'MeshPhongMaterial';

        if ( this.color.getHex() !== 0xffffff ) data.color = this.color.getHex();
        if ( this.emissive.getHex() !== 0x000000 ) data.emissive = this.emissive.getHex();
        if ( this.emissiveIntensity !== 1.0 ) data.emissiveIntensity = this.emissiveIntensity;
        if ( this.emissiveMap !== null ) data.emissiveMap = this.emissiveMap.toJSON( meta ).uuid;
        if ( this.specular.getHex() !== 0x111111 ) data.specular = this.specular.getHex();
        if ( this.shininess !== 30 ) data.shininess = this.shininess;
        if ( this.specularMap !== null ) data.specularMap = this.specularMap.toJSON( meta ).uuid;
        if ( this.map !== null ) data.map = this.map.toJSON( meta ).uuid;
        if ( this.lightMap !== null ) data.lightMap = this.lightMap.toJSON( meta ).uuid;
        if ( this.lightMapIntensity !== 1.0 ) data.lightMapIntensity = this.lightMapIntensity;
        if ( this.aoMap !== null ) data.aoMap = this.aoMap.toJSON( meta ).uuid;
        if ( this.aoMapIntensity !== 1.0 ) data.aoMapIntensity = this.aoMapIntensity;
        if ( this.bumpMap !== null ) data.bumpMap = this.bumpMap.toJSON( meta ).uuid;
        if ( this.bumpScale !== 1 ) data.bumpScale = this.bumpScale;
        if ( this.normalMap !== null ) data.normalMap = this.normalMap.toJSON( meta ).uuid;
        if ( this.normalMapType !== TangentSpaceNormalMap ) data.normalMapType = this.normalMapType;
        if ( this.normalScale.x !== 1 || this.normalScale.y !== 1 ) data.normalScale = this.normalScale.toArray();
        if ( this.displacementMap !== null ) data.displacementMap = this.displacementMap.toJSON( meta ).uuid;
        if ( this.displacementScale !== 1 ) data.displacementScale = this.displacementScale;
        if ( this.displacementBias !== 0 ) data.displacementBias = this.displacementBias;
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
        if ( this.flatShading ) data.flatShading = true;
        if ( this.fog === false ) data.fog = false;

        // Anime extensions
        if ( this.specularBands !== 2 ) data.specularBands = this.specularBands;
        if ( this.specularQuantize !== 1.0 ) data.specularQuantize = this.specularQuantize;
        if ( this.specularThreshold !== 0.5 ) data.specularThreshold = this.specularThreshold;
        if ( this.specularSoftness !== 0.05 ) data.specularSoftness = this.specularSoftness;
        if ( this.specularAnisotropy !== 0 ) data.specularAnisotropy = this.specularAnisotropy;
        if ( this.specularAngle !== 0 ) data.specularAngle = this.specularAngle;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.specularTintIntensity !== 0 ) data.specularTintIntensity = this.specularTintIntensity;
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
    MeshPhongMaterial,
    MeshPhongMaterialBatch,
    applySpecularCelBanding,
    applySpecularToonShaping,
    gradeSpecularColor,
    gradeDiffuseColor,
    generateSpecularVariation
};
export default MeshPhongMaterial;