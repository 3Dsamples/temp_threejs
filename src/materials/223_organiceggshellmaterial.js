// file number : 223
// full path name : src/materials/223_organiceggshellmaterial.js
// description : OrganicEggshellMaterial — a ready-to-use eggshell material
//               for eggshells, eggshell fragments, and calcified biological
//               shells. Extends MeshPhysicalMaterial with purpose-built presets
//               for chicken-egg white, brown egg, speckled egg, blue egg, duck
//               egg, and porcelain-like eggshell. Includes biologically
//               grounded defaults (eggshell IOR ≈ 1.53, roughness 0.35–0.55,
//               zero metalness, thin-walled transmission for the slight
//               translucency of fresh eggshell, and subtle clearcoat for the
//               waxy cuticle) plus real-time anime stylization: cel-banded
//               eggshell highlights, speckle-pattern approximation, mood
//               tinting, rim glow, and per-instance variation. Includes a
//               procedural eggshell-speckle texture generator using hashed
//               speckle cells with per-speckle colour variation, pore grain,
//               and optional cuticle mottle.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Organic eggshells, chicken eggs, duck eggs, quail eggs, speckled
//            eggs, blue eggs, porcelain-like eggs, eggshell fragments, nests,
//            and any calcified biological shell that needs real-time PBR +
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
// Eggshell presets — biologically grounded PBR parameter sets for eggshell
// types.
//
// Reference values (from eggshell PBR references, biological literature on
// avian eggshells, and CG egg texture packs):
//   - Eggshell IOR:              ≈ 1.53 (calcite + cuticle)
//   - Eggshell roughness:        0.35–0.55 (matte to slightly glossy)
//   - Metalness:                 0.0 (eggshell is a dielectric)
//   - Fresh eggshell transmission: subtle (0.05–0.15) for the warm see-through
//   - Clearcoat:                 subtle for the waxy cuticle of fresh eggs
//   - Speckle presence:          speckled eggs contain protoporphyrin pigment
//   - Blue eggs (robin, duck):   biliverdin pigment produces a blue-green tint
// ---------------------------------------------------------------------------

const OrganicEggshellPresets = {
    'chicken-white': {
        color: [0.96, 0.94, 0.90],
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.40,
        transmission: 0.10,
        thickness: 0.003,
        attenuationDistance: 0.05,
        attenuationColor: [0.98, 0.94, 0.86],
        specularIntensity: 0.32,
        specularColor: [0.92, 0.90, 0.88]
    },
    'chicken-brown': {
        color: [0.78, 0.58, 0.42],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.08,
        clearcoatRoughness: 0.42,
        transmission: 0.08,
        thickness: 0.003,
        attenuationDistance: 0.05,
        attenuationColor: [0.85, 0.64, 0.48],
        specularIntensity: 0.30,
        specularColor: [0.85, 0.72, 0.62]
    },
    'speckled': {
        color: [0.88, 0.82, 0.74],
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.40,
        transmission: 0.09,
        thickness: 0.003,
        attenuationDistance: 0.05,
        attenuationColor: [0.92, 0.86, 0.78],
        specularIntensity: 0.32,
        specularColor: [0.90, 0.86, 0.82]
    },
    'blue': {
        color: [0.58, 0.72, 0.82],
        roughness: 0.40,
        metalness: 0.0,
        clearcoat: 0.12,
        clearcoatRoughness: 0.38,
        transmission: 0.11,
        thickness: 0.003,
        attenuationDistance: 0.05,
        attenuationColor: [0.62, 0.78, 0.88],
        specularIntensity: 0.34,
        specularColor: [0.78, 0.88, 0.95]
    },
    'duck-green': {
        color: [0.68, 0.78, 0.62],
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.40,
        transmission: 0.10,
        thickness: 0.003,
        attenuationDistance: 0.05,
        attenuationColor: [0.72, 0.82, 0.66],
        specularIntensity: 0.32,
        specularColor: [0.82, 0.90, 0.78]
    },
    'porcelain-eggshell': {
        color: [0.94, 0.92, 0.90],
        roughness: 0.24,
        metalness: 0.0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.15,
        transmission: 0.14,
        thickness: 0.003,
        attenuationDistance: 0.06,
        attenuationColor: [0.96, 0.94, 0.92],
        specularIntensity: 0.52,
        specularColor: [0.96, 0.95, 0.94]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable eggshell scratch records
// ---------------------------------------------------------------------------

class EggshellScratchPool {
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

const _eggshellScratchPool = new EggshellScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — eggshell-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded eggshell highlights. Eggshells have soft, warm shading
 * with a subtle matte specular — quantizing it into discrete bands produces
 * the crisp anime eggshell edges seen in hand-drawn still-life and food
 * illustrations.
 */
function applyEggshellCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to eggshell. Warm moods push eggshell toward warm
 * cream/ivory, cool moods toward cool pearl-grey — matching the atmospheric
 * eggshell tinting seen in stylized still-life scenes.
 */
function gradeEggshellColor(color, temperature, saturation, brightness, contrast) {
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

    // Eggshell-specific temperature bias: warm shift pushes toward cream,
    // cool shift pushes toward pearl-grey.
    r += temperature * 0.03;
    g += temperature * 0.01;
    b -= temperature * 0.03;

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
 * Generate a procedural eggshell-speckle texture. The algorithm:
 * 1. Hashed speckle cells: divide UV into a fine grid, per-cell hash decides
 *    if a speckle is present, its size, and its intensity.
 * 2. Per-speckle colour variation from a second hash.
 * 3. Fine simplex-noise pore grain for the micro-surface of the cuticle.
 * 4. Optional cuticle mottle: low-frequency fBm for uneven pigmentation.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateEggshellSpeckleTexture(width, height, speckleDensity = 0.25, speckleSize = 0.35, speckleStrength = 0.55, poreGrain = 0.06, mottleStrength = 0.10) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Hashed speckle cells ---
            const cellX = Math.floor(x * 0.4);
            const cellY = Math.floor(y * 0.4);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const cellHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;

            let speckle = 0;
            if (cellHash > (1.0 - speckleDensity)) {
                // Local offset from a second hash
                const h2 = Math.abs(Math.sin(cellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                const h3 = Math.abs(Math.sin(cellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                const cx = (x * 0.4) - cellX - h2;
                const cy = (y * 0.4) - cellY - h3;
                const dist = Math.sqrt(cx * cx + cy * cy);
                speckle = Math.max(0, 1.0 - dist / speckleSize);

                // --- 2. Per-speckle colour variation ---
                const speckleTint = 0.5 + h2 * 0.5;
                speckle *= speckleTint * speckleStrength;
            }

            // --- 3. Fine pore grain ---
            const grain = SimplexNoise.noise2D(x * 0.9, y * 0.9) * poreGrain;

            // --- 4. Cuticle mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.02, y * 0.02) * mottleStrength;

            // --- Combine ---
            let value = 0.88 - speckle + grain + mottle;
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

const _eggshellWorld = BitECS.createWorld();
const OrganicEggshellMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    eggshellBands: 'ui8',
    eggshellQuantize: 'f64',
    eggshellSoftness: 'f64',
    speckleStrength: 'f64',
    speckleDensity: 'f64',
    cuticleMottle: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicEggshellMaterialBatch {
    constructor() {
        this.world = _eggshellWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicEggshellMaterialComponent, eid);
        OrganicEggshellMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicEggshellMaterialComponent.eggshellBands[eid] = material.eggshellBands;
        OrganicEggshellMaterialComponent.eggshellQuantize[eid] = material.eggshellQuantize;
        OrganicEggshellMaterialComponent.eggshellSoftness[eid] = material.eggshellSoftness;
        OrganicEggshellMaterialComponent.speckleStrength[eid] = material.speckleStrength;
        OrganicEggshellMaterialComponent.speckleDensity[eid] = material.speckleDensity;
        OrganicEggshellMaterialComponent.cuticleMottle[eid] = material.cuticleMottle;
        OrganicEggshellMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicEggshellMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicEggshellMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicEggshellMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicEggshellMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicEggshellMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicEggshellMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicEggshellMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.eggshellBands = OrganicEggshellMaterialComponent.eggshellBands[eid];
            material.eggshellQuantize = OrganicEggshellMaterialComponent.eggshellQuantize[eid];
            material.eggshellSoftness = OrganicEggshellMaterialComponent.eggshellSoftness[eid];
            material.speckleStrength = OrganicEggshellMaterialComponent.speckleStrength[eid];
            material.speckleDensity = OrganicEggshellMaterialComponent.speckleDensity[eid];
            material.cuticleMottle = OrganicEggshellMaterialComponent.cuticleMottle[eid];
            material.moodTemperature = OrganicEggshellMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicEggshellMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicEggshellMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicEggshellMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicEggshellMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicEggshellMaterialComponent.variationSeed[eid];

            OrganicEggshellMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicEggshellMaterial class
// ---------------------------------------------------------------------------

class OrganicEggshellMaterial extends MeshPhysicalMaterial {
    static {
        _eggshellScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicEggshellMaterial = true;
        this.type = 'OrganicEggshellMaterial';

        // -------------------------------------------------------------------
        // Eggshell-specific PBR defaults (chicken-white baseline)
        // -------------------------------------------------------------------
        this.ior = 1.53;
        this.specularIntensity = 0.32;
        this.roughness = 0.42;
        this.metalness = 0.0;
        this.specularColor = new Color(0.92, 0.90, 0.88);
        this.color = new Color(0.96, 0.94, 0.90);

        // Clearcoat for the waxy cuticle
        this.clearcoat = 0.10;
        this.clearcoatRoughness = 0.40;

        // Thin-walled transmission for the slight see-through of fresh eggshell
        this.transmission = 0.10;
        this.thickness = 0.003;
        this.attenuationDistance = 0.05;
        this.attenuationColor = new Color(0.98, 0.94, 0.86);

        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — eggshell-specific
        // -------------------------------------------------------------------
        this.eggshellBands = 3;
        this.eggshellQuantize = 0.4;
        this.eggshellSoftness = 0.15;
        this.speckleStrength = 0.0;
        this.speckleDensity = 0.25;
        this.cuticleMottle = 0.10;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.08;
        this.rimGlowColor = new Color(0.96, 0.94, 0.90);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (eggshell leans semi-realistic)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.35;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    applyEggshellBanding(baseColor, output) {
        return applyEggshellCelBanding(
            baseColor,
            output,
            this.eggshellBands,
            this.eggshellQuantize,
            this.eggshellSoftness
        );
    }

    updateMoodColor() {
        gradeEggshellColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic eggshell preset to this material.
     * @param {string} presetName - One of the keys of `OrganicEggshellPresets`.
     * @returns {OrganicEggshellMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicEggshellPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;
        this.transmission = preset.transmission;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Speckle strength is per-preset
        if (presetName === 'speckled') {
            this.speckleStrength = 0.55;
            this.speckleDensity = 0.28;
        } else {
            this.speckleStrength = 0.0;
            this.speckleDensity = 0.0;
        }

        // Adjust anime band softness per preset
        if (presetName === 'porcelain-eggshell') {
            this.eggshellSoftness = 0.08;
            this.eggshellBands = 4;
        } else if (presetName === 'chicken-brown' || presetName === 'duck-green') {
            this.eggshellSoftness = 0.18;
            this.eggshellBands = 3;
        } else {
            this.eggshellSoftness = 0.15;
            this.eggshellBands = 3;
        }

        this.updateMoodColor();
        return this;
    }

    generateEggshellSpeckleTexture(width, height, speckleDensity = 0.25, speckleSize = 0.35, speckleStrength = 0.55) {
        return generateEggshellSpeckleTexture(width, height, speckleDensity, speckleSize, speckleStrength, 0.06, 0.10);
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

        shader.uniforms.eggshellBands = { value: this.eggshellBands };
        shader.uniforms.eggshellQuantize = { value: this.eggshellQuantize };
        shader.uniforms.eggshellSoftness = { value: this.eggshellSoftness };
        shader.uniforms.speckleStrength = { value: this.speckleStrength };
        shader.uniforms.speckleDensity = { value: this.speckleDensity };
        shader.uniforms.cuticleMottle = { value: this.cuticleMottle };
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
                uniform int eggshellBands;
                uniform float eggshellQuantize;
                uniform float eggshellSoftness;
                uniform float speckleStrength;
                uniform float speckleDensity;
                uniform float cuticleMottle;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyEggshellBands(vec3 baseColor) {
                    if (eggshellBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(eggshellBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * eggshellSoftness;
                    float finalLum = mix(lum, softQuantized, eggshellQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply eggshell cel banding
                gl_FragColor.rgb = applyEggshellBands(gl_FragColor.rgb);

                // Speckle approximation: hashed per-cell darkening
                if (speckleStrength > 0.0) {
                    vec2 speckleUV = vUv * 120.0;
                    vec2 speckleCell = floor(speckleUV);
                    float speckleHash = fract(sin(dot(speckleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    float speckleMask = speckleHash > (1.0 - speckleDensity) ? 1.0 : 0.0;
                    float speckleIntensity = fract(sin(dot(speckleCell, vec2(39.425, 1.57))) * 43758.5453);
                    gl_FragColor.rgb *= (1.0 - speckleMask * speckleStrength * (0.6 + speckleIntensity * 0.4));
                }

                // Cuticle mottle: low-frequency uneven pigmentation
                if (cuticleMottle > 0.0) {
                    float mottle = sin(vUv.x * 25.0 + variationOffset) * cos(vUv.y * 25.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 - mottle * cuticleMottle * 0.15);
                }

                // Warm rim glow on eggshell edges
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
            this.clearcoat, this.clearcoatRoughness,
            this.transmission, this.thickness, this.attenuationDistance,
            this.eggshellBands, this.eggshellQuantize, this.eggshellSoftness,
            this.speckleStrength, this.speckleDensity, this.cuticleMottle,
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
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.eggshellBands = source.eggshellBands;
        this.eggshellQuantize = source.eggshellQuantize;
        this.eggshellSoftness = source.eggshellSoftness;
        this.speckleStrength = source.speckleStrength;
        this.speckleDensity = source.speckleDensity;
        this.cuticleMottle = source.cuticleMottle;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicEggshellMaterial';
        if (this.ior !== 1.53) data.ior = this.ior;
        if (this.specularIntensity !== 0.32) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.42) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.10) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.40) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.10) data.transmission = this.transmission;
        if (this.thickness !== 0.003) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.05) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.98, 0.94, 0.86).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularColor.getHex() !== new Color(0.92, 0.90, 0.88).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.eggshellBands !== 3) data.eggshellBands = this.eggshellBands;
        if (this.eggshellQuantize !== 0.4) data.eggshellQuantize = this.eggshellQuantize;
        if (this.eggshellSoftness !== 0.15) data.eggshellSoftness = this.eggshellSoftness;
        if (this.speckleStrength !== 0.0) data.speckleStrength = this.speckleStrength;
        if (this.speckleDensity !== 0.25) data.speckleDensity = this.speckleDensity;
        if (this.cuticleMottle !== 0.10) data.cuticleMottle = this.cuticleMottle;
        if (this.rimGlow !== 0.08) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.96, 0.94, 0.90).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.eggshellBands = json.eggshellBands ?? this.eggshellBands;
        this.eggshellQuantize = json.eggshellQuantize ?? this.eggshellQuantize;
        this.eggshellSoftness = json.eggshellSoftness ?? this.eggshellSoftness;
        this.speckleStrength = json.speckleStrength ?? this.speckleStrength;
        this.speckleDensity = json.speckleDensity ?? this.speckleDensity;
        this.cuticleMottle = json.cuticleMottle ?? this.cuticleMottle;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicEggshellMaterialBatchComponent = {
    materialPtr: 'ui32',
    eggshellBands: 'ui8',
    eggshellQuantize: 'f64',
    eggshellSoftness: 'f64',
    speckleStrength: 'f64',
    speckleDensity: 'f64',
    cuticleMottle: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicEggshellMaterial,
    OrganicEggshellMaterialBatch,
    EggshellScratchPool,
    OrganicEggshellMaterialBatchComponent,
    OrganicEggshellPresets,
    applyEggshellCelBanding,
    gradeEggshellColor,
    generateEggshellSpeckleTexture
};

export default OrganicEggshellMaterial;