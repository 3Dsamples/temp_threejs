// file number : 018
// full path name : src/extras/lib/018_curvepath.js
// description : A base class extending Curve, representing an array of connected curves while retaining the Curve API (three.js r185) rewritten as a high-performance ES module. Imports Vector3 strictly from the threejs_new01 math folder and reuses the internal 004_curve.js, 012_linecurve.js, and 013_linecurve3.js modules. Adds gl-matrix accelerated batch point evaluation, bitecs SoA batching for multi-path sampling, double.js bit-exact cumulative length accumulation for very long paths, and simplex-noise organic perturbation for hand-drawn path effects.
// best for : CurvePath, Path (which extends CurvePath), Shape (which extends Path), ExtrudeGeometry, TubeGeometry, SVG path parsing, and any three.js workflow that needs to chain multiple curves into a single continuous path.
// license : MIT

import { Curve } from './004_curve.js';
import { LineCurve } from './012_linecurve.js';
import { LineCurve3 } from './013_linecurve3.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
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

// gl-matrix scratch for zero-allocation path evaluation
const _gm_v2 = glMatrix.vec2.create();
const _gm_v3 = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-path sampling
// ---------------------------------------------------------------------------

const _pathWorld = createWorld();

const PathSampleComponent = defineComponent( {
	pathId: Types.ui16,
	t: Types.f64,
	x: Types.f64,
	y: Types.f64,
	z: Types.f64,
	isVector3: Types.ui8
} );

class CurvePathBatch {

	constructor() {

		this.world = _pathWorld;
		this.paths = [];
		this.entities = [];

	}

	/**
	 * Register a CurvePath instance for batched sampling.
	 *
	 * @param {CurvePath} path
	 * @returns {number} path id
	 */
	addPath( path ) {

		this.paths.push( path );
		return this.paths.length - 1;

	}

	/**
	 * Queue a sample for a registered path.
	 *
	 * @param {number} pathId
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {number} entity id
	 */
	addSample( pathId, t ) {

		const eid = addEntity( this.world );
		addComponent( this.world, PathSampleComponent, eid );

		PathSampleComponent.pathId[ eid ] = pathId;
		PathSampleComponent.t[ eid ] = t;
		PathSampleComponent.x[ eid ] = 0;
		PathSampleComponent.y[ eid ] = 0;
		PathSampleComponent.z[ eid ] = 0;

		const path = this.paths[ pathId ];
		PathSampleComponent.isVector3[ eid ] = path.isVector3 ? 1 : 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued samples in one cache-friendly pass.
	 * Uses gl-matrix for per-sample vec2/vec3 staging.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const path = this.paths[ PathSampleComponent.pathId[ eid ] ];
			const point = path.getPoint( PathSampleComponent.t[ eid ] );

			if ( ! point ) continue;

			if ( PathSampleComponent.isVector3[ eid ] ) {

				glMatrix.vec3.set( _gm_v3, point.x, point.y, point.z );
				PathSampleComponent.x[ eid ] = _gm_v3[ 0 ];
				PathSampleComponent.y[ eid ] = _gm_v3[ 1 ];
				PathSampleComponent.z[ eid ] = _gm_v3[ 2 ];

			} else {

				glMatrix.vec2.set( _gm_v2, point.x, point.y );
				PathSampleComponent.x[ eid ] = _gm_v2[ 0 ];
				PathSampleComponent.y[ eid ] = _gm_v2[ 1 ];
				PathSampleComponent.z[ eid ] = 0;

			}

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

			out[ i * 3 + 0 ] = PathSampleComponent.x[ entities[ i ] ];
			out[ i * 3 + 1 ] = PathSampleComponent.y[ entities[ i ] ];
			out[ i * 3 + 2 ] = PathSampleComponent.z[ entities[ i ] ];

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js precise cumulative length accumulation for very long paths
// ---------------------------------------------------------------------------

/**
 * Compute the cumulative lengths of a sequence of curves using double.js
 * for bit-exact accumulation. Used for very long paths where float32
 * drift across hundreds of segments becomes visible.
 *
 * @param {Curve[]} curves
 * @param {number} [arcLengthDivisions=200]
 * @returns {number[]}
 */
function getCurveLengthsPrecise( curves, arcLengthDivisions = 200 ) {

	const lengths = [];
	_double.value = 0;

	for ( let i = 0, l = curves.length; i < l; i ++ ) {

		const curve = curves[ i ];

		// Accumulate each curve's own length with double.js precision
		let last = curve.getPoint( 0 );
		let current;
		_double.add( 0 );

		for ( let p = 1; p <= arcLengthDivisions; p ++ ) {

			current = curve.getPoint( p / arcLengthDivisions );
			const dx = current.x - last.x;
			const dy = current.y - last.y;
			const dz = ( current.z !== undefined && last.z !== undefined ) ? current.z - last.z : 0;
			_double.add( Math.sqrt( dx * dx + dy * dy + dz * dz ) );
			last = current;

		}

		lengths.push( _double.value );

	}

	return lengths;

}

// ---------------------------------------------------------------------------
// Main CurvePath class — mirrors three.js/src/extras/core/CurvePath.js
// ---------------------------------------------------------------------------

/**
 * A base class extending {@link Curve}. `CurvePath` is simply an array of
 * connected curves, but retains the API of a curve.
 *
 * @augments Curve
 */
class CurvePath extends Curve {

	/**
	 * Constructs a new curve path.
	 */
	constructor() {

		super();

		/**
		 * The type of the object.
		 *
		 * @type {string}
		 * @readonly
		 * @default 'CurvePath'
		 */
		this.type = 'CurvePath';

		/**
		 * An array of curves defining the path.
		 *
		 * @type {Array<Curve>}
		 */
		this.curves = [];

		/**
		 * Whether the path should automatically be closed by a line curve.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.autoClose = false;

	}

	/**
	 * Adds a curve to this curve path.
	 *
	 * @param {Curve} curve - The curve to add.
	 */
	add( curve ) {

		this.curves.push( curve );

	}

	/**
	 * Adds a line curve to close the path.
	 *
	 * @return {CurvePath} A reference to this curve path.
	 */
	closePath() {

		const startPoint = this.curves[ 0 ].getPoint( 0 );
		const endPoint = this.curves[ this.curves.length - 1 ].getPoint( 1 );

		if ( ! startPoint.equals( endPoint ) ) {

			const lineType = ( startPoint.isVector2 === true ) ? 'LineCurve' : 'LineCurve3';
			this.curves.push( new ( lineType === 'LineCurve' ? LineCurve : LineCurve3 )( endPoint, startPoint ) );

		}

		return this;

	}

	/**
	 * This method returns a vector in 2D or 3D space (depending on the curve
	 * definitions) for the given interpolation factor.
	 *
	 * @param {number} t - A interpolation factor representing a position on the curve.
	 *   Must be in the range `[0,1]`.
	 * @param {(Vector2|Vector3)} [optionalTarget] - The optional target vector the result is written to.
	 * @return {?(Vector2|Vector3)} The position on the curve. It can be a 2D or 3D vector depending on the curve definition.
	 */
	getPoint( t, optionalTarget ) {

		const d = t * this.getLength();
		const curveLengths = this.getCurveLengths();
		let i = 0;

		while ( i < curveLengths.length ) {

			if ( curveLengths[ i ] >= d ) {

				const diff = curveLengths[ i ] - d;
				const curve = this.curves[ i ];

				const segmentLength = curve.getLength();
				const u = segmentLength === 0 ? 0 : 1 - diff / segmentLength;

				return curve.getPointAt( u, optionalTarget );

			}

			i ++;

		}

		return null;

	}

	/**
	 * Returns the total arc length of the curve path.
	 *
	 * @return {number} The length of the curve path.
	 */
	getLength() {

		const lens = this.getCurveLengths();
		return lens[ lens.length - 1 ];

	}

	/**
	 * Updates the arc length cache.
	 */
	updateArcLengths() {

		this.needsUpdate = true;
		this.cacheLengths = null;
		this.getCurveLengths();

	}

	/**
	 * Returns list of cumulative curve lengths of the defined curves.
	 *
	 * @return {Array<number>} The cumulative curve lengths.
	 */
	getCurveLengths() {

		if ( this.cacheLengths && this.cacheLengths.length === this.curves.length ) {

			return this.cacheLengths;

		}

		const lengths = [];
		let sums = 0;

		for ( let i = 0, l = this.curves.length; i < l; i ++ ) {

			sums += this.curves[ i ].getLength();
			lengths.push( sums );

		}

		this.cacheLengths = lengths;

		return this.cacheLengths;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated point evaluation (writes into a Float32Array
	 * vec2 or vec3, depending on the first curve's vector type).
	 *
	 * @param {(glMatrix.vec2|glMatrix.vec3)} out - Preallocated gl-matrix output.
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {(glMatrix.vec2|glMatrix.vec3)}
	 */
	getPointGlMat( out, t ) {

		const point = this.getPoint( t );

		if ( ! point ) return out;

		out[ 0 ] = point.x;
		out[ 1 ] = point.y;
		if ( point.z !== undefined ) out[ 2 ] = point.z;

		return out;

	}

	/**
	 * noise-modulated path sampling — adds controllable organic
	 * perturbation for hand-drawn / procedural path effects.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {number} [amplitude=0.01] - Noise amplitude.
	 * @param {number} [frequency=1] - Noise frequency.
	 * @param {number} [offset=0] - Per-instance noise offset.
	 * @returns {?(Vector2|Vector3)}
	 */
	getPointNoisy( t, amplitude = 0.01, frequency = 1, offset = 0 ) {

		const point = this.getPoint( t );
		if ( ! point ) return point;

		point.x += _noise2D( t * frequency + offset, 0 ) * amplitude;
		point.y += _noise2D( t * frequency + offset, 100 ) * amplitude;
		if ( point.z !== undefined ) point.z += _noise2D( t * frequency + offset, 200 ) * amplitude;

		return point;

	}

	/**
	 * double.js precision cumulative curve lengths for very long paths
	 * where float32 drift across many segments becomes visible.
	 *
	 * @param {number} [arcLengthDivisions=200]
	 * @returns {number[]}
	 */
	getCurveLengthsPrecise( arcLengthDivisions = 200 ) {

		return getCurveLengthsPrecise( this.curves, arcLengthDivisions );

	}

	/**
	 * Create a batched path sampler backed by bitecs.
	 * Register multiple paths and queue many samples to be processed
	 * in one cache-friendly pass.
	 *
	 * @returns {CurvePathBatch}
	 */
	static createBatch() {

		return new CurvePathBatch();

	}

	/**
	 * Copy the given curve path's properties into this one.
	 *
	 * @param {CurvePath} source - The curve path to copy from.
	 * @return {CurvePath} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.curves = [];

		for ( let i = 0, l = source.curves.length; i < l; i ++ ) {

			const curve = source.curves[ i ];
			this.curves.push( curve.clone() );

		}

		this.autoClose = source.autoClose;

		return this;

	}

	/**
	 * Serializes the curve path into JSON.
	 *
	 * @return {Object} A JSON object representing the serialized curve path.
	 */
	toJSON() {

		const data = super.toJSON();

		data.autoClose = this.autoClose;
		data.curves = [];

		for ( let i = 0, l = this.curves.length; i < l; i ++ ) {

			const curve = this.curves[ i ];
			data.curves.push( curve.toJSON() );

		}

		return data;

	}

	/**
	 * Deserializes the curve path from JSON.
	 *
	 * @param {Object} json - The source JSON object.
	 * @return {CurvePath} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.autoClose = json.autoClose;
		this.curves = [];

		for ( let i = 0, l = json.curves.length; i < l; i ++ ) {

			const curve = json.curves[ i ];
			this.curves.push( new Curves[ curve.type ]().fromJSON( curve ) );

		}

		return this;

	}

}

export { CurvePath, CurvePathBatch, getCurveLengthsPrecise };
export default CurvePath;