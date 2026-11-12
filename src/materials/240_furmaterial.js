// file number : 240
// full path name : src/materials/240_furmaterial.js
// description : FurMaterial — a ready-to-use base fur material for real-time
//               organic fur rendering. Extends MeshPhysicalMaterial with
//               purpose-built presets for common fur types (fox, wolf, bear,
//               rabbit, cat, and deer). Includes biologically grounded
//               defaults matching physical fur references: keratin IOR ≈ 1.55,
//               dual-lobe specular with distinct longitudinal/azimuthal
//               roughness, strong anisotropy along the strand direction,
//               thin-walled transmission for light-through-fur, and a sheen
//               lobe for the soft fur edge. Adds real-time anime stylization:
//               cel-banded fur highlights, dual-lobe highlight splitting,
//               mood tinting, rim glow, and per-instance variation. Includes
//               a procedural fur-strand texture generator using directional
//               fBm with per-strand hashing and optional undercoat/clump noise.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Organic fur, fox fur, wolf fur, bear fur, rabbit fur, cat fur,
//            deer fur, animal pelts, creature coats, stylized anime animal
//            characters, and any fur surface that needs real-time PBR + anime
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
// Fur presets — biologically grounded PBR parameter sets for fur types.
//
// Reference values (from Guerilla Hair2, Pixar PxrMarschnerHair, MoonRay
// HairMaterial_v3, and Houdini Chiang Fur):
//   - Fur IOR:                    ≈ 1.55 (keratin)
//   - Longitudinal roughness:     0.25–0.40 (strand-aligned)
//   - Azimuthal roughness:        0.35–0.60 (across-strand; higher for fur
//                                 than human hair)
//   - Transmission azimuthal roughness: ≈1.0 for animal fur (wide energy
//     spread across the volume)
//   - Dual-lobe specular:         primary near-white sharp, secondary tinted
//     by fur colour and broader
//   - Anisotropy strength:        0.55–0.85 along the strand direction
//   - Sheen:                      0.20–0.45 for the soft fur edge
//   - Metalness:                  0.0 (fur is a dielectric)
// ---------------------------------------------------------------------------

const FurPresets = {
    'fox-red': {
        color: [0.82, 0.42, 0.16],
        roughness: 0.34,
        metalness: 0.0,
        longitudinalRoughness: 0.30,
        azimuthalRoughness: 0.48,
        transmissionAzimuthalRoughness: 1.0,
        anisotropy: 0.72,
        anisotropyRotation: 0.0,
        transmission: 0.20,
        thickness: 0.002,
        attenuationDistance: 0.02,
        attenuationColor: [0.90, 0.52, 0.24],
        sheen: 0.38,
        sheenColor: [0.95, 0.72, 0.42],
        sheenRoughness: 0.45,
        specularIntensity: 0.55,
        specularColor: [0.98, 0.90, 0.80],
        secondaryLobeColor: [0.82, 0.42, 0.16],
        dualLobeRatio: 0.55
    },
    'wolf-grey': {
        color: [0.42, 0.42, 0.44],
        roughness: 0.38,
        metalness: 0.0,
        longitudinalRoughness: 0.34,
        azimuthalRoughness: 0.52,
        transmissionAzimuthalRoughness: 1.0,
        anisotropy: 0.68,
        anisotropyRotation: 0.0,
        transmission: 0.18,
        thickness: 0.002,
        attenuationDistance: 0.02,
        attenuationColor: [0.52, 0.52, 0.54],
        sheen: 0.32,
        sheenColor: [0.68, 0.68, 0.70],
        sheenRoughness: 0.50,
        specularIntensity: 0.52,
        specularColor: [0.88, 0.88, 0.90],
        secondaryLobeColor: [0.42, 0.42, 0.44],
        dualLobeRatio: 0.58
    },
    'bear-brown': {
        color: [0.38, 0.24, 0.14],
        roughness: 0.42,
        metalness: 0.0,
        longitudinalRoughness: 0.38,
        azimuthalRoughness: 0.58,
        transmissionAzimuthalRoughness: 1.0,
        anisotropy: 0.62,
        anisotropyRotation: 0.0,
        transmission: 0.15,
        thickness: 0.002,
        attenuationDistance: 0.02,
        attenuationColor: [0.48, 0.32, 0.20],
        sheen: 0.30,
        sheenColor: [0.65, 0.48, 0.32],
        sheenRoughness: 0.55,
        specularIntensity: 0.50,
        specularColor: [0.85, 0.82, 0.78],
        secondaryLobeColor: [0.38, 0.24, 0.14],
        dualLobeRatio: 0.60
    },
    'rabbit-white': {
        color: [0.94, 0.92, 0.88],
        roughness: 0.36,
        metalness: 0.0,
        longitudinalRoughness: 0.32,
        azimuthalRoughness: 0.50,
        transmissionAzimuthalRoughness: 1.0,
        anisotropy: 0.58,
        anisotropyRotation: 0.0,
        transmission: 0.22,
        thickness: 0.002,
        attenuationDistance: 0.02,
        attenuationColor: [0.96, 0.94, 0.90],
        sheen: 0.45,
        sheenColor: [1.0, 0.98, 0.95],
        sheenRoughness: 0.40,
        specularIntensity: 0.58,
        specularColor: [0.98, 0.96, 0.94],
        secondaryLobeColor: [0.94, 0.92, 0.88],
        dualLobeRatio: 0.50
    },
    'cat-black': {
        color: [0.06, 0.05, 0.05],
        roughness: 0.30,
        metalness: 0.0,
        longitudinalRoughness: 0.28,
        azimuthalRoughness: 0.44,
        transmissionAzimuthalRoughness: 1.0,
        anisotropy: 0.75,
        anisotropyRotation: 0.0,
        transmission: 0.16,
        thickness: 0.002,
        attenuationDistance: 0.02,
        attenuationColor: [0.18, 0.14, 0.14],
        sheen: 0.35,
        sheenColor: [0.42, 0.40, 0.40],
        sheenRoughness: 0.40,
        specularIntensity: 0.62,
        specularColor: [0.88, 0.86, 0.88],
        secondaryLobeColor: [0.06, 0.05, 0.05],
        dualLobeRatio: 0.52
    },
    'deer-tan': {
        color: [0.62, 0.46, 0.30],
        roughness: 0.38,
        metalness: 0.0,
        longitudinalRoughness: 0.34,
        azimuthalRoughness: 0.52,
        transmissionAzimuthalRoughness: 1.0,
        anisotropy: 0.65,
        anisotropyRotation: 0.0,
        transmission: 0.18,
        thickness: 0.002,
        attenuationDistance: 0.02,
        attenuationColor: [0.72, 0.56, 0.38],
        sheen: 0.34,
        sheenColor: [0.82, 0.68, 0.50],
        sheenRoughness: 0.50,
        specularIntensity: 0.54,
        specularColor: [0.90, 0.82, 0.72],
        secondaryLobeColor: [0.62, 0.46, 0.30],
        dualLobeRatio: 0.56
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable fur scratch records
// ---------------------------------------------------------------------------

class FurScratchPool {
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

const _furScratchPool = new FurScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — fur-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded fur highlights. Fur has anisotropic, strand-aligned
 * specular streaks — quantizing them into discrete bands produces the crisp
 * anime fur shine seen in hand-drawn animal illustrations.
 */
function applyFurCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.10) {
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
 * Apply mood-based tinting to fur. Warm moods push fur toward warm golden-
 * amber, cool moods toward cool ash-grey — matching the atmospheric fur
 * tinting seen in stylized animal scenes.
 */
function gradeFurColor(color, temperature, saturation, brightness, contrast) {
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

    // Fur-specific temperature bias: warm shift pushes toward golden-amber,
    // cool shift pushes toward ash-grey.
    r += temperature * 0.035;
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
 * Generate a procedural fur-strand texture. The algorithm:
 * 1. Directional fBm: high-frequency noise stretched along the strand
 *    direction to simulate longitudinal fibre streaks.
 * 2. Per-strand hashed colour jitter: each virtual strand cell gets a small
 *    brightness/colour offset to break up uniformity.
 * 3. Cross-strand clump noise: low-frequency clumps that group strands into
 *    tufts.
 * 4. Optional undercoat noise: darker low-frequency blotch for the dense
 *    undercoat layer beneath the guard hairs.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * anisotropy direction, or bump-map use.
 */
function generateFurStrandTexture(width, height, strandDirection = 0.0, scale = 0.02, octaves = 4, strandJitter = 0.15, clumpStrength = 0.20, undercoatStrength = 0.0) {
    const out = new Uint8Array(width * height * 4);

    const cosA = Math.cos(strandDirection);
    const sinA = Math.sin(strandDirection);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Rotate coordinates into strand frame
            const rx = x * cosA - y * sinA;
            const ry = x * sinA + y * cosA;

            // --- 1. Directional fBm (stretched along strand axis) ---
            let fbm = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                fbm += SimplexNoise.noise2D(
                    rx * frequency * 0.2,
                    ry * frequency * 2.0
                ) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;

            // --- 2. Per-strand hashed jitter ---
            const strandCell = Math.floor(ry * 4.0);
            const strandHash = Math.abs(Math.sin(strandCell * 12.9898 + 5.0) * 43758.5453) % 1.0;
            const jitter = (strandHash - 0.5) * strandJitter;

            // --- 3. Cross-strand clump noise ---
            const clump = SimplexNoise.noise2D(rx * 0.01, ry * 0.05) * 0.5 + 0.5;
            const clumpMask = (clump - 0.5) * clumpStrength;

            // --- 4. Undercoat noise ---
            let undercoat = 0;
            if (undercoatStrength > 0) {
                const u = SimplexNoise.noise2D(x * 0.008, y * 0.008) * 0.5 + 0.5;
                undercoat = (u - 0.5) * undercoatStrength;
            }

            // --- Combine ---
            let value = 0.55
                + (fbm - 0.5) * 0.25
                + jitter
                + clumpMask
                + undercoat;

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

const _furWorld = BitECS.createWorld();
const FurMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    furBands: 'ui8',
    furQuantize: 'f64',
    furSoftness: 'f64',
    longitudinalRoughness: 'f64',
    azimuthalRoughness: 'f64',
    transmissionAzimuthalRoughness: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    dualLobeRatio: 'f64',
    secondaryLobeColorR: 'f64',
    secondaryLobeColorG: 'f64',
    secondaryLobeColorB: 'f64',
    strandJitter: 'f64',
    clumpStrength: 'f64',
    undercoatStrength: 'f64',
    tipGlowIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class FurMaterialBatch {
    constructor() {
        this.world = _furWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, FurMaterialComponent, eid);
        FurMaterialComponent.materialPtr[eid] = this.materials.length;
        FurMaterialComponent.furBands[eid] = material.furBands;
        FurMaterialComponent.furQuantize[eid] = material.furQuantize;
        FurMaterialComponent.furSoftness[eid] = material.furSoftness;
        FurMaterialComponent.longitudinalRoughness[eid] = material.longitudinalRoughness;
        FurMaterialComponent.azimuthalRoughness[eid] = material.azimuthalRoughness;
        FurMaterialComponent.transmissionAzimuthalRoughness[eid] = material.transmissionAzimuthalRoughness;
        FurMaterialComponent.anisotropyStrength[eid] = material.anisotropy;
        FurMaterialComponent.anisotropyRotation[eid] = material.anisotropyRotation;
        FurMaterialComponent.dualLobeRatio[eid] = material.dualLobeRatio;
        FurMaterialComponent.secondaryLobeColorR[eid] = material.secondaryLobeColor.r;
        FurMaterialComponent.secondaryLobeColorG[eid] = material.secondaryLobeColor.g;
        FurMaterialComponent.secondaryLobeColorB[eid] = material.secondaryLobeColor.b;
        FurMaterialComponent.strandJitter[eid] = material.strandJitter;
        FurMaterialComponent.clumpStrength[eid] = material.clumpStrength;
        FurMaterialComponent.undercoatStrength[eid] = material.undercoatStrength;
        FurMaterialComponent.tipGlowIntensity[eid] = material.tipGlowIntensity;
        FurMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        FurMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        FurMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        FurMaterialComponent.moodContrast[eid] = material.moodContrast;
        FurMaterialComponent.rimGlow[eid] = material.rimGlow;
        FurMaterialComponent.variationSeed[eid] = material.variationSeed;
        FurMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[FurMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.furBands = FurMaterialComponent.furBands[eid];
            material.furQuantize = FurMaterialComponent.furQuantize[eid];
            material.furSoftness = FurMaterialComponent.furSoftness[eid];
            material.longitudinalRoughness = FurMaterialComponent.longitudinalRoughness[eid];
            material.azimuthalRoughness = FurMaterialComponent.azimuthalRoughness[eid];
            material.transmissionAzimuthalRoughness = FurMaterialComponent.transmissionAzimuthalRoughness[eid];
            material.anisotropy = FurMaterialComponent.anisotropyStrength[eid];
            material.anisotropyRotation = FurMaterialComponent.anisotropyRotation[eid];
            material.dualLobeRatio = FurMaterialComponent.dualLobeRatio[eid];
            material.secondaryLobeColor.setRGB(
                FurMaterialComponent.secondaryLobeColorR[eid],
                FurMaterialComponent.secondaryLobeColorG[eid],
                FurMaterialComponent.secondaryLobeColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.strandJitter = FurMaterialComponent.strandJitter[eid];
            material.clumpStrength = FurMaterialComponent.clumpStrength[eid];
            material.undercoatStrength = FurMaterialComponent.undercoatStrength[eid];
            material.tipGlowIntensity = FurMaterialComponent.tipGlowIntensity[eid];
            material.moodTemperature = FurMaterialComponent.moodTemperature[eid];
            material.moodSaturation = FurMaterialComponent.moodSaturation[eid];
            material.moodBrightness = FurMaterialComponent.moodBrightness[eid];
            material.moodContrast = FurMaterialComponent.moodContrast[eid];
            material.rimGlow = FurMaterialComponent.rimGlow[eid];
            material.variationSeed = FurMaterialComponent.variationSeed[eid];

            FurMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main FurMaterial class
// ---------------------------------------------------------------------------

class FurMaterial extends MeshPhysicalMaterial {
    static {
        _furScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isFurMaterial = true;
        this.type = 'FurMaterial';

        // -------------------------------------------------------------------
        // Fur-specific PBR defaults (fox-red baseline)
        // -------------------------------------------------------------------
        this.ior = 1.55;
        this.specularIntensity = 0.55;
        this.roughness = 0.34;
        this.metalness = 0.0;
        this.specularColor = new Color(0.98, 0.90, 0.80);
        this.color = new Color(0.82, 0.42, 0.16);

        // Dual-lobe specular roughness controls
        this.longitudinalRoughness = 0.30;
        this.azimuthalRoughness = 0.48;
        this.transmissionAzimuthalRoughness = 1.0;

        // Anisotropy along the strand direction
        this.anisotropy = 0.72;
        this.anisotropyRotation = 0.0;

        // Thin-walled transmission for light-through-fur
        this.transmission = 0.20;
        this.thickness = 0.002;
        this.attenuationDistance = 0.02;
        this.attenuationColor = new Color(0.90, 0.52, 0.24);

        // Sheen for the soft fur edge
        this.sheen = 0.38;
        this.sheenColor = new Color(0.95, 0.72, 0.42);
        this.sheenRoughness = 0.45;

        // -------------------------------------------------------------------
        // Anime rendering extensions — fur-specific
        // -------------------------------------------------------------------
        this.furBands = 3;
        this.furQuantize = 0.5;
        this.furSoftness = 0.10;

        // Dual-lobe specular approximation
        this.dualLobeRatio = 0.55;
        this.secondaryLobeColor = new Color(0.82, 0.42, 0.16);

        // Strand / clump / undercoat / tip-glow controls
        this.strandJitter = 0.15;
        this.clumpStrength = 0.20;
        this.undercoatStrength = 0.0;
        this.tipGlowIntensity = 0.15;
        this.tipGlowColor = new Color(1.0, 0.95, 0.80);

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(1.0, 0.85, 0.65);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (fur leans semi-realistic)
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

    applyFurBanding(baseColor, output) {
        return applyFurCelBanding(
            baseColor,
            output,
            this.furBands,
            this.furQuantize,
            this.furSoftness
        );
    }

    updateMoodColor() {
        gradeFurColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named fur preset to this material.
     * @param {string} presetName - One of the keys of `FurPresets`.
     * @returns {FurMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = FurPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.longitudinalRoughness = preset.longitudinalRoughness;
        this.azimuthalRoughness = preset.azimuthalRoughness;
        this.transmissionAzimuthalRoughness = preset.transmissionAzimuthalRoughness;
        this.anisotropy = preset.anisotropy;
        this.anisotropyRotation = preset.anisotropyRotation;
        this.transmission = preset.transmission;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.secondaryLobeColor.setRGB(preset.secondaryLobeColor[0], preset.secondaryLobeColor[1], preset.secondaryLobeColor[2], ColorManagement.workingColorSpace);
        this.dualLobeRatio = preset.dualLobeRatio;

        // Per-preset anime tuning
        if (presetName === 'cat-black' || presetName === 'fox-red') {
            this.furSoftness = 0.06;
            this.furBands = 4;
            this.tipGlowIntensity = 0.20;
        } else if (presetName === 'rabbit-white') {
            this.furSoftness = 0.14;
            this.furBands = 3;
            this.tipGlowIntensity = 0.10;
        } else if (presetName === 'bear-brown') {
            this.furSoftness = 0.18;
            this.furBands = 2;
            this.undercoatStrength = 0.20;
        } else {
            this.furSoftness = 0.10;
            this.furBands = 3;
            this.tipGlowIntensity = 0.15;
        }

        this.updateMoodColor();
        return this;
    }

    generateFurStrandTexture(width, height, strandDirection = 0.0, scale = 0.02, octaves = 4, strandJitter = 0.15, clumpStrength = 0.20, undercoatStrength = 0.0) {
        return generateFurStrandTexture(width, height, strandDirection, scale, octaves, strandJitter, clumpStrength, undercoatStrength);
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

        shader.uniforms.furBands = { value: this.furBands };
        shader.uniforms.furQuantize = { value: this.furQuantize };
        shader.uniforms.furSoftness = { value: this.furSoftness };
        shader.uniforms.longitudinalRoughness = { value: this.longitudinalRoughness };
        shader.uniforms.azimuthalRoughness = { value: this.azimuthalRoughness };
        shader.uniforms.transmissionAzimuthalRoughness = { value: this.transmissionAzimuthalRoughness };
        shader.uniforms.anisotropyStrength = { value: this.anisotropy };
        shader.uniforms.anisotropyRotation = { value: this.anisotropyRotation };
        shader.uniforms.dualLobeRatio = { value: this.dualLobeRatio };
        shader.uniforms.secondaryLobeColor = { value: this.secondaryLobeColor };
        shader.uniforms.strandJitter = { value: this.strandJitter };
        shader.uniforms.clumpStrength = { value: this.clumpStrength };
        shader.uniforms.undercoatStrength = { value: this.undercoatStrength };
        shader.uniforms.tipGlowIntensity = { value: this.tipGlowIntensity };
        shader.uniforms.tipGlowColor = { value: this.tipGlowColor };
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
                uniform int furBands;
                uniform float furQuantize;
                uniform float furSoftness;
                uniform float longitudinalRoughness;
                uniform float azimuthalRoughness;
                uniform float transmissionAzimuthalRoughness;
                uniform float anisotropyStrength;
                uniform float anisotropyRotation;
                uniform float dualLobeRatio;
                uniform vec3 secondaryLobeColor;
                uniform float strandJitter;
                uniform float clumpStrength;
                uniform float undercoatStrength;
                uniform float tipGlowIntensity;
                uniform vec3 tipGlowColor;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyFurBands(vec3 baseColor) {
                    if (furBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(furBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * furSoftness;
                    float finalLum = mix(lum, softQuantized, furQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply fur cel banding
                gl_FragColor.rgb = applyFurBands(gl_FragColor.rgb);

                // Dual-lobe specular approximation (primary + secondary)
                // Primary lobe = near-white, sharper, longitudinal/azimuthal
                // Secondary lobe = tinted by fur colour, broader, transmission
                {
                    vec3 viewDirFur = normalize(vViewPosition);
                    vec3 normalFur = normalize(vNormal);
                    float ndotvFur = abs(dot(normalFur, viewDirFur));

                    // Primary lobe — near-white sharp
                    float primarySpec = pow(1.0 - ndotvFur, 1.0 / max(longitudinalRoughness, 0.01)) * specularIntensity * 1.2;

                    // Secondary lobe — fur-colour tinted, broader (azimuthal-driven)
                    float secondarySpec = pow(1.0 - ndotvFur, 1.0 / max(azimuthalRoughness, 0.01)) * specularIntensity * 0.6;

                    // Blend by dual-lobe ratio
                    vec3 primaryColor = vec3(1.0);
                    vec3 lobeBlend = mix(secondaryLobeColor * secondarySpec, primaryColor * primarySpec, dualLobeRatio);
                    gl_FragColor.rgb += lobeBlend;
                }

                // Tip glow — brighten tips for classic anime fur shine
                if (tipGlowIntensity > 0.0) {
                    float tipMask = smoothstep(0.6, 1.0, vUv.y);
                    gl_FragColor.rgb += tipGlowColor * tipMask * tipGlowIntensity;
                }

                // Warm rim glow on fur edges
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
            this.longitudinalRoughness, this.azimuthalRoughness,
            this.transmissionAzimuthalRoughness,
            this.anisotropy, this.anisotropyRotation,
            this.transmission, this.thickness, this.attenuationDistance,
            this.sheen, this.sheenRoughness,
            this.furBands, this.furQuantize, this.furSoftness,
            this.dualLobeRatio, this.secondaryLobeColor.r,
            this.strandJitter, this.clumpStrength, this.undercoatStrength,
            this.tipGlowIntensity,
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
        this.longitudinalRoughness = source.longitudinalRoughness;
        this.azimuthalRoughness = source.azimuthalRoughness;
        this.transmissionAzimuthalRoughness = source.transmissionAzimuthalRoughness;
        this.anisotropy = source.anisotropy;
        this.anisotropyRotation = source.anisotropyRotation;
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.furBands = source.furBands;
        this.furQuantize = source.furQuantize;
        this.furSoftness = source.furSoftness;
        this.dualLobeRatio = source.dualLobeRatio;
        this.secondaryLobeColor.copy(source.secondaryLobeColor);
        this.strandJitter = source.strandJitter;
        this.clumpStrength = source.clumpStrength;
        this.undercoatStrength = source.undercoatStrength;
        this.tipGlowIntensity = source.tipGlowIntensity;
        this.tipGlowColor.copy(source.tipGlowColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'FurMaterial';
        if (this.ior !== 1.55) data.ior = this.ior;
        if (this.specularIntensity !== 0.55) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.34) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.longitudinalRoughness !== 0.30) data.longitudinalRoughness = this.longitudinalRoughness;
        if (this.azimuthalRoughness !== 0.48) data.azimuthalRoughness = this.azimuthalRoughness;
        if (this.transmissionAzimuthalRoughness !== 1.0) data.transmissionAzimuthalRoughness = this.transmissionAzimuthalRoughness;
        if (this.anisotropy !== 0.72) data.anisotropy = this.anisotropy;
        if (this.anisotropyRotation !== 0.0) data.anisotropyRotation = this.anisotropyRotation;
        if (this.transmission !== 0.20) data.transmission = this.transmission;
        if (this.thickness !== 0.002) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.02) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.90, 0.52, 0.24).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.38) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.95, 0.72, 0.42).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.45) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.98, 0.90, 0.80).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.furBands !== 3) data.furBands = this.furBands;
        if (this.furQuantize !== 0.5) data.furQuantize = this.furQuantize;
        if (this.furSoftness !== 0.10) data.furSoftness = this.furSoftness;
        if (this.dualLobeRatio !== 0.55) data.dualLobeRatio = this.dualLobeRatio;
        if (this.secondaryLobeColor.getHex() !== new Color(0.82, 0.42, 0.16).getHex()) data.secondaryLobeColor = this.secondaryLobeColor.getHex();
        if (this.strandJitter !== 0.15) data.strandJitter = this.strandJitter;
        if (this.clumpStrength !== 0.20) data.clumpStrength = this.clumpStrength;
        if (this.undercoatStrength !== 0.0) data.undercoatStrength = this.undercoatStrength;
        if (this.tipGlowIntensity !== 0.15) data.tipGlowIntensity = this.tipGlowIntensity;
        if (this.tipGlowColor.getHex() !== new Color(1.0, 0.95, 0.80).getHex()) data.tipGlowColor = this.tipGlowColor.getHex();
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 0.85, 0.65).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.longitudinalRoughness = json.longitudinalRoughness ?? this.longitudinalRoughness;
        this.azimuthalRoughness = json.azimuthalRoughness ?? this.azimuthalRoughness;
        this.transmissionAzimuthalRoughness = json.transmissionAzimuthalRoughness ?? this.transmissionAzimuthalRoughness;
        this.anisotropy = json.anisotropy ?? this.anisotropy;
        this.anisotropyRotation = json.anisotropyRotation ?? this.anisotropyRotation;
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.furBands = json.furBands ?? this.furBands;
        this.furQuantize = json.furQuantize ?? this.furQuantize;
        this.furSoftness = json.furSoftness ?? this.furSoftness;
        this.dualLobeRatio = json.dualLobeRatio ?? this.dualLobeRatio;
        if (json.secondaryLobeColor !== undefined) this.secondaryLobeColor.setHex(json.secondaryLobeColor);
        this.strandJitter = json.strandJitter ?? this.strandJitter;
        this.clumpStrength = json.clumpStrength ?? this.clumpStrength;
        this.undercoatStrength = json.undercoatStrength ?? this.undercoatStrength;
        this.tipGlowIntensity = json.tipGlowIntensity ?? this.tipGlowIntensity;
        if (json.tipGlowColor !== undefined) this.tipGlowColor.setHex(json.tipGlowColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const FurMaterialBatchComponent = {
    materialPtr: 'ui32',
    furBands: 'ui8',
    furQuantize: 'f64',
    furSoftness: 'f64',
    longitudinalRoughness: 'f64',
    azimuthalRoughness: 'f64',
    transmissionAzimuthalRoughness: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    dualLobeRatio: 'f64',
    secondaryLobeColorR: 'f64',
    secondaryLobeColorG: 'f64',
    secondaryLobeColorB: 'f64',
    strandJitter: 'f64',
    clumpStrength: 'f64',
    undercoatStrength: 'f64',
    tipGlowIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    FurMaterial,
    FurMaterialBatch,
    FurScratchPool,
    FurMaterialBatchComponent,
    FurPresets,
    applyFurCelBanding,
    gradeFurColor,
    generateFurStrandTexture
};

export default FurMaterial;