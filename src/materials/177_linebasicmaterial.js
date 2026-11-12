// file number : 177
// full path name : src/materials/177_linebasicmaterial.js
// description : LineBasicMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with line‑specific
//               anime stylization: hand‑drawn brush jitter for wobbly contours,
//               paper‑grain opacity modulation, mood‑graded line colours,
//               rim glow for neon effects, and cel‑band line‑thickness variation.
//               Preserves the full r185 LineBasicMaterial API and integrates
//               with the unified PBR ↔ Anime blend layer, galactic‑scale
//               configuration hooks, zero‑allocation scratch pools, and
//               ECS‑ready batching metadata introduced in the base class.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : LineBasicMaterial, wireframe overlays, anime‑style outlines,
//            hand‑drawn sketches, glowing neon lines, watercolor contour lines,
//            technical drawing annotations, and any line‑based rendering that
//            needs real‑time anime stylization.
// license : MIT

import { Material } from './176_material.js';
import { Color } from '../math/069_Color.js';
import { ColorManagement } from '../math/068_ColorManagement.js';
import { RENDER } from '../core/002_Constants.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';

// ---------------------------------------------------------------------------
// Global declarations — scratch pools and constants
// ---------------------------------------------------------------------------

/** @type {number} Per‑instance seed increment. */
const SEED_INCREMENT = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation line colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

// ---------------------------------------------------------------------------
// Pool system — reusable line scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for line‑material scratch records. Prevents per‑frame
 * allocation of temporary mood‑grading, endpoint‑jitter, and rim‑glow scratch
 * objects.
 */
class LineScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, p0: Float32Array, p1: Float32Array}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            p0: new Float32Array(3),
            p1: new Float32Array(3)
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, p0: Float32Array, p1: Float32Array}}
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

/** @type {LineScratchPool} Shared scratch pool for all line material instances. */
const _lineScratchPool = new LineScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — line‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply hand‑drawn brush jitter to a line segment's two endpoints using
 * simplex‑noise. The endpoints are modified in place.
 * @param {Float32Array} p0 - First endpoint [x, y, z].
 * @param {Float32Array} p1 - Second endpoint [x, y, z].
 * @param {number} [amplitude=0.02] - Jitter amplitude in world units.
 * @param {number} [frequency=1.0] - Noise frequency along the line.
 * @param {number} [offset=0] - Per‑instance noise offset for decorrelation.
 * @param {number} [seed=0] - Additional per‑segment seed.
 */
function applyBrushJitterToLine(p0, p1, amplitude = 0.02, frequency = 1.0, offset = 0, seed = 0) {
    const nx0 = SimplexNoise.noise2D(offset + seed, 0) * amplitude;
    const ny0 = SimplexNoise.noise2D(offset + seed, 100) * amplitude;
    const nz0 = SimplexNoise.noise2D(offset + seed, 200) * amplitude;
    const nx1 = SimplexNoise.noise2D(offset + seed + frequency, 0) * amplitude;
    const ny1 = SimplexNoise.noise2D(offset + seed + frequency, 100) * amplitude;
    const nz1 = SimplexNoise.noise2D(offset + seed + frequency, 200) * amplitude;
    p0[0] += nx0;
    p0[1] += ny0;
    p0[2] += nz0;
    p1[0] += nx1;
    p1[1] += ny1;
    p1[2] += nz1;
}

/**
 * Generate a paper‑grain multiplier for a given UV position. Used to modulate
 * line opacity so the line appears drawn on textured watercolor paper.
 * @param {number} u - U coordinate (e.g. along the line).
 * @param {number} v - V coordinate (e.g. across the line).
 * @param {number} [scale=8.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.3] - Grain intensity in [0, 1].
 * @param {number} [offset=0] - Per‑material noise offset.
 * @returns {number} Multiplier in [0, 1] to apply to opacity.
 */
function paperGrainMultiplier(u, v, scale = 8.0, intensity = 0.3, offset = 0) {
    const n = SimplexNoise.noise2D(u * scale + offset, v * scale) * 0.5 + 0.5;
    return Math.max(0, Math.min(1, 1 - intensity * (1 - n)));
}

/**
 * Apply mood‑based colour grading specifically tuned for line rendering.
 * Handles warm (sunset orange) and cool (snowy cyan) moods.
 * @param {Color} color - The line colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @returns {Color}
 */
function gradeLineColor(color, temperature, saturation, brightness) {
    _scratchRGBA[0] = color.r;
    _scratchRGBA[1] = color.g;
    _scratchRGBA[2] = color.b;

    // Saturation: push away from luminance
    const lum = 0.2126 * _scratchRGBA[0] + 0.7152 * _scratchRGBA[1] + 0.0722 * _scratchRGBA[2];

    let r = lum + (_scratchRGBA[0] - lum) * saturation;
    let g = lum + (_scratchRGBA[1] - lum) * saturation;
    let b = lum + (_scratchRGBA[2] - lum) * saturation;

    // Temperature: warm shifts toward orange, cool toward cyan
    r += temperature * 0.15;
    b -= temperature * 0.15;

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

// ---------------------------------------------------------------------------
// Main LineBasicMaterial class
// ---------------------------------------------------------------------------

/**
 * A material for rendering line primitives.
 *
 * In addition to the standard three.js parameters, this material exposes
 * a rich set of real‑time anime‑style controls: brush jitter, paper grain,
 * mood‑based line colour grading, rim glow, and cel‑band modulation for
 * stylized line‑thickness variation.
 *
 * @augments Material
 */
class LineBasicMaterial extends Material {

    /**
     * Construct a new line basic material.
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
        this.isLineBasicMaterial = true;

        this.type = 'LineBasicMaterial';

        // -------------------------------------------------------------------
        // Standard LineBasicMaterial surface
        // -------------------------------------------------------------------

        /**
         * Colour of the line. Default is white.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color(0xffffff);

        /**
         * Controls line thickness. Note: WebGL does not support line widths
         * greater than 1 on most platforms.
         * @type {number}
         * @default 1
         */
        this.linewidth = 1;

        /**
         * Defines the appearance of line ends.
         * @type {string}
         * @default 'round'
         */
        this.linecap = 'round';

        /**
         * Defines the appearance of line joints.
         * @type {string}
         * @default 'round'
         */
        this.linejoin = 'round';

        /**
         * Whether the material is affected by fog.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        // -------------------------------------------------------------------
        // Anime rendering extensions — line‑specific
        // -------------------------------------------------------------------

        /**
         * Hand‑drawn brush jitter amplitude in world units.
         * @type {number}
         * @default 0
         */
        this.brushJitter = 0;

        /**
         * Brush jitter noise frequency.
         * @type {number}
         * @default 1.0
         */
        this.brushJitterFrequency = 1.0;

        /**
         * Paper‑grain overlay intensity in [0, 1].
         * @type {number}
         * @default 0
         */
        this.paperGrain = 0;

        /**
         * Paper‑grain noise scale (higher = finer grain).
         * @type {number}
         * @default 8.0
         */
        this.paperGrainScale = 8.0;

        /**
         * Mood temperature shift in [-1, 1] for line colour.
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Mood saturation multiplier for line colour.
         * @type {number}
         * @default 1.0
         */
        this.moodSaturation = 1.0;

        /**
         * Mood brightness multiplier for line colour.
         * @type {number}
         * @default 1.0
         */
        this.moodBrightness = 1.0;

        /**
         * The precomputed mood‑graded line colour.
         * @type {Color}
         */
        this.moodColor = new Color(0xffffff);

        /**
         * Rim‑glow intensity for neon‑line effects.
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Rim‑glow colour. Defaults to a cool cyan tuned for snowy scenes.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color(0.5, 0.9, 1.0);

        /**
         * Number of cel‑shading bands applied to line thickness.
         * 0 = off, 2–4 = classic anime stylized thickness variation.
         * @type {number}
         * @default 0
         */
        this.animeBands = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, but line materials may override)
        // -------------------------------------------------------------------

        /**
         * Line materials are almost always anime‑leaning by default.
         * @type {number}
         * @default 0.7
         */
        this.renderStyleBlend = 0.7;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the line material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters and initialise derived values
        // -------------------------------------------------------------------

        this.setValues(parameters);

        // Initialise mood colour from the current parameters.
        this.updateMoodColor();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Recompute the mood‑graded line colour from the current mood parameters.
     * @returns {LineBasicMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy(this.color);
        gradeLineColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness
        );
        return this;
    }

    /**
     * Apply brush jitter to a pair of line endpoints in world space. The
     * endpoints are modified in place.
     * @param {Float32Array} p0 - First endpoint [x, y, z].
     * @param {Float32Array} p1 - Second endpoint [x, y, z].
     * @param {number} [seed=0] - Per‑segment seed.
     * @returns {LineBasicMaterial} A reference to this instance.
     */
    applyBrushJitterToLine(p0, p1, seed = 0) {
        if (this.brushJitter <= 0) return this;
        applyBrushJitterToLine(
            p0,
            p1,
            this.brushJitter,
            this.brushJitterFrequency,
            this.id,
            seed
        );
        return this;
    }

    /**
     * Compute the paper‑grain opacity multiplier at a given UV.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    samplePaperGrain(u, v) {
        if (this.paperGrain <= 0) return 1;
        return paperGrainMultiplier(u, v, this.paperGrainScale, this.paperGrain, this.id);
    }

    /**
     * Compute the cel‑band thickness multiplier for a given normal·light
     * value. Provides stylized line‑thickness variation.
     * @param {number} ndotl - Dot product of normal and light direction in [0, 1].
     * @returns {number} Multiplier in [0.3, 1.5].
     */
    sampleCelBandThickness(ndotl) {
        if (this.animeBands <= 0) return 1;
        const bands = this.animeBands;
        const band = Math.floor(ndotl * bands) / Math.max(1, bands - 1);
        // Thicker lines in shadow, thinner in highlight
        return 0.5 + 1.0 * (1 - band);
    }

    /**
     * Compute the per‑instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * SEED_INCREMENT;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base Material's anime shader chunks with line‑specific
     * features: brush jitter UV distortion, paper grain opacity modulation,
     * and rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first so base anime uniforms are injected
        super.onBeforeCompile(shader, renderer);

        // Inject line‑specific uniforms
        shader.uniforms.brushJitter = { value: this.brushJitter };
        shader.uniforms.brushJitterFrequency = { value: this.brushJitterFrequency };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.paperGrainScale = { value: this.paperGrainScale };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.moodColor = { value: this.moodColor };

        // Extend the fragment shader with line‑specific anime chunks
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRimIntensity;',
                `uniform float uRimIntensity;
                uniform float brushJitter;
                uniform float brushJitterFrequency;
                uniform float paperGrain;
                uniform float paperGrainScale;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform vec3 moodColor;

                float samplePaperGrain(vec2 uv) {
                    if (paperGrain <= 0.0) return 1.0;
                    float n = sin(uv.x * paperGrainScale) * cos(uv.y * paperGrainScale);
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * (1.0 - n);
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Override with mood‑graded line colour for line materials
                gl_FragColor.rgb = mix(gl_FragColor.rgb, moodColor, 0.85);

                // Apply paper grain opacity modulation
                gl_FragColor.a *= samplePaperGrain(vUv);

                // Rim glow
                if (rimGlow > 0.0) {
                    gl_FragColor.rgb += rimGlowColor * rimGlow;
                }
                `
            );
    }

    /**
     * Custom program cache key. Extends the base key with line‑specific
     * anime state.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.brushJitter,
            this.brushJitterFrequency,
            this.paperGrain,
            this.paperGrainScale,
            this.rimGlow,
            this.animeBands,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {LineBasicMaterial} source
     * @return {LineBasicMaterial}
     */
    copy(source) {
        super.copy(source);

        this.color.copy(source.color);
        this.linewidth = source.linewidth;
        this.linecap = source.linecap;
        this.linejoin = source.linejoin;
        this.fog = source.fog;

        // Anime extensions
        this.brushJitter = source.brushJitter;
        this.brushJitterFrequency = source.brushJitterFrequency;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodColor.copy(source.moodColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.animeBands = source.animeBands;

        return this;
    }

    /**
     * Serialise to JSON.
     * @param {?(Object|string)} meta
     * @return {Object}
     */
    toJSON(meta) {
        const data = super.toJSON(meta);

        data.type = 'LineBasicMaterial';

        if (this.color.getHex() !== 0xffffff) data.color = this.color.getHex();
        if (this.linewidth !== 1) data.linewidth = this.linewidth;
        if (this.linecap !== 'round') data.linecap = this.linecap;
        if (this.linejoin !== 'round') data.linejoin = this.linejoin;
        if (this.fog === false) data.fog = false;

        // Anime extensions
        if (this.brushJitter !== 0) data.brushJitter = this.brushJitter;
        if (this.brushJitterFrequency !== 1.0) data.brushJitterFrequency = this.brushJitterFrequency;
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.paperGrainScale !== 8.0) data.paperGrainScale = this.paperGrainScale;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.rimGlow !== 0) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.5, 0.9, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.animeBands !== 0) data.animeBands = this.animeBands;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {LineBasicMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        if (json.color !== undefined) this.color.setHex(json.color);
        this.linewidth = json.linewidth ?? this.linewidth;
        this.linecap = json.linecap ?? this.linecap;
        this.linejoin = json.linejoin ?? this.linejoin;
        this.fog = json.fog ?? this.fog;

        this.brushJitter = json.brushJitter ?? this.brushJitter;
        this.brushJitterFrequency = json.brushJitterFrequency ?? this.brushJitterFrequency;
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.paperGrainScale = json.paperGrainScale ?? this.paperGrainScale;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        this.animeBands = json.animeBands ?? this.animeBands;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for line materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing line‑specific batching metadata. Consumers can
 * register line materials with a World to drive batch updates.
 */
const LineMaterialBatchComponent = {
    materialPtr: 'ui32',
    brushJitter: 'f64',
    paperGrain: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    rimGlow: 'f64',
    animeBands: 'ui8',
    dirty: 'ui8'
};

export {
    LineBasicMaterial,
    LineScratchPool,
    LineMaterialBatchComponent,
    applyBrushJitterToLine,
    paperGrainMultiplier,
    gradeLineColor
};

export default LineBasicMaterial;