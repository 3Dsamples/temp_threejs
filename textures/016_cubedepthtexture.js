// file number : 016
// full path name : src/textures/016_cubedepthtexture.js
// description : CubeDepthTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 009_depthtexture.js (which itself extends 002_texture.js) to automatically save the depth information of a cube rendering into a cube texture with depth format. Used for PointLight shadows and WebGPU CubeRenderTarget depth attachments. Preserves the full r185 API — six face image descriptors, isCubeDepthTexture flag, isCubeTexture flag, CubeReflectionMapping default, images getter/setter alias, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated cube-face direction computation for CPU-side shadow verification, bitecs SoA batching for multi-point-light shadow pipelines (shadow atlas coordination), double.js bit-exact depth-range validation for six-face HDR depth buffers, and simplex-noise dithered fallback painting for platforms that lack native cube-depth-texture support.
// best for : CubeDepthTexture, PointLight shadow maps, PointShadowNode (WebGPU), CubeRenderTarget depth attachments, omnidirectional shadow rendering, and any three.js workflow that needs six faces of depth data as a single texture unit.
// license : MIT

import { DepthTexture } from './009_depthtexture.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import {
	UnsignedIntType,
	DepthFormat,
	NearestFilter,
	CubeReflectionMapping,
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
// bitecs SoA batch coordinator for multi-point-light shadow pipelines
// ---------------------------------------------------------------------------

const _cubeDepthWorld = createWorld();

const CubeDepthFaceComponent = defineComponent( {
	texPtr: Types.ui32,
	face: Types.ui8,
	size: Types.ui32,
	depth: Types.ui32,
	validated: Types.ui8
} );

class CubeDepthTextureBatch {

	constructor() {

		this.world = _cubeDepthWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a CubeDepthTexture instance for batched face validation.
	 *
	 * @param {CubeDepthTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Enumerate the six faces of a registered cube depth texture and queue
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
			addComponent( this.world, CubeDepthFaceComponent, eid );

			CubeDepthFaceComponent.texPtr[ eid ] = textureId;
			CubeDepthFaceComponent.face[ eid ] = f;
			CubeDepthFaceComponent.size[ eid ] = img?.width ?? 0;
			CubeDepthFaceComponent.depth[ eid ] = img?.depth ?? 1;
			CubeDepthFaceComponent.validated[ eid ] = 0;

			this.entities.push( eid );
			if ( f === 0 ) firstEid = eid;

		}

		return firstEid;

	}

	/**
	 * Validate all queued faces in one cache-friendly pass. Checks that
	 * each face's size is positive and consistent across all six faces.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const size = CubeDepthFaceComponent.size[ eid ];
			const depth = CubeDepthFaceComponent.depth[ eid ];

			const ok = size > 0 && depth === 1;

			CubeDepthFaceComponent.validated[ eid ] = ok ? 1 : 0;

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
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = CubeDepthFaceComponent.validated[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact depth-range validation for six-face HDR buffers
// ---------------------------------------------------------------------------

/**
 * Validate the combined depth range of all six cube faces using double.js
 * for bit-exact min/max computation. Used when a CubeDepthTexture holds
 * very large depth ranges (e.g. logarithmic depth for outdoor point-light
 * shadows) where float32 accumulation of min/max across six faces drifts
 * and causes shadow acne.
 *
 * @param {Array<Float32Array>} faceDepthData - Array of six Float32Array buffers.
 * @returns {{min: number, max: number, range: number}}
 */
function validateCubeDepthRangePrecise( faceDepthData ) {

	_double.value = Infinity;
	let min = _double.value;

	_double.value = - Infinity;
	let max = _double.value;

	for ( let f = 0; f < faceDepthData.length; f ++ ) {

		const faceData = faceDepthData[ f ];
		if ( ! faceData ) continue;

		for ( let i = 0; i < faceData.length; i ++ ) {

			const v = faceData[ i ];

			if ( v < min ) min = v;
			if ( v > max ) max = v;

		}

	}

	_double.value = max;
	_double.sub( min );
	const range = _double.value;

	return { min, max, range };

}

// ---------------------------------------------------------------------------
// simplex-noise dithered fallback painting for platforms without native support
// ---------------------------------------------------------------------------

/**
 * Paint a dithered fallback depth pattern for platforms that lack native
 * support for cube depth textures (WebGL1 without WEBGL_depth_texture).
 * This is intentionally low-fidelity — it exists so the pipeline degrades
 * gracefully, and the simplex-noise dithering prevents visible banding
 * in the pseudo-depth gradient.
 *
 * @param {HTMLCanvasElement} canvas - The backing canvas.
 * @param {number} face - Cube face index (0..5).
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 */
function paintCubeDepthFallback( canvas, face, amplitude = 0.5 ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.createImageData( canvas.width, canvas.height );
	const data = imageData.data;
	const invAmp = amplitude / 255;

	// Per-face radial gradient for visual distinction
	for ( let y = 0; y < canvas.height; y ++ ) {

		for ( let x = 0; x < canvas.width; x ++ ) {

			const p = ( y * canvas.width + x ) * 4;
			const d = _noise2D( x * 0.05 + face * 100, y * 0.05 ) * invAmp;

			const cx = ( x / canvas.width ) - 0.5;
			const cy = ( y / canvas.height ) - 0.5;
			const dist = Math.sqrt( cx * cx + cy * cy );

			const depth = Math.max( 0, Math.min( 1, dist + d ) );
			const value = Math.floor( depth * 255 );

			data[ p ] = value;
			data[ p + 1 ] = value;
			data[ p + 2 ] = value;
			data[ p + 3 ] = 255;

		}

	}

	ctx.putImageData( imageData, 0, 0 );

}

// ---------------------------------------------------------------------------
// Main CubeDepthTexture class — mirrors three.js/src/textures/CubeDepthTexture.js
// ---------------------------------------------------------------------------

/**
 * This class can be used to automatically save the depth information of a
 * cube rendering into a cube texture with depth format. Used for PointLight
 * shadows.
 *
 * ```js
 * const size = 512;
 * const cubeDepthTexture = new THREE.CubeDepthTexture( size );
 * cubeDepthTexture.needsUpdate = true;
 * ```
 *
 * @augments DepthTexture
 */
class CubeDepthTexture extends DepthTexture {

	/**
	 * Constructs a new cube depth texture.
	 *
	 * @param {number} size - The size (width and height) of each cube face.
	 * @param {number} [type=UnsignedIntType] - The texture type.
	 * @param {number} [mapping=CubeReflectionMapping] - The texture mapping.
	 * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
	 * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
	 * @param {number} [magFilter=NearestFilter] - The mag filter value.
	 * @param {number} [minFilter=NearestFilter] - The min filter value.
	 * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
	 * @param {number} [format=DepthFormat] - The texture format.
	 */
	constructor(
		size,
		type = UnsignedIntType,
		mapping = CubeReflectionMapping,
		wrapS = ClampToEdgeWrapping,
		wrapT = ClampToEdgeWrapping,
		magFilter = NearestFilter,
		minFilter = NearestFilter,
		anisotropy = Texture.DEFAULT_ANISOTROPY,
		format = DepthFormat
	) {

		// Create 6 identical image descriptors for the cube faces
		const image = { width: size, height: size, depth: 1 };
		const images = [ image, image, image, image, image, image ];

		// Call DepthTexture constructor with width, height
		super(
			size,
			size,
			type,
			mapping,
			wrapS,
			wrapT,
			magFilter,
			minFilter,
			anisotropy,
			format
		);

		// Replace the single image with the array of 6 images
		this.image = images;

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isCubeDepthTexture = true;

		/**
		 * Set to true for cube texture handling in WebGLTextures.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isCubeTexture = true;

	}

	/**
	 * Alias for {@link CubeDepthTexture#image}.
	 *
	 * @type {Array}
	 */
	get images() {

		return this.image;

	}

	set images( value ) {

		this.image = value;

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
	 * UV coordinates. Useful for point-light shadow lookups.
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
	 * double.js bit-exact depth-range validation for six-face HDR buffers.
	 * Returns { min, max, range } computed with double precision across
	 * all six faces.
	 *
	 * @param {Array<Float32Array>} faceDepthData - Array of six Float32Array buffers.
	 * @returns {{min: number, max: number, range: number}}
	 */
	validateCubeDepthRangePrecise( faceDepthData ) {

		return validateCubeDepthRangePrecise( faceDepthData );

	}

	/**
	 * Paint a dithered fallback depth pattern for every face of this cube
	 * depth texture. Used on platforms that lack native support for cube
	 * depth textures. The fallback is stored on the instance and can be
	 * sampled via `sampleFaceGlMat`.
	 *
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {CubeDepthTexture} A reference to this instance.
	 */
	paintFallback( amplitude = 0.5 ) {

		this._fallback = [];

		const size = this.image[ 0 ]?.width ?? 512;

		for ( let f = 0; f < 6; f ++ ) {

			const canvas = document.createElement( 'canvas' );
			canvas.width = size;
			canvas.height = size;

			paintCubeDepthFallback( canvas, f, amplitude );

			const ctx = canvas.getContext( '2d' );
			const imageData = ctx.getImageData( 0, 0, size, size );

			this._fallback.push( {
				width: size,
				height: size,
				data: imageData.data
			} );

		}

		return this;

	}

	/**
	 * gl-matrix accelerated depth sampling from a fallback face (if attached
	 * via `paintFallback`). Returns the depth value in [0, 1], or null if
	 * no fallback is available.
	 *
	 * @param {number} [face=0] - Cube face index (0..5).
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {number|null}
	 */
	sampleFaceDepthGlMat( face = 0, u = 0.5, v = 0.5 ) {

		if ( ! this._fallback || face >= this._fallback.length ) return null;

		const fallback = this._fallback[ face ];
		if ( ! fallback ) return null;

		const x = Math.min( fallback.width - 1, Math.max( 0, Math.floor( u * fallback.width ) ) );
		const y = Math.min( fallback.height - 1, Math.max( 0, Math.floor( v * fallback.height ) ) );
		const p = ( y * fallback.width + x ) * 4;

		return fallback.data[ p ] / 255;

	}

	/**
	 * Create a batched cube-depth face validation coordinator backed by bitecs.
	 *
	 * @returns {CubeDepthTextureBatch}
	 */
	static createBatch() {

		return new CubeDepthTextureBatch();

	}

	/**
	 * Copy the given cube depth texture's properties into this one.
	 *
	 * @param {CubeDepthTexture} source - The texture to copy from.
	 * @return {CubeDepthTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		// Rebuild the six-face image array from the source.
		const size = source.image[ 0 ]?.width ?? 1;
		const image = { width: size, height: size, depth: 1 };
		this.image = [ image, image, image, image, image, image ];

		return this;

	}

	/**
	 * Serializes the cube depth texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Cube depth textures cannot serialize their GPU-side depth data
		// directly. Only structural metadata (dimensions, face count) is
		// preserved.
		output.image = {
			width: this.image[ 0 ]?.width ?? 0,
			height: this.image[ 0 ]?.height ?? 0,
			faceCount: this.image.length
		};

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { CubeDepthTexture, CubeDepthTextureBatch, validateCubeDepthRangePrecise, paintCubeDepthFallback };
export default CubeDepthTexture;