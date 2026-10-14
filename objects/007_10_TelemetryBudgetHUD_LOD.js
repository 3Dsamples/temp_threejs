
// file number : 007_10
// full path name : src/objects/007_10_TelemetryBudgetHUD_LOD.js
// description : Enhancement #12 for the Dynamic LOD system. Adds a full telemetry, change-event, and budget HUD layer tailored for Android 64-bit mobile devices running Three.js. Aggregates per-LOD metrics across every prior layer (temporal, delta-time, curvature, SSE, budget, frustum/occlusion, motion, prediction, resolution scale, async apply) into a single scene-wide ledger, plus Android-specific signals: device memory class, hardware concurrency, WebGL/WebGL2 capability tier, GPU renderer string, battery API, thermal pressure hints, and frame-jank percentage. Change events are emitted for density, level, budget-rejected, budget-starved, and saturation transitions. A HUD renderer draws directly into a 2D canvas that can be wrapped into a Three.js CanvasTexture + Sprite overlay with an OrthographicCamera, so it works inside the same WebGL context on mobile without a second canvas. Uses gl-matrix for HUD layout math, double.js for high-precision aggregated metrics (triangles, vertices, memory bytes), bitecs for SoA telemetry state, and simplex-noise for deterministic sampling jitter that prevents telemetry aliasing.
// best for : Android 64-bit mobile profiling, Three.js WebGL1/WebGL2 scenes, mid-range and high-end mobile GPUs, thermal-throttling detection, battery-aware LOD tuning, in-development on-device HUD, budget rejection debugging, capture and replay of telemetry snapshots.
// license : MIT

import { AsyncDensityApplicationLOD } from './007_9_AsyncDensityApplication_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _noise3D = createNoise3D();

// ─── ECS world + Telemetry SoA component ────────────────────────────────────
const _telemetryWorld = createWorld();

const TelemetrySoA = defineComponent( {
    // Per-LOD density snapshot
    density: Types.f64,
    densityTarget: Types.f64,
    densityDelta: Types.f64,
    densityVelocity: Types.f64,

    // Per-LOD level snapshot
    currentLevel: Types.i32,
    levelTransitionCount: Types.i32,
    lastLevelChangeFrame: Types.i32,

    // Budget snapshot
    desiredVertices: Types.i32,
    allocatedVertices: Types.i32,
    allocationRatio: Types.f64,
    rejected: Types.ui8,
    starved: Types.ui8,

    // Visibility snapshot
    visibility: Types.f64,
    inFrustum: Types.ui8,
    occluded: Types.ui8,

    // SSE snapshot
    currentSSE: Types.f64,
    pixelBudgetUsed: Types.f64,

    // Motion snapshot
    velocityMagnitude: Types.f64,
    motionImportance: Types.f64,

    // Prediction snapshot
    futureVisibility: Types.f64,
    predictiveWeight: Types.f64,

    // Async snapshot
    pendingJobs: Types.i32,
    inflightJobs: Types.i32,
    backPressure: Types.f64,

    // Resolution snapshot
    currentScale: Types.f64,
    adaptiveBias: Types.f64,

    // Change events
    densityChangeCount: Types.i32,
    lastDensityChangeFrame: Types.i32,
    rejectedChangeCount: Types.i32,
    starvedChangeCount: Types.i32,
    saturationChangeCount: Types.i32,

    // Aggregated cost
    estimatedTriangleCount: Types.i32,
    estimatedVertexCount: Types.i32,
    estimatedMemoryBytes: Types.f64
} );

// ─── Tunables specific to telemetry / HUD ───────────────────────────────────
const TelemetryDefaults = {
    // HUD canvas dimensions in CSS pixels.
    hudWidth: 320,
    hudHeight: 200,
    hudPadding: 8,
    hudLineHeight: 14,
    hudFont: '11px monospace',
    hudBackground: 'rgba(0,0,0,0.55)',
    hudForeground: '#e6e6e6',
    hudAccent: '#7fd1ff',
    hudWarning: '#ffcc55',
    hudCritical: '#ff5555',
    hudOk: '#7fe08a',

    // Telemetry sample rate (1 = every frame, 2 = every other frame).
    sampleRate: 1,

    // EMA smoothing factor for per-frame metrics.
    smoothing: 0.15,

    // Frame history ring buffer length (frames).
    frameHistoryLength: 120,

    // Number of worst LODs to display in the HUD.
    worstLODCount: 6,

    // Jank threshold in milliseconds. Frames above this are counted as jank.
    jankThresholdMs: 33.33,

    // Thermal pressure threshold (°C approximate from any available sensor).
    thermalWarningC: 42.0,
    thermalCriticalC: 48.0,

    // Battery warning threshold (fraction, 0..1).
    batteryWarning: 0.15,

    // Budget rejection warning threshold (fraction, 0..1).
    rejectionWarning: 0.25,
    rejectionCritical: 0.50,

    // Starvation warning threshold (fraction, 0..1).
    starvationWarning: 0.15,
    starvationCritical: 0.35,

    // Back-pressure warning threshold (0..1).
    backPressureWarning: 0.60,
    backPressureCritical: 0.85,

    // Deterministic seed base for telemetry sampling jitter.
    determinismSeed: 0x27D4EB2D,

    // Whether to auto-detect Android 64-bit capability tier at construction.
    autoDetectAndroid: true,

    // Whether to attempt to read battery API (if available).
    readBattery: true,

    // Whether to attempt to read thermal hints (if available).
    readThermal: true,

    // Whether to emit change events (density, level, rejected, starved).
    emitChangeEvents: true,

    // Maximum snapshots retained in memory.
    maxSnapshots: 512
};

// ─── Android capability tier constants ──────────────────────────────────────
const AndroidTier = Object.freeze( {
    UNKNOWN: 0,
    LOW: 1,       // 2 GB RAM class, Adreno 5xx / Mali-G5x
    MID: 2,       // 4 GB RAM class, Adreno 6xx / Mali-G7x
    HIGH: 3,      // 6-8 GB RAM class, Adreno 7xx / Mali-G7x MC
    FLAGSHIP: 4   // 12 GB RAM class, Adreno 740+ / Immortalis-G715+
} );

// ─── Change-event type constants ────────────────────────────────────────────
const TelemetryEvent = Object.freeze( {
    DENSITY_CHANGED: 'density-changed',
    LEVEL_CHANGED: 'level-changed',
    BUDGET_REJECTED: 'budget-rejected',
    BUDGET_STARVED: 'budget-starved',
    SATURATION_CHANGED: 'saturation-changed',
    THERMAL_WARNING: 'thermal-warning',
    THERMAL_CRITICAL: 'thermal-critical',
    BATTERY_WARNING: 'battery-warning',
    JANK_DETECTED: 'jank-detected',
    TIER_CHANGED: 'tier-changed'
} );

/**
 * TelemetryBudgetHUDLOD
 *
 * Extends AsyncDensityApplicationLOD and adds a full telemetry layer with
 * an on-device HUD optimized for Android 64-bit mobile running Three.js.
 *
 * The class owns:
 *
 *   - Per-LOD telemetry snapshots (density, budget, visibility, SSE, motion,
 *     prediction, async, resolution scale).
 *   - Scene-wide aggregated ledgers (total vertices, triangles, memory bytes,
 *     jank percentage, thermal pressure, battery level).
 *   - A change-event bus (density, level, rejected, starved, saturation).
 *   - A 2D-canvas HUD renderer that can be wrapped into a Three.js
 *     CanvasTexture + Sprite overlay with an OrthographicCamera.
 *   - An Android capability tier detector that inspects `navigator`,
 *     `WebGLRenderingContext`, and the GPU renderer string to classify the
 *     device as LOW / MID / HIGH / FLAGSHIP. This tier can be used to
 *     pre-tune every prior LOD layer at startup.
 *
 * Recommended usage on Android 64-bit:
 * ```js
 * // One-time setup
 * const tier = TelemetryBudgetHUDLOD.detectAndroidTier( renderer );
 * TelemetryBudgetHUDLOD.applyTierPreset( tier );
 *
 * // Per LOD
 * const lod = new TelemetryBudgetHUDLOD();
 * lod.attachTarget( mesh, { vertexBudget: 64000 } );
 * lod.registerWithAllocator( 'world' );
 *
 * // Optional Three.js HUD overlay
 * const hudTexture = new THREE.CanvasTexture( lod.getHUDCanvas() );
 * const hudMaterial = new THREE.SpriteMaterial( { map: hudTexture, depthTest: false } );
 * const hudSprite = new THREE.Sprite( hudMaterial );
 * // Add hudSprite to a dedicated ortho scene rendered after the main scene.
 *
 * // Per frame
 * TelemetryBudgetHUDLOD.beginFrame( frameIndex );
 * for ( const l of allLODs ) l.update( camera, player, dt );
 * AsyncDensityApplicationLOD.flushAsync();
 * TelemetryBudgetHUDLOD.endFrame( deltaTimeMs, renderer );
```

· 
· @augments AsyncDensityApplicationLOD
  */
  class TelemetryBudgetHUDLOD extends AsyncDensityApplicationLOD {
  constructor() {
  super();
  }
  // ─── Public API: events ──────────────────────────────────────────────────
  /**
  · Registers a listener for a telemetry event type.
  · @param {string} eventType - One of TelemetryEvent.
  · @param {Function} callback - (payload) => void.
  · @return {TelemetryBudgetHUDLOD}
    */
    on( eventType, callback ) {
    let set = this._eventListeners.get( eventType );
    if ( set === undefined ) {
    set = new Set();
    this._eventListeners.set( eventType, set );
    }
    set.add( callback );
    return this;
    }
  /**
  · Removes a previously registered listener.
  · @param {string} eventType
  · @param {Function} callback
  · @return {TelemetryBudgetHUDLOD}
    */
    off( eventType, callback ) {
    const set = this._eventListeners.get( eventType );
    if ( set !== undefined ) set.delete( callback );
    return this;
    }
  _emit( eventType, payload ) {
  if ( ! this.emitChangeEvents ) return;
  }
  // ─── Public API: snapshots ───────────────────────────────────────────────
  /**
  · Returns a plain-object snapshot of this LOD's telemetry.
  · @return {object}
    */
    getSnapshot() {
    return {
    density: this._density,
    densityTarget: this._densityTarget,
    densityDelta: this._densityDelta,
    densityVelocity: this._densityVelocity,
    currentLevel: this._currentLevel,
    levelTransitionCount: this._levelTransitionCount,
    desiredVertices: this._desiredVertices,
    allocatedVertices: this._allocatedVertices,
    allocationRatio: this._allocationRatio,
    rejected: this._rejected,
    starved: this._starved,
    visibility: this._visibility,
    inFrustum: this._inFrustum,
    occluded: this._occluded,
    currentSSE: this._currentSSE,
    pixelBudgetUsed: this._pixelBudgetUsed,
    velocityMagnitude: this._velocityMagnitude,
    motionImportance: this._motionImportance,
    futureVisibility: this._futureVisibility,
    predictiveWeight: this._predictiveWeight,
    pendingJobs: this._pendingJobs,
    inflightJobs: this._inflightJobs,
    backPressure: this._backPressure,
    currentScale: this._currentScale,
    adaptiveBias: this._adaptiveBias,
    estimatedTriangleCount: this._estimatedTriangleCount,
    estimatedVertexCount: this._estimatedVertexCount,
    estimatedMemoryBytes: this._estimatedMemoryBytes,
    densityChangeCount: this._densityChangeCount,
    rejectedChangeCount: this._rejectedChangeCount,
    starvedChangeCount: this._starvedChangeCount,
    saturationChangeCount: this._saturationChangeCount
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides AsyncDensityApplicationLOD.update. Runs the full parent chain,
  · then captures a telemetry snapshot and emits change events.
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
    // ── 1. Parent chain runs the entire LOD pipeline. ───────────────────
    super.update( camera, player, rawDeltaTime );
    // ── 2. Sample telemetry. ────────────────────────────────────────────
    const doSample = this.sampleRate <= 1 || ( this._frameIndex % this.sampleRate ) === 0;
    if ( doSample ) {
    this._captureTelemetry();
    this._emitChangeEvents();
    }
    this.syncTelemetryECS();
    }
  _captureTelemetry() {
  // Density.
  this._density = this._dynamicDensity;
  this._densityTarget = this._dynamicTargetDensity;
  this._densityDelta = this._densityTarget - this._density;
  this._densityVelocity = this._densityVelocity;
  }
  _emitChangeEvents() {
  // Density change.
  if ( Math.abs( this._density - this._prevDensity ) > 0.02 ) {
  this._densityChangeCount ++;
  this._lastDensityChangeFrame = this._frameIndex;
  }
  // ─── HUD rendering ───────────────────────────────────────────────────────
  /**
  · Returns the 2D canvas used to draw the HUD. Lazily created on first call.
  · On Android 64-bit, this canvas is safe to wrap into a Three.js
  · CanvasTexture and used as a SpriteMaterial map for an on-screen overlay.
  · 
  · @return {HTMLCanvasElement}
    */
    getHUDCanvas() {
    if ( TelemetryBudgetHUDLOD._hudCanvas === null ) {
    TelemetryBudgetHUDLOD._hudCanvas = document.createElement( 'canvas' );
    TelemetryBudgetHUDLOD._hudCanvas.width = this.hudWidth;
    TelemetryBudgetHUDLOD._hudCanvas.height = this.hudHeight;
    TelemetryBudgetHUDLOD._hudCtx = TelemetryBudgetHUDLOD._hudCanvas.getContext( '2d' );
    }
    return TelemetryBudgetHUDLOD._hudCanvas;
    }
  /**
  · Returns the 2D context used by the HUD canvas.
  · @return {CanvasRenderingContext2D}
    */
    getHUDContext() {
    if ( TelemetryBudgetHUDLOD._hudCtx === null ) this.getHUDCanvas();
    return TelemetryBudgetHUDLOD._hudCtx;
    }
  /**
  · Draws the scene-wide telemetry HUD into the internal canvas.
  · Call once per frame from the host, after all LODs have updated.
    */
    static drawHUD() {
    const S = TelemetryBudgetHUDLOD;
    if ( S._hudCanvas === null ) return;
    const ctx = S._hudCtx;
    const w = S._hudCanvas.width;
    const h = S._hudCanvas.height;
    // Background.
    ctx.clearRect( 0, 0, w, h );
    ctx.fillStyle = TelemetryDefaults.hudBackground;
    ctx.fillRect( 0, 0, w, h );
    // Font.
    ctx.font = TelemetryDefaults.hudFont;
    ctx.textBaseline = 'top';
    const pad = TelemetryDefaults.hudPadding;
    const lineH = TelemetryDefaults.hudLineHeight;
    let y = pad;
    const setColor = ( c ) => { ctx.fillStyle = c; };
    const drawLine = ( label, value, color = TelemetryDefaults.hudForeground ) => {
    setColor( TelemetryDefaults.hudAccent );
    ctx.fillText( label, pad, y );
    setColor( color );
    ctx.fillText( String( value ), pad + 130, y );
    y += lineH;
    };
    // ── Header. ─────────────────────────────────────────────────────────
    setColor( TelemetryDefaults.hudAccent );
    ctx.fillText( 'LOD Telemetry — Android 64-bit / Three.js', pad, y );
    y += lineH + 2;
    // ── Aggregated ledger. ──────────────────────────────────────────────
    const agg = S.getAggregatedLedger();
    drawLine( 'LODs', agg.lodCount );
    drawLine( 'Active LODs', agg.activeLODCount );
    drawLine( 'Total verts', agg.totalVertices );
    drawLine( 'Total tris', agg.totalTriangles );
    drawLine( 'Memory', ( agg.totalMemoryMB ).toFixed( 1 ) + ' MB' );
    // ── Budget. ─────────────────────────────────────────────────────────
    drawLine( 'Budget util', ( agg.budgetUtilization * 100 ).toFixed( 1 ) + '%',
    agg.budgetUtilization > 0.9 ? TelemetryDefaults.hudCritical
    : agg.budgetUtilization > 0.75 ? TelemetryDefaults.hudWarning
    : TelemetryDefaults.hudOk );
    drawLine( 'Rejected', ( agg.rejectionRatio * 100 ).toFixed( 1 ) + '%',
    agg.rejectionRatio > TelemetryDefaults.rejectionCritical ? TelemetryDefaults.hudCritical
    : agg.rejectionRatio > TelemetryDefaults.rejectionWarning ? TelemetryDefaults.hudWarning
    : TelemetryDefaults.hudOk );
    drawLine( 'Starved', ( agg.starvationRatio * 100 ).toFixed( 1 ) + '%',
    agg.starvationRatio > TelemetryDefaults.starvationCritical ? TelemetryDefaults.hudCritical
    : agg.starvationRatio > TelemetryDefaults.starvationWarning ? TelemetryDefaults.hudWarning
    : TelemetryDefaults.hudOk );
    // ── Frame. ──────────────────────────────────────────────────────────
    drawLine( 'Frame (ms)', agg.frameTimeEMA.toFixed( 1 ),
    agg.frameTimeEMA > S._criticalFrameTimeMs ? TelemetryDefaults.hudCritical
    : agg.frameTimeEMA > S._warningFrameTimeMs ? TelemetryDefaults.hudWarning
    : TelemetryDefaults.hudOk );
    drawLine( 'Jank', ( agg.jankRatio * 100 ).toFixed( 1 ) + '%',
    agg.jankRatio > 0.10 ? TelemetryDefaults.hudCritical
    : agg.jankRatio > 0.03 ? TelemetryDefaults.hudWarning
    : TelemetryDefaults.hudOk );
    // ── Android device. ─────────────────────────────────────────────────
    drawLine( 'Tier', AndroidTier[ agg.androidTier ] || 'UNKNOWN' );
    drawLine( 'GPU', S._gpuRendererString !== '' ? S._gpuRendererString.slice( 0, 24 ) : 'n/a' );
    if ( S._batteryLevel >= 0 ) {
    drawLine( 'Battery', ( S._batteryLevel * 100 ).toFixed( 0 ) + '%',
    S._batteryLevel < TelemetryDefaults.batteryWarning ? TelemetryDefaults.hudWarning : TelemetryDefaults.hudForeground );
    }
    if ( S._thermalC > 0 ) {
    drawLine( 'Thermal', S._thermalC.toFixed( 1 ) + ' C',
    S._thermalC > TelemetryDefaults.thermalCriticalC ? TelemetryDefaults.hudCritical
    : S._thermalC > TelemetryDefaults.thermalWarningC ? TelemetryDefaults.hudWarning
    : TelemetryDefaults.hudOk );
    }
    // ── Worst LODs. ─────────────────────────────────────────────────────
    if ( y + lineH * 2 < h ) {
    y += 2;
    setColor( TelemetryDefaults.hudAccent );
    ctx.fillText( 'Worst LODs (by cost)', pad, y );
    y += lineH;
    }
    }
  // ─── Static aggregation ──────────────────────────────────────────────────
  /**
  · Aggregates telemetry across all registered LODs into a single ledger.
  · @return {object}
    */
    static getAggregatedLedger() {
    const S = TelemetryBudgetHUDLOD;
    let totalVertices = 0;
    let totalTriangles = 0;
    let totalMemoryBytes = 0.0;
    let activeCount = 0;
    let rejectedCount = 0;
    let starvedCount = 0;
    for ( const lod of S._registeredTelemetry ) {
    if ( lod.visible && lod._inFrustum ) activeCount ++;
    if ( lod._rejected ) rejectedCount ++;
    if ( lod._starved ) starvedCount ++;
    }
    const lodCount = S._registeredTelemetry.size;
    const poolStats = AsyncDensityApplicationLOD.getPoolStats( 'default' );
    const budgetUtilization = poolStats !== null
    ? poolStats.utilization
    : 0.0;
    const rejectionRatio = lodCount > 0 ? rejectedCount / lodCount : 0.0;
    const starvationRatio = lodCount > 0 ? starvedCount / lodCount : 0.0;
    const jankRatio = S._frameHistoryCount > 0
    ? S._jankFrameCount / S._frameHistoryCount
    : 0.0;
    return {
    lodCount: lodCount,
    activeLODCount: activeCount,
    totalVertices: totalVertices,
    totalTriangles: totalTriangles,
    totalMemoryBytes: totalMemoryBytes,
    totalMemoryMB: totalMemoryBytes / ( 1024 * 1024 ),
    budgetUtilization: budgetUtilization,
    rejectionRatio: rejectionRatio,
    starvationRatio: starvationRatio,
    frameTimeEMA: S._frameTimeEMA,
    jankRatio: jankRatio,
    androidTier: S._androidTier,
    isAndroid64: S._isAndroid64,
    gpuRendererString: S._gpuRendererString,
    batteryLevel: S._batteryLevel,
    thermalC: S._thermalC
    };
    }
  static _registerTelemetryLOD( lod ) {
  TelemetryBudgetHUDLOD._registeredTelemetry.add( lod );
  }
  static _unregisterTelemetryLOD( lod ) {
  TelemetryBudgetHUDLOD._registeredTelemetry.delete( lod );
  }
  // ─── Frame lifecycle ─────────────────────────────────────────────────────
  /**
  · Resets per-frame budgets across every prior layer. Called once per frame.
  · @param {number} frameIndex
    */
    static beginFrame( frameIndex ) {
    AsyncDensityApplicationLOD.beginFrame( frameIndex );
    TelemetryBudgetHUDLOD._frameIndex = frameIndex;
    TelemetryBudgetHUDLOD._frameStartMs = TelemetryBudgetHUDLOD._nowMs();
    }
  /**
  · Records the frame timing and updates aggregated metrics. Called once
  · per frame, after all LOD updates and after AsyncDensityApplicationLOD.flushAsync().
  · 
  · @param {number} frameTimeMs - Frame time in milliseconds.
  · @param {object} [renderer] - Optional Three.js WebGLRenderer for info stats.
    */
    static endFrame( frameTimeMs, renderer = null ) {
    const S = TelemetryBudgetHUDLOD;
    const dt = Math.max( 0.01, Math.min( 500.0, frameTimeMs ) );
    S._frameTimeEMA += ( dt - S._frameTimeEMA ) * TelemetryDefaults.smoothing;
    // Jank detection.
    S._frameHistory[ S._frameHistoryIndex ] = dt;
    S._frameHistoryIndex = ( S._frameHistoryIndex + 1 ) % S._frameHistory.length;
    if ( S._frameHistoryCount < S._frameHistory.length ) S._frameHistoryCount ++;
    // Count jank frames in the ring buffer.
    let jank = 0;
    for ( let i = 0; i < S._frameHistoryCount; i ++ ) {
    if ( S._frameHistory[ i ] > TelemetryDefaults.jankThresholdMs ) jank ++;
    }
    S._jankFrameCount = jank;
    // Emit events for jank.
    if ( dt > TelemetryDefaults.jankThresholdMs ) {
    const evt = {
    frameIndex: S._frameIndex,
    frameTimeMs: dt,
    thresholdMs: TelemetryDefaults.jankThresholdMs
    };
    }
    // Capture Three.js renderer info if provided.
    if ( renderer !== null && renderer.info !== undefined ) {
    S._threeInfoRenderCalls = renderer.info.render.calls || 0;
    S._threeInfoTriangles = renderer.info.render.triangles || 0;
    S._threeInfoGeometries = renderer.info.memory.geometries || 0;
    S._threeInfoTextures = renderer.info.memory.textures || 0;
    }
    // Read Android-specific signals (thermal / battery) every N frames.
    if ( S._frameIndex % 60 === 0 ) {
    S._pollAndroidSignals();
    }
    }
  // ─── Android device detection ────────────────────────────────────────────
  /**
  · Detects the Android 64-bit capability tier of the current device.
  · @param {object} [renderer] - Optional Three.js WebGLRenderer to inspect.
  · @return {number} One of AndroidTier.
    */
    static detectAndroidTier( renderer = null ) {
    const S = TelemetryBudgetHUDLOD;
    // Detect Android and 64-bit.
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    S._isAndroid64 = /Android/i.test( ua ) && /arm64|aarch64|x86_64/i.test( ua );
    // GPU renderer string.
    let gpu = '';
    try {
    if ( renderer !== null && renderer.getContext !== undefined ) {
    const gl = renderer.getContext();
    const dbg = gl.getExtension( 'WEBGL_debug_renderer_info' );
    if ( dbg !== null ) {
    gpu = gl.getParameter( dbg.UNMASKED_RENDERER_WEBGL ) || '';
    }
    }
    } catch ( e ) {
    gpu = '';
    }
    S._gpuRendererString = gpu;
    // RAM class heuristic via deviceMemory (Chrome on Android).
    const deviceMemory = typeof navigator !== 'undefined' && navigator.deviceMemory !== undefined
    ? navigator.deviceMemory
    : 0;
    // Hardware concurrency (CPU cores).
    const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency !== undefined
    ? navigator.hardwareConcurrency
    : 0;
    // Classify.
    let tier = AndroidTier.UNKNOWN;
    const gpuLower = gpu.toLowerCase();
    const isFlagship = /adreno.7[3-9]\d|adreno.[89]\d\d|immortalis-g7(1[5-9]|[2-9]\d)|mali-g7(1[5-9]|[2-9]\d)/.test( gpuLower );
    const isHigh = /adreno.7[0-2]\d|adreno.6[5-9]\d|immortalis-g7(1[0-4])|mali-g7(1[0-4])/.test( gpuLower );
    const isMid = /adreno.6[1-4]\d|adreno.6[0-4]\d|mali-g(6[89]|7[0-4])/.test( gpuLower );
    const isLow = /adreno.*5\d\d|mali-g5\d|mali-t\d/.test( gpuLower );
    if ( isFlagship || deviceMemory >= 12 ) tier = AndroidTier.FLAGSHIP;
    else if ( isHigh || deviceMemory >= 8 ) tier = AndroidTier.HIGH;
    else if ( isMid || deviceMemory >= 6 ) tier = AndroidTier.MID;
    else if ( isLow || deviceMemory >= 2 ) tier = AndroidTier.LOW;
    else if ( cores >= 8 ) tier = AndroidTier.MID;
    else if ( cores >= 4 ) tier = AndroidTier.LOW;
    else tier = AndroidTier.LOW;
    S._androidTier = tier;
    return tier;
    }
  /**
  · Applies a preset to every prior LOD layer tuned for the given Android
  · tier. Call this once at startup after detectAndroidTier.
  · 
  · @param {number} tier - One of AndroidTier.
    */
    static applyTierPreset( tier ) {
    const S = TelemetryBudgetHUDLOD;
    S._appliedTier = tier;
    // Frame time thresholds for warning / critical states in the HUD.
    if ( tier === AndroidTier.FLAGSHIP ) {
    S._warningFrameTimeMs = 11.1;  // 90 FPS target
    S._criticalFrameTimeMs = 16.7; // 60 FPS target
    S._hudWorstCount = 8;
    } else if ( tier === AndroidTier.HIGH ) {
    S._warningFrameTimeMs = 13.3;  // 75 FPS target
    S._criticalFrameTimeMs = 16.7;
    S._hudWorstCount = 8;
    } else if ( tier === AndroidTier.MID ) {
    S._warningFrameTimeMs = 16.7;  // 60 FPS target
    S._criticalFrameTimeMs = 22.2; // 45 FPS target
    S._hudWorstCount = 6;
    } else {
    S._warningFrameTimeMs = 22.2;  // 45 FPS target
    S._criticalFrameTimeMs = 33.3; // 30 FPS target
    S._hudWorstCount = 4;
    }
    // Notify all registered LODs of the tier change.
    for ( const lod of S._registeredTelemetry ) {
    lod._emit( TelemetryEvent.TIER_CHANGED, { tier: tier, preset: S._appliedTier } );
    }
    }
  static _pollAndroidSignals() {
  const S = TelemetryBudgetHUDLOD;
  }
  static _nowMs() {
  if ( typeof performance !== 'undefined' && typeof performance.now === 'function' ) {
  return performance.now();
  }
  return Date.now();
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerTelemetryECS() {
  if ( this._ecsTelemetryRegistered ) {
  return this._ecsTelemetryEntity;
  }
  }
  syncTelemetryECS() {
  if ( ! this._ecsTelemetryRegistered ) {
  return this;
  }
  }
  pullTelemetryECS() {
  if ( ! this._ecsTelemetryRegistered ) {
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
  · Returns the total estimated memory in bytes using double.js for
  · high-precision aggregation across very large scenes.
  · @return {number}
    */
    computeMemoryBytesHighPrecision() {
    return new Double( this._estimatedVertexCount ).mul( new Double( 32 ) ).valueOf();
    }
  /**
  · Returns a deterministic sampling jitter used to avoid telemetry
  · aliasing when many LODs sample in the same frame.
  · @param {number} frameIndex
  · @return {number}
    */
    computeSamplingJitter( frameIndex ) {
    const seed = ( this.determinismSeed ^ ( this._ecsEntity >>> 0 ) ) >>> 0;
    return _noise3D( seed * 1e-6, frameIndex * 0.05, this.id ) * 0.5;
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
  · Packs per-LOD telemetry into a vec4 for GPU debug rendering.
  · Layout: (density, allocationRatio, visibility, estimatedVertexCount)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packTelemetryVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._density,
    this._allocationRatio,
    this._visibility,
    this._estimatedVertexCount
    );
    return v;
    }
  static getECSWorld() {
  return _telemetryWorld;
  }
  static getTelemetrySoA() {
  return TelemetrySoA;
  }
  static get TelemetryDefaults() {
  return TelemetryDefaults;
  }
  static get AndroidTier() {
  return AndroidTier;
  }
  static get TelemetryEvent() {
  return TelemetryEvent;
  }
  }

// ─── Static telemetry storage (module-scoped, shared across all instances) ──
TelemetryBudgetHUDLOD._registeredTelemetry = new Set();
TelemetryBudgetHUDLOD._frameIndex = 0;
TelemetryBudgetHUDLOD._frameStartMs = 0;
TelemetryBudgetHUDLOD._frameTimeEMA = 16.67;
TelemetryBudgetHUDLOD._frameHistory = new Float64Array( TelemetryDefaults.frameHistoryLength );
TelemetryBudgetHUDLOD._frameHistoryIndex = 0;
TelemetryBudgetHUDLOD._frameHistoryCount = 0;
TelemetryBudgetHUDLOD._jankFrameCount = 0;

TelemetryBudgetHUDLOD._hudCanvas = null;
TelemetryBudgetHUDLOD._hudCtx = null;
TelemetryBudgetHUDLOD._hudWorstCount = TelemetryDefaults.worstLODCount;
TelemetryBudgetHUDLOD._worstLODScratch = [];

TelemetryBudgetHUDLOD._androidTier = AndroidTier.UNKNOWN;
TelemetryBudgetHUDLOD._isAndroid64 = false;
TelemetryBudgetHUDLOD._gpuRendererString = '';
TelemetryBudgetHUDLOD._appliedTier = AndroidTier.UNKNOWN;
TelemetryBudgetHUDLOD._warningFrameTimeMs = 16.7;
TelemetryBudgetHUDLOD._criticalFrameTimeMs = 33.3;

TelemetryBudgetHUDLOD._batteryManager = null;
TelemetryBudgetHUDLOD._batteryLevel = - 1;
TelemetryBudgetHUDLOD._thermalC = - 1;

TelemetryBudgetHUDLOD._threeInfoRenderCalls = 0;
TelemetryBudgetHUDLOD._threeInfoTriangles = 0;
TelemetryBudgetHUDLOD._threeInfoGeometries = 0;
TelemetryBudgetHUDLOD._threeInfoTextures = 0;

export {
TelemetryBudgetHUDLOD,
TelemetrySoA,
TelemetryDefaults,
AndroidTier,
TelemetryEvent
};
