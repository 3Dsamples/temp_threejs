// file number : 217
// full path name : src/materials/217_organicfishscalematerial.js
// description : OrganicFishScaleMaterial — a ready-to-use fish‑scale material
//               for fish, reptiles, and scaly organic surfaces. Extends
//               MeshPhysicalMaterial with purpose‑built presets for koi,
//               salmon, tropical reef fish, and serpent scales. Includes
//               biologically grounded defaults (zero metalness, roughness
//               0.35–0.55, anisotropic specular for scale direction, and
//               iridescence for the silvery guanine‑crystal shimmer) plus
//               real‑time anime stylization: cel‑banded scale highlights,
//               iridescent scale shimmer, mood tinting, rim glow, and
//               per‑instance variation. Includes a procedural scale‑pattern
//               texture generator using overlapping circular SDF cells with
//               per‑scale hashing and anisotropy direction. All imports
//               resolve to the internal Threejs_gl repository tree; no CDN
//               dependencies.
// best for : Organic fish scales, koi, salmon, tropical reef fish, serpent
//            scales, reptile skin, fantasy creature scales, and any scaly
//            organic surface that needs real‑time PBR + anime stylization.
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

/** @type {number} Golden‑angle increment for per‑instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec2} Scratch 2D vector for UV staging. */
const _scratchUV = new Vec2();

/** @type {Vec3} Scratch 3D vector for normal staging. */
const _scratchNormal = new Vec3();

/** @type {Vec3} Scratch 3D vector for view‑direction staging. */
const _scratchView = new Vec3();

/** @type {Mat4} Scratch matrix for projection staging. */
const _scratchProjMat = new Mat4();

// ---------------------------------------------------------------------------
// Fish‑scale presets — biologically grounded PBR parameter sets for scale
// types.
//
// Reference values (from 3DTexel fish‑scale PBR packs, cgaxis fish‑scale
// textures, and Chaos V‑Ray fish‑scale guidance):
//   - Fish‑scale metalness:     0.0 (dielectric)
//   - Fish‑scale roughness:     0.35–0.55 (realistic glossy scales)
//   - Anisotropy strength:      0.5–0.9 (aligned with scale rows)
//   - Reflection glossiness:    0.65–0.85
//   - Iridescence:              significant for koi/salmon/reef fish
//   - IOR (scale keratin):      ≈ 1.50
// ---------------------------------------------------------------------------

const OrganicFishScalePresets = {
    'koi': {
        color: [0.92, 0.88, 0.82],
        roughness: 0.38,
        metalness: 0.0,
        anisotropy: 0.70,
        anisotropyRotation: 0.0,
        iridescence: 0.55,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [200, 600],
        specularIntensity: 0.75,
        specularColor: [0.98, 0.96, 0.92],
        transmission: 0.05,
        thickness: 0.002,
        attenuationDistance: 0.15,
        attenuationColor: [0.92, 0.86, 0.78]
    },
    'salmon': {
        color: [0.82, 0.58, 0.48],
        roughness: 0.42,
        metalness: 0.0,
        anisotropy: 0.65,
        anisotropyRotation: 0.0,
        iridescence: 0.45,
        iridescenceIOR: 1.28,
        iridescenceThicknessRange: [180, 550],
        specularIntensity: 0.70,
        specularColor: [0.95, 0.88, 0.82],
        transmission: 0.04,
        thickness: 0.002,
        attenuationDistance: 0.12,
        attenuationColor: [0.85, 0.68, 0.58]
    },
    'tropical-reef': {
        color: [0.28, 0.62, 0.82],
        roughness: 0.32,
        metalness: 0.0,
        anisotropy: 0.75,
        anisotropyRotation: 0.0,
        iridescence: 0.85,
        iridescenceIOR: 1.35,
        iridescenceThicknessRange: [250, 700],
        specularIntensity: 0.80,
        specularColor: [0.85, 0.95, 1.0],
        transmission: 0.06,
        thickness: 0.002,
        attenuationDistance: 0.18,
        attenuationColor: [0.42, 0.72, 0.90]
    },
    'serpent': {
        color: [0.42, 0.58, 0.28],
        roughness: 0.48,
        metalness: 0.0,
        anisotropy: 0.55,
        anisotropyRotation: 0.0,
        iridescence: 0.35,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [150, 450],
        specularIntensity: 0.65,
        specularColor: [0.85, 0.90, 0.75],
        transmission: 0.02,
        thickness: 0.003,
        attenuationDistance: 0.10,
        attenuationColor: [0.55, 0.70, 0.42]
    },
    'goldfish': {
        color: [0.92, 0.48, 0.18],
        roughness: 0.40,
        metalness: 0.0,
        anisotropy: 0.68,
        anisotropyRotation: 0.0,
        iridescence: 0.60,
        iridescenceIOR: 1.32,
        iridescenceThicknessRange: [220, 620],
        specularIntensity: 0.72,
        specularColor: [1.0, 0.88, 0.72],
        transmission: 0.05,
        thickness: 0.002,
        attenuationDistance: 0.14,
        attenuationColor: [0.95, 0.62, 0.32]
    },
    'deep-sea': {
        color: [0.18, 0.22, 0.32],
        roughness: 0.45,
        metalness: 0.0,
        anisotropy: 0.60,
        anisotropyRotation: 0.0,
        iridescence: 0.70,
        iridescenceIOR: 1.34,
        iridescenceThicknessRange: [200, 580],
        specularIntensity: 0.68,
        specularColor: [0.75, 0.82, 0.95],
        transmission: 0.03,
        thickness: 0.002,
        attenuationDistance: 0.12,
        attenuationColor: [0.30, 0.38, 0.52]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable fish‑scale scratch records
// ---------------------------------------------------------------------------

class FishScaleScratchPool {
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

const _fishScaleScratchPool = new FishScaleScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — fish‑scale‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel‑banded scale highlights. Fish scales have crisp specular
 * highlights on each scale plate — quantizing the luminance into discrete
 * bands produces the flat anime scale shine seen in hand‑drawn fish
 * illustrations.
 */
function applyFishScaleCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.08) {
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
 * Apply mood‑based tinting to fish scales. Warm moods push scales toward a
 * warm golden‑amber, cool moods toward a cool silvery‑blue — matching the
 * atmospheric scale tinting seen in stylized aquatic scenes.
 */
function gradeFishScaleColor(color, temperature, saturation, brightness, contrast) {
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

    // Scale‑specific temperature bias: warm shift pushes toward gold,
    // cool shift pushes toward silver‑blue.
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
 * Generate a procedural fish‑scale texture. The algorithm:
 * 1. Divide the UV into an overlapping circular scale lattice with a
 *    per‑row horizontal offset to produce the classic overlapping‑scale
 *    pattern.
 * 2. For each pixel, compute the nearest scale centre (SDF distance) and use
 *    a smooth‑stepped circle mask to isolate the scale plate.
 * 3. Per‑scale hashing produces small colour/brightness variations between
 *    scales (reference: bevy_symbios_texture scale generation pattern).
 * 4. A directional anisotropy mask highlights the scale‑row direction.
 * 5. A fine simplex‑noise mottle breaks up uniformity.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * anisotropy direction, or bump‑map use.
 */
function generateFishScaleTexture(width, height, scaleCols = 16, scaleRows = 16, scaleRadius = 0.48, rowStagger = 0.5, scaleEdgeSoftness = 0.08, scaleJitter = 0.08, anisotropyStrength = 0.35) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Scale lattice coordinates
            const rowFloat = (y / height) * scaleRows;
            const rowIndex = Math.floor(rowFloat);
            const rowOffset = (rowIndex % 2) * rowStagger;

            const colFloat = (x / width) * scaleCols + rowOffset;
            const colIndex = Math.floor(colFloat);

            // Cell‑local coordinates centred at 0.5
            const cellX = colFloat - colIndex;
            const cellY = rowFloat - rowIndex;

            // Per‑scale hashed jitter of the centre
            const scaleId = colIndex * 73856093 ^ rowIndex * 19349663;
            const hx = Math.abs(Math.sin(scaleId * 12.9898) * 43758.5453) % 1.0;
            const hy = Math.abs(Math.sin(scaleId * 78.233 + 3.14) * 43758.5453) % 1.0;
            const jitterX = (hx - 0.5) * scaleJitter;
            const jitterY = (hy - 0.5) * scaleJitter;

            // Distance to the nearest scale centre (SDF)
            const dx = (cellX - 0.5) + jitterX;
            const dy = (cellY - 0.5) + jitterY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // Scale‑plate mask: 1 inside the circle, 0 outside
            const plateMask = 1.0 - Math.max(0, Math.min(1, (dist - scaleRadius + scaleEdgeSoftness) / scaleEdgeSoftness));

            // Per‑scale colour hash
            const scaleHash = Math.abs(Math.sin(scaleId * 26.651 + 1.57) * 43758.5453) % 1.0;
            const scaleTint = 0.85 + scaleHash * 0.15;

            // Directional anisotropy mask (brighter along the row axis)
            const anisotropy = Math.max(0, 1.0 - Math.abs(dy) / scaleRadius) * anisotropyStrength;

            // Fine mottle
            const mottle = SimplexNoise.noise2D(x * 0.6, y * 0.6) * 0.04;

            // Combine
            let value = 0.45
                + plateMask * 0.35 * scaleTint
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

const _fishScaleWorld = BitECS.createWorld();
const OrganicFishScaleMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    scaleBands: 'ui8',
    scaleQuantize: 'f64',
    scaleSoftness: 'f64',
    scaleIridescence: 'f64',
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

class OrganicFishScaleMaterialBatch {
    constructor() {
        this.world = _fishScaleWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicFishScaleMaterialComponent, eid);
        OrganicFishScaleMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicFishScaleMaterialComponent.scaleBands[eid] = material.scaleBands;
        OrganicFishScaleMaterialComponent.scaleQuantize[eid] = material.scaleQuantize;
        OrganicFishScaleMaterialComponent.scaleSoftness[eid] = material.scaleSoftness;
        OrganicFishScaleMaterialComponent.scaleIridescence[eid] = material.scaleIridescence;
        OrganicFishScaleMaterialComponent.anisotropyStrength[eid] = material.anisotropy;
        OrganicFishScaleMaterialComponent.anisotropyRotation[eid] = material.anisotropyRotation;
        OrganicFishScaleMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicFishScaleMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicFishScaleMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicFishScaleMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicFishScaleMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicFishScaleMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicFishScaleMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicFishScaleMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.scaleBands = OrganicFishScaleMaterialComponent.scaleBands[eid];
            material.scaleQuantize = OrganicFishScaleMaterialComponent.scaleQuantize[eid];
            material.scaleSoftness = OrganicFishScaleMaterialComponent.scaleSoftness[eid];
            material.scaleIridescence = OrganicFishScaleMaterialComponent.scaleIridescence[eid];
            material.anisotropy = OrganicFishScaleMaterialComponent.anisotropyStrength[eid];
            material.anisotropyRotation = OrganicFishScaleMaterialComponent.anisotropyRotation[eid];
            material.moodTemperature = OrganicFishScaleMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicFishScaleMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicFishScaleMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicFishScaleMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicFishScaleMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicFishScaleMaterialComponent.variationSeed[eid];

            OrganicFishScaleMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicFishScaleMaterial class
// ---------------------------------------------------------------------------

class OrganicFishScaleMaterial extends MeshPhysicalMaterial {
    static {
        _fishScaleScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicFishScaleMaterial = true;
        this.type = 'OrganicFishScaleMaterial';

        // -------------------------------------------------------------------
        // Fish‑scale‑specific PBR defaults (koi baseline)
        // -------------------------------------------------------------------
        this.ior = 1.50;
        this.specularIntensity = 0.75;
        this.roughness = 0.38;
        this.metalness = 0.0;
        this.specularColor = new Color(0.98, 0.96, 0.92);
        this.color = new Color(0.92, 0.88, 0.82);

        // Anisotropy for scale direction
        this.anisotropy = 0.70;
        this.anisotropyRotation = 0.0;

        // Iridescence for silvery guanine‑crystal shimmer
        this.iridescence = 0.55;
        this.iridescenceIOR = 1.30;
        this.iridescenceThicknessRange = [200, 600];

        // Thin‑walled transmission for the translucent scale membrane
        this.transmission = 0.05;
        this.thickness = 0.002;
        this.attenuationDistance = 0.15;
        this.attenuationColor = new Color(0.92, 0.86, 0.78);

        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — fish‑scale‑specific
        // -------------------------------------------------------------------
        this.scaleBands = 3;
        this.scaleQuantize = 0.5;
        this.scaleSoftness = 0.08;
        this.scaleIridescence = 0.55;
        this.scaleIridescenceColor = new Color(0.85, 0.92, 1.0);

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.15;
        this.rimGlowColor = new Color(0.75, 0.90, 1.0);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (fish scales lean semi‑realistic)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.35;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    applyScaleBanding(baseColor, output) {
        return applyFishScaleCelBanding(
            baseColor,
            output,
            this.scaleBands,
            this.scaleQuantize,
            this.scaleSoftness
        );
    }

    updateMoodColor() {
        gradeFishScaleColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic fish‑scale preset to this material.
     * @param {string} presetName - One of the keys of `OrganicFishScalePresets`.
     * @returns {OrganicFishScaleMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicFishScalePresets[presetName];
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
        this.transmission = preset.transmission;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness per preset
        if (presetName === 'tropical-reef' || presetName === 'koi') {
            this.scaleSoftness = 0.06;
            this.scaleBands = 3;
        } else if (presetName === 'serpent') {
            this.scaleSoftness = 0.15;
            this.scaleBands = 2;
        } else {
            this.scaleSoftness = 0.10;
            this.scaleBands = 3;
        }

        this.scaleIridescence = preset.iridescence;

        this.updateMoodColor();
        return this;
    }

    generateFishScaleTexture(width, height, scaleCols = 16, scaleRows = 16, scaleRadius = 0.48, rowStagger = 0.5) {
        return generateFishScaleTexture(width, height, scaleCols, scaleRows, scaleRadius, rowStagger, 0.08, 0.08, 0.35);
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
        shader.uniforms.scaleIridescence = { value: this.scaleIridescence };
        shader.uniforms.scaleIridescenceColor = { value: this.scaleIridescenceColor };
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
                uniform int scaleBands;
                uniform float scaleQuantize;
                uniform float scaleSoftness;
                uniform float scaleIridescence;
                uniform vec3 scaleIridescenceColor;
                uniform float anisotropyStrength;
                uniform float anisotropyRotation;
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

                // Apply fish‑scale cel banding
                gl_FragColor.rgb = applyScaleBands(gl_FragColor.rgb);

                // Iridescent scale shimmer: grazing‑angle colour shift
                if (scaleIridescence > 0.0) {
                    float ndotvScale = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float shimmerMask = pow(1.0 - ndotvScale, 3.0) * scaleIridescence;
                    // Hue shift based on grazing angle for the iridescent film effect
                    float hueShift = (1.0 - ndotvScale) * 0.25;
                    vec3 shimmerColor = mix(scaleIridescenceColor, vec3(1.0, 0.95, 0.80), hueShift);
                    gl_FragColor.rgb += shimmerColor * shimmerMask * 0.5;
                }

                // Cool‑cyan rim glow on scale edges
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
            this.scaleBands, this.scaleQuantize, this.scaleSoftness,
            this.scaleIridescence,
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
        this.scaleBands = source.scaleBands;
        this.scaleQuantize = source.scaleQuantize;
        this.scaleSoftness = source.scaleSoftness;
        this.scaleIridescence = source.scaleIridescence;
        this.scaleIridescenceColor.copy(source.scaleIridescenceColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicFishScaleMaterial';
        if (this.ior !== 1.50) data.ior = this.ior;
        if (this.specularIntensity !== 0.75) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.38) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.anisotropy !== 0.70) data.anisotropy = this.anisotropy;
        if (this.anisotropyRotation !== 0.0) data.anisotropyRotation = this.anisotropyRotation;
        if (this.iridescence !== 0.55) data.iridescence = this.iridescence;
        if (this.iridescenceIOR !== 1.30) data.iridescenceIOR = this.iridescenceIOR;
        if (this.transmission !== 0.05) data.transmission = this.transmission;
        if (this.thickness !== 0.002) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.15) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.92, 0.86, 0.78).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularColor.getHex() !== new Color(0.98, 0.96, 0.92).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.scaleBands !== 3) data.scaleBands = this.scaleBands;
        if (this.scaleQuantize !== 0.5) data.scaleQuantize = this.scaleQuantize;
        if (this.scaleSoftness !== 0.08) data.scaleSoftness = this.scaleSoftness;
        if (this.scaleIridescence !== 0.55) data.scaleIridescence = this.scaleIridescence;
        if (this.scaleIridescenceColor.getHex() !== new Color(0.85, 0.92, 1.0).getHex()) data.scaleIridescenceColor = this.scaleIridescenceColor.getHex();
        if (this.rimGlow !== 0.15) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.75, 0.90, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.scaleBands = json.scaleBands ?? this.scaleBands;
        this.scaleQuantize = json.scaleQuantize ?? this.scaleQuantize;
        this.scaleSoftness = json.scaleSoftness ?? this.scaleSoftness;
        this.scaleIridescence = json.scaleIridescence ?? this.scaleIridescence;
        if (json.scaleIridescenceColor !== undefined) this.scaleIridescenceColor.setHex(json.scaleIridescenceColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata
// ---------------------------------------------------------------------------

const OrganicFishScaleMaterialBatchComponent = {
    materialPtr: 'ui32',
    scaleBands: 'ui8',
    scaleQuantize: 'f64',
    scaleSoftness: 'f64',
    scaleIridescence: 'f64',
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
    OrganicFishScaleMaterial,
    OrganicFishScaleMaterialBatch,
    FishScaleScratchPool,
    OrganicFishScaleMaterialBatchComponent,
    OrganicFishScalePresets,
    applyFishScaleCelBanding,
    gradeFishScaleColor,
    generateFishScaleTexture
};

export default OrganicFishScaleMaterial;