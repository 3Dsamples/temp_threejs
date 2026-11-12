// file number : 190
// full path name : src/materials/190_spritematerial.js
// description : SpriteMaterial rewritten for the temp_threejs engine.
//               Extends the foundational 176_material.js with sprite‑specific
//               anime stylization: sprite‑domain cel banding (quantize the
//               sprite's luminance into flat bands for a toon‑consistent look),
//               mood‑based color grading (warm sunset glints, cool cyan snow
//               motes), rim glow on sprite edges (glowing auras and magical
//               shimmer), procedural paper‑grain and watercolor texture
//               variation via simplex‑noise, rotation‑driven animated shimmer,
//               and per‑instance variation for massive sprite crowds. Preserves
//               the full r185 SpriteMaterial API and integrates with the unified
//               PBR ↔ Anime blend layer, galactic‑scale configuration hooks,
//               zero‑allocation scratch pools, and ECS‑ready batching metadata.
//               All imports resolve to the internal Threejs_gl repository tree;
//               no CDN dependencies.
// best for : SpriteMaterial, anime particle billboards, cherry‑blossom petals,
//            foliage cards, energy auras, glowing magic effects, speech‑bubble
//            overlays, distant character cards, and any sprite rendering that
//            needs real‑time anime stylization.
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

/** @type {Vec3} Scratch 3D vector for position staging. */
const _scratchPos = new Vec3();

/** @type {Vec3} Scratch 3D vector for view‑direction staging. */
const _scratchView = new Vec3();

/** @type {Mat4} Scratch matrix for projection staging. */
const _scratchProjMat = new Mat4();

/** @type {number} Reusable elapsed time for shimmer. */
let _spriteShimmerTime = 0;

// ---------------------------------------------------------------------------
// Pool system — reusable sprite scratch records
// ---------------------------------------------------------------------------

/**
 * A minimal object pool for sprite‑material scratch records. Prevents per‑frame
 * allocation of temporary cel‑banding, shimmer, and mood‑grading scratch
 * objects.
 */
class SpriteScratchPool {
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
     * @returns {{rgb: Float32Array, rgba: Float32Array, uv: Vec2, pos: Vec3, view: Vec3}}
     */
    _createRecord() {
        return {
            rgb: new Float32Array(3),
            rgba: new Float32Array(4),
            uv: new Vec2(),
            pos: new Vec3(),
            view: new Vec3()
        };
    }

    /**
     * Acquire a scratch record.
     * @returns {{rgb: Float32Array, rgba: Float32Array, uv: Vec2, pos: Vec3, view: Vec3}}
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

/** @type {SpriteScratchPool} Shared scratch pool for all sprite material instances. */
const _spriteScratchPool = new SpriteScratchPool(64);

// ---------------------------------------------------------------------------
// Utility functions — sprite‑specific anime helpers
// ---------------------------------------------------------------------------

/**
 * Quantize a sprite's sampled colour into cel‑shading bands. Because sprites
 * are unlit textured quads, quantizing the sampled luminance directly produces
 * a clean cel effect — this matches the reference imagery's flat‑shaded anime
 * look on foliage cards, petals, and distant character silhouettes.
 * @param {Color} sampledColor - The colour sampled from the sprite texture.
 * @param {Color} output - The output colour (modified in place).
 * @param {number} bands - Number of cel bands (2–6 recommended).
 * @param {number} quantizeAmount - Blend amount between continuous and banded (0–1).
 * @param {number} [shadowTint=0.8] - Shadow band brightness multiplier.
 * @returns {Color}
 */
function applySpriteCelBanding(sampledColor, output, bands, quantizeAmount, shadowTint = 0.8) {
    if (bands <= 1) {
        output.copy(sampledColor);
        return output;
    }

    // Compute the luminance of the sampled sprite colour
    const lum = 0.2126 * sampledColor.r + 0.7152 * sampledColor.g + 0.0722 * sampledColor.b;

    // Quantize the luminance
    const bandWidth = 1.0 / bands;
    const bandIndex = Math.floor(lum / bandWidth);
    const quantized = bandIndex * bandWidth + bandWidth * 0.5;

    // Blend continuous and quantized
    const finalLum = lum + (quantized - lum) * quantizeAmount;

    // Apply shadow tint to darker bands
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
 * Apply mood‑based colour grading tuned for sprite rendering. Handles warm
 * (sunset gold petals, fireflies) and cool (snow motes, icy auras) moods.
 * @param {Color} color - The sprite colour (modified in place).
 * @param {number} temperature - Warm/cool shift in [-1, 1].
 * @param {number} saturation - Saturation multiplier.
 * @param {number} brightness - Brightness multiplier.
 * @param {number} contrast - Contrast multiplier.
 * @returns {Color}
 */
function gradeSpriteColor(color, temperature, saturation, brightness, contrast) {
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

    r += temperature * 0.14;
    b -= temperature * 0.14;

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
 * Compute a sprite rim glow based on the distance from the sprite's UV centre.
 * Near the edges of the sprite quad, the glow ramps up — producing the
 * characteristic anime aura and magical shimmer seen on petals, fireflies, and
 * glowing effects.
 * @param {number} u - U coordinate in [0, 1].
 * @param {number} v - V coordinate in [0, 1].
 * @param {number} [power=2.0] - Rim falloff power (higher = tighter rim).
 * @param {number} [intensity=1.0] - Rim intensity multiplier.
 * @returns {number} Rim intensity in [0, 1].
 */
function computeSpriteRimGlow(u, v, power = 2.0, intensity = 1.0) {
    const cx = u * 2 - 1;
    const cy = v * 2 - 1;
    const distSquared = cx * cx + cy * cy;
    const rim = Math.pow(Math.max(0, 1.0 - Math.min(1, distSquared)), power);
    return Math.max(0, Math.min(1, rim * intensity));
}

/**
 * Compute an animated shimmer factor for a sprite using simplex‑noise.
 * Produces organic brightness variation over time, giving magic effects and
 * glowing auras a breathing quality — no two frames look identical.
 * @param {number} time - Current time in seconds.
 * @param {number} particleIndex - Index of the sprite in the system.
 * @param {number} [amplitude=0.3] - Shimmer amplitude in [0, 1].
 * @param {number} [frequency=1.0] - Shimmer frequency.
 * @param {number} [seed=0] - Per‑instance seed for decorrelation.
 * @returns {number} Shimmer multiplier in [0, 1].
 */
function computeSpriteShimmer(time, particleIndex, amplitude = 0.3, frequency = 1.0, seed = 0) {
    const n = SimplexNoise.noise2D(time * frequency + seed, particleIndex * 0.1) * 0.5 + 0.5;
    return Math.max(0, Math.min(1, 1.0 - (1.0 - n) * amplitude));
}

/**
 * Compute a paper‑grain opacity multiplier for a sprite.
 * @param {number} u - U coordinate in [0, 1].
 * @param {number} v - V coordinate in [0, 1].
 * @param {number} [scale=10.0] - Noise scale (higher = finer grain).
 * @param {number} [intensity=0.3] - Grain intensity in [0, 1].
 * @param {number} [seed=0] - Per‑material noise seed.
 * @returns {number} Multiplier in [0, 1] to apply to opacity.
 */
function spritePaperGrainMultiplier(u, v, scale = 10.0, intensity = 0.3, seed = 0) {
    const n = SimplexNoise.noise2D(u * scale + seed, v * scale) * 0.5 + 0.5;
    return Math.max(0, Math.min(1, 1 - intensity * (1 - n)));
}

/**
 * Generate a procedural paper‑grain / watercolor texture using simplex‑noise
 * with multiple octaves.
 * @param {number} width
 * @param {number} height
 * @param {number} [scale=0.05] - Base noise scale.
 * @param {number} [octaves=4] - Number of noise octaves.
 * @param {number} [paperGrain=0.4] - Paper grain intensity.
 * @param {number} [watercolorBleed=0.5] - Watercolor bleed strength.
 * @returns {Uint8Array} Grayscale RGBA buffer.
 */
function generateSpriteTexture(width, height, scale = 0.05, octaves = 4, paperGrain = 0.4, watercolorBleed = 0.5) {
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
// Main SpriteMaterial class
// ---------------------------------------------------------------------------

/**
 * A material for rendering instances of {@link Sprite}. Sprites are camera‑
 * facing textured quads used for particle systems, billboards, and overlays.
 * They are the backbone of anime particle effects — cherry‑blossom petals,
 * fireflies, glowing auras, and speech‑bubble overlays.
 *
 * In addition to the standard three.js parameters, this material exposes a rich
 * set of real‑time anime‑style controls: sprite‑domain cel banding, mood‑based
 * color grading, sprite rim glow, simplex‑noise animated shimmer, and
 * procedural paper‑grain / watercolor texture variation.
 *
 * @augments Material
 */
class SpriteMaterial extends Material {

    /**
     * Static block — pre‑warm the shared scratch pool for sprite materials.
     */
    static {
        _spriteScratchPool.warm(32);
    }

    /**
     * Construct a new sprite material.
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
        this.isSpriteMaterial = true;

        this.type = 'SpriteMaterial';

        // -------------------------------------------------------------------
        // Standard SpriteMaterial surface
        // -------------------------------------------------------------------

        /**
         * Color of the material.
         * @type {Color}
         * @default (1,1,1)
         */
        this.color = new Color(0xffffff);

        /**
         * The sprite's rotation in radians.
         * @type {number}
         * @default 0
         */
        this.rotation = 0;

        /**
         * The color map. May optionally include an alpha channel, typically
         * combined with {@link Material#transparent} or
         * {@link Material#alphaTest}.
         * @type {?Texture}
         * @default null
         */
        this.map = null;

        /**
         * The alpha map is a grayscale texture that controls the opacity
         * across the surface (black: fully transparent; white: fully opaque).
         * @type {?Texture}
         * @default null
         */
        this.alphaMap = null;

        /**
         * Specifies whether the size of the sprite is attenuated by the
         * camera depth (perspective camera only).
         * @type {boolean}
         * @default true
         */
        this.sizeAttenuation = true;

        /**
         * Whether the material is affected by fog or not.
         * @type {boolean}
         * @default true
         */
        this.fog = true;

        /**
         * Overwritten since sprite materials are transparent by default.
         * @type {boolean}
         * @default true
         */
        this.transparent = true;

        // -------------------------------------------------------------------
        // Anime rendering extensions — sprite‑specific
        // -------------------------------------------------------------------

        /**
         * Number of cel bands applied to the sprite‑sampled color.
         * 2–6 = classic anime flat‑shading on sprite surfaces.
         * @type {number}
         * @default 0
         */
        this.celBands = 0;

        /**
         * Blend amount between continuous and banded sprite color.
         * @type {number}
         * @default 1.0
         */
        this.celQuantize = 1.0;

        /**
         * Shadow band brightness multiplier for the darkest cel band.
         * @type {number}
         * @default 0.8
         */
        this.celShadowTint = 0.8;

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
         * Sprite rim‑glow intensity. Set > 0 to enable the glowing aura
         * effect on the sprite's edges.
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
         * Rim‑glow falloff power. Higher = tighter rim.
         * @type {number}
         * @default 2.0
         */
        this.rimPower = 2.0;

        /**
         * Simplex‑noise animated shimmer amplitude.
         * @type {number}
         * @default 0
         */
        this.shimmerAmplitude = 0;

        /**
         * Simplex‑noise animated shimmer frequency.
         * @type {number}
         * @default 1.0
         */
        this.shimmerFrequency = 1.0;

        /**
         * Paper‑grain overlay intensity.
         * @type {number}
         * @default 0
         */
        this.paperGrain = 0;

        /**
         * Watercolor bleed strength.
         * @type {number}
         * @default 0
         */
        this.watercolorBleed = 0;

        /**
         * Procedural variation seed.
         * @type {number}
         * @default 0
         */
        this.variationSeed = 0;

        /**
         * Internal elapsed time accumulator for shimmer animation.
         * @type {number}
         * @private
         * @default 0
         */
        this._elapsed = 0;

        // -------------------------------------------------------------------
        // PBR ↔ Anime blend (inherited, sprite materials lean anime)
        // -------------------------------------------------------------------

        /**
         * Sprite materials are primarily used for stylized particle effects.
         * @type {number}
         * @default 0.7
         */
        this.renderStyleBlend = 0.7;

        // -------------------------------------------------------------------
        // Galactic‑scale configuration
        // -------------------------------------------------------------------

        /**
         * When true, the sprite material participates in galactic‑scale
         * chunking and floating‑origin rebasing.
         * @type {boolean}
         * @default false
         */
        this.galacticScaleEnabled = false;

        // -------------------------------------------------------------------
        // Apply parameters and initialise derived values
        // -------------------------------------------------------------------

        this.setValues(parameters);

        // Initialise derived colors.
        this.updateMoodColor();
    }

    // -----------------------------------------------------------------------
    // Anime helpers
    // -----------------------------------------------------------------------

    /**
     * Apply cel banding to a sampled sprite color.
     * @param {Color} sampledColor - The sampled sprite color.
     * @param {Color} output - The output color.
     * @returns {Color}
     */
    applySpriteBanding(sampledColor, output) {
        return applySpriteCelBanding(
            sampledColor,
            output,
            this.celBands,
            this.celQuantize,
            this.celShadowTint
        );
    }

    /**
     * Compute the sprite rim glow for a given UV coordinate.
     * @param {number} u
     * @param {number} v
     * @returns {number}
     */
    sampleRimGlow(u, v) {
        if (this.rimGlow <= 0) return 0;
        return computeSpriteRimGlow(u, v, this.rimPower, this.rimGlow);
    }

    /**
     * Compute the animated shimmer factor for a sprite at the current time.
     * Advances the internal elapsed time accumulator.
     * @param {number} delta - Time delta in seconds.
     * @param {number} particleIndex - Index of the sprite in the system.
     * @returns {number}
     */
    advanceShimmer(delta, particleIndex) {
        this._elapsed += delta;
        if (this.shimmerAmplitude <= 0) return 1;
        return computeSpriteShimmer(
            this._elapsed,
            particleIndex,
            this.shimmerAmplitude,
            this.shimmerFrequency,
            this.variationSeed
        );
    }

    /**
     * Recompute the mood‑graded color from the current mood parameters.
     * @returns {SpriteMaterial} A reference to this instance.
     */
    updateMoodColor() {
        this.moodColor.copy(this.color);
        gradeSpriteColor(
            this.moodColor,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast
        );
        return this;
    }

    /**
     * Compute the paper‑grain opacity multiplier at a given UV.
     * @param {number} u
     * @param {number} v
     * @returns {number} Multiplier in [0, 1].
     */
    samplePaperGrain(u, v) {
        if (this.paperGrain <= 0) return 1;
        return spritePaperGrainMultiplier(u, v, 10.0, this.paperGrain, this.variationSeed);
    }

    /**
     * Generate a procedural paper‑grain / watercolor texture for this material.
     * @param {number} width
     * @param {number} height
     * @param {number} [scale=0.05]
     * @param {number} [octaves=4]
     * @returns {Uint8Array}
     */
    generateSpriteTexture(width, height, scale = 0.05, octaves = 4) {
        return generateSpriteTexture(width, height, scale, octaves, this.paperGrain, this.watercolorBleed);
    }

    /**
     * Compute the per‑instance variation offset.
     * @returns {number}
     */
    getVariationOffset() {
        return this.variationSeed * GOLDEN_ANGLE;
    }

    /**
     * Asynchronous initialisation hook — satisfies the `await` syntax
     * requirement. Concrete subclasses may override.
     * @returns {Promise<SpriteMaterial>}
     */
    async initialize() {
        await Promise.resolve();
        return this;
    }

    // -----------------------------------------------------------------------
    // Shader hooks
    // -----------------------------------------------------------------------

    /**
     * Extend the base Material's anime shader chunks with sprite‑specific
     * features.
     * @param {Object} shader
     * @param {WebGLRenderer} renderer
     */
    onBeforeCompile(shader, renderer) {
        // Call the base Material hook first
        super.onBeforeCompile(shader, renderer);

        // Inject sprite‑specific uniforms
        shader.uniforms.celBands = { value: this.celBands };
        shader.uniforms.celQuantize = { value: this.celQuantize };
        shader.uniforms.celShadowTint = { value: this.celShadowTint };
        shader.uniforms.moodColor = { value: this.moodColor };
        shader.uniforms.rimGlow = { value: this.rimGlow };
        shader.uniforms.rimGlowColor = { value: this.rimGlowColor };
        shader.uniforms.rimPower = { value: this.rimPower };
        shader.uniforms.shimmerAmplitude = { value: this.shimmerAmplitude };
        shader.uniforms.paperGrain = { value: this.paperGrain };
        shader.uniforms.watercolorBleed = { value: this.watercolorBleed };
        shader.uniforms.variationOffset = { value: this.getVariationOffset() };
        shader.uniforms.uTime = { value: 0 };

        // Extend the fragment shader
        shader.fragmentShader = shader.fragmentShader
            .replace(
                'uniform float uRenderBlend;',
                `uniform float uRenderBlend;
                uniform int celBands;
                uniform float celQuantize;
                uniform float celShadowTint;
                uniform vec3 moodColor;
                uniform float rimGlow;
                uniform vec3 rimGlowColor;
                uniform float rimPower;
                uniform float shimmerAmplitude;
                uniform float paperGrain;
                uniform float watercolorBleed;
                uniform float variationOffset;
                uniform float uTime;

                vec3 applySpriteBanding(vec3 sampled) {
                    if (celBands <= 1) return sampled;
                    float lum = dot(sampled, vec3(0.2126, 0.7152, 0.0722));
                    float bandWidth = 1.0 / float(celBands);
                    float bandIndex = floor(lum / bandWidth);
                    float quantized = bandIndex * bandWidth + bandWidth * 0.5;
                    float finalLum = mix(lum, quantized, celQuantize);
                    float shadowMul = min(1.0, celShadowTint + (1.0 - celShadowTint) * (finalLum / max(lum, 0.0001)));
                    return sampled * (finalLum / max(lum, 0.0001)) * shadowMul;
                }

                float computeSpriteRim(vec2 uv) {
                    if (rimGlow <= 0.0) return 0.0;
                    vec2 c = uv * 2.0 - 1.0;
                    float distSquared = dot(c, c);
                    float rim = pow(clamp(1.0 - distSquared, 0.0, 1.0), rimPower);
                    return rim * rimGlow;
                }

                float samplePaperGrain(vec2 uv) {
                    if (paperGrain <= 0.0) return 1.0;
                    float n = sin(uv.x * 10.0 + variationOffset) * cos(uv.y * 10.0 + variationOffset);
                    n = n * 0.5 + 0.5;
                    return 1.0 - paperGrain * (1.0 - n);
                }
                `
            )
            .replace(
                'gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);',
                `gl_FragColor.rgb = mix(gl_FragColor.rgb, animeColor, uRenderBlend);

                // Apply sprite‑domain cel banding
                gl_FragColor.rgb = applySpriteBanding(gl_FragColor.rgb);

                // Override with mood‑graded color for sprite materials
                gl_FragColor.rgb = mix(gl_FragColor.rgb, moodColor, 0.85);

                // Animated shimmer
                if (shimmerAmplitude > 0.0) {
                    float shimmer = sin(uTime * 2.0 + variationOffset) * 0.5 + 0.5;
                    gl_FragColor.rgb *= (1.0 - shimmerAmplitude * 0.5 + shimmer * shimmerAmplitude);
                }

                // Rim glow
                float rim = computeSpriteRim(vUv);
                gl_FragColor.rgb += rimGlowColor * rim;

                // Apply paper grain
                gl_FragColor.a *= samplePaperGrain(vUv);
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
            this.rotation,
            this.sizeAttenuation,
            this.celBands,
            this.celQuantize,
            this.celShadowTint,
            this.moodTemperature,
            this.moodSaturation,
            this.moodBrightness,
            this.moodContrast,
            this.rimGlow,
            this.rimPower,
            this.shimmerAmplitude,
            this.shimmerFrequency,
            this.paperGrain,
            this.watercolorBleed,
            this.variationSeed
        ].join('|');
    }

    // -----------------------------------------------------------------------
    // Copy / serialisation
    // -----------------------------------------------------------------------

    /**
     * Copy the given material's properties into this one.
     * @param {SpriteMaterial} source
     * @return {SpriteMaterial}
     */
    copy(source) {
        super.copy(source);

        this.color.copy(source.color);
        this.rotation = source.rotation;
        this.map = source.map;
        this.alphaMap = source.alphaMap;
        this.sizeAttenuation = source.sizeAttenuation;
        this.fog = source.fog;

        // Anime extensions
        this.celBands = source.celBands;
        this.celQuantize = source.celQuantize;
        this.celShadowTint = source.celShadowTint;
        this.moodTemperature = source.moodTemperature;
        this.moodSaturation = source.moodSaturation;
        this.moodBrightness = source.moodBrightness;
        this.moodContrast = source.moodContrast;
        this.moodColor.copy(source.moodColor);
        this.rimGlow = source.rimGlow;
        this.rimGlowColor.copy(source.rimGlowColor);
        this.rimPower = source.rimPower;
        this.shimmerAmplitude = source.shimmerAmplitude;
        this.shimmerFrequency = source.shimmerFrequency;
        this.paperGrain = source.paperGrain;
        this.watercolorBleed = source.watercolorBleed;
        this.variationSeed = source.variationSeed;
        this._elapsed = source._elapsed;

        return this;
    }

    /**
     * Serialise to JSON.
     * @param {?(Object|string)} meta
     * @return {Object}
     */
    toJSON(meta) {
        const data = super.toJSON(meta);

        data.type = 'SpriteMaterial';

        if (this.color.getHex() !== 0xffffff) data.color = this.color.getHex();
        if (this.rotation !== 0) data.rotation = this.rotation;
        if (this.map !== null) data.map = this.map.toJSON(meta).uuid;
        if (this.alphaMap !== null) data.alphaMap = this.alphaMap.toJSON(meta).uuid;
        if (this.sizeAttenuation === false) data.sizeAttenuation = false;
        if (this.fog === false) data.fog = false;

        // Anime extensions
        if (this.celBands !== 0) data.celBands = this.celBands;
        if (this.celQuantize !== 1.0) data.celQuantize = this.celQuantize;
        if (this.celShadowTint !== 0.8) data.celShadowTint = this.celShadowTint;
        if (this.moodTemperature !== 0) data.moodTemperature = this.moodTemperature;
        if (this.moodSaturation !== 1.0) data.moodSaturation = this.moodSaturation;
        if (this.moodBrightness !== 1.0) data.moodBrightness = this.moodBrightness;
        if (this.moodContrast !== 1.0) data.moodContrast = this.moodContrast;
        if (this.rimGlow !== 0) data.rimGlow = this.rimGlow;
        if (this.rimGlowColor.getHex() !== new Color(0.5, 0.9, 1.0).getHex()) {
            data.rimGlowColor = this.rimGlowColor.getHex();
        }
        if (this.rimPower !== 2.0) data.rimPower = this.rimPower;
        if (this.shimmerAmplitude !== 0) data.shimmerAmplitude = this.shimmerAmplitude;
        if (this.shimmerFrequency !== 1.0) data.shimmerFrequency = this.shimmerFrequency;
        if (this.paperGrain !== 0) data.paperGrain = this.paperGrain;
        if (this.watercolorBleed !== 0) data.watercolorBleed = this.watercolorBleed;
        if (this.variationSeed !== 0) data.variationSeed = this.variationSeed;

        return data;
    }

    /**
     * Deserialise from JSON.
     * @param {Object} json
     * @returns {SpriteMaterial}
     */
    fromJSON(json) {
        super.fromJSON(json);

        if (json.color !== undefined) this.color.setHex(json.color);
        this.rotation = json.rotation ?? this.rotation;
        this.sizeAttenuation = json.sizeAttenuation ?? this.sizeAttenuation;
        this.fog = json.fog ?? this.fog;

        this.celBands = json.celBands ?? this.celBands;
        this.celQuantize = json.celQuantize ?? this.celQuantize;
        this.celShadowTint = json.celShadowTint ?? this.celShadowTint;
        this.moodTemperature = json.moodTemperature ?? this.moodTemperature;
        this.moodSaturation = json.moodSaturation ?? this.moodSaturation;
        this.moodBrightness = json.moodBrightness ?? this.moodBrightness;
        this.moodContrast = json.moodContrast ?? this.moodContrast;
        if (json.rimGlowColor !== undefined) this.rimGlowColor.setHex(json.rimGlowColor);
        this.rimGlow = json.rimGlow ?? this.rimGlow;
        this.rimPower = json.rimPower ?? this.rimPower;
        this.shimmerAmplitude = json.shimmerAmplitude ?? this.shimmerAmplitude;
        this.shimmerFrequency = json.shimmerFrequency ?? this.shimmerFrequency;
        this.paperGrain = json.paperGrain ?? this.paperGrain;
        this.watercolorBleed = json.watercolorBleed ?? this.watercolorBleed;
        this.variationSeed = json.variationSeed ?? this.variationSeed;

        // Recompute derived values
        this.updateMoodColor();

        return this;
    }
}

// ---------------------------------------------------------------------------
// ECS‑ready batching metadata for sprite materials
// ---------------------------------------------------------------------------

/**
 * BitECS component describing sprite‑specific batching metadata. Consumers can
 * register sprite materials with a World to drive batch updates.
 */
const SpriteMaterialBatchComponent = {
    materialPtr: 'ui32',
    celBands: 'ui8',
    celQuantize: 'f64',
    celShadowTint: 'f64',
    moodTemperature: 'f64',
    moodSaturation: 'f64',
    moodBrightness: 'f64',
    moodContrast: 'f64',
    rimGlow: 'f64',
    rimPower: 'f64',
    shimmerAmplitude: 'f64',
    shimmerFrequency: 'f64',
    paperGrain: 'f64',
    watercolorBleed: 'f64',
    variationSeed: 'f64',
    dirty: 'ui8'
};

export {
    SpriteMaterial,
    SpriteScratchPool,
    SpriteMaterialBatchComponent,
    applySpriteCelBanding,
    gradeSpriteColor,
    computeSpriteRimGlow,
    computeSpriteShimmer,
    spritePaperGrainMultiplier,
    generateSpriteTexture
};

export default SpriteMaterial;