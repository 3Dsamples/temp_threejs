// file number : 225
// full path name : src/materials/225_organicscalematerial.js
// description : OrganicScaleMaterial — a ready-to-use scale material for
//               reptile scales, snake scales, lizard scales, crocodile scutes,
//               and other keratinous scale surfaces. Extends
//               MeshPhysicalMaterial with purpose-built presets for green
//               snake, brown lizard, gecko, crocodile, iridescent serpent, and
//               dragon-scale. Includes scale-appropriate PBR defaults
//               (keratin IOR ≈ 1.548, roughness 0.35–0.55, zero metalness,
//               anisotropic specular along the scale rows, and iridescence for
//               the structural-colour sheen of certain reptiles) plus real-time
//               anime stylization: cel-banded scale highlights, overlapping
//               scale-plate approximation, mood tinting, rim glow, and
//               per-instance variation. Includes a procedural overlapping-scale
//               texture generator using diamond/hex SDF cells with per-scale
//               hashing, directional specular, and optional membrane crevices.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Organic scales, reptile scales, snake scales, lizard scales,
//            crocodile scutes, gecko skin, dragon scales, fantasy creature
//            scales, and any keratinous scale surface that needs real-time
//            PBR + anime stylization.
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
// Scale presets — biologically grounded PBR parameter sets for scale types.
//
// Reference values (from reptile scale PBR packs, cgaxis scale textures, and
// keratin optical literature):
//   - Keratin IOR:             ≈ 1.548 (hair keratin; scale keratin similar)
//   - Scale roughness:         0.35–0.55 (dry scales)
//   - Metalness:               0.0 (scales are dielectric)
//   - Anisotropy:              0.4–0.8 along scale rows
//   - Iridescence:             0.0–0.8 (structural colour in some species)
//   - Sheen:                   subtle oily sheen on raised scale edges
// ---------------------------------------------------------------------------

const OrganicScalePresets = {
    'green-snake': {
        color: [0.18, 0.42, 0.18],
        roughness: 0.40,
        metalness: 0.0,
        anisotropy: 0.65,
        anisotropyRotation: 0.0,
        iridescence: 0.15,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [250, 600],
        specularIntensity: 0.55,
        specularColor: [0.75, 0.88, 0.68],
        sheen: 0.25,
        sheenColor: [0.55, 0.75, 0.42],
        sheenRoughness: 0.55,
        transmission: 0.02,
        thickness: 0.003,
        attenuationDistance: 0.03,
        attenuationColor: [0.30, 0.52, 0.28]
    },
    'brown-lizard': {
        color: [0.42, 0.30, 0.18],
        roughness: 0.46,
        metalness: 0.0,
        anisotropy: 0.55,
        anisotropyRotation: 0.0,
        iridescence: 0.05,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [220, 550],
        specularIntensity: 0.48,
        specularColor: [0.85, 0.72, 0.55],
        sheen: 0.20,
        sheenColor: [0.65, 0.52, 0.35],
        sheenRoughness: 0.60,
        transmission: 0.02,
        thickness: 0.003,
        attenuationDistance: 0.03,
        attenuationColor: [0.52, 0.38, 0.22]
    },
    'gecko': {
        color: [0.62, 0.58, 0.42],
        roughness: 0.50,
        metalness: 0.0,
        anisotropy: 0.45,
        anisotropyRotation: 0.0,
        iridescence: 0.10,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [230, 580],
        specularIntensity: 0.42,
        specularColor: [0.82, 0.78, 0.65],
        sheen: 0.35,
        sheenColor: [0.75, 0.72, 0.55],
        sheenRoughness: 0.65,
        transmission: 0.03,
        thickness: 0.003,
        attenuationDistance: 0.03,
        attenuationColor: [0.68, 0.62, 0.45]
    },
    'crocodile': {
        color: [0.22, 0.26, 0.18],
        roughness: 0.52,
        metalness: 0.0,
        anisotropy: 0.70,
        anisotropyRotation: 0.0,
        iridescence: 0.02,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [200, 500],
        specularIntensity: 0.50,
        specularColor: [0.72, 0.78, 0.62],
        sheen: 0.22,
        sheenColor: [0.48, 0.55, 0.38],
        sheenRoughness: 0.60,
        transmission: 0.01,
        thickness: 0.004,
        attenuationDistance: 0.03,
        attenuationColor: [0.30, 0.35, 0.24]
    },
    'iridescent-serpent': {
        color: [0.08, 0.12, 0.20],
        roughness: 0.28,
        metalness: 0.0,
        anisotropy: 0.75,
        anisotropyRotation: 0.0,
        iridescence: 0.85,
        iridescenceIOR: 1.60,
        iridescenceThicknessRange: [300, 850],
        specularIntensity: 0.78,
        specularColor: [0.55, 0.78, 0.95],
        sheen: 0.30,
        sheenColor: [0.42, 0.62, 0.88],
        sheenRoughness: 0.45,
        transmission: 0.03,
        thickness: 0.003,
        attenuationDistance: 0.03,
        attenuationColor: [0.12, 0.18, 0.32]
    },
    'dragon-scale': {
        color: [0.42, 0.12, 0.14],
        roughness: 0.32,
        metalness: 0.0,
        anisotropy: 0.80,
        anisotropyRotation: 0.0,
        iridescence: 0.60,
        iridescenceIOR: 1.58,
        iridescenceThicknessRange: [280, 750],
        specularIntensity: 0.72,
        specularColor: [0.92, 0.55, 0.52],
        sheen: 0.28,
        sheenColor: [0.85, 0.42, 0.38],
        sheenRoughness: 0.50,
        transmission: 0.02,
        thickness: 0.004,
        attenuationDistance: 0.03,
        attenuationColor: [0.55, 0.18, 0.18]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable scale scratch records
// ---------------------------------------------------------------------------

class ScaleScratchPool {
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

const _scaleScratchPool = new ScaleScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — scale-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded scale highlights. Reptile scales have crisp, specular
 * edges on each overlapping plate — quantizing the luminance into discrete
 * bands produces the flat anime scale shine seen in hand-drawn reptile and
 * dragon illustrations.
 */
function applyScaleCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.08) {
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
 * Apply mood-based tinting to scales. Warm moods push scales toward warm
 * amber/ochre, cool moods toward cool teal/blue — matching the atmospheric
 * scale tinting seen in stylized reptile and dragon scenes.
 */
function gradeScaleColor(color, temperature, saturation, brightness, contrast) {
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

    // Scale-specific temperature bias: warm shift pushes toward amber/ochre,
    // cool shift pushes toward teal/blue.
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
 * Generate a procedural overlapping-scale texture. The algorithm:
 * 1. Diamond/hex Voronoi cells: place jittered seeds in a 3x3 neighbourhood,
 *    compute F1 distance to the nearest seed — the cell centre is the scale
 *    tip, and the F2-F1 difference gives the overlapping scale rim.
 * 2. Scale-tip highlight: a smooth power function on F1 produces the convex
 *    scale dome.
 * 3. Membrane crevices: darkening along the F2-F1 boundary (the gap between
 *    overlapping scales).
 * 4. Per-scale hashing: subtle colour variation between scales.
 * 5. Fine simplex-noise mottle for micro-surface texture.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * anisotropy direction, or bump-map use.
 */
function generateScalePatternTexture(width, height, scaleCols = 32, scaleRows = 32, scaleRadius = 0.48, scaleSharpness = 2.2, membraneStrength = 0.30, perScaleVariance = 0.12) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Jittered Voronoi scale cells
            const vx = (x / width) * scaleCols;
            const vy = (y / height) * scaleRows;
            const cellX = Math.floor(vx);
            const cellY = Math.floor(vy);

            let f1 = 1e9;
            let f2 = 1e9;
            let f1Id = 0;

            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    const nx = cellX + ox;
                    const ny = cellY + oy;
                    const h1 = Math.sin(nx * 127.1 + ny * 311.7) * 43758.5453;
                    const h2 = Math.sin(nx * 269.5 + ny * 183.3) * 43758.5453;
                    const jx = h1 - Math.floor(h1);
                    const jy = h2 - Math.floor(h2);
                    const dx = vx - (nx + jx);
                    const dy = vy - (ny + jy);
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < f1) {
                        f2 = f1;
                        f1 = d;
                        f1Id = nx * 73856093 ^ ny * 19349663;
                    } else if (d < f2) {
                        f2 = d;
                    }
                }
            }

            // Scale-tip dome: 1 at the tip, 0 at the rim
            const scaleDome = Math.pow(Math.max(0, 1.0 - f1 / scaleRadius), scaleSharpness);

            // Membrane crevice: darkening at the F2-F1 boundary
            const cellBorder = Math.max(0, Math.min(1, (f2 - f1) / 0.1));
            const membraneMask = (1.0 - cellBorder) * membraneStrength;

            // Per-scale hashing
            const scaleHash = Math.abs(Math.sin(f1Id * 12.9898) * 43758.5453) % 1.0;
            const scaleTint = 1.0 - perScaleVariance * 0.5 + scaleHash * perScaleVariance;

            // Fine mottle
            const mottle = SimplexNoise.noise2D(x * 0.7, y * 0.7) * 0.04;

            // Combine
            let value = 0.45
                + scaleDome * 0.35 * scaleTint
                - membraneMask * 0.50
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

const _scaleWorld = BitECS.createWorld();
const OrganicScaleMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    scaleBands: 'ui8',
    scaleQuantize: 'f64',
    scaleSoftness: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    membraneStrength: 'f64',
    perScaleVariance: 'f64',
    scaleIridescence: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicScaleMaterialBatch {
    constructor() {
        this.world = _scaleWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicScaleMaterialComponent, eid);
        OrganicScaleMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicScaleMaterialComponent.scaleBands[eid] = material.scaleBands;
        OrganicScaleMaterialComponent.scaleQuantize[eid] = material.scaleQuantize;
        OrganicScaleMaterialComponent.scaleSoftness[eid] = material.scaleSoftness;
        OrganicScaleMaterialComponent.anisotropyStrength[eid] = material.anisotropy;
        OrganicScaleMaterialComponent.anisotropyRotation[eid] = material.anisotropyRotation;
        OrganicScaleMaterialComponent.membraneStrength[eid] = material.membraneStrength;
        OrganicScaleMaterialComponent.perScaleVariance[eid] = material.perScaleVariance;
        OrganicScaleMaterialComponent.scaleIridescence[eid] = material.scaleIridescence;
        OrganicScaleMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicScaleMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicScaleMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicScaleMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicScaleMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicScaleMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicScaleMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicScaleMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.scaleBands = OrganicScaleMaterialComponent.scaleBands[eid];
            material.scaleQuantize = OrganicScaleMaterialComponent.scaleQuantize[eid];
            material.scaleSoftness = OrganicScaleMaterialComponent.scaleSoftness[eid];
            material.anisotropy = OrganicScaleMaterialComponent.anisotropyStrength[eid];
            material.anisotropyRotation = OrganicScaleMaterialComponent.anisotropyRotation[eid];
            material.membraneStrength = OrganicScaleMaterialComponent.membraneStrength[eid];
            material.perScaleVariance = OrganicScaleMaterialComponent.perScaleVariance[eid];
            material.scaleIridescence = OrganicScaleMaterialComponent.scaleIridescence[eid];
            material.moodTemperature = OrganicScaleMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicScaleMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicScaleMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicScaleMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicScaleMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicScaleMaterialComponent.variationSeed[eid];

            OrganicScaleMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicScaleMaterial class
// ---------------------------------------------------------------------------

class OrganicScaleMaterial extends MeshPhysicalMaterial {
    static {
        _scaleScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicScaleMaterial = true;
        this.type = 'OrganicScaleMaterial';

        // -------------------------------------------------------------------
        // Scale-specific PBR defaults (green-snake baseline)
        // -------------------------------------------------------------------
        this.ior = 1.548;
        this.specularIntensity = 0.55;
        this.roughness = 0.40;
        this.metalness = 0.0;
        this.specularColor = new Color(0.75, 0.88, 0.68);
        this.color = new Color(0.18, 0.42, 0.18);

        // Anisotropy along the scale rows
        this.anisotropy = 0.65;
        this.anisotropyRotation = 0.0;

        // Structural-colour iridescence (subtle by default)
        this.iridescence = 0.15;
        this.iridescenceIOR = 1.55;
        this.iridescenceThicknessRange = [250, 600];

        // Sheen for the oily scale edge
        this.sheen = 0.25;
        this.sheenColor = new Color(0.55, 0.75, 0.42);
        this.sheenRoughness = 0.55;

        // Thin-walled transmission (very subtle for wet scales)
        this.transmission = 0.02;
        this.thickness = 0.003;
        this.attenuationDistance = 0.03;
        this.attenuationColor = new Color(0.30, 0.52, 0.28);

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — scale-specific
        // -------------------------------------------------------------------
        this.scaleBands = 3;
        this.scaleQuantize = 0.4;
        this.scaleSoftness = 0.08;

        // Overlapping scale-plate approximation
        this.membraneStrength = 0.30;
        this.perScaleVariance = 0.12;
        this.scaleIridescence = 0.15;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.55, 0.75, 0.42);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (scales lean semi-realistic)
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

    applyScaleBanding(baseColor, output) {
        return applyScaleCelBanding(
            baseColor,
            output,
            this.scaleBands,
            this.scaleQuantize,
            this.scaleSoftness
        );
    }

    updateMoodColor() {
        gradeScaleColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic scale preset to this material.
     * @param {string} presetName - One of the keys of `OrganicScalePresets`.
     * @returns {OrganicScaleMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicScalePresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.anisotropy = preset.anisotropy;
        this.anisotropyRotation = preset.anisotropyRotation;
        this.iridescence = preset.iridescence;
        this.iridescenceIOR = preset.iridescenceIOR;
        this.iridescenceThicknessRange = preset.iridescenceThicknessRange.slice();
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.transmission = preset.transmission;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness per preset
        if (presetName === 'iridescent-serpent' || presetName === 'dragon-scale') {
            this.scaleSoftness = 0.04;
            this.scaleBands = 4;
        } else if (presetName === 'crocodile') {
            this.scaleSoftness = 0.15;
            this.scaleBands = 2;
        } else {
            this.scaleSoftness = 0.08;
            this.scaleBands = 3;
        }

        this.scaleIridescence = preset.iridescence;

        this.updateMoodColor();
        return this;
    }

    generateScalePatternTexture(width, height, scaleCols = 32, scaleRows = 32, scaleRadius = 0.48, scaleSharpness = 2.2, membraneStrength = 0.30, perScaleVariance = 0.12) {
        return generateScalePatternTexture(width, height, scaleCols, scaleRows, scaleRadius, scaleSharpness, membraneStrength, perScaleVariance);
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

        shader.uniforms.scaleBands = { value: this.scaleBands };
        shader.uniforms.scaleQuantize = { value: this.scaleQuantize };
        shader.uniforms.scaleSoftness = { value: this.scaleSoftness };
        shader.uniforms.anisotropyStrength = { value: this.anisotropy };
        shader.uniforms.anisotropyRotation = { value: this.anisotropyRotation };
        shader.uniforms.membraneStrength = { value: this.membraneStrength };
        shader.uniforms.perScaleVariance = { value: this.perScaleVariance };
        shader.uniforms.scaleIridescence = { value: this.scaleIridescence };
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
                uniform int scaleBands;
                uniform float scaleQuantize;
                uniform float scaleSoftness;
                uniform float anisotropyStrength;
                uniform float anisotropyRotation;
                uniform float membraneStrength;
                uniform float perScaleVariance;
                uniform float scaleIridescence;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyScaleBands(vec3 baseColor) {
                    if (scaleBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(scaleBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * scaleSoftness;
                    float finalLum = mix(lum, softQuantized, scaleQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply scale cel banding
                gl_FragColor.rgb = applyScaleBands(gl_FragColor.rgb);

                // Overlapping scale-plate approximation:
                // Jittered Voronoi-scale cells with membrane crevices between scales
                {
                    vec2 scaleUV = vUv * 32.0;
                    vec2 scaleCell = floor(scaleUV);
                    vec2 scaleFrac = fract(scaleUV);
                    float scaleHash = fract(sin(dot(scaleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    // Offset cell centre for jitter
                    vec2 scaleCentre = vec2(scaleHash, fract(scaleHash * 7.31));
                    float scaleDist = length(scaleFrac - scaleCentre);
                    // Scale-tip dome
                    float scaleDome = pow(max(0.0, 1.0 - scaleDist * 2.0), 2.2);
                    // Per-scale variance
                    float scaleTint = 0.85 + fract(scaleHash * 13.7) * perScaleVariance;
                    gl_FragColor.rgb *= (1.0 + (scaleDome - 0.5) * perScaleVariance * scaleTint);
                    // Membrane crevice darkening
                    float membrane = smoothstep(0.35, 0.5, scaleDist) * membraneStrength;
                    gl_FragColor.rgb *= (1.0 - membrane * 0.5);
                }

                // Scale iridescence shimmer (structural-colour sheen)
                if (scaleIridescence > 0.0) {
                    float ndotvScale = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float shimmerMask = pow(1.0 - ndotvScale, 3.0) * scaleIridescence;
                    float hueShift = (1.0 - ndotvScale) * 0.35;
                    vec3 shimmerColor = mix(specularColor, vec3(1.0, 0.85, 0.65), hueShift);
                    gl_FragColor.rgb += shimmerColor * shimmerMask * 0.50;
                }

                // Warm rim glow on scale edges
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
            this.sheen, this.sheenRoughness,
            this.transmission, this.thickness, this.attenuationDistance,
            this.scaleBands, this.scaleQuantize, this.scaleSoftness,
            this.membraneStrength, this.perScaleVariance, this.scaleIridescence,
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
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.scaleBands = source.scaleBands;
        this.scaleQuantize = source.scaleQuantize;
        this.scaleSoftness = source.scaleSoftness;
        this.membraneStrength = source.membraneStrength;
        this.perScaleVariance = source.perScaleVariance;
        this.scaleIridescence = source.scaleIridescence;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicScaleMaterial';
        if (this.ior !== 1.548) data.ior = this.ior;
        if (this.specularIntensity !== 0.55) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.40) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.anisotropy !== 0.65) data.anisotropy = this.anisotropy;
        if (this.anisotropyRotation !== 0.0) data.anisotropyRotation = this.anisotropyRotation;
        if (this.iridescence !== 0.15) data.iridescence = this.iridescence;
        if (this.iridescenceIOR !== 1.55) data.iridescenceIOR = this.iridescenceIOR;
        if (this.sheen !== 0.25) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.55, 0.75, 0.42).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.55) data.sheenRoughness = this.sheenRoughness;
        if (this.transmission !== 0.02) data.transmission = this.transmission;
        if (this.thickness !== 0.003) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.03) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.30, 0.52, 0.28).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularColor.getHex() !== new Color(0.75, 0.88, 0.68).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.scaleBands !== 3) data.scaleBands = this.scaleBands;
        if (this.scaleQuantize !== 0.4) data.scaleQuantize = this.scaleQuantize;
        if (this.scaleSoftness !== 0.08) data.scaleSoftness = this.scaleSoftness;
        if (this.membraneStrength !== 0.30) data.membraneStrength = this.membraneStrength;
        if (this.perScaleVariance !== 0.12) data.perScaleVariance = this.perScaleVariance;
        if (this.scaleIridescence !== 0.15) data.scaleIridescence = this.scaleIridescence;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.55, 0.75, 0.42).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.scaleBands = json.scaleBands ?? this.scaleBands;
        this.scaleQuantize = json.scaleQuantize ?? this.scaleQuantize;
        this.scaleSoftness = json.scaleSoftness ?? this.scaleSoftness;
        this.membraneStrength = json.membraneStrength ?? this.membraneStrength;
        this.perScaleVariance = json.perScaleVariance ?? this.perScaleVariance;
        this.scaleIridescence = json.scaleIridescence ?? this.scaleIridescence;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicScaleMaterialBatchComponent = {
    materialPtr: 'ui32',
    scaleBands: 'ui8',
    scaleQuantize: 'f64',
    scaleSoftness: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    membraneStrength: 'f64',
    perScaleVariance: 'f64',
    scaleIridescence: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicScaleMaterial,
    OrganicScaleMaterialBatch,
    ScaleScratchPool,
    OrganicScaleMaterialBatchComponent,
    OrganicScalePresets,
    applyScaleCelBanding,
    gradeScaleColor,
    generateScalePatternTexture
};

export default OrganicScaleMaterial;