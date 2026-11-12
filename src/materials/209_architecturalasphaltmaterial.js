// file number : 209
// full path name : src/materials/209_architecturalasphaltmaterial.js
// description : ArchitecturalAsphaltMaterial — a ready-to-use asphalt material
//               for architectural visualization, focused on asphalt paving,
//               parking lots, roads, driveways, tarmac, and pervious paving.
//               Extends MeshPhysicalMaterial with purpose-built presets for
//               new asphalt, weathered asphalt, wet asphalt, tarmac, and
//               pervious paving. Includes asphalt-appropriate PBR defaults
//               (high roughness for dry asphalt, low roughness + higher
//               specular for wet asphalt, zero metalness) plus real-time
//               anime stylization (cel-banded asphalt highlights, mood
//               tinting, wet-glint rim glow, paper-grain texture, watercolor
//               bleed, and per-instance variation). Includes a procedural
//               asphalt-aggregate texture generator using multi-octave fBm
//               for the bitumen binder, high-frequency hashed speckles for
//               aggregate, and optional wetness patches for wet variants.
//               All imports resolve to the internal Threejs_gl repository
//               tree; no CDN dependencies.
// best for : Architectural asphalt, asphalt paving, parking lots, roads,
//            driveways, tarmac, pervious paving, parking structures, service
//            yards, and any asphalt surface that needs real-time PBR + anime
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
// Asphalt presets — curated PBR parameter sets for common architectural asphalt
// ---------------------------------------------------------------------------

/**
 * Asphalt reference PBR values (from architectural paving guides):
 *   - New asphalt:       roughness 0.82–0.88, very dark grey (~0.18 lum),
 *                        specular ~0.25, zero metalness
 *   - Weathered asphalt: roughness 0.90–0.94, mid-grey (~0.32 lum),
 *                        specular ~0.20 (oxidised micro-surface)
 *   - Wet asphalt:       roughness 0.30–0.40, very dark (~0.12 lum),
 *                        specular ~0.65 (water film on binder), higher
 *                        clearcoat for the wet-glint effect
 *   - Tarmac:            roughness 0.86–0.90, warm mixed grey (~0.28 lum),
 *                        specular ~0.24
 *   - Pervious paving:   roughness 0.94–0.96, lighter open-graded stone,
 *                        specular ~0.15 (very diffuse)
 */
const ArchitecturalAsphaltPresets = {
    'new-asphalt': {
        color: [0.18, 0.18, 0.19],
        roughness: 0.85,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        specularIntensity: 0.25,
        specularColor: [0.6, 0.6, 0.62]
    },
    'weathered-asphalt': {
        color: [0.32, 0.32, 0.33],
        roughness: 0.92,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        specularIntensity: 0.20,
        specularColor: [0.65, 0.65, 0.66]
    },
    'wet-asphalt': {
        color: [0.12, 0.12, 0.14],
        roughness: 0.34,
        metalness: 0.0,
        clearcoat: 0.45,
        clearcoatRoughness: 0.08,
        specularIntensity: 0.65,
        specularColor: [0.75, 0.78, 0.82]
    },
    'tarmac': {
        color: [0.28, 0.27, 0.26],
        roughness: 0.88,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        specularIntensity: 0.24,
        specularColor: [0.66, 0.64, 0.60]
    },
    'pervious-paving': {
        color: [0.42, 0.41, 0.39],
        roughness: 0.95,
        metalness: 0.0,
        clearcoat: 0.0,
        clearcoatRoughness: 0.0,
        specularIntensity: 0.15,
        specularColor: [0.60, 0.58, 0.55]
    },
    'airport-runway': {
        color: [0.16, 0.16, 0.17],
        roughness: 0.80,
        metalness: 0.0,
        clearcoat: 0.1,
        clearcoatRoughness: 0.15,
        specularIntensity: 0.30,
        specularColor: [0.62, 0.62, 0.64]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable asphalt scratch records
// ---------------------------------------------------------------------------

class AsphaltScratchPool {
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

const _asphaltScratchPool = new AsphaltScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — asphalt-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded asphalt highlights. Asphalt has a mostly uniform binder
 * with per-aggregate speckles — quantizing the luminance into discrete bands
 * produces the crisp anime asphalt edges seen in hand-drawn architectural
 * exteriors.
 */
function applyAsphaltCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to asphalt. Warm moods tint asphalt toward a warm
 * charcoal-umber, cool moods toward a cool blue-charcoal — matching the
 * atmospheric asphalt tinting seen in architectural anime backgrounds.
 */
function gradeAsphaltColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.02;
    b -= temperature * 0.02;

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
 * Generate a procedural asphalt-aggregate texture. The algorithm:
 * 1. Multi-octave fBm for the bitumen binder base (large-scale patch variation).
 * 2. High-frequency hashed speckle field for aggregate stones:
 *    - Sample a hash at the pixel's integer cell ID (fine grid).
 *    - If the hash exceeds a per-frequency threshold, place a bright speckle.
 *    - Blend speckle colour with the binder using hash-based intensity.
 * 3. Optional wetness patches: low-frequency mask that darkens the binder and
 *    brightens specular glints (for wet asphalt variants).
 * 4. Add a subtle directional micro-grain for the fine surface roughness.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map use.
 */
function generateAsphaltPatternTexture(width, height, scale = 0.03, octaves = 4, speckleDensity = 0.18, speckleStrength = 0.35, wetnessStrength = 0.0, grainStrength = 0.04) {
    const out = new Uint8Array(width * height * 4);

    // Pre-compute a bitumen base offset so each call varies
    const baseOffsetX = (width * 0.137) % 1000;
    const baseOffsetY = (height * 0.271) % 1000;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Bitumen binder via multi-octave fBm ---
            let fbm = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                fbm += SimplexNoise.noise2D(
                    (x + baseOffsetX) * frequency,
                    (y + baseOffsetY) * frequency
                ) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;

            // --- 2. Aggregate speckle field ---
            // Use a fine grid (~2-pixel cells) with a per-cell hash.
            const cellX = Math.floor(x * 0.5);
            const cellY = Math.floor(y * 0.5);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const cellHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;

            // Speckle mask: only fire when hash exceeds the density threshold
            const isSpeckle = cellHash > (1.0 - speckleDensity) ? 1.0 : 0.0;

            // Per-speckle brightness from a second hash
            const cellHash2 = Math.abs(Math.sin(cellId * 78.233 + 12.34) * 43758.5453) % 1.0;
            const speckleBrightness = isSpeckle * (0.55 + cellHash2 * 0.45);

            // --- 3. Wetness patches ---
            let wetness = 0;
            if (wetnessStrength > 0) {
                const w = SimplexNoise.noise2D(x * 0.006, y * 0.006) * 0.5 + 0.5;
                wetness = Math.max(0, w - 0.4) / 0.6 * wetnessStrength;
            }

            // --- 4. Micro-grain ---
            const grain = SimplexNoise.noise2D(x * 0.9, y * 0.9) * grainStrength;

            // --- Combine ---
            // Bitumen base (fBm) + speckle contribution + wetness darkening + grain
            let value = 0.30
                + (fbm - 0.5) * 0.15
                + speckleBrightness * speckleStrength
                - wetness * 0.20
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

const _asphaltWorld = BitECS.createWorld();
const ArchitecturalAsphaltMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    asphaltBands: 'ui8',
    asphaltQuantize: 'f64',
    asphaltSoftness: 'f64',
    wetGlintIntensity: 'f64',
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

class ArchitecturalAsphaltMaterialBatch {
    constructor() {
        this.world = _asphaltWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalAsphaltMaterialComponent, eid);
        ArchitecturalAsphaltMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalAsphaltMaterialComponent.asphaltBands[eid] = material.asphaltBands;
        ArchitecturalAsphaltMaterialComponent.asphaltQuantize[eid] = material.asphaltQuantize;
        ArchitecturalAsphaltMaterialComponent.asphaltSoftness[eid] = material.asphaltSoftness;
        ArchitecturalAsphaltMaterialComponent.wetGlintIntensity[eid] = material.wetGlintIntensity;
        ArchitecturalAsphaltMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalAsphaltMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalAsphaltMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalAsphaltMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalAsphaltMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalAsphaltMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalAsphaltMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalAsphaltMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalAsphaltMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalAsphaltMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.asphaltBands = ArchitecturalAsphaltMaterialComponent.asphaltBands[eid];
            material.asphaltQuantize = ArchitecturalAsphaltMaterialComponent.asphaltQuantize[eid];
            material.asphaltSoftness = ArchitecturalAsphaltMaterialComponent.asphaltSoftness[eid];
            material.wetGlintIntensity = ArchitecturalAsphaltMaterialComponent.wetGlintIntensity[eid];
            material.moodTemperature = ArchitecturalAsphaltMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalAsphaltMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalAsphaltMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalAsphaltMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalAsphaltMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalAsphaltMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalAsphaltMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalAsphaltMaterialComponent.variationSeed[eid];

            ArchitecturalAsphaltMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalAsphaltMaterial class
// ---------------------------------------------------------------------------

class ArchitecturalAsphaltMaterial extends MeshPhysicalMaterial {
    static {
        _asphaltScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isArchitecturalAsphaltMaterial = true;
        this.type = 'ArchitecturalAsphaltMaterial';

        // -------------------------------------------------------------------
        // Asphalt-specific PBR defaults (new asphalt baseline)
        // -------------------------------------------------------------------
        this.ior = 1.55;
        this.specularIntensity = 0.25;
        this.roughness = 0.85;
        this.metalness = 0.0;
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;
        this.specularColor = new Color(0.6, 0.6, 0.62);
        this.color = new Color(0.18, 0.18, 0.19);
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;
        this.transmission = 0.0;
        this.thickness = 0.0;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        // -------------------------------------------------------------------
        // Anime rendering extensions — asphalt-specific
        // -------------------------------------------------------------------
        this.asphaltBands = 2;
        this.asphaltQuantize = 0.4;
        this.asphaltSoftness = 0.18;
        this.wetGlintIntensity = 0.0;
        this.wetGlintColor = new Color(0.85, 0.90, 1.0);
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.06;
        this.rimGlowColor = new Color(0.75, 0.78, 0.85);
        this.paperGrain = 0;
        this.watercolorBleed = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (asphalt leans semi-realistic)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.28;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    applyAsphaltBanding(baseColor, output) {
        return applyAsphaltCelBanding(
            baseColor,
            output,
            this.asphaltBands,
            this.asphaltQuantize,
            this.asphaltSoftness
        );
    }

    updateMoodColor() {
        gradeAsphaltColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural asphalt preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalAsphaltPresets`.
     * @returns {ArchitecturalAsphaltMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalAsphaltPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Wet asphalt variant: enable wet-glint rim, crisper anime bands
        if (presetName === 'wet-asphalt') {
            this.wetGlintIntensity = 0.55;
            this.asphaltSoftness = 0.08;
            this.asphaltBands = 3;
        } else {
            this.wetGlintIntensity = 0.0;
            this.asphaltSoftness = preset.roughness > 0.9 ? 0.22 : 0.16;
            this.asphaltBands = 2;
        }

        this.updateMoodColor();
        return this;
    }

    generateAsphaltPatternTexture(width, height, scale = 0.03, octaves = 4, wetness = 0.0) {
        return generateAsphaltPatternTexture(width, height, scale, octaves, 0.18, 0.35, wetness, 0.04);
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

        shader.uniforms.asphaltBands = { value: this.asphaltBands };
        shader.uniforms.asphaltQuantize = { value: this.asphaltQuantize };
        shader.uniforms.asphaltSoftness = { value: this.asphaltSoftness };
        shader.uniforms.wetGlintIntensity = { value: this.wetGlintIntensity };
        shader.uniforms.wetGlintColor = { value: this.wetGlintColor };
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
                uniform int asphaltBands;
                uniform float asphaltQuantize;
                uniform float asphaltSoftness;
                uniform float wetGlintIntensity;
                uniform vec3 wetGlintColor;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyAsphaltBands(vec3 baseColor) {
                    if (asphaltBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(asphaltBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * asphaltSoftness;
                    float finalLum = mix(lum, softQuantized, asphaltQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply asphalt cel banding
                gl_FragColor.rgb = applyAsphaltBands(gl_FragColor.rgb);

                // Wet-glint effect: bright grazing-angle specular streaks
                if (wetGlintIntensity > 0.0) {
                    float ndotvWet = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float glint = pow(1.0 - ndotvWet, 4.0) * wetGlintIntensity;
                    gl_FragColor.rgb += wetGlintColor * glint;
                }

                // Cool-neutral rim glow on asphalt edges
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
            this.asphaltBands, this.asphaltQuantize, this.asphaltSoftness,
            this.wetGlintIntensity,
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
        this.clearcoat = source.clearcoat;
        this.clearcoatRoughness = source.clearcoatRoughness;
        this.specularColor.copy(source.specularColor);
        this.asphaltBands = source.asphaltBands;
        this.asphaltQuantize = source.asphaltQuantize;
        this.asphaltSoftness = source.asphaltSoftness;
        this.wetGlintIntensity = source.wetGlintIntensity;
        this.wetGlintColor.copy(source.wetGlintColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'ArchitecturalAsphaltMaterial';
        if (this.ior !== 1.55) data.ior = this.ior;
        if (this.specularIntensity !== 0.25) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.85) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.6, 0.6, 0.62).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.asphaltBands !== 2) data.asphaltBands = this.asphaltBands;
        if (this.asphaltQuantize !== 0.4) data.asphaltQuantize = this.asphaltQuantize;
        if (this.asphaltSoftness !== 0.18) data.asphaltSoftness = this.asphaltSoftness;
        if (this.wetGlintIntensity !== 0.0) data.wetGlintIntensity = this.wetGlintIntensity;
        if (this.wetGlintColor.getHex() !== new Color(0.85, 0.90, 1.0).getHex()) data.wetGlintColor = this.wetGlintColor.getHex();
        if (this.rimGlow !== 0.06) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.75, 0.78, 0.85).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;
        return data;
    }

    fromJSON(json) {
        super.fromJSON(json);
        this.ior = json.ior ?? this.ior;
        this.specularIntensity = json.specularIntensity ?? this.specularIntensity;
        this.roughness = json.roughness ?? this.roughness;
        this.metalness = json.metalness ?? this.metalness;
        this.clearcoat = json.clearcoat ?? this.clearcoat;
        this.clearcoatRoughness = json.clearcoatRoughness ?? this.clearcoatRoughness;
        if (json.specularColor !== undefined) this.specularColor.setHex(json.specularColor);
        this.asphaltBands = json.asphaltBands ?? this.asphaltBands;
        this.asphaltQuantize = json.asphaltQuantize ?? this.asphaltQuantize;
        this.asphaltSoftness = json.asphaltSoftness ?? this.asphaltSoftness;
        this.wetGlintIntensity = json.wetGlintIntensity ?? this.wetGlintIntensity;
        if (json.wetGlintColor !== undefined) this.wetGlintColor.setHex(json.wetGlintColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const ArchitecturalAsphaltMaterialBatchComponent = {
    materialPtr: 'ui32',
    asphaltBands: 'ui8',
    asphaltQuantize: 'f64',
    asphaltSoftness: 'f64',
    wetGlintIntensity: 'f64',
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
    ArchitecturalAsphaltMaterial,
    ArchitecturalAsphaltMaterialBatch,
    AsphaltScratchPool,
    ArchitecturalAsphaltMaterialBatchComponent,
    ArchitecturalAsphaltPresets,
    applyAsphaltCelBanding,
    gradeAsphaltColor,
    generateAsphaltPatternTexture
};

export default ArchitecturalAsphaltMaterial;