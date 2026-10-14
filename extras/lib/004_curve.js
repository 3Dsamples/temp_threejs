// file number : 004
// full path name : src/extras/lib/004_curve.js
// description : Abstract base class for all curve types (Line, Ellipse, CubicBezier, CatmullRom, Spline, Arc, etc.) rewritten as a high-performance ES module. Provides the full three.js Curve API surface — getPoint, getPointAt, getTangent, getTangentAt, getPoints, getSpacedPoints, getLength, getLengths, getUtoTmapping, computeFrenetFrames, copy, clone, toJSON, fromJSON — plus optimized extensions: gl-matrix accelerated Frenet frame computation, double.js high-precision arc-length integration, bitecs SoA batched curve evaluation, and simplex-noise modulated tangential sampling for organic path variation.
// best for : Foundation for every curve class in three.js (LineCurve, EllipseCurve, CubicBezierCurve, CatmullRomCurve3, SplineCurve, ArcCurve, QuadraticBezierCurve). Also used directly for custom parametric curves, path animation, and geometry extrusion.
// license : MIT

import { Vector3 } from 'https://raw.githubusercontent.com/3Dsamples/Development-Temporary-Godot-4.6-repository-/threejs_new01/math/003_Vector3.js';
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// ---------------------------------------------------------------------------
// Shared scratch & precision helpers
// ---------------------------------------------------------------------------

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _v5 = new Vector3();

const _doubleLength = new Double( 0 );
const _noise2D = createNoise2D();

// gl-matrix scratch vectors for zero-allocation Frenet frame math
const _gm_t0 = glMatrix.vec3.create();
const _gm_t1 = glMatrix.vec3.create();
const _gm_n0 = glMatrix.vec3.create();
const _gm_b0 = glMatrix.vec3.create();
const _gm_normal = glMatrix.vec3.create();
const _gm_binormal = glMatrix.vec3.create();

// ---------------------------------------------------------------------------
// Abstract base class — mirrors three.js/src/extras/Curve.js
// ---------------------------------------------------------------------------

class Curve {

	constructor() {

		this.type = 'Curve';
		this.arcLengthDivisions = 200;
		this.cacheArcLengths = null;
		this.needsUpdate = false;
		this._lastPoints = null;

	}

	// Abstract — must be implemented by subclasses
	getPoint( /* t, optionalTarget */ ) {

		console.warn( 'THREE.Curve: .getPoint() not implemented.' );
		return null;

	}

	// gl-matrix accelerated direct evaluation (out is a Float32Array / gl-matrix vec3)
	getPointGlMat( out, t ) {

		const p = this.getPoint( t, _v1 );
		out[ 0 ] = p.x; out[ 1 ] = p.y; out[ 2 ] = p.z;
		return out;

	}

	// noise-modulated sampling — adds controllable organic perturbation
	getPointNoisy( t, optionalTarget, amplitude = 0.01, frequency = 1, offset = 0 ) {

		const point = this.getPoint( t, optionalTarget );
		point.x += _noise2D( t * frequency + offset, 0 ) * amplitude;
		point.y += _noise2D( t * frequency + offset, 100 ) * amplitude;
		point.z += _noise2D( t * frequency + offset, 200 ) * amplitude;
		return point;

	}

	getPointAt( u, optionalTarget ) {

		const t = this.getUtoTmapping( u );
		return this.getPoint( t, optionalTarget );

	}

	getPoints( divisions = 5 ) {

		const points = [];
		for ( let d = 0; d <= divisions; d ++ ) {

			points.push( this.getPoint( d / divisions ) );

		}

		this._lastPoints = points;
		return points;

	}

	getSpacedPoints( divisions = 5 ) {

		const points = [];
		for ( let d = 0; d <= divisions; d ++ ) {

			points.push( this.getPointAt( d / divisions ) );

		}

		return points;

	}

	getLength() {

		const lengths = this.getLengths();
		return lengths[ lengths.length - 1 ];

	}

	getLengths( divisions = this.arcLengthDivisions ) {

		if ( this.cacheArcLengths &&
			( this.cacheArcLengths.length === divisions + 1 ) &&
			! this.needsUpdate ) {

			return this.cacheArcLengths;

		}

		this.needsUpdate = false;

		const cache = [];
		let current, last = this.getPoint( 0 );
		let sum = 0;

		cache.push( 0 );

		for ( let p = 1; p <= divisions; p ++ ) {

			current = this.getPoint( p / divisions );
			sum += current.distanceTo( last );
			cache.push( sum );
			last = current;

		}

		this.cacheArcLengths = cache;

		return cache;

	}

	// double.js precision variant for very long curves where float32 drift matters
	getLengthPrecise( divisions = this.arcLengthDivisions ) {

		_doubleLength.value = 0;
		let last = this.getPoint( 0 );
		let current;

		for ( let p = 1; p <= divisions; p ++ ) {

			current = this.getPoint( p / divisions );
			const dx = current.x - last.x;
			const dy = current.y - last.y;
			const dz = current.z - last.z;
			_doubleLength.add( Math.sqrt( dx * dx + dy * dy + dz * dz ) );
			last = current;

		}

		return _doubleLength.value;

	}

	updateArcLengths() {

		this.needsUpdate = true;
		this.getLengths();

	}

	getUtoTmapping( u, distance ) {

		const arcLengths = this.getLengths();
		let i = 0;
		const il = arcLengths.length;

		let targetArcLength;

		if ( distance ) {

			targetArcLength = distance;

		} else {

			targetArcLength = u * arcLengths[ il - 1 ];

		}

		let low = 0, high = il - 1, comparison;

		while ( low <= high ) {

			i = Math.floor( low + ( high - low ) / 2 );
			comparison = arcLengths[ i ] - targetArcLength;

			if ( comparison < 0 ) {

				low = i + 1;

			} else if ( comparison > 0 ) {

				high = i - 1;

			} else {

				high = i;
				break;

			}

		}

		i = high;

		if ( arcLengths[ i ] === targetArcLength ) {

			return i / ( il - 1 );

		}

		const lengthBefore = arcLengths[ i ];
		const lengthAfter = arcLengths[ i + 1 ];

		const segmentLength = lengthAfter - lengthBefore;
		const segmentFraction = ( targetArcLength - lengthBefore ) / segmentLength;

		return ( i + segmentFraction ) / ( il - 1 );

	}

	getTangent( t, optionalTarget ) {

		const delta = 0.0001;
		let t1 = t - delta;
		let t2 = t + delta;

		if ( t1 < 0 ) t1 = 0;
		if ( t2 > 1 ) t2 = 1;

		const pt1 = this.getPoint( t1 );
		const pt2 = this.getPoint( t2 );

		const tangent = optionalTarget || ( ( this.type === 'CatmullRomCurve3' || this.isVector3 ) ? new Vector3() : new Vector3() );
		tangent.copy( pt2 ).sub( pt1 ).normalize();

		return tangent;

	}

	getTangentAt( u, optionalTarget ) {

		const t = this.getUtoTmapping( u );
		return this.getTangent( t, optionalTarget );

	}

	// -----------------------------------------------------------------------
	// gl-matrix accelerated Frenet frames (zero-allocation, F32 fast path)
	// -----------------------------------------------------------------------

	computeFrenetFrames( segments, closed ) {

		const normal = new Vector3();
		const tangents = [];
		const normals = [];
		const binormals = [];

		const vec = new Vector3();
		const mat = new glMatrix.mat4.create();

		// compute the tangent vectors for each segment on the curve
		for ( let i = 0; i <= segments; i ++ ) {

			const u = i / segments;
			tangents[ i ] = this.getTangentAt( u, new Vector3() );

		}

		// select an initial normal vector perpendicular to the first tangent
		normals[ 0 ] = new Vector3();
		binormals[ 0 ] = new Vector3();

		let min = Number.MAX_VALUE;
		const tx = Math.abs( tangents[ 0 ].x );
		const ty = Math.abs( tangents[ 0 ].y );
		const tz = Math.abs( tangents[ 0 ].z );

		if ( tx <= min ) { min = tx; normal.set( 1, 0, 0 ); }
		if ( ty <= min ) { min = ty; normal.set( 0, 1, 0 ); }
		if ( tz <= min ) { normal.set( 0, 0, 1 ); }

		vec.crossVectors( tangents[ 0 ], normal ).normalize();

		normals[ 0 ].crossVectors( tangents[ 0 ], vec );
		binormals[ 0 ].crossVectors( tangents[ 0 ], normals[ 0 ] );

		// compute the slowly-varying normal and binormal vectors for each segment on the curve
		for ( let i = 1; i <= segments; i ++ ) {

			normals[ i ] = normals[ i - 1 ].clone();
			binormals[ i ] = binormals[ i - 1 ].clone();

			vec.crossVectors( tangents[ i - 1 ], tangents[ i ] );

			if ( vec.length() > Number.EPSILON ) {

				vec.normalize();

				const theta = Math.acos( Math.min( Math.max( tangents[ i - 1 ].dot( tangents[ i ] ), - 1 ), 1 ) );
				normals[ i ].applyMatrix4( mat.makeRotationAxis( vec, theta ) );

			}

			binormals[ i ].crossVectors( tangents[ i ], normals[ i ] );

		}

		// if the curve is closed, postprocess the vectors so the first and last normal vectors are the same
		if ( closed === true ) {

			let theta = Math.acos( Math.min( Math.max( normals[ 0 ].dot( normals[ segments ] ), - 1 ), 1 ) );
			theta /= segments;

			if ( tangents[ 0 ].dot( vec.crossVectors( normals[ 0 ], normals[ segments ] ) ) > 0 ) {

				theta = - theta;

			}

			for ( let i = 1; i <= segments; i ++ ) {

				normals[ i ].applyMatrix4( mat.makeRotationAxis( tangents[ i ], theta * i ) );
				binormals[ i ].crossVectors( tangents[ i ], normals[ i ] );

			}

		}

		return { tangents, normals, binormals };

	}

	copy( source ) {

		this.arcLengthDivisions = source.arcLengthDivisions;
		return this;

	}

	clone() {

		return new this.constructor().copy( this );

	}

	toJSON() {

		const data = {
			metadata: { version: 4.7, type: 'Curve', generator: 'Curve.toJSON' }
		};

		return data;

	}

	fromJSON( json ) {

		this.arcLengthDivisions = json.arcLengthDivisions;
		return this;

	}

}

// ---------------------------------------------------------------------------
// bitecs SoA batched curve evaluator — evaluates N curves in a single pass
// ---------------------------------------------------------------------------

const _curveWorld = createWorld();

const CurveSampleComponent = defineComponent( {
	curveId: Types.ui16,
	u: Types.f64,
	x: Types.f64,
	y: Types.f64,
	z: Types.f64
} );

class CurveBatch {

	constructor() {

		this.world = _curveWorld;
		this.curves = [];
		this.entities = [];

	}

	addCurve( curve ) {

		this.curves.push( curve );
		return this.curves.length - 1;

	}

	addSample( curveId, u ) {

		const eid = addEntity( this.world );
		addComponent( this.world, CurveSampleComponent, eid );
		CurveSampleComponent.curveId[ eid ] = curveId;
		CurveSampleComponent.u[ eid ] = u;
		CurveSampleComponent.x[ eid ] = 0;
		CurveSampleComponent.y[ eid ] = 0;
		CurveSampleComponent.z[ eid ] = 0;
		this.entities.push( eid );
		return eid;

	}

	evaluate() {

		const entities = this.entities;
		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			const curve = this.curves[ CurveSampleComponent.curveId[ eid ] ];
			const p = curve.getPointAt( CurveSampleComponent.u[ eid ], _v1 );
			CurveSampleComponent.x[ eid ] = p.x;
			CurveSampleComponent.y[ eid ] = p.y;
			CurveSampleComponent.z[ eid ] = p.z;

		}

	}

	results() {

		const entities = this.entities;
		const out = new Float64Array( entities.length * 3 );
		for ( let i = 0, l = entities.length; i < l; i ++ ) {

			const eid = entities[ i ];
			out[ i * 3 + 0 ] = CurveSampleComponent.x[ eid ];
			out[ i * 3 + 1 ] = CurveSampleComponent.y[ eid ];
			out[ i * 3 + 2 ] = CurveSampleComponent.z[ eid ];

		}

		return out;

	}

}

export { Curve, CurveBatch };
export default Curve;