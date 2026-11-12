// file number : 228
// full path name : src/materials/228_humanfairskinmaterial.js
// description : HumanFairSkinMaterial — a ready-to-use human-skin material
//               specializing in fair phototypes (Fitzpatrick I–II, Northern
//               European, light/fair complexions). Extends MeshPhysicalMaterial
//               with biologically grounded PBR defaults matching published
//               real-time skin references (Filament, Pixar LamaSSS, Unreal
//               digital-human): skin IOR ≈ 1.40, F0 ≈ 2.8% specular,
//               roughness ≈ 0.42, zero metalness, thin-walled transmission for
//               the visible red SSS bleed, and clearcoat for the oily T-zone
//               sheen. Adds real-time anime stylization: cel-banded skin
//               highlights, warm-red SSS bleed rim, mood tinting, rim glow, and
//               per-instance variation. Includes a procedural pore/wrinkle/
//               freckle/skin-mottle texture generator using multi-octave fBm
//               with directional micro-grooves, hashed pores, and per-area
//               colour jitter. All imports resolve to the internal
//               Threejs_gl repository tree; no CDN dependencies.
// best for : Human fair skin, portrait characters, anime fair-skinned leads,
//            stylized fantasy heroes with pale complexions, portrait renders,
//            mobile character pipelines, digital humans, and any fair human
//            skin surface that needs real-time PBR + anime stylization.
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
// Human fair-skin presets — biologically grounded PBR parameter sets for
// fair phototypes.
//
// Reference values (from Filament material guide, Pixar LamaSSS, Unreal
// digital-human skin references, and dermatology literature):
//   - Skin IOR:                   1.40
//   - Skin F0 specular:           ~2.8%
//   - Healthy fair skin roughness: 0.38–0.48 (0.42 nominal)
//   - Oily T-zone roughness:       0.20–0.30
//   - Aged/dry fair skin:          0.55–0.70
//   - SSS bleed radius:            red > green > blue (warm SSS tint)
//   - Fair skin SSS bleed colour:  soft peachy-red (~0.95, 0.45, 0.42)
//   - Clearcoat (oily sheen):      0.06–0.15
//   - Metalness:                   0.0 (skin is a dielectric)
// ---------------------------------------------------------------------------

const HumanFairSkinPresets = {
    'northern-european': {
        color: [0.94, 0.82, 0.76],
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.35,
        transmission: 0.12,
        thickness: 0.015,
        attenuationDistance: 0.08,
        attenuationColor: [0.85, 0.45, 0.40],
        specularIntensity: 0.50,
        specularColor: [0.95, 0.90, 0.88],
        sheen: 0.15,
        sheenColor: [0.95, 0.88, 0.82],
        sheenRoughness: 0.55
    },
    'celtic-freckled': {
        color: [0.92, 0.80, 0.72],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.08,
        clearcoatRoughness: 0.38,
        transmission: 0.13,
        thickness: 0.015,
        attenuationDistance: 0.08,
        attenuationColor: [0.88, 0.42, 0.36],
        specularIntensity: 0.48,
        specularColor: [0.94, 0.88, 0.85],
        sheen: 0.18,
        sheenColor: [0.94, 0.86, 0.78],
        sheenRoughness: 0.55
    },
    'slavic-pale': {
        color: [0.95, 0.85, 0.80],
        roughness: 0.40,
        metalness: 0.0,
        clearcoat: 0.12,
        clearcoatRoughness: 0.32,
        transmission: 0.12,
        thickness: 0.015,
        attenuationDistance: 0.08,
        attenuationColor: [0.86, 0.48, 0.44],
        specularIntensity: 0.52,
        specularColor: [0.96, 0.92, 0.90],
        sheen: 0.14,
        sheenColor: [0.96, 0.90, 0.86],
        sheenRoughness: 0.55
    },
    'east-asian-fair': {
        color: [0.92, 0.82, 0.72],
        roughness: 0.40,
        metalness: 0.0,
        clearcoat: 0.11,
        clearcoatRoughness: 0.32,
        transmission: 0.11,
        thickness: 0.015,
        attenuationDistance: 0.08,
        attenuationColor: [0.88, 0.48, 0.42],
        specularIntensity: 0.52,
        specularColor: [0.95, 0.90, 0.86],
        sheen: 0.16,
        sheenColor: [0.94, 0.88, 0.82],
        sheenRoughness: 0.55
    },
    'freckled-summer': {
        color: [0.90, 0.78, 0.68],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.09,
        clearcoatRoughness: 0.36,
        transmission: 0.12,
        thickness: 0.015,
        attenuationDistance: 0.08,
        attenuationColor: [0.88, 0.44, 0.36],
        specularIntensity: 0.48,
        specularColor: [0.94, 0.88, 0.82],
        sheen: 0.18,
        sheenColor: [0.94, 0.84, 0.76],
        sheenRoughness: 0.55
    },
    'anime-fair': {
        color: [0.96, 0.86, 0.80],
        roughness: 0.36,
        metalness: 0.0,
        clearcoat: 0.14,
        clearcoatRoughness: 0.28,
        transmission: 0.14,
        thickness: 0.015,
        attenuationDistance: 0.08,
        attenuationColor: [0.90, 0.48, 0.44],
        specularIntensity: 0.55,
        specularColor: [0.98, 0.92, 0.90],
        sheen: 0.20,
        sheenColor: [0.98, 0.92, 0.88],
        sheenRoughness: 0.50
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable fair-skin scratch records
// ---------------------------------------------------------------------------

class FairSkinScratchPool {
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

const _fairSkinScratchPool = new FairSkinScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — fair-skin-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded fair-skin highlights. Fair skin has soft, low-frequency
 * shading with a subtle warm-red SSS tint — quantizing it into discrete bands
 * produces the crisp anime skin edges seen in hand-drawn character
 * illustrations.
 */
function applyFairSkinCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.18) {
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
 * Apply mood-based tinting to fair skin. Warm moods push fair skin toward a
 * healthy sun-kissed warmth; cool moods push toward a pale/cool porcelain
 * tone. The SSS bleed channel is also warmed so blood-scattering stays
 * plausible.
 */
function gradeFairSkinColor(color, temperature, saturation, brightness, contrast) {
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

    // Fair-skin-specific temperature bias: warm shift favours R slightly more
    // than G; cool shift favours B slightly more than R.
    r += temperature * 0.04;
    g += temperature * 0.02;
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
 * Generate a procedural fair-skin texture. The algorithm:
 * 1. Multi-octave fBm for the low-frequency subcutaneous blotch (natural
 *    pinkness variation).
 * 2. Hashed pore field: per-cell presence, jittered centre, small radial
 *    falloff — producing the micro-pitted skin surface.
 * 3. Directional micro-grooves for fine wrinkles at two crossed angles.
 * 4. Freckle field: larger hashed cells with radius-varied disc masks.
 * 5. SSS bleed mask: soft radial-weighted noise for the warm-red tint.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * bump-map, or normal-map derivation.
 */
function generateFairSkinTexture(width, height, scale = 0.04, octaves = 4, poreDensity = 0.22, poreStrength = 0.18, wrinkleStrength = 0.10, freckleDensity = 0.05, sssBleedStrength = 0.15) {
    const out = new Uint8Array(width * height * 4);

    // Crossed wrinkle angles
    const angleA = 0.6;
    const angleB = -0.9;
    const cosA = Math.cos(angleA);
    const sinA = Math.sin(angleA);
    const cosB = Math.cos(angleB);
    const sinB = Math.sin(angleB);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Low-frequency fBm blotch ---
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

            // --- 2. Pore field (hashed per-cell) ---
            const cellX = Math.floor(x * 0.9);
            const cellY = Math.floor(y * 0.9);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const hash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;

            let pore = 0;
            if (hash > (1.0 - poreDensity)) {
                // Local pore centre within the cell
                const h2 = Math.abs(Math.sin(cellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                const h3 = Math.abs(Math.sin(cellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                const cx = (x * 0.9) - Math.floor(x * 0.9) - h2;
                const cy = (y * 0.9) - Math.floor(y * 0.9) - h3;
                const dist = Math.sqrt(cx * cx + cy * cy);
                pore = Math.max(0, 1.0 - dist * 4.0) * poreStrength;
            }

            // --- 3. Directional wrinkles ---
            const rx = x * cosA - y * sinA;
            const ry = x * sinA + y * cosA;
            const wrinkleA = SimplexNoise.noise2D(rx * 0.03, ry * 0.15) * 0.5 + 0.5;

            const sx = x * cosB - y * sinB;
            const sy = x * sinB + y * cosB;
            const wrinkleB = SimplexNoise.noise2D(sx * 0.04, sy * 0.12) * 0.5 + 0.5;

            const wrinkles = ((wrinkleA - 0.5) + (wrinkleB - 0.5)) * wrinkleStrength;

            // --- 4. Freckle field ---
            let freckle = 0;
            if (freckleDensity > 0) {
                const fCellX = Math.floor(x * 0.2);
                const fCellY = Math.floor(y * 0.2);
                const fCellId = fCellX * 73856093 ^ fCellY * 19349663;
                const fHash = Math.abs(Math.sin(fCellId * 12.9898) * 43758.5453) % 1.0;
                if (fHash > (1.0 - freckleDensity)) {
                    const fh2 = Math.abs(Math.sin(fCellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                    const fh3 = Math.abs(Math.sin(fCellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                    const fcx = (x * 0.2) - Math.floor(x * 0.2) - fh2;
                    const fcy = (y * 0.2) - Math.floor(y * 0.2) - fh3;
                    const fDist = Math.sqrt(fcx * fcx + fcy * fcy);
                    freckle = Math.max(0, 1.0 - fDist * 3.0) * 0.20;
                }
            }

            // --- 5. SSS bleed mask ---
            const sss = SimplexNoise.noise2D(x * 0.01, y * 0.01) * 0.5 + 0.5;
            const sssMask = Math.max(0, sss - 0.5) * sssBleedStrength;

            // --- Combine ---
            let value = 0.62
                + (fbm - 0.5) * 0.20
                - pore * 0.60
                + wrinkles
                - freckle
                + sssMask * 0.15;

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

const _fairSkinWorld = BitECS.createWorld();
const HumanFairSkinMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    skinBands: 'ui8',
    skinQuantize: 'f64',
    skinSoftness: 'f64',
    sssBleedIntensity: 'f64',
    sssBleedColorR: 'f64',
    sssBleedColorG: 'f64',
    sssBleedColorB: 'f64',
    freckleDensity: 'f64',
    freckleStrength: 'f64',
    poreDensity: 'f64',
    poreStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class HumanFairSkinMaterialBatch {
    constructor() {
        this.world = _fairSkinWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, HumanFairSkinMaterialComponent, eid);
        HumanFairSkinMaterialComponent.materialPtr[eid] = this.materials.length;
        HumanFairSkinMaterialComponent.skinBands[eid] = material.skinBands;
        HumanFairSkinMaterialComponent.skinQuantize[eid] = material.skinQuantize;
        HumanFairSkinMaterialComponent.skinSoftness[eid] = material.skinSoftness;
        HumanFairSkinMaterialComponent.sssBleedIntensity[eid] = material.sssBleedIntensity;
        HumanFairSkinMaterialComponent.sssBleedColorR[eid] = material.sssBleedColor.r;
        HumanFairSkinMaterialComponent.sssBleedColorG[eid] = material.sssBleedColor.g;
        HumanFairSkinMaterialComponent.sssBleedColorB[eid] = material.sssBleedColor.b;
        HumanFairSkinMaterialComponent.freckleDensity[eid] = material.freckleDensity;
        HumanFairSkinMaterialComponent.freckleStrength[eid] = material.freckleStrength;
        HumanFairSkinMaterialComponent.poreDensity[eid] = material.poreDensity;
        HumanFairSkinMaterialComponent.poreStrength[eid] = material.poreStrength;
        HumanFairSkinMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        HumanFairSkinMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        HumanFairSkinMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        HumanFairSkinMaterialComponent.moodContrast[eid] = material.moodContrast;
        HumanFairSkinMaterialComponent.rimGlow[eid] = material.rimGlow;
        HumanFairSkinMaterialComponent.variationSeed[eid] = material.variationSeed;
        HumanFairSkinMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[HumanFairSkinMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.skinBands = HumanFairSkinMaterialComponent.skinBands[eid];
            material.skinQuantize = HumanFairSkinMaterialComponent.skinQuantize[eid];
            material.skinSoftness = HumanFairSkinMaterialComponent.skinSoftness[eid];
            material.sssBleedIntensity = HumanFairSkinMaterialComponent.sssBleedIntensity[eid];
            material.sssBleedColor.setRGB(
                HumanFairSkinMaterialComponent.sssBleedColorR[eid],
                HumanFairSkinMaterialComponent.sssBleedColorG[eid],
                HumanFairSkinMaterialComponent.sssBleedColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.freckleDensity = HumanFairSkinMaterialComponent.freckleDensity[eid];
            material.freckleStrength = HumanFairSkinMaterialComponent.freckleStrength[eid];
            material.poreDensity = HumanFairSkinMaterialComponent.poreDensity[eid];
            material.poreStrength = HumanFairSkinMaterialComponent.poreStrength[eid];
            material.moodTemperature = HumanFairSkinMaterialComponent.moodTemperature[eid];
            material.moodSaturation = HumanFairSkinMaterialComponent.moodSaturation[eid];
            material.moodBrightness = HumanFairSkinMaterialComponent.moodBrightness[eid];
            material.moodContrast = HumanFairSkinMaterialComponent.moodContrast[eid];
            material.rimGlow = HumanFairSkinMaterialComponent.rimGlow[eid];
            material.variationSeed = HumanFairSkinMaterialComponent.variationSeed[eid];

            HumanFairSkinMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main HumanFairSkinMaterial class
// ---------------------------------------------------------------------------

class HumanFairSkinMaterial extends MeshPhysicalMaterial {
    static {
        _fairSkinScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isHumanFairSkinMaterial = true;
        this.type = 'HumanFairSkinMaterial';

        // -------------------------------------------------------------------
        // Fair-skin-specific PBR defaults (northern-european baseline)
        // -------------------------------------------------------------------
        this.ior = 1.40;
        this.specularIntensity = 0.50;
        this.roughness = 0.42;
        this.metalness = 0.0;
        this.specularColor = new Color(0.95, 0.90, 0.88);
        this.color = new Color(0.94, 0.82, 0.76);

        // Subsurface-scattering approximation via thin-walled transmission
        this.transmission = 0.12;
        this.thickness = 0.015;
        this.attenuationDistance = 0.08;
        this.attenuationColor = new Color(0.85, 0.45, 0.40);

        // Clearcoat for oily/moist T-zone sheen
        this.clearcoat = 0.10;
        this.clearcoatRoughness = 0.35;

        // Sheen for the soft facial fuzz / fine vellus
        this.sheen = 0.15;
        this.sheenColor = new Color(0.95, 0.88, 0.82);
        this.sheenRoughness = 0.55;

        // -------------------------------------------------------------------
        // Anime rendering extensions — fair-skin-specific
        // -------------------------------------------------------------------
        this.skinBands = 3;
        this.skinQuantize = 0.4;
        this.skinSoftness = 0.18;

        // SSS bleed: warm-red rim bleed characteristic of anime fair skin
        this.sssBleedIntensity = 0.28;
        this.sssBleedColor = new Color(0.95, 0.35, 0.30);

        // Skin micro-features
        this.freckleDensity = 0.05;
        this.freckleStrength = 0.20;
        this.poreDensity = 0.22;
        this.poreStrength = 0.18;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(1.0, 0.55, 0.45);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (fair skin leans semi-realistic)
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

    applySkinBanding(baseColor, output) {
        return applyFairSkinCelBanding(
            baseColor,
            output,
            this.skinBands,
            this.skinQuantize,
            this.skinSoftness
        );
    }

    updateMoodColor() {
        gradeFairSkinColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named human fair-skin preset to this material.
     * @param {string} presetName - One of the keys of `HumanFairSkinPresets`.
     * @returns {HumanFairSkinMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = HumanFairSkinPresets[presetName];
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
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;

        // Freckle density per preset
        if (presetName === 'celtic-freckled' || presetName === 'freckled-summer') {
            this.freckleDensity = 0.12;
            this.freckleStrength = 0.25;
        } else {
            this.freckleDensity = 0.05;
            this.freckleStrength = 0.20;
        }

        // Aged/dry preset: crisp bands; healthy: softer bands
        if (presetName === 'anime-fair') {
            this.skinSoftness = 0.12;
            this.skinBands = 4;
            this.sssBleedIntensity = 0.35;
        } else {
            this.skinSoftness = 0.18;
            this.skinBands = 3;
            this.sssBleedIntensity = 0.28;
        }

        this.updateMoodColor();
        return this;
    }

    generateFairSkinTexture(width, height, scale = 0.04, octaves = 4, poreDensity = 0.22, poreStrength = 0.18) {
        return generateFairSkinTexture(width, height, scale, octaves, poreDensity, poreStrength, 0.10, this.freckleDensity, 0.15);
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

        shader.uniforms.skinBands = { value: this.skinBands };
        shader.uniforms.skinQuantize = { value: this.skinQuantize };
        shader.uniforms.skinSoftness = { value: this.skinSoftness };
        shader.uniforms.sssBleedIntensity = { value: this.sssBleedIntensity };
        shader.uniforms.sssBleedColor = { value: this.sssBleedColor };
        shader.uniforms.freckleDensity = { value: this.freckleDensity };
        shader.uniforms.freckleStrength = { value: this.freckleStrength };
        shader.uniforms.poreDensity = { value: this.poreDensity };
        shader.uniforms.poreStrength = { value: this.poreStrength };
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
                uniform int skinBands;
                uniform float skinQuantize;
                uniform float skinSoftness;
                uniform float sssBleedIntensity;
                uniform vec3 sssBleedColor;
                uniform float freckleDensity;
                uniform float freckleStrength;
                uniform float poreDensity;
                uniform float poreStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applySkinBands(vec3 baseColor) {
                    if (skinBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(skinBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * skinSoftness;
                    float finalLum = mix(lum, softQuantized, skinQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply skin cel banding
                gl_FragColor.rgb = applySkinBands(gl_FragColor.rgb);

                // Freckle approximation: hashed cell darkening
                if (freckleDensity > 0.0) {
                    vec2 freckleUV = vUv * 80.0;
                    vec2 freckleCell = floor(freckleUV);
                    float freckleHash = fract(sin(dot(freckleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (freckleHash > (1.0 - freckleDensity)) {
                        vec2 freckleCentre = vec2(fract(freckleHash * 7.31), fract(freckleHash * 13.7));
                        vec2 freckleFrac = fract(freckleUV);
                        float freckleDist = length(freckleFrac - freckleCentre);
                        float freckleMask = max(0.0, 1.0 - freckleDist * 3.0);
                        gl_FragColor.rgb *= (1.0 - freckleMask * freckleStrength * 0.5);
                    }
                }

                // Pore approximation: fine hashed darkening
                if (poreStrength > 0.0) {
                    vec2 poreUV = vUv * 200.0;
                    vec2 poreCell = floor(poreUV);
                    float poreHash = fract(sin(dot(poreCell, vec2(39.425, 1.57))) * 43758.5453);
                    float poreMask = poreHash > (1.0 - poreDensity) ? 1.0 : 0.0;
                    gl_FragColor.rgb *= (1.0 - poreMask * poreStrength * 0.15);
                }

                // SSS bleed: warm-red rim on silhouettes (approximates subsurface scattering)
                if (sssBleedIntensity > 0.0) {
                    float ndotvSkin = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float bleed = pow(1.0 - ndotvSkin, 3.0) * sssBleedIntensity;
                    gl_FragColor.rgb += sssBleedColor * bleed;
                }

                // Warm-red rim glow on skin edges
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
            this.sheen, this.sheenRoughness,
            this.skinBands, this.skinQuantize, this.skinSoftness,
            this.sssBleedIntensity,
            this.freckleDensity, this.freckleStrength,
            this.poreDensity, this.poreStrength,
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
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.skinBands = source.skinBands;
        this.skinQuantize = source.skinQuantize;
        this.skinSoftness = source.skinSoftness;
        this.sssBleedIntensity = source.sssBleedIntensity;
        this.sssBleedColor.copy(source.sssBleedColor);
        this.freckleDensity = source.freckleDensity;
        this.freckleStrength = source.freckleStrength;
        this.poreDensity = source.poreDensity;
        this.poreStrength = source.poreStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'HumanFairSkinMaterial';
        if (this.ior !== 1.40) data.ior = this.ior;
        if (this.specularIntensity !== 0.50) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.42) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.10) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.35) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.12) data.transmission = this.transmission;
        if (this.thickness !== 0.015) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.08) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.85, 0.45, 0.40).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.15) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.95, 0.88, 0.82).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.55) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.95, 0.90, 0.88).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.skinBands !== 3) data.skinBands = this.skinBands;
        if (this.skinQuantize !== 0.4) data.skinQuantize = this.skinQuantize;
        if (this.skinSoftness !== 0.18) data.skinSoftness = this.skinSoftness;
        if (this.sssBleedIntensity !== 0.28) data.sssBleedIntensity = this.sssBleedIntensity;
        if (this.sssBleedColor.getHex() !== new Color(0.95, 0.35, 0.30).getHex()) data.sssBleedColor = this.sssBleedColor.getHex();
        if (this.freckleDensity !== 0.05) data.freckleDensity = this.freckleDensity;
        if (this.freckleStrength !== 0.20) data.freckleStrength = this.freckleStrength;
        if (this.poreDensity !== 0.22) data.poreDensity = this.poreDensity;
        if (this.poreStrength !== 0.18) data.poreStrength = this.poreStrength;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 0.55, 0.45).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.skinBands = json.skinBands ?? this.skinBands;
        this.skinQuantize = json.skinQuantize ?? this.skinQuantize;
        this.skinSoftness = json.skinSoftness ?? this.skinSoftness;
        this.sssBleedIntensity = json.sssBleedIntensity ?? this.sssBleedIntensity;
        if (json.sssBleedColor !== undefined) this.sssBleedColor.setHex(json.sssBleedColor);
        this.freckleDensity = json.freckleDensity ?? this.freckleDensity;
        this.freckleStrength = json.freckleStrength ?? this.freckleStrength;
        this.poreDensity = json.poreDensity ?? this.poreDensity;
        this.poreStrength = json.poreStrength ?? this.poreStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const HumanFairSkinMaterialBatchComponent = {
    materialPtr: 'ui32',
    skinBands: 'ui8',
    skinQuantize: 'f64',
    skinSoftness: 'f64',
    sssBleedIntensity: 'f64',
    sssBleedColorR: 'f64',
    sssBleedColorG: 'f64',
    sssBleedColorB: 'f64',
    freckleDensity: 'f64',
    freckleStrength: 'f64',
    poreDensity: 'f64',
    poreStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    HumanFairSkinMaterial,
    HumanFairSkinMaterialBatch,
    FairSkinScratchPool,
    HumanFairSkinMaterialBatchComponent,
    HumanFairSkinPresets,
    applyFairSkinCelBanding,
    gradeFairSkinColor,
    generateFairSkinTexture
};

export default HumanFairSkinMaterial;