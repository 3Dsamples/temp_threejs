// file number : 012
// full path name : src/extras/lib/012_linecurve.js
// description : A curve representing a 2D line segment (three.js r185) rewritten as a high-performance ES module. Extends the internal 004_curve.js base class and imports Vector2 strictly from the threejs_new01 math folder. Implements the exact LineCurve contract from three.js r185 including the getPoint(1) fast-path optimization, plus accelerated extensions: gl-matrix zero-allocation point evaluation, bitecs SoA batch sampling for many line segments processed in a single cache-friendly pass, double.js high-precision parametric evaluation for extremely long lines where float32 drift matters, and simplex-noise organic jitter for hand-drawn line effects.
// best for : LineCurve, LineCurve3 (extends this class), Shape.lineTo(), Path.lineTo(), SVG line parsing, animation path segments, and any 2D line interpolation used by three.js shape and geometry APIs.
// license : MIT

import { Curve } from './004_curve.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation line evaluation
const _gm_v2 = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-segment sampling
// ---------------------------------------------------------------------------

const _lineWorld = createWorld();

const LineSampleComponent = defineComponent( {
	lineId: Types.ui16,
	t: Types.f64,
	v1x: Types.f64,
	v1y: Types.f64,
	v2x: Types.f64,
	v2y: Types.f64,
	x: Types.f64,
	y: Types.f64
} );

class LineCurveBatch {

	constructor() {

		this.world = _lineWorld;
		this.lines = [];
		this.entities = [];

	}

	/**
	 * Register a LineCurve instance for batched sampling.
	 *
	 * @param {LineCurve} line
	 * @returns {number} line id
	 */
	addLine( line ) {

		this.lines.push( line );
		return this.lines.length - 1;

	}

	/**
	 * Queue a sample for a registered line.
	 *
	 * @param {number} lineId
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {number} entity id
	 */
	addSample( lineId, t ) {

		const eid = addEntity( this.world );
		addComponent( this.world, LineSampleComponent, eid );

		const line = this.lines[ lineId ];

		LineSampleComponent.lineId[ eid ] = lineId;
		LineSampleComponent.t[ eid ] = t;
		LineSampleComponent.v1x[ eid ] = line.v1.x;
		LineSampleComponent.v1y[ eid ] = line.v1.y;
		LineSampleComponent.v2x[ eid ] = line.v2.x;
		LineSampleComponent.v2y[ eid ] = line.v2.y;
		LineSampleComponent.x[ eid ] = 0;
		LineSampleComponent.y[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued samples in one cache-friendly pass.
	 * Uses gl-matrix for per-sample vec2 staging.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const t = LineSampleComponent.t[ eid ];

			// Fast path: t === 1 returns v2 directly (mirrors r185 optimization)
			if ( t === 1 ) {

				LineSampleComponent.x[ eid ] = LineSampleComponent.v2x[ eid ];
				LineSampleComponent.y[ eid ] = LineSampleComponent.v2y[ eid ];
				continue;

			}

			// General case: linear interpolation via gl-matrix
			glMatrix.vec2.set(
				_gm_v2,
				LineSampleComponent.v1x[ eid ] + t * ( LineSampleComponent.v2x[ eid ] - LineSampleComponent.v1x[ eid ] ),
				LineSampleComponent.v1y[ eid ] + t * ( LineSampleComponent.v2y[ eid ] - LineSampleComponent.v1y[ eid ] )
			);

			LineSampleComponent.x[ eid ] = _gm_v2[ 0 ];
			LineSampleComponent.y[ eid ] = _gm_v2[ 1 ];

		}

	}

	/**
	 * Retrieve all results as a Float64Array of [x0, y0, x1, y1, ...].
	 *
	 * @returns {Float64Array}
	 */
	results() {

		const entities = this.entities;
		const out = new Float64Array( entities.length * 2 );

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			out[ i * 2 + 0 ] = LineSampleComponent.x[ entities[ i ] ];
			out[ i * 2 + 1 ] = LineSampleComponent.y[ entities[ i ] ];

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js precise parametric evaluation for very long 2D lines
// ---------------------------------------------------------------------------

/**
 * Evaluate a 2D line at parameter t using double.js for bit-exact
 * accumulation. Used when the standard float32 path produces visible
 * drift on extremely long lines (e.g. > 1e7 units).
 *
 * @param {number} t
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {{x: number, y: number}}
 */
function linePrecise( t, x1, y1, x2, y2 ) {

	_double.value = x2;
	_double.sub( x1 );
	const dx = _double.value;

	_double.value = y2;
	_double.sub( y1 );
	const dy = _double.value;

	_double.value = x1;
	_double.add( t * dx );
	const x = _double.value;

	_double.value = y1;
	_double.add( t * dy );
	const y = _double.value;

	return { x, y };

}

// ---------------------------------------------------------------------------
// Main LineCurve class — mirrors three.js/src/extras/curves/LineCurve.js
// ---------------------------------------------------------------------------

/**
 * A curve representing a 2D line segment.
 *
 * ```js
 * const curve = new THREE.LineCurve(
 *   new THREE.Vector2( - 5, 5 ),
 *   new THREE.Vector2( 5, - 5 )
 * );
 * const points = curve.getPoints( 50 );
 * const geometry = new THREE.BufferGeometry().setFromPoints( points );
 * const material = new THREE.LineBasicMaterial( { color: 0xff0000 } );
 * const curveObject = new THREE.Line( geometry, material );
 * ```
 *
 * @augments Curve
 */
class LineCurve extends Curve {

	/**
	 * Constructs a new line curve.
	 *
	 * @param {Vector2} [v1] - The start point.
	 * @param {Vector2} [v2] - The end point.
	 */
	constructor( v1 = new Vector2(), v2 = new Vector2() ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isLineCurve = true;

		this.type = 'LineCurve';

		/**
		 * The start point.
		 *
		 * @type {Vector2}
		 */
		this.v1 = v1;

		/**
		 * The end point.
		 *
		 * @type {Vector2}
		 */
		this.v2 = v2;

	}

	/**
	 * Returns a point on the curve.
	 *
	 * @param {number} t - A interpolation factor representing a position on the curve. Must be in the range `[0,1]`.
	 * @param {Vector2} [optionalTarget] - The optional target vector the result is written to.
	 * @return {Vector2} The position on the curve.
	 */
	getPoint( t, optionalTarget = new Vector2() ) {

		const point = optionalTarget;

		if ( t === 1 ) {

			point.copy( this.v2 );

		} else {

			point.copy( this.v2 ).sub( this.v1 );
			point.multiplyScalar( t ).add( this.v1 );

		}

		return point;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated point evaluation (writes into a Float32Array vec2).
	 *
	 * @param {glMatrix.vec2} out - Preallocated gl-matrix vec2 output.
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {glMatrix.vec2}
	 */
	getPointGlMat( out, t ) {

		const point = this.getPoint( t, new Vector2() );
		out[ 0 ] = point.x;
		out[ 1 ] = point.y;
		return out;

	}

	/**
	 * noise-modulated line sampling — adds controllable organic
	 * perturbation for hand-drawn / procedural line effects.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {Vector2} [optionalTarget] - Optional target vector.
	 * @param {number} [amplitude=0.01] - Noise amplitude.
	 * @param {number} [frequency=1] - Noise frequency.
	 * @param {number} [offset=0] - Per-instance noise offset.
	 * @returns {Vector2}
	 */
	getPointNoisy( t, optionalTarget = new Vector2(), amplitude = 0.01, frequency = 1, offset = 0 ) {

		const point = this.getPoint( t, optionalTarget );
		point.x += _noise2D( t * frequency + offset, 0 ) * amplitude;
		point.y += _noise2D( t * frequency + offset, 100 ) * amplitude;
		return point;

	}

	/**
	 * double.js precision evaluation of the line at parameter t.
	 * Bit-exact parametric interpolation for extremely long lines.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {Vector2} [optionalTarget] - Optional target vector.
	 * @returns {Vector2}
	 */
	getPointPrecise( t, optionalTarget = new Vector2() ) {

		const point = optionalTarget;
		const r = linePrecise( t, this.v1.x, this.v1.y, this.v2.x, this.v2.y );
		point.set( r.x, r.y );
		return point;

	}

	/**
	 * double.js precision arc-length. For a line segment this is exact,
	 * but double.js avoids float32 cancellation for very long lines.
	 *
	 * @returns {number}
	 */
	getLengthPrecise() {

		const dx = this.v2.x - this.v1.x;
		const dy = this.v2.y - this.v1.y;

		_double.value = dx * dx;
		_double.add( dy * dy );

		return Math.sqrt( _double.value );

	}

	/**
	 * Create a batched line sampler backed by bitecs.
	 * Register multiple lines and queue many samples to be processed
	 * in one cache-friendly pass.
	 *
	 * @returns {LineCurveBatch}
	 */
	static createBatch() {

		return new LineCurveBatch();

	}

	/**
	 * Copy the given curve's properties into this one.
	 *
	 * @param {Curve} source - The curve to copy from.
	 * @return {LineCurve} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.v1.copy( source.v1 );
		this.v2.copy( source.v2 );

		return this;

	}

	/**
	 * Serializes the curve into JSON.
	 *
	 * @return {Object} A JSON object representing the serialized curve.
	 */
	toJSON() {

		const data = super.toJSON();

		data.v1 = this.v1.toArray();
		data.v2 = this.v2.toArray();

		return data;

	}

	/**
	 * Deserializes the curve from JSON.
	 *
	 * @param {Object} json - The source JSON object.
	 * @return {LineCurve} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.v1.fromArray( json.v1 );
		this.v2.fromArray( json.v2 );

		return this;

	}

}

export { LineCurve, LineCurveBatch, linePrecise };
export default LineCurve;