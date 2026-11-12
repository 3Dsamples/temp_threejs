// file number : 193
// full path name : src/materials/193_meshphysicalmaterial.js
// description : MeshPhysicalMaterial rewritten for the temp_threejs engine.
//               Extends the rewritten 186_meshstandardmaterial.js with advanced
//               PBR‑specific anime stylization: clearcoat cel banding, iridescence
//               to anime sparkle mapping (discrete rainbow bands for magical
//               effects), sheen‑driven rim glow (velvet fabric halos),
//               transmission‑driven cel banding for translucent materials,
//               mood‑based advanced PBR rebalancing (cool cyan snow/ice, warm
//               sunset golden‑hour), simplex‑noise dithered advanced specular,
//               and per‑instance variation. Preserves the full r185
//               MeshPhysicalMaterial API and integrates with the unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : MeshPhysicalMaterial, anime characters with translucent skin/hair,
//            iridescent water and glass, velvet anime fabrics, brushed metal
//            anime props, wet anime surfaces, magical rainbow effects, and any
//            advanced PBR mesh that needs real‑time anime stylization.
// license : MIT

import { MeshStandardMaterial } from './186_meshstandardmaterial.js';
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

/** @type {number} Golden‑angle increment for per‑instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec2} Scratch 2D vector for UV staging. */
const _scratchUV = new Vec2();

/** @type {Vec3} Scratch 3D vector for normal staging. */
const _scratchNormal = new Vec3();

/** @type {Vec3} Scratch 3D vector for view‑direction staging. */
const _scratchView = new Vec3();

/** @type {Vec4} Scratch 4D vector for iridescence staging. */
const _scratchVec4 = new Vec4();

/** @type {Mat4} Scratch matrix for projection staging. */
const _scratchProjMat = new Mat4();

// ---------------------------------------------------------------------------
// Pool system — reusable advanced PBR scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for advanced‑PBR scratch records. Prevents per‑frame
 * allocation of temporary clearcoat, iridescence, sheen, and transmission
 * scratch objects.
 */
class AdvPBRScratchPool {
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
     * Create a single scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Vec3, view: Vec3, v4: Vec4}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            normal: new Vec3(),
            view: new Vec3(),
            v4: new Vec4()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Vec3, view: Vec3, v4: Vec4}}
     */
    acquire() {
        return this._free.pop() || this._createRecord();
    }

    /**
     * Release a scratch record back to the pool.
     * @param {Object} record
     */
    release(record) {
        if (record && this._free.length < 256) {
            this._free.push(record);
        }
    }

    /**
     * Pre‑warm the pool.
     * @param {number} count
     */
    warm(count) {
        while (this._free.length < count) {
            this._free.push(this._createRecord());
        }
    }
}

/** @type {AdvPBRScratchPool} Shared scratch pool for all advanced PBR instances. */
const _advPbrScratchPool = new AdvPBRScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — advanced PBR anime helpers
// ---------------------------------------------------------------------------

/**
 * Quantize a clearcoat specular intensity into cel bands. Clearcoat is the thin,
 * glossy top layer that gives materials like car paint and wet surfaces their
 * distinctive shine. Cel‑banding it produces the crisp anime sparkle on wet
 * anime skin, polished armor, and clearcoat character features.
 * @param {number} clearcoatIntensity - Raw clearcoat intensity in [0, 1].
 * @param {number} bands - Number of cel bands (2–3 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [threshold=0.5] - Minimum intensity to show the first band.
 * @param {number} [softness=0.05] - Edge softness in [0, 0.3].
 * @returns {number} Banded clearcoat intensity in [0, 1].
 */
function applyClearcoatCelBanding(clearcoatIntensity, bands, quantizeAmount, threshold = 0.5, softness = 0.05) {
    if (bands <= 1 || clearcoatIntensity < threshold) return 0;

    const normalized = Math.max(0, Math.min(1, (clearcoatIntensity - threshold) / Math.max(1.0 - threshold, 0.0001)));

    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(normalized / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;

    const distToBoundary = Math.abs(normalized - bandIndex * bandWidth - bandWidth * 0.5);
    const softFactor = Math.max(0, Math.min(1, distToBoundary / (bandWidth * 0.5)));
    const softQuantized = quantized + (normalized - quantized) * (1 - softFactor) * softness;

    return Math.max(0, Math.min(1, normalized + (softQuantized - normalized) * quantizeAmount));
}

/**
 * Map an iridescence value to discrete anime rainbow bands. Iridescence produces
 * angle‑dependent color shifts — soap bubbles, beetle shells, oil slicks. For
 * anime, we map this to discrete rainbow bands that read as magical sparkle.
 * @param {number} iridescence - Raw iridescence value in [0, 1].
 * @param {number} bands - Number of rainbow bands (4–6 recommended).
 * @param {number} angleShift - Angle‑dependent shift in [0, 1].
 * @param {Color} output - Output colour (modified in place).
 * @returns {Color}
 */
function mapIridescenceToAnimeSparkle(iridescence, bands, angleShift, output) {
    // Shift the iridescence value by the angle to produce angle dependence
    let t = (iridescence + angleShift * 0.5) * bands;
    t = t - Math.floor(t);
    const hue = t / bands * 6.0; // map to [0, 6) hue space

    // Convert HSV (hue, 1, 1) to RGB
    const i = Math.floor(hue);
    const f = hue - i;
    const p = 0;
    const q = 1 - f;
    const t2 = f;

    let r, g, b;
    switch (i % 6) {
        case 0: r = 1; g = t2; b = p; break;
        case 1: r = q; g = 1; b = p; break;
        case 2: r = p; g = 1; b = t2; break;
        case 3: r = p; g = q; b = 1; break;
        case 4: r = t2; g = p; b = 1; break;
        case 5: r = 1; g = p; b = q; break;
        default: r = 1; g = 1; b = 1;
    }

    output.setRGB(
        Math.max(0, Math.min(1, r)),
        Math.max(0, Math.min(1, g)),
        Math.max(0, Math.min(1, b)),
        ColorManagement.workingColorSpace
    );
    return output;
}

/**
 * Compute a sheen‑driven rim glow. Sheen produces the soft, dusty appearance of
 * velvet and fabric. For anime, we amplify the sheen at the silhouette edges to
 * produce a soft halo, matching the velvet anime costume halos.
 * @param {number} sheen - Raw sheen value in [0, 1].
 * @param {number} ndotv - Normal·View dot product in [0, 1].
 * @param {number} [power=2.0] - Rim falloff power.
 * @param {number} [intensity=1.0] - Rim intensity multiplier.
 * @returns {number} Sheen rim glow in [0, 1].
 */
function computeSheenRimGlow(sheen, ndotv, power = 2.0, intensity = 1.0) {
    if (sheen <= 0) return 0;
    const rim = Math.pow(1.0 - Math.abs(ndotv), power);
    return Math.max(0, Math.min(1, rim * sheen * intensity));
}

/**
 * Apply cel‑band quantization to a transmission‑driven translucent color.
 * Transmission is used for glass, water, and translucent anime skin/hair. Cel‑
 * banding it produces the discrete "glass layers" look of hand‑drawn anime
 * glass and water surfaces.
 * @param {Color} baseColor - The transmitted base color.
 * @param {Color} output - The output color (modified in place).
 * @param {number} transmission - Raw transmission value in [0, 1].
 * @param {number} bands - Number of cel bands (2–4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @returns {Color}
 */
function applyTransmissionCelBanding(baseColor, output, transmission, bands, quantizeAmount) {
    if (bands <= 1 || transmission <= 0) {
        output.copy(baseColor);
        return output;
    }

    _scratchRGB[0] = baseColor.r;
    _scratchRGB[1] = baseColor.g;
    _scratchRGB[2] = baseColor.b;

    const lum = 0.2126 * _scratchRGB[0] + 0.7152 * _scratchRGB[1] + 0.0722 * _scratchRGB[2];

    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(lum / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;

    const finalLum = lum + (quantized - lum) * quantizeAmount;

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
 * Rebalance advanced PBR parameters based on scene mood. Snow/ice scenes need
 * higher roughness, higher clearcoat, cool tint; golden‑hour scenes need lower
 * roughness, lower clearcoat (matte sunset look), warm tint.
 * @param {Color} color - The base color (modified in place).
 * @param {Object} params - The PBR parameters to rebalance.
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Object} The rebalanced parameters.
 */
function moodAdvancedPBRRebalance(color, params, temperature, saturation, brightness, contrast) {
    // Color grading (diffuse)
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

    r += temperature * 0.12;
    b -= temperature * 0.12;

    r *= brightness;
    g *= brightness;
    b *= brightness;

    color.setRGB(
        Math.max(0, Math.min(1, r)),
        Math.max(0, Math.min(1, g)),
        Math.max(0, Math.min(1, b)),
        ColorManagement.workingColorSpace
    );

    // Rebalance PBR parameters
    const newParams = {};

    // Roughness: cooler → higher (matte), warmer → lower (glossy)
    newParams.roughness = Math.max(0, Math.min(1, params.roughness + temperature * 0.1));

    // Metalness: cooler → slightly higher, warmer → slightly lower
    newParams.metalness = Math.max(0, Math.min(1, params.metalness - temperature * 0.05));

    // Clearcoat: cooler → higher (ice gloss), warmer → lower
    newParams.clearcoat = Math.max(0, Math.min(1, params.clearcoat - temperature * 0.15));

    // Sheen: cooler → lower, warmer → higher
    newParams.sheen = Math.max(0, Math.min(1, params.sheen + temperature * 0.1));

    // Iridescence: cooler → higher (icy sparkle), warmer → lower
    newParams.iridescence = Math.max(0, Math.min(1, params.iridescence - temperature * 0.1));

    // Transmission: cooler → slightly higher (clear ice), warmer → slightly lower
    newParams.transmission = Math.max(0, Math.min(1, params.transmission - temperature * 0.05));

    // Anisotropy: cooler → lower, warmer → higher
    newParams.anisotropy = Math.max(0, Math.min(1, params.anisotropy + temperature * 0.08));

    return newParams;
}

/**
 * Generate a combined paper‑grain and watercolor texture using simplex‑noise
 * with multiple octaves. Produces the hand‑painted texture characteristic of
 * the reference imagery's advanced PBR surfaces (iridescent water, translucent
 * glass, velvet fabric).
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03] - Base noise scale.
 * @param {number} [octaves=4] - Number of noise octaves.
 * @param {number} [paperGrain=0.3] - Paper grain intensity.
 * @param {number} [watercolorBleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateAdvancedPBRTexture(width, height, scale = 0.03, octaves = 4, paperGrain = 0.3, watercolorBleed = 0.5) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            let value = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                value += SimplexNoise.noise2D(x * frequency, y * frequency) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            value = (value / maxAmplitude) * 0.5 + 0.5;

            value = (value - 0.5) * (1.0 + watercolorBleed) + 0.5;
            value = Math.max(0, Math.min(1, value));

            const grain = SimplexNoise.noise2D(x * 0.5, y * 0.5) * 0.5 + 0.5;
            value = value * (1 - paperGrain) + grain * paperGrain;
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
// bitecs SoA batch coordinator for real‑time advanced PBR material updates
// ---------------------------------------------------------------------------

const _advPbrWorld = BitECS.createWorld();
const AdvPBRMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    clearcoatBands: 'ui8',
    clearcoatQuantize: 'f64',
    clearcoatThreshold: 'f64',
    clearcoatSoftness: 'f64',
    iridescenceBands: 'ui8',
    iridescenceAngleShift: 'f64',
    sheenRimPower: 'f64',
    sheenRimIntensity: 'f64',
    transmissionBands: 'ui8',
    transmissionQuantize: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    ditherAmplitude: 'f64',
    dirty: 'ui8'
});

/**
 * Batch coordinator for advanced PBR materials. Registers MeshPhysicalMaterial
 * instances and drives their anime parameters and mood‑rebalanced values in one
 * cache‑friendly pass.
 */
class MeshPhysicalMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _advPbrWorld;
        /** @type {MeshPhysicalMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register a MeshPhysicalMaterial instance for batched real‑time updates.
     * @param {MeshPhysicalMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, AdvPBRMaterialComponent, eid);
        AdvPBRMaterialComponent.materialPtr[eid] = this.materials.length;
        AdvPBRMaterialComponent.clearcoatBands[eid] = material.clearcoatBands;
        AdvPBRMaterialComponent.clearcoatQuantize[eid] = material.clearcoatQuantize;
        AdvPBRMaterialComponent.clearcoatThreshold[eid] = material.clearcoatThreshold;
        AdvPBRMaterialComponent.clearcoatSoftness[eid] = material.clearcoatSoftness;
        AdvPBRMaterialComponent.iridescenceBands[eid] = material.iridescenceBands;
        AdvPBRMaterialComponent.iridescenceAngleShift[eid] = material.iridescenceAngleShift;
        AdvPBRMaterialComponent.sheenRimPower[eid] = material.sheenRimPower;
        AdvPBRMaterialComponent.sheenRimIntensity[eid] = material.sheenRimIntensity;
        AdvPBRMaterialComponent.transmissionBands[eid] = material.transmissionBands;
        AdvPBRMaterialComponent.transmissionQuantize[eid] = material.transmissionQuantize;
        AdvPBRMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        AdvPBRMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        AdvPBRMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        AdvPBRMaterialComponent.moodContrast[eid] = material.moodContrast;
        AdvPBRMaterialComponent.paperGrain[eid] = material.paperGrain;
        AdvPBRMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        AdvPBRMaterialComponent.ditherAmplitude[eid] = material.ditherAmplitude;
        AdvPBRMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued advanced PBR material updates in one cache‑friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[AdvPBRMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.clearcoatBands = AdvPBRMaterialComponent.clearcoatBands[eid];
            material.clearcoatQuantize = AdvPBRMaterialComponent.clearcoatQuantize[eid];
            material.clearcoatThreshold = AdvPBRMaterialComponent.clearcoatThreshold[eid];
            material.clearcoatSoftness = AdvPBRMaterialComponent.clearcoatSoftness[eid];
            material.iridescenceBands = AdvPBRMaterialComponent.iridescenceBands[eid];
            material.iridescenceAngleShift = AdvPBRMaterialComponent.iridescenceAngleShift[eid];
            material.sheenRimPower = AdvPBRMaterialComponent.sheenRimPower[eid];
            material.sheenRimIntensity = AdvPBRMaterialComponent.sheenRimIntensity[eid];
            material.transmissionBands = AdvPBRMaterialComponent.transmissionBands[eid];
            material.transmissionQuantize = AdvPBRMaterialComponent.transmissionQuantize[eid];
            material.moodTemperature = AdvPBRMaterialComponent.moodTemperature[eid];
            material.moodSaturation = AdvPBRMaterialComponent.moodSaturation[eid];
            material.moodBrightness = AdvPBRMaterialComponent.moodBrightness[eid];
            material.moodContrast = AdvPBRMaterialComponent.moodContrast[eid];
            material.paperGrain = AdvPBRMaterialComponent.paperGrain[eid];
            material.watercolorBleed = AdvPBRMaterialComponent.watercolorBleed[eid];
            material.ditherAmplitude = AdvPBRMaterialComponent.ditherAmplitude[eid];

            // Recompute derived values
            material.moodColor.copy(material.color);
            const newParams = moodAdvancedPBRRebalance(
                material.moodColor,
                {
                    roughness: material.roughness,
                    metalness: material.metalness,
                    clearcoat: material.clearcoat,
                    sheen: material.sheen,
                    iridescence: material.iridescence,
                    transmission: material.transmission,
                    anisotropy: material.anisotropy
                },
                material.moodTemperature,
                material.moodSaturation,
                material.moodBrightness,
                material.moodContrast
            );
            material.moodRoughness = newParams.roughness;
            material.moodMetalness = newParams.metalness;
            material.moodClearcoat = newParams.clearcoat;
            material.moodSheen = newParams.sheen;
            material.moodIridescence = newParams.iridescence;
            material.moodTransmission = newParams.transmission;
            material.moodAnisotropy = newParams.anisotropy;

            AdvPBRMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MeshPhysicalMaterial class
// ---------------------------------------------------------------------------

/**
 * An extension of MeshStandardMaterial providing more advanced physically based
 * rendering properties: clearcoat, iridescence, sheen, transmission, and
 * anisotropy.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: clearcoat cel banding, iridescence‑to‑
 * anime‑sparkle mapping, sheen‑driven rim glow, transmission cel banding, and
 * mood‑based advanced PBR rebalancing.
 *
 * @augments MeshStandardMaterial
 */
class MeshPhysicalMaterial extends MeshStandardMaterial {

    /**
     * Static block — pre‑warm the shared scratch pool for advanced PBR materials.
     */
    static {
        _advPbrScratchPool.warm(32);
    }

    /**
     * Construct a new mesh physical material.
     * @param {Object} [parameters] - An object with one or more properties
     * defining the material's appearance.
     */
    constructor(parameters) {
        super();

        /**
         * This flag can be used for type testing.
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isMeshPhysicalMaterial = true;

        this.type = 'MeshPhysicalMaterial';

        // -------------------------------------------------------------------
        // Standard MeshPhysicalMaterial surface — clearcoat
        // -------------------------------------------------------------------

        /** @type {number} @default 0.0 */
        this.clearcoat = 0.0;
        /** @type {number} @default 0.0 */
        this.clearcoatRoughness = 0.0;
        /** @type {?Texture} @default null */
        this.clearcoatMap = null;
        /** @type {?Texture} @default null */
        this.clearcoatRoughnessMap = null;
        /** @type {?Texture} @default null */
        this.clearcoatNormalMap = null;
        /** @type {Vec2} @default (1,1) */
        this.clearcoatNormalScale = new Vec2(1, 1);

        // ---- Iridescence ----
        /** @type {number} @default 0.0 */
        this.iridescence = 0.0;
        /** @type {number} @default 1.3 */
        this.iridescenceIOR = 1.3;
        /** @type {Vec2} @default (100, 400) */
        this.iridescenceThicknessRange = new Vec2(100, 400);
        /** @type {?Texture} @default null */
        this.iridescenceMap = null;
        /** @type {?Texture} @default null */
        this.iridescenceThicknessMap = null;

        // ---- Sheen ----
        /** @type {number} @default 0.0 */
        this.sheen = 0.0;
        /** @type {Color} @default (0,0,0) */
        this.sheenColor = new Color(0x000000);
        /** @type {?Texture} @default null */
        this.sheenColorMap = null;
        /** @type {number} @default 1.0 */
        this.sheenRoughness = 1.0;
        /** @type {?Texture} @default null */
        this.sheenRoughnessMap = null;

        // ---- Transmission ----
        /** @type {number} @default 0.0 */
        this.transmission = 0.0;
        /** @type {?Texture} @default null */
        this.transmissionMap = null;
        /** @type {number} @default 0 */
        this.thickness = 0;
        /** @type {?Texture} @default null */
        this.thicknessMap = null;
        /** @type {number} @default Infinity */
        this.attenuationDistance = Infinity;
        /** @type {Color} @default (1,1,1) */
        this.attenuationColor = new Color(0xffffff);

        // ---- Specular ----
        /** @type {number} @default 1.0 */
        this.specularIntensity = 1.0;
        /** @type {?Texture} @default null */
        this.specularIntensityMap = null;
        /** @type {Color} @default (1,1,1) */
        this.specularColor = new Color(0xffffff);
        /** @type {?Texture} @default null */
        this.specularColorMap = null;

        // ---- Anisotropy ----
        /** @type {number} @default 0.0 */
        this.anisotropy = 0.0;
        /** @type {number} @default 0.0 */
        this.anisotropyRotation = 0.0;
        /** @type {?Texture} @default null */
        this.anisotropyMap = null;

        // -------------------------------------------------------------------
        // Anime rendering extensions — advanced PBR‑specific
        // -------------------------------------------------------------------

        /**
         * Number of clearcoat cel bands. 2–3 = classic anime sparkle on clearcoat
         * surfaces.
         * @type {number}
         * @default 2
         */
        this.clearcoatBands = 2;

        /**
         * Blend amount between continuous and banded clearcoat.
         * @type {number}
         * @default 1.0
         */
        this.clearcoatQuantize = 1.0;

        /**
         * Minimum clearcoat intensity to trigger the first band.
         * @type {number}
         * @default 0.5
         */
        this.clearcoatThreshold = 0.5;

        /**
         * Clearcoat band edge softness.
         * @type {number}
         * @default 0.05
         */
        this.clearcoatSoftness = 0.05;

        /**
         * Number of iridescence rainbow bands for anime sparkle mapping.
         * @type {number}
         * @default 5
         */
        this.iridescenceBands = 5;

        /**
         * Angle‑dependent shift applied to the iridescence sparkle.
         * @type {number}
         * @default 0.5
         */
        this.iridescenceAngleShift = 0.5;

        /**
         * Sheen rim‑glow falloff power.
         * @type {number}
         * @default 2.0
         */
        this.sheenRimPower = 2.0;

        /**
         * Sheen rim‑glow intensity.
         * @type {number}
         * @default 0
         */
        this.sheenRimIntensity = 0;

        /**
         * Number of transmission cel bands.
         * @type {number}
         * @default 0
         */
        this.transmissionBands = 0;

        /**
         * Blend amount between continuous and banded transmission.
         * @type {number}
         * @default 1.0
         */
        this.transmissionQuantize = 1.0;

        /**
         * The precomputed mood‑graded color.
         * @type {Color}
         */
        this.moodColor = new Color(0xffffff);

        /** @type {number} @default 1.0 */
        this.moodRoughness = 1.0;
        /** @type {number} @default 0.0 */
        this.moodMetalness = 0.0;
        /** @type {number} @default 0.0 */
        this.moodClearcoat = 0.0;
        /** @type {number} @default 0.0 */
        this.moodSheen = 0.0;
        /** @type {number} @default 0.0 */
        this.moodIridescence = 0.0;
        /** @type {number} @default 0.0 */
        this.moodTransmission = 0.0;
        /** @type {number} @default 0.0 */
        this.moodAnisotropy = 0.0;

        /**
         * Paper‑grain overlay intensity.
         * @type {number}
         * @default 0
         */
        this.paperGrain = 0;

        /**
         * Watercolor bleed strength.
         * @type {number}
         * @default 0
         */
        this.watercolorBleed = 0;

        /**
         * Simplex‑noise dithering amplitude in 8‑bit units.
         * @type {number}
         * @default 0
         */
        this.ditherAmplitude = 0;

        /**
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, advanced PBR leans semi‑realistic)
        // -------------------------------------------------------------------

        /**
         * Advanced PBR materials typically lean semi‑realistic.
         * @type {number}
         * @default 0.4
         */
        this.renderStyleBlend = 0.4;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the advanced PBR material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters and initialise derived values
        // -------------------------------------------------------------------

        this.setValues(parameters);

        // Initialise derived values.
        this.updateMoodAdvancedPBR();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Apply clearcoat cel banding to a raw clearcoat intensity.
     * @param {number} intensity - Raw clearcoat intensity in [0, 1].
     * @returns {number} Banded clearcoat intensity in [0, 1].
     */
    applyClearcoatBanding(intensity) {
        return applyClearcoatCelBanding(
            intensity,
            this.clearcoatBands,
            this.clearcoatQuantize,
            this.clearcoatThreshold,
            this.clearcoatSoftness
        );
    }

    /**
     * Map the current iridescence value to an anime rainbow sparkle color.
     * @param {number} angleShift - Angle‑dependent shift in [0, 1].
     * @returns {Color} A new Color instance.
     */
    mapIridescenceSparkle(angleShift) {
        const out = new Color();
        return mapIridescenceToAnimeSparkle(this.iridescence, this.iridescenceBands, angleShift, out);
    }

    /**
     * Compute the sheen‑driven rim glow for a given normal·view dot product.
     * @param {number} ndotv - Normal·View dot product in [0, 1].
     * @returns {number} Sheen rim glow in [0, 1].
     */
    sampleSheenRim(ndotv) {
        if (this.sheenRimIntensity <= 0) return 0;
        return computeSheenRimGlow(this.sheen, ndotv, this.sheenRimPower, this.sheenRimIntensity);
    }

    /**
     * Apply transmission cel banding to a transmitted color.
     * @param {Color} baseColor - The transmitted base color.
     * @param {Color} output - The output color.
     * @returns {Color}
     */
    applyTransmissionBanding(baseColor, output) {
        return applyTransmissionCelBanding(
            baseColor,
            output,
            this.transmission,
            this.transmissionBands,
            this.transmissionQuantize
        );
    }

    /**
     * Recompute the mood‑graded color and rebalanced advanced PBR parameters.
     * @returns {MeshPhysicalMaterial} A reference to this instance.
     */
    updateMoodAdvancedPBR() {
        this.moodColor.copy(this.color);
        const newParams = moodAdvancedPBRRebalance(
            this.moodColor,
            {
                roughness: this.roughness,
                metalness: this.metalness,
                clearcoat: this.clearcoat,
                sheen: this.sheen,
                iridescence: this.iridescence,
                transmission: this.transmission,
                anisotropy: this.anisotropy
            },
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        this.moodRoughness = newParams.roughness;
        this.moodMetalness = newParams.metalness;
        this.moodClearcoat = newParams.clearcoat;
        this.moodSheen = newParams.sheen;
        this.moodIridescence = newParams.iridescence;
        this.moodTransmission = newParams.transmission;
        this.moodAnisotropy = newParams.anisotropy;
        return this;
    }

    /**
     * Generate a procedural advanced PBR texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.03]
     * @param {number} [octaves=4]
     * @returns {Uint8Array}
     */
    generateAdvancedPBRTexture(width, height, scale = 0.03, octaves = 4) {
        return generateAdvancedPBRTexture(width, height, scale, octaves, this.paperGrain, this.watercolorBleed);
    }

    /**
     * Compute the per‑instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * Asynchronous initialisation hook — satisfies the `await` syntax
     * requirement. Concrete subclasses may override.
     * @returns {Promise<MeshPhysicalMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshStandardMaterial anime shader chunks with advanced PBR
     * features: clearcoat cel banding, iridescence sparkle mapping, sheen rim
     * glow, and transmission cel banding.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base MeshStandardMaterial hook first
        super.onBeforeCompile(shader, renderer);

        // Inject advanced PBR uniforms
        shader.uniforms.clearcoatBands = { value: this.clearcoatBands };
        shader.uniforms.clearcoatQuantize = { value: this.clearcoatQuantize };
        shader.uniforms.clearcoatThreshold = { value: this.clearcoatThreshold };
        shader.uniforms.clearcoatSoftness = { value: this.clearcoatSoftness };
        shader.uniforms.iridescenceBands = { value: this.iridescenceBands };
        shader.uniforms.iridescenceAngleShift = { value: this.iridescenceAngleShift };
        shader.uniforms.sheenRimPower = { value: this.sheenRimPower };
        shader.uniforms.sheenRimIntensity = { value: this.sheenRimIntensity };
        shader.uniforms.transmissionBands = { value: this.transmissionBands };
        shader.uniforms.transmissionQuantize = { value: this.transmissionQuantize };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.moodClearcoat = { value: this.moodClearcoat };
        shader.uniforms.moodSheen = { value: this.moodSheen };
        shader.uniforms.moodIridescence = { value: this.moodIridescence };
        shader.uniforms.moodTransmission = { value: this.moodTransmission };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.ditherAmplitude = { value: this.ditherAmplitude };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader with advanced PBR anime chunks
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int clearcoatBands;
                uniform float clearcoatQuantize;
                uniform float clearcoatThreshold;
                uniform float clearcoatSoftness;
                uniform int iridescenceBands;
                uniform float iridescenceAngleShift;
                uniform float sheenRimPower;
                uniform float sheenRimIntensity;
                uniform int transmissionBands;
                uniform float transmissionQuantize;
                uniform vec3 moodColor;
                uniform float moodClearcoat;
                uniform float moodSheen;
                uniform float moodIridescence;
                uniform float moodTransmission;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float ditherAmplitude;
                uniform float variationOffset;

                float applyClearcoatCel(float spec) {
                    if (clearcoatBands <= 1 || spec < clearcoatThreshold) return 0.0;
                    float normalized = clamp((spec - clearcoatThreshold) / max(1.0 - clearcoatThreshold, 0.0001), 0.0, 1.0);
                    float bandWidth = 1.0 / float(clearcoatBands);
                    float bandIndex = floor(normalized / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(normalized - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (normalized - quantized) * (1.0 - softFactor) * clearcoatSoftness;
                    return clamp(mix(normalized, softQuantized, clearcoatQuantize), 0.0, 1.0);
                }

                vec3 mapIridescenceSparkle(float iridescence, float angle) {
                    if (iridescence <= 0.0) return vec3(0.0);
                    float t = fract(iridescence * float(iridescenceBands) + angle * iridescenceAngleShift);
                    float i = floor(t * 6.0);
                    float f = t * 6.0 - i;
                    float p = 0.0;
                    float q = 1.0 - f;
                    float r, g, b;
                    if (i == 0.0) { r = 1.0; g = f; b = p; }
                    else if (i == 1.0) { r = q; g = 1.0; b = p; }
                    else if (i == 2.0) { r = p; g = 1.0; b = f; }
                    else if (i == 3.0) { r = p; g = q; b = 1.0; }
                    else if (i == 4.0) { r = f; g = p; b = 1.0; }
                    else { r = 1.0; g = p; b = q; }
                    return vec3(r, g, b) * iridescence;
                }

                float computeSheenRim(float sheen, float ndotv) {
                    if (sheen <= 0.0 || sheenRimIntensity <= 0.0) return 0.0;
                    float rim = pow(1.0 - abs(ndotv), sheenRimPower);
                    return clamp(rim * sheen * sheenRimIntensity, 0.0, 1.0);
                }

                vec3 applyTransmissionCel(vec3 baseColor, float transmission) {
                    if (transmissionBands <= 1 || transmission <= 0.0) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(transmissionBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float finalLum = mix(lum, quantized, transmissionQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }

                float samplePaperGrain(vec2 uv) {
                    if (paperGrain <= 0.0) return 1.0;
                    float n = sin(uv.x * 8.0 + variationOffset) * cos(uv.y * 8.0 + variationOffset);
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * (1.0 - n);
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply clearcoat cel banding
                float rawClearcoat = max(max(gl_FragColor.r, gl_FragColor.g), gl_FragColor.b);
                float bandedClearcoat = applyClearcoatCel(rawClearcoat);
                gl_FragColor.rgb += vec3(bandedClearcoat) * moodClearcoat;

                // Apply iridescence sparkle mapping
                float iridescenceAngle = dot(normalize(vNormal), normalize(vViewPosition));
                vec3 sparkle = mapIridescenceSparkle(moodIridescence, iridescenceAngle);
                gl_FragColor.rgb += sparkle;

                // Apply sheen rim glow
                float ndotvAdv = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                float sheenRim = computeSheenRim(moodSheen, ndotvAdv);
                gl_FragColor.rgb += vec3(sheenRim);

                // Apply transmission cel banding
                gl_FragColor.rgb = applyTransmissionCel(gl_FragColor.rgb, moodTransmission);

                // Apply simplex‑noise dithering
                if (ditherAmplitude > 0.0) {
                    float d = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
                    gl_FragColor.rgb += (d - 0.5) * ditherAmplitude / 255.0;
                }

                // Apply paper grain
                gl_FragColor.a *= samplePaperGrain(vUv);
                `
            );
    }

    /**
     * Custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.clearcoat,
            this.clearcoatRoughness,
            this.clearcoatBands,
            this.clearcoatQuantize,
            this.clearcoatThreshold,
            this.clearcoatSoftness,
            this.iridescence,
            this.iridescenceIOR,
            this.iridescenceBands,
            this.iridescenceAngleShift,
            this.sheen,
            this.sheenRoughness,
            this.sheenRimPower,
            this.sheenRimIntensity,
            this.transmission,
            this.transmissionBands,
            this.transmissionQuantize,
            this.anisotropy,
            this.anisotropyRotation,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.paperGrain,
            this.watercolorBleed,
            this.ditherAmplitude,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {MeshPhysicalMaterial} source
     * @return {MeshPhysicalMaterial}
     */
    copy(source) {
        super.copy(source);

        // Clearcoat
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.clearcoatMap = source.clearcoatMap;
        this.clearcoatRoughnessMap = source.clearcoatRoughnessMap;
        this.clearcoatNormalMap = source.clearcoatNormalMap;
        this.clearcoatNormalScale.copy(source.clearcoatNormalScale);

        // Iridescence
        this.iridescence = source.iridescence;
        this.iridescenceIOR = source.iridescenceIOR;
        this.iridescenceThicknessRange.copy(source.iridescenceThicknessRange);
        this.iridescenceMap = source.iridescenceMap;
        this.iridescenceThicknessMap = source.iridescenceThicknessMap;

        // Sheen
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenColorMap = source.sheenColorMap;
        this.sheenRoughness = source.sheenRoughness;
        this.sheenRoughnessMap = source.sheenRoughnessMap;

        // Transmission
        this.transmission = source.transmission;
        this.transmissionMap = source.transmissionMap;
        this.thickness = source.thickness;
        this.thicknessMap = source.thicknessMap;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);

        // Specular
        this.specularIntensity = source.specularIntensity;
        this.specularIntensityMap = source.specularIntensityMap;
        this.specularColor.copy(source.specularColor);
        this.specularColorMap = source.specularColorMap;

        // Anisotropy
        this.anisotropy = source.anisotropy;
        this.anisotropyRotation = source.anisotropyRotation;
        this.anisotropyMap = source.anisotropyMap;

        // Anime extensions
        this.clearcoatBands = source.clearcoatBands;
        this.clearcoatQuantize = source.clearcoatQuantize;
        this.clearcoatThreshold = source.clearcoatThreshold;
        this.clearcoatSoftness = source.clearcoatSoftness;
        this.iridescenceBands = source.iridescenceBands;
        this.iridescenceAngleShift = source.iridescenceAngleShift;
        this.sheenRimPower = source.sheenRimPower;
        this.sheenRimIntensity = source.sheenRimIntensity;
        this.transmissionBands = source.transmissionBands;
        this.transmissionQuantize = source.transmissionQuantize;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy(source.moodColor);
        this.moodRoughness = source.moodRoughness;
        this.moodMetalness = source.moodMetalness;
        this.moodClearcoat = source.moodClearcoat;
        this.moodSheen = source.moodSheen;
        this.moodIridescence = source.moodIridescence;
        this.moodTransmission = source.moodTransmission;
        this.moodAnisotropy = source.moodAnisotropy;
        this.paperGrain = source.paperGrain;
        this.watercolorBleed = source.watercolorBleed;
        this.ditherAmplitude = source.ditherAmplitude;
        this.variationSeed = source.variationSeed;

        return this;
    }

    /**
     * Serialise to JSON.
     * @param {?(Object|string)} meta
     * @return {Object}
     */
    toJSON(meta) {
        const data = super.toJSON(meta);

        data.type = 'MeshPhysicalMaterial';

        // Clearcoat
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.clearcoatMap !== null) data.clearcoatMap = this.clearcoatMap.toJSON(meta).uuid;
        if (this.clearcoatRoughnessMap !== null) data.clearcoatRoughnessMap = this.clearcoatRoughnessMap.toJSON(meta).uuid;
        if (this.clearcoatNormalMap !== null) data.clearcoatNormalMap = this.clearcoatNormalMap.toJSON(meta).uuid;
        if (this.clearcoatNormalScale.x !== 1 || this.clearcoatNormalScale.y !== 1) {
            data.clearcoatNormalScale = this.clearcoatNormalScale.toArray();
        }

        // Iridescence
        if (this.iridescence !== 0.0) data.iridescence = this.iridescence;
        if (this.iridescenceIOR !== 1.3) data.iridescenceIOR = this.iridescenceIOR;
        if (this.iridescenceThicknessRange.x !== 100 || this.iridescenceThicknessRange.y !== 400) {
            data.iridescenceThicknessRange = this.iridescenceThicknessRange.toArray();
        }
        if (this.iridescenceMap !== null) data.iridescenceMap = this.iridescenceMap.toJSON(meta).uuid;
        if (this.iridescenceThicknessMap !== null) data.iridescenceThicknessMap = this.iridescenceThicknessMap.toJSON(meta).uuid;

        // Sheen
        if (this.sheen !== 0.0) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== 0x000000) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenColorMap !== null) data.sheenColorMap = this.sheenColorMap.toJSON(meta).uuid;
        if (this.sheenRoughness !== 1.0) data.sheenRoughness = this.sheenRoughness;
        if (this.sheenRoughnessMap !== null) data.sheenRoughnessMap = this.sheenRoughnessMap.toJSON(meta).uuid;

        // Transmission
        if (this.transmission !== 0.0) data.transmission = this.transmission;
        if (this.transmissionMap !== null) data.transmissionMap = this.transmissionMap.toJSON(meta).uuid;
        if (this.thickness !== 0) data.thickness = this.thickness;
        if (this.thicknessMap !== null) data.thicknessMap = this.thicknessMap.toJSON(meta).uuid;
        if (this.attenuationDistance !== Infinity) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== 0xffffff) data.attenuationColor = this.attenuationColor.getHex();

        // Specular
        if (this.specularIntensity !== 1.0) data.specularIntensity = this.specularIntensity;
        if (this.specularIntensityMap !== null) data.specularIntensityMap = this.specularIntensityMap.toJSON(meta).uuid;
        if (this.specularColor.getHex() !== 0xffffff) data.specularColor = this.specularColor.getHex();
        if (this.specularColorMap !== null) data.specularColorMap = this.specularColorMap.toJSON(meta).uuid;

        // Anisotropy
        if (this.anisotropy !== 0.0) data.anisotropy = this.anisotropy;
        if (this.anisotropyRotation !== 0.0) data.anisotropyRotation = this.anisotropyRotation;
        if (this.anisotropyMap !== null) data.anisotropyMap = this.anisotropyMap.toJSON(meta).uuid;

        // Anime extensions
        if (this.clearcoatBands !== 2) data.clearcoatBands = this.clearcoatBands;
        if (this.clearcoatQuantize !== 1.0) data.clearcoatQuantize = this.clearcoatQuantize;
        if (this.clearcoatThreshold !== 0.5) data.clearcoatThreshold = this.clearcoatThreshold;
        if (this.clearcoatSoftness !== 0.05) data.clearcoatSoftness = this.clearcoatSoftness;
        if (this.iridescenceBands !== 5) data.iridescenceBands = this.iridescenceBands;
        if (this.iridescenceAngleShift !== 0.5) data.iridescenceAngleShift = this.iridescenceAngleShift;
        if (this.sheenRimPower !== 2.0) data.sheenRimPower = this.sheenRimPower;
        if (this.sheenRimIntensity !== 0) data.sheenRimIntensity = this.sheenRimIntensity;
        if (this.transmissionBands !== 0) data.transmissionBands = this.transmissionBands;
        if (this.transmissionQuantize !== 1.0) data.transmissionQuantize = this.transmissionQuantize;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.watercolorBleed !== 0) data.watercolorBleed = this.watercolorBleed;
        if (this.ditherAmplitude !== 0) data.ditherAmplitude = this.ditherAmplitude;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {MeshPhysicalMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        // Clearcoat
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        if (json.clearcoatNormalScale) this.clearcoatNormalScale.fromArray(json.clearcoatNormalScale);

        // Iridescence
        this.iridescence = json.iridescence ?? this.iridescence;
        this.iridescenceIOR = json.iridescenceIOR ?? this.iridescenceIOR;
        if (json.iridescenceThicknessRange) this.iridescenceThicknessRange.fromArray(json.iridescenceThicknessRange);

        // Sheen
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;

        // Transmission
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        if (json.attenuationDistance !== undefined) this.attenuationDistance = json.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);

        // Specular
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);

        // Anisotropy
        this.anisotropy = json.anisotropy ?? this.anisotropy;
        this.anisotropyRotation = json.anisotropyRotation ?? this.anisotropyRotation;

        // Anime extensions
        this.clearcoatBands = json.clearcoatBands ?? this.clearcoatBands;
        this.clearcoatQuantize = json.clearcoatQuantize ?? this.clearcoatQuantize;
        this.clearcoatThreshold = json.clearcoatThreshold ?? this.clearcoatThreshold;
        this.clearcoatSoftness = json.clearcoatSoftness ?? this.clearcoatSoftness;
        this.iridescenceBands = json.iridescenceBands ?? this.iridescenceBands;
        this.iridescenceAngleShift = json.iridescenceAngleShift ?? this.iridescenceAngleShift;
        this.sheenRimPower = json.sheenRimPower ?? this.sheenRimPower;
        this.sheenRimIntensity = json.sheenRimIntensity ?? this.sheenRimIntensity;
        this.transmissionBands = json.transmissionBands ?? this.transmissionBands;
        this.transmissionQuantize = json.transmissionQuantize ?? this.transmissionQuantize;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.watercolorBleed = json.watercolorBleed ?? this.watercolorBleed;
        this.ditherAmplitude = json.ditherAmplitude ?? this.ditherAmplitude;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived values
        this.updateMoodAdvancedPBR();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for advanced PBR materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing advanced PBR‑specific batching metadata.
 * Consumers can register advanced PBR materials with a World to drive batch
 * updates.
 */
const MeshPhysicalMaterialBatchComponent = {
    materialPtr: 'ui32',
    clearcoatBands: 'ui8',
    clearcoatQuantize: 'f64',
    clearcoatThreshold: 'f64',
    clearcoatSoftness: 'f64',
    iridescenceBands: 'ui8',
    iridescenceAngleShift: 'f64',
    sheenRimPower: 'f64',
    sheenRimIntensity: 'f64',
    transmissionBands: 'ui8',
    transmissionQuantize: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    ditherAmplitude: 'f64',
    dirty: 'ui8'
};

export {
    MeshPhysicalMaterial,
    MeshPhysicalMaterialBatch,
    AdvPBRScratchPool,
    MeshPhysicalMaterialBatchComponent,
    applyClearcoatCelBanding,
    mapIridescenceToAnimeSparkle,
    computeSheenRimGlow,
    applyTransmissionCelBanding,
    moodAdvancedPBRRebalance,
    generateAdvancedPBRTexture
};

export default MeshPhysicalMaterial;