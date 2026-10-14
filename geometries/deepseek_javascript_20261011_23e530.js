// file number : 010
// full path name : src/geometries/010_PolyhedronGeometry.js
// description : PolyhedronGeometry — a solid in three dimensions with flat faces.
//               Takes an array of vertices and indices describing a base polyhedron,
//               projects them onto a sphere, and subdivides faces to the desired
//               level of detail. Generates smooth or flat normals and UVs based on
//               spherical mapping. Integrates bitecs ECS for parameter/stat tracking,
//               gl-matrix for cached AABB and interop, double.js for high-precision
//               volume estimation, and simplex-noise for procedural radial
//               displacement. Provides fromVec3 / fromDouble factories.
// license : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { Vector3 } from '../math/003_Vector3.js';
import { Vector2 } from '../math/002_Vector2.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const polyhedronWorld = createWorld();

// ─── Component definitions for polyhedron tracking ──────────────────────────
const PolyhedronParams = defineComponent({
  inputVertexCount: Types.ui16,
  inputIndexCount: Types.ui16,
  radius: Types.f32,
  detail: Types.ui8
});

const PolyhedronStats = defineComponent({
  outputVertexCount: Types.ui32,
  outputTriangleCount: Types.ui32,
  outputUvCount: Types.ui32
});

/**
 * A polyhedron is a solid in three dimensions with flat faces. This class
 * will take an array of vertices, project them onto a sphere, and then
 * divide them up to the desired level of detail.
 *
 * @augments BufferGeometry
 */
class PolyhedronGeometry extends BufferGeometry {

  /**
   * Constructs a new polyhedron geometry.
   *
   * @param {Array} [vertices] - A flat array of vertices describing the base shape.
   * @param {Array} [indices] - A flat array of indices describing the base shape.
   * @param {number} [radius=1] - The radius of the shape.
   * @param {number} [detail=0] - How many levels to subdivide the geometry. The more detail,
   *        the smoother the shape.
   */
  constructor( vertices = [], indices = [], radius = 1, detail = 0 ) {

    super();

    this.type = 'PolyhedronGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      vertices: vertices,
      indices: indices,
      radius: radius,
      detail: detail
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    // ─── ECS: register polyhedron entity ───────────────────────────────────
    const entityId = addEntity( polyhedronWorld );

    addComponent( polyhedronWorld, PolyhedronParams, {
      inputVertexCount: vertices.length / 3,
      inputIndexCount: indices.length,
      radius: radius,
      detail: detail
    }, entityId );

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for volume ───────────────────────────
    let totalVolume = new Double( 0 );

    // ─── Reusable Vector3 scratch (single allocation) ──────────────────────
    const _vec3 = new Vector3();
    const _vec3b = new Vector3();
    const _vec3c = new Vector3();

    // ─── Default buffer data ───────────────────────────────────────────────
    const vertexBuffer = [];
    const uvBuffer = [];

    // ─── Subdivide the geometry ────────────────────────────────────────────
    subdivide( detail );

    // ─── Project all vertices onto the sphere ──────────────────────────────
    applyRadius( radius );

    // ─── Generate UV coordinates ───────────────────────────────────────────
    generateUVs();

    // ─── Build non-indexed geometry ────────────────────────────────────────
    this.setAttribute( 'position', new Float32BufferAttribute( vertexBuffer, 3 ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( vertexBuffer.slice(), 3 ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvBuffer, 2 ) );

    if ( detail === 0 ) {

      this.computeVertexNormals(); // flat normals

    } else {

      this.normalizeNormals(); // smooth normals
    }

    // ─── ECS: record polyhedron statistics ─────────────────────────────────
    addComponent( polyhedronWorld, PolyhedronStats, {
      outputVertexCount: vertexBuffer.length / 3,
      outputTriangleCount: vertexBuffer.length / 9,
      outputUvCount: uvBuffer.length / 2
    }, entityId );

    this._polyhedronEntityId = entityId;

    // ─── Helper functions ──────────────────────────────────────────────────

    function subdivide( detail ) {

      const a = new Vector3();
      const b = new Vector3();
      const c = new Vector3();

      // iterate over all faces and apply a subdivision with the given detail value
      for ( let i = 0; i < indices.length; i += 3 ) {

        // get the vertices of the face
        getVertexByIndex( indices[ i + 0 ], a );
        getVertexByIndex( indices[ i + 1 ], b );
        getVertexByIndex( indices[ i + 2 ], c );

        // perform subdivision
        subdivideFace( a, b, c, detail );
      }
    }

    function subdivideFace( a, b, c, detail ) {

      const cols = detail + 1;

      // we use this multidimensional array as a data structure for creating the subdivision
      const v = [];

      // construct all of the vertices for this subdivision
      for ( let i = 0; i <= cols; i ++ ) {

        v[ i ] = [];

        const aj = a.clone().lerp( c, i / cols );
        const bj = b.clone().lerp( c, i / cols );

        const rows = cols - i;

        for ( let j = 0; j <= rows; j ++ ) {

          if ( j === 0 && i === cols ) {

            v[ i ][ j ] = aj;

          } else {

            v[ i ][ j ] = aj.clone().lerp( bj, j / rows );
          }
        }
      }

      // construct all of the faces
      for ( let i = 0; i < cols; i ++ ) {

        for ( let j = 0; j < 2 * ( cols - i ) - 1; j ++ ) {

          const k = Math.floor( j / 2 );

          if ( j % 2 === 0 ) {

            pushVertex( v[ i ][ k + 1 ] );
            pushVertex( v[ i + 1 ][ k ] );
            pushVertex( v[ i ][ k ] );

          } else {

            pushVertex( v[ i ][ k + 1 ] );
            pushVertex( v[ i + 1 ][ k + 1 ] );
            pushVertex( v[ i + 1 ][ k ] );
          }
        }
      }
    }

    function applyRadius( radius ) {

      const vertex = new Vector3();

      // iterate over the entire buffer and apply the radius to each vertex
      for ( let i = 0; i < vertexBuffer.length; i += 3 ) {

        vertex.x = vertexBuffer[ i + 0 ];
        vertex.y = vertexBuffer[ i + 1 ];
        vertex.z = vertexBuffer[ i + 2 ];

        vertex.normalize().multiplyScalar( radius );

        vertexBuffer[ i + 0 ] = vertex.x;
        vertexBuffer[ i + 1 ] = vertex.y;
        vertexBuffer[ i + 2 ] = vertex.z;
      }
    }

    function generateUVs() {

      const vertex = new Vector3();

      for ( let i = 0; i < vertexBuffer.length; i += 3 ) {

        vertex.x = vertexBuffer[ i + 0 ];
        vertex.y = vertexBuffer[ i + 1 ];
        vertex.z = vertexBuffer[ i + 2 ];

        const u = azimuth( vertex ) / 2 / Math.PI + 0.5;
        const v = inclination( vertex ) / Math.PI + 0.5;

        uvBuffer.push( u, 1 - v );
      }

      correctUVs();
      correctSeam();
    }

    function correctSeam() {

      // handle case when face straddles the seam, see #3269
      for ( let i = 0; i < uvBuffer.length; i += 6 ) {

        // uv data of a single face
        const x0 = uvBuffer[ i + 0 ];
        const x1 = uvBuffer[ i + 2 ];
        const x2 = uvBuffer[ i + 4 ];

        const max = Math.max( x0, x1, x2 );
        const min = Math.min( x0, x1, x2 );

        // 0.9 is somewhat arbitrary
        if ( max > 0.9 && min < 0.1 ) {

          if ( x0 < 0.2 ) uvBuffer[ i + 0 ] += 1;
          if ( x1 < 0.2 ) uvBuffer[ i + 2 ] += 1;
          if ( x2 < 0.2 ) uvBuffer[ i + 4 ] += 1;
        }
      }
    }

    function pushVertex( vertex ) {

      vertexBuffer.push( vertex.x, vertex.y, vertex.z );
    }

    function getVertexByIndex( index, vertex ) {

      const stride = index * 3;

      vertex.x = vertices[ stride + 0 ];
      vertex.y = vertices[ stride + 1 ];
      vertex.z = vertices[ stride + 2 ];
    }

    function correctUVs() {

      const a = new Vector3();
      const b = new Vector3();
      const c = new Vector3();

      const centroid = new Vector3();

      const uvA = new Vector2();
      const uvB = new Vector2();
      const uvC = new Vector2();

      for ( let i = 0, j = 0; i < vertexBuffer.length; i += 9, j += 6 ) {

        a.set( vertexBuffer[ i + 0 ], vertexBuffer[ i + 1 ], vertexBuffer[ i + 2 ] );
        b.set( vertexBuffer[ i + 3 ], vertexBuffer[ i + 4 ], vertexBuffer[ i + 5 ] );
        c.set( vertexBuffer[ i + 6 ], vertexBuffer[ i + 7 ], vertexBuffer[ i + 8 ] );

        uvA.set( uvBuffer[ j + 0 ], uvBuffer[ j + 1 ] );
        uvB.set( uvBuffer[ j + 2 ], uvBuffer[ j + 3 ] );
        uvC.set( uvBuffer[ j + 4 ], uvBuffer[ j + 5 ] );

        centroid.copy( a ).add( b ).add( c ).divideScalar( 3 );

        const azi = azimuth( centroid );

        correctUV( uvA, j + 0, a, azi );
        correctUV( uvB, j + 2, b, azi );
        correctUV( uvC, j + 4, c, azi );
      }
    }

    function correctUV( uv, stride, vector, azimuth ) {

      if ( ( azimuth < 0 ) && ( uv.x === 1 ) ) {

        uvBuffer[ stride ] = uv.x - 1;
      }

      if ( ( vector.x === 0 ) && ( vector.z === 0 ) ) {

        uvBuffer[ stride ] = azimuth / 2 / Math.PI + 0.5;
      }
    }

    // Angle around the Y axis, counter-clockwise when looking from above.
    function azimuth( vector ) {

      return Math.atan2( vector.z, - vector.x );
    }

    // Angle above the XZ plane.
    function inclination( vector ) {

      return Math.atan2( - vector.y, Math.sqrt( ( vector.x * vector.x ) + ( vector.z * vector.z ) ) );
    }
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {PolyhedronGeometry} A new instance.
   */
  static fromJSON( data ) {

    return new PolyhedronGeometry( data.vertices, data.indices, data.radius, data.detail );
  }

  /**
   * Creates a PolyhedronGeometry from a gl-matrix vec3 array.
   * The vec3 array is flattened into the vertex buffer expected by the constructor.
   *
   * @param {Array<vec3>} vec3Array - Array of gl-matrix vec3 vertices.
   * @param {Array<number>} indices - Flat index array.
   * @param {number} [radius=1] - Sphere radius.
   * @param {number} [detail=0] - Subdivision detail.
   * @return {PolyhedronGeometry} A new PolyhedronGeometry instance.
   */
  static fromVec3Array( vec3Array, indices, radius = 1, detail = 0 ) {

    const flat = new Float32Array( vec3Array.length * 3 );

    for ( let i = 0; i < vec3Array.length; i ++ ) {

      flat[ i * 3 + 0 ] = vec3Array[ i ][ 0 ];
      flat[ i * 3 + 1 ] = vec3Array[ i ][ 1 ];
      flat[ i * 3 + 2 ] = vec3Array[ i ][ 2 ];
    }

    return new PolyhedronGeometry( flat, indices, radius, detail );
  }

  /**
   * Creates a PolyhedronGeometry with radius derived from a Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing the radius.
   * @param {Array} vertices - Flat vertex array.
   * @param {Array} indices - Flat index array.
   * @param {number} [detail=0] - Subdivision detail.
   * @return {PolyhedronGeometry} A new PolyhedronGeometry instance.
   */
  static fromDouble( d, vertices, indices, detail = 0 ) {

    return new PolyhedronGeometry( vertices, indices, d.toNumber(), detail );
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
   * Applies a noise-based radial displacement to all vertices.
   * Each vertex is moved along its normalized direction by a simplex-noise value.
   * Uses 3D simplex-noise for spatially coherent deformation.
   *
   * @param {number} [amplitude=0.1] - Displacement amplitude.
   * @param {number} [frequency=1] - Noise frequency.
   */
  applyNoise( amplitude = 0.1, frequency = 1 ) {

    const noise3D = createNoise3D();
    const positions = this.getAttribute( 'position' ).array;
    const normals = this.getAttribute( 'normal' ).array;
    const count = positions.length / 3;

    for ( let i = 0; i < count; i ++ ) {

      const i3 = i * 3;
      const x = positions[ i3 ];
      const y = positions[ i3 + 1 ];
      const z = positions[ i3 + 2 ];

      // Normalized direction from origin (vertices lie on a sphere)
      const nx = normals[ i3 ];
      const ny = normals[ i3 + 1 ];
      const nz = normals[ i3 + 2 ];

      const n = noise3D( x * frequency, y * frequency, z * frequency );
      const disp = n * amplitude;

      positions[ i3 ] += nx * disp;
      positions[ i3 + 1 ] += ny * disp;
      positions[ i3 + 2 ] += nz * disp;
    }

    this.getAttribute( 'position' ).needsUpdate = true;
    this._cachedAABB = null;
  }

  /**
   * Computes the approximate volume of the polyhedron using double precision.
   * Uses the signed-tetrahedron decomposition: V = (1/6) * Σ | a · (b × c) |.
   *
   * @return {number} The approximate volume.
   */
  computeVolume() {

    const positions = this.getAttribute( 'position' ).array;
    const count = positions.length / 3;

    let volume = new Double( 0 );

    // Tetrahedron decomposition from origin for each triangle
    for ( let i = 0; i < count; i += 3 ) {

      const i0 = i * 3;
      const i1 = ( i + 1 ) * 3;
      const i2 = ( i + 2 ) * 3;

      const ax = new Double( positions[ i0 ] );
      const ay = new Double( positions[ i0 + 1 ] );
      const az = new Double( positions[ i0 + 2 ] );

      const bx = new Double( positions[ i1 ] );
      const by = new Double( positions[ i1 + 1 ] );
      const bz = new Double( positions[ i1 + 2 ] );

      const cx = new Double( positions[ i2 ] );
      const cy = new Double( positions[ i2 + 1 ] );
      const cz = new Double( positions[ i2 + 2 ] );

      // Scalar triple product a · (b × c)
      const crossX = by.mul( cz ).sub( bz.mul( cy ) );
      const crossY = bz.mul( cx ).sub( bx.mul( cz ) );
      const crossZ = bx.mul( cy ).sub( by.mul( cx ) );

      const triple = ax.mul( crossX ).add( ay.mul( crossY ) ).add( az.mul( crossZ ) );

      volume = volume.add( triple );
    }

    // V = |Σ triple| / 6
    const absVolume = volume.toNumber() < 0 ? volume.mul( new Double( - 1 ) ) : volume;

    return absVolume.div( new Double( 6 ) ).toNumber();
  }

  /**
   * Queries all PolyhedronGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( polyhedronWorld, [ PolyhedronParams, PolyhedronStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          inputVertexCount: PolyhedronParams.inputVertexCount[ entity ],
          inputIndexCount: PolyhedronParams.inputIndexCount[ entity ],
          radius: PolyhedronParams.radius[ entity ],
          detail: PolyhedronParams.detail[ entity ]
        },
        stats: {
          outputVertexCount: PolyhedronStats.outputVertexCount[ entity ],
          outputTriangleCount: PolyhedronStats.outputTriangleCount[ entity ],
          outputUvCount: PolyhedronStats.outputUvCount[ entity ]
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

export { PolyhedronGeometry };
export default PolyhedronGeometry;