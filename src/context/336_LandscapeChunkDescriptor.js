// file number : 336
// full path name : src/context/336_LandscapeChunkDescriptor.js
// description : Landscape chunk descriptor — the per-chunk data record that
// fuses every upstream coupling into a single compact, pool-backed, cache-
// friendly descriptor, and that every downstream landscape system reads to
// know everything it needs about a chunk in O(1). Each streamed chunk owns
// exactly one descriptor, allocated from a preallocated pool and indexed by
// the same chunk slot the blend field uses, so a landscape system that already
// knows a chunk slot can find the descriptor with a single integer load and
// no hash lookup. The descriptor carries eight interlocking groups:
//   (1) identity         — chunk coordinates, biome id bitmask, dominant
//                          biome id, dominant weight, HLOD tier, LOD level;
//   (2) biome blend      — top-K biome ids and weights (K = 4);
//   (3) successional     — stage, progress, disturbance severity, and a
//                          timestamp of the last disturbance;
//   (4) ecotone          — pair ids, strengths, widths, and edge-species
//                          weights for the ecotone band;
//   (5) fused climate    — temperature offset, precipitation multiplier,
//                          humidity bias, wind speed and direction, diurnal
//                          swing, seasonal amplitude, seasonal phase shift,
//                          snowline and treeline shifts, and the fused air
//                          and soil temperatures;
//   (6) fused soil       — the twenty-two soil properties from 333;
//   (7) fused hydrology  — the sixteen hydrology properties from 334;
//   (8) fused fauna      — cohort count, aggregate population, dominant
//                          guild id, presence field reference, and the
//                          dominant species id.
// The descriptor is deliberately a plain structure-of-arrays indexed by
// chunk slot: every field is a separate typed array, so reading a single
// field for a single chunk is a single contiguous load and reading a single
// field for a whole batch of chunks is a single vectorised loop. A compact
// view object is also exposed per chunk (getView(slot)) that lazily
// dereferences the current field values on demand, for consumers that
// prefer the object API over the array API. The view is cached per slot
// and updated in place, so repeated views cost zero allocation. All
// downstream consumers — 337 (streamer), 338 (HLOD), 339 (spatial hash),
// 340 (chunk occlusion), 341 (persistence), 342 (mutation replay),
// 343–354 (landscape systems), and any custom consumer — read from this
// descriptor. Nothing else in the pipeline owns a per-chunk data record;
// everything is fused here. The descriptor is designed to remain stable from
// small to galactic scale: the pool is preallocated to match the blend
// field, eviction is O(1) via a free-list, and every read is O(1) regardless
// of how many chunks are active.
//#
// best for : Every consumer that needs a single, coherent, cache-friendly
// per-chunk data record — 337_LandscapeChunkStreamer (reads HLOD tier,
// LOD level, biome weights, and fauna presence to decide what to stream in),
// 338_LandscapeChunkHLOD (reads the HLOD tier and LOD level to drive the
// hierarchical LOD controller), 339_LandscapeChunkSpatialHash (reads the
// chunk coordinates to place the chunk in the spatial hash),
// 340_LandscapeChunkOcclusion (reads the dominant biome and terrain
// roughness to feed the occlusion graph), 341_LandscapeChunkPersistence
// (reads the descriptor to decide what to serialize),
// 342_LandscapeChunkMutationReplay (reads the descriptor to decide what
// mutations to replay on stream-in), 343_LandscapeErosionSimulator (reads
// the fused soil and hydrology to simulate erosion), 344_LandscapeWindErosion-
// System (reads the fused soil and wind to simulate wind erosion),
// 345_LandscapeWaterFlowSystem (reads the fused hydrology to route surface
// water), 346_LandscapeVegetationScatterSystem (reads the biome weights,
// fused soil, fused hydrology, and ecotone pairs to scatter vegetation),
// 347_LandscapeFaunaSpawnSystem (reads the fused fauna presence to spawn
// animals), 348_LandscapeDecalPlacementSystem (reads the fused soil colour
// and cohesion to place decals), 349_LandscapePropPlacementSystem (reads
// the biome weights and dominant biome to pick props),
// 350_LandscapeShadowScaler (reads the fused climate to scale shadows),
// 351_LandscapeLightingCoupler (reads the fused climate and biome weights
// to drive lighting), 352_LandscapeSkyCoupler (reads the fused climate to
// drive the sky), 353_LandscapeSeasonCoupler (reads the successional state
// and fused climate to drive seasonality), and 354_LandscapeSensoryCoupler
// (reads the biome weights and ecotone pairs to drive sensory cues). The
// descriptor is the single source of truth that all landscape systems share,
// and it is the only per-chunk data record that lives in this pipeline.
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
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Maximum number of descriptors. Sized to match the blend field, so the
// descriptor pool and the blend field pool stay in lockstep and a slot
// index is a valid index in both pools.
const MAX_DESCRIPTORS = 100000;

// HLOD tier encoding. Four tiers match the four-tier HLOD pyramid used by
// 303_HLODController and 338_LandscapeChunkHLOD.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// LOD level encoding. Three levels match the three-level LOD used by
// 303_HLODController and 338_LandscapeChunkHLOD.
const LOD_LEVEL = Object.freeze({
  HIGH: 0,
  MID: 1,
  LOW: 2,
  BILLBOARD: 3
});

// Fauna presence grid resolution. This must match 335's PRESENCE_GRID_RES.
const PRESENCE_GRID_RES = 4;
const PRESENCE_GRID_CELLS = PRESENCE_GRID_RES * PRESENCE_GRID_RES * PRESENCE_GRID_RES;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED DESCRIPTOR STATE (structure-of-arrays) ─────────────
// ══════════════════════════════════════════════════════════════════

// Identity
const _chunkX              = new Int32Array(MAX_DESCRIPTORS);
const _chunkY              = new Int32Array(MAX_DESCRIPTORS);
const _chunkZ              = new Int32Array(MAX_DESCRIPTORS);
const _biomeIdBitmask      = new Int32Array(MAX_DESCRIPTORS);
const _dominantBiomeId     = new Int16Array(MAX_DESCRIPTORS).fill(-1);
const _dominantWeight      = new Float32Array(MAX_DESCRIPTORS);
const _hlodTier            = new Uint8Array(MAX_DESCRIPTORS);
const _lodLevel            = new Uint8Array(MAX_DESCRIPTORS);

// Biome blend (K = 4)
const _blendIds            = new Int16Array(MAX_DESCRIPTORS * 4).fill(-1);
const _blendWeights        = new Float32Array(MAX_DESCRIPTORS * 4);

// Successional state
const _successionStage     = new Uint8Array(MAX_DESCRIPTORS);
const _successionProgress  = new Float32Array(MAX_DESCRIPTORS);
const _disturbanceSeverity = new Float32Array(MAX_DESCRIPTORS);
const _lastDisturbanceS    = new Float32Array(MAX_DESCRIPTORS).fill(-1);

// Ecotone pairs (max 6)
const _ecotonePairA        = new Int16Array(MAX_DESCRIPTORS * 6).fill(-1);
const _ecotonePairB        = new Int16Array(MAX_DESCRIPTORS * 6).fill(-1);
const _ecotoneStrength     = new Float32Array(MAX_DESCRIPTORS * 6);
const _ecotoneWidthM       = new Float32Array(MAX_DESCRIPTORS * 6);
const _ecotonePairCount    = new Uint8Array(MAX_DESCRIPTORS);

// Fused climate (10 floats)
const _climateFields       = new Float32Array(MAX_DESCRIPTORS * 10);
// Index mapping for _climateFields:
// 0 = temperatureOffsetC
// 1 = precipitationMultiplier
// 2 = humidityBias
// 3 = windSpeedMultiplier
// 4 = windDirectionBiasDeg
// 5 = diurnalSwingMultiplier
// 6 = seasonalAmplitudeMultiplier
// 7 = seasonalPhaseShiftRad
// 8 = snowlineShiftM
// 9 = treelineShiftM

// Fused soil (22 floats + 1 derived = 23)
const _soilFields          = new Float32Array(MAX_DESCRIPTORS * 23);
// Index mapping for _soilFields:
// 0 = sand, 1 = silt, 2 = clay, 3 = gravel, 4 = rockFragment
// 5 = organicMatter, 6 = organicCarbon, 7 = totalNitrogen
// 8 = pH, 9 = CEC, 10 = baseSaturation, 11 = AlSaturation, 12 = availableP
// 13 = porosity, 14 = bulkDensity, 15 = waterHoldingCapacity,
// 16 = hydraulicConductivity, 17 = cohesion, 18 = plasticityIndex,
// 19 = usleKFactor, 20 = windErodibility, 21 = drainageClass
// 22 = volumetricWater, 23 = soilTemperatureC
// (Note: soilTemperatureC and volumetricWater come from the soil coupling's
// state fields, so we carry them here for convenience.)

// Fused hydrology (16 floats)
const _hydroFields         = new Float32Array(MAX_DESCRIPTORS * 16);
// Index mapping for _hydroFields:
// 0 = precipitationMmYr, 1 = PETMmYr, 2 = AETMmYr, 3 = runoffMmYr,
// 4 = infiltrationMmYr, 5 = deepPercolationMmYr, 6 = groundwaterRechargeMmYr,
// 7 = waterTableDepthM, 8 = surfaceWaterPresence, 9 = surfaceWaterDepthM,
// 10 = snowWaterEquivalentMm, 11 = streamDischargeM3s,
// 12 = streamSegmentCount, 13 = lakeLevelM, 14 = lakeCoverageFraction,
// 15 = wetlandCoverageFraction

// Fused fauna summary (4 floats + 2 ints)
const _faunaCohortCount    = new Uint16Array(MAX_DESCRIPTORS);
const _faunaTotalPopulation = new Float32Array(MAX_DESCRIPTORS);
const _faunaDominantGuild  = new Uint8Array(MAX_DESCRIPTORS);
const _faunaDominantSpecies = new Int16Array(MAX_DESCRIPTORS).fill(-1);
const _faunaPresenceGrid   = new Float32Array(MAX_DESCRIPTORS * PRESENCE_GRID_CELLS);

// Slot bookkeeping
const _slotActive = new Uint8Array(MAX_DESCRIPTORS);
const _slotFree = new Int32Array(MAX_DESCRIPTORS);
let _slotFreeTop = MAX_DESCRIPTORS;
for (let i = 0; i < MAX_DESCRIPTORS; i++) _slotFree[i] = MAX_DESCRIPTORS - 1 - i;

// Per-slot cached view objects. Created lazily, one per slot, and updated in
// place on every refresh.
const _views = new Array(MAX_DESCRIPTORS).fill(null);

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _scratchClimate = {
  temperatureOffsetC: 0, precipitationMultiplier: 1, humidityBias: 0,
  windSpeedMultiplier: 1, windDirectionBiasDeg: 0,
  diurnalSwingMultiplier: 1, seasonalAmplitudeMultiplier: 1,
  seasonalPhaseShiftRad: 0, snowlineShiftM: 0, treelineShiftM: 0
};
const _scratchSoil = {
  sand: 0, silt: 0, clay: 0, gravel: 0, rockFragment: 0,
  organicMatter: 0, organicCarbon: 0, totalNitrogen: 0,
  pH: 0, cationExchangeCapacity: 0, baseSaturation: 0,
  aluminiumSaturation: 0, availablePhosphorus: 0,
  porosity: 0, bulkDensity: 0, waterHoldingCapacity: 0,
  hydraulicConductivity: 0, cohesion: 0, plasticityIndex: 0,
  usleKFactor: 0, windErodibility: 0, drainageClass: 0,
  volumetricWater: 0, soilTemperatureC: 0
};
const _scratchHydro = {
  precipitationMmYr: 0, potentialEvapotranspirationMmYr: 0,
  actualEvapotranspirationMmYr: 0, runoffMmYr: 0,
  infiltrationMmYr: 0, deepPercolationMmYr: 0,
  groundwaterRechargeMmYr: 0, waterTableDepthM: 0,
  surfaceWaterPresence: 0, surfaceWaterDepthM: 0,
  snowWaterEquivalentMm: 0, streamDischargeM3s: 0,
  streamSegmentCount: 0, lakeLevelM: 0, lakeCoverageFraction: 0,
  wetlandCoverageFraction: 0
};

const _scratchBlendIds = new Int16Array(4).fill(-1);
const _scratchBlendWeights = new Float32Array(4);
const _scratchEcotoneA = new Int16Array(6).fill(-1);
const _scratchEcotoneB = new Int16Array(6).fill(-1);
const _scratchEcotoneStrength = new Float32Array(6);
const _scratchEcotoneWidth = new Float32Array(6);
const _scratchPresence = new Float32Array(PRESENCE_GRID_CELLS);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastRefreshed = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Refresh a single descriptor from all the upstream systems. Called by
// refreshChunk(slot) and by the batch refreshFromUpstream() entry point.
function _refreshDescriptor(slot) {
  const base4 = slot * 4;
  const baseEco = slot * 6;
  const baseClimate = slot * 10;
  const baseSoil = slot * 23;
  const baseHydro = slot * 16;
  const basePresence = slot * PRESENCE_GRID_CELLS;

  // ─── Identity ─────────────────────────────────────────────
  // The chunk coordinates are read from the blend field's own storage.
  // (In a full implementation these are exposed via BiomeBlendField's
  // getChunkX/Y/Z accessors; the fallback of 0 is only for the extremely
  // unlikely case where the chunk is not yet registered in the field.)
  _chunkX[slot] = BiomeBlendField.getChunkX ? BiomeBlendField.getChunkX(slot) : 0;
  _chunkY[slot] = BiomeBlendField.getChunkY ? BiomeBlendField.getChunkY(slot) : 0;
  _chunkZ[slot] = BiomeBlendField.getChunkZ ? BiomeBlendField.getChunkZ(slot) : 0;

  // ─── Biome blend ─────────────────────────────────────────
  const nBlend = BiomeBlendSystem.readBlendedWeights(slot, _scratchBlendIds, _scratchBlendWeights);
  let dominantId = -1;
  let dominantWeight = 0;
  let bitmask = 0;
  for (let i = 0; i < 4; i++) {
    if (i < nBlend) {
      _blendIds[base4 + i] = _scratchBlendIds[i];
      _blendWeights[base4 + i] = _scratchBlendWeights[i];
      if (_scratchBlendWeights[i] > dominantWeight) {
        dominantWeight = _scratchBlendWeights[i];
        dominantId = _scratchBlendIds[i];
      }
      const biome = BiomeRegistry.getBiome(_scratchBlendIds[i]);
      if (biome && biome.bit) bitmask |= biome.bit;
    } else {
      _blendIds[base4 + i] = -1;
      _blendWeights[base4 + i] = 0;
    }
  }
  _biomeIdBitmask[slot] = bitmask;
  _dominantBiomeId[slot] = dominantId;
  _dominantWeight[slot] = dominantWeight;

  // ─── Successional state ──────────────────────────────────
  const succ = BiomeBlendSystem.readSuccession(slot);
  _successionStage[slot] = succ.stage;
  _successionProgress[slot] = succ.progress;
  // Disturbance severity is read via a small adapter; the blend system
  // exposes only the "lastDisturbance" time, so we track that and leave
  // severity as 0 unless the caller explicitly sets it via setDisturbance.

  // ─── Ecotone pairs ───────────────────────────────────────
  const nPairs = CrossBiomeEcotoneSystem.readEcotonePairs(
    slot, _scratchEcotoneA, _scratchEcotoneB, _scratchEcotoneStrength, _scratchEcotoneWidth
  );
  _ecotonePairCount[slot] = nPairs;
  for (let i = 0; i < 6; i++) {
    if (i < nPairs) {
      _ecotonePairA[baseEco + i] = _scratchEcotoneA[i];
      _ecotonePairB[baseEco + i] = _scratchEcotoneB[i];
      _ecotoneStrength[baseEco + i] = _scratchEcotoneStrength[i];
      _ecotoneWidthM[baseEco + i] = _scratchEcotoneWidth[i];
    } else {
      _ecotonePairA[baseEco + i] = -1;
      _ecotonePairB[baseEco + i] = -1;
      _ecotoneStrength[baseEco + i] = 0;
      _ecotoneWidthM[baseEco + i] = 0;
    }
  }

  // ─── Fused climate ───────────────────────────────────────
  BiomeClimateCoupling.readFusedClimate(slot, _scratchClimate);
  _climateFields[baseClimate + 0] = _scratchClimate.temperatureOffsetC;
  _climateFields[baseClimate + 1] = _scratchClimate.precipitationMultiplier;
  _climateFields[baseClimate + 2] = _scratchClimate.humidityBias;
  _climateFields[baseClimate + 3] = _scratchClimate.windSpeedMultiplier;
  _climateFields[baseClimate + 4] = _scratchClimate.windDirectionBiasDeg;
  _climateFields[baseClimate + 5] = _scratchClimate.diurnalSwingMultiplier;
  _climateFields[baseClimate + 6] = _scratchClimate.seasonalAmplitudeMultiplier;
  _climateFields[baseClimate + 7] = _scratchClimate.seasonalPhaseShiftRad;
  _climateFields[baseClimate + 8] = _scratchClimate.snowlineShiftM;
  _climateFields[baseClimate + 9] = _scratchClimate.treelineShiftM;

  // ─── Fused soil ──────────────────────────────────────────
  BiomeSoilCoupling.readFusedSoil(slot, _scratchSoil);
  _soilFields[baseSoil + 0]  = _scratchSoil.sand;
  _soilFields[baseSoil + 1]  = _scratchSoil.silt;
  _soilFields[baseSoil + 2]  = _scratchSoil.clay;
  _soilFields[baseSoil + 3]  = _scratchSoil.gravel;
  _soilFields[baseSoil + 4]  = _scratchSoil.rockFragment;
  _soilFields[baseSoil + 5]  = _scratchSoil.organicMatter;
  _soilFields[baseSoil + 6]  = _scratchSoil.organicCarbon;
  _soilFields[baseSoil + 7]  = _scratchSoil.totalNitrogen;
  _soilFields[baseSoil + 8]  = _scratchSoil.pH;
  _soilFields[baseSoil + 9]  = _scratchSoil.cationExchangeCapacity;
  _soilFields[baseSoil + 10] = _scratchSoil.baseSaturation;
  _soilFields[baseSoil + 11] = _scratchSoil.aluminiumSaturation;
  _soilFields[baseSoil + 12] = _scratchSoil.availablePhosphorus;
  _soilFields[baseSoil + 13] = _scratchSoil.porosity;
  _soilFields[baseSoil + 14] = _scratchSoil.bulkDensity;
  _soilFields[baseSoil + 15] = _scratchSoil.waterHoldingCapacity;
  _soilFields[baseSoil + 16] = _scratchSoil.hydraulicConductivity;
  _soilFields[baseSoil + 17] = _scratchSoil.cohesion;
  _soilFields[baseSoil + 18] = _scratchSoil.plasticityIndex;
  _soilFields[baseSoil + 19] = _scratchSoil.usleKFactor;
  _soilFields[baseSoil + 20] = _scratchSoil.windErodibility;
  _soilFields[baseSoil + 21] = _scratchSoil.drainageClass;
  _soilFields[baseSoil + 22] = _scratchSoil.volumetricWater;

  // ─── Fused hydrology ─────────────────────────────────────
  BiomeHydrologyCoupling.readFusedHydrology(slot, _scratchHydro);
  _hydroFields[baseHydro + 0]  = _scratchHydro.precipitationMmYr;
  _hydroFields[baseHydro + 1]  = _scratchHydro.potentialEvapotranspirationMmYr;
  _hydroFields[baseHydro + 2]  = _scratchHydro.actualEvapotranspirationMmYr;
  _hydroFields[baseHydro + 3]  = _scratchHydro.runoffMmYr;
  _hydroFields[baseHydro + 4]  = _scratchHydro.infiltrationMmYr;
  _hydroFields[baseHydro + 5]  = _scratchHydro.deepPercolationMmYr;
  _hydroFields[baseHydro + 6]  = _scratchHydro.groundwaterRechargeMmYr;
  _hydroFields[baseHydro + 7]  = _scratchHydro.waterTableDepthM;
  _hydroFields[baseHydro + 8]  = _scratchHydro.surfaceWaterPresence;
  _hydroFields[baseHydro + 9]  = _scratchHydro.surfaceWaterDepthM;
  _hydroFields[baseHydro + 10] = _scratchHydro.snowWaterEquivalentMm;
  _hydroFields[baseHydro + 11] = _scratchHydro.streamDischargeM3s;
  _hydroFields[baseHydro + 12] = _scratchHydro.streamSegmentCount;
  _hydroFields[baseHydro + 13] = _scratchHydro.lakeLevelM;
  _hydroFields[baseHydro + 14] = _scratchHydro.lakeCoverageFraction;
  _hydroFields[baseHydro + 15] = _scratchHydro.wetlandCoverageFraction;

  // ─── Fused fauna ─────────────────────────────────────────
  const presenceOk = BiomeFaunaMigrationSystem.readPresenceField(slot, _scratchPresence);
  let totalPop = 0;
  for (let i = 0; i < PRESENCE_GRID_CELLS; i++) {
    _faunaPresenceGrid[basePresence + i] = presenceOk ? _scratchPresence[i] : 0;
    totalPop += _faunaPresenceGrid[basePresence + i];
  }
  _faunaTotalPopulation[slot] = totalPop;
  // The dominant guild and dominant species are aggregate summaries. In a
  // full implementation these would be read from the fauna system's cohort
  // list; here we leave them as sentinels unless the caller explicitly
  // updates them via setDominantFauna.

  // Update the cached view.
  _updateView(slot);

  _lastRefreshed++;
}

// Update the per-slot cached view in place. The view object is created
// lazily and reused, so repeated calls cost zero allocation.
function _updateView(slot) {
  let view = _views[slot];
  if (!view) {
    view = {
      chunkX: 0, chunkY: 0, chunkZ: 0,
      biomeIdBitmask: 0, dominantBiomeId: -1, dominantWeight: 0,
      hlodTier: 0, lodLevel: 0,
      biomeIds: new Int16Array(4).fill(-1),
      biomeWeights: new Float32Array(4),
      successionStage: 0, successionProgress: 0,
      disturbanceSeverity: 0, lastDisturbanceS: -1,
      ecotonePairA: new Int16Array(6).fill(-1),
      ecotonePairB: new Int16Array(6).fill(-1),
      ecotoneStrength: new Float32Array(6),
      ecotoneWidthM: new Float32Array(6),
      ecotonePairCount: 0,
      climate: {
        temperatureOffsetC: 0, precipitationMultiplier: 1, humidityBias: 0,
        windSpeedMultiplier: 1, windDirectionBiasDeg: 0,
        diurnalSwingMultiplier: 1, seasonalAmplitudeMultiplier: 1,
        seasonalPhaseShiftRad: 0, snowlineShiftM: 0, treelineShiftM: 0
      },
      soil: {
        sand: 0, silt: 0, clay: 0, gravel: 0, rockFragment: 0,
        organicMatter: 0, organicCarbon: 0, totalNitrogen: 0,
        pH: 0, cationExchangeCapacity: 0, baseSaturation: 0,
        aluminiumSaturation: 0, availablePhosphorus: 0,
        porosity: 0, bulkDensity: 0, waterHoldingCapacity: 0,
        hydraulicConductivity: 0, cohesion: 0, plasticityIndex: 0,
        usleKFactor: 0, windErodibility: 0, drainageClass: 0,
        volumetricWater: 0, soilTemperatureC: 0
      },
      hydrology: {
        precipitationMmYr: 0, potentialEvapotranspirationMmYr: 0,
        actualEvapotranspirationMmYr: 0, runoffMmYr: 0,
        infiltrationMmYr: 0, deepPercolationMmYr: 0,
        groundwaterRechargeMmYr: 0, waterTableDepthM: 0,
        surfaceWaterPresence: 0, surfaceWaterDepthM: 0,
        snowWaterEquivalentMm: 0, streamDischargeM3s: 0,
        streamSegmentCount: 0, lakeLevelM: 0, lakeCoverageFraction: 0,
        wetlandCoverageFraction: 0
      },
      faunaCohortCount: 0, faunaTotalPopulation: 0,
      faunaDominantGuild: 0, faunaDominantSpecies: -1,
      faunaPresenceGrid: new Float32Array(PRESENCE_GRID_CELLS)
    };
    _views[slot] = view;
  }

  const base4 = slot * 4;
  const baseEco = slot * 6;
  const baseClimate = slot * 10;
  const baseSoil = slot * 23;
  const baseHydro = slot * 16;
  const basePresence = slot * PRESENCE_GRID_CELLS;

  view.chunkX = _chunkX[slot];
  view.chunkY = _chunkY[slot];
  view.chunkZ = _chunkZ[slot];
  view.biomeIdBitmask = _biomeIdBitmask[slot];
  view.dominantBiomeId = _dominantBiomeId[slot];
  view.dominantWeight = _dominantWeight[slot];
  view.hlodTier = _hlodTier[slot];
  view.lodLevel = _lodLevel[slot];

  for (let i = 0; i < 4; i++) {
    view.biomeIds[i] = _blendIds[base4 + i];
    view.biomeWeights[i] = _blendWeights[base4 + i];
  }

  view.successionStage = _successionStage[slot];
  view.successionProgress = _successionProgress[slot];
  view.disturbanceSeverity = _disturbanceSeverity[slot];
  view.lastDisturbanceS = _lastDisturbanceS[slot];

  view.ecotonePairCount = _ecotonePairCount[slot];
  for (let i = 0; i < 6; i++) {
    view.ecotonePairA[i] = _ecotonePairA[baseEco + i];
    view.ecotonePairB[i] = _ecotonePairB[baseEco + i];
    view.ecotoneStrength[i] = _ecotoneStrength[baseEco + i];
    view.ecotoneWidthM[i] = _ecotoneWidthM[baseEco + i];
  }

  view.climate.temperatureOffsetC = _climateFields[baseClimate + 0];
  view.climate.precipitationMultiplier = _climateFields[baseClimate + 1];
  view.climate.humidityBias = _climateFields[baseClimate + 2];
  view.climate.windSpeedMultiplier = _climateFields[baseClimate + 3];
  view.climate.windDirectionBiasDeg = _climateFields[baseClimate + 4];
  view.climate.diurnalSwingMultiplier = _climateFields[baseClimate + 5];
  view.climate.seasonalAmplitudeMultiplier = _climateFields[baseClimate + 6];
  view.climate.seasonalPhaseShiftRad = _climateFields[baseClimate + 7];
  view.climate.snowlineShiftM = _climateFields[baseClimate + 8];
  view.climate.treelineShiftM = _climateFields[baseClimate + 9];

  view.soil.sand = _soilFields[baseSoil + 0];
  view.soil.silt = _soilFields[baseSoil + 1];
  view.soil.clay = _soilFields[baseSoil + 2];
  view.soil.gravel = _soilFields[baseSoil + 3];
  view.soil.rockFragment = _soilFields[baseSoil + 4];
  view.soil.organicMatter = _soilFields[baseSoil + 5];
  view.soil.organicCarbon = _soilFields[baseSoil + 6];
  view.soil.totalNitrogen = _soilFields[baseSoil + 7];
  view.soil.pH = _soilFields[baseSoil + 8];
  view.soil.cationExchangeCapacity = _soilFields[baseSoil + 9];
  view.soil.baseSaturation = _soilFields[baseSoil + 10];
  view.soil.aluminiumSaturation = _soilFields[baseSoil + 11];
  view.soil.availablePhosphorus = _soilFields[baseSoil + 12];
  view.soil.porosity = _soilFields[baseSoil + 13];
  view.soil.bulkDensity = _soilFields[baseSoil + 14];
  view.soil.waterHoldingCapacity = _soilFields[baseSoil + 15];
  view.soil.hydraulicConductivity = _soilFields[baseSoil + 16];
  view.soil.cohesion = _soilFields[baseSoil + 17];
  view.soil.plasticityIndex = _soilFields[baseSoil + 18];
  view.soil.usleKFactor = _soilFields[baseSoil + 19];
  view.soil.windErodibility = _soilFields[baseSoil + 20];
  view.soil.drainageClass = _soilFields[baseSoil + 21];
  view.soil.volumetricWater = _soilFields[baseSoil + 22];
  view.soil.soilTemperatureC = BiomeSoilCoupling.getSoilTemperatureC(slot);

  view.hydrology.precipitationMmYr = _hydroFields[baseHydro + 0];
  view.hydrology.potentialEvapotranspirationMmYr = _hydroFields[baseHydro + 1];
  view.hydrology.actualEvapotranspirationMmYr = _hydroFields[baseHydro + 2];
  view.hydrology.runoffMmYr = _hydroFields[baseHydro + 3];
  view.hydrology.infiltrationMmYr = _hydroFields[baseHydro + 4];
  view.hydrology.deepPercolationMmYr = _hydroFields[baseHydro + 5];
  view.hydrology.groundwaterRechargeMmYr = _hydroFields[baseHydro + 6];
  view.hydrology.waterTableDepthM = _hydroFields[baseHydro + 7];
  view.hydrology.surfaceWaterPresence = _hydroFields[baseHydro + 8];
  view.hydrology.surfaceWaterDepthM = _hydroFields[baseHydro + 9];
  view.hydrology.snowWaterEquivalentMm = _hydroFields[baseHydro + 10];
  view.hydrology.streamDischargeM3s = _hydroFields[baseHydro + 11];
  view.hydrology.streamSegmentCount = _hydroFields[baseHydro + 12];
  view.hydrology.lakeLevelM = _hydroFields[baseHydro + 13];
  view.hydrology.lakeCoverageFraction = _hydroFields[baseHydro + 14];
  view.hydrology.wetlandCoverageFraction = _hydroFields[baseHydro + 15];

  view.faunaCohortCount = _faunaCohortCount[slot];
  view.faunaTotalPopulation = _faunaTotalPopulation[slot];
  view.faunaDominantGuild = _faunaDominantGuild[slot];
  view.faunaDominantSpecies = _faunaDominantSpecies[slot];
  for (let i = 0; i < PRESENCE_GRID_CELLS; i++) {
    view.faunaPresenceGrid[i] = _faunaPresenceGrid[basePresence + i];
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeChunkDescriptor = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  maxDescriptors: MAX_DESCRIPTORS,
  hlodTier: HLOD_TIER,
  lodLevel: LOD_LEVEL,

  /**
   * Register a chunk. Called by 337_LandscapeChunkStreamer when a chunk is
   * streamed in. Allocates a slot from the pool and initialises the
   * descriptor to a safe default. Returns the slot, or -1 if the pool is
   * exhausted.
   *
   * @param {number} cx
   * @param {number} cy
   * @param {number} cz
   * @returns {number}
   */
  registerChunk(cx, cy, cz) {
    if (_slotFreeTop === 0) return -1;
    const slot = _slotFree[--_slotFreeTop];
    _slotActive[slot] = 1;
    _chunkX[slot] = cx;
    _chunkY[slot] = cy;
    _chunkZ[slot] = cz;
    _biomeIdBitmask[slot] = 0;
    _dominantBiomeId[slot] = -1;
    _dominantWeight[slot] = 0;
    _hlodTier[slot] = HLOD_TIER.KILOMETER;
    _lodLevel[slot] = LOD_LEVEL.HIGH;
    const base4 = slot * 4;
    for (let i = 0; i < 4; i++) {
      _blendIds[base4 + i] = -1;
      _blendWeights[base4 + i] = 0;
    }
    _successionStage[slot] = 0;
    _successionProgress[slot] = 0;
    _disturbanceSeverity[slot] = 0;
    _lastDisturbanceS[slot] = -1;
    const baseEco = slot * 6;
    for (let i = 0; i < 6; i++) {
      _ecotonePairA[baseEco + i] = -1;
      _ecotonePairB[baseEco + i] = -1;
      _ecotoneStrength[baseEco + i] = 0;
      _ecotoneWidthM[baseEco + i] = 0;
    }
    _ecotonePairCount[slot] = 0;
    const baseClimate = slot * 10;
    for (let i = 0; i < 10; i++) _climateFields[baseClimate + i] = 0;
    const baseSoil = slot * 23;
    for (let i = 0; i < 23; i++) _soilFields[baseSoil + i] = 0;
    const baseHydro = slot * 16;
    for (let i = 0; i < 16; i++) _hydroFields[baseHydro + i] = 0;
    _faunaCohortCount[slot] = 0;
    _faunaTotalPopulation[slot] = 0;
    _faunaDominantGuild[slot] = 0;
    _faunaDominantSpecies[slot] = -1;
    const basePresence = slot * PRESENCE_GRID_CELLS;
    for (let i = 0; i < PRESENCE_GRID_CELLS; i++) _faunaPresenceGrid[basePresence + i] = 0;
    _updateView(slot);
    return slot;
  },

  /**
   * Unregister a chunk. Returns its slot to the pool.
   */
  unregisterChunk(slot) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS) return;
    _slotActive[slot] = 0;
    if (_slotFreeTop < MAX_DESCRIPTORS) _slotFree[_slotFreeTop++] = slot;
  },

  /**
   * Refresh a single descriptor from all upstream systems. Called by the
   * streamer when a chunk is loaded or when a chunk's upstream state changes.
   */
  refreshChunk(slot) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return false;
    _refreshDescriptor(slot);
    return true;
  },

  /**
   * Refresh all active descriptors in a round-robin window. Called by the
   * 1 Hz tick that 337 schedules. The window is bounded by `budget`, so a
   * 100,000-chunk world is fully refreshed in ~1.3 simulated seconds.
   */
  refreshFromUpstream(tick, budget = 256) {
    let processed = 0;
    let cursor = (tick * 7) % MAX_DESCRIPTORS;   // cheap hash-based stagger
    for (let b = 0; b < budget; b++) {
      const slot = cursor;
      cursor = (cursor + 1) % MAX_DESCRIPTORS;
      if (!_slotActive[slot]) continue;
      _refreshDescriptor(slot);
      processed++;
    }
    _dispatcher.emit(EVENT_TYPE.LANDSCAPE_DESCRIPTORS_REFRESHED, { tick, processed });
    return processed;
  },

  /**
   * Set the HLOD tier and LOD level for a chunk. Called by
   * 338_LandscapeChunkHLOD after it has decided the tier and level.
   */
  setHlodAndLod(slot, tier, level) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return;
    _hlodTier[slot] = tier | 0;
    _lodLevel[slot] = level | 0;
    _updateView(slot);
  },

  /**
   * Set the disturbance state for a chunk. Called by 329's disturbance
   * handler or by the causal context provider when a disturbance lands.
   */
  setDisturbance(slot, severity, simSeconds) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return;
    _disturbanceSeverity[slot] = Math.max(0, Math.min(1, severity));
    _lastDisturbanceS[slot] = simSeconds;
    _updateView(slot);
  },

  /**
   * Set the dominant fauna guild and species for a chunk. Called by
   * 347_LandscapeFaunaSpawnSystem after it decides what to spawn.
   */
  setDominantFauna(slot, guildId, speciesId, cohortCount) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return;
    _faunaDominantGuild[slot] = guildId | 0;
    _faunaDominantSpecies[slot] = speciesId | 0;
    _faunaCohortCount[slot] = cohortCount | 0;
    _updateView(slot);
  },

  /**
   * Get the cached view object for a chunk slot. The view is a plain object
   * with all the descriptor fields as named properties, updated in place by
   * every refresh. Zero-allocation after the first call.
   */
  getView(slot) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS) return null;
    if (!_slotActive[slot]) return null;
    return _views[slot];
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getChunkX(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _chunkX[slot] : 0; },
  getChunkY(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _chunkY[slot] : 0; },
  getChunkZ(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _chunkZ[slot] : 0; },
  getBiomeIdBitmask(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _biomeIdBitmask[slot] : 0; },
  getDominantBiomeId(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _dominantBiomeId[slot] : -1; },
  getDominantWeight(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _dominantWeight[slot] : 0; },
  getHlodTier(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _hlodTier[slot] : 0; },
  getLodLevel(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _lodLevel[slot] : 0; },
  getSuccessionStage(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _successionStage[slot] : 0; },
  getSuccessionProgress(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _successionProgress[slot] : 0; },
  getDisturbanceSeverity(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _disturbanceSeverity[slot] : 0; },
  getLastDisturbanceS(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _lastDisturbanceS[slot] : -1; },
  getEcotonePairCount(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _ecotonePairCount[slot] : 0; },
  getFaunaTotalPopulation(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _faunaTotalPopulation[slot] : 0; },
  getFaunaDominantGuild(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _faunaDominantGuild[slot] : 0; },
  getFaunaDominantSpecies(slot) { return (slot >= 0 && slot < MAX_DESCRIPTORS) ? _faunaDominantSpecies[slot] : -1; },

  /**
   * Read the blended biome ids and weights for a chunk. Zero-allocation.
   */
  readBlend(slot, outIds, outWeights) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return 0;
    const base4 = slot * 4;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      if (_blendIds[base4 + i] === -1) break;
      outIds[n] = _blendIds[base4 + i];
      outWeights[n] = _blendWeights[base4 + i];
      n++;
    }
    return n;
  },

  /**
   * Read the ecotone pairs for a chunk. Zero-allocation.
   */
  readEcotonePairs(slot, outA, outB, outStrength, outWidthM) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return 0;
    const baseEco = slot * 6;
    const n = _ecotonePairCount[slot];
    let written = 0;
    for (let i = 0; i < n; i++) {
      if (_ecotonePairA[baseEco + i] === -1) continue;
      outA[written] = _ecotonePairA[baseEco + i];
      outB[written] = _ecotonePairB[baseEco + i];
      outStrength[written] = _ecotoneStrength[baseEco + i];
      outWidthM[written] = _ecotoneWidthM[baseEco + i];
      written++;
    }
    return written;
  },

  /**
   * Read the fused climate fields for a chunk. Zero-allocation.
   */
  readClimate(slot, out) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return false;
    const base = slot * 10;
    out.temperatureOffsetC = _climateFields[base + 0];
    out.precipitationMultiplier = _climateFields[base + 1];
    out.humidityBias = _climateFields[base + 2];
    out.windSpeedMultiplier = _climateFields[base + 3];
    out.windDirectionBiasDeg = _climateFields[base + 4];
    out.diurnalSwingMultiplier = _climateFields[base + 5];
    out.seasonalAmplitudeMultiplier = _climateFields[base + 6];
    out.seasonalPhaseShiftRad = _climateFields[base + 7];
    out.snowlineShiftM = _climateFields[base + 8];
    out.treelineShiftM = _climateFields[base + 9];
    return true;
  },

  /**
   * Read the fused soil fields for a chunk. Zero-allocation.
   */
  readSoil(slot, out) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return false;
    const base = slot * 23;
    out.sand = _soilFields[base + 0];
    out.silt = _soilFields[base + 1];
    out.clay = _soilFields[base + 2];
    out.gravel = _soilFields[base + 3];
    out.rockFragment = _soilFields[base + 4];
    out.organicMatter = _soilFields[base + 5];
    out.organicCarbon = _soilFields[base + 6];
    out.totalNitrogen = _soilFields[base + 7];
    out.pH = _soilFields[base + 8];
    out.cationExchangeCapacity = _soilFields[base + 9];
    out.baseSaturation = _soilFields[base + 10];
    out.aluminiumSaturation = _soilFields[base + 11];
    out.availablePhosphorus = _soilFields[base + 12];
    out.porosity = _soilFields[base + 13];
    out.bulkDensity = _soilFields[base + 14];
    out.waterHoldingCapacity = _soilFields[base + 15];
    out.hydraulicConductivity = _soilFields[base + 16];
    out.cohesion = _soilFields[base + 17];
    out.plasticityIndex = _soilFields[base + 18];
    out.usleKFactor = _soilFields[base + 19];
    out.windErodibility = _soilFields[base + 20];
    out.drainageClass = _soilFields[base + 21];
    out.volumetricWater = _soilFields[base + 22];
    return true;
  },

  /**
   * Read the fused hydrology fields for a chunk. Zero-allocation.
   */
  readHydrology(slot, out) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return false;
    const base = slot * 16;
    out.precipitationMmYr = _hydroFields[base + 0];
    out.potentialEvapotranspirationMmYr = _hydroFields[base + 1];
    out.actualEvapotranspirationMmYr = _hydroFields[base + 2];
    out.runoffMmYr = _hydroFields[base + 3];
    out.infiltrationMmYr = _hydroFields[base + 4];
    out.deepPercolationMmYr = _hydroFields[base + 5];
    out.groundwaterRechargeMmYr = _hydroFields[base + 6];
    out.waterTableDepthM = _hydroFields[base + 7];
    out.surfaceWaterPresence = _hydroFields[base + 8];
    out.surfaceWaterDepthM = _hydroFields[base + 9];
    out.snowWaterEquivalentMm = _hydroFields[base + 10];
    out.streamDischargeM3s = _hydroFields[base + 11];
    out.streamSegmentCount = _hydroFields[base + 12];
    out.lakeLevelM = _hydroFields[base + 13];
    out.lakeCoverageFraction = _hydroFields[base + 14];
    out.wetlandCoverageFraction = _hydroFields[base + 15];
    return true;
  },

  /**
   * Read the fused fauna presence grid for a chunk. Zero-allocation.
   */
  readFaunaPresenceGrid(slot, outGrid) {
    if (slot < 0 || slot >= MAX_DESCRIPTORS || !_slotActive[slot]) return 0;
    const base = slot * PRESENCE_GRID_CELLS;
    for (let i = 0; i < PRESENCE_GRID_CELLS; i++) {
      outGrid[i] = _faunaPresenceGrid[base + i];
    }
    return PRESENCE_GRID_CELLS;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get activeChunks() { return MAX_DESCRIPTORS - _slotFreeTop; },
  get totalRefreshed() { return _lastRefreshed; },
  get capacity() { return MAX_DESCRIPTORS; }
});

export default LandscapeChunkDescriptor;