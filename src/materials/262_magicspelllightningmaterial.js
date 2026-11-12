// file number : 262
// full path name : src/materials/262_magicspelllightningmaterial.js
// description : MagicSpellLightningMaterial — a ready-to-use lightning-magic
//               spell material for lightning bolts, electric arcs, chain
//               lightning, thunder strikes, and crackling energy with a
//               white-hot core. Extends MagicSpellBaseMaterial with
//               lightning-specific features: a spectral blue-to-white-to-
//               violet "electric ramp" (mirroring fire's heat ramp and ice's
//               cold ramp), branching bolt pattern approximation via
//               ridged-fBm with per-branch hashing, high-frequency electric
//               flicker with per-channel jitter, and an electric arc overlay
//               for chain-lightning effects. Adds real-time anime stylization:
//               cel-banded lightning highlights, spectral electric ramp,
//               animated flicker pulse, mood tinting, rim glow, and
//               per-instance variation. Includes a procedural
//               lightning-turbulence texture generator using ridged
//               domain-warped fBm with a blue-white-violet palette ramp.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Lightning magic spells, lightning bolts, electric arcs, chain
//            lightning, thunder strikes, storm attacks, anime lightning
//            techniques, tesla-coil effects, and any lightning-magic surface
//            that needs real-time PBR + anime stylization.
// license : MIT

import { MagicSpellBaseMaterial } from './259_magicspellbasematerial.js';
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
// Lightning presets — physically grounded parameter sets for lightning VFX.
//
// Electric spectral ramp:
//   deep violet (0.28,0.10,0.72) → electric blue (0.20,0.55,1.0)
//   → plasma white (0.92,0.96,1.0) → white-hot (1.0,1.0,1.0)
//
// Lightning characteristics (from real-time lightning shader references):
//   - Ridged noise (|fBm|) produces the sharp bolt paths
//   - Per-branch random offsets simulate branching
//   - High-frequency per-channel flicker (10–30 Hz) for electric crackle
//   - Emissive HDR 20–40 for bright electric flash under bloom
// ---------------------------------------------------------------------------

const MagicSpellLightningPresets = {
    'lightning-electric-blue': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 26.0,
        coreRadius: 0.20,
        haloColor: [0.20, 0.55, 1.0],
        haloRadius: 0.62,
        spellColor: [0.05, 0.20, 0.72],
        opacity: 0.94,
        pulseStrength: 0.55,
        pulseFrequency: 12.0,
        energyStreakStrength: 0.42,
        electricRampStrength: 1.0,
        branchDensity: 0.45,
        branchFrequency: 14.0,
        boltSharpness: 3.2,
        electricFlickerStrength: 0.45,
        electricFlickerFrequency: 22.0,
        channelJitter: 0.30,
        arcOverlayStrength: 0.35
    },
    'lightning-violet-thunder': {
        coreColor: [1.0, 0.96, 1.0],
        coreIntensity: 28.0,
        coreRadius: 0.22,
        haloColor: [0.62, 0.28, 1.0],
        haloRadius: 0.66,
        spellColor: [0.32, 0.08, 0.72],
        opacity: 0.94,
        pulseStrength: 0.55,
        pulseFrequency: 11.0,
        energyStreakStrength: 0.40,
        electricRampStrength: 1.1,
        branchDensity: 0.50,
        branchFrequency: 12.0,
        boltSharpness: 3.6,
        electricFlickerStrength: 0.48,
        electricFlickerFrequency: 20.0,
        channelJitter: 0.35,
        arcOverlayStrength: 0.40
    },
    'lightning-white-strike': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 40.0,
        coreRadius: 0.32,
        haloColor: [0.85, 0.92, 1.0],
        haloRadius: 0.80,
        spellColor: [0.55, 0.72, 0.95],
        opacity: 0.98,
        pulseStrength: 0.65,
        pulseFrequency: 15.0,
        energyStreakStrength: 0.50,
        electricRampStrength: 1.5,
        branchDensity: 0.55,
        branchFrequency: 16.0,
        boltSharpness: 4.0,
        electricFlickerStrength: 0.55,
        electricFlickerFrequency: 26.0,
        channelJitter: 0.40,
        arcOverlayStrength: 0.55
    },
    'lightning-crimson-thunder': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 30.0,
        coreRadius: 0.22,
        haloColor: [1.0, 0.22, 0.45],
        haloRadius: 0.66,
        spellColor: [0.62, 0.08, 0.28],
        opacity: 0.94,
        pulseStrength: 0.55,
        pulseFrequency: 12.0,
        energyStreakStrength: 0.42,
        electricRampStrength: 1.1,
        branchDensity: 0.48,
        branchFrequency: 13.0,
        boltSharpness: 3.4,
        electricFlickerStrength: 0.50,
        electricFlickerFrequency: 22.0,
        channelJitter: 0.32,
        arcOverlayStrength: 0.38
    },
    'lightning-chain': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 22.0,
        coreRadius: 0.16,
        haloColor: [0.35, 0.75, 1.0],
        haloRadius: 0.55,
        spellColor: [0.10, 0.35, 0.85],
        opacity: 0.92,
        pulseStrength: 0.48,
        pulseFrequency: 16.0,
        energyStreakStrength: 0.45,
        electricRampStrength: 1.0,
        branchDensity: 0.70,
        branchFrequency: 20.0,
        boltSharpness: 3.0,
        electricFlickerStrength: 0.42,
        electricFlickerFrequency: 28.0,
        channelJitter: 0.38,
        arcOverlayStrength: 0.65
    },
    'anime-lightning': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 46.0,
        coreRadius: 0.36,
        haloColor: [0.65, 0.92, 1.0],
        haloRadius: 0.85,
        spellColor: [0.22, 0.55, 0.95],
        opacity: 1.0,
        pulseStrength: 0.75,
        pulseFrequency: 18.0,
        energyStreakStrength: 0.55,
        electricRampStrength: 1.7,
        branchDensity: 0.65,
        branchFrequency: 18.0,
        boltSharpness: 4.5,
        electricFlickerStrength: 0.65,
        electricFlickerFrequency: 30.0,
        channelJitter: 0.45,
        arcOverlayStrength: 0.60
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable lightning-scratch records
// ---------------------------------------------------------------------------

class MagicSpellLightningScratchPool {
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

const _magicSpellLightningScratchPool = new MagicSpellLightningScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — lightning-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded lightning highlights.
 */
function applyLightningCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.02) {
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
 * Mood tinting for lightning halo.
 */
function gradeLightningColor(color, temperature, saturation, brightness, contrast) {
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
    // Lightning-specific temperature bias: warm shift toward violet-magenta;
    // cool shift toward cyan-blue.
    r += temperature * 0.040;
    g += temperature * 0.010;
    b -= temperature * 0.025;
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
 * Generate lightning-turbulence texture: ridged domain-warped fBm with
 * blue-white-violet palette ramp.
 */
function generateLightningTurbulenceTexture(width, height, scale = 0.03, octaves = 5, warpStrength = 1.8, boltSharpness = 3.4, electricRampStrength = 1.1, branchDensity = 0.48) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            // Domain warp
            const warpX = SimplexNoise.noise2D(x * 0.01, y * 0.01) * warpStrength;
            const warpY = SimplexNoise.noise2D(x * 0.01 + 100, y * 0.01 + 100) * warpStrength;
            // Multi-octave ridged fBm (|fBm| produces sharp bolt-like ridges)
            let ridged = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;
            for (let o = 0; o < octaves; o++) {
                const n = SimplexNoise.noise2D(
                    (x + warpX) * frequency,
                    (y + warpY) * frequency
                );
                ridged += (1.0 - Math.abs(n)) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            ridged = ridged / maxAmplitude;
            ridged = Math.pow(ridged, boltSharpness);
            // Branching cells
            const branchCellX = Math.floor(x * 0.02);
            const branchCellY = Math.floor(y * 0.02);
            const branchId = branchCellX * 73856093 ^ branchCellY * 19349663;
            const branchHash = Math.abs(Math.sin(branchId * 12.9898) * 43758.5453) % 1.0;
            let branch = 0;
            if (branchHash > (1.0 - branchDensity)) {
                branch = branchHash * 0.35;
            }
            // Electric ramp
            const electric = Math.min(1, (ridged + branch) * electricRampStrength);
            let r, g, b;
            if (electric > 0.90) {
                r = 1.0; g = 1.0; b = 1.0;
            } else if (electric > 0.65) {
                r = 0.92; g = 0.96; b = 1.0;
            } else if (electric > 0.40) {
                r = 0.20; g = 0.55; b = 1.0;
            } else {
                r = 0.28; g = 0.10; b = 0.72;
            }
            out[p] = Math.floor(r * 255);
            out[p + 1] = Math.floor(g * 255);
            out[p + 2] = Math.floor(b * 255);
            out[p + 3] = 255;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator
// ---------------------------------------------------------------------------

const _magicSpellLightningWorld = BitECS.createWorld();
const MagicSpellLightningMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    magicBands: 'ui8',
    magicQuantize: 'f64',
    magicSoftness: 'f64',
    coreIntensity: 'f64',
    coreRadius: 'f64',
    haloRadius: 'f64',
    haloColorR: 'f64',
    haloColorG: 'f64',
    haloColorB: 'f64',
    pulseStrength: 'f64',
    pulseFrequency: 'f64',
    energyStreakStrength: 'f64',
    electricRampStrength: 'f64',
    branchDensity: 'f64',
    branchFrequency: 'f64',
    boltSharpness: 'f64',
    electricFlickerStrength: 'f64',
    electricFlickerFrequency: 'f64',
    channelJitter: 'f64',
    arcOverlayStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class MagicSpellLightningMaterialBatch {
    constructor() {
        this.world = _magicSpellLightningWorld;
        this.materials = [];
        this.entities = [];
        this._elapsed = 0;
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, MagicSpellLightningMaterialComponent, eid);
        MagicSpellLightningMaterialComponent.materialPtr[eid] = this.materials.length;
        MagicSpellLightningMaterialComponent.magicBands[eid] = material.magicBands;
        MagicSpellLightningMaterialComponent.magicQuantize[eid] = material.magicQuantize;
        MagicSpellLightningMaterialComponent.magicSoftness[eid] = material.magicSoftness;
        MagicSpellLightningMaterialComponent.coreIntensity[eid] = material.coreIntensity;
        MagicSpellLightningMaterialComponent.coreRadius[eid] = material.coreRadius;
        MagicSpellLightningMaterialComponent.haloRadius[eid] = material.haloRadius;
        MagicSpellLightningMaterialComponent.haloColorR[eid] = material.haloColor.r;
        MagicSpellLightningMaterialComponent.haloColorG[eid] = material.haloColor.g;
        MagicSpellLightningMaterialComponent.haloColorB[eid] = material.haloColor.b;
        MagicSpellLightningMaterialComponent.pulseStrength[eid] = material.pulseStrength;
        MagicSpellLightningMaterialComponent.pulseFrequency[eid] = material.pulseFrequency;
        MagicSpellLightningMaterialComponent.energyStreakStrength[eid] = material.energyStreakStrength;
        MagicSpellLightningMaterialComponent.electricRampStrength[eid] = material.electricRampStrength;
        MagicSpellLightningMaterialComponent.branchDensity[eid] = material.branchDensity;
        MagicSpellLightningMaterialComponent.branchFrequency[eid] = material.branchFrequency;
        MagicSpellLightningMaterialComponent.boltSharpness[eid] = material.boltSharpness;
        MagicSpellLightningMaterialComponent.electricFlickerStrength[eid] = material.electricFlickerStrength;
        MagicSpellLightningMaterialComponent.electricFlickerFrequency[eid] = material.electricFlickerFrequency;
        MagicSpellLightningMaterialComponent.channelJitter[eid] = material.channelJitter;
        MagicSpellLightningMaterialComponent.arcOverlayStrength[eid] = material.arcOverlayStrength;
        MagicSpellLightningMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        MagicSpellLightningMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        MagicSpellLightningMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        MagicSpellLightningMaterialComponent.moodContrast[eid] = material.moodContrast;
        MagicSpellLightningMaterialComponent.rimGlow[eid] = material.rimGlow;
        MagicSpellLightningMaterialComponent.variationSeed[eid] = material.variationSeed;
        MagicSpellLightningMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MagicSpellLightningMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            material.magicBands = MagicSpellLightningMaterialComponent.magicBands[eid];
            material.magicQuantize = MagicSpellLightningMaterialComponent.magicQuantize[eid];
            material.magicSoftness = MagicSpellLightningMaterialComponent.magicSoftness[eid];
            material.coreIntensity = MagicSpellLightningMaterialComponent.coreIntensity[eid];
            material.coreRadius = MagicSpellLightningMaterialComponent.coreRadius[eid];
            material.haloRadius = MagicSpellLightningMaterialComponent.haloRadius[eid];
            material.haloColor.setRGB(
                MagicSpellLightningMaterialComponent.haloColorR[eid],
                MagicSpellLightningMaterialComponent.haloColorG[eid],
                MagicSpellLightningMaterialComponent.haloColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.pulseStrength = MagicSpellLightningMaterialComponent.pulseStrength[eid];
            material.pulseFrequency = MagicSpellLightningMaterialComponent.pulseFrequency[eid];
            material.energyStreakStrength = MagicSpellLightningMaterialComponent.energyStreakStrength[eid];
            material.electricRampStrength = MagicSpellLightningMaterialComponent.electricRampStrength[eid];
            material.branchDensity = MagicSpellLightningMaterialComponent.branchDensity[eid];
            material.branchFrequency = MagicSpellLightningMaterialComponent.branchFrequency[eid];
            material.boltSharpness = MagicSpellLightningMaterialComponent.boltSharpness[eid];
            material.electricFlickerStrength = MagicSpellLightningMaterialComponent.electricFlickerStrength[eid];
            material.electricFlickerFrequency = MagicSpellLightningMaterialComponent.electricFlickerFrequency[eid];
            material.channelJitter = MagicSpellLightningMaterialComponent.channelJitter[eid];
            material.arcOverlayStrength = MagicSpellLightningMaterialComponent.arcOverlayStrength[eid];
            material.moodTemperature = MagicSpellLightningMaterialComponent.moodTemperature[eid];
            material.moodSaturation = MagicSpellLightningMaterialComponent.moodSaturation[eid];
            material.moodBrightness = MagicSpellLightningMaterialComponent.moodBrightness[eid];
            material.moodContrast = MagicSpellLightningMaterialComponent.moodContrast[eid];
            material.rimGlow = MagicSpellLightningMaterialComponent.rimGlow[eid];
            material.variationSeed = MagicSpellLightningMaterialComponent.variationSeed[eid];
            MagicSpellLightningMaterialComponent.dirty[eid] = 1;
        }
    }

    update(delta) {
        this._elapsed += delta;
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MagicSpellLightningMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            if (material.uniforms && material.uniforms.uTime) {
                material.uniforms.uTime.value = this._elapsed;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Main MagicSpellLightningMaterial class
// ---------------------------------------------------------------------------

class MagicSpellLightningMaterial extends MagicSpellBaseMaterial {
    static {
        _magicSpellLightningScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isMagicSpellLightningMaterial = true;
        this.type = 'MagicSpellLightningMaterial';

        this.magicBands = 5;
        this.magicQuantize = 0.75;
        this.magicSoftness = 0.02;
        this.coreIntensity = 26.0;
        this.coreRadius = 0.20;
        this.haloRadius = 0.62;
        this.pulseStrength = 0.55;
        this.pulseFrequency = 12.0;
        this.energyStreakStrength = 0.42;

        // Lightning-specific controls
        this.electricRampStrength = 1.0;
        this.branchDensity = 0.45;
        this.branchFrequency = 14.0;
        this.boltSharpness = 3.2;
        this.electricFlickerStrength = 0.45;
        this.electricFlickerFrequency = 22.0;
        this.channelJitter = 0.30;
        this.arcOverlayStrength = 0.35;

        // Lightning colour defaults (electric blue)
        this.color = new Color(0.05, 0.20, 0.72);
        this.haloColor = new Color(0.20, 0.55, 1.0);
        this.rimGlowColor = new Color(0.20, 0.55, 1.0);
        this.coreColor = new Color(1.0, 1.0, 1.0);
        this.emissiveIntensity = 26.0;

        this.uniforms = {};

        this.transparent = true;
        this.opacity = 0.94;
        this.depthWrite = false;
        this.blending = Constants.ADDITIVE_BLENDING ?? 2;
        this.side = Constants.DOUBLE_SIDE ?? 2;

        this.renderStyleBlend = 0.72;
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    applyLightningBanding(baseColor, output) {
        return applyLightningCelBanding(baseColor, output, this.magicBands, this.magicQuantize, this.magicSoftness);
    }

    updateMoodColor() {
        gradeLightningColor(this.haloColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        this.rimGlowColor.copy(this.haloColor);
        return this;
    }

    applyPreset(presetName) {
        const preset = MagicSpellLightningPresets[presetName];
        if (!preset) return this;

        this.coreColor.setRGB(preset.coreColor[0], preset.coreColor[1], preset.coreColor[2], ColorManagement.workingColorSpace);
        this.coreIntensity = preset.coreIntensity;
        this.coreRadius = preset.coreRadius;
        this.haloColor.setRGB(preset.haloColor[0], preset.haloColor[1], preset.haloColor[2], ColorManagement.workingColorSpace);
        this.haloRadius = preset.haloRadius;
        this.color.setRGB(preset.spellColor[0], preset.spellColor[1], preset.spellColor[2], ColorManagement.workingColorSpace);
        this.opacity = preset.opacity;
        this.pulseStrength = preset.pulseStrength;
        this.pulseFrequency = preset.pulseFrequency;
        this.energyStreakStrength = preset.energyStreakStrength;
        this.electricRampStrength = preset.electricRampStrength;
        this.branchDensity = preset.branchDensity;
        this.branchFrequency = preset.branchFrequency;
        this.boltSharpness = preset.boltSharpness;
        this.electricFlickerStrength = preset.electricFlickerStrength;
        this.electricFlickerFrequency = preset.electricFlickerFrequency;
        this.channelJitter = preset.channelJitter;
        this.arcOverlayStrength = preset.arcOverlayStrength;

        if (presetName === 'anime-lightning') {
            this.magicSoftness = 0.02;
            this.magicBands = 5;
            this.rimGlow = 0.42;
        } else if (presetName === 'lightning-white-strike') {
            this.magicSoftness = 0.02;
            this.magicBands = 5;
            this.rimGlow = 0.35;
        } else {
            this.magicSoftness = 0.02;
            this.magicBands = 5;
            this.rimGlow = 0.28;
        }

        this.updateMoodColor();
        return this;
    }

    generateLightningTurbulenceTexture(width, height, scale = 0.03, octaves = 5, warpStrength = 1.8, boltSharpness = 3.4, electricRampStrength = 1.1, branchDensity = 0.48) {
        return generateLightningTurbulenceTexture(width, height, scale, octaves, warpStrength, boltSharpness, electricRampStrength, branchDensity);
    }

    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    async initialize() {
        await Promise.resolve();
        return this;
    }

    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        this.uniforms = shader.uniforms;

        shader.uniforms.electricRampStrength = { value: this.electricRampStrength };
        shader.uniforms.branchDensity = { value: this.branchDensity };
        shader.uniforms.branchFrequency = { value: this.branchFrequency };
        shader.uniforms.boltSharpness = { value: this.boltSharpness };
        shader.uniforms.electricFlickerStrength = { value: this.electricFlickerStrength };
        shader.uniforms.electricFlickerFrequency = { value: this.electricFlickerFrequency };
        shader.uniforms.channelJitter = { value: this.channelJitter };
        shader.uniforms.arcOverlayStrength = { value: this.arcOverlayStrength };
        shader.uniforms.uTime = { value: 0 };

        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float variationOffset;',
                `uniform float variationOffset;
                uniform float electricRampStrength;
                uniform float branchDensity;
                uniform float branchFrequency;
                uniform float boltSharpness;
                uniform float electricFlickerStrength;
                uniform float electricFlickerFrequency;
                uniform float channelJitter;
                uniform float arcOverlayStrength;
                uniform float uTime;
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // White-core + lightning-halo radial falloff
                {
                    vec2 centreUV = vUv - vec2(0.5);
                    float radialDist = length(centreUV) * 2.0;

                    float coreMask = max(0.0, 1.0 - radialDist / coreRadius);
                    coreMask = pow(coreMask, 1.4);
                    gl_FragColor.rgb += coreColor * coreMask * coreIntensity;

                    float haloInner = smoothstep(coreRadius * 0.75, coreRadius, radialDist);
                    float haloOuter = 1.0 - smoothstep(haloRadius * 0.7, haloRadius, radialDist);
                    float haloMask = haloInner * haloOuter;
                    gl_FragColor.rgb += haloColor * haloMask * 0.75;
                }

                // Branching bolt pattern approximation: ridged fBm with per-branch hashing
                if (boltSharpness > 0.0) {
                    vec2 boltUV = vUv * branchFrequency + vec2(uTime * 0.5, 0.0);
                    vec2 boltCell = floor(boltUV);
                    vec2 boltFrac = fract(boltUV);
                    float branchHash = fract(sin(dot(boltCell, vec2(12.9898, 78.233))) * 43758.5453);
                    // Sharp ridge line down the middle of each cell
                    float ridge = 1.0 - abs(boltFrac.x - 0.5) * 2.0;
                    ridge = pow(max(0.0, ridge), boltSharpness);
                    if (branchHash > (1.0 - branchDensity)) {
                        gl_FragColor.rgb += haloColor * ridge * branchHash * 0.35;
                    }
                    // Per-branch energy flicker
                    float flicker = fract(sin(branchHash * uTime * branchFrequency) * 43758.5453);
                    gl_FragColor.rgb += vec3(flicker) * ridge * 0.08;
                }

                // Electric-ramp gradient overlay (blue → white → violet)
                if (electricRampStrength > 0.0) {
                    float electric = max(0.0, 1.0 - length(vUv - vec2(0.5)) * 2.0);
                    electric = pow(electric, 0.7) * electricRampStrength;
                    vec3 electricColor;
                    if (electric > 0.90) electricColor = vec3(1.0, 1.0, 1.0);
                    else if (electric > 0.65) electricColor = vec3(0.92, 0.96, 1.0);
                    else if (electric > 0.40) electricColor = vec3(0.20, 0.55, 1.0);
                    else electricColor = vec3(0.28, 0.10, 0.72);
                    gl_FragColor.rgb += electricColor * electric * 0.22;
                }

                // High-frequency electric flicker with per-channel jitter
                if (electricFlickerStrength > 0.0) {
                    float flickR = fract(sin(uTime * electricFlickerFrequency + variationOffset) * 43758.5453);
                    float flickG = fract(sin(uTime * electricFlickerFrequency * 1.1 + variationOffset + 100.0) * 43758.5453);
                    float flickB = fract(sin(uTime * electricFlickerFrequency * 1.3 + variationOffset + 200.0) * 43758.5453);
                    vec3 channelShift = vec3(flickR, flickG, flickB) - 0.5;
                    gl_FragColor.rgb += channelShift * electricFlickerStrength * channelJitter;
                }

                // Electric-arc overlay: random sparkle cells (chain lightning)
                if (arcOverlayStrength > 0.0) {
                    vec2 arcUV = vUv * 80.0 + vec2(0.0, uTime * 3.0);
                    vec2 arcCell = floor(arcUV);
                    float arcHash = fract(sin(dot(arcCell, vec2(39.425, 1.57))) * 43758.5453);
                    if (arcHash > 0.85) {
                        gl_FragColor.rgb += vec3(0.85, 0.92, 1.0) * (arcHash - 0.85) * arcOverlayStrength * 4.0;
                    }
                }

                // Bright rim glow on lightning edges
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
            this.electricRampStrength, this.branchDensity,
            this.branchFrequency, this.boltSharpness,
            this.electricFlickerStrength, this.electricFlickerFrequency,
            this.channelJitter, this.arcOverlayStrength
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.electricRampStrength = source.electricRampStrength;
        this.branchDensity = source.branchDensity;
        this.branchFrequency = source.branchFrequency;
        this.boltSharpness = source.boltSharpness;
        this.electricFlickerStrength = source.electricFlickerStrength;
        this.electricFlickerFrequency = source.electricFlickerFrequency;
        this.channelJitter = source.channelJitter;
        this.arcOverlayStrength = source.arcOverlayStrength;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'MagicSpellLightningMaterial';
        if (this.electricRampStrength !== 1.0) data.electricRampStrength = this.electricRampStrength;
        if (this.branchDensity !== 0.45) data.branchDensity = this.branchDensity;
        if (this.branchFrequency !== 14.0) data.branchFrequency = this.branchFrequency;
        if (this.boltSharpness !== 3.2) data.boltSharpness = this.boltSharpness;
        if (this.electricFlickerStrength !== 0.45) data.electricFlickerStrength = this.electricFlickerStrength;
        if (this.electricFlickerFrequency !== 22.0) data.electricFlickerFrequency = this.electricFlickerFrequency;
        if (this.channelJitter !== 0.30) data.channelJitter = this.channelJitter;
        if (this.arcOverlayStrength !== 0.35) data.arcOverlayStrength = this.arcOverlayStrength;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.electricRampStrength = json.electricRampStrength ?? this.electricRampStrength;
        this.branchDensity = json.branchDensity ?? this.branchDensity;
        this.branchFrequency = json.branchFrequency ?? this.branchFrequency;
        this.boltSharpness = json.boltSharpness ?? this.boltSharpness;
        this.electricFlickerStrength = json.electricFlickerStrength ?? this.electricFlickerStrength;
        this.electricFlickerFrequency = json.electricFlickerFrequency ?? this.electricFlickerFrequency;
        this.channelJitter = json.channelJitter ?? this.channelJitter;
        this.arcOverlayStrength = json.arcOverlayStrength ?? this.arcOverlayStrength;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const MagicSpellLightningMaterialBatchComponent = {
    materialPtr: 'ui32',
    magicBands: 'ui8',
    magicQuantize: 'f64',
    magicSoftness: 'f64',
    coreIntensity: 'f64',
    coreRadius: 'f64',
    haloRadius: 'f64',
    haloColorR: 'f64',
    haloColorG: 'f64',
    haloColorB: 'f64',
    pulseStrength: 'f64',
    pulseFrequency: 'f64',
    energyStreakStrength: 'f64',
    electricRampStrength: 'f64',
    branchDensity: 'f64',
    branchFrequency: 'f64',
    boltSharpness: 'f64',
    electricFlickerStrength: 'f64',
    electricFlickerFrequency: 'f64',
    channelJitter: 'f64',
    arcOverlayStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    MagicSpellLightningMaterial,
    MagicSpellLightningMaterialBatch,
    MagicSpellLightningScratchPool,
    MagicSpellLightningMaterialBatchComponent,
    MagicSpellLightningPresets,
    applyLightningCelBanding,
    gradeLightningColor,
    generateLightningTurbulenceTexture
};

export default MagicSpellLightningMaterial;