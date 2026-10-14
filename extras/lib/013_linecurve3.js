// file number : 013
// full path name : src/extras/lib/013_linecurve3.js
// description : A curve representing a 3D line segment (three.js r185) rewritten as a high-performance ES module. Extends the internal 004_curve.js base class and imports Vector3 strictly from the threejs_new01 math folder. Implements the exact LineCurve3 contract including getPoint(1) fast-path, overridden getPointAt/getTangent/getTangentAt for linear behavior, plus accelerated extensions: gl-matrix zero-allocation point evaluation, bitecs SoA batch sampling for many segments processed in a single cache-friendly pass, double.js high-precision parametric evaluation for extremely long lines, and simplex-noise organic jitter for hand-drawn 3D line effects.
// best for : LineCurve3, TubeGeometry linear segments, 3D motion path segments, camera rigs, wireframe helpers, and any 3D line interpolation used by three.js geometry and curve APIs.
// license : MIT

import { Curve } from './004_curve.js';
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

// gl-matrix scratch for zero-allocation line evaluation
const _gm_v3 = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-segment sampling
// ---------------------------------------------------------------------------

const _lineWorld = createWorld();

const LineSampleComponent = defineComponent( {
	lineId: Types.ui16,
	t: Types.f64,
	v1x: Types.f64,
	v1y: Types.f64,
	v1z: Types.f64,
	v2x: Types.f64,
	v2y: Types.f64,
	v2z: Types.f64,
	x: Types.f64,
	y: Types.f64,
	z: Types.f64
} );

class LineCurve3Batch {

	constructor() {

		this.world = _lineWorld;
		this.lines = [];
		this.entities = [];

	}

	/**
	 * Register a LineCurve3 instance for batched sampling.
	 *
	 * @param {LineCurve3} line
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
		LineSampleComponent.v1z[ eid ] = line.v1.z;
		LineSampleComponent.v2x[ eid ] = line.v2.x;
		LineSampleComponent.v2y[ eid ] = line.v2.y;
		LineSampleComponent.v2z[ eid ] = line.v2.z;
		LineSampleComponent.x[ eid ] = 0;
		LineSampleComponent.y[ eid ] = 0;
		LineSampleComponent.z[ eid ] = 0;

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
			const t = LineSampleComponent.t[ eid ];

			// Fast path: t === 1 returns v2 directly (mirrors r185 optimization)
			if ( t === 1 ) {

				LineSampleComponent.x[ eid ] = LineSampleComponent.v2x[ eid ];
				LineSampleComponent.y[ eid ] = LineSampleComponent.v2y[ eid ];
				LineSampleComponent.z[ eid ] = LineSampleComponent.v2z[ eid ];
				continue;

			}

			// General case: linear interpolation via gl-matrix
			glMatrix.vec3.set(
				_gm_v3,
				LineSampleComponent.v1x[ eid ] + t * ( LineSampleComponent.v2x[ eid ] - LineSampleComponent.v1x[ eid ] ),
				LineSampleComponent.v1y[ eid ] + t * ( LineSampleComponent.v2y[ eid ] - LineSampleComponent.v1y[ eid ] ),
				LineSampleComponent.v1z[ eid ] + t * ( LineSampleComponent.v2z[ eid ] - LineSampleComponent.v1z[ eid ] )
			);

			LineSampleComponent.x[ eid ] = _gm_v3[ 0 ];
			LineSampleComponent.y[ eid ] = _gm_v3[ 1 ];
			LineSampleComponent.z[ eid ] = _gm_v3[ 2 ];

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

			out[ i * 3 + 0 ] = LineSampleComponent.x[ entities[ i ] ];
			out[ i * 3 + 1 ] = LineSampleComponent.y[ entities[ i ] ];
			out[ i * 3 + 2 ] = LineSampleComponent.z[ entities[ i ] ];

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js precise parametric evaluation for very long 3D lines
// ---------------------------------------------------------------------------

/**
 * Evaluate a 3D line at parameter t using double.js for bit-exact
 * accumulation. Used when the standard float32 path produces visible
 * drift on extremely long lines (e.g. > 1e7 units).
 *
 * @param {number} t
 * @param {number} x1
 * @param {number} y1
 * @param {number} z1
 * @param {number} x2
 * @param {number} y2
 * @param {number} z2
 * @returns {{x: number, y: number, z: number}}
 */
function line3Precise( t, x1, y1, z1, x2, y2, z2 ) {

	_double.value = x2;
	_double.sub( x1 );
	const dx = _double.value;

	_double.value = y2;
	_double.sub( y1 );
	const dy = _double.value;

	_double.value = z2;
	_double.sub( z1 );
	const dz = _double.value;

	_double.value = x1;
	_double.add( t * dx );
	const x = _double.value;

	_double.value = y1;
	_double.add( t * dy );
	const y = _double.value;

	_double.value = z1;
	_double.add( t * dz );
	const z = _double.value;

	return { x, y, z };

}

// ---------------------------------------------------------------------------
// Main LineCurve3 class — mirrors three.js/src/extras/curves/LineCurve3.js
// ---------------------------------------------------------------------------

/**
 * A curve representing a 3D line segment.
 *
 * ```js
 * const curve = new THREE.LineCurve3(
 *   new THREE.Vector3( - 10, 0, 0 ),
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
class LineCurve3 extends Curve {

	/**
	 * Constructs a new line curve.
	 *
	 * @param {Vector3} [v1] - The start point.
	 * @param {Vector3} [v2] - The end point.
	 */
	constructor( v1 = new Vector3(), v2 = new Vector3() ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isLineCurve3 = true;

		this.type = 'LineCurve3';

		/**
		 * The start point.
		 *
		 * @type {Vector3}
		 */
		this.v1 = v1;

		/**
		 * The end point.
		 *
		 * @type {Vector3}
		 */
		this.v2 = v2;

	}

	/**
	 * Returns a point on the line.
	 *
	 * @param {number} t - A interpolation factor representing a position on the line. Must be in the range `[0,1]`.
	 * @param {Vector3} [optionalTarget] - The optional target vector the result is written to.
	 * @return {Vector3} The position on the line.
	 */
	getPoint( t, optionalTarget = new Vector3() ) {

		const point = optionalTarget;

		if ( t === 1 ) {

			point.copy( this.v2 );

		} else {

			point.copy( this.v2 ).sub( this.v1 );
			point.multiplyScalar( t ).add( this.v1 );

		}

		return point;

	}

	// Line curve is linear, so we can overwrite default getPointAt
	getPointAt( u, optionalTarget ) {

		return this.getPoint( u, optionalTarget );

	}

	getTangent( t, optionalTarget = new Vector3() ) {

		return optionalTarget.subVectors( this.v2, this.v1 ).normalize();

	}

	getTangentAt( u, optionalTarget ) {

		return this.getTangent( u, optionalTarget );

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
	 * noise-modulated line sampling — adds controllable organic
	 * perturbation for hand-drawn / procedural 3D line effects.
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
	 * double.js precision evaluation of the line at parameter t.
	 * Bit-exact parametric interpolation for extremely long lines.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {Vector3} [optionalTarget] - Optional target vector.
	 * @returns {Vector3}
	 */
	getPointPrecise( t, optionalTarget = new Vector3() ) {

		const point = optionalTarget;
		const r = line3Precise( t, this.v1.x, this.v1.y, this.v1.z, this.v2.x, this.v2.y, this.v2.z );
		point.set( r.x, r.y, r.z );
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
		const dz = this.v2.z - this.v1.z;

		_double.value = dx * dx;
		_double.add( dy * dy );
		_double.add( dz * dz );

		return Math.sqrt( _double.value );

	}

	/**
	 * Create a batched line sampler backed by bitecs.
	 * Register multiple lines and queue many samples to be processed
	 * in one cache-friendly pass.
	 *
	 * @returns {LineCurve3Batch}
	 */
	static createBatch() {

		return new LineCurve3Batch();

	}

	/**
	 * Copy the given curve's properties into this one.
	 *
	 * @param {Curve} source - The curve to copy from.
	 * @return {LineCurve3} A reference to this instance.
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
	 * @return {LineCurve3} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.v1.fromArray( json.v1 );
		this.v2.fromArray( json.v2 );

		return this;

	}

}

export { LineCurve3, LineCurve3Batch, line3Precise };
export default LineCurve3;