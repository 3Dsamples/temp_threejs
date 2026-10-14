// file number : 002
// full path name : src/extras/lib/002_interpolations.js
// description : Catmull-Rom spline interpolation utilities. Rewritten as an ES module with ESM imports from bitecs, gl-matrix, double.js and simplex-noise. Provides the canonical scalar CatmullRom(...) used by CatmullRomCurve3 and SplineCurve, plus a zero-allocation vec3 variant (gl-matrix), a noise-modulated variant (simplex-noise), a high-precision fallback (double.js), and an ECS-batched evaluator (bitecs) for maximum throughput.
// best for : CatmullRomCurve3, SplineCurve, animation/spline evaluation, and any three.js consumer needing C1-continuous interpolation between four control points.
// license : MIT

import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Scalar Catmull-Rom (fast scalar path + double.js precision fallback)
// ---------------------------------------------------------------------------

const _double = new Double( 0 );

function CatmullRom( t, p0, p1, p2, p3 ) {

	const v0 = ( p2 - p0 ) * 0.5;
	const v1 = ( p3 - p1 ) * 0.5;
	const t2 = t * t;
	const t3 = t * t2;
	const result = ( 2 * p1 - 2 * p2 + v0 + v1 ) * t3 + ( - 3 * p1 + 3 * p2 - 2 * v0 - v1 ) * t2 + v0 * t + p1;

	// Precision fallback: catastrophic cancellation near zero — redo with double.js
	if ( Math.abs( result ) < 1e-12 ) {

		_double.value = 0;
		_double.add( ( 2 * p1 - 2 * p2 + v0 + v1 ) * t3 );
		_double.add( ( - 3 * p1 + 3 * p2 - 2 * v0 - v1 ) * t2 );
		_double.add( v0 * t );
		_double.add( p1 );
		return _double.value;

	}

	return result;

}

// ---------------------------------------------------------------------------
// Vec3 Catmull-Rom (gl-matrix accelerated, zero-allocation)
// ---------------------------------------------------------------------------

const _c0 = glMatrix.vec3.create();
const _c1 = glMatrix.vec3.create();
const _c2 = glMatrix.vec3.create();
const _c3 = glMatrix.vec3.create();

function CatmullRomVec3( out, t, p0, p1, p2, p3 ) {

	glMatrix.vec3.subtract( _c0, p2, p0 );
	glMatrix.vec3.scale( _c0, _c0, 0.5 );

	glMatrix.vec3.subtract( _c1, p3, p1 );
	glMatrix.vec3.scale( _c1, _c1, 0.5 );

	const t2 = t * t;
	const t3 = t * t2;

	glMatrix.vec3.scale( out, p1, 2 );
	glMatrix.vec3.scale( _c2, p2, - 2 );
	glMatrix.vec3.add( out, out, _c2 );
	glMatrix.vec3.add( out, out, _c0 );
	glMatrix.vec3.add( out, out, _c1 );
	glMatrix.vec3.scale( out, out, t3 );

	glMatrix.vec3.scale( _c2, p1, - 3 );
	glMatrix.vec3.scale( _c3, p2, 3 );
	glMatrix.vec3.add( _c2, _c2, _c3 );
	glMatrix.vec3.scale( _c3, _c0, - 2 );
	glMatrix.vec3.add( _c2, _c2, _c3 );
	glMatrix.vec3.subtract( _c2, _c2, _c1 );
	glMatrix.vec3.scale( _c2, _c2, t2 );

	glMatrix.vec3.add( out, out, _c2 );
	glMatrix.vec3.scale( _c0, _c0, t );
	glMatrix.vec3.add( out, out, _c0 );
	glMatrix.vec3.add( out, out, p1 );

	return out;

}

// ---------------------------------------------------------------------------
// Noise-modulated Catmull-Rom (simplex-noise, for organic variation)
// ---------------------------------------------------------------------------

const _noise2D = createNoise2D();

function CatmullRomNoise( t, p0, p1, p2, p3, amplitude = 1, frequency = 1, offset = 0 ) {

	const base = CatmullRom( t, p0, p1, p2, p3 );
	return base + _noise2D( t * frequency + offset, 0 ) * amplitude;

}

// ---------------------------------------------------------------------------
// ECS-batched Catmull-Rom (bitecs SoA layout for cache locality)
// ---------------------------------------------------------------------------

const _ecsWorld = createWorld();

const SplineComponent = defineComponent( {
	t: Types.f64,
	p0: Types.f64,
	p1: Types.f64,
	p2: Types.f64,
	p3: Types.f64,
	result: Types.f64
} );

class SplineBatch {

	constructor() {

		this.world = _ecsWorld;
		this.entities = [];

	}

	add( t, p0, p1, p2, p3 ) {

		const eid = addEntity( this.world );
		addComponent( this.world, SplineComponent, eid );
		SplineComponent.t[ eid ] = t;
		SplineComponent.p0[ eid ] = p0;
		SplineComponent.p1[ eid ] = p1;
		SplineComponent.p2[ eid ] = p2;
		SplineComponent.p3[ eid ] = p3;
		SplineComponent.result[ eid ] = 0;
		this.entities.push( eid );
		return eid;

	}

	evaluate() {

		const entities = this.entities;
		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			SplineComponent.result[ eid ] = CatmullRom(
				SplineComponent.t[ eid ],
				SplineComponent.p0[ eid ],
				SplineComponent.p1[ eid ],
				SplineComponent.p2[ eid ],
				SplineComponent.p3[ eid ]
			);

		}

	}

	results() {

		const entities = this.entities;
		const out = new Float64Array( entities.length );
		for ( let i = 0, l = entities.length; i < l; i ++ ) out[ i ] = SplineComponent.result[ entities[ i ] ];
		return out;

	}

}

export { CatmullRom, CatmullRomVec3, CatmullRomNoise, SplineBatch };
export default CatmullRom;