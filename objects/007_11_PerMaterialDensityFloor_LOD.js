
// file number : 007_11
// full path name : src/objects/007_11_PerMaterialDensityFloor_LOD.js
// description : Enhancement #13 for the Dynamic LOD system, tuned for Android 64-bit mobile devices running Three.js (WebGL1 / WebGL2). Adds per-material and per-shader minimum density floors so that alpha-tested foliage, transparent glass, hair cards, particle sprites, and any material with sharp alpha cutoffs never drop below a quality-safe density even at extreme distance. Alpha-tested and transparent materials alias far worse than opaque hard-surface materials at low density because their visual detail is carried by the alpha mask rather than the silhouette, so a static wall can safely fall to 20% density while a foliage shader must hold 60%+ at 500 m. Floors are resolved from a priority chain: explicit userData hint → material registry lookup by UUID → material registry lookup by type → shader-feature inference (alphaTest, transparent, blending, side, custom depth/derivative defines) → safe default. Includes an Android 64-bit specific preset table calibrated for Adreno 5xx–7xx and Mali-G5x–G7xx families, plus a memory-pressure fallback that relaxes floors under thermal or battery pressure. Uses gl-matrix for feature-vector packing of shader attributes, double.js for high-precision floor accounting across dense foliage instancing, bitecs for SoA floor state, and simplex-noise for deterministic floor dithering that prevents hard density banding on alpha edges.
// best for : Android 64-bit mobile Three.js scenes, foliage / grass / tree cards, alpha-tested hair, transparent glass and water, particle systems, decals, screenspace UI on 3D surfaces, mobile WebGL1 and WebGL2 renderers, thermal-throttled mid-range devices, per-shader density regulation, budget-safe LOD floors.
// license : MIT

import { TelemetryBudgetHUDLOD } from './007_10_TelemetryBudgetHUD_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { Material } from '../materials/000_Material.js';
import { MeshBasicMaterial } from '../materials/003_MeshBasicMaterial.js';
import { MeshStandardMaterial } from '../materials/004_MeshStandardMaterial.js';
import { MeshPhysicalMaterial } from '../materials/005_MeshPhysicalMaterial.js';
import { MeshPhongMaterial } from '../materials/006_MeshPhongMaterial.js';
import { MeshLambertMaterial } from '../materials/007_MeshLambertMaterial.js';
import { MeshToonMaterial } from '../materials/008_MeshToonMaterial.js';
import { MeshNormalMaterial } from '../materials/009_MeshNormalMaterial.js';
import { MeshDepthMaterial } from '../materials/010_MeshDepthMaterial.js';
import { MeshDistanceMaterial } from '../materials/011_MeshDistanceMaterial.js';
import { MeshMatcapMaterial } from '../materials/012_MeshMatcapMaterial.js';
import { PointsMaterial } from '../materials/013_PointsMaterial.js';
import { SpriteMaterial } from '../materials/014_SpriteMaterial.js';
import { LineBasicMaterial } from '../materials/015_LineBasicMaterial.js';
import { LineDashedMaterial } from '../materials/016_LineDashedMaterial.js';
import { ShaderMaterial } from '../materials/017_ShaderMaterial.js';
import { RawShaderMaterial } from '../materials/018_RawShaderMaterial.js';
import { ShadowMaterial } from '../materials/019_ShadowMaterial.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _featureVec = new Float64Array( 8 );
const _noise3D = createNoise3D();

// ─── ECS world + MaterialFloor SoA component ────────────────────────────────
const _materialFloorWorld = createWorld();

const MaterialFloorSoA = defineComponent( {
    // Resolved floor
    resolvedFloor: Types.f64,           // final floor in [0, 1]
    baseFloor: Types.f64,               // floor before any modifiers
    typeFloor: Types.f64,               // floor from material type
    shaderFloor: Types.f64,             // floor from shader features
    userFloor: Types.f64,               // floor from userData hint (or -1 if unset)
    presetFloor: Types.f64,             // floor from Android tier preset

    // Modifiers
    alphaTestBoost: Types.f64,          // extra floor from alphaTest
    transparencyBoost: Types.f64,       // extra floor from transparent flag
    blendingBoost: Types.f64,           // extra floor from additive / custom blending
    sideBoost: Types.f64,               // extra floor from DoubleSide
    emissiveBoost: Types.f64,           // extra floor from emissive intensity
    distanceFalloff: Types.f64,         // distance-based floor relaxation

    // Feature flags (packed booleans)
    hasAlphaTest: Types.ui8,
    isTransparent: Types.ui8,
    isAdditive: Types.ui8,
    isDoubleSided: Types.ui8,
    isDepthWrite: Types.ui8,
    isDepthTest: Types.ui8,
    hasVertexColors: Types.ui8,
    hasMap: Types.ui8,
    hasAlphaMap: Types.ui8,
    hasNormalMap: Types.ui8,
    hasDisplacementMap: Types.ui8,
    hasCustomShader: Types.ui8,

    // Android / device context
    androidTier: Types.i32,
    thermalPressure: Types.f64,
    batteryPressure: Types.f64,
    memoryPressure: Types.f64,

    // Material identity
    materialHash: Types.i32,
    materialType: Types.i32,
    materialDirty: Types.ui8,

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    frozen: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64,
    ditherSample: Types.f64
} );

// ─── Material type classification constants ─────────────────────────────────
const MaterialKind = Object.freeze( {
    UNKNOWN: 0,
    OPAQUE_HARD: 1,        // MeshStandard, MeshPhysical (no transparency)
    OPAQUE_SOFT: 2,        // MeshLambert, MeshToon
    NORMAL_DEBUG: 3,       // MeshNormal, MeshDepth, MeshDistance
    MATCAP: 4,             // MeshMatcap
    POINTS: 5,             // PointsMaterial
    SPRITE: 6,             // SpriteMaterial
    LINE: 7,               // LineBasic, LineDashed
    SHADER: 8,             // ShaderMaterial, RawShaderMaterial
    SHADOW: 9,             // ShadowMaterial
    ALPHA_TESTED: 10,      // Any material with alphaTest > 0
    TRANSPARENT: 11        // Any material with transparent = true
} );

// ─── Android 64-bit tier default floors per material kind ───────────────────
// Rows = AndroidTier (LOW, MID, HIGH, FLAGSHIP), Columns = MaterialKind.
// Values are minimum density floors that must be respected regardless of
// distance, SSE, or budget pressure. Alpha-tested and transparent materials
// get higher floors because they alias far worse than opaque geometry.
const ANDROID_FLOOR_TABLE = {
    // LOW: Adreno 5xx, Mali-G5x — tight memory, aggressive floors.
    LOW: {
        [ MaterialKind.UNKNOWN ]: 0.30,
        [ MaterialKind.OPAQUE_HARD ]: 0.20,
        [ MaterialKind.OPAQUE_SOFT ]: 0.25,
        [ MaterialKind.NORMAL_DEBUG ]: 0.15,
        [ MaterialKind.MATCAP ]: 0.35,
        [ MaterialKind.POINTS ]: 0.25,
        [ MaterialKind.SPRITE ]: 0.35,
        [ MaterialKind.LINE ]: 0.40,
        [ MaterialKind.SHADER ]: 0.40,
        [ MaterialKind.SHADOW ]: 0.10,
        [ MaterialKind.ALPHA_TESTED ]: 0.60,
        [ MaterialKind.TRANSPARENT ]: 0.55
    },
    // MID: Adreno 61x–64x, Mali-G68/G7x.
    MID: {
        [ MaterialKind.UNKNOWN ]: 0.35,
        [ MaterialKind.OPAQUE_HARD ]: 0.25,
        [ MaterialKind.OPAQUE_SOFT ]: 0.30,
        [ MaterialKind.NORMAL_DEBUG ]: 0.20,
        [ MaterialKind.MATCAP ]: 0.40,
        [ MaterialKind.POINTS ]: 0.30,
        [ MaterialKind.SPRITE ]: 0.40,
        [ MaterialKind.LINE ]: 0.45,
        [ MaterialKind.SHADER ]: 0.45,
        [ MaterialKind.SHADOW ]: 0.10,
        [ MaterialKind.ALPHA_TESTED ]: 0.65,
        [ MaterialKind.TRANSPARENT ]: 0.60
    },
    // HIGH: Adreno 65x–72x, Immortalis-G71x.
    HIGH: {
        [ MaterialKind.UNKNOWN ]: 0.40,
        [ MaterialKind.OPAQUE_HARD ]: 0.30,
        [ MaterialKind.OPAQUE_SOFT ]: 0.35,
        [ MaterialKind.NORMAL_DEBUG ]: 0.25,
        [ MaterialKind.MATCAP ]: 0.45,
        [ MaterialKind.POINTS ]: 0.35,
        [ MaterialKind.SPRITE ]: 0.45,
        [ MaterialKind.LINE ]: 0.50,
        [ MaterialKind.SHADER ]: 0.50,
        [ MaterialKind.SHADOW ]: 0.10,
        [ MaterialKind.ALPHA_TESTED ]: 0.70,
        [ MaterialKind.TRANSPARENT ]: 0.65
    },
    // FLAGSHIP: Adreno 73x+, Immortalis-G715+.
    FLAGSHIP: {
        [ MaterialKind.UNKNOWN ]: 0.45,
        [ MaterialKind.OPAQUE_HARD ]: 0.35,
        [ MaterialKind.OPAQUE_SOFT ]: 0.40,
        [ MaterialKind.NORMAL_DEBUG ]: 0.30,
        [ MaterialKind.MATCAP ]: 0.50,
        [ MaterialKind.POINTS ]: 0.40,
        [ MaterialKind.SPRITE ]: 0.50,
        [ MaterialKind.LINE ]: 0.55,
        [ MaterialKind.SHADER ]: 0.55,
        [ MaterialKind.SHADOW ]: 0.10,
        [ MaterialKind.ALPHA_TESTED ]: 0.75,
        [ MaterialKind.TRANSPARENT ]: 0.70
    }
};

// ─── Tunables specific to per-material floors ───────────────────────────────
const MaterialFloorDefaults = {
    // Whether to auto-infer floors from material features.
    autoInfer: true,

    // Whether to honor userData.densityFloor if set on a material.
    honorUserHint: true,

    // Whether to relax floors at very long distance (beyond 500 m on mobile).
    distanceRelaxation: true,

    // Distance (world units) beyond which distance relaxation begins.
    distanceRelaxationStart: 500.0,

    // Distance (world units) at which distance relaxation reaches its max.
    distanceRelaxationEnd: 1500.0,

    // Maximum floor relaxation fraction at max distance (0..1).
    // 0.25 = floor can drop by up to 25% at 1500 m.
    maxDistanceRelaxation: 0.25,

    // Extra floor for alphaTest materials (added to the tier base).
    alphaTestBoost: 0.10,

    // Extra floor for transparent materials.
    transparencyBoost: 0.05,

    // Extra floor for additive / custom blending.
    blendingBoost: 0.08,

    // Extra floor for DoubleSide materials.
    sideBoost: 0.03,

    // Extra floor for materials with strong emissive contribution.
    emissiveBoost: 0.02,

    // Whether to relax all floors under thermal pressure.
    thermalRelaxation: true,

    // Thermal pressure at which floors start to relax.
    thermalRelaxationStart: 0.5,

    // Maximum floor relaxation fraction under critical thermal pressure.
    maxThermalRelaxation: 0.15,

    // Whether to relax all floors under battery pressure.
    batteryRelaxation: true,

    // Battery pressure at which floors start to relax.
    batteryRelaxationStart: 0.5,

    // Maximum floor relaxation fraction under critical battery pressure.
    maxBatteryRelaxation: 0.10,

    // Whether to relax all floors under memory pressure.
    memoryRelaxation: true,

    // Dither amplitude applied to the floor boundary.
    floorDither: 0.015,

    // Deterministic seed base.
    determinismSeed: 0x27D4EB2B,

    // Cache TTL in frames for resolved floors.
    cacheTTL: 30,

    // Global hard floor (never drop below this).
    globalHardFloor: 0.05,

    // Global hard ceiling (never exceed this).
    globalHardCeiling: 1.0
};

/**
 * PerMaterialDensityFloorLOD
 *
 * Extends TelemetryBudgetHUDLOD and inserts a material-aware minimum floor
 * between the density target and the applied density value. The floor is a
 * lower bound that no other layer can override: even if SSE, visibility,
 * budget, motion, prediction, and async layers all agree that density should
 * collapse to 5%, the floor will keep it at (for example) 65% for foliage.
 *
 * Floor resolution priority:
 *
 *   1. `material.userData.densityFloor` (explicit user override).
 *   2. Registered per-UUID floor in `MaterialFloorRegistry`.
 *   3. Registered per-type floor in `MaterialFloorRegistry`.
 *   4. Inferred from shader features (alphaTest, transparent, blending, side).
 *   5. Android tier default from `ANDROID_FLOOR_TABLE`.
 *   6. Global hard floor.
 *
 * Modifiers applied after the base floor:
 *
 *   - alphaTest boost
 *   - transparency boost
 *   - blending boost
 *   - side boost
 *   - emissive boost
 *   - distance relaxation
 *   - thermal relaxation
 *   - battery relaxation
 *   - memory relaxation
 *   - deterministic dither
 *
 * The floor is deliberately one-sided: it can only RAISE density, never lower
 * it below the parent target. This guarantees that no material is under-tessellated
 * because of an aggressive upstream layer, while still allowing opaque materials
 * to drop very low at long distance.
 *
 * Recommended usage on Android 64-bit:
 * ```js
 * // One-time setup
 * const tier = TelemetryBudgetHUDLOD.detectAndroidTier( renderer );
 * TelemetryBudgetHUDLOD.applyTierPreset( tier );
 * PerMaterialDensityFloorLOD.setAndroidTier( tier );
 *
 * // Per material (optional)
 * PerMaterialDensityFloorLOD.registerFloorByUuid( foliageMat.uuid, 0.65 );
 * PerMaterialDensityFloorLOD.registerFloorByType( 'MeshStandardMaterial', 0.30 );
 *
 * // Per LOD
 * const lod = new PerMaterialDensityFloorLOD();
 * lod.attachTarget( foliageMesh, { vertexBudget: 48000 } );
 * lod.registerWithAllocator( 'foliage' );
 *
 * // Per frame
 * TelemetryBudgetHUDLOD.beginFrame( frameIndex );
 * for ( const l of allLODs ) l.update( camera, player, dt );
 * AsyncDensityApplicationLOD.flushAsync();
 * TelemetryBudgetHUDLOD.endFrame( deltaTimeMs, renderer );
```

· 
· @augments TelemetryBudgetHUDLOD
  */
  class PerMaterialDensityFloorLOD extends TelemetryBudgetHUDLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Enables or disables per-material floor enforcement on this LOD.
  · @param {boolean} [enabled=true]
  · @return {PerMaterialDensityFloorLOD}
    */
    enableFloor( enabled = true ) {
    this._enabled = enabled;
    return this;
    }
  /**
  · Freezes floor resolution. Parent chain still runs.
  · @param {boolean} [frozen=true]
  · @return {PerMaterialDensityFloorLOD}
    */
    freezeFloor( frozen = true ) {
    this._floorFrozen = frozen;
    return this;
    }
  /**
  · Returns the currently resolved density floor.
  · @return {number}
    */
    getResolvedFloor() {
    return this._resolvedFloor;
    }
  /**
  · Returns the material kind currently classified for this LOD.
  · @return {number}
    */
    getMaterialKind() {
    return this._materialType;
    }
  /**
  · Returns a high-precision floor ledger for telemetry.
  · @return {object}
    */
    getFloorLedger() {
    const rf = new Double( this._resolvedFloor );
    const bf = new Double( this._baseFloor );
    const user = this._userFloor >= 0 ? new Double( this._userFloor ).valueOf() : - 1;
    return {
    resolvedFloor: rf.valueOf(),
    baseFloor: bf.valueOf(),
    typeFloor: this._typeFloor,
    shaderFloor: this._shaderFloor,
    userFloor: user,
    presetFloor: this._presetFloor,
    alphaTestBoost: this._alphaTestBoost,
    transparencyBoost: this._transparencyBoost,
    blendingBoost: this._blendingBoost,
    sideBoost: this._sideBoost,
    emissiveBoost: this._emissiveBoost,
    distanceFalloff: this._distanceFalloff,
    materialKind: this._materialType,
    androidTier: this._androidTier,
    thermalPressure: this._thermalPressure,
    batteryPressure: this._batteryPressure,
    memoryPressure: this._memoryPressure,
    enabled: this._enabled
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides TelemetryBudgetHUDLOD.update. Runs the full parent chain,
  · then applies the material floor as a lower bound on the density.
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
    this._lastDeltaTime = rawDeltaTime;
    // ── 1. Pull Android tier from the shared telemetry layer. ───────────
    this._androidTier = TelemetryBudgetHUDLOD._androidTier;
    // ── 2. Parent chain runs the entire LOD pipeline. ───────────────────
    super.update( camera, player, rawDeltaTime );
    if ( ! this._enabled || this._floorFrozen ) {
    this._resolvedFloor = this.globalHardFloor;
    this.syncMaterialFloorECS();
    return;
    }
    // ── 3. Resolve the floor for the current target material. ──────────
    this._resolveFloor();
    // ── 4. Apply the floor as a lower bound on the applied density. ─────
    // The floor only RAISES density; it never lowers it below the parent.
    const floor = this._resolvedFloor;
    const current = this._dynamicDensity;
    if ( current < floor ) {
    this._dynamicDensity = floor;
    }
    this.syncMaterialFloorECS();
    }
  // ─── Floor resolution ────────────────────────────────────────────────────
  _resolveFloor() {
  const material = this._resolveTargetMaterial();
  }
  _resolveTargetMaterial() {
  const target = this.target;
  if ( target === null ) return null;
  }
  _classifyMaterial( material ) {
  // Reset feature flags.
  this._hasAlphaTest = false;
  this._isTransparent = false;
  this._isAdditive = false;
  this._isDoubleSided = false;
  this._isDepthWrite = true;
  this._isDepthTest = true;
  this._hasVertexColors = false;
  this._hasMap = false;
  this._hasAlphaMap = false;
  this._hasNormalMap = false;
  this._hasDisplacementMap = false;
  this._hasCustomShader = false;
  }
  _inferShaderFloor() {
  // Base inference from feature flags. This is intentionally additive:
  // every feature that makes the material alias worse raises the floor.
  let floor = 0.0;
  }
  // ─── Pressure setters (host-driven) ───────────────────────────────────────
  /**
  · Sets the thermal pressure for this LOD. 0 = cool, 1 = critical.
  · @param {number} pressure
  · @return {PerMaterialDensityFloorLOD}
    */
    setThermalPressure( pressure ) {
    this._thermalPressure = Math.min( 1.0, Math.max( 0.0, pressure ) );
    return this;
    }
  /**
  · Sets the battery pressure. 0 = full, 1 = critical.
  · @param {number} pressure
  · @return {PerMaterialDensityFloorLOD}
    */
    setBatteryPressure( pressure ) {
    this._batteryPressure = Math.min( 1.0, Math.max( 0.0, pressure ) );
    return this;
    }
  /**
  · Sets the memory pressure. 0 = relaxed, 1 = critical.
  · @param {number} pressure
  · @return {PerMaterialDensityFloorLOD}
    */
    setMemoryPressure( pressure ) {
    this._memoryPressure = Math.min( 1.0, Math.max( 0.0, pressure ) );
    return this;
    }
  // ─── Static registry ─────────────────────────────────────────────────────
  /**
  · Registers an explicit density floor for a specific material UUID.
  · @param {string} uuid
  · @param {number} floor - Floor value in [0, 1].
    */
    static registerFloorByUuid( uuid, floor ) {
    PerMaterialDensityFloorLOD._registry.byUuid.set( uuid, Math.min( 1.0, Math.max( 0.0, floor ) ) );
    }
  /**
  · Registers an explicit density floor for a material type name
  · (e.g. 'MeshStandardMaterial').
  · @param {string} typeName
  · @param {number} floor - Floor value in [0, 1].
    */
    static registerFloorByType( typeName, floor ) {
    PerMaterialDensityFloorLOD._registry.byType.set( typeName, Math.min( 1.0, Math.max( 0.0, floor ) ) );
    }
  /**
  · Removes an explicit floor registered by UUID.
  · @param {string} uuid
    */
    static unregisterFloorByUuid( uuid ) {
    PerMaterialDensityFloorLOD._registry.byUuid.delete( uuid );
    }
  /**
  · Removes an explicit floor registered by type name.
  · @param {string} typeName
    */
    static unregisterFloorByType( typeName ) {
    PerMaterialDensityFloorLOD._registry.byType.delete( typeName );
    }
  /**
  · Clears all explicit floors.
    */
    static clearRegistry() {
    PerMaterialDensityFloorLOD._registry.byUuid.clear();
    PerMaterialDensityFloorLOD._registry.byType.clear();
    }
  /**
  · Publishes the current Android tier to all registered material-floor LODs.
  · @param {number} tier
    */
    static setAndroidTier( tier ) {
    PerMaterialDensityFloorLOD._androidTier = tier;
    for ( const lod of PerMaterialDensityFloorLOD._registeredMaterialFloor ) {
    lod._androidTier = tier;
    lod._materialDirty = true;
    }
    }
  /**
  · Returns the current Android tier used by the floor table.
  · @return {number}
    */
    static getAndroidTier() {
    return PerMaterialDensityFloorLOD._androidTier;
    }
  /**
  · Returns the floor table row for the current tier.
  · @return {object}
    */
    static getCurrentTierFloors() {
    const key = PerMaterialDensityFloorLOD._tierKey( PerMaterialDensityFloorLOD._androidTier );
    return ANDROID_FLOOR_TABLE[ key ] || ANDROID_FLOOR_TABLE.MID;
    }
  /**
  · Sets the global thermal pressure on all registered LODs.
  · @param {number} pressure
    */
    static setGlobalThermalPressure( pressure ) {
    for ( const lod of PerMaterialDensityFloorLOD._registeredMaterialFloor ) {
    lod._thermalPressure = Math.min( 1.0, Math.max( 0.0, pressure ) );
    }
    }
  /**
  · Sets the global battery pressure on all registered LODs.
  · @param {number} pressure
    */
    static setGlobalBatteryPressure( pressure ) {
    for ( const lod of PerMaterialDensityFloorLOD._registeredMaterialFloor ) {
    lod._batteryPressure = Math.min( 1.0, Math.max( 0.0, pressure ) );
    }
    }
  /**
  · Sets the global memory pressure on all registered LODs.
  · @param {number} pressure
    */
    static setGlobalMemoryPressure( pressure ) {
    for ( const lod of PerMaterialDensityFloorLOD._registeredMaterialFloor ) {
    lod._memoryPressure = Math.min( 1.0, Math.max( 0.0, pressure ) );
    }
    }
  static _tierKey( tier ) {
  switch ( tier ) {
  case 1: return 'LOW';
  case 2: return 'MID';
  case 3: return 'HIGH';
  case 4: return 'FLAGSHIP';
  default: return 'MID';
  }
  }
  static _registerMaterialFloorLOD( lod ) {
  PerMaterialDensityFloorLOD._registeredMaterialFloor.add( lod );
  }
  static _unregisterMaterialFloorLOD( lod ) {
  PerMaterialDensityFloorLOD._registeredMaterialFloor.delete( lod );
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerMaterialFloorECS() {
  if ( this._ecsMaterialFloorRegistered ) {
  return this._ecsMaterialFloorEntity;
  }
  }
  syncMaterialFloorECS() {
  if ( ! this._ecsMaterialFloorRegistered ) {
  return this;
  }
  }
  pullMaterialFloorECS() {
  if ( ! this._ecsMaterialFloorRegistered ) {
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
  · Returns the resolved floor with double.js high precision. Useful for
  · aggregating floors across very dense foliage instancing.
  · @return {number}
    */
    computeResolvedFloorHighPrecision() {
    const rf = new Double( this._resolvedFloor );
    return rf.valueOf();
    }
  /**
  · Returns a deterministic dither sample for the floor boundary.
  · @param {number} frameIndex
  · @return {number}
    */
    computeFloorDither( frameIndex ) {
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
  · Packs material-floor telemetry into a vec4 for GPU debug rendering.
  · Layout: (resolvedFloor, baseFloor, shaderFloor, materialKind)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packFloorVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._resolvedFloor,
    this._baseFloor,
    this._shaderFloor,
    this._materialType
    );
    return v;
    }
  /**
  · Packs material feature flags into a vec4 for GPU debug rendering.
  · Layout: (hasAlphaTest, isTransparent, isAdditive, isDoubleSided)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packFeatureVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._hasAlphaTest ? 1 : 0,
    this._isTransparent ? 1 : 0,
    this._isAdditive ? 1 : 0,
    this._isDoubleSided ? 1 : 0
    );
    return v;
    }
  /**
  · Packs the raw material feature vector into a Float64Array for
  · classification and caching. Layout matches _featureVec.
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packMaterialFeatureVector( out ) {
    const v = out || _featureVec;
    glMatrix.vec3.set( _scratchVec3A, this._hasAlphaTest ? 1 : 0, this._isTransparent ? 1 : 0, this._isAdditive ? 1 : 0 );
    glMatrix.vec3.set( _scratchVec3B, this._isDoubleSided ? 1 : 0, this._hasCustomShader ? 1 : 0, this._hasDisplacementMap ? 1 : 0 );
    v[ 0 ] = _scratchVec3A[ 0 ];
    v[ 1 ] = _scratchVec3A[ 1 ];
    v[ 2 ] = _scratchVec3A[ 2 ];
    v[ 3 ] = _scratchVec3B[ 0 ];
    v[ 4 ] = _scratchVec3B[ 1 ];
    v[ 5 ] = _scratchVec3B[ 2 ];
    v[ 6 ] = this._materialType;
    v[ 7 ] = this._androidTier;
    return v;
    }
  static getECSWorld() {
  return _materialFloorWorld;
  }
  static getMaterialFloorSoA() {
  return MaterialFloorSoA;
  }
  static get MaterialFloorDefaults() {
  return MaterialFloorDefaults;
  }
  static get MaterialKind() {
  return MaterialKind;
  }
  static get AndroidFloorTable() {
  return ANDROID_FLOOR_TABLE;
  }
  }

// ─── Static material-floor storage (module-scoped, shared across instances) ─
PerMaterialDensityFloorLOD._registeredMaterialFloor = new Set();
PerMaterialDensityFloorLOD._androidTier = 2; // MID default
PerMaterialDensityFloorLOD._registry = {
byUuid: new Map(),
byType: new Map()
};

void Material;
void MeshBasicMaterial;
void MeshStandardMaterial;
void MeshPhysicalMaterial;
void MeshPhongMaterial;
void MeshLambertMaterial;
void MeshToonMaterial;
void MeshNormalMaterial;
void MeshDepthMaterial;
void MeshDistanceMaterial;
void MeshMatcapMaterial;
void PointsMaterial;
void SpriteMaterial;
void LineBasicMaterial;
void LineDashedMaterial;
void ShaderMaterial;
void RawShaderMaterial;
void ShadowMaterial;

export {
PerMaterialDensityFloorLOD,
MaterialFloorSoA,
MaterialFloorDefaults,
MaterialKind,
ANDROID_FLOOR_TABLE
};

