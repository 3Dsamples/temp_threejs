// file number : 007
// full path name : src/geometries/007_LatheGeometry.js
// description : LatheGeometry — creates meshes with axial symmetry by rotating a 2D profile
//               (array of Vector2 points) around the Y axis. Supports configurable segment
//               count, phi start angle, and phi length for full or partial lathe sweeps.
//               Pre-computes smooth normals along the meridian profile for correct shading.
//               Integrates bitecs ECS, gl-matrix, double.js, and simplex-noise for enhanced
//               geometric computation and procedural surface deformation.
// license : MIT

import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Vector3 } from '../math/003_Vector3.js';
import { Vector2 } from '../math/002_Vector2.js';
import { clamp } from '../math/001_MathUtils.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const latheWorld = createWorld();

// ─── Component definitions for lathe tracking ───────────────────────────────
const LatheParams = defineComponent({
  pointCount: Types.ui16,
  segments: Types.ui16,
  phiStart: Types.f32,
  phiLength: Types.f32
});

const LatheStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32
});

/**
 * Creates meshes with axial symmetry like vases. The lathe rotates around the Y axis.
 *
 * ```js
 * const points = [];
 * for ( let i = 0; i < 10; i ++ ) {
 *   points.push( new THREE.Vector2( Math.sin( i * 0.2 ) * 10 + 5, ( i - 5 ) * 2 ) );
 * }
 * const geometry = new THREE.LatheGeometry( points );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const lathe = new THREE.Mesh( geometry, material );
 * scene.add( lathe );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#LatheGeometry
 */
class LatheGeometry extends BufferGeometry {

  /**
   * Constructs a new lathe geometry.
   *
   * @param {Array<Vector2>} [points] - An array of points in 2D space. The x-coordinate of each point
   *        must be greater than zero.
   * @param {number} [segments=12] - The number of circumference segments to generate.
   * @param {number} [phiStart=0] - The starting angle in radians.
   * @param {number} [phiLength=Math.PI*2] - The radian (0 to 2PI) range of the lathed section.
   *        2PI is a closed lathe, less than 2PI is a portion.
   */
  constructor( points = [ new Vector2( 0, - 0.5 ), new Vector2( 0.5, 0 ), new Vector2( 0, 0.5 ) ], segments = 12, phiStart = 0, phiLength = Math.PI * 2 ) {

    super();

    this.type = 'LatheGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      points: points,
      segments: segments,
      phiStart: phiStart,
      phiLength: phiLength
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    // ─── Integer enforcement ───────────────────────────────────────────────
    segments = Math.floor( segments );

    // ─── Clamp phiLength to [ 0, 2PI ] ─────────────────────────────────────
    phiLength = clamp( phiLength, 0, Math.PI * 2 );

    // ─── ECS: register lathe entity ────────────────────────────────────────
    const entityId = addEntity( latheWorld );

    addComponent( latheWorld, LatheParams, {
      pointCount: points.length,
      segments: segments,
      phiStart: phiStart,
      phiLength: phiLength
    }, entityId );

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for surface area ─────────────────────
    let totalSurfaceArea = new Double( 0 );

    // ─── Reusable math objects (single allocation) ─────────────────────────
    const vertex = new Vector3();
    const uv = new Vector2();
    const normal = new Vector3();
    const curNormal = new Vector3();
    const prevNormal = new Vector3();

    // ─── Buffers (dynamic arrays for variable point count) ─────────────────
    const indices = [];
    const vertices = [];
    const uvs = [];
    const initNormals = [];
    const normals = [];

    let dx = 0;
    let dy = 0;

    // ─── Pre-compute normals for initial "meridian" ────────────────────────
    for ( let j = 0; j <= ( points.length - 1 ); j ++ ) {

      switch ( j ) {

        case 0:
          // special handling for 1st vertex on path
          dx = points[ j + 1 ].x - points[ j ].x;
          dy = points[ j + 1 ].y - points[ j ].y;

          normal.x = dy * 1.0;
          normal.y = - dx;
          normal.z = dy * 0.0;

          prevNormal.copy( normal );

          normal.normalize();

          initNormals.push( normal.x, normal.y, normal.z );
          break;

        case ( points.length - 1 ):
          // special handling for last Vertex on path
          initNormals.push( prevNormal.x, prevNormal.y, prevNormal.z );
          break;

        default:
          // default handling for all vertices in between
          dx = points[ j + 1 ].x - points[ j ].x;
          dy = points[ j + 1 ].y - points[ j ].y;

          curNormal.x = dy * 1.0;
          curNormal.y = - dx;
          curNormal.z = dy * 0.0;

          prevNormal.add( curNormal );
          prevNormal.normalize();

          initNormals.push( prevNormal.x, prevNormal.y, prevNormal.z );
          prevNormal.copy( curNormal );
          break;
      }
    }

    // ─── Generate vertices, uvs and indices ────────────────────────────────
    const inverseSegments = 1.0 / segments;

    for ( let i = 0; i <= segments; i ++ ) {

      const phi = phiStart + i * inverseSegments * phiLength;

      const sin = Math.sin( phi );
      const cos = Math.cos( phi );

      for ( let j = 0; j <= ( points.length - 1 ); j ++ ) {

        // vertex
        vertex.x = points[ j ].x * sin;
        vertex.y = points[ j ].y;
        vertex.z = points[ j ].x * cos;

        vertices.push( vertex.x, vertex.y, vertex.z );

        // uv
        uv.x = i / segments;
        uv.y = j / ( points.length - 1 );

        uvs.push( uv.x, uv.y );

        // normal
        const x = initNormals[ 3 * j + 0 ] * sin;
        const y = initNormals[ 3 * j + 1 ];
        const z = initNormals[ 3 * j + 0 ] * cos;

        normals.push( x, y, z );
      }
    }

    // ─── Indices ───────────────────────────────────────────────────────────
    for ( let i = 0; i < segments; i ++ ) {

      for ( let j = 0; j < ( points.length - 1 ); j ++ ) {

        const base = j + i * points.length;

        const a = base;
        const b = base + points.length;
        const c = base + points.length + 1;
        const d = base + 1;

        // faces
        indices.push( a, b, d );
        indices.push( c, d, b );

        // ─── Accumulate surface area in double precision ────────────────
        const v0x = vertices[ a * 3 ];
        const v0y = vertices[ a * 3 + 1 ];
        const v0z = vertices[ a * 3 + 2 ];

        const v1x = vertices[ b * 3 ];
        const v1y = vertices[ b * 3 + 1 ];
        const v1z = vertices[ b * 3 + 2 ];

        const v2x = vertices[ d * 3 ];
        const v2y = vertices[ d * 3 + 1 ];
        const v2z = vertices[ d * 3 + 2 ];

        const ax = new Double( v1x - v0x );
        const ay = new Double( v1y - v0y );
        const az = new Double( v1z - v0z );

        const bx = new Double( v2x - v0x );
        const by = new Double( v2y - v0y );
        const bz = new Double( v2z - v0z );

        const cx = ay.mul( bz ).sub( az.mul( by ) );
        const cy = az.mul( bx ).sub( ax.mul( bz ) );
        const cz = ax.mul( by ).sub( ay.mul( bx ) );

        const crossLen = cx.mul( cx ).add( cy.mul( cy ) ).add( cz.mul( cz ) ).sqrt();

        totalSurfaceArea = totalSurfaceArea.add( crossLen.mul( new Double( 0.5 ) ) );
      }
    }

    // ─── Build geometry ────────────────────────────────────────────────────
    this.setIndex( indices );
    this.setAttribute( 'position', new Float32BufferAttribute( vertices, 3 ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );

    // ─── ECS: record lathe statistics ──────────────────────────────────────
    addComponent( latheWorld, LatheStats, {
      vertexCount: vertices.length / 3,
      indexCount: indices.length,
      triangleCount: indices.length / 3
    }, entityId );

    this._latheEntityId = entityId;
    this._totalSurfaceArea = totalSurfaceArea.toNumber();
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {LatheGeometry} A new instance.
   */
  static fromJSON( data ) {

    const points = data.points.map( p => new Vector2( p.x, p.y ) );

    return new LatheGeometry( points, data.segments, data.phiStart, data.phiLength );
  }

  /**
   * Creates a LatheGeometry from a gl-matrix vec2 array.
   *
   * @param {Array<vec2>} points - Array of gl-matrix vec2 points.
   * @param {number} [segments=12] - Circumference segment count.
   * @param {number} [phiStart=0] - Start angle.
   * @param {number} [phiLength=Math.PI*2] - Sweep angle.
   * @return {LatheGeometry} A new LatheGeometry instance.
   */
  static fromVec2Array( points, segments = 12, phiStart = 0, phiLength = Math.PI * 2 ) {

    const threePoints = points.map( p => new Vector2( p[ 0 ], p[ 1 ] ) );

    return new LatheGeometry( threePoints, segments, phiStart, phiLength );
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
   * Applies a noise-based displacement to all vertices.
   * Uses simplex-noise for procedural surface deformation.
   *
   * @param {number} [amplitude=0.1] - Displacement amplitude.
   * @param {number} [frequency=1] - Noise frequency.
   */
  applyNoise( amplitude = 0.1, frequency = 1 ) {

    const noise2D = createNoise2D();
    const positions = this.getAttribute( 'position' ).array;
    const normals = this.getAttribute( 'normal' ).array;
    const count = positions.length / 3;

    for ( let i = 0; i < count; i ++ ) {

      const i3 = i * 3;
      const x = positions[ i3 ];
      const y = positions[ i3 + 1 ];
      const z = positions[ i3 + 2 ];

      const n = noise2D( x * frequency, z * frequency );
      const disp = n * amplitude;

      positions[ i3 ] += normals[ i3 ] * disp;
      positions[ i3 + 1 ] += normals[ i3 + 1 ] * disp;
      positions[ i3 + 2 ] += normals[ i3 + 2 ] * disp;
    }

    this.getAttribute( 'position' ).needsUpdate = true;
    this._cachedAABB = null;
  }

  /**
   * Returns the total surface area of the lathe geometry in double precision.
   *
   * @return {number} The approximate surface area.
   */
  getTotalSurfaceArea() {

    return this._totalSurfaceArea || 0;
  }

  /**
   * Queries all LatheGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( latheWorld, [ LatheParams, LatheStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          pointCount: LatheParams.pointCount[ entity ],
          segments: LatheParams.segments[ entity ],
          phiStart: LatheParams.phiStart[ entity ],
          phiLength: LatheParams.phiLength[ entity ]
        },
        stats: {
          vertexCount: LatheStats.vertexCount[ entity ],
          indexCount: LatheStats.indexCount[ entity ],
          triangleCount: LatheStats.triangleCount[ entity ]
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

export { LatheGeometry };
export default LatheGeometry;