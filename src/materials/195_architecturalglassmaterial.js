// file number : 195
// full path name : src/materials/195_architecturalglassmaterial.js
// description : ArchitecturalGlassMaterial — a ready-to-use glass material for
//               architectural visualization. Extends MeshPhysicalMaterial with
//               purpose-built defaults for windows, curtain walls, shopfronts,
//               and skylights: transmission, IOR, thickness, attenuation,
//               clearcoat, and real-time anime stylization (cel-banded
//               reflections, mood tinting, rim glow, paper-grain texture, and
//               per-instance variation). All imports resolve to the internal
//               Threejs_gl repository tree; no CDN dependencies.
// best for : Architectural glass, glazing, curtain walls, shopfronts, skylights,
//            interior partitions, and any transparent architectural surface
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
// Pool system — reusable glass scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for glass-material scratch records. Prevents per-frame
 * allocation of temporary cel-banding, mood-tinting, and rim-glow scratch objects.
 */
class GlassScratchPool {
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

/** @type {GlassScratchPool} Shared scratch pool for all glass material instances. */
const _glassScratchPool = new GlassScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — glass-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded reflections to a glass surface. Glass reflections are
 * quantized into discrete anime-style bands — producing the crisp, flat
 * highlight edges seen in hand-drawn architectural anime.
 * @param {Color} baseColor - The reflected base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of reflection bands (2–4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.05] - Edge softness in [0, 0.3].
 * @returns {Color}
 */
function applyGlassReflectionCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.05) {
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
 * Apply mood-based tinting to glass. Warm moods tint glass toward amber/gold,
 * cool moods toward cyan/blue — matching the atmospheric glass tinting seen in
 * architectural anime backgrounds.
 * @param {Color} color - The glass colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeGlassColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.08;
    b -= temperature * 0.08;

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
 * Generate a procedural glass surface texture using simplex-noise. Creates the
 * subtle surface imperfection pattern characteristic of real architectural
 * glass — fingerprints, dust, and micro-scratches.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.08] - Base noise scale.
 * @param {number} [octaves=2] - Number of noise octaves.
 * @param {number} [intensity=0.15] - Imperfection intensity in [0, 1].
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateGlassTexture(width, height, scale = 0.08, octaves = 2, intensity = 0.15) {
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
// bitecs SoA batch coordinator for real-time glass material updates
// ---------------------------------------------------------------------------

const _glassWorld = BitECS.createWorld();
const ArchitecturalGlassMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    transmissionBands: 'ui8',
    transmissionQuantize: 'f64',
    reflectionBands: 'ui8',
    reflectionQuantize: 'f64',
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
 * Batch coordinator for architectural glass materials. Registers
 * ArchitecturalGlassMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalGlassMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _glassWorld;
        /** @type {ArchitecturalGlassMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalGlassMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalGlassMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalGlassMaterialComponent, eid);
        ArchitecturalGlassMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalGlassMaterialComponent.transmissionBands[eid] = material.transmissionBands;
        ArchitecturalGlassMaterialComponent.transmissionQuantize[eid] = material.transmissionQuantize;
        ArchitecturalGlassMaterialComponent.reflectionBands[eid] = material.reflectionBands;
        ArchitecturalGlassMaterialComponent.reflectionQuantize[eid] = material.reflectionQuantize;
        ArchitecturalGlassMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalGlassMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalGlassMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalGlassMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalGlassMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalGlassMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalGlassMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalGlassMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalGlassMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued glass-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalGlassMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.transmissionBands = ArchitecturalGlassMaterialComponent.transmissionBands[eid];
            material.transmissionQuantize = ArchitecturalGlassMaterialComponent.transmissionQuantize[eid];
            material.reflectionBands = ArchitecturalGlassMaterialComponent.reflectionBands[eid];
            material.reflectionQuantize = ArchitecturalGlassMaterialComponent.reflectionQuantize[eid];
            material.moodTemperature = ArchitecturalGlassMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalGlassMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalGlassMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalGlassMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalGlassMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalGlassMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalGlassMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalGlassMaterialComponent.variationSeed[eid];

            ArchitecturalGlassMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalGlassMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural glass material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built defaults for windows, curtain
 * walls, shopfronts, and skylights, plus real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalGlassMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for glass materials.
     */
    static {
        _glassScratchPool.warm(32);
    }

    /**
     * Construct a new architectural glass material.
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
        this.isArchitecturalGlassMaterial = true;

        this.type = 'ArchitecturalGlassMaterial';

        // -------------------------------------------------------------------
        // Glass-specific PBR defaults (architectural glazing)
        // -------------------------------------------------------------------

        /**
         * Transmission intensity. 1 = fully transmissive glass.
         * @type {number}
         * @default 1.0
         */
        this.transmission = 1.0;

        /**
         * Index of refraction. Glass ≈ 1.5, water ≈ 1.33, air ≈ 1.0.
         * @type {number}
         * @default 1.5
         */
        this.ior = 1.5;

        /**
         * Volume thickness in world units. Drives Beer-Lambert attenuation.
         * @type {number}
         * @default 0.5
         */
        this.thickness = 0.5;

        /**
         * Attenuation distance. Higher = less coloured absorption.
         * @type {number}
         * @default 200
         */
        this.attenuationDistance = 200;

        /**
         * Attenuation colour. Slight cyan-green tint for glass.
         * @type {Color}
         * @default (0.85, 0.95, 0.92)
         */
        this.attenuationColor = new Color(0.85, 0.95, 0.92);

        /**
         * Roughness. Keep very low for clean windows.
         * @type {number}
         * @default 0.03
         */
        this.roughness = 0.03;

        /**
         * Metalness. Glass is a dielectric.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * Clearcoat intensity for extra surface gloss.
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
         * Specular intensity.
         * @type {number}
         * @default 1.0
         */
        this.specularIntensity = 1.0;

        /**
         * Specular colour.
         * @type {Color}
         * @default (1,1,1)
         */
        this.specularColor = new Color(0xffffff);

        /**
         * Iridescence intensity for magical / stained glass effects.
         * @type {number}
         * @default 0.0
         */
        this.iridescence = 0.0;

        /**
         * Iridescence IOR.
         * @type {number}
         * @default 1.3
         */
        this.iridescenceIOR = 1.3;

        /**
         * Base colour of the glass (mostly neutral for clear glass).
         * @type {Color}
         * @default (0.95, 0.97, 0.96)
         */
        this.color = new Color(0.95, 0.97, 0.96);

        // -------------------------------------------------------------------
        // Anime rendering extensions — glass-specific
        // -------------------------------------------------------------------

        /**
         * Number of transmission cel bands. 2–4 = stylized glass layers.
         * @type {number}
         * @default 2
         */
        this.transmissionBands = 2;

        /**
         * Blend amount between continuous and banded transmission.
         * @type {number}
         * @default 0.8
         */
        this.transmissionQuantize = 0.8;

        /**
         * Number of reflection cel bands. 2–4 = stylized reflection steps.
         * @type {number}
         * @default 3
         */
        this.reflectionBands = 3;

        /**
         * Blend amount between continuous and banded reflections.
         * @type {number}
         * @default 0.7
         */
        this.reflectionQuantize = 0.7;

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
         * Rim-glow intensity for glass edges.
         * @type {number}
         * @default 0.3
         */
        this.rimGlow = 0.3;

        /**
         * Rim-glow colour.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color(0.5, 0.9, 1.0);

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
        // PBR ↔ Anime blend (glass leans semi-realistic with anime edges)
        // -------------------------------------------------------------------

        /**
         * Glass materials blend PBR transmission with anime stylization.
         * @type {number}
         * @default 0.35
         */
        this.renderStyleBlend = 0.35;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the glass material participates in galactic-scale chunking.
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
     * Apply cel banding to glass reflections.
     * @param {Color} baseColor - The reflection base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applyReflectionBanding(baseColor, output) {
        return applyGlassReflectionCelBanding(
            baseColor,
            output,
            this.reflectionBands,
            this.reflectionQuantize,
            0.05
        );
    }

    /**
     * Recompute the mood-graded glass colour.
     * @returns {ArchitecturalGlassMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradeGlassColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Generate a procedural glass surface texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.08]
     * @param {number} [octaves=2]
     * @returns {Uint8Array}
     */
    generateGlassTexture(width, height, scale = 0.08, octaves = 2) {
        return generateGlassTexture(width, height, scale, octaves, 0.15);
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
     * @returns {Promise<ArchitecturalGlassMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with glass-specific
     * features: cel-banded reflections and transmission.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.transmissionBands = { value: this.transmissionBands };
        shader.uniforms.transmissionQuantize = { value: this.transmissionQuantize };
        shader.uniforms.reflectionBands = { value: this.reflectionBands };
        shader.uniforms.reflectionQuantize = { value: this.reflectionQuantize };
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
                uniform int transmissionBands;
                uniform float transmissionQuantize;
                uniform int reflectionBands;
                uniform float reflectionQuantize;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyGlassReflectionBands(vec3 baseColor) {
                    if (reflectionBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(reflectionBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float finalLum = mix(lum, quantized, reflectionQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }

                vec3 applyGlassTransmissionBands(vec3 baseColor) {
                    if (transmissionBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(transmissionBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float finalLum = mix(lum, quantized, transmissionQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply glass reflection cel banding
                gl_FragColor.rgb = applyGlassReflectionBands(gl_FragColor.rgb);

                // Apply transmission cel banding
                gl_FragColor.rgb = applyGlassTransmissionBands(gl_FragColor.rgb);

                // Rim glow on glass edges
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
            this.transmission,
            this.ior,
            this.thickness,
            this.attenuationDistance,
            this.transmissionBands,
            this.transmissionQuantize,
            this.reflectionBands,
            this.reflectionQuantize,
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
     * @param {ArchitecturalGlassMaterial} source
     * @return {ArchitecturalGlassMaterial}
     */
    copy(source) {
        super.copy(source);

        this.transmission = source.transmission;
        this.ior = source.ior;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.transmissionBands = source.transmissionBands;
        this.transmissionQuantize = source.transmissionQuantize;
        this.reflectionBands = source.reflectionBands;
        this.reflectionQuantize = source.reflectionQuantize;
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

        data.type = 'ArchitecturalGlassMaterial';

        if (this.transmission !== 1.0) data.transmission = this.transmission;
        if (this.ior !== 1.5) data.ior = this.ior;
        if (this.thickness !== 0.5) data.thickness = this.thickness;
        if (this.attenuationDistance !== 200) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.85, 0.95, 0.92).getHex()) {
            data.attenuationColor = this.attenuationColor.getHex();
        }
        if (this.transmissionBands !== 2) data.transmissionBands = this.transmissionBands;
        if (this.transmissionQuantize !== 0.8) data.transmissionQuantize = this.transmissionQuantize;
        if (this.reflectionBands !== 3) data.reflectionBands = this.reflectionBands;
        if (this.reflectionQuantize !== 0.7) data.reflectionQuantize = this.reflectionQuantize;
        if (this.rimGlow !== 0.3) data.rimGlow = this.rimGlow;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalGlassMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        this.transmission = json.transmission ?? this.transmission;
        this.ior = json.ior ?? this.ior;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.transmissionBands = json.transmissionBands ?? this.transmissionBands;
        this.transmissionQuantize = json.transmissionQuantize ?? this.transmissionQuantize;
        this.reflectionBands = json.reflectionBands ?? this.reflectionBands;
        this.reflectionQuantize = json.reflectionQuantize ?? this.reflectionQuantize;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural glass materials
// ---------------------------------------------------------------------------

const ArchitecturalGlassMaterialBatchComponent = {
    materialPtr: 'ui32',
    transmissionBands: 'ui8',
    transmissionQuantize: 'f64',
    reflectionBands: 'ui8',
    reflectionQuantize: 'f64',
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
    ArchitecturalGlassMaterial,
    ArchitecturalGlassMaterialBatch,
    GlassScratchPool,
    ArchitecturalGlassMaterialBatchComponent,
    applyGlassReflectionCelBanding,
    gradeGlassColor,
    generateGlassTexture
};

export default ArchitecturalGlassMaterial;