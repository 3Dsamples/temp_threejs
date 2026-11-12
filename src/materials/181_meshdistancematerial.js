// file number : 181
// full path name : src/materials/181_meshdistancematerial.js
// description : MeshDistanceMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with distance‑based
//               anime stylization: stylized distance banding for toon‑consistent
//               point‑light shadows, mood‑tinted distance falloff (warm near /
//               cool far), procedural simplex‑noise distance dithering, paper‑
//               grain distance modulation, and rim‑detection emphasis for
//               stylized shadow contours. Preserves the full r185
//               MeshDistanceMaterial API and integrates with the unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : MeshDistanceMaterial, PointLight shadow maps, RectAreaLight shadow
//            maps, Object3D.customDistanceMaterial overrides, anime shadow
//            stylization, toon‑consistent point‑light shadows, hand‑drawn
//            shadow contours, and any distance‑based shadow rendering that
//            needs real‑time stylization.
// license : MIT

import { Material } from './176_material.js';
import { Color } from '../math/069_Color.js';
import { ColorManagement } from '../math/068_ColorManagement.js';
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

/** @type {Float32Array} Scratch vec3 for zero‑allocation distance colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec3} Scratch vector for reference position staging. */
const _scratchRefPos = new Vec3();

/** @type {Mat4} Scratch matrix for depth projection staging. */
const _scratchProjMat = new Mat4();

// ---------------------------------------------------------------------------
// Pool system — reusable distance scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for distance‑material scratch records. Prevents
 * per‑frame allocation of temporary banding, dithering, and rim‑detection
 * scratch objects.
 */
class DistanceScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, refPos: Vec3}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            refPos: new Vec3()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, refPos: Vec3}}
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

/** @type {DistanceScratchPool} Shared scratch pool for all distance material instances. */
const _distanceScratchPool = new DistanceScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — distance‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel‑like banding to a normalized distance value. Produces discrete
 * distance steps that keep anime shadow contours consistent across the scene.
 * @param {number} distance - Normalized distance in [0, 1] (0 = near, 1 = far).
 * @param {number} bands - Number of discrete distance bands (2–8 recommended).
 * @param {number} [blend=1.0] - Blend between continuous and banded (0–1).
 * @returns {number} Banded distance value in [0, 1].
 */
function applyDistanceBanding(distance, bands, blend = 1.0) {
    if (bands <= 1) return distance;

    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(distance / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;
    const finalDistance = distance + (quantized - distance) * blend;
    return Math.max(0, Math.min(1, finalDistance));
}

/**
 * Map a normalized distance value to a mood‑tinted colour. Cool cyan for
 * distant shadow casters, warm orange for near ones — matching atmospheric
 * falloff.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} distance - Normalized distance in [0, 1] (0 = near, 1 = far).
 * @param {number} [temperature=0] - Additional warm/cool shift in [-1, 1].
 * @param {number} [saturation=1.0] - Saturation multiplier.
 * @param {number} [brightness=1.0] - Brightness multiplier.
 * @returns {Color}
 */
function distanceToMoodColor(output, distance, temperature = 0, saturation = 1.0, brightness = 1.0) {
    // Base gradient: near = warm orange, far = cool cyan
    const t = Math.sin(distance * Math.PI * 0.5);

    let r = 1.0 * (1 - t) + 0.35 * t;
    let g = 0.55 * (1 - t) + 0.75 * t;
    let b = 0.25 * (1 - t) + 1.0 * t;

    // Temperature shift
    r += temperature * 0.15;
    b -= temperature * 0.15;

    // Saturation
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = lum + (r - lum) * saturation;
    g = lum + (g - lum) * saturation;
    b = lum + (b - lum) * saturation;

    // Brightness
    r *= brightness;
    g *= brightness;
    b *= brightness;

    output.setRGB(
        Math.max(0, Math.min(1, r)),
        Math.max(0, Math.min(1, g)),
        Math.max(0, Math.min(1, b)),
        ColorManagement.workingColorSpace
    );
    return output;
}

/**
 * Apply simplex‑noise dithering to a distance value. Breaks up 8‑bit distance
 * banding and shadow acne without adding visible noise — the dithering is
 * correlated to screen position so it averages out smoothly under bilinear
 * filtering.
 * @param {number} distance - Normalized distance in [0, 1].
 * @param {number} x - Screen‑space x coordinate.
 * @param {number} y - Screen‑space y coordinate.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8‑bit units.
 * @param {number} [scale=1.0] - Noise scale (higher = finer dither).
 * @returns {number} Dithered distance in [0, 1].
 */
function ditherDistance(distance, x, y, amplitude = 0.5, scale = 1.0) {
    const n = SimplexNoise.noise2D(x * scale, y * scale);
    const dithered = distance + n * amplitude / 255;
    return Math.max(0, Math.min(1, dithered));
}

/**
 * Compute a paper‑grain modulation for the distance value. Adds subtle
 * hand‑drawn texture to the distance visualization.
 * @param {number} u - U coordinate in [0, 1].
 * @param {number} v - V coordinate in [0, 1].
 * @param {number} [scale=10.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.3] - Grain intensity in [0, 1].
 * @returns {number} Multiplier in [0, 1] to apply to distance contrast.
 */
function distancePaperGrain(u, v, scale = 10.0, intensity = 0.3) {
    const n = SimplexNoise.noise2D(u * scale, v * scale) * 0.5 + 0.5;
    return Math.max(0, Math.min(1, 1 - intensity * (1 - n)));
}

/**
 * Compute a rim‑emphasis factor from distance discontinuity. Used to reinforce
 * anime‑style shadow contours in post‑processing.
 * @param {number} distanceCenter - Distance at the center pixel.
 * @param {number} distanceNeighbor - Distance at the neighbor pixel.
 * @param {number} [threshold=0.02] - Distance discontinuity threshold.
 * @param {number} [emphasis=1.0] - Emphasis strength.
 * @returns {number} Rim factor in [0, 1].
 */
function distanceRimEmphasis(distanceCenter, distanceNeighbor, threshold = 0.02, emphasis = 1.0) {
    const delta = Math.abs(distanceCenter - distanceNeighbor);
    if (delta < threshold) return 0;
    const rim = (delta / threshold - 1) * emphasis;
    return Math.max(0, Math.min(1, rim));
}

// ---------------------------------------------------------------------------
// Main MeshDistanceMaterial class
// ---------------------------------------------------------------------------

/**
 * A material used internally for implementing shadow mapping with point lights.
 * Can also be used to customize the shadow casting of an object by assigning an
 * instance of `MeshDistanceMaterial` to `Object3D#customDistanceMaterial`.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: stylized distance banding, mood‑tinted
 * distance visualization, procedural dithering, paper‑grain modulation, and rim‑
 * detection emphasis for stylized shadow contours.
 *
 * @augments Material
 */
class MeshDistanceMaterial extends Material {

    /**
     * Construct a new mesh distance material.
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
        this.isMeshDistanceMaterial = true;

        this.type = 'MeshDistanceMaterial';

        // -------------------------------------------------------------------
        // Standard MeshDistanceMaterial surface
        // -------------------------------------------------------------------

        /**
         * The light's reference position in world space.
         * @type {Vec3}
         * @default (0,0,0)
         */
        this.referencePosition = new Vec3();

        /**
         * The near distance of the internal shadow camera.
         * @type {number}
         * @default 1
         */
        this.nearDistance = 1;

        /**
         * The far distance of the internal shadow camera.
         * @type {number}
         * @default 1000
         */
        this.farDistance = 1000;

        /**
         * The color map.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * Alpha map.
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * Displacement map.
         * @type {?Texture}
         * @default null
         */
        this.displacementMap = null;

        /**
         * Displacement scale.
         * @type {number}
         * @default 1
         */
        this.displacementScale = 1;

        /**
         * Displacement bias.
         * @type {number}
         * @default 0
         */
        this.displacementBias = 0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — distance‑specific
        // -------------------------------------------------------------------

        /**
         * Number of discrete distance bands. 1 = continuous (standard distance),
         * 2–8 = cel‑like banding for stylized shadow contours.
         * @type {number}
         * @default 1
         */
        this.distanceBands = 1;

        /**
         * Blend amount between continuous and banded distance.
         * @type {number}
         * @default 1.0
         */
        this.distanceBandBlend = 1.0;

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
         * The precomputed near‑distance mood colour (distance = 0).
         * @type {Color}
         */
        this.nearColor = new Color(0xffffff);

        /**
         * The precomputed far‑distance mood colour (distance = 1).
         * @type {Color}
         */
        this.farColor = new Color(0x000000);

        /**
         * Simplex‑noise dithering amplitude in 8‑bit units.
         * @type {number}
         * @default 0
         */
        this.ditherAmplitude = 0;

        /**
         * Paper‑grain distance modulation intensity in [0, 1].
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
         * Distance discontinuity threshold for rim detection.
         * @type {number}
         * @default 0.02
         */
        this.rimThreshold = 0.02;

        /**
         * Rim emphasis strength for stylized shadow contours.
         * @type {number}
         * @default 0
         */
        this.rimEmphasis = 0;

        /**
         * Per‑instance variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, distance materials typically lean anime)
        // -------------------------------------------------------------------

        /**
         * Distance materials are primarily used for stylized shadow passes.
         * @type {number}
         * @default 0.8
         */
        this.renderStyleBlend = 0.8;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the distance material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters and initialise derived values
        // -------------------------------------------------------------------

        this.setValues(parameters);

        // Initialise derived colours from the current mood parameters.
        this.updateMoodColors();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Recompute the near/far mood colours from the current mood parameters.
     * @returns {MeshDistanceMaterial} A reference to this instance.
     */
    updateMoodColors() {
        distanceToMoodColor(this.nearColor, 0, this.moodTemperature, this.moodSaturation, this.moodBrightness);
        distanceToMoodColor(this.farColor, 1, this.moodTemperature, this.moodSaturation, this.moodBrightness);
        return this;
    }

    /**
     * Apply stylized distance banding to a normalized distance value.
     * @param {number} distance - Normalized distance in [0, 1].
     * @returns {number} Banded distance in [0, 1].
     */
    applyBanding(distance) {
        return applyDistanceBanding(distance, this.distanceBands, this.distanceBandBlend);
    }

    /**
     * Apply simplex‑noise dithering to a normalized distance value.
     * @param {number} distance
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    applyDither(distance, x, y) {
        if (this.ditherAmplitude <= 0) return distance;
        return ditherDistance(distance, x, y, this.ditherAmplitude);
    }

    /**
     * Compute the paper‑grain modulation at a UV position.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    samplePaperGrain(u, v) {
        if (this.paperGrain <= 0) return 1;
        return distancePaperGrain(u, v, this.paperGrainScale, this.paperGrain);
    }

    /**
     * Compute the rim‑emphasis factor from a distance discontinuity.
     * @param {number} distanceCenter
     * @param {number} distanceNeighbor
     * @returns {number} Rim factor in [0, 1].
     */
    sampleRimEmphasis(distanceCenter, distanceNeighbor) {
        if (this.rimEmphasis <= 0) return 0;
        return distanceRimEmphasis(distanceCenter, distanceNeighbor, this.rimThreshold, this.rimEmphasis);
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
     * Extend the base Material's anime shader chunks with distance‑specific
     * features: distance banding, mood‑tinted gradient, simplex‑noise dithering,
     * and paper grain.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject distance‑specific uniforms
        shader.uniforms.distanceBands = { value: this.distanceBands };
        shader.uniforms.distanceBandBlend = { value: this.distanceBandBlend };
        shader.uniforms.nearColor = { value: this.nearColor };
        shader.uniforms.farColor = { value: this.farColor };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.paperGrainScale = { value: this.paperGrainScale };
        shader.uniforms.rimEmphasis = { value: this.rimEmphasis };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader with distance‑specific chunks
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int distanceBands;
                uniform float distanceBandBlend;
                uniform vec3 nearColor;
                uniform vec3 farColor;
                uniform float ditherAmplitude;
                uniform float paperGrain;
                uniform float paperGrainScale;
                uniform float rimEmphasis;
                uniform float variationOffset;

                float applyDistanceBanding(float distance) {
                    if (distanceBands <= 1) return distance;
                    float bandWidth = 1.0 / float(distanceBands);
                    float quantized = floor(distance / bandWidth) * bandWidth + bandWidth * 0.5;
                    return mix(distance, quantized, distanceBandBlend);
                }

                float distancePaperGrain(vec2 uv) {
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

                // Extract distance from the base material's output
                float baseDistance = gl_FragColor.r;

                // Apply stylized distance banding
                float bandedDistance = applyDistanceBanding(baseDistance);

                // Map distance to mood‑tinted color
                vec3 distanceColor = mix(nearColor, farColor, bandedDistance);

                // Apply simplex‑noise dithering (approximated in shader with hash)
                if (ditherAmplitude > 0.0) {
                    float d = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
                    distanceColor += (d - 0.5) * ditherAmplitude / 255.0;
                }

                // Apply paper grain
                distanceColor *= distancePaperGrain(vUv);

                gl_FragColor.rgb = distanceColor;
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
            this.distanceBands,
            this.distanceBandBlend,
            this.ditherAmplitude,
            this.paperGrain,
            this.paperGrainScale,
            this.rimEmphasis,
            this.rimThreshold,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {MeshDistanceMaterial} source
     * @return {MeshDistanceMaterial}
     */
    copy(source) {
        super.copy(source);

        this.referencePosition.copy(source.referencePosition);
        this.nearDistance = source.nearDistance;
        this.farDistance = source.farDistance;
        this.map = source.map;
        this.alphaMap = source.alphaMap;
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;

        // Anime extensions
        this.distanceBands = source.distanceBands;
        this.distanceBandBlend = source.distanceBandBlend;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.nearColor.copy(source.nearColor);
        this.farColor.copy(source.farColor);
        this.ditherAmplitude = source.ditherAmplitude;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
        this.rimThreshold = source.rimThreshold;
        this.rimEmphasis = source.rimEmphasis;
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

        data.type = 'MeshDistanceMaterial';

        data.referencePosition = this.referencePosition.toArray();
        if (this.nearDistance !== 1) data.nearDistance = this.nearDistance;
        if (this.farDistance !== 1000) data.farDistance = this.farDistance;
        if (this.map !== null) data.map = this.map.toJSON(meta).uuid;
        if (this.alphaMap !== null) data.alphaMap = this.alphaMap.toJSON(meta).uuid;
        if (this.displacementMap !== null) data.displacementMap = this.displacementMap.toJSON(meta).uuid;
        if (this.displacementScale !== 1) data.displacementScale = this.displacementScale;
        if (this.displacementBias !== 0) data.displacementBias = this.displacementBias;

        // Anime extensions
        if (this.distanceBands !== 1) data.distanceBands = this.distanceBands;
        if (this.distanceBandBlend !== 1.0) data.distanceBandBlend = this.distanceBandBlend;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.ditherAmplitude !== 0) data.ditherAmplitude = this.ditherAmplitude;
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.paperGrainScale !== 10.0) data.paperGrainScale = this.paperGrainScale;
        if (this.rimThreshold !== 0.02) data.rimThreshold = this.rimThreshold;
        if (this.rimEmphasis !== 0) data.rimEmphasis = this.rimEmphasis;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {MeshDistanceMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        if (json.referencePosition) this.referencePosition.fromArray(json.referencePosition);
        this.nearDistance = json.nearDistance ?? this.nearDistance;
        this.farDistance = json.farDistance ?? this.farDistance;
        this.displacementScale = json.displacementScale ?? this.displacementScale;
        this.displacementBias = json.displacementBias ?? this.displacementBias;

        this.distanceBands = json.distanceBands ?? this.distanceBands;
        this.distanceBandBlend = json.distanceBandBlend ?? this.distanceBandBlend;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.ditherAmplitude = json.ditherAmplitude ?? this.ditherAmplitude;
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.paperGrainScale = json.paperGrainScale ?? this.paperGrainScale;
        this.rimThreshold = json.rimThreshold ?? this.rimThreshold;
        this.rimEmphasis = json.rimEmphasis ?? this.rimEmphasis;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived colours
        this.updateMoodColors();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for distance materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing distance‑specific batching metadata. Consumers
 * can register distance materials with a World to drive batch updates.
 */
const MeshDistanceMaterialBatchComponent = {
    materialPtr: 'ui32',
    distanceBands: 'ui8',
    distanceBandBlend: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    ditherAmplitude: 'f64',
    paperGrain: 'f64',
    paperGrainScale: 'f64',
    rimThreshold: 'f64',
    rimEmphasis: 'f64',
    dirty: 'ui8'
};

export {
    MeshDistanceMaterial,
    DistanceScratchPool,
    MeshDistanceMaterialBatchComponent,
    applyDistanceBanding,
    distanceToMoodColor,
    ditherDistance,
    distancePaperGrain,
    distanceRimEmphasis
};

export default MeshDistanceMaterial;