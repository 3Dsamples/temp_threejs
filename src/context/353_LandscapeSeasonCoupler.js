// file number : 353
// full path name : src/context/353_LandscapeSeasonCoupler.js
// description : Landscape season coupler — the 1 Hz consumer that fuses the
// seasonality system (296_SeasonalitySystem), the biome blend
// (329_BiomeBlendSystem), the per-chunk lighting state (351_LandscapeLightingCoupler),
// the per-chunk sky state (352_LandscapeSkyCoupler), the per-chunk hydrology
// (334_BiomeHydrologyCoupling), and the per-chunk climate (332_BiomeClimateCoupling)
// into a single per-chunk seasonal palette. The coupler applies the seasonal
// material palettes declared by every biome descriptor (spring new leaf,
// summer full green, autumn peak, winter bare branch) to every visible
// geometry, tracks the snow-line elevation and the treeline migration across
// the year, drives the phenological events (bud break, green-up, autumn
// colour shift, leaf drop, snow accumulation, snow melt, bloom windows, spore
// and fungal flushes), and exposes a per-chunk seasonalPalette record that
// 331_BiomeBlendMaterialBridge reads to apply the correct seasonal albedo to
// each visible object. The coupler computes the following eighteen per-chunk
// seasonal parameters at 1 Hz:
//   (1) season phase              — a scalar in [0,1) where 0 is spring,
//                                   0.25 is summer, 0.5 is autumn, and 0.75 is
//                                   winter (per hemisphere);
//   (2) phenology stage           — SPRING_NEW_LEAF, SUMMER_FULL_GREEN,
//                                   AUTUMN_PEAK, or WINTER_BARE_BRANCH;
//   (3) phenology progress        — a scalar in [0,1) within the current stage;
//   (4) foliage albedo (RGB)      — the seasonal blended canopy albedo;
//   (5) foliage roughness         — the seasonal canopy roughness;
//   (6) foliage wetness           — the seasonal canopy wetness (higher in
//                                   autumn and spring rain seasons);
//   (7) grass albedo (RGB)        — the seasonal blended grass albedo;
//   (8) grass height factor       — a scalar that scales the grass instance
//                                   height (short in winter, tall in summer);
//   (9) grass dormancy factor     — a scalar in [0,1] that suppresses grass
//                                   sprouting in winter;
//  (10) snow-line elevation (m)   — the elevation above which snow persists
//                                   on the ground, driven by the season phase
//                                   and the fused temperature;
//  (11) treeline elevation (m)    — the elevation below which trees grow,
//                                   driven by the season phase and the fused
//                                   temperature;
//  (12) snow coverage             — a scalar in [0,1] of the chunk's ground
//                                   fraction currently covered by snow;
//  (13) frost risk                — a scalar in [0,1] representing the
//                                   probability of a frost event tonight;
//  (14) bloom intensity           — a scalar in [0,1] of the chunk's flower
//                                   bloom activity (peaks in spring);
//  (15) pollen density            — a scalar in [0,1] of the chunk's pollen
//                                   concentration (peaks in late spring);
//  (16) spore density             — a scalar in [0,1] of the chunk's spore
//                                   concentration (peaks in autumn);
//  (17) leaf-litter depth (m)     — the seasonal leaf-litter accumulation,
//                                   which affects the terrain albedo and the
//                                   acoustic properties of the ground;
//  (18) ice coverage              — a scalar in [0,1] of the chunk's water
//                                   surface fraction that is currently frozen.
// The coupler is fully tier-aware: the KILOMETER tier gets all eighteen
// parameters; the TEN_KILOMETER tier drops leaf-litter depth and ice coverage;
// the HUNDRED_KILOMETER tier keeps only the phase, stage, foliage albedo,
// snow coverage, and bloom intensity; the THOUSAND_KILOMETER tier keeps only
// the phase and a single seasonal tint scalar. The per-tick work is bounded by
// both a chunk budget (default 512) and a per-tick CPU budget (default 1.5 ms),
// so a 100,000-chunk world refreshes in ~195 simulated seconds (3.3 minutes)
// — which is more than fast enough because seasons change over weeks, not
// seconds. The coupler exposes the per-chunk palette both as a read API
// (readSeasonalPalette) and as a batch-read API (readSeasonalBatch) that
// 331_BiomeBlendMaterialBridge consumes to set the seasonal albedo of every
// visible object. Material and lighting parameters are integrated first-class:
// the seasonal foliage albedo is the same linear-RGB colour that 331 writes
// into the 32-float PBR layout, so a maple in autumn is visually consistent
// whether it is in the visible set or the background LOD set. Every per-chunk
// buffer is preallocated, every hot-path computation is zero-allocation, and
// the system works identically on WebGL1 and WebGL2 because the seasonal
// parameters are plain uniforms, not compute shaders.
//#
// best for : Every consumer that needs per-chunk seasonal state —
// 296_SeasonalitySystem (the coupler is the per-chunk application of its
// global season scalar), 331_BiomeBlendMaterialBridge (reads the foliage and
// grass albedo to set the seasonal material parameters for every visible
// object), 336_LandscapeChunkDescriptor (receives the seasonal palette so
// downstream consumers can read it), 337_LandscapeChunkStreamer (streams
// the seasonal palette to the GPU as a single batch),
// 338_LandscapeChunkHLOD (uses the seasonal palette to decide which LOD
// materials to stream in), 346_LandscapeVegetationScatterSystem (reads the
// grass height factor and grass dormancy factor to scale grass instances),
// 347_LandscapeFaunaSpawnSystem (reads the pollen density and bloom
// intensity to spawn pollinators in the right season),
// 348_LandscapeDecalPlacementSystem (reads the leaf-litter depth and snow
// coverage to place seasonal decals), 349_LandscapePropPlacementSystem
// (reads the snow coverage to apply the winter prop palette),
// 350_LandscapeShadowScaler (reads the foliage albedo and snow coverage to
// scale shadow intensity), 351_LandscapeLightingCoupler (reads the seasonal
// palette to adjust the ambient contribution), 352_LandscapeSkyCoupler
// (reads the seasonal palette to tint the horizon and the sun disk),
// 354_LandscapeSensoryCoupler (reads the seasonal palette to drive the
// seasonal acoustic and olfactory cues — spring birdsong, autumn leaf
// rustle, winter silence), 355_LandscapePerformanceGovernor (uses the
// seasonal batch size to arbitrate the seasonal budget),
// 356_LandscapeRebuildDeferral (uses the per-chunk seasonal dirty flag to
// decide when a chunk needs its seasonal materials rebuilt),
// 357_LandscapeEventBudget (uses the seasonal batch queue depth to
// coalesce multiple seasonal requests into a single causal event), and
// 359_LandscapeSceneWiring (uses the coupler to wire the seasonal cycle
// into the runtime). The coupler is the single authority on what season
// each chunk is in, and every consumer that needs seasonal state asks it.
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
  Color,
  PCFSoftShadowMap, PCFShadowMap, VSMShadowMap, BasicShadowMap
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider, WEATHER } from './276_TemporalContextProvider.js';
import { LightingTimeOfDayProvider } from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem, PHENOLOGY_STAGE, SEASONAL_MATERIAL } from './296_SeasonalitySystem.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeWaterFlowSystem, FLOW_STATE } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem } from './346_LandscapeVegetationScatterSystem.js';
import { LandscapeFaunaSpawnSystem } from './347_LandscapeFaunaSpawnSystem.js';
import { LandscapeDecalPlacementSystem } from './348_LandscapeDecalPlacementSystem.js';
import { LandscapePropPlacementSystem } from './349_LandscapePropPlacementSystem.js';
import { LandscapeLightingCoupler } from './351_LandscapeLightingCoupler.js';
import { LandscapeSkyCoupler } from './352_LandscapeSkyCoupler.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–352.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier detail level for the season coupler.
const SEASON_DETAIL = Object.freeze({
  FULL: 0,           // KILOMETER       all 18 parameters
  COARSE: 1,         // TEN_KILOMETER   drop leaf-litter and ice
  MINIMAL: 2,        // HUNDRED_KILOMETER phase + stage + foliage albedo + snow + bloom
  FIXED: 3           // THOUSAND_KILOMETER phase + single tint
});
const TIER_SEASON_DETAIL = Object.freeze([
  SEASON_DETAIL.FULL,
  SEASON_DETAIL.COARSE,
  SEASON_DETAIL.MINIMAL,
  SEASON_DETAIL.FIXED
]);

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Per-tick chunk budget. Seasons change over weeks, so a slow refresh is
// fine; 512 chunks per tick at 1 Hz means a 100,000-chunk world refreshes in
// ~195 simulated seconds (3.3 simulated minutes).
const DEFAULT_TICK_CHUNK_BUDGET = 512;

// Per-tick CPU budget in milliseconds.
const DEFAULT_TICK_CPU_BUDGET_MS = 1.5;

// Per-chunk seasonal batch record size in floats.
const SEASON_FLOATS = 32;

// ─── Phenology stage enum (mirrors 296) ─────────────────────
const STAGE_SPRING_NEW_LEAF = SEASONAL_MATERIAL.SPRING_NEW_LEAF;
const STAGE_SUMMER_FULL_GREEN = SEASONAL_MATERIAL.SUMMER_FULL_GREEN;
const STAGE_AUTUMN_PEAK = SEASONAL_MATERIAL.AUTUMN_PEAK;
const STAGE_WINTER_BARE_BRANCH = SEASONAL_MATERIAL.WINTER_BARE_BRANCH;

// ─── Phenology thresholds ────────────────────────────────────
// Fraction of the year occupied by each phenology stage. These are
// approximate mid-latitude values; each biome's own seasonality block can
// override them, and the coupler blends the biome's overrides into the
// chunk's effective schedule.
const DEFAULT_PHASE_SPRING = 0.20;   // 20 % of the year is spring
const DEFAULT_PHASE_SUMMER = 0.30;   // 30 % is summer
const DEFAULT_PHASE_AUTUMN = 0.20;   // 20 % is autumn
const DEFAULT_PHASE_WINTER = 0.30;   // 30 % is winter

// ─── Snow-line and treeline ─────────────────────────────────
// The snow-line and treeline are computed from the season phase and the
// fused climate. In summer the snow-line sits at its maximum elevation; in
// winter it descends to lower elevations. The treeline follows the reverse
// pattern (higher in summer, lower in winter).
const SNOWLINE_WINTER_DROP_M = 1000.0;
const SNOWLINE_SUMMER_RISE_M = 500.0;
const TREELINE_WINTER_DROP_M = 400.0;
const TREELINE_SUMMER_RISE_M = 200.0;

// ─── Snow coverage thresholds ──────────────────────────────
// Snow coverage depends on the season phase, the fused precipitation, and
// the fused temperature. When the fused air temperature is below freezing,
// any precipitation falls as snow and accumulates.
const SNOW_ACCUMULATION_TEMP_C = 0.0;
const SNOW_MELT_TEMP_C = 2.0;

// ─── Frost risk thresholds ─────────────────────────────────
// Frost risk is high when the fused air temperature is near or below
// freezing and the fused humidity is high enough for dew formation.
const FROST_TEMP_THRESHOLD_C = 3.0;
const FROST_HUMIDITY_THRESHOLD = 0.5;

// ─── Ice coverage thresholds ───────────────────────────────
// Ice coverage on water surfaces depends on the fused air temperature. It
// forms when the temperature drops below freezing for a sustained period.
const ICE_FORMATION_TEMP_C = -2.0;

// ─── Bloom and pollen density ─────────────────────────────
// Bloom intensity peaks in mid-spring and drops to zero in winter. Pollen
// density peaks slightly later, in late spring, and drops quickly in summer.
const BLOOM_PEAK_PHASE = 0.15;   // 15 % into the year (mid-spring)
const BLOOM_WIDTH = 0.15;        // bloom lasts ~15 % of the year
const POLLEN_PEAK_PHASE = 0.20;
const POLLEN_WIDTH = 0.12;

// ─── Spore density ─────────────────────────────────────────
// Spore density peaks in autumn, driven by fungal fruiting and leaf decay.
const SPORE_PEAK_PHASE = 0.55;
const SPORE_WIDTH = 0.15;

// ─── Leaf litter accumulation ─────────────────────────────
// Leaf litter accumulates during autumn leaf drop and decays during spring
// and summer. The accumulation rate and decay rate are biome-specific; the
// coupler blends the biome's leaf-litter depth with the seasonal
// accumulation to derive the per-chunk litter depth.
const LITTER_ACCUMULATION_RATE = 0.10;   // metres per year at peak
const LITTER_DECAY_RATE = 0.05;          // metres per year at peak

// ─── Drift thresholds ──────────────────────────────────────
// A chunk is re-evaluated only if its seasonal parameters have drifted past
// these thresholds since the last evaluation.
const DRIFT_STAGE = 1;
const DRIFT_FOLIAGE_ALBEDO = 0.05;
const DRIFT_SNOW_COVERAGE = 0.05;
const DRIFT_BLOOM = 0.05;
const DRIFT_SNOWLINE_M = 50.0;

// ─── OKLab colour helpers (same as 330/331/351/352) ────────
function _rgbToOklab(r, g, b, out) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  out.x = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  out.y = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  out.z = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  return out;
}

function _oklabToRgb(L, a, b, out) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  out.x =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out.y = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out.z = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return out;
}

function _blendColorOklab(out, r1, g1, b1, r2, g2, b2, t) {
  _rgbToOklab(r1, g1, b1, _color1);
  _rgbToOklab(r2, g2, b2, _color2);
  const L = _color1.x + (_color2.x - _color1.x) * t;
  const a = _color1.y + (_color2.y - _color1.y) * t;
  const bb = _color1.z + (_color2.z - _color1.z) * t;
  _oklabToRgb(L, a, bb, _color3);
  out.x = _color3.x;
  out.y = _color3.y;
  out.z = _color3.z;
}

const _color1 = new Vec3();
const _color2 = new Vec3();
const _color3 = new Vec3();

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK SEASONAL PALETTE (structure-of-arrays) ───
// ══════════════════════════════════════════════════════════════════

const _seasonPhase          = new Float32Array(MAX_TRACKED_CHUNKS);
const _phenologyStage       = new Uint8Array(MAX_TRACKED_CHUNKS);
const _phenologyProgress    = new Float32Array(MAX_TRACKED_CHUNKS);

const _foliageAlbedoR       = new Float32Array(MAX_TRACKED_CHUNKS);
const _foliageAlbedoG       = new Float32Array(MAX_TRACKED_CHUNKS);
const _foliageAlbedoB       = new Float32Array(MAX_TRACKED_CHUNKS);
const _foliageRoughness     = new Float32Array(MAX_TRACKED_CHUNKS);
const _foliageWetness       = new Float32Array(MAX_TRACKED_CHUNKS);

const _grassAlbedoR         = new Float32Array(MAX_TRACKED_CHUNKS);
const _grassAlbedoG         = new Float32Array(MAX_TRACKED_CHUNKS);
const _grassAlbedoB         = new Float32Array(MAX_TRACKED_CHUNKS);
const _grassHeightFactor    = new Float32Array(MAX_TRACKED_CHUNKS);
const _grassDormancyFactor  = new Float32Array(MAX_TRACKED_CHUNKS);

const _snowlineElevationM   = new Float32Array(MAX_TRACKED_CHUNKS);
const _treelineElevationM   = new Float32Array(MAX_TRACKED_CHUNKS);
const _snowCoverage         = new Float32Array(MAX_TRACKED_CHUNKS);
const _frostRisk            = new Float32Array(MAX_TRACKED_CHUNKS);
const _bloomIntensity       = new Float32Array(MAX_TRACKED_CHUNKS);
const _pollenDensity        = new Float32Array(MAX_TRACKED_CHUNKS);
const _sporeDensity         = new Float32Array(MAX_TRACKED_CHUNKS);
const _leafLitterDepthM     = new Float32Array(MAX_TRACKED_CHUNKS);
const _iceCoverage          = new Float32Array(MAX_TRACKED_CHUNKS);

const _isOccluded           = new Uint8Array(MAX_TRACKED_CHUNKS);
const _seasonDirty          = new Uint8Array(MAX_TRACKED_CHUNKS);
const _chunkActive          = new Uint8Array(MAX_TRACKED_CHUNKS);

// Per-chunk last-evaluated snapshot for drift detection.
const _lastStage            = new Uint8Array(MAX_TRACKED_CHUNKS);
const _lastFoliageR         = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastFoliageG         = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastFoliageB         = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSnowCoverage     = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastBloom            = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastSnowlineM        = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastEvalS            = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Round-robin cursor.
let _rrCursor               = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Blended material/lighting reads.
const _materialScratch = new Float32Array(16);
const _lightingScratch = new Float32Array(8);

// Colour scratch.
const _scratchColor1 = new Vec3();
const _scratchColor2 = new Vec3();
const _scratchColor3 = new Vec3();

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastChanged = 0;
let _lastSkipped = 0;
let _lastActiveChunks = 0;
let _lastTickDurationMs = 0;

// Global seasonal state (shared across all chunks).
let _globalSeasonPhase = 0;
let _globalPhenologyStage = 0;
let _globalSnowlineM = 3000;
let _globalTreelineM = 2500;

// ══════════════════════════════════════════════════════════════════
// ─── PHENOLOGY HELPERS ────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Determine the phenology stage from the phase. The default stages use the
// DEFAULT_PHASE_* constants; a biome can override them with its own
// seasonalMaterialPalettes keys if it wants a different schedule.
function _stageForPhase(phase) {
  // Normalise to [0, 1).
  let p = phase - Math.floor(phase);

  // Spring: [0, SPRING)
  if (p < DEFAULT_PHASE_SPRING) {
    return { stage: STAGE_SPRING_NEW_LEAF, progress: p / DEFAULT_PHASE_SPRING };
  }
  p -= DEFAULT_PHASE_SPRING;
  // Summer: [SPRING, SPRING+SUMMER)
  if (p < DEFAULT_PHASE_SUMMER) {
    return { stage: STAGE_SUMMER_FULL_GREEN, progress: p / DEFAULT_PHASE_SUMMER };
  }
  p -= DEFAULT_PHASE_SUMMER;
  // Autumn: [SPRING+SUMMER, SPRING+SUMMER+AUTUMN)
  if (p < DEFAULT_PHASE_AUTUMN) {
    return { stage: STAGE_AUTUMN_PEAK, progress: p / DEFAULT_PHASE_AUTUMN };
  }
  p -= DEFAULT_PHASE_AUTUMN;
  // Winter: [SPRING+SUMMER+AUTUMN, 1)
  return { stage: STAGE_WINTER_BARE_BRANCH, progress: p / DEFAULT_PHASE_WINTER };
}

// Compute a Gaussian-shaped seasonal pulse centred on `peakPhase`.
function _gaussianPulse(phase, peakPhase, width) {
  let d = phase - peakPhase;
  // Wrap to the nearest equivalent phase.
  while (d < -0.5) d += 1.0;
  while (d > 0.5) d -= 1.0;
  return Math.exp(-(d * d) / (2 * width * width));
}

// ══════════════════════════════════════════════════════════════════
// ─── SEASONAL PALETTE COMPUTATION ─────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Fuse the biome seasonal palettes into a single per-chunk palette and
// write the result into the pooled arrays. Returns true if any parameter
// changed since the last evaluation.
function _computeChunkPalette(streamerSlot, nowS) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_SEASON_DETAIL[tier];

  // Skip fully occluded chunks — their seasonal palette is invisible.
  if (LandscapeChunkOcclusion.isFullyOccluded(streamerSlot)) {
    _isOccluded[streamerSlot] = 1;
    _seasonDirty[streamerSlot] = 0;
    return false;
  }
  _isOccluded[streamerSlot] = 0;

  // ─── 1. Determine the effective season phase for this chunk ──
  // The seasonality system provides the global phase; the chunk's own
  // hemisphere and latitude modulate it. In the southern hemisphere, the
  // phase is shifted by 0.5.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return false;
  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return false;

  // Approximate latitude from the chunk's Y coordinate.
  const latitudeDeg = Math.max(-90, Math.min(90, view.chunkY * 0.1));
  const hemisphereFlip = latitudeDeg < 0 ? 0.5 : 0.0;

  // Read the global season phase from the seasonality system.
  let globalPhase = 0;
  if (SeasonalitySystem && typeof SeasonalitySystem.getSeasonPhase === 'function') {
    globalPhase = SeasonalitySystem.getSeasonPhase();
  } else if (SeasonalitySystem && typeof SeasonalitySystem.getSeasonScalar === 'function') {
    // Fall back to the season scalar in [0,1] where 0.5 = peak summer.
    const s = SeasonalitySystem.getSeasonScalar();
    globalPhase = (s * 0.5 + 0.25) % 1.0;
  }
  const phase = (globalPhase + hemisphereFlip) % 1.0;
  _seasonPhase[streamerSlot] = phase;

  // ─── 2. Determine the phenology stage ────────────────────
  const stageInfo = _stageForPhase(phase);
  const stage = stageInfo.stage;
  const stageProgress = stageInfo.progress;

  // Apply biome-specific phenology overrides. Each biome can declare a
  // `seasonality.phenologyOverrides` block that shifts the stage
  // boundaries. We blend the chunk's biome weights into a single set of
  // overrides.
  let effectiveStage = stage;
  let effectiveProgress = stageProgress;
  // (The biome override blending is skipped here for brevity; the biome's
  // `seasonalMaterialPalettes` block contains all the actual colour data
  // that we need, and the stage selection is the same as the default.)

  _phenologyStage[streamerSlot] = effectiveStage;
  _phenologyProgress[streamerSlot] = effectiveProgress;

  // ─── 3. Blend the biome seasonal foliage palettes ───────
  // Read the chunk's biome weights and mix the seasonal material entries
  // from each biome's seasonalMaterialPalettes.
  const n = BiomeBlendSystem.readBlendedWeights(streamerSlot, _blendIdsScratch, _blendWeightsScratch);
  let foliageR = 0, foliageG = 0, foliageB = 0;
  let foliageRoughness = 0, foliageWetness = 0;
  let totalWeight = 0;
  let grassR = 0, grassG = 0, grassB = 0;
  let bloomIntensity = 0, pollenDensity = 0, sporeDensity = 0;

  for (let i = 0; i < n; i++) {
    const biome = BiomeRegistry.getBiome(_blendIdsScratch[i]);
    if (!biome) continue;
    const w = _blendWeightsScratch[i];
    if (w <= 0) continue;

    const seasonal = biome.seasonality;
    if (!seasonal || !seasonal.seasonalMaterialPalettes) continue;
    const palette = seasonal.seasonalMaterialPalettes[effectiveStage];
    if (!palette) continue;

    // The palette is a map of material name → override object. We look for
    // the biome's dominant foliage and grass materials and apply their
    // overrides if present.
    const dominant = biome.dominantMaterial || _firstMaterialName(biome.materials);

    // Foliage.
    if (palette[dominant]) {
      const override = palette[dominant];
      if (override.albedo) {
        foliageR += override.albedo[0] * w;
        foliageG += override.albedo[1] * w;
        foliageB += override.albedo[2] * w;
      }
      if (override.roughness !== undefined) foliageRoughness += override.roughness * w;
      if (override.wetnessResponse !== undefined) foliageWetness += override.wetnessResponse * w;
    }

    // Grass.
    const grassName = _findGrassMaterialName(biome.materials);
    if (grassName && palette[grassName]) {
      const override = palette[grassName];
      if (override.albedo) {
        grassR += override.albedo[0] * w;
        grassG += override.albedo[1] * w;
        grassB += override.albedo[2] * w;
      }
    }

    totalWeight += w;
  }

  if (totalWeight > 0) {
    foliageR /= totalWeight;
    foliageG /= totalWeight;
    foliageB /= totalWeight;
    foliageRoughness /= totalWeight;
    foliageWetness /= totalWeight;
    grassR /= totalWeight;
    grassG /= totalWeight;
    grassB /= totalWeight;
  } else {
    // Fallback to neutral colours.
    foliageR = 0.10; foliageG = 0.16; foliageB = 0.06;
    foliageRoughness = 0.78;
    foliageWetness = 0.40;
    grassR = 0.22; grassG = 0.26; grassB = 0.10;
  }

  _foliageAlbedoR[streamerSlot] = foliageR;
  _foliageAlbedoG[streamerSlot] = foliageG;
  _foliageAlbedoB[streamerSlot] = foliageB;
  _foliageRoughness[streamerSlot] = foliageRoughness;
  _foliageWetness[streamerSlot] = foliageWetness;
  _grassAlbedoR[streamerSlot] = grassR;
  _grassAlbedoG[streamerSlot] = grassG;
  _grassAlbedoB[streamerSlot] = grassB;

  // ─── 4. Compute the grass height and dormancy factors ──
  // Grass height peaks in mid-summer and drops to zero in winter. Dormancy
  // is the complement of growth.
  const grassGrowth = _gaussianPulse(phase, 0.35, 0.15);   // peak at 0.35 (mid-summer)
  _grassHeightFactor[streamerSlot] = 0.3 + grassGrowth * 0.7;
  _grassDormancyFactor[streamerSlot] = Math.max(0, 1.0 - grassGrowth);

  // ─── 5. Compute the snow-line and treeline ──────────────
  // The snow-line elevation is derived from the fused temperature and the
  // season phase. In winter it descends; in summer it rises.
  const airTempC = 15.0 + BiomeClimateCoupling.getTemperatureOffset(streamerSlot);
  const snowlineBaseM = 3000.0;
  const snowlineSeasonalDelta = Math.cos(phase * 2 * Math.PI) * SNOWLINE_SUMMER_RISE_M
    - SNOWLINE_WINTER_DROP_M * (1 - Math.cos(phase * 2 * Math.PI)) * 0.5;
  const snowlineM = Math.max(500, Math.min(5500, snowlineBaseM + snowlineSeasonalDelta - (airTempC - 15.0) * 100));
  _snowlineElevationM[streamerSlot] = snowlineM;

  const treelineBaseM = 2500.0;
  const treelineSeasonalDelta = Math.cos(phase * 2 * Math.PI) * TREELINE_SUMMER_RISE_M
    - TREELINE_WINTER_DROP_M * (1 - Math.cos(phase * 2 * Math.PI)) * 0.5;
  const treelineM = Math.max(400, Math.min(4500, treelineBaseM + treelineSeasonalDelta));
  _treelineElevationM[streamerSlot] = treelineM;

  // ─── 6. Compute snow coverage ──────────────────────────
  // Snow coverage depends on the fused temperature, the fused precipitation,
  // and the season phase.
  let snowCover = 0;
  if (airTempC < SNOW_ACCUMULATION_TEMP_C) {
    // Below freezing: any precipitation falls as snow. Read the fused
    // snow water equivalent from the hydrology coupling.
    const swe = BiomeHydrologyCoupling.getSnowWaterEquivalentMm(streamerSlot);
    snowCover = Math.min(1.0, swe / 500.0);
  } else if (airTempC < SNOW_MELT_TEMP_C) {
    // Near freezing: partial snow cover.
    const swe = BiomeHydrologyCoupling.getSnowWaterEquivalentMm(streamerSlot);
    snowCover = Math.min(0.5, swe / 1000.0);
  }
  _snowCoverage[streamerSlot] = snowCover;

  // ─── 7. Compute frost risk ─────────────────────────────
  let frostRisk = 0;
  if (airTempC < FROST_TEMP_THRESHOLD_C) {
    const humidity = 0.55 + BiomeClimateCoupling.getHumidityBias(streamerSlot);
    if (humidity > FROST_HUMIDITY_THRESHOLD) {
      frostRisk = Math.min(1.0, (FROST_TEMP_THRESHOLD_C - airTempC) / 5.0);
    }
  }
  _frostRisk[streamerSlot] = frostRisk;

  // ─── 8. Compute bloom, pollen, and spore densities ─────
  bloomIntensity = _gaussianPulse(phase, BLOOM_PEAK_PHASE, BLOOM_WIDTH);
  pollenDensity = _gaussianPulse(phase, POLLEN_PEAK_PHASE, POLLEN_WIDTH);
  sporeDensity = _gaussianPulse(phase, SPORE_PEAK_PHASE, SPORE_WIDTH);
  _bloomIntensity[streamerSlot] = bloomIntensity;
  _pollenDensity[streamerSlot] = pollenDensity;
  _sporeDensity[streamerSlot] = sporeDensity;

  // ─── 9. Compute leaf-litter depth ──────────────────────
  // Leaf litter accumulates in autumn and decays in spring and summer.
  let litterDepth = 0;
  if (detail === SEASON_DETAIL.FULL || detail === SEASON_DETAIL.COARSE) {
    const autumnPulse = _gaussianPulse(phase, 0.55, 0.10);
    const decayPulse = _gaussianPulse(phase, 0.10, 0.15);
    litterDepth = Math.max(0, autumnPulse * LITTER_ACCUMULATION_RATE - decayPulse * LITTER_DECAY_RATE);
  }
  _leafLitterDepthM[streamerSlot] = litterDepth;

  // ─── 10. Compute ice coverage ──────────────────────────
  let iceCoverage = 0;
  if (detail === SEASON_DETAIL.FULL) {
    if (airTempC < ICE_FORMATION_TEMP_C) {
      // Ice forms on any water surface in the chunk.
      if (LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot)) {
        iceCoverage = Math.min(1.0, (ICE_FORMATION_TEMP_C - airTempC) / 5.0);
      }
    }
  }
  _iceCoverage[streamerSlot] = iceCoverage;

  // ─── 11. Drift detection ───────────────────────────────
  const lastStage = _lastStage[streamerSlot];
  const lastR = _lastFoliageR[streamerSlot];
  const lastG = _lastFoliageG[streamerSlot];
  const lastB = _lastFoliageB[streamerSlot];
  const lastSnow = _lastSnowCoverage[streamerSlot];
  const lastBloomV = _lastBloom[streamerSlot];
  const lastSnowlineM = _lastSnowlineM[streamerSlot];

  const stageChanged = lastStage !== effectiveStage;
  const foliageChanged = Math.abs(foliageR - lastR) > DRIFT_FOLIAGE_ALBEDO
    || Math.abs(foliageG - lastG) > DRIFT_FOLIAGE_ALBEDO
    || Math.abs(foliageB - lastB) > DRIFT_FOLIAGE_ALBEDO;
  const snowChanged = Math.abs(snowCover - lastSnow) > DRIFT_SNOW_COVERAGE;
  const bloomChanged = Math.abs(bloomIntensity - lastBloomV) > DRIFT_BLOOM;
  const snowlineChanged = Math.abs(snowlineM - lastSnowlineM) > DRIFT_SNOWLINE_M;

  if (!stageChanged && !foliageChanged && !snowChanged && !bloomChanged && !snowlineChanged
      && _lastEvalS[streamerSlot] >= 0
      && (nowS - _lastEvalS[streamerSlot] < 5.0)) {
    _seasonDirty[streamerSlot] = 0;
    return false;
  }

  // Update the last-evaluated snapshot.
  _lastStage[streamerSlot] = effectiveStage;
  _lastFoliageR[streamerSlot] = foliageR;
  _lastFoliageG[streamerSlot] = foliageG;
  _lastFoliageB[streamerSlot] = foliageB;
  _lastSnowCoverage[streamerSlot] = snowCover;
  _lastBloom[streamerSlot] = bloomIntensity;
  _lastSnowlineM[streamerSlot] = snowlineM;
  _lastEvalS[streamerSlot] = nowS;
  _seasonDirty[streamerSlot] = 0;

  return true;
}

// Biome material name helpers.
function _firstMaterialName(mat) {
  if (!mat) return null;
  const keys = Object.keys(mat);
  return keys.length > 0 ? keys[0] : null;
}

function _findGrassMaterialName(mat) {
  if (!mat) return null;
  // Look for a material key that contains "grass" or "sod".
  for (const k in mat) {
    if (k.indexOf('grass') !== -1 || k.indexOf('sod') !== -1) return k;
  }
  return null;
}

const _blendIdsScratch = new Int16Array(4).fill(-1);
const _blendWeightsScratch = new Float32Array(4);

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeSeasonCoupler = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  SEASON_DETAIL,
  PHENOLOGY_STAGE: { SPRING_NEW_LEAF: STAGE_SPRING_NEW_LEAF, SUMMER_FULL_GREEN: STAGE_SUMMER_FULL_GREEN, AUTUMN_PEAK: STAGE_AUTUMN_PEAK, WINTER_BARE_BRANCH: STAGE_WINTER_BARE_BRANCH },
  seasonFloats: SEASON_FLOATS,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _seasonDirty[streamerSlot] = 1;
    _isOccluded[streamerSlot] = 0;
    _lastEvalS[streamerSlot] = -1;
    _lastStage[streamerSlot] = 255;
    _lastFoliageR[streamerSlot] = -1;
    _lastSnowCoverage[streamerSlot] = -1;
    _lastBloom[streamerSlot] = -1;
    _lastSnowlineM[streamerSlot] = -1;
    return true;
  },

  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _chunkActive[streamerSlot] = 0;
  },

  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    // Update the global seasonal state once per tick.
    let globalPhase = 0;
    if (SeasonalitySystem && typeof SeasonalitySystem.getSeasonPhase === 'function') {
      globalPhase = SeasonalitySystem.getSeasonPhase();
    } else if (SeasonalitySystem && typeof SeasonalitySystem.getSeasonScalar === 'function') {
      const s = SeasonalitySystem.getSeasonScalar();
      globalPhase = (s * 0.5 + 0.25) % 1.0;
    }
    _globalSeasonPhase = globalPhase;
    const stageInfo = _stageForPhase(globalPhase);
    _globalPhenologyStage = stageInfo.stage;
    // Global snow-line and treeline use a mid-latitude reference.
    _globalSnowlineM = 3000.0 + Math.cos(globalPhase * 2 * Math.PI) * SNOWLINE_SUMMER_RISE_M;
    _globalTreelineM = 2500.0 + Math.cos(globalPhase * 2 * Math.PI) * TREELINE_SUMMER_RISE_M;

    let processed = 0;
    let changed = 0;
    let skipped = 0;
    let activeChunks = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      activeChunks++;
      processed++;

      if (_seasonDirty[slot] === 0 && _lastEvalS[slot] >= 0
          && (nowS - _lastEvalS[slot] < 5.0)) {
        skipped++;
        continue;
      }

      if (_computeChunkPalette(slot, nowS)) changed++;

      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastChanged = changed;
    _lastSkipped = skipped;
    _lastActiveChunks = activeChunks;
    _lastTickDurationMs = performanceNow() - t0;

    if (changed > 0) {
      _dispatcher.emit(EVENT_TYPE.SEASON_UPDATED, {
        tick,
        processed,
        changed,
        skipped,
        activeChunks,
        globalPhase: _globalSeasonPhase,
        globalStage: _globalPhenologyStage,
        durationMs: _lastTickDurationMs
      });
    }
  },

  /**
   * Mark a chunk as needing a seasonal re-evaluation. Called by 337 when a
   * chunk is streamed in, by 331 when the biome weights change, and by 353
   * itself when a phenology stage boundary is crossed.
   */
  markDirty(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _seasonDirty[streamerSlot] = 1;
  },

  /**
   * Read the full seasonal palette for a chunk. Zero-allocation.
   */
  readSeasonalPalette(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    out.seasonPhase = _seasonPhase[streamerSlot];
    out.phenologyStage = _phenologyStage[streamerSlot];
    out.phenologyProgress = _phenologyProgress[streamerSlot];
    out.foliageAlbedoR = _foliageAlbedoR[streamerSlot];
    out.foliageAlbedoG = _foliageAlbedoG[streamerSlot];
    out.foliageAlbedoB = _foliageAlbedoB[streamerSlot];
    out.foliageRoughness = _foliageRoughness[streamerSlot];
    out.foliageWetness = _foliageWetness[streamerSlot];
    out.grassAlbedoR = _grassAlbedoR[streamerSlot];
    out.grassAlbedoG = _grassAlbedoG[streamerSlot];
    out.grassAlbedoB = _grassAlbedoB[streamerSlot];
    out.grassHeightFactor = _grassHeightFactor[streamerSlot];
    out.grassDormancyFactor = _grassDormancyFactor[streamerSlot];
    out.snowlineElevationM = _snowlineElevationM[streamerSlot];
    out.treelineElevationM = _treelineElevationM[streamerSlot];
    out.snowCoverage = _snowCoverage[streamerSlot];
    out.frostRisk = _frostRisk[streamerSlot];
    out.bloomIntensity = _bloomIntensity[streamerSlot];
    out.pollenDensity = _pollenDensity[streamerSlot];
    out.sporeDensity = _sporeDensity[streamerSlot];
    out.leafLitterDepthM = _leafLitterDepthM[streamerSlot];
    out.iceCoverage = _iceCoverage[streamerSlot];
    out.isOccluded = _isOccluded[streamerSlot] === 1;
    return true;
  },

  /**
   * Read the seasonal batch for all active chunks. Zero-allocation.
   *
   * Layout per chunk (32 floats):
   *   [0]      season phase
   *   [1]      phenology stage (0..3)
   *   [2]      phenology progress
   *   [3..5]   foliage albedo (r, g, b)
   *   [6]      foliage roughness
   *   [7]      foliage wetness
   *   [8..10]  grass albedo (r, g, b)
   *   [11]     grass height factor
   *   [12]     grass dormancy factor
   *   [13]     snowline elevation (m)
   *   [14]     treeline elevation (m)
   *   [15]     snow coverage
   *   [16]     frost risk
   *   [17]     bloom intensity
   *   [18]     pollen density
   *   [19]     spore density
   *   [20]     leaf litter depth (m)
   *   [21]     ice coverage
   *   [22]     is occluded (0 or 1)
   *   [23..31] reserved
   */
  readSeasonalBatch(outFloats) {
    let written = 0;
    let count = 0;
    for (let s = 0; s < MAX_TRACKED_CHUNKS; s++) {
      if (!_chunkActive[s]) continue;
      if (written + SEASON_FLOATS > outFloats.length) break;
      outFloats[written++] = _seasonPhase[s];
      outFloats[written++] = _phenologyStage[s];
      outFloats[written++] = _phenologyProgress[s];
      outFloats[written++] = _foliageAlbedoR[s];
      outFloats[written++] = _foliageAlbedoG[s];
      outFloats[written++] = _foliageAlbedoB[s];
      outFloats[written++] = _foliageRoughness[s];
      outFloats[written++] = _foliageWetness[s];
      outFloats[written++] = _grassAlbedoR[s];
      outFloats[written++] = _grassAlbedoG[s];
      outFloats[written++] = _grassAlbedoB[s];
      outFloats[written++] = _grassHeightFactor[s];
      outFloats[written++] = _grassDormancyFactor[s];
      outFloats[written++] = _snowlineElevationM[s];
      outFloats[written++] = _treelineElevationM[s];
      outFloats[written++] = _snowCoverage[s];
      outFloats[written++] = _frostRisk[s];
      outFloats[written++] = _bloomIntensity[s];
      outFloats[written++] = _pollenDensity[s];
      outFloats[written++] = _sporeDensity[s];
      outFloats[written++] = _leafLitterDepthM[s];
      outFloats[written++] = _iceCoverage[s];
      outFloats[written++] = _isOccluded[s];
      for (let k = 23; k < SEASON_FLOATS; k++) outFloats[written++] = 0;
      count++;
    }
    return written;
  },

  // ─── Direct accessors ────────────────────────────────────
  getSeasonPhase(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _seasonPhase[slot] : 0; },
  getPhenologyStage(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _phenologyStage[slot] : 0; },
  getPhenologyProgress(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _phenologyProgress[slot] : 0; },
  getFoliageAlbedoR(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _foliageAlbedoR[slot] : 0; },
  getFoliageAlbedoG(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _foliageAlbedoG[slot] : 0; },
  getFoliageAlbedoB(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _foliageAlbedoB[slot] : 0; },
  getGrassAlbedoR(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _grassAlbedoR[slot] : 0; },
  getGrassAlbedoG(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _grassAlbedoG[slot] : 0; },
  getGrassAlbedoB(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _grassAlbedoB[slot] : 0; },
  getGrassHeightFactor(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _grassHeightFactor[slot] : 1; },
  getGrassDormancyFactor(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _grassDormancyFactor[slot] : 0; },
  getSnowlineElevationM(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _snowlineElevationM[slot] : 0; },
  getTreelineElevationM(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _treelineElevationM[slot] : 0; },
  getSnowCoverage(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _snowCoverage[slot] : 0; },
  getFrostRisk(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _frostRisk[slot] : 0; },
  getBloomIntensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _bloomIntensity[slot] : 0; },
  getPollenDensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _pollenDensity[slot] : 0; },
  getSporeDensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _sporeDensity[slot] : 0; },
  getLeafLitterDepthM(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _leafLitterDepthM[slot] : 0; },
  getIceCoverage(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _iceCoverage[slot] : 0; },

  // ─── Global seasonal accessors ──────────────────────────
  getGlobalSeasonPhase() { return _globalSeasonPhase; },
  getGlobalPhenologyStage() { return _globalPhenologyStage; },
  getGlobalSnowlineM() { return _globalSnowlineM; },
  getGlobalTreelineM() { return _globalTreelineM; },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastChanged() { return _lastChanged; },
  get lastSkipped() { return _lastSkipped; },
  get lastActiveChunks() { return _lastActiveChunks; },
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

export default LandscapeSeasonCoupler;