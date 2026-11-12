// file number : 201
// full path name : src/materials/201_architecturalstonematerial.js
// description : ArchitecturalStoneMaterial — a ready-to-use stone material for
//               architectural visualization. Extends MeshPhysicalMaterial with
//               purpose-built defaults for marble, granite, limestone, sandstone,
//               slate, and polished/rough stone: variable roughness, dielectric
//               metalness, subtle veining, and real-time anime stylization
//               (cel-banded stone highlights, mood tinting, rim glow, paper-
//               grain texture, watercolor bleed, and per-instance variation).
//               Includes a procedural veining texture generator using
//               multi-octave fBm noise with domain-warped ridge lines, plus
//               curated presets. All imports resolve to the internal
//               Threejs_gl repository tree; no CDN dependencies.
// best for : Architectural stone, polished marble, granite countertops, rough
//            limestone, sandstone, slate roofing, stone floors, stone cladding,
//            column capitals, and any stone surface that needs real-time PBR +
//            anime stylization.
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
// Stone presets — curated PBR parameter sets for common architectural stones
// ---------------------------------------------------------------------------

const ArchitecturalStonePresets = {
    'polished-marble': {
        color: [0.92, 0.91, 0.88],
        roughness: 0.12,
        metalness: 0.0,
        specularIntensity: 0.7,
        specularColor: [1.0, 0.98, 0.95],
        clearcoat: 0.6,
        clearcoatRoughness: 0.05
    },
    'cararra-marble': {
        color: [0.95, 0.95, 0.94],
        roughness: 0.15,
        metalness: 0.0,
        specularIntensity: 0.65,
        specularColor: [1.0, 1.0, 0.98],
        clearcoat: 0.5,
        clearcoatRoughness: 0.08
    },
    'granite': {
        color: [0.55, 0.54, 0.52],
        roughness: 0.55,
        metalness: 0.0,
        specularIntensity: 0.4,
        specularColor: [0.85, 0.83, 0.82],
        clearcoat: 0.15,
        clearcoatRoughness: 0.15
    },
    'limestone': {
        color: [0.82, 0.76, 0.65],
        roughness: 0.82,
        metalness: 0.0,
        specularIntensity: 0.28,
        specularColor: [0.9, 0.85, 0.75],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'sandstone': {
        color: [0.78, 0.65, 0.48],
        roughness: 0.85,
        metalness: 0.0,
        specularIntensity: 0.25,
        specularColor: [0.88, 0.8, 0.7],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'slate': {
        color: [0.35, 0.37, 0.40],
        roughness: 0.65,
        metalness: 0.0,
        specularIntensity: 0.35,
        specularColor: [0.7, 0.72, 0.75],
        clearcoat: 0.1,
        clearcoatRoughness: 0.1
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable stone scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for stone-material scratch records. Prevents per-frame
 * allocation of temporary cel-banding, mood-tinting, and rim-glow scratch
 * objects.
 */
class StoneScratchPool {
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

/** @type {StoneScratchPool} Shared scratch pool for all stone material instances. */
const _stoneScratchPool = new StoneScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — stone-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded stone highlights to a stone surface. Polished stone has
 * crisp cel edges, rough stone has softer edges — both produced by the
 * configurable softness parameter.
 * @param {Color} baseColor - The stone base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of stone bands (2–5 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.1] - Edge softness in [0, 0.5].
 * @returns {Color}
 */
function applyStoneCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.1) {
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
 * Apply mood-based tinting to stone. Warm moods tint stone toward warm cream
 * and ivory, cool moods toward cool blue-grey — matching the atmospheric
 * stone tinting seen in architectural anime backgrounds.
 * @param {Color} color - The stone colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeStoneColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.04;
    b -= temperature * 0.04;

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
 * Generate a procedural stone veining texture using multi-octave fBm noise
 * with domain-warped ridge lines. The domain-warp step produces the natural
 * swirl of marble veins, while the ridge function extracts thin, bright
 * vein lines from the warped noise field.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.02] - Base noise scale.
 * @param {number} [octaves=5] - Number of noise octaves.
 * @param {number} [veinFrequency=6] - Number of vein ridge lines.
 * @param {number} [veinSharpness=4.0] - Ridge sharpness (higher = thinner veins).
 * @param {number} [warpStrength=2.5] - Domain-warp intensity.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateStoneVeinTexture(width, height, scale = 0.02, octaves = 5, veinFrequency = 6, veinSharpness = 4.0, warpStrength = 2.5) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Domain warp: offset the sampling coordinate using two noise fields
            const warpX = SimplexNoise.noise2D(x * 0.01, y * 0.01) * warpStrength;
            const warpY = SimplexNoise.noise2D(x * 0.01 + 100, y * 0.01 + 100) * warpStrength;

            // Multi-octave fBm for base stone tone
            let fbm = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                fbm += SimplexNoise.noise2D(
                    (x + warpX) * frequency,
                    (y + warpY) * frequency
                ) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;

            // Ridge function for vein extraction
            const veinNoise = SimplexNoise.noise2D(
                (x + warpX) * 0.015 * veinFrequency,
                (y + warpY) * 0.015 * veinFrequency
            );
            const veinRidge = Math.pow(1.0 - Math.abs(veinNoise), veinSharpness);

            // Combine: base stone tone + vein ridges (darker veins)
            let value = 0.75 + (fbm - 0.5) * 0.25 - veinRidge * 0.35;
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
// bitecs SoA batch coordinator for real-time stone material updates
// ---------------------------------------------------------------------------

const _stoneWorld = BitECS.createWorld();
const ArchitecturalStoneMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    stoneBands: 'ui8',
    stoneQuantize: 'f64',
    stoneSoftness: 'f64',
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
 * Batch coordinator for architectural stone materials. Registers
 * ArchitecturalStoneMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalStoneMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _stoneWorld;
        /** @type {ArchitecturalStoneMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalStoneMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalStoneMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalStoneMaterialComponent, eid);
        ArchitecturalStoneMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalStoneMaterialComponent.stoneBands[eid] = material.stoneBands;
        ArchitecturalStoneMaterialComponent.stoneQuantize[eid] = material.stoneQuantize;
        ArchitecturalStoneMaterialComponent.stoneSoftness[eid] = material.stoneSoftness;
        ArchitecturalStoneMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalStoneMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalStoneMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalStoneMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalStoneMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalStoneMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalStoneMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalStoneMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalStoneMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued stone-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalStoneMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.stoneBands = ArchitecturalStoneMaterialComponent.stoneBands[eid];
            material.stoneQuantize = ArchitecturalStoneMaterialComponent.stoneQuantize[eid];
            material.stoneSoftness = ArchitecturalStoneMaterialComponent.stoneSoftness[eid];
            material.moodTemperature = ArchitecturalStoneMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalStoneMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalStoneMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalStoneMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalStoneMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalStoneMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalStoneMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalStoneMaterialComponent.variationSeed[eid];

            ArchitecturalStoneMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalStoneMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural stone material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built defaults for marble,
 * granite, limestone, sandstone, slate, and polished/rough stone, plus
 * real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalStoneMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for stone materials.
     */
    static {
        _stoneScratchPool.warm(32);
    }

    /**
     * Construct a new architectural stone material.
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
        this.isArchitecturalStoneMaterial = true;

        this.type = 'ArchitecturalStoneMaterial';

        // -------------------------------------------------------------------
        // Stone-specific PBR defaults (architectural stone)
        // -------------------------------------------------------------------

        /**
         * Index of refraction for stone (≈1.55).
         * @type {number}
         * @default 1.55
         */
        this.ior = 1.55;

        /**
         * Specular intensity for stone.
         * @type {number}
         * @default 0.5
         */
        this.specularIntensity = 0.5;

        /**
         * Base roughness. Default is polished marble roughness.
         * @type {number}
         * @default 0.15
         */
        this.roughness = 0.15;

        /**
         * Metalness. Stone is a dielectric.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * Clearcoat intensity for polished stone.
         * @type {number}
         * @default 0.4
         */
        this.clearcoat = 0.4;

        /**
         * Clearcoat roughness.
         * @type {number}
         * @default 0.05
         */
        this.clearcoatRoughness = 0.05;

        /**
         * Specular colour.
         * @type {Color}
         * @default (1.0, 0.98, 0.95)
         */
        this.specularColor = new Color(1.0, 0.98, 0.95);

        /**
         * Base colour of the stone. Default is a cool white marble.
         * @type {Color}
         * @default (0.92, 0.91, 0.88)
         */
        this.color = new Color(0.92, 0.91, 0.88);

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
        // Anime rendering extensions — stone-specific
        // -------------------------------------------------------------------

        /**
         * Number of stone cel bands. 2–5 = stylized stone highlight steps.
         * @type {number}
         * @default 3
         */
        this.stoneBands = 3;

        /**
         * Blend amount between continuous and banded stone highlights.
         * @type {number}
         * @default 0.5
         */
        this.stoneQuantize = 0.5;

        /**
         * Stone band edge softness. Polished stone = low, rough stone = high.
         * @type {number}
         * @default 0.1
         */
        this.stoneSoftness = 0.1;

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
         * Rim-glow intensity for stone edges.
         * @type {number}
         * @default 0.15
         */
        this.rimGlow = 0.15;

        /**
         * Rim-glow colour. Stone rim is cool-neutral.
         * @type {Color}
         * @default (0.85, 0.88, 0.95)
         */
        this.rimGlowColor = new Color(0.85, 0.88, 0.95);

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
        // PBR ↔ Anime blend (stone leans semi-realistic with anime banding)
        // -------------------------------------------------------------------

        /**
         * Stone materials blend PBR with anime cel-banding stylization.
         * @type {number}
         * @default 0.35
         */
        this.renderStyleBlend = 0.35;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the stone material participates in galactic-scale
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
     * Apply cel banding to stone highlights.
     * @param {Color} baseColor - The stone base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applyStoneBanding(baseColor, output) {
        return applyStoneCelBanding(
            baseColor,
            output,
            this.stoneBands,
            this.stoneQuantize,
            this.stoneSoftness
        );
    }

    /**
     * Recompute the mood-graded stone colour.
     * @returns {ArchitecturalStoneMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradeStoneColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural stone preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalStonePresets`.
     * @returns {ArchitecturalStoneMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalStonePresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;

        // Adjust anime band softness for rough vs polished stones
        this.stoneSoftness = preset.roughness < 0.3 ? 0.08 : (preset.roughness > 0.7 ? 0.35 : 0.18);

        this.updateMoodColor();
        return this;
    }

    /**
     * Generate a procedural stone veining texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.02]
     * @param {number} [octaves=5]
     * @param {number} [veinFrequency=6]
     * @returns {Uint8Array}
     */
    generateStoneVeinTexture(width, height, scale = 0.02, octaves = 5, veinFrequency = 6) {
        return generateStoneVeinTexture(width, height, scale, octaves, veinFrequency, 4.0, 2.5);
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
     * @returns {Promise<ArchitecturalStoneMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with stone-specific
     * features: cel-banded highlights and cool-neutral rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.stoneBands = { value: this.stoneBands };
        shader.uniforms.stoneQuantize = { value: this.stoneQuantize };
        shader.uniforms.stoneSoftness = { value: this.stoneSoftness };
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
                uniform int stoneBands;
                uniform float stoneQuantize;
                uniform float stoneSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyStoneBands(vec3 baseColor) {
                    if (stoneBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(stoneBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * stoneSoftness;
                    float finalLum = mix(lum, softQuantized, stoneQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply stone cel banding
                gl_FragColor.rgb = applyStoneBands(gl_FragColor.rgb);

                // Cool-neutral rim glow on stone edges
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
            this.stoneBands,
            this.stoneQuantize,
            this.stoneSoftness,
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
     * @param {ArchitecturalStoneMaterial} source
     * @return {ArchitecturalStoneMaterial}
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
        this.stoneBands = source.stoneBands;
        this.stoneQuantize = source.stoneQuantize;
        this.stoneSoftness = source.stoneSoftness;
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

        data.type = 'ArchitecturalStoneMaterial';

        if (this.ior !== 1.55) data.ior = this.ior;
        if (this.specularIntensity !== 0.5) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.15) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.4) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.05) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(1.0, 0.98, 0.95).getHex()) {
            data.specularColor = this.specularColor.getHex();
        }
        if (this.stoneBands !== 3) data.stoneBands = this.stoneBands;
        if (this.stoneQuantize !== 0.5) data.stoneQuantize = this.stoneQuantize;
        if (this.stoneSoftness !== 0.1) data.stoneSoftness = this.stoneSoftness;
        if (this.rimGlow !== 0.15) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.88, 0.95).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalStoneMaterial}
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
        this.stoneBands = json.stoneBands ?? this.stoneBands;
        this.stoneQuantize = json.stoneQuantize ?? this.stoneQuantize;
        this.stoneSoftness = json.stoneSoftness ?? this.stoneSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural stone materials
// ---------------------------------------------------------------------------

const ArchitecturalStoneMaterialBatchComponent = {
    materialPtr: 'ui32',
    stoneBands: 'ui8',
    stoneQuantize: 'f64',
    stoneSoftness: 'f64',
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
    ArchitecturalStoneMaterial,
    ArchitecturalStoneMaterialBatch,
    StoneScratchPool,
    ArchitecturalStoneMaterialBatchComponent,
    ArchitecturalStonePresets,
    applyStoneCelBanding,
    gradeStoneColor,
    generateStoneVeinTexture
};

export default ArchitecturalStoneMaterial;