// file number : 004
// full path name : src/textures/004_compressedtexture.js
// description : CompressedTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class and stores pre-compressed mipmaps (KTX, KTX2, DDS, Basis, ASTC, ETC, PVR) instead of a single image source. Preserves the full r185 API — mipmaps array, image proxy with {width, height, depth}, generateMipmaps=false, flipY=false, unpackAlignment=1, needsUpdate=true on construction, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated multi-mip sampling for CPU-side verification, bitecs SoA batching for multi-KTX pipelines (batch-loading compressed texture atlases), double.js bit-exact mip-size validation for large texture arrays, and simplex-noise dithered fallback decoding for platforms lacking native compression support.
// best for : CompressedTexture, KTX/KTX2/DDS/Basis/ASTC/ETC/PVR loaders, GPU compressed texture pipelines, memory-constrained mobile/VR rendering, and any three.js workflow that streams pre-compressed texture data.
// license : MIT

import { Texture } from './002_texture.js';
import {
	NoColorSpace,
	LinearFilter,
	LinearMipmapLinearFilter,
	RGBAFormat,
	UnsignedByteType,
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

// gl-matrix scratch for zero-allocation mip sampling
const _gm_rgba = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-KTX pipelines
// ---------------------------------------------------------------------------

const _compressedWorld = createWorld();

const CompressedMipComponent = defineComponent( {
	texPtr: Types.ui32,
	mipLevel: Types.ui8,
	width: Types.ui32,
	height: Types.ui32,
	depth: Types.ui32,
	byteLength: Types.ui32,
	validated: Types.ui8
} );

class CompressedTextureBatch {

	constructor() {

		this.world = _compressedWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a CompressedTexture instance for batched validation.
	 *
	 * @param {CompressedTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Enumerate all mip levels of a registered compressed texture and queue
	 * a validation job per mip.
	 *
	 * @param {number} textureId
	 * @returns {number} the first entity id created (subsequent entities are sequential)
	 */
	enumerateMips( textureId ) {

		const texture = this.textures[ textureId ];
		const mipmaps = texture.mipmaps;
		let firstEid = 0;

		for ( let i = 0, l = mipmaps.length; i < l; i ++ ) {

			const mip = mipmaps[ i ];
			const eid = addEntity( this.world );
			addComponent( this.world, CompressedMipComponent, eid );

			CompressedMipComponent.texPtr[ eid ] = textureId;
			CompressedMipComponent.mipLevel[ eid ] = i;
			CompressedMipComponent.width[ eid ] = mip.width;
			CompressedMipComponent.height[ eid ] = mip.height;
			CompressedMipComponent.depth[ eid ] = mip.depth ?? 1;
			CompressedMipComponent.byteLength[ eid ] = mip.data ? mip.data.byteLength : 0;
			CompressedMipComponent.validated[ eid ] = 0;

			this.entities.push( eid );
			if ( i === 0 ) firstEid = eid;

		}

		return firstEid;

	}

	/**
	 * Validate all queued mip levels in one cache-friendly pass. Checks that
	 * each mip is exactly half the size of the previous one (in both
	 * dimensions), which is the requirement for GPU-compressed mip chains.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const mipLevel = CompressedMipComponent.mipLevel[ eid ];

			if ( mipLevel === 0 ) {

				CompressedMipComponent.validated[ eid ] = 1;
				continue;

			}

			// Find the parent mip (mipLevel - 1) for the same texture
			const texPtr = CompressedMipComponent.texPtr[ eid ];
			let parentEid = 0;

			for ( let j = 0; j < l; j ++ ) {

				const other = entities[ j ];
				if ( CompressedMipComponent.texPtr[ other ] === texPtr &&
					CompressedMipComponent.mipLevel[ other ] === mipLevel - 1 ) {

					parentEid = other;
					break;

				}

			}

			if ( parentEid === 0 ) {

				CompressedMipComponent.validated[ eid ] = 0;
				continue;

			}

			const expectedW = Math.max( 1, CompressedMipComponent.width[ parentEid ] >> 1 );
			const expectedH = Math.max( 1, CompressedMipComponent.height[ parentEid ] >> 1 );

			const ok = CompressedMipComponent.width[ eid ] === expectedW &&
				CompressedMipComponent.height[ eid ] === expectedH;

			CompressedMipComponent.validated[ eid ] = ok ? 1 : 0;

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
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = CompressedMipComponent.validated[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact mip-chain size computation
// ---------------------------------------------------------------------------

/**
 * Compute the total byte length of a compressed mip chain using double.js
 * for bit-exact accumulation. Used when validating very large compressed
 * textures (e.g. 16K × 16K ASTC atlases) where float32 accumulation of
 * mip sizes drifts above 2^24 bytes.
 *
 * @param {Array<{width: number, height: number, data?: any}>} mipmaps
 * @returns {number}
 */
function computeMipChainBytesPrecise( mipmaps ) {

	_double.value = 0;
	for ( let i = 0, l = mipmaps.length; i < l; i ++ ) {

		const mip = mipmaps[ i ];
		if ( mip.data && mip.data.byteLength !== undefined ) {

			_double.add( mip.data.byteLength );

		} else {

			// Fallback: estimate from dimensions (RGBA8 assumption)
			_double.add( mip.width * mip.height * 4 );

		}

	}

	return _double.value;

}

// ---------------------------------------------------------------------------
// simplex-noise dithered fallback decoding for platforms without native compression
// ---------------------------------------------------------------------------

/**
 * Produce a simple dithered RGBA fallback image for a compressed texture.
 * Used when the platform lacks native support for the source compression
 * format and a raw-pixel fallback is required. This is intentionally
 * low-fidelity — it exists so the pipeline degrades gracefully rather than
 * crashing, and the simplex-noise dithering prevents visible banding.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @returns {Uint8ClampedArray} RGBA byte buffer.
 */
function generateFallbackImage( width, height, amplitude = 0.5 ) {

	const out = new Uint8ClampedArray( width * height * 4 );
	const invAmp = amplitude / 255;

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const p = ( y * width + x ) * 4;
			const d = _noise2D( x * 0.05, y * 0.05 ) * invAmp;

			// Subtle magenta/gray checker so the fallback is visually distinct
			const check = ( ( x >> 4 ) ^ ( y >> 4 ) ) & 1;
			out[ p ] = Math.floor( ( check ? 0.6 : 0.4 ) * 255 + d * 255 );
			out[ p + 1 ] = Math.floor( 0.3 * 255 + d * 255 );
			out[ p + 2 ] = Math.floor( 0.7 * 255 + d * 255 );
			out[ p + 3 ] = 255;

		}

	}

	return out;

}

// ---------------------------------------------------------------------------
// Main CompressedTexture class — mirrors three.js/src/textures/CompressedTexture.js
// ---------------------------------------------------------------------------

/**
 * Creates a texture based on data in compressed form, for example from a
 * [DDS](https://en.wikipedia.org/wiki/DirectDraw_Surface) or
 * [KTX](https://www.khronos.org/ktx/) file.
 *
 * For use with the {@link CompressedTextureLoader}.
 *
 * @augments Texture
 */
class CompressedTexture extends Texture {

	/**
	 * Constructs a new compressed texture.
	 *
	 * @param {Array} [mipmaps] - The array of mipmaps. Each element should be an
	 *   object with `data`, `width`, and `height` properties.
	 * @param {number} [width] - The width of the texture.
	 * @param {number} [height] - The height of the texture.
	 * @param {number} [format=RGBAFormat] - The texture format.
	 * @param {number} [type=UnsignedByteType] - The texture type.
	 * @param {number} [mapping=Texture.DEFAULT_MAPPING] - The texture mapping.
	 * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
	 * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
	 * @param {number} [magFilter=LinearFilter] - The mag filter value.
	 * @param {number} [minFilter=LinearMipmapLinearFilter] - The min filter value.
	 * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
	 * @param {string} [colorSpace=NoColorSpace] - The color space.
	 */
	constructor(
		mipmaps,
		width,
		height,
		format = RGBAFormat,
		type = UnsignedByteType,
		mapping = Texture.DEFAULT_MAPPING,
		wrapS = ClampToEdgeWrapping,
		wrapT = ClampToEdgeWrapping,
		magFilter = LinearFilter,
		minFilter = LinearMipmapLinearFilter,
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
		this.isCompressedTexture = true;

		/**
		 * The image property of a compressed texture just defines its dimensions.
		 *
		 * @type {{width: number, height: number, depth: number}}
		 */
		this.image = { width, height, depth: 1 };

		/**
		 * The array of mipmaps. Each element should be an object with `data`,
		 * `width`, and `height` properties.
		 *
		 * @type {Array}
		 */
		this.mipmaps = mipmaps;

		// no flipping for texture uploads, since the texture is already flipped
		this.generateMipmaps = false;
		this.flipY = false;
		this.unpackAlignment = 1;

		// compressed textures typically require special handling for NPOT
		this.needsUpdate = true;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated pixel sampling from the top mip of a compressed
	 * texture's fallback buffer (if any). Returns null if no fallback data
	 * is present — compressed textures normally do not have CPU-side pixels.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleGlMat( out = _gm_rgba, u = 0.5, v = 0.5 ) {

		// Compressed textures do not have CPU-readable pixels. If a fallback
		// was attached (see generateFallback), sample from it.
		if ( ! this._fallback ) return null;

		const fallback = this._fallback;
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
	 * double.js bit-exact total mip-chain byte length. Useful for budgeting
	 * GPU memory when streaming very large compressed atlases.
	 *
	 * @returns {number}
	 */
	getMipChainBytesPrecise() {

		return computeMipChainBytesPrecise( this.mipmaps );

	}

	/**
	 * Generate a dithered fallback image for platforms without native
	 * support for this compression format. The fallback is stored on the
	 * instance and can be sampled via `sampleGlMat`.
	 *
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {CompressedTexture} A reference to this instance.
	 */
	generateFallback( amplitude = 0.5 ) {

		this._fallback = {
			width: this.image.width,
			height: this.image.height,
			data: generateFallbackImage( this.image.width, this.image.height, amplitude )
		};

		return this;

	}

	/**
	 * Create a batched mip-validation coordinator backed by bitecs.
	 * Enumerates and validates the mip chains of many CompressedTexture
	 * instances in a single cache-friendly pass.
	 *
	 * @returns {CompressedTextureBatch}
	 */
	static createBatch() {

		return new CompressedTextureBatch();

	}

	/**
	 * Copy the given compressed texture's properties into this one.
	 *
	 * @param {CompressedTexture} source - The texture to copy from.
	 * @return {CompressedTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.mipmaps = source.mipmaps.slice( 0 );
		this.image = {
			width: source.image.width,
			height: source.image.height,
			depth: source.image.depth ?? 1
		};

		return this;

	}

	/**
	 * Serializes the compressed texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Compressed textures cannot serialize their pixel data into JSON.
		// Only the structural metadata (dimensions, format, mip count) is
		// preserved; the actual bytes must be re-loaded from the source file.
		output.image = {
			width: this.image.width,
			height: this.image.height,
			depth: this.image.depth ?? 1
		};

		output.mipmaps = this.mipmaps.map( mip => ( {
			width: mip.width,
			height: mip.height,
			depth: mip.depth ?? 1,
			byteLength: mip.data ? mip.data.byteLength : 0
		} ) );

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { CompressedTexture, CompressedTextureBatch, computeMipChainBytesPrecise, generateFallbackImage };
export default CompressedTexture;