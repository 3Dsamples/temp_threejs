// file number : 243
// full path name : src/materials/243_carmetallicpaintmaterial.js
// description : CarMetallicPaintMaterial — a ready-to-use metallic car-paint
//               material specializing in automotive metallic finishes.
//               Extends CarPaintMaterial with purpose-built presets for the
//               classic metallic paint families: aluminium metallic, gold
//               metallic, copper metallic, steel metallic, gunmetal metallic,
//               and rose-gold metallic. Includes metallic-specific PBR tuning
//               (higher metalness 0.35–0.55, stronger flake density 0.45–0.65,
//               tinted specular colour to match the metal family, slightly
//               rougher base coat 0.32–0.42 for the flake scatter, and
//               stronger clearcoat so the flake sparkle reads through the
//               topcoat) plus real-time anime stylization: cel-banded
//               metallic-paint highlights, stronger metallic-flake sparkle
//               approximation, metallic-tinted specular, mood tinting, rim
//               glow, and per-instance variation. Includes a procedural
//               metallic-flake texture generator with per-flake hue jitter,
//               clearcoat micro-mottle, and optional brushed-direction
//               anisotropy for directional metallic finishes.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Metallic car paint, aluminium metallic, gold metallic, copper
//            metallic, steel metallic, gunmetal metallic, rose-gold metallic,
//            automotive close-ups, anime car scenes, and any metallic
//            automotive painted surface that needs real-time PBR + anime
//            stylization.
// license : MIT

import { CarPaintMaterial } from './242_carpaintmaterial.js';
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
// Metallic car-paint presets — physically grounded PBR parameter sets for
// automotive metallic finishes.
//
// Reference values (from AxF automotive finish guidelines, Unreal Automotive
// Lighting reference, Substance Automotive, and paint-manufacturer datasheets):
//   - Metallic base coat metalness: 0.35–0.55 (metal flakes mixed with pigment)
//   - Base coat roughness:           0.32–0.42 (flakes scatter)
//   - Clearcoat:                     1.0 (always full automotive clearcoat)
//   - Clearcoat roughness:           0.02–0.06 (gloss)
//   - IOR (automotive clearcoat):    ≈ 1.50
//   - Flake density:                 0.45–0.65 (dominant metallic character)
//   - Specular colour:               tinted by metal family (aluminium=neutral,
//                                    gold=warm, copper=red-orange, steel=cool)
//   - Anisotropy:                    usually 0 (isotropic metal flakes)
// ---------------------------------------------------------------------------

const CarMetallicPaintPresets = {
    'aluminium-metallic': {
        color: [0.74, 0.76, 0.80],
        roughness: 0.36,
        metalness: 0.45,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        ior: 1.50,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 1.0,
        specularColor: [0.95, 0.96, 0.98],
        flakeDensity: 0.55,
        flakeStrength: 0.65,
        flakeHueJitter: 0.04
    },
    'gold-metallic': {
        color: [0.86, 0.66, 0.22],
        roughness: 0.34,
        metalness: 0.52,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        ior: 1.50,
        iridescence: 0.10,
        iridescenceIOR: 1.35,
        iridescenceThicknessRange: [150, 500],
        specularIntensity: 1.0,
        specularColor: [1.0, 0.90, 0.65],
        flakeDensity: 0.58,
        flakeStrength: 0.68,
        flakeHueJitter: 0.08
    },
    'copper-metallic': {
        color: [0.82, 0.42, 0.20],
        roughness: 0.35,
        metalness: 0.50,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        ior: 1.50,
        iridescence: 0.08,
        iridescenceIOR: 1.35,
        iridescenceThicknessRange: [140, 480],
        specularIntensity: 1.0,
        specularColor: [1.0, 0.80, 0.62],
        flakeDensity: 0.56,
        flakeStrength: 0.66,
        flakeHueJitter: 0.07
    },
    'steel-metallic': {
        color: [0.42, 0.44, 0.48],
        roughness: 0.38,
        metalness: 0.42,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        ior: 1.50,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 1.0,
        specularColor: [0.88, 0.90, 0.94],
        flakeDensity: 0.50,
        flakeStrength: 0.60,
        flakeHueJitter: 0.03
    },
    'gunmetal-metallic': {
        color: [0.22, 0.24, 0.28],
        roughness: 0.40,
        metalness: 0.48,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        ior: 1.50,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 1.0,
        specularColor: [0.75, 0.78, 0.84],
        flakeDensity: 0.48,
        flakeStrength: 0.58,
        flakeHueJitter: 0.03
    },
    'rose-gold-metallic': {
        color: [0.90, 0.62, 0.52],
        roughness: 0.34,
        metalness: 0.50,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        ior: 1.50,
        iridescence: 0.15,
        iridescenceIOR: 1.38,
        iridescenceThicknessRange: [160, 520],
        specularIntensity: 1.0,
        specularColor: [1.0, 0.86, 0.78],
        flakeDensity: 0.54,
        flakeStrength: 0.64,
        flakeHueJitter: 0.09
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable metallic-paint scratch records
// ---------------------------------------------------------------------------

class CarMetallicPaintScratchPool {
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

const _carMetallicPaintScratchPool = new CarMetallicPaintScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — metallic-paint-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded metallic-paint highlights. Metallic automotive paint has
 * extremely crisp specular bands under clearcoat, with flake sparkle riding
 * on top — quantizing the luminance produces the flat anime metallic look.
 */
function applyMetallicPaintCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.04) {
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
 * Apply mood-based tinting to metallic car paint. Warm moods push the paint
 * toward warm sunset amber, cool moods toward cool twilight blue — matching
 * the atmospheric metallic-paint tinting seen in stylized automotive scenes.
 */
function gradeMetallicPaintColor(color, temperature, saturation, brightness, contrast) {
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

    // Metallic-paint-specific temperature bias: warm shift pushes toward
    // sunset amber, cool shift toward twilight blue.
    r += temperature * 0.035;
    g += temperature * 0.015;
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
 * Generate a procedural metallic-flake texture. The algorithm:
 * 1. Hashed sparkle cells: per-cell presence, per-flake brightness, and
 *    per-flake hue jitter — producing the metallic-flake sparkle look.
 * 2. Clearcoat micro-roughness mottle: low-frequency fBm for the clearcoat
 *    surface micro-texture (very subtle for gloss).
 * 3. Optional brushed-direction anisotropy: elongated streak noise for
 *    directional metallic finishes.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation. For coloured flake sparkle, the shader applies
 * per-flake hue jitter using the accompanying per-flake tint channel (stored
 * in the alpha channel here for convenience).
 */
function generateMetallicFlakeTexture(width, height, flakeDensity = 0.55, flakeStrength = 0.65, flakeHueJitter = 0.04, clearcoatMottle = 0.03, brushedStrength = 0.0) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Hashed sparkle cells ---
            const flakeCellX = Math.floor(x * 1.2);
            const flakeCellY = Math.floor(y * 1.2);
            const flakeCellId = flakeCellX * 73856093 ^ flakeCellY * 19349663;
            const flakeHash = Math.abs(Math.sin(flakeCellId * 12.9898) * 43758.5453) % 1.0;

            let flake = 0;
            let flakeTint = 0.5;
            if (flakeHash > (1.0 - flakeDensity)) {
                const fh2 = Math.abs(Math.sin(flakeCellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                const fh3 = Math.abs(Math.sin(flakeCellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                flake = fh2 * flakeStrength;
                // Per-flake hue jitter encoded in [0, 1] for shader-side tinting
                flakeTint = 0.5 + (fh3 - 0.5) * (flakeHueJitter * 2.0);
            }

            // --- 2. Clearcoat micro-roughness mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.05, y * 0.05) * 0.5 + 0.5;
            const mottleValue = (mottle - 0.5) * clearcoatMottle;

            // --- 3. Brushed-direction anisotropy (optional) ---
            let brushed = 0;
            if (brushedStrength > 0) {
                const streak = SimplexNoise.noise2D(x * 0.02, y * 0.6) * 0.5 + 0.5;
                brushed = (streak - 0.5) * brushedStrength;
            }

            // --- Combine ---
            let value = 0.5 + flake * 0.4 + mottleValue + brushed * 0.2;
            value = Math.max(0, Math.min(1, value));

            const v8 = Math.floor(value * 255);
            const tint8 = Math.floor(Math.max(0, Math.min(1, flakeTint)) * 255);

            out[p] = v8;
            out[p + 1] = v8;
            out[p + 2] = v8;
            // Alpha channel stores the per-flake tint for shader-side hue jitter
            out[p + 3] = tint8;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator
// ---------------------------------------------------------------------------

const _carMetallicPaintWorld = BitECS.createWorld();
const CarMetallicPaintMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    paintBands: 'ui8',
    paintQuantize: 'f64',
    paintSoftness: 'f64',
    flakeDensity: 'f64',
    flakeStrength: 'f64',
    flakeHueJitter: 'f64',
    flakeSparkleIntensity: 'f64',
    clearcoatMottle: 'f64',
    brushedStrength: 'f64',
    metallicSpecularTint: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class CarMetallicPaintMaterialBatch {
    constructor() {
        this.world = _carMetallicPaintWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, CarMetallicPaintMaterialComponent, eid);
        CarMetallicPaintMaterialComponent.materialPtr[eid] = this.materials.length;
        CarMetallicPaintMaterialComponent.paintBands[eid] = material.paintBands;
        CarMetallicPaintMaterialComponent.paintQuantize[eid] = material.paintQuantize;
        CarMetallicPaintMaterialComponent.paintSoftness[eid] = material.paintSoftness;
        CarMetallicPaintMaterialComponent.flakeDensity[eid] = material.flakeDensity;
        CarMetallicPaintMaterialComponent.flakeStrength[eid] = material.flakeStrength;
        CarMetallicPaintMaterialComponent.flakeHueJitter[eid] = material.flakeHueJitter;
        CarMetallicPaintMaterialComponent.flakeSparkleIntensity[eid] = material.flakeSparkleIntensity;
        CarMetallicPaintMaterialComponent.clearcoatMottle[eid] = material.clearcoatMottle;
        CarMetallicPaintMaterialComponent.brushedStrength[eid] = material.brushedStrength;
        CarMetallicPaintMaterialComponent.metallicSpecularTint[eid] = material.metallicSpecularTint;
        CarMetallicPaintMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        CarMetallicPaintMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        CarMetallicPaintMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        CarMetallicPaintMaterialComponent.moodContrast[eid] = material.moodContrast;
        CarMetallicPaintMaterialComponent.rimGlow[eid] = material.rimGlow;
        CarMetallicPaintMaterialComponent.variationSeed[eid] = material.variationSeed;
        CarMetallicPaintMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[CarMetallicPaintMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.paintBands = CarMetallicPaintMaterialComponent.paintBands[eid];
            material.paintQuantize = CarMetallicPaintMaterialComponent.paintQuantize[eid];
            material.paintSoftness = CarMetallicPaintMaterialComponent.paintSoftness[eid];
            material.flakeDensity = CarMetallicPaintMaterialComponent.flakeDensity[eid];
            material.flakeStrength = CarMetallicPaintMaterialComponent.flakeStrength[eid];
            material.flakeHueJitter = CarMetallicPaintMaterialComponent.flakeHueJitter[eid];
            material.flakeSparkleIntensity = CarMetallicPaintMaterialComponent.flakeSparkleIntensity[eid];
            material.clearcoatMottle = CarMetallicPaintMaterialComponent.clearcoatMottle[eid];
            material.brushedStrength = CarMetallicPaintMaterialComponent.brushedStrength[eid];
            material.metallicSpecularTint = CarMetallicPaintMaterialComponent.metallicSpecularTint[eid];
            material.moodTemperature = CarMetallicPaintMaterialComponent.moodTemperature[eid];
            material.moodSaturation = CarMetallicPaintMaterialComponent.moodSaturation[eid];
            material.moodBrightness = CarMetallicPaintMaterialComponent.moodBrightness[eid];
            material.moodContrast = CarMetallicPaintMaterialComponent.moodContrast[eid];
            material.rimGlow = CarMetallicPaintMaterialComponent.rimGlow[eid];
            material.variationSeed = CarMetallicPaintMaterialComponent.variationSeed[eid];

            CarMetallicPaintMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main CarMetallicPaintMaterial class
// ---------------------------------------------------------------------------

class CarMetallicPaintMaterial extends CarPaintMaterial {
    static {
        _carMetallicPaintScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isCarMetallicPaintMaterial = true;
        this.type = 'CarMetallicPaintMaterial';

        // -------------------------------------------------------------------
        // Metallic-paint-specific PBR defaults (aluminium-metallic baseline)
        // -------------------------------------------------------------------
        this.ior = 1.50;
        this.specularIntensity = 1.0;
        this.roughness = 0.36;
        this.metalness = 0.45;
        this.specularColor = new Color(0.95, 0.96, 0.98);
        this.color = new Color(0.74, 0.76, 0.80);

        // Full automotive clearcoat
        this.clearcoat = 1.0;
        this.clearcoatRoughness = 0.03;

        // Iridescence off for most metallics (enable for gold/copper/rose-gold)
        this.iridescence = 0.0;
        this.iridescenceIOR = 1.30;
        this.iridescenceThicknessRange = [100, 400];

        // -------------------------------------------------------------------
        // Anime rendering extensions — metallic-paint-specific
        // -------------------------------------------------------------------
        this.paintBands = 4;
        this.paintQuantize = 0.5;
        this.paintSoftness = 0.04;

        // Metallic flake / brushed / specular controls
        this.flakeDensity = 0.55;
        this.flakeStrength = 0.65;
        this.flakeHueJitter = 0.04;
        this.flakeSparkleIntensity = 0.55;
        this.flakeHueColor = new Color(0.95, 0.95, 1.0);
        this.clearcoatMottle = 0.03;
        this.brushedStrength = 0.0;
        this.metallicSpecularTint = 1.0;

        // Pearl shift (used for rose-gold, gold, copper presets)
        this.pearlShiftStrength = 0.0;
        this.pearlShiftColor = new Color(0.85, 0.92, 1.0);

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.14;
        this.rimGlowColor = new Color(1.0, 0.95, 0.90);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (metallic car paint leans semi-realistic)
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

    applyMetallicBanding(baseColor, output) {
        return applyMetallicPaintCelBanding(
            baseColor,
            output,
            this.paintBands,
            this.paintQuantize,
            this.paintSoftness
        );
    }

    updateMoodColor() {
        gradeMetallicPaintColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named metallic car-paint preset to this material.
     * @param {string} presetName - One of the keys of `CarMetallicPaintPresets`.
     * @returns {CarMetallicPaintMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = CarMetallicPaintPresets[presetName];
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
        this.flakeHueJitter = preset.flakeHueJitter;
        this.flakeSparkleIntensity = preset.flakeStrength * 0.85;

        // Per-preset anime tuning
        if (presetName === 'gold-metallic' || presetName === 'copper-metallic' || presetName === 'rose-gold-metallic') {
            this.pearlShiftStrength = 0.20;
            this.pearlShiftColor.setRGB(1.0, 0.88, 0.70, ColorManagement.workingColorSpace);
            this.metallicSpecularTint = 1.10;
        } else if (presetName === 'gunmetal-metallic' || presetName === 'steel-metallic') {
            this.pearlShiftStrength = 0.0;
            this.metallicSpecularTint = 0.90;
        } else {
            this.pearlShiftStrength = 0.0;
            this.metallicSpecularTint = 1.0;
        }

        this.updateMoodColor();
        return this;
    }

    generateMetallicFlakeTexture(width, height, flakeDensity = 0.55, flakeStrength = 0.65, flakeHueJitter = 0.04, clearcoatMottle = 0.03, brushedStrength = 0.0) {
        return generateMetallicFlakeTexture(width, height, flakeDensity, flakeStrength, flakeHueJitter, clearcoatMottle, brushedStrength);
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

        shader.uniforms.flakeDensity = { value: this.flakeDensity };
        shader.uniforms.flakeStrength = { value: this.flakeStrength };
        shader.uniforms.flakeHueJitter = { value: this.flakeHueJitter };
        shader.uniforms.flakeSparkleIntensity = { value: this.flakeSparkleIntensity };
        shader.uniforms.flakeHueColor = { value: this.flakeHueColor };
        shader.uniforms.clearcoatMottle = { value: this.clearcoatMottle };
        shader.uniforms.brushedStrength = { value: this.brushedStrength };
        shader.uniforms.metallicSpecularTint = { value: this.metallicSpecularTint };
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
                uniform float flakeDensity;
                uniform float flakeStrength;
                uniform float flakeHueJitter;
                uniform float flakeSparkleIntensity;
                uniform vec3 flakeHueColor;
                uniform float clearcoatMottle;
                uniform float brushedStrength;
                uniform float metallicSpecularTint;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyFlakeHueShift(vec3 flakeColor, float hueShift) {
                    float lum = dot(flakeColor, vec3(0.2126, 0.7152, 0.0722));
                    return mix(flakeColor, flakeColor * flakeHueColor, clamp(hueShift * metallicSpecularTint, 0.0, 1.0));
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Metallic flake sparkle with per-flake hue jitter
                if (flakeDensity > 0.0) {
                    vec2 flakeUV = vUv * 300.0;
                    vec2 flakeCell = floor(flakeUV);
                    float flakeHash = fract(sin(dot(flakeCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (flakeHash > (1.0 - flakeDensity)) {
                        float flakeHueHash = fract(sin(dot(flakeCell, vec2(39.425, 1.57))) * 43758.5453);
                        float hueShift = (flakeHueHash - 0.5) * flakeHueJitter * 2.0;
                        vec3 flakeSparkle = applyFlakeHueShift(vec3(1.0), hueShift);
                        gl_FragColor.rgb += flakeSparkle * flakeHash * flakeStrength * flakeSparkleIntensity;
                    }
                }

                // Clearcoat micro-mottle
                if (clearcoatMottle > 0.0) {
                    float mottle = sin(vUv.x * 22.0 + variationOffset) * cos(vUv.y * 22.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + mottle * clearcoatMottle * 0.10);
                }

                // Brushed-direction anisotropy (optional)
                if (brushedStrength > 0.0) {
                    float brushed = sin(vUv.x * 30.0 + variationOffset) * cos(vUv.y * 200.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + brushed * brushedStrength * 0.08);
                }

                // Metallic specular tint: tint the rim specular toward metal family
                {
                    float ndotvMet = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float rimSpec = pow(1.0 - ndotvMet, 5.0);
                    vec3 metallicRim = mix(specularColor, specularColor * flakeHueColor, metallicSpecularTint * 0.5);
                    gl_FragColor.rgb += metallicRim * rimSpec * 0.20;
                }

                // Warm rim glow on metallic-paint edges
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
            this.paintBands, this.paintQuantize, this.paintSoftness,
            this.flakeDensity, this.flakeStrength, this.flakeHueJitter,
            this.flakeSparkleIntensity, this.clearcoatMottle,
            this.brushedStrength, this.metallicSpecularTint,
            this.pearlShiftStrength,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    copy(source) {
        super.copy(source);
        this.flakeDensity = source.flakeDensity;
        this.flakeStrength = source.flakeStrength;
        this.flakeHueJitter = source.flakeHueJitter;
        this.flakeSparkleIntensity = source.flakeSparkleIntensity;
        this.flakeHueColor.copy(source.flakeHueColor);
        this.clearcoatMottle = source.clearcoatMottle;
        this.brushedStrength = source.brushedStrength;
        this.metallicSpecularTint = source.metallicSpecularTint;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'CarMetallicPaintMaterial';
        if (this.flakeDensity !== 0.55) data.flakeDensity = this.flakeDensity;
        if (this.flakeStrength !== 0.65) data.flakeStrength = this.flakeStrength;
        if (this.flakeHueJitter !== 0.04) data.flakeHueJitter = this.flakeHueJitter;
        if (this.flakeSparkleIntensity !== 0.55) data.flakeSparkleIntensity = this.flakeSparkleIntensity;
        if (this.flakeHueColor.getHex() !== new Color(0.95, 0.95, 1.0).getHex()) data.flakeHueColor = this.flakeHueColor.getHex();
        if (this.clearcoatMottle !== 0.03) data.clearcoatMottle = this.clearcoatMottle;
        if (this.brushedStrength !== 0.0) data.brushedStrength = this.brushedStrength;
        if (this.metallicSpecularTint !== 1.0) data.metallicSpecularTint = this.metallicSpecularTint;
        if (this.rimGlow !== 0.14) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 0.95, 0.90).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.flakeDensity = json.flakeDensity ?? this.flakeDensity;
        this.flakeStrength = json.flakeStrength ?? this.flakeStrength;
        this.flakeHueJitter = json.flakeHueJitter ?? this.flakeHueJitter;
        this.flakeSparkleIntensity = json.flakeSparkleIntensity ?? this.flakeSparkleIntensity;
        if (json.flakeHueColor !== undefined) this.flakeHueColor.setHex(json.flakeHueColor);
        this.clearcoatMottle = json.clearcoatMottle ?? this.clearcoatMottle;
        this.brushedStrength = json.brushedStrength ?? this.brushedStrength;
        this.metallicSpecularTint = json.metallicSpecularTint ?? this.metallicSpecularTint;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const CarMetallicPaintMaterialBatchComponent = {
    materialPtr: 'ui32',
    paintBands: 'ui8',
    paintQuantize: 'f64',
    paintSoftness: 'f64',
    flakeDensity: 'f64',
    flakeStrength: 'f64',
    flakeHueJitter: 'f64',
    flakeSparkleIntensity: 'f64',
    clearcoatMottle: 'f64',
    brushedStrength: 'f64',
    metallicSpecularTint: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    CarMetallicPaintMaterial,
    CarMetallicPaintMaterialBatch,
    CarMetallicPaintScratchPool,
    CarMetallicPaintMaterialBatchComponent,
    CarMetallicPaintPresets,
    applyMetallicPaintCelBanding,
    gradeMetallicPaintColor,
    generateMetallicFlakeTexture
};

export default CarMetallicPaintMaterial;