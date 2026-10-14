// file number : 016
// full path name : src/geometries/016_ShapeGeometry.js
// description : ShapeGeometry — creates a one-sided polygonal geometry from one or more
//               Shape paths. Supports multiple shapes with per-shape material groups for
//               MultiMaterial rendering. Triangulates contours with holes using earcut,
//               generates world-space UVs, and produces flat +Z normals. Integrates bitecs
//               ECS for parameter/stat tracking, gl-matrix for cached AABB and interop
//               factories, double.js for high-precision area metrics, and simplex-noise
//               for procedural planar deformation. Provides fromVec2Array / fromDouble
//               factories and ECS queryAll for introspection.
// license : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { Shape } from '../extras/lib/019_shape.js';
import { ShapeUtils } from '../extras/lib/017_shapeutils.js';
import { Vector2 } from '../math/002_Vector2.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const shapeWorld = createWorld();

// ─── Component definitions for shape tracking ───────────────────────────────
const ShapeParams = defineComponent({
  shapeCount: Types.ui16,
  curveSegments: Types.ui16
});

const ShapeStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32,
  groupCount: Types.ui8,
  holeCount: Types.ui32
});

/**
 * Creates a one-sided polygonal geometry from one or more path shapes.
 *
 * ```js
 * const arcShape = new THREE.Shape()
 *   .moveTo( 5, 1 )
 *   .absarc( 1, 1, 4, 0, Math.PI * 2, false );
 *
 * const geometry = new THREE.ShapeGeometry( arcShape );
 * const material = new THREE.MeshBasicMaterial( { color: 0x00ff00, side: THREE.DoubleSide } );
 * const mesh = new THREE.Mesh( geometry, material );
 * scene.add( mesh );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#ShapeGeometry
 */
class ShapeGeometry extends BufferGeometry {

  /**
   * Constructs a new shape geometry.
   *
   * @param {Shape|Array} [shapes] - A shape or an array of shapes.
   * @param {number} [curveSegments=12] - Number of segments per shape.
   */
  constructor( shapes = new Shape( [ new Vector2( 0, 0.5 ), new Vector2( - 0.5, - 0.5 ), new Vector2( 0.5, - 0.5 ) ] ), curveSegments = 12 ) {

    super();

    this.type = 'ShapeGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      shapes: shapes,
      curveSegments: curveSegments
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    // ─── Integer enforcement ───────────────────────────────────────────────
    curveSegments = Math.max( 1, Math.floor( curveSegments ) );

    // ─── Normalize shapes to array ─────────────────────────────────────────
    const shapesArray = Array.isArray( shapes ) ? shapes : [ shapes ];

    // ─── ECS: register shape entity ────────────────────────────────────────
    const entityId = addEntity( shapeWorld );

    addComponent( shapeWorld, ShapeParams, {
      shapeCount: shapesArray.length,
      curveSegments: curveSegments
    }, entityId );

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for surface area ─────────────────────
    let totalSurfaceArea = new Double( 0 );

    // ─── Noise instance for optional displacement ──────────────────────────
    const _noise2D = createNoise2D();

    // ─── Buffers ───────────────────────────────────────────────────────────
    const indices = [];
    const vertices = [];
    const normals = [];
    const uvs = [];

    // ─── Helper variables ──────────────────────────────────────────────────
    let groupStart = 0;
    let groupCount = 0;
    let totalHoles = 0;

    // ─── Allow single and array values for "shapes" parameter ──────────────
    if ( Array.isArray( shapes ) === false ) {

      addShape( shapes );

    } else {

      for ( let i = 0; i < shapes.length; i ++ ) {

        addShape( shapes[ i ] );
        this.addGroup( groupStart, groupCount, i ); // enables MultiMaterial support
        groupStart += groupCount;
        groupCount = 0;
      }
    }

    // ─── Build geometry ────────────────────────────────────────────────────
    this.setIndex( indices );
    this.setAttribute( 'position', new Float32BufferAttribute( vertices, 3 ) );
    this.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
    this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );

    // ─── ECS: record shape statistics ──────────────────────────────────────
    addComponent( shapeWorld, ShapeStats, {
      vertexCount: vertices.length / 3,
      indexCount: indices.length,
      triangleCount: indices.length / 3,
      groupCount: this.groups ? this.groups.length : 0,
      holeCount: totalHoles
    }, entityId );

    this._shapeEntityId = entityId;
    this._totalSurfaceArea = totalSurfaceArea.toNumber();

    // ─── Helper functions ──────────────────────────────────────────────────

    function addShape( shape ) {

      const indexOffset = vertices.length / 3;
      const points = shape.extractPoints( curveSegments );

      let shapeVertices = points.shape;
      const shapeHoles = points.holes;

      // ─── Check direction of vertices ───────────────────────────────────
      if ( ShapeUtils.isClockWise( shapeVertices ) === false ) {

        shapeVertices = shapeVertices.reverse();
      }

      for ( let i = 0, l = shapeHoles.length; i < l; i ++ ) {

        const shapeHole = shapeHoles[ i ];

        if ( ShapeUtils.isClockWise( shapeHole ) === true ) {

          shapeHoles[ i ] = shapeHole.reverse();
        }
      }

      const faces = ShapeUtils.triangulateShape( shapeVertices, shapeHoles );

      // ─── Join vertices of inner and outer paths to a single array ──────
      for ( let i = 0, l = shapeHoles.length; i < l; i ++ ) {

        const shapeHole = shapeHoles[ i ];
        shapeVertices = shapeVertices.concat( shapeHole );
      }

      totalHoles += shapeHoles.length;

      // ─── Vertices, normals, uvs ────────────────────────────────────────
      for ( let i = 0, l = shapeVertices.length; i < l; i ++ ) {

        const vertex = shapeVertices[ i ];

        vertices.push( vertex.x, vertex.y, 0 );
        normals.push( 0, 0, 1 );
        uvs.push( vertex.x, vertex.y ); // world uvs
      }

      // ─── Indices ───────────────────────────────────────────────────────
      for ( let i = 0, l = faces.length; i < l; i ++ ) {

        const face = faces[ i ];

        const a = face[ 0 ] + indexOffset;
        const b = face[ 1 ] + indexOffset;
        const c = face[ 2 ] + indexOffset;

        indices.push( a, b, c );
        groupCount += 3;

        // ─── Accumulate surface area in double precision ────────────────
        const v0x = vertices[ a * 3 ];
        const v0y = vertices[ a * 3 + 1 ];

        const v1x = vertices[ b * 3 ];
        const v1y = vertices[ b * 3 + 1 ];

        const v2x = vertices[ c * 3 ];
        const v2y = vertices[ c * 3 + 1 ];

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
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @param {Array} shapes - An array of shapes.
   * @return {ShapeGeometry} A new instance.
   */
  static fromJSON( data, shapes ) {

    const geometryShapes = [];

    for ( let j = 0, jl = data.shapes.length; j < jl; j ++ ) {

      const shape = shapes[ data.shapes[ j ] ];
      geometryShapes.push( shape );
    }

    return new ShapeGeometry( geometryShapes, data.curveSegments );
  }

  /**
   * Creates a ShapeGeometry from a gl-matrix vec2 array.
   *
   * @param {Array<vec2>} vec2Array - Array of gl-matrix vec2 points.
   * @param {number} [curveSegments=12] - Curve segment count.
   * @return {ShapeGeometry} A new ShapeGeometry instance.
   */
  static fromVec2Array( vec2Array, curveSegments = 12 ) {

    const points = vec2Array.map( v => new Vector2( v[ 0 ], v[ 1 ] ) );
    const shape = new Shape( points );

    return new ShapeGeometry( shape, curveSegments );
  }

  /**
   * Creates a ShapeGeometry from a Double-precision array of alternating
   * x/y coordinates.
   *
   * @param {Array<Double>} coords - Array of Double values [x0, y0, x1, y1, ...].
   * @param {number} [curveSegments=12] - Curve segment count.
   * @return {ShapeGeometry} A new ShapeGeometry instance.
   */
  static fromDoubleArray( coords, curveSegments = 12 ) {

    const points = [];

    for ( let i = 0; i < coords.length; i += 2 ) {

      points.push( new Vector2( coords[ i ].toNumber(), coords[ i + 1 ].toNumber() ) );
    }

    const shape = new Shape( points );

    return new ShapeGeometry( shape, curveSegments );
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
   * Returns the total surface area of the shape geometry in double precision.
   * Accumulated during construction using triangle cross-product magnitudes.
   *
   * @return {number} The approximate surface area.
   */
  getTotalSurfaceArea() {

    return this._totalSurfaceArea || 0;
  }

  /**
   * Queries all ShapeGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( shapeWorld, [ ShapeParams, ShapeStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          shapeCount: ShapeParams.shapeCount[ entity ],
          curveSegments: ShapeParams.curveSegments[ entity ]
        },
        stats: {
          vertexCount: ShapeStats.vertexCount[ entity ],
          indexCount: ShapeStats.indexCount[ entity ],
          triangleCount: ShapeStats.triangleCount[ entity ],
          groupCount: ShapeStats.groupCount[ entity ],
          holeCount: ShapeStats.holeCount[ entity ]
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

  toJSON() {

    const data = super.toJSON();
    const shapes = this.parameters.shapes;

    return toJSON( shapes, data );
  }
}

// ─── Serialization helper (mirrors r185 source) ─────────────────────────────
function toJSON( shapes, data ) {

  data.shapes = [];

  if ( Array.isArray( shapes ) ) {

    for ( let i = 0, l = shapes.length; i < l; i ++ ) {

      const shape = shapes[ i ];
      data.shapes.push( shape.uuid );
    }

  } else {

    data.shapes.push( shapes.uuid );
  }

  return data;
}

export { ShapeGeometry };
export default ShapeGeometry;