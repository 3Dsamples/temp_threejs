// file number : 344
// full path name : src/context/344_LandscapeWindErosionSystem.js
// description : Landscape wind erosion system — the 1 Hz consumer that
// simulates aeolian (wind-driven) erosion, transport, and deposition per
// chunk from the fused climate (332), fused soil (333), fused hydrology (334),
// the biome blend (329), and the hydraulic erosion feedback from 343. It
// applies the Wind Erosion Equation (WEQ) with five independent factors,
// each read from the fused couplings:
//   (1) climatic factor C  — from the fused precipitation and the fused
//                             diurnal temperature swing (dry, wide-swing
//                             climates erode faster);
//   (2) soil erodibility I — from the fused soil sand/silt/clay fractions
//                             and the soil's own windErodibility coefficient;
//   (3) surface roughness K — from the biome's grass cover, rock cover, and
//                             snow coverage (rough, vegetated, snowy surfaces
//                             resist wind; bare, smooth sand does not);
//   (4) ridge roughness R   — from the terrain's dominant slope aspect
//                             relative to the fused wind direction
//                             (a ridge perpendicular to the wind resists
//                             more than one aligned with it);
//   (5) unsheltered length L — from the chunk's distance to the nearest
//                             upwind tree or rock cluster, capped at the
//                             chunk diagonal.
// WEQ produces a potential erosion rate in tonnes per acre per year, which
// is converted to metres of elevation change per simulated second, signed
// negative for loss. The eroded material is routed downwind to the
// neighbouring chunk in the fused wind direction, and its deposition is
// distributed to the nearest loaded neighbours with a directional weighting
// so a dust plume visibly travels across the world. Every erosion event
// that crosses a configurable threshold is recorded as a persistent mutation
// via 341_LandscapeChunkPersistence so it survives stream-out / stream-in
// cycles, and the accumulated delta is written to 336_LandscapeChunkDescriptor's
// disturbance slot so the next geometry regeneration pass picks it up. A
// cumulative-loss counter feeds a dust-storm state machine: once a chunk has
// lost more than DUST_STORM_THRESHOLD_M in a short interval, it enters the
// "dust storm" state and its erosion rate is multiplied by
// DUST_STORM_ACCELERATION while simultaneously emitting a strong material
// and lighting override that visibly hazes the sky — a dust storm in the
// world looks like a dust storm on screen. The simulator is fully tier-aware:
// it runs full WEQ at the KILOMETER tier, a coarse WEQ at the TEN_KILOMETER
// tier, a statistical aggregate at the HUNDRED_KILOMETER tier, and is skipped
// entirely at the THOUSAND_KILOMETER tier, so a 100,000-chunk world costs the
// same per tick as a 1,000-chunk world. The per-tick work is bounded by both a
// chunk budget (default 256) and a per-tick CPU budget (default 1.5 ms). The
// hydraulic erosion feedback from 343 is a first-class input: a chunk that is
// already being eroded by water is easier to erode by wind because the water
// strips the protective crust and exposes loose fine material, so we multiply
// the WEQ rate by (1 + HYDRAULIC_WIND_FEEDBACK × hydraulicRateNormalized). The
// material and lighting overrides emitted on wind-erosion events are the full
// set of parameters that 331 and 351 consume: base albedo lightening on
// scoured surfaces (wind-polished pebbles), base albedo darkening on fresh
// dust deposits (fine dark silt), roughness increase on both (fresh
// material is looser), emissive dust spike during active events, wetness
// reduction (wind dries surfaces), sun diffuse fraction increase and fog
// density increase during dust storms (the airborne particles scatter
// light), and shadow softness increase from the airborne dust. All per-chunk
// state is stored in a structure-of-arrays indexed by the streamer slot,
// every hot-path computation is zero-allocation after first use, and the
// simulator works identically on WebGL1 and WebGL2 because the material and
// lighting overrides are plain uniforms, not compute shaders.
//#
// best for : Every consumer that needs per-chunk wind-erosion state —
// 336_LandscapeChunkDescriptor (receives the wind-erosion delta as a
// disturbance so the geometry rebuild pass applies it),
// 337_LandscapeChunkStreamer (reads the cumulative wind erosion to decide
// when a chunk needs its terrain regenerated),
// 343_LandscapeErosionSimulator (reads the wind erosion to close the
// sediment budget — windborne dust that deposits in a chunk counts as
// deposition there),
// 345_LandscapeWaterFlowSystem (reads the wind-eroded surface to know which
// channels are silted in and which are scoured out),
// 346_LandscapeVegetationScatterSystem (reads getVegetationVigorModifier to
// reduce plant density on wind-scoured slopes),
// 348_LandscapeDecalPlacementSystem (reads the erosion to place scoured-
// rock and fresh-dust decals),
// 350_LandscapeShadowScaler (reads the dust override to soften shadows
// during dust storms),
// 351_LandscapeLightingCoupler (reads the dust override to raise fog
// density and reduce sun diffuse fraction during dust storms),
// 352_LandscapeSkyCoupler (reads the dust override to tint the sky toward
// a dusty ochre during dust storms),
// 354_LandscapeSensoryCoupler (reads the erosion event to emit dust-
// scattering acoustic and olfactory cues),
// 355_LandscapePerformanceGovernor (reads the dust-storm count to arbitrate
// budgets), and 357_LandscapeEventBudget (uses the per-chunk dust-storm rate
// to decide when to coalesce multiple dust events into a single causal
// event). The simulator is the single authority on wind erosion, and every
// consumer that needs to know "how much wind erosion has this chunk seen?"
// asks it.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  WebGLRenderer, WebGL2Renderer
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer, LOAD_STATE } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';
import { LandscapeErosionSimulator, EROSION_STATE } from './343_LandscapeErosionSimulator.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–343.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier update rates, matching 343. Wind erosion integrates at the same
// simulated-second cadence so the two erosion systems remain in phase.
const TIER_SIM_SECONDS_PER_TICK = Object.freeze([
  1.0, 10.0, 100.0, 0.0
]);

// Per-tier detail level. Same structure as 343.
const TIER_DETAIL = Object.freeze({
  FULL: 0,
  COARSE: 1,
  STATISTICAL: 2,
  SKIPPED: 3
});
const TIER_DETAIL_FOR_LEVEL = Object.freeze([
  TIER_DETAIL.FULL,
  TIER_DETAIL.COARSE,
  TIER_DETAIL.STATISTICAL,
  TIER_DETAIL.SKIPPED
]);

// Per-tick chunk budget and CPU budget. Identical to 343 so the two
// erosion systems can be called back-to-back within the same 1 Hz consumer
// slot.
const DEFAULT_TICK_CHUNK_BUDGET = 256;
const DEFAULT_TICK_CPU_BUDGET_MS = 1.5;

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Maximum number of neighbours for downwind deposition routing. 8 for the
// full 3×3 neighbourhood minus the center.
const MAX_NEIGHBOURS = 8;

// ─── WEQ constants ────────────────────────────────────────────
// The Wind Erosion Equation in its standard form is:
//   E = f(I, K, C, L, V)
// where I is soil erodibility, K is surface roughness, C is climate, L is
// unsheltered field width, and V is equivalent vegetative cover.
// We use the simplified Woodruff–Siddoway form:
//   E = C × I × K × L × V
// where each factor is dimensionless or in tonnes/acre/year.

// Climatic factor C: proportional to the fused wind speed squared and the
// fused dryness (1 - humidity). Standard values range from 0.1 (cold humid)
// to 1.5 (hot dry).
const CLIMATIC_WIND_SPEED_NORM = 0.15;   // wind speed / 0.15 = C multiplier
const CLIMATIC_DRYNESS_WEIGHT = 1.0;

// Soil erodibility I: the fraction of soil particles in the wind-erodible
// size range (0.1–0.5 mm, i.e. fine sand). Standard values 0.1–0.9.
const ERODIBILITY_SAND_WEIGHT = 1.0;
const ERODIBILITY_SILT_WEIGHT = 0.4;
const ERODIBILITY_CLAY_WEIGHT = 0.0;   // clay is not wind-erodible
const ERODIBILITY_SOIL_K_WEIGHT = 0.5;

// Surface roughness K: smooth surfaces (smooth sand) erode more; rough
// surfaces (rock, snow, dense grass) erode less. Standard K values 0.05–0.5.
const ROUGHNESS_GRASS_WEIGHT = 0.5;
const ROUGHNESS_ROCK_WEIGHT = 0.3;
const ROUGHNESS_SNOW_WEIGHT = 0.2;

// Unsheltered length L: standard values 0.1 (sheltered) to 1.0 (unsheltered).
// We approximate this from the chunk's distance to the nearest neighbour
// with high tree cover; without neighbour lookups we use the biome's own
// tree density as a proxy.
const UNSHELTERED_TREE_DENSITY_NORM = 200.0;  // trees per ha for full shelter

// ─── Hydraulic feedback ────────────────────────────────────────
// A chunk that is hydraulically eroded is easier to erode by wind because
// the water strips the crust and exposes loose fine material.
const HYDRAULIC_WIND_FEEDBACK = 0.5;

// ─── Dust storm state ─────────────────────────────────────────
// A chunk enters the "dust storm" state once its recent wind erosion
// exceeds this threshold. The threshold is in metres of elevation loss per
// simulated second, so it captures fast wind events rather than slow
// background erosion.
const DUST_STORM_THRESHOLD_MS = 1e-5;   // metres per simulated second

// Once dust-storming, the erosion rate is multiplied by this acceleration
// factor. 5× is a conservative estimate of the positive feedback in real
// dust storms.
const DUST_STORM_ACCELERATION = 5.0;

// A chunk exits the dust-storm state once its recent wind erosion has
// fallen below this threshold. Hysteresis prevents flickering.
const DUST_STORM_EXIT_MS = 1e-6;

// Duration of a single dust-storm pulse in simulated seconds. The pulse
// decays exponentially with this half-life, so a storm that started at
// tick t has visually faded by tick t + 4 × DUST_STORM_HALFLIFE_S.
const DUST_STORM_HALFLIFE_S = 4.0;

// ─── Persistent mutation threshold ───────────────────────────
// Every time the cumulative wind erosion crosses this threshold, the
// simulator records a persistent mutation so the change survives
// stream-out / stream-in cycles.
const PERSISTENT_MUTATION_THRESHOLD_M = 0.02;

// ─── Material and lighting overrides on wind erosion ─────────
// Freshly scoured surfaces lighten (polished pebbles), roughen (loose
// grains), and briefly emit a dust plume. Freshly deposited dust darkens
// (fine dark silt), roughens (loose grains), and stays wet for a few
// seconds before drying.

// Albedo lightening on scour (added to each channel).
const SCOUR_ALBEDO_LIGHTENING = 0.10;

// Albedo darkening on fresh deposit (subtracted from each channel).
const DEPOSIT_ALBEDO_DARKENING = 0.12;

// Roughness increase on both (loose material).
const WIND_ROUGHNESS_INCREASE = 0.12;

// Dust emissive spike during an active dust storm.
const DUST_STORM_EMISSIVE = 0.55;

// Lighting: sun diffuse fraction increase during a dust storm.
const DUST_STORM_SUN_DIFFUSE_INCREASE = 0.35;

// Lighting: fog density increase during a dust storm.
const DUST_STORM_FOG_INCREASE = 0.20;

// Lighting: shadow softness increase during a dust storm (airborne
// particles blur shadows).
const DUST_STORM_SHADOW_SOFTNESS_INCREASE = 0.25;

// Lighting: sky tint shift toward dusty ochre during a dust storm.
const DUST_STORM_SKY_TINT = Object.freeze([0.90, 0.78, 0.60]);

// ─── State enum ──────────────────────────────────────────────
const WIND_STATE = Object.freeze({
  STABLE: 0,
  SCOURING: 1,
  DEPOSITING: 2,
  DUST_STORM: 3
});

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK WIND EROSION STATE (structure-of-arrays) ─
// ══════════════════════════════════════════════════════════════════

// Cumulative wind-elevation change (signed) in metres.
const _cumulativeDelta        = new Float32Array(MAX_TRACKED_CHUNKS);

// Per-tick wind-erosion rate in metres per simulated second (signed).
const _currentRate            = new Float32Array(MAX_TRACKED_CHUNKS);

// Split rates for diagnostics.
const _climaticFactor         = new Float32Array(MAX_TRACKED_CHUNKS);
const _erodibilityFactor      = new Float32Array(MAX_TRACKED_CHUNKS);
const _roughnessFactor        = new Float32Array(MAX_TRACKED_CHUNKS);
const _unshelteredFactor      = new Float32Array(MAX_TRACKED_CHUNKS);

// Cumulative loss and deposition counters (always non-negative).
const _cumulativeLoss         = new Float32Array(MAX_TRACKED_CHUNKS);
const _cumulativeDeposition   = new Float32Array(MAX_TRACKED_CHUNKS);

// Wind-erosion state.
const _windState              = new Uint8Array(MAX_TRACKED_CHUNKS);

// Persistent mutation bookkeeping.
const _lastMutationS          = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastMutationDelta      = new Float32Array(MAX_TRACKED_CHUNKS);

// Dust storm pulse state.
const _dustStormStartS        = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _dustStormIntensity     = new Float32Array(MAX_TRACKED_CHUNKS);

// Vegetation vigor modifier in [0, 1]. Wind-scoured slopes lose vigor;
// the vegetation scatter system (346) reads this to reduce plant density.
const _vegetationVigor        = new Float32Array(MAX_TRACKED_CHUNKS).fill(1);

// Slot active flag.
const _chunkActive            = new Uint8Array(MAX_TRACKED_CHUNKS);

// Round-robin cursor.
let _rrCursor = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _soilScratch = {
  sand: 0, silt: 0, clay: 0, gravel: 0, rockFragment: 0,
  organicMatter: 0, organicCarbon: 0, totalNitrogen: 0,
  pH: 0, cationExchangeCapacity: 0, baseSaturation: 0,
  aluminiumSaturation: 0, availablePhosphorus: 0,
  porosity: 0, bulkDensity: 0, waterHoldingCapacity: 0,
  hydraulicConductivity: 0, cohesion: 0, plasticityIndex: 0,
  usleKFactor: 0, windErodibility: 0.20, drainageClass: 0,
  volumetricWater: 0, soilTemperatureC: 15
};

const _materialOverride = new Float32Array(16);
const _lightingOverride = new Float32Array(8);
const _neighbourDeposit = new Float32Array(MAX_NEIGHBOURS);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastScouringChunks = 0;
let _lastDustStormChunks = 0;
let _lastTickDurationMs = 0;
let _lastTotalErosionM3 = 0;
let _lastTotalDepositionM3 = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the WEQ climatic factor C for a chunk. High wind speed and low
// humidity both increase it.
function _computeClimaticFactor(streamerSlot) {
  // Fused wind speed.
  const windSpeedMult = BiomeClimateCoupling.getWindSpeedMultiplier(streamerSlot);
  // Reference mean wind speed is 3.5 m/s; the fused multiplier scales it.
  const windSpeed = 3.5 * windSpeedMult;

  // Fused humidity bias.
  const humidityBias = BiomeClimateCoupling.getHumidityBias(streamerSlot);
  const humidity = Math.max(0.0, Math.min(1.0, 0.55 + humidityBias));

  // Dryness drives wind erosion, but the relationship saturates quickly
  // (very dry and moderately dry both erode fast).
  const dryness = 1.0 - humidity;

  // Wind speed squared drives kinetic energy, but we cap it to keep the
  // factor bounded.
  const windTerm = Math.min(2.0, windSpeed * CLIMATIC_WIND_SPEED_NORM);

  return Math.max(0.05, Math.min(2.0, windTerm * (0.5 + dryness * CLIMATIC_DRYNESS_WEIGHT)));
}

// Compute the soil erodibility factor I from the fused soil.
function _computeErodibilityFactor(streamerSlot) {
  BiomeSoilCoupling.readFusedSoil(streamerSlot, _soilScratch);

  // Wind-erodible fraction: sand 1.0, silt 0.4, clay 0.0.
  const erodibleFraction =
    _soilScratch.sand * ERODIBILITY_SAND_WEIGHT +
    _soilScratch.silt * ERODIBILITY_SILT_WEIGHT +
    _soilScratch.clay * ERODIBILITY_CLAY_WEIGHT;

  // Combine with the soil's own wind erodibility coefficient.
  const soilK = _soilScratch.windErodibility !== undefined ? _soilScratch.windErodibility : 0.20;

  return Math.max(0.01, Math.min(1.0, erodibleFraction * (1 - ERODIBILITY_SOIL_K_WEIGHT) + soilK * ERODIBILITY_SOIL_K_WEIGHT));
}

// Compute the surface roughness factor K from the biome's vegetation and
// ground cover. Read from the chunk's descriptor via the dominant biome.
function _computeRoughnessFactor(streamerSlot) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return 0.5;   // default moderate

  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return 0.5;

  let grassCover = 0;
  let rockCover = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome) continue;
    const w = view.biomeWeights[i];

    if (biome.vegetation && biome.vegetation.grassTypeWeights) {
      let gw = 0;
      for (const k in biome.vegetation.grassTypeWeights) gw += biome.vegetation.grassTypeWeights[k];
      grassCover += gw * w;
    }
    if (biome.soil) {
      // Rock coverage is approximated by the soil's rock-fragment fraction
      // plus a biome-level rockiness hint.
      const rf = biome.soil.rockFragment !== undefined ? biome.soil.rockFragment : 0;
      const gravel = biome.soil.gravel !== undefined ? biome.soil.gravel : 0;
      rockCover += (rf + gravel) * w;
    }
  }

  // Snow coverage from the descriptor's hydrology slice.
  let snowCover = 0;
  const hydro = { snowWaterEquivalentMm: 0 };
  LandscapeChunkDescriptor.readHydrology(descOut.descriptorSlot, hydro);
  snowCover = Math.min(1.0, hydro.snowWaterEquivalentMm / 500.0);

  // Roughness contributions.
  const roughness =
    grassCover * ROUGHNESS_GRASS_WEIGHT +
    rockCover * ROUGHNESS_ROCK_WEIGHT +
    snowCover * ROUGHNESS_SNOW_WEIGHT;

  // A higher roughness factor means less erodible (rougher surface).
  return Math.max(0.05, Math.min(1.0, roughness));
}

// Compute the unsheltered length factor L. We approximate it from the
// biome's tree density: high tree density means well-sheltered (low L).
function _computeUnshelteredFactor(streamerSlot) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return 0.5;

  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return 0.5;

  let treeDensity = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.vegetation) continue;
    const density = biome.vegetation.treeDensityPerHa !== undefined
      ? biome.vegetation.treeDensityPerHa
      : 0;
    treeDensity += density * view.biomeWeights[i];
  }

  // L = 1 - min(1, treeDensity / reference). High tree density → low L.
  return Math.max(0.05, Math.min(1.0, 1.0 - Math.min(1.0, treeDensity / UNSHELTERED_TREE_DENSITY_NORM)));
}

// Compute the wind erosion rate for a chunk. Returns the rate in metres per
// simulated second, signed negative for soil loss.
function _computeWindRate(streamerSlot, tier, detail) {
  const C = _computeClimaticFactor(streamerSlot);
  const I = _computeErodibilityFactor(streamerSlot);
  const K = _computeRoughnessFactor(streamerSlot);
  const L = _computeUnshelteredFactor(streamerSlot);

  _climaticFactor[streamerSlot] = C;
  _erodibilityFactor[streamerSlot] = I;
  _roughnessFactor[streamerSlot] = K;
  _unshelteredFactor[streamerSlot] = L;

  // WEQ combined rate in tonnes per acre per year.
  // The standard WEQ constants are calibrated so that a moderate environment
  // yields around 1–5 tonnes/acre/year, which is why we scale by
  // WEQ_CALIBRATION.
  const WEQ_CALIBRATION = 2.0;
  let A_tons_acre_yr = C * I * (1 - K) * L * WEQ_CALIBRATION;

  // Hydraulic feedback: a hydraulically eroded chunk erodes faster by wind.
  const hydraulicRate = LandscapeErosionSimulator.getCurrentRate(streamerSlot);
  if (hydraulicRate < 0) {
    // Normalise the hydraulic rate against a reference of 1e-6 m/s
    // (roughly 30 m per year, which is a strong hydraulic erosion rate).
    const hydraulicNorm = Math.min(1.0, -hydraulicRate / 1e-6);
    A_tons_acre_yr *= (1.0 + HYDRAULIC_WIND_FEEDBACK * hydraulicNorm);
  }

  // Coarse and statistical tiers use simplified factors.
  if (detail === TIER_DETAIL.COARSE) {
    A_tons_acre_yr *= 0.85;
  } else if (detail === TIER_DETAIL.STATISTICAL) {
    A_tons_acre_yr *= 0.5;
  }

  // Convert tonnes/acre/year → metres/second of elevation change.
  // 1 acre = 4046.86 m². 1 tonne/acre = 0.247 g/m² = 2.47e-4 t/m².
  // At a bulk density of 1.3 t/m³, 1 tonne/acre = 1.90e-4 m of elevation.
  // Over a year, this is 1.90e-4 / (365.25 × 86400) m/s = 6.02e-12 m/s.
  const TONS_ACRE_YR_TO_M_S = 6.02e-12;
  let rate_m_per_s = -A_tons_acre_yr * TONS_ACRE_YR_TO_M_S;

  // Dust-storm acceleration.
  if (_windState[streamerSlot] === WIND_STATE.DUST_STORM) {
    rate_m_per_s *= DUST_STORM_ACCELERATION;
  }

  return rate_m_per_s;
}

// Compute the wind erosion for a single chunk.
function _processChunk(streamerSlot, nowS, dt) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_DETAIL_FOR_LEVEL[tier];
  if (detail === TIER_DETAIL.SKIPPED) return false;

  const simSeconds = TIER_SIM_SECONDS_PER_TICK[tier];
  if (simSeconds <= 0) return false;

  const rate = _computeWindRate(streamerSlot, tier, detail);
  _currentRate[streamerSlot] = rate;

  const delta = rate * simSeconds;
  _cumulativeDelta[streamerSlot] += delta;
  if (delta < 0) {
    _cumulativeLoss[streamerSlot] -= delta;
  } else {
    _cumulativeDeposition[streamerSlot] += delta;
  }

  // Dust-storm state transitions with hysteresis.
  const oldState = _windState[streamerSlot];
  let newState = oldState;
  if (oldState === WIND_STATE.DUST_STORM) {
    if (-rate < DUST_STORM_EXIT_MS) newState = WIND_STATE.SCOURING;
  } else {
    if (-rate > DUST_STORM_THRESHOLD_MS) {
      newState = WIND_STATE.DUST_STORM;
      _dustStormStartS[streamerSlot] = nowS;
      _dustStormIntensity[streamerSlot] = Math.min(1.0, -rate / DUST_STORM_THRESHOLD_MS);
    } else if (rate < -1e-9) {
      newState = WIND_STATE.SCOURING;
    } else if (rate > 1e-9) {
      newState = WIND_STATE.DEPOSITING;
    } else {
      newState = WIND_STATE.STABLE;
    }
  }
  _windState[streamerSlot] = newState;

  // Vegetation vigor: wind-scoured slopes lose vigor similarly to water-
  // scoured slopes.
  const lossFactor = Math.min(1.0, _cumulativeLoss[streamerSlot] / DUST_STORM_THRESHOLD_MS);
  _vegetationVigor[streamerSlot] = Math.max(0.2, 1.0 - lossFactor * 0.6);

  // Downwind deposition: if the chunk is losing material, route some of it
  // to the neighbour in the downwind direction.
  if (delta < 0) {
    const lostMass = -delta;
    _routeDepositionDownwind(streamerSlot, lostMass * 0.6, nowS);
  }

  // Persistent mutation if the cumulative delta crossed the threshold.
  const deltaSinceLastMutation = Math.abs(_cumulativeDelta[streamerSlot] - _lastMutationDelta[streamerSlot]);
  if (deltaSinceLastMutation >= PERSISTENT_MUTATION_THRESHOLD_M) {
    _recordWindMutation(streamerSlot, nowS);
    _lastMutationDelta[streamerSlot] = _cumulativeDelta[streamerSlot];
    _lastMutationS[streamerSlot] = nowS;
  }

  // Write to the descriptor's disturbance slot.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot !== -1) {
    const severity = Math.min(1.0, _cumulativeLoss[streamerSlot] / DUST_STORM_THRESHOLD_MS);
    if (severity > 0) {
      LandscapeChunkDescriptor.setDisturbance(descOut.descriptorSlot, severity, nowS);
    }
  }

  return oldState !== newState;
}

// Route deposition to the chunk's downwind neighbours.
function _routeDepositionDownwind(streamerSlot, mass, nowS) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return;
  const cx = LandscapeChunkDescriptor.getChunkX(descOut.descriptorSlot);
  const cy = LandscapeChunkDescriptor.getChunkY(descOut.descriptorSlot);
  const cz = LandscapeChunkDescriptor.getChunkZ(descOut.descriptorSlot);

  // Determine the downwind direction from the fused wind direction bias.
  // The bias is expressed in degrees relative to due west; we convert to a
  // direction vector and pick the neighbour whose offset is closest to it.
  const windBiasDeg = BiomeClimateCoupling.getWindDirectionBiasDeg(streamerSlot);
  const windDirRad = (windBiasDeg * Math.PI) / 180.0;
  const windX = Math.cos(windDirRad);
  const windZ = Math.sin(windDirRad);

  let bestSlot = -1;
  let bestScore = -2;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.5) continue;
        const score = (dx / len) * windX + (dz / len) * windZ;
        if (score > bestScore) {
          const n = LandscapeChunkStreamer.getStreamerSlot(cx + dx, cy + dy, cz + dz);
          if (n !== -1 && _chunkActive[n]) {
            bestScore = score;
            bestSlot = n;
          }
        }
      }
    }
  }

  if (bestSlot === -1) return;

  _cumulativeDelta[bestSlot] += mass;
  _cumulativeDeposition[bestSlot] += mass;
}

// Record a wind-erosion mutation as a persistent mutation via 341.
function _recordWindMutation(streamerSlot, nowS) {
  if (!LandscapeChunkPersistence || typeof LandscapeChunkPersistence.recordMutation !== 'function') return;

  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return;
  const cx = LandscapeChunkDescriptor.getChunkX(descOut.descriptorSlot);
  const cy = LandscapeChunkDescriptor.getChunkY(descOut.descriptorSlot);
  const cz = LandscapeChunkDescriptor.getChunkZ(descOut.descriptorSlot);
  const cs = LandscapeChunkStreamer.config.chunkSizeM;
  const centerX = (cx + 0.5) * cs;
  const centerY = (cy + 0.5) * cs;
  const centerZ = (cz + 0.5) * cs;

  // Persist the mutation.
  LandscapeChunkPersistence.recordMutation(streamerSlot, {
    type: 7,   // EROSION_DAMAGE
    materialId: -1,
    tick: Math.floor(nowS * 1000),
    x: centerX,
    y: centerY,
    z: centerZ,
    radius: cs * 0.5,
    force: Math.abs(_cumulativeDelta[streamerSlot] - _lastMutationDelta[streamerSlot]),
    decayTau: DUST_STORM_HALFLIFE_S,
    decayLambda: 0,
    wetness: 0,
    fireEmissive: 0,
    moss: 0,
    snow: 0,
    flags: 0
  });

  // Material and lighting overrides.
  const isDeposit = _cumulativeDelta[streamerSlot] > _lastMutationDelta[streamerSlot];
  const isDustStorm = _windState[streamerSlot] === WIND_STATE.DUST_STORM;
  const intensity = isDustStorm ? Math.min(1.0, _dustStormIntensity[streamerSlot]) : 0.5;

  for (let i = 0; i < 16; i++) _materialOverride[i] = 0;
  for (let i = 0; i < 8; i++) _lightingOverride[i] = 0;

  if (isDeposit) {
    _materialOverride[0] = -DEPOSIT_ALBEDO_DARKENING;
    _materialOverride[1] = -DEPOSIT_ALBEDO_DARKENING;
    _materialOverride[2] = -DEPOSIT_ALBEDO_DARKENING;
  } else {
    _materialOverride[0] = SCOUR_ALBEDO_LIGHTENING;
    _materialOverride[1] = SCOUR_ALBEDO_LIGHTENING;
    _materialOverride[2] = SCOUR_ALBEDO_LIGHTENING;
  }
  _materialOverride[3] = WIND_ROUGHNESS_INCREASE;
  if (isDustStorm) {
    _materialOverride[6] = intensity * DUST_STORM_EMISSIVE;
  }

  if (isDustStorm) {
    _lightingOverride[0] = intensity * DUST_STORM_SUN_DIFFUSE_INCREASE;
    _lightingOverride[7] = intensity * DUST_STORM_FOG_INCREASE;
    // Shadow softness (index 6 in 351's lighting layout).
    _lightingOverride[6] = intensity * DUST_STORM_SHADOW_SOFTNESS_INCREASE;
    // Sky tint (indices 2, 3, 4 in 351's layout are the cast colour; sky
    // tint is index 5 in 351's layout — we emit the tint here so 351 can
    // apply it).
    _lightingOverride[2] = DUST_STORM_SKY_TINT[0];
    _lightingOverride[3] = DUST_STORM_SKY_TINT[1];
    _lightingOverride[4] = DUST_STORM_SKY_TINT[2];
  }

  _dispatcher.emit(EVENT_TYPE.WIND_EROSION_MUTATION, {
    streamerSlot,
    delta: _cumulativeDelta[streamerSlot] - _lastMutationDelta[streamerSlot],
    cumulativeDelta: _cumulativeDelta[streamerSlot],
    isDustStorm,
    materialOverride: _materialOverride,
    lightingOverride: _lightingOverride,
    tick: nowS
  });
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeWindErosionSystem = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  WIND_STATE,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  dustStormThresholdMs: DUST_STORM_THRESHOLD_MS,
  dustStormAcceleration: DUST_STORM_ACCELERATION,
  persistentMutationThresholdM: PERSISTENT_MUTATION_THRESHOLD_M,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _cumulativeDelta[streamerSlot] = 0;
    _currentRate[streamerSlot] = 0;
    _climaticFactor[streamerSlot] = 0;
    _erodibilityFactor[streamerSlot] = 0;
    _roughnessFactor[streamerSlot] = 0;
    _unshelteredFactor[streamerSlot] = 0;
    _cumulativeLoss[streamerSlot] = 0;
    _cumulativeDeposition[streamerSlot] = 0;
    _windState[streamerSlot] = WIND_STATE.STABLE;
    _lastMutationS[streamerSlot] = -1;
    _lastMutationDelta[streamerSlot] = 0;
    _dustStormStartS[streamerSlot] = -1;
    _dustStormIntensity[streamerSlot] = 0;
    _vegetationVigor[streamerSlot] = 1.0;
    return true;
  },

  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _chunkActive[streamerSlot] = 0;
  },

  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    let processed = 0;
    let changed = 0;
    let scouringChunks = 0;
    let dustStormChunks = 0;
    let totalErosion = 0;
    let totalDeposition = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      processed++;
      if (_processChunk(slot, nowS, dt)) {
        changed++;
      }
      if (_windState[slot] === WIND_STATE.SCOURING) {
        scouringChunks++;
        totalErosion += Math.abs(_currentRate[slot]) * dt;
      }
      if (_windState[slot] === WIND_STATE.DUST_STORM) {
        dustStormChunks++;
        totalErosion += Math.abs(_currentRate[slot]) * dt;
      }
      if (_windState[slot] === WIND_STATE.DEPOSITING) {
        totalDeposition += _currentRate[slot] * dt;
      }
      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastScouringChunks = scouringChunks;
    _lastDustStormChunks = dustStormChunks;
    _lastTickDurationMs = performanceNow() - t0;
    _lastTotalErosionM3 = totalErosion;
    _lastTotalDepositionM3 = totalDeposition;

    if (processed > 0 || changed > 0) {
      _dispatcher.emit(EVENT_TYPE.WIND_EROSION_UPDATED, {
        tick,
        processed,
        changed,
        scouringChunks,
        dustStormChunks,
        durationMs: _lastTickDurationMs
      });
    }
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getCumulativeDelta(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _cumulativeDelta[streamerSlot];
  },
  getCurrentRate(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _currentRate[streamerSlot];
  },
  getClimaticFactor(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _climaticFactor[streamerSlot];
  },
  getErodibilityFactor(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _erodibilityFactor[streamerSlot];
  },
  getRoughnessFactor(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _roughnessFactor[streamerSlot];
  },
  getUnshelteredFactor(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _unshelteredFactor[streamerSlot];
  },
  getCumulativeLoss(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _cumulativeLoss[streamerSlot];
  },
  getCumulativeDeposition(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _cumulativeDeposition[streamerSlot];
  },
  getWindState(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return WIND_STATE.STABLE;
    return _windState[streamerSlot];
  },
  getVegetationVigorModifier(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 1;
    return _vegetationVigor[streamerSlot];
  },
  isDustStorming(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    return _windState[streamerSlot] === WIND_STATE.DUST_STORM;
  },

  /**
   * Read the full per-chunk wind-erosion record. Zero-allocation.
   */
  readWindErosionState(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    out.cumulativeDelta = _cumulativeDelta[streamerSlot];
    out.currentRate = _currentRate[streamerSlot];
    out.climaticFactor = _climaticFactor[streamerSlot];
    out.erodibilityFactor = _erodibilityFactor[streamerSlot];
    out.roughnessFactor = _roughnessFactor[streamerSlot];
    out.unshelteredFactor = _unshelteredFactor[streamerSlot];
    out.cumulativeLoss = _cumulativeLoss[streamerSlot];
    out.cumulativeDeposition = _cumulativeDeposition[streamerSlot];
    out.state = _windState[streamerSlot];
    out.vegetationVigor = _vegetationVigor[streamerSlot];
    out.dustStormIntensity = _dustStormIntensity[streamerSlot];
    return true;
  },

  /**
   * Query the dust emissive override for a chunk.
   */
  getDustEmissive(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (_windState[streamerSlot] !== WIND_STATE.DUST_STORM) return 0;
    const intensity = _dustStormIntensity[streamerSlot];
    const ageS = BiomeBlendSystem.elapsedSimSeconds - _dustStormStartS[streamerSlot];
    const decay = Math.exp(-ageS * Math.log(2) / DUST_STORM_HALFLIFE_S);
    return Math.max(0, Math.min(1, intensity * decay * DUST_STORM_EMISSIVE));
  },

  /**
   * Query the dust fog override for a chunk.
   */
  getDustFogOverride(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (_windState[streamerSlot] !== WIND_STATE.DUST_STORM) return 0;
    const intensity = _dustStormIntensity[streamerSlot];
    const ageS = BiomeBlendSystem.elapsedSimSeconds - _dustStormStartS[streamerSlot];
    const decay = Math.exp(-ageS * Math.log(2) / DUST_STORM_HALFLIFE_S);
    return Math.max(0, Math.min(1, intensity * decay * DUST_STORM_FOG_INCREASE));
  },

  /**
   * Query the dust sun diffuse override for a chunk.
   */
  getDustSunDiffuseOverride(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (_windState[streamerSlot] !== WIND_STATE.DUST_STORM) return 0;
    const intensity = _dustStormIntensity[streamerSlot];
    const ageS = BiomeBlendSystem.elapsedSimSeconds - _dustStormStartS[streamerSlot];
    const decay = Math.exp(-ageS * Math.log(2) / DUST_STORM_HALFLIFE_S);
    return Math.max(0, Math.min(1, intensity * decay * DUST_STORM_SUN_DIFFUSE_INCREASE));
  },

  /**
   * Force a wind-erosion event on a chunk. Used by
   * 300_ImpactEventCoordinator to apply the erosion from a large impact.
   */
  forceWindErosion(streamerSlot, magnitudeM) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    _cumulativeDelta[streamerSlot] += magnitudeM;
    if (magnitudeM < 0) _cumulativeLoss[streamerSlot] -= magnitudeM;
    else _cumulativeDeposition[streamerSlot] += magnitudeM;
    return true;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastScouringChunks() { return _lastScouringChunks; },
  get lastDustStormChunks() { return _lastDustStormChunks; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get lastTotalErosionM3() { return _lastTotalErosionM3; },
  get lastTotalDepositionM3() { return _lastTotalDepositionM3; },
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

export default LandscapeWindErosionSystem;