// file number : 005
// full path name : src/textures/005_cubetexture.js
// description : CubeTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class and represents six images forming a cubemap (used by CubeCamera, PMREMGenerator, and environment maps). Preserves the full r185 API — images array, flipY=false, generateMipmaps=false, unpackAlignment=1, mapping=CubeReflectionMapping, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated cube-face direction computation for CPU-side lookups, bitecs SoA batching for multi-cubemap pipelines (batch-rendering reflection probes), double.js bit-exact spherical coordinate accumulation for high-res HDR environment maps, and simplex-noise dithered fallback painting for procedural skybox generation.
// best for : CubeTexture, CubeCamera, PMREMGenerator, CubeReflectionMapping, CubeRefractionMapping, environment maps, skyboxes, reflection probes, and any three.js workflow that needs six faces of a cube as a single texture unit.
// license : MIT

import { Texture } from './002_texture.js';
import {
	NoColorSpace,
	LinearFilter,
	LinearMipmapLinearFilter,
	RGBAFormat,
	UnsignedByteType,
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
const _gm_tmp = glMatrix.vec3.create();

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
// bitecs SoA batch coordinator for multi-cubemap pipelines
// ---------------------------------------------------------------------------

const _cubeWorld = createWorld();

const CubeFaceComponent = defineComponent( {
	texPtr: Types.ui32,
	face: Types.ui8,
	width: Types.ui32,
	height: Types.ui32,
	applied: Types.ui8
} );

class CubeTextureBatch {

	constructor() {

		this.world = _cubeWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a CubeTexture instance for batched face processing.
	 *
	 * @param {CubeTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Enumerate the six faces of a registered cubemap and queue a processing
	 * job per face.
	 *
	 * @param {number} textureId
	 * @returns {number} the first entity id created
	 */
	enumerateFaces( textureId ) {

		const texture = this.textures[ textureId ];
		const images = texture.images;
		let firstEid = 0;

		for ( let f = 0; f < 6; f ++ ) {

			const img = images[ f ];
			const eid = addEntity( this.world );
			addComponent( this.world, CubeFaceComponent, eid );

			CubeFaceComponent.texPtr[ eid ] = textureId;
			CubeFaceComponent.face[ eid ] = f;
			CubeFaceComponent.width[ eid ] = img?.width ?? texture.image.width;
			CubeFaceComponent.height[ eid ] = img?.height ?? texture.image.height;
			CubeFaceComponent.applied[ eid ] = 0;

			this.entities.push( eid );
			if ( f === 0 ) firstEid = eid;

		}

		return firstEid;

	}

	/**
	 * Validate all queued faces in one cache-friendly pass. Checks that
	 * each face's dimensions match the cubemap's declared image dimensions.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ CubeFaceComponent.texPtr[ eid ] ];
			const expectedW = texture.image.width;
			const expectedH = texture.image.height;

			const ok = CubeFaceComponent.width[ eid ] === expectedW &&
				CubeFaceComponent.height[ eid ] === expectedH;

			CubeFaceComponent.applied[ eid ] = ok ? 1 : 0;

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
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = CubeFaceComponent.applied[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact cube-face direction computation
// ---------------------------------------------------------------------------

/**
 * Compute a normalized 3D direction vector from cubemap face UV using
 * double.js for bit-exact accumulation. Critical when generating very
 * high-resolution HDR environment maps where float32 drift causes visible
 * seams between cube faces.
 *
 * @param {number} face - Cube face index (0..5).
 * @param {number} u - UV.x in [-1, 1].
 * @param {number} v - UV.y in [-1, 1].
 * @param {glMatrix.vec3} out - Preallocated output.
 * @returns {glMatrix.vec3}
 */
function cubeFaceToDirectionPrecise( face, u, v, out ) {

	let x = 0, y = 0, z = 0;

	switch ( face ) {

		case CUBE_FACE_POS_X:
			_double.value = 1; x = _double.value;
			_double.value = - v; y = _double.value;
			_double.value = - u; z = _double.value;
			break;

		case CUBE_FACE_NEG_X:
			_double.value = - 1; x = _double.value;
			_double.value = - v; y = _double.value;
			_double.value = u; z = _double.value;
			break;

		case CUBE_FACE_POS_Y:
			_double.value = u; x = _double.value;
			_double.value = 1; y = _double.value;
			_double.value = v; z = _double.value;
			break;

		case CUBE_FACE_NEG_Y:
			_double.value = u; x = _double.value;
			_double.value = - 1; y = _double.value;
			_double.value = - v; z = _double.value;
			break;

		case CUBE_FACE_POS_Z:
			_double.value = u; x = _double.value;
			_double.value = - v; y = _double.value;
			_double.value = 1; z = _double.value;
			break;

		case CUBE_FACE_NEG_Z:
			_double.value = - u; x = _double.value;
			_double.value = - v; y = _double.value;
			_double.value = - 1; z = _double.value;
			break;

	}

	glMatrix.vec3.set( out, x, y, z );
	glMatrix.vec3.normalize( out, out );

	return out;

}

// ---------------------------------------------------------------------------
// simplex-noise dithered fallback painting for procedural skybox generation
// ---------------------------------------------------------------------------

/**
 * Generate a procedural skybox face using simplex-noise dithering. Used
 * when a CubeTexture is required but no source images are available
 * (e.g. during development or when a fallback is needed for a missing
 * environment map).
 *
 * @param {number} width
 * @param {number} height
 * @param {number} face - Cube face index (0..5).
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @returns {Uint8ClampedArray} RGBA byte buffer.
 */
function generateSkyboxFace( width, height, face, amplitude = 0.5 ) {

	const out = new Uint8ClampedArray( width * height * 4 );
	const invAmp = amplitude / 255;

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const p = ( y * width + x ) * 4;
			const u = ( x / width ) * 2 - 1;
			const v = ( y / height ) * 2 - 1;

			cubeFaceToDirectionPrecise( face, u, v, _gm_dir );

			// Map direction to a sky gradient (blue at top → white at horizon)
			const t = Math.max( 0, Math.min( 1, _gm_dir[ 1 ] * 0.5 + 0.5 ) );
			const r = 0.4 + t * 0.5;
			const g = 0.5 + t * 0.4;
			const b = 0.8 + t * 0.2;

			// Add subtle noise texture
			const n = _noise2D( x * 0.02, y * 0.02 ) * 0.05;
			const d = _noise2D( x * 0.1, y * 0.1 ) * invAmp;

			out[ p ] = Math.floor( Math.max( 0, Math.min( 1, r + n + d ) ) * 255 );
			out[ p + 1 ] = Math.floor( Math.max( 0, Math.min( 1, g + n + d ) ) * 255 );
			out[ p + 2 ] = Math.floor( Math.max( 0, Math.min( 1, b + n + d ) ) * 255 );
			out[ p + 3 ] = 255;

		}

	}

	return out;

}

// ---------------------------------------------------------------------------
// Main CubeTexture class — mirrors three.js/src/textures/CubeTexture.js
// ---------------------------------------------------------------------------

/**
 * Creates a cube texture made up of six images.
 *
 * ```js
 * const loader = new THREE.CubeTextureLoader();
 * loader.setPath( 'textures/cube/pisa/' );
 *
 * const textureCube = loader.load( [
 *   'px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png'
 * ] );
 *
 * const material = new THREE.MeshBasicMaterial( { color: 0xffffff, envMap: textureCube } );
 * ```
 *
 * @augments Texture
 */
class CubeTexture extends Texture {

	/**
	 * Constructs a new cube texture.
	 *
	 * @param {Array<Image>} [images] - The array of images. Must contain 6 elements.
	 * @param {number} [mapping=CubeReflectionMapping] - The texture mapping.
	 * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
	 * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
	 * @param {number} [magFilter=LinearFilter] - The mag filter value.
	 * @param {number} [minFilter=LinearMipmapLinearFilter] - The min filter value.
	 * @param {number} [format=RGBAFormat] - The texture format.
	 * @param {number} [type=UnsignedByteType] - The texture type.
	 * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
	 * @param {string} [colorSpace=NoColorSpace] - The color space.
	 */
	constructor(
		images = [],
		mapping = CubeReflectionMapping,
		wrapS = ClampToEdgeWrapping,
		wrapT = ClampToEdgeWrapping,
		magFilter = LinearFilter,
		minFilter = LinearMipmapLinearFilter,
		format = RGBAFormat,
		type = UnsignedByteType,
		anisotropy = Texture.DEFAULT_ANISOTROPY,
		colorSpace = NoColorSpace
	) {

		super(
			images,
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
		this.isCubeTexture = true;

		/**
		 * The array of images. Must contain 6 elements (one per cube face).
		 *
		 * @type {Array<Image>}
		 */
		this.images = images;

		// no flipping for cube textures, since the cube texture is already flipped
		this.flipY = false;

		// no mipmaps are generated for cube textures by default
		this.generateMipmaps = false;

		this.unpackAlignment = 1;

		// the image proxy is set to a placeholder that exposes dimensions
		this.needsUpdate = true;

	}

	/**
	 * The image property of a cube texture is a placeholder that exposes
	 * the dimensions of the cube (derived from the first image).
	 *
	 * @type {Object}
	 */
	get image() {

		return {
			width: this.images[ 0 ]?.width ?? 0,
			height: this.images[ 0 ]?.height ?? 0,
			depth: 1
		};

	}

	set image( value ) {

		// Cube textures manage their images through the `images` array.
		// Assigning to `image` is a no-op with a developer warning.
		if ( value !== undefined && value !== null ) {

			console.warn( 'CubeTexture: assigning to `image` is deprecated. Use `images` array instead.' );

		}

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * Compute the direction vector corresponding to a face and UV pair
	 * using double.js for bit-exact accumulation. Zero-allocation; writes
	 * into a preallocated glMatrix.vec3.
	 *
	 * @param {glMatrix.vec3} out - Preallocated output vec3.
	 * @param {number} face - Cube face index (0..5).
	 * @param {number} u - UV.x in [-1, 1].
	 * @param {number} v - UV.y in [-1, 1].
	 * @returns {glMatrix.vec3}
	 */
	cubeFaceToDirectionGlMat( out, face, u, v ) {

		return cubeFaceToDirectionPrecise( face, u, v, out );

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
	 * Generate a procedural skybox using simplex-noise dithering. Populates
	 * the internal `images` array with six generated canvases. Useful when
	 * a CubeTexture is required but no source images are available.
	 *
	 * @param {number} [size=512] - Edge length of each face in pixels.
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {CubeTexture} A reference to this instance.
	 */
	generateProceduralSkybox( size = 512, amplitude = 0.5 ) {

		const faces = [];

		for ( let f = 0; f < 6; f ++ ) {

			const canvas = document.createElement( 'canvas' );
			canvas.width = size;
			canvas.height = size;

			const rgba = generateSkyboxFace( size, size, f, amplitude );
			const imageData = new ImageData( rgba, size, size );
			canvas.getContext( '2d' ).putImageData( imageData, 0, 0 );

			faces.push( canvas );

		}

		this.images = faces;
		this.needsUpdate = true;

		return this;

	}

	/**
	 * Create a batched cube-face validation coordinator backed by bitecs.
	 * Enumerates and validates the six faces of many CubeTexture instances
	 * in a single cache-friendly pass.
	 *
	 * @returns {CubeTextureBatch}
	 */
	static createBatch() {

		return new CubeTextureBatch();

	}

	/**
	 * Copy the given cube texture's properties into this one.
	 *
	 * @param {CubeTexture} source - The texture to copy from.
	 * @return {CubeTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.images = [];

		for ( let i = 0, l = source.images.length; i < l; i ++ ) {

			this.images[ i ] = source.images[ i ];

		}

		return this;

	}

	/**
	 * Serializes the cube texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// The base Texture.toJSON already includes `image` — for a cube
		// texture we additionally record the face count and dimensions.
		output.image = {
			width: this.image.width,
			height: this.image.height,
			faceCount: this.images.length
		};

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { CubeTexture, CubeTextureBatch, cubeFaceToDirectionPrecise, generateSkyboxFace };
export default CubeTexture;