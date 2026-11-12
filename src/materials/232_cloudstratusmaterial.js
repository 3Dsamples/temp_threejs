// file number : 232
// full path name : src/materials/232_cloudstratusmaterial.js
// description : CloudStratusMaterial — a ready-to-use stratus cloud material
//               for layered low-altitude clouds, fog banks, overcast skies,
//               morning mist, marine layers, and altostratus sheets. Extends
//               MeshPhysicalMaterial with purpose-built presets for thin
//               stratus, dense overcast, morning mist, marine layer, and
//               altostratus. Includes stratus-appropriate PBR defaults (very
//               high roughness 0.90–0.96, low transmission 0.15–0.30 for
//               shallower vertical scatter than cumulus, wide attenuation
//               distance 0.20–0.40, and low sheen 0.15–0.30 for the flat,
//               layered look) plus real-time anime stylization: cel-banded
//               stratus highlights, flat-layer approximation, mood tinting
//               (overcast-grey, sunrise-pink, snowy-cyan), rim glow, and
//               per-instance variation. Includes a procedural stratus-layer
//               texture generator using horizontally-stretched multi-octave
//               fBm with soft banding and optional fog-edge erosion.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Stratus clouds, overcast skies, fog banks, morning mist, marine
//            layers, altostratus, stratus sheets, atmospheric haze, anime
//            overcast backgrounds, and any stratus cloud surface that needs
//            real-time PBR + anime stylization.
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
// Stratus cloud presets — physically grounded PBR parameter sets for
// stratus cloud types.
//
// Reference values (from real-time volumetric cloud references: Nubis Evolved
// by Guerrilla Games, three-volumetric-clouds, Universal Planetary Volumetric
// Cloud engine, and Unreal Engine Volumetric Cloud Component):
//   - Stratus is a low, uniform, horizontally-layered cloud with limited
//     vertical extent. Distinctly different from cumulus:
//       * Very high roughness (0.90–0.96): soft, flat, layered scatter
//       * Low transmission (0.15–0.30): shallower vertical light path
//       * Wide attenuation distance (0.20–0.40): long horizontal scatter
//       * Low sheen (0.15–0.30): less silver-lining than cumulus
//       * Higher albedo whiteness for overcast → grey for storm stratus
//   - Cloud IOR ≈ 1.0003; metalness = 0
// ---------------------------------------------------------------------------

const CloudStratusPresets = {
    'thin-stratus': {
        color: [0.92, 0.92, 0.94],
        roughness: 0.92,
        metalness: 0.0,
        transmission: 0.30,
        thickness: 0.08,
        attenuationDistance: 0.30,
        attenuationColor: [0.94, 0.94, 0.96],
        sheen: 0.25,
        sheenColor: [0.98, 0.98, 1.0],
        sheenRoughness: 0.55,
        specularIntensity: 0.28,
        specularColor: [1.0, 1.0, 1.0],
        powderIntensity: 0.35,
        anisotropyG: 0.75
    },
    'dense-overcast': {
        color: [0.72, 0.74, 0.78],
        roughness: 0.95,
        metalness: 0.0,
        transmission: 0.18,
        thickness: 0.20,
        attenuationDistance: 0.22,
        attenuationColor: [0.74, 0.76, 0.80],
        sheen: 0.18,
        sheenColor: [0.82, 0.84, 0.88],
        sheenRoughness: 0.65,
        specularIntensity: 0.22,
        specularColor: [0.85, 0.86, 0.90],
        powderIntensity: 0.55,
        anisotropyG: 0.72
    },
    'morning-mist': {
        color: [0.94, 0.94, 0.96],
        roughness: 0.94,
        metalness: 0.0,
        transmission: 0.34,
        thickness: 0.05,
        attenuationDistance: 0.40,
        attenuationColor: [0.96, 0.96, 0.98],
        sheen: 0.30,
        sheenColor: [1.0, 1.0, 1.0],
        sheenRoughness: 0.50,
        specularIntensity: 0.30,
        specularColor: [1.0, 1.0, 1.0],
        powderIntensity: 0.30,
        anisotropyG: 0.78
    },
    'marine-layer': {
        color: [0.82, 0.84, 0.88],
        roughness: 0.93,
        metalness: 0.0,
        transmission: 0.24,
        thickness: 0.12,
        attenuationDistance: 0.35,
        attenuationColor: [0.84, 0.88, 0.92],
        sheen: 0.22,
        sheenColor: [0.90, 0.93, 0.98],
        sheenRoughness: 0.60,
        specularIntensity: 0.25,
        specularColor: [0.92, 0.94, 0.98],
        powderIntensity: 0.40,
        anisotropyG: 0.75
    },
    'altostratus': {
        color: [0.86, 0.86, 0.88],
        roughness: 0.90,
        metalness: 0.0,
        transmission: 0.28,
        thickness: 0.10,
        attenuationDistance: 0.32,
        attenuationColor: [0.90, 0.90, 0.92],
        sheen: 0.20,
        sheenColor: [0.94, 0.94, 0.96],
        sheenRoughness: 0.60,
        specularIntensity: 0.26,
        specularColor: [0.96, 0.96, 0.98],
        powderIntensity: 0.35,
        anisotropyG: 0.73
    },
    'sunrise-stratus': {
        color: [0.98, 0.86, 0.78],
        roughness: 0.90,
        metalness: 0.0,
        transmission: 0.32,
        thickness: 0.10,
        attenuationDistance: 0.36,
        attenuationColor: [1.0, 0.86, 0.74],
        sheen: 0.35,
        sheenColor: [1.0, 0.90, 0.80],
        sheenRoughness: 0.45,
        specularIntensity: 0.34,
        specularColor: [1.0, 0.92, 0.82],
        powderIntensity: 0.35,
        anisotropyG: 0.76
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable stratus scratch records
// ---------------------------------------------------------------------------

class CloudStratusScratchPool {
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

const _cloudStratusScratchPool = new CloudStratusScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — stratus-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded stratus highlights. Stratus clouds have very soft, flat,
 * layered shading — quantizing the luminance into discrete bands produces
 * the flat overcast anime sky look seen in moody Ghibli-style backgrounds.
 */
function applyStratusCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.22) {
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
 * Apply mood-based tinting to stratus clouds. Warm moods push clouds toward
 * warm sunrise pink/peach, cool moods toward cool snowy-cyan, and neutral
 * moods keep the flat grey overcast palette.
 */
function gradeCloudStratusColor(color, temperature, saturation, brightness, contrast) {
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

    // Stratus-specific temperature bias: warm shift pushes toward sunrise pink
    // (R up, G slightly up, B down); cool shift pushes toward snowy-cyan
    // (B up, R slightly down).
    r += temperature * 0.04;
    g += temperature * 0.015;
    b -= temperature * 0.035;

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
 * Generate a procedural stratus-layer texture. The algorithm:
 * 1. Horizontally-stretched multi-octave fBm: sample noise at low frequency
 *    along X and high frequency along Y to produce the characteristic
 *    horizontal layering of stratus clouds.
 * 2. Soft banding: a sinusoid on the V axis adds the layered streaking.
 * 3. Optional fog-edge erosion: low-frequency noise erodes the layer edges
 *    to give the wispy, dispersed look of morning mist.
 * The output is a grayscale density map suitable for volume-density use, or
 * for driving the alpha of billboarded stratus impostors.
 */
function generateStratusLayerTexture(width, height, scaleX = 0.008, scaleY = 0.05, octaves = 4, bandStrength = 0.30, bandFrequency = 6.0, erosionStrength = 0.20) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Horizontally-stretched fBm ---
            let fbm = 0;
            let amplitude = 1;
            let fX = scaleX;
            let fY = scaleY;
            let maxAmplitude = 0;
            for (let o = 0; o < octaves; o++) {
                fbm += SimplexNoise.noise2D(x * fX, y * fY) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                fX *= 2.0;
                fY *= 2.0;
            }
            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;

            // --- 2. Soft horizontal banding ---
            const band = Math.sin((y / height) * bandFrequency * Math.PI * 2.0) * 0.5 + 0.5;
            const bandMask = band * bandStrength;

            // --- 3. Fog-edge erosion ---
            const erosion = SimplexNoise.noise2D(x * 0.01, y * 0.01) * 0.5 + 0.5;
            const erosionMask = Math.max(0, erosion - 0.4) / 0.6 * erosionStrength;

            // --- Combine ---
            let value = fbm * 0.85 + bandMask * 0.15 - erosionMask * 0.30;
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

const _cloudStratusWorld = BitECS.createWorld();
const CloudStratusMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    stratusBands: 'ui8',
    stratusQuantize: 'f64',
    stratusSoftness: 'f64',
    layerStrength: 'f64',
    layerFrequency: 'f64',
    erosionStrength: 'f64',
    powderIntensity: 'f64',
    silverLiningIntensity: 'f64',
    anisotropyG: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class CloudStratusMaterialBatch {
    constructor() {
        this.world = _cloudStratusWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, CloudStratusMaterialComponent, eid);
        CloudStratusMaterialComponent.materialPtr[eid] = this.materials.length;
        CloudStratusMaterialComponent.stratusBands[eid] = material.stratusBands;
        CloudStratusMaterialComponent.stratusQuantize[eid] = material.stratusQuantize;
        CloudStratusMaterialComponent.stratusSoftness[eid] = material.stratusSoftness;
        CloudStratusMaterialComponent.layerStrength[eid] = material.layerStrength;
        CloudStratusMaterialComponent.layerFrequency[eid] = material.layerFrequency;
        CloudStratusMaterialComponent.erosionStrength[eid] = material.erosionStrength;
        CloudStratusMaterialComponent.powderIntensity[eid] = material.powderIntensity;
        CloudStratusMaterialComponent.silverLiningIntensity[eid] = material.silverLiningIntensity;
        CloudStratusMaterialComponent.anisotropyG[eid] = material.anisotropyG;
        CloudStratusMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        CloudStratusMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        CloudStratusMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        CloudStratusMaterialComponent.moodContrast[eid] = material.moodContrast;
        CloudStratusMaterialComponent.rimGlow[eid] = material.rimGlow;
        CloudStratusMaterialComponent.variationSeed[eid] = material.variationSeed;
        CloudStratusMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[CloudStratusMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.stratusBands = CloudStratusMaterialComponent.stratusBands[eid];
            material.stratusQuantize = CloudStratusMaterialComponent.stratusQuantize[eid];
            material.stratusSoftness = CloudStratusMaterialComponent.stratusSoftness[eid];
            material.layerStrength = CloudStratusMaterialComponent.layerStrength[eid];
            material.layerFrequency = CloudStratusMaterialComponent.layerFrequency[eid];
            material.erosionStrength = CloudStratusMaterialComponent.erosionStrength[eid];
            material.powderIntensity = CloudStratusMaterialComponent.powderIntensity[eid];
            material.silverLiningIntensity = CloudStratusMaterialComponent.silverLiningIntensity[eid];
            material.anisotropyG = CloudStratusMaterialComponent.anisotropyG[eid];
            material.moodTemperature = CloudStratusMaterialComponent.moodTemperature[eid];
            material.moodSaturation = CloudStratusMaterialComponent.moodSaturation[eid];
            material.moodBrightness = CloudStratusMaterialComponent.moodBrightness[eid];
            material.moodContrast = CloudStratusMaterialComponent.moodContrast[eid];
            material.rimGlow = CloudStratusMaterialComponent.rimGlow[eid];
            material.variationSeed = CloudStratusMaterialComponent.variationSeed[eid];

            CloudStratusMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main CloudStratusMaterial class
// ---------------------------------------------------------------------------

class CloudStratusMaterial extends MeshPhysicalMaterial {
    static {
        _cloudStratusScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isCloudStratusMaterial = true;
        this.type = 'CloudStratusMaterial';

        // -------------------------------------------------------------------
        // Stratus-specific PBR defaults (thin-stratus baseline)
        // -------------------------------------------------------------------
        this.ior = 1.0003;
        this.specularIntensity = 0.28;
        this.roughness = 0.92;
        this.metalness = 0.0;
        this.specularColor = new Color(1.0, 1.0, 1.0);
        this.color = new Color(0.92, 0.92, 0.94);

        // Low transmission for shallow vertical scatter
        this.transmission = 0.30;
        this.thickness = 0.08;
        this.attenuationDistance = 0.30;
        this.attenuationColor = new Color(0.94, 0.94, 0.96);

        // Low sheen for the flat, layered look
        this.sheen = 0.25;
        this.sheenColor = new Color(0.98, 0.98, 1.0);
        this.sheenRoughness = 0.55;

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — stratus-specific
        // -------------------------------------------------------------------
        this.stratusBands = 2;
        this.stratusQuantize = 0.35;
        this.stratusSoftness = 0.22;

        // Layer / erosion / powder / silver-lining controls
        this.layerStrength = 0.30;
        this.layerFrequency = 6.0;
        this.erosionStrength = 0.20;
        this.powderIntensity = 0.35;
        this.silverLiningIntensity = 0.25;
        this.anisotropyG = 0.75;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.08;
        this.rimGlowColor = new Color(0.95, 0.95, 1.0);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (stratus leans semi-realistic)
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

    applyStratusBanding(baseColor, output) {
        return applyStratusCelBanding(
            baseColor,
            output,
            this.stratusBands,
            this.stratusQuantize,
            this.stratusSoftness
        );
    }

    updateMoodColor() {
        gradeCloudStratusColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named stratus preset to this material.
     * @param {string} presetName - One of the keys of `CloudStratusPresets`.
     * @returns {CloudStratusMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = CloudStratusPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.transmission = preset.transmission;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.powderIntensity = preset.powderIntensity;
        this.anisotropyG = preset.anisotropyG;

        // Per-preset anime tuning
        if (presetName === 'dense-overcast') {
            this.stratusSoftness = 0.30;
            this.stratusBands = 2;
            this.silverLiningIntensity = 0.10;
            this.layerStrength = 0.15;
            this.erosionStrength = 0.10;
        } else if (presetName === 'morning-mist') {
            this.stratusSoftness = 0.35;
            this.stratusBands = 2;
            this.silverLiningIntensity = 0.35;
            this.layerStrength = 0.20;
            this.erosionStrength = 0.35;
        } else if (presetName === 'sunrise-stratus') {
            this.stratusSoftness = 0.18;
            this.stratusBands = 3;
            this.silverLiningIntensity = 0.45;
            this.layerStrength = 0.30;
            this.erosionStrength = 0.20;
        } else {
            this.stratusSoftness = 0.22;
            this.stratusBands = 2;
            this.silverLiningIntensity = 0.25;
        }

        this.updateMoodColor();
        return this;
    }

    generateStratusLayerTexture(width, height, scaleX = 0.008, scaleY = 0.05, octaves = 4, bandStrength = 0.30, bandFrequency = 6.0, erosionStrength = 0.20) {
        return generateStratusLayerTexture(width, height, scaleX, scaleY, octaves, bandStrength, bandFrequency, erosionStrength);
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

        shader.uniforms.stratusBands = { value: this.stratusBands };
        shader.uniforms.stratusQuantize = { value: this.stratusQuantize };
        shader.uniforms.stratusSoftness = { value: this.stratusSoftness };
        shader.uniforms.layerStrength = { value: this.layerStrength };
        shader.uniforms.layerFrequency = { value: this.layerFrequency };
        shader.uniforms.erosionStrength = { value: this.erosionStrength };
        shader.uniforms.powderIntensity = { value: this.powderIntensity };
        shader.uniforms.silverLiningIntensity = { value: this.silverLiningIntensity };
        shader.uniforms.anisotropyG = { value: this.anisotropyG };
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
                uniform int stratusBands;
                uniform float stratusQuantize;
                uniform float stratusSoftness;
                uniform float layerStrength;
                uniform float layerFrequency;
                uniform float erosionStrength;
                uniform float powderIntensity;
                uniform float silverLiningIntensity;
                uniform float anisotropyG;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyStratusBands(vec3 baseColor) {
                    if (stratusBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(stratusBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * stratusSoftness;
                    float finalLum = mix(lum, softQuantized, stratusQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply stratus cel banding
                gl_FragColor.rgb = applyStratusBands(gl_FragColor.rgb);

                // Horizontal layer banding: soft streaks that mimic the
                // horizontally-layered look of stratus clouds
                if (layerStrength > 0.0) {
                    float layerBand = sin(vUv.y * layerFrequency * 6.28318 + variationOffset) * 0.5 + 0.5;
                    gl_FragColor.rgb *= (0.90 + layerBand * layerStrength * 0.20);
                }

                // Fog-edge erosion (wispy edges of morning mist / thin stratus)
                if (erosionStrength > 0.0) {
                    float erosion = fract(sin(dot(vUv * 30.0 + variationOffset, vec2(12.9898, 78.233))) * 43758.5453);
                    gl_FragColor.a *= mix(1.0, 0.75 + erosion * 0.25, erosionStrength);
                }

                // Powder effect: dense stratus cores appear slightly brighter
                if (powderIntensity > 0.0) {
                    float powder = smoothstep(0.3, 0.7, fract(sin(dot(floor(vUv * 12.0), vec2(12.9898, 78.233))) * 43758.5453));
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), powder * powderIntensity * 0.10);
                }

                // Silver-lining: subtle grazing-angle rim (weaker than cumulus)
                if (silverLiningIntensity > 0.0) {
                    float ndotvStratus = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float hgPhase = (1.0 - anisotropyG * anisotropyG) / pow(1.0 + anisotropyG * anisotropyG - 2.0 * anisotropyG * ndotvStratus, 1.5);
                    float silverLining = pow(1.0 - ndotvStratus, 3.0) * hgPhase * silverLiningIntensity * 0.25;
                    gl_FragColor.rgb += sheenColor * silverLining;
                }

                // Cool-tinted rim glow on stratus edges
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
            this.sheen, this.sheenRoughness,
            this.stratusBands, this.stratusQuantize, this.stratusSoftness,
            this.layerStrength, this.layerFrequency, this.erosionStrength,
            this.powderIntensity, this.silverLiningIntensity, this.anisotropyG,
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
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.stratusBands = source.stratusBands;
        this.stratusQuantize = source.stratusQuantize;
        this.stratusSoftness = source.stratusSoftness;
        this.layerStrength = source.layerStrength;
        this.layerFrequency = source.layerFrequency;
        this.erosionStrength = source.erosionStrength;
        this.powderIntensity = source.powderIntensity;
        this.silverLiningIntensity = source.silverLiningIntensity;
        this.anisotropyG = source.anisotropyG;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'CloudStratusMaterial';
        if (this.ior !== 1.0003) data.ior = this.ior;
        if (this.specularIntensity !== 0.28) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.92) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.transmission !== 0.30) data.transmission = this.transmission;
        if (this.thickness !== 0.08) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.30) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.94, 0.94, 0.96).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.25) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.98, 0.98, 1.0).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.55) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.stratusBands !== 2) data.stratusBands = this.stratusBands;
        if (this.stratusQuantize !== 0.35) data.stratusQuantize = this.stratusQuantize;
        if (this.stratusSoftness !== 0.22) data.stratusSoftness = this.stratusSoftness;
        if (this.layerStrength !== 0.30) data.layerStrength = this.layerStrength;
        if (this.layerFrequency !== 6.0) data.layerFrequency = this.layerFrequency;
        if (this.erosionStrength !== 0.20) data.erosionStrength = this.erosionStrength;
        if (this.powderIntensity !== 0.35) data.powderIntensity = this.powderIntensity;
        if (this.silverLiningIntensity !== 0.25) data.silverLiningIntensity = this.silverLiningIntensity;
        if (this.anisotropyG !== 0.75) data.anisotropyG = this.anisotropyG;
        if (this.rimGlow !== 0.08) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.95, 0.95, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.stratusBands = json.stratusBands ?? this.stratusBands;
        this.stratusQuantize = json.stratusQuantize ?? this.stratusQuantize;
        this.stratusSoftness = json.stratusSoftness ?? this.stratusSoftness;
        this.layerStrength = json.layerStrength ?? this.layerStrength;
        this.layerFrequency = json.layerFrequency ?? this.layerFrequency;
        this.erosionStrength = json.erosionStrength ?? this.erosionStrength;
        this.powderIntensity = json.powderIntensity ?? this.powderIntensity;
        this.silverLiningIntensity = json.silverLiningIntensity ?? this.silverLiningIntensity;
        this.anisotropyG = json.anisotropyG ?? this.anisotropyG;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const CloudStratusMaterialBatchComponent = {
    materialPtr: 'ui32',
    stratusBands: 'ui8',
    stratusQuantize: 'f64',
    stratusSoftness: 'f64',
    layerStrength: 'f64',
    layerFrequency: 'f64',
    erosionStrength: 'f64',
    powderIntensity: 'f64',
    silverLiningIntensity: 'f64',
    anisotropyG: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    CloudStratusMaterial,
    CloudStratusMaterialBatch,
    CloudStratusScratchPool,
    CloudStratusMaterialBatchComponent,
    CloudStratusPresets,
    applyStratusCelBanding,
    gradeCloudStratusColor,
    generateStratusLayerTexture
};

export default CloudStratusMaterial;