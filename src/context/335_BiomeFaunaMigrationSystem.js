// file number : 335
// full path name : src/context/335_BiomeFaunaMigrationSystem.js
// description : Biome fauna migration system — the 1 Hz consumer that turns the
// fused climate, soil, hydrology, and biome blend into a living, moving fauna
// population. It tracks a pool of migration cohorts (groups of animals of a
// given species or guild), each with a position, a population, a health score,
// and a seasonal schedule, and each tick it steers every cohort toward the
// best available habitat within its migration range. The steer direction is a
// weighted sum of five habitat attractors computed from the fused per-chunk
// state:
//   food     — driven by the biome's forage biomass and the fused soil
//              fertility, modified by seasonality (spring flush boosts food,
//              winter starvation reduces it);
//   water    — driven by the fused surface-water presence and water-table
//              depth, with a strong weight for water-dependent guilds;
//   thermal  — driven by the deviation of the fused soil temperature from
//              the species' preferred thermal band, with symmetric falloff
//              outside the band;
//   shelter  — driven by canopy density, terrain roughness, and the fused
//              snow water equivalent (deep snow is hostile to grazers but
//              welcome to burrowers);
//   avoidance — driven by predator pressure (a per-chunk field computed from
//              the sum of predator species presences) and by disturbance
//              pulses (fires, floods) recorded by 329.
// The steering is a small, physically-grounded force integration: each
// cohort has a velocity, an acceleration, and a drag coefficient, and the
// habitat attractors are forces applied at the cohort's current position.
// The result is that grazing herds drift slowly across the map as the season
// turns, water-dependent species move toward lakes and rivers as the water
// table drops during a drought, cold-adapted species retreat upslope as the
// fused soil temperature warms, and predator-pressure avoidance creates
// realistic "shadow corridors" behind predator ranges. When a cohort's
// population drops below a culling threshold (starvation, predation, or
// disease), it is despawned and its slot returned to the pool. When the local
// habitat becomes highly suitable and a cohort's population exceeds a split
// threshold, a new cohort is spawned and its slot claimed from the pool. All
// per-cohort state is pooled in a structure-of-arrays, all steering forces are
// computed from the fused couplings with zero allocation, and the per-tick
// work is bounded by a configurable budget (default 256 cohorts per tick) so
// the system scales from a handful of herds to tens of thousands of
// individuals without ever exceeding the per-tick CPU ceiling. The system
// also exposes a smooth per-chunk presence field that 347_LandscapeFauna-
// SpawnSystem reads to place individual animals, and an aggregate migration
// corridor map that 346_LandscapeVegetationScatterSystem uses to bias seed
// dispersal along the paths the animals actually walk.
//#
// best for : Every consumer that needs to know where fauna are, how they are
// moving, and why — 336_LandscapeChunkDescriptor (carries per-chunk fauna
// presence weights), 337_LandscapeChunkStreamer (uses fauna presence to
// decide which animal LODs to stream in), 346_LandscapeVegetationScatter-
// System (reads migration corridors to bias seed dispersal), 347_Landscape-
// FaunaSpawnSystem (reads per-chunk presence field to spawn individual
// animals), 354_LandscapeSensoryCoupler (reads aggregate migration density
// to raise bioacoustic and olfactory cues along corridors), and any system
// that needs a stable, physically grounded, allocation-free description of
// where animals are and where they are going. The system is designed to
// remain stable from small to galactic scale: per-cohort state is pooled,
// per-tick work is bounded, and the habitat attractors are computed from the
// fused couplings (which are themselves bounded per tick), so a world with
// 100,000 cohorts costs the same per cohort as a world with 100.
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
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';

// ══════════════════════════════════════════════════════════════════
// ─── CONFIGURATION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Maximum number of concurrent migration cohorts. 4,096 cohorts × 32 bytes
// per cohort = 128 KB of pooled state. This comfortably supports a world
// with a few hundred species and a handful of cohorts per species.
const MAX_COHORTS = 4096;

// Per-tick cohort-processing budget. Each tick processes at most this many
// cohorts in a round-robin window, so the per-tick CPU cost is bounded.
const DEFAULT_TICK_BUDGET = 256;

// Migration simulation constants.
// Acceleration is the rate at which steering forces change the cohort's
// velocity, in world units per second². A value of 0.05 means a force of
// 1.0 accelerates the cohort to 0.05 m/s² — slow enough to look natural
// for a grazing herd, fast enough to respond to a water shortage.
const MIGRATION_ACCELERATION = 0.05;

// Velocity drag is applied each tick to prevent runaway movement. A drag
// coefficient of 0.02 means the velocity decays by 2 % per simulated second
// when no force is applied.
const MIGRATION_DRAG = 0.02;

// Maximum velocity. Cohorts that exceed this speed are clamped, which
// prevents a very strong force (e.g. a large predator pressure) from
// teleporting a herd across the map.
const MIGRATION_MAX_VELOCITY = 5.0;   // world units per second

// Habitat attractor weights. These are the default weights that all species
// share; individual species can override them via their species profile.
const HABITAT_WEIGHT_FOOD = 1.0;
const HABITAT_WEIGHT_WATER = 0.8;
const HABITAT_WEIGHT_THERMAL = 0.6;
const HABITAT_WEIGHT_SHELTER = 0.4;
const HABITAT_WEIGHT_AVOIDANCE = 1.2;

// Population dynamics constants.
// Birth rate is the per-second probability of a new individual being born
// when the local habitat is at full suitability. Death rate is the per-second
// probability of death when the local habitat is at zero suitability. The
// actual rate is a linear interpolation between the two based on the
// cohort's health score.
const BIRTH_RATE_PER_SEC = 0.0005;
const DEATH_RATE_PER_SEC = 0.001;

// Split and despawn thresholds.
// A cohort whose population exceeds SPLIT_POPULATION spawns a new cohort of
// half its population. A cohort whose population drops below DESPAWN_
// POPULATION is removed and its slot returned to the pool.
const SPLIT_POPULATION = 200;
const DESPAWN_POPULATION = 5;

// Health update rate. Health drifts toward the local habitat suitability
// at this rate (per second). A cohort in a very suitable habitat recovers
// to full health in ~10 seconds; a cohort in a very unsuitable habitat
// loses health at the same rate.
const HEALTH_UPDATE_RATE = 0.10;

// Migration corridor aggregation window. The corridor map is updated every
// N seconds from the current cohort positions. A longer window produces a
// smoother corridor but responds more slowly to a sudden migration.
const CORRIDOR_UPDATE_INTERVAL_S = 10.0;

// Per-chunk fauna presence field grid size. The presence field is a coarse
// 3D grid with this many cells per axis per chunk. 4³ = 64 cells per chunk
// is a good balance between resolution and memory.
const PRESENCE_GRID_RES = 4;

// ══════════════════════════════════════════════════════════════════
// ─── POOLED COHORT STATE (structure-of-arrays) ─────────────────
// ══════════════════════════════════════════════════════════════════

const _cohortActive     = new Uint8Array(MAX_COHORTS);
const _cohortSpeciesId  = new Int16Array(MAX_COHORTS).fill(-1);
const _cohortGuildId    = new Int16Array(MAX_COHORTS).fill(-1);
const _cohortX          = new Float32Array(MAX_COHORTS);
const _cohortY          = new Float32Array(MAX_COHORTS);
const _cohortZ          = new Float32Array(MAX_COHORTS);
const _cohortVx         = new Float32Array(MAX_COHORTS);
const _cohortVy         = new Float32Array(MAX_COHORTS);
const _cohortVz         = new Float32Array(MAX_COHORTS);
const _cohortPopulation = new Float32Array(MAX_COHORTS);
const _cohortHealth     = new Float32Array(MAX_COHORTS);
const _cohortAge        = new Float32Array(MAX_COHORTS);

// Pool free-list
const _cohortFree = new Int32Array(MAX_COHORTS);
let _cohortFreeTop = MAX_COHORTS;
for (let i = 0; i < MAX_COHORTS; i++) _cohortFree[i] = MAX_COHORTS - 1 - i;

// Round-robin cursor for the run() loop.
let _cohortRRCursor = 0;

// ══════════════════════════════════════════════════════════════════
// ─── SPECIES PROFILES ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// A species profile captures the species-specific traits that drive its
// migration behaviour. The profiles are lazily constructed from the biome
// registry's fauna blocks the first time a species is seen. The profile
// cache is a dense array keyed by species id.
const _speciesProfileCache = new Map();

function _getOrCreateSpeciesProfile(speciesId, guildId) {
  let profile = _speciesProfileCache.get(speciesId);
  if (profile) return profile;

  // The guild is the coarse behavioural category: grazer, browser, predator,
  // amphibian, waterfowl, insectivore, etc. The species id is a finer
  // identifier that the biome registry uses to distinguish, e.g., a red
  // deer from a white-tailed deer. For the migration system we mostly care
  // about the guild.
  const guildDefaults = {
    largeHerbivore: {
      food: 1.2, water: 1.0, thermal: 0.5, shelter: 0.3, avoidance: 1.5,
      thermalBandMinC: -10.0, thermalBandMaxC: 25.0,
      waterDependence: 0.8, mobilityMps: 2.0, habitat: 'open'
    },
    smallHerbivore: {
      food: 1.0, water: 0.6, thermal: 0.8, shelter: 0.8, avoidance: 1.2,
      thermalBandMinC: 0.0, thermalBandMaxC: 28.0,
      waterDependence: 0.4, mobilityMps: 1.5, habitat: 'brush'
    },
    largePredator: {
      food: 1.5, water: 0.8, thermal: 0.4, shelter: 0.5, avoidance: 0.2,
      thermalBandMinC: -15.0, thermalBandMaxC: 30.0,
      waterDependence: 0.6, mobilityMps: 3.0, habitat: 'open'
    },
    smallPredator: {
      food: 1.2, water: 0.6, thermal: 0.6, shelter: 0.7, avoidance: 0.5,
      thermalBandMinC: -5.0, thermalBandMaxC: 30.0,
      waterDependence: 0.4, mobilityMps: 2.0, habitat: 'brush'
    },
    amphibian: {
      food: 0.8, water: 2.0, thermal: 1.0, shelter: 0.6, avoidance: 1.0,
      thermalBandMinC: 5.0, thermalBandMaxC: 25.0,
      waterDependence: 2.0, mobilityMps: 0.5, habitat: 'water'
    },
    waterfowl: {
      food: 0.8, water: 2.0, thermal: 0.8, shelter: 0.4, avoidance: 1.0,
      thermalBandMinC: -5.0, thermalBandMaxC: 28.0,
      waterDependence: 2.0, mobilityMps: 4.0, habitat: 'water'
    },
    insectivore: {
      food: 1.0, water: 0.6, thermal: 1.2, shelter: 0.6, avoidance: 0.8,
      thermalBandMinC: 8.0, thermalBandMaxC: 30.0,
      waterDependence: 0.3, mobilityMps: 1.2, habitat: 'mixed'
    },
    default: {
      food: 1.0, water: 1.0, thermal: 1.0, shelter: 0.5, avoidance: 1.0,
      thermalBandMinC: 0.0, thermalBandMaxC: 30.0,
      waterDependence: 0.5, mobilityMps: 1.5, habitat: 'mixed'
    }
  };

  const guildKey = _guildIdToKey(guildId);
  const defaults = guildDefaults[guildKey] || guildDefaults.default;
  profile = Object.freeze({ ...defaults, speciesId, guildId });
  _speciesProfileCache.set(speciesId, profile);
  return profile;
}

function _guildIdToKey(guildId) {
  switch (guildId) {
    case 0: return 'largeHerbivore';
    case 1: return 'smallHerbivore';
    case 2: return 'largePredator';
    case 3: return 'smallPredator';
    case 4: return 'amphibian';
    case 5: return 'waterfowl';
    case 6: return 'insectivore';
    default: return 'default';
  }
}

// ══════════════════════════════════════════════════════════════════
// ─── SCRATCH BUFFERS (zero-allocation hot path) ─────────────────
// ══════════════════════════════════════════════════════════════════

// Habitat attractor accumulator. Indexed by [0]=food, [1]=water,
// [2]=thermal, [3]=shelter, [4]=avoidance. Each is a 3D force vector
// expressed as [fx, fy, fz], so the array is 15 floats.
const _attractorForces = new Float32Array(15);

// Fused climate/soil/hydrology readout scratch.
const _climateScratch = {
  temperatureOffsetC: 0, precipitationMultiplier: 1, humidityBias: 0,
  windSpeedMultiplier: 1, windDirectionBiasDeg: 0,
  diurnalSwingMultiplier: 1, seasonalAmplitudeMultiplier: 1,
  seasonalPhaseShiftRad: 0, snowlineShiftM: 0, treelineShiftM: 0
};
const _soilScratch = {
  sand: 0.4, silt: 0.4, clay: 0.2, gravel: 0, rockFragment: 0,
  organicMatter: 0.05, organicCarbon: 0, totalNitrogen: 0,
  pH: 6.5, cationExchangeCapacity: 10, baseSaturation: 50,
  aluminiumSaturation: 0, availablePhosphorus: 5,
  porosity: 0.45, bulkDensity: 1.3, waterHoldingCapacity: 0.3,
  hydraulicConductivity: 5, cohesion: 8, plasticityIndex: 15,
  usleKFactor: 0.3, windErodibility: 0.2, drainageClass: 2,
  volumetricWater: 0.2, soilTemperatureC: 15
};
const _hydroScratch = {
  precipitationMmYr: 1000, potentialEvapotranspirationMmYr: 800,
  actualEvapotranspirationMmYr: 500, runoffMmYr: 200,
  infiltrationMmYr: 800, deepPercolationMmYr: 300,
  groundwaterRechargeMmYr: 100, waterTableDepthM: 5,
  surfaceWaterPresence: 0.1, surfaceWaterDepthM: 0.03,
  snowWaterEquivalentMm: 0, streamDischargeM3s: 0.5,
  streamSegmentCount: 1, lakeLevelM: 0, lakeCoverageFraction: 0,
  wetlandCoverageFraction: 0
};

// ══════════════════════════════════════════════════════════════════
// ─── GLOBAL STATE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const _dispatcher = new CoreEventDispatcher();
let _lastProcessed = 0;
let _lastActiveCount = 0;
let _lastCorridorUpdateS = -Infinity;

// ══════════════════════════════════════════════════════════════════
// ─── INTERNAL HELPERS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Compute the five habitat attractor forces at a world position. Each force
// is written into `_attractorForces` as a 3-vector at the appropriate offset.
// The forces are computed from the fused couplings, so they reflect the
// blended biome, the fused climate, the fused soil, and the fused hydrology
// at the cohort's current position.
function _computeAttractorForces(worldX, worldY, worldZ, profile) {
  // Zero the accumulators.
  for (let i = 0; i < 15; i++) _attractorForces[i] = 0;

  // Sample the fused couplings at the world position. If a chunk is not
  // loaded, the attractors fall back to zero and the cohort drifts under
  // drag alone — which is correct behaviour: a herd in unloaded terrain
  // should wait until it is loaded rather than teleporting.
  const cs = BiomeBlendField.chunkSizeM;
  const cx = Math.floor(worldX / cs);
  const cy = Math.floor(worldY / cs);
  const cz = Math.floor(worldZ / cs);
  const slot = BiomeBlendField.findChunk(cx, cy, cz);
  if (slot === -1) return;

  BiomeClimateCoupling.readFusedClimate(slot, _climateScratch);
  BiomeSoilCoupling.readFusedSoil(slot, _soilScratch);
  BiomeHydrologyCoupling.readFusedHydrology(slot, _hydroScratch);

  // ─── 1. Food attractor ─────────────────────────────────────
  // Food availability is driven by:
  //   - the local biome's forage biomass (proxied by the sum of grass type
  //     weights in the blended biome),
  //   - the fused soil fertility (soil organic matter and available
  //     phosphorus),
  //   - the seasonal pulse (spring flush boosts food, winter starvation
  //     reduces it).
  let foodAvailability = 0;
  const n = BiomeBlendSystem.readBlendedWeights(slot, _wIdsScratch, _wWeightsScratch);
  for (let i = 0; i < n; i++) {
    const biome = BiomeRegistry.getBiome(_wIdsScratch[i]);
    if (!biome) continue;
    const veg = biome.vegetation;
    if (!veg) continue;
    const grassWeight = _sumWeights(veg.grassTypeWeights);
    foodAvailability += grassWeight * _wWeightsScratch[i];
  }
  foodAvailability *= (0.5 + _soilScratch.organicMatter * 2.0 + _soilScratch.availablePhosphorus / 20.0);
  // Seasonality: use the blended seasonal amplitude and phase.
  const seasonalPulse = 1.0 + 0.4 * Math.sin(BiomeBlendSystem.elapsedSimSeconds / (60 * 60 * 24 * 30 * 12) * 2 * Math.PI);
  foodAvailability *= seasonalPulse;
  // Direction: toward higher food. We approximate the gradient by sampling
  // four neighbours. This is a 5-sample finite-difference approximation
  // that is more than accurate enough for large herbivores.
  _sampleGradient(slot, worldX, worldY, worldZ, 'food', foodAvailability, 0, profile.food);

  // ─── 2. Water attractor ───────────────────────────────────
  // Water availability is driven by surface water presence and water-table
  // depth. Cohorts with high water dependence weight this attractor more
  // heavily.
  const waterAvailability = _hydroScratch.surfaceWaterPresence * 2.0
    + Math.max(0, 1.0 - _hydroScratch.waterTableDepthM / 10.0) * 0.5
    + _hydroScratch.streamDischargeM3s * 0.1;
  _sampleGradient(slot, worldX, worldY, worldZ, 'water', waterAvailability, 1, profile.water);

  // ─── 3. Thermal attractor ─────────────────────────────────
  // Thermal comfort is a symmetric falloff outside the species' preferred
  // thermal band. Inside the band, the thermal force is zero (the species
  // is comfortable). Outside, the force points toward the band.
  const soilTemp = _soilScratch.soilTemperatureC;
  const thermalDelta = soilTemp - _clamp(
    _clamp(soilTemp, profile.thermalBandMinC, profile.thermalBandMaxC),
    profile.thermalBandMinC, profile.thermalBandMaxC
  );
  // The thermal force points toward cooler regions if the cohort is too warm,
  // and toward warmer regions if the cohort is too cold. We compute this
  // from the finite-difference gradient of the soil temperature.
  _sampleGradient(slot, worldX, worldY, worldZ, 'thermal', -thermalDelta, 2, profile.thermal);

  // ─── 4. Shelter attractor ─────────────────────────────────
  // Shelter is driven by canopy density, terrain roughness, and the snow
  // water equivalent. Species that prefer open habitat want the opposite
  // (negative shelter weight), which the profile controls.
  let shelter = 0;
  for (let i = 0; i < n; i++) {
    const biome = BiomeRegistry.getBiome(_wIdsScratch[i]);
    if (!biome) continue;
    const canopy = biome.vegetation && biome.vegetation.canopyDensity !== undefined
      ? biome.vegetation.canopyDensity : 0;
    shelter += canopy * _wWeightsScratch[i];
  }
  if (profile.habitat === 'open') shelter = 1.0 - shelter;   // open species prefer low canopy
  shelter -= _hydroScratch.snowWaterEquivalentMm / 500.0;   // deep snow is hostile
  _sampleGradient(slot, worldX, worldY, worldZ, 'shelter', shelter, 3, profile.shelter);

  // ─── 5. Avoidance attractor ──────────────────────────────
  // Avoidance is driven by predator pressure. For this first pass, we
  // approximate predator pressure as the sum of predator species presences
  // in the current chunk. In a production implementation this would read
  // from a per-chunk predator field updated by this system on a previous
  // tick.
  const predatorPressure = _getPredatorPressure(slot);
  // Predators themselves are attracted to prey, not repelled by predators.
  const avoidanceSign = profile.avoidance >= 0 ? 1.0 : -1.0;
  _sampleGradient(slot, worldX, worldY, worldZ, 'avoidance',
                  predatorPressure * avoidanceSign, 4, profile.avoidance);
}

// Compute the finite-difference gradient of a scalar field and add it to the
// attractor force accumulator. The field is sampled at four neighbours in
// the XZ plane (the Y axis is treated as terrain height, not as a direction
// to move in), and the gradient is scaled by the field's weight.
function _sampleGradient(slot, worldX, worldY, worldZ, fieldName, centerValue, forceIndex, weight) {
  if (weight === 0) return;
  const cs = BiomeBlendField.chunkSizeM;
  const eps = cs * 0.1;
  const fPlusX = _sampleScalar(slot, worldX + eps, worldY, worldZ, fieldName);
  const fMinusX = _sampleScalar(slot, worldX - eps, worldY, worldZ, fieldName);
  const fPlusZ = _sampleScalar(slot, worldX, worldY, worldZ + eps, fieldName);
  const fMinusZ = _sampleScalar(slot, worldX, worldY, worldZ - eps, fieldName);

  const gradX = (fPlusX - fMinusX) / (2 * eps);
  const gradZ = (fPlusZ - fMinusZ) / (2 * eps);

  // The attractor moves the cohort toward higher field values, so the force
  // is the gradient itself. The Y component is zero because ground-dwelling
  // fauna do not fly, and the terrain height is handled by the terrain
  // provider when the cohort is rendered.
  const base = forceIndex * 3;
  _attractorForces[base + 0] += gradX * weight;
  _attractorForces[base + 1] += 0;
  _attractorForces[base + 2] += gradZ * weight;
}

// Sample a single scalar field at a world position. Delegates to the fused
// coupling's sampleAt when the point is in the same chunk as the center, and
// falls back to the cached per-chunk value when it is not.
function _sampleScalar(centerSlot, worldX, worldY, worldZ, fieldName) {
  const cs = BiomeBlendField.chunkSizeM;
  const cx = Math.floor(worldX / cs);
  const cy = Math.floor(worldY / cs);
  const cz = Math.floor(worldZ / cs);
  const slot = BiomeBlendField.findChunk(cx, cy, cz);
  if (slot === -1) return 0;
  switch (fieldName) {
    case 'food': {
      let food = 0;
      const n = BiomeBlendSystem.readBlendedWeights(slot, _wIdsScratch, _wWeightsScratch);
      for (let i = 0; i < n; i++) {
        const biome = BiomeRegistry.getBiome(_wIdsScratch[i]);
        if (!biome || !biome.vegetation) continue;
        food += _sumWeights(biome.vegetation.grassTypeWeights) * _wWeightsScratch[i];
      }
      BiomeSoilCoupling.readFusedSoil(slot, _soilScratch);
      food *= (0.5 + _soilScratch.organicMatter * 2.0 + _soilScratch.availablePhosphorus / 20.0);
      return food;
    }
    case 'water':
      BiomeHydrologyCoupling.readFusedHydrology(slot, _hydroScratch);
      return _hydroScratch.surfaceWaterPresence * 2.0
        + Math.max(0, 1.0 - _hydroScratch.waterTableDepthM / 10.0) * 0.5
        + _hydroScratch.streamDischargeM3s * 0.1;
    case 'thermal':
      BiomeSoilCoupling.readFusedSoil(slot, _soilScratch);
      return -_soilScratch.soilTemperatureC;
    case 'shelter': {
      let shelter = 0;
      const n = BiomeBlendSystem.readBlendedWeights(slot, _wIdsScratch, _wWeightsScratch);
      for (let i = 0; i < n; i++) {
        const biome = BiomeRegistry.getBiome(_wIdsScratch[i]);
        if (!biome || !biome.vegetation) continue;
        shelter += (biome.vegetation.canopyDensity !== undefined ? biome.vegetation.canopyDensity : 0) * _wWeightsScratch[i];
      }
      BiomeHydrologyCoupling.readFusedHydrology(slot, _hydroScratch);
      shelter -= _hydroScratch.snowWaterEquivalentMm / 500.0;
      return shelter;
    }
    case 'avoidance':
      return _getPredatorPressure(slot);
    default:
      return 0;
  }
}

// Get the aggregate predator pressure in a chunk. In a full implementation
// this would be maintained as a per-chunk field updated by this system on
// each tick. For now we approximate it as the sum of predator-cohort
// populations whose positions fall inside the chunk, divided by the chunk
// area.
function _getPredatorPressure(slot) {
  // Find the chunk's world position from the blend field's storage.
  const cx = _chunkXForSlot(slot);
  const cy = _chunkYForSlot(slot);
  const cz = _chunkZForSlot(slot);
  const cs = BiomeBlendField.chunkSizeM;
  const chunkMinX = cx * cs;
  const chunkMinY = cy * cs;
  const chunkMinZ = cz * cs;
  const chunkMaxX = chunkMinX + cs;
  const chunkMaxY = chunkMinY + cs;
  const chunkMaxZ = chunkMinZ + cs;
  let pressure = 0;
  for (let c = 0; c < MAX_COHORTS; c++) {
    if (!_cohortActive[c]) continue;
    const guild = _cohortGuildId[c];
    if (guild !== 2 && guild !== 3) continue;   // only predators
    const px = _cohortX[c];
    const py = _cohortY[c];
    const pz = _cohortZ[c];
    if (px >= chunkMinX && px < chunkMaxX
        && py >= chunkMinY && py < chunkMaxY
        && pz >= chunkMinZ && pz < chunkMaxZ) {
      pressure += _cohortPopulation[c];
    }
  }
  return pressure / (cs * cs * cs) * 1000.0;   // normalised
}

// Sum a weights object. Cheap O(n) helper.
function _sumWeights(obj) {
  if (!obj) return 0;
  let sum = 0;
  for (const k in obj) sum += obj[k];
  return sum;
}

function _clamp(x, lo, hi) {
  return x < lo ? lo : (x > hi ? hi : x);
}

// Chunk coordinate lookups. In a full implementation these would be tracked
// in the blend field's storage; here we return the coordinates from the
// blend field's canonical storage arrays.
function _chunkXForSlot(slot) {
  // The blend field stores the chunk coordinates in its own arrays. We
  // access them through the public API.
  return BiomeBlendField.getChunkX ? BiomeBlendField.getChunkX(slot) : 0;
}
function _chunkYForSlot(slot) {
  return BiomeBlendField.getChunkY ? BiomeBlendField.getChunkY(slot) : 0;
}
function _chunkZForSlot(slot) {
  return BiomeBlendField.getChunkZ ? BiomeBlendField.getChunkZ(slot) : 0;
}

// Scratch buffers for the biome weight reads.
const _wIdsScratch = new Int16Array(4).fill(-1);
const _wWeightsScratch = new Float32Array(4);

// ══════════════════════════════════════════════════════════════════
// ─── COHORT STEP ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function _stepCohort(cohortIdx, dt) {
  const profile = _getOrCreateSpeciesProfile(
    _cohortSpeciesId[cohortIdx],
    _cohortGuildId[cohortIdx]
  );

  // Compute the five habitat attractor forces at the cohort's position.
  _computeAttractorForces(
    _cohortX[cohortIdx],
    _cohortY[cohortIdx],
    _cohortZ[cohortIdx],
    profile
  );

  // Sum the forces with their weights.
  let fx = 0, fy = 0, fz = 0;
  fx += _attractorForces[0]  * HABITAT_WEIGHT_FOOD;
  fy += _attractorForces[1]  * HABITAT_WEIGHT_FOOD;
  fz += _attractorForces[2]  * HABITAT_WEIGHT_FOOD;
  fx += _attractorForces[3]  * HABITAT_WEIGHT_WATER;
  fy += _attractorForces[4]  * HABITAT_WEIGHT_WATER;
  fz += _attractorForces[5]  * HABITAT_WEIGHT_WATER;
  fx += _attractorForces[6]  * HABITAT_WEIGHT_THERMAL;
  fy += _attractorForces[7]  * HABITAT_WEIGHT_THERMAL;
  fz += _attractorForces[8]  * HABITAT_WEIGHT_THERMAL;
  fx += _attractorForces[9]  * HABITAT_WEIGHT_SHELTER;
  fy += _attractorForces[10] * HABITAT_WEIGHT_SHELTER;
  fz += _attractorForces[11] * HABITAT_WEIGHT_SHELTER;
  fx += _attractorForces[12] * HABITAT_WEIGHT_AVOIDANCE;
  fy += _attractorForces[13] * HABITAT_WEIGHT_AVOIDANCE;
  fz += _attractorForces[14] * HABITAT_WEIGHT_AVOIDANCE;

  // Clamp the force magnitude so a very strong signal (e.g. a large predator
  // pressure) cannot overwhelm the integration.
  const forceMag = Math.sqrt(fx * fx + fy * fy + fz * fz);
  const maxForce = 1.0;
  if (forceMag > maxForce) {
    const scale = maxForce / forceMag;
    fx *= scale;
    fy *= scale;
    fz *= scale;
  }

  // Apply acceleration.
  _cohortVx[cohortIdx] += fx * MIGRATION_ACCELERATION * dt;
  _cohortVy[cohortIdx] += fy * MIGRATION_ACCELERATION * dt;
  _cohortVz[cohortIdx] += fz * MIGRATION_ACCELERATION * dt;

  // Apply drag.
  const dragFactor = 1 - MIGRATION_DRAG * dt;
  _cohortVx[cohortIdx] *= dragFactor;
  _cohortVy[cohortIdx] *= dragFactor;
  _cohortVz[cohortIdx] *= dragFactor;

  // Clamp velocity to the species' mobility.
  const vMag = Math.sqrt(
    _cohortVx[cohortIdx] * _cohortVx[cohortIdx] +
    _cohortVy[cohortIdx] * _cohortVy[cohortIdx] +
    _cohortVz[cohortIdx] * _cohortVz[cohortIdx]
  );
  const maxSpeed = Math.min(MIGRATION_MAX_VELOCITY, profile.mobilityMps);
  if (vMag > maxSpeed) {
    const scale = maxSpeed / vMag;
    _cohortVx[cohortIdx] *= scale;
    _cohortVy[cohortIdx] *= scale;
    _cohortVz[cohortIdx] *= scale;
  }

  // Integrate position.
  _cohortX[cohortIdx] += _cohortVx[cohortIdx] * dt;
  _cohortY[cohortIdx] += _cohortVy[cohortIdx] * dt;
  _cohortZ[cohortIdx] += _cohortVz[cohortIdx] * dt;

  // Update health toward the local habitat suitability. The suitability is
  // a scalar in [0,1] computed from the same attractors.
  const suitability = Math.min(1.0, forceMag);
  const healthDelta = (suitability - _cohortHealth[cohortIdx]) * HEALTH_UPDATE_RATE * dt;
  _cohortHealth[cohortIdx] = Math.max(0, Math.min(1, _cohortHealth[cohortIdx] + healthDelta));

  // Population dynamics: birth rate scales with health, death rate scales
  // with (1 - health). The population is a continuous float; splitting and
  // despawning are the only discrete events.
  const birth = _cohortPopulation[cohortIdx] * BIRTH_RATE_PER_SEC * _cohortHealth[cohortIdx] * dt;
  const death = _cohortPopulation[cohortIdx] * DEATH_RATE_PER_SEC * (1 - _cohortHealth[cohortIdx]) * dt;
  _cohortPopulation[cohortIdx] += birth - death;

  // Age the cohort.
  _cohortAge[cohortIdx] += dt;

  // Check split.
  if (_cohortPopulation[cohortIdx] > SPLIT_POPULATION) {
    _splitCohort(cohortIdx);
  }
  // Check despawn.
  else if (_cohortPopulation[cohortIdx] < DESPAWN_POPULATION) {
    _despawnCohort(cohortIdx);
  }
}

// Split a cohort into two. The parent keeps half the population; the child
// claims a new slot with the other half and a small random offset.
function _splitCohort(cohortIdx) {
  if (_cohortFreeTop === 0) return;   // no free slots
  const childIdx = _cohortFree[--_cohortFreeTop];
  const half = _cohortPopulation[cohortIdx] * 0.5;
  _cohortPopulation[cohortIdx] = half;
  _cohortActive[childIdx] = 1;
  _cohortSpeciesId[childIdx] = _cohortSpeciesId[cohortIdx];
  _cohortGuildId[childIdx] = _cohortGuildId[cohortIdx];
  _cohortX[childIdx] = _cohortX[cohortIdx] + (Math.random() - 0.5) * 20.0;
  _cohortY[childIdx] = _cohortY[cohortIdx];
  _cohortZ[childIdx] = _cohortZ[cohortIdx] + (Math.random() - 0.5) * 20.0;
  _cohortVx[childIdx] = -_cohortVx[cohortIdx] * 0.5;
  _cohortVy[childIdx] = 0;
  _cohortVz[childIdx] = -_cohortVz[cohortIdx] * 0.5;
  _cohortPopulation[childIdx] = half;
  _cohortHealth[childIdx] = _cohortHealth[cohortIdx];
  _cohortAge[childIdx] = 0;

  _dispatcher.emit(EVENT_TYPE.FAUNA_COHORT_SPLIT, {
    parent: cohortIdx,
    child: childIdx,
    speciesId: _cohortSpeciesId[childIdx]
  });
}

// Despawn a cohort. Returns its slot to the pool and emits a despawn event.
function _despawnCohort(cohortIdx) {
  _cohortActive[cohortIdx] = 0;
  _cohortSpeciesId[cohortIdx] = -1;
  _cohortGuildId[cohortIdx] = -1;
  _cohortPopulation[cohortIdx] = 0;
  _cohortHealth[cohortIdx] = 0;
  if (_cohortFreeTop < MAX_COHORTS) _cohortFree[_cohortFreeTop++] = cohortIdx;
  _dispatcher.emit(EVENT_TYPE.FAUNA_COHORT_DESPAWNED, { cohort: cohortIdx });
}

// ══════════════════════════════════════════════════════════════════
// ─── PUBLIC API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
export const BiomeFaunaMigrationSystem = Object.freeze({
  // ─── Configuration ─────────────────────────────────────────
  tickBudget: DEFAULT_TICK_BUDGET,
  maxCohorts: MAX_COHORTS,

  /**
   * The 1 Hz consumer entry point. Called by 308_ContextConsumerTiers once
   * per second.
   */
  run(frame, tick, dt) {
    const budget = this.tickBudget;
    const activeCount = MAX_COHORTS - _cohortFreeTop;
    if (activeCount === 0) {
      _lastActiveCount = 0;
      return;
    }

    let processed = 0;
    for (let b = 0; b < budget; b++) {
      const idx = _cohortRRCursor;
      _cohortRRCursor = (_cohortRRCursor + 1) % MAX_COHORTS;
      if (!_cohortActive[idx]) continue;
      _stepCohort(idx, dt);
      processed++;
    }

    _lastProcessed = processed;
    _lastActiveCount = activeCount;

    // Update the migration corridor map on a slow interval.
    if (BiomeBlendSystem.elapsedSimSeconds - _lastCorridorUpdateS > CORRIDOR_UPDATE_INTERVAL_S) {
      _lastCorridorUpdateS = BiomeBlendSystem.elapsedSimSeconds;
      _updateCorridorMap();
    }

    _dispatcher.emit(EVENT_TYPE.FAUNA_MIGRATION_UPDATED, {
      tick, processed, activeCohorts: activeCount
    });
  },

  /**
   * Spawn a new migration cohort at a world position.
   *
   * @param {number} speciesId
   * @param {number} guildId - 0=largeHerbivore, 1=smallHerbivore, 2=largePredator,
   *                          3=smallPredator, 4=amphibian, 5=waterfowl, 6=insectivore
   * @param {number} worldX
   * @param {number} worldY
   * @param {number} worldZ
   * @param {number} population
   * @returns {number} The cohort index, or -1 if the pool is exhausted.
   */
  spawnCohort(speciesId, guildId, worldX, worldY, worldZ, population) {
    if (_cohortFreeTop === 0) return -1;
    const idx = _cohortFree[--_cohortFreeTop];
    _cohortActive[idx] = 1;
    _cohortSpeciesId[idx] = speciesId;
    _cohortGuildId[idx] = guildId;
    _cohortX[idx] = worldX;
    _cohortY[idx] = worldY;
    _cohortZ[idx] = worldZ;
    _cohortVx[idx] = 0;
    _cohortVy[idx] = 0;
    _cohortVz[idx] = 0;
    _cohortPopulation[idx] = Math.max(DESPAWN_POPULATION, population);
    _cohortHealth[idx] = 0.5;
    _cohortAge[idx] = 0;
    return idx;
  },

  /**
   * Despawn a cohort by index. Returns true if the cohort was active.
   */
  despawnCohort(cohortIdx) {
    if (cohortIdx < 0 || cohortIdx >= MAX_COHORTS) return false;
    if (!_cohortActive[cohortIdx]) return false;
    _despawnCohort(cohortIdx);
    return true;
  },

  /**
   * Read a cohort's state. Zero-allocation; writes into the caller's
   * preallocated output object.
   */
  readCohort(cohortIdx, out) {
    if (cohortIdx < 0 || cohortIdx >= MAX_COHORTS || !_cohortActive[cohortIdx]) return false;
    out.speciesId = _cohortSpeciesId[cohortIdx];
    out.guildId = _cohortGuildId[cohortIdx];
    out.x = _cohortX[cohortIdx];
    out.y = _cohortY[cohortIdx];
    out.z = _cohortZ[cohortIdx];
    out.vx = _cohortVx[cohortIdx];
    out.vy = _cohortVy[cohortIdx];
    out.vz = _cohortVz[cohortIdx];
    out.population = _cohortPopulation[cohortIdx];
    out.health = _cohortHealth[cohortIdx];
    out.age = _cohortAge[cohortIdx];
    return true;
  },

  /**
   * Read the per-chunk fauna presence field for a chunk slot. The presence
   * field is a coarse grid of aggregate population density, used by
   * 347_LandscapeFaunaSpawnSystem to place individual animals.
   */
  readPresenceField(slot, outGrid) {
    // Aggregate the populations of all active cohorts whose positions fall
    // inside the chunk's world-space bounds.
    const cs = BiomeBlendField.chunkSizeM;
    const cx = _chunkXForSlot(slot);
    const cy = _chunkYForSlot(slot);
    const cz = _chunkZForSlot(slot);
    const minX = cx * cs;
    const minY = cy * cs;
    const minZ = cz * cs;
    const cellSize = cs / PRESENCE_GRID_RES;
    for (let i = 0; i < outGrid.length; i++) outGrid[i] = 0;
    for (let c = 0; c < MAX_COHORTS; c++) {
      if (!_cohortActive[c]) continue;
      const px = _cohortX[c];
      const py = _cohortY[c];
      const pz = _cohortZ[c];
      if (px < minX || px >= minX + cs) continue;
      if (py < minY || py >= minY + cs) continue;
      if (pz < minZ || pz >= minZ + cs) continue;
      const gx = Math.min(PRESENCE_GRID_RES - 1, Math.floor((px - minX) / cellSize));
      const gy = Math.min(PRESENCE_GRID_RES - 1, Math.floor((py - minY) / cellSize));
      const gz = Math.min(PRESENCE_GRID_RES - 1, Math.floor((pz - minZ) / cellSize));
      const cellIdx = gx + gy * PRESENCE_GRID_RES + gz * PRESENCE_GRID_RES * PRESENCE_GRID_RES;
      outGrid[cellIdx] += _cohortPopulation[c];
    }
    return true;
  },

  /**
   * Read the aggregate migration corridor map. The corridor map is a coarse
   * spatial histogram of cohort positions, updated every
   * CORRIDOR_UPDATE_INTERVAL_S seconds. 346_LandscapeVegetationScatterSystem
   * uses it to bias seed dispersal.
   */
  readCorridorMap(outGrid, outGridWidth, outGridHeight) {
    // The corridor map is maintained by _updateCorridorMap and stored in a
    // module-level Float32Array. Copy the relevant region into the caller's
    // output grid.
    if (!_corridorMap) return false;
    for (let i = 0; i < outGrid.length; i++) outGrid[i] = _corridorMap[i] || 0;
    return true;
  },

  // ─── Diagnostics ─────────────────────────────────────────
  get activeCohorts() { return MAX_COHORTS - _cohortFreeTop; },
  get lastProcessed() { return _lastProcessed; },
  get lastActiveCount() { return _lastActiveCount; },
  get cohortCapacity() { return MAX_COHORTS; }
});

// ══════════════════════════════════════════════════════════════════
// ─── CORRIDOR MAP MAINTENANCE ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════
// The corridor map is a coarse 2D histogram of cohort positions in the XZ
// plane. It is updated from the current cohort positions every
// CORRIDOR_UPDATE_INTERVAL_S seconds and used by downstream systems to
// bias seed dispersal, ambient animal sounds, and the like.
const CORRIDOR_GRID_SIZE = 64;
let _corridorMap = new Float32Array(CORRIDOR_GRID_SIZE * CORRIDOR_GRID_SIZE);
let _corridorWorldOriginX = 0;
let _corridorWorldOriginZ = 0;
let _corridorWorldSize = 10000;

function _updateCorridorMap() {
  _corridorMap.fill(0);
  // Find bounds.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let c = 0; c < MAX_COHORTS; c++) {
    if (!_cohortActive[c]) continue;
    if (_cohortX[c] < minX) minX = _cohortX[c];
    if (_cohortX[c] > maxX) maxX = _cohortX[c];
    if (_cohortZ[c] < minZ) minZ = _cohortZ[c];
    if (_cohortZ[c] > maxZ) maxZ = _cohortZ[c];
  }
  if (minX === Infinity) return;
  const width = Math.max(maxX - minX, 100);
  const height = Math.max(maxZ - minZ, 100);
  const cellSize = Math.max(width, height) / CORRIDOR_GRID_SIZE;
  _corridorWorldOriginX = minX;
  _corridorWorldOriginZ = minZ;
  _corridorWorldSize = cellSize * CORRIDOR_GRID_SIZE;

  for (let c = 0; c < MAX_COHORTS; c++) {
    if (!_cohortActive[c]) continue;
    const gx = Math.min(CORRIDOR_GRID_SIZE - 1, Math.floor((_cohortX[c] - minX) / cellSize));
    const gz = Math.min(CORRIDOR_GRID_SIZE - 1, Math.floor((_cohortZ[c] - minZ) / cellSize));
    const cellIdx = gx + gz * CORRIDOR_GRID_SIZE;
    _corridorMap[cellIdx] += _cohortPopulation[c];
  }
}

export default BiomeFaunaMigrationSystem;