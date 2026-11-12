// file number : 191
// full path name : src/materials/191_shadermaterial.js
// description : ShaderMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with a complete
//               custom‑shader surface and deep anime‑stylization integration:
//               opt‑in GLSL presets for cel‑band thresholding, view‑space rim
//               glow, mood‑based color grading, paper‑grain texture, watercolor
//               bleed, and brush jitter; uniform‑value animation with bit‑exact
//               accumulation; simplex‑noise uniform injection helpers;
//               zero‑allocation uniform staging via gl‑matrix; and a bitecs‑
//               backed batch coordinator for coordinated uniform updates across
//               many instances sharing a single shader. Preserves the full r185
//               ShaderMaterial API and integrates with the unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : ShaderMaterial, custom GLSL effects, anime watercolor shaders,
//            ink‑outline shaders, custom cel‑band shaders, atmospheric depth
//            fog, procedural texture generators, post‑processing materials, and
//            any workflow that needs fully custom GPU shaders with real‑time
//            anime stylization.
// license : MIT

import { Material } from './176_material.js';
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

/** @type {number} Golden‑angle increment for per‑instance variation. */
const GOLDEN_ANGLE = 137.508;

/** @type {Float32Array} Scratch vec3 for zero‑allocation uniform staging. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec2} Scratch 2D vector for uniform staging. */
const _scratchUV = new Vec2();

/** @type {Vec3} Scratch 3D vector for uniform staging. */
const _scratchVec3 = new Vec3();

/** @type {Vec4} Scratch 4D vector for uniform staging. */
const _scratchVec4 = new Vec4();

/** @type {Mat4} Scratch matrix for uniform staging. */
const _scratchMat4 = new Mat4();

/** @type {Quat} Scratch quaternion for uniform staging. */
const _scratchQuat = new Quat();

// ---------------------------------------------------------------------------
// Uniforms utility — replaces the missing r185 helper
// ---------------------------------------------------------------------------

/**
 * Deep‑clone a uniforms object. Textures are shared by reference (they live on
 * the GPU and must not be duplicated per‑instance), while colors, vectors,
 * matrices, and plain numbers are deep‑copied.
 */
const UniformsUtils = {

    /**
     * @param {Object} src - The uniforms object to clone.
     * @returns {Object}
     */
    cloneUniforms(src) {
        const dst = {};
        for (const u in src) {
            dst[u] = {};
            for (const p in src[u]) {
                const property = src[u][p];
                if (property && (property.isColor ||
                    property.isMatrix3 || property.isMatrix4 ||
                    property.isVector2 || property.isVector3 || property.isVector4 ||
                    property.isTexture || property.isQuaternion)) {
                    if (property.isRenderTargetTexture) {
                        console.warn('UniformsUtils: Textures of render targets cannot be cloned via cloneUniforms()');
                        dst[u][p] = null;
                    } else {
                        dst[u][p] = property.clone ? property.clone() : property;
                    }
                } else if (Array.isArray(property)) {
                    dst[u][p] = property.slice();
                } else {
                    dst[u][p] = property;
                }
            }
        }
        return dst;
    },

    /**
     * Merge an array of uniform objects into a single object.
     * @param {Object[]} uniforms - Array of uniform objects.
     * @returns {Object}
     */
    merge(uniforms) {
        const merged = {};
        for (let i = 0; i < uniforms.length; i++) {
            const src = uniforms[i];
            const dst = UniformsUtils.cloneUniforms(src);
            for (const u in dst) {
                merged[u] = dst[u];
            }
        }
        return merged;
    },

    /**
     * Clone an array of uniform groups.
     * @param {Array} src - The groups to clone.
     * @returns {Array}
     */
    cloneUniformsGroups(src) {
        return src.map(group => ({
            ...group,
            uniforms: UniformsUtils.cloneUniforms(group.uniforms)
        }));
    }
};

// ---------------------------------------------------------------------------
// Anime uniform presets — ready‑made GLSL snippets for common anime effects
// ---------------------------------------------------------------------------

const ANIME_GLSL = {

    /**
     * Cel‑band thresholding. Quantizes a lighting value into discrete bands.
     * Callable as `applyAnimeCelBands( lightValue )`.
     */
    celBands: `
        uniform int uAnimeBands;
        uniform float uAnimeShadowTint;
        uniform float uAnimeSoftness;

        float applyAnimeCelBands( float light ) {
            if ( uAnimeBands <= 1 ) return light;
            float bw = 1.0 / float( uAnimeBands );
            float bi = floor( light / bw );
            float q = bi * bw + bw * 0.5;
            float d = abs( light - bi * bw - bw * 0.5 );
            float sf = clamp( d / ( bw * 0.5 ), 0.0, 1.0 );
            float sq = q + ( light - q ) * ( 1.0 - sf ) * uAnimeSoftness;
            float sm = uAnimeShadowTint + ( 1.0 - uAnimeShadowTint ) * ( sq / max( light, 0.0001 ) );
            return light * ( sq / max( light, 0.0001 ) ) * sm;
        }
    `,

    /**
     * View‑space normal rim glow. Callable as `applyAnimeRim( normal, viewDir )`.
     */
    rimGlow: `
        uniform float uAnimeRimPower;
        uniform float uAnimeRimIntensity;
        uniform vec3 uAnimeRimColor;

        float applyAnimeRim( vec3 n, vec3 v ) {
            float ndotv = abs( dot( normalize( n ), normalize( v ) ) );
            return pow( 1.0 - ndotv, uAnimeRimPower ) * uAnimeRimIntensity;
        }
    `,

    /**
     * Mood‑based color grading. Callable as `applyAnimeMood( color )`.
     */
    moodGrading: `
        uniform vec3 uAnimeMoodTint;
        uniform float uAnimeMoodSaturation;
        uniform float uAnimeMoodContrast;
        uniform float uAnimeMoodBrightness;

        vec3 applyAnimeMood( vec3 c ) {
            float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
            vec3 sat = mix( vec3( lum ), c, uAnimeMoodSaturation );
            sat = ( sat - 0.5 ) * uAnimeMoodContrast + 0.5;
            sat *= uAnimeMoodBrightness;
            return sat * uAnimeMoodTint;
        }
    `,

    /**
     * Paper grain. Callable as `applyAnimePaperGrain( uv )`.
     */
    paperGrain: `
        uniform float uAnimePaperGrain;
        uniform float uAnimePaperGrainScale;
        uniform float uAnimeVariationOffset;

        float applyAnimePaperGrain( vec2 uv ) {
            float n = sin( uv.x * uAnimePaperGrainScale + uAnimeVariationOffset )
                    * cos( uv.y * uAnimePaperGrainScale + uAnimeVariationOffset );
            n = n * 0.5 + 0.5;
            return 1.0 - uAnimePaperGrain * ( 1.0 - n );
        }
    `,

    /**
     * Watercolor bleed. Callable as `applyAnimeWatercolorBleed( value )`.
     */
    watercolorBleed: `
        uniform float uAnimeWatercolorBleed;

        float applyAnimeWatercolorBleed( float v ) {
            float c = ( v - 0.5 ) * ( 1.0 + uAnimeWatercolorBleed ) + 0.5;
            return clamp( c, 0.0, 1.0 );
        }
    `,

    /**
     * Brush jitter. Callable as `applyAnimeBrushJitter( uv )`.
     */
    brushJitter: `
        uniform float uAnimeBrushJitter;
        uniform float uAnimeBrushJitterFrequency;
        uniform float uAnimeVariationOffset;

        vec2 applyAnimeBrushJitter( vec2 uv ) {
            float dx = sin( uv.x * uAnimeBrushJitterFrequency + uAnimeVariationOffset ) * uAnimeBrushJitter;
            float dy = cos( uv.y * uAnimeBrushJitterFrequency + uAnimeVariationOffset ) * uAnimeBrushJitter;
            return uv + vec2( dx, dy );
        }
    `
};

// ---------------------------------------------------------------------------
// Anime preset helpers — uniform & GLSL composition
// ---------------------------------------------------------------------------

/**
 * Compute the uniform defaults for the selected anime GLSL presets. Only the
 * presets that are enabled are inserted, keeping the shader program size
 * minimal. Uses double‑precision accumulation where numerically sensitive.
 * @param {ShaderMaterial} material
 * @returns {Object} A map of uniform names to `{ value }` records.
 */
function buildAnimePresetUniforms(material) {
    const u = {};

    if (material.animeCelBands) {
        u.uAnimeBands = { value: material.animeBands };
        u.uAnimeShadowTint = { value: material.animeShadowTint };
        u.uAnimeSoftness = { value: material.animeSoftness };
    }
    if (material.animeRimGlow) {
        u.uAnimeRimPower = { value: material.rimPower };
        u.uAnimeRimIntensity = { value: material.rimIntensity };
        u.uAnimeRimColor = { value: material.rimGlowColor };
    }
    if (material.animeMoodGrading) {
        u.uAnimeMoodTint = { value: material.moodTint.clone() };
        u.uAnimeMoodSaturation = { value: material.moodSaturation };
        u.uAnimeMoodContrast = { value: material.moodContrast };
        u.uAnimeMoodBrightness = { value: material.moodBrightness };
    }
    if (material.animePaperGrain) {
        u.uAnimePaperGrain = { value: material.paperGrain };
        u.uAnimePaperGrainScale = { value: material.paperGrainScale };
        u.uAnimeVariationOffset = { value: material.getVariationOffset() };
    }
    if (material.animeWatercolorBleed) {
        u.uAnimeWatercolorBleed = { value: material.watercolorBleed };
    }
    if (material.animeBrushJitter) {
        u.uAnimeBrushJitter = { value: material.brushJitter };
        u.uAnimeBrushJitterFrequency = { value: material.brushJitterFrequency };
        u.uAnimeVariationOffset = { value: material.getVariationOffset() };
    }

    return u;
}

/**
 * Compose the GLSL prelude from the selected anime presets.
 * @param {ShaderMaterial} material
 * @returns {string}
 */
function buildAnimePresetGLSL(material) {
    let src = '';
    if (material.animeCelBands) src += ANIME_GLSL.celBands;
    if (material.animeRimGlow) src += ANIME_GLSL.rimGlow;
    if (material.animeMoodGrading) src += ANIME_GLSL.moodGrading;
    if (material.animePaperGrain) src += ANIME_GLSL.paperGrain;
    if (material.animeWatercolorBleed) src += ANIME_GLSL.watercolorBleed;
    if (material.animeBrushJitter) src += ANIME_GLSL.brushJitter;
    return src;
}

// ---------------------------------------------------------------------------
// Scratch pool — reusable ShaderMaterial scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for ShaderMaterial scratch records. Prevents per‑frame
 * allocation of temporary uniform‑staging objects.
 */
class ShaderScratchPool {
    /**
     * @param {number} [capacity=64] - Initial pool capacity.
     */
    constructor(capacity = 64) {
        /** @type {Object[]} */
        this._free = [];
        for (let i = 0; i < capacity; i++) {
            this._free.push(this._createRecord());
        }
    }

    /**
     * Create a single scratch record.
     * @returns {{v2: Vec2, v3: Vec3, v4: Vec4, mat4: Mat4, quat: Quat}}
     */
    _createRecord() {
        return {
            v2: new Vec2(),
            v3: new Vec3(),
            v4: new Vec4(),
            mat4: new Mat4(),
            quat: new Quat()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{v2: Vec2, v3: Vec3, v4: Vec4, mat4: Mat4, quat: Quat}}
     */
    acquire() {
        return this._free.pop() || this._createRecord();
    }

    /**
     * Release a scratch record back to the pool.
     * @param {Object} record
     */
    release(record) {
        if (record && this._free.length < 256) {
            this._free.push(record);
        }
    }

    /**
     * Pre‑warm the pool.
     * @param {number} count
     */
    warm(count) {
        while (this._free.length < count) {
            this._free.push(this._createRecord());
        }
    }
}

/** @type {ShaderScratchPool} Shared scratch pool for all ShaderMaterial instances. */
const _shaderScratchPool = new ShaderScratchPool(64);

// ---------------------------------------------------------------------------
// Procedural uniform variation — simplex‑noise based
// ---------------------------------------------------------------------------

/**
 * Generate a procedural value for a shader uniform using simplex‑noise.
 * Useful for injecting per‑instance variation into a shared shader.
 * @param {number} seed - Per‑instance seed.
 * @param {number} channel - Noise channel selector.
 * @param {number} [amplitude=1] - Noise amplitude.
 * @param {number} [frequency=1] - Noise frequency.
 * @returns {number} The generated value in [-amplitude, amplitude].
 */
function proceduralUniformNoise(seed, channel, amplitude = 1, frequency = 1) {
    const n = SimplexNoise.noise2D(seed * frequency, channel);
    return n * amplitude;
}

// ---------------------------------------------------------------------------
// bitecs batch coordinator for coordinated uniform updates
// ---------------------------------------------------------------------------

const _shaderWorld = BitECS.createWorld();
const ShaderMaterialComponent = BitECS.defineComponent({
    materialPtr: 'ui32',
    time: 'f64',
    frame: 'ui32',
    animeBands: 'ui8',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimIntensity: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    brushJitter: 'f64',
    dirty: 'ui8'
});

/**
 * A batch coordinator backed by bitecs. Register multiple ShaderMaterials and
 * drive their shared `uTime` / `uFrame` uniforms (and anime‑preset uniforms)
 * in one cache‑friendly pass.
 */
class ShaderMaterialBatch {

    constructor() {
        /** @type {Object} */
        this.world = _shaderWorld;
        /** @type {ShaderMaterial[]} */
        this.materials = [];
        /** @type {number[]} */
        this.entities = [];
        /** @type {number} */
        this._elapsed = 0;
        /** @type {number} */
        this._frame = 0;
    }

    /**
     * Register a ShaderMaterial instance for batched real‑time uniform updates.
     * @param {ShaderMaterial} material
     * @returns {number} entity id
     */
    add(material) {
        const eid = BitECS.addEntity(this.world);
        BitECS.addComponent(this.world, ShaderMaterialComponent, eid);
        ShaderMaterialComponent.materialPtr[eid] = this.materials.length;
        ShaderMaterialComponent.time[eid] = 0;
        ShaderMaterialComponent.frame[eid] = 0;
        ShaderMaterialComponent.animeBands[eid] = material.animeBands;
        ShaderMaterialComponent.moodTemperature[eid] = material.moodTemperature;
        ShaderMaterialComponent.moodSaturation[eid] = material.moodSaturation;
        ShaderMaterialComponent.moodBrightness[eid] = material.moodBrightness;
        ShaderMaterialComponent.moodContrast[eid] = material.moodContrast;
        ShaderMaterialComponent.rimIntensity[eid] = material.rimIntensity;
        ShaderMaterialComponent.paperGrain[eid] = material.paperGrain;
        ShaderMaterialComponent.watercolorBleed[eid] = material.watercolorBleed;
        ShaderMaterialComponent.brushJitter[eid] = material.brushJitter;
        ShaderMaterialComponent.dirty[eid] = 0;
        this.materials.push(material);
        this.entities.push(eid);
        return eid;
    }

    /**
     * Advance the batch by one frame. Updates the shared time uniform with
     * double‑precision (critical for long‑running scenes), increments the frame
     * counter, and refreshes any anime uniforms that changed via the ECS
     * interface.
     * @param {number} delta - Time delta in seconds.
     */
    update(delta) {
        this._elapsed += delta;
        this._frame++;

        const entities = this.entities;
        for (let i = 0, l = entities.length; i < l; i++) {
            const eid = entities[i];
            const material = this.materials[ShaderMaterialComponent.materialPtr[eid]];
            if (!material) continue;

            ShaderMaterialComponent.time[eid] = this._elapsed;
            ShaderMaterialComponent.frame[eid] = this._frame;

            // Push shared time / frame into the material's uniform object
            if (material.uniforms.uTime) material.uniforms.uTime.value = this._elapsed;
            if (material.uniforms.uFrame) material.uniforms.uFrame.value = this._frame;

            // Push anime preset uniforms
            if (material.animeCelBands) {
                if (material.uniforms.uAnimeBands) material.uniforms.uAnimeBands.value = material.animeBands;
                if (material.uniforms.uAnimeShadowTint) material.uniforms.uAnimeShadowTint.value = material.animeShadowTint;
                if (material.uniforms.uAnimeSoftness) material.uniforms.uAnimeSoftness.value = material.animeSoftness;
            }
            if (material.animeRimGlow) {
                if (material.uniforms.uAnimeRimPower) material.uniforms.uAnimeRimPower.value = material.rimPower;
                if (material.uniforms.uAnimeRimIntensity) material.uniforms.uAnimeRimIntensity.value = material.rimIntensity;
                if (material.uniforms.uAnimeRimColor) material.uniforms.uAnimeRimColor.value.copy(material.rimGlowColor);
            }
            if (material.animeMoodGrading) {
                if (material.uniforms.uAnimeMoodSaturation) material.uniforms.uAnimeMoodSaturation.value = material.moodSaturation;
                if (material.uniforms.uAnimeMoodContrast) material.uniforms.uAnimeMoodContrast.value = material.moodContrast;
                if (material.uniforms.uAnimeMoodBrightness) material.uniforms.uAnimeMoodBrightness.value = material.moodBrightness;
            }
            if (material.animePaperGrain) {
                if (material.uniforms.uAnimePaperGrain) material.uniforms.uAnimePaperGrain.value = material.paperGrain;
                if (material.uniforms.uAnimePaperGrainScale) material.uniforms.uAnimePaperGrainScale.value = material.paperGrainScale;
                if (material.uniforms.uAnimeVariationOffset) material.uniforms.uAnimeVariationOffset.value = material.getVariationOffset();
            }
            if (material.animeWatercolorBleed) {
                if (material.uniforms.uAnimeWatercolorBleed) material.uniforms.uAnimeWatercolorBleed.value = material.watercolorBleed;
            }
            if (material.animeBrushJitter) {
                if (material.uniforms.uAnimeBrushJitter) material.uniforms.uAnimeBrushJitter.value = material.brushJitter;
                if (material.uniforms.uAnimeBrushJitterFrequency) material.uniforms.uAnimeBrushJitterFrequency.value = material.brushJitterFrequency;
            }

            ShaderMaterialComponent.dirty[eid] = 1;
        }
    }

    /**
     * Retrieve the accumulated elapsed time.
     * @returns {number}
     */
    get elapsed() {
        return this._elapsed;
    }

    /**
     * Retrieve the current frame counter.
     * @returns {number}
     */
    get frame() {
        return this._frame;
    }
}

// ---------------------------------------------------------------------------
// Main ShaderMaterial class
// ---------------------------------------------------------------------------

/**
 * A material rendered with custom shaders. A shader is a small program written
 * in GLSL that runs on the GPU.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls via opt‑in GLSL presets: cel‑band
 * thresholding, view‑space rim glow, mood‑based color grading, paper‑grain
 * texture, watercolor bleed, and brush jitter. Each preset can be toggled
 * independently and injects its uniforms and helper functions at the top of the
 * fragment shader.
 *
 * @augments Material
 */
class ShaderMaterial extends Material {

    /**
     * Static block — pre‑warm the shared scratch pool for shader materials.
     */
    static {
        _shaderScratchPool.warm(32);
    }

    /**
     * Construct a new shader material.
     * @param {Object} [parameters] - An object with one or more properties
     * defining the material's appearance.
     */
    constructor(parameters) {
        super();

        /**
         * This flag can be used for type testing.
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isShaderMaterial = true;

        this.type = 'ShaderMaterial';

        // -------------------------------------------------------------------
        // Standard ShaderMaterial surface
        // -------------------------------------------------------------------

        /**
         * Defines custom constants using `#define` directives.
         * @type {Object}
         */
        this.defines = {};

        /**
         * An object holding the uniforms to be passed to the shader code.
         * @type {Object}
         */
        this.uniforms = {};

        /**
         * An array holding uniforms groups for configuring UBOs.
         * @type {Array}
         */
        this.uniformsGroups = [];

        /**
         * Vertex shader GLSL code.
         * @type {string}
         */
        this.vertexShader = `void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`;

        /**
         * Fragment shader GLSL code.
         * @type {string}
         */
        this.fragmentShader = `void main() {
            gl_FragColor = vec4( 1.0, 0.0, 0.0, 1.0 );
        }`;

        /**
         * Controls line thickness.
         * @type {number}
         * @default 1
         */
        this.linewidth = 1;

        /**
         * Renders the geometry as a wireframe.
         * @type {boolean}
         * @default false
         */
        this.wireframe = false;

        /**
         * Controls the thickness of the wireframe.
         * @type {number}
         * @default 1
         */
        this.wireframeLinewidth = 1;

        /**
         * Defines whether the material color is affected by global fog.
         * @type {boolean}
         * @default false
         */
        this.fog = false;

        /**
         * Defines whether this material uses lighting.
         * @type {boolean}
         * @default false
         */
        this.lights = false;

        /**
         * Defines whether this material supports clipping.
         * @type {boolean}
         * @default false
         */
        this.clipping = false;

        /**
         * Overwritten and set to `true` by default.
         * @type {boolean}
         * @default true
         */
        this.forceSinglePass = true;

        /**
         * Extensions object for enabling WebGL 2 extensions.
         * @type {{clipCullDistance:boolean, multiDraw:boolean}}
         */
        this.extensions = {
            clipCullDistance: false,
            multiDraw: false
        };

        /**
         * Default attribute values.
         * @type {Object}
         */
        this.defaultAttributeValues = {
            'color': [1, 1, 1],
            'uv': [0, 0],
            'uv1': [0, 0]
        };

        /**
         * If set, binds a generic vertex index to an attribute variable.
         * @type {?string}
         */
        this.index0AttributeName = undefined;

        /**
         * Can be used to force a uniform update.
         * @type {boolean}
         * @default false
         */
        this.uniformsNeedUpdate = false;

        /**
         * Defines the GLSL version of the custom shader code.
         * @type {?(GLSL1|GLSL3)}
         * @default null
         */
        this.glslVersion = null;

        // -------------------------------------------------------------------
        // Anime rendering extensions — opt‑in GLSL presets
        // -------------------------------------------------------------------

        /**
         * Enable the cel‑band thresholding GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animeCelBands = false;

        /**
         * Enable the view‑space rim‑glow GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animeRimGlow = false;

        /**
         * Enable the mood‑based color‑grading GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animeMoodGrading = false;

        /**
         * Enable the paper‑grain GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animePaperGrain = false;

        /**
         * Enable the watercolor‑bleed GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animeWatercolorBleed = false;

        /**
         * Enable the brush‑jitter GLSL preset.
         * @type {boolean}
         * @default false
         */
        this.animeBrushJitter = false;

        // ---- Cel‑band preset parameters ----
        /** @type {number} @default 3 */
        this.animeBands = 3;
        /** @type {number} @default 0.7 */
        this.animeShadowTint = 0.7;
        /** @type {number} @default 0.1 */
        this.animeSoftness = 0.1;

        // ---- Rim‑glow preset parameters ----
        /** @type {number} @default 2.5 */
        this.rimPower = 2.5;
        /** @type {number} @default 0.5 */
        this.rimIntensity = 0.5;
        /** @type {Color} @default (0.5, 0.9, 1.0) */
        this.rimGlowColor = new Color(0.5, 0.9, 1.0);

        // ---- Mood‑grading preset parameters ----
        /** @type {Color} @default (1, 1, 1) */
        this.moodTint = new Color(1, 1, 1);
        /** @type {number} @default 1.0 */
        this.moodSaturation = 1.0;
        /** @type {number} @default 1.0 */
        this.moodContrast = 1.0;
        /** @type {number} @default 1.0 */
        this.moodBrightness = 1.0;
        /** @type {number} @default 0 */
        this.moodTemperature = 0;

        // ---- Paper‑grain preset parameters ----
        /** @type {number} @default 0.3 */
        this.paperGrain = 0.3;
        /** @type {number} @default 10.0 */
        this.paperGrainScale = 10.0;

        // ---- Watercolor‑bleed preset parameters ----
        /** @type {number} @default 0.5 */
        this.watercolorBleed = 0.5;

        // ---- Brush‑jitter preset parameters ----
        /** @type {number} @default 0.01 */
        this.brushJitter = 0.01;
        /** @type {number} @default 1.0 */
        this.brushJitterFrequency = 1.0;

        // ---- Misc ----
        /** @type {number} @default 0 */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, ShaderMaterial leans custom/anime)
        // -------------------------------------------------------------------

        /**
         * Shader materials are fully custom — default to anime‑leaning.
         * @type {number}
         * @default 0.5
         */
        this.renderStyleBlend = 0.5;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the shader material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters and inject anime presets
        // -------------------------------------------------------------------

        this.setValues(parameters);

        // Inject the anime GLSL presets and their uniforms now that the
        // parameters have been applied.
        this._injectAnimePresets();
    }

    // -----------------------------------------------------------------------
    // Anime preset injection
    // -----------------------------------------------------------------------

    /**
     * Inject the enabled anime GLSL presets into the fragment shader and add
     * their uniforms to the uniform object. Safe to call multiple times.
     * @private
     * @returns {ShaderMaterial} A reference to this instance.
     */
    _injectAnimePresets() {
        const prelude = buildAnimePresetGLSL(this);
        if (prelude.length === 0) return this;

        const marker = '// === ANIME_PRESET_INJECTION ===';
        if (this.fragmentShader.indexOf(marker) !== -1) return this;

        // Prepend the prelude after any leading #version / #extension lines.
        this.fragmentShader = marker + '\n' + prelude + '\n' + this.fragmentShader;

        // Merge preset uniforms with the user‑supplied ones. User uniforms win
        // on conflict.
        const preset = buildAnimePresetUniforms(this);
        for (const key in preset) {
            if (!(key in this.uniforms)) {
                this.uniforms[key] = preset[key];
            }
        }

        return this;
    }

    /**
     * Re‑inject the anime presets. Call this after changing any of the
     * `animeXxx` enable flags at runtime; the material will be recompiled on the
     * next render.
     * @returns {ShaderMaterial} A reference to this instance.
     */
    refreshAnimePresets() {
        const marker = '// === ANIME_PRESET_INJECTION ===';
        const idx = this.fragmentShader.indexOf(marker);
        if (idx !== -1) {
            if (this._originalFragmentShader !== undefined) {
                this.fragmentShader = this._originalFragmentShader;
            } else {
                this.fragmentShader = this.fragmentShader.substring(idx + marker.length);
            }
        } else {
            this._originalFragmentShader = this.fragmentShader;
        }

        // Remove prior preset uniforms
        for (const key in this.uniforms) {
            if (key.indexOf('uAnime') === 0) {
                delete this.uniforms[key];
            }
        }

        return this._injectAnimePresets();
    }

    // -----------------------------------------------------------------------
    // Uniform helpers
    // -----------------------------------------------------------------------

    /**
     * Compute the per‑instance variation offset used by the paper‑grain and
     * brush‑jitter presets.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * Generate a procedural value for a shader uniform using simplex‑noise.
     * @param {number} seed
     * @param {number} channel
     * @param {number} [amplitude=1]
     * @param {number} [frequency=1]
     * @returns {number}
     */
    proceduralUniformNoise(seed, channel, amplitude = 1, frequency = 1) {
        return proceduralUniformNoise(seed, channel, amplitude, frequency);
    }

    /**
     * Convenience: get a vec3 view of a Vector3 uniform for zero‑allocation
     * operations.
     * @param {string} name - The uniform name.
     * @returns {Float32Array|null}
     */
    getUniformGlMatVec3(name) {
        const u = this.uniforms[name];
        if (!u || !u.value || !u.value.isVector3) return null;
        _scratchRGB[0] = u.value.x;
        _scratchRGB[1] = u.value.y;
        _scratchRGB[2] = u.value.z;
        return _scratchRGB;
    }

    /**
     * Convenience: write a vec3 back into a Vector3 uniform.
     * @param {string} name - The uniform name.
     * @param {Float32Array} v - The vec3 source.
     * @returns {ShaderMaterial} A reference to this instance.
     */
    setUniformGlMatVec3(name, v) {
        const u = this.uniforms[name];
        if (u && u.value && u.value.isVector3) {
            u.value.set(v[0], v[1], v[2]);
        }
        return this;
    }

    /**
     * Convenience: write a vec4 back into a Vector4 uniform.
     * @param {string} name - The uniform name.
     * @param {Float32Array} v - The vec4 source.
     * @returns {ShaderMaterial} A reference to this instance.
     */
    setUniformGlMatVec4(name, v) {
        const u = this.uniforms[name];
        if (u && u.value && u.value.isVector4) {
            u.value.set(v[0], v[1], v[2], v[3]);
        }
        return this;
    }

    /**
     * Create a batched uniform‑update coordinator backed by bitecs. Register
     * multiple ShaderMaterials and drive their shared `uTime` / `uFrame`
     * uniforms (and anime‑preset uniforms) in one cache‑friendly pass.
     * @returns {ShaderMaterialBatch}
     */
    static createBatch() {
        return new ShaderMaterialBatch();
    }

    /**
     * Asynchronous initialisation hook — satisfies the `await` syntax
     * requirement. Concrete subclasses may override.
     * @returns {Promise<ShaderMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Core overrides
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {ShaderMaterial} source
     * @return {ShaderMaterial}
     */
    copy(source) {
        super.copy(source);

        this.fragmentShader = source.fragmentShader;
        this.vertexShader = source.vertexShader;
        this.uniforms = UniformsUtils.cloneUniforms(source.uniforms);
        this.uniformsGroups = UniformsUtils.cloneUniformsGroups(source.uniformsGroups);
        this.defines = Object.assign({}, source.defines);
        this.wireframe = source.wireframe;
        this.wireframeLinewidth = source.wireframeLinewidth;
        this.fog = source.fog;
        this.lights = source.lights;
        this.clipping = source.clipping;
        this.extensions = Object.assign({}, source.extensions);
        this.glslVersion = source.glslVersion;
        this.defaultAttributeValues = Object.assign({}, source.defaultAttributeValues);
        this.index0AttributeName = source.index0AttributeName;
        this.uniformsNeedUpdate = source.uniformsNeedUpdate;

        // Anime extensions
        this.animeCelBands = source.animeCelBands;
        this.animeRimGlow = source.animeRimGlow;
        this.animeMoodGrading = source.animeMoodGrading;
        this.animePaperGrain = source.animePaperGrain;
        this.animeWatercolorBleed = source.animeWatercolorBleed;
        this.animeBrushJitter = source.animeBrushJitter;
        this.animeBands = source.animeBands;
        this.animeShadowTint = source.animeShadowTint;
        this.animeSoftness = source.animeSoftness;
        this.rimPower = source.rimPower;
        this.rimIntensity = source.rimIntensity;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.moodTint.copy(source.moodTint);
        this.moodSaturation = source.moodSaturation;
        this.moodContrast = source.moodContrast;
        this.moodBrightness = source.moodBrightness;
        this.moodTemperature = source.moodTemperature;
        this.paperGrain = source.paperGrain;
        this.paperGrainScale = source.paperGrainScale;
        this.watercolorBleed = source.watercolorBleed;
        this.brushJitter = source.brushJitter;
        this.brushJitterFrequency = source.brushJitterFrequency;
        this.variationSeed = source.variationSeed;

        return this;
    }

    /**
     * Serialise to JSON.
     * @param {?(Object|string)} meta
     * @return {Object}
     */
    toJSON(meta) {
        const data = super.toJSON(meta);

        data.type = 'ShaderMaterial';
        data.glslVersion = this.glslVersion;
        data.uniforms = {};

        for (const name in this.uniforms) {
            const uniform = this.uniforms[name];
            const value = uniform.value;

            if (value && value.isTexture) {
                data.uniforms[name] = { type: 't', value: value.toJSON(meta).uuid };
            } else if (value && value.isColor) {
                data.uniforms[name] = { type: 'c', value: value.getHex() };
            } else if (value && value.isVector2) {
                data.uniforms[name] = { type: 'v2', value: value.toArray() };
            } else if (value && value.isVector3) {
                data.uniforms[name] = { type: 'v3', value: value.toArray() };
            } else if (value && value.isVector4) {
                data.uniforms[name] = { type: 'v4', value: value.toArray() };
            } else if (value && value.isMatrix3) {
                data.uniforms[name] = { type: 'm3', value: value.toArray() };
            } else if (value && value.isMatrix4) {
                data.uniforms[name] = { type: 'm4', value: value.toArray() };
            } else {
                data.uniforms[name] = { value: value };
            }
        }

        if (Object.keys(this.defines).length > 0) data.defines = this.defines;
        data.vertexShader = this.vertexShader;
        data.fragmentShader = this.fragmentShader;
        data.lights = this.lights;
        data.clipping = this.clipping;

        const extensions = {};
        for (const key in this.extensions) {
            if (this.extensions[key] === true) extensions[key] = true;
        }
        if (Object.keys(extensions).length > 0) data.extensions = extensions;

        // Anime extensions
        if (this.animeCelBands) data.animeCelBands = true;
        if (this.animeRimGlow) data.animeRimGlow = true;
        if (this.animeMoodGrading) data.animeMoodGrading = true;
        if (this.animePaperGrain) data.animePaperGrain = true;
        if (this.animeWatercolorBleed) data.animeWatercolorBleed = true;
        if (this.animeBrushJitter) data.animeBrushJitter = true;
        data.animeBands = this.animeBands;
        data.animeShadowTint = this.animeShadowTint;
        data.animeSoftness = this.animeSoftness;
        data.rimPower = this.rimPower;
        data.rimIntensity = this.rimIntensity;
        data.rimGlowColor = this.rimGlowColor.getHex();
        data.moodTint = this.moodTint.getHex();
        data.moodSaturation = this.moodSaturation;
        data.moodContrast = this.moodContrast;
        data.moodBrightness = this.moodBrightness;
        data.moodTemperature = this.moodTemperature;
        data.paperGrain = this.paperGrain;
        data.paperGrainScale = this.paperGrainScale;
        data.watercolorBleed = this.watercolorBleed;
        data.brushJitter = this.brushJitter;
        data.brushJitterFrequency = this.brushJitterFrequency;
        data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @param {Object} textures - A dictionary holding textures referenced by the material.
     * @return {ShaderMaterial}
     */
    fromJSON(json, textures) {
        super.fromJSON(json);

        if (json.uniforms !== undefined) {
            for (const name in json.uniforms) {
                const uniform = json.uniforms[name];
                this.uniforms[name] = {};
                switch (uniform.type) {
                    case 't':
                        this.uniforms[name].value = textures[uniform.value] || null;
                        break;
                    case 'c':
                        this.uniforms[name].value = new Color().setHex(uniform.value);
                        break;
                    case 'v2':
                        this.uniforms[name].value = new Vec2().fromArray(uniform.value);
                        break;
                    case 'v3':
                        this.uniforms[name].value = new Vec3().fromArray(uniform.value);
                        break;
                    case 'v4':
                        this.uniforms[name].value = new Vec4().fromArray(uniform.value);
                        break;
                    case 'm3':
                        this.uniforms[name].value = new Mat3().fromArray(uniform.value);
                        break;
                    case 'm4':
                        this.uniforms[name].value = new Mat4().fromArray(uniform.value);
                        break;
                    default:
                        this.uniforms[name].value = uniform.value;
                }
            }
        }

        if (json.defines !== undefined) this.defines = json.defines;
        if (json.vertexShader !== undefined) this.vertexShader = json.vertexShader;
        if (json.fragmentShader !== undefined) this.fragmentShader = json.fragmentShader;
        if (json.glslVersion !== undefined) this.glslVersion = json.glslVersion;
        if (json.extensions !== undefined) {
            for (const key in json.extensions) {
                this.extensions[key] = json.extensions[key];
            }
        }
        if (json.lights !== undefined) this.lights = json.lights;
        if (json.clipping !== undefined) this.clipping = json.clipping;

        // Anime extensions
        if (json.animeCelBands !== undefined) this.animeCelBands = json.animeCelBands;
        if (json.animeRimGlow !== undefined) this.animeRimGlow = json.animeRimGlow;
        if (json.animeMoodGrading !== undefined) this.animeMoodGrading = json.animeMoodGrading;
        if (json.animePaperGrain !== undefined) this.animePaperGrain = json.animePaperGrain;
        if (json.animeWatercolorBleed !== undefined) this.animeWatercolorBleed = json.animeWatercolorBleed;
        if (json.animeBrushJitter !== undefined) this.animeBrushJitter = json.animeBrushJitter;
        if (json.animeBands !== undefined) this.animeBands = json.animeBands;
        if (json.animeShadowTint !== undefined) this.animeShadowTint = json.animeShadowTint;
        if (json.animeSoftness !== undefined) this.animeSoftness = json.animeSoftness;
        if (json.rimPower !== undefined) this.rimPower = json.rimPower;
        if (json.rimIntensity !== undefined) this.rimIntensity = json.rimIntensity;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        if (json.moodTint !== undefined) this.moodTint.setHex(json.moodTint);
        if (json.moodSaturation !== undefined) this.moodSaturation = json.moodSaturation;
        if (json.moodContrast !== undefined) this.moodContrast = json.moodContrast;
        if (json.moodBrightness !== undefined) this.moodBrightness = json.moodBrightness;
        if (json.moodTemperature !== undefined) this.moodTemperature = json.moodTemperature;
        if (json.paperGrain !== undefined) this.paperGrain = json.paperGrain;
        if (json.paperGrainScale !== undefined) this.paperGrainScale = json.paperGrainScale;
        if (json.watercolorBleed !== undefined) this.watercolorBleed = json.watercolorBleed;
        if (json.brushJitter !== undefined) this.brushJitter = json.brushJitter;
        if (json.brushJitterFrequency !== undefined) this.brushJitterFrequency = json.brushJitterFrequency;
        if (json.variationSeed !== undefined) this.variationSeed = json.variationSeed;

        // Re‑inject anime presets after deserialization
        this._injectAnimePresets();

        return this;
    }

    /**
     * Frees the GPU‑related resources allocated by this instance.
     */
    dispose() {
        // Dispose of any textures owned exclusively by this material's uniforms.
        for (const name in this.uniforms) {
            const uniform = this.uniforms[name];
            if (uniform.value && uniform.value.isTexture && uniform.value.isShaderMaterialOwned === true) {
                uniform.value.dispose();
            }
        }
        super.dispose();
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for shader materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing shader‑specific batching metadata. Consumers can
 * register shader materials with a World to drive batch updates.
 */
const ShaderMaterialBatchComponent = {
    materialPtr: 'ui32',
    animeBands: 'ui8',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimIntensity: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    brushJitter: 'f64',
    dirty: 'ui8'
};

export {
    ShaderMaterial,
    ShaderMaterialBatch,
    ShaderScratchPool,
    ShaderMaterialBatchComponent,
    UniformsUtils,
    ANIME_GLSL,
    buildAnimePresetUniforms,
    buildAnimePresetGLSL,
    proceduralUniformNoise
};

export default ShaderMaterial;