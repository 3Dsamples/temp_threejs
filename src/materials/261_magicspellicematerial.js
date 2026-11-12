// file number : 261
// full path name : src/materials/261_magicspellicematerial.js
// description : MagicSpellIceMaterial — a ready-to-use ice-magic spell
//               material for ice shards, frost bursts, ice walls, frozen
//               projectiles, and crystalline magic with a white-hot core.
//               Extends MagicSpellBaseMaterial with ice-specific features: a
//               cool-cyan-to-white "cold-light" gradient (mirroring the
//               fire material's heat ramp), crystalline facet approximation
//               via hashed Voronoi cells, frost-spark glints, icy vapor
//               drift with downward-sheared turbulence (mirroring fire's
//               upward buoyancy), and a freeze-crack overlay for frozen
//               surfaces. Adds real-time anime stylization: cel-banded ice
//               highlights, cold-light gradient, animated frost pulse, mood
//               tinting, rim glow, and per-instance variation. Includes a
//               procedural ice-turbulence texture generator using
//               downward-sheared domain-warped fBm with a cold-light palette
//               ramp (deep blue → cyan → white-ice → white-hot).
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Ice magic spells, ice shards, frost bursts, ice walls, frozen
//            projectiles, blizzard attacks, anime ice techniques, ice
//            runes, freeze effects, and any ice-magic surface that needs
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
// Ice presets — physically grounded parameter sets for ice-magic VFX.
//
// Cold-light gradient (mirror of the fire "heat" ramp):
//   deep blue (0.06,0.15,0.42) → cyan (0.10,0.75,1.0)
//   → white-ice (0.82,0.95,1.0) → white-hot (1.0,1.0,1.0)
// ---------------------------------------------------------------------------

const MagicSpellIcePresets = {
    'ice-frost-blue': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 18.0,
        coreRadius: 0.22,
        haloColor: [0.14, 0.55, 1.0],
        haloRadius: 0.65,
        spellColor: [0.08, 0.32, 0.72],
        opacity: 0.92,
        pulseStrength: 0.35,
        pulseFrequency: 5.0,
        energyStreakStrength: 0.26,
        coldGradientStrength: 1.0,
        crystalFacetStrength: 0.45,
        crystalFacetCells: 18.0,
        frostSparkDensity: 0.18,
        frostSparkStrength: 0.55,
        vaporDriftStrength: 0.30,
        vaporDriftSpeed: 0.9,
        freezeCrackStrength: 0.20
    },
    'ice-glacier-teal': {
        coreColor: [0.94, 1.0, 1.0],
        coreIntensity: 20.0,
        coreRadius: 0.24,
        haloColor: [0.10, 0.78, 0.92],
        haloRadius: 0.68,
        spellColor: [0.05, 0.42, 0.52],
        opacity: 0.94,
        pulseStrength: 0.32,
        pulseFrequency: 4.5,
        energyStreakStrength: 0.24,
        coldGradientStrength: 1.1,
        crystalFacetStrength: 0.50,
        crystalFacetCells: 16.0,
        frostSparkDensity: 0.20,
        frostSparkStrength: 0.60,
        vaporDriftStrength: 0.35,
        vaporDriftSpeed: 1.0,
        freezeCrackStrength: 0.25
    },
    'ice-white-out': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 30.0,
        coreRadius: 0.32,
        haloColor: [0.82, 0.96, 1.0],
        haloRadius: 0.80,
        spellColor: [0.55, 0.78, 0.92],
        opacity: 0.98,
        pulseStrength: 0.45,
        pulseFrequency: 6.5,
        energyStreakStrength: 0.34,
        coldGradientStrength: 1.4,
        crystalFacetStrength: 0.60,
        crystalFacetCells: 14.0,
        frostSparkDensity: 0.30,
        frostSparkStrength: 0.75,
        vaporDriftStrength: 0.45,
        vaporDriftSpeed: 1.3,
        freezeCrackStrength: 0.35
    },
    'ice-deep-freeze': {
        coreColor: [0.86, 0.92, 1.0],
        coreIntensity: 14.0,
        coreRadius: 0.28,
        haloColor: [0.08, 0.28, 0.72],
        haloRadius: 0.72,
        spellColor: [0.04, 0.14, 0.42],
        opacity: 0.96,
        pulseStrength: 0.40,
        pulseFrequency: 3.0,
        energyStreakStrength: 0.28,
        coldGradientStrength: 1.0,
        crystalFacetStrength: 0.55,
        crystalFacetCells: 20.0,
        frostSparkDensity: 0.22,
        frostSparkStrength: 0.55,
        vaporDriftStrength: 0.40,
        vaporDriftSpeed: 0.8,
        freezeCrackStrength: 0.55
    },
    'ice-crystal-shard': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 24.0,
        coreRadius: 0.20,
        haloColor: [0.62, 0.90, 1.0],
        haloRadius: 0.58,
        spellColor: [0.25, 0.55, 0.85],
        opacity: 0.95,
        pulseStrength: 0.38,
        pulseFrequency: 5.5,
        energyStreakStrength: 0.32,
        coldGradientStrength: 1.2,
        crystalFacetStrength: 0.75,
        crystalFacetCells: 10.0,
        frostSparkDensity: 0.25,
        frostSparkStrength: 0.70,
        vaporDriftStrength: 0.25,
        vaporDriftSpeed: 0.9,
        freezeCrackStrength: 0.30
    },
    'anime-ice': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 34.0,
        coreRadius: 0.36,
        haloColor: [0.55, 0.92, 1.0],
        haloRadius: 0.85,
        spellColor: [0.14, 0.42, 0.82],
        opacity: 1.0,
        pulseStrength: 0.60,
        pulseFrequency: 9.0,
        energyStreakStrength: 0.42,
        coldGradientStrength: 1.6,
        crystalFacetStrength: 0.85,
        crystalFacetCells: 9.0,
        frostSparkDensity: 0.35,
        frostSparkStrength: 0.85,
        vaporDriftStrength: 0.50,
        vaporDriftSpeed: 1.5,
        freezeCrackStrength: 0.45
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable ice-scratch records
// ---------------------------------------------------------------------------

class MagicSpellIceScratchPool {
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

const _magicSpellIceScratchPool = new MagicSpellIceScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — ice-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded ice highlights.
 */
function applyIceCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.03) {
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
 * Mood tinting for ice halo.
 */
function gradeIceColor(color, temperature, saturation, brightness, contrast) {
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
    // Ice-specific temperature bias: warm shift toward cool cyan;
    // cool shift toward deep blue.
    r += temperature * 0.030;
    g += temperature * 0.010;
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
 * Generate ice-turbulence texture: downward-sheared domain-warped fBm with
 * cold-light palette ramp.
 */
function generateIceTurbulenceTexture(width, height, scale = 0.03, octaves = 5, shearStrength = 0.35, turbulenceStrength = 0.55, coldGradientStrength = 1.0) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            // Downward shear: the noise field is displaced downward as v increases,
            // producing the characteristic falling ice / snow vapor drift.
            const shear = (y / height) * shearStrength * height;
            const sampleY = y - shear * 20.0;
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
            // Crystalline feather: crystal facets have sharp edges
            const crystal = Math.pow(Math.abs(fbm * 2.0 - 1.0), 0.5);
            const turbulence = (fbm * 0.7 + (1.0 - crystal) * 0.3) * turbulenceStrength;
            // Cold-light ramp: high value → white-hot core, low → deep blue
            const cold = Math.min(1, turbulence * coldGradientStrength + 0.30);
            let r, g, b;
            if (cold > 0.90) {
                r = 1.0; g = 1.0; b = 1.0;
            } else if (cold > 0.65) {
                r = 0.82; g = 0.95; b = 1.0;
            } else if (cold > 0.40) {
                r = 0.10; g = 0.75; b = 1.0;
            } else {
                r = 0.06; g = 0.15; b = 0.42;
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

const _magicSpellIceWorld = BitECS.createWorld();
const MagicSpellIceMaterialComponent = BitECS.defineComponent({
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
    coldGradientStrength: 'f64',
    crystalFacetStrength: 'f64',
    crystalFacetCells: 'f64',
    frostSparkDensity: 'f64',
    frostSparkStrength: 'f64',
    vaporDriftStrength: 'f64',
    vaporDriftSpeed: 'f64',
    freezeCrackStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class MagicSpellIceMaterialBatch {
    constructor() {
        this.world = _magicSpellIceWorld;
        this.materials = [];
        this.entities = [];
        this._elapsed = 0;
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, MagicSpellIceMaterialComponent, eid);
        MagicSpellIceMaterialComponent.materialPtr[eid] = this.materials.length;
        MagicSpellIceMaterialComponent.magicBands[eid] = material.magicBands;
        MagicSpellIceMaterialComponent.magicQuantize[eid] = material.magicQuantize;
        MagicSpellIceMaterialComponent.magicSoftness[eid] = material.magicSoftness;
        MagicSpellIceMaterialComponent.coreIntensity[eid] = material.coreIntensity;
        MagicSpellIceMaterialComponent.coreRadius[eid] = material.coreRadius;
        MagicSpellIceMaterialComponent.haloRadius[eid] = material.haloRadius;
        MagicSpellIceMaterialComponent.haloColorR[eid] = material.haloColor.r;
        MagicSpellIceMaterialComponent.haloColorG[eid] = material.haloColor.g;
        MagicSpellIceMaterialComponent.haloColorB[eid] = material.haloColor.b;
        MagicSpellIceMaterialComponent.pulseStrength[eid] = material.pulseStrength;
        MagicSpellIceMaterialComponent.pulseFrequency[eid] = material.pulseFrequency;
        MagicSpellIceMaterialComponent.energyStreakStrength[eid] = material.energyStreakStrength;
        MagicSpellIceMaterialComponent.coldGradientStrength[eid] = material.coldGradientStrength;
        MagicSpellIceMaterialComponent.crystalFacetStrength[eid] = material.crystalFacetStrength;
        MagicSpellIceMaterialComponent.crystalFacetCells[eid] = material.crystalFacetCells;
        MagicSpellIceMaterialComponent.frostSparkDensity[eid] = material.frostSparkDensity;
        MagicSpellIceMaterialComponent.frostSparkStrength[eid] = material.frostSparkStrength;
        MagicSpellIceMaterialComponent.vaporDriftStrength[eid] = material.vaporDriftStrength;
        MagicSpellIceMaterialComponent.vaporDriftSpeed[eid] = material.vaporDriftSpeed;
        MagicSpellIceMaterialComponent.freezeCrackStrength[eid] = material.freezeCrackStrength;
        MagicSpellIceMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        MagicSpellIceMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        MagicSpellIceMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        MagicSpellIceMaterialComponent.moodContrast[eid] = material.moodContrast;
        MagicSpellIceMaterialComponent.rimGlow[eid] = material.rimGlow;
        MagicSpellIceMaterialComponent.variationSeed[eid] = material.variationSeed;
        MagicSpellIceMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MagicSpellIceMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            material.magicBands = MagicSpellIceMaterialComponent.magicBands[eid];
            material.magicQuantize = MagicSpellIceMaterialComponent.magicQuantize[eid];
            material.magicSoftness = MagicSpellIceMaterialComponent.magicSoftness[eid];
            material.coreIntensity = MagicSpellIceMaterialComponent.coreIntensity[eid];
            material.coreRadius = MagicSpellIceMaterialComponent.coreRadius[eid];
            material.haloRadius = MagicSpellIceMaterialComponent.haloRadius[eid];
            material.haloColor.setRGB(
                MagicSpellIceMaterialComponent.haloColorR[eid],
                MagicSpellIceMaterialComponent.haloColorG[eid],
                MagicSpellIceMaterialComponent.haloColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.pulseStrength = MagicSpellIceMaterialComponent.pulseStrength[eid];
            material.pulseFrequency = MagicSpellIceMaterialComponent.pulseFrequency[eid];
            material.energyStreakStrength = MagicSpellIceMaterialComponent.energyStreakStrength[eid];
            material.coldGradientStrength = MagicSpellIceMaterialComponent.coldGradientStrength[eid];
            material.crystalFacetStrength = MagicSpellIceMaterialComponent.crystalFacetStrength[eid];
            material.crystalFacetCells = MagicSpellIceMaterialComponent.crystalFacetCells[eid];
            material.frostSparkDensity = MagicSpellIceMaterialComponent.frostSparkDensity[eid];
            material.frostSparkStrength = MagicSpellIceMaterialComponent.frostSparkStrength[eid];
            material.vaporDriftStrength = MagicSpellIceMaterialComponent.vaporDriftStrength[eid];
            material.vaporDriftSpeed = MagicSpellIceMaterialComponent.vaporDriftSpeed[eid];
            material.freezeCrackStrength = MagicSpellIceMaterialComponent.freezeCrackStrength[eid];
            material.moodTemperature = MagicSpellIceMaterialComponent.moodTemperature[eid];
            material.moodSaturation = MagicSpellIceMaterialComponent.moodSaturation[eid];
            material.moodBrightness = MagicSpellIceMaterialComponent.moodBrightness[eid];
            material.moodContrast = MagicSpellIceMaterialComponent.moodContrast[eid];
            material.rimGlow = MagicSpellIceMaterialComponent.rimGlow[eid];
            material.variationSeed = MagicSpellIceMaterialComponent.variationSeed[eid];
            MagicSpellIceMaterialComponent.dirty[eid] = 1;
        }
    }

    update(delta) {
        this._elapsed += delta;
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MagicSpellIceMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            if (material.uniforms && material.uniforms.uTime) {
                material.uniforms.uTime.value = this._elapsed;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Main MagicSpellIceMaterial class
// ---------------------------------------------------------------------------

class MagicSpellIceMaterial extends MagicSpellBaseMaterial {
    static {
        _magicSpellIceScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isMagicSpellIceMaterial = true;
        this.type = 'MagicSpellIceMaterial';

        this.magicBands = 4;
        this.magicQuantize = 0.7;
        this.magicSoftness = 0.03;
        this.coreIntensity = 18.0;
        this.coreRadius = 0.22;
        this.haloRadius = 0.65;
        this.pulseStrength = 0.35;
        this.pulseFrequency = 5.0;
        this.energyStreakStrength = 0.26;

        // Ice-specific controls
        this.coldGradientStrength = 1.0;
        this.crystalFacetStrength = 0.45;
        this.crystalFacetCells = 18.0;
        this.frostSparkDensity = 0.18;
        this.frostSparkStrength = 0.55;
        this.vaporDriftStrength = 0.30;
        this.vaporDriftSpeed = 0.9;
        this.freezeCrackStrength = 0.20;

        // Ice colour defaults (frost blue)
        this.color = new Color(0.08, 0.32, 0.72);
        this.haloColor = new Color(0.14, 0.55, 1.0);
        this.rimGlowColor = new Color(0.14, 0.55, 1.0);
        this.coreColor = new Color(1.0, 1.0, 1.0);
        this.emissiveIntensity = 18.0;

        this.uniforms = {};

        this.transparent = true;
        this.opacity = 0.92;
        this.depthWrite = false;
        this.blending = Constants.ADDITIVE_BLENDING ?? 2;
        this.side = Constants.DOUBLE_SIDE ?? 2;

        this.renderStyleBlend = 0.70;
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    applyIceBanding(baseColor, output) {
        return applyIceCelBanding(baseColor, output, this.magicBands, this.magicQuantize, this.magicSoftness);
    }

    updateMoodColor() {
        gradeIceColor(this.haloColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        this.rimGlowColor.copy(this.haloColor);
        return this;
    }

    applyPreset(presetName) {
        const preset = MagicSpellIcePresets[presetName];
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
        this.coldGradientStrength = preset.coldGradientStrength;
        this.crystalFacetStrength = preset.crystalFacetStrength;
        this.crystalFacetCells = preset.crystalFacetCells;
        this.frostSparkDensity = preset.frostSparkDensity;
        this.frostSparkStrength = preset.frostSparkStrength;
        this.vaporDriftStrength = preset.vaporDriftStrength;
        this.vaporDriftSpeed = preset.vaporDriftSpeed;
        this.freezeCrackStrength = preset.freezeCrackStrength;

        if (presetName === 'anime-ice') {
            this.magicSoftness = 0.02;
            this.magicBands = 5;
            this.rimGlow = 0.42;
        } else {
            this.magicSoftness = 0.03;
            this.magicBands = 4;
            this.rimGlow = 0.28;
        }

        this.updateMoodColor();
        return this;
    }

    generateIceTurbulenceTexture(width, height, scale = 0.03, octaves = 5, shearStrength = 0.35, turbulenceStrength = 0.55, coldGradientStrength = 1.0) {
        return generateIceTurbulenceTexture(width, height, scale, octaves, shearStrength, turbulenceStrength, coldGradientStrength);
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

        shader.uniforms.coldGradientStrength = { value: this.coldGradientStrength };
        shader.uniforms.crystalFacetStrength = { value: this.crystalFacetStrength };
        shader.uniforms.crystalFacetCells = { value: this.crystalFacetCells };
        shader.uniforms.frostSparkDensity = { value: this.frostSparkDensity };
        shader.uniforms.frostSparkStrength = { value: this.frostSparkStrength };
        shader.uniforms.vaporDriftStrength = { value: this.vaporDriftStrength };
        shader.uniforms.vaporDriftSpeed = { value: this.vaporDriftSpeed };
        shader.uniforms.freezeCrackStrength = { value: this.freezeCrackStrength };
        shader.uniforms.uTime = { value: 0 };

        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float variationOffset;',
                `uniform float variationOffset;
                uniform float coldGradientStrength;
                uniform float crystalFacetStrength;
                uniform float crystalFacetCells;
                uniform float frostSparkDensity;
                uniform float frostSparkStrength;
                uniform float vaporDriftStrength;
                uniform float vaporDriftSpeed;
                uniform float freezeCrackStrength;
                uniform float uTime;
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // White-core + ice-halo radial falloff
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

                // Crystalline facet approximation: hashed Voronoi-cell flat facets
                if (crystalFacetStrength > 0.0) {
                    vec2 facetUV = vUv * crystalFacetCells;
                    vec2 facetCell = floor(facetUV);
                    float facetHash = fract(sin(dot(facetCell, vec2(12.9898, 78.233))) * 43758.5453);
                    // Per-facet brightness offset (each facet is a mirrored flat)
                    float facetBrightness = (facetHash - 0.5) * crystalFacetStrength;
                    gl_FragColor.rgb += haloColor * facetBrightness * 0.25;

                    // Facet edge: bright line between cells
                    vec2 facetFrac = fract(facetUV);
                    float facetEdge = min(min(facetFrac.x, 1.0 - facetFrac.x), min(facetFrac.y, 1.0 - facetFrac.y));
                    float edgeLine = smoothstep(0.05, 0.0, facetEdge);
                    gl_FragColor.rgb += vec3(0.92, 0.98, 1.0) * edgeLine * crystalFacetStrength * 0.35;
                }

                // Frost-spark glints: hashed bright specks
                if (frostSparkStrength > 0.0) {
                    vec2 sparkUV = vUv * 60.0;
                    vec2 sparkCell = floor(sparkUV);
                    float sparkHash = fract(sin(dot(sparkCell, vec2(39.425, 1.57))) * 43758.5453);
                    if (sparkHash > (1.0 - frostSparkDensity)) {
                        gl_FragColor.rgb += vec3(0.95, 1.0, 1.0) * sparkHash * frostSparkStrength;
                    }
                }

                // Icy vapor drift: downward-sheared turbulence (mirror of fire's rise)
                if (vaporDriftStrength > 0.0) {
                    float fall = uTime * vaporDriftSpeed;
                    float turb = sin(vUv.y * 7.0 + fall + variationOffset) * cos(vUv.x * 9.0 - fall * 0.6);
                    turb = turb * 0.5 + 0.5;
                    // Taper at the base (vapor sinks and drifts)
                    float taper = pow(vUv.y, 0.7);
                    gl_FragColor.rgb += haloColor * turb * vaporDriftStrength * taper * 0.22;
                }

                // Cold-light gradient overlay (mirror of fire's black-body ramp)
                if (coldGradientStrength > 0.0) {
                    float cold = max(0.0, 1.0 - length(vUv - vec2(0.5)) * 2.0);
                    cold = pow(cold, 0.8) * coldGradientStrength;
                    vec3 coldColor;
                    if (cold > 0.9) coldColor = vec3(1.0, 1.0, 1.0);
                    else if (cold > 0.65) coldColor = vec3(0.82, 0.95, 1.0);
                    else if (cold > 0.4) coldColor = vec3(0.10, 0.75, 1.0);
                    else coldColor = vec3(0.06, 0.15, 0.42);
                    gl_FragColor.rgb += coldColor * cold * 0.22;
                }

                // Freeze-crack overlay: low-frequency dark veins
                if (freezeCrackStrength > 0.0) {
                    float crack = sin(vUv.x * 22.0 + variationOffset) * cos(vUv.y * 18.0 + variationOffset);
                    crack = 1.0 - abs(crack);
                    crack = pow(crack, 8.0);
                    gl_FragColor.rgb *= (1.0 - crack * freezeCrackStrength * 0.5);
                }

                // Bright rim glow on ice edges
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
            this.coldGradientStrength, this.crystalFacetStrength,
            this.crystalFacetCells, this.frostSparkDensity,
            this.frostSparkStrength, this.vaporDriftStrength,
            this.vaporDriftSpeed, this.freezeCrackStrength
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.coldGradientStrength = source.coldGradientStrength;
        this.crystalFacetStrength = source.crystalFacetStrength;
        this.crystalFacetCells = source.crystalFacetCells;
        this.frostSparkDensity = source.frostSparkDensity;
        this.frostSparkStrength = source.frostSparkStrength;
        this.vaporDriftStrength = source.vaporDriftStrength;
        this.vaporDriftSpeed = source.vaporDriftSpeed;
        this.freezeCrackStrength = source.freezeCrackStrength;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'MagicSpellIceMaterial';
        if (this.coldGradientStrength !== 1.0) data.coldGradientStrength = this.coldGradientStrength;
        if (this.crystalFacetStrength !== 0.45) data.crystalFacetStrength = this.crystalFacetStrength;
        if (this.crystalFacetCells !== 18.0) data.crystalFacetCells = this.crystalFacetCells;
        if (this.frostSparkDensity !== 0.18) data.frostSparkDensity = this.frostSparkDensity;
        if (this.frostSparkStrength !== 0.55) data.frostSparkStrength = this.frostSparkStrength;
        if (this.vaporDriftStrength !== 0.30) data.vaporDriftStrength = this.vaporDriftStrength;
        if (this.vaporDriftSpeed !== 0.9) data.vaporDriftSpeed = this.vaporDriftSpeed;
        if (this.freezeCrackStrength !== 0.20) data.freezeCrackStrength = this.freezeCrackStrength;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.coldGradientStrength = json.coldGradientStrength ?? this.coldGradientStrength;
        this.crystalFacetStrength = json.crystalFacetStrength ?? this.crystalFacetStrength;
        this.crystalFacetCells = json.crystalFacetCells ?? this.crystalFacetCells;
        this.frostSparkDensity = json.frostSparkDensity ?? this.frostSparkDensity;
        this.frostSparkStrength = json.frostSparkStrength ?? this.frostSparkStrength;
        this.vaporDriftStrength = json.vaporDriftStrength ?? this.vaporDriftStrength;
        this.vaporDriftSpeed = json.vaporDriftSpeed ?? this.vaporDriftSpeed;
        this.freezeCrackStrength = json.freezeCrackStrength ?? this.freezeCrackStrength;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const MagicSpellIceMaterialBatchComponent = {
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
    coldGradientStrength: 'f64',
    crystalFacetStrength: 'f64',
    crystalFacetCells: 'f64',
    frostSparkDensity: 'f64',
    frostSparkStrength: 'f64',
    vaporDriftStrength: 'f64',
    vaporDriftSpeed: 'f64',
    freezeCrackStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    MagicSpellIceMaterial,
    MagicSpellIceMaterialBatch,
    MagicSpellIceScratchPool,
    MagicSpellIceMaterialBatchComponent,
    MagicSpellIcePresets,
    applyIceCelBanding,
    gradeIceColor,
    generateIceTurbulenceTexture
};

export default MagicSpellIceMaterial;