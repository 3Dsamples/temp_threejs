// file number : 180
// full path name : src/materials/180_linedashedmaterial.js
// description : LineDashedMaterial rewritten for the temp_threejs engine.
//               Extends the rewritten 177_linebasicmaterial.js with dashed‑line
//               specific anime stylization: organic dash pattern variation for
//               hand‑drawn rhythm, paper‑grain modulation of dash opacity,
//               mood‑based dash color grading, cel‑band‑aware dash density for
//               stylized distance falloff, and rim glow for neon‑dash effects.
//               Preserves the full r185 LineDashedMaterial API and integrates
//               with the unified PBR ↔ Anime blend layer, galactic‑scale
//               configuration hooks, zero‑allocation scratch pools, and
//               ECS‑ready batching metadata. All imports resolve to the
//               internal Threejs_gl repository tree; no CDN dependencies.
// best for : LineDashedMaterial, dashed wireframes, manga speed‑lines, anime
//            storyboard panels, motion trail annotations, hand‑drawn map
//            contours, dashed UI separators, and any dashed‑line rendering that
//            needs real‑time anime stylization.
// license : MIT

import { LineBasicMaterial } from './177_linebasicmaterial.js';
import { Color } from '../math/069_Color.js';
import { ColorManagement } from '../math/068_ColorManagement.js';
import { Vec3 } from '../math/006_Vec3.js';
import { Quat } from '../math/011_Quat.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';

// ---------------------------------------------------------------------------
// Global declarations — scratch pools and constants
// ---------------------------------------------------------------------------

/** @type {number} Golden‑angle increment for per‑instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation dash colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec3} Scratch vector for endpoint staging. */
const _scratchP0 = new Vec3();

/** @type {Vec3} Scratch vector for endpoint staging. */
const _scratchP1 = new Vec3();

/** @type {Quat} Scratch quaternion for rotation staging. */
const _scratchQuat = new Quat();

// ---------------------------------------------------------------------------
// Pool system — reusable dash scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for dashed‑line scratch records. Prevents per‑frame
 * allocation of temporary dash‑pattern, paper‑grain, and mood‑grading scratch
 * objects.
 */
class DashScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, p0: Vec3, p1: Vec3}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            p0: new Vec3(),
            p1: new Vec3()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, p0: Vec3, p1: Vec3}}
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

/** @type {DashScratchPool} Shared scratch pool for all dash material instances. */
const _dashScratchPool = new DashScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — dashed‑line anime helpers
// ---------------------------------------------------------------------------

/**
 * Compute an organically‑varied dash length and gap length at a given position
 * along a dashed line. Uses simplex‑noise so dashes breathe and shift like a
 * hand‑drawn marker line.
 * @param {number} baseDash - Base dash size.
 * @param {number} baseGap - Base gap size.
 * @param {number} t - Position along the line in [0, 1].
 * @param {number} [variation=0.3] - Variation amplitude in [0, 1].
 * @param {number} [frequency=8] - Number of variation cycles along the line.
 * @param {number} [seed=0] - Per‑instance seed for decorrelation.
 * @returns {{dash: number, gap: number}}
 */
function computeOrganicDashGap(baseDash, baseGap, t, variation = 0.3, frequency = 8, seed = 0) {
    const dashNoise = SimplexNoise.noise2D(t * frequency + seed, 0) * 0.5 + 0.5;
    const gapNoise = SimplexNoise.noise2D(t * frequency + seed + 100, 0) * 0.5 + 0.5;

    const dash = Math.max(0.001, (1 + (dashNoise - 0.5) * 2 * variation) * baseDash);
    const gap = Math.max(0.001, (1 + (gapNoise - 0.5) * 2 * variation) * baseGap);
    return { dash, gap };
}

/**
 * Apply mood‑based color grading specifically tuned for dashed lines.
 * @param {Color} color - The line color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeDashColor(color, temperature, saturation, brightness, contrast) {
    _scratchRGBA[0] = color.r;
    _scratchRGBA[1] = color.g;
    _scratchRGBA[2] = color.b;

    const lum = 0.2126 * _scratchRGBA[0] + 0.7152 * _scratchRGBA[1] + 0.0722 * _scratchRGBA[2];

    let r = lum + (_scratchRGBA[0] - lum) * saturation;
    let g = lum + (_scratchRGBA[1] - lum) * saturation;
    let b = lum + (_scratchRGBA[2] - lum) * saturation;

    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;

    r += temperature * 0.14;
    b -= temperature * 0.14;

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
 * Compute a paper‑grain opacity multiplier for a dash segment.
 * @param {number} u - U coordinate along the dash in [0, 1].
 * @param {number} v - V coordinate across the dash in [0, 1].
 * @param {number} [scale=12.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.4] - Grain intensity in [0, 1].
 * @param {number} [seed=0] - Per‑material noise seed.
 * @returns {number} Multiplier in [0, 1] to apply to opacity.
 */
function dashPaperGrainMultiplier(u, v, scale = 12.0, intensity = 0.4, seed = 0) {
    const n = SimplexNoise.noise2D(u * scale + seed, v * scale) * 0.5 + 0.5;
    return Math.max(0, Math.min(1, 1 - intensity * (1 - n)));
}

/**
 * Compute a dash‑density multiplier based on the camera‑space depth of the
 * line. Distant dashes become sparser (classic anime speed‑line falloff),
 * while close dashes become denser.
 * @param {number} depth - Camera‑space depth in [0, 1] (0 = near, 1 = far).
 * @param {number} bands - Number of discrete bands (0 = continuous falloff).
 * @param {number} [densityRange=0.5] - Range of density variation.
 * @returns {number} Density multiplier in [0.5, 1.5].
 */
function sampleCelDashDensity(depth, bands, densityRange = 0.5) {
    let d = depth;
    if (bands > 1) {
        const bandWidth = 1.0 / bands;
        d = Math.floor(depth / bandWidth) * bandWidth;
    }
    // Near = denser, far = sparser
    return 1.0 + densityRange * (0.5 - d);
}

// ---------------------------------------------------------------------------
// Main LineDashedMaterial class
// ---------------------------------------------------------------------------

/**
 * A material for rendering dashed line primitives.
 *
 * In addition to the standard three.js parameters, this material exposes a
 * rich set of real‑time anime‑style controls: organic dash variation, paper‑
 * grain opacity modulation, mood‑based color grading, cel‑band‑aware dash
 * density, and rim glow.
 *
 * Note that dashed lines require line distances computed via
 * `Line.computeLineDistances()` before rendering.
 *
 * @augments LineBasicMaterial
 */
class LineDashedMaterial extends LineBasicMaterial {

    /**
     * Construct a new line dashed material.
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
        this.isLineDashedMaterial = true;

        this.type = 'LineDashedMaterial';

        // -------------------------------------------------------------------
        // Standard LineDashedMaterial surface
        // -------------------------------------------------------------------

        /**
         * The scale of the dashed part of a line.
         * @type {number}
         * @default 1
         */
        this.scale = 1;

        /**
         * The size of the dash.
         * @type {number}
         * @default 3
         */
        this.dashSize = 3;

        /**
         * The size of the gap.
         * @type {number}
         * @default 1
         */
        this.gapSize = 1;

        // -------------------------------------------------------------------
        // Anime rendering extensions — dashed‑line‑specific
        // -------------------------------------------------------------------

        /**
         * Organic dash variation amplitude in [0, 1].
         * 0 = perfectly regular dashes, 1 = highly irregular hand‑drawn dashes.
         * @type {number}
         * @default 0
         */
        this.dashVariation = 0;

        /**
         * Number of variation cycles along the dashed line.
         * @type {number}
         * @default 8
         */
        this.dashFrequency = 8;

        /**
         * Paper‑grain overlay intensity in [0, 1].
         * @type {number}
         * @default 0
         */
        this.paperGrain = 0;

        /**
         * Paper‑grain noise scale.
         * @type {number}
         * @default 12.0
         */
        this.paperGrainScale = 12.0;

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
         * Number of cel‑shading bands applied to dash density variation.
         * 0 = continuous falloff, 2–4 = classic anime banded falloff.
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Rim‑glow intensity for neon‑dash effects.
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Per‑instance seed for decorrelating procedural dash variation.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, dash materials typically lean anime)
        // -------------------------------------------------------------------

        /**
         * Dash materials are primarily used for stylized dashed lines.
         * @type {number}
         * @default 0.8
         */
        this.renderStyleBlend = 0.8;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the dash material participates in galactic‑scale
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
     * Recompute the mood‑graded line color from the current mood parameters.
     * @returns {LineDashedMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy(this.color);
        gradeDashColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Compute the organically‑varied dash and gap sizes at a given position
     * along the dashed line.
     * @param {number} t - Position along the line in [0, 1].
     * @returns {{dash: number, gap: number}}
     */
    sampleOrganicDash(t) {
        if (this.dashVariation <= 0) {
            return { dash: this.dashSize, gap: this.gapSize };
        }
        return computeOrganicDashGap(
            this.dashSize,
            this.gapSize,
            t,
            this.dashVariation,
            this.dashFrequency,
            this.variationSeed
        );
    }

    /**
     * Compute the paper‑grain opacity multiplier for a dash at a given UV.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    sampleDashPaperGrain(u, v) {
        if (this.paperGrain <= 0) return 1;
        return dashPaperGrainMultiplier(u, v, this.paperGrainScale, this.paperGrain, this.variationSeed);
    }

    /**
     * Compute the cel‑band‑aware dash density multiplier at a given depth.
     * @param {number} depth - Camera‑space depth in [0, 1].
     * @returns {number} Density multiplier in [0.5, 1.5].
     */
    sampleDashDensity(depth) {
        return sampleCelDashDensity(depth, this.celBands);
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
     * Extend the base LineBasicMaterial's anime shader chunks with dash‑specific
     * features: organic dash variation, paper‑grain opacity modulation, and
     * cel‑band‑aware density.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base LineBasicMaterial hook first
        super.onBeforeCompile(shader, renderer);

        // Inject dash‑specific uniforms
        shader.uniforms.scale = { value: this.scale };
        shader.uniforms.dashSize = { value: this.dashSize };
        shader.uniforms.gapSize = { value: this.gapSize };
        shader.uniforms.dashVariation = { value: this.dashVariation };
        shader.uniforms.dashFrequency = { value: this.dashFrequency };
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the vertex shader with dash‑distance interpolation
        shader.vertexShader = shader.vertexShader
            .replace(
                '#include <common>',
                `#include <common>
                uniform float scale;
                uniform float dashSize;
                uniform float gapSize;
                uniform float dashVariation;
                uniform float dashFrequency;
                varying float vLineDistance;
                `
            )
            .replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                vLineDistance = scale * lineDistance;
                `
            );

        // Extend the fragment shader with dash computation
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float brushJitter;',
                `uniform float brushJitter;
                uniform float dashSize;
                uniform float gapSize;
                uniform float dashVariation;
                uniform float dashFrequency;
                uniform int celBands;
                uniform float variationOffset;
                varying float vLineDistance;

                // Hash function for discrete dash positioning
                float dashHash(float n) {
                    return fract(sin(n * 43758.5453123) * 12345.6789);
                }

                // Compute the dash mask with organic variation
                float computeDashMask(float distance) {
                    float period = dashSize + gapSize;

                    // Organic variation of the dash boundary
                    if (dashVariation > 0.0) {
                        float variation = sin(distance * dashFrequency * 0.1 + variationOffset) * dashVariation;
                        period *= (1.0 + variation * 0.5);
                    }

                    float t = fract(distance / period);
                    float dashFraction = dashSize / period;
                    return step(t, dashFraction);
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, moodColor, 0.85);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, moodColor, 0.85);

                // Apply paper grain
                gl_FragColor.a *= samplePaperGrain(vUv);

                // Apply dash mask — discard fragments in gaps
                float dashMask = computeDashMask(vLineDistance);
                if (dashMask < 0.5) discard;

                // Rim glow
                if (rimGlow > 0.0) {
                    gl_FragColor.rgb += rimGlowColor * rimGlow;
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
            this.scale,
            this.dashSize,
            this.gapSize,
            this.dashVariation,
            this.dashFrequency,
            this.celBands,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {LineDashedMaterial} source
     * @return {LineDashedMaterial}
     */
    copy(source) {
        super.copy(source);

        this.scale = source.scale;
        this.dashSize = source.dashSize;
        this.gapSize = source.gapSize;

        // Anime extensions
        this.dashVariation = source.dashVariation;
        this.dashFrequency = source.dashFrequency;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy(source.moodColor);
        this.celBands = source.celBands;
        this.rimGlow = source.rimGlow;
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

        data.type = 'LineDashedMaterial';

        if (this.scale !== 1) data.scale = this.scale;
        if (this.dashSize !== 3) data.dashSize = this.dashSize;
        if (this.gapSize !== 1) data.gapSize = this.gapSize;

        // Anime extensions
        if (this.dashVariation !== 0) data.dashVariation = this.dashVariation;
        if (this.dashFrequency !== 8) data.dashFrequency = this.dashFrequency;
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.paperGrainScale !== 12.0) data.paperGrainScale = this.paperGrainScale;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.celBands !== 0) data.celBands = this.celBands;
        if (this.rimGlow !== 0) data.rimGlow = this.rimGlow;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {LineDashedMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        this.scale = json.scale ?? this.scale;
        this.dashSize = json.dashSize ?? this.dashSize;
        this.gapSize = json.gapSize ?? this.gapSize;

        this.dashVariation = json.dashVariation ?? this.dashVariation;
        this.dashFrequency = json.dashFrequency ?? this.dashFrequency;
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.paperGrainScale = json.paperGrainScale ?? this.paperGrainScale;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        this.celBands = json.celBands ?? this.celBands;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived values
        this.updateMoodColor();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for dashed materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing dashed‑line‑specific batching metadata.
 * Consumers can register dashed materials with a World to drive batch updates.
 */
const LineDashedMaterialBatchComponent = {
    materialPtr: 'ui32',
    scale: 'f64',
    dashSize: 'f64',
    gapSize: 'f64',
    dashVariation: 'f64',
    dashFrequency: 'f64',
    paperGrain: 'f64',
    paperGrainScale: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    celBands: 'ui8',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    LineDashedMaterial,
    DashScratchPool,
    LineDashedMaterialBatchComponent,
    computeOrganicDashGap,
    gradeDashColor,
    dashPaperGrainMultiplier,
    sampleCelDashDensity
};

export default LineDashedMaterial;