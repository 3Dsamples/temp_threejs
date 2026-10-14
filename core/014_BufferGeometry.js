// file number : 014
// full path name : src/core/014_BufferGeometry.js
// description : A representation of mesh, line, or point geometry. Stores vertex positions, indices, normals, colors, UVs, and custom attributes within typed arrays, reducing the cost of passing data to the GPU. Rewritten as an ES module; extends the local 001_EventDispatcher and consumes 002_Vector2, 003_Vector3, 006_Matrix3, 007_Matrix4, 011_Sphere, 012_Box3, and 016_Vector4 from the threejsbitecs/math folder. Bridges to 001_MathUtils for generateUUID and scalar helpers, gl-matrix for packing the geometry header (attributeCount, indexCount, groupCount, version) into a vec4, double.js for high-precision vertex/triangle byte tracking, bitecs for SoA geometry registration, and simplex-noise for procedural vertex-noise generation. All non-math three.js r185 imports (BufferAttribute, Float32BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute, Object3D, utils) are imported explicitly so the module remains self-contained. Corrected import paths and a single default export.
// best for : The base geometry class for all renderable shapes (BoxGeometry, SphereGeometry, PlaneGeometry, etc.). Directly consumed by Mesh, Line, Points, and all renderer backends.
// license : MIT

import EventDispatcher from './001_EventDispatcher.js';
import MathUtils from '../math/001_MathUtils.js';
import Vector2 from '../math/002_Vector2.js';
import Vector3 from '../math/003_Vector3.js';
import Matrix3 from '../math/006_Matrix3.js';
import Matrix4 from '../math/007_Matrix4.js';
import Sphere from '../math/011_Sphere.js';
import Box3 from '../math/012_Box3.js';
import Vector4 from '../math/016_Vector4.js';

import { BufferAttribute, Float32BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute } from 'https://cdn.jsdelivr.net/npm/three@0.185.0/src/core/BufferAttribute.js';
import { Object3D } from 'https://cdn.jsdelivr.net/npm/three@0.185.0/src/core/Object3D.js';
import { arrayNeedsUint32, warn, error } from 'https://cdn.jsdelivr.net/npm/three@0.185.0/src/utils.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );

// ── Module-private scratch objects (mirrors r185 source) ────────────────────
const _m1 = new Matrix4();
const _obj = new Object3D();
const _offset = new Vector3();
const _box = new Box3();
const _boxMorphTargets = new Box3();
const _vector = new Vector3();

let _id = 0;

const BufferGeometryUtils = {

    // 001_MathUtils bridge: generate a UUID for the geometry.
    generateUUID: () => MathUtils.generateUUID(),

    // 001_MathUtils bridge: clamp an attribute count to a safe non-negative integer.
    clampAttributeCount: ( value ) => MathUtils.clamp( Math.floor( value ), 0, Infinity ),

    // gl-matrix bridge: pack the geometry header (attributeCount, indexCount, groupCount, version) into a vec4.
    packHeaderVec4: ( out, attributeCount, indexCount, groupCount, version ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set( out || _scratchVec4, attributeCount, indexCount, groupCount, version );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // bitecs bridge: register a BufferGeometry as a SoA component column set.
    registerComponent: ( name, count ) => {

        const attributeCountColumn = new Uint32Array( count );
        const indexCountColumn = new Uint32Array( count );
        const groupCountColumn = new Uint32Array( count );
        const versionColumn = new Uint32Array( count );
        return { name, attributeCountColumn, indexCountColumn, groupCountColumn, versionColumn, count };

    },

    // double.js bridge: high-precision total vertex bytes (vertexCount * itemSize * bytesPerElement).
    totalVertexBytes: ( vertexCount, itemSize, bytesPerElement = 4 ) => {

        const c = new Double( vertexCount );
        const i = new Double( itemSize );
        const b = new Double( bytesPerElement );
        return c.mul( i ).mul( b ).valueOf();

    },

    // double.js bridge: high-precision total triangle count (indexCount / 3).
    totalTriangles: ( indexCount ) => {

        const c = new Double( indexCount );
        return c.div( 3 ).valueOf();

    },

    // simplex-noise bridge: fill a position attribute array with procedural 3D noise.
    fillWithNoise: ( out, vertexCount, itemSize, scale = 0.1, seed = 0 ) => {

        let i = 0;
        for ( let v = 0; v < vertexCount; v ++ ) {

            for ( let c = 0; c < itemSize; c ++ ) {

                out[ i ++ ] = _noise3D( v * scale + seed, c * scale + seed, seed );

            }

        }
        return out;

    },

    // simplex-noise bridge: displace existing positions along the normal by noise.
    displaceByNoise: ( positions, normals, vertexCount, amplitude = 0.1, scale = 0.1, seed = 0 ) => {

        for ( let i = 0; i < vertexCount; i ++ ) {

            const ix = i * 3;
            const n = _noise3D(
                positions[ ix ] * scale + seed,
                positions[ ix + 1 ] * scale + seed,
                positions[ ix + 2 ] * scale + seed
            );
            positions[ ix ] += normals[ ix ] * n * amplitude;
            positions[ ix + 1 ] += normals[ ix + 1 ] * n * amplitude;
            positions[ ix + 2 ] += normals[ ix + 2 ] * n * amplitude;

        }
        return positions;

    },

    // simplex-noise bridge: procedural noise for geometry utilities.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class BufferGeometry extends EventDispatcher {

    constructor() {

        super();

        this.isBufferGeometry = true;

        Object.defineProperty( this, 'id', { value: _id ++ } );

        this.uuid = BufferGeometryUtils.generateUUID();

        this.name = '';
        this.type = 'BufferGeometry';

        this.index = null;
        this.indirect = null;
        this.indirectOffset = 0;

        this.attributes = {};
        this.morphAttributes = {};
        this.morphTargetsRelative = false;

        this.groups = [];

        this.boundingBox = null;
        this.boundingSphere = null;

        this.drawRange = { start: 0, count: Infinity };

        this.userData = {};

        this._transformed = false;

    }

    getIndex() {

        return this.index;

    }

    setIndex( index ) {

        if ( Array.isArray( index ) ) {

            this.index = new ( arrayNeedsUint32( index ) ? Uint32BufferAttribute : Uint16BufferAttribute )( index, 1 );

        } else {

            this.index = index;

        }

        return this;

    }

    setIndirect( indirect, indirectOffset = 0 ) {

        this.indirect = indirect;
        this.indirectOffset = indirectOffset;
        return this;

    }

    getIndirect() {

        return this.indirect;

    }

    getAttribute( name ) {

        return this.attributes[ name ];

    }

    setAttribute( name, attribute ) {

        this.attributes[ name ] = attribute;
        return this;

    }

    deleteAttribute( name ) {

        delete this.attributes[ name ];
        return this;

    }

    hasAttribute( name ) {

        return this.attributes[ name ] !== undefined;

    }

    addGroup( start, count, materialIndex = 0 ) {

        this.groups.push( { start, count, materialIndex } );

    }

    clearGroups() {

        this.groups = [];

    }

    setDrawRange( start, count ) {

        this.drawRange.start = start;
        this.drawRange.count = count;

    }

    applyMatrix4( matrix ) {

        const position = this.attributes.position;

        if ( position !== undefined ) {

            position.applyMatrix4( matrix );
            position.needsUpdate = true;

        }

        const normal = this.attributes.normal;

        if ( normal !== undefined ) {

            const normalMatrix = new Matrix3().getNormalMatrix( matrix );
            normal.applyNormalMatrix( normalMatrix );
            normal.needsUpdate = true;

        }

        const tangent = this.attributes.tangent;

        if ( tangent !== undefined ) {

            tangent.transformDirection( matrix );
            tangent.needsUpdate = true;

        }

        if ( this.boundingBox !== null ) {

            this.computeBoundingBox();

        }

        if ( this.boundingSphere !== null ) {

            this.computeBoundingSphere();

        }

        this._transformed = true;

        return this;

    }

    applyQuaternion( q ) {

        _m1.makeRotationFromQuaternion( q );
        this.applyMatrix4( _m1 );

        return this;

    }

    rotateX( angle ) {

        _m1.makeRotationX( angle );
        this.applyMatrix4( _m1 );

        return this;

    }

    rotateY( angle ) {

        _m1.makeRotationY( angle );
        this.applyMatrix4( _m1 );

        return this;

    }

    rotateZ( angle ) {

        _m1.makeRotationZ( angle );
        this.applyMatrix4( _m1 );

        return this;

    }

    translate( x, y, z ) {

        _m1.makeTranslation( x, y, z );
        this.applyMatrix4( _m1 );

        return this;

    }

    scale( x, y, z ) {

        _m1.makeScale( x, y, z );
        this.applyMatrix4( _m1 );

        return this;

    }

    lookAt( vector ) {

        _obj.lookAt( vector );
        _obj.updateMatrix();
        this.applyMatrix4( _obj.matrix );

    }

    center() {

        this.computeBoundingBox();
        this.boundingBox.getCenter( _offset ).negate();
        this.translate( _offset.x, _offset.y, _offset.z );

        return this;

    }

    setFromPoints( points ) {

        const position = [];

        for ( let i = 0, l = points.length; i < l; i ++ ) {

            const point = points[ i ];
            position.push( point.x, point.y, point.z || 0 );

        }

        this.setAttribute( 'position', new Float32BufferAttribute( position, 3 ) );

        return this;

    }

    computeBoundingBox() {

        if ( this.boundingBox === null ) {

            this.boundingBox = new Box3();

        }

        const position = this.attributes.position;
        const morphAttributesPosition = this.morphAttributes.position;

        if ( position && position.isGLBufferAttribute ) {

            error( 'BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box.', this );
            this.boundingBox.set(
                new Vector3( - Infinity, - Infinity, - Infinity ),
                new Vector3( + Infinity, + Infinity, + Infinity )
            );

            return;

        }

        if ( position !== undefined ) {

            this.boundingBox.setFromBufferAttribute( position );

            if ( morphAttributesPosition ) {

                for ( let i = 0, il = morphAttributesPosition.length; i < il; i ++ ) {

                    const morphAttribute = morphAttributesPosition[ i ];
                    _box.setFromBufferAttribute( morphAttribute );

                    if ( this.morphTargetsRelative ) {

                        _vector.addVectors( this.boundingBox.min, _box.min );
                        this.boundingBox.expandByPoint( _vector );

                        _vector.addVectors( this.boundingBox.max, _box.max );
                        this.boundingBox.expandByPoint( _vector );

                    } else {

                        this.boundingBox.expandByPoint( _box.min );
                        this.boundingBox.expandByPoint( _box.max );

                    }

                }

            }

        } else {

            this.boundingBox.makeEmpty();

        }

        if ( isNaN( this.boundingBox.min.x ) || isNaN( this.boundingBox.min.y ) || isNaN( this.boundingBox.min.z ) ) {

            error( 'BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.', this );

        }

    }

    computeBoundingSphere() {

        if ( this.boundingSphere === null ) {

            this.boundingSphere = new Sphere();

        }

        const position = this.attributes.position;
        const morphAttributesPosition = this.morphAttributes.position;

        if ( position && position.isGLBufferAttribute ) {

            error( 'BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere.', this );
            this.boundingSphere.set( new Vector3(), Infinity );

            return;

        }

        if ( position ) {

            // first, find the center of the bounding sphere
            const center = this.boundingSphere.center;

            _box.setFromBufferAttribute( position );

            if ( morphAttributesPosition ) {

                for ( let i = 0, il = morphAttributesPosition.length; i < il; i ++ ) {

                    const morphAttribute = morphAttributesPosition[ i ];
                    _boxMorphTargets.setFromBufferAttribute( morphAttribute );

                    if ( this.morphTargetsRelative ) {

                        _vector.addVectors( _box.min, _boxMorphTargets.min );
                        _box.expandByPoint( _vector );

                        _vector.addVectors( _box.max, _boxMorphTargets.max );
                        _box.expandByPoint( _vector );

                    } else {

                        _box.expandByPoint( _boxMorphTargets.min );
                        _box.expandByPoint( _boxMorphTargets.max );

                    }

                }

            }

            _box.getCenter( center );

            // second, try to find a boundingSphere with a radius smaller than the
            // boundingSphere of the boundingBox: sqrt(3) smaller in the best case

            let maxRadiusSq = 0;

            for ( let i = 0, il = position.count; i < il; i ++ ) {

                _vector.fromBufferAttribute( position, i );
                maxRadiusSq = Math.max( maxRadiusSq, center.distanceToSquared( _vector ) );

            }

            if ( morphAttributesPosition ) {

                for ( let i = 0, il = morphAttributesPosition.length; i < il; i ++ ) {

                    const morphAttribute = morphAttributesPosition[ i ];
                    const morphTargetsRelative = this.morphTargetsRelative;

                    for ( let j = 0, jl = morphAttribute.count; j < jl; j ++ ) {

                        _vector.fromBufferAttribute( morphAttribute, j );

                        if ( morphTargetsRelative ) {

                            _offset.fromBufferAttribute( position, j );
                            _vector.add( _offset );

                        }

                        maxRadiusSq = Math.max( maxRadiusSq, center.distanceToSquared( _vector ) );

                    }

                }

            }

            this.boundingSphere.radius = Math.sqrt( maxRadiusSq );

            if ( isNaN( this.boundingSphere.radius ) ) {

                error( 'BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.', this );

            }

        }

    }

    computeTangents() {

        const index = this.index;
        const attributes = this.attributes;

        // based on http://www.terathon.com/code/tangent.html
        // (per vertex tangents)

        if (
            index === null ||
            attributes.position === undefined ||
            attributes.normal === undefined ||
            attributes.uv === undefined
        ) {

            error( 'BufferGeometry: computeTangents() requires an index, position, normal and uv attribute.' );
            return;

        }

        const indexArray = index.array;
        const positionAttribute = attributes.position;
        const normalAttribute = attributes.normal;
        const uvAttribute = attributes.uv;

        // check if all attributes have same count
        if ( positionAttribute.count !== normalAttribute.count || positionAttribute.count !== uvAttribute.count ) {

            error( 'BufferGeometry: computeTangents() attribute count mismatch.' );
            return;

        }

        const tangentAttribute = new BufferAttribute( new Float32Array( positionAttribute.count * 4 ), 4 );

        // we iterate over the triangles and compute the tangent per triangle
        for ( let i = 0; i < indexArray.length; i += 3 ) {

            const i0 = indexArray[ i + 0 ];
            const i1 = indexArray[ i + 1 ];
            const i2 = indexArray[ i + 2 ];

            const vA = new Vector3();
            const vB = new Vector3();
            const vC = new Vector3();

            vA.fromBufferAttribute( positionAttribute, i0 );
            vB.fromBufferAttribute( positionAttribute, i1 );
            vC.fromBufferAttribute( positionAttribute, i2 );

            const uvA = new Vector2();
            const uvB = new Vector2();
            const uvC = new Vector2();

            uvA.fromBufferAttribute( uvAttribute, i0 );
            uvB.fromBufferAttribute( uvAttribute, i1 );
            uvC.fromBufferAttribute( uvAttribute, i2 );

            const edge1 = new Vector3().subVectors( vB, vA );
            const edge2 = new Vector3().subVectors( vC, vA );

            const uv1 = new Vector2().subVectors( uvB, uvA );
            const uv2 = new Vector2().subVectors( uvC, uvA );

            const r = 1.0 / ( uv1.x * uv2.y - uv1.y * uv2.x );

            if ( r === Infinity || r === - Infinity ) continue;

            const tangent = new Vector3(
                ( edge1.x * uv2.y - edge2.x * uv1.y ) * r,
                ( edge1.y * uv2.y - edge2.y * uv1.y ) * r,
                ( edge1.z * uv2.y - edge2.z * uv1.y ) * r,
            ).normalize();

            tangentAttribute.setXYZ( i0, tangent.x, tangent.y, tangent.z );
            tangentAttribute.setXYZ( i1, tangent.x, tangent.y, tangent.z );
            tangentAttribute.setXYZ( i2, tangent.x, tangent.y, tangent.z );

        }

        this.setAttribute( 'tangent', tangentAttribute );

    }

    computeVertexNormals() {

        const index = this.index;
        const positionAttribute = this.getAttribute( 'position' );

        if ( positionAttribute !== undefined ) {

            let normalAttribute = this.getAttribute( 'normal' );

            if ( normalAttribute === undefined ) {

                normalAttribute = new BufferAttribute( new Float32Array( positionAttribute.count * 3 ), 3 );
                this.setAttribute( 'normal', normalAttribute );

            } else {

                // reset existing normals to zero
                for ( let i = 0, il = normalAttribute.count; i < il; i ++ ) {

                    normalAttribute.setXYZ( i, 0, 0, 0 );

                }

            }

            const pA = new Vector3();
            const pB = new Vector3();
            const pC = new Vector3();
            const nA = new Vector3();
            const nB = new Vector3();
            const nC = new Vector3();

            // indexed elements
            if ( index ) {

                for ( let i = 0, il = index.count; i < il; i += 3 ) {

                    const vA = index.getX( i + 0 );
                    const vB = index.getX( i + 1 );
                    const vC = index.getX( i + 2 );

                    pA.fromBufferAttribute( positionAttribute, vA );
                    pB.fromBufferAttribute( positionAttribute, vB );
                    pC.fromBufferAttribute( positionAttribute, vC );

                    nA.subVectors( pC, pB );
                    nB.subVectors( pA, pC );
                    nC.subVectors( pB, pA );

                    normalAttribute.setXYZ( vA,
                        normalAttribute.getX( vA ) + nA.x,
                        normalAttribute.getY( vA ) + nA.y,
                        normalAttribute.getZ( vA ) + nA.z
                    );
                    normalAttribute.setXYZ( vB,
                        normalAttribute.getX( vB ) + nB.x,
                        normalAttribute.getY( vB ) + nB.y,
                        normalAttribute.getZ( vB ) + nB.z
                    );
                    normalAttribute.setXYZ( vC,
                        normalAttribute.getX( vC ) + nC.x,
                        normalAttribute.getY( vC ) + nC.y,
                        normalAttribute.getZ( vC ) + nC.z
                    );

                }

            } else {

                // non-indexed elements (unconnected triangle soup)

                for ( let i = 0, il = positionAttribute.count; i < il; i += 3 ) {

                    pA.fromBufferAttribute( positionAttribute, i + 0 );
                    pB.fromBufferAttribute( positionAttribute, i + 1 );
                    pC.fromBufferAttribute( positionAttribute, i + 2 );

                    nA.subVectors( pC, pB );
                    nB.subVectors( pA, pC );
                    nC.subVectors( pB, pA );

                    normalAttribute.setXYZ( i + 0, nA.x, nA.y, nA.z );
                    normalAttribute.setXYZ( i + 1, nB.x, nB.y, nB.z );
                    normalAttribute.setXYZ( i + 2, nC.x, nC.y, nC.z );

                }

            }

            this.normalizeNormals();

            normalAttribute.needsUpdate = true;

        }

    }

    normalizeNormals() {

        const normals = this.attributes.normal;

        for ( let i = 0, il = normals.count; i < il; i ++ ) {

            _vector.fromBufferAttribute( normals, i );
            _vector.normalize();
            normals.setXYZ( i, _vector.x, _vector.y, _vector.z );

        }

    }

    toNonIndexed() {

        function convertBufferAttribute( attribute, indices ) {

            const array = attribute.array;
            const itemSize = attribute.itemSize;
            const normalized = attribute.normalized;

            const array2 = new array.constructor( convertBufferAttributeToArray( indices, itemSize, array ) );
            const attribute2 = new BufferAttribute( array2, itemSize, normalized );

            return attribute2;

        }

        function convertBufferAttributeToArray( indices, itemSize, array ) {

            const out = new Float32Array( indices.length * itemSize );
            let offset = 0;

            for ( let i = 0; i < indices.length; i ++ ) {

                const index = indices[ i ] * itemSize;

                for ( let j = 0; j < itemSize; j ++ ) {

                    out[ offset ++ ] = array[ index + j ];

                }

            }

            return out;

        }

        if ( this.index === null ) {

            warn( 'THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed.' );
            return this;

        }

        const geometry2 = new BufferGeometry();

        const indices = this.index.array;
        const attributes = this.attributes;

        // attributes

        for ( const name in attributes ) {

            const attribute = attributes[ name ];

            const newAttribute = convertBufferAttribute( attribute, indices );

            geometry2.setAttribute( name, newAttribute );

        }

        // morph attributes

        const morphAttributes = this.morphAttributes;

        for ( const name in morphAttributes ) {

            const morphArray = [];
            const morphAttribute = morphAttributes[ name ];

            for ( let i = 0, il = morphAttribute.length; i < il; i ++ ) {

                const attribute = morphAttribute[ i ];

                const newAttribute = convertBufferAttribute( attribute, indices );

                morphArray.push( newAttribute );

            }

            geometry2.morphAttributes[ name ] = morphArray;

        }

        geometry2.morphTargetsRelative = this.morphTargetsRelative;

        // groups

        const groups = this.groups;

        for ( let i = 0, l = groups.length; i < l; i ++ ) {

            const group = groups[ i ];
            geometry2.addGroup( group.start, group.count, group.materialIndex );

        }

        return geometry2;

    }

    toJSON() {

        const data = {
            metadata: {
                version: 4.7,
                type: 'BufferGeometry',
                generator: 'BufferGeometry.toJSON'
            }
        };

        data.uuid = this.uuid;
        data.type = this.type;

        if ( this.name !== '' ) data.name = this.name;

        if ( Object.keys( this.userData ).length > 0 ) data.userData = this.userData;

        if ( this.parameters !== undefined ) {

            const parameters = this.parameters;

            for ( const key in parameters ) {

                if ( parameters[ key ] !== undefined ) data[ key ] = parameters[ key ];

            }

            return data;

        }

        // optimized to avoid cloning if there's only one attribute per name

        data.data = { attributes: {} };

        const index = this.index;

        if ( index !== null ) {

            data.data.index = {
                type: index.array.constructor.name,
                array: Array.prototype.slice.call( index.array )
            };

        }

        const attributes = this.attributes;

        for ( const key in attributes ) {

            const attribute = attributes[ key ];

            const attributeData = attribute.toJSON( data.data );

            data.data.attributes[ key ] = attributeData;

        }

        const morphAttributes = [];
        let hasMorphAttributes = false;

        for ( const key in this.morphAttributes ) {

            const attributeArray = this.morphAttributes[ key ];

            const array = [];

            for ( let i = 0, il = attributeArray.length; i < il; i ++ ) {

                const attribute = attributeArray[ i ];

                const attributeData = attribute.toJSON( data.data );

                array.push( attributeData );

            }

            if ( array.length > 0 ) {

                morphAttributes.push( {
                    name: key,
                    array: array
                } );

                hasMorphAttributes = true;

            }

        }

        if ( hasMorphAttributes ) {

            data.data.morphAttributes = morphAttributes;
            data.data.morphTargetsRelative = this.morphTargetsRelative;

        }

        const groups = this.groups;

        if ( groups.length > 0 ) {

            data.data.groups = JSON.parse( JSON.stringify( groups ) );

        }

        const boundingSphere = this.boundingSphere;

        if ( boundingSphere !== null ) {

            data.data.boundingSphere = {
                center: boundingSphere.center.toArray(),
                radius: boundingSphere.radius
            };

        }

        return data;

    }

    clone() {

        return new this.constructor().copy( this );

    }

    copy( source ) {

        // reset

        this.index = null;
        this.attributes = {};
        this.morphAttributes = {};
        this.groups = [];
        this.boundingBox = null;
        this.boundingSphere = null;

        // name

        this.name = source.name;

        // index

        const index = source.index;

        if ( index !== null ) {

            this.setIndex( index.clone() );

        }

        // attributes

        const attributes = source.attributes;

        for ( const name in attributes ) {

            const attribute = attributes[ name ];
            this.setAttribute( name, attribute.clone() );

        }

        // morph attributes

        const morphAttributes = source.morphAttributes;

        for ( const name in morphAttributes ) {

            const array = [];
            const morphAttribute = morphAttributes[ name ];

            for ( let i = 0, l = morphAttribute.length; i < l; i ++ ) {

                array.push( morphAttribute[ i ].clone() );

            }

            this.morphAttributes[ name ] = array;

        }

        this.morphTargetsRelative = source.morphTargetsRelative;

        // groups

        const groups = source.groups;

        for ( let i = 0, l = groups.length; i < l; i ++ ) {

            const group = groups[ i ];
            this.addGroup( group.start, group.count, group.materialIndex );

        }

        // bounding box

        const boundingBox = source.boundingBox;

        if ( boundingBox !== null ) {

            this.boundingBox = boundingBox.clone();

        }

        // bounding sphere

        const boundingSphere = source.boundingSphere;

        if ( boundingSphere !== null ) {

            this.boundingSphere = boundingSphere.clone();

        }

        // draw range

        this.drawRange.start = source.drawRange.start;
        this.drawRange.count = source.drawRange.count;

        // user data

        this.userData = source.userData;

        // geometry generator parameters

        if ( source.parameters !== undefined ) this.parameters = Object.assign( {}, source.parameters );

        return this;

    }

    dispose() {

        this.dispatchEvent( { type: 'dispose' } );

    }

    // Convenience accessors backed by the utility surface above.
    packHeaderToVec4( out ) {

        return BufferGeometryUtils.packHeaderVec4(
            out,
            Object.keys( this.attributes ).length,
            this.index ? this.index.count : 0,
            this.groups.length,
            this._version || 0
        );

    }

    getTotalVertexBytes( name, bytesPerElement = 4 ) {

        const attr = this.attributes[ name ];
        if ( ! attr ) return 0;
        return BufferGeometryUtils.totalVertexBytes( attr.count, attr.itemSize, bytesPerElement );

    }

    getTotalTriangles() {

        if ( this.index ) {

            return BufferGeometryUtils.totalTriangles( this.index.count );

        }

        const position = this.attributes.position;
        return position ? BufferGeometryUtils.totalTriangles( position.count ) : 0;

    }

    asBitecsComponent( name, count ) {

        return BufferGeometryUtils.registerComponent( name, count );

    }

    fillPositionWithNoise( scale = 0.1, seed = 0 ) {

        const position = this.attributes.position;

        if ( position ) {

            BufferGeometryUtils.fillWithNoise( position.array, position.count, position.itemSize, scale, seed );
            position.needsUpdate = true;

        }

        return this;

    }

    displaceByNoise( amplitude = 0.1, scale = 0.1, seed = 0 ) {

        const position = this.attributes.position;
        const normal = this.attributes.normal;

        if ( position && normal ) {

            BufferGeometryUtils.displaceByNoise( position.array, normal.array, position.count, amplitude, scale, seed );
            position.needsUpdate = true;

        }

        return this;

    }

}

BufferGeometry.Utils = BufferGeometryUtils;

export default BufferGeometry;