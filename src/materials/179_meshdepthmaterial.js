// file number : 179
// full path name : src/materials/179_meshdepthmaterial.js
// description : MeshDepthMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with depth‑specific
//               anime stylization: stylized depth banding for toon‑consistent
//               silhouettes, mood‑tinted depth visualization (warm near / cool
//               far), procedural simplex‑noise depth dithering, paper‑grain
//               depth modulation, and rim‑detection emphasis for stylized
//               outlines in depth‑based post‑processing passes. Preserves the
//               full r185 MeshDepthMaterial API and integrates with the unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : MeshDepthMaterial, shadow‑map passes, depth‑of‑field pre‑passes,
//            logarithmic depth buffers, SSAO depth input, anime atmospheric
//            falloff, toon‑consistent silhouettes in depth‑based outlines, and
//            any depth rendering that needs real‑time stylization.
// license : MIT

import { Material } from './176_material.js';
import { Color } from '../math/069_Color.js';
import { ColorManagement } from '../math/068_ColorManagement.js';
import { Vector3 } from '../math/003_Vector3.js';
import { Matrix4 } from '../math/007_Matrix4.js';
import { RENDER } from '../core/002_Constants.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';
import { Texture } from '../textures/002_texture.js';

// ---------------------------------------------------------------------------
// Global declarations — scratch pools and constants
// ---------------------------------------------------------------------------

/** @type {number} Golden‑angle increment for per‑instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation depth colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vector3} Scratch vector for normal staging. */
const _scratchNormal = new Vector3();

/** @type {Vector3} Scratch vector for view‑direction staging. */
const _scratchView = new Vector3();

/** @type {Matrix4} Scratch matrix for depth projection. */
const _scratchMatrix = new Matrix4();

// ---------------------------------------------------------------------------
// Pool system — reusable depth scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for depth‑material scratch records. Prevents per‑frame
 * allocation of temporary banding, dithering, and rim‑detection scratch objects.
 */
class DepthScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Vector3, view: Vector3}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            normal: new Vector3(),
            view: new Vector3()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Vector3, view: Vector3}}
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

/** @type {DepthScratchPool} Shared scratch pool for all depth material instances. */
const _depthScratchPool = new DepthScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — depth‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel‑like banding to a normalized depth value. Produces discrete depth
 * steps that keep anime silhouettes consistent across the scene. Uses native
 * double‑precision arithmetic for bit‑exact band threshold computation.
 * @param {number} depth - Normalized depth in [0, 1] (0 = near, 1 = far).
 * @param {number} bands - Number of discrete depth bands (2–8 recommended).
 * @param {number} [blend=1.0] - Blend between continuous and banded (0–1).
 * @returns {number} Banded depth value in [0, 1].
 */
function applyDepthBanding(depth, bands, blend = 1.0) {
    if (bands <= 1) return depth;

    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(depth / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;
    const finalDepth = depth + (quantized - depth) * blend;
    return Math.max(0, Math.min(1, finalDepth));
}

/**
 * Map a normalized depth value to a mood‑tinted colour. Cool cyan for distant
 * geometry, warm orange for near geometry — matching atmospheric falloff.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} depth - Normalized depth in [0, 1] (0 = near, 1 = far).
 * @param {number} [temperature=0] - Additional warm/cool shift in [-1, 1].
 * @param {number} [saturation=1.0] - Saturation multiplier.
 * @param {number} [brightness=1.0] - Brightness multiplier.
 * @returns {Color}
 */
function depthToMoodColor(output, depth, temperature = 0, saturation = 1.0, brightness = 1.0) {
    // Base gradient: near = warm orange, far = cool cyan
    const t = Math.sin(depth * Math.PI * 0.5);

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
 * Apply simplex‑noise dithering to a depth value. Breaks up 8‑bit depth banding
 * without adding visible noise — the dithering is correlated to screen position
 * so it averages out smoothly under bilinear filtering.
 * @param {number} depth - Normalized depth in [0, 1].
 * @param {number} x - Screen‑space x coordinate.
 * @param {number} y - Screen‑space y coordinate.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8‑bit units.
 * @param {number} [scale=1.0] - Noise scale (higher = finer dither).
 * @returns {number} Dithered depth in [0, 1].
 */
function ditherDepth(depth, x, y, amplitude = 0.5, scale = 1.0) {
    const n = SimplexNoise.noise2D(x * scale, y * scale);
    const dithered = depth + n * amplitude / 255;
    return Math.max(0, Math.min(1, dithered));
}

/**
 * Compute a paper‑grain modulation for the depth value. Adds subtle hand‑drawn
 * texture to the depth visualization.
 * @param {number} u - U coordinate in [0, 1].
 * @param {number} v - V coordinate in [0, 1].
 * @param {number} [scale=10.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.3] - Grain intensity in [0, 1].
 * @returns {number} Multiplier in [0, 1] to apply to depth contrast.
 */
function depthPaperGrain(u, v, scale = 10.0, intensity = 0.3) {
    const n = SimplexNoise.noise2D(u * scale, v * scale) * 0.5 + 0.5;
    return Math.max(0, Math.min(1, 1 - intensity * (1 - n)));
}

/**
 * Compute a rim‑emphasis factor from depth discontinuity. Used to reinforce
 * anime‑style outlines in depth‑based post‑processing passes.
 * @param {number} depthCenter - Depth at the center pixel.
 * @param {number} depthNeighbor - Depth at the neighbor pixel.
 * @param {number} [threshold=0.02] - Depth discontinuity threshold.
 * @param {number} [emphasis=1.0] - Emphasis strength.
 * @returns {number} Rim factor in [0, 1].
 */
function depthRimEmphasis(depthCenter, depthNeighbor, threshold = 0.02, emphasis = 1.0) {
    const delta = Math.abs(depthCenter - depthNeighbor);
    if (delta < threshold) return 0;
    const rim = (delta / threshold - 1) * emphasis;
    return Math.max(0, Math.min(1, rim));
}

// ---------------------------------------------------------------------------
// Main MeshDepthMaterial class
// ---------------------------------------------------------------------------

/**
 * A material for drawing geometry by depth. Depth is based off the camera near
 * and far plane. White is nearest, black is farthest.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: stylized depth banding, mood‑tinted
 * depth visualization, procedural dithering, paper‑grain modulation, and rim‑
 * detection emphasis for stylized outlines.
 *
 * @augments Material
 */
class MeshDepthMaterial extends Material {

    /**
     * Construct a new mesh depth material.
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
        this.isMeshDepthMaterial = true;

        this.type = 'MeshDepthMaterial';

        // -------------------------------------------------------------------
        // Standard MeshDepthMaterial surface
        // -------------------------------------------------------------------

        /**
         * Depth packing type.
         * @type {number}
         * @default BasicDepthPacking
         */
        this.depthPacking = RENDER.DEPTH_PACKING_BASIC ?? 0;

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

        /**
         * Whether to render as wireframe.
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

        // -------------------------------------------------------------------
        // Anime rendering extensions — depth‑specific
        // -------------------------------------------------------------------

        /**
         * Number of discrete depth bands. 1 = continuous (standard depth),
         * 2–8 = cel‑like banding for stylized silhouettes.
         * @type {number}
         * @default 1
         */
        this.depthBands = 1;

        /**
         * Blend amount between continuous and banded depth.
         * @type {number}
         * @default 1.0
         */
        this.depthBandBlend = 1.0;

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
         * The precomputed near‑depth mood colour (depth = 0).
         * @type {Color}
         */
        this.nearColor = new Color(0xffffff);

        /**
         * The precomputed far‑depth mood colour (depth = 1).
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
         * Paper‑grain depth modulation intensity in [0, 1].
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
         * Depth discontinuity threshold for rim detection.
         * @type {number}
         * @default 0.02
         */
        this.rimThreshold = 0.02;

        /**
         * Rim emphasis strength for stylized outlines.
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
        // PBR ↔ Anime blend (inherited, depth materials typically lean anime)
        // -------------------------------------------------------------------

        /**
         * Depth materials are primarily used for stylized passes.
         * @type {number}
         * @default 0.8
         */
        this.renderStyleBlend = 0.8;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the depth material participates in galactic‑scale
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
     * @returns {MeshDepthMaterial} A reference to this instance.
     */
    updateMoodColors() {
        depthToMoodColor(this.nearColor, 0, this.moodTemperature, this.moodSaturation, this.moodBrightness);
        depthToMoodColor(this.farColor, 1, this.moodTemperature, this.moodSaturation, this.moodBrightness);
        return this;
    }

    /**
     * Apply stylized depth banding to a normalized depth value.
     * @param {number} depth - Normalized depth in [0, 1].
     * @returns {number} Banded depth in [0, 1].
     */
    applyBanding(depth) {
        return applyDepthBanding(depth, this.depthBands, this.depthBandBlend);
    }

    /**
     * Apply simplex‑noise dithering to a normalized depth value.
     * @param {number} depth
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    applyDither(depth, x, y) {
        if (this.ditherAmplitude <= 0) return depth;
        return ditherDepth(depth, x, y, this.ditherAmplitude);
    }

    /**
     * Compute the paper‑grain modulation at a UV position.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    samplePaperGrain(u, v) {
        if (this.paperGrain <= 0) return 1;
        return depthPaperGrain(u, v, this.paperGrainScale, this.paperGrain);
    }

    /**
     * Compute the rim‑emphasis factor from a depth discontinuity.
     * @param {number} depthCenter
     * @param {number} depthNeighbor
     * @returns {number} Rim factor in [0, 1].
     */
    sampleRimEmphasis(depthCenter, depthNeighbor) {
        if (this.rimEmphasis <= 0) return 0;
        return depthRimEmphasis(depthCenter, depthNeighbor, this.rimThreshold, this.rimEmphasis);
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
     * Extend the base Material's anime shader chunks with depth‑specific
     * features: depth banding, mood‑tinted gradient, simplex‑noise dithering,
     * and paper grain.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject depth‑specific uniforms
        shader.uniforms.depthBands = { value: this.depthBands };
        shader.uniforms.depthBandBlend = { value: this.depthBandBlend };
        shader.uniforms.nearColor = { value: this.nearColor };
        shader.uniforms.farColor = { value: this.farColor };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.paperGrainScale = { value: this.paperGrainScale };
        shader.uniforms.rimEmphasis = { value: this.rimEmphasis };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader with depth‑specific chunks
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int depthBands;
                uniform float depthBandBlend;
                uniform vec3 nearColor;
                uniform vec3 farColor;
                uniform float ditherAmplitude;
                uniform float paperGrain;
                uniform float paperGrainScale;
                uniform float rimEmphasis;
                uniform float variationOffset;

                float applyDepthBanding(float depth) {
                    if (depthBands <= 1) return depth;
                    float bandWidth = 1.0 / float(depthBands);
                    float quantized = floor(depth / bandWidth) * bandWidth + bandWidth * 0.5;
                    return mix(depth, quantized, depthBandBlend);
                }

                float depthPaperGrain(vec2 uv) {
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

                // Extract depth from the base material's output
                float baseDepth = gl_FragColor.r;

                // Apply stylized depth banding
                float bandedDepth = applyDepthBanding(baseDepth);

                // Map depth to mood‑tinted color
                vec3 depthColor = mix(nearColor, farColor, bandedDepth);

                // Apply simplex‑noise dithering (approximated in shader with hash)
                if (ditherAmplitude > 0.0) {
                    float d = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
                    depthColor += (d - 0.5) * ditherAmplitude / 255.0;
                }

                // Apply paper grain
                depthColor *= depthPaperGrain(vUv);

                gl_FragColor.rgb = depthColor;
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
            this.depthPacking,
            this.depthBands,
            this.depthBandBlend,
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
     * @param {MeshDepthMaterial} source
     * @return {MeshDepthMaterial}
     */
    copy(source) {
        super.copy(source);

        this.depthPacking = source.depthPacking;
        this.map = source.map;
        this.alphaMap = source.alphaMap;
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;

        // Anime extensions
        this.depthBands = source.depthBands;
        this.depthBandBlend = source.depthBandBlend;
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

        data.type = 'MeshDepthMaterial';

        if (this.depthPacking !== (RENDER.DEPTH_PACKING_BASIC ?? 0)) data.depthPacking = this.depthPacking;
        if (this.map !== null) data.map = this.map.toJSON(meta).uuid;
        if (this.alphaMap !== null) data.alphaMap = this.alphaMap.toJSON(meta).uuid;
        if (this.displacementMap !== null) data.displacementMap = this.displacementMap.toJSON(meta).uuid;
        if (this.displacementScale !== 1) data.displacementScale = this.displacementScale;
        if (this.displacementBias !== 0) data.displacementBias = this.displacementBias;
        if (this.wireframe !== false) data.wireframe = this.wireframe;
        if (this.wireframeLinewidth !== 1) data.wireframeLinewidth = this.wireframeLinewidth;

        // Anime extensions
        if (this.depthBands !== 1) data.depthBands = this.depthBands;
        if (this.depthBandBlend !== 1.0) data.depthBandBlend = this.depthBandBlend;
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
     * @returns {MeshDepthMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        this.depthPacking = json.depthPacking ?? this.depthPacking;
        this.displacementScale = json.displacementScale ?? this.displacementScale;
        this.displacementBias = json.displacementBias ?? this.displacementBias;
        this.wireframe = json.wireframe ?? this.wireframe;
        this.wireframeLinewidth = json.wireframeLinewidth ?? this.wireframeLinewidth;

        this.depthBands = json.depthBands ?? this.depthBands;
        this.depthBandBlend = json.depthBandBlend ?? this.depthBandBlend;
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
// ECS‑ready batching metadata for depth materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing depth‑specific batching metadata. Consumers can
 * register depth materials with a World to drive batch updates.
 */
const MeshDepthMaterialBatchComponent = {
    materialPtr: 'ui32',
    depthBands: 'ui8',
    depthBandBlend: 'f64',
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
    MeshDepthMaterial,
    DepthScratchPool,
    MeshDepthMaterialBatchComponent,
    applyDepthBanding,
    depthToMoodColor,
    ditherDepth,
    depthPaperGrain,
    depthRimEmphasis
};

export default MeshDepthMaterial;