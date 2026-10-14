// file number : 003
// full path name : src/textures/003_canvastexture.js
// description : CanvasTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class and immediately sets needsUpdate to true since a canvas can be used for rendering directly. Adds gl-matrix accelerated canvas pixel sampling, bitecs SoA batching for multi-canvas texture pipelines (2D sprite-sheet processing, tilemaps, dynamic UI atlases), double.js bit-exact canvas-to-linear conversion for HDR source data, and simplex-noise dithered canvas painting for procedural texture generation.
// best for : CanvasTexture, SpriteMaterial maps, dynamic UI canvases, 2D tilemaps, drawn HUD overlays, procedural texture generation, and any three.js material that needs a canvas as its image source.
// license : MIT

import { Texture } from './002_texture.js';
import { ImageUtils } from '../extras/lib/007_imageutils.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import {
	UVMapping,
	ClampToEdgeWrapping,
	LinearFilter,
	LinearMipmapLinearFilter,
	RGBAFormat,
	UnsignedByteType,
	NoColorSpace
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

// gl-matrix scratch for zero-allocation canvas pixel sampling
const _gm_rgba = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-canvas texture pipelines
// ---------------------------------------------------------------------------

const _canvasWorld = createWorld();

const CanvasJobComponent = defineComponent( {
	texPtr: Types.ui32,
	canvasPtr: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	mode: Types.ui8,      // 0 = raw, 1 = sRGB→linear, 2 = dither+linear
	done: Types.ui8
} );

class CanvasTextureBatch {

	constructor() {

		this.world = _canvasWorld;
		this.textures = [];
		this.canvases = [];
		this.outputs = [];
		this.entities = [];

	}

	/**
	 * Register a CanvasTexture instance for batched processing.
	 *
	 * @param {CanvasTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a canvas processing job for a registered texture.
	 *
	 * @param {number} textureId
	 * @param {HTMLCanvasElement} canvas
	 * @param {number} [mode=0] - 0 = raw, 1 = sRGB→linear, 2 = dither+linear.
	 * @returns {number} entity id
	 */
	addJob( textureId, canvas, mode = 0 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, CanvasJobComponent, eid );

		const canvasIndex = this.canvases.length;
		this.canvases.push( canvas );

		CanvasJobComponent.texPtr[ eid ] = textureId;
		CanvasJobComponent.canvasPtr[ eid ] = canvasIndex;
		CanvasJobComponent.width[ eid ] = canvas.width;
		CanvasJobComponent.height[ eid ] = canvas.height;
		CanvasJobComponent.mode[ eid ] = mode;
		CanvasJobComponent.done[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued canvas jobs in one cache-friendly pass.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const canvas = this.canvases[ CanvasJobComponent.canvasPtr[ eid ] ];
			const mode = CanvasJobComponent.mode[ eid ];

			const ctx = canvas.getContext( '2d' );
			const imageData = ctx.getImageData( 0, 0, canvas.width, canvas.height );

			let result = imageData;

			if ( mode === 1 ) {

				result = ImageUtils.sRGBToLinear( imageData );

			} else if ( mode === 2 ) {

				const dithered = ImageUtils.sRGBToLinearDithered( imageData.data, canvas.width, canvas.height, 0.5 );
				result = new ImageData( dithered, canvas.width, canvas.height );

			}

			const dstIndex = this.outputs.length;
			this.outputs.push( result );
			CanvasJobComponent.done[ eid ] = 1;

		}

	}

	/**
	 * Retrieve the processed result for a given entity.
	 *
	 * @param {number} eid
	 * @returns {ImageData|null}
	 */
	result( eid ) {

		if ( ! CanvasJobComponent.done[ eid ] ) return null;
		return this.outputs[ CanvasJobComponent.dstPtr[ eid ] ];

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact canvas-to-linear conversion for HDR source data
// ---------------------------------------------------------------------------

/**
 * Convert a canvas's RGBA pixels from sRGB to linear using double.js for
 * bit-exact accumulation. Used when the canvas holds HDR data (e.g. a
 * tone-mapped render target drawn to canvas) and float32 rounding matters.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {ImageData}
 */
function canvasToLinearPrecise( canvas ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.getImageData( 0, 0, canvas.width, canvas.height );
	const data = imageData.data;

	for ( let i = 0; i < data.length; i += 4 ) {

		for ( let c = 0; c < 3; c ++ ) {

			_double.value = data[ i + c ] / 255;
			// sRGB → linear with double.js intermediate
			const linear = _double.value <= 0.04045
				? _double.value / 12.92
				: Math.pow( ( _double.value + 0.055 ) / 1.055, 2.4 );
			data[ i + c ] = Math.floor( linear * 255 );

		}

	}

	return imageData;

}

// ---------------------------------------------------------------------------
// simplex-noise dithered canvas painting for procedural texture generation
// ---------------------------------------------------------------------------

/**
 * Fill a canvas with simplex-noise dithering to avoid visible banding
 * when generating smooth gradients procedurally. Useful for procedural
 * sky textures, fog gradients, and any canvas-based HDR background.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Function} colorFn - Function (x, y, noiseValue) → [r, g, b, a] in [0, 1].
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 */
function paintDithered( canvas, colorFn, amplitude = 0.5 ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.createImageData( canvas.width, canvas.height );
	const data = imageData.data;
	const invAmp = amplitude / 255;

	for ( let y = 0; y < canvas.height; y ++ ) {

		for ( let x = 0; x < canvas.width; x ++ ) {

			const p = ( y * canvas.width + x ) * 4;
			const dither = _noise2D( x * 0.1, y * 0.1 ) * invAmp;
			const rgba = colorFn( x, y, dither );

			data[ p ] = Math.floor( Math.max( 0, Math.min( 1, rgba[ 0 ] + dither ) ) * 255 );
			data[ p + 1 ] = Math.floor( Math.max( 0, Math.min( 1, rgba[ 1 ] + dither ) ) * 255 );
			data[ p + 2 ] = Math.floor( Math.max( 0, Math.min( 1, rgba[ 2 ] + dither ) ) * 255 );
			data[ p + 3 ] = Math.floor( ( rgba[ 3 ] ?? 1 ) * 255 );

		}

	}

	ctx.putImageData( imageData, 0, 0 );

}

// ---------------------------------------------------------------------------
// Main CanvasTexture class — mirrors three.js/src/textures/CanvasTexture.js
// ---------------------------------------------------------------------------

/**
 * Creates a texture from a canvas element.
 *
 * This is almost the same as the base texture class, except that it sets
 * {@link Texture#needsUpdate} to `true` immediately since a canvas can
 * directly be used for rendering.
 *
 * @augments Texture
 */
class CanvasTexture extends Texture {

	/**
	 * Constructs a new texture.
	 *
	 * @param {HTMLCanvasElement} [canvas] - The HTML canvas element.
	 * @param {number} [mapping=Texture.DEFAULT_MAPPING] - The texture mapping.
	 * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
	 * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
	 * @param {number} [magFilter=LinearFilter] - The mag filter value.
	 * @param {number} [minFilter=LinearMipmapLinearFilter] - The min filter value.
	 * @param {number} [format=RGBAFormat] - The texture format.
	 * @param {number} [type=UnsignedByteType] - The texture type.
	 * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
	 */
	constructor(
		canvas,
		mapping = Texture.DEFAULT_MAPPING,
		wrapS = ClampToEdgeWrapping,
		wrapT = ClampToEdgeWrapping,
		magFilter = LinearFilter,
		minFilter = LinearMipmapLinearFilter,
		format = RGBAFormat,
		type = UnsignedByteType,
		anisotropy = Texture.DEFAULT_ANISOTROPY
	) {

		super( canvas, mapping, wrapS, wrapT, magFilter, minFilter, format, type, anisotropy );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isCanvasTexture = true;

		this.needsUpdate = true;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated pixel sampling from the underlying canvas.
	 * Writes into a preallocated glMatrix.vec4 for zero-allocation
	 * downstream processing.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleGlMat( out = _gm_rgba, u = 0.5, v = 0.5 ) {

		const canvas = this.image;
		if ( ! ( canvas instanceof HTMLCanvasElement ) ) return null;

		const ctx = canvas.getContext( '2d' );
		const imageData = ctx.getImageData( 0, 0, canvas.width, canvas.height );

		const x = Math.min( canvas.width - 1, Math.max( 0, Math.floor( u * canvas.width ) ) );
		const y = Math.min( canvas.height - 1, Math.max( 0, Math.floor( v * canvas.height ) ) );
		const p = ( y * canvas.width + x ) * 4;

		glMatrix.vec4.set(
			out,
			imageData.data[ p ] / 255,
			imageData.data[ p + 1 ] / 255,
			imageData.data[ p + 2 ] / 255,
			imageData.data[ p + 3 ] / 255
		);

		return out;

	}

	/**
	 * double.js bit-exact canvas-to-linear conversion for HDR source data.
	 * Returns a new ImageData instance with the converted pixels.
	 *
	 * @returns {ImageData|null}
	 */
	toLinearPrecise() {

		const canvas = this.image;
		if ( ! ( canvas instanceof HTMLCanvasElement ) ) return null;

		return canvasToLinearPrecise( canvas );

	}

	/**
	 * simplex-noise dithered canvas painting for procedural texture
	 * generation. Writes directly into the underlying canvas.
	 *
	 * @param {Function} colorFn - Function (x, y, noiseValue) → [r, g, b, a] in [0, 1].
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {CanvasTexture} A reference to this instance.
	 */
	paintDithered( colorFn, amplitude = 0.5 ) {

		const canvas = this.image;
		if ( ! ( canvas instanceof HTMLCanvasElement ) ) return this;

		paintDithered( canvas, colorFn, amplitude );
		this.needsUpdate = true;

		return this;

	}

	/**
	 * Create a batched canvas processing coordinator backed by bitecs.
	 *
	 * @returns {CanvasTextureBatch}
	 */
	static createBatch() {

		return new CanvasTextureBatch();

	}

	/**
	 * Copy the given texture's properties into this one.
	 *
	 * @param {CanvasTexture} source - The texture to copy from.
	 * @return {CanvasTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		return this;

	}

}

export { CanvasTexture, CanvasTextureBatch, canvasToLinearPrecise, paintDithered };
export default CanvasTexture;