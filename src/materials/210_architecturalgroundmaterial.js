// file number : 210
// full path name : src/materials/210_architecturalgroundmaterial.js
// description : ArchitecturalGroundMaterial — a ready-to-use general-purpose
//               site-ground material for architectural visualization, focused
//               on exterior surfaces that are not specifically paved: packed
//               earth, decomposed granite, sand, mulch, and exposed soil.
//               Extends MeshPhysicalMaterial with purpose-built presets for
//               each ground type plus real-time anime stylization (cel-banded
//               ground highlights, mood tinting, rim glow, paper-grain texture,
//               watercolor bleed, and per-instance variation). Includes a
//               procedural granular-ground texture generator combining
//               multi-octave fBm with hashed grain, moisture patches, and
//               optional directional streaks for mulched surfaces.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Architectural site grounds, packed earth, decomposed granite, sand
//            beds, mulch beds, exposed soil, landscaping sub-surfaces, and any
//            granular exterior ground that needs real-time PBR + anime
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
// Ground presets — curated PBR parameter sets for common architectural ground
// types.
//
// Reference PBR values (from architectural ground/landscape guides):
//   - Packed earth:          roughness 0.92–0.96, warm mid-brown
//   - Decomposed granite:    roughness 0.90–0.94, warm grey-tan
//   - Sand:                  roughness 0.86–0.92, light warm cream
//   - Mulch:                 roughness 0.94–0.98, dark warm brown
//   - Exposed soil:          roughness 0.90–0.94, deep mid-brown
//   - All grounds are non-metallic (metalness = 0)
//   - Specular intensity is low (0.10–0.22) due to micro-roughness
// ---------------------------------------------------------------------------

const ArchitecturalGroundPresets = {
    'packed-earth': {
        color: [0.55, 0.44, 0.32],
        roughness: 0.94,
        metalness: 0.0,
        specularIntensity: 0.15,
        specularColor: [0.72, 0.62, 0.50]
    },
    'decomposed-granite': {
        color: [0.68, 0.60, 0.50],
        roughness: 0.92,
        metalness: 0.0,
        specularIntensity: 0.20,
        specularColor: [0.80, 0.74, 0.65]
    },
    'sand': {
        color: [0.86, 0.78, 0.62],
        roughness: 0.88,
        metalness: 0.0,
        specularIntensity: 0.22,
        specularColor: [0.92, 0.86, 0.74]
    },
    'mulch': {
        color: [0.32, 0.22, 0.14],
        roughness: 0.96,
        metalness: 0.0,
        specularIntensity: 0.10,
        specularColor: [0.55, 0.42, 0.28]
    },
    'exposed-soil': {
        color: [0.42, 0.30, 0.20],
        roughness: 0.92,
        metalness: 0.0,
        specularIntensity: 0.18,
        specularColor: [0.65, 0.50, 0.36]
    },
    'red-clay': {
        color: [0.58, 0.32, 0.22],
        roughness: 0.90,
        metalness: 0.0,
        specularIntensity: 0.22,
        specularColor: [0.78, 0.55, 0.42]
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable ground scratch records
// ---------------------------------------------------------------------------

class GroundScratchPool {
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

const _groundScratchPool = new GroundScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — ground-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded ground highlights. Ground surfaces have soft, low-frequency
 * shading — quantizing it into discrete bands produces the crisp anime
 * landscaping edges seen in hand-drawn architectural site plans and
 * perspective renderings.
 */
function applyGroundCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.2) {
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
 * Apply mood-based tinting to ground. Warm moods tint ground toward warm
 * ochre/tan, cool moods toward cool mauve-grey — matching the atmospheric
 * landscaping tinting seen in architectural anime backgrounds.
 */
function gradeGroundColor(color, temperature, saturation, brightness, contrast) {
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
 * Generate a procedural granular-ground texture. The algorithm combines:
 * 1. Multi-octave fBm for the large-scale moisture / composition patches.
 * 2. Fine hashed grain per integer cell for the granular aggregate look.
 * 3. Optional directional streaks (for mulched or raked ground).
 * 4. Optional moisture patches that darken the surface.
 * The output is a grayscale height/colour map suitable for albedo, roughness,
 * or bump-map use.
 */
function generateGroundPatternTexture(width, height, scale = 0.03, octaves = 4, grainStrength = 0.18, moistureStrength = 0.15, streakStrength = 0.0, streakAngle = 0.0) {
    const out = new Uint8Array(width * height * 4);

    // Pre-compute streak rotation
    const cosR = Math.cos(streakAngle);
    const sinR = Math.sin(streakAngle);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Multi-octave fBm (large-scale patches) ---
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

            // --- 2. Fine granular grain via per-cell hash ---
            const cellX = Math.floor(x * 0.7);
            const cellY = Math.floor(y * 0.7);
            const cellId = cellX * 73856093 ^ cellY * 19349663;
            const grainHash = Math.abs(Math.sin(cellId * 12.9898) * 43758.5453) % 1.0;
            const grain = (grainHash - 0.5) * grainStrength;

            // --- 3. Directional streaks (for rake/mulch texture) ---
            let streak = 0;
            if (streakStrength > 0) {
                const rx = x * cosR - y * sinR;
                const ry = x * sinR + y * cosR;
                const s = SimplexNoise.noise2D(rx * 0.02, ry * 0.15) * 0.5 + 0.5;
                streak = (s - 0.5) * streakStrength;
            }

            // --- 4. Moisture patches ---
            const moist = SimplexNoise.noise2D(x * 0.005, y * 0.005) * 0.5 + 0.5;
            const wet = Math.max(0, moist - 0.55) / 0.45 * moistureStrength;

            // --- Combine ---
            let value = 0.55 + (fbm - 0.5) * 0.25 + grain + streak - wet * 0.25;
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

const _groundWorld = BitECS.createWorld();
const ArchitecturalGroundMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    groundBands: 'ui8',
    groundQuantize: 'f64',
    groundSoftness: 'f64',
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

class ArchitecturalGroundMaterialBatch {
    constructor() {
        this.world = _groundWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ArchitecturalGroundMaterialComponent, eid);
        ArchitecturalGroundMaterialComponent.materialPtr[eid] = this.materials.length;
        ArchitecturalGroundMaterialComponent.groundBands[eid] = material.groundBands;
        ArchitecturalGroundMaterialComponent.groundQuantize[eid] = material.groundQuantize;
        ArchitecturalGroundMaterialComponent.groundSoftness[eid] = material.groundSoftness;
        ArchitecturalGroundMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ArchitecturalGroundMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ArchitecturalGroundMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ArchitecturalGroundMaterialComponent.moodContrast[eid] = material.moodContrast;
        ArchitecturalGroundMaterialComponent.rimGlow[eid] = material.rimGlow;
        ArchitecturalGroundMaterialComponent.paperGrain[eid] = material.paperGrain;
        ArchitecturalGroundMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ArchitecturalGroundMaterialComponent.variationSeed[eid] = material.variationSeed;
        ArchitecturalGroundMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ArchitecturalGroundMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.groundBands = ArchitecturalGroundMaterialComponent.groundBands[eid];
            material.groundQuantize = ArchitecturalGroundMaterialComponent.groundQuantize[eid];
            material.groundSoftness = ArchitecturalGroundMaterialComponent.groundSoftness[eid];
            material.moodTemperature = ArchitecturalGroundMaterialComponent.moodTemperature[eid];
            material.moodSaturation = ArchitecturalGroundMaterialComponent.moodSaturation[eid];
            material.moodBrightness = ArchitecturalGroundMaterialComponent.moodBrightness[eid];
            material.moodContrast = ArchitecturalGroundMaterialComponent.moodContrast[eid];
            material.rimGlow = ArchitecturalGroundMaterialComponent.rimGlow[eid];
            material.paperGrain = ArchitecturalGroundMaterialComponent.paperGrain[eid];
            material.watercolorBleed = ArchitecturalGroundMaterialComponent.watercolorBleed[eid];
            material.variationSeed = ArchitecturalGroundMaterialComponent.variationSeed[eid];

            ArchitecturalGroundMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main ArchitecturalGroundMaterial class
// ---------------------------------------------------------------------------

class ArchitecturalGroundMaterial extends MeshPhysicalMaterial {
    static {
        _groundScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isArchitecturalGroundMaterial = true;
        this.type = 'ArchitecturalGroundMaterial';

        // -------------------------------------------------------------------
        // Ground-specific PBR defaults (packed earth baseline)
        // -------------------------------------------------------------------
        this.ior = 1.45;
        this.specularIntensity = 0.15;
        this.roughness = 0.94;
        this.metalness = 0.0;
        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;
        this.specularColor = new Color(0.72, 0.62, 0.50);
        this.color = new Color(0.55, 0.44, 0.32);
        this.sheen = 0.0;
        this.sheenColor = new Color(0x000000);
        this.sheenRoughness = 0.5;
        this.transmission = 0.0;
        this.thickness = 0.0;
        this.attenuationDistance = Infinity;
        this.attenuationColor = new Color(0xffffff);

        // -------------------------------------------------------------------
        // Anime rendering extensions — ground-specific
        // -------------------------------------------------------------------
        this.groundBands = 2;
        this.groundQuantize = 0.4;
        this.groundSoftness = 0.25;
        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.06;
        this.rimGlowColor = new Color(0.88, 0.80, 0.68);
        this.paperGrain = 0;
        this.watercolorBleed = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (ground leans semi-realistic)
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

    applyGroundBanding(baseColor, output) {
        return applyGroundCelBanding(
            baseColor,
            output,
            this.groundBands,
            this.groundQuantize,
            this.groundSoftness
        );
    }

    updateMoodColor() {
        gradeGroundColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named architectural ground preset to this material.
     * @param {string} presetName - One of the keys of `ArchitecturalGroundPresets`.
     * @returns {ArchitecturalGroundMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = ArchitecturalGroundPresets[presetName];
        if (!preset) return this;

        this.color.setRGB(preset.color[0], preset.color[1], preset.color[2], ColorManagement.workingColorSpace);
        this.roughness = preset.roughness;
        this.metalness = preset.metalness;
        this.specularIntensity = preset.specularIntensity;
        this.specularColor.setRGB(preset.specularColor[0], preset.specularColor[1], preset.specularColor[2], ColorManagement.workingColorSpace);

        // Adjust anime band softness
        if (presetName === 'mulch') {
            this.groundSoftness = 0.35;
            this.groundBands = 2;
        } else if (presetName === 'sand') {
            this.groundSoftness = 0.20;
            this.groundBands = 3;
        } else {
            this.groundSoftness = 0.28;
            this.groundBands = 2;
        }

        this.updateMoodColor();
        return this;
    }

    generateGroundPatternTexture(width, height, scale = 0.03, octaves = 4, grainStrength = 0.18, moistureStrength = 0.15, streakStrength = 0.0, streakAngle = 0.0) {
        return generateGroundPatternTexture(width, height, scale, octaves, grainStrength, moistureStrength, streakStrength, streakAngle);
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

        shader.uniforms.groundBands = { value: this.groundBands };
        shader.uniforms.groundQuantize = { value: this.groundQuantize };
        shader.uniforms.groundSoftness = { value: this.groundSoftness };
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
                uniform int groundBands;
                uniform float groundQuantize;
                uniform float groundSoftness;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyGroundBands(vec3 baseColor) {
                    if (groundBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(groundBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * groundSoftness;
                    float finalLum = mix(lum, softQuantized, groundQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply ground cel banding
                gl_FragColor.rgb = applyGroundBands(gl_FragColor.rgb);

                // Warm-neutral rim glow on ground edges
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
            this.groundBands, this.groundQuantize, this.groundSoftness,
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
        this.groundBands = source.groundBands;
        this.groundQuantize = source.groundQuantize;
        this.groundSoftness = source.groundSoftness;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'ArchitecturalGroundMaterial';
        if (this.ior !== 1.45) data.ior = this.ior;
        if (this.specularIntensity !== 0.15) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.94) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.specularColor.getHex() !== new Color(0.72, 0.62, 0.50).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.groundBands !== 2) data.groundBands = this.groundBands;
        if (this.groundQuantize !== 0.4) data.groundQuantize = this.groundQuantize;
        if (this.groundSoftness !== 0.25) data.groundSoftness = this.groundSoftness;
        if (this.rimGlow !== 0.06) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.88, 0.80, 0.68).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.groundBands = json.groundBands ?? this.groundBands;
        this.groundQuantize = json.groundQuantize ?? this.groundQuantize;
        this.groundSoftness = json.groundSoftness ?? this.groundSoftness;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const ArchitecturalGroundMaterialBatchComponent = {
    materialPtr: 'ui32',
    groundBands: 'ui8',
    groundQuantize: 'f64',
    groundSoftness: 'f64',
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
    ArchitecturalGroundMaterial,
    ArchitecturalGroundMaterialBatch,
    GroundScratchPool,
    ArchitecturalGroundMaterialBatchComponent,
    ArchitecturalGroundPresets,
    applyGroundCelBanding,
    gradeGroundColor,
    generateGroundPatternTexture
};

export default ArchitecturalGroundMaterial;