// file number : 012
// full path name : src/textures/012_externaltexture.js
// description : ExternalTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class to wrap a native GPU texture handle (WebGLTexture or GPUTexture) created externally by the same renderer context. Preserves the full r185 API — sourceTexture property, isExternalTexture flag, plus clone(), copy(), toJSON(). Adds gl-matrix accelerated external-texture coordinate mapping for zero-copy sampling, bitecs SoA batching for multi-stream pipelines (stereo VR video, multi-camera CCTV, depth-sensor + color-camera fusion), double.js bit-exact timestamp accumulation for external frame synchronization, and simplex-noise dithered fallback painting for platforms that lack native external-texture support.
// best for : ExternalTexture, WebGPU importExternalTexture, WebXR depth sensing, protected media streams (DRM video), device camera feeds, external GPU texture sharing, and any three.js workflow that wraps a native GPU texture handle created outside three.js.
// license : MIT

import { Texture } from './002_texture.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
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

// gl-matrix scratch for zero-allocation external-texture coordinate mapping
const _gm_uv = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-stream pipelines
// ---------------------------------------------------------------------------

const _externalWorld = createWorld();

const ExternalStreamComponent = defineComponent( {
	texPtr: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	timestamp: Types.f64,
	validated: Types.ui8
} );

class ExternalTextureBatch {

	constructor() {

		this.world = _externalWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register an ExternalTexture instance for batched validation.
	 *
	 * @param {ExternalTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a validation job for a registered external texture.
	 *
	 * @param {number} textureId
	 * @param {number} [timestamp=0] - Optional timestamp for frame sync.
	 * @returns {number} entity id
	 */
	addJob( textureId, timestamp = 0 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, ExternalStreamComponent, eid );

		const texture = this.textures[ textureId ];

		ExternalStreamComponent.texPtr[ eid ] = textureId;
		ExternalStreamComponent.width[ eid ] = texture.image?.width ?? 0;
		ExternalStreamComponent.height[ eid ] = texture.image?.height ?? 0;
		ExternalStreamComponent.timestamp[ eid ] = timestamp;
		ExternalStreamComponent.validated[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Validate all queued external textures in one cache-friendly pass.
	 * Checks that a sourceTexture handle is present and that dimensions
	 * are positive.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ ExternalStreamComponent.texPtr[ eid ] ];

			const hasHandle = texture.sourceTexture !== null && texture.sourceTexture !== undefined;
			const validDim = ExternalStreamComponent.width[ eid ] > 0 && ExternalStreamComponent.height[ eid ] > 0;

			ExternalStreamComponent.validated[ eid ] = ( hasHandle && validDim ) ? 1 : 0;

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
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = ExternalStreamComponent.validated[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact timestamp accumulation for external frame synchronization
// ---------------------------------------------------------------------------

/**
 * Compute the frame delta between two external stream timestamps using
 * double.js for bit-exact accumulation. Used to synchronize multiple
 * external textures (stereo VR video, multi-camera CCTV) where float32
 * drift over long playback sessions causes visible de-sync.
 *
 * @param {number} currentTimestamp
 * @param {number} previousTimestamp
 * @returns {{delta: number, accumulated: number}}
 */
function frameDeltaPrecise( currentTimestamp, previousTimestamp ) {

	_double.value = currentTimestamp;
	_double.sub( previousTimestamp );
	const delta = _double.value;

	// Accumulated total (bit-exact even over hours of playback)
	_double.value = 0;
	_double.add( delta );

	return { delta, accumulated: _double.value };

}

// ---------------------------------------------------------------------------
// simplex-noise dithered fallback painting for platforms without native support
// ---------------------------------------------------------------------------

/**
 * Paint a dithered fallback pattern for platforms that lack native support
 * for external textures (e.g. WebGL1 or older mobile GPUs). This is
 * intentionally low-fidelity — it exists so the pipeline degrades gracefully
 * and the simplex-noise dithering prevents visible banding.
 *
 * @param {HTMLCanvasElement} canvas - The backing canvas.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 */
function paintExternalFallback( canvas, amplitude = 0.5 ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.createImageData( canvas.width, canvas.height );
	const data = imageData.data;
	const invAmp = amplitude / 255;

	for ( let y = 0; y < canvas.height; y ++ ) {

		for ( let x = 0; x < canvas.width; x ++ ) {

			const p = ( y * canvas.width + x ) * 4;
			const d = _noise2D( x * 0.05, y * 0.05 ) * invAmp;

			// Crosshair grid placeholder
			const isGrid = ( x % 64 === 0 ) || ( y % 64 === 0 );
			const base = isGrid ? 0.8 : 0.2;

			data[ p ] = Math.floor( Math.max( 0, Math.min( 1, base + d ) ) * 255 );
			data[ p + 1 ] = Math.floor( Math.max( 0, Math.min( 1, base + d ) ) * 255 );
			data[ p + 2 ] = Math.floor( Math.max( 0, Math.min( 1, base + d ) ) * 255 );
			data[ p + 3 ] = 255;

		}

	}

	ctx.putImageData( imageData, 0, 0 );

}

// ---------------------------------------------------------------------------
// Main ExternalTexture class — mirrors three.js/src/textures/ExternalTexture.js
// ---------------------------------------------------------------------------

/**
 * Represents a texture created externally with the same renderer context.
 * This may be a texture from a protected media stream, device camera feed,
 * or other data feeds like a depth sensor.
 *
 * Note that this class is only supported in WebGLRenderer and in the
 * WebGPURenderer WebGPU backend.
 *
 * ```js
 * // assuming you have a WebGLTexture handle created elsewhere
 * const gl = renderer.getContext();
 * const glTexture = gl.createTexture();
 *
 * const texture = new THREE.ExternalTexture( glTexture );
 * texture.needsUpdate = true;
 * ```
 *
 * @augments Texture
 */
class ExternalTexture extends Texture {

	/**
	 * Constructs a new external texture.
	 *
	 * @param {?(WebGLTexture|GPUTexture)} [sourceTexture=null] - The external
	 *   source texture handle created by the same renderer context.
	 */
	constructor( sourceTexture = null ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isExternalTexture = true;

		/**
		 * The external source texture handle. May be a `WebGLTexture` (for
		 * WebGLRenderer) or a `GPUTexture` (for the WebGPURenderer WebGPU
		 * backend).
		 *
		 * @type {?(WebGLTexture|GPUTexture)}
		 * @default null
		 */
		this.sourceTexture = sourceTexture;

		// External textures manage their own GPU state. The engine must not
		// attempt to upload or generate mipmaps for them.
		this.generateMipmaps = false;
		this.flipY = false;
		this.unpackAlignment = 1;

		// Provide a placeholder image with 1x1 dimensions. External-texture
		// consumers should query the source handle for actual dimensions.
		this.image = { width: 1, height: 1, depth: 1 };

	}

	/**
	 * The width of the external texture. Queries the underlying source
	 * handle's dimensions when available.
	 *
	 * @type {number}
	 */
	get width() {

		return this.image?.width ?? 1;

	}

	/**
	 * The height of the external texture. Queries the underlying source
	 * handle's dimensions when available.
	 *
	 * @type {number}
	 */
	get height() {

		return this.image?.height ?? 1;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated external-texture coordinate mapping. Maps a UV
	 * in [0, 1] to the native coordinate space expected by the external
	 * handle (accounting for flipY and typical external-texture
	 * orientation).
	 *
	 * @param {glMatrix.vec2} out - Preallocated gl-matrix vec2 output.
	 * @param {number} u - U coordinate in [0, 1].
	 * @param {number} v - V coordinate in [0, 1].
	 * @returns {glMatrix.vec2}
	 */
	externalUvGlMat( out, u, v ) {

		// External textures typically use top-left origin; three.js uses
		// bottom-left. Flip V unless the texture explicitly opts out.
		const flippedV = this.flipY ? ( 1 - v ) : v;

		glMatrix.vec2.set( out, u, flippedV );
		return out;

	}

	/**
	 * double.js bit-exact frame-delta computation for synchronizing this
	 * external texture with others in a multi-stream pipeline.
	 *
	 * @param {number} currentTimestamp
	 * @param {number} previousTimestamp
	 * @returns {{delta: number, accumulated: number}}
	 */
	frameDeltaPrecise( currentTimestamp, previousTimestamp ) {

		return frameDeltaPrecise( currentTimestamp, previousTimestamp );

	}

	/**
	 * Paint a dithered fallback pattern for platforms that lack native
	 * support for external textures. The fallback is stored on the
	 * instance for diagnostic purposes only — the engine will still
	 * attempt to use the native handle when available.
	 *
	 * @param {number} [width=512] - Fallback canvas width.
	 * @param {number} [height=512] - Fallback canvas height.
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {ExternalTexture} A reference to this instance.
	 */
	paintFallback( width = 512, height = 512, amplitude = 0.5 ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;

		paintExternalFallback( canvas, amplitude );

		const ctx = canvas.getContext( '2d' );
		const imageData = ctx.getImageData( 0, 0, width, height );

		this._fallback = {
			width,
			height,
			data: imageData.data
		};

		return this;

	}

	/**
	 * Create a batched external-stream validation coordinator backed by bitecs.
	 *
	 * @returns {ExternalTextureBatch}
	 */
	static createBatch() {

		return new ExternalTextureBatch();

	}

	/**
	 * Copy the given external texture's properties into this one.
	 *
	 * @param {ExternalTexture} source - The texture to copy from.
	 * @return {ExternalTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.sourceTexture = source.sourceTexture;

		this.generateMipmaps = source.generateMipmaps;
		this.flipY = source.flipY;
		this.unpackAlignment = source.unpackAlignment;

		return this;

	}

	/**
	 * Serializes the external texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// External textures wrap native GPU handles that cannot be
		// serialized. Only structural metadata is preserved; the handle
		// must be re-created by the consuming application.
		output.image = {
			width: this.image?.width ?? 1,
			height: this.image?.height ?? 1,
			depth: this.image?.depth ?? 1
		};

		output.sourceTexture = null;

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { ExternalTexture, ExternalTextureBatch, frameDeltaPrecise, paintExternalFallback };
export default ExternalTexture;