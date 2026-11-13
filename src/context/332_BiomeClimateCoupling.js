// file number : 332
// full path name : src/context/332_BiomeClimateCoupling.js
// description : Biome–climate coupling — the 1 Hz consumer that reads the
// blended biome weights from 329_BiomeBlendSystem, extracts the biome-weighted
// climate traits from each biome's climate descriptor, and writes the fused
// climate overrides back into the climate providers (287_ClimateTemperatureProvider,
// 288_ClimatePrecipitationProvider, 289_ClimateWindProvider) and into the
// physical slice of the context frame, so every downstream consumer sees the
// climate of the actual blended biome at each chunk rather than a single global
// default. The coupling computes five fused climate outputs per chunk:
//   (1) temperature offset — the biome-weighted deviation from the global
//       reference temperature, including the biome's own mean annual
//       temperature anomaly, its diurnal swing multiplier, and its seasonal
//       amplitude multiplier;
//   (2) precipitation multiplier — the biome-weighted ratio of the biome's
//       annual precipitation to the global default, applied on top of the
//       precipitation provider's own base value;
//   (3) humidity bias — the biome-weighted deviation from the global
//       humidity reference, used by the moisture, fog, and wetness systems;
//   (4) wind modifier — the biome-weighted wind speed multiplier and
//       dominant-direction bias, applied to the wind provider;
//   (5) seasonal phase shift — the biome-weighted phase offset applied to
//       the seasonality system, so the growing season, flowering window, and
//       leaf-drop timing of the blended biome are honored at each chunk.
// The coupling also drives the temporal forces that change the effective
// climate over time: seasonality (already handled by each biome's own
// seasonal amplitude), the global warming drift already accumulated by
// 329_BiomeBlendSystem (applied as an additional temperature offset that
// grows linearly with simulated years), and long-horizon biome migration
// (applied via the registry's suitability scoring, which the blend field
// already accounts for). All five fused outputs are written to a pooled
// structure-of-arrays table indexed by the same chunk slot the blend field
// uses, so 331, 333, 334, 350–354 and any other consumer can read the per-
// chunk fused climate with a single integer lookup. The hot path is zero-
// allocation: per-chunk arrays are preallocated, scratch buffers are reused,
// and the per-tick work is bounded by a configurable budget (default 128
// chunks per tick) so a 10,000-chunk world is fully refreshed in roughly 1.3
// simulated seconds without ever exceeding the per-tick CPU ceiling.
//#
// best for : Every consumer that needs per-chunk fused climate — 333_BiomeSoil-
// Coupling (soil composition depends on the local climate of the blended
// biome), 334_BiomeHydrologyCoupling (water budget and runoff depend on the
// local precipitation and temperature), 335_BiomeFaunaMigrationSystem
// (migration corridors follow the climate gradients), 336_LandscapeChunk-
// Descriptor (carries the fused climate per chunk), 337_LandscapeChunkStreamer
// (uses the fused climate to decide which biomes' assets to stream in),
// 343_LandscapeErosionSimulator and 344_LandscapeWindErosionSystem (erosion
// rates depend on temperature and precipitation), 345_LandscapeWaterFlow-
// System (flow routing depends on the local water budget),
// 350_LandscapeShadowScaler (shadow scaling follows the local sun elevation),
// 351_LandscapeLightingCoupler (directional light follows the local sun
// elevation and precipitation haze), 352_LandscapeSkyCoupler (sky colour
// follows the local temperature and humidity), 353_LandscapeSeasonCoupler
// (season application uses the local seasonal phase shift), and the entire
// biome-aware material and lighting pipeline. The coupling is designed to
// remain stable from small to galactic scale: the per-chunk arrays are pooled,
// the per-tick work is bounded, and all climate contributions are computed
// from the registry descriptors (which are themselves static data), so a
// 10,000-chunk world costs the same per chunk as a 100-chunk world.
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
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider } from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE } from './289_ClimateWindProvider.js';
import { SeasonalitySystem } from './296_SeasonalitySystem.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Reference climate values that each biome's own values are expressed as
// deviations from. These are the "global default" values that the climate
// providers use when no biome blend is active, so the coupling is a
// modification on top of a well-defined baseline.
const REFERENCE_TEMPERATURE_C = 15.0;
const REFERENCE_HUMIDITY = 0.55;
const REFERENCE_PRECIPITATION_MM = 1000.0;
const REFERENCE_WIND_SPEED = 3.5;
const REFERENCE_DIURNAL_SWING_C = 10.0;
const REFERENCE_SEASONAL_AMPLITUDE = 0.65;

// Global warming drift conversion. The blend system accumulates warming in
// °C; the coupling converts that into a per-chunk temperature offset that
// is applied on top of the biome-weighted temperature. This is how the
// long-horizon climate drift in 329 actually reaches the climate providers.
const WARMING_TO_TEMPERATURE_OFFSET = 1.0;

// Temporal smoothing rate for the fused climate outputs (per second). The
// outputs are smoothed with an exponential moving average toward their
// target so the climate does not snap when a disturbance or a season flip
// briefly changes the blended biome. A rate of 0.05 gives a ~20 s time
// constant, which is fast enough to feel responsive and slow enough to
// suppress per-tick noise.
const CLIMATE_SMOOTHING_RATE = 0.05;

// Per-tick work budget. The run() loop processes at most this many chunks
// per tick. With a default of 128 chunks and a 1 Hz consumer cadence, a
// 10,000-chunk world is fully refreshed in ~1.3 seconds. A larger budget
// speeds up the refresh but risks exceeding the per-tick CPU ceiling.
const DEFAULT_TICK_BUDGET = 128;

// Maximum number of active chunk states. Sized to match the blend field and
// the blend system so the three systems can share slot indices.
const MAX_CHUNK_STATES = 100000;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK FUSED CLIMATE (structure-of-arrays) ───────
// ══════════════════════════════════════════════════════════════════
// One record per active chunk. The slot index is shared with 328, 329, and
// 330, so the fused climate can be looked up in O(1).

const _fusedTemperatureOffset = new Float32Array(MAX_CHUNK_STATES);
const _fusedPrecipitationMultiplier = new Float32Array(MAX_CHUNK_STATES);
const _fusedHumidityBias = new Float32Array(MAX_CHUNK_STATES);
const _fusedWindSpeedMultiplier = new Float32Array(MAX_CHUNK_STATES);
const _fusedWindDirectionBias = new Float32Array(MAX_CHUNK_STATES);
const _fusedDiurnalSwingMultiplier = new Float32Array(MAX_CHUNK_STATES);
const _fusedSeasonalAmplitudeMultiplier = new Float32Array(MAX_CHUNK_STATES);
const _fusedSeasonalPhaseShift = new Float32Array(MAX_CHUNK_STATES);
const _fusedSnowlineShiftM = new Float32Array(MAX_CHUNK_STATES);
const _fusedTreelineShiftM = new Float32Array(MAX_CHUNK_STATES);

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

// Scratch for the target values (computed from the raw biome weights) and
// current values (smoothed toward target). We keep the target separate from
// current so the smoothing step is a simple lerp.
const _targetTemperatureOffset = new Float32Array(1);
const _targetPrecipitationMultiplier = new Float32Array(1);
const _targetHumidityBias = new Float32Array(1);
const _targetWindSpeedMultiplier = new Float32Array(1);
const _targetWindDirectionBias = new Float32Array(1);
const _targetDiurnalSwingMultiplier = new Float32Array(1);
const _targetSeasonalAmplitudeMultiplier = new Float32Array(1);
const _targetSeasonalPhaseShift = new Float32Array(1);
const _targetSnowlineShiftM = new Float32Array(1);
const _targetTreelineShiftM = new Float32Array(1);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastActiveCount = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the target fused climate for a chunk from its blended biome
// weights and the current global warming drift. Zero-allocation.
function _computeTargetClimate(slot, simSeconds, globalWarmingC) {
  const n = BiomeBlendSystem.readBlendedWeights(slot, _wIds, _wWeights);
  if (n === 0) return;

  // Normalise the weights so the weighted average is well-defined even if
  // the caller's weights sum to slightly less than 1 due to hysteresis.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += _wWeights[i];
  if (sum <= 1e-6) return;
  const invSum = 1 / sum;

  // Accumulate the weighted climate traits across the biomes in the chunk.
  let tempOffset = 0;
  let precipMult = 0;
  let humidityBias = 0;
  let windSpeedMult = 0;
  let windDirBias = 0;
  let diurnalMult = 0;
  let seasonalMult = 0;
  let seasonalPhase = 0;
  let snowlineShift = 0;
  let treelineShift = 0;
  let accumulated = 0;

  for (let i = 0; i < n; i++) {
    const biome = BiomeRegistry.getBiome(_wIds[i]);
    if (!biome) continue;
    const climate = biome.climate;
    if (!climate) continue;
    const w = _wWeights[i] * invSum;
    accumulated += w;

    // Temperature offset: biome's mean annual temperature minus the global
    // reference, plus a diurnal-swing multiplier derived from the biome's
    // daily swing and a seasonal-amplitude multiplier derived from the
    // biome's seasonality amplitude.
    const biomeTempMean = climate.temperatureMean !== undefined ? climate.temperatureMean : REFERENCE_TEMPERATURE_C;
    tempOffset += (biomeTempMean - REFERENCE_TEMPERATURE_C) * w;

    // Precipitation multiplier: biome's annual precipitation divided by the
    // global reference. Clamped to a sane range so a single very wet or very
    // dry biome does not completely override the global value.
    const biomePrecipMm = climate.precipitationAnnualMm !== undefined ? climate.precipitationAnnualMm : REFERENCE_PRECIPITATION_MM;
    const precipRatio = Math.max(0.1, Math.min(5.0, biomePrecipMm / REFERENCE_PRECIPITATION_MM));
    precipMult += precipRatio * w;

    // Humidity bias: biome's mean humidity minus the reference.
    const biomeHumidity = climate.humidityMean !== undefined ? climate.humidityMean : REFERENCE_HUMIDITY;
    humidityBias += (biomeHumidity - REFERENCE_HUMIDITY) * w;

    // Wind multiplier: biome's mean wind speed divided by the reference.
    const biomeWind = climate.windMeanSpeed !== undefined ? climate.windMeanSpeed : REFERENCE_WIND_SPEED;
    const windRatio = Math.max(0.1, Math.min(5.0, biomeWind / REFERENCE_WIND_SPEED));
    windSpeedMult += windRatio * w;

    // Wind direction bias: biome's predominant wind direction, expressed as
    // a signed angular deviation from due west (270°). We wrap to [-180, 180].
    const biomeWindDir = climate.windPredominantDirDeg !== undefined ? climate.windPredominantDirDeg : 270;
    let dirDelta = biomeWindDir - 270;
    while (dirDelta > 180) dirDelta -= 360;
    while (dirDelta < -180) dirDelta += 360;
    windDirBias += dirDelta * w;

    // Diurnal swing multiplier: biome's daily swing divided by the reference.
    const biomeSwing = climate.temperatureDailySwing !== undefined ? climate.temperatureDailySwing : REFERENCE_DIURNAL_SWING_C;
    const swingRatio = Math.max(0.1, Math.min(3.0, biomeSwing / REFERENCE_DIURNAL_SWING_C));
    diurnalMult += swingRatio * w;

    // Seasonal amplitude multiplier: biome's seasonality amplitude divided
    // by the reference.
    const biomeSeasonal = climate.seasonalityAmplitude !== undefined ? climate.seasonalityAmplitude : REFERENCE_SEASONAL_AMPLITUDE;
    const seasonRatio = Math.max(0.1, Math.min(3.0, biomeSeasonal / REFERENCE_SEASONAL_AMPLITUDE));
    seasonalMult += seasonRatio * w;

    // Seasonal phase shift: derived from the biome's wetSeasonPeakDay
    // relative to the year. This shifts the biome's phenology forward or
    // backward in the year so the growing season, flowering window, and
    // leaf-drop timing line up with the biome's actual wet/dry cycle.
    const peakDay = climate.wetSeasonPeakDay !== undefined ? climate.wetSeasonPeakDay : 180;
    const phaseShift = (peakDay - 180) / 365 * 2 * Math.PI;   // radians
    seasonalPhase += phaseShift * w;

    // Snowline shift: the biome's snowline elevation, expressed as a delta
    // from the biome's own mid-elevation.
    const snowlineMin = biome.terrain && biome.terrain.snowlineMinM !== undefined
      ? biome.terrain.snowlineMinM
      : 3000;
    const biomeMidElev = biome.terrain && biome.terrain.elevationMinM !== undefined
      ? (biome.terrain.elevationMinM + (biome.terrain.elevationMaxM !== undefined ? biome.terrain.elevationMaxM : 0)) * 0.5
      : 1000;
    snowlineShift += (snowlineMin - biomeMidElev) * w;

    // Treeline shift: the biome's treeline elevation, expressed as a delta
    // from the biome's own mid-elevation. This drives the Flora scatter
    // system's treeline placement.
    const treelineMin = biome.terrain && biome.terrain.treelineMinM !== undefined
      ? biome.terrain.treelineMinM
      : biomeMidElev + 500;
    treelineShift += (treelineMin - biomeMidElev) * w;
  }

  if (accumulated <= 1e-6) return;

  // Add the global warming drift. This makes the long-horizon climate change
  // felt by the climate providers: warming pushes up every chunk's effective
  // temperature by the same amount, which pushes the biome suitability
  // optima and eventually triggers the biome migration that 329 applies.
  tempOffset += globalWarmingC * WARMING_TO_TEMPERATURE_OFFSET;

  // Store the target values. The smoothing step will lerp the current values
  // toward these targets.
  _targetTemperatureOffset[0] = tempOffset;
  _targetPrecipitationMultiplier[0] = precipMult;
  _targetHumidityBias[0] = humidityBias;
  _targetWindSpeedMultiplier[0] = windSpeedMult;
  _targetWindDirectionBias[0] = windDirBias;
  _targetDiurnalSwingMultiplier[0] = diurnalMult;
  _targetSeasonalAmplitudeMultiplier[0] = seasonalMult;
  _targetSeasonalPhaseShift[0] = seasonalPhase;
  _targetSnowlineShiftM[0] = snowlineShift;
  _targetTreelineShiftM[0] = treelineShift;
}

// Smooth the current fused climate toward the target values. This is a
// simple exponential moving average: current += (target - current) * alpha.
function _smoothClimate(slot, dt) {
  const alpha = 1 - Math.exp(-CLIMATE_SMOOTHING_RATE * dt);
  _fusedTemperatureOffset[slot] += (_targetTemperatureOffset[0] - _fusedTemperatureOffset[slot]) * alpha;
  _fusedPrecipitationMultiplier[slot] += (_targetPrecipitationMultiplier[0] - _fusedPrecipitationMultiplier[slot]) * alpha;
  _fusedHumidityBias[slot] += (_targetHumidityBias[0] - _fusedHumidityBias[slot]) * alpha;
  _fusedWindSpeedMultiplier[slot] += (_targetWindSpeedMultiplier[0] - _fusedWindSpeedMultiplier[slot]) * alpha;
  _fusedWindDirectionBias[slot] += (_targetWindDirectionBias[0] - _fusedWindDirectionBias[slot]) * alpha;
  _fusedDiurnalSwingMultiplier[slot] += (_targetDiurnalSwingMultiplier[0] - _fusedDiurnalSwingMultiplier[slot]) * alpha;
  _fusedSeasonalAmplitudeMultiplier[slot] += (_targetSeasonalAmplitudeMultiplier[0] - _fusedSeasonalAmplitudeMultiplier[slot]) * alpha;
  _fusedSeasonalPhaseShift[slot] += (_targetSeasonalPhaseShift[0] - _fusedSeasonalPhaseShift[slot]) * alpha;
  _fusedSnowlineShiftM[slot] += (_targetSnowlineShiftM[0] - _fusedSnowlineShiftM[slot]) * alpha;
  _fusedTreelineShiftM[slot] += (_targetTreelineShiftM[0] - _fusedTreelineShiftM[slot]) * alpha;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const BiomeClimateCoupling = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  tickBudget: DEFAULT_TICK_BUDGET,

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

    const simSeconds = BiomeBlendSystem.elapsedSimSeconds;
    const globalWarmingC = BiomeBlendSystem.globalWarmingC;

    let processed = 0;
    for (let b = 0; b < budget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_CHUNK_STATES;
      if (!_slotActive[slot]) continue;

      // Compute the target fused climate for this chunk and smooth the
      // current fused climate toward it.
      _computeTargetClimate(slot, simSeconds, globalWarmingC);
      _smoothClimate(slot, dt);
      processed++;
    }

    _lastProcessed = processed;
    _lastActiveCount = activeCount;

    // Emit the batched dispatch event. Downstream consumers (333, 334,
    // 335, 336, 337, 343, 344, 345, 350–354) subscribe to this event
    // rather than polling the coupling.
    _dispatcher.emit(EVENT_TYPE.BIOME_CLIMATE_UPDATED, {
      tick,
      processed,
      activeChunks: activeCount,
      globalWarmingC
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
    // Seed the fused values with the reference climate so the first frame
    // does not show a discontinuous jump.
    _fusedTemperatureOffset[slot] = 0;
    _fusedPrecipitationMultiplier[slot] = 1;
    _fusedHumidityBias[slot] = 0;
    _fusedWindSpeedMultiplier[slot] = 1;
    _fusedWindDirectionBias[slot] = 0;
    _fusedDiurnalSwingMultiplier[slot] = 1;
    _fusedSeasonalAmplitudeMultiplier[slot] = 1;
    _fusedSeasonalPhaseShift[slot] = 0;
    _fusedSnowlineShiftM[slot] = 0;
    _fusedTreelineShiftM[slot] = 0;
    return slot;
  },

  /**
   * Unregister a chunk. Returns its slot to the pool. Called by the streamer
   * when a chunk is streamed out.
   */
  unregisterChunk(slot) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES) return;
    _slotActive[slot] = 0;
    if (_slotFreeTop < MAX_CHUNK_STATES) _slotFree[_slotFreeTop++] = slot;
  },

  /**
   * Read the fused climate for a chunk. Zero-allocation. The caller provides
   * a preallocated output object or reads the individual getters. The values
   * returned are the smoothed, biome-weighted climate traits that 331, 333,
   * 334, 335, 336, and the landscape systems can consume directly.
   *
   * @param {number} slot
   * @param {object} out - Output object with the named fields.
   * @returns {boolean} true if the slot is active and the output was written.
   */
  readFusedClimate(slot, out) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) return false;
    out.temperatureOffsetC = _fusedTemperatureOffset[slot];
    out.precipitationMultiplier = _fusedPrecipitationMultiplier[slot];
    out.humidityBias = _fusedHumidityBias[slot];
    out.windSpeedMultiplier = _fusedWindSpeedMultiplier[slot];
    out.windDirectionBiasDeg = _fusedWindDirectionBias[slot];
    out.diurnalSwingMultiplier = _fusedDiurnalSwingMultiplier[slot];
    out.seasonalAmplitudeMultiplier = _fusedSeasonalAmplitudeMultiplier[slot];
    out.seasonalPhaseShiftRad = _fusedSeasonalPhaseShift[slot];
    out.snowlineShiftM = _fusedSnowlineShiftM[slot];
    out.treelineShiftM = _fusedTreelineShiftM[slot];
    return true;
  },

  /**
   * Read the fused climate at a world point by delegating to the blend
   * field's interpolated sampling. This is the API used by the material and
   * lighting bridges for smoothly interpolated climate at a world point
   * rather than a chunk-averaged climate.
   *
   * @param {number} worldX
   * @param {number} worldY
   * @param {number} worldZ
   * @param {object} out - Output object with the named fields.
   * @returns {boolean}
   */
  sampleAt(worldX, worldY, worldZ, out) {
    const cs = BiomeBlendField.chunkSizeM;
    const cx = Math.floor(worldX / cs);
    const cy = Math.floor(worldY / cs);
    const cz = Math.floor(worldZ / cs);
    const slot = BiomeBlendField.findChunk(cx, cy, cz);
    if (slot === -1) return false;
    return this.readFusedClimate(slot, out);
  },

  // ─── Direct accessor API for hot paths ─────────────────────
  // These accessors are the fastest way for very hot consumers to read a
  // single fused value without allocating an output object. They are the
  // recommended path for the per-entity loops in 331, 350, 351.
  getTemperatureOffset(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedTemperatureOffset[slot] : 0;
  },
  getPrecipitationMultiplier(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedPrecipitationMultiplier[slot] : 1;
  },
  getHumidityBias(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedHumidityBias[slot] : 0;
  },
  getWindSpeedMultiplier(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedWindSpeedMultiplier[slot] : 1;
  },
  getWindDirectionBiasDeg(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedWindDirectionBias[slot] : 0;
  },
  getDiurnalSwingMultiplier(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedDiurnalSwingMultiplier[slot] : 1;
  },
  getSeasonalAmplitudeMultiplier(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedSeasonalAmplitudeMultiplier[slot] : 1;
  },
  getSeasonalPhaseShiftRad(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedSeasonalPhaseShift[slot] : 0;
  },
  getSnowlineShiftM(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedSnowlineShiftM[slot] : 0;
  },
  getTreelineShiftM(slot) {
    return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedTreelineShiftM[slot] : 0;
  },

  /**
   * Apply the fused climate to the climate providers. Called by
   * 309_ContextRuntime in stage six (the batched dispatch stage) so the
   * fused climate is folded into the providers' state for the next frame.
   * The providers themselves decide how to consume the fused values (e.g.
   * the temperature provider adds the offset to its global temperature, the
   * precipitation provider multiplies its base by the multiplier).
   *
   * The function is a no-op if the providers have not declared an
   * `applyBiomeClimate` hook; this keeps the coupling usable in worlds
   * where the providers are simple or synthetic.
   */
  applyToProviders(climateTemperature, climatePrecipitation, climateWind) {
    if (climateTemperature && typeof climateTemperature.applyBiomeClimate === 'function') {
      climateTemperature.applyBiomeClimate(this);
    }
    if (climatePrecipitation && typeof climatePrecipitation.applyBiomeClimate === 'function') {
      climatePrecipitation.applyBiomeClimate(this);
    }
    if (climateWind && typeof climateWind.applyBiomeClimate === 'function') {
      climateWind.applyBiomeClimate(this);
    }
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get activeChunks() {
    return MAX_CHUNK_STATES - _slotFreeTop;
  },
  get lastProcessed() {
    return _lastProcessed;
  },
  get lastActiveCount() {
    return _lastActiveCount;
  }
});

export default BiomeClimateCoupling;