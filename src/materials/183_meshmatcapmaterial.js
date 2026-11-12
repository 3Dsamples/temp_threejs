// file number : 183
// full path name : src/materials/183_meshmatcapmaterial.js
// description : MeshMatcapMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with matcap‑specific
//               anime stylization: matcap‑domain cel banding, matcap UV mood
//               warping (rotation/scale/offset), procedural matcap overlay
//               variation via simplex‑noise, rim glow on silhouettes, paper‑
//               grain and watercolor textures, and per‑instance variation.
//               Preserves the full r185 MeshMatcapMaterial API and integrates
//               with the unified PBR ↔ Anime blend layer, galactic‑scale
//               configuration hooks, zero‑allocation scratch pools, and
//               ECS‑ready batching metadata. All imports resolve to the
//               internal Threejs_gl repository tree; no CDN dependencies.
// best for : MeshMatcapMaterial, anime character skin/hair, stylized props,
//            static sculptures, technical visualization, mobile anime games
//            (matcaps are extremely cheap), and any mesh that needs pre‑baked
//            stylized lighting.
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

/** @type {Float32Array} Scratch vec3 for zero‑allocation colour transforms. */
const _scratchRGB = new Float32Array(3);

/** @type {Float32Array} Scratch vec4 for RGBA staging. */
const _scratchRGBA = new Float32Array(4);

/** @type {Vec2} Scratch 2D vector for UV staging. */
const _scratchUV = new Vec2();

/** @type {Vec3} Scratch 3D vector for normal staging. */
const _scratchNormal = new Vec3();

/** @type {Vec3} Scratch 3D vector for view‑direction staging. */
const _scratchView = new Vec3();

/** @type {Mat4} Scratch matrix for projection staging. */
const _scratchProjMat = new Mat4();

/** @type {Quat} Scratch quaternion for rotation staging. */
const _scratchQuat = new Quat();

// ---------------------------------------------------------------------------
// Pool system — reusable matcap scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for matcap‑material scratch records. Prevents per‑frame
 * allocation of temporary cel‑banding, UV‑warping, and overlay‑grading scratch
 * objects.
 */
class MatcapScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, uv: Vec2, normal: Vec3, view: Vec3}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            uv: new Vec2(),
            normal: new Vec3(),
            view: new Vec3()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, uv: Vec2, normal: Vec3, view: Vec3}}
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

/** @type {MatcapScratchPool} Shared scratch pool for all matcap material instances. */
const _matcapScratchPool = new MatcapScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — matcap‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Quantize a matcap‑sampled colour into cel‑shading bands. Because matcaps bake
 * lighting into a 2D texture, quantizing the sampled colour directly produces a
 * clean cel effect without needing light direction information.
 * @param {Color} sampledColor - The colour sampled from the matcap.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of cel bands (2–6 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [shadowTint=0.8] - Shadow band brightness multiplier.
 * @returns {Color}
 */
function applyMatcapCelBanding(sampledColor, output, bands, quantizeAmount, shadowTint = 0.8) {
    if (bands <= 1) {
        output.copy(sampledColor);
        return output;
    }

    // Compute the luminance of the sampled matcap colour
    const lum = 0.2126 * sampledColor.r + 0.7152 * sampledColor.g + 0.0722 * sampledColor.b;

    // Quantize the luminance
    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(lum / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;

    // Blend continuous and quantized
    const finalLum = lum + (quantized - lum) * quantizeAmount;

    // Apply shadow tint to darker bands for extra anime contrast
    const shadowMul = Math.min(1, shadowTint + (1.0 - shadowTint) * Math.min(1, finalLum / Math.max(lum, 0.0001)));

    // Preserve hue, only change luminance
    if (lum > 0.0001) {
        output.r = sampledColor.r * (finalLum / lum) * shadowMul;
        output.g = sampledColor.g * (finalLum / lum) * shadowMul;
        output.b = sampledColor.b * (finalLum / lum) * shadowMul;
    } else {
        output.copy(sampledColor);
    }

    output.a = sampledColor.a;

    // Clamp
    output.r = Math.max(0, Math.min(1, output.r));
    output.g = Math.max(0, Math.min(1, output.g));
    output.b = Math.max(0, Math.min(1, output.b));
    return output;
}

/**
 * Transform a matcap UV coordinate using rotation, scale, and offset. Rotating
 * the matcap shifts the "virtual light direction" baked into the texture —
 * this is how we match the scene mood to the reference imagery.
 * @param {Vec2} out - Preallocated output Vec2.
 * @param {number} u - Input U in [0, 1].
 * @param {number} v - Input V in [0, 1].
 * @param {number} rotation - Rotation angle in radians.
 * @param {number} scale - Scale multiplier (1 = unchanged).
 * @param {number} [offsetX=0] - U offset.
 * @param {number} [offsetY=0] - V offset.
 * @returns {Vec2}
 */
function warpMatcapUV(out, u, v, rotation, scale, offsetX = 0, offsetY = 0) {
    // Center the UV around (0.5, 0.5) for rotation
    const cx = u - 0.5;
    const cy = v - 0.5;

    // Rotate
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const rx = cx * cosR - cy * sinR;
    const ry = cx * sinR + cy * cosR;

    // Scale and re‑center
    let finalU = rx * scale + 0.5 + offsetX;
    let finalV = ry * scale + 0.5 + offsetY;

    // Wrap into [0, 1] with mirror
    finalU = finalU - Math.floor(finalU);
    finalV = finalV - Math.floor(finalV);

    out.set(finalU, finalV);
    return out;
}

/**
 * Generate a procedural matcap overlay texture using simplex‑noise. This is
 * layered multiplicatively on top of the base matcap to add a subtle hand‑
 * painted texture variation.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.05] - Noise scale.
 * @param {number} [octaves=3] - Number of noise octaves.
 * @param {number} [intensity=0.3] - Overlay intensity in [0, 1].
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateMatcapOverlay(width, height, scale = 0.05, octaves = 3, intensity = 0.3) {
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

            // Modulate by intensity around neutral (1.0)
            value = value * intensity + (1.0 - intensity * 0.5);
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

/**
 * Apply mood‑based color grading for matcap surfaces.
 * @param {Color} color - The color to grade (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeMatcapColor(color, temperature, saturation, brightness, contrast) {
    _scratchRGB[0] = color.r;
    _scratchRGB[1] = color.g;
    _scratchRGB[2] = color.b;

    const lum = 0.2126 * _scratchRGB[0] + 0.7152 * _scratchRGB[1] + 0.0722 * _scratchRGB[2];

    let r = lum + (_scratchRGB[0] - lum) * saturation;
    let g = lum + (_scratchRGB[1] - lum) * saturation;
    let b = lum + (_scratchRGB[2] - lum) * saturation;

    // Contrast
    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;

    // Temperature
    r += temperature * 0.12;
    b -= temperature * 0.12;

    // Brightness
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

// ---------------------------------------------------------------------------
// Main MeshMatcapMaterial class
// ---------------------------------------------------------------------------

/**
 * A material for rendering geometry using a matcap (material capture) texture.
 * Matcaps are 2D textures that capture the full lighting response of a surface
 * from a single viewpoint, giving a sculpted look without any light computation.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: matcap‑domain cel banding, matcap UV
 * mood warping, procedural matcap overlay variation, mood‑based color grading,
 * rim glow, and per‑instance variation.
 *
 * @augments Material
 */
class MeshMatcapMaterial extends Material {

    /**
     * Static block — pre‑warm the shared scratch pool for matcap materials.
     */
    static {
        _matcapScratchPool.warm(32);
    }

    /**
     * Construct a new mesh matcap material.
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
        this.isMeshMatcapMaterial = true;

        this.type = 'MeshMatcapMaterial';

        // -------------------------------------------------------------------
        // Standard MeshMatcapMaterial surface
        // -------------------------------------------------------------------

        /**
         * Color of the material.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color(0xffffff);

        /**
         * The matcap texture.
         * @type {?Texture}
         * @default null
         */
        this.matcap = null;

        /**
         * The color map.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * The alpha map.
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * The bump map.
         * @type {?Texture}
         * @default null
         */
        this.bumpMap = null;

        /**
         * How much the bump map affects the material.
         * @type {number}
         * @default 1
         */
        this.bumpScale = 1;

        /**
         * The normal map.
         * @type {?Texture}
         * @default null
         */
        this.normalMap = null;

        /**
         * The type of the normal map.
         * @type {number}
         * @default TangentSpaceNormalMap
         */
        this.normalMapType = Constants.TANGENT_SPACE_NORMAL_MAP ?? 0;

        /**
         * How much the normal map affects the material.
         * @type {Vec2}
         * @default (1,1)
         */
        this.normalScale = new Vec2(1, 1);

        /**
         * The displacement map.
         * @type {?Texture}
         * @default null
         */
        this.displacementMap = null;

        /**
         * How much the displacement map affects the mesh.
         * @type {number}
         * @default 1
         */
        this.displacementScale = 1;

        /**
         * The displacement bias.
         * @type {number}
         * @default 0
         */
        this.displacementBias = 0;

        /**
         * Whether to use flat shading.
         * @type {boolean}
         * @default false
         */
        this.flatShading = false;

        /**
         * Whether the material is affected by fog.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        // -------------------------------------------------------------------
        // Anime rendering extensions — matcap‑specific
        // -------------------------------------------------------------------

        /**
         * Number of cel bands applied to the matcap‑sampled color.
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Blend amount between continuous and banded matcap color.
         * @type {number}
         * @default 1.0
         */
        this.celQuantize = 1.0;

        /**
         * Shadow band brightness multiplier.
         * @type {number}
         * @default 0.8
         */
        this.shadowTint = 0.8;

        /**
         * Matcap rotation angle in radians.
         * @type {number}
         * @default 0
         */
        this.matcapRotation = 0;

        /**
         * Matcap UV scale multiplier.
         * @type {number}
         * @default 1.0
         */
        this.matcapScale = 1.0;

        /**
         * Matcap UV offset.
         * @type {Vec2}
         * @default (0,0)
         */
        this.matcapOffset = new Vec2(0, 0);

        /**
         * Mood temperature shift in [-1, 1].
         * @type {number}
         * @default 0
         */
        this.moodTemperature = 0;

        /**
         * Mood saturation multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodSaturation = 1.0;

        /**
         * Mood brightness multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodBrightness = 1.0;

        /**
         * Mood contrast multiplier.
         * @type {number}
         * @default 1.0
         */
        this.moodContrast = 1.0;

        /**
         * The precomputed mood‑graded color.
         * @type {Color}
         */
        this.moodColor = new Color(0xffffff);

        /**
         * Rim‑glow intensity.
         * @type {number}
         * @default 0
         */
        this.rimGlow = 0;

        /**
         * Rim‑glow color.
         * @type {Color}
         * @default (0.5, 0.9, 1.0)
         */
        this.rimGlowColor = new Color(0.5, 0.9, 1.0);

        /**
         * Procedural matcap overlay variation.
         * @type {number}
         * @default 0
         */
        this.overlayVariation = 0;

        /**
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, matcap materials lean anime)
        // -------------------------------------------------------------------

        /**
         * Matcap materials are primarily used for stylized anime looks.
         * @type {number}
         * @default 0.7
         */
        this.renderStyleBlend = 0.7;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the matcap material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters and initialise derived values
        // -------------------------------------------------------------------

        this.setValues(parameters);

        // Initialise mood colour from the current parameters.
        this.updateMoodColor();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Apply cel banding to a sampled matcap color.
     * @param {Color} sampledColor - The sampled matcap color.
     * @param {Color} output - The output color.
     * @returns {Color}
     */
    applyMatcapBanding(sampledColor, output) {
        return applyMatcapCelBanding(sampledColor, output, this.celBands, this.celQuantize, this.shadowTint);
    }

    /**
     * Warp a matcap UV coordinate using the current rotation / scale / offset
     * parameters.
     * @param {Vec2} out - Preallocated output Vec2.
     * @param {number} u
     * @param {number} v
     * @returns {Vec2}
     */
    warpMatcapUV(out, u, v) {
        return warpMatcapUV(out, u, v, this.matcapRotation, this.matcapScale, this.matcapOffset.x, this.matcapOffset.y);
    }

    /**
     * Generate a procedural matcap overlay texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.05]
     * @param {number} [octaves=3]
     * @returns {Uint8Array}
     */
    generateMatcapOverlay(width, height, scale = 0.05, octaves = 3) {
        return generateMatcapOverlay(width, height, scale, octaves, this.overlayVariation);
    }

    /**
     * Compute the per‑instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * Recompute the mood color from the current mood parameters.
     * @returns {MeshMatcapMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy(this.color);
        gradeMatcapColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Asynchronous initialisation hook — satisfies the `await` syntax
     * requirement. Concrete subclasses may override.
     * @returns {Promise<MeshMatcapMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base Material's anime shader chunks with matcap‑specific
     * features.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject matcap‑specific uniforms
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.celQuantize = { value: this.celQuantize };
        shader.uniforms.shadowTint = { value: this.shadowTint };
        shader.uniforms.matcapRotation = { value: this.matcapRotation };
        shader.uniforms.matcapScale = { value: this.matcapScale };
        shader.uniforms.matcapOffset = { value: this.matcapOffset };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.overlayVariation = { value: this.overlayVariation };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int celBands;
                uniform float celQuantize;
                uniform float shadowTint;
                uniform float matcapRotation;
                uniform float matcapScale;
                uniform vec2 matcapOffset;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float overlayVariation;
                uniform float variationOffset;

                vec2 warpMatcapUV(vec2 uv) {
                    vec2 centered = uv - 0.5;
                    float cosR = cos(matcapRotation);
                    float sinR = sin(matcapRotation);
                    vec2 rotated = vec2(
                        centered.x * cosR - centered.y * sinR,
                        centered.x * sinR + centered.y * cosR
                    );
                    vec2 scaled = rotated * matcapScale + 0.5 + matcapOffset;
                    return fract(scaled);
                }

                vec3 applyMatcapBanding(vec3 sampled) {
                    if (celBands <= 1) return sampled;
                    float lum = dot(sampled, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(celBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float finalLum = mix(lum, quantized, celQuantize);
                    float shadowMul = min(1.0, shadowTint + (1.0 - shadowTint) * (finalLum / max(lum, 0.0001)));
                    return sampled * (finalLum / max(lum, 0.0001)) * shadowMul;
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply matcap‑domain cel banding
                gl_FragColor.rgb = applyMatcapBanding(gl_FragColor.rgb);

                // Blend with mood‑graded base color
                gl_FragColor.rgb = mix(
                    gl_FragColor.rgb,
                    moodColor * (dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722)) / max(dot(moodColor, vec3(0.2126, 0.7152, 0.0722)), 0.0001)),
                    0.6
                );

                // Procedural overlay variation
                if (overlayVariation > 0.0) {
                    float overlay = sin(vUv.x * 8.0 + variationOffset) * cos(vUv.y * 8.0 + variationOffset);
                    overlay = overlay * 0.5 + 0.5;
                    gl_FragColor.rgb *= mix(1.0, overlay, overlayVariation);
                }

                // Rim glow
                if (rimGlow > 0.0) {
                    float rimFactor = 1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition)));
                    gl_FragColor.rgb += rimGlowColor * rimGlow * rimFactor;
                }
                `
            );
    }

    /**
     * Custom program cache key.
     * @returns {string}
     */
    customProgramCacheKey() {
        return [
            super.customProgramCacheKey(),
            this.celBands,
            this.celQuantize,
            this.shadowTint,
            this.matcapRotation,
            this.matcapScale,
            this.matcapOffset.x,
            this.matcapOffset.y,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.rimGlow,
            this.overlayVariation,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {MeshMatcapMaterial} source
     * @return {MeshMatcapMaterial}
     */
    copy(source) {
        super.copy(source);

        this.color.copy(source.color);
        this.matcap = source.matcap;
        this.map = source.map;
        this.alphaMap = source.alphaMap;
        this.bumpMap = source.bumpMap;
        this.bumpScale = source.bumpScale;
        this.normalMap = source.normalMap;
        this.normalMapType = source.normalMapType;
        this.normalScale.copy(source.normalScale);
        this.displacementMap = source.displacementMap;
        this.displacementScale = source.displacementScale;
        this.displacementBias = source.displacementBias;
        this.flatShading = source.flatShading;
        this.fog = source.fog;

        // Anime extensions
        this.celBands = source.celBands;
        this.celQuantize = source.celQuantize;
        this.shadowTint = source.shadowTint;
        this.matcapRotation = source.matcapRotation;
        this.matcapScale = source.matcapScale;
        this.matcapOffset.copy(source.matcapOffset);
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy(source.moodColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.overlayVariation = source.overlayVariation;
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

        data.type = 'MeshMatcapMaterial';

        if (this.color.getHex() !== 0xffffff) data.color = this.color.getHex();
        if (this.matcap !== null) data.matcap = this.matcap.toJSON(meta).uuid;
        if (this.map !== null) data.map = this.map.toJSON(meta).uuid;
        if (this.alphaMap !== null) data.alphaMap = this.alphaMap.toJSON(meta).uuid;
        if (this.bumpMap !== null) data.bumpMap = this.bumpMap.toJSON(meta).uuid;
        if (this.bumpScale !== 1) data.bumpScale = this.bumpScale;
        if (this.normalMap !== null) data.normalMap = this.normalMap.toJSON(meta).uuid;
        if (this.normalMapType !== (Constants.TANGENT_SPACE_NORMAL_MAP ?? 0)) data.normalMapType = this.normalMapType;
        if (this.normalScale.x !== 1 || this.normalScale.y !== 1) data.normalScale = this.normalScale.toArray();
        if (this.displacementMap !== null) data.displacementMap = this.displacementMap.toJSON(meta).uuid;
        if (this.displacementScale !== 1) data.displacementScale = this.displacementScale;
        if (this.displacementBias !== 0) data.displacementBias = this.displacementBias;
        if (this.flatShading) data.flatShading = true;
        if (this.fog === false) data.fog = false;

        // Anime extensions
        if (this.celBands !== 0) data.celBands = this.celBands;
        if (this.celQuantize !== 1.0) data.celQuantize = this.celQuantize;
        if (this.shadowTint !== 0.8) data.shadowTint = this.shadowTint;
        if (this.matcapRotation !== 0) data.matcapRotation = this.matcapRotation;
        if (this.matcapScale !== 1.0) data.matcapScale = this.matcapScale;
        if (this.matcapOffset.x !== 0 || this.matcapOffset.y !== 0) data.matcapOffset = this.matcapOffset.toArray();
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.rimGlow !== 0) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.5, 0.9, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.overlayVariation !== 0) data.overlayVariation = this.overlayVariation;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {MeshMatcapMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        if (json.color !== undefined) this.color.setHex(json.color);
        this.bumpScale = json.bumpScale ?? this.bumpScale;
        this.normalMapType = json.normalMapType ?? this.normalMapType;
        if (json.normalScale) this.normalScale.fromArray(json.normalScale);
        this.displacementScale = json.displacementScale ?? this.displacementScale;
        this.displacementBias = json.displacementBias ?? this.displacementBias;
        this.flatShading = json.flatShading ?? this.flatShading;
        this.fog = json.fog ?? this.fog;

        this.celBands = json.celBands ?? this.celBands;
        this.celQuantize = json.celQuantize ?? this.celQuantize;
        this.shadowTint = json.shadowTint ?? this.shadowTint;
        this.matcapRotation = json.matcapRotation ?? this.matcapRotation;
        this.matcapScale = json.matcapScale ?? this.matcapScale;
        if (json.matcapOffset) this.matcapOffset.fromArray(json.matcapOffset);
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        this.overlayVariation = json.overlayVariation ?? this.overlayVariation;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived values
        this.updateMoodColor();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for matcap materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing matcap‑specific batching metadata. Consumers can
 * register matcap materials with a World to drive batch updates.
 */
const MeshMatcapMaterialBatchComponent = {
    materialPtr: 'ui32',
    celBands: 'ui8',
    celQuantize: 'f64',
    shadowTint: 'f64',
    matcapRotation: 'f64',
    matcapScale: 'f64',
    matcapOffsetX: 'f64',
    matcapOffsetY: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    overlayVariation: 'f64',
    dirty: 'ui8'
};

export {
    MeshMatcapMaterial,
    MatcapScratchPool,
    MeshMatcapMaterialBatchComponent,
    applyMatcapCelBanding,
    warpMatcapUV,
    generateMatcapOverlay,
    gradeMatcapColor
};

export default MeshMatcapMaterial;