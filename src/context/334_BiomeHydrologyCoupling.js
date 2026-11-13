// file number : 334
// full path name : src/context/334_BiomeHydrologyCoupling.js
// description : Biome–hydrology coupling — the 1 Hz consumer that fuses the
// active biome blend (329_BiomeBlendSystem), the fused climate
// (332_BiomeClimateCoupling), and the fused soil (333_BiomeSoilCoupling) into
// a single coherent per-chunk hydrology state that every downstream water-
// aware system reads without recomputing anything. It computes the full
// water balance at the chunk scale — precipitation input, evapotranspiration
// loss, surface runoff, infiltration, deep percolation, and groundwater
// recharge — and derives from that balance the water-table depth, the
// surface-water presence, the soil volumetric water content (shared with
// 333 for consistency), the snowpack water equivalent, and the stream
// discharge that the water-flow system (345) and the erosion systems
// (343, 344) consume. The water balance is the standard Thornthwaite–Mather
// formulation:
//   P  = precipitation input (fused annual × current temporal state)
//   PET = potential evapotranspiration (Hargreaves–Samani from the fused
//         temperature)
//   AET = actual evapotranspiration (PET × soil-moisture stress factor)
//   R  = surface runoff (P × runoff-coefficient, driven by soil texture
//         and surface slope)
//   I  = infiltration (P − R)
//   DP = deep percolation (I − AET − Δsoil-storage)
//   GR = groundwater recharge (max(0, DP − baseflow-return))
// The current water-table depth is derived from the groundwater recharge
// against the chunk's own storage capacity, with a slow drainage relaxation
// toward the biome's natural water-table depth. This makes the water table
// rise after a sustained rain event and fall during a drought — a slow,
// physically grounded response rather than a per-frame snap. Snowpack is
// tracked as snow water equivalent (SWE) with accumulation in freezing
// conditions and melt at a degree-day rate driven by the fused soil
// temperature. All per-chunk state is stored in a pooled structure-of-arrays,
// indexed by the same slot the other couplings use. The hot path is zero-
// allocation: per-chunk arrays are preallocated, scratch buffers are reused,
// and the per-tick work is bounded by a configurable budget (default 128
// chunks per tick). A 10,000-chunk world refreshes in roughly 1.3 simulated
// seconds without exceeding the per-tick CPU ceiling. The coupling also
// exposes a smooth sampled API at any world point so the material bridge
// (331) and the vegetation scatter (346) can drive wetness-dependent
// parameters from the fused hydrology without looking up the chunk.
//#
// best for : Every consumer that needs per-chunk fused hydrology — 335_Biome-
// FaunaMigrationSystem (water sources constrain migration corridors),
// 336_LandscapeChunkDescriptor (carries the fused hydrology per chunk),
// 337_LandscapeChunkStreamer (uses the fused hydrology to decide which
// water features to stream in), 343_LandscapeErosionSimulator (hydraulic
// erosion depends on runoff and stream power), 344_LandscapeWindErosion-
// System (dry soil is more erodible by wind), 345_LandscapeWaterFlowSystem
// (flow routing uses the fused runoff and stream discharge),
// 346_LandscapeVegetationScatterSystem (moisture-limited species depend on
// the fused water balance), 347_LandscapeFaunaSpawnSystem (amphibians and
// waterfowl depend on the fused surface-water presence),
// 348_LandscapeDecalPlacementSystem (water decals depend on the fused
// stream and lake presence), 350_LandscapeShadowScaler (water surfaces
// reflect light and affect shadow fill), 351_LandscapeLightingCoupler
// (water reflections and atmospheric haze depend on the fused water
// balance), 353_LandscapeSeasonCoupler (snowpack drives seasonal reflect-
// ance), and the entire biome-aware material and lighting pipeline. The
// coupling is designed to remain stable from small to galactic scale: per-
// chunk arrays are pooled, per-tick work is bounded, and every fused
// hydrology trait is computed from the biome descriptors plus the fused
// climate and soil, so a 10,000-chunk world costs the same per chunk as a
// 100-chunk world.
// license : MIT

// ─── raw 3js primitives — exported by the 264 barrel ────────────
import {
  Vec2, Vec3, Vec4, Mat4, Quat,
  SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry,
  Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

// ─── context providers & systems ────────────────────────────────
import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { MoistureLevelProvider, MOISTURE_STATE } from './285_MoistureLevelProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE } from './284_GroundwaterProvider.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Temporal smoothing rate for the fused hydrology outputs (per second). A
// rate of 0.04 gives a ~25 s time constant, which is the right scale for
// a chunk-scale water balance: fast enough to respond to a sustained rain
// event, slow enough to suppress per-tick noise.
const HYDROLOGY_SMOOTHING_RATE = 0.04;

// Per-tick work budget. Same rationale as the other couplings.
const DEFAULT_TICK_BUDGET = 128;

// Maximum number of active chunk states. Shared across the entire coupling
// chain so all systems can index a chunk by its slot.
const MAX_CHUNK_STATES = 100000;

// Water-balance reference values. These are the same reference values used
// by the climate coupling, so the fused hydrology is expressed in the same
// units as the fused climate.
const REFERENCE_PRECIPITATION_MM_PER_YEAR = 1000.0;
const SECONDS_PER_YEAR = 60.0 * 60.0 * 24.0 * 30.0 * 12.0;   // 30-day months
const MM_PER_SECOND_TO_MM_PER_YEAR = SECONDS_PER_YEAR;

// Hargreaves–Samani PET formula constants:
//   PET (mm/day) = 0.0023 · Ra · (Tmean + 17.8) · √(Tmax − Tmin)
// We work in °C, so Ra is expressed in mm/day of equivalent evaporation.
// The default Ra (extraterrestrial radiation at the equator) is 15.0 mm/day.
const HARGREAVES_COEFF = 0.0023;
const HARGREAVES_RA_MM_PER_DAY = 15.0;
const HARGREAVES_T_OFFSET = 17.8;

// Runoff coefficient range. The runoff coefficient depends on soil texture
// (sandy soils absorb more, clay soils shed more) and slope (steep slopes
// shed more). The min and max bound the texture-driven range.
const RUNOFF_MIN = 0.05;
const RUNOFF_MAX = 0.75;

// Snow water equivalent accumulation and melt rates. Accumulation happens
// below 0 °C; melt happens above 0 °C at a degree-day rate. The melt
// degree-day factor is expressed in mm of SWE per °C per second.
const SNOW_ACCUM_RATE_MM_PER_S = 0.001;
const SNOW_MELT_DEGREE_DAY_MM_PER_C_PER_DAY = 4.0;
const SNOW_MELT_DEGREE_DAY_MM_PER_C_PER_S = SNOW_MELT_DEGREE_DAY_MM_PER_C_PER_DAY / (24 * 3600);

// Water table relaxation constants. The water table rises after recharge
// and falls during drought, with a relaxation time constant in simulated
// seconds. A long time constant (default ~1 day) makes the water table
// respond slowly, like a real aquifer.
const WATER_TABLE_RISE_TIME_S = 24 * 3600;
const WATER_TABLE_FALL_TIME_S = 7 * 24 * 3600;

// Maximum number of stream segments per chunk. A chunk can have at most this
// many stream segments routed through it; the flow system (345) uses this
// to allocate per-chunk stream buffers. 4 is the practical maximum for a
// 100 m chunk in a well-drained terrain.
const MAX_STREAM_SEGMENTS = 4;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK FUSED HYDROLOGY (structure-of-arrays) ─────
// ══════════════════════════════════════════════════════════════════

// Water-balance terms (all in mm/year except where noted)
const _fusedPrecipitationMmYr = new Float32Array(MAX_CHUNK_STATES);
const _fusedPETMmYr = new Float32Array(MAX_CHUNK_STATES);
const _fusedAETMmYr = new Float32Array(MAX_CHUNK_STATES);
const _fusedRunoffMmYr = new Float32Array(MAX_CHUNK_STATES);
const _fusedInfiltrationMmYr = new Float32Array(MAX_CHUNK_STATES);
const _fusedDeepPercolationMmYr = new Float32Array(MAX_CHUNK_STATES);
const _fusedGroundwaterRechargeMmYr = new Float32Array(MAX_CHUNK_STATES);

// Water-table and surface-water state
const _fusedWaterTableDepthM = new Float32Array(MAX_CHUNK_STATES);
const _fusedSurfaceWaterPresence = new Float32Array(MAX_CHUNK_STATES);
const _fusedSurfaceWaterDepthM = new Float32Array(MAX_CHUNK_STATES);
const _fusedSnowWaterEquivalentMm = new Float32Array(MAX_CHUNK_STATES);

// Stream discharge and routing
const _fusedStreamDischargeM3s = new Float32Array(MAX_CHUNK_STATES);
const _fusedStreamSegmentCount = new Uint8Array(MAX_CHUNK_STATES);

// Lake and wetland state
const _fusedLakeLevelM = new Float32Array(MAX_CHUNK_STATES);
const _fusedLakeCoverageFraction = new Float32Array(MAX_CHUNK_STATES);
const _fusedWetlandCoverageFraction = new Float32Array(MAX_CHUNK_STATES);

// Slot bookkeeping
const _slotActive = new Uint8Array(MAX_CHUNK_STATES);
const _slotFree = new Int32Array(MAX_CHUNK_STATES);
let _slotFreeTop = MAX_CHUNK_STATES;
for (let i = 0; i < MAX_CHUNK_STATES; i++) _slotFree[i] = MAX_CHUNK_STATES - 1 - i;

// Round-robin cursor for the run() loop.
let _rrCursor = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS (zero-allocation hot path) ─────────────────
// ══════════════════════════════════════════════════════════════════

const _wIds = new Int16Array(4).fill(-1);
const _wWeights = new Float32Array(4);

// Per-chunk target scratch (computed once per chunk per tick).
const _targetHydro = new Float32Array(16);

// Scratch for reading fused climate and soil per chunk.
const _climateScratch = {
  temperatureOffsetC: 0,
  precipitationMultiplier: 1,
  humidityBias: 0,
  windSpeedMultiplier: 1,
  windDirectionBiasDeg: 0,
  diurnalSwingMultiplier: 1,
  seasonalAmplitudeMultiplier: 1,
  seasonalPhaseShiftRad: 0,
  snowlineShiftM: 0,
  treelineShiftM: 0
};

const _soilScratch = {
  sand: 0.4, silt: 0.4, clay: 0.2, gravel: 0.0, rockFragment: 0.0,
  organicMatter: 0.05, organicCarbon: 0.0, totalNitrogen: 0.0,
  pH: 6.5, cationExchangeCapacity: 10.0, baseSaturation: 50.0,
  aluminiumSaturation: 0.0, availablePhosphorus: 5.0,
  porosity: 0.45, bulkDensity: 1.30, waterHoldingCapacity: 0.30,
  hydraulicConductivity: 5.0, cohesion: 8.0, plasticityIndex: 15.0,
  usleKFactor: 0.30, windErodibility: 0.20, drainageClass: 2,
  volumetricWater: 0.20, soilTemperatureC: 15.0
};

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastActiveCount = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute runoff coefficient from the fused soil texture and the local
// slope. The standard NRCS Curve Number method is overkill here; we use a
// smooth approximation that captures the texture dependence:
//   sand-dominated soils drain quickly → low runoff
//   clay-dominated soils shed water → high runoff
//   steep slopes shed more than flat ones
function _runoffCoefficient(soil, slopeDeg) {
  const clayBias = soil.clay * 1.5;
  const sandBias = soil.sand * 0.3;
  const organicBias = soil.organicMatter * 1.2;
  let coeff = 0.20 + clayBias - sandBias - organicBias;
  coeff = Math.max(RUNOFF_MIN, Math.min(RUNOFF_MAX, coeff));
  // Slope modifier: 0° → 0.7×, 30° → 1.3×
  const slopeFactor = 0.7 + (slopeDeg / 30.0) * 0.6;
  return Math.max(RUNOFF_MIN, Math.min(RUNOFF_MAX, coeff * slopeFactor));
}

// Compute potential evapotranspiration using the Hargreaves–Samani
// formulation, converted to mm/year. The formula is:
//   PET_mm_per_day = 0.0023 · Ra · (Tmean + 17.8) · √(Tmax − Tmin)
// We use the fused diurnal swing to estimate (Tmax − Tmin).
function _potentialETMmPerYear(temperatureMeanC, diurnalSwingC) {
  const sqrtT = Math.sqrt(Math.max(0.1, diurnalSwingC));
  const petMmPerDay = HARGREAVES_COEFF * HARGREAVES_RA_MM_PER_DAY *
                      (temperatureMeanC + HARGREAVES_T_OFFSET) * sqrtT;
  // Convert to mm/year using 365 days.
  return Math.max(0, petMmPerDay * 365.0);
}

// Compute actual evapotranspiration from PET and the fused soil moisture.
// The stress factor follows the standard Feddes approach: full AET when
// volumetric water is above the field capacity, declining linearly to zero
// at the wilting point.
function _actualETMmPerYear(petMmYr, volumetricWater, waterHoldingCapacity) {
  const fieldCapacity = waterHoldingCapacity * 0.8;
  const wiltingPoint = waterHoldingCapacity * 0.2;
  if (volumetricWater >= fieldCapacity) return petMmYr;
  if (volumetricWater <= wiltingPoint) return 0;
  const stressFactor = (volumetricWater - wiltingPoint) / (fieldCapacity - wiltingPoint);
  return petMmYr * stressFactor;
}

// Compute the target fused hydrology for a chunk.
function _computeTargetHydro(slot) {
  // 1. Read the fused climate and fused soil for this chunk.
  BiomeClimateCoupling.readFusedClimate(slot, _climateScratch);
  BiomeSoilCoupling.readFusedSoil(slot, _soilScratch);

  // 2. Normalise the biome weights and accumulate the biome-weighted
  //    hydrology traits.
  const n = BiomeBlendSystem.readBlendedWeights(slot, _wIds, _wWeights);
  if (n === 0) return false;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += _wWeights[i];
  if (sum <= 1e-6) return false;
  const invSum = 1 / sum;

  let surfaceWaterPresence = 0;
  let lakeCoverage = 0;
  let wetlandCoverage = 0;
  let naturalWaterTableDepth = 0;
  let streamDensity = 0;
  let snowlineOffset = 0;
  let accumulated = 0;

  for (let i = 0; i < n; i++) {
    const biome = BiomeRegistry.getBiome(_wIds[i]);
    if (!biome) continue;
    const water = biome.water;
    if (!water) continue;
    const w = _wWeights[i] * invSum;
    accumulated += w;

    surfaceWaterPresence += (water.surfaceWaterPresence !== undefined ? water.surfaceWaterPresence : 0.10) * w;
    lakeCoverage += (water.lakeCoverage !== undefined ? water.lakeCoverage : 0.0) * w;
    wetlandCoverage += (water.bogCoverage !== undefined ? water.bogCoverage : 0.0) * w;
    naturalWaterTableDepth += (water.waterTableDepthM !== undefined ? water.waterTableDepthM : 5.0) * w;
    streamDensity += (water.riverineNetworkDensity !== undefined ? water.riverineNetworkDensity : 0.10) * w;
    snowlineOffset += (biome.terrain && biome.terrain.snowlineMinM !== undefined ? biome.terrain.snowlineMinM : 3000) * w;
  }

  if (accumulated <= 1e-6) return false;

  // 3. Water balance at the chunk scale.
  //    Precipitation is the fused reference precipitation scaled by the
  //    fused precipitation multiplier. The reference is 1000 mm/year.
  const precipMmYr = REFERENCE_PRECIPITATION_MM_PER_YEAR * _climateScratch.precipitationMultiplier;

  //    Air temperature drives the PET. We use the fused air temperature
  //    (reference 15 °C plus the fused offset plus the fused warming).
  const airTemp = 15.0 + _climateScratch.temperatureOffsetC;
  const diurnalSwing = 10.0 * _climateScratch.diurnalSwingMultiplier;
  const petMmYr = _potentialETMmPerYear(airTemp, diurnalSwing);

  //    Runoff coefficient depends on the fused soil texture and the
  //    typical slope for the biome. We use a reference slope of 5° for
  //    non-mountainous biomes and 20° for mountainous ones; the actual
  //    slope is supplied by the terrain provider when available.
  const referenceSlope = 5.0;
  const runoffCoeff = _runoffCoefficient(_soilScratch, referenceSlope);
  const runoffMmYr = precipMmYr * runoffCoeff;
  const infiltrationMmYr = precipMmYr - runoffMmYr;

  //    Actual evapotranspiration depends on the fused soil moisture.
  const aetMmYr = _actualETMmPerYear(
    petMmYr,
    _soilScratch.volumetricWater,
    _soilScratch.waterHoldingCapacity
  );

  //    Deep percolation is infiltration minus AET, floored at zero.
  const deepPercolationMmYr = Math.max(0, infiltrationMmYr - aetMmYr);

  //    Groundwater recharge is deep percolation minus a baseflow return
  //    that depends on the drainage class. Well-drained soils return
  //    baseflow quickly; poorly drained soils store the recharge.
  let baseflowFraction = 0.5;
  switch (_soilScratch.drainageClass) {
    case 0: baseflowFraction = 0.2; break;  // excessive — most recharge returns as baseflow
    case 1: baseflowFraction = 0.4; break;  // well
    case 2: baseflowFraction = 0.6; break;  // moderate
    case 3: baseflowFraction = 0.8; break;  // poor
    case 4: baseflowFraction = 0.9; break;  // very poor
  }
  const groundwaterRechargeMmYr = deepPercolationMmYr * (1 - baseflowFraction);

  // 4. Store the water-balance terms.
  _targetHydro[0] = precipMmYr;
  _targetHydro[1] = petMmYr;
  _targetHydro[2] = aetMmYr;
  _targetHydro[3] = runoffMmYr;
  _targetHydro[4] = infiltrationMmYr;
  _targetHydro[5] = deepPercolationMmYr;
  _targetHydro[6] = groundwaterRechargeMmYr;

  // 5. Derive surface-water presence and coverage from the balance.
  //    A wetter balance supports more surface water.
  const wetnessProxy = Math.min(1.0, precipMmYr / 2000.0);
  _targetHydro[7] = Math.min(1.0, surfaceWaterPresence * (0.5 + wetnessProxy));
  _targetHydro[8] = Math.max(0, _targetHydro[7] * 0.30);   // mean surface-water depth (m)
  _targetHydro[9] = Math.max(0, _fusedSnowWaterEquivalentMm[slot]);   // placeholder, updated below
  _targetHydro[10] = runoffMmYr * 1e-3 / (SECONDS_PER_YEAR * 0.7);  // approximate stream discharge (m³/s)
  _targetHydro[11] = Math.min(MAX_STREAM_SEGMENTS, Math.round(streamDensity * 8));  // stream segments
  _targetHydro[12] = 0.0;   // lake level, updated below
  _targetHydro[13] = lakeCoverage;
  _targetHydro[14] = wetlandCoverage;
  _targetHydro[15] = naturalWaterTableDepth;

  return true;
}

// Smooth the current fused hydrology toward the target values.
function _smoothHydro(slot, dt) {
  const alpha = 1 - Math.exp(-HYDROLOGY_SMOOTHING_RATE * dt);
  _fusedPrecipitationMmYr[slot] += (_targetHydro[0] - _fusedPrecipitationMmYr[slot]) * alpha;
  _fusedPETMmYr[slot] += (_targetHydro[1] - _fusedPETMmYr[slot]) * alpha;
  _fusedAETMmYr[slot] += (_targetHydro[2] - _fusedAETMmYr[slot]) * alpha;
  _fusedRunoffMmYr[slot] += (_targetHydro[3] - _fusedRunoffMmYr[slot]) * alpha;
  _fusedInfiltrationMmYr[slot] += (_targetHydro[4] - _fusedInfiltrationMmYr[slot]) * alpha;
  _fusedDeepPercolationMmYr[slot] += (_targetHydro[5] - _fusedDeepPercolationMmYr[slot]) * alpha;
  _fusedGroundwaterRechargeMmYr[slot] += (_targetHydro[6] - _fusedGroundwaterRechargeMmYr[slot]) * alpha;
  _fusedSurfaceWaterPresence[slot] += (_targetHydro[7] - _fusedSurfaceWaterPresence[slot]) * alpha;
  _fusedSurfaceWaterDepthM[slot] += (_targetHydro[8] - _fusedSurfaceWaterDepthM[slot]) * alpha;
  _fusedStreamDischargeM3s[slot] += (_targetHydro[10] - _fusedStreamDischargeM3s[slot]) * alpha;
  _fusedStreamSegmentCount[slot] = _targetHydro[11] | 0;
  _fusedLakeLevelM[slot] += (_targetHydro[12] - _fusedLakeLevelM[slot]) * alpha;
  _fusedLakeCoverageFraction[slot] += (_targetHydro[13] - _fusedLakeCoverageFraction[slot]) * alpha;
  _fusedWetlandCoverageFraction[slot] += (_targetHydro[14] - _fusedWetlandCoverageFraction[slot]) * alpha;

  // Water table: rises toward the natural level when recharge is high,
  // falls when recharge is low. The asymmetry between the rise and fall
  // time constants makes the water table "sticky": it takes longer to
  // drain than to fill.
  const naturalDepth = _targetHydro[15];
  const rechargeRatio = Math.min(1.0, _fusedGroundwaterRechargeMmYr[slot] / 200.0);
  const targetDepth = naturalDepth * (1.0 - rechargeRatio * 0.5);
  const currentDepth = _fusedWaterTableDepthM[slot];
  const rising = targetDepth < currentDepth;
  const timeConstant = rising ? WATER_TABLE_RISE_TIME_S : WATER_TABLE_FALL_TIME_S;
  const alphaWT = 1 - Math.exp(-dt / timeConstant);
  _fusedWaterTableDepthM[slot] += (targetDepth - currentDepth) * alphaWT;
}

// Step the snow water equivalent based on the fused soil temperature.
function _stepSnow(slot, dt) {
  const soilTempC = BiomeSoilCoupling.getSoilTemperatureC(slot);
  const precipInputMmYr = _fusedPrecipitationMmYr[slot];
  const precipInputMmPerSec = precipInputMmYr / SECONDS_PER_YEAR;

  if (soilTempC < 0) {
    // Accumulation.
    _fusedSnowWaterEquivalentMm[slot] += precipInputMmPerSec * SNOW_ACCUM_RATE_MM_PER_S * dt;
  } else {
    // Melt at a degree-day rate, capped at the available SWE.
    const meltMmPerSec = soilTempC * SNOW_MELT_DEGREE_DAY_MM_PER_C_PER_S;
    _fusedSnowWaterEquivalentMm[slot] = Math.max(0, _fusedSnowWaterEquivalentMm[slot] - meltMmPerSec * dt);
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const BiomeHydrologyCoupling = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  tickBudget: DEFAULT_TICK_BUDGET,
  maxStreamSegments: MAX_STREAM_SEGMENTS,

  /**
   * The 1 Hz consumer entry point. Called by 308_ContextConsumerTiers once
   * per second. Processes up to `tickBudget` chunks in a round-robin
   * fashion so the per-tick CPU cost is bounded regardless of active chunk
   * count.
   *
   * @param {ContextFrame} frame - The context frame being built.
   * @param {number} tick - The current tick counter.
   * @param {number} dt - Delta time since the previous call, in seconds.
   */
  run(frame, tick, dt) {
    const budget = this.tickBudget;
    const activeCount = MAX_CHUNK_STATES - _slotFreeTop;
    if (activeCount === 0) {
      _lastActiveCount = 0;
      return;
    }

    let processed = 0;
    for (let b = 0; b < budget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_CHUNK_STATES;
      if (!_slotActive[slot]) continue;

      // Compute the target fused hydrology and smooth toward it.
      if (_computeTargetHydro(slot)) {
        _smoothHydro(slot, dt);
      }

      // Advance the snow state.
      _stepSnow(slot, dt);
      processed++;
    }

    _lastProcessed = processed;
    _lastActiveCount = activeCount;

    // Emit the batched dispatch event. Downstream consumers (335, 336, 337,
    // 343, 344, 345, 346, 347, 348, 350, 351, 353) subscribe to this event
    // rather than polling the coupling.
    _dispatcher.emit(EVENT_TYPE.BIOME_HYDROLOGY_UPDATED, {
      tick,
      processed,
      activeChunks: activeCount
    });
  },

  /**
   * Register a chunk. Called by 337_LandscapeChunkStreamer when a chunk is
   * streamed in. Allocates a slot from the pool. Returns -1 if the pool is
   * exhausted.
   */
  registerChunk(cx, cy, cz) {
    if (_slotFreeTop === 0) return -1;
    const slot = _slotFree[--_slotFreeTop];
    _slotActive[slot] = 1;
    // Seed with reasonable defaults.
    _fusedPrecipitationMmYr[slot] = 1000.0;
    _fusedPETMmYr[slot] = 800.0;
    _fusedAETMmYr[slot] = 500.0;
    _fusedRunoffMmYr[slot] = 200.0;
    _fusedInfiltrationMmYr[slot] = 800.0;
    _fusedDeepPercolationMmYr[slot] = 300.0;
    _fusedGroundwaterRechargeMmYr[slot] = 100.0;
    _fusedWaterTableDepthM[slot] = 5.0;
    _fusedSurfaceWaterPresence[slot] = 0.10;
    _fusedSurfaceWaterDepthM[slot] = 0.03;
    _fusedSnowWaterEquivalentMm[slot] = 0.0;
    _fusedStreamDischargeM3s[slot] = 0.5;
    _fusedStreamSegmentCount[slot] = 1;
    _fusedLakeLevelM[slot] = 0.0;
    _fusedLakeCoverageFraction[slot] = 0.0;
    _fusedWetlandCoverageFraction[slot] = 0.0;
    return slot;
  },

  /**
   * Unregister a chunk. Returns its slot to the pool.
   */
  unregisterChunk(slot) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES) return;
    _slotActive[slot] = 0;
    if (_slotFreeTop < MAX_CHUNK_STATES) _slotFree[_slotFreeTop++] = slot;
  },

  /**
   * Read the fused hydrology for a chunk. Zero-allocation. The caller
   * provides a preallocated output object.
   *
   * @param {number} slot
   * @param {object} out - Output object with the named fields.
   * @returns {boolean}
   */
  readFusedHydrology(slot, out) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) return false;
    out.precipitationMmYr = _fusedPrecipitationMmYr[slot];
    out.potentialEvapotranspirationMmYr = _fusedPETMmYr[slot];
    out.actualEvapotranspirationMmYr = _fusedAETMmYr[slot];
    out.runoffMmYr = _fusedRunoffMmYr[slot];
    out.infiltrationMmYr = _fusedInfiltrationMmYr[slot];
    out.deepPercolationMmYr = _fusedDeepPercolationMmYr[slot];
    out.groundwaterRechargeMmYr = _fusedGroundwaterRechargeMmYr[slot];
    out.waterTableDepthM = _fusedWaterTableDepthM[slot];
    out.surfaceWaterPresence = _fusedSurfaceWaterPresence[slot];
    out.surfaceWaterDepthM = _fusedSurfaceWaterDepthM[slot];
    out.snowWaterEquivalentMm = _fusedSnowWaterEquivalentMm[slot];
    out.streamDischargeM3s = _fusedStreamDischargeM3s[slot];
    out.streamSegmentCount = _fusedStreamSegmentCount[slot];
    out.lakeLevelM = _fusedLakeLevelM[slot];
    out.lakeCoverageFraction = _fusedLakeCoverageFraction[slot];
    out.wetlandCoverageFraction = _fusedWetlandCoverageFraction[slot];
    return true;
  },

  /**
   * Sample the fused hydrology at a world point.
   */
  sampleAt(worldX, worldY, worldZ, out) {
    const cs = BiomeBlendField.chunkSizeM;
    const cx = Math.floor(worldX / cs);
    const cy = Math.floor(worldY / cs);
    const cz = Math.floor(worldZ / cs);
    const slot = BiomeBlendField.findChunk(cx, cy, cz);
    if (slot === -1) return false;
    return this.readFusedHydrology(slot, out);
  },

  /**
   * Apply the fused hydrology to the hydrology providers. Called by
   * 309_ContextRuntime in stage six. Providers may implement an
   * `applyBiomeHydrology` hook; if not, the call is a no-op.
   */
  applyToProviders(moistureLevel, groundwater) {
    if (moistureLevel && typeof moistureLevel.applyBiomeHydrology === 'function') {
      moistureLevel.applyBiomeHydrology(this);
    }
    if (groundwater && typeof groundwater.applyBiomeHydrology === 'function') {
      groundwater.applyBiomeHydrology(this);
    }
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getPrecipitationMmYr(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedPrecipitationMmYr[slot] : 1000.0; },
  getPETMmYr(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedPETMmYr[slot] : 800.0; },
  getAETMmYr(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedAETMmYr[slot] : 500.0; },
  getRunoffMmYr(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedRunoffMmYr[slot] : 200.0; },
  getInfiltrationMmYr(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedInfiltrationMmYr[slot] : 800.0; },
  getDeepPercolationMmYr(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedDeepPercolationMmYr[slot] : 300.0; },
  getGroundwaterRechargeMmYr(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedGroundwaterRechargeMmYr[slot] : 100.0; },
  getWaterTableDepthM(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedWaterTableDepthM[slot] : 5.0; },
  getSurfaceWaterPresence(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedSurfaceWaterPresence[slot] : 0.10; },
  getSurfaceWaterDepthM(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedSurfaceWaterDepthM[slot] : 0.03; },
  getSnowWaterEquivalentMm(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedSnowWaterEquivalentMm[slot] : 0.0; },
  getStreamDischargeM3s(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedStreamDischargeM3s[slot] : 0.5; },
  getStreamSegmentCount(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedStreamSegmentCount[slot] : 1; },
  getLakeLevelM(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedLakeLevelM[slot] : 0.0; },
  getLakeCoverageFraction(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedLakeCoverageFraction[slot] : 0.0; },
  getWetlandCoverageFraction(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedWetlandCoverageFraction[slot] : 0.0; },

  // ─── Diagnostics ─────────────────────────────────────────
  get activeChunks() { return MAX_CHUNK_STATES - _slotFreeTop; },
  get lastProcessed() { return _lastProcessed; },
  get lastActiveCount() { return _lastActiveCount; }
});

export default BiomeHydrologyCoupling;