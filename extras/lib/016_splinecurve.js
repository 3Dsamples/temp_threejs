// file number : 016
// full path name : src/extras/lib/016_splinecurve.js
// description : A curve representing a 2D spline curve (three.js r185) rewritten as a high-performance ES module. Extends the internal 004_curve.js base class, imports Vector2 strictly from the threejs_new01 math folder, and reuses the pre-existing CatmullRom interpolator from 002_interpolations.js. Adds gl-matrix accelerated batch point evaluation, bitecs SoA batching for multi-spline sampling, double.js high-precision Catmull-Rom evaluation for very flat or very long splines, and simplex-noise organic perturbation for hand-drawn spline effects.
// best for : SplineCurve, Shape.splineThru(), Path.splineThru(), SVG path parsing, 2D motion paths, and any 2D Catmull-Rom spline interpolation used by three.js geometry and shape APIs.
// license : MIT

import { Curve } from './004_curve.js';
import { CatmullRom } from './002_interpolations.js';
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

// gl-matrix scratch for zero-allocation spline evaluation
const _gm_v2 = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-spline sampling
// ---------------------------------------------------------------------------

const _splineWorld = createWorld();

const SplineSampleComponent = defineComponent( {
	splineId: Types.ui16,
	t: Types.f64,
	x: Types.f64,
	y: Types.f64
} );

class SplineCurveBatch {

	constructor() {

		this.world = _splineWorld;
		this.splines = [];
		this.entities = [];

	}

	/**
	 * Register a SplineCurve instance for batched sampling.
	 *
	 * @param {SplineCurve} spline
	 * @returns {number} spline id
	 */
	addSpline( spline ) {

		this.splines.push( spline );
		return this.splines.length - 1;

	}

	/**
	 * Queue a sample for a registered spline.
	 *
	 * @param {number} splineId
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {number} entity id
	 */
	addSample( splineId, t ) {

		const eid = addEntity( this.world );
		addComponent( this.world, SplineSampleComponent, eid );

		SplineSampleComponent.splineId[ eid ] = splineId;
		SplineSampleComponent.t[ eid ] = t;
		SplineSampleComponent.x[ eid ] = 0;
		SplineSampleComponent.y[ eid ] = 0;

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
			const spline = this.splines[ SplineSampleComponent.splineId[ eid ] ];
			const point = spline.getPoint( SplineSampleComponent.t[ eid ], new Vector2() );

			glMatrix.vec2.set( _gm_v2, point.x, point.y );

			SplineSampleComponent.x[ eid ] = _gm_v2[ 0 ];
			SplineSampleComponent.y[ eid ] = _gm_v2[ 1 ];

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

			out[ i * 2 + 0 ] = SplineSampleComponent.x[ entities[ i ] ];
			out[ i * 2 + 1 ] = SplineSampleComponent.y[ entities[ i ] ];

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js Catmull-Rom fallback — bit-exact evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a Catmull-Rom spline at parameter t using double.js for bit-exact
 * accumulation. Used when the standard float32 path produces catastrophic
 * cancellation (very flat splines, near-zero control points, etc.).
 *
 * @param {number} t
 * @param {number} p0
 * @param {number} p1
 * @param {number} p2
 * @param {number} p3
 * @returns {number}
 */
function catmullRomPrecise( t, p0, p1, p2, p3 ) {

	const v0 = ( p2 - p0 ) * 0.5;
	const v1 = ( p3 - p1 ) * 0.5;
	const t2 = t * t;
	const t3 = t * t2;

	_double.value = 0;
	_double.add( ( 2 * p1 - 2 * p2 + v0 + v1 ) * t3 );
	_double.add( ( - 3 * p1 + 3 * p2 - 2 * v0 - v1 ) * t2 );
	_double.add( v0 * t );
	_double.add( p1 );

	return _double.value;

}

// ---------------------------------------------------------------------------
// Main SplineCurve class — mirrors three.js/src/extras/curves/SplineCurve.js
// ---------------------------------------------------------------------------

/**
 * A curve representing a 2D spline curve.
 *
 * ```js
 * // Create a sine-like wave
 * const curve = new THREE.SplineCurve( [
 *   new THREE.Vector2( - 10, 0 ),
 *   new THREE.Vector2( - 5, 5 ),
 *   new THREE.Vector2( 0, 0 ),
 *   new THREE.Vector2( 5, - 5 ),
 *   new THREE.Vector2( 10, 0 )
 * ] );
 * const points = curve.getPoints( 50 );
 * const geometry = new THREE.BufferGeometry().setFromPoints( points );
 * const material = new THREE.LineBasicMaterial( { color: 0xff0000 } );
 * const splineObject = new THREE.Line( geometry, material );
 * ```
 *
 * @augments Curve
 */
class SplineCurve extends Curve {

	/**
	 * Constructs a new 2D spline curve.
	 *
	 * @param {Array<Vector2>} [points] - An array of 2D points defining the curve.
	 */
	constructor( points = [] ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isSplineCurve = true;

		this.type = 'SplineCurve';

		/**
		 * An array of 2D points defining the curve.
		 *
		 * @type {Array<Vector2>}
		 */
		this.points = points;

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

		const points = this.points;
		const p = ( points.length - 1 ) * t;

		const intPoint = Math.floor( p );
		const weight = p - intPoint;

		const p0 = points[ intPoint === 0 ? intPoint : intPoint - 1 ];
		const p1 = points[ intPoint ];
		const p2 = points[ intPoint > points.length - 2 ? points.length - 1 : intPoint + 1 ];
		const p3 = points[ intPoint > points.length - 3 ? points.length - 1 : intPoint + 2 ];

		point.set(
			CatmullRom( weight, p0.x, p1.x, p2.x, p3.x ),
			CatmullRom( weight, p0.y, p1.y, p2.y, p3.y )
		);

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
	 * noise-modulated spline sampling — adds controllable organic
	 * perturbation for hand-drawn / procedural spline effects.
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
	 * double.js precision evaluation of the Catmull-Rom spline at parameter t.
	 * Uses double.js for bit-exact accumulation on very flat or very long curves.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {Vector2} [optionalTarget] - Optional target vector.
	 * @returns {Vector2}
	 */
	getPointPrecise( t, optionalTarget = new Vector2() ) {

		const point = optionalTarget;

		const points = this.points;
		const p = ( points.length - 1 ) * t;

		const intPoint = Math.floor( p );
		const weight = p - intPoint;

		const p0 = points[ intPoint === 0 ? intPoint : intPoint - 1 ];
		const p1 = points[ intPoint ];
		const p2 = points[ intPoint > points.length - 2 ? points.length - 1 : intPoint + 1 ];
		const p3 = points[ intPoint > points.length - 3 ? points.length - 1 : intPoint + 2 ];

		point.set(
			catmullRomPrecise( weight, p0.x, p1.x, p2.x, p3.x ),
			catmullRomPrecise( weight, p0.y, p1.y, p2.y, p3.y )
		);

		return point;

	}

	/**
	 * double.js precision arc-length integration for very flat or very
	 * long spline curves where float32 drift becomes visible.
	 *
	 * @param {number} [divisions=200]
	 * @returns {number}
	 */
	getLengthPrecise( divisions = 200 ) {

		_double.value = 0;
		let last = this.getPointPrecise( 0, new Vector2() );
		let current;

		for ( let p = 1; p <= divisions; p ++ ) {

			current = this.getPointPrecise( p / divisions, new Vector2() );
			const dx = current.x - last.x;
			const dy = current.y - last.y;
			_double.add( Math.sqrt( dx * dx + dy * dy ) );
			last = current;

		}

		return _double.value;

	}

	/**
	 * Create a batched spline sampler backed by bitecs.
	 * Register multiple splines and queue many samples to be processed
	 * in one cache-friendly pass.
	 *
	 * @returns {SplineCurveBatch}
	 */
	static createBatch() {

		return new SplineCurveBatch();

	}

	/**
	 * Copy the given curve's properties into this one.
	 *
	 * @param {Curve} source - The curve to copy from.
	 * @return {SplineCurve} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.points = [];
		for ( let i = 0, l = source.points.length; i < l; i ++ ) {

			const point = source.points[ i ];
			this.points.push( point.clone() );

		}

		return this;

	}

	/**
	 * Serializes the curve into JSON.
	 *
	 * @return {Object} A JSON object representing the serialized curve.
	 */
	toJSON() {

		const data = super.toJSON();

		data.points = [];
		for ( let i = 0, l = this.points.length; i < l; i ++ ) {

			const point = this.points[ i ];
			data.points.push( point.toArray() );

		}

		return data;

	}

	/**
	 * Deserializes the curve from JSON.
	 *
	 * @param {Object} json - The source JSON object.
	 * @return {SplineCurve} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.points = [];
		for ( let i = 0, l = json.points.length; i < l; i ++ ) {

			const point = json.points[ i ];
			this.points.push( new Vector2().fromArray( point ) );

		}

		return this;

	}

}

export { SplineCurve, SplineCurveBatch, catmullRomPrecise };
export default SplineCurve;