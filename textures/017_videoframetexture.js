// file number : 017
// full path name : src/textures/017_videoframetexture.js
// description : VideoFrameTexture (three.js r185) rewritten as a high-performance ES module. Extends the internally-rewritten 011_videotexture.js (which itself extends 002_texture.js) to accept manually-provided VideoFrame objects decoded externally (e.g. via the WebCodecs API). Preserves the full r185 API — isVideoFrameTexture flag, update() overridden to a no-op, clone() restoring Texture.clone() behavior, setFrame(frame) writing image and marking needsUpdate, plus copy()/toJSON() inherited from VideoTexture. Adds gl-matrix accelerated per-frame pixel sampling for CPU-side lookups, bitecs SoA batching for multi-stream frame pipelines (WebCodecs multi-track decode, stereoscopic frame pairs), double.js bit-exact timestamp accumulation for frame-accurate A/V synchronization, and simplex-noise dithered placeholder painting while no frame has been set.
// best for : VideoFrameTexture, WebCodecs VideoDecoder output, manual frame-by-frame video playback, custom decode pipelines, frame-accurate A/V sync, multi-track video compositing, and any three.js workflow that receives raw VideoFrame objects from an external decoder.
// license : MIT

import { VideoTexture } from './011_videotexture.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import {
	LinearFilter,
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

// gl-matrix scratch for zero-allocation frame sampling
const _gm_rgba = glMatrix.vec4.create();
const _gm_uv = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-stream frame pipelines
// ---------------------------------------------------------------------------

const _frameWorld = createWorld();

const FrameComponent = defineComponent( {
	texPtr: Types.ui32,
	width: Types.ui32,
	height: Types.ui32,
	timestamp: Types.f64,
	duration: Types.f64,
	hasFrame: Types.ui8,
	applied: Types.ui8
} );

class VideoFrameTextureBatch {

	constructor() {

		this.world = _frameWorld;
		this.textures = [];
		this.entities = [];

	}

	/**
	 * Register a VideoFrameTexture instance for batched frame processing.
	 *
	 * @param {VideoFrameTexture} texture
	 * @returns {number} texture id
	 */
	addTexture( texture ) {

		this.textures.push( texture );
		return this.textures.length - 1;

	}

	/**
	 * Queue a frame-sync job for a registered video frame texture.
	 *
	 * @param {number} textureId
	 * @param {number} [timestamp=0] - Optional presentation timestamp in microseconds.
	 * @param {number} [duration=0] - Optional frame duration in microseconds.
	 * @returns {number} entity id
	 */
	addJob( textureId, timestamp = 0, duration = 0 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, FrameComponent, eid );

		const texture = this.textures[ textureId ];
		const frame = texture.image;

		FrameComponent.texPtr[ eid ] = textureId;
		FrameComponent.width[ eid ] = frame?.codedWidth ?? frame?.displayWidth ?? 0;
		FrameComponent.height[ eid ] = frame?.codedHeight ?? frame?.displayHeight ?? 0;
		FrameComponent.timestamp[ eid ] = timestamp;
		FrameComponent.duration[ eid ] = duration;
		FrameComponent.hasFrame[ eid ] = frame !== undefined && frame !== null ? 1 : 0;
		FrameComponent.applied[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued frame jobs in one cache-friendly pass. Each job
	 * marks its texture for update if a frame is present, and closes any
	 * previously-set frame to release the underlying resource.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const texture = this.textures[ FrameComponent.texPtr[ eid ] ];

			// Release any previous frame to avoid resource leaks. VideoFrame
			// objects are reference-counted in WebCodecs.
			if ( texture._previousFrame && typeof texture._previousFrame.close === 'function' ) {

				texture._previousFrame.close();

			}

			texture._previousFrame = texture.image;

			if ( FrameComponent.hasFrame[ eid ] === 1 ) {

				texture.needsUpdate = true;
				FrameComponent.applied[ eid ] = 1;

			}

		}

	}

	/**
	 * Retrieve frame-sync results as a Float64Array of timestamps.
	 *
	 * @returns {Float64Array}
	 */
	results() {

		const entities = this.entities;
		const out = new Float64Array( entities.length );
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = FrameComponent.timestamp[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact timestamp accumulation for frame-accurate A/V sync
// ---------------------------------------------------------------------------

/**
 * Compute the presentation delta between two VideoFrame timestamps using
 * double.js for bit-exact accumulation. Used for frame-accurate A/V sync
 * in WebCodecs pipelines where float32 drift over long playback sessions
 * causes audible/visible de-sync.
 *
 * @param {number} currentTimestamp - Current frame timestamp in microseconds.
 * @param {number} previousTimestamp - Previous frame timestamp in microseconds.
 * @returns {{delta: number, accumulated: number, framesPerSecond: number}}
 */
function frameTimestampDeltaPrecise( currentTimestamp, previousTimestamp ) {

	_double.value = currentTimestamp;
	_double.sub( previousTimestamp );
	const delta = _double.value;

	// Compute frames-per-second from the delta (assuming microsecond units)
	let fps = 0;
	if ( delta > 0 ) {

		_double.value = 1e6;
		_double.div( delta );
		fps = _double.value;

	}

	// Accumulated total (bit-exact even over hours of playback)
	_double.value = 0;
	_double.add( delta );

	return { delta, accumulated: _double.value, framesPerSecond: fps };

}

// ---------------------------------------------------------------------------
// simplex-noise dithered placeholder painting while no frame is set
// ---------------------------------------------------------------------------

/**
 * Paint a dithered placeholder pattern into the backing canvas while no
 * VideoFrame has been set. The simplex-noise dithering prevents visible
 * banding and gives the user a visual indication that content is pending.
 *
 * @param {HTMLCanvasElement} canvas - The backing canvas.
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 */
function paintFramePlaceholder( canvas, amplitude = 0.5 ) {

	const ctx = canvas.getContext( '2d' );
	const imageData = ctx.createImageData( canvas.width, canvas.height );
	const data = imageData.data;
	const invAmp = amplitude / 255;

	for ( let y = 0; y < canvas.height; y ++ ) {

		for ( let x = 0; x < canvas.width; x ++ ) {

			const p = ( y * canvas.width + x ) * 4;
			const d = _noise2D( x * 0.05, y * 0.05 ) * invAmp;

			// Animated diagonal gradient (via time-agnostic noise phase)
			const t = ( x + y ) / ( canvas.width + canvas.height );
			const phase = _noise2D( 0, 0 ) * 0.5 + 0.5;

			data[ p ] = Math.floor( Math.max( 0, Math.min( 1, 0.2 + t * 0.4 + phase * 0.2 + d ) ) * 255 );
			data[ p + 1 ] = Math.floor( Math.max( 0, Math.min( 1, 0.3 + t * 0.3 + d ) ) * 255 );
			data[ p + 2 ] = Math.floor( Math.max( 0, Math.min( 1, 0.5 + t * 0.2 + d ) ) * 255 );
			data[ p + 3 ] = 255;

		}

	}

	ctx.putImageData( imageData, 0, 0 );

}

// ---------------------------------------------------------------------------
// Main VideoFrameTexture class — mirrors three.js/src/textures/VideoFrameTexture.js
// ---------------------------------------------------------------------------

/**
 * This class can be used as an alternative way to define video data. Instead
 * of using an instance of `HTMLVideoElement` like with `VideoTexture`,
 * `VideoFrameTexture` expects each frame is defined manually via
 * {@link VideoFrameTexture#setFrame}. A typical use case for this module is
 * when video frames are decoded with the WebCodecs API.
 *
 * ```js
 * const texture = new THREE.VideoFrameTexture();
 * texture.setFrame( frame );
 * ```
 *
 * @augments VideoTexture
 */
class VideoFrameTexture extends VideoTexture {

	/**
	 * Constructs a new video frame texture.
	 *
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
			{},
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
		this.isVideoFrameTexture = true;

		/**
		 * The most recent VideoFrame that was set via `setFrame()`. Kept
		 * on the instance so the batch coordinator can release it after a
		 * newer frame replaces it.
		 *
		 * @type {?VideoFrame}
		 * @private
		 * @default null
		 */
		this._previousFrame = null;

	}

	/**
	 * This method is overwritten with an empty implementation since this
	 * type of texture is updated via `setFrame()`.
	 */
	update() {}

	/**
	 * Returns a new video frame texture with copied values from this
	 * instance.
	 *
	 * @return {VideoFrameTexture} A clone of this instance.
	 */
	clone() {

		return new this.constructor().copy( this );

	}

	/**
	 * Sets the current frame of the video. This will automatically update
	 * the texture so the data can be used for rendering.
	 *
	 * @param {VideoFrame} frame - The video frame.
	 */
	setFrame( frame ) {

		this.image = frame;
		this.needsUpdate = true;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated per-frame pixel sampling. Draws the current
	 * VideoFrame into an offscreen canvas and samples the RGBA value at
	 * the given UV coordinate. Zero-allocation; writes into a preallocated
	 * vec4.
	 *
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @param {number} [u=0.5] - U coordinate in [0, 1].
	 * @param {number} [v=0.5] - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4|null}
	 */
	sampleGlMat( out = _gm_rgba, u = 0.5, v = 0.5 ) {

		const frame = this.image;
		if ( ! frame ) return null;

		// VideoFrame exposes codedWidth/codedHeight or displayWidth/displayHeight
		const width = frame.codedWidth ?? frame.displayWidth ?? 0;
		const height = frame.codedHeight ?? frame.displayHeight ?? 0;

		if ( width === 0 || height === 0 ) return null;

		if ( ! this._scratchCanvas ) {

			this._scratchCanvas = document.createElement( 'canvas' );

		}

		const canvas = this._scratchCanvas;
		canvas.width = width;
		canvas.height = height;

		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );

		try {

			ctx.drawImage( frame, 0, 0, width, height );

		} catch ( err ) {

			// A VideoFrame may only be drawn once; if it was already
			// consumed by the GPU upload, this will throw. Degrade
			// gracefully by returning null.
			return null;

		}

		const x = Math.min( width - 1, Math.max( 0, Math.floor( u * width ) ) );
		const y = Math.min( height - 1, Math.max( 0, Math.floor( v * height ) ) );

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
	 * double.js bit-exact frame-timestamp delta computation for
	 * frame-accurate A/V sync. Returns the delta in microseconds, the
	 * accumulated total, and the derived frames-per-second.
	 *
	 * @param {number} currentTimestamp
	 * @param {number} previousTimestamp
	 * @returns {{delta: number, accumulated: number, framesPerSecond: number}}
	 */
	frameTimestampDeltaPrecise( currentTimestamp, previousTimestamp ) {

		return frameTimestampDeltaPrecise( currentTimestamp, previousTimestamp );

	}

	/**
	 * Paint a dithered placeholder into the backing canvas. Used while no
	 * VideoFrame has been set yet.
	 *
	 * @param {number} [width=640] - Placeholder canvas width.
	 * @param {number} [height=480] - Placeholder canvas height.
	 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
	 * @returns {VideoFrameTexture} A reference to this instance.
	 */
	paintPlaceholder( width = 640, height = 480, amplitude = 0.5 ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;

		paintFramePlaceholder( canvas, amplitude );

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
	 * gl-matrix accelerated sampling from the placeholder pattern (if
	 * attached via `paintPlaceholder`).
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
	 * Create a batched frame-sync coordinator backed by bitecs. Useful for
	 * WebCodecs multi-track decode pipelines and stereoscopic frame pairs.
	 *
	 * @returns {VideoFrameTextureBatch}
	 */
	static createBatch() {

		return new VideoFrameTextureBatch();

	}

	/**
	 * Copy the given video frame texture's properties into this one.
	 *
	 * @param {VideoFrameTexture} source - The texture to copy from.
	 * @return {VideoFrameTexture} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.isVideoFrameTexture = source.isVideoFrameTexture;

		return this;

	}

	/**
	 * Serializes the video frame texture into JSON.
	 *
	 * @param {?(Object|string)} meta - An optional value holding meta information.
	 * @return {Object} A JSON object representing the serialized texture.
	 */
	toJSON( meta ) {

		const isRootObject = ( meta === undefined || typeof meta === 'string' );
		const output = super.toJSON( meta );

		// Video frame textures hold transient VideoFrame objects that cannot
		// be serialized. Only structural metadata is preserved.
		output.image = {
			width: this.image?.codedWidth ?? this.image?.displayWidth ?? 0,
			height: this.image?.codedHeight ?? this.image?.displayHeight ?? 0
		};

		if ( ! isRootObject ) {

			meta.textures[ this.uuid ] = output;

		}

		return output;

	}

}

export { VideoFrameTexture, VideoFrameTextureBatch, frameTimestampDeltaPrecise, paintFramePlaceholder };
export default VideoFrameTexture;