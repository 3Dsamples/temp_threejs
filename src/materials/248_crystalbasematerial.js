// file number : 248
// full path name : src/materials/248_crystalbasematerial.js
// description : CrystalBaseMaterial — foundational crystal material for
//               real-time rendering of transparent crystalline solids.
//               Extends MeshPhysicalMaterial with purpose-built defaults
//               matching published crystal PBR references: high transmission
//               (0.85–0.98), low roughness (0.02–0.12), wavelength-dependent
//               attenuation (for subtle crystal tint), and strong specular
//               glints. Adds crystal-specific dispersion approximation,
//               internal-inclusion scatter, cel-banded crystal highlights,
//               mood tinting, rim glow, and per-instance variation. Includes
//               a procedural crystal-inclusion texture generator using
//               multi-octave fBm with hashed bubble and cleavage-plane
//               streaks. All imports resolve to the internal Threejs_gl
//               repository tree; no CDN dependencies.
// best for : Base crystal material for gemstones, mineral specimens,
//            ice crystals, magical crystals, fantasy crystal formations, and
//            any transparent crystalline solid that needs real-time PBR +
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

/** @type {Quat} Scratch quaternion for rotation staging. */
const _scratchQuat = new Quat();

// ---------------------------------------------------------------------------
// Crystal base presets — physically grounded PBR parameter sets.
// ---------------------------------------------------------------------------

const CrystalBasePresets = {
    'clear-crystal': {
        color: [0.96, 0.97, 0.98],
        roughness: 0.04,
        metalness: 0.0,
        clearcoat: 0.95,
        clearcoatRoughness: 0.02,
        transmission: 0.96,
        thickness: 0.15,
        attenuationDistance: 0.50,
        attenuationColor: [0.96, 0.98, 0.99],
        ior: 1.54,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 0.85,
        specularColor: [1.0, 1.0, 1.0],
        dispersionStrength: 0.10,
        inclusionDensity: 0.08
    },
    'faint-rose-crystal': {
        color: [0.96, 0.88, 0.90],
        roughness: 0.05,
        metalness: 0.0,
        clearcoat: 0.92,
        clearcoatRoughness: 0.03,
        transmission: 0.94,
        thickness: 0.15,
        attenuationDistance: 0.45,
        attenuationColor: [0.95, 0.82, 0.86],
        ior: 1.55,
        iridescence: 0.05,
        iridescenceIOR: 1.32,
        iridescenceThicknessRange: [120, 450],
        specularIntensity: 0.82,
        specularColor: [1.0, 0.96, 0.98],
        dispersionStrength: 0.12,
        inclusionDensity: 0.10
    },
    'faint-blue-crystal': {
        color: [0.88, 0.92, 0.98],
        roughness: 0.05,
        metalness: 0.0,
        clearcoat: 0.92,
        clearcoatRoughness: 0.03,
        transmission: 0.94,
        thickness: 0.15,
        attenuationDistance: 0.45,
        attenuationColor: [0.82, 0.88, 0.96],
        ior: 1.55,
        iridescence: 0.08,
        iridescenceIOR: 1.33,
        iridescenceThicknessRange: [140, 480],
        specularIntensity: 0.82,
        specularColor: [0.96, 0.98, 1.0],
        dispersionStrength: 0.12,
        inclusionDensity: 0.10
    },
    'smoky-crystal': {
        color: [0.72, 0.70, 0.68],
        roughness: 0.06,
        metalness: 0.0,
        clearcoat: 0.88,
        clearcoatRoughness: 0.04,
        transmission: 0.90,
        thickness: 0.18,
        attenuationDistance: 0.40,
        attenuationColor: [0.68, 0.66, 0.64],
        ior: 1.55,
        iridescence: 0.03,
        iridescenceIOR: 1.32,
        iridescenceThicknessRange: [120, 420],
        specularIntensity: 0.80,
        specularColor: [0.98, 0.98, 0.96],
        dispersionStrength: 0.08,
        inclusionDensity: 0.14
    },
    'ice-crystal': {
        color: [0.92, 0.96, 1.0],
        roughness: 0.03,
        metalness: 0.0,
        clearcoat: 0.98,
        clearcoatRoughness: 0.01,
        transmission: 0.97,
        thickness: 0.12,
        attenuationDistance: 0.55,
        attenuationColor: [0.90, 0.95, 1.0],
        ior: 1.31,
        iridescence: 0.12,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [150, 500],
        specularIntensity: 0.90,
        specularColor: [0.96, 0.99, 1.0],
        dispersionStrength: 0.06,
        inclusionDensity: 0.06
    },
    'anime-crystal': {
        color: [0.96, 0.94, 0.98],
        roughness: 0.02,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.01,
        transmission: 0.98,
        thickness: 0.15,
        attenuationDistance: 0.55,
        attenuationColor: [0.94, 0.92, 0.98],
        ior: 1.55,
        iridescence: 0.20,
        iridescenceIOR: 1.35,
        iridescenceThicknessRange: [180, 550],
        specularIntensity: 0.95,
        specularColor: [1.0, 0.98, 1.0],
        dispersionStrength: 0.18,
        inclusionDensity: 0.05
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable crystal scratch records
// ---------------------------------------------------------------------------

class CrystalBaseScratchPool {
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

const _crystalBaseScratchPool = new CrystalBaseScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — crystal-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded crystal highlights. Crystal clearcoat has extremely crisp
 * specular edges — quantizing the luminance into discrete bands produces the
 * flat anime crystal shine.
 */
function applyCrystalCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.04) {
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
 * Apply mood-based tinting to crystal. Warm moods push crystal toward warm
 * amber, cool moods toward cool cyan — matching the atmospheric crystal
 * tinting in stylized fantasy scenes.
 */
function gradeCrystalColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.035;
    g += temperature * 0.015;
    b -= temperature * 0.030;

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
 * Generate a procedural crystal-inclusion texture. Combines multi-octave fBm
 * for the body-tone mottle, hashed bubble cells for trapped inclusions, and
 * optional cleavage-plane streaks.
 */
function generateCrystalInclusionTexture(width, height, scale = 0.03, octaves = 4, inclusionDensity = 0.08, bubbleSize = 0.30, cleavageStrength = 0.15, mottleStrength = 0.06) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Multi-octave fBm body tone
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

            // Hashed bubble inclusions
            let bubble = 0;
            if (inclusionDensity > 0) {
                const cellX = Math.floor(x * 0.3);
                const cellY = Math.floor(y * 0.3);
                const cellId = cellX * 73856093 ^ cellY * 19349663;
                const hash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;
                if (hash > (1.0 - inclusionDensity)) {
                    const h2 = Math.abs(Math.sin(cellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                    const h3 = Math.abs(Math.sin(cellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                    const cx = (x * 0.3) - cellX - h2;
                    const cy = (y * 0.3) - cellY - h3;
                    const dist = Math.sqrt(cx * cx + cy * cy);
                    bubble = Math.max(0, 1.0 - dist / bubbleSize) * 0.30;
                }
            }

            // Cleavage-plane streaks
            let cleavage = 0;
            if (cleavageStrength > 0) {
                const streak = SimplexNoise.noise2D(x * 0.01, y * 0.15) * 0.5 + 0.5;
                cleavage = Math.pow(1.0 - Math.abs(streak * 2.0 - 1.0), 3.0) * cleavageStrength;
            }

            // Fine mottle
            const mottle = SimplexNoise.noise2D(x * 0.6, y * 0.6) * mottleStrength;

            let value = 0.55
                + (fbm - 0.5) * 0.15
                + bubble * 0.25
                - cleavage * 0.20
                + mottle;
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

const _crystalBaseWorld = BitECS.createWorld();
const CrystalBaseMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    crystalBands: 'ui8',
    crystalQuantize: 'f64',
    crystalSoftness: 'f64',
    dispersionStrength: 'f64',
    dispersionColorR: 'f64',
    dispersionColorG: 'f64',
    dispersionColorB: 'f64',
    inclusionDensity: 'f64',
    bubbleSize: 'f64',
    cleavageStrength: 'f64',
    mottleStrength: 'f64',
    internalGlowIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class CrystalBaseMaterialBatch {
    constructor() {
        this.world = _crystalBaseWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, CrystalBaseMaterialComponent, eid);
        CrystalBaseMaterialComponent.materialPtr[eid] = this.materials.length;
        CrystalBaseMaterialComponent.crystalBands[eid] = material.crystalBands;
        CrystalBaseMaterialComponent.crystalQuantize[eid] = material.crystalQuantize;
        CrystalBaseMaterialComponent.crystalSoftness[eid] = material.crystalSoftness;
        CrystalBaseMaterialComponent.dispersionStrength[eid] = material.dispersionStrength;
        CrystalBaseMaterialComponent.dispersionColorR[eid] = material.dispersionColor.r;
        CrystalBaseMaterialComponent.dispersionColorG[eid] = material.dispersionColor.g;
        CrystalBaseMaterialComponent.dispersionColorB[eid] = material.dispersionColor.b;
        CrystalBaseMaterialComponent.inclusionDensity[eid] = material.inclusionDensity;
        CrystalBaseMaterialComponent.bubbleSize[eid] = material.bubbleSize;
        CrystalBaseMaterialComponent.cleavageStrength[eid] = material.cleavageStrength;
        CrystalBaseMaterialComponent.mottleStrength[eid] = material.mottleStrength;
        CrystalBaseMaterialComponent.internalGlowIntensity[eid] = material.internalGlowIntensity;
        CrystalBaseMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        CrystalBaseMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        CrystalBaseMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        CrystalBaseMaterialComponent.moodContrast[eid] = material.moodContrast;
        CrystalBaseMaterialComponent.rimGlow[eid] = material.rimGlow;
        CrystalBaseMaterialComponent.variationSeed[eid] = material.variationSeed;
        CrystalBaseMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[CrystalBaseMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.crystalBands = CrystalBaseMaterialComponent.crystalBands[eid];
            material.crystalQuantize = CrystalBaseMaterialComponent.crystalQuantize[eid];
            material.crystalSoftness = CrystalBaseMaterialComponent.crystalSoftness[eid];
            material.dispersionStrength = CrystalBaseMaterialComponent.dispersionStrength[eid];
            material.dispersionColor.setRGB(
                CrystalBaseMaterialComponent.dispersionColorR[eid],
                CrystalBaseMaterialComponent.dispersionColorG[eid],
                CrystalBaseMaterialComponent.dispersionColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.inclusionDensity = CrystalBaseMaterialComponent.inclusionDensity[eid];
            material.bubbleSize = CrystalBaseMaterialComponent.bubbleSize[eid];
            material.cleavageStrength = CrystalBaseMaterialComponent.cleavageStrength[eid];
            material.mottleStrength = CrystalBaseMaterialComponent.mottleStrength[eid];
            material.internalGlowIntensity = CrystalBaseMaterialComponent.internalGlowIntensity[eid];
            material.moodTemperature = CrystalBaseMaterialComponent.moodTemperature[eid];
            material.moodSaturation = CrystalBaseMaterialComponent.moodSaturation[eid];
            material.moodBrightness = CrystalBaseMaterialComponent.moodBrightness[eid];
            material.moodContrast = CrystalBaseMaterialComponent.moodContrast[eid];
            material.rimGlow = CrystalBaseMaterialComponent.rimGlow[eid];
            material.variationSeed = CrystalBaseMaterialComponent.variationSeed[eid];

            CrystalBaseMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main CrystalBaseMaterial class
// ---------------------------------------------------------------------------

class CrystalBaseMaterial extends MeshPhysicalMaterial {
    static {
        _crystalBaseScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isCrystalBaseMaterial = true;
        this.type = 'CrystalBaseMaterial';

        // Crystal-specific PBR defaults (clear-crystal baseline)
        this.ior = 1.54;
        this.specularIntensity = 0.85;
        this.roughness = 0.04;
        this.metalness = 0.0;
        this.specularColor = new Color(1.0, 1.0, 1.0);
        this.color = new Color(0.96, 0.97, 0.98);

        // Clearcoat for the polished crystal surface
        this.clearcoat = 0.95;
        this.clearcoatRoughness = 0.02;

        // High transmission for the transparent body
        this.transmission = 0.96;
        this.thickness = 0.15;
        this.attenuationDistance = 0.50;
        this.attenuationColor = new Color(0.96, 0.98, 0.99);

        // Iridescence for subtle rainbow shimmer (optional)
        this.iridescence = 0.0;
        this.iridescenceIOR = 1.30;
        this.iridescenceThicknessRange = [100, 400];

        // Sheen off (crystals have no fur/fabric sheen)
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // Anime extensions
        this.crystalBands = 4;
        this.crystalQuantize = 0.5;
        this.crystalSoftness = 0.04;

        // Dispersion approximation
        this.dispersionStrength = 0.10;
        this.dispersionColor = new Color(0.85, 0.92, 1.0);

        // Internal inclusion controls
        this.inclusionDensity = 0.08;
        this.bubbleSize = 0.30;
        this.cleavageStrength = 0.15;
        this.mottleStrength = 0.06;
        this.internalGlowIntensity = 0.15;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(0.92, 0.96, 1.0);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // PBR ↔ Anime blend
        this.renderStyleBlend = 0.35;

        // Galactic-scale configuration
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    applyCrystalBanding(baseColor, output) {
        return applyCrystalCelBanding(
            baseColor,
            output,
            this.crystalBands,
            this.crystalQuantize,
            this.crystalSoftness
        );
    }

    updateMoodColor() {
        gradeCrystalColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    applyPreset(presetName) {
        const preset = CrystalBasePresets[presetName];
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
        this.ior = preset.ior;
        this.iridescence = preset.iridescence;
        this.iridescenceIOR = preset.iridescenceIOR;
        this.iridescenceThicknessRange = preset.iridescenceThicknessRange.slice();
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.dispersionStrength = preset.dispersionStrength;
        this.inclusionDensity = preset.inclusionDensity;

        if (presetName === 'anime-crystal') {
            this.crystalSoftness = 0.02;
            this.crystalBands = 5;
        } else if (presetName === 'ice-crystal') {
            this.crystalSoftness = 0.03;
            this.crystalBands = 4;
        } else {
            this.crystalSoftness = 0.04;
            this.crystalBands = 4;
        }

        this.updateMoodColor();
        return this;
    }

    generateCrystalInclusionTexture(width, height, scale = 0.03, octaves = 4, inclusionDensity = 0.08, bubbleSize = 0.30, cleavageStrength = 0.15) {
        return generateCrystalInclusionTexture(width, height, scale, octaves, inclusionDensity, bubbleSize, cleavageStrength, this.mottleStrength);
    }

    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    async initialize() {
        await Promise.resolve();
        return this;
    }

    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.crystalBands = { value: this.crystalBands };
        shader.uniforms.crystalQuantize = { value: this.crystalQuantize };
        shader.uniforms.crystalSoftness = { value: this.crystalSoftness };
        shader.uniforms.dispersionStrength = { value: this.dispersionStrength };
        shader.uniforms.dispersionColor = { value: this.dispersionColor };
        shader.uniforms.inclusionDensity = { value: this.inclusionDensity };
        shader.uniforms.bubbleSize = { value: this.bubbleSize };
        shader.uniforms.cleavageStrength = { value: this.cleavageStrength };
        shader.uniforms.mottleStrength = { value: this.mottleStrength };
        shader.uniforms.internalGlowIntensity = { value: this.internalGlowIntensity };
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
                uniform int crystalBands;
                uniform float crystalQuantize;
                uniform float crystalSoftness;
                uniform float dispersionStrength;
                uniform vec3 dispersionColor;
                uniform float inclusionDensity;
                uniform float bubbleSize;
                uniform float cleavageStrength;
                uniform float mottleStrength;
                uniform float internalGlowIntensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyCrystalBands(vec3 baseColor) {
                    if (crystalBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(crystalBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * crystalSoftness;
                    float finalLum = mix(lum, softQuantized, crystalQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply crystal cel banding
                gl_FragColor.rgb = applyCrystalBands(gl_FragColor.rgb);

                // Dispersion approximation: subtle rainbow shift at grazing angles
                if (dispersionStrength > 0.0) {
                    float ndotvCrystal = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float dispersionMask = pow(1.0 - ndotvCrystal, 2.0) * dispersionStrength;
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * dispersionColor * 1.2, dispersionMask);
                }

                // Internal inclusion approximation: hashed bubble cells
                if (inclusionDensity > 0.0) {
                    vec2 bubbleUV = vUv * 40.0;
                    vec2 bubbleCell = floor(bubbleUV);
                    vec2 bubbleFrac = fract(bubbleUV);
                    float bubbleHash = fract(sin(dot(bubbleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (bubbleHash > (1.0 - inclusionDensity)) {
                        vec2 bubbleCentre = vec2(fract(bubbleHash * 7.31), fract(bubbleHash * 13.7));
                        float bubbleDist = length(bubbleFrac - bubbleCentre);
                        float bubbleMask = max(0.0, 1.0 - bubbleDist / bubbleSize) * 0.20;
                        gl_FragColor.rgb += vec3(bubbleMask);
                    }
                }

                // Cleavage-plane streaks
                if (cleavageStrength > 0.0) {
                    float cleavage = sin(vUv.y * 30.0 + variationOffset) * 0.5 + 0.5;
                    float cleavageMask = pow(cleavage, 3.0) * cleavageStrength;
                    gl_FragColor.rgb *= (1.0 - cleavageMask * 0.15);
                }

                // Internal glow
                if (internalGlowIntensity > 0.0) {
                    gl_FragColor.rgb += dispersionColor * internalGlowIntensity * 0.10;
                }

                // Cool rim glow on crystal edges
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
            this.iridescence, this.iridescenceIOR,
            this.crystalBands, this.crystalQuantize, this.crystalSoftness,
            this.dispersionStrength, this.dispersionColor.r,
            this.inclusionDensity, this.bubbleSize, this.cleavageStrength,
            this.mottleStrength, this.internalGlowIntensity,
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
        this.iridescence = source.iridescence;
        this.iridescenceIOR = source.iridescenceIOR;
        this.iridescenceThicknessRange = source.iridescenceThicknessRange.slice();
        this.crystalBands = source.crystalBands;
        this.crystalQuantize = source.crystalQuantize;
        this.crystalSoftness = source.crystalSoftness;
        this.dispersionStrength = source.dispersionStrength;
        this.dispersionColor.copy(source.dispersionColor);
        this.inclusionDensity = source.inclusionDensity;
        this.bubbleSize = source.bubbleSize;
        this.cleavageStrength = source.cleavageStrength;
        this.mottleStrength = source.mottleStrength;
        this.internalGlowIntensity = source.internalGlowIntensity;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'CrystalBaseMaterial';
        if (this.ior !== 1.54) data.ior = this.ior;
        if (this.specularIntensity !== 0.85) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.04) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.95) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.02) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.96) data.transmission = this.transmission;
        if (this.thickness !== 0.15) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.50) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.96, 0.98, 0.99).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.iridescence !== 0.0) data.iridescence = this.iridescence;
        if (this.iridescenceIOR !== 1.30) data.iridescenceIOR = this.iridescenceIOR;
        if (this.crystalBands !== 4) data.crystalBands = this.crystalBands;
        if (this.crystalQuantize !== 0.5) data.crystalQuantize = this.crystalQuantize;
        if (this.crystalSoftness !== 0.04) data.crystalSoftness = this.crystalSoftness;
        if (this.dispersionStrength !== 0.10) data.dispersionStrength = this.dispersionStrength;
        if (this.dispersionColor.getHex() !== new Color(0.85, 0.92, 1.0).getHex()) data.dispersionColor = this.dispersionColor.getHex();
        if (this.inclusionDensity !== 0.08) data.inclusionDensity = this.inclusionDensity;
        if (this.bubbleSize !== 0.30) data.bubbleSize = this.bubbleSize;
        if (this.cleavageStrength !== 0.15) data.cleavageStrength = this.cleavageStrength;
        if (this.mottleStrength !== 0.06) data.mottleStrength = this.mottleStrength;
        if (this.internalGlowIntensity !== 0.15) data.internalGlowIntensity = this.internalGlowIntensity;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.92, 0.96, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.iridescence = json.iridescence ?? this.iridescence;
        this.iridescenceIOR = json.iridescenceIOR ?? this.iridescenceIOR;
        if (json.iridescenceThicknessRange) this.iridescenceThicknessRange = json.iridescenceThicknessRange.slice();
        this.crystalBands = json.crystalBands ?? this.crystalBands;
        this.crystalQuantize = json.crystalQuantize ?? this.crystalQuantize;
        this.crystalSoftness = json.crystalSoftness ?? this.crystalSoftness;
        this.dispersionStrength = json.dispersionStrength ?? this.dispersionStrength;
        if (json.dispersionColor !== undefined) this.dispersionColor.setHex(json.dispersionColor);
        this.inclusionDensity = json.inclusionDensity ?? this.inclusionDensity;
        this.bubbleSize = json.bubbleSize ?? this.bubbleSize;
        this.cleavageStrength = json.cleavageStrength ?? this.cleavageStrength;
        this.mottleStrength = json.mottleStrength ?? this.mottleStrength;
        this.internalGlowIntensity = json.internalGlowIntensity ?? this.internalGlowIntensity;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const CrystalBaseMaterialBatchComponent = {
    materialPtr: 'ui32',
    crystalBands: 'ui8',
    crystalQuantize: 'f64',
    crystalSoftness: 'f64',
    dispersionStrength: 'f64',
    dispersionColorR: 'f64',
    dispersionColorG: 'f64',
    dispersionColorB: 'f64',
    inclusionDensity: 'f64',
    bubbleSize: 'f64',
    cleavageStrength: 'f64',
    mottleStrength: 'f64',
    internalGlowIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    CrystalBaseMaterial,
    CrystalBaseMaterialBatch,
    CrystalBaseScratchPool,
    CrystalBaseMaterialBatchComponent,
    CrystalBasePresets,
    applyCrystalCelBanding,
    gradeCrystalColor,
    generateCrystalInclusionTexture
};

export default CrystalBaseMaterial;