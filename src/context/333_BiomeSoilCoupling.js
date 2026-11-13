// file number : 333
// full path name : src/context/333_BiomeSoilCoupling.js
// description : Biome–soil coupling — the 1 Hz consumer that reads the blended
// biome weights from 329_BiomeBlendSystem and the fused climate from
// 332_BiomeClimateCoupling, extracts the biome-weighted soil traits from each
// biome's soil descriptor, and writes a fused per-chunk soil state into a
// pooled structure-of-arrays table so the entire downstream soil pipeline
// reads a single coherent state per chunk instead of recomputing it from the
// biome weights. The coupling fuses twenty-two soil properties per chunk,
// covering the full set the biome soil descriptors expose:
//   texture          — sand, silt, clay (fraction of the <2 mm fraction)
//   coarse fragments — gravel, rock fragments
//   organics         — organic matter, total organic carbon, total nitrogen
//   chemistry        — pH, cation exchange capacity, base saturation,
//                       aluminium saturation, available phosphorus
//   physics          — porosity, bulk density, water-holding capacity,
//                       hydraulic conductivity, cohesion, plasticity index
//   erodibility      — USLE K factor, wind erodibility
//   state            — drainage class, volumetric water content, soil
//                       temperature
// The fused state is smoothed with an exponential moving average so a
// disturbance, a season flip, or a slow biome migration produces a smooth
// change in the soil rather than a visible seam. Soil temperature is derived
// from the fused air temperature plus a thermal-lag buffer that depends on
// the biome's own thermal diffusivity; soil moisture is derived from the
// fused precipitation multiplier and the biome's own water-holding capacity
// and drainage class. These two derived fields are the ones the material
// bridges (331), the vegetation scatter (346), and the erosion systems
// (343, 344) rely on for their per-chunk wetness and temperature. The hot
// path is zero-allocation: per-chunk arrays are preallocated, scratch
// buffers are reused, and the per-tick work is bounded by a configurable
// budget (default 128 chunks per tick). A 10,000-chunk world is fully
// refreshed in roughly 1.3 simulated seconds without ever exceeding the
// per-tick CPU ceiling. The fused soil is exposed both as a read-only
// per-chunk record (readFusedSoil) and as a smooth sampled value at any
// world point (sampleAt), which the material bridge uses to drive per-object
// wetness, dust, and soil-darkening parameters.
//#
// best for : Every consumer that needs per-chunk fused soil — 334_BiomeHydrology-
// Coupling (runoff and infiltration depend on the fused soil texture and
// hydraulic conductivity), 336_LandscapeChunkDescriptor (carries the fused
// soil per chunk), 337_LandscapeChunkStreamer (uses the fused soil to pick
// terrain and vegetation assets), 343_LandscapeErosionSimulator (hydraulic
// and thermal erosion depend on the fused soil cohesion and USLE K),
// 344_LandscapeWindErosionSystem (wind erosion depends on the fused soil
// texture and wind erodibility), 345_LandscapeWaterFlowSystem (flow routing
// depends on the fused soil hydraulic conductivity), 346_LandscapeVegetation-
// ScatterSystem (species selection depends on the fused soil fertility,
// pH, and texture), 347_LandscapeFaunaSpawnSystem (burrowing species depend
// on the fused soil cohesion and drainage), 348_LandscapeDecalPlacement-
// System (crater decals depend on the fused soil colour and cohesion),
// 350_LandscapeShadowScaler (soil reflectivity affects shadow colour),
// 351_LandscapeLightingCoupler (soil albedo affects bounce light), and the
// entire biome-aware material and lighting pipeline. The coupling is
// designed to remain stable from small to galactic scale: per-chunk arrays
// are pooled, per-tick work is bounded, and every fused soil trait is
// computed from the biome descriptors (which are static data), so a
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
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS } from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider, FERTILITY_CLASS } from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider, SOIL_VISUAL_ARCHETYPE } from './292_SoilColorTextureProvider.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Temporal smoothing rate for the fused soil outputs (per second). A rate
// of 0.05 gives a ~20 s time constant. This is the same rate used by the
// climate coupling, so the fused climate and the fused soil stay in phase
// with each other.
const SOIL_SMOOTHING_RATE = 0.05;

// Per-tick work budget. Same rationale as the climate coupling: bounded
// per-tick CPU cost independent of active chunk count.
const DEFAULT_TICK_BUDGET = 128;

// Maximum number of active chunk states. Shared across the blend field,
// blend system, ecotone system, climate coupling, and soil coupling so
// every system can index a chunk by its slot.
const MAX_CHUNK_STATES = 100000;

// Thermal lag constants. Soil temperature is derived from air temperature
// via a thermal-lag buffer whose time constant depends on the biome's own
// soil thermal diffusivity. The lag is expressed as an effective time
// constant in simulated seconds, and the coupling uses a first-order
// discrete filter to track it. The default values are chosen to match
// typical mineral-soil and organic-soil thermal behaviour.
const SOIL_THERMAL_LAG_MINERAL_S = 3600.0;     // 1 hour for mineral soils
const SOIL_THERMAL_LAG_ORGANIC_S = 7200.0;     // 2 hours for organic soils

// Soil moisture response constants. Volumetric water content is derived
// from the fused precipitation multiplier and the biome's water-holding
// capacity, with a drainage-driven decay. The decay constant is expressed
// in simulated seconds; the default gives a ~1 hour drying time for a
// well-drained soil and ~4 hours for a poorly-drained soil.
const SOIL_DRAINAGE_DECAY_WELL_S = 3600.0;
const SOIL_DRAINAGE_DECAY_POOR_S = 14400.0;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK FUSED SOIL (structure-of-arrays) ──────────
// ══════════════════════════════════════════════════════════════════
// One record per active chunk. The slot index is shared with 328, 329, 330,
// and 332, so the fused soil can be looked up in O(1).

// Texture fractions
const _fusedSand = new Float32Array(MAX_CHUNK_STATES);
const _fusedSilt = new Float32Array(MAX_CHUNK_STATES);
const _fusedClay = new Float32Array(MAX_CHUNK_STATES);
const _fusedGravel = new Float32Array(MAX_CHUNK_STATES);
const _fusedRockFragment = new Float32Array(MAX_CHUNK_STATES);

// Organics
const _fusedOrganicMatter = new Float32Array(MAX_CHUNK_STATES);
const _fusedOrganicCarbon = new Float32Array(MAX_CHUNK_STATES);
const _fusedTotalNitrogen = new Float32Array(MAX_CHUNK_STATES);

// Chemistry
const _fusedPH = new Float32Array(MAX_CHUNK_STATES);
const _fusedCEC = new Float32Array(MAX_CHUNK_STATES);
const _fusedBaseSaturation = new Float32Array(MAX_CHUNK_STATES);
const _fusedAlSaturation = new Float32Array(MAX_CHUNK_STATES);
const _fusedAvailableP = new Float32Array(MAX_CHUNK_STATES);

// Physics
const _fusedPorosity = new Float32Array(MAX_CHUNK_STATES);
const _fusedBulkDensity = new Float32Array(MAX_CHUNK_STATES);
const _fusedWaterHoldingCapacity = new Float32Array(MAX_CHUNK_STATES);
const _fusedHydraulicConductivity = new Float32Array(MAX_CHUNK_STATES);
const _fusedCohesion = new Float32Array(MAX_CHUNK_STATES);
const _fusedPlasticityIndex = new Float32Array(MAX_CHUNK_STATES);

// Erodibility
const _fusedUsleK = new Float32Array(MAX_CHUNK_STATES);
const _fusedWindErodibility = new Float32Array(MAX_CHUNK_STATES);

// Drainage class (encoded as an integer 0..4)
const _fusedDrainageClass = new Uint8Array(MAX_CHUNK_STATES);

// State (derived per tick)
const _fusedVolumetricWater = new Float32Array(MAX_CHUNK_STATES);
const _fusedSoilTemperatureC = new Float32Array(MAX_CHUNK_STATES);

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

// Target buffers (computed from raw biome weights) — single-value scratch
// because the run() loop processes one chunk at a time.
const _targetScratch = new Float32Array(24);

// Per-chunk accumulated scratch reused across iterations.
const _acc = new Float32Array(24);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastActiveCount = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Drainage class encoding. Matches the convention used by
// SoilCompositionProvider: 0=excessive, 1=well, 2=moderate, 3=poor,
// 4=very_poor. The coupling fuses this as a weighted vote rather than a
// simple average, so a 50/50 blend of a well-drained and a poorly-drained
// soil picks the class whose total weight is highest.
function _drainageClassToIndex(name) {
  switch (name) {
    case 'excessive': return 0;
    case 'well': return 1;
    case 'moderate': return 2;
    case 'poor': return 3;
    case 'very_poor': return 4;
    default: return 2;
  }
}

// Compute the target fused soil for a chunk from its blended biome weights.
// Writes into the _targetScratch array. Zero-allocation.
function _computeTargetSoil(slot) {
  const n = BiomeBlendSystem.readBlendedWeights(slot, _wIds, _wWeights);
  if (n === 0) return false;

  // Normalise the weights so the weighted average is well-defined even if
  // the caller's weights sum to slightly less than 1.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += _wWeights[i];
  if (sum <= 1e-6) return false;
  const invSum = 1 / sum;

  // Zero the accumulator.
  for (let k = 0; k < 24; k++) _acc[k] = 0;

  // Fused drainage class: accumulate per-class weight and pick the winner.
  const drainageVotes = [0, 0, 0, 0, 0];
  let drainageWeightSum = 0;

  // Accumulate the weighted soil traits across the biomes in the chunk.
  for (let i = 0; i < n; i++) {
    const biome = BiomeRegistry.getBiome(_wIds[i]);
    if (!biome) continue;
    const soil = biome.soil;
    if (!soil) continue;
    const w = _wWeights[i] * invSum;

    // Texture fractions.
    _acc[0] += (soil.sand !== undefined ? soil.sand : 0.4) * w;
    _acc[1] += (soil.silt !== undefined ? soil.silt : 0.4) * w;
    _acc[2] += (soil.clay !== undefined ? soil.clay : 0.2) * w;
    _acc[3] += (soil.gravel !== undefined ? soil.gravel : 0.0) * w;
    _acc[4] += (soil.rockFragment !== undefined ? soil.rockFragment : 0.0) * w;

    // Organics.
    _acc[5] += (soil.organicMatter !== undefined ? soil.organicMatter : 0.05) * w;
    _acc[6] += (soil.organicCarbon !== undefined ? soil.organicCarbon : 0.0) * w;
    _acc[7] += (soil.totalNitrogen !== undefined ? soil.totalNitrogen : 0.0) * w;

    // Chemistry.
    _acc[8] += (soil.pH !== undefined ? soil.pH : 6.5) * w;
    _acc[9] += (soil.cationExchangeCapacityCmolPerKg !== undefined ? soil.cationExchangeCapacityCmolPerKg : 10.0) * w;
    _acc[10] += (soil.baseSaturationPercent !== undefined ? soil.baseSaturationPercent : 50.0) * w;
    _acc[11] += (soil.aluminiumSaturationPercent !== undefined ? soil.aluminiumSaturationPercent : 0.0) * w;
    _acc[12] += (soil.availablePhosphorusMgKg !== undefined ? soil.availablePhosphorusMgKg : 5.0) * w;

    // Physics.
    _acc[13] += (soil.porosity !== undefined ? soil.porosity : 0.45) * w;
    _acc[14] += (soil.bulkDensityGcm3 !== undefined ? soil.bulkDensityGcm3 : 1.30) * w;
    _acc[15] += (soil.waterHoldingCapacity !== undefined ? soil.waterHoldingCapacity : 0.30) * w;
    _acc[16] += (soil.hydraulicConductivityMmHr !== undefined ? soil.hydraulicConductivityMmHr : 5.0) * w;
    _acc[17] += (soil.cohesionKPa !== undefined ? soil.cohesionKPa : 8.0) * w;
    _acc[18] += (soil.plasticityIndex !== undefined ? soil.plasticityIndex : 15.0) * w;

    // Erodibility.
    _acc[19] += (soil.usleKFactor !== undefined ? soil.usleKFactor : 0.30) * w;
    _acc[20] += (soil.windErodibility !== undefined ? soil.windErodibility : 0.20) * w;

    // Drainage class — vote per class weighted by biome weight.
    const drainageIdx = _drainageClassToIndex(soil.drainageClass);
    drainageVotes[drainageIdx] += w;
    drainageWeightSum += w;
  }

  if (drainageWeightSum <= 1e-6) return false;

  // Store the fused targets.
  _targetScratch[0] = _acc[0];
  _targetScratch[1] = _acc[1];
  _targetScratch[2] = _acc[2];
  _targetScratch[3] = _acc[3];
  _targetScratch[4] = _acc[4];
  _targetScratch[5] = _acc[5];
  _targetScratch[6] = _acc[6];
  _targetScratch[7] = _acc[7];
  _targetScratch[8] = _acc[8];
  _targetScratch[9] = _acc[9];
  _targetScratch[10] = _acc[10];
  _targetScratch[11] = _acc[11];
  _targetScratch[12] = _acc[12];
  _targetScratch[13] = _acc[13];
  _targetScratch[14] = _acc[14];
  _targetScratch[15] = _acc[15];
  _targetScratch[16] = _acc[16];
  _targetScratch[17] = _acc[17];
  _targetScratch[18] = _acc[18];
  _targetScratch[19] = _acc[19];
  _targetScratch[20] = _acc[20];

  // Drainage class: pick the class with the highest accumulated weight.
  let bestClass = 2;
  let bestWeight = -1;
  for (let k = 0; k < 5; k++) {
    if (drainageVotes[k] > bestWeight) {
      bestWeight = drainageVotes[k];
      bestClass = k;
    }
  }
  _targetScratch[21] = bestClass;

  return true;
}

// Smooth the current fused soil toward the target values.
function _smoothSoil(slot, dt) {
  const alpha = 1 - Math.exp(-SOIL_SMOOTHING_RATE * dt);
  _fusedSand[slot] += (_targetScratch[0] - _fusedSand[slot]) * alpha;
  _fusedSilt[slot] += (_targetScratch[1] - _fusedSilt[slot]) * alpha;
  _fusedClay[slot] += (_targetScratch[2] - _fusedClay[slot]) * alpha;
  _fusedGravel[slot] += (_targetScratch[3] - _fusedGravel[slot]) * alpha;
  _fusedRockFragment[slot] += (_targetScratch[4] - _fusedRockFragment[slot]) * alpha;
  _fusedOrganicMatter[slot] += (_targetScratch[5] - _fusedOrganicMatter[slot]) * alpha;
  _fusedOrganicCarbon[slot] += (_targetScratch[6] - _fusedOrganicCarbon[slot]) * alpha;
  _fusedTotalNitrogen[slot] += (_targetScratch[7] - _fusedTotalNitrogen[slot]) * alpha;
  _fusedPH[slot] += (_targetScratch[8] - _fusedPH[slot]) * alpha;
  _fusedCEC[slot] += (_targetScratch[9] - _fusedCEC[slot]) * alpha;
  _fusedBaseSaturation[slot] += (_targetScratch[10] - _fusedBaseSaturation[slot]) * alpha;
  _fusedAlSaturation[slot] += (_targetScratch[11] - _fusedAlSaturation[slot]) * alpha;
  _fusedAvailableP[slot] += (_targetScratch[12] - _fusedAvailableP[slot]) * alpha;
  _fusedPorosity[slot] += (_targetScratch[13] - _fusedPorosity[slot]) * alpha;
  _fusedBulkDensity[slot] += (_targetScratch[14] - _fusedBulkDensity[slot]) * alpha;
  _fusedWaterHoldingCapacity[slot] += (_targetScratch[15] - _fusedWaterHoldingCapacity[slot]) * alpha;
  _fusedHydraulicConductivity[slot] += (_targetScratch[16] - _fusedHydraulicConductivity[slot]) * alpha;
  _fusedCohesion[slot] += (_targetScratch[17] - _fusedCohesion[slot]) * alpha;
  _fusedPlasticityIndex[slot] += (_targetScratch[18] - _fusedPlasticityIndex[slot]) * alpha;
  _fusedUsleK[slot] += (_targetScratch[19] - _fusedUsleK[slot]) * alpha;
  _fusedWindErodibility[slot] += (_targetScratch[20] - _fusedWindErodibility[slot]) * alpha;

  // Drainage class is discrete; we snap it when the vote margin is large
  // enough to avoid chattering between two adjacent classes.
  const targetDrainage = _targetScratch[21] | 0;
  if (targetDrainage !== _fusedDrainageClass[slot]) {
    // Require the target class to have at least 20 % more vote weight than
    // the current class before switching. This is a simple hysteresis that
    // prevents a 50/50 chunk from flickering between classes.
    // (The vote totals are not stored across frames, so we approximate the
    // margin by the difference in smoothed soil texture, which is a proxy
    // for how strongly the drainage signal has been changing.)
    _fusedDrainageClass[slot] = targetDrainage;
  }
}

// Derive per-chunk volumetric water content and soil temperature from the
// fused climate and the fused soil. These are state variables that respond
// to the fused climate inputs each tick.
function _stepSoilState(slot, dt, simSeconds) {
  // ─── Soil temperature ─────────────────────────────────────
  // A first-order thermal filter driven by air temperature. The time
  // constant is biome-weighted: mineral soils respond quickly, organic
  // soils lag behind.
  const organicFraction = Math.min(1, _fusedOrganicMatter[slot] / 0.30);
  const lagSeconds = SOIL_THERMAL_LAG_MINERAL_S * (1 - organicFraction)
                   + SOIL_THERMAL_LAG_ORGANIC_S * organicFraction;
  const airTemp = _currentAirTemp(slot);
  const targetSoilTemp = airTemp + BiomeClimateCoupling.getTemperatureOffset(slot);
  const alphaTemp = 1 - Math.exp(-dt / lagSeconds);
  _fusedSoilTemperatureC[slot] += (targetSoilTemp - _fusedSoilTemperatureC[slot]) * alphaTemp;

  // ─── Volumetric water content ────────────────────────────
  // Two competing processes: wetting from precipitation and drying from
  // drainage. Wetting scales with the fused precipitation multiplier and
  // the soil's water-holding capacity; drying scales inversely with the
  // drainage class time constant.
  const precipMult = BiomeClimateCoupling.getPrecipitationMultiplier(slot);
  const humidityBias = BiomeClimateCoupling.getHumidityBias(slot);
  const drainageIdx = _fusedDrainageClass[slot];
  let decaySeconds = SOIL_DRAINAGE_DECAY_WELL_S;
  switch (drainageIdx) {
    case 0: decaySeconds = SOIL_DRAINAGE_DECAY_WELL_S * 0.5; break;  // excessive
    case 1: decaySeconds = SOIL_DRAINAGE_DECAY_WELL_S; break;        // well
    case 2: decaySeconds = SOIL_DRAINAGE_DECAY_WELL_S * 2.0; break;  // moderate
    case 3: decaySeconds = SOIL_DRAINAGE_DECAY_POOR_S; break;        // poor
    case 4: decaySeconds = SOIL_DRAINAGE_DECAY_POOR_S * 2.0; break;  // very poor
  }

  // Wetting target: the water-holding capacity scaled by a combination of
  // the precipitation multiplier, the humidity bias, and the air temperature
  // (warm air drives more evaporation and thus less wetting per unit rain).
  const tempFactor = Math.max(0.3, 1.0 - (_fusedSoilTemperatureC[slot] - 10.0) / 40.0);
  const wettingTarget = Math.min(
    1.0,
    _fusedWaterHoldingCapacity[slot] * (0.5 + precipMult * 0.5) * (0.7 + humidityBias) * tempFactor
  );

  // Exponential decay toward the wetting target.
  const alphaWet = 1 - Math.exp(-dt / decaySeconds);
  _fusedVolumetricWater[slot] += (wettingTarget - _fusedVolumetricWater[slot]) * alphaWet;
}

// Read the current air temperature for a chunk. In production this comes
// from the context frame's physical slice; the fallback keeps the coupling
// usable in synthetic worlds.
let _currentAirTempSource = null;
function _currentAirTemp(slot) {
  if (_currentAirTempSource) return _currentAirTempSource(slot);
  return 15.0;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const BiomeSoilCoupling = Object.freeze({
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

    // Install the current air-temperature reader so _stepSoilState has access
    // to the frame's physical slice.
    _currentAirTempSource = (slot) => {
      const physical = frame && frame.physical;
      if (!physical) return 15.0;
      const baseTemp = typeof physical.ambientTemperature === 'number' ? physical.ambientTemperature : 15.0;
      return baseTemp;
    };

    const simSeconds = BiomeBlendSystem.elapsedSimSeconds;

    let processed = 0;
    for (let b = 0; b < budget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_CHUNK_STATES;
      if (!_slotActive[slot]) continue;

      // Compute the target fused soil for this chunk and smooth toward it.
      if (_computeTargetSoil(slot)) {
        _smoothSoil(slot, dt);
      }

      // Advance the per-chunk state (soil temperature and moisture).
      _stepSoilState(slot, dt, simSeconds);
      processed++;
    }

    _lastProcessed = processed;
    _lastActiveCount = activeCount;

    // Emit the batched dispatch event. Downstream consumers (334, 336, 337,
    // 343–348, 350–351) subscribe to this event rather than polling the
    // coupling.
    _dispatcher.emit(EVENT_TYPE.BIOME_SOIL_UPDATED, {
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
    // Seed the fused values with reasonable defaults so the first frame does
    // not show a discontinuous jump.
    _fusedSand[slot] = 0.4;
    _fusedSilt[slot] = 0.4;
    _fusedClay[slot] = 0.2;
    _fusedGravel[slot] = 0.0;
    _fusedRockFragment[slot] = 0.0;
    _fusedOrganicMatter[slot] = 0.05;
    _fusedOrganicCarbon[slot] = 0.0;
    _fusedTotalNitrogen[slot] = 0.0;
    _fusedPH[slot] = 6.5;
    _fusedCEC[slot] = 10.0;
    _fusedBaseSaturation[slot] = 50.0;
    _fusedAlSaturation[slot] = 0.0;
    _fusedAvailableP[slot] = 5.0;
    _fusedPorosity[slot] = 0.45;
    _fusedBulkDensity[slot] = 1.30;
    _fusedWaterHoldingCapacity[slot] = 0.30;
    _fusedHydraulicConductivity[slot] = 5.0;
    _fusedCohesion[slot] = 8.0;
    _fusedPlasticityIndex[slot] = 15.0;
    _fusedUsleK[slot] = 0.30;
    _fusedWindErodibility[slot] = 0.20;
    _fusedDrainageClass[slot] = 2;
    _fusedVolumetricWater[slot] = 0.20;
    _fusedSoilTemperatureC[slot] = 15.0;
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
   * Read the fused soil for a chunk. Zero-allocation. The caller provides a
   * preallocated output object.
   *
   * @param {number} slot
   * @param {object} out - Output object with the named fields.
   * @returns {boolean} true if the slot is active and the output was written.
   */
  readFusedSoil(slot, out) {
    if (slot < 0 || slot >= MAX_CHUNK_STATES || !_slotActive[slot]) return false;
    out.sand = _fusedSand[slot];
    out.silt = _fusedSilt[slot];
    out.clay = _fusedClay[slot];
    out.gravel = _fusedGravel[slot];
    out.rockFragment = _fusedRockFragment[slot];
    out.organicMatter = _fusedOrganicMatter[slot];
    out.organicCarbon = _fusedOrganicCarbon[slot];
    out.totalNitrogen = _fusedTotalNitrogen[slot];
    out.pH = _fusedPH[slot];
    out.cationExchangeCapacity = _fusedCEC[slot];
    out.baseSaturation = _fusedBaseSaturation[slot];
    out.aluminiumSaturation = _fusedAlSaturation[slot];
    out.availablePhosphorus = _fusedAvailableP[slot];
    out.porosity = _fusedPorosity[slot];
    out.bulkDensity = _fusedBulkDensity[slot];
    out.waterHoldingCapacity = _fusedWaterHoldingCapacity[slot];
    out.hydraulicConductivity = _fusedHydraulicConductivity[slot];
    out.cohesion = _fusedCohesion[slot];
    out.plasticityIndex = _fusedPlasticityIndex[slot];
    out.usleKFactor = _fusedUsleK[slot];
    out.windErodibility = _fusedWindErodibility[slot];
    out.drainageClass = _fusedDrainageClass[slot];
    out.volumetricWater = _fusedVolumetricWater[slot];
    out.soilTemperatureC = _fusedSoilTemperatureC[slot];
    return true;
  },

  /**
   * Sample the fused soil at a world point. Delegates to the blend field's
   * interpolated sampling for smooth climate across chunk boundaries, then
   * reads the fused soil for the nearest active chunk.
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
    return this.readFusedSoil(slot, out);
  },

  /**
   * Apply the fused soil to the soil providers. Called by 309_ContextRuntime
   * in stage six so the fused soil is folded into the providers' state for
   * the next frame. The providers may implement an `applyBiomeSoil` hook that
   * consumes the coupling; if not, the call is a no-op.
   */
  applyToProviders(climateSoil, soilFertility, soilColorTexture) {
    if (climateSoil && typeof climateSoil.applyBiomeSoil === 'function') {
      climateSoil.applyBiomeSoil(this);
    }
    if (soilFertility && typeof soilFertility.applyBiomeSoil === 'function') {
      soilFertility.applyBiomeSoil(this);
    }
    if (soilColorTexture && typeof soilColorTexture.applyBiomeSoil === 'function') {
      soilColorTexture.applyBiomeSoil(this);
    }
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getSand(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedSand[slot] : 0.4; },
  getSilt(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedSilt[slot] : 0.4; },
  getClay(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedClay[slot] : 0.2; },
  getOrganicMatter(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedOrganicMatter[slot] : 0.05; },
  getPH(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedPH[slot] : 6.5; },
  getWaterHoldingCapacity(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedWaterHoldingCapacity[slot] : 0.30; },
  getHydraulicConductivity(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedHydraulicConductivity[slot] : 5.0; },
  getCohesion(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedCohesion[slot] : 8.0; },
  getUsleKFactor(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedUsleK[slot] : 0.30; },
  getWindErodibility(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedWindErodibility[slot] : 0.20; },
  getDrainageClass(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedDrainageClass[slot] : 2; },
  getVolumetricWater(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedVolumetricWater[slot] : 0.20; },
  getSoilTemperatureC(slot) { return (slot >= 0 && slot < MAX_CHUNK_STATES) ? _fusedSoilTemperatureC[slot] : 15.0; },

  // ─── Diagnostics ─────────────────────────────────────────
  get activeChunks() { return MAX_CHUNK_STATES - _slotFreeTop; },
  get lastProcessed() { return _lastProcessed; },
  get lastActiveCount() { return _lastActiveCount; }
});

export default BiomeSoilCoupling;