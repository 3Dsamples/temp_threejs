// file number : 245
// full path name : src/materials/245_metalsteelbeammaterial.js
// description : MetalSteelBeamMaterial — a ready-to-use structural-steel beam
//               material for architectural and industrial visualization. Extends
//               MeshPhysicalMaterial with purpose-built presets covering the
//               common structural-steel finishes: hot-rolled carbon steel
//               (mill scale), cold-rolled steel, primed structural steel,
//               painted structural steel (red-oxide primer + topcoat), weathered
//               corten steel, and blackened steel. Includes physically grounded
//               defaults matching published metal PBR references: metalness 1.0
//               for bare steel, base colour near-neutral grey (#A8A8A8 ≈
//               0.66/0.66/0.66 linear), roughness 0.15–0.40 for polished-to-
//               satin steel, brushed anisotropy 0.6–0.8 for rolled/brushed
//               surfaces, and clearcoat only for painted/primed variants.
//               Adds real-time anime stylization: cel-banded steel highlights,
//               mill-scale mottle approximation, scratch-streak approximation,
//               brushed anisotropy mask, metallic edge specular, mood tinting,
//               rim glow, and per-instance variation. Includes a procedural
//               steel-surface texture generator using multi-octave fBm with
//               directional scratch streaks, optional spangle cells, and
//               mill-scale mottle.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Structural steel beams, I-beams, H-beams, columns, girders,
//            trusses, industrial steelwork, architectural steel, corten
//            weathering steel, primed/painted steel, and any steel-beam
//            surface that needs real-time PBR + anime stylization.
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
// Steel-beam presets — physically grounded PBR parameter sets for structural
// steel finishes.
//
// Reference values (from The Ultimate Guide to Creating Photorealistic Steel,
// NormalMap.ai steel texture guide, ArchVizDaily metal shader breakdown, and
// 3DTexel galvanized-steel PBR measurements):
//   - Bare steel metalness:            1.0 (pure conductor)
//   - Bare steel base colour:          dark-grey ~#A8A8A8 to #C8C9CB (linear
//                                      0.66–0.78); steel has no chroma tint
//   - Polished steel roughness:        0.05–0.15
//   - Satin / brushed steel roughness: 0.18–0.35
//   - Hot-rolled carbon steel:         mottled bluish-grey mill scale, roughness
//                                      0.45–0.65
//   - Brushed anisotropy:              0.6–0.8 with rotation aligned to grain
//   - Painted steel:                   metalness 0.0 (dielectric paint layer),
//                                      clearcoat 0.2–0.5, roughness 0.35–0.55
//   - Corten (weathered) steel:        metalness 0.85–0.95 (partly oxidised),
//                                      roughness 0.70–0.90, warm rust-orange
//   - Blackened steel:                 roughness 0.25–0.50 organic blotching
// ---------------------------------------------------------------------------

const MetalSteelBeamPresets = {
    'hot-rolled-carbon-steel': {
        color: [0.36, 0.38, 0.42],
        roughness: 0.55,
        metalness: 1.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        ior: 2.50,
        specularIntensity: 1.0,
        specularColor: [0.72, 0.74, 0.78],
        anisotropy: 0.35,
        anisotropyRotation: 0.0,
        millScaleStrength: 0.45,
        scratchStrength: 0.20,
        spangleStrength: 0.0
    },
    'cold-rolled-steel': {
        color: [0.62, 0.64, 0.66],
        roughness: 0.28,
        metalness: 1.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        ior: 2.50,
        specularIntensity: 1.0,
        specularColor: [0.88, 0.90, 0.92],
        anisotropy: 0.55,
        anisotropyRotation: 0.0,
        millScaleStrength: 0.10,
        scratchStrength: 0.30,
        spangleStrength: 0.0
    },
    'primed-structural-steel': {
        color: [0.68, 0.28, 0.18],
        roughness: 0.62,
        metalness: 0.0,
        clearcoat: 0.20,
        clearcoatRoughness: 0.45,
        ior: 1.50,
        specularIntensity: 0.55,
        specularColor: [0.82, 0.60, 0.52],
        anisotropy: 0.0,
        anisotropyRotation: 0.0,
        millScaleStrength: 0.30,
        scratchStrength: 0.15,
        spangleStrength: 0.0
    },
    'painted-structural-steel': {
        color: [0.42, 0.46, 0.50],
        roughness: 0.48,
        metalness: 0.0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.28,
        ior: 1.50,
        specularIntensity: 0.70,
        specularColor: [0.85, 0.88, 0.90],
        anisotropy: 0.0,
        anisotropyRotation: 0.0,
        millScaleStrength: 0.15,
        scratchStrength: 0.10,
        spangleStrength: 0.0
    },
    'weathered-corten-steel': {
        color: [0.62, 0.32, 0.16],
        roughness: 0.82,
        metalness: 0.85,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        ior: 2.50,
        specularIntensity: 0.75,
        specularColor: [0.80, 0.52, 0.34],
        anisotropy: 0.15,
        anisotropyRotation: 0.0,
        millScaleStrength: 0.60,
        scratchStrength: 0.25,
        spangleStrength: 0.0
    },
    'blackened-steel': {
        color: [0.06, 0.06, 0.07],
        roughness: 0.38,
        metalness: 1.0,
        clearcoat: 0.05,
        clearcoatRoughness: 0.35,
        ior: 2.50,
        specularIntensity: 1.0,
        specularColor: [0.68, 0.68, 0.72],
        anisotropy: 0.40,
        anisotropyRotation: 0.0,
        millScaleStrength: 0.25,
        scratchStrength: 0.35,
        spangleStrength: 0.0
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable steel-beam scratch records
// ---------------------------------------------------------------------------

class MetalSteelBeamScratchPool {
    /**
     * @param {number} [capacity=64] - Initial pool capacity.
     */
    constructor(capacity = 64) {
        /** @type {Object[]} */
        this._free = [];
        for (let i = 0; i < capacity; i++) {
            this._free.push(this._createRecord());
        }
    }

    /**
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Vec3, view: Vec3}}
     */
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

/** @type {MetalSteelBeamScratchPool} */
const _metalSteelBeamScratchPool = new MetalSteelBeamScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — steel-beam-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded steel highlights. Bare steel is a pure conductor, so its
 * "colour" is almost entirely reflection — quantizing the luminance into
 * discrete bands produces the crisp flat anime steel highlight seen in
 * hand-drawn industrial and architectural scenes.
 * @param {Color} baseColor
 * @param {Color} output - Modified in place.
 * @param {number} bands
 * @param {number} quantizeAmount
 * @param {number} [softness=0.06]
 * @returns {Color}
 */
function applySteelCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.06) {
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
 * Apply mood-based tinting to steel. Warm moods push steel toward a warm
 * amber heat-tint, cool moods toward cool bluish steel — matching the
 * atmospheric steel tinting seen in stylized industrial scenes.
 * @param {Color} color - Modified in place.
 * @param {number} temperature
 * @param {number} saturation
 * @param {number} brightness
 * @param {number} contrast
 * @returns {Color}
 */
function gradeSteelColor(color, temperature, saturation, brightness, contrast) {
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

    // Steel-specific temperature bias: warm shift pushes toward amber heat
    // tint; cool shift pushes toward bluish steel.
    r += temperature * 0.030;
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
 * Generate a procedural steel-surface texture. The algorithm:
 * 1. Mill-scale mottle: low-frequency multi-octave fBm producing the
 *    characteristic mottled bluish-grey hot-rolled mill scale.
 * 2. Directional scratch streaks: high-frequency noise stretched along the
 *    rolling grain, producing micro scratches and handling marks.
 * 3. Optional spangle cells: hashed polygonal zinc-crystal cells for
 *    galvanized steel.
 * 4. Fine micro-grain: high-frequency mottle for the finishing texture.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.02]
 * @param {number} [octaves=4]
 * @param {number} [millScaleStrength=0.35]
 * @param {number} [scratchStrength=0.25]
 * @param {number} [scratchDensity=10.0]
 * @param {number} [spangleStrength=0.0]
 * @param {number} [spangleCells=24]
 * @returns {Uint8Array}
 */
function generateSteelSurfaceTexture(width, height, scale = 0.02, octaves = 4, millScaleStrength = 0.35, scratchStrength = 0.25, scratchDensity = 10.0, spangleStrength = 0.0, spangleCells = 24) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Mill-scale mottle (low-frequency fBm) ---
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

            // --- 2. Directional scratch streaks (stretched along X) ---
            const scratch = SimplexNoise.noise2D(x * 0.005 * scratchDensity, y * 0.15 * scratchDensity) * 0.5 + 0.5;
            const scratchMask = Math.pow(1.0 - Math.abs(scratch * 2.0 - 1.0), 3.0) * scratchStrength;

            // --- 3. Optional spangle cells (galvanized) ---
            let spangle = 0;
            if (spangleStrength > 0) {
                const vx = (x / width) * spangleCells;
                const vy = (y / height) * spangleCells;
                const cellX = Math.floor(vx);
                const cellY = Math.floor(vy);
                const cellId = cellX * 73856093 ^ cellY * 19349663;
                const h = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;
                // Soft cell-edge fade
                const fx = vx - cellX;
                const fy = vy - cellY;
                const edge = Math.min(fx, 1 - fx, fy, 1 - fy) * 2.0;
                const cellMask = Math.min(1, edge);
                spangle = (h - 0.5) * cellMask * spangleStrength;
            }

            // --- 4. Fine micro-grain ---
            const grain = SimplexNoise.noise2D(x * 0.7, y * 0.7) * 0.04;

            // --- Combine ---
            let value = 0.55
                + (fbm - 0.5) * millScaleStrength
                - scratchMask * 0.20
                + spangle * 0.30
                + grain;

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

const _metalSteelBeamWorld = BitECS.createWorld();
const MetalSteelBeamMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    steelBands: 'ui8',
    steelQuantize: 'f64',
    steelSoftness: 'f64',
    millScaleStrength: 'f64',
    scratchStrength: 'f64',
    scratchDensity: 'f64',
    spangleStrength: 'f64',
    brushedAnisotropy: 'f64',
    brushedRotation: 'f64',
    edgeSpecularIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class MetalSteelBeamMaterialBatch {
    constructor() {
        this.world = _metalSteelBeamWorld;
        /** @type {MetalSteelBeamMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * @param {MetalSteelBeamMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, MetalSteelBeamMaterialComponent, eid);
        MetalSteelBeamMaterialComponent.materialPtr[eid] = this.materials.length;
        MetalSteelBeamMaterialComponent.steelBands[eid] = material.steelBands;
        MetalSteelBeamMaterialComponent.steelQuantize[eid] = material.steelQuantize;
        MetalSteelBeamMaterialComponent.steelSoftness[eid] = material.steelSoftness;
        MetalSteelBeamMaterialComponent.millScaleStrength[eid] = material.millScaleStrength;
        MetalSteelBeamMaterialComponent.scratchStrength[eid] = material.scratchStrength;
        MetalSteelBeamMaterialComponent.scratchDensity[eid] = material.scratchDensity;
        MetalSteelBeamMaterialComponent.spangleStrength[eid] = material.spangleStrength;
        MetalSteelBeamMaterialComponent.brushedAnisotropy[eid] = material.anisotropy;
        MetalSteelBeamMaterialComponent.brushedRotation[eid] = material.anisotropyRotation;
        MetalSteelBeamMaterialComponent.edgeSpecularIntensity[eid] = material.edgeSpecularIntensity;
        MetalSteelBeamMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        MetalSteelBeamMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        MetalSteelBeamMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        MetalSteelBeamMaterialComponent.moodContrast[eid] = material.moodContrast;
        MetalSteelBeamMaterialComponent.rimGlow[eid] = material.rimGlow;
        MetalSteelBeamMaterialComponent.variationSeed[eid] = material.variationSeed;
        MetalSteelBeamMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MetalSteelBeamMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.steelBands = MetalSteelBeamMaterialComponent.steelBands[eid];
            material.steelQuantize = MetalSteelBeamMaterialComponent.steelQuantize[eid];
            material.steelSoftness = MetalSteelBeamMaterialComponent.steelSoftness[eid];
            material.millScaleStrength = MetalSteelBeamMaterialComponent.millScaleStrength[eid];
            material.scratchStrength = MetalSteelBeamMaterialComponent.scratchStrength[eid];
            material.scratchDensity = MetalSteelBeamMaterialComponent.scratchDensity[eid];
            material.spangleStrength = MetalSteelBeamMaterialComponent.spangleStrength[eid];
            material.anisotropy = MetalSteelBeamMaterialComponent.brushedAnisotropy[eid];
            material.anisotropyRotation = MetalSteelBeamMaterialComponent.brushedRotation[eid];
            material.edgeSpecularIntensity = MetalSteelBeamMaterialComponent.edgeSpecularIntensity[eid];
            material.moodTemperature = MetalSteelBeamMaterialComponent.moodTemperature[eid];
            material.moodSaturation = MetalSteelBeamMaterialComponent.moodSaturation[eid];
            material.moodBrightness = MetalSteelBeamMaterialComponent.moodBrightness[eid];
            material.moodContrast = MetalSteelBeamMaterialComponent.moodContrast[eid];
            material.rimGlow = MetalSteelBeamMaterialComponent.rimGlow[eid];
            material.variationSeed = MetalSteelBeamMaterialComponent.variationSeed[eid];

            MetalSteelBeamMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MetalSteelBeamMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use structural-steel beam material for architectural and
 * industrial visualization. Extends MeshPhysicalMaterial with steel-specific
 * PBR defaults and real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class MetalSteelBeamMaterial extends MeshPhysicalMaterial {
    static {
        _metalSteelBeamScratchPool.warm(32);
    }

    /**
     * @param {Object} [parameters]
     */
    constructor(parameters) {
        super();

        this.isMetalSteelBeamMaterial = true;
        this.type = 'MetalSteelBeamMaterial';

        // -------------------------------------------------------------------
        // Steel-specific PBR defaults (cold-rolled steel baseline)
        // -------------------------------------------------------------------
        this.ior = 2.50;                    // Metals: ior is used for F0 only when metalness<1
        this.specularIntensity = 1.0;
        this.roughness = 0.28;
        this.metalness = 1.0;
        this.specularColor = new Color(0.88, 0.90, 0.92);
        this.color = new Color(0.62, 0.64, 0.66);   // near-neutral grey, ~#A8A8A8

        // No clearcoat for bare steel
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // No transmission for opaque steel
        this.transmission = 0.0;
        this.thickness = 0.001;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        // Anisotropy for rolled/brushed steel
        this.anisotropy = 0.55;
        this.anisotropyRotation = 0.0;

        // Sheen off (not typical for steel)
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // Iridescence off (except optional thin-film heat tint)
        this.iridescence = 0.0;
        this.iridescenceIOR = 1.30;
        this.iridescenceThicknessRange = [100, 400];

        // -------------------------------------------------------------------
        // Anime rendering extensions — steel-specific
        // -------------------------------------------------------------------
        this.steelBands = 4;
        this.steelQuantize = 0.5;
        this.steelSoftness = 0.06;

        // Surface micro-features
        this.millScaleStrength = 0.10;
        this.scratchStrength = 0.30;
        this.scratchDensity = 10.0;
        this.spangleStrength = 0.0;
        this.spangleCells = 24;

        // Edge specular — the bright chamfer highlight that reads as "metal"
        this.edgeSpecularIntensity = 0.35;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(0.85, 0.88, 0.95);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (steel leans semi-realistic)
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

    /**
     * @param {Color} baseColor
     * @param {Color} output
     * @returns {Color}
     */
    applySteelBanding(baseColor, output) {
        return applySteelCelBanding(
            baseColor,
            output,
            this.steelBands,
            this.steelQuantize,
            this.steelSoftness
        );
    }

    /**
     * @returns {MetalSteelBeamMaterial}
     */
    updateMoodColor() {
        gradeSteelColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named structural-steel preset.
     * @param {string} presetName - One of the keys of `MetalSteelBeamPresets`.
     * @returns {MetalSteelBeamMaterial}
     */
    applyPreset(presetName) {
        const preset = MetalSteelBeamPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;
        this.ior = preset.ior;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.anisotropy = preset.anisotropy;
        this.anisotropyRotation = preset.anisotropyRotation;
        this.millScaleStrength = preset.millScaleStrength;
        this.scratchStrength = preset.scratchStrength;
        this.spangleStrength = preset.spangleStrength;

        // Per-preset anime tuning
        if (presetName === 'hot-rolled-carbon-steel') {
            this.steelSoftness = 0.14;
            this.steelBands = 3;
            this.edgeSpecularIntensity = 0.25;
        } else if (presetName === 'cold-rolled-steel') {
            this.steelSoftness = 0.04;
            this.steelBands = 4;
            this.edgeSpecularIntensity = 0.45;
        } else if (presetName === 'primed-structural-steel' || presetName === 'painted-structural-steel') {
            this.steelSoftness = 0.18;
            this.steelBands = 2;
            this.edgeSpecularIntensity = 0.20;
        } else if (presetName === 'weathered-corten-steel') {
            this.steelSoftness = 0.24;
            this.steelBands = 2;
            this.edgeSpecularIntensity = 0.15;
        } else if (presetName === 'blackened-steel') {
            this.steelSoftness = 0.06;
            this.steelBands = 4;
            this.edgeSpecularIntensity = 0.50;
        }

        this.updateMoodColor();
        return this;
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.02]
     * @param {number} [octaves=4]
     * @param {number} [millScaleStrength=0.35]
     * @param {number} [scratchStrength=0.25]
     * @param {number} [spangleStrength=0.0]
     * @returns {Uint8Array}
     */
    generateSteelSurfaceTexture(width, height, scale = 0.02, octaves = 4, millScaleStrength = 0.35, scratchStrength = 0.25, spangleStrength = 0.0) {
        return generateSteelSurfaceTexture(width, height, scale, octaves, millScaleStrength, scratchStrength, this.scratchDensity, spangleStrength, this.spangleCells);
    }

    /**
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * @returns {Promise<MetalSteelBeamMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.steelBands = { value: this.steelBands };
        shader.uniforms.steelQuantize = { value: this.steelQuantize };
        shader.uniforms.steelSoftness = { value: this.steelSoftness };
        shader.uniforms.millScaleStrength = { value: this.millScaleStrength };
        shader.uniforms.scratchStrength = { value: this.scratchStrength };
        shader.uniforms.scratchDensity = { value: this.scratchDensity };
        shader.uniforms.spangleStrength = { value: this.spangleStrength };
        shader.uniforms.spangleCells = { value: this.spangleCells };
        shader.uniforms.brushedAnisotropy = { value: this.anisotropy };
        shader.uniforms.brushedRotation = { value: this.anisotropyRotation };
        shader.uniforms.edgeSpecularIntensity = { value: this.edgeSpecularIntensity };
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
                uniform int steelBands;
                uniform float steelQuantize;
                uniform float steelSoftness;
                uniform float millScaleStrength;
                uniform float scratchStrength;
                uniform float scratchDensity;
                uniform float spangleStrength;
                uniform float spangleCells;
                uniform float brushedAnisotropy;
                uniform float brushedRotation;
                uniform float edgeSpecularIntensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applySteelBands(vec3 baseColor) {
                    if (steelBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(steelBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * steelSoftness;
                    float finalLum = mix(lum, softQuantized, steelQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply steel cel banding
                gl_FragColor.rgb = applySteelBands(gl_FragColor.rgb);

                // Mill-scale mottle approximation
                if (millScaleStrength > 0.0) {
                    float mottle = sin(vUv.x * 8.0 + variationOffset) * cos(vUv.y * 8.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + mottle * millScaleStrength * 0.10);
                }

                // Directional scratch streaks
                if (scratchStrength > 0.0) {
                    vec2 scratchUV = vec2(vUv.x * 4.0, vUv.y * scratchDensity * 6.0);
                    float scratchHash = fract(sin(floor(scratchUV.y) * 12.9898 + variationOffset) * 43758.5453);
                    float scratchMask = smoothstep(0.55, 0.0, abs(fract(scratchUV.x) - 0.5)) * (scratchHash > 0.75 ? 1.0 : 0.0);
                    gl_FragColor.rgb *= (1.0 - scratchMask * scratchStrength * 0.25);
                }

                // Optional spangle cells (galvanized)
                if (spangleStrength > 0.0) {
                    vec2 spangleUV = vUv * spangleCells;
                    vec2 spangleCell = floor(spangleUV);
                    vec2 spangleFrac = fract(spangleUV);
                    float spangleHash = fract(sin(dot(spangleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    float spangleEdge = min(min(spangleFrac.x, 1.0 - spangleFrac.x), min(spangleFrac.y, 1.0 - spangleFrac.y)) * 2.0;
                    float spangleMask = clamp(spangleEdge, 0.0, 1.0);
                    gl_FragColor.rgb *= (1.0 + (spangleHash - 0.5) * spangleMask * spangleStrength * 0.30);
                }

                // Brushed-direction anisotropy approximation
                if (brushedAnisotropy > 0.0) {
                    float cosA = cos(brushedRotation);
                    float sinA = sin(brushedRotation);
                    vec2 rotatedUV = vec2(vUv.x * cosA - vUv.y * sinA, vUv.x * sinA + vUv.y * cosA);
                    float brushed = sin(rotatedUV.x * 60.0 + variationOffset) * cos(rotatedUV.y * 4.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + brushed * brushedAnisotropy * 0.05);
                }

                // Edge specular — the bright chamfer highlight that reads as metal
                if (edgeSpecularIntensity > 0.0) {
                    float ndotvSteel = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float edgeSpec = pow(1.0 - ndotvSteel, 4.0);
                    gl_FragColor.rgb += specularColor * edgeSpec * edgeSpecularIntensity;
                }

                // Cool-neutral rim glow on steel edges
                if (rimGlow > 0.0) {
                    float rimFactor = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    gl_FragColor.rgb += rimGlowColor * rimGlow * rimFactor;
                }
                `
            );
    }

    /**
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.ior, this.specularIntensity, this.roughness, this.metalness,
            this.clearcoat, this.clearcoatRoughness,
            this.anisotropy, this.anisotropyRotation,
            this.steelBands, this.steelQuantize, this.steelSoftness,
            this.millScaleStrength, this.scratchStrength, this.scratchDensity,
            this.spangleStrength, this.spangleCells,
            this.edgeSpecularIntensity,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    /**
     * @param {MetalSteelBeamMaterial} source
     * @returns {MetalSteelBeamMaterial}
     */
    copy(source) {
        super.copy(source);
        this.ior = source.ior;
        this.specularIntensity = source.specularIntensity;
        this.roughness = source.roughness;
        this.metalness = source.metalness;
        this.specularColor.copy(source.specularColor);
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.anisotropy = source.anisotropy;
        this.anisotropyRotation = source.anisotropyRotation;
        this.steelBands = source.steelBands;
        this.steelQuantize = source.steelQuantize;
        this.steelSoftness = source.steelSoftness;
        this.millScaleStrength = source.millScaleStrength;
        this.scratchStrength = source.scratchStrength;
        this.scratchDensity = source.scratchDensity;
        this.spangleStrength = source.spangleStrength;
        this.spangleCells = source.spangleCells;
        this.edgeSpecularIntensity = source.edgeSpecularIntensity;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    /**
     * @param {?(Object|string)} meta
     * @returns {Object}
     */
    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'MetalSteelBeamMaterial';

        if (this.ior !== 2.50) data.ior = this.ior;
        if (this.specularIntensity !== 1.0) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.28) data.roughness = this.roughness;
        if (this.metalness !== 1.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.88, 0.90, 0.92).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.anisotropy !== 0.55) data.anisotropy = this.anisotropy;
        if (this.anisotropyRotation !== 0.0) data.anisotropyRotation = this.anisotropyRotation;
        if (this.steelBands !== 4) data.steelBands = this.steelBands;
        if (this.steelQuantize !== 0.5) data.steelQuantize = this.steelQuantize;
        if (this.steelSoftness !== 0.06) data.steelSoftness = this.steelSoftness;
        if (this.millScaleStrength !== 0.10) data.millScaleStrength = this.millScaleStrength;
        if (this.scratchStrength !== 0.30) data.scratchStrength = this.scratchStrength;
        if (this.scratchDensity !== 10.0) data.scratchDensity = this.scratchDensity;
        if (this.spangleStrength !== 0.0) data.spangleStrength = this.spangleStrength;
        if (this.spangleCells !== 24) data.spangleCells = this.spangleCells;
        if (this.edgeSpecularIntensity !== 0.35) data.edgeSpecularIntensity = this.edgeSpecularIntensity;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.88, 0.95).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;
        return data;
    }

    /**
     * @param {Object} json
     * @returns {MetalSteelBeamMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);
        this.ior = json.ior ?? this.ior;
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        this.roughness = json.roughness ?? this.roughness;
        this.metalness = json.metalness ?? this.metalness;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        this.anisotropy = json.anisotropy ?? this.anisotropy;
        this.anisotropyRotation = json.anisotropyRotation ?? this.anisotropyRotation;
        this.steelBands = json.steelBands ?? this.steelBands;
        this.steelQuantize = json.steelQuantize ?? this.steelQuantize;
        this.steelSoftness = json.steelSoftness ?? this.steelSoftness;
        this.millScaleStrength = json.millScaleStrength ?? this.millScaleStrength;
        this.scratchStrength = json.scratchStrength ?? this.scratchStrength;
        this.scratchDensity = json.scratchDensity ?? this.scratchDensity;
        this.spangleStrength = json.spangleStrength ?? this.spangleStrength;
        this.spangleCells = json.spangleCells ?? this.spangleCells;
        this.edgeSpecularIntensity = json.edgeSpecularIntensity ?? this.edgeSpecularIntensity;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const MetalSteelBeamMaterialBatchComponent = {
    materialPtr: 'ui32',
    steelBands: 'ui8',
    steelQuantize: 'f64',
    steelSoftness: 'f64',
    millScaleStrength: 'f64',
    scratchStrength: 'f64',
    scratchDensity: 'f64',
    spangleStrength: 'f64',
    brushedAnisotropy: 'f64',
    brushedRotation: 'f64',
    edgeSpecularIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    MetalSteelBeamMaterial,
    MetalSteelBeamMaterialBatch,
    MetalSteelBeamScratchPool,
    MetalSteelBeamMaterialBatchComponent,
    MetalSteelBeamPresets,
    applySteelCelBanding,
    gradeSteelColor,
    generateSteelSurfaceTexture
};

export default MetalSteelBeamMaterial;