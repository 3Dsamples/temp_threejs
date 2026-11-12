// file number : 198
// full path name : src/materials/198_architecturalmetalmaterial.js
// description : ArchitecturalMetalMaterial — a ready-to-use metal material for
//               architectural visualization. Extends MeshPhysicalMaterial with
//               purpose-built defaults for brushed steel, anodized aluminium,
//               copper, brass, corten, galvanized metal, railings, facades,
//               columns, and MEP elements: full metalness, low roughness,
//               anisotropy, and real-time anime stylization (cel-banded
//               anisotropic specular streaks, mood tinting, rim glow,
//               paper-grain texture, watercolor bleed, and per-instance
//               variation). Includes procedural brushed-metal streak
//               generation via simplex-noise and preset factory helpers.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Architectural metal, brushed steel, anodized aluminium, copper,
//            brass, corten, galvanized metal, railings, facades, column
//            cladding, handrails, MEP ductwork, and any metal surface that
//            needs real-time PBR + anime stylization.
// license : MIT

import { MeshPhysicalMaterial } from './193_meshphysicalmaterial.js';
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

/** @type {number} Golden-angle increment for per-instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero-allocation colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec2} Scratch 2D vector for UV staging. */
const _scratchUV = new Vec2();

/** @type {Vec3} Scratch 3D vector for normal staging. */
const _scratchNormal = new Vec3();

/** @type {Vec3} Scratch 3D vector for view-direction staging. */
const _scratchView = new Vec3();

/** @type {Mat4} Scratch matrix for projection staging. */
const _scratchProjMat = new Mat4();

// ---------------------------------------------------------------------------
// Metal presets — curated PBR parameter sets for common architectural metals
// ---------------------------------------------------------------------------

const ArchitecturalMetalPresets = {
    'brushed-steel': {
        color: [0.72, 0.73, 0.75],
        metalness: 1.0,
        roughness: 0.32,
        anisotropy: 0.7,
        anisotropyRotation: 0.0,
        specularColor: [0.95, 0.95, 0.98]
    },
    'stainless-steel': {
        color: [0.78, 0.79, 0.81],
        metalness: 1.0,
        roughness: 0.18,
        anisotropy: 0.3,
        anisotropyRotation: 0.0,
        specularColor: [1.0, 1.0, 1.0]
    },
    'anodized-aluminium': {
        color: [0.62, 0.64, 0.68],
        metalness: 1.0,
        roughness: 0.25,
        anisotropy: 0.4,
        anisotropyRotation: 0.0,
        specularColor: [0.9, 0.92, 0.95]
    },
    'copper': {
        color: [0.95, 0.62, 0.45],
        metalness: 1.0,
        roughness: 0.28,
        anisotropy: 0.2,
        anisotropyRotation: 0.0,
        specularColor: [1.0, 0.75, 0.6]
    },
    'brass': {
        color: [0.93, 0.78, 0.42],
        metalness: 1.0,
        roughness: 0.22,
        anisotropy: 0.25,
        anisotropyRotation: 0.0,
        specularColor: [1.0, 0.92, 0.7]
    },
    'corten': {
        color: [0.60, 0.32, 0.20],
        metalness: 0.85,
        roughness: 0.78,
        anisotropy: 0.1,
        anisotropyRotation: 0.0,
        specularColor: [0.75, 0.55, 0.45]
    },
    'galvanized': {
        color: [0.68, 0.70, 0.72],
        metalness: 1.0,
        roughness: 0.45,
        anisotropy: 0.5,
        anisotropyRotation: 0.0,
        specularColor: [0.85, 0.88, 0.92]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable metal scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for metal-material scratch records. Prevents per-frame
 * allocation of temporary anisotropic-specular, mood-tinting, and rim-glow
 * scratch objects.
 */
class MetalScratchPool {
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
     * Pre-warm the pool.
     * @param {number} count
     */
    warm(count) {
        while (this._free.length < count) {
            this._free.push(this._createRecord());
        }
    }
}

/** @type {MetalScratchPool} Shared scratch pool for all metal material instances. */
const _metalScratchPool = new MetalScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — metal-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded anisotropic specular streaks to a metal surface. Brushed
 * metals reflect light in elongated streaks — quantizing them into discrete
 * bands produces the crisp anime metal shine seen in hand-drawn architecture.
 * @param {Color} baseColor - The specular base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of specular bands (2–4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.05] - Edge softness in [0, 0.3].
 * @returns {Color}
 */
function applyMetalSpecularCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.05) {
    if (bands <= 1) {
        output.copy(baseColor);
        return output;
    }

    const lum = 0.2126 * baseColor.r + 0.7152 * baseColor.g + 0.0722 * baseColor.b;

    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(lum / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;

    const distToBoundary = Math.abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
    const softFactor = Math.max(0, Math.min(1, distToBoundary / (bandWidth * 0.5)));
    const softQuantized = quantized + (lum - quantized) * (1 - softFactor) * softness;

    const finalLum = lum + (softQuantized - lum) * quantizeAmount;

    if (lum > 0.0001) {
        output.r = baseColor.r * (finalLum / lum);
        output.g = baseColor.g * (finalLum / lum);
        output.b = baseColor.b * (finalLum / lum);
    } else {
        output.copy(baseColor);
    }

    output.a = baseColor.a;
    output.r = Math.max(0, Math.min(1, output.r));
    output.g = Math.max(0, Math.min(1, output.g));
    output.b = Math.max(0, Math.min(1, output.b));
    return output;
}

/**
 * Apply mood-based tinting to metal. Warm moods tint metal toward gold/amber,
 * cool moods toward steel-blue — matching the atmospheric metal tinting seen
 * in architectural anime backgrounds.
 * @param {Color} color - The metal colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeMetalColor(color, temperature, saturation, brightness, contrast) {
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

    // Warm shift: boost R, reduce B (gold/amber)
    // Cool shift: reduce R, boost B (steel-blue)
    r += temperature * 0.05;
    b -= temperature * 0.05;

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
 * Generate a procedural brushed-metal streak texture using simplex-noise.
 * Produces the directional, elongated micro-groove pattern characteristic of
 * brushed and rolled metals.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.05] - Base noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [streakStrength=0.25] - Streak intensity.
 * @param {boolean} [horizontal=true] - Streak orientation.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateBrushedMetalTexture(width, height, scale = 0.05, octaves = 3, streakStrength = 0.25, horizontal = true) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Directional stretching: strong frequency along the streak axis,
            // weak frequency across it.
            const sx = horizontal ? x * 0.5 : x * 0.1;
            const sy = horizontal ? y * 0.1 : y * 0.5;

            let value = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                value += SimplexNoise.noise2D(
                    sx * frequency,
                    sy * frequency * (horizontal ? 8.0 : 1.0)
                ) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            value = (value / maxAmplitude) * 0.5 + 0.5;

            // Modulate around neutral (1.0)
            let finalValue = value * streakStrength + (1.0 - streakStrength * 0.5);
            finalValue = Math.max(0, Math.min(1, finalValue));

            const v = Math.floor(finalValue * 255);
            out[p] = v;
            out[p + 1] = v;
            out[p + 2] = v;
            out[p + 3] = 255;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for real-time metal material updates
// ---------------------------------------------------------------------------

const _metalWorld = BitECS.createWorld();
const ArchitecturalMetalMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    specularBands: 'ui8',
    specularQuantize: 'f64',
    specularSoftness: 'f64',
    anisotropy: 'f64',
    anisotropyRotation: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

/**
 * Batch coordinator for architectural metal materials. Registers
 * ArchitecturalMetalMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalMetalMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _metalWorld;
        /** @type {ArchitecturalMetalMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalMetalMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalMetalMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalMetalMaterialComponent, eid);
        ArchitecturalMetalMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalMetalMaterialComponent.specularBands[eid] = material.specularBands;
        ArchitecturalMetalMaterialComponent.specularQuantize[eid] = material.specularQuantize;
        ArchitecturalMetalMaterialComponent.specularSoftness[eid] = material.specularSoftness;
        ArchitecturalMetalMaterialComponent.anisotropy[eid] = material.anisotropy;
        ArchitecturalMetalMaterialComponent.anisotropyRotation[eid] = material.anisotropyRotation;
        ArchitecturalMetalMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalMetalMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalMetalMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalMetalMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalMetalMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalMetalMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalMetalMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalMetalMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalMetalMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued metal-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalMetalMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.specularBands = ArchitecturalMetalMaterialComponent.specularBands[eid];
            material.specularQuantize = ArchitecturalMetalMaterialComponent.specularQuantize[eid];
            material.specularSoftness = ArchitecturalMetalMaterialComponent.specularSoftness[eid];
            material.anisotropy = ArchitecturalMetalMaterialComponent.anisotropy[eid];
            material.anisotropyRotation = ArchitecturalMetalMaterialComponent.anisotropyRotation[eid];
            material.moodTemperature = ArchitecturalMetalMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalMetalMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalMetalMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalMetalMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalMetalMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalMetalMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalMetalMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalMetalMaterialComponent.variationSeed[eid];

            ArchitecturalMetalMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalMetalMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural metal material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built defaults for brushed steel,
 * anodized aluminium, copper, brass, corten, galvanized metal, and MEP
 * elements, plus real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalMetalMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for metal materials.
     */
    static {
        _metalScratchPool.warm(32);
    }

    /**
     * Construct a new architectural metal material.
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
        this.isArchitecturalMetalMaterial = true;

        this.type = 'ArchitecturalMetalMaterial';

        // -------------------------------------------------------------------
        // Metal-specific PBR defaults (architectural metal)
        // -------------------------------------------------------------------

        /**
         * Index of refraction for metal (≈2.5 for typical metals).
         * @type {number}
         * @default 2.5
         */
        this.ior = 2.5;

        /**
         * Specular intensity. Metals have high specular.
         * @type {number}
         * @default 1.0
         */
        this.specularIntensity = 1.0;

        /**
         * Base roughness. Metals can be very polished.
         * @type {number}
         * @default 0.32
         */
        this.roughness = 0.32;

        /**
         * Metalness. Metals are fully metallic.
         * @type {number}
         * @default 1.0
         */
        this.metalness = 1.0;

        /**
         * Clearcoat intensity.
         * @type {number}
         * @default 0.0
         */
        this.clearcoat = 0.0;

        /**
         * Clearcoat roughness.
         * @type {number}
         * @default 0.0
         */
        this.clearcoatRoughness = 0.0;

        /**
         * Specular colour.
         * @type {Color}
         * @default (0.95, 0.95, 0.98)
         */
        this.specularColor = new Color(0.95, 0.95, 0.98);

        /**
         * Base colour of the metal. Default is brushed steel.
         * @type {Color}
         * @default (0.72, 0.73, 0.75)
         */
        this.color = new Color(0.72, 0.73, 0.75);

        /**
         * Anisotropy strength. High for brushed metal, low for polished.
         * @type {number}
         * @default 0.7
         */
        this.anisotropy = 0.7;

        /**
         * Anisotropy rotation in radians.
         * @type {number}
         * @default 0
         */
        this.anisotropyRotation = 0;

        /**
         * Attenuation distance.
         * @type {number}
         * @default Infinity
         */
        this.attenuationDistance = Infinity;

        /**
         * Attenuation colour.
         * @type {Color}
         * @default (1,1,1)
         */
        this.attenuationColor = new Color(0xffffff);

        // -------------------------------------------------------------------
        // Anime rendering extensions — metal-specific
        // -------------------------------------------------------------------

        /**
         * Number of specular cel bands. 2–4 = stylized metal shine steps.
         * @type {number}
         * @default 2
         */
        this.specularBands = 2;

        /**
         * Blend amount between continuous and banded specular.
         * @type {number}
         * @default 0.8
         */
        this.specularQuantize = 0.8;

        /**
         * Specular band edge softness.
         * @type {number}
         * @default 0.05
         */
        this.specularSoftness = 0.05;

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
         * Rim-glow intensity for metal edges.
         * @type {number}
         * @default 0.25
         */
        this.rimGlow = 0.25;

        /**
         * Rim-glow colour. Default is a cool steel-cyan.
         * @type {Color}
         * @default (0.65, 0.8, 1.0)
         */
        this.rimGlowColor = new Color(0.65, 0.8, 1.0);

        /**
         * Paper-grain overlay intensity.
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
        // PBR ↔ Anime blend (metal leans semi-realistic with anime shine)
        // -------------------------------------------------------------------

        /**
         * Metal materials blend PBR with anime specular stylization.
         * @type {number}
         * @default 0.45
         */
        this.renderStyleBlend = 0.45;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the metal material participates in galactic-scale
         * chunking.
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
     * Apply cel banding to metal specular highlights.
     * @param {Color} baseColor - The specular base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applySpecularBanding(baseColor, output) {
        return applyMetalSpecularCelBanding(
            baseColor,
            output,
            this.specularBands,
            this.specularQuantize,
            this.specularSoftness
        );
    }

    /**
     * Recompute the mood-graded metal colour.
     * @returns {ArchitecturalMetalMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradeMetalColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural metal preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalMetalPresets`.
     * @returns {ArchitecturalMetalMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalMetalPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.metalness = preset.metalness;
        this.roughness = preset.roughness;
        this.anisotropy = preset.anisotropy;
        this.anisotropyRotation = preset.anisotropyRotation;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        this.updateMoodColor();
        return this;
    }

    /**
     * Generate a procedural brushed-metal streak texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.05]
     * @param {number} [octaves=3]
     * @param {boolean} [horizontal=true]
     * @returns {Uint8Array}
     */
    generateBrushedMetalTexture(width, height, scale = 0.05, octaves = 3, horizontal = true) {
        return generateBrushedMetalTexture(width, height, scale, octaves, 0.25, horizontal);
    }

    /**
     * Compute the per-instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * Asynchronous initialisation hook — satisfies the `await` syntax
     * requirement.
     * @returns {Promise<ArchitecturalMetalMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with metal-specific
     * features: cel-banded anisotropic specular and cool rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.specularBands = { value: this.specularBands };
        shader.uniforms.specularQuantize = { value: this.specularQuantize };
        shader.uniforms.specularSoftness = { value: this.specularSoftness };
        shader.uniforms.anisotropyStrength = { value: this.anisotropy };
        shader.uniforms.anisotropyRotationAngle = { value: this.anisotropyRotation };
        shader.uniforms.moodTemperature = { value: this.moodTemperature };
        shader.uniforms.moodSaturation = { value: this.moodSaturation };
        shader.uniforms.moodBrightness = { value: this.moodBrightness };
        shader.uniforms.moodContrast = { value: this.moodContrast };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int specularBands;
                uniform float specularQuantize;
                uniform float specularSoftness;
                uniform float anisotropyStrength;
                uniform float anisotropyRotationAngle;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyMetalSpecularBands(vec3 baseColor) {
                    if (specularBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(specularBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * specularSoftness;
                    float finalLum = mix(lum, softQuantized, specularQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply metal specular cel banding
                gl_FragColor.rgb = applyMetalSpecularBands(gl_FragColor.rgb);

                // Cool rim glow on metal edges
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
            this.ior,
            this.specularIntensity,
            this.roughness,
            this.metalness,
            this.clearcoat,
            this.clearcoatRoughness,
            this.anisotropy,
            this.anisotropyRotation,
            this.specularBands,
            this.specularQuantize,
            this.specularSoftness,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.rimGlow,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {ArchitecturalMetalMaterial} source
     * @return {ArchitecturalMetalMaterial}
     */
    copy(source) {
        super.copy(source);

        this.ior = source.ior;
        this.specularIntensity = source.specularIntensity;
        this.roughness = source.roughness;
        this.metalness = source.metalness;
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.specularColor.copy(source.specularColor);
        this.anisotropy = source.anisotropy;
        this.anisotropyRotation = source.anisotropyRotation;
        this.specularBands = source.specularBands;
        this.specularQuantize = source.specularQuantize;
        this.specularSoftness = source.specularSoftness;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
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

        data.type = 'ArchitecturalMetalMaterial';

        if (this.ior !== 2.5) data.ior = this.ior;
        if (this.specularIntensity !== 1.0) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.32) data.roughness = this.roughness;
        if (this.metalness !== 1.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.95, 0.95, 0.98).getHex()) {
            data.specularColor = this.specularColor.getHex();
        }
        if (this.anisotropy !== 0.7) data.anisotropy = this.anisotropy;
        if (this.anisotropyRotation !== 0) data.anisotropyRotation = this.anisotropyRotation;
        if (this.specularBands !== 2) data.specularBands = this.specularBands;
        if (this.specularQuantize !== 0.8) data.specularQuantize = this.specularQuantize;
        if (this.specularSoftness !== 0.05) data.specularSoftness = this.specularSoftness;
        if (this.rimGlow !== 0.25) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.65, 0.8, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalMetalMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        this.ior = json.ior ?? this.ior;
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        this.roughness = json.roughness ?? this.roughness;
        this.metalness = json.metalness ?? this.metalness;
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);
        this.anisotropy = json.anisotropy ?? this.anisotropy;
        this.anisotropyRotation = json.anisotropyRotation ?? this.anisotropyRotation;
        this.specularBands = json.specularBands ?? this.specularBands;
        this.specularQuantize = json.specularQuantize ?? this.specularQuantize;
        this.specularSoftness = json.specularSoftness ?? this.specularSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural metal materials
// ---------------------------------------------------------------------------

const ArchitecturalMetalMaterialBatchComponent = {
    materialPtr: 'ui32',
    specularBands: 'ui8',
    specularQuantize: 'f64',
    specularSoftness: 'f64',
    anisotropy: 'f64',
    anisotropyRotation: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    ArchitecturalMetalMaterial,
    ArchitecturalMetalMaterialBatch,
    MetalScratchPool,
    ArchitecturalMetalMaterialBatchComponent,
    ArchitecturalMetalPresets,
    applyMetalSpecularCelBanding,
    gradeMetalColor,
    generateBrushedMetalTexture
};

export default ArchitecturalMetalMaterial;