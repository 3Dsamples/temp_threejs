// file number : 014
// full path name : src/geometries/014_TetrahedronGeometry.js
// description : TetrahedronGeometry — a regular tetrahedron (4 triangular faces) built
//               from four alternating cube vertices projected onto a sphere. Extends
//               PolyhedronGeometry for subdivision, UV generation, and normal computation.
//               Integrates bitecs ECS for parameter/stat tracking, gl-matrix for cached
//               AABB and interop factories, double.js for high-precision volume/area
//               metrics, and simplex-noise for procedural radial displacement.
//               Provides fromVec3 / fromDouble factories and ECS queryAll for introspection.
// license : MIT

import { PolyhedronGeometry } from './010_PolyhedronGeometry.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const tetrahedronWorld = createWorld();

// ─── Component definitions for tetrahedron tracking ─────────────────────────
const TetrahedronParams = defineComponent({
  radius: Types.f32,
  detail: Types.ui8
});

const TetrahedronStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32,
  faceCount: Types.ui8
});

/**
 * A geometry class for representing a tetrahedron.
 *
 * ```js
 * const geometry = new THREE.TetrahedronGeometry();
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const tetrahedron = new THREE.Mesh( geometry, material );
 * scene.add( tetrahedron );
 * ```
 *
 * @augments PolyhedronGeometry
 * @demo scenes/geometry-browser.html#TetrahedronGeometry
 */
class TetrahedronGeometry extends PolyhedronGeometry {

  /**
   * Constructs a new tetrahedron geometry.
   *
   * @param {number} [radius=1] - Radius of the tetrahedron.
   * @param {number} [detail=0] - Setting this to a value greater than `0` adds vertices
   *        making it no longer a tetrahedron.
   */
  constructor( radius = 1, detail = 0 ) {

    // ─── Alternating cube vertices (mirrors r185 source) ───────────────────
    const vertices = [
      1, 1, 1, 	- 1, - 1, 1, 	- 1, 1, - 1, 	1, - 1, - 1
    ];

    const indices = [
      2, 1, 0, 	0, 3, 2, 	1, 3, 0, 	2, 3, 1
    ];

    super( vertices, indices, radius, detail );

    this.type = 'TetrahedronGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      radius: radius,
      detail: detail
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    // ─── ECS: register tetrahedron entity ──────────────────────────────────
    const entityId = addEntity( tetrahedronWorld );

    addComponent( tetrahedronWorld, TetrahedronParams, {
      radius: radius,
      detail: detail
    }, entityId );

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for surface area ─────────────────────
    let totalSurfaceArea = new Double( 0 );

    // ─── Compute surface area in double precision ──────────────────────────
    const positions = this.getAttribute( 'position' ).array;
    const count = positions.length / 3;

    for ( let i = 0; i < count; i += 3 ) {

      const i0 = i * 3;
      const i1 = ( i + 1 ) * 3;
      const i2 = ( i + 2 ) * 3;

      const v0x = new Double( positions[ i0 ] );
      const v0y = new Double( positions[ i0 + 1 ] );
      const v0z = new Double( positions[ i0 + 2 ] );

      const v1x = new Double( positions[ i1 ] );
      const v1y = new Double( positions[ i1 + 1 ] );
      const v1z = new Double( positions[ i1 + 2 ] );

      const v2x = new Double( positions[ i2 ] );
      const v2y = new Double( positions[ i2 + 1 ] );
      const v2z = new Double( positions[ i2 + 2 ] );

      // Edge vectors
      const ax = v1x.sub( v0x );
      const ay = v1y.sub( v0y );
      const az = v1z.sub( v0z );

      const bx = v2x.sub( v0x );
      const by = v2y.sub( v0y );
      const bz = v2z.sub( v0z );

      // Cross product magnitude / 2 = triangle area
      const cx = ay.mul( bz ).sub( az.mul( by ) );
      const cy = az.mul( bx ).sub( ax.mul( bz ) );
      const cz = ax.mul( by ).sub( ay.mul( bx ) );

      const crossLen = cx.mul( cx ).add( cy.mul( cy ) ).add( cz.mul( cz ) ).sqrt();

      totalSurfaceArea = totalSurfaceArea.add( crossLen.mul( new Double( 0.5 ) ) );
    }

    this._totalSurfaceArea = totalSurfaceArea.toNumber();

    // ─── ECS: record tetrahedron statistics ────────────────────────────────
    addComponent( tetrahedronWorld, TetrahedronStats, {
      vertexCount: this.getAttribute( 'position' ).count,
      indexCount: this.getIndex() ? this.getIndex().count : 0,
      triangleCount: ( this.getIndex() ? this.getIndex().count : 0 ) / 3,
      faceCount: 4
    }, entityId );

    this._tetrahedronEntityId = entityId;
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {TetrahedronGeometry} A new instance.
   */
  static fromJSON( data ) {

    return new TetrahedronGeometry( data.radius, data.detail );
  }

  /**
   * Creates a TetrahedronGeometry with radius derived from a gl-matrix vec3 size.
   * Uses the x component as the radius.
   *
   * @param {vec3} size - gl-matrix vec3 containing radius in the x component.
   * @param {number} [detail=0] - Subdivision detail.
   * @return {TetrahedronGeometry} A new TetrahedronGeometry instance.
   */
  static fromVec3( size, detail = 0 ) {

    return new TetrahedronGeometry( size[ 0 ], detail );
  }

  /**
   * Creates a TetrahedronGeometry with radius derived from a Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing the radius.
   * @param {number} [detail=0] - Subdivision detail.
   * @return {TetrahedronGeometry} A new TetrahedronGeometry instance.
   */
  static fromDouble( d, detail = 0 ) {

    return new TetrahedronGeometry( d.toNumber(), detail );
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
   * Returns the total surface area of the tetrahedron in double precision.
   * Accumulated during construction using triangle cross-product magnitudes.
   *
   * @return {number} The approximate surface area.
   */
  getTotalSurfaceArea() {

    return this._totalSurfaceArea || 0;
  }

  /**
   * Computes the analytic volume of a regular tetrahedron in double precision.
   * V = a³ / (6√2), where a = edge length.
   * Edge length for radius R circumscribing sphere: a = 4R / √6.
   *
   * @return {number} The analytic volume.
   */
  computeVolume() {

    const { radius } = this.parameters;

    const a = new Double( 4 ).mul( new Double( radius ) )
      .div( new Double( 6 ).sqrt() );

    const aCubed = a.mul( a ).mul( a );
    const coeff = new Double( 1 ).div( new Double( 6 ).mul( new Double( 2 ).sqrt() ) );

    return coeff.mul( aCubed ).toNumber();
  }

  /**
   * Queries all TetrahedronGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( tetrahedronWorld, [ TetrahedronParams, TetrahedronStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          radius: TetrahedronParams.radius[ entity ],
          detail: TetrahedronParams.detail[ entity ]
        },
        stats: {
          vertexCount: TetrahedronStats.vertexCount[ entity ],
          indexCount: TetrahedronStats.indexCount[ entity ],
          triangleCount: TetrahedronStats.triangleCount[ entity ],
          faceCount: TetrahedronStats.faceCount[ entity ]
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

export { TetrahedronGeometry };
export default TetrahedronGeometry;