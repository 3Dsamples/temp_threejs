// file number : 234
// full path name : src/materials/234_organicgelatinmaterial.js
// description : OrganicGelatinMaterial — a ready-to-use gelatin/jelly material
//               for real-time rendering of gelatin desserts, jelly blocks,
//               molded jello, aspic, and other translucent water-based gels.
//               Extends MeshPhysicalMaterial with purpose-built presets for
//               clear gelatin, strawberry jelly, lime jelly, orange jelly,
//               blue-raspberry jelly, and coffee jelly. Includes biologically
//               grounded defaults matching published gelatin PBR references
//               (gelatin IOR ≈ 1.34–1.45 as a water-based gel, very high
//               transmission 0.85–0.98 for the translucent body, low roughness
//               0.10–0.30 for the smooth wet surface, clearcoat for the glossy
//               skin, and attenuation colour + distance for the deeper-colour-
//               where-thicker volumetric look) plus real-time anime
//               stylization: cel-banded gelatin highlights, wobble-free
//               volumetric colour approximation, mood tinting, rim glow, and
//               per-instance variation. Includes a procedural gelatin-bubble
//               texture generator using hashed bubble cells with per-bubble
//               radial falloff and optional surface-mottle.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Gelatin desserts, jelly blocks, molded jello, aspic, fruit jelly,
//            coffee jelly, anime food scenes, candy close-ups, translucent
//            gummy bodies, and any water-based gel surface that needs real-time
//            PBR + anime stylization.
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
// Gelatin presets — biologically grounded PBR parameter sets for gelatin
// types.
//
// Reference values (from IOR/rendering parameter tables, three.js jelly
// references, and food-science literature):
//   - Gelatin is water-based (≈85–90% water):
//       * Optical-grade jelly IOR:      1.340–1.380
//       * Rough gelatin IOR:            1.500–1.530 (higher solids)
//       * Common food gelatin IOR:      1.34–1.45
//   - Roughness:                        0.10–0.30 (smooth, wet surface)
//   - Transmission:                     0.85–0.98 (very translucent body)
//   - Clearcoat:                        0.3–1.0 (glossy wet skin)
//   - Attenuation distance:             0.05–0.5 (deeper colour where thicker)
//   - Attenuation colour:               tinted by the jelly flavour
//   - Sheen:                            subtle 0.05–0.15 (soft candy edge)
// ---------------------------------------------------------------------------

const OrganicGelatinPresets = {
    'clear-gelatin': {
        color: [0.96, 0.97, 0.96],
        roughness: 0.10,
        metalness: 0.0,
        clearcoat: 0.85,
        clearcoatRoughness: 0.05,
        transmission: 0.96,
        thickness: 0.10,
        attenuationDistance: 0.40,
        attenuationColor: [0.96, 0.98, 0.96],
        sheen: 0.05,
        sheenColor: [0.98, 0.99, 0.98],
        sheenRoughness: 0.30,
        specularIntensity: 0.50,
        specularColor: [0.98, 0.99, 0.98]
    },
    'strawberry-jelly': {
        color: [0.88, 0.28, 0.34],
        roughness: 0.14,
        metalness: 0.0,
        clearcoat: 0.80,
        clearcoatRoughness: 0.06,
        transmission: 0.92,
        thickness: 0.10,
        attenuationDistance: 0.08,
        attenuationColor: [0.90, 0.22, 0.28],
        sheen: 0.08,
        sheenColor: [0.95, 0.45, 0.45],
        sheenRoughness: 0.35,
        specularIntensity: 0.55,
        specularColor: [0.98, 0.82, 0.80]
    },
    'lime-jelly': {
        color: [0.48, 0.82, 0.28],
        roughness: 0.14,
        metalness: 0.0,
        clearcoat: 0.80,
        clearcoatRoughness: 0.06,
        transmission: 0.92,
        thickness: 0.10,
        attenuationDistance: 0.09,
        attenuationColor: [0.42, 0.82, 0.24],
        sheen: 0.08,
        sheenColor: [0.65, 0.92, 0.50],
        sheenRoughness: 0.35,
        specularIntensity: 0.55,
        specularColor: [0.82, 0.96, 0.78]
    },
    'orange-jelly': {
        color: [0.96, 0.60, 0.18],
        roughness: 0.14,
        metalness: 0.0,
        clearcoat: 0.80,
        clearcoatRoughness: 0.06,
        transmission: 0.91,
        thickness: 0.10,
        attenuationDistance: 0.08,
        attenuationColor: [0.96, 0.55, 0.14],
        sheen: 0.08,
        sheenColor: [1.0, 0.72, 0.38],
        sheenRoughness: 0.35,
        specularIntensity: 0.55,
        specularColor: [1.0, 0.88, 0.68]
    },
    'blue-raspberry-jelly': {
        color: [0.28, 0.42, 0.92],
        roughness: 0.14,
        metalness: 0.0,
        clearcoat: 0.80,
        clearcoatRoughness: 0.06,
        transmission: 0.90,
        thickness: 0.10,
        attenuationDistance: 0.09,
        attenuationColor: [0.22, 0.38, 0.90],
        sheen: 0.08,
        sheenColor: [0.52, 0.62, 1.0],
        sheenRoughness: 0.35,
        specularIntensity: 0.55,
        specularColor: [0.82, 0.88, 1.0]
    },
    'coffee-jelly': {
        color: [0.42, 0.24, 0.14],
        roughness: 0.16,
        metalness: 0.0,
        clearcoat: 0.75,
        clearcoatRoughness: 0.08,
        transmission: 0.82,
        thickness: 0.12,
        attenuationDistance: 0.06,
        attenuationColor: [0.42, 0.22, 0.12],
        sheen: 0.06,
        sheenColor: [0.62, 0.42, 0.28],
        sheenRoughness: 0.40,
        specularIntensity: 0.52,
        specularColor: [0.85, 0.72, 0.60]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable gelatin scratch records
// ---------------------------------------------------------------------------

class GelatinScratchPool {
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

const _gelatinScratchPool = new GelatinScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — gelatin-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded gelatin highlights. Gelatin has very crisp, smooth
 * specular highlights with a wet glossy sheen — quantizing the luminance into
 * discrete bands produces the flat anime gelatin shine seen in hand-drawn food
 * illustrations.
 */
function applyGelatinCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.05) {
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
 * Apply mood-based tinting to gelatin. Warm moods push gelatin toward warm
 * amber/honey, cool moods toward cool mint/cyan — matching the atmospheric
 * candy tinting seen in stylized food anime scenes.
 */
function gradeGelatinColor(color, temperature, saturation, brightness, contrast) {
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

    // Gelatin-specific temperature bias: warm shift pushes toward amber/honey
    // (R and G up, B down); cool shift pushes toward mint/cyan.
    r += temperature * 0.03;
    g += temperature * 0.02;
    b -= temperature * 0.03;

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
 * Generate a procedural gelatin-bubble texture. The algorithm:
 * 1. Hashed bubble cells: per-cell presence, jittered centre, radius-varied
 *    radial falloff — producing the trapped-air-bubble look.
 * 2. Per-bubble highlight: bright inner ring for the bubble specular.
 * 3. Fine surface mottle: low-frequency fBm for the gelatin surface texture.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateGelatinBubbleTexture(width, height, bubbleDensity = 0.08, bubbleSize = 0.4, mottleStrength = 0.06) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Hashed bubble cells ---
            const cellX = Math.floor(x * 0.08);
            const cellY = Math.floor(y * 0.08);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const cellHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;

            let bubble = 0;
            if (cellHash > (1.0 - bubbleDensity)) {
                const h2 = Math.abs(Math.sin(cellId * 78.233 + 3.14) * 43758.5453) % 1.0;
                const h3 = Math.abs(Math.sin(cellId * 39.425 + 1.57) * 43758.5453) % 1.0;
                const cx = (x * 0.08) - cellX - h2;
                const cy = (y * 0.08) - cellY - h3;
                const dist = Math.sqrt(cx * cx + cy * cy);
                // Bright inner ring for bubble highlight
                bubble = Math.max(0, 1.0 - dist / bubbleSize) * 0.35;
            }

            // --- 3. Fine surface mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.05, y * 0.05) * mottleStrength;

            // --- Combine ---
            let value = 0.55 + bubble + mottle;
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

const _gelatinWorld = BitECS.createWorld();
const OrganicGelatinMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    gelatinBands: 'ui8',
    gelatinQuantize: 'f64',
    gelatinSoftness: 'f64',
    bubbleDensity: 'f64',
    bubbleSize: 'f64',
    mottleStrength: 'f64',
    causticIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicGelatinMaterialBatch {
    constructor() {
        this.world = _gelatinWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicGelatinMaterialComponent, eid);
        OrganicGelatinMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicGelatinMaterialComponent.gelatinBands[eid] = material.gelatinBands;
        OrganicGelatinMaterialComponent.gelatinQuantize[eid] = material.gelatinQuantize;
        OrganicGelatinMaterialComponent.gelatinSoftness[eid] = material.gelatinSoftness;
        OrganicGelatinMaterialComponent.bubbleDensity[eid] = material.bubbleDensity;
        OrganicGelatinMaterialComponent.bubbleSize[eid] = material.bubbleSize;
        OrganicGelatinMaterialComponent.mottleStrength[eid] = material.mottleStrength;
        OrganicGelatinMaterialComponent.causticIntensity[eid] = material.causticIntensity;
        OrganicGelatinMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicGelatinMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicGelatinMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicGelatinMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicGelatinMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicGelatinMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicGelatinMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicGelatinMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.gelatinBands = OrganicGelatinMaterialComponent.gelatinBands[eid];
            material.gelatinQuantize = OrganicGelatinMaterialComponent.gelatinQuantize[eid];
            material.gelatinSoftness = OrganicGelatinMaterialComponent.gelatinSoftness[eid];
            material.bubbleDensity = OrganicGelatinMaterialComponent.bubbleDensity[eid];
            material.bubbleSize = OrganicGelatinMaterialComponent.bubbleSize[eid];
            material.mottleStrength = OrganicGelatinMaterialComponent.mottleStrength[eid];
            material.causticIntensity = OrganicGelatinMaterialComponent.causticIntensity[eid];
            material.moodTemperature = OrganicGelatinMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicGelatinMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicGelatinMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicGelatinMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicGelatinMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicGelatinMaterialComponent.variationSeed[eid];

            OrganicGelatinMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicGelatinMaterial class
// ---------------------------------------------------------------------------

class OrganicGelatinMaterial extends MeshPhysicalMaterial {
    static {
        _gelatinScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicGelatinMaterial = true;
        this.type = 'OrganicGelatinMaterial';

        // -------------------------------------------------------------------
        // Gelatin-specific PBR defaults (clear-gelatin baseline)
        // -------------------------------------------------------------------
        this.ior = 1.40;
        this.specularIntensity = 0.50;
        this.roughness = 0.10;
        this.metalness = 0.0;
        this.specularColor = new Color(0.98, 0.99, 0.98);
        this.color = new Color(0.96, 0.97, 0.96);

        // Very high transmission for the translucent gelatin body
        this.transmission = 0.96;
        this.thickness = 0.10;
        this.attenuationDistance = 0.40;
        this.attenuationColor = new Color(0.96, 0.98, 0.96);

        // Clearcoat for the glossy wet skin
        this.clearcoat = 0.85;
        this.clearcoatRoughness = 0.05;

        // Sheen for the soft candy edge
        this.sheen = 0.05;
        this.sheenColor = new Color(0.98, 0.99, 0.98);
        this.sheenRoughness = 0.30;

        // -------------------------------------------------------------------
        // Anime rendering extensions — gelatin-specific
        // -------------------------------------------------------------------
        this.gelatinBands = 4;
        this.gelatinQuantize = 0.5;
        this.gelatinSoftness = 0.05;

        // Bubble / mottle / caustic controls
        this.bubbleDensity = 0.08;
        this.bubbleSize = 0.4;
        this.mottleStrength = 0.06;
        this.causticIntensity = 0.35;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.10;
        this.rimGlowColor = new Color(0.98, 0.99, 0.98);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (gelatin leans semi-realistic)
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

    applyGelatinBanding(baseColor, output) {
        return applyGelatinCelBanding(
            baseColor,
            output,
            this.gelatinBands,
            this.gelatinQuantize,
            this.gelatinSoftness
        );
    }

    updateMoodColor() {
        gradeGelatinColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named gelatin preset to this material.
     * @param {string} presetName - One of the keys of `OrganicGelatinPresets`.
     * @returns {OrganicGelatinMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicGelatinPresets[presetName];
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
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Per-preset anime tuning
        if (presetName === 'clear-gelatin') {
            this.gelatinSoftness = 0.03;
            this.gelatinBands = 4;
            this.bubbleDensity = 0.06;
            this.causticIntensity = 0.40;
        } else if (presetName === 'coffee-jelly') {
            this.gelatinSoftness = 0.08;
            this.gelatinBands = 3;
            this.bubbleDensity = 0.10;
            this.causticIntensity = 0.25;
        } else {
            this.gelatinSoftness = 0.05;
            this.gelatinBands = 4;
            this.bubbleDensity = 0.08;
            this.causticIntensity = 0.35;
        }

        this.updateMoodColor();
        return this;
    }

    generateGelatinBubbleTexture(width, height, bubbleDensity = 0.08, bubbleSize = 0.4, mottleStrength = 0.06) {
        return generateGelatinBubbleTexture(width, height, bubbleDensity, bubbleSize, mottleStrength);
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

        shader.uniforms.gelatinBands = { value: this.gelatinBands };
        shader.uniforms.gelatinQuantize = { value: this.gelatinQuantize };
        shader.uniforms.gelatinSoftness = { value: this.gelatinSoftness };
        shader.uniforms.bubbleDensity = { value: this.bubbleDensity };
        shader.uniforms.bubbleSize = { value: this.bubbleSize };
        shader.uniforms.mottleStrength = { value: this.mottleStrength };
        shader.uniforms.causticIntensity = { value: this.causticIntensity };
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
                uniform int gelatinBands;
                uniform float gelatinQuantize;
                uniform float gelatinSoftness;
                uniform float bubbleDensity;
                uniform float bubbleSize;
                uniform float mottleStrength;
                uniform float causticIntensity;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyGelatinBands(vec3 baseColor) {
                    if (gelatinBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(gelatinBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * gelatinSoftness;
                    float finalLum = mix(lum, softQuantized, gelatinQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply gelatin cel banding
                gl_FragColor.rgb = applyGelatinBands(gl_FragColor.rgb);

                // Bubble approximation: hashed cell brightening
                if (bubbleDensity > 0.0) {
                    vec2 bubbleUV = vUv * 20.0;
                    vec2 bubbleCell = floor(bubbleUV);
                    vec2 bubbleFrac = fract(bubbleUV);
                    float bubbleHash = fract(sin(dot(bubbleCell, vec2(12.9898, 78.233))) * 43758.5453);
                    if (bubbleHash > (1.0 - bubbleDensity)) {
                        vec2 bubbleCentre = vec2(fract(bubbleHash * 7.31), fract(bubbleHash * 13.7));
                        float bubbleDist = length(bubbleFrac - bubbleCentre);
                        float bubbleMask = max(0.0, 1.0 - bubbleDist / bubbleSize);
                        gl_FragColor.rgb += vec3(bubbleMask * 0.15);
                    }
                }

                // Surface mottle: low-frequency subtle variation
                if (mottleStrength > 0.0) {
                    float mottle = sin(vUv.x * 15.0 + variationOffset) * cos(vUv.y * 15.0 + variationOffset);
                    gl_FragColor.rgb *= (1.0 + mottle * mottleStrength * 0.10);
                }

                // Caustic glint: bright grazing-angle specular streaks
                if (causticIntensity > 0.0) {
                    float ndotvGel = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float glint = pow(1.0 - ndotvGel, 4.0) * causticIntensity;
                    gl_FragColor.rgb += sheenColor * glint * 0.5;
                }

                // Warm rim glow on gelatin edges
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
            this.ior, this.specularIntensity, this.roughness, this.metalness,
            this.clearcoat, this.clearcoatRoughness,
            this.transmission, this.thickness, this.attenuationDistance,
            this.sheen, this.sheenRoughness,
            this.gelatinBands, this.gelatinQuantize, this.gelatinSoftness,
            this.bubbleDensity, this.bubbleSize, this.mottleStrength,
            this.causticIntensity,
            this.moodTemperature, this.moodSaturation, this.moodBrightness, this.moodContrast,
            this.rimGlow, this.variationSeed
        ].join('|');
    }

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
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.gelatinBands = source.gelatinBands;
        this.gelatinQuantize = source.gelatinQuantize;
        this.gelatinSoftness = source.gelatinSoftness;
        this.bubbleDensity = source.bubbleDensity;
        this.bubbleSize = source.bubbleSize;
        this.mottleStrength = source.mottleStrength;
        this.causticIntensity = source.causticIntensity;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicGelatinMaterial';
        if (this.ior !== 1.40) data.ior = this.ior;
        if (this.specularIntensity !== 0.50) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.10) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.85) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.05) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.96) data.transmission = this.transmission;
        if (this.thickness !== 0.10) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.40) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.96, 0.98, 0.96).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.05) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.98, 0.99, 0.98).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.30) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.98, 0.99, 0.98).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.gelatinBands !== 4) data.gelatinBands = this.gelatinBands;
        if (this.gelatinQuantize !== 0.5) data.gelatinQuantize = this.gelatinQuantize;
        if (this.gelatinSoftness !== 0.05) data.gelatinSoftness = this.gelatinSoftness;
        if (this.bubbleDensity !== 0.08) data.bubbleDensity = this.bubbleDensity;
        if (this.bubbleSize !== 0.4) data.bubbleSize = this.bubbleSize;
        if (this.mottleStrength !== 0.06) data.mottleStrength = this.mottleStrength;
        if (this.causticIntensity !== 0.35) data.causticIntensity = this.causticIntensity;
        if (this.rimGlow !== 0.10) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.98, 0.99, 0.98).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;
        return data;
    }

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
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.gelatinBands = json.gelatinBands ?? this.gelatinBands;
        this.gelatinQuantize = json.gelatinQuantize ?? this.gelatinQuantize;
        this.gelatinSoftness = json.gelatinSoftness ?? this.gelatinSoftness;
        this.bubbleDensity = json.bubbleDensity ?? this.bubbleDensity;
        this.bubbleSize = json.bubbleSize ?? this.bubbleSize;
        this.mottleStrength = json.mottleStrength ?? this.mottleStrength;
        this.causticIntensity = json.causticIntensity ?? this.causticIntensity;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicGelatinMaterialBatchComponent = {
    materialPtr: 'ui32',
    gelatinBands: 'ui8',
    gelatinQuantize: 'f64',
    gelatinSoftness: 'f64',
    bubbleDensity: 'f64',
    bubbleSize: 'f64',
    mottleStrength: 'f64',
    causticIntensity: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicGelatinMaterial,
    OrganicGelatinMaterialBatch,
    GelatinScratchPool,
    OrganicGelatinMaterialBatchComponent,
    OrganicGelatinPresets,
    applyGelatinCelBanding,
    gradeGelatinColor,
    generateGelatinBubbleTexture
};

export default OrganicGelatinMaterial;