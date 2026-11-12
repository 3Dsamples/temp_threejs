// file number : 216
// full path name : src/materials/216_organicleafmaterial.js
// description : OrganicLeafMaterial — a ready-to-use leaf material for foliage,
//               leaves, and plant canopies. Extends MeshPhysicalMaterial with
//               purpose-built presets for spring-green, summer-green, autumn-
//               red, autumn-orange, tropical, and evergreen leaves. Includes
//               leaf-appropriate PBR defaults (zero metalness, roughness
//               0.15–0.35 for healthy leaves, thin-walled transmission for
//               leaf translucency, sheen for waxy cuticle highlights) plus
//               real-time anime stylization: cel-banded leaf highlights, vein
//               darkening, mood tinting, rim glow, and per-instance variation.
//               Includes a procedural leaf-vein texture generator using
//               Voronoi-style F1 distance for vein ridges, multi-octave fBm
//               for clump shading, and per-vein hashing for organic variation.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Organic leaves, foliage, plant canopies, shrubs, hedges, vines,
//            tropical plants, autumn foliage, and any leaf surface that needs
//            real-time PBR + anime stylization.
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
// Leaf presets — biologically grounded PBR parameter sets for leaf types.
//
// Reference values (from foliage PBR guides, three.js leaf references, and
// botanical literature):
//   - Healthy summer foliage roughness: 0.09–0.12
//   - Autumn foliage roughness:         0.15–0.30
//   - Waxy cuticle produces subtle directional specular
//   - Leaf translucency weight:         0.30–0.50
//   - Metalness:                        0.0 (leaves are dielectrics)
//   - IOR (leaf cuticle):               ≈ 1.42
// ---------------------------------------------------------------------------

const OrganicLeafPresets = {
    'spring-green': {
        color: [0.42, 0.62, 0.24],
        roughness: 0.14,
        metalness: 0.0,
        transmission: 0.38,
        thickness: 0.001,
        attenuationDistance: 8.0,
        attenuationColor: [0.55, 0.78, 0.35],
        sheen: 0.42,
        sheenColor: [0.62, 0.80, 0.44],
        sheenRoughness: 0.55,
        specularIntensity: 0.40,
        specularColor: [0.70, 0.82, 0.55]
    },
    'summer-green': {
        color: [0.28, 0.48, 0.16],
        roughness: 0.12,
        metalness: 0.0,
        transmission: 0.35,
        thickness: 0.001,
        attenuationDistance: 7.0,
        attenuationColor: [0.45, 0.68, 0.28],
        sheen: 0.45,
        sheenColor: [0.55, 0.72, 0.35],
        sheenRoughness: 0.60,
        specularIntensity: 0.42,
        specularColor: [0.65, 0.78, 0.48]
    },
    'autumn-red': {
        color: [0.68, 0.22, 0.14],
        roughness: 0.24,
        metalness: 0.0,
        transmission: 0.32,
        thickness: 0.001,
        attenuationDistance: 6.0,
        attenuationColor: [0.82, 0.32, 0.18],
        sheen: 0.30,
        sheenColor: [0.88, 0.45, 0.25],
        sheenRoughness: 0.65,
        specularIntensity: 0.35,
        specularColor: [0.85, 0.55, 0.40]
    },
    'autumn-orange': {
        color: [0.82, 0.48, 0.16],
        roughness: 0.22,
        metalness: 0.0,
        transmission: 0.34,
        thickness: 0.001,
        attenuationDistance: 6.5,
        attenuationColor: [0.92, 0.62, 0.25],
        sheen: 0.32,
        sheenColor: [0.95, 0.65, 0.30],
        sheenRoughness: 0.60,
        specularIntensity: 0.38,
        specularColor: [0.90, 0.72, 0.45]
    },
    'tropical': {
        color: [0.18, 0.42, 0.18],
        roughness: 0.10,
        metalness: 0.0,
        transmission: 0.40,
        thickness: 0.002,
        attenuationDistance: 10.0,
        attenuationColor: [0.35, 0.65, 0.30],
        sheen: 0.55,
        sheenColor: [0.50, 0.75, 0.40],
        sheenRoughness: 0.50,
        specularIntensity: 0.48,
        specularColor: [0.60, 0.78, 0.50]
    },
    'evergreen': {
        color: [0.16, 0.32, 0.14],
        roughness: 0.18,
        metalness: 0.0,
        transmission: 0.28,
        thickness: 0.001,
        attenuationDistance: 6.0,
        attenuationColor: [0.28, 0.52, 0.22],
        sheen: 0.38,
        sheenColor: [0.42, 0.62, 0.32],
        sheenRoughness: 0.60,
        specularIntensity: 0.38,
        specularColor: [0.55, 0.70, 0.42]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable leaf scratch records
// ---------------------------------------------------------------------------

class LeafScratchPool {
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

const _leafScratchPool = new LeafScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — leaf-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded leaf highlights. Leaves have soft, organic shading with a
 * subtle waxy specular — quantizing it into discrete bands produces the crisp
 * anime leaf edges seen in hand-drawn nature scenes.
 */
function applyLeafCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.12) {
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
 * Apply mood-based tinting to leaves. Warm moods push leaves toward a warmer
 * autumn-gold, cool moods toward a cool deep green — matching the atmospheric
 * foliage tinting seen in nature anime backgrounds.
 */
function gradeLeafColor(color, temperature, saturation, brightness, contrast) {
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

    // Leaf-specific temperature bias: warm shift pushes toward gold/amber,
    // cool shift pushes toward deep forest green.
    r += temperature * 0.04;
    g += temperature * 0.02;
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
 * Generate a procedural leaf-vein texture. The algorithm:
 * 1. Domain-warp the UV with low-frequency fBm for organic wobble.
 * 2. Voronoi-style F1 distance for the vein network: place jittered seed
 *    points in a grid, compute F1 (nearest) and F2 (second-nearest) distances,
 *    use the F2-F1 difference to extract thin vein lines.
 * 3. Multi-octave fBm for large-scale leaf-clump shading.
 * 4. Per-vein hashing for organic variation between vein segments.
 * 5. Fine mottle for leaf-to-leaf micro-variation.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map derivation.
 */
function generateLeafVeinTexture(width, height, scale = 0.02, octaves = 4, veinCells = 6, veinSharpness = 3.0, warpStrength = 1.5, clumpStrength = 0.25) {
    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Domain warp ---
            const warpX = SimplexNoise.noise2D(x * 0.008, y * 0.008) * warpStrength;
            const warpY = SimplexNoise.noise2D(x * 0.008 + 100, y * 0.008 + 100) * warpStrength;

            // --- 2. Voronoi-style vein network ---
            const vx = (x + warpX) * 0.02 * veinCells;
            const vy = (y + warpY) * 0.02 * veinCells;
            const cellX = Math.floor(vx);
            const cellY = Math.floor(vy);

            let f1 = 1e9;
            let f2 = 1e9;
            let f1Id = 0;

            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    const nx = cellX + ox;
                    const ny = cellY + oy;
                    const h = Math.sin(nx * 127.1 + ny * 311.7) * 43758.5453;
                    const jx = h - Math.floor(h);
                    const h2 = Math.sin(nx * 269.5 + ny * 183.3) * 43758.5453;
                    const jy = h2 - Math.floor(h2);
                    const dx = vx - (nx + jx);
                    const dy = vy - (ny + jy);
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < f1) {
                        f2 = f1;
                        f1 = d;
                        f1Id = nx * 73856093 ^ ny * 19349663;
                    } else if (d < f2) {
                        f2 = d;
                    }
                }
            }

            const cellBorder = f2 - f1;
            const veinRidge = Math.pow(Math.max(0, Math.min(1, cellBorder)), 1.0 / veinSharpness);

            // --- 3. Canopy-clump fBm ---
            let clump = 0;
            let amplitude = 1;
            let frequency = scale * 0.5;
            let maxAmplitude = 0;
            for (let o = 0; o < octaves; o++) {
                clump += SimplexNoise.noise2D(x * frequency, y * frequency) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }
            clump = (clump / maxAmplitude) * 0.5 + 0.5;

            // --- 4. Per-vein hash ---
            const veinHash = Math.abs(Math.sin(f1Id * 12.9898) * 43758.5453) % 1.0;
            const veinTint = 1.0 - 0.3 * 0.5 + veinHash * 0.3;

            // --- 5. Fine mottle ---
            const mottle = SimplexNoise.noise2D(x * 0.6, y * 0.6) * 0.05;

            // --- Combine ---
            let value = 0.55
                + (clump - 0.5) * clumpStrength
                + veinRidge * 0.25 * veinTint
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

const _leafWorld = BitECS.createWorld();
const OrganicLeafMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    leafBands: 'ui8',
    leafQuantize: 'f64',
    leafSoftness: 'f64',
    veinDarkening: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    paperGrain: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class OrganicLeafMaterialBatch {
    constructor() {
        this.world = _leafWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, OrganicLeafMaterialComponent, eid);
        OrganicLeafMaterialComponent.materialPtr[eid] = this.materials.length;
        OrganicLeafMaterialComponent.leafBands[eid] = material.leafBands;
        OrganicLeafMaterialComponent.leafQuantize[eid] = material.leafQuantize;
        OrganicLeafMaterialComponent.leafSoftness[eid] = material.leafSoftness;
        OrganicLeafMaterialComponent.veinDarkening[eid] = material.veinDarkening;
        OrganicLeafMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        OrganicLeafMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        OrganicLeafMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        OrganicLeafMaterialComponent.moodContrast[eid] = material.moodContrast;
        OrganicLeafMaterialComponent.rimGlow[eid] = material.rimGlow;
        OrganicLeafMaterialComponent.paperGrain[eid] = material.paperGrain;
        OrganicLeafMaterialComponent.variationSeed[eid] = material.variationSeed;
        OrganicLeafMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[OrganicLeafMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.leafBands = OrganicLeafMaterialComponent.leafBands[eid];
            material.leafQuantize = OrganicLeafMaterialComponent.leafQuantize[eid];
            material.leafSoftness = OrganicLeafMaterialComponent.leafSoftness[eid];
            material.veinDarkening = OrganicLeafMaterialComponent.veinDarkening[eid];
            material.moodTemperature = OrganicLeafMaterialComponent.moodTemperature[eid];
            material.moodSaturation = OrganicLeafMaterialComponent.moodSaturation[eid];
            material.moodBrightness = OrganicLeafMaterialComponent.moodBrightness[eid];
            material.moodContrast = OrganicLeafMaterialComponent.moodContrast[eid];
            material.rimGlow = OrganicLeafMaterialComponent.rimGlow[eid];
            material.paperGrain = OrganicLeafMaterialComponent.paperGrain[eid];
            material.variationSeed = OrganicLeafMaterialComponent.variationSeed[eid];

            OrganicLeafMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main OrganicLeafMaterial class
// ---------------------------------------------------------------------------

class OrganicLeafMaterial extends MeshPhysicalMaterial {
    static {
        _leafScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isOrganicLeafMaterial = true;
        this.type = 'OrganicLeafMaterial';

        // -------------------------------------------------------------------
        // Leaf-specific PBR defaults (summer-green baseline)
        // -------------------------------------------------------------------
        this.ior = 1.42;
        this.specularIntensity = 0.42;
        this.roughness = 0.12;
        this.metalness = 0.0;
        this.specularColor = new Color(0.65, 0.78, 0.48);
        this.color = new Color(0.28, 0.48, 0.16);

        // Thin-walled transmission for leaf translucency
        this.transmission = 0.35;
        this.thickness = 0.001;
        this.attenuationDistance = 7.0;
        this.attenuationColor = new Color(0.45, 0.68, 0.28);

        // Sheen for waxy cuticle highlights
        this.sheen = 0.45;
        this.sheenColor = new Color(0.55, 0.72, 0.35);
        this.sheenRoughness = 0.60;

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — leaf-specific
        // -------------------------------------------------------------------
        this.leafBands = 3;
        this.leafQuantize = 0.5;
        this.leafSoftness = 0.12;
        this.veinDarkening = 0.25;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.12;
        this.rimGlowColor = new Color(0.55, 0.78, 0.40);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (leaf leans semi-realistic)
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

    applyLeafBanding(baseColor, output) {
        return applyLeafCelBanding(
            baseColor,
            output,
            this.leafBands,
            this.leafQuantize,
            this.leafSoftness
        );
    }

    updateMoodColor() {
        gradeLeafColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named organic leaf preset to this material.
     * @param {string} presetName - One of the keys of `OrganicLeafPresets`.
     * @returns {OrganicLeafMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = OrganicLeafPresets[presetName];
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

        // Adjust anime band softness
        if (presetName === 'autumn-red' || presetName === 'autumn-orange') {
            this.leafSoftness = 0.20;
            this.leafBands = 2;
        } else if (presetName === 'tropical') {
            this.leafSoftness = 0.08;
            this.leafBands = 4;
        } else {
            this.leafSoftness = 0.12;
            this.leafBands = 3;
        }

        this.updateMoodColor();
        return this;
    }

    generateLeafVeinTexture(width, height, scale = 0.02, octaves = 4, veinCells = 6) {
        return generateLeafVeinTexture(width, height, scale, octaves, veinCells, 3.0, 1.5, 0.25);
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

        shader.uniforms.leafBands = { value: this.leafBands };
        shader.uniforms.leafQuantize = { value: this.leafQuantize };
        shader.uniforms.leafSoftness = { value: this.leafSoftness };
        shader.uniforms.veinDarkening = { value: this.veinDarkening };
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
                uniform int leafBands;
                uniform float leafQuantize;
                uniform float leafSoftness;
                uniform float veinDarkening;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyLeafBands(vec3 baseColor) {
                    if (leafBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(leafBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * leafSoftness;
                    float finalLum = mix(lum, softQuantized, leafQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply leaf cel banding
                gl_FragColor.rgb = applyLeafBands(gl_FragColor.rgb);

                // Vein darkening: darken the leaf where veins would be
                // (approximated via UV-based radial/lattice pattern)
                if (veinDarkening > 0.0) {
                    vec2 veinUV = vUv * 8.0;
                    vec2 veinCell = floor(veinUV);
                    vec2 veinFrac = fract(veinUV);
                    float veinDist = min(min(veinFrac.x, 1.0 - veinFrac.x), min(veinFrac.y, 1.0 - veinFrac.y));
                    float veinMask = 1.0 - smoothstep(0.0, 0.05, veinDist);
                    gl_FragColor.rgb *= (1.0 - veinMask * veinDarkening);
                }

                // Green-tinted rim glow on leaf edges
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
            this.leafBands, this.leafQuantize, this.leafSoftness,
            this.veinDarkening,
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
        this.leafBands = source.leafBands;
        this.leafQuantize = source.leafQuantize;
        this.leafSoftness = source.leafSoftness;
        this.veinDarkening = source.veinDarkening;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'OrganicLeafMaterial';
        if (this.ior !== 1.42) data.ior = this.ior;
        if (this.specularIntensity !== 0.42) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.12) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.transmission !== 0.35) data.transmission = this.transmission;
        if (this.thickness !== 0.001) data.thickness = this.thickness;
        if (this.attenuationDistance !== 7.0) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.45, 0.68, 0.28).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.45) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(0.55, 0.72, 0.35).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.60) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(0.65, 0.78, 0.48).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.leafBands !== 3) data.leafBands = this.leafBands;
        if (this.leafQuantize !== 0.5) data.leafQuantize = this.leafQuantize;
        if (this.leafSoftness !== 0.12) data.leafSoftness = this.leafSoftness;
        if (this.veinDarkening !== 0.25) data.veinDarkening = this.veinDarkening;
        if (this.rimGlow !== 0.12) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.55, 0.78, 0.40).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.leafBands = json.leafBands ?? this.leafBands;
        this.leafQuantize = json.leafQuantize ?? this.leafQuantize;
        this.leafSoftness = json.leafSoftness ?? this.leafSoftness;
        this.veinDarkening = json.veinDarkening ?? this.veinDarkening;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const OrganicLeafMaterialBatchComponent = {
    materialPtr: 'ui32',
    leafBands: 'ui8',
    leafQuantize: 'f64',
    leafSoftness: 'f64',
    veinDarkening: 'f64',
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
    OrganicLeafMaterial,
    OrganicLeafMaterialBatch,
    LeafScratchPool,
    OrganicLeafMaterialBatchComponent,
    OrganicLeafPresets,
    applyLeafCelBanding,
    gradeLeafColor,
    generateLeafVeinTexture
};

export default OrganicLeafMaterial;