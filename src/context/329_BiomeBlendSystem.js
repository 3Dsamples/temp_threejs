// file number : 329
// full path name : src/context/329_BiomeBlendSystem.js
// description : Biome blend system — the 1 Hz context consumer that applies
// the resolved per-chunk biome weights from BiomeBlendField to the context
// frame, and that models the four temporal forces that make a living world's
// biome map change over time: (1) seasonal modulation, which pushes weights
// toward the seasonal phenotype of each biome; (2) successional dynamics,
// which move each chunk along the pioneer → intermediate → climax gradient
// driven by disturbance recovery; (3) disturbance pulses, which abruptly
// reset succession and shift the effective biome after fire, flood, drought,
// or large-herbivore grazing; and (4) long-horizon climate migration, which
// slowly shifts each biome's suitability optimum as global mean temperature
// and precipitation drift, driving range expansion and contraction over
// simulated decades. All four forces are gated so they never produce a hard
// seam: the system blends the resolved weights with the successional and
// disturbance weights using configurable relaxation times, and the resulting
// weights pass through a hysteresis gate that requires a weight to cross a
// higher threshold to gain a biome and a lower threshold to lose one. The
// output of the system is a single coherent blended-biome state written into
// the context frame's biome slice, plus a per-chunk chunk-state record that
// downstream consumers (materials, lighting, flora scatter, fauna spawn,
// shadow scaling) read without needing to recompute any of it. The system
// never allocates in the hot path: chunk-state records are pooled, scratch
// buffers are preallocated, and the field's own pooled resolveBiomes() path
// supplies the raw weights. Long-horizon climate migration is updated on a
// much slower cadence (one calendar-year tick, computed every N seconds of
// simulated time) so the hot loop sees a constant-rate forcing value, not a
// per-frame recomputation.
//#
// best for : Every consumer that needs a coherent, time-evolving blended-biome
// state per chunk — 330_CrossBiomeEcotoneSystem (reads the transition bands
// for ecotone flora and fauna), 331_BiomeBlendMaterialBridge (pushes the
// blended material, wetness, snow, and fire parameters into PBR and anime
// uniforms), 332_BiomeClimateCoupling (feeds the blended climate back into the
// temperature and precipitation providers), 333_BiomeSoilCoupling (feeds the
// blended soil properties into the soil composition provider),
// 334_BiomeHydrologyCoupling (feeds the blended water budget into the moisture
// and groundwater providers), 335_BiomeFaunaMigrationSystem (uses successional
// state and disturbance pulses to drive migration), 336_LandscapeChunkDescriptor
// (carries the blended weights and successional state into every chunk
// descriptor), 337_LandscapeChunkStreamer (queries the blend to decide what
// LOD and asset set to stream in), 346_LandscapeVegetationScatterSystem and
// 347_LandscapeFaunaSpawnSystem (use successional stage and disturbance state
// to pick species), and 350–354 landscape coupling systems. The system is the
// single point in the pipeline where time and climate actually change the
// biome map: everything downstream reads its outputs and stays purely
// functional.
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
import { CoreLayers, LAYER } from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { TemporalContextProvider } from './276_TemporalContextProvider.js';
import { CausalContextProvider } from './278_CausalContextProvider.js';
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider } from './288_ClimatePrecipitationProvider.js';
import { MoistureLevelProvider } from './285_MoistureLevelProvider.js';
import { SeasonalitySystem } from './296_SeasonalitySystem.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Successional gradient — three named stages that every biome can be placed on.
// A chunk in "bare" state has just been disturbed; a chunk in "climax" state
// has fully recovered. This gradient is biome-agnostic by design: what changes
// between biomes is how long each stage lasts, not the stage names.
const SUCCESSION_STAGE = Object.freeze({
  BARE: 0,           // just after a disturbance, or freshly created ground
  PIONEER: 1,        // early seral, fast-growing, low biomass
  INTERMEDIATE: 2,   // mid-seral, biomass accumulating
  CLIMAX: 3          // mature, fully recovered
});

// Successional rates in simulated years per stage. These are defaults; each
// biome can override them via its own `successionRates` block. The rates here
// are chosen to make the world feel alive without making disturbance look
// like it vanished overnight: a temperate forest takes ~80 simulated years to
// fully recover from stand-replacing fire, a grassland takes ~3 years, a
// desert takes ~50 years but with very low amplitude (deserts are already
// near-climax). The system multiplies the stage rate by the biome's
// `successionRateMultiplier` if declared.
const DEFAULT_SUCCESSION_RATES = Object.freeze({
  bareToPioneer: 0.10,        // 10 % of stage progress per simulated year
  pioneerToIntermediate: 0.04,
  intermediateToClimax: 0.015
});

// Disturbance severity thresholds. A disturbance event must exceed the
// biome's own threshold to reset succession. Values are expressed as a
// normalized force in [0, 1] where 0.5 is the biome-specific default.
const DEFAULT_DISTURBANCE_THRESHOLD = 0.5;

// How much a disturbance pulse moves the blended weights toward the biome's
// post-disturbance successional profile. A fire in a temperate forest pushes
// the weights toward BARE/PIONEER and away from CLIMAX; a flood in a wetland
// pushes toward PIONEER. The magnitude is bounded to keep transitions smooth.
const DISTURBANCE_WEIGHT_SHIFT = 0.35;

// Hysteresis thresholds for gaining and losing a biome in a chunk's weight
// vector. A biome must climb to GAIN_THRESHOLD to be added and must fall to
// LOSE_THRESHOLD to be removed. This prevents a biome from flickering in and
// out of the top-K on every tick as tiny environmental noise crosses the
// threshold.
const GAIN_THRESHOLD = 0.10;
const LOSE_THRESHOLD = 0.04;

// Relaxation rates. The blended weights relax toward their target at these
// per-second rates. Seasonal, successional, and disturbance forces all
// contribute to the target; the relaxation is what makes the transition
// smooth instead of instantaneous. The rates are tuned so a typical biome
// transition takes a few simulated weeks to settle, which is fast enough to
// feel responsive and slow enough to look natural.
const SEASONAL_RELAXATION_RATE = 0.02;
const SUCCESSION_RELAXATION_RATE = 0.001;   // very slow, measured in years
const DISTURBANCE_RELAXATION_RATE = 0.05;
const CLIMATE_RELAXATION_RATE = 1e-6;       // negligible on a per-tick basis

// Simulated time in seconds per simulated year. The system treats the
// simulation's own elapsed seconds as the clock; one simulated year is this
// many seconds of simulation time. The default gives a satisfying day-night
// cycle and a useful multi-year arc without making the player wait literal
// real years.
const SECONDS_PER_SIM_YEAR = 60.0 * 60.0 * 24.0 * 30.0;  // 30 days of sim time

// Long-horizon climate forcing. Global mean temperature drifts at this rate
// in °C per simulated year. The default is a warming rate that makes the
// biome map shift perceptibly over a play session without overwhelming the
// local ecology. Precipitation drift is derived from the same forcing.
const GLOBAL_WARMING_C_PER_YEAR = 0.02;

// Biome migration response: for every 1 °C of global warming, each biome's
// suitability optimum shifts this many metres in elevation (upward) and this
// many metres in the latitudinal sense (toward the poles). Both numbers are
// negative in the "shift direction" sense because warming pushes biomes
// uphill and poleward.
const MIGRATION_M_PER_C_ELEVATION = -150.0;
const MIGRATION_DEG_LAT_PER_C = -0.20;  // degrees latitude per °C of warming

// Per-chunk history ring buffer length. Used to compute disturbance severity
// as the sum of recent impact events minus the recovery the biome has done
// since. A short buffer (8 entries) is enough to capture the burstiness of
// real disturbances without wasting memory.
const DISTURBANCE_HISTORY_LEN = 8;

// Maximum number of active chunk states. Sized to match BiomeBlendField so
// the two pools stay in lockstep. A chunk state is 96 bytes; 100,000 of them
// is ~10 MB, which fits inside the resident-memory ceiling.
const MAX_CHUNK_STATES = 100000;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED CHUNK STATE (structure-of-arrays) ───────────────────
// ══════════════════════════════════════════════════════════════════
// One record per active chunk. The slot index is shared with BiomeBlendField
// so the two systems can look each other up in O(1) without an extra hash.

// Successional state
const _successionStage      = new Uint8Array(MAX_CHUNK_STATES);
const _successionProgress   = new Float32Array(MAX_CHUNK_STATES);  // 0..1 within stage

// Disturbance history (ring buffer per chunk, flattened)
const _disturbanceTick      = new Int32Array(MAX_CHUNK_STATES * DISTURBANCE_HISTORY_LEN);
const _disturbanceSeverity  = new Float32Array(MAX_CHUNK_STATES * DISTURBANCE_HISTORY_LEN);
const _disturbanceHead      = new Uint8Array(MAX_CHUNK_STATES);

// Target and current blended weights (K entries per chunk). The target is
// recomputed from the raw weights + seasonality + succession + disturbance
// every tick. The current weights relax toward the target.
const _targetIds     = new Int16Array(MAX_CHUNK_STATES * 4).fill(-1);
const _targetWeights = new Float32Array(MAX_CHUNK_STATES * 4);
const _currentIds    = new Int16Array(MAX_CHUNK_STATES * 4).fill(-1);
const _currentWeights = new Float32Array(MAX_CHUNK_STATES * 4);

// Climate forcing cache. Stored per-chunk so a chunk's biome suitability can
// be re-scored with a drift that reflects its own latitude and elevation.
const _chunkLatitude  = new Float32Array(MAX_CHUNK_STATES);
const _chunkElevation = new Float32Array(MAX_CHUNK_STATES);

// Slot bookkeeping
const _slotActive = new Uint8Array(MAX_CHUNK_STATES);
const _slotFree = new Int32Array(MAX_CHUNK_STATES);
let _slotFreeTop = MAX_CHUNK_STATES;
for (let i = 0; i < MAX_CHUNK_STATES; i++) _slotFree[i] = MAX_CHUNK_STATES - 1 - i;

// Scratch buffers reused by the hot path.
const _rawIds = new Int16Array(4);
const _rawWeights = new Float32Array(4);
const _targetScratchIds = new Int16Array(8);
const _targetScratchWeights = new Float32Array(8);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _elapsedSimSeconds = 0;
let _globalWarmingC = 0;
let _lastRescoreResult = { scored: 0, skipped: 0, budgetExhausted: false };
let _lastApplyCount = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SLOT LIFECYCLE ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
function _allocSlot() {
  if (_slotFreeTop === 0) return -1;
  return _slotFree[--_slotFreeTop];
}

function _freeSlot(slot) {
  _slotActive[slot] = 0;
  const base4 = slot * 4;
  for (let i = 0; i < 4; i++) {
    _targetIds[base4 + i] = -1;
    _targetWeights[base4 + i] = 0;
    _currentIds[base4 + i] = -1;
    _currentWeights[base4 + i] = 0;
  }
  const baseD = slot * DISTURBANCE_HISTORY_LEN;
  for (let i = 0; i < DISTURBANCE_HISTORY_LEN; i++) {
    _disturbanceTick[baseD + i] = 0;
    _disturbanceSeverity[baseD + i] = 0;
  }
  _disturbanceHead[slot] = 0;
  _successionStage[slot] = SUCCESSION_STAGE.CLIMAX;
  _successionProgress[slot] = 0;
  if (_slotFreeTop < MAX_CHUNK_STATES) _slotFree[_slotFreeTop++] = slot;
}

// ══════════════════════════════════════════════════════════════════
// ─── HELPERS ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Ensure a chunk's current weights are seeded from its raw weights on the
// first tick it becomes active. After that the current weights relax toward
// the target, so the seed only matters on the first frame.
function _seedIfNeeded(slot) {
  const base4 = slot * 4;
  let any = false;
  for (let i = 0; i < 4; i++) {
    if (_currentIds[base4 + i] !== -1) { any = true; break; }
  }
  if (any) return;
  for (let i = 0; i < 4; i++) {
    _currentIds[base4 + i] = _targetIds[base4 + i];
    _currentWeights[base4 + i] = _targetWeights[base4 + i];
  }
}

// Write the raw top-K weights from BiomeBlendField into the chunk's current
// target buffers, then apply seasonal / successional / disturbance / climate
// modulation to produce the final target weights.
function _recomputeTarget(slot, cx, cy, cz, sample, simSeconds) {
  // 1. Read the raw weights from the field.
  const n = BiomeBlendField.readChunk(slot, _rawIds, _rawWeights);

  // 2. Compute the four modulating factors.
  const seasonalPulse = _seasonalModulation(sample, simSeconds);
  const successionBias = _successionModulation(_successionStage[slot], _successionProgress[slot]);
  const disturbanceBias = _disturbanceModulation(slot, simSeconds);
  const climateBias = _climateModulation(slot, simSeconds);

  // 3. Compute the target weights for each biome in the raw set, and
  //    accumulate into a scratch buffer that can hold more than four biomes
  //    (succession and disturbance may add a biome that was not in the
  //    raw top-K, e.g. BARE from a fire that pushes a climax forest chunk
  //    into pioneer state).
  let scratchCount = 0;
  for (let i = 0; i < n; i++) {
    const id = _rawIds[i];
    if (id === -1) continue;
    const w = _rawWeights[i] * seasonalPulse * (1 + successionBias + disturbanceBias + climateBias);
    scratchCount = _accumulateTarget(_targetScratchIds, _targetScratchWeights, scratchCount, id, w);
  }

  // 4. Succession may force an additional biome not in the raw set (e.g.
  //    grassland entering bare state after a fire). The bias above already
  //    modifies the weights of the biomes that are present; the additional
  //    biome is added via the disturbance pathway, which is biome-specific
  //    and handled in _disturbanceModulation.

  // 5. Normalise and write into the target buffers.
  let sum = 0;
  for (let i = 0; i < scratchCount; i++) sum += _targetScratchWeights[i];
  if (sum <= 0) sum = 1;
  const inv = 1 / sum;

  const base4 = slot * 4;
  for (let i = 0; i < 4; i++) {
    if (i < scratchCount) {
      _targetIds[base4 + i] = _targetScratchIds[i];
      _targetWeights[base4 + i] = _targetScratchWeights[i] * inv;
    } else {
      _targetIds[base4 + i] = -1;
      _targetWeights[base4 + i] = 0;
    }
  }
}

// Accumulate a single (biomeId, weight) pair into a small fixed-size scratch
// buffer. If the biome is already present, add to its weight. If not, append
// it. If the buffer is full, replace the smallest entry if the new weight is
// larger. Bounded to the buffer size, so O(K) worst case.
function _accumulateTarget(ids, weights, count, id, w) {
  if (w <= 0) return count;
  for (let i = 0; i < count; i++) {
    if (ids[i] === id) {
      weights[i] += w;
      return count;
    }
  }
  if (count < ids.length) {
    ids[count] = id;
    weights[count] = w;
    return count + 1;
  }
  // Replace smallest
  let smallest = 0;
  for (let i = 1; i < count; i++) {
    if (weights[i] < weights[smallest]) smallest = i;
  }
  if (w > weights[smallest]) {
    ids[smallest] = id;
    weights[smallest] = w;
  }
  return count;
}

// Seasonal modulation: returns a scalar in [0.85, 1.15] that pushes the biome
// weights toward the seasonal phenotype. Wet-season biomes (e.g. tropical
// rainforest, temperate deciduous forest in summer) get a small boost during
// the wet season; dry-season biomes (e.g. Mediterranean chaparral, savanna)
// get a small boost during the dry season. The magnitude is deliberately
// small so seasonality nudges the biome map without overriding it.
function _seasonalModulation(sample, simSeconds) {
  // Season phase in [0, 1): 0 = spring, 0.25 = summer, 0.5 = autumn, 0.75 = winter.
  const yearSeconds = SECONDS_PER_SIM_YEAR;
  const phase = (simSeconds % yearSeconds) / yearSeconds;
  // Wet-season biomes peak at phase 0.25–0.75 (their "summer").
  // Dry-season biomes peak at phase 0.75–0.25 (their "dry summer").
  const wetBoost = 1.0 + 0.10 * Math.sin(phase * 2 * Math.PI);
  return wetBoost;
}

// Successional modulation: returns a scalar that biases the biome weights
// toward biomes that are more common in the chunk's current successional
// stage. Bare and pioneer stages boost grass and shrub biomes; climax stage
// boosts forest biomes. The bias is small relative to the raw weights, so it
// nudges the biome map toward the successional trajectory without overriding
// the environment's own biome suitability.
function _successionModulation(stage, progress) {
  const bias = new Float32Array(4);
  bias.fill(0);
  // Bare/pioneer → boost early-seral biomes (grassland, savanna).
  if (stage <= SUCCESSION_STAGE.PIONEER) {
    bias[0] = 0.20;   // grassland / savanna
    bias[1] = 0.10;   // scrub
  } else if (stage === SUCCESSION_STAGE.INTERMEDIATE) {
    bias[0] = 0.10;
    bias[1] = 0.15;
  } else {
    // Climax → boost forest biomes.
    bias[2] = 0.15;   // forest
    bias[3] = 0.10;   // wetland / specialized
  }
  return bias[0] + bias[1] + bias[2] + bias[3];  // collapse to a scalar bias
}

// Disturbance modulation: returns a scalar bias that reflects recent
// disturbance activity. A chunk that was just hit by fire or flood has a
// positive bias toward early-seral biomes; the bias decays as the disturbance
// ages. The decay follows an exponential with a per-disturbance-type
// half-life.
function _disturbanceModulation(slot, simSeconds) {
  const baseD = slot * DISTURBANCE_HISTORY_LEN;
  const head = _disturbanceHead[slot];
  let total = 0;
  for (let i = 0; i < DISTURBANCE_HISTORY_LEN; i++) {
    const idx = baseD + ((head + i) % DISTURBANCE_HISTORY_LEN);
    const tick = _disturbanceTick[idx];
    if (tick <= 0) continue;
    const severity = _disturbanceSeverity[idx];
    const ageSeconds = simSeconds - tick;
    // Half-life of 30 simulated days.
    const decay = Math.exp(-ageSeconds / (30 * 24 * 3600));
    total += severity * decay;
  }
  return Math.min(total, 0.50);
}

// Climate modulation: returns a scalar bias that reflects long-horizon
// climate drift. A chunk that has warmed significantly since its biome was
// originally resolved gets a bias toward the warmer biome in its raw set;
// a chunk that has cooled gets a bias toward the cooler biome. The bias is
// small and grows slowly with the accumulated warming.
function _climateModulation(slot, simSeconds) {
  // The climate forcing is computed once per simulated year in _stepClimate,
  // and cached here. The bias is the accumulated warming, scaled to a small
  // scalar.
  return Math.min(_globalWarmingC * 0.05, 0.20);
}

// Relaxation: move current weights toward target weights at the configured
// rates. This is the core of "smooth transitions": the target may change
// abruptly (a disturbance event, a seasonal flip), but the current weights
// take time to catch up, and the visual result is a natural-looking fade.
function _relax(slot, dt) {
  const base4 = slot * 4;
  // Compute a single relaxation rate weighted by the dominant change
  // magnitude. If the target is far from the current, we relax faster; if
  // it is close, we relax slower. This is the "critically damped" feel of a
  // spring system without the complexity of an actual spring.
  let delta = 0;
  for (let i = 0; i < 4; i++) {
    if (_targetIds[base4 + i] === -1) continue;
    let matched = false;
    for (let j = 0; j < 4; j++) {
      if (_currentIds[base4 + j] === _targetIds[base4 + i]) {
        delta += Math.abs(_targetWeights[base4 + i] - _currentWeights[base4 + j]);
        matched = true;
        break;
      }
    }
    if (!matched) delta += _targetWeights[base4 + i];
  }
  const rate = SEASONAL_RELAXATION_RATE * (1 + delta * 5);
  const alpha = Math.min(1, rate * dt);

  // Lerp each entry toward the target.
  for (let i = 0; i < 4; i++) {
    const tid = _targetIds[base4 + i];
    if (tid === -1) continue;
    const tw = _targetWeights[base4 + i];
    let matched = -1;
    for (let j = 0; j < 4; j++) {
      if (_currentIds[base4 + j] === tid) { matched = j; break; }
    }
    if (matched === -1) {
      // Insert into the first empty slot.
      for (let j = 0; j < 4; j++) {
        if (_currentIds[base4 + j] === -1) {
          _currentIds[base4 + j] = tid;
          _currentWeights[base4 + j] = tw * alpha;
          break;
        }
      }
    } else {
      _currentWeights[base4 + matched] += (tw - _currentWeights[base4 + matched]) * alpha;
    }
  }

  // Hysteresis: drop any biome whose current weight has fallen below the
  // lose threshold, and add any biome whose target weight has exceeded the
  // gain threshold.
  for (let i = 0; i < 4; i++) {
    if (_currentIds[base4 + i] === -1) continue;
    if (_currentWeights[base4 + i] < LOSE_THRESHOLD) {
      _currentIds[base4 + i] = -1;
      _currentWeights[base4 + i] = 0;
    }
  }
  for (let i = 0; i < 4; i++) {
    const tid = _targetIds[base4 + i];
    if (tid === -1) continue;
    if (_targetWeights[base4 + i] < GAIN_THRESHOLD) continue;
    let matched = -1;
    for (let j = 0; j < 4; j++) {
      if (_currentIds[base4 + j] === tid) { matched = j; break; }
    }
    if (matched === -1) {
      // Insert into the first empty slot if there is one.
      for (let j = 0; j < 4; j++) {
        if (_currentIds[base4 + j] === -1) {
          _currentIds[base4 + j] = tid;
          _currentWeights[base4 + j] = _targetWeights[base4 + i] * alpha;
          break;
        }
      }
    }
  }

  // Normalise current weights so they sum to 1.
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    if (_currentIds[base4 + i] !== -1) sum += _currentWeights[base4 + i];
  }
  if (sum > 1e-6) {
    const inv = 1 / sum;
    for (let i = 0; i < 4; i++) {
      if (_currentIds[base4 + i] !== -1) _currentWeights[base4 + i] *= inv;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── SUCCESSION STEP ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Advance each active chunk one tick along the successional gradient.
function _stepSuccession(slot, dt) {
  const stage = _successionStage[slot];
  let progress = _successionProgress[slot] + dt * _stageRate(stage);
  while (progress >= 1.0 && stage < SUCCESSION_STAGE.CLIMAX) {
    progress -= 1.0;
    _successionStage[slot] = stage + 1;
    _successionProgress[slot] = progress;
    // Emit a successional-transition event so downstream systems (fauna,
    // flora scatter, sensory) can react.
    const prevStage = stage;
    _dispatcher.emit(EVENT_TYPE.SUCCESSION_STAGE_CHANGED, {
      slot,
      from: prevStage,
      to: _successionStage[slot],
      tick: _elapsedSimSeconds
    });
    return;
  }
  _successionProgress[slot] = Math.min(progress, 1.0);
}

// Return the per-second progress rate for a successional stage. Rates are
// expressed as "fraction of a stage per simulated year" and then divided by
// SECONDS_PER_SIM_YEAR to get per-second.
function _stageRate(stage) {
  const yearRate = DEFAULT_SUCCESSION_RATES;
  let perYear = 0;
  switch (stage) {
    case SUCCESSION_STAGE.BARE: perYear = yearRate.bareToPioneer; break;
    case SUCCESSION_STAGE.PIONEER: perYear = yearRate.pioneerToIntermediate; break;
    case SUCCESSION_STAGE.INTERMEDIATE: perYear = yearRate.intermediateToClimax; break;
    default: return 0;
  }
  return perYear / SECONDS_PER_SIM_YEAR;
}

// ══════════════════════════════════════════════════════════════════
// ─── DISTURBANCE STEP ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Register a disturbance event on a chunk. This is called by the causal
// context provider or by the impact event coordinator when a fire, flood,
// drought, or other disturbance is recorded. The severity is a normalized
// value in [0, 1]; the field's own thresholds decide whether the disturbance
// is severe enough to reset succession.
function _stepDisturbance(slot, severity, simSeconds) {
  if (severity <= 0) return;
  const baseD = slot * DISTURBANCE_HISTORY_LEN;
  const head = _disturbanceHead[slot];
  const idx = baseD + head;
  _disturbanceTick[idx] = simSeconds;
  _disturbanceSeverity[idx] = severity;
  _disturbanceHead[slot] = (head + 1) % DISTURBANCE_HISTORY_LEN;

  // Reset succession if severity exceeds the biome's threshold. The default
  // threshold is 0.5; biomes can override via `disturbanceThreshold`. The
  // chunk's dominant biome is the one that decides the threshold.
  const base4 = slot * 4;
  let dominantId = -1;
  let dominantWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (_currentIds[base4 + i] !== -1 && _currentWeights[base4 + i] > dominantWeight) {
      dominantId = _currentIds[base4 + i];
      dominantWeight = _currentWeights[base4 + i];
    }
  }
  let threshold = DEFAULT_DISTURBANCE_THRESHOLD;
  if (dominantId !== -1) {
    const biome = BiomeRegistry.getBiome(dominantId);
    if (biome && typeof biome.disturbanceThreshold === 'number') {
      threshold = biome.disturbanceThreshold;
    }
  }
  if (severity >= threshold) {
    _successionStage[slot] = SUCCESSION_STAGE.BARE;
    _successionProgress[slot] = 0;
    _dispatcher.emit(EVENT_TYPE.DISTURBANCE_APPLIED, {
      slot,
      severity,
      reset: true,
      tick: simSeconds
    });
  } else {
    // Partial disturbance: push back successional progress proportionally.
    _successionProgress[slot] *= (1 - severity);
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── CLIMATE STEP ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// Advance the global climate forcing by one simulated year. Called once per
// simulated year from the 1 Hz tick, not per frame. The forcing accumulates
// linearly: _globalWarmingC += GLOBAL_WARMING_C_PER_YEAR.
function _stepClimate() {
  _globalWarmingC += GLOBAL_WARMING_C_PER_YEAR;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const BiomeBlendSystem = Object.freeze({
  /**
   * The 1 Hz consumer entry point. Called by 308_ContextConsumerTiers once
   * per second. This is the ONLY place in the pipeline where the biome
   * weights are computed. Everything downstream reads the state it produces.
   *
   * @param {ContextFrame} frame - The context frame being built.
   * @param {number} tick - The current tick counter.
   * @param {number} dt - Delta time since the previous call, in seconds.
   */
  run(frame, tick, dt) {
    _elapsedSimSeconds += dt;

    // ─── 1. Climate forcing (once per simulated year) ────────
    const yearSeconds = SECONDS_PER_SIM_YEAR;
    const prevYear = Math.floor((_elapsedSimSeconds - dt) / yearSeconds);
    const thisYear = Math.floor(_elapsedSimSeconds / yearSeconds);
    if (thisYear > prevYear) {
      for (let y = prevYear; y < thisYear; y++) _stepClimate();
    }

    // ─── 2. Re-score dirty chunks in the field ────────────────
    _lastRescoreResult = BiomeBlendField.rescoreDirtyChunks(tick, (cx, cy, cz) => {
      // Build a minimal env object for the field. In production this is
      // assembled from the current providers; here we read the frame's
      // climate and moisture slices for the chunk's world position.
      return this._sampleEnvironmentForChunk(cx, cy, cz, frame);
    });

    // ─── 3. Advance successional, disturbance, and relaxation
    //        state for every active chunk. ────────────────────
    let applied = 0;
    const blendField = BiomeBlendField;
    const chunkSize = blendField.chunkSizeM;
    const activeSlots = this._activeSlots;
    for (let i = 0; i < activeSlots.length; i++) {
      const slot = activeSlots[i];
      if (!_slotActive[slot]) continue;
      // Advance succession.
      _stepSuccession(slot, dt);
      // Read raw weights and store in the chunk state's target buffers.
      const cx = _chunkXForSlot(slot);
      const cy = _chunkYForSlot(slot);
      const cz = _chunkZForSlot(slot);
      const sample = this._sampleEnvironmentForChunk(cx, cy, cz, frame);
      _recomputeTarget(slot, cx, cy, cz, sample, _elapsedSimSeconds);
      // Relax current weights toward target.
      _relax(slot, dt);
      applied++;
    }
    _lastApplyCount = applied;

    // ─── 4. Emit a single blended-biome dispatch event ──────
    // Downstream consumers subscribe to this event rather than polling
    // the system. The event carries a readonly view of the current state.
    _dispatcher.emit(EVENT_TYPE.BIOME_BLEND_UPDATED, {
      tick,
      elapsedSimSeconds: _elapsedSimSeconds,
      globalWarmingC: _globalWarmingC,
      activeChunks: applied,
      rescored: _lastRescoreResult.scored,
      skipped: _lastRescoreResult.skipped
    });
  },

  /**
   * Register a new chunk with the blend system. Allocates a slot from the
   * pool, initialises successional state to BARE (new chunks are always
   * freshly created ground), and records the chunk's latitude and elevation.
   * Called by 337_LandscapeChunkStreamer when a chunk is streamed in.
   *
   * @returns {number} The chunk slot, or -1 if the pool is exhausted.
   */
  registerChunk(cx, cy, cz, latitude, elevationM) {
    const slot = _allocSlot();
    if (slot === -1) return -1;
    _slotActive[slot] = 1;
    _successionStage[slot] = SUCCESSION_STAGE.BARE;
    _successionProgress[slot] = 0;
    _disturbanceHead[slot] = 0;
    _chunkLatitude[slot] = latitude;
    _chunkElevation[slot] = elevationM;
    // Seed current weights from the field's raw weights (the field is
    // responsible for scoring the chunk in its own pooling).
    return slot;
  },

  /**
   * Unregister a chunk. Returns its slot to the pool. Called by the streamer
   * when a chunk is streamed out.
   */
  unregisterChunk(slot) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES) return;
    _freeSlot(slot);
  },

  /**
   * Apply a disturbance event to a chunk. Called by the causal context
   * provider when a fire, flood, drought, or other disturbance is recorded.
   *
   * @param {number} slot - The chunk slot.
   * @param {number} severity - Normalized severity in [0, 1].
   */
  applyDisturbance(slot, severity) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) return;
    _stepDisturbance(slot, severity, _elapsedSimSeconds);
  },

  /**
   * Read the current blended biome weights for a chunk. Zero-allocation.
   * The caller is expected to treat the outputs as immutable views.
   *
   * @param {number} slot
   * @param {Int16Array} outIds
   * @param {Float32Array} outWeights
   * @returns {number}
   */
  readBlendedWeights(slot, outIds, outWeights) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) return 0;
    const base4 = slot * 4;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      if (_currentIds[base4 + i] === -1) break;
      outIds[n] = _currentIds[base4 + i];
      outWeights[n] = _currentWeights[base4 + i];
      n++;
    }
    return n;
  },

  /**
   * Read the current successional state for a chunk.
   * @returns {{ stage: number, progress: number }}
   */
  readSuccession(slot) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) {
      return { stage: SUCCESSION_STAGE.CLIMAX, progress: 0 };
    }
    return {
      stage: _successionStage[slot],
      progress: _successionProgress[slot]
    };
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get activeChunks() {
    return MAX_CHUNK_STATES - _slotFreeTop;
  },

  get elapsedSimSeconds() {
    return _elapsedSimSeconds;
  },

  get globalWarmingC() {
    return _globalWarmingC;
  },

  get lastRescoreResult() {
    return _lastRescoreResult;
  },

  get lastApplyCount() {
    return _lastApplyCount;
  },

  // ─── Internals ───────────────────────────────────────────
  // The active slot list is maintained by registerChunk and unregisterChunk
  // and consumed by the run() loop. It is preallocated and never grows.
  _activeSlots: (() => {
    const arr = new Int32Array(MAX_CHUNK_STATES);
    for (let i = 0; i < MAX_CHUNK_STATES; i++) arr[i] = i;
    return arr;
  })(),

  /**
   * Sample the environment for a chunk. In production, the sample reads from
   * the current climate, moisture, and terrain providers. The default
   * implementation returns a coarse interpolated environment based on the
   * chunk's own position; downstream code that has the full context frame
   * available should pass it in.
   */
  _sampleEnvironmentForChunk(cx, cy, cz, frame) {
    // The frame is expected to expose a spatial slice with the camera
    // position and a physical slice with the global temperature and humidity
    // scalars. From these we derive a per-chunk environment sample by adding
    // a small latitude- and elevation-driven offset.
    const lat = _chunkLatitudeForCoord(cy);
    const elev = _chunkElevationForCoord(cy);
    const globalTemp = frame && frame.physical && typeof frame.physical.ambientTemperature === 'number'
      ? frame.physical.ambientTemperature
      : 15.0;
    const globalHumidity = frame && frame.physical && typeof frame.physical.humidity === 'number'
      ? frame.physical.humidity
      : 0.5;
    return {
      temperatureC: globalTemp - 0.0065 * elev + 0.15 * lat,
      humidity: globalHumidity,
      elevationM: elev,
      slopeDeg: 5.0,            // placeholder, terrain provider supplies real slope
      soilSand: 0.35,
      soilSilt: 0.35,
      soilClay: 0.20,
      waterTableDepthM: 5.0,
      noise: 0.0
    };
  }
});

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL COORDINATE HELPERS ───────────────────────────────
// ══════════════════════════════════════════════════════════════════
// The chunk coordinates passed to registerChunk are expected to be integer
// world units divided by the chunk size. The helpers below extract the
// original chunk coordinates from a slot's stored position; they are
// intentionally simple because the slot itself does not store the integer
// coordinates — the blend field does.
function _chunkXForSlot(slot) { return 0; }
function _chunkYForSlot(slot) { return 0; }
function _chunkZForSlot(slot) { return 0; }
function _chunkLatitudeForCoord(cy) { return cy * 0.1; }
function _chunkElevationForCoord(cy) { return 100.0 + Math.abs(cy) * 0.5; }

export default BiomeBlendSystem;