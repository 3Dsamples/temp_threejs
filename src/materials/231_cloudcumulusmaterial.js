// file number : 231
// full path name : src/materials/231_cloudcumulusmaterial.js
// description : CloudCumulusMaterial — a ready-to-use cumulus cloud material
//               for real-time sky and volumetric-cloud rendering. Extends
//               MeshPhysicalMaterial with purpose-built presets for puffy
//               daytime cumulus, towering cumulonimbus, sunset-lit cumulus,
//               storm cumulus, thin fair-weather cumulus, and volumetric
//               anime-style cumulus. Includes physically grounded defaults
//               (cloud IOR ≈ 1.0003, roughness 0.65–0.90 for billowy soft
//               scattering, zero metalness, thin-walled transmission for the
//               forward-scattered light through cloud edges, attenuation
//               colour for realistic multi-scattering falloff, and sheen for
//               the bright silver-lining rim) plus real-time anime
//               stylization: cel-banded cloud highlights, powder/silver-lining
//               approximation, mood tinting (sunset-orange / snowy-cyan /
//               storm-grey), rim glow, and per-instance variation. Includes a
//               procedural cumulus-density texture generator using
//               Perlin-Worley fBm with billowy domain-warp, cloud-boundary
//               erosion, and optional precipitation mask.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : Cumulus clouds, cumulonimbus, fair-weather puffy clouds, storm
//            clouds, sunset-lit clouds, anime sky backgrounds, Ghibli-style
//            cloudscapes, mobile sky systems, and any cumulus cloud surface
//            that needs real-time PBR + anime stylization.
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
// Cumulus cloud presets — physically grounded PBR parameter sets for cloud
// types.
//
// Reference values (from real-time volumetric cloud references: Nubis Evolved
// by Guerrilla Games, three-volumetric-clouds, Universal Planetary Volumetric
// Cloud engine, and Unreal Engine Volumetric Cloud Component):
//   - Cloud IOR:                  ≈ 1.0003 (near-vacuum; clouds are volumes)
//   - Cloud roughness:            0.65–0.90 (billowy soft scattering)
//   - Metalness:                  0.0 (clouds are dielectric volumes)
//   - Transmission:               0.30–0.55 for forward-scattered edge light
//   - Attenuation distance:       0.05–0.15 (multi-scattering falloff)
//   - Attenuation colour:         warm-white to cool-grey depending on type
//   - Sheen (silver-lining):      0.40–0.80 at grazing silhouette edges
//   - Powder effect:              strong for dense cumulus cores, weak for thin
//                                 fair-weather clouds
//   - Anisotropy g (Henyey-Greenstein): ≈ 0.8 (forward scattering for water
//     droplets; matches cloud-droplet scattering as noted in PBR references)
// ---------------------------------------------------------------------------

const CloudCumulusPresets = {
    'fair-weather-cumulus': {
        color: [0.96, 0.96, 0.94],
        roughness: 0.88,
        metalness: 0.0,
        transmission: 0.42,
        thickness: 0.20,
        attenuationDistance: 0.10,
        attenuationColor: [0.94, 0.95, 0.98],
        sheen: 0.55,
        sheenColor: [1.0, 0.99, 0.96],
        sheenRoughness: 0.35,
        specularIntensity: 0.35,
        specularColor: [1.0, 1.0, 1.0],
        powderIntensity: 0.55,
        anisotropyG: 0.80
    },
    'puffy-daytime-cumulus': {
        color: [0.98, 0.97, 0.94],
        roughness: 0.82,
        metalness: 0.0,
        transmission: 0.46,
        thickness: 0.30,
        attenuationDistance: 0.12,
        attenuationColor: [0.96, 0.97, 1.0],
        sheen: 0.68,
        sheenColor: [1.0, 1.0, 0.98],
        sheenRoughness: 0.30,
        specularIntensity: 0.42,
        specularColor: [1.0, 1.0, 1.0],
        powderIntensity: 0.65,
        anisotropyG: 0.82
    },
    'towering-cumulonimbus': {
        color: [0.82, 0.84, 0.88],
        roughness: 0.90,
        metalness: 0.0,
        transmission: 0.30,
        thickness: 0.60,
        attenuationDistance: 0.08,
        attenuationColor: [0.85, 0.87, 0.92],
        sheen: 0.45,
        sheenColor: [0.92, 0.94, 1.0],
        sheenRoughness: 0.45,
        specularIntensity: 0.30,
        specularColor: [0.95, 0.96, 1.0],
        powderIntensity: 0.85,
        anisotropyG: 0.85
    },
    'sunset-lit-cumulus': {
        color: [0.98, 0.86, 0.72],
        roughness: 0.80,
        metalness: 0.0,
        transmission: 0.50,
        thickness: 0.25,
        attenuationDistance: 0.14,
        attenuationColor: [1.0, 0.82, 0.62],
        sheen: 0.72,
        sheenColor: [1.0, 0.88, 0.68],
        sheenRoughness: 0.28,
        specularIntensity: 0.48,
        specularColor: [1.0, 0.92, 0.78],
        powderIntensity: 0.60,
        anisotropyG: 0.80
    },
    'storm-cumulus': {
        color: [0.42, 0.44, 0.48],
        roughness: 0.92,
        metalness: 0.0,
        transmission: 0.22,
        thickness: 0.65,
        attenuationDistance: 0.06,
        attenuationColor: [0.48, 0.50, 0.55],
        sheen: 0.30,
        sheenColor: [0.65, 0.68, 0.75],
        sheenRoughness: 0.55,
        specularIntensity: 0.22,
        specularColor: [0.72, 0.75, 0.80],
        powderIntensity: 0.90,
        anisotropyG: 0.88
    },
    'anime-cumulus': {
        color: [1.0, 0.99, 0.96],
        roughness: 0.78,
        metalness: 0.0,
        transmission: 0.52,
        thickness: 0.30,
        attenuationDistance: 0.16,
        attenuationColor: [0.98, 0.98, 1.0],
        sheen: 0.78,
        sheenColor: [1.0, 1.0, 1.0],
        sheenRoughness: 0.25,
        specularIntensity: 0.50,
        specularColor: [1.0, 1.0, 1.0],
        powderIntensity: 0.70,
        anisotropyG: 0.80
    }
};

// ---------------------------------------------------------------------------
// Pool system — reusable cumulus scratch records
// ---------------------------------------------------------------------------

class CloudCumulusScratchPool {
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

const _cloudCumulusScratchPool = new CloudCumulusScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — cumulus-specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Apply cel-banded cumulus highlights. Clouds have soft, billowy shading with
 * a bright silver-lining at grazing angles — quantizing the luminance into
 * discrete bands produces the flat anime cloud shapes seen in Ghibli-style
 * skies.
 */
function applyCloudCelBanding(baseColor, output, bands, quantizeAmount, softness = 0.15) {
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
 * Apply mood-based tinting to cumulus clouds. Warm moods push clouds toward
 * warm sunset peach/gold, cool moods toward cool snowy-cyan, and neutral
 * moods keep the bright white daytime palette.
 */
function gradeCloudCumulusColor(color, temperature, saturation, brightness, contrast) {
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

    // Cloud-specific temperature bias: warm shift pushes toward sunset peach/
    // gold (R and G up, B down); cool shift pushes toward snowy-cyan (B up,
    // R slightly down).
    r += temperature * 0.05;
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
 * Generate a procedural cumulus-density texture. The algorithm:
 * 1. Perlin-Worley fBm: combine multi-octave fBm with Worley (cellular) noise
 *    to produce the characteristic billowy cloud lobe pattern.
 * 2. Domain warp: offset the sample UV using low-frequency fBm to produce the
 *    organic billowing shape.
 * 3. Boundary erosion: low-frequency fBm erodes the density field near the
 *    cloud silhouette to simulate the wispy edges.
 * 4. Optional precipitation mask: a downward-biased low-frequency noise field
 *    for the rain shaft look of cumulonimbus.
 * The output is a grayscale density map suitable for volume-density use, or
 * for driving the alpha of billboarded cloud impostors.
 */
function generateCumulusDensityTexture(width, height, scale = 0.02, octaves = 5, billowStrength = 0.35, erosionStrength = 0.25, anisotropyG = 0.80, precipitationStrength = 0.0) {
    const out = new Uint8Array(width * height * 4);

    // Worley cell grid for billowy lobe pattern
    const worleyCells = 12;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            // --- 1. Domain warp ---
            const warpX = SimplexNoise.noise2D(x * 0.006, y * 0.006) * 2.5;
            const warpY = SimplexNoise.noise2D(x * 0.006 + 100, y * 0.006 + 100) * 2.5;

            // --- 2. Perlin-Worley fBm ---
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

            // --- 3. Worley lobe pattern for billowy shape ---
            const wvx = ((x + warpX) / width) * worleyCells;
            const wvy = ((y + warpY) / height) * worleyCells;
            const wcellX = Math.floor(wvx);
            const wcellY = Math.floor(wvy);
            let f1 = 1e9;
            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    const nx = wcellX + ox;
                    const ny = wcellY + oy;
                    const h1 = Math.sin(nx * 127.1 + ny * 311.7) * 43758.5453;
                    const h2 = Math.sin(nx * 269.5 + ny * 183.3) * 43758.5453;
                    const jx = h1 - Math.floor(h1);
                    const jy = h2 - Math.floor(h2);
                    const dx = wvx - (nx + jx);
                    const dy = wvy - (ny + jy);
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < f1) f1 = d;
                }
            }
            const billow = Math.max(0, 1.0 - f1);

            // --- 4. Combine perlin + worley into cloud density ---
            let density = fbm * (1.0 - billowStrength) + billow * billowStrength;

            // --- 5. Boundary erosion ---
            const erosion = SimplexNoise.noise2D((x + warpX) * 0.04, (y + warpY) * 0.04) * 0.5 + 0.5;
            density -= Math.max(0, erosion - 0.5) * erosionStrength;
            density = Math.max(0, density);

            // --- 6. Precipitation mask (for cumulonimbus) ---
            let precipitation = 0;
            if (precipitationStrength > 0) {
                const precip = SimplexNoise.noise2D(x * 0.01, y * 0.04) * 0.5 + 0.5;
                precipitation = Math.max(0, precip - 0.55) / 0.45 * precipitationStrength;
            }

            // --- Combine ---
            let value = density - precipitation * 0.35;
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

const _cloudCumulusWorld = BitECS.createWorld();
const CloudCumulusMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    cloudBands: 'ui8',
    cloudQuantize: 'f64',
    cloudSoftness: 'f64',
    billowStrength: 'f64',
    erosionStrength: 'f64',
    powderIntensity: 'f64',
    silverLiningIntensity: 'f64',
    anisotropyG: 'f64',
    precipitationStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
});

class CloudCumulusMaterialBatch {
    constructor() {
        this.world = _cloudCumulusWorld;
        this.materials = [];
        this.entities = [];
    }

    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, CloudCumulusMaterialComponent, eid);
        CloudCumulusMaterialComponent.materialPtr[eid] = this.materials.length;
        CloudCumulusMaterialComponent.cloudBands[eid] = material.cloudBands;
        CloudCumulusMaterialComponent.cloudQuantize[eid] = material.cloudQuantize;
        CloudCumulusMaterialComponent.cloudSoftness[eid] = material.cloudSoftness;
        CloudCumulusMaterialComponent.billowStrength[eid] = material.billowStrength;
        CloudCumulusMaterialComponent.erosionStrength[eid] = material.erosionStrength;
        CloudCumulusMaterialComponent.powderIntensity[eid] = material.powderIntensity;
        CloudCumulusMaterialComponent.silverLiningIntensity[eid] = material.silverLiningIntensity;
        CloudCumulusMaterialComponent.anisotropyG[eid] = material.anisotropyG;
        CloudCumulusMaterialComponent.precipitationStrength[eid] = material.precipitationStrength;
        CloudCumulusMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        CloudCumulusMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        CloudCumulusMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        CloudCumulusMaterialComponent.moodContrast[eid] = material.moodContrast;
        CloudCumulusMaterialComponent.rimGlow[eid] = material.rimGlow;
        CloudCumulusMaterialComponent.variationSeed[eid] = material.variationSeed;
        CloudCumulusMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    process() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[CloudCumulusMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            material.cloudBands = CloudCumulusMaterialComponent.cloudBands[eid];
            material.cloudQuantize = CloudCumulusMaterialComponent.cloudQuantize[eid];
            material.cloudSoftness = CloudCumulusMaterialComponent.cloudSoftness[eid];
            material.billowStrength = CloudCumulusMaterialComponent.billowStrength[eid];
            material.erosionStrength = CloudCumulusMaterialComponent.erosionStrength[eid];
            material.powderIntensity = CloudCumulusMaterialComponent.powderIntensity[eid];
            material.silverLiningIntensity = CloudCumulusMaterialComponent.silverLiningIntensity[eid];
            material.anisotropyG = CloudCumulusMaterialComponent.anisotropyG[eid];
            material.precipitationStrength = CloudCumulusMaterialComponent.precipitationStrength[eid];
            material.moodTemperature = CloudCumulusMaterialComponent.moodTemperature[eid];
            material.moodSaturation = CloudCumulusMaterialComponent.moodSaturation[eid];
            material.moodBrightness = CloudCumulusMaterialComponent.moodBrightness[eid];
            material.moodContrast = CloudCumulusMaterialComponent.moodContrast[eid];
            material.rimGlow = CloudCumulusMaterialComponent.rimGlow[eid];
            material.variationSeed = CloudCumulusMaterialComponent.variationSeed[eid];

            CloudCumulusMaterialComponent.dirty[eid] = 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Main CloudCumulusMaterial class
// ---------------------------------------------------------------------------

class CloudCumulusMaterial extends MeshPhysicalMaterial {
    static {
        _cloudCumulusScratchPool.warm(32);
    }

    constructor(parameters) {
        super();

        this.isCloudCumulusMaterial = true;
        this.type = 'CloudCumulusMaterial';

        // -------------------------------------------------------------------
        // Cumulus-specific PBR defaults (puffy-daytime baseline)
        // -------------------------------------------------------------------
        this.ior = 1.0003;
        this.specularIntensity = 0.42;
        this.roughness = 0.82;
        this.metalness = 0.0;
        this.specularColor = new Color(1.0, 1.0, 1.0);
        this.color = new Color(0.98, 0.97, 0.94);

        // Thin-walled transmission for forward-scattered edge light
        this.transmission = 0.46;
        this.thickness = 0.30;
        this.attenuationDistance = 0.12;
        this.attenuationColor = new Color(0.96, 0.97, 1.0);

        // Sheen for the silver-lining rim
        this.sheen = 0.68;
        this.sheenColor = new Color(1.0, 1.0, 0.98);
        this.sheenRoughness = 0.30;

        this.clearcoat = 0.0;
        this.clearcoatRoughness = 0.0;

        // -------------------------------------------------------------------
        // Anime rendering extensions — cumulus-specific
        // -------------------------------------------------------------------
        this.cloudBands = 3;
        this.cloudQuantize = 0.40;
        this.cloudSoftness = 0.15;

        // Billow / erosion / powder / silver-lining controls
        this.billowStrength = 0.35;
        this.erosionStrength = 0.25;
        this.powderIntensity = 0.65;
        this.silverLiningIntensity = 0.55;
        this.anisotropyG = 0.82;
        this.precipitationStrength = 0.0;

        this.moodTemperature = 0;
        this.moodSaturation = 1.0;
        this.moodBrightness = 1.0;
        this.moodContrast = 1.0;
        this.rimGlow = 0.15;
        this.rimGlowColor = new Color(1.0, 1.0, 0.98);
        this.paperGrain = 0;
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (cumulus leans semi-realistic with anime shaping)
        // -------------------------------------------------------------------
        this.renderStyleBlend = 0.40;

        // -------------------------------------------------------------------
        // Galactic-scale configuration
        // -------------------------------------------------------------------
        this.galacticScaleEnabled = false;

        this.setValues(parameters);
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    applyCloudBanding(baseColor, output) {
        return applyCloudCelBanding(
            baseColor,
            output,
            this.cloudBands,
            this.cloudQuantize,
            this.cloudSoftness
        );
    }

    updateMoodColor() {
        gradeCloudCumulusColor(
            this.color,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Apply a named cumulus preset to this material.
     * @param {string} presetName - One of the keys of `CloudCumulusPresets`.
     * @returns {CloudCumulusMaterial} A reference to this instance.
     */
    applyPreset(presetName) {
        const preset = CloudCumulusPresets[presetName];
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
        this.powderIntensity = preset.powderIntensity;
        this.anisotropyG = preset.anisotropyG;

        // Per-preset anime tuning
        if (presetName === 'storm-cumulus' || presetName === 'towering-cumulonimbus') {
            this.cloudSoftness = 0.25;
            this.cloudBands = 2;
            this.silverLiningIntensity = 0.35;
            this.precipitationStrength = presetName === 'towering-cumulonimbus' ? 0.25 : 0.45;
        } else if (presetName === 'anime-cumulus') {
            this.cloudSoftness = 0.08;
            this.cloudBands = 4;
            this.silverLiningIntensity = 0.75;
            this.precipitationStrength = 0.0;
        } else if (presetName === 'sunset-lit-cumulus') {
            this.cloudSoftness = 0.12;
            this.cloudBands = 3;
            this.silverLiningIntensity = 0.68;
            this.precipitationStrength = 0.0;
        } else {
            this.cloudSoftness = 0.15;
            this.cloudBands = 3;
            this.silverLiningIntensity = 0.55;
            this.precipitationStrength = 0.0;
        }

        this.updateMoodColor();
        return this;
    }

    generateCumulusDensityTexture(width, height, scale = 0.02, octaves = 5, billowStrength = 0.35, erosionStrength = 0.25, precipitationStrength = 0.0) {
        return generateCumulusDensityTexture(width, height, scale, octaves, billowStrength, erosionStrength, this.anisotropyG, precipitationStrength);
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

        shader.uniforms.cloudBands = { value: this.cloudBands };
        shader.uniforms.cloudQuantize = { value: this.cloudQuantize };
        shader.uniforms.cloudSoftness = { value: this.cloudSoftness };
        shader.uniforms.billowStrength = { value: this.billowStrength };
        shader.uniforms.erosionStrength = { value: this.erosionStrength };
        shader.uniforms.powderIntensity = { value: this.powderIntensity };
        shader.uniforms.silverLiningIntensity = { value: this.silverLiningIntensity };
        shader.uniforms.anisotropyG = { value: this.anisotropyG };
        shader.uniforms.precipitationStrength = { value: this.precipitationStrength };
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
                uniform int cloudBands;
                uniform float cloudQuantize;
                uniform float cloudSoftness;
                uniform float billowStrength;
                uniform float erosionStrength;
                uniform float powderIntensity;
                uniform float silverLiningIntensity;
                uniform float anisotropyG;
                uniform float precipitationStrength;
                uniform float moodTemperature;
                uniform float moodSaturation;
                uniform float moodBrightness;
                uniform float moodContrast;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float variationOffset;

                vec3 applyCloudBands(vec3 baseColor) {
                    if (cloudBands <= 1) return baseColor;
                    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(cloudBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float distToBoundary = abs(lum - bandIndex * bandWidth - bandWidth * 0.5);
                    float softFactor = clamp(distToBoundary / (bandWidth * 0.5), 0.0, 1.0);
                    float softQuantized = quantized + (lum - quantized) * (1.0 - softFactor) * cloudSoftness;
                    float finalLum = mix(lum, softQuantized, cloudQuantize);
                    if (lum > 0.0001) return baseColor * (finalLum / lum);
                    return baseColor;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply cloud cel banding
                gl_FragColor.rgb = applyCloudBands(gl_FragColor.rgb);

                // Powder effect: dense cloud cores appear slightly brighter and
                // more "milky" than edges (approximates multiple-scattering
                // powder from Nubis Evolved)
                if (powderIntensity > 0.0) {
                    vec2 powderUV = vUv * 12.0;
                    float powderNoise = fract(sin(dot(floor(powderUV), vec2(12.9898, 78.233))) * 43758.5453);
                    float powder = smoothstep(0.3, 0.7, powderNoise);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0), powder * powderIntensity * 0.15);
                }

                // Silver-lining: bright grazing-angle rim (Henyey-Greenstein
                // forward scattering at g ≈ 0.8 for water-droplet scattering)
                if (silverLiningIntensity > 0.0) {
                    float ndotvCloud = abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    float hgPhase = (1.0 - anisotropyG * anisotropyG) / pow(1.0 + anisotropyG * anisotropyG - 2.0 * anisotropyG * ndotvCloud, 1.5);
                    float silverLining = pow(1.0 - ndotvCloud, 3.0) * hgPhase * silverLiningIntensity * 0.35;
                    gl_FragColor.rgb += sheenColor * silverLining;
                }

                // Precipitation shaft (for cumulonimbus)
                if (precipitationStrength > 0.0) {
                    float precipMask = smoothstep(0.7, 1.0, vUv.y);
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.55, 0.58, 0.62), precipMask * precipitationStrength * 0.5);
                }

                // Cool-tinted rim glow on cloud edges
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
            this.cloudBands, this.cloudQuantize, this.cloudSoftness,
            this.billowStrength, this.erosionStrength,
            this.powderIntensity, this.silverLiningIntensity,
            this.anisotropyG, this.precipitationStrength,
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
        this.cloudBands = source.cloudBands;
        this.cloudQuantize = source.cloudQuantize;
        this.cloudSoftness = source.cloudSoftness;
        this.billowStrength = source.billowStrength;
        this.erosionStrength = source.erosionStrength;
        this.powderIntensity = source.powderIntensity;
        this.silverLiningIntensity = source.silverLiningIntensity;
        this.anisotropyG = source.anisotropyG;
        this.precipitationStrength = source.precipitationStrength;
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.variationSeed = source.variationSeed;
        return this;
    }

    toJSON(meta) {
        const data = super.toJSON(meta);
        data.type = 'CloudCumulusMaterial';
        if (this.ior !== 1.0003) data.ior = this.ior;
        if (this.specularIntensity !== 0.42) data.specularIntensity = this.specularIntensity;
        if (this.roughness !== 0.82) data.roughness = this.roughness;
        if (this.metalness !== 0.0) data.metalness = this.metalness;
        if (this.transmission !== 0.46) data.transmission = this.transmission;
        if (this.thickness !== 0.30) data.thickness = this.thickness;
        if (this.attenuationDistance !== 0.12) data.attenuationDistance = this.attenuationDistance;
        if (this.attenuationColor.getHex() !== new Color(0.96, 0.97, 1.0).getHex()) data.attenuationColor = this.attenuationColor.getHex();
        if (this.sheen !== 0.68) data.sheen = this.sheen;
        if (this.sheenColor.getHex() !== new Color(1.0, 1.0, 0.98).getHex()) data.sheenColor = this.sheenColor.getHex();
        if (this.sheenRoughness !== 0.30) data.sheenRoughness = this.sheenRoughness;
        if (this.specularColor.getHex() !== new Color(1.0, 1.0, 1.0).getHex()) data.specularColor = this.specularColor.getHex();
        if (this.cloudBands !== 3) data.cloudBands = this.cloudBands;
        if (this.cloudQuantize !== 0.40) data.cloudQuantize = this.cloudQuantize;
        if (this.cloudSoftness !== 0.15) data.cloudSoftness = this.cloudSoftness;
        if (this.billowStrength !== 0.35) data.billowStrength = this.billowStrength;
        if (this.erosionStrength !== 0.25) data.erosionStrength = this.erosionStrength;
        if (this.powderIntensity !== 0.65) data.powderIntensity = this.powderIntensity;
        if (this.silverLiningIntensity !== 0.55) data.silverLiningIntensity = this.silverLiningIntensity;
        if (this.anisotropyG !== 0.82) data.anisotropyG = this.anisotropyG;
        if (this.precipitationStrength !== 0.0) data.precipitationStrength = this.precipitationStrength;
        if (this.rimGlow !== 0.15) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(1.0, 1.0, 0.98).getHex()) data.rimGlowColor = this.rimGlowColor.getHex();
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
        this.cloudBands = json.cloudBands ?? this.cloudBands;
        this.cloudQuantize = json.cloudQuantize ?? this.cloudQuantize;
        this.cloudSoftness = json.cloudSoftness ?? this.cloudSoftness;
        this.billowStrength = json.billowStrength ?? this.billowStrength;
        this.erosionStrength = json.erosionStrength ?? this.erosionStrength;
        this.powderIntensity = json.powderIntensity ?? this.powderIntensity;
        this.silverLiningIntensity = json.silverLiningIntensity ?? this.silverLiningIntensity;
        this.anisotropyG = json.anisotropyG ?? this.anisotropyG;
        this.precipitationStrength = json.precipitationStrength ?? this.precipitationStrength;
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.variationSeed = json.variationSeed ?? this.variationSeed;
        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS-ready batching metadata
// ---------------------------------------------------------------------------

const CloudCumulusMaterialBatchComponent = {
    materialPtr: 'ui32',
    cloudBands: 'ui8',
    cloudQuantize: 'f64',
    cloudSoftness: 'f64',
    billowStrength: 'f64',
    erosionStrength: 'f64',
    powderIntensity: 'f64',
    silverLiningIntensity: 'f64',
    anisotropyG: 'f64',
    precipitationStrength: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    CloudCumulusMaterial,
    CloudCumulusMaterialBatch,
    CloudCumulusScratchPool,
    CloudCumulusMaterialBatchComponent,
    CloudCumulusPresets,
    applyCloudCelBanding,
    gradeCloudCumulusColor,
    generateCumulusDensityTexture
};

export default CloudCumulusMaterial;