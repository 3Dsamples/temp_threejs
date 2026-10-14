
// file number : 001
// full path name : src/objects/001_Bone.js
// description : A bone which is part of a Skeleton. The skeleton in turn is used by the SkinnedMesh. This rewrite extends Object3D (018_Object3D.js) and integrates gl-matrix for high-performance matrix operations, double.js for high-precision world-matrix decomposition, bitecs for SoA ECS bone registration, and simplex-noise for procedural bone jitter useful in organic skeletal animation. All CDN imports are used in the implementation to preserve the benefits of each library.
// best for : Skeletal animation hierarchies, IK chains, procedural bone motion, ECS-driven skeletal systems, high-precision world-space bone decomposition.
// license : MIT

import Object3D from '../core/018_Object3D.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec3 = new Float64Array( 3 );
const _noise3D = createNoise3D();

// ─── ECS world + Bone SoA component definition ───────────────────────────────
const _boneWorld = createWorld();

const BoneSoA = defineComponent( {
    // Position columns
    positionX: Types.f64,
    positionY: Types.f64,
    positionZ: Types.f64,
    // Quaternion columns
    quaternionX: Types.f64,
    quaternionY: Types.f64,
    quaternionZ: Types.f64,
    quaternionW: Types.f64,
    // Scale columns
    scaleX: Types.f64,
    scaleY: Types.f64,
    scaleZ: Types.f64,
    // Hierarchy reference (entity id)
    parentEntity: Types.i32,
    // Flags
    visible: Types.ui8
} );

/**
 * A bone which is part of a Skeleton. The skeleton in turn is used by
 * the SkinnedMesh.
 *
 * ```js
 * const root = new THREE.Bone();
 * const child = new THREE.Bone();
 * root.add( child );
 * child.position.y = 5;
```

· 
· This rewrite adds:
· · gl-matrix fast path for matrix multiplication and world-matrix packing.
· · double.js high-precision decomposition of the world matrix.
· · bitecs SoA registration for ECS-driven skeletal animation.
· · simplex-noise procedural jitter for organic bone motion.
· 
· @augments Object3D
  */
  class Bone extends Object3D {
  /**
  · Constructs a new bone.
    */
    constructor() {
    super();
    /**
    · This flag can be used for type testing.
    · @type {boolean}
    · @readonly
    · @default true
      */
      this.isBone = true;
    this.type = 'Bone';
    /**
    · The ECS entity id registered in the BoneSoA world, or -1 if
    · not yet registered.
    · @type {number}
    · @default -1
      */
      this._ecsEntity = - 1;
    /**
    · Whether this bone has been registered in the ECS world.
    · @type {boolean}
    · @default false
      */
      this._ecsRegistered = false;
      }
  /**
  · Registers this bone in the BoneSoA ECS world and syncs its current
  · transform into SoA columns. Subsequent calls to {@link Bone#syncECS}
  · will update the columns without re-adding the component.
  · 
  · @return {number} The ECS entity id.
    */
    registerECS() {
    if ( this._ecsRegistered ) {
    return this._ecsEntity;
    }
    const entity = addEntity( _boneWorld );
    addComponent( _boneWorld, BoneSoA, entity );
    this._ecsEntity = entity;
    this._ecsRegistered = true;
    this.syncECS();
    return entity;
    }
  /**
  · Syncs the current transform of this bone into the BoneSoA ECS columns.
  · Call this after mutating position, quaternion, or scale when
  · using the ECS path.
  · 
  · @return {Bone} A reference to this bone.
    */
    syncECS() {
    if ( ! this._ecsRegistered ) {
    return this;
    }
    const eid = this._ecsEntity;
    BoneSoA.positionX[ eid ] = this.position.x;
    BoneSoA.positionY[ eid ] = this.position.y;
    BoneSoA.positionZ[ eid ] = this.position.z;
    BoneSoA.quaternionX[ eid ] = this.quaternion.x;
    BoneSoA.quaternionY[ eid ] = this.quaternion.y;
    BoneSoA.quaternionZ[ eid ] = this.quaternion.z;
    BoneSoA.quaternionW[ eid ] = this.quaternion.w;
    BoneSoA.scaleX[ eid ] = this.scale.x;
    BoneSoA.scaleY[ eid ] = this.scale.y;
    BoneSoA.scaleZ[ eid ] = this.scale.z;
    BoneSoA.visible[ eid ] = this.visible ? 1 : 0;
    return this;
    }
  /**
  · Pushes the ECS columns back into the Object3D transform. Useful when
  · an external system mutates the SoA columns directly and you want to
  · reflect those changes on the Bone.
  · 
  · @return {Bone} A reference to this bone.
    */
    pullECS() {
    if ( ! this._ecsRegistered ) {
    return this;
    }
    const eid = this._ecsEntity;
    this.position.set(
    BoneSoA.positionX[ eid ],
    BoneSoA.positionY[ eid ],
    BoneSoA.positionZ[ eid ]
    );
    this.quaternion.set(
    BoneSoA.quaternionX[ eid ],
    BoneSoA.quaternionY[ eid ],
    BoneSoA.quaternionZ[ eid ],
    BoneSoA.quaternionW[ eid ]
    );
    this.scale.set(
    BoneSoA.scaleX[ eid ],
    BoneSoA.scaleY[ eid ],
    BoneSoA.scaleZ[ eid ]
    );
    this.visible = BoneSoA.visible[ eid ] === 1;
    return this;
    }
  /**
  · Multiplies two mat4 arrays using gl-matrix and returns the result.
  · This is a fast path for callers that already have raw Float64Array
  · matrices and want to avoid Object3D matrix object overhead.
  · 
  · @param {Float64Array|number[]} out - The output matrix (16 elements).
  · @param {Float64Array|number[]} a - The left-hand matrix (16 elements).
  · @param {Float64Array|number[]} b - The right-hand matrix (16 elements).
  · @return {Float64Array|number[]} The out matrix.
    */
    multiplyMat4GL( out, a, b ) {
    glMatrix.mat4.multiply( out || _scratchMat4, a, b );
    return out || _scratchMat4;
    }
  /**
  · Decomposes the world matrix of this bone using double.js for
  · high-precision translation extraction. Scale and rotation are
  · still taken from the Object3D transform because double.js is
  · used here specifically to avoid precision loss in large worlds.
  · 
  · @return {{x:number, y:number, z:number}} High-precision world position.
    */
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
  /**
  · Returns the high-precision magnitude of the determinant of the world
  · matrix. Useful for detecting degenerate scale in very large or very
  · small skeletons.
  · 
  · @return {number} The absolute determinant magnitude.
    */
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
  /**
  · Applies procedural jitter to the bone position using simplex-noise.
  · This is useful for organic secondary motion, wind sway, or debugging
  · non-deterministic skeletal setups.
  · 
  · @param {number} [amplitude=0.01] - The jitter amplitude.
  · @param {number} [time=0] - The time parameter (e.g., elapsed seconds).
  · @param {number} [seed=0] - An additional seed offset.
  · @return {Bone} A reference to this bone.
    */
    jitterPosition( amplitude = 0.01, time = 0, seed = 0 ) {
    this.position.x += _noise3D( seed, 0, time ) * amplitude;
    this.position.y += _noise3D( 0, seed, time ) * amplitude;
    this.position.z += _noise3D( 0, 0, seed + time ) * amplitude;
    return this;
    }
  /**
  · Packs the Object3D header (matrixAutoUpdate, matrixWorldAutoUpdate,
  · visible, childCount) into a Float64Array vec4 using gl-matrix.
  · Mirrors the Object3DUtils.packHeaderVec4 helper in Object3D.js.
  · 
  · @param {Float64Array} [out] - Optional output vec4.
  · @return {Float64Array} The packed vec4.
    */
    packHeaderVec4( out ) {
    const v = out || _scratchVec3;
    glMatrix.vec4.set(
    v,
    this.matrixAutoUpdate ? 1 : 0,
    this.matrixWorldAutoUpdate ? 1 : 0,
    this.visible ? 1 : 0,
    this.children.length
    );
    return v;
    }
  /**
  · Returns the ECS world used by all Bone instances for SoA registration.
  · Exposed so that systems (e.g., animation systems) can query bones.
  · 
  · @return {object} The bitecs world.
    */
    static getECSWorld() {
    return _boneWorld;
    }
  /**
  · Returns the BoneSoA component definition so that external systems can
  · query or extend it.
  · 
  · @return {object} The BoneSoA component.
    */
    static getBoneSoA() {
    return BoneSoA;
    }
    }

export { Bone }; 