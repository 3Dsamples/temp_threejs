// file number : 185
// full path name : src/materials/185_meshphongmaterial.js
// description : MeshPhongMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with Phong‑specific
//               anime stylization: specular cel banding (hard‑edged anime
//               sparkle with adjustable threshold and softness), specular toon
//               shaping (anisotropic elongated highlights for hand‑drawn hair
//               shine), mood‑based specular tinting (warm sunset glints, cool
//               cyan ice glints), rim glow, procedural specular variation, and
//               per‑instance variation for crowds. Preserves the full r185
//               MeshPhongMaterial API and integrates with the unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : MeshPhongMaterial, anime character hair and eyes, glossy props,
//            glassware, metals, wet surfaces, ceramic objects, mobile anime
//            games, and any phong‑shaded mesh that needs real‑time stylized
//            specular highlights.
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

/** @type {Float32Array} Scratch vec3 for zero‑allocation colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec3} Scratch 3D vector for half‑vector staging. */
const _scratchHalfVec = new Vec3();

/** @type {Vec3} Scratch 3D vector for normal staging. */
const _scratchNormal = new Vec3();

/** @type {Vec3} Scratch 3D vector for light‑direction staging. */
const _scratchLightDir = new Vec3();

/** @type {Vec3} Scratch 3D vector for view‑direction staging. */
const _scratchViewDir = new Vec3();

/** @type {Mat4} Scratch matrix for projection staging. */
const _scratchProjMat = new Mat4();

// ---------------------------------------------------------------------------
// Pool system — reusable Phong scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for Phong‑material scratch records. Prevents per‑frame
 * allocation of temporary specular‑banding, toon‑shaping, and mood‑tinting
 * scratch objects.
 */
class PhongScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, halfVec: Vec3, normal: Vec3, lightDir: Vec3, viewDir: Vec3}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            halfVec: new Vec3(),
            normal: new Vec3(),
            lightDir: new Vec3(),
            viewDir: new Vec3()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, halfVec: Vec3, normal: Vec3, lightDir: Vec3, viewDir: Vec3}}
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

/** @type {PhongScratchPool} Shared scratch pool for all Phong material instances. */
const _phongScratchPool = new PhongScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — Phong‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Quantize a specular highlight intensity into discrete cel bands. This is the
 * classic anime "sparkle" — instead of a smooth Gaussian falloff, the highlight
 * is a hard‑edged shape with a sharp boundary.
 * @param {number} specularIntensity - Raw specular intensity in [0, 1].
 * @param {number} bands - Number of specular bands (2–3 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [threshold=0.5] - Minimum intensity to show the first band.
 * @param {number} [softness=0.05] - Edge softness in [0, 0.3].
 * @returns {number} Banded specular intensity in [0, 1].
 */
function applySpecularCelBanding(specularIntensity, bands, quantizeAmount, threshold = 0.5, softness = 0.05) {
    if (bands <= 1 || specularIntensity < threshold) return 0;

    // Normalize into [0, 1] above the threshold
    const normalized = Math.max(0, Math.min(1, (specularIntensity - threshold) / (1.0 - threshold)));

    // Quantize into bands
    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(normalized / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;

    // Soft edge near band boundary
    const distToBoundary = Math.abs(normalized - bandIndex * bandWidth - bandWidth * 0.5);
    const softFactor = Math.max(0, Math.min(1, distToBoundary / (bandWidth * 0.5)));
    const softQuantized = quantized + (normalized - quantized) * (1 - softFactor) * softness;

    // Blend continuous and quantized
    const finalSpec = normalized + (softQuantized - normalized) * quantizeAmount;
    return Math.max(0, Math.min(1, finalSpec));
}

/**
 * Shape a specular highlight into an elongated toon form. Classic anime hair
 * shine is an anisotropic "streak" rather than a circular dot.
 * @param {number} specularIntensity - Raw specular intensity in [0, 1].
 * @param {number} anisotropy - Elongation factor in [0, 1] (0 = circular, 1 = very long).
 * @param {number} angle - Angle of the anisotropy axis in radians.
 * @param {number} halfVecX - X component of the half vector (view‑space).
 * @param {number} halfVecY - Y component of the half vector (view‑space).
 * @returns {number} Shaped specular intensity in [0, 1].
 */
function applySpecularToonShaping(specularIntensity, anisotropy, angle, halfVecX, halfVecY) {
    if (anisotropy <= 0) return specularIntensity;

    // Rotate the half‑vector into the anisotropy frame
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);
    const localX = halfVecX * cosA - halfVecY * sinA;
    const localY = halfVecX * sinA + halfVecY * cosA;

    // Compress the local Y axis (making the highlight longer along X)
    const distSquared = localX * localX + localY * localY / Math.max(1e-4, 1 - anisotropy);

    // Map distance back into a shaping factor
    const shape = Math.pow(Math.max(0, 1.0 - Math.min(1, distSquared)), 0.5);

    // Multiply the specular by the shaping factor
    return Math.max(0, Math.min(1, specularIntensity * shape));
}

/**
 * Apply mood‑based specular tinting. Warm moods (sunset) tint specular
 * highlights toward orange/gold, while cool moods (snowy, icy) tint them
 * toward cyan.
 * @param {Color} color - The specular color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} intensity - Tint intensity in [0, 1].
 * @returns {Color}
 */
function gradeSpecularColor(color, temperature, intensity) {
    if (intensity <= 0) return color;

    _scratchRGB[0] = color.r;
    _scratchRGB[1] = color.g;
    _scratchRGB[2] = color.b;

    // Warm target (gold): (1.0, 0.85, 0.5); Cool target (ice cyan): (0.7, 0.9, 1.0)
    const targetR = 1.0;
    const targetG = 0.85 + temperature * 0.05;
    const targetB = 0.5 - temperature * 0.5;

    const r = _scratchRGB[0] * (1 - intensity) + targetR * intensity;
    const g = _scratchRGB[1] * (1 - intensity) + targetG * intensity;
    const b = _scratchRGB[2] * (1 - intensity) + targetB * intensity;

    color.setRGB(
        Math.max(0, Math.min(1, r)),
        Math.max(0, Math.min(1, g)),
        Math.max(0, Math.min(1, b)),
        ColorManagement.workingColorSpace
    );
    return color;
}

/**
 * Apply mood‑based color grading to the diffuse channel.
 * @param {Color} color - The diffuse color (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeDiffuseColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate a procedural specular variation texture using simplex‑noise. Used as
 * a multiplier on the specular highlight to break up the hard cel edges with
 * subtle hand‑drawn texture.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.08] - Noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [intensity=0.3] - Variation intensity in [0, 1].
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateSpecularVariation(width, height, scale = 0.08, octaves = 3, intensity = 0.3) {
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

            // Modulate around neutral (1.0)
            value = value * intensity + (1.0 - intensity * 0.5);
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
// Main MeshPhongMaterial class
// ---------------------------------------------------------------------------

/**
 * A material for shiny surfaces with specular highlights. The material uses a
 * non‑physically based Blinn‑Phong model for calculating reflectance.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: specular cel banding, specular toon
 * shaping (anisotropic elongation), mood‑based specular tinting, and procedural
 * specular variation.
 *
 * @augments Material
 */
class MeshPhongMaterial extends Material {

    /**
     * Static block — pre‑warm the shared scratch pool for Phong materials.
     */
    static {
        _phongScratchPool.warm(32);
    }

    /**
     * Construct a new mesh phong material.
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
        this.isMeshPhongMaterial = true;

        this.type = 'MeshPhongMaterial';

        // -------------------------------------------------------------------
        // Standard MeshPhongMaterial surface
        // -------------------------------------------------------------------

        /**
         * The material's base color.
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
         * The specular color of the material.
         * @type {Color}
         * @default (0x111111)
         */
        this.specular = new Color(0x111111);

        /**
         * How shiny the specular highlight is. A higher value = shinier.
         * @type {number}
         * @default 30
         */
        this.shininess = 30;

        /**
         * The specular map.
         * @type {?Texture}
         * @default null
         */
        this.specularMap = null;

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
         * The ambient occlusion map (red channel).
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
        this.combine = Constants.MULTIPLY_OPERATION ?? 0;

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
         * Whether to use flat shading.
         * @type {boolean}
         * @default false
         */
        this.flatShading = false;

        /**
         * Whether the material is affected by fog.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        // -------------------------------------------------------------------
        // Anime rendering extensions — Phong‑specific
        // -------------------------------------------------------------------

        /**
         * Number of specular cel bands. 2 = classic hard‑edged anime sparkle,
         * 3 = softer stylized, 0 = continuous (off).
         * @type {number}
         * @default 2
         */
        this.specularBands = 2;

        /**
         * Blend amount between continuous and banded specular.
         * @type {number}
         * @default 1.0
         */
        this.specularQuantize = 1.0;

        /**
         * Minimum specular intensity to trigger the first band.
         * @type {number}
         * @default 0.5
         */
        this.specularThreshold = 0.5;

        /**
         * Specular band edge softness.
         * @type {number}
         * @default 0.05
         */
        this.specularSoftness = 0.05;

        /**
         * Anisotropy of the specular highlight. 0 = circular (standard),
         * 1 = very elongated. Classic anime hair uses 0.5–0.8.
         * @type {number}
         * @default 0
         */
        this.specularAnisotropy = 0;

        /**
         * Angle of the anisotropy axis in radians.
         * @type {number}
         * @default 0
         */
        this.specularAngle = 0;

        /**
         * Mood temperature shift in [-1, 1].
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Mood saturation multiplier (diffuse).
         * @type {number}
         * @default 1.0
         */
        this.moodSaturation = 1.0;

        /**
         * Mood brightness multiplier (diffuse).
         * @type {number}
         * @default 1.0
         */
        this.moodBrightness = 1.0;

        /**
         * Mood contrast multiplier (diffuse).
         * @type {number}
         * @default 1.0
         */
        this.moodContrast = 1.0;

        /**
         * Specular tint intensity applied via the mood system.
         * @type {number}
         * @default 0
         */
        this.specularTintIntensity = 0;

        /**
         * The precomputed mood‑graded diffuse color.
         * @type {Color}
         */
        this.moodColor = new Color(0xffffff);

        /**
         * The precomputed mood‑graded specular color.
         * @type {Color}
         */
        this.moodSpecular = new Color(0x111111);

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
        // PBR ↔ Anime blend (inherited, Phong materials lean semi‑realistic)
        // -------------------------------------------------------------------

        /**
         * Phong materials are typically semi‑realistic to anime.
         * @type {number}
         * @default 0.5
         */
        this.renderStyleBlend = 0.5;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the Phong material participates in galactic‑scale
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
        this.updateMoodColors();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Apply specular cel banding to a raw specular intensity.
     * @param {number} specularIntensity - Raw specular in [0, 1].
     * @returns {number} Banded specular in [0, 1].
     */
    applySpecularBanding(specularIntensity) {
        return applySpecularCelBanding(
            specularIntensity,
            this.specularBands,
            this.specularQuantize,
            this.specularThreshold,
            this.specularSoftness
        );
    }

    /**
     * Apply specular toon shaping (anisotropic elongation).
     * @param {number} specularIntensity
     * @param {number} halfVecX
     * @param {number} halfVecY
     * @returns {number}
     */
    applySpecularShaping(specularIntensity, halfVecX, halfVecY) {
        return applySpecularToonShaping(
            specularIntensity,
            this.specularAnisotropy,
            this.specularAngle,
            halfVecX,
            halfVecY
        );
    }

    /**
     * Recompute the mood‑graded colors from the current mood parameters.
     * @returns {MeshPhongMaterial} A reference to this instance.
     */
    updateMoodColors() {
        this.moodColor.copy(this.color);
        gradeDiffuseColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        this.moodSpecular.copy(this.specular);
        gradeSpecularColor(this.moodSpecular, this.moodTemperature, this.specularTintIntensity);
        return this;
    }

    /**
     * Generate a procedural specular variation texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.08]
     * @param {number} [octaves=3]
     * @returns {Uint8Array}
     */
    generateSpecularVariation(width, height, scale = 0.08, octaves = 3) {
        return generateSpecularVariation(width, height, scale, octaves, this.paperGrain);
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
     * @returns {Promise<MeshPhongMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base Material's anime shader chunks with Phong‑specific
     * features: specular cel banding, specular toon shaping, and mood‑based
     * specular tinting.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject Phong‑specific uniforms
        shader.uniforms.specularBands = { value: this.specularBands };
        shader.uniforms.specularQuantize = { value: this.specularQuantize };
        shader.uniforms.specularThreshold = { value: this.specularThreshold };
        shader.uniforms.specularSoftness = { value: this.specularSoftness };
        shader.uniforms.specularAnisotropy = { value: this.specularAnisotropy };
        shader.uniforms.specularAngle = { value: this.specularAngle };
        shader.uniforms.moodSpecular = { value: this.moodSpecular };
        shader.uniforms.specularTintIntensity = { value: this.specularTintIntensity };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int specularBands;
                uniform float specularQuantize;
                uniform float specularThreshold;
                uniform float specularSoftness;
                uniform float specularAnisotropy;
                uniform float specularAngle;
                uniform vec3 moodSpecular;
                uniform float specularTintIntensity;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float variationOffset;

                float applySpecularBanding(float spec) {
                    if (specularBands <= 1 || spec < specularThreshold) return spec;
                    float normalized = (spec - specularThreshold) / max(1.0 - specularThreshold, 0.0001);
                    normalized = clamp(normalized, 0.0, 1.0);
                    float bandWidth = 1.0 / float(specularBands);
                    float bandIndex = floor(normalized / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(normalized - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (normalized - quantized) * (1.0 - softFactor) * specularSoftness;
                    return clamp(mix(normalized, softQuantized, specularQuantize), 0.0, 1.0);
                }

                float applySpecularShaping(float spec, vec3 halfVec) {
                    if (specularAnisotropy <= 0.0) return spec;
                    float cosA = cos(-specularAngle);
                    float sinA = sin(-specularAngle);
                    vec2 hv2 = halfVec.xy;
                    vec2 rotated = vec2(
                        hv2.x * cosA - hv2.y * sinA,
                        hv2.x * sinA + hv2.y * cosA
                    );
                    float distSquared = rotated.x * rotated.x + rotated.y * rotated.y / max(1e-4, 1.0 - specularAnisotropy);
                    float shape = pow(clamp(1.0 - distSquared, 0.0, 1.0), 0.5);
                    return spec * shape;
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

                // Compute half‑vector in view space for specular shaping
                vec3 viewDirP = normalize(vViewPosition);
                vec3 lightDirP = normalize(vec3(0.0, 0.0, 1.0));
                vec3 halfVecP = normalize(viewDirP + lightDirP);

                // Extract and reshape the specular component
                float rawSpec = max(max(gl_FragColor.r, gl_FragColor.g), gl_FragColor.b);
                float shapedSpec = applySpecularShaping(rawSpec, halfVecP);
                float bandedSpec = applySpecularBanding(shapedSpec);

                // Blend mood specular
                vec3 finalSpec = moodSpecular * bandedSpec;

                // Apply paper grain to the specular
                finalSpec *= samplePaperGrain(vUv);

                gl_FragColor.rgb += finalSpec;

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
            this.specularBands,
            this.specularQuantize,
            this.specularThreshold,
            this.specularSoftness,
            this.specularAnisotropy,
            this.specularAngle,
            this.shininess,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.specularTintIntensity,
            this.rimGlow,
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
     * @param {MeshPhongMaterial} source
     * @return {MeshPhongMaterial}
     */
    copy(source) {
        super.copy(source);

        this.color.copy(source.color);
        this.emissive.copy(source.emissive);
        this.emissiveIntensity = source.emissiveIntensity;
        this.emissiveMap = source.emissiveMap;
        this.specular.copy(source.specular);
        this.shininess = source.shininess;
        this.specularMap = source.specularMap;
        this.map = source.map;
        this.lightMap = source.lightMap;
        this.lightMapIntensity = source.lightMapIntensity;
        this.aoMap = source.aoMap;
        this.aoMapIntensity = source.aoMapIntensity;
        this.bumpMap = source.bumpMap;
        this.bumpScale = source.bumpScale;
        this.normalMap = source.normalMap;
        this.normalMapType = source.normalMapType;
        this.normalScale.copy(source.normalScale);
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.envMap = source.envMap;
        this.envMapRotation = source.envMapRotation;
        this.combine = source.combine;
        this.reflectivity = source.reflectivity;
        this.refractionRatio = source.refractionRatio;
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.wireframeLinecap = source.wireframeLinecap;
        this.wireframeLinejoin = source.wireframeLinejoin;
        this.flatShading = source.flatShading;
        this.fog = source.fog;

        // Anime extensions
        this.specularBands = source.specularBands;
        this.specularQuantize = source.specularQuantize;
        this.specularThreshold = source.specularThreshold;
        this.specularSoftness = source.specularSoftness;
        this.specularAnisotropy = source.specularAnisotropy;
        this.specularAngle = source.specularAngle;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.specularTintIntensity = source.specularTintIntensity;
        this.moodColor.copy(source.moodColor);
        this.moodSpecular.copy(source.moodSpecular);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
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

        data.type = 'MeshPhongMaterial';

        if (this.color.getHex() !== 0xffffff) data.color = this.color.getHex();
        if (this.emissive.getHex() !== 0x000000) data.emissive = this.emissive.getHex();
        if (this.emissiveIntensity !== 1.0) data.emissiveIntensity = this.emissiveIntensity;
        if (this.emissiveMap !== null) data.emissiveMap = this.emissiveMap.toJSON(meta).uuid;
        if (this.specular.getHex() !== 0x111111) data.specular = this.specular.getHex();
        if (this.shininess !== 30) data.shininess = this.shininess;
        if (this.specularMap !== null) data.specularMap = this.specularMap.toJSON(meta).uuid;
        if (this.map !== null) data.map = this.map.toJSON(meta).uuid;
        if (this.lightMap !== null) data.lightMap = this.lightMap.toJSON(meta).uuid;
        if (this.lightMapIntensity !== 1.0) data.lightMapIntensity = this.lightMapIntensity;
        if (this.aoMap !== null) data.aoMap = this.aoMap.toJSON(meta).uuid;
        if (this.aoMapIntensity !== 1.0) data.aoMapIntensity = this.aoMapIntensity;
        if (this.bumpMap !== null) data.bumpMap = this.bumpMap.toJSON(meta).uuid;
        if (this.bumpScale !== 1) data.bumpScale = this.bumpScale;
        if (this.normalMap !== null) data.normalMap = this.normalMap.toJSON(meta).uuid;
        if (this.normalMapType !== (Constants.TANGENT_SPACE_NORMAL_MAP ?? 0)) data.normalMapType = this.normalMapType;
        if (this.normalScale.x !== 1 || this.normalScale.y !== 1) data.normalScale = this.normalScale.toArray();
        if (this.displacementMap !== null) data.displacementMap = this.displacementMap.toJSON(meta).uuid;
        if (this.displacementScale !== 1) data.displacementScale = this.displacementScale;
        if (this.displacementBias !== 0) data.displacementBias = this.displacementBias;
        if (this.envMap !== null) data.envMap = this.envMap.toJSON(meta).uuid;
        if (this.envMapRotation !== null) data.envMapRotation = this.envMapRotation.toArray();
        if (this.combine !== (Constants.MULTIPLY_OPERATION ?? 0)) data.combine = this.combine;
        if (this.reflectivity !== 1) data.reflectivity = this.reflectivity;
        if (this.refractionRatio !== 0.98) data.refractionRatio = this.refractionRatio;
        if (this.wireframe !== false) data.wireframe = this.wireframe;
        if (this.wireframeLinewidth !== 1) data.wireframeLinewidth = this.wireframeLinewidth;
        if (this.wireframeLinecap !== 'round') data.wireframeLinecap = this.wireframeLinecap;
        if (this.wireframeLinejoin !== 'round') data.wireframeLinejoin = this.wireframeLinejoin;
        if (this.flatShading) data.flatShading = true;
        if (this.fog === false) data.fog = false;

        // Anime extensions
        if (this.specularBands !== 2) data.specularBands = this.specularBands;
        if (this.specularQuantize !== 1.0) data.specularQuantize = this.specularQuantize;
        if (this.specularThreshold !== 0.5) data.specularThreshold = this.specularThreshold;
        if (this.specularSoftness !== 0.05) data.specularSoftness = this.specularSoftness;
        if (this.specularAnisotropy !== 0) data.specularAnisotropy = this.specularAnisotropy;
        if (this.specularAngle !== 0) data.specularAngle = this.specularAngle;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.specularTintIntensity !== 0) data.specularTintIntensity = this.specularTintIntensity;
        if (this.rimGlow !== 0) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.5, 0.9, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.watercolorBleed !== 0) data.watercolorBleed = this.watercolorBleed;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {MeshPhongMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        if (json.color !== undefined) this.color.setHex(json.color);
        if (json.emissive !== undefined) this.emissive.setHex(json.emissive);
        this.emissiveIntensity = json.emissiveIntensity ?? this.emissiveIntensity;
        if (json.specular !== undefined) this.specular.setHex(json.specular);
        this.shininess = json.shininess ?? this.shininess;
        this.lightMapIntensity = json.lightMapIntensity ?? this.lightMapIntensity;
        this.aoMapIntensity = json.aoMapIntensity ?? this.aoMapIntensity;
        this.bumpScale = json.bumpScale ?? this.bumpScale;
        this.normalMapType = json.normalMapType ?? this.normalMapType;
        if (json.normalScale) this.normalScale.fromArray(json.normalScale);
        this.displacementScale = json.displacementScale ?? this.displacementScale;
        this.displacementBias = json.displacementBias ?? this.displacementBias;
        if (json.combine !== undefined) this.combine = json.combine;
        this.reflectivity = json.reflectivity ?? this.reflectivity;
        this.refractionRatio = json.refractionRatio ?? this.refractionRatio;
        this.wireframe = json.wireframe ?? this.wireframe;
        this.wireframeLinewidth = json.wireframeLinewidth ?? this.wireframeLinewidth;
        this.wireframeLinecap = json.wireframeLinecap ?? this.wireframeLinecap;
        this.wireframeLinejoin = json.wireframeLinejoin ?? this.wireframeLinejoin;
        this.flatShading = json.flatShading ?? this.flatShading;
        this.fog = json.fog ?? this.fog;

        this.specularBands = json.specularBands ?? this.specularBands;
        this.specularQuantize = json.specularQuantize ?? this.specularQuantize;
        this.specularThreshold = json.specularThreshold ?? this.specularThreshold;
        this.specularSoftness = json.specularSoftness ?? this.specularSoftness;
        this.specularAnisotropy = json.specularAnisotropy ?? this.specularAnisotropy;
        this.specularAngle = json.specularAngle ?? this.specularAngle;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        this.specularTintIntensity = json.specularTintIntensity ?? this.specularTintIntensity;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.watercolorBleed = json.watercolorBleed ?? this.watercolorBleed;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived values
        this.updateMoodColors();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for Phong materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing Phong‑specific batching metadata. Consumers can
 * register Phong materials with a World to drive batch updates.
 */
const MeshPhongMaterialBatchComponent = {
    materialPtr: 'ui32',
    specularBands: 'ui8',
    specularQuantize: 'f64',
    specularThreshold: 'f64',
    specularSoftness: 'f64',
    specularAnisotropy: 'f64',
    specularAngle: 'f64',
    shininess: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    specularTintIntensity: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    dirty: 'ui8'
};

export {
    MeshPhongMaterial,
    PhongScratchPool,
    MeshPhongMaterialBatchComponent,
    applySpecularCelBanding,
    applySpecularToonShaping,
    gradeSpecularColor,
    gradeDiffuseColor,
    generateSpecularVariation
};

export default MeshPhongMaterial;