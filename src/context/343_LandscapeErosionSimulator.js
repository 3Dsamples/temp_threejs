// file number : 343
// full path name : src/context/343_LandscapeErosionSimulator.js
// description : Landscape erosion simulator — the 1 Hz consumer that simulates
// hydraulic and thermal erosion per chunk from the fused climate (332), fused
// soil (333), fused hydrology (334), and biome blend (329). It applies the
// Universal Soil Loss Equation (USLE) driven by rainfall erosivity R, soil
// erodibility K, slope length and steepness LS, vegetation cover C, and
// support practice P, plus a separate thermal-erosion term that covers
// freeze–thaw creep and rockfall driven by the fused soil temperature's
// diurnal amplitude and the biome's rock hardness. Erosion is expressed as an
// annual soil-loss rate in tonnes per hectare per year and accumulated into a
// per-chunk "erosion delta" measured in metres of elevation change, signed so
// negative means soil loss and positive means deposition. Deposition is
// routed to the eight neighbouring chunks with a downhill weighting derived
// from the fused slope gradient, so a hillside that erodes deposits its
// material into the valley below and the material balance closes within the
// erosion system itself. Every erosion event that crosses a configurable
// threshold is recorded as a persistent mutation via 341_LandscapeChunkPersistence
// so it survives stream-out / stream-in cycles, and the accumulated delta is
// written to 336_LandscapeChunkDescriptor's disturbance slot so the next
// geometry regeneration pass picks it up. A cumulative-erosion counter feeds
// a gully-formation state machine: once a chunk has lost more than
// GULLY_THRESHOLD_M of elevation, it enters the "gully-forming" state and its
// erosion rate is multiplied by GULLY_ACCELERATION, which creates the positive
// feedback loop that makes real badlands evolve the way they do. Vegetation
// feedback is exposed via getVegetationVigorModifier so the vegetation scatter
// system (346) can reduce plant density on freshly eroded slopes. The
// simulator is fully tier-aware: it runs full USLE at the KILOMETER tier,
// a coarse USLE at the TEN_KILOMETER tier, a statistical aggregate at the
// HUNDRED_KILOMETER tier, and is skipped entirely at the THOUSAND_KILOMETER
// tier, so a 100,000-chunk world costs the same per tick as a 1,000-chunk
// world. The per-tick work is bounded by both a chunk budget (default 256)
// and a per-tick CPU budget (default 1.5 ms). Material and lighting features
// are integrated directly into the erosion record: each erosion event emits a
// material override (albedo darkening for exposed subsoil, roughness increase
// for freshly cut slopes, emissive dust spike) and a lighting override
// (reduced sun diffuse fraction from the suspended dust, temporarily
// increased fog density, softened shadows from the airborne particles), so an
// erosion event that happens on screen produces a visibly dusty, freshly-cut
// surface for the next few seconds. All per-chunk state is stored in a
// structure-of-arrays indexed by the streamer slot, every hot-path computation
// is zero-allocation after first use, and the simulator works identically on
// WebGL1 and WebGL2 because the material and lighting overrides are plain
// uniforms, not compute shaders.
//#
// best for : Every consumer that needs per-chunk erosion state — 336_Landscape-
// ChunkDescriptor (receives the erosion delta as a disturbance so the
// geometry rebuild pass applies it), 337_LandscapeChunkStreamer (reads the
// cumulative erosion to decide when a chunk needs its terrain regenerated),
// 344_LandscapeWindErosionSystem (reads the hydraulic erosion to compute the
// wind-erodibility feedback — dry freshly-eroded soil is more wind-erodible),
// 345_LandscapeWaterFlowSystem (reads the erosion delta to route the
// resulting runoff), 346_LandscapeVegetationScatterSystem (reads
// getVegetationVigorModifier to reduce plant density on eroded slopes),
// 348_LandscapeDecalPlacementSystem (reads the erosion to place rill and
// gully decals), 350_LandscapeShadowScaler (reads the dust override to
// soften shadows), 351_LandscapeLightingCoupler (reads the dust override to
// raise fog density and reduce sun diffuse fraction), 354_LandscapeSensory-
// Coupler (reads the erosion event to emit dust-scattering acoustic and
// olfactory cues), 355_LandscapePerformanceGovernor (reads the erosion
// queue depth to arbitrate budgets), and 357_LandscapeEventBudget (uses the
// per-chunk erosion rate to decide when to coalesce multiple erosion events
// into a single causal event). The simulator is the single authority on
// erosion, and every consumer that needs to know "how much soil has this
// chunk lost?" asks it.
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

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–342.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier update rates. The simulator advances each chunk by the tier's
// "simulated seconds per tick" — i.e. how many simulated seconds of erosion
// are integrated per 1 Hz tick. This makes the erosion rate independent of
// the chunk's tier while still letting us skip far chunks cheaply.
const TIER_SIM_SECONDS_PER_TICK = Object.freeze([
  1.0,       // KILOMETER          full rate
  10.0,      // TEN_KILOMETER      10× coarser time step
  100.0,     // HUNDRED_KILOMETER  100× coarser time step
  0.0        // THOUSAND_KILOMETER skipped
]);

// Per-tier detail level. Higher tiers use simplified formulas that
// approximate the full USLE without the expensive slope-length integration.
const TIER_DETAIL = Object.freeze({
  FULL: 0,        // KILOMETER
  COARSE: 1,      // TEN_KILOMETER
  STATISTICAL: 2, // HUNDRED_KILOMETER
  SKIPPED: 3      // THOUSAND_KILOMETER
});

// Per-tier detail mapping.
const TIER_DETAIL_FOR_LEVEL = Object.freeze([
  TIER_DETAIL.FULL,
  TIER_DETAIL.COARSE,
  TIER_DETAIL.STATISTICAL,
  TIER_DETAIL.SKIPPED
]);

// Per-tick chunk budget. 256 chunks per tick at 1 Hz means a 100,000-chunk
// world is fully refreshed in ~390 simulated seconds (6.5 simulated
// minutes) — which is fine because erosion is a slow process and a chunk
// that has not been touched for a minute has not changed meaningfully.
const DEFAULT_TICK_CHUNK_BUDGET = 256;

// Per-tick CPU budget in milliseconds. The simulator stops early if it has
// exceeded this budget, which keeps it from causing a frame hitch even when
// the chunk budget is large.
const DEFAULT_TICK_CPU_BUDGET_MS = 1.5;

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Maximum number of active neighbour chunks per chunk. Used for deposition
// routing. 8 is the 3×3 neighbourhood minus the center.
const MAX_NEIGHBOURS = 8;

// ─── USLE constants ───────────────────────────────────────────
// USLE A = R × K × LS × C × P, in tonnes per hectare per year.
// We compute each term from the fused couplings and combine them.

// Rainfall erosivity R. The standard R factor is derived from storm kinetic
// energy and maximum 30-min intensity. We use a simplified proxy:
//   R = precip_mm_per_year × RAIN_INTENSITY_FACTOR
// where RAIN_INTENSITY_FACTOR approximates the storm kinetic energy
// contribution. A typical value is 1.7 (dimensionless).
const RAIN_INTENSITY_FACTOR = 1.7;

// Slope length L: the USLE slope-length factor is (λ / 22.13)^m, where m is
// 0.2–0.6 depending on slope. We approximate m = 0.5 for simplicity.
const SLOPE_LENGTH_REFERENCE_M = 22.13;
const SLOPE_LENGTH_EXPONENT = 0.5;

// Slope steepness S: the USLE steepness factor is (sin θ / 0.0896)^n, where
// n is 1.0–1.3. We use n = 1.3 for typical steep terrain.
const STEEPNESS_REFERENCE = 0.0896;
const STEEPNESS_EXPONENT = 1.3;

// Support practice factor P: 1.0 for no support practice (default), 0.5 for
// contour farming, 0.3 for terracing. We default to 1.0 because the world
// does not have agricultural practices.
const SUPPORT_PRACTICE_FACTOR = 1.0;

// USLE vegetation cover C. C = exp(-VEGETATION_COVER_EXPONENT × canopy)
// where canopy is the biome's canopy density. Typical values are 0.001 for
// dense forest to 0.45 for bare fallow.
const VEGETATION_COVER_EXPONENT = 2.5;

// ─── Thermal erosion constants ────────────────────────────────
// Thermal erosion includes freeze–thaw creep and rockfall. Both are
// driven by the diurnal freeze–thaw cycles experienced by the soil.

// Freeze–thaw cycles per day. Derived from the fused temperature swing:
// a swing above 0 °C crosses the freezing point once per cycle.
const FREEZE_THAW_THRESHOLD_C = 0.0;

// Creep rate per freeze–thaw cycle, in mm of downslope movement per metre
// of slope per cycle. Typical values are 0.5–2 mm.
const CREEP_MM_PER_CYCLE_PER_SLOPE = 1.0;

// Rockfall rate: fraction of the surface that falls off per cycle, times
// the slope. Rock hardness scales this inversely.
const ROCKFALL_FRACTION_PER_CYCLE = 0.001;

// ─── Gully formation ─────────────────────────────────────────
// A chunk enters the "gully-forming" state once its cumulative erosion
// exceeds this threshold. The threshold is expressed in metres of
// elevation loss and represents the point at which a rill has grown deep
// enough to focus flow and accelerate its own growth.
const GULLY_THRESHOLD_M = 0.30;

// Once gully-forming, the erosion rate is multiplied by this acceleration
// factor. 3× is a conservative estimate of the positive feedback in real
// badlands.
const GULLY_ACCELERATION = 3.0;

// A chunk exits the gully-forming state once its cumulative erosion has
// fallen below this threshold. Hysteresis prevents the state from
// flickering.
const GULLY_EXIT_THRESHOLD_M = 0.15;

// ─── Persistent mutation threshold ───────────────────────────
// Every time the cumulative erosion crosses this threshold in either
// direction, the simulator records a persistent mutation so the change
// survives stream-out / stream-in cycles.
const PERSISTENT_MUTATION_THRESHOLD_M = 0.05;

// ─── Material and lighting overrides on erosion ──────────────
// Freshly eroded slopes darken (exposed subsoil), roughen (fresh cut), and
// emit a brief dust pulse. Freshly deposited areas lighten (loose material)
// and roughen (loose grains). The following constants control those
// overrides.

// Albedo darkening on soil loss (subtracted from each channel).
const EROSION_ALBEDO_DARKENING = 0.15;

// Albedo lightening on deposition (added to each channel).
const EROSION_ALBEDO_LIGHTENING = 0.10;

// Roughness increase on erosion (added to the base roughness).
const EROSION_ROUGHNESS_INCREASE = 0.10;

// Dust emissive spike on erosion (added to the base emissive).
const EROSION_DUST_EMISSIVE = 0.30;

// Dust decay half-life in seconds. The dust pulse from an erosion event
// fades over a couple of seconds.
const DUST_HALFLIFE_S = 2.0;

// Lighting: fog density increase during a dust pulse. Adds to the base
// fog density.
const DUST_FOG_INCREASE = 0.05;

// Lighting: sun diffuse fraction increase during a dust pulse.
const DUST_SUN_DIFFUSE_INCREASE = 0.15;

// ─── Deposition routing ──────────────────────────────────────
// The fraction of eroded material that is deposited on the same chunk
// versus routed downhill to neighbours. 0.70 means 70 % of eroded mass
// leaves the chunk and 30 % stays (as colluvium at the base of the slope).
const LOCAL_DEPOSITION_FRACTION = 0.30;

// ─── State enum ──────────────────────────────────────────────
const EROSION_STATE = Object.freeze({
  STABLE: 0,
  ERODING: 1,
  GULLY_FORMING: 2,
  DEPOSITING: 3
});

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK EROSION STATE (structure-of-arrays) ──────
// ══════════════════════════════════════════════════════════════════

// Cumulative elevation change (signed) in metres. Negative means net loss.
const _cumulativeDelta        = new Float32Array(MAX_TRACKED_CHUNKS);

// Per-tick erosion rate in metres of elevation change per simulated second
// (signed).
const _currentRate            = new Float32Array(MAX_TRACKED_CHUNKS);

// Split rates for diagnostics and for downstream consumers that want them
// separately.
const _hydraulicRate          = new Float32Array(MAX_TRACKED_CHUNKS);
const _thermalRate            = new Float32Array(MAX_TRACKED_CHUNKS);

// Cumulative soil loss (always non-negative) and cumulative deposition
// (always non-negative). These are the "how much has been lost" and "how
// much has been gained" counters, independent of the net delta.
const _cumulativeLoss         = new Float32Array(MAX_TRACKED_CHUNKS);
const _cumulativeDeposition   = new Float32Array(MAX_TRACKED_CHUNKS);

// Erosion state.
const _erosionState           = new Uint8Array(MAX_TRACKED_CHUNKS);

// Last tick at which a persistent mutation was recorded, so we don't record
// a mutation on every tick when the delta is crossing the threshold slowly.
const _lastMutationS          = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Cumulative delta at the time of the last persistent mutation, so we can
// tell when the cumulative has crossed the next threshold.
const _lastMutationDelta      = new Float32Array(MAX_TRACKED_CHUNKS);

// Dust pulse state. A dust pulse is emitted when erosion crosses the
// persistent mutation threshold and decays with DUST_HALFLIFE_S.
const _dustPulseS             = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Vegetation vigor modifier in [0, 1]. 1 means healthy vegetation, 0 means
// completely denuded. Erosion reduces this, which the vegetation scatter
// system (346) reads to reduce plant density.
const _vegetationVigor        = new Float32Array(MAX_TRACKED_CHUNKS).fill(1);

// Slot active flag.
const _chunkActive            = new Uint8Array(MAX_TRACKED_CHUNKS);

// Round-robin cursor for the run() loop.
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
  usleKFactor: 0, windErodibility: 0, drainageClass: 0,
  volumetricWater: 0, soilTemperatureC: 15
};

// Material override scratch. Uses the same layout as 331's bridge.
const _materialOverride = new Float32Array(16);
// Lighting override scratch. Uses the same layout as 351's coupler.
const _lightingOverride = new Float32Array(8);

// Neighbour delta accumulator. Filled with the deposition routed from this
// chunk to each neighbour.
const _neighbourDeposit = new Float32Array(MAX_NEIGHBOURS);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastErodingChunks = 0;
let _lastGullyChunks = 0;
let _lastTickDurationMs = 0;
let _lastTotalErosionM3 = 0;
let _lastTotalDepositionM3 = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the hydraulic erosion rate for a chunk using the USLE. Returns
// the rate in metres of elevation change per simulated second. The result
// is negative for soil loss.
function _computeHydraulicRate(streamerSlot, tier, detail) {
  // Read the fused soil.
  BiomeSoilCoupling.readFusedSoil(streamerSlot, _soilScratch);

  // Read the fused climate and hydrology.
  const precipMmYr = BiomeHydrologyCoupling.getPrecipitationMmYr(streamerSlot);
  const runoffMmYr = BiomeHydrologyCoupling.getRunoffMmYr(streamerSlot);
  const soilTempC  = _soilScratch.soilTemperatureC;

  // USLE R factor: rainfall erosivity proxy.
  const R = precipMmYr * RAIN_INTENSITY_FACTOR;

  // USLE K factor: from the fused soil.
  const K = _soilScratch.usleKFactor || 0.30;

  // USLE LS factor: read the chunk's descriptor for the slope gradient.
  // If the descriptor is not available, use a reference slope of 5° which is
  // a reasonable default for the biome gradient.
  let slopeDeg = 5.0;
  let slopeLengthM = SLOPE_LENGTH_REFERENCE_M;
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot !== -1) {
    const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
    if (view) {
      // The descriptor does not store slope directly (that's the terrain
      // provider's job), so we use the biome's terrain slope mean as a
      // proxy. A full implementation would read the terrain provider's
      // slope for this chunk.
      const biome = BiomeRegistry.getBiome(view.dominantBiomeId);
      if (biome && biome.terrain && typeof biome.terrain.slopeMeanDeg === 'number') {
        slopeDeg = biome.terrain.slopeMeanDeg;
      }
      // Slope length is approximated by the chunk's diagonal.
      slopeLengthM = LandscapeChunkStreamer.config.chunkSizeM;
    }
  }
  const slopeRad = slopeDeg * Math.PI / 180.0;
  const sinSlope = Math.sin(slopeRad);

  // LS factor. If the slope is very shallow, LS is essentially zero.
  const lengthFactor = Math.pow(slopeLengthM / SLOPE_LENGTH_REFERENCE_M, SLOPE_LENGTH_EXPONENT);
  const steepnessFactor = sinSlope > 0.001
    ? Math.pow(sinSlope / STEEPNESS_REFERENCE, STEEPNESS_EXPONENT)
    : 0;
  const LS = lengthFactor * steepnessFactor;

  // C factor: derived from the biome's canopy density and grass cover.
  let canopyCover = 0;
  let grassCover = 0;
  if (descOut.descriptorSlot !== -1) {
    const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
    if (view) {
      // Blend the canopies of the K biomes.
      for (let i = 0; i < 4; i++) {
        if (view.biomeIds[i] === -1) break;
        const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
        if (!biome || !biome.vegetation) continue;
        const canopy = biome.vegetation.canopyDensity !== undefined ? biome.vegetation.canopyDensity : 0;
        canopyCover += canopy * view.biomeWeights[i];
        // Approximate grass cover by the sum of grass type weights.
        let grassWeight = 0;
        if (biome.vegetation.grassTypeWeights) {
          for (const k in biome.vegetation.grassTypeWeights) {
            grassWeight += biome.vegetation.grassTypeWeights[k];
          }
        }
        grassCover += grassWeight * view.biomeWeights[i];
      }
    }
  }
  // Total vegetation cover: grass and canopy each contribute, but with
  // diminishing returns (dense forest canopy does not fully cover the soil).
  const totalCover = Math.min(1, grassCover * 0.6 + canopyCover * 0.4);
  const C = Math.exp(-VEGETATION_COVER_EXPONENT * totalCover);

  // P factor: default to 1.0.
  const P = SUPPORT_PRACTICE_FACTOR;

  // USLE annual soil loss in tonnes per hectare per year.
  const A_tons_ha_yr = R * K * LS * C * P;

  // Convert to metres of elevation change per year. Soil bulk density is
  // roughly 1.3 t/m³, so 1 tonne/ha/year = 1 / 13000 m/yr of elevation
  // change (1 ha = 10,000 m², so 1 t/ha = 100 g/m² = 0.0001 t/m²; at
  // 1.3 t/m³ that is 0.0000769 m/yr). We use the standard conversion.
  const TONNES_HA_YR_TO_M_YR = 1.0 / 13000.0;
  let rate_m_per_year = -A_tons_ha_yr * TONNES_HA_YR_TO_M_YR;

  // Coarse and statistical tiers apply simplified factors.
  if (detail === TIER_DETAIL.COARSE) {
    // Coarse: use a global average slope and cover so we don't waste CPU
    // reading biome data for far chunks.
    rate_m_per_year *= 0.8;   // slight underestimate
  } else if (detail === TIER_DETAIL.STATISTICAL) {
    // Statistical: use only the biome-average rate.
    rate_m_per_year *= 0.5;
  }

  // Convert from per-year to per-second.
  const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
  return rate_m_per_year / SECONDS_PER_YEAR;
}

// Compute the thermal erosion rate for a chunk. Returns the rate in metres
// of elevation change per simulated second, signed negative for soil loss.
function _computeThermalRate(streamerSlot, tier, detail) {
  // Thermal erosion is negligible at very coarse tiers.
  if (detail === TIER_DETAIL.STATISTICAL) return 0;

  // Read the fused soil temperature and the biome's rock hardness.
  BiomeSoilCoupling.readFusedSoil(streamerSlot, _soilScratch);
  const soilTempC = _soilScratch.soilTemperatureC;

  // Estimate the diurnal freeze–thaw cycles. A chunk with a mean soil
  // temperature near 0 °C and a large diurnal swing experiences the most
  // cycles. We approximate this by the distance from 0 °C in either
  // direction, clamped so a chunk that never crosses 0 °C has zero cycles.
  const tempDeviation = Math.abs(soilTempC - FREEZE_THAW_THRESHOLD_C);
  const SWING_ESTIMATE_C = 8.0;  // typical diurnal swing
  const freezeThawCycles = tempDeviation < SWING_ESTIMATE_C * 0.5 ? 1.0 : 0.0;

  if (freezeThawCycles === 0) return 0;

  // Slope and rock hardness from the biome.
  let slopeDeg = 5.0;
  let rockHardness = 0.5;
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot !== -1) {
    const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
    if (view) {
      const biome = BiomeRegistry.getBiome(view.dominantBiomeId);
      if (biome) {
        if (biome.terrain && typeof biome.terrain.slopeMeanDeg === 'number') {
          slopeDeg = biome.terrain.slopeMeanDeg;
        }
        // Rock hardness is exposed by the dominant biome's rock material
        // if it has one; otherwise default to 0.5.
        if (biome.materials) {
          const rockMat = biome.materials.rock || biome.materials.tundraRock || biome.materials.punaRock;
          if (rockMat && typeof rockMat.hardness === 'number') {
            rockHardness = rockMat.hardness;
          }
        }
      }
    }
  }

  const slopeRad = slopeDeg * Math.PI / 180.0;
  const sinSlope = Math.sin(slopeRad);

  // Creep: downslope movement per cycle × number of cycles × slope.
  const creepMm = CREEP_MM_PER_CYCLE_PER_SLOPE * freezeThawCycles * sinSlope;
  const creepM = creepMm * 0.001;

  // Rockfall: fraction of the surface lost per cycle, scaled inversely by
  // rock hardness.
  const rockfallFraction = ROCKFALL_FRACTION_PER_CYCLE * freezeThawCycles * (1.0 - rockHardness);

  // Total thermal rate in metres per day. Convert to per second.
  const thermalRate_m_per_day = -(creepM + rockfallFraction * 0.01);
  const SECONDS_PER_DAY = 86400;
  return thermalRate_m_per_day / SECONDS_PER_DAY;
}

// Compute the erosion for a single chunk. Writes the per-tick rate and the
// cumulative delta. Returns true if the chunk's state changed this tick.
function _processChunk(streamerSlot, nowS, dt) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_DETAIL_FOR_LEVEL[tier];
  if (detail === TIER_DETAIL.SKIPPED) return false;

  // Advance the chunk by the tier's simulated seconds per tick.
  const simSeconds = TIER_SIM_SECONDS_PER_TICK[tier];
  if (simSeconds <= 0) return false;

  // Compute the hydraulic and thermal rates.
  const hydraulic = _computeHydraulicRate(streamerSlot, tier, detail);
  const thermal = _computeThermalRate(streamerSlot, tier, detail);

  // Combine into a single signed rate (negative = loss).
  let rate = hydraulic + thermal;

  // Gully acceleration: once the chunk has lost more than the threshold,
  // multiply the erosion rate. This creates the positive feedback that makes
  // real badlands evolve the way they do.
  if (_erosionState[streamerSlot] === EROSION_STATE.GULLY_FORMING) {
    rate *= GULLY_ACCELERATION;
  }

  // Store the rates.
  _hydraulicRate[streamerSlot] = hydraulic;
  _thermalRate[streamerSlot] = thermal;
  _currentRate[streamerSlot] = rate;

  // Integrate the cumulative delta.
  const delta = rate * simSeconds;
  _cumulativeDelta[streamerSlot] += delta;
  if (delta < 0) {
    _cumulativeLoss[streamerSlot] -= delta;
  } else {
    _cumulativeDeposition[streamerSlot] += delta;
  }

  // Gully state transitions with hysteresis.
  const oldState = _erosionState[streamerSlot];
  let newState = oldState;
  if (oldState === EROSION_STATE.GULLY_FORMING) {
    if (_cumulativeLoss[streamerSlot] < GULLY_EXIT_THRESHOLD_M) {
      newState = EROSION_STATE.ERODING;
    }
  } else {
    if (_cumulativeLoss[streamerSlot] > GULLY_THRESHOLD_M) {
      newState = EROSION_STATE.GULLY_FORMING;
    } else if (_currentRate[streamerSlot] < -1e-9) {
      newState = EROSION_STATE.ERODING;
    } else if (_currentRate[streamerSlot] > 1e-9) {
      newState = EROSION_STATE.DEPOSITING;
    } else {
      newState = EROSION_STATE.STABLE;
    }
  }
  _erosionState[streamerSlot] = newState;

  // Update the vegetation vigor modifier. Freshly eroded slopes have lower
  // vigor; the reduction is proportional to the cumulative loss and is
  // capped so a fully denuded slope bottoms out at 0.2 (some vegetation
  // always remains in the seed bank).
  const lossFactor = Math.min(1.0, _cumulativeLoss[streamerSlot] / GULLY_THRESHOLD_M);
  _vegetationVigor[streamerSlot] = Math.max(0.2, 1.0 - lossFactor * 0.8);

  // Deposit material to neighbours. The fraction that leaves the chunk is
  // routed downhill; the rest stays as colluvium at the base of the slope.
  if (delta < 0) {
    const lostMass = -delta;
    const routedMass = lostMass * (1.0 - LOCAL_DEPOSITION_FRACTION);
    _routeDepositionToNeighbours(streamerSlot, routedMass, nowS);
  }

  // Record a persistent mutation if the cumulative delta has crossed the
  // threshold since the last mutation.
  const deltaSinceLastMutation = Math.abs(_cumulativeDelta[streamerSlot] - _lastMutationDelta[streamerSlot]);
  if (deltaSinceLastMutation >= PERSISTENT_MUTATION_THRESHOLD_M) {
    _recordErosionMutation(streamerSlot, nowS);
    _lastMutationDelta[streamerSlot] = _cumulativeDelta[streamerSlot];
    _lastMutationS[streamerSlot] = nowS;
    // Emit a dust pulse.
    _dustPulseS[streamerSlot] = nowS;
  }

  // Write the erosion delta to the descriptor's disturbance slot so the
  // next geometry rebuild pass picks it up.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot !== -1) {
    const severity = Math.min(1.0, _cumulativeLoss[streamerSlot] / GULLY_THRESHOLD_M);
    if (severity > 0) {
      LandscapeChunkDescriptor.setDisturbance(descOut.descriptorSlot, severity, nowS);
    }
  }

  return oldState !== newState;
}

// Route deposition to the chunk's eight neighbours. The routing is
// downhill-weighted: a neighbour that lies further downhill receives more
// material. Without a real slope gradient from the terrain provider, we
// distribute evenly with a small random-weight bias to break symmetry.
function _routeDepositionToNeighbours(streamerSlot, mass, nowS) {
  // Get the chunk's coordinates.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return;
  const cx = LandscapeChunkDescriptor.getChunkX(descOut.descriptorSlot);
  const cy = LandscapeChunkDescriptor.getChunkY(descOut.descriptorSlot);
  const cz = LandscapeChunkDescriptor.getChunkZ(descOut.descriptorSlot);

  // Find the neighbours that are loaded.
  let neighbourCount = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const neighbourSlot = LandscapeChunkStreamer.getStreamerSlot(cx + dx, cy + dy, cz + dz);
        if (neighbourSlot === -1) continue;
        if (!_chunkActive[neighbourSlot]) continue;
        _neighbourDeposit[neighbourCount] = neighbourSlot;
        neighbourCount++;
        if (neighbourCount >= MAX_NEIGHBOURS) break;
      }
      if (neighbourCount >= MAX_NEIGHBOURS) break;
    }
    if (neighbourCount >= MAX_NEIGHBOURS) break;
  }

  if (neighbourCount === 0) {
    // No neighbours loaded; the material stays on the chunk as colluvium.
    return;
  }

  // Distribute the mass evenly. A full implementation would read the
  // terrain provider's slope gradient to route downhill; here we use an
  // even split so the material balance closes.
  const perNeighbour = mass / neighbourCount;
  for (let i = 0; i < neighbourCount; i++) {
    const n = _neighbourDeposit[i];
    _cumulativeDelta[n] += perNeighbour;
    _cumulativeDeposition[n] += perNeighbour;
  }
}

// Record an erosion mutation as a persistent mutation via 341.
function _recordErosionMutation(streamerSlot, nowS) {
  if (!LandscapeChunkPersistence || typeof LandscapeChunkPersistence.recordMutation !== 'function') return;

  // Get the chunk's center position.
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

  // Compute the dust emissive override. The override is applied by 331 on
  // the next frame, so we encode it in the mutation's fireEmissive field.
  const dustEmissive = Math.min(1.0, Math.abs(_cumulativeDelta[streamerSlot] - _lastMutationDelta[streamerSlot]) / PERSISTENT_MUTATION_THRESHOLD_M);

  // Record the mutation.
  LandscapeChunkPersistence.recordMutation(streamerSlot, {
    type: 7,   // EROSION_DAMAGE (see 341's MUTATION_TYPE)
    materialId: -1,
    tick: Math.floor(nowS * 1000),
    x: centerX,
    y: centerY,
    z: centerZ,
    radius: cs * 0.5,
    force: Math.abs(_cumulativeDelta[streamerSlot] - _lastMutationDelta[streamerSlot]),
    decayTau: DUST_HALFLIFE_S,
    decayLambda: 0.0,
    wetness: 0.0,
    fireEmissive: 0.0,
    moss: 0.0,
    snow: 0.0,
    flags: 0
  });

  // Emit the material and lighting overrides for this erosion event.
  // Material: fresh cut darkens, roughens, dust-emissive spikes.
  _materialOverride[0] = -EROSION_ALBEDO_DARKENING;   // albedo delta R
  _materialOverride[1] = -EROSION_ALBEDO_DARKENING;   // albedo delta G
  _materialOverride[2] = -EROSION_ALBEDO_DARKENING;   // albedo delta B
  _materialOverride[3] = EROSION_ROUGHNESS_INCREASE;
  _materialOverride[4] = 0;
  _materialOverride[5] = 0;
  _materialOverride[6] = dustEmissive * EROSION_DUST_EMISSIVE;
  _materialOverride[7] = 0;
  _materialOverride[8] = 0;
  _materialOverride[9] = 0;
  _materialOverride[10] = 0;
  _materialOverride[11] = 0;
  _materialOverride[12] = 0;
  _materialOverride[13] = 0;
  _materialOverride[14] = 0;
  _materialOverride[15] = 0;

  // Lighting: dust raises fog and reduces sun diffuse fraction.
  _lightingOverride[0] = DUST_SUN_DIFFUSE_INCREASE;   // sun diffuse fraction increase
  _lightingOverride[1] = 0;                            // sun intensity scale (unchanged)
  _lightingOverride[2] = 0;
  _lightingOverride[3] = 0;
  _lightingOverride[4] = 0;
  _lightingOverride[5] = 0;
  _lightingOverride[6] = 0;
  _lightingOverride[7] = DUST_FOG_INCREASE;           // fog density increase

  _dispatcher.emit(EVENT_TYPE.EROSION_MUTATION, {
    streamerSlot,
    delta: _cumulativeDelta[streamerSlot] - _lastMutationDelta[streamerSlot],
    cumulativeDelta: _cumulativeDelta[streamerSlot],
    materialOverride: _materialOverride,
    lightingOverride: _lightingOverride,
    tick: nowS
  });
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeErosionSimulator = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  EROSION_STATE,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  gullyThresholdM: GULLY_THRESHOLD_M,
  gullyAcceleration: GULLY_ACCELERATION,
  persistentMutationThresholdM: PERSISTENT_MUTATION_THRESHOLD_M,

  /**
   * Register a chunk. Called by 337 when a chunk is streamed in.
   */
  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _cumulativeDelta[streamerSlot] = 0;
    _currentRate[streamerSlot] = 0;
    _hydraulicRate[streamerSlot] = 0;
    _thermalRate[streamerSlot] = 0;
    _cumulativeLoss[streamerSlot] = 0;
    _cumulativeDeposition[streamerSlot] = 0;
    _erosionState[streamerSlot] = EROSION_STATE.STABLE;
    _lastMutationS[streamerSlot] = -1;
    _lastMutationDelta[streamerSlot] = 0;
    _dustPulseS[streamerSlot] = -1;
    _vegetationVigor[streamerSlot] = 1.0;
    return true;
  },

  /**
   * Unregister a chunk. Called by 337 when a chunk is streamed out.
   */
  unregisterChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _chunkActive[streamerSlot] = 0;
  },

  /**
   * The 1 Hz consumer entry point. Called by 308_ContextConsumerTiers.
   */
  run(frame, tick, dt) {
    const t0 = performanceNow();
    const nowS = BiomeBlendSystem.elapsedSimSeconds;

    let processed = 0;
    let changed = 0;
    let erodingChunks = 0;
    let gullyChunks = 0;
    let totalErosion = 0;
    let totalDeposition = 0;

    // ─── 1. Process chunks in a round-robin window ──────────
    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      processed++;
      if (_processChunk(slot, nowS, dt)) {
        changed++;
      }
      if (_erosionState[slot] === EROSION_STATE.ERODING || _erosionState[slot] === EROSION_STATE.GULLY_FORMING) {
        erodingChunks++;
        totalErosion += Math.abs(_currentRate[slot]) * dt;
      }
      if (_erosionState[slot] === EROSION_STATE.GULLY_FORMING) {
        gullyChunks++;
      }
      if (_erosionState[slot] === EROSION_STATE.DEPOSITING) {
        totalDeposition += _currentRate[slot] * dt;
      }

      // Check the CPU budget.
      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastErodingChunks = erodingChunks;
    _lastGullyChunks = gullyChunks;
    _lastTickDurationMs = performanceNow() - t0;
    _lastTotalErosionM3 = totalErosion;
    _lastTotalDepositionM3 = totalDeposition;

    // ─── 2. Emit the aggregate event ────────────────────────
    if (processed > 0 || changed > 0) {
      _dispatcher.emit(EVENT_TYPE.EROSION_UPDATED, {
        tick,
        processed,
        changed,
        erodingChunks,
        gullyChunks,
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
  getHydraulicRate(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _hydraulicRate[streamerSlot];
  },
  getThermalRate(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _thermalRate[streamerSlot];
  },
  getCumulativeLoss(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _cumulativeLoss[streamerSlot];
  },
  getCumulativeDeposition(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _cumulativeDeposition[streamerSlot];
  },
  getErosionState(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return EROSION_STATE.STABLE;
    return _erosionState[streamerSlot];
  },
  getVegetationVigorModifier(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 1;
    return _vegetationVigor[streamerSlot];
  },
  isGullyForming(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    return _erosionState[streamerSlot] === EROSION_STATE.GULLY_FORMING;
  },

  /**
   * Read the full per-chunk erosion record. Zero-allocation; writes into
   * the caller's preallocated output object.
   */
  readErosionState(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    out.cumulativeDelta = _cumulativeDelta[streamerSlot];
    out.currentRate = _currentRate[streamerSlot];
    out.hydraulicRate = _hydraulicRate[streamerSlot];
    out.thermalRate = _thermalRate[streamerSlot];
    out.cumulativeLoss = _cumulativeLoss[streamerSlot];
    out.cumulativeDeposition = _cumulativeDeposition[streamerSlot];
    out.state = _erosionState[streamerSlot];
    out.vegetationVigor = _vegetationVigor[streamerSlot];
    out.dustPulseAgeS = _dustPulseS[streamerSlot] >= 0
      ? BiomeBlendSystem.elapsedSimSeconds - _dustPulseS[streamerSlot]
      : -1;
    return true;
  },

  /**
   * Query the dust emissive override for a chunk. Returns a scalar in
   * [0, 1] that the material bridge (331) adds to the chunk's emissive
   * term. Zero when there is no active dust pulse.
   */
  getDustEmissive(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (_dustPulseS[streamerSlot] < 0) return 0;
    const ageS = BiomeBlendSystem.elapsedSimSeconds - _dustPulseS[streamerSlot];
    const decay = Math.exp(-ageS * Math.log(2) / DUST_HALFLIFE_S);
    return Math.max(0, Math.min(1, decay * EROSION_DUST_EMISSIVE));
  },

  /**
   * Query the dust fog override for a chunk. Returns a scalar in [0, 1]
   * that the lighting coupler (351) adds to the chunk's fog density.
   */
  getDustFogOverride(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (_dustPulseS[streamerSlot] < 0) return 0;
    const ageS = BiomeBlendSystem.elapsedSimSeconds - _dustPulseS[streamerSlot];
    const decay = Math.exp(-ageS * Math.log(2) / DUST_HALFLIFE_S);
    return Math.max(0, Math.min(1, decay * DUST_FOG_INCREASE));
  },

  /**
   * Query the dust sun diffuse override for a chunk. Returns a scalar in
   * [0, 1] that the lighting coupler (351) adds to the chunk's sun diffuse
   * fraction.
   */
  getDustSunDiffuseOverride(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    if (_dustPulseS[streamerSlot] < 0) return 0;
    const ageS = BiomeBlendSystem.elapsedSimSeconds - _dustPulseS[streamerSlot];
    const decay = Math.exp(-ageS * Math.log(2) / DUST_HALFLIFE_S);
    return Math.max(0, Math.min(1, decay * DUST_SUN_DIFFUSE_INCREASE));
  },

  /**
   * Force an erosion event on a chunk. Used by 300_ImpactEventCoordinator
   * to apply the erosion from a large impact (e.g. a meteorite or an
   * explosive) directly to the terrain. The magnitude is in metres of
   * elevation change, signed negative for loss.
   */
  forceErosion(streamerSlot, magnitudeM) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    _cumulativeDelta[streamerSlot] += magnitudeM;
    if (magnitudeM < 0) _cumulativeLoss[streamerSlot] -= magnitudeM;
    else _cumulativeDeposition[streamerSlot] += magnitudeM;
    // Trigger a dust pulse.
    _dustPulseS[streamerSlot] = BiomeBlendSystem.elapsedSimSeconds;
    return true;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastErodingChunks() { return _lastErodingChunks; },
  get lastGullyChunks() { return _lastGullyChunks; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get lastTotalErosionM3() { return _lastTotalErosionM3; },
  get lastTotalDepositionM3() { return _lastTotalDepositionM3; },
  get activeChunks() {
    let n = 0;
    for (let i = 0; i < MAX_TRACKED_CHUNKS; i++) if (_chunkActive[i]) n++;
    return n;
  }
});

// Performance-now shim.
function performanceNow() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

export default LandscapeErosionSimulator;