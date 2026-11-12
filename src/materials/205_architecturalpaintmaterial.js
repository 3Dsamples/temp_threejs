// file number : 205
// full path name : src/materials/205_architecturalpaintmaterial.js
// description : ArchitecturalPaintMaterial — a ready-to-use paint material
//               for architectural visualization. Extends MeshPhysicalMaterial
//               with purpose-built presets for matte emulsion, satin, semi-
//               gloss, high-gloss, lacquer, and enamel paints. Includes a
//               procedural roller-stipple texture generator (directional fBm
//               with multi-scale noise), real-time anime stylization (cel-
//               banded paint highlights, mood tinting, rim glow, paper-grain
//               texture, watercolor bleed, and per-instance variation), and
//               full PBR ↔ Anime blend control. All imports resolve to the
//               internal Threejs_gl repository tree; no CDN dependencies.
// best for : Architectural paint finishes — interior walls, ceilings, trim,
//            doors, cabinetry, exterior render, feature walls, and any painted
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
// Paint presets — curated PBR parameter sets for common architectural finishes
// ---------------------------------------------------------------------------

/**
 * Roughness reference ranges (from PBR paint guides):
 *   - Lacquer / high-gloss: 0.04–0.08
 *   - Semi-gloss / satin:   0.15–0.35
 *   - Eggshell / matte:     0.55–0.75
 *   - Flat / matte emulsion: 0.8–0.95
 * Clearcoat is used for lacquer and high-gloss finishes to add a secondary
 * reflective top layer.
 */
const ArchitecturalPaintPresets = {
    'matte-emulsion': {
        color: [0.92, 0.92, 0.92],
        roughness: 0.88,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        sheen: 0.0,
        sheenColor: [0.0, 0.0, 0.0],
        sheenRoughness: 0.5,
        specularIntensity: 0.15,
        specularColor: [0.85, 0.85, 0.85]
    },
    'eggshell': {
        color: [0.90, 0.90, 0.90],
        roughness: 0.68,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        sheen: 0.05,
        sheenColor: [0.9, 0.9, 0.9],
        sheenRoughness: 0.6,
        specularIntensity: 0.22,
        specularColor: [0.88, 0.88, 0.88]
    },
    'satin': {
        color: [0.88, 0.88, 0.88],
        roughness: 0.35,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        sheen: 0.1,
        sheenColor: [0.92, 0.92, 0.92],
        sheenRoughness: 0.5,
        specularIntensity: 0.35,
        specularColor: [0.92, 0.92, 0.92]
    },
    'semi-gloss': {
        color: [0.86, 0.86, 0.86],
        roughness: 0.22,
        metalness: 0.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.1,
        sheen: 0.0,
        sheenColor: [0.0, 0.0, 0.0],
        sheenRoughness: 0.5,
        specularIntensity: 0.5,
        specularColor: [0.95, 0.95, 0.95]
    },
    'high-gloss': {
        color: [0.84, 0.84, 0.84],
        roughness: 0.10,
        metalness: 0.0,
        clearcoat: 0.5,
        clearcoatRoughness: 0.05,
        sheen: 0.0,
        sheenColor: [0.0, 0.0, 0.0],
        sheenRoughness: 0.5,
        specularIntensity: 0.65,
        specularColor: [0.98, 0.98, 0.98]
    },
    'lacquer': {
        color: [0.80, 0.80, 0.80],
        roughness: 0.06,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.02,
        sheen: 0.0,
        sheenColor: [0.0, 0.0, 0.0],
        sheenRoughness: 0.5,
        specularIntensity: 0.75,
        specularColor: [1.0, 1.0, 1.0]
    },
    'enamel': {
        color: [0.82, 0.82, 0.82],
        roughness: 0.15,
        metalness: 0.0,
        clearcoat: 0.3,
        clearcoatRoughness: 0.08,
        sheen: 0.0,
        sheenColor: [0.0, 0.0, 0.0],
        sheenRoughness: 0.5,
        specularIntensity: 0.55,
        specularColor: [0.96, 0.96, 0.96]
    },
    'textured-masonry-paint': {
        color: [0.88, 0.86, 0.82],
        roughness: 0.82,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        sheen: 0.08,
        sheenColor: [0.9, 0.88, 0.85],
        sheenRoughness: 0.7,
        specularIntensity: 0.18,
        specularColor: [0.85, 0.83, 0.80]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable paint scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for paint-material scratch records. Prevents per-frame
 * allocation of temporary cel-banding, mood-tinting, and rim-glow scratch
 * objects.
 */
class PaintScratchPool {
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

/** @type {PaintScratchPool} Shared scratch pool for all paint material instances. */
const _paintScratchPool = new PaintScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — paint-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded paint highlights to a painted surface. Glossy paints have
 * crisp specular edges, matte paints have softer edges — both produced by the
 * configurable softness parameter.
 * @param {Color} baseColor - The paint base colour.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of paint bands (2–5 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [softness=0.1] - Edge softness in [0, 0.5].
 * @returns {Color}
 */
function applyPaintCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.1) {
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
 * Apply mood-based tinting to paint. Warm moods tint paint toward warm cream/
 * ivory, cool moods toward cool grey-blue — matching the atmospheric paint
 * tinting seen in architectural anime backgrounds.
 * @param {Color} color - The paint colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradePaintColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate a procedural roller-stipple texture. Real paint rollers leave a
 * subtle orange-peel / stipple pattern — this is simulated with a multi-octave
 * fBm noise field modulated by directional roller streaks. A second high-
 * frequency noise layer provides the fine "peel" grain. The output is a
 * grayscale height/bump map suitable for a bumpMap or normal map derivative.
 * @param {number} width - Texture width in pixels.
 * @param {number} height - Texture height in pixels.
 * @param {number} [scale=0.04] - Base noise scale (higher = finer stipple).
 * @param {number} [octaves=4] - Number of noise octaves.
 * @param {number} [stippleStrength=0.25] - Stipple bump intensity.
 * @param {number} [rollerDirection=0.0] - Roller direction in radians (0 = horizontal).
 * @param {number} [rollerStreakStrength=0.15] - Directional streak intensity.
 * @returns {Uint8Array} Grayscale RGBA buffer (bump/height map).
 */
function generateRollerStippleTexture(width, height, scale = 0.04, octaves = 4, stippleStrength = 0.25, rollerDirection = 0.0, rollerStreakStrength = 0.15) {
    const out = new Uint8Array(width * height * 4);

    // Pre-compute roller direction cos/sin for rotated streaks
    const cosR = Math.cos(rollerDirection);
    const sinR = Math.sin(rollerDirection);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Multi-octave fBm for the base orange-peel stipple
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

            // Rotated coordinates for roller streaks
            const rx = x * cosR - y * sinR;
            const ry = x * sinR + y * cosR;

            // Directional roller streak: stretched noise along the roller axis
            const streak = SimplexNoise.noise2D(rx * 0.02, ry * 0.25) * 0.5 + 0.5;

            // High-frequency fine peel grain
            const fineGrain = SimplexNoise.noise2D(x * 0.8, y * 0.8) * 0.5 + 0.5;

            // Combine: base stipple + directional streak + fine grain
            let value = 0.5
                + (fbm - 0.5) * stippleStrength
                + (streak - 0.5) * rollerStreakStrength
                + (fineGrain - 0.5) * 0.08;

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
// bitecs SoA batch coordinator for real-time paint material updates
// ---------------------------------------------------------------------------

const _paintWorld = BitECS.createWorld();
const ArchitecturalPaintMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    paintBands: 'ui8',
    paintQuantize: 'f64',
    paintSoftness: 'f64',
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
 * Batch coordinator for architectural paint materials. Registers
 * ArchitecturalPaintMaterial instances and drives their anime parameters in
 * one cache-friendly pass.
 */
class ArchitecturalPaintMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _paintWorld;
        /** @type {ArchitecturalPaintMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register an ArchitecturalPaintMaterial instance for batched real-time
     * updates.
     * @param {ArchitecturalPaintMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalPaintMaterialComponent, eid);
        ArchitecturalPaintMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalPaintMaterialComponent.paintBands[eid] = material.paintBands;
        ArchitecturalPaintMaterialComponent.paintQuantize[eid] = material.paintQuantize;
        ArchitecturalPaintMaterialComponent.paintSoftness[eid] = material.paintSoftness;
        ArchitecturalPaintMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalPaintMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalPaintMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalPaintMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalPaintMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalPaintMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalPaintMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalPaintMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalPaintMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply all queued paint-material updates in one cache-friendly pass.
     */
    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalPaintMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.paintBands = ArchitecturalPaintMaterialComponent.paintBands[eid];
            material.paintQuantize = ArchitecturalPaintMaterialComponent.paintQuantize[eid];
            material.paintSoftness = ArchitecturalPaintMaterialComponent.paintSoftness[eid];
            material.moodTemperature = ArchitecturalPaintMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalPaintMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalPaintMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalPaintMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalPaintMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalPaintMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalPaintMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalPaintMaterialComponent.variationSeed[eid];

            ArchitecturalPaintMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalPaintMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use architectural paint material for architectural visualization.
 * Extends MeshPhysicalMaterial with purpose-built presets for matte emulsion,
 * eggshell, satin, semi-gloss, high-gloss, lacquer, enamel, and textured
 * masonry paint, plus real-time anime stylization.
 *
 * @augments MeshPhysicalMaterial
 */
class ArchitecturalPaintMaterial extends MeshPhysicalMaterial {

    /**
     * Static block — pre-warm the shared scratch pool for paint materials.
     */
    static {
        _paintScratchPool.warm(32);
    }

    /**
     * Construct a new architectural paint material.
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
        this.isArchitecturalPaintMaterial = true;

        this.type = 'ArchitecturalPaintMaterial';

        // -------------------------------------------------------------------
        // Paint-specific PBR defaults (matte emulsion baseline)
        // -------------------------------------------------------------------

        /**
         * Index of refraction for paint binder (≈1.5).
         * @type {number}
         * @default 1.5
         */
        this.ior = 1.5;

        /**
         * Specular intensity for paint. Low for matte, higher for gloss.
         * @type {number}
         * @default 0.15
         */
        this.specularIntensity = 0.15;

        /**
         * Base roughness. Default is matte emulsion.
         * @type {number}
         * @default 0.88
         */
        this.roughness = 0.88;

        /**
         * Metalness. Paint is a dielectric.
         * @type {number}
         * @default 0.0
         */
        this.metalness = 0.0;

        /**
         * Clearcoat intensity. 0 = no clearcoat for matte. Lacquer uses 1.0.
         * @type {number}
         * @default 0.0
         */
        this.clearcoat = 0.0;

        /**
         * Clearcoat roughness. Very low for lacquer.
         * @type {number}
         * @default 0.0
         */
        this.clearcoatRoughness = 0.0;

        /**
         * Specular colour.
         * @type {Color}
         * @default (0.85, 0.85, 0.85)
         */
        this.specularColor = new Color(0.85, 0.85, 0.85);

        /**
         * Base colour of the paint. Default is a neutral off-white.
         * @type {Color}
         * @default (0.92, 0.92, 0.92)
         */
        this.color = new Color(0.92, 0.92, 0.92);

        /**
         * Sheen intensity. Non-zero for textured / eggshell finishes.
         * @type {number}
         * @default 0.0
         */
        this.sheen = 0.0;

        /**
         * Sheen colour.
         * @type {Color}
         * @default (0,0,0)
         */
        this.sheenColor = new Color(0x000000);

        /**
         * Sheen roughness.
         * @type {number}
         * @default 0.5
         */
        this.sheenRoughness = 0.5;

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
        // Anime rendering extensions — paint-specific
        // -------------------------------------------------------------------

        /**
         * Number of paint cel bands. 2–5 = stylized paint highlight steps.
         * @type {number}
         * @default 3
         */
        this.paintBands = 3;

        /**
         * Blend amount between continuous and banded paint highlights.
         * @type {number}
         * @default 0.5
         */
        this.paintQuantize = 0.5;

        /**
         * Paint band edge softness. Glossy = low, matte = high.
         * @type {number}
         * @default 0.1
         */
        this.paintSoftness = 0.1;

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
         * Rim-glow intensity for paint edges.
         * @type {number}
         * @default 0.08
         */
        this.rimGlow = 0.08;

        /**
         * Rim-glow colour. Paint rim is cool-neutral.
         * @type {Color}
         * @default (0.85, 0.88, 0.95)
         */
        this.rimGlowColor = new Color(0.85, 0.88, 0.95);

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
        // PBR ↔ Anime blend (paint leans semi-realistic with anime banding)
        // -------------------------------------------------------------------

        /**
         * Paint materials blend PBR with anime cel-banding stylization.
         * @type {number}
         * @default 0.35
         */
        this.renderStyleBlend = 0.35;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the paint material participates in galactic-scale chunking.
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
     * Apply cel banding to paint highlights.
     * @param {Color} baseColor - The paint base colour.
     * @param {Color} output - The output colour.
     * @returns {Color}
     */
    applyPaintBanding(baseColor, output) {
        return applyPaintCelBanding(
            baseColor,
            output,
            this.paintBands,
            this.paintQuantize,
            this.paintSoftness
        );
    }

    /**
     * Recompute the mood-graded paint colour.
     * @returns {ArchitecturalPaintMaterial} A reference to this instance.
     */
    updateMoodColor() {
        gradePaintColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural paint preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalPaintPresets`.
     * @returns {ArchitecturalPaintMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalPaintPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness for gloss level
        // Lacquer/gloss = crisp bands (0.05), matte = soft bands (0.35)
        if (preset.roughness < 0.15) {
            this.paintSoftness = 0.05;
            this.paintBands = 3;
        } else if (preset.roughness < 0.4) {
            this.paintSoftness = 0.12;
            this.paintBands = 3;
        } else if (preset.roughness < 0.7) {
            this.paintSoftness = 0.22;
            this.paintBands = 2;
        } else {
            this.paintSoftness = 0.35;
            this.paintBands = 2;
        }

        this.updateMoodColor();
        return this;
    }

    /**
     * Generate a procedural roller-stipple texture.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.04]
     * @param {number} [octaves=4]
     * @param {number} [stippleStrength=0.25]
     * @param {number} [rollerDirection=0.0]
     * @returns {Uint8Array}
     */
    generateRollerStippleTexture(width, height, scale = 0.04, octaves = 4, stippleStrength = 0.25, rollerDirection = 0.0) {
        return generateRollerStippleTexture(width, height, scale, octaves, stippleStrength, rollerDirection, 0.15);
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
     * @returns {Promise<ArchitecturalPaintMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base MeshPhysicalMaterial anime shader chunks with paint-specific
     * features: cel-banded highlights and cool-neutral rim glow.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        super.onBeforeCompile(shader, renderer);

        shader.uniforms.paintBands = { value: this.paintBands };
        shader.uniforms.paintQuantize = { value: this.paintQuantize };
        shader.uniforms.paintSoftness = { value: this.paintSoftness };
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

                // Apply paint cel banding
                gl_FragColor.rgb = applyPaintBands(gl_FragColor.rgb);

                // Cool-neutral rim glow on paint edges
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
            this.sheen,
            this.sheenRoughness,
            this.paintBands,
            this.paintQuantize,
            this.paintSoftness,
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
     * @param {ArchitecturalPaintMaterial} source
     * @return {ArchitecturalPaintMaterial}
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
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.paintBands = source.paintBands;
        this.paintQuantize = source.paintQuantize;
        this.paintSoftness = source.paintSoftness;
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

        data.type = 'ArchitecturalPaintMaterial';

        if (this.ior !== 1.5) data.ior = this.ior;
        if (this.specularIntensity !== 0.15) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.88) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.85, 0.85, 0.85).getHex()) {
            data.specularColor = this.specularColor.getHex();
        }
        if (this.sheen !== 0.0) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== 0x000000) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.5) data.sheenRoughness = this.sheenRoughness;
        if (this.paintBands !== 3) data.paintBands = this.paintBands;
        if (this.paintQuantize !== 0.5) data.paintQuantize = this.paintQuantize;
        if (this.paintSoftness !== 0.1) data.paintSoftness = this.paintSoftness;
        if (this.rimGlow !== 0.08) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.88, 0.95).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {ArchitecturalPaintMaterial}
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
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.paintBands = json.paintBands ?? this.paintBands;
        this.paintQuantize = json.paintQuantize ?? this.paintQuantize;
        this.paintSoftness = json.paintSoftness ?? this.paintSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata for architectural paint materials
// ---------------------------------------------------------------------------

const ArchitecturalPaintMaterialBatchComponent = {
    materialPtr: 'ui32',
    paintBands: 'ui8',
    paintQuantize: 'f64',
    paintSoftness: 'f64',
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
    ArchitecturalPaintMaterial,
    ArchitecturalPaintMaterialBatch,
    PaintScratchPool,
    ArchitecturalPaintMaterialBatchComponent,
    ArchitecturalPaintPresets,
    applyPaintCelBanding,
    gradePaintColor,
    generateRollerStippleTexture
};

export default ArchitecturalPaintMaterial;