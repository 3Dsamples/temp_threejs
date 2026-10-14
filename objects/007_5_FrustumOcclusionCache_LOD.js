
// file number : 007_5
// full path name : src/objects/007_5_FrustumOcclusionCache_LOD.js
// description : Enhancement #6 for the Dynamic LOD system. Adds cached frustum plane computation and an optional occlusion mask so that visibility is computed once per camera per frame instead of once per object per frame. Frustum planes are packed into a Float64Array and shared across all registered LODs through a static cache keyed by camera uuid + matrixWorld revision. Occlusion is supplied by an external mask provider (software HiZ, Godot 4.6 occlusion culling signal, or a custom buffer) and consulted only for LODs whose frustum test is ambiguous. A per-frame visibility ledger tracks occluded / frustum-rejected / visible LODs. Uses gl-matrix for plane extraction and sphere-plane math, double.js for high-precision plane-distance accumulation on huge worlds, bitecs for SoA visibility cache state, and simplex-noise for occlusion-mask dithering that prevents hard pop on occlusion boundary edges.
// best for : Scene-wide visibility caching, large worlds with thousands of LODs, occlusion-culling-driven density, VR per-eye visibility, split-screen multi-camera visibility, Godot 4.6 occlusion culling integration, software HiZ pipelines, frustum-aware budget allocation.
// license : MIT

import { GlobalBudgetAllocatorLOD } from './007_4_GlobalBudgetAllocator_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchMat4B = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchPlane = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + FrustumOcclusion SoA component ─────────────────────────────
const _frustumWorld = createWorld();

const FrustumOcclusionSoA = defineComponent( {
    // Frustum state
    inFrustum: Types.ui8,
    frustumTestFrame: Types.i32,
    distanceToNearPlane: Types.f64,
    distanceToFarPlane: Types.f64,

    // Occlusion state
    occluded: Types.ui8,
    occlusionTestFrame: Types.i32,
    occlusionConfidence: Types.f64,   // 0..1, 1 = definitely occluded
    occlusionMaskValue: Types.f64,    // raw value from mask provider

    // Combined visibility
    visibility: Types.f64,            // 0..1, fed to the SSE / density pipeline
    visibilitySource: Types.i32,      // 0 = frustum, 1 = occlusion, 2 = both

    // Caching
    cached: Types.ui8,
    cacheFrame: Types.i32,
    cameraUuidHash: Types.i32,

    // Multi-camera reduction
    maxVisibilityAcrossCameras: Types.f64,
    cameraCount: Types.i32,

    // Dither
    lastDither: Types.f64
} );

// ─── Tunables specific to frustum / occlusion caching ───────────────────────
const FrustumOcclusionDefaults = {
    // Number of frames a frustum result is valid for before recomputation.
    frustumCacheTTL: 1,

    // Number of frames an occlusion result is valid for.
    occlusionCacheTTL: 4,

    // Padding added to the frustum test sphere (world units).
    frustumPadding: 0.05,

    // Whether to use the external occlusion mask provider if available.
    useOcclusionMask: true,

    // Minimum occlusion confidence required to fully reject an LOD.
    occlusionRejectionThreshold: 0.85,

    // Confidence below which the LOD is treated as fully visible.
    occlusionVisibleThreshold: 0.15,

    // Dithering amplitude applied to the occlusion confidence to avoid
    // hard pop on occlusion boundary edges.
    occlusionDitherAmplitude: 0.05,

    // Deterministic seed base.
    determinismSeed: 0x9E3779B1,

    // Multi-camera reduction mode:
    //   0 = max visibility (VR / split-screen, no LOD disappearing)
    //   1 = min visibility (aggressive culling, single-view only)
    //   2 = weighted average
    multiCameraMode: 0,

    // Maximum number of cameras processed per frame.
    maxCamerasPerFrame: 8
};

/**
 * FrustumOcclusionCacheLOD
 *
 * Extends GlobalBudgetAllocatorLOD and replaces the per-object frustum
 * computation with a shared, cached frustum plane array. The cache is keyed
 * by the camera's `uuid` hash and its `matrixWorld` revision, so all LODs in
 * the same scene reuse a single plane extraction per camera per frame.
 *
 * The occlusion path is optional. Hosts may install an
 * `OcclusionMaskProvider` object with a `sample(x, y, z, radius)` method
 * that returns a value in `[0, 1]` (0 = fully visible, 1 = fully occluded).
 * If no provider is installed, the LOD falls back to frustum-only visibility.
 *
 * The resulting visibility scalar feeds into the SSE-driven density target
 * as a multiplicative term, so occluded geometry drops density aggressively
 * while still retaining a small safety margin to avoid pop when it re-emerges.
 *
 * Multi-camera support is built in: `beginFrame( cameras )` accepts an array
 * of cameras and the per-LOD visibility is reduced across all of them.
 *
 * Recommended usage:
 * ```js
 * const lod = new FrustumOcclusionCacheLOD();
 * lod.attachTarget( mesh, { vertexBudget: 64000 } );
 * lod.registerWithAllocator( 'world' );
 *
 * // Per frame
 * FrustumOcclusionCacheLOD.beginFrame( frameIndex, [ camera ] );
 * for ( const lod of allLODs ) lod.update( camera, player, dt );
 * GlobalBudgetAllocatorLOD.flushAllocation();
```

· 
· @augments GlobalBudgetAllocatorLOD
  */
  class FrustumOcclusionCacheLOD extends GlobalBudgetAllocatorLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Returns the current combined visibility in [0, 1].
  · @return {number}
    */
    getVisibility() {
    return this._visibility;
    }
  /**
  · Returns true if the LOD is currently considered occluded.
  · @return {boolean}
    */
    isOccluded() {
    return this._occluded === 1;
    }
  /**
  · Returns true if the LOD is inside the current frustum.
  · @return {boolean}
    */
    isInFrustum() {
    return this._inFrustum === 1;
    }
  /**
  · Returns a high-precision visibility ledger for telemetry.
  · @return {object}
    */
    getVisibilityLedger() {
    const v = new Double( this._visibility );
    const o = new Double( this._occlusionConfidence );
    const d = new Double( this._distanceToNearPlane );
    return {
    visibility: v.valueOf(),
    inFrustum: this._inFrustum === 1,
    occluded: this._occluded === 1,
    occlusionConfidence: o.valueOf(),
    distanceToNearPlane: d.valueOf(),
    visibilitySource: this._visibilitySource,
    cameraCount: this._cameraCount,
    cameraUuidHash: this._cameraUuidHash
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides GlobalBudgetAllocatorLOD.update. Before the parent chain runs,
  · this method refreshes the cached frustum and (optionally) samples the
  · occlusion mask, then folds the resulting visibility scalar into the
  · density target as a multiplicative term.
  · 
  · @param {Camera} camera
  · @param {Object3D} [player]
  · @param {number} [rawDeltaTime]
    */
    update( camera, player = this.player, rawDeltaTime = 0.016 ) {
    if ( this.mode === LOD_MODE.CONVENTIONAL ) {
    super.update( camera, player, rawDeltaTime );
    return;
    }
    // ── 1. Refresh visibility from cache / mask. ────────────────────────
    this._refreshVisibility( camera );
    // ── 2. Parent chain runs SSE, curvature, temporal, allocator. ───────
    super.update( camera, player, rawDeltaTime );
    // ── 3. Fold visibility into the density target. ─────────────────────
    // Visibility 1 → no change. Visibility 0 → collapse to the minimum.
    const vis = this._visibility;
    // Preserve a minimum safety margin so occluded geometry does not
    // fully disappear at the boundary and cause a visible pop.
    const safetyFloor = 0.05;
    const visFactor = safetyFloor + ( 1.0 - safetyFloor ) * vis;
    const before = this._dynamicTargetDensity;
    let after = before * visFactor;
    after = Math.min( 1.0, Math.max( 0.0, after ) );
    if ( Math.abs( after - before ) > 1e-4 ) {
    this._dynamicTargetDensity = after;
    }
    this.syncFrustumECS();
    }
  // ─── Visibility refresh ─────────────────────────────────────────────────
  _refreshVisibility( camera ) {
  if ( camera === null || camera === undefined ) {
  this._visibility = 1.0;
  this._inFrustum = 1;
  this._occluded = 0;
  return;
  }
  }
  _testFrustum( cache ) {
  const lodE = this.matrixWorld.elements;
  glMatrix.vec3.set( _scratchVec3A, lodE[ 12 ], lodE[ 13 ], lodE[ 14 ] );
  }
  _planeDistance( planes, planeIndex, point ) {
  const b = planeIndex * 4;
  const nx = planes[ b ];
  const ny = planes[ b + 1 ];
  const nz = planes[ b + 2 ];
  const d = planes[ b + 3 ];
  }
  // ─── Static frustum cache ─────────────────────────────────────────────────
  static beginFrame( frameIndex, cameras = [] ) {
  GlobalBudgetAllocatorLOD.beginFrame( frameIndex );
  }
  /**
  · Installs an external occlusion mask provider. The provider must expose
  · sample(x, y, z, radius) returning a value in [0, 1].
  · @param {object|null} provider
    */
    static setOcclusionProvider( provider ) {
    FrustumOcclusionCacheLOD._occlusionProvider = provider;
    }
  /**
  · Returns the currently installed occlusion provider, or null.
  · @return {object|null}
    */
    static getOcclusionProvider() {
    return FrustumOcclusionCacheLOD._occlusionProvider;
    }
  static _registerFrustumLOD( lod ) {
  FrustumOcclusionCacheLOD._registeredFrustum.add( lod );
  }
  static _unregisterFrustumLOD( lod ) {
  FrustumOcclusionCacheLOD._registeredFrustum.delete( lod );
  }
  static _getOrBuildFrustumCache( camera ) {
  const uuidHash = FrustumOcclusionCacheLOD._hashString( camera.uuid );
  const revision = FrustumOcclusionCacheLOD._cameraRevision( camera );
  }
  static _extractPlane( out, planeIndex, m, rowA, rowB, sign ) {
  const a = rowA * 4;
  const b = rowB * 4;
  }
  static _hashString( s ) {
  let h = 0x811c9dc5;
  for ( let i = 0; i < s.length; i ++ ) {
  h ^= s.charCodeAt( i );
  h = Math.imul( h, 0x01000193 );
  }
  return h >>> 0;
  }
  static _cameraRevision( camera ) {
  // Use the matrixWorld elements checksum as a coarse revision key.
  const e = camera.matrixWorld.elements;
  let h = 0x811c9dc5;
  for ( let i = 0; i < 16; i ++ ) {
  const v = Math.round( e[ i ] * 1e5 ) | 0;
  h ^= v;
  h = Math.imul( h, 0x01000193 );
  }
  return h >>> 0;
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerFrustumECS() {
  if ( this._ecsFrustumRegistered ) {
  return this._ecsFrustumEntity;
  }
  }
  syncFrustumECS() {
  if ( ! this._ecsFrustumRegistered ) {
  return this;
  }
  }
  pullFrustumECS() {
  if ( ! this._ecsFrustumRegistered ) {
  return this;
  }
  }
  // ─── Copy / JSON ──────────────────────────────────────────────────────────
  copy( source ) {
  super.copy( source );
  }
  toJSON( meta ) {
  const data = super.toJSON( meta );
  }
  // ─── gl-matrix / double.js / simplex-noise utilities ───────────────────────
  multiplyMat4GL( out, a, b ) {
  glMatrix.mat4.multiply( out || _scratchMat4, a, b );
  return out || _scratchMat4;
  }
  /**
  · High-precision sphere-plane test using double.js. Useful for very
  · large worlds where the Float64 plane distance loses precision.
  · @param {Float64Array} planes
  · @param {number} planeIndex
  · @param {number} x
  · @param {number} y
  · @param {number} z
  · @return {number}
    */
    planeDistanceHighPrecision( planes, planeIndex, x, y, z ) {
    const b = planeIndex * 4;
    const nx = new Double( planes[ b ] );
    const ny = new Double( planes[ b + 1 ] );
    const nz = new Double( planes[ b + 2 ] );
    const d = new Double( planes[ b + 3 ] );
    return nx.mul( new Double( x ) )
    .add( ny.mul( new Double( y ) ) )
    .add( nz.mul( new Double( z ) ) )
    .add( d )
    .valueOf();
    }
  /**
  · Returns a deterministic dither sample for the occlusion boundary.
  · @param {number} frameIndex
  · @return {number}
    */
    computeOcclusionDither( frameIndex ) {
    const seed = ( this.determinismSeed ^ ( this._ecsEntity >>> 0 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.02, this.id );
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
  /**
  · Packs visibility telemetry into a vec4 for GPU debug rendering.
  · Layout: (visibility, occlusionConfidence, inFrustum, occluded)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packVisibilityVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._visibility,
    this._occlusionConfidence,
    this._inFrustum,
    this._occluded
    );
    return v;
    }
  static getECSWorld() {
  return _frustumWorld;
  }
  static getFrustumSoA() {
  return FrustumOcclusionSoA;
  }
  static get FrustumOcclusionDefaults() {
  return FrustumOcclusionDefaults;
  }
  }

// ─── Static cache storage (module-scoped, shared across all instances) ──────
FrustumOcclusionCacheLOD._frameIndex = 0;
FrustumOcclusionCacheLOD._registeredFrustum = new Set();
FrustumOcclusionCacheLOD._frustumCache = null;
FrustumOcclusionCacheLOD._occlusionProvider = null;
FrustumOcclusionCacheLOD._activeCameras = [];

export {
FrustumOcclusionCacheLOD,
FrustumOcclusionSoA,
FrustumOcclusionDefaults
};

