// file number : 194
// full path name : src/materials/194_materials.js
// description : Barrel entry point for the rewritten materials folder.
//               Re-exports all concrete material classes (176–193), provides a
//               high-level AnimeMaterialRegistry (bitecs-backed SoA registry for
//               heterogeneous material sets), a global mood controller, a global
//               rim controller, a global cel-band controller, a global paper-grain
//               controller, a createMaterial factory, and a shared anime texture
//               generator. All imports resolve to the internal Threejs_gl
//               repository tree; no CDN dependencies.
// best for : The `materials` namespace — the single-import entry point for any
//            project that needs to construct, register, mood-manage, and batch-
//            process any material type with anime stylization.
// license : MIT

import { Material } from './176_material.js';
import { LineBasicMaterial } from './177_linebasicmaterial.js';
import { MeshBasicMaterial } from './178_meshbasicmaterial.js';
import { MeshDepthMaterial } from './179_meshdepthmaterial.js';
import { LineDashedMaterial } from './180_linedashedmaterial.js';
import { MeshDistanceMaterial } from './181_meshdistancematerial.js';
import { MeshLambertMaterial } from './182_meshlambertmaterial.js';
import { MeshMatcapMaterial } from './183_meshmatcapmaterial.js';
import { MeshNormalMaterial } from './184_meshnormalmaterial.js';
import { MeshPhongMaterial } from './185_meshphongmaterial.js';
import { MeshStandardMaterial } from './186_meshstandardmaterial.js';
import { MeshToonMaterial } from './187_meshtoonmaterial.js';
import { PointsMaterial } from './188_pointsmaterial.js';
import { ShadowMaterial } from './189_shadowmaterial.js';
import { SpriteMaterial } from './190_spritematerial.js';
import { ShaderMaterial } from './191_shadermaterial.js';
import { RawShaderMaterial } from './192_rawshadermaterial.js';
import { MeshPhysicalMaterial } from './193_meshphysicalmaterial.js';

// Architectural visualization materials (new files 195–199)
import { ArchitecturalGlassMaterial } from './195_architecturalglassmaterial.js';
import { ArchitecturalWoodMaterial } from './196_architecturalwoodmaterial.js';
import { ArchitecturalConcreteMaterial } from './197_architecturalconcretematerial.js';
import { ArchitecturalMetalMaterial } from './198_architecturalmetalmaterial.js';
import { ArchitecturalFabricMaterial } from './199_architecturalfabricmaterial.js';

import { Color } from '../math/069_Color.js';
import { ColorManagement } from '../math/068_ColorManagement.js';
import { Vec2 } from '../math/005_Vec2.js';
import { Vec3 } from '../math/006_Vec3.js';
import { SimplexNoise } from '../math/013_SimplexNoise.js';
import { BitECS } from '../ecs/014_BitECS.js';
import { World } from '../ecs/015_World.js';
import { Components } from '../ecs/016_Components.js';
import { Systems } from '../ecs/017_Systems.js';

// ---------------------------------------------------------------------------
// Global declarations
// ---------------------------------------------------------------------------

/** @type {Float32Array} Scratch vec3 for zero-allocation cross-material transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Object} Map of material type names to constructors. */
const _materialConstructors = {
    Material,
    LineBasicMaterial,
    MeshBasicMaterial,
    MeshDepthMaterial,
    LineDashedMaterial,
    MeshDistanceMaterial,
    MeshLambertMaterial,
    MeshMatcapMaterial,
    MeshNormalMaterial,
    MeshPhongMaterial,
    MeshStandardMaterial,
    MeshToonMaterial,
    PointsMaterial,
    ShadowMaterial,
    SpriteMaterial,
    ShaderMaterial,
    RawShaderMaterial,
    MeshPhysicalMaterial,
    ArchitecturalGlassMaterial,
    ArchitecturalWoodMaterial,
    ArchitecturalConcreteMaterial,
    ArchitecturalMetalMaterial,
    ArchitecturalFabricMaterial
};

// ---------------------------------------------------------------------------
// Material type tags (used by the ECS registry)
// ---------------------------------------------------------------------------

const MaterialType = {
    Material: 0,
    LineBasicMaterial: 1,
    LineDashedMaterial: 2,
    MeshBasicMaterial: 3,
    MeshDepthMaterial: 4,
    MeshDistanceMaterial: 5,
    MeshLambertMaterial: 6,
    MeshMatcapMaterial: 7,
    MeshNormalMaterial: 8,
    MeshPhongMaterial: 9,
    MeshStandardMaterial: 10,
    MeshPhysicalMaterial: 11,
    MeshToonMaterial: 12,
    PointsMaterial: 13,
    ShaderMaterial: 14,
    RawShaderMaterial: 15,
    ShadowMaterial: 16,
    SpriteMaterial: 17,
    ArchitecturalGlassMaterial: 18,
    ArchitecturalWoodMaterial: 19,
    ArchitecturalConcreteMaterial: 20,
    ArchitecturalMetalMaterial: 21,
    ArchitecturalFabricMaterial: 22
};

// ---------------------------------------------------------------------------
// bitecs SoA registry for heterogeneous material sets
// ---------------------------------------------------------------------------

const _materialsWorld = BitECS.createWorld();

const MaterialRegistryComponent = BitECS.defineComponent({
    materialType: 'ui8',
    materialPtr: 'ui32',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimIntensity: 'f64',
    celBands: 'ui8',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    variationSeed: 'f64',
    active: 'ui8'
});

/**
 * A registry for heterogeneous material sets backed by bitecs SoA storage.
 * Supports global mood, rim, cel-band, and paper-grain application across all
 * registered materials in one cache-friendly pass.
 */
class AnimeMaterialRegistry {

    constructor() {
        /** @type {Object} */
        this.world = _materialsWorld;
        /** @type {Material[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
    }

    /**
     * Register a material instance. The type is inferred from the instance's
     * `type` field.
     * @param {Material} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, MaterialRegistryComponent, eid);

        const typeName = material.type || 'Material';
        MaterialRegistryComponent.materialType[eid] = MaterialType[typeName] ?? 255;
        MaterialRegistryComponent.materialPtr[eid] = this.materials.length;
        MaterialRegistryComponent.moodTemperature[eid] = material.moodTemperature ?? 0;
        MaterialRegistryComponent.moodSaturation[eid] = material.moodSaturation ?? 1.0;
        MaterialRegistryComponent.moodBrightness[eid] = material.moodBrightness ?? 1.0;
        MaterialRegistryComponent.moodContrast[eid] = material.moodContrast ?? 1.0;
        MaterialRegistryComponent.rimIntensity[eid] = material.rimIntensity ?? material.rimGlow ?? 0;
        MaterialRegistryComponent.celBands[eid] = material.animeBands ?? material.celBands ?? material.toonBands ?? material.flatBands ?? 0;
        MaterialRegistryComponent.paperGrain[eid] = material.paperGrain ?? 0;
        MaterialRegistryComponent.watercolorBleed[eid] = material.watercolorBleed ?? 0;
        MaterialRegistryComponent.variationSeed[eid] = material.variationSeed ?? 0;
        MaterialRegistryComponent.active[eid] = 1;

        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Apply a single mood across all registered materials in one cache-friendly
     * pass.
     * @param {number} temperature - Warm/cool shift in [-1, 1].
     * @param {number} saturation - Saturation multiplier.
     * @param {number} brightness - Brightness multiplier.
     * @param {number} contrast - Contrast multiplier.
     */
    applyGlobalMood(temperature, saturation, brightness, contrast) {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MaterialRegistryComponent.materialPtr[eid]];
            if (!material) continue;

            if ('moodTemperature' in material) material.moodTemperature = temperature;
            if ('moodSaturation' in material) material.moodSaturation = saturation;
            if ('moodBrightness' in material) material.moodBrightness = brightness;
            if ('moodContrast' in material) material.moodContrast = contrast;

            MaterialRegistryComponent.moodTemperature[eid] = temperature;
            MaterialRegistryComponent.moodSaturation[eid] = saturation;
            MaterialRegistryComponent.moodBrightness[eid] = brightness;
            MaterialRegistryComponent.moodContrast[eid] = contrast;

            if (typeof material.updateMoodColor === 'function') material.updateMoodColor();
            if (typeof material.updateMoodColors === 'function') material.updateMoodColors();
            if (typeof material.updateMoodPBR === 'function') material.updateMoodPBR();
            if (typeof material.updateMoodAdvancedPBR === 'function') material.updateMoodAdvancedPBR();
        }
    }

    /**
     * Apply a global rim intensity across all registered materials.
     * @param {number} intensity - Rim intensity.
     */
    applyGlobalRim(intensity) {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MaterialRegistryComponent.materialPtr[eid]];
            if (!material) continue;

            if ('rimIntensity' in material) material.rimIntensity = intensity;
            if ('rimGlow' in material) material.rimGlow = intensity;
            if ('edgeRimIntensity' in material) material.edgeRimIntensity = intensity;

            MaterialRegistryComponent.rimIntensity[eid] = intensity;
        }
    }

    /**
     * Apply a global cel-band count across all registered materials.
     * @param {number} bands - Number of cel bands.
     */
    applyGlobalCelBands(bands) {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MaterialRegistryComponent.materialPtr[eid]];
            if (!material) continue;

            if ('animeBands' in material) material.animeBands = bands;
            if ('celBands' in material) material.celBands = bands;
            if ('toonBands' in material) material.toonBands = bands;
            if ('flatBands' in material) material.flatBands = bands;

            MaterialRegistryComponent.celBands[eid] = bands;

            if (typeof material.updateCelColor === 'function') material.updateCelColor();
            if (typeof material.updateFlatColor === 'function') material.updateFlatColor();
            if (typeof material.updateCelThresholds === 'function') material.updateCelThresholds();
        }
    }

    /**
     * Apply a global paper-grain intensity across all registered materials.
     * @param {number} intensity - Paper-grain intensity in [0, 1].
     */
    applyGlobalPaperGrain(intensity) {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MaterialRegistryComponent.materialPtr[eid]];
            if (!material) continue;

            if ('paperGrain' in material) material.paperGrain = intensity;
            MaterialRegistryComponent.paperGrain[eid] = intensity;
        }
    }

    /**
     * Apply a global watercolor bleed strength across all registered materials.
     * @param {number} intensity - Watercolor bleed strength in [0, 1].
     */
    applyGlobalWatercolorBleed(intensity) {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MaterialRegistryComponent.materialPtr[eid]];
            if (!material) continue;

            if ('watercolorBleed' in material) material.watercolorBleed = intensity;
            MaterialRegistryComponent.watercolorBleed[eid] = intensity;
        }
    }

    /**
     * Mark every registered material as needing a shader recompile.
     */
    markAllForUpdate() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MaterialRegistryComponent.materialPtr[eid]];
            if (!material) continue;
            material.needsUpdate = true;
        }
    }

    /**
     * Filter registered materials by type tag.
     * @param {number} typeTag - One of the `MaterialType` constants.
     * @returns {Material[]}
     */
    filterByType(typeTag) {
        const out = [];
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            if (MaterialRegistryComponent.materialType[eid] === typeTag) {
                out.push(this.materials[MaterialRegistryComponent.materialPtr[eid]]);
            }
        }
        return out;
    }

    /**
     * Dispose every registered material in one pass.
     */
    disposeAll() {
        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[MaterialRegistryComponent.materialPtr[eid]];
            if (!material) continue;

            if (typeof material.dispose === 'function') material.dispose();
            MaterialRegistryComponent.active[eid] = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// Mood presets — curated combinations of temperature, saturation, brightness,
// contrast chosen to match the reference imagery's atmospheric palettes.
// ---------------------------------------------------------------------------

const AnimeMoodPresets = {
    'snowy-cyan': { temperature: -0.35, saturation: 1.15, brightness: 1.05, contrast: 1.1 },
    'sunset-orange': { temperature: 0.45, saturation: 1.25, brightness: 1.05, contrast: 1.2 },
    'ocean-teal': { temperature: -0.25, saturation: 1.35, brightness: 0.95, contrast: 1.15 },
    'space-blue': { temperature: -0.45, saturation: 0.85, brightness: 1.15, contrast: 0.95 },
    'shoji-warmth': { temperature: 0.30, saturation: 1.05, brightness: 1.10, contrast: 0.90 },
    'flora-vibrant': { temperature: 0.05, saturation: 1.55, brightness: 1.10, contrast: 1.15 }
};

/**
 * Apply a named anime mood preset to the entire material registry.
 * @param {AnimeMaterialRegistry} registry
 * @param {string} moodName - One of the keys of `AnimeMoodPresets`.
 * @returns {boolean} True if the preset was applied.
 */
function applyMoodPreset(registry, moodName) {
    const preset = AnimeMoodPresets[moodName];
    if (!preset) return false;

    registry.applyGlobalMood(preset.temperature, preset.saturation, preset.brightness, preset.contrast);
    return true;
}

/**
 * Apply a mood preset directly to a single material instance.
 * @param {Material} material
 * @param {string} moodName
 * @returns {Material}
 */
function applyMoodToMaterial(material, moodName) {
    const preset = AnimeMoodPresets[moodName];
    if (!preset) return material;

    if ('moodTemperature' in material) material.moodTemperature = preset.temperature;
    if ('moodSaturation' in material) material.moodSaturation = preset.saturation;
    if ('moodBrightness' in material) material.moodBrightness = preset.brightness;
    if ('moodContrast' in material) material.moodContrast = preset.contrast;

    if (typeof material.updateMoodColor === 'function') material.updateMoodColor();
    if (typeof material.updateMoodColors === 'function') material.updateMoodColors();
    if (typeof material.updateMoodPBR === 'function') material.updateMoodPBR();
    if (typeof material.updateMoodAdvancedPBR === 'function') material.updateMoodAdvancedPBR();

    return material;
}

// ---------------------------------------------------------------------------
// Shared procedural paper-grain / watercolor texture generator
// ---------------------------------------------------------------------------

/**
 * Generate a single paper-grain / watercolor texture that can be shared across
 * all materials in a scene.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03]
 * @param {number} [octaves=4]
 * @param {number} [paperGrain=0.3]
 * @param {number} [watercolorBleed=0.5]
 * @returns {Uint8Array} RGBA buffer.
 */
function generateSharedAnimeTexture(width, height, scale = 0.03, octaves = 4, paperGrain = 0.3, watercolorBleed = 0.5) {
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;

            let value = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for (let o = 0; o < octaves; o++) {
                value += SimplexNoise.noise2D(x * frequency, y * frequency) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            value = (value / maxAmplitude) * 0.5 + 0.5;

            value = (value - 0.5) * (1.0 + watercolorBleed) + 0.5;
            value = Math.max(0, Math.min(1, value));

            const grain = SimplexNoise.noise2D(x * 0.5, y * 0.5) * 0.5 + 0.5;
            value = value * (1 - paperGrain) + grain * paperGrain;
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
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a material instance by type name.
 * @param {string} typeName - One of the keys of `_materialConstructors`.
 * @param {Object} [parameters] - Constructor parameters forwarded to the material.
 * @returns {Material}
 */
function createMaterial(typeName, parameters = {}) {
    const Ctor = _materialConstructors[typeName];
    if (!Ctor) throw new Error(`Materials.createMaterial: unknown material type "${typeName}"`);
    return new Ctor(parameters);
}

// ---------------------------------------------------------------------------
// Exports — the barrel namespace
// ---------------------------------------------------------------------------

export {
    // Core material classes
    Material,
    LineBasicMaterial,
    MeshBasicMaterial,
    MeshDepthMaterial,
    LineDashedMaterial,
    MeshDistanceMaterial,
    MeshLambertMaterial,
    MeshMatcapMaterial,
    MeshNormalMaterial,
    MeshPhongMaterial,
    MeshStandardMaterial,
    MeshToonMaterial,
    PointsMaterial,
    ShadowMaterial,
    SpriteMaterial,
    ShaderMaterial,
    RawShaderMaterial,
    MeshPhysicalMaterial,

    // Architectural visualization materials
    ArchitecturalGlassMaterial,
    ArchitecturalWoodMaterial,
    ArchitecturalConcreteMaterial,
    ArchitecturalMetalMaterial,
    ArchitecturalFabricMaterial,

    // Registry & type tags
    MaterialType,
    AnimeMaterialRegistry,

    // Mood presets & controllers
    AnimeMoodPresets,
    applyMoodPreset,
    applyMoodToMaterial,

    // Factory & shared resources
    createMaterial,
    generateSharedAnimeTexture
};

// Default export mirrors three.js's namespace-style barrel export
export default {
    Material,
    LineBasicMaterial,
    MeshBasicMaterial,
    MeshDepthMaterial,
    LineDashedMaterial,
    MeshDistanceMaterial,
    MeshLambertMaterial,
    MeshMatcapMaterial,
    MeshNormalMaterial,
    MeshPhongMaterial,
    MeshStandardMaterial,
    MeshToonMaterial,
    PointsMaterial,
    ShadowMaterial,
    SpriteMaterial,
    ShaderMaterial,
    RawShaderMaterial,
    MeshPhysicalMaterial,
    ArchitecturalGlassMaterial,
    ArchitecturalWoodMaterial,
    ArchitecturalConcreteMaterial,
    ArchitecturalMetalMaterial,
    ArchitecturalFabricMaterial,
    MaterialType,
    AnimeMaterialRegistry,
    AnimeMoodPresets,
    applyMoodPreset,
    applyMoodToMaterial,
    createMaterial,
    generateSharedAnimeTexture
};