// file number : 008
// full path name : src/textures/008_data3dtexture.js
// description : Data3DTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class to create 3D (volume) textures directly from raw typed-array buffers. Preserves the full r185 API — image proxy with {data, width, height, depth}, generateMipmaps=false, flipY=false, unpackAlignment=1, magFilter/minFilter=NearestFilter, wrapR=ClampToEdgeWrapping, isData3DTexture flag, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated trilinear volume sampling for CPU-side voxel lookups, bitecs SoA batching for multi-slice uploads (volumetric rendering, 3D LUTs, medical imaging), double.js bit-exact depth-slice offset accumulation for very deep volumes, and simplex-noise dithered 3D noise generation for procedural volume textures.
// best for : Data3DTexture, volume rendering, 3D LUTs, medical imaging (CT/MRI), WebGL2 TEXTURE_3D, procedural volumetric clouds, Perlin/simplex noise volumes, and any three.js workflow that needs a true 3D texture.
// license : MIT

import { Texture } from './002_texture.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import {
	NearestFilter,
	ClampToEdgeWrapping,
	RGBAFormat,
	UnsignedByteType,
	FloatType,
	HalfFloatType,
	NoColorSpace,
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

// gl-matrix scratch for zero-allocation volume sampling
const _gm_rgba = glMatrix.vec4.create();
const _gm_rgb = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-slice uploads
// ---------------------------------------------------------------------------

const _volumeWorld = createWorld();

const VolumeSliceComponent = defineComponent( {
	texPtr: Types.ui32,
	slice: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	depth: Types.ui32,
	mode: Types.ui8,      // 0 = raw, 1 = normalize float, 2 = dither 8-bit
	done: Types.ui8
} );

class Data3DTextureBatch {

	constructor() {

		this.world = _volumeWorld;
		this.textures = [];
		this.outputs = [];
		this.entities = [];

	}

	/**
	 * Register a Data3DTexture instance for batched processing.
	 *
	 * @param {Data3DTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a processing job for a specific depth slice of a registered volume.
	 *
	 * @param {number} textureId
	 * @param {number} slice
	 * @param {number} [mode=0] - 0 = raw, 1 = normalize float, 2 = dither 8-bit.
	 * @returns {number} entity id
	 */
	addSliceJob( textureId, slice, mode = 0 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, VolumeSliceComponent, eid );

		const texture = this.textures[ textureId ];

		VolumeSliceComponent.texPtr[ eid ] = textureId;
		VolumeSliceComponent.slice[ eid ] = slice;
		VolumeSliceComponent.width[ eid ] = texture.image.width;
		VolumeSliceComponent.height[ eid ] = texture.image.height;
		VolumeSliceComponent.depth[ eid ] = texture.image.depth;
		VolumeSliceComponent.mode[ eid ] = mode;
		VolumeSliceComponent.done[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued slice jobs in one cache-friendly pass.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ VolumeSliceComponent.texPtr[ eid ] ];
			const data = texture.image.data;

			if ( ! data ) {

				VolumeSliceComponent.done[ eid ] = 1;
				this.outputs.push( null );
				continue;

			}

			const slice = VolumeSliceComponent.slice[ eid ];
			const width = VolumeSliceComponent.width[ eid ];
			const height = VolumeSliceComponent.height[ eid ];
			const sliceSize = width * height * 4;
			const sliceOffset = slice * sliceSize;

			const mode = VolumeSliceComponent.mode[ eid ];
			let result = null;

			if ( mode === 0 ) {

				result = data.slice( sliceOffset, sliceOffset + sliceSize );

			} else if ( mode === 1 && data instanceof Float32Array ) {

				// Normalize the slice's float data using double.js
				_double.value = 0;
				for ( let k = 0; k < sliceSize; k ++ ) {

					const abs = Math.abs( data[ sliceOffset + k ] );
					if ( abs > _double.value ) _double.value = abs;

				}

				const max = _double.value || 1;
				const out = new Float32Array( sliceSize );
				for ( let k = 0; k < sliceSize; k ++ ) {

					_double.value = data[ sliceOffset + k ];
					_double.div( max );
					out[ k ] = _double.value;

				}

				result = out;

			} else if ( mode === 2 && ( data instanceof Uint8Array || data instanceof Uint8ClampedArray ) ) {

				// Dither this slice's 8-bit output using simplex-noise
				const out = new Uint8ClampedArray( sliceSize );
				for ( let k = 0; k < sliceSize; k ++ ) {

					const d = _noise2D( k * 0.01, slice ) * 0.5;
					out[ k ] = Math.max( 0, Math.min( 255, data[ sliceOffset + k ] + d ) );

				}

				result = out;

			} else {

				result = data.slice( sliceOffset, sliceOffset + sliceSize );

			}

			const dstIndex = this.outputs.length;
			this.outputs.push( result );
			VolumeSliceComponent.done[ eid ] = 1;

		}

	}

	/**
	 * Retrieve the processed slice for a given entity.
	 *
	 * @param {number} eid
	 * @returns {TypedArray|null}
	 */
	result( eid ) {

		if ( ! VolumeSliceComponent.done[ eid ] ) return null;
		return this.outputs[ VolumeSliceComponent.dstPtr[ eid ] ];

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact depth-slice offset accumulation
// ---------------------------------------------------------------------------

/**
 * Compute the cumulative byte offset of a specific depth slice in a 3D
 * texture using double.js for bit-exact accumulation. Used when the
 * volume depth is large enough that float32 multiplication of
 * width*height*4*slice exceeds 2^24 and starts losing precision.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} slice
 * @returns {number}
 */
function sliceByteOffsetPrecise( width, height, slice ) {

	_double.value = width;
	_double.mul( height );
	_double.mul( 4 );
	_double.mul( slice );

	return _double.value;

}

// ---------------------------------------------------------------------------
// simplex-noise dithered 3D noise generation for procedural volumes
// ---------------------------------------------------------------------------

/**
 * Generate a procedural 3D volume using stacked simplex-noise slices.
 * Used to create organic cloud/smoke/fog volumes without loading external
 * data. Each depth slice is generated by sampling 2D noise at a different
 * offset, producing a smoothly varying 3D field.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} depth
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @param {number} [frequency=0.02] - Noise frequency.
 * @returns {Uint8ClampedArray} RGBA byte buffer of size width*height*depth*4.
 */
function generateNoiseVolume( width, height, depth, amplitude = 0.5, frequency = 0.02 ) {

	const out = new Uint8ClampedArray( width * height * depth * 4 );
	const invAmp = amplitude / 255;

	for ( let z = 0; z < depth; z ++ ) {

		const zOffset = z * 1000; // decorrelate slices

		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				const p = ( ( z * height + y ) * width + x ) * 4;

				// 3D noise approximated by combining two 2D slices
				const n1 = _noise2D( x * frequency, y * frequency + zOffset );
				const n2 = _noise2D( x * frequency + zOffset, y * frequency );
				const n = ( n1 + n2 ) * 0.5;

				const d = _noise2D( x * 0.1, y * 0.1 + z * 0.1 ) * invAmp;
				const value = Math.max( 0, Math.min( 1, ( n + 1 ) * 0.5 + d ) );

				// Store as grayscale RGBA (useful for cloud density)
				out[ p ] = Math.floor( value * 255 );
				out[ p + 1 ] = Math.floor( value * 255 );
				out[ p + 2 ] = Math.floor( value * 255 );
				out[ p + 3 ] = 255;

			}

		}

	}

	return out;

}

// ---------------------------------------------------------------------------
// Main Data3DTexture class — mirrors three.js/src/textures/Data3DTexture.js
// ---------------------------------------------------------------------------

/**
 * Creates a three-dimensional texture from raw data, with parameters to
 * divide it into width, height, and depth.
 *
 * ```js
 * // create a buffer with some data
 * const sizeX = 64;
 * const sizeY = 64;
 * const sizeZ = 64;
 * const data = new Uint8Array( sizeX * sizeY * sizeZ );
 * let i = 0;
 *
 * for ( let z = 0; z < sizeZ; z ++ ) {
 *   for ( let y = 0; y < sizeY; y ++ ) {
 *     for ( let x = 0; x < sizeX; x ++ ) {
 *       data[ i ] = i % 256;
 *       i ++;
 *     }
 *   }
 * }
 *
 * // use the buffer to create the texture
 * const texture = new THREE.Data3DTexture( data, sizeX, sizeY, sizeZ );
 * texture.needsUpdate = true;
 * ```
 *
 * @augments Texture
 */
class Data3DTexture extends Texture {

	/**
	 * Constructs a new data 3D texture.
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
		this.isData3DTexture = true;

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
		 * This defines how the texture is wrapped in the depth direction.
		 * Overwritten and set to `ClampToEdgeWrapping` by default.
		 *
		 * @type {number}
		 * @default ClampToEdgeWrapping
		 */
		this.wrapR = ClampToEdgeWrapping;

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
	 * gl-matrix accelerated texel sampling from the volume. Writes into a
	 * preallocated glMatrix.vec4 for zero-allocation downstream processing.
	 * Assumes a 4-channel (RGBA) buffer.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @param {number} [w=0.5] - W coordinate in [0, 1] (depth).
	 * @returns {glMatrix.vec4|null}
	 */
	sampleGlMat( out = _gm_rgba, u = 0.5, v = 0.5, w = 0.5 ) {

		const data = this.image.data;
		const width = this.image.width;
		const height = this.image.height;
		const depth = this.image.depth;

		if ( ! data || ! width || ! height || ! depth ) return null;

		const x = Math.min( width - 1, Math.max( 0, Math.floor( u * width ) ) );
		const y = Math.min( height - 1, Math.max( 0, Math.floor( v * height ) ) );
		const z = Math.min( depth - 1, Math.max( 0, Math.floor( w * depth ) ) );

		const p = ( ( z * height + y ) * width + x ) * 4;

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
	 * gl-matrix accelerated 3-channel texel sampling from the volume
	 * (for RGB buffers).
	 *
	 * @param {glMatrix.vec3} [out] - Optional preallocated output vec3.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @param {number} [w=0.5] - W coordinate in [0, 1] (depth).
	 * @returns {glMatrix.vec3|null}
	 */
	sampleRgbGlMat( out = _gm_rgb, u = 0.5, v = 0.5, w = 0.5 ) {

		const data = this.image.data;
		const width = this.image.width;
		const height = this.image.height;
		const depth = this.image.depth;

		if ( ! data || ! width || ! height || ! depth ) return null;

		const x = Math.min( width - 1, Math.max( 0, Math.floor( u * width ) ) );
		const y = Math.min( height - 1, Math.max( 0, Math.floor( v * height ) ) );
		const z = Math.min( depth - 1, Math.max( 0, Math.floor( w * depth ) ) );

		const p = ( ( z * height + y ) * width + x ) * 3;

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
	 * gl-matrix accelerated trilinear interpolation within the volume.
	 * Provides smooth sampling for volume rendering and 3D LUT lookups.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @param {number} [w=0.5] - W coordinate in [0, 1] (depth).
	 * @returns {glMatrix.vec4|null}
	 */
	sampleTrilinearGlMat( out = _gm_rgba, u = 0.5, v = 0.5, w = 0.5 ) {

		const data = this.image.data;
		const width = this.image.width;
		const height = this.image.height;
		const depth = this.image.depth;

		if ( ! data || ! width || ! height || ! depth ) return null;

		const fx = u * ( width - 1 );
		const fy = v * ( height - 1 );
		const fz = w * ( depth - 1 );

		const x0 = Math.floor( fx );
		const y0 = Math.floor( fy );
		const z0 = Math.floor( fz );

		const x1 = Math.min( x0 + 1, width - 1 );
		const y1 = Math.min( y0 + 1, height - 1 );
		const z1 = Math.min( z0 + 1, depth - 1 );

		const dx = fx - x0;
		const dy = fy - y0;
		const dz = fz - z0;

		const scale = ( this.type === FloatType || this.type === HalfFloatType ) ? 1 : 1 / 255;

		// Precompute slice offsets for the 8 corners
		const i000 = ( ( z0 * height + y0 ) * width + x0 ) * 4;
		const i100 = ( ( z0 * height + y0 ) * width + x1 ) * 4;
		const i010 = ( ( z0 * height + y1 ) * width + x0 ) * 4;
		const i110 = ( ( z0 * height + y1 ) * width + x1 ) * 4;
		const i001 = ( ( z1 * height + y0 ) * width + x0 ) * 4;
		const i101 = ( ( z1 * height + y0 ) * width + x1 ) * 4;
		const i011 = ( ( z1 * height + y1 ) * width + x0 ) * 4;
		const i111 = ( ( z1 * height + y1 ) * width + x1 ) * 4;

		for ( let c = 0; c < 4; c ++ ) {

			// Interpolate along X for each of the 4 Z-Y pairs
			const c000 = data[ i000 + c ] * ( 1 - dx ) + data[ i100 + c ] * dx;
			const c010 = data[ i010 + c ] * ( 1 - dx ) + data[ i110 + c ] * dx;
			const c001 = data[ i001 + c ] * ( 1 - dx ) + data[ i101 + c ] * dx;
			const c011 = data[ i011 + c ] * ( 1 - dx ) + data[ i111 + c ] * dx;

			// Interpolate along Y
			const c00 = c000 * ( 1 - dy ) + c010 * dy;
			const c01 = c001 * ( 1 - dy ) + c011 * dy;

			// Interpolate along Z
			out[ c ] = ( c00 * ( 1 - dz ) + c01 * dz ) * scale;

		}

		return out;

	}

	/**
	 * double.js bit-exact depth-slice byte offset. Useful for very deep
	 * volumes where float32 multiplication of width*height*4*slice
	 * exceeds 2^24.
	 *
	 * @param {number} slice
	 * @returns {number}
	 */
	sliceByteOffsetPrecise( slice ) {

		return sliceByteOffsetPrecise( this.image.width, this.image.height, slice );

	}

	/**
	 * Generate a procedural 3D noise volume using stacked simplex-noise
	 * slices. Populates the image buffer directly. Used to create organic
	 * cloud/smoke/fog volumes without loading external data.
	 *
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @param {number} [frequency=0.02] - Noise frequency.
	 * @returns {Data3DTexture} A reference to this instance.
	 */
	generateNoiseVolume( amplitude = 0.5, frequency = 0.02 ) {

		const { width, height, depth } = this.image;

		this.image.data = generateNoiseVolume( width, height, depth, amplitude, frequency );
		this.needsUpdate = true;

		return this;

	}

	/**
	 * Create a batched volume-slice processing coordinator backed by bitecs.
	 *
	 * @returns {Data3DTextureBatch}
	 */
	static createBatch() {

		return new Data3DTextureBatch();

	}

	/**
	 * Copy the given data 3D texture's properties into this one.
	 *
	 * @param {Data3DTexture} source - The texture to copy from.
	 * @return {Data3DTexture} A reference to this instance.
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
		this.wrapR = source.wrapR;

		this.generateMipmaps = source.generateMipmaps;
		this.flipY = source.flipY;
		this.unpackAlignment = source.unpackAlignment;

		return this;

	}

	/**
	 * Serializes the data 3D texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Data 3D texture pixel buffers cannot be serialized to JSON
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

export { Data3DTexture, Data3DTextureBatch, sliceByteOffsetPrecise, generateNoiseVolume };
export default Data3DTexture;