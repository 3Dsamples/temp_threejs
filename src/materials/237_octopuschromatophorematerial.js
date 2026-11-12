// file number : 237
// full path name : src/materials/237_octopuschromatophorematerial.js
// description : OctopusChromatophoreMaterial — a ready-to-use octopus-skin
//               material focused on the chromatophore pigment-sac layer of
//               cephalopod skin. Extends MeshPhysicalMaterial with presets
//               covering the major chromatophore states (expanded camouflage,
//               contracted resting, signalling flash, and deep-water red
//               shift). Includes biologically grounded defaults for the
//               chromatophore layer (wet membrane IOR ≈ 1.40, roughness
//               0.28–0.40 for the glossy mucous layer, clearcoat 0.25–0.35
//               for the wet sheen, slight transmission for translucent
//               sacs, and strong sheen for the dermal glow) plus real-time
//               anime stylization: cel-banded chromatophore highlights,
//               hashed pigment-sac expansion approximation, mood tinting,
//               rim glow, and per-instance variation. Includes a procedural
//               chromatophore expansion texture generator using hashed
//               radial sacs with per-sac expanded-radius control, membrane
//               mottle, and optional iridophore sparkle.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Octopus chromatophores, cephalopod camouflage skin, signalling
//            colour flashes, ink-sac regions, mimic octopus displays, cuttlefish
//            and squid chromatophore layers, deep-sea cephalopod skin, and any
//            colour-change organic surface that needs real-time PBR + anime
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
// Chromatophore presets — biologically grounded PBR parameter sets for
// octopus chromatophore pigment-sac states.
//
// Reference values (from cephalopod chromatophore literature, cgaxis octopus
// PBR packs, and CG wet-skin texture references):
//   - Chromatophore membrane IOR:    ≈ 1.40
//   - Chromatophore roughness:       0.28–0.40
//   - Metalness:                     0.0 (dielectric)
//   - Clearcoat:                     0.25–0.35 (mucous membrane)
//   - Transmission:                  0.08–0.14 (translucent sacs)
//   - Sheen:                         0.20–0.35 (dermal glow)
//   - Expanded chromatophores:       strong pigment colour, flat shading
//   - Contracted chromatophores:     more base-skin visible, tighter sheen
//   - Signalling flash:              high-contrast, mid-expansion
//   - Deep-sea red shift:            darker, less blue (absorption effect)
// ---------------------------------------------------------------------------

const OctopusChromatophorePresets = {
    'expanded-camouflage': {
        color: [0.42, 0.28, 0.22],
        roughness: 0.34,
        metalness: 0.0,
        clearcoat: 0.28,
        clearcoatRoughness: 0.25,
        transmission: 0.10,
        thickness: 0.010,
        attenuationDistance: 0.06,
        attenuationColor: [0.52, 0.34, 0.28],
        sheen: 0.28,
        sheenColor: [0.68, 0.48, 0.38],
        sheenRoughness: 0.45,
        specularIntensity: 0.52,
        specularColor: [0.85, 0.72, 0.62],
        expansionRatio: 0.85,
        pigmentSaturation: 1.10
    },
    'contracted-resting': {
        color: [0.62, 0.48, 0.36],
        roughness: 0.36,
        metalness: 0.0,
        clearcoat: 0.26,
        clearcoatRoughness: 0.26,
        transmission: 0.10,
        thickness: 0.010,
        attenuationDistance: 0.06,
        attenuationColor: [0.68, 0.52, 0.42],
        sheen: 0.22,
        sheenColor: [0.82, 0.66, 0.52],
        sheenRoughness: 0.45,
        specularIntensity: 0.55,
        specularColor: [0.88, 0.78, 0.68],
        expansionRatio: 0.25,
        pigmentSaturation: 0.60
    },
    'signalling-flash': {
        color: [0.82, 0.32, 0.18],
        roughness: 0.30,
        metalness: 0.0,
        clearcoat: 0.32,
        clearcoatRoughness: 0.20,
        transmission: 0.12,
        thickness: 0.010,
        attenuationDistance: 0.07,
        attenuationColor: [0.90, 0.38, 0.22],
        sheen: 0.32,
        sheenColor: [1.0, 0.55, 0.42],
        sheenRoughness: 0.40,
        specularIntensity: 0.60,
        specularColor: [1.0, 0.78, 0.68],
        expansionRatio: 0.65,
        pigmentSaturation: 1.35
    },
    'deep-water-red-shift': {
        color: [0.52, 0.18, 0.14],
        roughness: 0.34,
        metalness: 0.0,
        clearcoat: 0.28,
        clearcoatRoughness: 0.25,
        transmission: 0.09,
        thickness: 0.010,
        attenuationDistance: 0.06,
        attenuationColor: [0.62, 0.22, 0.18],
        sheen: 0.26,
        sheenColor: [0.78, 0.34, 0.28],
        sheenRoughness: 0.45,
        specularIntensity: 0.50,
        specularColor: [0.82, 0.60, 0.55],
        expansionRatio: 0.75,
        pigmentSaturation: 1.20
    },
    'mimic-blue-rings': {
        color: [0.72, 0.62, 0.24],
        roughness: 0.30,
        metalness: 0.0,
        clearcoat: 0.32,
        clearcoatRoughness: 0.20,
        transmission: 0.11,
        thickness: 0.010,
        attenuationDistance: 0.07,
        attenuationColor: [0.80, 0.68, 0.30],
        sheen: 0.30,
        sheenColor: [0.95, 0.82, 0.48],
        sheenRoughness: 0.42,
        specularIntensity: 0.58,
        specularColor: [0.96, 0.88, 0.70],
        expansionRatio: 0.55,
        pigmentSaturation: 1.25
    },
    'anime-chromatophore': {
        color: [0.68, 0.30, 0.24],
        roughness: 0.28,
        metalness: 0.0,
        clearcoat: 0.34,
        clearcoatRoughness: 0.18,
        transmission: 0.12,
        thickness: 0.010,
        attenuationDistance: 0.07,
        attenuationColor: [0.78, 0.38, 0.30],
        sheen: 0.30,
        sheenColor: [0.94, 0.55, 0.48],
        sheenRoughness: 0.40,
        specularIntensity: 0.62,
        specularColor: [0.98, 0.82, 0.74],
        expansionRatio: 0.72,
        pigmentSaturation: 1.30
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable chromatophore scratch records
// ---------------------------------------------------------------------------

class OctopusChromatophoreScratchPool {
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

const _octopusChromatophoreScratchPool = new OctopusChromatophoreScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — chromatophore-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded chromatophore highlights. Chromatophore sacs have soft,
 * glossy shading with strong saturated pigment colour — quantizing the
 * luminance into discrete bands produces the crisp anime chromatophore
 * edges seen in hand-drawn cephalopod close-ups.
 */
function applyChromatophoreCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.10) {
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
 * Apply mood-based tinting to chromatophore skin. Warm moods push pigments
 * toward warm reddish-brown, cool moods toward cool violet-grey — matching
 * the atmospheric chromatophore tinting seen in stylized underwater scenes.
 */
function gradeChromatophoreColor(color, temperature, saturation, brightness, contrast) {
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

    // Chromatophore-specific temperature bias: warm shift pushes toward
    // reddish-brown pigment, cool shift pushes toward violet-grey.
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
 * Generate a procedural chromatophore expansion texture. The algorithm:
 * 1. Hashed chromatophore sac cells: per-cell presence, jittered centre, and
 *    per-sac expanded radius (controlled by the global expansionRatio).
 * 2. Radial falloff around each sac centre produces the pigment-sac dome.
 * 3. Per-sac colour variance from a second hash for organic patterning.
 * 4. Membrane mottle: low-frequency fBm for the dermal base between sacs.
 * 5. Optional iridophore sparkle: small hashed bright cells for the
 *    structural-colour iridophores beneath the chromatophores.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateChromatophoreExpansionTexture(width, height, sacDensity = 0.35, sacRadius = 0.35, expansionRatio = 0.75, membraneMottle = 0.10, iridophoreDensity = 0.0) {
    const out = new Uint8Array(width * height * 4);

    // Effective sac radius scales with expansionRatio (0 = fully contracted,
    // 1 = fully expanded)
    const effectiveRadius = sacRadius * (0.35 + expansionRatio * 0.65);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Hashed chromatophore sac cells ---
            const cellX = Math.floor(x * 0.15);
            const cellY = Math.floor(y * 0.15);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const cellHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;

            let sac = 0;
            let sacTint = 0;
            if (cellHash > (1.0 - sacDensity)) {
                const h2 = Math.abs(Math.sin(cellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                const h3 = Math.abs(Math.sin(cellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                const cx = (x * 0.15) - cellX - h2;
                const cy = (y * 0.15) - cellY - h3;
                const dist = Math.sqrt(cx * cx + cy * cy);

                // Radial dome for the pigment sac
                sac = Math.max(0, 1.0 - dist / effectiveRadius);

                // --- 3. Per-sac colour variance ---
                const h4 = Math.abs(Math.sin(cellId * 269.5 + 1.0) * 43758.5453) % 1.0;
                sacTint = 0.85 + h4 * 0.15;
            }

            // --- 4. Membrane mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.03, y * 0.03) * 0.5 + 0.5;
            const mottleValue = (mottle - 0.5) * membraneMottle;

            // --- 5. Iridophore sparkle ---
            let iridophore = 0;
            if (iridophoreDensity > 0) {
                const iCellX = Math.floor(x * 0.5);
                const iCellY = Math.floor(y * 0.5);
                const iCellId = iCellX * 73856093 ^ iCellY * 19349663;
                const iHash = Math.abs(Math.sin(iCellId * 12.9898) * 43758.5453) % 1.0;
                if (iHash > (1.0 - iridophoreDensity)) {
                    iridophore = 0.15 * iHash;
                }
            }

            // --- Combine ---
            let value = 0.55
                + sac * 0.30 * sacTint
                + mottleValue
                + iridophore;

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

const _octopusChromatophoreWorld = BitECS.createWorld();
const OctopusChromatophoreMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    chromatophoreBands: 'ui8',
    chromatophoreQuantize: 'f64',
    chromatophoreSoftness: 'f64',
    sacDensity: 'f64',
    sacRadius: 'f64',
    expansionRatio: 'f64',
    pigmentSaturation: 'f64',
    membraneMottle: 'f64',
    iridophoreDensity: 'f64',
    wetGleamIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OctopusChromatophoreMaterialBatch {
    constructor() {
        this.world = _octopusChromatophoreWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OctopusChromatophoreMaterialComponent, eid);
        OctopusChromatophoreMaterialComponent.materialPtr[eid] = this.materials.length;
        OctopusChromatophoreMaterialComponent.chromatophoreBands[eid] = material.chromatophoreBands;
        OctopusChromatophoreMaterialComponent.chromatophoreQuantize[eid] = material.chromatophoreQuantize;
        OctopusChromatophoreMaterialComponent.chromatophoreSoftness[eid] = material.chromatophoreSoftness;
        OctopusChromatophoreMaterialComponent.sacDensity[eid] = material.sacDensity;
        OctopusChromatophoreMaterialComponent.sacRadius[eid] = material.sacRadius;
        OctopusChromatophoreMaterialComponent.expansionRatio[eid] = material.expansionRatio;
        OctopusChromatophoreMaterialComponent.pigmentSaturation[eid] = material.pigmentSaturation;
        OctopusChromatophoreMaterialComponent.membraneMottle[eid] = material.membraneMottle;
        OctopusChromatophoreMaterialComponent.iridophoreDensity[eid] = material.iridophoreDensity;
        OctopusChromatophoreMaterialComponent.wetGleamIntensity[eid] = material.wetGleamIntensity;
        OctopusChromatophoreMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OctopusChromatophoreMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OctopusChromatophoreMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OctopusChromatophoreMaterialComponent.moodContrast[eid] = material.moodContrast;
        OctopusChromatophoreMaterialComponent.rimGlow[eid] = material.rimGlow;
        OctopusChromatophoreMaterialComponent.variationSeed[eid] = material.variationSeed;
        OctopusChromatophoreMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OctopusChromatophoreMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.chromatophoreBands = OctopusChromatophoreMaterialComponent.chromatophoreBands[eid];
            material.chromatophoreQuantize = OctopusChromatophoreMaterialComponent.chromatophoreQuantize[eid];
            material.chromatophoreSoftness = OctopusChromatophoreMaterialComponent.chromatophoreSoftness[eid];
            material.sacDensity = OctopusChromatophoreMaterialComponent.sacDensity[eid];
            material.sacRadius = OctopusChromatophoreMaterialComponent.sacRadius[eid];
            material.expansionRatio = OctopusChromatophoreMaterialComponent.expansionRatio[eid];
            material.pigmentSaturation = OctopusChromatophoreMaterialComponent.pigmentSaturation[eid];
            material.membraneMottle = OctopusChromatophoreMaterialComponent.membraneMottle[eid];
            material.iridophoreDensity = OctopusChromatophoreMaterialComponent.iridophoreDensity[eid];
            material.wetGleamIntensity = OctopusChromatophoreMaterialComponent.wetGleamIntensity[eid];
            material.moodTemperature = OctopusChromatophoreMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OctopusChromatophoreMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OctopusChromatophoreMaterialComponent.moodBrightness[eid];
            material.moodContrast = OctopusChromatophoreMaterialComponent.moodContrast[eid];
            material.rimGlow = OctopusChromatophoreMaterialComponent.rimGlow[eid];
            material.variationSeed = OctopusChromatophoreMaterialComponent.variationSeed[eid];

            OctopusChromatophoreMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OctopusChromatophoreMaterial class
// ---------------------------------------------------------------------------

class OctopusChromatophoreMaterial extends MeshPhysicalMaterial {
    static {
        _octopusChromatophoreScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOctopusChromatophoreMaterial = true;
        this.type = 'OctopusChromatophoreMaterial';

        // -------------------------------------------------------------------
        // Chromatophore-specific PBR defaults (expanded-camouflage baseline)
        // -------------------------------------------------------------------
        this.ior = 1.40;
        this.specularIntensity = 0.52;
        this.roughness = 0.34;
        this.metalness = 0.0;
        this.specularColor = new Color(0.85, 0.72, 0.62);
        this.color = new Color(0.42, 0.28, 0.22);

        // Clearcoat for the mucous-layer sheen
        this.clearcoat = 0.28;
        this.clearcoatRoughness = 0.25;

        // Thin-walled transmission for translucent sac membranes
        this.transmission = 0.10;
        this.thickness = 0.010;
        this.attenuationDistance = 0.06;
        this.attenuationColor = new Color(0.52, 0.34, 0.28);

        // Sheen for the dermal glow between sacs
        this.sheen = 0.28;
        this.sheenColor = new Color(0.68, 0.48, 0.38);
        this.sheenRoughness = 0.45;

        // -------------------------------------------------------------------
        // Anime rendering extensions — chromatophore-specific
        // -------------------------------------------------------------------
        this.chromatophoreBands = 3;
        this.chromatophoreQuantize = 0.4;
        this.chromatophoreSoftness = 0.10;

        // Chromatophore-specific controls
        this.sacDensity = 0.35;
        this.sacRadius = 0.35;
        this.expansionRatio = 0.75;
        this.pigmentSaturation = 1.10;
        this.membraneMottle = 0.10;
        this.iridophoreDensity = 0.0;
        this.wetGleamIntensity = 0.40;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.85, 0.55, 0.48);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (chromatophore leans semi-realistic)
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

    applyChromatophoreBanding(baseColor, output) {
        return applyChromatophoreCelBanding(
            baseColor,
            output,
            this.chromatophoreBands,
            this.chromatophoreQuantize,
            this.chromatophoreSoftness
        );
    }

    updateMoodColor() {
        gradeChromatophoreColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named chromatophore preset to this material.
     * @param {string} presetName - One of the keys of `OctopusChromatophorePresets`.
     * @returns {OctopusChromatophoreMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OctopusChromatophorePresets[presetName];
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
        this.expansionRatio = preset.expansionRatio;
        this.pigmentSaturation = preset.pigmentSaturation;

        // Per-preset anime tuning
        if (presetName === 'expanded-camouflage') {
            this.chromatophoreSoftness = 0.10;
            this.chromatophoreBands = 3;
            this.sacDensity = 0.40;
            this.wetGleamIntensity = 0.35;
        } else if (presetName === 'contracted-resting') {
            this.chromatophoreSoftness = 0.18;
            this.chromatophoreBands = 2;
            this.sacDensity = 0.20;
            this.wetGleamIntensity = 0.45;
        } else if (presetName === 'signalling-flash') {
            this.chromatophoreSoftness = 0.06;
            this.chromatophoreBands = 4;
            this.sacDensity = 0.45;
            this.wetGleamIntensity = 0.55;
        } else if (presetName === 'anime-chromatophore') {
            this.chromatophoreSoftness = 0.05;
            this.chromatophoreBands = 4;
            this.sacDensity = 0.38;
            this.wetGleamIntensity = 0.60;
        } else {
            this.chromatophoreSoftness = 0.10;
            this.chromatophoreBands = 3;
            this.sacDensity = 0.35;
            this.wetGleamIntensity = 0.40;
        }

        this.updateMoodColor();
        return this;
    }

    generateChromatophoreExpansionTexture(width, height, sacDensity = 0.35, sacRadius = 0.35, expansionRatio = 0.75) {
        return generateChromatophoreExpansionTexture(width, height, sacDensity, sacRadius, expansionRatio, this.membraneMottle, this.iridophoreDensity);
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

        shader.uniforms.chromatophoreBands = { value: this.chromatophoreBands };
        shader.uniforms.chromatophoreQuantize = { value: this.chromatophoreQuantize };
        shader.uniforms.chromatophoreSoftness = { value: this.chromatophoreSoftness };
        shader.uniforms.sacDensity = { value: this.sacDensity };
        shader.uniforms.sacRadius = { value: this.sacRadius };
        shader.uniforms.expansionRatio = { value: this.expansionRatio };
        shader.uniforms.pigmentSaturation = { value: this.pigmentSaturation };
        shader.uniforms.membraneMottle = { value: this.membraneMottle };
        shader.uniforms.iridophoreDensity = { value: this.iridophoreDensity };
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
                uniform int chromatophoreBands;
                uniform float chromatophoreQuantize;
                uniform float chromatophoreSoftness;
                uniform float sacDensity;
                uniform float sacRadius;
                uniform float expansionRatio;
                uniform float pigmentSaturation;
                uniform float membraneMottle;
                uniform float iridophoreDensity;
                uniform float wetGleamIntensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyChromatophoreBands(vec3 baseColor) {
                    if (chromatophoreBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(chromatophoreBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * chromatophoreSoftness;
                    float finalLum = mix(lum, softQuantized, chromatophoreQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply chromatophore cel banding
                gl_FragColor.rgb = applyChromatophoreBands(gl_FragColor.rgb);

                // Chromatophore expansion approximation:
                // hashed sac cells with radius scaled by expansionRatio
                {
                    float effectiveRadius = sacRadius * (0.35 + expansionRatio * 0.65);
                    vec2 sacUV = vUv * 50.0;
                    vec2 sacCell = floor(sacUV);
                    vec2 sacFrac = fract(sacUV);
                    float sacHash = fract(sin(dot(sacCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (sacHash > (1.0 - sacDensity)) {
                        vec2 sacCentre = vec2(fract(sacHash * 7.31), fract(sacHash * 13.7));
                        float sacDist = length(sacFrac - sacCentre);
                        float sacMask = max(0.0, 1.0 - sacDist / effectiveRadius);
                        // Deepen pigment in the sac (hue-preserved darkening)
                        gl_FragColor.rgb *= (1.0 - sacMask * 0.20 * pigmentSaturation);
                    }
                }

                // Membrane mottle between sacs
                if (membraneMottle > 0.0) {
                    float mottle = sin(vUv.x * 25.0 + variationOffset) * cos(vUv.y * 25.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + mottle * membraneMottle * 0.10);
                }

                // Iridophore sparkle: small hashed bright cells
                if (iridophoreDensity > 0.0) {
                    vec2 iUV = vUv * 180.0;
                    vec2 iCell = floor(iUV);
                    float iHash = fract(sin(dot(iCell, vec2(39.425, 1.57))) * 43758.5453);
                    float sparkle = iHash > (1.0 - iridophoreDensity) ? (iHash * 0.15) : 0.0;
                    gl_FragColor.rgb += vec3(sparkle);
                }

                // Wet gleam: bright grazing-angle specular streaks
                if (wetGleamIntensity > 0.0) {
                    float ndotvChrom = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float wetGleam = pow(1.0 - ndotvChrom, 3.0) * wetGleamIntensity;
                    gl_FragColor.rgb += sheenColor * wetGleam * 0.5;
                }

                // Warm rim glow on chromatophore edges
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
            this.chromatophoreBands, this.chromatophoreQuantize, this.chromatophoreSoftness,
            this.sacDensity, this.sacRadius, this.expansionRatio,
            this.pigmentSaturation, this.membraneMottle, this.iridophoreDensity,
            this.wetGleamIntensity,
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
        this.chromatophoreBands = source.chromatophoreBands;
        this.chromatophoreQuantize = source.chromatophoreQuantize;
        this.chromatophoreSoftness = source.chromatophoreSoftness;
        this.sacDensity = source.sacDensity;
        this.sacRadius = source.sacRadius;
        this.expansionRatio = source.expansionRatio;
        this.pigmentSaturation = source.pigmentSaturation;
        this.membraneMottle = source.membraneMottle;
        this.iridophoreDensity = source.iridophoreDensity;
        this.wetGleamIntensity = source.wetGleamIntensity;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OctopusChromatophoreMaterial';
        if (this.ior !== 1.40) data.ior = this.ior;
        if (this.specularIntensity !== 0.52) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.34) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.28) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.25) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.10) data.transmission = this.transmission;
        if (this.thickness !== 0.010) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.06) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.52, 0.34, 0.28).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.28) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.68, 0.48, 0.38).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.45) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.85, 0.72, 0.62).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.chromatophoreBands !== 3) data.chromatophoreBands = this.chromatophoreBands;
        if (this.chromatophoreQuantize !== 0.4) data.chromatophoreQuantize = this.chromatophoreQuantize;
        if (this.chromatophoreSoftness !== 0.10) data.chromatophoreSoftness = this.chromatophoreSoftness;
        if (this.sacDensity !== 0.35) data.sacDensity = this.sacDensity;
        if (this.sacRadius !== 0.35) data.sacRadius = this.sacRadius;
        if (this.expansionRatio !== 0.75) data.expansionRatio = this.expansionRatio;
        if (this.pigmentSaturation !== 1.10) data.pigmentSaturation = this.pigmentSaturation;
        if (this.membraneMottle !== 0.10) data.membraneMottle = this.membraneMottle;
        if (this.iridophoreDensity !== 0.0) data.iridophoreDensity = this.iridophoreDensity;
        if (this.wetGleamIntensity !== 0.40) data.wetGleamIntensity = this.wetGleamIntensity;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.55, 0.48).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.chromatophoreBands = json.chromatophoreBands ?? this.chromatophoreBands;
        this.chromatophoreQuantize = json.chromatophoreQuantize ?? this.chromatophoreQuantize;
        this.chromatophoreSoftness = json.chromatophoreSoftness ?? this.chromatophoreSoftness;
        this.sacDensity = json.sacDensity ?? this.sacDensity;
        this.sacRadius = json.sacRadius ?? this.sacRadius;
        this.expansionRatio = json.expansionRatio ?? this.expansionRatio;
        this.pigmentSaturation = json.pigmentSaturation ?? this.pigmentSaturation;
        this.membraneMottle = json.membraneMottle ?? this.membraneMottle;
        this.iridophoreDensity = json.iridophoreDensity ?? this.iridophoreDensity;
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

const OctopusChromatophoreMaterialBatchComponent = {
    materialPtr: 'ui32',
    chromatophoreBands: 'ui8',
    chromatophoreQuantize: 'f64',
    chromatophoreSoftness: 'f64',
    sacDensity: 'f64',
    sacRadius: 'f64',
    expansionRatio: 'f64',
    pigmentSaturation: 'f64',
    membraneMottle: 'f64',
    iridophoreDensity: 'f64',
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
    OctopusChromatophoreMaterial,
    OctopusChromatophoreMaterialBatch,
    OctopusChromatophoreScratchPool,
    OctopusChromatophoreMaterialBatchComponent,
    OctopusChromatophorePresets,
    applyChromatophoreCelBanding,
    gradeChromatophoreColor,
    generateChromatophoreExpansionTexture
};

export default OctopusChromatophoreMaterial;