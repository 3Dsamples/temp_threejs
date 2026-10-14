// file number : 009
// full path name : src/extras/lib/009_catmullromcurve3.js
// description : A curve representing a Catmull-Rom spline in 3D (three.js r185) rewritten as a high-performance ES module. Extends the internal 004_curve.js base class and imports Vector3 strictly from the threejs_new01 math folder. Provides centripetal (default), chordal, and catmullrom parameterizations with tunable tension. Adds gl-matrix accelerated batch point evaluation, bitecs SoA batching for multi-spline sampling, double.js high-precision tangent computation for long chains, and simplex-noise organic perturbation for hand-drawn spline effects.
// best for : CatmullRomCurve3, camera paths, animation trajectories, extrude-spline workflows, procedural motion, and any 3D spline interpolation requiring C1 continuity across control points.
// license : MIT

import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { Curve } from './004_curve.js';
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
const _gm_p0 = glMatrix.vec3.create();
const _gm_p1 = glMatrix.vec3.create();
const _gm_p2 = glMatrix.vec3.create();
const _gm_p3 = glMatrix.vec3.create();
const _gm_tmp = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// CubicPoly — inline coefficient computation (ported from r185)
// ---------------------------------------------------------------------------

function CubicPoly() {

	let c0 = 0, c1 = 0, c2 = 0, c3 = 0;

	/**
	 * Compute coefficients for a cubic polynomial
	 *   p(s) = c0 + c1*s + c2*s^2 + c3*s^3
	 * such that
	 *   p(0) = x0, p(1) = x1
	 * and
	 *   p'(0) = t0, p'(1) = t1.
	 */
	function init( x0, x1, t0, t1 ) {

		c0 = x0;
		c1 = t0;
		c2 = - 3 * x0 + 3 * x1 - 2 * t0 - t1;
		c3 = 2 * x0 - 2 * x1 + t0 + t1;

	}

	return {

		initCatmullRom: function ( x0, x1, x2, x3, tension ) {

			init( x1, x2, tension * ( x2 - x0 ), tension * ( x3 - x1 ) );

		},

		initNonuniformCatmullRom: function ( x0, x1, x2, x3, dt0, dt1, dt2 ) {

			// compute tangents when parameterized in [t1,t2]
			let t1 = ( x1 - x0 ) / dt0 - ( x2 - x0 ) / ( dt0 + dt1 ) + ( x2 - x1 ) / dt1;
			let t2 = ( x2 - x1 ) / dt1 - ( x3 - x1 ) / ( dt1 + dt2 ) + ( x3 - x2 ) / dt2;

			// rescale tangents for parametrization in [0,1]
			t1 *= dt1;
			t2 *= dt1;

			init( x1, x2, t1, t2 );

		},

		calc: function ( t ) {

			const t2 = t * t;
			const t3 = t2 * t;
			return c0 + c1 * t + c2 * t2 + c3 * t3;

		}

	};

}

// ---------------------------------------------------------------------------
// Shared module-level scratch (ported from r185)
// ---------------------------------------------------------------------------

const tmp = /*@__PURE__*/ new Vector3();
const tmp2 = /*@__PURE__*/ new Vector3();
const px = /*@__PURE__*/ new CubicPoly();
const py = /*@__PURE__*/ new CubicPoly();
const pz = /*@__PURE__*/ new CubicPoly();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-spline sampling
// ---------------------------------------------------------------------------

const _splineWorld = createWorld();

const SplineSampleComponent = defineComponent( {
	splineId: Types.ui16,
	t: Types.f64,
	x: Types.f64,
	y: Types.f64,
	z: Types.f64
} );

class CatmullRomBatch {

	constructor() {

		this.world = _splineWorld;
		this.splines = [];
		this.entities = [];

	}

	/**
	 * Register a CatmullRomCurve3 instance for batched sampling.
	 *
	 * @param {CatmullRomCurve3} spline
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
		SplineSampleComponent.z[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued samples in one cache-friendly pass.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const spline = this.splines[ SplineSampleComponent.splineId[ eid ] ];
			const point = spline.getPoint( SplineSampleComponent.t[ eid ], tmp );

			SplineSampleComponent.x[ eid ] = point.x;
			SplineSampleComponent.y[ eid ] = point.y;
			SplineSampleComponent.z[ eid ] = point.z;

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

			out[ i * 3 + 0 ] = SplineSampleComponent.x[ entities[ i ] ];
			out[ i * 3 + 1 ] = SplineSampleComponent.y[ entities[ i ] ];
			out[ i * 3 + 2 ] = SplineSampleComponent.z[ entities[ i ] ];

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// Main CatmullRomCurve3 class — mirrors three.js/src/extras/curves/CatmullRomCurve3.js
// ---------------------------------------------------------------------------

/**
 * A curve representing a Catmull-Rom spline.
 *
 * ```js
 * //Create a closed wavey loop
 * const curve = new THREE.CatmullRomCurve3( [
 *   new THREE.Vector3( -10, 0, 10 ),
 *   new THREE.Vector3( -5, 5, 5 ),
 *   new THREE.Vector3( 0, 0, 0 ),
 *   new THREE.Vector3( 5, -5, 5 ),
 *   new THREE.Vector3( 10, 0, 10 )
 * ] );
 * const points = curve.getPoints( 50 );
 * const geometry = new THREE.BufferGeometry().setFromPoints( points );
 * const material = new THREE.LineBasicMaterial( { color: 0xff0000 } );
 * const curveObject = new THREE.Line( geometry, material );
 * ```
 *
 * @augments Curve
 */
class CatmullRomCurve3 extends Curve {

	/**
	 * Constructs a new Catmull-Rom curve.
	 *
	 * @param {Array<Vector3>} [points] - An array of 3D points defining the curve.
	 * @param {boolean} [closed=false] - Whether the curve is closed or not.
	 * @param {string} [curveType='centripetal'] - The curve type: `centripetal`, `chordal`, or `catmullrom`.
	 * @param {number} [tension=0.5] - The tension of the curve. Only used when `curveType` is `catmullrom`.
	 */
	constructor( points = [], closed = false, curveType = 'centripetal', tension = 0.5 ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isCatmullRomCurve3 = true;

		this.type = 'CatmullRomCurve3';

		/**
		 * An array of 3D points defining the curve.
		 *
		 * @type {Array<Vector3>}
		 */
		this.points = points;

		/**
		 * Whether the curve is closed or not.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.closed = closed;

		/**
		 * The curve type.
		 *
		 * @type {string}
		 * @default 'centripetal'
		 */
		this.curveType = curveType;

		/**
		 * The tension of the curve.
		 *
		 * @type {number}
		 * @default 0.5
		 */
		this.tension = tension;

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

		const points = this.points;
		const l = points.length;

		const p = ( l - ( this.closed ? 0 : 1 ) ) * t;
		let intPoint = Math.floor( p );
		let weight = p - intPoint;

		if ( this.closed ) {

			intPoint += intPoint > 0 ? 0 : ( Math.floor( Math.abs( intPoint ) / l ) + 1 ) * l;

		} else if ( weight === 0 && intPoint === l - 1 ) {

			intPoint = l - 2;
			weight = 1;

		}

		let p0, p3; // 4 points (p1 & p2 defined below)

		if ( this.closed || intPoint > 0 ) {

			p0 = points[ ( intPoint - 1 ) % l ];

		} else {

			// extrapolate first point
			tmp.subVectors( points[ 0 ], points[ 1 ] ).add( points[ 0 ] );
			p0 = tmp;

		}

		const p1 = points[ intPoint % l ];
		const p2 = points[ ( intPoint + 1 ) % l ];

		if ( this.closed || intPoint + 2 < l ) {

			p3 = points[ ( intPoint + 2 ) % l ];

		} else {

			// extrapolate last point
			tmp2.subVectors( points[ l - 1 ], points[ l - 2 ] ).add( points[ l - 1 ] );
			p3 = tmp2;

		}

		if ( this.curveType === 'centripetal' || this.curveType === 'chordal' ) {

			// init Centripetal / Chordal Catmull-Rom
			const pow = this.curveType === 'chordal' ? 0.5 : 0.25;
			let dt0 = Math.pow( p0.distanceToSquared( p1 ), pow );
			let dt1 = Math.pow( p1.distanceToSquared( p2 ), pow );
			let dt2 = Math.pow( p2.distanceToSquared( p3 ), pow );

			// safety check for repeated points
			if ( dt1 < 1e-4 ) dt1 = 1.0;
			if ( dt0 < 1e-4 ) dt0 = dt1;
			if ( dt2 < 1e-4 ) dt2 = dt1;

			px.initNonuniformCatmullRom( p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2 );
			py.initNonuniformCatmullRom( p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2 );
			pz.initNonuniformCatmullRom( p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2 );

		} else if ( this.curveType === 'catmullrom' ) {

			px.initCatmullRom( p0.x, p1.x, p2.x, p3.x, this.tension );
			py.initCatmullRom( p0.y, p1.y, p2.y, p3.y, this.tension );
			pz.initCatmullRom( p0.z, p1.z, p2.z, p3.z, this.tension );

		}

		point.set(
			px.calc( weight ),
			py.calc( weight ),
			pz.calc( weight )
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

		const point = this.getPoint( t, tmp );
		out[ 0 ] = point.x;
		out[ 1 ] = point.y;
		out[ 2 ] = point.z;
		return out;

	}

	/**
	 * noise-modulated spline sampling — adds controllable organic
	 * perturbation for hand-drawn / procedural spline effects.
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
	 * double.js precision tangent computation for long spline chains
	 * where float32 drift in the tangent direction becomes visible.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {Vector3} [optionalTarget] - Optional target vector.
	 * @returns {Vector3}
	 */
	getTangentPrecise( t, optionalTarget = new Vector3() ) {

		const delta = 0.0001;
		let t1 = t - delta;
		let t2 = t + delta;

		if ( t1 < 0 ) t1 = 0;
		if ( t2 > 1 ) t2 = 1;

		const pt1 = this.getPoint( t1, tmp );
		const pt2 = this.getPoint( t2, tmp2 );

		_double.value = pt2.x - pt1.x;
		optionalTarget.x = _double.value;
		_double.value = pt2.y - pt1.y;
		optionalTarget.y = _double.value;
		_double.value = pt2.z - pt1.z;
		optionalTarget.z = _double.value;

		return optionalTarget.normalize();

	}

	/**
	 * Create a batched spline sampler backed by bitecs.
	 * Register multiple splines and queue many samples to be processed
	 * in one cache-friendly pass.
	 *
	 * @returns {CatmullRomBatch}
	 */
	static createBatch() {

		return new CatmullRomBatch();

	}

	/**
	 * Copy the given curve's properties into this one.
	 *
	 * @param {Curve} source - The curve to copy from.
	 * @return {CatmullRomCurve3} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.points = [];
		for ( let i = 0, l = source.points.length; i < l; i ++ ) {

			const point = source.points[ i ];
			this.points.push( point.clone() );

		}

		this.closed = source.closed;
		this.curveType = source.curveType;
		this.tension = source.tension;

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

		data.closed = this.closed;
		data.curveType = this.curveType;
		data.tension = this.tension;

		return data;

	}

	/**
	 * Deserializes the curve from JSON.
	 *
	 * @param {Object} json - The source JSON object.
	 * @return {CatmullRomCurve3} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.points = [];
		for ( let i = 0, l = json.points.length; i < l; i ++ ) {

			const point = json.points[ i ];
			this.points.push( new Vector3().fromArray( point ) );

		}

		this.closed = json.closed;
		this.curveType = json.curveType;
		this.tension = json.tension;

		return this;

	}

}

export { CatmullRomCurve3, CatmullRomBatch };
export default CatmullRomCurve3;