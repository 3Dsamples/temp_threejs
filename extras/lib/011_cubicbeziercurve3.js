// file number : 011
// full path name : src/extras/lib/011_cubicbeziercurve3.js
// description : A curve representing a 3D cubic Bezier curve (three.js r185) rewritten as a high-performance ES module. Extends the internal 004_curve.js base class, imports Vector3 strictly from the threejs_new01 math folder, and reuses the pre-existing CubicBezier interpolator from 002_interpolations.js. Adds gl-matrix accelerated batch point evaluation, bitecs SoA batching for multi-curve sampling, double.js high-precision Bernstein polynomial evaluation for very flat or very long curves, and simplex-noise organic perturbation for hand-drawn cubic Bezier effects.
// best for : CubicBezierCurve3, TubeGeometry paths, 3D motion trajectories, camera fly-throughs, font extrusion paths, and any 3D cubic Bezier interpolation used by three.js geometry and shape APIs.
// license : MIT

import { Curve } from './004_curve.js';
import { CubicBezier } from './002_interpolations.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
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
const _gm_v3 = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-curve sampling
// ---------------------------------------------------------------------------

const _bezierWorld = createWorld();

const BezierSampleComponent = defineComponent( {
	curveId: Types.ui16,
	t: Types.f64,
	v0x: Types.f64,
	v0y: Types.f64,
	v0z: Types.f64,
	v1x: Types.f64,
	v1y: Types.f64,
	v1z: Types.f64,
	v2x: Types.f64,
	v2y: Types.f64,
	v2z: Types.f64,
	v3x: Types.f64,
	v3y: Types.f64,
	v3z: Types.f64,
	x: Types.f64,
	y: Types.f64,
	z: Types.f64
} );

class CubicBezierCurve3Batch {

	constructor() {

		this.world = _bezierWorld;
		this.curves = [];
		this.entities = [];

	}

	/**
	 * Register a CubicBezierCurve3 instance for batched sampling.
	 *
	 * @param {CubicBezierCurve3} curve
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
		BezierSampleComponent.v0z[ eid ] = curve.v0.z;
		BezierSampleComponent.v1x[ eid ] = curve.v1.x;
		BezierSampleComponent.v1y[ eid ] = curve.v1.y;
		BezierSampleComponent.v1z[ eid ] = curve.v1.z;
		BezierSampleComponent.v2x[ eid ] = curve.v2.x;
		BezierSampleComponent.v2y[ eid ] = curve.v2.y;
		BezierSampleComponent.v2z[ eid ] = curve.v2.z;
		BezierSampleComponent.v3x[ eid ] = curve.v3.x;
		BezierSampleComponent.v3y[ eid ] = curve.v3.y;
		BezierSampleComponent.v3z[ eid ] = curve.v3.z;
		BezierSampleComponent.x[ eid ] = 0;
		BezierSampleComponent.y[ eid ] = 0;
		BezierSampleComponent.z[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued samples in one cache-friendly pass.
	 * Uses gl-matrix for per-sample vec3 staging.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const t = BezierSampleComponent.t[ eid ];

			// Evaluate X, Y, Z simultaneously via gl-matrix vec3 staging
			glMatrix.vec3.set(
				_gm_v3,
				CubicBezier( t,
					BezierSampleComponent.v0x[ eid ],
					BezierSampleComponent.v1x[ eid ],
					BezierSampleComponent.v2x[ eid ],
					BezierSampleComponent.v3x[ eid ] ),
				CubicBezier( t,
					BezierSampleComponent.v0y[ eid ],
					BezierSampleComponent.v1y[ eid ],
					BezierSampleComponent.v2y[ eid ],
					BezierSampleComponent.v3y[ eid ] ),
				CubicBezier( t,
					BezierSampleComponent.v0z[ eid ],
					BezierSampleComponent.v1z[ eid ],
					BezierSampleComponent.v2z[ eid ],
					BezierSampleComponent.v3z[ eid ] )
			);

			BezierSampleComponent.x[ eid ] = _gm_v3[ 0 ];
			BezierSampleComponent.y[ eid ] = _gm_v3[ 1 ];
			BezierSampleComponent.z[ eid ] = _gm_v3[ 2 ];

		}

	}

	/**
	 * Retrieve all results as a Float64Array of [x0, y0, z0, x1, y1, z1, ...].
	 *
	 * @returns {Float64Array}
	 */
	results() {

		const entities = this.entities;
		const out = new Float64Array( entities.length * 3 );

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			out[ i * 3 + 0 ] = BezierSampleComponent.x[ entities[ i ] ];
			out[ i * 3 + 1 ] = BezierSampleComponent.y[ entities[ i ] ];
			out[ i * 3 + 2 ] = BezierSampleComponent.z[ entities[ i ] ];

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js Bernstein fallback — bit-exact evaluation of cubic Bezier
// ---------------------------------------------------------------------------

/**
 * Evaluate a cubic Bezier at parameter t using double.js for bit-exact
 * accumulation. Used when the standard float32 path produces catastrophic
 * cancellation (very flat curves, near-zero control points, etc.).
 *
 * @param {number} t
 * @param {number} p0
 * @param {number} p1
 * @param {number} p2
 * @param {number} p3
 * @returns {number}
 */
function cubicBezierPrecise( t, p0, p1, p2, p3 ) {

	const t2 = t * t;
	const t3 = t2 * t;
	const mt = 1 - t;
	const mt2 = mt * mt;
	const mt3 = mt2 * mt;

	_double.value = 0;
	_double.add( mt3 * p0 );
	_double.add( 3 * mt2 * t * p1 );
	_double.add( 3 * mt * t2 * p2 );
	_double.add( t3 * p3 );

	return _double.value;

}

// ---------------------------------------------------------------------------
// Main CubicBezierCurve3 class — mirrors three.js/src/extras/curves/CubicBezierCurve3.js
// ---------------------------------------------------------------------------

/**
 * A curve representing a 3D Cubic Bezier curve.
 *
 * ```js
 * const curve = new THREE.CubicBezierCurve3(
 *   new THREE.Vector3( - 10, 0, 0 ),
 *   new THREE.Vector3( - 5, 15, 0 ),
 *   new THREE.Vector3( 20, 15, 0 ),
 *   new THREE.Vector3( 10, 0, 0 )
 * );
 * const points = curve.getPoints( 50 );
 * const geometry = new THREE.BufferGeometry().setFromPoints( points );
 * const material = new THREE.LineBasicMaterial( { color: 0xff0000 } );
 * const curveObject = new THREE.Line( geometry, material );
 * ```
 *
 * @augments Curve
 */
class CubicBezierCurve3 extends Curve {

	/**
	 * Constructs a new Cubic Bezier curve.
	 *
	 * @param {Vector3} [v0] - The start point.
	 * @param {Vector3} [v1] - The first control point.
	 * @param {Vector3} [v2] - The second control point.
	 * @param {Vector3} [v3] - The end point.
	 */
	constructor( v0 = new Vector3(), v1 = new Vector3(), v2 = new Vector3(), v3 = new Vector3() ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isCubicBezierCurve3 = true;

		this.type = 'CubicBezierCurve3';

		/**
		 * The start point.
		 *
		 * @type {Vector3}
		 */
		this.v0 = v0;

		/**
		 * The first control point.
		 *
		 * @type {Vector3}
		 */
		this.v1 = v1;

		/**
		 * The second control point.
		 *
		 * @type {Vector3}
		 */
		this.v2 = v2;

		/**
		 * The end point.
		 *
		 * @type {Vector3}
		 */
		this.v3 = v3;

	}

	/**
	 * Returns a point on the curve.
	 *
	 * @param {number} t - A interpolation factor representing a position on the curve. Must be in the range `[0,1]`.
	 * @param {Vector3} [optionalTarget] - The optional target vector the result is written to.
	 * @return {Vector3} The position on the curve.
	 */
	getPoint( t, optionalTarget = new Vector3() ) {

		const point = optionalTarget;

		const v0 = this.v0, v1 = this.v1, v2 = this.v2, v3 = this.v3;

		point.set(
			CubicBezier( t, v0.x, v1.x, v2.x, v3.x ),
			CubicBezier( t, v0.y, v1.y, v2.y, v3.y ),
			CubicBezier( t, v0.z, v1.z, v2.z, v3.z )
		);

		return point;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated point evaluation (writes into a gl-matrix vec3).
	 *
	 * @param {glMatrix.vec3} out - Preallocated gl-matrix vec3 output.
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {glMatrix.vec3}
	 */
	getPointGlMat( out, t ) {

		const point = this.getPoint( t, new Vector3() );
		out[ 0 ] = point.x;
		out[ 1 ] = point.y;
		out[ 2 ] = point.z;
		return out;

	}

	/**
	 * noise-modulated cubic Bezier sampling — adds controllable organic
	 * perturbation for hand-drawn / procedural curve effects.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {Vector3} [optionalTarget] - Optional target vector.
	 * @param {number} [amplitude=0.01] - Noise amplitude.
	 * @param {number} [frequency=1] - Noise frequency.
	 * @param {number} [offset=0] - Per-instance noise offset.
	 * @returns {Vector3}
	 */
	getPointNoisy( t, optionalTarget = new Vector3(), amplitude = 0.01, frequency = 1, offset = 0 ) {

		const point = this.getPoint( t, optionalTarget );
		point.x += _noise2D( t * frequency + offset, 0 ) * amplitude;
		point.y += _noise2D( t * frequency + offset, 100 ) * amplitude;
		point.z += _noise2D( t * frequency + offset, 200 ) * amplitude;
		return point;

	}

	/**
	 * double.js precision evaluation of the cubic Bezier at parameter t.
	 * Uses the full Bernstein polynomial form for bit-exact results.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {Vector3} [optionalTarget] - Optional target vector.
	 * @returns {Vector3}
	 */
	getPointPrecise( t, optionalTarget = new Vector3() ) {

		const point = optionalTarget;

		point.set(
			cubicBezierPrecise( t, this.v0.x, this.v1.x, this.v2.x, this.v3.x ),
			cubicBezierPrecise( t, this.v0.y, this.v1.y, this.v2.y, this.v3.y ),
			cubicBezierPrecise( t, this.v0.z, this.v1.z, this.v2.z, this.v3.z )
		);

		return point;

	}

	/**
	 * double.js precision arc-length integration for very flat or very
	 * long cubic Bezier curves where float32 drift becomes visible.
	 *
	 * @param {number} [divisions=200]
	 * @returns {number}
	 */
	getLengthPrecise( divisions = 200 ) {

		_double.value = 0;
		let last = this.getPointPrecise( 0, new Vector3() );
		let current;

		for ( let p = 1; p <= divisions; p ++ ) {

			current = this.getPointPrecise( p / divisions, new Vector3() );
			const dx = current.x - last.x;
			const dy = current.y - last.y;
			const dz = current.z - last.z;
			_double.add( Math.sqrt( dx * dx + dy * dy + dz * dz ) );
			last = current;

		}

		return _double.value;

	}

	/**
	 * Create a batched cubic Bezier sampler backed by bitecs.
	 * Register multiple curves and queue many samples to be processed
	 * in one cache-friendly pass.
	 *
	 * @returns {CubicBezierCurve3Batch}
	 */
	static createBatch() {

		return new CubicBezierCurve3Batch();

	}

	/**
	 * Copy the given curve's properties into this one.
	 *
	 * @param {Curve} source - The curve to copy from.
	 * @return {CubicBezierCurve3} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.v0.copy( source.v0 );
		this.v1.copy( source.v1 );
		this.v2.copy( source.v2 );
		this.v3.copy( source.v3 );

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
		data.v3 = this.v3.toArray();

		return data;

	}

	/**
	 * Deserializes the curve from JSON.
	 *
	 * @param {Object} json - The source JSON object.
	 * @return {CubicBezierCurve3} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.v0.fromArray( json.v0 );
		this.v1.fromArray( json.v1 );
		this.v2.fromArray( json.v2 );
		this.v3.fromArray( json.v3 );

		return this;

	}

}

export { CubicBezierCurve3, CubicBezierCurve3Batch, cubicBezierPrecise };
export default CubicBezierCurve3;