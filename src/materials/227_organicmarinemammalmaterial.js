// file number : 227
// full path name : src/materials/227_organicmarinemammalmaterial.js
// description : OrganicMarineMammalMaterial — a ready-to-use marine-mammal
//               skin material for whales, dolphins, seals, walruses, and other
//               marine-mammal surfaces. Extends MeshPhysicalMaterial with
//               purpose-built presets for blue whale, humpback whale, dolphin,
//               orca, seal, and walrus. Includes marine-mammal-appropriate PBR
//               defaults (wet-skin IOR ≈ 1.40, roughness 0.25–0.55 for wet
//               smooth-to-rough skin, zero metalness, subtle thin-walled
//               transmission for subsurface blubber translucency, and strong
//               sheen for the wet mucus-like gleam of freshly surfacing
//               animals) plus real-time anime stylization: cel-banded marine
//               highlights, wet-gleam grazing-angle reflections, mood tinting,
//               rim glow, and per-instance variation. Includes a procedural
//               smooth-wet-skin texture generator using low-frequency fBm with
//               fine scratch streaks, optional barnacle patches, and skin
//               micro-texture variation.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Organic marine-mammal skin, whales, dolphins, orcas, seals,
//            walruses, sea lions, manatees, and any marine-mammal surface that
//            needs real-time PBR + anime stylization.
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
// Marine-mammal presets — biologically grounded PBR parameter sets for
// marine-mammal skin types.
//
// Reference values (from marine-mammal skin PBR references, cetacean biology
// literature, and CG wet-skin texture packs):
//   - Wet-skin IOR:              ≈ 1.40 (thin water/mucus film over keratin)
//   - Wet-skin roughness:        0.25–0.55 (glossy when wet, matte when dry)
//   - Metalness:                 0.0 (dielectric)
//   - Transmission:              subtle (0.05–0.15) for blubber translucency
//   - Sheen:                     strong for the wet mucus gleam
//   - Orca/dolphin:              high contrast black/white markings
//   - Walrus/humpback:           weathered, scarred, barnacle-spotted
// ---------------------------------------------------------------------------

const OrganicMarineMammalPresets = {
    'blue-whale': {
        color: [0.42, 0.52, 0.58],
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.30,
        clearcoatRoughness: 0.25,
        transmission: 0.10,
        thickness: 0.02,
        attenuationDistance: 0.08,
        attenuationColor: [0.55, 0.65, 0.72],
        sheen: 0.55,
        sheenColor: [0.65, 0.75, 0.82],
        sheenRoughness: 0.45,
        specularIntensity: 0.60,
        specularColor: [0.80, 0.86, 0.90]
    },
    'humpback-whale': {
        color: [0.28, 0.32, 0.36],
        roughness: 0.50,
        metalness: 0.0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.32,
        transmission: 0.08,
        thickness: 0.02,
        attenuationDistance: 0.07,
        attenuationColor: [0.38, 0.42, 0.48],
        sheen: 0.45,
        sheenColor: [0.55, 0.60, 0.65],
        sheenRoughness: 0.55,
        specularIntensity: 0.52,
        specularColor: [0.72, 0.76, 0.80]
    },
    'dolphin': {
        color: [0.55, 0.62, 0.68],
        roughness: 0.28,
        metalness: 0.0,
        clearcoat: 0.45,
        clearcoatRoughness: 0.15,
        transmission: 0.12,
        thickness: 0.02,
        attenuationDistance: 0.09,
        attenuationColor: [0.65, 0.72, 0.78],
        sheen: 0.65,
        sheenColor: [0.78, 0.84, 0.88],
        sheenRoughness: 0.35,
        specularIntensity: 0.72,
        specularColor: [0.88, 0.92, 0.95]
    },
    'orca': {
        color: [0.04, 0.04, 0.05],
        roughness: 0.26,
        metalness: 0.0,
        clearcoat: 0.50,
        clearcoatRoughness: 0.12,
        transmission: 0.10,
        thickness: 0.02,
        attenuationDistance: 0.08,
        attenuationColor: [0.08, 0.08, 0.10],
        sheen: 0.60,
        sheenColor: [0.30, 0.35, 0.42],
        sheenRoughness: 0.40,
        specularIntensity: 0.75,
        specularColor: [0.90, 0.92, 0.95]
    },
    'seal': {
        color: [0.42, 0.38, 0.34],
        roughness: 0.48,
        metalness: 0.0,
        clearcoat: 0.22,
        clearcoatRoughness: 0.35,
        transmission: 0.08,
        thickness: 0.015,
        attenuationDistance: 0.07,
        attenuationColor: [0.52, 0.48, 0.42],
        sheen: 0.48,
        sheenColor: [0.62, 0.58, 0.52],
        sheenRoughness: 0.55,
        specularIntensity: 0.55,
        specularColor: [0.78, 0.74, 0.70]
    },
    'walrus': {
        color: [0.58, 0.48, 0.40],
        roughness: 0.62,
        metalness: 0.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.45,
        transmission: 0.06,
        thickness: 0.015,
        attenuationDistance: 0.06,
        attenuationColor: [0.65, 0.55, 0.45],
        sheen: 0.38,
        sheenColor: [0.72, 0.62, 0.52],
        sheenRoughness: 0.65,
        specularIntensity: 0.45,
        specularColor: [0.78, 0.72, 0.65]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable marine-mammal scratch records
// ---------------------------------------------------------------------------

class MarineMammalScratchPool {
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

const _marineMammalScratchPool = new MarineMammalScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — marine-mammal-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded marine-mammal highlights. Marine-mammal skin has a wet,
 * smooth, low-frequency shading with a strong wet gleam — quantizing it into
 * discrete bands produces the crisp anime marine-mammal edges seen in
 * hand-drawn underwater scenes.
 */
function applyMarineMammalCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.12) {
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
 * Apply mood-based tinting to marine-mammal skin. Warm moods push skin
 * toward warm grey-blue, cool moods toward cool steel-blue — matching the
 * atmospheric marine-mammal tinting seen in stylized underwater scenes.
 */
function gradeMarineMammalColor(color, temperature, saturation, brightness, contrast) {
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

    // Marine-mammal-specific temperature bias: warm shift pushes toward
    // warm grey-blue, cool shift pushes toward steel-blue.
    r += temperature * 0.02;
    g += temperature * 0.01;
    b -= temperature * 0.02;

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
 * Generate a procedural marine-mammal wet-skin texture. The algorithm:
 * 1. Multi-octave fBm for the low-frequency skin base tone (subtle wet-skin
 *    mottling).
 * 2. Fine scratch streaks: directional noise stretched along the body axis,
 *    simulating rake marks, scars, and skin micro-folds.
 * 3. Per-scratch hashing for small colour variation between marks.
 * 4. Optional barnacle patches: hashed cell clusters with darker/greyer tint
 *    for humpback whale-style encrustations.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateMarineMammalSkinTexture(width, height, scale = 0.02, octaves = 4, scratchStrength = 0.15, scratchDensity = 8.0, barnacleStrength = 0.0, barnacleDensity = 0.10) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Multi-octave fBm base tone ---
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

            // --- 2. Fine scratch streaks ---
            // Stretch noise along x-axis (body length) more than y
            const scratch = SimplexNoise.noise2D(x * 0.01 * scratchDensity, y * 0.15 * scratchDensity) * 0.5 + 0.5;
            const scratchMask = Math.pow(1.0 - Math.abs(scratch * 2.0 - 1.0), 3.0) * scratchStrength;

            // --- 3. Per-scratch hashing ---
            const scratchCell = Math.floor(y * 0.15 * scratchDensity);
            const scratchHash = Math.abs(Math.sin(scratchCell * 12.9898) * 43758.5453) % 1.0;
            const scratchTint = 0.85 + scratchHash * 0.15;

            // --- 4. Barnacle patches (optional) ---
            let barnacle = 0;
            if (barnacleStrength > 0) {
                const cellX = Math.floor(x * 0.25);
                const cellY = Math.floor(y * 0.25);
                const cellId = cellX * 73856093 ^ cellY * 19349663;
                const barnacleHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;
                if (barnacleHash > (1.0 - barnacleDensity)) {
                    const h2 = Math.abs(Math.sin(cellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                    const h3 = Math.abs(Math.sin(cellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                    const cx = (x * 0.25) - cellX - h2;
                    const cy = (y * 0.25) - cellY - h3;
                    const dist = Math.sqrt(cx * cx + cy * cy);
                    barnacle = Math.max(0, 1.0 - dist * 4.0) * barnacleStrength;
                }
            }

            // --- Combine ---
            let value = 0.55
                + (fbm - 0.5) * 0.15
                - scratchMask * 0.20 * scratchTint
                - barnacle * 0.30;

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

const _marineMammalWorld = BitECS.createWorld();
const OrganicMarineMammalMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    marineBands: 'ui8',
    marineQuantize: 'f64',
    marineSoftness: 'f64',
    wetGleamIntensity: 'f64',
    scratchStrength: 'f64',
    scratchDensity: 'f64',
    barnacleStrength: 'f64',
    barnacleDensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicMarineMammalMaterialBatch {
    constructor() {
        this.world = _marineMammalWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicMarineMammalMaterialComponent, eid);
        OrganicMarineMammalMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicMarineMammalMaterialComponent.marineBands[eid] = material.marineBands;
        OrganicMarineMammalMaterialComponent.marineQuantize[eid] = material.marineQuantize;
        OrganicMarineMammalMaterialComponent.marineSoftness[eid] = material.marineSoftness;
        OrganicMarineMammalMaterialComponent.wetGleamIntensity[eid] = material.wetGleamIntensity;
        OrganicMarineMammalMaterialComponent.scratchStrength[eid] = material.scratchStrength;
        OrganicMarineMammalMaterialComponent.scratchDensity[eid] = material.scratchDensity;
        OrganicMarineMammalMaterialComponent.barnacleStrength[eid] = material.barnacleStrength;
        OrganicMarineMammalMaterialComponent.barnacleDensity[eid] = material.barnacleDensity;
        OrganicMarineMammalMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicMarineMammalMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicMarineMammalMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicMarineMammalMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicMarineMammalMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicMarineMammalMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicMarineMammalMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicMarineMammalMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.marineBands = OrganicMarineMammalMaterialComponent.marineBands[eid];
            material.marineQuantize = OrganicMarineMammalMaterialComponent.marineQuantize[eid];
            material.marineSoftness = OrganicMarineMammalMaterialComponent.marineSoftness[eid];
            material.wetGleamIntensity = OrganicMarineMammalMaterialComponent.wetGleamIntensity[eid];
            material.scratchStrength = OrganicMarineMammalMaterialComponent.scratchStrength[eid];
            material.scratchDensity = OrganicMarineMammalMaterialComponent.scratchDensity[eid];
            material.barnacleStrength = OrganicMarineMammalMaterialComponent.barnacleStrength[eid];
            material.barnacleDensity = OrganicMarineMammalMaterialComponent.barnacleDensity[eid];
            material.moodTemperature = OrganicMarineMammalMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicMarineMammalMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicMarineMammalMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicMarineMammalMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicMarineMammalMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicMarineMammalMaterialComponent.variationSeed[eid];

            OrganicMarineMammalMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicMarineMammalMaterial class
// ---------------------------------------------------------------------------

class OrganicMarineMammalMaterial extends MeshPhysicalMaterial {
    static {
        _marineMammalScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicMarineMammalMaterial = true;
        this.type = 'OrganicMarineMammalMaterial';

        // -------------------------------------------------------------------
        // Marine-mammal-specific PBR defaults (dolphin baseline)
        // -------------------------------------------------------------------
        this.ior = 1.40;
        this.specularIntensity = 0.72;
        this.roughness = 0.28;
        this.metalness = 0.0;
        this.specularColor = new Color(0.88, 0.92, 0.95);
        this.color = new Color(0.55, 0.62, 0.68);

        // Clearcoat for wet mucus layer
        this.clearcoat = 0.45;
        this.clearcoatRoughness = 0.15;

        // Thin-walled transmission for blubber translucency
        this.transmission = 0.12;
        this.thickness = 0.02;
        this.attenuationDistance = 0.09;
        this.attenuationColor = new Color(0.65, 0.72, 0.78);

        // Sheen for the wet mucus gleam
        this.sheen = 0.65;
        this.sheenColor = new Color(0.78, 0.84, 0.88);
        this.sheenRoughness = 0.35;

        // -------------------------------------------------------------------
        // Anime rendering extensions — marine-mammal-specific
        // -------------------------------------------------------------------
        this.marineBands = 3;
        this.marineQuantize = 0.4;
        this.marineSoftness = 0.12;
        this.wetGleamIntensity = 0.55;
        this.scratchStrength = 0.15;
        this.scratchDensity = 8.0;
        this.barnacleStrength = 0.0;
        this.barnacleDensity = 0.10;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.78, 0.84, 0.88);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (marine-mammal skin leans semi-realistic)
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

    applyMarineBanding(baseColor, output) {
        return applyMarineMammalCelBanding(
            baseColor,
            output,
            this.marineBands,
            this.marineQuantize,
            this.marineSoftness
        );
    }

    updateMoodColor() {
        gradeMarineMammalColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic marine-mammal preset to this material.
     * @param {string} presetName - One of the keys of `OrganicMarineMammalPresets`.
     * @returns {OrganicMarineMammalMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicMarineMammalPresets[presetName];
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
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Per-preset anime tuning
        if (presetName === 'dolphin' || presetName === 'orca') {
            this.marineSoftness = 0.06;
            this.marineBands = 4;
            this.wetGleamIntensity = 0.75;
            this.barnacleStrength = 0.0;
            this.barnacleDensity = 0.0;
        } else if (presetName === 'humpback-whale') {
            this.marineSoftness = 0.20;
            this.marineBands = 2;
            this.wetGleamIntensity = 0.40;
            this.barnacleStrength = 0.25;
            this.barnacleDensity = 0.15;
            this.scratchStrength = 0.25;
        } else if (presetName === 'walrus') {
            this.marineSoftness = 0.22;
            this.marineBands = 2;
            this.wetGleamIntensity = 0.30;
            this.scratchStrength = 0.20;
        } else {
            this.marineSoftness = 0.12;
            this.marineBands = 3;
            this.wetGleamIntensity = 0.55;
            this.barnacleStrength = 0.0;
        }

        this.updateMoodColor();
        return this;
    }

    generateMarineMammalSkinTexture(width, height, scale = 0.02, octaves = 4, scratchStrength = 0.15, scratchDensity = 8.0, barnacleStrength = 0.0) {
        return generateMarineMammalSkinTexture(width, height, scale, octaves, scratchStrength, scratchDensity, barnacleStrength, 0.10);
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

        shader.uniforms.marineBands = { value: this.marineBands };
        shader.uniforms.marineQuantize = { value: this.marineQuantize };
        shader.uniforms.marineSoftness = { value: this.marineSoftness };
        shader.uniforms.wetGleamIntensity = { value: this.wetGleamIntensity };
        shader.uniforms.scratchStrength = { value: this.scratchStrength };
        shader.uniforms.scratchDensity = { value: this.scratchDensity };
        shader.uniforms.barnacleStrength = { value: this.barnacleStrength };
        shader.uniforms.barnacleDensity = { value: this.barnacleDensity };
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
                uniform int marineBands;
                uniform float marineQuantize;
                uniform float marineSoftness;
                uniform float wetGleamIntensity;
                uniform float scratchStrength;
                uniform float scratchDensity;
                uniform float barnacleStrength;
                uniform float barnacleDensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyMarineBands(vec3 baseColor) {
                    if (marineBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(marineBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * marineSoftness;
                    float finalLum = mix(lum, softQuantized, marineQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply marine-mammal cel banding
                gl_FragColor.rgb = applyMarineBands(gl_FragColor.rgb);

                // Scratch streak approximation
                if (scratchStrength > 0.0) {
                    vec2 scratchUV = vUv * vec2(4.0, 60.0);
                    float scratchHash = fract(sin(floor(scratchUV.y) * 12.9898) * 43758.5453);
                    float scratchMask = smoothstep(0.6, 0.0, abs(fract(scratchUV.x) - 0.5)) * (scratchHash > 0.7 ? 1.0 : 0.0);
                    gl_FragColor.rgb *= (1.0 - scratchMask * scratchStrength * 0.3);
                }

                // Barnacle patches
                if (barnacleStrength > 0.0) {
                    vec2 barnacleUV = vUv * 25.0;
                    vec2 barnacleCell = floor(barnacleUV);
                    vec2 barnacleFrac = fract(barnacleUV);
                    float barnacleHash = fract(sin(dot(barnacleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (barnacleHash > (1.0 - barnacleDensity)) {
                        vec2 barnacleCentre = vec2(fract(barnacleHash * 7.31), fract(barnacleHash * 13.7));
                        float barnacleDist = length(barnacleFrac - barnacleCentre);
                        float barnacleMask = max(0.0, 1.0 - barnacleDist * 3.0);
                        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.55, 0.52, 0.48), barnacleMask * barnacleStrength);
                    }
                }

                // Wet gleam: strong grazing-angle specular reflection
                if (wetGleamIntensity > 0.0) {
                    float ndotvMarine = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float wetGleam = pow(1.0 - ndotvMarine, 3.5) * wetGleamIntensity;
                    gl_FragColor.rgb += sheenColor * wetGleam * 0.5;
                }

                // Cool-tinted rim glow on marine-mammal edges
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
            this.marineBands, this.marineQuantize, this.marineSoftness,
            this.wetGleamIntensity, this.scratchStrength, this.scratchDensity,
            this.barnacleStrength, this.barnacleDensity,
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
        this.marineBands = source.marineBands;
        this.marineQuantize = source.marineQuantize;
        this.marineSoftness = source.marineSoftness;
        this.wetGleamIntensity = source.wetGleamIntensity;
        this.scratchStrength = source.scratchStrength;
        this.scratchDensity = source.scratchDensity;
        this.barnacleStrength = source.barnacleStrength;
        this.barnacleDensity = source.barnacleDensity;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicMarineMammalMaterial';
        if (this.ior !== 1.40) data.ior = this.ior;
        if (this.specularIntensity !== 0.72) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.28) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.45) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.15) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.12) data.transmission = this.transmission;
        if (this.thickness !== 0.02) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.09) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.65, 0.72, 0.78).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.65) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.78, 0.84, 0.88).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.35) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.88, 0.92, 0.95).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.marineBands !== 3) data.marineBands = this.marineBands;
        if (this.marineQuantize !== 0.4) data.marineQuantize = this.marineQuantize;
        if (this.marineSoftness !== 0.12) data.marineSoftness = this.marineSoftness;
        if (this.wetGleamIntensity !== 0.55) data.wetGleamIntensity = this.wetGleamIntensity;
        if (this.scratchStrength !== 0.15) data.scratchStrength = this.scratchStrength;
        if (this.scratchDensity !== 8.0) data.scratchDensity = this.scratchDensity;
        if (this.barnacleStrength !== 0.0) data.barnacleStrength = this.barnacleStrength;
        if (this.barnacleDensity !== 0.10) data.barnacleDensity = this.barnacleDensity;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.78, 0.84, 0.88).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.marineBands = json.marineBands ?? this.marineBands;
        this.marineQuantize = json.marineQuantize ?? this.marineQuantize;
        this.marineSoftness = json.marineSoftness ?? this.marineSoftness;
        this.wetGleamIntensity = json.wetGleamIntensity ?? this.wetGleamIntensity;
        this.scratchStrength = json.scratchStrength ?? this.scratchStrength;
        this.scratchDensity = json.scratchDensity ?? this.scratchDensity;
        this.barnacleStrength = json.barnacleStrength ?? this.barnacleStrength;
        this.barnacleDensity = json.barnacleDensity ?? this.barnacleDensity;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicMarineMammalMaterialBatchComponent = {
    materialPtr: 'ui32',
    marineBands: 'ui8',
    marineQuantize: 'f64',
    marineSoftness: 'f64',
    wetGleamIntensity: 'f64',
    scratchStrength: 'f64',
    scratchDensity: 'f64',
    barnacleStrength: 'f64',
    barnacleDensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicMarineMammalMaterial,
    OrganicMarineMammalMaterialBatch,
    MarineMammalScratchPool,
    OrganicMarineMammalMaterialBatchComponent,
    OrganicMarineMammalPresets,
    applyMarineMammalCelBanding,
    gradeMarineMammalColor,
    generateMarineMammalSkinTexture
};

export default OrganicMarineMammalMaterial;