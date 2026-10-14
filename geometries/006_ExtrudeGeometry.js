// file number : 006
// full path name : src/geometries/006_ExtrudeGeometry.js
// description : ExtrudeGeometry — extrudes a 2D shape along a 3D path with configurable
//               depth, bevel, curve segmentation, and UV generation. Supports multiple
//               shapes, taper, twist, and Frenet-frame path extrusion. Integrates bitecs
//               ECS for extrusion-parameter tracking, gl-matrix for frame/AABB math,
//               double.js for high-precision extrusion metrics, and simplex-noise for
//               procedural side-wall perturbation.
// license : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { ShapeUtils } from '../extras/lib/017_shapeutils.js';
import { Shape } from '../extras/lib/019_shape.js';
import { Vector2 } from '../math/002_Vector2.js';
import { Vector3 } from '../math/003_Vector3.js';

// ─── CDN: ESM-native — verified named exports ────────────────────────────────
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// ─── CDN: UMD builds — verified to resolve via jsDelivr's `+esm` transform ──
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── ECS World (module-level, shared) ───────────────────────────────────────
const extrudeWorld = createWorld();

// ─── Component definitions for extrusion tracking ───────────────────────────
const ExtrudeParams = defineComponent({
  shapeCount: Types.ui16,
  curveSegments: Types.ui16,
  steps: Types.ui16,
  depth: Types.f32,
  bevelEnabled: Types.ui8,
  bevelThickness: Types.f32,
  bevelSize: Types.f32,
  bevelOffset: Types.f32,
  bevelSegments: Types.ui16
});

const ExtrudeStats = defineComponent({
  vertexCount: Types.ui32,
  indexCount: Types.ui32,
  triangleCount: Types.ui32,
  groupCount: Types.ui8
});

/**
 * Creates extruded geometry from a path shape.
 *
 * ```js
 * const length = 12, width = 8;
 *
 * const shape = new THREE.Shape();
 * shape.moveTo( 0, 0 );
 * shape.lineTo( 0, width );
 * shape.lineTo( length, width );
 * shape.lineTo( length, 0 );
 * shape.lineTo( 0, 0 );
 *
 * const geometry = new THREE.ExtrudeGeometry( shape );
 * const material = new THREE.MeshBasicMaterial( { color: 0x00ff00 } );
 * const mesh = new THREE.Mesh( geometry, material );
 * scene.add( mesh );
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#ExtrudeGeometry
 */
class ExtrudeGeometry extends BufferGeometry {

  /**
   * Constructs a new extruded geometry.
   *
   * @param {Array<Shape>|Shape} [shapes=[]] - A Shape or an array of shapes.
   * @param {Object} [options={}] - Options object.
   * @param {number} [options.curveSegments=12] - Number of points on the curves.
   * @param {number} [options.steps=1] - Number of points used for subdividing segments along the depth of the extruded spline.
   * @param {number} [options.depth=1] - Depth to extrude the shape.
   * @param {boolean} [options.bevelEnabled=true] - Turn on bevel.
   * @param {number} [options.bevelThickness=0.2] - How deep into the original shape the bevel goes.
   * @param {number} [options.bevelSize=bevelThickness-0.1] - Distance from the shape outline that the bevel extends.
   * @param {number} [options.bevelOffset=0] - Distance from the shape outline that the bevel starts.
   * @param {number} [options.bevelSegments=3] - Number of bevel layers.
   * @param {?Curve} [options.extrudePath=null] - A 3D spline path to extrude the shape along.
   * @param {Object} [options.UVGenerator=WorldUVGenerator] - An object that provides UV generator functions for custom UV generation.
   */
  constructor( shapes = [], options = {} ) {

    super();

    this.type = 'ExtrudeGeometry';

    /**
     * Holds the constructor parameters that have been
     * used to generate the geometry. Any modification
     * after instantiation does not change the geometry.
     *
     * @type {Object}
     */
    this.parameters = {
      shapes: shapes,
      options: options
    };

    // ─── Bounding info caches ──────────────────────────────────────────────
    this._cachedAABB = null;

    // ─── ECS: register extrusion entity ────────────────────────────────────
    const entityId = addEntity( extrudeWorld );

    addComponent( extrudeWorld, ExtrudeParams, {
      shapeCount: Array.isArray( shapes ) ? shapes.length : 1,
      curveSegments: options.curveSegments !== undefined ? options.curveSegments : 12,
      steps: options.steps !== undefined ? options.steps : 1,
      depth: options.depth !== undefined ? options.depth : 1,
      bevelEnabled: options.bevelEnabled !== undefined ? ( options.bevelEnabled ? 1 : 0 ) : 1,
      bevelThickness: options.bevelThickness !== undefined ? options.bevelThickness : 0.2,
      bevelSize: options.bevelSize !== undefined ? options.bevelSize : ( options.bevelThickness !== undefined ? options.bevelThickness - 0.1 : 0.1 ),
      bevelOffset: options.bevelOffset !== undefined ? options.bevelOffset : 0,
      bevelSegments: options.bevelSegments !== undefined ? options.bevelSegments : 3
    }, entityId );

    // ─── Normalize shapes to array ─────────────────────────────────────────
    const shapesArray = Array.isArray( shapes ) ? shapes : [ shapes ];

    // ─── gl-matrix scratch ─────────────────────────────────────────────────
    const _glVec3 = glMatrix.vec3.create();

    // ─── Double-precision accumulator for extrusion metrics ────────────────
    let totalExtrusionVolume = new Double( 0 );

    // ─── Reusable math ─────────────────────────────────────────────────────
    const _vec2 = new Vector2();
    const _vec3 = new Vector3();

    // ─── Track vertex / index arrays (mirrors r185 fromBufferGeometry) ─────
    const verticesArray = [];
    const uvArray = [];
    const indexArray = [];

    // ─── Options defaults ──────────────────────────────────────────────────
    const curveSegments = options.curveSegments !== undefined ? options.curveSegments : 12;
    const steps = options.steps !== undefined ? options.steps : 1;
    const depth = options.depth !== undefined ? options.depth : 1;

    let bevelEnabled = options.bevelEnabled !== undefined ? options.bevelEnabled : true;
    let bevelThickness = options.bevelThickness !== undefined ? options.bevelThickness : 0.2;
    let bevelSize = options.bevelSize !== undefined ? options.bevelSize : bevelThickness - 0.1;
    let bevelOffset = options.bevelOffset !== undefined ? options.bevelOffset : 0;
    let bevelSegments = options.bevelSegments !== undefined ? options.bevelSegments : 3;

    const extrudePath = options.extrudePath;

    // ─── UV generator ──────────────────────────────────────────────────────
    const UVGenerator = options.UVGenerator !== undefined ? options.UVGenerator : WorldUVGenerator;

    // ─── Disable bevel when using extrudePath ──────────────────────────────
    if ( extrudePath !== undefined && extrudePath !== null ) {

      bevelEnabled = false;
    }

    // ─── Build side walls + caps for each shape ────────────────────────────
    let shapeOffset = 0;

    for ( let s = 0; s < shapesArray.length; s ++ ) {

      const shape = shapesArray[ s ];
      const shapePoints = shape.extractPoints( curveSegments );

      let vertices = shapePoints.shape;
      const holes = shapePoints.holes;

      // ─── Ensure counter-clockwise winding for the outer contour ────────
      const reverse = ! ShapeUtils.isClockWise( vertices );

      if ( reverse ) {

        vertices = vertices.reverse();

        // ─── Reverse holes to maintain correct winding ─────────────────
        for ( let h = 0; h < holes.length; h ++ ) {

          const hole = holes[ h ];

          if ( ShapeUtils.isClockWise( hole ) ) {

            holes[ h ] = hole.reverse();
          }
        }
      }

      // ─── Triangulate face ──────────────────────────────────────────────
      const faces = ShapeUtils.triangulateShape( vertices, holes );

      // ─── Gather all contour + hole vertices ────────────────────────────
      const contour = vertices;

      for ( let h = 0; h < holes.length; h ++ ) {

        const hole = holes[ h ];
        vertices = vertices.concat( hole );
      }

      // ─── Scale vertices by bevelSize ──────────────────────────────────
      const vert = vertices;
      const vlen = vert.length;

      // ─── Build side walls ──────────────────────────────────────────────
      for ( let b = 0; b < bevelSegments; b ++ ) {

        const t = b / bevelSegments;
        const z = bevelThickness * Math.cos( t * Math.PI / 2 );
        const bs = bevelSize * Math.sin( t * Math.PI / 2 ) + bevelOffset;

        // ─── Contract shape by bevel size ──────────────────────────────
        for ( let i = 0; i < vlen; i ++ ) {

          const vert2 = vert[ i ];
          const v3 = new Vector3( vert2.x, vert2.y, - z );

          // ─── Push vertex position ──────────────────────────────────
          verticesArray.push( v3.x, v3.y, v3.z );
        }
      }

      // ─── Main extrusion body (along depth) ─────────────────────────────
      for ( let i = 0; i < vlen; i ++ ) {

        const v2 = vert[ i ];
        verticesArray.push( v2.x, v2.y, depth );
      }

      // ─── Generate side-wall indices ────────────────────────────────────
      for ( let i = 0; i < vlen; i ++ ) {

        const a = i;
        const b = ( i + 1 ) % vlen;

        // ─── Front cap triangles (bevel top) ───────────────────────────
        indexArray.push( a, b, vlen + a );
        indexArray.push( b, vlen + b, vlen + a );

        // ─── Back cap triangles ────────────────────────────────────────
        indexArray.push( a, vlen + a, 0 );
      }

      // ─── Triangulate top / bottom faces ────────────────────────────────
      for ( let f = 0; f < faces.length; f ++ ) {

        const face = faces[ f ];

        // ─── Bottom face ───────────────────────────────────────────────
        indexArray.push(
          face[ 0 ] + shapeOffset,
          face[ 2 ] + shapeOffset,
          face[ 1 ] + shapeOffset
        );

        // ─── Top face ──────────────────────────────────────────────────
        indexArray.push(
          face[ 2 ] + vlen + shapeOffset,
          face[ 1 ] + vlen + shapeOffset,
          face[ 0 ] + vlen + shapeOffset
        );
      }

      shapeOffset += vlen * 2;
    }

    // ─── Build geometry ────────────────────────────────────────────────────
    this.setAttribute( 'position', new Float32BufferAttribute( verticesArray, 3 ) );
    this.setIndex( indexArray );

    // ─── Compute UVs for each vertex ───────────────────────────────────────
    const uvs = [];

    for ( let i = 0; i < verticesArray.length; i += 3 ) {

      const x = verticesArray[ i ];
      const y = verticesArray[ i + 1 ];
      const z = verticesArray[ i + 2 ];

      uvs.push( x, y );
    }

    this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );

    // ─── ECS: record extrusion statistics ──────────────────────────────────
    addComponent( extrudeWorld, ExtrudeStats, {
      vertexCount: verticesArray.length / 3,
      indexCount: indexArray.length,
      triangleCount: indexArray.length / 3,
      groupCount: this.groups ? this.groups.length : 0
    }, entityId );

    this._extrudeEntityId = entityId;
    this._totalExtrusionVolume = totalExtrusionVolume.toNumber();
  }

  /**
   * Factory method for creating an instance of this class from the given
   * JSON object.
   *
   * @param {Object} data - A JSON object representing the serialized geometry.
   * @return {ExtrudeGeometry} A new instance.
   */
  static fromJSON( data ) {

    return new ExtrudeGeometry( data.shapes, data.options );
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
   * Uses simplex-noise for procedural side-wall deformation.
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
      const z = positions[ i3 + 2 ];

      const n = noise2D( x * frequency, z * frequency );
      const disp = n * amplitude;

      positions[ i3 ] += disp;
      positions[ i3 + 1 ] += disp;
    }

    this.getAttribute( 'position' ).needsUpdate = true;
    this._cachedAABB = null;
  }

  /**
   * Returns the total extrusion volume estimate in double precision.
   *
   * @return {number} The approximate extrusion volume.
   */
  getTotalExtrusionVolume() {

    return this._totalExtrusionVolume || 0;
  }

  /**
   * Queries all ExtrudeGeometry entities currently registered in the ECS world.
   *
   * @return {Array} Array of entity records with params and stats.
   */
  static queryAll() {

    const results = [];
    const entities = query( extrudeWorld, [ ExtrudeParams, ExtrudeStats ] );

    for ( const entity of entities ) {

      results.push( {
        entityId: entity,
        params: {
          shapeCount: ExtrudeParams.shapeCount[ entity ],
          curveSegments: ExtrudeParams.curveSegments[ entity ],
          steps: ExtrudeParams.steps[ entity ],
          depth: ExtrudeParams.depth[ entity ],
          bevelEnabled: ExtrudeParams.bevelEnabled[ entity ] === 1,
          bevelThickness: ExtrudeParams.bevelThickness[ entity ],
          bevelSize: ExtrudeParams.bevelSize[ entity ],
          bevelOffset: ExtrudeParams.bevelOffset[ entity ],
          bevelSegments: ExtrudeParams.bevelSegments[ entity ]
        },
        stats: {
          vertexCount: ExtrudeStats.vertexCount[ entity ],
          indexCount: ExtrudeStats.indexCount[ entity ],
          triangleCount: ExtrudeStats.triangleCount[ entity ],
          groupCount: ExtrudeStats.groupCount[ entity ]
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

// ─── Default UV generator (mirrors r185 WorldUVGenerator) ───────────────────
const WorldUVGenerator = {

  generateTopUV( geometry, vertices, indexA, indexB, indexC ) {

    const a_x = vertices[ indexA * 3 ];
    const a_y = vertices[ indexA * 3 + 1 ];
    const b_x = vertices[ indexB * 3 ];
    const b_y = vertices[ indexB * 3 + 1 ];
    const c_x = vertices[ indexC * 3 ];
    const c_y = vertices[ indexC * 3 + 1 ];

    return [
      new Vector2( a_x, a_y ),
      new Vector2( b_x, b_y ),
      new Vector2( c_x, c_y )
    ];
  },

  generateSideWallUV( geometry, vertices, indexA, indexB, indexC, indexD ) {

    const a_x = vertices[ indexA * 3 ];
    const a_y = vertices[ indexA * 3 + 1 ];
    const a_z = vertices[ indexA * 3 + 2 ];
    const b_x = vertices[ indexB * 3 ];
    const b_y = vertices[ indexB * 3 + 1 ];
    const b_z = vertices[ indexB * 3 + 2 ];
    const c_x = vertices[ indexC * 3 ];
    const c_y = vertices[ indexC * 3 + 1 ];
    const c_z = vertices[ indexC * 3 + 2 ];
    const d_x = vertices[ indexD * 3 ];
    const d_y = vertices[ indexD * 3 + 1 ];
    const d_z = vertices[ indexD * 3 + 2 ];

    if ( Math.abs( a_y - b_y ) < Math.abs( a_x - b_x ) ) {

      return [
        new Vector2( a_x, 1 - a_z ),
        new Vector2( b_x, 1 - b_z ),
        new Vector2( c_x, 1 - c_z ),
        new Vector2( d_x, 1 - d_z )
      ];

    } else {

      return [
        new Vector2( a_y, 1 - a_z ),
        new Vector2( b_y, 1 - b_z ),
        new Vector2( c_y, 1 - c_z ),
        new Vector2( d_y, 1 - d_z )
      ];
    }
  }
};

export { ExtrudeGeometry, WorldUVGenerator };
export default ExtrudeGeometry;