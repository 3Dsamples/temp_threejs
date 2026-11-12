// file number : 242
// full path name : src/materials/242_carpaintmaterial.js
// description : CarPaintMaterial — a ready-to-use base car-paint material for
//               real-time automotive rendering. Extends MeshPhysicalMaterial
//               with purpose-built presets covering the most common automotive
//               paint finishes: solid gloss, metallic, pearl/mica, matte,
//               satin, and candy. Includes physically grounded defaults
//               matching published automotive PBR references: two-layer
//               coating model (base colour + clearcoat) with clearcoat 1.0,
//               clearcoat roughness 0.02–0.08, base roughness 0.25–0.45,
//               metallic flakes via metalness 0.0–0.35, and iridescence for
//               pearl finishes. Adds real-time anime stylization: cel-banded
//               paint highlights, dual-layer clearcoat shine approximation,
//               metallic-flake sparkle, mood tinting, rim glow, and per-
//               instance variation. Includes a procedural paint-flake
//               texture generator using hashed sparkle cells and clearcoat
//               micro-roughness mottle.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Car paint, solid gloss car bodies, metallic car paint,
//            pearl/mica finishes, matte car wraps, satin finishes, candy
//            paint, automotive close-ups, anime car scenes, and any
//            automotive painted surface that needs real-time PBR + anime
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
// Car-paint presets — physically grounded PBR parameter sets for automotive
// paint finishes.
//
// Reference values (from AxF automotive finish guidelines, Unreal Automotive
// Lighting reference, Blender Guru car paint tutorials, and Substance
// Automotive materials):
//   - Base coat roughness:        0.25–0.45 (metallic/pearl rougher)
//   - Clearcoat:                  1.0 (automotive clearcoat is a full coat)
//   - Clearcoat roughness:        0.02–0.08 (gloss) up to 0.30 (satin)
//   - Metalness:                  0.0 for solid, 0.15–0.35 for metallic paint
//   - IOR (automotive clearcoat): ≈ 1.50
//   - Iridescence:                0.0 for solid, 0.20–0.45 for pearl/mica
//   - Anisotropy:                 rarely used (usually 0)
//   - Attenuation (not used for opaque paint)
// ---------------------------------------------------------------------------

const CarPaintPresets = {
    'solid-gloss-red': {
        color: [0.72, 0.08, 0.08],
        roughness: 0.30,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        ior: 1.50,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0],
        flakeDensity: 0.0,
        flakeStrength: 0.0
    },
    'metallic-blue': {
        color: [0.10, 0.24, 0.55],
        roughness: 0.36,
        metalness: 0.25,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        ior: 1.50,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0],
        flakeDensity: 0.35,
        flakeStrength: 0.55
    },
    'metallic-silver': {
        color: [0.72, 0.74, 0.78],
        roughness: 0.34,
        metalness: 0.28,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        ior: 1.50,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 1.0,
        specularColor: [1.0, 1.0, 1.0],
        flakeDensity: 0.40,
        flakeStrength: 0.60
    },
    'pearl-white': {
        color: [0.92, 0.90, 0.88],
        roughness: 0.32,
        metalness: 0.15,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        ior: 1.50,
        iridescence: 0.35,
        iridescenceIOR: 1.40,
        iridescenceThicknessRange: [200, 650],
        specularIntensity: 1.0,
        specularColor: [1.0, 0.98, 0.95],
        flakeDensity: 0.25,
        flakeStrength: 0.40
    },
    'matte-black': {
        color: [0.04, 0.04, 0.05],
        roughness: 0.68,
        metalness: 0.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.55,
        ior: 1.50,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 0.55,
        specularColor: [0.55, 0.55, 0.58],
        flakeDensity: 0.0,
        flakeStrength: 0.0
    },
    'satin-forest-green': {
        color: [0.10, 0.24, 0.16],
        roughness: 0.46,
        metalness: 0.0,
        clearcoat: 0.55,
        clearcoatRoughness: 0.28,
        ior: 1.50,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 0.85,
        specularColor: [0.85, 0.88, 0.85],
        flakeDensity: 0.0,
        flakeStrength: 0.0
    },
    'candy-orange': {
        color: [0.92, 0.34, 0.08],
        roughness: 0.25,
        metalness: 0.18,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        ior: 1.50,
        iridescence: 0.15,
        iridescenceIOR: 1.35,
        iridescenceThicknessRange: [150, 500],
        specularIntensity: 1.0,
        specularColor: [1.0, 0.98, 0.95],
        flakeDensity: 0.20,
        flakeStrength: 0.35
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable car-paint scratch records
// ---------------------------------------------------------------------------

class CarPaintScratchPool {
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

const _carPaintScratchPool = new CarPaintScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — car-paint-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded car-paint highlights. Automotive clearcoat has extremely
 * crisp specular edges — quantizing the luminance into discrete bands
 * produces the flat anime car shine seen in hand-drawn automotive scenes.
 */
function applyCarPaintCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.05) {
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
 * Apply mood-based tinting to car paint. Warm moods push paint toward warm
 * sunset amber, cool moods toward cool twilight blue — matching the
 * atmospheric car-paint tinting seen in stylized automotive scenes.
 */
function gradeCarPaintColor(color, temperature, saturation, brightness, contrast) {
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

    // Car-paint-specific temperature bias: warm shift pushes toward sunset
    // amber, cool shift toward twilight blue.
    r += temperature * 0.03;
    g += temperature * 0.015;
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
 * Generate a procedural paint-flake texture. The algorithm:
 * 1. Hashed sparkle cells: per-cell presence and per-flake brightness —
 *    producing the metallic-flake sparkle look of automotive paint.
 * 2. Clearcoat micro-roughness mottle: low-frequency fBm for the clearcoat
 *    surface micro-texture (very subtle for gloss, stronger for matte).
 * 3. Optional pearl-shift mask: low-frequency hue-shift map for pearl
 *    finishes.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generatePaintFlakeTexture(width, height, flakeDensity = 0.35, flakeStrength = 0.55, clearcoatMottle = 0.04, pearlStrength = 0.0) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Hashed sparkle cells (metallic flake) ---
            const flakeCellX = Math.floor(x * 1.2);
            const flakeCellY = Math.floor(y * 1.2);
            const flakeCellId = flakeCellX * 73856093 ^ flakeCellY * 19349663;
            const flakeHash = Math.abs(Math.sin(flakeCellId * 12.9898) * 43758.5453) % 1.0;

            let flake = 0;
            if (flakeHash > (1.0 - flakeDensity)) {
                const fh2 = Math.abs(Math.sin(flakeCellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                flake = fh2 * flakeStrength;
            }

            // --- 2. Clearcoat micro-roughness mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.05, y * 0.05) * 0.5 + 0.5;
            const mottleValue = (mottle - 0.5) * clearcoatMottle;

            // --- 3. Pearl-shift mask ---
            let pearl = 0;
            if (pearlStrength > 0) {
                const pearlNoise = SimplexNoise.noise2D(x * 0.01, y * 0.01) * 0.5 + 0.5;
                pearl = (pearlNoise - 0.5) * pearlStrength;
            }

            // --- Combine ---
            let value = 0.5 + flake * 0.4 + mottleValue + pearl * 0.2;
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

const _carPaintWorld = BitECS.createWorld();
const CarPaintMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    paintBands: 'ui8',
    paintQuantize: 'f64',
    paintSoftness: 'f64',
    flakeDensity: 'f64',
    flakeStrength: 'f64',
    flakeSparkleIntensity: 'f64',
    clearcoatMottle: 'f64',
    pearlShiftStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class CarPaintMaterialBatch {
    constructor() {
        this.world = _carPaintWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, CarPaintMaterialComponent, eid);
        CarPaintMaterialComponent.materialPtr[eid] = this.materials.length;
        CarPaintMaterialComponent.paintBands[eid] = material.paintBands;
        CarPaintMaterialComponent.paintQuantize[eid] = material.paintQuantize;
        CarPaintMaterialComponent.paintSoftness[eid] = material.paintSoftness;
        CarPaintMaterialComponent.flakeDensity[eid] = material.flakeDensity;
        CarPaintMaterialComponent.flakeStrength[eid] = material.flakeStrength;
        CarPaintMaterialComponent.flakeSparkleIntensity[eid] = material.flakeSparkleIntensity;
        CarPaintMaterialComponent.clearcoatMottle[eid] = material.clearcoatMottle;
        CarPaintMaterialComponent.pearlShiftStrength[eid] = material.pearlShiftStrength;
        CarPaintMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        CarPaintMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        CarPaintMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        CarPaintMaterialComponent.moodContrast[eid] = material.moodContrast;
        CarPaintMaterialComponent.rimGlow[eid] = material.rimGlow;
        CarPaintMaterialComponent.variationSeed[eid] = material.variationSeed;
        CarPaintMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[CarPaintMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.paintBands = CarPaintMaterialComponent.paintBands[eid];
            material.paintQuantize = CarPaintMaterialComponent.paintQuantize[eid];
            material.paintSoftness = CarPaintMaterialComponent.paintSoftness[eid];
            material.flakeDensity = CarPaintMaterialComponent.flakeDensity[eid];
            material.flakeStrength = CarPaintMaterialComponent.flakeStrength[eid];
            material.flakeSparkleIntensity = CarPaintMaterialComponent.flakeSparkleIntensity[eid];
            material.clearcoatMottle = CarPaintMaterialComponent.clearcoatMottle[eid];
            material.pearlShiftStrength = CarPaintMaterialComponent.pearlShiftStrength[eid];
            material.moodTemperature = CarPaintMaterialComponent.moodTemperature[eid];
            material.moodSaturation = CarPaintMaterialComponent.moodSaturation[eid];
            material.moodBrightness = CarPaintMaterialComponent.moodBrightness[eid];
            material.moodContrast = CarPaintMaterialComponent.moodContrast[eid];
            material.rimGlow = CarPaintMaterialComponent.rimGlow[eid];
            material.variationSeed = CarPaintMaterialComponent.variationSeed[eid];

            CarPaintMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main CarPaintMaterial class
// ---------------------------------------------------------------------------

class CarPaintMaterial extends MeshPhysicalMaterial {
    static {
        _carPaintScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isCarPaintMaterial = true;
        this.type = 'CarPaintMaterial';

        // -------------------------------------------------------------------
        // Car-paint-specific PBR defaults (solid-gloss-red baseline)
        // -------------------------------------------------------------------
        this.ior = 1.50;
        this.specularIntensity = 1.0;
        this.roughness = 0.30;
        this.metalness = 0.0;
        this.specularColor = new Color(1.0, 1.0, 1.0);
        this.color = new Color(0.72, 0.08, 0.08);

        // Full automotive clearcoat
        this.clearcoat = 1.0;
        this.clearcoatRoughness = 0.03;

        // Iridescence (off for solid, on for pearl/mica)
        this.iridescence = 0.0;
        this.iridescenceIOR = 1.30;
        this.iridescenceThicknessRange = [100, 400];

        // No transmission for opaque paint
        this.transmission = 0.0;
        this.thickness = 0.001;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        // Sheen off (not typical for car paint)
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — car-paint-specific
        // -------------------------------------------------------------------
        this.paintBands = 4;
        this.paintQuantize = 0.5;
        this.paintSoftness = 0.05;

        // Metallic flake / clearcoat mottle / pearl-shift controls
        this.flakeDensity = 0.0;
        this.flakeStrength = 0.0;
        this.flakeSparkleIntensity = 0.0;
        this.clearcoatMottle = 0.04;
        this.pearlShiftStrength = 0.0;
        this.pearlShiftColor = new Color(0.85, 0.92, 1.0);

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(1.0, 0.92, 0.85);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (car paint leans semi-realistic)
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

    applyPaintBanding(baseColor, output) {
        return applyCarPaintCelBanding(
            baseColor,
            output,
            this.paintBands,
            this.paintQuantize,
            this.paintSoftness
        );
    }

    updateMoodColor() {
        gradeCarPaintColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named car-paint preset to this material.
     * @param {string} presetName - One of the keys of `CarPaintPresets`.
     * @returns {CarPaintMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = CarPaintPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;
        this.ior = preset.ior;
        this.iridescence = preset.iridescence;
        this.iridescenceIOR = preset.iridescenceIOR;
        this.iridescenceThicknessRange = preset.iridescenceThicknessRange.slice();
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.flakeDensity = preset.flakeDensity;
        this.flakeStrength = preset.flakeStrength;
        this.flakeSparkleIntensity = preset.flakeStrength * 0.6;

        // Per-preset anime tuning
        if (presetName === 'matte-black') {
            this.paintSoftness = 0.22;
            this.paintBands = 2;
            this.clearcoatMottle = 0.12;
        } else if (presetName === 'satin-forest-green') {
            this.paintSoftness = 0.15;
            this.paintBands = 3;
            this.clearcoatMottle = 0.08;
        } else if (presetName === 'pearl-white' || presetName === 'candy-orange') {
            this.paintSoftness = 0.03;
            this.paintBands = 4;
            this.pearlShiftStrength = 0.25;
        } else {
            this.paintSoftness = 0.05;
            this.paintBands = 4;
        }

        this.updateMoodColor();
        return this;
    }

    generatePaintFlakeTexture(width, height, flakeDensity = 0.35, flakeStrength = 0.55, clearcoatMottle = 0.04, pearlStrength = 0.0) {
        return generatePaintFlakeTexture(width, height, flakeDensity, flakeStrength, clearcoatMottle, pearlStrength);
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

        shader.uniforms.paintBands = { value: this.paintBands };
        shader.uniforms.paintQuantize = { value: this.paintQuantize };
        shader.uniforms.paintSoftness = { value: this.paintSoftness };
        shader.uniforms.flakeDensity = { value: this.flakeDensity };
        shader.uniforms.flakeStrength = { value: this.flakeStrength };
        shader.uniforms.flakeSparkleIntensity = { value: this.flakeSparkleIntensity };
        shader.uniforms.clearcoatMottle = { value: this.clearcoatMottle };
        shader.uniforms.pearlShiftStrength = { value: this.pearlShiftStrength };
        shader.uniforms.pearlShiftColor = { value: this.pearlShiftColor };
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
                uniform int paintBands;
                uniform float paintQuantize;
                uniform float paintSoftness;
                uniform float flakeDensity;
                uniform float flakeStrength;
                uniform float flakeSparkleIntensity;
                uniform float clearcoatMottle;
                uniform float pearlShiftStrength;
                uniform vec3 pearlShiftColor;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyPaintBands(vec3 baseColor) {
                    if (paintBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(paintBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * paintSoftness;
                    float finalLum = mix(lum, softQuantized, paintQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply car-paint cel banding
                gl_FragColor.rgb = applyPaintBands(gl_FragColor.rgb);

                // Metallic flake sparkle approximation
                if (flakeDensity > 0.0) {
                    vec2 flakeUV = vUv * 300.0;
                    vec2 flakeCell = floor(flakeUV);
                    float flakeHash = fract(sin(dot(flakeCell, vec2(12.9898, 78.233))) * 43758.5453);
                    float flakeMask = flakeHash > (1.0 - flakeDensity) ? (flakeHash * flakeStrength) : 0.0;
                    gl_FragColor.rgb += vec3(flakeMask * flakeSparkleIntensity);
                }

                // Clearcoat micro-mottle
                if (clearcoatMottle > 0.0) {
                    float mottle = sin(vUv.x * 22.0 + variationOffset) * cos(vUv.y * 22.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + mottle * clearcoatMottle * 0.10);
                }

                // Pearl/mica shift
                if (pearlShiftStrength > 0.0) {
                    float pearlMask = smoothstep(0.2, 0.8, vUv.x + vUv.y);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * pearlShiftColor * 1.15, pearlMask * pearlShiftStrength);
                }

                // Clearcoat specular rim (very tight grazing-angle glint)
                {
                    float ndotvPaint = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float rimSpec = pow(1.0 - ndotvPaint, 5.0);
                    gl_FragColor.rgb += specularColor * rimSpec * 0.15;
                }

                // Warm rim glow on paint edges
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
            this.iridescence, this.iridescenceIOR,
            this.paintBands, this.paintQuantize, this.paintSoftness,
            this.flakeDensity, this.flakeStrength, this.flakeSparkleIntensity,
            this.clearcoatMottle, this.pearlShiftStrength,
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
        this.iridescence = source.iridescence;
        this.iridescenceIOR = source.iridescenceIOR;
        this.iridescenceThicknessRange = source.iridescenceThicknessRange.slice();
        this.paintBands = source.paintBands;
        this.paintQuantize = source.paintQuantize;
        this.paintSoftness = source.paintSoftness;
        this.flakeDensity = source.flakeDensity;
        this.flakeStrength = source.flakeStrength;
        this.flakeSparkleIntensity = source.flakeSparkleIntensity;
        this.clearcoatMottle = source.clearcoatMottle;
        this.pearlShiftStrength = source.pearlShiftStrength;
        this.pearlShiftColor.copy(source.pearlShiftColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'CarPaintMaterial';
        if (this.ior !== 1.50) data.ior = this.ior;
        if (this.specularIntensity !== 1.0) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.30) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 1.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.03) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.iridescence !== 0.0) data.iridescence = this.iridescence;
        if (this.iridescenceIOR !== 1.30) data.iridescenceIOR = this.iridescenceIOR;
        if (this.specularColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.paintBands !== 4) data.paintBands = this.paintBands;
        if (this.paintQuantize !== 0.5) data.paintQuantize = this.paintQuantize;
        if (this.paintSoftness !== 0.05) data.paintSoftness = this.paintSoftness;
        if (this.flakeDensity !== 0.0) data.flakeDensity = this.flakeDensity;
        if (this.flakeStrength !== 0.0) data.flakeStrength = this.flakeStrength;
        if (this.flakeSparkleIntensity !== 0.0) data.flakeSparkleIntensity = this.flakeSparkleIntensity;
        if (this.clearcoatMottle !== 0.04) data.clearcoatMottle = this.clearcoatMottle;
        if (this.pearlShiftStrength !== 0.0) data.pearlShiftStrength = this.pearlShiftStrength;
        if (this.pearlShiftColor.getHex() !== new Color(0.85, 0.92, 1.0).getHex()) data.pearlShiftColor = this.pearlShiftColor.getHex();
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 0.92, 0.85).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.iridescence = json.iridescence ?? this.iridescence;
        this.iridescenceIOR = json.iridescenceIOR ?? this.iridescenceIOR;
        if (json.iridescenceThicknessRange) this.iridescenceThicknessRange = json.iridescenceThicknessRange.slice();
        this.paintBands = json.paintBands ?? this.paintBands;
        this.paintQuantize = json.paintQuantize ?? this.paintQuantize;
        this.paintSoftness = json.paintSoftness ?? this.paintSoftness;
        this.flakeDensity = json.flakeDensity ?? this.flakeDensity;
        this.flakeStrength = json.flakeStrength ?? this.flakeStrength;
        this.flakeSparkleIntensity = json.flakeSparkleIntensity ?? this.flakeSparkleIntensity;
        this.clearcoatMottle = json.clearcoatMottle ?? this.clearcoatMottle;
        this.pearlShiftStrength = json.pearlShiftStrength ?? this.pearlShiftStrength;
        if (json.pearlShiftColor !== undefined) this.pearlShiftColor.setHex(json.pearlShiftColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const CarPaintMaterialBatchComponent = {
    materialPtr: 'ui32',
    paintBands: 'ui8',
    paintQuantize: 'f64',
    paintSoftness: 'f64',
    flakeDensity: 'f64',
    flakeStrength: 'f64',
    flakeSparkleIntensity: 'f64',
    clearcoatMottle: 'f64',
    pearlShiftStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    CarPaintMaterial,
    CarPaintMaterialBatch,
    CarPaintScratchPool,
    CarPaintMaterialBatchComponent,
    CarPaintPresets,
    applyCarPaintCelBanding,
    gradeCarPaintColor,
    generatePaintFlakeTexture
};

export default CarPaintMaterial;