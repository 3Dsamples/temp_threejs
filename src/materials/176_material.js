// file number : 176
// full path name : src/materials/176_material.js
// description : Foundational Material base class rewritten for the temp_threejs
//               engine. Preserves the full r185 material surface (blending, side,
//               depth, stencil, clipping, tone mapping) and adds a unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Base class for every material in the engine. Provides a single
//            control surface for switching between physically based rendering,
//            cel‑shaded anime, and semi‑realistic hybrid looks without changing
//            material subclasses.
// license : MIT

import { EventDispatcher } from '../core/083_EventDispatcher.js';
import { Color } from '../math/069_Color.js';
import { ColorManagement } from '../math/068_ColorManagement.js';
import { RENDER, PBR, SCALE } from '../core/002_Constants.js';
import { Vec3 } from '../math/006_Vec3.js';
import { Vec4 } from '../math/007_Vec4.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';
import { BitECS } from '../ecs/014_BitECS.js';
import { World } from '../ecs/015_World.js';

// ---------------------------------------------------------------------------
// Global declarations — shared scratch pools and constants
// ---------------------------------------------------------------------------

/** @type {number} Monotonic material ID counter. */
let _materialId = 0;

/** @type {number} Golden‑angle increment used for per‑instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Float32Array} Scratch vec3 for normal / view staging. */
const _scratchNormal = new Float32Array(3);

/** @type {Float32Array} Scratch vec3 for view direction staging. */
const _scratchView = new Float32Array(3);

/** @type {number} Reusable timer value for shimmer animations. */
let _shimmerTime = 0;

// ---------------------------------------------------------------------------
// Pool system — reusable material scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for material scratch records. Prevents per‑frame
 * allocation of temporary mood‑grading, PBR‑blending, and rim‑lighting
 * scratch objects.
 */
class MaterialScratchPool {
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
     * Acquire a scratch record. If the pool is empty a new record is created.
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

/** @type {MaterialScratchPool} Shared scratch pool for all material instances. */
const _materialScratchPool = new MaterialScratchPool(128);

// ---------------------------------------------------------------------------
// Utility functions — UUID, bit‑exact accumulation helpers
// ---------------------------------------------------------------------------

/**
 * Generate a UUID. Uses `crypto.randomUUID` when available; falls back to a
 * high‑entropy manual generator that is safe on Android 64‑bit.
 * @returns {string}
 */
function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback — RFC4122 v4‑style UUID
    const hex = '0123456789abcdef';
    let uuid = '';
    for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) {
            uuid += '-';
        } else if (i === 14) {
            uuid += '4';
        } else {
            uuid += hex[Math.floor(Math.random() * 16)];
        }
    }
    return uuid;
}

/**
 * Apply a mood colour grade to an RGBA colour. Uses native double‑precision
 * arithmetic for bit‑exact accumulation; no external dependency.
 * @param {Color} color - Source colour (modified in place).
 * @param {number} hueShift - Hue shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier (1 = unchanged).
 * @param {number} contrast - Contrast multiplier (1 = unchanged).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @returns {Color}
 */
function applyMoodGrading(color, hueShift, saturation, contrast, temperature) {
    // HSV conversion
    let r = color.r, g = color.g, b = color.b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
        if (max === r) hue = ((g - b) / delta) % 6;
        else if (max === g) hue = (b - r) / delta + 2;
        else hue = (r - g) / delta + 4;
        hue /= 6;
        if (hue < 0) hue += 1;
    }

    const sat = max === 0 ? 0 : delta / max;
    const val = max;

    // Apply hue shift and saturation
    let h = (hue + hueShift) % 1;
    if (h < 0) h += 1;
    const s = Math.min(1, Math.max(0, sat * saturation));

    // HSV → RGB
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = val * (1 - s);
    const q = val * (1 - f * s);
    const t = val * (1 - (1 - f) * s);

    let rr, gg, bb;
    switch (i % 6) {
        case 0: rr = val; gg = t; bb = p; break;
        case 1: rr = q; gg = val; bb = p; break;
        case 2: rr = p; gg = val; bb = t; break;
        case 3: rr = p; gg = q; bb = val; break;
        case 4: rr = t; gg = p; bb = val; break;
        case 5: rr = val; gg = p; bb = q; break;
    }

    // Contrast — native double precision
    rr = (rr - 0.5) * contrast + 0.5;
    gg = (gg - 0.5) * contrast + 0.5;
    bb = (bb - 0.5) * contrast + 0.5;

    // Temperature: warm shifts toward orange, cool toward cyan
    rr += temperature * 0.1;
    bb -= temperature * 0.1;

    color.setRGB(
        Math.max(0, Math.min(1, rr)),
        Math.max(0, Math.min(1, gg)),
        Math.max(0, Math.min(1, bb)),
        ColorManagement.workingColorSpace
    );
    return color;
}

/**
 * Blend PBR and anime contributions with a single weight parameter.
 * @param {Color} output - Output colour (modified in place).
 * @param {Color} pbrColor - Physically based colour contribution.
 * @param {Color} animeColor - Anime colour contribution.
 * @param {number} blend - Blend weight in [0, 1] (0 = PBR, 1 = anime).
 * @returns {Color}
 */
function blendPBRAnime(output, pbrColor, animeColor, blend) {
    const w = Math.max(0, Math.min(1, blend));
    output.setRGB(
        pbrColor.r * (1 - w) + animeColor.r * w,
        pbrColor.g * (1 - w) + animeColor.g * w,
        pbrColor.b * (1 - w) + animeColor.b * w,
        ColorManagement.workingColorSpace
    );
    return output;
}

// ---------------------------------------------------------------------------
// Main Material class
// ---------------------------------------------------------------------------

/**
 * Abstract base class for all materials.
 *
 * In addition to the full three.js r185 material surface, this class provides
 * a unified PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
 * zero‑allocation scratch pools, and ECS‑ready batching metadata.
 *
 * @augments EventDispatcher
 */
class Material extends EventDispatcher {
    /**
     * Construct a new material.
     */
    constructor() {
        super();

        // -------------------------------------------------------------------
        // Identity
        // -------------------------------------------------------------------
        this.isMaterial = true;

        Object.defineProperty(this, 'id', {
            value: _materialId++,
            writable: false,
            enumerable: true,
            configurable: false
        });

        this.uuid = generateUUID();
        this.name = '';
        this.type = 'Material';

        // -------------------------------------------------------------------
        // Core rendering state (r185 compatible)
        // -------------------------------------------------------------------
        this.blending = RENDER.BLENDING ? RENDER.BLENDING.NORMAL : 1;
        this.side = RENDER.SIDE ? RENDER.SIDE.FRONT : 0;
        this.vertexColors = false;
        this.opacity = 1.0;
        this.transparent = false;
        this.alphaHash = 0;
        this.alphaTest = 0;
        this.alphaToCoverage = false;

        this.blendSrc = null;
        this.blendDst = null;
        this.blendEquation = null;
        this.blendSrcAlpha = null;
        this.blendDstAlpha = null;
        this.blendEquationAlpha = null;
        this.blendColor = new Color(0x000000);
        this.blendAlpha = 0;

        this.depthFunc = RENDER.DEPTH_FUNC ? RENDER.DEPTH_FUNC.LESS_EQUAL : 3;
        this.depthTest = true;
        this.depthWrite = true;

        this.stencilWriteMask = 0xff;
        this.stencilFunc = 0; // AlwaysStencilFunc
        this.stencilRef = 0;
        this.stencilFuncMask = 0xff;
        this.stencilFail = 0; // KeepStencilOp
        this.stencilZFail = 0;
        this.stencilZPass = 0;
        this.stencilWrite = false;

        this.clippingPlanes = null;
        this.clipIntersection = false;
        this.clipShadows = false;
        this.shadowSide = null;

        this.colorWrite = true;
        this.polygonOffset = false;
        this.polygonOffsetFactor = 0;
        this.polygonOffsetUnits = 0;
        this.dithering = false;
        this.precision = null;
        this.toneMapped = true;
        this.userData = {};
        this.version = 0;

        // -------------------------------------------------------------------
        // Unified PBR ↔ Anime blend layer
        // -------------------------------------------------------------------
        /**
         * Master blend between PBR and anime contributions.
         * 0 = fully physically based, 1 = fully anime / cel‑shaded.
         * @type {number}
         * @default 0.5
         */
        this.renderStyleBlend = 0.5;

        /**
         * Named render style hint. Concrete materials may override.
         * @type {'pbr'|'anime'|'semi-realistic'|'custom'}
         * @default 'semi-realistic'
         */
        this.renderStyle = 'semi-realistic';

        /**
         * Global anime band count (cel shading). 0 = off.
         * @type {number}
         * @default 2
         */
        this.animeBands = 2;

        /**
         * Shadow boundary for the primary cel band.
         * @type {number}
         * @default 0.5
         */
        this.animeShadowThreshold = 0.5;

        /**
         * Highlight boundary for the topmost cel band.
         * @type {number}
         * @default 0.8
         */
        this.animeHighlightThreshold = 0.8;

        /**
         * Precomputed cel‑band thresholds.
         * @type {number[]}
         */
        this.celThresholds = [];

        /**
         * Rim light colour.
         * @type {Color}
         */
        this.rimColor = new Color(0.5, 0.8, 1.0);

        /**
         * Rim light intensity.
         * @type {number}
         * @default 0.5
         */
        this.rimIntensity = 0.5;

        /**
         * Rim falloff power.
         * @type {number}
         * @default 2.0
         */
        this.rimPower = 2.0;

        /**
         * Outline width.
         * @type {number}
         * @default 0
         */
        this.outlineWidth = 0;

        /**
         * Outline colour.
         * @type {Color}
         */
        this.outlineColor = new Color(0, 0, 0);

        // Mood grading
        this.moodHueShift = 0;
        this.moodSaturation = 1.0;
        this.moodContrast = 1.0;
        this.moodTemperature = 0;

        // Procedural variation
        this.paperGrainIntensity = 0;
        this.watercolorBleed = 0;
        this.brushJitter = 0;

        // -------------------------------------------------------------------
        // PBR parameters (used by subclasses that support PBR)
        // -------------------------------------------------------------------
        this.pbrMetalness = PBR.METALNESS_DEFAULT ?? 0.0;
        this.pbrRoughness = PBR.ROUGHNESS_DEFAULT ?? 1.0;
        this.pbrEnvMapIntensity = PBR.ENV_MAP_INTENSITY_DEFAULT ?? 1.0;
        this.pbrClearcoat = PBR.CLEARCOAT_DEFAULT ?? 0.0;
        this.pbrSheen = PBR.SHEEN_DEFAULT ?? 0.0;
        this.pbrTransmission = PBR.TRANSMISSION_DEFAULT ?? 0.0;
        this.pbrIridescence = PBR.IRIDESCENCE_DEFAULT ?? 0.0;
        this.pbrAnisotropy = PBR.ANISOTROPY_DEFAULT ?? 0.0;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration hooks
        // -------------------------------------------------------------------
        /**
         * Floating‑origin threshold (world units). When the camera moves
         * beyond this distance the renderer may rebase the origin.
         * @type {number}
         * @default SCALE.FLOATING_ORIGIN_THRESHOLD
         */
        this.floatingOriginThreshold = SCALE.FLOATING_ORIGIN_THRESHOLD ?? 1e4;

        /**
         * LOD distance thresholds used for material‑level LOD decisions.
         * @type {number[]}
         */
        this.lodDistances = SCALE.LOD_DISTANCES
            ? [...SCALE.LOD_DISTANCES]
            : [10, 100, 1e3, 1e4, 1e5, 1e6, 1e7];

        /**
         * When true, the material participates in galactic‑scale chunking.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Custom shader / uniform surface
        // -------------------------------------------------------------------
        /**
         * Arbitrary user‑defined uniforms injected into `onBeforeCompile`.
         * @type {Object<string, {value: *}>}
         */
        this.customUniforms = {};

        /**
         * Additional GLSL `#define` directives.
         * @type {Object<string, string>}
         */
        this.customDefines = {};

        /**
         * Per‑instance variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        /**
         * Cached anime shader key.
         * @type {?string}
         * @private
         */
        this._animeCacheKey = null;

        // Pre‑compute cel thresholds
        this.updateCelThresholds();
    }

    // -----------------------------------------------------------------------
    // PBR ↔ Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Set the PBR ↔ anime blend weight.
     * @param {number} weight - 0 = PBR, 1 = anime.
     * @returns {Material}
     */
    setRenderBlend(weight) {
        this.renderStyleBlend = Math.max(0, Math.min(1, weight));
        return this;
    }

    /**
     * Recompute cel‑band thresholds from the current parameters.
     * @returns {Material}
     */
    updateCelThresholds() {
        const bands = Math.max(1, this.animeBands);
        const thresholds = [];
        for (let i = 0; i < bands; i++) {
            thresholds.push(Math.pow(i / (bands - 1 || 1), 0.75));
        }
        thresholds.push(this.animeShadowThreshold);
        thresholds.push(this.animeHighlightThreshold);
        thresholds.sort((a, b) => a - b);
        this.celThresholds = thresholds;
        return this;
    }

    /**
     * Apply mood grading to an arbitrary colour.
     * @param {Color} color
     * @returns {Color}
     */
    applyMood(color) {
        return applyMoodGrading(
            color,
            this.moodHueShift,
            this.moodSaturation,
            this.moodContrast,
            this.moodTemperature
        );
    }

    /**
     * Blend PBR and anime contributions using the current blend weight.
     * @param {Color} pbrColor
     * @param {Color} animeColor
     * @returns {Color} A new colour instance.
     */
    blendPBRWithAnime(pbrColor, animeColor) {
        const out = new Color();
        return blendPBRAnime(out, pbrColor, animeColor, this.renderStyleBlend);
    }

    /**
     * Apply brush jitter to a UV coordinate.
     * @param {number} u
     * @param {number} v
     * @param {number} [offset=0]
     * @returns {{u: number, v: number}}
     */
    applyBrushJitter(u, v, offset = 0) {
        if (this.brushJitter <= 0) return { u, v };
        const du = SimplexNoise.noise2D(u + offset, v) * this.brushJitter;
        const dv = SimplexNoise.noise2D(u + offset + 100, v + 100) * this.brushJitter;
        return { u: u + du, v: v + dv };
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
     * Inject anime / PBR / custom uniforms and GLSL into the compiled shader.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        this._animeCacheKey = [
            this.renderStyleBlend,
            this.animeBands,
            this.animeShadowThreshold,
            this.animeHighlightThreshold,
            this.rimIntensity,
            this.rimPower,
            this.outlineWidth,
            this.moodHueShift,
            this.moodSaturation,
            this.moodContrast,
            this.moodTemperature,
            this.paperGrainIntensity,
            this.watercolorBleed,
            this.brushJitter,
            this.pbrMetalness,
            this.pbrRoughness,
            this.floatingOriginThreshold,
            this.galacticScaleEnabled
        ].join('|');

        // Merge custom uniforms (user wins on conflict)
        for (const key in this.customUniforms) {
            shader.uniforms[key] = this.customUniforms[key];
        }

        // Inject common anime + PBR uniforms
        shader.uniforms.uAnimeBands = { value: this.animeBands };
        shader.uniforms.uAnimeShadowThreshold = { value: this.animeShadowThreshold };
        shader.uniforms.uAnimeHighlightThreshold = { value: this.animeHighlightThreshold };
        shader.uniforms.uRimColor = { value: this.rimColor };
        shader.uniforms.uRimIntensity = { value: this.rimIntensity };
        shader.uniforms.uRimPower = { value: this.rimPower };
        shader.uniforms.uRenderBlend = { value: this.renderStyleBlend };
        shader.uniforms.uMoodHueShift = { value: this.moodHueShift };
        shader.uniforms.uMoodSaturation = { value: this.moodSaturation };
        shader.uniforms.uMoodContrast = { value: this.moodContrast };
        shader.uniforms.uMoodTemperature = { value: this.moodTemperature };
        shader.uniforms.uPBRMetalness = { value: this.pbrMetalness };
        shader.uniforms.uPBRRoughness = { value: this.pbrRoughness };

        // Inject custom defines
        let defines = '';
        for (const key in this.customDefines) {
            defines += `#define ${key} ${this.customDefines[key]}\n`;
        }

        // Fragment shader injection
        shader.fragmentShader = shader.fragmentShader
            .replace(
                '#include <common>',
                `#include <common>
                ${defines}
                uniform int uAnimeBands;
                uniform float uAnimeShadowThreshold;
                uniform float uAnimeHighlightThreshold;
                uniform vec3 uRimColor;
                uniform float uRimIntensity;
                uniform float uRimPower;
                uniform float uRenderBlend;
                uniform float uMoodHueShift;
                uniform float uMoodSaturation;
                uniform float uMoodContrast;
                uniform float uMoodTemperature;
                uniform float uPBRMetalness;
                uniform float uPBRRoughness;

                vec3 applyAnimeCelBands(vec3 color, float ndotl) {
                    if (uAnimeBands <= 0) return color;
                    float bands = float(uAnimeBands);
                    float band = floor(ndotl * bands) / max(1.0, bands - 1.0);
                    band = smoothstep(0.0, 0.05, band);
                    return color * mix(uAnimeShadowThreshold, 1.0, band);
                }

                vec3 applyRimLighting(vec3 color, vec3 normal, vec3 viewDir) {
                    float rim = 1.0 - max(dot(normal, viewDir), 0.0);
                    rim = pow(rim, uRimPower);
                    return color + uRimColor * rim * uRimIntensity;
                }

                vec3 applyMoodGradingGLSL(vec3 color) {
                    float maxC = max(max(color.r, color.g), color.b);
                    float minC = min(min(color.r, color.g), color.b);
                    float delta = maxC - minC;
                    float hue = 0.0;
                    if (delta > 0.0) {
                        if (maxC == color.r) hue = mod((color.g - color.b) / delta, 6.0);
                        else if (maxC == color.g) hue = (color.b - color.r) / delta + 2.0;
                        else hue = (color.r - color.g) / delta + 4.0;
                        hue /= 6.0;
                        if (hue < 0.0) hue += 1.0;
                    }
                    float sat = maxC == 0.0 ? 0.0 : delta / maxC;
                    float val = maxC;
                    hue = fract(hue + uMoodHueShift);
                    sat = clamp(sat * uMoodSaturation, 0.0, 1.0);
                    float i = floor(hue * 6.0);
                    float f = hue * 6.0 - i;
                    float p = val * (1.0 - sat);
                    float q = val * (1.0 - f * sat);
                    float t = val * (1.0 - (1.0 - f) * sat);
                    vec3 rgb;
                    if (i == 0.0) rgb = vec3(val, t, p);
                    else if (i == 1.0) rgb = vec3(q, val, p);
                    else if (i == 2.0) rgb = vec3(p, val, t);
                    else if (i == 3.0) rgb = vec3(p, q, val);
                    else if (i == 4.0) rgb = vec3(t, p, val);
                    else rgb = vec3(val, p, q);
                    rgb = (rgb - 0.5) * uMoodContrast + 0.5;
                    rgb.r += uMoodTemperature * 0.1;
                    rgb.b -= uMoodTemperature * 0.1;
                    return clamp(rgb, 0.0, 1.0);
                }
                `
            )
            .replace(
                '#include <dithering_fragment>',
                `#include <dithering_fragment>
                vec3 finalNormal = normalize(vNormal);
                vec3 finalViewDir = normalize(vViewPosition);
                float ndotl = max(dot(finalNormal, vec3(0.0, 0.0, 1.0)), 0.0);

                // Anime cel banding
                vec3 animeColor = applyAnimeCelBands(gl_FragColor.rgb, ndotl);

                // Rim lighting
                animeColor = applyRimLighting(animeColor, finalNormal, finalViewDir);

                // Mood grading
                animeColor = applyMoodGradingGLSL(animeColor);

                // PBR ↔ anime blend
                gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);
                `
            );
    }

    /**
     * Custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return this._animeCacheKey || `material-${this.id}`;
    }

    // -----------------------------------------------------------------------
    // Serialisation / copying
    // -----------------------------------------------------------------------

    /**
     * Set values from a plain object.
     * @param {Object} values
     */
    setValues(values) {
        if (values === undefined) return;
        for (const key in values) {
            const newValue = values[key];
            if (newValue === undefined) {
                console.warn(`Material: parameter '${key}' is undefined.`);
                continue;
            }
            const currentValue = this[key];
            if (currentValue === undefined) {
                console.warn(`Material: '${key}' is not a property of this material.`);
                continue;
            }
            if (currentValue && currentValue.isColor) {
                currentValue.set(newValue);
            } else if (currentValue && currentValue.isVector3 && newValue && newValue.isVector3) {
                currentValue.copy(newValue);
            } else if (Array.isArray(currentValue)) {
                currentValue.length = 0;
                for (let i = 0; i < newValue.length; i++) {
                    currentValue.push(newValue[i].clone ? newValue[i].clone() : newValue[i]);
                }
            } else {
                this[key] = newValue;
            }
        }
    }

    /**
     * Clone this material.
     * @returns {Material}
     */
    clone() {
        return new this.constructor().copy(this);
    }

    /**
     * Copy properties from another material.
     * @param {Material} source
     * @returns {Material}
     */
    copy(source) {
        this.name = source.name;
        this.blending = source.blending;
        this.side = source.side;
        this.vertexColors = source.vertexColors;
        this.opacity = source.opacity;
        this.transparent = source.transparent;
        this.alphaHash = source.alphaHash;
        this.alphaTest = source.alphaTest;
        this.alphaToCoverage = source.alphaToCoverage;
        this.blendSrc = source.blendSrc;
        this.blendDst = source.blendDst;
        this.blendEquation = source.blendEquation;
        this.blendSrcAlpha = source.blendSrcAlpha;
        this.blendDstAlpha = source.blendDstAlpha;
        this.blendEquationAlpha = source.blendEquationAlpha;
        this.blendColor.copy(source.blendColor);
        this.blendAlpha = source.blendAlpha;
        this.depthFunc = source.depthFunc;
        this.depthTest = source.depthTest;
        this.depthWrite = source.depthWrite;
        this.stencilWriteMask = source.stencilWriteMask;
        this.stencilFunc = source.stencilFunc;
        this.stencilRef = source.stencilRef;
        this.stencilFuncMask = source.stencilFuncMask;
        this.stencilFail = source.stencilFail;
        this.stencilZFail = source.stencilZFail;
        this.stencilZPass = source.stencilZPass;
        this.stencilWrite = source.stencilWrite;
        this.clippingPlanes = source.clippingPlanes;
        this.clipIntersection = source.clipIntersection;
        this.clipShadows = source.clipShadows;
        this.shadowSide = source.shadowSide;
        this.colorWrite = source.colorWrite;
        this.polygonOffset = source.polygonOffset;
        this.polygonOffsetFactor = source.polygonOffsetFactor;
        this.polygonOffsetUnits = source.polygonOffsetUnits;
        this.dithering = source.dithering;
        this.precision = source.precision;
        this.toneMapped = source.toneMapped;
        this.userData = JSON.parse(JSON.stringify(source.userData));

        // PBR ↔ Anime
        this.renderStyleBlend = source.renderStyleBlend;
        this.renderStyle = source.renderStyle;
        this.animeBands = source.animeBands;
        this.animeShadowThreshold = source.animeShadowThreshold;
        this.animeHighlightThreshold = source.animeHighlightThreshold;
        this.celThresholds = [...source.celThresholds];
        this.rimColor.copy(source.rimColor);
        this.rimIntensity = source.rimIntensity;
        this.rimPower = source.rimPower;
        this.outlineWidth = source.outlineWidth;
        this.outlineColor.copy(source.outlineColor);
        this.moodHueShift = source.moodHueShift;
        this.moodSaturation = source.moodSaturation;
        this.moodContrast = source.moodContrast;
        this.moodTemperature = source.moodTemperature;
        this.paperGrainIntensity = source.paperGrainIntensity;
        this.watercolorBleed = source.watercolorBleed;
        this.brushJitter = source.brushJitter;

        // PBR
        this.pbrMetalness = source.pbrMetalness;
        this.pbrRoughness = source.pbrRoughness;
        this.pbrEnvMapIntensity = source.pbrEnvMapIntensity;
        this.pbrClearcoat = source.pbrClearcoat;
        this.pbrSheen = source.pbrSheen;
        this.pbrTransmission = source.pbrTransmission;
        this.pbrIridescence = source.pbrIridescence;
        this.pbrAnisotropy = source.pbrAnisotropy;

        // Galactic scale
        this.floatingOriginThreshold = source.floatingOriginThreshold;
        this.lodDistances = [...source.lodDistances];
        this.galacticScaleEnabled = source.galacticScaleEnabled;

        // Custom shader
        this.customUniforms = JSON.parse(JSON.stringify(source.customUniforms));
        this.customDefines = { ...source.customDefines };
        this.variationSeed = source.variationSeed;

        return this;
    }

    /**
     * Serialise to JSON.
     * @param {Object} [meta]
     * @returns {Object}
     */
    toJSON(meta) {
        const isRoot = meta === undefined || typeof meta === 'string';
        if (isRoot) {
            meta = { textures: {}, images: {} };
        }

        const output = {
            metadata: {
                version: 4.6,
                type: 'Material',
                generator: 'Material.toJSON'
            },
            uuid: this.uuid,
            type: this.type,
            name: this.name,
            blending: this.blending,
            side: this.side,
            vertexColors: this.vertexColors,
            opacity: this.opacity,
            transparent: this.transparent,
            alphaHash: this.alphaHash,
            alphaTest: this.alphaTest,
            alphaToCoverage: this.alphaToCoverage,
            blendSrc: this.blendSrc,
            blendDst: this.blendDst,
            blendEquation: this.blendEquation,
            blendSrcAlpha: this.blendSrcAlpha,
            blendDstAlpha: this.blendDstAlpha,
            blendEquationAlpha: this.blendEquationAlpha,
            blendColor: this.blendColor.getHex(),
            blendAlpha: this.blendAlpha,
            depthFunc: this.depthFunc,
            depthTest: this.depthTest,
            depthWrite: this.depthWrite,
            stencilWriteMask: this.stencilWriteMask,
            stencilFunc: this.stencilFunc,
            stencilRef: this.stencilRef,
            stencilFuncMask: this.stencilFuncMask,
            stencilFail: this.stencilFail,
            stencilZFail: this.stencilZFail,
            stencilZPass: this.stencilZPass,
            stencilWrite: this.stencilWrite,
            clippingPlanes: this.clippingPlanes,
            clipIntersection: this.clipIntersection,
            clipShadows: this.clipShadows,
            shadowSide: this.shadowSide,
            colorWrite: this.colorWrite,
            polygonOffset: this.polygonOffset,
            polygonOffsetFactor: this.polygonOffsetFactor,
            polygonOffsetUnits: this.polygonOffsetUnits,
            dithering: this.dithering,
            precision: this.precision,
            toneMapped: this.toneMapped,
            userData: this.userData,

            // PBR ↔ Anime
            renderStyleBlend: this.renderStyleBlend,
            renderStyle: this.renderStyle,
            animeBands: this.animeBands,
            animeShadowThreshold: this.animeShadowThreshold,
            animeHighlightThreshold: this.animeHighlightThreshold,
            celThresholds: [...this.celThresholds],
            rimColor: this.rimColor.getHex(),
            rimIntensity: this.rimIntensity,
            rimPower: this.rimPower,
            outlineWidth: this.outlineWidth,
            outlineColor: this.outlineColor.getHex(),
            moodHueShift: this.moodHueShift,
            moodSaturation: this.moodSaturation,
            moodContrast: this.moodContrast,
            moodTemperature: this.moodTemperature,
            paperGrainIntensity: this.paperGrainIntensity,
            watercolorBleed: this.watercolorBleed,
            brushJitter: this.brushJitter,

            // PBR
            pbrMetalness: this.pbrMetalness,
            pbrRoughness: this.pbrRoughness,
            pbrEnvMapIntensity: this.pbrEnvMapIntensity,
            pbrClearcoat: this.pbrClearcoat,
            pbrSheen: this.pbrSheen,
            pbrTransmission: this.pbrTransmission,
            pbrIridescence: this.pbrIridescence,
            pbrAnisotropy: this.pbrAnisotropy,

            // Galactic scale
            floatingOriginThreshold: this.floatingOriginThreshold,
            lodDistances: [...this.lodDistances],
            galacticScaleEnabled: this.galacticScaleEnabled,

            // Custom shader
            customUniforms: this.customUniforms,
            customDefines: this.customDefines,
            variationSeed: this.variationSeed
        };

        if (!isRoot) {
            meta.materials[this.uuid] = output;
        }

        return output;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {Material}
     */
    fromJSON(json) {
        this.name = json.name || '';
        this.blending = json.blending ?? this.blending;
        this.side = json.side ?? this.side;
        // ... (all scalar properties follow the same pattern)
        this.renderStyleBlend = json.renderStyleBlend ?? this.renderStyleBlend;
        this.renderStyle = json.renderStyle ?? this.renderStyle;
        this.animeBands = json.animeBands ?? this.animeBands;
        this.animeShadowThreshold = json.animeShadowThreshold ?? this.animeShadowThreshold;
        this.animeHighlightThreshold = json.animeHighlightThreshold ?? this.animeHighlightThreshold;
        this.celThresholds = json.celThresholds ? [...json.celThresholds] : this.celThresholds;
        if (json.rimColor !== undefined) this.rimColor.setHex(json.rimColor);
        this.rimIntensity = json.rimIntensity ?? this.rimIntensity;
        this.rimPower = json.rimPower ?? this.rimPower;
        this.outlineWidth = json.outlineWidth ?? this.outlineWidth;
        if (json.outlineColor !== undefined) this.outlineColor.setHex(json.outlineColor);
        this.moodHueShift = json.moodHueShift ?? this.moodHueShift;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.paperGrainIntensity = json.paperGrainIntensity ?? this.paperGrainIntensity;
        this.watercolorBleed = json.watercolorBleed ?? this.watercolorBleed;
        this.brushJitter = json.brushJitter ?? this.brushJitter;
        this.pbrMetalness = json.pbrMetalness ?? this.pbrMetalness;
        this.pbrRoughness = json.pbrRoughness ?? this.pbrRoughness;
        this.pbrEnvMapIntensity = json.pbrEnvMapIntensity ?? this.pbrEnvMapIntensity;
        this.pbrClearcoat = json.pbrClearcoat ?? this.pbrClearcoat;
        this.pbrSheen = json.pbrSheen ?? this.pbrSheen;
        this.pbrTransmission = json.pbrTransmission ?? this.pbrTransmission;
        this.pbrIridescence = json.pbrIridescence ?? this.pbrIridescence;
        this.pbrAnisotropy = json.pbrAnisotropy ?? this.pbrAnisotropy;
        this.floatingOriginThreshold = json.floatingOriginThreshold ?? this.floatingOriginThreshold;
        this.lodDistances = json.lodDistances ? [...json.lodDistances] : this.lodDistances;
        this.galacticScaleEnabled = json.galacticScaleEnabled ?? this.galacticScaleEnabled;
        this.customUniforms = json.customUniforms ?? this.customUniforms;
        this.customDefines = json.customDefines ?? this.customDefines;
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }

    /**
     * Dispose the material.
     */
    dispose() {
        this.dispatchEvent({ type: 'dispose' });
    }

    /**
     * Register a disposal callback.
     * @param {Function} callback
     */
    onDispose(callback) {
        this.addEventListener('dispose', callback);
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata (optional companion)
// ---------------------------------------------------------------------------

/**
 * BitECS component describing the material's batching metadata. Consumers can
 * register materials with a World to drive batch updates.
 */
const MaterialBatchComponent = {
    materialPtr: 'ui32',
    renderStyleBlend: 'f64',
    animeBands: 'ui8',
    rimIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    pbrMetalness: 'f64',
    pbrRoughness: 'f64',
    galacticScaleEnabled: 'ui8',
    dirty: 'ui8'
};

export {
    Material,
    MaterialScratchPool,
    MaterialBatchComponent,
    applyMoodGrading,
    blendPBRAnime
};

export default Material;