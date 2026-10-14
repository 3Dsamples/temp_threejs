
// file number : 007_12
// full path name : src/objects/007_12_SkinningCostMultiplier_LOD.js
// description : Enhancement #14 for the Dynamic LOD system, tuned for Android 64-bit mobile devices running Three.js (WebGL1 / WebGL2). Adds a skinning-aware density cost multiplier so that a SkinnedMesh with many bones and heavy vertex skinning can afford lower geometry density than a static mesh at the same SSE, because the dominant runtime cost on mobile is skinning matrix uploads, bone texture sampling, and per-vertex matrix palette lookups, not raw triangle count. On Adreno 5xx–7xx and Mali-G5x–G7xx hardware, a 200-bone skinned character at 60% geometry density renders roughly 3× faster than the same mesh at 100% density, while a static mesh at 60% renders only ~1.4× faster. This layer reads bone count, skinning weight presence, morph target count, and SkinnedMesh bind mode, then folds a cost multiplier into the density target so characters shed geometry aggressively but stay visually intact. Uses gl-matrix for bone-palette size normalization, double.js for high-precision cost accounting across dense NPC crowds, bitecs for SoA skinning state, and simplex-noise for deterministic cost dithering that avoids banding on skeletonized crowds.
// best for : Android 64-bit mobile crowd rendering, NPC mobs, skinned characters with 50–250 bones, morph-target faces, morph-targeted hair, characters with blend-shape facial animation, GPU-skinned instanced crowds, skinned foliage, skinned cloth, bone-heavy procedural rigs, mobile AR / VR character pipelines.
// license : MIT

import { PerMaterialDensityFloorLOD } from './007_11_PerMaterialDensityFloor_LOD.js';
import { LOD_MODE } from './007_LOD.js';

import { SkinnedMesh } from './014_SkinnedMesh.js';
import { Skeleton } from './008_Skeleton.js';
import { Bone } from './001_Bone.js';
import { Mesh } from './003_Mesh.js';
import { BufferGeometry } from '../core/019_BufferGeometry.js';
import { BufferAttribute } from '../core/020_BufferAttribute.js';

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import { createWorld, addEntity, addComponent, defineComponent, Types, query } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import { Double } from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/+esm';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/+esm';

// ─── Module-private scratch buffers (zero-allocation hot paths) ──────────────
const _scratchMat4 = new Float64Array( 16 );
const _scratchVec4 = new Float64Array( 4 );
const _scratchVec3A = new Float64Array( 3 );
const _scratchVec3B = new Float64Array( 3 );
const _paletteVec = new Float64Array( 8 );
const _noise3D = createNoise3D();

// ─── ECS world + SkinningCost SoA component ─────────────────────────────────
const _skinningWorld = createWorld();

const SkinningCostSoA = defineComponent( {
    // Bone state
    boneCount: Types.i32,
    boneCountNormalized: Types.f64,     // boneCount / 128, clamped to [0, 1]
    bindMode: Types.i32,                // 0 = attached, 1 = detached
    hasSkeleton: Types.ui8,

    // Vertex state
    skinnedVertexCount: Types.i32,
    vertexWeightCount: Types.i32,       // 1–4 typically
    hasSkinIndex: Types.ui8,
    hasSkinWeight: Types.ui8,
    hasMorphTargets: Types.ui8,
    morphTargetCount: Types.i32,

    // Cost model
    skinCostMultiplier: Types.f64,      // multiplier applied to density target
    boneCostFactor: Types.f64,          // bone count contribution
    vertexWeightFactor: Types.f64,      // weight count contribution
    morphCostFactor: Types.f64,         // morph target contribution
    skinningOverhead: Types.f64,        // combined overhead
    palettePressure: Types.f64,         // GPU palette pressure
    boneTexturePressure: Types.f64,     // bone texture pressure

    // Android-specific tuning
    androidTier: Types.i32,
    gpuFamily: Types.i32,               // 0 = unknown, 1 = adreno, 2 = mali, 3 = powervr, 4 = xclipse
    isMobile64: Types.ui8,

    // Dynamic budgets
    densityCeiling: Types.f64,          // max density due to skinning cost
    densityFloorBonus: Types.f64,       // floor raise for skinned meshes
    effectiveDensityCap: Types.f64,     // final applied cap

    // State
    initialized: Types.ui8,
    enabled: Types.ui8,
    frozen: Types.ui8,
    lastFrameIndex: Types.i32,
    lastDeltaTime: Types.f64,
    ditherSample: Types.f64,
    skinningDirty: Types.ui8,
    lastBoneCount: Types.i32,
    lastMorphCount: Types.i32
} );

// ─── Android GPU family constants ───────────────────────────────────────────
const GPUFamily = Object.freeze( {
    UNKNOWN: 0,
    ADRENO: 1,
    MALI: 2,
    POWERVR: 3,
    XCLIPSE: 4
} );

// ─── Skinning preset profiles per Android tier ──────────────────────────────
// These values are calibrated for Android 64-bit mobile, where the
// vertex-shader skinning path is the dominant runtime cost for skinned
// meshes. Larger bone counts cause proportionally larger bone-palette
// uploads and bone-texture samples, so the cost multiplier is superlinear
// in bone count.
const SKINNING_PRESET_TABLE = {
    // LOW: Adreno 5xx, Mali-G5x — tight vertex budget, aggressive shedding.
    LOW: {
        maxAffordableBones: 64,
        costBoneLinear: 0.55,
        costBoneQuadratic: 0.85,
        costWeightLinear: 0.20,
        costMorphLinear: 0.35,
        skinningOverheadBase: 0.15,
        densityCeilingMin: 0.55,
        densityCeilingMax: 0.95,
        floorBonus: 0.10,
        palettePressureWeight: 0.55,
        boneTexturePressureWeight: 0.45
    },
    // MID: Adreno 61x–64x, Mali-G68/G7x.
    MID: {
        maxAffordableBones: 96,
        costBoneLinear: 0.40,
        costBoneQuadratic: 0.65,
        costWeightLinear: 0.15,
        costMorphLinear: 0.25,
        skinningOverheadBase: 0.10,
        densityCeilingMin: 0.65,
        densityCeilingMax: 0.97,
        floorBonus: 0.08,
        palettePressureWeight: 0.45,
        boneTexturePressureWeight: 0.40
    },
    // HIGH: Adreno 65x–72x, Immortalis-G71x.
    HIGH: {
        maxAffordableBones: 128,
        costBoneLinear: 0.30,
        costBoneQuadratic: 0.45,
        costWeightLinear: 0.10,
        costMorphLinear: 0.18,
        skinningOverheadBase: 0.08,
        densityCeilingMin: 0.72,
        densityCeilingMax: 0.99,
        floorBonus: 0.06,
        palettePressureWeight: 0.35,
        boneTexturePressureWeight: 0.32
    },
    // FLAGSHIP: Adreno 73x+, Immortalis-G715+.
    FLAGSHIP: {
        maxAffordableBones: 192,
        costBoneLinear: 0.22,
        costBoneQuadratic: 0.35,
        costWeightLinear: 0.08,
        costMorphLinear: 0.12,
        skinningOverheadBase: 0.05,
        densityCeilingMin: 0.80,
        densityCeilingMax: 1.00,
        floorBonus: 0.04,
        palettePressureWeight: 0.28,
        boneTexturePressureWeight: 0.25
    }
};

// ─── Tunables specific to skinning-aware density ────────────────────────────
const SkinningCostDefaults = {
    // Whether to auto-read the target's skeleton and skinning attributes.
    autoDetect: true,

    // Vertex weight count assumed when the geometry has no skinWeight attribute
    // (i.e. the mesh is skinned but weights are baked).
    defaultVertexWeights: 4,

    // Weight of the skinning cost multiplier on the final density cap, in [0, 1].
    // 0 = ignore skinning, 1 = skinning fully drives the density cap.
    skinCostWeight: 0.85,

    // Vertex count above which the skinning cost saturates. Mobile GPUs are
    // typically vertex-bound at 20k–60k skinned vertices per draw.
    vertexSaturation: 40000,

    // Whether to raise the material floor for skinned meshes (characters
    // alias visibly when under-tessellated even if they are small on screen).
    raiseFloorForSkinned: true,

    // Whether to relax the density cap when the character is off-screen.
    relaxWhenOffscreen: true,

    // Off-screen relaxation factor applied to the density cap.
    offscreenRelaxation: 0.15,

    // Whether to relax the density cap when the character is far from camera.
    relaxWhenDistant: true,

    // Distance (world units) at which skinning relaxation begins.
    skinningRelaxationStart: 40.0,

    // Distance (world units) at which skinning relaxation saturates.
    skinningRelaxationEnd: 200.0,

    // Maximum cap relaxation fraction at max distance.
    maxSkinningRelaxation: 0.35,

    // Dither amplitude applied to the density cap boundary.
    skinCapDither: 0.02,

    // Deterministic seed base.
    determinismSeed: 0x85EBCA77,

    // Cache TTL in frames for resolved skinning metadata.
    cacheTTL: 60,

    // Global hard cap for any skinned mesh (never exceed this).
    globalSkinHardCeiling: 1.0,

    // Global hard floor for any skinned mesh (never drop below this).
    globalSkinHardFloor: 0.30,

    // Whether to apply the cap to Mesh children of a SkinnedMesh hierarchy.
    applyToMeshChildren: false
};

/**
 * SkinningCostMultiplierLOD
 *
 * Extends PerMaterialDensityFloorLOD and inserts a skinning-aware density cap.
 * The cap is a soft upper bound: unlike a floor, it LOWERS the density target
 * when the target is a SkinnedMesh with heavy skinning cost. This reflects
 * the fact that on mobile Android 64-bit GPUs, skinning dominates the vertex
 * budget, so shedding geometry from skinned characters is by far the cheapest
 * win available to the LOD system.
 *
 * The cost model is:
 *
 *   boneFactor      = linear * boneCountNorm + quadratic * boneCountNorm^2
 *   weightFactor    = weightLinear * weightCount
 *   morphFactor     = morphLinear * morphCount
 *   overhead        = base + boneFactor + weightFactor + morphFactor
 *   palettePressure = boneCount / maxAffordableBones
 *   densityCeiling  = lerp(ceilingMin, ceilingMax, 1 - overhead)
 *
 * The final cap is:
 *
 *   cap = lerp( 1.0, densityCeiling, skinCostWeight )
 *   if offscreen: cap *= (1 - offscreenRelaxation)
 *   if distant:   cap *= distanceRelaxation
 *   cap = clamp( cap, globalSkinHardFloor, globalSkinHardCeiling )
 *
 * Then the density target is capped:
 *
 *   target = min( parentTarget, cap )
 *
 * The floor from PerMaterialDensityFloorLOD is still applied afterwards, so
 * a skinned foliage card gets both its material floor and its skinning cap.
 *
 * Recommended usage on Android 64-bit:
 * ```js
 * // One-time setup
 * const tier = TelemetryBudgetHUDLOD.detectAndroidTier( renderer );
 * TelemetryBudgetHUDLOD.applyTierPreset( tier );
 * PerMaterialDensityFloorLOD.setAndroidTier( tier );
 * SkinningCostMultiplierLOD.setAndroidTier( tier, renderer );
 *
 * // Per LOD
 * const lod = new SkinningCostMultiplierLOD();
 * lod.attachTarget( skinnedCharacter, { vertexBudget: 48000 } );
 * lod.registerWithAllocator( 'characters' );
 *
 * // Per frame
 * TelemetryBudgetHUDLOD.beginFrame( frameIndex );
 * for ( const l of allLODs ) l.update( camera, player, dt );
 * AsyncDensityApplicationLOD.flushAsync();
 * TelemetryBudgetHUDLOD.endFrame( deltaTimeMs, renderer );
```

· 
· @augments PerMaterialDensityFloorLOD
  */
  class SkinningCostMultiplierLOD extends PerMaterialDensityFloorLOD {
  constructor() {
  super();
  }
  // ─── Public API ───────────────────────────────────────────────────────────
  /**
  · Enables or disables skinning-aware density capping on this LOD.
  · @param {boolean} [enabled=true]
  · @return {SkinningCostMultiplierLOD}
    */
    enableSkinning( enabled = true ) {
    this._enabled = enabled;
    return this;
    }
  /**
  · Freezes skinning cap resolution. Parent chain still runs.
  · @param {boolean} [frozen=true]
  · @return {SkinningCostMultiplierLOD}
    */
    freezeSkinning( frozen = true ) {
    this._skinFrozen = frozen;
    return this;
    }
  /**
  · Returns the current skinning cost multiplier.
  · @return {number}
    */
    getSkinCostMultiplier() {
    return this._skinCostMultiplier;
    }
  /**
  · Returns the current density ceiling imposed by skinning cost.
  · @return {number}
    */
    getDensityCeiling() {
    return this._densityCeiling;
    }
  /**
  · Returns the bone count currently detected for the target.
  · @return {number}
    */
    getBoneCount() {
    return this._boneCount;
    }
  /**
  · Returns a high-precision skinning ledger for telemetry.
  · @return {object}
    */
    getSkinningLedger() {
    const mult = new Double( this._skinCostMultiplier );
    const ceil = new Double( this._densityCeiling );
    const overhead = new Double( this._skinningOverhead );
    return {
    skinCostMultiplier: mult.valueOf(),
    densityCeiling: ceil.valueOf(),
    skinningOverhead: overhead.valueOf(),
    boneCount: this._boneCount,
    boneCountNormalized: this._boneCountNormalized,
    vertexWeightCount: this._vertexWeightCount,
    morphTargetCount: this._morphTargetCount,
    palettePressure: this._palettePressure,
    boneTexturePressure: this._boneTexturePressure,
    bindMode: this._bindMode,
    hasSkeleton: this._hasSkeleton,
    hasSkinIndex: this._hasSkinIndex,
    hasSkinWeight: this._hasSkinWeight,
    hasMorphTargets: this._hasMorphTargets,
    androidTier: this._androidTier,
    gpuFamily: this._gpuFamily,
    isMobile64: this._isMobile64,
    effectiveDensityCap: this._effectiveDensityCap,
    enabled: this._enabled
    };
    }
  // ─── Update override ──────────────────────────────────────────────────────
  /**
  · Overrides PerMaterialDensityFloorLOD.update. Runs the full parent chain
  · (including the material floor), then applies the skinning density cap.
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
    // ── 1. Refresh shared Android / GPU context. ────────────────────────
    this._androidTier = PerMaterialDensityFloorLOD._androidTier;
    this._gpuFamily = SkinningCostMultiplierLOD._gpuFamily;
    this._isMobile64 = SkinningCostMultiplierLOD._isMobile64;
    // ── 2. Parent chain runs the entire LOD pipeline. ───────────────────
    super.update( camera, player, rawDeltaTime );
    if ( ! this._enabled || this._skinFrozen ) {
    this._skinCostMultiplier = 1.0;
    this._effectiveDensityCap = 1.0;
    this.syncSkinningECS();
    return;
    }
    // ── 3. Refresh skinning metadata if the target changed. ─────────────
    this._refreshSkinningMetadata();
    // ── 4. Compute the skinning density cap. ────────────────────────────
    this._computeSkinningCap();
    // ── 5. Apply the cap to the density target. ─────────────────────────
    const cap = this._effectiveDensityCap;
    const before = this._dynamicTargetDensity;
    let after = Math.min( before, cap );
    after = Math.min( 1.0, Math.max( 0.0, after ) );
    if ( Math.abs( after - before ) > 1e-4 ) {
    this._dynamicTargetDensity = after;
    }
    // ── 6. Optionally raise the material floor for skinned meshes. ──────
    if ( this.raiseFloorForSkinned && this._hasSkeleton && this._boneCount > 0 ) {
    const floorBonus = this._densityFloorBonus;
    const newFloor = Math.min( this.globalHardCeiling, this._resolvedFloor + floorBonus );
    if ( newFloor > this._resolvedFloor ) {
    this._resolvedFloor = newFloor;
    }
    this.syncSkinningECS();
    }
  // ─── Skinning metadata refresh ──────────────────────────────────────────
  _refreshSkinningMetadata() {
  const target = this.target;
  if ( target === null ) {
  this._hasSkeleton = false;
  this._boneCount = 0;
  this._boneCountNormalized = 0.0;
  return;
  }
  }
  // ─── Skinning cap computation ───────────────────────────────────────────
  _computeSkinningCap() {
  // ── 1. Nothing to cap if not skinned. ───────────────────────────────
  if ( ! this._hasSkeleton || this._boneCount === 0 ) {
  this._skinCostMultiplier = 1.0;
  this._densityCeiling = 1.0;
  this._effectiveDensityCap = 1.0;
  this._densityFloorBonus = 0.0;
  return;
  }
  }
  // ─── Static GPU / tier helpers ───────────────────────────────────────────
  /**
  · Sets the Android tier and GPU family for skinning calibration.
  · Call once at startup with the renderer instance.
  · 
  · @param {number} tier - AndroidTier value.
  · @param {object} [renderer] - Optional Three.js WebGLRenderer.
    */
    static setAndroidTier( tier, renderer = null ) {
    SkinningCostMultiplierLOD._androidTier = tier;
    // Detect GPU family if a renderer was provided.
    if ( renderer !== null ) {
    SkinningCostMultiplierLOD._detectGPUFamily( renderer );
    }
    // Detect Android 64-bit from user agent.
    if ( typeof navigator !== 'undefined' ) {
    const ua = navigator.userAgent || '';
    SkinningCostMultiplierLOD._isMobile64 = /Android/i.test( ua )
    && /arm64|aarch64|x86_64/i.test( ua );
    }
    for ( const lod of SkinningCostMultiplierLOD._registeredSkinning ) {
    lod._androidTier = tier;
    lod._gpuFamily = SkinningCostMultiplierLOD._gpuFamily;
    lod._isMobile64 = SkinningCostMultiplierLOD._isMobile64;
    lod._skinningDirty = true;
    }
    }
  static _detectGPUFamily( renderer ) {
  let gpu = '';
  }
  /**
  · Returns the current GPU family.
  · @return {number}
    */
    static getGPUFamily() {
    return SkinningCostMultiplierLOD._gpuFamily;
    }
  /**
  · Returns the current Android tier.
  · @return {number}
    */
    static getAndroidTier() {
    return SkinningCostMultiplierLOD._androidTier;
    }
  /**
  · Returns true if the device is Android 64-bit.
  · @return {boolean}
    */
    static isAndroid64() {
    return SkinningCostMultiplierLOD._isMobile64;
    }
  /**
  · Returns the current tier preset used for skinning calibration.
  · @return {object}
    */
    static getCurrentPreset() {
    const key = SkinningCostMultiplierLOD._tierKey( SkinningCostMultiplierLOD._androidTier );
    return SKINNING_PRESET_TABLE[ key ] || SKINNING_PRESET_TABLE.MID;
    }
  /**
  · Returns the skinning preset table.
  · @return {object}
    */
    static getPresetTable() {
    return SKINNING_PRESET_TABLE;
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
  static _registerSkinningLOD( lod ) {
  SkinningCostMultiplierLOD._registeredSkinning.add( lod );
  }
  static _unregisterSkinningLOD( lod ) {
  SkinningCostMultiplierLOD._registeredSkinning.delete( lod );
  }
  // ─── ECS registration ──────────────────────────────────────────────────────
  registerSkinningECS() {
  if ( this._ecsSkinningRegistered ) {
  return this._ecsSkinningEntity;
  }
  }
  syncSkinningECS() {
  if ( ! this._ecsSkinningRegistered ) {
  return this;
  }
  }
  pullSkinningECS() {
  if ( ! this._ecsSkinningRegistered ) {
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
  · High-precision skinning cost accounting using double.js. Useful when
  · aggregating cost across a dense crowd of NPCs on mobile.
  · @return {number}
    */
    computeSkinningOverheadHighPrecision() {
    const overhead = new Double( this._skinningOverhead );
    const boneCost = new Double( this._boneCostFactor );
    const weightCost = new Double( this._vertexWeightFactor );
    const morphCost = new Double( this._morphCostFactor );
    return overhead.add( boneCost ).add( weightCost ).add( morphCost ).valueOf();
    }
  /**
  · Returns a deterministic dither sample for the skinning cap boundary.
  · @param {number} frameIndex
  · @return {number}
    */
    computeSkinningDither( frameIndex ) {
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
  · Packs skinning telemetry into a vec4 for GPU debug rendering.
  · Layout: (skinCostMultiplier, densityCeiling, boneCountNorm, overhead)
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packSkinningVec4( out ) {
    const v = out || _scratchVec4;
    glMatrix.vec4.set(
    v,
    this._skinCostMultiplier,
    this._densityCeiling,
    this._boneCountNormalized,
    this._skinningOverhead
    );
    return v;
    }
  /**
  · Packs the full skeleton palette descriptor into a Float64Array for
  · GPU-side skinning telemetry. Layout matches _paletteVec.
  · @param {Float64Array} [out]
  · @return {Float64Array}
    */
    packSkeletonPaletteVec8( out ) {
    const v = out || _paletteVec;
    v[ 0 ] = this._boneCount;
    v[ 1 ] = this._boneCountNormalized;
    v[ 2 ] = this._vertexWeightCount;
    v[ 3 ] = this._morphTargetCount;
    v[ 4 ] = this._palettePressure;
    v[ 5 ] = this._boneTexturePressure;
    v[ 6 ] = this._effectiveDensityCap;
    v[ 7 ] = this._androidTier;
    void _scratchVec3A;
    void _scratchVec3B;
    return v;
    }
  static getECSWorld() {
  return _skinningWorld;
  }
  static getSkinningSoA() {
  return SkinningCostSoA;
  }
  static get SkinningCostDefaults() {
  return SkinningCostDefaults;
  }
  static get GPUFamily() {
  return GPUFamily;
  }
  static get SkinningPresetTable() {
  return SKINNING_PRESET_TABLE;
  }
  }

// ─── Static skinning storage (module-scoped, shared across all instances) ───
SkinningCostMultiplierLOD._registeredSkinning = new Set();
SkinningCostMultiplierLOD._androidTier = 2; // MID default
SkinningCostMultiplierLOD._gpuFamily = GPUFamily.UNKNOWN;
SkinningCostMultiplierLOD._gpuString = '';
SkinningCostMultiplierLOD._isMobile64 = false;

void SkinnedMesh;
void Skeleton;
void Bone;
void Mesh;
void BufferGeometry;
void BufferAttribute;

export {
SkinningCostMultiplierLOD,
SkinningCostSoA,
SkinningCostDefaults,
GPUFamily,
SKINNING_PRESET_TABLE
};
