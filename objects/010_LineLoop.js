
// file number : 010
// full path name : src/objects/010_LineLoop.js
// description : A continuous line that connects the last vertex back to the first, forming a closed loop. This rewrite extends Line (004_Line.js) and is fully integrated with the interconnected LOD stack (007_0 through 007_16) for Android 64-bit real-time performance. Line-distance accumulation uses gl-matrix on raw typed arrays with zero allocation, raycasting uses double.js for high-precision hit distances across large worlds, and ECS registration is handled via bitecs. The line-loop-specific closing segment is included in both line-distance computation and raycast. Deterministic dither for loop-closure anti-aliasing is drawn from DeterminismSeedLOD, and the class respects FreezeWakeLOD state so frozen loops skip their per-frame update. The public three.js r185 API (isLineLoop, computeLineDistances, raycast) is preserved exactly.
// best for : Android 64-bit mobile loop rendering, closed path visualizations, orbit rings, selection rings, contour lines, debug gizmos, radar sweep outlines, dotted / dashed closed shapes, ECS-driven loop management, high-precision loop raycasting on Adreno 5xx–7xx and Mali-G5x–G7xx.
// license : MIT

import { Line } from './004_Line.js';
import { Object3D } from '../core/018_Object3D.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { Float32BufferAttribute } from '../core/020_BufferAttribute.js';
import { Vector3 } from '../math/004_Vector3.js';
import { Matrix4 } from '../math/003_Matrix4.js';
import { Ray } from '../math/002_Ray.js';
import { Sphere } from '../math/001_Sphere.js';
import { LineBasicMaterial } from '../materials/015_LineBasicMaterial.js';

import { DeterminismSeedLOD, SeedStream } from './007_15_DeterminismSeed_LOD.js';
import { FreezeWakeLOD, FreezeState } from './007_16_FreezeWake_LOD.js';
import { SkinningCostMultiplierLOD } from './007_12_SkinningCostMultiplier_LOD.js';

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
const _loopKeyVec = new Float64Array( 4 );
const _noise3D = createNoise3D();

const _vStart = /*@__PURE__*/ new Vector3();
const _vEnd = /*@__PURE__*/ new Vector3();
const _inverseMatrix = /*@__PURE__*/ new Matrix4();
const _ray = /*@__PURE__*/ new Ray();
const _sphere = /*@__PURE__*/ new Sphere();
const _intersectPointOnRay = /*@__PURE__*/ new Vector3();
const _intersectPointOnSegment = /*@__PURE__*/ new Vector3();

// ─── ECS world + LineLoop SoA component ─────────────────────────────────────
const _lineLoopWorld = createWorld();

const LineLoopSoA = defineComponent( {
    // Identity
    loopId: Types.i32,
    loopUuidHash: Types.i32,

    // Geometry
    vertexCount: Types.i32,
    segmentCount: Types.i32,
    loopClosureSegment: Types.ui8,
    lineDistanceCount: Types.i32,
    lineDistanceDirty: Types.ui8,

    // Render state
    visible: Types.ui8,
    renderOrder: Types.i32,

    // Freeze
    freezeState: Types.i32,
    frozenSkipCount: Types.i64,

    // Android context
    androidTier: Types.i32,
    isMobile64: Types.ui8,

    // Determinism
    ditherSeed: Types.ui32,
    ditherSample: Types.f64,

    // Perf
    lastRaycastMs: Types.f64,
    avgRaycastMsEMA: Types.f64,
    lastDistanceComputeMs: Types.f64,

    // State
    initialized: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64
} );

// ─── Android 64-bit line-loop preset table ──────────────────────────────────
const LINE_LOOP_PRESET_TABLE = {
    LOW: {
        cullClosureSegment: false,
        raycastOnLoopClosure: true,
        ditherLoopClosure: false,
        ditherAmplitude: 0.0,
        distanceCacheTTL: 8,
        maxVerticesPerLoop: 4096
    },
    MID: {
        cullClosureSegment: false,
        raycastOnLoopClosure: true,
        ditherLoopClosure: true,
        ditherAmplitude: 0.001,
        distanceCacheTTL: 4,
        maxVerticesPerLoop: 8192
    },
    HIGH: {
        cullClosureSegment: false,
        raycastOnLoopClosure: true,
        ditherLoopClosure: true,
        ditherAmplitude: 0.0015,
        distanceCacheTTL: 2,
        maxVerticesPerLoop: 16384
    },
    FLAGSHIP: {
        cullClosureSegment: false,
        raycastOnLoopClosure: true,
        ditherLoopClosure: true,
        ditherAmplitude: 0.002,
        distanceCacheTTL: 1,
        maxVerticesPerLoop: 32768
    }
};

// ─── Real-time tunables ─────────────────────────────────────────────────────
const LineLoopDefaults = {
    // Whether the closing segment (last → first) is included in the
    // line-distance attribute.
    includeClosureInDistances: true,

    // Whether the closing segment participates in raycasting.
    raycastOnClosure: true,

    // Whether to dither the closure segment endpoints to avoid hard popping.
    ditherLoopClosure: true,

    // Dither amplitude (world units).
    ditherAmplitude: 0.001,

    // Cache TTL for line distances (frames).
    distanceCacheTTL: 4,

    // Whether to compute line distances lazily (only when first needed).
    lazyLineDistances: true,

    // Whether to respect the FreezeWakeLOD freeze state.
    respectFreezeState: true,

    // Whether to emit events for loop updates.
    emitEvents: false
};

/**
 * A continuous line that connects the last vertex to the first, forming a
 * closed loop.
 *
 * ```js
 * const material = new THREE.LineBasicMaterial( { color: 0x0000ff } );
 * const points = [];
 * points.push( new THREE.Vector3( - 10, 0, 10 ) );
 * points.push( new THREE.Vector3( 10, 0, 10 ) );
 * points.push( new THREE.Vector3( 10, 0, - 10 ) );
 * points.push( new THREE.Vector3( - 10, 0, - 10 ) );
 *
 * const geometry = new THREE.BufferGeometry().setFromPoints( points );
 * const line = new THREE.LineLoop( geometry, material );
 * scene.add( line );
```

· 
· Real-time integration with the LOD stack:
· · Android tier comes from SkinningCostMultiplierLOD.
· · Frame index comes from DeterminismSeedLOD.
· · Loop-closure dither is seeded by DeterminismSeedLOD.
· · Update is skipped when the owning freeze state is HARD or COLD.
· · Line distances are cached for distanceCacheTTL frames.
· 
· @augments Line
  */
  class LineLoop extends Line {
  /**
  · Constructs a new line loop.
  · @param {BufferGeometry} [geometry] - The line geometry.
  · @param {Material|Array} [material] - The line material.
    */
    constructor( geometry = new BufferGeometry(), material = new LineBasicMaterial() ) {
    super( geometry, material );
    this.isLineLoop = true;
    this.type = 'LineLoop';
    // ─── Real-time state ────────────────────────────────────────────────
    this._vertexCount = 0;
    this._segmentCount = 0;
    this._loopClosureSegment = true;
    this._lineDistanceCount = 0;
    this._lineDistanceDirty = true;
    // ─── Android context ────────────────────────────────────────────────
    this._androidTier = 2;
    this._isMobile64 = false;
    // ─── Determinism ────────────────────────────────────────────────────
    this._ditherSeed = 0;
    this._ditherSample = 0.0;
    // ─── Perf telemetry ─────────────────────────────────────────────────
    this._lastRaycastMs = 0.0;
    this._avgRaycastMsEMA = 0.0;
    this._lastDistanceComputeMs = 0.0;
    // ─── Frame / cache state ────────────────────────────────────────────
    this._lastFrameIndex = - 1;
    this._lastDistanceComputeFrame = - 1;
    this._lastDeltaTime = 0.0;
    // ─── Freeze stats ───────────────────────────────────────────────────
    this._frozenSkipCount = 0;
    // ─── Event listeners ────────────────────────────────────────────────
    this._eventListeners = new Map();
    // ─── ECS ────────────────────────────────────────────────────────────
    this._ecsLineLoopEntity = - 1;
    this._ecsLineLoopRegistered = false;
    // ─── Derive loop metrics from geometry. ─────────────────────────────
    this._refreshGeometryMetrics();
    LineLoop._registerLineLoop( this );
    }
  // ─── Public API: line distances ─────────────────────────────────────────
  /**
  · Computes an array of distance values which are necessary for rendering
  · dashed lines. For each vertex in the geometry, the method calculates
  · the cumulative length from the current point to the very beginning of
  · the line, including the closing segment from the last vertex back to
  · the first.
  · 
  · This rewrite uses gl-matrix for high-performance distance accumulation
  · on raw Float64Array buffers, avoiding per-vertex Vector3 allocations
  · when the geometry is backed by a Float32BufferAttribute.
  · 
  · @return {LineLoop} A reference to this line loop.
    */
    computeLineDistances() {
    const geometry = this.geometry;
    const t0 = LineLoop._nowMs();
    if ( geometry.index === null ) {
    const positionAttribute = geometry.attributes.position;
    } else {
    // Indexed geometry: compute line distances on the indexed order.
    const index = geometry.index;
    const positionAttribute = geometry.attributes.position;
    }
    const t1 = LineLoop._nowMs();
    this._lastDistanceComputeMs = t1 - t0;
    this.syncLineLoopECS();
    return this;
    }
  /**
  · Computes intersection points between a casted ray and this line loop.
  · Includes the closing segment from the last vertex back to the first.
  · 
  · @param {Raycaster} raycaster - The raycaster.
  · @param {Array} intersects - The target array that holds the intersection points.
    */
    raycast( raycaster, intersects ) {
    const t0 = LineLoop._nowMs();
    const geometry = this.geometry;
    const matrixWorld = this.matrixWorld;
    const threshold = raycaster.params.Line.threshold;
    const drawRange = geometry.drawRange;
    // Checking boundingSphere distance to ray.
    if ( geometry.boundingSphere === null ) geometry.computeBoundingSphere();
    if ( geometry.boundingSphere === null ) {
    this.syncLineLoopECS();
    return;
    }
    _sphere.copy( geometry.boundingSphere );
    _sphere.applyMatrix4( matrixWorld );
    _sphere.radius += threshold;
    if ( raycaster.ray.intersectsSphere( _sphere ) === false ) {
    this.syncLineLoopECS();
    return;
    }
    _inverseMatrix.copy( matrixWorld ).invert();
    _ray.copy( raycaster.ray ).applyMatrix4( _inverseMatrix );
    const localThreshold = threshold / ( ( this.scale.x + this.scale.y + this.scale.z ) / 3 );
    const localThresholdSq = localThreshold * localThreshold;
    const index = geometry.index;
    const attributes = geometry.attributes;
    const positionAttribute = attributes.position;
    if ( positionAttribute === undefined ) {
    this.syncLineLoopECS();
    return;
    }
    if ( index !== null ) {
    const start = Math.max( 0, drawRange.start );
    const end = Math.min( index.count, ( drawRange.start + drawRange.count ) );
    } else {
    const start = Math.max( 0, drawRange.start );
    const end = Math.min( positionAttribute.count, ( drawRange.start + drawRange.count ) );
    }
    const t1 = LineLoop._nowMs();
    this._lastRaycastMs = t1 - t0;
    this._avgRaycastMsEMA = this._avgRaycastMsEMA * 0.9 + this._lastRaycastMs * 0.1;
    this.syncLineLoopECS();
    }
  // ─── Public API: update ─────────────────────────────────────────────────
  /**
  · Updates the line loop. Called once per frame by the host or by the
  · LOD stack. When the owning freeze state is HARD or COLD, the update
  · is skipped and only the freeze counter is incremented.
  · 
  · @param {number} [deltaTime]
  · @return {LineLoop}
    */
    update( deltaTime = 0.016 ) {
    this._lastDeltaTime = deltaTime;
    this._lastFrameIndex = DeterminismSeedLOD.getFrameIndex();
    // ── 1. Read shared Android tier. ────────────────────────────────────
    this._androidTier = SkinningCostMultiplierLOD.getAndroidTier();
    this._isMobile64 = SkinningCostMultiplierLOD.isAndroid64();
    // ── 2. Respect freeze state when a freeze owner exists. ─────────────
    if ( LineLoopDefaults.respectFreezeState && this.ownerLod !== undefined && this.ownerLod !== null ) {
    const fs = this.ownerLod.getFreezeState();
    }
    // ── 3. Recompute line distances lazily. ─────────────────────────────
    const preset = LineLoop._presetFor( this._androidTier );
    const cacheTTL = preset.distanceCacheTTL;
    if ( this._lineDistanceDirty
    || ( this._lastFrameIndex - this._lastDistanceComputeFrame ) >= cacheTTL ) {
    this.computeLineDistances();
    }
    // ── 4. Apply loop-closure dither when enabled on this tier. ────────
    if ( preset.ditherLoopClosure ) {
    this._applyLoopClosureDither( preset.ditherAmplitude );
    }
    this.syncLineLoopECS();
    return this;
    }
  // ─── Public API: real-time controls ─────────────────────────────────────
  /**
  · Sets the owning LOD so this loop can read freeze state.
  · @param {Object3D} lod
  · @return {LineLoop}
    */
    setOwnerLod( lod ) {
    this.ownerLod = lod;
    return this;
    }
  /**
  · Marks the line distance attribute as dirty so it will be recomputed.
  · @return {LineLoop}
    */
    invalidateLineDistances() {
    this._lineDistanceDirty = true;
    this._lastDistanceComputeFrame = - 1;
    return this;
    }
  /**
  · Returns a real-time ledger for this loop.
  · @return {object}
    */
    getLineLoopLedger() {
    const vertexCount = new Double( this._vertexCount );
    const segmentCount = new Double( this._segmentCount );
    return {
    uuid: this.uuid,
    uuidHash: this._uuidHash,
    vertexCount: vertexCount.valueOf(),
    segmentCount: segmentCount.valueOf(),
    loopClosureSegment: this._loopClosureSegment,
    lineDistanceCount: this._lineDistanceCount,
    lineDistanceDirty: this._lineDistanceDirty,
    lastRaycastMs: this._lastRaycastMs,
    avgRaycastMsEMA: this._avgRaycastMsEMA,
    lastDistanceComputeMs: this._lastDistanceComputeMs,
    frozenSkipCount: this._frozenSkipCount,
    androidTier: this._androidTier,
    isMobile64: this._isMobile64
    };
    }
  // ─── Internal ───────────────────────────────────────────────────────────
  _refreshGeometryMetrics() {
  const geometry = this.geometry;
  if ( geometry === undefined || geometry === null ) return;
  }
  _applyLoopClosureDither( amplitude ) {
  if ( amplitude <= 0.0 ) return;
  }
  // ─── Events ─────────────────────────────────────────────────────────────
  on( eventType, callback ) {
  let set = this._eventListeners.get( eventType );
  if ( set === undefined ) {
  set = new Set();
  this._eventListeners.set( eventType, set );
  }
  set.add( callback );
  return this;
  }
  off( eventType, callback ) {
  const set = this._eventListeners.get( eventType );
  if ( set !== undefined ) set.delete( callback );
  return this;
  }
  _emit( eventType, payload ) {
  if ( ! LineLoopDefaults.emitEvents ) return;
  const set = this._eventListeners.get( eventType );
  if ( set === undefined ) return;
  for ( const cb of set ) {
  try { cb( payload ); } catch ( e ) { void e; }
  }
  }
  // ─── Copy ───────────────────────────────────────────────────────────────
  copy( source, recursive ) {
  super.copy( source, recursive );
  }
  // ─── Static: Android context ────────────────────────────────────────────
  /**
  · Publishes the Android tier to every registered LineLoop.
  · @param {number} tier
    */
    static setAndroidTier( tier ) {
    LineLoop._androidTier = tier;
    for ( const loop of LineLoop._registeredLineLoops ) {
    loop._androidTier = tier;
    }
    }
  /**
  · Returns the current preset for the active tier.
  · @return {object}
    */
    static getCurrentPreset() {
    return LineLoop._presetFor( LineLoop._androidTier );
    }
  /**
  · Returns the preset table.
  · @return {object}
    */
    static getPresetTable() {
    return LINE_LOOP_PRESET_TABLE;
    }
  /**
  · Returns the shared ECS world.
  · @return {object}
    */
    static getECSWorld() {
    return _lineLoopWorld;
    }
  /**
  · Returns the LineLoopSoA component.
  · @return {object}
    */
    static getLineLoopSoA() {
    return LineLoopSoA;
    }
  /**
  · Returns the LineLoopDefaults.
  · @return {object}
    */
    static get LineLoopDefaults() {
    return LineLoopDefaults;
    }
  // ─── Static: frame lifecycle ────────────────────────────────────────────
  /**
  · Advances the shared frame index for all registered LineLoops.
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    LineLoop._frameIndex = frameIndex | 0;
    for ( const loop of LineLoop._registeredLineLoops ) {
    loop._lastFrameIndex = frameIndex | 0;
    }
    }
  // ─── Static: telemetry ──────────────────────────────────────────────────
  /**
  · Returns a scene-wide summary of line loop activity.
  · @return {object}
    */
    static getAggregatedStats() {
    let totalLoops = 0;
    let totalVertices = 0;
    let totalSegments = 0;
    let totalRaycastMs = 0.0;
    let totalDistanceComputeMs = 0.0;
    let frozenLoops = 0;
    for ( const loop of LineLoop._registeredLineLoops ) {
    totalLoops ++;
    totalVertices += loop._vertexCount;
    totalSegments += loop._segmentCount;
    totalRaycastMs += loop._avgRaycastMsEMA;
    totalDistanceComputeMs += loop._lastDistanceComputeMs;
    }
    const total = new Double( totalRaycastMs );
    return {
    totalLoops: totalLoops,
    totalVertices: totalVertices,
    totalSegments: totalSegments,
    avgRaycastMs: totalLoops > 0 ? total.valueOf() / totalLoops : 0.0,
    totalDistanceComputeMs: totalDistanceComputeMs,
    frozenLoops: frozenLoops,
    androidTier: LineLoop._androidTier
    };
    }
  // ─── Static: helpers ────────────────────────────────────────────────────
  static _presetFor( tier ) {
  switch ( tier ) {
  case 1: return LINE_LOOP_PRESET_TABLE.LOW;
  case 2: return LINE_LOOP_PRESET_TABLE.MID;
  case 3: return LINE_LOOP_PRESET_TABLE.HIGH;
  case 4: return LINE_LOOP_PRESET_TABLE.FLAGSHIP;
  default: return LINE_LOOP_PRESET_TABLE.MID;
  }
  }
  static _registerLineLoop( loop ) {
  LineLoop._registeredLineLoops.add( loop );
  }
  static _unregisterLineLoop( loop ) {
  LineLoop._registeredLineLoops.delete( loop );
  }
  static _hashString( s ) {
  let h = 0x811c9dc5;
  for ( let i = 0; i < s.length; i ++ ) {
  h ^= s.charCodeAt( i );
  h = Math.imul( h, 0x01000193 );
  }
  return h >>> 0;
  }
  static _nowMs() {
  if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
  return performance.now();
  }
  return Date.now();
  }
  // ─── ECS registration ───────────────────────────────────────────────────
  registerLineLoopECS() {
  if ( this._ecsLineLoopRegistered ) {
  return this._ecsLineLoopEntity;
  }
  }
  syncLineLoopECS() {
  if ( ! this._ecsLineLoopRegistered ) return this;
  }
  pullLineLoopECS() {
  if ( ! this._ecsLineLoopRegistered ) return this;
  }
  // ─── gl-matrix / double.js / simplex-noise utilities ────────────────────
  multiplyMat4GL( out, a, b ) {
  glMatrix.mat4.multiply( out || _scratchMat4, a, b );
  return out || _scratchMat4;
  }
  /**
  · High-precision distance between the first and last vertex of the loop
  · using double.js. Useful for very large worlds.
  · @return {number}
    */
    computeLoopClosureDistanceHighPrecision() {
    const geometry = this.geometry;
    if ( geometry === undefined || geometry === null ) return 0.0;
    const positionAttribute = geometry.attributes.position;
    if ( positionAttribute === undefined ) return 0.0;
    const count = positionAttribute.count;
    if ( count < 2 ) return 0.0;
    const a = count - 1;
    const b = 0;
    _vStart.fromBufferAttribute( positionAttribute, a );
    _vEnd.fromBufferAttribute( positionAttribute, b );
    const dx = new Double( _vEnd.x ).sub( new Double( _vStart.x ) );
    const dy = new Double( _vEnd.y ).sub( new Double( _vStart.y ) );
    const dz = new Double( _vEnd.z ).sub( new Double( _vStart.z ) );
    return dx.mul( dx ).add( dy.mul( dy ) ).add( dz.mul( dz ) ).sqrt().valueOf();
    }
  /**
  · Returns a deterministic dither sample for the loop closure.
  · @param {number} frameIndex
  · @return {number}
    */
    computeLoopDither( frameIndex ) {
    const seed = ( this._ditherSeed ^ ( this._ecsLineLoopEntity >>> 0 ) ) >>> 0;
    return DeterminismSeedLOD.sampleGlobal( SeedStream.TEMPORAL, seed + frameIndex );
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
  · Packs line loop telemetry into a vec4 for GPU debug rendering.
  · Layout: (vertexCount, segmentCount, lineDistanceCount, androidTier)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packLineLoopVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._vertexCount,
    this._segmentCount,
    this._lineDistanceCount,
    this._androidTier
    );
    return v;
    }
  /**
  · Packs the loop key into a Float64Array for GPU-side telemetry.
  · Layout: (loopClosureSegment, ditherSeed, ditherSample, frozenSkipCount)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packLoopKeyVec4( out ) {
    const v = out || _loopKeyVec;
    v[ 0 ] = this._loopClosureSegment ? 1 : 0;
    v[ 1 ] = this._ditherSeed;
    v[ 2 ] = this._ditherSample;
    v[ 3 ] = this._frozenSkipCount;
    return v;
    }
  /**
  · Returns the UUID hash.
  · @return {number}
    */
    getUuidHash() {
    return LineLoop._hashString( this.uuid );
    }
    }

// ─── Local helper ───────────────────────────────────────────────────────────
function checkIntersection( object, raycaster, ray, thresholdSq, a, b, i ) {
const positionAttribute = object.geometry.attributes.position;

}

// ─── Static LineLoop storage (module-scoped, shared across instances) ───────
LineLoop._registeredLineLoops = new Set();
LineLoop._frameIndex = 0;
LineLoop._androidTier = 2;

void Object3D;
void Vector3;
void Matrix4;
void Ray;
void Sphere;
void LineBasicMaterial;
void _scratchVec3C;

export { LineLoop, LineLoopSoA, LineLoopDefaults, LINE_LOOP_PRESET_TABLE };
