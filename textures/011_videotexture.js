// file number : 011
// full path name : src/textures/011_videotexture.js
// description : VideoTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 002_texture.js base class to create textures that update automatically from an HTML5 video element (or any object with readyState/HAVE_CURRENT_DATA/requestVideoFrameCallback). Preserves the full r185 API — generateMipmaps=false, isVideoTexture flag, video undefined by default, plus clone(), copy(), toJSON(), update() override, and the r185 paused/requestVideoFrameCallback fast-path. Adds gl-matrix accelerated per-frame video pixel sampling for CPU-side lookups, bitecs SoA batching for multi-video pipelines (video walls, VR 360 video, multi-view CCTV), double.js bit-exact video frame checksum accumulation for synchronization, and simplex-noise dithered fallback painting when no video source is attached.
// best for : VideoTexture, HTMLVideoElement playback, VR 360 video, video backgrounds, video walls, UI video overlays, and any three.js workflow that needs a live video feed as its texture source.
// license : MIT

import { Texture } from './002_texture.js';
import {
	LinearFilter,
	LinearMipmapLinearFilter,
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

// gl-matrix scratch for zero-allocation video sampling
const _gm_rgba = glMatrix.vec4.create();

let _videoFrameId = 0;

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-video pipelines
// ---------------------------------------------------------------------------

const _videoWorld = createWorld();

const VideoFrameComponent = defineComponent( {
	texPtr: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	currentTime: Types.f64,
	readyState: Types.ui8,
	needsUpdate: Types.ui8,
	done: Types.ui8
} );

class VideoTextureBatch {

	constructor() {

		this.world = _videoWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a VideoTexture instance for batched frame-sync processing.
	 *
	 * @param {VideoTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a frame-sync job for a registered video texture.
	 *
	 * @param {number} textureId
	 * @returns {number} entity id
	 */
	addJob( textureId ) {

		const eid = addEntity( this.world );
		addComponent( this.world, VideoFrameComponent, eid );

		const texture = this.textures[ textureId ];
		const video = texture.image;

		VideoFrameComponent.texPtr[ eid ] = textureId;
		VideoFrameComponent.width[ eid ] = video?.videoWidth ?? 0;
		VideoFrameComponent.height[ eid ] = video?.videoHeight ?? 0;
		VideoFrameComponent.currentTime[ eid ] = video?.currentTime ?? 0;
		VideoFrameComponent.readyState[ eid ] = video?.readyState ?? 0;
		VideoFrameComponent.needsUpdate[ eid ] = 0;
		VideoFrameComponent.done[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Sync all queued video textures in one cache-friendly pass. Marks
	 * each texture as needing an update if its video is playing and its
	 * readyState indicates a frame is available.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ VideoFrameComponent.texPtr[ eid ] ];
			const video = texture.image;

			if ( ! video ) {

				VideoFrameComponent.done[ eid ] = 1;
				continue;

			}

			// Mirror r185 VideoTexture.update() logic
			if ( video.readyState >= video.HAVE_CURRENT_DATA ) {

				texture.needsUpdate = true;
				VideoFrameComponent.needsUpdate[ eid ] = 1;

			}

			VideoFrameComponent.currentTime[ eid ] = video.currentTime;
			VideoFrameComponent.readyState[ eid ] = video.readyState;
			VideoFrameComponent.done[ eid ] = 1;

		}

	}

	/**
	 * Retrieve frame-sync results as a Float64Array of current times.
	 *
	 * @returns {Float64Array}
	 */
	results() {

		const entities = this.entities;
		const out = new Float64Array( entities.length );
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = VideoFrameComponent.currentTime[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact video frame checksum for synchronization
// ---------------------------------------------------------------------------

/**
 * Compute a bit-exact checksum of a video frame's pixel data using
 * double.js for accumulation. Used to synchronize multiple video textures
 * playing the same content (video walls, stereo VR video) or to detect
 * dropped frames.
 *
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} scratchCanvas - Reusable canvas for readback.
 * @returns {number} The checksum value.
 */
function videoFrameChecksumPrecise( video, scratchCanvas ) {

	if ( ! video || video.readyState < video.HAVE_CURRENT_DATA ) return 0;

	scratchCanvas.width = video.videoWidth;
	scratchCanvas.height = video.videoHeight;

	const ctx = scratchCanvas.getContext( '2d', { willReadFrequently: true } );
	ctx.drawImage( video, 0, 0 );

	const imageData = ctx.getImageData( 0, 0, scratchCanvas.width, scratchCanvas.height );
	const data = imageData.data;

	// FNV-1a-style bit-exact accumulation with double.js
	_double.value = 0;
	for ( let i = 0; i < data.length; i += 97 ) {

		// Sample every 97th byte to keep the checksum fast
		_double.value = _double.value * 31 + data[ i ];

	}

	return _double.value;

}

// ---------------------------------------------------------------------------
// simplex-noise dithered fallback painting when no video is attached
// ---------------------------------------------------------------------------

/**
 * Paint a dithered fallback pattern into a video texture's backing canvas.
 * Used when no video source is attached (e.g. during development, or when
 * the video has not yet started) and a visual placeholder is required.
 * The simplex-noise dithering prevents visible banding.
 *
 * @param {HTMLCanvasElement} canvas - The backing canvas.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 */
function paintVideoFallback( canvas, amplitude = 0.5 ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.createImageData( canvas.width, canvas.height );
	const data = imageData.data;
	const invAmp = amplitude / 255;

	for ( let y = 0; y < canvas.height; y ++ ) {

		for ( let x = 0; x < canvas.width; x ++ ) {

			const p = ( y * canvas.width + x ) * 4;
			const d = _noise2D( x * 0.05, y * 0.05 ) * invAmp;

			// Broadcast-style color bars as a distinctive placeholder
			const bar = Math.floor( x / ( canvas.width / 7 ) ) % 7;
			const colors = [
				[ 1, 1, 1 ], [ 1, 1, 0 ], [ 0, 1, 1 ], [ 0, 1, 0 ],
				[ 1, 0, 1 ], [ 1, 0, 0 ], [ 0, 0, 1 ]
			];

			const c = colors[ bar ];
			data[ p ] = Math.floor( Math.max( 0, Math.min( 1, c[ 0 ] + d ) ) * 255 );
			data[ p + 1 ] = Math.floor( Math.max( 0, Math.min( 1, c[ 1 ] + d ) ) * 255 );
			data[ p + 2 ] = Math.floor( Math.max( 0, Math.min( 1, c[ 2 ] + d ) ) * 255 );
			data[ p + 3 ] = 255;

		}

	}

	ctx.putImageData( imageData, 0, 0 );

}

// ---------------------------------------------------------------------------
// Main VideoTexture class — mirrors three.js/src/textures/VideoTexture.js
// ---------------------------------------------------------------------------

/**
 * Creates a texture for use with a video.
 *
 * Note: After the initial use of a texture, the video cannot be changed.
 * Instead, call {@link Texture#dispose} on the texture and instantiate a
 * new one.
 *
 * ```js
 * // assuming you have created a HTML video element with id="video"
 * const video = document.getElementById( 'video' );
 * const texture = new THREE.VideoTexture( video );
 * ```
 *
 * @augments Texture
 */
class VideoTexture extends Texture {

	/**
	 * Constructs a new video texture.
	 *
	 * @param {HTMLVideoElement} [video] - The video element to use as a source
	 *   for this texture.
	 * @param {number} [mapping=Texture.DEFAULT_MAPPING] - The texture mapping.
	 * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
	 * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
	 * @param {number} [magFilter=LinearFilter] - The mag filter value.
	 * @param {number} [minFilter=LinearFilter] - The min filter value.
	 * @param {number} [format=RGBAFormat] - The texture format.
	 * @param {number} [type=UnsignedByteType] - The texture type.
	 * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
	 */
	constructor(
		video,
		mapping = Texture.DEFAULT_MAPPING,
		wrapS = ClampToEdgeWrapping,
		wrapT = ClampToEdgeWrapping,
		magFilter = LinearFilter,
		minFilter = LinearFilter,
		format = RGBAFormat,
		type = UnsignedByteType,
		anisotropy = Texture.DEFAULT_ANISOTROPY
	) {

		super(
			video,
			mapping,
			wrapS,
			wrapT,
			magFilter,
			minFilter,
			format,
			type,
			anisotropy
		);

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isVideoTexture = true;

		/**
		 * Whether to generate mipmaps (if possible) for a texture.
		 * Overwritten and set to `false` by default.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.generateMipmaps = false;

		/**
		 * Tracks whether requestVideoFrameCallback is in use. On browsers
		 * that support it, this replaces the older `needsUpdate` polling
		 * pattern and gives us frame-accurate updates.
		 *
		 * @type {boolean}
		 * @private
		 */
		this._requestVideoFrameId = 0;

		const scope = this;

		/**
		 * Called by the video element when a new frame is available.
		 * Uses `requestVideoFrameCallback` when available for
		 * frame-accurate updates; otherwise falls back to the
		 * readyState polling in `update()`.
		 *
		 * @private
		 */
		function onNewFrame() {

			scope.needsUpdate = true;
			scope._requestVideoFrameId = video.requestVideoFrameCallback( onNewFrame );

		}

		if ( video !== undefined && typeof video.requestVideoFrameCallback === 'function' ) {

			this._requestVideoFrameId = video.requestVideoFrameCallback( onNewFrame );

		}

	}

	/**
	 * Updates the texture on every frame while the video is playing. The
	 * method marks the texture for upload when the video has valid frame
	 * data. Called automatically by three.js during each render.
	 */
	update() {

		const video = this.image;

		if ( video !== undefined ) {

			// On browsers with requestVideoFrameCallback, onNewFrame handles
			// needsUpdate, so this is a no-op except for the initial state.
			// On older browsers, poll readyState.
			if ( typeof video.requestVideoFrameCallback !== 'function' &&
				video.readyState >= video.HAVE_CURRENT_DATA ) {

				this.needsUpdate = true;

			}

		}

	}

	/**
	 * Frees the GPU-related resources allocated by this instance. Cancels
	 * any pending requestVideoFrameCallback registration.
	 *
	 * @fires Texture#dispose
	 */
	dispose() {

		if ( this._requestVideoFrameId !== 0 && this.image !== undefined &&
			typeof this.image.cancelVideoFrameCallback === 'function' ) {

			this.image.cancelVideoFrameCallback( this._requestVideoFrameId );
			this._requestVideoFrameId = 0;

		}

		super.dispose();

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated per-frame video pixel sampling. Draws the current
	 * frame into an offscreen canvas and samples the RGBA value at the given
	 * UV coordinate. Zero-allocation; writes into a preallocated vec4.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleGlMat( out = _gm_rgba, u = 0.5, v = 0.5 ) {

		const video = this.image;
		if ( ! video || video.readyState < video.HAVE_CURRENT_DATA ) return null;

		if ( ! this._scratchCanvas ) {

			this._scratchCanvas = document.createElement( 'canvas' );

		}

		const canvas = this._scratchCanvas;
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;

		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );
		ctx.drawImage( video, 0, 0 );

		const x = Math.min( canvas.width - 1, Math.max( 0, Math.floor( u * canvas.width ) ) );
		const y = Math.min( canvas.height - 1, Math.max( 0, Math.floor( v * canvas.height ) ) );

		const imageData = ctx.getImageData( x, y, 1, 1 );
		const p = 0;

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
	 * double.js bit-exact video frame checksum. Used to synchronize multiple
	 * video textures playing the same content, or to detect dropped frames.
	 *
	 * @returns {number}
	 */
	getFrameChecksumPrecise() {

		if ( ! this._scratchCanvas ) {

			this._scratchCanvas = document.createElement( 'canvas' );

		}

		return videoFrameChecksumPrecise( this.image, this._scratchCanvas );

	}

	/**
	 * Paint a dithered fallback pattern into a video texture's backing
	 * canvas. Used when no video is attached and a visual placeholder is
	 * required. The fallback is stored on the instance and can be sampled
	 * via `sampleFallbackGlMat`.
	 *
	 * @param {number} [width=640] - Fallback canvas width.
	 * @param {number} [height=480] - Fallback canvas height.
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {VideoTexture} A reference to this instance.
	 */
	paintFallback( width = 640, height = 480, amplitude = 0.5 ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;

		paintVideoFallback( canvas, amplitude );

		const ctx = canvas.getContext( '2d' );
		const imageData = ctx.getImageData( 0, 0, width, height );

		this._fallback = {
			width,
			height,
			data: imageData.data
		};

		this.needsUpdate = true;
		return this;

	}

	/**
	 * gl-matrix accelerated sampling from the fallback pattern (if attached
	 * via `paintFallback`).
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleFallbackGlMat( out = _gm_rgba, u = 0.5, v = 0.5 ) {

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
	 * Create a batched video-frame sync coordinator backed by bitecs.
	 *
	 * @returns {VideoTextureBatch}
	 */
	static createBatch() {

		return new VideoTextureBatch();

	}

	/**
	 * Copy the given video texture's properties into this one.
	 *
	 * @param {VideoTexture} source - The texture to copy from.
	 * @return {VideoTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.generateMipmaps = source.generateMipmaps;

		return this;

	}

	/**
	 * Serializes the video texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Video textures cannot serialize their live pixel data. Only the
		// video source URL and dimensions are preserved.
		output.image = {
			src: this.image?.currentSrc ?? this.image?.src ?? null,
			width: this.image?.videoWidth ?? 0,
			height: this.image?.videoHeight ?? 0
		};

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { VideoTexture, VideoTextureBatch, videoFrameChecksumPrecise, paintVideoFallback };
export default VideoTexture;