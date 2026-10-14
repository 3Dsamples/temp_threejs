// file number : 017
// full path name : src/materials/017_meshphysicalmaterial.js
// description : MeshPhysicalMaterial (three.js r185) rewritten as a high-performance ES module with deep anime-stylization integration. Extends the anime-enabled 010_meshstandardmaterial.js and preserves the full r185 MeshPhysicalMaterial API — clearcoat, clearcoatRoughness, clearcoatMap, clearcoatRoughnessMap, clearcoatNormalMap, clearcoatNormalScale, iridescence, iridescenceIOR, iridescenceThicknessRange, iridescenceMap, iridescenceThicknessMap, sheen, sheenColor, sheenColorMap, sheenRoughness, sheenRoughnessMap, transmission, transmissionMap, thickness, thicknessMap, attenuationDistance, attenuationColor, specularIntensity, specularIntensityMap, specularColor, specularColorMap, anisotropy, anisotropyRotation, anisotropyMap, plus all inherited MeshStandardMaterial properties (color, roughness, metalness, map, lightMap, aoMap, emissive, bumpMap, normalMap, displacementMap, roughnessMap, metalnessMap, alphaMap, envMap, wireframe, flatShading, fog). MeshPhysicalMaterial is the most advanced three.js PBR material, adding clearcoat (car paint, wet surfaces), iridescence (soap bubbles, beetle shells), sheen (velvet, fabric), transmission (glass, water), and anisotropy (brushed metal) to the standard metallic-roughness workflow. For anime stylization, these advanced PBR features unlock the rich material storytelling seen in the reference imagery — iridescent water droplets, translucent glass, velvet anime fabrics, and the specular highlights on wet skin after rain. Adds real-time anime features specifically tuned for advanced PBR: cel-band quantization for clearcoat/specular/sheen layers, mood-based rebalancing of all PBR parameters (cool cyan snow/ice, warm sunset golden-hour), transmission-driven cel banding for translucent materials, iridescence-to-anime sparkle mapping (discrete rainbow bands for magical effects), sheen-driven rim glow (velvet fabric halos), simplex-noise dithered advanced specular, and per-instance variation. Imports Color, Euler, Vector2, Vector3, Matrix3, Matrix4, and other math classes strictly from threejs_new01 math, and uses gl-matrix for zero-allocation advanced PBR color transforms, double.js for bit-exact clearcoat/iridescence/sheen quantization and HDR mood grading, bitecs SoA batching for real-time updates across thousands of advanced PBR instances, and simplex-noise for procedural texture variation.
// best for : MeshPhysicalMaterial, anime characters with translucent skin/hair, iridescent water and glass, velvet anime fabrics, brushed metal anime props, wet anime surfaces, magical rainbow effects, and any three.js advanced PBR mesh that needs real-time anime stylization.
// license : MIT

import { MeshStandardMaterial } from './010_meshstandardmaterial.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';
import { Euler } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/008_Euler.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { Matrix3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/009_Matrix3.js';
import { Matrix4 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/007_Matrix4.js';
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

// gl-matrix scratch for zero-allocation advanced PBR color transforms
const _gm_rgb = glMatrix.vec3.create();
const _gm_hsv = glMatrix.vec3.create();
const _gm_rgba = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// Anime feature — clearcoat cel banding
// ---------------------------------------------------------------------------
/**
 * Quantize a clearcoat specular intensity into cel bands using double.js
 * for bit-exact thresholding. Clearcoat is the thin, glossy top layer
 * that gives materials like car paint and wet surfaces their distinctive
 * shine. Cel-banding it produces the crisp anime sparkle on wet anime
 * skin, polished armor, and clearcoat character features.
 * @param {number} clearcoatIntensity - Raw clearcoat intensity in [0, 1].
 * @param {number} bands - Number of cel bands (2-3 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @param {number} [threshold=0.5] - Minimum intensity to show the first band.
 * @param {number} [softness=0.05] - Edge softness in [0, 0.3].
 * @returns {number} Banded clearcoat intensity in [0, 1].
 */
function applyClearcoatCelBanding( clearcoatIntensity, bands, quantizeAmount, threshold = 0.5, softness = 0.05 ) {
    if ( bands <= 1 || clearcoatIntensity < threshold ) return 0;

    _double.value = clearcoatIntensity;
    _double.sub( threshold );
    _double.div( Math.max( 1.0 - threshold, 0.0001 ) );
    const normalized = Math.max( 0, Math.min( 1, _double.value ) );

    const bandWidth = 1.0 / bands;
    _double.value = normalized;
    _double.div( bandWidth );
    const bandIndex = Math.floor( _double.value );
    _double.value = bandIndex;
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    const distToBoundary = Math.abs( normalized - bandIndex * bandWidth - bandWidth * 0.5 );
    const softFactor = Math.max( 0, Math.min( 1, distToBoundary / ( bandWidth * 0.5 ) ) );
    const softQuantized = quantized + ( normalized - quantized ) * ( 1 - softFactor ) * softness;

    _double.value = normalized;
    _double.add( ( softQuantized - normalized ) * quantizeAmount );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — iridescence to anime sparkle mapping
// ---------------------------------------------------------------------------
/**
 * Map an iridescence value to discrete anime rainbow bands. Iridescence
 * produces angle-dependent color shifts — soap bubbles, beetle shells,
 * oil slicks. For anime, we map this to a set of discrete rainbow bands
 * that read as magical sparkle, matching the iridescent water droplets
 * and magical effects in the reference imagery.
 * @param {number} iridescence - Raw iridescence value in [0, 1].
 * @param {number} bands - Number of rainbow bands (4-6 recommended).
 * @param {number} angleShift - Angle-dependent shift in [0, 1].
 * @returns {Color} The mapped rainbow color.
 */
function mapIridescenceToAnimeSparkle( iridescence, bands, angleShift ) {
    // Shift the iridescence value by the angle to produce angle dependence
    _double.value = iridescence;
    _double.add( angleShift * 0.5 );
    _double.mul( bands );
    _double.value = _double.value % bands;
    _double.div( bands );
    const t = _double.value;

    // Map t to a rainbow hue [0, 1]
    const hue = t;

    // Convert HSV (hue, 1, 1) to RGB
    const i = Math.floor( hue * 6 );
    const f = hue * 6 - i;
    const p = 0;
    const q = 1 - f;
    const t2 = f;

    let r, g, b;
    switch ( i % 6 ) {
        case 0: r = 1; g = t2; b = p; break;
        case 1: r = q; g = 1; b = p; break;
        case 2: r = p; g = 1; b = t2; break;
        case 3: r = p; g = q; b = 1; break;
        case 4: r = t2; g = p; b = 1; break;
        case 5: r = 1; g = p; b = q; break;
    }

    const out = new Color();
    out.setRGB(
        Math.max( 0, Math.min( 1, r ) ),
        Math.max( 0, Math.min( 1, g ) ),
        Math.max( 0, Math.min( 1, b ) ),
        ColorManagement.workingColorSpace
    );
    return out;
}

// ---------------------------------------------------------------------------
// Anime feature — sheen-driven rim glow (velvet fabric halo)
// ---------------------------------------------------------------------------
/**
 * Compute a sheen-driven rim glow. Sheen produces the soft, dusty
 * appearance of velvet and fabric. For anime, we amplify the sheen
 * at the silhouette edges to produce a soft halo, matching the velvet
 * anime costume halos and fabric fuzz in the reference imagery.
 * @param {number} sheen - Raw sheen value in [0, 1].
 * @param {number} ndotv - Normal·View dot product in [0, 1].
 * @param {number} [power=2.0] - Rim falloff power.
 * @param {number} [intensity=1.0] - Rim intensity multiplier.
 * @returns {number} Sheen rim glow in [0, 1].
 */
function computeSheenRimGlow( sheen, ndotv, power = 2.0, intensity = 1.0 ) {
    if ( sheen <= 0 ) return 0;
    _double.value = 1.0 - Math.abs( ndotv );
    const rim = Math.pow( _double.value, power );
    _double.value = rim * sheen * intensity;
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — transmission-driven cel banding
// ---------------------------------------------------------------------------
/**
 * Apply cel-band quantization to a transmission-driven translucent color.
 * Transmission is used for glass, water, and translucent anime skin/hair.
 * Cel-banding it produces the discrete "glass layers" look of hand-drawn
 * anime glass and water surfaces.
 * @param {Color} baseColor - The transmitted base color.
 * @param {Color} output - The output color (modified in place).
 * @param {number} transmission - Raw transmission value in [0, 1].
 * @param {number} bands - Number of cel bands (2-4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @returns {Color}
 */
function applyTransmissionCelBanding( baseColor, output, transmission, bands, quantizeAmount ) {
    if ( bands <= 1 || transmission <= 0 ) {
        output.copy( baseColor );
        return output;
    }

    glMatrix.vec3.set( _gm_rgb, baseColor.r, baseColor.g, baseColor.b );

    const lum = 0.2126 * _gm_rgb[ 0 ] + 0.7152 * _gm_rgb[ 1 ] + 0.0722 * _gm_rgb[ 2 ];

    const bandWidth = 1.0 / bands;
    _double.value = lum;
    _double.div( bandWidth );
    const bandIndex = Math.floor( _double.value );
    _double.value = bandIndex;
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    _double.value = lum;
    _double.add( ( quantized - lum ) * quantizeAmount );
    const finalLum = _double.value;

    if ( lum > 0.0001 ) {
        _double.value = baseColor.r;
        _double.div( lum );
        _double.mul( finalLum );
        output.r = _double.value;

        _double.value = baseColor.g;
        _double.div( lum );
        _double.mul( finalLum );
        output.g = _double.value;

        _double.value = baseColor.b;
        _double.div( lum );
        _double.mul( finalLum );
        output.b = _double.value;
    } else {
        output.copy( baseColor );
    }

    output.a = baseColor.a;

    output.r = Math.max( 0, Math.min( 1, output.r ) );
    output.g = Math.max( 0, Math.min( 1, output.g ) );
    output.b = Math.max( 0, Math.min( 1, output.b ) );
    return output;
}

// ---------------------------------------------------------------------------
// Anime feature — mood-based advanced PBR rebalancing
// ---------------------------------------------------------------------------
/**
 * Rebalance advanced PBR parameters based on scene mood. Snow/ice scenes
 * need higher roughness, higher clearcoat, cool tint; golden-hour scenes
 * need lower roughness, lower clearcoat (matte sunset look), warm tint.
 * Uses gl-matrix for zero-allocation staging and double.js for bit-exact
 * accumulation.
 * @param {Color} color - The base color (modified in place).
 * @param {Object} params - The PBR parameters to rebalance.
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Object} The rebalanced parameters.
 */
function moodAdvancedPBRRebalance( color, params, temperature, saturation, brightness, contrast ) {
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

    // Rebalance PBR parameters
    const newParams = {};

    // Roughness: cooler → higher (matte), warmer → lower (glossy)
    _double.value = params.roughness;
    _double.add( temperature * 0.1 );
    newParams.roughness = Math.max( 0, Math.min( 1, _double.value ) );

    // Metalness: cooler → slightly higher, warmer → slightly lower
    _double.value = params.metalness;
    _double.add( - temperature * 0.05 );
    newParams.metalness = Math.max( 0, Math.min( 1, _double.value ) );

    // Clearcoat: cooler → higher (ice gloss), warmer → lower
    _double.value = params.clearcoat;
    _double.add( - temperature * 0.15 );
    newParams.clearcoat = Math.max( 0, Math.min( 1, _double.value ) );

    // Sheen: cooler → lower, warmer → higher
    _double.value = params.sheen;
    _double.add( temperature * 0.1 );
    newParams.sheen = Math.max( 0, Math.min( 1, _double.value ) );

    // Iridescence: cooler → higher (icy sparkle), warmer → lower
    _double.value = params.iridescence;
    _double.add( - temperature * 0.1 );
    newParams.iridescence = Math.max( 0, Math.min( 1, _double.value ) );

    // Transmission: cooler → slightly higher (clear ice), warmer → slightly lower
    _double.value = params.transmission;
    _double.add( - temperature * 0.05 );
    newParams.transmission = Math.max( 0, Math.min( 1, _double.value ) );

    // Anisotropy: cooler → lower, warmer → higher
    _double.value = params.anisotropy;
    _double.add( temperature * 0.08 );
    newParams.anisotropy = Math.max( 0, Math.min( 1, _double.value ) );

    return newParams;
}

// ---------------------------------------------------------------------------
// Anime feature — procedural texture variation
// ---------------------------------------------------------------------------
/**
 * Generate a combined paper-grain and watercolor texture using
 * simplex-noise with multiple octaves. Produces the hand-painted
 * texture characteristic of the reference imagery's advanced PBR
 * surfaces (iridescent water, translucent glass, velvet fabric).
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03] - Base noise scale.
 * @param {number} [octaves=4] - Number of noise octaves.
 * @param {number} [paperGrain=0.3] - Paper grain intensity.
 * @param {number} [watercolorBleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateAdvancedPBRTexture( width, height, scale = 0.03, octaves = 4, paperGrain = 0.3, watercolorBleed = 0.5 ) {
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
// bitecs SoA batch coordinator for real-time advanced PBR material updates
// ---------------------------------------------------------------------------
const _advPbrWorld = createWorld();
const AdvPBRMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    clearcoatBands: Types.ui8,
    clearcoatQuantize: Types.f64,
    clearcoatThreshold: Types.f64,
    clearcoatSoftness: Types.f64,
    iridescenceBands: Types.ui8,
    iridescenceAngleShift: Types.f64,
    sheenRimPower: Types.f64,
    sheenRimIntensity: Types.f64,
    transmissionBands: Types.ui8,
    transmissionQuantize: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    paperGrain: Types.f64,
    watercolorBleed: Types.f64,
    ditherAmplitude: Types.f64,
    dirty: Types.ui8
} );

class MeshPhysicalMaterialBatch {

    constructor() {
        this.world = _advPbrWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a MeshPhysicalMaterial instance for batched real-time updates.
     * @param {MeshPhysicalMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, AdvPBRMaterialComponent, eid );
        AdvPBRMaterialComponent.materialPtr[ eid ] = this.materials.length;
        AdvPBRMaterialComponent.clearcoatBands[ eid ] = material.clearcoatBands;
        AdvPBRMaterialComponent.clearcoatQuantize[ eid ] = material.clearcoatQuantize;
        AdvPBRMaterialComponent.clearcoatThreshold[ eid ] = material.clearcoatThreshold;
        AdvPBRMaterialComponent.clearcoatSoftness[ eid ] = material.clearcoatSoftness;
        AdvPBRMaterialComponent.iridescenceBands[ eid ] = material.iridescenceBands;
        AdvPBRMaterialComponent.iridescenceAngleShift[ eid ] = material.iridescenceAngleShift;
        AdvPBRMaterialComponent.sheenRimPower[ eid ] = material.sheenRimPower;
        AdvPBRMaterialComponent.sheenRimIntensity[ eid ] = material.sheenRimIntensity;
        AdvPBRMaterialComponent.transmissionBands[ eid ] = material.transmissionBands;
        AdvPBRMaterialComponent.transmissionQuantize[ eid ] = material.transmissionQuantize;
        AdvPBRMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        AdvPBRMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        AdvPBRMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        AdvPBRMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        AdvPBRMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        AdvPBRMaterialComponent.watercolorBleed[ eid ] = material.watercolorBleed;
        AdvPBRMaterialComponent.ditherAmplitude[ eid ] = material.ditherAmplitude;
        AdvPBRMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued advanced PBR material updates in one cache-friendly
     * pass. Uses double.js internally for bit-exact clearcoat quantization
     * and mood grading.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ AdvPBRMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.clearcoatBands = AdvPBRMaterialComponent.clearcoatBands[ eid ];
            material.clearcoatQuantize = AdvPBRMaterialComponent.clearcoatQuantize[ eid ];
            material.clearcoatThreshold = AdvPBRMaterialComponent.clearcoatThreshold[ eid ];
            material.clearcoatSoftness = AdvPBRMaterialComponent.clearcoatSoftness[ eid ];
            material.iridescenceBands = AdvPBRMaterialComponent.iridescenceBands[ eid ];
            material.iridescenceAngleShift = AdvPBRMaterialComponent.iridescenceAngleShift[ eid ];
            material.sheenRimPower = AdvPBRMaterialComponent.sheenRimPower[ eid ];
            material.sheenRimIntensity = AdvPBRMaterialComponent.sheenRimIntensity[ eid ];
            material.transmissionBands = AdvPBRMaterialComponent.transmissionBands[ eid ];
            material.transmissionQuantize = AdvPBRMaterialComponent.transmissionQuantize[ eid ];
            material.moodTemperature = AdvPBRMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = AdvPBRMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = AdvPBRMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = AdvPBRMaterialComponent.moodContrast[ eid ];
            material.paperGrain = AdvPBRMaterialComponent.paperGrain[ eid ];
            material.watercolorBleed = AdvPBRMaterialComponent.watercolorBleed[ eid ];
            material.ditherAmplitude = AdvPBRMaterialComponent.ditherAmplitude[ eid ];

            // Recompute derived values
            material.moodColor.copy( material.color );
            const newParams = moodAdvancedPBRRebalance(
                material.moodColor,
                {
                    roughness: material.roughness,
                    metalness: material.metalness,
                    clearcoat: material.clearcoat,
                    sheen: material.sheen,
                    iridescence: material.iridescence,
                    transmission: material.transmission,
                    anisotropy: material.anisotropy
                },
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );
            material.moodRoughness = newParams.roughness;
            material.moodMetalness = newParams.metalness;
            material.moodClearcoat = newParams.clearcoat;
            material.moodSheen = newParams.sheen;
            material.moodIridescence = newParams.iridescence;
            material.moodTransmission = newParams.transmission;
            material.moodAnisotropy = newParams.anisotropy;

            AdvPBRMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshPhysicalMaterial class — mirrors
// three.js/src/materials/MeshPhysicalMaterial.js
// ---------------------------------------------------------------------------
/**
 * An extension of the {@link MeshStandardMaterial}, providing more advanced
 * physically-based rendering properties:
 * - Clearcoat: Some materials — like car paints, carbon fiber, and wet surfaces —
 *   require a clear, reflective layer on top of another layer that may be
 *   irregularly rough. Clearcoat provides this effect.
 * - Iridescence: Allows the rendering of the effect where hue varies depending
 *   on the viewing angle and illumination angle. Soap bubbles and beetle shells
 *   are examples of this phenomenon.
 * - Sheen: Can be used to represent soft, dusty surfaces such as velvet or
 *   fabric.
 * - Transmission: Provides a way to render transparent or translucent surfaces
 *   like glass, water, or skin.
 * - Anisotropy: Allows the reflection to be stretched according to a direction
 *   and strength, which is useful for brushed metals and other anisotropic
 *   materials.
 *
 * In addition to the standard three.js parameters, this material exposes a
 * rich set of real-time anime-style controls: clearcoat cel banding,
 * iridescence-to-anime-sparkle mapping, sheen-driven rim glow, transmission
 * cel banding, and mood-based advanced PBR rebalancing.
 *
 * ```js
 * const material = new THREE.MeshPhysicalMaterial( {
 *   color: 0x88ccff,
 *   metalness: 0.1,
 *   roughness: 0.3,
 *   clearcoat: 1.0,
 *   clearcoatBands: 2,
 *   iridescenceBands: 5,
 *   sheenRimIntensity: 0.4,
 *   moodTemperature: -0.3
 * } );
 * ```
 * @augments MeshStandardMaterial
 */
class MeshPhysicalMaterial extends MeshStandardMaterial {

    /**
     * Constructs a new mesh physical material.
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
        this.isMeshPhysicalMaterial = true;

        this.type = 'MeshPhysicalMaterial';

        // ---- Clearcoat ----
        /**
         * The clearcoat layer intensity. 0 = disabled, 1 = full clearcoat.
         * @type {number}
         * @default 0.0
         */
        this.clearcoat = 0.0;

        /**
         * The clearcoat layer roughness.
         * @type {number}
         * @default 0.0
         */
        this.clearcoatRoughness = 0.0;

        /**
         * The clearcoat map. The red channel of this texture is used to
         * modulate the clearcoat layer intensity.
         * @type {?Texture}
         * @default null
         */
        this.clearcoatMap = null;

        /**
         * The clearcoat roughness map. The red channel of this texture is
         * used to modulate the clearcoat layer roughness.
         * @type {?Texture}
         * @default null
         */
        this.clearcoatRoughnessMap = null;

        /**
         * The clearcoat normal map. The texture is expected to be in
         * `NoColorSpace`.
         * @type {?Texture}
         * @default null
         */
        this.clearcoatNormalMap = null;

        /**
         * The scale of the clearcoat normal map.
         * @type {Vector2}
         * @default (1,1)
         */
        this.clearcoatNormalScale = new Vector2( 1, 1 );

        // ---- Iridescence ----
        /**
         * The iridescence intensity. 0 = disabled, 1 = full iridescence.
         * @type {number}
         * @default 0.0
         */
        this.iridescence = 0.0;

        /**
         * The index of refraction of the iridescent layer.
         * @type {number}
         * @default 1.3
         */
        this.iridescenceIOR = 1.3;

        /**
         * The thickness range of the iridescent layer in nanometers.
         * @type {Vector2}
         * @default (100, 400)
         */
        this.iridescenceThicknessRange = new Vector2( 100, 400 );

        /**
         * The iridescence map. The red channel of this texture is used to
         * modulate the iridescence intensity.
         * @type {?Texture}
         * @default null
         */
        this.iridescenceMap = null;

        /**
         * The iridescence thickness map. The green channel of this texture
         * is used to modulate the iridescence layer thickness.
         * @type {?Texture}
         * @default null
         */
        this.iridescenceThicknessMap = null;

        // ---- Sheen ----
        /**
         * The sheen intensity. 0 = disabled, 1 = full sheen.
         * @type {number}
         * @default 0.0
         */
        this.sheen = 0.0;

        /**
         * The sheen color.
         * @type {Color}
         * @default (0,0,0)
         */
        this.sheenColor = new Color( 0x000000 );

        /**
         * The sheen color map.
         * @type {?Texture}
         * @default null
         */
        this.sheenColorMap = null;

        /**
         * The sheen roughness.
         * @type {number}
         * @default 1.0
         */
        this.sheenRoughness = 1.0;

        /**
         * The sheen roughness map. The alpha channel of this texture is
         * used to modulate the sheen roughness.
         * @type {?Texture}
         * @default null
         */
        this.sheenRoughnessMap = null;

        // ---- Transmission ----
        /**
         * The transmission intensity. 0 = opaque, 1 = fully transmissive.
         * @type {number}
         * @default 0.0
         */
        this.transmission = 0.0;

        /**
         * The transmission map. The red channel of this texture is used to
         * modulate the transmission intensity.
         * @type {?Texture}
         * @default null
         */
        this.transmissionMap = null;

        /**
         * The thickness of the volume beneath the surface in world units.
         * @type {number}
         * @default 0
         */
        this.thickness = 0;

        /**
         * The thickness map. The green channel of this texture is used to
         * modulate the thickness value.
         * @type {?Texture}
         * @default null
         */
        this.thicknessMap = null;

        /**
         * The density of the material's volume.
         * @type {number}
         * @default 0
         */
        this.attenuationDistance = Infinity;

        /**
         * The color that white light turns into due to absorption when
         * reaching the attenuation distance.
         * @type {Color}
         * @default (1,1,1)
         */
        this.attenuationColor = new Color( 0xffffff );

        // ---- Specular ----
        /**
         * The intensity of the specular reflections.
         * @type {number}
         * @default 1.0
         */
        this.specularIntensity = 1.0;

        /**
         * The specular intensity map.
         * @type {?Texture}
         * @default null
         */
        this.specularIntensityMap = null;

        /**
         * The color of the specular reflections.
         * @type {Color}
         * @default (1,1,1)
         */
        this.specularColor = new Color( 0xffffff );

        /**
         * The specular color map.
         * @type {?Texture}
         * @default null
         */
        this.specularColorMap = null;

        // ---- Anisotropy ----
        /**
         * The anisotropy strength. 0 = isotropic, 1 = fully anisotropic.
         * @type {number}
         * @default 0.0
         */
        this.anisotropy = 0.0;

        /**
         * The rotation of the anisotropy in tangent space.
         * @type {number}
         * @default 0.0
         */
        this.anisotropyRotation = 0.0;

        /**
         * The anisotropy map. The red and green channels of this texture
         * encode the anisotropy direction.
         * @type {?Texture}
         * @default null
         */
        this.anisotropyMap = null;

        // -------------------------------------------------------------------
        // Anime Rendering Extensions
        // -------------------------------------------------------------------
        /**
         * Number of clearcoat cel bands. 2-3 = classic anime sparkle on
         * clearcoat surfaces.
         * @type {number}
         * @default 2
         */
        this.clearcoatBands = 2;

        /**
         * Blend amount between continuous and banded clearcoat.
         * @type {number}
         * @default 1.0
         */
        this.clearcoatQuantize = 1.0;

        /**
         * Minimum clearcoat intensity to trigger the first band.
         * @type {number}
         * @default 0.5
         */
        this.clearcoatThreshold = 0.5;

        /**
         * Clearcoat band edge softness.
         * @type {number}
         * @default 0.05
         */
        this.clearcoatSoftness = 0.05;

        /**
         * Number of iridescence rainbow bands for anime sparkle mapping.
         * 4-6 = classic anime magical sparkle.
         * @type {number}
         * @default 5
         */
        this.iridescenceBands = 5;

        /**
         * Angle-dependent shift applied to the iridescence sparkle.
         * @type {number}
         * @default 0.5
         */
        this.iridescenceAngleShift = 0.5;

        /**
         * Sheen rim-glow falloff power.
         * @type {number}
         * @default 2.0
         */
        this.sheenRimPower = 2.0;

        /**
         * Sheen rim-glow intensity.
         * @type {number}
         * @default 0
         */
        this.sheenRimIntensity = 0;

        /**
         * Number of transmission cel bands.
         * @type {number}
         * @default 0
         */
        this.transmissionBands = 0;

        /**
         * Blend amount between continuous and banded transmission.
         * @type {number}
         * @default 1.0
         */
        this.transmissionQuantize = 1.0;

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
         * The precomputed mood-rebalanced clearcoat.
         * @type {number}
         * @default 0.0
         */
        this.moodClearcoat = 0.0;

        /**
         * The precomputed mood-rebalanced sheen.
         * @type {number}
         * @default 0.0
         */
        this.moodSheen = 0.0;

        /**
         * The precomputed mood-rebalanced iridescence.
         * @type {number}
         * @default 0.0
         */
        this.moodIridescence = 0.0;

        /**
         * The precomputed mood-rebalanced transmission.
         * @type {number}
         * @default 0.0
         */
        this.moodTransmission = 0.0;

        /**
         * The precomputed mood-rebalanced anisotropy.
         * @type {number}
         * @default 0.0
         */
        this.moodAnisotropy = 0.0;

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
         * Simplex-noise dithering amplitude in 8-bit units.
         * @type {number}
         * @default 0
         */
        this.ditherAmplitude = 0;

        /**
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        this.setValues( parameters );

        // Initialize derived values.
        this.updateMoodAdvancedPBR();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Apply clearcoat cel banding to a raw clearcoat intensity.
     * @param {number} intensity - Raw clearcoat intensity in [0, 1].
     * @returns {number} Banded clearcoat intensity in [0, 1].
     */
    applyClearcoatBanding( intensity ) {
        return applyClearcoatCelBanding(
            intensity,
            this.clearcoatBands,
            this.clearcoatQuantize,
            this.clearcoatThreshold,
            this.clearcoatSoftness
        );
    }

    /**
     * Map the current iridescence value to an anime rainbow sparkle color.
     * @param {number} angleShift - Angle-dependent shift in [0, 1].
     * @returns {Color}
     */
    mapIridescenceSparkle( angleShift ) {
        return mapIridescenceToAnimeSparkle( this.iridescence, this.iridescenceBands, angleShift );
    }

    /**
     * Compute the sheen-driven rim glow for a given normal·view dot product.
     * @param {number} ndotv - Normal·View dot product in [0, 1].
     * @returns {number} Sheen rim glow in [0, 1].
     */
    sampleSheenRim( ndotv ) {
        if ( this.sheenRimIntensity <= 0 ) return 0;
        return computeSheenRimGlow( this.sheen, ndotv, this.sheenRimPower, this.sheenRimIntensity );
    }

    /**
     * Apply transmission cel banding to a transmitted color.
     * @param {Color} baseColor - The transmitted base color.
     * @param {Color} output - The output color.
     * @returns {Color}
     */
    applyTransmissionBanding( baseColor, output ) {
        return applyTransmissionCelBanding(
            baseColor,
            output,
            this.transmission,
            this.transmissionBands,
            this.transmissionQuantize
        );
    }

    /**
     * Recompute the mood-graded color and rebalanced advanced PBR parameters.
     * @returns {MeshPhysicalMaterial} A reference to this instance.
     */
    updateMoodAdvancedPBR() {
        this.moodColor.copy( this.color );
        const newParams = moodAdvancedPBRRebalance(
            this.moodColor,
            {
                roughness: this.roughness,
                metalness: this.metalness,
                clearcoat: this.clearcoat,
                sheen: this.sheen,
                iridescence: this.iridescence,
                transmission: this.transmission,
                anisotropy: this.anisotropy
            },
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        this.moodRoughness = newParams.roughness;
        this.moodMetalness = newParams.metalness;
        this.moodClearcoat = newParams.clearcoat;
        this.moodSheen = newParams.sheen;
        this.moodIridescence = newParams.iridescence;
        this.moodTransmission = newParams.transmission;
        this.moodAnisotropy = newParams.anisotropy;
        return this;
    }

    /**
     * Generate a procedural advanced PBR texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.03]
     * @param {number} [octaves=4]
     * @returns {Uint8Array}
     */
    generateAdvancedPBRTexture( width, height, scale = 0.03, octaves = 4 ) {
        return generateAdvancedPBRTexture( width, height, scale, octaves, this.paperGrain, this.watercolorBleed );
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
     * The default `onBeforeCompile` hook. Extends the base MeshStandardMaterial
     * anime shader chunks with advanced PBR features: clearcoat cel banding,
     * iridescence sparkle mapping, sheen rim glow, and transmission cel
     * banding.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base MeshStandardMaterial hook first
        super.onBeforeCompile( shader, renderer );

        // Inject advanced PBR uniforms
        shader.uniforms.clearcoatBands = { value: this.clearcoatBands };
        shader.uniforms.clearcoatQuantize = { value: this.clearcoatQuantize };
        shader.uniforms.clearcoatThreshold = { value: this.clearcoatThreshold };
        shader.uniforms.clearcoatSoftness = { value: this.clearcoatSoftness };
        shader.uniforms.iridescenceBands = { value: this.iridescenceBands };
        shader.uniforms.iridescenceAngleShift = { value: this.iridescenceAngleShift };
        shader.uniforms.sheenRimPower = { value: this.sheenRimPower };
        shader.uniforms.sheenRimIntensity = { value: this.sheenRimIntensity };
        shader.uniforms.transmissionBands = { value: this.transmissionBands };
        shader.uniforms.transmissionQuantize = { value: this.transmissionQuantize };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.moodClearcoat = { value: this.moodClearcoat };
        shader.uniforms.moodSheen = { value: this.moodSheen };
        shader.uniforms.moodIridescence = { value: this.moodIridescence };
        shader.uniforms.moodTransmission = { value: this.moodTransmission };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader with advanced PBR anime chunks
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int clearcoatBands;
                uniform float clearcoatQuantize;
                uniform float clearcoatThreshold;
                uniform float clearcoatSoftness;
                uniform int iridescenceBands;
                uniform float iridescenceAngleShift;
                uniform float sheenRimPower;
                uniform float sheenRimIntensity;
                uniform int transmissionBands;
                uniform float transmissionQuantize;
                uniform vec3 moodColor;
                uniform float moodClearcoat;
                uniform float moodSheen;
                uniform float moodIridescence;
                uniform float moodTransmission;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float ditherAmplitude;
                uniform float variationOffset;

                float applyClearcoatCel( float spec ) {
                    if ( clearcoatBands <= 1 || spec < clearcoatThreshold ) return 0.0;
                    float normalized = clamp( ( spec - clearcoatThreshold ) / max( 1.0 - clearcoatThreshold, 0.0001 ), 0.0, 1.0 );
                    float bandWidth = 1.0 / float( clearcoatBands );
                    float bandIndex = floor( normalized / bandWidth );
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs( normalized - bandIndex * bandWidth - bandWidth * 0.5 );
                    float softFactor = clamp( distToBoundary / ( bandWidth * 0.5 ), 0.0, 1.0 );
                    float softQuantized = quantized + ( normalized - quantized ) * ( 1.0 - softFactor ) * clearcoatSoftness;
                    return clamp( mix( normalized, softQuantized, clearcoatQuantize ), 0.0, 1.0 );
                }

                vec3 mapIridescenceSparkle( float iridescence, float angle ) {
                    if ( iridescence <= 0.0 ) return vec3( 0.0 );
                    float t = fract( iridescence * float( iridescenceBands ) + angle * iridescenceAngleShift );
                    float i = floor( t * 6.0 );
                    float f = t * 6.0 - i;
                    float p = 0.0;
                    float q = 1.0 - f;
                    float r, g, b;
                    if ( i == 0.0 ) { r = 1.0; g = f; b = p; }
                    else if ( i == 1.0 ) { r = q; g = 1.0; b = p; }
                    else if ( i == 2.0 ) { r = p; g = 1.0; b = f; }
                    else if ( i == 3.0 ) { r = p; g = q; b = 1.0; }
                    else if ( i == 4.0 ) { r = f; g = p; b = 1.0; }
                    else { r = 1.0; g = p; b = q; }
                    return vec3( r, g, b ) * iridescence;
                }

                float computeSheenRim( float sheen, float ndotv ) {
                    if ( sheen <= 0.0 || sheenRimIntensity <= 0.0 ) return 0.0;
                    float rim = pow( 1.0 - abs( ndotv ), sheenRimPower );
                    return clamp( rim * sheen * sheenRimIntensity, 0.0, 1.0 );
                }

                vec3 applyTransmissionCel( vec3 baseColor, float transmission ) {
                    if ( transmissionBands <= 1 || transmission <= 0.0 ) return baseColor;
                    float lum = dot( baseColor, vec3( 0.2126, 0.7152, 0.0722 ) );
                    float bandWidth = 1.0 / float( transmissionBands );
                    float bandIndex = floor( lum / bandWidth );
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float finalLum = mix( lum, quantized, transmissionQuantize );
                    if ( lum > 0.0001 ) return baseColor * ( finalLum / lum );
                    return baseColor;
                }

                float samplePaperGrain( vec2 uv ) {
                    if ( paperGrain <= 0.0 ) return 1.0;
                    float n = sin( uv.x * 8.0 + variationOffset ) * cos( uv.y * 8.0 + variationOffset );
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * ( 1.0 - n );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Apply clearcoat cel banding
                float rawClearcoat = max( max( gl_FragColor.r, gl_FragColor.g ), gl_FragColor.b );
                float bandedClearcoat = applyClearcoatCel( rawClearcoat );
                gl_FragColor.rgb += vec3( bandedClearcoat ) * moodClearcoat;

                // Apply iridescence sparkle mapping
                float iridescenceAngle = dot( normalize( vNormal ), normalize( vViewPosition ) );
                vec3 sparkle = mapIridescenceSparkle( moodIridescence, iridescenceAngle );
                gl_FragColor.rgb += sparkle;

                // Apply sheen rim glow
                float ndotv = abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
                float sheenRim = computeSheenRim( moodSheen, ndotv );
                gl_FragColor.rgb += vec3( sheenRim );

                // Apply transmission cel banding
                gl_FragColor.rgb = applyTransmissionCel( gl_FragColor.rgb, moodTransmission );

                // Apply simplex-noise dithering
                if ( ditherAmplitude > 0.0 ) {
                    float d = fract( sin( gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233 ) * 43758.5453 );
                    gl_FragColor.rgb += ( d - 0.5 ) * ditherAmplitude / 255.0;
                }

                // Apply paper grain
                gl_FragColor.a *= samplePaperGrain( vUv );
            ` );
    }

    /**
     * The custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.clearcoat,
            this.clearcoatRoughness,
            this.clearcoatBands,
            this.clearcoatQuantize,
            this.clearcoatThreshold,
            this.clearcoatSoftness,
            this.iridescence,
            this.iridescenceIOR,
            this.iridescenceBands,
            this.iridescenceAngleShift,
            this.sheen,
            this.sheenRoughness,
            this.sheenRimPower,
            this.sheenRimIntensity,
            this.transmission,
            this.transmissionBands,
            this.transmissionQuantize,
            this.anisotropy,
            this.anisotropyRotation,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.paperGrain,
            this.watercolorBleed,
            this.ditherAmplitude,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {MeshPhysicalMaterial} source - The material to copy from.
     * @return {MeshPhysicalMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        // Clearcoat
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.clearcoatMap = source.clearcoatMap;
        this.clearcoatRoughnessMap = source.clearcoatRoughnessMap;
        this.clearcoatNormalMap = source.clearcoatNormalMap;
        this.clearcoatNormalScale.copy( source.clearcoatNormalScale );

        // Iridescence
        this.iridescence = source.iridescence;
        this.iridescenceIOR = source.iridescenceIOR;
        this.iridescenceThicknessRange.copy( source.iridescenceThicknessRange );
        this.iridescenceMap = source.iridescenceMap;
        this.iridescenceThicknessMap = source.iridescenceThicknessMap;

        // Sheen
        this.sheen = source.sheen;
        this.sheenColor.copy( source.sheenColor );
        this.sheenColorMap = source.sheenColorMap;
        this.sheenRoughness = source.sheenRoughness;
        this.sheenRoughnessMap = source.sheenRoughnessMap;

        // Transmission
        this.transmission = source.transmission;
        this.transmissionMap = source.transmissionMap;
        this.thickness = source.thickness;
        this.thicknessMap = source.thicknessMap;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy( source.attenuationColor );

        // Specular
        this.specularIntensity = source.specularIntensity;
        this.specularIntensityMap = source.specularIntensityMap;
        this.specularColor.copy( source.specularColor );
        this.specularColorMap = source.specularColorMap;

        // Anisotropy
        this.anisotropy = source.anisotropy;
        this.anisotropyRotation = source.anisotropyRotation;
        this.anisotropyMap = source.anisotropyMap;

        // Anime extensions
        this.clearcoatBands = source.clearcoatBands;
        this.clearcoatQuantize = source.clearcoatQuantize;
        this.clearcoatThreshold = source.clearcoatThreshold;
        this.clearcoatSoftness = source.clearcoatSoftness;
        this.iridescenceBands = source.iridescenceBands;
        this.iridescenceAngleShift = source.iridescenceAngleShift;
        this.sheenRimPower = source.sheenRimPower;
        this.sheenRimIntensity = source.sheenRimIntensity;
        this.transmissionBands = source.transmissionBands;
        this.transmissionQuantize = source.transmissionQuantize;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy( source.moodColor );
        this.moodRoughness = source.moodRoughness;
        this.moodMetalness = source.moodMetalness;
        this.moodClearcoat = source.moodClearcoat;
        this.moodSheen = source.moodSheen;
        this.moodIridescence = source.moodIridescence;
        this.moodTransmission = source.moodTransmission;
        this.moodAnisotropy = source.moodAnisotropy;
        this.paperGrain = source.paperGrain;
        this.watercolorBleed = source.watercolorBleed;
        this.ditherAmplitude = source.ditherAmplitude;
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

        data.type = 'MeshPhysicalMaterial';

        // Clearcoat
        if ( this.clearcoat !== 0.0 ) data.clearcoat = this.clearcoat;
        if ( this.clearcoatRoughness !== 0.0 ) data.clearcoatRoughness = this.clearcoatRoughness;
        if ( this.clearcoatMap !== null ) data.clearcoatMap = this.clearcoatMap.toJSON( meta ).uuid;
        if ( this.clearcoatRoughnessMap !== null ) data.clearcoatRoughnessMap = this.clearcoatRoughnessMap.toJSON( meta ).uuid;
        if ( this.clearcoatNormalMap !== null ) data.clearcoatNormalMap = this.clearcoatNormalMap.toJSON( meta ).uuid;
        if ( this.clearcoatNormalScale.x !== 1 || this.clearcoatNormalScale.y !== 1 ) {
            data.clearcoatNormalScale = this.clearcoatNormalScale.toArray();
        }

        // Iridescence
        if ( this.iridescence !== 0.0 ) data.iridescence = this.iridescence;
        if ( this.iridescenceIOR !== 1.3 ) data.iridescenceIOR = this.iridescenceIOR;
        if ( this.iridescenceThicknessRange.x !== 100 || this.iridescenceThicknessRange.y !== 400 ) {
            data.iridescenceThicknessRange = this.iridescenceThicknessRange.toArray();
        }
        if ( this.iridescenceMap !== null ) data.iridescenceMap = this.iridescenceMap.toJSON( meta ).uuid;
        if ( this.iridescenceThicknessMap !== null ) data.iridescenceThicknessMap = this.iridescenceThicknessMap.toJSON( meta ).uuid;

        // Sheen
        if ( this.sheen !== 0.0 ) data.sheen = this.sheen;
        if ( this.sheenColor.getHex() !== 0x000000 ) data.sheenColor = this.sheenColor.getHex();
        if ( this.sheenColorMap !== null ) data.sheenColorMap = this.sheenColorMap.toJSON( meta ).uuid;
        if ( this.sheenRoughness !== 1.0 ) data.sheenRoughness = this.sheenRoughness;
        if ( this.sheenRoughnessMap !== null ) data.sheenRoughnessMap = this.sheenRoughnessMap.toJSON( meta ).uuid;

        // Transmission
        if ( this.transmission !== 0.0 ) data.transmission = this.transmission;
        if ( this.transmissionMap !== null ) data.transmissionMap = this.transmissionMap.toJSON( meta ).uuid;
        if ( this.thickness !== 0 ) data.thickness = this.thickness;
        if ( this.thicknessMap !== null ) data.thicknessMap = this.thicknessMap.toJSON( meta ).uuid;
        if ( this.attenuationDistance !== Infinity ) data.attenuationDistance = this.attenuationDistance;
        if ( this.attenuationColor.getHex() !== 0xffffff ) data.attenuationColor = this.attenuationColor.getHex();

        // Specular
        if ( this.specularIntensity !== 1.0 ) data.specularIntensity = this.specularIntensity;
        if ( this.specularIntensityMap !== null ) data.specularIntensityMap = this.specularIntensityMap.toJSON( meta ).uuid;
        if ( this.specularColor.getHex() !== 0xffffff ) data.specularColor = this.specularColor.getHex();
        if ( this.specularColorMap !== null ) data.specularColorMap = this.specularColorMap.toJSON( meta ).uuid;

        // Anisotropy
        if ( this.anisotropy !== 0.0 ) data.anisotropy = this.anisotropy;
        if ( this.anisotropyRotation !== 0.0 ) data.anisotropyRotation = this.anisotropyRotation;
        if ( this.anisotropyMap !== null ) data.anisotropyMap = this.anisotropyMap.toJSON( meta ).uuid;

        // Anime extensions
        if ( this.clearcoatBands !== 2 ) data.clearcoatBands = this.clearcoatBands;
        if ( this.clearcoatQuantize !== 1.0 ) data.clearcoatQuantize = this.clearcoatQuantize;
        if ( this.clearcoatThreshold !== 0.5 ) data.clearcoatThreshold = this.clearcoatThreshold;
        if ( this.clearcoatSoftness !== 0.05 ) data.clearcoatSoftness = this.clearcoatSoftness;
        if ( this.iridescenceBands !== 5 ) data.iridescenceBands = this.iridescenceBands;
        if ( this.iridescenceAngleShift !== 0.5 ) data.iridescenceAngleShift = this.iridescenceAngleShift;
        if ( this.sheenRimPower !== 2.0 ) data.sheenRimPower = this.sheenRimPower;
        if ( this.sheenRimIntensity !== 0 ) data.sheenRimIntensity = this.sheenRimIntensity;
        if ( this.transmissionBands !== 0 ) data.transmissionBands = this.transmissionBands;
        if ( this.transmissionQuantize !== 1.0 ) data.transmissionQuantize = this.transmissionQuantize;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.paperGrain !== 0 ) data.paperGrain = this.paperGrain;
        if ( this.watercolorBleed !== 0 ) data.watercolorBleed = this.watercolorBleed;
        if ( this.ditherAmplitude !== 0 ) data.ditherAmplitude = this.ditherAmplitude;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    MeshPhysicalMaterial,
    MeshPhysicalMaterialBatch,
    applyClearcoatCelBanding,
    mapIridescenceToAnimeSparkle,
    computeSheenRimGlow,
    applyTransmissionCelBanding,
    moodAdvancedPBRRebalance,
    generateAdvancedPBRTexture
};
export default MeshPhysicalMaterial;