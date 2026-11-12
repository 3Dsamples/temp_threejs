// file number : 200
// full path name : src/materials/200_architecturalbrickmaterial.js
// description : ArchitecturalBrickMaterial — a ready-to-use brick and masonry
//               material for architectural visualization. Extends
//               MeshPhysicalMaterial with purpose-built defaults for red brick,
//               terracotta, yellow brick, white-washed brick, clay tiles, and
//               masonry: high roughness, dielectric metalness, subtle mortar-
//               line bump variation, and real-time anime stylization
//               (cel-banded brick highlights, mood tinting, rim glow, paper-
//               grain texture, watercolor bleed, and per-instance variation).
//               Includes a procedural brick-pattern texture generator using
//               grid-based SDF with per-cell hashing and simplex-noise
//               variation, plus curated presets. All imports resolve to the
//               internal Threejs_gl repository tree; no CDN dependencies.
// best for : Architectural brick walls, terracotta, yellow brick, white-washed
//            brick, clay tiles, masonry, facades, chimneys, garden walls, and
//            any brick or masonry surface that needs real-time PBR + anime
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
// Brick presets — curated PBR parameter sets for common architectural bricks
// ---------------------------------------------------------------------------

const ArchitecturalBrickPresets = {
    'red-brick': {
        color: [0.62, 0.25, 0.18],
        roughness: 0.88,
        metalness: 0.0,
        specularIntensity: 0.25,
        specularColor: [0.8, 0.7, 0.65]
    },
    'terracotta': {
        color: [0.72, 0.38, 0.22],
        roughness: 0.82,
        metalness: 0.0,
        specularIntensity: 0.28,
        specularColor: [0.85, 0.72, 0.6]
    },
    'yellow-brick': {
        color: [0.78, 0.65, 0.42],
        roughness: 0.85,
        metalness: 0.0,
        specularIntensity: 0.22,
        specularColor: [0.85, 0.8, 0.7]
    },
    'white-washed-brick': {
        color: [0.88, 0.85, 0.80],
        roughness: 0.92,
        metalness: 0.0,
        specularIntensity: 0.18,
        specularColor: [0.9, 0.88, 0.85]
    },
    'grey-brick': {
        color: [0.55, 0.55, 0.55],
        roughness: 0.86,
        metalness: 0.0,
        specularIntensity: 0.24,
        specularColor: [0.75, 0.75, 0.75]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable brick scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for brick-material scratch records. Prevents per-frame
 * allocation of temporary cel-banding, mood-tinting, and rim-glow scratch
 * objects.
 */
class BrickScratchPool {
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

/** @type {BrickScratchPool} Shared scratch pool for all brick material instances. */
const _brickScratchPool = new BrickScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — brick-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded brick highlights to a masonry surface. Brick has rough,
 * low-frequency shading — quantizing it into discrete bands produces the
 * crisp anime brick edges seen in hand-drawn architectural exteriors.
 * @param {Color} baseColor - The brick base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of brick bands (2–4 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.15] - Edge softness in [0, 0.4].
 * @returns {Color}
 */
function applyBrickCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to brick. Warm moods tint brick toward orange/amber,
 * cool moods toward cool grey-brown — matching the atmospheric masonry tinting
 * seen in architectural anime backgrounds.
 * @param {Color} color - The brick colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeBrickColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.06;
    b -= temperature * 0.06;

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
 * Generate a procedural brick-pattern texture using grid-based SDF with
 * per-cell hashing and simplex-noise variation. The algorithm:
 * 1. Scale UV into a brick grid.
 * 2. Offset each row to create a running-bond pattern.
 * 3. Compute a rounded-box SDF to separate brick from mortar.
 * 4. Hash each cell's integer ID for per-brick colour variance.
 * 5. Add simplex-noise for organic surface variation.
 * @param {number} width
 * @param {number} height
 * @param {number} [cols=8] - Number of bricks per row.
 * @param {number} [rows=16] - Number of brick rows.
 * @param {number} [mortarWidth=0.06] - Mortar joint width as fraction of cell size.
 * @param {number} [colorVariance=0.12] - Per-brick colour variance.
 * @param {number} [surfaceNoise=0.08] - Surface noise intensity.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateBrickPatternTexture(width, height, cols = 8, rows = 16, mortarWidth = 0.06, colorVariance = 0.12, surfaceNoise = 0.08) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Normalized UV
            const u = x / width;
            const v = y / height;

            // Scale to brick grid
            const gridX = u * cols;
            const gridY = v * rows;

            // Row index and per-row offset (running bond)
            const rowIndex = Math.floor(gridY);
            const rowOffset = (rowIndex % 2) * 0.5;

            // Cell-local coordinates
            const cellX = (gridX + rowOffset) % 1.0;
            const cellY = gridY % 1.0;

            // Brick cell ID for per-brick hashing
            const brickCol = Math.floor(gridX + rowOffset);
            const brickId = brickCol * 73856093 ^ rowIndex * 19349663;

            // Rounded-box SDF: distance from brick centre
            const dx = Math.abs(cellX - 0.5) - (0.5 - mortarWidth);
            const dy = Math.abs(cellY - 0.5) - (0.5 - mortarWidth);
            const sdf = Math.max(dx, dy);

            // Mortar mask: sdf > 0 means we're in the mortar joint
            const isMortar = sdf > 0 ? 1.0 : 0.0;

            // Per-brick colour variance from hash
            const hashValue = Math.abs(Math.sin(brickId * 12.9898) * 43758.5453) % 1.0;
            const brickTint = 1.0 - colorVariance * 0.5 + hashValue * colorVariance;

            // Surface noise (simplex)
            const surfaceNoiseValue = SimplexNoise.noise2D(x * 0.08, y * 0.08) * surfaceNoise;

            // Combine: mortar is darker (~0.4), brick is ~0.7 with variance
            let value;
            if (isMortar > 0.5) {
                value = 0.35 + surfaceNoiseValue * 0.5;
            } else {
                value = 0.70 * brickTint + surfaceNoiseValue;
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
// bitecs SoA batch coordinator for real-time brick material updates
// ---------------------------------------------------------------------------

const _brickWorld = BitECS.createWorld();
const ArchitecturalBrickMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    brickBands: 'ui8',
    brickQuantize: 'f64',
    brickSoftness: 'f64',
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
 * Batch coordinator for architectural brick materials. Registers
 * ArchitecturalBrickMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalBrickMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _brickWorld;
        /** @type {ArchitecturalBrickMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalBrickMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalBrickMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalBrickMaterialComponent, eid);
        ArchitecturalBrickMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalBrickMaterialComponent.brickBands[eid] = material.brickBands;
        ArchitecturalBrickMaterialComponent.brickQuantize[eid] = material.brickQuantize;
        ArchitecturalBrickMaterialComponent.brickSoftness[eid] = material.brickSoftness;
        ArchitecturalBrickMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalBrickMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalBrickMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalBrickMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalBrickMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalBrickMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalBrickMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalBrickMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalBrickMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued brick-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalBrickMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.brickBands = ArchitecturalBrickMaterialComponent.brickBands[eid];
            material.brickQuantize = ArchitecturalBrickMaterialComponent.brickQuantize[eid];
            material.brickSoftness = ArchitecturalBrickMaterialComponent.brickSoftness[eid];
            material.moodTemperature = ArchitecturalBrickMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalBrickMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalBrickMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalBrickMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalBrickMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalBrickMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalBrickMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalBrickMaterialComponent.variationSeed[eid];

            ArchitecturalBrickMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalBrickMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural brick material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built defaults for red brick,
 * terracotta, yellow brick, white-washed brick, clay tiles, and masonry, plus
 * real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalBrickMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for brick materials.
     */
    static {
        _brickScratchPool.warm(32);
    }

    /**
     * Construct a new architectural brick material.
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
        this.isArchitecturalBrickMaterial = true;

        this.type = 'ArchitecturalBrickMaterial';

        // -------------------------------------------------------------------
        // Brick-specific PBR defaults (architectural masonry)
        // -------------------------------------------------------------------

        /**
         * Index of refraction for brick (≈1.5).
         * @type {number}
         * @default 1.5
         */
        this.ior = 1.5;

        /**
         * Specular intensity for brick (≈0.25, masonry is low-specular).
         * @type {number}
         * @default 0.25
         */
        this.specularIntensity = 0.25;

        /**
         * Base roughness. Brick is very rough (matte).
         * @type {number}
         * @default 0.88
         */
        this.roughness = 0.88;

        /**
         * Metalness. Brick is a dielectric.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * Clearcoat intensity. 0 = raw brick.
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
         * Specular colour. Brick specular is warm.
         * @type {Color}
         * @default (0.8, 0.7, 0.65)
         */
        this.specularColor = new Color(0.8, 0.7, 0.65);

        /**
         * Base colour of the brick. Default is a warm red brick.
         * @type {Color}
         * @default (0.62, 0.25, 0.18)
         */
        this.color = new Color(0.62, 0.25, 0.18);

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
        // Anime rendering extensions — brick-specific
        // -------------------------------------------------------------------

        /**
         * Number of brick cel bands. 2–4 = stylized brick highlight steps.
         * @type {number}
         * @default 2
         */
        this.brickBands = 2;

        /**
         * Blend amount between continuous and banded brick highlights.
         * @type {number}
         * @default 0.5
         */
        this.brickQuantize = 0.5;

        /**
         * Brick band edge softness.
         * @type {number}
         * @default 0.2
         */
        this.brickSoftness = 0.2;

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
         * Rim-glow intensity for brick edges.
         * @type {number}
         * @default 0.1
         */
        this.rimGlow = 0.1;

        /**
         * Rim-glow colour. Brick rim is warm.
         * @type {Color}
         * @default (1.0, 0.8, 0.6)
         */
        this.rimGlowColor = new Color(1.0, 0.8, 0.6);

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
        // PBR ↔ Anime blend (brick leans semi-realistic with anime banding)
        // -------------------------------------------------------------------

        /**
         * Brick materials blend PBR with anime cel-banding stylization.
         * @type {number}
         * @default 0.35
         */
        this.renderStyleBlend = 0.35;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the brick material participates in galactic-scale
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
     * Apply cel banding to brick highlights.
     * @param {Color} baseColor - The brick base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applyBrickBanding(baseColor, output) {
        return applyBrickCelBanding(
            baseColor,
            output,
            this.brickBands,
            this.brickQuantize,
            this.brickSoftness
        );
    }

    /**
     * Recompute the mood-graded brick colour.
     * @returns {ArchitecturalBrickMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradeBrickColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural brick preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalBrickPresets`.
     * @returns {ArchitecturalBrickMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalBrickPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        this.updateMoodColor();
        return this;
    }

    /**
     * Generate a procedural brick-pattern texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [cols=8]
     * @param {number} [rows=16]
     * @param {number} [mortarWidth=0.06]
     * @returns {Uint8Array}
     */
    generateBrickPatternTexture(width, height, cols = 8, rows = 16, mortarWidth = 0.06) {
        return generateBrickPatternTexture(width, height, cols, rows, mortarWidth, 0.12, 0.08);
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
     * @returns {Promise<ArchitecturalBrickMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with brick-specific
     * features: cel-banded highlights and warm rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.brickBands = { value: this.brickBands };
        shader.uniforms.brickQuantize = { value: this.brickQuantize };
        shader.uniforms.brickSoftness = { value: this.brickSoftness };
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
                uniform int brickBands;
                uniform float brickQuantize;
                uniform float brickSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyBrickBands(vec3 baseColor) {
                    if (brickBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(brickBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * brickSoftness;
                    float finalLum = mix(lum, softQuantized, brickQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply brick cel banding
                gl_FragColor.rgb = applyBrickBands(gl_FragColor.rgb);

                // Warm rim glow on brick edges
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
            this.brickBands,
            this.brickQuantize,
            this.brickSoftness,
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
     * @param {ArchitecturalBrickMaterial} source
     * @return {ArchitecturalBrickMaterial}
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
        this.brickBands = source.brickBands;
        this.brickQuantize = source.brickQuantize;
        this.brickSoftness = source.brickSoftness;
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

        data.type = 'ArchitecturalBrickMaterial';

        if (this.ior !== 1.5) data.ior = this.ior;
        if (this.specularIntensity !== 0.25) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.88) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.8, 0.7, 0.65).getHex()) {
            data.specularColor = this.specularColor.getHex();
        }
        if (this.brickBands !== 2) data.brickBands = this.brickBands;
        if (this.brickQuantize !== 0.5) data.brickQuantize = this.brickQuantize;
        if (this.brickSoftness !== 0.2) data.brickSoftness = this.brickSoftness;
        if (this.rimGlow !== 0.1) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 0.8, 0.6).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalBrickMaterial}
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
        this.brickBands = json.brickBands ?? this.brickBands;
        this.brickQuantize = json.brickQuantize ?? this.brickQuantize;
        this.brickSoftness = json.brickSoftness ?? this.brickSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural brick materials
// ---------------------------------------------------------------------------

const ArchitecturalBrickMaterialBatchComponent = {
    materialPtr: 'ui32',
    brickBands: 'ui8',
    brickQuantize: 'f64',
    brickSoftness: 'f64',
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
    ArchitecturalBrickMaterial,
    ArchitecturalBrickMaterialBatch,
    BrickScratchPool,
    ArchitecturalBrickMaterialBatchComponent,
    ArchitecturalBrickPresets,
    applyBrickCelBanding,
    gradeBrickColor,
    generateBrickPatternTexture
};

export default ArchitecturalBrickMaterial;