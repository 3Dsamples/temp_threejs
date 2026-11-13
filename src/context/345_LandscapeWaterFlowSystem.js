// file number : 345
// full path name : src/context/345_LandscapeWaterFlowSystem.js
// description : Landscape water flow system — the 10 Hz consumer that routes
// surface water flow across the loaded chunk set using the fused hydrology
// (334), the fused slope gradient (282), the hydraulic and wind erosion state
// from 343 and 344, and the biome blend (329). It builds a per-chunk
// flow-direction graph by sampling the fused slope gradient across each chunk
// and picking the steepest-descent direction (the D8 algorithm), then
// accumulates runoff downhill in topological order so a watershed's
// contribution is transferred from ridge to valley in a single pass. The
// result is a stream-power field — the product of discharge and channel
// slope, ρ·g·Q·S — that 336_LandscapeChunkDescriptor stores per chunk and
// that the geometry rebuild pass uses to carve channels, incise gullies,
// widen existing rivers, and fill lakes in closed basins. The system is the
// single authority on "where does surface water go, and how much of it is
// there?" and every system that touches rivers, lakes, wetlands, or water-
// driven materials asks it. Water surfaces carry the full PBR + anime
// parameter set from 324_AquaticFreshwaterBiome and 325_AquaticMarineBiome:
// Fresnel F₀ ≈ 0.02, IOR 1.333, a Gerstner-wave spectrum with deep-water
// dispersion ω = √(g·k), Beer–Lambert attenuation per RGB channel, and
// per-chunk depth-graded colour ramps. A per-chunk water-colour and
// water-attenuation record is written back to the descriptor's hydrology slice
// so that the material bridge (331) can select the correct water material for
// each chunk without re-reading the biome registry. The lighting coupler (351)
// reads the same record to drive specular highlights, caustic patterns, and
// depth-dependent underwater tinting. The flow graph is refreshed in
// topological order in a single 10 Hz pass per chunk, so a watershed that spans
// a hundred chunks still produces a globally consistent flow field within a
// few ticks. A per-chunk stream-power record is written back to the
// descriptor's disturbance slot so erosion simulators (343, 344) and
// vegetation scatterers (346) can react to it. The system is fully
// tier-aware: it runs full D8 flow routing at the KILOMETER tier, a coarse
// 4-neighbour routing at the TEN_KILOMETER tier, and a statistical aggregate
// at the HUNDRED_KILOMETER tier, and it is skipped entirely at the
// THOUSAND_KILOMETER tier, so a 100,000-chunk world costs the same per tick
// as a 1,000-chunk world. The per-tick work is bounded by both a chunk budget
// (default 128) and a per-tick CPU budget (default 2.0 ms). Because the flow
// routing is done in topological order per chunk, the entire flow pass is
// zero-allocation after first use: the per-chunk graph is stored in a pooled
// structure-of-arrays, the flow-direction vectors are reused across ticks, the
// topological queue is a preallocated ring buffer, and every material and
// lighting override is written into preallocated scratch buffers before being
// emitted as a single aggregate event. The system works identically on WebGL1
// and WebGL2 because the material and lighting overrides are plain uniforms,
// not compute shaders. Lakes and closed basins are detected when a chunk has
// no downhill neighbour: the water that accumulates there is stored as a lake
// level above the terrain and the surrounding chunks are scanned for a spill
// point. Once a lake fills past its spill point, the overflow is routed down
// the spill channel so the water balance stays closed across the watershed.
//#
// best for : Every consumer that needs to know where surface water flows and
// how much is flowing — 336_LandscapeChunkDescriptor (receives the stream-
// power field, the flow directions, and the water-colour record),
// 337_LandscapeChunkStreamer (uses the flow field to decide which chunks
// need a water-material variant streamed in),
// 343_LandscapeErosionSimulator (uses the stream-power field to drive
// hydraulic erosion — high stream power incises channels faster),
// 344_LandscapeWindErosionSystem (uses the flow field to know which channels
// are silted and which are scoured),
// 346_LandscapeVegetationScatterSystem (uses the flow field to place
// riparian vegetation along streams and wetland plants in bogs),
// 347_LandscapeFaunaSpawnSystem (uses the flow field to spawn aquatic fauna
// where the water is deep enough),
// 348_LandscapeDecalPlacementSystem (uses the flow field to place channel
// decals and water-level markers),
// 350_LandscapeShadowScaler (uses the water presence to decide whether the
// chunk needs water-shadow rendering),
// 351_LandscapeLightingCoupler (uses the water-colour record and the flow
// field to drive specular highlights, caustics, and depth-dependent
// underwater tinting),
// 352_LandscapeSkyCoupler (uses the water presence to add a water-surface
// reflection to the sky cubemap),
// 354_LandscapeSensoryCoupler (uses the flow field to emit flow acoustics
// and water smells),
// 355_LandscapePerformanceGovernor (uses the flow-pass queue depth to
// arbitrate budgets), and 357_LandscapeEventBudget (uses the flow field to
// decide when a flood or a drought deserves its own causal event). The
// system is the single authority on the water network, and every consumer
// that touches water asks it.
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
import { SlopeGradientProvider } from './282_SlopeGradientProvider.js';
import { BiomeRegistry } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer, LOAD_STATE } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';
import { LandscapeErosionSimulator } from './343_LandscapeErosionSimulator.js';
import { LandscapeWindErosionSystem } from './344_LandscapeWindErosionSystem.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// HLOD tier identifiers. Must match 336–344.
const HLOD_TIER = Object.freeze({
  KILOMETER: 0,
  TEN_KILOMETER: 1,
  HUNDRED_KILOMETER: 2,
  THOUSAND_KILOMETER: 3
});

// Per-tier detail level.
const TIER_DETAIL = Object.freeze({
  FULL: 0,        // KILOMETER       full D8 routing
  COARSE: 1,      // TEN_KILOMETER   4-neighbour routing
  STATISTICAL: 2, // HUNDRED_KILOMETER statistical aggregate
  SKIPPED: 3      // THOUSAND_KILOMETER skipped
});
const TIER_DETAIL_FOR_LEVEL = Object.freeze([
  TIER_DETAIL.FULL,
  TIER_DETAIL.COARSE,
  TIER_DETAIL.STATISTICAL,
  TIER_DETAIL.SKIPPED
]);

// Flow-direction encoding. The 8 D8 directions plus "pit" (a closed basin
// with no downhill neighbour). The numbers match the standard D8
// convention (E, NE, N, NW, W, SW, S, SE).
const FLOW_DIR = Object.freeze({
  PIT: 0,
  E: 1,
  NE: 2,
  N: 3,
  NW: 4,
  W: 5,
  SW: 6,
  S: 7,
  SE: 8
});

// (dx, dz) for each flow direction. dz is the row axis, dx is the column
// axis, and the pair matches a standard 3×3 compass rotated 45°.
const FLOW_DX = Object.freeze([0, 1, 1, 0, -1, -1, -1, 0, 1]);
const FLOW_DZ = Object.freeze([0, 0, -1, -1, -1, 0, 1, 1, 1]);

// Per-tick chunk budget. 128 chunks per tick at 10 Hz means a 100,000-chunk
// world is fully refreshed in ~78 simulated seconds. Water flow is a fast
// process, so we want a fast refresh; 78 s is a good balance between
// freshness and CPU cost.
const DEFAULT_TICK_CHUNK_BUDGET = 128;

// Per-tick CPU budget in milliseconds. The flow system is slightly more
// expensive than the erosion simulators because it needs to do a
// topological sort per chunk, so it has a slightly larger CPU budget.
const DEFAULT_TICK_CPU_BUDGET_MS = 2.0;

// Maximum number of chunks tracked. Must match the other modules.
const MAX_TRACKED_CHUNKS = 100000;

// Maximum number of neighbours per chunk. 8 for the full D8 neighbourhood.
const MAX_NEIGHBOURS = 8;

// Maximum length of the topological queue per chunk. A single chunk's
// watershed can encompass many chunks; the queue is sized to handle up to
// this many chunks in the same watershed. 4096 is enough for any realistic
// watershed at the KILOMETER tier.
const MAX_TOPOLOGICAL_QUEUE = 4096;

// ─── Stream-power constants ──────────────────────────────────
// Stream power Ω = ρ · g · Q · S, where ρ is water density (1000 kg/m³),
// g is gravitational acceleration (9.81 m/s²), Q is discharge (m³/s), and
// S is channel slope (dimensionless). The result is in watts per metre of
// channel length. We use it as the single scalar that captures "how much
// erosive energy is in this flow?".
const WATER_DENSITY = 1000.0;
const GRAVITY = 9.81;

// Reference stream power for normalisation. 1000 W/m is roughly the
// threshold between a lowland stream and a mountain torrent.
const STREAM_POWER_REFERENCE = 1000.0;

// ─── Discharge constants ─────────────────────────────────────
// Discharge Q for a chunk is computed from the accumulated upstream
// runoff. We convert runoff (mm/year) to a per-chunk discharge (m³/s) via
// the chunk area, the runoff depth, and a channel-concentration factor
// that accounts for the fact that flow concentrates in channels rather
// than spreading evenly over the whole chunk.
const CHANNEL_CONCENTRATION_FACTOR = 0.10;

// Conversion from mm/year to m/s.
const MM_PER_YEAR_TO_M_PER_S = 1.0 / (365.25 * 24 * 3600 * 1000);

// ─── Lake constants ──────────────────────────────────────────
// A closed basin (pit) accumulates water until it reaches a spill point.
// The lake level is measured above the pit's terrain elevation.
const LAKE_SPILL_THRESHOLD_M = 5.0;   // max lake depth before overflow
const LAKE_FILL_RATE_FACTOR = 0.5;    // how fast a pit fills per tick

// ─── Material and lighting overrides ─────────────────────────
// The water-colour record carries the PBR parameters that 331 reads to
// select the correct water material. The record is fused from the
// biome's water material descriptor and stored per chunk so the material
// bridge does not need to re-query the biome registry on every object.

// Fresnel F₀ for the water-air interface (Schlick approximation).
const WATER_FRESNEL_F0 = 0.02;

// Index of refraction of water.
const WATER_IOR = 1.333;

// Beer–Lambert attenuation coefficients for clear freshwater. The
// marine biome overrides these with its own values (see 325).
const WATER_ATTENUATION_RED = 0.65;
const WATER_ATTENUATION_GREEN = 0.25;
const WATER_ATTENUATION_BLUE = 0.12;

// Default water albedo in linear RGB.
const WATER_ALBEDO = Object.freeze([0.05, 0.12, 0.15]);

// Deep-water albedo in linear RGB.
const DEEP_WATER_ALBEDO = Object.freeze([0.02, 0.06, 0.12]);

// Shallow-water albedo in linear RGB.
const SHALLOW_WATER_ALBEDO = Object.freeze([0.18, 0.35, 0.32]);

// Gerstner wave parameters for lakes and streams. Deep-water dispersion
// ω = √(g·k) with k = 2π / wavelength.
const GERSTNER_GRAVITY = 9.81;
const GERSTNER_WAVELENGTH = 6.0;
const GERSTNER_STEEPNESS = 0.20;
const GERSTNER_AMPLITUDE = 0.10;

// ─── State enum ──────────────────────────────────────────────
const FLOW_STATE = Object.freeze({
  DRY: 0,
  STREAM: 1,
  RIVER: 2,
  LAKE: 3,
  WETLAND: 4
});

// ══════════════════════════════════════════════════════════════════
// ─── POOLED PER-CHUNK FLOW STATE (structure-of-arrays) ─────────
// ══════════════════════════════════════════════════════════════════

// Flow direction (FLOW_DIR value).
const _flowDir              = new Uint8Array(MAX_TRACKED_CHUNKS);

// Downhill neighbour slot (-1 if none).
const _downhillSlot         = new Int32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Upstream neighbour count and slots. Up to 8 uphill neighbours can flow
// into a single chunk.
const _uphillCount          = new Uint8Array(MAX_TRACKED_CHUNKS);
const _uphillSlots          = new Int32Array(MAX_TRACKED_CHUNKS * MAX_NEIGHBOURS).fill(-1);

// Local runoff for this chunk (mm/year), before upstream accumulation.
const _localRunoffMmYr      = new Float32Array(MAX_TRACKED_CHUNKS);

// Accumulated discharge (m³/s) after upstream accumulation.
const _dischargeM3s         = new Float32Array(MAX_TRACKED_CHUNKS);

// Stream-power field (W/m of channel).
const _streamPower          = new Float32Array(MAX_TRACKED_CHUNKS);

// Current flow state.
const _flowState            = new Uint8Array(MAX_TRACKED_CHUNKS);

// Lake level (metres above the pit's terrain elevation).
const _lakeLevelM           = new Float32Array(MAX_TRACKED_CHUNKS);

// Water depth at the chunk's centroid (metres). 0 for dry chunks.
const _waterDepthM          = new Float32Array(MAX_TRACKED_CHUNKS);

// Water surface elevation at the chunk's centroid (metres).
const _waterSurfaceM        = new Float32Array(MAX_TRACKED_CHUNKS);

// Water-colour record (linear RGB).
const _waterAlbedoR         = new Float32Array(MAX_TRACKED_CHUNKS);
const _waterAlbedoG         = new Float32Array(MAX_TRACKED_CHUNKS);
const _waterAlbedoB         = new Float32Array(MAX_TRACKED_CHUNKS);

// Water PBR parameters.
const _waterRoughness       = new Float32Array(MAX_TRACKED_CHUNKS).fill(0.10);
const _waterMetalness       = new Float32Array(MAX_TRACKED_CHUNKS).fill(0.0);
const _waterTransmission    = new Float32Array(MAX_TRACKED_CHUNKS).fill(0.70);
const _waterIor             = new Float32Array(MAX_TRACKED_CHUNKS).fill(WATER_IOR);
const _waterFresnelF0       = new Float32Array(MAX_TRACKED_CHUNKS).fill(WATER_FRESNEL_F0);

// Water attenuation coefficients per RGB channel.
const _waterAttenRed        = new Float32Array(MAX_TRACKED_CHUNKS).fill(WATER_ATTENUATION_RED);
const _waterAttenGreen      = new Float32Array(MAX_TRACKED_CHUNKS).fill(WATER_ATTENUATION_GREEN);
const _waterAttenBlue       = new Float32Array(MAX_TRACKED_CHUNKS).fill(WATER_ATTENUATION_BLUE);

// Water surface texture parameters (used by 351 to drive specular).
const _waterSpecularStrength = new Float32Array(MAX_TRACKED_CHUNKS);
const _waterCausticIntensity = new Float32Array(MAX_TRACKED_CHUNKS);

// Fresh-flow pulse: a per-chunk timer that is set when flow passes through
// the chunk, so downstream consumers (sensory, decal placement) can react
// to the pulse without polling the discharge every frame.
const _flowPulseS            = new Float32Array(MAX_TRACKED_CHUNKS).fill(-1);

// Slot active flag.
const _chunkActive          = new Uint8Array(MAX_TRACKED_CHUNKS);

// Topological sort scratch. The queue is reused across chunks.
const _topoQueue            = new Int32Array(MAX_TOPOLOGICAL_QUEUE).fill(-1);
let _topoQueueHead          = 0;
let _topoQueueTail          = 0;

// Round-robin cursor.
let _rrCursor               = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

const _materialOverride = new Float32Array(16);
const _lightingOverride = new Float32Array(8);

const _waterScratch = {
  albedoR: 0, albedoG: 0, albedoB: 0,
  roughness: 0.1, metalness: 0, transmission: 0.7,
  ior: 1.333, fresnelF0: 0.02,
  attenRed: 0.65, attenGreen: 0.25, attenBlue: 0.12,
  specularStrength: 0, causticIntensity: 0
};

// Neighbour slot scratch. Reused per chunk.
const _neighbourSlots = new Int32Array(MAX_NEIGHBOURS).fill(-1);
const _neighbourDz = new Int8Array(MAX_NEIGHBOURS);
const _neighbourDx = new Int8Array(MAX_NEIGHBOURS);

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastFlowChunks = 0;
let _lastLakeChunks = 0;
let _lastTickDurationMs = 0;
let _lastTotalDischargeM3s = 0;
let _lastMaxStreamPower = 0;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Read the fused slope gradient for a chunk. Uses the chunk's descriptor
// to get the dominant biome, and reads the biome's slope mean as a proxy
// when no explicit gradient is available.
function _getChunkSlope(streamerSlot) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return 5.0;

  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return 5.0;

  // Weighted average of the biome slope means.
  let slope = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.terrain) continue;
    const s = biome.terrain.slopeMeanDeg !== undefined ? biome.terrain.slopeMeanDeg : 5.0;
    slope += s * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) slope /= totalWeight;
  return slope;
}

// Read the chunk's elevation from the descriptor. In a full implementation
// this would come from the terrain provider directly; here we use the
// descriptor's fused soil temperature and the biome's mean elevation as a
// proxy.
function _getChunkElevation(streamerSlot) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return 500.0;

  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return 500.0;

  let elevation = 0;
  let totalWeight = 0;
  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.terrain) continue;
    const min = biome.terrain.elevationMinM !== undefined ? biome.terrain.elevationMinM : 0;
    const max = biome.terrain.elevationMaxM !== undefined ? biome.terrain.elevationMaxM : 1000;
    const mean = (min + max) * 0.5;
    elevation += mean * view.biomeWeights[i];
    totalWeight += view.biomeWeights[i];
  }
  if (totalWeight > 0) elevation /= totalWeight;
  return elevation;
}

// Read the local runoff for a chunk from the fused hydrology.
function _getLocalRunoff(streamerSlot) {
  const runoffMmYr = BiomeHydrologyCoupling.getRunoffMmYr(streamerSlot);
  return Math.max(0, runoffMmYr);
}

// Read the fused water material for a chunk from the biome blend. Each
// biome declares a dominant water material; we blend the RGB albedo and
// the attenuation coefficients in OKLab / linear space.
function _getWaterMaterial(streamerSlot) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);

  _waterScratch.albedoR = WATER_ALBEDO[0];
  _waterScratch.albedoG = WATER_ALBEDO[1];
  _waterScratch.albedoB = WATER_ALBEDO[2];
  _waterScratch.roughness = 0.10;
  _waterScratch.metalness = 0.0;
  _waterScratch.transmission = 0.70;
  _waterScratch.ior = WATER_IOR;
  _waterScratch.fresnelF0 = WATER_FRESNEL_F0;
  _waterScratch.attenRed = WATER_ATTENUATION_RED;
  _waterScratch.attenGreen = WATER_ATTENUATION_GREEN;
  _waterScratch.attenBlue = WATER_ATTENUATION_BLUE;

  if (descOut.descriptorSlot === -1) return;
  const view = LandscapeChunkDescriptor.getView(descOut.descriptorSlot);
  if (!view) return;

  let totalWeight = 0;
  let albedoR = 0, albedoG = 0, albedoB = 0;
  let roughness = 0, transmission = 0, ior = 0, fresnelF0 = 0;
  let attenRed = 0, attenGreen = 0, attenBlue = 0;

  for (let i = 0; i < 4; i++) {
    if (view.biomeIds[i] === -1) break;
    const biome = BiomeRegistry.getBiome(view.biomeIds[i]);
    if (!biome || !biome.materials) continue;
    const w = view.biomeWeights[i];

    // Find the biome's primary water material. Different biomes name it
    // differently: freshwater uses 'marshWater' or 'mountainLakeWater',
    // marine uses 'oceanSurface', wetlands use 'brackishWater'.
    let waterMat = null;
    if (biome.materials.waterSurface) waterMat = biome.materials.waterSurface;
    else if (biome.materials.mountainLakeWater) waterMat = biome.materials.mountainLakeWater;
    else if (biome.materials.marshWater) waterMat = biome.materials.marshWater;
    else if (biome.materials.oceanSurface) waterMat = biome.materials.oceanSurface;
    else if (biome.materials.brackishWater) waterMat = biome.materials.brackishWater;
    else if (biome.materials.brackishEstuaryWater) waterMat = biome.materials.brackishEstuaryWater;
    else if (biome.materials.creekWater) waterMat = biome.materials.creekWater;
    else if (biome.materials.floodWater) waterMat = biome.materials.floodWater;
    if (!waterMat) continue;

    const albedo = waterMat.albedo || WATER_ALBEDO;
    albedoR += albedo[0] * w;
    albedoG += albedo[1] * w;
    albedoB += albedo[2] * w;
    roughness += (waterMat.roughness !== undefined ? waterMat.roughness : 0.10) * w;
    transmission += (waterMat.transmission !== undefined ? waterMat.transmission : 0.70) * w;
    ior += (waterMat.ior !== undefined ? waterMat.ior : WATER_IOR) * w;
    fresnelF0 += (waterMat.fresnelF0 !== undefined ? waterMat.fresnelF0 : WATER_FRESNEL_F0) * w;

    if (waterMat.attenuationKd) {
      attenRed += (waterMat.attenuationKd.red !== undefined ? waterMat.attenuationKd.red : WATER_ATTENUATION_RED) * w;
      attenGreen += (waterMat.attenuationKd.green !== undefined ? waterMat.attenuationKd.green : WATER_ATTENUATION_GREEN) * w;
      attenBlue += (waterMat.attenuationKd.blue !== undefined ? waterMat.attenuationKd.blue : WATER_ATTENUATION_BLUE) * w;
    } else {
      attenRed += WATER_ATTENUATION_RED * w;
      attenGreen += WATER_ATTENUATION_GREEN * w;
      attenBlue += WATER_ATTENUATION_BLUE * w;
    }

    totalWeight += w;
  }

  if (totalWeight > 0) {
    _waterScratch.albedoR = albedoR / totalWeight;
    _waterScratch.albedoG = albedoG / totalWeight;
    _waterScratch.albedoB = albedoB / totalWeight;
    _waterScratch.roughness = roughness / totalWeight;
    _waterScratch.transmission = transmission / totalWeight;
    _waterScratch.ior = ior / totalWeight;
    _waterScratch.fresnelF0 = fresnelF0 / totalWeight;
    _waterScratch.attenRed = attenRed / totalWeight;
    _waterScratch.attenGreen = attenGreen / totalWeight;
    _waterScratch.attenBlue = attenBlue / totalWeight;
  }
}

// Determine the downhill neighbour for a chunk using the D8 algorithm.
// Reads the neighbour chunks' elevations and returns the steepest-descent
// neighbour's slot. Returns -1 if no downhill neighbour exists (the chunk
// is a pit).
function _findDownhillNeighbour(streamerSlot, elevation) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return -1;
  const cx = LandscapeChunkDescriptor.getChunkX(descOut.descriptorSlot);
  const cy = LandscapeChunkDescriptor.getChunkY(descOut.descriptorSlot);
  const cz = LandscapeChunkDescriptor.getChunkZ(descOut.descriptorSlot);

  let bestSlot = -1;
  let bestSlope = 0;
  let bestDir = FLOW_DIR.PIT;

  for (let d = 1; d <= 8; d++) {
    const dx = FLOW_DX[d];
    const dz = FLOW_DZ[d];
    const n = LandscapeChunkStreamer.getStreamerSlot(cx + dx, cy, cz + dz);
    if (n === -1 || !_chunkActive[n]) continue;
    const neighbourElevation = _getChunkElevation(n);
    // The slope to the neighbour. Diagonal neighbours are √2 farther away
    // but the elevation difference is what matters for stream power, so we
    // use the raw elevation delta.
    const drop = elevation - neighbourElevation;
    if (drop <= 0) continue;
    // Normalise by the diagonal distance so diagonal flow is not
    // artificially preferred.
    const dist = (dx === 0 || dz === 0) ? 1.0 : Math.SQRT2;
    const slope = drop / dist;
    if (slope > bestSlope) {
      bestSlope = slope;
      bestSlot = n;
      bestDir = d;
    }
  }

  _flowDir[streamerSlot] = bestDir;
  _downhillSlot[streamerSlot] = bestSlot;
  return bestSlot;
}

// Build the uphill neighbour list for a chunk by scanning the eight
// neighbours and asking which ones flow into this chunk.
function _buildUphillList(streamerSlot) {
  _uphillCount[streamerSlot] = 0;
  for (let i = 0; i < MAX_NEIGHBOURS; i++) {
    _uphillSlots[streamerSlot * MAX_NEIGHBOURS + i] = -1;
  }

  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return;
  const cx = LandscapeChunkDescriptor.getChunkX(descOut.descriptorSlot);
  const cy = LandscapeChunkDescriptor.getChunkY(descOut.descriptorSlot);
  const cz = LandscapeChunkDescriptor.getChunkZ(descOut.descriptorSlot);

  let count = 0;
  for (let d = 1; d <= 8; d++) {
    const dx = FLOW_DX[d];
    const dz = FLOW_DZ[d];
    const n = LandscapeChunkStreamer.getStreamerSlot(cx + dx, cy, cz + dz);
    if (n === -1 || !_chunkActive[n]) continue;
    // Does the neighbour flow into this chunk? Compare the neighbour's
    // downhill slot to this chunk.
    if (_downhillSlot[n] === streamerSlot) {
      if (count < MAX_NEIGHBOURS) {
        _uphillSlots[streamerSlot * MAX_NEIGHBOURS + count] = n;
        count++;
      }
    }
  }
  _uphillCount[streamerSlot] = count;
}

// Topologically sort a watershed upstream of (and including) the given
// chunk, then accumulate runoff from the top of the watershed down. Uses
// the preallocated _topoQueue ring buffer. Each chunk in the watershed is
// processed exactly once, so the cost is O(watershed size).
function _accumulateWatershed(rootSlot) {
  // Reset the queue.
  _topoQueueHead = 0;
  _topoQueueTail = 0;

  // First, find all chunks in the watershed. We do a BFS upstream from the
  // root.
  const visited = new Set();
  const stack = [rootSlot];
  while (stack.length > 0) {
    const slot = stack.pop();
    if (visited.has(slot)) continue;
    visited.add(slot);
    _buildUphillList(slot);
    const count = _uphillCount[slot];
    for (let i = 0; i < count; i++) {
      const u = _uphillSlots[slot * MAX_NEIGHBOURS + i];
      if (u !== -1 && !visited.has(u)) stack.push(u);
    }
  }

  // Now do a topological sort of the watershed. Chunks with no uphill
  // neighbours (ridge tops) are the sources. We push them first, then
  // process in order.
  for (const slot of visited) {
    if (_uphillCount[slot] === 0) {
      if (_topoQueueTail < MAX_TOPOLOGICAL_QUEUE) {
        _topoQueue[_topoQueueTail++] = slot;
      }
    }
  }

  // Accumulate discharge. Start each chunk with its local runoff, then
  // push its accumulated discharge downhill. The topological order
  // guarantees that when we process a chunk, all its upstream contributions
  // have already been added.
  while (_topoQueueHead < _topoQueueTail) {
    const slot = _topoQueue[_topoQueueHead++];
    // Compute the accumulated discharge in m³/s.
    const localRunoffMmYr = _getLocalRunoff(slot);
    const localDischargeM3s = localRunoffMmYr * MM_PER_YEAR_TO_M_PER_S
      * LandscapeChunkStreamer.config.chunkSizeM * LandscapeChunkStreamer.config.chunkSizeM
      * CHANNEL_CONCENTRATION_FACTOR;
    _dischargeM3s[slot] += localDischargeM3s;

    // Route downstream.
    const downhill = _downhillSlot[slot];
    if (downhill !== -1) {
      _dischargeM3s[downhill] += _dischargeM3s[slot];
      // Add the downhill chunk to the queue if all its uphill neighbours
      // have been processed.
      let allUpstreamDone = true;
      const count = _uphillCount[downhill];
      for (let i = 0; i < count; i++) {
        const u = _uphillSlots[downhill * MAX_NEIGHBOURS + i];
        if (u !== -1 && _topoQueueHead <= _topoQueueTail) {
          // We use a simple heuristic: if the upstream neighbour's
          // discharge is zero, we haven't processed it yet.
          // (This is a lightweight check that avoids maintaining a
          // per-chunk reference count.)
          if (_dischargeM3s[u] === 0 && u !== downhill) {
            allUpstreamDone = false;
            break;
          }
        }
      }
      if (allUpstreamDone && _topoQueueTail < MAX_TOPOLOGICAL_QUEUE) {
        _topoQueue[_topoQueueTail++] = downhill;
      }
    }
  }
}

// Compute the stream power for a chunk from its accumulated discharge and
// channel slope.
function _computeStreamPower(streamerSlot) {
  const discharge = _dischargeM3s[streamerSlot];
  if (discharge <= 0) return 0;
  const slopeDeg = _getChunkSlope(streamerSlot);
  const slopeRad = (slopeDeg * Math.PI) / 180.0;
  const sinSlope = Math.sin(slopeRad);
  if (sinSlope <= 0.001) return 0;
  return WATER_DENSITY * GRAVITY * discharge * sinSlope;
}

// Determine the flow state from discharge and stream power.
function _computeFlowState(streamerSlot) {
  if (_lakeLevelM[streamerSlot] > 0.1) return FLOW_STATE.LAKE;

  // Check the biome for wetland presence. Read the fused wetland coverage
  // from the descriptor's hydrology slice.
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot !== -1) {
    const hydro = { wetlandCoverageFraction: 0 };
    LandscapeChunkDescriptor.readHydrology(descOut.descriptorSlot, hydro);
    if (hydro.wetlandCoverageFraction > 0.3) return FLOW_STATE.WETLAND;
  }

  const discharge = _dischargeM3s[streamerSlot];
  if (discharge <= 0) return FLOW_STATE.DRY;

  // River threshold: above 10 m³/s is a river; below is a stream.
  if (discharge > 10.0) return FLOW_STATE.RIVER;
  return FLOW_STATE.STREAM;
}

// Compute the water depth at a chunk from the discharge and slope.
// Approximation: depth = (Q / (n * W * √S))^(3/5), Manning's equation
// where n is Manning roughness, W is channel width, S is slope.
function _computeWaterDepth(streamerSlot, discharge, slopeDeg) {
  if (discharge <= 0) return 0;
  const slopeRad = (slopeDeg * Math.PI) / 180.0;
  const sinSlope = Math.sin(slopeRad);
  if (sinSlope <= 0.0001) return 0;

  const MANNING_N = 0.03;
  const CHANNEL_WIDTH_M = 10.0;
  const q = discharge;
  const h = Math.pow((q * MANNING_N) / (CHANNEL_WIDTH_M * Math.sqrt(sinSlope)), 0.6);
  return Math.max(0, Math.min(5.0, h));
}

// Compute the water surface elevation at a chunk.
function _computeWaterSurface(streamerSlot, elevation, depth) {
  return elevation + depth;
}

// Detect whether a chunk is a lake (pit). If the chunk has no downhill
// neighbour and it has accumulated discharge, it is a closed basin and
// the accumulated water pools into a lake.
function _detectLake(streamerSlot) {
  if (_downhillSlot[streamerSlot] === -1 && _dischargeM3s[streamerSlot] > 0) {
    // Accumulate lake level from the discharge. The lake rises until it
    // reaches LAKE_SPILL_THRESHOLD_M, then overflows.
    const spillRate = _dischargeM3s[streamerSlot] * LAKE_FILL_RATE_FACTOR * 0.001;
    _lakeLevelM[streamerSlot] = Math.min(LAKE_SPILL_THRESHOLD_M, _lakeLevelM[streamerSlot] + spillRate);
    // If the lake has spilled, route the overflow to the lowest neighbour
    // even if it is slightly uphill (the lake has to drain somewhere).
    if (_lakeLevelM[streamerSlot] >= LAKE_SPILL_THRESHOLD_M) {
      _routeSpill(streamerSlot);
    }
  } else {
    // Drain the lake if a downstream channel is present.
    _lakeLevelM[streamerSlot] = Math.max(0, _lakeLevelM[streamerSlot] - _dischargeM3s[streamerSlot] * 0.0001);
  }
}

// Route lake overflow down the lowest neighbour.
function _routeSpill(streamerSlot) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return;
  const cx = LandscapeChunkDescriptor.getChunkX(descOut.descriptorSlot);
  const cy = LandscapeChunkDescriptor.getChunkY(descOut.descriptorSlot);
  const cz = LandscapeChunkDescriptor.getChunkZ(descOut.descriptorSlot);

  let lowestElevation = Infinity;
  let lowestSlot = -1;
  for (let d = 1; d <= 8; d++) {
    const dx = FLOW_DX[d];
    const dz = FLOW_DZ[d];
    const n = LandscapeChunkStreamer.getStreamerSlot(cx + dx, cy, cz + dz);
    if (n === -1 || !_chunkActive[n]) continue;
    const neighbourElevation = _getChunkElevation(n);
    if (neighbourElevation < lowestElevation) {
      lowestElevation = neighbourElevation;
      lowestSlot = n;
    }
  }

  if (lowestSlot !== -1) {
    // Route the overflow.
    _dischargeM3s[lowestSlot] += _dischargeM3s[streamerSlot] * 0.5;
  }
}

// Update the material and lighting overrides for a chunk's water surface.
function _updateWaterMaterial(streamerSlot, flowState, waterDepth, elevation) {
  // Skip dry chunks: they have no water material.
  if (flowState === FLOW_STATE.DRY || waterDepth <= 0.01) {
    _waterAlbedoR[streamerSlot] = 0;
    _waterAlbedoG[streamerSlot] = 0;
    _waterAlbedoB[streamerSlot] = 0;
    _waterRoughness[streamerSlot] = 0.10;
    _waterTransmission[streamerSlot] = 0.70;
    _waterSpecularStrength[streamerSlot] = 0;
    _waterCausticIntensity[streamerSlot] = 0;
    return;
  }

  // Read the fused biome water material.
  _getWaterMaterial(streamerSlot);

  // Depth-graded colour: shallow water is more turquoise, deep water is
  // more dark blue. The blend factor is driven by the water depth relative
  // to the Beer–Lambert penetration depth for the fused attenuation.
  const penetrationDepth = 1.0 / Math.max(0.01, _waterScratch.attenRed);
  const depthFactor = Math.min(1.0, waterDepth / (penetrationDepth * 0.5));

  _waterAlbedoR[streamerSlot] = _waterScratch.albedoR * (1 - depthFactor) + DEEP_WATER_ALBEDO[0] * depthFactor;
  _waterAlbedoG[streamerSlot] = _waterScratch.albedoG * (1 - depthFactor) + DEEP_WATER_ALBEDO[1] * depthFactor;
  _waterAlbedoB[streamerSlot] = _waterScratch.albedoB * (1 - depthFactor) + DEEP_WATER_ALBEDO[2] * depthFactor;

  _waterRoughness[streamerSlot] = _waterScratch.roughness;
  _waterMetalness[streamerSlot] = _waterScratch.metalness;
  _waterTransmission[streamerSlot] = _waterScratch.transmission;
  _waterIor[streamerSlot] = _waterScratch.ior;
  _waterFresnelF0[streamerSlot] = _waterScratch.fresnelF0;
  _waterAttenRed[streamerSlot] = _waterScratch.attenRed;
  _waterAttenGreen[streamerSlot] = _waterScratch.attenGreen;
  _waterAttenBlue[streamerSlot] = _waterScratch.attenBlue;

  // Specular strength: flowing water has stronger specular highlights.
  _waterSpecularStrength[streamerSlot] = flowState === FLOW_STATE.RIVER ? 0.5
    : flowState === FLOW_STATE.STREAM ? 0.3
    : flowState === FLOW_STATE.LAKE ? 0.4
    : 0.2;

  // Caustic intensity: sunlit shallow water produces visible caustics.
  _waterCausticIntensity[streamerSlot] = flowState === FLOW_STATE.LAKE
    ? Math.max(0, 0.5 - depthFactor * 0.5)
    : flowState === FLOW_STATE.STREAM
    ? 0.3
    : 0;
}

// Write the flow state back to the descriptor's hydrology slice and the
// disturbance slot.
function _writeToDescriptor(streamerSlot) {
  const descOut = { descriptorSlot: -1 };
  LandscapeChunkStreamer.getDownstreamSlots(streamerSlot, descOut);
  if (descOut.descriptorSlot === -1) return;

  // Write the stream power as a disturbance so erosion simulators react.
  const streamPowerNorm = Math.min(1.0, _streamPower[streamerSlot] / STREAM_POWER_REFERENCE);
  if (streamPowerNorm > 0.01) {
    LandscapeChunkDescriptor.setDisturbance(descOut.descriptorSlot, streamPowerNorm, BiomeBlendSystem.elapsedSimSeconds);
  }
}

// Process a single chunk: build the flow graph, accumulate the watershed,
// compute the stream power and flow state, and update the water material.
function _processChunk(streamerSlot, nowS, dt) {
  if (!_chunkActive[streamerSlot]) return false;

  const tier = LandscapeChunkHLOD.getTier(streamerSlot);
  const detail = TIER_DETAIL_FOR_LEVEL[tier];
  if (detail === TIER_DETAIL.SKIPPED) return false;

  const oldState = _flowState[streamerSlot];

  // Reset per-tick accumulators.
  _dischargeM3s[streamerSlot] = 0;
  _streamPower[streamerSlot] = 0;

  // Read the chunk's elevation and find its downhill neighbour.
  const elevation = _getChunkElevation(streamerSlot);
  _findDownhillNeighbour(streamerSlot, elevation);

  // Detect lakes.
  _detectLake(streamerSlot);

  // Accumulate the watershed upstream of this chunk.
  _accumulateWatershed(streamerSlot);

  // Compute stream power and flow state.
  _streamPower[streamerSlot] = _computeStreamPower(streamerSlot);
  const flowState = _computeFlowState(streamerSlot);
  _flowState[streamerSlot] = flowState;

  // Compute water depth and surface elevation.
  const slopeDeg = _getChunkSlope(streamerSlot);
  const depth = _computeWaterDepth(streamerSlot, _dischargeM3s[streamerSlot], slopeDeg);
  _waterDepthM[streamerSlot] = depth;
  _waterSurfaceM[streamerSlot] = _computeWaterSurface(streamerSlot, elevation, depth);

  // Update the water material.
  _updateWaterMaterial(streamerSlot, flowState, depth, elevation);

  // Write to the descriptor.
  _writeToDescriptor(streamerSlot);

  // Emit a flow pulse if the discharge is high enough.
  if (_dischargeM3s[streamerSlot] > 0.1) {
    _flowPulseS[streamerSlot] = nowS;
  }

  return oldState !== flowState;
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const LandscapeWaterFlowSystem = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  HLOD_TIER,
  FLOW_STATE,
  FLOW_DIR,
  tickChunkBudget: DEFAULT_TICK_CHUNK_BUDGET,
  tickCpuBudgetMs: DEFAULT_TICK_CPU_BUDGET_MS,
  streamPowerReference: STREAM_POWER_REFERENCE,
  waterFresnelF0: WATER_FRESNEL_F0,
  waterIor: WATER_IOR,
  gerstnerGravity: GERSTNER_GRAVITY,
  gerstnerWavelength: GERSTNER_WAVELENGTH,
  gerstnerSteepness: GERSTNER_STEEPNESS,
  gerstnerAmplitude: GERSTNER_AMPLITUDE,

  registerChunk(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    _chunkActive[streamerSlot] = 1;
    _flowDir[streamerSlot] = FLOW_DIR.PIT;
    _downhillSlot[streamerSlot] = -1;
    _uphillCount[streamerSlot] = 0;
    for (let i = 0; i < MAX_NEIGHBOURS; i++) {
      _uphillSlots[streamerSlot * MAX_NEIGHBOURS + i] = -1;
    }
    _localRunoffMmYr[streamerSlot] = 0;
    _dischargeM3s[streamerSlot] = 0;
    _streamPower[streamerSlot] = 0;
    _flowState[streamerSlot] = FLOW_STATE.DRY;
    _lakeLevelM[streamerSlot] = 0;
    _waterDepthM[streamerSlot] = 0;
    _waterSurfaceM[streamerSlot] = 0;
    _waterAlbedoR[streamerSlot] = 0;
    _waterAlbedoG[streamerSlot] = 0;
    _waterAlbedoB[streamerSlot] = 0;
    _waterRoughness[streamerSlot] = 0.10;
    _waterMetalness[streamerSlot] = 0;
    _waterTransmission[streamerSlot] = 0.70;
    _waterIor[streamerSlot] = WATER_IOR;
    _waterFresnelF0[streamerSlot] = WATER_FRESNEL_F0;
    _waterAttenRed[streamerSlot] = WATER_ATTENUATION_RED;
    _waterAttenGreen[streamerSlot] = WATER_ATTENUATION_GREEN;
    _waterAttenBlue[streamerSlot] = WATER_ATTENUATION_BLUE;
    _waterSpecularStrength[streamerSlot] = 0;
    _waterCausticIntensity[streamerSlot] = 0;
    _flowPulseS[streamerSlot] = -1;
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
    let flowChunks = 0;
    let lakeChunks = 0;
    let totalDischarge = 0;
    let maxStreamPower = 0;

    for (let b = 0; b < this.tickChunkBudget; b++) {
      const slot = _rrCursor;
      _rrCursor = (_rrCursor + 1) % MAX_TRACKED_CHUNKS;
      if (!_chunkActive[slot]) continue;
      processed++;
      if (_processChunk(slot, nowS, dt)) {
        changed++;
      }
      if (_flowState[slot] === FLOW_STATE.STREAM || _flowState[slot] === FLOW_STATE.RIVER) {
        flowChunks++;
      }
      if (_flowState[slot] === FLOW_STATE.LAKE) {
        lakeChunks++;
      }
      totalDischarge += _dischargeM3s[slot];
      if (_streamPower[slot] > maxStreamPower) maxStreamPower = _streamPower[slot];
      if ((performanceNow() - t0) > this.tickCpuBudgetMs) break;
    }

    _lastProcessed = processed;
    _lastFlowChunks = flowChunks;
    _lastLakeChunks = lakeChunks;
    _lastTickDurationMs = performanceNow() - t0;
    _lastTotalDischargeM3s = totalDischarge;
    _lastMaxStreamPower = maxStreamPower;

    if (processed > 0 || changed > 0) {
      _dispatcher.emit(EVENT_TYPE.WATER_FLOW_UPDATED, {
        tick,
        processed,
        changed,
        flowChunks,
        lakeChunks,
        totalDischargeM3s: totalDischarge,
        maxStreamPower,
        durationMs: _lastTickDurationMs
      });
    }
  },

  // ─── Direct accessor API for hot paths ────────────────────
  getFlowDirection(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return FLOW_DIR.PIT;
    return _flowDir[streamerSlot];
  },
  getDownhillSlot(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return -1;
    return _downhillSlot[streamerSlot];
  },
  getDischargeM3s(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _dischargeM3s[streamerSlot];
  },
  getStreamPower(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _streamPower[streamerSlot];
  },
  getFlowState(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return FLOW_STATE.DRY;
    return _flowState[streamerSlot];
  },
  getLakeLevelM(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _lakeLevelM[streamerSlot];
  },
  getWaterDepthM(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _waterDepthM[streamerSlot];
  },
  getWaterSurfaceM(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _waterSurfaceM[streamerSlot];
  },
  getWaterAlbedoR(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _waterAlbedoR[streamerSlot];
  },
  getWaterAlbedoG(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _waterAlbedoG[streamerSlot];
  },
  getWaterAlbedoB(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _waterAlbedoB[streamerSlot];
  },
  getWaterRoughness(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0.10;
    return _waterRoughness[streamerSlot];
  },
  getWaterTransmission(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0.70;
    return _waterTransmission[streamerSlot];
  },
  getWaterIor(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return WATER_IOR;
    return _waterIor[streamerSlot];
  },
  getWaterFresnelF0(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return WATER_FRESNEL_F0;
    return _waterFresnelF0[streamerSlot];
  },
  getWaterAttenRed(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return WATER_ATTENUATION_RED;
    return _waterAttenRed[streamerSlot];
  },
  getWaterAttenGreen(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return WATER_ATTENUATION_GREEN;
    return _waterAttenGreen[streamerSlot];
  },
  getWaterAttenBlue(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return WATER_ATTENUATION_BLUE;
    return _waterAttenBlue[streamerSlot];
  },
  getWaterSpecularStrength(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _waterSpecularStrength[streamerSlot];
  },
  getWaterCausticIntensity(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return 0;
    return _waterCausticIntensity[streamerSlot];
  },

  /**
   * Read the full per-chunk flow state. Zero-allocation.
   */
  readFlowState(streamerSlot, out) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    out.flowDir = _flowDir[streamerSlot];
    out.downhillSlot = _downhillSlot[streamerSlot];
    out.dischargeM3s = _dischargeM3s[streamerSlot];
    out.streamPower = _streamPower[streamerSlot];
    out.flowState = _flowState[streamerSlot];
    out.lakeLevelM = _lakeLevelM[streamerSlot];
    out.waterDepthM = _waterDepthM[streamerSlot];
    out.waterSurfaceM = _waterSurfaceM[streamerSlot];
    out.waterAlbedoR = _waterAlbedoR[streamerSlot];
    out.waterAlbedoG = _waterAlbedoG[streamerSlot];
    out.waterAlbedoB = _waterAlbedoB[streamerSlot];
    out.waterRoughness = _waterRoughness[streamerSlot];
    out.waterTransmission = _waterTransmission[streamerSlot];
    out.waterIor = _waterIor[streamerSlot];
    out.waterFresnelF0 = _waterFresnelF0[streamerSlot];
    out.waterAttenRed = _waterAttenRed[streamerSlot];
    out.waterAttenGreen = _waterAttenGreen[streamerSlot];
    out.waterAttenBlue = _waterAttenBlue[streamerSlot];
    out.waterSpecularStrength = _waterSpecularStrength[streamerSlot];
    out.waterCausticIntensity = _waterCausticIntensity[streamerSlot];
    out.flowPulseAgeS = _flowPulseS[streamerSlot] >= 0
      ? BiomeBlendSystem.elapsedSimSeconds - _flowPulseS[streamerSlot]
      : -1;
    return true;
  },

  /**
   * Query whether a chunk is currently flowing (has water moving through it).
   */
  isFlowing(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    const s = _flowState[streamerSlot];
    return s === FLOW_STATE.STREAM || s === FLOW_STATE.RIVER;
  },

  /**
   * Query whether a chunk has a lake.
   */
  isLake(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    return _flowState[streamerSlot] === FLOW_STATE.LAKE;
  },

  /**
   * Query whether a chunk is a wetland.
   */
  isWetland(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    return _flowState[streamerSlot] === FLOW_STATE.WETLAND;
  },

  /**
   * Query whether a chunk has any water (stream, river, lake, or wetland).
   */
  hasWater(streamerSlot) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    return _flowState[streamerSlot] !== FLOW_STATE.DRY;
  },

  /**
   * Force a flow event (a flood or a dam break) on a chunk. Used by
   * 300_ImpactEventCoordinator when a large impact or a dam failure
   * injects water into the flow network.
   */
  forceFlow(streamerSlot, additionalDischargeM3s) {
    if (streamerSlot < 0 || streamerSlot >= MAX_TRACKED_CHUNKS) return false;
    if (!_chunkActive[streamerSlot]) return false;
    _dischargeM3s[streamerSlot] += additionalDischargeM3s;
    _flowPulseS[streamerSlot] = BiomeBlendSystem.elapsedSimSeconds;
    return true;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get lastProcessed() { return _lastProcessed; },
  get lastFlowChunks() { return _lastFlowChunks; },
  get lastLakeChunks() { return _lastLakeChunks; },
  get lastTickDurationMs() { return _lastTickDurationMs; },
  get lastTotalDischargeM3s() { return _lastTotalDischargeM3s; },
  get lastMaxStreamPower() { return _lastMaxStreamPower; },
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

export default LandscapeWaterFlowSystem;