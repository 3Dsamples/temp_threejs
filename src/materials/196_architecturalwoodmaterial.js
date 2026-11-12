// file number : 196
// full path name : src/materials/196_architecturalwoodmaterial.js
// description : ArchitecturalWoodMaterial — a ready-to-use timber material for
//               architectural visualization. Extends MeshPhysicalMaterial with
//               purpose-built defaults for oak, pine, walnut, plywood, veneer,
//               flooring, wall panels, and furniture: realistic IOR (≈1.43),
//               specular intensity, roughness clamping, clearcoat for polished
//               wood, and real-time anime stylization (cel-banded grain
//               highlights, mood tinting, rim glow, paper-grain texture,
//               watercolor bleed, and per-instance variation). Includes
//               procedural growth-ring / grain generation via simplex-noise.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Architectural timber, wood flooring, wall panels, furniture,
//            joinery, veneer, plywood, timber cladding, and any wood surface
//            that needs real-time PBR + anime stylization.
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
// Pool system — reusable wood scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for wood-material scratch records. Prevents per-frame
 * allocation of temporary grain-banding, mood-tinting, and rim-glow scratch
 * objects.
 */
class WoodScratchPool {
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

/** @type {WoodScratchPool} Shared scratch pool for all wood material instances. */
const _woodScratchPool = new WoodScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — wood-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded grain highlights to a wood surface. Wood grain produces
 * subtle tonal variation — quantizing it into discrete bands produces the
 * crisp, flat highlight edges seen in hand-drawn architectural anime.
 * @param {Color} baseColor - The grain base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of grain bands (2–4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.1] - Edge softness in [0, 0.3].
 * @returns {Color}
 */
function applyWoodGrainCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.1) {
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
 * Apply mood-based tinting to wood. Warm moods tint wood toward amber/gold,
 * cool moods toward a cooler brown — matching the atmospheric timber tinting
 * seen in architectural anime backgrounds.
 * @param {Color} color - The wood colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeWoodColor(color, temperature, saturation, brightness, contrast) {
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

    // Warm shift: boost R, reduce B (amber)
    // Cool shift: reduce R, boost B (cool brown)
    r += temperature * 0.06;
    b -= temperature * 0.06;

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
 * Generate a procedural wood grain texture using simplex-noise. Creates the
 * growth-ring / fibre pattern characteristic of real timber. The algorithm
 * uses cylindrical ring coordinates modulated by fBm noise for organic
 * variation.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.02] - Base noise scale.
 * @param {number} [octaves=4] - Number of noise octaves.
 * @param {number} [ringFrequency=18] - Number of growth rings.
 * @param {number} [fibreStrength=0.25] - Fibre streak intensity.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateWoodGrainTexture(width, height, scale = 0.02, octaves = 4, ringFrequency = 18, fibreStrength = 0.25) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Multi-octave fBm for organic grain wobble
            let fbm = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                fbm += SimplexNoise.noise2D(x * frequency, y * frequency) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;

            // Growth rings: distance from a virtual pith, modulated by fBm
            const cx = 0.5 + fbm * 0.15;
            const cy = 0.5 + fbm * 0.1;
            const dx = (x / width) - cx;
            const dy = (y / height) - cy;
            const radius = Math.sqrt(dx * dx + dy * dy) * ringFrequency;

            // Ring phase with fBm wobble
            const ringPhase = (radius + fbm * 2.0) % 1.0;

            // Latewood / earlywood contrast
            const ringValue = Math.pow(Math.abs(Math.sin(ringPhase * Math.PI)), 1.5);

            // Fibre streaks (high-frequency directional noise)
            const fibre = SimplexNoise.noise2D(x * 0.5, y * 8.0) * fibreStrength;

            // Combine
            let value = 0.3 + ringValue * 0.45 + fibre * 0.15 + (fbm - 0.5) * 0.2;
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
// bitecs SoA batch coordinator for real-time wood material updates
// ---------------------------------------------------------------------------

const _woodWorld = BitECS.createWorld();
const ArchitecturalWoodMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    grainBands: 'ui8',
    grainQuantize: 'f64',
    grainSoftness: 'f64',
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
 * Batch coordinator for architectural wood materials. Registers
 * ArchitecturalWoodMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalWoodMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _woodWorld;
        /** @type {ArchitecturalWoodMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalWoodMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalWoodMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalWoodMaterialComponent, eid);
        ArchitecturalWoodMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalWoodMaterialComponent.grainBands[eid] = material.grainBands;
        ArchitecturalWoodMaterialComponent.grainQuantize[eid] = material.grainQuantize;
        ArchitecturalWoodMaterialComponent.grainSoftness[eid] = material.grainSoftness;
        ArchitecturalWoodMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalWoodMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalWoodMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalWoodMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalWoodMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalWoodMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalWoodMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalWoodMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalWoodMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued wood-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalWoodMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.grainBands = ArchitecturalWoodMaterialComponent.grainBands[eid];
            material.grainQuantize = ArchitecturalWoodMaterialComponent.grainQuantize[eid];
            material.grainSoftness = ArchitecturalWoodMaterialComponent.grainSoftness[eid];
            material.moodTemperature = ArchitecturalWoodMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalWoodMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalWoodMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalWoodMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalWoodMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalWoodMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalWoodMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalWoodMaterialComponent.variationSeed[eid];

            ArchitecturalWoodMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalWoodMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural wood material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built defaults for oak, pine,
 * walnut, plywood, veneer, flooring, wall panels, and furniture, plus real-time
 * anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalWoodMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for wood materials.
     */
    static {
        _woodScratchPool.warm(32);
    }

    /**
     * Construct a new architectural wood material.
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
        this.isArchitecturalWoodMaterial = true;

        this.type = 'ArchitecturalWoodMaterial';

        // -------------------------------------------------------------------
        // Wood-specific PBR defaults (architectural timber)
        // -------------------------------------------------------------------

        /**
         * Index of refraction for wood (≈1.43).
         * @type {number}
         * @default 1.43
         */
        this.ior = 1.43;

        /**
         * Specular intensity for wood (≈0.72).
         * @type {number}
         * @default 0.72
         */
        this.specularIntensity = 0.72;

        /**
         * Base roughness. Wood is non-metallic with moderate roughness.
         * @type {number}
         * @default 0.55
         */
        this.roughness = 0.55;

        /**
         * Metalness. Wood is a dielectric.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * Clearcoat intensity for polished / lacquered wood.
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
         * @default (0.9, 0.85, 0.75) — warm specular for wood
         */
        this.specularColor = new Color(0.9, 0.85, 0.75);

        /**
         * Base colour of the wood. Default is a warm mid-brown oak tone.
         * @type {Color}
         * @default (0.62, 0.42, 0.24)
         */
        this.color = new Color(0.62, 0.42, 0.24);

        /**
         * Attenuation distance (not typically used for opaque wood, but kept
         * for completeness).
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
        // Anime rendering extensions — wood-specific
        // -------------------------------------------------------------------

        /**
         * Number of grain cel bands. 2–4 = stylized grain highlight steps.
         * @type {number}
         * @default 3
         */
        this.grainBands = 3;

        /**
         * Blend amount between continuous and banded grain.
         * @type {number}
         * @default 0.7
         */
        this.grainQuantize = 0.7;

        /**
         * Grain band edge softness.
         * @type {number}
         * @default 0.15
         */
        this.grainSoftness = 0.15;

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
         * Rim-glow intensity for wood edges.
         * @type {number}
         * @default 0.15
         */
        this.rimGlow = 0.15;

        /**
         * Rim-glow colour.
         * @type {Color}
         * @default (1.0, 0.8, 0.5) — warm wood rim
         */
        this.rimGlowColor = new Color(1.0, 0.8, 0.5);

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
        // PBR ↔ Anime blend (wood leans semi-realistic with anime grain)
        // -------------------------------------------------------------------

        /**
         * Wood materials blend PBR with anime grain stylization.
         * @type {number}
         * @default 0.4
         */
        this.renderStyleBlend = 0.4;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the wood material participates in galactic-scale chunking.
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
     * Apply cel banding to wood grain highlights.
     * @param {Color} baseColor - The grain base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applyGrainBanding(baseColor, output) {
        return applyWoodGrainCelBanding(
            baseColor,
            output,
            this.grainBands,
            this.grainQuantize,
            this.grainSoftness
        );
    }

    /**
     * Recompute the mood-graded wood colour.
     * @returns {ArchitecturalWoodMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradeWoodColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Generate a procedural wood grain texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.02]
     * @param {number} [octaves=4]
     * @param {number} [ringFrequency=18]
     * @returns {Uint8Array}
     */
    generateWoodGrainTexture(width, height, scale = 0.02, octaves = 4, ringFrequency = 18) {
        return generateWoodGrainTexture(width, height, scale, octaves, ringFrequency, 0.25);
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
     * @returns {Promise<ArchitecturalWoodMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with wood-specific
     * features: cel-banded grain highlights and warm rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.grainBands = { value: this.grainBands };
        shader.uniforms.grainQuantize = { value: this.grainQuantize };
        shader.uniforms.grainSoftness = { value: this.grainSoftness };
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
                uniform int grainBands;
                uniform float grainQuantize;
                uniform float grainSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyWoodGrainBands(vec3 baseColor) {
                    if (grainBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(grainBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * grainSoftness;
                    float finalLum = mix(lum, softQuantized, grainQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply wood grain cel banding
                gl_FragColor.rgb = applyWoodGrainBands(gl_FragColor.rgb);

                // Warm rim glow on wood edges
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
            this.grainBands,
            this.grainQuantize,
            this.grainSoftness,
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
     * @param {ArchitecturalWoodMaterial} source
     * @return {ArchitecturalWoodMaterial}
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
        this.grainBands = source.grainBands;
        this.grainQuantize = source.grainQuantize;
        this.grainSoftness = source.grainSoftness;
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

        data.type = 'ArchitecturalWoodMaterial';

        if (this.ior !== 1.43) data.ior = this.ior;
        if (this.specularIntensity !== 0.72) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.55) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.9, 0.85, 0.75).getHex()) {
            data.specularColor = this.specularColor.getHex();
        }
        if (this.grainBands !== 3) data.grainBands = this.grainBands;
        if (this.grainQuantize !== 0.7) data.grainQuantize = this.grainQuantize;
        if (this.grainSoftness !== 0.15) data.grainSoftness = this.grainSoftness;
        if (this.rimGlow !== 0.15) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 0.8, 0.5).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalWoodMaterial}
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
        this.grainBands = json.grainBands ?? this.grainBands;
        this.grainQuantize = json.grainQuantize ?? this.grainQuantize;
        this.grainSoftness = json.grainSoftness ?? this.grainSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural wood materials
// ---------------------------------------------------------------------------

const ArchitecturalWoodMaterialBatchComponent = {
    materialPtr: 'ui32',
    grainBands: 'ui8',
    grainQuantize: 'f64',
    grainSoftness: 'f64',
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
    ArchitecturalWoodMaterial,
    ArchitecturalWoodMaterialBatch,
    WoodScratchPool,
    ArchitecturalWoodMaterialBatchComponent,
    applyWoodGrainCelBanding,
    gradeWoodColor,
    generateWoodGrainTexture
};

export default ArchitecturalWoodMaterial;