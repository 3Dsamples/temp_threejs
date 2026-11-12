// file number : 249
// full path name : src/materials/249_icebasematerial.js
// description : IceBaseMaterial — foundational ice material for real-time
//               rendering of transparent and translucent ice surfaces.
//               Extends MeshPhysicalMaterial with purpose-built defaults
//               matching published ice PBR references: IOR 1.31, high
//               transmission 0.85–0.98, low roughness 0.03–0.15 for clear ice,
//               clearcoat for the wet surface, Beer-Lambert attenuation for
//               the subtle blue-green depth tint, and chromatic dispersion
//               for the rainbow edge shift. Adds ice-specific features:
//               subsurface scatter approximation, bubble-inclusion texture
//               generation, frost roughness modulation, cel-banded ice
//               highlights, mood tinting, rim glow, and per-instance
//               variation. All imports resolve to the internal Threejs_gl
//               repository tree; no CDN dependencies.
// best for : Base ice material for clear ice cubes, glacier ice, frozen
//            lakes, ice crystals, frost, snow, ice sculptures, and any
//            transparent/translucent ice surface that needs real-time PBR +
//            anime stylization.
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

/** @type {Quat} Scratch quaternion for rotation staging. */
const _scratchQuat = new Quat();

// ---------------------------------------------------------------------------
// Ice base presets — physically grounded PBR parameter sets for ice types.
//
// Reference values:
//   - Ice IOR:                     1.309–1.31 (standard)
//   - Clear ice roughness:         0.0–0.1 (polished)
//   - Frosted/cloudy ice roughness: 0.3–0.6
//   - Transmission:                0.85–0.98 for clear ice
//   - Attenuation colour:          subtle blue-green (Beer-Lambert)
//   - Clearcoat:                   0.3–0.8 for wet ice
//   - Dispersion:                  subtle rainbow edge shift
//   - Bubbles/inclusions:          enhance visual authenticity
// ---------------------------------------------------------------------------

const IceBasePresets = {
    'clear-ice': {
        color: [0.92, 0.96, 0.98],
        roughness: 0.05,
        metalness: 0.0,
        clearcoat: 0.60,
        clearcoatRoughness: 0.05,
        transmission: 0.96,
        thickness: 0.20,
        attenuationDistance: 0.60,
        attenuationColor: [0.82, 0.94, 0.96],
        ior: 1.31,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 0.85,
        specularColor: [1.0, 1.0, 1.0],
        dispersionStrength: 0.12,
        bubbleDensity: 0.08,
        frostStrength: 0.0
    },
    'frosted-ice': {
        color: [0.90, 0.94, 0.97],
        roughness: 0.38,
        metalness: 0.0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.30,
        transmission: 0.82,
        thickness: 0.18,
        attenuationDistance: 0.50,
        attenuationColor: [0.80, 0.92, 0.95],
        ior: 1.31,
        iridescence: 0.05,
        iridescenceIOR: 1.32,
        iridescenceThicknessRange: [120, 450],
        specularIntensity: 0.65,
        specularColor: [0.96, 0.98, 1.0],
        dispersionStrength: 0.06,
        bubbleDensity: 0.15,
        frostStrength: 0.45
    },
    'glacier-ice': {
        color: [0.78, 0.86, 0.92],
        roughness: 0.22,
        metalness: 0.0,
        clearcoat: 0.45,
        clearcoatRoughness: 0.18,
        transmission: 0.88,
        thickness: 0.35,
        attenuationDistance: 0.30,
        attenuationColor: [0.60, 0.78, 0.86],
        ior: 1.31,
        iridescence: 0.10,
        iridescenceIOR: 1.35,
        iridescenceThicknessRange: [150, 500],
        specularIntensity: 0.75,
        specularColor: [0.92, 0.98, 1.0],
        dispersionStrength: 0.10,
        bubbleDensity: 0.25,
        frostStrength: 0.20
    },
    'wet-ice': {
        color: [0.94, 0.97, 0.99],
        roughness: 0.08,
        metalness: 0.0,
        clearcoat: 0.85,
        clearcoatRoughness: 0.03,
        transmission: 0.94,
        thickness: 0.22,
        attenuationDistance: 0.55,
        attenuationColor: [0.84, 0.94, 0.97],
        ior: 1.31,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 0.90,
        specularColor: [1.0, 1.0, 1.0],
        dispersionStrength: 0.14,
        bubbleDensity: 0.05,
        frostStrength: 0.0
    },
    'anime-ice': {
        color: [0.90, 0.95, 0.98],
        roughness: 0.03,
        metalness: 0.0,
        clearcoat: 0.95,
        clearcoatRoughness: 0.02,
        transmission: 0.97,
        thickness: 0.20,
        attenuationDistance: 0.65,
        attenuationColor: [0.85, 0.95, 1.0],
        ior: 1.31,
        iridescence: 0.20,
        iridescenceIOR: 1.38,
        iridescenceThicknessRange: [180, 550],
        specularIntensity: 0.95,
        specularColor: [1.0, 0.99, 1.0],
        dispersionStrength: 0.18,
        bubbleDensity: 0.06,
        frostStrength: 0.0
    },
    'black-ice': {
        color: [0.08, 0.10, 0.12],
        roughness: 0.06,
        metalness: 0.0,
        clearcoat: 0.90,
        clearcoatRoughness: 0.03,
        transmission: 0.92,
        thickness: 0.18,
        attenuationDistance: 0.15,
        attenuationColor: [0.10, 0.14, 0.18],
        ior: 1.31,
        iridescence: 0.0,
        iridescenceIOR: 1.30,
        iridescenceThicknessRange: [100, 400],
        specularIntensity: 0.88,
        specularColor: [0.85, 0.90, 1.0],
        dispersionStrength: 0.08,
        bubbleDensity: 0.02,
        frostStrength: 0.0
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable ice scratch records
// ---------------------------------------------------------------------------

class IceBaseScratchPool {
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

/** @type {IceBaseScratchPool} */
const _iceBaseScratchPool = new IceBaseScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — ice-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded ice highlights. Ice has extremely crisp specular edges
 * under clearcoat — quantizing the luminance into discrete bands produces
 * the flat anime ice shine.
 * @param {Color} baseColor
 * @param {Color} output - Modified in place.
 * @param {number} bands
 * @param {number} quantizeAmount
 * @param {number} [softness=0.04]
 * @returns {Color}
 */
function applyIceCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.04) {
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
 * Apply mood-based tinting to ice. Warm moods push ice toward warm amber
 * sunlit tint, cool moods toward cool arctic blue — matching the atmospheric
 * ice tinting in stylized scenes.
 * @param {Color} color - Modified in place.
 * @param {number} temperature
 * @param {number} saturation
 * @param {number} brightness
 * @param {number} contrast
 * @returns {Color}
 */
function gradeIceColor(color, temperature, saturation, brightness, contrast) {
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

    // Ice-specific temperature bias: warm shift pushes toward amber sunlit
    // tint; cool shift pushes toward arctic blue.
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
 * Generate a procedural ice-bubble texture. The algorithm:
 * 1. Hashed bubble cells: per-cell presence, jittered centre, radial falloff
 *    producing the trapped-air-bubble look.
 * 2. Per-bubble highlight: bright inner ring for the bubble specular.
 * 3. Frost crystals: high-frequency noise for the surface frost texture.
 * 4. Fine body mottle: low-frequency fBm for the ice body tone.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 * @param {number} width
 * @param {number} height
 * @param {number} [bubbleDensity=0.08]
 * @param {number} [bubbleSize=0.35]
 * @param {number} [frostStrength=0.0]
 * @param {number} [mottleStrength=0.06]
 * @returns {Uint8Array}
 */
function generateIceBubbleTexture(width, height, bubbleDensity = 0.08, bubbleSize = 0.35, frostStrength = 0.0, mottleStrength = 0.06) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Hashed bubble cells ---
            const cellX = Math.floor(x * 0.2);
            const cellY = Math.floor(y * 0.2);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const cellHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;

            let bubble = 0;
            if (cellHash > (1.0 - bubbleDensity)) {
                const h2 = Math.abs(Math.sin(cellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                const h3 = Math.abs(Math.sin(cellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                const cx = (x * 0.2) - cellX - h2;
                const cy = (y * 0.2) - cellY - h3;
                const dist = Math.sqrt(cx * cx + cy * cy);
                bubble = Math.max(0, 1.0 - dist / bubbleSize) * 0.30;
            }

            // --- 2. Frost crystals ---
            let frost = 0;
            if (frostStrength > 0) {
                const frostNoise = SimplexNoise.noise2D(x * 0.8, y * 0.8) * 0.5 + 0.5;
                frost = frostNoise * frostStrength * 0.25;
            }

            // --- 3. Fine body mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.05, y * 0.05) * mottleStrength;

            // --- Combine ---
            let value = 0.55 + bubble + frost + mottle;
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

const _iceBaseWorld = BitECS.createWorld();
const IceBaseMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    iceBands: 'ui8',
    iceQuantize: 'f64',
    iceSoftness: 'f64',
    dispersionStrength: 'f64',
    dispersionColorR: 'f64',
    dispersionColorG: 'f64',
    dispersionColorB: 'f64',
    bubbleDensity: 'f64',
    bubbleSize: 'f64',
    frostStrength: 'f64',
    mottleStrength: 'f64',
    internalGlowIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class IceBaseMaterialBatch {
    constructor() {
        this.world = _iceBaseWorld;
        /** @type {IceBaseMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * @param {IceBaseMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, IceBaseMaterialComponent, eid);
        IceBaseMaterialComponent.materialPtr[eid] = this.materials.length;
        IceBaseMaterialComponent.iceBands[eid] = material.iceBands;
        IceBaseMaterialComponent.iceQuantize[eid] = material.iceQuantize;
        IceBaseMaterialComponent.iceSoftness[eid] = material.iceSoftness;
        IceBaseMaterialComponent.dispersionStrength[eid] = material.dispersionStrength;
        IceBaseMaterialComponent.dispersionColorR[eid] = material.dispersionColor.r;
        IceBaseMaterialComponent.dispersionColorG[eid] = material.dispersionColor.g;
        IceBaseMaterialComponent.dispersionColorB[eid] = material.dispersionColor.b;
        IceBaseMaterialComponent.bubbleDensity[eid] = material.bubbleDensity;
        IceBaseMaterialComponent.bubbleSize[eid] = material.bubbleSize;
        IceBaseMaterialComponent.frostStrength[eid] = material.frostStrength;
        IceBaseMaterialComponent.mottleStrength[eid] = material.mottleStrength;
        IceBaseMaterialComponent.internalGlowIntensity[eid] = material.internalGlowIntensity;
        IceBaseMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        IceBaseMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        IceBaseMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        IceBaseMaterialComponent.moodContrast[eid] = material.moodContrast;
        IceBaseMaterialComponent.rimGlow[eid] = material.rimGlow;
        IceBaseMaterialComponent.variationSeed[eid] = material.variationSeed;
        IceBaseMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[IceBaseMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.iceBands = IceBaseMaterialComponent.iceBands[eid];
            material.iceQuantize = IceBaseMaterialComponent.iceQuantize[eid];
            material.iceSoftness = IceBaseMaterialComponent.iceSoftness[eid];
            material.dispersionStrength = IceBaseMaterialComponent.dispersionStrength[eid];
            material.dispersionColor.setRGB(
                IceBaseMaterialComponent.dispersionColorR[eid],
                IceBaseMaterialComponent.dispersionColorG[eid],
                IceBaseMaterialComponent.dispersionColorB[eid],
                ColorManagement.workingColorSpace
            );
            material.bubbleDensity = IceBaseMaterialComponent.bubbleDensity[eid];
            material.bubbleSize = IceBaseMaterialComponent.bubbleSize[eid];
            material.frostStrength = IceBaseMaterialComponent.frostStrength[eid];
            material.mottleStrength = IceBaseMaterialComponent.mottleStrength[eid];
            material.internalGlowIntensity = IceBaseMaterialComponent.internalGlowIntensity[eid];
            material.moodTemperature = IceBaseMaterialComponent.moodTemperature[eid];
            material.moodSaturation = IceBaseMaterialComponent.moodSaturation[eid];
            material.moodBrightness = IceBaseMaterialComponent.moodBrightness[eid];
            material.moodContrast = IceBaseMaterialComponent.moodContrast[eid];
            material.rimGlow = IceBaseMaterialComponent.rimGlow[eid];
            material.variationSeed = IceBaseMaterialComponent.variationSeed[eid];

            IceBaseMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main IceBaseMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use ice material for real-time rendering of transparent and
 * translucent ice surfaces. Extends MeshPhysicalMaterial with ice-specific
 * PBR defaults and real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class IceBaseMaterial extends MeshPhysicalMaterial {
    static {
        _iceBaseScratchPool.warm(32);
    }

    /**
     * @param {Object} [parameters]
     */
    constructor(parameters) {
        super();

        this.isIceBaseMaterial = true;
        this.type = 'IceBaseMaterial';

        // -------------------------------------------------------------------
        // Ice-specific PBR defaults (clear-ice baseline)
        // -------------------------------------------------------------------
        this.ior = 1.31;                    // standard ice IOR
        this.specularIntensity = 0.85;
        this.roughness = 0.05;
        this.metalness = 0.0;
        this.specularColor = new Color(1.0, 1.0, 1.0);
        this.color = new Color(0.92, 0.96, 0.98);

        // Clearcoat for the wet surface
        this.clearcoat = 0.60;
        this.clearcoatRoughness = 0.05;

        // High transmission for the transparent body
        this.transmission = 0.96;
        this.thickness = 0.20;
        this.attenuationDistance = 0.60;
        this.attenuationColor = new Color(0.82, 0.94, 0.96);

        // Iridescence (off by default; enable for anime-ice)
        this.iridescence = 0.0;
        this.iridescenceIOR = 1.30;
        this.iridescenceThicknessRange = [100, 400];

        // Sheen off
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — ice-specific
        // -------------------------------------------------------------------
        this.iceBands = 4;
        this.iceQuantize = 0.5;
        this.iceSoftness = 0.04;

        // Dispersion approximation (rainbow edge shift)
        this.dispersionStrength = 0.12;
        this.dispersionColor = new Color(0.82, 0.94, 1.0);

        // Bubble / frost / mottle controls
        this.bubbleDensity = 0.08;
        this.bubbleSize = 0.35;
        this.frostStrength = 0.0;
        this.mottleStrength = 0.06;
        this.internalGlowIntensity = 0.15;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(0.85, 0.95, 1.0);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend
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
    applyIceBanding(baseColor, output) {
        return applyIceCelBanding(
            baseColor,
            output,
            this.iceBands,
            this.iceQuantize,
            this.iceSoftness
        );
    }

    /**
     * @returns {IceBaseMaterial}
     */
    updateMoodColor() {
        gradeIceColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named ice preset.
     * @param {string} presetName - One of the keys of `IceBasePresets`.
     * @returns {IceBaseMaterial}
     */
    applyPreset(presetName) {
        const preset = IceBasePresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;
        this.transmission = preset.transmission;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);
        this.ior = preset.ior;
        this.iridescence = preset.iridescence;
        this.iridescenceIOR = preset.iridescenceIOR;
        this.iridescenceThicknessRange = preset.iridescenceThicknessRange.slice();
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.dispersionStrength = preset.dispersionStrength;
        this.bubbleDensity = preset.bubbleDensity;
        this.frostStrength = preset.frostStrength;

        // Per-preset anime tuning
        if (presetName === 'clear-ice') {
            this.iceSoftness = 0.03;
            this.iceBands = 4;
        } else if (presetName === 'frosted-ice') {
            this.iceSoftness = 0.14;
            this.iceBands = 3;
        } else if (presetName === 'glacier-ice') {
            this.iceSoftness = 0.08;
            this.iceBands = 3;
        } else if (presetName === 'wet-ice') {
            this.iceSoftness = 0.02;
            this.iceBands = 4;
        } else if (presetName === 'anime-ice') {
            this.iceSoftness = 0.02;
            this.iceBands = 5;
        } else if (presetName === 'black-ice') {
            this.iceSoftness = 0.04;
            this.iceBands = 4;
        }

        this.updateMoodColor();
        return this;
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} [bubbleDensity=0.08]
     * @param {number} [bubbleSize=0.35]
     * @param {number} [frostStrength=0.0]
     * @returns {Uint8Array}
     */
    generateIceBubbleTexture(width, height, bubbleDensity = 0.08, bubbleSize = 0.35, frostStrength = 0.0) {
        return generateIceBubbleTexture(width, height, bubbleDensity, bubbleSize, frostStrength, this.mottleStrength);
    }

    /**
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * @returns {Promise<IceBaseMaterial>}
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

        shader.uniforms.iceBands = { value: this.iceBands };
        shader.uniforms.iceQuantize = { value: this.iceQuantize };
        shader.uniforms.iceSoftness = { value: this.iceSoftness };
        shader.uniforms.dispersionStrength = { value: this.dispersionStrength };
        shader.uniforms.dispersionColor = { value: this.dispersionColor };
        shader.uniforms.bubbleDensity = { value: this.bubbleDensity };
        shader.uniforms.bubbleSize = { value: this.bubbleSize };
        shader.uniforms.frostStrength = { value: this.frostStrength };
        shader.uniforms.mottleStrength = { value: this.mottleStrength };
        shader.uniforms.internalGlowIntensity = { value: this.internalGlowIntensity };
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
                uniform int iceBands;
                uniform float iceQuantize;
                uniform float iceSoftness;
                uniform float dispersionStrength;
                uniform vec3 dispersionColor;
                uniform float bubbleDensity;
                uniform float bubbleSize;
                uniform float frostStrength;
                uniform float mottleStrength;
                uniform float internalGlowIntensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyIceBands(vec3 baseColor) {
                    if (iceBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(iceBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * iceSoftness;
                    float finalLum = mix(lum, softQuantized, iceQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply ice cel banding
                gl_FragColor.rgb = applyIceBands(gl_FragColor.rgb);

                // Dispersion approximation: subtle rainbow shift at grazing angles
                if (dispersionStrength > 0.0) {
                    float ndotvIce = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float dispersionMask = pow(1.0 - ndotvIce, 2.0) * dispersionStrength;
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * dispersionColor * 1.15, dispersionMask);
                }

                // Bubble inclusion approximation: hashed bubble cells
                if (bubbleDensity > 0.0) {
                    vec2 bubbleUV = vUv * 40.0;
                    vec2 bubbleCell = floor(bubbleUV);
                    vec2 bubbleFrac = fract(bubbleUV);
                    float bubbleHash = fract(sin(dot(bubbleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (bubbleHash > (1.0 - bubbleDensity)) {
                        vec2 bubbleCentre = vec2(fract(bubbleHash * 7.31), fract(bubbleHash * 13.7));
                        float bubbleDist = length(bubbleFrac - bubbleCentre);
                        float bubbleMask = max(0.0, 1.0 - bubbleDist / bubbleSize) * 0.20;
                        gl_FragColor.rgb += vec3(bubbleMask);
                    }
                }

                // Frost crystal approximation
                if (frostStrength > 0.0) {
                    float frost = sin(vUv.x * 100.0 + variationOffset) * cos(vUv.y * 100.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + frost * frostStrength * 0.10);
                }

                // Internal glow
                if (internalGlowIntensity > 0.0) {
                    gl_FragColor.rgb += dispersionColor * internalGlowIntensity * 0.10;
                }

                // Cool rim glow on ice edges
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
            this.transmission, this.thickness, this.attenuationDistance,
            this.iridescence, this.iridescenceIOR,
            this.iceBands, this.iceQuantize, this.iceSoftness,
            this.dispersionStrength, this.dispersionColor.r,
            this.bubbleDensity, this.bubbleSize, this.frostStrength,
            this.mottleStrength, this.internalGlowIntensity,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    /**
     * @param {IceBaseMaterial} source
     * @returns {IceBaseMaterial}
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
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.iridescence = source.iridescence;
        this.iridescenceIOR = source.iridescenceIOR;
        this.iridescenceThicknessRange = source.iridescenceThicknessRange.slice();
        this.iceBands = source.iceBands;
        this.iceQuantize = source.iceQuantize;
        this.iceSoftness = source.iceSoftness;
        this.dispersionStrength = source.dispersionStrength;
        this.dispersionColor.copy(source.dispersionColor);
        this.bubbleDensity = source.bubbleDensity;
        this.bubbleSize = source.bubbleSize;
        this.frostStrength = source.frostStrength;
        this.mottleStrength = source.mottleStrength;
        this.internalGlowIntensity = source.internalGlowIntensity;
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
        data.type = 'IceBaseMaterial';
        if (this.ior !== 1.31) data.ior = this.ior;
        if (this.specularIntensity !== 0.85) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.05) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.60) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.05) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.96) data.transmission = this.transmission;
        if (this.thickness !== 0.20) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.60) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.82, 0.94, 0.96).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.specularColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.iridescence !== 0.0) data.iridescence = this.iridescence;
        if (this.iridescenceIOR !== 1.30) data.iridescenceIOR = this.iridescenceIOR;
        if (this.iceBands !== 4) data.iceBands = this.iceBands;
        if (this.iceQuantize !== 0.5) data.iceQuantize = this.iceQuantize;
        if (this.iceSoftness !== 0.04) data.iceSoftness = this.iceSoftness;
        if (this.dispersionStrength !== 0.12) data.dispersionStrength = this.dispersionStrength;
        if (this.dispersionColor.getHex() !== new Color(0.82, 0.94, 1.0).getHex()) data.dispersionColor = this.dispersionColor.getHex();
        if (this.bubbleDensity !== 0.08) data.bubbleDensity = this.bubbleDensity;
        if (this.bubbleSize !== 0.35) data.bubbleSize = this.bubbleSize;
        if (this.frostStrength !== 0.0) data.frostStrength = this.frostStrength;
        if (this.mottleStrength !== 0.06) data.mottleStrength = this.mottleStrength;
        if (this.internalGlowIntensity !== 0.15) data.internalGlowIntensity = this.internalGlowIntensity;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.95, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;
        return data;
    }

    /**
     * @param {Object} json
     * @returns {IceBaseMaterial}
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
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.iridescence = json.iridescence ?? this.iridescence;
        this.iridescenceIOR = json.iridescenceIOR ?? this.iridescenceIOR;
        if (json.iridescenceThicknessRange) this.iridescenceThicknessRange = json.iridescenceThicknessRange.slice();
        this.iceBands = json.iceBands ?? this.iceBands;
        this.iceQuantize = json.iceQuantize ?? this.iceQuantize;
        this.iceSoftness = json.iceSoftness ?? this.iceSoftness;
        this.dispersionStrength = json.dispersionStrength ?? this.dispersionStrength;
        if (json.dispersionColor !== undefined) this.dispersionColor.setHex(json.dispersionColor);
        this.bubbleDensity = json.bubbleDensity ?? this.bubbleDensity;
        this.bubbleSize = json.bubbleSize ?? this.bubbleSize;
        this.frostStrength = json.frostStrength ?? this.frostStrength;
        this.mottleStrength = json.mottleStrength ?? this.mottleStrength;
        this.internalGlowIntensity = json.internalGlowIntensity ?? this.internalGlowIntensity;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const IceBaseMaterialBatchComponent = {
    materialPtr: 'ui32',
    iceBands: 'ui8',
    iceQuantize: 'f64',
    iceSoftness: 'f64',
    dispersionStrength: 'f64',
    dispersionColorR: 'f64',
    dispersionColorG: 'f64',
    dispersionColorB: 'f64',
    bubbleDensity: 'f64',
    bubbleSize: 'f64',
    frostStrength: 'f64',
    mottleStrength: 'f64',
    internalGlowIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    IceBaseMaterial,
    IceBaseMaterialBatch,
    IceBaseScratchPool,
    IceBaseMaterialBatchComponent,
    IceBasePresets,
    applyIceCelBanding,
    gradeIceColor,
    generateIceBubbleTexture
};

export default IceBaseMaterial;