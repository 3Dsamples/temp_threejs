// file number : 250
// full path name : src/materials/250_iceglaciermaterial.js
// description : IceGlacierMaterial — a ready-to-use glacier-ice material for
//               real-time rendering of dense, blue-tinted glacier ice with
//               internal fractures, bubble layers, and the characteristic
//               deep-cyan glacial falloff. Extends IceBaseMaterial with
//               glacier-specific presets: deep glacier blue, layered glacier
//               ice, crevasse ice, compressed firn ice, and anime glacier.
//               Uses physically grounded defaults from the ice-shader and
//               glacial-optics literature: IOR 1.31, shorter attenuation
//               distance (0.15–0.30) for the dense blue ice body, deeper
//               attenuation colour (cyan/teal), moderate roughness
//               (0.10–0.22) for the compacted surface, and a slightly reduced
//               transmission (0.82–0.92) because internal bubbles and
//               fractures scatter the light path. Adds real-time anime
//               stylization: cel-banded glacier highlights, layered bubble-band
//               approximation, internal fracture-plane approximation, mood
//               tinting, rim glow, and per-instance variation. Includes a
//               procedural glacier-layer texture generator using multi-octave
//               fBm with horizontal bubble bands, fracture streaks, and
//               compacted-layer mottle.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Glacier ice, deep glacier blue, layered glacier ice, crevasse
//            ice, compressed firn ice, arctic ice fields, frozen glacial
//            lakes, anime glacier environments, and any dense glacial-ice
//            surface that needs real-time PBR + anime stylization.
// license : MIT

import { IceBaseMaterial } from './249_icebasematerial.js';
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
// Glacier-ice presets — physically grounded PBR parameter sets for glacier
// ice types.
//
// Reference values (from the mr_cool_ice shader by Salas, glacial-optics
// literature, and the NormalMap.ai snow/glacial PBR matrix):
//   - Ice IOR:                       1.31
//   - Glacier-ice roughness:         0.10–0.22 (compacted, partially
//                                    refrozen surface; higher than clear ice)
//   - Transmission:                  0.82–0.92 (internal bubbles and
//                                    fractures reduce the clear path)
//   - Attenuation distance:          0.15–0.30 (short because glacier ice
//                                    absorbs strongly in the red band,
//                                    yielding the deep blue tint)
//   - Attenuation colour:            deep cyan-teal (0.35–0.75, 0.70–0.92,
//                                    0.85–1.0)
//   - Clearcoat:                     0.35–0.60 (partially wet glacial
//                                    surface)
//   - Bubble layers:                 horizontal bands of trapped air
//   - Fractures:                     internal cleavage planes
// ---------------------------------------------------------------------------

const IceGlacierPresets = {
    'deep-glacier-blue': {
        color: [0.68, 0.82, 0.92],
        roughness: 0.14,
        metalness: 0.0,
        clearcoat: 0.50,
        clearcoatRoughness: 0.10,
        transmission: 0.90,
        thickness: 0.30,
        attenuationDistance: 0.18,
        attenuationColor: [0.40, 0.72, 0.88],
        ior: 1.31,
        iridescence: 0.08,
        iridescenceIOR: 1.35,
        iridescenceThicknessRange: [150, 500],
        specularIntensity: 0.78,
        specularColor: [0.92, 0.98, 1.0],
        dispersionStrength: 0.08,
        bubbleDensity: 0.22,
        frostStrength: 0.10
    },
    'layered-glacier-ice': {
        color: [0.72, 0.84, 0.92],
        roughness: 0.16,
        metalness: 0.0,
        clearcoat: 0.45,
        clearcoatRoughness: 0.12,
        transmission: 0.88,
        thickness: 0.35,
        attenuationDistance: 0.20,
        attenuationColor: [0.45, 0.75, 0.90],
        ior: 1.31,
        iridescence: 0.10,
        iridescenceIOR: 1.36,
        iridescenceThicknessRange: [160, 520],
        specularIntensity: 0.76,
        specularColor: [0.90, 0.96, 1.0],
        dispersionStrength: 0.09,
        bubbleDensity: 0.28,
        frostStrength: 0.15
    },
    'crevasse-ice': {
        color: [0.60, 0.76, 0.88],
        roughness: 0.20,
        metalness: 0.0,
        clearcoat: 0.40,
        clearcoatRoughness: 0.16,
        transmission: 0.84,
        thickness: 0.40,
        attenuationDistance: 0.15,
        attenuationColor: [0.35, 0.65, 0.85],
        ior: 1.31,
        iridescence: 0.12,
        iridescenceIOR: 1.38,
        iridescenceThicknessRange: [180, 560],
        specularIntensity: 0.72,
        specularColor: [0.88, 0.95, 1.0],
        dispersionStrength: 0.10,
        bubbleDensity: 0.35,
        frostStrength: 0.20
    },
    'compressed-firn': {
        color: [0.76, 0.86, 0.94],
        roughness: 0.12,
        metalness: 0.0,
        clearcoat: 0.55,
        clearcoatRoughness: 0.08,
        transmission: 0.92,
        thickness: 0.28,
        attenuationDistance: 0.25,
        attenuationColor: [0.50, 0.78, 0.92],
        ior: 1.31,
        iridescence: 0.06,
        iridescenceIOR: 1.34,
        iridescenceThicknessRange: [140, 480],
        specularIntensity: 0.80,
        specularColor: [0.94, 0.99, 1.0],
        dispersionStrength: 0.07,
        bubbleDensity: 0.15,
        frostStrength: 0.05
    },
    'anime-glacier': {
        color: [0.72, 0.86, 0.96],
        roughness: 0.10,
        metalness: 0.0,
        clearcoat: 0.65,
        clearcoatRoughness: 0.06,
        transmission: 0.94,
        thickness: 0.30,
        attenuationDistance: 0.22,
        attenuationColor: [0.48, 0.80, 0.96],
        ior: 1.31,
        iridescence: 0.20,
        iridescenceIOR: 1.40,
        iridescenceThicknessRange: [200, 600],
        specularIntensity: 0.88,
        specularColor: [0.96, 1.0, 1.0],
        dispersionStrength: 0.16,
        bubbleDensity: 0.18,
        frostStrength: 0.08
    },
    'arctic-blue-ice': {
        color: [0.62, 0.78, 0.90],
        roughness: 0.18,
        metalness: 0.0,
        clearcoat: 0.42,
        clearcoatRoughness: 0.14,
        transmission: 0.86,
        thickness: 0.38,
        attenuationDistance: 0.16,
        attenuationColor: [0.38, 0.68, 0.86],
        ior: 1.31,
        iridescence: 0.09,
        iridescenceIOR: 1.37,
        iridescenceThicknessRange: [170, 540],
        specularIntensity: 0.74,
        specularColor: [0.90, 0.96, 1.0],
        dispersionStrength: 0.08,
        bubbleDensity: 0.30,
        frostStrength: 0.18
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable glacier scratch records
// ---------------------------------------------------------------------------

class IceGlacierScratchPool {
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

/** @type {IceGlacierScratchPool} */
const _iceGlacierScratchPool = new IceGlacierScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — glacier-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded glacier highlights. Glacier ice has crisp specular edges
 * on its compacted surface — quantizing the luminance into discrete bands
 * produces the flat anime glacier shine.
 * @param {Color} baseColor
 * @param {Color} output - Modified in place.
 * @param {number} bands
 * @param {number} quantizeAmount
 * @param {number} [softness=0.06]
 * @returns {Color}
 */
function applyGlacierCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.06) {
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
 * Apply mood-based tinting to glacier ice. Warm moods push the ice toward
 * warm sunlit glacial tint, cool moods toward deep arctic blue — matching
 * the atmospheric glacier tinting in stylized alpine scenes.
 * @param {Color} color - Modified in place.
 * @param {number} temperature
 * @param {number} saturation
 * @param {number} brightness
 * @param {number} contrast
 * @returns {Color}
 */
function gradeGlacierColor(color, temperature, saturation, brightness, contrast) {
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

    // Glacier-specific temperature bias: warm shift pushes toward sunlit
    // glacial tint; cool shift pushes toward deep arctic blue.
    r += temperature * 0.028;
    g += temperature * 0.010;
    b -= temperature * 0.028;

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
 * Generate a procedural glacier-layer texture. The algorithm:
 * 1. Horizontal bubble bands: low-frequency sinusoid combined with fBm
 *    produces the characteristic horizontal bubble layers of glacier ice.
 * 2. Internal fracture streaks: directional noise stretched along the
 *    fracture direction, producing the cleavage planes.
 * 3. Compacted-layer mottle: multi-octave fBm for the dense blue ice body.
 * 4. Fine micro-grain: high-frequency noise for the compacted surface
 *    texture.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.02]
 * @param {number} [octaves=4]
 * @param {number} [bandFrequency=6.0]
 * @param {number} [bandStrength=0.30]
 * @param {number} [fractureStrength=0.20]
 * @param {number} [fractureDensity=8.0]
 * @param {number} [mottleStrength=0.08]
 * @returns {Uint8Array}
 */
function generateGlacierLayerTexture(width, height, scale = 0.02, octaves = 4, bandFrequency = 6.0, bandStrength = 0.30, fractureStrength = 0.20, fractureDensity = 8.0, mottleStrength = 0.08) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Horizontal bubble bands ---
            let fbm = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;
            for (let o = 0; o < octaves; o++) {
                fbm += SimplexNoise.noise2D(x * frequency * 0.4, y * frequency * 2.0) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;

            const band = Math.sin((y / height) * bandFrequency * Math.PI * 2.0) * 0.5 + 0.5;
            const bubbleBand = (fbm * 0.6 + band * 0.4) * bandStrength;

            // --- 2. Internal fracture streaks ---
            const fracture = SimplexNoise.noise2D(x * 0.01 * fractureDensity, y * 0.20 * fractureDensity) * 0.5 + 0.5;
            const fractureMask = Math.pow(1.0 - Math.abs(fracture * 2.0 - 1.0), 3.0) * fractureStrength;

            // --- 3. Compacted-layer mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.01, y * 0.01) * mottleStrength;

            // --- 4. Fine micro-grain ---
            const grain = SimplexNoise.noise2D(x * 0.7, y * 0.7) * 0.04;

            // --- Combine ---
            let value = 0.55
                + bubbleBand * 0.30
                - fractureMask * 0.20
                + mottle
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

const _iceGlacierWorld = BitECS.createWorld();
const IceGlacierMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    glacierBands: 'ui8',
    glacierQuantize: 'f64',
    glacierSoftness: 'f64',
    bubbleBandFrequency: 'f64',
    bubbleBandStrength: 'f64',
    fractureStrength: 'f64',
    fractureDensity: 'f64',
    layerMottle: 'f64',
    internalGlowIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class IceGlacierMaterialBatch {
    constructor() {
        this.world = _iceGlacierWorld;
        /** @type {IceGlacierMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * @param {IceGlacierMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, IceGlacierMaterialComponent, eid);
        IceGlacierMaterialComponent.materialPtr[eid] = this.materials.length;
        IceGlacierMaterialComponent.glacierBands[eid] = material.glacierBands;
        IceGlacierMaterialComponent.glacierQuantize[eid] = material.glacierQuantize;
        IceGlacierMaterialComponent.glacierSoftness[eid] = material.glacierSoftness;
        IceGlacierMaterialComponent.bubbleBandFrequency[eid] = material.bubbleBandFrequency;
        IceGlacierMaterialComponent.bubbleBandStrength[eid] = material.bubbleBandStrength;
        IceGlacierMaterialComponent.fractureStrength[eid] = material.fractureStrength;
        IceGlacierMaterialComponent.fractureDensity[eid] = material.fractureDensity;
        IceGlacierMaterialComponent.layerMottle[eid] = material.layerMottle;
        IceGlacierMaterialComponent.internalGlowIntensity[eid] = material.internalGlowIntensity;
        IceGlacierMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        IceGlacierMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        IceGlacierMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        IceGlacierMaterialComponent.moodContrast[eid] = material.moodContrast;
        IceGlacierMaterialComponent.rimGlow[eid] = material.rimGlow;
        IceGlacierMaterialComponent.variationSeed[eid] = material.variationSeed;
        IceGlacierMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[IceGlacierMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.glacierBands = IceGlacierMaterialComponent.glacierBands[eid];
            material.glacierQuantize = IceGlacierMaterialComponent.glacierQuantize[eid];
            material.glacierSoftness = IceGlacierMaterialComponent.glacierSoftness[eid];
            material.bubbleBandFrequency = IceGlacierMaterialComponent.bubbleBandFrequency[eid];
            material.bubbleBandStrength = IceGlacierMaterialComponent.bubbleBandStrength[eid];
            material.fractureStrength = IceGlacierMaterialComponent.fractureStrength[eid];
            material.fractureDensity = IceGlacierMaterialComponent.fractureDensity[eid];
            material.layerMottle = IceGlacierMaterialComponent.layerMottle[eid];
            material.internalGlowIntensity = IceGlacierMaterialComponent.internalGlowIntensity[eid];
            material.moodTemperature = IceGlacierMaterialComponent.moodTemperature[eid];
            material.moodSaturation = IceGlacierMaterialComponent.moodSaturation[eid];
            material.moodBrightness = IceGlacierMaterialComponent.moodBrightness[eid];
            material.moodContrast = IceGlacierMaterialComponent.moodContrast[eid];
            material.rimGlow = IceGlacierMaterialComponent.rimGlow[eid];
            material.variationSeed = IceGlacierMaterialComponent.variationSeed[eid];

            IceGlacierMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main IceGlacierMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use glacier-ice material for real-time rendering of dense,
 * blue-tinted glacier ice with internal fractures and bubble layers. Extends
 * IceBaseMaterial with glacier-specific PBR defaults and real-time anime
 * stylization.
 *
 * @augments IceBaseMaterial
 */
class IceGlacierMaterial extends IceBaseMaterial {
    static {
        _iceGlacierScratchPool.warm(32);
    }

    /**
     * @param {Object} [parameters]
     */
    constructor(parameters) {
        super();

        this.isIceGlacierMaterial = true;
        this.type = 'IceGlacierMaterial';

        // -------------------------------------------------------------------
        // Glacier-specific PBR defaults (deep-glacier-blue baseline)
        // -------------------------------------------------------------------
        this.ior = 1.31;
        this.specularIntensity = 0.78;
        this.roughness = 0.14;
        this.metalness = 0.0;
        this.specularColor = new Color(0.92, 0.98, 1.0);
        this.color = new Color(0.68, 0.82, 0.92);

        // Clearcoat for the partially wet glacial surface
        this.clearcoat = 0.50;
        this.clearcoatRoughness = 0.10;

        // Transmission and attenuation for the dense blue glacial body
        this.transmission = 0.90;
        this.thickness = 0.30;
        this.attenuationDistance = 0.18;
        this.attenuationColor = new Color(0.40, 0.72, 0.88);

        // Subtle iridescence
        this.iridescence = 0.08;
        this.iridescenceIOR = 1.35;
        this.iridescenceThicknessRange = [150, 500];

        // Sheen off
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — glacier-specific
        // -------------------------------------------------------------------
        this.glacierBands = 4;
        this.glacierQuantize = 0.5;
        this.glacierSoftness = 0.06;

        // Bubble-band / fracture / mottle controls
        this.bubbleBandFrequency = 6.0;
        this.bubbleBandStrength = 0.30;
        this.fractureStrength = 0.20;
        this.fractureDensity = 8.0;
        this.layerMottle = 0.08;
        this.internalGlowIntensity = 0.18;

        // Dispersion approximation
        this.dispersionStrength = 0.08;
        this.dispersionColor = new Color(0.55, 0.82, 1.0);

        // Bubble / frost overrides
        this.bubbleDensity = 0.22;
        this.bubbleSize = 0.35;
        this.frostStrength = 0.10;
        this.mottleStrength = 0.08;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.14;
        this.rimGlowColor = new Color(0.62, 0.88, 1.0);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (glacier leans semi-realistic)
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
    applyGlacierBanding(baseColor, output) {
        return applyGlacierCelBanding(
            baseColor,
            output,
            this.glacierBands,
            this.glacierQuantize,
            this.glacierSoftness
        );
    }

    /**
     * @returns {IceGlacierMaterial}
     */
    updateMoodColor() {
        gradeGlacierColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named glacier-ice preset.
     * @param {string} presetName - One of the keys of `IceGlacierPresets`.
     * @returns {IceGlacierMaterial}
     */
    applyPreset(presetName) {
        const preset = IceGlacierPresets[presetName];
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
        if (presetName === 'deep-glacier-blue') {
            this.glacierSoftness = 0.05;
            this.glacierBands = 4;
            this.bubbleBandStrength = 0.30;
            this.fractureStrength = 0.20;
        } else if (presetName === 'layered-glacier-ice') {
            this.glacierSoftness = 0.07;
            this.glacierBands = 4;
            this.bubbleBandStrength = 0.35;
            this.fractureStrength = 0.22;
        } else if (presetName === 'crevasse-ice') {
            this.glacierSoftness = 0.10;
            this.glacierBands = 3;
            this.bubbleBandStrength = 0.40;
            this.fractureStrength = 0.35;
        } else if (presetName === 'compressed-firn') {
            this.glacierSoftness = 0.04;
            this.glacierBands = 4;
            this.bubbleBandStrength = 0.20;
            this.fractureStrength = 0.15;
        } else if (presetName === 'anime-glacier') {
            this.glacierSoftness = 0.03;
            this.glacierBands = 5;
            this.bubbleBandStrength = 0.25;
            this.fractureStrength = 0.18;
        } else if (presetName === 'arctic-blue-ice') {
            this.glacierSoftness = 0.08;
            this.glacierBands = 3;
            this.bubbleBandStrength = 0.32;
            this.fractureStrength = 0.25;
        }

        this.updateMoodColor();
        return this;
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.02]
     * @param {number} [octaves=4]
     * @param {number} [bandFrequency=6.0]
     * @param {number} [bandStrength=0.30]
     * @param {number} [fractureStrength=0.20]
     * @param {number} [fractureDensity=8.0]
     * @returns {Uint8Array}
     */
    generateGlacierLayerTexture(width, height, scale = 0.02, octaves = 4, bandFrequency = 6.0, bandStrength = 0.30, fractureStrength = 0.20, fractureDensity = 8.0) {
        return generateGlacierLayerTexture(width, height, scale, octaves, bandFrequency, bandStrength, fractureStrength, fractureDensity, this.layerMottle);
    }

    /**
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * @returns {Promise<IceGlacierMaterial>}
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
        // Call the base IceBaseMaterial hook first
        super.onBeforeCompile(shader, renderer);

        // Inject glacier-specific uniforms
        shader.uniforms.glacierBands = { value: this.glacierBands };
        shader.uniforms.glacierQuantize = { value: this.glacierQuantize };
        shader.uniforms.glacierSoftness = { value: this.glacierSoftness };
        shader.uniforms.bubbleBandFrequency = { value: this.bubbleBandFrequency };
        shader.uniforms.bubbleBandStrength = { value: this.bubbleBandStrength };
        shader.uniforms.fractureStrength = { value: this.fractureStrength };
        shader.uniforms.fractureDensity = { value: this.fractureDensity };
        shader.uniforms.layerMottle = { value: this.layerMottle };
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
                uniform int glacierBands;
                uniform float glacierQuantize;
                uniform float glacierSoftness;
                uniform float bubbleBandFrequency;
                uniform float bubbleBandStrength;
                uniform float fractureStrength;
                uniform float fractureDensity;
                uniform float layerMottle;
                uniform float internalGlowIntensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyGlacierBands(vec3 baseColor) {
                    if (glacierBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(glacierBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * glacierSoftness;
                    float finalLum = mix(lum, softQuantized, glacierQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply glacier cel banding
                gl_FragColor.rgb = applyGlacierBands(gl_FragColor.rgb);

                // Horizontal bubble-band approximation
                if (bubbleBandStrength > 0.0) {
                    float band = sin(vUv.y * bubbleBandFrequency * 6.28318 + variationOffset) * 0.5 + 0.5;
                    float bubbleBand = band * bubbleBandStrength;
                    gl_FragColor.rgb += vec3(bubbleBand * 0.10);
                }

                // Internal fracture-plane approximation
                if (fractureStrength > 0.0) {
                    vec2 fractureUV = vUv * vec2(4.0, fractureDensity * 6.0);
                    float fractureHash = fract(sin(floor(fractureUV.y) * 12.9898 + variationOffset) * 43758.5453);
                    float fractureMask = smoothstep(0.6, 0.0, abs(fract(fractureUV.x) - 0.5)) * (fractureHash > 0.7 ? 1.0 : 0.0);
                    gl_FragColor.rgb *= (1.0 - fractureMask * fractureStrength * 0.25);
                }

                // Compacted-layer mottle
                if (layerMottle > 0.0) {
                    float mottle = sin(vUv.x * 12.0 + variationOffset) * cos(vUv.y * 12.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + mottle * layerMottle * 0.10);
                }

                // Internal glow (deep glacier blue)
                if (internalGlowIntensity > 0.0) {
                    gl_FragColor.rgb += dispersionColor * internalGlowIntensity * 0.12;
                }

                // Cool-cyan rim glow on glacier edges
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
            this.glacierBands, this.glacierQuantize, this.glacierSoftness,
            this.bubbleBandFrequency, this.bubbleBandStrength,
            this.fractureStrength, this.fractureDensity,
            this.layerMottle, this.internalGlowIntensity,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    /**
     * @param {IceGlacierMaterial} source
     * @returns {IceGlacierMaterial}
     */
    copy(source) {
        super.copy(source);
        this.glacierBands = source.glacierBands;
        this.glacierQuantize = source.glacierQuantize;
        this.glacierSoftness = source.glacierSoftness;
        this.bubbleBandFrequency = source.bubbleBandFrequency;
        this.bubbleBandStrength = source.bubbleBandStrength;
        this.fractureStrength = source.fractureStrength;
        this.fractureDensity = source.fractureDensity;
        this.layerMottle = source.layerMottle;
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
        data.type = 'IceGlacierMaterial';

        if (this.glacierBands !== 4) data.glacierBands = this.glacierBands;
        if (this.glacierQuantize !== 0.5) data.glacierQuantize = this.glacierQuantize;
        if (this.glacierSoftness !== 0.06) data.glacierSoftness = this.glacierSoftness;
        if (this.bubbleBandFrequency !== 6.0) data.bubbleBandFrequency = this.bubbleBandFrequency;
        if (this.bubbleBandStrength !== 0.30) data.bubbleBandStrength = this.bubbleBandStrength;
        if (this.fractureStrength !== 0.20) data.fractureStrength = this.fractureStrength;
        if (this.fractureDensity !== 8.0) data.fractureDensity = this.fractureDensity;
        if (this.layerMottle !== 0.08) data.layerMottle = this.layerMottle;
        if (this.internalGlowIntensity !== 0.18) data.internalGlowIntensity = this.internalGlowIntensity;
        if (this.rimGlow !== 0.14) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.62, 0.88, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * @param {Object} json
     * @returns {IceGlacierMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);
        this.glacierBands = json.glacierBands ?? this.glacierBands;
        this.glacierQuantize = json.glacierQuantize ?? this.glacierQuantize;
        this.glacierSoftness = json.glacierSoftness ?? this.glacierSoftness;
        this.bubbleBandFrequency = json.bubbleBandFrequency ?? this.bubbleBandFrequency;
        this.bubbleBandStrength = json.bubbleBandStrength ?? this.bubbleBandStrength;
        this.fractureStrength = json.fractureStrength ?? this.fractureStrength;
        this.fractureDensity = json.fractureDensity ?? this.fractureDensity;
        this.layerMottle = json.layerMottle ?? this.layerMottle;
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

const IceGlacierMaterialBatchComponent = {
    materialPtr: 'ui32',
    glacierBands: 'ui8',
    glacierQuantize: 'f64',
    glacierSoftness: 'f64',
    bubbleBandFrequency: 'f64',
    bubbleBandStrength: 'f64',
    fractureStrength: 'f64',
    fractureDensity: 'f64',
    layerMottle: 'f64',
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
    IceGlacierMaterial,
    IceGlacierMaterialBatch,
    IceGlacierScratchPool,
    IceGlacierMaterialBatchComponent,
    IceGlacierPresets,
    applyGlacierCelBanding,
    gradeGlacierColor,
    generateGlacierLayerTexture
};

export default IceGlacierMaterial;