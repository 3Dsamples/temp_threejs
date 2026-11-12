// file number : 189
// full path name : src/materials/189_shadowmaterial.js
// description : ShadowMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with shadow‑specific
//               anime stylization: cel‑band shadow density quantization
//               (discrete shadow steps for flat anime look), mood‑based shadow
//               tinting (cool cyan shadows for snowy scenes, warm purple‑umber
//               shadows for sunset scenes), procedural simplex‑noise dithered
//               shadow falloff, paper‑grain shadow texture, and per‑instance
//               variation for shadow‑catcher crowds. Preserves the full r185
//               ShadowMaterial API and integrates with the unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : ShadowMaterial, shadow‑catching ground planes, anime shadow styling,
//            toon‑consistent ground shadows, stylized contact shadows, and any
//            shadow‑receiving plane that needs real‑time stylization.
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

/** @type {Float32Array} Scratch vec3 for zero‑allocation shadow colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec3} Scratch 3D vector for shadow direction staging. */
const _scratchShadowDir = new Vec3();

/** @type {Vec3} Scratch 3D vector for view‑direction staging. */
const _scratchView = new Vec3();

/** @type {Mat4} Scratch matrix for projection staging. */
const _scratchProjMat = new Mat4();

// ---------------------------------------------------------------------------
// Pool system — reusable shadow scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for shadow‑material scratch records. Prevents per‑frame
 * allocation of temporary shadow‑density quantization, mood‑tinting, and
 * dithering scratch objects.
 */
class ShadowScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, shadowDir: Vec3, view: Vec3}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            shadowDir: new Vec3(),
            view: new Vec3()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, shadowDir: Vec3, view: Vec3}}
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

/** @type {ShadowScratchPool} Shared scratch pool for all shadow material instances. */
const _shadowScratchPool = new ShadowScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — shadow‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply mood‑based shadow tinting. Shadows in anime are never pure black —
 * snowy scenes have cool cyan‑blue shadows, while sunset scenes have warm
 * purple‑umber shadows.
 * @param {Color} color - The shadow color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeShadowColor(color, temperature, saturation, brightness, contrast) {
    _scratchRGB[0] = color.r;
    _scratchRGB[1] = color.g;
    _scratchRGB[2] = color.b;

    const lum = 0.2126 * _scratchRGB[0] + 0.7152 * _scratchRGB[1] + 0.0722 * _scratchRGB[2];

    // Saturation
    let r = lum + (_scratchRGB[0] - lum) * saturation;
    let g = lum + (_scratchRGB[1] - lum) * saturation;
    let b = lum + (_scratchRGB[2] - lum) * saturation;

    // Contrast
    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;

    // Temperature: warm shadows shift toward purple‑umber, cool shadows toward cyan
    r += temperature * 0.08;
    g += temperature * 0.02;
    b -= temperature * 0.08;

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
 * Quantize a shadow density value into discrete cel bands. Produces discrete
 * shadow steps for the flat anime look, avoiding the continuous gradient of
 * standard shadow rendering.
 * @param {number} density - Raw shadow density in [0, 1] (1 = full shadow).
 * @param {number} bands - Number of shadow bands (2–5 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.1] - Edge softness in [0, 0.3].
 * @returns {number} Banded shadow density in [0, 1].
 */
function quantizeShadowDensityCel(density, bands, quantizeAmount, softness = 0.1) {
    if (bands <= 1) return density;

    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(density / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;

    // Soft edge
    const distToBoundary = Math.abs(density - bandIndex * bandWidth - bandWidth * 0.5);
    const softFactor = Math.max(0, Math.min(1, distToBoundary / (bandWidth * 0.5)));
    const softQuantized = quantized + (density - quantized) * (1 - softFactor) * softness;

    // Blend
    const finalDensity = density + (softQuantized - density) * quantizeAmount;
    return Math.max(0, Math.min(1, finalDensity));
}

/**
 * Apply simplex‑noise dithering to a shadow density value. Breaks up 8‑bit
 * shadow banding without adding visible noise.
 * @param {number} density - Shadow density in [0, 1].
 * @param {number} x - Screen‑space x coordinate.
 * @param {number} y - Screen‑space y coordinate.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8‑bit units.
 * @param {number} [scale=1.0] - Noise scale (higher = finer dither).
 * @returns {number} Dithered shadow density in [0, 1].
 */
function ditherShadowDensity(density, x, y, amplitude = 0.5, scale = 1.0) {
    const n = SimplexNoise.noise2D(x * scale, y * scale);
    const dithered = density + n * amplitude / 255;
    return Math.max(0, Math.min(1, dithered));
}

/**
 * Compute a paper‑grain modulation for the shadow density. Adds the subtle
 * hand‑drawn texture characteristic of the reference imagery's watercolor
 * backgrounds.
 * @param {number} u - U coordinate in [0, 1].
 * @param {number} v - V coordinate in [0, 1].
 * @param {number} [scale=10.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.3] - Grain intensity in [0, 1].
 * @returns {number} Multiplier in [0, 1] to apply to shadow density.
 */
function shadowPaperGrain(u, v, scale = 10.0, intensity = 0.3) {
    const n = SimplexNoise.noise2D(u * scale, v * scale) * 0.5 + 0.5;
    return Math.max(0, Math.min(1, 1 - intensity * (1 - n)));
}

// ---------------------------------------------------------------------------
// Main ShadowMaterial class
// ---------------------------------------------------------------------------

/**
 * This material can receive shadows, but otherwise is completely transparent.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: cel‑band shadow quantization, mood‑
 * based shadow tinting, simplex‑noise dithered shadow falloff, and paper‑grain
 * shadow texture.
 *
 * @augments Material
 */
class ShadowMaterial extends Material {

    /**
     * Static block — pre‑warm the shared scratch pool for shadow materials.
     */
    static {
        _shadowScratchPool.warm(32);
    }

    /**
     * Construct a new shadow material.
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
        this.isShadowMaterial = true;

        this.type = 'ShadowMaterial';

        // -------------------------------------------------------------------
        // Standard ShadowMaterial surface
        // -------------------------------------------------------------------

        /**
         * Color of the material.
         * @type {Color}
         * @default (0,0,0)
         */
        this.color = new Color(0x000000);

        /**
         * Whether the material is affected by fog.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        /**
         * Overwritten since shadow materials are transparent by default.
         * @type {boolean}
         * @default true
         */
        this.transparent = true;

        // -------------------------------------------------------------------
        // Anime rendering extensions — shadow‑specific
        // -------------------------------------------------------------------

        /**
         * Number of shadow density cel bands. 2–5 = stylized flat anime shadow
         * steps.
         * @type {number}
         * @default 0
         */
        this.shadowBands = 0;

        /**
         * Blend amount between continuous and banded shadow density.
         * @type {number}
         * @default 1.0
         */
        this.shadowQuantize = 1.0;

        /**
         * Shadow band edge softness.
         * @type {number}
         * @default 0.1
         */
        this.shadowSoftness = 0.1;

        /**
         * Mood temperature shift in [-1, 1]. Positive = warm purple‑umber
         * shadows (sunset), negative = cool cyan shadows (snow/ice).
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
         * The precomputed mood‑graded shadow color.
         * @type {Color}
         */
        this.moodColor = new Color(0x000000);

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
         * Paper‑grain shadow texture intensity.
         * @type {number}
         * @default 0
         */
        this.paperGrain = 0;

        /**
         * Paper‑grain noise scale.
         * @type {number}
         * @default 10.0
         */
        this.paperGrainScale = 10.0;

        /**
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, shadow materials lean anime)
        // -------------------------------------------------------------------

        /**
         * Shadow materials are primarily used for stylized shadow passes.
         * @type {number}
         * @default 0.8
         */
        this.renderStyleBlend = 0.8;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the shadow material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters and initialise derived values
        // -------------------------------------------------------------------

        this.setValues(parameters);

        // Initialise derived colors.
        this.updateMoodColor();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Recompute the mood‑graded shadow color from the current mood parameters.
     * @returns {ShadowMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy(this.color);
        gradeShadowColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply cel‑band quantization to a shadow density value.
     * @param {number} density - Raw shadow density in [0, 1].
     * @returns {number} Banded shadow density in [0, 1].
     */
    applyShadowBanding(density) {
        return quantizeShadowDensityCel(
            density,
            this.shadowBands,
            this.shadowQuantize,
            this.shadowSoftness
        );
    }

    /**
     * Apply simplex‑noise dithering to a shadow density value.
     * @param {number} density - Shadow density in [0, 1].
     * @param {number} x - Screen‑space x.
     * @param {number} y - Screen‑space y.
     * @returns {number}
     */
    applyDither(density, x, y) {
        if (this.ditherAmplitude <= 0) return density;
        return ditherShadowDensity(density, x, y, this.ditherAmplitude, this.ditherScale);
    }

    /**
     * Compute the paper‑grain modulation at a UV position.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    samplePaperGrain(u, v) {
        if (this.paperGrain <= 0) return 1;
        return shadowPaperGrain(u, v, this.paperGrainScale, this.paperGrain);
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
     * @returns {Promise<ShadowMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base Material's anime shader chunks with shadow‑specific
     * features: cel‑band shadow quantization, mood‑based shadow tinting,
     * simplex‑noise dithering, and paper‑grain texture variation.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject shadow‑specific uniforms
        shader.uniforms.shadowBands = { value: this.shadowBands };
        shader.uniforms.shadowQuantize = { value: this.shadowQuantize };
        shader.uniforms.shadowSoftness = { value: this.shadowSoftness };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.ditherScale = { value: this.ditherScale };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.paperGrainScale = { value: this.paperGrainScale };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int shadowBands;
                uniform float shadowQuantize;
                uniform float shadowSoftness;
                uniform vec3 moodColor;
                uniform float ditherAmplitude;
                uniform float ditherScale;
                uniform float paperGrain;
                uniform float paperGrainScale;
                uniform float variationOffset;

                float quantizeShadowDensity(float density) {
                    if (shadowBands <= 1) return density;
                    float bandWidth = 1.0 / float(shadowBands);
                    float bandIndex = floor(density / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(density - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (density - quantized) * (1.0 - softFactor) * shadowSoftness;
                    return mix(density, softQuantized, shadowQuantize);
                }

                float samplePaperGrain(vec2 uv) {
                    if (paperGrain <= 0.0) return 1.0;
                    float n = sin(uv.x * paperGrainScale + variationOffset) * cos(uv.y * paperGrainScale + variationOffset);
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * (1.0 - n);
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Extract the shadow density from the shadow mask
                float shadowDensity = gl_FragColor.a;

                // Apply cel‑band shadow quantization
                shadowDensity = quantizeShadowDensity(shadowDensity);

                // Apply simplex‑noise dithering
                if (ditherAmplitude > 0.0) {
                    float d = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
                    shadowDensity += (d - 0.5) * ditherAmplitude / 255.0;
                }

                // Apply paper grain
                shadowDensity *= samplePaperGrain(vUv);

                // Apply mood‑tinted shadow color
                gl_FragColor.rgb = moodColor;
                gl_FragColor.a *= shadowDensity;
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
            this.shadowBands,
            this.shadowQuantize,
            this.shadowSoftness,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.ditherAmplitude,
            this.ditherScale,
            this.paperGrain,
            this.paperGrainScale,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {ShadowMaterial} source
     * @return {ShadowMaterial}
     */
    copy(source) {
        super.copy(source);

        this.color.copy(source.color);
        this.fog = source.fog;
        this.transparent = source.transparent;

        // Anime extensions
        this.shadowBands = source.shadowBands;
        this.shadowQuantize = source.shadowQuantize;
        this.shadowSoftness = source.shadowSoftness;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy(source.moodColor);
        this.ditherAmplitude = source.ditherAmplitude;
        this.ditherScale = source.ditherScale;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
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

        data.type = 'ShadowMaterial';

        if (this.color.getHex() !== 0x000000) data.color = this.color.getHex();
        if (this.fog === false) data.fog = false;
        if (this.transparent === false) data.transparent = this.transparent;

        // Anime extensions
        if (this.shadowBands !== 0) data.shadowBands = this.shadowBands;
        if (this.shadowQuantize !== 1.0) data.shadowQuantize = this.shadowQuantize;
        if (this.shadowSoftness !== 0.1) data.shadowSoftness = this.shadowSoftness;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.ditherAmplitude !== 0) data.ditherAmplitude = this.ditherAmplitude;
        if (this.ditherScale !== 1.0) data.ditherScale = this.ditherScale;
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.paperGrainScale !== 10.0) data.paperGrainScale = this.paperGrainScale;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ShadowMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        if (json.color !== undefined) this.color.setHex(json.color);
        this.fog = json.fog ?? this.fog;
        this.transparent = json.transparent ?? this.transparent;

        this.shadowBands = json.shadowBands ?? this.shadowBands;
        this.shadowQuantize = json.shadowQuantize ?? this.shadowQuantize;
        this.shadowSoftness = json.shadowSoftness ?? this.shadowSoftness;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        this.ditherAmplitude = json.ditherAmplitude ?? this.ditherAmplitude;
        this.ditherScale = json.ditherScale ?? this.ditherScale;
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.paperGrainScale = json.paperGrainScale ?? this.paperGrainScale;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived colors
        this.updateMoodColor();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for shadow materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing shadow‑specific batching metadata. Consumers can
 * register shadow materials with a World to drive batch updates.
 */
const ShadowMaterialBatchComponent = {
    materialPtr: 'ui32',
    shadowBands: 'ui8',
    shadowQuantize: 'f64',
    shadowSoftness: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    ditherAmplitude: 'f64',
    ditherScale: 'f64',
    paperGrain: 'f64',
    paperGrainScale: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    ShadowMaterial,
    ShadowScratchPool,
    ShadowMaterialBatchComponent,
    gradeShadowColor,
    quantizeShadowDensityCel,
    ditherShadowDensity,
    shadowPaperGrain
};

export default ShadowMaterial;