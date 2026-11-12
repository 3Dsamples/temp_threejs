// file number : 220
// full path name : src/materials/220_organicbonematerial.js
// description : OrganicBoneMaterial — a ready-to-use bone material for bones,
//               antlers, horns, ivory tusks, and skeletal surfaces. Extends
//               MeshPhysicalMaterial with purpose-built presets for fresh bone,
//               fossilized bone, ivory, antler, horn, and weathered bone.
//               Includes biologically grounded defaults (bone IOR ≈ 1.55,
//               roughness 0.45–0.65, zero metalness, thin-walled transmission
//               for the slightly translucent fresh-bone look, and optional
//               clearcoat for polished/ivory finishes) plus real-time anime
//               stylization: cel-banded bone highlights, marrow-pore
//               approximation, mood tinting, rim glow, and per-instance
//               variation. Includes a procedural bone-pore texture generator
//               using multi-octave fBm with directional Haversian-canal
//               streaks and per-pore hashing.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Organic bone, skeletal surfaces, antlers, horns, ivory tusks,
//            fossilized bone, weathered bone, creature skulls, fantasy bone
//            armor, and any bone surface that needs real-time PBR + anime
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
// Bone presets — biologically grounded PBR parameter sets for bone types.
//
// Reference values (from skeletal PBR references, cgaxis bone texture packs,
// and anatomical literature):
//   - Bone IOR:              ≈ 1.55 (hydroxyapatite + collagen)
//   - Bone roughness:        0.45–0.65 (dry bone)
//   - Polished/ivory:        0.20–0.35 with clearcoat
//   - Metalness:             0.0 (bone is a dielectric)
//   - Fresh bone transmission: subtle (0.05–0.15) for the slightly waxy
//                              subsurface glow of freshly cleaned bone
//   - Antler/horn:           slightly softer, warmer, with more porosity
// ---------------------------------------------------------------------------

const OrganicBonePresets = {
    'fresh-bone': {
        color: [0.92, 0.88, 0.78],
        roughness: 0.55,
        metalness: 0.0,
        clearcoat: 0.05,
        clearcoatRoughness: 0.50,
        transmission: 0.08,
        thickness: 0.01,
        attenuationDistance: 0.06,
        attenuationColor: [0.95, 0.88, 0.72],
        specularIntensity: 0.45,
        specularColor: [0.95, 0.92, 0.85]
    },
    'fossilized-bone': {
        color: [0.52, 0.42, 0.30],
        roughness: 0.68,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.55,
        transmission: 0.02,
        thickness: 0.01,
        attenuationDistance: 0.05,
        attenuationColor: [0.55, 0.42, 0.28],
        specularIntensity: 0.35,
        specularColor: [0.75, 0.68, 0.55]
    },
    'ivory': {
        color: [0.94, 0.90, 0.78],
        roughness: 0.28,
        metalness: 0.0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.15,
        transmission: 0.15,
        thickness: 0.02,
        attenuationDistance: 0.10,
        attenuationColor: [0.98, 0.92, 0.78],
        specularIntensity: 0.58,
        specularColor: [1.0, 0.96, 0.88]
    },
    'antler': {
        color: [0.62, 0.48, 0.32],
        roughness: 0.62,
        metalness: 0.0,
        clearcoat: 0.04,
        clearcoatRoughness: 0.55,
        transmission: 0.06,
        thickness: 0.015,
        attenuationDistance: 0.07,
        attenuationColor: [0.72, 0.55, 0.35],
        specularIntensity: 0.40,
        specularColor: [0.80, 0.72, 0.60]
    },
    'horn': {
        color: [0.22, 0.16, 0.10],
        roughness: 0.52,
        metalness: 0.0,
        clearcoat: 0.08,
        clearcoatRoughness: 0.40,
        transmission: 0.03,
        thickness: 0.015,
        attenuationDistance: 0.05,
        attenuationColor: [0.28, 0.20, 0.12],
        specularIntensity: 0.42,
        specularColor: [0.65, 0.58, 0.50]
    },
    'weathered-bone': {
        color: [0.78, 0.72, 0.62],
        roughness: 0.75,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        transmission: 0.01,
        thickness: 0.01,
        attenuationDistance: 0.04,
        attenuationColor: [0.82, 0.74, 0.62],
        specularIntensity: 0.28,
        specularColor: [0.78, 0.72, 0.62]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable bone scratch records
// ---------------------------------------------------------------------------

class BoneScratchPool {
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

const _boneScratchPool = new BoneScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — bone-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded bone highlights. Bone has soft, warm shading with a subtle
 * waxy sheen — quantizing it into discrete bands produces the crisp anime bone
 * edges seen in hand-drawn skeletal and creature illustrations.
 */
function applyBoneCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.18) {
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
 * Apply mood-based tinting to bone. Warm moods push bone toward warm ivory/
 * amber, cool moods toward cool grey-bone — matching the atmospheric bone
 * tinting seen in desert and fantasy anime scenes.
 */
function gradeBoneColor(color, temperature, saturation, brightness, contrast) {
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

    // Bone-specific temperature bias: warm shift pushes toward ivory/amber,
    // cool shift pushes toward cool grey-bone.
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
 * Generate a procedural bone-pore texture. The algorithm:
 * 1. Multi-octave fBm for the large-scale bone body tone.
 * 2. Hashed Haversian canal streaks: directional stretched noise along the
 *    bone axis producing the characteristic parallel canal streaks.
 * 3. Per-pore hashing: small dark pits scattered on the surface for the
 *    osteocyte lacunae look.
 * 4. Optional fracture-mask: low-frequency blotch for weathering cracks.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateBonePoreTexture(width, height, scale = 0.03, octaves = 4, canalStrength = 0.25, canalDensity = 12.0, poreDensity = 0.15, poreStrength = 0.12, fractureStrength = 0.0) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Multi-octave fBm base ---
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

            // --- 2. Directional Haversian canal streaks ---
            // Stretched along the y-axis (bone length direction)
            const canal = SimplexNoise.noise2D(x * 0.15 * canalDensity, y * 0.02 * canalDensity) * 0.5 + 0.5;
            const canalMask = Math.pow(1.0 - Math.abs(canal * 2.0 - 1.0), 3.0) * canalStrength;

            // --- 3. Per-pore hashed pits ---
            const cellX = Math.floor(x * 0.8);
            const cellY = Math.floor(y * 0.8);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const poreHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;

            let pore = 0;
            if (poreHash > (1.0 - poreDensity)) {
                const h2 = Math.abs(Math.sin(cellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                const h3 = Math.abs(Math.sin(cellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                const cx = (x * 0.8) - Math.floor(x * 0.8) - h2;
                const cy = (y * 0.8) - Math.floor(y * 0.8) - h3;
                const dist = Math.sqrt(cx * cx + cy * cy);
                pore = Math.max(0, 1.0 - dist * 4.0) * poreStrength;
            }

            // --- 4. Optional fracture mask ---
            let fracture = 0;
            if (fractureStrength > 0) {
                const f = SimplexNoise.noise2D(x * 0.008, y * 0.008) * 0.5 + 0.5;
                fracture = Math.max(0, f - 0.65) / 0.35 * fractureStrength;
            }

            // --- Combine ---
            let value = 0.60
                + (fbm - 0.5) * 0.20
                + canalMask * 0.20
                - pore * 0.60
                - fracture * 0.30;

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

const _boneWorld = BitECS.createWorld();
const OrganicBoneMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    boneBands: 'ui8',
    boneQuantize: 'f64',
    boneSoftness: 'f64',
    poreStrength: 'f64',
    canalStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicBoneMaterialBatch {
    constructor() {
        this.world = _boneWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicBoneMaterialComponent, eid);
        OrganicBoneMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicBoneMaterialComponent.boneBands[eid] = material.boneBands;
        OrganicBoneMaterialComponent.boneQuantize[eid] = material.boneQuantize;
        OrganicBoneMaterialComponent.boneSoftness[eid] = material.boneSoftness;
        OrganicBoneMaterialComponent.poreStrength[eid] = material.poreStrength;
        OrganicBoneMaterialComponent.canalStrength[eid] = material.canalStrength;
        OrganicBoneMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicBoneMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicBoneMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicBoneMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicBoneMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicBoneMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicBoneMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicBoneMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.boneBands = OrganicBoneMaterialComponent.boneBands[eid];
            material.boneQuantize = OrganicBoneMaterialComponent.boneQuantize[eid];
            material.boneSoftness = OrganicBoneMaterialComponent.boneSoftness[eid];
            material.poreStrength = OrganicBoneMaterialComponent.poreStrength[eid];
            material.canalStrength = OrganicBoneMaterialComponent.canalStrength[eid];
            material.moodTemperature = OrganicBoneMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicBoneMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicBoneMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicBoneMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicBoneMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicBoneMaterialComponent.variationSeed[eid];

            OrganicBoneMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicBoneMaterial class
// ---------------------------------------------------------------------------

class OrganicBoneMaterial extends MeshPhysicalMaterial {
    static {
        _boneScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicBoneMaterial = true;
        this.type = 'OrganicBoneMaterial';

        // -------------------------------------------------------------------
        // Bone-specific PBR defaults (fresh bone baseline)
        // -------------------------------------------------------------------
        this.ior = 1.55;
        this.specularIntensity = 0.45;
        this.roughness = 0.55;
        this.metalness = 0.0;
        this.specularColor = new Color(0.95, 0.92, 0.85);
        this.color = new Color(0.92, 0.88, 0.78);

        // Clearcoat for slight waxy surface
        this.clearcoat = 0.05;
        this.clearcoatRoughness = 0.50;

        // Thin-walled transmission for subsurface waxy glow
        this.transmission = 0.08;
        this.thickness = 0.01;
        this.attenuationDistance = 0.06;
        this.attenuationColor = new Color(0.95, 0.88, 0.72);

        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — bone-specific
        // -------------------------------------------------------------------
        this.boneBands = 3;
        this.boneQuantize = 0.4;
        this.boneSoftness = 0.18;
        this.poreStrength = 0.12;
        this.canalStrength = 0.25;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.95, 0.88, 0.72);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (bone leans semi-realistic)
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

    applyBoneBanding(baseColor, output) {
        return applyBoneCelBanding(
            baseColor,
            output,
            this.boneBands,
            this.boneQuantize,
            this.boneSoftness
        );
    }

    updateMoodColor() {
        gradeBoneColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic bone preset to this material.
     * @param {string} presetName - One of the keys of `OrganicBonePresets`.
     * @returns {OrganicBoneMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicBonePresets[presetName];
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
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness per preset
        if (presetName === 'ivory') {
            this.boneSoftness = 0.10;
            this.boneBands = 4;
        } else if (presetName === 'fossilized-bone' || presetName === 'weathered-bone') {
            this.boneSoftness = 0.28;
            this.boneBands = 2;
        } else if (presetName === 'horn') {
            this.boneSoftness = 0.15;
            this.boneBands = 3;
        } else {
            this.boneSoftness = 0.18;
            this.boneBands = 3;
        }

        this.updateMoodColor();
        return this;
    }

    generateBonePoreTexture(width, height, scale = 0.03, octaves = 4, canalStrength = 0.25, canalDensity = 12.0, poreDensity = 0.15, poreStrength = 0.12) {
        return generateBonePoreTexture(width, height, scale, octaves, canalStrength, canalDensity, poreDensity, poreStrength, 0.0);
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

        shader.uniforms.boneBands = { value: this.boneBands };
        shader.uniforms.boneQuantize = { value: this.boneQuantize };
        shader.uniforms.boneSoftness = { value: this.boneSoftness };
        shader.uniforms.poreStrength = { value: this.poreStrength };
        shader.uniforms.canalStrength = { value: this.canalStrength };
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
                uniform int boneBands;
                uniform float boneQuantize;
                uniform float boneSoftness;
                uniform float poreStrength;
                uniform float canalStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyBoneBands(vec3 baseColor) {
                    if (boneBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(boneBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * boneSoftness;
                    float finalLum = mix(lum, softQuantized, boneQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply bone cel banding
                gl_FragColor.rgb = applyBoneBands(gl_FragColor.rgb);

                // Pore approximation (dark speckles)
                if (poreStrength > 0.0) {
                    vec2 poreUV = vUv * 80.0;
                    vec2 poreCell = floor(poreUV);
                    float poreHash = fract(sin(dot(poreCell, vec2(12.9898, 78.233))) * 43758.5453);
                    float poreMask = poreHash > 0.85 ? 1.0 : 0.0;
                    gl_FragColor.rgb *= (1.0 - poreMask * poreStrength);
                }

                // Haversian canal streaks (directional darkening)
                if (canalStrength > 0.0) {
                    float canal = sin(vUv.y * 60.0 + vUv.x * 4.0) * 0.5 + 0.5;
                    float canalMask = pow(canal, 4.0) * canalStrength;
                    gl_FragColor.rgb *= (1.0 - canalMask * 0.4);
                }

                // Warm rim glow on bone edges
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
            this.boneBands, this.boneQuantize, this.boneSoftness,
            this.poreStrength, this.canalStrength,
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
        this.boneBands = source.boneBands;
        this.boneQuantize = source.boneQuantize;
        this.boneSoftness = source.boneSoftness;
        this.poreStrength = source.poreStrength;
        this.canalStrength = source.canalStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicBoneMaterial';
        if (this.ior !== 1.55) data.ior = this.ior;
        if (this.specularIntensity !== 0.45) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.55) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.05) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.50) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.08) data.transmission = this.transmission;
        if (this.thickness !== 0.01) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.06) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.95, 0.88, 0.72).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularColor.getHex() !== new Color(0.95, 0.92, 0.85).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.boneBands !== 3) data.boneBands = this.boneBands;
        if (this.boneQuantize !== 0.4) data.boneQuantize = this.boneQuantize;
        if (this.boneSoftness !== 0.18) data.boneSoftness = this.boneSoftness;
        if (this.poreStrength !== 0.12) data.poreStrength = this.poreStrength;
        if (this.canalStrength !== 0.25) data.canalStrength = this.canalStrength;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.95, 0.88, 0.72).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.boneBands = json.boneBands ?? this.boneBands;
        this.boneQuantize = json.boneQuantize ?? this.boneQuantize;
        this.boneSoftness = json.boneSoftness ?? this.boneSoftness;
        this.poreStrength = json.poreStrength ?? this.poreStrength;
        this.canalStrength = json.canalStrength ?? this.canalStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicBoneMaterialBatchComponent = {
    materialPtr: 'ui32',
    boneBands: 'ui8',
    boneQuantize: 'f64',
    boneSoftness: 'f64',
    poreStrength: 'f64',
    canalStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicBoneMaterial,
    OrganicBoneMaterialBatch,
    BoneScratchPool,
    OrganicBoneMaterialBatchComponent,
    OrganicBonePresets,
    applyBoneCelBanding,
    gradeBoneColor,
    generateBonePoreTexture
};

export default OrganicBoneMaterial;