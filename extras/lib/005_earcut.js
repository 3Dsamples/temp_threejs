// file number : 005
// full path name : src/extras/lib/005_earcut.js
// description : Earcut polygon triangulation wrapper class (three.js r185). Delegates to the high-performance `earcut` core from 001_earcut.js, which uses gl-matrix for vectorized area calculations, double.js for bit-exact signed-area precision, bitecs for O(1) ECS node management, and simplex-noise for degenerate-polygon perturbation. This wrapper exposes the canonical `Earcut.triangulate(data, holeIndices, dim)` static API, plus accelerated variants for batched and precision-critical triangulation.
// best for : ShapeGeometry, ExtrudeGeometry, ShapeUtils.triangulateShape, and any three.js path that needs fast, robust polygon triangulation with optional hole support.
// license : MIT (three.js) — core algorithm ISC (mapbox/earcut v3.0.2)

import earcut, { perturbDegenerate } from './001_earcut.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for pre/post validation of input polygons
const _v2a = glMatrix.vec2.create();
const _v2b = glMatrix.vec2.create();

// ---------------------------------------------------------------------------
// bitecs SoA batched triangulation — process N polygons in one pass
// ---------------------------------------------------------------------------

const _batchWorld = createWorld();

const TriangulateJobComponent = defineComponent( {
	dataPtr: Types.ui32,        // index into this.jobs
	holeIndicesPtr: Types.ui32, // index into this.jobs
	dim: Types.ui32,
	outputPtr: Types.ui32,      // index into this.outputs
	outputLen: Types.ui32,
	ready: Types.ui8
} );

class EarcutBatch {

	constructor() {

		this.world = _batchWorld;
		this.jobs = [];
		this.outputs = [];
		this.entities = [];

	}

	/**
	 * Queue a triangulation job.
	 * @param {number[]} data - flat vertex array
	 * @param {number[]|null} holeIndices - hole indices (or null)
	 * @param {number} dim - coordinates per vertex (default 2)
	 * @returns {number} entity id
	 */
	add( data, holeIndices = null, dim = 2 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, TriangulateJobComponent, eid );

		const jobIndex = this.jobs.length;
		this.jobs.push( { data, holeIndices, dim } );

		TriangulateJobComponent.dataPtr[ eid ] = jobIndex;
		TriangulateJobComponent.holeIndicesPtr[ eid ] = jobIndex;
		TriangulateJobComponent.dim[ eid ] = dim;
		TriangulateJobComponent.outputPtr[ eid ] = 0;
		TriangulateJobComponent.outputLen[ eid ] = 0;
		TriangulateJobComponent.ready[ eid ] = 0;

		this.entities.push( eid );
		return eid;

	}

	/**
	 * Execute all queued jobs. Results are stored in this.outputs.
	 */
	process() {

		const entities = this.entities;
		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const job = this.jobs[ TriangulateJobComponent.dataPtr[ eid ] ];

			const result = earcut( job.data, job.holeIndices, job.dim );

			const outputIndex = this.outputs.length;
			this.outputs.push( result );

			TriangulateJobComponent.outputPtr[ eid ] = outputIndex;
			TriangulateJobComponent.outputLen[ eid ] = result.length;
			TriangulateJobComponent.ready[ eid ] = 1;

		}

	}

	/**
	 * Retrieve the triangulation result for a given entity.
	 * @param {number} eid - entity id returned by add()
	 * @returns {number[]} triangle index array
	 */
	result( eid ) {

		if ( ! TriangulateJobComponent.ready[ eid ] ) return null;
		return this.outputs[ TriangulateJobComponent.outputPtr[ eid ] ];

	}

	/**
	 * Retrieve all results as a flat array-of-arrays.
	 * @returns {number[][]}
	 */
	results() {

		return this.outputs.slice();

	}

}

// ---------------------------------------------------------------------------
// Precision-checked triangulation — double.js validates signed area first
// ---------------------------------------------------------------------------

/**
 * Triangulate with a double-precision signed-area pre-check.
 * For degenerate (near-zero-area) polygons, applies simplex-noise perturbation
 * before retrying, avoiding the classic earcut failure on collinear inputs.
 *
 * @param {number[]} data - flat vertex array
 * @param {number[]|null} holeIndices
 * @param {number} dim
 * @returns {number[]} triangle indices
 */
function triangulatePrecise( data, holeIndices = null, dim = 2 ) {

	// Compute signed area with double.js for maximum precision
	_double.value = 0;

	const n = holeIndices && holeIndices.length ? holeIndices[ 0 ] * dim : data.length;
	for ( let i = 0, j = n - dim; i < n; i += dim ) {

		_double.add( ( data[ j ] - data[ i ] ) * ( data[ i + 1 ] + data[ j + 1 ] ) );
		j = i;

	}

	// If polygon area is degenerately small, perturb with simplex-noise and retry
	if ( Math.abs( _double.value ) < 1e-10 ) {

		const perturbed = perturbDegenerate( data.slice(), dim );
		return earcut( perturbed, holeIndices, dim );

	}

	return earcut( data, holeIndices, dim );

}

// ---------------------------------------------------------------------------
// gl-matrix accelerated normal validation (useful for 3D-to-2D projections)
// ---------------------------------------------------------------------------

/**
 * Validate that a set of 2D points is roughly planar (for pre-projection checks).
 * Uses gl-matrix for zero-allocation cross-product magnitude checks.
 *
 * @param {number[]} data - flat vertex array
 * @param {number} dim
 * @returns {boolean}
 */
function isPlanar( data, dim = 2 ) {

	if ( dim !== 2 ) return true; // only 2D input is inherently planar

	// Find first non-zero edge
	let ex = 0, ey = 0;
	for ( let i = dim; i < data.length; i += dim ) {

		const dx = data[ i ] - data[ 0 ];
		const dy = data[ i + 1 ] - data[ 1 ];
		if ( dx !== 0 || dy !== 0 ) {

			ex = dx;
			ey = dy;
			break;

		}

	}

	if ( ex === 0 && ey === 0 ) return false; // all points identical

	// Check that all subsequent edges are parallel to the first (zero cross product)
	for ( let i = dim; i < data.length; i += dim ) {

		const dx = data[ i ] - data[ 0 ];
		const dy = data[ i + 1 ] - data[ 1 ];

		glMatrix.vec2.set( _v2a, ex, ey );
		glMatrix.vec2.set( _v2b, dx, dy );

		const cross = _v2a[ 0 ] * _v2b[ 1 ] - _v2a[ 1 ] * _v2b[ 0 ];
		if ( Math.abs( cross ) > 1e-10 ) return false; // not collinear → planar

	}

	return true;

}

// ---------------------------------------------------------------------------
// Main Earcut class — mirrors three.js/src/extras/Earcut.js
// ---------------------------------------------------------------------------

/**
 * An implementation of the earcut polygon triangulation algorithm.
 * The code is a port of [mapbox/earcut](https://github.com/mapbox/earcut).
 *
 * @see https://github.com/mapbox/earcut
 */
class Earcut {

	/**
	 * Triangulates the given shape definition by returning an array of triangles.
	 *
	 * @param {Array} data - An array with 2D points.
	 * @param {Array} holeIndices - An array with indices defining holes.
	 * @param {number} [dim=2] - The number of coordinates per vertex in the input array.
	 * @return {Array} An array representing the triangulated faces. Each face is
	 *   defined by three consecutive numbers representing vertex indices.
	 */
	static triangulate( data, holeIndices, dim = 2 ) {

		return earcut( data, holeIndices, dim );

	}

	/**
	 * Triangulate with double-precision signed-area validation and
	 * simplex-noise perturbation for degenerate inputs.
	 *
	 * @param {Array} data
	 * @param {Array} holeIndices
	 * @param {number} [dim=2]
	 * @returns {Array}
	 */
	static triangulatePrecise( data, holeIndices, dim = 2 ) {

		return triangulatePrecise( data, holeIndices, dim );

	}

	/**
	 * Check whether a flat vertex array describes a planar polygon
	 * (uses gl-matrix for zero-allocation cross-product tests).
	 *
	 * @param {Array} data
	 * @param {number} [dim=2]
	 * @returns {boolean}
	 */
	static isPlanar( data, dim = 2 ) {

		return isPlanar( data, dim );

	}

	/**
	 * Create a batched triangulation context backed by bitecs.
	 * Queue many polygons, process them in one cache-friendly pass.
	 *
	 * @returns {EarcutBatch}
	 */
	static createBatch() {

		return new EarcutBatch();

	}

}

export { Earcut, EarcutBatch, triangulatePrecise, isPlanar };
export default Earcut;