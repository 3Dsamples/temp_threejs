// file number : 246
// full path name : src/materials/246_metalgalvanizedbeammaterial.js
// description : MetalGalvanizedBeamMaterial — a ready-to-use hot-dip
//               galvanized structural-steel beam material for architectural and
//               industrial visualization. Extends MetalSteelBeamMaterial with
//               galvanized-specific presets covering the classic hot-dip zinc
//               finishes: large-spangle galvanized, small-spangle galvanized,
//               freshly galvanized (bright zinc), partially weathered
//               galvanized, and heavily weathered galvanized (white rust /
//               zinc-oxide patches). Includes galvanized-appropriate PBR
//               defaults matching published galvanized-steel references:
//               metalness 0.90–1.0 for the zinc coating, roughness 0.35–0.55
//               for the crystalline spangle surface, spangle-cell density
//               12–48 (large vs small spangle), bright silvery base colour
//               (linear 0.72–0.82 near-neutral), and white-rust (zinc oxide)
//               patches for the weathered presets. Adds real-time anime
//               stylization: cel-banded galvanized highlights, zinc-crystal
//               spangle approximation, white-rust patch approximation,
//               directional spangle-flow, metallic edge specular, mood
//               tinting, rim glow, and per-instance variation. Includes a
//               procedural galvanized-spangle texture generator using
//               jittered Voronoi cells for the zinc crystal facets, per-cell
//               brightness hashing, and optional white-rust patches.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Hot-dip galvanized steel beams, galvanized I-beams, H-beams,
//            columns, girders, trusses, industrial steelwork, exterior
//            structural steel, galvanized handrails, and any galvanized
//            steel surface that needs real-time PBR + anime stylization.
// license : MIT

import { MetalSteelBeamMaterial } from './245_metalsteelbeammaterial.js';
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
// Galvanized-beam presets — physically grounded PBR parameter sets for
// hot-dip galvanized steel finishes.
//
// Reference values (from 3DTexel Galvanized Steel PBR measurements, The
// Ultimate Guide to Creating Photorealistic Steel, NormalMap.ai galvanized
// guide, and industrial galvanization literature):
//   - Zinc coating metalness:        0.90–1.0 (zinc is a metal)
//   - Galvanized roughness:          0.35–0.55 (spangle crystal facets)
//   - Fresh galvanized base colour:  bright silvery, linear 0.72–0.82
//                                    near-neutral with cool cast
//   - Spangle cells (large):         12–20 per unit UV (big crystals)
//   - Spangle cells (small):         32–48 per unit UV (fine crystals)
//   - Weathered galvanized:          grey-white zinc oxide (white rust),
//                                    roughness 0.60–0.80, metalness 0.70–0.85
//   - White-rust patches:            light-grey dielectric blotches
//   - Anisotropy:                    low (0.10–0.25) — spangle is isotropic
// ---------------------------------------------------------------------------

const MetalGalvanizedBeamPresets = {
    'large-spangle': {
        color: [0.74, 0.76, 0.78],
        roughness: 0.42,
        metalness: 0.95,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        ior: 2.50,
        specularIntensity: 1.0,
        specularColor: [0.86, 0.88, 0.92],
        anisotropy: 0.15,
        anisotropyRotation: 0.0,
        spangleCells: 16.0,
        spangleStrength: 0.60,
        whiteRustStrength: 0.0,
        whiteRustDensity: 0.0
    },
    'small-spangle': {
        color: [0.78, 0.80, 0.82],
        roughness: 0.40,
        metalness: 0.95,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        ior: 2.50,
        specularIntensity: 1.0,
        specularColor: [0.88, 0.90, 0.94],
        anisotropy: 0.12,
        anisotropyRotation: 0.0,
        spangleCells: 42.0,
        spangleStrength: 0.42,
        whiteRustStrength: 0.0,
        whiteRustDensity: 0.0
    },
    'fresh-galvanized': {
        color: [0.82, 0.83, 0.86],
        roughness: 0.36,
        metalness: 0.98,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        ior: 2.50,
        specularIntensity: 1.0,
        specularColor: [0.92, 0.94, 0.98],
        anisotropy: 0.10,
        anisotropyRotation: 0.0,
        spangleCells: 36.0,
        spangleStrength: 0.50,
        whiteRustStrength: 0.0,
        whiteRustDensity: 0.0
    },
    'partially-weathered': {
        color: [0.70, 0.72, 0.74],
        roughness: 0.52,
        metalness: 0.85,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        ior: 2.50,
        specularIntensity: 0.85,
        specularColor: [0.80, 0.82, 0.86],
        anisotropy: 0.10,
        anisotropyRotation: 0.0,
        spangleCells: 32.0,
        spangleStrength: 0.30,
        whiteRustStrength: 0.30,
        whiteRustDensity: 0.20
    },
    'heavily-weathered': {
        color: [0.62, 0.63, 0.65],
        roughness: 0.68,
        metalness: 0.70,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        ior: 2.50,
        specularIntensity: 0.70,
        specularColor: [0.72, 0.74, 0.78],
        anisotropy: 0.08,
        anisotropyRotation: 0.0,
        spangleCells: 28.0,
        spangleStrength: 0.18,
        whiteRustStrength: 0.60,
        whiteRustDensity: 0.45
    },
    'anime-galvanized': {
        color: [0.80, 0.82, 0.86],
        roughness: 0.34,
        metalness: 0.96,
        clearcoat: 0.05,
        clearcoatRoughness: 0.25,
        ior: 2.50,
        specularIntensity: 1.0,
        specularColor: [0.95, 0.96, 1.0],
        anisotropy: 0.12,
        anisotropyRotation: 0.0,
        spangleCells: 40.0,
        spangleStrength: 0.55,
        whiteRustStrength: 0.0,
        whiteRustDensity: 0.0
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable galvanized-beam scratch records
// ---------------------------------------------------------------------------

class MetalGalvanizedBeamScratchPool {
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

/** @type {MetalGalvanizedBeamScratchPool} */
const _metalGalvanizedBeamScratchPool = new MetalGalvanizedBeamScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — galvanized-beam-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded galvanized highlights. Galvanized zinc is a bright metal
 * with crystalline facets — quantizing the luminance into discrete bands
 * produces the crisp flat anime galvanized look seen in hand-drawn industrial
 * and architectural scenes.
 * @param {Color} baseColor
 * @param {Color} output - Modified in place.
 * @param {number} bands
 * @param {number} quantizeAmount
 * @param {number} [softness=0.06]
 * @returns {Color}
 */
function applyGalvanizedCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.06) {
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
 * Apply mood-based tinting to galvanized steel. Warm moods push the zinc
 * toward a warm amber heat tint; cool moods toward cool bluish zinc —
 * matching the atmospheric galvanized tinting seen in stylized industrial
 * scenes.
 * @param {Color} color - Modified in place.
 * @param {number} temperature
 * @param {number} saturation
 * @param {number} brightness
 * @param {number} contrast
 * @returns {Color}
 */
function gradeGalvanizedColor(color, temperature, saturation, brightness, contrast) {
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

    // Galvanized-specific temperature bias: warm shift pushes toward amber
    // heat tint; cool shift pushes toward bluish zinc.
    r += temperature * 0.028;
    g += temperature * 0.012;
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
 * Generate a procedural galvanized-spangle texture. The algorithm:
 * 1. Jittered Voronoi cells: place jittered seed points in a grid, compute
 *    F1 (nearest) distance — this produces the polygonal zinc crystal facets
 *    of the hot-dip galvanized spangle.
 * 2. Per-cell brightness hashing: each crystal facet gets a slight brightness
 *    offset, producing the spangle sheen.
 * 3. Optional white-rust patches: low-frequency hashed blotch mask producing
 *    the zinc-oxide (white rust) patches seen on partially weathered
 *    galvanized steel.
 * 4. Fine micro-grain: high-frequency mottle for the surface finishing
 *    texture.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 * @param {number} width
 * @param {number} height
 * @param {number} [spangleCells=36]
 * @param {number} [spangleStrength=0.50]
 * @param {number} [whiteRustStrength=0.0]
 * @param {number} [whiteRustDensity=0.0]
 * @param {number} [microGrain=0.04]
 * @returns {Uint8Array}
 */
function generateGalvanizedSpangleTexture(width, height, spangleCells = 36, spangleStrength = 0.50, whiteRustStrength = 0.0, whiteRustDensity = 0.0, microGrain = 0.04) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Jittered Voronoi spangle cells ---
            const vx = (x / width) * spangleCells;
            const vy = (y / height) * spangleCells;
            const cellX = Math.floor(vx);
            const cellY = Math.floor(vy);

            let f1 = 1e9;
            let f1Id = 0;

            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    const nx = cellX + ox;
                    const ny = cellY + oy;
                    const h1 = Math.sin(nx * 127.1 + ny * 311.7) * 43758.5453;
                    const h2 = Math.sin(nx * 269.5 + ny * 183.3) * 43758.5453;
                    const jx = h1 - Math.floor(h1);
                    const jy = h2 - Math.floor(h2);
                    const dx = vx - (nx + jx);
                    const dy = vy - (ny + jy);
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < f1) {
                        f1 = d;
                        f1Id = nx * 73856093 ^ ny * 19349663;
                    }
                }
            }

            // --- 2. Per-cell brightness hashing ---
            const cellHash = Math.abs(Math.sin(f1Id * 12.9898) * 43758.5453) % 1.0;
            const spangle = (cellHash - 0.5) * spangleStrength;

            // --- 3. Optional white-rust patches ---
            let whiteRust = 0;
            if (whiteRustStrength > 0 && whiteRustDensity > 0) {
                const rustCellX = Math.floor(x * 0.04);
                const rustCellY = Math.floor(y * 0.04);
                const rustCellId = rustCellX * 73856093 ^ rustCellY * 19349663;
                const rustHash = Math.abs(Math.sin(rustCellId * 12.9898 + 3.14) * 43758.5453) % 1.0;
                if (rustHash > (1.0 - whiteRustDensity)) {
                    const rh2 = Math.abs(Math.sin(rustCellId * 78.233) * 43758.5453) % 1.0;
                    whiteRust = rh2 * whiteRustStrength;
                }
            }

            // --- 4. Fine micro-grain ---
            const grain = SimplexNoise.noise2D(x * 0.7, y * 0.7) * microGrain;

            // --- Combine ---
            let value = 0.62 + spangle * 0.35 + whiteRust * 0.25 + grain;
            value = Math.max(0, Math.min(1, value));

            const v8 = Math.floor(value * 255);
            out[p] = v8;
            out[p + 1] = v8;
            out[p + 2] = v8;
            // Alpha channel stores the white-rust mask (0..1) for shader use
            const rustMask8 = Math.floor(Math.max(0, Math.min(1, whiteRust)) * 255);
            out[p + 3] = rustMask8;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator
// ---------------------------------------------------------------------------

const _metalGalvanizedBeamWorld = BitECS.createWorld();
const MetalGalvanizedBeamMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    galvanizedBands: 'ui8',
    galvanizedQuantize: 'f64',
    galvanizedSoftness: 'f64',
    spangleCells: 'f64',
    spangleStrength: 'f64',
    spangleFlow: 'f64',
    whiteRustStrength: 'f64',
    whiteRustDensity: 'f64',
    edgeSpecularIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class MetalGalvanizedBeamMaterialBatch {
    constructor() {
        this.world = _metalGalvanizedBeamWorld;
        /** @type {MetalGalvanizedBeamMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * @param {MetalGalvanizedBeamMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, MetalGalvanizedBeamMaterialComponent, eid);
        MetalGalvanizedBeamMaterialComponent.materialPtr[eid] = this.materials.length;
        MetalGalvanizedBeamMaterialComponent.galvanizedBands[eid] = material.galvanizedBands;
        MetalGalvanizedBeamMaterialComponent.galvanizedQuantize[eid] = material.galvanizedQuantize;
        MetalGalvanizedBeamMaterialComponent.galvanizedSoftness[eid] = material.galvanizedSoftness;
        MetalGalvanizedBeamMaterialComponent.spangleCells[eid] = material.spangleCells;
        MetalGalvanizedBeamMaterialComponent.spangleStrength[eid] = material.spangleStrength;
        MetalGalvanizedBeamMaterialComponent.spangleFlow[eid] = material.spangleFlow;
        MetalGalvanizedBeamMaterialComponent.whiteRustStrength[eid] = material.whiteRustStrength;
        MetalGalvanizedBeamMaterialComponent.whiteRustDensity[eid] = material.whiteRustDensity;
        MetalGalvanizedBeamMaterialComponent.edgeSpecularIntensity[eid] = material.edgeSpecularIntensity;
        MetalGalvanizedBeamMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        MetalGalvanizedBeamMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        MetalGalvanizedBeamMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        MetalGalvanizedBeamMaterialComponent.moodContrast[eid] = material.moodContrast;
        MetalGalvanizedBeamMaterialComponent.rimGlow[eid] = material.rimGlow;
        MetalGalvanizedBeamMaterialComponent.variationSeed[eid] = material.variationSeed;
        MetalGalvanizedBeamMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MetalGalvanizedBeamMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.galvanizedBands = MetalGalvanizedBeamMaterialComponent.galvanizedBands[eid];
            material.galvanizedQuantize = MetalGalvanizedBeamMaterialComponent.galvanizedQuantize[eid];
            material.galvanizedSoftness = MetalGalvanizedBeamMaterialComponent.galvanizedSoftness[eid];
            material.spangleCells = MetalGalvanizedBeamMaterialComponent.spangleCells[eid];
            material.spangleStrength = MetalGalvanizedBeamMaterialComponent.spangleStrength[eid];
            material.spangleFlow = MetalGalvanizedBeamMaterialComponent.spangleFlow[eid];
            material.whiteRustStrength = MetalGalvanizedBeamMaterialComponent.whiteRustStrength[eid];
            material.whiteRustDensity = MetalGalvanizedBeamMaterialComponent.whiteRustDensity[eid];
            material.edgeSpecularIntensity = MetalGalvanizedBeamMaterialComponent.edgeSpecularIntensity[eid];
            material.moodTemperature = MetalGalvanizedBeamMaterialComponent.moodTemperature[eid];
            material.moodSaturation = MetalGalvanizedBeamMaterialComponent.moodSaturation[eid];
            material.moodBrightness = MetalGalvanizedBeamMaterialComponent.moodBrightness[eid];
            material.moodContrast = MetalGalvanizedBeamMaterialComponent.moodContrast[eid];
            material.rimGlow = MetalGalvanizedBeamMaterialComponent.rimGlow[eid];
            material.variationSeed = MetalGalvanizedBeamMaterialComponent.variationSeed[eid];

            MetalGalvanizedBeamMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main MetalGalvanizedBeamMaterial class
// ---------------------------------------------------------------------------

/**
 * A ready-to-use hot-dip galvanized structural-steel beam material for
 * architectural and industrial visualization. Extends MetalSteelBeamMaterial
 * with galvanized-specific PBR defaults and real-time anime stylization.
 *
 * @augments MetalSteelBeamMaterial
 */
class MetalGalvanizedBeamMaterial extends MetalSteelBeamMaterial {
    static {
        _metalGalvanizedBeamScratchPool.warm(32);
    }

    /**
     * @param {Object} [parameters]
     */
    constructor(parameters) {
        super();

        this.isMetalGalvanizedBeamMaterial = true;
        this.type = 'MetalGalvanizedBeamMaterial';

        // -------------------------------------------------------------------
        // Galvanized-specific PBR defaults (small-spangle baseline)
        // -------------------------------------------------------------------
        this.ior = 2.50;
        this.specularIntensity = 1.0;
        this.roughness = 0.40;
        this.metalness = 0.95;
        this.specularColor = new Color(0.88, 0.90, 0.94);
        this.color = new Color(0.78, 0.80, 0.82);   // bright silvery zinc

        // No clearcoat for bare galvanized
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // Low anisotropy for the spangle crystal (isotropic)
        this.anisotropy = 0.12;
        this.anisotropyRotation = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — galvanized-specific
        // -------------------------------------------------------------------
        this.galvanizedBands = 4;
        this.galvanizedQuantize = 0.5;
        this.galvanizedSoftness = 0.06;

        // Spangle crystal controls
        this.spangleCells = 42.0;
        this.spangleStrength = 0.42;
        this.spangleFlow = 0.0;

        // White-rust (zinc-oxide) controls
        this.whiteRustStrength = 0.0;
        this.whiteRustDensity = 0.0;
        this.whiteRustColor = new Color(0.90, 0.92, 0.94);

        // Edge specular — the bright chamfer highlight that reads as metal
        this.edgeSpecularIntensity = 0.40;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.14;
        this.rimGlowColor = new Color(0.88, 0.92, 0.98);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (galvanized leans semi-realistic)
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
    applyGalvanizedBanding(baseColor, output) {
        return applyGalvanizedCelBanding(
            baseColor,
            output,
            this.galvanizedBands,
            this.galvanizedQuantize,
            this.galvanizedSoftness
        );
    }

    /**
     * @returns {MetalGalvanizedBeamMaterial}
     */
    updateMoodColor() {
        gradeGalvanizedColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named galvanized-beam preset.
     * @param {string} presetName - One of the keys of `MetalGalvanizedBeamPresets`.
     * @returns {MetalGalvanizedBeamMaterial}
     */
    applyPreset(presetName) {
        const preset = MetalGalvanizedBeamPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;
        this.ior = preset.ior;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.anisotropy = preset.anisotropy;
        this.anisotropyRotation = preset.anisotropyRotation;
        this.spangleCells = preset.spangleCells;
        this.spangleStrength = preset.spangleStrength;
        this.whiteRustStrength = preset.whiteRustStrength;
        this.whiteRustDensity = preset.whiteRustDensity;

        // Per-preset anime tuning
        if (presetName === 'large-spangle') {
            this.galvanizedSoftness = 0.06;
            this.galvanizedBands = 4;
            this.edgeSpecularIntensity = 0.38;
        } else if (presetName === 'small-spangle' || presetName === 'fresh-galvanized') {
            this.galvanizedSoftness = 0.04;
            this.galvanizedBands = 4;
            this.edgeSpecularIntensity = 0.45;
        } else if (presetName === 'partially-weathered') {
            this.galvanizedSoftness = 0.14;
            this.galvanizedBands = 3;
            this.edgeSpecularIntensity = 0.28;
        } else if (presetName === 'heavily-weathered') {
            this.galvanizedSoftness = 0.22;
            this.galvanizedBands = 2;
            this.edgeSpecularIntensity = 0.18;
        } else if (presetName === 'anime-galvanized') {
            this.galvanizedSoftness = 0.03;
            this.galvanizedBands = 5;
            this.edgeSpecularIntensity = 0.55;
        }

        this.updateMoodColor();
        return this;
    }

    /**
     * @param {number} width
     * @param {number} height
     * @param {number} [spangleCells=36]
     * @param {number} [spangleStrength=0.50]
     * @param {number} [whiteRustStrength=0.0]
     * @param {number} [whiteRustDensity=0.0]
     * @returns {Uint8Array}
     */
    generateGalvanizedSpangleTexture(width, height, spangleCells = 36, spangleStrength = 0.50, whiteRustStrength = 0.0, whiteRustDensity = 0.0) {
        return generateGalvanizedSpangleTexture(width, height, spangleCells, spangleStrength, whiteRustStrength, whiteRustDensity, 0.04);
    }

    /**
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * @returns {Promise<MetalGalvanizedBeamMaterial>}
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
        // Call the base MetalSteelBeamMaterial hook first
        super.onBeforeCompile(shader, renderer);

        // Inject galvanized-specific uniforms (overrides of the base class)
        shader.uniforms.galvanizedBands = { value: this.galvanizedBands };
        shader.uniforms.galvanizedQuantize = { value: this.galvanizedQuantize };
        shader.uniforms.galvanizedSoftness = { value: this.galvanizedSoftness };
        shader.uniforms.spangleCells = { value: this.spangleCells };
        shader.uniforms.spangleStrength = { value: this.spangleStrength };
        shader.uniforms.spangleFlow = { value: this.spangleFlow };
        shader.uniforms.whiteRustStrength = { value: this.whiteRustStrength };
        shader.uniforms.whiteRustDensity = { value: this.whiteRustDensity };
        shader.uniforms.whiteRustColor = { value: this.whiteRustColor };
        shader.uniforms.edgeSpecularIntensity = { value: this.edgeSpecularIntensity };
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
                uniform int galvanizedBands;
                uniform float galvanizedQuantize;
                uniform float galvanizedSoftness;
                uniform float spangleCells;
                uniform float spangleStrength;
                uniform float spangleFlow;
                uniform float whiteRustStrength;
                uniform float whiteRustDensity;
                uniform vec3 whiteRustColor;
                uniform float edgeSpecularIntensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyGalvanizedBands(vec3 baseColor) {
                    if (galvanizedBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(galvanizedBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * galvanizedSoftness;
                    float finalLum = mix(lum, softQuantized, galvanizedQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply galvanized cel banding
                gl_FragColor.rgb = applyGalvanizedBands(gl_FragColor.rgb);

                // Zinc-crystal spangle approximation:
                // hashed Voronoi cell facets with per-cell brightness offset
                if (spangleStrength > 0.0) {
                    vec2 spangleUV = vUv * spangleCells + vec2(spangleFlow * 0.1, 0.0);
                    vec2 spangleCell = floor(spangleUV);
                    vec2 spangleFrac = fract(spangleUV);

                    // Approximate F1 Voronoi in a single cell (cheap version)
                    float spangleHash = fract(sin(dot(spangleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    float spangleBrightness = (spangleHash - 0.5) * spangleStrength;
                    gl_FragColor.rgb += vec3(spangleBrightness * 0.10);

                    // Facet edge highlight
                    vec2 facetEdge = smoothstep(0.0, 0.05, spangleFrac) * smoothstep(1.0, 0.95, spangleFrac);
                    float facetMask = 1.0 - facetEdge.x * facetEdge.y;
                    gl_FragColor.rgb *= (1.0 - facetMask * spangleStrength * 0.05);
                }

                // White-rust (zinc-oxide) patch approximation
                if (whiteRustStrength > 0.0) {
                    vec2 rustUV = vUv * 30.0;
                    vec2 rustCell = floor(rustUV);
                    vec2 rustFrac = fract(rustUV);
                    float rustHash = fract(sin(dot(rustCell, vec2(39.425, 1.57))) * 43758.5453);
                    if (rustHash > (1.0 - whiteRustDensity)) {
                        vec2 rustCentre = vec2(fract(rustHash * 7.31), fract(rustHash * 13.7));
                        float rustDist = length(rustFrac - rustCentre);
                        float rustMask = max(0.0, 1.0 - rustDist * 2.5) * whiteRustStrength;
                        gl_FragColor.rgb = mix(gl_FragColor.rgb, whiteRustColor, rustMask);
                    }
                }

                // Edge specular — the bright chamfer highlight that reads as metal
                if (edgeSpecularIntensity > 0.0) {
                    float ndotvGal = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float edgeSpec = pow(1.0 - ndotvGal, 4.0);
                    gl_FragColor.rgb += specularColor * edgeSpec * edgeSpecularIntensity;
                }

                // Cool-bluish rim glow on galvanized edges
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
            this.galvanizedBands, this.galvanizedQuantize, this.galvanizedSoftness,
            this.spangleCells, this.spangleStrength, this.spangleFlow,
            this.whiteRustStrength, this.whiteRustDensity,
            this.edgeSpecularIntensity,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

    /**
     * @param {MetalGalvanizedBeamMaterial} source
     * @returns {MetalGalvanizedBeamMaterial}
     */
    copy(source) {
        super.copy(source);
        this.galvanizedBands = source.galvanizedBands;
        this.galvanizedQuantize = source.galvanizedQuantize;
        this.galvanizedSoftness = source.galvanizedSoftness;
        this.spangleCells = source.spangleCells;
        this.spangleStrength = source.spangleStrength;
        this.spangleFlow = source.spangleFlow;
        this.whiteRustStrength = source.whiteRustStrength;
        this.whiteRustDensity = source.whiteRustDensity;
        this.whiteRustColor.copy(source.whiteRustColor);
        this.edgeSpecularIntensity = source.edgeSpecularIntensity;
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
        data.type = 'MetalGalvanizedBeamMaterial';

        if (this.galvanizedBands !== 4) data.galvanizedBands = this.galvanizedBands;
        if (this.galvanizedQuantize !== 0.5) data.galvanizedQuantize = this.galvanizedQuantize;
        if (this.galvanizedSoftness !== 0.06) data.galvanizedSoftness = this.galvanizedSoftness;
        if (this.spangleCells !== 42.0) data.spangleCells = this.spangleCells;
        if (this.spangleStrength !== 0.42) data.spangleStrength = this.spangleStrength;
        if (this.spangleFlow !== 0.0) data.spangleFlow = this.spangleFlow;
        if (this.whiteRustStrength !== 0.0) data.whiteRustStrength = this.whiteRustStrength;
        if (this.whiteRustDensity !== 0.0) data.whiteRustDensity = this.whiteRustDensity;
        if (this.whiteRustColor.getHex() !== new Color(0.90, 0.92, 0.94).getHex()) data.whiteRustColor = this.whiteRustColor.getHex();
        if (this.edgeSpecularIntensity !== 0.40) data.edgeSpecularIntensity = this.edgeSpecularIntensity;
        if (this.rimGlow !== 0.14) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.88, 0.92, 0.98).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * @param {Object} json
     * @returns {MetalGalvanizedBeamMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);
        this.galvanizedBands = json.galvanizedBands ?? this.galvanizedBands;
        this.galvanizedQuantize = json.galvanizedQuantize ?? this.galvanizedQuantize;
        this.galvanizedSoftness = json.galvanizedSoftness ?? this.galvanizedSoftness;
        this.spangleCells = json.spangleCells ?? this.spangleCells;
        this.spangleStrength = json.spangleStrength ?? this.spangleStrength;
        this.spangleFlow = json.spangleFlow ?? this.spangleFlow;
        this.whiteRustStrength = json.whiteRustStrength ?? this.whiteRustStrength;
        this.whiteRustDensity = json.whiteRustDensity ?? this.whiteRustDensity;
        if (json.whiteRustColor !== undefined) this.whiteRustColor.setHex(json.whiteRustColor);
        this.edgeSpecularIntensity = json.edgeSpecularIntensity ?? this.edgeSpecularIntensity;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const MetalGalvanizedBeamMaterialBatchComponent = {
    materialPtr: 'ui32',
    galvanizedBands: 'ui8',
    galvanizedQuantize: 'f64',
    galvanizedSoftness: 'f64',
    spangleCells: 'f64',
    spangleStrength: 'f64',
    spangleFlow: 'f64',
    whiteRustStrength: 'f64',
    whiteRustDensity: 'f64',
    edgeSpecularIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    MetalGalvanizedBeamMaterial,
    MetalGalvanizedBeamMaterialBatch,
    MetalGalvanizedBeamScratchPool,
    MetalGalvanizedBeamMaterialBatchComponent,
    MetalGalvanizedBeamPresets,
    applyGalvanizedCelBanding,
    gradeGalvanizedColor,
    generateGalvanizedSpangleTexture
};

export default MetalGalvanizedBeamMaterial;