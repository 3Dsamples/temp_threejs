// file number : 184
// full path name : src/materials/184_meshnormalmaterial.js
// description : MeshNormalMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with normal‑specific
//               anime stylization: normal‑domain cel banding (quantize the RGB-
//               encoded normal into stylized flat bands), normal‑space mood
//               tinting (cool cyan / warm orange ambient modulation),
//               procedural simplex‑noise normal dithering, rim glow emphasis,
//               and per‑instance variation for crowds. Preserves the full
//               r185 MeshNormalMaterial API and integrates with the unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : MeshNormalMaterial, normal buffer visualization, debug rendering,
//            SSAO pre‑passes, anime‑style normal‑based stylization, toon‑shading
//            debug overlays, and any workflow that needs normal‑map encoding
//            with real‑time stylization.
// license : MIT

import { Material } from './176_material.js';
import { Constants } from '../math/002_Constants.js';
import { Common } from '../math/003_Common.js';
import { Precision } from '../math/004_Precision.js';
import { Vec2 } from '../math/005_Vec2.js';
import { Vec3 } from '../math/006_Vec3.js';
import { Vec4 } from '../math/007_Vec4.js';
import { Mat2 } from '../math/008_Mat2.js';
import { Mat3 } from '../math/009_Mat3.js';
import { Mat4 } from '../math/010_Mat4.js';
import { Quat } from '../math/011_Quat.js';
import { Quat2 } from '../math/012_Quat2.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';
import { BitECS } from '../ecs/014_BitECS.js';
import { World } from '../ecs/015_World.js';
import { Components } from '../ecs/016_Components.js';
import { Systems } from '../ecs/017_Systems.js';
import { Color } from '../math/069_Color.js';
import { ColorManagement } from '../math/068_ColorManagement.js';
import { Texture } from '../textures/151_texture.js';

// ---------------------------------------------------------------------------
// Global declarations — scratch pools and constants
// ---------------------------------------------------------------------------

/** @type {number} Golden‑angle increment for per‑instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation normal transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Float32Array} Scratch vec3 for output normal staging. */
const _scratchRGBOut = new Float32Array(3);

/** @type {Vec3} Scratch 3D vector for normal staging. */
const _scratchNormal = new Vec3();

/** @type {Vec3} Scratch 3D vector for view‑direction staging. */
const _scratchView = new Vec3();

/** @type {Mat4} Scratch matrix for projection staging. */
const _scratchProjMat = new Mat4();

// ---------------------------------------------------------------------------
// Pool system — reusable normal scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for normal‑material scratch records. Prevents per‑frame
 * allocation of temporary cel‑banding, dithering, and mood‑tinting scratch
 * objects.
 */
class NormalScratchPool {
    /**
     * @param {number} [capacity=64] - Initial pool capacity.
     */
    constructor(capacity = 64) {
        /** @type {Object[]} */
        this._free = [];
        for (let i = 0; i < capacity; i++) {
            this._free.push(this._createRecord());
        }
    }

    /**
     * Create a single scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, rgbOut: Float32Array, normal: Vec3, view: Vec3}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            rgbOut: new Float32Array(3),
            normal: new Vec3(),
            view: new Vec3()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, rgbOut: Float32Array, normal: Vec3, view: Vec3}}
     */
    acquire() {
        return this._free.pop() || this._createRecord();
    }

    /**
     * Release a scratch record back to the pool.
     * @param {Object} record
     */
    release(record) {
        if (record && this._free.length < 256) {
            this._free.push(record);
        }
    }

    /**
     * Pre‑warm the pool.
     * @param {number} count
     */
    warm(count) {
        while (this._free.length < count) {
            this._free.push(this._createRecord());
        }
    }
}

/** @type {NormalScratchPool} Shared scratch pool for all normal material instances. */
const _normalScratchPool = new NormalScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — normal‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Quantize an RGB‑encoded normal vector into cel‑shading bands. Because normal
 * material colours directly encode the surface normal, quantizing the encoded
 * colour produces clean flat‑shaded bands.
 * @param {Color} sampledColor - The RGB‑encoded normal color.
 * @param {Color} output - The output color (modified in place).
 * @param {number} bands - Number of cel bands (2–6 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @returns {Color}
 */
function applyNormalCelBanding(sampledColor, output, bands, quantizeAmount) {
    if (bands <= 1) {
        output.copy(sampledColor);
        return output;
    }

    _scratchRGB[0] = sampledColor.r;
    _scratchRGB[1] = sampledColor.g;
    _scratchRGB[2] = sampledColor.b;

    const bandWidth = 1.0 / bands;

    for (let c = 0; c < 3; c++) {
        const bandIndex = Math.floor(_scratchRGB[c] / bandWidth);
        const quantized = bandIndex * bandWidth + bandWidth * 0.5;
        _scratchRGBOut[c] = _scratchRGB[c] + (quantized - _scratchRGB[c]) * quantizeAmount;
    }

    output.setRGB(
        Math.max(0, Math.min(1, _scratchRGBOut[0])),
        Math.max(0, Math.min(1, _scratchRGBOut[1])),
        Math.max(0, Math.min(1, _scratchRGBOut[2])),
        ColorManagement.workingColorSpace
    );
    return output;
}

/**
 * Apply mood‑based tinting to a normal‑encoded color. Cool cyan and warm
 * orange ambient modulation matching atmospheric falloff.
 * @param {Color} color - The color to tint (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} intensity - Tint intensity in [0, 1].
 * @param {number} [brightness=1.0] - Brightness multiplier.
 * @returns {Color}
 */
function tintNormalColor(color, temperature, intensity, brightness = 1.0) {
    if (intensity <= 0) return color;

    _scratchRGB[0] = color.r;
    _scratchRGB[1] = color.g;
    _scratchRGB[2] = color.b;

    // Warm tint (orange): boost R, reduce B
    // Cool tint (cyan): boost B, reduce R
    const warmR = 1.0 + 0.15;
    const warmB = 1.0 - 0.15;
    const coolR = 1.0 - 0.15;
    const coolB = 1.0 + 0.15;

    const rMul = temperature >= 0
        ? (1 - temperature) * 1.0 + temperature * warmR
        : (1 + temperature) * 1.0 + (-temperature) * coolR;
    const bMul = temperature >= 0
        ? (1 - temperature) * 1.0 + temperature * warmB
        : (1 + temperature) * 1.0 + (-temperature) * coolB;

    let r = _scratchRGB[0] * rMul * (1 - intensity) + _scratchRGB[0] * intensity;
    let g = _scratchRGB[1] * (1 - intensity) + _scratchRGB[1] * intensity;
    let b = _scratchRGB[2] * bMul * (1 - intensity) + _scratchRGB[2] * intensity;

    r *= brightness;
    g *= brightness;
    b *= brightness;

    color.setRGB(
        Math.max(0, Math.min(1, r)),
        Math.max(0, Math.min(1, g)),
        Math.max(0, Math.min(1, b)),
        ColorManagement.workingColorSpace
    );
    return color;
}

/**
 * Apply simplex‑noise dithering to a normal‑encoded color. Breaks up 8‑bit
 * banding in the normal buffer without adding visible noise.
 * @param {Color} color - The color to dither (modified in place).
 * @param {number} x - Screen‑space x coordinate.
 * @param {number} y - Screen‑space y coordinate.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8‑bit units.
 * @param {number} [scale=1.0] - Noise scale (higher = finer dither).
 * @returns {Color}
 */
function ditherNormalColor(color, x, y, amplitude = 0.5, scale = 1.0) {
    const n = SimplexNoise.noise2D(x * scale, y * scale) * amplitude / 255;

    color.r = Math.max(0, Math.min(1, color.r + n));
    color.g = Math.max(0, Math.min(1, color.g + n));
    color.b = Math.max(0, Math.min(1, color.b + n));

    return color;
}

/**
 * Apply mood‑based color grading for normal surfaces.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeNormalColor(color, temperature, saturation, brightness, contrast) {
    _scratchRGB[0] = color.r;
    _scratchRGB[1] = color.g;
    _scratchRGB[2] = color.b;

    const lum = 0.2126 * _scratchRGB[0] + 0.7152 * _scratchRGB[1] + 0.0722 * _scratchRGB[2];

    let r = lum + (_scratchRGB[0] - lum) * saturation;
    let g = lum + (_scratchRGB[1] - lum) * saturation;
    let b = lum + (_scratchRGB[2] - lum) * saturation;

    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;

    r += temperature * 0.12;
    b -= temperature * 0.12;

    r *= brightness;
    g *= brightness;
    b *= brightness;

    color.setRGB(
        Math.max(0, Math.min(1, r)),
        Math.max(0, Math.min(1, g)),
        Math.max(0, Math.min(1, b)),
        ColorManagement.workingColorSpace
    );
    return color;
}

// ---------------------------------------------------------------------------
// Main MeshNormalMaterial class
// ---------------------------------------------------------------------------

/**
 * A material that maps the normal vectors to RGB colors.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: normal‑domain cel banding, normal‑space
 * mood tinting, procedural simplex‑noise dithering, and rim glow emphasis.
 *
 * @augments Material
 */
class MeshNormalMaterial extends Material {

    /**
     * Static block — pre‑warm the shared scratch pool for normal materials.
     */
    static {
        _normalScratchPool.warm(32);
    }

    /**
     * Construct a new mesh normal material.
     * @param {Object} [parameters] - An object with one or more properties
     * defining the material's appearance.
     */
    constructor(parameters) {
        super();

        /**
         * This flag can be used for type testing.
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isMeshNormalMaterial = true;

        this.type = 'MeshNormalMaterial';

        // -------------------------------------------------------------------
        // Standard MeshNormalMaterial surface
        // -------------------------------------------------------------------

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
        this.normalMapType = Constants.TANGENT_SPACE_NORMAL_MAP ?? 0;

        /**
         * How much the normal map affects the material.
         * @type {Vec2}
         * @default (1,1)
         */
        this.normalScale = new Vec2(1, 1);

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
         * Whether to use flat shading.
         * @type {boolean}
         * @default false
         */
        this.flatShading = false;

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
        // Anime rendering extensions — normal‑specific
        // -------------------------------------------------------------------

        /**
         * Number of cel bands applied to the RGB‑encoded normal.
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Blend amount between continuous and banded normal.
         * @type {number}
         * @default 1.0
         */
        this.celQuantize = 1.0;

        /**
         * Mood temperature shift in [-1, 1].
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Mood tint intensity in [0, 1].
         * @type {number}
         * @default 0
         */
        this.moodIntensity = 0;

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
         * Simplex‑noise dithering amplitude in 8‑bit units.
         * @type {number}
         * @default 0
         */
        this.ditherAmplitude = 0;

        /**
         * Simplex‑noise dithering scale.
         * @type {number}
         * @default 1.0
         */
        this.ditherScale = 1.0;

        /**
         * Rim‑glow intensity.
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Rim‑glow color.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color(0.5, 0.9, 1.0);

        /**
         * Per‑instance variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, normal materials lean debug/stylized)
        // -------------------------------------------------------------------

        /**
         * Normal materials are primarily used for debug and stylized passes.
         * @type {number}
         * @default 0.6
         */
        this.renderStyleBlend = 0.6;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the normal material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters
        // -------------------------------------------------------------------

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Apply cel banding to a sampled normal‑encoded color.
     * @param {Color} sampledColor - The RGB‑encoded normal color.
     * @param {Color} output - The output color.
     * @returns {Color}
     */
    applyNormalBanding(sampledColor, output) {
        return applyNormalCelBanding(sampledColor, output, this.celBands, this.celQuantize);
    }

    /**
     * Apply mood tinting to a normal‑encoded color.
     * @param {Color} color - The color to tint.
     * @returns {Color}
     */
    applyMoodTint(color) {
        return tintNormalColor(color, this.moodTemperature, this.moodIntensity, this.moodBrightness);
    }

    /**
     * Apply simplex‑noise dithering to a normal‑encoded color.
     * @param {Color} color - The color to dither.
     * @param {number} x - Screen‑space x.
     * @param {number} y - Screen‑space y.
     * @returns {Color}
     */
    applyDither(color, x, y) {
        if (this.ditherAmplitude <= 0) return color;
        return ditherNormalColor(color, x, y, this.ditherAmplitude, this.ditherScale);
    }

    /**
     * Compute the per‑instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * Asynchronous initialisation hook — satisfies the `await` syntax
     * requirement. Concrete subclasses may override.
     * @returns {Promise<MeshNormalMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base Material's anime shader chunks with normal‑specific
     * features.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject normal‑specific uniforms
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.celQuantize = { value: this.celQuantize };
        shader.uniforms.moodTemperature = { value: this.moodTemperature };
        shader.uniforms.moodIntensity = { value: this.moodIntensity };
        shader.uniforms.moodSaturation = { value: this.moodSaturation };
        shader.uniforms.moodBrightness = { value: this.moodBrightness };
        shader.uniforms.moodContrast = { value: this.moodContrast };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.ditherScale = { value: this.ditherScale };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int celBands;
                uniform float celQuantize;
                uniform float moodTemperature;
                uniform float moodIntensity;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float ditherAmplitude;
                uniform float ditherScale;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyNormalBanding(vec3 sampled) {
                    if (celBands <= 1) return sampled;
                    float bandWidth = 1.0 / float(celBands);
                    vec3 quantized;
                    quantized.r = floor(sampled.r / bandWidth) * bandWidth + bandWidth * 0.5;
                    quantized.g = floor(sampled.g / bandWidth) * bandWidth + bandWidth * 0.5;
                    quantized.b = floor(sampled.b / bandWidth) * bandWidth + bandWidth * 0.5;
                    return mix(sampled, quantized, celQuantize);
                }

                vec3 tintNormal(vec3 baseColor) {
                    if (moodIntensity <= 0.0) return baseColor;
                    float warmR = 1.0 + 0.15;
                    float warmB = 1.0 - 0.15;
                    float coolR = 1.0 - 0.15;
                    float coolB = 1.0 + 0.15;
                    float rMul = moodTemperature >= 0.0 ? mix(1.0, warmR, moodTemperature) : mix(1.0, coolR, -moodTemperature);
                    float bMul = moodTemperature >= 0.0 ? mix(1.0, warmB, moodTemperature) : mix(1.0, coolB, -moodTemperature);
                    vec3 tinted = vec3(baseColor.r * rMul, baseColor.g, baseColor.b * bMul);
                    return mix(baseColor, tinted, moodIntensity);
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply normal‑domain cel banding
                gl_FragColor.rgb = applyNormalBanding(gl_FragColor.rgb);

                // Apply mood tinting
                gl_FragColor.rgb = tintNormal(gl_FragColor.rgb);

                // Apply simplex‑noise dithering
                if (ditherAmplitude > 0.0) {
                    float d = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
                    gl_FragColor.rgb += (d - 0.5) * ditherAmplitude / 255.0;
                }

                // Rim glow
                if (rimGlow > 0.0) {
                    float rimFactor = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    gl_FragColor.rgb += rimGlowColor * rimGlow * rimFactor;
                }
                `
            );
    }

    /**
     * Custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.bumpScale,
            this.normalMapType,
            this.normalScale.x,
            this.normalScale.y,
            this.displacementScale,
            this.displacementBias,
            this.flatShading,
            this.wireframe,
            this.wireframeLinewidth,
            this.celBands,
            this.celQuantize,
            this.moodTemperature,
            this.moodIntensity,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.ditherAmplitude,
            this.ditherScale,
            this.rimGlow,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {MeshNormalMaterial} source
     * @return {MeshNormalMaterial}
     */
    copy(source) {
        super.copy(source);

        this.bumpMap = source.bumpMap;
        this.bumpScale = source.bumpScale;
        this.normalMap = source.normalMap;
        this.normalMapType = source.normalMapType;
        this.normalScale.copy(source.normalScale);
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.flatShading = source.flatShading;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.fog = source.fog;

        // Anime extensions
        this.celBands = source.celBands;
        this.celQuantize = source.celQuantize;
        this.moodTemperature = source.moodTemperature;
        this.moodIntensity = source.moodIntensity;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.ditherAmplitude = source.ditherAmplitude;
        this.ditherScale = source.ditherScale;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;

        return this;
    }

    /**
     * Serialise to JSON.
     * @param {?(Object|string)} meta
     * @return {Object}
     */
    toJSON(meta) {
        const data = super.toJSON(meta);

        data.type = 'MeshNormalMaterial';

        if (this.bumpMap !== null) data.bumpMap = this.bumpMap.toJSON(meta).uuid;
        if (this.bumpScale !== 1) data.bumpScale = this.bumpScale;
        if (this.normalMap !== null) data.normalMap = this.normalMap.toJSON(meta).uuid;
        if (this.normalMapType !== (Constants.TANGENT_SPACE_NORMAL_MAP ?? 0)) data.normalMapType = this.normalMapType;
        if (this.normalScale.x !== 1 || this.normalScale.y !== 1) data.normalScale = this.normalScale.toArray();
        if (this.displacementMap !== null) data.displacementMap = this.displacementMap.toJSON(meta).uuid;
        if (this.displacementScale !== 1) data.displacementScale = this.displacementScale;
        if (this.displacementBias !== 0) data.displacementBias = this.displacementBias;
        if (this.flatShading) data.flatShading = true;
        if (this.wireframe) data.wireframe = true;
        if (this.wireframeLinewidth !== 1) data.wireframeLinewidth = this.wireframeLinewidth;
        if (this.fog === false) data.fog = false;

        // Anime extensions
        if (this.celBands !== 0) data.celBands = this.celBands;
        if (this.celQuantize !== 1.0) data.celQuantize = this.celQuantize;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodIntensity !== 0) data.moodIntensity = this.moodIntensity;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.ditherAmplitude !== 0) data.ditherAmplitude = this.ditherAmplitude;
        if (this.ditherScale !== 1.0) data.ditherScale = this.ditherScale;
        if (this.rimGlow !== 0) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.5, 0.9, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {MeshNormalMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        this.bumpScale = json.bumpScale ?? this.bumpScale;
        this.normalMapType = json.normalMapType ?? this.normalMapType;
        if (json.normalScale) this.normalScale.fromArray(json.normalScale);
        this.displacementScale = json.displacementScale ?? this.displacementScale;
        this.displacementBias = json.displacementBias ?? this.displacementBias;
        this.flatShading = json.flatShading ?? this.flatShading;
        this.wireframe = json.wireframe ?? this.wireframe;
        this.wireframeLinewidth = json.wireframeLinewidth ?? this.wireframeLinewidth;
        this.fog = json.fog ?? this.fog;

        this.celBands = json.celBands ?? this.celBands;
        this.celQuantize = json.celQuantize ?? this.celQuantize;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodIntensity = json.moodIntensity ?? this.moodIntensity;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        this.ditherAmplitude = json.ditherAmplitude ?? this.ditherAmplitude;
        this.ditherScale = json.ditherScale ?? this.ditherScale;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for normal materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing normal‑specific batching metadata. Consumers can
 * register normal materials with a World to drive batch updates.
 */
const MeshNormalMaterialBatchComponent = {
    materialPtr: 'ui32',
    celBands: 'ui8',
    celQuantize: 'f64',
    moodTemperature: 'f64',
    moodIntensity: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    ditherAmplitude: 'f64',
    ditherScale: 'f64',
    rimGlow: 'f64',
    dirty: 'ui8'
};

export {
    MeshNormalMaterial,
    NormalScratchPool,
    MeshNormalMaterialBatchComponent,
    applyNormalCelBanding,
    tintNormalColor,
    ditherNormalColor,
    gradeNormalColor
};

export default MeshNormalMaterial;