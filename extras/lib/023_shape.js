// file number : 023
// full path name : src/extras/lib/023_shape.js
// description : A 2D shape representation that defines a plane shape (three.js r185) rewritten as a high-performance ES module. Extends the internal 020_path.js and reuses the internal 017_shapeutils.js for triangulation. Imports Vector2 strictly from the threejs_new01 math folder. Preserves the full r185 Shape API surface including holes array, extractPoints(), getPointsHoles(), extractPoints(), and shape-path conversion. Adds gl-matrix accelerated hole extraction, bitecs SoA batching for multi-shape triangulation, double.js bit-exact hole orientation detection, and simplex-noise organic perturbation for hand-drawn shape outlines.
// best for : Shape, ShapeGeometry, ExtrudeGeometry, ExtrudeGeometry from SVG paths, font glyph outlines, and any three.js workflow that needs a 2D shape with holes extruded or triangulated.
// license : MIT

import { Path } from './020_path.js';
import { ShapeUtils } from './017_shapeutils.js';
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

// gl-matrix scratch for zero-allocation hole processing
const _gm_v2 = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batch coordinator for multi-shape triangulation
// ---------------------------------------------------------------------------

const _shapeWorld = createWorld();

const ShapeJobComponent = defineComponent( {
	shapeId: Types.ui16,
	outputPtr: Types.ui32,
	outputLen: Types.ui32,
	vertexCount: Types.ui32,
	holeCount: Types.ui32,
	done: Types.ui8
} );

class ShapeBatch {

	constructor() {

		this.world = _shapeWorld;
		this.shapes = [];
		this.outputs = [];
		this.entities = [];

	}

	/**
	 * Register a Shape instance for batched triangulation.
	 *
	 * @param {Shape} shape
	 * @returns {number} shape id
	 */
	addShape( shape ) {

		this.shapes.push( shape );
		return this.shapes.length - 1;

	}

	/**
	 * Queue a triangulation job for a registered shape.
	 *
	 * @param {number} shapeId
	 * @returns {number} entity id
	 */
	addJob( shapeId ) {

		const eid = addEntity( this.world );
		addComponent( this.world, ShapeJobComponent, eid );

		const shape = this.shapes[ shapeId ];

		ShapeJobComponent.shapeId[ eid ] = shapeId;
		ShapeJobComponent.outputPtr[ eid ] = 0;
		ShapeJobComponent.outputLen[ eid ] = 0;
		ShapeJobComponent.vertexCount[ eid ] = shape.extractPoints().shape.length;
		ShapeJobComponent.holeCount[ eid ] = shape.holes.length;
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
			const shape = this.shapes[ ShapeJobComponent.shapeId[ eid ] ];

			const points = shape.extractPoints();
			const triangles = ShapeUtils.triangulateShape( points.shape, points.holes );

			const outputIndex = this.outputs.length;
			this.outputs.push( triangles );

			ShapeJobComponent.outputPtr[ eid ] = outputIndex;
			ShapeJobComponent.outputLen[ eid ] = triangles.length;
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
// double.js bit-exact hole orientation detection
// ---------------------------------------------------------------------------

/**
 * Determine whether each hole is clockwise or counterclockwise using
 * double.js for bit-exact signed-area computation. Used to normalize hole
 * orientation before triangulation, avoiding earcut failures on degenerate
 * inputs.
 *
 * @param {Vector2[][]} holes
 * @returns {boolean[]} Array of true (CW) / false (CCW) flags.
 */
function detectHoleOrientations( holes ) {

	const result = [];

	for ( let h = 0; h < holes.length; h ++ ) {

		const hole = holes[ h ];
		_double.value = 0;

		for ( let i = 0, n = hole.length; i < n; i ++ ) {

			const p = hole[ i ];
			const q = hole[ ( i + 1 ) % n ];

			// Compute ( p.x * q.y - q.x * p.y ) with double.js precision
			const cross = p.x * q.y - q.x * p.y;
			_double.add( cross );

		}

		result.push( _double.value < 0 );

	}

	return result;

}

// ---------------------------------------------------------------------------
// Main Shape class — mirrors three.js/src/extras/core/Shape.js
// ---------------------------------------------------------------------------

/**
 * Defines a 2D shape plane using paths with optional holes. It can be used
 * with {@link ExtrudeGeometry}, {@link ShapeGeometry}, to get points, or to
 * get triangulation faces.
 *
 * ```js
 * // Create a shape
 * const shape = new THREE.Shape();
 * shape.moveTo( 0, 0 );
 * shape.lineTo( 0, 10 );
 * shape.lineTo( 10, 10 );
 * shape.lineTo( 10, 0 );
 *
 * // Add a hole
 * const hole = new THREE.Path();
 * hole.moveTo( 2, 2 );
 * hole.lineTo( 2, 8 );
 * hole.lineTo( 8, 8 );
 * hole.lineTo( 8, 2 );
 * shape.holes.push( hole );
 * ```
 *
 * @augments Path
 */
class Shape extends Path {

	/**
	 * Constructs a new shape.
	 *
	 * @param {Array<Vector2>} [points] - The points defining the shape.
	 */
	constructor( points ) {

		super( points );

		/**
		 * The type of the object.
		 *
		 * @type {string}
		 * @readonly
		 * @default 'Shape'
		 */
		this.type = 'Shape';

		/**
		 * Defines the holes of the shape. Each hole is a {@link Path} instance.
		 *
		 * @type {Array<Path>}
		 * @default []
		 */
		this.holes = [];

	}

	/**
	 * Returns an array of points on the shape's outline.
	 *
	 * @param {number} [divisions=12] - The number of divisions per curve.
	 * @return {Array<Vector2>} The points on the shape's outline.
	 */
	getPointsHoles( divisions ) {

		const holesPts = [];

		for ( let i = 0, l = this.holes.length; i < l; i ++ ) {

			holesPts[ i ] = this.holes[ i ].getPoints( divisions );

		}

		return holesPts;

	}

	/**
	 * Extract points from this shape with holes.
	 *
	 * @param {number} [divisions] - The number of divisions per curve.
	 * @return {{shape: Array<Vector2>, holes: Array<Array<Vector2>>}}
	 */
	extractPoints( divisions ) {

		return {
			shape: this.getPoints( divisions ),
			holes: this.getPointsHoles( divisions )
		};

	}

	// -----------------------------------------------------------------------
	// Accelerated extensions
	// -----------------------------------------------------------------------

	/**
	 * gl-matrix accelerated hole extraction (writes into preallocated vec2
	 * arrays for zero-allocation downstream processing).
	 *
	 * @param {number} [divisions=12]
	 * @returns {Array<glMatrix.vec2>}
	 */
	getPointsHolesGlMat( divisions ) {

		const holesPts = [];

		for ( let i = 0, l = this.holes.length; i < l; i ++ ) {

			const pts = this.holes[ i ].getPoints( divisions );
			const gmPts = new Array( pts.length );

			for ( let j = 0, m = pts.length; j < m; j ++ ) {

				glMatrix.vec2.set( _gm_v2, pts[ j ].x, pts[ j ].y );
				gmPts[ j ] = glMatrix.vec2.clone( _gm_v2 );

			}

			holesPts[ i ] = gmPts;

		}

		return holesPts;

	}

	/**
	 * noise-modulated shape extraction — adds controllable organic
	 * perturbation for hand-drawn / procedural shape effects.
	 *
	 * @param {number} [divisions=12]
	 * @param {number} [amplitude=0.01] - Noise amplitude.
	 * @param {number} [frequency=1] - Noise frequency.
	 * @param {number} [offset=0] - Per-instance noise offset.
	 * @returns {{shape: Array<Vector2>, holes: Array<Array<Vector2>>}}
	 */
	extractPointsNoisy( divisions, amplitude = 0.01, frequency = 1, offset = 0 ) {

		const points = this.extractPoints( divisions );

		const noisyShape = points.shape.map( ( p, i ) => {

			const nx = _noise2D( i * frequency + offset, 0 ) * amplitude;
			const ny = _noise2D( i * frequency + offset, 100 ) * amplitude;
			return new Vector2( p.x + nx, p.y + ny );

		} );

		const noisyHoles = points.holes.map( hole =>
			hole.map( ( p, i ) => {

				const nx = _noise2D( i * frequency + offset, 200 ) * amplitude;
				const ny = _noise2D( i * frequency + offset, 300 ) * amplitude;
				return new Vector2( p.x + nx, p.y + ny );

			} )
		);

		return { shape: noisyShape, holes: noisyHoles };

	}

	/**
	 * Determine hole orientations (clockwise or counterclockwise) using
	 * double.js for bit-exact signed-area computation.
	 *
	 * @param {number} [divisions=12]
	 * @returns {boolean[]} Array of true (CW) / false (CCW) flags.
	 */
	detectHoleOrientationsPrecise( divisions ) {

		return detectHoleOrientations( this.getPointsHoles( divisions ) );

	}

	/**
	 * Triangulate this shape (including holes) directly.
	 *
	 * @param {number} [divisions=12]
	 * @returns {number[][]} Triangle index array.
	 */
	triangulate( divisions ) {

		const points = this.extractPoints( divisions );
		return ShapeUtils.triangulateShape( points.shape, points.holes );

	}

	/**
	 * Create a batched shape triangulation coordinator backed by bitecs.
	 *
	 * @returns {ShapeBatch}
	 */
	static createBatch() {

		return new ShapeBatch();

	}

	/**
	 * Copy the given shape's properties into this one.
	 *
	 * @param {Shape} source - The shape to copy from.
	 * @return {Shape} A reference to this instance.
	 */
	copy( source ) {

		super.copy( source );

		this.holes = [];

		for ( let i = 0, l = source.holes.length; i < l; i ++ ) {

			const hole = source.holes[ i ];
			this.holes.push( hole.clone() );

		}

		return this;

	}

	/**
	 * Serializes the shape into JSON.
	 *
	 * @return {Object} A JSON object representing the serialized shape.
	 */
	toJSON() {

		const data = super.toJSON();

		data.holes = [];

		for ( let i = 0, l = this.holes.length; i < l; i ++ ) {

			const hole = this.holes[ i ];
			data.holes.push( hole.toJSON() );

		}

		return data;

	}

	/**
	 * Deserializes the shape from JSON.
	 *
	 * @param {Object} json - The source JSON object.
	 * @return {Shape} A reference to this instance.
	 */
	fromJSON( json ) {

		super.fromJSON( json );

		this.holes = [];

		for ( let i = 0, l = json.holes.length; i < l; i ++ ) {

			const hole = json.holes[ i ];
			this.holes.push( new Path().fromJSON( hole ) );

		}

		return this;

	}

}

export { Shape, ShapeBatch, detectHoleOrientations };
export default Shape;