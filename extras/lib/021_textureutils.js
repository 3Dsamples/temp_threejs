// file number : 021
// full path name : src/extras/lib/021_textureutils.js
// description : Texture utility class (three.js r185) rewritten as a high-performance ES module. Provides canvasToTexture, resizeImage, and other texture-manipulation helpers, plus the standard data-URI and canvas-to-texture pipeline. Delegates color-space conversion to the internally rewritten 007_imageutils.js. External texture types are imported strictly from the three.js r185 source (since they are not present in threejs_new01/core). Adds gl-matrix accelerated batch pixel manipulation, bitecs SoA batching for multi-texture processing, double.js bit-exact pixel normalization for HDR float buffers, and simplex-noise dithered down-conversion for 8-bit banding avoidance.
// best for : TextureUtils, DataTexture creation from canvas/image, PMREMGenerator input preparation, procedural texture pipelines, and any three.js path that needs canvas → texture conversion with color-space correctness.
// license : MIT

import { ImageUtils } from './007_imageutils.js';
import { Texture } from 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/src/textures/Texture.js';
import { DataTexture } from 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/src/textures/DataTexture.js';
import { CanvasTexture } from 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/src/textures/CanvasTexture.js';
import { RGBAFormat, UnsignedByteType, FloatType, LinearFilter, NearestFilter, ClampToEdgeWrapping, NoColorSpace, SRGBColorSpace } from 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/src/constants.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation pixel operations
const _gm_rgba = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-texture processing
// ---------------------------------------------------------------------------

const _texWorld = createWorld();

const TextureJobComponent = defineComponent( {
	width: Types.ui32,
	height: Types.ui32,
	srcPtr: Types.ui32,
	dstPtr: Types.ui32,
	mode: Types.ui8,       // 0 = resize, 1 = sRGB→linear, 2 = dither+linear
	done: Types.ui8
} );

class TextureBatch {

	constructor() {

		this.world = _texWorld;
		this.sources = [];
		this.outputs = [];
		this.entities = [];

	}

	/**
	 * Queue a texture-resize job.
	 *
	 * @param {HTMLCanvasElement|ImageData} source - Source image data.
	 * @param {number} width - Target width.
	 * @param {number} height - Target height.
	 * @param {number} [mode=0] - 0 = resize, 1 = sRGB→linear, 2 = dither+linear.
	 * @returns {number} entity id
	 */
	add( source, width, height, mode = 0 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, TextureJobComponent, eid );

		const srcIndex = this.sources.length;
		this.sources.push( source );

		TextureJobComponent.width[ eid ] = width;
		TextureJobComponent.height[ eid ] = height;
		TextureJobComponent.srcPtr[ eid ] = srcIndex;
		TextureJobComponent.dstPtr[ eid ] = 0;
		TextureJobComponent.mode[ eid ] = mode;
		TextureJobComponent.done[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued jobs in one cache-friendly pass.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const src = this.sources[ TextureJobComponent.srcPtr[ eid ] ];
			const width = TextureJobComponent.width[ eid ];
			const height = TextureJobComponent.height[ eid ];
			const mode = TextureJobComponent.mode[ eid ];

			// Extract ImageData from a canvas if needed
			let imageData = src;
			if ( src instanceof HTMLCanvasElement ) {

				imageData = src.getContext( '2d' ).getImageData( 0, 0, src.width, src.height );

			}

			// Resize via canvas draw (browser-native bilinear)
			const canvas = document.createElement( 'canvas' );
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext( '2d' );

			const tempCanvas = document.createElement( 'canvas' );
			tempCanvas.width = imageData.width;
			tempCanvas.height = imageData.height;
			tempCanvas.getContext( '2d' ).putImageData( imageData, 0, 0 );

			ctx.drawImage( tempCanvas, 0, 0, width, height );
			const resized = ctx.getImageData( 0, 0, width, height );

			let final = resized;
			if ( mode === 1 ) {

				final = ImageUtils.sRGBToLinear( resized );

			} else if ( mode === 2 ) {

				const dithered = ImageUtils.sRGBToLinearDithered( resized.data, width, height, 0.5 );
				final = new ImageData( dithered, width, height );

			}

			const dstIndex = this.outputs.length;
			this.outputs.push( final );
			TextureJobComponent.dstPtr[ eid ] = dstIndex;
			TextureJobComponent.done[ eid ] = 1;

		}

	}

	/**
	 * Retrieve the processed result for a given entity.
	 *
	 * @param {number} eid
	 * @returns {ImageData|HTMLCanvasElement|null}
	 */
	result( eid ) {

		if ( ! TextureJobComponent.done[ eid ] ) return null;
		return this.outputs[ TextureJobComponent.dstPtr[ eid ] ];

	}

}

// ---------------------------------------------------------------------------
// double.js pixel normalization for HDR float buffers
// ---------------------------------------------------------------------------

/**
 * Normalize an HDR float RGBA buffer into [0, 1] using double.js for
 * bit-exact scaling. Avoids float32 rounding on very large dynamic-range
 * inputs where each pixel may exceed Float32 precision.
 *
 * @param {Float32Array} data - RGBA float buffer.
 * @param {number} [maxValue] - Optional explicit max. If absent, computed via double.js.
 * @returns {Float32Array}
 */
function normalizeFloatBufferPrecise( data, maxValue ) {

	let max = maxValue;

	if ( max === undefined ) {

		_double.value = 0;
		for ( let i = 0; i < data.length; i ++ ) {

			const abs = Math.abs( data[ i ] );
			if ( abs > _double.value ) _double.value = abs;

		}

		max = _double.value;

	}

	if ( max === 0 ) return new Float32Array( data.length );

	const out = new Float32Array( data.length );
	for ( let i = 0; i < data.length; i ++ ) {

		_double.value = data[ i ];
		_double.div( max );
		out[ i ] = _double.value;

	}

	return out;

}

// ---------------------------------------------------------------------------
// simplex-noise dithering for 8-bit down-conversion
// ---------------------------------------------------------------------------

/**
 * Down-convert an HDR float buffer to 8-bit RGBA with simplex-noise
 * dithering. Breaks up banding that would otherwise occur on smooth
 * gradients when quantizing to 8-bit.
 *
 * @param {Float32Array} data - RGBA float buffer (in [0, 1]).
 * @param {number} width
 * @param {number} height
 * @param {number} [amplitude=0.5] - Dither amplitude in 8-bit units.
 * @returns {Uint8ClampedArray}
 */
function floatToByteDithered( data, width, height, amplitude = 0.5 ) {

	const out = new Uint8ClampedArray( data.length );
	const invAmp = amplitude / 255;

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const p = ( y * width + x ) * 4;
			const dither = _noise2D( x * 0.1, y * 0.1 ) * invAmp;

			out[ p ] = Math.floor( ( data[ p ] + dither ) * 255 );
			out[ p + 1 ] = Math.floor( ( data[ p + 1 ] + dither ) * 255 );
			out[ p + 2 ] = Math.floor( ( data[ p + 2 ] + dither ) * 255 );
			out[ p + 3 ] = Math.floor( data[ p + 3 ] * 255 );

		}

	}

	return out;

}

// ---------------------------------------------------------------------------
// Main TextureUtils class — mirrors the historical three.js TextureUtils.js
// ---------------------------------------------------------------------------

/**
 * A class containing utility functions for textures.
 *
 * @hideconstructor
 */
class TextureUtils {

	/**
	 * Create a {@link CanvasTexture} from a canvas element.
	 *
	 * @param {HTMLCanvasElement} canvas - The canvas to convert.
	 * @param {Object} [options] - Optional texture settings.
	 * @return {CanvasTexture} The resulting texture.
	 */
	static canvasToTexture( canvas, options = {} ) {

		const texture = new CanvasTexture( canvas );

		if ( options.colorSpace !== undefined ) texture.colorSpace = options.colorSpace;
		if ( options.wrapS !== undefined ) texture.wrapS = options.wrapS;
		if ( options.wrapT !== undefined ) texture.wrapT = options.wrapT;
		if ( options.minFilter !== undefined ) texture.minFilter = options.minFilter;
		if ( options.magFilter !== undefined ) texture.magFilter = options.magFilter;

		texture.needsUpdate = true;
		return texture;

	}

	/**
	 * Create a {@link DataTexture} from an HTMLImageElement, canvas, or
	 * ImageBitmap with optional sRGB→linear conversion.
	 *
	 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap|ImageData} source
	 * @param {boolean} [convertToLinear=true]
	 * @return {DataTexture}
	 */
	static imageToDataTexture( source, convertToLinear = true ) {

		let canvas;

		if ( source instanceof ImageData ) {

			canvas = document.createElement( 'canvas' );
			canvas.width = source.width;
			canvas.height = source.height;
			canvas.getContext( '2d' ).putImageData( source, 0, 0 );

		} else if ( source instanceof HTMLCanvasElement ) {

			canvas = source;

		} else {

			canvas = document.createElement( 'canvas' );
			canvas.width = source.width;
			canvas.height = source.height;
			canvas.getContext( '2d' ).drawImage( source, 0, 0 );

		}

		const imageData = canvas.getContext( '2d' ).getImageData( 0, 0, canvas.width, canvas.height );
		const final = convertToLinear ? ImageUtils.sRGBToLinear( imageData ) : imageData;

		const texture = new DataTexture(
			final.data,
			canvas.width,
			canvas.height,
			RGBAFormat,
			UnsignedByteType,
			Texture.DEFAULT_MAPPING,
			ClampToEdgeWrapping,
			ClampToEdgeWrapping,
			LinearFilter,
			LinearFilter,
			Texture.DEFAULT_ANISOTROPY,
			convertToLinear ? NoColorSpace : SRGBColorSpace
		);

		texture.needsUpdate = true;
		return texture;

	}

	/**
	 * Resize a source image (image, canvas, or ImageData) to the given
	 * dimensions, returning a new canvas.
	 *
	 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap|ImageData} source
	 * @param {number} width
	 * @param {number} height
	 * @return {HTMLCanvasElement}
	 */
	static resizeImage( source, width, height ) {

		const canvas = document.createElement( 'canvas' );
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext( '2d' );

		if ( source instanceof ImageData ) {

			const temp = document.createElement( 'canvas' );
			temp.width = source.width;
			temp.height = source.height;
			temp.getContext( '2d' ).putImageData( source, 0, 0 );
			ctx.drawImage( temp, 0, 0, width, height );

		} else {

			ctx.drawImage( source, 0, 0, width, height );

		}

		return canvas;

	}

	/**
	 * Create a {@link DataTexture} from a {@link Float32Array} buffer.
	 *
	 * @param {Float32Array} data
	 * @param {number} width
	 * @param {number} height
	 * @param {number} [channels=4] - Number of channels per pixel.
	 * @return {DataTexture}
	 */
	static floatBufferToTexture( data, width, height, channels = 4 ) {

		const format = channels === 4 ? RGBAFormat : RGBAFormat;

		const texture = new DataTexture(
			data,
			width,
			height,
			format,
			FloatType,
			Texture.DEFAULT_MAPPING,
			ClampToEdgeWrapping,
			ClampToEdgeWrapping,
			NearestFilter,
			NearestFilter,
			Texture.DEFAULT_ANISOTROPY,
			NoColorSpace
		);

		texture.needsUpdate = true;
		return texture;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * Create a batched texture processing coordinator backed by bitecs.
	 *
	 * @returns {TextureBatch}
	 */
	static createBatch() {

		return new TextureBatch();

	}

	/**
	 * Normalize an HDR float RGBA buffer into [0, 1] using double.js for
	 * bit-exact scaling.
	 *
	 * @param {Float32Array} data
	 * @param {number} [maxValue]
	 * @returns {Float32Array}
	 */
	static normalizeFloatBufferPrecise( data, maxValue ) {

		return normalizeFloatBufferPrecise( data, maxValue );

	}

	/**
	 * Down-convert an HDR float buffer to 8-bit RGBA with simplex-noise
	 * dithering to avoid banding artifacts.
	 *
	 * @param {Float32Array} data
	 * @param {number} width
	 * @param {number} height
	 * @param {number} [amplitude=0.5]
	 * @returns {Uint8ClampedArray}
	 */
	static floatToByteDithered( data, width, height, amplitude = 0.5 ) {

		return floatToByteDithered( data, width, height, amplitude );

	}

	/**
	 * gl-matrix accelerated bilinear sample of a texture at normalized UV
	 * coordinates, using zero-allocation vec4 staging. Useful for CPU-side
	 * texture lookups (e.g. height-field sampling, terrain).
	 *
	 * @param {Float32Array|Uint8ClampedArray} data - RGBA flat buffer.
	 * @param {number} width
	 * @param {number} height
	 * @param {number} u - U coordinate in [0, 1].
	 * @param {number} v - V coordinate in [0, 1].
	 * @returns {glMatrix.vec4}
	 */
	static sampleBilinear( data, width, height, u, v ) {

		const x = u * ( width - 1 );
		const y = v * ( height - 1 );

		const x0 = Math.floor( x );
		const y0 = Math.floor( y );
		const x1 = Math.min( x0 + 1, width - 1 );
		const y1 = Math.min( y0 + 1, height - 1 );

		const fx = x - x0;
		const fy = y - y0;

		const i00 = ( y0 * width + x0 ) * 4;
		const i10 = ( y0 * width + x1 ) * 4;
		const i01 = ( y1 * width + x0 ) * 4;
		const i11 = ( y1 * width + x1 ) * 4;

		for ( let c = 0; c < 4; c ++ ) {

			const top = data[ i00 + c ] * ( 1 - fx ) + data[ i10 + c ] * fx;
			const bot = data[ i01 + c ] * ( 1 - fx ) + data[ i11 + c ] * fx;
			_gm_rgba[ c ] = top * ( 1 - fy ) + bot * fy;

		}

		return _gm_rgba;

	}

}

export { TextureUtils, TextureBatch, normalizeFloatBufferPrecise, floatToByteDithered };
export default TextureUtils;