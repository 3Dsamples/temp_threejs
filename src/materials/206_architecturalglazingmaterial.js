// file number : 206
// full path name : src/materials/206_architecturalglazingmaterial.js
// description : ArchitecturalGlazingMaterial — a ready-to-use glazing material
//               for architectural visualization, focused on curtain-wall and
//               window systems. Extends MeshPhysicalMaterial with purpose-built
//               presets for clear float glass, low-iron glass, tinted glass,
//               reflective solar-control glass, frosted glass, and laminated
//               safety glass. Includes physically based transmission, IOR,
//               thickness, and attenuation controls matching real architectural
//               glass (IOR 1.45–1.52, thickness 4–12 mm), a procedural
//               frosting/acid-etch texture generator (multi-octave fBm with
//               micro-roughness scattering), and real-time anime stylization
//               (cel-banded glazing reflections, mood tinting, rim glow,
//               paper-grain texture, and per-instance variation). All imports
//               resolve to the internal Threejs_gl repository tree; no CDN
//               dependencies.
// best for : Curtain-wall glazing, window panes, storefronts, skylights,
//            interior glass partitions, balustrades, and any architectural
//            glass system that needs real-time PBR + anime stylization.
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
// Glazing presets — curated PBR parameter sets for common architectural glazing
// ---------------------------------------------------------------------------

/**
 * Reference values (from architectural glazing PBR guides):
 *   - Clear float glass:     IOR 1.52, transmission 1.0, roughness 0.02–0.05,
 *                            thickness 4–12 mm, attenuationColor near white
 *   - Low-iron glass:        IOR 1.50, transmission 1.0, roughness 0.01–0.03,
 *                            attenuationColor very light cyan
 *   - Tinted glass:          IOR 1.52, transmission 0.75–0.9, roughness 0.03–0.06,
 *                            attenuationColor bronze/grey
 *   - Solar-control glass:   IOR 1.52, transmission 0.55–0.8, roughness 0.02–0.05,
 *                            attenuationColor blue/green
 *   - Frosted glass:         IOR 1.52, transmission 0.85, roughness 0.35–0.55,
 *                            thickness 6–10 mm
 *   - Laminated safety glass: IOR 1.52, transmission 1.0, roughness 0.02–0.04,
 *                            thickness 8–16 mm (two layers + PVB interlayer)
 */
const ArchitecturalGlazingPresets = {
    'clear-float': {
        color: [0.96, 0.97, 0.98],
        transmission: 1.0,
        ior: 1.52,
        roughness: 0.03,
        thickness: 0.006,
        attenuationDistance: 500,
        attenuationColor: [0.92, 0.98, 0.96],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0]
    },
    'low-iron': {
        color: [0.98, 0.99, 0.99],
        transmission: 1.0,
        ior: 1.50,
        roughness: 0.02,
        thickness: 0.006,
        attenuationDistance: 2000,
        attenuationColor: [0.96, 1.0, 0.99],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0]
    },
    'tinted-bronze': {
        color: [0.72, 0.58, 0.42],
        transmission: 0.82,
        ior: 1.52,
        roughness: 0.04,
        thickness: 0.006,
        attenuationDistance: 80,
        attenuationColor: [0.65, 0.48, 0.32],
        specularIntensity: 1.0,
        specularColor: [0.95, 0.88, 0.78]
    },
    'tinted-grey': {
        color: [0.55, 0.57, 0.60],
        transmission: 0.78,
        ior: 1.52,
        roughness: 0.04,
        thickness: 0.006,
        attenuationDistance: 90,
        attenuationColor: [0.45, 0.48, 0.52],
        specularIntensity: 1.0,
        specularColor: [0.88, 0.90, 0.92]
    },
    'solar-control': {
        color: [0.62, 0.74, 0.82],
        transmission: 0.65,
        ior: 1.52,
        roughness: 0.03,
        thickness: 0.008,
        attenuationDistance: 120,
        attenuationColor: [0.42, 0.62, 0.75],
        specularIntensity: 1.0,
        specularColor: [0.85, 0.92, 1.0]
    },
    'frosted': {
        color: [0.92, 0.94, 0.95],
        transmission: 0.88,
        ior: 1.52,
        roughness: 0.42,
        thickness: 0.008,
        attenuationDistance: 300,
        attenuationColor: [0.90, 0.94, 0.93],
        specularIntensity: 0.7,
        specularColor: [0.95, 0.96, 0.98]
    },
    'laminated-safety': {
        color: [0.95, 0.96, 0.97],
        transmission: 1.0,
        ior: 1.52,
        roughness: 0.025,
        thickness: 0.012,
        attenuationDistance: 400,
        attenuationColor: [0.90, 0.96, 0.94],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable glazing scratch records
// ---------------------------------------------------------------------------

class GlazingScratchPool {
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

const _glazingScratchPool = new GlazingScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — glazing-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded glazing reflections to a glass surface. Glass reflections
 * are quantized into discrete anime-style bands — producing the crisp, flat
 * highlight edges seen in hand-drawn architectural anime.
 */
function applyGlazingCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.05) {
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
 * Apply mood-based tinting to glazing. Warm moods tint glazing toward amber/
 * gold, cool moods toward cyan/blue — matching the atmospheric glass tinting
 * seen in architectural anime backgrounds.
 */
function gradeGlazingColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.06;
    b -= temperature * 0.06;

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
 * Generate a procedural frosting/acid-etch texture. Acid-etched and sandblasted
 * glass has a micro-roughened surface that scatters transmitted light — this is
 * simulated with a multi-octave fBm noise field producing a uniform fine grain.
 * An optional larger-scale blotch layer simulates varying etch depth across
 * the pane. The output is a grayscale height/roughness map.
 */
function generateFrostingTexture(width, height, scale = 0.08, octaves = 4, etchStrength = 0.25, blotchStrength = 0.1) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Multi-octave fBm for the fine micro-roughness
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

            // Low-frequency blotch for varying etch depth
            const blotch = SimplexNoise.noise2D(x * 0.008, y * 0.008) * 0.5 + 0.5;

            // Combine: base neutral + fine etch grain + slow blotch
            let value = 0.5
                + (fbm - 0.5) * etchStrength
                + (blotch - 0.5) * blotchStrength;

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

const _glazingWorld = BitECS.createWorld();
const ArchitecturalGlazingMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    glazingBands: 'ui8',
    glazingQuantize: 'f64',
    glazingSoftness: 'f64',
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

class ArchitecturalGlazingMaterialBatch {
    constructor() {
        this.world = _glazingWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalGlazingMaterialComponent, eid);
        ArchitecturalGlazingMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalGlazingMaterialComponent.glazingBands[eid] = material.glazingBands;
        ArchitecturalGlazingMaterialComponent.glazingQuantize[eid] = material.glazingQuantize;
        ArchitecturalGlazingMaterialComponent.glazingSoftness[eid] = material.glazingSoftness;
        ArchitecturalGlazingMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalGlazingMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalGlazingMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalGlazingMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalGlazingMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalGlazingMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalGlazingMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalGlazingMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalGlazingMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalGlazingMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.glazingBands = ArchitecturalGlazingMaterialComponent.glazingBands[eid];
            material.glazingQuantize = ArchitecturalGlazingMaterialComponent.glazingQuantize[eid];
            material.glazingSoftness = ArchitecturalGlazingMaterialComponent.glazingSoftness[eid];
            material.moodTemperature = ArchitecturalGlazingMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalGlazingMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalGlazingMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalGlazingMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalGlazingMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalGlazingMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalGlazingMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalGlazingMaterialComponent.variationSeed[eid];

            ArchitecturalGlazingMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalGlazingMaterial class
// ---------------------------------------------------------------------------

class ArchitecturalGlazingMaterial extends MeshPhysicalMaterial {
    static {
        _glazingScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isArchitecturalGlazingMaterial = true;
        this.type = 'ArchitecturalGlazingMaterial';

        // PBR defaults (clear float glass)
        this.ior = 1.52;
        this.transmission = 1.0;
        this.roughness = 0.03;
        this.metalness = 0.0;
        this.thickness = 0.006;
        this.attenuationDistance = 500;
        this.attenuationColor = new Color(0.92, 0.98, 0.96);
        this.specularIntensity = 1.0;
        this.specularColor = new Color(1.0, 1.0, 1.0);
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;
        this.color = new Color(0.96, 0.97, 0.98);
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // Anime extensions
        this.glazingBands = 3;
        this.glazingQuantize = 0.5;
        this.glazingSoftness = 0.05;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.2;
        this.rimGlowColor = new Color(0.6, 0.85, 1.0);
        this.paperGrain = 0;
        this.watercolorBleed = 0;
        this.variationSeed = 0;

        // PBR ↔ Anime blend
        this.renderStyleBlend = 0.3;

        // Galactic-scale
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // Anime helpers
    applyGlazingBanding(baseColor, output) {
        return applyGlazingCelBanding(baseColor, output, this.glazingBands, this.glazingQuantize, this.glazingSoftness);
    }

    updateMoodColor() {
        gradeGlazingColor(this.color, this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast);
        return this;
    }

    applyPreset(presetName) {
        const preset = ArchitecturalGlazingPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.transmission = preset.transmission;
        this.ior = preset.ior;
        this.roughness = preset.roughness;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness for frosted vs clear glass
        if (presetName === 'frosted') {
            this.glazingSoftness = 0.35;
            this.glazingBands = 2;
        } else {
            this.glazingSoftness = 0.05;
            this.glazingBands = 3;
        }

        this.updateMoodColor();
        return this;
    }

    generateFrostingTexture(width, height, scale = 0.08, octaves = 4) {
        return generateFrostingTexture(width, height, scale, octaves, 0.25, 0.1);
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

        shader.uniforms.glazingBands = { value: this.glazingBands };
        shader.uniforms.glazingQuantize = { value: this.glazingQuantize };
        shader.uniforms.glazingSoftness = { value: this.glazingSoftness };
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
                uniform int glazingBands;
                uniform float glazingQuantize;
                uniform float glazingSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyGlazingBands(vec3 baseColor) {
                    if (glazingBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(glazingBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * glazingSoftness;
                    float finalLum = mix(lum, softQuantized, glazingQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                gl_FragColor.rgb = applyGlazingBands(gl_FragColor.rgb);

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
            this.ior, this.transmission, this.roughness, this.metalness,
            this.thickness, this.attenuationDistance, this.specularIntensity,
            this.glazingBands, this.glazingQuantize, this.glazingSoftness,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.ior = source.ior;
        this.transmission = source.transmission;
        this.roughness = source.roughness;
        this.metalness = source.metalness;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.specularIntensity = source.specularIntensity;
        this.specularColor.copy(source.specularColor);
        this.glazingBands = source.glazingBands;
        this.glazingQuantize = source.glazingQuantize;
        this.glazingSoftness = source.glazingSoftness;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'ArchitecturalGlazingMaterial';
        if (this.ior !== 1.52) data.ior = this.ior;
        if (this.transmission !== 1.0) data.transmission = this.transmission;
        if (this.roughness !== 0.03) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.thickness !== 0.006) data.thickness = this.thickness;
        if (this.attenuationDistance !== 500) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.92, 0.98, 0.96).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularIntensity !== 1.0) data.specularIntensity = this.specularIntensity;
        if (this.specularColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.glazingBands !== 3) data.glazingBands = this.glazingBands;
        if (this.glazingQuantize !== 0.5) data.glazingQuantize = this.glazingQuantize;
        if (this.glazingSoftness !== 0.05) data.glazingSoftness = this.glazingSoftness;
        if (this.rimGlow !== 0.2) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.6, 0.85, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.ior = json.ior ?? this.ior;
        this.transmission = json.transmission ?? this.transmission;
        this.roughness = json.roughness ?? this.roughness;
        this.metalness = json.metalness ?? this.metalness;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);
        this.glazingBands = json.glazingBands ?? this.glazingBands;
        this.glazingQuantize = json.glazingQuantize ?? this.glazingQuantize;
        this.glazingSoftness = json.glazingSoftness ?? this.glazingSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const ArchitecturalGlazingMaterialBatchComponent = {
    materialPtr: 'ui32',
    glazingBands: 'ui8',
    glazingQuantize: 'f64',
    glazingSoftness: 'f64',
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
    ArchitecturalGlazingMaterial,
    ArchitecturalGlazingMaterialBatch,
    GlazingScratchPool,
    ArchitecturalGlazingMaterialBatchComponent,
    ArchitecturalGlazingPresets,
    applyGlazingCelBanding,
    gradeGlazingColor,
    generateFrostingTexture
};

export default ArchitecturalGlazingMaterial;