// file number : 257
// full path name : src/materials/257_laserbeamtrailmaterial.js
// description : LaserBeamTrailMaterial — a ready-to-use laser trail material
//               for trailing laser beams, magic comet trails, projectile
//               streaks, and motion paths with a white-hot core. Extends
//               LaserWhiteCoreBaseMaterial with trail-specific features: a
//               UV-based beam-length taper (head-to-tail power fade), a
//               fade-out-over-time parameter (for projectiles that dim as they
//               travel), a motion-blur streak approximation for the classic
//               "comet" look, and distance-based intensity attenuation (for
//               long trails that span hundreds of metres). Adds real-time
//               anime stylization: cel-banded trail highlights, white-core
//               radial falloff, head-spark brightening, mood tinting, rim glow,
//               and per-instance variation. Includes a procedural beam-trail
//               noise texture generator using directional fBm with
//               head-biased turbulence and tail-dissolve mottle.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Laser trails, comet tails, projectile streaks, magic trails,
//            sci-fi bullet traces, firework streaks, energy tethers, anime
//            magic comet attacks, and any white-cored trail beam that needs
//            real-time PBR + anime stylization.
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
// Trail presets — physically grounded parameter sets for the three classic
// trail families: comet, streak, and magic.
// ---------------------------------------------------------------------------

const LaserBeamTrailPresets = {
    'comet-red': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 18.0,
        coreRadius: 0.20,
        haloColor: [1.0, 0.15, 0.08],
        haloRadius: 0.55,
        beamColor: [0.60, 0.04, 0.03],
        opacity: 0.90,
        pulseStrength: 0.30,
        pulseFrequency: 5.0,
        energyStreakStrength: 0.25,
        trailTaperPower: 1.8,
        headSparkIntensity: 0.85,
        motionBlurStrength: 0.35,
        distanceAttenuation: 0.02,
        trailDissolveStrength: 0.30
    },
    'comet-blue': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 18.0,
        coreRadius: 0.20,
        haloColor: [0.10, 0.45, 1.0],
        haloRadius: 0.55,
        beamColor: [0.04, 0.18, 0.60],
        opacity: 0.90,
        pulseStrength: 0.30,
        pulseFrequency: 5.0,
        energyStreakStrength: 0.25,
        trailTaperPower: 1.8,
        headSparkIntensity: 0.85,
        motionBlurStrength: 0.35,
        distanceAttenuation: 0.02,
        trailDissolveStrength: 0.30
    },
    'streak-cyan': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 22.0,
        coreRadius: 0.14,
        haloColor: [0.10, 0.92, 1.0],
        haloRadius: 0.42,
        beamColor: [0.04, 0.52, 0.62],
        opacity: 0.85,
        pulseStrength: 0.20,
        pulseFrequency: 3.0,
        energyStreakStrength: 0.35,
        trailTaperPower: 2.4,
        headSparkIntensity: 1.10,
        motionBlurStrength: 0.55,
        distanceAttenuation: 0.03,
        trailDissolveStrength: 0.40
    },
    'streak-magenta': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 22.0,
        coreRadius: 0.14,
        haloColor: [1.0, 0.20, 0.80],
        haloRadius: 0.42,
        beamColor: [0.62, 0.05, 0.45],
        opacity: 0.85,
        pulseStrength: 0.20,
        pulseFrequency: 3.0,
        energyStreakStrength: 0.35,
        trailTaperPower: 2.4,
        headSparkIntensity: 1.10,
        motionBlurStrength: 0.55,
        distanceAttenuation: 0.03,
        trailDissolveStrength: 0.40
    },
    'magic-trail': {
        coreColor: [1.0, 0.98, 1.0],
        coreIntensity: 26.0,
        coreRadius: 0.26,
        haloColor: [0.92, 0.55, 1.0],
        haloRadius: 0.68,
        beamColor: [0.55, 0.28, 0.72],
        opacity: 0.95,
        pulseStrength: 0.45,
        pulseFrequency: 8.0,
        energyStreakStrength: 0.30,
        trailTaperPower: 1.4,
        headSparkIntensity: 0.95,
        motionBlurStrength: 0.30,
        distanceAttenuation: 0.015,
        trailDissolveStrength: 0.55
    },
    'anime-comet': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 34.0,
        coreRadius: 0.30,
        haloColor: [1.0, 0.65, 0.92],
        haloRadius: 0.72,
        beamColor: [0.72, 0.42, 0.68],
        opacity: 0.98,
        pulseStrength: 0.55,
        pulseFrequency: 10.0,
        energyStreakStrength: 0.40,
        trailTaperPower: 1.2,
        headSparkIntensity: 1.30,
        motionBlurStrength: 0.45,
        distanceAttenuation: 0.01,
        trailDissolveStrength: 0.50
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable trail scratch records
// ---------------------------------------------------------------------------

class LaserBeamTrailScratchPool {
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

const _laserBeamTrailScratchPool = new LaserBeamTrailScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — trail-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded trail highlights.
 */
function applyTrailCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.03) {
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
 * Mood tinting for trail halo.
 */
function gradeTrailColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate a beam-trail noise texture: head-biased turbulence + tail dissolve.
 */
function generateBeamTrailNoiseTexture(width, height, scale = 0.02, octaves = 4, headBiasStrength = 0.45, tailDissolveStrength = 0.30, streakStrength = 0.20) {
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
            const streak = SimplexNoise.noise2D(x * 0.20, y * 0.005) * 0.5 + 0.5;
            const streakMask = Math.pow(1.0 - Math.abs(streak * 2.0 - 1.0), 3.0) * streakStrength;
            // Head bias: brighter near the top of the trail (v = 1)
            const headBias = Math.pow(y / height, 1.4) * headBiasStrength;
            // Tail dissolve: extra noise near the bottom of the trail (v = 0)
            const tailNoise = SimplexNoise.noise2D(x * 0.15, y * 0.15) * 0.5 + 0.5;
            const tailDissolve = (1.0 - y / height) * tailNoise * tailDissolveStrength;
            let value = 0.45 + (fbm - 0.5) * 0.15 + streakMask * 0.20 + headBias * 0.15 - tailDissolve * 0.25;
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

const _laserBeamTrailWorld = BitECS.createWorld();
const LaserBeamTrailMaterialComponent = BitECS.defineComponent({
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
    trailTaperPower: 'f64',
    headSparkIntensity: 'f64',
    motionBlurStrength: 'f64',
    distanceAttenuation: 'f64',
    trailDissolveStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class LaserBeamTrailMaterialBatch {
    constructor() {
        this.world = _laserBeamTrailWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, LaserBeamTrailMaterialComponent, eid);
        LaserBeamTrailMaterialComponent.materialPtr[eid] = this.materials.length;
        LaserBeamTrailMaterialComponent.laserBands[eid] = material.laserBands;
        LaserBeamTrailMaterialComponent.laserQuantize[eid] = material.laserQuantize;
        LaserBeamTrailMaterialComponent.laserSoftness[eid] = material.laserSoftness;
        LaserBeamTrailMaterialComponent.coreIntensity[eid] = material.coreIntensity;
        LaserBeamTrailMaterialComponent.coreRadius[eid] = material.coreRadius;
        LaserBeamTrailMaterialComponent.haloRadius[eid] = material.haloRadius;
        LaserBeamTrailMaterialComponent.haloColorR[eid] = material.haloColor.r;
        LaserBeamTrailMaterialComponent.haloColorG[eid] = material.haloColor.g;
        LaserBeamTrailMaterialComponent.haloColorB[eid] = material.haloColor.b;
        LaserBeamTrailMaterialComponent.pulseStrength[eid] = material.pulseStrength;
        LaserBeamTrailMaterialComponent.pulseFrequency[eid] = material.pulseFrequency;
        LaserBeamTrailMaterialComponent.energyStreakStrength[eid] = material.energyStreakStrength;
        LaserBeamTrailMaterialComponent.trailTaperPower[eid] = material.trailTaperPower;
        LaserBeamTrailMaterialComponent.headSparkIntensity[eid] = material.headSparkIntensity;
        LaserBeamTrailMaterialComponent.motionBlurStrength[eid] = material.motionBlurStrength;
        LaserBeamTrailMaterialComponent.distanceAttenuation[eid] = material.distanceAttenuation;
        LaserBeamTrailMaterialComponent.trailDissolveStrength[eid] = material.trailDissolveStrength;
        LaserBeamTrailMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        LaserBeamTrailMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        LaserBeamTrailMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        LaserBeamTrailMaterialComponent.moodContrast[eid] = material.moodContrast;
        LaserBeamTrailMaterialComponent.rimGlow[eid] = material.rimGlow;
        LaserBeamTrailMaterialComponent.variationSeed[eid] = material.variationSeed;
        LaserBeamTrailMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[LaserBeamTrailMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            material.laserBands = LaserBeamTrailMaterialComponent.laserBands[eid];
            material.laserQuantize = LaserBeamTrailMaterialComponent.laserQuantize[eid];
            material.laserSoftness = LaserBeamTrailMaterialComponent.laserSoftness[eid];
            material.coreIntensity = LaserBeamTrailMaterialComponent.coreIntensity[eid];
            material.coreRadius = LaserBeamTrailMaterialComponent.coreRadius[eid];
            material.haloRadius = LaserBeamTrailMaterialComponent.haloRadius[eid];
            material.haloColor.setRGB(
                LaserBeamTrailMaterialComponent.haloColorR[eid],
                LaserBeamTrailMaterialComponent.haloColorG[eid],
                LaserBeamTrailMaterialComponent.haloColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.pulseStrength = LaserBeamTrailMaterialComponent.pulseStrength[eid];
            material.pulseFrequency = LaserBeamTrailMaterialComponent.pulseFrequency[eid];
            material.energyStreakStrength = LaserBeamTrailMaterialComponent.energyStreakStrength[eid];
            material.trailTaperPower = LaserBeamTrailMaterialComponent.trailTaperPower[eid];
            material.headSparkIntensity = LaserBeamTrailMaterialComponent.headSparkIntensity[eid];
            material.motionBlurStrength = LaserBeamTrailMaterialComponent.motionBlurStrength[eid];
            material.distanceAttenuation = LaserBeamTrailMaterialComponent.distanceAttenuation[eid];
            material.trailDissolveStrength = LaserBeamTrailMaterialComponent.trailDissolveStrength[eid];
            material.moodTemperature = LaserBeamTrailMaterialComponent.moodTemperature[eid];
            material.moodSaturation = LaserBeamTrailMaterialComponent.moodSaturation[eid];
            material.moodBrightness = LaserBeamTrailMaterialComponent.moodBrightness[eid];
            material.moodContrast = LaserBeamTrailMaterialComponent.moodContrast[eid];
            material.rimGlow = LaserBeamTrailMaterialComponent.rimGlow[eid];
            material.variationSeed = LaserBeamTrailMaterialComponent.variationSeed[eid];
            LaserBeamTrailMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main LaserBeamTrailMaterial class
// ---------------------------------------------------------------------------

class LaserBeamTrailMaterial extends LaserWhiteCoreBaseMaterial {
    static {
        _laserBeamTrailScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isLaserBeamTrailMaterial = true;
        this.type = 'LaserBeamTrailMaterial';

        this.laserBands = 4;
        this.laserQuantize = 0.6;
        this.laserSoftness = 0.03;
        this.coreIntensity = 18.0;
        this.coreRadius = 0.20;
        this.haloRadius = 0.55;
        this.pulseStrength = 0.30;
        this.pulseFrequency = 5.0;
        this.energyStreakStrength = 0.25;

        // Trail-specific controls
        this.trailTaperPower = 1.8;
        this.headSparkIntensity = 0.85;
        this.motionBlurStrength = 0.35;
        this.distanceAttenuation = 0.02;
        this.trailDissolveStrength = 0.30;

        this.transparent = true;
        this.opacity = 0.90;
        this.depthWrite = false;
        this.blending = Constants.ADDITIVE_BLENDING ?? 2;
        this.side = Constants.DOUBLE_SIDE ?? 2;

        this.renderStyleBlend = 0.65;
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    applyTrailBanding(baseColor, output) {
        return applyTrailCelBanding(baseColor, output, this.laserBands, this.laserQuantize, this.laserSoftness);
    }

    updateMoodColor() {
        gradeTrailColor(this.haloColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        this.rimGlowColor.copy(this.haloColor);
        return this;
    }

    applyPreset(presetName) {
        const preset = LaserBeamTrailPresets[presetName];
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
        this.trailTaperPower = preset.trailTaperPower;
        this.headSparkIntensity = preset.headSparkIntensity;
        this.motionBlurStrength = preset.motionBlurStrength;
        this.distanceAttenuation = preset.distanceAttenuation;
        this.trailDissolveStrength = preset.trailDissolveStrength;

        if (presetName === 'anime-comet') {
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

    generateBeamTrailNoiseTexture(width, height, scale = 0.02, octaves = 4, headBiasStrength = 0.45, tailDissolveStrength = 0.30, streakStrength = 0.20) {
        return generateBeamTrailNoiseTexture(width, height, scale, octaves, headBiasStrength, tailDissolveStrength, streakStrength);
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

        shader.uniforms.trailTaperPower = { value: this.trailTaperPower };
        shader.uniforms.headSparkIntensity = { value: this.headSparkIntensity };
        shader.uniforms.motionBlurStrength = { value: this.motionBlurStrength };
        shader.uniforms.distanceAttenuation = { value: this.distanceAttenuation };
        shader.uniforms.trailDissolveStrength = { value: this.trailDissolveStrength };

        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float variationOffset;',
                `uniform float variationOffset;
                uniform float trailTaperPower;
                uniform float headSparkIntensity;
                uniform float motionBlurStrength;
                uniform float distanceAttenuation;
                uniform float trailDissolveStrength;
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // UV-based trail taper: head bright, tail dissolving.
                // Convention: v = 1 is the head of the trail, v = 0 is the tail.
                {
                    float taper = pow(vUv.y, trailTaperPower);
                    gl_FragColor.a *= mix(0.05, 1.0, taper);
                }

                // Head spark: bright flash at the leading edge of the trail
                if (headSparkIntensity > 0.0) {
                    float headMask = smoothstep(0.85, 1.0, vUv.y);
                    float headSpark = pow(headMask, 3.0) * headSparkIntensity;
                    gl_FragColor.rgb += coreColor * headSpark * 1.5;
                }

                // Motion-blur streak: high-frequency directional noise along the trail axis
                if (motionBlurStrength > 0.0) {
                    float streak = sin(vUv.y * 60.0 + variationOffset) * 0.5 + 0.5;
                    float streakMask = pow(streak, 6.0) * motionBlurStrength;
                    gl_FragColor.rgb += haloColor * streakMask * 0.20;
                }

                // Distance-based intensity attenuation (view-space depth)
                if (distanceAttenuation > 0.0) {
                    float depth = length(vViewPosition);
                    float atten = 1.0 / (1.0 + depth * distanceAttenuation);
                    gl_FragColor.rgb *= atten;
                    gl_FragColor.a *= atten;
                }

                // Tail dissolve: extra noise near the bottom of the trail
                if (trailDissolveStrength > 0.0) {
                    float tailNoise = sin(vUv.x * 25.0 + variationOffset) * cos(vUv.y * 40.0 + variationOffset);
                    tailNoise = tailNoise * 0.5 + 0.5;
                    float dissolve = smoothstep(1.0, 0.0, vUv.y) * tailNoise * trailDissolveStrength;
                    gl_FragColor.a *= (1.0 - dissolve);
                }
                `
            );
    }

    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.trailTaperPower, this.headSparkIntensity,
            this.motionBlurStrength, this.distanceAttenuation,
            this.trailDissolveStrength
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.trailTaperPower = source.trailTaperPower;
        this.headSparkIntensity = source.headSparkIntensity;
        this.motionBlurStrength = source.motionBlurStrength;
        this.distanceAttenuation = source.distanceAttenuation;
        this.trailDissolveStrength = source.trailDissolveStrength;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'LaserBeamTrailMaterial';
        if (this.trailTaperPower !== 1.8) data.trailTaperPower = this.trailTaperPower;
        if (this.headSparkIntensity !== 0.85) data.headSparkIntensity = this.headSparkIntensity;
        if (this.motionBlurStrength !== 0.35) data.motionBlurStrength = this.motionBlurStrength;
        if (this.distanceAttenuation !== 0.02) data.distanceAttenuation = this.distanceAttenuation;
        if (this.trailDissolveStrength !== 0.30) data.trailDissolveStrength = this.trailDissolveStrength;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.trailTaperPower = json.trailTaperPower ?? this.trailTaperPower;
        this.headSparkIntensity = json.headSparkIntensity ?? this.headSparkIntensity;
        this.motionBlurStrength = json.motionBlurStrength ?? this.motionBlurStrength;
        this.distanceAttenuation = json.distanceAttenuation ?? this.distanceAttenuation;
        this.trailDissolveStrength = json.trailDissolveStrength ?? this.trailDissolveStrength;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const LaserBeamTrailMaterialBatchComponent = {
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
    trailTaperPower: 'f64',
    headSparkIntensity: 'f64',
    motionBlurStrength: 'f64',
    distanceAttenuation: 'f64',
    trailDissolveStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    LaserBeamTrailMaterial,
    LaserBeamTrailMaterialBatch,
    LaserBeamTrailScratchPool,
    LaserBeamTrailMaterialBatchComponent,
    LaserBeamTrailPresets,
    applyTrailCelBanding,
    gradeTrailColor,
    generateBeamTrailNoiseTexture
};

export default LaserBeamTrailMaterial;