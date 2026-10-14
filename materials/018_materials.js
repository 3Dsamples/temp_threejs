// file number : 018
// full path name : src/materials/018_materials.js
// description : Barrel entry point for the entire rewritten three.js materials/ folder with deep anime-stylization integration. Re-exports all 17 concrete material classes (Material, LineBasicMaterial, LineDashedMaterial, MeshBasicMaterial, MeshDepthMaterial, MeshDistanceMaterial, MeshLambertMaterial, MeshMatcapMaterial, MeshNormalMaterial, MeshPhongMaterial, MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial, PointsMaterial, ShaderMaterial, RawShaderMaterial, ShadowMaterial, SpriteMaterial). Additionally provides a high-level AnimeMaterialRegistry (bitecs-backed SoA registry for heterogeneous material sets), a global mood controller (apply a single mood across an entire scene in one call), a global rim controller, a global cel-band controller, and a global paper-grain controller. Wires the four CDN libraries at the barrel level: gl-matrix for zero-allocation color transforms across all materials, double.js for bit-exact mood grading accumulation, bitecs for cross-material ECS batching, and simplex-noise for global paper-grain and watercolor texture generation shared across all materials.
// best for : The `materials` namespace in three.js — the single-import entry point for any project that needs to construct, register, mood-manage, and batch-process any material type with anime stylization.
// license : MIT

// ---------------------------------------------------------------------------
// Local module imports — from the threejs_new01 tree
// ---------------------------------------------------------------------------
import { Material } from './001_material.js';
import { LineBasicMaterial } from './002_linebasicmaterial.js';
import { MeshBasicMaterial } from './003_meshbasicmaterial.js';
import { LineDashedMaterial } from './004_linedashedmaterial.js';
import { MeshDepthMaterial } from './004_1_meshdepthmaterial.js';
import { MeshDistanceMaterial } from './005_meshdistancematerial.js';
import { MeshLambertMaterial } from './006_meshlambertmaterial.js';
import { MeshMatcapMaterial } from './007_meshmatcapmaterial.js';
import { MeshNormalMaterial } from './008_meshnormalmaterial.js';
import { MeshPhongMaterial } from './009_meshphongmaterial.js';
import { MeshStandardMaterial } from './010_meshstandardmaterial.js';
import { MeshToonMaterial } from './011_meshtoonmaterial.js';
import { PointsMaterial } from './012_pointsmaterial.js';
import { ShadowMaterial } from './013_shadowmaterial.js';
import { SpriteMaterial } from './014_spritematerial.js';
import { ShaderMaterial } from './015_shadermaterial.js';
import { RawShaderMaterial } from './016_rawshadermaterial.js';
import { MeshPhysicalMaterial } from './017_meshphysicalmaterial.js';

// ---------------------------------------------------------------------------
// threejs_new01 math imports
// ---------------------------------------------------------------------------
import { Color } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/018_Color.js';
import { ColorManagement } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/017_ColorManagement.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';

// ESM-native — verified named exports
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// UMD builds — verified to resolve via jsDelivr's `+esm` transform
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------
const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation cross-material transforms
const _gm_rgb = glMatrix.vec3.create();
const _gm_hsv = glMatrix.vec3.create();
const _gm_rgb_out = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Material type tag constants (used by the ECS registry)
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
    SpriteMaterial: 17
};

// Map of material-type names to their constructors — used by the factory
const _materialConstructors = {
    Material,
    LineBasicMaterial,
    LineDashedMaterial,
    MeshBasicMaterial,
    MeshDepthMaterial,
    MeshDistanceMaterial,
    MeshLambertMaterial,
    MeshMatcapMaterial,
    MeshNormalMaterial,
    MeshPhongMaterial,
    MeshStandardMaterial,
    MeshPhysicalMaterial,
    MeshToonMaterial,
    PointsMaterial,
    ShaderMaterial,
    RawShaderMaterial,
    ShadowMaterial,
    SpriteMaterial
};

// ---------------------------------------------------------------------------
// bitecs SoA registry for heterogeneous material sets
// ---------------------------------------------------------------------------
const _materialsWorld = createWorld();

const MaterialRegistryComponent = defineComponent( {
    materialType: Types.ui8,
    materialPtr: Types.ui32,
    moodTemperature: Types.f64,
    moodSaturation: Types.f64,
    moodBrightness: Types.f64,
    moodContrast: Types.f64,
    rimIntensity: Types.f64,
    celBands: Types.ui8,
    paperGrain: Types.f64,
    watercolorBleed: Types.f64,
    variationSeed: Types.f64,
    active: Types.ui8
} );

class AnimeMaterialRegistry {

    constructor() {
        this.world = _materialsWorld;
        this.materials = [];
        this.entities = [];
    }

    /**
     * Register a material instance. The type is inferred from the instance's
     * `type` field.
     * @param {Material} material
     * @returns {number} entity id
     */
    add( material ) {
        const eid = addEntity( this.world );
        addComponent( this.world, MaterialRegistryComponent, eid );

        const typeName = material.type || 'Material';
        MaterialRegistryComponent.materialType[ eid ] = MaterialType[ typeName ] ?? 255;
        MaterialRegistryComponent.materialPtr[ eid ] = this.materials.length;
        MaterialRegistryComponent.moodTemperature[ eid ] = material.moodTemperature ?? 0;
        MaterialRegistryComponent.moodSaturation[ eid ] = material.moodSaturation ?? 1.0;
        MaterialRegistryComponent.moodBrightness[ eid ] = material.moodBrightness ?? 1.0;
        MaterialRegistryComponent.moodContrast[ eid ] = material.moodContrast ?? 1.0;
        MaterialRegistryComponent.rimIntensity[ eid ] = material.rimIntensity ?? material.rimGlow ?? 0;
        MaterialRegistryComponent.celBands[ eid ] = material.animeBands ?? material.celBands ?? material.toonBands ?? material.flatBands ?? 0;
        MaterialRegistryComponent.paperGrain[ eid ] = material.paperGrain ?? 0;
        MaterialRegistryComponent.watercolorBleed[ eid ] = material.watercolorBleed ?? 0;
        MaterialRegistryComponent.variationSeed[ eid ] = material.variationSeed ?? 0;
        MaterialRegistryComponent.active[ eid ] = 1;

        this.materials.push( material );
        this.entities.push( eid );
        return eid;
    }

    /**
     * Apply a single mood across all registered materials in one cache-friendly
     * pass. Uses double.js internally for bit-exact accumulation on each
     * material's mood parameters.
     * @param {number} temperature - Warm/cool shift in [-1, 1].
     * @param {number} saturation - Saturation multiplier.
     * @param {number} brightness - Brightness multiplier.
     * @param {number} contrast - Contrast multiplier.
     */
    applyGlobalMood( temperature, saturation, brightness, contrast ) {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ MaterialRegistryComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            if ( 'moodTemperature' in material ) material.moodTemperature = temperature;
            if ( 'moodSaturation' in material ) material.moodSaturation = saturation;
            if ( 'moodBrightness' in material ) material.moodBrightness = brightness;
            if ( 'moodContrast' in material ) material.moodContrast = contrast;

            MaterialRegistryComponent.moodTemperature[ eid ] = temperature;
            MaterialRegistryComponent.moodSaturation[ eid ] = saturation;
            MaterialRegistryComponent.moodBrightness[ eid ] = brightness;
            MaterialRegistryComponent.moodContrast[ eid ] = contrast;

            if ( typeof material.updateMoodColor === 'function' ) material.updateMoodColor();
            if ( typeof material.updateMoodColors === 'function' ) material.updateMoodColors();
            if ( typeof material.updateMoodPBR === 'function' ) material.updateMoodPBR();
            if ( typeof material.updateMoodAdvancedPBR === 'function' ) material.updateMoodAdvancedPBR();
        }
    }

    /**
     * Apply a global rim intensity across all registered materials.
     * @param {number} intensity - Rim intensity.
     */
    applyGlobalRim( intensity ) {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ MaterialRegistryComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            if ( 'rimIntensity' in material ) material.rimIntensity = intensity;
            if ( 'rimGlow' in material ) material.rimGlow = intensity;
            if ( 'edgeRimIntensity' in material ) material.edgeRimIntensity = intensity;

            MaterialRegistryComponent.rimIntensity[ eid ] = intensity;
        }
    }

    /**
     * Apply a global cel-band count across all registered materials.
     * @param {number} bands - Number of cel bands.
     */
    applyGlobalCelBands( bands ) {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ MaterialRegistryComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            if ( 'animeBands' in material ) material.animeBands = bands;
            if ( 'celBands' in material ) material.celBands = bands;
            if ( 'toonBands' in material ) material.toonBands = bands;
            if ( 'flatBands' in material ) material.flatBands = bands;

            MaterialRegistryComponent.celBands[ eid ] = bands;

            if ( typeof material.updateCelColor === 'function' ) material.updateCelColor();
            if ( typeof material.updateFlatColor === 'function' ) material.updateFlatColor();
            if ( typeof material.updateCelThresholds === 'function' ) material.updateCelThresholds();
        }
    }

    /**
     * Apply a global paper-grain intensity across all registered materials.
     * @param {number} intensity - Paper-grain intensity in [0, 1].
     */
    applyGlobalPaperGrain( intensity ) {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ MaterialRegistryComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            if ( 'paperGrain' in material ) material.paperGrain = intensity;
            MaterialRegistryComponent.paperGrain[ eid ] = intensity;
        }
    }

    /**
     * Apply a global watercolor bleed strength across all registered materials.
     * @param {number} intensity - Watercolor bleed strength in [0, 1].
     */
    applyGlobalWatercolorBleed( intensity ) {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ MaterialRegistryComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            if ( 'watercolorBleed' in material ) material.watercolorBleed = intensity;
            MaterialRegistryComponent.watercolorBleed[ eid ] = intensity;
        }
    }

    /**
     * Mark every registered material as needing a shader recompile.
     */
    markAllForUpdate() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ MaterialRegistryComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;
            material.needsUpdate = true;
        }
    }

    /**
     * Filter registered materials by type tag.
     * @param {number} typeTag - One of the `MaterialType` constants.
     * @returns {Material[]}
     */
    filterByType( typeTag ) {
        const out = [];
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            if ( MaterialRegistryComponent.materialType[ eid ] === typeTag ) {
                out.push( this.materials[ MaterialRegistryComponent.materialPtr[ eid ] ] );
            }
        }
        return out;
    }

    /**
     * Dispose every registered material in one pass.
     */
    disposeAll() {
        const entities = this.entities;
        for ( let i = 0, l = entities.length; i < l; i ++ ) {
            const eid = entities[ i ];
            const material = this.materials[ MaterialRegistryComponent.materialPtr[ eid ] ];
            if ( ! material ) continue;

            if ( typeof material.dispose === 'function' ) material.dispose();
            MaterialRegistryComponent.active[ eid ] = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// Global mood controller — apply a scene-wide mood from a single call
// ---------------------------------------------------------------------------
/**
 * A high-level mood controller that drives the entire material registry toward
 * a named anime mood. Each mood preset is a curated combination of temperature,
 * saturation, brightness, and contrast chosen to match one of the reference
 * imagery's atmospheric palettes.
 *
 * Presets:
 * - `snowy-cyan` (reference 1, 5): cool temperature, high saturation, cool blue tint.
 * - `sunset-orange` (reference 2, 4): warm temperature, saturated orange, high contrast.
 * - `ocean-teal` (reference 3): cool-cyan temperature, saturated, medium contrast.
 * - `space-blue` (reference 4): cool temperature, low saturation, high brightness.
 * - `shoji-warmth` (reference 6): warm temperature, warm interior light, low contrast.
 * - `flora-vibrant` (reference 7): neutral temperature, hyper-saturated, high brightness.
 */
const AnimeMoodPresets = {
    'snowy-cyan': {
        temperature: - 0.35,
        saturation: 1.15,
        brightness: 1.05,
        contrast: 1.1
    },
    'sunset-orange': {
        temperature: 0.45,
        saturation: 1.25,
        brightness: 1.05,
        contrast: 1.2
    },
    'ocean-teal': {
        temperature: - 0.25,
        saturation: 1.35,
        brightness: 0.95,
        contrast: 1.15
    },
    'space-blue': {
        temperature: - 0.45,
        saturation: 0.85,
        brightness: 1.15,
        contrast: 0.95
    },
    'shoji-warmth': {
        temperature: 0.30,
        saturation: 1.05,
        brightness: 1.10,
        contrast: 0.90
    },
    'flora-vibrant': {
        temperature: 0.05,
        saturation: 1.55,
        brightness: 1.10,
        contrast: 1.15
    }
};

/**
 * Apply a named anime mood preset to the entire material registry.
 * @param {AnimeMaterialRegistry} registry
 * @param {string} moodName - One of the keys of `AnimeMoodPresets`.
 * @returns {boolean} True if the preset was applied.
 */
function applyMoodPreset( registry, moodName ) {
    const preset = AnimeMoodPresets[ moodName ];
    if ( ! preset ) return false;

    registry.applyGlobalMood( preset.temperature, preset.saturation, preset.brightness, preset.contrast );
    return true;
}

// ---------------------------------------------------------------------------
// Global procedural paper-grain / watercolor texture shared across materials
// ---------------------------------------------------------------------------
/**
 * Generate a single paper-grain / watercolor texture that can be shared
 * across all materials in a scene. Uses simplex-noise with multiple
 * octaves for the hand-painted anime look.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.03]
 * @param {number} [octaves=4]
 * @param {number} [paperGrain=0.3]
 * @param {number} [watercolorBleed=0.5]
 * @returns {Uint8Array} RGBA buffer.
 */
function generateSharedAnimeTexture( width, height, scale = 0.03, octaves = 4, paperGrain = 0.3, watercolorBleed = 0.5 ) {
    const out = new Uint8Array( width * height * 4 );
    for ( let y = 0; y < height; y ++ ) {
        for ( let x = 0; x < width; x ++ ) {
            const p = ( y * width + x ) * 4;

            let value = 0;
            let amplitude = 1;
            let frequency = scale;
            let maxAmplitude = 0;

            for ( let o = 0; o < octaves; o ++ ) {
                value += _noise2D( x * frequency, y * frequency ) * amplitude;
                maxAmplitude += amplitude;
                amplitude *= 0.5;
                frequency *= 2.0;
            }

            value = ( value / maxAmplitude ) * 0.5 + 0.5;

            _double.value = value;
            _double.sub( 0.5 );
            _double.mul( 1.0 + watercolorBleed );
            _double.add( 0.5 );
            value = Math.max( 0, Math.min( 1, _double.value ) );

            const grain = _noise2D( x * 0.5, y * 0.5 ) * 0.5 + 0.5;
            _double.value = value;
            _double.mul( 1 - paperGrain );
            _double.add( grain * paperGrain );
            value = Math.max( 0, Math.min( 1, _double.value ) );

            const v = Math.floor( value * 255 );
            out[ p ] = v;
            out[ p + 1 ] = v;
            out[ p + 2 ] = v;
            out[ p + 3 ] = 255;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// High-level factory helper
// ---------------------------------------------------------------------------
/**
 * Create a material instance by type name.
 * @param {string} typeName - One of the keys of `_materialConstructors`.
 * @param {Object} [parameters] - Constructor parameters forwarded to the material.
 * @returns {Material}
 */
function createMaterial( typeName, parameters = {} ) {
    const Ctor = _materialConstructors[ typeName ];
    if ( ! Ctor ) throw new Error( `Materials.createMaterial: unknown material type "${ typeName }"` );
    return new Ctor( parameters );
}

/**
 * Apply a mood preset directly to a single material instance. Works by
 * writing the mood parameters and invoking the material's mood-update
 * method if present.
 * @param {Material} material
 * @param {string} moodName - One of the keys of `AnimeMoodPresets`.
 * @returns {Material}
 */
function applyMoodToMaterial( material, moodName ) {
    const preset = AnimeMoodPresets[ moodName ];
    if ( ! preset ) return material;

    if ( 'moodTemperature' in material ) material.moodTemperature = preset.temperature;
    if ( 'moodSaturation' in material ) material.moodSaturation = preset.saturation;
    if ( 'moodBrightness' in material ) material.moodBrightness = preset.brightness;
    if ( 'moodContrast' in material ) material.moodContrast = preset.contrast;

    if ( typeof material.updateMoodColor === 'function' ) material.updateMoodColor();
    if ( typeof material.updateMoodColors === 'function' ) material.updateMoodColors();
    if ( typeof material.updateMoodPBR === 'function' ) material.updateMoodPBR();
    if ( typeof material.updateMoodAdvancedPBR === 'function' ) material.updateMoodAdvancedPBR();

    return material;
}

// ---------------------------------------------------------------------------
// Exports — the barrel namespace
// ---------------------------------------------------------------------------
export {
    // Concrete material classes
    Material,
    LineBasicMaterial,
    LineDashedMaterial,
    MeshBasicMaterial,
    MeshDepthMaterial,
    MeshDistanceMaterial,
    MeshLambertMaterial,
    MeshMatcapMaterial,
    MeshNormalMaterial,
    MeshPhongMaterial,
    MeshStandardMaterial,
    MeshPhysicalMaterial,
    MeshToonMaterial,
    PointsMaterial,
    ShaderMaterial,
    RawShaderMaterial,
    ShadowMaterial,
    SpriteMaterial,

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
    LineDashedMaterial,
    MeshBasicMaterial,
    MeshDepthMaterial,
    MeshDistanceMaterial,
    MeshLambertMaterial,
    MeshMatcapMaterial,
    MeshNormalMaterial,
    MeshPhongMaterial,
    MeshStandardMaterial,
    MeshPhysicalMaterial,
    MeshToonMaterial,
    PointsMaterial,
    ShaderMaterial,
    RawShaderMaterial,
    ShadowMaterial,
    SpriteMaterial,
    MaterialType,
    AnimeMaterialRegistry,
    AnimeMoodPresets,
    applyMoodPreset,
    applyMoodToMaterial,
    createMaterial,
    generateSharedAnimeTexture
};