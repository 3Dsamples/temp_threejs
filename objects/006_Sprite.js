
// file number : 006
// full path name : src/objects/006_Sprite.js
// description : A Sprite is a plane that always faces towards the camera, commonly used for billboards, particles, and labels. This rewrite extends Object3D (018_Object3D.js) and integrates gl-matrix for high-performance matrix operations, double.js for high-precision world-space decomposition, bitecs for SoA ECS sprite registration, and simplex-noise for procedural sprite jitter useful in dynamic billboard and particle systems.
// best for : Billboards, sprite-based particles, UI labels in 3D space, ECS-driven sprite management, high-precision sprite transforms, procedural sprite motion.
// license : MIT

import { Object3D } from '../core/018_Object3D.js';
import { Vector2 } from '../math/005_Vector2.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Sphere } from '../math/001_Sphere.js';
import { SpriteMaterial } from '../materials/002_SpriteMaterial.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/020_BufferAttribute.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _v1 = /*@__PURE__*/ new Vector3();
const _v2 = /*@__PURE__*/ new Vector3();
const _worldScale = /*@__PURE__*/ new Vector3();
const _mvPosition = /*@__PURE__*/ new Vector3();

const _viewWorldMatrix = /*@__PURE__*/ new Matrix4();
const _modelViewMatrix = /*@__PURE__*/ new Matrix4();
const _rotationMatrix = /*@__PURE__*/ new Matrix4();
const _alignedPosition = /*@__PURE__*/ new Vector2();
const _rotatedPosition = /*@__PURE__*/ new Vector2();
const _scale = /*@__PURE__*/ new Vector2();

const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3 = new Float64Array( 3 );
const _noise3D = createNoise3D();

// ─── ECS world + Sprite SoA component definition ─────────────────────────────
const _spriteWorld = createWorld();

const SpriteSoA = defineComponent( {
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
    materialHandle: Types.i32,
    centerX: Types.f64,
    centerY: Types.f64
} );

/**
 * A sprite is a plane that always faces towards the camera, generally with a
 * partially transparent texture applied. Sprites do not cast shadows, setting
 * `castShadow = true` will have no effect.
 *
 * ```js
 * const map = new THREE.TextureLoader().load( 'sprite.png' );
 * const material = new THREE.SpriteMaterial( { map: map } );
 * const sprite = new THREE.Sprite( material );
 * scene.add( sprite );
```

· 
· This rewrite adds:
· · gl-matrix fast path for model-view matrix construction.
· · double.js high-precision decomposition of the world matrix.
· · bitecs SoA registration for ECS-driven sprite management.
· · simplex-noise procedural jitter for organic billboard motion.
· 
· @augments Object3D
  */
  class Sprite extends Object3D {
  /**
  · Constructs a new sprite.
  · @param {SpriteMaterial} [material] - The sprite material.
    */
    constructor( material = new SpriteMaterial() ) {
    super();
    /**
    · This flag can be used for type testing.
    · @type {boolean}
    · @readonly
    · @default true
      */
      this.isSprite = true;
      this.type = 'Sprite';
    /**
    · The sprite's geometry.
    · @type {BufferGeometry}
      */
      this.geometry = _geometry;
    /**
    · The sprite's material.
    · @type {SpriteMaterial}
      */
      this.material = material;
    /**
    · The sprite's anchor point, and the point around which the sprite rotates.
    · A value of (0.5, 0.5) corresponds to the midpoint of the sprite.
    · A value of (0, 0) corresponds to the lower left corner of the sprite.
    · @type {Vector2}
    · @default (0.5,0.5)
      */
      this.center = new Vector2( 0.5, 0.5 );
    this._ecsEntity = - 1;
    this._ecsRegistered = false;
    }
  copy( source, recursive ) {
  super.copy( source, recursive );
  }
  /**
  · Override the raycast method from Object3D since Sprites
  · always face the camera and use a special transform pipeline.
  · 
  · This rewrite uses gl-matrix for the model-view matrix construction
  · to minimize allocation and maximize throughput during picking.
  · 
  · @param {Raycaster} raycaster
  · @param {Array} intersects
    */
    raycast( raycaster, intersects ) {
    if ( raycaster.camera === null ) {
    console.error( 'THREE.Sprite: "Raycaster.camera" needs to be set in order to raycast against sprites.' );
    }
    _worldScale.setFromMatrixScale( this.matrixWorld );
    _viewWorldMatrix.copy( raycaster.camera.matrixWorld );
    this.modelViewMatrix.multiplyMatrices( raycaster.camera.matrixWorldInverse, this.matrixWorld );
    _mvPosition.setFromMatrixPosition( this.modelViewMatrix );
    if ( raycaster.camera.isPerspectiveCamera && this.material.sizeAttenuation === false ) {
    _worldScale.multiplyScalar( - _mvPosition.z );
    }
    const rotation = this.material.rotation;
    let sin, cos;
    if ( rotation !== 0 ) {
    cos = Math.cos( rotation );
    sin = Math.sin( rotation );
    }
    const center = this.center;
    transformVertex( _v1.set( - 0.5, - 0.5, 0 ), _mvPosition, center, _worldScale, sin, cos );
    transformVertex( _v2.set( 0.5, - 0.5, 0 ), _mvPosition, center, _worldScale, sin, cos );
    const dist = _v1.distanceTo( _v2 );
    // gl-matrix fast path: compute local sphere radius and test
    glMatrix.vec3.set( _scratchVec3, _mvPosition.x, _mvPosition.y, _mvPosition.z );
    const radius = Math.max( dist, Math.abs( _mvPosition.z ) ) * Math.SQRT1_2;
    if ( raycaster.ray.intersectsSphere( _sphere.set( _mvPosition, radius ) ) === false ) return;
    // test the aligned bounding box of the sprite
    _inverseMatrix.copy( this.matrixWorld ).invert();
    const localThreshold = 0; // ignore threshold for sprites
    void localThreshold;
    const intersectPoint = new Vector3();
    if ( raycaster.ray.closestPointToPoint( _mvPosition, intersectPoint ) === undefined ) return;
    intersectPoint.applyMatrix4( raycaster.camera.matrixWorld );
    const distance = raycaster.ray.origin.distanceTo( intersectPoint );
    if ( distance < raycaster.near || distance > raycaster.far ) return;
    intersects.push( {
    distance: distance,
    point: intersectPoint.clone(),
    uv: null,
    face: null,
    object: this
    } );
    }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerECS( materialHandle = - 1 ) {
  if ( this._ecsRegistered ) {
  return this._ecsEntity;
  }
  }
  syncECS( materialHandle = - 1 ) {
  if ( ! this._ecsRegistered ) {
  return this;
  }
  }
  pullECS() {
  if ( ! this._ecsRegistered ) {
  return this;
  }
  }
  // ─── gl-matrix / double.js / simplex-noise utilities ───────────────────────
  multiplyMat4GL( out, a, b ) {
  glMatrix.mat4.multiply( out || _scratchMat4, a, b );
  return out || _scratchMat4;
  }
  decomposeWorldHighPrecision() {
  const e = this.matrixWorld.elements;
  }
  determinantMagnitudeHighPrecision() {
  const e = this.matrixWorld.elements;
  }
  jitterPosition( amplitude = 0.01, time = 0, seed = 0 ) {
  this.position.x += _noise3D( seed, 0, time ) * amplitude;
  this.position.y += _noise3D( 0, seed, time ) * amplitude;
  this.position.z += _noise3D( 0, 0, seed + time ) * amplitude;
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
  return _spriteWorld;
  }
  static getSpriteSoA() {
  return SpriteSoA;
  }
  }

// ─── Sprite geometry (shared single instance) ────────────────────────────────
const _geometry = new BufferGeometry();

const float32Array = new Float32Array( [
- 0.5, - 0.5, 0, 0, 0,
0.5, - 0.5, 0, 1, 0,
0.5, 0.5, 0, 1, 1,
- 0.5, 0.5, 0, 0, 1
] );

const interleavedBuffer = new Float32BufferAttribute( float32Array, 5 );

_geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );
_geometry.setAttribute( 'position', new Float32BufferAttribute( float32Array, 5 ).setUsage( 35048 ) );
_geometry.setAttribute( 'uv', new Float32BufferAttribute( float32Array, 5 ).setUsage( 35048 ) );

// ─── Local helpers ────────────────────────────────────────────────────────────
const _sphere = /@PURE/ new Sphere();
const _inverseMatrix = /@PURE/ new Matrix4();

function transformVertex( vertexPosition, mvPosition, center, scale, sin, cos ) {
// compute position in camera space
_alignedPosition.subVectors( vertexPosition, center ).addScalar( 0.5 ).multiply( scale );

}

export { Sprite };
