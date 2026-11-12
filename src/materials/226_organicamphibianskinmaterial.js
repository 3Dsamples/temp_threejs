// file number : 226
// full path name : src/materials/226_organicamphibianskinmaterial.js
// description : OrganicAmphibianSkinMaterial — a ready-to-use amphibian-skin
//               material for frogs, toads, salamanders, newts, and other
//               moist-skinned amphibians. Extends MeshPhysicalMaterial with
//               purpose-built presets for green frog, brown toad, red poison
//               dart frog, blue poison dart frog, yellow salamander, and
//               newt-orange. Includes amphibian-appropriate PBR defaults
//               (moist-skin IOR ≈ 1.40, roughness 0.35–0.55, zero metalness,
//               thin-walled transmission for the wet translucency, and strong
//               sheen for the mucus-layer wet gleam) plus real-time anime
//               stylization: cel-banded amphibian highlights, mucus-wet
//               approximation, mood tinting, rim glow, and per-instance
//               variation. Includes a procedural amphibian-skin texture
//               generator using multi-octave fBm with wart pits, mucus-gland
//               speckles, and per-gland hashing.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Organic amphibian skin, frogs, toads, salamanders, newts, poison
//            dart frogs, tropical frogs, wet-skin creatures, fantasy amphibian
//            creatures, and any amphibian-like skin surface that needs real-time
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
// Amphibian-skin presets — biologically grounded PBR parameter sets for
// amphibian skin types.
//
// Reference values (from amphibian-skin PBR references, cgaxis wet-skin
// texture packs, and herpetology literature):
//   - Amphibian moist-skin IOR:  ≈ 1.40 (water-rich mucus layer)
//   - Amphibian roughness:       0.35–0.55 (wet, slippery)
//   - Metalness:                 0.0 (amphibian skin is a dielectric)
//   - Transmission:              thin-walled 0.05–0.20 for the wet translucency
//   - Sheen:                     strong for the mucus-layer wet gleam
//   - Poison dart frog colours:  high-saturation warning colours
// ---------------------------------------------------------------------------

const OrganicAmphibianSkinPresets = {
    'green-frog': {
        color: [0.32, 0.58, 0.22],
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.35,
        transmission: 0.12,
        thickness: 0.004,
        attenuationDistance: 0.05,
        attenuationColor: [0.42, 0.68, 0.32],
        sheen: 0.45,
        sheenColor: [0.55, 0.78, 0.42],
        sheenRoughness: 0.50,
        specularIntensity: 0.55,
        specularColor: [0.75, 0.88, 0.65]
    },
    'brown-toad': {
        color: [0.52, 0.42, 0.28],
        roughness: 0.50,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.42,
        transmission: 0.08,
        thickness: 0.004,
        attenuationDistance: 0.05,
        attenuationColor: [0.62, 0.52, 0.38],
        sheen: 0.38,
        sheenColor: [0.72, 0.62, 0.48],
        sheenRoughness: 0.58,
        specularIntensity: 0.45,
        specularColor: [0.82, 0.72, 0.58]
    },
    'red-poison-dart': {
        color: [0.82, 0.14, 0.12],
        roughness: 0.38,
        metalness: 0.0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.30,
        transmission: 0.14,
        thickness: 0.004,
        attenuationDistance: 0.05,
        attenuationColor: [0.90, 0.22, 0.18],
        sheen: 0.55,
        sheenColor: [0.95, 0.42, 0.35],
        sheenRoughness: 0.45,
        specularIntensity: 0.62,
        specularColor: [1.0, 0.72, 0.65]
    },
    'blue-poison-dart': {
        color: [0.12, 0.32, 0.82],
        roughness: 0.38,
        metalness: 0.0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.30,
        transmission: 0.14,
        thickness: 0.004,
        attenuationDistance: 0.05,
        attenuationColor: [0.20, 0.42, 0.90],
        sheen: 0.55,
        sheenColor: [0.42, 0.62, 0.98],
        sheenRoughness: 0.45,
        specularIntensity: 0.62,
        specularColor: [0.72, 0.88, 1.0]
    },
    'yellow-salamander': {
        color: [0.82, 0.72, 0.28],
        roughness: 0.44,
        metalness: 0.0,
        clearcoat: 0.18,
        clearcoatRoughness: 0.35,
        transmission: 0.11,
        thickness: 0.004,
        attenuationDistance: 0.05,
        attenuationColor: [0.92, 0.82, 0.38],
        sheen: 0.42,
        sheenColor: [0.95, 0.88, 0.52],
        sheenRoughness: 0.50,
        specularIntensity: 0.55,
        specularColor: [0.92, 0.88, 0.65]
    },
    'newt-orange': {
        color: [0.72, 0.38, 0.18],
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.35,
        transmission: 0.10,
        thickness: 0.004,
        attenuationDistance: 0.05,
        attenuationColor: [0.82, 0.48, 0.24],
        sheen: 0.40,
        sheenColor: [0.90, 0.62, 0.38],
        sheenRoughness: 0.52,
        specularIntensity: 0.52,
        specularColor: [0.92, 0.78, 0.62]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable amphibian-skin scratch records
// ---------------------------------------------------------------------------

class AmphibianSkinScratchPool {
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

const _amphibianSkinScratchPool = new AmphibianSkinScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — amphibian-skin-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded amphibian-skin highlights. Amphibian skin has soft, wet
 * shading with a strong wet gleam — quantizing it into discrete bands produces
 * the crisp anime amphibian edges seen in hand-drawn nature illustrations.
 */
function applyAmphibianSkinCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to amphibian skin. Warm moods push amphibian skin
 * toward warm ochre/brown, cool moods toward cool blue-green — matching the
 * atmospheric amphibian tinting seen in stylized wetland scenes.
 */
function gradeAmphibianSkinColor(color, temperature, saturation, brightness, contrast) {
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

    // Amphibian-skin-specific temperature bias: warm shift pushes toward
    // ochre/brown, cool shift pushes toward blue-green.
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
 * Generate a procedural amphibian-skin texture. The algorithm:
 * 1. Multi-octave fBm for the low-frequency skin base tone.
 * 2. Wart-pit field: hashed cells with per-cell presence, radius, and depth —
 *    producing the toad wart look or the smooth frog gland pits.
 * 3. Mucus-gland speckles: high-frequency per-cell hashing producing small
 *    bright/dark glands scattered across the surface.
 * 4. Optional colour mottle: low-frequency fBm for pigmentation variation.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateAmphibianSkinTexture(width, height, scale = 0.04, octaves = 4, wartDensity = 0.15, wartStrength = 0.25, glandDensity = 0.30, mottleStrength = 0.10) {
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

            // --- 2. Wart-pit field ---
            const wartCellX = Math.floor(x * 0.15);
            const wartCellY = Math.floor(y * 0.15);
            const wartCellId = wartCellX * 73856093 ^ wartCellY * 19349663;
            const wartHash = Math.abs(Math.sin(wartCellId * 12.9898) * 43758.5453) % 1.0;

            let wart = 0;
            if (wartHash > (1.0 - wartDensity)) {
                const h2 = Math.abs(Math.sin(wartCellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                const h3 = Math.abs(Math.sin(wartCellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                const cx = (x * 0.15) - wartCellX - h2;
                const cy = (y * 0.15) - wartCellY - h3;
                const dist = Math.sqrt(cx * cx + cy * cy);
                wart = Math.max(0, 1.0 - dist * 4.0) * wartStrength;
            }

            // --- 3. Mucus-gland speckles ---
            const glandCellX = Math.floor(x * 0.9);
            const glandCellY = Math.floor(y * 0.9);
            const glandCellId = glandCellX * 2654435761 ^ glandCellY * 40503;
            const glandHash = Math.abs(Math.sin(glandCellId * 12.9898) * 43758.5453) % 1.0;
            const gland = glandHash > (1.0 - glandDensity) ? 1.0 : 0.0;

            // --- 4. Colour mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.02, y * 0.02) * mottleStrength;

            // --- Combine ---
            let value = 0.62
                + (fbm - 0.5) * 0.20
                + wart * 0.40
                + (gland - 0.5) * 0.06
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

const _amphibianSkinWorld = BitECS.createWorld();
const OrganicAmphibianSkinMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    amphibianBands: 'ui8',
    amphibianQuantize: 'f64',
    amphibianSoftness: 'f64',
    wartStrength: 'f64',
    wartDensity: 'f64',
    mucusGlandDensity: 'f64',
    wetSheenStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicAmphibianSkinMaterialBatch {
    constructor() {
        this.world = _amphibianSkinWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicAmphibianSkinMaterialComponent, eid);
        OrganicAmphibianSkinMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicAmphibianSkinMaterialComponent.amphibianBands[eid] = material.amphibianBands;
        OrganicAmphibianSkinMaterialComponent.amphibianQuantize[eid] = material.amphibianQuantize;
        OrganicAmphibianSkinMaterialComponent.amphibianSoftness[eid] = material.amphibianSoftness;
        OrganicAmphibianSkinMaterialComponent.wartStrength[eid] = material.wartStrength;
        OrganicAmphibianSkinMaterialComponent.wartDensity[eid] = material.wartDensity;
        OrganicAmphibianSkinMaterialComponent.mucusGlandDensity[eid] = material.mucusGlandDensity;
        OrganicAmphibianSkinMaterialComponent.wetSheenStrength[eid] = material.wetSheenStrength;
        OrganicAmphibianSkinMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicAmphibianSkinMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicAmphibianSkinMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicAmphibianSkinMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicAmphibianSkinMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicAmphibianSkinMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicAmphibianSkinMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicAmphibianSkinMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.amphibianBands = OrganicAmphibianSkinMaterialComponent.amphibianBands[eid];
            material.amphibianQuantize = OrganicAmphibianSkinMaterialComponent.amphibianQuantize[eid];
            material.amphibianSoftness = OrganicAmphibianSkinMaterialComponent.amphibianSoftness[eid];
            material.wartStrength = OrganicAmphibianSkinMaterialComponent.wartStrength[eid];
            material.wartDensity = OrganicAmphibianSkinMaterialComponent.wartDensity[eid];
            material.mucusGlandDensity = OrganicAmphibianSkinMaterialComponent.mucusGlandDensity[eid];
            material.wetSheenStrength = OrganicAmphibianSkinMaterialComponent.wetSheenStrength[eid];
            material.moodTemperature = OrganicAmphibianSkinMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicAmphibianSkinMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicAmphibianSkinMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicAmphibianSkinMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicAmphibianSkinMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicAmphibianSkinMaterialComponent.variationSeed[eid];

            OrganicAmphibianSkinMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicAmphibianSkinMaterial class
// ---------------------------------------------------------------------------

class OrganicAmphibianSkinMaterial extends MeshPhysicalMaterial {
    static {
        _amphibianSkinScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicAmphibianSkinMaterial = true;
        this.type = 'OrganicAmphibianSkinMaterial';

        // -------------------------------------------------------------------
        // Amphibian-skin-specific PBR defaults (green-frog baseline)
        // -------------------------------------------------------------------
        this.ior = 1.40;
        this.specularIntensity = 0.55;
        this.roughness = 0.42;
        this.metalness = 0.0;
        this.specularColor = new Color(0.75, 0.88, 0.65);
        this.color = new Color(0.32, 0.58, 0.22);

        // Clearcoat for the wet mucus layer
        this.clearcoat = 0.15;
        this.clearcoatRoughness = 0.35;

        // Thin-walled transmission for the wet translucency
        this.transmission = 0.12;
        this.thickness = 0.004;
        this.attenuationDistance = 0.05;
        this.attenuationColor = new Color(0.42, 0.68, 0.32);

        // Sheen for the mucus-layer wet gleam
        this.sheen = 0.45;
        this.sheenColor = new Color(0.55, 0.78, 0.42);
        this.sheenRoughness = 0.50;

        // -------------------------------------------------------------------
        // Anime rendering extensions — amphibian-skin-specific
        // -------------------------------------------------------------------
        this.amphibianBands = 3;
        this.amphibianQuantize = 0.4;
        this.amphibianSoftness = 0.15;
        this.wartStrength = 0.25;
        this.wartDensity = 0.15;
        this.mucusGlandDensity = 0.30;
        this.wetSheenStrength = 0.40;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.55, 0.78, 0.42);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (amphibian skin leans semi-realistic)
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

    applyAmphibianBanding(baseColor, output) {
        return applyAmphibianSkinCelBanding(
            baseColor,
            output,
            this.amphibianBands,
            this.amphibianQuantize,
            this.amphibianSoftness
        );
    }

    updateMoodColor() {
        gradeAmphibianSkinColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic amphibian-skin preset to this material.
     * @param {string} presetName - One of the keys of `OrganicAmphibianSkinPresets`.
     * @returns {OrganicAmphibianSkinMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicAmphibianSkinPresets[presetName];
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

        // Adjust anime band softness per preset
        if (presetName === 'red-poison-dart' || presetName === 'blue-poison-dart') {
            this.amphibianSoftness = 0.08;
            this.amphibianBands = 4;
            this.wartStrength = 0.0;
            this.wartDensity = 0.0;
        } else if (presetName === 'brown-toad') {
            this.amphibianSoftness = 0.20;
            this.amphibianBands = 2;
            this.wartStrength = 0.35;
            this.wartDensity = 0.25;
        } else {
            this.amphibianSoftness = 0.15;
            this.amphibianBands = 3;
            this.wartStrength = 0.15;
            this.wartDensity = 0.10;
        }

        this.updateMoodColor();
        return this;
    }

    generateAmphibianSkinTexture(width, height, scale = 0.04, octaves = 4, wartDensity = 0.15, wartStrength = 0.25, glandDensity = 0.30) {
        return generateAmphibianSkinTexture(width, height, scale, octaves, wartDensity, wartStrength, glandDensity, 0.10);
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

        shader.uniforms.amphibianBands = { value: this.amphibianBands };
        shader.uniforms.amphibianQuantize = { value: this.amphibianQuantize };
        shader.uniforms.amphibianSoftness = { value: this.amphibianSoftness };
        shader.uniforms.wartStrength = { value: this.wartStrength };
        shader.uniforms.wartDensity = { value: this.wartDensity };
        shader.uniforms.mucusGlandDensity = { value: this.mucusGlandDensity };
        shader.uniforms.wetSheenStrength = { value: this.wetSheenStrength };
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
                uniform int amphibianBands;
                uniform float amphibianQuantize;
                uniform float amphibianSoftness;
                uniform float wartStrength;
                uniform float wartDensity;
                uniform float mucusGlandDensity;
                uniform float wetSheenStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyAmphibianBands(vec3 baseColor) {
                    if (amphibianBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(amphibianBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * amphibianSoftness;
                    float finalLum = mix(lum, softQuantized, amphibianQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply amphibian-skin cel banding
                gl_FragColor.rgb = applyAmphibianBands(gl_FragColor.rgb);

                // Wart-pit approximation: hashed cell darkening
                if (wartStrength > 0.0) {
                    vec2 wartUV = vUv * 40.0;
                    vec2 wartCell = floor(wartUV);
                    vec2 wartFrac = fract(wartUV);
                    float wartHash = fract(sin(dot(wartCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (wartHash > (1.0 - wartDensity)) {
                        vec2 wartCentre = vec2(fract(wartHash * 7.31), fract(wartHash * 13.7));
                        float wartDist = length(wartFrac - wartCentre);
                        float wartMask = max(0.0, 1.0 - wartDist * 3.0);
                        gl_FragColor.rgb *= (1.0 - wartMask * wartStrength * 0.4);
                    }
                }

                // Mucus-gland speckles: small bright/dark dots
                if (mucusGlandDensity > 0.0) {
                    vec2 glandUV = vUv * 120.0;
                    vec2 glandCell = floor(glandUV);
                    float glandHash = fract(sin(dot(glandCell, vec2(39.425, 1.57))) * 43758.5453);
                    float glandMask = glandHash > (1.0 - mucusGlandDensity) ? 1.0 : 0.0;
                    gl_FragColor.rgb *= (1.0 + glandMask * 0.08);
                }

                // Wet sheen: bright grazing-angle specular streaks
                if (wetSheenStrength > 0.0) {
                    float ndotvAmph = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float wetGleam = pow(1.0 - ndotvAmph, 4.0) * wetSheenStrength;
                    gl_FragColor.rgb += sheenColor * wetGleam * 0.4;
                }

                // Warm rim glow on amphibian-skin edges
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
            this.amphibianBands, this.amphibianQuantize, this.amphibianSoftness,
            this.wartStrength, this.wartDensity, this.mucusGlandDensity,
            this.wetSheenStrength,
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
        this.amphibianBands = source.amphibianBands;
        this.amphibianQuantize = source.amphibianQuantize;
        this.amphibianSoftness = source.amphibianSoftness;
        this.wartStrength = source.wartStrength;
        this.wartDensity = source.wartDensity;
        this.mucusGlandDensity = source.mucusGlandDensity;
        this.wetSheenStrength = source.wetSheenStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicAmphibianSkinMaterial';
        if (this.ior !== 1.40) data.ior = this.ior;
        if (this.specularIntensity !== 0.55) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.42) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.15) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.35) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.12) data.transmission = this.transmission;
        if (this.thickness !== 0.004) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.05) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.42, 0.68, 0.32).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.45) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.55, 0.78, 0.42).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.50) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.75, 0.88, 0.65).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.amphibianBands !== 3) data.amphibianBands = this.amphibianBands;
        if (this.amphibianQuantize !== 0.4) data.amphibianQuantize = this.amphibianQuantize;
        if (this.amphibianSoftness !== 0.15) data.amphibianSoftness = this.amphibianSoftness;
        if (this.wartStrength !== 0.25) data.wartStrength = this.wartStrength;
        if (this.wartDensity !== 0.15) data.wartDensity = this.wartDensity;
        if (this.mucusGlandDensity !== 0.30) data.mucusGlandDensity = this.mucusGlandDensity;
        if (this.wetSheenStrength !== 0.40) data.wetSheenStrength = this.wetSheenStrength;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.55, 0.78, 0.42).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.amphibianBands = json.amphibianBands ?? this.amphibianBands;
        this.amphibianQuantize = json.amphibianQuantize ?? this.amphibianQuantize;
        this.amphibianSoftness = json.amphibianSoftness ?? this.amphibianSoftness;
        this.wartStrength = json.wartStrength ?? this.wartStrength;
        this.wartDensity = json.wartDensity ?? this.wartDensity;
        this.mucusGlandDensity = json.mucusGlandDensity ?? this.mucusGlandDensity;
        this.wetSheenStrength = json.wetSheenStrength ?? this.wetSheenStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicAmphibianSkinMaterialBatchComponent = {
    materialPtr: 'ui32',
    amphibianBands: 'ui8',
    amphibianQuantize: 'f64',
    amphibianSoftness: 'f64',
    wartStrength: 'f64',
    wartDensity: 'f64',
    mucusGlandDensity: 'f64',
    wetSheenStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicAmphibianSkinMaterial,
    OrganicAmphibianSkinMaterialBatch,
    AmphibianSkinScratchPool,
    OrganicAmphibianSkinMaterialBatchComponent,
    OrganicAmphibianSkinPresets,
    applyAmphibianSkinCelBanding,
    gradeAmphibianSkinColor,
    generateAmphibianSkinTexture
};

export default OrganicAmphibianSkinMaterial;