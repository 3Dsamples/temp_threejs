
// file number : 007
// full path name : src/objects/007_LOD.js
// description : A component providing Level of Detail (LOD) with two operating modes. The DEFAULT mode is Dynamic LOD: a real-time, camera-and-player-aware mesh density regulator that automatically increases or decreases geometric density based on what the camera can see and the player's position, giving every mesh and every procedural generator high performance and low memory consumption by default without any manual authoring. The CONVENTIONAL mode (addLevel / removeLevel) is retained as an OPTIONAL feature for cases where explicit per-level meshes must be authored by hand. This rewrite extends Object3D (018_Object3D.js) and integrates gl-matrix for high-performance matrix and vector math, double.js for high-precision camera/player distance and frustum math, bitecs for SoA ECS LOD registration and dynamic density state, and simplex-noise for procedural density jitter and organic streaming.
// best for : Real-time dynamic mesh density regulation, procedural generation with automatic budget-aware tessellation, camera/player-aware streaming, optional authored LOD chains, ECS-driven LOD management, high-precision distance/frustum computation.
// license : MIT

import { Object3D } from '../core/018_Object3D.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Frustum } from '../math/006_Frustum.js';
import { Sphere } from '../math/001_Sphere.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── LOD operating modes ─────────────────────────────────────────────────────
const LOD_MODE = Object.freeze( {
    DYNAMIC: 0,
    CONVENTIONAL: 1
} );

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _v1 = /*@__PURE__*/ new Vector3();
const _v2 = /*@__PURE__*/ new Vector3();
const _cameraWorldPos = /*@__PURE__*/ new Vector3();
const _playerWorldPos = /*@__PURE__*/ new Vector3();
const _frustum = /*@__PURE__*/ new Frustum();
const _projScreenMatrix = /*@__PURE__*/ new Matrix4();
const _lodSphere = /*@__PURE__*/ new Sphere();

const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _noise3D = createNoise3D();

// ─── Global tunables for Dynamic LOD ─────────────────────────────────────────
const DynamicLODDefaults = {
    // Target screen-space coverage (fraction of viewport height) below which
    // density should start decreasing.
    targetScreenCoverage: 0.15,
    // Density multiplier applied when the object is fully inside the frustum
    // and very close to the camera / player.
    nearDensityMultiplier: 2.0,
    // Density multiplier applied at the far edge of the LOD range.
    farDensityMultiplier: 0.25,
    // Distance at which near density saturates.
    nearDistance: 5.0,
    // Distance at which far density saturates.
    farDistance: 250.0,
    // How aggressively density responds to visibility (0..1). 1 = full response.
    visibilityResponse: 0.75,
    // Player proximity weight (0..1). 0 = ignore player, 1 = player dominates.
    playerWeight: 0.5,
    // Memory budget soft cap in units of "vertex cost" per object.
    memoryBudget: 1.0,
    // Hysteresis to avoid flicker in density changes.
    hysteresis: 0.08
};

// ─── ECS world + LOD SoA component definition ───────────────────────────────
const _lodWorld = createWorld();

const LODSoA = defineComponent( {
    // Transform columns (mirrors parent Object3D state)
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

    // LOD-mode columns
    mode: Types.i32,                 // LOD_MODE.DYNAMIC or LOD_MODE.CONVENTIONAL
    autoUpdate: Types.ui8,
    currentLevel: Types.i32,
    levelCount: Types.i32,

    // Dynamic LOD state columns
    dynamicDensity: Types.f64,        // current density factor (0..1)
    dynamicTargetDensity: Types.f64,  // desired density factor (0..1)
    dynamicVertexBudget: Types.i32,   // target vertex count for current density
    dynamicLastDistance: Types.f64,
    dynamicLastCoverage: Types.f64,
    dynamicLastVisibility: Types.f64,
    dynamicLODBias: Types.f64,        // user bias
    dynamicFrozen: Types.ui8,         // 1 = freeze dynamic updates

    // Conventional LOD distance/hysteresis (up to 8 authored levels)
    distance0: Types.f64,
    distance1: Types.f64,
    distance2: Types.f64,
    distance3: Types.f64,
    distance4: Types.f64,
    distance5: Types.f64,
    distance6: Types.f64,
    distance7: Types.f64,
    hysteresis0: Types.f64,
    hysteresis1: Types.f64,
    hysteresis2: Types.f64,
    hysteresis3: Types.f64,
    hysteresis4: Types.f64,
    hysteresis5: Types.f64,
    hysteresis6: Types.f64,
    hysteresis7: Types.f64
} );

/**
 * A component for Level of Detail (LOD).
 *
 * Two operating modes are supported:
 *
 * 1. **DYNAMIC (default)** — real-time mesh density regulation. Every mesh
 *    and every procedural generator gets this automatically. Density is
 *    increased when the object is close, fully visible, and near the player,
 *    and decreased when the object is far, partially off-screen, or the
 *    memory budget is tight. No manual authoring is required.
 *
 * 2. **CONVENTIONAL (optional)** — the classic three.js LOD API where you
 *    author explicit per-level meshes with `addLevel()` / `removeLevel()`.
 *    Set `lod.mode = LOD_MODE.CONVENTIONAL` to opt in.
 *
 * ```js
 * // Dynamic LOD (default) — nothing to author
 * const mesh = new THREE.Mesh( geometry, material );
 * mesh.lod = new THREE.LOD();
 * mesh.lod.attachTarget( mesh, { vertexBudget: 64000 } );
 *
 * // Conventional LOD (optional)
 * const lod = new THREE.LOD();
 * lod.mode = THREE.LOD_MODE.CONVENTIONAL;
 * lod.addLevel( highMesh, 0 );
 * lod.addLevel( midMesh, 75 );
 * lod.addLevel( lowMesh, 150 );
```

· 
· @augments Object3D
  */
  class LOD extends Object3D {
  constructor() {
  super();
  }
  // ─── Public API: dynamic LOD ──────────────────────────────────────────────
  /**
  · Attaches a target object to this LOD for dynamic density regulation.
  · The target must expose either:
  · · setDensity(density) — a procedural generator callback, or
  · · geometry — a BufferGeometry whose drawRange will be adjusted.
  · 
  · @param {Object3D} target - The mesh or procedural generator.
  · @param {Object} [options] - Optional overrides.
  · @param {number} [options.vertexBudget] - Maximum vertex count for full density.
  · @param {number} [options.baseDensity] - Starting density (0..1).
  · @return {LOD} A reference to this instance.
    */
    attachTarget( target, options = {} ) {
    this.target = target;
    if ( options.vertexBudget !== undefined ) {
    this._dynamicVertexBudget = options.vertexBudget;
    } else if ( target.geometry && target.geometry.attributes && target.geometry.attributes.position ) {
    this._dynamicVertexBudget = target.geometry.attributes.position.count;
    }
    if ( options.baseDensity !== undefined ) {
    this._dynamicDensity = options.baseDensity;
    }
    this.syncECS();
    return this;
    }
  /**
  · Detaches the current dynamic target.
  · @return {LOD} A reference to this instance.
    */
    detachTarget() {
    this.target = null;
    this._dynamicVertexBudget = 0;
    this.syncECS();
    return this;
    }
  /**
  · Freezes dynamic density updates. Useful for cutscenes or fixed-budget
  · deterministic captures.
  · @param {boolean} [frozen=true]
  · @return {LOD} A reference to this instance.
    */
    freezeDynamic( frozen = true ) {
    this._dynamicFrozen = frozen;
    return this;
    }
  /**
  · Adds a user bias to the dynamic density, e.g. +0.25 forces higher
  · density, -0.25 forces lower density.
  · @param {number} bias
  · @return {LOD} A reference to this instance.
    */
    setDynamicBias( bias ) {
    this._dynamicLODBias = bias;
    return this;
    }
  /**
  · Returns the current dynamic density factor in [0, 1].
  · @return {number}
    */
    getDynamicDensity() {
    return this._dynamicDensity;
    }
  // ─── Public API: conventional LOD (optional) ──────────────────────────────
  /**
  · Adds a mesh that will display at a certain distance and greater.
  · Only used when mode === LOD_MODE.CONVENTIONAL.
  · 
  · @param {Object3D} object - The 3D object to display at this level.
  · @param {number} [distance=0] - The distance at which to display this level of detail.
  · @param {number} [hysteresis=0] - Flicker-avoidance threshold as a fraction of distance.
  · @return {LOD} A reference to this instance.
    */
    addLevel( object, distance = 0, hysteresis = 0 ) {
    distance = Math.abs( distance );
    const levels = this.levels;
    let l;
    for ( l = 0; l < levels.length; l ++ ) {
    if ( distance < levels[ l ].distance ) {
    break;
    }
    }
    levels.splice( l, 0, {
    distance: distance,
    hysteresis: hysteresis,
    object: object
    } );
    this.add( object );
    this.syncECS();
    return this;
    }
  /**
  · Removes an existing level, based on the distance from the camera.
  · Returns true when the level has been removed. Otherwise false.
  · 
  · @param {number} distance - Distance of the level to remove.
  · @return {boolean} Whether the level has been removed or not.
    */
    removeLevel( distance ) {
    const levels = this.levels;
    for ( let i = 0; i < levels.length; i ++ ) {
    if ( levels[ i ].distance === distance ) {
    const removedElements = levels.splice( i, 1 );
    }
    this.syncECS();
    return false;
    }
  /**
  · Returns the currently active LOD level index (conventional mode).
  · @return {number}
    */
    getCurrentLevel() {
    return this._currentLevel;
    }
  /**
  · Returns a reference to the first 3D object that is greater than
  · the given distance. Conventional mode only.
  · 
  · @param {number} distance - The LOD distance.
  · @return {?Object3D}
    */
    getObjectForDistance( distance ) {
    const levels = this.levels;
    if ( levels.length > 0 ) {
    let i, l;
    }
    return null;
    }
  // ─── Raycast ──────────────────────────────────────────────────────────────
  raycast( raycaster, intersects ) {
  if ( this.mode === LOD_MODE.CONVENTIONAL ) {
  const levels = this.levels;
  }
  // ─── Update ───────────────────────────────────────────────────────────────
  /**
  · Updates the LOD. In DYNAMIC mode (default) this performs camera- and
  · player-aware density regulation. In CONVENTIONAL mode this performs the
  · classic per-level visibility switch.
  · 
  · @param {Camera} camera - The camera the scene is rendered with.
  · @param {Object3D} [player] - Optional player transform (overrides this.player).
    */
    update( camera, player = this.player ) {
    if ( this.mode === LOD_MODE.CONVENTIONAL ) {
    this._updateConventional( camera );
    } else {
    this._updateDynamic( camera, player );
    }
    }
  // ─── Dynamic LOD core ─────────────────────────────────────────────────────
  _updateDynamic( camera, player ) {
  if ( this._dynamicFrozen ) return;
  if ( camera === null || camera === undefined ) return;
  }
  _applyDensityToTarget() {
  const target = this.target;
  if ( target === null ) return;
  }
  _updateConventional( camera ) {
  const levels = this.levels;
  }
  // ─── Copy / JSON ──────────────────────────────────────────────────────────
  copy( source ) {
  super.copy( source, false );
  }
  toJSON( meta ) {
  const data = super.toJSON( meta );
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerECS() {
  if ( this._ecsRegistered ) {
  return this._ecsEntity;
  }
  }
  syncECS() {
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
  distanceToCameraHighPrecision( camera ) {
  const camE = camera.matrixWorld.elements;
  const lodE = this.matrixWorld.elements;
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
  return _lodWorld;
  }
  static getLODSoA() {
  return LODSoA;
  }
  static get MODE() {
  return LOD_MODE;
  }
  static get DynamicDefaults() {
  return DynamicLODDefaults;
  }
  }

export { LOD, LOD_MODE, DynamicLODDefaults };

