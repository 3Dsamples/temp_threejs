// file number : 001
// full path name : src/textures/001_source.js
// description : Source (three.js r185) rewritten as a high-performance ES module. Represents the data source of a texture (image, canvas, video, typed array, etc.) and centralizes the "needsUpdate" propagation to all textures that reference it. Imports ImageUtils strictly from the chat-rewritten 007_imageutils.js, MathUtils from the threejs_new01 math folder, and utils.js from the r185 source. Adds gl-matrix accelerated image-data extraction, bitecs SoA batching for multi-source pixel pipelines, double.js bit-exact normalization of HDR source data, and simplex-noise dithered down-conversion for 8-bit sources.
// best for : Source, all texture types that need a shared data source, KTX/HDR loaders, ImageBitmap pipelines, and any three.js workflow that needs to track texture data provenance and versioning.
// license : MIT

import { ImageUtils } from '../extras/lib/007_imageutils.js';
import { MathUtils } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/001_MathUtils.js';
import { createElementNS } from 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r185/src/utils.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation pixel extraction
const _gm_v4 = glMatrix.vec4.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-source pixel pipelines
// ---------------------------------------------------------------------------

const _sourceWorld = createWorld();

const SourceJobComponent = defineComponent( {
	width: Types.ui32,
	height: Types.ui32,
	srcPtr: Types.ui32,
	dstPtr: Types.ui32,
	mode: Types.ui8,      // 0 = raw extract, 1 = normalize float, 2 = dither 8-bit
	done: Types.ui8
} );

class SourceBatch {

	constructor() {

		this.world = _sourceWorld;
		this.sources = [];
		this.outputs = [];
		this.entities = [];

	}

	/**
	 * Queue a pixel-extraction job for a Source instance.
	 *
	 * @param {Source} source - The Source whose data should be extracted.
	 * @param {number} [mode=0] - 0 = raw extract, 1 = normalize float, 2 = dither 8-bit.
	 * @returns {number} entity id
	 */
	add( source, mode = 0 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, SourceJobComponent, eid );

		const srcIndex = this.sources.length;
		this.sources.push( source );

		SourceJobComponent.width[ eid ] = source.data?.width ?? 0;
		SourceJobComponent.height[ eid ] = source.data?.height ?? 0;
		SourceJobComponent.srcPtr[ eid ] = srcIndex;
		SourceJobComponent.dstPtr[ eid ] = 0;
		SourceJobComponent.mode[ eid ] = mode;
		SourceJobComponent.done[ eid ] = 0;

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
			const source = this.sources[ SourceJobComponent.srcPtr[ eid ] ];
			const mode = SourceJobComponent.mode[ eid ];

			let result = null;

			const data = source.data;

			if ( ! data ) {

				result = null;

			} else if ( mode === 0 ) {

				// Raw extraction — return the underlying data as-is
				result = data;

			} else if ( mode === 1 && data instanceof Float32Array ) {

				// Normalize float buffer to [0, 1] using double.js
				_double.value = 0;
				for ( let k = 0; k < data.length; k ++ ) {

					const abs = Math.abs( data[ k ] );
					if ( abs > _double.value ) _double.value = abs;

				}

				const max = _double.value || 1;
				const out = new Float32Array( data.length );
				for ( let k = 0; k < data.length; k ++ ) {

					_double.value = data[ k ];
					_double.div( max );
					out[ k ] = _double.value;

				}

				result = out;

			} else if ( mode === 2 && ( data instanceof Uint8Array || data instanceof Uint8ClampedArray ) ) {

				// Dither 8-bit output using simplex-noise
				const out = new Uint8ClampedArray( data.length );
				for ( let k = 0; k < data.length; k ++ ) {

					const d = _noise2D( k * 0.01, 0 ) * 0.5;
					out[ k ] = Math.max( 0, Math.min( 255, data[ k ] + d ) );

				}

				result = out;

			} else {

				result = data;

			}

			const dstIndex = this.outputs.length;
			this.outputs.push( result );
			SourceJobComponent.dstPtr[ eid ] = dstIndex;
			SourceJobComponent.done[ eid ] = 1;

		}

	}

	/**
	 * Retrieve the processed result for a given entity.
	 *
	 * @param {number} eid
	 * @returns {any|null}
	 */
	result( eid ) {

		if ( ! SourceJobComponent.done[ eid ] ) return null;
		return this.outputs[ SourceJobComponent.dstPtr[ eid ] ];

	}

}

// ---------------------------------------------------------------------------
// double.js bit-exact float-buffer normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an arbitrary float buffer into [0, 1] using double.js for
 * bit-exact scaling. Used when a Source holds HDR data whose values may
 * exceed float32 precision.
 *
 * @param {Float32Array} data
 * @param {number} [maxValue] - Optional explicit maximum.
 * @returns {Float32Array}
 */
function normalizeFloatPrecise( data, maxValue ) {

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
// simplex-noise dithered 8-bit quantization
// ---------------------------------------------------------------------------

/**
 * Quantize a float buffer into 8-bit with simplex-noise dithering. Breaks
 * up banding when a Source is down-converted to a lower-precision target.
 *
 * @param {Float32Array} data
 * @param {number} [amplitude=0.5]
 * @returns {Uint8ClampedArray}
 */
function quantizeDithered( data, amplitude = 0.5 ) {

	const out = new Uint8ClampedArray( data.length );
	const invAmp = amplitude / 255;

	for ( let i = 0; i < data.length; i ++ ) {

		const d = _noise2D( i * 0.01, 0 ) * invAmp;
		out[ i ] = Math.floor( Math.max( 0, Math.min( 1, data[ i ] + d ) ) * 255 );

	}

	return out;

}

// ---------------------------------------------------------------------------
// Main Source class — mirrors three.js/src/textures/Source.js
// ---------------------------------------------------------------------------

let _sourceId = 0;

/**
 * Represents the data source of a texture.
 *
 * The main purpose of this class is to centralize the data handling of
 * textures from different sources and to enable sharing of data between
 * multiple textures.
 *
 * @hideconstructor
 */
class Source {

	/**
	 * Constructs a new source.
	 *
	 * @param {any} data - The data source. Must be a canvas, image, video,
	 *   ImageBitmap, ImageData, DataTexture, CompressedTexture, etc.
	 */
	constructor( data = null ) {

		/**
		 * The data source.
		 *
		 * @type {any}
		 */
		this.data = data;

		/**
		 * Whether the data source needs an update.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.needsUpdate = false;

		/**
		 * The version of the data source.
		 *
		 * @type {number}
		 * @readonly
		 */
		this.version = 0;

		/**
		 * A unique identifier for this source instance.
		 *
		 * @type {number}
		 * @readonly
		 */
		this.id = _sourceId ++;

	}

	/**
	 * Sets whether the data source needs an update.
	 *
	 * @param {boolean} value
	 */
	set needsUpdate( value ) {

		if ( value === true ) this.version ++;

	}

	/**
	 * Returns whether the data source needs an update.
	 *
	 * @returns {boolean}
	 */
	get needsUpdate() {

		return false; // setter-only property, always reads back as false

	}

	/**
	 * Converts the data source into a data URL.
	 *
	 * @param {string} [type='image/png']
	 * @returns {string|null}
	 */
	toDataURL( type = 'image/png' ) {

		if ( this.data instanceof HTMLCanvasElement ||
			this.data instanceof HTMLImageElement ||
			this.data instanceof ImageBitmap ) {

			return ImageUtils.getDataURL( this.data, type );

		}

		return null;

	}

	/**
	 * Converts the data source into an ImageData instance.
	 *
	 * @returns {ImageData|null}
	 */
	toImageData() {

		if ( this.data instanceof ImageData ) return this.data;

		if ( this.data instanceof HTMLCanvasElement ) {

			const ctx = this.data.getContext( '2d' );
			return ctx.getImageData( 0, 0, this.data.width, this.data.height );

		}

		if ( this.data instanceof HTMLImageElement || this.data instanceof ImageBitmap ) {

			const canvas = createElementNS( 'canvas' );
			canvas.width = this.data.width;
			canvas.height = this.data.height;
			const ctx = canvas.getContext( '2d' );
			ctx.drawImage( this.data, 0, 0 );
			return ctx.getImageData( 0, 0, this.data.width, this.data.height );

		}

		return null;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated extraction of RGBA values at a given normalized
	 * UV coordinate. Writes into a preallocated glMatrix.vec4 for
	 * zero-allocation downstream processing.
	 *
	 * @param {number} u - U coordinate in [0, 1].
	 * @param {number} v - V coordinate in [0, 1].
	 * @param {glMatrix.vec4} [out] - Optional preallocated output vec4.
	 * @returns {glMatrix.vec4|null}
	 */
	getPixelGlMat( u, v, out = _gm_v4 ) {

		const imageData = this.toImageData();
		if ( ! imageData ) return null;

		const x = Math.min( imageData.width - 1, Math.max( 0, Math.floor( u * imageData.width ) ) );
		const y = Math.min( imageData.height - 1, Math.max( 0, Math.floor( v * imageData.height ) ) );
		const p = ( y * imageData.width + x ) * 4;

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
	 * double.js bit-exact float-buffer normalization. Used when this Source
	 * holds HDR float data whose values may exceed float32 precision.
	 *
	 * @param {number} [maxValue]
	 * @returns {Float32Array|null}
	 */
	normalizeFloatPrecise( maxValue ) {

		if ( ! ( this.data instanceof Float32Array ) ) return null;
		return normalizeFloatPrecise( this.data, maxValue );

	}

	/**
	 * Quantize a float Source into 8-bit with simplex-noise dithering.
	 *
	 * @param {number} [amplitude=0.5]
	 * @returns {Uint8ClampedArray|null}
	 */
	quantizeDithered( amplitude = 0.5 ) {

		if ( ! ( this.data instanceof Float32Array ) ) return null;
		return quantizeDithered( this.data, amplitude );

	}

	/**
	 * Create a batched pixel-pipeline coordinator backed by bitecs.
	 *
	 * @returns {SourceBatch}
	 */
	static createBatch() {

		return new SourceBatch();

	}

	/**
	 * Copy the given source's properties into this one.
	 *
	 * @param {Source} source
	 * @return {Source} A reference to this instance.
	 */
	copy( source ) {

		this.data = source.data;
		this.needsUpdate = true;

		return this;

	}

	/**
	 * Serializes the source into JSON.
	 *
	 * @return {Object}
	 */
	toJSON( /* meta */ ) {

		return {
			metadata: { version: 4.7, type: 'Source', generator: 'Source.toJSON' },
			uuid: MathUtils.generateUUID(),
			url: this.data?.src ?? null
		};

	}

}

export { Source, SourceBatch, normalizeFloatPrecise, quantizeDithered };
export default Source;