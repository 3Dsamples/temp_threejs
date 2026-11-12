// file number : 260
// full path name : src/materials/260_magicspellfirematerial.js
// description : MagicSpellFireMaterial — a ready-to-use fire-magic spell
//               material for fireballs, flame bursts, fire walls, and molten
//               projectiles with a white-hot core. Extends
//               MagicSpellBaseMaterial with fire-specific features: a
//               black-body heat gradient (dull red → orange → yellow →
//               white-hot core), upward-sheared flame turbulence that rises
//               with buoyancy (matching real-time volumetric fire references),
//               heat-shimmer flicker, ember-spark particle approximation, and
//               a molten-crack overlay for lava-like projectiles. Adds
//               real-time anime stylization: cel-banded fire highlights,
//               heat-gradient colour ramp, animated flame pulse, mood
//               tinting, rim glow, and per-instance variation. Includes a
//               procedural fire-turbulence texture generator using
//               upward-sheared domain-warped fBm with a black-body palette
//               ramp. All imports resolve to the internal Threejs_gl
//               repository tree; no CDN dependencies.
// best for : Fire magic spells, fireballs, flame bursts, fire walls, molten
//            projectiles, lava attacks, anime fire techniques, dragon breath,
//            explosive fire runes, and any fire-magic surface that needs
//            real-time PBR + anime stylization.
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
// Fire presets — physically grounded parameter sets for fire-magic VFX.
//
// Reference values (from real-time fire shader references, black-body
// radiation curves, and VFX guides):
//   - Heat gradient:   dull red (0.4,0.05,0.02) → orange (1.0,0.45,0.05)
//                      → yellow (1.0,0.85,0.15) → white-hot (1.0,1.0,1.0)
//   - Emissive:        HDR intensity 18–35 (>>1 triggers bloom)
//   - Blending:        Additive
//   - depthWrite:      False
//   - Turbulence:      upward-sheared, buoyancy-rising
//   - Heat shimmer:    time-based UV warp near flame edges
//   - Embers:          hashed sparks with per-ember gravity offset
// ---------------------------------------------------------------------------

const MagicSpellFirePresets = {
    'fire-orange': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 22.0,
        coreRadius: 0.22,
        haloColor: [1.0, 0.42, 0.08],
        haloRadius: 0.68,
        spellColor: [0.85, 0.22, 0.04],
        opacity: 0.94,
        pulseStrength: 0.42,
        pulseFrequency: 6.0,
        energyStreakStrength: 0.30,
        heatGradientStrength: 1.0,
        flameTurbulenceStrength: 0.55,
        flameTurbulenceSpeed: 1.6,
        heatShimmerStrength: 0.25,
        heatShimmerFrequency: 12.0,
        emberDensity: 0.35,
        emberStrength: 0.55,
        emberGravity: 0.60,
        moltenCrackStrength: 0.0
    },
    'fire-crimson': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 20.0,
        coreRadius: 0.20,
        haloColor: [1.0, 0.12, 0.06],
        haloRadius: 0.65,
        spellColor: [0.65, 0.04, 0.03],
        opacity: 0.94,
        pulseStrength: 0.40,
        pulseFrequency: 5.0,
        energyStreakStrength: 0.28,
        heatGradientStrength: 1.0,
        flameTurbulenceStrength: 0.55,
        flameTurbulenceSpeed: 1.4,
        heatShimmerStrength: 0.22,
        heatShimmerFrequency: 11.0,
        emberDensity: 0.32,
        emberStrength: 0.50,
        emberGravity: 0.55,
        moltenCrackStrength: 0.0
    },
    'fire-white-hot': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 34.0,
        coreRadius: 0.32,
        haloColor: [1.0, 0.82, 0.42],
        haloRadius: 0.78,
        spellColor: [0.92, 0.55, 0.10],
        opacity: 0.98,
        pulseStrength: 0.50,
        pulseFrequency: 7.0,
        energyStreakStrength: 0.38,
        heatGradientStrength: 1.4,
        flameTurbulenceStrength: 0.65,
        flameTurbulenceSpeed: 2.0,
        heatShimmerStrength: 0.30,
        heatShimmerFrequency: 14.0,
        emberDensity: 0.42,
        emberStrength: 0.68,
        emberGravity: 0.75,
        moltenCrackStrength: 0.0
    },
    'fire-blue': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 26.0,
        coreRadius: 0.24,
        haloColor: [0.22, 0.62, 1.0],
        haloRadius: 0.68,
        spellColor: [0.08, 0.28, 0.82],
        opacity: 0.94,
        pulseStrength: 0.40,
        pulseFrequency: 5.5,
        energyStreakStrength: 0.30,
        heatGradientStrength: 1.0,
        flameTurbulenceStrength: 0.50,
        flameTurbulenceSpeed: 1.5,
        heatShimmerStrength: 0.24,
        heatShimmerFrequency: 11.0,
        emberDensity: 0.34,
        emberStrength: 0.55,
        emberGravity: 0.60,
        moltenCrackStrength: 0.0
    },
    'fire-molten-lava': {
        coreColor: [1.0, 0.92, 0.72],
        coreIntensity: 24.0,
        coreRadius: 0.26,
        haloColor: [1.0, 0.32, 0.06],
        haloRadius: 0.72,
        spellColor: [0.72, 0.12, 0.02],
        opacity: 0.98,
        pulseStrength: 0.35,
        pulseFrequency: 4.0,
        energyStreakStrength: 0.22,
        heatGradientStrength: 1.2,
        flameTurbulenceStrength: 0.40,
        flameTurbulenceSpeed: 1.2,
        heatShimmerStrength: 0.20,
        heatShimmerFrequency: 9.0,
        emberDensity: 0.28,
        emberStrength: 0.50,
        emberGravity: 0.35,
        moltenCrackStrength: 0.55
    },
    'anime-fire': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 38.0,
        coreRadius: 0.36,
        haloColor: [1.0, 0.62, 0.22],
        haloRadius: 0.85,
        spellColor: [0.88, 0.35, 0.06],
        opacity: 1.0,
        pulseStrength: 0.65,
        pulseFrequency: 10.0,
        energyStreakStrength: 0.45,
        heatGradientStrength: 1.6,
        flameTurbulenceStrength: 0.75,
        flameTurbulenceSpeed: 2.4,
        heatShimmerStrength: 0.35,
        heatShimmerFrequency: 16.0,
        emberDensity: 0.48,
        emberStrength: 0.75,
        emberGravity: 0.85,
        moltenCrackStrength: 0.0
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable fire-scratch records
// ---------------------------------------------------------------------------

class MagicSpellFireScratchPool {
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

const _magicSpellFireScratchPool = new MagicSpellFireScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — fire-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded fire highlights.
 */
function applyFireCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.03) {
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
 * Mood tinting for fire halo.
 */
function gradeFireColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate a fire-turbulence texture: upward-sheared domain-warped fBm with
 * black-body palette ramp (dull red → orange → yellow → white-hot).
 */
function generateFireTurbulenceTexture(width, height, scale = 0.03, octaves = 5, shearStrength = 0.35, turbulenceStrength = 0.55, heatGradientStrength = 1.0) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            // Upward shear: the noise field is displaced upward as v increases,
            // producing the characteristic rising flame turbulence.
            const shear = (y / height) * shearStrength * height;
            const sampleY = y + shear * 20.0;
            // Domain warp
            const warpX = SimplexNoise.noise2D(x * 0.008, sampleY * 0.008) * 1.6;
            const warpY = SimplexNoise.noise2D(x * 0.008 + 100, sampleY * 0.008 + 100) * 1.6;
            // Multi-octave fBm
            let fbm = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;
            for (let o = 0; o < octaves; o++) {
                fbm += SimplexNoise.noise2D(
                    (x + warpX) * frequency,
                    (sampleY + warpY) * frequency
                ) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;
            // Buoyancy-driven narrowing: flames taper toward the top
            const taper = Math.pow(1.0 - y / height, 0.7);
            const turbulence = fbm * turbulenceStrength * taper;
            // Black-body heat ramp: high value → white-hot core, low → dull red
            const heat = Math.min(1, turbulence * heatGradientStrength + 0.35);
            let r, g, b;
            if (heat > 0.9) {
                r = 1.0; g = 1.0; b = 1.0;
            } else if (heat > 0.65) {
                r = 1.0; g = 0.85; b = 0.15;
            } else if (heat > 0.4) {
                r = 1.0; g = 0.45; b = 0.05;
            } else {
                r = 0.4; g = 0.05; b = 0.02;
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

const _magicSpellFireWorld = BitECS.createWorld();
const MagicSpellFireMaterialComponent = BitECS.defineComponent({
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
    heatGradientStrength: 'f64',
    flameTurbulenceStrength: 'f64',
    flameTurbulenceSpeed: 'f64',
    heatShimmerStrength: 'f64',
    heatShimmerFrequency: 'f64',
    emberDensity: 'f64',
    emberStrength: 'f64',
    emberGravity: 'f64',
    moltenCrackStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class MagicSpellFireMaterialBatch {
    constructor() {
        this.world = _magicSpellFireWorld;
        this.materials = [];
        this.entities = [];
        this._elapsed = 0;
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, MagicSpellFireMaterialComponent, eid);
        MagicSpellFireMaterialComponent.materialPtr[eid] = this.materials.length;
        MagicSpellFireMaterialComponent.magicBands[eid] = material.magicBands;
        MagicSpellFireMaterialComponent.magicQuantize[eid] = material.magicQuantize;
        MagicSpellFireMaterialComponent.magicSoftness[eid] = material.magicSoftness;
        MagicSpellFireMaterialComponent.coreIntensity[eid] = material.coreIntensity;
        MagicSpellFireMaterialComponent.coreRadius[eid] = material.coreRadius;
        MagicSpellFireMaterialComponent.haloRadius[eid] = material.haloRadius;
        MagicSpellFireMaterialComponent.haloColorR[eid] = material.haloColor.r;
        MagicSpellFireMaterialComponent.haloColorG[eid] = material.haloColor.g;
        MagicSpellFireMaterialComponent.haloColorB[eid] = material.haloColor.b;
        MagicSpellFireMaterialComponent.pulseStrength[eid] = material.pulseStrength;
        MagicSpellFireMaterialComponent.pulseFrequency[eid] = material.pulseFrequency;
        MagicSpellFireMaterialComponent.energyStreakStrength[eid] = material.energyStreakStrength;
        MagicSpellFireMaterialComponent.heatGradientStrength[eid] = material.heatGradientStrength;
        MagicSpellFireMaterialComponent.flameTurbulenceStrength[eid] = material.flameTurbulenceStrength;
        MagicSpellFireMaterialComponent.flameTurbulenceSpeed[eid] = material.flameTurbulenceSpeed;
        MagicSpellFireMaterialComponent.heatShimmerStrength[eid] = material.heatShimmerStrength;
        MagicSpellFireMaterialComponent.heatShimmerFrequency[eid] = material.heatShimmerFrequency;
        MagicSpellFireMaterialComponent.emberDensity[eid] = material.emberDensity;
        MagicSpellFireMaterialComponent.emberStrength[eid] = material.emberStrength;
        MagicSpellFireMaterialComponent.emberGravity[eid] = material.emberGravity;
        MagicSpellFireMaterialComponent.moltenCrackStrength[eid] = material.moltenCrackStrength;
        MagicSpellFireMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        MagicSpellFireMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        MagicSpellFireMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        MagicSpellFireMaterialComponent.moodContrast[eid] = material.moodContrast;
        MagicSpellFireMaterialComponent.rimGlow[eid] = material.rimGlow;
        MagicSpellFireMaterialComponent.variationSeed[eid] = material.variationSeed;
        MagicSpellFireMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MagicSpellFireMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            material.magicBands = MagicSpellFireMaterialComponent.magicBands[eid];
            material.magicQuantize = MagicSpellFireMaterialComponent.magicQuantize[eid];
            material.magicSoftness = MagicSpellFireMaterialComponent.magicSoftness[eid];
            material.coreIntensity = MagicSpellFireMaterialComponent.coreIntensity[eid];
            material.coreRadius = MagicSpellFireMaterialComponent.coreRadius[eid];
            material.haloRadius = MagicSpellFireMaterialComponent.haloRadius[eid];
            material.haloColor.setRGB(
                MagicSpellFireMaterialComponent.haloColorR[eid],
                MagicSpellFireMaterialComponent.haloColorG[eid],
                MagicSpellFireMaterialComponent.haloColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.pulseStrength = MagicSpellFireMaterialComponent.pulseStrength[eid];
            material.pulseFrequency = MagicSpellFireMaterialComponent.pulseFrequency[eid];
            material.energyStreakStrength = MagicSpellFireMaterialComponent.energyStreakStrength[eid];
            material.heatGradientStrength = MagicSpellFireMaterialComponent.heatGradientStrength[eid];
            material.flameTurbulenceStrength = MagicSpellFireMaterialComponent.flameTurbulenceStrength[eid];
            material.flameTurbulenceSpeed = MagicSpellFireMaterialComponent.flameTurbulenceSpeed[eid];
            material.heatShimmerStrength = MagicSpellFireMaterialComponent.heatShimmerStrength[eid];
            material.heatShimmerFrequency = MagicSpellFireMaterialComponent.heatShimmerFrequency[eid];
            material.emberDensity = MagicSpellFireMaterialComponent.emberDensity[eid];
            material.emberStrength = MagicSpellFireMaterialComponent.emberStrength[eid];
            material.emberGravity = MagicSpellFireMaterialComponent.emberGravity[eid];
            material.moltenCrackStrength = MagicSpellFireMaterialComponent.moltenCrackStrength[eid];
            material.moodTemperature = MagicSpellFireMaterialComponent.moodTemperature[eid];
            material.moodSaturation = MagicSpellFireMaterialComponent.moodSaturation[eid];
            material.moodBrightness = MagicSpellFireMaterialComponent.moodBrightness[eid];
            material.moodContrast = MagicSpellFireMaterialComponent.moodContrast[eid];
            material.rimGlow = MagicSpellFireMaterialComponent.rimGlow[eid];
            material.variationSeed = MagicSpellFireMaterialComponent.variationSeed[eid];
            MagicSpellFireMaterialComponent.dirty[eid] = 1;
        }
    }

    update(delta) {
        this._elapsed += delta;
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MagicSpellFireMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            if (material.uniforms && material.uniforms.uTime) {
                material.uniforms.uTime.value = this._elapsed;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Main MagicSpellFireMaterial class
// ---------------------------------------------------------------------------

class MagicSpellFireMaterial extends MagicSpellBaseMaterial {
    static {
        _magicSpellFireScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isMagicSpellFireMaterial = true;
        this.type = 'MagicSpellFireMaterial';

        this.magicBands = 4;
        this.magicQuantize = 0.7;
        this.magicSoftness = 0.03;
        this.coreIntensity = 22.0;
        this.coreRadius = 0.22;
        this.haloRadius = 0.68;
        this.pulseStrength = 0.42;
        this.pulseFrequency = 6.0;
        this.energyStreakStrength = 0.30;

        // Fire-specific controls
        this.heatGradientStrength = 1.0;
        this.flameTurbulenceStrength = 0.55;
        this.flameTurbulenceSpeed = 1.6;
        this.heatShimmerStrength = 0.25;
        this.heatShimmerFrequency = 12.0;
        this.emberDensity = 0.35;
        this.emberStrength = 0.55;
        this.emberGravity = 0.60;
        this.moltenCrackStrength = 0.0;

        // Fire colour defaults (orange)
        this.color = new Color(0.85, 0.22, 0.04);
        this.haloColor = new Color(1.0, 0.42, 0.08);
        this.rimGlowColor = new Color(1.0, 0.42, 0.08);
        this.coreColor = new Color(1.0, 1.0, 1.0);
        this.emissiveIntensity = 22.0;

        // Runtime uniform cache
        this.uniforms = {};

        // Fire blending: additive, no depth-write
        this.transparent = true;
        this.opacity = 0.94;
        this.depthWrite = false;
        this.blending = Constants.ADDITIVE_BLENDING ?? 2;
        this.side = Constants.DOUBLE_SIDE ?? 2;

        this.renderStyleBlend = 0.70;
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    applyFireBanding(baseColor, output) {
        return applyFireCelBanding(baseColor, output, this.magicBands, this.magicQuantize, this.magicSoftness);
    }

    updateMoodColor() {
        gradeFireColor(this.haloColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        this.rimGlowColor.copy(this.haloColor);
        return this;
    }

    applyPreset(presetName) {
        const preset = MagicSpellFirePresets[presetName];
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
        this.heatGradientStrength = preset.heatGradientStrength;
        this.flameTurbulenceStrength = preset.flameTurbulenceStrength;
        this.flameTurbulenceSpeed = preset.flameTurbulenceSpeed;
        this.heatShimmerStrength = preset.heatShimmerStrength;
        this.heatShimmerFrequency = preset.heatShimmerFrequency;
        this.emberDensity = preset.emberDensity;
        this.emberStrength = preset.emberStrength;
        this.emberGravity = preset.emberGravity;
        this.moltenCrackStrength = preset.moltenCrackStrength;

        if (presetName === 'anime-fire') {
            this.magicSoftness = 0.02;
            this.magicBands = 5;
            this.rimGlow = 0.40;
        } else {
            this.magicSoftness = 0.03;
            this.magicBands = 4;
            this.rimGlow = 0.28;
        }

        this.updateMoodColor();
        return this;
    }

    generateFireTurbulenceTexture(width, height, scale = 0.03, octaves = 5, shearStrength = 0.35, turbulenceStrength = 0.55, heatGradientStrength = 1.0) {
        return generateFireTurbulenceTexture(width, height, scale, octaves, shearStrength, turbulenceStrength, heatGradientStrength);
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

        shader.uniforms.heatGradientStrength = { value: this.heatGradientStrength };
        shader.uniforms.flameTurbulenceStrength = { value: this.flameTurbulenceStrength };
        shader.uniforms.flameTurbulenceSpeed = { value: this.flameTurbulenceSpeed };
        shader.uniforms.heatShimmerStrength = { value: this.heatShimmerStrength };
        shader.uniforms.heatShimmerFrequency = { value: this.heatShimmerFrequency };
        shader.uniforms.emberDensity = { value: this.emberDensity };
        shader.uniforms.emberStrength = { value: this.emberStrength };
        shader.uniforms.emberGravity = { value: this.emberGravity };
        shader.uniforms.moltenCrackStrength = { value: this.moltenCrackStrength };
        shader.uniforms.uTime = { value: 0 };

        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float variationOffset;',
                `uniform float variationOffset;
                uniform float heatGradientStrength;
                uniform float flameTurbulenceStrength;
                uniform float flameTurbulenceSpeed;
                uniform float heatShimmerStrength;
                uniform float heatShimmerFrequency;
                uniform float emberDensity;
                uniform float emberStrength;
                uniform float emberGravity;
                uniform float moltenCrackStrength;
                uniform float uTime;
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Heat-shimmer UV warp: slightly warp UVs near flame edges
                vec2 fireUV = vUv;
                if (heatShimmerStrength > 0.0) {
                    float shimmer = sin(vUv.y * heatShimmerFrequency + uTime * 3.0 + variationOffset)
                                  * cos(vUv.x * heatShimmerFrequency * 0.7 + uTime * 2.4);
                    fireUV += vec2(shimmer * heatShimmerStrength * 0.05, 0.0);
                }

                // White-core + fire-halo radial falloff
                {
                    vec2 centreUV = fireUV - vec2(0.5);
                    float radialDist = length(centreUV) * 2.0;

                    float coreMask = max(0.0, 1.0 - radialDist / coreRadius);
                    coreMask = pow(coreMask, 1.4);
                    gl_FragColor.rgb += coreColor * coreMask * coreIntensity;

                    float haloInner = smoothstep(coreRadius * 0.75, coreRadius, radialDist);
                    float haloOuter = 1.0 - smoothstep(haloRadius * 0.7, haloRadius, radialDist);
                    float haloMask = haloInner * haloOuter;
                    gl_FragColor.rgb += haloColor * haloMask * 0.75;
                }

                // Upward-sheared flame turbulence (buoyancy-rising)
                if (flameTurbulenceStrength > 0.0) {
                    // The noise sample is displaced upward over time to simulate rising flame
                    float rise = uTime * flameTurbulenceSpeed;
                    float turb = sin(vUv.y * 8.0 - rise + variationOffset) * cos(vUv.x * 10.0 + rise * 0.6);
                    turb = turb * 0.5 + 0.5;
                    // Taper toward the top (buoyancy narrowing)
                    float taper = pow(1.0 - vUv.y, 0.7);
                    gl_FragColor.rgb += haloColor * turb * flameTurbulenceStrength * taper * 0.20;
                }

                // Black-body heat gradient overlay
                if (heatGradientStrength > 0.0) {
                    // Heat value = radius-based (center hottest) × turbulence
                    float heat = max(0.0, 1.0 - length(fireUV - vec2(0.5)) * 2.0);
                    heat = pow(heat, 0.8) * heatGradientStrength;
                    // Dull red → orange → yellow → white-hot
                    vec3 heatColor;
                    if (heat > 0.9) heatColor = vec3(1.0, 1.0, 1.0);
                    else if (heat > 0.65) heatColor = vec3(1.0, 0.85, 0.15);
                    else if (heat > 0.4) heatColor = vec3(1.0, 0.45, 0.05);
                    else heatColor = vec3(0.4, 0.05, 0.02);
                    gl_FragColor.rgb += heatColor * heat * 0.22;
                }

                // Ember sparks: hashed cells that rise upward with time
                if (emberStrength > 0.0) {
                    vec2 emberUV = fireUV * 50.0;
                    emberUV.y += uTime * 2.5;  // embers rise
                    vec2 emberCell = floor(emberUV);
                    vec2 emberFrac = fract(emberUV);
                    float emberHash = fract(sin(dot(emberCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (emberHash > (1.0 - emberDensity)) {
                        vec2 emberCentre = vec2(fract(emberHash * 7.31), fract(emberHash * 13.7));
                        float emberDist = length(emberFrac - emberCentre);
                        float emberMask = max(0.0, 1.0 - emberDist * 5.0);
                        // Ember gravity: dim embers that have risen higher
                        float gravity = 1.0 - vUv.y * emberGravity;
                        gl_FragColor.rgb += vec3(1.0, 0.65, 0.20) * emberMask * emberStrength * gravity;
                    }
                }

                // Molten-lava cracks: low-frequency dark veins on the surface
                if (moltenCrackStrength > 0.0) {
                    float crack = sin(vUv.x * 18.0 + variationOffset) * cos(vUv.y * 14.0 + variationOffset);
                    crack = 1.0 - abs(crack);
                    crack = pow(crack, 6.0);
                    gl_FragColor.rgb *= (1.0 - crack * moltenCrackStrength * 0.6);
                }

                // Bright rim glow on fire edges
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
            this.heatGradientStrength, this.flameTurbulenceStrength,
            this.flameTurbulenceSpeed, this.heatShimmerStrength,
            this.heatShimmerFrequency, this.emberDensity,
            this.emberStrength, this.emberGravity,
            this.moltenCrackStrength
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.heatGradientStrength = source.heatGradientStrength;
        this.flameTurbulenceStrength = source.flameTurbulenceStrength;
        this.flameTurbulenceSpeed = source.flameTurbulenceSpeed;
        this.heatShimmerStrength = source.heatShimmerStrength;
        this.heatShimmerFrequency = source.heatShimmerFrequency;
        this.emberDensity = source.emberDensity;
        this.emberStrength = source.emberStrength;
        this.emberGravity = source.emberGravity;
        this.moltenCrackStrength = source.moltenCrackStrength;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'MagicSpellFireMaterial';
        if (this.heatGradientStrength !== 1.0) data.heatGradientStrength = this.heatGradientStrength;
        if (this.flameTurbulenceStrength !== 0.55) data.flameTurbulenceStrength = this.flameTurbulenceStrength;
        if (this.flameTurbulenceSpeed !== 1.6) data.flameTurbulenceSpeed = this.flameTurbulenceSpeed;
        if (this.heatShimmerStrength !== 0.25) data.heatShimmerStrength = this.heatShimmerStrength;
        if (this.heatShimmerFrequency !== 12.0) data.heatShimmerFrequency = this.heatShimmerFrequency;
        if (this.emberDensity !== 0.35) data.emberDensity = this.emberDensity;
        if (this.emberStrength !== 0.55) data.emberStrength = this.emberStrength;
        if (this.emberGravity !== 0.60) data.emberGravity = this.emberGravity;
        if (this.moltenCrackStrength !== 0.0) data.moltenCrackStrength = this.moltenCrackStrength;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.heatGradientStrength = json.heatGradientStrength ?? this.heatGradientStrength;
        this.flameTurbulenceStrength = json.flameTurbulenceStrength ?? this.flameTurbulenceStrength;
        this.flameTurbulenceSpeed = json.flameTurbulenceSpeed ?? this.flameTurbulenceSpeed;
        this.heatShimmerStrength = json.heatShimmerStrength ?? this.heatShimmerStrength;
        this.heatShimmerFrequency = json.heatShimmerFrequency ?? this.heatShimmerFrequency;
        this.emberDensity = json.emberDensity ?? this.emberDensity;
        this.emberStrength = json.emberStrength ?? this.emberStrength;
        this.emberGravity = json.emberGravity ?? this.emberGravity;
        this.moltenCrackStrength = json.moltenCrackStrength ?? this.moltenCrackStrength;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const MagicSpellFireMaterialBatchComponent = {
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
    heatGradientStrength: 'f64',
    flameTurbulenceStrength: 'f64',
    flameTurbulenceSpeed: 'f64',
    heatShimmerStrength: 'f64',
    heatShimmerFrequency: 'f64',
    emberDensity: 'f64',
    emberStrength: 'f64',
    emberGravity: 'f64',
    moltenCrackStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    MagicSpellFireMaterial,
    MagicSpellFireMaterialBatch,
    MagicSpellFireScratchPool,
    MagicSpellFireMaterialBatchComponent,
    MagicSpellFirePresets,
    applyFireCelBanding,
    gradeFireColor,
    generateFireTurbulenceTexture
};

export default MagicSpellFireMaterial;