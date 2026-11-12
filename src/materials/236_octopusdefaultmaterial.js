// file number : 236
// full path name : src/materials/236_octopusdefaultmaterial.js
// description : OctopusDefaultMaterial — a ready-to-use octopus skin material
//               for cephalopod rendering covering the base dermal surface. 
//               Extends MeshPhysicalMaterial with purpose-built presets for
//               common octopus species (common octopus, giant Pacific octopus,
//               blue-ringed octopus, mimic octopus, and deep-sea octopus).
//               Includes octopus-appropriate PBR defaults grounded in real
//               cephalopod references: wet skin with a soft glossy finish
//               (roughness ≈ 0.28–0.40), slight clearcoat for the mucous
//               layer (0.20–0.35), subtle transmission for translucent
//               membranes, and a sheen lobe for the soft dermal glow.
//               Adds real-time anime stylization: cel-banded skin highlights,
//               speckle pattern approximation (chromatophore precursors),
//               mood tinting, rim glow, and per-instance variation.
//               Includes a procedural octopus-skin texture generator using
//               multi-octave fBm with white/grey speckle cells and optional
//               papillae bump. All imports resolve to the internal
//               Threejs_gl repository tree; no CDN dependencies.
// best for : Octopus skin, common octopus, giant Pacific octopus, blue-ringed
//            octopus, mimic octopus, deep-sea octopus, cephalopod rendering,
//            underwater creature scenes, anime creature close-ups, and any
//            octopus surface that needs real-time PBR + anime stylization.
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
// Octopus default presets — biologically grounded PBR parameter sets for
// common octopus skin types.
//
// Reference values (from cgaxis octopus-skin PBR packs, cephalopod biology
// literature, and CG wet-skin texture references):
//   - Octopus skin IOR:              ≈ 1.40 (wet mucous membrane)
//   - Octopus skin roughness:        0.28–0.40 (glossy when wet)
//   - Metalness:                     0.0 (dielectric)
//   - Clearcoat:                     0.20–0.35 (mucous layer sheen)
//   - Transmission:                  0.06–0.12 (translucent membrane edges)
//   - Sheen:                         0.15–0.30 (soft dermal glow)
//   - White/grey speckles:           scattered over the surface
//   - Papillae:                      small raised nodules (some species)
// ---------------------------------------------------------------------------

const OctopusDefaultPresets = {
    'common-octopus': {
        color: [0.62, 0.36, 0.30],
        roughness: 0.34,
        metalness: 0.0,
        clearcoat: 0.28,
        clearcoatRoughness: 0.25,
        transmission: 0.09,
        thickness: 0.010,
        attenuationDistance: 0.06,
        attenuationColor: [0.68, 0.42, 0.36],
        sheen: 0.22,
        sheenColor: [0.78, 0.52, 0.46],
        sheenRoughness: 0.45,
        specularIntensity: 0.55,
        specularColor: [0.90, 0.75, 0.70]
    },
    'giant-pacific-octopus': {
        color: [0.72, 0.28, 0.24],
        roughness: 0.30,
        metalness: 0.0,
        clearcoat: 0.30,
        clearcoatRoughness: 0.22,
        transmission: 0.10,
        thickness: 0.012,
        attenuationDistance: 0.07,
        attenuationColor: [0.78, 0.32, 0.26],
        sheen: 0.24,
        sheenColor: [0.85, 0.45, 0.40],
        sheenRoughness: 0.40,
        specularIntensity: 0.58,
        specularColor: [0.92, 0.70, 0.62]
    },
    'blue-ringed-octopus': {
        color: [0.82, 0.68, 0.28],
        roughness: 0.32,
        metalness: 0.0,
        clearcoat: 0.26,
        clearcoatRoughness: 0.24,
        transmission: 0.08,
        thickness: 0.010,
        attenuationDistance: 0.06,
        attenuationColor: [0.85, 0.72, 0.32],
        sheen: 0.20,
        sheenColor: [0.95, 0.85, 0.45],
        sheenRoughness: 0.45,
        specularIntensity: 0.52,
        specularColor: [0.95, 0.88, 0.65]
    },
    'mimic-octopus': {
        color: [0.52, 0.42, 0.32],
        roughness: 0.38,
        metalness: 0.0,
        clearcoat: 0.24,
        clearcoatRoughness: 0.28,
        transmission: 0.08,
        thickness: 0.010,
        attenuationDistance: 0.06,
        attenuationColor: [0.58, 0.48, 0.36],
        sheen: 0.20,
        sheenColor: [0.72, 0.62, 0.50],
        sheenRoughness: 0.50,
        specularIntensity: 0.50,
        specularColor: [0.85, 0.78, 0.68]
    },
    'deep-sea-octopus': {
        color: [0.38, 0.32, 0.42],
        roughness: 0.36,
        metalness: 0.0,
        clearcoat: 0.22,
        clearcoatRoughness: 0.30,
        transmission: 0.11,
        thickness: 0.010,
        attenuationDistance: 0.06,
        attenuationColor: [0.44, 0.38, 0.50],
        sheen: 0.18,
        sheenColor: [0.62, 0.58, 0.72],
        sheenRoughness: 0.50,
        specularIntensity: 0.48,
        specularColor: [0.78, 0.75, 0.88]
    },
    'anime-octopus': {
        color: [0.68, 0.32, 0.28],
        roughness: 0.28,
        metalness: 0.0,
        clearcoat: 0.32,
        clearcoatRoughness: 0.20,
        transmission: 0.10,
        thickness: 0.010,
        attenuationDistance: 0.07,
        attenuationColor: [0.78, 0.38, 0.32],
        sheen: 0.25,
        sheenColor: [0.92, 0.55, 0.50],
        sheenRoughness: 0.40,
        specularIntensity: 0.60,
        specularColor: [0.95, 0.78, 0.72]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable octopus scratch records
// ---------------------------------------------------------------------------

class OctopusDefaultScratchPool {
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

const _octopusDefaultScratchPool = new OctopusDefaultScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — octopus-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded octopus-skin highlights. Octopus skin has a wet, glossy
 * finish with soft low-frequency shading — quantizing the luminance into
 * discrete bands produces the crisp anime octopus edges seen in hand-drawn
 * underwater scenes.
 */
function applyOctopusDefaultCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.12) {
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
 * Apply mood-based tinting to octopus skin. Warm moods push skin toward warm
 * reddish-brown, cool moods toward cool violet-grey — matching the atmospheric
 * octopus tinting seen in stylized underwater scenes.
 */
function gradeOctopusDefaultColor(color, temperature, saturation, brightness, contrast) {
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

    // Octopus-specific temperature bias: warm shift pushes toward reddish-brown
    // (R up, G slightly up, B down); cool shift pushes toward violet-grey.
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
 * Generate a procedural octopus-skin texture. The algorithm:
 * 1. Multi-octave fBm for the low-frequency dermal base tone.
 * 2. Hashed speckle cells: per-cell presence, jittered centre, small radial
 *    falloff — producing the white/grey speckle pattern typical of octopus
 *    skin.
 * 3. Optional papillae bump: hashed cells with a raised radial dome for the
 *    muscular dermal protrusions.
 * 4. Fine micro-mottle for wet-skin surface variation.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateOctopusSkinTexture(width, height, scale = 0.03, octaves = 4, speckleDensity = 0.12, speckleSize = 0.35, papillaeStrength = 0.0, mottleStrength = 0.08) {
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

            // --- 2. Hashed speckle cells ---
            const cellX = Math.floor(x * 0.2);
            const cellY = Math.floor(y * 0.2);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const cellHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;

            let speckle = 0;
            if (cellHash > (1.0 - speckleDensity)) {
                const h2 = Math.abs(Math.sin(cellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                const h3 = Math.abs(Math.sin(cellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                const cx = (x * 0.2) - cellX - h2;
                const cy = (y * 0.2) - cellY - h3;
                const dist = Math.sqrt(cx * cx + cy * cy);
                speckle = Math.max(0, 1.0 - dist / speckleSize) * 0.35;
            }

            // --- 3. Papillae bump (optional) ---
            let papillae = 0;
            if (papillaeStrength > 0) {
                const pCellX = Math.floor(x * 0.15);
                const pCellY = Math.floor(y * 0.15);
                const pCellId = pCellX * 73856093 ^ pCellY * 19349663;
                const pHash = Math.abs(Math.sin(pCellId * 12.9898) * 43758.5453) % 1.0;
                if (pHash > 0.5) {
                    const ph2 = Math.abs(Math.sin(pCellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                    const ph3 = Math.abs(Math.sin(pCellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                    const pcx = (x * 0.15) - pCellX - ph2;
                    const pcy = (y * 0.15) - pCellY - ph3;
                    const pDist = Math.sqrt(pcx * pcx + pcy * pcy);
                    papillae = Math.max(0, 1.0 - pDist * 3.0) * papillaeStrength;
                }
            }

            // --- 4. Fine micro-mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.6, y * 0.6) * mottleStrength;

            // --- Combine ---
            let value = 0.55
                + (fbm - 0.5) * 0.15
                + speckle * 0.25
                + papillae * 0.40
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

const _octopusDefaultWorld = BitECS.createWorld();
const OctopusDefaultMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    octopusBands: 'ui8',
    octopusQuantize: 'f64',
    octopusSoftness: 'f64',
    speckleDensity: 'f64',
    speckleSize: 'f64',
    papillaeStrength: 'f64',
    mottleStrength: 'f64',
    wetGleamIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OctopusDefaultMaterialBatch {
    constructor() {
        this.world = _octopusDefaultWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OctopusDefaultMaterialComponent, eid);
        OctopusDefaultMaterialComponent.materialPtr[eid] = this.materials.length;
        OctopusDefaultMaterialComponent.octopusBands[eid] = material.octopusBands;
        OctopusDefaultMaterialComponent.octopusQuantize[eid] = material.octopusQuantize;
        OctopusDefaultMaterialComponent.octopusSoftness[eid] = material.octopusSoftness;
        OctopusDefaultMaterialComponent.speckleDensity[eid] = material.speckleDensity;
        OctopusDefaultMaterialComponent.speckleSize[eid] = material.speckleSize;
        OctopusDefaultMaterialComponent.papillaeStrength[eid] = material.papillaeStrength;
        OctopusDefaultMaterialComponent.mottleStrength[eid] = material.mottleStrength;
        OctopusDefaultMaterialComponent.wetGleamIntensity[eid] = material.wetGleamIntensity;
        OctopusDefaultMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OctopusDefaultMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OctopusDefaultMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OctopusDefaultMaterialComponent.moodContrast[eid] = material.moodContrast;
        OctopusDefaultMaterialComponent.rimGlow[eid] = material.rimGlow;
        OctopusDefaultMaterialComponent.variationSeed[eid] = material.variationSeed;
        OctopusDefaultMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OctopusDefaultMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.octopusBands = OctopusDefaultMaterialComponent.octopusBands[eid];
            material.octopusQuantize = OctopusDefaultMaterialComponent.octopusQuantize[eid];
            material.octopusSoftness = OctopusDefaultMaterialComponent.octopusSoftness[eid];
            material.speckleDensity = OctopusDefaultMaterialComponent.speckleDensity[eid];
            material.speckleSize = OctopusDefaultMaterialComponent.speckleSize[eid];
            material.papillaeStrength = OctopusDefaultMaterialComponent.papillaeStrength[eid];
            material.mottleStrength = OctopusDefaultMaterialComponent.mottleStrength[eid];
            material.wetGleamIntensity = OctopusDefaultMaterialComponent.wetGleamIntensity[eid];
            material.moodTemperature = OctopusDefaultMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OctopusDefaultMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OctopusDefaultMaterialComponent.moodBrightness[eid];
            material.moodContrast = OctopusDefaultMaterialComponent.moodContrast[eid];
            material.rimGlow = OctopusDefaultMaterialComponent.rimGlow[eid];
            material.variationSeed = OctopusDefaultMaterialComponent.variationSeed[eid];

            OctopusDefaultMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OctopusDefaultMaterial class
// ---------------------------------------------------------------------------

class OctopusDefaultMaterial extends MeshPhysicalMaterial {
    static {
        _octopusDefaultScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOctopusDefaultMaterial = true;
        this.type = 'OctopusDefaultMaterial';

        // -------------------------------------------------------------------
        // Octopus-default-specific PBR defaults (common-octopus baseline)
        // -------------------------------------------------------------------
        this.ior = 1.40;
        this.specularIntensity = 0.55;
        this.roughness = 0.34;
        this.metalness = 0.0;
        this.specularColor = new Color(0.90, 0.75, 0.70);
        this.color = new Color(0.62, 0.36, 0.30);

        // Clearcoat for the mucous-layer sheen
        this.clearcoat = 0.28;
        this.clearcoatRoughness = 0.25;

        // Thin-walled transmission for translucent membrane edges
        this.transmission = 0.09;
        this.thickness = 0.010;
        this.attenuationDistance = 0.06;
        this.attenuationColor = new Color(0.68, 0.42, 0.36);

        // Sheen for the soft dermal glow
        this.sheen = 0.22;
        this.sheenColor = new Color(0.78, 0.52, 0.46);
        this.sheenRoughness = 0.45;

        // -------------------------------------------------------------------
        // Anime rendering extensions — octopus-specific
        // -------------------------------------------------------------------
        this.octopusBands = 3;
        this.octopusQuantize = 0.4;
        this.octopusSoftness = 0.12;

        // Speckle / papillae / mottle / wet-gleam controls
        this.speckleDensity = 0.12;
        this.speckleSize = 0.35;
        this.papillaeStrength = 0.0;
        this.mottleStrength = 0.08;
        this.wetGleamIntensity = 0.35;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.78, 0.52, 0.46);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (octopus leans semi-realistic)
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

    applyOctopusBanding(baseColor, output) {
        return applyOctopusDefaultCelBanding(
            baseColor,
            output,
            this.octopusBands,
            this.octopusQuantize,
            this.octopusSoftness
        );
    }

    updateMoodColor() {
        gradeOctopusDefaultColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named octopus preset to this material.
     * @param {string} presetName - One of the keys of `OctopusDefaultPresets`.
     * @returns {OctopusDefaultMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OctopusDefaultPresets[presetName];
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
        if (presetName === 'giant-pacific-octopus') {
            this.octopusSoftness = 0.08;
            this.octopusBands = 4;
            this.speckleDensity = 0.15;
            this.wetGleamIntensity = 0.45;
        } else if (presetName === 'blue-ringed-octopus') {
            this.octopusSoftness = 0.10;
            this.octopusBands = 3;
            this.speckleDensity = 0.20;
            this.wetGleamIntensity = 0.35;
        } else if (presetName === 'mimic-octopus') {
            this.octopusSoftness = 0.18;
            this.octopusBands = 2;
            this.speckleDensity = 0.10;
            this.wetGleamIntensity = 0.30;
        } else if (presetName === 'anime-octopus') {
            this.octopusSoftness = 0.06;
            this.octopusBands = 4;
            this.speckleDensity = 0.12;
            this.wetGleamIntensity = 0.50;
        } else {
            this.octopusSoftness = 0.12;
            this.octopusBands = 3;
            this.speckleDensity = 0.12;
            this.wetGleamIntensity = 0.35;
        }

        this.updateMoodColor();
        return this;
    }

    generateOctopusSkinTexture(width, height, scale = 0.03, octaves = 4, speckleDensity = 0.12, speckleSize = 0.35, papillaeStrength = 0.0) {
        return generateOctopusSkinTexture(width, height, scale, octaves, speckleDensity, speckleSize, papillaeStrength, this.mottleStrength);
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

        shader.uniforms.octopusBands = { value: this.octopusBands };
        shader.uniforms.octopusQuantize = { value: this.octopusQuantize };
        shader.uniforms.octopusSoftness = { value: this.octopusSoftness };
        shader.uniforms.speckleDensity = { value: this.speckleDensity };
        shader.uniforms.speckleSize = { value: this.speckleSize };
        shader.uniforms.papillaeStrength = { value: this.papillaeStrength };
        shader.uniforms.mottleStrength = { value: this.mottleStrength };
        shader.uniforms.wetGleamIntensity = { value: this.wetGleamIntensity };
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
                uniform int octopusBands;
                uniform float octopusQuantize;
                uniform float octopusSoftness;
                uniform float speckleDensity;
                uniform float speckleSize;
                uniform float papillaeStrength;
                uniform float mottleStrength;
                uniform float wetGleamIntensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyOctopusBands(vec3 baseColor) {
                    if (octopusBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(octopusBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * octopusSoftness;
                    float finalLum = mix(lum, softQuantized, octopusQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply octopus cel banding
                gl_FragColor.rgb = applyOctopusBands(gl_FragColor.rgb);

                // Speckle approximation: hashed cell brightening
                if (speckleDensity > 0.0) {
                    vec2 speckleUV = vUv * 60.0;
                    vec2 speckleCell = floor(speckleUV);
                    vec2 speckleFrac = fract(speckleUV);
                    float speckleHash = fract(sin(dot(speckleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (speckleHash > (1.0 - speckleDensity)) {
                        vec2 speckleCentre = vec2(fract(speckleHash * 7.31), fract(speckleHash * 13.7));
                        float speckleDist = length(speckleFrac - speckleCentre);
                        float speckleMask = max(0.0, 1.0 - speckleDist / speckleSize);
                        gl_FragColor.rgb += vec3(speckleMask * 0.20);
                    }
                }

                // Papillae bump approximation (subtle cell brightening)
                if (papillaeStrength > 0.0) {
                    vec2 papUV = vUv * 40.0;
                    vec2 papCell = floor(papUV);
                    float papHash = fract(sin(dot(papCell, vec2(39.425, 1.57))) * 43758.5453);
                    if (papHash > 0.5) {
                        vec2 papFrac = fract(papUV);
                        vec2 papCentre = vec2(0.5, 0.5);
                        float papDist = length(papFrac - papCentre);
                        float papMask = max(0.0, 1.0 - papDist * 3.0);
                        gl_FragColor.rgb += vec3(papMask * papillaeStrength * 0.25);
                    }
                }

                // Wet gleam: bright grazing-angle specular streaks
                if (wetGleamIntensity > 0.0) {
                    float ndotvOct = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float wetGleam = pow(1.0 - ndotvOct, 3.0) * wetGleamIntensity;
                    gl_FragColor.rgb += sheenColor * wetGleam * 0.5;
                }

                // Warm rim glow on octopus edges
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
            this.octopusBands, this.octopusQuantize, this.octopusSoftness,
            this.speckleDensity, this.speckleSize, this.papillaeStrength,
            this.mottleStrength, this.wetGleamIntensity,
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
        this.octopusBands = source.octopusBands;
        this.octopusQuantize = source.octopusQuantize;
        this.octopusSoftness = source.octopusSoftness;
        this.speckleDensity = source.speckleDensity;
        this.speckleSize = source.speckleSize;
        this.papillaeStrength = source.papillaeStrength;
        this.mottleStrength = source.mottleStrength;
        this.wetGleamIntensity = source.wetGleamIntensity;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OctopusDefaultMaterial';
        if (this.ior !== 1.40) data.ior = this.ior;
        if (this.specularIntensity !== 0.55) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.34) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.28) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.25) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.09) data.transmission = this.transmission;
        if (this.thickness !== 0.010) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.06) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.68, 0.42, 0.36).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.22) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.78, 0.52, 0.46).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.45) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.90, 0.75, 0.70).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.octopusBands !== 3) data.octopusBands = this.octopusBands;
        if (this.octopusQuantize !== 0.4) data.octopusQuantize = this.octopusQuantize;
        if (this.octopusSoftness !== 0.12) data.octopusSoftness = this.octopusSoftness;
        if (this.speckleDensity !== 0.12) data.speckleDensity = this.speckleDensity;
        if (this.speckleSize !== 0.35) data.speckleSize = this.speckleSize;
        if (this.papillaeStrength !== 0.0) data.papillaeStrength = this.papillaeStrength;
        if (this.mottleStrength !== 0.08) data.mottleStrength = this.mottleStrength;
        if (this.wetGleamIntensity !== 0.35) data.wetGleamIntensity = this.wetGleamIntensity;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.78, 0.52, 0.46).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.octopusBands = json.octopusBands ?? this.octopusBands;
        this.octopusQuantize = json.octopusQuantize ?? this.octopusQuantize;
        this.octopusSoftness = json.octopusSoftness ?? this.octopusSoftness;
        this.speckleDensity = json.speckleDensity ?? this.speckleDensity;
        this.speckleSize = json.speckleSize ?? this.speckleSize;
        this.papillaeStrength = json.papillaeStrength ?? this.papillaeStrength;
        this.mottleStrength = json.mottleStrength ?? this.mottleStrength;
        this.wetGleamIntensity = json.wetGleamIntensity ?? this.wetGleamIntensity;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OctopusDefaultMaterialBatchComponent = {
    materialPtr: 'ui32',
    octopusBands: 'ui8',
    octopusQuantize: 'f64',
    octopusSoftness: 'f64',
    speckleDensity: 'f64',
    speckleSize: 'f64',
    papillaeStrength: 'f64',
    mottleStrength: 'f64',
    wetGleamIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OctopusDefaultMaterial,
    OctopusDefaultMaterialBatch,
    OctopusDefaultScratchPool,
    OctopusDefaultMaterialBatchComponent,
    OctopusDefaultPresets,
    applyOctopusDefaultCelBanding,
    gradeOctopusDefaultColor,
    generateOctopusSkinTexture
};

export default OctopusDefaultMaterial;