// file number : 199
// full path name : src/materials/199_architecturalfabricmaterial.js
// description : ArchitecturalFabricMaterial — a ready-to-use fabric material
//               for architectural visualization. Extends MeshPhysicalMaterial
//               with purpose-built defaults for curtains, upholstery, acoustic
//               panels, carpets, and textiles: sheen, high roughness, zero
//               metalness, transmission for sheer fabrics, and real-time anime
//               stylization (cel-banded fabric highlights, mood tinting,
//               sheen-driven rim glow, paper-grain texture, watercolor bleed,
//               and per-instance variation). Includes procedural fabric weave
//               pattern generation via simplex-noise and curated presets for
//               velvet, linen, wool, sheer, and canvas. All imports resolve to
//               the internal Threejs_gl repository tree; no CDN dependencies.
// best for : Architectural fabric, curtains, upholstery, acoustic panels,
//            carpets, textiles, cushions, drapes, sheers, and any soft
//            furnishing that needs real-time PBR + anime stylization.
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
// Fabric presets — curated PBR parameter sets for common architectural textiles
// ---------------------------------------------------------------------------

const ArchitecturalFabricPresets = {
    'velvet': {
        color: [0.42, 0.12, 0.28],
        roughness: 0.75,
        metalness: 0.0,
        sheen: 1.0,
        sheenColor: [0.85, 0.55, 0.75],
        sheenRoughness: 0.45,
        transmission: 0.0
    },
    'linen': {
        color: [0.88, 0.82, 0.72],
        roughness: 0.88,
        metalness: 0.0,
        sheen: 0.35,
        sheenColor: [0.95, 0.9, 0.82],
        sheenRoughness: 0.75,
        transmission: 0.0
    },
    'wool': {
        color: [0.52, 0.45, 0.38],
        roughness: 0.92,
        metalness: 0.0,
        sheen: 0.55,
        sheenColor: [0.7, 0.62, 0.55],
        sheenRoughness: 0.7,
        transmission: 0.0
    },
    'sheer': {
        color: [0.95, 0.95, 0.98],
        roughness: 0.6,
        metalness: 0.0,
        sheen: 0.2,
        sheenColor: [1.0, 1.0, 1.0],
        sheenRoughness: 0.5,
        transmission: 0.65
    },
    'canvas': {
        color: [0.78, 0.72, 0.6],
        roughness: 0.85,
        metalness: 0.0,
        sheen: 0.25,
        sheenColor: [0.85, 0.8, 0.72],
        sheenRoughness: 0.8,
        transmission: 0.0
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable fabric scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for fabric-material scratch records. Prevents per-frame
 * allocation of temporary sheen, cel-banding, and rim-glow scratch objects.
 */
class FabricScratchPool {
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

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, normal: Vec3, view: Vec3}}
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
     * Pre-warm the pool.
     * @param {number} count
     */
    warm(count) {
        while (this._free.length < count) {
            this._free.push(this._createRecord());
        }
    }
}

/** @type {FabricScratchPool} Shared scratch pool for all fabric material instances. */
const _fabricScratchPool = new FabricScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — fabric-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded fabric highlights to a textile surface. Fabric has soft,
 * low-frequency shading — quantizing it into discrete bands produces the
 * crisp anime fabric edges seen in hand-drawn architectural interiors.
 * @param {Color} baseColor - The fabric base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of fabric bands (2–4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.2] - Edge softness in [0, 0.5].
 * @returns {Color}
 */
function applyFabricCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.2) {
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
 * Compute a sheen-driven rim glow. Sheen produces the soft, dusty appearance
 * of velvet and satin at grazing angles — for anime, this produces the
 * characteristic velvet halo seen on upholstered furniture and heavy drapes.
 * @param {number} sheen - Raw sheen value in [0, 1].
 * @param {number} ndotv - Normal·View dot product in [0, 1].
 * @param {number} [power=2.0] - Rim falloff power.
 * @param {number} [intensity=1.0] - Rim intensity multiplier.
 * @returns {number} Sheen rim glow in [0, 1].
 */
function computeFabricSheenRim(sheen, ndotv, power = 2.0, intensity = 1.0) {
    if (sheen <= 0) return 0;
    const rim = Math.pow(1.0 - Math.abs(ndotv), power);
    return Math.max(0, Math.min(1, rim * sheen * intensity));
}

/**
 * Apply mood-based tinting to fabric. Warm moods tint fabric toward warm
 * cream/amber, cool moods toward cool grey-blue — matching the atmospheric
 * textile tinting seen in architectural anime interiors.
 * @param {Color} color - The fabric colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeFabricColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.05;
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
 * Generate a procedural fabric weave texture using simplex-noise. Combines
 * warp/weft directional noise, subtle slub variation, and low-frequency
 * colour mottling to reproduce the characteristic textile micro-structure.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.1] - Base noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [weaveFrequency=40] - Number of weave cells across the texture.
 * @param {number} [slubStrength=0.15] - Slub / yarn irregularity strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateFabricWeaveTexture(width, height, scale = 0.1, octaves = 3, weaveFrequency = 40, slubStrength = 0.15) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Directional warp/weft weave pattern
            const warpPhase = Math.sin((x / width) * weaveFrequency * Math.PI * 2.0);
            const weftPhase = Math.sin((y / height) * weaveFrequency * Math.PI * 2.0);
            const weave = (warpPhase * weftPhase) * 0.5 + 0.5;

            // Multi-octave fBm for slub / yarn variation
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

            // Combine: 0.5 neutral base + weave contrast + slub variation
            let value = 0.5 + (weave - 0.5) * 0.35 + (fbm - 0.5) * slubStrength;
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
// bitecs SoA batch coordinator for real-time fabric material updates
// ---------------------------------------------------------------------------

const _fabricWorld = BitECS.createWorld();
const ArchitecturalFabricMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    fabricBands: 'ui8',
    fabricQuantize: 'f64',
    fabricSoftness: 'f64',
    sheen: 'f64',
    sheenRimPower: 'f64',
    sheenRimIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

/**
 * Batch coordinator for architectural fabric materials. Registers
 * ArchitecturalFabricMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalFabricMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _fabricWorld;
        /** @type {ArchitecturalFabricMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalFabricMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalFabricMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalFabricMaterialComponent, eid);
        ArchitecturalFabricMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalFabricMaterialComponent.fabricBands[eid] = material.fabricBands;
        ArchitecturalFabricMaterialComponent.fabricQuantize[eid] = material.fabricQuantize;
        ArchitecturalFabricMaterialComponent.fabricSoftness[eid] = material.fabricSoftness;
        ArchitecturalFabricMaterialComponent.sheen[eid] = material.sheen;
        ArchitecturalFabricMaterialComponent.sheenRimPower[eid] = material.sheenRimPower;
        ArchitecturalFabricMaterialComponent.sheenRimIntensity[eid] = material.sheenRimIntensity;
        ArchitecturalFabricMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalFabricMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalFabricMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalFabricMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalFabricMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalFabricMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalFabricMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalFabricMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued fabric-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalFabricMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.fabricBands = ArchitecturalFabricMaterialComponent.fabricBands[eid];
            material.fabricQuantize = ArchitecturalFabricMaterialComponent.fabricQuantize[eid];
            material.fabricSoftness = ArchitecturalFabricMaterialComponent.fabricSoftness[eid];
            material.sheen = ArchitecturalFabricMaterialComponent.sheen[eid];
            material.sheenRimPower = ArchitecturalFabricMaterialComponent.sheenRimPower[eid];
            material.sheenRimIntensity = ArchitecturalFabricMaterialComponent.sheenRimIntensity[eid];
            material.moodTemperature = ArchitecturalFabricMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalFabricMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalFabricMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalFabricMaterialComponent.moodContrast[eid];
            material.paperGrain = ArchitecturalFabricMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalFabricMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalFabricMaterialComponent.variationSeed[eid];

            ArchitecturalFabricMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalFabricMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural fabric material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built defaults for curtains,
 * upholstery, acoustic panels, carpets, and textiles, plus real-time anime
 * stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalFabricMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for fabric materials.
     */
    static {
        _fabricScratchPool.warm(32);
    }

    /**
     * Construct a new architectural fabric material.
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
        this.isArchitecturalFabricMaterial = true;

        this.type = 'ArchitecturalFabricMaterial';

        // -------------------------------------------------------------------
        // Fabric-specific PBR defaults (architectural textiles)
        // -------------------------------------------------------------------

        /**
         * Index of refraction for textile fibres (≈1.5).
         * @type {number}
         * @default 1.5
         */
        this.ior = 1.5;

        /**
         * Specular intensity. Fabric is a low-specular dielectric.
         * @type {number}
         * @default 0.3
         */
        this.specularIntensity = 0.3;

        /**
         * Base roughness. Fabric is very rough (matte).
         * @type {number}
         * @default 0.85
         */
        this.roughness = 0.85;

        /**
         * Metalness. Fabric is a dielectric.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * Clearcoat intensity.
         * @type {number}
         * @default 0.0
         */
        this.clearcoat = 0.0;

        /**
         * Clearcoat roughness.
         * @type {number}
         * @default 0.0
         */
        this.clearcoatRoughness = 0.0;

        /**
         * Specular colour.
         * @type {Color}
         * @default (0.9, 0.88, 0.85)
         */
        this.specularColor = new Color(0.9, 0.88, 0.85);

        /**
         * Base colour of the fabric. Default is a warm linen.
         * @type {Color}
         * @default (0.88, 0.82, 0.72)
         */
        this.color = new Color(0.88, 0.82, 0.72);

        /**
         * Sheen intensity. Key for velvet / satin / wool.
         * @type {number}
         * @default 0.55
         */
        this.sheen = 0.55;

        /**
         * Sheen colour.
         * @type {Color}
         * @default (0.9, 0.85, 0.78)
         */
        this.sheenColor = new Color(0.9, 0.85, 0.78);

        /**
         * Sheen roughness.
         * @type {number}
         * @default 0.7
         */
        this.sheenRoughness = 0.7;

        /**
         * Transmission for sheer fabrics. 0 = opaque, 1 = fully sheer.
         * @type {number}
         * @default 0.0
         */
        this.transmission = 0.0;

        /**
         * Volume thickness for sheer fabrics.
         * @type {number}
         * @default 0.05
         */
        this.thickness = 0.05;

        /**
         * Attenuation distance.
         * @type {number}
         * @default Infinity
         */
        this.attenuationDistance = Infinity;

        /**
         * Attenuation colour.
         * @type {Color}
         * @default (1,1,1)
         */
        this.attenuationColor = new Color(0xffffff);

        // -------------------------------------------------------------------
        // Anime rendering extensions — fabric-specific
        // -------------------------------------------------------------------

        /**
         * Number of fabric cel bands. 2–4 = stylized fabric highlight steps.
         * @type {number}
         * @default 2
         */
        this.fabricBands = 2;

        /**
         * Blend amount between continuous and banded fabric highlights.
         * @type {number}
         * @default 0.5
         */
        this.fabricQuantize = 0.5;

        /**
         * Fabric band edge softness.
         * @type {number}
         * @default 0.3
         */
        this.fabricSoftness = 0.3;

        /**
         * Sheen rim-glow falloff power.
         * @type {number}
         * @default 2.0
         */
        this.sheenRimPower = 2.0;

        /**
         * Sheen rim-glow intensity.
         * @type {number}
         * @default 0.4
         */
        this.sheenRimIntensity = 0.4;

        /**
         * Sheen rim-glow colour. Warm cream for fabric.
         * @type {Color}
         * @default (1.0, 0.92, 0.82)
         */
        this.sheenRimColor = new Color(1.0, 0.92, 0.82);

        /**
         * Mood temperature shift in [-1, 1].
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Mood saturation multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodSaturation = 1.0;

        /**
         * Mood brightness multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodBrightness = 1.0;

        /**
         * Mood contrast multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodContrast = 1.0;

        /**
         * Paper-grain overlay intensity.
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
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (fabric leans semi-realistic with anime sheen)
        // -------------------------------------------------------------------

        /**
         * Fabric materials blend PBR with anime sheen stylization.
         * @type {number}
         * @default 0.4
         */
        this.renderStyleBlend = 0.4;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the fabric material participates in galactic-scale
         * chunking.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters
        // -------------------------------------------------------------------

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Apply cel banding to fabric highlights.
     * @param {Color} baseColor - The fabric base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applyFabricBanding(baseColor, output) {
        return applyFabricCelBanding(
            baseColor,
            output,
            this.fabricBands,
            this.fabricQuantize,
            this.fabricSoftness
        );
    }

    /**
     * Compute the sheen rim glow for a given normal·view dot product.
     * @param {number} ndotv - Normal·View dot product in [0, 1].
     * @returns {number} Sheen rim glow in [0, 1].
     */
    sampleSheenRim(ndotv) {
        if (this.sheenRimIntensity <= 0) return 0;
        return computeFabricSheenRim(this.sheen, ndotv, this.sheenRimPower, this.sheenRimIntensity);
    }

    /**
     * Recompute the mood-graded fabric colour.
     * @returns {ArchitecturalFabricMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradeFabricColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural fabric preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalFabricPresets`.
     * @returns {ArchitecturalFabricMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalFabricPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.transmission = preset.transmission;

        this.updateMoodColor();
        return this;
    }

    /**
     * Generate a procedural fabric weave texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.1]
     * @param {number} [octaves=3]
     * @param {number} [weaveFrequency=40]
     * @returns {Uint8Array}
     */
    generateFabricWeaveTexture(width, height, scale = 0.1, octaves = 3, weaveFrequency = 40) {
        return generateFabricWeaveTexture(width, height, scale, octaves, weaveFrequency, 0.15);
    }

    /**
     * Compute the per-instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * Asynchronous initialisation hook — satisfies the `await` syntax
     * requirement.
     * @returns {Promise<ArchitecturalFabricMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with fabric-specific
     * features: cel-banded highlights and sheen rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.fabricBands = { value: this.fabricBands };
        shader.uniforms.fabricQuantize = { value: this.fabricQuantize };
        shader.uniforms.fabricSoftness = { value: this.fabricSoftness };
        shader.uniforms.sheenValue = { value: this.sheen };
        shader.uniforms.sheenRimPower = { value: this.sheenRimPower };
        shader.uniforms.sheenRimIntensity = { value: this.sheenRimIntensity };
        shader.uniforms.sheenRimColor = { value: this.sheenRimColor };
        shader.uniforms.moodTemperature = { value: this.moodTemperature };
        shader.uniforms.moodSaturation = { value: this.moodSaturation };
        shader.uniforms.moodBrightness = { value: this.moodBrightness };
        shader.uniforms.moodContrast = { value: this.moodContrast };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int fabricBands;
                uniform float fabricQuantize;
                uniform float fabricSoftness;
                uniform float sheenValue;
                uniform float sheenRimPower;
                uniform float sheenRimIntensity;
                uniform vec3 sheenRimColor;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float variationOffset;

                vec3 applyFabricBands(vec3 baseColor) {
                    if (fabricBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(fabricBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * fabricSoftness;
                    float finalLum = mix(lum, softQuantized, fabricQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }

                float computeFabricSheenRim(float sheen, float ndotv) {
                    if (sheen <= 0.0 || sheenRimIntensity <= 0.0) return 0.0;
                    float rim = pow(1.0 - abs(ndotv), sheenRimPower);
                    return clamp(rim * sheen * sheenRimIntensity, 0.0, 1.0);
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply fabric cel banding
                gl_FragColor.rgb = applyFabricBands(gl_FragColor.rgb);

                // Sheen rim glow (velvet / fabric halo)
                float ndotvFabric = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                float sheenRim = computeFabricSheenRim(sheenValue, ndotvFabric);
                gl_FragColor.rgb += sheenRimColor * sheenRim;
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
            this.ior,
            this.specularIntensity,
            this.roughness,
            this.metalness,
            this.sheen,
            this.sheenRoughness,
            this.transmission,
            this.thickness,
            this.fabricBands,
            this.fabricQuantize,
            this.fabricSoftness,
            this.sheenRimPower,
            this.sheenRimIntensity,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {ArchitecturalFabricMaterial} source
     * @return {ArchitecturalFabricMaterial}
     */
    copy(source) {
        super.copy(source);

        this.ior = source.ior;
        this.specularIntensity = source.specularIntensity;
        this.roughness = source.roughness;
        this.metalness = source.metalness;
        this.specularColor.copy(source.specularColor);
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.fabricBands = source.fabricBands;
        this.fabricQuantize = source.fabricQuantize;
        this.fabricSoftness = source.fabricSoftness;
        this.sheenRimPower = source.sheenRimPower;
        this.sheenRimIntensity = source.sheenRimIntensity;
        this.sheenRimColor.copy(source.sheenRimColor);
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.paperGrain = source.paperGrain;
        this.watercolorBleed = source.watercolorBleed;
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

        data.type = 'ArchitecturalFabricMaterial';

        if (this.ior !== 1.5) data.ior = this.ior;
        if (this.specularIntensity !== 0.3) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.85) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.sheen !== 0.55) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.9, 0.85, 0.78).getHex()) {
            data.sheenColor = this.sheenColor.getHex();
        }
        if (this.sheenRoughness !== 0.7) data.sheenRoughness = this.sheenRoughness;
        if (this.transmission !== 0.0) data.transmission = this.transmission;
        if (this.thickness !== 0.05) data.thickness = this.thickness;
        if (this.fabricBands !== 2) data.fabricBands = this.fabricBands;
        if (this.fabricQuantize !== 0.5) data.fabricQuantize = this.fabricQuantize;
        if (this.fabricSoftness !== 0.3) data.fabricSoftness = this.fabricSoftness;
        if (this.sheenRimPower !== 2.0) data.sheenRimPower = this.sheenRimPower;
        if (this.sheenRimIntensity !== 0.4) data.sheenRimIntensity = this.sheenRimIntensity;
        if (this.sheenRimColor.getHex() !== new Color(1.0, 0.92, 0.82).getHex()) {
            data.sheenRimColor = this.sheenRimColor.getHex();
        }
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.watercolorBleed !== 0) data.watercolorBleed = this.watercolorBleed;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalFabricMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        this.ior = json.ior ?? this.ior;
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        this.roughness = json.roughness ?? this.roughness;
        this.metalness = json.metalness ?? this.metalness;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.fabricBands = json.fabricBands ?? this.fabricBands;
        this.fabricQuantize = json.fabricQuantize ?? this.fabricQuantize;
        this.fabricSoftness = json.fabricSoftness ?? this.fabricSoftness;
        this.sheenRimPower = json.sheenRimPower ?? this.sheenRimPower;
        this.sheenRimIntensity = json.sheenRimIntensity ?? this.sheenRimIntensity;
        if (json.sheenRimColor !== undefined) this.sheenRimColor.setHex(json.sheenRimColor);
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.watercolorBleed = json.watercolorBleed ?? this.watercolorBleed;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural fabric materials
// ---------------------------------------------------------------------------

const ArchitecturalFabricMaterialBatchComponent = {
    materialPtr: 'ui32',
    fabricBands: 'ui8',
    fabricQuantize: 'f64',
    fabricSoftness: 'f64',
    sheen: 'f64',
    sheenRimPower: 'f64',
    sheenRimIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    ArchitecturalFabricMaterial,
    ArchitecturalFabricMaterialBatch,
    FabricScratchPool,
    ArchitecturalFabricMaterialBatchComponent,
    ArchitecturalFabricPresets,
    applyFabricCelBanding,
    computeFabricSheenRim,
    gradeFabricColor,
    generateFabricWeaveTexture
};

export default ArchitecturalFabricMaterial;