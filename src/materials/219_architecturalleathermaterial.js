// file number : 219
// full path name : src/materials/219_architecturalleathermaterial.js
// description : ArchitecturalLeatherMaterial — a ready-to-use leather material
//               for architectural visualization. Extends MeshPhysicalMaterial
//               with purpose-built presets for black leather, brown leather,
//               tan leather, oxblood leather, distressed leather, and patent
//               leather (used for upholstery, wall panels, reception counters,
//               seating, and acoustic wall coverings). Includes biologically
//               grounded defaults (IOR ≈ 1.50, roughness 0.30–0.70 for
//               natural-to-polished leather, near-zero metalness, sheen for
//               the waxy surface, clearcoat for patent finishes) plus real-
//               time anime stylization: cel-banded leather highlights, pebble-
//               grain approximation, mood tinting, rim glow, and per-instance
//               variation. Includes a procedural leather-grain texture
//               generator using multi-octave fBm with Voronoi-style pebble
//               cells and directional wrinkle streaks.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Architectural leather, upholstery, wall panels, reception
//            counters, seating, acoustic wall coverings, headboards, booth
//            seating, executive interiors, and any leather surface that needs
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

// ---------------------------------------------------------------------------
// Leather presets — biologically grounded PBR parameter sets for leather types.
//
// Reference values (from architectural leather/faux leather PBR guides and
// upholstery references):
//   - Leather IOR:              ≈ 1.50
//   - Natural leather roughness: 0.55–0.70
//   - Polished leather roughness: 0.35–0.50
//   - Patent leather:           0.05–0.15 (with clearcoat 1.0)
//   - Metalness:                0.0 (leather is a dielectric)
//   - Sheen:                    subtle for aniline, stronger for suede
//   - Clearcoat:                0 for matte, 1.0 for patent
// ---------------------------------------------------------------------------

const ArchitecturalLeatherPresets = {
    'black-leather': {
        color: [0.06, 0.05, 0.05],
        roughness: 0.55,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.45,
        sheen: 0.30,
        sheenColor: [0.22, 0.20, 0.18],
        sheenRoughness: 0.55,
        specularIntensity: 0.35,
        specularColor: [0.55, 0.52, 0.50]
    },
    'brown-leather': {
        color: [0.32, 0.18, 0.10],
        roughness: 0.58,
        metalness: 0.0,
        clearcoat: 0.08,
        clearcoatRoughness: 0.48,
        sheen: 0.32,
        sheenColor: [0.55, 0.38, 0.24],
        sheenRoughness: 0.55,
        specularIntensity: 0.38,
        specularColor: [0.68, 0.55, 0.42]
    },
    'tan-leather': {
        color: [0.72, 0.48, 0.28],
        roughness: 0.60,
        metalness: 0.0,
        clearcoat: 0.06,
        clearcoatRoughness: 0.50,
        sheen: 0.35,
        sheenColor: [0.85, 0.65, 0.45],
        sheenRoughness: 0.60,
        specularIntensity: 0.40,
        specularColor: [0.85, 0.72, 0.55]
    },
    'oxblood-leather': {
        color: [0.42, 0.10, 0.10],
        roughness: 0.52,
        metalness: 0.0,
        clearcoat: 0.12,
        clearcoatRoughness: 0.40,
        sheen: 0.30,
        sheenColor: [0.65, 0.22, 0.20],
        sheenRoughness: 0.55,
        specularIntensity: 0.42,
        specularColor: [0.78, 0.45, 0.40]
    },
    'distressed-leather': {
        color: [0.52, 0.38, 0.28],
        roughness: 0.72,
        metalness: 0.0,
        clearcoat: 0.02,
        clearcoatRoughness: 0.65,
        sheen: 0.42,
        sheenColor: [0.72, 0.58, 0.45],
        sheenRoughness: 0.70,
        specularIntensity: 0.28,
        specularColor: [0.65, 0.55, 0.45]
    },
    'patent-leather': {
        color: [0.04, 0.04, 0.05],
        roughness: 0.08,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        sheen: 0.05,
        sheenColor: [0.25, 0.25, 0.28],
        sheenRoughness: 0.30,
        specularIntensity: 0.75,
        specularColor: [0.95, 0.95, 1.00]
    },
    'cream-leather': {
        color: [0.88, 0.82, 0.72],
        roughness: 0.58,
        metalness: 0.0,
        clearcoat: 0.06,
        clearcoatRoughness: 0.48,
        sheen: 0.28,
        sheenColor: [0.95, 0.90, 0.82],
        sheenRoughness: 0.55,
        specularIntensity: 0.36,
        specularColor: [0.92, 0.88, 0.82]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable leather scratch records
// ---------------------------------------------------------------------------

class LeatherScratchPool {
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

const _leatherScratchPool = new LeatherScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — leather-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded leather highlights. Leather has soft waxy shading with
 * subtle pebble-grain specular — quantizing it into discrete bands produces
 * the crisp anime leather edges seen in hand-drawn interior scenes.
 */
function applyLeatherCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to leather. Warm moods push leather toward warm
 * cognac/amber, cool moods toward cool charcoal-black — matching the
 * atmospheric leather tinting seen in interior anime scenes.
 */
function gradeLeatherColor(color, temperature, saturation, brightness, contrast) {
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

    // Leather-specific temperature bias: warm shift pushes toward cognac,
    // cool shift pushes toward charcoal.
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
 * Generate a procedural leather-grain texture. The algorithm:
 * 1. Voronoi-style pebble cells: jittered seeds in a 3x3 neighbourhood,
 *    F1 distance used to extract the pebbled grain pattern.
 * 2. Multi-octave fBm for the large-scale blotch (uneven tanning).
 * 3. Directional wrinkle streaks (stretched noise) for creases.
 * 4. Per-pebble hashing for subtle colour variation.
 * 5. Fine mottle for surface pores.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * normal-map, or bump-map use.
 */
function generateLeatherGrainTexture(width, height, pebbleCells = 22, pebbleSharpness = 2.5, grainStrength = 0.30, wrinkleStrength = 0.15, mottleStrength = 0.08) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Voronoi pebble cells ---
            const vx = (x / width) * pebbleCells;
            const vy = (y / height) * pebbleCells;
            const cellX = Math.floor(vx);
            const cellY = Math.floor(vy);

            let f1 = 1e9;
            let f1Id = 0;

            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    const nx = cellX + ox;
                    const ny = cellY + oy;
                    const h1 = Math.sin(nx * 127.1 + ny * 311.7) * 43758.5453;
                    const h2 = Math.sin(nx * 269.5 + ny * 183.3) * 43758.5453;
                    const jx = h1 - Math.floor(h1);
                    const jy = h2 - Math.floor(h2);
                    const dx = vx - (nx + jx);
                    const dy = vy - (ny + jy);
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < f1) {
                        f1 = d;
                        f1Id = nx * 73856093 ^ ny * 19349663;
                    }
                }
            }

            // Pebble ridge profile
            const pebble = Math.pow(Math.max(0, 1.0 - f1), pebbleSharpness);

            // Per-pebble hashing
            const pebbleHash = Math.abs(Math.sin(f1Id * 12.9898) * 43758.5453) % 1.0;
            const pebbleTint = 0.9 + pebbleHash * 0.1;

            // --- 2. Large-scale blotch (uneven tanning) ---
            const blotch = SimplexNoise.noise2D(x * 0.005, y * 0.005) * 0.5 + 0.5;

            // --- 3. Directional wrinkles ---
            const wrinkle = SimplexNoise.noise2D(x * 0.02, y * 0.15) * 0.5 + 0.5;
            const wrinkleValue = (wrinkle - 0.5) * wrinkleStrength;

            // --- 4. Fine mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.8, y * 0.8) * mottleStrength;

            // --- Combine ---
            let value = 0.45
                + pebble * grainStrength * pebbleTint
                + (blotch - 0.5) * 0.15
                + wrinkleValue
                + mottle;

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

const _leatherWorld = BitECS.createWorld();
const ArchitecturalLeatherMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    leatherBands: 'ui8',
    leatherQuantize: 'f64',
    leatherSoftness: 'f64',
    grainStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class ArchitecturalLeatherMaterialBatch {
    constructor() {
        this.world = _leatherWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalLeatherMaterialComponent, eid);
        ArchitecturalLeatherMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalLeatherMaterialComponent.leatherBands[eid] = material.leatherBands;
        ArchitecturalLeatherMaterialComponent.leatherQuantize[eid] = material.leatherQuantize;
        ArchitecturalLeatherMaterialComponent.leatherSoftness[eid] = material.leatherSoftness;
        ArchitecturalLeatherMaterialComponent.grainStrength[eid] = material.grainStrength;
        ArchitecturalLeatherMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalLeatherMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalLeatherMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalLeatherMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalLeatherMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalLeatherMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalLeatherMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalLeatherMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalLeatherMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.leatherBands = ArchitecturalLeatherMaterialComponent.leatherBands[eid];
            material.leatherQuantize = ArchitecturalLeatherMaterialComponent.leatherQuantize[eid];
            material.leatherSoftness = ArchitecturalLeatherMaterialComponent.leatherSoftness[eid];
            material.grainStrength = ArchitecturalLeatherMaterialComponent.grainStrength[eid];
            material.moodTemperature = ArchitecturalLeatherMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalLeatherMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalLeatherMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalLeatherMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalLeatherMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalLeatherMaterialComponent.paperGrain[eid];
            material.variationSeed = ArchitecturalLeatherMaterialComponent.variationSeed[eid];

            ArchitecturalLeatherMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalLeatherMaterial class
// ---------------------------------------------------------------------------

class ArchitecturalLeatherMaterial extends MeshPhysicalMaterial {
    static {
        _leatherScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isArchitecturalLeatherMaterial = true;
        this.type = 'ArchitecturalLeatherMaterial';

        // -------------------------------------------------------------------
        // Leather-specific PBR defaults (brown leather baseline)
        // -------------------------------------------------------------------
        this.ior = 1.50;
        this.specularIntensity = 0.38;
        this.roughness = 0.58;
        this.metalness = 0.0;
        this.specularColor = new Color(0.68, 0.55, 0.42);
        this.color = new Color(0.32, 0.18, 0.10);

        // Clearcoat for leather polish
        this.clearcoat = 0.08;
        this.clearcoatRoughness = 0.48;

        // Sheen for waxy leather surface
        this.sheen = 0.32;
        this.sheenColor = new Color(0.55, 0.38, 0.24);
        this.sheenRoughness = 0.55;

        // No transmission for standard leather
        this.transmission = 0.0;
        this.thickness = 0.002;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        // -------------------------------------------------------------------
        // Anime rendering extensions — leather-specific
        // -------------------------------------------------------------------
        this.leatherBands = 3;
        this.leatherQuantize = 0.4;
        this.leatherSoftness = 0.15;
        this.grainStrength = 0.30;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.85, 0.65, 0.45);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (leather leans semi-realistic)
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

    applyLeatherBanding(baseColor, output) {
        return applyLeatherCelBanding(
            baseColor,
            output,
            this.leatherBands,
            this.leatherQuantize,
            this.leatherSoftness
        );
    }

    updateMoodColor() {
        gradeLeatherColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural leather preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalLeatherPresets`.
     * @returns {ArchitecturalLeatherMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalLeatherPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness per preset
        if (presetName === 'patent-leather') {
            this.leatherSoftness = 0.05;
            this.leatherBands = 4;
        } else if (presetName === 'distressed-leather') {
            this.leatherSoftness = 0.30;
            this.leatherBands = 2;
        } else {
            this.leatherSoftness = 0.15;
            this.leatherBands = 3;
        }

        this.updateMoodColor();
        return this;
    }

    generateLeatherGrainTexture(width, height, pebbleCells = 22, pebbleSharpness = 2.5, grainStrength = 0.30) {
        return generateLeatherGrainTexture(width, height, pebbleCells, pebbleSharpness, grainStrength, 0.15, 0.08);
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

        shader.uniforms.leatherBands = { value: this.leatherBands };
        shader.uniforms.leatherQuantize = { value: this.leatherQuantize };
        shader.uniforms.leatherSoftness = { value: this.leatherSoftness };
        shader.uniforms.grainStrength = { value: this.grainStrength };
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
                uniform int leatherBands;
                uniform float leatherQuantize;
                uniform float leatherSoftness;
                uniform float grainStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyLeatherBands(vec3 baseColor) {
                    if (leatherBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(leatherBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * leatherSoftness;
                    float finalLum = mix(lum, softQuantized, leatherQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply leather cel banding
                gl_FragColor.rgb = applyLeatherBands(gl_FragColor.rgb);

                // Pebble-grain approximation: subtle UV-based noise modulation
                if (grainStrength > 0.0) {
                    vec2 pebbleUV = vUv * 22.0;
                    vec2 pebbleCell = floor(pebbleUV);
                    vec2 pebbleFrac = fract(pebbleUV);
                    float pebbleHash = fract(sin(dot(pebbleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    float pebbleMask = smoothstep(0.0, 0.4, 0.5 - length(pebbleFrac - 0.5));
                    float pebbleTint = 0.85 + pebbleHash * 0.15;
                    gl_FragColor.rgb *= mix(1.0, pebbleTint, pebbleMask * grainStrength);
                }

                // Warm rim glow on leather edges
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
            this.clearcoat, this.clearcoatRoughness,
            this.sheen, this.sheenRoughness,
            this.leatherBands, this.leatherQuantize, this.leatherSoftness,
            this.grainStrength,
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
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.leatherBands = source.leatherBands;
        this.leatherQuantize = source.leatherQuantize;
        this.leatherSoftness = source.leatherSoftness;
        this.grainStrength = source.grainStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'ArchitecturalLeatherMaterial';
        if (this.ior !== 1.50) data.ior = this.ior;
        if (this.specularIntensity !== 0.38) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.58) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.08) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.48) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.sheen !== 0.32) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.55, 0.38, 0.24).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.55) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.68, 0.55, 0.42).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.leatherBands !== 3) data.leatherBands = this.leatherBands;
        if (this.leatherQuantize !== 0.4) data.leatherQuantize = this.leatherQuantize;
        if (this.leatherSoftness !== 0.15) data.leatherSoftness = this.leatherSoftness;
        if (this.grainStrength !== 0.30) data.grainStrength = this.grainStrength;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.65, 0.45).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.leatherBands = json.leatherBands ?? this.leatherBands;
        this.leatherQuantize = json.leatherQuantize ?? this.leatherQuantize;
        this.leatherSoftness = json.leatherSoftness ?? this.leatherSoftness;
        this.grainStrength = json.grainStrength ?? this.grainStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const ArchitecturalLeatherMaterialBatchComponent = {
    materialPtr: 'ui32',
    leatherBands: 'ui8',
    leatherQuantize: 'f64',
    leatherSoftness: 'f64',
    grainStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    ArchitecturalLeatherMaterial,
    ArchitecturalLeatherMaterialBatch,
    LeatherScratchPool,
    ArchitecturalLeatherMaterialBatchComponent,
    ArchitecturalLeatherPresets,
    applyLeatherCelBanding,
    gradeLeatherColor,
    generateLeatherGrainTexture
};

export default ArchitecturalLeatherMaterial;