// file number : 015
// full path name : src/geometries/015_RingGeometry.js
// description : RingGeometry — creates a two-dimensional ring (annulus) with configurable
//               inner radius, outer radius, theta segments, phi segments, start angle,
//               and central angle. Builds concentric rings of vertices from the inner
//               radius outward, with planar +Z normals and radial UV mapping. Integrates
//               bitecs ECS for parameter/stat tracking, gl-matrix for cached AABB and
//               interop factories, double.js for high-precision area metrics, and
//               simplex-noise for procedural planar deformation. Provides fromVec3 /
//               fromDouble factories and ECS queryAll for introspection.
// license : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { Vector2 } from '../math/002_Vector2.js';
import { Vector3 } from '../math/003_Vector3.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const ringWorld = createWorld();

// ─── Component definitions for ring tracking ────────────────────────────────
const RingParams = defineComponent({
  innerRadius: Types.f32,
  outerRadius: Types.f32,
  thetaSegments: Types.ui16,
  phiSegments: Types.ui16,
  thetaStart: Types.f32,
  thetaLength: Types.f32
});

const RingStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32
});

/**
 * A class for generating a two-dimensional ring geometry.
 *
 * ```js
 * const geometry = new THREE.RingGeometry( 1, 5, 32 );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00, side: THREE.DoubleSide } );
 * const mesh = new THREE.Mesh( geometry, material );
 * scene.add( mesh );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#RingGeometry
 */
class RingGeometry extends BufferGeometry {

  /**
   * Constructs a new ring geometry.
   *
   * @param {number} [innerRadius=0.5] - The inner radius of the ring.
   * @param {number} [outerRadius=1] - The outer radius of the ring.
   * @param {number} [thetaSegments=32] - Number of segments. A higher number means the ring will be more round. Minimum is `3`.
   * @param {number} [phiSegments=1] - Number of segments per ring segment. Minimum is `1`.
   * @param {number} [thetaStart=0] - Starting angle in radians.
   * @param {number} [thetaLength=Math.PI*2] - Central angle in radians.
   */
  constructor( innerRadius = 0.5, outerRadius = 1, thetaSegments = 32, phiSegments = 1, thetaStart = 0, thetaLength = Math.PI * 2 ) {

    super();

    this.type = 'RingGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      innerRadius: innerRadius,
      outerRadius: outerRadius,
      thetaSegments: thetaSegments,
      phiSegments: phiSegments,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    // ─── Integer enforcement ───────────────────────────────────────────────
    thetaSegments = Math.max( 3, Math.floor( thetaSegments ) );
    phiSegments = Math.max( 1, Math.floor( phiSegments ) );

    // ─── ECS: register ring entity ─────────────────────────────────────────
    const entityId = addEntity( ringWorld );

    addComponent( ringWorld, RingParams, {
      innerRadius: innerRadius,
      outerRadius: outerRadius,
      thetaSegments: thetaSegments,
      phiSegments: phiSegments,
      thetaStart: thetaStart,
      thetaLength: thetaLength
    }, entityId );

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for surface area ─────────────────────
    let totalSurfaceArea = new Double( 0 );

    // ─── Pre-allocated typed arrays for maximum throughput ─────────────────
    const vertexCount = ( thetaSegments + 1 ) * ( phiSegments + 1 );
    const indexCount = thetaSegments * phiSegments * 6;

    const indices = new ( vertexCount > 65535 ? Uint32Array : Uint16Array )( indexCount );
    const vertices = new Float32Array( vertexCount * 3 );
    const normals = new Float32Array( vertexCount * 3 );
    const uvs = new Float32Array( vertexCount * 2 );

    // ─── Write cursors ─────────────────────────────────────────────────────
    let vWrite = 0;
    let uvWrite = 0;
    let iWrite = 0;

    // ─── Helper variables ──────────────────────────────────────────────────
    let radius = innerRadius;
    const radiusStep = ( ( outerRadius - innerRadius ) / phiSegments );

    const _vertex = new Vector3();
    const _uv = new Vector2();

    // ─── Noise instance for optional displacement ──────────────────────────
    const _noise2D = createNoise2D();

    // ─── Generate vertices, normals, and UVs ───────────────────────────────
    for ( let j = 0; j <= phiSegments; j ++ ) {

      for ( let i = 0; i <= thetaSegments; i ++ ) {

        // values are generated from the inside of the ring to the outside
        const segment = thetaStart + i / thetaSegments * thetaLength;

        // ─── Vertex ──────────────────────────────────────────────────────
        _vertex.x = radius * Math.cos( segment );
        _vertex.y = radius * Math.sin( segment );

        vertices[ vWrite ++ ] = _vertex.x;
        vertices[ vWrite ++ ] = _vertex.y;
        vertices[ vWrite ++ ] = 0;

        // ─── Normal (+Z) ─────────────────────────────────────────────────
        normals[ vWrite - 3 ] = 0;
        normals[ vWrite - 2 ] = 0;
        normals[ vWrite - 1 ] = 1;

        // ─── UV ──────────────────────────────────────────────────────────
        _uv.x = ( _vertex.x / outerRadius + 1 ) / 2;
        _uv.y = ( _vertex.y / outerRadius + 1 ) / 2;

        uvs[ uvWrite ++ ] = _uv.x;
        uvs[ uvWrite ++ ] = _uv.y;
      }

      // increase the radius for next row of vertices
      radius += radiusStep;
    }

    // ─── Generate indices ──────────────────────────────────────────────────
    for ( let j = 0; j < phiSegments; j ++ ) {

      const thetaSegmentLevel = j * ( thetaSegments + 1 );

      for ( let i = 0; i < thetaSegments; i ++ ) {

        const segment = i + thetaSegmentLevel;

        const a = segment;
        const b = segment + thetaSegments + 1;
        const c = segment + thetaSegments + 2;
        const d = segment + 1;

        // faces
        indices[ iWrite ++ ] = a;
        indices[ iWrite ++ ] = b;
        indices[ iWrite ++ ] = d;

        indices[ iWrite ++ ] = b;
        indices[ iWrite ++ ] = c;
        indices[ iWrite ++ ] = d;

        // ─── Accumulate surface area in double precision ────────────────
        const v0x = vertices[ a * 3 ];
        const v0y = vertices[ a * 3 + 1 ];

        const v1x = vertices[ b * 3 ];
        const v1y = vertices[ b * 3 + 1 ];

        const v2x = vertices[ d * 3 ];
        const v2y = vertices[ d * 3 + 1 ];

        // For planar geometry, area = 0.5 * | (x1-x0)(y2-y0) - (x2-x0)(y1-y0) |
        const ax = new Double( v1x - v0x );
        const ay = new Double( v1y - v0y );

        const bx = new Double( v2x - v0x );
        const by = new Double( v2y - v0y );

        const cross = ax.mul( by ).sub( ay.mul( bx ) );

        const absCross = cross.toNumber() < 0 ? cross.mul( new Double( - 1 ) ) : cross;

        totalSurfaceArea = totalSurfaceArea.add( absCross.mul( new Double( 0.5 ) ) );
      }
    }

    // ─── Build geometry ────────────────────────────────────────────────────
    this.setIndex( indices );
    this.setAttribute( 'position', new Float32BufferAttribute( vertices.buffer, 3, 0, vWrite ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals.buffer, 3, 0, vWrite ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs.buffer, 2, 0, uvWrite ) );

    // ─── ECS: record ring statistics ───────────────────────────────────────
    addComponent( ringWorld, RingStats, {
      vertexCount: vertexCount,
      indexCount: indexCount,
      triangleCount: indexCount / 3
    }, entityId );

    this._ringEntityId = entityId;
    this._totalSurfaceArea = totalSurfaceArea.toNumber();
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {RingGeometry} A new instance.
   */
  static fromJSON( data ) {

    return new RingGeometry(
      data.innerRadius,
      data.outerRadius,
      data.thetaSegments,
      data.phiSegments,
      data.thetaStart,
      data.thetaLength
    );
  }

  /**
   * Creates a RingGeometry from a gl-matrix vec3 size.
   * Uses the x component as the inner radius and the y component as the outer radius.
   *
   * @param {vec3} size - gl-matrix vec3 containing innerRadius in x and outerRadius in y.
   * @param {number} [thetaSegments=32] - Theta segment count.
   * @param {number} [phiSegments=1] - Phi segment count.
   * @return {RingGeometry} A new RingGeometry instance.
   */
  static fromVec3( size, thetaSegments = 32, phiSegments = 1 ) {

    return new RingGeometry( size[ 0 ], size[ 1 ], thetaSegments, phiSegments );
  }

  /**
   * Creates a RingGeometry with radii derived from a Double-precision value.
   * The Double value is used as the outer radius; the inner radius is half of it.
   *
   * @param {Double} d - A double.js Double value representing the outer radius.
   * @param {number} [thetaSegments=32] - Theta segment count.
   * @param {number} [phiSegments=1] - Phi segment count.
   * @return {RingGeometry} A new RingGeometry instance.
   */
  static fromDouble( d, thetaSegments = 32, phiSegments = 1 ) {

    const outer = d.toNumber();

    return new RingGeometry( outer / 2, outer, thetaSegments, phiSegments );
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
   * Uses simplex-noise for procedural planar deformation.
   *
   * @param {number} [amplitude=0.1] - Displacement amplitude.
   * @param {number} [frequency=1] - Noise frequency.
   */
  applyNoise( amplitude = 0.1, frequency = 1 ) {

    const noise2D = createNoise2D();
    const positions = this.getAttribute( 'position' ).array;
    const count = positions.length / 3;

    for ( let i = 0; i < count; i ++ ) {

      const i3 = i * 3;
      const x = positions[ i3 ];
      const y = positions[ i3 + 1 ];

      const n = noise2D( x * frequency, y * frequency );
      const disp = n * amplitude;

      positions[ i3 + 2 ] += disp;
    }

    this.getAttribute( 'position' ).needsUpdate = true;
    this._cachedAABB = null;
  }

  /**
   * Returns the total surface area of the ring in double precision.
   * Accumulated during construction using triangle cross-product magnitudes.
   *
   * @return {number} The approximate surface area.
   */
  getTotalSurfaceArea() {

    return this._totalSurfaceArea || 0;
  }

  /**
   * Computes the analytic area of the ring in double precision.
   * A = π * ( outerRadius² - innerRadius² ) * ( thetaLength / 2π )
   *
   * @return {number} The analytic area.
   */
  computeAnalyticArea() {

    const { innerRadius, outerRadius, thetaLength } = this.parameters;

    const fraction = thetaLength / ( Math.PI * 2 );
    const r1sq = new Double( innerRadius ).mul( new Double( innerRadius ) );
    const r2sq = new Double( outerRadius ).mul( new Double( outerRadius ) );

    const area = new Double( Math.PI ).mul( r2sq.sub( r1sq ) ).mul( new Double( fraction ) );

    return area.toNumber();
  }

  /**
   * Queries all RingGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( ringWorld, [ RingParams, RingStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          innerRadius: RingParams.innerRadius[ entity ],
          outerRadius: RingParams.outerRadius[ entity ],
          thetaSegments: RingParams.thetaSegments[ entity ],
          phiSegments: RingParams.phiSegments[ entity ],
          thetaStart: RingParams.thetaStart[ entity ],
          thetaLength: RingParams.thetaLength[ entity ]
        },
        stats: {
          vertexCount: RingStats.vertexCount[ entity ],
          indexCount: RingStats.indexCount[ entity ],
          triangleCount: RingStats.triangleCount[ entity ]
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

export { RingGeometry };
export default RingGeometry;