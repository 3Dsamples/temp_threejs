// file number : 208
// full path name : src/materials/208_architecturalgravelmaterial.js
// description : ArchitecturalGravelMaterial — a ready-to-use gravel material
//               for architectural visualization, focused on gravel beds,
//               aggregate paving, exposed-aggregate concrete, drainage strips,
//               and decorative stone beds. Extends MeshPhysicalMaterial with
//               purpose-built presets for pea gravel, crushed stone, river
//               rock, and exposed aggregate. Includes gravel-appropriate PBR
//               defaults (high roughness, zero metalness, subtle per-stone
//               colour variation), real-time anime stylization (cel-banded
//               aggregate highlights, mood tinting, rim glow, paper-grain
//               texture, watercolor bleed, and per-instance variation), and a
//               procedural gravel-pattern texture generator using jittered
//               point seeding with Voronoi-style F1 distance and per-stone
//               colour hashing. All imports resolve to the internal
//               Threejs_gl repository tree; no CDN dependencies.
// best for : Architectural gravel, gravel beds, aggregate paving, exposed-
//            aggregate concrete, drainage strips, decorative stone beds,
//            river-rock features, path gravel, and any aggregate surface that
//            needs real-time PBR + anime stylization.
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
// Gravel presets — curated PBR parameter sets for common architectural gravels
// ---------------------------------------------------------------------------

/**
 * Gravel reference PBR values (from architectural aggregate guides):
 *   - Pea gravel:        roughness 0.92–0.96, warm mixed greys
 *   - Crushed stone:     roughness 0.94–0.98, cool angular greys
 *   - River rock:        roughness 0.75–0.85 (smoother), warm mixed browns
 *   - Exposed aggregate: roughness 0.88–0.92, warm concrete-bound stones
 *   - Gravel is universally non-metallic (metalness = 0)
 *   - Specular intensity is low (0.15–0.30) due to micro-roughness
 */
const ArchitecturalGravelPresets = {
    'pea-gravel': {
        color: [0.62, 0.60, 0.56],
        roughness: 0.94,
        metalness: 0.0,
        specularIntensity: 0.20,
        specularColor: [0.75, 0.73, 0.68]
    },
    'crushed-stone': {
        color: [0.48, 0.48, 0.50],
        roughness: 0.96,
        metalness: 0.0,
        specularIntensity: 0.18,
        specularColor: [0.68, 0.68, 0.70]
    },
    'river-rock': {
        color: [0.58, 0.52, 0.44],
        roughness: 0.80,
        metalness: 0.0,
        specularIntensity: 0.30,
        specularColor: [0.78, 0.72, 0.62]
    },
    'exposed-aggregate': {
        color: [0.66, 0.62, 0.56],
        roughness: 0.90,
        metalness: 0.0,
        specularIntensity: 0.22,
        specularColor: [0.78, 0.74, 0.68]
    },
    'white-gravel': {
        color: [0.88, 0.86, 0.82],
        roughness: 0.92,
        metalness: 0.0,
        specularIntensity: 0.24,
        specularColor: [0.92, 0.90, 0.86]
    },
    'black-basalt': {
        color: [0.22, 0.22, 0.24],
        roughness: 0.88,
        metalness: 0.0,
        specularIntensity: 0.28,
        specularColor: [0.55, 0.55, 0.58]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable gravel scratch records
// ---------------------------------------------------------------------------

class GravelScratchPool {
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

const _gravelScratchPool = new GravelScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — gravel-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded aggregate highlights. Gravel has high-frequency per-stone
 * shading — quantizing it into discrete bands produces the crisp anime
 * aggregate edges seen in hand-drawn architectural landscapes.
 */
function applyGravelCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to gravel. Warm moods tint gravel toward warm
 * tan/beige, cool moods toward cool grey-blue — matching the atmospheric
 * aggregate tinting seen in architectural anime backgrounds.
 */
function gradeGravelColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.04;
    b -= temperature * 0.04;

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
 * Generate a procedural gravel/aggregate texture. The algorithm:
 * 1. Divide the UV into a jittered Voronoi cell grid.
 * 2. For each pixel, evaluate the F1 distance to the nearest seed and the
 *    F2 distance to the second-nearest seed — the F2-F1 difference produces
 *    the classic stone-edge cell borders.
 * 3. Use a per-stone hash to derive colour variance and per-stone shading
 *    (each stone is slightly brighter/darker than its neighbours).
 * 4. Apply a smooth edge profile to simulate rounded or angular stone shape.
 * 5. Add a fine simplex-noise grain for micro-surface roughness.
 * The output is a grayscale height/colour map suitable for albedo,
 * roughness, or bump-map use.
 */
function generateGravelPatternTexture(width, height, cellsX = 24, cellsY = 24, jitter = 0.85, edgeSharpness = 4.0, colorVariance = 0.18, grainStrength = 0.05) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Normalized UV scaled to cell grid
            const vx = (x / width) * cellsX;
            const vy = (y / height) * cellsY;

            const cellX = Math.floor(vx);
            const cellY = Math.floor(vy);

            // F1 / F2 Voronoi
            let f1 = 1e9;
            let f2 = 1e9;
            let f1Id = 0;

            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    const nx = cellX + ox;
                    const ny = cellY + oy;

                    // Per-cell hash for jittered seed position
                    const h1 = Math.sin(nx * 127.1 + ny * 311.7) * 43758.5453;
                    const h2 = Math.sin(nx * 269.5 + ny * 183.3) * 43758.5453;
                    const jx = (h1 - Math.floor(h1)) * jitter;
                    const jy = (h2 - Math.floor(h2)) * jitter;

                    const dx = vx - (nx + jx);
                    const dy = vy - (ny + jy);
                    const d = Math.sqrt(dx * dx + dy * dy);

                    if (d < f1) {
                        f2 = f1;
                        f1 = d;
                        f1Id = nx * 73856093 ^ ny * 19349663;
                    } else if (d < f2) {
                        f2 = d;
                    }
                }
            }

            // Cell-border profile: F2-F1 is 0 at borders, large at centres
            const cellDist = f2 - f1;
            const cellProfile = Math.pow(Math.max(0, Math.min(1, cellDist)), 1.0 / edgeSharpness);

            // Per-stone colour hash
            const stoneHash = Math.abs(Math.sin(f1Id * 12.9898) * 43758.5453) % 1.0;
            const stoneTint = 1.0 - colorVariance * 0.5 + stoneHash * colorVariance;

            // Per-stone shading: brighter near the stone centre
            const stoneShade = 0.55 + cellProfile * 0.45;

            // Fine micro-grain
            const grain = SimplexNoise.noise2D(x * 0.6, y * 0.6) * grainStrength;

            // Combine
            let value = stoneShade * stoneTint + grain;
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

const _gravelWorld = BitECS.createWorld();
const ArchitecturalGravelMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    gravelBands: 'ui8',
    gravelQuantize: 'f64',
    gravelSoftness: 'f64',
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

class ArchitecturalGravelMaterialBatch {
    constructor() {
        this.world = _gravelWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalGravelMaterialComponent, eid);
        ArchitecturalGravelMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalGravelMaterialComponent.gravelBands[eid] = material.gravelBands;
        ArchitecturalGravelMaterialComponent.gravelQuantize[eid] = material.gravelQuantize;
        ArchitecturalGravelMaterialComponent.gravelSoftness[eid] = material.gravelSoftness;
        ArchitecturalGravelMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalGravelMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalGravelMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalGravelMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalGravelMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalGravelMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalGravelMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalGravelMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalGravelMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalGravelMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.gravelBands = ArchitecturalGravelMaterialComponent.gravelBands[eid];
            material.gravelQuantize = ArchitecturalGravelMaterialComponent.gravelQuantize[eid];
            material.gravelSoftness = ArchitecturalGravelMaterialComponent.gravelSoftness[eid];
            material.moodTemperature = ArchitecturalGravelMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalGravelMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalGravelMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalGravelMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalGravelMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalGravelMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalGravelMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalGravelMaterialComponent.variationSeed[eid];

            ArchitecturalGravelMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalGravelMaterial class
// ---------------------------------------------------------------------------

class ArchitecturalGravelMaterial extends MeshPhysicalMaterial {
    static {
        _gravelScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isArchitecturalGravelMaterial = true;
        this.type = 'ArchitecturalGravelMaterial';

        // -------------------------------------------------------------------
        // Gravel-specific PBR defaults (pea gravel baseline)
        // -------------------------------------------------------------------
        this.ior = 1.5;
        this.specularIntensity = 0.20;
        this.roughness = 0.94;
        this.metalness = 0.0;
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;
        this.specularColor = new Color(0.75, 0.73, 0.68);
        this.color = new Color(0.62, 0.60, 0.56);
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;
        this.transmission = 0.0;
        this.thickness = 0.0;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        // -------------------------------------------------------------------
        // Anime rendering extensions — gravel-specific
        // -------------------------------------------------------------------
        this.gravelBands = 2;
        this.gravelQuantize = 0.5;
        this.gravelSoftness = 0.2;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.08;
        this.rimGlowColor = new Color(0.85, 0.82, 0.78);
        this.paperGrain = 0;
        this.watercolorBleed = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (gravel leans semi-realistic)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.30;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    applyGravelBanding(baseColor, output) {
        return applyGravelCelBanding(
            baseColor,
            output,
            this.gravelBands,
            this.gravelQuantize,
            this.gravelSoftness
        );
    }

    updateMoodColor() {
        gradeGravelColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural gravel preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalGravelPresets`.
     * @returns {ArchitecturalGravelMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalGravelPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness — smaller stones = crisper bands
        if (presetName === 'pea-gravel' || presetName === 'crushed-stone') {
            this.gravelSoftness = 0.12;
            this.gravelBands = 2;
        } else if (presetName === 'river-rock') {
            this.gravelSoftness = 0.28;
            this.gravelBands = 3;
        } else {
            this.gravelSoftness = 0.20;
            this.gravelBands = 2;
        }

        this.updateMoodColor();
        return this;
    }

    generateGravelPatternTexture(width, height, cellsX = 24, cellsY = 24, jitter = 0.85, edgeSharpness = 4.0) {
        return generateGravelPatternTexture(width, height, cellsX, cellsY, jitter, edgeSharpness, 0.18, 0.05);
    }

    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.gravelBands = { value: this.gravelBands };
        shader.uniforms.gravelQuantize = { value: this.gravelQuantize };
        shader.uniforms.gravelSoftness = { value: this.gravelSoftness };
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
                uniform int gravelBands;
                uniform float gravelQuantize;
                uniform float gravelSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyGravelBands(vec3 baseColor) {
                    if (gravelBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(gravelBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * gravelSoftness;
                    float finalLum = mix(lum, softQuantized, gravelQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply gravel cel banding
                gl_FragColor.rgb = applyGravelBands(gl_FragColor.rgb);

                // Warm-neutral rim glow on gravel edges
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
            this.gravelBands, this.gravelQuantize, this.gravelSoftness,
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
        this.specularColor.copy(source.specularColor);
        this.gravelBands = source.gravelBands;
        this.gravelQuantize = source.gravelQuantize;
        this.gravelSoftness = source.gravelSoftness;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'ArchitecturalGravelMaterial';
        if (this.ior !== 1.5) data.ior = this.ior;
        if (this.specularIntensity !== 0.20) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.94) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.specularColor.getHex() !== new Color(0.75, 0.73, 0.68).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.gravelBands !== 2) data.gravelBands = this.gravelBands;
        if (this.gravelQuantize !== 0.5) data.gravelQuantize = this.gravelQuantize;
        if (this.gravelSoftness !== 0.2) data.gravelSoftness = this.gravelSoftness;
        if (this.rimGlow !== 0.08) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.82, 0.78).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.ior = json.ior ?? this.ior;
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        this.roughness = json.roughness ?? this.roughness;
        this.metalness = json.metalness ?? this.metalness;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);
        this.gravelBands = json.gravelBands ?? this.gravelBands;
        this.gravelQuantize = json.gravelQuantize ?? this.gravelQuantize;
        this.gravelSoftness = json.gravelSoftness ?? this.gravelSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const ArchitecturalGravelMaterialBatchComponent = {
    materialPtr: 'ui32',
    gravelBands: 'ui8',
    gravelQuantize: 'f64',
    gravelSoftness: 'f64',
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
    ArchitecturalGravelMaterial,
    ArchitecturalGravelMaterialBatch,
    GravelScratchPool,
    ArchitecturalGravelMaterialBatchComponent,
    ArchitecturalGravelPresets,
    applyGravelCelBanding,
    gradeGravelColor,
    generateGravelPatternTexture
};

export default ArchitecturalGravelMaterial;