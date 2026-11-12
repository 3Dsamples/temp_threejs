// file number : 182
// full path name : src/materials/182_meshlambertmaterial.js
// description : MeshLambertMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with Lambert‑specific
//               anime stylization: Lambert‑driven cel banding with configurable
//               softness and shadow tint, ambient sky‑to‑ground gradient tinting,
//               mood‑based color grading, rim glow, and procedural paper‑grain /
//               watercolor texture variation. Preserves the full r185
//               MeshLambertMaterial API and integrates with the unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : MeshLambertMaterial, low‑cost character shading, stylized anime
//            backgrounds, distant foliage, town/village props, mobile anime
//            games, and any lambert‑shaded mesh that needs real‑time anime
//            stylization.
// license : MIT

import { Material } from './176_material.js';
import { Color } from '../math/069_Color.js';
import { ColorManagement } from '../math/068_ColorManagement.js';
import { Vec2 } from '../math/005_Vec2.js';
import { Vec3 } from '../math/006_Vec3.js';
import { Mat4 } from '../math/010_Mat4.js';
import { RENDER, SCALE } from '../core/002_Constants.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';
import { Texture } from '../textures/151_texture.js';

// ---------------------------------------------------------------------------
// Global declarations — scratch pools and constants
// ---------------------------------------------------------------------------

/** @type {number} Golden‑angle increment for per‑instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec3} Scratch vector for world position staging. */
const _scratchWorldPos = new Vec3();

/** @type {Mat4} Scratch matrix for view projection staging. */
const _scratchViewProj = new Mat4();

/** @type {Vec2} Scratch 2D vector for UV staging. */
const _scratchUV = new Vec2();

// ---------------------------------------------------------------------------
// Pool system — reusable Lambert scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for Lambert‑material scratch records. Prevents
 * per‑frame allocation of temporary cel‑banding, gradient‑tinting, and
 * watercolor‑grading scratch objects.
 */
class LambertScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, worldPos: Vec3, uv: Vec2}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            worldPos: new Vec3(),
            uv: new Vec2()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, worldPos: Vec3, uv: Vec2}}
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

/** @type {LambertScratchPool} Shared scratch pool for all Lambert material instances. */
const _lambertScratchPool = new LambertScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — Lambert‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel‑shading banding to a Lambert‑lit colour. Lambert materials already
 * produce low‑frequency gradients, so the banding operation uses a softer
 * transition than a standard toon material — producing the characteristic
 * "soft cel" look of modern anime.
 * @param {Color} baseColor - The Lambert‑lit base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of cel bands (2–4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.1] - Edge softness in [0, 0.5].
 * @param {number} [shadowTint=0.85] - Shadow band brightness multiplier.
 * @returns {Color}
 */
function applyLambertCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.1, shadowTint = 0.85) {
    if (bands <= 1) {
        output.copy(baseColor);
        return output;
    }

    // Luminance
    const lum = 0.2126 * baseColor.r + 0.7152 * baseColor.g + 0.0722 * baseColor.b;

    // Quantize with a soft band transition
    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(lum / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;

    // Soft transition: blend between hard band and a smoothstep near the boundary
    const distToBoundary = Math.abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
    const softFactor = Math.max(0, Math.min(1, distToBoundary / (bandWidth * 0.5)));
    const softQuantized = quantized + (lum - quantized) * (1 - softFactor) * softness;

    // Blend continuous and quantized
    const finalLum = lum + (softQuantized - lum) * quantizeAmount;

    // Apply shadow tint to the lower bands
    const shadowMultiplier = Math.min(1, shadowTint + (1.0 - shadowTint) * (finalLum / Math.max(lum, 0.0001)));

    // Preserve hue, change luminance
    if (lum > 0.0001) {
        output.r = baseColor.r * (finalLum / lum) * shadowMultiplier;
        output.g = baseColor.g * (finalLum / lum) * shadowMultiplier;
        output.b = baseColor.b * (finalLum / lum) * shadowMultiplier;
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
 * Apply a vertical gradient tint to emulate the ambient‑sky‑to‑ground gradient
 * characteristic of anime backgrounds.
 * @param {Color} color - The color to tint (modified in place).
 * @param {number} worldY - The world Y coordinate of the fragment.
 * @param {number} heightRange - Range over which the gradient blends.
 * @param {Color} skyColor - Tint applied at the top.
 * @param {Color} groundColor - Tint applied at the bottom.
 * @param {number} intensity - Blend intensity in [0, 1].
 * @returns {Color}
 */
function applyAmbientGradientTint(color, worldY, heightRange, skyColor, groundColor, intensity) {
    if (intensity <= 0) return color;

    let t = worldY / heightRange + 0.5;
    t = Math.max(0, Math.min(1, t));

    // Blend between ground (t=0) and sky (t=1)
    const tr = groundColor.r + (skyColor.r - groundColor.r) * t;
    const tg = groundColor.g + (skyColor.g - groundColor.g) * t;
    const tb = groundColor.b + (skyColor.b - groundColor.b) * t;

    // Mix tinted color with the base color
    color.r = color.r * (1 - intensity) + tr * color.r * intensity;
    color.g = color.g * (1 - intensity) + tg * color.g * intensity;
    color.b = color.b * (1 - intensity) + tb * color.b * intensity;

    return color;
}

/**
 * Apply mood‑based color grading for Lambert‑lit surfaces.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeLambertColor(color, temperature, saturation, brightness, contrast) {
    _scratchRGB[0] = color.r;
    _scratchRGB[1] = color.g;
    _scratchRGB[2] = color.b;

    // Saturation
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
 * Generate a combined paper‑grain and watercolor texture using simplex‑noise
 * with multiple octaves.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03] - Base noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [paperGrain=0.3] - Paper grain intensity.
 * @param {number} [watercolorBleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateLambertTexture(width, height, scale = 0.03, octaves = 3, paperGrain = 0.3, watercolorBleed = 0.5) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Multi‑octave watercolor base
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

            // Watercolor bleed: soften toward extremes
            value = (value - 0.5) * (1.0 + watercolorBleed) + 0.5;
            value = Math.max(0, Math.min(1, value));

            // Paper grain overlay (fine high‑frequency noise)
            const grain = SimplexNoise.noise2D(x * 0.5, y * 0.5) * 0.5 + 0.5;
            value = value * (1 - paperGrain) + grain * paperGrain;
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
// Main MeshLambertMaterial class
// ---------------------------------------------------------------------------

/**
 * A material for non‑shiny surfaces, without specular highlights. The material
 * uses a non‑physically based Lambertian model for calculating the color of the
 * material.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: Lambert‑driven cel banding with
 * configurable softness, ambient‑anime gradient tinting, mood‑based color
 * grading, rim glow, and procedural paper‑grain / watercolor texture variation.
 *
 * @augments Material
 */
class MeshLambertMaterial extends Material {

    /**
     * Construct a new mesh lambert material.
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
        this.isMeshLambertMaterial = true;

        this.type = 'MeshLambertMaterial';

        // -------------------------------------------------------------------
        // Standard MeshLambertMaterial surface
        // -------------------------------------------------------------------

        /**
         * Color of the material.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color(0xffffff);

        /**
         * The emissive (light) color of the material.
         * @type {Color}
         * @default (0,0,0)
         */
        this.emissive = new Color(0x000000);

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
         * The specular map.
         * @type {?Texture}
         * @default null
         */
        this.specularMap = null;

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
         * @type {?Euler}
         * @default null
         */
        this.envMapRotation = null;

        /**
         * How to combine the environment map with the surface color.
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
         * Whether the material is affected by fog.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        // -------------------------------------------------------------------
        // Anime rendering extensions — Lambert‑specific
        // -------------------------------------------------------------------

        /**
         * Number of cel bands for stylized Lambert shading.
         * 0 = off, 2 = classic hard‑shadow, 3–4 = soft cel.
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Blend amount between continuous Lambert and banded shading.
         * @type {number}
         * @default 1.0
         */
        this.celQuantize = 1.0;

        /**
         * Edge softness of cel bands.
         * 0 = hard edges, 0.3 = very soft.
         * @type {number}
         * @default 0.15
         */
        this.celSoftness = 0.15;

        /**
         * Shadow band brightness multiplier.
         * 0.7 = strong shadow, 0.95 = very soft shadow.
         * @type {number}
         * @default 0.85
         */
        this.shadowTint = 0.85;

        /**
         * The precomputed cel‑banded color.
         * @type {Color}
         */
        this.celColor = new Color(0xffffff);

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
         * Ambient gradient intensity.
         * @type {number}
         * @default 0
         */
        this.ambientGradient = 0;

        /**
         * The sky tint applied at the top of the ambient gradient.
         * @type {Color}
         * @default (0.5, 0.75, 1.0)
         */
        this.skyTint = new Color(0.5, 0.75, 1.0);

        /**
         * The ground tint applied at the bottom of the ambient gradient.
         * @type {Color}
         * @default (1.0, 0.85, 0.7)
         */
        this.groundTint = new Color(1.0, 0.85, 0.7);

        /**
         * Paper‑grain overlay intensity.
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

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, Lambert materials lean semi‑realistic)
        // -------------------------------------------------------------------

        /**
         * Lambert materials are typically semi‑realistic.
         * @type {number}
         * @default 0.4
         */
        this.renderStyleBlend = 0.4;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the Lambert material participates in galactic‑scale
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
        this.updateCelColor();
        this.updateMoodColor();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Recompute the cel‑banded color from the current parameters.
     * @returns {MeshLambertMaterial} A reference to this instance.
     */
    updateCelColor() {
        applyLambertCelBanding(
            this.color,
            this.celColor,
            this.celBands,
            this.celQuantize,
            this.celSoftness,
            this.shadowTint
        );
        return this;
    }

    /**
     * Recompute the mood‑graded color from the current mood parameters.
     * @returns {MeshLambertMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy(this.color);
        gradeLambertColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply the ambient gradient tint to a color at a given world Y.
     * @param {Color} color - The color to tint.
     * @param {number} worldY - World Y coordinate.
     * @param {number} [heightRange=10] - Range over which the gradient blends.
     * @returns {Color}
     */
    applyAmbientGradient(color, worldY, heightRange = 10) {
        return applyAmbientGradientTint(
            color,
            worldY,
            heightRange,
            this.skyTint,
            this.groundTint,
            this.ambientGradient
        );
    }

    /**
     * Generate a procedural paper‑grain / watercolor texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.03]
     * @param {number} [octaves=3]
     * @returns {Uint8Array}
     */
    generateLambertTexture(width, height, scale = 0.03, octaves = 3) {
        return generateLambertTexture(width, height, scale, octaves, this.paperGrain, this.watercolorBleed);
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
     * Extend the base Material's anime shader chunks with Lambert‑specific
     * features.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject Lambert‑specific uniforms
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.celQuantize = { value: this.celQuantize };
        shader.uniforms.celSoftness = { value: this.celSoftness };
        shader.uniforms.shadowTint = { value: this.shadowTint };
        shader.uniforms.celColor = { value: this.celColor };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.ambientGradient = { value: this.ambientGradient };
        shader.uniforms.skyTint = { value: this.skyTint };
        shader.uniforms.groundTint = { value: this.groundTint };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int celBands;
                uniform float celQuantize;
                uniform float celSoftness;
                uniform float shadowTint;
                uniform vec3 celColor;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float ambientGradient;
                uniform vec3 skyTint;
                uniform vec3 groundTint;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float variationOffset;

                vec3 applyLambertCel(vec3 baseColor) {
                    if (celBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(celBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    // Soft edge near the band boundary
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * celSoftness;
                    float finalLum = mix(lum, softQuantized, celQuantize);
                    // Shadow tint multiplier
                    float shadowMul = shadowTint + (1.0 - shadowTint) * (finalLum / max(lum, 0.0001));
                    shadowMul = min(1.0, shadowMul);
                    return baseColor * (finalLum / max(lum, 0.0001)) * shadowMul;
                }

                vec3 applyAmbientGradient(vec3 baseColor, float worldY) {
                    if (ambientGradient <= 0.0) return baseColor;
                    float t = clamp(worldY / 10.0 + 0.5, 0.0, 1.0);
                    vec3 tint = mix(groundTint, skyTint, t);
                    return mix(baseColor, baseColor * tint, ambientGradient);
                }

                float samplePaperGrain(vec2 uv) {
                    if (paperGrain <= 0.0) return 1.0;
                    float n = sin(uv.x * 8.0 + variationOffset) * cos(uv.y * 8.0 + variationOffset);
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * (1.0 - n);
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply Lambert‑driven cel banding
                gl_FragColor.rgb = applyLambertCel(gl_FragColor.rgb);

                // Override with mood‑graded color for Lambert materials
                gl_FragColor.rgb = mix(
                    gl_FragColor.rgb,
                    moodColor * (dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722)) / max(dot(moodColor, vec3(0.2126, 0.7152, 0.0722)), 0.0001)),
                    0.5
                );

                // Ambient gradient tint (using view position as world Y proxy)
                gl_FragColor.rgb = applyAmbientGradient(gl_FragColor.rgb, vViewPosition.z);

                // Paper grain opacity modulation
                gl_FragColor.a *= samplePaperGrain(vUv);

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
            this.celBands,
            this.celQuantize,
            this.celSoftness,
            this.shadowTint,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.rimGlow,
            this.ambientGradient,
            this.paperGrain,
            this.watercolorBleed,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {MeshLambertMaterial} source
     * @return {MeshLambertMaterial}
     */
    copy(source) {
        super.copy(source);

        this.color.copy(source.color);
        this.emissive.copy(source.emissive);
        this.emissiveIntensity = source.emissiveIntensity;
        this.emissiveMap = source.emissiveMap;
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
        this.celBands = source.celBands;
        this.celQuantize = source.celQuantize;
        this.celSoftness = source.celSoftness;
        this.shadowTint = source.shadowTint;
        this.celColor.copy(source.celColor);
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy(source.moodColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.ambientGradient = source.ambientGradient;
        this.skyTint.copy(source.skyTint);
        this.groundTint.copy(source.groundTint);
        this.paperGrain = source.paperGrain;
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

        data.type = 'MeshLambertMaterial';

        if (this.color.getHex() !== 0xffffff) data.color = this.color.getHex();
        if (this.emissive.getHex() !== 0x000000) data.emissive = this.emissive.getHex();
        if (this.emissiveIntensity !== 1.0) data.emissiveIntensity = this.emissiveIntensity;
        if (this.emissiveMap !== null) data.emissiveMap = this.emissiveMap.toJSON(meta).uuid;
        if (this.map !== null) data.map = this.map.toJSON(meta).uuid;
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
        if (this.celBands !== 0) data.celBands = this.celBands;
        if (this.celQuantize !== 1.0) data.celQuantize = this.celQuantize;
        if (this.celSoftness !== 0.15) data.celSoftness = this.celSoftness;
        if (this.shadowTint !== 0.85) data.shadowTint = this.shadowTint;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.rimGlow !== 0) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.5, 0.9, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.ambientGradient !== 0) data.ambientGradient = this.ambientGradient;
        if (this.skyTint.getHex() !== new Color(0.5, 0.75, 1.0).getHex()) {
            data.skyTint = this.skyTint.getHex();
        }
        if (this.groundTint.getHex() !== new Color(1.0, 0.85, 0.7).getHex()) {
            data.groundTint = this.groundTint.getHex();
        }
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.watercolorBleed !== 0) data.watercolorBleed = this.watercolorBleed;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {MeshLambertMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        if (json.color !== undefined) this.color.setHex(json.color);
        if (json.emissive !== undefined) this.emissive.setHex(json.emissive);
        this.emissiveIntensity = json.emissiveIntensity ?? this.emissiveIntensity;
        this.lightMapIntensity = json.lightMapIntensity ?? this.lightMapIntensity;
        this.aoMapIntensity = json.aoMapIntensity ?? this.aoMapIntensity;
        if (json.combine !== undefined) this.combine = json.combine;
        this.reflectivity = json.reflectivity ?? this.reflectivity;
        this.refractionRatio = json.refractionRatio ?? this.refractionRatio;
        this.wireframe = json.wireframe ?? this.wireframe;
        this.wireframeLinewidth = json.wireframeLinewidth ?? this.wireframeLinewidth;
        this.wireframeLinecap = json.wireframeLinecap ?? this.wireframeLinecap;
        this.wireframeLinejoin = json.wireframeLinejoin ?? this.wireframeLinejoin;
        this.fog = json.fog ?? this.fog;

        this.celBands = json.celBands ?? this.celBands;
        this.celQuantize = json.celQuantize ?? this.celQuantize;
        this.celSoftness = json.celSoftness ?? this.celSoftness;
        this.shadowTint = json.shadowTint ?? this.shadowTint;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        this.ambientGradient = json.ambientGradient ?? this.ambientGradient;
        if (json.skyTint !== undefined) this.skyTint.setHex(json.skyTint);
        if (json.groundTint !== undefined) this.groundTint.setHex(json.groundTint);
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.watercolorBleed = json.watercolorBleed ?? this.watercolorBleed;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived values
        this.updateCelColor();
        this.updateMoodColor();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for Lambert materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing Lambert‑specific batching metadata. Consumers can
 * register Lambert materials with a World to drive batch updates.
 */
const MeshLambertMaterialBatchComponent = {
    materialPtr: 'ui32',
    celBands: 'ui8',
    celQuantize: 'f64',
    celSoftness: 'f64',
    shadowTint: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    ambientGradient: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    dirty: 'ui8'
};

export {
    MeshLambertMaterial,
    LambertScratchPool,
    MeshLambertMaterialBatchComponent,
    applyLambertCelBanding,
    applyAmbientGradientTint,
    gradeLambertColor,
    generateLambertTexture
};

export default MeshLambertMaterial;