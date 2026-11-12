// file number : 221
// full path name : src/materials/221_organiccoralmaterial.js
// description : OrganicCoralMaterial — a ready-to-use coral material for coral,
//               coral reef, and reef-building organism surfaces. Extends
//               MeshPhysicalMaterial with purpose-built presets for staghorn
//               coral, brain coral, soft coral, sea-fan coral, and bleached
//               coral. Includes reef-appropriate PBR defaults (IOR ≈ 1.45,
//               roughness 0.40–0.70 for wet coral, zero metalness, thin-walled
//               transmission for the soft-coral translucent look, and subtle
//               sheen for the wet mucus layer) plus real-time anime
//               stylization: cel-banded coral highlights, polyp-pit
//               approximation, mood tinting, rim glow, and per-instance
//               variation. Includes a procedural coral-polyp texture generator
//               using jittered Voronoi F1 cells for polyp pits, multi-octave
//               fBm for overall coral tone, and per-polyp hashing for colour
//               variance.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Organic coral, coral reef, staghorn coral, brain coral, soft
//            coral, sea-fan coral, bleached coral, reef-building organisms,
//            aquarium decor, underwater scenes, and any coral surface that
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
// Coral presets — biologically grounded PBR parameter sets for coral types.
//
// Reference values (from coral reef PBR references, aquarium coral texture
// packs, and marine biology literature):
//   - Coral IOR:              ≈ 1.45 (aragonite + organic tissue)
//   - Coral roughness:        0.40–0.70 (wet coral)
//   - Metalness:              0.0 (coral is a dielectric)
//   - Soft coral transmission: 0.10–0.20 (thin translucent tissue)
//   - Sheen:                  subtle wet mucus layer at grazing angles
//   - Bleached coral:         near-white, higher roughness, no transmission
// ---------------------------------------------------------------------------

const OrganicCoralPresets = {
    'staghorn-coral': {
        color: [0.78, 0.52, 0.42],
        roughness: 0.55,
        metalness: 0.0,
        transmission: 0.08,
        thickness: 0.005,
        attenuationDistance: 0.08,
        attenuationColor: [0.82, 0.58, 0.45],
        sheen: 0.25,
        sheenColor: [0.88, 0.68, 0.58],
        sheenRoughness: 0.55,
        specularIntensity: 0.40,
        specularColor: [0.90, 0.78, 0.70]
    },
    'brain-coral': {
        color: [0.72, 0.62, 0.38],
        roughness: 0.62,
        metalness: 0.0,
        transmission: 0.05,
        thickness: 0.008,
        attenuationDistance: 0.10,
        attenuationColor: [0.78, 0.68, 0.42],
        sheen: 0.22,
        sheenColor: [0.85, 0.78, 0.55],
        sheenRoughness: 0.60,
        specularIntensity: 0.35,
        specularColor: [0.85, 0.82, 0.65]
    },
    'soft-coral': {
        color: [0.82, 0.38, 0.52],
        roughness: 0.48,
        metalness: 0.0,
        transmission: 0.18,
        thickness: 0.003,
        attenuationDistance: 0.06,
        attenuationColor: [0.88, 0.45, 0.58],
        sheen: 0.35,
        sheenColor: [0.92, 0.55, 0.65],
        sheenRoughness: 0.45,
        specularIntensity: 0.45,
        specularColor: [0.92, 0.68, 0.75]
    },
    'sea-fan-coral': {
        color: [0.58, 0.38, 0.72],
        roughness: 0.52,
        metalness: 0.0,
        transmission: 0.12,
        thickness: 0.002,
        attenuationDistance: 0.07,
        attenuationColor: [0.62, 0.42, 0.78],
        sheen: 0.30,
        sheenColor: [0.72, 0.55, 0.88],
        sheenRoughness: 0.50,
        specularIntensity: 0.42,
        specularColor: [0.82, 0.70, 0.92]
    },
    'bleached-coral': {
        color: [0.92, 0.90, 0.88],
        roughness: 0.70,
        metalness: 0.0,
        transmission: 0.02,
        thickness: 0.005,
        attenuationDistance: 0.08,
        attenuationColor: [0.95, 0.93, 0.90],
        sheen: 0.15,
        sheenColor: [0.95, 0.93, 0.90],
        sheenRoughness: 0.70,
        specularIntensity: 0.30,
        specularColor: [0.92, 0.90, 0.88]
    },
    'fire-coral': {
        color: [0.88, 0.28, 0.18],
        roughness: 0.50,
        metalness: 0.0,
        transmission: 0.10,
        thickness: 0.004,
        attenuationDistance: 0.07,
        attenuationColor: [0.92, 0.35, 0.22],
        sheen: 0.28,
        sheenColor: [0.95, 0.45, 0.32],
        sheenRoughness: 0.52,
        specularIntensity: 0.44,
        specularColor: [0.95, 0.68, 0.58]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable coral scratch records
// ---------------------------------------------------------------------------

class CoralScratchPool {
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

const _coralScratchPool = new CoralScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — coral-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded coral highlights. Coral has soft, organic shading with a
 * subtle wet sheen — quantizing it into discrete bands produces the crisp
 * anime coral edges seen in hand-drawn underwater and reef illustrations.
 */
function applyCoralCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to coral. Warm moods push coral toward a warm
 * ochre/pink, cool moods toward a cool cyan/purple — matching the atmospheric
 * coral tinting seen in stylized underwater scenes.
 */
function gradeCoralColor(color, temperature, saturation, brightness, contrast) {
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

    // Coral-specific temperature bias: warm shift pushes toward ochre/pink,
    // cool shift pushes toward cyan/purple.
    r += temperature * 0.04;
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
 * Generate a procedural coral-polyp texture. The algorithm:
 * 1. Jittered Voronoi cells: place jittered seeds in a 3x3 neighbourhood,
 *    compute F1 distance to the nearest seed — the cell centre is the polyp
 *    pit, and the F2-F1 difference gives the cell boundary.
 * 2. Polyp-pit profile: a smooth power function on F1 produces the concave
 *    polyp depression.
 * 3. Multi-octave fBm for the overall coral body tone.
 * 4. Per-polyp hashing for colour variation between polyps.
 * 5. Fine mottle for micro-surface texture.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateCoralPolypTexture(width, height, polypCells = 28, polypSharpness = 2.0, polypDepth = 0.35, bodyStrength = 0.25, mottleStrength = 0.06) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Jittered Voronoi polyp cells ---
            const vx = (x / width) * polypCells;
            const vy = (y / height) * polypCells;
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

            // --- 2. Polyp-pit profile (concave depression at cell centre) ---
            const polyp = Math.pow(Math.max(0, 1.0 - f1), polypSharpness) * polypDepth;

            // --- 3. Multi-octave fBm body tone ---
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

            // --- 4. Per-polyp hashing ---
            const polypHash = Math.abs(Math.sin(f1Id * 12.9898) * 43758.5453) % 1.0;
            const polypTint = 0.85 + polypHash * 0.15;

            // --- 5. Fine mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.7, y * 0.7) * mottleStrength;

            // --- Combine ---
            let value = 0.45
                - polyp * 0.60
                + (fbm - 0.5) * bodyStrength
                + polypTint * 0.10
                + mottle;

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

const _coralWorld = BitECS.createWorld();
const OrganicCoralMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    coralBands: 'ui8',
    coralQuantize: 'f64',
    coralSoftness: 'f64',
    polypDepth: 'f64',
    bodyStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicCoralMaterialBatch {
    constructor() {
        this.world = _coralWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicCoralMaterialComponent, eid);
        OrganicCoralMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicCoralMaterialComponent.coralBands[eid] = material.coralBands;
        OrganicCoralMaterialComponent.coralQuantize[eid] = material.coralQuantize;
        OrganicCoralMaterialComponent.coralSoftness[eid] = material.coralSoftness;
        OrganicCoralMaterialComponent.polypDepth[eid] = material.polypDepth;
        OrganicCoralMaterialComponent.bodyStrength[eid] = material.bodyStrength;
        OrganicCoralMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicCoralMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicCoralMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicCoralMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicCoralMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicCoralMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicCoralMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicCoralMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.coralBands = OrganicCoralMaterialComponent.coralBands[eid];
            material.coralQuantize = OrganicCoralMaterialComponent.coralQuantize[eid];
            material.coralSoftness = OrganicCoralMaterialComponent.coralSoftness[eid];
            material.polypDepth = OrganicCoralMaterialComponent.polypDepth[eid];
            material.bodyStrength = OrganicCoralMaterialComponent.bodyStrength[eid];
            material.moodTemperature = OrganicCoralMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicCoralMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicCoralMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicCoralMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicCoralMaterialComponent.rimGlow[eid];
            material.variationSeed = OrganicCoralMaterialComponent.variationSeed[eid];

            OrganicCoralMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicCoralMaterial class
// ---------------------------------------------------------------------------

class OrganicCoralMaterial extends MeshPhysicalMaterial {
    static {
        _coralScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicCoralMaterial = true;
        this.type = 'OrganicCoralMaterial';

        // -------------------------------------------------------------------
        // Coral-specific PBR defaults (staghorn coral baseline)
        // -------------------------------------------------------------------
        this.ior = 1.45;
        this.specularIntensity = 0.40;
        this.roughness = 0.55;
        this.metalness = 0.0;
        this.specularColor = new Color(0.90, 0.78, 0.70);
        this.color = new Color(0.78, 0.52, 0.42);

        // Thin-walled transmission for the soft-coral translucent tissue
        this.transmission = 0.08;
        this.thickness = 0.005;
        this.attenuationDistance = 0.08;
        this.attenuationColor = new Color(0.82, 0.58, 0.45);

        // Sheen for the wet mucus layer
        this.sheen = 0.25;
        this.sheenColor = new Color(0.88, 0.68, 0.58);
        this.sheenRoughness = 0.55;

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — coral-specific
        // -------------------------------------------------------------------
        this.coralBands = 3;
        this.coralQuantize = 0.4;
        this.coralSoftness = 0.15;
        this.polypDepth = 0.35;
        this.bodyStrength = 0.25;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(0.85, 0.75, 0.95);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (coral leans semi-realistic)
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

    applyCoralBanding(baseColor, output) {
        return applyCoralCelBanding(
            baseColor,
            output,
            this.coralBands,
            this.coralQuantize,
            this.coralSoftness
        );
    }

    updateMoodColor() {
        gradeCoralColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic coral preset to this material.
     * @param {string} presetName - One of the keys of `OrganicCoralPresets`.
     * @returns {OrganicCoralMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicCoralPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.transmission = preset.transmission;
        this.thickness = preset.thickness;
        this.attenuationDistance = preset.attenuationDistance;
        this.attenuationColor.setRGB(preset.attenuationColor[0], preset.attenuationColor[1], preset.attenuationColor[2], ColorManagement.workingColorSpace);
        this.sheen = preset.sheen;
        this.sheenColor.setRGB(preset.sheenColor[0], preset.sheenColor[1], preset.sheenColor[2], ColorManagement.workingColorSpace);
        this.sheenRoughness = preset.sheenRoughness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness per preset
        if (presetName === 'soft-coral' || presetName === 'sea-fan-coral') {
            this.coralSoftness = 0.20;
            this.coralBands = 2;
        } else if (presetName === 'brain-coral') {
            this.coralSoftness = 0.25;
            this.coralBands = 2;
        } else {
            this.coralSoftness = 0.15;
            this.coralBands = 3;
        }

        this.updateMoodColor();
        return this;
    }

    generateCoralPolypTexture(width, height, polypCells = 28, polypSharpness = 2.0, polypDepth = 0.35, bodyStrength = 0.25) {
        return generateCoralPolypTexture(width, height, polypCells, polypSharpness, polypDepth, bodyStrength, 0.06);
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

        shader.uniforms.coralBands = { value: this.coralBands };
        shader.uniforms.coralQuantize = { value: this.coralQuantize };
        shader.uniforms.coralSoftness = { value: this.coralSoftness };
        shader.uniforms.polypDepth = { value: this.polypDepth };
        shader.uniforms.bodyStrength = { value: this.bodyStrength };
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
                uniform int coralBands;
                uniform float coralQuantize;
                uniform float coralSoftness;
                uniform float polypDepth;
                uniform float bodyStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyCoralBands(vec3 baseColor) {
                    if (coralBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(coralBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * coralSoftness;
                    float finalLum = mix(lum, softQuantized, coralQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply coral cel banding
                gl_FragColor.rgb = applyCoralBands(gl_FragColor.rgb);

                // Polyp-pit approximation: subtle darkening in a Voronoi-like pattern
                if (polypDepth > 0.0) {
                    vec2 polypUV = vUv * 28.0;
                    vec2 polypCell = floor(polypUV);
                    vec2 polypFrac = fract(polypUV);
                    float polypHash = fract(sin(dot(polypCell, vec2(12.9898, 78.233))) * 43758.5453);
                    // Offset the cell centre by hash for jitter
                    vec2 polypCentre = vec2(polypHash, fract(polypHash * 7.31));
                    float polypDist = length(polypFrac - polypCentre);
                    float polypMask = pow(max(0.0, 1.0 - polypDist * 2.0), 2.0);
                    gl_FragColor.rgb *= (1.0 - polypMask * polypDepth * 0.6);
                }

                // Cool-tinted rim glow on coral edges
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
            this.transmission, this.thickness, this.attenuationDistance,
            this.sheen, this.sheenRoughness,
            this.coralBands, this.coralQuantize, this.coralSoftness,
            this.polypDepth, this.bodyStrength,
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
        this.transmission = source.transmission;
        this.thickness = source.thickness;
        this.attenuationDistance = source.attenuationDistance;
        this.attenuationColor.copy(source.attenuationColor);
        this.sheen = source.sheen;
        this.sheenColor.copy(source.sheenColor);
        this.sheenRoughness = source.sheenRoughness;
        this.coralBands = source.coralBands;
        this.coralQuantize = source.coralQuantize;
        this.coralSoftness = source.coralSoftness;
        this.polypDepth = source.polypDepth;
        this.bodyStrength = source.bodyStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicCoralMaterial';
        if (this.ior !== 1.45) data.ior = this.ior;
        if (this.specularIntensity !== 0.40) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.55) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.transmission !== 0.08) data.transmission = this.transmission;
        if (this.thickness !== 0.005) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.08) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.82, 0.58, 0.45).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.25) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.88, 0.68, 0.58).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.55) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.90, 0.78, 0.70).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.coralBands !== 3) data.coralBands = this.coralBands;
        if (this.coralQuantize !== 0.4) data.coralQuantize = this.coralQuantize;
        if (this.coralSoftness !== 0.15) data.coralSoftness = this.coralSoftness;
        if (this.polypDepth !== 0.35) data.polypDepth = this.polypDepth;
        if (this.bodyStrength !== 0.25) data.bodyStrength = this.bodyStrength;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.85, 0.75, 0.95).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.transmission = json.transmission ?? this.transmission;
        this.thickness = json.thickness ?? this.thickness;
        this.attenuationDistance = json.attenuationDistance ?? this.attenuationDistance;
        if (json.attenuationColor !== undefined) this.attenuationColor.setHex(json.attenuationColor);
        this.sheen = json.sheen ?? this.sheen;
        if (json.sheenColor !== undefined) this.sheenColor.setHex(json.sheenColor);
        this.sheenRoughness = json.sheenRoughness ?? this.sheenRoughness;
        this.coralBands = json.coralBands ?? this.coralBands;
        this.coralQuantize = json.coralQuantize ?? this.coralQuantize;
        this.coralSoftness = json.coralSoftness ?? this.coralSoftness;
        this.polypDepth = json.polypDepth ?? this.polypDepth;
        this.bodyStrength = json.bodyStrength ?? this.bodyStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicCoralMaterialBatchComponent = {
    materialPtr: 'ui32',
    coralBands: 'ui8',
    coralQuantize: 'f64',
    coralSoftness: 'f64',
    polypDepth: 'f64',
    bodyStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    OrganicCoralMaterial,
    OrganicCoralMaterialBatch,
    CoralScratchPool,
    OrganicCoralMaterialBatchComponent,
    OrganicCoralPresets,
    applyCoralCelBanding,
    gradeCoralColor,
    generateCoralPolypTexture
};

export default OrganicCoralMaterial;