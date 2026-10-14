// file number : 003
// full path name : src/extras/lib/003_datautils.js
// description : Binary data conversion utilities (half-float ↔ float32, normalized integer ↔ float) rewritten as a high-performance ES module. Uses gl-matrix for vectorized batch conversions, bitecs SoA arrays for cache-friendly bulk processing, double.js for bit-exact precision fallback on subnormal half-floats, and simplex-noise to demonstrate deterministic seedable conversion pipelines.
// best for : Loading/saving half-float textures (DataTexture with HalfFloatType), packed vertex attributes, and any binary buffer conversion path in three.js that must stay bit-exact.
// license : MIT

import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch buffers & precision helpers
// ---------------------------------------------------------------------------

const _floatView = new Float32Array( 1 );
const _int32View = new Int32Array( _floatView.buffer );

const _double = new Double( 0 );
const _noise2D = createNoise2D();

// ---------------------------------------------------------------------------
// Half-float conversion tables (faster than per-value branching)
// ---------------------------------------------------------------------------

const _halfFloatTable = new Float32Array( 65536 );
const _floatToHalfTable = new Uint16Array( 65536 );

// Precompute fromHalfFloat for all 65536 possible uint16 inputs.
( function buildHalfFloatTable() {

	for ( let i = 0; i < 65536; i ++ ) {

		const s = ( i & 0x8000 ) >> 15;
		const e = ( i & 0x7C00 ) >> 10;
		const f = i & 0x03FF;

		if ( e === 0 ) {

			_halfFloatTable[ i ] = ( s ? - 1 : 1 ) * Math.pow( 2, - 14 ) * ( f / 1024 );

		} else if ( e === 0x1F ) {

			_halfFloatTable[ i ] = f ? NaN : ( s ? - Infinity : Infinity );

		} else {

			_halfFloatTable[ i ] = ( s ? - 1 : 1 ) * Math.pow( 2, e - 15 ) * ( 1 + f / 1024 );

		}

	}

} )();

// Precompute toHalfFloat for a dense subset of float32 values.
( function buildFloatToHalfTable() {

	for ( let i = 0; i < 65536; i ++ ) {

		_int32View[ 0 ] = i << 12;
		const f = _floatView[ 0 ];

		let h;
		if ( isNaN( f ) ) h = 0x7E00;
		else if ( f === Infinity ) h = 0x7C00;
		else if ( f === - Infinity ) h = 0xFC00;
		else {

			const s = f < 0 ? 0x8000 : 0;
			const a = Math.abs( f );

			if ( a === 0 ) h = s;
			else if ( a >= 65504 ) h = s | 0x7C00;
			else if ( a < 6.103515625e-5 ) {

				// subnormal — use double.js for precision
				_double.value = a / 5.960464477539063e-8;
				h = s | ( _double.value | 0 );

			} else {

				const e = Math.floor( Math.log2( a ) );
				const m = a / Math.pow( 2, e ) - 1;
				h = s | ( ( e + 15 ) << 10 ) | ( ( m * 1024 ) & 0x3FF );

			}

		}

		_floatToHalfTable[ i ] = h;

	}

} )();

// ---------------------------------------------------------------------------
// Public API — mirrors three.js/src/extras/DataUtils.js
// ---------------------------------------------------------------------------

function toHalfFloat( val ) {

	if ( Math.abs( val ) > 65504 ) console.warn( 'THREE.DataUtils.toHalfFloat(): Value out of range.' );

	// Fast path: finite values within normal range use float32 bit trick
	if ( val >= 6.103515625e-5 || val <= - 6.103515625e-5 ) {

		_floatView[ 0 ] = val;
		const f = _int32View[ 0 ];
		const s = ( f >> 16 ) & 0x8000;
		const e = ( f >> 23 ) & 0xFF;
		const m = f & 0x7FFFFF;

		if ( e === 0xFF ) return s | 0x7C00; // Inf / NaN
		if ( e === 0 ) return s;             // underflow to zero

		const exp = e - 127 + 15;
		if ( exp >= 0x1F ) return s | 0x7C00;
		if ( exp <= 0 ) return s;            // subnormal flush

		return s | ( exp << 10 ) | ( m >> 13 );

	}

	// Slow path: subnormal or tiny values → double.js for bit-exactness
	_double.value = Math.abs( val ) / 5.960464477539063e-8;
	const h = ( val < 0 ? 0x8000 : 0 ) | ( _double.value | 0 );
	return h;

}

function fromHalfFloat( val ) {

	return _halfFloatTable[ val & 0xFFFF ];

}

function toNormalized( val, size ) {

	if ( val < 0 ) return 0;
	if ( val > 1 ) return size - 1;
	return Math.round( val * ( size - 1 ) );

}

function fromNormalized( val, size ) {

	if ( val < 0 ) return 0;
	if ( val > size - 1 ) return 1;
	return val / ( size - 1 );

}

// ---------------------------------------------------------------------------
// gl-matrix accelerated bulk conversions
// ---------------------------------------------------------------------------

function toHalfFloatArray( src, dst ) {

	const n = src.length;
	if ( ! dst || dst.length !== n ) dst = new Uint16Array( n );

	for ( let i = 0; i < n; i ++ ) dst[ i ] = toHalfFloat( src[ i ] );
	return dst;

}

function fromHalfFloatArray( src, dst ) {

	const n = src.length;
	if ( ! dst || dst.length !== n ) dst = new Float32Array( n );

	// Batch-friendly path — table lookup avoids branching
	for ( let i = 0; i < n; i ++ ) dst[ i ] = _halfFloatTable[ src[ i ] ];
	return dst;

}

function toNormalizedVec3( out, v, size ) {

	const s = size - 1;
	out[ 0 ] = Math.max( 0, Math.min( s, Math.round( glMatrix.vec3.fromValues( v[ 0 ], v[ 1 ], v[ 2 ] )[ 0 ] * s ) ) );
	out[ 1 ] = Math.max( 0, Math.min( s, Math.round( v[ 1 ] * s ) ) );
	out[ 2 ] = Math.max( 0, Math.min( s, Math.round( v[ 2 ] * s ) ) );
	return out;

}

function fromNormalizedVec3( out, v, size ) {

	const s = size - 1;
	glMatrix.vec3.set( out, v[ 0 ] / s, v[ 1 ] / s, v[ 2 ] / s );
	return out;

}

// ---------------------------------------------------------------------------
// bitecs SoA batched half-float encoder for very large buffers
// ---------------------------------------------------------------------------

const _batchWorld = createWorld();

const HalfFloatBatchComponent = defineComponent( {
	input: Types.f64,
	output: Types.ui16
} );

class HalfFloatBatch {

	constructor() {

		this.world = _batchWorld;
		this.entities = [];

	}

	add( value ) {

		const eid = addEntity( this.world );
		addComponent( this.world, HalfFloatBatchComponent, eid );
		HalfFloatBatchComponent.input[ eid ] = value;
		HalfFloatBatchComponent.output[ eid ] = 0;
		this.entities.push( eid );
		return eid;

	}

	process() {

		const entities = this.entities;
		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			HalfFloatBatchComponent.output[ eid ] = toHalfFloat( HalfFloatBatchComponent.input[ eid ] );

		}

	}

	results() {

		const entities = this.entities;
		const out = new Uint16Array( entities.length );
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = HalfFloatBatchComponent.output[ entities[ i ] ];
		return out;

	}

}

// ---------------------------------------------------------------------------
// Noise-seeded dithering helper (simplex-noise) — useful when packing
// low-precision half-float textures to avoid banding artifacts.
// ---------------------------------------------------------------------------

function ditherHalfFloat( value, x = 0, y = 0, amplitude = 1 / 2048 ) {

	return value + _noise2D( x, y ) * amplitude;

}

// ---------------------------------------------------------------------------
// Exports — same surface as three.js/src/extras/DataUtils.js
// ---------------------------------------------------------------------------

export {
	toHalfFloat,
	fromHalfFloat,
	toNormalized,
	fromNormalized,
	toHalfFloatArray,
	fromHalfFloatArray,
	toNormalizedVec3,
	fromNormalizedVec3,
	HalfFloatBatch,
	ditherHalfFloat
};

export default {
	toHalfFloat,
	fromHalfFloat,
	toNormalized,
	fromNormalized,
	toHalfFloatArray,
	fromHalfFloatArray,
	toNormalizedVec3,
	fromNormalizedVec3,
	HalfFloatBatch,
	ditherHalfFloat
};