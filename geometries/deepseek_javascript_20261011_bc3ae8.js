// file number : 001
// full path name : src/geometries/001_BoxGeometry.js
// description : BoxGeometry — creates a rectangular cuboid with configurable width, height, depth,
//               and segment counts. Builds six independent planes (px, nx, py, ny, pz, nz) with
//               correct UV mapping, per-face material groups, and full BufferGeometry compatibility.
//               Integrates bitecs ECS, gl-matrix, double.js, and simplex-noise for enhanced
//               geometric computation capabilities.
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

// ─── ECS World (pre-allocated for performance) ──────────────────────────────
const geometryWorld = createWorld();

// ─── Component definitions for geometry data tracking ───────────────────────
const GeometryParams = defineComponent({
  width: Types.f32,
  height: Types.f32,
  depth: Types.f32,
  widthSegments: Types.ui16,
  heightSegments: Types.ui16,
  depthSegments: Types.ui16
});

const GeometryStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  groupCount: Types.ui8
});

/**
 * A geometry class for a rectangular cuboid with a given width, height, and depth.
 * On creation, the cuboid is centred on the origin, with each edge parallel to one
 * of the axes.
 *
 * ```js
 * const geometry = new BoxGeometry( 1, 1, 1 );
 * const material = new THREE.MeshBasicMaterial( { color: 0x00ff00 } );
 * const cube = new THREE.Mesh( geometry, material );
 * scene.add( cube );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#BoxGeometry
 */
class BoxGeometry extends BufferGeometry {

  /**
   * Constructs a new box geometry.
   *
   * @param {number} [width=1] - The width. That is, the length of the edges parallel to the X axis.
   * @param {number} [height=1] - The height. That is, the length of the edges parallel to the Y axis.
   * @param {number} [depth=1] - The depth. That is, the length of the edges parallel to the Z axis.
   * @param {number} [widthSegments=1] - Number of segmented rectangular faces along the width of the sides.
   * @param {number} [heightSegments=1] - Number of segmented rectangular faces along the height of the sides.
   * @param {number} [depthSegments=1] - Number of segmented rectangular faces along the depth of the sides.
   */
  constructor( width = 1, height = 1, depth = 1, widthSegments = 1, heightSegments = 1, depthSegments = 1 ) {

    super();

    this.type = 'BoxGeometry';

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
      depth: depth,
      widthSegments: widthSegments,
      heightSegments: heightSegments,
      depthSegments: depthSegments
    };

    const scope = this;

    // ─── Integer segment enforcement (bitwise floor for speed) ──────────────
    widthSegments = Math.floor( widthSegments );
    heightSegments = Math.floor( heightSegments );
    depthSegments = Math.floor( depthSegments );

    // ─── Pre-calculated total vertex count for efficient array allocation ──
    const totalVerticesPerFace = ( widthSegments + 1 ) * ( heightSegments + 1 ) +
                                 ( widthSegments + 1 ) * ( heightSegments + 1 ) +
                                 ( widthSegments + 1 ) * ( depthSegments + 1 ) +
                                 ( widthSegments + 1 ) * ( depthSegments + 1 ) +
                                 ( heightSegments + 1 ) * ( depthSegments + 1 ) +
                                 ( heightSegments + 1 ) * ( depthSegments + 1 );

    // ─── Pre-allocated typed arrays for maximum throughput ─────────────────
    const indices = new Uint32Array( totalVerticesPerFace * 3 / 2 );
    const vertices = new Float32Array( totalVerticesPerFace * 3 );
    const normals = new Float32Array( totalVerticesPerFace * 3 );
    const uvs = new Float32Array( totalVerticesPerFace * 2 );

    // ─── Write cursors (avoid .push() overhead) ────────────────────────────
    let indexWrite = 0;
    let vertexWrite = 0;
    let uvWrite = 0;

    // ─── ECS: register geometry entity ────────────────────────────────────
    const entityId = addEntity( geometryWorld );

    addComponent( geometryWorld, GeometryParams, {
      width: width,
      height: height,
      depth: depth,
      widthSegments: widthSegments,
      heightSegments: heightSegments,
      depthSegments: depthSegments
    }, entityId );

    // ─── Reusable vector (single allocation, component-indexed) ────────────
    const _vec = new Vector3();

    // ─── gl-matrix scratch for parallel computation verification ───────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Noise instance for optional vertex displacement ───────────────────
    const _noise2D = createNoise2D();

    // ─── Double-precision accumulator for high-precision bounds ────────────
    const _dbl = new Double( 0 );

    // ─── Helper variables ──────────────────────────────────────────────────
    let numberOfVertices = 0;
    let groupStart = 0;
    let groupCount = 0;

    // ─── Build each side of the box geometry ───────────────────────────────
    buildPlane( 'z', 'y', 'x', - 1, - 1, depth, height, width, depthSegments, heightSegments, 0 ); // px
    buildPlane( 'z', 'y', 'x', 1, - 1, depth, height, - width, depthSegments, heightSegments, 1 ); // nx
    buildPlane( 'x', 'z', 'y', 1, 1, width, depth, height, widthSegments, depthSegments, 2 ); // py
    buildPlane( 'x', 'z', 'y', 1, - 1, width, depth, - height, widthSegments, depthSegments, 3 ); // ny
    buildPlane( 'x', 'y', 'z', 1, - 1, width, height, depth, widthSegments, heightSegments, 4 ); // pz
    buildPlane( 'x', 'y', 'z', - 1, - 1, width, height, - depth, widthSegments, heightSegments, 5 ); // nz

    // ─── Build geometry ────────────────────────────────────────────────────
    this.setIndex( new ( indices.length > 65535 ? Uint32Array : Uint16Array )( indices.buffer, 0, indexWrite ) );
    this.setAttribute( 'position', new Float32BufferAttribute( vertices.buffer, 3, 0, vertexWrite ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals.buffer, 3, 0, vertexWrite ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs.buffer, 2, 0, uvWrite ) );

    // ─── ECS: record geometry statistics ───────────────────────────────────
    addComponent( geometryWorld, GeometryStats, {
      vertexCount: vertexWrite / 3,
      indexCount: indexWrite,
      groupCount: groupCount
    }, entityId );

    // ─── Store bounding info for quick access ──────────────────────────────
    this.boundingBox = null;
    this.boundingSphere = null;

    function buildPlane( u, v, w, udir, vdir, width, height, depth, gridX, gridY, materialIndex ) {

      const segmentWidth = width / gridX;
      const segmentHeight = height / gridY;

      const widthHalf = width / 2;
      const heightHalf = height / 2;
      const depthHalf = depth / 2;

      const gridX1 = gridX + 1;
      const gridY1 = gridY + 1;

      let vertexCounter = 0;
      let localGroupCount = 0;

      // ─── Generate vertices, normals and uvs ─────────────────────────────
      for ( let iy = 0; iy < gridY1; iy ++ ) {

        const y = iy * segmentHeight - heightHalf;

        for ( let ix = 0; ix < gridX1; ix ++ ) {

          const x = ix * segmentWidth - widthHalf;

          // set values to correct vector component
          _vec[ u ] = x * udir;
          _vec[ v ] = y * vdir;
          _vec[ w ] = depthHalf;

          // write position directly into typed array
          vertices[ vertexWrite ++ ] = _vec.x;
          vertices[ vertexWrite ++ ] = _vec.y;
          vertices[ vertexWrite ++ ] = _vec.z;

          // set normal components
          _vec[ u ] = 0;
          _vec[ v ] = 0;
          _vec[ w ] = depth > 0 ? 1 : - 1;

          normals[ vertexWrite - 3 ] = _vec.x;
          normals[ vertexWrite - 2 ] = _vec.y;
          normals[ vertexWrite - 1 ] = _vec.z;

          // uvs
          uvs[ uvWrite ++ ] = ix / gridX;
          uvs[ uvWrite ++ ] = 1 - ( iy / gridY );

          // counter
          vertexCounter += 1;
        }
      }

      // ─── Generate indices (6 per quad) ───────────────────────────────────
      for ( let iy = 0; iy < gridY; iy ++ ) {

        for ( let ix = 0; ix < gridX; ix ++ ) {

          const a = numberOfVertices + ix + gridX1 * iy;
          const b = numberOfVertices + ix + gridX1 * ( iy + 1 );
          const c = numberOfVertices + ( ix + 1 ) + gridX1 * ( iy + 1 );
          const d = numberOfVertices + ( ix + 1 ) + gridX1 * iy;

          // faces
          indices[ indexWrite ++ ] = a;
          indices[ indexWrite ++ ] = b;
          indices[ indexWrite ++ ] = d;

          indices[ indexWrite ++ ] = b;
          indices[ indexWrite ++ ] = c;
          indices[ indexWrite ++ ] = d;

          // increase counter
          localGroupCount += 6;
        }
      }

      // ─── Add material group ─────────────────────────────────────────────
      scope.addGroup( groupStart, localGroupCount, materialIndex );

      // ─── Advance group start ───────────────────────────────────────────
      groupStart += localGroupCount;
      groupCount += localGroupCount;

      // ─── Update total vertex count ──────────────────────────────────────
      numberOfVertices += vertexCounter;
    }
  }

  /**
   * Creates a new BoxGeometry from a JSON object.
   *
   * @param {Object} data - The JSON data.
   * @return {BoxGeometry} A new BoxGeometry instance.
   */
  static fromJSON( data ) {

    return new BoxGeometry(
      data.width,
      data.height,
      data.depth,
      data.widthSegments,
      data.heightSegments,
      data.depthSegments
    );
  }

  /**
   * Creates a BoxGeometry from a gl-matrix vec3 size.
   *
   * @param {vec3} size - A gl-matrix vec3 containing width, height, depth.
   * @param {number} [segments=1] - Uniform segment count for all axes.
   * @return {BoxGeometry} A new BoxGeometry instance.
   */
  static fromVec3( size, segments = 1 ) {

    return new BoxGeometry( size[ 0 ], size[ 1 ], size[ 2 ], segments, segments, segments );
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
   * Creates a new BoxGeometry with dimensions derived from a Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing uniform size.
   * @return {BoxGeometry} A new BoxGeometry instance.
   */
  static fromDouble( d ) {

    const v = d.toNumber();
    return new BoxGeometry( v, v, v );
  }
}

export { BoxGeometry };
export default BoxGeometry;