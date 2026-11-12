// file number : 214
// full path name : src/materials/214_organiceyematerial.js
// description : OrganicEyeMaterial — a ready-to-use eye material for real-time
//               organic character rendering. Extends MeshPhysicalMaterial with
//               purpose-built presets for blue, green, brown, hazel, amber, and
//               grey eyes. Includes physically grounded eye defaults covering
//               the three anatomical layers (cornea ≈ IOR 1.376, iris
//               roughness ≈ 0.35, sclera roughness ≈ 0.55) plus a corneal
//               clearcoat for wetness. Anime extensions cover cel-banded iris
//               highlights, dual-layer iris approximation (radial fibre layer
//               + collarette ring), pupil-dilation control, iris-parallax
//               approximation, mood tinting, rim glow, and per-instance
//               variation. Includes a procedural iris-fibre texture generator
//               using radial polar fBm with collarette ring and crypt detail.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Organic eyes, human/creature eyes, character close-ups, portrait
//            renders, stylized anime eyes, animal eyes, and any eye surface
//            that needs real-time PBR + anime stylization.
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
// Eye presets — biologically grounded PBR parameter sets for eye tones.
//
// Reference values (from Pixar eye shaders, three.js community eye material
// references, and ophthalmic literature):
//   - Cornea IOR:          1.376
//   - Lens IOR:            1.42
//   - Iris roughness:      0.30–0.40 (0.35 nominal)
//   - Sclera roughness:    0.50–0.60 (0.55 nominal)
//   - Cornea clearcoat:    1.0 (fully wet)
//   - Pupil:               near-black albedo, very low roughness (glossy)
//   - Metalness:           0.0 (eye is a dielectric)
// ---------------------------------------------------------------------------

const OrganicEyePresets = {
    'blue': {
        irisColor: [0.18, 0.42, 0.72],
        irisRoughness: 0.35,
        irisSecondaryColor: [0.35, 0.65, 0.90],
        scleraColor: [0.94, 0.92, 0.90],
        scleraRoughness: 0.55,
        corneaClearcoat: 1.0,
        corneaRoughness: 0.02,
        pupilColor: [0.01, 0.01, 0.02],
        pupilSize: 0.35
    },
    'green': {
        irisColor: [0.22, 0.52, 0.28],
        irisRoughness: 0.36,
        irisSecondaryColor: [0.48, 0.68, 0.32],
        scleraColor: [0.94, 0.92, 0.90],
        scleraRoughness: 0.55,
        corneaClearcoat: 1.0,
        corneaRoughness: 0.02,
        pupilColor: [0.01, 0.01, 0.02],
        pupilSize: 0.35
    },
    'brown': {
        irisColor: [0.42, 0.22, 0.10],
        irisRoughness: 0.34,
        irisSecondaryColor: [0.68, 0.44, 0.22],
        scleraColor: [0.94, 0.92, 0.90],
        scleraRoughness: 0.55,
        corneaClearcoat: 1.0,
        corneaRoughness: 0.02,
        pupilColor: [0.01, 0.01, 0.02],
        pupilSize: 0.35
    },
    'hazel': {
        irisColor: [0.48, 0.34, 0.12],
        irisRoughness: 0.35,
        irisSecondaryColor: [0.62, 0.52, 0.22],
        scleraColor: [0.94, 0.92, 0.90],
        scleraRoughness: 0.55,
        corneaClearcoat: 1.0,
        corneaRoughness: 0.02,
        pupilColor: [0.01, 0.01, 0.02],
        pupilSize: 0.35
    },
    'amber': {
        irisColor: [0.78, 0.42, 0.10],
        irisRoughness: 0.33,
        irisSecondaryColor: [0.92, 0.62, 0.22],
        scleraColor: [0.94, 0.92, 0.90],
        scleraRoughness: 0.55,
        corneaClearcoat: 1.0,
        corneaRoughness: 0.02,
        pupilColor: [0.01, 0.01, 0.02],
        pupilSize: 0.35
    },
    'grey': {
        irisColor: [0.42, 0.44, 0.46],
        irisRoughness: 0.36,
        irisSecondaryColor: [0.62, 0.65, 0.68],
        scleraColor: [0.94, 0.92, 0.90],
        scleraRoughness: 0.55,
        corneaClearcoat: 1.0,
        corneaRoughness: 0.02,
        pupilColor: [0.01, 0.01, 0.02],
        pupilSize: 0.35
    },
    'anime-crimson': {
        irisColor: [0.72, 0.14, 0.16],
        irisRoughness: 0.28,
        irisSecondaryColor: [0.92, 0.35, 0.32],
        scleraColor: [0.96, 0.94, 0.92],
        scleraRoughness: 0.50,
        corneaClearcoat: 1.0,
        corneaRoughness: 0.01,
        pupilColor: [0.02, 0.00, 0.02],
        pupilSize: 0.40
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable eye scratch records
// ---------------------------------------------------------------------------

class EyeScratchPool {
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

const _eyeScratchPool = new EyeScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — eye-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded iris highlights. The iris has fine radial fibre detail
 * which quantizes into discrete anime-style bands — producing the crisp
 * flat iris shine seen in hand-drawn anime eyes.
 */
function applyEyeCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.08) {
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
 * Apply mood-based tinting to iris color. Warm moods push iris toward a
 * warmer amber hue, cool moods toward a cooler blue-grey — matching the
 * atmospheric iris tinting seen in stylized anime portraits.
 */
function gradeEyeColor(color, temperature, saturation, brightness, contrast) {
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

    // Iris-specific temperature bias: warm shift pushes toward amber,
    // cool shift pushes toward cyan-blue.
    r += temperature * 0.05;
    g += temperature * 0.02;
    b -= temperature * 0.05;

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
 * Generate a procedural iris-fibre texture. The algorithm works in polar
 * coordinates around the pupil centre:
 * 1. Compute r (radial distance 0–1) and θ (angle) for each pixel.
 * 2. Radial fibre layer: 1D noise sampled along θ, stretched radially, to
 *    produce radial striations from the pupil to the limbus.
 * 3. Collarette ring: a bright annulus at r ≈ 0.3–0.4 (the anatomical
 *    "collarette") built with a smooth band function.
 * 4. Crypt detail: high-frequency per-angle hash producing irregular dark
 *    pits (Fuchs' crypts) that break up the fibres.
 * 5. Pupil mask: radial darkening inside r < pupilSize.
 * 6. Limbus ring: dark ring at r ≈ 0.95–1.0 (the outer iris boundary).
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateIrisTexture(width, height, fibreDensity = 120.0, fibreStrength = 0.35, collaretteWidth = 0.08, cryptStrength = 0.25, pupilSize = 0.35, limbusWidth = 0.05) {
    const out = new Uint8Array(width * height * 4);

    const cx = width * 0.5;
    const cy = height * 0.5;
    const maxRadius = Math.min(width, height) * 0.5;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Polar coordinates
            const dx = (x - cx) / maxRadius;
            const dy = (y - cy) / maxRadius;
            const r = Math.sqrt(dx * dx + dy * dy);
            const theta = Math.atan2(dy, dx);

            // Out-of-iris pixels → neutral background
            if (r > 1.05) {
                out[p] = 128;
                out[p + 1] = 128;
                out[p + 2] = 128;
                out[p + 3] = 255;
                continue;
            }

            // --- 1. Radial fibre layer ---
            // Sample noise along θ, but stretch radially so fibres run outward.
            const fibreNoise = SimplexNoise.noise2D(theta * fibreDensity * 0.05, r * 2.0);
            const fibre = (fibreNoise * 0.5 + 0.5) * fibreStrength;

            // --- 2. Collarette ring ---
            const collaretteDistance = Math.abs(r - 0.35);
            const collarette = Math.max(0, 1.0 - collaretteDistance / collaretteWidth) * 0.35;

            // --- 3. Crypt detail (hashed per angular cell) ---
            const angularCell = Math.floor((theta + Math.PI) * 40.0);
            const cryptHash = Math.abs(Math.sin(angularCell * 12.9898 + 3.14) * 43758.5453) % 1.0;
            const crypt = Math.max(0, cryptHash - 0.65) * cryptStrength;

            // --- 4. Pupil mask ---
            const pupilMask = r < pupilSize ? 1.0 : 0.0;

            // --- 5. Limbus ring ---
            const limbusDistance = Math.abs(r - 0.97);
            const limbus = Math.max(0, 1.0 - limbusDistance / limbusWidth) * 0.6;

            // --- Combine ---
            let value;
            if (pupilMask > 0.5) {
                // Pupil: near-black
                value = 0.05 + fibre * 0.2;
            } else {
                // Iris: fibres + collarette + crypts − limbus
                value = 0.55
                    + fibre
                    + collarette
                    - crypt
                    - limbus * (1.0 - limbusDistance / limbusWidth);
                // Fade toward the limbus edge
                const edgeFade = Math.max(0, Math.min(1, (1.0 - r) / 0.15));
                value *= edgeFade * 0.3 + 0.7;
            }

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

const _eyeWorld = BitECS.createWorld();
const OrganicEyeMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    eyeBands: 'ui8',
    eyeQuantize: 'f64',
    eyeSoftness: 'f64',
    pupilSize: 'f64',
    pupilDilation: 'f64',
    irisParallax: 'f64',
    irisSecondaryColorR: 'f64',
    irisSecondaryColorG: 'f64',
    irisSecondaryColorB: 'f64',
    specularGlintIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicEyeMaterialBatch {
    constructor() {
        this.world = _eyeWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicEyeMaterialComponent, eid);
        OrganicEyeMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicEyeMaterialComponent.eyeBands[eid] = material.eyeBands;
        OrganicEyeMaterialComponent.eyeQuantize[eid] = material.eyeQuantize;
        OrganicEyeMaterialComponent.eyeSoftness[eid] = material.eyeSoftness;
        OrganicEyeMaterialComponent.pupilSize[eid] = material.pupilSize;
        OrganicEyeMaterialComponent.pupilDilation[eid] = material.pupilDilation;
        OrganicEyeMaterialComponent.irisParallax[eid] = material.irisParallax;
        OrganicEyeMaterialComponent.irisSecondaryColorR[eid] = material.irisSecondaryColor.r;
        OrganicEyeMaterialComponent.irisSecondaryColorG[eid] = material.irisSecondaryColor.g;
        OrganicEyeMaterialComponent.irisSecondaryColorB[eid] = material.irisSecondaryColor.b;
        OrganicEyeMaterialComponent.specularGlintIntensity[eid] = material.specularGlintIntensity;
        OrganicEyeMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicEyeMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicEyeMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicEyeMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicEyeMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicEyeMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicEyeMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicEyeMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.eyeBands = OrganicEyeMaterialComponent.eyeBands[eid];
            material.eyeQuantize = OrganicEyeMaterialComponent.eyeQuantize[eid];
            material.eyeSoftness = OrganicEyeMaterialComponent.eyeSoftness[eid];
            material.pupilSize = OrganicEyeMaterialComponent.pupilSize[eid];
            material.pupilDilation = OrganicEyeMaterialComponent.pupilDilation[eid];
            material.irisParallax = OrganicEyeMaterialComponent.irisParallax[eid];
            material.irisSecondaryColor.setRGB(
                OrganicEyeMaterialComponent.irisSecondaryColorR[eid],
                OrganicEyeMaterialComponent.irisSecondaryColorG[eid],
                OrganicEyeMaterialComponent.irisSecondaryColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.specularGlintIntensity = OrganicEyeMaterialComponent.specularGlintIntensity[eid];
            material.moodTemperature = OrganicEyeMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicEyeMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicEyeMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicEyeMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicEyeMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicEyeMaterialComponent.variationSeed[eid];

            OrganicEyeMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicEyeMaterial class
// ---------------------------------------------------------------------------

class OrganicEyeMaterial extends MeshPhysicalMaterial {
    static {
        _eyeScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicEyeMaterial = true;
        this.type = 'OrganicEyeMaterial';

        // -------------------------------------------------------------------
        // Eye-specific PBR defaults (brown iris baseline)
        // -------------------------------------------------------------------
        this.ior = 1.376;
        this.specularIntensity = 0.65;
        this.roughness = 0.34;
        this.metalness = 0.0;
        this.specularColor = new Color(0.95, 0.94, 0.92);
        this.color = new Color(0.42, 0.22, 0.10);

        // Secondary iris colour (radial fibre layer / collarette)
        this.irisSecondaryColor = new Color(0.68, 0.44, 0.22);

        // Sclera colour & roughness (used by subclassed shader injection)
        this.scleraColor = new Color(0.94, 0.92, 0.90);
        this.scleraRoughness = 0.55;

        // Corneal wetness via clearcoat
        this.clearcoat = 1.0;
        this.clearcoatRoughness = 0.02;

        // Transmission only for the outermost wet layer; not deep volume
        this.transmission = 0.0;
        this.thickness = 0.005;
        this.attenuationDistance = 0.02;
        this.attenuationColor = new Color(0.30, 0.15, 0.10);

        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — eye-specific
        // -------------------------------------------------------------------
        this.eyeBands = 4;
        this.eyeQuantize = 0.5;
        this.eyeSoftness = 0.08;

        // Pupil control
        this.pupilSize = 0.35;          // base radius fraction
        this.pupilDilation = 0.0;        // extra dilation (0–0.5)

        // Iris parallax — approximate pupil depth displacement
        this.irisParallax = 0.05;

        // Specular glint (the anime "eye sparkle")
        this.specularGlintIntensity = 0.6;
        this.specularGlintColor = new Color(1.0, 1.0, 1.0);

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(1.0, 0.90, 0.80);
        this.paperGrain = 0;
        this.watercolorBleed = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (eyes lean semi-realistic)
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

    applyEyeBanding(baseColor, output) {
        return applyEyeCelBanding(
            baseColor,
            output,
            this.eyeBands,
            this.eyeQuantize,
            this.eyeSoftness
        );
    }

    updateMoodColor() {
        gradeEyeColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic eye preset to this material.
     * @param {string} presetName - One of the keys of `OrganicEyePresets`.
     * @returns {OrganicEyeMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicEyePresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.irisColor[0], preset.irisColor[1], preset.irisColor[2], ColorManagement.workingColorSpace);
        this.irisSecondaryColor.setRGB(preset.irisSecondaryColor[0], preset.irisSecondaryColor[1], preset.irisSecondaryColor[2], ColorManagement.workingColorSpace);
        this.roughness = preset.irisRoughness;
        this.scleraColor.setRGB(preset.scleraColor[0], preset.scleraColor[1], preset.scleraColor[2], ColorManagement.workingColorSpace);
        this.scleraRoughness = preset.scleraRoughness;
        this.clearcoat = preset.corneaClearcoat;
        this.clearcoatRoughness = preset.corneaRoughness;
        this.pupilSize = preset.pupilSize;

        // Anime-style eyes: crisper banding for saturated iris colours
        if (presetName === 'anime-crimson') {
            this.eyeSoftness = 0.04;
            this.eyeBands = 4;
            this.specularGlintIntensity = 0.85;
        } else {
            this.eyeSoftness = 0.08;
            this.eyeBands = 4;
            this.specularGlintIntensity = 0.60;
        }

        this.updateMoodColor();
        return this;
    }

    generateIrisTexture(width, height, fibreDensity = 120.0, fibreStrength = 0.35, pupilSize = 0.35) {
        return generateIrisTexture(width, height, fibreDensity, fibreStrength, 0.08, 0.25, pupilSize, 0.05);
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

        shader.uniforms.eyeBands = { value: this.eyeBands };
        shader.uniforms.eyeQuantize = { value: this.eyeQuantize };
        shader.uniforms.eyeSoftness = { value: this.eyeSoftness };
        shader.uniforms.pupilSize = { value: this.pupilSize };
        shader.uniforms.pupilDilation = { value: this.pupilDilation };
        shader.uniforms.irisParallax = { value: this.irisParallax };
        shader.uniforms.irisSecondaryColor = { value: this.irisSecondaryColor };
        shader.uniforms.specularGlintIntensity = { value: this.specularGlintIntensity };
        shader.uniforms.specularGlintColor = { value: this.specularGlintColor };
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
                uniform int eyeBands;
                uniform float eyeQuantize;
                uniform float eyeSoftness;
                uniform float pupilSize;
                uniform float pupilDilation;
                uniform float irisParallax;
                uniform vec3 irisSecondaryColor;
                uniform float specularGlintIntensity;
                uniform vec3 specularGlintColor;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyEyeBands(vec3 baseColor) {
                    if (eyeBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(eyeBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * eyeSoftness;
                    float finalLum = mix(lum, softQuantized, eyeQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply eye cel banding
                gl_FragColor.rgb = applyEyeBands(gl_FragColor.rgb);

                // Dual-layer iris approximation:
                // Blend the base iris colour with the secondary fibre colour
                // based on a radial collarette ring at r ≈ 0.35.
                {
                    // UV-space radial coordinate (assumes iris is centred at UV centre)
                    vec2 irisUV = vUv - vec2(0.5);
                    float irisR = length(irisUV);
                    float collarette = smoothstep(0.28, 0.38, irisR) * (1.0 - smoothstep(0.38, 0.48, irisR));

                    // Mix base iris with secondary fibre colour inside the collarette
                    vec3 fibreLayer = mix(gl_FragColor.rgb, irisSecondaryColor, collarette * 0.45);
                    gl_FragColor.rgb = fibreLayer;

                    // Pupil mask: darkens towards the centre based on pupilSize + dilation
                    float effectivePupil = pupilSize + pupilDilation;
                    // Approximate parallax by offsetting the pupil mask radially
                    float pupilMask = 1.0 - smoothstep(effectivePupil - 0.02, effectivePupil + 0.02 + irisParallax, irisR);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.01, 0.01, 0.02), pupilMask);
                }

                // Specular glint (anime eye sparkle)
                if (specularGlintIntensity > 0.0) {
                    float ndotvEye = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float glint = pow(1.0 - ndotvEye, 12.0) * specularGlintIntensity;
                    gl_FragColor.rgb += specularGlintColor * glint;
                }

                // Warm rim glow on eye edges
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
            this.eyeBands, this.eyeQuantize, this.eyeSoftness,
            this.pupilSize, this.pupilDilation, this.irisParallax,
            this.specularGlintIntensity,
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
        this.irisSecondaryColor.copy(source.irisSecondaryColor);
        this.scleraColor.copy(source.scleraColor);
        this.scleraRoughness = source.scleraRoughness;
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.eyeBands = source.eyeBands;
        this.eyeQuantize = source.eyeQuantize;
        this.eyeSoftness = source.eyeSoftness;
        this.pupilSize = source.pupilSize;
        this.pupilDilation = source.pupilDilation;
        this.irisParallax = source.irisParallax;
        this.specularGlintIntensity = source.specularGlintIntensity;
        this.specularGlintColor.copy(source.specularGlintColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicEyeMaterial';
        if (this.ior !== 1.376) data.ior = this.ior;
        if (this.specularIntensity !== 0.65) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.34) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 1.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.02) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.0) data.transmission = this.transmission;
        if (this.thickness !== 0.005) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.02) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.30, 0.15, 0.10).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularColor.getHex() !== new Color(0.95, 0.94, 0.92).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.irisSecondaryColor.getHex() !== new Color(0.68, 0.44, 0.22).getHex()) data.irisSecondaryColor = this.irisSecondaryColor.getHex();
        if (this.scleraColor.getHex() !== new Color(0.94, 0.92, 0.90).getHex()) data.scleraColor = this.scleraColor.getHex();
        if (this.scleraRoughness !== 0.55) data.scleraRoughness = this.scleraRoughness;
        if (this.eyeBands !== 4) data.eyeBands = this.eyeBands;
        if (this.eyeQuantize !== 0.5) data.eyeQuantize = this.eyeQuantize;
        if (this.eyeSoftness !== 0.08) data.eyeSoftness = this.eyeSoftness;
        if (this.pupilSize !== 0.35) data.pupilSize = this.pupilSize;
        if (this.pupilDilation !== 0.0) data.pupilDilation = this.pupilDilation;
        if (this.irisParallax !== 0.05) data.irisParallax = this.irisParallax;
        if (this.specularGlintIntensity !== 0.6) data.specularGlintIntensity = this.specularGlintIntensity;
        if (this.specularGlintColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) data.specularGlintColor = this.specularGlintColor.getHex();
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 0.90, 0.80).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        if (json.irisSecondaryColor !== undefined) this.irisSecondaryColor.setHex(json.irisSecondaryColor);
        if (json.scleraColor !== undefined) this.scleraColor.setHex(json.scleraColor);
        this.scleraRoughness = json.scleraRoughness ?? this.scleraRoughness;
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.eyeBands = json.eyeBands ?? this.eyeBands;
        this.eyeQuantize = json.eyeQuantize ?? this.eyeQuantize;
        this.eyeSoftness = json.eyeSoftness ?? this.eyeSoftness;
        this.pupilSize = json.pupilSize ?? this.pupilSize;
        this.pupilDilation = json.pupilDilation ?? this.pupilDilation;
        this.irisParallax = json.irisParallax ?? this.irisParallax;
        this.specularGlintIntensity = json.specularGlintIntensity ?? this.specularGlintIntensity;
        if (json.specularGlintColor !== undefined) this.specularGlintColor.setHex(json.specularGlintColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicEyeMaterialBatchComponent = {
    materialPtr: 'ui32',
    eyeBands: 'ui8',
    eyeQuantize: 'f64',
    eyeSoftness: 'f64',
    pupilSize: 'f64',
    pupilDilation: 'f64',
    irisParallax: 'f64',
    irisSecondaryColorR: 'f64',
    irisSecondaryColorG: 'f64',
    irisSecondaryColorB: 'f64',
    specularGlintIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicEyeMaterial,
    OrganicEyeMaterialBatch,
    EyeScratchPool,
    OrganicEyeMaterialBatchComponent,
    OrganicEyePresets,
    applyEyeCelBanding,
    gradeEyeColor,
    generateIrisTexture
};

export default OrganicEyeMaterial;