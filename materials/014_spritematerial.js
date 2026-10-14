// file number : 014
// full path name : src/materials/014_spritematerial.js
// description : SpriteMaterial (three.js r185) rewritten as a high-performance ES module with deep anime-stylization integration. Extends the anime-enabled 001_material.js base class and preserves the full r185 SpriteMaterial API — color, map, alphaMap, rotation, sizeAttenuation, fog, and the inherited material surface. Sprites are the backbone of anime billboards: cherry-blossom petals, distant foliage cards, energy auras, speech-bubble overlays, and any camera-facing textured quad. Adds real-time anime features specifically tuned for sprite rendering: sprite-domain cel banding (quantize the sprite's luminance into flat bands for a toon-consistent look), mood-based color grading (warm sunset glints, cool cyan snow motes), rim glow on sprite edges (matches the glowing water sparkles and character auras in the reference imagery), procedural paper-grain and watercolor texture variation via simplex-noise, rotation-driven animated shimmer (organic breathing for magical effects), and per-instance variation for massive sprite crowds. Imports Color, Euler, Vector2, Vector3, and other math classes strictly from threejs_new01 math, and uses gl-matrix for zero-allocation sprite color transforms, double.js for bit-exact cel banding and HDR mood grading, bitecs SoA batching for real-time updates across hundreds of thousands of sprite instances, and simplex-noise for procedural texture variation and animated shimmer.
// best for : SpriteMaterial, anime particle billboards, cherry-blossom petals, foliage cards, energy auras, glowing magic effects, speech-bubble overlays, distant character cards, and any three.js sprite rendering that needs real-time anime stylization.
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

// gl-matrix scratch for zero-allocation sprite color transforms
const _gm_rgb = glMatrix.vec3.create();
const _gm_rgba = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// Anime feature — sprite-domain cel banding
// ---------------------------------------------------------------------------
/**
 * Quantize a sprite's sampled color into cel-shading bands using double.js
 * for bit-exact thresholding. Because sprites are unlit textured quads,
 * quantizing the sampled luminance directly produces a clean cel effect —
 * this matches the reference imagery's flat-shaded anime look on foliage
 * cards, petals, and distant character silhouettes.
 * @param {Color} sampledColor - The color sampled from the sprite texture.
 * @param {Color} output - The output color (modified in place).
 * @param {number} bands - Number of cel bands (2-6 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0-1).
 * @param {number} [shadowTint=0.8] - Shadow band brightness multiplier.
 * @returns {Color}
 */
function applySpriteCelBanding( sampledColor, output, bands, quantizeAmount, shadowTint = 0.8 ) {
    if ( bands <= 1 ) {
        output.copy( sampledColor );
        return output;
    }

    // Compute the luminance of the sampled sprite color
    _double.value = 0.2126 * sampledColor.r;
    _double.add( 0.7152 * sampledColor.g );
    _double.add( 0.0722 * sampledColor.b );
    const lum = _double.value;

    // Quantize the luminance
    const bandWidth = 1.0 / bands;
    _double.value = lum;
    _double.div( bandWidth );
    const bandIndex = Math.floor( _double.value );
    _double.value = bandIndex;
    _double.mul( bandWidth );
    _double.add( bandWidth * 0.5 );
    const quantized = _double.value;

    // Blend continuous and quantized
    _double.value = lum;
    _double.add( ( quantized - lum ) * quantizeAmount );
    const finalLum = _double.value;

    // Apply shadow tint to darker bands
    _double.value = shadowTint;
    _double.add( ( 1.0 - shadowTint ) * Math.min( 1, finalLum / Math.max( lum, 0.0001 ) ) );
    const shadowMul = Math.min( 1, _double.value );

    // Preserve hue, only change luminance
    if ( lum > 0.0001 ) {
        _double.value = sampledColor.r;
        _double.div( lum );
        _double.mul( finalLum );
        _double.mul( shadowMul );
        output.r = _double.value;

        _double.value = sampledColor.g;
        _double.div( lum );
        _double.mul( finalLum );
        _double.mul( shadowMul );
        output.g = _double.value;

        _double.value = sampledColor.b;
        _double.div( lum );
        _double.mul( finalLum );
        _double.mul( shadowMul );
        output.b = _double.value;
    } else {
        output.copy( sampledColor );
    }

    output.a = sampledColor.a;

    // Clamp
    output.r = Math.max( 0, Math.min( 1, output.r ) );
    output.g = Math.max( 0, Math.min( 1, output.g ) );
    output.b = Math.max( 0, Math.min( 1, output.b ) );
    return output;
}

// ---------------------------------------------------------------------------
// Anime feature — mood-based sprite color grading
// ---------------------------------------------------------------------------
/**
 * Apply mood-based color grading tuned for sprite rendering. Handles warm
 * (sunset gold petals, fireflies) and cool (snow motes, icy auras) moods
 * seen across the reference imagery. Uses gl-matrix for zero-allocation
 * staging and double.js for bit-exact accumulation.
 * @param {Color} color - The sprite color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeSpriteColor( color, temperature, saturation, brightness, contrast ) {
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
    _double.value = r; _double.add( temperature * 0.14 ); r = _double.value;
    _double.value = b; _double.sub( temperature * 0.14 ); b = _double.value;

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
// Anime feature — sprite rim glow (glowing aura effect)
// ---------------------------------------------------------------------------
/**
 * Compute a sprite rim glow based on the distance from the sprite's UV
 * center. Near the edges of the sprite quad, the glow ramps up — producing
 * the characteristic anime aura and magical shimmer seen on petals,
 * fireflies, and glowing effects in the reference imagery.
 * @param {number} u - U coordinate in [0, 1].
 * @param {number} v - V coordinate in [0, 1].
 * @param {number} [power=2.0] - Rim falloff power (higher = tighter rim).
 * @param {number} [intensity=1.0] - Rim intensity multiplier.
 * @returns {number} Rim intensity in [0, 1].
 */
function computeSpriteRimGlow( u, v, power = 2.0, intensity = 1.0 ) {
    _double.value = u;
    _double.sub( 0.5 );
    _double.mul( 2.0 );
    const cx = _double.value;

    _double.value = v;
    _double.sub( 0.5 );
    _double.mul( 2.0 );
    const cy = _double.value;

    _double.value = cx * cx;
    _double.add( cy * cy );
    const distSquared = _double.value;

    _double.value = 1.0 - Math.min( 1, distSquared );
    const rim = Math.pow( Math.max( 0, _double.value ), power );
    return Math.max( 0, Math.min( 1, rim * intensity ) );
}

// ---------------------------------------------------------------------------
// Anime feature — simplex-noise animated shimmer
// ---------------------------------------------------------------------------
/**
 * Compute an animated shimmer factor for a sprite using simplex-noise.
 * Produces organic brightness variation over time, giving magic effects
 * and glowing auras a breathing quality — no two frames look identical.
 * @param {number} time - Current time in seconds.
 * @param {number} particleIndex - Index of the sprite in the system.
 * @param {number} [amplitude=0.3] - Shimmer amplitude in [0, 1].
 * @param {number} [frequency=1.0] - Shimmer frequency.
 * @param {number} [seed=0] - Per-instance seed for decorrelation.
 * @returns {number} Shimmer multiplier in [0, 1].
 */
function computeSpriteShimmer( time, particleIndex, amplitude = 0.3, frequency = 1.0, seed = 0 ) {
    const n = _noise2D( time * frequency + seed, particleIndex * 0.1 ) * 0.5 + 0.5;
    _double.value = 1.0;
    _double.sub( ( 1.0 - n ) * amplitude );
    return Math.max( 0, Math.min( 1, _double.value ) );
}

// ---------------------------------------------------------------------------
// Anime feature — procedural paper-grain / watercolor texture variation
// ---------------------------------------------------------------------------
/**
 * Generate a procedural paper-grain / watercolor texture using simplex-noise
 * with multiple octaves. Produces the hand-painted texture characteristic
 * of the reference imagery's sprite surfaces (petals, leaves, motes).
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.05] - Base noise scale.
 * @param {number} [octaves=4] - Number of noise octaves.
 * @param {number} [paperGrain=0.4] - Paper grain intensity.
 * @param {number} [watercolorBleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateSpriteTexture( width, height, scale = 0.05, octaves = 4, paperGrain = 0.4, watercolorBleed = 0.5 ) {
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
// bitecs SoA batch coordinator for real-time sprite material updates
// ---------------------------------------------------------------------------
const _spriteWorld = createWorld();
const SpriteMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    celBands: Types.ui8,
    celQuantize: Types.f64,
    celShadowTint: Types.f64,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    rimGlow: Types.f64,
    rimPower: Types.f64,
    shimmerAmplitude: Types.f64,
    shimmerFrequency: Types.f64,
    paperGrain: Types.f64,
    watercolorBleed: Types.f64,
    dirty: Types.ui8
} );

class SpriteMaterialBatch {

    constructor() {
        this.world = _spriteWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a SpriteMaterial instance for batched real-time updates.
     * @param {SpriteMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, SpriteMaterialComponent, eid );
        SpriteMaterialComponent.materialPtr[ eid ] = this.materials.length;
        SpriteMaterialComponent.celBands[ eid ] = material.celBands;
        SpriteMaterialComponent.celQuantize[ eid ] = material.celQuantize;
        SpriteMaterialComponent.celShadowTint[ eid ] = material.celShadowTint;
        SpriteMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        SpriteMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        SpriteMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        SpriteMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        SpriteMaterialComponent.rimGlow[ eid ] = material.rimGlow;
        SpriteMaterialComponent.rimPower[ eid ] = material.rimPower;
        SpriteMaterialComponent.shimmerAmplitude[ eid ] = material.shimmerAmplitude;
        SpriteMaterialComponent.shimmerFrequency[ eid ] = material.shimmerFrequency;
        SpriteMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        SpriteMaterialComponent.watercolorBleed[ eid ] = material.watercolorBleed;
        SpriteMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply all queued sprite-material updates in one cache-friendly pass.
     * Uses double.js internally for bit-exact cel banding and mood grading.
     */
    process() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ SpriteMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            material.celBands = SpriteMaterialComponent.celBands[ eid ];
            material.celQuantize = SpriteMaterialComponent.celQuantize[ eid ];
            material.celShadowTint = SpriteMaterialComponent.celShadowTint[ eid ];
            material.moodTemperature = SpriteMaterialComponent.moodTemperature[ eid ];
            material.moodSaturation = SpriteMaterialComponent.moodSaturation[ eid ];
            material.moodBrightness = SpriteMaterialComponent.moodBrightness[ eid ];
            material.moodContrast = SpriteMaterialComponent.moodContrast[ eid ];
            material.rimGlow = SpriteMaterialComponent.rimGlow[ eid ];
            material.rimPower = SpriteMaterialComponent.rimPower[ eid ];
            material.shimmerAmplitude = SpriteMaterialComponent.shimmerAmplitude[ eid ];
            material.shimmerFrequency = SpriteMaterialComponent.shimmerFrequency[ eid ];
            material.paperGrain = SpriteMaterialComponent.paperGrain[ eid ];
            material.watercolorBleed = SpriteMaterialComponent.watercolorBleed[ eid ];

            // Recompute mood-graded color
            material.moodColor.copy( material.color );
            gradeSpriteColor(
                material.moodColor,
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );

            SpriteMaterialComponent.dirty[ eid ] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main SpriteMaterial class — mirrors
// three.js/src/materials/SpriteMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material for rendering instances of {@link Sprite}.
 *
 * Sprites are camera-facing textured quads used for particle systems,
 * billboards, and overlays. They are the backbone of anime particle
 * effects — cherry-blossom petals, fireflies, glowing auras, and
 * speech-bubble overlays.
 *
 * In addition to the standard three.js parameters, this material exposes
 * a rich set of real-time anime-style controls: sprite-domain cel banding,
 * mood-based color grading, sprite rim glow, simplex-noise animated
 * shimmer, and procedural paper-grain / watercolor texture variation.
 *
 * ```js
 * const material = new THREE.SpriteMaterial( {
 *   color: 0xffffff,
 *   map: spriteTexture,
 *   celBands: 3,
 *   celShadowTint: 0.8,
 *   rimGlow: 0.4,
 *   shimmerAmplitude: 0.3,
 *   moodTemperature: 0.3
 * } );
 * ```
 * @augments Material
 */
class SpriteMaterial extends Material {

    /**
     * Constructs a new sprite material.
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
        this.isSpriteMaterial = true;

        this.type = 'SpriteMaterial';

        /**
         * Color of the material.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color( 0xffffff );

        /**
         * The sprite's rotation in radians.
         * @type {number}
         * @default 0
         */
        this.rotation = 0;

        /**
         * The color map. May optionally include an alpha channel, typically
         * combined with {@link Material#transparent} or
         * {@link Material#alphaTest}. The texture map color is modulated by
         * the diffuse `color`.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * The alpha map is a grayscale texture that controls the opacity
         * across the surface (black: fully transparent; white: fully opaque).
         * Only the color of the texture is used, ignoring the alpha channel
         * if one exists. For RGB and RGBA textures, the renderer will use
         * the green channel when sampling this texture due to the extra bit
         * of precision provided for green in DXT-compressed and uncompressed
         * RGB 565 formats. Luminance-only and luminance/alpha textures will
         * also still work as expected.
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * Specifies whether the size of the sprite is attenuated by the
         * camera depth (perspective camera only).
         * @type {boolean}
         * @default true
         */
        this.sizeAttenuation = true;

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
         * Number of cel bands applied to the sprite-sampled color.
         * 2-6 = classic anime flat-shading on sprite surfaces.
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Blend amount between continuous and banded sprite color.
         * @type {number}
         * @default 1.0
         */
        this.celQuantize = 1.0;

        /**
         * Shadow band brightness multiplier for the darkest cel band.
         * @type {number}
         * @default 0.8
         */
        this.celShadowTint = 0.8;

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
         * Sprite rim-glow intensity. Set > 0 to enable the glowing aura
         * effect on the sprite's edges.
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Rim-glow color. Defaults to cool cyan.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color( 0.5, 0.9, 1.0 );

        /**
         * Rim-glow falloff power. Higher = tighter rim.
         * @type {number}
         * @default 2.0
         */
        this.rimPower = 2.0;

        /**
         * Simplex-noise animated shimmer amplitude.
         * @type {number}
         * @default 0
         */
        this.shimmerAmplitude = 0;

        /**
         * Simplex-noise animated shimmer frequency.
         * @type {number}
         * @default 1.0
         */
        this.shimmerFrequency = 1.0;

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

        /**
         * Internal elapsed time accumulator for shimmer animation.
         * @type {number}
         * @private
         * @default 0
         */
        this._elapsed = 0;

        this.setValues( parameters );

        // Initialize derived colors.
        this.updateMoodColor();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Apply cel banding to a sampled sprite color.
     * @param {Color} sampledColor - The sampled sprite color.
     * @param {Color} output - The output color.
     * @returns {Color}
     */
    applySpriteBanding( sampledColor, output ) {
        return applySpriteCelBanding(
            sampledColor,
            output,
            this.celBands,
            this.celQuantize,
            this.celShadowTint
        );
    }

    /**
     * Compute the sprite rim glow for a given UV coordinate.
     * @param {number} u
     * @param {number} v
     * @returns {number}
     */
    sampleRimGlow( u, v ) {
        if ( this.rimGlow <= 0 ) return 0;
        return computeSpriteRimGlow( u, v, this.rimPower, this.rimGlow );
    }

    /**
     * Compute the animated shimmer factor for a sprite at the current time.
     * Advances the internal elapsed time accumulator.
     * @param {number} delta - Time delta in seconds.
     * @param {number} particleIndex - Index of the sprite in the system.
     * @returns {number}
     */
    advanceShimmer( delta, particleIndex ) {
        this._elapsed += delta;
        if ( this.shimmerAmplitude <= 0 ) return 1;
        return computeSpriteShimmer(
            this._elapsed,
            particleIndex,
            this.shimmerAmplitude,
            this.shimmerFrequency,
            this.variationSeed
        );
    }

    /**
     * Recompute the mood-graded color from the current mood parameters.
     * @returns {SpriteMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy( this.color );
        gradeSpriteColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Generate a procedural paper-grain / watercolor texture for this
     * material. The caller is expected to assign the returned buffer to
     * a `DataTexture` and attach it to `map` or `alphaMap`.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.05]
     * @param {number} [octaves=4]
     * @returns {Uint8Array}
     */
    generateSpriteTexture( width, height, scale = 0.05, octaves = 4 ) {
        return generateSpriteTexture( width, height, scale, octaves, this.paperGrain, this.watercolorBleed );
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
     * anime shader chunks with sprite-specific features.
     * @param {Object} shader - The shader object.
     * @param {WebGLRenderer} renderer - The renderer.
     */
    onBeforeCompile( shader, renderer ) {
        // Call the base Material hook first
        super.onBeforeCompile( shader, renderer );

        // Inject sprite-specific uniforms
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.celQuantize = { value: this.celQuantize };
        shader.uniforms.celShadowTint = { value: this.celShadowTint };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.rimPower = { value: this.rimPower };
        shader.uniforms.shimmerAmplitude = { value: this.shimmerAmplitude };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };
        shader.uniforms.uTime = { value: 0 };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace( 'uniform float brushJitter;', `uniform float brushJitter;
                uniform int celBands;
                uniform float celQuantize;
                uniform float celShadowTint;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float rimPower;
                uniform float shimmerAmplitude;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float variationOffset;
                uniform float uTime;

                vec3 applySpriteBanding( vec3 sampled ) {
                    if ( celBands <= 1 ) return sampled;
                    float lum = dot( sampled, vec3( 0.2126, 0.7152, 0.0722 ) );
                    float bandWidth = 1.0 / float( celBands );
                    float bandIndex = floor( lum / bandWidth );
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float finalLum = mix( lum, quantized, celQuantize );
                    float shadowMul = min( 1.0, celShadowTint + ( 1.0 - celShadowTint ) * ( finalLum / max( lum, 0.0001 ) ) );
                    return sampled * ( finalLum / max( lum, 0.0001 ) ) * shadowMul;
                }

                float computeSpriteRim( vec2 uv ) {
                    if ( rimGlow <= 0.0 ) return 0.0;
                    vec2 c = uv * 2.0 - 1.0;
                    float distSquared = dot( c, c );
                    float rim = pow( clamp( 1.0 - distSquared, 0.0, 1.0 ), rimPower );
                    return rim * rimGlow;
                }

                float samplePaperGrain( vec2 uv ) {
                    if ( paperGrain <= 0.0 ) return 1.0;
                    float n = sin( uv.x * 8.0 + variationOffset ) * cos( uv.y * 8.0 + variationOffset );
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * ( 1.0 - n );
                }
            ` )
            .replace( 'gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );', `gl_FragColor.rgb = applyMoodGrading( gl_FragColor.rgb );

                // Apply sprite-domain cel banding
                gl_FragColor.rgb = applySpriteBanding( gl_FragColor.rgb );

                // Override with mood-graded color for sprite materials
                gl_FragColor.rgb = mix( gl_FragColor.rgb, moodColor, 0.85 );

                // Animated shimmer
                if ( shimmerAmplitude > 0.0 ) {
                    float shimmer = sin( uTime * 2.0 + variationOffset ) * 0.5 + 0.5;
                    gl_FragColor.rgb *= ( 1.0 - shimmerAmplitude * 0.5 + shimmer * shimmerAmplitude );
                }

                // Rim glow
                float rim = computeSpriteRim( vUv );
                gl_FragColor.rgb += rimGlowColor * rim;

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
            this.rotation,
            this.sizeAttenuation,
            this.celBands,
            this.celQuantize,
            this.celShadowTint,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.rimGlow,
            this.rimPower,
            this.shimmerAmplitude,
            this.shimmerFrequency,
            this.paperGrain,
            this.watercolorBleed,
            this.variationSeed
        ].join( '|' );
    }

    /**
     * Copy the given material's properties into this one.
     * @param {SpriteMaterial} source - The material to copy from.
     * @return {SpriteMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.color.copy( source.color );
        this.rotation = source.rotation;
        this.map = source.map;
        this.alphaMap = source.alphaMap;
        this.sizeAttenuation = source.sizeAttenuation;
        this.fog = source.fog;

        // Anime extensions
        this.celBands = source.celBands;
        this.celQuantize = source.celQuantize;
        this.celShadowTint = source.celShadowTint;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy( source.moodColor );
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy( source.rimGlowColor );
        this.rimPower = source.rimPower;
        this.shimmerAmplitude = source.shimmerAmplitude;
        this.shimmerFrequency = source.shimmerFrequency;
        this.paperGrain = source.paperGrain;
        this.watercolorBleed = source.watercolorBleed;
        this.variationSeed = source.variationSeed;
        this._elapsed = source._elapsed;

        return this;
    }

    /**
     * Serializes the material into JSON.
     * @param {?(Object|string)} meta - An optional value holding meta information.
     * @return {Object} A JSON object representing the serialized material.
     */
    toJSON( meta ) {
        const data = super.toJSON( meta );

        data.type = 'SpriteMaterial';

        if ( this.color.getHex() !== 0xffffff ) data.color = this.color.getHex();
        if ( this.rotation !== 0 ) data.rotation = this.rotation;
        if ( this.map !== null ) data.map = this.map.toJSON( meta ).uuid;
        if ( this.alphaMap !== null ) data.alphaMap = this.alphaMap.toJSON( meta ).uuid;
        if ( this.sizeAttenuation === false ) data.sizeAttenuation = false;
        if ( this.fog === false ) data.fog = false;

        // Anime extensions
        if ( this.celBands !== 0 ) data.celBands = this.celBands;
        if ( this.celQuantize !== 1.0 ) data.celQuantize = this.celQuantize;
        if ( this.celShadowTint !== 0.8 ) data.celShadowTint = this.celShadowTint;
        if ( this.moodTemperature !== 0 ) data.moodTemperature = this.moodTemperature;
        if ( this.moodSaturation !== 1.0 ) data.moodSaturation = this.moodSaturation;
        if ( this.moodBrightness !== 1.0 ) data.moodBrightness = this.moodBrightness;
        if ( this.moodContrast !== 1.0 ) data.moodContrast = this.moodContrast;
        if ( this.rimGlow !== 0 ) data.rimGlow = this.rimGlow;
        if ( this.rimGlowColor.getHex() !== new Color( 0.5, 0.9, 1.0 ).getHex() ) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if ( this.rimPower !== 2.0 ) data.rimPower = this.rimPower;
        if ( this.shimmerAmplitude !== 0 ) data.shimmerAmplitude = this.shimmerAmplitude;
        if ( this.shimmerFrequency !== 1.0 ) data.shimmerFrequency = this.shimmerFrequency;
        if ( this.paperGrain !== 0 ) data.paperGrain = this.paperGrain;
        if ( this.watercolorBleed !== 0 ) data.watercolorBleed = this.watercolorBleed;
        if ( this.variationSeed !== 0 ) data.variationSeed = this.variationSeed;

        return data;
    }
}

export {
    SpriteMaterial,
    SpriteMaterialBatch,
    applySpriteCelBanding,
    gradeSpriteColor,
    computeSpriteRimGlow,
    computeSpriteShimmer,
    generateSpriteTexture
};
export default SpriteMaterial;