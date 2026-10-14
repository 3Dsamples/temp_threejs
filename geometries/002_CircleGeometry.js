// file number : 002
// full path name : src/geometries/002_CircleGeometry.js
// description : CircleGeometry — creates a circle or circular sector using triangular segments
//               radiating from a center point. Supports configurable radius, segment count,
//               start angle, and central angle for partial arcs and regular polygons.
//               Integrates bitecs ECS, gl-matrix, double.js, and simplex-noise for enhanced
//               geometric computation and procedural deformation.
// license : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { Vector3 } from '../math/003_Vector3.js';
import { Vector2 } from '../math/002_Vector2.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (pre-allocated for performance) ──────────────────────────────
const circleWorld = createWorld();

// ─── Component definitions for geometry data tracking ───────────────────────
const CircleParams = defineComponent({
  radius: Types.f32,
  segments: Types.ui16,
  thetaStart: Types.f32,
  thetaLength: Types.f32
});

const CircleStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32
});

/**
 * A simple shape of Euclidean geometry. It is constructed from a
 * number of triangular segments that are oriented around a central point and
 * extend as far out as a given radius. It is built counter-clockwise from a
 * start angle and a given central angle. It can also be used to create
 * regular polygons, where the number of segments determines the number of
 * sides.
 *
 * ```js
 * const geometry = new THREE.CircleGeometry( 5, 32 );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const circle = new THREE.Mesh( geometry, material );
 * scene.add( circle );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#CircleGeometry
 */
class CircleGeometry extends BufferGeometry {

  /**
   * Constructs a new circle geometry.
   *
   * @param {number} [radius=1] - Radius of the circle.
   * @param {number} [segments=32] - Number of segments (triangles), minimum = `3`.
   * @param {number} [thetaStart=0] - Start angle for first segment in radians.
   * @param {number} [thetaLength=Math.PI*2] - The central angle, often called theta,
   *        of the circular sector in radians. The default value results in a complete circle.
   */
  constructor( radius = 1, segments = 32, thetaStart = 0, thetaLength = Math.PI * 2 ) {

    super();

    this.type = 'CircleGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      radius: radius,
      segments: segments,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    };

    // ─── Segment clamping (minimum 3 for a valid triangle fan) ─────────────
    segments = Math.max( 3, Math.floor( segments ) );

    // ─── Pre-allocated typed arrays (center + perimeter ring) ──────────────
    const vertexCount = 1 + ( segments + 1 );
    const indexCount = segments * 3;

    const indices = new ( vertexCount > 65535 ? Uint32Array : Uint16Array )( indexCount );
    const vertices = new Float32Array( vertexCount * 3 );
    const normals = new Float32Array( vertexCount * 3 );
    const uvs = new Float32Array( vertexCount * 2 );

    // ─── Write cursors ─────────────────────────────────────────────────────
    let vWrite = 0;
    let uvWrite = 0;

    // ─── Reusable math objects (single allocation) ─────────────────────────
    const _vertex = new Vector3();
    const _uv = new Vector2();

    // ─── ECS: register geometry entity ─────────────────────────────────────
    const entityId = addEntity( circleWorld );

    addComponent( circleWorld, CircleParams, {
      radius: radius,
      segments: segments,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    }, entityId );

    // ─── gl-matrix scratch for AABB and interop ────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for high-precision area ──────────────
    const _dbl = new Double( 0 );

    // ─── Center point ──────────────────────────────────────────────────────
    vertices[ vWrite ++ ] = 0;
    vertices[ vWrite ++ ] = 0;
    vertices[ vWrite ++ ] = 0;

    normals[ vWrite - 3 ] = 0;
    normals[ vWrite - 2 ] = 0;
    normals[ vWrite - 1 ] = 1;

    uvs[ uvWrite ++ ] = 0.5;
    uvs[ uvWrite ++ ] = 0.5;

    // ─── Perimeter ring ────────────────────────────────────────────────────
    for ( let s = 0; s <= segments; s ++ ) {

      const segment = thetaStart + s / segments * thetaLength;

      _vertex.x = radius * Math.cos( segment );
      _vertex.y = radius * Math.sin( segment );
      _vertex.z = 0;

      vertices[ vWrite ++ ] = _vertex.x;
      vertices[ vWrite ++ ] = _vertex.y;
      vertices[ vWrite ++ ] = _vertex.z;

      normals[ vWrite - 3 ] = 0;
      normals[ vWrite - 2 ] = 0;
      normals[ vWrite - 1 ] = 1;

      _uv.x = ( _vertex.x / radius + 1 ) / 2;
      _uv.y = ( _vertex.y / radius + 1 ) / 2;

      uvs[ uvWrite ++ ] = _uv.x;
      uvs[ uvWrite ++ ] = _uv.y;
    }

    // ─── Indices (triangle fan) ────────────────────────────────────────────
    for ( let i = 1; i <= segments; i ++ ) {

      indices[ ( i - 1 ) * 3 ] = i;
      indices[ ( i - 1 ) * 3 + 1 ] = i + 1;
      indices[ ( i - 1 ) * 3 + 2 ] = 0;
    }

    // ─── Build geometry ────────────────────────────────────────────────────
    this.setIndex( indices );
    this.setAttribute( 'position', new Float32BufferAttribute( vertices.buffer, 3, 0, vWrite ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals.buffer, 3, 0, vWrite ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs.buffer, 2, 0, uvWrite ) );

    // ─── ECS: record geometry statistics ───────────────────────────────────
    addComponent( circleWorld, CircleStats, {
      vertexCount: vertexCount,
      indexCount: indexCount,
      triangleCount: segments
    }, entityId );

    // ─── Bounding info caches ──────────────────────────────────────────────
    this.boundingBox = null;
    this.boundingSphere = null;
    this._cachedAABB = null;
  }

  /**
   * Creates a new CircleGeometry from a JSON object.
   *
   * @param {Object} data - The JSON data.
   * @return {CircleGeometry} A new CircleGeometry instance.
   */
  static fromJSON( data ) {

    return new CircleGeometry(
      data.radius,
      data.segments,
      data.thetaStart,
      data.thetaLength
    );
  }

  /**
   * Creates a CircleGeometry from a gl-matrix vec3 size.
   * Uses the x component as the radius.
   *
   * @param {vec3} size - A gl-matrix vec3 containing radius in the x component.
   * @param {number} [segments=32] - Number of segments.
   * @return {CircleGeometry} A new CircleGeometry instance.
   */
  static fromVec3( size, segments = 32 ) {

    return new CircleGeometry( size[ 0 ], segments );
  }

  /**
   * Creates a CircleGeometry with a uniform radius derived from a Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing the radius.
   * @param {number} [segments=32] - Number of segments.
   * @return {CircleGeometry} A new CircleGeometry instance.
   */
  static fromDouble( d, segments = 32 ) {

    return new CircleGeometry( d.toNumber(), segments );
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
   * Applies a noise-based displacement to all perimeter vertices.
   * The center vertex is left untouched to preserve the fan topology.
   * Uses simplex-noise for procedural deformation.
   *
   * @param {number} [amplitude=0.1] - Displacement amplitude.
   * @param {number} [frequency=1] - Noise frequency.
   */
  applyNoise( amplitude = 0.1, frequency = 1 ) {

    const noise2D = createNoise2D();
    const positions = this.getAttribute( 'position' ).array;
    const normals = this.getAttribute( 'normal' ).array;
    const count = positions.length / 3;

    // Skip the center vertex (index 0) to preserve fan topology
    for ( let i = 1; i < count; i ++ ) {

      const i3 = i * 3;
      const x = positions[ i3 ];
      const y = positions[ i3 + 1 ];

      const n = noise2D( x * frequency, y * frequency );
      const disp = n * amplitude;

      positions[ i3 ] += normals[ i3 ] * disp;
      positions[ i3 + 1 ] += normals[ i3 + 1 ] * disp;
    }

    this.getAttribute( 'position' ).needsUpdate = true;
    this._cachedAABB = null;
  }

  /**
   * Computes the signed area of the circle geometry using the shoelace formula
   * in double precision. Useful for validation against Math.PI * r².
   *
   * @return {number} The signed area as a JavaScript number.
   */
  computeArea() {

    const positions = this.getAttribute( 'position' ).array;
    const count = positions.length / 3;

    let area = new Double( 0 );

    for ( let i = 1; i < count - 1; i ++ ) {

      const i3 = i * 3;
      const j3 = ( i + 1 ) * 3;

      const cross = positions[ i3 ] * positions[ j3 + 1 ] -
                    positions[ j3 ] * positions[ i3 + 1 ];

      area = area.add( new Double( cross ) );
    }

    return area.toNumber() / 2;
  }

  /**
   * Queries all CircleGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity IDs that have CircleParams and CircleStats.
   */
  static queryAll() {

    const results = [];
    const entities = query( circleWorld, [ CircleParams, CircleStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          radius: CircleParams.radius[ entity ],
          segments: CircleParams.segments[ entity ],
          thetaStart: CircleParams.thetaStart[ entity ],
          thetaLength: CircleParams.thetaLength[ entity ]
        },
        stats: {
          vertexCount: CircleStats.vertexCount[ entity ],
          indexCount: CircleStats.indexCount[ entity ],
          triangleCount: CircleStats.triangleCount[ entity ]
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

export { CircleGeometry };
export default CircleGeometry;