// file number : 254
// full path name : src/materials/254_laserwhitecorebasematerial.js
// description : LaserWhiteCoreBaseMaterial — foundational laser material with
//               a white-hot central core and a coloured halo, for real-time
//               rendering of laser beams, plasma shots, and energy projectiles.
//               Extends MeshPhysicalMaterial with laser-specific defaults
//               grounded in real-time laser rendering references: a pure white
//               HDR emissive core (emissiveIntensity 8–20, well above 1.0 so
//               bloom post-processing produces the white core), a coloured
//               halo ring that surrounds the core, additive-style transparent
//               blending, and depthWrite disabled so overlapping beams blend
//               additively. Adds real-time anime stylization: cel-banded beam
//               highlights, white-core radial falloff, halo ring approximation,
//               mood tinting, rim glow, and per-instance variation. Includes a
//               procedural laser-pulse texture generator using multi-octave
//               fBm with directional energy streaks. All imports resolve to
//               the internal Threejs_gl repository tree; no CDN dependencies.
// best for : Base laser material for laser beams, plasma shots, energy
//            projectiles, sci-fi weapon fire, magic bolts, glowing beams with
//            a white hot core, and any emissive beam surface that needs
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
// Laser white-core presets — physically grounded parameter sets.
//
// Reference values (from real-time laser rendering references, WebGL laser
// shaders, and HDR bloom guidelines):
//   - Core emissive:       pure white, HDR intensity 8–20 (>>1 triggers bloom)
//   - Halo colour:         saturated brand colour surrounding the white core
//   - Core radius:         narrow (~0.10–0.20 of the beam diameter)
//   - Halo radius:         wider (~0.35–0.55 of the beam diameter)
//   - Blending:            additive for overlapping beams
//   - depthWrite:          false so beams stack additively
//   - Beam roughness:      0.0 (pure emissive, no specular response)
// ---------------------------------------------------------------------------

const LaserWhiteCorePresets = {
    'laser-red': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 12.0,
        coreRadius: 0.18,
        haloColor: [1.0, 0.10, 0.06],
        haloRadius: 0.48,
        beamColor: [0.60, 0.04, 0.03],
        roughness: 0.0,
        metalness: 0.0,
        opacity: 0.85,
        pulseStrength: 0.25,
        pulseFrequency: 3.0,
        energyStreakStrength: 0.20
    },
    'laser-blue': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 12.0,
        coreRadius: 0.18,
        haloColor: [0.10, 0.42, 1.0],
        haloRadius: 0.48,
        beamColor: [0.04, 0.18, 0.60],
        roughness: 0.0,
        metalness: 0.0,
        opacity: 0.85,
        pulseStrength: 0.25,
        pulseFrequency: 3.0,
        energyStreakStrength: 0.20
    },
    'laser-green': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 12.0,
        coreRadius: 0.18,
        haloColor: [0.15, 1.0, 0.30],
        haloRadius: 0.48,
        beamColor: [0.04, 0.55, 0.15],
        roughness: 0.0,
        metalness: 0.0,
        opacity: 0.85,
        pulseStrength: 0.25,
        pulseFrequency: 3.0,
        energyStreakStrength: 0.20
    },
    'laser-purple': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 12.0,
        coreRadius: 0.18,
        haloColor: [0.65, 0.15, 1.0],
        haloRadius: 0.48,
        beamColor: [0.28, 0.04, 0.55],
        roughness: 0.0,
        metalness: 0.0,
        opacity: 0.85,
        pulseStrength: 0.25,
        pulseFrequency: 3.0,
        energyStreakStrength: 0.20
    },
    'laser-cyan': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 12.0,
        coreRadius: 0.18,
        haloColor: [0.10, 0.92, 1.0],
        haloRadius: 0.48,
        beamColor: [0.04, 0.48, 0.55],
        roughness: 0.0,
        metalness: 0.0,
        opacity: 0.85,
        pulseStrength: 0.25,
        pulseFrequency: 3.0,
        energyStreakStrength: 0.20
    },
    'anime-laser': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 20.0,
        coreRadius: 0.22,
        haloColor: [1.0, 0.55, 0.85],
        haloRadius: 0.55,
        beamColor: [0.65, 0.30, 0.55],
        roughness: 0.0,
        metalness: 0.0,
        opacity: 0.95,
        pulseStrength: 0.45,
        pulseFrequency: 6.0,
        energyStreakStrength: 0.30
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable laser scratch records
// ---------------------------------------------------------------------------

class LaserWhiteCoreScratchPool {
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

/** @type {LaserWhiteCoreScratchPool} */
const _laserWhiteCoreScratchPool = new LaserWhiteCoreScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — laser-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded laser highlights. Laser beams have crisp emissive bands
 * from the HDR core out through the coloured halo — quantizing the luminance
 * into discrete bands produces the flat anime laser shine.
 * @param {Color} baseColor
 * @param {Color} output - Modified in place.
 * @param {number} bands
 * @param {number} quantizeAmount
 * @param {number} [softness=0.03]
 * @returns {Color}
 */
function applyLaserCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.03) {
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
 * Apply mood-based tinting to the laser halo. Warm moods push the halo toward
 * warm magenta-amber, cool moods toward cool cyan-blue — matching the
 * atmospheric laser tinting in stylized sci-fi and anime scenes.
 * @param {Color} color - Modified in place.
 * @param {number} temperature
 * @param {number} saturation
 * @param {number} brightness
 * @param {number} contrast
 * @returns {Color}
 */
function gradeLaserColor(color, temperature, saturation, brightness, contrast) {
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

    // Laser-specific temperature bias: warm shift pushes toward magenta-amber;
    // cool shift pushes toward cyan-blue.
    r += temperature * 0.045;
    g += temperature * 0.012;
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
 * Generate a procedural laser-pulse texture. The algorithm:
 * 1. Directional energy streaks: high-frequency noise stretched along the
 *    beam axis, producing the travelling-pulse striations of an energy beam.
 * 2. Radial energy rings: low-frequency sinusoid on the beam axis producing
 *    the pulse rings.
 * 3. Fine micro-grain: high-frequency mottle for the plasma surface texture.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.02]
 * @param {number} [octaves=4]
 * @param {number} [pulseStrength=0.25]
 * @param {number} [pulseFrequency=3.0]
 * @param {number} [streakStrength=0.20]
 * @returns {Uint8Array}
 */
function generateLaserPulseTexture(width, height, scale = 0.02, octaves = 4, pulseStrength = 0.25, pulseFrequency = 3.0, streakStrength = 0.20) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Directional energy streaks ---
            const streak = SimplexNoise.noise2D(x * 0.18, y * 0.005) * 0.5 + 0.5;
            const streakMask = Math.pow(1.0 - Math.abs(streak * 2.0 - 1.0), 3.0) * streakStrength;

            // --- 2. Radial energy rings ---
            const pulse = Math.sin((y / height) * pulseFrequency * Math.PI * 2.0) * 0.5 + 0.5;
            const pulseMask = pulse * pulseStrength;

            // --- 3. Fine micro-grain ---
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
            const grain = (fbm - 0.5) * 0.06;

            // --- Combine ---
            let value = 0.55 + pulseMask * 0.25 + streakMask * 0.15 + grain;
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

const _laserWhiteCoreWorld = BitECS.createWorld();
const LaserWhiteCoreMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    laserBands: 'ui8',
    laserQuantize: 'f64',
    laserSoftness: 'f64',
    coreIntensity: 'f64',
    coreRadius: 'f64',
    haloRadius: 'f64',
    haloColorR: 'f64',
    haloColorG: 'f64',
    haloColorB: 'f64',
    pulseStrength: 'f64',
    pulseFrequency: 'f64',
    energyStreakStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class LaserWhiteCoreMaterialBatch {
    constructor() {
        this.world = _laserWhiteCoreWorld;
        /** @type {LaserWhiteCoreBaseMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * @param {LaserWhiteCoreBaseMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, LaserWhiteCoreMaterialComponent, eid);
        LaserWhiteCoreMaterialComponent.materialPtr[eid] = this.materials.length;
        LaserWhiteCoreMaterialComponent.laserBands[eid] = material.laserBands;
        LaserWhiteCoreMaterialComponent.laserQuantize[eid] = material.laserQuantize;
        LaserWhiteCoreMaterialComponent.laserSoftness[eid] = material.laserSoftness;
        LaserWhiteCoreMaterialComponent.coreIntensity[eid] = material.coreIntensity;
        LaserWhiteCoreMaterialComponent.coreRadius[eid] = material.coreRadius;
        LaserWhiteCoreMaterialComponent.haloRadius[eid] = material.haloRadius;
        LaserWhiteCoreMaterialComponent.haloColorR[eid] = material.haloColor.r;
        LaserWhiteCoreMaterialComponent.haloColorG[eid] = material.haloColor.g;
        LaserWhiteCoreMaterialComponent.haloColorB[eid] = material.haloColor.b;
        LaserWhiteCoreMaterialComponent.pulseStrength[eid] = material.pulseStrength;
        LaserWhiteCoreMaterialComponent.pulseFrequency[eid] = material.pulseFrequency;
        LaserWhiteCoreMaterialComponent.energyStreakStrength[eid] = material.energyStreakStrength;
        LaserWhiteCoreMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        LaserWhiteCoreMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        LaserWhiteCoreMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        LaserWhiteCoreMaterialComponent.moodContrast[eid] = material.moodContrast;
        LaserWhiteCoreMaterialComponent.rimGlow[eid] = material.rimGlow;
        LaserWhiteCoreMaterialComponent.variationSeed[eid] = material.variationSeed;
        LaserWhiteCoreMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[LaserWhiteCoreMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.laserBands = LaserWhiteCoreMaterialComponent.laserBands[eid];
            material.laserQuantize = LaserWhiteCoreMaterialComponent.laserQuantize[eid];
            material.laserSoftness = LaserWhiteCoreMaterialComponent.laserSoftness[eid];
            material.coreIntensity = LaserWhiteCoreMaterialComponent.coreIntensity[eid];
            material.coreRadius = LaserWhiteCoreMaterialComponent.coreRadius[eid];
            material.haloRadius = LaserWhiteCoreMaterialComponent.haloRadius[eid];
            material.haloColor.setRGB(
                LaserWhiteCoreMaterialComponent.haloColorR[eid],
                LaserWhiteCoreMaterialComponent.haloColorG[eid],
                LaserWhiteCoreMaterialComponent.haloColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.pulseStrength = LaserWhiteCoreMaterialComponent.pulseStrength[eid];
            material.pulseFrequency = LaserWhiteCoreMaterialComponent.pulseFrequency[eid];
            material.energyStreakStrength = LaserWhiteCoreMaterialComponent.energyStreakStrength[eid];
            material.moodTemperature = LaserWhiteCoreMaterialComponent.moodTemperature[eid];
            material.moodSaturation = LaserWhiteCoreMaterialComponent.moodSaturation[eid];
            material.moodBrightness = LaserWhiteCoreMaterialComponent.moodBrightness[eid];
            material.moodContrast = LaserWhiteCoreMaterialComponent.moodContrast[eid];
            material.rimGlow = LaserWhiteCoreMaterialComponent.rimGlow[eid];
            material.variationSeed = LaserWhiteCoreMaterialComponent.variationSeed[eid];

            LaserWhiteCoreMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main LaserWhiteCoreBaseMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use laser material with a white-hot central core and a coloured
 * halo, for real-time rendering of laser beams, plasma shots, and energy
 * projectiles. Extends MeshPhysicalMaterial with laser-specific PBR defaults
 * and real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class LaserWhiteCoreBaseMaterial extends MeshPhysicalMaterial {
    static {
        _laserWhiteCoreScratchPool.warm(32);
    }

    /**
     * @param {Object} [parameters]
     */
    constructor(parameters) {
        super();

        this.isLaserWhiteCoreBaseMaterial = true;
        this.type = 'LaserWhiteCoreBaseMaterial';

        // -------------------------------------------------------------------
        // Laser-specific PBR defaults (laser-red baseline)
        // -------------------------------------------------------------------
        this.ior = 1.50;
        this.specularIntensity = 0.0;
        this.roughness = 0.0;
        this.metalness = 0.0;
        this.specularColor = new Color(0, 0, 0);
        this.color = new Color(0.60, 0.04, 0.03);

        // No clearcoat for pure emissive beams
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // No transmission for opaque emissive beams
        this.transmission = 0.0;
        this.thickness = 0.001;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        // Emissive core — the core colour drives the white hot centre
        this.emissive = new Color(1.0, 1.0, 1.0);
        this.emissiveIntensity = 12.0;

        // Additive blending so overlapping beams blend additively
        this.transparent = true;
        this.opacity = 0.85;
        this.depthWrite = false;
        this.side = Constants.DOUBLE_SIDE ?? 2;

        // Iridescence off
        this.iridescence = 0.0;
        this.iridescenceIOR = 1.30;
        this.iridescenceThicknessRange = [100, 400];

        // Sheen off
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — laser-specific
        // -------------------------------------------------------------------
        this.laserBands = 4;
        this.laserQuantize = 0.6;
        this.laserSoftness = 0.03;

        // White core + coloured halo controls
        this.coreColor = new Color(1.0, 1.0, 1.0);
        this.coreIntensity = 12.0;
        this.coreRadius = 0.18;
        this.haloColor = new Color(1.0, 0.10, 0.06);
        this.haloRadius = 0.48;

        // Pulse / energy-streak controls
        this.pulseStrength = 0.25;
        this.pulseFrequency = 3.0;
        this.energyStreakStrength = 0.20;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.20;
        this.rimGlowColor = new Color(1.0, 0.10, 0.06);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (laser leans anime)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.60;

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
    applyLaserBanding(baseColor, output) {
        return applyLaserCelBanding(
            baseColor,
            output,
            this.laserBands,
            this.laserQuantize,
            this.laserSoftness
        );
    }

    /**
     * @returns {LaserWhiteCoreBaseMaterial}
     */
    updateMoodColor() {
        gradeLaserColor(
            this.haloColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        this.rimGlowColor.copy(this.haloColor);
        return this;
    }

    /**
     * Apply a named laser preset.
     * @param {string} presetName - One of the keys of `LaserWhiteCorePresets`.
     * @returns {LaserWhiteCoreBaseMaterial}
     */
    applyPreset(presetName) {
        const preset = LaserWhiteCorePresets[presetName];
        if (!preset) return this;

        this.coreColor.setRGB(preset.coreColor[0], preset.coreColor[1], preset.coreColor[2], ColorManagement.workingColorSpace);
        this.coreIntensity = preset.coreIntensity;
        this.coreRadius = preset.coreRadius;
        this.haloColor.setRGB(preset.haloColor[0], preset.haloColor[1], preset.haloColor[2], ColorManagement.workingColorSpace);
        this.haloRadius = preset.haloRadius;
        this.color.setRGB(preset.beamColor[0], preset.beamColor[1], preset.beamColor[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.opacity = preset.opacity;
        this.pulseStrength = preset.pulseStrength;
        this.pulseFrequency = preset.pulseFrequency;
        this.energyStreakStrength = preset.energyStreakStrength;

        // Per-preset anime tuning
        if (presetName === 'anime-laser') {
            this.laserSoftness = 0.02;
            this.laserBands = 5;
            this.rimGlow = 0.30;
        } else {
            this.laserSoftness = 0.03;
            this.laserBands = 4;
            this.rimGlow = 0.20;
        }

        this.updateMoodColor();
        return this;
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.02]
     * @param {number} [octaves=4]
     * @param {number} [pulseStrength=0.25]
     * @param {number} [pulseFrequency=3.0]
     * @param {number} [streakStrength=0.20]
     * @returns {Uint8Array}
     */
    generateLaserPulseTexture(width, height, scale = 0.02, octaves = 4, pulseStrength = 0.25, pulseFrequency = 3.0, streakStrength = 0.20) {
        return generateLaserPulseTexture(width, height, scale, octaves, pulseStrength, pulseFrequency, streakStrength);
    }

    /**
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * @returns {Promise<LaserWhiteCoreBaseMaterial>}
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

        shader.uniforms.laserBands = { value: this.laserBands };
        shader.uniforms.laserQuantize = { value: this.laserQuantize };
        shader.uniforms.laserSoftness = { value: this.laserSoftness };
        shader.uniforms.coreColor = { value: this.coreColor };
        shader.uniforms.coreIntensity = { value: this.coreIntensity };
        shader.uniforms.coreRadius = { value: this.coreRadius };
        shader.uniforms.haloColor = { value: this.haloColor };
        shader.uniforms.haloRadius = { value: this.haloRadius };
        shader.uniforms.pulseStrength = { value: this.pulseStrength };
        shader.uniforms.pulseFrequency = { value: this.pulseFrequency };
        shader.uniforms.energyStreakStrength = { value: this.energyStreakStrength };
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
                uniform int laserBands;
                uniform float laserQuantize;
                uniform float laserSoftness;
                uniform vec3 coreColor;
                uniform float coreIntensity;
                uniform float coreRadius;
                uniform vec3 haloColor;
                uniform float haloRadius;
                uniform float pulseStrength;
                uniform float pulseFrequency;
                uniform float energyStreakStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyLaserBands(vec3 baseColor) {
                    if (laserBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(laserBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * laserSoftness;
                    float finalLum = mix(lum, softQuantized, laserQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply laser cel banding
                gl_FragColor.rgb = applyLaserBands(gl_FragColor.rgb);

                // White-core + coloured-halo radial falloff.
                // The core is pure white (HDR) and the halo is the beam colour.
                {
                    vec2 centreUV = vUv - vec2(0.5);
                    float radialDist = length(centreUV) * 2.0;

                    // White-hot core
                    float coreMask = max(0.0, 1.0 - radialDist / coreRadius);
                    coreMask = pow(coreMask, 1.5);
                    gl_FragColor.rgb += coreColor * coreMask * coreIntensity;

                    // Coloured halo ring
                    float haloInner = smoothstep(coreRadius * 0.8, coreRadius, radialDist);
                    float haloOuter = 1.0 - smoothstep(haloRadius * 0.7, haloRadius, radialDist);
                    float haloMask = haloInner * haloOuter;
                    gl_FragColor.rgb += haloColor * haloMask * 0.6;
                }

                // Pulsed energy rings along the beam axis
                if (pulseStrength > 0.0) {
                    float pulse = sin(vUv.y * pulseFrequency * 6.28318 + variationOffset) * 0.5 + 0.5;
                    gl_FragColor.rgb += haloColor * pulse * pulseStrength * 0.15;
                }

                // Directional energy streaks
                if (energyStreakStrength > 0.0) {
                    float streak = sin(vUv.y * 40.0 + variationOffset) * 0.5 + 0.5;
                    float streakMask = pow(streak, 4.0) * energyStreakStrength;
                    gl_FragColor.rgb += coreColor * streakMask * 0.10;
                }

                // Bright rim glow on laser edges
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
            this.laserBands, this.laserQuantize, this.laserSoftness,
            this.coreIntensity, this.coreRadius,
            this.haloRadius, this.haloColor.r,
            this.pulseStrength, this.pulseFrequency, this.energyStreakStrength,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    /**
     * @param {LaserWhiteCoreBaseMaterial} source
     * @returns {LaserWhiteCoreBaseMaterial}
     */
    copy(source) {
        super.copy(source);
        this.laserBands = source.laserBands;
        this.laserQuantize = source.laserQuantize;
        this.laserSoftness = source.laserSoftness;
        this.coreColor.copy(source.coreColor);
        this.coreIntensity = source.coreIntensity;
        this.coreRadius = source.coreRadius;
        this.haloColor.copy(source.haloColor);
        this.haloRadius = source.haloRadius;
        this.pulseStrength = source.pulseStrength;
        this.pulseFrequency = source.pulseFrequency;
        this.energyStreakStrength = source.energyStreakStrength;
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
        data.type = 'LaserWhiteCoreBaseMaterial';

        if (this.laserBands !== 4) data.laserBands = this.laserBands;
        if (this.laserQuantize !== 0.6) data.laserQuantize = this.laserQuantize;
        if (this.laserSoftness !== 0.03) data.laserSoftness = this.laserSoftness;
        if (this.coreColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) data.coreColor = this.coreColor.getHex();
        if (this.coreIntensity !== 12.0) data.coreIntensity = this.coreIntensity;
        if (this.coreRadius !== 0.18) data.coreRadius = this.coreRadius;
        if (this.haloColor.getHex() !== new Color(1.0, 0.10, 0.06).getHex()) data.haloColor = this.haloColor.getHex();
        if (this.haloRadius !== 0.48) data.haloRadius = this.haloRadius;
        if (this.pulseStrength !== 0.25) data.pulseStrength = this.pulseStrength;
        if (this.pulseFrequency !== 3.0) data.pulseFrequency = this.pulseFrequency;
        if (this.energyStreakStrength !== 0.20) data.energyStreakStrength = this.energyStreakStrength;
        if (this.rimGlow !== 0.20) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 0.10, 0.06).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * @param {Object} json
     * @returns {LaserWhiteCoreBaseMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);
        this.laserBands = json.laserBands ?? this.laserBands;
        this.laserQuantize = json.laserQuantize ?? this.laserQuantize;
        this.laserSoftness = json.laserSoftness ?? this.laserSoftness;
        if (json.coreColor !== undefined) this.coreColor.setHex(json.coreColor);
        this.coreIntensity = json.coreIntensity ?? this.coreIntensity;
        this.coreRadius = json.coreRadius ?? this.coreRadius;
        if (json.haloColor !== undefined) this.haloColor.setHex(json.haloColor);
        this.haloRadius = json.haloRadius ?? this.haloRadius;
        this.pulseStrength = json.pulseStrength ?? this.pulseStrength;
        this.pulseFrequency = json.pulseFrequency ?? this.pulseFrequency;
        this.energyStreakStrength = json.energyStreakStrength ?? this.energyStreakStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const LaserWhiteCoreMaterialBatchComponent = {
    materialPtr: 'ui32',
    laserBands: 'ui8',
    laserQuantize: 'f64',
    laserSoftness: 'f64',
    coreIntensity: 'f64',
    coreRadius: 'f64',
    haloRadius: 'f64',
    haloColorR: 'f64',
    haloColorG: 'f64',
    haloColorB: 'f64',
    pulseStrength: 'f64',
    pulseFrequency: 'f64',
    energyStreakStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    LaserWhiteCoreBaseMaterial,
    LaserWhiteCoreMaterialBatch,
    LaserWhiteCoreScratchPool,
    LaserWhiteCoreMaterialBatchComponent,
    LaserWhiteCorePresets,
    applyLaserCelBanding,
    gradeLaserColor,
    generateLaserPulseTexture
};

export default LaserWhiteCoreBaseMaterial;