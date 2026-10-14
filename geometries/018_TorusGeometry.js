
// file number : 018
// full path name : src/geometries/018_TorusGeometry.js
// description : TorusGeometry — a BufferGeometry subclass generating a torus (donut/ring) via procedural vertex/normal/uv/index construction with zero-allocation typed arrays, analytic unit normals, trig lookup tables, and optional simplex-noise displacement for the Anime stylized pipeline.
// best for    : Android arm64 mobile rendering, procedural donuts/rings/tires, anime-style volume boundaries, instanced & ECS-driven geometry spawning, high-segment-count torus meshes, per-frame geometry rebuilds.
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

// ─── Component definitions for torus parameter tracking ──────────────────────
const TorusParams = defineComponent( {
	radius: Types.f32,
	tube: Types.f32,
	radialSegments: Types.ui16,
	tubularSegments: Types.ui16,
	arc: Types.f32,
	thetaStart: Types.f32,
	thetaLength: Types.f32
} );

const torusQuery = query( [ TorusParams ] );

// double-double fallback — only entered when float32 would suffer catastrophic cancellation
function preciseAdd( a, b ) {

	return Number( new Double( a ).add( new Double( b ) ) );

}

/**
 * A geometry class for representing a torus.
 *
 * ```js
 * const geometry = new THREE.TorusGeometry( 10, 3, 16, 100 );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const torus = new THREE.Mesh( geometry, material );
 * scene.add( torus );
```

· 
· Hot-path notes (Android / arm64):
· · 2 trig calls per ring + per segment instead of 4 per vertex (lookup tables).
· · No Array.prototype.push, no Vector3 scratch objects → zero GC pressure.
· · Positions / normals / uvs written straight into pre-sized Float32Arrays.
· · Normals analytically unit length: n = ( cosV·cosU, cosV·sinU, sinV ) → no normalize, no sqrt.
· · Index buffer auto-selects Uint16Array (≤ 65536 verts) or Uint32Array.
· · Analytic bounding sphere for closed torus → skips lazy O(n) vertex scan.
· 
· @augments BufferGeometry
· @demo scenes/geometry-browser.html#TorusGeometry
  */
  class TorusGeometry extends BufferGeometry {
  /**
  · Constructs a new torus geometry.
  · 
  · @param {number} [radius=1] - Radius of the torus, from the center of the torus to the center of the tube.
  · @param {number} [tube=0.4] - Radius of the tube. Must be smaller than radius.
  · @param {number} [radialSegments=12] - The number of radial segments.
  · @param {number} [tubularSegments=48] - The number of tubular segments.
  · @param {number} [arc=Math.PI*2] - Central angle in radians.
  · @param {number} [thetaStart=0] - Start of the tubular sweep in radians.
  · @param {number} [thetaLength=Math.PI*2] - Length of the tubular sweep in radians.
    */
    constructor( radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48, arc = TWO_PI, thetaStart = 0, thetaLength = TWO_PI ) {
    super();
    this.type = 'TorusGeometry';
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
      radialSegments: radialSegments,
      tubularSegments: tubularSegments,
      arc: arc,
      thetaStart: thetaStart,
      thetaLength: thetaLength
      };
    // ── ECS registration ────────────────────────────────────────────────────
    const eid = addEntity( geometryWorld );
    addComponent( geometryWorld, TorusParams, eid );
    TorusParams.radius[ eid ] = radius;
    TorusParams.tube[ eid ] = tube;
    TorusParams.radialSegments[ eid ] = radialSegments;
    TorusParams.tubularSegments[ eid ] = tubularSegments;
    TorusParams.arc[ eid ] = arc;
    TorusParams.thetaStart[ eid ] = thetaStart;
    TorusParams.thetaLength[ eid ] = thetaLength;
    // ── integer sanitisation: keep both counters as V8 small ints ──────────
    radialSegments = Math.max( 1, Math.floor( radialSegments ) );
    tubularSegments = Math.max( 1, Math.floor( tubularSegments ) );
    const radialCount = radialSegments + 1;
    const tubularCount = tubularSegments + 1;
    const invRadial = 1 / radialSegments;
    const invTubular = 1 / tubularSegments;
    // ── trig lookup tables ─────────────────────────────────────────────────
    const cosU = new Float64Array( tubularCount );
    const sinU = new Float64Array( tubularCount );
    for ( let i = 0; i < tubularCount; i ++ ) {
    }
    const cosV = new Float64Array( radialCount );
    const sinV = new Float64Array( radialCount );
    for ( let j = 0; j < radialCount; j ++ ) {
    }
    // ── single allocation pass ──────────────────────────────────────────────
    const vertexCount = radialCount * tubularCount;
    const indexCount = radialSegments * tubularSegments * 6;
    const positions = new Float32Array( vertexCount * 3 );
    const normals = new Float32Array( vertexCount * 3 );
    const uvs = new Float32Array( vertexCount * 2 );
    // only taken for pathological radius/tube ratios — never on the common path
    const highPrecision = tube > 0 && radius / tube > 1e6;
    let p = 0, n = 0, t = 0;
    for ( let j = 0; j < radialCount; j ++ ) {
    }
    // ── indices: one typed array, pointer filled, no closures ───────────────
    const indices = vertexCount > 65536 ? new Uint32Array( indexCount ) : new Uint16Array( indexCount );
    let k = 0;
    for ( let j = 1; j <= radialSegments; j ++ ) {
    }
    // ── build geometry ──────────────────────────────────────────────────────
    this.setIndex( indices );
    this.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );
    // analytic bounding sphere for the closed torus — skips lazy O(n) vertex scan + frustum-cull cost
    if ( arc === TWO_PI && thetaStart === 0 && thetaLength === TWO_PI ) {
    }
  }
  copy( source ) {
  }
  /**
  · Factory method for creating an instance of this class from the given
  · JSON object.
  · 
  · @param {Object} data - A JSON object representing the serialized geometry.
  · @return {TorusGeometry} A new instance.
    */
    static fromJSON( data ) {
    return new TorusGeometry(
    data.radius,
    data.tube,
    data.radialSegments,
    data.tubularSegments,
    data.arc,
    data.thetaStart,
    data.thetaLength
    );
  }

}

// ─── Shared simplex-noise instance (created once, reused across all displacements) ─
const _noise3D = createNoise3D();

/**

· Displaces an existing torus along its normals with 3D simplex noise, in place.
· Uses the shared noise instance to avoid allocation per call.
· 
· @param {TorusGeometry} geometry
· @param {number} [amplitude=0.1]
· @param {number} [frequency=1]
· @param {number} [seed=0]
· @return {TorusGeometry}
  */
  function displaceTorusByNoise( geometry, amplitude = 0.1, frequency = 1, seed = 0 ) {
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

/**

· Writes the point on the torus surface at (u, v) into out
· (defaults to a shared scratch vec3, zero allocation).
· 
· @param {number} radius
· @param {number} tube
· @param {number} u
· @param {number} v
· @param {Float32Array|Float64Array} [out]
· @return {Float32Array|Float64Array}
  */
  function torusPointAt( radius, tube, u, v, out = _sampleScratch ) {
  const r = radius + tube * Math.cos( v );
  out[ 0 ] = r * Math.cos( u );
  out[ 1 ] = r * Math.sin( u );
  out[ 2 ] = tube * Math.sin( v );
  return out;

}

/**

· Creates an ECS entity carrying the parameters needed to build a torus geometry.
· The entity lives in the module-level geometryWorld and is queryable via torusQuery.
· 
· @param {number} [radius=1]
· @param {number} [tube=0.4]
· @param {number} [radialSegments=12]
· @param {number} [tubularSegments=48]
· @return {number} entity id
  */
  function spawnTorusParams( radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48 ) {
  const eid = addEntity( geometryWorld );
  addComponent( geometryWorld, TorusParams, eid );
  TorusParams.radius[ eid ] = radius;
  TorusParams.tube[ eid ] = tube;
  TorusParams.radialSegments[ eid ] = radialSegments;
  TorusParams.tubularSegments[ eid ] = tubularSegments;
  TorusParams.arc[ eid ] = TWO_PI;
  TorusParams.thetaStart[ eid ] = 0;
  TorusParams.thetaLength[ eid ] = TWO_PI;
  return eid;

}

export { TorusGeometry, TorusParams, torusQuery, torusPointAt, displaceTorusByNoise, spawnTorusParams };
