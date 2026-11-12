// file number : 229
// full path name : src/materials/229_humanmediumskinmaterial.js
// description : HumanMediumSkinMaterial — a ready-to-use human-skin material
//               specializing in medium/olive phototypes (Fitzpatrick III–IV,
//               Mediterranean, Middle Eastern, South Asian, Southeast Asian,
//               Latin American complexions). Extends MeshPhysicalMaterial with
//               biologically grounded PBR defaults matching published real-time
//               skin references: skin IOR ≈ 1.40, roughness ≈ 0.44, zero
//               metalness, thicker dermis (larger attenuationDistance),
//               warmer/deeper SSS bleed (red-umber instead of peachy-red), and
//               clearcoat for the oily T-zone sheen. Adds real-time anime
//               stylization: cel-banded skin highlights, warm SSS bleed rim,
//               mood tinting with olive/golden undertone support, rim glow,
//               and per-instance variation. Includes a procedural skin texture
//               generator with multi-octave fBm, hashed pores, directional
//               wrinkles, pigment mottle, and optional sun-tan gradient mask.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Human medium/olive skin, Mediterranean characters, Middle Eastern
//            characters, South and Southeast Asian characters, Latin American
//            characters, tanned anime leads, portrait renders, and any medium
//            human skin surface that needs real-time PBR + anime stylization.
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
// Human medium-skin presets — biologically grounded PBR parameter sets for
// medium/olive phototypes (Fitzpatrick III–IV).
//
// Reference values (from Filament, Pixar LamaSSS, Unreal digital-human, and
// dermatology literature):
//   - Skin IOR:                          1.40
//   - Medium skin roughness:             0.42–0.48 (0.44 nominal)
//   - Higher melanin → slightly higher attenuation distance (0.09–0.11)
//   - Warmer deeper SSS bleed: red-umber (~0.78, 0.36, 0.28)
//   - Clearcoat (oily sheen):            0.08–0.12
//   - Metalness:                         0.0 (skin is a dielectric)
//   - Olive/golden undertone:            adds small green-yellow component
// ---------------------------------------------------------------------------

const HumanMediumSkinPresets = {
    'mediterranean-olive': {
        color: [0.82, 0.66, 0.52],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.35,
        transmission: 0.13,
        thickness: 0.015,
        attenuationDistance: 0.09,
        attenuationColor: [0.78, 0.38, 0.28],
        specularIntensity: 0.50,
        specularColor: [0.90, 0.82, 0.74],
        sheen: 0.14,
        sheenColor: [0.88, 0.76, 0.62],
        sheenRoughness: 0.55
    },
    'middle-eastern-golden': {
        color: [0.78, 0.60, 0.42],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.11,
        clearcoatRoughness: 0.34,
        transmission: 0.14,
        thickness: 0.015,
        attenuationDistance: 0.10,
        attenuationColor: [0.75, 0.34, 0.24],
        specularIntensity: 0.52,
        specularColor: [0.88, 0.78, 0.68],
        sheen: 0.15,
        sheenColor: [0.86, 0.72, 0.55],
        sheenRoughness: 0.55
    },
    'south-asian-warm': {
        color: [0.72, 0.52, 0.36],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.35,
        transmission: 0.13,
        thickness: 0.015,
        attenuationDistance: 0.10,
        attenuationColor: [0.72, 0.30, 0.22],
        specularIntensity: 0.50,
        specularColor: [0.85, 0.74, 0.62],
        sheen: 0.15,
        sheenColor: [0.82, 0.68, 0.52],
        sheenRoughness: 0.55
    },
    'southeast-asian-golden': {
        color: [0.74, 0.56, 0.38],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.11,
        clearcoatRoughness: 0.34,
        transmission: 0.14,
        thickness: 0.015,
        attenuationDistance: 0.10,
        attenuationColor: [0.74, 0.34, 0.24],
        specularIntensity: 0.51,
        specularColor: [0.86, 0.76, 0.64],
        sheen: 0.15,
        sheenColor: [0.84, 0.70, 0.54],
        sheenRoughness: 0.55
    },
    'latina-warm': {
        color: [0.80, 0.62, 0.46],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.35,
        transmission: 0.13,
        thickness: 0.015,
        attenuationDistance: 0.09,
        attenuationColor: [0.76, 0.36, 0.26],
        specularIntensity: 0.50,
        specularColor: [0.88, 0.78, 0.66],
        sheen: 0.14,
        sheenColor: [0.86, 0.72, 0.58],
        sheenRoughness: 0.55
    },
    'anime-medium': {
        color: [0.76, 0.58, 0.42],
        roughness: 0.40,
        metalness: 0.0,
        clearcoat: 0.13,
        clearcoatRoughness: 0.30,
        transmission: 0.15,
        thickness: 0.015,
        attenuationDistance: 0.10,
        attenuationColor: [0.78, 0.36, 0.26],
        specularIntensity: 0.54,
        specularColor: [0.90, 0.80, 0.70],
        sheen: 0.18,
        sheenColor: [0.88, 0.74, 0.58],
        sheenRoughness: 0.50
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable medium-skin scratch records
// ---------------------------------------------------------------------------

class MediumSkinScratchPool {
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

const _mediumSkinScratchPool = new MediumSkinScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — medium-skin-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded medium-skin highlights. Medium skin has warm, low-frequency
 * shading with an olive/golden undertone — quantizing it into discrete bands
 * produces the crisp anime medium-skin edges seen in hand-drawn character
 * illustrations.
 */
function applyMediumSkinCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.16) {
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
 * Apply mood-based tinting to medium/olive skin. Warm moods push skin toward
 * warm honey/amber; cool moods toward a cool olive/khaki. The olive undertone
 * is preserved by adding a small green-yellow component to the temperature
 * shift.
 */
function gradeMediumSkinColor(color, temperature, saturation, brightness, contrast) {
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

    // Medium/olive-skin-specific temperature bias:
    // Warm shift pushes toward honey/amber (R and G slightly up, B down).
    // Cool shift pushes toward cool olive/khaki (G slightly up, R and B down).
    r += temperature * 0.045;
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
 * Generate a procedural medium-skin texture. The algorithm:
 * 1. Multi-octave fBm for the low-frequency subcutaneous blotch (natural
 *    pigment variation with a warmer undertone).
 * 2. Hashed pore field: per-cell presence, jittered centre, small radial
 *    falloff — producing the micro-pitted skin surface.
 * 3. Directional micro-grooves for fine wrinkles at two crossed angles.
 * 4. Pigment mottle: slightly larger cells for uneven pigmentation typical
 *    of olive skin.
 * 5. Optional sun-tan gradient: a soft v-driven darkening mask for
 *    sun-exposed regions.
 * 6. SSS bleed mask: soft radial-weighted noise for the warm-red tint.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * bump-map, or normal-map derivation.
 */
function generateMediumSkinTexture(width, height, scale = 0.04, octaves = 4, poreDensity = 0.22, poreStrength = 0.18, wrinkleStrength = 0.10, pigmentStrength = 0.12, sunTanStrength = 0.0, sssBleedStrength = 0.15) {
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

            // --- 4. Pigment mottle ---
            const pigment = (SimplexNoise.noise2D(x * 0.008, y * 0.008) * 0.5 + 0.5 - 0.5) * pigmentStrength;

            // --- 5. Sun-tan gradient (optional) ---
            let sunTan = 0;
            if (sunTanStrength > 0) {
                const t = y / height;
                sunTan = Math.sin(t * Math.PI) * sunTanStrength;
            }

            // --- 6. SSS bleed mask ---
            const sss = SimplexNoise.noise2D(x * 0.01, y * 0.01) * 0.5 + 0.5;
            const sssMask = Math.max(0, sss - 0.5) * sssBleedStrength;

            // --- Combine ---
            let value = 0.60
                + (fbm - 0.5) * 0.18
                - pore * 0.60
                + wrinkles
                + pigment
                - sunTan * 0.20
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

const _mediumSkinWorld = BitECS.createWorld();
const HumanMediumSkinMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    skinBands: 'ui8',
    skinQuantize: 'f64',
    skinSoftness: 'f64',
    sssBleedIntensity: 'f64',
    sssBleedColorR: 'f64',
    sssBleedColorG: 'f64',
    sssBleedColorB: 'f64',
    pigmentStrength: 'f64',
    sunTanStrength: 'f64',
    poreDensity: 'f64',
    poreStrength: 'f64',
    oliveUndertone: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class HumanMediumSkinMaterialBatch {
    constructor() {
        this.world = _mediumSkinWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, HumanMediumSkinMaterialComponent, eid);
        HumanMediumSkinMaterialComponent.materialPtr[eid] = this.materials.length;
        HumanMediumSkinMaterialComponent.skinBands[eid] = material.skinBands;
        HumanMediumSkinMaterialComponent.skinQuantize[eid] = material.skinQuantize;
        HumanMediumSkinMaterialComponent.skinSoftness[eid] = material.skinSoftness;
        HumanMediumSkinMaterialComponent.sssBleedIntensity[eid] = material.sssBleedIntensity;
        HumanMediumSkinMaterialComponent.sssBleedColorR[eid] = material.sssBleedColor.r;
        HumanMediumSkinMaterialComponent.sssBleedColorG[eid] = material.sssBleedColor.g;
        HumanMediumSkinMaterialComponent.sssBleedColorB[eid] = material.sssBleedColor.b;
        HumanMediumSkinMaterialComponent.pigmentStrength[eid] = material.pigmentStrength;
        HumanMediumSkinMaterialComponent.sunTanStrength[eid] = material.sunTanStrength;
        HumanMediumSkinMaterialComponent.poreDensity[eid] = material.poreDensity;
        HumanMediumSkinMaterialComponent.poreStrength[eid] = material.poreStrength;
        HumanMediumSkinMaterialComponent.oliveUndertone[eid] = material.oliveUndertone;
        HumanMediumSkinMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        HumanMediumSkinMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        HumanMediumSkinMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        HumanMediumSkinMaterialComponent.moodContrast[eid] = material.moodContrast;
        HumanMediumSkinMaterialComponent.rimGlow[eid] = material.rimGlow;
        HumanMediumSkinMaterialComponent.variationSeed[eid] = material.variationSeed;
        HumanMediumSkinMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[HumanMediumSkinMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.skinBands = HumanMediumSkinMaterialComponent.skinBands[eid];
            material.skinQuantize = HumanMediumSkinMaterialComponent.skinQuantize[eid];
            material.skinSoftness = HumanMediumSkinMaterialComponent.skinSoftness[eid];
            material.sssBleedIntensity = HumanMediumSkinMaterialComponent.sssBleedIntensity[eid];
            material.sssBleedColor.setRGB(
                HumanMediumSkinMaterialComponent.sssBleedColorR[eid],
                HumanMediumSkinMaterialComponent.sssBleedColorG[eid],
                HumanMediumSkinMaterialComponent.sssBleedColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.pigmentStrength = HumanMediumSkinMaterialComponent.pigmentStrength[eid];
            material.sunTanStrength = HumanMediumSkinMaterialComponent.sunTanStrength[eid];
            material.poreDensity = HumanMediumSkinMaterialComponent.poreDensity[eid];
            material.poreStrength = HumanMediumSkinMaterialComponent.poreStrength[eid];
            material.oliveUndertone = HumanMediumSkinMaterialComponent.oliveUndertone[eid];
            material.moodTemperature = HumanMediumSkinMaterialComponent.moodTemperature[eid];
            material.moodSaturation = HumanMediumSkinMaterialComponent.moodSaturation[eid];
            material.moodBrightness = HumanMediumSkinMaterialComponent.moodBrightness[eid];
            material.moodContrast = HumanMediumSkinMaterialComponent.moodContrast[eid];
            material.rimGlow = HumanMediumSkinMaterialComponent.rimGlow[eid];
            material.variationSeed = HumanMediumSkinMaterialComponent.variationSeed[eid];

            HumanMediumSkinMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main HumanMediumSkinMaterial class
// ---------------------------------------------------------------------------

class HumanMediumSkinMaterial extends MeshPhysicalMaterial {
    static {
        _mediumSkinScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isHumanMediumSkinMaterial = true;
        this.type = 'HumanMediumSkinMaterial';

        // -------------------------------------------------------------------
        // Medium-skin-specific PBR defaults (mediterranean-olive baseline)
        // -------------------------------------------------------------------
        this.ior = 1.40;
        this.specularIntensity = 0.50;
        this.roughness = 0.44;
        this.metalness = 0.0;
        this.specularColor = new Color(0.90, 0.82, 0.74);
        this.color = new Color(0.82, 0.66, 0.52);

        // Subsurface-scattering approximation via thin-walled transmission
        // (thicker dermis than fair skin → larger attenuation distance)
        this.transmission = 0.13;
        this.thickness = 0.015;
        this.attenuationDistance = 0.09;
        this.attenuationColor = new Color(0.78, 0.38, 0.28);

        // Clearcoat for oily/moist T-zone sheen
        this.clearcoat = 0.10;
        this.clearcoatRoughness = 0.35;

        // Sheen for the soft facial fuzz / fine vellus
        this.sheen = 0.14;
        this.sheenColor = new Color(0.88, 0.76, 0.62);
        this.sheenRoughness = 0.55;

        // -------------------------------------------------------------------
        // Anime rendering extensions — medium-skin-specific
        // -------------------------------------------------------------------
        this.skinBands = 3;
        this.skinQuantize = 0.4;
        this.skinSoftness = 0.16;

        // Deeper, warmer SSS bleed typical of medium/olive skin
        this.sssBleedIntensity = 0.26;
        this.sssBleedColor = new Color(0.85, 0.32, 0.24);

        // Skin micro-features
        this.pigmentStrength = 0.12;
        this.sunTanStrength = 0.0;
        this.poreDensity = 0.22;
        this.poreStrength = 0.18;

        // Olive undertone scalar (0 = neutral warm, 1 = strong olive-green)
        this.oliveUndertone = 0.20;
        this.oliveTintColor = new Color(0.55, 0.62, 0.40);

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(0.92, 0.62, 0.42);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (medium skin leans semi-realistic)
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
        return applyMediumSkinCelBanding(
            baseColor,
            output,
            this.skinBands,
            this.skinQuantize,
            this.skinSoftness
        );
    }

    updateMoodColor() {
        gradeMediumSkinColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named human medium-skin preset to this material.
     * @param {string} presetName - One of the keys of `HumanMediumSkinPresets`.
     * @returns {HumanMediumSkinMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = HumanMediumSkinPresets[presetName];
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

        // Per-preset olive undertone
        if (presetName === 'mediterranean-olive') {
            this.oliveUndertone = 0.35;
        } else if (presetName === 'middle-eastern-golden' || presetName === 'southeast-asian-golden') {
            this.oliveUndertone = 0.15;
        } else if (presetName === 'anime-medium') {
            this.oliveUndertone = 0.10;
        } else {
            this.oliveUndertone = 0.20;
        }

        // Anime band softness per preset
        if (presetName === 'anime-medium') {
            this.skinSoftness = 0.12;
            this.skinBands = 4;
            this.sssBleedIntensity = 0.32;
        } else {
            this.skinSoftness = 0.16;
            this.skinBands = 3;
            this.sssBleedIntensity = 0.26;
        }

        this.updateMoodColor();
        return this;
    }

    generateMediumSkinTexture(width, height, scale = 0.04, octaves = 4, poreDensity = 0.22, poreStrength = 0.18) {
        return generateMediumSkinTexture(width, height, scale, octaves, poreDensity, poreStrength, 0.10, this.pigmentStrength, this.sunTanStrength, 0.15);
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
        shader.uniforms.pigmentStrength = { value: this.pigmentStrength };
        shader.uniforms.sunTanStrength = { value: this.sunTanStrength };
        shader.uniforms.poreDensity = { value: this.poreDensity };
        shader.uniforms.poreStrength = { value: this.poreStrength };
        shader.uniforms.oliveUndertone = { value: this.oliveUndertone };
        shader.uniforms.oliveTintColor = { value: this.oliveTintColor };
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
                uniform float pigmentStrength;
                uniform float sunTanStrength;
                uniform float poreDensity;
                uniform float poreStrength;
                uniform float oliveUndertone;
                uniform vec3 oliveTintColor;
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

                // Olive undertone (subtle green-yellow shift)
                if (oliveUndertone > 0.0) {
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * oliveTintColor * 1.6, oliveUndertone * 0.25);
                }

                // Pigment mottle: low-frequency hue/brightness variation
                if (pigmentStrength > 0.0) {
                    float pigment = sin(vUv.x * 12.0 + variationOffset) * cos(vUv.y * 12.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + pigment * pigmentStrength * 0.10);
                }

                // Sun-tan gradient (optional)
                if (sunTanStrength > 0.0) {
                    float tanMask = sin(vUv.y * 3.14159);
                    gl_FragColor.rgb *= (1.0 - tanMask * sunTanStrength * 0.15);
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

                // Warm rim glow on skin edges
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
            this.pigmentStrength, this.sunTanStrength,
            this.poreDensity, this.poreStrength,
            this.oliveUndertone,
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
        this.pigmentStrength = source.pigmentStrength;
        this.sunTanStrength = source.sunTanStrength;
        this.poreDensity = source.poreDensity;
        this.poreStrength = source.poreStrength;
        this.oliveUndertone = source.oliveUndertone;
        this.oliveTintColor.copy(source.oliveTintColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'HumanMediumSkinMaterial';
        if (this.ior !== 1.40) data.ior = this.ior;
        if (this.specularIntensity !== 0.50) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.44) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.10) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.35) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.13) data.transmission = this.transmission;
        if (this.thickness !== 0.015) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.09) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.78, 0.38, 0.28).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.14) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.88, 0.76, 0.62).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.55) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.90, 0.82, 0.74).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.skinBands !== 3) data.skinBands = this.skinBands;
        if (this.skinQuantize !== 0.4) data.skinQuantize = this.skinQuantize;
        if (this.skinSoftness !== 0.16) data.skinSoftness = this.skinSoftness;
        if (this.sssBleedIntensity !== 0.26) data.sssBleedIntensity = this.sssBleedIntensity;
        if (this.sssBleedColor.getHex() !== new Color(0.85, 0.32, 0.24).getHex()) data.sssBleedColor = this.sssBleedColor.getHex();
        if (this.pigmentStrength !== 0.12) data.pigmentStrength = this.pigmentStrength;
        if (this.sunTanStrength !== 0.0) data.sunTanStrength = this.sunTanStrength;
        if (this.poreDensity !== 0.22) data.poreDensity = this.poreDensity;
        if (this.poreStrength !== 0.18) data.poreStrength = this.poreStrength;
        if (this.oliveUndertone !== 0.20) data.oliveUndertone = this.oliveUndertone;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.92, 0.62, 0.42).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.pigmentStrength = json.pigmentStrength ?? this.pigmentStrength;
        this.sunTanStrength = json.sunTanStrength ?? this.sunTanStrength;
        this.poreDensity = json.poreDensity ?? this.poreDensity;
        this.poreStrength = json.poreStrength ?? this.poreStrength;
        this.oliveUndertone = json.oliveUndertone ?? this.oliveUndertone;
        if (json.oliveTintColor !== undefined) this.oliveTintColor.setHex(json.oliveTintColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const HumanMediumSkinMaterialBatchComponent = {
    materialPtr: 'ui32',
    skinBands: 'ui8',
    skinQuantize: 'f64',
    skinSoftness: 'f64',
    sssBleedIntensity: 'f64',
    sssBleedColorR: 'f64',
    sssBleedColorG: 'f64',
    sssBleedColorB: 'f64',
    pigmentStrength: 'f64',
    sunTanStrength: 'f64',
    poreDensity: 'f64',
    poreStrength: 'f64',
    oliveUndertone: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    HumanMediumSkinMaterial,
    HumanMediumSkinMaterialBatch,
    MediumSkinScratchPool,
    HumanMediumSkinMaterialBatchComponent,
    HumanMediumSkinPresets,
    applyMediumSkinCelBanding,
    gradeMediumSkinColor,
    generateMediumSkinTexture
};

export default HumanMediumSkinMaterial;