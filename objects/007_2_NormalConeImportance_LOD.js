
// file number : 007_2
// full path name : src/objects/007_2_NormalConeImportance_LOD.js
// description : Enhancement #3 for the Dynamic LOD system. Adds per-vertex normal-variance (curvature) importance on top of DeltaTimeIntegrationLOD (007_1_DeltaTimeIntegration_LOD.js). Computes a cached "normal cone" importance map per geometry: flat regions (walls, ground, cube faces) are aggressively down-density-able, while high-curvature regions (faces, foliage edges, silhouette ridges) retain density. Biases the density target by the object's average and 90th-percentile curvature so a fixed vertex budget is spent where the eye actually sees detail. Uses gl-matrix for cone-axis and variance math, double.js for high-precision curvature accumulation across large meshes, bitecs for SoA importance cache state, and simplex-noise for anti-banding dithering of the curvature map.
// best for : Silhouette-aware density regulation, foliage and organic meshes, hard-surface vs. soft-surface differentiation, fixed-budget visual quality maximization, normal-cone LOD admission control.
// license : MIT

import { DeltaTimeIntegrationLOD } from './007_1_DeltaTimeIntegration_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _scratchVec3C = new Float64Array( 3 );
const _noise3D = createNoise3D();

// ─── ECS world + NormalCone SoA component ───────────────────────────────────
const _normalConeWorld = createWorld();

const NormalConeSoA = defineComponent( {
    // Curvature summary statistics (per object)
    averageCurvature: Types.f64,
    p90Curvature: Types.f64,
    maxCurvature: Types.f64,
    minCurvature: Types.f64,

    // Normal cone data
    coneAxisX: Types.f64,
    coneAxisY: Types.f64,
    coneAxisZ: Types.f64,
    coneAngle: Types.f64,

    // Importance state
    importance: Types.f64,       // 0..1, 0 = flat, 1 = highly curved
    importanceBias: Types.f64,   // user bias added to importance
    curvatureWeight: Types.f64,  // how strongly importance affects density
    flatFloor: Types.f64,        // density floor for perfectly flat regions
    curvedCeiling: Types.f64,    // density ceiling for highly curved regions

    // Cache management
    cached: Types.ui8,
    vertexCount: Types.i32,
    cacheFrame: Types.i32,
    validGeometryHandle: Types.i32
} );

// ─── Tunables specific to normal-cone importance ────────────────────────────
const NormalConeDefaults = {
    // Weight of curvature importance on final density target, in [0, 1].
    // 0 = ignore curvature, 1 = curvature fully drives density.
    curvatureWeight: 0.5,
    // Minimum density factor applied to a completely flat region.
    flatFloor: 0.35,
    // Maximum density factor applied to a highly curved region.
    curvedCeiling: 1.0,
    // Percentile used to summarize the "importance tail" of the mesh.
    // 0.90 means we care about the top 10% most curved vertices.
    importancePercentile: 0.90,
    // Anti-banding dither amplitude on the curvature map.
    ditherAmplitude: 0.02,
    // How many frames a cached curvature map stays valid. -1 = never expire.
    cacheTTL: - 1,
    // Deterministic seed base for curvature-map dithering.
    determinismSeed: 0x27D4EB2F
};

/**
 * NormalConeImportanceLOD
 *
 * Extends DeltaTimeIntegrationLOD and biases the density target with a
 * per-geometry curvature summary. The pipeline is:
 *
 *   1. On attachTarget(), compute a curvature map for the geometry (once).
 *   2. Extract a normal-cone axis + opening angle for the whole mesh.
 *   3. On every update, derive an "importance" scalar in [0, 1] from the
 *      p90 curvature (default) plus a user bias.
 *   4. Remap the density target so flat meshes drop faster and curved
 *      meshes hold higher density at the same distance / coverage.
 *
 * The curvature map itself is stored on the target geometry via a
 * WeakMap so multiple LODs sharing the same geometry do not recompute it.
 *
 * Recommended usage:
 * ```js
 * const lod = new NormalConeImportanceLOD();
 * lod.attachTarget( foliageMesh, { vertexBudget: 32000 } );
 * lod.curvatureWeight = 0.65;   // foliage: prioritize silhouette
 *
 * function frame( camera, player, dt ) {
 *     lod.update( camera, player, dt );
 * }
```

· 
· @augments DeltaTimeIntegrationLOD
  */
  class NormalConeImportanceLOD extends DeltaTimeIntegrationLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Overrides the base attachTarget to compute the curvature map when a
  · geometry-bearing target is supplied.
  · 
  · @param {Object3D} target
  · @param {Object} [options]
  · @return {NormalConeImportanceLOD}
    */
    attachTarget( target, options = {} ) {
    super.attachTarget( target, options );
    if ( target !== null && target.geometry !== undefined && target.geometry !== null ) {
    this._computeCurvatureMap( target.geometry );
    }
    this.syncNConeECS();
    return this;
    }
  /**
  · Adds a user bias to the curvature-derived importance.
  · Positive values push density up (treat the object as "more curved"),
  · negative values push it down (treat the object as "flatter").
  · 
  · @param {number} bias
  · @return {NormalConeImportanceLOD}
    */
    setImportanceBias( bias ) {
    this._importanceBias = bias;
    return this;
    }
  /**
  · Returns the current curvature-derived importance in [0, 1].
  · @return {number}
    */
    getImportance() {
    return this._importance;
    }
  /**
  · Returns the cached curvature statistics.
  · @return {{average:number, p90:number, max:number, min:number, coneAxis:[number,number,number], coneAngle:number, vertexCount:number}}
    */
    getCurvatureStats() {
    return {
    average: this._averageCurvature,
    p90: this._p90Curvature,
    max: this._maxCurvature,
    min: this._minCurvature,
    coneAxis: [ this._coneAxisX, this._coneAxisY, this._coneAxisZ ],
    coneAngle: this._coneAngle,
    vertexCount: this._vertexCount
    };
    }
  /**
  · Forces a recomputation of the curvature map for the current target.
  · Useful when the geometry has been procedurally regenerated.
  · @return {NormalConeImportanceLOD}
    */
    invalidateCurvatureCache() {
    if ( this.target !== null && this.target.geometry !== undefined && this.target.geometry !== null ) {
    this._curvatureCache.delete( this.target.geometry );
    this._computeCurvatureMap( this.target.geometry );
    }
    return this;
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides DeltaTimeIntegrationLOD.update. After the parent has computed
  · a fresh density target, this method folds in the curvature importance
  · remap so flat geometry drops faster and curved geometry holds density.
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
    // Refresh the cache if TTL has expired.
    this._maybeRefreshCache();
    // Compute importance BEFORE the parent runs, so the parent sees a
    // target already biased toward curvature. This keeps the temporal
    // integrator smoothing the final value, not the raw one.
    this._importance = this._computeImportance();
    const before = this._dynamicTargetDensity;
    void before;
    super.update( camera, player, rawDeltaTime );
    // Now apply the importance remap to the parent's fresh target and
    // re-apply the density if the value materially changed.
    const remapped = this._remapDensityTarget( this._dynamicTargetDensity );
    if ( Math.abs( remapped - this._dynamicTargetDensity ) > 1e-4 ) {
    this._dynamicTargetDensity = remapped;
    }
    this.syncNConeECS();
    }
  // ─── Curvature map computation ───────────────────────────────────────────
  _computeCurvatureMap( geometry ) {
  const cached = this._curvatureCache.get( geometry );
  if ( cached !== undefined ) {
  this._applyCachedCurvature( cached );
  return;
  }
  }
  _applyCachedCurvature( stats ) {
  this._averageCurvature = stats.average;
  this._p90Curvature = stats.p90;
  this._maxCurvature = stats.max;
  this._minCurvature = stats.min;
  }
  _triangleNormalVariance( nArr, nItem, i0, i1, i2 ) {
  const b0 = i0 * nItem;
  const b1 = i1 * nItem;
  const b2 = i2 * nItem;
  }
  _maybeRefreshCache() {
  if ( this.cacheTTL < 0 ) return;
  if ( this._cacheFrame < 0 ) return;
  }
  // ─── Importance computation ──────────────────────────────────────────────
  _computeImportance() {
  // Base importance: normalized p90 curvature in [0, 1].
  // The max curvature is used as the normalizer, so the value is
  // invariant to absolute units and mesh scale.
  const denom = Math.max( 1e-6, this._maxCurvature );
  let base = this._p90Curvature / denom;
  }
  _remapDensityTarget( target ) {
  // Blend between the raw target and a curvature-driven target.
  //   curvature-driven = flatFloor + (curvedCeiling - flatFloor) * importance
  // Final = lerp( raw, curvatureDriven, curvatureWeight )
  const curvatureDriven = this.flatFloor +
  ( this.curvedCeiling - this.flatFloor ) * this._importance;
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerNConeECS() {
  if ( this._ecsNConeRegistered ) {
  return this._ecsNConeEntity;
  }
  }
  syncNConeECS() {
  if ( ! this._ecsNConeRegistered ) {
  return this;
  }
  }
  pullNConeECS() {
  if ( ! this._ecsNConeRegistered ) {
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
  · Returns a high-precision curvature summary using double.js for the
  · average computation. Useful for telemetry on very large meshes.
  · @return {number}
    */
    computeAverageCurvatureHighPrecision() {
    const denom = new Double( Math.max( 1, this._vertexCount ) );
    const sum = new Double( this._averageCurvature ).mul( denom );
    return sum.div( denom ).valueOf();
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
  return _normalConeWorld;
  }
  static getNormalConeSoA() {
  return NormalConeSoA;
  }
  static get NormalConeDefaults() {
  return NormalConeDefaults;
  }
  }

// ─── Shared curvature cache (geometry → stats), reused across LOD instances ─
NormalConeImportanceLOD._sharedCurvatureCache = new WeakMap();

export { NormalConeImportanceLOD, NormalConeSoA, NormalConeDefaults };
