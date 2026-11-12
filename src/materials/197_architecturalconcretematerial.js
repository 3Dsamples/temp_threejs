// file number : 197
// full path name : src/materials/197_architecturalconcretematerial.js
// description : ArchitecturalConcreteMaterial — a ready-to-use concrete material
//               for architectural visualization. Extends MeshPhysicalMaterial
//               with purpose-built defaults for concrete, cement, plaster,
//               render, and brutalist architecture: high roughness, dielectric
//               metalness, subtle bump variation, and real-time anime
//               stylization (cel-banded surface mottling, mood tinting, rim
//               glow, paper-grain texture, watercolor bleed, and per-instance
//               variation). Includes procedural mottling and moisture-patch
//               generation via simplex-noise. All imports resolve to the
//               internal Threejs_gl repository tree; no CDN dependencies.
// best for : Architectural concrete floors, walls, columns, ceilings, brutalist
//            architecture, plaster, cement render, polished concrete, and any
//            concrete surface that needs real-time PBR + anime stylization.
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
// Pool system — reusable concrete scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for concrete-material scratch records. Prevents per-frame
 * allocation of temporary mottling-banding, mood-tinting, and rim-glow scratch
 * objects.
 */
class ConcreteScratchPool {
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

/** @type {ConcreteScratchPool} Shared scratch pool for all concrete material instances. */
const _concreteScratchPool = new ConcreteScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — concrete-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded surface mottling to a concrete surface. Concrete has subtle
 * tonal variation from aggregate, moisture, and patina — quantizing it into
 * discrete bands produces the crisp, flat highlight edges seen in hand-drawn
 * architectural anime.
 * @param {Color} baseColor - The mottling base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of mottling bands (2–5 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.2] - Edge softness in [0, 0.5].
 * @returns {Color}
 */
function applyConcreteMottlingCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.2) {
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
 * Apply mood-based tinting to concrete. Warm moods tint concrete toward warm
 * beige/umber, cool moods toward cool blue-grey — matching the atmospheric
 * concrete tinting seen in architectural anime backgrounds.
 * @param {Color} color - The concrete colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeConcreteColor(color, temperature, saturation, brightness, contrast) {
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

    // Warm shift: slight R boost, B reduction
    // Cool shift: slight B boost, R reduction
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
 * Generate a procedural concrete surface texture using simplex-noise. Combines
 * aggregate speckles, moisture patches, and faint form-work lines to produce
 * the mottled appearance characteristic of real cast concrete.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.05] - Base noise scale.
 * @param {number} [octaves=4] - Number of noise octaves.
 * @param {number} [speckleStrength=0.15] - Aggregate speckle intensity.
 * @param {number} [moistureStrength=0.2] - Moisture patch intensity.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateConcreteTexture(width, height, scale = 0.05, octaves = 4, speckleStrength = 0.15, moistureStrength = 0.2) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Multi-octave fBm for low-frequency moisture patches
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

            // High-frequency aggregate speckle
            const speckle = SimplexNoise.noise2D(x * 2.5, y * 2.5) * 0.5 + 0.5;

            // Combine: 0.55 neutral base + fBm moisture + speckle
            let value = 0.55 + (fbm - 0.5) * moistureStrength + (speckle - 0.5) * speckleStrength;
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
// bitecs SoA batch coordinator for real-time concrete material updates
// ---------------------------------------------------------------------------

const _concreteWorld = BitECS.createWorld();
const ArchitecturalConcreteMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    mottlingBands: 'ui8',
    mottlingQuantize: 'f64',
    mottlingSoftness: 'f64',
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
 * Batch coordinator for architectural concrete materials. Registers
 * ArchitecturalConcreteMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalConcreteMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _concreteWorld;
        /** @type {ArchitecturalConcreteMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalConcreteMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalConcreteMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalConcreteMaterialComponent, eid);
        ArchitecturalConcreteMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalConcreteMaterialComponent.mottlingBands[eid] = material.mottlingBands;
        ArchitecturalConcreteMaterialComponent.mottlingQuantize[eid] = material.mottlingQuantize;
        ArchitecturalConcreteMaterialComponent.mottlingSoftness[eid] = material.mottlingSoftness;
        ArchitecturalConcreteMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalConcreteMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalConcreteMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalConcreteMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalConcreteMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalConcreteMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalConcreteMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalConcreteMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalConcreteMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued concrete-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalConcreteMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.mottlingBands = ArchitecturalConcreteMaterialComponent.mottlingBands[eid];
            material.mottlingQuantize = ArchitecturalConcreteMaterialComponent.mottlingQuantize[eid];
            material.mottlingSoftness = ArchitecturalConcreteMaterialComponent.mottlingSoftness[eid];
            material.moodTemperature = ArchitecturalConcreteMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalConcreteMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalConcreteMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalConcreteMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalConcreteMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalConcreteMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalConcreteMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalConcreteMaterialComponent.variationSeed[eid];

            ArchitecturalConcreteMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalConcreteMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural concrete material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built defaults for concrete,
 * cement, plaster, render, and brutalist architecture, plus real-time anime
 * stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalConcreteMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for concrete materials.
     */
    static {
        _concreteScratchPool.warm(32);
    }

    /**
     * Construct a new architectural concrete material.
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
        this.isArchitecturalConcreteMaterial = true;

        this.type = 'ArchitecturalConcreteMaterial';

        // -------------------------------------------------------------------
        // Concrete-specific PBR defaults (architectural concrete)
        // -------------------------------------------------------------------

        /**
         * Index of refraction for concrete (≈1.5).
         * @type {number}
         * @default 1.5
         */
        this.ior = 1.5;

        /**
         * Specular intensity for concrete (≈0.35, concrete is quite matte).
         * @type {number}
         * @default 0.35
         */
        this.specularIntensity = 0.35;

        /**
         * Base roughness. Concrete is very rough (matte).
         * @type {number}
         * @default 0.85
         */
        this.roughness = 0.85;

        /**
         * Metalness. Concrete is a dielectric.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * Clearcoat intensity. 0 = no clearcoat (raw concrete). For polished
         * concrete, set to 1.0.
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
         * Specular colour. Concrete specular is slightly warm.
         * @type {Color}
         * @default (0.85, 0.82, 0.78)
         */
        this.specularColor = new Color(0.85, 0.82, 0.78);

        /**
         * Base colour of the concrete. Default is a neutral cool-grey.
         * @type {Color}
         * @default (0.65, 0.65, 0.65)
         */
        this.color = new Color(0.65, 0.65, 0.65);

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
        // Anime rendering extensions — concrete-specific
        // -------------------------------------------------------------------

        /**
         * Number of mottling cel bands. 2–5 = stylized concrete surface steps.
         * @type {number}
         * @default 3
         */
        this.mottlingBands = 3;

        /**
         * Blend amount between continuous and banded mottling.
         * @type {number}
         * @default 0.6
         */
        this.mottlingQuantize = 0.6;

        /**
         * Mottling band edge softness.
         * @type {number}
         * @default 0.25
         */
        this.mottlingSoftness = 0.25;

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
         * Rim-glow intensity for concrete edges.
         * @type {number}
         * @default 0.1
         */
        this.rimGlow = 0.1;

        /**
         * Rim-glow colour. Concrete rim is cool-neutral.
         * @type {Color}
         * @default (0.7, 0.75, 0.85)
         */
        this.rimGlowColor = new Color(0.7, 0.75, 0.85);

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
        // PBR ↔ Anime blend (concrete leans semi-realistic with anime mottling)
        // -------------------------------------------------------------------

        /**
         * Concrete materials blend PBR with anime mottling stylization.
         * @type {number}
         * @default 0.35
         */
        this.renderStyleBlend = 0.35;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the concrete material participates in galactic-scale
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
     * Apply cel banding to concrete mottling highlights.
     * @param {Color} baseColor - The mottling base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applyMottlingBanding(baseColor, output) {
        return applyConcreteMottlingCelBanding(
            baseColor,
            output,
            this.mottlingBands,
            this.mottlingQuantize,
            this.mottlingSoftness
        );
    }

    /**
     * Recompute the mood-graded concrete colour.
     * @returns {ArchitecturalConcreteMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradeConcreteColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Generate a procedural concrete surface texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.05]
     * @param {number} [octaves=4]
     * @returns {Uint8Array}
     */
    generateConcreteTexture(width, height, scale = 0.05, octaves = 4) {
        return generateConcreteTexture(width, height, scale, octaves, 0.15, 0.2);
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
     * @returns {Promise<ArchitecturalConcreteMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with concrete-specific
     * features: cel-banded mottling and neutral rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.mottlingBands = { value: this.mottlingBands };
        shader.uniforms.mottlingQuantize = { value: this.mottlingQuantize };
        shader.uniforms.mottlingSoftness = { value: this.mottlingSoftness };
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
                uniform int mottlingBands;
                uniform float mottlingQuantize;
                uniform float mottlingSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyConcreteMottlingBands(vec3 baseColor) {
                    if (mottlingBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(mottlingBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * mottlingSoftness;
                    float finalLum = mix(lum, softQuantized, mottlingQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply concrete mottling cel banding
                gl_FragColor.rgb = applyConcreteMottlingBands(gl_FragColor.rgb);

                // Neutral rim glow on concrete edges
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
            this.mottlingBands,
            this.mottlingQuantize,
            this.mottlingSoftness,
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
     * @param {ArchitecturalConcreteMaterial} source
     * @return {ArchitecturalConcreteMaterial}
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
        this.mottlingBands = source.mottlingBands;
        this.mottlingQuantize = source.mottlingQuantize;
        this.mottlingSoftness = source.mottlingSoftness;
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

        data.type = 'ArchitecturalConcreteMaterial';

        if (this.ior !== 1.5) data.ior = this.ior;
        if (this.specularIntensity !== 0.35) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.85) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.85, 0.82, 0.78).getHex()) {
            data.specularColor = this.specularColor.getHex();
        }
        if (this.mottlingBands !== 3) data.mottlingBands = this.mottlingBands;
        if (this.mottlingQuantize !== 0.6) data.mottlingQuantize = this.mottlingQuantize;
        if (this.mottlingSoftness !== 0.25) data.mottlingSoftness = this.mottlingSoftness;
        if (this.rimGlow !== 0.1) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.7, 0.75, 0.85).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalConcreteMaterial}
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
        this.mottlingBands = json.mottlingBands ?? this.mottlingBands;
        this.mottlingQuantize = json.mottlingQuantize ?? this.mottlingQuantize;
        this.mottlingSoftness = json.mottlingSoftness ?? this.mottlingSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural concrete materials
// ---------------------------------------------------------------------------

const ArchitecturalConcreteMaterialBatchComponent = {
    materialPtr: 'ui32',
    mottlingBands: 'ui8',
    mottlingQuantize: 'f64',
    mottlingSoftness: 'f64',
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
    ArchitecturalConcreteMaterial,
    ArchitecturalConcreteMaterialBatch,
    ConcreteScratchPool,
    ArchitecturalConcreteMaterialBatchComponent,
    applyConcreteMottlingCelBanding,
    gradeConcreteColor,
    generateConcreteTexture
};

export default ArchitecturalConcreteMaterial;