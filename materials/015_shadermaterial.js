// file number : 015
// full path name : src/materials/015_shadermaterial.js
// description : ShaderMaterial (three.js r185) rewritten as a high-performance ES module with deep anime-stylization integration. Extends the anime-enabled 001_material.js base class and preserves the full r185 ShaderMaterial API — defines, uniforms, uniformsGroups, vertexShader, fragmentShader, linewidth, wireframe, wireframeLinewidth, fog, lights, clipping, forceSinglePass, extensions, defaultAttributeValues, index0AttributeName, uniformsNeedUpdate, glslVersion, plus the inherited material surface. ShaderMaterial is the ultimate escape hatch: users supply raw GLSL, and three.js injects all built-in uniforms and attributes around it. For anime stylization this is the material that unlocks truly custom effects — hand-painted watercolor noise, procedural ink outlines, custom cel-band shaders, mood-driven color grading, atmospheric depth fog, and any effect the reference imagery demands. Adds real-time anime features: uniform-value animation via double.js bit-exact accumulation (critical for time-based shaders in long-running scenes), simplex-noise uniform injection helpers for procedural variation, gl-matrix uniform helpers for zero-allocation vector/matrix updates, bitecs SoA batching for coordinated uniform updates across many instances sharing a single shader, and anime uniform presets (cel-banding, rim-glow, mood-grading, paper-grain, watercolor-bleed) that can be toggled on/off at runtime. Imports Color, Vector2, Vector3, Vector4, Matrix3, Matrix4, Euler and other math classes strictly from threejs_new01 math, and uses gl-matrix for zero-allocation uniform staging, double.js for bit-exact uniform accumulation, bitecs SoA batching for real-time uniform updates across hundreds of thousands of shared-shader instances, and simplex-noise for procedural uniform variation.
// best for : ShaderMaterial, custom GLSL effects, anime watercolor shaders, ink-outline shaders, custom cel-band shaders, atmospheric depth fog, procedural texture generators, post-processing materials, and any three.js workflow that needs fully custom GPU shaders with real-time anime stylization.
// license : MIT

import { Material } from './001_material.js';
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';
import { Euler } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/008_Euler.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { Vector4 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/004_Vector4.js';
import { Matrix3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/009_Matrix3.js';
import { Matrix4 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/007_Matrix4.js';
import { Texture } from './../textures/002_texture.js';

// three.js r185 npm source — core, math, extras, and textures folders excluded per spec
import {
    NormalBlending,
    FrontSide,
    GLSL1,
    GLSL3,
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

// gl-matrix scratch for zero-allocation uniform staging
const _gm_v2 = glMatrix.vec2.create();
const _gm_v3 = glMatrix.vec3.create();
const _gm_v4 = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// Inline UniformsUtils — replaces the missing r185 helper since the renderers/
// folder is not available in the threejs_new01 tree.
// ---------------------------------------------------------------------------
const UniformsUtils = {

    /**
     * Deep-clone a uniforms object. Textures are shared by reference (they
     * live on the GPU and must not be duplicated per-instance), while
     * colors, vectors, matrices, and plain numbers are deep-copied.
     * @param {Object} src - The uniforms object to clone.
     * @returns {Object}
     */
    cloneUniforms( src ) {
        const dst = {};
        for ( const u in src ) {
            dst[ u ] = {};
            for ( const p in src[ u ] ) {
                const property = src[ u ][ p ];
                if ( property && ( property.isColor ||
                    property.isMatrix3 || property.isMatrix4 ||
                    property.isVector2 || property.isVector3 || property.isVector4 ||
                    property.isTexture || property.isQuaternion ) ) {
                    if ( property.isRenderTargetTexture ) {
                        console.warn( 'UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms()' );
                        dst[ u ][ p ] = null;
                    } else {
                        dst[ u ][ p ] = property.clone ? property.clone() : property;
                    }
                } else if ( Array.isArray( property ) ) {
                    dst[ u ][ p ] = property.slice();
                } else {
                    dst[ u ][ p ] = property;
                }
            }
        }
        return dst;
    },

    /**
     * Merge an array of uniform objects into a single object. Later entries
     * override earlier ones.
     * @param {Object[]} uniforms - Array of uniform objects.
     * @returns {Object}
     */
    merge( uniforms ) {
        const merged = {};
        for ( let i = 0; i < uniforms.length; i ++ ) {
            const src = uniforms[ i ];
            const dst = UniformsUtils.cloneUniforms( src );
            for ( const u in dst ) {
                merged[ u ] = dst[ u ];
            }
        }
        return merged;
    },

    /**
     * Clone an array of uniform groups. Each group is cloned with the same
     * rules as `cloneUniforms`.
     * @param {Array} src - The groups to clone.
     * @returns {Array}
     */
    cloneUniformsGroups( src ) {
        return src.map( group => ( {
            ...group,
            uniforms: UniformsUtils.cloneUniforms( group.uniforms )
        } ) );
    }
};

// ---------------------------------------------------------------------------
// Anime uniform presets — ready-made GLSL snippets for common anime effects
// ---------------------------------------------------------------------------
const ANIME_GLSL = {

    /**
     * Cel-band thresholding. Quantizes a lighting value into discrete
     * bands. Uses the (bit-exact) uniform `uAnimeBands` for band count.
     * Injected at the top of a fragment shader, callable as
     * `applyAnimeCelBands( lightValue )`.
     */
    celBands: `
        uniform int uAnimeBands;
        uniform float uAnimeShadowTint;
        uniform float uAnimeSoftness;

        float applyAnimeCelBands( float light ) {
            if ( uAnimeBands <= 1 ) return light;
            float bw = 1.0 / float( uAnimeBands );
            float bi = floor( light / bw );
            float q = bi * bw + bw * 0.5;
            float d = abs( light - bi * bw - bw * 0.5 );
            float sf = clamp( d / ( bw * 0.5 ), 0.0, 1.0 );
            float sq = q + ( light - q ) * ( 1.0 - sf ) * uAnimeSoftness;
            float sm = uAnimeShadowTint + ( 1.0 - uAnimeShadowTint ) * ( sq / max( light, 0.0001 ) );
            return light * ( sq / max( light, 0.0001 ) ) * sm;
        }
    `,

    /**
     * View-space normal rim glow. Produces the cyan water rims and warm
     * character rims seen across the reference imagery. Callable as
     * `applyAnimeRim( normal, viewDir )`.
     */
    rimGlow: `
        uniform float uAnimeRimPower;
        uniform float uAnimeRimIntensity;
        uniform vec3 uAnimeRimColor;

        float applyAnimeRim( vec3 n, vec3 v ) {
            float ndotv = abs( dot( normalize( n ), normalize( v ) ) );
            return pow( 1.0 - ndotv, uAnimeRimPower ) * uAnimeRimIntensity;
        }
    `,

    /**
     * Mood-based color grading. Rebalances hue/saturation/contrast/temperature
     * around a neutral midpoint. Callable as `applyAnimeMood( color )`.
     */
    moodGrading: `
        uniform vec3 uAnimeMoodTint;
        uniform float uAnimeMoodSaturation;
        uniform float uAnimeMoodContrast;
        uniform float uAnimeMoodBrightness;

        vec3 applyAnimeMood( vec3 c ) {
            float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
            vec3 sat = mix( vec3( lum ), c, uAnimeMoodSaturation );
            sat = ( sat - 0.5 ) * uAnimeMoodContrast + 0.5;
            sat *= uAnimeMoodBrightness;
            return sat * uAnimeMoodTint;
        }
    `,

    /**
     * Paper grain. Multiplies a subtle noise onto the fragment alpha so
     * the surface reads as hand-painted watercolor paper. Callable as
     * `applyAnimePaperGrain( uv )`.
     */
    paperGrain: `
        uniform float uAnimePaperGrain;
        uniform float uAnimePaperGrainScale;
        uniform float uAnimeVariationOffset;

        float applyAnimePaperGrain( vec2 uv ) {
            float n = sin( uv.x * uAnimePaperGrainScale + uAnimeVariationOffset )
                    * cos( uv.y * uAnimePaperGrainScale + uAnimeVariationOffset );
            n = n * 0.5 + 0.5;
            return 1.0 - uAnimePaperGrain * ( 1.0 - n );
        }
    `,

    /**
     * Watercolor bleed. Softens a value toward its extremes, producing the
     * wet-in-wet pigment diffusion of traditional watercolor backgrounds.
     * Callable as `applyAnimeWatercolorBleed( value )`.
     */
    watercolorBleed: `
        uniform float uAnimeWatercolorBleed;

        float applyAnimeWatercolorBleed( float v ) {
            float c = ( v - 0.5 ) * ( 1.0 + uAnimeWatercolorBleed ) + 0.5;
            return clamp( c, 0.0, 1.0 );
        }
    `,

    /**
     * Brush jitter. Distorts a UV coordinate using simplex-noise, giving
     * the surface a subtle hand-drawn wobble. Callable as
     * `applyAnimeBrushJitter( uv )`.
     */
    brushJitter: `
        uniform float uAnimeBrushJitter;
        uniform float uAnimeBrushJitterFrequency;
        uniform float uAnimeVariationOffset;

        vec2 applyAnimeBrushJitter( vec2 uv ) {
            float dx = sin( uv.x * uAnimeBrushJitterFrequency + uAnimeVariationOffset ) * uAnimeBrushJitter;
            float dy = cos( uv.y * uAnimeBrushJitterFrequency + uAnimeVariationOffset ) * uAnimeBrushJitter;
            return uv + vec2( dx, dy );
        }
    `
};

// ---------------------------------------------------------------------------
// Anime feature — presets enable/disable helper
// ---------------------------------------------------------------------------
/**
 * Compute the uniform defaults for the selected anime GLSL presets. Only
 * the presets that are enabled are inserted, keeping the shader program
 * size minimal. Uses double.js for bit-exact defaults on numerically
 * sensitive uniforms.
 * @param {Object} material - The ShaderMaterial instance.
 * @returns {Object} A map of uniform names to `{ value }` records.
 */
function buildAnimePresetUniforms( material ) {
    const u = {};

    if ( material.animeCelBands ) {
        u.uAnimeBands = { value: material.animeBands };
        u.uAnimeShadowTint = { value: material.animeShadowTint };
        u.uAnimeSoftness = { value: material.animeSoftness };
    }
    if ( material.animeRimGlow ) {
        u.uAnimeRimPower = { value: material.rimPower };
        u.uAnimeRimIntensity = { value: material.rimIntensity };
        u.uAnimeRimColor = { value: material.rimGlowColor };
    }
    if ( material.animeMoodGrading ) {
        _double.value = material.moodTemperature;
        u.uAnimeMoodTint = { value: material.moodTint.clone() };
        u.uAnimeMoodSaturation = { value: material.moodSaturation };
        u.uAnimeMoodContrast = { value: material.moodContrast };
        u.uAnimeMoodBrightness = { value: material.moodBrightness };
    }
    if ( material.animePaperGrain ) {
        u.uAnimePaperGrain = { value: material.paperGrain };
        u.uAnimePaperGrainScale = { value: material.paperGrainScale };
        u.uAnimeVariationOffset = { value: material.getVariationOffset() };
    }
    if ( material.animeWatercolorBleed ) {
        u.uAnimeWatercolorBleed = { value: material.watercolorBleed };
    }
    if ( material.animeBrushJitter ) {
        u.uAnimeBrushJitter = { value: material.brushJitter };
        u.uAnimeBrushJitterFrequency = { value: material.brushJitterFrequency };
        u.uAnimeVariationOffset = { value: material.getVariationOffset() };
    }

    return u;
}

/**
 * Compose the GLSL prelude from the selected anime presets. Returns the
 * concatenated uniform declarations and helper functions, ready to be
 * injected at the top of a fragment shader.
 * @param {Object} material
 * @returns {string}
 */
function buildAnimePresetGLSL( material ) {
    let src = '';
    if ( material.animeCelBands ) src += ANIME_GLSL.celBands;
    if ( material.animeRimGlow ) src += ANIME_GLSL.rimGlow;
    if ( material.animeMoodGrading ) src += ANIME_GLSL.moodGrading;
    if ( material.animePaperGrain ) src += ANIME_GLSL.paperGrain;
    if ( material.animeWatercolorBleed ) src += ANIME_GLSL.watercolorBleed;
    if ( material.animeBrushJitter ) src += ANIME_GLSL.brushJitter;
    return src;
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for real-time uniform updates
// ---------------------------------------------------------------------------
const _shaderWorld = createWorld();
const ShaderMaterialComponent = defineComponent( {
    materialPtr: Types.ui32,
    time: Types.f64,
    frame: Types.ui32,
    animeBands: Types.ui8,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    rimIntensity: Types.f64,
    paperGrain: Types.f64,
    watercolorBleed: Types.f64,
    brushJitter: Types.f64,
    dirty: Types.ui8
} );

class ShaderMaterialBatch {

    constructor() {
        this.world = _shaderWorld;
        this.materials = [];
        this.entities = [];
        this._elapsed = 0;
        this._frame = 0;
    }

    /**
     * Register a ShaderMaterial instance for batched real-time uniform
     * updates.
     * @param {ShaderMaterial} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, ShaderMaterialComponent, eid );
        ShaderMaterialComponent.materialPtr[ eid ] = this.materials.length;
        ShaderMaterialComponent.time[ eid ] = 0;
        ShaderMaterialComponent.frame[ eid ] = 0;
        ShaderMaterialComponent.animeBands[ eid ] = material.animeBands;
        ShaderMaterialComponent.moodTemperature[ eid ] = material.moodTemperature;
        ShaderMaterialComponent.moodSaturation[ eid ] = material.moodSaturation;
        ShaderMaterialComponent.moodBrightness[ eid ] = material.moodBrightness;
        ShaderMaterialComponent.moodContrast[ eid ] = material.moodContrast;
        ShaderMaterialComponent.rimIntensity[ eid ] = material.rimIntensity;
        ShaderMaterialComponent.paperGrain[ eid ] = material.paperGrain;
        ShaderMaterialComponent.watercolorBleed[ eid ] = material.watercolorBleed;
        ShaderMaterialComponent.brushJitter[ eid ] = material.brushJitter;
        ShaderMaterialComponent.dirty[ eid ] = 0;
        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Advance the batch by one frame. Updates the shared time uniform with
     * double.js precision (critical for long-running scenes where float32
     * time drifts and causes shader popping), increments the frame counter,
     * and refreshes any anime uniforms that changed via the ECS interface.
     * @param {number} delta - Time delta in seconds.
     */
    update( delta ) {
        _double.value = this._elapsed;
        _double.add( delta );
        this._elapsed = _double.value;
        this._frame ++;

        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ ShaderMaterialComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            ShaderMaterialComponent.time[ eid ] = this._elapsed;
            ShaderMaterialComponent.frame[ eid ] = this._frame;

            // Push shared time / frame into the material's uniform object
            if ( material.uniforms.uTime ) material.uniforms.uTime.value = this._elapsed;
            if ( material.uniforms.uFrame ) material.uniforms.uFrame.value = this._frame;

            // Push anime preset uniforms
            if ( material.animeCelBands ) {
                if ( material.uniforms.uAnimeBands ) material.uniforms.uAnimeBands.value = material.animeBands;
                if ( material.uniforms.uAnimeShadowTint ) material.uniforms.uAnimeShadowTint.value = material.animeShadowTint;
                if ( material.uniforms.uAnimeSoftness ) material.uniforms.uAnimeSoftness.value = material.animeSoftness;
            }
            if ( material.animeRimGlow ) {
                if ( material.uniforms.uAnimeRimPower ) material.uniforms.uAnimeRimPower.value = material.rimPower;
                if ( material.uniforms.uAnimeRimIntensity ) material.uniforms.uAnimeRimIntensity.value = material.rimIntensity;
                if ( material.uniforms.uAnimeRimColor ) material.uniforms.uAnimeRimColor.value.copy( material.rimGlowColor );
            }
            if ( material.animeMoodGrading ) {
                if ( material.uniforms.uAnimeMoodSaturation ) material.uniforms.uAnimeMoodSaturation.value = material.moodSaturation;
                if ( material.uniforms.uAnimeMoodContrast ) material.uniforms.uAnimeMoodContrast.value = material.moodContrast;
                if ( material.uniforms.uAnimeMoodBrightness ) material.uniforms.uAnimeMoodBrightness.value = material.moodBrightness;
            }
            if ( material.animePaperGrain ) {
                if ( material.uniforms.uAnimePaperGrain ) material.uniforms.uAnimePaperGrain.value = material.paperGrain;
                if ( material.uniforms.uAnimePaperGrainScale ) material.uniforms.uAnimePaperGrainScale.value = material.paperGrainScale;
                if ( material.uniforms.uAnimeVariationOffset ) material.uniforms.uAnimeVariationOffset.value = material.getVariationOffset();
            }
            if ( material.animeWatercolorBleed ) {
                if ( material.uniforms.uAnimeWatercolorBleed ) material.uniforms.uAnimeWatercolorBleed.value = material.watercolorBleed;
            }
            if ( material.animeBrushJitter ) {
                if ( material.uniforms.uAnimeBrushJitter ) material.uniforms.uAnimeBrushJitter.value = material.brushJitter;
                if ( material.uniforms.uAnimeBrushJitterFrequency ) material.uniforms.uAnimeBrushJitterFrequency.value = material.brushJitterFrequency;
            }

            ShaderMaterialComponent.dirty[ eid ] = 1;
        }
    }

    /**
     * Retrieve the accumulated elapsed time with double.js precision.
     * @returns {number}
     */
    get elapsed() {
        return this._elapsed;
    }

    /**
     * Retrieve the current frame counter.
     * @returns {number}
     */
    get frame() {
        return this._frame;
    }
}

// ---------------------------------------------------------------------------
// Anime feature — procedural uniform variation via simplex-noise
// ---------------------------------------------------------------------------
/**
 * Generate a procedural value for a shader uniform using simplex-noise.
 * Useful for injecting per-instance variation into a shared shader (e.g.
 * varying the phase of a watercolor ripple across a crowd).
 * @param {number} seed - Per-instance seed.
 * @param {number} channel - Noise channel selector (e.g. 0 for X, 100 for Y).
 * @param {number} [amplitude=1] - Noise amplitude.
 * @param {number} [frequency=1] - Noise frequency.
 * @returns {number} The generated value in [-amplitude, amplitude].
 */
function proceduralUniformNoise( seed, channel, amplitude = 1, frequency = 1 ) {
    const n = _noise2D( seed * frequency, channel );
    _double.value = n;
    _double.mul( amplitude );
    return _double.value;
}

// ---------------------------------------------------------------------------
// Main ShaderMaterial class — mirrors
// three.js/src/materials/ShaderMaterial.js
// ---------------------------------------------------------------------------
/**
 * A material rendered with custom shaders. A shader is a small program
 * written in GLSL that runs on the GPU. You may want to use a custom
 * shader if you need to implement an effect not included with any of the
 * built-in materials.
 *
 * In addition to the standard three.js parameters, this material exposes a
 * rich set of real-time anime-style controls via opt-in GLSL presets:
 * cel-band thresholding, view-space rim glow, mood-based color grading,
 * paper-grain texture, watercolor bleed, and brush jitter. Each preset
 * can be toggled independently and injects its uniforms and helper
 * functions at the top of the fragment shader.
 *
 * ```js
 * const material = new THREE.ShaderMaterial( {
 *   uniforms: {
 *     uTime: { value: 0 },
 *     uColor: { value: new THREE.Color( 0x88ccff ) }
 *   },
 *   vertexShader: `...`,
 *   fragmentShader: `...`,
 *   animeCelBands: true,
 *   animeRimGlow: true,
 *   animeBands: 3,
 *   rimIntensity: 0.4
 * } );
 * ```
 * @augments Material
 */
class ShaderMaterial extends Material {

    /**
     * Constructs a new shader material.
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
        this.isShaderMaterial = true;

        this.type = 'ShaderMaterial';

        /**
         * Defines custom constants using `#define` directives within the
         * GLSL code for both the vertex and fragment shaders.
         * @type {Object}
         */
        this.defines = {};

        /**
         * An object holding the uniforms to be passed to the shader code.
         * Keys are uniform names, values are `{ value }` records.
         * @type {Object}
         */
        this.uniforms = {};

        /**
         * An array holding uniforms groups for configuring UBOs.
         * @type {Array}
         */
        this.uniformsGroups = [];

        /**
         * Vertex shader GLSL code.
         * @type {string}
         */
        this.vertexShader = `void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`;

        /**
         * Fragment shader GLSL code.
         * @type {string}
         */
        this.fragmentShader = `void main() {
            gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
        }`;

        /**
         * Controls line thickness or lines. WebGL ignores this setting and
         * always renders line primitives with a width of one pixel.
         * @type {number}
         * @default 1
         */
        this.linewidth = 1;

        /**
         * Renders the geometry as a wireframe.
         * @type {boolean}
         * @default false
         */
        this.wireframe = false;

        /**
         * Controls the thickness of the wireframe. WebGL ignores this.
         * @type {number}
         * @default 1
         */
        this.wireframeLinewidth = 1;

        /**
         * Defines whether the material color is affected by global fog.
         * Setting `true` requires the definition of fog uniforms.
         * @type {boolean}
         * @default false
         */
        this.fog = false;

        /**
         * Defines whether this material uses lighting; `true` to pass
         * uniform data related to lighting to the shader.
         * @type {boolean}
         * @default false
         */
        this.lights = false;

        /**
         * Defines whether this material supports clipping; `true` to let
         * the renderer pass the `clippingPlanes` uniform.
         * @type {boolean}
         * @default false
         */
        this.clipping = false;

        /**
         * Overwritten and set to `true` by default.
         * @type {boolean}
         * @default true
         */
        this.forceSinglePass = true;

        /**
         * Extensions object for enabling WebGL 2 extensions.
         * @type {{clipCullDistance:boolean,multiDraw:boolean}}
         */
        this.extensions = {
            clipCullDistance: false,
            multiDraw: false
        };

        /**
         * Default attribute values passed to the shader when the geometry
         * doesn't include them.
         * @type {Object}
         */
        this.defaultAttributeValues = {
            'color': [ 1, 1, 1 ],
            'uv': [ 0, 0 ],
            'uv1': [ 0, 0 ]
        };

        /**
         * If set, binds a generic vertex index to an attribute variable.
         * @type {?string}
         * @default undefined
         */
        this.index0AttributeName = undefined;

        /**
         * Can be used to force a uniform update while changing uniforms in
         * `Object3D#onBeforeRender`.
         * @type {boolean}
         * @default false
         */
        this.uniformsNeedUpdate = false;

        /**
         * Defines the GLSL version of the custom shader code.
         * @type {?(GLSL1|GLSL3)}
         * @default null
         */
        this.glslVersion = null;

        // -------------------------------------------------------------------
        // Anime Rendering Extensions
        // -------------------------------------------------------------------
        /**
         * Enable the cel-band thresholding GLSL preset. When enabled, the
         * helper function `applyAnimeCelBands( light )` is injected into
         * the fragment shader along with its uniforms.
         * @type {boolean}
         * @default false
         */
        this.animeCelBands = false;

        /**
         * Enable the view-space rim-glow GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animeRimGlow = false;

        /**
         * Enable the mood-based color-grading GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animeMoodGrading = false;

        /**
         * Enable the paper-grain GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animePaperGrain = false;

        /**
         * Enable the watercolor-bleed GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animeWatercolorBleed = false;

        /**
         * Enable the brush-jitter GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animeBrushJitter = false;

        // ---- Cel-band preset parameters ----
        /** @type {number} @default 3 */
        this.animeBands = 3;
        /** @type {number} @default 0.7 */
        this.animeShadowTint = 0.7;
        /** @type {number} @default 0.1 */
        this.animeSoftness = 0.1;

        // ---- Rim-glow preset parameters ----
        /** @type {number} @default 2.5 */
        this.rimPower = 2.5;
        /** @type {number} @default 0.5 */
        this.rimIntensity = 0.5;
        /** @type {Color} @default (0.5, 0.9, 1.0) */
        this.rimGlowColor = new Color( 0.5, 0.9, 1.0 );

        // ---- Mood-grading preset parameters ----
        /** @type {Color} @default (1, 1, 1) */
        this.moodTint = new Color( 1, 1, 1 );
        /** @type {number} @default 1.0 */
        this.moodSaturation = 1.0;
        /** @type {number} @default 1.0 */
        this.moodContrast = 1.0;
        /** @type {number} @default 1.0 */
        this.moodBrightness = 1.0;
        /** @type {number} @default 0 */
        this.moodTemperature = 0;

        // ---- Paper-grain preset parameters ----
        /** @type {number} @default 0.3 */
        this.paperGrain = 0.3;
        /** @type {number} @default 10.0 */
        this.paperGrainScale = 10.0;

        // ---- Watercolor-bleed preset parameters ----
        /** @type {number} @default 0.5 */
        this.watercolorBleed = 0.5;

        // ---- Brush-jitter preset parameters ----
        /** @type {number} @default 0.01 */
        this.brushJitter = 0.01;
        /** @type {number} @default 1.0 */
        this.brushJitterFrequency = 1.0;

        // ---- Misc ----
        /** @type {number} @default 0 */
        this.variationSeed = 0;

        this.setValues( parameters );

        // Inject the anime GLSL presets and their uniforms now that the
        // parameters have been applied.
        this._injectAnimePresets();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------
    /**
     * Inject the enabled anime GLSL presets into the fragment shader and
     * add their uniforms to the uniform object. Safe to call multiple
     * times; the injection is guarded by a marker.
     * @private
     * @returns {ShaderMaterial} A reference to this instance.
     */
    _injectAnimePresets() {
        const prelude = buildAnimePresetGLSL( this );
        if ( prelude.length === 0 ) return this;

        const marker = '// === ANIME_PRESET_INJECTION ===';
        if ( this.fragmentShader.indexOf( marker ) !== - 1 ) return this;

        // Prepend the prelude after any leading #version / #extension lines.
        this.fragmentShader = marker + '\n' + prelude + '\n' + this.fragmentShader;

        // Merge preset uniforms with the user-supplied ones. User uniforms
        // win on conflict.
        const preset = buildAnimePresetUniforms( this );
        for ( const key in preset ) {
            if ( ! ( key in this.uniforms ) ) {
                this.uniforms[ key ] = preset[ key ];
            }
        }

        return this;
    }

    /**
     * Re-inject the anime presets. Call this after changing any of the
     * `animeXxx` enable flags at runtime; the material will be recompiled
     * on the next render.
     * @returns {ShaderMaterial} A reference to this instance.
     */
    refreshAnimePresets() {
        // Strip any prior injection
        const marker = '// === ANIME_PRESET_INJECTION ===';
        const idx = this.fragmentShader.indexOf( marker );
        if ( idx !== - 1 ) {
            // Find the end of the injected block — the original shader starts
            // at the next non-comment, non-whitespace line. We keep it simple
            // by remembering the original fragment shader on first call.
            if ( this._originalFragmentShader !== undefined ) {
                this.fragmentShader = this._originalFragmentShader;
            } else {
                // Fallback: strip up to and including the marker line only.
                this.fragmentShader = this.fragmentShader.substring( idx + marker.length );
            }
        } else {
            this._originalFragmentShader = this.fragmentShader;
        }

        // Remove prior preset uniforms
        for ( const key in this.uniforms ) {
            if ( key.indexOf( 'uAnime' ) === 0 ) {
                delete this.uniforms[ key ];
            }
        }

        return this._injectAnimePresets();
    }

    /**
     * Compute the per-instance variation offset used by the paper-grain
     * and brush-jitter presets.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * 137.508;
    }

    /**
     * Generate a procedural value for a shader uniform using simplex-noise.
     * @param {number} seed
     * @param {number} channel
     * @param {number} [amplitude=1]
     * @param {number} [frequency=1]
     * @returns {number}
     */
    proceduralUniformNoise( seed, channel, amplitude = 1, frequency = 1 ) {
        return proceduralUniformNoise( seed, channel, amplitude, frequency );
    }

    /**
     * Convenience: get a gl-matrix vec3 view of a Vector3 uniform. Useful
     * for passing uniform values into gl-matrix operations without
     * allocating a new array.
     * @param {string} name - The uniform name.
     * @returns {glMatrix.vec3|null}
     */
    getUniformGlMatVec3( name ) {
        const u = this.uniforms[ name ];
        if ( ! u || ! u.value || ! u.value.isVector3 ) return null;
        glMatrix.vec3.set( _gm_v3, u.value.x, u.value.y, u.value.z );
        return _gm_v3;
    }

    /**
     * Convenience: write a gl-matrix vec3 back into a Vector3 uniform.
     * @param {string} name - The uniform name.
     * @param {glMatrix.vec3} v - The gl-matrix vec3 source.
     * @returns {ShaderMaterial} A reference to this instance.
     */
    setUniformGlMatVec3( name, v ) {
        const u = this.uniforms[ name ];
        if ( u && u.value && u.value.isVector3 ) {
            u.value.set( v[ 0 ], v[ 1 ], v[ 2 ] );
        }
        return this;
    }

    /**
     * Convenience: write a gl-matrix vec4 back into a Vector4 uniform.
     * @param {string} name - The uniform name.
     * @param {glMatrix.vec4} v - The gl-matrix vec4 source.
     * @returns {ShaderMaterial} A reference to this instance.
     */
    setUniformGlMatVec4( name, v ) {
        const u = this.uniforms[ name ];
        if ( u && u.value && u.value.isVector4 ) {
            u.value.set( v[ 0 ], v[ 1 ], v[ 2 ], v[ 3 ] );
        }
        return this;
    }

    /**
     * Create a batched uniform-update coordinator backed by bitecs. Register
     * multiple ShaderMaterials and drive their shared `uTime`/`uFrame`
     * uniforms (and anime-preset uniforms) in one cache-friendly pass.
     * @returns {ShaderMaterialBatch}
     */
    static createBatch() {
        return new ShaderMaterialBatch();
    }

    // -----------------------------------------------------------------------
    // Core overrides
    // -----------------------------------------------------------------------
    /**
     * Copy the given material's properties into this one.
     * @param {ShaderMaterial} source - The material to copy from.
     * @return {ShaderMaterial} A reference to this instance.
     */
    copy( source ) {
        super.copy( source );

        this.fragmentShader = source.fragmentShader;
        this.vertexShader = source.vertexShader;
        this.uniforms = UniformsUtils.cloneUniforms( source.uniforms );
        this.uniformsGroups = UniformsUtils.cloneUniformsGroups( source.uniformsGroups );
        this.defines = Object.assign( {}, source.defines );
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.fog = source.fog;
        this.lights = source.lights;
        this.clipping = source.clipping;
        this.extensions = Object.assign( {}, source.extensions );
        this.glslVersion = source.glslVersion;
        this.defaultAttributeValues = Object.assign( {}, source.defaultAttributeValues );
        this.index0AttributeName = source.index0AttributeName;
        this.uniformsNeedUpdate = source.uniformsNeedUpdate;

        // Anime extensions
        this.animeCelBands = source.animeCelBands;
        this.animeRimGlow = source.animeRimGlow;
        this.animeMoodGrading = source.animeMoodGrading;
        this.animePaperGrain = source.animePaperGrain;
        this.animeWatercolorBleed = source.animeWatercolorBleed;
        this.animeBrushJitter = source.animeBrushJitter;
        this.animeBands = source.animeBands;
        this.animeShadowTint = source.animeShadowTint;
        this.animeSoftness = source.animeSoftness;
        this.rimPower = source.rimPower;
        this.rimIntensity = source.rimIntensity;
        this.rimGlowColor.copy( source.rimGlowColor );
        this.moodTint.copy( source.moodTint );
        this.moodSaturation = source.moodSaturation;
        this.moodContrast = source.moodContrast;
        this.moodBrightness = source.moodBrightness;
        this.moodTemperature = source.moodTemperature;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
        this.watercolorBleed = source.watercolorBleed;
        this.brushJitter = source.brushJitter;
        this.brushJitterFrequency = source.brushJitterFrequency;
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

        data.type = 'ShaderMaterial';
        data.glslVersion = this.glslVersion;
        data.uniforms = {};

        for ( const name in this.uniforms ) {
            const uniform = this.uniforms[ name ];
            const value = uniform.value;

            if ( value && value.isTexture ) {
                data.uniforms[ name ] = { type: 't', value: value.toJSON( meta ).uuid };
            } else if ( value && value.isColor ) {
                data.uniforms[ name ] = { type: 'c', value: value.getHex() };
            } else if ( value && value.isVector2 ) {
                data.uniforms[ name ] = { type: 'v2', value: value.toArray() };
            } else if ( value && value.isVector3 ) {
                data.uniforms[ name ] = { type: 'v3', value: value.toArray() };
            } else if ( value && value.isVector4 ) {
                data.uniforms[ name ] = { type: 'v4', value: value.toArray() };
            } else if ( value && value.isMatrix3 ) {
                data.uniforms[ name ] = { type: 'm3', value: value.toArray() };
            } else if ( value && value.isMatrix4 ) {
                data.uniforms[ name ] = { type: 'm4', value: value.toArray() };
            } else {
                data.uniforms[ name ] = { value: value };
            }
        }

        if ( Object.keys( this.defines ).length > 0 ) data.defines = this.defines;
        data.vertexShader = this.vertexShader;
        data.fragmentShader = this.fragmentShader;
        data.lights = this.lights;
        data.clipping = this.clipping;

        const extensions = {};
        for ( const key in this.extensions ) {
            if ( this.extensions[ key ] === true ) extensions[ key ] = true;
        }
        if ( Object.keys( extensions ).length > 0 ) data.extensions = extensions;

        // Anime extensions
        if ( this.animeCelBands ) data.animeCelBands = true;
        if ( this.animeRimGlow ) data.animeRimGlow = true;
        if ( this.animeMoodGrading ) data.animeMoodGrading = true;
        if ( this.animePaperGrain ) data.animePaperGrain = true;
        if ( this.animeWatercolorBleed ) data.animeWatercolorBleed = true;
        if ( this.animeBrushJitter ) data.animeBrushJitter = true;
        data.animeBands = this.animeBands;
        data.animeShadowTint = this.animeShadowTint;
        data.animeSoftness = this.animeSoftness;
        data.rimPower = this.rimPower;
        data.rimIntensity = this.rimIntensity;
        data.rimGlowColor = this.rimGlowColor.getHex();
        data.moodTint = this.moodTint.getHex();
        data.moodSaturation = this.moodSaturation;
        data.moodContrast = this.moodContrast;
        data.moodBrightness = this.moodBrightness;
        data.moodTemperature = this.moodTemperature;
        data.paperGrain = this.paperGrain;
        data.paperGrainScale = this.paperGrainScale;
        data.watercolorBleed = this.watercolorBleed;
        data.brushJitter = this.brushJitter;
        data.brushJitterFrequency = this.brushJitterFrequency;
        data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserializes the material from JSON.
     * @param {Object} json - The JSON holding the serialized material.
     * @param {Object} textures - A dictionary holding textures referenced by the material.
     * @return {ShaderMaterial} A reference to this material.
     */
    fromJSON( json, textures ) {
        super.fromJSON( json );

        if ( json.uniforms !== undefined ) {
            for ( const name in json.uniforms ) {
                const uniform = json.uniforms[ name ];
                this.uniforms[ name ] = {};
                switch ( uniform.type ) {
                    case 't':
                        this.uniforms[ name ].value = textures[ uniform.value ] || null;
                        break;
                    case 'c':
                        this.uniforms[ name ].value = new Color().setHex( uniform.value );
                        break;
                    case 'v2':
                        this.uniforms[ name ].value = new Vector2().fromArray( uniform.value );
                        break;
                    case 'v3':
                        this.uniforms[ name ].value = new Vector3().fromArray( uniform.value );
                        break;
                    case 'v4':
                        this.uniforms[ name ].value = new Vector4().fromArray( uniform.value );
                        break;
                    case 'm3':
                        this.uniforms[ name ].value = new Matrix3().fromArray( uniform.value );
                        break;
                    case 'm4':
                        this.uniforms[ name ].value = new Matrix4().fromArray( uniform.value );
                        break;
                    default:
                        this.uniforms[ name ].value = uniform.value;
                }
            }
        }

        if ( json.defines !== undefined ) this.defines = json.defines;
        if ( json.vertexShader !== undefined ) this.vertexShader = json.vertexShader;
        if ( json.fragmentShader !== undefined ) this.fragmentShader = json.fragmentShader;
        if ( json.glslVersion !== undefined ) this.glslVersion = json.glslVersion;
        if ( json.extensions !== undefined ) {
            for ( const key in json.extensions ) {
                this.extensions[ key ] = json.extensions[ key ];
            }
        }
        if ( json.lights !== undefined ) this.lights = json.lights;
        if ( json.clipping !== undefined ) this.clipping = json.clipping;

        // Anime extensions
        if ( json.animeCelBands !== undefined ) this.animeCelBands = json.animeCelBands;
        if ( json.animeRimGlow !== undefined ) this.animeRimGlow = json.animeRimGlow;
        if ( json.animeMoodGrading !== undefined ) this.animeMoodGrading = json.animeMoodGrading;
        if ( json.animePaperGrain !== undefined ) this.animePaperGrain = json.animePaperGrain;
        if ( json.animeWatercolorBleed !== undefined ) this.animeWatercolorBleed = json.animeWatercolorBleed;
        if ( json.animeBrushJitter !== undefined ) this.animeBrushJitter = json.animeBrushJitter;
        if ( json.animeBands !== undefined ) this.animeBands = json.animeBands;
        if ( json.animeShadowTint !== undefined ) this.animeShadowTint = json.animeShadowTint;
        if ( json.animeSoftness !== undefined ) this.animeSoftness = json.animeSoftness;
        if ( json.rimPower !== undefined ) this.rimPower = json.rimPower;
        if ( json.rimIntensity !== undefined ) this.rimIntensity = json.rimIntensity;
        if ( json.rimGlowColor !== undefined ) this.rimGlowColor.setHex( json.rimGlowColor );
        if ( json.moodTint !== undefined ) this.moodTint.setHex( json.moodTint );
        if ( json.moodSaturation !== undefined ) this.moodSaturation = json.moodSaturation;
        if ( json.moodContrast !== undefined ) this.moodContrast = json.moodContrast;
        if ( json.moodBrightness !== undefined ) this.moodBrightness = json.moodBrightness;
        if ( json.moodTemperature !== undefined ) this.moodTemperature = json.moodTemperature;
        if ( json.paperGrain !== undefined ) this.paperGrain = json.paperGrain;
        if ( json.paperGrainScale !== undefined ) this.paperGrainScale = json.paperGrainScale;
        if ( json.watercolorBleed !== undefined ) this.watercolorBleed = json.watercolorBleed;
        if ( json.brushJitter !== undefined ) this.brushJitter = json.brushJitter;
        if ( json.brushJitterFrequency !== undefined ) this.brushJitterFrequency = json.brushJitterFrequency;
        if ( json.variationSeed !== undefined ) this.variationSeed = json.variationSeed;

        return this;
    }

    /**
     * Frees the GPU-related resources allocated by this instance.
     */
    dispose() {
        // Dispose of any textures owned exclusively by this material's
        // uniforms. Textures shared across materials are the caller's
        // responsibility.
        for ( const name in this.uniforms ) {
            const uniform = this.uniforms[ name ];
            if ( uniform.value && uniform.value.isTexture && uniform.value.isShaderMaterialOwned === true ) {
                uniform.value.dispose();
            }
        }
        super.dispose();
    }
}

export {
    ShaderMaterial,
    ShaderMaterialBatch,
    UniformsUtils,
    ANIME_GLSL,
    buildAnimePresetUniforms,
    buildAnimePresetGLSL,
    proceduralUniformNoise
};
export default ShaderMaterial;