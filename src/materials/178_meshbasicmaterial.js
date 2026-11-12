// file number : 178
// full path name : src/materials/178_meshbasicmaterial.js
// description : MeshBasicMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with mesh‑specific
//               anime stylization: flat‑color cel‑like banding for unlit
//               surfaces, procedural paper‑grain and watercolor texture
//               variation, mood‑based color grading, rim glow for character
//               silhouettes, and per‑instance variation for crowds. Preserves
//               the full r185 MeshBasicMaterial API and integrates with the
//               unified PBR ↔ Anime blend layer, galactic‑scale configuration
//               hooks, zero‑allocation scratch pools, and ECS‑ready batching
//               metadata introduced in the base class. All imports resolve to
//               the internal Threejs_gl repository tree; no CDN dependencies.
// best for : MeshBasicMaterial, UI elements, flat‑shaded anime backgrounds,
//            toon character bases, unlit props, skyboxes, loading placeholders,
//            UV debugging, sprite billboards, and any mesh rendering that needs
//            flat‑color anime stylization.
// license : MIT

import { Material } from './176_material.js';
import { Color } from '../math/069_Color.js';
import { ColorManagement } from '../math/068_ColorManagement.js';
import { RENDER } from '../core/002_Constants.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';

// ---------------------------------------------------------------------------
// Global declarations — scratch pools and constants
// ---------------------------------------------------------------------------

/** @type {number} Golden‑angle increment for per‑instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

// ---------------------------------------------------------------------------
// Pool system — reusable mesh scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for mesh‑material scratch records. Prevents per‑frame
 * allocation of temporary flat‑banding, watercolor‑grading, and rim‑glow
 * scratch objects.
 */
class MeshScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Float32Array, view: Float32Array}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            normal: new Float32Array(3),
            view: new Float32Array(3)
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Float32Array, view: Float32Array}}
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

/** @type {MeshScratchPool} Shared scratch pool for all mesh material instances. */
const _meshScratchPool = new MeshScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — mesh‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply flat‑color banding to a base colour, mimicking cel‑shading without any
 * light dependence. The band boundaries are computed with native double‑
 * precision arithmetic for bit‑exact thresholding.
 * @param {Color} baseColor - The base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of flat color bands (2–4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @returns {Color}
 */
function applyFlatColorBanding(baseColor, output, bands, quantizeAmount) {
    if (bands <= 1) {
        output.copy(baseColor);
        return output;
    }

    // Compute luminance of the base colour
    const lum = 0.2126 * baseColor.r + 0.7152 * baseColor.g + 0.0722 * baseColor.b;

    // Quantize luminance into discrete bands
    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(lum / bandWidth);
    const quantizedLum = bandIndex * bandWidth + bandWidth * 0.5;

    // Blend between continuous and quantized luminance
    const finalLum = lum + (quantizedLum - lum) * quantizeAmount;

    // Preserve hue and saturation, only change luminance
    if (lum > 0.0001) {
        output.r = baseColor.r * (finalLum / lum);
        output.g = baseColor.g * (finalLum / lum);
        output.b = baseColor.b * (finalLum / lum);
    } else {
        output.copy(baseColor);
    }

    output.a = baseColor.a;

    // Clamp
    output.r = Math.max(0, Math.min(1, output.r));
    output.g = Math.max(0, Math.min(1, output.g));
    output.b = Math.max(0, Math.min(1, output.b));
    return output;
}

/**
 * Apply mood‑based color grading tuned for unlit mesh rendering. Handles warm
 * (sunset orange), cool (snowy cyan), and vibrant (flora) moods.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeMeshColor(color, temperature, saturation, brightness, contrast) {
    _scratchRGB[0] = color.r;
    _scratchRGB[1] = color.g;
    _scratchRGB[2] = color.b;

    // Saturation: push away from luminance
    const lum = 0.2126 * _scratchRGB[0] + 0.7152 * _scratchRGB[1] + 0.0722 * _scratchRGB[2];

    let r = lum + (_scratchRGB[0] - lum) * saturation;
    let g = lum + (_scratchRGB[1] - lum) * saturation;
    let b = lum + (_scratchRGB[2] - lum) * saturation;

    // Contrast
    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;

    // Temperature
    r += temperature * 0.12;
    b -= temperature * 0.12;

    // Brightness
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
 * Generate a watercolor‑pigment variation texture using simplex‑noise. Creates
 * the subtle blotchy texture characteristic of watercolor backgrounds.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03] - Base noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [bleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateWatercolorTexture(width, height, scale = 0.03, octaves = 3, bleed = 0.5) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            let value = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                value += SimplexNoise.noise2D(x * frequency, y * frequency) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            value = (value / maxAmplitude) * 0.5 + 0.5;

            // Watercolor bleed: soften the value toward the extremes
            value = (value - 0.5) * (1.0 + bleed) + 0.5;
            value = Math.max(0, Math.min(1, value));

            const v = Math.floor(value * 255);
            out[p] = v;
            out[p + 1] = v;
            out[p + 2] = v;
            out[p + 3] = 255;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Main MeshBasicMaterial class
// ---------------------------------------------------------------------------

/**
 * A material for drawing geometries in a simple shaded (flat or wireframe)
 * way. This material is not affected by lights.
 *
 * In addition to the standard three.js parameters, this material exposes
 * a rich set of real‑time anime‑style controls: flat‑color cel‑like banding,
 * procedural watercolor texture variation, mood‑based color grading, rim
 * glow, and per‑instance variation for large crowds.
 *
 * @augments Material
 */
class MeshBasicMaterial extends Material {

    /**
     * Construct a new mesh basic material.
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
        this.isMeshBasicMaterial = true;

        this.type = 'MeshBasicMaterial';

        // -------------------------------------------------------------------
        // Standard MeshBasicMaterial surface
        // -------------------------------------------------------------------

        /**
         * Color of the material.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color(0xffffff);

        /**
         * The color map. May optionally include an alpha channel.
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
         * The ambient occlusion map.
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
         * Specular map.
         * @type {?Texture}
         * @default null
         */
        this.specularMap = null;

        /**
         * Alpha map.
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * Environment map.
         * @type {?Texture}
         * @default null
         */
        this.envMap = null;

        /**
         * Environment map rotation.
         * @type {?Euler}
         * @default null
         */
        this.envMapRotation = null;

        /**
         * How to combine the environment map with the surface colour.
         * @type {number}
         * @default MultiplyOperation
         */
        this.combine = RENDER.COMBINE_MULTIPLY ?? 0;

        /**
         * How much the environment map affects the surface.
         * @type {number}
         * @default 1
         */
        this.reflectivity = 1;

        /**
         * Index of refraction ratio.
         * @type {number}
         * @default 0.98
         */
        this.refractionRatio = 0.98;

        /**
         * Render as wireframe.
         * @type {boolean}
         * @default false
         */
        this.wireframe = false;

        /**
         * Wireframe line thickness.
         * @type {number}
         * @default 1
         */
        this.wireframeLinewidth = 1;

        /**
         * Wireframe line cap style.
         * @type {string}
         * @default 'round'
         */
        this.wireframeLinecap = 'round';

        /**
         * Wireframe line join style.
         * @type {string}
         * @default 'round'
         */
        this.wireframeLinejoin = 'round';

        /**
         * Whether the material is affected by fog.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        // -------------------------------------------------------------------
        // Anime rendering extensions — mesh‑specific
        // -------------------------------------------------------------------

        /**
         * Number of flat color bands for cel‑like banding.
         * 1 = off, 2–4 = classic anime flat shading.
         * @type {number}
         * @default 3
         */
        this.flatBands = 3;

        /**
         * Blend amount between continuous and banded luminance.
         * 0 = off, 1 = fully quantized.
         * @type {number}
         * @default 0.8
         */
        this.flatQuantize = 0.8;

        /**
         * The precomputed flat‑color result.
         * @type {Color}
         */
        this.flatColor = new Color(0xffffff);

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
         * The precomputed mood‑graded color.
         * @type {Color}
         */
        this.moodColor = new Color(0xffffff);

        /**
         * Rim‑glow intensity for character silhouettes and neon effects.
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
         * Watercolor bleed strength.
         * @type {number}
         * @default 0
         */
        this.watercolorBleed = 0;

        /**
         * Per‑instance variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, but mesh basics may override)
        // -------------------------------------------------------------------

        /**
         * Mesh basics are typically used for unlit anime looks, so default
         * blend leans anime.
         * @type {number}
         * @default 0.6
         */
        this.renderStyleBlend = 0.6;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the mesh material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters and initialise derived values
        // -------------------------------------------------------------------

        this.setValues(parameters);

        // Initialise derived colours from current state.
        this.updateFlatColor();
        this.updateMoodColor();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Recompute the flat‑color result from the current flatBands and
     * flatQuantize values.
     * @returns {MeshBasicMaterial} A reference to this instance.
     */
    updateFlatColor() {
        applyFlatColorBanding(this.color, this.flatColor, this.flatBands, this.flatQuantize);
        return this;
    }

    /**
     * Recompute the mood‑graded color from the current mood parameters.
     * @returns {MeshBasicMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy(this.color);
        gradeMeshColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Generate a procedural watercolor variation texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.03]
     * @param {number} [octaves=3]
     * @returns {Uint8Array}
     */
    generateWatercolorTexture(width, height, scale = 0.03, octaves = 3) {
        return generateWatercolorTexture(width, height, scale, octaves, this.watercolorBleed);
    }

    /**
     * Compute the per‑instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base Material's anime shader chunks with mesh‑specific
     * features: flat‑color banding, watercolor texture variation, and rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject mesh‑specific uniforms
        shader.uniforms.flatBands = { value: this.flatBands };
        shader.uniforms.flatQuantize = { value: this.flatQuantize };
        shader.uniforms.flatColor = { value: this.flatColor };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int flatBands;
                uniform float flatQuantize;
                uniform vec3 flatColor;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float watercolorBleed;
                uniform float variationOffset;

                vec3 applyFlatBanding(vec3 baseColor) {
                    if (flatBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(flatBands);
                    float quantizedLum = floor(lum / bandWidth) * bandWidth + bandWidth * 0.5;
                    float finalLum = mix(lum, quantizedLum, flatQuantize);
                    if (lum > 0.0001) {
                        return baseColor * (finalLum / lum);
                    }
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply flat‑color cel banding for unlit surfaces
                gl_FragColor.rgb = applyFlatBanding(gl_FragColor.rgb);

                // Override with mood‑graded color for unlit materials
                gl_FragColor.rgb = mix(gl_FragColor.rgb, moodColor, 0.7);

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
            this.flatBands,
            this.flatQuantize,
            this.rimGlow,
            this.watercolorBleed,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {MeshBasicMaterial} source
     * @return {MeshBasicMaterial}
     */
    copy(source) {
        super.copy(source);

        this.color.copy(source.color);
        this.map = source.map;
        this.lightMap = source.lightMap;
        this.lightMapIntensity = source.lightMapIntensity;
        this.aoMap = source.aoMap;
        this.aoMapIntensity = source.aoMapIntensity;
        this.specularMap = source.specularMap;
        this.alphaMap = source.alphaMap;
        this.envMap = source.envMap;
        this.envMapRotation = source.envMapRotation;
        this.combine = source.combine;
        this.reflectivity = source.reflectivity;
        this.refractionRatio = source.refractionRatio;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.wireframeLinecap = source.wireframeLinecap;
        this.wireframeLinejoin = source.wireframeLinejoin;
        this.fog = source.fog;

        // Anime extensions
        this.flatBands = source.flatBands;
        this.flatQuantize = source.flatQuantize;
        this.flatColor.copy(source.flatColor);
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy(source.moodColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.watercolorBleed = source.watercolorBleed;
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

        data.type = 'MeshBasicMaterial';

        if (this.color.getHex() !== 0xffffff) data.color = this.color.getHex();
        if (this.lightMap !== null) data.lightMap = this.lightMap.toJSON(meta).uuid;
        if (this.lightMapIntensity !== 1.0) data.lightMapIntensity = this.lightMapIntensity;
        if (this.aoMap !== null) data.aoMap = this.aoMap.toJSON(meta).uuid;
        if (this.aoMapIntensity !== 1.0) data.aoMapIntensity = this.aoMapIntensity;
        if (this.specularMap !== null) data.specularMap = this.specularMap.toJSON(meta).uuid;
        if (this.alphaMap !== null) data.alphaMap = this.alphaMap.toJSON(meta).uuid;
        if (this.envMap !== null) data.envMap = this.envMap.toJSON(meta).uuid;
        if (this.envMapRotation !== null) data.envMapRotation = this.envMapRotation.toArray();
        if (this.combine !== (RENDER.COMBINE_MULTIPLY ?? 0)) data.combine = this.combine;
        if (this.reflectivity !== 1) data.reflectivity = this.reflectivity;
        if (this.refractionRatio !== 0.98) data.refractionRatio = this.refractionRatio;
        if (this.wireframe !== false) data.wireframe = this.wireframe;
        if (this.wireframeLinewidth !== 1) data.wireframeLinewidth = this.wireframeLinewidth;
        if (this.wireframeLinecap !== 'round') data.wireframeLinecap = this.wireframeLinecap;
        if (this.wireframeLinejoin !== 'round') data.wireframeLinejoin = this.wireframeLinejoin;
        if (this.fog === false) data.fog = false;

        // Anime extensions
        if (this.flatBands !== 3) data.flatBands = this.flatBands;
        if (this.flatQuantize !== 0.8) data.flatQuantize = this.flatQuantize;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.rimGlow !== 0) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.5, 0.9, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.watercolorBleed !== 0) data.watercolorBleed = this.watercolorBleed;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {MeshBasicMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        if (json.color !== undefined) this.color.setHex(json.color);
        if (json.lightMapIntensity !== undefined) this.lightMapIntensity = json.lightMapIntensity;
        if (json.aoMapIntensity !== undefined) this.aoMapIntensity = json.aoMapIntensity;
        if (json.combine !== undefined) this.combine = json.combine;
        if (json.reflectivity !== undefined) this.reflectivity = json.reflectivity;
        if (json.refractionRatio !== undefined) this.refractionRatio = json.refractionRatio;
        if (json.wireframe !== undefined) this.wireframe = json.wireframe;
        if (json.wireframeLinewidth !== undefined) this.wireframeLinewidth = json.wireframeLinewidth;
        if (json.wireframeLinecap !== undefined) this.wireframeLinecap = json.wireframeLinecap;
        if (json.wireframeLinejoin !== undefined) this.wireframeLinejoin = json.wireframeLinejoin;
        if (json.fog !== undefined) this.fog = json.fog;

        this.flatBands = json.flatBands ?? this.flatBands;
        this.flatQuantize = json.flatQuantize ?? this.flatQuantize;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        this.watercolorBleed = json.watercolorBleed ?? this.watercolorBleed;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived values
        this.updateFlatColor();
        this.updateMoodColor();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for mesh materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing mesh‑specific batching metadata. Consumers can
 * register mesh materials with a World to drive batch updates.
 */
const MeshBasicMaterialBatchComponent = {
    materialPtr: 'ui32',
    flatBands: 'ui8',
    flatQuantize: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    watercolorBleed: 'f64',
    dirty: 'ui8'
};

export {
    MeshBasicMaterial,
    MeshScratchPool,
    MeshBasicMaterialBatchComponent,
    applyFlatColorBanding,
    gradeMeshColor,
    generateWatercolorTexture
};

export default MeshBasicMaterial;