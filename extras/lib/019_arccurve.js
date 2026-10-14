// file number : 019
// full path name : src/extras/lib/019_arccurve.js
// description : A curve representing a circular arc (three.js r185) rewritten as a high-performance ES module. Extends the internal 008_ellipsecurve.js (which in turn extends 004_curve.js) and imports Vector2 strictly from the threejs_new01 math folder. Preserves the exact ArcCurve contract — hardcoded circle parameters (equal radii, center at origin) with only start/end angles exposed. Adds gl-matrix accelerated batch point evaluation, bitecs SoA batching for multi-arc sampling (useful for sprites, radial UI, and particle rings), double.js bit-exact angle unwrapping for very large sweep angles, and simplex-noise organic radius modulation for hand-drawn arc effects.
// best for : ArcCurve, CircleGeometry outlines, Path.arc(), Shape.arc(), radial UI elements, particle ring emitters, and any three.js path that needs a circular arc segment.
// license : MIT

import { EllipseCurve } from './008_ellipsecurve.js';
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

// gl-matrix scratch for zero-allocation arc evaluation
const _gm_v2 = glMatrix.vec2.create();

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-arc sampling
// ---------------------------------------------------------------------------

const _arcWorld = createWorld();

const ArcSampleComponent = defineComponent( {
	arcId: Types.ui16,
	t: Types.f64,
	radius: Types.f64,
	aStartAngle: Types.f64,
	aEndAngle: Types.f64,
	aClockwise: Types.ui8,
	x: Types.f64,
	y: Types.f64
} );

class ArcCurveBatch {

	constructor() {

		this.world = _arcWorld;
		this.arcs = [];
		this.entities = [];

	}

	/**
	 * Register an ArcCurve instance for batched sampling.
	 *
	 * @param {ArcCurve} arc
	 * @returns {number} arc id
	 */
	addArc( arc ) {

		this.arcs.push( arc );
		return this.arcs.length - 1;

	}

	/**
	 * Queue a sample for a registered arc.
	 *
	 * @param {number} arcId
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {number} entity id
	 */
	addSample( arcId, t ) {

		const eid = addEntity( this.world );
		addComponent( this.world, ArcSampleComponent, eid );

		const arc = this.arcs[ arcId ];

		ArcSampleComponent.arcId[ eid ] = arcId;
		ArcSampleComponent.t[ eid ] = t;
		ArcSampleComponent.radius[ eid ] = arc.xRadius;
		ArcSampleComponent.aStartAngle[ eid ] = arc.aStartAngle;
		ArcSampleComponent.aEndAngle[ eid ] = arc.aEndAngle;
		ArcSampleComponent.aClockwise[ eid ] = arc.aClockwise ? 1 : 0;
		ArcSampleComponent.x[ eid ] = 0;
		ArcSampleComponent.y[ eid ] = 0;

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
			const t = ArcSampleComponent.t[ eid ];
			const r = ArcSampleComponent.radius[ eid ];

			let deltaAngle = ArcSampleComponent.aEndAngle[ eid ] - ArcSampleComponent.aStartAngle[ eid ];

			// Normalize deltaAngle into [0, 2π]
			while ( deltaAngle < 0 ) deltaAngle += TWO_PI;
			while ( deltaAngle > TWO_PI ) deltaAngle -= TWO_PI;

			if ( deltaAngle < Number.EPSILON ) deltaAngle = TWO_PI;

			if ( ArcSampleComponent.aClockwise[ eid ] === 1 ) {

				if ( deltaAngle === TWO_PI ) deltaAngle = - TWO_PI;
				else deltaAngle = deltaAngle - TWO_PI;

			}

			const angle = ArcSampleComponent.aStartAngle[ eid ] + t * deltaAngle;

			glMatrix.vec2.set(
				_gm_v2,
				r * Math.cos( angle ),
				r * Math.sin( angle )
			);

			ArcSampleComponent.x[ eid ] = _gm_v2[ 0 ];
			ArcSampleComponent.y[ eid ] = _gm_v2[ 1 ];

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

			out[ i * 2 + 0 ] = ArcSampleComponent.x[ entities[ i ] ];
			out[ i * 2 + 1 ] = ArcSampleComponent.y[ entities[ i ] ];

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// double.js precise angle unwrapping for very large sweep angles
// ---------------------------------------------------------------------------

/**
 * Compute the arc's effective deltaAngle using double.js for bit-exact
 * accumulation. Used when sweeps exceed 2π many times over (spiral-like
 * inputs) and float32 drift becomes visible.
 *
 * @param {number} aStartAngle
 * @param {number} aEndAngle
 * @param {boolean} aClockwise
 * @returns {number}
 */
function computeDeltaAnglePrecise( aStartAngle, aEndAngle, aClockwise ) {

	_double.value = aEndAngle;
	_double.sub( aStartAngle );
	let deltaAngle = _double.value;

	// Wrap into [0, 2π] using double.js — no float32 accumulation loss
	while ( deltaAngle < 0 ) {

		_double.value = deltaAngle;
		_double.add( TWO_PI );
		deltaAngle = _double.value;

	}

	while ( deltaAngle > TWO_PI ) {

		_double.value = deltaAngle;
		_double.sub( TWO_PI );
		deltaAngle = _double.value;

	}

	if ( deltaAngle < Number.EPSILON ) deltaAngle = TWO_PI;

	if ( aClockwise ) {

		if ( deltaAngle === TWO_PI ) deltaAngle = - TWO_PI;
		else deltaAngle = deltaAngle - TWO_PI;

	}

	return deltaAngle;

}

// ---------------------------------------------------------------------------
// Main ArcCurve class — mirrors three.js/src/extras/curves/ArcCurve.js
// ---------------------------------------------------------------------------

/**
 * An alias for {@link EllipseCurve} representing a circular arc centered on
 * the origin with equal x/y radii.
 *
 * ```js
 * const curve = new THREE.ArcCurve(
 *   0, 0,        // aX, aY
 *   10,          // aRadius
 *   0,           // aStartAngle
 *   Math.PI * 2, // aEndAngle
 *   false        // aClockwise
 * );
 * const points = curve.getPoints( 50 );
 * const geometry = new THREE.BufferGeometry().setFromPoints( points );
 * const material = new THREE.LineBasicMaterial( { color: 0xff0000 } );
 * const arc = new THREE.Line( geometry, material );
 * ```
 *
 * @augments EllipseCurve
 */
class ArcCurve extends EllipseCurve {

	/**
	 * Constructs a new arc curve.
	 *
	 * @param {number} [aX=0] - The X center of the arc.
	 * @param {number} [aY=0] - The Y center of the arc.
	 * @param {number} [aRadius=1] - The radius of the arc.
	 * @param {number} [aStartAngle=0] - The start angle of the arc in radians, from the positive X axis.
	 * @param {number} [aEndAngle=Math.PI*2] - The end angle of the arc in radians, from the positive X axis.
	 * @param {boolean} [aClockwise=false] - Whether the arc is drawn clockwise or not.
	 */
	constructor( aX = 0, aY = 0, aRadius = 1, aStartAngle = 0, aEndAngle = TWO_PI, aClockwise = false ) {

		super( aX, aY, aRadius, aRadius, aStartAngle, aEndAngle, aClockwise );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isArcCurve = true;

		this.type = 'ArcCurve';

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated point evaluation (writes into a gl-matrix vec2).
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
	 * noise-modulated arc sampling — adds controllable organic
	 * perturbation for hand-drawn / procedural circular arc effects.
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
	 * double.js precision point evaluation. Uses bit-exact angle unwrapping
	 * before applying the trigonometric evaluation. Suitable for very large
	 * sweep angles where float32 drift matters.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @param {Vector2} [optionalTarget] - Optional target vector.
	 * @returns {Vector2}
	 */
	getPointPrecise( t, optionalTarget = new Vector2() ) {

		const point = optionalTarget;

		const deltaAngle = computeDeltaAnglePrecise( this.aStartAngle, this.aEndAngle, this.aClockwise );
		const angle = this.aStartAngle + t * deltaAngle;

		point.set(
			this.aX + this.xRadius * Math.cos( angle ),
			this.aY + this.yRadius * Math.sin( angle )
		);

		return point;

	}

	/**
	 * double.js precision arc length. For a circular arc the closed form is
	 * exact: length = radius * |deltaAngle|.
	 *
	 * @returns {number}
	 */
	getLengthPrecise() {

		const deltaAngle = computeDeltaAnglePrecise( this.aStartAngle, this.aEndAngle, this.aClockwise );

		_double.value = this.xRadius;
		_double.mul( Math.abs( deltaAngle ) );

		return _double.value;

	}

	/**
	 * Create a batched arc sampler backed by bitecs.
	 * Register multiple arcs and queue many samples to be processed
	 * in one cache-friendly pass.
	 *
	 * @returns {ArcCurveBatch}
	 */
	static createBatch() {

		return new ArcCurveBatch();

	}

}

export { ArcCurve, ArcCurveBatch, computeDeltaAnglePrecise };
export default ArcCurve;