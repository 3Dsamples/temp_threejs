// file number : 004
// full path name : src/geometries/004_ConeGeometry.js
// description : ConeGeometry — a specialized cylinder with radiusTop = 0, producing a cone.
//               Inherits the full torso + base-cap generation of CylinderGeometry while
//               adding ECS registration, cached AABB computation, simplex-noise procedural
//               deformation, double-precision volume, and gl-matrix interop factories.
//               Integrates bitecs ECS, gl-matrix, double.js, and simplex-noise for enhanced
//               geometric computation capabilities.
// license : MIT

import { CylinderGeometry } from './003_CylinderGeometry.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const coneWorld = createWorld();

// ─── Component definitions for cone-specific tracking ───────────────────────
const ConeParams = defineComponent({
  radius: Types.f32,
  height: Types.f32,
  radialSegments: Types.ui16,
  heightSegments: Types.ui16,
  openEnded: Types.ui8,
  thetaStart: Types.f32,
  thetaLength: Types.f32
});

const ConeStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32,
  groupCount: Types.ui8
});

/**
 * A geometry class for representing a cone.
 *
 * ```js
 * const geometry = new THREE.ConeGeometry( 5, 20, 32 );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const cone = new THREE.Mesh( geometry, material );
 * scene.add( cone );
 * ```
 *
 * @augments CylinderGeometry
 * @demo scenes/geometry-browser.html#ConeGeometry
 */
class ConeGeometry extends CylinderGeometry {

  /**
   * Constructs a new cone geometry.
   *
   * @param {number} [radius=1] - Radius of the cone base.
   * @param {number} [height=1] - Height of the cone.
   * @param {number} [radialSegments=32] - Number of segmented faces around the circumference of the cone.
   * @param {number} [heightSegments=1] - Number of rows of faces along the height of the cone.
   * @param {boolean} [openEnded=false] - Whether the base of the cone is open or capped.
   * @param {number} [thetaStart=0] - Start angle for first segment, in radians.
   * @param {number} [thetaLength=Math.PI*2] - The central angle, often called theta, of the circular sector, in radians.
   *        The default value results in a complete cone.
   */
  constructor( radius = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = Math.PI * 2 ) {

    super( 0, radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength );

    this.type = 'ConeGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      radius: radius,
      height: height,
      radialSegments: radialSegments,
      heightSegments: heightSegments,
      openEnded: openEnded,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    };

    // ─── ECS: register cone-specific entity ────────────────────────────────
    const entityId = addEntity( coneWorld );

    addComponent( coneWorld, ConeParams, {
      radius: radius,
      height: height,
      radialSegments: radialSegments,
      heightSegments: heightSegments,
      openEnded: openEnded ? 1 : 0,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    }, entityId );

    const positionAttr = this.getAttribute( 'position' );
    const indexAttr = this.getIndex();

    addComponent( coneWorld, ConeStats, {
      vertexCount: positionAttr.count,
      indexCount: indexAttr.count,
      triangleCount: indexAttr.count / 3,
      groupCount: this.groups ? this.groups.length : 0
    }, entityId );

    // ─── Store the cone entity ID for later retrieval ──────────────────────
    this._coneEntityId = entityId;

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {ConeGeometry} A new instance.
   */
  static fromJSON( data ) {

    return new ConeGeometry(
      data.radius,
      data.height,
      data.radialSegments,
      data.heightSegments,
      data.openEnded,
      data.thetaStart,
      data.thetaLength
    );
  }

  /**
   * Creates a ConeGeometry from a gl-matrix vec3 size.
   * Uses x as radius and y as height.
   *
   * @param {vec3} size - gl-matrix vec3 with radius in x, height in y.
   * @param {number} [radialSegments=32] - Radial segment count.
   * @param {number} [heightSegments=1] - Height segment count.
   * @return {ConeGeometry} A new ConeGeometry instance.
   */
  static fromVec3( size, radialSegments = 32, heightSegments = 1 ) {

    return new ConeGeometry( size[ 0 ], size[ 1 ], radialSegments, heightSegments );
  }

  /**
   * Creates a ConeGeometry with a uniform height derived from a Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing the height.
   * @param {number} [radius=1] - Radius of the cone base.
   * @param {number} [radialSegments=32] - Radial segment count.
   * @return {ConeGeometry} A new ConeGeometry instance.
   */
  static fromDouble( d, radius = 1, radialSegments = 32 ) {

    return new ConeGeometry( radius, d.toNumber(), radialSegments );
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
   * Computes the volume of the cone using double precision.
   * V = (1/3) * π * r² * h * (thetaLength / 2π)
   *
   * @return {number} The approximate volume.
   */
  computeVolume() {

    const { radius, height, thetaLength } = this.parameters;

    const fraction = thetaLength / ( Math.PI * 2 );
    const r = new Double( radius );
    const h = new Double( height );

    const rSq = r.mul( r );
    const volume = rSq.mul( h ).mul( new Double( Math.PI / 3 ) ).mul( new Double( fraction ) );

    return volume.toNumber();
  }

  /**
   * Computes the lateral surface area of the cone using double precision.
   * A = π * r * l * (thetaLength / 2π), where l = sqrt(r² + h²)
   *
   * @return {number} The approximate lateral surface area.
   */
  computeLateralArea() {

    const { radius, height, thetaLength } = this.parameters;

    const fraction = thetaLength / ( Math.PI * 2 );
    const r = new Double( radius );
    const h = new Double( height );

    const slant = r.mul( r ).add( h.mul( h ) ).sqrt();
    const area = new Double( Math.PI ).mul( r ).mul( slant ).mul( new Double( fraction ) );

    return area.toNumber();
  }

  /**
   * Queries all ConeGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( coneWorld, [ ConeParams, ConeStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          radius: ConeParams.radius[ entity ],
          height: ConeParams.height[ entity ],
          radialSegments: ConeParams.radialSegments[ entity ],
          heightSegments: ConeParams.heightSegments[ entity ],
          openEnded: ConeParams.openEnded[ entity ] === 1,
          thetaStart: ConeParams.thetaStart[ entity ],
          thetaLength: ConeParams.thetaLength[ entity ]
        },
        stats: {
          vertexCount: ConeStats.vertexCount[ entity ],
          indexCount: ConeStats.indexCount[ entity ],
          triangleCount: ConeStats.triangleCount[ entity ],
          groupCount: ConeStats.groupCount[ entity ]
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

export { ConeGeometry };
export default ConeGeometry;