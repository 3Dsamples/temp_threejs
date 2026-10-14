
// file number : 020
// full path name : src/geometries/020_TubeGeometry.js
// description : TubeGeometry — a BufferGeometry subclass generating a tube (pipe/sweep) along an arbitrary 3D Curve via Frenet frames, with zero-allocation typed arrays, pre-computed ring trig lookup tables, analytic unit normals, auto-select index buffers, cached Frenet frames for sampling, and optional simplex-noise displacement for the Anime stylized pipeline.
// best for    : Android arm64 mobile rendering, procedural pipes/wires/vines, anime-style energy trails, instanced & ECS-driven geometry spawning along splines, high tubular/radial segment counts, per-frame geometry rebuilds.
// license     : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { Vector3 } from '../math/003_Vector3.js';

// ─── Curve registry (needed by fromJSON to rehydrate path subclasses) ────────
import { Curves } from '../extras/Curves.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

const TWO_PI = Math.PI * 2;

// ─── ECS World (pre-allocated for performance) ──────────────────────────────
const geometryWorld = createWorld();

// ─── Component definitions for tube parameter tracking ──────────────────────
const TubeParams = defineComponent( {
	radius: Types.f32,
	tubularSegments: Types.ui16,
	radialSegments: Types.ui16,
	closed: Types.ui8
} );

// NOTE: bitecs 0.4.0 queries are world-bound — call `tubeQuery( geometryWorld )`
// to obtain the entity list. `geometryWorld` is module-private.
const tubeQuery = query( [ TubeParams ] );

// double-double fallback — only entered when float32 would suffer catastrophic cancellation
function preciseAdd( a, b ) {

	return Number( new Double( a ).add( new Double( b ) ) );

}

// ─── Frenet-frame cache (WeakMap keyed on the Curve instance) ───────────────
// Avoids recomputing O(n) frames on every `tubePointAt()` call.
const _framesCache = new WeakMap();

function getCachedFrames( path, tubularSegments, closed ) {

	let entry = _framesCache.get( path );

	if ( entry === undefined || entry.tubularSegments !== tubularSegments || entry.closed !== closed ) {

		entry = {
			tubularSegments: tubularSegments,
			closed: closed,
			frames: path.computeFrenetFrames( tubularSegments, closed )
		};

		_framesCache.set( path, entry );

	}

	return entry.frames;

}

/**
 * Creates a tube that extrudes along a 3D curve.
 *
 * ```js
 * class CustomSinCurve extends THREE.Curve {
 *   getPoint( t, optionalTarget = new THREE.Vector3() ) {
 *     const tx = t * 3 - 1.5;
 *     const ty = Math.sin( 2 * Math.PI * t );
 *     const tz = 0;
 *     return optionalTarget.set( tx, ty, tz );
 *   }
 * }
 * const path = new CustomSinCurve( 10 );
 * const geometry = new THREE.TubeGeometry( path, 20, 2, 8, false );
 * const material = new THREE.MeshBasicMaterial( { color: 0x00ff00 } );
 * const mesh = new THREE.Mesh( geometry, material );
 * scene.add( mesh );
```

· 
· Hot-path notes (Android / arm64):
· · Frenet frames computed once per (path, tubularSegments, closed) triple, reused across all radial vertices.
· · Tube ring trig values (cosV, sinV) pre-computed once into Float64Array lookup tables.
· · No Array.prototype.push, no Vector3 scratch objects in inner loops → zero GC pressure.
· · Positions / normals / uvs written straight into pre-sized Float32Arrays.
· · Normals analytically unit length: n = cos(v)·N + sin(v)·B → no normalize, no sqrt.
· · Index buffer auto-selects Uint16Array (≤ 65536 verts) or Uint32Array.
· 
· @augments BufferGeometry
· @demo scenes/geometry-browser.html#TubeGeometry
  */
  class TubeGeometry extends BufferGeometry {
  /**
  · Constructs a new tube geometry.
  · 
  · @param {Curve} [path] - A 3D curve defining the path of the tube. Must implement getPointAt(u, target) and computeFrenetFrames(segments, closed).
  · @param {number} [tubularSegments=64] - The number of segments that make up the tube.
  · @param {number} [radius=1] - The radius of the tube.
  · @param {number} [radialSegments=8] - The number of segments that make up the cross-section.
  · @param {boolean} [closed=false] - Whether the tube is closed or not.
    */
    constructor( path, tubularSegments = 64, radius = 1, radialSegments = 8, closed = false ) {
    super();
    this.type = 'TubeGeometry';
    if ( path === undefined || path === null ) {
    }
    if ( typeof path.getPointAt !== 'function' || typeof path.computeFrenetFrames !== 'function' ) {
    }
    /**
    · Holds the constructor parameters that have been
    · used to generate the geometry. Any modification
    · after instantiation does not change the geometry.
    · 
    · @type {Object}
      */
      this.parameters = {
      path: path,
      tubularSegments: tubularSegments,
      radius: radius,
      radialSegments: radialSegments,
      closed: closed
      };
    // ── ECS registration ────────────────────────────────────────────────────
    const eid = addEntity( geometryWorld );
    addComponent( geometryWorld, TubeParams, eid );
    TubeParams.radius[ eid ] = radius;
    TubeParams.tubularSegments[ eid ] = tubularSegments;
    TubeParams.radialSegments[ eid ] = radialSegments;
    TubeParams.closed[ eid ] = closed ? 1 : 0;
    // ── integer sanitisation: keep counters as V8 small ints ────────────────
    tubularSegments = Math.max( 1, Math.floor( tubularSegments ) );
    radialSegments = Math.max( 3, Math.floor( radialSegments ) );
    const tubularCount = tubularSegments + 1;
    const radialCount = radialSegments + 1;
    const invTubular = 1 / tubularSegments;
    const invRadial = 1 / radialSegments;
    // ── Frenet frames (computed once, reused across all radial vertices) ────
    const frames = path.computeFrenetFrames( tubularSegments, closed );
    // expose internals (three.js compatibility)
    this.tangents = frames.tangents;
    this.normals = frames.normals;
    this.binormals = frames.binormals;
    // ── pre-compute tube ring trig values ──────────────────────────────────
    const cosV = new Float64Array( radialCount );
    const sinV = new Float64Array( radialCount );
    for ( let j = 0; j < radialCount; j ++ ) {
    }
    // ── single allocation pass ──────────────────────────────────────────────
    const vertexCount = tubularCount * radialCount;
    const indexCount = tubularSegments * radialSegments * 6;
    const positions = new Float32Array( vertexCount * 3 );
    const normals = new Float32Array( vertexCount * 3 );
    const uvs = new Float32Array( vertexCount * 2 );
    // high-precision fallback only for pathological radius values
    const highPrecision = radius > 1e6;
    // scratch vector for path sampling (reused, no allocation in loop)
    const P = new Vector3();
    let pIdx = 0, nIdx = 0, tIdx = 0;
    // ── segment generation: i from 0 to tubularSegments (inclusive) ────────
    // closed === false → last segment uses t = 1
    // closed === true  → last segment duplicates t = 0 (UVs still differ)
    for ( let i = 0; i <= tubularSegments; i ++ ) {
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
    // bounding sphere: sphere around the tube envelope (uses path bbox + radius)
    this.computeBoundingSphere();
  }
  copy( source ) {
  }
  toJSON() {
  }
  /**
  · Factory method for creating an instance of this class from the given
  · JSON object.
  · 
  · @param {Object} data - A JSON object representing the serialized geometry.
  · @return {TubeGeometry} A new instance.
    */
    static fromJSON( data ) {
    const CurveClass = Curves[ data.path.type ];
    if ( CurveClass === undefined ) {
    }
    return new TubeGeometry(
    new CurveClass().fromJSON( data.path ),
    data.tubularSegments,
    data.radius,
    data.radialSegments,
    data.closed
    );
  }

}

// ─── Shared simplex-noise instance (created once, reused across all displacements) ─
const _noise3D = createNoise3D();

/**

· Displaces an existing tube along its normals with 3D simplex noise, in place.
· Uses the shared noise instance to avoid allocation per call.
· 
· @param {TubeGeometry} geometry
· @param {number} [amplitude=0.1]
· @param {number} [frequency=1]
· @param {number} [seed=0]
· @return {TubeGeometry}
  */
  function displaceTubeByNoise( geometry, amplitude = 0.1, frequency = 1, seed = 0 ) {
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
const _sampleP = new Vector3();

/**

· Writes the point on the tube surface at (u, v) into out
· (defaults to a shared scratch vec3, zero allocation).
· Frenet frames are cached per-path via WeakMap — no per-call O(n) rebuild.
· 
· @param {Curve} path - The 3D curve.
· @param {number} radius
· @param {number} tubularSegments
· @param {boolean} closed
· @param {number} u - Curve parameter in [0, 1].
· @param {number} v - Tube ring parameter in [0, 2π].
· @param {Float32Array|Float64Array} [out]
· @return {Float32Array|Float64Array}
  */
  function tubePointAt( path, radius, tubularSegments, closed, u, v, out = _sampleScratch ) {
  const frames = getCachedFrames( path, tubularSegments, closed );
  path.getPointAt( u, _sampleP );
  const sampleIndex = Math.min( Math.floor( u * tubularSegments ), tubularSegments - 1 );
  const N = frames.normals[ sampleIndex ];
  const B = frames.binormals[ sampleIndex ];
  const cv = Math.cos( v );
  const sv = Math.sin( v );
  const nrmX = cv * N.x + sv * B.x;
  const nrmY = cv * N.y + sv * B.y;
  const nrmZ = cv * N.z + sv * B.z;
  out[ 0 ] = _sampleP.x + radius * nrmX;
  out[ 1 ] = _sampleP.y + radius * nrmY;
  out[ 2 ] = _sampleP.z + radius * nrmZ;
  return out;

}

/**

· Creates an ECS entity carrying the parameters needed to build a tube geometry.
· The entity lives in the module-level geometryWorld and is queryable via tubeQuery.
· 
· @param {number} [radius=1]
· @param {number} [tubularSegments=64]
· @param {number} [radialSegments=8]
· @param {boolean} [closed=false]
· @return {number} entity id
  */
  function spawnTubeParams( radius = 1, tubularSegments = 64, radialSegments = 8, closed = false ) {
  const eid = addEntity( geometryWorld );
  addComponent( geometryWorld, TubeParams, eid );
  TubeParams.radius[ eid ] = radius;
  TubeParams.tubularSegments[ eid ] = tubularSegments;
  TubeParams.radialSegments[ eid ] = radialSegments;
  TubeParams.closed[ eid ] = closed ? 1 : 0;
  return eid;

}

export { TubeGeometry, TubeParams, tubeQuery, tubePointAt, displaceTubeByNoise, spawnTubeParams };
export default TubeGeometry;

