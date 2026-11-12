// file number : 224
// full path name : src/materials/224_organicfeathermaterial.js
// description : OrganicFeatherMaterial — a ready-to-use feather material for
//               feathers, plumage, down, and bird feather surfaces. Extends
//               MeshPhysicalMaterial with purpose-built presets for white swan,
//               peacock iridescent, eagle brown, raven black, parrot red, and
//               downy feather. Includes feather-appropriate PBR defaults
//               (keratin IOR ≈ 1.54, roughness ≈ 0.40, zero metalness,
//               anisotropic specular along the barbs, and a sheen lobe for the
//               soft feathered edge) plus real-time anime stylization:
//               cel-banded feather highlights, barb-rachis approximation, mood
//               tinting, rim glow, and per-instance variation. Includes a
//               procedural feather-barb texture generator using directional
//               fBm with rachis-axis stretching and per-barb hashing.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Organic feathers, plumage, down, bird feathers, swan feathers,
//            peacock feathers, eagle feathers, raven feathers, parrot
//            feathers, downy feather, costume feathers, fantasy feather
//            accessories, and any feather surface that needs real-time PBR +
//            anime stylization.
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
// Feather presets — biologically grounded PBR parameter sets for feather
// types.
//
// Reference values (from feather PBR references, cgaxis feather texture packs,
// and ornithology literature):
//   - Feather keratin IOR:  ≈ 1.54
//   - Feather roughness:    0.35–0.50
//   - Metalness:            0.0 (feather is a dielectric)
//   - Anisotropy:           0.5–0.85 along barb direction
//   - Sheen:                0.15–0.35 for soft feather edges
//   - Iridescence:          strong for peacock (0.7–0.9)
// ---------------------------------------------------------------------------

const OrganicFeatherPresets = {
    'white-swan': {
        color: [0.96, 0.94, 0.90],
        roughness: 0.42,
        metalness: 0.0,
        anisotropy: 0.55,
        anisotropyRotation: 0.0,
        iridescence: 0.10,
        iridescenceIOR: 1.54,
        iridescenceThicknessRange: [200, 500],
        specularIntensity: 0.45,
        specularColor: [0.98, 0.96, 0.92],
        sheen: 0.28,
        sheenColor: [0.98, 0.96, 0.92],
        sheenRoughness: 0.60,
        transmission: 0.06,
        thickness: 0.002,
        attenuationDistance: 0.04,
        attenuationColor: [0.98, 0.96, 0.92]
    },
    'peacock-iridescent': {
        color: [0.12, 0.34, 0.42],
        roughness: 0.30,
        metalness: 0.0,
        anisotropy: 0.75,
        anisotropyRotation: 0.0,
        iridescence: 0.85,
        iridescenceIOR: 1.60,
        iridescenceThicknessRange: [300, 800],
        specularIntensity: 0.70,
        specularColor: [0.55, 0.90, 0.95],
        sheen: 0.35,
        sheenColor: [0.42, 0.82, 0.88],
        sheenRoughness: 0.45,
        transmission: 0.08,
        thickness: 0.002,
        attenuationDistance: 0.04,
        attenuationColor: [0.18, 0.42, 0.50]
    },
    'eagle-brown': {
        color: [0.42, 0.28, 0.16],
        roughness: 0.46,
        metalness: 0.0,
        anisotropy: 0.60,
        anisotropyRotation: 0.0,
        iridescence: 0.05,
        iridescenceIOR: 1.54,
        iridescenceThicknessRange: [200, 500],
        specularIntensity: 0.42,
        specularColor: [0.85, 0.72, 0.58],
        sheen: 0.22,
        sheenColor: [0.72, 0.55, 0.38],
        sheenRoughness: 0.60,
        transmission: 0.04,
        thickness: 0.002,
        attenuationDistance: 0.04,
        attenuationColor: [0.52, 0.34, 0.18]
    },
    'raven-black': {
        color: [0.04, 0.04, 0.06],
        roughness: 0.28,
        metalness: 0.0,
        anisotropy: 0.85,
        anisotropyRotation: 0.0,
        iridescence: 0.55,
        iridescenceIOR: 1.58,
        iridescenceThicknessRange: [280, 700],
        specularIntensity: 0.75,
        specularColor: [0.65, 0.70, 0.90],
        sheen: 0.30,
        sheenColor: [0.35, 0.42, 0.62],
        sheenRoughness: 0.45,
        transmission: 0.03,
        thickness: 0.002,
        attenuationDistance: 0.04,
        attenuationColor: [0.08, 0.08, 0.14]
    },
    'parrot-red': {
        color: [0.78, 0.14, 0.10],
        roughness: 0.36,
        metalness: 0.0,
        anisotropy: 0.65,
        anisotropyRotation: 0.0,
        iridescence: 0.25,
        iridescenceIOR: 1.56,
        iridescenceThicknessRange: [220, 580],
        specularIntensity: 0.55,
        specularColor: [0.98, 0.72, 0.60],
        sheen: 0.28,
        sheenColor: [0.92, 0.48, 0.35],
        sheenRoughness: 0.55,
        transmission: 0.05,
        thickness: 0.002,
        attenuationDistance: 0.04,
        attenuationColor: [0.82, 0.22, 0.14]
    },
    'downy': {
        color: [0.90, 0.88, 0.84],
        roughness: 0.55,
        metalness: 0.0,
        anisotropy: 0.30,
        anisotropyRotation: 0.0,
        iridescence: 0.0,
        iridescenceIOR: 1.54,
        iridescenceThicknessRange: [200, 500],
        specularIntensity: 0.30,
        specularColor: [0.92, 0.90, 0.88],
        sheen: 0.45,
        sheenColor: [0.96, 0.94, 0.90],
        sheenRoughness: 0.65,
        transmission: 0.08,
        thickness: 0.002,
        attenuationDistance: 0.04,
        attenuationColor: [0.94, 0.92, 0.88]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable feather scratch records
// ---------------------------------------------------------------------------

class FeatherScratchPool {
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

const _featherScratchPool = new FeatherScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — feather-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded feather highlights. Feathers have directional specular
 * streaks along the barbs — quantizing them into discrete bands produces the
 * crisp anime feather shine seen in hand-drawn bird illustrations.
 */
function applyFeatherCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.10) {
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
 * Apply mood-based tinting to feathers. Warm moods push feathers toward warm
 * amber/gold, cool moods toward cool blue-grey — matching the atmospheric
 * feather tinting seen in stylized bird and fantasy scenes.
 */
function gradeFeatherColor(color, temperature, saturation, brightness, contrast) {
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

    // Feather-specific temperature bias: warm shift pushes toward amber/gold,
    // cool shift pushes toward blue-grey.
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
 * Generate a procedural feather-barb texture. The algorithm:
 * 1. Rachis-axis direction: compute the distance from the rachis (central
 *    shaft) along the v-axis (or u-axis depending on orientation).
 * 2. Barb pattern: fine directional stripes along the rachis direction,
 *    modulated by a per-barb hashing.
 * 3. Barbule noise: high-frequency noise across the barbs for the fine
 *    barbule structure.
 * 4. Multi-octave fBm for the overall feather base tone.
 * 5. Optional vane-edge fading to simulate the soft feathered edge.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * anisotropy direction, or bump-map use.
 */
function generateFeatherBarbTexture(width, height, barbDensity = 160.0, barbStrength = 0.35, barbuleStrength = 0.15, rachisWidth = 0.03, vaneFadeStrength = 0.25) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Normalized UV
            const u = x / width;
            const v = y / height;

            // Distance from rachis (rachis along the v-axis at u = 0.5)
            const rachisDist = Math.abs(u - 0.5);

            // --- 1. Rachis core ---
            const rachisMask = 1.0 - Math.min(1.0, rachisDist / rachisWidth);

            // --- 2. Barb pattern (directional stripes across the feather) ---
            // The barbs run perpendicular to the rachis, so the stripe pattern
            // is stretched along v and compressed along u.
            const barbPhase = (u * barbDensity) % 1.0;
            const barbNormalized = Math.abs(barbPhase - 0.5) * 2.0;
            const barbMask = (1.0 - Math.pow(barbNormalized, 1.5)) * barbStrength;

            // --- 3. Per-barb hashing ---
            const barbIndex = Math.floor(u * barbDensity);
            const barbHash = Math.abs(Math.sin(barbIndex * 12.9898) * 43758.5453) % 1.0;
            const barbTint = 0.85 + barbHash * 0.15;

            // --- 4. Barbule noise (fine cross-barb structure) ---
            const barbule = SimplexNoise.noise2D(u * 800.0, v * 30.0) * barbuleStrength;

            // --- 5. Multi-octave fBm base tone ---
            let fbm = 0;
            let amplitude = 1;
            let frequency = 0.03;
            let maxAmplitude = 0;
            for (let o = 0; o < 4; o++) {
                fbm += SimplexNoise.noise2D(x * frequency, y * frequency) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;

            // --- 6. Vane-edge fading (soft feather edge) ---
            const edgeFade = Math.max(0, 1.0 - rachisDist / 0.5) * vaneFadeStrength;

            // --- Combine ---
            let value = 0.50
                + rachisMask * 0.30
                + barbMask * barbTint
                + barbule
                + (fbm - 0.5) * 0.15
                + edgeFade * 0.10;

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

const _featherWorld = BitECS.createWorld();
const OrganicFeatherMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    featherBands: 'ui8',
    featherQuantize: 'f64',
    featherSoftness: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    barbStrength: 'f64',
    barbDensity: 'f64',
    vaneFadeStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicFeatherMaterialBatch {
    constructor() {
        this.world = _featherWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicFeatherMaterialComponent, eid);
        OrganicFeatherMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicFeatherMaterialComponent.featherBands[eid] = material.featherBands;
        OrganicFeatherMaterialComponent.featherQuantize[eid] = material.featherQuantize;
        OrganicFeatherMaterialComponent.featherSoftness[eid] = material.featherSoftness;
        OrganicFeatherMaterialComponent.anisotropyStrength[eid] = material.anisotropy;
        OrganicFeatherMaterialComponent.anisotropyRotation[eid] = material.anisotropyRotation;
        OrganicFeatherMaterialComponent.barbStrength[eid] = material.barbStrength;
        OrganicFeatherMaterialComponent.barbDensity[eid] = material.barbDensity;
        OrganicFeatherMaterialComponent.vaneFadeStrength[eid] = material.vaneFadeStrength;
        OrganicFeatherMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicFeatherMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicFeatherMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicFeatherMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicFeatherMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicFeatherMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicFeatherMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicFeatherMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.featherBands = OrganicFeatherMaterialComponent.featherBands[eid];
            material.featherQuantize = OrganicFeatherMaterialComponent.featherQuantize[eid];
            material.featherSoftness = OrganicFeatherMaterialComponent.featherSoftness[eid];
            material.anisotropy = OrganicFeatherMaterialComponent.anisotropyStrength[eid];
            material.anisotropyRotation = OrganicFeatherMaterialComponent.anisotropyRotation[eid];
            material.barbStrength = OrganicFeatherMaterialComponent.barbStrength[eid];
            material.barbDensity = OrganicFeatherMaterialComponent.barbDensity[eid];
            material.vaneFadeStrength = OrganicFeatherMaterialComponent.vaneFadeStrength[eid];
            material.moodTemperature = OrganicFeatherMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicFeatherMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicFeatherMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicFeatherMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicFeatherMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicFeatherMaterialComponent.variationSeed[eid];

            OrganicFeatherMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicFeatherMaterial class
// ---------------------------------------------------------------------------

class OrganicFeatherMaterial extends MeshPhysicalMaterial {
    static {
        _featherScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicFeatherMaterial = true;
        this.type = 'OrganicFeatherMaterial';

        // -------------------------------------------------------------------
        // Feather-specific PBR defaults (white swan baseline)
        // -------------------------------------------------------------------
        this.ior = 1.54;
        this.specularIntensity = 0.45;
        this.roughness = 0.42;
        this.metalness = 0.0;
        this.specularColor = new Color(0.98, 0.96, 0.92);
        this.color = new Color(0.96, 0.94, 0.90);

        // Anisotropy along the barbs
        this.anisotropy = 0.55;
        this.anisotropyRotation = 0.0;

        // Sheen for the soft feather edge
        this.sheen = 0.28;
        this.sheenColor = new Color(0.98, 0.96, 0.92);
        this.sheenRoughness = 0.60;

        // Iridescence for peacock-style shimmer (off by default)
        this.iridescence = 0.10;
        this.iridescenceIOR = 1.54;
        this.iridescenceThicknessRange = [200, 500];

        // Thin-walled transmission for the light feather translucency
        this.transmission = 0.06;
        this.thickness = 0.002;
        this.attenuationDistance = 0.04;
        this.attenuationColor = new Color(0.98, 0.96, 0.92);

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — feather-specific
        // -------------------------------------------------------------------
        this.featherBands = 3;
        this.featherQuantize = 0.4;
        this.featherSoftness = 0.10;

        // Barb-rachis approximation
        this.barbStrength = 0.35;
        this.barbDensity = 160.0;
        this.vaneFadeStrength = 0.25;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.98, 0.96, 0.92);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (feather leans semi-realistic)
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

    applyFeatherBanding(baseColor, output) {
        return applyFeatherCelBanding(
            baseColor,
            output,
            this.featherBands,
            this.featherQuantize,
            this.featherSoftness
        );
    }

    updateMoodColor() {
        gradeFeatherColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic feather preset to this material.
     * @param {string} presetName - One of the keys of `OrganicFeatherPresets`.
     * @returns {OrganicFeatherMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicFeatherPresets[presetName];
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
        if (presetName === 'raven-black' || presetName === 'peacock-iridescent') {
            this.featherSoftness = 0.05;
            this.featherBands = 4;
        } else if (presetName === 'downy') {
            this.featherSoftness = 0.25;
            this.featherBands = 2;
        } else {
            this.featherSoftness = 0.10;
            this.featherBands = 3;
        }

        this.updateMoodColor();
        return this;
    }

    generateFeatherBarbTexture(width, height, barbDensity = 160.0, barbStrength = 0.35, barbuleStrength = 0.15, rachisWidth = 0.03, vaneFadeStrength = 0.25) {
        return generateFeatherBarbTexture(width, height, barbDensity, barbStrength, barbuleStrength, rachisWidth, vaneFadeStrength);
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

        shader.uniforms.featherBands = { value: this.featherBands };
        shader.uniforms.featherQuantize = { value: this.featherQuantize };
        shader.uniforms.featherSoftness = { value: this.featherSoftness };
        shader.uniforms.anisotropyStrength = { value: this.anisotropy };
        shader.uniforms.anisotropyRotation = { value: this.anisotropyRotation };
        shader.uniforms.barbStrength = { value: this.barbStrength };
        shader.uniforms.barbDensity = { value: this.barbDensity };
        shader.uniforms.vaneFadeStrength = { value: this.vaneFadeStrength };
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
                uniform int featherBands;
                uniform float featherQuantize;
                uniform float featherSoftness;
                uniform float anisotropyStrength;
                uniform float anisotropyRotation;
                uniform float barbStrength;
                uniform float barbDensity;
                uniform float vaneFadeStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyFeatherBands(vec3 baseColor) {
                    if (featherBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(featherBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * featherSoftness;
                    float finalLum = mix(lum, softQuantized, featherQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply feather cel banding
                gl_FragColor.rgb = applyFeatherBands(gl_FragColor.rgb);

                // Barb-rachis approximation:
                // 1. Darken the rachis (central shaft) using a UV-distance mask
                // 2. Add directional barb stripes using sin-based pattern
                {
                    // Rachis: a vertical band at u = 0.5
                    float rachisDist = abs(vUv.x - 0.5);
                    float rachisMask = 1.0 - smoothstep(0.0, 0.03, rachisDist);
                    gl_FragColor.rgb *= (1.0 - rachisMask * 0.35);

                    // Barbs: directional stripes across the feather
                    float barbPhase = fract(vUv.x * barbDensity);
                    float barbMask = 1.0 - abs(barbPhase - 0.5) * 2.0;
                    barbMask = pow(barbMask, 1.5) * barbStrength;
                    gl_FragColor.rgb *= (1.0 - barbMask * 0.10);

                    // Vane-edge fading
                    float vaneMask = smoothstep(0.0, 0.5, rachisDist);
                    gl_FragColor.a *= mix(1.0, 1.0 - vaneFadeStrength * 0.3, vaneMask);
                }

                // Iridescent shimmer (peacock, raven) at grazing angles
                if (iridescence > 0.0) {
                    float ndotvFeather = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float shimmerMask = pow(1.0 - ndotvFeather, 3.0) * iridescence;
                    // Hue shift for iridescent film effect
                    float hueShift = (1.0 - ndotvFeather) * 0.30;
                    vec3 shimmerColor = mix(specularColor, vec3(1.0, 0.85, 0.65), hueShift);
                    gl_FragColor.rgb += shimmerColor * shimmerMask * 0.45;
                }

                // Warm rim glow on feather edges
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
            this.featherBands, this.featherQuantize, this.featherSoftness,
            this.barbStrength, this.barbDensity, this.vaneFadeStrength,
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
        this.featherBands = source.featherBands;
        this.featherQuantize = source.featherQuantize;
        this.featherSoftness = source.featherSoftness;
        this.barbStrength = source.barbStrength;
        this.barbDensity = source.barbDensity;
        this.vaneFadeStrength = source.vaneFadeStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicFeatherMaterial';
        if (this.ior !== 1.54) data.ior = this.ior;
        if (this.specularIntensity !== 0.45) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.42) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.anisotropy !== 0.55) data.anisotropy = this.anisotropy;
        if (this.anisotropyRotation !== 0.0) data.anisotropyRotation = this.anisotropyRotation;
        if (this.iridescence !== 0.10) data.iridescence = this.iridescence;
        if (this.iridescenceIOR !== 1.54) data.iridescenceIOR = this.iridescenceIOR;
        if (this.sheen !== 0.28) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.98, 0.96, 0.92).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.60) data.sheenRoughness = this.sheenRoughness;
        if (this.transmission !== 0.06) data.transmission = this.transmission;
        if (this.thickness !== 0.002) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.04) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.98, 0.96, 0.92).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularColor.getHex() !== new Color(0.98, 0.96, 0.92).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.featherBands !== 3) data.featherBands = this.featherBands;
        if (this.featherQuantize !== 0.4) data.featherQuantize = this.featherQuantize;
        if (this.featherSoftness !== 0.10) data.featherSoftness = this.featherSoftness;
        if (this.barbStrength !== 0.35) data.barbStrength = this.barbStrength;
        if (this.barbDensity !== 160.0) data.barbDensity = this.barbDensity;
        if (this.vaneFadeStrength !== 0.25) data.vaneFadeStrength = this.vaneFadeStrength;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.98, 0.96, 0.92).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.featherBands = json.featherBands ?? this.featherBands;
        this.featherQuantize = json.featherQuantize ?? this.featherQuantize;
        this.featherSoftness = json.featherSoftness ?? this.featherSoftness;
        this.barbStrength = json.barbStrength ?? this.barbStrength;
        this.barbDensity = json.barbDensity ?? this.barbDensity;
        this.vaneFadeStrength = json.vaneFadeStrength ?? this.vaneFadeStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicFeatherMaterialBatchComponent = {
    materialPtr: 'ui32',
    featherBands: 'ui8',
    featherQuantize: 'f64',
    featherSoftness: 'f64',
    anisotropyStrength: 'f64',
    anisotropyRotation: 'f64',
    barbStrength: 'f64',
    barbDensity: 'f64',
    vaneFadeStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicFeatherMaterial,
    OrganicFeatherMaterialBatch,
    FeatherScratchPool,
    OrganicFeatherMaterialBatchComponent,
    OrganicFeatherPresets,
    applyFeatherCelBanding,
    gradeFeatherColor,
    generateFeatherBarbTexture
};

export default OrganicFeatherMaterial;