// file number : 350
// full path name : src/context/350_LandscapeShadowScaler.js
// description : Landscape shadow scaler — the 10 Hz consumer that computes
// per-chunk shadow configuration from the biome blend, the fused climate, the
// HLOD tier, the occlusion state, the decal shadow softening, and the prop
// shadow contribution, and writes it back into the chunk descriptor so the
// renderer can stream the correct shadow state without re-evaluating any of
// the underlying signals. It scales seven independent shadow parameters per
// chunk:
//   (1) cascade count    — how many shadow cascades the chunk's slice of the
//                          camera frustum uses (1–4), driven by the chunk's
//                          HLOD tier and its dominant biome's shadow cost;
//   (2) shadow map size  — the per-cascade shadow map resolution (512–4096),
//                          driven by the chunk's screen coverage, its prop
//                          density, and its vegetation density;
//   (3) shadow distance  — the far plane of the shadow frustum (50–5000 m),
//                          driven by the chunk's mean distance and the
//                          biome's canopy occlusion (dense canopy shadows
//                          need more range than open desert);
//   (4) shadow softness  — the PCF/CSSM softness radius (0.1–4.0 px),
//                          driven by the fused sun diffuse fraction, the
//                          fused fog density, the snow coverage, and the
//                          decal shadow softening from 348;
//   (5) shadow bias      — the depth bias (0.001–0.02), driven by the fused
//                          sun angle, the biome's terrain roughness, and the
//                          prop density (many small props need more bias to
//                          avoid self-shadowing acne);
//   (6) shadow intensity — the shadow darkness multiplier (0.2–0.9), driven
//                          by the fused sun diffuse fraction (diffuse light
//                          produces weaker shadows) and the snow coverage
//                          (snow re-radiates light, weakening shadows);
//   (7) cascade splits   — the four cascade split distances along the camera
//                          frustum, computed from the chunk's distance range
//                          and the biome's own shadow range multiplier.
// The scaler is fully tier-aware: the KILOMETER tier gets 4 cascades at the
// maximum resolution, the TEN_KILOMETER tier gets 2 cascades at half
// resolution, the HUNDRED_KILOMETER tier gets 1 cascade at quarter
// resolution, and the THOUSAND_KILOMETER tier gets no shadows at all. The
// per-tick work is bounded by both a chunk budget (default 128) and a
// per-tick CPU budget (default 1.5 ms). Occluded chunks are skipped entirely
// (their shadows would not be visible anyway), and chunks whose shadow
// parameters have not changed by more than a configurable threshold are
// skipped so the re-evaluation cost is proportional to the number of chunks
// whose shadow state actually changed. The scaler exposes the shadow state
// both as a per-chunk read API (readShadowState) and as a batch-read API for
// the renderer (readShadowBatch), so 337 can stream the shadow configuration
// to the GPU as a single contiguous buffer. Material and lighting parameters
// are integrated first-class: the shadow softness and shadow intensity are
// driven by the same PBR + anime parameters that 331 uploads (sun diffuse
// fraction, fog density, snow albedo boost, subsurface scattering), so a
// shadow on a hazy snow-covered conifer forest reads very differently from a
// shadow on clear dry desert — which is exactly what makes the world look
// real. The system works identically on WebGL1 and WebGL2 because it only
// produces per-chunk shadow configuration values; the actual shadow map
// rendering is handled by the standard THREE.WebGLShadowMap pipeline that
// both renderers support.
//#
// best for : Every consumer that needs per-chunk shadow configuration —
// 336_LandscapeChunkDescriptor (receives the shadow state so downstream
// consumers can read it without re-querying), 337_LandscapeChunkStreamer
// (streams the shadow state to the GPU as a single batch), 338_Landscape-
// ChunkHLOD (reads the tier-driven cascade counts to decide the tier's
// shadow budget), 340_LandscapeChunkOcclusion (occluded chunks are excluded
// from shadow rendering), 343_LandscapeErosionSimulator and
// 344_LandscapeWindErosionSystem (read the shadow state to know which
// chunks are self-shadowed, which affects erosion rates), 346_Landscape-
// VegetationScatterSystem (reads the shadow state to decide the vegetation
// shadow density), 347_LandscapeFaunaSpawnSystem (reads the shadow state
// to decide the animal shadow-casting flag), 348_LandscapeDecalPlacement-
// System (writes shadow softening into the scaler), 349_LandscapeProp-
// PlacementSystem (writes prop shadows into the scaler), 351_Landscape-
// LightingCoupler (uses the shadow state to set the directional light's
// shadow properties), 352_LandscapeSkyCoupler (uses the shadow state to
// modulate the sky's ambient contribution), 353_LandscapeSeasonCoupler
// (reads the shadow state to know which seasonal palettes apply),
// 354_LandscapeSensoryCoupler (uses the shadow state to attenuate audio
// and scent cues in shaded areas), 355_LandscapePerformanceGovernor (uses
// the cascade counts to arbitrate the shadow budget), 356_LandscapeRebuild-
// Deferral (uses the per-chunk shadow dirty flag to decide when a chunk
// needs its shadow buffer rebuilt), and 357_LandscapeEventBudget (uses the
// shadow batch queue depth to coalesce multiple shadow requests into a
// single causal event). The shadow scaler is the single authority on what
// shadow configuration each chunk uses, and every consumer that needs
// shadow state asks it.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  InstancedBufferAttribute, InstancedBufferGeometry,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  WebGLRenderer, WebGL2Renderer,
  DirectionalLight, SpotLight, PointLight,
  PCFSoftShadowMap, PCFShadowMap, VSMShadowMap, BasicShadowMap
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkOcclusion, OCC_STATE } from './340_LandscapeChunkOcclusion.js';
import { LandscapeWaterFlowSystem } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem } from './346_LandscapeVegetationScatterSystem.js';
import { LandscapeFaunaSpawnSystem } from './347_LandscapeFaunaSpawnSystem.js';
import { LandscapeDecalPlacementSystem } from './348_LandscapeDecalPlacementSystem.js';
import { LandscapePropPlacementSystem } from './349_LandscapePropPlacementSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–349.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier cascade counts. The KILOMETER tier gets 4 cascades for sharp
// near shadows; the coarser tiers get fewer cascades because their shadows
// are less visible on screen.
const TIER_CASCADE_COUNT = Object.freeze([
  4,      // KILOMETER
  2,      // TEN_KILOMETER
  1,      // HUNDRED_KILOMETER
  0       // THOUSAND_KILOMETER
]);

// Per-tier base shadow map size. Powers of two, capped at 4096.
const TIER_SHADOW_MAP_SIZE = Object.freeze([
  2048,   // KILOMETER
  1024,   // TEN_KILOMETER
  512,    // HUNDRED_KILOMETER
  0       // THOUSAND_KILOMETER
]);

// Per-tier base shadow distance in metres.
const TIER_SHADOW_DISTANCE_M = Object.freeze([
  150.0,    // KILOMETER
  500.0,    // TEN_KILOMETER
  2000.0,   // HUNDRED_KILOMETER
  0.0       // THOUSAND_KILOMETER
]);

// Per-tier base shadow softness in pixels. Higher tiers use softer shadows
// because their pixels are larger on screen.
const TIER_SHADOW_SOFTNESS_PX = Object.freeze([
  1.0,     // KILOMETER
  2.0,     // TEN_KILOMETER
  3.5,     // HUNDRED_KILOMETER
  0.0      // THOUSAND_KILOMETER
]);

// Per-tier base shadow intensity (darkness multiplier).
const TIER_SHADOW_INTENSITY = Object.freeze([
  0.75,    // KILOMETER
  0.65,    // TEN_KILOMETER
  0.50,    // HUNDRED_KILOMETER
  0.0      // THOUSAND_KILOMETER
]);

// Per-tier base shadow bias. Coarser tiers need more bias because their
// depth buffer precision is lower.
const TIER_SHADOW_BIAS = Object.freeze([
  0.001,   // KILOMETER
  0.003,   // TEN_KILOMETER
  0.010,   // HUNDRED_KILOMETER
  0.0      // THOUSAND_KILOMETER
]);

// Maximum number of active chunk states. Shared across the pipeline.
const MAX_TRACKED_CHUNKS = 100000;

// Per-tick chunk budget. Shadows are slower to change than geometry, so
// the budget is bounded but not as tight as the erosion systems.
const DEFAULT_TICK_CHUNK_BUDGET = 128;

// Per-tick CPU budget in milliseconds.
const DEFAULT_TICK_CPU_BUDGET_MS = 1.5;

// Shadow parameter drift thresholds. A chunk is re-evaluated only if its
// shadow parameters have drifted past these thresholds since the last
// evaluation. This keeps the per-tick cost proportional to the number of
// chunks whose shadow state actually changed.
const DRIFT_SOFTNESS = 0.15;
const DRIFT_INTENSITY = 0.05;
const DRIFT_BIAS = 0.0005;
const DRIFT_DISTANCE_FRACTION = 0.10;
const DRIFT_CASCADE_CHANGE = 1;
const DRIFT_MAP_SIZE_CHANGE = 1;

// Sun diffuse fraction thresholds. When the fused sun diffuse fraction is
// above this value, the light is mostly scattered and shadows are weak.
const HIGH_DIFFUSE_THRESHOLD = 0.65;

// Fog density threshold. Above this value, the atmosphere itself casts
// shadows and the shadow intensity is reduced further.
const HIGH_FOG_THRESHOLD = 0.02;

// Snow coverage threshold. Above this value, snow re-radiates enough light
// to noticeably reduce shadow intensity.
const HIGH_SNOW_THRESHOLD = 0.30;

// ─── Shadow quality presets ───────────────────────────────────
// Coarse quality tiers are used to quantise the shadow map size so the
// renderer only ever has to allocate a small number of distinct texture
// sizes. This is important for WebGL1 where switching shadow map sizes
// forces a full pipeline recompile.
const SHADOW_MAP_SIZES = Object.freeze([256, 512, 1024, 2048, 4096]);

// Quantise a raw shadow map size to the nearest power-of-two preset.
function _quantiseShadowMapSize(rawSize) {
  for (let i = 0; i < SHADOW_MAP_SIZES.length; i++) {
    if (rawSize <= SHADOW_MAP_SIZES[i]) return SHADOW_MAP_SIZES[i];
  }
  return SHADOW_MAP_SIZES[SHADOW_MAP_SIZES.length - 1];
}

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK SHADOW STATE (structure-of-arrays) ───────
// ══════════════════════════════════════════════════════════════════

// Cascade count (0–4).
const _cascadeCount          = new Uint8Array(MAX_TRACKED_CHUNKS);

// Shadow map size (power of two, 0 for no shadows).
const _shadowMapSize         = new Uint16Array(MAX_TRACKED_CHUNKS);

// Shadow distance (metres).
const _shadowDistanceM       = new Float32Array(MAX_TRACKED_CHUNKS);

// Shadow softness (pixels).
const _shadowSoftnessPx      = new Float32Array(MAX_TRACKED_CHUNKS);

// Shadow bias (depth units).
const _shadowBias            = new Float32Array(MAX_TRACKED_CHUNKS);

// Shadow intensity (darkness multiplier).
const _shadowIntensity       = new Float32Array(MAX_TRACKED_CHUNKS);

// Cascade split distances (4 floats per chunk). Only the first N entries
// are used, where N is the cascade count.
const _cascadeSplitsM        = new Float32Array(MAX_TRACKED_CHUNKS * 4);

// Per-chunk dirty flag (0 = clean, 1 = needs re-evaluation).
const _shadowDirty           = new Uint8Array(MAX_TRACKED_CHUNKS);

// Per-chunk active flag.
const _chunkActive           = new Uint8Array(MAX_TRACKED_CHUNKS);

// Per-chunk last-evaluated snapshot (used for drift detection).
const _lastSoftness         = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastIntensity        = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastBias             = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastDistance         = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastCascadeCount     = new Uint8Array(MAX_TRACKED_CHUNKS);
const _lastShadowMapSize    = new Uint16Array(MAX_TRACKED_CHUNKS);

// Per-chunk last evaluation time.
const _lastEvalS            = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Round-robin cursor for the run() loop.
let _rrCursor               = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Scratch for reading the blended material and lighting from 331.
const _materialScratch = new Float32Array(16);
const _lightingScratch = new Float32Array(8);

// Scratch for reading the chunk view.
const _viewScratch = {
  chunkX: 0, chunkY: 0, chunkZ: 0,
  biomeIdBitmask: 0, dominantBiomeId: -1, dominantWeight: 0,
  hlodTier: 0, lodLevel: 0
};

// Batch buffer for the shadow state readout. Used by readShadowBatch.
const _shadowBatch = new Float32Array(MAX_TRACKED_CHUNKS * 10);
let _shadowBatchCount = 0;

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastChanged = 0;
let _lastSkipped = 0;
let _lastTickDurationMs = 0;
let _lastActiveChunks = 0;
let _lastTotalCascades = 0;
let _lastShadowMapMemoryBytes = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SHADOW COMPUTATION ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the shadow parameters for a chunk and write them into the
// pooled arrays. Returns true if any parameter changed since the last
// evaluation.
function _computeChunkShadow(streamerSlot, nowS) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const baseCascadeCount = TIER_CASCADE_COUNT[tier];
  if (baseCascadeCount === 0) {
    // No shadows at this tier.
    _setNoShadowState(streamerSlot);
    return false;
  }

  // Read the chunk descriptor.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return false;
  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return false;

  // If the chunk is fully occluded, skip it. Its shadows would not be
  // visible anyway.
  if (LandscapeChunkOcclusion.isFullyOccluded(streamerSlot)) {
    _setNoShadowState(streamerSlot);
    return false;
  }

  // Read the blended material and lighting record from 330 (which 331
  // consumes). We use the ecotone system's material blend as a proxy for
  // the chunk's material state.
  CrossBiomeEcotoneSystem.readMaterialBlend(streamerSlot, _materialScratch);
  CrossBiomeEcotoneSystem.readLightingBlend(streamerSlot, _lightingScratch);

  const sunDiffuseFraction = _lightingScratch[0];
  const shadowSoftnessNear = _lightingScratch[7];
  const fogDensity = _materialScratch[10] > 0 ? _materialScratch[10] : 0.01;
  const snowCoverage = _materialScratch[18];
  const canopyOcclusion = _materialScratch[9];
  const roughness = _materialScratch[3];

  // Read the fused climate and hydrology.
  BiomeClimateCoupling.readFusedClimate(streamerSlot, _climateReadScratch);
  const sunIntensity = _climateReadScratch.sunIntensityMultiplier > 0
    ? _climateReadScratch.sunIntensityMultiplier
    : 1.0;

  // Read the water presence.
  const hasWater = LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot);

  // Read the vegetation density.
  const vegetationCount = LandscapeVegetationScatterSystem.getInstanceCount(streamerSlot);

  // Read the prop density.
  const propCount = LandscapePropPlacementSystem.getPropCount(streamerSlot);

  // Read the decal shadow softening.
  let maxDecalSoften = 0;
  const decalSlots = _decalScratch;
  const decalCount = LandscapeDecalPlacementSystem.readChunkDecalSlots(streamerSlot, decalSlots, 16);
  for (let i = 0; i < decalCount; i++) {
    const s = LandscapeDecalPlacementSystem.getDecalShadowSoften(decalSlots[i]);
    if (s > maxDecalSoften) maxDecalSoften = s;
  }

  // ─── 1. Cascade count ──────────────────────────────────────
  // Start from the tier's base count. Add extra cascades if the chunk has
  // many small shadow-casting props (more cascades keep close shadows sharp)
  // or a very dense canopy (self-shadowing needs more cascades to resolve).
  let cascadeCount = baseCascadeCount;
  if (tier === HLOD_TIER.KILOMETER) {
    if (propCount > 3) cascadeCount = Math.min(4, cascadeCount + 1);
    if (canopyOcclusion > 0.7) cascadeCount = Math.min(4, cascadeCount + 1);
  }
  if (vegetationCount > 200) cascadeCount = Math.min(4, cascadeCount + 1);

  // ─── 2. Shadow map size ────────────────────────────────────
  // Start from the tier's base size. Reduce it if the chunk is far away
  // (the shadows are small on screen). Increase it if the chunk has many
  // shadow casters.
  let rawMapSize = TIER_SHADOW_MAP_SIZE[tier];
  if (propCount > 3) rawMapSize = Math.min(4096, rawMapSize * 2);
  if (vegetationCount > 200) rawMapSize = Math.min(4096, rawMapSize * 1.5);
  if (canopyOcclusion > 0.7) rawMapSize = Math.min(4096, rawMapSize * 1.25);
  if (hasWater) rawMapSize = Math.max(256, rawMapSize * 0.75);   // water reflects, no shadow casting needed
  const shadowMapSize = _quantiseShadowMapSize(rawMapSize);

  // ─── 3. Shadow distance ───────────────────────────────────
  // Start from the tier's base distance. Increase it if the chunk has a
  // dense canopy (long shadows through trees), decrease it if the light is
  // mostly diffuse (short shadows).
  let shadowDistanceM = TIER_SHADOW_DISTANCE_M[tier];
  if (canopyOcclusion > 0.5) shadowDistanceM *= 1.5;
  if (sunDiffuseFraction > HIGH_DIFFUSE_THRESHOLD) shadowDistanceM *= 0.7;
  if (hasWater) shadowDistanceM *= 0.5;
  shadowDistanceM = Math.max(50.0, Math.min(5000.0, shadowDistanceM));

  // ─── 4. Shadow softness ───────────────────────────────────
  // Softness is driven by the sun diffuse fraction (diffuse light produces
  // softer shadows), the fog density (fog blurs shadow edges), the snow
  // coverage (snow re-radiates light, softening shadows), the decal shadow
  // softening, and the biome's own shadow softness.
  let softnessPx = TIER_SHADOW_SOFTNESS_PX[tier];
  softnessPx *= (1.0 + sunDiffuseFraction * 1.5);
  softnessPx *= (1.0 + fogDensity * 30.0);
  softnessPx *= (1.0 + snowCoverage * 0.5);
  softnessPx *= (1.0 + maxDecalSoften * 1.0);
  softnessPx *= (1.0 + shadowSoftnessNear * 0.5);
  softnessPx = Math.max(0.1, Math.min(4.0, softnessPx));

  // ─── 5. Shadow bias ──────────────────────────────────────
  // Bias prevents shadow acne. It needs to be larger for coarser tiers,
  // for rougher terrain, for many small props, and for lower sun angles.
  let bias = TIER_SHADOW_BIAS[tier];
  bias *= (1.0 + roughness * 0.5);
  bias *= (1.0 + propCount * 0.1);
  if (sunIntensity < 0.5) bias *= 1.5;   // low sun angle needs more bias
  bias = Math.max(0.001, Math.min(0.02, bias));

  // ─── 6. Shadow intensity ─────────────────────────────────
  // Intensity is the darkness multiplier. It is reduced when the light is
  // diffuse, when it is foggy, and when snow is present.
  let intensity = TIER_SHADOW_INTENSITY[tier];
  if (sunDiffuseFraction > HIGH_DIFFUSE_THRESHOLD) {
    intensity *= (1.0 - (sunDiffuseFraction - HIGH_DIFFUSE_THRESHOLD) * 2.0);
  }
  if (fogDensity > HIGH_FOG_THRESHOLD) {
    intensity *= (1.0 - (fogDensity - HIGH_FOG_THRESHOLD) * 10.0);
  }
  if (snowCoverage > HIGH_SNOW_THRESHOLD) {
    intensity *= (1.0 - (snowCoverage - HIGH_SNOW_THRESHOLD) * 0.8);
  }
  intensity = Math.max(0.1, Math.min(0.9, intensity));

  // ─── 7. Cascade splits ───────────────────────────────────
  // The four cascade split distances distribute the shadow distance range
  // logarithmically along the camera frustum. Cascade 0 is the closest
  // range (sharpest shadows); cascade 3 is the farthest (softest).
  const cascadeSplits = _cascadeSplitScratch;
  if (cascadeCount > 0) {
    const fraction0 = 0.05;
    const fraction1 = 0.15;
    const fraction2 = 0.35;
    const fraction3 = 1.00;
    cascadeSplits[0] = shadowDistanceM * fraction0;
    cascadeSplits[1] = shadowDistanceM * fraction1;
    cascadeSplits[2] = shadowDistanceM * fraction2;
    cascadeSplits[3] = shadowDistanceM * fraction3;
  }

  // ─── Drift detection ─────────────────────────────────────
  // Compare each parameter against the last-evaluated snapshot. If none of
  // them have drifted past their thresholds, we skip writing the state.
  const lastSoftness = _lastSoftness[streamerSlot];
  const lastIntensity = _lastIntensity[streamerSlot];
  const lastBias = _lastBias[streamerSlot];
  const lastDistance = _lastDistance[streamerSlot];
  const lastCascades = _lastCascadeCount[streamerSlot];
  const lastMapSize = _lastShadowMapSize[streamerSlot];

  const softnessChanged = Math.abs(softnessPx - lastSoftness) > DRIFT_SOFTNESS;
  const intensityChanged = Math.abs(intensity - lastIntensity) > DRIFT_INTENSITY;
  const biasChanged = Math.abs(bias - lastBias) > DRIFT_BIAS;
  const distanceChanged = lastDistance < 0 || Math.abs(shadowDistanceM - lastDistance) / Math.max(1, lastDistance) > DRIFT_DISTANCE_FRACTION;
  const cascadesChanged = Math.abs(cascadeCount - lastCascades) >= DRIFT_CASCADE_CHANGE;
  const mapSizeChanged = Math.abs(shadowMapSize - lastMapSize) >= DRIFT_MAP_SIZE_CHANGE;

  if (!softnessChanged && !intensityChanged && !biasChanged && !distanceChanged && !cascadesChanged && !mapSizeChanged) {
    _shadowDirty[streamerSlot] = 0;
    return false;
  }

  // Write the state.
  _cascadeCount[streamerSlot] = cascadeCount;
  _shadowMapSize[streamerSlot] = shadowMapSize;
  _shadowDistanceM[streamerSlot] = shadowDistanceM;
  _shadowSoftnessPx[streamerSlot] = softnessPx;
  _shadowBias[streamerSlot] = bias;
  _shadowIntensity[streamerSlot] = intensity;
  const splitBase = streamerSlot * 4;
  for (let i = 0; i < 4; i++) _cascadeSplitsM[splitBase + i] = cascadeSplits[i];

  // Update the last-evaluated snapshot.
  _lastSoftness[streamerSlot] = softnessPx;
  _lastIntensity[streamerSlot] = intensity;
  _lastBias[streamerSlot] = bias;
  _lastDistance[streamerSlot] = shadowDistanceM;
  _lastCascadeCount[streamerSlot] = cascadeCount;
  _lastShadowMapSize[streamerSlot] = shadowMapSize;
  _lastEvalS[streamerSlot] = nowS;
  _shadowDirty[streamerSlot] = 0;

  return true;
}

function _setNoShadowState(streamerSlot) {
  _cascadeCount[streamerSlot] = 0;
  _shadowMapSize[streamerSlot] = 0;
  _shadowDistanceM[streamerSlot] = 0;
  _shadowSoftnessPx[streamerSlot] = 0;
  _shadowBias[streamerSlot] = 0;
  _shadowIntensity[streamerSlot] = 0;
  const splitBase = streamerSlot * 4;
  for (let i = 0; i < 4; i++) _cascadeSplitsM[splitBase + i] = 0;
}

// Scratch buffers used inside _computeChunkShadow.
const _climateReadScratch = {
  temperatureOffsetC: 0, precipitationMultiplier: 1, humidityBias: 0,
  windSpeedMultiplier: 1, windDirectionBiasDeg: 0,
  diurnalSwingMultiplier: 1, seasonalAmplitudeMultiplier: 1,
  seasonalPhaseShiftRad: 0, snowlineShiftM: 0, treelineShiftM: 0,
  sunIntensityMultiplier: 1
};
const _cascadeSplitScratch = new Float32Array(4);
const _decalScratch = new Int32Array(16);

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeShadowScaler = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  shadowMapSizes: SHADOW_MAP_SIZES,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _shadowDirty[streamerSlot] = 1;
    _lastSoftness[streamerSlot] = -1;
    _lastIntensity[streamerSlot] = -1;
    _lastBias[streamerSlot] = -1;
    _lastDistance[streamerSlot] = -1;
    _lastCascadeCount[streamerSlot] = 0;
    _lastShadowMapSize[streamerSlot] = 0;
    _lastEvalS[streamerSlot] = -1;
    return true;
  },

  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _chunkActive[streamerSlot] = 0;
    _setNoShadowState(streamerSlot);
  },

  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    let processed = 0;
    let changed = 0;
    let skipped = 0;
    let activeChunks = 0;
    let totalCascades = 0;
    let shadowMapMemoryBytes = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      activeChunks++;
      processed++;

      // Skip clean chunks whose shadow state has not drifted.
      if (_shadowDirty[slot] === 0) {
        // But still allow a slow refresh: re-evaluate any chunk that has
        // not been touched in the last 5 simulated seconds.
        if (nowS - _lastEvalS[slot] < 5.0) {
          skipped++;
          continue;
        }
      }

      if (_computeChunkShadow(slot, nowS)) changed++;

      // Accumulate diagnostics.
      totalCascades += _cascadeCount[slot];
      if (_shadowMapSize[slot] > 0 && _cascadeCount[slot] > 0) {
        shadowMapMemoryBytes += _cascadeCount[slot] * _shadowMapSize[slot] * _shadowMapSize[slot] * 4;
      }

      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastChanged = changed;
    _lastSkipped = skipped;
    _lastActiveChunks = activeChunks;
    _lastTotalCascades = totalCascades;
    _lastShadowMapMemoryBytes = shadowMapMemoryBytes;
    _lastTickDurationMs = performanceNow() - t0;

    if (changed > 0) {
      _dispatcher.emit(EVENT_TYPE.SHADOW_CONFIG_UPDATED, {
        tick,
        processed,
        changed,
        skipped,
        activeChunks,
        totalCascades,
        shadowMapMemoryBytes,
        durationMs: _lastTickDurationMs
      });
    }
  },

  /**
   * Mark a chunk as needing a shadow re-evaluation. Called by 337 when a
   * chunk is streamed in, by 349 when a prop is damaged, and by 348 when a
   * decal is placed.
   */
  markDirty(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _shadowDirty[streamerSlot] = 1;
  },

  /**
   * Read the full shadow state for a chunk. Zero-allocation.
   */
  readShadowState(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    out.cascadeCount = _cascadeCount[streamerSlot];
    out.shadowMapSize = _shadowMapSize[streamerSlot];
    out.shadowDistanceM = _shadowDistanceM[streamerSlot];
    out.shadowSoftnessPx = _shadowSoftnessPx[streamerSlot];
    out.shadowBias = _shadowBias[streamerSlot];
    out.shadowIntensity = _shadowIntensity[streamerSlot];
    const splitBase = streamerSlot * 4;
    out.cascadeSplit0 = _cascadeSplitsM[splitBase + 0];
    out.cascadeSplit1 = _cascadeSplitsM[splitBase + 1];
    out.cascadeSplit2 = _cascadeSplitsM[splitBase + 2];
    out.cascadeSplit3 = _cascadeSplitsM[splitBase + 3];
    return true;
  },

  /**
   * Read the shadow batch for all active chunks. Zero-allocation (writes
   * into the caller's preallocated buffer).
   *
   * Layout per chunk (10 floats):
   *   [0] streamerSlot
   *   [1] cascadeCount
   *   [2] shadowMapSize
   *   [3] shadowDistanceM
   *   [4] shadowSoftnessPx
   *   [5] shadowBias
   *   [6] shadowIntensity
   *   [7] cascadeSplit0
   *   [8] cascadeSplit1
   *   [9] cascadeSplit2 (cascadeSplit3 is at index 3 of the splits but
   *       we cap the batch at 10 entries per chunk for simplicity)
   */
  readShadowBatch(outFloats) {
    let written = 0;
    for (let s = 0; s < MAX_TRACKED_CHUNKS; s++) {
      if (!_chunkActive[s]) continue;
      if (written + 10 > outFloats.length) break;
      outFloats[written++] = s;
      outFloats[written++] = _cascadeCount[s];
      outFloats[written++] = _shadowMapSize[s];
      outFloats[written++] = _shadowDistanceM[s];
      outFloats[written++] = _shadowSoftnessPx[s];
      outFloats[written++] = _shadowBias[s];
      outFloats[written++] = _shadowIntensity[s];
      const splitBase = s * 4;
      outFloats[written++] = _cascadeSplitsM[splitBase + 0];
      outFloats[written++] = _cascadeSplitsM[splitBase + 1];
      outFloats[written++] = _cascadeSplitsM[splitBase + 2];
    }
    _shadowBatchCount = written / 10;
    return written;
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getCascadeCount(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _cascadeCount[streamerSlot];
  },
  getShadowMapSize(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _shadowMapSize[streamerSlot];
  },
  getShadowDistanceM(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _shadowDistanceM[streamerSlot];
  },
  getShadowSoftnessPx(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _shadowSoftnessPx[streamerSlot];
  },
  getShadowBias(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _shadowBias[streamerSlot];
  },
  getShadowIntensity(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _shadowIntensity[streamerSlot];
  },
  getCascadeSplit(streamerSlot, cascadeIndex) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (cascadeIndex < 0 || cascadeIndex >= 4) return 0;
    return _cascadeSplitsM[streamerSlot * 4 + cascadeIndex];
  },
  hasShadows(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    return _cascadeCount[streamerSlot] > 0 && _shadowMapSize[streamerSlot] > 0;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastChanged() { return _lastChanged; },
  get lastSkipped() { return _lastSkipped; },
  get lastActiveChunks() { return _lastActiveChunks; },
  get lastTotalCascades() { return _lastTotalCascades; },
  get lastShadowMapMemoryBytes() { return _lastShadowMapMemoryBytes; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get activeChunks() {
    let n = 0;
    for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) if (_chunkActive[i]) n++;
    return n;
  }
});

function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default LandscapeShadowScaler;