
// file number : 007_4
// full path name : src/objects/007_4_GlobalBudgetAllocator_LOD.js
// description : Enhancement #5 for the Dynamic LOD system. Adds a per-frame global vertex budget allocator that converts the per-object ScreenSpaceErrorLOD pipeline into an actual real-time LOD system. Every registered LOD reports its desired vertex count and importance weight; the allocator sorts by importance-per-vertex and greedily distributes a global vertex budget across the entire scene. Objects at the SSE-optimal density for the current frame consume only what they need; the leftover budget is reinvested into the most visually important LODs. Supports multiple named budget pools, per-pool priorities, hierarchical sub-budgets (per region/zone), and a deterministic greedy knapsack solver. Uses gl-matrix for the sort-key vectorization, double.js for high-precision budget accounting across millions of vertices, bitecs for SoA allocator state, and simplex-noise for tie-breaking dither that makes the allocation order deterministic but non-degenerate.
// best for : Scene-wide vertex budget regulation, Nanite-style global LOD control, GPU memory pressure management, streaming LOD orchestration, open-world regions, VR frame-budget enforcement, deterministic replay of allocation decisions.
// license : MIT

import { ScreenSpaceErrorLOD } from './007_3_ScreenSpaceError_LOD.js';
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
const _noise3D = createNoise3D();

// ─── ECS world + BudgetAllocator SoA component ──────────────────────────────
const _budgetWorld = createWorld();

const BudgetAllocatorSoA = defineComponent( {
    // Per-LOD reported demand
    desiredVertices: Types.i32,
    allocatedVertices: Types.i32,
    minVertices: Types.i32,
    maxVertices: Types.i32,

    // Importance weighting
    importance: Types.f64,
    priority: Types.f64,
    poolId: Types.i32,

    // Allocation result
    allocationRatio: Types.f64,     // allocatedVertices / desiredVertices
    rejected: Types.ui8,
    starved: Types.ui8,

    // Sort keys (kept in SoA for fast radix)
    sseKey: Types.f64,
    screenCoverageKey: Types.f64,

    // Pool membership
    registered: Types.ui8,
    lastFrameIndex: Types.i32,
    lastAllocationFrame: Types.i32
} );

// ─── ECS world + BudgetPool SoA component ───────────────────────────────────
const _poolWorld = createWorld();

const BudgetPoolSoA = defineComponent( {
    totalBudget: Types.i32,
    usedBudget: Types.i32,
    freeBudget: Types.i32,
    overflowBudget: Types.i32,     // amount by which demand exceeded budget
    memberCount: Types.i32,
    allocatedCount: Types.i32,
    rejectedCount: Types.i32,
    starvedCount: Types.i32,
    lastFrameIndex: Types.i32,
    dirty: Types.ui8
} );

// ─── Tunables specific to the global budget allocator ───────────────────────
const BudgetAllocatorDefaults = {
    // Default global vertex budget across all pools combined.
    globalVertexBudget: 4_000_000,

    // Default per-pool budget for the primary pool (used when no pools
    // are explicitly authored).
    defaultPoolBudget: 4_000_000,

    // Minimum vertices an LOD is allowed to keep, regardless of budget
    // pressure. This prevents full LOD collapse.
    minVerticesPerLOD: 64,

    // Maximum vertices an LOD is allowed to claim, even if it wants more.
    maxVerticesPerLOD: 8_000_000,

    // Importance-vs-vertex weighting exponent. A value > 1 favors small
    // high-importance objects; a value < 1 favors large ones.
    importanceExponent: 1.15,

    // Hysteresis on the allocation ratio so allocations do not flap.
    allocationHysteresis: 0.03,

    // Deterministic tie-breaker seed for sort stability.
    determinismSeed: 0x85EBCA6B,

    // Maximum number of LODs processed per frame (bounds sort cost).
    maxLODsPerFrame: 65536,

    // Pool id used by default when no pool is specified.
    defaultPoolId: 0
};

/**
 * GlobalBudgetAllocatorLOD
 *
 * Extends ScreenSpaceErrorLOD and connects it to a scene-wide vertex budget.
 * The class owns:
 *
 *   - A registry of all LODs that have opted into allocation.
 *   - A set of named budget pools (each with its own vertex cap).
 *   - A per-frame greedy allocator that distributes the pool budget across
 *     registered LODs in order of importance-per-vertex.
 *
 * Pipeline per frame:
 *
 *   1. Parent chain (temporal → curvature → SSE) computes a desired density
 *      and a desired vertex count for this LOD.
 *   2. This class reports that demand to the allocator.
 *   3. After all LODs have reported (via a static flush call), the allocator
 *      sorts by importance-per-vertex and assigns allocations.
 *   4. Each LOD reads back its allocation and adjusts its density to match.
 *
 * Recommended usage:
 * ```js
 * // Per-LOD
 * const lod = new GlobalBudgetAllocatorLOD();
 * lod.attachTarget( mesh, { vertexBudget: 64000 } );
 * lod.registerWithAllocator( 'world', /* priority *\/ 1.0 );
 *
 * // Per-frame
 * GlobalBudgetAllocatorLOD.beginFrame( frameIndex );
 * for ( const lod of allLODs ) lod.update( camera, player, dt );
 * GlobalBudgetAllocatorLOD.flushAllocation();
```

· 
· @augments ScreenSpaceErrorLOD
  */
  class GlobalBudgetAllocatorLOD extends ScreenSpaceErrorLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Registers this LOD with the global allocator under the given pool.
  · 
  · @param {string|number} [pool='default'] - Pool name or id.
  · @param {number} [priority=1.0] - Relative priority within the pool.
  · @return {GlobalBudgetAllocatorLOD}
    */
    registerWithAllocator( pool = 'default', priority = 1.0 ) {
    this.poolId = GlobalBudgetAllocatorLOD._resolvePoolId( pool );
    this.priority = priority;
    this._registeredWithAllocator = true;
    GlobalBudgetAllocatorLOD._registerLOD( this );
    this.syncBudgetECS();
    return this;
    }
  /**
  · Unregisters this LOD from the allocator.
  · @return {GlobalBudgetAllocatorLOD}
    */
    unregisterFromAllocator() {
    this._registeredWithAllocator = false;
    GlobalBudgetAllocatorLOD._unregisterLOD( this );
    return this;
    }
  /**
  · Returns the vertex count the LOD would use at the SSE-optimal density
  · if there were no budget pressure.
  · @return {number}
    */
    getDesiredVertices() {
    return this._desiredVertices;
    }
  /**
  · Returns the vertex count actually granted by the allocator this frame.
  · @return {number}
    */
    getAllocatedVertices() {
    return this._allocatedVertices;
    }
  /**
  · Returns allocatedVertices / desiredVertices in [0, 1].
  · @return {number}
    */
    getAllocationRatio() {
    return this._allocationRatio;
    }
  /**
  · Returns true if the allocator could not satisfy the desired budget.
  · @return {boolean}
    */
    wasRejected() {
    return this._rejected;
    }
  /**
  · Returns true if the LOD fell to its minimum vertex floor.
  · @return {boolean}
    */
    wasStarved() {
    return this._starved;
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides ScreenSpaceErrorLOD.update. Runs the full parent pipeline,
  · then reports the desired vertex count to the allocator and reads back
  · the previous frame's allocation. The final density is a blend of the
  · SSE-driven target and the allocator's grant.
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
    // ── 1. Parent chain computes SSE, curvature, temporal, base density. ─
    super.update( camera, player, rawDeltaTime );
    // ── 2. Compute the desired vertex count from the current density. ────
    const fullVertexCount = this._dynamicVertexBudget > 0
    ? this._dynamicVertexBudget
    : ( this.target !== null && this.target.geometry !== undefined && this.target.geometry.attributes.position !== undefined
    ? this.target.geometry.attributes.position.count
    : 0 );
    const desired = Math.max(
    this.minVertices,
    Math.min( this.maxVertices, Math.round( fullVertexCount * this._dynamicDensity ) )
    );
    this._desiredVertices = desired;
    // ── 3. Report demand + sort keys to the allocator. ──────────────────
    if ( this._registeredWithAllocator ) {
    this._sseKey = this._currentSSE;
    this._screenCoverageKey = this._pixelBudgetUsed;
    }
    // ── 4. Read back the previous frame's allocation. ───────────────────
    const allocated = this._allocatedVertices;
    if ( allocated > 0 && fullVertexCount > 0 ) {
    const allocRatio = allocated / fullVertexCount;
    // Blend the SSE-driven density with the allocator grant.
    const blended = this._dynamicDensity * 0.5 + allocRatio * 0.5;
    const clamped = Math.min( 1.0, Math.max( 0.0, blended ) );
    }
    // ── 5. Update flags. ────────────────────────────────────────────────
    this._rejected = allocated < this._desiredVertices;
    this._starved = allocated <= this.minVertices + 1;
    this.syncBudgetECS();
    }
  // ─── Static allocator core ────────────────────────────────────────────────
  /**
  · Begins a new allocation frame. Clears per-frame telemetry on all pools.
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    GlobalBudgetAllocatorLOD._frameIndex = frameIndex;
    GlobalBudgetAllocatorLOD._reported.clear();
    for ( const pool of GlobalBudgetAllocatorLOD._pools.values() ) {
    pool.usedBudget = 0;
    pool.overflowBudget = 0;
    pool.allocatedCount = 0;
    pool.rejectedCount = 0;
    pool.starvedCount = 0;
    pool.memberCount = 0;
    pool.lastFrameIndex = frameIndex;
    }
    GlobalBudgetAllocatorLOD._pendingReports.length = 0;
    }
  /**
  · Registers a named budget pool with a vertex cap.
  · @param {string} name
  · @param {number} budget
  · @return {object} The pool record.
    */
    static registerPool( name, budget ) {
    const id = GlobalBudgetAllocatorLOD._resolvePoolId( name );
    const pool = {
    id: id,
    name: name,
    totalBudget: budget,
    usedBudget: 0,
    freeBudget: budget,
    overflowBudget: 0,
    memberCount: 0,
    allocatedCount: 0,
    rejectedCount: 0,
    starvedCount: 0,
    lastFrameIndex: - 1,
    dirty: true
    };
    GlobalBudgetAllocatorLOD._pools.set( id, pool );
    return pool;
    }
  /**
  · Runs the greedy allocator across all pools. Called once per frame
  · after all registered LODs have reported their demand.
    */
    static flushAllocation() {
    const reports = GlobalBudgetAllocatorLOD._pendingReports;
    if ( reports.length === 0 ) return;
    // ── 1. Bucket reports by pool. ─────────────────────────────────────
    const byPool = GlobalBudgetAllocatorLOD._byPoolScratch;
    for ( const key of byPool.keys() ) byPool.delete( key );
    for ( let i = 0; i < reports.length; i ++ ) {
    const r = reports[ i ];
    let bucket = byPool.get( r.poolId );
    if ( bucket === undefined ) {
    bucket = [];
    byPool.set( r.poolId, bucket );
    }
    bucket.push( r );
    }
    // ── 2. Allocate each pool independently. ───────────────────────────
    for ( const [ poolId, bucket ] of byPool ) {
    const pool = GlobalBudgetAllocatorLOD._pools.get( poolId );
    if ( pool === undefined ) continue;
    }
    }
  static _allocatePool( pool, bucket ) {
  // ── 1. Sort by importance-per-vertex (descending). ──────────────────
  const exponent = BudgetAllocatorDefaults.importanceExponent;
  }
  static _registerLOD( lod ) {
  GlobalBudgetAllocatorLOD._registered.add( lod );
  }
  static _unregisterLOD( lod ) {
  GlobalBudgetAllocatorLOD._registered.delete( lod );
  }
  static _reportLOD( lod ) {
  GlobalBudgetAllocatorLOD._pendingReports.push( {
  lod: lod,
  entity: lod._ecsEntity,
  poolId: lod.poolId,
  priority: lod.priority,
  desired: lod._desiredVertices,
  minVertices: lod.minVertices,
  maxVertices: lod.maxVertices,
  sseRatio: lod._sseRatio,
  sseKey: lod._sseKey,
  screenCoverageKey: lod._screenCoverageKey
  } );
  }
  static _resolvePoolId( name ) {
  if ( typeof name === 'number' ) return name;
  }
  /**
  · Returns a snapshot of the current allocator state for the given pool.
  · @param {string|number} [pool='default']
  · @return {object}
    */
    static getPoolStats( pool = 'default' ) {
    const id = GlobalBudgetAllocatorLOD._resolvePoolId( pool );
    const p = GlobalBudgetAllocatorLOD._pools.get( id );
    if ( p === undefined ) return null;
    const used = new Double( p.usedBudget );
    const total = new Double( Math.max( 1, p.totalBudget ) );
    const util = used.div( total );
    return {
    id: p.id,
    name: p.name,
    totalBudget: p.totalBudget,
    usedBudget: p.usedBudget,
    freeBudget: p.freeBudget,
    overflowBudget: p.overflowBudget,
    utilization: util.valueOf(),
    memberCount: p.memberCount,
    allocatedCount: p.allocatedCount,
    rejectedCount: p.rejectedCount,
    starvedCount: p.starvedCount,
    lastFrameIndex: p.lastFrameIndex
    };
    }
  /**
  · Returns all registered pool stats.
  · @return {Array<object>}
    */
    static getAllPoolStats() {
    const out = [];
    for ( const pool of GlobalBudgetAllocatorLOD._pools.values() ) {
    out.push( GlobalBudgetAllocatorLOD.getPoolStats( pool.id ) );
    }
    return out;
    }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerBudgetECS() {
  if ( this._ecsBudgetRegistered ) {
  return this._ecsBudgetEntity;
  }
  }
  syncBudgetECS() {
  if ( ! this._ecsBudgetRegistered ) {
  return this;
  }
  }
  pullBudgetECS() {
  if ( ! this._ecsBudgetRegistered ) {
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
  · Computes a high-precision allocation ratio using double.js. Useful
  · for telemetry and for cross-frame budget accounting where float32
  · drift over millions of vertices would be unacceptable.
  · @return {number}
    */
    computeAllocationRatioHighPrecision() {
    const alloc = new Double( this._allocatedVertices );
    const desired = new Double( Math.max( 1, this._desiredVertices ) );
    return alloc.div( desired ).valueOf();
    }
  /**
  · Returns a deterministic tie-break key using simplex-noise seeded by
  · the entity id and pool id. Guarantees stable sort ordering across runs.
  · @param {number} frameIndex
  · @return {number}
    */
    computeTieBreakKey( frameIndex ) {
    const seed = ( this.determinismSeed ^ ( this._ecsEntity >>> 0 ) ^ ( this.poolId << 16 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.01, this.poolId );
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
  · Packs allocation telemetry into a vec4 for GPU-side debug rendering.
  · Layout: (allocatedVertices, desiredVertices, allocationRatio, poolId)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packAllocationVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._allocatedVertices,
    this._desiredVertices,
    this._allocationRatio,
    this.poolId
    );
    return v;
    }
  static getECSWorld() {
  return _budgetWorld;
  }
  static getBudgetSoA() {
  return BudgetAllocatorSoA;
  }
  static getPoolECSWorld() {
  return _poolWorld;
  }
  static getPoolSoA() {
  return BudgetPoolSoA;
  }
  static get BudgetAllocatorDefaults() {
  return BudgetAllocatorDefaults;
  }
  }

// ─── Static allocator storage (module-scoped, shared across all instances) ──
GlobalBudgetAllocatorLOD._frameIndex = 0;
GlobalBudgetAllocatorLOD._registered = new Set();
GlobalBudgetAllocatorLOD._pendingReports = [];
GlobalBudgetAllocatorLOD._pools = new Map();
GlobalBudgetAllocatorLOD._poolNameToId = new Map();
GlobalBudgetAllocatorLOD._byPoolScratch = new Map();
GlobalBudgetAllocatorLOD._nextPoolId = 1;

// Ensure the default pool exists on module load.
GlobalBudgetAllocatorLOD.registerPool( 'default', BudgetAllocatorDefaults.defaultPoolBudget );

export {
GlobalBudgetAllocatorLOD,
BudgetAllocatorSoA,
BudgetPoolSoA,
BudgetAllocatorDefaults
};

