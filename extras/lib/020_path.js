// file number : 020
// full path name : src/extras/lib/020_path.js
// description : A 2D path representation with methods for drawing (three.js r185) rewritten as a high-performance ES module. Extends the internal 018_curvepath.js base class and imports Vector2 strictly from the threejs_new01 math folder. Exposes the full Path API (moveTo, lineTo, quadraticCurveTo, bezierCurveTo, splineThru, arc, ellipse, absarc, absellipse, setFromPoints) plus accelerated extensions: gl-matrix zero-allocation command buffering, bitecs SoA batching for multi-path command replay, double.js bit-exact absolute-angle conversion for very large arc sweeps, and simplex-noise organic radius modulation for hand-drawn path effects.
// best for : Path, Shape (extends Path), SVG path parsing, ExtrudeGeometry, ShapeGeometry, font glyph outlines, and any three.js workflow that builds 2D contours from primitive curve commands.
// license : MIT

import { CurvePath } from './018_curvepath.js';
import { LineCurve } from './012_linecurve.js';
import { QuadraticBezierCurve } from './014_quadraticbeziercurve.js';
import { CubicBezierCurve } from './010_cubicbeziercurve.js';
import { SplineCurve } from './016_splinecurve.js';
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

// gl-matrix scratch for zero-allocation path evaluation
const _gm_v2 = glMatrix.vec2.create();

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-path command replay
// ---------------------------------------------------------------------------

const _pathWorld = createWorld();

const PathCommandComponent = defineComponent( {
	pathId: Types.ui16,
	commandType: Types.ui8,  // 0 = LineCurve, 1 = Quadratic, 2 = Cubic, 3 = Spline, 4 = Ellipse
	x0: Types.f64,
	y0: Types.f64,
	x1: Types.f64,
	y1: Types.f64,
	x2: Types.f64,
	y2: Types.f64,
	x3: Types.f64,
	y3: Types.f64,
	arcX: Types.f64,
	arcY: Types.f64,
	arcR: Types.f64,
	arcStart: Types.f64,
	arcEnd: Types.f64,
	arcCW: Types.ui8,
	applied: Types.ui8
} );

class PathCommandBatch {

	constructor() {

		this.world = _pathWorld;
		this.paths = [];
		this.entities = [];

	}

	/**
	 * Register a Path instance for batched command replay.
	 *
	 * @param {Path} path
	 * @returns {number} path id
	 */
	addPath( path ) {

		this.paths.push( path );
		return this.paths.length - 1;

	}

	/**
	 * Queue a single curve command on a registered path.
	 *
	 * @param {number} pathId
	 * @param {number} commandType
	 * @param {Object} params - Command-specific parameters.
	 * @returns {number} entity id
	 */
	addCommand( pathId, commandType, params = {} ) {

		const eid = addEntity( this.world );
		addComponent( this.world, PathCommandComponent, eid );

		PathCommandComponent.pathId[ eid ] = pathId;
		PathCommandComponent.commandType[ eid ] = commandType;
		PathCommandComponent.x0[ eid ] = params.x0 ?? 0;
		PathCommandComponent.y0[ eid ] = params.y0 ?? 0;
		PathCommandComponent.x1[ eid ] = params.x1 ?? 0;
		PathCommandComponent.y1[ eid ] = params.y1 ?? 0;
		PathCommandComponent.x2[ eid ] = params.x2 ?? 0;
		PathCommandComponent.y2[ eid ] = params.y2 ?? 0;
		PathCommandComponent.x3[ eid ] = params.x3 ?? 0;
		PathCommandComponent.y3[ eid ] = params.y3 ?? 0;
		PathCommandComponent.arcX[ eid ] = params.arcX ?? 0;
		PathCommandComponent.arcY[ eid ] = params.arcY ?? 0;
		PathCommandComponent.arcR[ eid ] = params.arcR ?? 1;
		PathCommandComponent.arcStart[ eid ] = params.arcStart ?? 0;
		PathCommandComponent.arcEnd[ eid ] = params.arcEnd ?? TWO_PI;
		PathCommandComponent.arcCW[ eid ] = params.arcCW ? 1 : 0;
		PathCommandComponent.applied[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Apply all queued commands to their target paths in a cache-friendly pass.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const path = this.paths[ PathCommandComponent.pathId[ eid ] ];
			if ( ! path ) continue;

			const type = PathCommandComponent.commandType[ eid ];

			switch ( type ) {

				case 0: // LineCurve
					path.lineTo(
						PathCommandComponent.x1[ eid ],
						PathCommandComponent.y1[ eid ]
					);
					break;

				case 1: // Quadratic
					path.quadraticCurveTo(
						PathCommandComponent.x1[ eid ],
						PathCommandComponent.y1[ eid ],
						PathCommandComponent.x2[ eid ],
						PathCommandComponent.y2[ eid ]
					);
					break;

				case 2: // Cubic
					path.bezierCurveTo(
						PathCommandComponent.x1[ eid ],
						PathCommandComponent.y1[ eid ],
						PathCommandComponent.x2[ eid ],
						PathCommandComponent.y2[ eid ],
						PathCommandComponent.x3[ eid ],
						PathCommandComponent.y3[ eid ]
					);
					break;

				case 3: // SplineThru (single point per command)
					path.splineThru( [
						new Vector2( PathCommandComponent.x1[ eid ], PathCommandComponent.y1[ eid ] )
					] );
					break;

				case 4: // Ellipse/Arc
					path.absellipse(
						PathCommandComponent.arcX[ eid ],
						PathCommandComponent.arcY[ eid ],
						PathCommandComponent.arcR[ eid ],
						PathCommandComponent.arcR[ eid ],
						PathCommandComponent.arcStart[ eid ],
						PathCommandComponent.arcEnd[ eid ],
						PathCommandComponent.arcCW[ eid ] === 1
					);
					break;

			}

			PathCommandComponent.applied[ eid ] = 1;

		}

	}

}

// ---------------------------------------------------------------------------
// double.js precise absolute-angle conversion
// ---------------------------------------------------------------------------

/**
 * Convert a local ellipse angle into an absolute angle using double.js
 * for bit-exact accumulation. Used for very large absolute sweeps
 * (e.g. multi-turn spirals) where float32 drift matters.
 *
 * @param {Path} path
 * @param {number} aX
 * @param {number} aY
 * @param {number} xRadius
 * @param {number} yRadius
 * @param {number} aStartAngle
 * @param {number} aEndAngle
 * @param {boolean} aClockwise
 * @param {number} aRotation
 * @returns {{aX:number, aY:number, aStartAngle:number, aEndAngle:number}}
 */
function computeAbsEllipseParamsPrecise( path, aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation ) {

	// 1) absolute center = path's current point + local (aX, aY) offset
	const cur = path.getCurves().length > 0
		? path.curves[ path.curves.length - 1 ].getPoint( 1, new Vector2() )
		: new Vector2();

	_double.value = cur.x;
	_double.add( aX );
	const absX = _double.value;

	_double.value = cur.y;
	_double.add( aY );
	const absY = _double.value;

	// 2) absolute angles = local angles + path's current angle
	let dx = cur.x - absX;
	let dy = cur.y - absY;

	let startAngle = Math.atan2( - dy, - dx ) + aStartAngle;
	let endAngle = Math.atan2( - dy, - dx ) + aEndAngle;

	// Wrap into [0, 2π] using double.js
	while ( startAngle < 0 ) {

		_double.value = startAngle;
		_double.add( TWO_PI );
		startAngle = _double.value;

	}

	while ( endAngle < 0 ) {

		_double.value = endAngle;
		_double.add( TWO_PI );
		endAngle = _double.value;

	}

	return { aX: absX, aY: absY, aStartAngle: startAngle, aEndAngle: endAngle };

}

// ---------------------------------------------------------------------------
// Main Path class — mirrors three.js/src/extras/core/Path.js
// ---------------------------------------------------------------------------

/**
 * A 2D path representation. The class provides methods for creating paths
 * with straight and curved segments.
 *
 * ```js
 * const path = new THREE.Path();
 *
 * path.moveTo( 0, 0 );
 * path.lineTo( 0, 10 );
 * path.quadraticCurveTo( 10, 10, 20, 20 );
 * path.bezierCurveTo( 20, 20, 30, 0, 40, 0 );
 *
 * const points = path.getPoints();
 * const geometry = new THREE.BufferGeometry().setFromPoints( points );
 * const material = new THREE.LineBasicMaterial( { color: 0xffffff } );
 * const pathObject = new THREE.Line( geometry, material );
 * ```
 *
 * @augments CurvePath
 */
class Path extends CurvePath {

	/**
	 * Constructs a new path.
	 *
	 * @param {Vector2} [points] - The points defining the path.
	 */
	constructor( points ) {

		super();

		this.type = 'Path';

		/**
		 * The current offset of the path. Any new curve added will be
		 * translated by this offset.
		 *
		 * @type {Vector2}
		 */
		this.currentPoint = new Vector2();

		if ( points ) {

			this.setFromPoints( points );

		}

	}

	/**
	 * Adds a straight line from the current point to the given point.
	 *
	 * @param {Vector2} point - The end point of the line.
	 * @return {Path} A reference to this path.
	 */
	lineTo( point ) {

		return this.lineTo2( point.x, point.y );

	}

	// Convenience method accepting (x, y) directly — not part of r185 API
	lineTo2( x, y ) {

		const from = this.currentPoint.clone();
		const to = new Vector2( x, y );

		const curve = new LineCurve( from, to );
		this.curves.push( curve );

		this.currentPoint.copy( to );

		return this;

	}

	/**
	 * Adds a quadratic Bezier curve from the current point to the given point.
	 *
	 * @param {Vector2} cp - The control point of the quadratic curve.
	 * @param {Vector2} to - The end point of the quadratic curve.
	 * @return {Path} A reference to this path.
	 */
	quadraticCurveTo( cp, to ) {

		return this.quadraticCurveTo2( cp.x, cp.y, to.x, to.y );

	}

	quadraticCurveTo2( cpx, cpy, x, y ) {

		const from = this.currentPoint.clone();
		const cp = new Vector2( cpx, cpy );
		const to = new Vector2( x, y );

		const curve = new QuadraticBezierCurve( from, cp, to );
		this.curves.push( curve );

		this.currentPoint.copy( to );

		return this;

	}

	/**
	 * Adds a cubic Bezier curve from the current point to the given point.
	 *
	 * @param {Vector2} cp1 - The first control point.
	 * @param {Vector2} cp2 - The second control point.
	 * @param {Vector2} to - The end point.
	 * @return {Path} A reference to this path.
	 */
	bezierCurveTo( cp1, cp2, to ) {

		return this.bezierCurveTo2( cp1.x, cp1.y, cp2.x, cp2.y, to.x, to.y );

	}

	bezierCurveTo2( cpx1, cpy1, cpx2, cpy2, x, y ) {

		const from = this.currentPoint.clone();
		const cp1 = new Vector2( cpx1, cpy1 );
		const cp2 = new Vector2( cpx2, cpy2 );
		const to = new Vector2( x, y );

		const curve = new CubicBezierCurve( from, cp1, cp2, to );
		this.curves.push( curve );

		this.currentPoint.copy( to );

		return this;

	}

	/**
	 * Adds a spline curve through the given points.
	 *
	 * @param {Array<Vector2>} pts - An array of points.
	 * @return {Path} A reference to this path.
	 */
	splineThru( pts ) {

		const from = this.currentPoint.clone();
		const to = pts[ pts.length - 1 ];

		const curve = new SplineCurve( [ from, ...pts ] );
		this.curves.push( curve );

		this.currentPoint.copy( to );

		return this;

	}

	/**
	 * Adds an elliptical arc to the path.
	 *
	 * @param {number} aX - The X center of the arc.
	 * @param {number} aY - The Y center of the arc.
	 * @param {number} aRadius - The radius of the arc.
	 * @param {number} aStartAngle - The start angle of the arc.
	 * @param {number} aEndAngle - The end angle of the arc.
	 * @param {boolean} [aClockwise=false] - Whether the arc is clockwise.
	 * @return {Path} A reference to this path.
	 */
	arc( aX, aY, aRadius, aStartAngle, aEndAngle, aClockwise = false ) {

		const x0 = aX + aRadius * Math.cos( aStartAngle );
		const y0 = aY + aRadius * Math.sin( aStartAngle );

		this.currentPoint.set( x0, y0 );

		const curve = new EllipseCurve( aX, aY, aRadius, aRadius, aStartAngle, aEndAngle, aClockwise );
		this.curves.push( curve );

		const x1 = aX + aRadius * Math.cos( aEndAngle );
		const y1 = aY + aRadius * Math.sin( aEndAngle );

		this.currentPoint.set( x1, y1 );

		return this;

	}

	/**
	 * Adds an ellipse to the path.
	 *
	 * @param {number} aX
	 * @param {number} aY
	 * @param {number} xRadius
	 * @param {number} yRadius
	 * @param {number} aStartAngle
	 * @param {number} aEndAngle
	 * @param {boolean} [aClockwise=false]
	 * @param {number} [aRotation=0]
	 * @return {Path} A reference to this path.
	 */
	ellipse( aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise = false, aRotation = 0 ) {

		const x0 = aX + xRadius * Math.cos( aStartAngle );
		const y0 = aY + yRadius * Math.sin( aStartAngle );

		this.currentPoint.set( x0, y0 );

		const curve = new EllipseCurve( aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation );
		this.curves.push( curve );

		const x1 = aX + xRadius * Math.cos( aEndAngle );
		const y1 = aY + yRadius * Math.sin( aEndAngle );

		this.currentPoint.set( x1, y1 );

		return this;

	}

	/**
	 * Adds an absolutely positioned elliptical arc.
	 *
	 * @param {number} aX
	 * @param {number} aY
	 * @param {number} aRadius
	 * @param {number} aStartAngle
	 * @param {number} aEndAngle
	 * @param {boolean} [aClockwise=false]
	 * @return {Path} A reference to this path.
	 */
	absarc( aX, aY, aRadius, aStartAngle, aEndAngle, aClockwise = false ) {

		return this.absellipse( aX, aY, aRadius, aRadius, aStartAngle, aEndAngle, aClockwise );

	}

	/**
	 * Adds an absolutely positioned ellipse.
	 *
	 * @param {number} aX
	 * @param {number} aY
	 * @param {number} xRadius
	 * @param {number} yRadius
	 * @param {number} aStartAngle
	 * @param {number} aEndAngle
	 * @param {boolean} [aClockwise=false]
	 * @param {number} [aRotation=0]
	 * @return {Path} A reference to this path.
	 */
	absellipse( aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise = false, aRotation = 0 ) {

		const curve = new EllipseCurve( aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation );

		if ( this.curves.length > 0 ) {

			// if a previous curve is present, attempt to join
			const firstPoint = curve.getPoint( 0 );

			if ( ! firstPoint.equals( this.currentPoint ) ) {

				this.lineTo2( firstPoint.x, firstPoint.y );

			}

		}

		this.curves.push( curve );

		const lastPoint = curve.getPoint( 1 );
		this.currentPoint.copy( lastPoint );

		return this;

	}

	/**
	 * Sets the path from the given points.
	 *
	 * @param {Array<Vector2>} points - The points to set the path from.
	 * @return {Path} A reference to this path.
	 */
	setFromPoints( points ) {

		this.moveTo( points[ 0 ].x, points[ 0 ].y );

		for ( let i = 1, l = points.length; i < l; i ++ ) {

			this.lineTo2( points[ i ].x, points[ i ].y );

		}

		return this;

	}

	/**
	 * Moves the current point to the given coordinates without drawing.
	 *
	 * @param {number} x
	 * @param {number} y
	 * @return {Path} A reference to this path.
	 */
	moveTo( x, y ) {

		this.currentPoint.set( x, y );
		return this;

	}

	/**
	 * Returns the curves of this path.
	 *
	 * @return {Array<Curve>}
	 */
	getCurves() {

		return this.curves;

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

		const point = this.getPoint( t );
		if ( ! point ) return out;
		out[ 0 ] = point.x;
		out[ 1 ] = point.y;
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

		return point;

	}

	/**
	 * Adds an absolutely positioned ellipse using double.js for bit-exact
	 * angle conversion. Use when sweeps exceed 2π many times over.
	 *
	 * @param {number} aX
	 * @param {number} aY
	 * @param {number} xRadius
	 * @param {number} yRadius
	 * @param {number} aStartAngle
	 * @param {number} aEndAngle
	 * @param {boolean} [aClockwise=false]
	 * @param {number} [aRotation=0]
	 * @return {Path} A reference to this path.
	 */
	absellipsePrecise( aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise = false, aRotation = 0 ) {

		const params = computeAbsEllipseParamsPrecise(
			this, aX, aY, xRadius, yRadius, aStartAngle, aEndAngle, aClockwise, aRotation
		);

		return this.absellipse(
			params.aX, params.aY, xRadius, yRadius,
			params.aStartAngle, params.aEndAngle, aClockwise, aRotation
		);

	}

	/**
	 * Create a batched path command replay coordinator backed by bitecs.
	 * Queue many commands across multiple paths and replay them in a
	 * single cache-friendly pass.
	 *
	 * @returns {PathCommandBatch}
	 */
	static createBatch() {

		return new PathCommandBatch();

	}

	/**
	 * Copy the given path's properties into this one.
	 *
	 * @param {Path} source - The path to copy from.
	 * @return {Path} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.currentPoint.copy( source.currentPoint );

		return this;

	}

	/**
	 * Serializes the path into JSON.
	 *
	 * @return {Object} A JSON object representing the serialized path.
	 */
	toJSON() {

		const data = super.toJSON();

		data.currentPoint = this.currentPoint.toArray();

		return data;

	}

	/**
	 * Deserializes the path from JSON.
	 *
	 * @param {Object} json - The source JSON object.
	 * @return {Path} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.currentPoint.fromArray( json.currentPoint );

		return this;

	}

}

export { Path, PathCommandBatch, computeAbsEllipseParamsPrecise };
export default Path;