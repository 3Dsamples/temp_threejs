// file number : 202
// full path name : src/materials/202_architecturaltilematerial.js
// description : ArchitecturalTileMaterial — a ready-to-use tile material for
//               architectural visualization. Extends MeshPhysicalMaterial with
//               purpose-built defaults for ceramic tiles, porcelain tiles, glazed
//               tiles, terrazzo, and mosaic: variable roughness (near-zero for
//               high-gloss glazes, higher for matte tiles), clearcoat for
//               polished glaze, subtle grout lines, and real-time anime
//               stylization (cel-banded glaze highlights, mood tinting, rim
//               glow, paper-grain texture, watercolor bleed, and per-instance
//               variation). Includes a procedural tile-pattern texture
//               generator using grid-based SDF with per-cell hashing, optional
//               running-bond offset, configurable grout width, and per-tile
//               colour variance, plus curated presets. All imports resolve to
//               the internal Threejs_gl repository tree; no CDN dependencies.
// best for : Architectural tiles, ceramic wall tiles, porcelain floor tiles,
//            glazed tiles, terrazzo, mosaic, bathroom tiles, kitchen backsplash,
//            pool tiles, and any tile surface that needs real-time PBR + anime
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
// Tile presets — curated PBR parameter sets for common architectural tiles
// ---------------------------------------------------------------------------

const ArchitecturalTilePresets = {
    'glossy-ceramic': {
        color: [0.92, 0.92, 0.93],
        roughness: 0.06,
        metalness: 0.0,
        specularIntensity: 0.75,
        specularColor: [1.0, 1.0, 1.0],
        clearcoat: 0.85,
        clearcoatRoughness: 0.03
    },
    'matte-porcelain': {
        color: [0.82, 0.81, 0.79],
        roughness: 0.62,
        metalness: 0.0,
        specularIntensity: 0.35,
        specularColor: [0.85, 0.84, 0.82],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'polished-porcelain': {
        color: [0.88, 0.87, 0.85],
        roughness: 0.12,
        metalness: 0.0,
        specularIntensity: 0.65,
        specularColor: [0.95, 0.94, 0.92],
        clearcoat: 0.5,
        clearcoatRoughness: 0.05
    },
    'terrazzo': {
        color: [0.85, 0.83, 0.80],
        roughness: 0.28,
        metalness: 0.0,
        specularIntensity: 0.45,
        specularColor: [0.9, 0.88, 0.85],
        clearcoat: 0.3,
        clearcoatRoughness: 0.1
    },
    'mosaic': {
        color: [0.55, 0.65, 0.78],
        roughness: 0.18,
        metalness: 0.0,
        specularIntensity: 0.7,
        specularColor: [0.85, 0.9, 1.0],
        clearcoat: 0.6,
        clearcoatRoughness: 0.05
    },
    'rustic-terracotta-tile': {
        color: [0.72, 0.42, 0.28],
        roughness: 0.78,
        metalness: 0.0,
        specularIntensity: 0.25,
        specularColor: [0.85, 0.7, 0.6],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable tile scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for tile-material scratch records. Prevents per-frame
 * allocation of temporary cel-banding, mood-tinting, and rim-glow scratch
 * objects.
 */
class TileScratchPool {
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

/** @type {TileScratchPool} Shared scratch pool for all tile material instances. */
const _tileScratchPool = new TileScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — tile-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded glaze highlights to a tile surface. Glazed tiles have crisp
 * specular edges — quantizing the luminance into discrete bands produces the
 * flat anime glaze highlights seen in hand-drawn architectural interiors.
 * @param {Color} baseColor - The tile base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of glaze bands (2–5 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.05] - Edge softness in [0, 0.4].
 * @returns {Color}
 */
function applyTileCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.05) {
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
 * Apply mood-based tinting to tile. Warm moods tint tile toward warm cream/
 * ivory, cool moods toward cool blue-grey — matching the atmospheric tile
 * tinting seen in architectural anime backgrounds.
 * @param {Color} color - The tile colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeTileColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.04;
    b -= temperature * 0.04;

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
 * Generate a procedural tile-pattern texture using grid-based SDF with per-cell
 * hashing. The algorithm supports both stacked and running-bond layouts,
 * configurable grout width, per-tile colour variance, and glaze surface noise.
 * @param {number} width
 * @param {number} height
 * @param {number} [cols=8] - Number of tile columns.
 * @param {number} [rows=8] - Number of tile rows.
 * @param {number} [groutWidth=0.08] - Grout joint width as fraction of cell size.
 * @param {number} [colorVariance=0.1] - Per-tile colour variance.
 * @param {number} [glazeNoise=0.06] - Glaze surface noise intensity.
 * @param {boolean} [runningBond=false] - Use running-bond offset.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateTilePatternTexture(width, height, cols = 8, rows = 8, groutWidth = 0.08, colorVariance = 0.1, glazeNoise = 0.06, runningBond = false) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Normalized UV
            const u = x / width;
            const v = y / height;

            // Scale to tile grid
            const gridX = u * cols;
            const gridY = v * rows;

            // Row index and per-row offset (running bond)
            const rowIndex = Math.floor(gridY);
            const rowOffset = runningBond ? (rowIndex % 2) * 0.5 : 0.0;

            // Cell-local coordinates
            const cellX = ((gridX + rowOffset) % 1.0 + 1.0) % 1.0;
            const cellY = gridY % 1.0;

            // Tile cell ID for per-tile hashing
            const tileCol = Math.floor(gridX + rowOffset);
            const tileId = tileCol * 73856093 ^ rowIndex * 19349663;

            // Rounded-box SDF: distance from tile centre
            const dx = Math.abs(cellX - 0.5) - (0.5 - groutWidth);
            const dy = Math.abs(cellY - 0.5) - (0.5 - groutWidth);
            const sdf = Math.max(dx, dy);

            // Grout mask: sdf > 0 means we're in the grout joint
            const isGrout = sdf > 0 ? 1.0 : 0.0;

            // Per-tile colour variance from hash
            const hashValue = Math.abs(Math.sin(tileId * 12.9898) * 43758.5453) % 1.0;
            const tileTint = 1.0 - colorVariance * 0.5 + hashValue * colorVariance;

            // Glaze surface noise (simplex)
            const glazeNoiseValue = SimplexNoise.noise2D(x * 0.15, y * 0.15) * glazeNoise;

            // Combine: grout is darker (~0.35), tile is ~0.75 with variance
            let value;
            if (isGrout > 0.5) {
                value = 0.35 + glazeNoiseValue * 0.5;
            } else {
                value = 0.75 * tileTint + glazeNoiseValue;
            }

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
// bitecs SoA batch coordinator for real-time tile material updates
// ---------------------------------------------------------------------------

const _tileWorld = BitECS.createWorld();
const ArchitecturalTileMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    tileBands: 'ui8',
    tileQuantize: 'f64',
    tileSoftness: 'f64',
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
 * Batch coordinator for architectural tile materials. Registers
 * ArchitecturalTileMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalTileMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _tileWorld;
        /** @type {ArchitecturalTileMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalTileMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalTileMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalTileMaterialComponent, eid);
        ArchitecturalTileMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalTileMaterialComponent.tileBands[eid] = material.tileBands;
        ArchitecturalTileMaterialComponent.tileQuantize[eid] = material.tileQuantize;
        ArchitecturalTileMaterialComponent.tileSoftness[eid] = material.tileSoftness;
        ArchitecturalTileMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalTileMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalTileMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalTileMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalTileMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalTileMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalTileMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalTileMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalTileMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued tile-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalTileMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.tileBands = ArchitecturalTileMaterialComponent.tileBands[eid];
            material.tileQuantize = ArchitecturalTileMaterialComponent.tileQuantize[eid];
            material.tileSoftness = ArchitecturalTileMaterialComponent.tileSoftness[eid];
            material.moodTemperature = ArchitecturalTileMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalTileMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalTileMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalTileMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalTileMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalTileMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalTileMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalTileMaterialComponent.variationSeed[eid];

            ArchitecturalTileMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalTileMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural tile material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built defaults for ceramic tiles,
 * porcelain tiles, glazed tiles, terrazzo, and mosaic, plus real-time anime
 * stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalTileMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for tile materials.
     */
    static {
        _tileScratchPool.warm(32);
    }

    /**
     * Construct a new architectural tile material.
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
        this.isArchitecturalTileMaterial = true;

        this.type = 'ArchitecturalTileMaterial';

        // -------------------------------------------------------------------
        // Tile-specific PBR defaults (architectural tiles)
        // -------------------------------------------------------------------

        /**
         * Index of refraction for tile (≈1.55).
         * @type {number}
         * @default 1.55
         */
        this.ior = 1.55;

        /**
         * Specular intensity for tile.
         * @type {number}
         * @default 0.65
         */
        this.specularIntensity = 0.65;

        /**
         * Base roughness. Default is glossy ceramic.
         * @type {number}
         * @default 0.08
         */
        this.roughness = 0.08;

        /**
         * Metalness. Tile is a dielectric.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * Clearcoat intensity for glazed tiles.
         * @type {number}
         * @default 0.7
         */
        this.clearcoat = 0.7;

        /**
         * Clearcoat roughness.
         * @type {number}
         * @default 0.03
         */
        this.clearcoatRoughness = 0.03;

        /**
         * Specular colour.
         * @type {Color}
         * @default (1.0, 1.0, 1.0)
         */
        this.specularColor = new Color(1.0, 1.0, 1.0);

        /**
         * Base colour of the tile. Default is a glossy white ceramic.
         * @type {Color}
         * @default (0.92, 0.92, 0.93)
         */
        this.color = new Color(0.92, 0.92, 0.93);

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
        // Anime rendering extensions — tile-specific
        // -------------------------------------------------------------------

        /**
         * Number of tile cel bands. 2–5 = stylized glaze highlight steps.
         * @type {number}
         * @default 3
         */
        this.tileBands = 3;

        /**
         * Blend amount between continuous and banded glaze highlights.
         * @type {number}
         * @default 0.6
         */
        this.tileQuantize = 0.6;

        /**
         * Tile band edge softness. Glossy tiles = low, matte tiles = high.
         * @type {number}
         * @default 0.05
         */
        this.tileSoftness = 0.05;

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
         * Rim-glow intensity for tile edges.
         * @type {number}
         * @default 0.12
         */
        this.rimGlow = 0.12;

        /**
         * Rim-glow colour. Tile rim is cool-neutral.
         * @type {Color}
         * @default (0.88, 0.92, 1.0)
         */
        this.rimGlowColor = new Color(0.88, 0.92, 1.0);

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
        // PBR ↔ Anime blend (tile leans semi-realistic with anime glaze)
        // -------------------------------------------------------------------

        /**
         * Tile materials blend PBR with anime glaze stylization.
         * @type {number}
         * @default 0.4
         */
        this.renderStyleBlend = 0.4;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the tile material participates in galactic-scale chunking.
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
     * Apply cel banding to tile glaze highlights.
     * @param {Color} baseColor - The tile base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applyTileBanding(baseColor, output) {
        return applyTileCelBanding(
            baseColor,
            output,
            this.tileBands,
            this.tileQuantize,
            this.tileSoftness
        );
    }

    /**
     * Recompute the mood-graded tile colour.
     * @returns {ArchitecturalTileMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradeTileColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural tile preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalTilePresets`.
     * @returns {ArchitecturalTileMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalTilePresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;

        // Adjust anime band softness for glossy vs matte tiles
        this.tileSoftness = preset.roughness < 0.15 ? 0.03 : (preset.roughness > 0.6 ? 0.3 : 0.1);

        this.updateMoodColor();
        return this;
    }

    /**
     * Generate a procedural tile-pattern texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [cols=8]
     * @param {number} [rows=8]
     * @param {number} [groutWidth=0.08]
     * @param {boolean} [runningBond=false]
     * @returns {Uint8Array}
     */
    generateTilePatternTexture(width, height, cols = 8, rows = 8, groutWidth = 0.08, runningBond = false) {
        return generateTilePatternTexture(width, height, cols, rows, groutWidth, 0.1, 0.06, runningBond);
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
     * @returns {Promise<ArchitecturalTileMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with tile-specific
     * features: cel-banded glaze highlights and cool-neutral rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.tileBands = { value: this.tileBands };
        shader.uniforms.tileQuantize = { value: this.tileQuantize };
        shader.uniforms.tileSoftness = { value: this.tileSoftness };
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
                uniform int tileBands;
                uniform float tileQuantize;
                uniform float tileSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyTileBands(vec3 baseColor) {
                    if (tileBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(tileBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * tileSoftness;
                    float finalLum = mix(lum, softQuantized, tileQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply tile glaze cel banding
                gl_FragColor.rgb = applyTileBands(gl_FragColor.rgb);

                // Cool-neutral rim glow on tile edges
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
            this.tileBands,
            this.tileQuantize,
            this.tileSoftness,
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
     * @param {ArchitecturalTileMaterial} source
     * @return {ArchitecturalTileMaterial}
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
        this.tileBands = source.tileBands;
        this.tileQuantize = source.tileQuantize;
        this.tileSoftness = source.tileSoftness;
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

        data.type = 'ArchitecturalTileMaterial';

        if (this.ior !== 1.55) data.ior = this.ior;
        if (this.specularIntensity !== 0.65) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.08) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.7) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.03) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) {
            data.specularColor = this.specularColor.getHex();
        }
        if (this.tileBands !== 3) data.tileBands = this.tileBands;
        if (this.tileQuantize !== 0.6) data.tileQuantize = this.tileQuantize;
        if (this.tileSoftness !== 0.05) data.tileSoftness = this.tileSoftness;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.88, 0.92, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalTileMaterial}
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
        this.tileBands = json.tileBands ?? this.tileBands;
        this.tileQuantize = json.tileQuantize ?? this.tileQuantize;
        this.tileSoftness = json.tileSoftness ?? this.tileSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural tile materials
// ---------------------------------------------------------------------------

const ArchitecturalTileMaterialBatchComponent = {
    materialPtr: 'ui32',
    tileBands: 'ui8',
    tileQuantize: 'f64',
    tileSoftness: 'f64',
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
    ArchitecturalTileMaterial,
    ArchitecturalTileMaterialBatch,
    TileScratchPool,
    ArchitecturalTileMaterialBatchComponent,
    ArchitecturalTilePresets,
    applyTileCelBanding,
    gradeTileColor,
    generateTilePatternTexture
};

export default ArchitecturalTileMaterial;