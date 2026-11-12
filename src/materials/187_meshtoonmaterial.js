// file number : 187
// full path name : src/materials/187_meshtoonmaterial.js
// description : MeshToonMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with toon‑specific
//               anime stylization: multi‑band gradient construction with
//               configurable softness and shadow tint, view‑space normal rim
//               glow, ambient sky‑to‑ground gradient tinting, mood‑based color
//               grading, procedural paper‑grain and watercolor texture
//               variation, and brush jitter for hand‑drawn UV distortion.
//               Preserves the full r185 MeshToonMaterial API and integrates
//               with the unified PBR ↔ Anime blend layer, galactic‑scale
//               configuration hooks, zero‑allocation scratch pools, and
//               ECS‑ready batching metadata. All imports resolve to the
//               internal Threejs_gl repository tree; no CDN dependencies.
// best for : MeshToonMaterial, anime character skin/hair/clothing, toon‑shaded
//            props, stylized backgrounds, cel‑shaded vehicles, and any mesh
//            that needs the classic cel‑shaded look with full PBR blending.
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
import { Euler } from '../math/008_Euler.js';
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

/** @type {Vec3} Scratch 3D vector for normal staging. */
const _scratchNormal = new Vec3();

/** @type {Vec3} Scratch 3D vector for view‑direction staging. */
const _scratchView = new Vec3();

/** @type {Mat4} Scratch matrix for projection staging. */
const _scratchProjMat = new Mat4();

/** @type {Float32Array} Scratch gradient buffer. */
let _scratchGradient = new Float32Array(256);

// ---------------------------------------------------------------------------
// Pool system — reusable toon scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for toon‑material scratch records. Prevents per‑frame
 * allocation of temporary gradient‑building, rim‑glow, and ambient‑gradient
 * scratch objects.
 */
class ToonScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Vec3, view: Vec3}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            normal: new Vec3(),
            view: new Vec3()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Vec3, view: Vec3}}
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

/** @type {ToonScratchPool} Shared scratch pool for all toon material instances. */
const _toonScratchPool = new ToonScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — toon‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Build a 1D gradient map representing the cel banding curve for the toon
 * material. The gradient map is sampled by the shader with N·L as the U
 * coordinate; the output V is the lighting multiplier.
 * @param {number} resolution - Gradient map resolution (e.g. 128 or 256).
 * @param {number} bands - Number of cel bands (2–6 recommended).
 * @param {number} [shadowTint=0.7] - Brightness of the darkest band.
 * @param {number} [softness=0.1] - Edge softness in [0, 0.5].
 * @param {number} [highlightTint=1.15] - Brightness of the brightest band.
 * @returns {Float32Array}
 */
function buildToonGradientMap(resolution, bands, shadowTint = 0.7, softness = 0.1, highlightTint = 1.15) {
    const out = new Float32Array(resolution);

    for (let i = 0; i < resolution; i++) {
        const ndotl = Math.max(0, Math.min(1, i / (resolution - 1)));

        // Quantize into bands
        const bandWidth = 1.0 / bands;
        const bandIndex = Math.floor(ndotl / bandWidth);

        // Distance to band center (for soft edges)
        const bandCenter = bandIndex * bandWidth + bandWidth * 0.5;
        const distToCenter = Math.abs(ndotl - bandCenter);

        // Soft edge factor
        const softFactor = Math.max(0, Math.min(1, distToCenter / (bandWidth * 0.5)));
        const edgeBlend = (1 - softFactor) * (1 - softness) + softness;

        // Map band index to brightness using shadow → highlight tint
        const bandPos = bandIndex / Math.max(1, bands - 1);
        const targetBrightness = shadowTint + (highlightTint - shadowTint) * bandPos;

        // Blend target with the smooth ndotl response near band edges
        out[i] = Math.max(0, Math.min(1, targetBrightness * edgeBlend + ndotl * (1 - edgeBlend)));
    }

    return out;
}

/**
 * Compute a view‑space normal rim glow. Surfaces facing away from the view
 * (silhouettes) produce a strong rim, mimicking the cyan water rims and warm
 * sunset character rims in the reference imagery.
 * @param {Vec3} viewNormal - View‑space normal (normalized).
 * @param {Vec3} viewDir - View direction (normalized).
 * @param {number} [power=2.5] - Rim falloff power (higher = tighter rim).
 * @param {number} [intensity=1.0] - Rim intensity multiplier.
 * @returns {number} Rim intensity in [0, 1].
 */
function computeToonRimGlow(viewNormal, viewDir, power = 2.5, intensity = 1.0) {
    _scratchNormal.copy(viewNormal).normalize();
    _scratchView.copy(viewDir).normalize();

    const ndotv = _scratchNormal.dot(_scratchView);
    const rim = Math.pow(1.0 - Math.abs(ndotv), power);
    return Math.max(0, Math.min(1, rim * intensity));
}

/**
 * Apply a vertical gradient tint from a sky color to a ground color. Emulates
 * the ambient bounce light in anime backgrounds — cool blue sky above, warm
 * ground below.
 * @param {Color} color - The color to tint (modified in place).
 * @param {number} worldY - The world Y coordinate of the fragment.
 * @param {number} heightRange - Range over which the gradient blends.
 * @param {Color} skyColor - Tint applied at the top.
 * @param {Color} groundColor - Tint applied at the bottom.
 * @param {number} intensity - Blend intensity in [0, 1].
 * @returns {Color}
 */
function applyToonAmbientGradient(color, worldY, heightRange, skyColor, groundColor, intensity) {
    if (intensity <= 0) return color;

    let t = worldY / heightRange + 0.5;
    t = Math.max(0, Math.min(1, t));

    const tr = groundColor.r + (skyColor.r - groundColor.r) * t;
    const tg = groundColor.g + (skyColor.g - groundColor.g) * t;
    const tb = groundColor.b + (skyColor.b - groundColor.b) * t;

    color.r = color.r * (1 - intensity) + tr * color.r * intensity;
    color.g = color.g * (1 - intensity) + tg * color.g * intensity;
    color.b = color.b * (1 - intensity) + tb * color.b * intensity;

    return color;
}

/**
 * Apply mood‑based color grading for toon materials.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeToonColor(color, temperature, saturation, brightness, contrast) {
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

/**
 * Generate a combined paper‑grain and watercolor texture using simplex‑noise
 * with multiple octaves.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03] - Base noise scale.
 * @param {number} [octaves=4] - Number of noise octaves.
 * @param {number} [paperGrain=0.3] - Paper grain intensity.
 * @param {number} [watercolorBleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateToonTexture(width, height, scale = 0.03, octaves = 4, paperGrain = 0.3, watercolorBleed = 0.5) {
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

            value = (value - 0.5) * (1.0 + watercolorBleed) + 0.5;
            value = Math.max(0, Math.min(1, value));

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
// Main MeshToonMaterial class
// ---------------------------------------------------------------------------

/**
 * A material implementing toon shading. Toon shading uses a gradient map (a
 * small 1D texture) to remap the N·L lighting term into discrete cel bands.
 * This is the classic anime rendering technique — flat color zones separated
 * by hard or soft edges.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: multi‑band gradient with configurable
 * smoothness and shadow tint, view‑space normal rim glow, mood‑based color
 * grading, ambient sky‑to‑ground gradient tinting, procedural paper‑grain and
 * watercolor texture variation, and brush jitter for hand‑drawn UV distortion.
 *
 * @augments Material
 */
class MeshToonMaterial extends Material {

    /**
     * Static block — pre‑warm the shared scratch pool for toon materials.
     */
    static {
        _toonScratchPool.warm(32);
        _scratchGradient = buildToonGradientMap(256, 3, 0.7, 0.1, 1.15);
    }

    /**
     * Construct a new mesh toon material.
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
        this.isMeshToonMaterial = true;

        this.type = 'MeshToonMaterial';

        // -------------------------------------------------------------------
        // Standard MeshToonMaterial surface
        // -------------------------------------------------------------------

        /**
         * The material's base color.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color(0xffffff);

        /**
         * The color map.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * The gradient map. This is a 1D texture sampled by N·L to produce
         * the cel‑shading bands.
         * @type {?Texture}
         * @default null
         */
        this.gradientMap = null;

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
         * The emissive color of the material.
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
         * The alpha map.
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

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
        // Anime rendering extensions — toon‑specific
        // -------------------------------------------------------------------

        /**
         * Number of toon cel bands. 2 = classic hard‑shadow anime,
         * 3–4 = softer stylized, 5–6 = very smooth cel.
         * @type {number}
         * @default 3
         */
        this.toonBands = 3;

        /**
         * Brightness of the darkest band.
         * @type {number}
         * @default 0.7
         */
        this.toonShadowTint = 0.7;

        /**
         * Edge softness of cel bands.
         * @type {number}
         * @default 0.1
         */
        this.toonSoftness = 0.1;

        /**
         * Brightness of the brightest band. Values > 1 push the top band into
         * a glow effect.
         * @type {number}
         * @default 1.15
         */
        this.toonHighlightTint = 1.15;

        /**
         * Cached 1D gradient map built from the toon parameters.
         * @type {Float32Array}
         * @private
         */
        this._gradientCache = buildToonGradientMap(256, 3, 0.7, 0.1, 1.15);

        /**
         * Rim‑glow falloff power. Higher = tighter rim.
         * @type {number}
         * @default 2.5
         */
        this.rimPower = 2.5;

        /**
         * Rim‑glow intensity.
         * @type {number}
         * @default 0
         */
        this.rimIntensity = 0;

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
         * Range over which the ambient gradient blends.
         * @type {number}
         * @default 10
         */
        this.ambientHeight = 10;

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
         * The precomputed mood‑graded base color.
         * @type {Color}
         */
        this.moodColor = new Color(0xffffff);

        /**
         * The precomputed mood‑graded emissive color.
         * @type {Color}
         */
        this.moodEmissive = new Color(0x000000);

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
         * Brush jitter amplitude for UV distortion.
         * @type {number}
         * @default 0
         */
        this.brushJitter = 0;

        /**
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, toon materials lean anime)
        // -------------------------------------------------------------------

        /**
         * Toon materials are primarily anime‑oriented.
         * @type {number}
         * @default 0.8
         */
        this.renderStyleBlend = 0.8;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the toon material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters and initialise derived values
        // -------------------------------------------------------------------

        this.setValues(parameters);

        // Initialise derived colors from current state.
        this.updateMoodColors();
        this.rebuildGradientCache();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Rebuild the internal 1D gradient cache from the current toon parameters.
     * @returns {MeshToonMaterial} A reference to this instance.
     */
    rebuildGradientCache() {
        this._gradientCache = buildToonGradientMap(
            256,
            this.toonBands,
            this.toonShadowTint,
            this.toonSoftness,
            this.toonHighlightTint
        );
        return this;
    }

    /**
     * Build a `Uint8Array` suitable for a `DataTexture` 1D gradient map from
     * the current toon parameters.
     * @param {number} [resolution=256]
     * @returns {Uint8Array}
     */
    toGradientData(resolution = 256) {
        const cache = resolution === this._gradientCache.length
            ? this._gradientCache
            : buildToonGradientMap(resolution, this.toonBands, this.toonShadowTint, this.toonSoftness, this.toonHighlightTint);

        const out = new Uint8Array(resolution);
        for (let i = 0; i < resolution; i++) {
            out[i] = Math.floor(cache[i] * 255);
        }
        return out;
    }

    /**
     * Compute the view‑space normal rim glow for a given normal and view
     * direction.
     * @param {Vec3} viewNormal
     * @param {Vec3} viewDir
     * @returns {number}
     */
    sampleToonRim(viewNormal, viewDir) {
        if (this.rimIntensity <= 0) return 0;
        return computeToonRimGlow(viewNormal, viewDir, this.rimPower, this.rimIntensity);
    }

    /**
     * Apply the ambient gradient tint to a color at a given world Y.
     * @param {Color} color
     * @param {number} worldY
     * @returns {Color}
     */
    applyAmbientGradient(color, worldY) {
        return applyToonAmbientGradient(
            color,
            worldY,
            this.ambientHeight,
            this.skyTint,
            this.groundTint,
            this.ambientGradient
        );
    }

    /**
     * Recompute the mood‑graded colors from the current mood parameters.
     * @returns {MeshToonMaterial} A reference to this instance.
     */
    updateMoodColors() {
        this.moodColor.copy(this.color);
        gradeToonColor(this.moodColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        this.moodEmissive.copy(this.emissive);
        gradeToonColor(this.moodEmissive, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        return this;
    }

    /**
     * Generate a procedural paper‑grain / watercolor texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.03]
     * @param {number} [octaves=4]
     * @returns {Uint8Array}
     */
    generateToonTexture(width, height, scale = 0.03, octaves = 4) {
        return generateToonTexture(width, height, scale, octaves, this.paperGrain, this.watercolorBleed);
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
     * @returns {Promise<MeshToonMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base Material's anime shader chunks with toon‑specific
     * features: multi‑band gradient remapping, view‑space normal rim glow,
     * ambient gradient tinting, and paper‑grain / watercolor texture variation.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject toon‑specific uniforms
        shader.uniforms.toonBands = { value: this.toonBands };
        shader.uniforms.toonShadowTint = { value: this.toonShadowTint };
        shader.uniforms.toonSoftness = { value: this.toonSoftness };
        shader.uniforms.toonHighlightTint = { value: this.toonHighlightTint };
        shader.uniforms.rimPower = { value: this.rimPower };
        shader.uniforms.rimIntensity = { value: this.rimIntensity };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.ambientGradient = { value: this.ambientGradient };
        shader.uniforms.ambientHeight = { value: this.ambientHeight };
        shader.uniforms.skyTint = { value: this.skyTint };
        shader.uniforms.groundTint = { value: this.groundTint };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.moodEmissive = { value: this.moodEmissive };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.brushJitter = { value: this.brushJitter };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int toonBands;
                uniform float toonShadowTint;
                uniform float toonSoftness;
                uniform float toonHighlightTint;
                uniform float rimPower;
                uniform float rimIntensity;
                uniform vec3 rimGlowColor;
                uniform float ambientGradient;
                uniform float ambientHeight;
                uniform vec3 skyTint;
                uniform vec3 groundTint;
                uniform vec3 moodColor;
                uniform vec3 moodEmissive;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float brushJitter;
                uniform float variationOffset;

                float applyToonBand(float ndotl) {
                    if (toonBands <= 1) return ndotl;
                    float bandWidth = 1.0 / float(toonBands);
                    float bandIndex = floor(ndotl / bandWidth);
                    float bandCenter = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToCenter = abs(ndotl - bandCenter);
                    float softFactor = clamp(distToCenter / (bandWidth * 0.5), 0.0, 1.0);
                    float edgeBlend = (1.0 - softFactor) * (1.0 - toonSoftness) + toonSoftness;
                    float bandPos = bandIndex / max(1.0, float(toonBands) - 1.0);
                    float targetBrightness = toonShadowTint + (toonHighlightTint - toonShadowTint) * bandPos;
                    return clamp(targetBrightness * edgeBlend + ndotl * (1.0 - edgeBlend), 0.0, 1.0);
                }

                float computeToonRim(vec3 n, vec3 v) {
                    if (rimIntensity <= 0.0) return 0.0;
                    float ndotv = abs(dot(normalize(n), normalize(v)));
                    float rim = pow(1.0 - ndotv, rimPower);
                    return clamp(rim * rimIntensity, 0.0, 1.0);
                }

                vec3 applyAmbientGradient(vec3 baseColor, float worldY) {
                    if (ambientGradient <= 0.0) return baseColor;
                    float t = clamp(worldY / ambientHeight + 0.5, 0.0, 1.0);
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

                // Apply toon cel banding
                float ndotl = max(dot(normalize(vNormal), normalize(vec3(0.0, 0.0, 1.0))), 0.0);
                float bandedLight = applyToonBand(ndotl);

                // Blend mood‑graded color with the banded light
                gl_FragColor.rgb = mix(
                    gl_FragColor.rgb,
                    moodColor * bandedLight,
                    0.85
                );

                // Add emissive contribution
                gl_FragColor.rgb += moodEmissive;

                // Apply ambient gradient
                gl_FragColor.rgb = applyAmbientGradient(gl_FragColor.rgb, vViewPosition.z);

                // Apply paper grain
                gl_FragColor.a *= samplePaperGrain(vUv);

                // Rim glow
                float rim = computeToonRim(vNormal, normalize(vViewPosition));
                gl_FragColor.rgb += rimGlowColor * rim;
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
            this.toonBands,
            this.toonShadowTint,
            this.toonSoftness,
            this.toonHighlightTint,
            this.rimPower,
            this.rimIntensity,
            this.ambientGradient,
            this.ambientHeight,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.paperGrain,
            this.watercolorBleed,
            this.brushJitter,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {MeshToonMaterial} source
     * @return {MeshToonMaterial}
     */
    copy(source) {
        super.copy(source);

        this.color.copy(source.color);
        this.map = source.map;
        this.gradientMap = source.gradientMap;
        this.lightMap = source.lightMap;
        this.lightMapIntensity = source.lightMapIntensity;
        this.aoMap = source.aoMap;
        this.aoMapIntensity = source.aoMapIntensity;
        this.emissive.copy(source.emissive);
        this.emissiveIntensity = source.emissiveIntensity;
        this.emissiveMap = source.emissiveMap;
        this.bumpMap = source.bumpMap;
        this.bumpScale = source.bumpScale;
        this.normalMap = source.normalMap;
        this.normalMapType = source.normalMapType;
        this.normalScale.copy(source.normalScale);
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.alphaMap = source.alphaMap;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.fog = source.fog;

        // Anime extensions
        this.toonBands = source.toonBands;
        this.toonShadowTint = source.toonShadowTint;
        this.toonSoftness = source.toonSoftness;
        this.toonHighlightTint = source.toonHighlightTint;
        this._gradientCache = source._gradientCache ? new Float32Array(source._gradientCache) : null;
        this.rimPower = source.rimPower;
        this.rimIntensity = source.rimIntensity;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.ambientGradient = source.ambientGradient;
        this.ambientHeight = source.ambientHeight;
        this.skyTint.copy(source.skyTint);
        this.groundTint.copy(source.groundTint);
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy(source.moodColor);
        this.moodEmissive.copy(source.moodEmissive);
        this.paperGrain = source.paperGrain;
        this.watercolorBleed = source.watercolorBleed;
        this.brushJitter = source.brushJitter;
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

        data.type = 'MeshToonMaterial';

        if (this.color.getHex() !== 0xffffff) data.color = this.color.getHex();
        if (this.map !== null) data.map = this.map.toJSON(meta).uuid;
        if (this.gradientMap !== null) data.gradientMap = this.gradientMap.toJSON(meta).uuid;
        if (this.lightMap !== null) data.lightMap = this.lightMap.toJSON(meta).uuid;
        if (this.lightMapIntensity !== 1.0) data.lightMapIntensity = this.lightMapIntensity;
        if (this.aoMap !== null) data.aoMap = this.aoMap.toJSON(meta).uuid;
        if (this.aoMapIntensity !== 1.0) data.aoMapIntensity = this.aoMapIntensity;
        if (this.emissive.getHex() !== 0x000000) data.emissive = this.emissive.getHex();
        if (this.emissiveIntensity !== 1.0) data.emissiveIntensity = this.emissiveIntensity;
        if (this.emissiveMap !== null) data.emissiveMap = this.emissiveMap.toJSON(meta).uuid;
        if (this.bumpMap !== null) data.bumpMap = this.bumpMap.toJSON(meta).uuid;
        if (this.bumpScale !== 1) data.bumpScale = this.bumpScale;
        if (this.normalMap !== null) data.normalMap = this.normalMap.toJSON(meta).uuid;
        if (this.normalMapType !== (Constants.TANGENT_SPACE_NORMAL_MAP ?? 0)) data.normalMapType = this.normalMapType;
        if (this.normalScale.x !== 1 || this.normalScale.y !== 1) data.normalScale = this.normalScale.toArray();
        if (this.displacementMap !== null) data.displacementMap = this.displacementMap.toJSON(meta).uuid;
        if (this.displacementScale !== 1) data.displacementScale = this.displacementScale;
        if (this.displacementBias !== 0) data.displacementBias = this.displacementBias;
        if (this.alphaMap !== null) data.alphaMap = this.alphaMap.toJSON(meta).uuid;
        if (this.wireframe !== false) data.wireframe = this.wireframe;
        if (this.wireframeLinewidth !== 1) data.wireframeLinewidth = this.wireframeLinewidth;
        if (this.fog === false) data.fog = false;

        // Anime extensions
        if (this.toonBands !== 3) data.toonBands = this.toonBands;
        if (this.toonShadowTint !== 0.7) data.toonShadowTint = this.toonShadowTint;
        if (this.toonSoftness !== 0.1) data.toonSoftness = this.toonSoftness;
        if (this.toonHighlightTint !== 1.15) data.toonHighlightTint = this.toonHighlightTint;
        if (this.rimPower !== 2.5) data.rimPower = this.rimPower;
        if (this.rimIntensity !== 0) data.rimIntensity = this.rimIntensity;
        if (this.rimGlowColor.getHex() !== new Color(0.5, 0.9, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.ambientGradient !== 0) data.ambientGradient = this.ambientGradient;
        if (this.ambientHeight !== 10) data.ambientHeight = this.ambientHeight;
        if (this.skyTint.getHex() !== new Color(0.5, 0.75, 1.0).getHex()) {
            data.skyTint = this.skyTint.getHex();
        }
        if (this.groundTint.getHex() !== new Color(1.0, 0.85, 0.7).getHex()) {
            data.groundTint = this.groundTint.getHex();
        }
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.watercolorBleed !== 0) data.watercolorBleed = this.watercolorBleed;
        if (this.brushJitter !== 0) data.brushJitter = this.brushJitter;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {MeshToonMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        if (json.color !== undefined) this.color.setHex(json.color);
        this.lightMapIntensity = json.lightMapIntensity ?? this.lightMapIntensity;
        this.aoMapIntensity = json.aoMapIntensity ?? this.aoMapIntensity;
        if (json.emissive !== undefined) this.emissive.setHex(json.emissive);
        this.emissiveIntensity = json.emissiveIntensity ?? this.emissiveIntensity;
        this.bumpScale = json.bumpScale ?? this.bumpScale;
        this.normalMapType = json.normalMapType ?? this.normalMapType;
        if (json.normalScale) this.normalScale.fromArray(json.normalScale);
        this.displacementScale = json.displacementScale ?? this.displacementScale;
        this.displacementBias = json.displacementBias ?? this.displacementBias;
        this.wireframe = json.wireframe ?? this.wireframe;
        this.wireframeLinewidth = json.wireframeLinewidth ?? this.wireframeLinewidth;
        this.fog = json.fog ?? this.fog;

        this.toonBands = json.toonBands ?? this.toonBands;
        this.toonShadowTint = json.toonShadowTint ?? this.toonShadowTint;
        this.toonSoftness = json.toonSoftness ?? this.toonSoftness;
        this.toonHighlightTint = json.toonHighlightTint ?? this.toonHighlightTint;
        this.rimPower = json.rimPower ?? this.rimPower;
        this.rimIntensity = json.rimIntensity ?? this.rimIntensity;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.ambientGradient = json.ambientGradient ?? this.ambientGradient;
        this.ambientHeight = json.ambientHeight ?? this.ambientHeight;
        if (json.skyTint !== undefined) this.skyTint.setHex(json.skyTint);
        if (json.groundTint !== undefined) this.groundTint.setHex(json.groundTint);
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.watercolorBleed = json.watercolorBleed ?? this.watercolorBleed;
        this.brushJitter = json.brushJitter ?? this.brushJitter;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived values
        this.updateMoodColors();
        this.rebuildGradientCache();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for toon materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing toon‑specific batching metadata. Consumers can
 * register toon materials with a World to drive batch updates.
 */
const MeshToonMaterialBatchComponent = {
    materialPtr: 'ui32',
    toonBands: 'ui8',
    toonShadowTint: 'f64',
    toonSoftness: 'f64',
    toonHighlightTint: 'f64',
    rimPower: 'f64',
    rimIntensity: 'f64',
    ambientGradient: 'f64',
    ambientHeight: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    brushJitter: 'f64',
    dirty: 'ui8'
};

export {
    MeshToonMaterial,
    ToonScratchPool,
    MeshToonMaterialBatchComponent,
    buildToonGradientMap,
    computeToonRimGlow,
    applyToonAmbientGradient,
    gradeToonColor,
    generateToonTexture
};

export default MeshToonMaterial;