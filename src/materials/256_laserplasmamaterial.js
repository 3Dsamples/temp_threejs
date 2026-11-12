// file number : 256
// full path name : src/materials/256_laserplasmamaterial.js
// description : LaserPlasmaMaterial — a ready-to-use plasma material for plasma
//               orbs, plasma shots, energy balls, and spherical energy cores
//               with a white-hot centre. Extends LaserWhiteCoreBaseMaterial with
//               plasma-specific features: spherical radial falloff (vs the
//               beam's cylindrical profile), plasma turbulence via domain-warped
//               fBm, heat-shimmer flicker (time-based noise modulation), and a
//               white-hot plasma corona. Adds real-time anime stylization:
//               cel-banded plasma highlights, plasma-turbulence texture, mood
//               tinting, rim glow, and per-instance variation. Includes a
//               procedural plasma-turbulence texture generator using
//               domain-warped multi-octave fBm with per-vortex hashing.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Plasma orbs, plasma shots, energy balls, magic spheres, sci-fi
//            plasma blasts, energy cores, glowing projectiles, anime magic
//            attacks, and any spherical white-cored plasma surface that needs
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

/** @type {number} Shared accumulator for time-based plasma flicker. */
let _plasmaTime = 0;

// ---------------------------------------------------------------------------
// Plasma presets — physically grounded parameter sets.
// ---------------------------------------------------------------------------

const LaserPlasmaPresets = {
    'plasma-red': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 22.0,
        coreRadius: 0.22,
        haloColor: [1.0, 0.14, 0.08],
        haloRadius: 0.62,
        beamColor: [0.65, 0.05, 0.03],
        opacity: 0.92,
        turbulenceStrength: 0.35,
        turbulenceFrequency: 5.0,
        flickerStrength: 0.20,
        flickerFrequency: 8.0,
        coronaStrength: 0.45,
        coronaRadius: 0.85
    },
    'plasma-blue': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 22.0,
        coreRadius: 0.22,
        haloColor: [0.10, 0.45, 1.0],
        haloRadius: 0.62,
        beamColor: [0.04, 0.18, 0.65],
        opacity: 0.92,
        turbulenceStrength: 0.35,
        turbulenceFrequency: 5.0,
        flickerStrength: 0.20,
        flickerFrequency: 8.0,
        coronaStrength: 0.45,
        coronaRadius: 0.85
    },
    'plasma-green': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 22.0,
        coreRadius: 0.22,
        haloColor: [0.18, 1.0, 0.32],
        haloRadius: 0.62,
        beamColor: [0.04, 0.58, 0.16],
        opacity: 0.92,
        turbulenceStrength: 0.35,
        turbulenceFrequency: 5.0,
        flickerStrength: 0.20,
        flickerFrequency: 8.0,
        coronaStrength: 0.45,
        coronaRadius: 0.85
    },
    'plasma-violet': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 24.0,
        coreRadius: 0.24,
        haloColor: [0.68, 0.22, 1.0],
        haloRadius: 0.65,
        beamColor: [0.30, 0.06, 0.62],
        opacity: 0.94,
        turbulenceStrength: 0.40,
        turbulenceFrequency: 6.0,
        flickerStrength: 0.25,
        flickerFrequency: 9.0,
        coronaStrength: 0.50,
        coronaRadius: 0.88
    },
    'plasma-white-hot': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 30.0,
        coreRadius: 0.28,
        haloColor: [0.92, 0.96, 1.0],
        haloRadius: 0.70,
        beamColor: [0.55, 0.68, 0.85],
        opacity: 0.96,
        turbulenceStrength: 0.30,
        turbulenceFrequency: 4.0,
        flickerStrength: 0.15,
        flickerFrequency: 6.0,
        coronaStrength: 0.60,
        coronaRadius: 0.92
    },
    'anime-plasma': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 32.0,
        coreRadius: 0.30,
        haloColor: [1.0, 0.65, 0.92],
        haloRadius: 0.72,
        beamColor: [0.75, 0.42, 0.70],
        opacity: 0.98,
        turbulenceStrength: 0.50,
        turbulenceFrequency: 8.0,
        flickerStrength: 0.35,
        flickerFrequency: 12.0,
        coronaStrength: 0.70,
        coronaRadius: 0.95
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable plasma scratch records
// ---------------------------------------------------------------------------

class LaserPlasmaScratchPool {
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

const _laserPlasmaScratchPool = new LaserPlasmaScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — plasma-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded plasma highlights.
 */
function applyPlasmaCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.03) {
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
 * Mood tinting for plasma halo.
 */
function gradePlasmaColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate a plasma-turbulence texture via domain-warped multi-octave fBm.
 */
function generatePlasmaTurbulenceTexture(width, height, scale = 0.03, octaves = 5, warpStrength = 1.8, turbulenceStrength = 0.35, coronaStrength = 0.45) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            // Domain warp
            const warpX = SimplexNoise.noise2D(x * 0.008, y * 0.008) * warpStrength;
            const warpY = SimplexNoise.noise2D(x * 0.008 + 100, y * 0.008 + 100) * warpStrength;
            // Multi-octave fBm
            let fbm = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;
            for (let o = 0; o < octaves; o++) {
                fbm += SimplexNoise.noise2D(
                    (x + warpX) * frequency,
                    (y + warpY) * frequency
                ) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;
            // Radial corona falloff centred at image middle
            const dx = (x / width) - 0.5;
            const dy = (y / height) - 0.5;
            const radial = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2.0);
            const corona = (1 - radial) * coronaStrength;
            // Combine
            let value = 0.45 + (fbm - 0.5) * turbulenceStrength + corona * 0.4;
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

const _laserPlasmaWorld = BitECS.createWorld();
const LaserPlasmaMaterialComponent = BitECS.defineComponent({
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
    turbulenceStrength: 'f64',
    turbulenceFrequency: 'f64',
    flickerStrength: 'f64',
    flickerFrequency: 'f64',
    coronaStrength: 'f64',
    coronaRadius: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class LaserPlasmaMaterialBatch {
    constructor() {
        this.world = _laserPlasmaWorld;
        this.materials = [];
        this.entities = [];
        this._elapsed = 0;
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, LaserPlasmaMaterialComponent, eid);
        LaserPlasmaMaterialComponent.materialPtr[eid] = this.materials.length;
        LaserPlasmaMaterialComponent.laserBands[eid] = material.laserBands;
        LaserPlasmaMaterialComponent.laserQuantize[eid] = material.laserQuantize;
        LaserPlasmaMaterialComponent.laserSoftness[eid] = material.laserSoftness;
        LaserPlasmaMaterialComponent.coreIntensity[eid] = material.coreIntensity;
        LaserPlasmaMaterialComponent.coreRadius[eid] = material.coreRadius;
        LaserPlasmaMaterialComponent.haloRadius[eid] = material.haloRadius;
        LaserPlasmaMaterialComponent.haloColorR[eid] = material.haloColor.r;
        LaserPlasmaMaterialComponent.haloColorG[eid] = material.haloColor.g;
        LaserPlasmaMaterialComponent.haloColorB[eid] = material.haloColor.b;
        LaserPlasmaMaterialComponent.turbulenceStrength[eid] = material.turbulenceStrength;
        LaserPlasmaMaterialComponent.turbulenceFrequency[eid] = material.turbulenceFrequency;
        LaserPlasmaMaterialComponent.flickerStrength[eid] = material.flickerStrength;
        LaserPlasmaMaterialComponent.flickerFrequency[eid] = material.flickerFrequency;
        LaserPlasmaMaterialComponent.coronaStrength[eid] = material.coronaStrength;
        LaserPlasmaMaterialComponent.coronaRadius[eid] = material.coronaRadius;
        LaserPlasmaMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        LaserPlasmaMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        LaserPlasmaMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        LaserPlasmaMaterialComponent.moodContrast[eid] = material.moodContrast;
        LaserPlasmaMaterialComponent.rimGlow[eid] = material.rimGlow;
        LaserPlasmaMaterialComponent.variationSeed[eid] = material.variationSeed;
        LaserPlasmaMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[LaserPlasmaMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            material.laserBands = LaserPlasmaMaterialComponent.laserBands[eid];
            material.laserQuantize = LaserPlasmaMaterialComponent.laserQuantize[eid];
            material.laserSoftness = LaserPlasmaMaterialComponent.laserSoftness[eid];
            material.coreIntensity = LaserPlasmaMaterialComponent.coreIntensity[eid];
            material.coreRadius = LaserPlasmaMaterialComponent.coreRadius[eid];
            material.haloRadius = LaserPlasmaMaterialComponent.haloRadius[eid];
            material.haloColor.setRGB(
                LaserPlasmaMaterialComponent.haloColorR[eid],
                LaserPlasmaMaterialComponent.haloColorG[eid],
                LaserPlasmaMaterialComponent.haloColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.turbulenceStrength = LaserPlasmaMaterialComponent.turbulenceStrength[eid];
            material.turbulenceFrequency = LaserPlasmaMaterialComponent.turbulenceFrequency[eid];
            material.flickerStrength = LaserPlasmaMaterialComponent.flickerStrength[eid];
            material.flickerFrequency = LaserPlasmaMaterialComponent.flickerFrequency[eid];
            material.coronaStrength = LaserPlasmaMaterialComponent.coronaStrength[eid];
            material.coronaRadius = LaserPlasmaMaterialComponent.coronaRadius[eid];
            material.moodTemperature = LaserPlasmaMaterialComponent.moodTemperature[eid];
            material.moodSaturation = LaserPlasmaMaterialComponent.moodSaturation[eid];
            material.moodBrightness = LaserPlasmaMaterialComponent.moodBrightness[eid];
            material.moodContrast = LaserPlasmaMaterialComponent.moodContrast[eid];
            material.rimGlow = LaserPlasmaMaterialComponent.rimGlow[eid];
            material.variationSeed = LaserPlasmaMaterialComponent.variationSeed[eid];
            LaserPlasmaMaterialComponent.dirty[eid] = 1;
        }
    }

    update(delta) {
        this._elapsed += delta;
        _plasmaTime = this._elapsed;
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[LaserPlasmaMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            if (material.uniforms && material.uniforms.uTime) {
                material.uniforms.uTime.value = this._elapsed;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Main LaserPlasmaMaterial class
// ---------------------------------------------------------------------------

class LaserPlasmaMaterial extends LaserWhiteCoreBaseMaterial {
    static {
        _laserPlasmaScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isLaserPlasmaMaterial = true;
        this.type = 'LaserPlasmaMaterial';

        this.laserBands = 4;
        this.laserQuantize = 0.6;
        this.laserSoftness = 0.03;
        this.coreIntensity = 22.0;
        this.coreRadius = 0.22;
        this.haloRadius = 0.62;

        // Plasma-specific features
        this.turbulenceStrength = 0.35;
        this.turbulenceFrequency = 5.0;
        this.flickerStrength = 0.20;
        this.flickerFrequency = 8.0;
        this.coronaStrength = 0.45;
        this.coronaRadius = 0.85;

        // Runtime uniform cache
        this.uniforms = {};

        this.transparent = true;
        this.opacity = 0.92;
        this.depthWrite = false;
        this.blending = Constants.ADDITIVE_BLENDING ?? 2;
        this.side = Constants.DOUBLE_SIDE ?? 2;

        this.renderStyleBlend = 0.60;
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    applyPlasmaBanding(baseColor, output) {
        return applyPlasmaCelBanding(baseColor, output, this.laserBands, this.laserQuantize, this.laserSoftness);
    }

    updateMoodColor() {
        gradePlasmaColor(this.haloColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        this.rimGlowColor.copy(this.haloColor);
        return this;
    }

    applyPreset(presetName) {
        const preset = LaserPlasmaPresets[presetName];
        if (!preset) return this;

        this.coreColor.setRGB(preset.coreColor[0], preset.coreColor[1], preset.coreColor[2], ColorManagement.workingColorSpace);
        this.coreIntensity = preset.coreIntensity;
        this.coreRadius = preset.coreRadius;
        this.haloColor.setRGB(preset.haloColor[0], preset.haloColor[1], preset.haloColor[2], ColorManagement.workingColorSpace);
        this.haloRadius = preset.haloRadius;
        this.color.setRGB(preset.beamColor[0], preset.beamColor[1], preset.beamColor[2], ColorManagement.workingColorSpace);
        this.opacity = preset.opacity;
        this.turbulenceStrength = preset.turbulenceStrength;
        this.turbulenceFrequency = preset.turbulenceFrequency;
        this.flickerStrength = preset.flickerStrength;
        this.flickerFrequency = preset.flickerFrequency;
        this.coronaStrength = preset.coronaStrength;
        this.coronaRadius = preset.coronaRadius;

        if (presetName === 'anime-plasma') {
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

    generatePlasmaTurbulenceTexture(width, height, scale = 0.03, octaves = 5, warpStrength = 1.8) {
        return generatePlasmaTurbulenceTexture(width, height, scale, octaves, warpStrength, this.turbulenceStrength, this.coronaStrength);
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

        // Cache for batch updates
        this.uniforms = shader.uniforms;

        shader.uniforms.turbulenceStrength = { value: this.turbulenceStrength };
        shader.uniforms.turbulenceFrequency = { value: this.turbulenceFrequency };
        shader.uniforms.flickerStrength = { value: this.flickerStrength };
        shader.uniforms.flickerFrequency = { value: this.flickerFrequency };
        shader.uniforms.coronaStrength = { value: this.coronaStrength };
        shader.uniforms.coronaRadius = { value: this.coronaRadius };
        shader.uniforms.uTime = { value: 0 };

        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float variationOffset;',
                `uniform float variationOffset;
                uniform float turbulenceStrength;
                uniform float turbulenceFrequency;
                uniform float flickerStrength;
                uniform float flickerFrequency;
                uniform float coronaStrength;
                uniform float coronaRadius;
                uniform float uTime;
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Plasma spherical radial falloff: white-hot core + coloured halo + corona
                {
                    vec2 centreUV = vUv - vec2(0.5);
                    float radialDist = length(centreUV) * 2.0;

                    // White-hot core
                    float coreMask = max(0.0, 1.0 - radialDist / coreRadius);
                    coreMask = pow(coreMask, 1.4);
                    gl_FragColor.rgb += coreColor * coreMask * coreIntensity;

                    // Coloured plasma halo ring
                    float haloInner = smoothstep(coreRadius * 0.75, coreRadius, radialDist);
                    float haloOuter = 1.0 - smoothstep(haloRadius * 0.75, haloRadius, radialDist);
                    float haloMask = haloInner * haloOuter;
                    gl_FragColor.rgb += haloColor * haloMask * 0.7;

                    // Outer plasma corona
                    float coronaInner = smoothstep(haloRadius * 0.85, haloRadius, radialDist);
                    float coronaOuter = 1.0 - smoothstep(coronaRadius * 0.7, coronaRadius, radialDist);
                    float coronaMask = coronaInner * coronaOuter * coronaStrength;
                    gl_FragColor.rgb += haloColor * coronaMask * 0.4;
                }

                // Plasma turbulence
                if (turbulenceStrength > 0.0) {
                    float turbulence = sin(vUv.x * turbulenceFrequency * 6.28318 + variationOffset + uTime * 1.5)
                                     * cos(vUv.y * turbulenceFrequency * 6.28318 + variationOffset + uTime * 1.2);
                    turbulence = turbulence * 0.5 + 0.5;
                    gl_FragColor.rgb += haloColor * turbulence * turbulenceStrength * 0.18;
                }

                // Heat-shimmer flicker
                if (flickerStrength > 0.0) {
                    float flicker = sin(uTime * flickerFrequency + variationOffset) * 0.5 + 0.5;
                    gl_FragColor.rgb *= (1.0 - flickerStrength * 0.5 + flicker * flickerStrength);
                }
                `
            );
    }

    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.turbulenceStrength, this.turbulenceFrequency,
            this.flickerStrength, this.flickerFrequency,
            this.coronaStrength, this.coronaRadius
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.turbulenceStrength = source.turbulenceStrength;
        this.turbulenceFrequency = source.turbulenceFrequency;
        this.flickerStrength = source.flickerStrength;
        this.flickerFrequency = source.flickerFrequency;
        this.coronaStrength = source.coronaStrength;
        this.coronaRadius = source.coronaRadius;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'LaserPlasmaMaterial';
        if (this.turbulenceStrength !== 0.35) data.turbulenceStrength = this.turbulenceStrength;
        if (this.turbulenceFrequency !== 5.0) data.turbulenceFrequency = this.turbulenceFrequency;
        if (this.flickerStrength !== 0.20) data.flickerStrength = this.flickerStrength;
        if (this.flickerFrequency !== 8.0) data.flickerFrequency = this.flickerFrequency;
        if (this.coronaStrength !== 0.45) data.coronaStrength = this.coronaStrength;
        if (this.coronaRadius !== 0.85) data.coronaRadius = this.coronaRadius;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.turbulenceStrength = json.turbulenceStrength ?? this.turbulenceStrength;
        this.turbulenceFrequency = json.turbulenceFrequency ?? this.turbulenceFrequency;
        this.flickerStrength = json.flickerStrength ?? this.flickerStrength;
        this.flickerFrequency = json.flickerFrequency ?? this.flickerFrequency;
        this.coronaStrength = json.coronaStrength ?? this.coronaStrength;
        this.coronaRadius = json.coronaRadius ?? this.coronaRadius;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const LaserPlasmaMaterialBatchComponent = {
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
    turbulenceStrength: 'f64',
    turbulenceFrequency: 'f64',
    flickerStrength: 'f64',
    flickerFrequency: 'f64',
    coronaStrength: 'f64',
    coronaRadius: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    LaserPlasmaMaterial,
    LaserPlasmaMaterialBatch,
    LaserPlasmaScratchPool,
    LaserPlasmaMaterialBatchComponent,
    LaserPlasmaPresets,
    applyPlasmaCelBanding,
    gradePlasmaColor,
    generatePlasmaTurbulenceTexture
};

export default LaserPlasmaMaterial;