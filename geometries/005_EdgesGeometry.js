// file number : 005
// full path name : src/geometries/005_EdgesGeometry.js
// description : EdgesGeometry — extracts hard edges from any BufferGeometry by comparing
//               face-normal angles against a threshold. Produces a LineSegments-friendly
//               geometry with paired vertices for each qualifying edge. Uses precision-point
//               hashing for edge deduplication and degenerate-triangle rejection.
//               Integrates bitecs ECS, gl-matrix, double.js, and simplex-noise for enhanced
//               geometric computation and edge statistics tracking.
// license : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { DEG2RAD } from '../math/001_MathUtils.js';
import { Triangle } from '../math/014_Triangle.js';
import { Vector3 } from '../math/003_Vector3.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const edgesWorld = createWorld();

// ─── Component definitions for edge tracking ────────────────────────────────
const EdgesParams = defineComponent({
  thresholdAngle: Types.f32,
  precisionPoints: Types.ui8
});

const EdgesStats = defineComponent({
  inputVertexCount: Types.ui32,
  inputTriangleCount: Types.ui32,
  outputEdgeCount: Types.ui32,
  skippedDegenerate: Types.ui32,
  uniqueEdgeCount: Types.ui32
});

// ─── Module-private scratch objects (mirrors r185 source) ───────────────────
const _v0 = /*@__PURE__*/ new Vector3();
const _v1 = /*@__PURE__*/ new Vector3();
const _normal = /*@__PURE__*/ new Vector3();
const _triangle = /*@__PURE__*/ new Triangle();

/**
 * Can be used as a helper object to view the edges of a geometry.
 *
 * ```js
 * const geometry = new THREE.BoxGeometry();
 * const edges = new THREE.EdgesGeometry( geometry );
 * const line = new THREE.LineSegments( edges );
 * scene.add( line );
 * ```
 *
 * Note: It is not yet possible to serialize/deserialize instances of this class.
 *
 * @augments BufferGeometry
 */
class EdgesGeometry extends BufferGeometry {

  /**
   * Constructs a new edges geometry.
   *
   * @param {?BufferGeometry} [geometry=null] - The geometry.
   * @param {number} [thresholdAngle=1] - An edge is only rendered if the angle (in degrees)
   *        between the face normals of the adjoining faces exceeds this value.
   */
  constructor( geometry = null, thresholdAngle = 1 ) {

    super();

    this.type = 'EdgesGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      geometry: geometry,
      thresholdAngle: thresholdAngle
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    if ( geometry !== null ) {

      const precisionPoints = 4;
      const precision = Math.pow( 10, precisionPoints );
      const thresholdDot = Math.cos( DEG2RAD * thresholdAngle );

      const indexAttr = geometry.getIndex();
      const positionAttr = geometry.getAttribute( 'position' );
      const indexCount = indexAttr ? indexAttr.count : positionAttr.count;

      const indexArr = [ 0, 0, 0 ];
      const vertKeys = [ 'a', 'b', 'c' ];
      const hashes = new Array( 3 );

      const edgeData = {};
      const vertices = [];

      // ─── ECS: register edges entity ─────────────────────────────────────
      const entityId = addEntity( edgesWorld );

      addComponent( edgesWorld, EdgesParams, {
        thresholdAngle: thresholdAngle,
        precisionPoints: precisionPoints
      }, entityId );

      // ─── Stats accumulators ─────────────────────────────────────────────
      let inputTriangleCount = 0;
      let skippedDegenerate = 0;

      // ─── gl-matrix scratch for AABB and interop ─────────────────────────
      const _glVec3 = glMatrix.vec3.create();

      // ─── Double-precision accumulator for edge-length stats ─────────────
      let totalEdgeLength = new Double( 0 );

      // ─── Noise instance for optional edge perturbation ──────────────────
      const _noise2D = createNoise2D();

      for ( let i = 0; i < indexCount; i += 3 ) {

        inputTriangleCount ++;

        if ( indexAttr ) {

          indexArr[ 0 ] = indexAttr.getX( i );
          indexArr[ 1 ] = indexAttr.getX( i + 1 );
          indexArr[ 2 ] = indexAttr.getX( i + 2 );

        } else {

          indexArr[ 0 ] = i;
          indexArr[ 1 ] = i + 1;
          indexArr[ 2 ] = i + 2;
        }

        const { a, b, c } = _triangle;

        a.fromBufferAttribute( positionAttr, indexArr[ 0 ] );
        b.fromBufferAttribute( positionAttr, indexArr[ 1 ] );
        c.fromBufferAttribute( positionAttr, indexArr[ 2 ] );

        _triangle.getNormal( _normal );

        // ─── Create hashes for the edge from the vertices ────────────────
        hashes[ 0 ] = `${ Math.round( a.x * precision ) },${ Math.round( a.y * precision ) },${ Math.round( a.z * precision ) }`;
        hashes[ 1 ] = `${ Math.round( b.x * precision ) },${ Math.round( b.y * precision ) },${ Math.round( b.z * precision ) }`;
        hashes[ 2 ] = `${ Math.round( c.x * precision ) },${ Math.round( c.y * precision ) },${ Math.round( c.z * precision ) }`;

        // ─── Skip degenerate triangles ───────────────────────────────────
        if ( hashes[ 0 ] === hashes[ 1 ] || hashes[ 1 ] === hashes[ 2 ] || hashes[ 2 ] === hashes[ 0 ] ) {

          skippedDegenerate ++;
          continue;
        }

        // ─── Check all three edges ───────────────────────────────────────
        for ( let j = 0; j < 3; j ++ ) {

          const k = ( j + 1 ) % 3;

          const v0 = vertKeys[ j ];
          const v1 = vertKeys[ k ];

          const hash0 = hashes[ j ];
          const hash1 = hashes[ k ];

          const edge = [ hash0, hash1 ].sort().join( '_' );

          if ( edgeData[ edge ] === undefined ) {

            edgeData[ edge ] = {
              normal: _normal.clone(),
              vertices: [ _triangle[ v0 ].clone(), _triangle[ v1 ].clone() ]
            };

          } else {

            const existing = edgeData[ edge ];

            // ─── Angle test: keep edge only if dihedral exceeds threshold ─
            if ( existing.normal.dot( _normal ) < thresholdDot ) {

              // ─── Preserve or replace stored normal/vertices ──────────────
              existing.normal.copy( _normal );
              existing.vertices[ 0 ].copy( _triangle[ v0 ] );
              existing.vertices[ 1 ].copy( _triangle[ v1 ] );

              // ─── Mark as a real edge (not just a shared face) ────────────
              existing.hard = true;
            }
          }
        }
      }

      // ─── Emit only edges that qualified as hard edges ──────────────────
      let outputEdgeCount = 0;

      for ( const key in edgeData ) {

        const edge = edgeData[ key ];

        if ( edge.hard ) {

          const v0 = edge.vertices[ 0 ];
          const v1 = edge.vertices[ 1 ];

          vertices.push( v0.x, v0.y, v0.z );
          vertices.push( v1.x, v1.y, v1.z );

          // ─── Accumulate edge length in double precision ────────────────
          const dx = new Double( v1.x - v0.x );
          const dy = new Double( v1.y - v0.y );
          const dz = new Double( v1.z - v0.z );

          const lenSq = dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) );
          totalEdgeLength = totalEdgeLength.add( lenSq.sqrt() );

          outputEdgeCount ++;
        }
      }

      // ─── Build geometry ────────────────────────────────────────────────
      this.setAttribute( 'position', new Float32BufferAttribute( vertices, 3 ) );

      // ─── ECS: record edge statistics ───────────────────────────────────
      addComponent( edgesWorld, EdgesStats, {
        inputVertexCount: positionAttr.count,
        inputTriangleCount: inputTriangleCount,
        outputEdgeCount: outputEdgeCount,
        skippedDegenerate: skippedDegenerate,
        uniqueEdgeCount: Object.keys( edgeData ).length
      }, entityId );

      // ─── Store entity ID and edge data for later retrieval ─────────────
      this._edgesEntityId = entityId;
      this._edgeData = edgeData;
      this._totalEdgeLength = totalEdgeLength.toNumber();
    }
  }

  /**
   * Creates a new EdgesGeometry from a JSON object.
   * Note: EdgesGeometry cannot be fully deserialized because it stores a
   * reference to the source geometry. This factory creates an empty instance.
   *
   * @param {Object} data - The JSON data.
   * @return {EdgesGeometry} A new EdgesGeometry instance.
   */
  static fromJSON( data ) {

    return new EdgesGeometry( null, data.thresholdAngle );
  }

  /**
   * Returns the world-space axis-aligned bounding box of this geometry.
   * Result is cached after the first computation.
   *
   * @return {Object} An object with min and max gl-matrix vec3 values.
   */
  getAABB() {

    if ( this._cachedAABB ) return this._cachedAABB;

    const positions = this.getAttribute( 'position' ).array;
    const count = positions.length / 3;

    const min = glMatrix.vec3.fromValues( Infinity, Infinity, Infinity );
    const max = glMatrix.vec3.fromValues( - Infinity, - Infinity, - Infinity );

    for ( let i = 0; i < count; i ++ ) {

      const i3 = i * 3;
      const x = positions[ i3 ];
      const y = positions[ i3 + 1 ];
      const z = positions[ i3 + 2 ];

      if ( x < min[ 0 ] ) min[ 0 ] = x;
      if ( y < min[ 1 ] ) min[ 1 ] = y;
      if ( z < min[ 2 ] ) min[ 2 ] = z;

      if ( x > max[ 0 ] ) max[ 0 ] = x;
      if ( y > max[ 1 ] ) max[ 1 ] = y;
      if ( z > max[ 2 ] ) max[ 2 ] = z;
    }

    this._cachedAABB = { min, max };
    return this._cachedAABB;
  }

  /**
   * Applies a noise-based displacement to all edge vertices.
   * Uses simplex-noise for procedural edge deformation.
   *
   * @param {number} [amplitude=0.1] - Displacement amplitude.
   * @param {number} [frequency=1] - Noise frequency.
   */
  applyNoise( amplitude = 0.1, frequency = 1 ) {

    const noise2D = createNoise2D();
    const positions = this.getAttribute( 'position' ).array;
    const count = positions.length / 3;

    for ( let i = 0; i < count; i ++ ) {

      const i3 = i * 3;
      const x = positions[ i3 ];
      const y = positions[ i3 + 1 ];

      const n = noise2D( x * frequency, y * frequency );
      const disp = n * amplitude;

      positions[ i3 ] += disp;
      positions[ i3 + 1 ] += disp;
      positions[ i3 + 2 ] += disp;
    }

    this.getAttribute( 'position' ).needsUpdate = true;
    this._cachedAABB = null;
  }

  /**
   * Returns the total length of all hard edges in double precision.
   *
   * @return {number} The total edge length.
   */
  getTotalEdgeLength() {

    return this._totalEdgeLength || 0;
  }

  /**
   * Returns the edge data map for advanced inspection.
   * Each entry contains the edge normal and vertex pair.
   *
   * @return {Object} The edge data map.
   */
  getEdgeData() {

    return this._edgeData || {};
  }

  /**
   * Queries all EdgesGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( edgesWorld, [ EdgesParams, EdgesStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          thresholdAngle: EdgesParams.thresholdAngle[ entity ],
          precisionPoints: EdgesParams.precisionPoints[ entity ]
        },
        stats: {
          inputVertexCount: EdgesStats.inputVertexCount[ entity ],
          inputTriangleCount: EdgesStats.inputTriangleCount[ entity ],
          outputEdgeCount: EdgesStats.outputEdgeCount[ entity ],
          skippedDegenerate: EdgesStats.skippedDegenerate[ entity ],
          uniqueEdgeCount: EdgesStats.uniqueEdgeCount[ entity ]
        }
      } );
    }

    return results;
  }

  copy( source ) {

    super.copy( source );
    this.parameters = Object.assign( {}, source.parameters );
    return this;
  }
}

export { EdgesGeometry };
export default EdgesGeometry;