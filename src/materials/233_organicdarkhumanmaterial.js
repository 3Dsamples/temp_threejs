// file number : 233
// full path name : src/materials/233_organicdarkhumanmaterial.js
// description : OrganicDarkHumanMaterial — a ready-to-use human-skin material
//               specializing in deep/rich phototypes (Fitzpatrick V–VI,
//               African, Afro-Caribbean, Afro-Latin, South Indian, Melanesian
//               complexions). Extends MeshPhysicalMaterial with biologically
//               grounded PBR defaults matching published real-time skin
//               references: skin IOR ≈ 1.40, roughness ≈ 0.44, zero metalness,
//               thicker dermis (larger attenuationDistance for melanin-rich
//               skin), deeper red-umber SSS bleed, and clearcoat for the
//               characteristic oily sheen of dark skin. Adds real-time anime
//               stylization: cel-banded skin highlights, warm-umber SSS bleed
//               rim, mood tinting with subtle blue-undertone support, rim glow,
//               and per-instance variation. Includes a procedural skin texture
//               generator with multi-octave fBm, hashed pores, directional
//               wrinkles, melanin-rich pigment mottle, and optional
//               sun-exposure gradient mask.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Human dark skin, African characters, Afro-Caribbean characters,
//            Afro-Latin characters, South Indian characters, Melanesian
//            characters, rich-toned anime leads, portrait renders, and any
//            deep human skin surface that needs real-time PBR + anime
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
// Human dark-skin presets — biologically grounded PBR parameter sets for
// Fitzpatrick V–VI phototypes.
//
// Reference values (from Filament, Pixar LamaSSS, Unreal digital-human, and
// dermatology literature):
//   - Skin IOR:                          1.40
//   - Dark skin roughness:               0.42–0.48 (0.44 nominal)
//   - Higher melanin → larger attenuation distance (0.10–0.12)
//   - Deeper red-umber SSS bleed:        (~0.65, 0.28, 0.22)
//   - Clearcoat (oily sheen):            0.12–0.15 (dark skin shows sheen
//                                        more prominently)
//   - Metalness:                         0.0 (skin is a dielectric)
//   - Blue/purple undertone option:      slight B component boost for
//                                        certain rich complexions
// ---------------------------------------------------------------------------

const OrganicDarkHumanPresets = {
    'african-rich-umber': {
        color: [0.42, 0.28, 0.20],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.13,
        clearcoatRoughness: 0.32,
        transmission: 0.14,
        thickness: 0.015,
        attenuationDistance: 0.11,
        attenuationColor: [0.62, 0.26, 0.20],
        specularIntensity: 0.52,
        specularColor: [0.78, 0.68, 0.60],
        sheen: 0.15,
        sheenColor: [0.72, 0.58, 0.48],
        sheenRoughness: 0.55
    },
    'afro-caribbean-warm': {
        color: [0.38, 0.26, 0.18],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.14,
        clearcoatRoughness: 0.30,
        transmission: 0.15,
        thickness: 0.015,
        attenuationDistance: 0.11,
        attenuationColor: [0.58, 0.24, 0.18],
        specularIntensity: 0.54,
        specularColor: [0.76, 0.66, 0.58],
        sheen: 0.16,
        sheenColor: [0.70, 0.56, 0.46],
        sheenRoughness: 0.55
    },
    'south-indian-deep': {
        color: [0.34, 0.22, 0.16],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.13,
        clearcoatRoughness: 0.32,
        transmission: 0.14,
        thickness: 0.015,
        attenuationDistance: 0.12,
        attenuationColor: [0.52, 0.20, 0.16],
        specularIntensity: 0.52,
        specularColor: [0.74, 0.64, 0.56],
        sheen: 0.15,
        sheenColor: [0.68, 0.54, 0.44],
        sheenRoughness: 0.55
    },
    'melanesian-rich': {
        color: [0.28, 0.20, 0.14],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.12,
        clearcoatRoughness: 0.33,
        transmission: 0.13,
        thickness: 0.015,
        attenuationDistance: 0.12,
        attenuationColor: [0.44, 0.18, 0.14],
        specularIntensity: 0.50,
        specularColor: [0.72, 0.62, 0.54],
        sheen: 0.14,
        sheenColor: [0.66, 0.52, 0.42],
        sheenRoughness: 0.55
    },
    'anime-dark': {
        color: [0.32, 0.22, 0.16],
        roughness: 0.40,
        metalness: 0.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.28,
        transmission: 0.16,
        thickness: 0.015,
        attenuationDistance: 0.12,
        attenuationColor: [0.55, 0.22, 0.18],
        specularIntensity: 0.56,
        specularColor: [0.80, 0.68, 0.58],
        sheen: 0.18,
        sheenColor: [0.72, 0.58, 0.46],
        sheenRoughness: 0.50
    },
    'blue-undertone-dark': {
        color: [0.30, 0.22, 0.20],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.13,
        clearcoatRoughness: 0.32,
        transmission: 0.14,
        thickness: 0.015,
        attenuationDistance: 0.11,
        attenuationColor: [0.50, 0.22, 0.22],
        specularIntensity: 0.52,
        specularColor: [0.74, 0.66, 0.62],
        sheen: 0.16,
        sheenColor: [0.68, 0.56, 0.52],
        sheenRoughness: 0.55
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable dark-skin scratch records
// ---------------------------------------------------------------------------

class DarkHumanScratchPool {
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

const _darkHumanScratchPool = new DarkHumanScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — dark-skin-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded dark-skin highlights. Dark skin has rich, warm, low-
 * frequency shading with a strong sheen — quantizing it into discrete bands
 * produces the crisp anime dark-skin edges seen in hand-drawn character
 * illustrations.
 */
function applyDarkHumanCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.16) {
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
 * Apply mood-based tinting to dark skin. Warm moods push skin toward warm
 * mahogany/amber; cool moods toward a cool blue-undertone rich brown. The
 * blue undertone is preserved by allowing a slight B-component shift.
 */
function gradeDarkHumanColor(color, temperature, saturation, brightness, contrast) {
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

    // Dark-skin-specific temperature bias: warm shift pushes toward mahogany/
    // amber (R and G up, B down); cool shift pushes toward blue-undertone
    // rich brown (B up, R slightly down).
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
 * Generate a procedural dark-skin texture. The algorithm:
 * 1. Multi-octave fBm for the low-frequency subcutaneous blotch (natural
 *    pigment variation with warmer undertone).
 * 2. Hashed pore field: per-cell presence, jittered centre, small radial
 *    falloff — producing the micro-pitted skin surface.
 * 3. Directional micro-grooves for fine wrinkles at two crossed angles.
 * 4. Melanin mottle: slightly larger cells for uneven pigmentation typical
 *    of melanin-rich skin.
 * 5. Optional sun-exposure gradient: a soft v-driven darkening mask for
 *    sun-exposed regions.
 * 6. SSS bleed mask: soft radial-weighted noise for the warm-umber tint.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * bump-map, or normal-map derivation.
 */
function generateDarkHumanTexture(width, height, scale = 0.04, octaves = 4, poreDensity = 0.22, poreStrength = 0.18, wrinkleStrength = 0.10, melaninStrength = 0.15, sunExposureStrength = 0.0, sssBleedStrength = 0.15) {
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

            // --- 4. Melanin mottle ---
            const melanin = (SimplexNoise.noise2D(x * 0.008, y * 0.008) * 0.5 + 0.5 - 0.5) * melaninStrength;

            // --- 5. Sun-exposure gradient (optional) ---
            let sunExposure = 0;
            if (sunExposureStrength > 0) {
                const t = y / height;
                sunExposure = Math.sin(t * Math.PI) * sunExposureStrength;
            }

            // --- 6. SSS bleed mask ---
            const sss = SimplexNoise.noise2D(x * 0.01, y * 0.01) * 0.5 + 0.5;
            const sssMask = Math.max(0, sss - 0.5) * sssBleedStrength;

            // --- Combine ---
            let value = 0.52
                + (fbm - 0.5) * 0.18
                - pore * 0.60
                + wrinkles
                + melanin
                - sunExposure * 0.15
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

const _darkHumanWorld = BitECS.createWorld();
const OrganicDarkHumanMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    skinBands: 'ui8',
    skinQuantize: 'f64',
    skinSoftness: 'f64',
    sssBleedIntensity: 'f64',
    sssBleedColorR: 'f64',
    sssBleedColorG: 'f64',
    sssBleedColorB: 'f64',
    melaninStrength: 'f64',
    sunExposureStrength: 'f64',
    poreDensity: 'f64',
    poreStrength: 'f64',
    blueUndertone: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicDarkHumanMaterialBatch {
    constructor() {
        this.world = _darkHumanWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicDarkHumanMaterialComponent, eid);
        OrganicDarkHumanMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicDarkHumanMaterialComponent.skinBands[eid] = material.skinBands;
        OrganicDarkHumanMaterialComponent.skinQuantize[eid] = material.skinQuantize;
        OrganicDarkHumanMaterialComponent.skinSoftness[eid] = material.skinSoftness;
        OrganicDarkHumanMaterialComponent.sssBleedIntensity[eid] = material.sssBleedIntensity;
        OrganicDarkHumanMaterialComponent.sssBleedColorR[eid] = material.sssBleedColor.r;
        OrganicDarkHumanMaterialComponent.sssBleedColorG[eid] = material.sssBleedColor.g;
        OrganicDarkHumanMaterialComponent.sssBleedColorB[eid] = material.sssBleedColor.b;
        OrganicDarkHumanMaterialComponent.melaninStrength[eid] = material.melaninStrength;
        OrganicDarkHumanMaterialComponent.sunExposureStrength[eid] = material.sunExposureStrength;
        OrganicDarkHumanMaterialComponent.poreDensity[eid] = material.poreDensity;
        OrganicDarkHumanMaterialComponent.poreStrength[eid] = material.poreStrength;
        OrganicDarkHumanMaterialComponent.blueUndertone[eid] = material.blueUndertone;
        OrganicDarkHumanMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicDarkHumanMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicDarkHumanMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicDarkHumanMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicDarkHumanMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicDarkHumanMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicDarkHumanMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicDarkHumanMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.skinBands = OrganicDarkHumanMaterialComponent.skinBands[eid];
            material.skinQuantize = OrganicDarkHumanMaterialComponent.skinQuantize[eid];
            material.skinSoftness = OrganicDarkHumanMaterialComponent.skinSoftness[eid];
            material.sssBleedIntensity = OrganicDarkHumanMaterialComponent.sssBleedIntensity[eid];
            material.sssBleedColor.setRGB(
                OrganicDarkHumanMaterialComponent.sssBleedColorR[eid],
                OrganicDarkHumanMaterialComponent.sssBleedColorG[eid],
                OrganicDarkHumanMaterialComponent.sssBleedColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.melaninStrength = OrganicDarkHumanMaterialComponent.melaninStrength[eid];
            material.sunExposureStrength = OrganicDarkHumanMaterialComponent.sunExposureStrength[eid];
            material.poreDensity = OrganicDarkHumanMaterialComponent.poreDensity[eid];
            material.poreStrength = OrganicDarkHumanMaterialComponent.poreStrength[eid];
            material.blueUndertone = OrganicDarkHumanMaterialComponent.blueUndertone[eid];
            material.moodTemperature = OrganicDarkHumanMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicDarkHumanMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicDarkHumanMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicDarkHumanMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicDarkHumanMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicDarkHumanMaterialComponent.variationSeed[eid];

            OrganicDarkHumanMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicDarkHumanMaterial class
// ---------------------------------------------------------------------------

class OrganicDarkHumanMaterial extends MeshPhysicalMaterial {
    static {
        _darkHumanScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicDarkHumanMaterial = true;
        this.type = 'OrganicDarkHumanMaterial';

        // -------------------------------------------------------------------
        // Dark-skin-specific PBR defaults (african-rich-umber baseline)
        // -------------------------------------------------------------------
        this.ior = 1.40;
        this.specularIntensity = 0.52;
        this.roughness = 0.44;
        this.metalness = 0.0;
        this.specularColor = new Color(0.78, 0.68, 0.60);
        this.color = new Color(0.42, 0.28, 0.20);

        // Subsurface-scattering approximation via thin-walled transmission
        // (thicker dermis than fair skin → larger attenuation distance)
        this.transmission = 0.14;
        this.thickness = 0.015;
        this.attenuationDistance = 0.11;
        this.attenuationColor = new Color(0.62, 0.26, 0.20);

        // Clearcoat for the oily sheen (more prominent on dark skin)
        this.clearcoat = 0.13;
        this.clearcoatRoughness = 0.32;

        // Sheen for the soft facial fuzz / fine vellus
        this.sheen = 0.15;
        this.sheenColor = new Color(0.72, 0.58, 0.48);
        this.sheenRoughness = 0.55;

        // -------------------------------------------------------------------
        // Anime rendering extensions — dark-skin-specific
        // -------------------------------------------------------------------
        this.skinBands = 3;
        this.skinQuantize = 0.4;
        this.skinSoftness = 0.16;

        // Deeper, warmer SSS bleed typical of dark skin
        this.sssBleedIntensity = 0.24;
        this.sssBleedColor = new Color(0.72, 0.28, 0.20);

        // Skin micro-features
        this.melaninStrength = 0.15;
        this.sunExposureStrength = 0.0;
        this.poreDensity = 0.22;
        this.poreStrength = 0.18;

        // Blue undertone scalar (0 = neutral warm, 1 = strong blue)
        this.blueUndertone = 0.15;
        this.blueTintColor = new Color(0.55, 0.58, 0.72);

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(0.82, 0.55, 0.42);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (dark skin leans semi-realistic)
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
        return applyDarkHumanCelBanding(
            baseColor,
            output,
            this.skinBands,
            this.skinQuantize,
            this.skinSoftness
        );
    }

    updateMoodColor() {
        gradeDarkHumanColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named human dark-skin preset to this material.
     * @param {string} presetName - One of the keys of `OrganicDarkHumanPresets`.
     * @returns {OrganicDarkHumanMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicDarkHumanPresets[presetName];
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

        // Per-preset blue undertone
        if (presetName === 'blue-undertone-dark') {
            this.blueUndertone = 0.45;
        } else if (presetName === 'african-rich-umber' || presetName === 'afro-caribbean-warm') {
            this.blueUndertone = 0.15;
        } else {
            this.blueUndertone = 0.10;
        }

        // Anime band softness per preset
        if (presetName === 'anime-dark') {
            this.skinSoftness = 0.10;
            this.skinBands = 4;
            this.sssBleedIntensity = 0.30;
        } else {
            this.skinSoftness = 0.16;
            this.skinBands = 3;
            this.sssBleedIntensity = 0.24;
        }

        this.updateMoodColor();
        return this;
    }

    generateDarkHumanTexture(width, height, scale = 0.04, octaves = 4, poreDensity = 0.22, poreStrength = 0.18) {
        return generateDarkHumanTexture(width, height, scale, octaves, poreDensity, poreStrength, 0.10, this.melaninStrength, this.sunExposureStrength, 0.15);
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
        shader.uniforms.melaninStrength = { value: this.melaninStrength };
        shader.uniforms.sunExposureStrength = { value: this.sunExposureStrength };
        shader.uniforms.poreDensity = { value: this.poreDensity };
        shader.uniforms.poreStrength = { value: this.poreStrength };
        shader.uniforms.blueUndertone = { value: this.blueUndertone };
        shader.uniforms.blueTintColor = { value: this.blueTintColor };
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
                uniform float melaninStrength;
                uniform float sunExposureStrength;
                uniform float poreDensity;
                uniform float poreStrength;
                uniform float blueUndertone;
                uniform vec3 blueTintColor;
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

                // Blue undertone (subtle cool-brown shift)
                if (blueUndertone > 0.0) {
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * blueTintColor * 1.6, blueUndertone * 0.25);
                }

                // Melanin mottle: low-frequency hue/brightness variation
                if (melaninStrength > 0.0) {
                    float melanin = sin(vUv.x * 12.0 + variationOffset) * cos(vUv.y * 12.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + melanin * melaninStrength * 0.12);
                }

                // Sun-exposure gradient (optional)
                if (sunExposureStrength > 0.0) {
                    float tanMask = sin(vUv.y * 3.14159);
                    gl_FragColor.rgb *= (1.0 - tanMask * sunExposureStrength * 0.12);
                }

                // Pore approximation: fine hashed darkening
                if (poreStrength > 0.0) {
                    vec2 poreUV = vUv * 200.0;
                    vec2 poreCell = floor(poreUV);
                    float poreHash = fract(sin(dot(poreCell, vec2(39.425, 1.57))) * 43758.5453);
                    float poreMask = poreHash > (1.0 - poreDensity) ? 1.0 : 0.0;
                    gl_FragColor.rgb *= (1.0 - poreMask * poreStrength * 0.15);
                }

                // SSS bleed: warm-umber rim on silhouettes (approximates subsurface scattering)
                if (sssBleedIntensity > 0.0) {
                    float ndotvSkin = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float bleed = pow(1.0 - ndotvSkin, 3.0) * sssBleedIntensity;
                    gl_FragColor.rgb += sssBleedColor * bleed;
                }

                // Warm-umber rim glow on skin edges
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
            this.melaninStrength, this.sunExposureStrength,
            this.poreDensity, this.poreStrength,
            this.blueUndertone,
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
        this.melaninStrength = source.melaninStrength;
        this.sunExposureStrength = source.sunExposureStrength;
        this.poreDensity = source.poreDensity;
        this.poreStrength = source.poreStrength;
        this.blueUndertone = source.blueUndertone;
        this.blueTintColor.copy(source.blueTintColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicDarkHumanMaterial';
        if (this.ior !== 1.40) data.ior = this.ior;
        if (this.specularIntensity !== 0.52) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.44) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.13) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.32) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.14) data.transmission = this.transmission;
        if (this.thickness !== 0.015) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.11) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.62, 0.26, 0.20).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.15) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.72, 0.58, 0.48).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.55) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.78, 0.68, 0.60).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.skinBands !== 3) data.skinBands = this.skinBands;
        if (this.skinQuantize !== 0.4) data.skinQuantize = this.skinQuantize;
        if (this.skinSoftness !== 0.16) data.skinSoftness = this.skinSoftness;
        if (this.sssBleedIntensity !== 0.24) data.sssBleedIntensity = this.sssBleedIntensity;
        if (this.sssBleedColor.getHex() !== new Color(0.72, 0.28, 0.20).getHex()) data.sssBleedColor = this.sssBleedColor.getHex();
        if (this.melaninStrength !== 0.15) data.melaninStrength = this.melaninStrength;
        if (this.sunExposureStrength !== 0.0) data.sunExposureStrength = this.sunExposureStrength;
        if (this.poreDensity !== 0.22) data.poreDensity = this.poreDensity;
        if (this.poreStrength !== 0.18) data.poreStrength = this.poreStrength;
        if (this.blueUndertone !== 0.15) data.blueUndertone = this.blueUndertone;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.82, 0.55, 0.42).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.melaninStrength = json.melaninStrength ?? this.melaninStrength;
        this.sunExposureStrength = json.sunExposureStrength ?? this.sunExposureStrength;
        this.poreDensity = json.poreDensity ?? this.poreDensity;
        this.poreStrength = json.poreStrength ?? this.poreStrength;
        this.blueUndertone = json.blueUndertone ?? this.blueUndertone;
        if (json.blueTintColor !== undefined) this.blueTintColor.setHex(json.blueTintColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicDarkHumanMaterialBatchComponent = {
    materialPtr: 'ui32',
    skinBands: 'ui8',
    skinQuantize: 'f64',
    skinSoftness: 'f64',
    sssBleedIntensity: 'f64',
    sssBleedColorR: 'f64',
    sssBleedColorG: 'f64',
    sssBleedColorB: 'f64',
    melaninStrength: 'f64',
    sunExposureStrength: 'f64',
    poreDensity: 'f64',
    poreStrength: 'f64',
    blueUndertone: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicDarkHumanMaterial,
    OrganicDarkHumanMaterialBatch,
    DarkHumanScratchPool,
    OrganicDarkHumanMaterialBatchComponent,
    OrganicDarkHumanPresets,
    applyDarkHumanCelBanding,
    gradeDarkHumanColor,
    generateDarkHumanTexture
};

export default OrganicDarkHumanMaterial;