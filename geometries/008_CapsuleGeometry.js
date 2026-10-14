// file number : 008
// full path name : src/geometries/008_CapsuleGeometry.js
// description : CapsuleGeometry — creates a capsule (a cylinder with hemispherical caps)
//               parameterized by radius, middle-section height, cap segments, radial segments,
//               and height segments. The profile is swept around the Y axis with pre-computed
//               normals for smooth shading. Integrates bitecs ECS for capsule-parameter tracking,
//               gl-matrix for cached AABB and interop factories, double.js for high-precision
//               volume/surface-area metrics, and simplex-noise for procedural surface deformation.
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
const capsuleWorld = createWorld();

// ─── Component definitions for capsule tracking ─────────────────────────────
const CapsuleParams = defineComponent({
  radius: Types.f32,
  height: Types.f32,
  capSegments: Types.ui16,
  radialSegments: Types.ui16,
  heightSegments: Types.ui16
});

const CapsuleStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32
});

/**
 * A geometry class for representing a capsule.
 *
 * ```js
 * const geometry = new THREE.CapsuleGeometry( 1, 1, 4, 8, 1 );
 * const material = new THREE.MeshBasicMaterial( { color: 0x00ff00 } );
 * const capsule = new THREE.Mesh( geometry, material );
 * scene.add( capsule );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#CapsuleGeometry
 */
class CapsuleGeometry extends BufferGeometry {

  /**
   * Constructs a new capsule geometry.
   *
   * @param {number} [radius=1] - Radius of the capsule.
   * @param {number} [height=1] - Height of the middle section.
   * @param {number} [capSegments=4] - Number of curve segments used to build each cap.
   * @param {number} [radialSegments=8] - Number of segmented faces around the circumference
   *        of the capsule. Must be an integer >= 3.
   * @param {number} [heightSegments=1] - Number of rows of faces along the height of the
   *        middle section. Must be an integer >= 1.
   */
  constructor( radius = 1, height = 1, capSegments = 4, radialSegments = 8, heightSegments = 1 ) {

    super();

    this.type = 'CapsuleGeometry';

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
      capSegments: capSegments,
      radialSegments: radialSegments,
      heightSegments: heightSegments
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    // ─── Parameter normalization (mirrors r185 source) ─────────────────────
    height = Math.max( 0, height );
    capSegments = Math.max( 1, Math.floor( capSegments ) );
    radialSegments = Math.max( 3, Math.floor( radialSegments ) );
    heightSegments = Math.max( 1, Math.floor( heightSegments ) );

    // ─── ECS: register capsule entity ──────────────────────────────────────
    const entityId = addEntity( capsuleWorld );

    addComponent( capsuleWorld, CapsuleParams, {
      radius: radius,
      height: height,
      capSegments: capSegments,
      radialSegments: radialSegments,
      heightSegments: heightSegments
    }, entityId );

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for surface area ─────────────────────
    let totalSurfaceArea = new Double( 0 );

    // ─── Buffers ───────────────────────────────────────────────────────────
    const indices = [];
    const vertices = [];
    const normals = [];
    const uvs = [];

    // ─── Helper variables ──────────────────────────────────────────────────
    const halfHeight = height / 2;
    const capArcLength = ( Math.PI / 2 ) * radius;
    const cylinderPartLength = height;
    const totalArcLength = 2 * capArcLength + cylinderPartLength;
    const numVerticalSegments = capSegments * 2 + heightSegments;
    const verticesPerRow = radialSegments + 1;

    const normal = new Vector3();
    const vertex = new Vector3();

    // ─── Generate vertices, normals, and uvs ───────────────────────────────
    for ( let iy = 0; iy <= numVerticalSegments; iy ++ ) {

      let currentArcLength = 0;
      let profileY = 0;
      let profileRadius = 0;
      let normalYComponent = 0;

      if ( iy <= capSegments ) {

        // ─── Bottom cap ──────────────────────────────────────────────────
        const segmentProgress = iy / capSegments;
        const angle = ( segmentProgress * Math.PI ) / 2;

        profileY = - halfHeight - radius * Math.cos( angle );
        profileRadius = radius * Math.sin( angle );
        normalYComponent = - radius * Math.cos( angle );
        currentArcLength = segmentProgress * capArcLength;

      } else if ( iy <= capSegments + heightSegments ) {

        // ─── Middle section ──────────────────────────────────────────────
        const segmentProgress = ( iy - capSegments ) / heightSegments;

        profileY = - halfHeight + segmentProgress * height;
        profileRadius = radius;
        normalYComponent = 0;
        currentArcLength = capArcLength + segmentProgress * cylinderPartLength;

      } else {

        // ─── Top cap ─────────────────────────────────────────────────────
        const segmentProgress = ( iy - capSegments - heightSegments ) / capSegments;
        const angle = ( segmentProgress * Math.PI ) / 2;

        profileY = halfHeight + radius * Math.sin( angle );
        profileRadius = radius * Math.cos( angle );
        normalYComponent = radius * Math.sin( angle );
        currentArcLength = capArcLength + cylinderPartLength + segmentProgress * capArcLength;
      }

      const v = Math.max( 0, Math.min( 1, currentArcLength / totalArcLength ) );

      // ─── Special case for the poles ─────────────────────────────────────
      let uOffset = 0;

      if ( iy === 0 ) {

        uOffset = 0.5 / radialSegments;

      } else if ( iy === numVerticalSegments ) {

        uOffset = - 0.5 / radialSegments;
      }

      for ( let ix = 0; ix <= radialSegments; ix ++ ) {

        const u = ix / radialSegments;
        const theta = u * Math.PI * 2;

        const sinTheta = Math.sin( theta );
        const cosTheta = Math.cos( theta );

        // ─── Vertex ──────────────────────────────────────────────────────
        vertex.x = - profileRadius * cosTheta;
        vertex.y = profileY;
        vertex.z = profileRadius * sinTheta;
        vertices.push( vertex.x, vertex.y, vertex.z );

        // ─── Normal ──────────────────────────────────────────────────────
        normal.set( - profileRadius * cosTheta, normalYComponent, profileRadius * sinTheta );
        normal.normalize();
        normals.push( normal.x, normal.y, normal.z );

        // ─── UV ──────────────────────────────────────────────────────────
        uvs.push( u + uOffset, v );
      }

      // ─── Indices (skip first row) ──────────────────────────────────────
      if ( iy > 0 ) {

        const prevIndexRow = ( iy - 1 ) * verticesPerRow;

        for ( let ix = 0; ix < radialSegments; ix ++ ) {

          const i1 = prevIndexRow + ix;
          const i2 = prevIndexRow + ix + 1;
          const i3 = iy * verticesPerRow + ix;
          const i4 = iy * verticesPerRow + ix + 1;

          indices.push( i1, i2, i3 );
          indices.push( i2, i4, i3 );

          // ─── Accumulate surface area in double precision ────────────
          const v0x = vertices[ i1 * 3 ];
          const v0y = vertices[ i1 * 3 + 1 ];
          const v0z = vertices[ i1 * 3 + 2 ];

          const v1x = vertices[ i2 * 3 ];
          const v1y = vertices[ i2 * 3 + 1 ];
          const v1z = vertices[ i2 * 3 + 2 ];

          const v2x = vertices[ i3 * 3 ];
          const v2y = vertices[ i3 * 3 + 1 ];
          const v2z = vertices[ i3 * 3 + 2 ];

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

    // ─── ECS: record capsule statistics ────────────────────────────────────
    addComponent( capsuleWorld, CapsuleStats, {
      vertexCount: vertices.length / 3,
      indexCount: indices.length,
      triangleCount: indices.length / 3
    }, entityId );

    this._capsuleEntityId = entityId;
    this._totalSurfaceArea = totalSurfaceArea.toNumber();
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {CapsuleGeometry} A new instance.
   */
  static fromJSON( data ) {

    return new CapsuleGeometry(
      data.radius,
      data.height,
      data.capSegments,
      data.radialSegments,
      data.heightSegments
    );
  }

  /**
   * Creates a CapsuleGeometry from a gl-matrix vec3 size.
   * Uses x as radius and y as height.
   *
   * @param {vec3} size - gl-matrix vec3 with radius in x, height in y.
   * @param {number} [capSegments=4] - Cap segment count.
   * @param {number} [radialSegments=8] - Radial segment count.
   * @param {number} [heightSegments=1] - Height segment count.
   * @return {CapsuleGeometry} A new CapsuleGeometry instance.
   */
  static fromVec3( size, capSegments = 4, radialSegments = 8, heightSegments = 1 ) {

    return new CapsuleGeometry( size[ 0 ], size[ 1 ], capSegments, radialSegments, heightSegments );
  }

  /**
   * Creates a CapsuleGeometry with a uniform height derived from a
   * Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing height.
   * @param {number} [radius=1] - Radius of the capsule.
   * @param {number} [capSegments=4] - Cap segment count.
   * @param {number} [radialSegments=8] - Radial segment count.
   * @return {CapsuleGeometry} A new CapsuleGeometry instance.
   */
  static fromDouble( d, radius = 1, capSegments = 4, radialSegments = 8 ) {

    return new CapsuleGeometry( radius, d.toNumber(), capSegments, radialSegments );
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
   * Returns the total surface area of the capsule geometry in double precision.
   * Uses the accumulated triangle cross-product magnitude during construction.
   *
   * @return {number} The approximate surface area.
   */
  getTotalSurfaceArea() {

    return this._totalSurfaceArea || 0;
  }

  /**
   * Computes the analytic volume of the capsule in double precision.
   * V = π * r² * h + (4/3) * π * r³
   *
   * @return {number} The analytic volume.
   */
  computeVolume() {

    const { radius, height } = this.parameters;

    const r = new Double( radius );
    const h = new Double( height );

    const cylinderVolume = new Double( Math.PI ).mul( r ).mul( r ).mul( h );
    const sphereVolume = new Double( 4 / 3 ).mul( new Double( Math.PI ) ).mul( r ).mul( r ).mul( r );

    return cylinderVolume.add( sphereVolume ).toNumber();
  }

  /**
   * Computes the analytic surface area of the capsule in double precision.
   * A = 2 * π * r * h + 4 * π * r²
   *
   * @return {number} The analytic surface area.
   */
  computeAnalyticSurfaceArea() {

    const { radius, height } = this.parameters;

    const r = new Double( radius );
    const h = new Double( height );

    const cylinderArea = new Double( 2 ).mul( new Double( Math.PI ) ).mul( r ).mul( h );
    const sphereArea = new Double( 4 ).mul( new Double( Math.PI ) ).mul( r ).mul( r );

    return cylinderArea.add( sphereArea ).toNumber();
  }

  /**
   * Queries all CapsuleGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( capsuleWorld, [ CapsuleParams, CapsuleStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          radius: CapsuleParams.radius[ entity ],
          height: CapsuleParams.height[ entity ],
          capSegments: CapsuleParams.capSegments[ entity ],
          radialSegments: CapsuleParams.radialSegments[ entity ],
          heightSegments: CapsuleParams.heightSegments[ entity ]
        },
        stats: {
          vertexCount: CapsuleStats.vertexCount[ entity ],
          indexCount: CapsuleStats.indexCount[ entity ],
          triangleCount: CapsuleStats.triangleCount[ entity ]
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

export { CapsuleGeometry };
export default CapsuleGeometry;