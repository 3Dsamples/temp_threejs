// file number : 218
// full path name : src/materials/218_organicinsectchitinmaterial.js
// description : OrganicInsectChitinMaterial — a ready-to-use chitin material
//               for insect exoskeletons, beetle shells, crustacean shells, and
//               other keratinous or chitinous organic surfaces. Extends
//               MeshPhysicalMaterial with purpose-built presets for beetle
//               black, beetle metallic green, dragonfly blue, ladybug red,
//               crustacean orange, and ant dark-brown chitin. Includes
//               biologically grounded defaults (IOR ≈ 1.55, low roughness
//               0.15–0.35 for glossy shells, strong iridescence for metallic
//               beetles, zero metalness) plus real-time anime stylization:
//               cel-banded chitin highlights, iridescent chitin shimmer,
//               mood tinting, rim glow, and per-instance variation. Includes
//               a procedural hex-chitin texture generator using hex SDF cells
//               with per-cell hashing and optional anisotropy for the shell
//               dome direction.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Organic chitin, insect exoskeletons, beetle shells, dragonfly
//            wings, ladybug carapaces, crustacean shells, scorpion armor,
//            fantasy creature chitin, and any chitinous organic surface that
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
// Chitin presets — biologically grounded PBR parameter sets for chitin types.
//
// Reference values (from Insect cuticle PBR literature, Disney BRDF, and
// CG beetle/chitin texture packs):
//   - Chitin IOR:              ≈ 1.55
//   - Chitin roughness:        0.15–0.35 (glossy shells)
//   - Iridescence:             strong for metallic beetles (0.6–1.0)
//   - Metalness:               0.0 (chitin is a dielectric; shine comes from
//                              a multilayer thin-film interference structure)
//   - Chitin sheen:            often present at grazing angles
// ---------------------------------------------------------------------------

const OrganicInsectChitinPresets = {
    'beetle-black': {
        color: [0.06, 0.06, 0.08],
        roughness: 0.18,
        metalness: 0.0,
        iridescence: 0.25,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [200, 600],
        specularIntensity: 0.85,
        specularColor: [0.85, 0.85, 0.92],
        transmission: 0.0,
        thickness: 0.01,
        attenuationDistance: 0.05,
        attenuationColor: [0.10, 0.10, 0.14],
        sheen: 0.20,
        sheenColor: [0.30, 0.30, 0.38],
        sheenRoughness: 0.40
    },
    'beetle-metallic-green': {
        color: [0.10, 0.28, 0.12],
        roughness: 0.14,
        metalness: 0.0,
        iridescence: 0.85,
        iridescenceIOR: 1.65,
        iridescenceThicknessRange: [300, 800],
        specularIntensity: 0.92,
        specularColor: [0.88, 0.98, 0.88],
        transmission: 0.0,
        thickness: 0.01,
        attenuationDistance: 0.05,
        attenuationColor: [0.18, 0.42, 0.20],
        sheen: 0.35,
        sheenColor: [0.45, 0.70, 0.42],
        sheenRoughness: 0.35
    },
    'dragonfly-blue': {
        color: [0.10, 0.24, 0.48],
        roughness: 0.16,
        metalness: 0.0,
        iridescence: 0.90,
        iridescenceIOR: 1.60,
        iridescenceThicknessRange: [280, 760],
        specularIntensity: 0.90,
        specularColor: [0.82, 0.92, 1.00],
        transmission: 0.05,
        thickness: 0.005,
        attenuationDistance: 0.06,
        attenuationColor: [0.15, 0.35, 0.65],
        sheen: 0.32,
        sheenColor: [0.45, 0.62, 0.90],
        sheenRoughness: 0.35
    },
    'ladybug-red': {
        color: [0.72, 0.10, 0.08],
        roughness: 0.15,
        metalness: 0.0,
        iridescence: 0.35,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [220, 620],
        specularIntensity: 0.88,
        specularColor: [1.00, 0.85, 0.80],
        transmission: 0.0,
        thickness: 0.01,
        attenuationDistance: 0.05,
        attenuationColor: [0.85, 0.18, 0.12],
        sheen: 0.28,
        sheenColor: [0.85, 0.30, 0.22],
        sheenRoughness: 0.40
    },
    'crustacean-orange': {
        color: [0.82, 0.36, 0.10],
        roughness: 0.28,
        metalness: 0.0,
        iridescence: 0.45,
        iridescenceIOR: 1.50,
        iridescenceThicknessRange: [260, 700],
        specularIntensity: 0.78,
        specularColor: [0.98, 0.88, 0.72],
        transmission: 0.02,
        thickness: 0.01,
        attenuationDistance: 0.06,
        attenuationColor: [0.85, 0.42, 0.15],
        sheen: 0.30,
        sheenColor: [0.92, 0.52, 0.22],
        sheenRoughness: 0.45
    },
    'ant-dark-brown': {
        color: [0.14, 0.10, 0.06],
        roughness: 0.30,
        metalness: 0.0,
        iridescence: 0.15,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [200, 550],
        specularIntensity: 0.75,
        specularColor: [0.75, 0.72, 0.68],
        transmission: 0.0,
        thickness: 0.01,
        attenuationDistance: 0.05,
        attenuationColor: [0.20, 0.14, 0.10],
        sheen: 0.22,
        sheenColor: [0.32, 0.24, 0.18],
        sheenRoughness: 0.50
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable chitin scratch records
// ---------------------------------------------------------------------------

class ChitinScratchPool {
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

const _chitinScratchPool = new ChitinScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — chitin-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded chitin highlights. Chitin shells have very crisp,
 * specular-edged highlights — quantizing the luminance into discrete bands
 * produces the flat anime shell shine seen in hand-drawn entomological and
 * fantasy illustrations.
 */
function applyChitinCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.05) {
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
 * Apply mood-based tinting to chitin. Warm moods push chitin toward warm
 * amber/gold, cool moods toward cool steel-blue — matching the atmospheric
 * chitin tinting seen in stylized insect/fantasy scenes.
 */
function gradeChitinColor(color, temperature, saturation, brightness, contrast) {
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

    // Chitin-specific temperature bias: warm shift pushes toward amber/gold,
    // cool shift pushes toward steel-blue.
    r += temperature * 0.03;
    g += temperature * 0.02;
    b -= temperature * 0.04;

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
 * Generate a procedural hex-chitin texture. The algorithm:
 * 1. Convert UV into hex-cell coordinates (axial coordinates).
 * 2. For each pixel, compute the distance to the nearest hex cell centre.
 * 3. Use a smooth-step on the hex SDF to isolate the plate mask.
 * 4. Per-cell hashing produces small colour/brightness variations.
 * 5. Optional anisotropy mask brightens along the shell's primary dome
 *    direction.
 * 6. Fine simplex-noise mottle breaks up uniformity.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * anisotropy direction, or bump-map use.
 */
function generateHexChitinTexture(width, height, hexCols = 24, hexRows = 24, cellRadius = 0.42, cellEdgeSoftness = 0.05, cellJitter = 0.06, anisotropyStrength = 0.30) {
    const out = new Uint8Array(width * height * 4);

    // Hex lattice constants
    const sqrt3 = Math.sqrt(3.0);
    const colStep = 1.5 * cellRadius;
    const rowStep = sqrt3 * cellRadius;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Normalized coordinates scaled to hex grid
            const u = (x / width) * hexCols;
            const v = (y / height) * hexRows;

            // Axial → cube → nearest hex
            const q = (sqrt3 / 3.0) * u - (1.0 / 3.0) * v;
            const r = (2.0 / 3.0) * v;

            // Cube rounding for nearest hex cell
            let cx = q;
            let cz = r;
            let cy = -cx - cz;
            let rx = Math.round(cx);
            let ry = Math.round(cy);
            let rz = Math.round(cz);
            const xDiff = Math.abs(rx - cx);
            const yDiff = Math.abs(ry - cy);
            const zDiff = Math.abs(rz - cz);
            if (xDiff > yDiff && xDiff > zDiff) {
                rx = -ry - rz;
            } else if (yDiff > zDiff) {
                ry = -rx - rz;
            } else {
                rz = -rx - ry;
            }

            // Hex centre in pixel-ish space
            const hx = (sqrt3 * rx + sqrt3 * 0.5 * rz);
            const hz = (1.5 * rz);

            // Distance to the nearest hex centre (approximate SDF)
            const ddx = u - hx;
            const ddy = v - hz;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy) / cellRadius;

            // Plate mask: 1 at the centre, 0 at the edges
            const plateMask = 1.0 - Math.max(0, Math.min(1, (dist - 1.0 + cellEdgeSoftness) / cellEdgeSoftness));

            // Per-cell hashing
            const cellId = Math.floor(rx) * 73856093 ^ Math.floor(rz) * 19349663;
            const hash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;
            const cellTint = 0.85 + hash * 0.15;

            // Jitter of the plate centre (breaks regularity)
            const jitterX = (hash - 0.5) * cellJitter;
            const jitterY = ((Math.abs(Math.sin(cellId * 78.233) * 43758.5453) % 1.0) - 0.5) * cellJitter;
            const jitteredDist = Math.sqrt((ddx + jitterX) * (ddx + jitterX) + (ddy + jitterY) * (ddy + jitterY)) / cellRadius;

            // Anisotropy mask (brighter along one axis)
            const anisotropy = Math.max(0, 1.0 - Math.abs(jitteredDist)) * anisotropyStrength;

            // Fine mottle
            const mottle = SimplexNoise.noise2D(x * 0.6, y * 0.6) * 0.04;

            // Combine
            let value = 0.35
                + plateMask * 0.40 * cellTint
                + anisotropy * 0.10
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

const _chitinWorld = BitECS.createWorld();
const OrganicInsectChitinMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    chitinBands: 'ui8',
    chitinQuantize: 'f64',
    chitinSoftness: 'f64',
    chitinIridescence: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicInsectChitinMaterialBatch {
    constructor() {
        this.world = _chitinWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicInsectChitinMaterialComponent, eid);
        OrganicInsectChitinMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicInsectChitinMaterialComponent.chitinBands[eid] = material.chitinBands;
        OrganicInsectChitinMaterialComponent.chitinQuantize[eid] = material.chitinQuantize;
        OrganicInsectChitinMaterialComponent.chitinSoftness[eid] = material.chitinSoftness;
        OrganicInsectChitinMaterialComponent.chitinIridescence[eid] = material.chitinIridescence;
        OrganicInsectChitinMaterialComponent.anisotropyStrength[eid] = material.anisotropy;
        OrganicInsectChitinMaterialComponent.anisotropyRotation[eid] = material.anisotropyRotation;
        OrganicInsectChitinMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicInsectChitinMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicInsectChitinMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicInsectChitinMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicInsectChitinMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicInsectChitinMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicInsectChitinMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicInsectChitinMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.chitinBands = OrganicInsectChitinMaterialComponent.chitinBands[eid];
            material.chitinQuantize = OrganicInsectChitinMaterialComponent.chitinQuantize[eid];
            material.chitinSoftness = OrganicInsectChitinMaterialComponent.chitinSoftness[eid];
            material.chitinIridescence = OrganicInsectChitinMaterialComponent.chitinIridescence[eid];
            material.anisotropy = OrganicInsectChitinMaterialComponent.anisotropyStrength[eid];
            material.anisotropyRotation = OrganicInsectChitinMaterialComponent.anisotropyRotation[eid];
            material.moodTemperature = OrganicInsectChitinMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicInsectChitinMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicInsectChitinMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicInsectChitinMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicInsectChitinMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicInsectChitinMaterialComponent.variationSeed[eid];

            OrganicInsectChitinMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicInsectChitinMaterial class
// ---------------------------------------------------------------------------

class OrganicInsectChitinMaterial extends MeshPhysicalMaterial {
    static {
        _chitinScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicInsectChitinMaterial = true;
        this.type = 'OrganicInsectChitinMaterial';

        // -------------------------------------------------------------------
        // Chitin-specific PBR defaults (beetle-black baseline)
        // -------------------------------------------------------------------
        this.ior = 1.55;
        this.specularIntensity = 0.85;
        this.roughness = 0.18;
        this.metalness = 0.0;
        this.specularColor = new Color(0.85, 0.85, 0.92);
        this.color = new Color(0.06, 0.06, 0.08);

        // Anisotropy for shell dome direction
        this.anisotropy = 0.60;
        this.anisotropyRotation = 0.0;

        // Iridescence for metallic beetle / dragonfly shimmer
        this.iridescence = 0.25;
        this.iridescenceIOR = 1.55;
        this.iridescenceThicknessRange = [200, 600];

        // Thin-walled transmission (optional, for membranous wings)
        this.transmission = 0.0;
        this.thickness = 0.01;
        this.attenuationDistance = 0.05;
        this.attenuationColor = new Color(0.10, 0.10, 0.14);

        // Sheen for the chitin edge glow
        this.sheen = 0.20;
        this.sheenColor = new Color(0.30, 0.30, 0.38);
        this.sheenRoughness = 0.40;

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — chitin-specific
        // -------------------------------------------------------------------
        this.chitinBands = 3;
        this.chitinQuantize = 0.5;
        this.chitinSoftness = 0.05;
        this.chitinIridescence = 0.25;
        this.chitinIridescenceColor = new Color(0.85, 0.85, 1.0);

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(0.85, 0.85, 1.0);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (chitin leans semi-realistic)
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

    applyChitinBanding(baseColor, output) {
        return applyChitinCelBanding(
            baseColor,
            output,
            this.chitinBands,
            this.chitinQuantize,
            this.chitinSoftness
        );
    }

    updateMoodColor() {
        gradeChitinColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic chitin preset to this material.
     * @param {string} presetName - One of the keys of `OrganicInsectChitinPresets`.
     * @returns {OrganicInsectChitinMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicInsectChitinPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.iridescence = preset.iridescence;
        this.iridescenceIOR = preset.iridescenceIOR;
        this.iridescenceThicknessRange = preset.iridescenceThicknessRange.slice();
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.transmission = preset.transmission;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;

        // Adjust anime band softness per preset
        if (presetName === 'beetle-metallic-green' || presetName === 'dragonfly-blue') {
            this.chitinSoftness = 0.03;
            this.chitinBands = 4;
        } else if (presetName === 'ant-dark-brown' || presetName === 'crustacean-orange') {
            this.chitinSoftness = 0.10;
            this.chitinBands = 2;
        } else {
            this.chitinSoftness = 0.05;
            this.chitinBands = 3;
        }

        this.chitinIridescence = preset.iridescence;

        this.updateMoodColor();
        return this;
    }

    generateHexChitinTexture(width, height, hexCols = 24, hexRows = 24, cellRadius = 0.42) {
        return generateHexChitinTexture(width, height, hexCols, hexRows, cellRadius, 0.05, 0.06, 0.30);
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

        shader.uniforms.chitinBands = { value: this.chitinBands };
        shader.uniforms.chitinQuantize = { value: this.chitinQuantize };
        shader.uniforms.chitinSoftness = { value: this.chitinSoftness };
        shader.uniforms.chitinIridescence = { value: this.chitinIridescence };
        shader.uniforms.chitinIridescenceColor = { value: this.chitinIridescenceColor };
        shader.uniforms.anisotropyStrength = { value: this.anisotropy };
        shader.uniforms.anisotropyRotation = { value: this.anisotropyRotation };
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
                uniform int chitinBands;
                uniform float chitinQuantize;
                uniform float chitinSoftness;
                uniform float chitinIridescence;
                uniform vec3 chitinIridescenceColor;
                uniform float anisotropyStrength;
                uniform float anisotropyRotation;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyChitinBands(vec3 baseColor) {
                    if (chitinBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(chitinBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * chitinSoftness;
                    float finalLum = mix(lum, softQuantized, chitinQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply chitin cel banding
                gl_FragColor.rgb = applyChitinBands(gl_FragColor.rgb);

                // Iridescent chitin shimmer: grazing-angle colour shift
                if (chitinIridescence > 0.0) {
                    float ndotvChitin = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float shimmerMask = pow(1.0 - ndotvChitin, 3.0) * chitinIridescence;
                    // Hue shift based on grazing angle for iridescent film
                    float hueShift = (1.0 - ndotvChitin) * 0.35;
                    vec3 shimmerColor = mix(chitinIridescenceColor, vec3(1.0, 0.90, 0.60), hueShift);
                    gl_FragColor.rgb += shimmerColor * shimmerMask * 0.6;
                }

                // Cool-neutral rim glow on chitin edges
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
            this.anisotropy, this.anisotropyRotation,
            this.iridescence, this.iridescenceIOR,
            this.transmission, this.thickness, this.attenuationDistance,
            this.sheen, this.sheenRoughness,
            this.chitinBands, this.chitinQuantize, this.chitinSoftness,
            this.chitinIridescence,
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
        this.anisotropy = source.anisotropy;
        this.anisotropyRotation = source.anisotropyRotation;
        this.iridescence = source.iridescence;
        this.iridescenceIOR = source.iridescenceIOR;
        this.iridescenceThicknessRange = source.iridescenceThicknessRange.slice();
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.chitinBands = source.chitinBands;
        this.chitinQuantize = source.chitinQuantize;
        this.chitinSoftness = source.chitinSoftness;
        this.chitinIridescence = source.chitinIridescence;
        this.chitinIridescenceColor.copy(source.chitinIridescenceColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicInsectChitinMaterial';
        if (this.ior !== 1.55) data.ior = this.ior;
        if (this.specularIntensity !== 0.85) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.18) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.anisotropy !== 0.60) data.anisotropy = this.anisotropy;
        if (this.anisotropyRotation !== 0.0) data.anisotropyRotation = this.anisotropyRotation;
        if (this.iridescence !== 0.25) data.iridescence = this.iridescence;
        if (this.iridescenceIOR !== 1.55) data.iridescenceIOR = this.iridescenceIOR;
        if (this.transmission !== 0.0) data.transmission = this.transmission;
        if (this.thickness !== 0.01) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.05) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.10, 0.10, 0.14).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.20) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.30, 0.30, 0.38).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.40) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.85, 0.85, 0.92).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.chitinBands !== 3) data.chitinBands = this.chitinBands;
        if (this.chitinQuantize !== 0.5) data.chitinQuantize = this.chitinQuantize;
        if (this.chitinSoftness !== 0.05) data.chitinSoftness = this.chitinSoftness;
        if (this.chitinIridescence !== 0.25) data.chitinIridescence = this.chitinIridescence;
        if (this.chitinIridescenceColor.getHex() !== new Color(0.85, 0.85, 1.0).getHex()) data.chitinIridescenceColor = this.chitinIridescenceColor.getHex();
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.85, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.anisotropy = json.anisotropy ?? this.anisotropy;
        this.anisotropyRotation = json.anisotropyRotation ?? this.anisotropyRotation;
        this.iridescence = json.iridescence ?? this.iridescence;
        this.iridescenceIOR = json.iridescenceIOR ?? this.iridescenceIOR;
        if (json.iridescenceThicknessRange) this.iridescenceThicknessRange = json.iridescenceThicknessRange.slice();
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.chitinBands = json.chitinBands ?? this.chitinBands;
        this.chitinQuantize = json.chitinQuantize ?? this.chitinQuantize;
        this.chitinSoftness = json.chitinSoftness ?? this.chitinSoftness;
        this.chitinIridescence = json.chitinIridescence ?? this.chitinIridescence;
        if (json.chitinIridescenceColor !== undefined) this.chitinIridescenceColor.setHex(json.chitinIridescenceColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicInsectChitinMaterialBatchComponent = {
    materialPtr: 'ui32',
    chitinBands: 'ui8',
    chitinQuantize: 'f64',
    chitinSoftness: 'f64',
    chitinIridescence: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicInsectChitinMaterial,
    OrganicInsectChitinMaterialBatch,
    ChitinScratchPool,
    OrganicInsectChitinMaterialBatchComponent,
    OrganicInsectChitinPresets,
    applyChitinCelBanding,
    gradeChitinColor,
    generateHexChitinTexture
};

export default OrganicInsectChitinMaterial;