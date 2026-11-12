// file number : 222
// full path name : src/materials/222_organicshellmaterial.js
// description : OrganicShellMaterial — a ready-to-use shell material for
//               seashells, snail shells, mollusk shells, nautilus, and other
//               calcareous exoskeletons. Extends MeshPhysicalMaterial with
//               purpose-built presets for nacre (mother-of-pearl), conch,
//               abalone, clam, nautilus, and fossilized shell. Includes
//               shell-appropriate PBR defaults (IOR ≈ 1.55, roughness
//               0.20–0.55 for polished-to-matte shells, zero metalness, thin-
//               walled transmission for the nacre pearlescent look, strong
//               iridescence for the calcium-carbonate thin-film shimmer) plus
//               real-time anime stylization: cel-banded shell highlights, nacre
//               iridescence shimmer, mood tinting, rim glow, and per-instance
//               variation. Includes a procedural shell-spiral texture generator
//               using logarithmic-spiral coordinates and growth-line fBm with
//               per-growth-band hashing.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Organic shells, seashells, snail shells, mollusk shells, nautilus
//            shells, abalone, clam shells, conch shells, fossilized shells, and
//            any calcareous exoskeleton surface that needs real-time PBR +
//            anime stylization.
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
// Shell presets — biologically grounded PBR parameter sets for shell types.
//
// Reference values (from seashell/nacre PBR references, cgaxis shell texture
// packs, and marine biology literature):
//   - Shell IOR:              ≈ 1.55 (aragonite / calcite)
//   - Shell roughness:        0.20–0.55 (polished nacre to matte conch)
//   - Metalness:              0.0 (shell is a dielectric)
//   - Nacre transmission:     0.10–0.25 (thin pearl-layer translucency)
//   - Iridescence:            strong for nacre (0.6–1.0); weak for matte shells
//   - Clearcoat:              useful for the polished wet look of nacre
// ---------------------------------------------------------------------------

const OrganicShellPresets = {
    'nacre': {
        color: [0.92, 0.88, 0.94],
        roughness: 0.22,
        metalness: 0.0,
        clearcoat: 0.45,
        clearcoatRoughness: 0.10,
        transmission: 0.18,
        thickness: 0.003,
        attenuationDistance: 0.05,
        attenuationColor: [0.95, 0.90, 0.96],
        iridescence: 0.85,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [300, 900],
        specularIntensity: 0.75,
        specularColor: [1.0, 0.98, 1.0]
    },
    'conch': {
        color: [0.88, 0.68, 0.52],
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.20,
        clearcoatRoughness: 0.35,
        transmission: 0.06,
        thickness: 0.005,
        attenuationDistance: 0.06,
        attenuationColor: [0.90, 0.72, 0.58],
        iridescence: 0.25,
        iridescenceIOR: 1.50,
        iridescenceThicknessRange: [250, 650],
        specularIntensity: 0.55,
        specularColor: [0.95, 0.82, 0.72]
    },
    'abalone': {
        color: [0.72, 0.82, 0.78],
        roughness: 0.28,
        metalness: 0.0,
        clearcoat: 0.40,
        clearcoatRoughness: 0.15,
        transmission: 0.15,
        thickness: 0.003,
        attenuationDistance: 0.05,
        attenuationColor: [0.78, 0.88, 0.82],
        iridescence: 0.90,
        iridescenceIOR: 1.58,
        iridescenceThicknessRange: [280, 850],
        specularIntensity: 0.72,
        specularColor: [0.92, 0.98, 0.96]
    },
    'clam': {
        color: [0.88, 0.84, 0.78],
        roughness: 0.50,
        metalness: 0.0,
        clearcoat: 0.10,
        clearcoatRoughness: 0.45,
        transmission: 0.04,
        thickness: 0.004,
        attenuationDistance: 0.06,
        attenuationColor: [0.90, 0.86, 0.80],
        iridescence: 0.30,
        iridescenceIOR: 1.50,
        iridescenceThicknessRange: [220, 600],
        specularIntensity: 0.50,
        specularColor: [0.92, 0.88, 0.82]
    },
    'nautilus': {
        color: [0.94, 0.92, 0.86],
        roughness: 0.35,
        metalness: 0.0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.25,
        transmission: 0.10,
        thickness: 0.004,
        attenuationDistance: 0.06,
        attenuationColor: [0.96, 0.92, 0.85],
        iridescence: 0.55,
        iridescenceIOR: 1.55,
        iridescenceThicknessRange: [260, 720],
        specularIntensity: 0.65,
        specularColor: [0.96, 0.94, 0.88]
    },
    'fossilized-shell': {
        color: [0.62, 0.55, 0.44],
        roughness: 0.62,
        metalness: 0.0,
        clearcoat: 0.05,
        clearcoatRoughness: 0.55,
        transmission: 0.02,
        thickness: 0.004,
        attenuationDistance: 0.05,
        attenuationColor: [0.68, 0.60, 0.48],
        iridescence: 0.10,
        iridescenceIOR: 1.50,
        iridescenceThicknessRange: [200, 550],
        specularIntensity: 0.40,
        specularColor: [0.78, 0.72, 0.62]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable shell scratch records
// ---------------------------------------------------------------------------

class ShellScratchPool {
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

const _shellScratchPool = new ShellScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — shell-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded shell highlights. Polished nacre has very crisp specular
 * edges, matte conch has softer edges — both produced by the configurable
 * softness parameter.
 */
function applyShellCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.10) {
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
 * Apply mood-based tinting to shell. Warm moods push shell toward warm ivory/
 * peach, cool moods toward cool pearl-blue — matching the atmospheric shell
 * tinting seen in stylized beach and underwater scenes.
 */
function gradeShellColor(color, temperature, saturation, brightness, contrast) {
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

    // Shell-specific temperature bias: warm shift pushes toward warm ivory,
    // cool shift pushes toward cool pearl-blue.
    r += temperature * 0.03;
    g += temperature * 0.01;
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
 * Generate a procedural shell-spiral texture. The algorithm:
 * 1. Convert UV into logarithmic-spiral coordinates centred at a fixed
 *    origin. The log-spiral parameter (r, θ) drives the growth-band layout.
 * 2. Growth-line ridges: a sinusoid on θ (or on log(r)) produces the fine
 *    parallel ridges seen on nautilus and conch shells.
 * 3. Per-band hashing produces small colour/brightness variations between
 *    growth bands.
 * 4. Multi-octave fBm for the fine surface grain.
 * 5. Optional nacre shimmer mask (a smooth radial gradient) for the pearl
 *    sheen on nacre shells.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateShellSpiralTexture(width, height, spiralTurns = 6.0, spiralGrowth = 0.18, bandCount = 60.0, bandStrength = 0.35, grainStrength = 0.08, nacreShimmerStrength = 0.20) {
    const out = new Uint8Array(width * height * 4);

    // Centre the spiral around the UV origin (0.5, 0.5)
    const cx = 0.5;
    const cy = 0.5;
    const twoPi = Math.PI * 2.0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // Normalized UV centred at origin
            const u = (x / width) - cx;
            const v = (y / height) - cy;

            // Polar coordinates
            const r = Math.sqrt(u * u + v * v) + 1e-6;
            const theta = Math.atan2(v, u);

            // Log-spiral coordinate: r = a * exp(b * θ)
            const logR = Math.log(r);
            const spiralPhase = (logR / spiralGrowth - theta) * spiralTurns;

            // --- 1. Growth-band mask ---
            const bandPhase = (spiralPhase * bandCount) % 1.0;
            const bandNormalized = Math.abs(bandPhase - 0.5) * 2.0; // 0 at band centre, 1 at band edge
            const bandMask = 1.0 - Math.pow(bandNormalized, 1.2);

            // --- 2. Per-band hashing ---
            const bandIndex = Math.floor(spiralPhase * bandCount);
            const bandHash = Math.abs(Math.sin(bandIndex * 12.9898) * 43758.5453) % 1.0;
            const bandTint = 0.88 + bandHash * 0.12;

            // --- 3. Multi-octave fBm surface grain ---
            let fbm = 0;
            let amplitude = 1;
            let frequency = 0.03;
            let maxAmplitude = 0;
            for (let o = 0; o < 4; o++) {
                fbm += SimplexNoise.noise2D(x * frequency, y * frequency) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            fbm = (fbm / maxAmplitude) * 0.5 + 0.5;

            // --- 4. Nacre shimmer mask (smooth radial gradient) ---
            const shimmerMask = Math.max(0, 1.0 - r * 1.6) * nacreShimmerStrength;

            // --- Combine ---
            let value = 0.50
                + bandMask * bandStrength * bandTint
                + (fbm - 0.5) * grainStrength
                + shimmerMask;

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

const _shellWorld = BitECS.createWorld();
const OrganicShellMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    shellBands: 'ui8',
    shellQuantize: 'f64',
    shellSoftness: 'f64',
    nacreIridescence: 'f64',
    growthBandStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicShellMaterialBatch {
    constructor() {
        this.world = _shellWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicShellMaterialComponent, eid);
        OrganicShellMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicShellMaterialComponent.shellBands[eid] = material.shellBands;
        OrganicShellMaterialComponent.shellQuantize[eid] = material.shellQuantize;
        OrganicShellMaterialComponent.shellSoftness[eid] = material.shellSoftness;
        OrganicShellMaterialComponent.nacreIridescence[eid] = material.nacreIridescence;
        OrganicShellMaterialComponent.growthBandStrength[eid] = material.growthBandStrength;
        OrganicShellMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicShellMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicShellMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicShellMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicShellMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicShellMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicShellMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicShellMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.shellBands = OrganicShellMaterialComponent.shellBands[eid];
            material.shellQuantize = OrganicShellMaterialComponent.shellQuantize[eid];
            material.shellSoftness = OrganicShellMaterialComponent.shellSoftness[eid];
            material.nacreIridescence = OrganicShellMaterialComponent.nacreIridescence[eid];
            material.growthBandStrength = OrganicShellMaterialComponent.growthBandStrength[eid];
            material.moodTemperature = OrganicShellMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicShellMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicShellMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicShellMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicShellMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicShellMaterialComponent.variationSeed[eid];

            OrganicShellMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicShellMaterial class
// ---------------------------------------------------------------------------

class OrganicShellMaterial extends MeshPhysicalMaterial {
    static {
        _shellScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicShellMaterial = true;
        this.type = 'OrganicShellMaterial';

        // -------------------------------------------------------------------
        // Shell-specific PBR defaults (nacre baseline)
        // -------------------------------------------------------------------
        this.ior = 1.55;
        this.specularIntensity = 0.75;
        this.roughness = 0.22;
        this.metalness = 0.0;
        this.specularColor = new Color(1.0, 0.98, 1.0);
        this.color = new Color(0.92, 0.88, 0.94);

        // Clearcoat for the polished wet nacre look
        this.clearcoat = 0.45;
        this.clearcoatRoughness = 0.10;

        // Thin-walled transmission for pearl-layer translucency
        this.transmission = 0.18;
        this.thickness = 0.003;
        this.attenuationDistance = 0.05;
        this.attenuationColor = new Color(0.95, 0.90, 0.96);

        // Strong iridescence for nacre shimmer
        this.iridescence = 0.85;
        this.iridescenceIOR = 1.55;
        this.iridescenceThicknessRange = [300, 900];

        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;

        // -------------------------------------------------------------------
        // Anime rendering extensions — shell-specific
        // -------------------------------------------------------------------
        this.shellBands = 3;
        this.shellQuantize = 0.4;
        this.shellSoftness = 0.10;
        this.nacreIridescence = 0.85;
        this.nacreIridescenceColor = new Color(0.85, 0.92, 1.0);
        this.growthBandStrength = 0.35;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(0.92, 0.92, 1.0);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (shell leans semi-realistic)
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

    applyShellBanding(baseColor, output) {
        return applyShellCelBanding(
            baseColor,
            output,
            this.shellBands,
            this.shellQuantize,
            this.shellSoftness
        );
    }

    updateMoodColor() {
        gradeShellColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic shell preset to this material.
     * @param {string} presetName - One of the keys of `OrganicShellPresets`.
     * @returns {OrganicShellMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicShellPresets[presetName];
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
        this.iridescence = preset.iridescence;
        this.iridescenceIOR = preset.iridescenceIOR;
        this.iridescenceThicknessRange = preset.iridescenceThicknessRange.slice();
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness per preset
        if (presetName === 'nacre' || presetName === 'abalone') {
            this.shellSoftness = 0.06;
            this.shellBands = 4;
        } else if (presetName === 'clam' || presetName === 'fossilized-shell') {
            this.shellSoftness = 0.25;
            this.shellBands = 2;
        } else {
            this.shellSoftness = 0.12;
            this.shellBands = 3;
        }

        this.nacreIridescence = preset.iridescence;

        this.updateMoodColor();
        return this;
    }

    generateShellSpiralTexture(width, height, spiralTurns = 6.0, spiralGrowth = 0.18, bandCount = 60.0, bandStrength = 0.35, nacreShimmerStrength = 0.20) {
        return generateShellSpiralTexture(width, height, spiralTurns, spiralGrowth, bandCount, bandStrength, 0.08, nacreShimmerStrength);
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

        shader.uniforms.shellBands = { value: this.shellBands };
        shader.uniforms.shellQuantize = { value: this.shellQuantize };
        shader.uniforms.shellSoftness = { value: this.shellSoftness };
        shader.uniforms.nacreIridescence = { value: this.nacreIridescence };
        shader.uniforms.nacreIridescenceColor = { value: this.nacreIridescenceColor };
        shader.uniforms.growthBandStrength = { value: this.growthBandStrength };
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
                uniform int shellBands;
                uniform float shellQuantize;
                uniform float shellSoftness;
                uniform float nacreIridescence;
                uniform vec3 nacreIridescenceColor;
                uniform float growthBandStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyShellBands(vec3 baseColor) {
                    if (shellBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(shellBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * shellSoftness;
                    float finalLum = mix(lum, softQuantized, shellQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply shell cel banding
                gl_FragColor.rgb = applyShellBands(gl_FragColor.rgb);

                // Nacre iridescence shimmer: grazing-angle colour shift
                if (nacreIridescence > 0.0) {
                    float ndotvShell = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float shimmerMask = pow(1.0 - ndotvShell, 3.0) * nacreIridescence;
                    // Hue shift based on grazing angle for the pearl-layer effect
                    float hueShift = (1.0 - ndotvShell) * 0.35;
                    vec3 shimmerColor = mix(nacreIridescenceColor, vec3(1.0, 0.90, 0.85), hueShift);
                    gl_FragColor.rgb += shimmerColor * shimmerMask * 0.55;
                }

                // Growth-band subtle darkening
                if (growthBandStrength > 0.0) {
                    float growthBand = sin(length(vUv - 0.5) * 60.0) * 0.5 + 0.5;
                    float bandMask = pow(growthBand, 3.0) * growthBandStrength;
                    gl_FragColor.rgb *= (1.0 - bandMask * 0.15);
                }

                // Cool-neutral rim glow on shell edges
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
            this.iridescence, this.iridescenceIOR,
            this.shellBands, this.shellQuantize, this.shellSoftness,
            this.nacreIridescence, this.growthBandStrength,
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
        this.iridescence = source.iridescence;
        this.iridescenceIOR = source.iridescenceIOR;
        this.iridescenceThicknessRange = source.iridescenceThicknessRange.slice();
        this.shellBands = source.shellBands;
        this.shellQuantize = source.shellQuantize;
        this.shellSoftness = source.shellSoftness;
        this.nacreIridescence = source.nacreIridescence;
        this.nacreIridescenceColor.copy(source.nacreIridescenceColor);
        this.growthBandStrength = source.growthBandStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicShellMaterial';
        if (this.ior !== 1.55) data.ior = this.ior;
        if (this.specularIntensity !== 0.75) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.22) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.clearcoat !== 0.45) data.clearcoat = this.clearcoat;
        if (this.clearcoatRoughness !== 0.10) data.clearcoatRoughness = this.clearcoatRoughness;
        if (this.transmission !== 0.18) data.transmission = this.transmission;
        if (this.thickness !== 0.003) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.05) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.95, 0.90, 0.96).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.iridescence !== 0.85) data.iridescence = this.iridescence;
        if (this.iridescenceIOR !== 1.55) data.iridescenceIOR = this.iridescenceIOR;
        if (this.specularColor.getHex() !== new Color(1.0, 0.98, 1.0).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.shellBands !== 3) data.shellBands = this.shellBands;
        if (this.shellQuantize !== 0.4) data.shellQuantize = this.shellQuantize;
        if (this.shellSoftness !== 0.10) data.shellSoftness = this.shellSoftness;
        if (this.nacreIridescence !== 0.85) data.nacreIridescence = this.nacreIridescence;
        if (this.nacreIridescenceColor.getHex() !== new Color(0.85, 0.92, 1.0).getHex()) data.nacreIridescenceColor = this.nacreIridescenceColor.getHex();
        if (this.growthBandStrength !== 0.35) data.growthBandStrength = this.growthBandStrength;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.92, 0.92, 1.0).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.iridescence = json.iridescence ?? this.iridescence;
        this.iridescenceIOR = json.iridescenceIOR ?? this.iridescenceIOR;
        if (json.iridescenceThicknessRange) this.iridescenceThicknessRange = json.iridescenceThicknessRange.slice();
        this.shellBands = json.shellBands ?? this.shellBands;
        this.shellQuantize = json.shellQuantize ?? this.shellQuantize;
        this.shellSoftness = json.shellSoftness ?? this.shellSoftness;
        this.nacreIridescence = json.nacreIridescence ?? this.nacreIridescence;
        if (json.nacreIridescenceColor !== undefined) this.nacreIridescenceColor.setHex(json.nacreIridescenceColor);
        this.growthBandStrength = json.growthBandStrength ?? this.growthBandStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicShellMaterialBatchComponent = {
    materialPtr: 'ui32',
    shellBands: 'ui8',
    shellQuantize: 'f64',
    shellSoftness: 'f64',
    nacreIridescence: 'f64',
    growthBandStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicShellMaterial,
    OrganicShellMaterialBatch,
    ShellScratchPool,
    OrganicShellMaterialBatchComponent,
    OrganicShellPresets,
    applyShellCelBanding,
    gradeShellColor,
    generateShellSpiralTexture
};

export default OrganicShellMaterial;