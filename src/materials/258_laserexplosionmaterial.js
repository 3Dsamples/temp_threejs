// file number : 258
// full path name : src/materials/258_laserexplosionmaterial.js
// description : LaserExplosionMaterial — a ready-to-use laser-explosion
//               material for impact flashes, plasma explosions, energy
//               detonations, and expanding shockwave shells. Extends
//               LaserWhiteCoreBaseMaterial with explosion-specific features:
//               an animated expanding shockwave radius (via uTime-driven
//               uniform), spherical wavefront fresnel boost for the bright
//               expanding edge, an initial white-flash burst overload, an
//               expanding shell that fades as it grows, and a
//               shockwave-front distortion approximation. Adds real-time
//               anime stylization: cel-banded explosion highlights,
//               white-hot core, expanding shockwave ring, mood tinting, rim
//               glow, and per-instance variation. Includes a procedural
//               explosion-shockwave texture generator using expanding-ring
//               SDFs and fBm turbulence.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Laser explosions, impact flashes, plasma detonations, energy
//            shockwaves, magic burst effects, sci-fi explosion beams, anime
//            attack impact flashes, and any white-cored explosion surface that
//            needs real-time PBR + anime stylization.
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
// Explosion presets — physically grounded parameter sets for laser
// detonation flashes and expanding shockwaves.
// ---------------------------------------------------------------------------

const LaserExplosionPresets = {
    'laser-flash-red': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 30.0,
        coreRadius: 0.25,
        haloColor: [1.0, 0.18, 0.10],
        haloRadius: 0.65,
        beamColor: [0.85, 0.10, 0.05],
        opacity: 0.98,
        shockwaveSpeed: 1.2,
        shockwaveThickness: 0.12,
        shockwaveFresnelBoost: 1.8,
        initialFlashDuration: 0.08,
        shellExpansionRate: 0.85,
        ringBanding: 4
    },
    'laser-flash-blue': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 30.0,
        coreRadius: 0.25,
        haloColor: [0.12, 0.50, 1.0],
        haloRadius: 0.65,
        beamColor: [0.05, 0.20, 0.85],
        opacity: 0.98,
        shockwaveSpeed: 1.2,
        shockwaveThickness: 0.12,
        shockwaveFresnelBoost: 1.8,
        initialFlashDuration: 0.08,
        shellExpansionRate: 0.85,
        ringBanding: 4
    },
    'plasma-detonation': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 36.0,
        coreRadius: 0.30,
        haloColor: [1.0, 0.55, 0.95],
        haloRadius: 0.75,
        beamColor: [0.85, 0.35, 0.75],
        opacity: 1.0,
        shockwaveSpeed: 1.8,
        shockwaveThickness: 0.16,
        shockwaveFresnelBoost: 2.4,
        initialFlashDuration: 0.12,
        shellExpansionRate: 1.2,
        ringBanding: 5
    },
    'nuclear-white-flash': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 50.0,
        coreRadius: 0.45,
        haloColor: [1.0, 0.98, 0.92],
        haloRadius: 0.90,
        beamColor: [0.85, 0.85, 0.85],
        opacity: 1.0,
        shockwaveSpeed: 2.5,
        shockwaveThickness: 0.20,
        shockwaveFresnelBoost: 3.0,
        initialFlashDuration: 0.20,
        shellExpansionRate: 1.6,
        ringBanding: 3
    },
    'magic-burst': {
        coreColor: [1.0, 0.98, 1.0],
        coreIntensity: 34.0,
        coreRadius: 0.28,
        haloColor: [0.92, 0.55, 1.0],
        haloRadius: 0.72,
        beamColor: [0.65, 0.30, 0.82],
        opacity: 0.98,
        shockwaveSpeed: 1.5,
        shockwaveThickness: 0.14,
        shockwaveFresnelBoost: 2.2,
        initialFlashDuration: 0.10,
        shellExpansionRate: 1.0,
        ringBanding: 5
    },
    'anime-explosion': {
        coreColor: [1.0, 1.0, 1.0],
        coreIntensity: 44.0,
        coreRadius: 0.36,
        haloColor: [1.0, 0.65, 0.92],
        haloRadius: 0.85,
        beamColor: [0.85, 0.42, 0.72],
        opacity: 1.0,
        shockwaveSpeed: 2.0,
        shockwaveThickness: 0.20,
        shockwaveFresnelBoost: 3.2,
        initialFlashDuration: 0.15,
        shellExpansionRate: 1.4,
        ringBanding: 6
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable explosion scratch records
// ---------------------------------------------------------------------------

class LaserExplosionScratchPool {
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

const _laserExplosionScratchPool = new LaserExplosionScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — explosion-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded explosion highlights.
 */
function applyExplosionCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.03) {
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
 * Mood tinting for explosion halo.
 */
function gradeExplosionColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate an explosion-shockwave texture: expanding ring SDF + turbulence.
 */
function generateExplosionShockwaveTexture(width, height, ringRadius = 0.35, ringThickness = 0.12, turbulenceStrength = 0.35, ringBands = 4) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            const dx = (x / width) - 0.5;
            const dy = (y / height) - 0.5;
            const radial = Math.sqrt(dx * dx + dy * dy) * 2.0;
            // Expanding shockwave ring
            const ringDist = Math.abs(radial - ringRadius);
            const ringMask = Math.max(0, 1.0 - ringDist / ringThickness);
            // Quantize ring into bands for cel-shading
            let bandMask = ringMask;
            if (ringBands > 1) {
                const bandIndex = Math.floor(ringMask * ringBands);
                bandMask = bandIndex / (ringBands - 1);
            }
            // Turbulence
            let fbm = 0;
            let amplitude = 1;
            let frequency = 0.03;
            let maxAmplitude = 0;
            for (let o = 0; o < 4; o++) {
                fbm += SimplexNoise.noise2D(x * frequency, y * frequency) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;
            const turb = (fbm - 0.5) * turbulenceStrength;
            // Central hot core
            const core = Math.max(0, 1.0 - radial / (ringRadius * 0.6));
            let value = bandMask * 0.55 + core * 0.45 + turb * 0.15;
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

const _laserExplosionWorld = BitECS.createWorld();
const LaserExplosionMaterialComponent = BitECS.defineComponent({
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
    shockwaveSpeed: 'f64',
    shockwaveThickness: 'f64',
    shockwaveFresnelBoost: 'f64',
    initialFlashDuration: 'f64',
    shellExpansionRate: 'f64',
    ringBanding: 'ui8',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class LaserExplosionMaterialBatch {
    constructor() {
        this.world = _laserExplosionWorld;
        this.materials = [];
        this.entities = [];
        this._elapsed = 0;
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, LaserExplosionMaterialComponent, eid);
        LaserExplosionMaterialComponent.materialPtr[eid] = this.materials.length;
        LaserExplosionMaterialComponent.laserBands[eid] = material.laserBands;
        LaserExplosionMaterialComponent.laserQuantize[eid] = material.laserQuantize;
        LaserExplosionMaterialComponent.laserSoftness[eid] = material.laserSoftness;
        LaserExplosionMaterialComponent.coreIntensity[eid] = material.coreIntensity;
        LaserExplosionMaterialComponent.coreRadius[eid] = material.coreRadius;
        LaserExplosionMaterialComponent.haloRadius[eid] = material.haloRadius;
        LaserExplosionMaterialComponent.haloColorR[eid] = material.haloColor.r;
        LaserExplosionMaterialComponent.haloColorG[eid] = material.haloColor.g;
        LaserExplosionMaterialComponent.haloColorB[eid] = material.haloColor.b;
        LaserExplosionMaterialComponent.shockwaveSpeed[eid] = material.shockwaveSpeed;
        LaserExplosionMaterialComponent.shockwaveThickness[eid] = material.shockwaveThickness;
        LaserExplosionMaterialComponent.shockwaveFresnelBoost[eid] = material.shockwaveFresnelBoost;
        LaserExplosionMaterialComponent.initialFlashDuration[eid] = material.initialFlashDuration;
        LaserExplosionMaterialComponent.shellExpansionRate[eid] = material.shellExpansionRate;
        LaserExplosionMaterialComponent.ringBanding[eid] = material.ringBanding;
        LaserExplosionMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        LaserExplosionMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        LaserExplosionMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        LaserExplosionMaterialComponent.moodContrast[eid] = material.moodContrast;
        LaserExplosionMaterialComponent.rimGlow[eid] = material.rimGlow;
        LaserExplosionMaterialComponent.variationSeed[eid] = material.variationSeed;
        LaserExplosionMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[LaserExplosionMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            material.laserBands = LaserExplosionMaterialComponent.laserBands[eid];
            material.laserQuantize = LaserExplosionMaterialComponent.laserQuantize[eid];
            material.laserSoftness = LaserExplosionMaterialComponent.laserSoftness[eid];
            material.coreIntensity = LaserExplosionMaterialComponent.coreIntensity[eid];
            material.coreRadius = LaserExplosionMaterialComponent.coreRadius[eid];
            material.haloRadius = LaserExplosionMaterialComponent.haloRadius[eid];
            material.haloColor.setRGB(
                LaserExplosionMaterialComponent.haloColorR[eid],
                LaserExplosionMaterialComponent.haloColorG[eid],
                LaserExplosionMaterialComponent.haloColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.shockwaveSpeed = LaserExplosionMaterialComponent.shockwaveSpeed[eid];
            material.shockwaveThickness = LaserExplosionMaterialComponent.shockwaveThickness[eid];
            material.shockwaveFresnelBoost = LaserExplosionMaterialComponent.shockwaveFresnelBoost[eid];
            material.initialFlashDuration = LaserExplosionMaterialComponent.initialFlashDuration[eid];
            material.shellExpansionRate = LaserExplosionMaterialComponent.shellExpansionRate[eid];
            material.ringBanding = LaserExplosionMaterialComponent.ringBanding[eid];
            material.moodTemperature = LaserExplosionMaterialComponent.moodTemperature[eid];
            material.moodSaturation = LaserExplosionMaterialComponent.moodSaturation[eid];
            material.moodBrightness = LaserExplosionMaterialComponent.moodBrightness[eid];
            material.moodContrast = LaserExplosionMaterialComponent.moodContrast[eid];
            material.rimGlow = LaserExplosionMaterialComponent.rimGlow[eid];
            material.variationSeed = LaserExplosionMaterialComponent.variationSeed[eid];
            LaserExplosionMaterialComponent.dirty[eid] = 1;
        }
    }

    update(delta) {
        this._elapsed += delta;
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[LaserExplosionMaterialComponent.materialPtr[eid]];
            if (!material) continue;
            if (material.uniforms && material.uniforms.uTime) {
                material.uniforms.uTime.value = this._elapsed;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Main LaserExplosionMaterial class
// ---------------------------------------------------------------------------

class LaserExplosionMaterial extends LaserWhiteCoreBaseMaterial {
    static {
        _laserExplosionScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isLaserExplosionMaterial = true;
        this.type = 'LaserExplosionMaterial';

        this.laserBands = 4;
        this.laserQuantize = 0.7;
        this.laserSoftness = 0.03;
        this.coreIntensity = 30.0;
        this.coreRadius = 0.25;
        this.haloRadius = 0.65;

        // Explosion-specific controls
        this.shockwaveSpeed = 1.2;
        this.shockwaveThickness = 0.12;
        this.shockwaveFresnelBoost = 1.8;
        this.initialFlashDuration = 0.08;
        this.shellExpansionRate = 0.85;
        this.ringBanding = 4;

        // Runtime uniform cache
        this.uniforms = {};

        this.transparent = true;
        this.opacity = 0.98;
        this.depthWrite = false;
        this.blending = Constants.ADDITIVE_BLENDING ?? 2;
        this.side = Constants.DOUBLE_SIDE ?? 2;

        this.renderStyleBlend = 0.70;
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    applyExplosionBanding(baseColor, output) {
        return applyExplosionCelBanding(baseColor, output, this.laserBands, this.laserQuantize, this.laserSoftness);
    }

    updateMoodColor() {
        gradeExplosionColor(this.haloColor, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        this.rimGlowColor.copy(this.haloColor);
        return this;
    }

    applyPreset(presetName) {
        const preset = LaserExplosionPresets[presetName];
        if (!preset) return this;

        this.coreColor.setRGB(preset.coreColor[0], preset.coreColor[1], preset.coreColor[2], ColorManagement.workingColorSpace);
        this.coreIntensity = preset.coreIntensity;
        this.coreRadius = preset.coreRadius;
        this.haloColor.setRGB(preset.haloColor[0], preset.haloColor[1], preset.haloColor[2], ColorManagement.workingColorSpace);
        this.haloRadius = preset.haloRadius;
        this.color.setRGB(preset.beamColor[0], preset.beamColor[1], preset.beamColor[2], ColorManagement.workingColorSpace);
        this.opacity = preset.opacity;
        this.shockwaveSpeed = preset.shockwaveSpeed;
        this.shockwaveThickness = preset.shockwaveThickness;
        this.shockwaveFresnelBoost = preset.shockwaveFresnelBoost;
        this.initialFlashDuration = preset.initialFlashDuration;
        this.shellExpansionRate = preset.shellExpansionRate;
        this.ringBanding = preset.ringBanding;

        if (presetName === 'anime-explosion') {
            this.laserSoftness = 0.02;
            this.laserBands = 5;
            this.rimGlow = 0.40;
        } else {
            this.laserSoftness = 0.03;
            this.laserBands = 4;
            this.rimGlow = 0.25;
        }

        this.updateMoodColor();
        return this;
    }

    generateExplosionShockwaveTexture(width, height, ringRadius = 0.35, ringThickness = 0.12, turbulenceStrength = 0.35, ringBands = 4) {
        return generateExplosionShockwaveTexture(width, height, ringRadius, ringThickness, turbulenceStrength, ringBands);
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

        shader.uniforms.shockwaveSpeed = { value: this.shockwaveSpeed };
        shader.uniforms.shockwaveThickness = { value: this.shockwaveThickness };
        shader.uniforms.shockwaveFresnelBoost = { value: this.shockwaveFresnelBoost };
        shader.uniforms.initialFlashDuration = { value: this.initialFlashDuration };
        shader.uniforms.shellExpansionRate = { value: this.shellExpansionRate };
        shader.uniforms.ringBanding = { value: this.ringBanding };
        shader.uniforms.uTime = { value: 0 };

        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float variationOffset;',
                `uniform float variationOffset;
                uniform float shockwaveSpeed;
                uniform float shockwaveThickness;
                uniform float shockwaveFresnelBoost;
                uniform float initialFlashDuration;
                uniform float shellExpansionRate;
                uniform int ringBanding;
                uniform float uTime;
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Explosion centre UV (assume the mesh centre is the explosion origin)
                vec2 centreUV = vUv - vec2(0.5);
                float radial = length(centreUV) * 2.0;

                // Expanding shockwave radius driven by uTime
                float shellRadius = min(1.0, uTime * shellExpansionRate);
                float wavefrontDist = abs(radial - shellRadius);
                float wavefrontMask = max(0.0, 1.0 - wavefrontDist / shockwaveThickness);
                // Cel-band the wavefront
                if (ringBanding > 1) {
                    float bandIdx = floor(wavefrontMask * float(ringBanding));
                    wavefrontMask = bandIdx / float(ringBanding - 1);
                }

                // Spherical wavefront fresnel boost (bright expanding edge)
                float ndotvExp = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                float fresnelEdge = pow(1.0 - ndotvExp, 2.5);
                float shockwaveEdge = wavefrontMask * (1.0 + fresnelEdge * shockwaveFresnelBoost);
                gl_FragColor.rgb += coreColor * shockwaveEdge * 1.4;
                gl_FragColor.rgb += haloColor * shockwaveEdge * 0.6;

                // Initial white-flash burst: bright overload at t < initialFlashDuration
                if (uTime < initialFlashDuration) {
                    float flashRatio = 1.0 - (uTime / initialFlashDuration);
                    gl_FragColor.rgb += coreColor * flashRatio * coreIntensity * 0.5;
                }

                // Expanding shell fade-out: brightness fades as shell grows
                gl_FragColor.a *= mix(1.0, 0.15, smoothstep(0.6, 1.0, shellRadius));

                // Warm rim glow on explosion edges
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
            this.shockwaveSpeed, this.shockwaveThickness,
            this.shockwaveFresnelBoost, this.initialFlashDuration,
            this.shellExpansionRate, this.ringBanding
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.shockwaveSpeed = source.shockwaveSpeed;
        this.shockwaveThickness = source.shockwaveThickness;
        this.shockwaveFresnelBoost = source.shockwaveFresnelBoost;
        this.initialFlashDuration = source.initialFlashDuration;
        this.shellExpansionRate = source.shellExpansionRate;
        this.ringBanding = source.ringBanding;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'LaserExplosionMaterial';
        if (this.shockwaveSpeed !== 1.2) data.shockwaveSpeed = this.shockwaveSpeed;
        if (this.shockwaveThickness !== 0.12) data.shockwaveThickness = this.shockwaveThickness;
        if (this.shockwaveFresnelBoost !== 1.8) data.shockwaveFresnelBoost = this.shockwaveFresnelBoost;
        if (this.initialFlashDuration !== 0.08) data.initialFlashDuration = this.initialFlashDuration;
        if (this.shellExpansionRate !== 0.85) data.shellExpansionRate = this.shellExpansionRate;
        if (this.ringBanding !== 4) data.ringBanding = this.ringBanding;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.shockwaveSpeed = json.shockwaveSpeed ?? this.shockwaveSpeed;
        this.shockwaveThickness = json.shockwaveThickness ?? this.shockwaveThickness;
        this.shockwaveFresnelBoost = json.shockwaveFresnelBoost ?? this.shockwaveFresnelBoost;
        this.initialFlashDuration = json.initialFlashDuration ?? this.initialFlashDuration;
        this.shellExpansionRate = json.shellExpansionRate ?? this.shellExpansionRate;
        this.ringBanding = json.ringBanding ?? this.ringBanding;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const LaserExplosionMaterialBatchComponent = {
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
    shockwaveSpeed: 'f64',
    shockwaveThickness: 'f64',
    shockwaveFresnelBoost: 'f64',
    initialFlashDuration: 'f64',
    shellExpansionRate: 'f64',
    ringBanding: 'ui8',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    LaserExplosionMaterial,
    LaserExplosionMaterialBatch,
    LaserExplosionScratchPool,
    LaserExplosionMaterialBatchComponent,
    LaserExplosionPresets,
    applyExplosionCelBanding,
    gradeExplosionColor,
    generateExplosionShockwaveTexture
};

export default LaserExplosionMaterial;