// file number : 211
// full path name : src/materials/211_architecturalwatermaterial.js
// description : ArchitecturalWaterMaterial — a ready-to-use water material for
//               architectural visualization, focused on fountains, pools, water
//               features, reflecting pools, and decorative water surfaces.
//               Extends MeshPhysicalMaterial with purpose-built presets for
//               clear pool water, reflective fountain water, turbulent water
//               features, reflecting pools, and shallow water. Includes
//               physically based water defaults matching real freshwater and
//               saltwater (IOR 1.333 / 1.34–1.35, roughness 0.02–0.08 for calm
//               water, 0.1–0.2 for windier surfaces, near-black albedo with
//               depth-attenuated colour, and transmission for refraction) plus
//               real-time anime stylization (cel-banded water highlights, mood
//               tinting, caustic-glint rim, paper-grain texture, watercolor
//               bleed, and per-instance variation). Includes a procedural
//               water-ripple texture generator using multi-octave simplex noise
//               with directional flow, layered wave patterns, and Fresnel-like
//               gradient masking for the stylized anime water look.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Architectural water, fountains, pools, reflecting pools, water
//            features, decorative water surfaces, water walls, rills, and any
//            architectural water element that needs real-time PBR + anime
//            stylization.
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
// Water presets — curated PBR parameter sets for common architectural water
// ---------------------------------------------------------------------------

/**
 * Water reference PBR values (from V-Ray, Revit/Enscape, and three.js water
 * implementations)[reference:0][reference:1]:
 *   - Freshwater IOR:       1.333
 *   - Saltwater IOR:        1.34–1.35
 *   - Calm water roughness: 0.02–0.08 (GGX)
 *   - Windy water roughness: 0.1–0.2
 *   - Base/albedo:          near-black (water is largely reflective; colour
 *                          comes from absorption)
 *   - Reflection:           white; Fresnel on
 *   - Refraction:           white; IOR matches reflection
 *   - Absorption:           slightly teal/green fog colour for depth attenuation
 *   - Transmission:         high for clear water
 */
const ArchitecturalWaterPresets = {
    'clear-pool': {
        color: [0.02, 0.04, 0.05],
        transmission: 0.92,
        ior: 1.333,
        roughness: 0.03,
        metalness: 0.0,
        thickness: 0.5,
        attenuationDistance: 5.0,
        attenuationColor: [0.55, 0.85, 0.90],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'reflective-fountain': {
        color: [0.01, 0.02, 0.03],
        transmission: 0.75,
        ior: 1.333,
        roughness: 0.02,
        metalness: 0.0,
        thickness: 0.3,
        attenuationDistance: 3.0,
        attenuationColor: [0.50, 0.75, 0.85],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0],
        clearcoat: 0.25,
        clearcoatRoughness: 0.02
    },
    'turbulent-water': {
        color: [0.05, 0.10, 0.12],
        transmission: 0.80,
        ior: 1.333,
        roughness: 0.18,
        metalness: 0.0,
        thickness: 0.6,
        attenuationDistance: 2.5,
        attenuationColor: [0.60, 0.88, 0.92],
        specularIntensity: 0.85,
        specularColor: [0.95, 0.98, 1.0],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'reflecting-pool': {
        color: [0.01, 0.02, 0.02],
        transmission: 0.65,
        ior: 1.333,
        roughness: 0.025,
        metalness: 0.0,
        thickness: 0.25,
        attenuationDistance: 4.0,
        attenuationColor: [0.48, 0.72, 0.82],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0],
        clearcoat: 0.35,
        clearcoatRoughness: 0.01
    },
    'shallow-water': {
        color: [0.08, 0.16, 0.15],
        transmission: 0.88,
        ior: 1.333,
        roughness: 0.05,
        metalness: 0.0,
        thickness: 0.15,
        attenuationDistance: 1.5,
        attenuationColor: [0.65, 0.90, 0.85],
        specularIntensity: 0.95,
        specularColor: [1.0, 1.0, 1.0],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'salt-water': {
        color: [0.02, 0.05, 0.06],
        transmission: 0.90,
        ior: 1.345,
        roughness: 0.04,
        metalness: 0.0,
        thickness: 0.5,
        attenuationDistance: 4.5,
        attenuationColor: [0.52, 0.82, 0.88],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable water scratch records
// ---------------------------------------------------------------------------

class WaterScratchPool {
    constructor(capacity = 64) {
        this._free = [];
        for (let i = 0; i < capacity; i++) {
            this._free.push(this._createRecord());
        }
    }

    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            normal: new Vec3(),
            view: new Vec3()
        };
    }

    acquire() {
        return this._free.pop() || this._createRecord();
    }

    release(record) {
        if (record && this._free.length < 256) {
            this._free.push(record);
        }
    }

    warm(count) {
        while (this._free.length < count) {
            this._free.push(this._createRecord());
        }
    }
}

const _waterScratchPool = new WaterScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — water-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded water highlights. Water surfaces have specular highlights
 * that are quantized into discrete anime-style bands — producing the crisp,
 * flat water highlight edges seen in hand-drawn architectural anime.
 */
function applyWaterCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.08) {
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
 * Apply mood-based tinting to water. Warm moods tint water toward warm amber/
 * teal, cool moods toward cool cyan/blue — matching the atmospheric water
 * tinting seen in architectural anime backgrounds.
 */
function gradeWaterColor(color, temperature, saturation, brightness, contrast) {
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

    // Warm shift pushes toward amber-teal; cool shift pushes toward cyan-blue
    r += temperature * 0.06;
    g += temperature * 0.02;
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
 * Generate a procedural water-ripple texture. The algorithm:
 * 1. Multi-octave simplex-noise for the primary wave field, with directional
 *    flow by offsetting the noise domain per octave.
 * 2. A second, higher-frequency wave layer at a different angle for the
 *    "interference" pattern typical of real water surfaces.
 * 3. A Fresnel-like gradient mask that brightens grazing angles (simulating
 *    the view-angle-dependent specular response) — critical for the anime
 *    water look.
 * 4. Optional caustic-like ridge highlights using a power function on the
 *    combined noise field.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * normal-map derivation, or bump-map use.
 */
function generateWaterRippleTexture(width, height, scale = 0.02, octaves = 4, flowDirection = 0.0, secondaryAngle = 0.7, causticStrength = 0.3, causticSharpness = 3.0) {
    const out = new Uint8Array(width * height * 4);

    const cosA = Math.cos(flowDirection);
    const sinA = Math.sin(flowDirection);
    const cosB = Math.cos(secondaryAngle);
    const sinB = Math.sin(secondaryAngle);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Primary wave field (directional flow) ---
            let primary = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                // Directional offset per octave creates a sense of flow
                const flowOffset = o * 1000;
                const rx = (x * cosA - y * sinA) * frequency + flowOffset;
                const ry = (x * sinA + y * cosA) * frequency + flowOffset;

                primary += SimplexNoise.noise2D(rx, ry) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            primary = (primary / maxAmplitude) * 0.5 + 0.5;

            // --- 2. Secondary wave field (different angle, higher frequency) ---
            const rxB = x * cosB - y * sinB;
            const ryB = x * sinB + y * cosB;
            const secondary = SimplexNoise.noise2D(rxB * scale * 3.0, ryB * scale * 3.0) * 0.5 + 0.5;

            // --- 3. Fresnel-like gradient mask ---
            // Normalize UV and compute a soft radial gradient (bright at grazing)
            const u = x / width - 0.5;
            const v = y / height - 0.5;
            const dist = Math.sqrt(u * u + v * v) * 2.0;
            const fresnelMask = Math.pow(1.0 - Math.min(1, dist), 1.5);

            // --- 4. Caustic-like ridge highlights ---
            const combined = primary * 0.6 + secondary * 0.4;
            const causticRidge = Math.pow(Math.max(0, 1.0 - Math.abs(combined - 0.5) * 2.0), causticSharpness);

            // --- Combine ---
            let value = 0.5
                + (primary - 0.5) * 0.25
                + (secondary - 0.5) * 0.10
                + causticRidge * causticStrength * 0.4
                + fresnelMask * 0.15;

            value = Math.max(0, Math.min(1, value));

            const v8 = Math.floor(value * 255);
            out[p] = v8;
            out[p + 1] = v8;
            out[p + 2] = v8;
            out[p + 3] = 255;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator
// ---------------------------------------------------------------------------

const _waterWorld = BitECS.createWorld();
const ArchitecturalWaterMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    waterBands: 'ui8',
    waterQuantize: 'f64',
    waterSoftness: 'f64',
    causticGlintIntensity: 'f64',
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

class ArchitecturalWaterMaterialBatch {
    constructor() {
        this.world = _waterWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalWaterMaterialComponent, eid);
        ArchitecturalWaterMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalWaterMaterialComponent.waterBands[eid] = material.waterBands;
        ArchitecturalWaterMaterialComponent.waterQuantize[eid] = material.waterQuantize;
        ArchitecturalWaterMaterialComponent.waterSoftness[eid] = material.waterSoftness;
        ArchitecturalWaterMaterialComponent.causticGlintIntensity[eid] = material.causticGlintIntensity;
        ArchitecturalWaterMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalWaterMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalWaterMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalWaterMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalWaterMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalWaterMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalWaterMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalWaterMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalWaterMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalWaterMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.waterBands = ArchitecturalWaterMaterialComponent.waterBands[eid];
            material.waterQuantize = ArchitecturalWaterMaterialComponent.waterQuantize[eid];
            material.waterSoftness = ArchitecturalWaterMaterialComponent.waterSoftness[eid];
            material.causticGlintIntensity = ArchitecturalWaterMaterialComponent.causticGlintIntensity[eid];
            material.moodTemperature = ArchitecturalWaterMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalWaterMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalWaterMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalWaterMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalWaterMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalWaterMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalWaterMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalWaterMaterialComponent.variationSeed[eid];

            ArchitecturalWaterMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalWaterMaterial class
// ---------------------------------------------------------------------------

class ArchitecturalWaterMaterial extends MeshPhysicalMaterial {
    static {
        _waterScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isArchitecturalWaterMaterial = true;
        this.type = 'ArchitecturalWaterMaterial';

        // -------------------------------------------------------------------
        // Water-specific PBR defaults (clear pool baseline)
        // -------------------------------------------------------------------
        this.ior = 1.333;
        this.specularIntensity = 1.0;
        this.roughness = 0.03;
        this.metalness = 0.0;
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;
        this.specularColor = new Color(1.0, 1.0, 1.0);
        this.color = new Color(0.02, 0.04, 0.05);

        // Transmission for refraction
        this.transmission = 0.92;
        this.thickness = 0.5;
        this.attenuationDistance = 5.0;
        this.attenuationColor = new Color(0.55, 0.85, 0.90);

        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — water-specific
        // -------------------------------------------------------------------
        this.waterBands = 3;
        this.waterQuantize = 0.4;
        this.waterSoftness = 0.08;
        this.causticGlintIntensity = 0.35;
        this.causticGlintColor = new Color(0.85, 0.95, 1.0);
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.20;
        this.rimGlowColor = new Color(0.60, 0.85, 1.0);
        this.paperGrain = 0;
        this.watercolorBleed = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (water leans semi-realistic)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.30;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    applyWaterBanding(baseColor, output) {
        return applyWaterCelBanding(
            baseColor,
            output,
            this.waterBands,
            this.waterQuantize,
            this.waterSoftness
        );
    }

    updateMoodColor() {
        gradeWaterColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural water preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalWaterPresets`.
     * @returns {ArchitecturalWaterMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalWaterPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.transmission = preset.transmission;
        this.ior = preset.ior;
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;

        // Adjust anime band softness for calm vs turbulent water
        if (presetName === 'turbulent-water') {
            this.waterSoftness = 0.20;
            this.waterBands = 2;
            this.causticGlintIntensity = 0.45;
        } else if (presetName === 'clear-pool' || presetName === 'shallow-water') {
            this.waterSoftness = 0.08;
            this.waterBands = 3;
            this.causticGlintIntensity = 0.30;
        } else {
            this.waterSoftness = 0.05;
            this.waterBands = 3;
            this.causticGlintIntensity = 0.35;
        }

        this.updateMoodColor();
        return this;
    }

    generateWaterRippleTexture(width, height, scale = 0.02, octaves = 4, flowDirection = 0.0, causticStrength = 0.3) {
        return generateWaterRippleTexture(width, height, scale, octaves, flowDirection, 0.7, causticStrength, 3.0);
    }

    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.waterBands = { value: this.waterBands };
        shader.uniforms.waterQuantize = { value: this.waterQuantize };
        shader.uniforms.waterSoftness = { value: this.waterSoftness };
        shader.uniforms.causticGlintIntensity = { value: this.causticGlintIntensity };
        shader.uniforms.causticGlintColor = { value: this.causticGlintColor };
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
                uniform int waterBands;
                uniform float waterQuantize;
                uniform float waterSoftness;
                uniform float causticGlintIntensity;
                uniform vec3 causticGlintColor;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyWaterBands(vec3 baseColor) {
                    if (waterBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(waterBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * waterSoftness;
                    float finalLum = mix(lum, softQuantized, waterQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply water cel banding
                gl_FragColor.rgb = applyWaterBands(gl_FragColor.rgb);

                // Caustic glint: bright grazing-angle specular streaks
                if (causticGlintIntensity > 0.0) {
                    float ndotvWater = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float glint = pow(1.0 - ndotvWater, 4.0) * causticGlintIntensity;
                    gl_FragColor.rgb += causticGlintColor * glint;
                }

                // Cool-cyan rim glow on water edges
                if (rimGlow > 0.0) {
                    float rimFactor = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    gl_FragColor.rgb += rimGlowColor * rimGlow * rimFactor;
                }
                `
            );
    }

    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.ior, this.specularIntensity, this.roughness, this.metalness,
            this.transmission, this.thickness, this.attenuationDistance,
            this.clearcoat, this.clearcoatRoughness,
            this.waterBands, this.waterQuantize, this.waterSoftness,
            this.causticGlintIntensity,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.ior = source.ior;
        this.specularIntensity = source.specularIntensity;
        this.roughness = source.roughness;
        this.metalness = source.metalness;
        this.specularColor.copy(source.specularColor);
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.waterBands = source.waterBands;
        this.waterQuantize = source.waterQuantize;
        this.waterSoftness = source.waterSoftness;
        this.causticGlintIntensity = source.causticGlintIntensity;
        this.causticGlintColor.copy(source.causticGlintColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'ArchitecturalWaterMaterial';
        if (this.ior !== 1.333) data.ior = this.ior;
        if (this.specularIntensity !== 1.0) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.03) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.transmission !== 0.92) data.transmission = this.transmission;
        if (this.thickness !== 0.5) data.thickness = this.thickness;
        if (this.attenuationDistance !== 5.0) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.55, 0.85, 0.90).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.waterBands !== 3) data.waterBands = this.waterBands;
        if (this.waterQuantize !== 0.4) data.waterQuantize = this.waterQuantize;
        if (this.waterSoftness !== 0.08) data.waterSoftness = this.waterSoftness;
        if (this.causticGlintIntensity !== 0.35) data.causticGlintIntensity = this.causticGlintIntensity;
        if (this.causticGlintColor.getHex() !== new Color(0.85, 0.95, 1.0).getHex()) data.causticGlintColor = this.causticGlintColor.getHex();
        if (this.rimGlow !== 0.20) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.60, 0.85, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.ior = json.ior ?? this.ior;
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        this.roughness = json.roughness ?? this.roughness;
        this.metalness = json.metalness ?? this.metalness;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        this.waterBands = json.waterBands ?? this.waterBands;
        this.waterQuantize = json.waterQuantize ?? this.waterQuantize;
        this.waterSoftness = json.waterSoftness ?? this.waterSoftness;
        this.causticGlintIntensity = json.causticGlintIntensity ?? this.causticGlintIntensity;
        if (json.causticGlintColor !== undefined) this.causticGlintColor.setHex(json.causticGlintColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const ArchitecturalWaterMaterialBatchComponent = {
    materialPtr: 'ui32',
    waterBands: 'ui8',
    waterQuantize: 'f64',
    waterSoftness: 'f64',
    causticGlintIntensity: 'f64',
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
    ArchitecturalWaterMaterial,
    ArchitecturalWaterMaterialBatch,
    WaterScratchPool,
    ArchitecturalWaterMaterialBatchComponent,
    ArchitecturalWaterPresets,
    applyWaterCelBanding,
    gradeWaterColor,
    generateWaterRippleTexture
};

export default ArchitecturalWaterMaterial;