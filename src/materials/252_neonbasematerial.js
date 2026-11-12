// file number : 252
// full path name : src/materials/252_neonbasematerial.js
// description : NeonBaseMaterial — foundational neon-tube material for
//               real-time rendering of glowing neon beams. Extends
//               MeshPhysicalMaterial with neon-specific defaults grounded in
//               real-time neon rendering references: a dielectric glass tube
//               (metalness 0.0, IOR ≈ 1.50, roughness 0.05–0.15), a highly
//               emissive inner gas core (emissiveIntensity 4–8), and a
//               clearcoat for the polished outer glass. The emissive value is
//               deliberately pushed above 1.0 so HDR pipelines trigger bloom
//               post-processing for the characteristic neon glow[reference:0].
//               Adds real-time anime stylization: cel-banded neon highlights,
//               core-glow radial falloff, mood tinting, rim glow, and
//               per-instance variation. Includes a procedural neon-glass
//               striation texture generator using multi-octave fBm with
//               directional highlight streaks. All imports resolve to the
//               internal Threejs_gl repository tree; no CDN dependencies.
// best for : Base neon tube material for neon signs, glowing neon beams,
//            cyberpunk neon strips, gas-discharge tubes, neon letters, neon
//            accent lighting, and any emissive neon surface that needs
//            real-time PBR + anime stylization.
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

/** @type {Quat} Scratch quaternion for rotation staging. */
const _scratchQuat = new Quat();

// ---------------------------------------------------------------------------
// Neon base presets — physically grounded parameter sets for neon gas colours.
//
// Reference values:
//   - Neon glass IOR:            1.50 (typical soda-lime / borosilicate)
//   - Glass roughness:           0.05–0.15 (polished outer tube)
//   - Metalness:                 0.0 (glass is a dielectric)
//   - Emissive intensity:        4.0–8.0 (HDR values above 1.0 trigger bloom)[reference:1]
//   - Clearcoat:                 0.8–1.0 (polished glass surface)
//   - Transmission:              0.6–0.85 (thin tube wall)
//   - Core colour matches the gas (neon=red-orange, argon=blue, etc.)
//   - Neon gas glow:             two prominent emission lines; colour stays
//                                consistent across intensity[reference:2]
// ---------------------------------------------------------------------------

const NeonBasePresets = {
    'neon-red': {
        color: [0.85, 0.12, 0.08],
        roughness: 0.08,
        metalness: 0.0,
        clearcoat: 0.90,
        clearcoatRoughness: 0.04,
        transmission: 0.75,
        thickness: 0.02,
        attenuationDistance: 0.05,
        attenuationColor: [0.90, 0.15, 0.10],
        ior: 1.50,
        specularIntensity: 0.90,
        specularColor: [1.0, 0.85, 0.80],
        emissive: [1.0, 0.15, 0.10],
        emissiveIntensity: 6.0,
        glowRadius: 0.35,
        striationStrength: 0.15
    },
    'neon-orange': {
        color: [0.90, 0.42, 0.08],
        roughness: 0.08,
        metalness: 0.0,
        clearcoat: 0.90,
        clearcoatRoughness: 0.04,
        transmission: 0.75,
        thickness: 0.02,
        attenuationDistance: 0.05,
        attenuationColor: [0.95, 0.48, 0.10],
        ior: 1.50,
        specularIntensity: 0.90,
        specularColor: [1.0, 0.92, 0.80],
        emissive: [1.0, 0.48, 0.08],
        emissiveIntensity: 5.5,
        glowRadius: 0.35,
        striationStrength: 0.15
    },
    'neon-blue': {
        color: [0.10, 0.32, 0.92],
        roughness: 0.08,
        metalness: 0.0,
        clearcoat: 0.90,
        clearcoatRoughness: 0.04,
        transmission: 0.75,
        thickness: 0.02,
        attenuationDistance: 0.05,
        attenuationColor: [0.15, 0.40, 0.95],
        ior: 1.50,
        specularIntensity: 0.90,
        specularColor: [0.82, 0.88, 1.0],
        emissive: [0.12, 0.42, 1.0],
        emissiveIntensity: 6.5,
        glowRadius: 0.35,
        striationStrength: 0.15
    },
    'neon-green': {
        color: [0.18, 0.85, 0.28],
        roughness: 0.08,
        metalness: 0.0,
        clearcoat: 0.90,
        clearcoatRoughness: 0.04,
        transmission: 0.75,
        thickness: 0.02,
        attenuationDistance: 0.05,
        attenuationColor: [0.22, 0.90, 0.32],
        ior: 1.50,
        specularIntensity: 0.90,
        specularColor: [0.82, 1.0, 0.85],
        emissive: [0.20, 1.0, 0.32],
        emissiveIntensity: 6.0,
        glowRadius: 0.35,
        striationStrength: 0.15
    },
    'neon-purple': {
        color: [0.62, 0.15, 0.88],
        roughness: 0.08,
        metalness: 0.0,
        clearcoat: 0.90,
        clearcoatRoughness: 0.04,
        transmission: 0.75,
        thickness: 0.02,
        attenuationDistance: 0.05,
        attenuationColor: [0.68, 0.20, 0.92],
        ior: 1.50,
        specularIntensity: 0.90,
        specularColor: [0.92, 0.82, 1.0],
        emissive: [0.72, 0.20, 1.0],
        emissiveIntensity: 6.0,
        glowRadius: 0.35,
        striationStrength: 0.15
    },
    'neon-pink': {
        color: [0.92, 0.18, 0.62],
        roughness: 0.08,
        metalness: 0.0,
        clearcoat: 0.90,
        clearcoatRoughness: 0.04,
        transmission: 0.75,
        thickness: 0.02,
        attenuationDistance: 0.05,
        attenuationColor: [0.95, 0.22, 0.68],
        ior: 1.50,
        specularIntensity: 0.90,
        specularColor: [1.0, 0.82, 0.92],
        emissive: [1.0, 0.22, 0.68],
        emissiveIntensity: 6.0,
        glowRadius: 0.35,
        striationStrength: 0.15
    },
    'anime-neon': {
        color: [0.92, 0.92, 0.96],
        roughness: 0.04,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        transmission: 0.85,
        thickness: 0.02,
        attenuationDistance: 0.06,
        attenuationColor: [0.96, 0.96, 1.0],
        ior: 1.50,
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0],
        emissive: [0.95, 0.95, 1.0],
        emissiveIntensity: 8.0,
        glowRadius: 0.45,
        striationStrength: 0.10
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable neon scratch records
// ---------------------------------------------------------------------------

class NeonBaseScratchPool {
    /**
     * @param {number} [capacity=64] - Initial pool capacity.
     */
    constructor(capacity = 64) {
        /** @type {Object[]} */
        this._free = [];
        for (let i = 0; i < capacity; i++) {
            this._free.push(this._createRecord());
        }
    }

    /**
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Vec3, view: Vec3}}
     */
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

/** @type {NeonBaseScratchPool} */
const _neonBaseScratchPool = new NeonBaseScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — neon-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded neon highlights. Neon glass has extremely crisp specular
 * edges — quantizing the luminance into discrete bands produces the flat
 * anime neon shine.
 * @param {Color} baseColor
 * @param {Color} output - Modified in place.
 * @param {number} bands
 * @param {number} quantizeAmount
 * @param {number} [softness=0.04]
 * @returns {Color}
 */
function applyNeonCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.04) {
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
 * Apply mood-based tinting to neon. Warm moods push neon toward warm
 * amber-magenta, cool moods toward cool cyan-blue — matching the atmospheric
 * neon tinting in stylized cyberpunk scenes.
 * @param {Color} color - Modified in place.
 * @param {number} temperature
 * @param {number} saturation
 * @param {number} brightness
 * @param {number} contrast
 * @returns {Color}
 */
function gradeNeonColor(color, temperature, saturation, brightness, contrast) {
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

    // Neon-specific temperature bias: warm shift pushes toward amber-magenta;
    // cool shift pushes toward cyan-blue.
    r += temperature * 0.04;
    g += temperature * 0.015;
    b -= temperature * 0.030;

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
 * Generate a procedural neon-glass striation texture. The algorithm:
 * 1. Directional highlight streaks: high-frequency noise stretched along the
 *    tube axis, producing the reflective striations of the polished glass.
 * 2. Inner-core mottle: low-frequency fBm producing the subtle inner-gas
 *    tube variation.
 * 3. Fine micro-grain: high-frequency mottle for the glass surface texture.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.02]
 * @param {number} [octaves=4]
 * @param {number} [striationStrength=0.15]
 * @param {number} [striationDensity=8.0]
 * @param {number} [coreMottleStrength=0.06]
 * @returns {Uint8Array}
 */
function generateNeonGlassStriationTexture(width, height, scale = 0.02, octaves = 4, striationStrength = 0.15, striationDensity = 8.0, coreMottleStrength = 0.06) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Directional highlight streaks (along tube axis) ---
            const striation = SimplexNoise.noise2D(x * 0.005 * striationDensity, y * 0.18 * striationDensity) * 0.5 + 0.5;
            const striationMask = Math.pow(1.0 - Math.abs(striation * 2.0 - 1.0), 3.0) * striationStrength;

            // --- 2. Inner-core mottle ---
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
            const coreMottle = (fbm - 0.5) * coreMottleStrength;

            // --- 3. Fine micro-grain ---
            const grain = SimplexNoise.noise2D(x * 0.7, y * 0.7) * 0.04;

            // --- Combine ---
            let value = 0.55 - striationMask * 0.20 + coreMottle + grain;
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

const _neonBaseWorld = BitECS.createWorld();
const NeonBaseMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    neonBands: 'ui8',
    neonQuantize: 'f64',
    neonSoftness: 'f64',
    glowRadius: 'f64',
    striationStrength: 'f64',
    striationDensity: 'f64',
    coreMottleStrength: 'f64',
    emissiveIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class NeonBaseMaterialBatch {
    constructor() {
        this.world = _neonBaseWorld;
        /** @type {NeonBaseMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * @param {NeonBaseMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, NeonBaseMaterialComponent, eid);
        NeonBaseMaterialComponent.materialPtr[eid] = this.materials.length;
        NeonBaseMaterialComponent.neonBands[eid] = material.neonBands;
        NeonBaseMaterialComponent.neonQuantize[eid] = material.neonQuantize;
        NeonBaseMaterialComponent.neonSoftness[eid] = material.neonSoftness;
        NeonBaseMaterialComponent.glowRadius[eid] = material.glowRadius;
        NeonBaseMaterialComponent.striationStrength[eid] = material.striationStrength;
        NeonBaseMaterialComponent.striationDensity[eid] = material.striationDensity;
        NeonBaseMaterialComponent.coreMottleStrength[eid] = material.coreMottleStrength;
        NeonBaseMaterialComponent.emissiveIntensity[eid] = material.emissiveIntensity;
        NeonBaseMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        NeonBaseMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        NeonBaseMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        NeonBaseMaterialComponent.moodContrast[eid] = material.moodContrast;
        NeonBaseMaterialComponent.rimGlow[eid] = material.rimGlow;
        NeonBaseMaterialComponent.variationSeed[eid] = material.variationSeed;
        NeonBaseMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[NeonBaseMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.neonBands = NeonBaseMaterialComponent.neonBands[eid];
            material.neonQuantize = NeonBaseMaterialComponent.neonQuantize[eid];
            material.neonSoftness = NeonBaseMaterialComponent.neonSoftness[eid];
            material.glowRadius = NeonBaseMaterialComponent.glowRadius[eid];
            material.striationStrength = NeonBaseMaterialComponent.striationStrength[eid];
            material.striationDensity = NeonBaseMaterialComponent.striationDensity[eid];
            material.coreMottleStrength = NeonBaseMaterialComponent.coreMottleStrength[eid];
            material.emissiveIntensity = NeonBaseMaterialComponent.emissiveIntensity[eid];
            material.moodTemperature = NeonBaseMaterialComponent.moodTemperature[eid];
            material.moodSaturation = NeonBaseMaterialComponent.moodSaturation[eid];
            material.moodBrightness = NeonBaseMaterialComponent.moodBrightness[eid];
            material.moodContrast = NeonBaseMaterialComponent.moodContrast[eid];
            material.rimGlow = NeonBaseMaterialComponent.rimGlow[eid];
            material.variationSeed = NeonBaseMaterialComponent.variationSeed[eid];

            NeonBaseMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main NeonBaseMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use neon-tube material for real-time rendering of glowing neon
 * beams. Extends MeshPhysicalMaterial with neon-specific PBR defaults and
 * real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class NeonBaseMaterial extends MeshPhysicalMaterial {
    static {
        _neonBaseScratchPool.warm(32);
    }

    /**
     * @param {Object} [parameters]
     */
    constructor(parameters) {
        super();

        this.isNeonBaseMaterial = true;
        this.type = 'NeonBaseMaterial';

        // -------------------------------------------------------------------
        // Neon-specific PBR defaults (neon-red baseline)
        // -------------------------------------------------------------------
        this.ior = 1.50;
        this.specularIntensity = 0.90;
        this.roughness = 0.08;
        this.metalness = 0.0;
        this.specularColor = new Color(1.0, 0.85, 0.80);
        this.color = new Color(0.85, 0.12, 0.08);

        // Clearcoat for the polished glass tube
        this.clearcoat = 0.90;
        this.clearcoatRoughness = 0.04;

        // Thin-walled transmission for the glass tube wall
        this.transmission = 0.75;
        this.thickness = 0.02;
        this.attenuationDistance = 0.05;
        this.attenuationColor = new Color(0.90, 0.15, 0.10);

        // Emissive gas glow — the core neon feature
        this.emissive = new Color(1.0, 0.15, 0.10);
        this.emissiveIntensity = 6.0;

        // Iridescence off (neon is monochromatic)
        this.iridescence = 0.0;
        this.iridescenceIOR = 1.30;
        this.iridescenceThicknessRange = [100, 400];

        // Sheen off
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — neon-specific
        // -------------------------------------------------------------------
        this.neonBands = 4;
        this.neonQuantize = 0.5;
        this.neonSoftness = 0.04;

        // Glow / striation / mottle controls
        this.glowRadius = 0.35;
        this.striationStrength = 0.15;
        this.striationDensity = 8.0;
        this.coreMottleStrength = 0.06;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.15;
        this.rimGlowColor = new Color(1.0, 0.85, 0.80);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (neon leans semi-realistic)
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

    /**
     * @param {Color} baseColor
     * @param {Color} output
     * @returns {Color}
     */
    applyNeonBanding(baseColor, output) {
        return applyNeonCelBanding(
            baseColor,
            output,
            this.neonBands,
            this.neonQuantize,
            this.neonSoftness
        );
    }

    /**
     * @returns {NeonBaseMaterial}
     */
    updateMoodColor() {
        gradeNeonColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named neon preset.
     * @param {string} presetName - One of the keys of `NeonBasePresets`.
     * @returns {NeonBaseMaterial}
     */
    applyPreset(presetName) {
        const preset = NeonBasePresets[presetName];
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
        this.ior = preset.ior;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.emissive.setRGB(preset.emissive[0], preset.emissive[1], preset.emissive[2], ColorManagement.workingColorSpace);
        this.emissiveIntensity = preset.emissiveIntensity;
        this.glowRadius = preset.glowRadius;
        this.striationStrength = preset.striationStrength;

        // Per-preset anime tuning
        if (presetName === 'anime-neon') {
            this.neonSoftness = 0.02;
            this.neonBands = 5;
        } else if (presetName === 'neon-red' || presetName === 'neon-orange') {
            this.neonSoftness = 0.04;
            this.neonBands = 4;
        } else {
            this.neonSoftness = 0.04;
            this.neonBands = 4;
        }

        this.updateMoodColor();
        return this;
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.02]
     * @param {number} [octaves=4]
     * @param {number} [striationStrength=0.15]
     * @param {number} [striationDensity=8.0]
     * @returns {Uint8Array}
     */
    generateNeonGlassStriationTexture(width, height, scale = 0.02, octaves = 4, striationStrength = 0.15, striationDensity = 8.0) {
        return generateNeonGlassStriationTexture(width, height, scale, octaves, striationStrength, striationDensity, this.coreMottleStrength);
    }

    /**
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * @returns {Promise<NeonBaseMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.neonBands = { value: this.neonBands };
        shader.uniforms.neonQuantize = { value: this.neonQuantize };
        shader.uniforms.neonSoftness = { value: this.neonSoftness };
        shader.uniforms.glowRadius = { value: this.glowRadius };
        shader.uniforms.striationStrength = { value: this.striationStrength };
        shader.uniforms.striationDensity = { value: this.striationDensity };
        shader.uniforms.coreMottleStrength = { value: this.coreMottleStrength };
        shader.uniforms.emissiveIntensity = { value: this.emissiveIntensity };
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
                uniform int neonBands;
                uniform float neonQuantize;
                uniform float neonSoftness;
                uniform float glowRadius;
                uniform float striationStrength;
                uniform float striationDensity;
                uniform float coreMottleStrength;
                uniform float emissiveIntensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyNeonBands(vec3 baseColor) {
                    if (neonBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(neonBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * neonSoftness;
                    float finalLum = mix(lum, softQuantized, neonQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply neon cel banding
                gl_FragColor.rgb = applyNeonBands(gl_FragColor.rgb);

                // Core-glow radial falloff: brightens the tube centre
                {
                    vec2 centreUV = vUv - vec2(0.5);
                    float radialDist = length(centreUV) * 2.0;
                    float coreGlow = max(0.0, 1.0 - radialDist / glowRadius);
                    gl_FragColor.rgb += emissive * coreGlow * 0.25;
                }

                // Glass striation streaks
                if (striationStrength > 0.0) {
                    vec2 striationUV = vec2(vUv.x * 4.0, vUv.y * striationDensity * 6.0);
                    float striationHash = fract(sin(floor(striationUV.y) * 12.9898 + variationOffset) * 43758.5453);
                    float striationMask = smoothstep(0.55, 0.0, abs(fract(striationUV.x) - 0.5)) * (striationHash > 0.7 ? 1.0 : 0.0);
                    gl_FragColor.rgb *= (1.0 - striationMask * striationStrength * 0.20);
                }

                // Core mottle
                if (coreMottleStrength > 0.0) {
                    float mottle = sin(vUv.x * 15.0 + variationOffset) * cos(vUv.y * 15.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + mottle * coreMottleStrength * 0.10);
                }

                // Warm rim glow on neon edges
                if (rimGlow > 0.0) {
                    float rimFactor = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    gl_FragColor.rgb += rimGlowColor * rimGlow * rimFactor;
                }
                `
            );
    }

    /**
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.ior, this.specularIntensity, this.roughness, this.metalness,
            this.clearcoat, this.clearcoatRoughness,
            this.transmission, this.thickness, this.attenuationDistance,
            this.emissiveIntensity,
            this.neonBands, this.neonQuantize, this.neonSoftness,
            this.glowRadius, this.striationStrength, this.striationDensity,
            this.coreMottleStrength,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    /**
     * @param {NeonBaseMaterial} source
     * @returns {NeonBaseMaterial}
     */
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
        this.emissive.copy(source.emissive);
        this.emissiveIntensity = source.emissiveIntensity;
        this.neonBands = source.neonBands;
        this.neonQuantize = source.neonQuantize;
        this.neonSoftness = source.neonSoftness;
        this.glowRadius = source.glowRadius;
        this.striationStrength = source.striationStrength;
        this.striationDensity = source.striationDensity;
        this.coreMottleStrength = source.coreMottleStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    /**
     * @param {?(Object|string)} meta
     * @returns {Object}
     */
    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'NeonBaseMaterial';

        if (this.ior !== 1.50) data.ior = this.ior;
        if (this.specularIntensity !== 0.90) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.08) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.90) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.04) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.75) data.transmission = this.transmission;
        if (this.thickness !== 0.02) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.05) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.90, 0.15, 0.10).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.emissive.getHex() !== new Color(1.0, 0.15, 0.10).getHex()) data.emissive = this.emissive.getHex();
        if (this.emissiveIntensity !== 6.0) data.emissiveIntensity = this.emissiveIntensity;
        if (this.specularColor.getHex() !== new Color(1.0, 0.85, 0.80).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.neonBands !== 4) data.neonBands = this.neonBands;
        if (this.neonQuantize !== 0.5) data.neonQuantize = this.neonQuantize;
        if (this.neonSoftness !== 0.04) data.neonSoftness = this.neonSoftness;
        if (this.glowRadius !== 0.35) data.glowRadius = this.glowRadius;
        if (this.striationStrength !== 0.15) data.striationStrength = this.striationStrength;
        if (this.striationDensity !== 8.0) data.striationDensity = this.striationDensity;
        if (this.coreMottleStrength !== 0.06) data.coreMottleStrength = this.coreMottleStrength;
        if (this.rimGlow !== 0.15) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 0.85, 0.80).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * @param {Object} json
     * @returns {NeonBaseMaterial}
     */
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
        if (json.emissive !== undefined) this.emissive.setHex(json.emissive);
        this.emissiveIntensity = json.emissiveIntensity ?? this.emissiveIntensity;
        this.neonBands = json.neonBands ?? this.neonBands;
        this.neonQuantize = json.neonQuantize ?? this.neonQuantize;
        this.neonSoftness = json.neonSoftness ?? this.neonSoftness;
        this.glowRadius = json.glowRadius ?? this.glowRadius;
        this.striationStrength = json.striationStrength ?? this.striationStrength;
        this.striationDensity = json.striationDensity ?? this.striationDensity;
        this.coreMottleStrength = json.coreMottleStrength ?? this.coreMottleStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const NeonBaseMaterialBatchComponent = {
    materialPtr: 'ui32',
    neonBands: 'ui8',
    neonQuantize: 'f64',
    neonSoftness: 'f64',
    glowRadius: 'f64',
    striationStrength: 'f64',
    striationDensity: 'f64',
    coreMottleStrength: 'f64',
    emissiveIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    NeonBaseMaterial,
    NeonBaseMaterialBatch,
    NeonBaseScratchPool,
    NeonBaseMaterialBatchComponent,
    NeonBasePresets,
    applyNeonCelBanding,
    gradeNeonColor,
    generateNeonGlassStriationTexture
};

export default NeonBaseMaterial;