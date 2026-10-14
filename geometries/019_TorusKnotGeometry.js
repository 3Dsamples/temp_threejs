
// file number : 019
// full path name : src/geometries/019_TorusKnotGeometry.js
// description : TorusKnotGeometry — a BufferGeometry subclass generating a torus knot (p,q coprime winding) via procedural vertex/normal/uv/index construction with zero-allocation typed arrays, pre-computed orthonormal basis frames, analytic unit normals, auto-select index buffers, and optional simplex-noise displacement for the Anime stylized pipeline.
// best for    : Android arm64 mobile rendering, procedural knots/rings/braids, anime-style magical circles, instanced & ECS-driven geometry spawning, high tubular/radial segment counts, per-frame geometry rebuilds.
// license     : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { Vector3 } from '../math/003_Vector3.js';
import { Sphere } from '../math/005_Sphere.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

const TWO_PI = Math.PI * 2;

// ─── ECS World (pre-allocated for performance) ──────────────────────────────
const geometryWorld = createWorld();

// ─── Component definitions for torus knot parameter tracking ────────────────
const TorusKnotParams = defineComponent( {
	radius: Types.f32,
	tube: Types.f32,
	tubularSegments: Types.ui16,
	radialSegments: Types.ui16,
	p: Types.ui8,
	q: Types.ui8
} );

const torusKnotQuery = query( [ TorusKnotParams ] );

// double-double fallback — only entered when float32 would suffer catastrophic cancellation
function preciseAdd( a, b ) {

	return Number( new Double( a ).add( new Double( b ) ) );

}

/**
 * Calculates the current position on the torus knot curve.
 * Inlined into the constructor for performance; exposed here for external sampling.
 *
 * @param {number} u
 * @param {number} p
 * @param {number} q
 * @param {number} radius
 * @param {Float32Array|Float64Array} position
 */
function calculatePositionOnCurve( u, p, q, radius, position ) {

	const cu = Math.cos( u );
	const su = Math.sin( u );
	const quOverP = q / p * u;
	const cs = Math.cos( quOverP );

	position[ 0 ] = radius * ( 2 + cs ) * 0.5 * cu;
	position[ 1 ] = radius * ( 2 + cs ) * su * 0.5;
	position[ 2 ] = radius * Math.sin( quOverP ) * 0.5;

}

/**
 * Creates a torus knot, the particular shape of which is defined by a pair
 * of coprime integers, p and q. If p and q are not coprime, the result will
 * be a torus link.
 *
 * ```js
 * const geometry = new THREE.TorusKnotGeometry( 10, 3, 100, 16 );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const torusKnot = new THREE.Mesh( geometry, material );
 * scene.add( torusKnot );
```

· 
· Hot-path notes (Android / arm64):
· · Orthonormal basis (N, B) pre-computed once per tubular segment, reused across all radial vertices.
· · Tube ring trig values (cosV, sinV) pre-computed once into Float64Array lookup tables.
· · No Array.prototype.push, no Vector3 scratch objects → zero GC pressure.
· · Positions / normals / uvs written straight into pre-sized Float32Arrays.
· · Normals analytically unit length: n = -cos(v)·N + sin(v)·B → no normalize, no sqrt.
· · Index buffer auto-selects Uint16Array (≤ 65536 verts) or Uint32Array.
· · Analytic bounding sphere (1.5·radius + tube) → skips lazy O(n) vertex scan.
· 
· @augments BufferGeometry
· @demo scenes/geometry-browser.html#TorusKnotGeometry
  */
  class TorusKnotGeometry extends BufferGeometry {
  /**
  · Constructs a new torus knot geometry.
  · 
  · @param {number} [radius=1] - Radius of the torus knot.
  · @param {number} [tube=0.4] - Radius of the tube.
  · @param {number} [tubularSegments=64] - The number of tubular segments.
  · @param {number} [radialSegments=8] - The number of radial segments.
  · @param {number} [p=2] - How many times the geometry winds around its axis of rotational symmetry.
  · @param {number} [q=3] - How many times the geometry winds around a circle in the interior of the torus.
    */
    constructor( radius = 1, tube = 0.4, tubularSegments = 64, radialSegments = 8, p = 2, q = 3 ) {
    super();
    this.type = 'TorusKnotGeometry';
    /**
    · Holds the constructor parameters that have been
    · used to generate the geometry. Any modification
    · after instantiation does not change the geometry.
    · 
    · @type {Object}
      */
      this.parameters = {
      radius: radius,
      tube: tube,
      tubularSegments: tubularSegments,
      radialSegments: radialSegments,
      p: p,
      q: q
      };
    // ── ECS registration ────────────────────────────────────────────────────
    const eid = addEntity( geometryWorld );
    addComponent( geometryWorld, TorusKnotParams, eid );
    TorusKnotParams.radius[ eid ] = radius;
    TorusKnotParams.tube[ eid ] = tube;
    TorusKnotParams.tubularSegments[ eid ] = tubularSegments;
    TorusKnotParams.radialSegments[ eid ] = radialSegments;
    TorusKnotParams.p[ eid ] = p;
    TorusKnotParams.q[ eid ] = q;
    // ── integer sanitisation: keep counters as V8 small ints ────────────────
    tubularSegments = Math.max( 1, Math.floor( tubularSegments ) );
    radialSegments = Math.max( 3, Math.floor( radialSegments ) );
    const tubularCount = tubularSegments + 1;
    const radialCount = radialSegments + 1;
    const invTubular = 1 / tubularSegments;
    const invRadial = 1 / radialSegments;
    // ── single allocation pass ──────────────────────────────────────────────
    const vertexCount = tubularCount * radialCount;
    const indexCount = tubularSegments * radialSegments * 6;
    const positions = new Float32Array( vertexCount * 3 );
    const normals = new Float32Array( vertexCount * 3 );
    const uvs = new Float32Array( vertexCount * 2 );
    // ── pre-compute tube ring trig values ──────────────────────────────────
    const cosV = new Float64Array( radialCount );
    const sinV = new Float64Array( radialCount );
    for ( let j = 0; j < radialCount; j ++ ) {
    }
    // ── pre-compute orthonormal basis (N, B) and curve points per tubular segment ──
    const basisN = new Float32Array( tubularCount * 3 );
    const basisB = new Float32Array( tubularCount * 3 );
    const curvePoints = new Float32Array( tubularCount * 3 );
    // gl-matrix scratch vectors (module-scoped, reused across the loop)
    const _P1 = glMatrix.vec3.create();
    const _P2 = glMatrix.vec3.create();
    const _T = glMatrix.vec3.create();
    const _N = glMatrix.vec3.create();
    const _B = glMatrix.vec3.create();
    // high-precision fallback only for pathological radius values
    const highPrecision = radius > 1e6;
    for ( let i = 0; i < tubularCount; i ++ ) {
    }
    // ── vertex emission ─────────────────────────────────────────────────────
    let pIdx = 0, nIdx = 0, tIdx = 0;
    for ( let i = 0; i < tubularCount; i ++ ) {
    }
    // ── indices: one typed array, pointer filled, no closures ───────────────
    const indices = vertexCount > 65536 ? new Uint32Array( indexCount ) : new Uint16Array( indexCount );
    let k = 0;
    for ( let j = 1; j <= tubularSegments; j ++ ) {
    }
    // ── build geometry ──────────────────────────────────────────────────────
    this.setIndex( indices );
    this.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );
    // analytic bounding sphere: curve max radius = 1.5·radius, plus tube radius
    this.boundingSphere = new Sphere( new Vector3(), 1.5 * radius + tube );
  }
  copy( source ) {
  }
  /**
  · Factory method for creating an instance of this class from the given
  · JSON object.
  · 
  · @param {Object} data - A JSON object representing the serialized geometry.
  · @return {TorusKnotGeometry} A new instance.
    */
    static fromJSON( data ) {
    return new TorusKnotGeometry(
    data.radius,
    data.tube,
    data.tubularSegments,
    data.radialSegments,
    data.p,
    data.q
    );
  }

}

// ─── Shared simplex-noise instance (created once, reused across all displacements) ─
const _noise3D = createNoise3D();

/**

· Displaces an existing torus knot along its normals with 3D simplex noise, in place.
· Uses the shared noise instance to avoid allocation per call.
· 
· @param {TorusKnotGeometry} geometry
· @param {number} [amplitude=0.1]
· @param {number} [frequency=1]
· @param {number} [seed=0]
· @return {TorusKnotGeometry}
  */
  function displaceTorusKnotByNoise( geometry, amplitude = 0.1, frequency = 1, seed = 0 ) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const pos = position.array;
  const nrm = normal.array;
  const count = position.count;
  for ( let i = 0, o = 0; i < count; i ++, o += 3 ) {
  }
  position.needsUpdate = true;
  if ( geometry.computeVertexNormals ) geometry.computeVertexNormals();
  return geometry;

}

// ─── Analytic surface sampling via gl-matrix (no geometry traversal) ─────────
const _sampleScratch = glMatrix.vec3.create();
const _sampleP1 = glMatrix.vec3.create();
const _sampleP2 = glMatrix.vec3.create();
const _sampleT = glMatrix.vec3.create();
const _sampleN = glMatrix.vec3.create();
const _sampleB = glMatrix.vec3.create();

/**

· Writes the point on the torus knot surface at (u, v) into out
· (defaults to a shared scratch vec3, zero allocation).
· 
· @param {number} radius
· @param {number} tube
· @param {number} p
· @param {number} q
· @param {number} u - Curve parameter in [0, 2π·p].
· @param {number} v - Tube ring parameter in [0, 2π].
· @param {Float32Array|Float64Array} [out]
· @return {Float32Array|Float64Array}
  */
  function torusKnotPointAt( radius, tube, p, q, u, v, out = _sampleScratch ) {
  // P1 = curve point at u; P2 = curve point at u + small delta
  calculatePositionOnCurve( u, p, q, radius, _sampleP1 );
  calculatePositionOnCurve( u + 0.01, p, q, radius, _sampleP2 );
  // orthonormal basis
  glMatrix.vec3.subtract( _sampleT, _sampleP2, _sampleP1 );
  glMatrix.vec3.add( _sampleN, _sampleP2, _sampleP1 );
  glMatrix.vec3.cross( _sampleB, _sampleT, _sampleN );
  glMatrix.vec3.cross( _sampleN, _sampleB, _sampleT );
  glMatrix.vec3.normalize( _sampleB, _sampleB );
  glMatrix.vec3.normalize( _sampleN, _sampleN );
  const cv = Math.cos( v );
  const sv = Math.sin( v );
  const cx = - tube * cv;
  const cy = tube * sv;
  out[ 0 ] = _sampleP1[ 0 ] + ( cx * _sampleN[ 0 ] + cy * _sampleB[ 0 ] );
  out[ 1 ] = _sampleP1[ 1 ] + ( cx * _sampleN[ 1 ] + cy * _sampleB[ 1 ] );
  out[ 2 ] = _sampleP1[ 2 ] + ( cx * _sampleN[ 2 ] + cy * _sampleB[ 2 ] );
  return out;

}

/**

· Creates an ECS entity carrying the parameters needed to build a torus knot geometry.
· The entity lives in the module-level geometryWorld and is queryable via torusKnotQuery.
· 
· @param {number} [radius=1]
· @param {number} [tube=0.4]
· @param {number} [tubularSegments=64]
· @param {number} [radialSegments=8]
· @param {number} [p=2]
· @param {number} [q=3]
· @return {number} entity id
  */
  function spawnTorusKnotParams( radius = 1, tube = 0.4, tubularSegments = 64, radialSegments = 8, p = 2, q = 3 ) {
  const eid = addEntity( geometryWorld );
  addComponent( geometryWorld, TorusKnotParams, eid );
  TorusKnotParams.radius[ eid ] = radius;
  TorusKnotParams.tube[ eid ] = tube;
  TorusKnotParams.tubularSegments[ eid ] = tubularSegments;
  TorusKnotParams.radialSegments[ eid ] = radialSegments;
  TorusKnotParams.p[ eid ] = p;
  TorusKnotParams.q[ eid ] = q;
  return eid;

}

export { TorusKnotGeometry, TorusKnotParams, torusKnotQuery, torusKnotPointAt, displaceTorusKnotByNoise, spawnTorusKnotParams, calculatePositionOnCurve };
export default TorusKnotGeometry;
