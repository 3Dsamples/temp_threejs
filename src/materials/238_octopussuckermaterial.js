// file number : 238
// full path name : src/materials/238_octopussuckermaterial.js
// description : OctopusSuckerMaterial — a ready-to-use material for the suction
//               cups on octopus arms. Covers the sucker disc, the ring, and the
//               central lumen. Extends MeshPhysicalMaterial with presets for
//               common octopus suckers, giant Pacific octopus suckers,
//               blue-ringed octopus suckers, aged suckers, and anime suckers.
//               Includes sucker-appropriate PBR defaults grounded in cephalopod
//               biology (wet mucosal IOR ≈ 1.38, roughness 0.22–0.38 for the
//               glossy wet mucosal disc, clearcoat 0.35–0.55 for the mucus
//               film, higher transmission 0.15–0.28 for the translucent lumen,
//               sheen 0.25–0.40 for the soft mucosal rim) plus real-time anime
//               stylization: cel-banded sucker highlights, ring-SDF sucker
//               approximation, mood tinting, rim glow, and per-instance
//               variation. Includes a procedural sucker-ring texture generator
//               using circular-ring SDFs with per-sucker colour variance and
//               optional mucosal micro-bubble speckle.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Octopus suckers, giant Pacific octopus suckers, blue-ringed
//            octopus suckers, tentacle underside close-ups, cephalopod
//            rendering, underwater creature scenes, anime creature close-ups,
//            and any sucker surface that needs real-time PBR + anime
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
// Octopus sucker presets — biologically grounded PBR parameter sets for
// sucker types.
//
// Reference values (from cgaxis octopus-sucker PBR packs, cephalopod biology
// literature, and CG mucosal-membrane texture references):
//   - Sucker mucosal IOR:        ≈ 1.38 (wet mucus + soft tissue)
//   - Sucker roughness:          0.22–0.38 (glossy wet mucosal disc)
//   - Metalness:                 0.0 (dielectric)
//   - Clearcoat:                 0.35–0.55 (mucus film)
//   - Transmission:              0.15–0.28 (translucent lumen center)
//   - Sheen:                     0.25–0.40 (soft mucosal rim)
//   - Colour:                    pale pink-white to deep rose depending on
//                                species and blood perfusion
// ---------------------------------------------------------------------------

const OctopusSuckerPresets = {
    'common-sucker': {
        color: [0.88, 0.72, 0.68],
        roughness: 0.30,
        metalness: 0.0,
        clearcoat: 0.45,
        clearcoatRoughness: 0.18,
        transmission: 0.22,
        thickness: 0.006,
        attenuationDistance: 0.04,
        attenuationColor: [0.92, 0.76, 0.72],
        sheen: 0.32,
        sheenColor: [0.95, 0.82, 0.78],
        sheenRoughness: 0.40,
        specularIntensity: 0.62,
        specularColor: [0.96, 0.88, 0.85]
    },
    'giant-pacific-sucker': {
        color: [0.82, 0.60, 0.58],
        roughness: 0.26,
        metalness: 0.0,
        clearcoat: 0.50,
        clearcoatRoughness: 0.15,
        transmission: 0.24,
        thickness: 0.008,
        attenuationDistance: 0.05,
        attenuationColor: [0.88, 0.64, 0.60],
        sheen: 0.35,
        sheenColor: [0.92, 0.74, 0.70],
        sheenRoughness: 0.38,
        specularIntensity: 0.66,
        specularColor: [0.95, 0.85, 0.82]
    },
    'blue-ringed-sucker': {
        color: [0.94, 0.86, 0.62],
        roughness: 0.28,
        metalness: 0.0,
        clearcoat: 0.48,
        clearcoatRoughness: 0.16,
        transmission: 0.23,
        thickness: 0.006,
        attenuationDistance: 0.04,
        attenuationColor: [0.95, 0.88, 0.66],
        sheen: 0.30,
        sheenColor: [0.98, 0.92, 0.72],
        sheenRoughness: 0.40,
        specularIntensity: 0.60,
        specularColor: [0.98, 0.94, 0.82]
    },
    'aged-sucker': {
        color: [0.72, 0.58, 0.52],
        roughness: 0.38,
        metalness: 0.0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.25,
        transmission: 0.15,
        thickness: 0.006,
        attenuationDistance: 0.04,
        attenuationColor: [0.76, 0.62, 0.56],
        sheen: 0.25,
        sheenColor: [0.82, 0.70, 0.64],
        sheenRoughness: 0.50,
        specularIntensity: 0.52,
        specularColor: [0.88, 0.82, 0.78]
    },
    'blood-perfused-sucker': {
        color: [0.82, 0.42, 0.42],
        roughness: 0.24,
        metalness: 0.0,
        clearcoat: 0.52,
        clearcoatRoughness: 0.14,
        transmission: 0.26,
        thickness: 0.008,
        attenuationDistance: 0.05,
        attenuationColor: [0.88, 0.42, 0.42],
        sheen: 0.34,
        sheenColor: [0.95, 0.55, 0.55],
        sheenRoughness: 0.36,
        specularIntensity: 0.68,
        specularColor: [0.98, 0.78, 0.76]
    },
    'anime-sucker': {
        color: [0.92, 0.74, 0.72],
        roughness: 0.22,
        metalness: 0.0,
        clearcoat: 0.55,
        clearcoatRoughness: 0.12,
        transmission: 0.28,
        thickness: 0.008,
        attenuationDistance: 0.05,
        attenuationColor: [0.95, 0.78, 0.76],
        sheen: 0.40,
        sheenColor: [1.0, 0.86, 0.84],
        sheenRoughness: 0.35,
        specularIntensity: 0.72,
        specularColor: [1.0, 0.92, 0.90]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable sucker scratch records
// ---------------------------------------------------------------------------

class OctopusSuckerScratchPool {
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

const _octopusSuckerScratchPool = new OctopusSuckerScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — sucker-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded sucker highlights. Sucker discs have crisp, glossy
 * specular highlights with a warm pale-pink base — quantizing the luminance
 * into discrete bands produces the crisp anime sucker look seen in hand-drawn
 * cephalopod close-ups.
 */
function applySuckerCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.08) {
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
 * Apply mood-based tinting to sucker skin. Warm moods push suckers toward warm
 * rose-pink, cool moods toward cool pale-lilac — matching the atmospheric
 * sucker tinting seen in stylized underwater scenes.
 */
function gradeSuckerColor(color, temperature, saturation, brightness, contrast) {
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

    // Sucker-specific temperature bias: warm shift pushes toward rose-pink
    // (R up, G slightly up, B down); cool shift pushes toward pale-lilac.
    r += temperature * 0.025;
    g += temperature * 0.01;
    b -= temperature * 0.025;

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
 * Generate a procedural sucker-ring texture. The algorithm:
 * 1. Divide UV into a jittered grid of sucker cells.
 * 2. For each pixel compute the local cell-local radius from the cell centre.
 * 3. Build the sucker SDF: outer disc + darker ring band + brighter lumen
 *    center + optional mucosal micro-bubble speckle.
 * 4. Per-sucker colour variance from a hashed ID gives organic variation.
 * 5. Multi-octave fBm adds the soft membrane mottle between suckers.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateSuckerRingTexture(width, height, suckerCols = 8, suckerRows = 8, discRadius = 0.44, ringThickness = 0.14, lumenRadius = 0.18, bubbleDensity = 0.10, mottleStrength = 0.08) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Cell-local coordinates
            const gx = (x / width) * suckerCols;
            const gy = (y / height) * suckerRows;
            const cellX = Math.floor(gx);
            const cellY = Math.floor(gy);
            const fx = gx - cellX - 0.5;
            const fy = gy - cellY - 0.5;
            const r = Math.sqrt(fx * fx + fy * fy);

            // Per-sucker hash
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const cellHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;
            const cellTint = 0.85 + cellHash * 0.15;

            // --- Sucker SDF: outer disc / ring band / lumen ---
            let suckerValue = 0;

            // Disc mask (soft edge)
            const discMask = 1.0 - Math.min(1.0, Math.max(0.0, (r - discRadius + 0.04) / 0.04));
            // Ring band (dark annulus near the outer edge)
            const ringDist = Math.abs(r - (discRadius - ringThickness * 0.5));
            const ringMask = Math.max(0.0, 1.0 - ringDist / (ringThickness * 0.5));
            // Lumen center (bright inner disc)
            const lumenMask = 1.0 - Math.min(1.0, Math.max(0.0, (r - lumenRadius + 0.02) / 0.02));

            // Base sucker body
            suckerValue = discMask * 0.55;
            // Darken the ring
            suckerValue -= ringMask * 0.30;
            // Brighten the lumen
            suckerValue += lumenMask * 0.45;

            // --- Mucosal micro-bubble speckle ---
            let bubble = 0;
            if (bubbleDensity > 0) {
                const bCellX = Math.floor(x * 0.5);
                const bCellY = Math.floor(y * 0.5);
                const bCellId = bCellX * 73856093 ^ bCellY * 19349663;
                const bHash = Math.abs(Math.sin(bCellId * 12.9898) * 43758.5453) % 1.0;
                if (bHash > (1.0 - bubbleDensity)) {
                    bubble = 0.10 * bHash;
                }
            }

            // --- Membrane mottle between suckers ---
            const mottle = SimplexNoise.noise2D(x * 0.05, y * 0.05) * 0.5 + 0.5;
            const mottleValue = (mottle - 0.5) * mottleStrength;

            // --- Combine ---
            let value = 0.35 + suckerValue * cellTint + bubble + mottleValue;
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

const _octopusSuckerWorld = BitECS.createWorld();
const OctopusSuckerMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    suckerBands: 'ui8',
    suckerQuantize: 'f64',
    suckerSoftness: 'f64',
    suckerCols: 'ui8',
    suckerRows: 'ui8',
    ringThickness: 'f64',
    lumenRadius: 'f64',
    bubbleDensity: 'f64',
    mottleStrength: 'f64',
    wetMucosalSheen: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OctopusSuckerMaterialBatch {
    constructor() {
        this.world = _octopusSuckerWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OctopusSuckerMaterialComponent, eid);
        OctopusSuckerMaterialComponent.materialPtr[eid] = this.materials.length;
        OctopusSuckerMaterialComponent.suckerBands[eid] = material.suckerBands;
        OctopusSuckerMaterialComponent.suckerQuantize[eid] = material.suckerQuantize;
        OctopusSuckerMaterialComponent.suckerSoftness[eid] = material.suckerSoftness;
        OctopusSuckerMaterialComponent.suckerCols[eid] = material.suckerCols;
        OctopusSuckerMaterialComponent.suckerRows[eid] = material.suckerRows;
        OctopusSuckerMaterialComponent.ringThickness[eid] = material.ringThickness;
        OctopusSuckerMaterialComponent.lumenRadius[eid] = material.lumenRadius;
        OctopusSuckerMaterialComponent.bubbleDensity[eid] = material.bubbleDensity;
        OctopusSuckerMaterialComponent.mottleStrength[eid] = material.mottleStrength;
        OctopusSuckerMaterialComponent.wetMucosalSheen[eid] = material.wetMucosalSheen;
        OctopusSuckerMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OctopusSuckerMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OctopusSuckerMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OctopusSuckerMaterialComponent.moodContrast[eid] = material.moodContrast;
        OctopusSuckerMaterialComponent.rimGlow[eid] = material.rimGlow;
        OctopusSuckerMaterialComponent.variationSeed[eid] = material.variationSeed;
        OctopusSuckerMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OctopusSuckerMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.suckerBands = OctopusSuckerMaterialComponent.suckerBands[eid];
            material.suckerQuantize = OctopusSuckerMaterialComponent.suckerQuantize[eid];
            material.suckerSoftness = OctopusSuckerMaterialComponent.suckerSoftness[eid];
            material.suckerCols = OctopusSuckerMaterialComponent.suckerCols[eid];
            material.suckerRows = OctopusSuckerMaterialComponent.suckerRows[eid];
            material.ringThickness = OctopusSuckerMaterialComponent.ringThickness[eid];
            material.lumenRadius = OctopusSuckerMaterialComponent.lumenRadius[eid];
            material.bubbleDensity = OctopusSuckerMaterialComponent.bubbleDensity[eid];
            material.mottleStrength = OctopusSuckerMaterialComponent.mottleStrength[eid];
            material.wetMucosalSheen = OctopusSuckerMaterialComponent.wetMucosalSheen[eid];
            material.moodTemperature = OctopusSuckerMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OctopusSuckerMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OctopusSuckerMaterialComponent.moodBrightness[eid];
            material.moodContrast = OctopusSuckerMaterialComponent.moodContrast[eid];
            material.rimGlow = OctopusSuckerMaterialComponent.rimGlow[eid];
            material.variationSeed = OctopusSuckerMaterialComponent.variationSeed[eid];

            OctopusSuckerMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OctopusSuckerMaterial class
// ---------------------------------------------------------------------------

class OctopusSuckerMaterial extends MeshPhysicalMaterial {
    static {
        _octopusSuckerScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOctopusSuckerMaterial = true;
        this.type = 'OctopusSuckerMaterial';

        // -------------------------------------------------------------------
        // Sucker-specific PBR defaults (common-octopus baseline)
        // -------------------------------------------------------------------
        this.ior = 1.38;
        this.specularIntensity = 0.62;
        this.roughness = 0.30;
        this.metalness = 0.0;
        this.specularColor = new Color(0.96, 0.88, 0.85);
        this.color = new Color(0.88, 0.72, 0.68);

        // Clearcoat for the mucus film on the sucker disc
        this.clearcoat = 0.45;
        this.clearcoatRoughness = 0.18;

        // Thin-walled transmission for the translucent lumen
        this.transmission = 0.22;
        this.thickness = 0.006;
        this.attenuationDistance = 0.04;
        this.attenuationColor = new Color(0.92, 0.76, 0.72);

        // Sheen for the soft mucosal rim
        this.sheen = 0.32;
        this.sheenColor = new Color(0.95, 0.82, 0.78);
        this.sheenRoughness = 0.40;

        // -------------------------------------------------------------------
        // Anime rendering extensions — sucker-specific
        // -------------------------------------------------------------------
        this.suckerBands = 3;
        this.suckerQuantize = 0.4;
        this.suckerSoftness = 0.08;

        // Sucker-ring controls
        this.suckerCols = 8;
        this.suckerRows = 8;
        this.ringThickness = 0.14;
        this.lumenRadius = 0.18;
        this.bubbleDensity = 0.10;
        this.mottleStrength = 0.08;
        this.wetMucosalSheen = 0.45;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.95, 0.82, 0.78);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (sucker leans semi-realistic)
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

    applySuckerBanding(baseColor, output) {
        return applySuckerCelBanding(
            baseColor,
            output,
            this.suckerBands,
            this.suckerQuantize,
            this.suckerSoftness
        );
    }

    updateMoodColor() {
        gradeSuckerColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named octopus-sucker preset to this material.
     * @param {string} presetName - One of the keys of `OctopusSuckerPresets`.
     * @returns {OctopusSuckerMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OctopusSuckerPresets[presetName];
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
        if (presetName === 'anime-sucker') {
            this.suckerSoftness = 0.05;
            this.suckerBands = 4;
            this.wetMucosalSheen = 0.60;
        } else if (presetName === 'aged-sucker') {
            this.suckerSoftness = 0.16;
            this.suckerBands = 2;
            this.wetMucosalSheen = 0.30;
        } else if (presetName === 'blood-perfused-sucker') {
            this.suckerSoftness = 0.06;
            this.suckerBands = 3;
            this.wetMucosalSheen = 0.55;
        } else {
            this.suckerSoftness = 0.08;
            this.suckerBands = 3;
            this.wetMucosalSheen = 0.45;
        }

        this.updateMoodColor();
        return this;
    }

    generateSuckerRingTexture(width, height, suckerCols = 8, suckerRows = 8, discRadius = 0.44, ringThickness = 0.14, lumenRadius = 0.18) {
        return generateSuckerRingTexture(width, height, suckerCols, suckerRows, discRadius, ringThickness, lumenRadius, this.bubbleDensity, this.mottleStrength);
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

        shader.uniforms.suckerBands = { value: this.suckerBands };
        shader.uniforms.suckerQuantize = { value: this.suckerQuantize };
        shader.uniforms.suckerSoftness = { value: this.suckerSoftness };
        shader.uniforms.suckerCols = { value: this.suckerCols };
        shader.uniforms.suckerRows = { value: this.suckerRows };
        shader.uniforms.ringThickness = { value: this.ringThickness };
        shader.uniforms.lumenRadius = { value: this.lumenRadius };
        shader.uniforms.bubbleDensity = { value: this.bubbleDensity };
        shader.uniforms.mottleStrength = { value: this.mottleStrength };
        shader.uniforms.wetMucosalSheen = { value: this.wetMucosalSheen };
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
                uniform int suckerBands;
                uniform float suckerQuantize;
                uniform float suckerSoftness;
                uniform int suckerCols;
                uniform int suckerRows;
                uniform float ringThickness;
                uniform float lumenRadius;
                uniform float bubbleDensity;
                uniform float mottleStrength;
                uniform float wetMucosalSheen;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applySuckerBands(vec3 baseColor) {
                    if (suckerBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(suckerBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * suckerSoftness;
                    float finalLum = mix(lum, softQuantized, suckerQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply sucker cel banding
                gl_FragColor.rgb = applySuckerBands(gl_FragColor.rgb);

                // Sucker-ring approximation: per-cell disc / ring / lumen
                {
                    float cols = max(1.0, float(suckerCols));
                    float rows = max(1.0, float(suckerRows));
                    vec2 cellUV = vec2(vUv.x * cols, vUv.y * rows);
                    vec2 cellLocal = fract(cellUV) - 0.5;
                    float localR = length(cellLocal);
                    float discRadius = 0.44;

                    // Disc mask (soft edge)
                    float discMask = 1.0 - clamp((localR - discRadius + 0.04) / 0.04, 0.0, 1.0);
                    // Ring band darkening
                    float ringDist = abs(localR - (discRadius - ringThickness * 0.5));
                    float ringMask = max(0.0, 1.0 - ringDist / (ringThickness * 0.5));
                    // Lumen bright inner disc
                    float lumenMask = 1.0 - clamp((localR - lumenRadius + 0.02) / 0.02, 0.0, 1.0);

                    gl_FragColor.rgb *= (1.0 - ringMask * 0.35 * discMask);
                    gl_FragColor.rgb += vec3(lumenMask * 0.20 * discMask);
                }

                // Mucosal micro-bubble speckle
                if (bubbleDensity > 0.0) {
                    vec2 bubbleUV = vUv * 200.0;
                    vec2 bubbleCell = floor(bubbleUV);
                    float bubbleHash = fract(sin(dot(bubbleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    float bubbleMask = bubbleHash > (1.0 - bubbleDensity) ? (bubbleHash * 0.10) : 0.0;
                    gl_FragColor.rgb += vec3(bubbleMask);
                }

                // Membrane mottle between suckers
                if (mottleStrength > 0.0) {
                    float mottle = sin(vUv.x * 30.0 + variationOffset) * cos(vUv.y * 30.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + mottle * mottleStrength * 0.10);
                }

                // Wet mucosal sheen: bright grazing-angle glint on the disc
                if (wetMucosalSheen > 0.0) {
                    float ndotvSuck = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float wetGleam = pow(1.0 - ndotvSuck, 3.0) * wetMucosalSheen;
                    gl_FragColor.rgb += sheenColor * wetGleam * 0.6;
                }

                // Warm rim glow on sucker edges
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
            this.suckerBands, this.suckerQuantize, this.suckerSoftness,
            this.suckerCols, this.suckerRows,
            this.ringThickness, this.lumenRadius,
            this.bubbleDensity, this.mottleStrength, this.wetMucosalSheen,
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
        this.suckerBands = source.suckerBands;
        this.suckerQuantize = source.suckerQuantize;
        this.suckerSoftness = source.suckerSoftness;
        this.suckerCols = source.suckerCols;
        this.suckerRows = source.suckerRows;
        this.ringThickness = source.ringThickness;
        this.lumenRadius = source.lumenRadius;
        this.bubbleDensity = source.bubbleDensity;
        this.mottleStrength = source.mottleStrength;
        this.wetMucosalSheen = source.wetMucosalSheen;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OctopusSuckerMaterial';
        if (this.ior !== 1.38) data.ior = this.ior;
        if (this.specularIntensity !== 0.62) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.30) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.45) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.18) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.22) data.transmission = this.transmission;
        if (this.thickness !== 0.006) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.04) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.92, 0.76, 0.72).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.32) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.95, 0.82, 0.78).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.40) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.96, 0.88, 0.85).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.suckerBands !== 3) data.suckerBands = this.suckerBands;
        if (this.suckerQuantize !== 0.4) data.suckerQuantize = this.suckerQuantize;
        if (this.suckerSoftness !== 0.08) data.suckerSoftness = this.suckerSoftness;
        if (this.suckerCols !== 8) data.suckerCols = this.suckerCols;
        if (this.suckerRows !== 8) data.suckerRows = this.suckerRows;
        if (this.ringThickness !== 0.14) data.ringThickness = this.ringThickness;
        if (this.lumenRadius !== 0.18) data.lumenRadius = this.lumenRadius;
        if (this.bubbleDensity !== 0.10) data.bubbleDensity = this.bubbleDensity;
        if (this.mottleStrength !== 0.08) data.mottleStrength = this.mottleStrength;
        if (this.wetMucosalSheen !== 0.45) data.wetMucosalSheen = this.wetMucosalSheen;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.95, 0.82, 0.78).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.suckerBands = json.suckerBands ?? this.suckerBands;
        this.suckerQuantize = json.suckerQuantize ?? this.suckerQuantize;
        this.suckerSoftness = json.suckerSoftness ?? this.suckerSoftness;
        this.suckerCols = json.suckerCols ?? this.suckerCols;
        this.suckerRows = json.suckerRows ?? this.suckerRows;
        this.ringThickness = json.ringThickness ?? this.ringThickness;
        this.lumenRadius = json.lumenRadius ?? this.lumenRadius;
        this.bubbleDensity = json.bubbleDensity ?? this.bubbleDensity;
        this.mottleStrength = json.mottleStrength ?? this.mottleStrength;
        this.wetMucosalSheen = json.wetMucosalSheen ?? this.wetMucosalSheen;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OctopusSuckerMaterialBatchComponent = {
    materialPtr: 'ui32',
    suckerBands: 'ui8',
    suckerQuantize: 'f64',
    suckerSoftness: 'f64',
    suckerCols: 'ui8',
    suckerRows: 'ui8',
    ringThickness: 'f64',
    lumenRadius: 'f64',
    bubbleDensity: 'f64',
    mottleStrength: 'f64',
    wetMucosalSheen: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OctopusSuckerMaterial,
    OctopusSuckerMaterialBatch,
    OctopusSuckerScratchPool,
    OctopusSuckerMaterialBatchComponent,
    OctopusSuckerPresets,
    applySuckerCelBanding,
    gradeSuckerColor,
    generateSuckerRingTexture
};

export default OctopusSuckerMaterial;