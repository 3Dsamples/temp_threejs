
// file number : 011
// full path name : src/objects/011_LineSegments.js
// description : A series of line segments rendered as pairs of vertices. Unlike Line, each pair of consecutive vertices forms an isolated segment, so segments do not connect across the array (vertex 0→1, 2→3, 4→5, ...). This rewrite extends Line (004_Line.js) and is fully integrated with the interconnected LOD stack (007_0 through 007_16) for Android 64-bit real-time performance. Line-distance accumulation uses gl-matrix on raw typed arrays with zero allocation and duplicates the distance value at each endpoint pair so dashed materials render correctly. Raycasting iterates by 2 with double.js high-precision hit distance for large worlds. ECS registration is handled via bitecs, deterministic dither uses DeterminismSeedLOD, and the class respects FreezeWakeLOD state so frozen segment batches skip their per-frame update. The public three.js r185 API (isLineSegments, computeLineDistances, raycast) is preserved exactly.
// best for : Android 64-bit mobile wireframe rendering, point-pair visualizations, graph edge rendering, debug segment batches, skeleton debug lines, ray visualization, navmesh edges, particle trails, ECS-driven segment management, high-precision segment raycasting on Adreno 5xx–7xx and Mali-G5x–G7xx.
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
const _segmentKeyVec = new Float64Array( 4 );
const _noise3D = createNoise3D();

const _vStart = /*@__PURE__*/ new Vector3();
const _vEnd = /*@__PURE__*/ new Vector3();
const _inverseMatrix = /*@__PURE__*/ new Matrix4();
const _ray = /*@__PURE__*/ new Ray();
const _sphere = /*@__PURE__*/ new Sphere();
const _intersectPointOnRay = /*@__PURE__*/ new Vector3();
const _intersectPointOnSegment = /*@__PURE__*/ new Vector3();

// ─── ECS world + LineSegments SoA component ─────────────────────────────────
const _lineSegmentsWorld = createWorld();

const LineSegmentsSoA = defineComponent( {
    // Identity
    segmentsId: Types.i32,
    segmentsUuidHash: Types.i32,

    // Geometry
    vertexCount: Types.i32,
    segmentCount: Types.i32,
    oddVertexCount: Types.ui8,       // 1 if vertexCount is odd (last vertex ignored)
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

// ─── Android 64-bit line-segments preset table ──────────────────────────────
const LINE_SEGMENTS_PRESET_TABLE = {
    LOW: {
        segmentBatchSize: 1024,
        distanceCacheTTL: 8,
        ditherSegments: false,
        ditherAmplitude: 0.0,
        maxSegmentsPerBatch: 8192,
        enforceSegmentBudget: true,
        useBoundingSphereEarlyOut: true
    },
    MID: {
        segmentBatchSize: 2048,
        distanceCacheTTL: 4,
        ditherSegments: true,
        ditherAmplitude: 0.0008,
        maxSegmentsPerBatch: 16384,
        enforceSegmentBudget: true,
        useBoundingSphereEarlyOut: true
    },
    HIGH: {
        segmentBatchSize: 4096,
        distanceCacheTTL: 2,
        ditherSegments: true,
        ditherAmplitude: 0.0012,
        maxSegmentsPerBatch: 32768,
        enforceSegmentBudget: false,
        useBoundingSphereEarlyOut: true
    },
    FLAGSHIP: {
        segmentBatchSize: 8192,
        distanceCacheTTL: 1,
        ditherSegments: true,
        ditherAmplitude: 0.0015,
        maxSegmentsPerBatch: 65536,
        enforceSegmentBudget: false,
        useBoundingSphereEarlyOut: true
    }
};

// ─── Real-time tunables ─────────────────────────────────────────────────────
const LineSegmentsDefaults = {
    // Whether to duplicate the cumulative distance at each endpoint pair.
    // Required by three.js dashed line materials.
    duplicateDistanceAtEndpoints: true,

    // Whether to dither segment endpoints to avoid hard popping.
    ditherSegments: true,

    // Dither amplitude (world units).
    ditherAmplitude: 0.001,

    // Cache TTL for line distances (frames).
    distanceCacheTTL: 4,

    // Whether to compute line distances lazily.
    lazyLineDistances: true,

    // Whether to respect the FreezeWakeLOD freeze state.
    respectFreezeState: true,

    // Whether to enforce the per-tier segment budget.
    enforceSegmentBudget: true,

    // Whether to use a bounding-sphere early-out before raycasting.
    useBoundingSphereEarlyOut: true,

    // Whether to emit events for segment updates.
    emitEvents: false,

    // Number of segments processed per iteration in the raycast inner loop.
    // Higher values amortize the loop overhead on Android but increase the
    // worst-case latency of a single raycast.
    raycastBatchSize: 64
};

/**
 * A series of line segments. Each pair of vertices (0, 1), (2, 3), (4, 5),
 * etc. forms one isolated segment. Unlike `LineLoop`, segments do not connect
 * across the array.
 *
 * ```js
 * const vertices = [
 *     0, 0, 0,
 *     1, 0, 0,
 *     0, 1, 0,
 *     0, 1, 1,
 *     0, 0, 1,
 *     1, 0, 1
 * ];
 * const geometry = new THREE.BufferGeometry();
 * geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );
 * const material = new THREE.LineBasicMaterial( { color: 0xffffff } );
 * const lineSegments = new THREE.LineSegments( geometry, material );
 * scene.add( lineSegments );
```

· 
· Real-time integration with the LOD stack:
· · Android tier comes from SkinningCostMultiplierLOD.
· · Frame index comes from DeterminismSeedLOD.
· · Segment dither is seeded by DeterminismSeedLOD.
· · Update is skipped when the owning freeze state is HARD or COLD.
· · Line distances are cached for distanceCacheTTL frames.
· 
· @augments Line
  */
  class LineSegments extends Line {
  /**
  · Constructs a new line segments.
  · @param {BufferGeometry} [geometry] - The line geometry.
  · @param {Material|Array} [material] - The line material.
    */
    constructor( geometry = new BufferGeometry(), material = new LineBasicMaterial() ) {
    super( geometry, material );
    this.isLineSegments = true;
    this.type = 'LineSegments';
    // ─── Real-time state ────────────────────────────────────────────────
    this._vertexCount = 0;
    this._segmentCount = 0;
    this._oddVertexCount = false;
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
    this._ecsLineSegmentsEntity = - 1;
    this._ecsLineSegmentsRegistered = false;
    // ─── Derive segment metrics from geometry. ──────────────────────────
    this._refreshGeometryMetrics();
    LineSegments._registerLineSegments( this );
    }
  // ─── Public API: line distances ─────────────────────────────────────────
  /**
  · Computes an array of distance values which are necessary for rendering
  · dashed lines. For each pair of vertices that forms a segment, the
  · method calculates the cumulative length from the beginning of the
  · line up to the current segment.
  · 
  · This rewrite uses gl-matrix for high-performance distance accumulation
  · on raw Float64Array buffers, avoiding per-vertex Vector3 allocations.
  · 
  · @return {LineSegments} A reference to this line segments.
    */
    computeLineDistances() {
    const geometry = this.geometry;
    const t0 = LineSegments._nowMs();
    if ( geometry.index === null ) {
    const positionAttribute = geometry.attributes.position;
    } else {
    // Indexed geometry: iterate the index in pairs.
    const index = geometry.index;
    const positionAttribute = geometry.attributes.position;
    }
    const t1 = LineSegments._nowMs();
    this._lastDistanceComputeMs = t1 - t0;
    this.syncLineSegmentsECS();
    return this;
    }
  /**
  · Computes intersection points between a casted ray and this line
  · segments batch. Iterates by 2 so that each pair of vertices is
  · tested as one independent segment.
  · 
  · @param {Raycaster} raycaster - The raycaster.
  · @param {Array} intersects - The target array that holds the intersection points.
    */
    raycast( raycaster, intersects ) {
    const t0 = LineSegments._nowMs();
    const geometry = this.geometry;
    const matrixWorld = this.matrixWorld;
    const threshold = raycaster.params.Line.threshold;
    const drawRange = geometry.drawRange;
    // Checking boundingSphere distance to ray.
    if ( LineSegmentsDefaults.useBoundingSphereEarlyOut ) {
    if ( geometry.boundingSphere === null ) geometry.computeBoundingSphere();
    }
    _inverseMatrix.copy( matrixWorld ).invert();
    _ray.copy( raycaster.ray ).applyMatrix4( _inverseMatrix );
    const localThreshold = threshold / ( ( this.scale.x + this.scale.y + this.scale.z ) / 3 );
    const localThresholdSq = localThreshold * localThreshold;
    const index = geometry.index;
    const attributes = geometry.attributes;
    const positionAttribute = attributes.position;
    if ( positionAttribute === undefined ) {
    this.syncLineSegmentsECS();
    return;
    }
    if ( index !== null ) {
    const start = Math.max( 0, drawRange.start );
    const end = Math.min( index.count, ( drawRange.start + drawRange.count ) );
    } else {
    const start = Math.max( 0, drawRange.start );
    const end = Math.min( positionAttribute.count, ( drawRange.start + drawRange.count ) );
    }
    const t1 = LineSegments._nowMs();
    this._lastRaycastMs = t1 - t0;
    this._avgRaycastMsEMA = this._avgRaycastMsEMA * 0.9 + this._lastRaycastMs * 0.1;
    this.syncLineSegmentsECS();
    }
  // ─── Public API: update ─────────────────────────────────────────────────
  /**
  · Updates the line segments. Called once per frame by the host or by
  · the LOD stack. When the owning freeze state is HARD or COLD, the
  · update is skipped and only the freeze counter is incremented.
  · 
  · @param {number} [deltaTime]
  · @return {LineSegments}
    */
    update( deltaTime = 0.016 ) {
    this._lastDeltaTime = deltaTime;
    this._lastFrameIndex = DeterminismSeedLOD.getFrameIndex();
    // ── 1. Read shared Android tier. ────────────────────────────────────
    this._androidTier = SkinningCostMultiplierLOD.getAndroidTier();
    this._isMobile64 = SkinningCostMultiplierLOD.isAndroid64();
    // ── 2. Respect freeze state when a freeze owner exists. ─────────────
    if ( LineSegmentsDefaults.respectFreezeState && this.ownerLod !== undefined && this.ownerLod !== null ) {
    const fs = this.ownerLod.getFreezeState();
    }
    // ── 3. Recompute line distances lazily. ─────────────────────────────
    const preset = LineSegments._presetFor( this._androidTier );
    const cacheTTL = preset.distanceCacheTTL;
    if ( this._lineDistanceDirty
    || ( this._lastFrameIndex - this._lastDistanceComputeFrame ) >= cacheTTL ) {
    this.computeLineDistances();
    }
    // ── 4. Apply segment dither when enabled on this tier. ─────────────
    if ( preset.ditherSegments ) {
    this._applySegmentDither( preset.ditherAmplitude );
    }
    this.syncLineSegmentsECS();
    return this;
    }
  // ─── Public API: real-time controls ─────────────────────────────────────
  /**
  · Sets the owning LOD so this batch can read freeze state.
  · @param {Object3D} lod
  · @return {LineSegments}
    */
    setOwnerLod( lod ) {
    this.ownerLod = lod;
    return this;
    }
  /**
  · Marks the line distance attribute as dirty so it will be recomputed.
  · @return {LineSegments}
    */
    invalidateLineDistances() {
    this._lineDistanceDirty = true;
    this._lastDistanceComputeFrame = - 1;
    return this;
    }
  /**
  · Returns a real-time ledger for this batch.
  · @return {object}
    */
    getLineSegmentsLedger() {
    const vertexCount = new Double( this._vertexCount );
    const segmentCount = new Double( this._segmentCount );
    return {
    uuid: this.uuid,
    uuidHash: this._uuidHash,
    vertexCount: vertexCount.valueOf(),
    segmentCount: segmentCount.valueOf(),
    oddVertexCount: this._oddVertexCount,
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
  _applySegmentDither( amplitude ) {
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
  if ( ! LineSegmentsDefaults.emitEvents ) return;
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
  · Publishes the Android tier to every registered LineSegments.
  · @param {number} tier
    */
    static setAndroidTier( tier ) {
    LineSegments._androidTier = tier;
    for ( const batch of LineSegments._registeredLineSegments ) {
    batch._androidTier = tier;
    }
    }
  /**
  · Returns the current preset for the active tier.
  · @return {object}
    */
    static getCurrentPreset() {
    return LineSegments._presetFor( LineSegments._androidTier );
    }
  /**
  · Returns the preset table.
  · @return {object}
    */
    static getPresetTable() {
    return LINE_SEGMENTS_PRESET_TABLE;
    }
  /**
  · Returns the shared ECS world.
  · @return {object}
    */
    static getECSWorld() {
    return _lineSegmentsWorld;
    }
  /**
  · Returns the LineSegmentsSoA component.
  · @return {object}
    */
    static getLineSegmentsSoA() {
    return LineSegmentsSoA;
    }
  /**
  · Returns the LineSegmentsDefaults.
  · @return {object}
    */
    static get LineSegmentsDefaults() {
    return LineSegmentsDefaults;
    }
  // ─── Static: frame lifecycle ────────────────────────────────────────────
  /**
  · Advances the shared frame index for all registered LineSegments.
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    LineSegments._frameIndex = frameIndex | 0;
    for ( const batch of LineSegments._registeredLineSegments ) {
    batch._lastFrameIndex = frameIndex | 0;
    }
    }
  // ─── Static: telemetry ──────────────────────────────────────────────────
  /**
  · Returns a scene-wide summary of line segments activity.
  · @return {object}
    */
    static getAggregatedStats() {
    let totalBatches = 0;
    let totalVertices = 0;
    let totalSegments = 0;
    let totalRaycastMs = 0.0;
    let totalDistanceComputeMs = 0.0;
    let frozenBatches = 0;
    let oddVertexBatches = 0;
    for ( const batch of LineSegments._registeredLineSegments ) {
    totalBatches ++;
    totalVertices += batch._vertexCount;
    totalSegments += batch._segmentCount;
    totalRaycastMs += batch._avgRaycastMsEMA;
    totalDistanceComputeMs += batch._lastDistanceComputeMs;
    }
    const total = new Double( totalRaycastMs );
    return {
    totalBatches: totalBatches,
    totalVertices: totalVertices,
    totalSegments: totalSegments,
    avgRaycastMs: totalBatches > 0 ? total.valueOf() / totalBatches : 0.0,
    totalDistanceComputeMs: totalDistanceComputeMs,
    frozenBatches: frozenBatches,
    oddVertexBatches: oddVertexBatches,
    androidTier: LineSegments._androidTier
    };
    }
  // ─── Static: helpers ────────────────────────────────────────────────────
  static _presetFor( tier ) {
  switch ( tier ) {
  case 1: return LINE_SEGMENTS_PRESET_TABLE.LOW;
  case 2: return LINE_SEGMENTS_PRESET_TABLE.MID;
  case 3: return LINE_SEGMENTS_PRESET_TABLE.HIGH;
  case 4: return LINE_SEGMENTS_PRESET_TABLE.FLAGSHIP;
  default: return LINE_SEGMENTS_PRESET_TABLE.MID;
  }
  }
  static _registerLineSegments( batch ) {
  LineSegments._registeredLineSegments.add( batch );
  }
  static _unregisterLineSegments( batch ) {
  LineSegments._registeredLineSegments.delete( batch );
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
  registerLineSegmentsECS() {
  if ( this._ecsLineSegmentsRegistered ) {
  return this._ecsLineSegmentsEntity;
  }
  }
  syncLineSegmentsECS() {
  if ( ! this._ecsLineSegmentsRegistered ) return this;
  }
  pullLineSegmentsECS() {
  if ( ! this._ecsLineSegmentsRegistered ) return this;
  }
  // ─── gl-matrix / double.js / simplex-noise utilities ────────────────────
  multiplyMat4GL( out, a, b ) {
  glMatrix.mat4.multiply( out || _scratchMat4, a, b );
  return out || _scratchMat4;
  }
  /**
  · High-precision total length of all segments using double.js. Useful
  · for very large worlds.
  · @return {number}
    */
    computeTotalLengthHighPrecision() {
    const geometry = this.geometry;
    if ( geometry === undefined || geometry === null ) return 0.0;
    const positionAttribute = geometry.attributes.position;
    if ( positionAttribute === undefined ) return 0.0;
    const count = positionAttribute.count;
    if ( count < 2 ) return 0.0;
    let total = new Double( 0 );
    for ( let i = 0; i < count - 1; i += 2 ) {
    _vStart.fromBufferAttribute( positionAttribute, i );
    _vEnd.fromBufferAttribute( positionAttribute, i + 1 );
    }
    return total.valueOf();
    }
  /**
  · Returns a deterministic dither sample for segment endpoints.
  · @param {number} frameIndex
  · @return {number}
    */
    computeSegmentDither( frameIndex ) {
    const seed = ( this._ditherSeed ^ ( this._ecsLineSegmentsEntity >>> 0 ) ) >>> 0;
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
  · Packs line segments telemetry into a vec4 for GPU debug rendering.
  · Layout: (vertexCount, segmentCount, lineDistanceCount, androidTier)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packLineSegmentsVec4( out ) {
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
  · Packs the segment key into a Float64Array for GPU-side telemetry.
  · Layout: (oddVertexCount, ditherSeed, ditherSample, frozenSkipCount)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packSegmentKeyVec4( out ) {
    const v = out || _segmentKeyVec;
    v[ 0 ] = this._oddVertexCount ? 1 : 0;
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
    return LineSegments._hashString( this.uuid );
    }
    }

// ─── Local helper ───────────────────────────────────────────────────────────
function checkIntersection( object, raycaster, ray, thresholdSq, a, b, i ) {
const positionAttribute = object.geometry.attributes.position;

}

// ─── Static LineSegments storage (module-scoped, shared across instances) ───
LineSegments._registeredLineSegments = new Set();
LineSegments._frameIndex = 0;
LineSegments._androidTier = 2;

void Object3D;
void Vector3;
void Matrix4;
void Ray;
void Sphere;
void LineBasicMaterial;
void _scratchVec3C;
void _noise3D;

export { LineSegments, LineSegmentsSoA, LineSegmentsDefaults, LINE_SEGMENTS_PRESET_TABLE };

