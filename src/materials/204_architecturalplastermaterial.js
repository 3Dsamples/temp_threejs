// file number : 204
// full path name : src/materials/204_architecturalplastermaterial.js
// description : ArchitecturalPlasterMaterial — a ready-to-use plaster material
//               for architectural visualization. Extends MeshPhysicalMaterial
//               with purpose-built defaults for gypsum plaster, lime plaster,
//               stucco, Venetian plaster, and clay plaster: high roughness,
//               slight sheen for polished Venetian plaster, subtle trowel-mark
//               variation, and real-time anime stylization (cel-banded plaster
//               highlights, mood tinting, rim glow, paper-grain texture,
//               watercolor bleed, and per-instance variation). Includes a
//               procedural trowel-mark texture generator using domain-warped
//               fBm with directional streaks, plus curated presets. All imports
//               resolve to the internal Threejs_gl repository tree; no CDN
//               dependencies.
// best for : Architectural plaster, gypsum plaster, lime plaster, stucco,
//            Venetian plaster, clay plaster, interior wall finishes, ceiling
//            plaster, and any plaster surface that needs real-time PBR + anime
//            stylization.
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

// ---------------------------------------------------------------------------
// Plaster presets — curated PBR parameter sets for common architectural plasters
// ---------------------------------------------------------------------------

const ArchitecturalPlasterPresets = {
    'gypsum-plaster': {
        color: [0.92, 0.91, 0.89],
        roughness: 0.88,
        metalness: 0.0,
        specularIntensity: 0.25,
        specularColor: [0.9, 0.88, 0.85],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        sheen: 0.15,
        sheenColor: [0.95, 0.93, 0.9]
    },
    'lime-plaster': {
        color: [0.88, 0.86, 0.82],
        roughness: 0.82,
        metalness: 0.0,
        specularIntensity: 0.28,
        specularColor: [0.9, 0.87, 0.82],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        sheen: 0.25,
        sheenColor: [0.92, 0.9, 0.85]
    },
    'stucco': {
        color: [0.82, 0.79, 0.74],
        roughness: 0.9,
        metalness: 0.0,
        specularIntensity: 0.2,
        specularColor: [0.85, 0.82, 0.78],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        sheen: 0.1,
        sheenColor: [0.88, 0.85, 0.8]
    },
    'venetian-plaster': {
        color: [0.78, 0.74, 0.68],
        roughness: 0.35,
        metalness: 0.0,
        specularIntensity: 0.55,
        specularColor: [0.95, 0.92, 0.88],
        clearcoat: 0.4,
        clearcoatRoughness: 0.15,
        sheen: 0.6,
        sheenColor: [0.9, 0.87, 0.82]
    },
    'clay-plaster': {
        color: [0.72, 0.62, 0.52],
        roughness: 0.85,
        metalness: 0.0,
        specularIntensity: 0.22,
        specularColor: [0.85, 0.78, 0.7],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        sheen: 0.2,
        sheenColor: [0.88, 0.8, 0.72]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable plaster scratch records
// ---------------------------------------------------------------------------

class PlasterScratchPool {
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

const _plasterScratchPool = new PlasterScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — plaster-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded plaster highlights. Plaster has soft, low-frequency
 * shading — quantizing it into discrete bands produces the crisp anime
 * plaster edges seen in hand-drawn architectural interiors.
 */
function applyPlasterCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.2) {
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
 * Apply mood-based tinting to plaster. Warm moods tint plaster toward warm
 * cream/ivory, cool moods toward cool grey-blue.
 */
function gradePlasterColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.03;
    b -= temperature * 0.03;

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
 * Generate a procedural trowel-mark texture. Uses domain-warped fBm with
 * directional streaks to simulate the layered, hand-applied look of plaster.
 */
function generatePlasterTexture(width, height, scale = 0.03, octaves = 4, trowelStrength = 0.2, warpStrength = 1.5) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            const warpX = SimplexNoise.noise2D(x * 0.008, y * 0.008) * warpStrength;
            const warpY = SimplexNoise.noise2D(x * 0.008 + 50, y * 0.008 + 50) * warpStrength;

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

            // Directional trowel streaks
            const trowel = SimplexNoise.noise2D((x + warpX) * 0.02, (y + warpY) * 0.15) * trowelStrength;

            let value = 0.7 + (fbm - 0.5) * 0.2 + trowel * 0.5;
            value = Math.max(0, Math.min(1, value));

            const v = Math.floor(value * 255);
            out[p] = v;
            out[p + 1] = v;
            out[p + 2] = v;
            out[p + 3] = 255;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator
// ---------------------------------------------------------------------------

const _plasterWorld = BitECS.createWorld();
const ArchitecturalPlasterMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    plasterBands: 'ui8',
    plasterQuantize: 'f64',
    plasterSoftness: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class ArchitecturalPlasterMaterialBatch {
    constructor() {
        this.world = _plasterWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalPlasterMaterialComponent, eid);
        ArchitecturalPlasterMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalPlasterMaterialComponent.plasterBands[eid] = material.plasterBands;
        ArchitecturalPlasterMaterialComponent.plasterQuantize[eid] = material.plasterQuantize;
        ArchitecturalPlasterMaterialComponent.plasterSoftness[eid] = material.plasterSoftness;
        ArchitecturalPlasterMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalPlasterMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalPlasterMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalPlasterMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalPlasterMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalPlasterMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalPlasterMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalPlasterMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalPlasterMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalPlasterMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.plasterBands = ArchitecturalPlasterMaterialComponent.plasterBands[eid];
            material.plasterQuantize = ArchitecturalPlasterMaterialComponent.plasterQuantize[eid];
            material.plasterSoftness = ArchitecturalPlasterMaterialComponent.plasterSoftness[eid];
            material.moodTemperature = ArchitecturalPlasterMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalPlasterMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalPlasterMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalPlasterMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalPlasterMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalPlasterMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalPlasterMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalPlasterMaterialComponent.variationSeed[eid];

            ArchitecturalPlasterMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalPlasterMaterial class
// ---------------------------------------------------------------------------

class ArchitecturalPlasterMaterial extends MeshPhysicalMaterial {
    static {
        _plasterScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isArchitecturalPlasterMaterial = true;
        this.type = 'ArchitecturalPlasterMaterial';

        // PBR defaults
        this.ior = 1.5;
        this.specularIntensity = 0.25;
        this.roughness = 0.88;
        this.metalness = 0.0;
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;
        this.specularColor = new Color(0.9, 0.88, 0.85);
        this.color = new Color(0.92, 0.91, 0.89);
        this.sheen = 0.15;
        this.sheenColor = new Color(0.95, 0.93, 0.9);
        this.sheenRoughness = 0.8;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        // Anime extensions
        this.plasterBands = 2;
        this.plasterQuantize = 0.5;
        this.plasterSoftness = 0.25;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.1;
        this.rimGlowColor = new Color(0.9, 0.88, 0.85);
        this.paperGrain = 0;
        this.watercolorBleed = 0;
        this.variationSeed = 0;

        // PBR ↔ Anime blend
        this.renderStyleBlend = 0.35;

        // Galactic-scale
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // Anime helpers
    applyPlasterBanding(baseColor, output) {
        return applyPlasterCelBanding(baseColor, output, this.plasterBands, this.plasterQuantize, this.plasterSoftness);
    }

    updateMoodColor() {
        gradePlasterColor(this.color, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        return this;
    }

    applyPreset(presetName) {
        const preset = ArchitecturalPlasterPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.plasterSoftness = preset.roughness > 0.8 ? 0.3 : 0.15;

        this.updateMoodColor();
        return this;
    }

    generatePlasterTexture(width, height, scale = 0.03, octaves = 4) {
        return generatePlasterTexture(width, height, scale, octaves, 0.2, 1.5);
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

        shader.uniforms.plasterBands = { value: this.plasterBands };
        shader.uniforms.plasterQuantize = { value: this.plasterQuantize };
        shader.uniforms.plasterSoftness = { value: this.plasterSoftness };
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
                uniform int plasterBands;
                uniform float plasterQuantize;
                uniform float plasterSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyPlasterBands(vec3 baseColor) {
                    if (plasterBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(plasterBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * plasterSoftness;
                    float finalLum = mix(lum, softQuantized, plasterQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                gl_FragColor.rgb = applyPlasterBands(gl_FragColor.rgb);

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
            this.ior, this.specularIntensity, this.roughness, this.metalness,
            this.clearcoat, this.clearcoatRoughness, this.sheen, this.sheenRoughness,
            this.plasterBands, this.plasterQuantize, this.plasterSoftness,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.ior = source.ior;
        this.specularIntensity = source.specularIntensity;
        this.roughness = source.roughness;
        this.metalness = source.metalness;
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.specularColor.copy(source.specularColor);
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.plasterBands = source.plasterBands;
        this.plasterQuantize = source.plasterQuantize;
        this.plasterSoftness = source.plasterSoftness;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'ArchitecturalPlasterMaterial';
        if (this.ior !== 1.5) data.ior = this.ior;
        if (this.specularIntensity !== 0.25) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.88) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.9, 0.88, 0.85).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.sheen !== 0.15) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.95, 0.93, 0.9).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.8) data.sheenRoughness = this.sheenRoughness;
        if (this.plasterBands !== 2) data.plasterBands = this.plasterBands;
        if (this.plasterQuantize !== 0.5) data.plasterQuantize = this.plasterQuantize;
        if (this.plasterSoftness !== 0.25) data.plasterSoftness = this.plasterSoftness;
        if (this.rimGlow !== 0.1) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.9, 0.88, 0.85).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.ior = json.ior ?? this.ior;
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        this.roughness = json.roughness ?? this.roughness;
        this.metalness = json.metalness ?? this.metalness;
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.plasterBands = json.plasterBands ?? this.plasterBands;
        this.plasterQuantize = json.plasterQuantize ?? this.plasterQuantize;
        this.plasterSoftness = json.plasterSoftness ?? this.plasterSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const ArchitecturalPlasterMaterialBatchComponent = {
    materialPtr: 'ui32',
    plasterBands: 'ui8',
    plasterQuantize: 'f64',
    plasterSoftness: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    ArchitecturalPlasterMaterial,
    ArchitecturalPlasterMaterialBatch,
    PlasterScratchPool,
    ArchitecturalPlasterMaterialBatchComponent,
    ArchitecturalPlasterPresets,
    applyPlasterCelBanding,
    gradePlasterColor,
    generatePlasterTexture
};

export default ArchitecturalPlasterMaterial;