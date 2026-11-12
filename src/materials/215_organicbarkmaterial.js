// file number : 215
// full path name : src/materials/215_organicbarkmaterial.js
// description : OrganicBarkMaterial — a ready-to-use bark material for trees,
//               shrubs, and woody plant surfaces. Extends MeshPhysicalMaterial
//               with purpose-built presets for oak, pine, birch, cherry, and
//               weathered bark. Includes biologically grounded bark defaults
//               (high roughness ≈ 0.85–0.95, low specular ≈ 0.15–0.25, zero
//               metalness) plus real-time anime stylization: cel-banded bark
//               fissures, mood tinting, rim glow, and per-instance variation.
//               Includes a procedural bark-fissure texture generator using
//               domain-warped fBm with directional fissures, per-fissure
//               hashing, and lenticel speckles. All imports resolve to the
//               internal Threejs_gl repository tree; no CDN dependencies.
// best for : Organic bark, tree trunks, shrubs, woody plant stems, roots,
//            branch surfaces, forest environments, and any bark surface that
//            needs real-time PBR + anime stylization.
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
// Bark presets — biologically grounded PBR parameter sets for bark types.
//
// Reference values (cgaxis PBR bark packs, 3DTexel AI bark materials, and
// Substance bark references):
//   - Bark roughness:  0.85–0.95 (highly micro-rough)
//   - Bark specular:   0.15–0.25 (very low, dielectric)
//   - Bark IOR:        ≈ 1.45 (woody cellulose)
//   - Metalness:       0.0 (bark is a dielectric)
// ---------------------------------------------------------------------------

const OrganicBarkPresets = {
    'oak': {
        color: [0.32, 0.24, 0.16],
        roughness: 0.92,
        metalness: 0.0,
        specularIntensity: 0.20,
        specularColor: [0.55, 0.48, 0.38],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'pine': {
        color: [0.42, 0.28, 0.18],
        roughness: 0.88,
        metalness: 0.0,
        specularIntensity: 0.22,
        specularColor: [0.62, 0.48, 0.35],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'birch': {
        color: [0.88, 0.86, 0.82],
        roughness: 0.78,
        metalness: 0.0,
        specularIntensity: 0.25,
        specularColor: [0.92, 0.90, 0.86],
        clearcoat: 0.05,
        clearcoatRoughness: 0.35
    },
    'cherry': {
        color: [0.38, 0.18, 0.12],
        roughness: 0.82,
        metalness: 0.0,
        specularIntensity: 0.24,
        specularColor: [0.60, 0.42, 0.32],
        clearcoat: 0.08,
        clearcoatRoughness: 0.28
    },
    'weathered': {
        color: [0.48, 0.44, 0.40],
        roughness: 0.95,
        metalness: 0.0,
        specularIntensity: 0.15,
        specularColor: [0.60, 0.58, 0.55],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    },
    'redwood': {
        color: [0.52, 0.24, 0.16],
        roughness: 0.86,
        metalness: 0.0,
        specularIntensity: 0.22,
        specularColor: [0.68, 0.45, 0.35],
        clearcoat: 0.0,
        clearcoatRoughness: 0.0
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable bark scratch records
// ---------------------------------------------------------------------------

class BarkScratchPool {
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

const _barkScratchPool = new BarkScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — bark-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded bark highlights. Bark has deep fissures and rough plates —
 * quantizing the luminance into discrete bands produces the crisp anime bark
 * edges seen in hand-drawn forest scenes.
 */
function applyBarkCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.20) {
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
 * Apply mood-based tinting to bark. Warm moods push bark toward a warm
 * chestnut/amber, cool moods toward a cool grey-brown — matching the
 * atmospheric bark tinting seen in forest anime backgrounds.
 */
function gradeBarkColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.03;
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
 * Generate a procedural bark-fissure texture. The algorithm:
 * 1. Domain-warp the UV using two low-frequency fBm layers to produce
 *    organic wobble (reference: bevy_symbios_texture bark.rs domain-warp
 *    pattern[reference:0]).
 * 2. Sample a third fBm layer at the warped UV for the base bark tone.
 * 3. Directional fissure mask: high-frequency noise stretched along the
 *    bark axis produces vertical cracks.
 * 4. Per-fissure hashing darkens some fissures more than others.
 * 5. Lenticel speckles: hashed horizontal dashes for birch-style markings.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateBarkFissureTexture(width, height, scale = 0.03, octaves = 4, warpStrength = 2.0, fissureStrength = 0.35, fissureDensity = 8.0, lenticelStrength = 0.15) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Domain warp ---
            const warpX = SimplexNoise.noise2D(x * 0.008, y * 0.008) * warpStrength;
            const warpY = SimplexNoise.noise2D(x * 0.008 + 100, y * 0.008 + 100) * warpStrength;

            // --- 2. Base fBm at warped UV ---
            let fbm = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                fbm += SimplexNoise.noise2D(
                    (x + warpX) * frequency,
                    (y + warpY) * frequency
                ) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;

            // --- 3. Directional fissure mask ---
            // Stretch noise along the vertical bark axis (y) more than x
            const fissureNoise = SimplexNoise.noise2D(
                (x + warpX) * 0.15 * fissureDensity,
                (y + warpY) * 0.02 * fissureDensity
            );
            const fissure = Math.pow(Math.max(0, 1.0 - Math.abs(fissureNoise)), 3.0) * fissureStrength;

            // --- 4. Per-fissure hashing (darken some fissures) ---
            const fissureCell = Math.floor((x + warpX) * 0.15 * fissureDensity);
            const fissureHash = Math.abs(Math.sin(fissureCell * 12.9898) * 43758.5453) % 1.0;
            const fissureDarken = fissure * (0.5 + fissureHash * 0.5);

            // --- 5. Lenticel speckles (birch-style horizontal dashes) ---
            const cellX = Math.floor(x * 0.3);
            const cellY = Math.floor(y * 0.9);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const lenticelHash = Math.abs(Math.sin(cellId * 12.9898 + 3.14) * 43758.5453) % 1.0;
            const lenticel = lenticelHash > 0.92 ? 1.0 : 0.0;
            const lenticelValue = lenticel * lenticelStrength;

            // --- Combine ---
            // Base tone + fBm variation − fissure darkening + lenticel brightening
            let value = 0.55
                + (fbm - 0.5) * 0.30
                - fissureDarken * 0.50
                + lenticelValue * 0.40;

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

const _barkWorld = BitECS.createWorld();
const OrganicBarkMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    barkBands: 'ui8',
    barkQuantize: 'f64',
    barkSoftness: 'f64',
    fissureStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicBarkMaterialBatch {
    constructor() {
        this.world = _barkWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicBarkMaterialComponent, eid);
        OrganicBarkMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicBarkMaterialComponent.barkBands[eid] = material.barkBands;
        OrganicBarkMaterialComponent.barkQuantize[eid] = material.barkQuantize;
        OrganicBarkMaterialComponent.barkSoftness[eid] = material.barkSoftness;
        OrganicBarkMaterialComponent.fissureStrength[eid] = material.fissureStrength;
        OrganicBarkMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicBarkMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicBarkMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicBarkMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicBarkMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicBarkMaterialComponent.paperGrain[eid] = material.paperGrain;
        OrganicBarkMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicBarkMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicBarkMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.barkBands = OrganicBarkMaterialComponent.barkBands[eid];
            material.barkQuantize = OrganicBarkMaterialComponent.barkQuantize[eid];
            material.barkSoftness = OrganicBarkMaterialComponent.barkSoftness[eid];
            material.fissureStrength = OrganicBarkMaterialComponent.fissureStrength[eid];
            material.moodTemperature = OrganicBarkMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicBarkMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicBarkMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicBarkMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicBarkMaterialComponent.rimGlow[eid];
            material.paperGrain = OrganicBarkMaterialComponent.paperGrain[eid];
            material.variationSeed = OrganicBarkMaterialComponent.variationSeed[eid];

            OrganicBarkMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicBarkMaterial class
// ---------------------------------------------------------------------------

class OrganicBarkMaterial extends MeshPhysicalMaterial {
    static {
        _barkScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicBarkMaterial = true;
        this.type = 'OrganicBarkMaterial';

        // -------------------------------------------------------------------
        // Bark-specific PBR defaults (oak baseline)
        // -------------------------------------------------------------------
        this.ior = 1.45;
        this.specularIntensity = 0.20;
        this.roughness = 0.92;
        this.metalness = 0.0;
        this.specularColor = new Color(0.55, 0.48, 0.38);
        this.color = new Color(0.32, 0.24, 0.16);

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        this.transmission = 0.0;
        this.thickness = 0.0;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — bark-specific
        // -------------------------------------------------------------------
        this.barkBands = 2;
        this.barkQuantize = 0.4;
        this.barkSoftness = 0.20;
        this.fissureStrength = 0.35;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.08;
        this.rimGlowColor = new Color(0.85, 0.72, 0.55);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (bark leans semi-realistic)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.30;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    applyBarkBanding(baseColor, output) {
        return applyBarkCelBanding(
            baseColor,
            output,
            this.barkBands,
            this.barkQuantize,
            this.barkSoftness
        );
    }

    updateMoodColor() {
        gradeBarkColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic bark preset to this material.
     * @param {string} presetName - One of the keys of `OrganicBarkPresets`.
     * @returns {OrganicBarkMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicBarkPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);
        this.clearcoat = preset.clearcoat;
        this.clearcoatRoughness = preset.clearcoatRoughness;

        // Birch: brighter, crisper bands; weathered: softest bands
        if (presetName === 'birch') {
            this.barkSoftness = 0.15;
            this.barkBands = 3;
        } else if (presetName === 'weathered') {
            this.barkSoftness = 0.30;
            this.barkBands = 2;
        } else {
            this.barkSoftness = 0.20;
            this.barkBands = 2;
        }

        this.updateMoodColor();
        return this;
    }

    generateBarkFissureTexture(width, height, scale = 0.03, octaves = 4, warpStrength = 2.0, fissureStrength = 0.35, fissureDensity = 8.0) {
        return generateBarkFissureTexture(width, height, scale, octaves, warpStrength, fissureStrength, fissureDensity, 0.15);
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

        shader.uniforms.barkBands = { value: this.barkBands };
        shader.uniforms.barkQuantize = { value: this.barkQuantize };
        shader.uniforms.barkSoftness = { value: this.barkSoftness };
        shader.uniforms.fissureStrength = { value: this.fissureStrength };
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
                uniform int barkBands;
                uniform float barkQuantize;
                uniform float barkSoftness;
                uniform float fissureStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyBarkBands(vec3 baseColor) {
                    if (barkBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(barkBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * barkSoftness;
                    float finalLum = mix(lum, softQuantized, barkQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply bark cel banding
                gl_FragColor.rgb = applyBarkBands(gl_FragColor.rgb);

                // Warm rim glow on bark edges
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
            this.barkBands, this.barkQuantize, this.barkSoftness,
            this.fissureStrength,
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
        this.barkBands = source.barkBands;
        this.barkQuantize = source.barkQuantize;
        this.barkSoftness = source.barkSoftness;
        this.fissureStrength = source.fissureStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicBarkMaterial';
        if (this.ior !== 1.45) data.ior = this.ior;
        if (this.specularIntensity !== 0.20) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.92) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.0) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.0) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.specularColor.getHex() !== new Color(0.55, 0.48, 0.38).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.barkBands !== 2) data.barkBands = this.barkBands;
        if (this.barkQuantize !== 0.4) data.barkQuantize = this.barkQuantize;
        if (this.barkSoftness !== 0.20) data.barkSoftness = this.barkSoftness;
        if (this.fissureStrength !== 0.35) data.fissureStrength = this.fissureStrength;
        if (this.rimGlow !== 0.08) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.72, 0.55).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.barkBands = json.barkBands ?? this.barkBands;
        this.barkQuantize = json.barkQuantize ?? this.barkQuantize;
        this.barkSoftness = json.barkSoftness ?? this.barkSoftness;
        this.fissureStrength = json.fissureStrength ?? this.fissureStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicBarkMaterialBatchComponent = {
    materialPtr: 'ui32',
    barkBands: 'ui8',
    barkQuantize: 'f64',
    barkSoftness: 'f64',
    fissureStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicBarkMaterial,
    OrganicBarkMaterialBatch,
    BarkScratchPool,
    OrganicBarkMaterialBatchComponent,
    OrganicBarkPresets,
    applyBarkCelBanding,
    gradeBarkColor,
    generateBarkFissureTexture
};

export default OrganicBarkMaterial;