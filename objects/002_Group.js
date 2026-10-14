// file number : 002
// full path name : src/objects/002_Group.js
// description : A Group is a container for Object3D instances. This rewrite extends Object3D (018_Object3D.js) and integrates gl-matrix for high-performance matrix operations, double.js for high-precision world-space decomposition, bitecs for SoA ECS group registration, and simplex-noise for procedural group jitter useful in dynamic scene graph manipulation.
// best for : Scene graph organization, ECS-driven container management, high-precision group transforms, procedural group motion.
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

// ─── ECS world + Group SoA component definition ──────────────────────────────
const _groupWorld = createWorld();

const GroupSoA = defineComponent( {
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
    visible: Types.ui8
} );

/**
 * A Group is a container for Object3D instances.
 * @augments Object3D
 */
class Group extends Object3D {

    constructor() {
        super();

        this.isGroup = true;
        this.type = 'Group';

        this._ecsEntity = - 1;
        this._ecsRegistered = false;
    }

    registerECS() {
        if ( this._ecsRegistered ) {
            return this._ecsEntity;
        }

        const entity = addEntity( _groupWorld );
        addComponent( _groupWorld, GroupSoA, entity );

        this._ecsEntity = entity;
        this._ecsRegistered = true;

        this.syncECS();

        return entity;
    }

    syncECS() {
        if ( ! this._ecsRegistered ) {
            return this;
        }

        const eid = this._ecsEntity;

        GroupSoA.positionX[ eid ] = this.position.x;
        GroupSoA.positionY[ eid ] = this.position.y;
        GroupSoA.positionZ[ eid ] = this.position.z;

        GroupSoA.quaternionX[ eid ] = this.quaternion.x;
        GroupSoA.quaternionY[ eid ] = this.quaternion.y;
        GroupSoA.quaternionZ[ eid ] = this.quaternion.z;
        GroupSoA.quaternionW[ eid ] = this.quaternion.w;

        GroupSoA.scaleX[ eid ] = this.scale.x;
        GroupSoA.scaleY[ eid ] = this.scale.y;
        GroupSoA.scaleZ[ eid ] = this.scale.z;

        GroupSoA.visible[ eid ] = this.visible ? 1 : 0;

        return this;
    }

    pullECS() {
        if ( ! this._ecsRegistered ) {
            return this;
        }

        const eid = this._ecsEntity;

        this.position.set(
            GroupSoA.positionX[ eid ],
            GroupSoA.positionY[ eid ],
            GroupSoA.positionZ[ eid ]
        );

        this.quaternion.set(
            GroupSoA.quaternionX[ eid ],
            GroupSoA.quaternionY[ eid ],
            GroupSoA.quaternionZ[ eid ],
            GroupSoA.quaternionW[ eid ]
        );

        this.scale.set(
            GroupSoA.scaleX[ eid ],
            GroupSoA.scaleY[ eid ],
            GroupSoA.scaleZ[ eid ]
        );

        this.visible = GroupSoA.visible[ eid ] === 1;

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
        return _groupWorld;
    }

    static getGroupSoA() {
        return GroupSoA;
    }
}

export { Group };