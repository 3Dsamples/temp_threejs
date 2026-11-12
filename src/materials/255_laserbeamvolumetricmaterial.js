// file number : 255
// full path name : src/materials/255_laserbeamvolumetricmaterial.js
// description : LaserBeamVolumetricMaterial — a ready-to-use volumetric laser
//               beam material with a white-hot core, for real-time rendering of
//               volumetric laser beams (Half-Life-style). Extends
//               LaserWhiteCoreBaseMaterial with volumetric-beam-specific
//               features: cylindrical billboarding (camera-facing beam body),
//               atmosphere dust/smoke noise injection, camera-fade for edge-on
//               views (softens the beam when looking down its axis), and a
//               beam-length power-fade for the classic tapering volumetric
//               beam. Adds real-time anime stylization: cel-banded beam
//               highlights, white-core radial falloff, animated energy pulse,
//               mood tinting, rim glow, and per-instance variation. Includes a
//               procedural volumetric-beam-dust texture generator using
//               multi-octave fBm with directional energy streaks and
//               density-based atmosphere haze.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Volumetric laser beams, atmospheric energy beams, sci-fi weapon
//            fire, magic ray spells, glowing light sabers, energy ropes,
//            tether beams, anime magic beams, and any white-cored volumetric
//            beam that needs real-time PBR + anime stylization.
// license : MIT

import { LaserWhiteCoreBaseMaterial } from './254_laserwhitecorebasematerial.js';
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
// Volumetric laser beam presets — physically grounded parameter sets.
// ---------------------------------------------------------------------------

const LaserBeamVolumetricPresets = {
    'hl-style-red': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 16.0,
        coreRadius: 0.15,
        haloColor: [1.0, 0.12, 0.08],
        haloRadius: 0.42,
        beamColor: [0.55, 0.04, 0.03],
        opacity: 0.75,
        pulseStrength: 0.30,
        pulseFrequency: 4.0,
        energyStreakStrength: 0.22,
        dustDensity: 0.35,
        dustHaze: 0.55,
        cameraFadeStrength: 0.85,
        beamLengthFade: 1.6
    },
    'hl-style-blue': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 16.0,
        coreRadius: 0.15,
        haloColor: [0.12, 0.45, 1.0],
        haloRadius: 0.42,
        beamColor: [0.04, 0.16, 0.55],
        opacity: 0.75,
        pulseStrength: 0.30,
        pulseFrequency: 4.0,
        energyStreakStrength: 0.22,
        dustDensity: 0.35,
        dustHaze: 0.55,
        cameraFadeStrength: 0.85,
        beamLengthFade: 1.6
    },
    'atmospheric-energy': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 20.0,
        coreRadius: 0.10,
        haloColor: [0.55, 0.85, 1.0],
        haloRadius: 0.55,
        beamColor: [0.20, 0.55, 0.75],
        opacity: 0.55,
        pulseStrength: 0.20,
        pulseFrequency: 2.0,
        energyStreakStrength: 0.30,
        dustDensity: 0.55,
        dustHaze: 0.75,
        cameraFadeStrength: 0.95,
        beamLengthFade: 2.5
    },
    'magic-ray': {
        coreColor: [1.0, 0.98, 1.0],
        coreIntensity: 22.0,
        coreRadius: 0.20,
        haloColor: [0.95, 0.55, 1.0],
        haloRadius: 0.60,
        beamColor: [0.55, 0.25, 0.75],
        opacity: 0.85,
        pulseStrength: 0.45,
        pulseFrequency: 6.0,
        energyStreakStrength: 0.35,
        dustDensity: 0.45,
        dustHaze: 0.65,
        cameraFadeStrength: 0.75,
        beamLengthFade: 1.4
    },
    'anime-volumetric': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 28.0,
        coreRadius: 0.24,
        haloColor: [1.0, 0.60, 0.90],
        haloRadius: 0.65,
        beamColor: [0.70, 0.35, 0.65],
        opacity: 0.95,
        pulseStrength: 0.55,
        pulseFrequency: 8.0,
        energyStreakStrength: 0.42,
        dustDensity: 0.40,
        dustHaze: 0.70,
        cameraFadeStrength: 0.65,
        beamLengthFade: 1.2
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable volumetric-beam scratch records
// ---------------------------------------------------------------------------

class LaserBeamVolumetricScratchPool {
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

const _laserBeamVolumetricScratchPool = new LaserBeamVolumetricScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — volumetric-beam-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded volumetric beam highlights.
 */
function applyVolumetricLaserCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.03) {
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
 * Mood tinting for volumetric beam halo.
 */
function gradeVolumetricLaserColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate volumetric-beam dust texture using fBm and directional streaks.
 */
function generateVolumetricBeamDustTexture(width, height, scale = 0.02, octaves = 4, dustDensity = 0.35, dustHaze = 0.55, streakStrength = 0.20) {
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
            const streak = SimplexNoise.noise2D(x * 0.18, y * 0.005) * 0.5 + 0.5;
            const streakMask = Math.pow(1.0 - Math.abs(streak * 2.0 - 1.0), 3.0) * streakStrength;
            const haze = fbm * dustHaze;
            let value = 0.45 + haze * dustDensity + streakMask * 0.15;
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

const _laserBeamVolumetricWorld = BitECS.createWorld();
const LaserBeamVolumetricMaterialComponent = BitECS.defineComponent({
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
    dustDensity: 'f64',
    dustHaze: 'f64',
    cameraFadeStrength: 'f64',
    beamLengthFade: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class LaserBeamVolumetricMaterialBatch {
    constructor() {
        this.world = _laserBeamVolumetricWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, LaserBeamVolumetricMaterialComponent, eid);
        LaserBeamVolumetricMaterialComponent.materialPtr[eid] = this.materials.length;
        LaserBeamVolumetricMaterialComponent.laserBands[eid] = material.laserBands;
        LaserBeamVolumetricMaterialComponent.laserQuantize[eid] = material.laserQuantize;
        LaserBeamVolumetricMaterialComponent.laserSoftness[eid] = material.laserSoftness;
        LaserBeamVolumetricMaterialComponent.coreIntensity[eid] = material.coreIntensity;
        LaserBeamVolumetricMaterialComponent.coreRadius[eid] = material.coreRadius;
        LaserBeamVolumetricMaterialComponent.haloRadius[eid] = material.haloRadius;
        LaserBeamVolumetricMaterialComponent.haloColorR[eid] = material.haloColor.r;
        LaserBeamVolumetricMaterialComponent.haloColorG[eid] = material.haloColor.g;
        LaserBeamVolumetricMaterialComponent.haloColorB[eid] = material.haloColor.b;
        LaserBeamVolumetricMaterialComponent.pulseStrength[eid] = material.pulseStrength;
        LaserBeamVolumetricMaterialComponent.pulseFrequency[eid] = material.pulseFrequency;
        LaserBeamVolumetricMaterialComponent.energyStreakStrength[eid] = material.energyStreakStrength;
        LaserBeamVolumetricMaterialComponent.dustDensity[eid] = material.dustDensity;
        LaserBeamVolumetricMaterialComponent.dustHaze[eid] = material.dustHaze;
        LaserBeamVolumetricMaterialComponent.cameraFadeStrength[eid] = material.cameraFadeStrength;
        LaserBeamVolumetricMaterialComponent.beamLengthFade[eid] = material.beamLengthFade;
        LaserBeamVolumetricMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        LaserBeamVolumetricMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        LaserBeamVolumetricMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        LaserBeamVolumetricMaterialComponent.moodContrast[eid] = material.moodContrast;
        LaserBeamVolumetricMaterialComponent.rimGlow[eid] = material.rimGlow;
        LaserBeamVolumetricMaterialComponent.variationSeed[eid] = material.variationSeed;
        LaserBeamVolumetricMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[LaserBeamVolumetricMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            material.laserBands = LaserBeamVolumetricMaterialComponent.laserBands[eid];
            material.laserQuantize = LaserBeamVolumetricMaterialComponent.laserQuantize[eid];
            material.laserSoftness = LaserBeamVolumetricMaterialComponent.laserSoftness[eid];
            material.coreIntensity = LaserBeamVolumetricMaterialComponent.coreIntensity[eid];
            material.coreRadius = LaserBeamVolumetricMaterialComponent.coreRadius[eid];
            material.haloRadius = LaserBeamVolumetricMaterialComponent.haloRadius[eid];
            material.haloColor.setRGB(
                LaserBeamVolumetricMaterialComponent.haloColorR[eid],
                LaserBeamVolumetricMaterialComponent.haloColorG[eid],
                LaserBeamVolumetricMaterialComponent.haloColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.pulseStrength = LaserBeamVolumetricMaterialComponent.pulseStrength[eid];
            material.pulseFrequency = LaserBeamVolumetricMaterialComponent.pulseFrequency[eid];
            material.energyStreakStrength = LaserBeamVolumetricMaterialComponent.energyStreakStrength[eid];
            material.dustDensity = LaserBeamVolumetricMaterialComponent.dustDensity[eid];
            material.dustHaze = LaserBeamVolumetricMaterialComponent.dustHaze[eid];
            material.cameraFadeStrength = LaserBeamVolumetricMaterialComponent.cameraFadeStrength[eid];
            material.beamLengthFade = LaserBeamVolumetricMaterialComponent.beamLengthFade[eid];
            material.moodTemperature = LaserBeamVolumetricMaterialComponent.moodTemperature[eid];
            material.moodSaturation = LaserBeamVolumetricMaterialComponent.moodSaturation[eid];
            material.moodBrightness = LaserBeamVolumetricMaterialComponent.moodBrightness[eid];
            material.moodContrast = LaserBeamVolumetricMaterialComponent.moodContrast[eid];
            material.rimGlow = LaserBeamVolumetricMaterialComponent.rimGlow[eid];
            material.variationSeed = LaserBeamVolumetricMaterialComponent.variationSeed[eid];
            LaserBeamVolumetricMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main LaserBeamVolumetricMaterial class
// ---------------------------------------------------------------------------

class LaserBeamVolumetricMaterial extends LaserWhiteCoreBaseMaterial {
    static {
        _laserBeamVolumetricScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isLaserBeamVolumetricMaterial = true;
        this.type = 'LaserBeamVolumetricMaterial';

        this.laserBands = 4;
        this.laserQuantize = 0.6;
        this.laserSoftness = 0.03;
        this.coreIntensity = 16.0;
        this.coreRadius = 0.15;
        this.haloRadius = 0.42;
        this.pulseStrength = 0.30;
        this.pulseFrequency = 4.0;
        this.energyStreakStrength = 0.22;

        this.dustDensity = 0.35;
        this.dustHaze = 0.55;
        this.cameraFadeStrength = 0.85;
        this.beamLengthFade = 1.6;

        this.transparent = true;
        this.opacity = 0.75;
        this.depthWrite = false;

        this.renderStyleBlend = 0.60;
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    applyVolumetricBanding(baseColor, output) {
        return applyVolumetricLaserCelBanding(baseColor, output, this.laserBands, this.laserQuantize, this.laserSoftness);
    }

    updateMoodColor() {
        gradeVolumetricLaserColor(this.haloColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        this.rimGlowColor.copy(this.haloColor);
        return this;
    }

    applyPreset(presetName) {
        const preset = LaserBeamVolumetricPresets[presetName];
        if (!preset) return this;

        this.coreColor.setRGB(preset.coreColor[0], preset.coreColor[1], preset.coreColor[2], ColorManagement.workingColorSpace);
        this.coreIntensity = preset.coreIntensity;
        this.coreRadius = preset.coreRadius;
        this.haloColor.setRGB(preset.haloColor[0], preset.haloColor[1], preset.haloColor[2], ColorManagement.workingColorSpace);
        this.haloRadius = preset.haloRadius;
        this.color.setRGB(preset.beamColor[0], preset.beamColor[1], preset.beamColor[2], ColorManagement.workingColorSpace);
        this.opacity = preset.opacity;
        this.pulseStrength = preset.pulseStrength;
        this.pulseFrequency = preset.pulseFrequency;
        this.energyStreakStrength = preset.energyStreakStrength;
        this.dustDensity = preset.dustDensity;
        this.dustHaze = preset.dustHaze;
        this.cameraFadeStrength = preset.cameraFadeStrength;
        this.beamLengthFade = preset.beamLengthFade;

        if (presetName === 'anime-volumetric') {
            this.laserSoftness = 0.02;
            this.laserBands = 5;
            this.rimGlow = 0.35;
        } else {
            this.laserSoftness = 0.03;
            this.laserBands = 4;
            this.rimGlow = 0.25;
        }

        this.updateMoodColor();
        return this;
    }

    generateVolumetricBeamDustTexture(width, height, scale = 0.02, octaves = 4, dustDensity = 0.35, dustHaze = 0.55, streakStrength = 0.20) {
        return generateVolumetricBeamDustTexture(width, height, scale, octaves, dustDensity, dustHaze, streakStrength);
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

        shader.uniforms.dustDensity = { value: this.dustDensity };
        shader.uniforms.dustHaze = { value: this.dustHaze };
        shader.uniforms.cameraFadeStrength = { value: this.cameraFadeStrength };
        shader.uniforms.beamLengthFade = { value: this.beamLengthFade };

        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float variationOffset;',
                `uniform float variationOffset;
                uniform float dustDensity;
                uniform float dustHaze;
                uniform float cameraFadeStrength;
                uniform float beamLengthFade;
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Volumetric dust haze
                if (dustDensity > 0.0) {
                    float dust = sin(vUv.x * 25.0 + variationOffset) * cos(vUv.y * 8.0 + variationOffset);
                    dust = dust * 0.5 + 0.5;
                    gl_FragColor.rgb += haloColor * dust * dustDensity * dustHaze * 0.15;
                }

                // Beam-length power fade (tapering)
                if (beamLengthFade > 0.0) {
                    float lengthFade = pow(1.0 - vUv.y, beamLengthFade);
                    gl_FragColor.a *= mix(1.0, lengthFade, 0.8);
                }

                // Camera-fade: dim the beam when looking nearly edge-on (down the axis)
                if (cameraFadeStrength > 0.0) {
                    vec3 beamAxisVS = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
                    vec3 viewDirVS = normalize(-vViewPosition);
                    float axisDot = abs(dot(beamAxisVS, viewDirVS));
                    float edgeOnFade = mix(1.0, 1.0 - axisDot * axisDot, cameraFadeStrength);
                    gl_FragColor.a *= edgeOnFade;
                }
                `
            );
    }

    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.dustDensity, this.dustHaze,
            this.cameraFadeStrength, this.beamLengthFade
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.dustDensity = source.dustDensity;
        this.dustHaze = source.dustHaze;
        this.cameraFadeStrength = source.cameraFadeStrength;
        this.beamLengthFade = source.beamLengthFade;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'LaserBeamVolumetricMaterial';
        if (this.dustDensity !== 0.35) data.dustDensity = this.dustDensity;
        if (this.dustHaze !== 0.55) data.dustHaze = this.dustHaze;
        if (this.cameraFadeStrength !== 0.85) data.cameraFadeStrength = this.cameraFadeStrength;
        if (this.beamLengthFade !== 1.6) data.beamLengthFade = this.beamLengthFade;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.dustDensity = json.dustDensity ?? this.dustDensity;
        this.dustHaze = json.dustHaze ?? this.dustHaze;
        this.cameraFadeStrength = json.cameraFadeStrength ?? this.cameraFadeStrength;
        this.beamLengthFade = json.beamLengthFade ?? this.beamLengthFade;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const LaserBeamVolumetricMaterialBatchComponent = {
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
    dustDensity: 'f64',
    dustHaze: 'f64',
    cameraFadeStrength: 'f64',
    beamLengthFade: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    LaserBeamVolumetricMaterial,
    LaserBeamVolumetricMaterialBatch,
    LaserBeamVolumetricScratchPool,
    LaserBeamVolumetricMaterialBatchComponent,
    LaserBeamVolumetricPresets,
    applyVolumetricLaserCelBanding,
    gradeVolumetricLaserColor,
    generateVolumetricBeamDustTexture
};

export default LaserBeamVolumetricMaterial;