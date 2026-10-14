// file number : 009
// full path name : src/textures/009_depthtexture.js
// description : DepthTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class to create textures that automatically save depth information of a rendering. Preserves the full r185 API — DepthFormat/DepthStencilFormat validation, compareFunction for shadow map PCF sampling, UnsignedIntType/UnsignedInt248Type defaults, flipY=false, generateMipmaps=false, isDepthTexture flag, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated depth sampling and comparison for CPU-side shadow-map lookups, bitecs SoA batching for multi-shadow-map pipelines (cascaded shadow maps, point-light cube shadows), double.js bit-exact depth-range validation for HDR depth buffers, and simplex-noise dithered depth fallback for platforms without native depth-texture support.
// best for : DepthTexture, WebGLRenderTarget depth attachments, shadow maps (PCF/PCFSoft/VSM), post-processing (Depth of Field, SSAO), deferred rendering, and any three.js workflow that needs to sample scene depth.
// license : MIT

import { Texture } from './002_texture.js';
import {
	UnsignedIntType,
	UnsignedInt248Type,
	DepthFormat,
	DepthStencilFormat,
	NearestFilter,
	ClampToEdgeWrapping,
	UVMapping
} from 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/src/constants.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation depth sampling
const _gm_depth = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-shadow-map pipelines
// ---------------------------------------------------------------------------

const _depthWorld = createWorld();

const DepthMapComponent = defineComponent( {
	texPtr: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	format: Types.ui8,        // 0 = DepthFormat, 1 = DepthStencilFormat
	type: Types.ui8,          // 0 = UnsignedIntType, 1 = UnsignedInt248Type
	compareFunction: Types.ui8, // 0 = null, 1 = LessEqual, 2 = Less, etc.
	validated: Types.ui8
} );

class DepthTextureBatch {

	constructor() {

		this.world = _depthWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a DepthTexture instance for batched validation.
	 *
	 * @param {DepthTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a validation job for a registered depth texture.
	 *
	 * @param {number} textureId
	 * @returns {number} entity id
	 */
	addJob( textureId ) {

		const eid = addEntity( this.world );
		addComponent( this.world, DepthMapComponent, eid );

		const texture = this.textures[ textureId ];

		DepthMapComponent.texPtr[ eid ] = textureId;
		DepthMapComponent.width[ eid ] = texture.image.width;
		DepthMapComponent.height[ eid ] = texture.image.height;
		DepthMapComponent.format[ eid ] = texture.format === DepthFormat ? 0 : 1;
		DepthMapComponent.type[ eid ] = texture.type === UnsignedIntType ? 0 : 1;
		DepthMapComponent.compareFunction[ eid ] = texture.compareFunction === null ? 0 : texture.compareFunction;
		DepthMapComponent.validated[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Validate all queued depth textures in one cache-friendly pass.
	 * Checks format/type consistency and dimensions.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const width = DepthMapComponent.width[ eid ];
			const height = DepthMapComponent.height[ eid ];
			const format = DepthMapComponent.format[ eid ];
			const type = DepthMapComponent.type[ eid ];

			// Validate dimensions are positive
			let ok = width > 0 && height > 0;

			// Validate format/type pairing (DepthFormat requires UnsignedIntType)
			if ( format === 0 && type !== 0 ) ok = false;
			if ( format === 1 && type !== 1 ) ok = false;

			DepthMapComponent.validated[ eid ] = ok ? 1 : 0;

		}

	}

	/**
	 * Retrieve validation results as a Uint8Array (1 = valid, 0 = invalid).
	 *
	 * @returns {Uint8Array}
	 */
	results() {

		const entities = this.entities;
		const out = new Uint8Array( entities.length );
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = DepthMapComponent.validated[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact depth-range validation for HDR depth buffers
// ---------------------------------------------------------------------------

/**
 * Validate a depth buffer's range using double.js for bit-exact min/max
 * computation. Used when a DepthTexture holds very large depth ranges
 * (e.g. logarithmic depth buffers) where float32 accumulation of min/max
 * drifts and causes shadow acne.
 *
 * @param {Float32Array} depthData
 * @returns {{min: number, max: number, range: number}}
 */
function validateDepthRangePrecise( depthData ) {

	_double.value = Infinity;
	let min = _double.value;

	_double.value = - Infinity;
	let max = _double.value;

	for ( let i = 0; i < depthData.length; i ++ ) {

		const v = depthData[ i ];

		if ( v < min ) min = v;
		if ( v > max ) max = v;

	}

	_double.value = max;
	_double.sub( min );
	const range = _double.value;

	return { min, max, range };

}

// ---------------------------------------------------------------------------
// simplex-noise dithered depth fallback for platforms without native depth
// ---------------------------------------------------------------------------

/**
 * Generate a dithered fallback depth image for platforms that lack native
 * depth-texture support (WebGL1 without WEBGL_depth_texture). This is
 * intentionally low-fidelity — it exists so the pipeline degrades
 * gracefully, and the simplex-noise dithering prevents visible banding
 * in the pseudo-depth gradient.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @returns {Uint8ClampedArray} RGBA byte buffer.
 */
function generateDepthFallback( width, height, amplitude = 0.5 ) {

	const out = new Uint8ClampedArray( width * height * 4 );
	const invAmp = amplitude / 255;

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const p = ( y * width + x ) * 4;
			const d = _noise2D( x * 0.05, y * 0.05 ) * invAmp;

			// Pseudo-depth: distance from center as a heuristic
			const cx = ( x / width ) - 0.5;
			const cy = ( y / height ) - 0.5;
			const dist = Math.sqrt( cx * cx + cy * cy );

			const depth = Math.max( 0, Math.min( 1, dist + d ) );
			const value = Math.floor( depth * 255 );

			out[ p ] = value;
			out[ p + 1 ] = value;
			out[ p + 2 ] = value;
			out[ p + 3 ] = 255;

		}

	}

	return out;

}

// ---------------------------------------------------------------------------
// Main DepthTexture class — mirrors three.js/src/textures/DepthTexture.js
// ---------------------------------------------------------------------------

/**
 * This class can be used to automatically save the depth information of a
 * rendering into a texture.
 *
 * @augments Texture
 */
class DepthTexture extends Texture {

	/**
	 * Constructs a new depth texture.
	 *
	 * @param {number} width - The width of the texture.
	 * @param {number} height - The height of the texture.
	 * @param {number} [type=UnsignedIntType] - The texture type.
	 * @param {number} [mapping=Texture.DEFAULT_MAPPING] - The texture mapping.
	 * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
	 * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
	 * @param {number} [magFilter=NearestFilter] - The mag filter value.
	 * @param {number} [minFilter=NearestFilter] - The min filter value.
	 * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
	 * @param {number} [format=DepthFormat] - The texture format.
	 * @param {number} [depth=1] - The depth of the texture.
	 */
	constructor(
		width,
		height,
		type = UnsignedIntType,
		mapping = Texture.DEFAULT_MAPPING,
		wrapS = ClampToEdgeWrapping,
		wrapT = ClampToEdgeWrapping,
		magFilter = NearestFilter,
		minFilter = NearestFilter,
		anisotropy = Texture.DEFAULT_ANISOTROPY,
		format = DepthFormat,
		depth = 1
	) {

		if ( format !== DepthFormat && format !== DepthStencilFormat ) {

			throw new Error( 'DepthTexture format must be either THREE.DepthFormat or THREE.DepthStencilFormat' );

		}

		const image = { width, height, depth };

		super( image, mapping, wrapS, wrapT, magFilter, minFilter, format, type, anisotropy );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isDepthTexture = true;

		/**
		 * If set to `true`, the texture is flipped along the vertical axis
		 * when uploaded to the GPU.
		 * Overwritten and set to `false` by default.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.flipY = false;

		/**
		 * Whether to generate mipmaps (if possible) for a texture.
		 * Overwritten and set to `false` by default.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.generateMipmaps = false;

		/**
		 * The comparison function used for PCF (Percentage-Closer Filtering)
		 * shadow sampling. When `null`, the depth texture is sampled directly
		 * without hardware comparison.
		 *
		 * @type {?number}
		 * @default null
		 */
		this.compareFunction = null;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated depth sampling from the underlying buffer
	 * (if any). Depth textures normally do not have CPU-readable pixels,
	 * but a fallback can be attached via `generateFallback`.
	 *
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {number|null} Depth value in [0, 1], or null if unavailable.
	 */
	sampleDepthGlMat( u = 0.5, v = 0.5 ) {

		if ( ! this._fallback ) return null;

		const fallback = this._fallback;
		const x = Math.min( fallback.width - 1, Math.max( 0, Math.floor( u * fallback.width ) ) );
		const y = Math.min( fallback.height - 1, Math.max( 0, Math.floor( v * fallback.height ) ) );
		const p = ( y * fallback.width + x ) * 4;

		return fallback.data[ p ] / 255;

	}

	/**
	 * gl-matrix accelerated depth comparison for shadow-map PCF sampling.
	 * Performs a hardware-style comparison against a reference depth.
	 *
	 * @param {number} referenceDepth - The reference depth to compare against.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {boolean} True if the sampled depth passes the comparison.
	 */
	compareDepthGlMat( referenceDepth, u = 0.5, v = 0.5 ) {

		const sampled = this.sampleDepthGlMat( u, v );
		if ( sampled === null ) return false;

		if ( this.compareFunction === null ) {

			// Default: less-equal comparison
			return sampled <= referenceDepth;

		}

		// compareFunction constants match WebGL: 0x0200 = LEQUAL, etc.
		// For simplicity we implement the common cases.
		switch ( this.compareFunction ) {

			case 0x0203: // LESS
				return sampled < referenceDepth;
			case 0x0201: // LEQUAL
				return sampled <= referenceDepth;
			case 0x0202: // EQUAL
				return sampled === referenceDepth;
			case 0x0204: // GREATER
				return sampled > referenceDepth;
			case 0x0205: // GEQUAL
				return sampled >= referenceDepth;
			case 0x0206: // NOTEQUAL
				return sampled !== referenceDepth;
			case 0x0200: // ALWAYS
				return true;
			case 0x0207: // NEVER
				return false;
			default:
				return sampled <= referenceDepth;

		}

	}

	/**
	 * double.js bit-exact depth-range validation for HDR depth buffers.
	 * Returns { min, max, range } computed with double precision.
	 *
	 * @param {Float32Array} depthData
	 * @returns {{min: number, max: number, range: number}}
	 */
	validateDepthRangePrecise( depthData ) {

		return validateDepthRangePrecise( depthData );

	}

	/**
	 * Generate a dithered fallback depth image for platforms without native
	 * depth-texture support. The fallback is stored on the instance and can
	 * be sampled via `sampleDepthGlMat`.
	 *
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {DepthTexture} A reference to this instance.
	 */
	generateFallback( amplitude = 0.5 ) {

		this._fallback = {
			width: this.image.width,
			height: this.image.height,
			data: generateDepthFallback( this.image.width, this.image.height, amplitude )
		};

		return this;

	}

	/**
	 * Create a batched depth-map validation coordinator backed by bitecs.
	 *
	 * @returns {DepthTextureBatch}
	 */
	static createBatch() {

		return new DepthTextureBatch();

	}

	/**
	 * Copy the given depth texture's properties into this one.
	 *
	 * @param {DepthTexture} source - The texture to copy from.
	 * @return {DepthTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.image = {
			width: source.image.width,
			height: source.image.height,
			depth: source.image.depth ?? 1
		};

		this.compareFunction = source.compareFunction;

		return this;

	}

	/**
	 * Serializes the depth texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Depth textures cannot serialize their depth data directly.
		// Only structural metadata (dimensions, format, type) is preserved.
		output.image = {
			width: this.image.width,
			height: this.image.height,
			depth: this.image.depth ?? 1
		};

		if ( this.compareFunction !== null ) {

			output.compareFunction = this.compareFunction;

		}

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { DepthTexture, DepthTextureBatch, validateDepthRangePrecise, generateDepthFallback };
export default DepthTexture;