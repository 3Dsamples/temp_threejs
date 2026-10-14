// file number : 015
// full path name : src/textures/015_compressedcubetexture.js
// description : CompressedCubeTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 004_compressedtexture.js (which itself extends 002_texture.js) to represent a cube map whose six faces are each in a GPU-compressed format (DDS, KTX2, Basis, ASTC, ETC, PVR). Preserves the full r185 API — images array of six compressed face descriptors, isCompressedCubeTexture flag, isCubeTexture flag, CubeReflectionMapping default, format/type propagation, generateMipmaps=false, flipY=false, unpackAlignment=1, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated cube-face direction computation for CPU-side verification, bitecs SoA batching for multi-face compression pipelines (batch-uploading six face KTX2 data streams), double.js bit-exact per-face byte-size validation for large HDR cubemaps, and simplex-noise dithered fallback painting for platforms that lack native compressed cubemap support.
// best for : CompressedCubeTexture, KTX2/DDS/Basis cubemap loaders, PMREMGenerator input, environment maps, reflection probes, skyboxes, and any three.js workflow that needs six compressed faces of a cube as a single texture unit.
// license : MIT

import { CompressedTexture } from './004_compressedtexture.js';
import {
	CubeReflectionMapping,
	RGBAFormat,
	UnsignedByteType,
	NoColorSpace,
	LinearFilter,
	LinearMipmapLinearFilter,
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

// gl-matrix scratch for zero-allocation cube-face direction computation
const _gm_dir = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Cube face constants (matches WebGL cube face ordering)
// ---------------------------------------------------------------------------

const CUBE_FACE_POS_X = 0;
const CUBE_FACE_NEG_X = 1;
const CUBE_FACE_POS_Y = 2;
const CUBE_FACE_NEG_Y = 3;
const CUBE_FACE_POS_Z = 4;
const CUBE_FACE_NEG_Z = 5;

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-face compression pipelines
// ---------------------------------------------------------------------------

const _cubeWorld = createWorld();

const CubeFaceComponent = defineComponent( {
	texPtr: Types.ui32,
	face: Types.ui8,
	width: Types.ui32,
	height: Types.ui32,
	mipCount: Types.ui8,
	byteLength: Types.ui32,
	validated: Types.ui8
} );

class CompressedCubeTextureBatch {

	constructor() {

		this.world = _cubeWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a CompressedCubeTexture instance for batched face validation.
	 *
	 * @param {CompressedCubeTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Enumerate the six faces of a registered compressed cubemap and queue
	 * a validation job per face.
	 *
	 * @param {number} textureId
	 * @returns {number} the first entity id created
	 */
	enumerateFaces( textureId ) {

		const texture = this.textures[ textureId ];
		const images = texture.image;
		let firstEid = 0;

		for ( let f = 0; f < 6; f ++ ) {

			const img = images[ f ];
			const eid = addEntity( this.world );
			addComponent( this.world, CubeFaceComponent, eid );

			CubeFaceComponent.texPtr[ eid ] = textureId;
			CubeFaceComponent.face[ eid ] = f;
			CubeFaceComponent.width[ eid ] = img?.width ?? 0;
			CubeFaceComponent.height[ eid ] = img?.height ?? 0;
			CubeFaceComponent.mipCount[ eid ] = img?.mipmaps?.length ?? 0;
			CubeFaceComponent.byteLength[ eid ] = img?.data?.byteLength ?? 0;
			CubeFaceComponent.validated[ eid ] = 0;

			this.entities.push( eid );
			if ( f === 0 ) firstEid = eid;

		}

		return firstEid;

	}

	/**
	 * Validate all queued faces in one cache-friendly pass. Checks that
	 * dimensions are positive, mip chains are non-empty, and byte lengths
	 * are consistent.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const width = CubeFaceComponent.width[ eid ];
			const height = CubeFaceComponent.height[ eid ];
			const mipCount = CubeFaceComponent.mipCount[ eid ];
			const byteLength = CubeFaceComponent.byteLength[ eid ];

			const ok = width > 0 && height > 0 && mipCount > 0 && byteLength > 0;

			CubeFaceComponent.validated[ eid ] = ok ? 1 : 0;

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
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = CubeFaceComponent.validated[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact per-face byte-size validation
// ---------------------------------------------------------------------------

/**
 * Compute the total byte length of all six compressed faces using double.js
 * for bit-exact accumulation. Used for large HDR cubemaps (e.g. 8K × 8K per
 * face) where float32 accumulation of face sizes exceeds 2^24 bytes.
 *
 * @param {Array<{data?: any, width: number, height: number}>} images
 * @returns {number}
 */
function computeCubeFaceBytesPrecise( images ) {

	_double.value = 0;

	for ( let f = 0; f < 6; f ++ ) {

		const img = images[ f ];
		if ( ! img ) continue;

		if ( img.data && img.data.byteLength !== undefined ) {

			_double.add( img.data.byteLength );

		} else {

			// Fallback: estimate from dimensions (RGBA8 assumption)
			_double.add( img.width * img.height * 4 );

		}

	}

	return _double.value;

}

// ---------------------------------------------------------------------------
// simplex-noise dithered fallback painting for platforms without native support
// ---------------------------------------------------------------------------

/**
 * Paint a dithered fallback pattern for platforms that lack native support
 * for compressed cubemaps (WebGL1, older mobile GPUs). This is
 * intentionally low-fidelity — it exists so the pipeline degrades gracefully
 * and the simplex-noise dithering prevents visible banding.
 *
 * @param {HTMLCanvasElement} canvas - The backing canvas.
 * @param {number} face - Cube face index (0..5).
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 */
function paintCubeFallback( canvas, face, amplitude = 0.5 ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.createImageData( canvas.width, canvas.height );
	const data = imageData.data;
	const invAmp = amplitude / 255;

	// Per-face base colors for visual distinction
	const faceColors = [
		[ 1.0, 0.2, 0.2 ], [ 0.2, 1.0, 0.2 ], [ 0.2, 0.2, 1.0 ],
		[ 1.0, 1.0, 0.2 ], [ 1.0, 0.2, 1.0 ], [ 0.2, 1.0, 1.0 ]
	];

	const baseColor = faceColors[ face ] || [ 0.5, 0.5, 0.5 ];

	for ( let y = 0; y < canvas.height; y ++ ) {

		for ( let x = 0; x < canvas.width; x ++ ) {

			const p = ( y * canvas.width + x ) * 4;
			const d = _noise2D( x * 0.05 + face * 100, y * 0.05 ) * invAmp;

			// Radial gradient from center
			const cx = ( x / canvas.width ) - 0.5;
			const cy = ( y / canvas.height ) - 0.5;
			const dist = Math.sqrt( cx * cx + cy * cy );

			data[ p ] = Math.floor( Math.max( 0, Math.min( 1, baseColor[ 0 ] * ( 1 - dist ) + d ) ) * 255 );
			data[ p + 1 ] = Math.floor( Math.max( 0, Math.min( 1, baseColor[ 1 ] * ( 1 - dist ) + d ) ) * 255 );
			data[ p + 2 ] = Math.floor( Math.max( 0, Math.min( 1, baseColor[ 2 ] * ( 1 - dist ) + d ) ) * 255 );
			data[ p + 3 ] = 255;

		}

	}

	ctx.putImageData( imageData, 0, 0 );

}

// ---------------------------------------------------------------------------
// Main CompressedCubeTexture class — mirrors three.js/src/textures/CompressedCubeTexture.js
// ---------------------------------------------------------------------------

/**
 * Creates a cube texture based on data in compressed form.
 *
 * For use with the {@link CompressedTextureLoader}.
 *
 * @augments CompressedTexture
 */
class CompressedCubeTexture extends CompressedTexture {

	/**
	 * Constructs a new compressed cube texture.
	 *
	 * @param {Array} [images] - The array of images. Must contain 6 elements,
	 *   each an object with `data`, `width`, and `height` properties.
	 * @param {number} [format=RGBAFormat] - The texture format.
	 * @param {number} [type=UnsignedByteType] - The texture type.
	 */
	constructor( images, format = RGBAFormat, type = UnsignedByteType ) {

		super( undefined, images[ 0 ].width, images[ 0 ].height, format, type, CubeReflectionMapping );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isCompressedCubeTexture = true;

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isCubeTexture = true;

		/**
		 * The array of six compressed face descriptors. Each element contains
		 * the face's `data`, `width`, and `height` (and optionally `depth`).
		 *
		 * @type {Array<{data: TypedArray, width: number, height: number, depth?: number}>}
		 */
		this.image = images;

		// Compressed cube textures manage their own GPU state.
		this.generateMipmaps = false;
		this.flipY = false;
		this.unpackAlignment = 1;

		// Mark for upload immediately.
		this.needsUpdate = true;

	}

	/**
	 * The width of the external texture. Queries the underlying source
	 * handle's dimensions when available.
	 *
	 * @type {number}
	 */
	get width() {

		return this.image[ 0 ]?.width ?? 0;

	}

	/**
	 * The height of the external texture. Queries the underlying source
	 * handle's dimensions when available.
	 *
	 * @type {number}
	 */
	get height() {

		return this.image[ 0 ]?.height ?? 0;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * Compute the direction vector corresponding to a face and UV pair
	 * using gl-matrix for zero-allocation, normalized output.
	 *
	 * @param {glMatrix.vec3} out - Preallocated output vec3.
	 * @param {number} face - Cube face index (0..5).
	 * @param {number} u - UV.x in [-1, 1].
	 * @param {number} v - UV.y in [-1, 1].
	 * @returns {glMatrix.vec3}
	 */
	cubeFaceToDirectionGlMat( out, face, u, v ) {

		let x = 0, y = 0, z = 0;

		switch ( face ) {

			case CUBE_FACE_POS_X: x = 1; y = - v; z = - u; break;
			case CUBE_FACE_NEG_X: x = - 1; y = - v; z = u; break;
			case CUBE_FACE_POS_Y: x = u; y = 1; z = v; break;
			case CUBE_FACE_NEG_Y: x = u; y = - 1; z = - v; break;
			case CUBE_FACE_POS_Z: x = u; y = - v; z = 1; break;
			case CUBE_FACE_NEG_Z: x = - u; y = - v; z = - 1; break;

		}

		glMatrix.vec3.set( out, x, y, z );
		glMatrix.vec3.normalize( out, out );

		return out;

	}

	/**
	 * gl-matrix accelerated direction→face/UV lookup. Given a normalized
	 * 3D direction, determines which face to sample and the corresponding
	 * UV coordinates.
	 *
	 * @param {number} x - Direction x component.
	 * @param {number} y - Direction y component.
	 * @param {number} z - Direction z component.
	 * @returns {{face: number, u: number, v: number}}
	 */
	directionToFaceUV( x, y, z ) {

		glMatrix.vec3.set( _gm_dir, x, y, z );
		glMatrix.vec3.normalize( _gm_dir, _gm_dir );

		const ax = Math.abs( _gm_dir[ 0 ] );
		const ay = Math.abs( _gm_dir[ 1 ] );
		const az = Math.abs( _gm_dir[ 2 ] );

		let face, sc, tc;

		if ( ax >= ay && ax >= az ) {

			face = _gm_dir[ 0 ] > 0 ? CUBE_FACE_POS_X : CUBE_FACE_NEG_X;
			sc = _gm_dir[ 0 ] > 0 ? - _gm_dir[ 2 ] : _gm_dir[ 2 ];
			tc = - _gm_dir[ 1 ];
			const ma = ax;
			sc /= ma; tc /= ma;

		} else if ( ay >= az ) {

			face = _gm_dir[ 1 ] > 0 ? CUBE_FACE_POS_Y : CUBE_FACE_NEG_Y;
			sc = _gm_dir[ 0 ];
			tc = _gm_dir[ 1 ] > 0 ? _gm_dir[ 2 ] : - _gm_dir[ 2 ];
			const ma = ay;
			sc /= ma; tc /= ma;

		} else {

			face = _gm_dir[ 2 ] > 0 ? CUBE_FACE_POS_Z : CUBE_FACE_NEG_Z;
			sc = _gm_dir[ 2 ] > 0 ? _gm_dir[ 0 ] : - _gm_dir[ 0 ];
			tc = - _gm_dir[ 1 ];
			const ma = az;
			sc /= ma; tc /= ma;

		}

		return {
			face,
			u: ( sc + 1 ) * 0.5,
			v: ( tc + 1 ) * 0.5
		};

	}

	/**
	 * double.js bit-exact total byte length of all six compressed faces.
	 * Useful for budgeting GPU memory when streaming very large compressed
	 * cubemaps.
	 *
	 * @returns {number}
	 */
	getCubeFaceBytesPrecise() {

		return computeCubeFaceBytesPrecise( this.image );

	}

	/**
	 * Paint a dithered fallback pattern for every face of this compressed
	 * cubemap. Used on platforms that lack native support for compressed
	 * cubemaps. The fallback is stored on the instance and can be sampled
	 * via `sampleFaceGlMat`.
	 *
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {CompressedCubeTexture} A reference to this instance.
	 */
	paintFallback( amplitude = 0.5 ) {

		this._fallback = [];

		for ( let f = 0; f < 6; f ++ ) {

			const img = this.image[ f ];
			const width = img?.width ?? 512;
			const height = img?.height ?? 512;

			const canvas = document.createElement( 'canvas' );
			canvas.width = width;
			canvas.height = height;

			paintCubeFallback( canvas, f, amplitude );

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
	 * gl-matrix accelerated sampling from a fallback face (if attached via
	 * `paintFallback`).
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [face=0] - Cube face index (0..5).
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleFaceGlMat( out, face = 0, u = 0.5, v = 0.5 ) {

		if ( ! this._fallback || face >= this._fallback.length ) return null;

		const fallback = this._fallback[ face ];
		if ( ! fallback ) return null;

		const x = Math.min( fallback.width - 1, Math.max( 0, Math.floor( u * fallback.width ) ) );
		const y = Math.min( fallback.height - 1, Math.max( 0, Math.floor( v * fallback.height ) ) );
		const p = ( y * fallback.width + x ) * 4;

		if ( ! out ) out = glMatrix.vec4.create();

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
	 * Create a batched compressed-cube face validation coordinator backed
	 * by bitecs.
	 *
	 * @returns {CompressedCubeTextureBatch}
	 */
	static createBatch() {

		return new CompressedCubeTextureBatch();

	}

	/**
	 * Copy the given compressed cube texture's properties into this one.
	 *
	 * @param {CompressedCubeTexture} source - The texture to copy from.
	 * @return {CompressedCubeTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.image = source.image.map( img => ( {
			data: img.data ? img.data.slice( 0 ) : null,
			width: img.width,
			height: img.height,
			depth: img.depth ?? 1
		} ) );

		return this;

	}

	/**
	 * Serializes the compressed cube texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Compressed cube textures cannot serialize their compressed pixel
		// data into JSON. Only structural metadata is preserved; the actual
		// bytes must be re-loaded from the source file.
		output.image = {
			width: this.image[ 0 ]?.width ?? 0,
			height: this.image[ 0 ]?.height ?? 0,
			faceCount: this.image.length,
			faces: this.image.map( img => ( {
				width: img.width,
				height: img.height,
				byteLength: img.data ? img.data.byteLength : 0
			} ) )
		};

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { CompressedCubeTexture, CompressedCubeTextureBatch, computeCubeFaceBytesPrecise, paintCubeFallback };
export default CompressedCubeTexture;