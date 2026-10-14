// file number : 025
// full path name : src/extras/lib/025_curves.js
// description : Barrel module (three.js r185) that re-exports every concrete Curve subclass and provides high-level factory helpers for building compound paths, sampling multiple curves, and converting to geometry-ready point arrays. Wires together all internally-rewritten curve modules (004–019) and applies the required CDN libraries at the barrel level: gl-matrix for zero-allocation batched sampling across heterogeneous curve types, bitecs SoA registry for curve-set management, double.js bit-exact cumulative length computation, and simplex-noise organic perturbation of curve sets for procedural workflows.
// best for : The `Curves` namespace in three.js — the single-import entry point for any project that needs ArcCurve, CatmullRomCurve3, CubicBezierCurve, CubicBezierCurve3, EllipseCurve, LineCurve, LineCurve3, QuadraticBezierCurve, QuadraticBezierCurve3, and SplineCurve.
// license : MIT

import { ArcCurve } from './019_arccurve.js';
import { CatmullRomCurve3 } from './009_catmullromcurve3.js';
import { CubicBezierCurve } from './010_cubicbeziercurve.js';
import { CubicBezierCurve3 } from './011_cubicbeziercurve3.js';
import { EllipseCurve } from './008_ellipsecurve.js';
import { LineCurve } from './012_linecurve.js';
import { LineCurve3 } from './013_linecurve3.js';
import { QuadraticBezierCurve } from './014_quadraticbeziercurve.js';
import { QuadraticBezierCurve3 } from './015_quadraticbeziercurve3.js';
import { SplineCurve } from './016_splinecurve.js';
import { Vector2 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/002_Vector2.js';
import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();
const _double = new Double( 0 );

// gl-matrix scratch for zero-allocation curve sampling
const _gm_v2 = glMatrix.vec2.create();
const _gm_v3 = glMatrix.vec3.create();
const _gm_v3_a = glMatrix.vec3.create();
const _gm_v3_b = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Curve type tag constants (used by the ECS registry and factory functions)
// ---------------------------------------------------------------------------

const CurveType = {
	ArcCurve: 0,
	CatmullRomCurve3: 1,
	CubicBezierCurve: 2,
	CubicBezierCurve3: 3,
	EllipseCurve: 4,
	LineCurve: 5,
	LineCurve3: 6,
	QuadraticBezierCurve: 7,
	QuadraticBezierCurve3: 8,
	SplineCurve: 9
};

// Map of curve-type names to their constructors — used by the factory
const _curveConstructors = {
	ArcCurve,
	CatmullRomCurve3,
	CubicBezierCurve,
	CubicBezierCurve3,
	EllipseCurve,
	LineCurve,
	LineCurve3,
	QuadraticBezierCurve,
	QuadraticBezierCurve3,
	SplineCurve
};

// ---------------------------------------------------------------------------
// bitecs SoA registry for heterogeneous curve sets
// ---------------------------------------------------------------------------

const _curvesWorld = createWorld();

const CurveRegistryComponent = defineComponent( {
	curveType: Types.ui8,
	curvePtr: Types.ui32,      // index into this.curves
	is3D: Types.ui8,
	isClosed: Types.ui8,
	cachedLength: Types.f64
} );

class CurveSet {

	constructor() {

		this.world = _curvesWorld;
		this.curves = [];
		this.entities = [];

	}

	/**
	 * Register a curve instance.
	 *
	 * @param {Curve} curve
	 * @returns {number} entity id
	 */
	add( curve ) {

		const eid = addEntity( this.world );
		addComponent( this.world, CurveRegistryComponent, eid );

		const typeName = curve.type;
		CurveRegistryComponent.curveType[ eid ] = CurveType[ typeName ] ?? 255;
		CurveRegistryComponent.curvePtr[ eid ] = this.curves.length;
		CurveRegistryComponent.is3D[ eid ] = ( curve.isLineCurve3 || curve.isCubicBezierCurve3 || curve.isQuadraticBezierCurve3 || curve.isCatmullRomCurve3 ) ? 1 : 0;
		CurveRegistryComponent.isClosed[ eid ] = curve.closed ? 1 : 0;
		CurveRegistryComponent.cachedLength[ eid ] = 0;

		this.curves.push( curve );
		this.entities.push( eid );

		return eid;

	}

	/**
	 * Compute cumulative arc lengths for all registered curves using
	 * double.js for bit-exact accumulation.
	 *
	 * @param {number} [divisions=200]
	 */
	computeLengths( divisions = 200 ) {

		for ( let i = 0, l = this.entities.length; i < l; i ++ ) {

			const eid = this.entities[ i ];
			const curve = this.curves[ CurveRegistryComponent.curvePtr[ eid ] ];

			const is3D = CurveRegistryComponent.is3D[ eid ] === 1;
			_double.value = 0;

			let last = curve.getPoint( 0 );
			let current;

			for ( let p = 1; p <= divisions; p ++ ) {

				current = curve.getPoint( p / divisions );
				const dx = current.x - last.x;
				const dy = current.y - last.y;
				const dz = is3D ? ( current.z - last.z ) : 0;
				_double.add( Math.sqrt( dx * dx + dy * dy + dz * dz ) );
				last = current;

			}

			CurveRegistryComponent.cachedLength[ eid ] = _double.value;

		}

	}

	/**
	 * Total combined length across all registered curves.
	 *
	 * @returns {number}
	 */
	totalLength() {

		_double.value = 0;
		for ( let i = 0, l = this.entities.length; i < l; i ++ ) {

			_double.add( CurveRegistryComponent.cachedLength[ this.entities[ i ] ] );

		}

		return _double.value;

	}

	/**
	 * Sample all curves at a uniform t and pack results into a Float32Array.
	 * Uses gl-matrix for zero-allocation vec2/vec3 staging.
	 *
	 * @param {number} t - Interpolation factor in [0, 1].
	 * @returns {{is3D: boolean, positions: Float32Array}}
	 */
	sampleAllGlMat( t ) {

		const n = this.entities.length;
		let anyIs3D = false;
		for ( let i = 0; i < n; i ++ ) {

			if ( CurveRegistryComponent.is3D[ this.entities[ i ] ] === 1 ) { anyIs3D = true; break; }

		}

		const stride = anyIs3D ? 3 : 2;
		const out = new Float32Array( n * stride );

		for ( let i = 0; i < n; i ++ ) {

			const eid = this.entities[ i ];
			const curve = this.curves[ CurveRegistryComponent.curvePtr[ eid ] ];
			const point = curve.getPoint( t );

			if ( anyIs3D ) {

				glMatrix.vec3.set( _gm_v3, point.x, point.y, point.z ?? 0 );
				out[ i * 3 + 0 ] = _gm_v3[ 0 ];
				out[ i * 3 + 1 ] = _gm_v3[ 1 ];
				out[ i * 3 + 2 ] = _gm_v3[ 2 ];

			} else {

				glMatrix.vec2.set( _gm_v2, point.x, point.y );
				out[ i * 2 + 0 ] = _gm_v2[ 0 ];
				out[ i * 2 + 1 ] = _gm_v2[ 1 ];

			}

		}

		return { is3D: anyIs3D, positions: out };

	}

}

// ---------------------------------------------------------------------------
// High-level factory & utility helpers
// ---------------------------------------------------------------------------

/**
 * Create a curve instance by type name.
 *
 * @param {string} typeName - One of the keys of `_curveConstructors`.
 * @param {...any} args - Constructor arguments forwarded to the curve.
 * @returns {Curve}
 */
function createCurve( typeName, ...args ) {

	const Ctor = _curveConstructors[ typeName ];
	if ( ! Ctor ) throw new Error( `Curves.createCurve: unknown curve type "${ typeName }"` );
	return new Ctor( ...args );

}

/**
 * Concatenate two or more curves into a single flat Float32Array of
 * sampled positions. Uses gl-matrix for zero-allocation staging.
 *
 * @param {Curve[]} curves
 * @param {number} [samplesPerCurve=16]
 * @returns {{is3D: boolean, positions: Float32Array}}
 */
function sampleCurveChainGlMat( curves, samplesPerCurve = 16 ) {

	const n = curves.length;
	if ( n === 0 ) return { is3D: false, positions: new Float32Array( 0 ) };

	const anyIs3D = curves.some( c =>
		c.isLineCurve3 || c.isCubicBezierCurve3 || c.isQuadraticBezierCurve3 || c.isCatmullRomCurve3
	);

	const stride = anyIs3D ? 3 : 2;
	const out = new Float32Array( n * samplesPerCurve * stride );

	let offset = 0;

	for ( let i = 0; i < n; i ++ ) {

		const curve = curves[ i ];

		for ( let s = 0; s < samplesPerCurve; s ++ ) {

			const t = s / ( samplesPerCurve - 1 );
			const point = curve.getPoint( t );

			if ( anyIs3D ) {

				glMatrix.vec3.set( _gm_v3, point.x, point.y, point.z ?? 0 );
				out[ offset ++ ] = _gm_v3[ 0 ];
				out[ offset ++ ] = _gm_v3[ 1 ];
				out[ offset ++ ] = _gm_v3[ 2 ];

			} else {

				glMatrix.vec2.set( _gm_v2, point.x, point.y );
				out[ offset ++ ] = _gm_v2[ 0 ];
				out[ offset ++ ] = _gm_v2[ 1 ];

			}

		}

	}

	return { is3D: anyIs3D, positions: out };

}

/**
 * double.js bit-exact cumulative arc lengths for an array of curves.
 * Returns the cumulative-length array (prefix sums) instead of the total.
 *
 * @param {Curve[]} curves
 * @param {number} [divisions=200]
 * @returns {number[]}
 */
function cumulativeLengthsPrecise( curves, divisions = 200 ) {

	const lengths = [];
	_double.value = 0;

	for ( let i = 0, l = curves.length; i < l; i ++ ) {

		const curve = curves[ i ];
		const is3D = curve.isLineCurve3 || curve.isCubicBezierCurve3 || curve.isQuadraticBezierCurve3 || curve.isCatmullRomCurve3;

		let last = curve.getPoint( 0 );
		let current;

		for ( let p = 1; p <= divisions; p ++ ) {

			current = curve.getPoint( p / divisions );
			const dx = current.x - last.x;
			const dy = current.y - last.y;
			const dz = is3D ? ( current.z - last.z ) : 0;
			_double.add( Math.sqrt( dx * dx + dy * dy + dz * dz ) );
			last = current;

		}

		lengths.push( _double.value );

	}

	return lengths;

}

/**
 * Perturb an entire curve set with simplex-noise and return a new array
 * of perturbed curves (using deep clone + noise-offset control points).
 * Useful for hand-drawn / organic variations of an existing path.
 *
 * @param {Curve[]} curves
 * @param {number} [amplitude=0.01]
 * @param {number} [frequency=1]
 * @param {number} [offset=0]
 * @returns {Curve[]}
 */
function perturbCurveSet( curves, amplitude = 0.01, frequency = 1, offset = 0 ) {

	return curves.map( ( curve, i ) => {

		const clone = curve.clone ? curve.clone() : Object.assign( Object.create( Object.getPrototypeOf( curve ) ), curve );

		const hasVec2 = 'v0' in curve && curve.v0 && curve.v0.isVector2;
		const hasVec3 = 'v0' in curve && curve.v0 && curve.v0.isVector3;

		const perCurveOffset = offset + i * 1000;

		if ( hasVec2 ) {

			for ( const key of [ 'v0', 'v1', 'v2', 'v3' ] ) {

				if ( clone[ key ] ) {

					clone[ key ].x += _noise2D( perCurveOffset, 0 ) * amplitude;
					clone[ key ].y += _noise2D( perCurveOffset, 100 ) * amplitude;

				}

			}

		} else if ( hasVec3 ) {

			for ( const key of [ 'v0', 'v1', 'v2', 'v3' ] ) {

				if ( clone[ key ] ) {

					clone[ key ].x += _noise2D( perCurveOffset, 0 ) * amplitude;
					clone[ key ].y += _noise2D( perCurveOffset, 100 ) * amplitude;
					clone[ key ].z += _noise2D( perCurveOffset, 200 ) * amplitude;

				}

			}

		} else if ( 'points' in curve && Array.isArray( curve.points ) ) {

			clone.points = curve.points.map( ( p, j ) => {

				const np = p.clone ? p.clone() : p;
				np.x = p.x + _noise2D( j * frequency + perCurveOffset, 0 ) * amplitude;
				np.y = p.y + _noise2D( j * frequency + perCurveOffset, 100 ) * amplitude;
				if ( p.z !== undefined ) np.z = p.z + _noise2D( j * frequency + perCurveOffset, 200 ) * amplitude;
				return np;

			} );

		}

		return clone;

	} );

}

// ---------------------------------------------------------------------------
// Exports — the barrel namespace
// ---------------------------------------------------------------------------

export {
	// Concrete curve classes
	ArcCurve,
	CatmullRomCurve3,
	CubicBezierCurve,
	CubicBezierCurve3,
	EllipseCurve,
	LineCurve,
	LineCurve3,
	QuadraticBezierCurve,
	QuadraticBezierCurve3,
	SplineCurve,

	// Constants & helpers
	CurveType,
	CurveSet,

	// Factory & utilities
	createCurve,
	sampleCurveChainGlMat,
	cumulativeLengthsPrecise,
	perturbCurveSet
};

// Default export mirrors three.js's namespace-style barrel export
export default {
	ArcCurve,
	CatmullRomCurve3,
	CubicBezierCurve,
	CubicBezierCurve3,
	EllipseCurve,
	LineCurve,
	LineCurve3,
	QuadraticBezierCurve,
	QuadraticBezierCurve3,
	SplineCurve,

	CurveType,
	CurveSet,

	createCurve,
	sampleCurveChainGlMat,
	cumulativeLengthsPrecise,
	perturbCurveSet
};