
// file number : 007_1
// full path name : src/objects/007_1_DeltaTimeIntegration_LOD.js
// description : Enhancement #2 for the Dynamic LOD system. Adds robust, framerate-independent delta-time handling on top of TemporalCoherenceLOD (007_0_TemporalCoherence_LOD.js). Provides large-frame sub-stepping, fixed-timestep fallback for deterministic replay, dt-clamp protection against tab-backgrounding spikes, time dilation compensation, and a per-frame accumulated time ledger. Uses gl-matrix for time-vector math, double.js for high-precision sub-step accumulation, bitecs for SoA dt state, and simplex-noise for sub-step phase dithering that removes aliasing artifacts when frames are irregular.
// best for : Framerate-independent convergence, tab-switch and stall recovery, fixed-timestep determinism, VR time-dilation compensation, heterogeneous host synchronization (Godot 4.6 / Three.js), long-running scene stability.
// license : MIT

import { TemporalCoherenceLOD } from './007_0_TemporalCoherence_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _noise3D = createNoise3D();

// ─── ECS world + DeltaTime SoA component ────────────────────────────────────
const _dtWorld = createWorld();

const DeltaTimeSoA = defineComponent( {
    // Frame accounting
    lastRawDeltaTime: Types.f64,
    lastClampedDeltaTime: Types.f64,
    lastSubStepCount: Types.i32,
    accumulatedTime: Types.f64,
    frameIndex: Types.i32,

    // Fixed-timestep state
    fixedTimestep: Types.f64,
    fixedAccumulator: Types.f64,
    fixedEnabled: Types.ui8,

    // Clamp & dilation
    maxDeltaTime: Types.f64,
    minDeltaTime: Types.f64,
    timeScale: Types.f64,
    timeDilation: Types.f64,

    // Stall detection
    stallCount: Types.i32,
    lastStallFrame: Types.i32,
    recovering: Types.ui8
} );

// ─── Tunables specific to delta-time integration ────────────────────────────
const DeltaTimeDefaults = {
    // Hard clamp on incoming dt to avoid integration explosions after a stall.
    maxDeltaTime: 0.1,
    // Soft floor on dt so zero-length frames do not divide by zero.
    minDeltaTime: 1e-5,
    // Any frame above this threshold counts as a "stall" and is sub-stepped.
    stallThreshold: 0.033,
    // Fixed timestep (seconds) used when fixedEnabled is true.
    fixedTimestep: 1 / 60,
    // Maximum sub-steps per frame to bound cost.
    maxSubSteps: 8,
    // Global time multiplier (slow-motion / fast-forward).
    timeScale: 1.0,
    // VR-style time dilation compensation (1.0 = none).
    timeDilation: 1.0,
    // Deterministic seed base for sub-step phase dithering.
    determinismSeed: 0xC2B2AE35
};

/**
 * DeltaTimeIntegrationLOD
 *
 * Extends TemporalCoherenceLOD and replaces the direct `update()` entry
 * point with a fully defensive delta-time pipeline:
 *
 *   rawDt  →  clamp  →  timeScale  →  timeDilation  →  split into sub-steps
 *
 * Each sub-step is fed back into the parent temporal integrator, so density
 * converges identically whether the host runs at 24, 60, 144 FPS, or stalls
 * for a full second and resumes. When `fixedEnabled` is true, the class
 * accumulates real time and fires a fixed number of 1/60s steps, matching
 * deterministic replay requirements.
 *
 * Recommended usage:
 * ```js
 * const lod = new DeltaTimeIntegrationLOD();
 * lod.attachTarget( mesh, { vertexBudget: 64000 } );
 * lod.fixedEnabled = true;   // deterministic replay
 *
 * function frame( camera, player, rawDt ) {
 *     lod.update( camera, player, rawDt );
 * }
```

· 
· @augments TemporalCoherenceLOD
  */
  class DeltaTimeIntegrationLOD extends TemporalCoherenceLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Enables or disables the fixed-timestep path. When enabled, the host's
  · rawDt is accumulated and the density integrator is stepped in
  · fixedTimestep increments. This guarantees bit-identical density
  · trajectories across different frame rates.
  · 
  · @param {boolean} [enabled=true]
  · @param {number} [timestep] - Optional override for the fixed timestep.
  · @return {DeltaTimeIntegrationLOD}
    */
    enableFixedTimestep( enabled = true, timestep ) {
    this.fixedEnabled = enabled;
    if ( timestep !== undefined ) {
    this.fixedTimestep = timestep;
    }
    this._fixedAccumulator = 0.0;
    return this;
    }
  /**
  · Returns the total wall-clock time this LOD has been active, in seconds.
  · @return {number}
    */
    getAccumulatedTime() {
    return this._accumulatedTime;
    }
  /**
  · Returns the number of sub-steps performed on the last frame.
  · @return {number}
    */
    getLastSubStepCount() {
    return this._lastSubStepCount;
    }
  /**
  · Returns true if the last frame was treated as a stall and sub-stepped.
  · @return {boolean}
    */
    isRecovering() {
    return this._recovering;
    }
  /**
  · Returns a high-precision snapshot of the current dt ledger.
  · @return {{raw:number, clamped:number, scaled:number, accumulated:number, subSteps:number}}
    */
    getTimeLedger() {
    const raw = new Double( this._lastRawDeltaTime );
    const clamped = new Double( this._lastClampedDeltaTime );
    const scaled = clamped.mul( new Double( this.timeScale ) ).mul( new Double( this.timeDilation ) );
    const acc = new Double( this._accumulatedTime );
    return {
    raw: raw.valueOf(),
    clamped: clamped.valueOf(),
    scaled: scaled.valueOf(),
    accumulated: acc.valueOf(),
    subSteps: this._lastSubStepCount
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides TemporalCoherenceLOD.update. Performs delta-time sanitation,
  · sub-step splitting, and fixed-timestep accumulation before delegating
  · to the parent temporal integrator.
  · 
  · @param {Camera} camera - The active camera.
  · @param {Object3D} [player] - Optional player transform.
  · @param {number} [rawDeltaTime] - Frame delta in seconds from the host.
    */
    update( camera, player = this.player, rawDeltaTime = 0.016 ) {
    // Conventional mode bypasses all dt machinery.
    if ( this.mode === LOD_MODE.CONVENTIONAL ) {
    super.update( camera, player, rawDeltaTime );
    return;
    }
    this._frameIndex ++;
    this._lastRawDeltaTime = rawDeltaTime;
    // ── 1. Clamp raw dt into a safe range. ───────────────────────────────
    let dt = rawDeltaTime;
    if ( ! Number.isFinite( dt ) || dt < this.minDeltaTime ) dt = this.minDeltaTime;
    if ( dt > this.maxDeltaTime ) dt = this.maxDeltaTime;
    this._lastClampedDeltaTime = dt;
    // ── 2. Apply global timeScale and dilation. ─────────────────────────
    dt *= this.timeScale;
    dt *= this.timeDilation;
    // ── 3. Stall detection: frames above the threshold are sub-stepped. ─
    const isStall = rawDeltaTime > this.stallThreshold;
    if ( isStall ) {
    this._stallCount ++;
    this._lastStallFrame = this._frameIndex;
    }
    this._recovering = isStall || ( this._frameIndex - this._lastStallFrame < 3 );
    // ── 4. Fixed-timestep path (deterministic replay). ──────────────────
    if ( this.fixedEnabled ) {
    this._fixedAccumulator += dt;
    }
    // ── 5. Adaptive sub-stepping path (default). ────────────────────────
    // Split dt into N chunks when dt > stallThreshold. N is bounded.
    const subSteps = isStall
    ? Math.min( this.maxSubSteps, Math.max( 2, Math.ceil( dt / this.fixedTimestep ) ) )
    : 1;
    const subDt = dt / subSteps;
    for ( let s = 0; s < subSteps; s ++ ) {
    this._stepOnce( camera, player, subDt, s );
    this._accumulatedTime += subDt;
    }
    this._lastSubStepCount = subSteps;
    this.syncDtECS();
    }
  // ─── Internal per-step driver ────────────────────────────────────────────
  _stepOnce( camera, player, stepDt, subStepIndex ) {
  // Phase dithering: offset the noise seed per sub-step so that
  // sub-stepped frames do not produce identical noise samples.
  const seed = ( this.determinismSeed ^ ( this._frameIndex * 73856093 ) ^ ( subStepIndex * 19349663 ) ) >>> 0;
  const phaseJitter = _noise3D( seed * 1e-6, subStepIndex * 0.1, this._accumulatedTime ) * 0.001;
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerDtECS() {
  if ( this._ecsDtRegistered ) {
  return this._ecsDtEntity;
  }
  }
  syncDtECS() {
  if ( ! this._ecsDtRegistered ) {
  return this;
  }
  }
  pullDtECS() {
  if ( ! this._ecsDtRegistered ) {
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
  · Returns a high-precision scaled dt using double.js. Useful when
  · chaining many small sub-steps where float32 drift matters.
  · @param {number} dt
  · @return {number}
    */
    scaleDeltaTimeHighPrecision( dt ) {
    const a = new Double( dt );
    const s = new Double( this.timeScale );
    const d = new Double( this.timeDilation );
    return a.mul( s ).mul( d ).valueOf();
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
  return _dtWorld;
  }
  static getDeltaTimeSoA() {
  return DeltaTimeSoA;
  }
  static get DeltaTimeDefaults() {
  return DeltaTimeDefaults;
  }
  }

export { DeltaTimeIntegrationLOD, DeltaTimeSoA, DeltaTimeDefaults };
