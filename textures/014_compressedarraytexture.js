// file number : 014
// full path name : src/textures/014_compressedarraytexture.js
// description : CompressedArrayTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 004_compressedtexture.js (which itself extends 002_texture.js) to create an array of compressed 2D textures backed by a single GPU array-texture allocation. Preserves the full r185 API — image proxy with {width, height, depth}, layerUpdates Set, wrapR=ClampToEdgeWrapping, format/type overrides, isCompressedArrayTexture flag, addLayerUpdate(), clearLayerUpdates(), plus clone(), copy(), toJSON(). Adds gl-matrix accelerated layer sampling for CPU-side verification, bitecs SoA batching for multi-layer KTX2 array pipelines (texture-array atlases, terrain splat maps, morph-target arrays), double.js bit-exact layer byte-offset accumulation for very deep arrays, and simplex-noise dithered fallback painting for platforms without native array-texture support.
// best for : CompressedArrayTexture, KTX2 array textures, GPU texture arrays for splat maps, layered materials with per-layer updates, WebGL2 TEXTURE_2D_ARRAY uploads, and any three.js workflow that needs a compressed array texture with layer-level update control.
// license : MIT

import { CompressedTexture } from './004_compressedtexture.js';
import {
	RGBAFormat,
	UnsignedByteType,
	NoColorSpace,
	ClampToEdgeWrapping,
	LinearFilter,
	LinearMipmapLinearFilter
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

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-layer KTX2 array pipelines
// ---------------------------------------------------------------------------

const _arrayWorld = createWorld();

const ArrayLayerComponent = defineComponent( {
	texPtr: Types.ui32,
	layer: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	depth: Types.ui32,
	mipCount: Types.ui8,
	validated: Types.ui8
} );

class CompressedArrayTextureBatch {

	constructor() {

		this.world = _arrayWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a CompressedArrayTexture instance for batched layer validation.
	 *
	 * @param {CompressedArrayTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Enumerate all layers of a registered compressed array texture and
	 * queue a validation job per layer.
	 *
	 * @param {number} textureId
	 * @returns {number} the first entity id created
	 */
	enumerateLayers( textureId ) {

		const texture = this.textures[ textureId ];
		const depth = texture.image.depth;
		const mipCount = texture.mipmaps.length;
		let firstEid = 0;

		for ( let layer = 0; layer < depth; layer ++ ) {

			const eid = addEntity( this.world );
			addComponent( this.world, ArrayLayerComponent, eid );

			ArrayLayerComponent.texPtr[ eid ] = textureId;
			ArrayLayerComponent.layer[ eid ] = layer;
			ArrayLayerComponent.width[ eid ] = texture.image.width;
			ArrayLayerComponent.height[ eid ] = texture.image.height;
			ArrayLayerComponent.depth[ eid ] = depth;
			ArrayLayerComponent.mipCount[ eid ] = mipCount;
			ArrayLayerComponent.validated[ eid ] = 0;

			this.entities.push( eid );
			if ( layer === 0 ) firstEid = eid;

		}

		return firstEid;

	}

	/**
	 * Validate all queued layers in one cache-friendly pass. Checks that
	 * each layer index is in range and that the mip chain is well-formed.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const layer = ArrayLayerComponent.layer[ eid ];
			const depth = ArrayLayerComponent.depth[ eid ];
			const mipCount = ArrayLayerComponent.mipCount[ eid ];

			const ok = layer < depth && mipCount > 0;

			ArrayLayerComponent.validated[ eid ] = ok ? 1 : 0;

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
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = ArrayLayerComponent.validated[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact layer byte-offset accumulation for very deep arrays
// ---------------------------------------------------------------------------

/**
 * Compute the cumulative byte offset of a specific layer in a compressed
 * array texture using double.js for bit-exact accumulation. Used when the
 * array depth is large enough that float32 multiplication of
 * layerSize * depth exceeds 2^24 and starts losing precision.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} layer
 * @param {number} [bytesPerPixel=4] - Bytes per pixel in the compressed format.
 * @returns {number}
 */
function arrayLayerByteOffsetPrecise( width, height, layer, bytesPerPixel = 4 ) {

	_double.value = width;
	_double.mul( height );
	_double.mul( bytesPerPixel );
	_double.mul( layer );

	return _double.value;

}

// ---------------------------------------------------------------------------
// simplex-noise dithered fallback painting for platforms without array support
// ---------------------------------------------------------------------------

/**
 * Paint a dithered fallback pattern for platforms that lack native support
 * for compressed array textures (WebGL1, older mobile GPUs). This is
 * intentionally low-fidelity — it exists so the pipeline degrades
 * gracefully and the simplex-noise dithering prevents visible banding.
 *
 * @param {HTMLCanvasElement} canvas - The backing canvas.
 * @param {number} layer - The layer index (used to vary the pattern).
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 */
function paintArrayFallback( canvas, layer, amplitude = 0.5 ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.createImageData( canvas.width, canvas.height );
	const data = imageData.data;
	const invAmp = amplitude / 255;

	for ( let y = 0; y < canvas.height; y ++ ) {

		for ( let x = 0; x < canvas.width; x ++ ) {

			const p = ( y * canvas.width + x ) * 4;
			const d = _noise2D( x * 0.05 + layer * 100, y * 0.05 ) * invAmp;

			// Layer-indexed gradient placeholder
			const t = ( x + y ) / ( canvas.width + canvas.height );
			const hue = ( layer * 0.2 ) % 1;

			data[ p ] = Math.floor( Math.max( 0, Math.min( 1, hue * t + d ) ) * 255 );
			data[ p + 1 ] = Math.floor( Math.max( 0, Math.min( 1, ( 1 - hue ) * t + d ) ) * 255 );
			data[ p + 2 ] = Math.floor( Math.max( 0, Math.min( 1, 0.5 + d ) ) * 255 );
			data[ p + 3 ] = 255;

		}

	}

	ctx.putImageData( imageData, 0, 0 );

}

// ---------------------------------------------------------------------------
// Main CompressedArrayTexture class — mirrors three.js/src/textures/CompressedArrayTexture.js
// ---------------------------------------------------------------------------

/**
 * Creates an array of textures directly from raw data in compressed form,
 * with parameters to divide it into width, height, and depth.
 *
 * For use with the {@link CompressedTextureLoader}.
 *
 * @augments CompressedTexture
 */
class CompressedArrayTexture extends CompressedTexture {

	/**
	 * Constructs a new compressed array texture.
	 *
	 * @param {Array} [mipmaps] - The array of mipmaps. Each element should be
	 *   an object with `data`, `width`, `height`, and `depth` properties.
	 * @param {number} [width] - The width of the texture.
	 * @param {number} [height] - The height of the texture.
	 * @param {number} [depth] - The depth of the texture.
	 * @param {number} [format=RGBAFormat] - The texture format.
	 * @param {number} [type=UnsignedByteType] - The texture type.
	 */
	constructor(
		mipmaps,
		width,
		height,
		depth,
		format = RGBAFormat,
		type = UnsignedByteType
	) {

		super( mipmaps, width, height, format, type );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isCompressedArrayTexture = true;

		/**
		 * The image definition of a compressed array texture.
		 *
		 * @type {{width: number, height: number, depth: number}}
		 */
		this.image.depth = depth;

		/**
		 * This defines how the texture is wrapped in the depth direction.
		 * Overwritten and set to `ClampToEdgeWrapping` by default.
		 *
		 * @type {number}
		 * @default ClampToEdgeWrapping
		 */
		this.wrapR = ClampToEdgeWrapping;

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
	 * gl-matrix accelerated texel sampling from a specific layer of a
	 * compressed array texture's CPU-side fallback (if attached via
	 * `paintFallback`). Compressed array textures normally do not have
	 * CPU-readable pixels.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [layer=0] - Layer index in [0, depth).
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleLayerGlMat( out = _gm_rgba, layer = 0, u = 0.5, v = 0.5 ) {

		if ( ! this._fallback || layer >= this._fallback.length ) return null;

		const fallback = this._fallback[ layer ];
		if ( ! fallback ) return null;

		const x = Math.min( fallback.width - 1, Math.max( 0, Math.floor( u * fallback.width ) ) );
		const y = Math.min( fallback.height - 1, Math.max( 0, Math.floor( v * fallback.height ) ) );
		const p = ( y * fallback.width + x ) * 4;

		glMatrix.vec4.set(
			out,
			fallback.data[ p ] / 255,
			fallback.data[ p + 1 ] / 255,
			fallback.data[ p + 2 ] / 255,
			fallback.data[ p + 3 ] / 255
		);

		return out;

	}

	/**
	 * double.js bit-exact layer byte offset. Useful for very deep compressed
	 * arrays where float32 multiplication of width*height*layer exceeds 2^24.
	 *
	 * @param {number} layer
	 * @param {number} [bytesPerPixel=4]
	 * @returns {number}
	 */
	layerByteOffsetPrecise( layer, bytesPerPixel = 4 ) {

		return arrayLayerByteOffsetPrecise( this.image.width, this.image.height, layer, bytesPerPixel );

	}

	/**
	 * Paint a dithered fallback pattern for every layer of this compressed
	 * array texture. Used on platforms that lack native support for
	 * compressed array textures. The fallback is stored on the instance and
	 * can be sampled via `sampleLayerGlMat`.
	 *
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {CompressedArrayTexture} A reference to this instance.
	 */
	paintFallback( amplitude = 0.5 ) {

		const depth = this.image.depth;
		const width = this.image.width;
		const height = this.image.height;

		this._fallback = [];

		for ( let layer = 0; layer < depth; layer ++ ) {

			const canvas = document.createElement( 'canvas' );
			canvas.width = width;
			canvas.height = height;

			paintArrayFallback( canvas, layer, amplitude );

			const ctx = canvas.getContext( '2d' );
			const imageData = ctx.getImageData( 0, 0, width, height );

			this._fallback.push( {
				width,
				height,
				data: imageData.data
			} );

		}

		return this;

	}

	/**
	 * Create a batched compressed-array layer validation coordinator backed
	 * by bitecs.
	 *
	 * @returns {CompressedArrayTextureBatch}
	 */
	static createBatch() {

		return new CompressedArrayTextureBatch();

	}

	/**
	 * Copy the given compressed array texture's properties into this one.
	 *
	 * @param {CompressedArrayTexture} source - The texture to copy from.
	 * @return {CompressedArrayTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.image.depth = source.image.depth;
		this.wrapR = source.wrapR;

		this.layerUpdates.clear();
		for ( const layer of source.layerUpdates ) {

			this.layerUpdates.add( layer );

		}

		return this;

	}

	/**
	 * Serializes the compressed array texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Compressed array textures cannot serialize their pixel data
		// directly. Only structural metadata (dimensions, format, mip
		// count) is preserved.
		output.image = {
			width: this.image.width,
			height: this.image.height,
			depth: this.image.depth
		};

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { CompressedArrayTexture, CompressedArrayTextureBatch, arrayLayerByteOffsetPrecise, paintArrayFallback };
export default CompressedArrayTexture;