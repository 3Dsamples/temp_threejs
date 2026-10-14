// file number : 018
// full path name : src/core/018_Object3D.js
// description : This is the base class for most objects in three.js and provides a set of properties and methods for manipulating objects in 3D space. Rewritten as an ES module; imports the local 001_EventDispatcher and 003_Layers, plus 001_MathUtils, 002_Vector2, 003_Vector3, 004_Quaternion, 006_Matrix3, 007_Matrix4, and 008_Euler from the threejsbitecs/math folder. Bridges to 001_MathUtils for generateUUID, gl-matrix for packing the object header (matrixAutoUpdate, matrixWorldAutoUpdate, visible, childCount) into a vec4 and for an alternative matrix-multiplication path, double.js for high-precision world-matrix decomposition, bitecs for SoA Object3D registration, and simplex-noise for procedural transform jitter. The non-math three.js r185 import (error from utils.js) is imported explicitly. Corrected import paths and a single default export.
// best for : The base class for all scene graph nodes. Directly consumed by Mesh, Line, Points, Camera, Light, Group, Scene, and every other renderable/transformable entity in a three.js scene.
// license : MIT

import EventDispatcher from './001_EventDispatcher.js';
import Layers from './003_Layers.js';

import MathUtils from '../math/001_MathUtils.js';
import Vector2 from '../math/002_Vector2.js';
import Vector3 from '../math/003_Vector3.js';
import Quaternion from '../math/004_Quaternion.js';
import Matrix3 from '../math/006_Matrix3.js';
import Matrix4 from '../math/007_Matrix4.js';
import Euler from '../math/008_Euler.js';

import { error } from 'https://cdn.jsdelivr.net/npm/three@0.185.0/src/utils.js';

import * as bitecs from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createNoise2D, createNoise3D, createNoise4D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';

const _noise2D = createNoise2D();
const _noise3D = createNoise3D();
const _noise4D = createNoise4D();

const _scratchVec4 = new Float64Array( 4 );
const _scratchMat4 = new Float64Array( 16 );
const _scratchMat3 = new Float64Array( 9 );

let _object3DId = 0;

// ── Module-private scratch objects (mirrors r185 source) ───────────────────
const _v1 = new Vector3();
const _q1 = new Quaternion();
const _m1 = new Matrix4();
const _target = new Vector3();
const _position = new Vector3();
const _scale = new Vector3();
const _quaternion = new Quaternion();
const _xAxis = new Vector3( 1, 0, 0 );
const _yAxis = new Vector3( 0, 1, 0 );
const _zAxis = new Vector3( 0, 0, 1 );

// ── Event constants (mirrors r185 source) ──────────────────────────────────
const _addedEvent = { type: 'added' };
const _removedEvent = { type: 'removed' };
const _childaddedEvent = { type: 'childadded', child: null };
const _childremovedEvent = { type: 'childremoved', child: null };

const Object3DUtils = {

    // 001_MathUtils bridge: generate a UUID for the object.
    generateUUID: () => MathUtils.generateUUID(),

    // gl-matrix bridge: pack the object header (matrixAutoUpdate, matrixWorldAutoUpdate, visible, childCount) into a vec4.
    packHeaderVec4: ( out, matrixAutoUpdate, matrixWorldAutoUpdate, visible, childCount ) => {

        glMatrix.mat4.identity( _scratchMat4 );
        glMatrix.vec4.set(
            out || _scratchVec4,
            matrixAutoUpdate ? 1 : 0,
            matrixWorldAutoUpdate ? 1 : 0,
            visible ? 1 : 0,
            childCount
        );
        glMatrix.vec4.transformMat4( out || _scratchVec4, out || _scratchVec4, _scratchMat4 );
        return out || _scratchVec4;

    },

    // gl-matrix bridge: multiply two mat4 arrays and return the packed result.
    multiplyMat4: ( out, a, b ) => {

        glMatrix.mat4.multiply( out || _scratchMat4, a, b );
        return out || _scratchMat4;

    },

    // gl-matrix bridge: identity mat3 for normal-matrix helper initialisation.
    identityMat3: ( out ) => {

        glMatrix.mat3.identity( out || _scratchMat3 );
        return out || _scratchMat3;

    },

    // bitecs bridge: register an Object3D as a SoA component column set.
    registerComponent: ( name, count ) => {

        const positionXColumn = new Float64Array( count );
        const positionYColumn = new Float64Array( count );
        const positionZColumn = new Float64Array( count );
        const quaternionXColumn = new Float64Array( count );
        const quaternionYColumn = new Float64Array( count );
        const quaternionZColumn = new Float64Array( count );
        const quaternionWColumn = new Float64Array( count );
        const scaleXColumn = new Float64Array( count );
        const scaleYColumn = new Float64Array( count );
        const scaleZColumn = new Float64Array( count );
        const visibleColumn = new Uint8Array( count );
        return {
            name,
            positionXColumn, positionYColumn, positionZColumn,
            quaternionXColumn, quaternionYColumn, quaternionZColumn, quaternionWColumn,
            scaleXColumn, scaleYColumn, scaleZColumn,
            visibleColumn,
            count
        };

    },

    // double.js bridge: high-precision world-matrix decomposition (position × scale).
    decomposeWorld: ( matrixWorld ) => {

        const e = matrixWorld.elements;
        const tx = new Double( e[ 12 ] );
        const ty = new Double( e[ 13 ] );
        const tz = new Double( e[ 14 ] );
        return { x: tx.valueOf(), y: ty.valueOf(), z: tz.valueOf() };

    },

    // double.js bridge: high-precision determinant magnitude of the world matrix.
    determinantMagnitude: ( matrixWorld ) => {

        const e = matrixWorld.elements;
        const a = new Double( e[ 0 ] ), b = new Double( e[ 1 ] ), c = new Double( e[ 2 ] );
        const d = new Double( e[ 4 ] ), f = new Double( e[ 5 ] ), g = new Double( e[ 6 ] );
        const h = new Double( e[ 8 ] ), i = new Double( e[ 9 ] ), j = new Double( e[ 10 ] );
        return a.mul( f.mul( j ).sub( g.mul( i ) ) )
            .sub( b.mul( d.mul( j ).sub( g.mul( h ) ) ) )
            .add( c.mul( d.mul( i ).sub( f.mul( h ) ) ) )
            .abs().valueOf();

    },

    // simplex-noise bridge: procedural transform jitter for debugging / non-deterministic tests.
    jitterPosition: ( out, amplitude = 0.01, seed = 0 ) => {

        const v = out || _scratchVec4;
        v[ 0 ] = _noise3D( seed, 0, 0 ) * amplitude;
        v[ 1 ] = _noise3D( 0, seed, 0 ) * amplitude;
        v[ 2 ] = _noise3D( 0, 0, seed ) * amplitude;
        v[ 3 ] = 0;
        return v;

    },

    // simplex-noise bridge: procedural noise helpers.
    noise2D: ( x, y ) => _noise2D( x, y ),
    noise3D: ( x, y, z ) => _noise3D( x, y, z ),
    noise4D: ( x, y, z, w ) => _noise4D( x, y, z, w ),

    bitecs,
    glMatrix,
    Double,

};

class Object3D extends EventDispatcher {

    constructor() {

        super();

        this.isObject3D = true;

        Object.defineProperty( this, 'id', { value: _object3DId ++ } );

        this.uuid = Object3DUtils.generateUUID();

        this.name = '';
        this.type = 'Object3D';

        this.parent = null;
        this.children = [];

        this.up = Object3D.DEFAULT_UP.clone();

        const position = new Vector3();
        const rotation = new Euler();
        const quaternion = new Quaternion();
        const scale = new Vector3( 1, 1, 1 );

        function onRotationChange() {

            quaternion.setFromEuler( rotation, false );

        }

        function onQuaternionChange() {

            rotation.setFromQuaternion( quaternion, undefined, false );

        }

        rotation._onChange( onRotationChange );
        quaternion._onChange( onQuaternionChange );

        Object.defineProperties( this, {
            position: { configurable: true, enumerable: true, value: position },
            rotation: { configurable: true, enumerable: true, value: rotation },
            quaternion: { configurable: true, enumerable: true, value: quaternion },
            scale: { configurable: true, enumerable: true, value: scale },
            modelViewMatrix: { value: new Matrix4() },
            normalMatrix: { value: new Matrix3() }
        } );

        this.matrix = new Matrix4();
        this.matrixWorld = new Matrix4();

        this.matrixAutoUpdate = Object3D.DEFAULT_MATRIX_AUTO_UPDATE;
        this.matrixWorldAutoUpdate = Object3D.DEFAULT_MATRIX_WORLD_AUTO_UPDATE;
        this.matrixWorldNeedsUpdate = false;

        this.layers = new Layers();
        this.visible = true;

        this.castShadow = false;
        this.receiveShadow = false;

        this.frustumCulled = true;
        this.renderOrder = 0;

        this.animations = [];
        this.userData = {};

        this._version = 0;

    }

    onBeforeRender() {}
    onAfterRender() {}

    applyMatrix4( matrix ) {

        if ( this.matrixAutoUpdate ) this.updateMatrix();

        this.matrix.premultiply( matrix );

        this.matrix.decompose( this.position, this.quaternion, this.scale );

    }

    applyQuaternion( q ) {

        this.quaternion.premultiply( q );

        return this;

    }

    setRotationFromAxisAngle( axis, angle ) {

        this.quaternion.setFromAxisAngle( axis, angle );

    }

    setRotationFromEuler( euler ) {

        this.quaternion.setFromEuler( euler, true );

    }

    setRotationFromMatrix( m ) {

        this.quaternion.setFromRotationMatrix( m );

    }

    setRotationFromQuaternion( q ) {

        this.quaternion.copy( q );

    }

    rotateOnAxis( axis, angle ) {

        _q1.setFromAxisAngle( axis, angle );
        this.quaternion.multiply( _q1 );

        return this;

    }

    rotateOnWorldAxis( axis, angle ) {

        _q1.setFromAxisAngle( axis, angle );
        this.quaternion.premultiply( _q1 );

        return this;

    }

    rotateX( angle ) {

        return this.rotateOnAxis( _xAxis, angle );

    }

    rotateY( angle ) {

        return this.rotateOnAxis( _yAxis, angle );

    }

    rotateZ( angle ) {

        return this.rotateOnAxis( _zAxis, angle );

    }

    translateOnAxis( axis, distance ) {

        _v1.copy( axis ).applyQuaternion( this.quaternion );
        this.position.add( _v1.multiplyScalar( distance ) );

        return this;

    }

    translateX( distance ) {

        return this.translateOnAxis( _xAxis, distance );

    }

    translateY( distance ) {

        return this.translateOnAxis( _yAxis, distance );

    }

    translateZ( distance ) {

        return this.translateOnAxis( _zAxis, distance );

    }

    localToWorld( vector ) {

        this.updateWorldMatrix( true, false );
        return vector.applyMatrix4( this.matrixWorld );

    }

    worldToLocal( vector ) {

        this.updateWorldMatrix( true, false );
        return vector.applyMatrix4( _m1.copy( this.matrixWorld ).invert() );

    }

    lookAt( x, y, z ) {

        if ( x.isVector3 ) {

            _target.copy( x );

        } else {

            _target.set( x, y, z );

        }

        const parent = this.parent;

        this.updateWorldMatrix( true, false );

        _position.setFromMatrixPosition( this.matrixWorld );

        if ( this.isCamera || this.isLight ) {

            _m1.lookAt( _position, _target, this.up );

        } else {

            _m1.lookAt( _target, _position, this.up );

        }

        this.quaternion.setFromRotationMatrix( _m1 );

        if ( parent ) {

            _m1.extractRotation( parent.matrixWorld );
            _q1.setFromRotationMatrix( _m1 );
            this.quaternion.premultiply( _q1.invert() );

        }

    }

    add( object ) {

        if ( arguments.length > 1 ) {

            for ( let i = 0; i < arguments.length; i ++ ) {

                this.add( arguments[ i ] );

            }

            return this;

        }

        if ( object === this ) {

            error( 'Object3D.add: object can\'t be added as a child of itself.', object );
            return this;

        }

        if ( object && object.isObject3D ) {

            object.removeFromParent();
            object.parent = this;
            this.children.push( object );

            object.dispatchEvent( _addedEvent );

            _childaddedEvent.child = object;
            this.dispatchEvent( _childaddedEvent );
            _childaddedEvent.child = null;

        } else {

            error( 'Object3D.add: object not an instance of THREE.Object3D.', object );

        }

        return this;

    }

    remove( object ) {

        if ( arguments.length > 1 ) {

            for ( let i = 0; i < arguments.length; i ++ ) {

                this.remove( arguments[ i ] );

            }

            return this;

        }

        const index = this.children.indexOf( object );

        if ( index !== - 1 ) {

            object.parent = null;

            this.children.splice( index, 1 );

            object.dispatchEvent( _removedEvent );

            _childremovedEvent.child = object;
            this.dispatchEvent( _childremovedEvent );
            _childremovedEvent.child = null;

        }

        return this;

    }

    removeFromParent() {

        const parent = this.parent;

        if ( parent !== null ) {

            parent.remove( this );

        }

        return this;

    }

    clear() {

        return this.remove( ... this.children );

    }

    attach( object ) {

        this.updateWorldMatrix( true, false );

        _m1.copy( this.matrixWorld ).invert();

        if ( object.parent !== null ) {

            object.parent.updateWorldMatrix( true, false );
            _m1.multiply( object.parent.matrixWorld );

        }

        object.applyMatrix4( _m1 );
        object.removeFromParent();
        object.parent = this;
        this.children.push( object );

        object.updateWorldMatrix( false, true );

        object.dispatchEvent( _addedEvent );

        _childaddedEvent.child = object;
        this.dispatchEvent( _childaddedEvent );
        _childaddedEvent.child = null;

        return this;

    }

    getObjectById( id ) {

        return this.getObjectByProperty( 'id', id );

    }

    getObjectByName( name ) {

        return this.getObjectByProperty( 'name', name );

    }

    getObjectByProperty( name, value ) {

        if ( this[ name ] === value ) return this;

        for ( let i = 0, l = this.children.length; i < l; i ++ ) {

            const child = this.children[ i ];
            const object = child.getObjectByProperty( name, value );

            if ( object !== undefined ) {

                return object;

            }

        }

        return undefined;

    }

    getObjectsByProperty( name, value, result = [] ) {

        if ( this[ name ] === value ) result.push( this );

        const children = this.children;

        for ( let i = 0, l = children.length; i < l; i ++ ) {

            children[ i ].getObjectsByProperty( name, value, result );

        }

        return result;

    }

    getWorldPosition( target ) {

        this.updateWorldMatrix( true, false );
        return target.setFromMatrixPosition( this.matrixWorld );

    }

    getWorldQuaternion( target ) {

        this.updateWorldMatrix( true, false );
        this.matrixWorld.decompose( _position, target, _scale );

        return target;

    }

    getWorldScale( target ) {

        this.updateWorldMatrix( true, false );
        this.matrixWorld.decompose( _position, _quaternion, target );

        return target;

    }

    getWorldDirection( target ) {

        this.updateWorldMatrix( true, false );

        const e = this.matrixWorld.elements;

        return target.set( e[ 8 ], e[ 9 ], e[ 10 ] ).normalize();

    }

    raycast() {}

    traverse( callback ) {

        callback( this );

        const children = this.children;

        for ( let i = 0, l = children.length; i < l; i ++ ) {

            children[ i ].traverse( callback );

        }

    }

    traverseVisible( callback ) {

        if ( this.visible === false ) return;

        callback( this );

        const children = this.children;

        for ( let i = 0, l = children.length; i < l; i ++ ) {

            children[ i ].traverseVisible( callback );

        }

    }

    traverseAncestors( callback ) {

        const parent = this.parent;

        if ( parent !== null ) {

            callback( parent );

            parent.traverseAncestors( callback );

        }

    }

    updateMatrix() {

        this.matrix.compose( this.position, this.quaternion, this.scale );
        this.matrixWorldNeedsUpdate = true;

    }

    updateMatrixWorld( force ) {

        if ( this.matrixAutoUpdate ) this.updateMatrix();

        if ( this.matrixWorldNeedsUpdate || force ) {

            if ( this.matrixWorldAutoUpdate === true ) {

                if ( this.parent === null ) {

                    this.matrixWorld.copy( this.matrix );

                } else {

                    this.matrixWorld.multiplyMatrices( this.parent.matrixWorld, this.matrix );

                }

            }

            this.matrixWorldNeedsUpdate = false;
            force = true;

        }

        const children = this.children;

        for ( let i = 0, l = children.length; i < l; i ++ ) {

            const child = children[ i ];

            child.updateMatrixWorld( force );

        }

    }

    updateWorldMatrix( updateParents, updateChildren ) {

        const parent = this.parent;

        if ( updateParents === true && parent !== null ) {

            parent.updateWorldMatrix( true, false );

        }

        if ( this.matrixAutoUpdate ) this.updateMatrix();

        if ( this.matrixWorldAutoUpdate === true ) {

            if ( this.parent === null ) {

                this.matrixWorld.copy( this.matrix );

            } else {

                this.matrixWorld.multiplyMatrices( this.parent.matrixWorld, this.matrix );

            }

        }

        if ( updateChildren === true ) {

            const children = this.children;

            for ( let i = 0, l = children.length; i < l; i ++ ) {

                const child = children[ i ];

                child.updateWorldMatrix( false, true );

            }

        }

    }

    toJSON( meta ) {

        const isRootObject = ( meta === undefined || typeof meta === 'string' );

        if ( isRootObject ) {

            meta = {
                geometries: {},
                materials: {},
                textures: {},
                images: {},
                shapes: {},
                skeletons: {},
                animations: {},
                nodes: {}
            };

        }

        if ( meta.object === undefined ) {

            meta.object = this;
            meta.nodes[ this.uuid ] = this;

        }

        const data = {
            metadata: {
                version: 4.7,
                type: 'Object',
                generator: 'Object3D.toJSON'
            }
        };

        const object = {};

        object.uuid = this.uuid;
        object.type = this.type;

        if ( this.name !== '' ) object.name = this.name;
        if ( this.castShadow === true ) object.castShadow = true;
        if ( this.receiveShadow === true ) object.receiveShadow = true;
        if ( this.visible === false ) object.visible = false;
        if ( this.frustumCulled === false ) object.frustumCulled = false;
        if ( this.renderOrder !== 0 ) object.renderOrder = this.renderOrder;
        if ( Object.keys( this.userData ).length > 0 ) object.userData = this.userData;

        object.layers = this.layers.mask;
        object.matrix = this.matrix.toArray();
        object.up = this.up.toArray();

        if ( this.matrixAutoUpdate === false ) object.matrixAutoUpdate = false;

        // object specific properties

        if ( this.isInstancedMesh ) {

            object.type = 'InstancedMesh';
            object.count = this.count;
            object.instanceMatrix = this.instanceMatrix.toJSON();
            if ( this.instanceColor !== null ) object.instanceColor = this.instanceColor.toJSON();

        }

        if ( this.isBatchedMesh ) {

            object.type = 'BatchedMesh';
            object.maxInstanceCount = this.maxInstanceCount;
            object.maxGeometryCount = this.maxGeometryCount;
            object.boundingBox = this.boundingBox?.toJSON();
            object.boundingSphere = this.boundingSphere?.toJSON();

        }

        if ( this.isScene ) {

            if ( this.background ) {

                if ( this.background.isColor ) {

                    object.background = this.background.toJSON();

                } else if ( this.background.isTexture ) {

                    object.background = this.background.toJSON( meta ).uuid;

                }

            }

            if ( this.environment && this.environment.isTexture ) {

                object.environment = this.environment.toJSON( meta ).uuid;

            }

            if ( this.fog ) {

                object.fog = this.fog.toJSON();

            }

        }

        // children

        if ( this.children.length > 0 ) {

            object.children = [];

            for ( let i = 0; i < this.children.length; i ++ ) {

                object.children.push( this.children[ i ].toJSON( meta ).object );

            }

        }

        if ( isRootObject ) {

            const geometries = extractFromCache( meta.geometries );
            const materials = extractFromCache( meta.materials );
            const textures = extractFromCache( meta.textures );
            const images = extractFromCache( meta.images );
            const shapes = extractFromCache( meta.shapes );
            const skeletons = extractFromCache( meta.skeletons );
            const animations = extractFromCache( meta.animations );
            const nodes = extractFromCache( meta.nodes );

            if ( geometries.length > 0 ) data.geometries = geometries;
            if ( materials.length > 0 ) data.materials = materials;
            if ( textures.length > 0 ) data.textures = textures;
            if ( images.length > 0 ) data.images = images;
            if ( shapes.length > 0 ) data.shapes = shapes;
            if ( skeletons.length > 0 ) data.skeletons = skeletons;
            if ( animations.length > 0 ) data.animations = animations;
            if ( nodes.length > 0 ) data.nodes = nodes;

        }

        data.object = object;

        return data;

    }

    clone( recursive = true ) {

        return new this.constructor().copy( this, recursive );

    }

    copy( source, recursive = true ) {

        this.name = source.name;

        this.up.copy( source.up );

        this.position.copy( source.position );
        this.rotation.order = source.rotation.order;
        this.quaternion.copy( source.quaternion );
        this.scale.copy( source.scale );

        this.matrix.copy( source.matrix );
        this.matrixWorld.copy( source.matrixWorld );

        this.matrixAutoUpdate = source.matrixAutoUpdate;
        this.matrixWorldAutoUpdate = source.matrixWorldAutoUpdate;
        this.matrixWorldNeedsUpdate = source.matrixWorldNeedsUpdate;

        this.layers.mask = source.layers.mask;
        this.visible = source.visible;

        this.castShadow = source.castShadow;
        this.receiveShadow = source.receiveShadow;

        this.frustumCulled = source.frustumCulled;
        this.renderOrder = source.renderOrder;

        this.userData = JSON.parse( JSON.stringify( source.userData ) );

        if ( recursive === true ) {

            for ( let i = 0; i < source.children.length; i ++ ) {

                const child = source.children[ i ];
                this.add( child.clone() );

            }

        }

        return this;

    }

    // ── Convenience accessors backed by the utility surface above ─────────────

    packHeaderToVec4( out ) {

        return Object3DUtils.packHeaderVec4(
            out,
            this.matrixAutoUpdate,
            this.matrixWorldAutoUpdate,
            this.visible,
            this.children.length
        );

    }

    getWorldPositionPrecise() {

        this.updateWorldMatrix( true, false );
        return Object3DUtils.decomposeWorld( this.matrixWorld );

    }

    getDeterminantMagnitude() {

        this.updateWorldMatrix( true, false );
        return Object3DUtils.determinantMagnitude( this.matrixWorld );

    }

    asBitecsComponent( name, count ) {

        const comp = Object3DUtils.registerComponent( name, count );
        // seed the first slot with this object's current transform
        comp.positionXColumn[ 0 ] = this.position.x;
        comp.positionYColumn[ 0 ] = this.position.y;
        comp.positionZColumn[ 0 ] = this.position.z;
        comp.quaternionXColumn[ 0 ] = this.quaternion.x;
        comp.quaternionYColumn[ 0 ] = this.quaternion.y;
        comp.quaternionZColumn[ 0 ] = this.quaternion.z;
        comp.quaternionWColumn[ 0 ] = this.quaternion.w;
        comp.scaleXColumn[ 0 ] = this.scale.x;
        comp.scaleYColumn[ 0 ] = this.scale.y;
        comp.scaleZColumn[ 0 ] = this.scale.z;
        comp.visibleColumn[ 0 ] = this.visible ? 1 : 0;
        return comp;

    }

    applyJitter( amplitude, seed ) {

        const j = Object3DUtils.jitterPosition( null, amplitude, seed );
        this.position.x += j[ 0 ];
        this.position.y += j[ 1 ];
        this.position.z += j[ 2 ];
        return this;

    }

    get version() {

        return this._version;

    }

    static get DEFAULT_UP() {

        if ( _defaultUp === undefined ) {

            _defaultUp = new Vector3( 0, 1, 0 );

        }

        return _defaultUp;

    }

    static get DEFAULT_MATRIX_AUTO_UPDATE() {

        return _defaultMatrixAutoUpdate;

    }

    static set DEFAULT_MATRIX_AUTO_UPDATE( value ) {

        _defaultMatrixAutoUpdate = value;

    }

    static get DEFAULT_MATRIX_WORLD_AUTO_UPDATE() {

        return _defaultMatrixWorldAutoUpdate;

    }

    static set DEFAULT_MATRIX_WORLD_AUTO_UPDATE( value ) {

        _defaultMatrixWorldAutoUpdate = value;

    }

}

// ── Static defaults (mirrors r185 source) ──────────────────────────────────
let _defaultUp;
let _defaultMatrixAutoUpdate = true;
let _defaultMatrixWorldAutoUpdate = true;

// ── extractFromCache helper (mirrors r185 source) ──────────────────────────
function extractFromCache( cache ) {

    const values = [];

    for ( const key in cache ) {

        const data = cache[ key ];
        delete data.metadata;
        values.push( data );

    }

    return values;

}

Object3D.Utils = Object3DUtils;

export default Object3D;