// file number : 259
// full path name : src/materials/259_magicspellbasematerial.js
// description : MagicSpellBaseMaterial — foundational magic spell material for
//               real-time rendering of glowing magical effects. Extends
//               MeshPhysicalMaterial with magic-specific defaults grounded in
//               real-time VFX references: additive blending for the magical
//               glow, HDR emissive intensity 10–25 (well above 1.0 so bloom
//               post-processing produces the characteristic magic glow),
//               transparent + depthWrite disabled for correct blending, and a
//               bright white-hot core with a coloured magical halo. Adds
//               real-time anime stylization: cel-banded magic highlights,
//               white-core radial falloff, animated energy pulse, mood
//               tinting, rim glow, and per-instance variation. Includes a
//               procedural magic-rune texture generator using multi-octave
//               fBm with hashed rune glyphs. All imports resolve to the
//               internal Threejs_gl repository tree; no CDN dependencies.
// best for : Base magic spell material for fireballs, ice shards, lightning
//            bolts, arcane orbs, healing auras, magic circles, spell
//            projectiles, and any emissive magical surface that needs
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
// Magic spell presets — physically grounded parameter sets for magic VFX.
//
// Reference values (from real-time VFX and magical effect references):
//   - Emissive intensity:    10–25 (HDR values above 1.0 trigger bloom)
//   - Additive blending:     Yes (for glows that bloom white in dense areas)
//   - Transparent:           Yes
//   - depthWrite:            False (so overlapping effects blend additively)
//   - Roughness:             0.0 (pure emissive, no specular response)
//   - Metalness:             0.0
//   - Core color:            Near-white for the white-hot centre
//   - Halo color:            Saturated spell colour
// ---------------------------------------------------------------------------

const MagicSpellBasePresets = {
    'arcane-purple': {
        coreColor: [1.0, 0.98, 1.0],
        coreIntensity: 15.0,
        coreRadius: 0.22,
        haloColor: [0.72, 0.22, 1.0],
        haloRadius: 0.62,
        spellColor: [0.45, 0.10, 0.72],
        opacity: 0.92,
        pulseStrength: 0.35,
        pulseFrequency: 4.0,
        energyStreakStrength: 0.25,
        runeGlyphDensity: 0.15,
        runeGlyphStrength: 0.30
    },
    'holy-gold': {
        coreColor: [1.0, 1.0, 0.98],
        coreIntensity: 18.0,
        coreRadius: 0.24,
        haloColor: [1.0, 0.88, 0.42],
        haloRadius: 0.65,
        spellColor: [0.82, 0.62, 0.18],
        opacity: 0.94,
        pulseStrength: 0.30,
        pulseFrequency: 3.0,
        energyStreakStrength: 0.22,
        runeGlyphDensity: 0.18,
        runeGlyphStrength: 0.35
    },
    'nature-green': {
        coreColor: [1.0, 1.0, 0.96],
        coreIntensity: 14.0,
        coreRadius: 0.22,
        haloColor: [0.28, 0.92, 0.45],
        haloRadius: 0.60,
        spellColor: [0.10, 0.62, 0.22],
        opacity: 0.90,
        pulseStrength: 0.40,
        pulseFrequency: 5.0,
        energyStreakStrength: 0.28,
        runeGlyphDensity: 0.12,
        runeGlyphStrength: 0.25
    },
    'psychic-pink': {
        coreColor: [1.0, 0.98, 1.0],
        coreIntensity: 16.0,
        coreRadius: 0.22,
        haloColor: [1.0, 0.42, 0.82],
        haloRadius: 0.62,
        spellColor: [0.72, 0.10, 0.52],
        opacity: 0.92,
        pulseStrength: 0.38,
        pulseFrequency: 5.0,
        energyStreakStrength: 0.25,
        runeGlyphDensity: 0.14,
        runeGlyphStrength: 0.30
    },
    'void-black-purple': {
        coreColor: [0.85, 0.72, 1.0],
        coreIntensity: 12.0,
        coreRadius: 0.28,
        haloColor: [0.48, 0.10, 0.62],
        haloRadius: 0.70,
        spellColor: [0.18, 0.02, 0.28],
        opacity: 0.96,
        pulseStrength: 0.50,
        pulseFrequency: 2.5,
        energyStreakStrength: 0.35,
        runeGlyphDensity: 0.20,
        runeGlyphStrength: 0.40
    },
    'anime-magic': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 25.0,
        coreRadius: 0.32,
        haloColor: [1.0, 0.65, 0.92],
        haloRadius: 0.75,
        spellColor: [0.75, 0.42, 0.72],
        opacity: 0.98,
        pulseStrength: 0.55,
        pulseFrequency: 8.0,
        energyStreakStrength: 0.40,
        runeGlyphDensity: 0.22,
        runeGlyphStrength: 0.45
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable magic spell scratch records
// ---------------------------------------------------------------------------

class MagicSpellBaseScratchPool {
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

const _magicSpellBaseScratchPool = new MagicSpellBaseScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — magic-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded magic highlights.
 */
function applyMagicCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.03) {
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
 * Mood tinting for magic halo.
 */
function gradeMagicColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate a procedural magic-rune texture with fBm and hashed glyphs.
 */
function generateMagicRuneTexture(width, height, scale = 0.02, octaves = 4, glyphDensity = 0.15, glyphStrength = 0.30, runeRingRadius = 0.40) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
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
            // Hashed glyph cells
            const cellX = Math.floor(x * 0.15);
            const cellY = Math.floor(y * 0.15);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const hash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;
            let glyph = 0;
            if (hash > (1.0 - glyphDensity)) {
                glyph = hash * glyphStrength;
            }
            // Central rune ring
            const dx = (x / width) - 0.5;
            const dy = (y / height) - 0.5;
            const radial = Math.sqrt(dx * dx + dy * dy) * 2.0;
            const ringDist = Math.abs(radial - runeRingRadius);
            const ringMask = Math.max(0, 1.0 - ringDist / 0.05) * 0.35;
            let value = 0.45 + (fbm - 0.5) * 0.15 + glyph * 0.25 + ringMask;
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

const _magicSpellBaseWorld = BitECS.createWorld();
const MagicSpellBaseMaterialComponent = BitECS.defineComponent({
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
    runeGlyphDensity: 'f64',
    runeGlyphStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class MagicSpellBaseMaterialBatch {
    constructor() {
        this.world = _magicSpellBaseWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, MagicSpellBaseMaterialComponent, eid);
        MagicSpellBaseMaterialComponent.materialPtr[eid] = this.materials.length;
        MagicSpellBaseMaterialComponent.magicBands[eid] = material.magicBands;
        MagicSpellBaseMaterialComponent.magicQuantize[eid] = material.magicQuantize;
        MagicSpellBaseMaterialComponent.magicSoftness[eid] = material.magicSoftness;
        MagicSpellBaseMaterialComponent.coreIntensity[eid] = material.coreIntensity;
        MagicSpellBaseMaterialComponent.coreRadius[eid] = material.coreRadius;
        MagicSpellBaseMaterialComponent.haloRadius[eid] = material.haloRadius;
        MagicSpellBaseMaterialComponent.haloColorR[eid] = material.haloColor.r;
        MagicSpellBaseMaterialComponent.haloColorG[eid] = material.haloColor.g;
        MagicSpellBaseMaterialComponent.haloColorB[eid] = material.haloColor.b;
        MagicSpellBaseMaterialComponent.pulseStrength[eid] = material.pulseStrength;
        MagicSpellBaseMaterialComponent.pulseFrequency[eid] = material.pulseFrequency;
        MagicSpellBaseMaterialComponent.energyStreakStrength[eid] = material.energyStreakStrength;
        MagicSpellBaseMaterialComponent.runeGlyphDensity[eid] = material.runeGlyphDensity;
        MagicSpellBaseMaterialComponent.runeGlyphStrength[eid] = material.runeGlyphStrength;
        MagicSpellBaseMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        MagicSpellBaseMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        MagicSpellBaseMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        MagicSpellBaseMaterialComponent.moodContrast[eid] = material.moodContrast;
        MagicSpellBaseMaterialComponent.rimGlow[eid] = material.rimGlow;
        MagicSpellBaseMaterialComponent.variationSeed[eid] = material.variationSeed;
        MagicSpellBaseMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MagicSpellBaseMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            material.magicBands = MagicSpellBaseMaterialComponent.magicBands[eid];
            material.magicQuantize = MagicSpellBaseMaterialComponent.magicQuantize[eid];
            material.magicSoftness = MagicSpellBaseMaterialComponent.magicSoftness[eid];
            material.coreIntensity = MagicSpellBaseMaterialComponent.coreIntensity[eid];
            material.coreRadius = MagicSpellBaseMaterialComponent.coreRadius[eid];
            material.haloRadius = MagicSpellBaseMaterialComponent.haloRadius[eid];
            material.haloColor.setRGB(
                MagicSpellBaseMaterialComponent.haloColorR[eid],
                MagicSpellBaseMaterialComponent.haloColorG[eid],
                MagicSpellBaseMaterialComponent.haloColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.pulseStrength = MagicSpellBaseMaterialComponent.pulseStrength[eid];
            material.pulseFrequency = MagicSpellBaseMaterialComponent.pulseFrequency[eid];
            material.energyStreakStrength = MagicSpellBaseMaterialComponent.energyStreakStrength[eid];
            material.runeGlyphDensity = MagicSpellBaseMaterialComponent.runeGlyphDensity[eid];
            material.runeGlyphStrength = MagicSpellBaseMaterialComponent.runeGlyphStrength[eid];
            material.moodTemperature = MagicSpellBaseMaterialComponent.moodTemperature[eid];
            material.moodSaturation = MagicSpellBaseMaterialComponent.moodSaturation[eid];
            material.moodBrightness = MagicSpellBaseMaterialComponent.moodBrightness[eid];
            material.moodContrast = MagicSpellBaseMaterialComponent.moodContrast[eid];
            material.rimGlow = MagicSpellBaseMaterialComponent.rimGlow[eid];
            material.variationSeed = MagicSpellBaseMaterialComponent.variationSeed[eid];
            MagicSpellBaseMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MagicSpellBaseMaterial class
// ---------------------------------------------------------------------------

class MagicSpellBaseMaterial extends MeshPhysicalMaterial {
    static {
        _magicSpellBaseScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isMagicSpellBaseMaterial = true;
        this.type = 'MagicSpellBaseMaterial';

        // -------------------------------------------------------------------
        // Magic-specific PBR defaults (arcane-purple baseline)
        // -------------------------------------------------------------------
        this.ior = 1.50;
        this.specularIntensity = 0.0;
        this.roughness = 0.0;
        this.metalness = 0.0;
        this.specularColor = new Color(0, 0, 0);
        this.color = new Color(0.45, 0.10, 0.72);

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        this.transmission = 0.0;
        this.thickness = 0.001;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        // Emissive magic glow
        this.emissive = new Color(1.0, 0.98, 1.0);
        this.emissiveIntensity = 15.0;

        // Additive blending for the magic glow
        this.transparent = true;
        this.opacity = 0.92;
        this.depthWrite = false;
        this.blending = Constants.ADDITIVE_BLENDING ?? 2;
        this.side = Constants.DOUBLE_SIDE ?? 2;

        this.iridescence = 0.0;
        this.iridescenceIOR = 1.30;
        this.iridescenceThicknessRange = [100, 400];

        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — magic-specific
        // -------------------------------------------------------------------
        this.magicBands = 4;
        this.magicQuantize = 0.6;
        this.magicSoftness = 0.03;

        // White core + coloured halo
        this.coreColor = new Color(1.0, 0.98, 1.0);
        this.coreIntensity = 15.0;
        this.coreRadius = 0.22;
        this.haloColor = new Color(0.72, 0.22, 1.0);
        this.haloRadius = 0.62;

        // Pulse / energy-streak / rune controls
        this.pulseStrength = 0.35;
        this.pulseFrequency = 4.0;
        this.energyStreakStrength = 0.25;
        this.runeGlyphDensity = 0.15;
        this.runeGlyphStrength = 0.30;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.22;
        this.rimGlowColor = new Color(0.72, 0.22, 1.0);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (magic leans anime)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.65;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    applyMagicBanding(baseColor, output) {
        return applyMagicCelBanding(baseColor, output, this.magicBands, this.magicQuantize, this.magicSoftness);
    }

    updateMoodColor() {
        gradeMagicColor(this.haloColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        this.rimGlowColor.copy(this.haloColor);
        return this;
    }

    applyPreset(presetName) {
        const preset = MagicSpellBasePresets[presetName];
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
        this.runeGlyphDensity = preset.runeGlyphDensity;
        this.runeGlyphStrength = preset.runeGlyphStrength;

        if (presetName === 'anime-magic') {
            this.magicSoftness = 0.02;
            this.magicBands = 5;
            this.rimGlow = 0.35;
        } else {
            this.magicSoftness = 0.03;
            this.magicBands = 4;
            this.rimGlow = 0.22;
        }

        this.updateMoodColor();
        return this;
    }

    generateMagicRuneTexture(width, height, scale = 0.02, octaves = 4, glyphDensity = 0.15, glyphStrength = 0.30) {
        return generateMagicRuneTexture(width, height, scale, octaves, glyphDensity, glyphStrength, 0.40);
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

        shader.uniforms.magicBands = { value: this.magicBands };
        shader.uniforms.magicQuantize = { value: this.magicQuantize };
        shader.uniforms.magicSoftness = { value: this.magicSoftness };
        shader.uniforms.coreColor = { value: this.coreColor };
        shader.uniforms.coreIntensity = { value: this.coreIntensity };
        shader.uniforms.coreRadius = { value: this.coreRadius };
        shader.uniforms.haloColor = { value: this.haloColor };
        shader.uniforms.haloRadius = { value: this.haloRadius };
        shader.uniforms.pulseStrength = { value: this.pulseStrength };
        shader.uniforms.pulseFrequency = { value: this.pulseFrequency };
        shader.uniforms.energyStreakStrength = { value: this.energyStreakStrength };
        shader.uniforms.runeGlyphDensity = { value: this.runeGlyphDensity };
        shader.uniforms.runeGlyphStrength = { value: this.runeGlyphStrength };
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
                uniform int magicBands;
                uniform float magicQuantize;
                uniform float magicSoftness;
                uniform vec3 coreColor;
                uniform float coreIntensity;
                uniform float coreRadius;
                uniform vec3 haloColor;
                uniform float haloRadius;
                uniform float pulseStrength;
                uniform float pulseFrequency;
                uniform float energyStreakStrength;
                uniform float runeGlyphDensity;
                uniform float runeGlyphStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyMagicBands(vec3 baseColor) {
                    if (magicBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(magicBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * magicSoftness;
                    float finalLum = mix(lum, softQuantized, magicQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply magic cel banding
                gl_FragColor.rgb = applyMagicBands(gl_FragColor.rgb);

                // White-core + coloured-halo radial falloff
                {
                    vec2 centreUV = vUv - vec2(0.5);
                    float radialDist = length(centreUV) * 2.0;

                    float coreMask = max(0.0, 1.0 - radialDist / coreRadius);
                    coreMask = pow(coreMask, 1.5);
                    gl_FragColor.rgb += coreColor * coreMask * coreIntensity;

                    float haloInner = smoothstep(coreRadius * 0.8, coreRadius, radialDist);
                    float haloOuter = 1.0 - smoothstep(haloRadius * 0.7, haloRadius, radialDist);
                    float haloMask = haloInner * haloOuter;
                    gl_FragColor.rgb += haloColor * haloMask * 0.65;
                }

                // Pulsed energy rings
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

                // Hashed rune glyphs
                if (runeGlyphStrength > 0.0) {
                    vec2 glyphUV = vUv * 40.0;
                    vec2 glyphCell = floor(glyphUV);
                    float glyphHash = fract(sin(dot(glyphCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (glyphHash > (1.0 - runeGlyphDensity)) {
                        gl_FragColor.rgb += haloColor * glyphHash * runeGlyphStrength * 0.20;
                    }
                }

                // Bright rim glow on magic edges
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
            this.magicBands, this.magicQuantize, this.magicSoftness,
            this.coreIntensity, this.coreRadius,
            this.haloRadius, this.haloColor.r,
            this.pulseStrength, this.pulseFrequency, this.energyStreakStrength,
            this.runeGlyphDensity, this.runeGlyphStrength,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.magicBands = source.magicBands;
        this.magicQuantize = source.magicQuantize;
        this.magicSoftness = source.magicSoftness;
        this.coreColor.copy(source.coreColor);
        this.coreIntensity = source.coreIntensity;
        this.coreRadius = source.coreRadius;
        this.haloColor.copy(source.haloColor);
        this.haloRadius = source.haloRadius;
        this.pulseStrength = source.pulseStrength;
        this.pulseFrequency = source.pulseFrequency;
        this.energyStreakStrength = source.energyStreakStrength;
        this.runeGlyphDensity = source.runeGlyphDensity;
        this.runeGlyphStrength = source.runeGlyphStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'MagicSpellBaseMaterial';

        if (this.magicBands !== 4) data.magicBands = this.magicBands;
        if (this.magicQuantize !== 0.6) data.magicQuantize = this.magicQuantize;
        if (this.magicSoftness !== 0.03) data.magicSoftness = this.magicSoftness;
        if (this.coreColor.getHex() !== new Color(1.0, 0.98, 1.0).getHex()) data.coreColor = this.coreColor.getHex();
        if (this.coreIntensity !== 15.0) data.coreIntensity = this.coreIntensity;
        if (this.coreRadius !== 0.22) data.coreRadius = this.coreRadius;
        if (this.haloColor.getHex() !== new Color(0.72, 0.22, 1.0).getHex()) data.haloColor = this.haloColor.getHex();
        if (this.haloRadius !== 0.62) data.haloRadius = this.haloRadius;
        if (this.pulseStrength !== 0.35) data.pulseStrength = this.pulseStrength;
        if (this.pulseFrequency !== 4.0) data.pulseFrequency = this.pulseFrequency;
        if (this.energyStreakStrength !== 0.25) data.energyStreakStrength = this.energyStreakStrength;
        if (this.runeGlyphDensity !== 0.15) data.runeGlyphDensity = this.runeGlyphDensity;
        if (this.runeGlyphStrength !== 0.30) data.runeGlyphStrength = this.runeGlyphStrength;
        if (this.rimGlow !== 0.22) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.72, 0.22, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.magicBands = json.magicBands ?? this.magicBands;
        this.magicQuantize = json.magicQuantize ?? this.magicQuantize;
        this.magicSoftness = json.magicSoftness ?? this.magicSoftness;
        if (json.coreColor !== undefined) this.coreColor.setHex(json.coreColor);
        this.coreIntensity = json.coreIntensity ?? this.coreIntensity;
        this.coreRadius = json.coreRadius ?? this.coreRadius;
        if (json.haloColor !== undefined) this.haloColor.setHex(json.haloColor);
        this.haloRadius = json.haloRadius ?? this.haloRadius;
        this.pulseStrength = json.pulseStrength ?? this.pulseStrength;
        this.pulseFrequency = json.pulseFrequency ?? this.pulseFrequency;
        this.energyStreakStrength = json.energyStreakStrength ?? this.energyStreakStrength;
        this.runeGlyphDensity = json.runeGlyphDensity ?? this.runeGlyphDensity;
        this.runeGlyphStrength = json.runeGlyphStrength ?? this.runeGlyphStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const MagicSpellBaseMaterialBatchComponent = {
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
    runeGlyphDensity: 'f64',
    runeGlyphStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    MagicSpellBaseMaterial,
    MagicSpellBaseMaterialBatch,
    MagicSpellBaseScratchPool,
    MagicSpellBaseMaterialBatchComponent,
    MagicSpellBasePresets,
    applyMagicCelBanding,
    gradeMagicColor,
    generateMagicRuneTexture
};

export default MagicSpellBaseMaterial;