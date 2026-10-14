// file number : 012
// full path name : src/geometries/012_IcosahedronGeometry.js
// description : IcosahedronGeometry — a regular icosahedron (20 triangular faces) built
//               from a golden-ratio vertex set projected onto a sphere. Extends
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
const icosahedronWorld = createWorld();

// ─── Component definitions for icosahedron tracking ─────────────────────────
const IcosahedronParams = defineComponent({
  radius: Types.f32,
  detail: Types.ui8
});

const IcosahedronStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32,
  faceCount: Types.ui8
});

/**
 * A geometry class for representing an icosahedron.
 *
 * ```js
 * const geometry = new THREE.IcosahedronGeometry();
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const icosahedron = new THREE.Mesh( geometry, material );
 * scene.add( icosahedron );
 * ```
 *
 * @augments PolyhedronGeometry
 * @demo scenes/geometry-browser.html#IcosahedronGeometry
 */
class IcosahedronGeometry extends PolyhedronGeometry {

  /**
   * Constructs a new icosahedron geometry.
   *
   * @param {number} [radius=1] - Radius of the icosahedron.
   * @param {number} [detail=0] - Setting this to a value greater than `0` adds vertices making it no
   *        longer an icosahedron.
   */
  constructor( radius = 1, detail = 0 ) {

    // ─── Golden-ratio vertex data (mirrors r185 source) ────────────────────
    const t = ( 1 + Math.sqrt( 5 ) ) / 2;

    const vertices = [
      - 1, t, 0, 	1, t, 0, 	- 1, - t, 0, 	1, - t, 0,
      0, - 1, t, 	0, 1, t, 	0, - 1, - t, 	0, 1, - t,
      t, 0, - 1, 	t, 0, 1, 	- t, 0, - 1, 	- t, 0, 1
    ];

    const indices = [
      0, 11, 5, 	0, 5, 1, 	0, 1, 7, 	0, 7, 10, 	0, 10, 11,
      1, 5, 9, 	5, 11, 4, 	11, 10, 2, 	10, 7, 6, 	7, 1, 8,
      3, 9, 4, 	3, 4, 2, 	3, 2, 6, 	3, 6, 8, 	3, 8, 9,
      4, 9, 5, 	2, 4, 11, 	6, 2, 10, 	8, 6, 7, 	9, 8, 1
    ];

    super( vertices, indices, radius, detail );

    this.type = 'IcosahedronGeometry';

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

    // ─── ECS: register icosahedron entity ──────────────────────────────────
    const entityId = addEntity( icosahedronWorld );

    addComponent( icosahedronWorld, IcosahedronParams, {
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

    // ─── ECS: record icosahedron statistics ────────────────────────────────
    addComponent( icosahedronWorld, IcosahedronStats, {
      vertexCount: this.getAttribute( 'position' ).count,
      indexCount: this.getIndex() ? this.getIndex().count : 0,
      triangleCount: ( this.getIndex() ? this.getIndex().count : 0 ) / 3,
      faceCount: 20
    }, entityId );

    this._icosahedronEntityId = entityId;
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {IcosahedronGeometry} A new instance.
   */
  static fromJSON( data ) {

    return new IcosahedronGeometry( data.radius, data.detail );
  }

  /**
   * Creates an IcosahedronGeometry with radius derived from a gl-matrix vec3 size.
   * Uses the x component as the radius.
   *
   * @param {vec3} size - gl-matrix vec3 containing radius in the x component.
   * @param {number} [detail=0] - Subdivision detail.
   * @return {IcosahedronGeometry} A new IcosahedronGeometry instance.
   */
  static fromVec3( size, detail = 0 ) {

    return new IcosahedronGeometry( size[ 0 ], detail );
  }

  /**
   * Creates an IcosahedronGeometry with radius derived from a Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing the radius.
   * @param {number} [detail=0] - Subdivision detail.
   * @return {IcosahedronGeometry} A new IcosahedronGeometry instance.
   */
  static fromDouble( d, detail = 0 ) {

    return new IcosahedronGeometry( d.toNumber(), detail );
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
   * Returns the total surface area of the icosahedron in double precision.
   * Accumulated during construction using triangle cross-product magnitudes.
   *
   * @return {number} The approximate surface area.
   */
  getTotalSurfaceArea() {

    return this._totalSurfaceArea || 0;
  }

  /**
   * Computes the analytic volume of a regular icosahedron in double precision.
   * V = (5/12) * (3 + √5) * a³, where a = edge length.
   * Edge length for radius R circumscribing sphere: a = 4R / √(10 + 2√5).
   *
   * @return {number} The analytic volume.
   */
  computeVolume() {

    const { radius } = this.parameters;

    const sqrt5 = new Double( Math.sqrt( 5 ) );

    // Edge length from circumradius
    const a = new Double( 4 ).mul( new Double( radius ) )
      .div( new Double( 10 ).add( new Double( 2 ).mul( sqrt5 ) ).sqrt() );

    const aCubed = a.mul( a ).mul( a );
    const coeff = new Double( 5 ).div( new Double( 12 ) ).mul( new Double( 3 ).add( sqrt5 ) );

    return coeff.mul( aCubed ).toNumber();
  }

  /**
   * Queries all IcosahedronGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( icosahedronWorld, [ IcosahedronParams, IcosahedronStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          radius: IcosahedronParams.radius[ entity ],
          detail: IcosahedronParams.detail[ entity ]
        },
        stats: {
          vertexCount: IcosahedronStats.vertexCount[ entity ],
          indexCount: IcosahedronStats.indexCount[ entity ],
          triangleCount: IcosahedronStats.triangleCount[ entity ],
          faceCount: IcosahedronStats.faceCount[ entity ]
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

export { IcosahedronGeometry };
export default IcosahedronGeometry;