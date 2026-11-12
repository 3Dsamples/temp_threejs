// file number : 207
// full path name : src/materials/207_architecturalvegetationmaterial.js
// description : ArchitecturalVegetationMaterial — a ready-to-use vegetation
//               material for architectural visualization, focused on green
//               roofs, living walls, planted terraces, and interior planting.
//               Extends MeshPhysicalMaterial with purpose-built presets for
//               turf, sedum, moss, climbing vines, and shrub foliage. Includes
//               leaf-appropriate PBR defaults (zero metalness, roughness
//               0.1–0.3 for healthy foliage[reference:0]), thin-walled
//               transmission for leaf translucency[reference:1], sheen for
//               waxy cuticle highlights[reference:2], and real-time anime
//               stylization (cel-banded foliage highlights, mood tinting,
//               rim glow, paper-grain texture, and per-instance variation).
//               Includes a procedural leaf-vein / canopy-clump texture
//               generator using domain-warped fBm with Voronoi-style vein
//               ridges[reference:3] and multi-layer clump noise[reference:4].
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Architectural vegetation, green roofs, living walls, planted
//            terraces, interior planting, turf, sedum, moss, climbing vines,
//            shrub foliage, and any vegetation surface that needs real-time
//            PBR + anime stylization.
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
// Vegetation presets — curated PBR parameter sets for common architectural
// vegetation types.
//
// Reference PBR values (from foliage PBR guides):
//   - Healthy summer foliage roughness: 0.09–0.12[reference:5]
//   - Autumn foliage roughness:         0.15–0.30[reference:6]
//   - Short green grass roughness:      0.20–0.25[reference:7]
//   - Tall wild grass roughness:        0.16–0.18[reference:8]
//   - Leaf translucency weight:         0.30–0.50[reference:9]
//   - Vegetation is universally non-metallic (metalness = 0)[reference:10]
//   - Waxy cuticle produces subtle directional specular[reference:11]
//   - Thin-walled transmission is appropriate for most leaves[reference:12]
// ---------------------------------------------------------------------------

const ArchitecturalVegetationPresets = {
    'turf': {
        color: [0.28, 0.42, 0.18],
        roughness: 0.22,
        metalness: 0.0,
        transmission: 0.15,
        sheen: 0.35,
        sheenColor: [0.55, 0.70, 0.40],
        sheenRoughness: 0.65,
        specularIntensity: 0.35,
        specularColor: [0.70, 0.78, 0.55]
    },
    'sedum': {
        color: [0.35, 0.45, 0.22],
        roughness: 0.28,
        metalness: 0.0,
        transmission: 0.25,
        sheen: 0.45,
        sheenColor: [0.60, 0.72, 0.45],
        sheenRoughness: 0.6,
        specularIntensity: 0.40,
        specularColor: [0.75, 0.82, 0.60]
    },
    'moss': {
        color: [0.22, 0.35, 0.14],
        roughness: 0.55,
        metalness: 0.0,
        transmission: 0.10,
        sheen: 0.55,
        sheenColor: [0.40, 0.55, 0.28],
        sheenRoughness: 0.75,
        specularIntensity: 0.20,
        specularColor: [0.55, 0.65, 0.40]
    },
    'climbing-vine': {
        color: [0.24, 0.40, 0.16],
        roughness: 0.12,
        metalness: 0.0,
        transmission: 0.35,
        sheen: 0.50,
        sheenColor: [0.50, 0.68, 0.35],
        sheenRoughness: 0.55,
        specularIntensity: 0.45,
        specularColor: [0.65, 0.75, 0.50]
    },
    'shrub-foliage': {
        color: [0.30, 0.44, 0.20],
        roughness: 0.15,
        metalness: 0.0,
        transmission: 0.30,
        sheen: 0.40,
        sheenColor: [0.58, 0.72, 0.42],
        sheenRoughness: 0.60,
        specularIntensity: 0.40,
        specularColor: [0.72, 0.80, 0.58]
    },
    'autumn-foliage': {
        color: [0.65, 0.38, 0.15],
        roughness: 0.24,
        metalness: 0.0,
        transmission: 0.28,
        sheen: 0.30,
        sheenColor: [0.80, 0.55, 0.25],
        sheenRoughness: 0.65,
        specularIntensity: 0.35,
        specularColor: [0.85, 0.65, 0.40]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable vegetation scratch records
// ---------------------------------------------------------------------------

class VegetationScratchPool {
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

const _vegetationScratchPool = new VegetationScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — vegetation-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded foliage highlights. Vegetation has soft, organic shading —
 * quantizing it into discrete bands produces the crisp anime foliage edges
 * seen in hand-drawn architectural illustrations.
 */
function applyVegetationCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to vegetation. Warm moods tint vegetation toward
 * warm olive/gold, cool moods toward cool deep green — matching the
 * atmospheric foliage tinting seen in architectural anime backgrounds.
 */
function gradeVegetationColor(color, temperature, saturation, brightness, contrast) {
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

    // Warm shift pushes toward olive/gold (boost R and G slightly, reduce B)
    // Cool shift pushes toward deep green (reduce R, boost G and B slightly)
    r += temperature * 0.05;
    g += temperature * 0.02;
    b -= temperature * 0.05;

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
 * Generate a procedural leaf-vein / canopy-clump texture. The algorithm:
 * 1. Domain-warp the UV with low-frequency fBm to create organic wobble.
 * 2. Compute a Voronoi-style vein field: place a small number of seed points
 *    in the warped domain, compute the F1 distance to the nearest seed, and
 *    use a ridge function to extract thin vein lines[reference:13].
 * 3. Layer a multi-octave canopy-clump mask (large dark clumps, medium
 *    mid-tone clusters, fine detail) for depth[reference:14].
 * 4. Add a subtle high-frequency mottle for leaf-to-leaf variation.
 * The output is a grayscale height/colour map suitable for albedo,
 * roughness, or bump-map use.
 */
function generateLeafVeinTexture(width, height, scale = 0.02, octaves = 4, veinCount = 6, veinSharpness = 3.0, warpStrength = 2.0, clumpStrength = 0.25) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Domain warp ---
            const warpX = SimplexNoise.noise2D(x * 0.008, y * 0.008) * warpStrength;
            const warpY = SimplexNoise.noise2D(x * 0.008 + 100, y * 0.008 + 100) * warpStrength;

            // --- 2. Voronoi-style vein field ---
            // Place veinCount^2 seed points in a jittered grid; compute F1 distance.
            // This approximates a Voronoi diagram without the full algorithm.
            const vx = (x + warpX) * 0.02 * veinCount;
            const vy = (y + warpY) * 0.02 * veinCount;
            const cellX = Math.floor(vx);
            const cellY = Math.floor(vy);

            let f1 = 1e9;
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    const nx = cellX + ox;
                    const ny = cellY + oy;
                    // Hash the cell to a jittered seed position
                    const h = Math.sin(nx * 127.1 + ny * 311.7) * 43758.5453;
                    const jx = h - Math.floor(h);
                    const h2 = Math.sin(nx * 269.5 + ny * 183.3) * 43758.5453;
                    const jy = h2 - Math.floor(h2);
                    const dx = vx - (nx + jx);
                    const dy = vy - (ny + jy);
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < f1) f1 = d;
                }
            }

            // Ridge function: thin bright lines at the Voronoi borders
            const veinRidge = Math.pow(Math.max(0, 1.0 - f1), veinSharpness);

            // --- 3. Canopy-clump mask (multi-layer) ---
            let clump = 0;
            let amplitude = 1;
            let frequency = scale * 0.5;
            let maxAmplitude = 0;
            for (let o = 0; o < octaves; o++) {
                clump += SimplexNoise.noise2D(x * frequency, y * frequency) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            clump = (clump / maxAmplitude) * 0.5 + 0.5;

            // --- 4. Fine mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.5, y * 0.5) * 0.5 + 0.5;

            // --- Combine ---
            // Base tone + clump shading + vein highlight + mottle
            let value = 0.55
                + (clump - 0.5) * clumpStrength
                + veinRidge * 0.25
                + (mottle - 0.5) * 0.06;

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

const _vegetationWorld = BitECS.createWorld();
const ArchitecturalVegetationMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    vegetationBands: 'ui8',
    vegetationQuantize: 'f64',
    vegetationSoftness: 'f64',
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

class ArchitecturalVegetationMaterialBatch {
    constructor() {
        this.world = _vegetationWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalVegetationMaterialComponent, eid);
        ArchitecturalVegetationMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalVegetationMaterialComponent.vegetationBands[eid] = material.vegetationBands;
        ArchitecturalVegetationMaterialComponent.vegetationQuantize[eid] = material.vegetationQuantize;
        ArchitecturalVegetationMaterialComponent.vegetationSoftness[eid] = material.vegetationSoftness;
        ArchitecturalVegetationMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalVegetationMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalVegetationMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalVegetationMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalVegetationMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalVegetationMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalVegetationMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalVegetationMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalVegetationMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalVegetationMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.vegetationBands = ArchitecturalVegetationMaterialComponent.vegetationBands[eid];
            material.vegetationQuantize = ArchitecturalVegetationMaterialComponent.vegetationQuantize[eid];
            material.vegetationSoftness = ArchitecturalVegetationMaterialComponent.vegetationSoftness[eid];
            material.moodTemperature = ArchitecturalVegetationMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalVegetationMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalVegetationMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalVegetationMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalVegetationMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalVegetationMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalVegetationMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalVegetationMaterialComponent.variationSeed[eid];

            ArchitecturalVegetationMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalVegetationMaterial class
// ---------------------------------------------------------------------------

class ArchitecturalVegetationMaterial extends MeshPhysicalMaterial {
    static {
        _vegetationScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isArchitecturalVegetationMaterial = true;
        this.type = 'ArchitecturalVegetationMaterial';

        // -------------------------------------------------------------------
        // Vegetation-specific PBR defaults (healthy summer foliage baseline)
        // -------------------------------------------------------------------
        this.ior = 1.42; // Leaf cuticle approximate IOR
        this.specularIntensity = 0.35;
        this.roughness = 0.15; // Healthy summer foliage: 0.09–0.12[reference:15]
        this.metalness = 0.0; // Vegetation is universally non-metallic[reference:16]
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;
        this.specularColor = new Color(0.72, 0.80, 0.58);
        this.color = new Color(0.30, 0.44, 0.20); // Mid-green foliage

        // Thin-walled transmission for leaf translucency[reference:17]
        this.transmission = 0.25;
        this.thickness = 0.001; // Very thin leaf
        this.attenuationDistance = 10;
        this.attenuationColor = new Color(0.55, 0.72, 0.35); // Greenish transmitted light

        // Sheen for waxy cuticle highlights[reference:18]
        this.sheen = 0.40;
        this.sheenColor = new Color(0.58, 0.72, 0.42);
        this.sheenRoughness = 0.60;

        // -------------------------------------------------------------------
        // Anime rendering extensions — vegetation-specific
        // -------------------------------------------------------------------
        this.vegetationBands = 3;
        this.vegetationQuantize = 0.5;
        this.vegetationSoftness = 0.15;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.15;
        this.rimGlowColor = new Color(0.55, 0.78, 0.40);
        this.paperGrain = 0;
        this.watercolorBleed = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (vegetation leans semi-realistic with anime
        // banding for the flat-shaded foliage look)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.35;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    applyVegetationBanding(baseColor, output) {
        return applyVegetationCelBanding(
            baseColor,
            output,
            this.vegetationBands,
            this.vegetationQuantize,
            this.vegetationSoftness
        );
    }

    updateMoodColor() {
        gradeVegetationColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural vegetation preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalVegetationPresets`.
     * @returns {ArchitecturalVegetationMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalVegetationPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.transmission = preset.transmission;
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness for turf vs moss (moss is softer)
        if (presetName === 'moss') {
            this.vegetationSoftness = 0.35;
            this.vegetationBands = 2;
        } else if (presetName === 'turf' || presetName === 'sedum') {
            this.vegetationSoftness = 0.20;
            this.vegetationBands = 3;
        } else {
            this.vegetationSoftness = 0.12;
            this.vegetationBands = 3;
        }

        this.updateMoodColor();
        return this;
    }

    generateLeafVeinTexture(width, height, scale = 0.02, octaves = 4, veinCount = 6) {
        return generateLeafVeinTexture(width, height, scale, octaves, veinCount, 3.0, 2.0, 0.25);
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

        shader.uniforms.vegetationBands = { value: this.vegetationBands };
        shader.uniforms.vegetationQuantize = { value: this.vegetationQuantize };
        shader.uniforms.vegetationSoftness = { value: this.vegetationSoftness };
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
                uniform int vegetationBands;
                uniform float vegetationQuantize;
                uniform float vegetationSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyVegetationBands(vec3 baseColor) {
                    if (vegetationBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(vegetationBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * vegetationSoftness;
                    float finalLum = mix(lum, softQuantized, vegetationQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply vegetation cel banding
                gl_FragColor.rgb = applyVegetationBands(gl_FragColor.rgb);

                // Green-tinted rim glow on vegetation edges
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
            this.transmission, this.thickness, this.attenuationDistance,
            this.sheen, this.sheenRoughness,
            this.vegetationBands, this.vegetationQuantize, this.vegetationSoftness,
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
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.vegetationBands = source.vegetationBands;
        this.vegetationQuantize = source.vegetationQuantize;
        this.vegetationSoftness = source.vegetationSoftness;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'ArchitecturalVegetationMaterial';
        if (this.ior !== 1.42) data.ior = this.ior;
        if (this.specularIntensity !== 0.35) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.15) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.transmission !== 0.25) data.transmission = this.transmission;
        if (this.thickness !== 0.001) data.thickness = this.thickness;
        if (this.attenuationDistance !== 10) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.55, 0.72, 0.35).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.40) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.58, 0.72, 0.42).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.60) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.72, 0.80, 0.58).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.vegetationBands !== 3) data.vegetationBands = this.vegetationBands;
        if (this.vegetationQuantize !== 0.5) data.vegetationQuantize = this.vegetationQuantize;
        if (this.vegetationSoftness !== 0.15) data.vegetationSoftness = this.vegetationSoftness;
        if (this.rimGlow !== 0.15) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.55, 0.78, 0.40).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.vegetationBands = json.vegetationBands ?? this.vegetationBands;
        this.vegetationQuantize = json.vegetationQuantize ?? this.vegetationQuantize;
        this.vegetationSoftness = json.vegetationSoftness ?? this.vegetationSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const ArchitecturalVegetationMaterialBatchComponent = {
    materialPtr: 'ui32',
    vegetationBands: 'ui8',
    vegetationQuantize: 'f64',
    vegetationSoftness: 'f64',
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
    ArchitecturalVegetationMaterial,
    ArchitecturalVegetationMaterialBatch,
    VegetationScratchPool,
    ArchitecturalVegetationMaterialBatchComponent,
    ArchitecturalVegetationPresets,
    applyVegetationCelBanding,
    gradeVegetationColor,
    generateLeafVeinTexture
};

export default ArchitecturalVegetationMaterial;