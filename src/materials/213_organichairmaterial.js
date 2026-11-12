// file number : 213
// full path name : src/materials/213_organichairmaterial.js
// description : OrganicHairMaterial — a ready-to-use hair/fur material for
//               real-time organic character rendering. Extends
//               MeshPhysicalMaterial with purpose-built presets for blonde,
//               brunette, black, red, and grey hair. Includes physically
//               grounded hair defaults (IOR ≈ 1.55, roughness 0.45, low
//               metalness) plus anisotropic specular and dual-lobe highlight
//               approximation for natural strand-based shine. Adds real-time
//               anime stylization: cel-banded hair highlights, dual-lobe shine
//               splitting, mood tinting, rim glow, paper-grain texture, and
//               per-instance variation. Includes a procedural strand-texture
//               generator producing directional anisotropy-flow maps and
//               per-strand colour jitter. All imports resolve to the internal
//               Threejs_gl repository tree; no CDN dependencies.
// best for : Organic hair, human/creature hair, fur, manes, beards, eyebrows,
//            stylized anime hair, groomed character hair, and any strand-based
//            organic fiber surface that needs real-time PBR + anime
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
// Hair presets — biologically grounded PBR parameter sets for hair tones.
//
// Reference values (from Omniverse, three.js hair shading guides, and
// community PBR hair references):
//   - Human hair IOR:       ≈ 1.55
//   - Hair roughness:       0.40–0.50 (0.45 nominal)
//   - Anisotropy strength:  0.55–0.75 for realistic directional shine
//   - Anisotropy rotation:  aligned with strand flow
//   - Dual-lobe specular:   primary lobe near-white, sharp, root-shifted;
//                           secondary lobe tinted by hair colour, broader,
//                           tip-shifted
//   - Metalness:            0.0 (hair is a dielectric)
// ---------------------------------------------------------------------------

const OrganicHairPresets = {
    'blonde': {
        color: [0.82, 0.68, 0.42],
        roughness: 0.44,
        metalness: 0.0,
        anisotropy: 0.65,
        anisotropyRotation: 0.0,
        specularIntensity: 0.55,
        specularColor: [0.95, 0.88, 0.72],
        transmission: 0.18,
        thickness: 0.008,
        attenuationDistance: 0.05,
        attenuationColor: [0.92, 0.75, 0.45],
        sheen: 0.35,
        sheenColor: [0.95, 0.85, 0.65],
        sheenRoughness: 0.55
    },
    'brunette': {
        color: [0.28, 0.18, 0.12],
        roughness: 0.45,
        metalness: 0.0,
        anisotropy: 0.68,
        anisotropyRotation: 0.0,
        specularIntensity: 0.55,
        specularColor: [0.88, 0.80, 0.72],
        transmission: 0.14,
        thickness: 0.008,
        attenuationDistance: 0.05,
        attenuationColor: [0.50, 0.28, 0.18],
        sheen: 0.30,
        sheenColor: [0.72, 0.58, 0.48],
        sheenRoughness: 0.55
    },
    'black': {
        color: [0.08, 0.07, 0.06],
        roughness: 0.46,
        metalness: 0.0,
        anisotropy: 0.70,
        anisotropyRotation: 0.0,
        specularIntensity: 0.50,
        specularColor: [0.85, 0.85, 0.88],
        transmission: 0.10,
        thickness: 0.008,
        attenuationDistance: 0.04,
        attenuationColor: [0.18, 0.12, 0.10],
        sheen: 0.28,
        sheenColor: [0.55, 0.55, 0.60],
        sheenRoughness: 0.60
    },
    'red': {
        color: [0.62, 0.28, 0.14],
        roughness: 0.43,
        metalness: 0.0,
        anisotropy: 0.66,
        anisotropyRotation: 0.0,
        specularIntensity: 0.56,
        specularColor: [0.95, 0.82, 0.72],
        transmission: 0.16,
        thickness: 0.008,
        attenuationDistance: 0.05,
        attenuationColor: [0.80, 0.32, 0.16],
        sheen: 0.32,
        sheenColor: [0.92, 0.62, 0.45],
        sheenRoughness: 0.55
    },
    'grey': {
        color: [0.68, 0.68, 0.70],
        roughness: 0.50,
        metalness: 0.0,
        anisotropy: 0.62,
        anisotropyRotation: 0.0,
        specularIntensity: 0.52,
        specularColor: [0.92, 0.92, 0.94],
        transmission: 0.12,
        thickness: 0.008,
        attenuationDistance: 0.05,
        attenuationColor: [0.72, 0.72, 0.74],
        sheen: 0.30,
        sheenColor: [0.82, 0.82, 0.85],
        sheenRoughness: 0.60
    },
    'platinum': {
        color: [0.90, 0.88, 0.82],
        roughness: 0.42,
        metalness: 0.0,
        anisotropy: 0.63,
        anisotropyRotation: 0.0,
        specularIntensity: 0.58,
        specularColor: [0.98, 0.96, 0.92],
        transmission: 0.20,
        thickness: 0.008,
        attenuationDistance: 0.06,
        attenuationColor: [0.95, 0.92, 0.85],
        sheen: 0.38,
        sheenColor: [0.98, 0.95, 0.90],
        sheenRoughness: 0.50
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable hair scratch records
// ---------------------------------------------------------------------------

class HairScratchPool {
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

const _hairScratchPool = new HairScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — hair-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded hair highlights. Hair has anisotropic, strand-aligned
 * specular streaks — quantizing them into discrete bands produces the crisp
 * anime hair shine seen in hand-drawn character illustrations.
 */
function applyHairCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.10) {
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
 * Apply mood-based tinting to hair. Warm moods push hair toward a warm
 * golden-amber, cool moods toward a cool ash-grey — matching the atmospheric
 * hair tinting seen in stylized anime scenes.
 */
function gradeHairColor(color, temperature, saturation, brightness, contrast) {
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

    // Hair-specific temperature bias: warm shift favours R and G more than B
    // (golden-amber), cool shift favours B more than R (ash-grey).
    r += temperature * 0.04;
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
 * Generate a procedural strand texture. The algorithm:
 * 1. Directional fBm: high-frequency noise stretched along the strand
 *    direction to simulate longitudinal fiber streaks.
 * 2. Per-strand hashed colour jitter: each virtual strand cell gets a small
 *    brightness/colour offset to break up uniformity.
 * 3. Cross-strand clump noise: low-frequency clumps that group strands into
 *    locks.
 * 4. Optional tip-fade: brightens tips for the classic hair-tip glow.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * anisotropy direction, or bump-map use.
 */
function generateStrandTexture(width, height, strandDirection = 0.0, scale = 0.02, octaves = 4, strandJitter = 0.15, clumpStrength = 0.2, tipFade = 0.0) {
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
                // Stretch along ry (across the strand) more than rx (along it)
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
            const strandCell = Math.floor(ry * 3.0);
            const strandHash = Math.abs(Math.sin(strandCell * 12.9898 + 5.0) * 43758.5453) % 1.0;
            const jitter = (strandHash - 0.5) * strandJitter;

            // --- 3. Cross-strand clump noise ---
            const clump = SimplexNoise.noise2D(rx * 0.01, ry * 0.05) * 0.5 + 0.5;
            const clumpMask = (clump - 0.5) * clumpStrength;

            // --- 4. Tip fade (brightens the far end) ---
            let tip = 0;
            if (tipFade > 0) {
                const t = Math.max(0, Math.min(1, (x / width)));
                tip = Math.pow(t, 2.0) * tipFade;
            }

            // --- Combine ---
            let value = 0.55
                + (fbm - 0.5) * 0.25
                + jitter
                + clumpMask
                + tip;

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

const _hairWorld = BitECS.createWorld();
const OrganicHairMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    hairBands: 'ui8',
    hairQuantize: 'f64',
    hairSoftness: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    dualLobeRatio: 'f64',
    secondaryLobeColorR: 'f64',
    secondaryLobeColorG: 'f64',
    secondaryLobeColorB: 'f64',
    tipGlowIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicHairMaterialBatch {
    constructor() {
        this.world = _hairWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicHairMaterialComponent, eid);
        OrganicHairMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicHairMaterialComponent.hairBands[eid] = material.hairBands;
        OrganicHairMaterialComponent.hairQuantize[eid] = material.hairQuantize;
        OrganicHairMaterialComponent.hairSoftness[eid] = material.hairSoftness;
        OrganicHairMaterialComponent.anisotropyStrength[eid] = material.anisotropy;
        OrganicHairMaterialComponent.anisotropyRotation[eid] = material.anisotropyRotation;
        OrganicHairMaterialComponent.dualLobeRatio[eid] = material.dualLobeRatio;
        OrganicHairMaterialComponent.secondaryLobeColorR[eid] = material.secondaryLobeColor.r;
        OrganicHairMaterialComponent.secondaryLobeColorG[eid] = material.secondaryLobeColor.g;
        OrganicHairMaterialComponent.secondaryLobeColorB[eid] = material.secondaryLobeColor.b;
        OrganicHairMaterialComponent.tipGlowIntensity[eid] = material.tipGlowIntensity;
        OrganicHairMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicHairMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicHairMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicHairMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicHairMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicHairMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicHairMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicHairMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.hairBands = OrganicHairMaterialComponent.hairBands[eid];
            material.hairQuantize = OrganicHairMaterialComponent.hairQuantize[eid];
            material.hairSoftness = OrganicHairMaterialComponent.hairSoftness[eid];
            material.anisotropy = OrganicHairMaterialComponent.anisotropyStrength[eid];
            material.anisotropyRotation = OrganicHairMaterialComponent.anisotropyRotation[eid];
            material.dualLobeRatio = OrganicHairMaterialComponent.dualLobeRatio[eid];
            material.secondaryLobeColor.setRGB(
                OrganicHairMaterialComponent.secondaryLobeColorR[eid],
                OrganicHairMaterialComponent.secondaryLobeColorG[eid],
                OrganicHairMaterialComponent.secondaryLobeColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.tipGlowIntensity = OrganicHairMaterialComponent.tipGlowIntensity[eid];
            material.moodTemperature = OrganicHairMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicHairMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicHairMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicHairMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicHairMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicHairMaterialComponent.variationSeed[eid];

            OrganicHairMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicHairMaterial class
// ---------------------------------------------------------------------------

class OrganicHairMaterial extends MeshPhysicalMaterial {
    static {
        _hairScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicHairMaterial = true;
        this.type = 'OrganicHairMaterial';

        // -------------------------------------------------------------------
        // Hair-specific PBR defaults (brunette baseline)
        // -------------------------------------------------------------------
        this.ior = 1.55;
        this.specularIntensity = 0.55;
        this.roughness = 0.45;
        this.metalness = 0.0;
        this.specularColor = new Color(0.88, 0.80, 0.72);
        this.color = new Color(0.28, 0.18, 0.12);

        // Anisotropy — critical for hair directional shine
        this.anisotropy = 0.68;
        this.anisotropyRotation = 0.0;

        // Thin-walled transmission for light-through-hair effects
        this.transmission = 0.14;
        this.thickness = 0.008;
        this.attenuationDistance = 0.05;
        this.attenuationColor = new Color(0.50, 0.28, 0.18);

        // Sheen for the soft secondary glow at grazing angles
        this.sheen = 0.30;
        this.sheenColor = new Color(0.72, 0.58, 0.48);
        this.sheenRoughness = 0.55;

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — hair-specific
        // -------------------------------------------------------------------
        this.hairBands = 3;
        this.hairQuantize = 0.5;
        this.hairSoftness = 0.10;

        // Dual-lobe specular approximation
        this.dualLobeRatio = 0.5;        // 0 = secondary only, 1 = primary only
        this.secondaryLobeColor = new Color(0.50, 0.28, 0.18); // tinted by hair color
        this.primaryLobeShift = 0.0;      // -1 root-shift, +1 tip-shift
        this.secondaryLobeShift = 0.0;    // -1 root-shift, +1 tip-shift

        // Tip glow — classic anime hair-tip brightening
        this.tipGlowIntensity = 0.15;
        this.tipGlowColor = new Color(1.0, 0.95, 0.80);

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.15;
        this.rimGlowColor = new Color(1.0, 0.85, 0.65);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (hair leans semi-realistic)
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

    applyHairBanding(baseColor, output) {
        return applyHairCelBanding(
            baseColor,
            output,
            this.hairBands,
            this.hairQuantize,
            this.hairSoftness
        );
    }

    updateMoodColor() {
        gradeHairColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic hair preset to this material.
     * @param {string} presetName - One of the keys of `OrganicHairPresets`.
     * @returns {OrganicHairMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicHairPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.anisotropy = preset.anisotropy;
        this.anisotropyRotation = preset.anisotropyRotation;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.transmission = preset.transmission;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;

        // Secondary lobe inherits the hair color (tinted)
        this.secondaryLobeColor.copy(this.color);

        // Adjust anime band softness: darker hair = crisper bands
        if (presetName === 'black') {
            this.hairSoftness = 0.06;
            this.hairBands = 3;
        } else if (presetName === 'blonde' || presetName === 'platinum') {
            this.hairSoftness = 0.14;
            this.hairBands = 3;
        } else {
            this.hairSoftness = 0.10;
            this.hairBands = 3;
        }

        this.updateMoodColor();
        return this;
    }

    generateStrandTexture(width, height, strandDirection = 0.0, scale = 0.02, octaves = 4, strandJitter = 0.15, clumpStrength = 0.2) {
        return generateStrandTexture(width, height, strandDirection, scale, octaves, strandJitter, clumpStrength, 0.0);
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

        shader.uniforms.hairBands = { value: this.hairBands };
        shader.uniforms.hairQuantize = { value: this.hairQuantize };
        shader.uniforms.hairSoftness = { value: this.hairSoftness };
        shader.uniforms.anisotropyStrength = { value: this.anisotropy };
        shader.uniforms.anisotropyRotation = { value: this.anisotropyRotation };
        shader.uniforms.dualLobeRatio = { value: this.dualLobeRatio };
        shader.uniforms.secondaryLobeColor = { value: this.secondaryLobeColor };
        shader.uniforms.primaryLobeShift = { value: this.primaryLobeShift };
        shader.uniforms.secondaryLobeShift = { value: this.secondaryLobeShift };
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
                uniform int hairBands;
                uniform float hairQuantize;
                uniform float hairSoftness;
                uniform float anisotropyStrength;
                uniform float anisotropyRotation;
                uniform float dualLobeRatio;
                uniform vec3 secondaryLobeColor;
                uniform float primaryLobeShift;
                uniform float secondaryLobeShift;
                uniform float tipGlowIntensity;
                uniform vec3 tipGlowColor;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyHairBands(vec3 baseColor) {
                    if (hairBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(hairBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * hairSoftness;
                    float finalLum = mix(lum, softQuantized, hairQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply hair cel banding
                gl_FragColor.rgb = applyHairBands(gl_FragColor.rgb);

                // Dual-lobe specular approximation (primary + secondary)
                // Primary lobe = near-white, sharper, root-shifted (subtle)
                // Secondary lobe = tinted by hair color, broader, tip-shifted
                {
                    vec3 viewDirHair = normalize(vViewPosition);
                    vec3 normalHair = normalize(vNormal);
                    float ndotvHair = abs(dot(normalHair, viewDirHair));

                    // Primary lobe — near-white sharp
                    float primarySpec = pow(1.0 - ndotvHair, 8.0) * specularIntensity * 1.2;

                    // Secondary lobe — hair-color tinted, broader
                    float secondarySpec = pow(1.0 - ndotvHair, 3.0) * specularIntensity * 0.6;

                    // Blend by dual-lobe ratio
                    vec3 primaryColor = vec3(1.0);
                    vec3 lobeBlend = mix(secondaryLobeColor * secondarySpec, primaryColor * primarySpec, dualLobeRatio);
                    gl_FragColor.rgb += lobeBlend;
                }

                // Tip glow — brighten tips for classic anime hair shine
                if (tipGlowIntensity > 0.0) {
                    float tipMask = smoothstep(0.6, 1.0, vUv.y);
                    gl_FragColor.rgb += tipGlowColor * tipMask * tipGlowIntensity;
                }

                // Warm rim glow on hair edges
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
            this.transmission, this.thickness, this.attenuationDistance,
            this.sheen, this.sheenRoughness,
            this.hairBands, this.hairQuantize, this.hairSoftness,
            this.dualLobeRatio, this.primaryLobeShift, this.secondaryLobeShift,
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
        this.anisotropy = source.anisotropy;
        this.anisotropyRotation = source.anisotropyRotation;
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.hairBands = source.hairBands;
        this.hairQuantize = source.hairQuantize;
        this.hairSoftness = source.hairSoftness;
        this.dualLobeRatio = source.dualLobeRatio;
        this.secondaryLobeColor.copy(source.secondaryLobeColor);
        this.primaryLobeShift = source.primaryLobeShift;
        this.secondaryLobeShift = source.secondaryLobeShift;
        this.tipGlowIntensity = source.tipGlowIntensity;
        this.tipGlowColor.copy(source.tipGlowColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicHairMaterial';
        if (this.ior !== 1.55) data.ior = this.ior;
        if (this.specularIntensity !== 0.55) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.45) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.anisotropy !== 0.68) data.anisotropy = this.anisotropy;
        if (this.anisotropyRotation !== 0.0) data.anisotropyRotation = this.anisotropyRotation;
        if (this.transmission !== 0.14) data.transmission = this.transmission;
        if (this.thickness !== 0.008) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.05) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.50, 0.28, 0.18).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.30) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.72, 0.58, 0.48).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.55) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.88, 0.80, 0.72).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.hairBands !== 3) data.hairBands = this.hairBands;
        if (this.hairQuantize !== 0.5) data.hairQuantize = this.hairQuantize;
        if (this.hairSoftness !== 0.10) data.hairSoftness = this.hairSoftness;
        if (this.dualLobeRatio !== 0.5) data.dualLobeRatio = this.dualLobeRatio;
        if (this.secondaryLobeColor.getHex() !== new Color(0.50, 0.28, 0.18).getHex()) data.secondaryLobeColor = this.secondaryLobeColor.getHex();
        if (this.tipGlowIntensity !== 0.15) data.tipGlowIntensity = this.tipGlowIntensity;
        if (this.tipGlowColor.getHex() !== new Color(1.0, 0.95, 0.80).getHex()) data.tipGlowColor = this.tipGlowColor.getHex();
        if (this.rimGlow !== 0.15) data.rimGlow = this.rimGlow;
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
        this.anisotropy = json.anisotropy ?? this.anisotropy;
        this.anisotropyRotation = json.anisotropyRotation ?? this.anisotropyRotation;
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.hairBands = json.hairBands ?? this.hairBands;
        this.hairQuantize = json.hairQuantize ?? this.hairQuantize;
        this.hairSoftness = json.hairSoftness ?? this.hairSoftness;
        this.dualLobeRatio = json.dualLobeRatio ?? this.dualLobeRatio;
        if (json.secondaryLobeColor !== undefined) this.secondaryLobeColor.setHex(json.secondaryLobeColor);
        this.primaryLobeShift = json.primaryLobeShift ?? this.primaryLobeShift;
        this.secondaryLobeShift = json.secondaryLobeShift ?? this.secondaryLobeShift;
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

const OrganicHairMaterialBatchComponent = {
    materialPtr: 'ui32',
    hairBands: 'ui8',
    hairQuantize: 'f64',
    hairSoftness: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    dualLobeRatio: 'f64',
    secondaryLobeColorR: 'f64',
    secondaryLobeColorG: 'f64',
    secondaryLobeColorB: 'f64',
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
    OrganicHairMaterial,
    OrganicHairMaterialBatch,
    HairScratchPool,
    OrganicHairMaterialBatchComponent,
    OrganicHairPresets,
    applyHairCelBanding,
    gradeHairColor,
    generateStrandTexture
};

export default OrganicHairMaterial;