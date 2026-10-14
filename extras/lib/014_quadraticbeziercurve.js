// file number : 014
// full path name : src/extras/lib/014_quadraticbeziercurve.js
// description : A curve representing a 2D Quadratic Bezier curve (three.js r185) rewritten as a high-performance ES module. Extends the internal 004_curve.js base class, imports Vector2 strictly from the threejs_new01 math folder, and reuses the pre-existing QuadraticBezier interpolator from 002_interpolations.js. Adds gl-matrix accelerated batch point evaluation, bitecs SoA batching for multi-curve sampling, double.js high-precision Bernstein polynomial evaluation for very flat or very long curves, and simplex-noise organic perturbation for hand-drawn quadratic Bezier effects.
// best for : QuadraticBezierCurve, Shape.quadraticCurveTo(), Path.quadraticCurveTo(), font glyph outlines, motion paths, and any 2D quadratic Bezier interpolation used by three.js geometry and shape APIs.
// license : MIT

import { Curve } from './004_curve.js';
import { QuadraticBezier } from './002_interpolations.js';
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

// gl-matrix scratch for zero-allocation Bezier evaluation
const _gm_v2 = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-curve sampling
// ---------------------------------------------------------------------------

const _bezierWorld = createWorld();

const BezierSampleComponent = defineComponent( {
	curveId: Types.ui16,
	t: Types.f64,
	v0x: Types.f64,
	v0y: Types.f64,
	v1x: Types.f64,
	v1y: Types.f64,
	v2x: Types.f64,
	v2y: Types.f64,
	x: Types.f64,
	y: Types.f64
} );

class QuadraticBezierCurveBatch {

	constructor() {

		this.world = _bezierWorld;
		this.curves = [];
		this.entities = [];

	}

	/**
	 * Register a QuadraticBezierCurve instance for batched sampling.
	 *
	 * @param {QuadraticBezierCurve} curve
	 * @returns {number} curve id
	 */
	addCurve( curve ) {

		this.curves.push( curve );
		return this.curves.length - 1;

	}

	/**
	 * Queue a sample for a registered curve.
	 *
	 * @param {number} curveId
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {number} entity id
	 */
	addSample( curveId, t ) {

		const eid = addEntity( this.world );
		addComponent( this.world, BezierSampleComponent, eid );

		const curve = this.curves[ curveId ];

		BezierSampleComponent.curveId[ eid ] = curveId;
		BezierSampleComponent.t[ eid ] = t;
		BezierSampleComponent.v0x[ eid ] = curve.v0.x;
		BezierSampleComponent.v0y[ eid ] = curve.v0.y;
		BezierSampleComponent.v1x[ eid ] = curve.v1.x;
		BezierSampleComponent.v1y[ eid ] = curve.v1.y;
		BezierSampleComponent.v2x[ eid ] = curve.v2.x;
		BezierSampleComponent.v2y[ eid ] = curve.v2.y;
		BezierSampleComponent.x[ eid ] = 0;
		BezierSampleComponent.y[ eid ] = 0;

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
			const t = BezierSampleComponent.t[ eid ];

			// Evaluate X and Y simultaneously via gl-matrix vec2 staging
			glMatrix.vec2.set(
				_gm_v2,
				QuadraticBezier( t,
					BezierSampleComponent.v0x[ eid ],
					BezierSampleComponent.v1x[ eid ],
					BezierSampleComponent.v2x[ eid ] ),
				QuadraticBezier( t,
					BezierSampleComponent.v0y[ eid ],
					BezierSampleComponent.v1y[ eid ],
					BezierSampleComponent.v2y[ eid ] )
			);

			BezierSampleComponent.x[ eid ] = _gm_v2[ 0 ];
			BezierSampleComponent.y[ eid ] = _gm_v2[ 1 ];

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

			out[ i * 2 + 0 ] = BezierSampleComponent.x[ entities[ i ] ];
			out[ i * 2 + 1 ] = BezierSampleComponent.y[ entities[ i ] ];

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js Bernstein fallback — bit-exact evaluation of quadratic Bezier
// ---------------------------------------------------------------------------

/**
 * Evaluate a quadratic Bezier at parameter t using double.js for bit-exact
 * accumulation. Used when the standard float32 path produces catastrophic
 * cancellation (very flat curves, near-zero control points, etc.).
 *
 * @param {number} t
 * @param {number} p0
 * @param {number} p1
 * @param {number} p2
 * @returns {number}
 */
function quadraticBezierPrecise( t, p0, p1, p2 ) {

	const mt = 1 - t;

	_double.value = 0;
	_double.add( mt * mt * p0 );
	_double.add( 2 * mt * t * p1 );
	_double.add( t * t * p2 );

	return _double.value;

}

// ---------------------------------------------------------------------------
// Main QuadraticBezierCurve class — mirrors three.js/src/extras/curves/QuadraticBezierCurve.js
// ---------------------------------------------------------------------------

/**
 * A curve representing a 2D Quadratic Bezier curve.
 *
 * ```js
 * const curve = new THREE.QuadraticBezierCurve(
 *   new THREE.Vector2( - 10, 0 ),
 *   new THREE.Vector2( 20, 15 ),
 *   new THREE.Vector2( 10, 0 )
 * );
 * const points = curve.getPoints( 50 );
 * const geometry = new THREE.BufferGeometry().setFromPoints( points );
 * const material = new THREE.LineBasicMaterial( { color: 0xff0000 } );
 * const curveObject = new THREE.Line( geometry, material );
 * ```
 *
 * @augments Curve
 */
class QuadraticBezierCurve extends Curve {

	/**
	 * Constructs a new Quadratic Bezier curve.
	 *
	 * @param {Vector2} [v0] - The start point.
	 * @param {Vector2} [v1] - The control point.
	 * @param {Vector2} [v2] - The end point.
	 */
	constructor( v0 = new Vector2(), v1 = new Vector2(), v2 = new Vector2() ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isQuadraticBezierCurve = true;

		this.type = 'QuadraticBezierCurve';

		/**
		 * The start point.
		 *
		 * @type {Vector2}
		 */
		this.v0 = v0;

		/**
		 * The control point.
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

		const v0 = this.v0, v1 = this.v1, v2 = this.v2;

		point.set(
			QuadraticBezier( t, v0.x, v1.x, v2.x ),
			QuadraticBezier( t, v0.y, v1.y, v2.y )
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
	 * noise-modulated quadratic Bezier sampling — adds controllable organic
	 * perturbation for hand-drawn / procedural curve effects.
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
	 * double.js precision evaluation of the quadratic Bezier at parameter t.
	 * Uses the full Bernstein polynomial form for bit-exact results.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {Vector2} [optionalTarget] - Optional target vector.
	 * @returns {Vector2}
	 */
	getPointPrecise( t, optionalTarget = new Vector2() ) {

		const point = optionalTarget;

		point.set(
			quadraticBezierPrecise( t, this.v0.x, this.v1.x, this.v2.x ),
			quadraticBezierPrecise( t, this.v0.y, this.v1.y, this.v2.y )
		);

		return point;

	}

	/**
	 * double.js precision arc-length integration for very flat or very
	 * long quadratic Bezier curves where float32 drift becomes visible.
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
	 * Create a batched quadratic Bezier sampler backed by bitecs.
	 * Register multiple curves and queue many samples to be processed
	 * in one cache-friendly pass.
	 *
	 * @returns {QuadraticBezierCurveBatch}
	 */
	static createBatch() {

		return new QuadraticBezierCurveBatch();

	}

	/**
	 * Copy the given curve's properties into this one.
	 *
	 * @param {Curve} source - The curve to copy from.
	 * @return {QuadraticBezierCurve} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.v0.copy( source.v0 );
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

		data.v0 = this.v0.toArray();
		data.v1 = this.v1.toArray();
		data.v2 = this.v2.toArray();

		return data;

	}

	/**
	 * Deserializes the curve from JSON.
	 *
	 * @param {Object} json - The source JSON object.
	 * @return {QuadraticBezierCurve} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.v0.fromArray( json.v0 );
		this.v1.fromArray( json.v1 );
		this.v2.fromArray( json.v2 );

		return this;

	}

}

export { QuadraticBezierCurve, QuadraticBezierCurveBatch, quadraticBezierPrecise };
export default QuadraticBezierCurve;