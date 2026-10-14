// file number : 003
// full path name : src/objects/003_Mesh.js
// description : A Mesh is an object that represents a geometry and a material. This rewrite extends Object3D (018_Object3D.js) and integrates gl-matrix for high-performance matrix operations, double.js for high-precision world-space decomposition, bitecs for SoA ECS mesh registration, and simplex-noise for procedural mesh jitter useful in dynamic scene graph manipulation. Includes morph target handling and geometry/material ownership semantics matching three.js r185.
// best for : Renderable geometry instances, ECS-driven renderable management, morph-target animation, high-precision mesh transforms, procedural mesh motion.
// license : MIT

import Object3D from '../core/018_Object3D.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + Mesh SoA component definition ───────────────────────────────
const _meshWorld = createWorld();

const MeshSoA = defineComponent( {
    positionX: Types.f64,
    positionY: Types.f64,
    positionZ: Types.f64,
    quaternionX: Types.f64,
    quaternionY: Types.f64,
    quaternionZ: Types.f64,
    quaternionW: Types.f64,
    scaleX: Types.f64,
    scaleY: Types.f64,
    scaleZ: Types.f64,
    parentEntity: Types.i32,
    visible: Types.ui8,
    // Geometry/material as integer handles resolved by a registry
    geometryHandle: Types.i32,
    materialHandle: Types.i32,
    morphInfluence0: Types.f32,
    morphInfluence1: Types.f32,
    morphInfluence2: Types.f32,
    morphInfluence3: Types.f32
} );

/**
 * A Mesh is an object that represents a geometry and a material.
 * @augments Object3D
 */
class Mesh extends Object3D {

    /**
     * Constructs a new mesh.
     * @param {BufferGeometry} [geometry] - The geometry. Default is a new BufferGeometry.
     * @param {Material} [material] - The material. Default is a new MeshBasicMaterial.
     */
    constructor( geometry = null, material = null ) {
        super();

        this.isMesh = true;
        this.type = 'Mesh';

        this.geometry = geometry;
        this.material = material;

        /**
         * An array of weights typically from 0-1 that specify how much of
         * the morph target shapes to apply.
         * @type {Array<number>}
         */
        this.morphTargetInfluences = undefined;

        /**
         * A dictionary of morphTargets based on the morphTarget.name property.
         * @type {Object<string, number>}
         */
        this.morphTargetDictionary = undefined;

        this._ecsEntity = - 1;
        this._ecsRegistered = false;

        this.updateMorphTargets();
    }

    /**
     * Copies the properties from the source mesh.
     * @param {Mesh} source
     * @param {boolean} [recursive]
     * @return {Mesh}
     */
    copy( source, recursive = true ) {
        super.copy( source, recursive );

        if ( source.morphTargetInfluences !== undefined ) {
            this.morphTargetInfluences = source.morphTargetInfluences.slice();
        }

        if ( source.morphTargetDictionary !== undefined ) {
            this.morphTargetDictionary = Object.assign( {}, source.morphTargetDictionary );
        }

        this.material = Array.isArray( source.material )
            ? source.material.slice()
            : source.material;

        this.geometry = source.geometry;

        return this;
    }

    /**
     * Updates the morphTargets to have no influence on the object.
     * Resets the morphTargetInfluences and morphTargetDictionary properties.
     * @return {Mesh}
     */
    updateMorphTargets() {
        const geometry = this.geometry;

        if ( geometry === null || geometry === undefined ) {
            return this;
        }

        const morphAttributes = geometry.morphAttributes;
        const keys = Object.keys( morphAttributes );

        if ( keys.length > 0 ) {
            const morphAttribute = morphAttributes[ keys[ 0 ] ];

            if ( morphAttribute !== undefined ) {
                this.morphTargetInfluences = [];
                this.morphTargetDictionary = {};

                for ( let m = 0, ml = morphAttribute.length; m < ml; m ++ ) {
                    const name = morphAttribute[ m ].name || String( m );

                    this.morphTargetInfluences.push( 0 );
                    this.morphTargetDictionary[ name ] = m;
                }
            }
        }

        return this;
    }

    registerECS( geometryHandle = - 1, materialHandle = - 1 ) {
        if ( this._ecsRegistered ) {
            return this._ecsEntity;
        }

        const entity = addEntity( _meshWorld );
        addComponent( _meshWorld, MeshSoA, entity );

        this._ecsEntity = entity;
        this._ecsRegistered = true;

        this.syncECS( geometryHandle, materialHandle );

        return entity;
    }

    syncECS( geometryHandle = - 1, materialHandle = - 1 ) {
        if ( ! this._ecsRegistered ) {
            return this;
        }

        const eid = this._ecsEntity;

        MeshSoA.positionX[ eid ] = this.position.x;
        MeshSoA.positionY[ eid ] = this.position.y;
        MeshSoA.positionZ[ eid ] = this.position.z;

        MeshSoA.quaternionX[ eid ] = this.quaternion.x;
        MeshSoA.quaternionY[ eid ] = this.quaternion.y;
        MeshSoA.quaternionZ[ eid ] = this.quaternion.z;
        MeshSoA.quaternionW[ eid ] = this.quaternion.w;

        MeshSoA.scaleX[ eid ] = this.scale.x;
        MeshSoA.scaleY[ eid ] = this.scale.y;
        MeshSoA.scaleZ[ eid ] = this.scale.z;

        MeshSoA.visible[ eid ] = this.visible ? 1 : 0;

        MeshSoA.geometryHandle[ eid ] = geometryHandle;
        MeshSoA.materialHandle[ eid ] = materialHandle;

        if ( this.morphTargetInfluences !== undefined ) {
            const mi = this.morphTargetInfluences;
            MeshSoA.morphInfluence0[ eid ] = mi[ 0 ] || 0;
            MeshSoA.morphInfluence1[ eid ] = mi[ 1 ] || 0;
            MeshSoA.morphInfluence2[ eid ] = mi[ 2 ] || 0;
            MeshSoA.morphInfluence3[ eid ] = mi[ 3 ] || 0;
        }

        return this;
    }

    pullECS() {
        if ( ! this._ecsRegistered ) {
            return this;
        }

        const eid = this._ecsEntity;

        this.position.set(
            MeshSoA.positionX[ eid ],
            MeshSoA.positionY[ eid ],
            MeshSoA.positionZ[ eid ]
        );

        this.quaternion.set(
            MeshSoA.quaternionX[ eid ],
            MeshSoA.quaternionY[ eid ],
            MeshSoA.quaternionZ[ eid ],
            MeshSoA.quaternionW[ eid ]
        );

        this.scale.set(
            MeshSoA.scaleX[ eid ],
            MeshSoA.scaleY[ eid ],
            MeshSoA.scaleZ[ eid ]
        );

        this.visible = MeshSoA.visible[ eid ] === 1;

        if ( this.morphTargetInfluences !== undefined ) {
            this.morphTargetInfluences[ 0 ] = MeshSoA.morphInfluence0[ eid ];
            this.morphTargetInfluences[ 1 ] = MeshSoA.morphInfluence1[ eid ];
            this.morphTargetInfluences[ 2 ] = MeshSoA.morphInfluence2[ eid ];
            this.morphTargetInfluences[ 3 ] = MeshSoA.morphInfluence3[ eid ];
        }

        return this;
    }

    multiplyMat4GL( out, a, b ) {
        glMatrix.mat4.multiply( out || _scratchMat4, a, b );
        return out || _scratchMat4;
    }

    decomposeWorldHighPrecision() {
        const e = this.matrixWorld.elements;

        const tx = new Double( e[ 12 ] );
        const ty = new Double( e[ 13 ] );
        const tz = new Double( e[ 14 ] );

        return {
            x: tx.valueOf(),
            y: ty.valueOf(),
            z: tz.valueOf()
        };
    }

    determinantMagnitudeHighPrecision() {
        const e = this.matrixWorld.elements;

        const a = new Double( e[ 0 ] ), b = new Double( e[ 1 ] ), c = new Double( e[ 2 ] );
        const d = new Double( e[ 4 ] ), f = new Double( e[ 5 ] ), g = new Double( e[ 6 ] );
        const h = new Double( e[ 8 ] ), i = new Double( e[ 9 ] ), j = new Double( e[ 10 ] );

        return a.mul( f.mul( j ).sub( g.mul( i ) ) )
            .sub( b.mul( d.mul( j ).sub( g.mul( h ) ) ) )
            .add( c.mul( d.mul( i ).sub( f.mul( h ) ) ) )
            .abs()
            .valueOf();
    }

    jitterPosition( amplitude = 0.01, time = 0, seed = 0 ) {
        this.position.x += _noise3D( seed, 0, time ) * amplitude;
        this.position.y += _noise3D( 0, seed, time ) * amplitude;
        this.position.z += _noise3D( 0, 0, seed + time ) * amplitude;

        return this;
    }

    packHeaderVec4( out ) {
        const v = out || _scratchVec4;
        glMatrix.vec4.set(
            v,
            this.matrixAutoUpdate ? 1 : 0,
            this.matrixWorldAutoUpdate ? 1 : 0,
            this.visible ? 1 : 0,
            this.children.length
        );
        return v;
    }

    static getECSWorld() {
        return _meshWorld;
    }

    static getMeshSoA() {
        return MeshSoA;
    }
}

export { Mesh };