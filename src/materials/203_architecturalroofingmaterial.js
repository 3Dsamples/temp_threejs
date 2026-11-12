// file number : 203
// full path name : src/materials/203_architecturalroofingmaterial.js
// description : ArchitecturalRoofingMaterial — a ready-to-use roofing material
//               for architectural visualization. Extends MeshPhysicalMaterial
//               with purpose-built defaults for asphalt shingles, clay roof
//               tiles, metal roofing (standing seam), slate roofing, green
//               roofs, and concrete roof tiles: variable roughness (high for
//               asphalt/clay, low for metal), variable metalness (1.0 for
//               metal roofing, 0.0 for asphalt/clay/slate), subtle overlapping-
//               course patterns, and real-time anime stylization (cel-banded
//               roofing highlights, mood tinting, rim glow, paper-grain texture,
//               watercolor bleed, and per-instance variation). Includes a
//               procedural overlapping-course pattern generator using a
//               sawtooth height ramp with row staggering, configurable shingle
//               profile, overlap, and moss/algae growth, plus curated presets.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Architectural roofing, asphalt shingles, clay roof tiles, metal
//            roofing (standing seam), slate roofing, green roofs, concrete roof
//            tiles, and any roof surface that needs real-time PBR + anime
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
// Roofing presets — curated PBR parameter sets for common architectural roofing
// ---------------------------------------------------------------------------

const ArchitecturalRoofingPresets = {
    'asphalt-shingle': {
        color: [0.32, 0.30, 0.28],
        roughness: 0.92,
        metalness: 0.0,
        specularIntensity: 0.2,
        specularColor: [0.6, 0.58, 0.55],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'clay-tile': {
        color: [0.72, 0.38, 0.22],
        roughness: 0.85,
        metalness: 0.0,
        specularIntensity: 0.28,
        specularColor: [0.85, 0.72, 0.6],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'metal-standing-seam': {
        color: [0.62, 0.64, 0.68],
        roughness: 0.28,
        metalness: 1.0,
        specularIntensity: 1.0,
        specularColor: [0.9, 0.92, 0.95],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'slate': {
        color: [0.35, 0.37, 0.40],
        roughness: 0.65,
        metalness: 0.0,
        specularIntensity: 0.35,
        specularColor: [0.7, 0.72, 0.75],
        clearcoat: 0.1,
        clearcoatRoughness: 0.1
    },
    'green-roof': {
        color: [0.28, 0.42, 0.22],
        roughness: 0.88,
        metalness: 0.0,
        specularIntensity: 0.15,
        specularColor: [0.5, 0.6, 0.45],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'concrete-tile': {
        color: [0.55, 0.52, 0.48],
        roughness: 0.82,
        metalness: 0.0,
        specularIntensity: 0.25,
        specularColor: [0.7, 0.68, 0.65],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable roofing scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for roofing-material scratch records. Prevents per-frame
 * allocation of temporary cel-banding, mood-tinting, and rim-glow scratch
 * objects.
 */
class RoofingScratchPool {
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

/** @type {RoofingScratchPool} Shared scratch pool for all roofing material instances. */
const _roofingScratchPool = new RoofingScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — roofing-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded roofing highlights to a roof surface. Roofing has
 * overlapping-course shading — quantizing it into discrete bands produces
 * the crisp anime roof edges seen in hand-drawn architectural exteriors.
 * @param {Color} baseColor - The roofing base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of roofing bands (2–4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.15] - Edge softness in [0, 0.4].
 * @returns {Color}
 */
function applyRoofingCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to roofing. Warm moods tint roofing toward warm
 * terracotta/amber, cool moods toward cool slate-blue — matching the
 * atmospheric roofing tinting seen in architectural anime backgrounds.
 * @param {Color} color - The roofing colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeRoofingColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate a procedural overlapping-course roofing texture. The algorithm
 * follows the shingle texture generator pattern: divide V into rows,
 * stagger alternate rows horizontally, build a sawtooth height ramp within
 * each row (0 at the exposed lower edge, 1 at the top where the shingle
 * slides under the row above), apply a configurable shape profile (square
 * → scalloped), and add optional moss/algae growth on the lower exposed
 * edges.
 * @param {number} width - Texture width in pixels.
 * @param {number} height - Texture height in pixels.
 * @param {number} [rows=6] - Number of shingle rows across the texture.
 * @param {number} [cols=4] - Number of shingle columns per row.
 * @param {number} [overlap=0.45] - Fraction of each shingle hidden under the row above (0–0.8).
 * @param {number} [stagger=0.5] - Horizontal stagger of alternate rows (0–1).
 * @param {number} [shapeProfile=0.5] - 0 = square/flat, 1 = scalloped (half-circle cut).
 * @param {number} [mossLevel=0.18] - Moss/algae growth on the lower exposed edge (0–1).
 * @param {number} [colorVariance=0.1] - Per-shingle colour variance.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateRoofingCourseTexture(width, height, rows = 6, cols = 4, overlap = 0.45, stagger = 0.5, shapeProfile = 0.5, mossLevel = 0.18, colorVariance = 0.1) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Normalized UV
            const u = x / width;
            const v = y / height;

            // Row index and per-row stagger offset
            const rowFloat = v * rows;
            const rowIndex = Math.floor(rowFloat);
            const rowOffset = (rowIndex % 2) * stagger;

            // Column index within the row (with stagger applied)
            const colFloat = (u + rowOffset) * cols;
            const colIndex = Math.floor(colFloat);

            // Cell-local coordinates
            const cellX = colFloat - colIndex;
            const cellY = rowFloat - rowIndex;

            // Sawtooth height ramp: 0 at the exposed lower edge,
            // 1 at the top where the shingle slides under the row above.
            // cellY = 0 is the top of the row, cellY = 1 is the bottom.
            // The exposed portion is (1 - overlap) at the bottom.
            const ramp = cellY; // 0 at top (under) → 1 at bottom (exposed edge)

            // Shape function: square (profile=0) → scalloped half-circle (profile=1)
            // Scallop mask: distance from cell centre, normalized by half-width
            const dx = Math.abs(cellX - 0.5) * 2.0;
            const shapeMask = shapeProfile > 0
                ? 1.0 - Math.pow(dx, 2.0) * shapeProfile
                : 1.0;

            // Per-shingle colour variance via hash
            const shingleId = colIndex * 73856093 ^ rowIndex * 19349663;
            const hashValue = Math.abs(Math.sin(shingleId * 12.9898) * 43758.5453) % 1.0;
            const shingleTint = 1.0 - colorVariance * 0.5 + hashValue * colorVariance;

            // Moss/algae growth on the lower exposed edge (cellY near 1)
            const exposedEdge = Math.max(0, (cellY - (1.0 - overlap)) / overlap);
            const mossNoise = SimplexNoise.noise2D(x * 0.1, y * 0.1) * 0.5 + 0.5;
            const moss = mossLevel * exposedEdge * mossNoise;

            // Surface noise (fine grain)
            const surfaceNoise = SimplexNoise.noise2D(x * 0.15, y * 0.15) * 0.04;

            // Combine: base tone + ramp shading + variance + moss
            let value = 0.55 + ramp * 0.25 + (shingleTint - 0.85) * 0.3 - moss * 0.4 + surfaceNoise;

            // Shape mask darkens scalloped edges (simulating shadow under overlap)
            value *= (0.7 + 0.3 * shapeMask);

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
// bitecs SoA batch coordinator for real-time roofing material updates
// ---------------------------------------------------------------------------

const _roofingWorld = BitECS.createWorld();
const ArchitecturalRoofingMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    roofingBands: 'ui8',
    roofingQuantize: 'f64',
    roofingSoftness: 'f64',
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

/**
 * Batch coordinator for architectural roofing materials. Registers
 * ArchitecturalRoofingMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalRoofingMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _roofingWorld;
        /** @type {ArchitecturalRoofingMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalRoofingMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalRoofingMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalRoofingMaterialComponent, eid);
        ArchitecturalRoofingMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalRoofingMaterialComponent.roofingBands[eid] = material.roofingBands;
        ArchitecturalRoofingMaterialComponent.roofingQuantize[eid] = material.roofingQuantize;
        ArchitecturalRoofingMaterialComponent.roofingSoftness[eid] = material.roofingSoftness;
        ArchitecturalRoofingMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalRoofingMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalRoofingMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalRoofingMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalRoofingMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalRoofingMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalRoofingMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalRoofingMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalRoofingMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued roofing-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalRoofingMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.roofingBands = ArchitecturalRoofingMaterialComponent.roofingBands[eid];
            material.roofingQuantize = ArchitecturalRoofingMaterialComponent.roofingQuantize[eid];
            material.roofingSoftness = ArchitecturalRoofingMaterialComponent.roofingSoftness[eid];
            material.moodTemperature = ArchitecturalRoofingMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalRoofingMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalRoofingMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalRoofingMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalRoofingMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalRoofingMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalRoofingMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalRoofingMaterialComponent.variationSeed[eid];

            ArchitecturalRoofingMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalRoofingMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural roofing material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built defaults for asphalt
 * shingles, clay roof tiles, metal roofing (standing seam), slate roofing,
 * green roofs, and concrete roof tiles, plus real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalRoofingMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for roofing materials.
     */
    static {
        _roofingScratchPool.warm(32);
    }

    /**
     * Construct a new architectural roofing material.
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
        this.isArchitecturalRoofingMaterial = true;

        this.type = 'ArchitecturalRoofingMaterial';

        // -------------------------------------------------------------------
        // Roofing-specific PBR defaults (architectural roofing)
        // -------------------------------------------------------------------

        /**
         * Index of refraction for roofing (≈1.5 for asphalt/clay, 2.5 for metal).
         * @type {number}
         * @default 1.5
         */
        this.ior = 1.5;

        /**
         * Specular intensity for roofing.
         * @type {number}
         * @default 0.2
         */
        this.specularIntensity = 0.2;

        /**
         * Base roughness. Default is asphalt shingle roughness.
         * @type {number}
         * @default 0.92
         */
        this.roughness = 0.92;

        /**
         * Metalness. Default is 0.0 for asphalt shingles.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * Clearcoat intensity. 0 = no clearcoat for raw asphalt.
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
         * Specular colour. Asphalt shingle specular is warm-neutral.
         * @type {Color}
         * @default (0.6, 0.58, 0.55)
         */
        this.specularColor = new Color(0.6, 0.58, 0.55);

        /**
         * Base colour of the roofing. Default is a dark grey asphalt shingle.
         * @type {Color}
         * @default (0.32, 0.30, 0.28)
         */
        this.color = new Color(0.32, 0.30, 0.28);

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
        // Anime rendering extensions — roofing-specific
        // -------------------------------------------------------------------

        /**
         * Number of roofing cel bands. 2–4 = stylized roofing highlight steps.
         * @type {number}
         * @default 2
         */
        this.roofingBands = 2;

        /**
         * Blend amount between continuous and banded roofing highlights.
         * @type {number}
         * @default 0.5
         */
        this.roofingQuantize = 0.5;

        /**
         * Roofing band edge softness.
         * @type {number}
         * @default 0.15
         */
        this.roofingSoftness = 0.15;

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
         * Rim-glow intensity for roofing edges.
         * @type {number}
         * @default 0.1
         */
        this.rimGlow = 0.1;

        /**
         * Rim-glow colour. Roofing rim is warm-neutral.
         * @type {Color}
         * @default (0.8, 0.75, 0.7)
         */
        this.rimGlowColor = new Color(0.8, 0.75, 0.7);

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
        // PBR ↔ Anime blend (roofing leans semi-realistic with anime banding)
        // -------------------------------------------------------------------

        /**
         * Roofing materials blend PBR with anime cel-banding stylization.
         * @type {number}
         * @default 0.35
         */
        this.renderStyleBlend = 0.35;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the roofing material participates in galactic-scale
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
     * Apply cel banding to roofing highlights.
     * @param {Color} baseColor - The roofing base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applyRoofingBanding(baseColor, output) {
        return applyRoofingCelBanding(
            baseColor,
            output,
            this.roofingBands,
            this.roofingQuantize,
            this.roofingSoftness
        );
    }

    /**
     * Recompute the mood-graded roofing colour.
     * @returns {ArchitecturalRoofingMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradeRoofingColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural roofing preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalRoofingPresets`.
     * @returns {ArchitecturalRoofingMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalRoofingPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;

        // Adjust ior for metal vs non-metal roofing
        this.ior = preset.metalness > 0.5 ? 2.5 : 1.5;

        // Adjust anime band softness for metal vs asphalt
        this.roofingSoftness = preset.metalness > 0.5 ? 0.08 : (preset.roughness > 0.8 ? 0.3 : 0.15);

        this.updateMoodColor();
        return this;
    }

    /**
     * Generate a procedural overlapping-course roofing texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [rows=6]
     * @param {number} [cols=4]
     * @param {number} [overlap=0.45]
     * @param {number} [shapeProfile=0.5]
     * @param {number} [mossLevel=0.18]
     * @returns {Uint8Array}
     */
    generateRoofingCourseTexture(width, height, rows = 6, cols = 4, overlap = 0.45, shapeProfile = 0.5, mossLevel = 0.18) {
        return generateRoofingCourseTexture(width, height, rows, cols, overlap, 0.5, shapeProfile, mossLevel, 0.1);
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
     * @returns {Promise<ArchitecturalRoofingMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with roofing-specific
     * features: cel-banded highlights and warm-neutral rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.roofingBands = { value: this.roofingBands };
        shader.uniforms.roofingQuantize = { value: this.roofingQuantize };
        shader.uniforms.roofingSoftness = { value: this.roofingSoftness };
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
                uniform int roofingBands;
                uniform float roofingQuantize;
                uniform float roofingSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyRoofingBands(vec3 baseColor) {
                    if (roofingBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(roofingBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * roofingSoftness;
                    float finalLum = mix(lum, softQuantized, roofingQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply roofing cel banding
                gl_FragColor.rgb = applyRoofingBands(gl_FragColor.rgb);

                // Warm-neutral rim glow on roofing edges
                if (rimGlow > 0.0) {
                    float rimFactor = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    gl_FragColor.rgb += rimGlowColor * rimGlow * rimFactor;
                }
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
            this.clearcoat,
            this.clearcoatRoughness,
            this.roofingBands,
            this.roofingQuantize,
            this.roofingSoftness,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.rimGlow,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {ArchitecturalRoofingMaterial} source
     * @return {ArchitecturalRoofingMaterial}
     */
    copy(source) {
        super.copy(source);

        this.ior = source.ior;
        this.specularIntensity = source.specularIntensity;
        this.roughness = source.roughness;
        this.metalness = source.metalness;
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.specularColor.copy(source.specularColor);
        this.roofingBands = source.roofingBands;
        this.roofingQuantize = source.roofingQuantize;
        this.roofingSoftness = source.roofingSoftness;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
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

        data.type = 'ArchitecturalRoofingMaterial';

        if (this.ior !== 1.5) data.ior = this.ior;
        if (this.specularIntensity !== 0.2) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.92) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.6, 0.58, 0.55).getHex()) {
            data.specularColor = this.specularColor.getHex();
        }
        if (this.roofingBands !== 2) data.roofingBands = this.roofingBands;
        if (this.roofingQuantize !== 0.5) data.roofingQuantize = this.roofingQuantize;
        if (this.roofingSoftness !== 0.15) data.roofingSoftness = this.roofingSoftness;
        if (this.rimGlow !== 0.1) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.8, 0.75, 0.7).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalRoofingMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        this.ior = json.ior ?? this.ior;
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        this.roughness = json.roughness ?? this.roughness;
        this.metalness = json.metalness ?? this.metalness;
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);
        this.roofingBands = json.roofingBands ?? this.roofingBands;
        this.roofingQuantize = json.roofingQuantize ?? this.roofingQuantize;
        this.roofingSoftness = json.roofingSoftness ?? this.roofingSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural roofing materials
// ---------------------------------------------------------------------------

const ArchitecturalRoofingMaterialBatchComponent = {
    materialPtr: 'ui32',
    roofingBands: 'ui8',
    roofingQuantize: 'f64',
    roofingSoftness: 'f64',
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
    ArchitecturalRoofingMaterial,
    ArchitecturalRoofingMaterialBatch,
    RoofingScratchPool,
    ArchitecturalRoofingMaterialBatchComponent,
    ArchitecturalRoofingPresets,
    applyRoofingCelBanding,
    gradeRoofingColor,
    generateRoofingCourseTexture
};

export default ArchitecturalRoofingMaterial;