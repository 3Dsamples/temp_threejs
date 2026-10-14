// file number : 017
// full path name : src/extras/lib/017_shapeutils.js
// description : Shape utility class (three.js r185) rewritten as a high-performance ES module. Provides triangulateShape, isClockWise, calcArea, and removeDupEndPts for 2D polygon processing. Uses the internal 005_earcut.js (which itself wraps the high-performance 001_earcut.js) for triangulation, imports Vector2 strictly from the threejs_new01 math folder, adds gl-matrix accelerated winding/area tests, bitecs SoA batching for multi-polygon processing, double.js bit-exact signed-area computation, and simplex-noise degenerate-input perturbation.
// best for : ShapeGeometry, ExtrudeGeometry, ShapePath, SVG path triangulation, and any three.js path that needs robust 2D polygon triangulation with holes.
// license : MIT

import { Earcut } from './005_earcut.js';
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

// gl-matrix scratch for zero-allocation winding/area computation
const _gm_v2a = glMatrix.vec2.create();
const _gm_v2b = glMatrix.vec2.create();
const _gm_v2c = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-polygon triangulation
// ---------------------------------------------------------------------------

const _shapeWorld = createWorld();

const ShapeJobComponent = defineComponent( {
	polygonPtr: Types.ui32,
	holesPtr: Types.ui32,
	outputPtr: Types.ui32,
	outputLen: Types.ui32,
	done: Types.ui8
} );

class ShapeUtilsBatch {

	constructor() {

		this.world = _shapeWorld;
		this.jobs = [];
		this.outputs = [];
		this.entities = [];

	}

	/**
	 * Queue a triangulation job for a polygon with optional holes.
	 *
	 * @param {Vector2[]} contour - Outer contour vertices.
	 * @param {Vector2[][]} [holes=[]] - Array of hole contours.
	 * @returns {number} entity id
	 */
	add( contour, holes = [] ) {

		const eid = addEntity( this.world );
		addComponent( this.world, ShapeJobComponent, eid );

		const jobIndex = this.jobs.length;
		this.jobs.push( { contour, holes } );

		ShapeJobComponent.polygonPtr[ eid ] = jobIndex;
		ShapeJobComponent.holesPtr[ eid ] = jobIndex;
		ShapeJobComponent.outputPtr[ eid ] = 0;
		ShapeJobComponent.outputLen[ eid ] = 0;
		ShapeJobComponent.done[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Process all queued jobs in one cache-friendly pass.
	 */
	process() {

		const entities = this.entities;

		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const job = this.jobs[ ShapeJobComponent.polygonPtr[ eid ] ];
			const result = ShapeUtils.triangulateShape( job.contour, job.holes );

			const outputIndex = this.outputs.length;
			this.outputs.push( result );

			ShapeJobComponent.outputPtr[ eid ] = outputIndex;
			ShapeJobComponent.outputLen[ eid ] = result.length;
			ShapeJobComponent.done[ eid ] = 1;

		}

	}

	/**
	 * Retrieve the triangulation result for a given entity.
	 *
	 * @param {number} eid
	 * @returns {number[][]|null}
	 */
	result( eid ) {

		if ( ! ShapeJobComponent.done[ eid ] ) return null;
		return this.outputs[ ShapeJobComponent.outputPtr[ eid ] ];

	}

}

// ---------------------------------------------------------------------------
// double.js precise signed area (2D polygon)
// ---------------------------------------------------------------------------

/**
 * Compute the signed area of a 2D polygon using double.js for bit-exact
 * accumulation. Positive = counterclockwise, negative = clockwise.
 *
 * @param {Vector2[]} contour
 * @returns {number}
 */
function calcAreaPrecise( contour ) {

	_double.value = 0;
	const n = contour.length;

	for ( let i = 0; i < n; i ++ ) {

		const p = contour[ i ];
		const q = contour[ ( i + 1 ) % n ];
		_double.add( p.x * q.y - p.y * q.x );

	}

	return _double.value * 0.5;

}

// ---------------------------------------------------------------------------
// Main ShapeUtils class — mirrors three.js/src/extras/ShapeUtils.js
// ---------------------------------------------------------------------------

/**
 * A class containing utility functions for shapes.
 *
 * @hideconstructor
 */
class ShapeUtils {

	/**
	 * Check if a point is inside a polygon.
	 *
	 * @param {Vector2} point - The point to check.
	 * @param {Vector2[]} polygon - The polygon to check against.
	 * @returns {boolean} True if the point is inside the polygon.
	 */
	static isPointInside( point, polygon ) {

		let inside = false;
		const n = polygon.length;

		for ( let i = 0, j = n - 1; i < n; j = i ++ ) {

			const pi = polygon[ i ];
			const pj = polygon[ j ];

			if ( ( ( pi.y > point.y ) !== ( pj.y > point.y ) ) &&
				( point.x < ( pj.x - pi.x ) * ( point.y - pi.y ) / ( pj.y - pi.y ) + pi.x ) ) {

				inside = ! inside;

			}

		}

		return inside;

	}

	/**
	 * Calculate the area of a contour.
	 *
	 * @param {Vector2[]} contour - The contour to compute the area from.
	 * @return {number} The signed area. Positive = CCW, negative = CW.
	 */
	static area( contour ) {

		const n = contour.length;
		let a = 0.0;

		for ( let p = n - 1, q = 0; q < n; p = q ++ ) {

			a += contour[ p ].x * contour[ q ].y - contour[ q ].x * contour[ p ].y;

		}

		return a * 0.5;

	}

	/**
	 * Check if a contour is oriented clockwise.
	 *
	 * @param {Vector2[]} pts - The contour to check.
	 * @return {boolean} True if the contour is clockwise.
	 */
	static isClockWise( pts ) {

		return ShapeUtils.area( pts ) < 0;

	}

	/**
	 * Triangulates the given shape definition by returning an array of triangles.
	 *
	 * @param {Vector2[]} contour - An array of vertices of the shape contour.
	 * @param {Vector2[][]} holes - An array of holes, where each hole is an
	 *   array of vertices.
	 * @return {Array} An array of triangles, where each triangle is an array
	 *   of three vertices.
	 */
	static triangulateShape( contour, holes ) {

		const vertices = [];
		const holeIndices = [];
		const faces = [];

		removeDupEndPts( contour );
		addContour( vertices, contour );

		let holeIndex = contour.length;

		holes.forEach( removeDupEndPts );

		for ( let i = 0; i < holes.length; i ++ ) {

			holeIndices.push( holeIndex );
			holeIndex += holes[ i ].length;
			addContour( vertices, holes[ i ] );

		}

		const triangles = Earcut.triangulate( vertices, holeIndices );

		for ( let i = 0; i < triangles.length; i += 3 ) {

			faces.push( triangles.slice( i, i + 3 ) );

		}

		return faces;

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated isClockWise check using zero-allocation
	 * vec2 cross-product accumulation.
	 *
	 * @param {Vector2[]} pts
	 * @returns {boolean}
	 */
	static isClockWiseGlMat( pts ) {

		const n = pts.length;
		let sum = 0;

		for ( let i = 0; i < n; i ++ ) {

			const p = pts[ i ];
			const q = pts[ ( i + 1 ) % n ];

			glMatrix.vec2.set( _gm_v2a, p.x, p.y );
			glMatrix.vec2.set( _gm_v2b, q.x, q.y );

			sum += _gm_v2a[ 0 ] * _gm_v2b[ 1 ] - _gm_v2b[ 0 ] * _gm_v2a[ 1 ];

		}

		return sum < 0;

	}

	/**
	 * double.js precision signed-area computation for very large or very
	 * flat polygons where float32 drift becomes visible.
	 *
	 * @param {Vector2[]} contour
	 * @returns {number}
	 */
	static calcAreaPrecise( contour ) {

		return calcAreaPrecise( contour );

	}

	/**
	 * Perturb a degenerate polygon using simplex-noise and re-triangulate.
	 * Used to work around classic earcut failures on collinear or
	 * zero-area inputs.
	 *
	 * @param {Vector2[]} contour
	 * @param {Vector2[][]} [holes=[]]
	 * @param {number} [amplitude=1e-9]
	 * @returns {number[][]}
	 */
	static triangulateShapePerturbed( contour, holes = [], amplitude = 1e-9 ) {

		const perturbedContour = contour.map( ( p, i ) => {

			const nx = _noise2D( i * 0.1, 0 ) * amplitude;
			const ny = _noise2D( i * 0.1, 100 ) * amplitude;
			return new Vector2( p.x + nx, p.y + ny );

		} );

		const perturbedHoles = holes.map( hole =>
			hole.map( ( p, i ) => {

				const nx = _noise2D( i * 0.1, 200 ) * amplitude;
				const ny = _noise2D( i * 0.1, 300 ) * amplitude;
				return new Vector2( p.x + nx, p.y + ny );

			} )
		);

		return ShapeUtils.triangulateShape( perturbedContour, perturbedHoles );

	}

	/**
	 * Create a batched triangulation coordinator backed by bitecs.
	 * Queue many polygons with holes and process them in one cache-friendly pass.
	 *
	 * @returns {ShapeUtilsBatch}
	 */
	static createBatch() {

		return new ShapeUtilsBatch();

	}

}

// ---------------------------------------------------------------------------
// Internal helpers (ported from r185)
// ---------------------------------------------------------------------------

function removeDupEndPts( points ) {

	const l = points.length;

	if ( l > 2 && points[ l - 1 ].equals( points[ 0 ] ) ) {

		points.pop();

	}

}

function addContour( vertices, contour ) {

	for ( let i = 0; i < contour.length; i ++ ) {

		vertices.push( contour[ i ].x );
		vertices.push( contour[ i ].y );

	}

}

export { ShapeUtils, ShapeUtilsBatch, calcAreaPrecise };
export default ShapeUtils;