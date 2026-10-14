// file number : 007
// full path name : src/textures/007_dataarraytexture.js
// description : DataArrayTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class to create 2D-array textures (layered texture stacks) directly from raw typed-array buffers. Preserves the full r185 API — image proxy with {data, width, height, depth}, layerUpdates Set, generateMipmaps=false, flipY=false, unpackAlignment=1, magFilter/minFilter=NearestFilter, isDataArrayTexture flag, addLayerUpdate(), clearLayerUpdates(), plus clone(), copy(), toJSON(). Adds gl-matrix accelerated layer sampling for CPU-side texel lookups, bitecs SoA batching for multi-layer uploads (morph target textures, texture atlases, volumetric slicing), double.js bit-exact layer-offset accumulation for very deep stacks, and simplex-noise dithered 8-bit quantization for LDR conversion of float layers.
// best for : DataArrayTexture, WebGLMorphtargets, morph-target data textures, layered texture atlases, volumetric slicing, sprite sheets with per-layer updates, and any three.js workflow that needs multiple texture layers addressable by a single layer index.
// license : MIT

import { Texture } from './002_texture.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import {
	NearestFilter,
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

// gl-matrix scratch for zero-allocation layer sampling
const _gm_rgba = glMatrix.vec4.create();
const _gm_rgb = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-layer uploads
// ---------------------------------------------------------------------------

const _arrayWorld = createWorld();

const ArrayLayerComponent = defineComponent( {
	texPtr: Types.ui32,
	layer: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	mode: Types.ui8,      // 0 = raw, 1 = normalize float, 2 = dither 8-bit
	done: Types.ui8
} );

class DataArrayTextureBatch {

	constructor() {

		this.world = _arrayWorld;
		this.textures = [];
		this.outputs = [];
		this.entities = [];

	}

	/**
	 * Register a DataArrayTexture instance for batched processing.
	 *
	 * @param {DataArrayTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a processing job for a specific layer of a registered texture.
	 *
	 * @param {number} textureId
	 * @param {number} layer
	 * @param {number} [mode=0] - 0 = raw, 1 = normalize float, 2 = dither 8-bit.
	 * @returns {number} entity id
	 */
	addLayerJob( textureId, layer, mode = 0 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, ArrayLayerComponent, eid );

		const texture = this.textures[ textureId ];

		ArrayLayerComponent.texPtr[ eid ] = textureId;
		ArrayLayerComponent.layer[ eid ] = layer;
		ArrayLayerComponent.width[ eid ] = texture.image.width;
		ArrayLayerComponent.height[ eid ] = texture.image.height;
		ArrayLayerComponent.mode[ eid ] = mode;
		ArrayLayerComponent.done[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued layer jobs in one cache-friendly pass.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ ArrayLayerComponent.texPtr[ eid ] ];
			const data = texture.image.data;

			if ( ! data ) {

				ArrayLayerComponent.done[ eid ] = 1;
				this.outputs.push( null );
				continue;

			}

			const layer = ArrayLayerComponent.layer[ eid ];
			const width = ArrayLayerComponent.width[ eid ];
			const height = ArrayLayerComponent.height[ eid ];
			const layerSize = width * height * 4;
			const layerOffset = layer * layerSize;

			const mode = ArrayLayerComponent.mode[ eid ];
			let result = null;

			if ( mode === 0 ) {

				// Raw slice for this layer
				result = data.slice( layerOffset, layerOffset + layerSize );

			} else if ( mode === 1 && data instanceof Float32Array ) {

				// Normalize the layer's float data using double.js
				_double.value = 0;
				for ( let k = 0; k < layerSize; k ++ ) {

					const abs = Math.abs( data[ layerOffset + k ] );
					if ( abs > _double.value ) _double.value = abs;

				}

				const max = _double.value || 1;
				const out = new Float32Array( layerSize );
				for ( let k = 0; k < layerSize; k ++ ) {

					_double.value = data[ layerOffset + k ];
					_double.div( max );
					out[ k ] = _double.value;

				}

				result = out;

			} else if ( mode === 2 && ( data instanceof Uint8Array || data instanceof Uint8ClampedArray ) ) {

				// Dither this layer's 8-bit output using simplex-noise
				const out = new Uint8ClampedArray( layerSize );
				for ( let k = 0; k < layerSize; k ++ ) {

					const d = _noise2D( k * 0.01, layer ) * 0.5;
					out[ k ] = Math.max( 0, Math.min( 255, data[ layerOffset + k ] + d ) );

				}

				result = out;

			} else {

				result = data.slice( layerOffset, layerOffset + layerSize );

			}

			const dstIndex = this.outputs.length;
			this.outputs.push( result );
			ArrayLayerComponent.done[ eid ] = 1;

		}

	}

	/**
	 * Retrieve the processed layer for a given entity.
	 *
	 * @param {number} eid
	 * @returns {TypedArray|null}
	 */
	result( eid ) {

		if ( ! ArrayLayerComponent.done[ eid ] ) return null;
		return this.outputs[ ArrayLayerComponent.dstPtr[ eid ] ];

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact layer-offset accumulation for very deep stacks
// ---------------------------------------------------------------------------

/**
 * Compute the cumulative byte offset of a specific layer in a layered
 * texture using double.js for bit-exact accumulation. Used when the
 * texture depth is large enough that float32 multiplication of
 * width*height*4*depth exceeds 2^24 and starts losing precision.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} depth
 * @param {number} layer
 * @returns {number}
 */
function layerByteOffsetPrecise( width, height, depth, layer ) {

	_double.value = width;
	_double.mul( height );
	_double.mul( 4 );
	_double.mul( layer );

	return _double.value;

}

// ---------------------------------------------------------------------------
// simplex-noise dithered 8-bit quantization for LDR conversion
// ---------------------------------------------------------------------------

/**
 * Quantize a float layer into 8-bit with simplex-noise dithering. Breaks
 * up banding when a float DataArrayTexture is down-converted to a LDR
 * format for platforms that cannot upload float layers.
 *
 * @param {Float32Array} layerData
 * @param {number} layer
 * @param {number} [amplitude=0.5]
 * @returns {Uint8ClampedArray}
 */
function quantizeLayerDithered( layerData, layer, amplitude = 0.5 ) {

	const out = new Uint8ClampedArray( layerData.length );
	const invAmp = amplitude / 255;

	for ( let i = 0; i < layerData.length; i ++ ) {

		const d = _noise2D( i * 0.01, layer ) * invAmp;
		out[ i ] = Math.floor( Math.max( 0, Math.min( 1, layerData[ i ] + d ) ) * 255 );

	}

	return out;

}

// ---------------------------------------------------------------------------
// Main DataArrayTexture class — mirrors three.js/src/textures/DataArrayTexture.js
// ---------------------------------------------------------------------------

/**
 * Creates an array of textures directly from raw buffer data.
 *
 * The buffer should have a length of `width * height * depth * 4`. For a
 * given layer, the texture is interpreted the same way as a
 * {@link DataTexture}:
 *
 * ```js
 * // create a 2D array texture with a 128x128x16 RGBA buffer
 * const width = 128;
 * const height = 128;
 * const depth = 16;
 * const size = width * height;
 * const data = new Uint8Array( 4 * size * depth );
 *
 * for ( let layer = 0; layer < depth; layer ++ ) {
 *   for ( let i = 0; i < size; i ++ ) {
 *     const stride = ( layer * size + i ) * 4;
 *     const x = i % width;
 *     const y = Math.floor( i / width );
 *     data[ stride ] = x;
 *     data[ stride + 1 ] = y;
 *     data[ stride + 2 ] = layer;
 *     data[ stride + 3 ] = 255;
 *   }
 * }
 *
 * const texture = new THREE.DataArrayTexture( data, width, height, depth );
 * texture.needsUpdate = true;
 * ```
 *
 * @augments Texture
 */
class DataArrayTexture extends Texture {

	/**
	 * Constructs a new data array texture.
	 *
	 * @param {?TypedArray} [data=null] - The buffer data.
	 * @param {number} [width=1] - The width of the texture.
	 * @param {number} [height=1] - The height of the texture.
	 * @param {number} [depth=1] - The depth of the texture.
	 */
	constructor( data = null, width = 1, height = 1, depth = 1 ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isDataArrayTexture = true;

		/**
		 * The image definition of a data texture.
		 *
		 * @type {{data: TypedArray, width: number, height: number, depth: number}}
		 */
		this.image = { data, width, height, depth };

		/**
		 * How the texture is sampled when a texel covers more than one pixel.
		 * Overwritten and set to `NearestFilter` by default.
		 *
		 * @type {number}
		 * @default NearestFilter
		 */
		this.magFilter = NearestFilter;

		/**
		 * How the texture is sampled when a texel covers less than one pixel.
		 * Overwritten and set to `NearestFilter` by default.
		 *
		 * @type {number}
		 * @default NearestFilter
		 */
		this.minFilter = NearestFilter;

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

		/**
		 * A set of all layers which need to be updated in the texture.
		 *
		 * @type {Set<number>}
		 */
		this.layerUpdates = new Set();

	}

	/**
	 * Describes that a specific layer of the texture needs to be updated.
	 *
	 * @param {number} layer - The layer index.
	 */
	addLayerUpdate( layer ) {

		this.layerUpdates.add( layer );

	}

	/**
	 * Clears the layer updates. Called automatically after upload to GPU.
	 */
	clearLayerUpdates() {

		this.layerUpdates.clear();

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated texel sampling from a specific layer. Writes into
	 * a preallocated glMatrix.vec4 for zero-allocation downstream processing.
	 * Assumes a 4-channel (RGBA) buffer.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [layer=0] - Layer index in [0, depth).
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleLayerGlMat( out = _gm_rgba, layer = 0, u = 0.5, v = 0.5 ) {

		const data = this.image.data;
		const width = this.image.width;
		const height = this.image.height;
		const depth = this.image.depth;

		if ( ! data || ! width || ! height || layer >= depth ) return null;

		const x = Math.min( width - 1, Math.max( 0, Math.floor( u * width ) ) );
		const y = Math.min( height - 1, Math.max( 0, Math.floor( v * height ) ) );

		const layerSize = width * height * 4;
		const layerOffset = layerSize * layer;

		const p = layerOffset + ( y * width + x ) * 4;

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
	 * gl-matrix accelerated 3-channel texel sampling from a specific layer
	 * (for RGB buffers).
	 *
	 * @param {glMatrix.vec3} [out] - Optional preallocated output vec3.
	 * @param {number} [layer=0] - Layer index in [0, depth).
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec3|null}
	 */
	sampleLayerRgbGlMat( out = _gm_rgb, layer = 0, u = 0.5, v = 0.5 ) {

		const data = this.image.data;
		const width = this.image.width;
		const height = this.image.height;
		const depth = this.image.depth;

		if ( ! data || ! width || ! height || layer >= depth ) return null;

		const x = Math.min( width - 1, Math.max( 0, Math.floor( u * width ) ) );
		const y = Math.min( height - 1, Math.max( 0, Math.floor( v * height ) ) );

		const layerSize = width * height * 3;
		const layerOffset = layerSize * layer;

		const p = layerOffset + ( y * width + x ) * 3;

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
	 * double.js bit-exact layer byte offset. Useful for very deep stacks
	 * where float32 multiplication of width*height*4*layer exceeds 2^24.
	 *
	 * @param {number} layer
	 * @returns {number}
	 */
	layerByteOffsetPrecise( layer ) {

		return layerByteOffsetPrecise( this.image.width, this.image.height, this.image.depth, layer );

	}

	/**
	 * Quantize a specific float layer into 8-bit with simplex-noise dithering.
	 * Returns a new Uint8ClampedArray suitable for LDR upload of that layer.
	 *
	 * @param {number} layer
	 * @param {number} [amplitude=0.5]
	 * @returns {Uint8ClampedArray|null}
	 */
	quantizeLayerDithered( layer, amplitude = 0.5 ) {

		if ( ! ( this.image.data instanceof Float32Array ) ) return null;

		const layerSize = this.image.width * this.image.height * 4;
		const layerOffset = layer * layerSize;
		const layerData = this.image.data.slice( layerOffset, layerOffset + layerSize );

		return quantizeLayerDithered( layerData, layer, amplitude );

	}

	/**
	 * Create a batched layer-processing coordinator backed by bitecs.
	 *
	 * @returns {DataArrayTextureBatch}
	 */
	static createBatch() {

		return new DataArrayTextureBatch();

	}

	/**
	 * Copy the given data array texture's properties into this one.
	 *
	 * @param {DataArrayTexture} source - The texture to copy from.
	 * @return {DataArrayTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.image = {
			data: source.image.data ? source.image.data.slice( 0 ) : null,
			width: source.image.width,
			height: source.image.height,
			depth: source.image.depth
		};

		this.magFilter = source.magFilter;
		this.minFilter = source.minFilter;

		this.generateMipmaps = source.generateMipmaps;
		this.flipY = source.flipY;
		this.unpackAlignment = source.unpackAlignment;

		return this;

	}

	/**
	 * Serializes the data array texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Data array texture pixel buffers cannot be serialized to JSON
		// directly. Only structural metadata (dimensions, type, format)
		// is preserved.
		output.image = {
			width: this.image.width,
			height: this.image.height,
			depth: this.image.depth,
			dataType: this.image.data ? this.image.data.constructor.name : null,
			byteLength: this.image.data ? this.image.data.byteLength : 0
		};

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { DataArrayTexture, DataArrayTextureBatch, layerByteOffsetPrecise, quantizeLayerDithered };
export default DataArrayTexture;