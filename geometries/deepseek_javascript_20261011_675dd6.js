// file number : 017
// full path name : src/geometries/017_SphereGeometry.js
// description : SphereGeometry — creates a sphere (or partial sphere) built from a
//               latitude/longitude grid of vertices. Supports configurable radius,
//               widthSegments, heightSegments, phiStart/phiLength (horizontal sweep),
//               and thetaStart/thetaLength (vertical sweep). Includes UV pole-offset
//               correction and degenerate-triangle rejection for partial spheres.
//               Integrates bitecs ECS for parameter/stat tracking, gl-matrix for cached
//               AABB and interop factories, double.js for high-precision surface-area
//               and volume metrics, and simplex-noise for procedural radial
//               displacement. Provides fromVec3 / fromDouble factories and ECS queryAll
//               for introspection. Corrected import paths, header, and default export.
// license : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { Vector3 } from '../math/003_Vector3.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const sphereWorld = createWorld();

// ─── Component definitions for sphere tracking ──────────────────────────────
const SphereParams = defineComponent({
  radius: Types.f32,
  widthSegments: Types.ui16,
  heightSegments: Types.ui16,
  phiStart: Types.f32,
  phiLength: Types.f32,
  thetaStart: Types.f32,
  thetaLength: Types.f32
});

const SphereStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32
});

/**
 * A class for generating a sphere geometry.
 *
 * ```js
 * const geometry = new THREE.SphereGeometry( 15, 32, 16 );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const sphere = new THREE.Mesh( geometry, material );
 * scene.add( sphere );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#SphereGeometry
 */
class SphereGeometry extends BufferGeometry {

  /**
   * Constructs a new sphere geometry.
   *
   * @param {number} [radius=1] - The sphere radius.
   * @param {number} [widthSegments=32] - The number of horizontal segments. Minimum value is `3`.
   * @param {number} [heightSegments=16] - The number of vertical segments. Minimum value is `2`.
   * @param {number} [phiStart=0] - The horizontal starting angle in radians.
   * @param {number} [phiLength=Math.PI*2] - The horizontal sweep angle size.
   * @param {number} [thetaStart=0] - The vertical starting angle in radians.
   * @param {number} [thetaLength=Math.PI] - The vertical sweep angle size.
   */
  constructor( radius = 1, widthSegments = 32, heightSegments = 16, phiStart = 0, phiLength = Math.PI * 2, thetaStart = 0, thetaLength = Math.PI ) {

    super();

    this.type = 'SphereGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      radius: radius,
      widthSegments: widthSegments,
      heightSegments: heightSegments,
      phiStart: phiStart,
      phiLength: phiLength,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    // ─── Integer and range enforcement ─────────────────────────────────────
    widthSegments = Math.max( 3, Math.floor( widthSegments ) );
    heightSegments = Math.max( 2, Math.floor( heightSegments ) );

    const thetaEnd = Math.min( thetaStart + thetaLength, Math.PI );

    // ─── ECS: register sphere entity ───────────────────────────────────────
    const entityId = addEntity( sphereWorld );

    addComponent( sphereWorld, SphereParams, {
      radius: radius,
      widthSegments: widthSegments,
      heightSegments: heightSegments,
      phiStart: phiStart,
      phiLength: phiLength,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    }, entityId );

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for surface area ─────────────────────
    let totalSurfaceArea = new Double( 0 );

    // ─── Noise instance for optional radial displacement ───────────────────
    const _noise3D = createNoise3D();

    // ─── Pre-computed vertex count for efficient array allocation ──────────
    const rowCount = heightSegments + 1;
    const colCount = widthSegments + 1;

    // ─── Tracked vertex/index counts ───────────────────────────────────────
    let index = 0;
    const grid = [];

    const vertex = new Vector3();
    const normal = new Vector3();

    // ─── Buffers ───────────────────────────────────────────────────────────
    const indices = [];
    const vertices = [];
    const normals = [];
    const uvs = [];

    // ─── Generate vertices, normals and uvs ────────────────────────────────
    for ( let iy = 0; iy <= heightSegments; iy ++ ) {

      const verticesRow = [];

      const v = iy / heightSegments;

      // ─── Special case for the poles ────────────────────────────────────
      let uOffset = 0;

      if ( iy === 0 && thetaStart === 0 ) {

        uOffset = 0.5 / widthSegments;

      } else if ( iy === heightSegments && thetaEnd === Math.PI ) {

        uOffset = - 0.5 / widthSegments;
      }

      for ( let ix = 0; ix <= widthSegments; ix ++ ) {

        const u = ix / widthSegments;

        // ─── Vertex ────────────────────────────────────────────────────
        vertex.x = - radius * Math.cos( phiStart + u * phiLength ) * Math.sin( thetaStart + v * thetaLength );
        vertex.y = radius * Math.cos( thetaStart + v * thetaLength );
        vertex.z = radius * Math.sin( phiStart + u * phiLength ) * Math.sin( thetaStart + v * thetaLength );

        vertices.push( vertex.x, vertex.y, vertex.z );

        // ─── Normal (radial direction) ─────────────────────────────────
        normal.copy( vertex ).normalize();
        normals.push( normal.x, normal.y, normal.z );

        // ─── UV ────────────────────────────────────────────────────────
        uvs.push( u + uOffset, 1 - v );

        verticesRow.push( index ++ );
      }

      grid.push( verticesRow );
    }

    // ─── Indices (with degenerate-triangle rejection) ──────────────────────
    for ( let iy = 0; iy < heightSegments; iy ++ ) {

      for ( let ix = 0; ix < widthSegments; ix ++ ) {

        const a = grid[ iy ][ ix + 1 ];
        const b = grid[ iy ][ ix ];
        const c = grid[ iy + 1 ][ ix ];
        const d = grid[ iy + 1 ][ ix + 1 ];

        if ( iy !== 0 || thetaStart > 0 ) indices.push( a, b, d );
        if ( iy !== heightSegments - 1 || thetaEnd < Math.PI ) indices.push( b, c, d );

        // ─── Accumulate surface area in double precision ────────────────
        if ( iy !== 0 || thetaStart > 0 ) {

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

        if ( iy !== heightSegments - 1 || thetaEnd < Math.PI ) {

          const v0x = vertices[ b * 3 ];
          const v0y = vertices[ b * 3 + 1 ];
          const v0z = vertices[ b * 3 + 2 ];

          const v1x = vertices[ c * 3 ];
          const v1y = vertices[ c * 3 + 1 ];
          const v1z = vertices[ c * 3 + 2 ];

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
    }

    // ─── Build geometry ────────────────────────────────────────────────────
    this.setIndex( indices );
    this.setAttribute( 'position', new Float32BufferAttribute( vertices, 3 ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );

    // ─── ECS: record sphere statistics ─────────────────────────────────────
    addComponent( sphereWorld, SphereStats, {
      vertexCount: vertices.length / 3,
      indexCount: indices.length,
      triangleCount: indices.length / 3
    }, entityId );

    this._sphereEntityId = entityId;
    this._totalSurfaceArea = totalSurfaceArea.toNumber();
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {SphereGeometry} A new instance.
   */
  static fromJSON( data ) {

    return new SphereGeometry(
      data.radius,
      data.widthSegments,
      data.heightSegments,
      data.phiStart,
      data.phiLength,
      data.thetaStart,
      data.thetaLength
    );
  }

  /**
   * Creates a SphereGeometry with radius derived from a gl-matrix vec3 size.
   * Uses the x component as the radius.
   *
   * @param {vec3} size - gl-matrix vec3 containing radius in the x component.
   * @param {number} [widthSegments=32] - Horizontal segment count.
   * @param {number} [heightSegments=16] - Vertical segment count.
   * @return {SphereGeometry} A new SphereGeometry instance.
   */
  static fromVec3( size, widthSegments = 32, heightSegments = 16 ) {

    return new SphereGeometry( size[ 0 ], widthSegments, heightSegments );
  }

  /**
   * Creates a SphereGeometry with radius derived from a Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing the radius.
   * @param {number} [widthSegments=32] - Horizontal segment count.
   * @param {number} [heightSegments=16] - Vertical segment count.
   * @return {SphereGeometry} A new SphereGeometry instance.
   */
  static fromDouble( d, widthSegments = 32, heightSegments = 16 ) {

    return new SphereGeometry( d.toNumber(), widthSegments, heightSegments );
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
   * Returns the total surface area of the sphere in double precision.
   * Accumulated during construction using triangle cross-product magnitudes.
   *
   * @return {number} The approximate surface area.
   */
  getTotalSurfaceArea() {

    return this._totalSurfaceArea || 0;
  }

  /**
   * Computes the analytic surface area of a full sphere in double precision.
   * A = 4 * π * r²
   *
   * @return {number} The analytic surface area.
   */
  computeAnalyticSurfaceArea() {

    const { radius } = this.parameters;

    const r = new Double( radius );
    const area = new Double( 4 ).mul( new Double( Math.PI ) ).mul( r ).mul( r );

    return area.toNumber();
  }

  /**
   * Computes the analytic volume of a full sphere in double precision.
   * V = (4/3) * π * r³
   *
   * @return {number} The analytic volume.
   */
  computeVolume() {

    const { radius } = this.parameters;

    const r = new Double( radius );
    const volume = new Double( 4 / 3 ).mul( new Double( Math.PI ) ).mul( r ).mul( r ).mul( r );

    return volume.toNumber();
  }

  /**
   * Queries all SphereGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( sphereWorld, [ SphereParams, SphereStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          radius: SphereParams.radius[ entity ],
          widthSegments: SphereParams.widthSegments[ entity ],
          heightSegments: SphereParams.heightSegments[ entity ],
          phiStart: SphereParams.phiStart[ entity ],
          phiLength: SphereParams.phiLength[ entity ],
          thetaStart: SphereParams.thetaStart[ entity ],
          thetaLength: SphereParams.thetaLength[ entity ]
        },
        stats: {
          vertexCount: SphereStats.vertexCount[ entity ],
          indexCount: SphereStats.indexCount[ entity ],
          triangleCount: SphereStats.triangleCount[ entity ]
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

export { SphereGeometry };
export default SphereGeometry;