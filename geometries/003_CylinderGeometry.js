// file number : 003
// full path name : src/geometries/003_CylinderGeometry.js
// description : CylinderGeometry — creates a cylinder (or truncated cone) with configurable
//               radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded,
//               thetaStart, and thetaLength. Builds the lateral surface plus optional top/bottom
//               caps with correct UVs, normals, and per-face material groups. Integrates bitecs
//               ECS, gl-matrix, double.js, and simplex-noise for enhanced geometric computation.
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

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const cylinderWorld = createWorld();

// ─── Component definitions for geometry data tracking ───────────────────────
const CylinderParams = defineComponent({
  radiusTop: Types.f32,
  radiusBottom: Types.f32,
  height: Types.f32,
  radialSegments: Types.ui16,
  heightSegments: Types.ui16,
  openEnded: Types.ui8,
  thetaStart: Types.f32,
  thetaLength: Types.f32
});

const CylinderStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32,
  groupCount: Types.ui8
});

/**
 * A class for generating cylinder geometries.
 *
 * ```js
 * const geometry = new THREE.CylinderGeometry( 5, 5, 20, 32 );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const cylinder = new THREE.Mesh( geometry, material );
 * scene.add( cylinder );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#CylinderGeometry
 */
class CylinderGeometry extends BufferGeometry {

  /**
   * Constructs a new cylinder geometry.
   *
   * @param {number} [radiusTop=1] - Radius of the cylinder at the top.
   * @param {number} [radiusBottom=1] - Radius of the cylinder at the bottom.
   * @param {number} [height=1] - Height of the cylinder.
   * @param {number} [radialSegments=32] - Number of segmented faces around the circumference.
   * @param {number} [heightSegments=1] - Number of rows of faces along the height.
   * @param {boolean} [openEnded=false] - Whether the ends of the cylinder are open.
   * @param {number} [thetaStart=0] - Start angle in radians.
   * @param {number} [thetaLength=Math.PI*2] - Central angle in radians.
   */
  constructor( radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = Math.PI * 2 ) {

    super();

    this.type = 'CylinderGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      radiusTop: radiusTop,
      radiusBottom: radiusBottom,
      height: height,
      radialSegments: radialSegments,
      heightSegments: heightSegments,
      openEnded: openEnded,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    };

    const scope = this;

    // ─── Integer enforcement ───────────────────────────────────────────────
    radialSegments = Math.floor( radialSegments );
    heightSegments = Math.floor( heightSegments );

    // ─── Buffers ───────────────────────────────────────────────────────────
    const indices = [];
    const vertices = [];
    const normals = [];
    const uvs = [];

    // ─── Helper variables ──────────────────────────────────────────────────
    let index = 0;
    const indexArray = [];
    const halfHeight = height / 2;
    let groupStart = 0;

    // ─── ECS: register geometry entity ─────────────────────────────────────
    const entityId = addEntity( cylinderWorld );

    addComponent( cylinderWorld, CylinderParams, {
      radiusTop: radiusTop,
      radiusBottom: radiusBottom,
      height: height,
      radialSegments: radialSegments,
      heightSegments: heightSegments,
      openEnded: openEnded ? 1 : 0,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    }, entityId );

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator ──────────────────────────────────────
    const _dbl = new Double( 0 );

    // ─── Reusable math ─────────────────────────────────────────────────────
    const _vec = new Vector3();
    const _uv = new Vector2();

    // ─── Generate geometry ─────────────────────────────────────────────────
    generateTorso();

    if ( openEnded === false ) {

      if ( radiusTop > 0 ) generateCap( true );
      if ( radiusBottom > 0 ) generateCap( false );
    }

    // ─── Build geometry ────────────────────────────────────────────────────
    this.setIndex( indices );
    this.setAttribute( 'position', new Float32BufferAttribute( vertices, 3 ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );

    // ─── ECS: record geometry statistics ───────────────────────────────────
    addComponent( cylinderWorld, CylinderStats, {
      vertexCount: vertices.length / 3,
      indexCount: indices.length,
      triangleCount: indices.length / 3,
      groupCount: scope.groups ? scope.groups.length : 0
    }, entityId );

    // ─── Bounding info caches ──────────────────────────────────────────────
    this.boundingBox = null;
    this.boundingSphere = null;
    this._cachedAABB = null;

    function generateTorso() {

      const normal = new Vector3();
      const vertex = new Vector3();

      let groupCount = 0;

      // ─── Generate rings of vertices ────────────────────────────────────
      for ( let y = 0; y <= heightSegments; y ++ ) {

        const indexRow = [];
        const v = y / heightSegments;

        // ─── Calculate radius of current ring ───────────────────────────
        const radius = v * ( radiusBottom - radiusTop ) + radiusTop;

        for ( let x = 0; x <= radialSegments; x ++ ) {

          const u = x / radialSegments;
          const theta = u * thetaLength + thetaStart;

          const sinTheta = Math.sin( theta );
          const cosTheta = Math.cos( theta );

          // ─── Vertex ──────────────────────────────────────────────────
          vertex.x = radius * sinTheta;
          vertex.y = - v * height + halfHeight;
          vertex.z = radius * cosTheta;
          vertices.push( vertex.x, vertex.y, vertex.z );

          // ─── Normal ──────────────────────────────────────────────────
          normal.set( sinTheta, 0, cosTheta ).normalize();
          normals.push( normal.x, normal.y, normal.z );

          // ─── UV ──────────────────────────────────────────────────────
          uvs.push( u, 1 - v );

          // ─── Save index of vertex in the current row ─────────────────
          indexRow.push( index ++ );
        }

        indexArray.push( indexRow );
      }

      // ─── Generate indices ──────────────────────────────────────────────
      for ( let x = 0; x < radialSegments; x ++ ) {

        for ( let y = 0; y < heightSegments; y ++ ) {

          const a = indexArray[ y ][ x + 1 ];
          const b = indexArray[ y ][ x ];
          const c = indexArray[ y + 1 ][ x ];
          const d = indexArray[ y + 1 ][ x + 1 ];

          if ( radiusTop > 0 || y !== 0 ) {

            indices.push( a, b, d );
            groupCount += 3;
          }

          if ( radiusBottom > 0 || y !== heightSegments - 1 ) {

            indices.push( b, c, d );
            groupCount += 3;
          }
        }
      }

      // ─── Add group for the side material ──────────────────────────────
      scope.addGroup( groupStart, groupCount, 0 );
      groupStart += groupCount;
    }

    function generateCap( top ) {

      // ─── Save the index at the beginning to prevent duplicates ────────
      const centerIndexStart = index;

      const uv = new Vector2();
      const vertex = new Vector3();

      let groupCount = 0;

      const radius = ( top === true ) ? radiusTop : radiusBottom;
      const sign = ( top === true ) ? 1 : - 1;

      // ─── Center vertex ────────────────────────────────────────────────
      vertices.push( 0, halfHeight * sign, 0 );
      normals.push( 0, sign, 0 );
      uvs.push( 0.5, 0.5 );
      index ++;

      const centerIndexEnd = index;

      // ─── Perimeter vertices ──────────────────────────────────────────
      for ( let x = 0; x <= radialSegments; x ++ ) {

        const u = x / radialSegments;
        const theta = u * thetaLength + thetaStart;

        const cosTheta = Math.cos( theta );
        const sinTheta = Math.sin( theta );

        vertex.x = radius * sinTheta;
        vertex.y = halfHeight * sign;
        vertex.z = radius * cosTheta;
        vertices.push( vertex.x, vertex.y, vertex.z );

        normals.push( 0, sign, 0 );

        uv.x = ( cosTheta * 0.5 ) + 0.5;
        uv.y = ( sinTheta * 0.5 * sign ) + 0.5;
        uvs.push( uv.x, uv.y );

        index ++;
      }

      // ─── Indices ─────────────────────────────────────────────────────
      for ( let x = 0; x < radialSegments; x ++ ) {

        const c = centerIndexStart + x;
        const i = centerIndexEnd + x;

        if ( top === true ) {

          indices.push( i, i + 1, c );
        } else {

          indices.push( i + 1, i, c );
        }

        groupCount += 3;
      }

      // ─── Add group for the cap material ──────────────────────────────
      scope.addGroup( groupStart, groupCount, top === true ? 1 : 2 );
      groupStart += groupCount;
    }
  }

  /**
   * Creates a new CylinderGeometry from a JSON object.
   *
   * @param {Object} data - The JSON data.
   * @return {CylinderGeometry} A new CylinderGeometry instance.
   */
  static fromJSON( data ) {

    return new CylinderGeometry(
      data.radiusTop,
      data.radiusBottom,
      data.height,
      data.radialSegments,
      data.heightSegments,
      data.openEnded,
      data.thetaStart,
      data.thetaLength
    );
  }

  /**
   * Creates a CylinderGeometry from a gl-matrix vec3 size.
   * Uses x and z as radii and y as height.
   *
   * @param {vec3} size - gl-matrix vec3 with radiusX, height, radiusZ.
   * @param {number} [radialSegments=32] - Radial segment count.
   * @param {number} [heightSegments=1] - Height segment count.
   * @return {CylinderGeometry} A new CylinderGeometry instance.
   */
  static fromVec3( size, radialSegments = 32, heightSegments = 1 ) {

    return new CylinderGeometry( size[ 0 ], size[ 2 ], size[ 1 ], radialSegments, heightSegments );
  }

  /**
   * Creates a CylinderGeometry from a Double-precision value.
   *
   * @param {Double} d - A double.js Double value representing height.
   * @param {number} [radius=1] - Uniform radius.
   * @param {number} [radialSegments=32] - Radial segment count.
   * @return {CylinderGeometry} A new CylinderGeometry instance.
   */
  static fromDouble( d, radius = 1, radialSegments = 32 ) {

    return new CylinderGeometry( radius, radius, d.toNumber(), radialSegments );
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
   * Computes the approximate volume of the cylinder using double precision.
   * Uses the frustum volume formula: V = (1/3) * π * h * (r₁² + r₁r₂ + r₂²).
   *
   * @return {number} The approximate volume.
   */
  computeVolume() {

    const { radiusTop, radiusBottom, height, thetaLength } = this.parameters;

    const fraction = thetaLength / ( Math.PI * 2 );
    const r1 = new Double( radiusTop );
    const r2 = new Double( radiusBottom );
    const h = new Double( height );

    const r1sq = r1.mul( r1 );
    const r2sq = r2.mul( r2 );
    const r1r2 = r1.mul( r2 );

    const sum = r1sq.add( r1r2 ).add( r2sq );
    const volume = sum.mul( h ).mul( new Double( Math.PI / 3 ) ).mul( new Double( fraction ) );

    return volume.toNumber();
  }

  /**
   * Queries all CylinderGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( cylinderWorld, [ CylinderParams, CylinderStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          radiusTop: CylinderParams.radiusTop[ entity ],
          radiusBottom: CylinderParams.radiusBottom[ entity ],
          height: CylinderParams.height[ entity ],
          radialSegments: CylinderParams.radialSegments[ entity ],
          heightSegments: CylinderParams.heightSegments[ entity ],
          openEnded: CylinderParams.openEnded[ entity ] === 1,
          thetaStart: CylinderParams.thetaStart[ entity ],
          thetaLength: CylinderParams.thetaLength[ entity ]
        },
        stats: {
          vertexCount: CylinderStats.vertexCount[ entity ],
          indexCount: CylinderStats.indexCount[ entity ],
          triangleCount: CylinderStats.triangleCount[ entity ],
          groupCount: CylinderStats.groupCount[ entity ]
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

export { CylinderGeometry };
export default CylinderGeometry;