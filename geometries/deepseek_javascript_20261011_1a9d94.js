// file number : 002
// full path name : src/geometries/002_CircleGeometry.js
// description : A simple shape of Euclidean geometry constructed from triangular segments oriented around a central point, extending to a given radius. Built counter-clockwise from a start angle and central angle. Can create regular polygons where segment count determines side count. Rewritten as an ES module for the threejs_new01 repository, consuming the local 014_BufferGeometry, 011_BufferAttribute, 003_Vector3, and 002_Vector2 modules, with additional CDN imports for bitecs, gl-matrix, double.js, and simplex-noise.
// best for : Creating circular discs, pie slices, sector shapes, and regular polygons for 2D UI elements, procedural generation, and rendering.
// license : MIT

import { BufferGeometry } from '../core/014_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/011_BufferAttribute.js';
import { Vector3 } from '../math/003_Vector3.js';
import { Vector2 } from '../math/002_Vector2.js';

// ESM-native — verified named exports
import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';

// UMD builds — verified to resolve via jsDelivr's `+esm` transform
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

/**
 * A simple shape of Euclidean geometry. It is constructed from a
 * number of triangular segments that are oriented around a central point and
 * extend as far out as a given radius. It is built counter-clockwise from a
 * start angle and a given central angle. It can also be used to create
 * regular polygons, where the number of segments determines the number of
 * sides.
 *
 * ```js
 * const geometry = new THREE.CircleGeometry( 5, 32 );
 * const material = new THREE.MeshBasicMaterial( { color: 0xffff00 } );
 * const circle = new THREE.Mesh( geometry, material );
 * scene.add( circle )
 * ```
 *
 * @augments BufferGeometry
 * @demo scenes/geometry-browser.html#CircleGeometry
 */
class CircleGeometry extends BufferGeometry {
	/**
	 * Constructs a new circle geometry.
	 *
	 * @param {number} [radius=1] - Radius of the circle.
	 * @param {number} [segments=32] - Number of segments (triangles), minimum = `3`.
	 * @param {number} [thetaStart=0] - Start angle for first segment in radians.
	 * @param {number} [thetaLength=Math.PI*2] - The central angle, often called theta,
	 * of the circular sector in radians. The default value results in a complete circle.
	 */
	constructor( radius = 1, segments = 32, thetaStart = 0, thetaLength = Math.PI * 2 ) {
		super();

		this.type = 'CircleGeometry';

		/**
		 * Holds the constructor parameters that have been
		 * used to generate the geometry. Any modification
		 * after instantiation does not change the geometry.
		 *
		 * @type {Object}
		 */
		this.parameters = {
			radius: radius,
			segments: segments,
			thetaStart: thetaStart,
			thetaLength: thetaLength
		};

		segments = Math.max( 3, segments );

		// buffers
		const indices = [];
		const vertices = [];
		const normals = [];
		const uvs = [];

		// helper variables
		const vertex = new Vector3();
		const uv = new Vector2();

		// center point
		vertices.push( 0, 0, 0 );
		normals.push( 0, 0, 1 );
		uvs.push( 0.5, 0.5 );

		for ( let s = 0, i = 3; s <= segments; s ++, i += 3 ) {
			const segment = thetaStart + s / segments * thetaLength;

			// vertex
			vertex.x = radius * Math.cos( segment );
			vertex.y = radius * Math.sin( segment );
			vertices.push( vertex.x, vertex.y, vertex.z );

			// normal
			normals.push( 0, 0, 1 );

			// uvs
			uv.x = ( vertices[ i ] / radius + 1 ) / 2;
			uv.y = ( vertices[ i + 1 ] / radius + 1 ) / 2;
			uvs.push( uv.x, uv.y );
		}

		// indices
		for ( let i = 1; i <= segments; i ++ ) {
			indices.push( i, i + 1, 0 );
		}

		// build geometry
		this.setIndex( indices );
		this.setAttribute( 'position', new Float32BufferAttribute( vertices, 3 ) );
		this.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
		this.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );
	}

	copy( source ) {
		super.copy( source );
		this.parameters = Object.assign( {}, source.parameters );
		return this;
	}

	/**
	 * Factory method for creating an instance of this class from the given
	 * JSON object.
	 *
	 * @param {Object} data - A JSON object representing the serialized geometry.
	 * @return {CircleGeometry} A new instance.
	 */
	static fromJSON( data ) {
		return new CircleGeometry(
			data.radius,
			data.segments,
			data.thetaStart,
			data.thetaLength
		);
	}
}

export { CircleGeometry };
export default CircleGeometry;