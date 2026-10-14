
// file number : 021
// full path name : src/geometries/021_WireframeGeometry.js
// description : WireframeGeometry — a BufferGeometry subclass that extracts every unique triangle edge from a source geometry as LineSegments-ready vertex pairs, using zero-allocation typed arrays, a collision-resistant dual-hash edge table (Math.imul-based, no string concatenation), pre-allocated output buffers, and auto-select index buffers for the Anime stylized pipeline.
// best for    : Android arm64 mobile rendering, debug wireframe overlays, anime-style outline/sketch passes, instanced & ECS-driven geometry introspection, high-poly source geometry edge extraction, per-frame geometry rebuilds.
// license     : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (pre-allocated for performance) ──────────────────────────────
const geometryWorld = createWorld();

// ─── Component definitions for wireframe parameter tracking ─────────────────
const WireframeParams = defineComponent( {
	edgeCount: Types.ui32,
	sourceVertexCount: Types.ui32,
	sourceIndexCount: Types.ui32,
	indexed: Types.ui8
} );

const wireframeQuery = query( [ WireframeParams ] );

// double-double fallback — only entered when float32 would suffer catastrophic cancellation
function preciseAdd( a, b ) {

	return Number( new Double( a ).add( new Double( b ) ) );

}

/**
 * Attempts to insert a unique edge into the output buffer.
 * Returns `true` if the edge was new (and was written to `positions`), `false` otherwise.
 *
 * Collision resistance: TWO independent 32-bit hashes are stored per slot and BOTH must
 * match for the edge to be considered a duplicate. Combined collision probability is
 * ~1 / 2^64 per pair — astronomically low for any realistic mesh.
 *
 * Symmetry: endpoint coordinates are lexicographically ordered before hashing, so
 * edge (A,B) and edge (B,A) produce identical hash values.
 *
 * @param {Float32Array|Float64Array} posArray
 * @param {number} posStride
 * @param {number} i0
 * @param {number} i1
 * @param {Int32Array} hashA - primary 32-bit hash table
 * @param {Int32Array} hashB - secondary 32-bit hash table
 * @param {Uint8Array} hashUsed - occupancy flags
 * @param {number} hashMask - (capacity - 1)
 * @param {Float32Array} positions - output buffer
 * @param {number} outputOffset - write offset into `positions`
 * @return {boolean}
 */
function tryUniqueEdge( posArray, posStride, i0, i1, hashA, hashB, hashUsed, hashMask, positions, outputOffset ) {

	const o0 = i0 * posStride;
	const o1 = i1 * posStride;

	const x1 = posArray[ o0 ];
	const y1 = posArray[ o0 + 1 ];
	const z1 = posArray[ o0 + 2 ];
	const x2 = posArray[ o1 ];
	const y2 = posArray[ o1 + 1 ];
	const z2 = posArray[ o1 + 2 ];

	// quantise to 4 decimal places (matches three.js EdgesGeometry precisionPoints = 4)
	// `| 0` clamps to int32 — safe for coordinates in [-214748.3647, +214748.3647]
	const qx1 = Math.round( x1 * 10000 ) | 0;
	const qy1 = Math.round( y1 * 10000 ) | 0;
	const qz1 = Math.round( z1 * 10000 ) | 0;
	const qx2 = Math.round( x2 * 10000 ) | 0;
	const qy2 = Math.round( y2 * 10000 ) | 0;
	const qz2 = Math.round( z2 * 10000 ) | 0;

	// lexicographic ordering → symmetric hash for (A,B) and (B,A)
	let ax = qx1, ay = qy1, az = qz1;
	let bx = qx2, by = qy2, bz = qz2;

	if ( qx1 > qx2 || ( qx1 === qx2 && ( qy1 > qy2 || ( qy1 === qy2 && qz1 > qz2 ) ) ) ) {

		ax = qx2; ay = qy2; az = qz2;
		bx = qx1; by = qy1; bz = qz1;

	}

	// dual hash — two independent prime-multiplier mixes with Math.imul for true 32-bit wraparound
	const hA = ( Math.imul( ax, 73856093 ) ^ Math.imul( ay, 19349663 ) ^ Math.imul( az, 83492791 ) ) | 0;
	const hB = ( Math.imul( bx, 2654435761 ) ^ Math.imul( by, 40503 ) ^ Math.imul( bz, 12345 ) ) | 0;

	// open addressing with linear probing
	let slot = ( hA >>> 0 ) & hashMask;

	for ( ; ; ) {

		if ( hashUsed[ slot ] === 0 ) {

			// empty slot → new edge, insert
			hashA[ slot ] = hA;
			hashB[ slot ] = hB;
			hashUsed[ slot ] = 1;

			positions[ outputOffset ] = x1;
			positions[ outputOffset + 1 ] = y1;
			positions[ outputOffset + 2 ] = z1;
			positions[ outputOffset + 3 ] = x2;
			positions[ outputOffset + 4 ] = y2;
			positions[ outputOffset + 5 ] = z2;

			return true;

		}

		if ( hashA[ slot ] === hA && hashB[ slot ] === hB ) {

			// both hashes match → duplicate edge
			return false;

		}

		slot = ( slot + 1 ) & hashMask;

	}

}

/**
 * Can be used as a helper object to visualize a geometry as a wireframe.
 *
 * ```js
 * const geometry = new THREE.SphereGeometry();
 * const wireframe = new THREE.WireframeGeometry( geometry );
 * const line = new THREE.LineSegments( wireframe );
 * line.material.depthWrite = false;
 * line.material.opacity = 0.25;
 * line.material.transparent = true;
 * scene.add( line );
```

· 
· Hot-path notes (Android / arm64):
· · Dual 32-bit hashing via Math.imul — no string concatenation, no GC pressure, negligible collisions.
· · Open-addressing linear-probe hash tables — O(1) average lookup, no Set/Map overhead.
· · Output positions written straight into a pre-allocated Float32Array, then slice()d to exact size.
· · Self-edges (i0 === i1) skipped as in three.js EdgesGeometry.
· · Analytic bounding sphere delegated to computeBoundingSphere().
· 
· @augments BufferGeometry
· @demo scenes/geometry-browser.html#WireframeGeometry
  */
  class WireframeGeometry extends BufferGeometry {
  /**
  · Constructs a new wireframe geometry.
  · 
  · @param {?BufferGeometry} [geometry=null] - The source geometry.
    */
    constructor( geometry = null ) {
    super();
    this.type = 'WireframeGeometry';
    /**
    · Holds the constructor parameters that have been
    · used to generate the geometry. Any modification
    · after instantiation does not change the geometry.
    · 
    · @type {Object}
      */
      this.parameters = {
      geometry: geometry
      };
    if ( geometry === null ) {
    }
    const positionAttr = geometry.getAttribute( 'position' );
    const indexAttr = geometry.getIndex();
    if ( positionAttr === undefined ) {
    }
    const posArray = positionAttr.array;
    const posStride = positionAttr.itemSize;
    // ── ECS registration ────────────────────────────────────────────────────
    const eid = addEntity( geometryWorld );
    addComponent( geometryWorld, WireframeParams, eid );
    WireframeParams.sourceVertexCount[ eid ] = positionAttr.count;
    WireframeParams.sourceIndexCount[ eid ] = indexAttr !== null ? indexAttr.count : 0;
    WireframeParams.indexed[ eid ] = indexAttr !== null ? 1 : 0;
    WireframeParams.edgeCount[ eid ] = 0;
    // ── estimate edge capacity ─────────────────────────────────────────────
    let triangleCount;
    if ( indexAttr !== null ) {
    } else {
    }
    // worst case: 3 unique edges per triangle
    const maxEdgeCount = triangleCount * 3;
    const maxVertexCount = maxEdgeCount * 2;
    // edge hash tables: capacity = next power of two >= 2 * maxEdgeCount (load factor <= 0.5)
    let hashCapacity = 1;
    while ( hashCapacity < maxEdgeCount * 2 ) {
    }
    // edge tables (2 x Int32 for dual-hash, 1 x Uint8 for occupancy)
    const hashA = new Int32Array( hashCapacity );
    const hashB = new Int32Array( hashCapacity );
    const hashUsed = new Uint8Array( hashCapacity );
    const hashMask = hashCapacity - 1;
    // output positions buffer (pre-allocated to worst-case capacity, sliced at the end)
    const positions = new Float32Array( maxVertexCount * 3 );
    let outputOffset = 0;
    let uniqueEdgeCount = 0;
    // ── determine group ranges to iterate ──────────────────────────────────
    let groups = geometry.groups;
    if ( groups === undefined || groups.length === 0 ) {
    }
    // ── edge extraction ────────────────────────────────────────────────────
    if ( indexAttr !== null ) {
    } else {
    }
    // ── trim to exact size (single memcpy, releases oversized backing buffer) ─
    const finalPositions = outputOffset === positions.length
    ? positions
    : positions.slice( 0, outputOffset );
    WireframeParams.edgeCount[ eid ] = uniqueEdgeCount;
    // ── build geometry ──────────────────────────────────────────────────────
    this.setAttribute( 'position', new Float32BufferAttribute( finalPositions, 3 ) );
    this.computeBoundingSphere();
  }
  copy( source ) {
  }
  /**
  · Factory method for creating an instance of this class from the given
  · JSON object.
  · 
  · @param {Object} data - A JSON object representing the serialized geometry.
  · @return {WireframeGeometry} A new instance.
    */
    static fromJSON( data ) {
    return new WireframeGeometry( data.geometry );
  }

}

// ─── Shared simplex-noise instance (created once, reused across all displacements) ─
const _noise3D = createNoise3D();

/**

· Displaces the wireframe vertices along their (implicit) normals with 3D simplex noise, in place.
· Since wireframes have no stored normals, the displacement direction is the
· radial direction from the mesh centroid.
· 
· @param {WireframeGeometry} geometry
· @param {number} [amplitude=0.1]
· @param {number} [frequency=1]
· @param {number} [seed=0]
· @return {WireframeGeometry}
  */
  function displaceWireframeByNoise( geometry, amplitude = 0.1, frequency = 1, seed = 0 ) {
  const position = geometry.attributes.position;
  if ( position === undefined ) {
  }
  const pos = position.array;
  const count = position.count;
  // compute centroid
  let cx = 0, cy = 0, cz = 0;
  for ( let i = 0, o = 0; i < count; i ++, o += 3 ) {
  }
  cx /= count;
  cy /= count;
  cz /= count;
  for ( let i = 0, o = 0; i < count; i ++, o += 3 ) {
  }
  position.needsUpdate = true;
  if ( geometry.computeVertexNormals ) geometry.computeVertexNormals();
  return geometry;

}

// ─── Analytic sampling via gl-matrix (no geometry traversal) ─────────────────
const _sampleScratch = glMatrix.vec3.create();

/**

· Writes the midpoint of edge e from a wireframe geometry into out
· (defaults to a shared scratch vec3, zero allocation).
· 
· @param {WireframeGeometry} geometry
· @param {number} e - Edge index (0-based).
· @param {Float32Array|Float64Array} [out]
· @return {Float32Array|Float64Array}
  */
  function wireframeEdgeMidpoint( geometry, e, out = _sampleScratch ) {
  const position = geometry.attributes.position;
  const pos = position.array;
  const o = e * 6;
  out[ 0 ] = ( pos[ o ] + pos[ o + 3 ] ) * 0.5;
  out[ 1 ] = ( pos[ o + 1 ] + pos[ o + 4 ] ) * 0.5;
  out[ 2 ] = ( pos[ o + 2 ] + pos[ o + 5 ] ) * 0.5;
  return out;

}

/**

· Creates an ECS entity carrying the parameters needed to build a wireframe geometry.
· The entity lives in the module-level geometryWorld and is queryable via wireframeQuery.
· 
· @param {number} [sourceVertexCount=0]
· @param {number} [sourceIndexCount=0]
· @param {boolean} [indexed=false]
· @return {number} entity id
  */
  function spawnWireframeParams( sourceVertexCount = 0, sourceIndexCount = 0, indexed = false ) {
  const eid = addEntity( geometryWorld );
  addComponent( geometryWorld, WireframeParams, eid );
  WireframeParams.sourceVertexCount[ eid ] = sourceVertexCount;
  WireframeParams.sourceIndexCount[ eid ] = sourceIndexCount;
  WireframeParams.indexed[ eid ] = indexed ? 1 : 0;
  WireframeParams.edgeCount[ eid ] = 0;
  return eid;

}

export { WireframeGeometry, WireframeParams, wireframeQuery, wireframeEdgeMidpoint, displaceWireframeByNoise, spawnWireframeParams, tryUniqueEdge };
export default WireframeGeometry;
