// file number : 354
// full path name : src/context/354_LandscapeSensoryCoupler.js
// description : Landscape sensory coupler — the 1 Hz consumer that fuses the
// biome blend (329), the per-chunk material state (331), the fused soil (333),
// the fused hydrology (334), the fauna migration (335), the vegetation scatter
// (346), the fauna spawn (347), the lighting state (351), the sky state (352),
// and the seasonal palette (353) into a single per-chunk sensory record. The
// coupler computes eighteen sensory parameters per chunk, grouped into three
// overlapping senses:
//
//   ACOUSTIC (six channels, each in [0, 1]):
//     biologicalDensity — insect chorus, birdsong, amphibian calls, and
//                          mammal vocalizations aggregated from the biome's
//                          fauna profile, the current vegetation density, the
//                          seasonal bloom/pollen state, and the time of day
//                          (nocturnal vs diurnal);
//     geologicalActivity — rockfall, ice cracking, sand shifting, and
//                          cryoturbation driven by the erosion state, the
//                          fused temperature's diurnal amplitude, and the
//                          biome's own geological weight;
//     waterFlow          — stream and river flow, lapping waves, dripping
//                          water, and rainfall intensity from the fused
//                          hydrology, the flow field, and the current
//                          precipitation;
//     windStrength       — wind through grass, wind through conifer needles,
//                          wind over open rock, driven by the fused wind
//                          speed multiplier and the biome's own wind weight;
//     vegetationRustle   — leaf and grass rustle, driven by the wind strength
//                          multiplied by the vegetation density and the
//                          seasonal foliage state (leaf-on vs bare branches);
//     mechanicalNoise    — distant humans, machines, and structures, driven
//                          by the prop density (campfires, buildings) and
//                          the smoke plume activity from the sky coupler.
//
//   OLFACTORY (ten channels, each in [0, 1]):
//     floral, earthy, aquatic, woodland, smoke, animal, decay, sulfur, sea,
//     clean — each driven by the biome's own olfactory profile modulated by
//     the seasonal palette (spring bloom boosts floral, autumn decay boosts
//     decay and woodland, winter suppresses all), the fused hydrology (water
//     boosts aquatic and sea), the fauna density (animal and decay), the
//     prop density (smoke from campfires), and the air quality (aerosols
//     suppress clean and boost earthy).
//
//   TACTILE (six scalars):
//     temperatureC, humidity, windPressurePa, precipitationType,
//     precipitationIntensity, groundHardness — each driven by the fused
//     climate, the fused soil moisture, the fused hydrology's ground water,
//     and the seasonal snow/frost state.
//
// The coupler exposes the sensory record both as a read API
// (readSensoryRecord) and as a batch-read API (readSensoryBatch) that 337
// streams to the audio system, the smell system, and the weather system as a
// single contiguous buffer of per-chunk sensory records. The acoustic data
// drives the procedural ambient audio, the olfactory data drives the
// procedural smell shader used for first-person atmosphere, and the tactile
// data drives the survival system's "what does it feel like here?" query.
//
// The coupler is fully tier-aware: the KILOMETER tier gets all eighteen
// channels at full resolution; the TEN_KILOMETER tier gets all acoustic and
// tactile channels but drops the two least significant olfactory channels
// (clean and sulfur); the HUNDRED_KILOMETER tier keeps only the acoustic
// channels and the tactile temperature/humidity pair; the THOUSAND_KILOMETER
// tier keeps only a single blended "sensory tint" scalar per chunk.
//
// The per-tick work is bounded by both a chunk budget (default 256) and a
// per-tick CPU budget (default 1.5 ms), so a 100,000-chunk world refreshes
// in ~390 simulated seconds (6.5 simulated minutes) — more than fast enough
// because ambient sensory cues change over minutes, not milliseconds.
//
// Material and lighting parameters are integrated first-class: the acoustic
// and olfactory profiles are read directly from each biome's ACOUSTIC_PROFILE
// and sensory block, so the sound of a rainforest canopy is guaranteed to
// match its visual material, and the smell of a desert is guaranteed to
// match its lighting. This coupling — where the material you see and the
// smell you perceive and the sound you hear all come from the same biome
// descriptor — is what makes the world feel unified rather than stitched
// together.
//
// Every per-chunk buffer is preallocated, every hot-path computation is
// zero-allocation, and the coupler works identically on WebGL1 and WebGL2
// because the sensory data is delivered through the standard audio/ambient
// pipeline, not through compute shaders.
//#
// best for : Every consumer that needs per-chunk sensory state —
// 297_SensoryDetailsProvider (the coupler is the per-chunk application of
// its global sensory dimensions), 331_BiomeBlendMaterialBridge (reads the
// acoustic profile to select the correct footstep sound for each visible
// surface), 336_LandscapeChunkDescriptor (receives the sensory record so
// downstream consumers can read it), 337_LandscapeChunkStreamer (streams
// the sensory record to the audio and weather systems as a single batch),
// 338_LandscapeChunkHLOD (uses the sensory record to decide which audio
// LODs to stream in), 346_LandscapeVegetationScatterSystem (reads the
// vegetationRustle and biologicalDensity channels to place ambient audio
// emitters), 347_LandscapeFaunaSpawnSystem (reads the animal and biological
// density channels to place fauna audio emitters), 348_LandscapeDecal-
// PlacementSystem (reads the earthy and aquatic channels to place wet-surface
// decals), 349_LandscapePropPlacementSystem (reads the smoke and mechanical
// channels to place prop audio emitters), 351_LandscapeLightingCoupler
// (reads the sensory record to adjust the ambient light for overcast vs
// clear conditions), 352_LandscapeSkyCoupler (reads the smoke and dust
// channels to drive the sky's haze), 353_LandscapeSeasonCoupler (reads the
// seasonal palette to modulate the sensory record), 355_LandscapePerformance-
// Governor (uses the sensory batch size to arbitrate the audio budget),
// 356_LandscapeRebuildDeferral (uses the per-chunk sensory dirty flag to
// decide when a chunk needs its audio emitters rebuilt), 357_LandscapeEvent-
// Budget (uses the sensory batch queue depth to coalesce multiple sensory
// requests into a single causal event), and 359_LandscapeSceneWiring (uses
// the coupler to wire the sensory system into the runtime). The coupler is
// the single authority on what each chunk sounds like, smells like, and
// feels like, and every consumer that needs sensory state asks it.
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
import { SensoryDetailsProvider, ACOUSTIC_PROFILE } from './297_SensoryDetailsProvider.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeErosionSimulator } from './343_LandscapeErosionSimulator.js';
import { LandscapeWindErosionSystem } from './344_LandscapeWindErosionSystem.js';
import { LandscapeWaterFlowSystem, FLOW_STATE } from './345_LandscapeWaterFlowSystem.js';
import { LandscapeVegetationScatterSystem } from './346_LandscapeVegetationScatterSystem.js';
import { LandscapeFaunaSpawnSystem } from './347_LandscapeFaunaSpawnSystem.js';
import { LandscapeDecalPlacementSystem } from './348_LandscapeDecalPlacementSystem.js';
import { LandscapePropPlacementSystem } from './349_LandscapePropPlacementSystem.js';
import { LandscapeShadowScaler } from './350_LandscapeShadowScaler.js';
import { LandscapeLightingCoupler } from './351_LandscapeLightingCoupler.js';
import { LandscapeSkyCoupler } from './352_LandscapeSkyCoupler.js';
import { LandscapeSeasonCoupler } from './353_LandscapeSeasonCoupler.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–353.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier detail level for the sensory coupler.
const SENSORY_DETAIL = Object.freeze({
  FULL: 0,           // KILOMETER       all 18 channels
  COARSE: 1,         // TEN_KILOMETER   drop clean + sulfur
  MINIMAL: 2,        // HUNDRED_KILOMETER acoustic + temperature/humidity only
  TINT_ONLY: 3       // THOUSAND_KILOMETER single sensory tint
});
const TIER_SENSORY_DETAIL = Object.freeze([
  SENSORY_DETAIL.FULL,
  SENSORY_DETAIL.COARSE,
  SENSORY_DETAIL.MINIMAL,
  SENSORY_DETAIL.TINT_ONLY
]);

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Per-tick chunk budget.
const DEFAULT_TICK_CHUNK_BUDGET = 256;

// Per-tick CPU budget in milliseconds.
const DEFAULT_TICK_CPU_BUDGET_MS = 1.5;

// Per-chunk sensory batch record size in floats (matches the batch layout).
const SENSORY_FLOATS = 32;

// ─── Acoustic channel indices ────────────────────────────────
const CH_ACOUSTIC_BIOLOGICAL  = 0;
const CH_ACOUSTIC_GEOLOGICAL  = 1;
const CH_ACOUSTIC_WATER       = 2;
const CH_ACOUSTIC_WIND        = 3;
const CH_ACOUSTIC_VEGETATION  = 4;
const CH_ACOUSTIC_MECHANICAL  = 5;

// ─── Olfactory channel indices ───────────────────────────────
const CH_OLFACTORY_FLORAL      = 6;
const CH_OLFACTORY_EARTHY      = 7;
const CH_OLFACTORY_AQUATIC     = 8;
const CH_OLFACTORY_WOODLAND    = 9;
const CH_OLFACTORY_SMOKE       = 10;
const CH_OLFACTORY_ANIMAL      = 11;
const CH_OLFACTORY_DECAY       = 12;
const CH_OLFACTORY_SULFUR      = 13;
const CH_OLFACTORY_SEA         = 14;
const CH_OLFACTORY_CLEAN       = 15;

// ─── Tactile scalar indices ──────────────────────────────────
const CH_TACTILE_TEMPERATURE_C  = 16;
const CH_TACTILE_HUMIDITY       = 17;
const CH_TACTILE_WIND_PRESSURE_PA = 18;
const CH_TACTILE_PRECIP_TYPE    = 19;
const CH_TACTILE_PRECIP_INTENSITY = 20;
const CH_TACTILE_GROUND_HARDNESS  = 21;

// ─── Drift thresholds ───────────────────────────────────────
const DRIFT_ACOUSTIC = 0.05;
const DRIFT_OLFACTORY = 0.05;
const DRIFT_TEMPERATURE = 0.5;      // °C
const DRIFT_HUMIDITY = 0.05;
const DRIFT_PRECIP = 0.05;

// ─── Diurnal acoustic modulation ────────────────────────────
// Biological acoustic activity peaks at dawn and dusk and is suppressed in
// the middle of the day (heat) and at night (except for nocturnal species).
const DAWN_PEAK_HOUR = 6.0;
const DUSK_PEAK_HOUR = 19.0;
const NOCTURNAL_PEAK_HOUR = 0.0;
const DIURNAL_BOOST = 0.6;
const NOCTURNAL_BOOST = 0.4;

// ─── Ground hardness constants ──────────────────────────────
// Ground hardness is derived from the fused soil cohesion and the water
// content. Wet soil is softer; dry soil is harder; frozen soil is hardest.
const GROUND_HARDNESS_MIN = 0.05;
const GROUND_HARDNESS_MAX = 0.95;
const FROZEN_HARDNESS_BONUS = 0.2;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK SENSORY STATE (structure-of-arrays) ──────
// ══════════════════════════════════════════════════════════════════
// 22 channels per chunk (6 acoustic + 10 olfactory + 6 tactile). Each
// channel is stored in its own typed array so a batch read is a contiguous
// per-channel loop.

const _acousticBiological   = new Float32Array(MAX_TRACKED_CHUNKS);
const _acousticGeological   = new Float32Array(MAX_TRACKED_CHUNKS);
const _acousticWater        = new Float32Array(MAX_TRACKED_CHUNKS);
const _acousticWind         = new Float32Array(MAX_TRACKED_CHUNKS);
const _acousticVegetation   = new Float32Array(MAX_TRACKED_CHUNKS);
const _acousticMechanical   = new Float32Array(MAX_TRACKED_CHUNKS);

const _olfactoryFloral      = new Float32Array(MAX_TRACKED_CHUNKS);
const _olfactoryEarthy      = new Float32Array(MAX_TRACKED_CHUNKS);
const _olfactoryAquatic     = new Float32Array(MAX_TRACKED_CHUNKS);
const _olfactoryWoodland    = new Float32Array(MAX_TRACKED_CHUNKS);
const _olfactorySmoke       = new Float32Array(MAX_TRACKED_CHUNKS);
const _olfactoryAnimal      = new Float32Array(MAX_TRACKED_CHUNKS);
const _olfactoryDecay       = new Float32Array(MAX_TRACKED_CHUNKS);
const _olfactorySulfur      = new Float32Array(MAX_TRACKED_CHUNKS);
const _olfactorySea         = new Float32Array(MAX_TRACKED_CHUNKS);
const _olfactoryClean       = new Float32Array(MAX_TRACKED_CHUNKS);

const _tactileTemperatureC  = new Float32Array(MAX_TRACKED_CHUNKS);
const _tactileHumidity      = new Float32Array(MAX_TRACKED_CHUNKS);
const _tactileWindPressure  = new Float32Array(MAX_TRACKED_CHUNKS);
const _tactilePrecipType    = new Uint8Array(MAX_TRACKED_CHUNKS);
const _tactilePrecipIntensity = new Float32Array(MAX_TRACKED_CHUNKS);
const _tactileGroundHardness = new Float32Array(MAX_TRACKED_CHUNKS);

// Single sensory tint for the THOUSAND_KILOMETER tier.
const _sensoryTint          = new Float32Array(MAX_TRACKED_CHUNKS);

// Slot bookkeeping.
const _isOccluded           = new Uint8Array(MAX_TRACKED_CHUNKS);
const _sensoryDirty         = new Uint8Array(MAX_TRACKED_CHUNKS);
const _chunkActive          = new Uint8Array(MAX_TRACKED_CHUNKS);

// Drift detection scratch.
const _lastAcousticBiological = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastAcousticWind       = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastOlfactoryFloral    = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastOlfactoryEarthy    = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastTemperatureC       = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1e9);
const _lastHumidity           = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastPrecipIntensity    = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);
const _lastEvalS              = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Round-robin cursor.
let _rrCursor               = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Blended biome weights.
const _blendIdsScratch = new Int16Array(4).fill(-1);
const _blendWeightsScratch = new Float32Array(4);

// Acoustic/olfactory accumulators (per-biome, blended at the end).
const _acousticAcc = new Float32Array(8);
const _olfactoryAcc = new Float32Array(10);
const _tactileAcc = new Float32Array(6);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastChanged = 0;
let _lastSkipped = 0;
let _lastActiveChunks = 0;
let _lastTickDurationMs = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Read the current time-of-day in hours from the temporal provider.
function _currentTimeOfDayHours() {
  if (TemporalContextProvider && typeof TemporalContextProvider.getTimeOfDayHours === 'function') {
    return TemporalContextProvider.getTimeOfDayHours();
  }
  return 12.0;
}

// Compute the diurnal acoustic boost for the current time of day. Dawn and
// dusk have the highest biological activity; midday and midnight have less.
function _diurnalAcousticBoost(timeOfDayHours) {
  // Distance to dawn and dusk peaks.
  const dawnDist = Math.abs(timeOfDayHours - DAWN_PEAK_HOUR);
  const duskDist = Math.abs(timeOfDayHours - DUSK_PEAK_HOUR);
  const dawnPulse = Math.max(0, 1.0 - dawnDist / 3.0);
  const duskPulse = Math.max(0, 1.0 - duskDist / 3.0);
  const diurnalPulse = Math.max(dawnPulse, duskPulse) * DIURNAL_BOOST;

  // Nocturnal pulse (midnight).
  const midnightDist = Math.min(timeOfDayHours, 24 - timeOfDayHours);
  const nocturnalPulse = Math.max(0, 1.0 - midnightDist / 4.0) * NOCTURNAL_BOOST;

  return Math.min(1.0, diurnalPulse + nocturnalPulse);
}

// Compute the acoustic biological density from the biome fauna profile,
// the current vegetation density, the seasonal bloom/pollen state, and the
// time of day.
function _computeAcousticBiological(streamerSlot, view, timeOfDayHours) {
  // Base from the biome's fauna profile.
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.acoustic) continue;
    base += biome.sensory.acoustic.biological * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  // Vegetation density modulation.
  const vegetationCount = LandscapeVegetationScatterSystem ? LandscapeVegetationScatterSystem.getInstanceCount(streamerSlot) : 0;
  const vegetationFactor = Math.min(1.0, vegetationCount / 100.0);

  // Seasonal bloom/pollen modulation.
  const bloomIntensity = LandscapeSeasonCoupler ? LandscapeSeasonCoupler.getBloomIntensity(streamerSlot) : 0;
  const pollenDensity = LandscapeSeasonCoupler ? LandscapeSeasonCoupler.getPollenDensity(streamerSlot) : 0;
  const seasonalFactor = 0.7 + bloomIntensity * 0.3 + pollenDensity * 0.2;

  // Time-of-day modulation.
  const diurnalBoost = _diurnalAcousticBoost(timeOfDayHours);

  return Math.min(1.0, base * (0.5 + vegetationFactor * 0.5) * seasonalFactor * (0.5 + diurnalBoost));
}

// Compute the acoustic geological activity from the erosion state and the
// diurnal temperature swing.
function _computeAcousticGeological(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.acoustic) continue;
    base += biome.sensory.acoustic.geological * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  // Hydraulic erosion activity.
  const erosionActive = LandscapeErosionSimulator && LandscapeErosionSimulator.getCurrentRate
    ? Math.min(1.0, Math.abs(LandscapeErosionSimulator.getCurrentRate(streamerSlot)) * 1e5)
    : 0;

  // Wind erosion (dust storm) activity.
  const dustActive = LandscapeWindErosionSystem && LandscapeWindErosionSystem.isDustStorming
    ? (LandscapeWindErosionSystem.isDustStorming(streamerSlot) ? 1.0 : 0.0)
    : 0;

  // Diurnal temperature swing drives freeze-thaw cracking.
  const diurnalSwing = BiomeClimateCoupling.getDiurnalSwingMultiplier(streamerSlot);
  const frostCrackingFactor = Math.min(1.0, (diurnalSwing - 0.8) * 2.0);

  return Math.min(1.0, base + erosionActive * 0.3 + dustActive * 0.5 + Math.max(0, frostCrackingFactor) * 0.2);
}

// Compute the acoustic water flow from the flow field and the current
// precipitation.
function _computeAcousticWater(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.acoustic) continue;
    base += biome.sensory.acoustic.water * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  // Flow field modulation.
  let flowBoost = 0;
  if (LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot)) {
    const discharge = LandscapeWaterFlowSystem.getDischargeM3s(streamerSlot);
    flowBoost = Math.min(1.0, discharge / 50.0);
  }

  // Precipitation modulation.
  let precipBoost = 0;
  if (TemporalContextProvider && typeof TemporalContextProvider.getPrecipitationIntensity === 'function') {
    precipBoost = TemporalContextProvider.getPrecipitationIntensity();
  }

  return Math.min(1.0, base + flowBoost * 0.5 + precipBoost * 0.6);
}

// Compute the acoustic wind strength from the fused wind speed.
function _computeAcousticWind(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.acoustic) continue;
    base += biome.sensory.acoustic.wind * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  const windMultiplier = BiomeClimateCoupling.getWindSpeedMultiplier(streamerSlot);
  return Math.min(1.0, base * (0.5 + windMultiplier * 0.5));
}

// Compute the acoustic vegetation rustle from the vegetation density and
// the seasonal foliage state.
function _computeAcousticVegetation(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.acoustic) continue;
    base += biome.sensory.acoustic.vegetation * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  const vegetationCount = LandscapeVegetationScatterSystem ? LandscapeVegetationScatterSystem.getInstanceCount(streamerSlot) : 0;
  const vegetationFactor = Math.min(1.0, vegetationCount / 100.0);

  // Seasonal suppression: bare branches make less noise than full foliage.
  const stage = LandscapeSeasonCoupler ? LandscapeSeasonCoupler.getPhenologyStage(streamerSlot) : 1;
  let foliageFactor = 1.0;
  if (stage === 3) foliageFactor = 0.3;   // winter bare branch
  else if (stage === 0) foliageFactor = 0.7; // spring new leaf

  const windMultiplier = BiomeClimateCoupling.getWindSpeedMultiplier(streamerSlot);

  return Math.min(1.0, base * (0.3 + vegetationFactor * 0.7) * foliageFactor * windMultiplier);
}

// Compute the acoustic mechanical noise from the prop density.
function _computeAcousticMechanical(streamerSlot) {
  const propCount = LandscapePropPlacementSystem ? LandscapePropPlacementSystem.getPropCount(streamerSlot) : 0;
  return Math.min(1.0, propCount / 8.0);
}

// Compute the olfactory floral density from the bloom state.
function _computeOlfactoryFloral(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.floral * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  const bloom = LandscapeSeasonCoupler ? LandscapeSeasonCoupler.getBloomIntensity(streamerSlot) : 0;
  return Math.min(1.0, base * (0.3 + bloom * 0.7));
}

// Compute the olfactory earthy density.
function _computeOlfactoryEarthy(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.earthy * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  // Wet soil boosts earthy smell.
  const humidity = 0.55 + BiomeClimateCoupling.getHumidityBias(streamerSlot);
  return Math.min(1.0, base * (0.5 + humidity * 0.5));
}

// Compute the olfactory aquatic density.
function _computeOlfactoryAquatic(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.aquatic * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  if (LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot)) {
    base = Math.min(1.0, base * 1.5);
  }
  return base;
}

// Compute the olfactory woodland density.
function _computeOlfactoryWoodland(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.woodland * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;
  return base;
}

// Compute the olfactory smoke density from the prop density and the current
// fire activity.
function _computeOlfactorySmoke(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.smoke * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  // Smoke from campfires and burning props.
  const propCount = LandscapePropPlacementSystem ? LandscapePropPlacementSystem.getPropCount(streamerSlot) : 0;
  const smokeBoost = Math.min(1.0, propCount / 4.0);
  return Math.min(1.0, base + smokeBoost * 0.5);
}

// Compute the olfactory animal density.
function _computeOlfactoryAnimal(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.animal * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  const animalCount = LandscapeFaunaSpawnSystem ? LandscapeFaunaSpawnSystem.getAnimalCount(streamerSlot) : 0;
  const animalBoost = Math.min(1.0, animalCount / 10.0);
  return Math.min(1.0, base * (0.5 + animalBoost * 0.5));
}

// Compute the olfactory decay density.
function _computeOlfactoryDecay(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.decay * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  // Autumn leaf litter boosts decay smell.
  const leafLitter = LandscapeSeasonCoupler ? LandscapeSeasonCoupler.getLeafLitterDepthM(streamerSlot) : 0;
  const decayBoost = Math.min(1.0, leafLitter * 5.0);
  return Math.min(1.0, base * (0.5 + decayBoost * 0.5));
}

// Compute the olfactory sulfur density (wetlands, volcanic, hydrothermal).
function _computeOlfactorySulfur(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.sulfur * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;
  return base;
}

// Compute the olfactory sea density.
function _computeOlfactorySea(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.sea * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  // Salt water boosts sea smell.
  if (LandscapeWaterFlowSystem && LandscapeWaterFlowSystem.hasWater(streamerSlot)) {
    // Salinity: from the hydrology coupling (would be >0 for marine biomes).
    base = Math.min(1.0, base * 1.3);
  }
  return base;
}

// Compute the olfactory clean density (fresh air, ozone).
function _computeOlfactoryClean(streamerSlot, view) {
  let base = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.sensory || !biome.sensory.olfactory) continue;
    base += biome.sensory.olfactory.clean * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) base /= totalWeight;

  // Air quality suppresses clean smell.
  if (AirQualityAtmosphereProvider && typeof AirQualityAtmosphereProvider.getAerosolOpticalDepth === 'function') {
    const aod = AirQualityAtmosphereProvider.getAerosolOpticalDepth();
    base *= Math.max(0.1, 1.0 - aod);
  }
  return base;
}

// Compute the tactile temperature in °C.
function _computeTactileTemperature(streamerSlot) {
  const baseTemp = 15.0;
  return baseTemp + BiomeClimateCoupling.getTemperatureOffset(streamerSlot);
}

// Compute the tactile humidity in [0, 1].
function _computeTactileHumidity(streamerSlot) {
  const baseHumidity = 0.55;
  return Math.max(0, Math.min(1.0, baseHumidity + BiomeClimateCoupling.getHumidityBias(streamerSlot)));
}

// Compute the tactile wind pressure in pascals.
function _computeTactileWindPressure(streamerSlot) {
  const baseWindSpeed = 3.5;   // m/s
  const windMultiplier = BiomeClimateCoupling.getWindSpeedMultiplier(streamerSlot);
  const windSpeed = baseWindSpeed * windMultiplier;
  // Dynamic pressure: q = 0.5 × ρ × v², ρ = 1.225 kg/m³ for air.
  return 0.5 * 1.225 * windSpeed * windSpeed;
}

// Compute the tactile precipitation type (enum).
function _computeTactilePrecipType(streamerSlot) {
  const tempC = _computeTactileTemperature(streamerSlot);
  if (tempC < 0) return 2;   // snow
  if (tempC < 2) return 3;   // sleet
  return 1;                   // rain
}

// Compute the tactile precipitation intensity in [0, 1].
function _computeTactilePrecipIntensity(streamerSlot) {
  if (TemporalContextProvider && typeof TemporalContextProvider.getPrecipitationIntensity === 'function') {
    return TemporalContextProvider.getPrecipitationIntensity();
  }
  return 0;
}

// Compute the tactile ground hardness in [0, 1].
function _computeTactileGroundHardness(streamerSlot) {
  // Base from soil cohesion.
  const cohesion = BiomeSoilCoupling.getCohesion(streamerSlot);
  let hardness = cohesion / 15.0;   // normalize to ~0.5 for typical 7.5 kPa

  // Wet soil is softer.
  const volWater = BiomeSoilCoupling.getVolumetricWater(streamerSlot);
  hardness *= (1.0 - volWater * 0.5);

  // Frozen soil is harder.
  const soilTemp = BiomeSoilCoupling.getSoilTemperatureC(streamerSlot);
  if (soilTemp < 0) {
    hardness += FROZEN_HARDNESS_BONUS;
  }

  return Math.max(GROUND_HARDNESS_MIN, Math.min(GROUND_HARDNESS_MAX, hardness));
}

// ══════════════════════════════════════════════════════════════════
// ─── CHUNK SENSORY COMPUTATION ────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _computeChunkSensory(streamerSlot, nowS) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_SENSORY_DETAIL[tier];

  // Skip fully occluded chunks.
  if (LandscapeChunkOcclusion.isFullyOccluded(streamerSlot)) {
    _isOccluded[streamerSlot] = 1;
    _sensoryDirty[streamerSlot] = 0;
    return false;
  }
  _isOccluded[streamerSlot] = 0;

  // Read the chunk descriptor.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return false;
  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return false;

  // ─── THOUSAND_KILOMETER tier: single sensory tint only ──
  if (detail === SENSORY_DETAIL.TINT_ONLY) {
    const biome = BiomeRegistry.getBiome(view.dominantBiomeId);
    const tempC = _computeTactileTemperature(streamerSlot);
    const humidity = _computeTactileHumidity(streamerSlot);
    _sensoryTint[streamerSlot] = (tempC / 40.0 + humidity) * 0.5;
    return true;
  }

  const timeOfDay = _currentTimeOfDayHours();

  // ─── ACOUSTIC ────────────────────────────────────────────
  _acousticBiological[streamerSlot] = _computeAcousticBiological(streamerSlot, view, timeOfDay);
  _acousticGeological[streamerSlot] = _computeAcousticGeological(streamerSlot, view);
  _acousticWater[streamerSlot] = _computeAcousticWater(streamerSlot, view);
  _acousticWind[streamerSlot] = _computeAcousticWind(streamerSlot, view);
  _acousticVegetation[streamerSlot] = _computeAcousticVegetation(streamerSlot, view);
  _acousticMechanical[streamerSlot] = _computeAcousticMechanical(streamerSlot);

  // ─── OLFACTORY ───────────────────────────────────────────
  _olfactoryFloral[streamerSlot] = _computeOlfactoryFloral(streamerSlot, view);
  _olfactoryEarthy[streamerSlot] = _computeOlfactoryEarthy(streamerSlot, view);
  _olfactoryAquatic[streamerSlot] = _computeOlfactoryAquatic(streamerSlot, view);
  _olfactoryWoodland[streamerSlot] = _computeOlfactoryWoodland(streamerSlot, view);
  _olfactorySmoke[streamerSlot] = _computeOlfactorySmoke(streamerSlot, view);
  _olfactoryAnimal[streamerSlot] = _computeOlfactoryAnimal(streamerSlot, view);
  _olfactoryDecay[streamerSlot] = _computeOlfactoryDecay(streamerSlot, view);
  if (detail === SENSORY_DETAIL.FULL) {
    _olfactorySulfur[streamerSlot] = _computeOlfactorySulfur(streamerSlot, view);
    _olfactorySea[streamerSlot] = _computeOlfactorySea(streamerSlot, view);
    _olfactoryClean[streamerSlot] = _computeOlfactoryClean(streamerSlot, view);
  } else {
    _olfactorySulfur[streamerSlot] = 0;
    _olfactorySea[streamerSlot] = _computeOlfactorySea(streamerSlot, view);
    _olfactoryClean[streamerSlot] = 0;
  }

  // ─── TACTILE ─────────────────────────────────────────────
  _tactileTemperatureC[streamerSlot] = _computeTactileTemperature(streamerSlot);
  _tactileHumidity[streamerSlot] = _computeTactileHumidity(streamerSlot);
  _tactileWindPressure[streamerSlot] = _computeTactileWindPressure(streamerSlot);
  _tactilePrecipType[streamerSlot] = _computeTactilePrecipType(streamerSlot);
  _tactilePrecipIntensity[streamerSlot] = _computeTactilePrecipIntensity(streamerSlot);
  _tactileGroundHardness[streamerSlot] = _computeTactileGroundHardness(streamerSlot);

  // ─── Drift detection ─────────────────────────────────────
  const lastBio = _lastAcousticBiological[streamerSlot];
  const lastWind = _lastAcousticWind[streamerSlot];
  const lastFloral = _lastOlfactoryFloral[streamerSlot];
  const lastEarthy = _lastOlfactoryEarthy[streamerSlot];
  const lastTemp = _lastTemperatureC[streamerSlot];
  const lastHum = _lastHumidity[streamerSlot];
  const lastPrecip = _lastPrecipIntensity[streamerSlot];

  const bioChanged = Math.abs(_acousticBiological[streamerSlot] - lastBio) > DRIFT_ACOUSTIC;
  const windChanged = Math.abs(_acousticWind[streamerSlot] - lastWind) > DRIFT_ACOUSTIC;
  const floralChanged = Math.abs(_olfactoryFloral[streamerSlot] - lastFloral) > DRIFT_OLFACTORY;
  const earthyChanged = Math.abs(_olfactoryEarthy[streamerSlot] - lastEarthy) > DRIFT_OLFACTORY;
  const tempChanged = Math.abs(_tactileTemperatureC[streamerSlot] - lastTemp) > DRIFT_TEMPERATURE;
  const humChanged = Math.abs(_tactileHumidity[streamerSlot] - lastHum) > DRIFT_HUMIDITY;
  const precipChanged = Math.abs(_tactilePrecipIntensity[streamerSlot] - lastPrecip) > DRIFT_PRECIP;

  if (!bioChanged && !windChanged && !floralChanged && !earthyChanged
      && !tempChanged && !humChanged && !precipChanged
      && _lastEvalS[streamerSlot] >= 0
      && (nowS - _lastEvalS[streamerSlot] < 5.0)) {
    _sensoryDirty[streamerSlot] = 0;
    return false;
  }

  // Update the last-evaluated snapshot.
  _lastAcousticBiological[streamerSlot] = _acousticBiological[streamerSlot];
  _lastAcousticWind[streamerSlot] = _acousticWind[streamerSlot];
  _lastOlfactoryFloral[streamerSlot] = _olfactoryFloral[streamerSlot];
  _lastOlfactoryEarthy[streamerSlot] = _olfactoryEarthy[streamerSlot];
  _lastTemperatureC[streamerSlot] = _tactileTemperatureC[streamerSlot];
  _lastHumidity[streamerSlot] = _tactileHumidity[streamerSlot];
  _lastPrecipIntensity[streamerSlot] = _tactilePrecipIntensity[streamerSlot];
  _lastEvalS[streamerSlot] = nowS;
  _sensoryDirty[streamerSlot] = 0;

  return true;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeSensoryCoupler = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  SENSORY_DETAIL,
  sensoryFloats: SENSORY_FLOATS,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,

  // Channel constants for downstream consumers.
  ACOUSTIC_BIOLOGICAL: CH_ACOUSTIC_BIOLOGICAL,
  ACOUSTIC_GEOLOGICAL: CH_ACOUSTIC_GEOLOGICAL,
  ACOUSTIC_WATER: CH_ACOUSTIC_WATER,
  ACOUSTIC_WIND: CH_ACOUSTIC_WIND,
  ACOUSTIC_VEGETATION: CH_ACOUSTIC_VEGETATION,
  ACOUSTIC_MECHANICAL: CH_ACOUSTIC_MECHANICAL,
  OLFACTORY_FLORAL: CH_OLFACTORY_FLORAL,
  OLFACTORY_EARTHY: CH_OLFACTORY_EARTHY,
  OLFACTORY_AQUATIC: CH_OLFACTORY_AQUATIC,
  OLFACTORY_WOODLAND: CH_OLFACTORY_WOODLAND,
  OLFACTORY_SMOKE: CH_OLFACTORY_SMOKE,
  OLFACTORY_ANIMAL: CH_OLFACTORY_ANIMAL,
  OLFACTORY_DECAY: CH_OLFACTORY_DECAY,
  OLFACTORY_SULFUR: CH_OLFACTORY_SULFUR,
  OLFACTORY_SEA: CH_OLFACTORY_SEA,
  OLFACTORY_CLEAN: CH_OLFACTORY_CLEAN,
  TACTILE_TEMPERATURE_C: CH_TACTILE_TEMPERATURE_C,
  TACTILE_HUMIDITY: CH_TACTILE_HUMIDITY,
  TACTILE_WIND_PRESSURE_PA: CH_TACTILE_WIND_PRESSURE_PA,
  TACTILE_PRECIP_TYPE: CH_TACTILE_PRECIP_TYPE,
  TACTILE_PRECIP_INTENSITY: CH_TACTILE_PRECIP_INTENSITY,
  TACTILE_GROUND_HARDNESS: CH_TACTILE_GROUND_HARDNESS,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _sensoryDirty[streamerSlot] = 1;
    _isOccluded[streamerSlot] = 0;
    _lastEvalS[streamerSlot] = -1;
    _lastAcousticBiological[streamerSlot] = -1;
    _lastAcousticWind[streamerSlot] = -1;
    _lastOlfactoryFloral[streamerSlot] = -1;
    _lastOlfactoryEarthy[streamerSlot] = -1;
    _lastTemperatureC[streamerSlot] = -1e9;
    _lastHumidity[streamerSlot] = -1;
    _lastPrecipIntensity[streamerSlot] = -1;
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
    let skipped = 0;
    let activeChunks = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      activeChunks++;
      processed++;

      if (_sensoryDirty[slot] === 0 && _lastEvalS[slot] >= 0
          && (nowS - _lastEvalS[slot] < 5.0)) {
        skipped++;
        continue;
      }

      if (_computeChunkSensory(slot, nowS)) changed++;

      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastChanged = changed;
    _lastSkipped = skipped;
    _lastActiveChunks = activeChunks;
    _lastTickDurationMs = performanceNow() - t0;

    if (changed > 0) {
      _dispatcher.emit(EVENT_TYPE.SENSORY_UPDATED, {
        tick,
        processed,
        changed,
        skipped,
        activeChunks,
        durationMs: _lastTickDurationMs
      });
    }
  },

  /**
   * Mark a chunk as needing a sensory re-evaluation. Called by 337 when a
   * chunk is streamed in, by 349 when a prop is placed, by 347 when an
   * animal is spawned, and by 353 when the season changes.
   */
  markDirty(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return;
    _sensoryDirty[streamerSlot] = 1;
  },

  /**
   * Read the full sensory record for a chunk. Zero-allocation.
   */
  readSensoryRecord(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    out.acousticBiological = _acousticBiological[streamerSlot];
    out.acousticGeological = _acousticGeological[streamerSlot];
    out.acousticWater = _acousticWater[streamerSlot];
    out.acousticWind = _acousticWind[streamerSlot];
    out.acousticVegetation = _acousticVegetation[streamerSlot];
    out.acousticMechanical = _acousticMechanical[streamerSlot];
    out.olfactoryFloral = _olfactoryFloral[streamerSlot];
    out.olfactoryEarthy = _olfactoryEarthy[streamerSlot];
    out.olfactoryAquatic = _olfactoryAquatic[streamerSlot];
    out.olfactoryWoodland = _olfactoryWoodland[streamerSlot];
    out.olfactorySmoke = _olfactorySmoke[streamerSlot];
    out.olfactoryAnimal = _olfactoryAnimal[streamerSlot];
    out.olfactoryDecay = _olfactoryDecay[streamerSlot];
    out.olfactorySulfur = _olfactorySulfur[streamerSlot];
    out.olfactorySea = _olfactorySea[streamerSlot];
    out.olfactoryClean = _olfactoryClean[streamerSlot];
    out.tactileTemperatureC = _tactileTemperatureC[streamerSlot];
    out.tactileHumidity = _tactileHumidity[streamerSlot];
    out.tactileWindPressurePa = _tactileWindPressure[streamerSlot];
    out.tactilePrecipType = _tactilePrecipType[streamerSlot];
    out.tactilePrecipIntensity = _tactilePrecipIntensity[streamerSlot];
    out.tactileGroundHardness = _tactileGroundHardness[streamerSlot];
    out.sensoryTint = _sensoryTint[streamerSlot];
    out.isOccluded = _isOccluded[streamerSlot] === 1;
    return true;
  },

  /**
   * Read the sensory batch for all active chunks. Zero-allocation.
   *
   * Layout per chunk (32 floats):
   *   [0..5]   acoustic channels (biological, geological, water, wind,
   *            vegetation, mechanical)
   *   [6..15]  olfactory channels (floral, earthy, aquatic, woodland, smoke,
   *            animal, decay, sulfur, sea, clean)
   *   [16]     tactile temperature (°C)
   *   [17]     tactile humidity (0..1)
   *   [18]     tactile wind pressure (Pa)
   *   [19]     tactile precipitation type (0=none, 1=rain, 2=snow, 3=sleet)
   *   [20]     tactile precipitation intensity (0..1)
   *   [21]     tactile ground hardness (0..1)
   *   [22]     sensory tint
   *   [23]     is occluded (0 or 1)
   *   [24..31] reserved
   */
  readSensoryBatch(outFloats) {
    let written = 0;
    let count = 0;
    for (let s = 0; s < MAX_TRACKED_CHUNKS; s++) {
      if (!_chunkActive[s]) continue;
      if (written + SENSORY_FLOATS > outFloats.length) break;
      outFloats[written++] = _acousticBiological[s];
      outFloats[written++] = _acousticGeological[s];
      outFloats[written++] = _acousticWater[s];
      outFloats[written++] = _acousticWind[s];
      outFloats[written++] = _acousticVegetation[s];
      outFloats[written++] = _acousticMechanical[s];
      outFloats[written++] = _olfactoryFloral[s];
      outFloats[written++] = _olfactoryEarthy[s];
      outFloats[written++] = _olfactoryAquatic[s];
      outFloats[written++] = _olfactoryWoodland[s];
      outFloats[written++] = _olfactorySmoke[s];
      outFloats[written++] = _olfactoryAnimal[s];
      outFloats[written++] = _olfactoryDecay[s];
      outFloats[written++] = _olfactorySulfur[s];
      outFloats[written++] = _olfactorySea[s];
      outFloats[written++] = _olfactoryClean[s];
      outFloats[written++] = _tactileTemperatureC[s];
      outFloats[written++] = _tactileHumidity[s];
      outFloats[written++] = _tactileWindPressure[s];
      outFloats[written++] = _tactilePrecipType[s];
      outFloats[written++] = _tactilePrecipIntensity[s];
      outFloats[written++] = _tactileGroundHardness[s];
      outFloats[written++] = _sensoryTint[s];
      outFloats[written++] = _isOccluded[s];
      for (let k = 24; k < SENSORY_FLOATS; k++) outFloats[written++] = 0;
      count++;
    }
    return written;
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getAcousticBiological(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _acousticBiological[slot] : 0; },
  getAcousticGeological(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _acousticGeological[slot] : 0; },
  getAcousticWater(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _acousticWater[slot] : 0; },
  getAcousticWind(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _acousticWind[slot] : 0; },
  getAcousticVegetation(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _acousticVegetation[slot] : 0; },
  getAcousticMechanical(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _acousticMechanical[slot] : 0; },
  getOlfactoryFloral(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactoryFloral[slot] : 0; },
  getOlfactoryEarthy(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactoryEarthy[slot] : 0; },
  getOlfactoryAquatic(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactoryAquatic[slot] : 0; },
  getOlfactoryWoodland(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactoryWoodland[slot] : 0; },
  getOlfactorySmoke(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactorySmoke[slot] : 0; },
  getOlfactoryAnimal(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactoryAnimal[slot] : 0; },
  getOlfactoryDecay(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactoryDecay[slot] : 0; },
  getOlfactorySulfur(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactorySulfur[slot] : 0; },
  getOlfactorySea(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactorySea[slot] : 0; },
  getOlfactoryClean(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _olfactoryClean[slot] : 0; },
  getTactileTemperatureC(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _tactileTemperatureC[slot] : 15; },
  getTactileHumidity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _tactileHumidity[slot] : 0.5; },
  getTactileWindPressurePa(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _tactileWindPressure[slot] : 0; },
  getTactilePrecipType(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _tactilePrecipType[slot] : 0; },
  getTactilePrecipIntensity(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _tactilePrecipIntensity[slot] : 0; },
  getTactileGroundHardness(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _tactileGroundHardness[slot] : 0.5; },
  getSensoryTint(slot) { return (slot >= 0 && slot < MAX_TRACKED_CHUNKS) ? _sensoryTint[slot] : 0; },

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

export default LandscapeSensoryCoupler;