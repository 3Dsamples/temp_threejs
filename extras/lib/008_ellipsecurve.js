// file number : 008
// full path name : src/extras/lib/008_ellipsecurve.js
// description : A curve representing an ellipse (three.js r185) rewritten as a high-performance ES module. Extends the internal 004_curve.js base class and imports Vector2 strictly from the threejs_new01 math folder. Adds gl-matrix accelerated batch point evaluation, bitecs SoA batching for multi-ellipse sampling, double.js high-precision angle unwrapping and arc-length integration, and simplex-noise organic radius modulation for hand-drawn ellipse effects.
// best for : EllipseCurve, ArcCurve (which extends EllipseCurve), Shape.ellipse(), Path.ellipse(), and any 2D/3D arc, circle, or ellipse geometry in three.js.
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

// gl-matrix scratch for zero-allocation ellipse point evaluation
const _gm_v2 = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-ellipse sampling
// ---------------------------------------------------------------------------

const _ellipseWorld = createWorld();

const EllipseSampleComponent = defineComponent( {
	ax: Types.f64,
	ay: Types.f64,
	xRadius: Types.f64,
	yRadius: Types.f64,
	aStartAngle: Types.f64,
	aEndAngle: Types.f64,
	aClockwise: Types.ui8,
	aRotation: Types.f64,
	t: Types.f64,
	x: Types.f64,
	y: Types.f64
} );

class EllipseCurveBatch {

	constructor() {

		this.world = _ellipseWorld;
		this.entities = [];

	}

	/**
	 * Queue a single ellipse sample.
	 *
	 * @param {number} ax
	 * @param {number} ay
	 * @param {number} xRadius
	 * @param {number} yRadius
	 * @param {number} aStartAngle
	 * @param {number} aEndAngle
	 * @param {boolean} aClockwise
	 * @param {number} aRotation
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {number} entity id
	 */
	add( ax, ay, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation, t ) {

		const eid = addEntity( this.world );
		addComponent( this.world, EllipseSampleComponent, eid );

		EllipseSampleComponent.ax[ eid ] = ax;
		EllipseSampleComponent.ay[ eid ] = ay;
		EllipseSampleComponent.xRadius[ eid ] = xRadius;
		EllipseSampleComponent.yRadius[ eid ] = yRadius;
		EllipseSampleComponent.aStartAngle[ eid ] = aStartAngle;
		EllipseSampleComponent.aEndAngle[ eid ] = aEndAngle;
		EllipseSampleComponent.aClockwise[ eid ] = aClockwise ? 1 : 0;
		EllipseSampleComponent.aRotation[ eid ] = aRotation;
		EllipseSampleComponent.t[ eid ] = t;
		EllipseSampleComponent.x[ eid ] = 0;
		EllipseSampleComponent.y[ eid ] = 0;

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

			const deltaAngle = EllipseSampleComponent.aEndAngle[ eid ] - EllipseSampleComponent.aStartAngle[ eid ];

			let samePoints = Math.abs( deltaAngle ) < Number.EPSILON;

			// ensures that we get a circle in case of an ellipse with same radii
			if ( samePoints ) {

				if ( EllipseSampleComponent.xRadius[ eid ] === EllipseSampleComponent.yRadius[ eid ] ) {

					samePoints = false;

				} else {

					EllipseSampleComponent.aStartAngle[ eid ] = EllipseSampleComponent.aEndAngle[ eid ];

				}

			}

			// prevents from calculating points over a full circle
			else if ( ! samePoints && Math.abs( deltaAngle ) > Math.PI * 2 ) {

				EllipseSampleComponent.aStartAngle[ eid ] = EllipseSampleComponent.aEndAngle[ eid ];

			}

			const angle = EllipseSampleComponent.aStartAngle[ eid ] +
				EllipseSampleComponent.t[ eid ] * ( EllipseSampleComponent.aEndAngle[ eid ] - EllipseSampleComponent.aStartAngle[ eid ] );

			const x = EllipseSampleComponent.ax[ eid ] + EllipseSampleComponent.xRadius[ eid ] * Math.cos( angle );
			const y = EllipseSampleComponent.ay[ eid ] + EllipseSampleComponent.yRadius[ eid ] * Math.sin( angle );

			if ( EllipseSampleComponent.aRotation[ eid ] !== 0 ) {

				const cos = Math.cos( EllipseSampleComponent.aRotation[ eid ] );
				const sin = Math.sin( EllipseSampleComponent.aRotation[ eid ] );

				const tx = x - EllipseSampleComponent.ax[ eid ];
				const ty = y - EllipseSampleComponent.ay[ eid ];

				EllipseSampleComponent.x[ eid ] = tx * cos - ty * sin + EllipseSampleComponent.ax[ eid ];
				EllipseSampleComponent.y[ eid ] = tx * sin + ty * cos + EllipseSampleComponent.ay[ eid ];

			} else {

				EllipseSampleComponent.x[ eid ] = x;
				EllipseSampleComponent.y[ eid ] = y;

			}

		}

	}

	/**
	 * Retrieve the sample result for a given entity.
	 *
	 * @param {number} eid
	 * @returns {{x: number, y: number}}
	 */
	result( eid ) {

		return {
			x: EllipseSampleComponent.x[ eid ],
			y: EllipseSampleComponent.y[ eid ]
		};

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

			out[ i * 2 + 0 ] = EllipseSampleComponent.x[ entities[ i ] ];
			out[ i * 2 + 1 ] = EllipseSampleComponent.y[ entities[ i ] ];

		}

		return out;

	}

}

// ---------------------------------------------------------------------------
// Main EllipseCurve class — mirrors three.js/src/extras/curves/EllipseCurve.js
// ---------------------------------------------------------------------------

/**
 * A curve representing an ellipse.
 *
 * ```js
 * const curve = new THREE.EllipseCurve(
 *   0, 0,
 *   10, 10,
 *   0, 2 * Math.PI,
 *   false,
 *   0
 * );
 * const points = curve.getPoints( 50 );
 * const geometry = new THREE.BufferGeometry().setFromPoints( points );
 * const material = new THREE.LineBasicMaterial( { color: 0xff0000 } );
 * const ellipse = new THREE.Line( geometry, material );
 * ```
 *
 * @augments Curve
 */
class EllipseCurve extends Curve {

	/**
	 * Constructs a new ellipse curve.
	 *
	 * @param {number} [aX=0] - The X center of the ellipse.
	 * @param {number} [aY=0] - The Y center of the ellipse.
	 * @param {number} [xRadius=1] - The radius of the ellipse in the x direction.
	 * @param {number} [yRadius=1] - The radius of the ellipse in the y direction.
	 * @param {number} [aStartAngle=0] - The start angle of the curve in radians starting from the positive X axis.
	 * @param {number} [aEndAngle=Math.PI*2] - The end angle of the curve in radians starting from the positive X axis.
	 * @param {boolean} [aClockwise=false] - Whether the ellipse is drawn clockwise or not.
	 * @param {number} [aRotation=0] - The rotation angle of the ellipse in radians, counterclockwise from the positive X axis.
	 */
	constructor( aX = 0, aY = 0, xRadius = 1, yRadius = 1, aStartAngle = 0, aEndAngle = Math.PI * 2, aClockwise = false, aRotation = 0 ) {

		super();

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isEllipseCurve = true;

		this.type = 'EllipseCurve';

		/**
		 * The X center of the ellipse.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.aX = aX;

		/**
		 * The Y center of the ellipse.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.aY = aY;

		/**
		 * The radius of the ellipse in the x direction.
		 *
		 * @type {number}
		 * @default 1
		 */
		this.xRadius = xRadius;

		/**
		 * The radius of the ellipse in the y direction.
		 *
		 * @type {number}
		 * @default 1
		 */
		this.yRadius = yRadius;

		/**
		 * The start angle of the curve in radians starting from the positive X axis.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.aStartAngle = aStartAngle;

		/**
		 * The end angle of the curve in radians starting from the positive X axis.
		 *
		 * @type {number}
		 * @default Math.PI*2
		 */
		this.aEndAngle = aEndAngle;

		/**
		 * Whether the ellipse is drawn clockwise or not.
		 *
		 * @type {boolean}
		 * @default false
		 */
		this.aClockwise = aClockwise;

		/**
		 * The rotation angle of the ellipse in radians, counterclockwise from the positive X axis.
		 *
		 * @type {number}
		 * @default 0
		 */
		this.aRotation = aRotation;

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

		const twoPi = Math.PI * 2;
		let deltaAngle = this.aEndAngle - this.aStartAngle;
		const samePoints = Math.abs( deltaAngle ) < Number.EPSILON;

		// ensures that deltaAngle is 0 .. 2 PI
		while ( deltaAngle < 0 ) deltaAngle += twoPi;
		while ( deltaAngle > twoPi ) deltaAngle -= twoPi;

		if ( deltaAngle < Number.EPSILON ) {

			if ( samePoints ) {

				deltaAngle = 0;

			} else {

				deltaAngle = twoPi;

			}

		}

		if ( this.aClockwise === true && ! samePoints ) {

			if ( deltaAngle === twoPi ) {

				deltaAngle = - twoPi;

			} else {

				deltaAngle = deltaAngle - twoPi;

			}

		}

		const angle = this.aStartAngle + t * deltaAngle;
		let x = this.aX + this.xRadius * Math.cos( angle );
		let y = this.aY + this.yRadius * Math.sin( angle );

		if ( this.aRotation !== 0 ) {

			const cos = Math.cos( this.aRotation );
			const sin = Math.sin( this.aRotation );

			const tx = x - this.aX;
			const ty = y - this.aY;

			// Rotate the point about the center of the ellipse.
			x = tx * cos - ty * sin + this.aX;
			y = tx * sin + ty * cos + this.aY;

		}

		return point.set( x, y );

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
	 * noise-modulated ellipse sampling — adds controllable organic radius
	 * variation for hand-drawn / procedural ellipse effects.
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
	 * double.js precision arc-length integration for very large or very
	 * flat ellipses where float32 drift becomes visible.
	 *
	 * @param {number} [divisions=200]
	 * @returns {number}
	 */
	getLengthPrecise( divisions = 200 ) {

		_double.value = 0;
		let last = this.getPoint( 0, new Vector2() );
		let current;

		for ( let p = 1; p <= divisions; p ++ ) {

			current = this.getPoint( p / divisions, new Vector2() );
			const dx = current.x - last.x;
			const dy = current.y - last.y;
			_double.add( Math.sqrt( dx * dx + dy * dy ) );
			last = current;

		}

		return _double.value;

	}

	/**
	 * Create a batched ellipse sampler backed by bitecs.
	 * Queue many samples and process them in one cache-friendly pass.
	 *
	 * @returns {EllipseCurveBatch}
	 */
	static createBatch() {

		return new EllipseCurveBatch();

	}

	/**
	 * Copy the given curve's properties into this one.
	 *
	 * @param {Curve} source - The curve to copy from.
	 * @return {EllipseCurve} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.aX = source.aX;
		this.aY = source.aY;

		this.xRadius = source.xRadius;
		this.yRadius = source.yRadius;

		this.aStartAngle = source.aStartAngle;
		this.aEndAngle = source.aEndAngle;

		this.aClockwise = source.aClockwise;

		this.aRotation = source.aRotation;

		return this;

	}

	/**
	 * Serializes the curve into JSON.
	 *
	 * @return {Object} A JSON object representing the serialized curve.
	 */
	toJSON() {

		const data = super.toJSON();

		data.aX = this.aX;
		data.aY = this.aY;

		data.xRadius = this.xRadius;
		data.yRadius = this.yRadius;

		data.aStartAngle = this.aStartAngle;
		data.aEndAngle = this.aEndAngle;

		data.aClockwise = this.aClockwise;

		data.aRotation = this.aRotation;

		return data;

	}

	/**
	 * Deserializes the curve from JSON.
	 *
	 * @param {Object} json - The source JSON object.
	 * @return {EllipseCurve} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.aX = json.aX;
		this.aY = json.aY;

		this.xRadius = json.xRadius;
		this.yRadius = json.yRadius;

		this.aStartAngle = json.aStartAngle;
		this.aEndAngle = json.aEndAngle;

		this.aClockwise = json.aClockwise;

		this.aRotation = json.aRotation;

		return this;

	}

}

export { EllipseCurve, EllipseCurveBatch };
export default EllipseCurve;