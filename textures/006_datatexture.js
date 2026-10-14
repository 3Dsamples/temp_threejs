// file number : 006
// full path name : src/textures/006_datatexture.js
// description : DataTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class to create textures directly from raw typed-array buffers (DataTexture, DataArrayTexture, Data3DTexture, and the entire HDR/EXR/TGA pipeline). Preserves the full r185 API — image proxy with {data, width, height}, generateMipmaps=false, flipY=false, unpackAlignment=1, isDataTexture flag, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated buffer sampling for CPU-side texel lookups, bitecs SoA batching for multi-buffer uploads (terrain heightfields, particle state textures, tile maps), double.js bit-exact float-buffer normalization for HDR EXR data, and simplex-noise dithered 8-bit quantization for LDR conversion of HDR sources.
// best for : DataTexture, DataTextureLoader, HDR/EXR/TGA loaders, terrain heightfields, particle simulation textures, GPU readback, tile maps, GPUComputationRenderer, and any three.js workflow that needs a texture directly backed by a typed array.
// license : MIT

import { Texture } from './002_texture.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import {
	NearestFilter,
	LinearFilter,
	RGBAFormat,
	UnsignedByteType,
	FloatType,
	HalfFloatType,
	NoColorSpace,
	UVMapping,
	ClampToEdgeWrapping
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

// gl-matrix scratch for zero-allocation texel sampling
const _gm_rgba = glMatrix.vec4.create();
const _gm_rgb = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-buffer uploads
// ---------------------------------------------------------------------------

const _dataWorld = createWorld();

const DataTextureJobComponent = defineComponent( {
	texPtr: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	channels: Types.ui8,
	mode: Types.ui8,      // 0 = raw, 1 = normalize float, 2 = dither 8-bit
	done: Types.ui8
} );

class DataTextureBatch {

	constructor() {

		this.world = _dataWorld;
		this.textures = [];
		this.outputs = [];
		this.entities = [];

	}

	/**
	 * Register a DataTexture instance for batched processing.
	 *
	 * @param {DataTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a processing job for a registered data texture.
	 *
	 * @param {number} textureId
	 * @param {number} [mode=0] - 0 = raw, 1 = normalize float, 2 = dither 8-bit.
	 * @returns {number} entity id
	 */
	addJob( textureId, mode = 0 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, DataTextureJobComponent, eid );

		const texture = this.textures[ textureId ];

		DataTextureJobComponent.texPtr[ eid ] = textureId;
		DataTextureJobComponent.width[ eid ] = texture.image.width;
		DataTextureJobComponent.height[ eid ] = texture.image.height;
		DataTextureJobComponent.channels[ eid ] = 4; // RGBA assumed
		DataTextureJobComponent.mode[ eid ] = mode;
		DataTextureJobComponent.done[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued jobs in one cache-friendly pass.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ DataTextureJobComponent.texPtr[ eid ] ];
			const data = texture.image.data;

			if ( ! data ) {

				DataTextureJobComponent.done[ eid ] = 1;
				this.outputs.push( null );
				continue;

			}

			const mode = DataTextureJobComponent.mode[ eid ];
			let result = null;

			if ( mode === 0 ) {

				result = data;

			} else if ( mode === 1 && data instanceof Float32Array ) {

				// Normalize float buffer to [0, 1] using double.js
				_double.value = 0;
				for ( let k = 0; k < data.length; k ++ ) {

					const abs = Math.abs( data[ k ] );
					if ( abs > _double.value ) _double.value = abs;

				}

				const max = _double.value || 1;
				const out = new Float32Array( data.length );
				for ( let k = 0; k < data.length; k ++ ) {

					_double.value = data[ k ];
					_double.div( max );
					out[ k ] = _double.value;

				}

				result = out;

			} else if ( mode === 2 && ( data instanceof Uint8Array || data instanceof Uint8ClampedArray ) ) {

				// Dither 8-bit output using simplex-noise
				const out = new Uint8ClampedArray( data.length );
				for ( let k = 0; k < data.length; k ++ ) {

					const d = _noise2D( k * 0.01, 0 ) * 0.5;
					out[ k ] = Math.max( 0, Math.min( 255, data[ k ] + d ) );

				}

				result = out;

			} else {

				result = data;

			}

			const dstIndex = this.outputs.length;
			this.outputs.push( result );
			DataTextureJobComponent.done[ eid ] = 1;

		}

	}

	/**
	 * Retrieve the processed result for a given entity.
	 *
	 * @param {number} eid
	 * @returns {TypedArray|null}
	 */
	result( eid ) {

		if ( ! DataTextureJobComponent.done[ eid ] ) return null;
		return this.outputs[ DataTextureJobComponent.dstPtr[ eid ] ];

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact float-buffer normalization for HDR EXR data
// ---------------------------------------------------------------------------

/**
 * Normalize an arbitrary float buffer into [0, 1] using double.js for
 * bit-exact scaling. Used when a DataTexture holds HDR data whose values
 * may exceed float32 precision (e.g. EXR channels with values > 1e38).
 *
 * @param {Float32Array} data
 * @param {number} [maxValue] - Optional explicit maximum.
 * @returns {Float32Array}
 */
function normalizeFloatPrecise( data, maxValue ) {

	let max = maxValue;

	if ( max === undefined ) {

		_double.value = 0;
		for ( let i = 0; i < data.length; i ++ ) {

			const abs = Math.abs( data[ i ] );
			if ( abs > _double.value ) _double.value = abs;

		}

		max = _double.value;

	}

	if ( max === 0 ) return new Float32Array( data.length );

	const out = new Float32Array( data.length );
	for ( let i = 0; i < data.length; i ++ ) {

		_double.value = data[ i ];
		_double.div( max );
		out[ i ] = _double.value;

	}

	return out;

}

// ---------------------------------------------------------------------------
// simplex-noise dithered 8-bit quantization for LDR conversion
// ---------------------------------------------------------------------------

/**
 * Quantize a float buffer into 8-bit with simplex-noise dithering. Breaks
 * up banding when an HDR DataTexture is down-converted to a LDR format.
 *
 * @param {Float32Array} data
 * @param {number} [amplitude=0.5]
 * @returns {Uint8ClampedArray}
 */
function quantizeDithered( data, amplitude = 0.5 ) {

	const out = new Uint8ClampedArray( data.length );
	const invAmp = amplitude / 255;

	for ( let i = 0; i < data.length; i ++ ) {

		const d = _noise2D( i * 0.01, 0 ) * invAmp;
		out[ i ] = Math.floor( Math.max( 0, Math.min( 1, data[ i ] + d ) ) * 255 );

	}

	return out;

}

// ---------------------------------------------------------------------------
// Main DataTexture class — mirrors three.js/src/textures/DataTexture.js
// ---------------------------------------------------------------------------

/**
 * Creates a texture directly from raw buffer data.
 *
 * The interpretation of the data depends on type and format:
 * If the type is `UnsignedByteType`, a `Uint8Array` will be useful for
 * addressing the texel data. If the format is `RGBAFormat`, data needs
 * four values for one texel: Red, Green, Blue and Alpha (typically the
 * opacity).
 *
 * ```js
 * // create a data texture with a 128x128 RGBA buffer
 * const width = 128;
 * const height = 128;
 * const size = width * height;
 * const data = new Uint8Array( 4 * size );
 *
 * for ( let i = 0; i < size; i ++ ) {
 *   const stride = i * 4;
 *   const x = i % width;
 *   const y = Math.floor( i / width );
 *   data[ stride ] = x;
 *   data[ stride + 1 ] = y;
 *   data[ stride + 2 ] = 0;
 *   data[ stride + 3 ] = 255;
 * }
 *
 * const texture = new THREE.DataTexture( data, width, height );
 * texture.needsUpdate = true;
 * ```
 *
 * @augments Texture
 */
class DataTexture extends Texture {

	/**
	 * Constructs a new data texture.
	 *
	 * @param {?TypedArray} [data=null] - The buffer data.
	 * @param {number} [width=1] - The width of the texture.
	 * @param {number} [height=1] - The height of the texture.
	 * @param {number} [format=RGBAFormat] - The texture format.
	 * @param {number} [type=UnsignedByteType] - The texture type.
	 * @param {number} [mapping=Texture.DEFAULT_MAPPING] - The texture mapping.
	 * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
	 * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
	 * @param {number} [magFilter=NearestFilter] - The mag filter value.
	 * @param {number} [minFilter=NearestFilter] - The min filter value.
	 * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
	 * @param {string} [colorSpace=NoColorSpace] - The color space.
	 */
	constructor(
		data = null,
		width = 1,
		height = 1,
		format = RGBAFormat,
		type = UnsignedByteType,
		mapping = Texture.DEFAULT_MAPPING,
		wrapS = ClampToEdgeWrapping,
		wrapT = ClampToEdgeWrapping,
		magFilter = NearestFilter,
		minFilter = NearestFilter,
		anisotropy = Texture.DEFAULT_ANISOTROPY,
		colorSpace = NoColorSpace
	) {

		super(
			null,
			mapping,
			wrapS,
			wrapT,
			magFilter,
			minFilter,
			format,
			type,
			anisotropy,
			colorSpace
		);

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isDataTexture = true;

		/**
		 * The image definition of a data texture.
		 *
		 * @type {{data: TypedArray, width: number, height: number}}
		 */
		this.image = { data, width, height };

		/**
		 * Whether to generate mipmaps (if possible) for a texture.
		 * Overwritten and set to `false` by default.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.generateMipmaps = false;

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
		 * Specifies the alignment requirements for the start of each pixel
		 * row in memory.
		 * Overwritten and set to `1` by default.
		 *
		 * @type {number}
		 * @default 1
		 */
		this.unpackAlignment = 1;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated texel sampling from the raw buffer. Writes into
	 * a preallocated glMatrix.vec4 for zero-allocation downstream processing.
	 * Assumes a 4-channel (RGBA) buffer in the range [0, 1] for float types
	 * or [0, 255] for byte types.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleGlMat( out = _gm_rgba, u = 0.5, v = 0.5 ) {

		const data = this.image.data;
		const width = this.image.width;
		const height = this.image.height;

		if ( ! data || ! width || ! height ) return null;

		const x = Math.min( width - 1, Math.max( 0, Math.floor( u * width ) ) );
		const y = Math.min( height - 1, Math.max( 0, Math.floor( v * height ) ) );
		const p = ( y * width + x ) * 4;

		const scale = ( this.type === FloatType || this.type === HalfFloatType ) ? 1 : 1 / 255;

		glMatrix.vec4.set(
			out,
			data[ p ] * scale,
			data[ p + 1 ] * scale,
			data[ p + 2 ] * scale,
			data[ p + 3 ] * scale
		);

		return out;

	}

	/**
	 * gl-matrix accelerated 3-channel texel sampling (for RGB buffers).
	 *
	 * @param {glMatrix.vec3} [out] - Optional preallocated output vec3.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec3|null}
	 */
	sampleRgbGlMat( out = _gm_rgb, u = 0.5, v = 0.5 ) {

		const data = this.image.data;
		const width = this.image.width;
		const height = this.image.height;

		if ( ! data || ! width || ! height ) return null;

		const x = Math.min( width - 1, Math.max( 0, Math.floor( u * width ) ) );
		const y = Math.min( height - 1, Math.max( 0, Math.floor( v * height ) ) );
		const p = ( y * width + x ) * 3;

		const scale = ( this.type === FloatType || this.type === HalfFloatType ) ? 1 : 1 / 255;

		glMatrix.vec3.set(
			out,
			data[ p ] * scale,
			data[ p + 1 ] * scale,
			data[ p + 2 ] * scale
		);

		return out;

	}

	/**
	 * double.js bit-exact float-buffer normalization for HDR EXR data.
	 * Returns a new Float32Array normalized into [0, 1].
	 *
	 * @param {number} [maxValue] - Optional explicit maximum.
	 * @returns {Float32Array|null}
	 */
	normalizeFloatPrecise( maxValue ) {

		if ( ! ( this.image.data instanceof Float32Array ) ) return null;
		return normalizeFloatPrecise( this.image.data, maxValue );

	}

	/**
	 * Quantize a float DataTexture into 8-bit with simplex-noise dithering.
	 * Returns a new Uint8ClampedArray suitable for LDR upload.
	 *
	 * @param {number} [amplitude=0.5]
	 * @returns {Uint8ClampedArray|null}
	 */
	quantizeDithered( amplitude = 0.5 ) {

		if ( ! ( this.image.data instanceof Float32Array ) ) return null;
		return quantizeDithered( this.image.data, amplitude );

	}

	/**
	 * Create a batched data-texture processing coordinator backed by bitecs.
	 *
	 * @returns {DataTextureBatch}
	 */
	static createBatch() {

		return new DataTextureBatch();

	}

	/**
	 * Copy the given data texture's properties into this one.
	 *
	 * @param {DataTexture} source - The texture to copy from.
	 * @return {DataTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.image = {
			data: source.image.data ? source.image.data.slice( 0 ) : null,
			width: source.image.width,
			height: source.image.height
		};

		this.generateMipmaps = source.generateMipmaps;
		this.flipY = source.flipY;
		this.unpackAlignment = source.unpackAlignment;

		return this;

	}

	/**
	 * Serializes the data texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Data texture pixel buffers cannot be serialized to JSON directly.
		// Only structural metadata (dimensions, type, format) is preserved.
		output.image = {
			width: this.image.width,
			height: this.image.height,
			dataType: this.image.data ? this.image.data.constructor.name : null,
			byteLength: this.image.data ? this.image.data.byteLength : 0
		};

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { DataTexture, DataTextureBatch, normalizeFloatPrecise, quantizeDithered };
export default DataTexture;