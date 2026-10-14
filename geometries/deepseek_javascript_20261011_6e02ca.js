// file number : 009
// full path name : src/geometries/009_PlaneGeometry.js
// description : PlaneGeometry — creates a flat rectangular plane subdivided into
//               widthSegments × heightSegments quads. The plane lies in the XY
//               plane facing +Z, centred on the origin. Pre-allocates typed arrays,
//               registers ECS entities via bitecs, caches gl-matrix AABB, supports
//               double-precision area computation, and simplex-noise procedural
//               deformation. Provides fromVec3 / fromDouble interop factories.
// license : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { Vector3 } from '../math/003_Vector3.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const planeWorld = createWorld();

// ─── Component definitions for plane tracking ───────────────────────────────
const PlaneParams = defineComponent({
  width: Types.f32,
  height: Types.f32,
  widthSegments: Types.ui16,
  heightSegments: Types.ui16
});

const PlaneStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32
});

/**
 * A geometry class for representing a plane.
 *
 * ```js
 * const geometry = new THREE.PlaneGeometry( 1, 1 );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00, side: THREE.DoubleSide } );
 * const plane = new THREE.Mesh( geometry, material );
 * scene.add( plane );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#PlaneGeometry
 */
class PlaneGeometry extends BufferGeometry {

  /**
   * Constructs a new plane geometry.
   *
   * @param {number} [width=1] - The width along the X axis.
   * @param {number} [height=1] - The height along the Y axis
   * @param {number} [widthSegments=1] - The number of segments along the X axis.
   * @param {number} [heightSegments=1] - The number of segments along the Y axis.
   */
  constructor( width = 1, height = 1, widthSegments = 1, heightSegments = 1 ) {

    super();

    this.type = 'PlaneGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      width: width,
      height: height,
      widthSegments: widthSegments,
      heightSegments: heightSegments
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    // ─── Integer enforcement ───────────────────────────────────────────────
    const gridX = Math.floor( widthSegments );
    const gridY = Math.floor( heightSegments );

    const gridX1 = gridX + 1;
    const gridY1 = gridY + 1;

    // ─── ECS: register plane entity ────────────────────────────────────────
    const entityId = addEntity( planeWorld );

    addComponent( planeWorld, PlaneParams, {
      width: width,
      height: height,
      widthSegments: gridX,
      heightSegments: gridY
    }, entityId );

    // ─── Pre-allocated typed arrays for maximum throughput ─────────────────
    const vertexCount = gridX1 * gridY1;
    const indexCount = gridX * gridY * 6;

    const indices = new ( vertexCount > 65535 ? Uint32Array : Uint16Array )( indexCount );
    const vertices = new Float32Array( vertexCount * 3 );
    const normals = new Float32Array( vertexCount * 3 );
    const uvs = new Float32Array( vertexCount * 2 );

    // ─── Write cursors ─────────────────────────────────────────────────────
    let vWrite = 0;
    let uvWrite = 0;
    let iWrite = 0;

    // ─── Geometry constants ────────────────────────────────────────────────
    const width_half = width / 2;
    const height_half = height / 2;
    const segment_width = width / gridX;
    const segment_height = height / gridY;

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for area ─────────────────────────────
    let totalArea = new Double( 0 );

    // ─── Noise instance for optional displacement ──────────────────────────
    const _noise2D = createNoise2D();

    // ─── Generate vertices, normals, and UVs ───────────────────────────────
    for ( let iy = 0; iy < gridY1; iy ++ ) {

      const y = iy * segment_height - height_half;

      for ( let ix = 0; ix < gridX1; ix ++ ) {

        const x = ix * segment_width - width_half;

        // ─── Position ────────────────────────────────────────────────────
        vertices[ vWrite ++ ] = x;
        vertices[ vWrite ++ ] = - y;
        vertices[ vWrite ++ ] = 0;

        // ─── Normal (+Z) ─────────────────────────────────────────────────
        normals[ vWrite - 3 ] = 0;
        normals[ vWrite - 2 ] = 0;
        normals[ vWrite - 1 ] = 1;

        // ─── UV ──────────────────────────────────────────────────────────
        uvs[ uvWrite ++ ] = ix / gridX;
        uvs[ uvWrite ++ ] = 1 - ( iy / gridY );
      }
    }

    // ─── Generate indices ──────────────────────────────────────────────────
    for ( let iy = 0; iy < gridY; iy ++ ) {

      for ( let ix = 0; ix < gridX; ix ++ ) {

        const a = ix + gridX1 * iy;
        const b = ix + gridX1 * ( iy + 1 );
        const c = ( ix + 1 ) + gridX1 * ( iy + 1 );
        const d = ( ix + 1 ) + gridX1 * iy;

        indices[ iWrite ++ ] = a;
        indices[ iWrite ++ ] = b;
        indices[ iWrite ++ ] = d;

        indices[ iWrite ++ ] = b;
        indices[ iWrite ++ ] = c;
        indices[ iWrite ++ ] = d;

        // ─── Accumulate triangle area in double precision ────────────────
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

        totalArea = totalArea.add( crossLen.mul( new Double( 0.5 ) ) );
      }
    }

    // ─── Build geometry ────────────────────────────────────────────────────
    this.setIndex( indices );
    this.setAttribute( 'position', new Float32BufferAttribute( vertices.buffer, 3, 0, vWrite ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals.buffer, 3, 0, vWrite ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs.buffer, 2, 0, uvWrite ) );

    // ─── ECS: record plane statistics ──────────────────────────────────────
    addComponent( planeWorld, PlaneStats, {
      vertexCount: vertexCount,
      indexCount: indexCount,
      triangleCount: indexCount / 3
    }, entityId );

    this._planeEntityId = entityId;
    this._totalArea = totalArea.toNumber();
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {PlaneGeometry} A new instance.
   */
  static fromJSON( data ) {

    return new PlaneGeometry(
      data.width,
      data.height,
      data.widthSegments,
      data.heightSegments
    );
  }

  /**
   * Creates a PlaneGeometry from a gl-matrix vec3 size.
   * Uses x as width and y as height.
   *
   * @param {vec3} size - gl-matrix vec3 with width in x, height in y.
   * @param {number} [widthSegments=1] - Width segment count.
   * @param {number} [heightSegments=1] - Height segment count.
   * @return {PlaneGeometry} A new PlaneGeometry instance.
   */
  static fromVec3( size, widthSegments = 1, heightSegments = 1 ) {

    return new PlaneGeometry( size[ 0 ], size[ 1 ], widthSegments, heightSegments );
  }

  /**
   * Creates a PlaneGeometry with uniform dimensions derived from a
   * Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing both width and height.
   * @param {number} [widthSegments=1] - Width segment count.
   * @param {number} [heightSegments=1] - Height segment count.
   * @return {PlaneGeometry} A new PlaneGeometry instance.
   */
  static fromDouble( d, widthSegments = 1, heightSegments = 1 ) {

    const v = d.toNumber();

    return new PlaneGeometry( v, v, widthSegments, heightSegments );
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
   * Applies a noise-based displacement to all vertices along the +Z axis.
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

      const n = noise2D( x * frequency, y * frequency );
      const disp = n * amplitude;

      positions[ i3 ] += normals[ i3 ] * disp;
      positions[ i3 + 1 ] += normals[ i3 + 1 ] * disp;
      positions[ i3 + 2 ] += normals[ i3 + 2 ] * disp;
    }

    this.getAttribute( 'position' ).needsUpdate = true;
    this._cachedAABB = null;
  }

  /**
   * Returns the total surface area of the plane in double precision.
   * Uses the accumulated triangle cross-product magnitude during construction.
   *
   * @return {number} The approximate surface area.
   */
  getTotalArea() {

    return this._totalArea || 0;
  }

  /**
   * Computes the analytic area of the plane in double precision.
   * A = width * height
   *
   * @return {number} The analytic area.
   */
  computeAnalyticArea() {

    const { width, height } = this.parameters;

    return new Double( width ).mul( new Double( height ) ).toNumber();
  }

  /**
   * Queries all PlaneGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( planeWorld, [ PlaneParams, PlaneStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          width: PlaneParams.width[ entity ],
          height: PlaneParams.height[ entity ],
          widthSegments: PlaneParams.widthSegments[ entity ],
          heightSegments: PlaneParams.heightSegments[ entity ]
        },
        stats: {
          vertexCount: PlaneStats.vertexCount[ entity ],
          indexCount: PlaneStats.indexCount[ entity ],
          triangleCount: PlaneStats.triangleCount[ entity ]
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

export { PlaneGeometry };
export default PlaneGeometry;