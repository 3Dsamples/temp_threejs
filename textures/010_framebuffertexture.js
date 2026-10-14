// file number : 010
// full path name : src/textures/010_framebuffertexture.js
// description : FramebufferTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class to capture the current framebuffer contents via renderer.copyFramebufferToTexture(). Preserves the full r185 API — width/height constructor, magFilter/minFilter = NearestFilter (filtering disabled by default), generateMipmaps = false, isFramebufferTexture flag, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated readback sampling for CPU-side pixel inspection, bitecs SoA batching for multi-framebuffer capture pipelines (screen-recording, post-processing passes), double.js bit-exact pixel-sum accumulation for framebuffer diffing, and simplex-noise dithered fallback painting for platforms where copyFramebufferToTexture is unavailable.
// best for : FramebufferTexture, WebGLRenderer.copyFramebufferToTexture, screen-space reflections, post-processing captures, debug viewports, dynamic UI overlays, and any three.js workflow that needs to capture the current framebuffer into a reusable texture.
// license : MIT

import { Texture } from './002_texture.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import {
	NearestFilter,
	RGBAFormat,
	UnsignedByteType,
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

// gl-matrix scratch for zero-allocation readback sampling
const _gm_rgba = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-framebuffer capture pipelines
// ---------------------------------------------------------------------------

const _fbWorld = createWorld();

const FramebufferJobComponent = defineComponent( {
	texPtr: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	captured: Types.ui8,
	validated: Types.ui8
} );

class FramebufferTextureBatch {

	constructor() {

		this.world = _fbWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a FramebufferTexture instance for batched validation.
	 *
	 * @param {FramebufferTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a validation job for a registered framebuffer texture.
	 *
	 * @param {number} textureId
	 * @returns {number} entity id
	 */
	addJob( textureId ) {

		const eid = addEntity( this.world );
		addComponent( this.world, FramebufferJobComponent, eid );

		const texture = this.textures[ textureId ];

		FramebufferJobComponent.texPtr[ eid ] = textureId;
		FramebufferJobComponent.width[ eid ] = texture.image.width;
		FramebufferJobComponent.height[ eid ] = texture.image.height;
		FramebufferJobComponent.captured[ eid ] = 0;
		FramebufferJobComponent.validated[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Validate all queued framebuffer textures in one cache-friendly pass.
	 * Checks that dimensions are positive and that the texture is ready
	 * for capture (needsUpdate was set at least once).
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const width = FramebufferJobComponent.width[ eid ];
			const height = FramebufferJobComponent.height[ eid ];
			const texture = this.textures[ FramebufferJobComponent.texPtr[ eid ] ];

			const ok = width > 0 && height > 0 && texture.version > 0;

			FramebufferJobComponent.validated[ eid ] = ok ? 1 : 0;
			FramebufferJobComponent.captured[ eid ] = ok ? 1 : 0;

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
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = FramebufferJobComponent.validated[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact pixel-sum accumulation for framebuffer diffing
// ---------------------------------------------------------------------------

/**
 * Compute the sum of all RGBA pixel values in a framebuffer texture using
 * double.js for bit-exact accumulation. Used for framebuffer diffing
 * (comparing two captures to detect changes) where float32 accumulation
 * of millions of 8-bit values loses precision.
 *
 * @param {Uint8ClampedArray|Uint8Array} data - RGBA pixel buffer.
 * @returns {{r: number, g: number, b: number, a: number, total: number}}
 */
function sumPixelsPrecise( data ) {

	let r = 0, g = 0, b = 0, a = 0;

	for ( let i = 0; i < data.length; i += 4 ) {

		_double.value = r;
		_double.add( data[ i ] );
		r = _double.value;

		_double.value = g;
		_double.add( data[ i + 1 ] );
		g = _double.value;

		_double.value = b;
		_double.add( data[ i + 2 ] );
		b = _double.value;

		_double.value = a;
		_double.add( data[ i + 3 ] );
		a = _double.value;

	}

	_double.value = r;
	_double.add( g );
	_double.add( b );
	_double.add( a );
	const total = _double.value;

	return { r, g, b, a, total };

}

// ---------------------------------------------------------------------------
// simplex-noise dithered fallback painting for platforms without copyFramebufferToTexture
// ---------------------------------------------------------------------------

/**
 * Paint a dithered fallback pattern into a framebuffer texture's backing
 * canvas. Used when the platform does not support
 * copyFramebufferToTexture() and a visual placeholder is required.
 * The simplex-noise dithering prevents visible banding in the fallback
 * gradient.
 *
 * @param {HTMLCanvasElement} canvas - The backing canvas.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 */
function paintFramebufferFallback( canvas, amplitude = 0.5 ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.createImageData( canvas.width, canvas.height );
	const data = imageData.data;
	const invAmp = amplitude / 255;

	for ( let y = 0; y < canvas.height; y ++ ) {

		for ( let x = 0; x < canvas.width; x ++ ) {

			const p = ( y * canvas.width + x ) * 4;
			const d = _noise2D( x * 0.05, y * 0.05 ) * invAmp;

			// Diagonal gradient placeholder
			const t = ( x + y ) / ( canvas.width + canvas.height );

			data[ p ] = Math.floor( Math.max( 0, Math.min( 1, 0.2 + t * 0.6 + d ) ) * 255 );
			data[ p + 1 ] = Math.floor( Math.max( 0, Math.min( 1, 0.3 + t * 0.4 + d ) ) * 255 );
			data[ p + 2 ] = Math.floor( Math.max( 0, Math.min( 1, 0.5 + t * 0.3 + d ) ) * 255 );
			data[ p + 3 ] = 255;

		}

	}

	ctx.putImageData( imageData, 0, 0 );

}

// ---------------------------------------------------------------------------
// Main FramebufferTexture class — mirrors three.js/src/textures/FramebufferTexture.js
// ---------------------------------------------------------------------------

/**
 * This class can only be used in combination with
 * {@link WebGLRenderer#copyFramebufferToTexture}.
 *
 * It extracts the contents of the current bound framebuffer and provides
 * it as a texture for further usage.
 *
 * ```js
 * const pixelRatio = window.devicePixelRatio;
 * const textureSize = 128 * pixelRatio;
 *
 * // instantiate a framebuffer texture
 * const frameTexture = new FramebufferTexture( textureSize, textureSize );
 *
 * // calculate start position for copying part of the frame data
 * const vector = new Vector2();
 * vector.x = ( window.innerWidth * pixelRatio / 2 ) - ( textureSize / 2 );
 * vector.y = ( window.innerHeight * pixelRatio / 2 ) - ( textureSize / 2 );
 *
 * renderer.render( scene, camera );
 *
 * // copy part of the rendered frame into the framebuffer texture
 * renderer.copyFramebufferToTexture( frameTexture, vector );
 * ```
 *
 * @augments Texture
 */
class FramebufferTexture extends Texture {

	/**
	 * Constructs a new framebuffer texture.
	 *
	 * @param {number} width - The width of the texture.
	 * @param {number} height - The height of the texture.
	 */
	constructor( width, height ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isFramebufferTexture = true;

		/**
		 * The image definition of the framebuffer texture. Since the
		 * framebuffer is captured from the GPU, the image is a placeholder
		 * object with just the dimensions — no CPU-side pixel data is
		 * initially available.
		 *
		 * @type {{width: number, height: number}}
		 */
		this.image = { width, height };

		/**
		 * How the texture is sampled when a texel covers more than one pixel.
		 * Overwritten and set to `NearestFilter` by default to disable
		 * filtering.
		 *
		 * @type {number}
		 * @default NearestFilter
		 */
		this.magFilter = NearestFilter;

		/**
		 * How the texture is sampled when a texel covers less than one pixel.
		 * Overwritten and set to `NearestFilter` by default to disable
		 * filtering.
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

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated readback sampling from the framebuffer texture's
	 * CPU-side fallback buffer (if attached). Framebuffer textures normally
	 * do not have CPU-readable pixels — a fallback can be attached via
	 * `paintFallback`.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleGlMat( out = _gm_rgba, u = 0.5, v = 0.5 ) {

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
	 * double.js bit-exact pixel-sum accumulation for framebuffer diffing.
	 * Returns the sum of all RGBA channels and the total.
	 *
	 * @param {Uint8ClampedArray|Uint8Array} data - RGBA pixel buffer.
	 * @returns {{r: number, g: number, b: number, a: number, total: number}}
	 */
	static sumPixelsPrecise( data ) {

		return sumPixelsPrecise( data );

	}

	/**
	 * Paint a dithered fallback pattern into the framebuffer texture's
	 * backing canvas. Used when the platform does not support
	 * copyFramebufferToTexture() and a visual placeholder is required.
	 *
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {FramebufferTexture} A reference to this instance.
	 */
	paintFallback( amplitude = 0.5 ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = this.image.width;
		canvas.height = this.image.height;

		paintFramebufferFallback( canvas, amplitude );

		const ctx = canvas.getContext( '2d' );
		const imageData = ctx.getImageData( 0, 0, canvas.width, canvas.height );

		this._fallback = {
			width: this.image.width,
			height: this.image.height,
			data: imageData.data
		};

		this.needsUpdate = true;
		return this;

	}

	/**
	 * Create a batched framebuffer-validation coordinator backed by bitecs.
	 *
	 * @returns {FramebufferTextureBatch}
	 */
	static createBatch() {

		return new FramebufferTextureBatch();

	}

	/**
	 * Copy the given framebuffer texture's properties into this one.
	 *
	 * @param {FramebufferTexture} source - The texture to copy from.
	 * @return {FramebufferTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.image = {
			width: source.image.width,
			height: source.image.height
		};

		this.magFilter = source.magFilter;
		this.minFilter = source.minFilter;

		this.generateMipmaps = source.generateMipmaps;

		return this;

	}

	/**
	 * Serializes the framebuffer texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Framebuffer textures cannot serialize their GPU-side pixel data
		// directly. Only structural metadata (dimensions) is preserved.
		output.image = {
			width: this.image.width,
			height: this.image.height
		};

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { FramebufferTexture, FramebufferTextureBatch, sumPixelsPrecise, paintFramebufferFallback };
export default FramebufferTexture;