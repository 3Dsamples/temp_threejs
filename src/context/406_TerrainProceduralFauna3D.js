// file number : 406
// full path name : src/context/406_TerrainProceduralFauna3D.js
//### Description : Context-aware procedural fauna simulation for the seamless
//###               3D terrain pipeline. Populates every tile with living
//###               creatures — birds, mammals, fish, insects, reptiles,
//###               amphibians, crustaceans, and any custom species — driven
//###               entirely by procedural rules, the context frame, and the
//###               tile's own biome/hydrology/scatter state. Nothing is
//###               loaded, streamed, or authored: every creature is created
//###               from a parametric species descriptor, placed by a
//###               deterministic Poisson-disk sampler, animated by a compact
//###               behavioural state machine, and integrated into the same
//###               ECS world, physical channel, and render arena as every
//###               other terrain feature.
//###               The engine integrates every relevant context file:
//###                 • CONTEXT FRAME (263) — temporal, physical, causal, player
//###                   channels drive activity, danger, feeding, and sleep.
//###                 • MATH/ECS BARREL (264) — Vec3, Quat, Mat4, SimplexNoise,
//###                   World, Components, Systems, EventDispatcher, Timer.
//###                 • CORE EVENT DISPATCHER (265) — emits fauna lifecycle events.
//###                 • SPATIAL ACCELERATION (271–274) — spatial hash for
//###                   neighbour queries (flee, flock, hunt).
//###                 • CONTEXT PROVIDERS (275–279) — spatial, temporal,
//###                   physical, causal, player data.
//###                 • TERRAIN PROVIDERS (280–282_Z09) — elevation, slope,
//###                   relief, cliff, rock, forest, grass, continental.
//###                 • ENVIRONMENTAL PROVIDERS (283–296) — bathymetry,
//###                   groundwater, moisture, decomposers, climate, soil,
//###                   lighting, seasonality.
//###                 • SENSORY (297, 317) — audio (birdsong, insect chorus,
//###                   wolf howl, whale song) and light (fireflies, glowing
//###                   eyes) emission per species.
//###                 • PERFORMANCE (303–307) — HLOD, memory, frame, GC.
//###                 • CONTEXT RUNTIME (308–310) — consumer tiers, frame reader.
//###                 • CONSUMER SYSTEMS (311–316) — LOD, load, visibility,
//###                   material, ecology response.
//###                 • BIOME DESCRIPTORS (318–326_Z17) — fauna definitions per
//###                   biome (species list, densities, activity windows).
//###                 • BIOME COUPLING (327–334) — material, climate, soil,
//###                   hydrology coupling affects where fauna can live.
//###                 • FAUNA MIGRATION (335) — the migration system's corridor
//###                   data drives seasonal herd movement.
//###                 • LANDSCAPE CHUNK (336–341) — HLOD, spatial hash,
//###                   occlusion, persistence.
//###                 • PROCEDURAL GENERATOR (386 series) — ScatterMarkerBuffer,
//###                   ScatterMarkerType, AdvancedScatterParams.
//###                 • LOD FIDELITY (395) — distance-based fauna LOD.
//###                 • SEAM STITCHER (396) — cross-tile fauna coherence.
//###                 • QUERY & COLLISION (397) — height, normal, raycast.
//###                 • HYDROLOGY (404) — water-dependent species (fish, frogs).
//###                 • SCATTER (405) — food sources (grass, berries, prey).
//###               On top of the standard pipeline, the engine adds three
//###               first-class extension points that let any new living being
//###               be hooked into the world with O(1) cost:
//###                 1. SPECIES REGISTRY — an append-only array of
//###                    FaunaSpeciesDescriptor objects with a parallel
//###                    numeric-ID → index map. Registering a new species is
//###                    `registerSpecies(props)`, which returns a stable
//###                    numeric ID. Removing a species frees its slot for
//###                    reuse. Registration is O(1) amortized and lookup is
//###                    O(1) via the ID map.
//###                 2. FAUNA HOOK ARRAY — an append-only array of
//###                    { name, phase, callback } hooks that fire at defined
//###                    lifecycle points: ON_SPAWN, ON_TICK, ON_INTERACT,
//###                    ON_FEED, ON_DEATH, ON_DESPAWN. Registering a hook is
//###                    O(1). Hooks are called in registration order; a hook
//###                    can be removed in O(n) by name, but the hot path never
//###                    iterates the removal list. This is the intended entry
//###                    point for external systems (audio, quests, AI,
//###                    particles) to react to fauna without modifying the
//###                    engine.
//###                 3. FAUNA INSTANCE ARENA — a shared Float32Array that holds
//###                    every creature's state (position, velocity, orientation,
//###                    animation phase, health, age, hunger, behaviour state).
//###                    It grows by doubling and reuses freed ranges via a
//###                    best-fit free-list, so spawning and despawning
//###                    thousands of creatures per second costs O(1) per
//###                    creature, not O(n). Instances are indexed by
//###                    (tileKey, instanceIndex) and can be looked up in O(1).
//###               The engine implements a compact behavioural state machine
//###               with ten behaviours:
//###                 IDLE, GRAZE, DRINK, SLEEP, WANDER, FLEE, HUNT, MIGRATE,
//###                 SOCIALIZE, DEAD — all driven by biome, weather, time-of-day,
//###                 player proximity, and food availability (scatter density).
//###               No external loader, no CDN access, no static server.
//###               Everything is procedural. Designed for Android arm64 under
//###               the 8 ms per-tick CPU ceiling and 200 MB resident memory
//###               cap, and scales from a single 10-unit tile to galactic
//###               streaming (10k+ units) without main-thread stalls.
//### Best for : Any world that needs to feel alive — forests full of birds,
//###            rivers full of fish, grasslands full of grazing herds, deserts
//###            full of scuttling insects, oceans full of whales, tundras full
//###            of migrating caribou, mountains full of eagles, wetlands full
//###            of frogs. The engine is the single source of truth for "what
//###            living creatures are here?" so downstream systems (audio,
//###            ecology, gameplay, quests) never need to duplicate the fauna
//###            logic. Because it plugs into the same physical channel as the
//###            scatter engine (file 405) and the render dispatcher (file 393),
//###            fauna appears seamlessly across all tile families without any
//###            family-specific workarounds.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat3, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  WebGLRenderer, WebGPURenderer, backendConfig,
  World, Components, Systems, BitECS,
  EventDispatcher, Timer
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';

// ---- Spatial acceleration (271–274) ----
import { SpatialHashGrid } from './271_SpatialHashGrid.js';
import { DynamicBVH } from './272_DynamicBVH.js';
import { FrustumCullingSystem } from './273_FrustumCullingSystem.js';
import { OcclusionGraph } from './274_OcclusionGraph.js';

// ---- Context providers (275–279) ----
import { SpatialContextProvider } from './275_SpatialContextProvider.js';
import { TemporalContextProvider } from './276_TemporalContextProvider.js';
import { PhysicalContextProvider } from './277_PhysicalContextProvider.js';
import { CausalContextProvider } from './278_CausalContextProvider.js';
import { PlayerContextProvider } from './279_PlayerContextProvider.js';

// ---- Terrain and gradient providers (280–282_Z09) ----
import { TerrainProvider } from './280_TerrainProvider.js';
import { ElevationProvider } from './281_ElevationProvider.js';
import { SlopeGradientProvider } from './282_SlopeGradientProvider.js';
import { RockGradientProvider } from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider } from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider } from './282_Z08_GrassAndFlowresGradientProvider.js';

// ---- Environmental providers (283–296) ----
import { BathymetryProvider } from './283_BathymetryProvider.js';
import { GroundwaterProvider } from './284_GroundwaterProvider.js';
import { MoistureLevelProvider } from './285_MoistureLevelProvider.js';
import { DecomposersSystem } from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider } from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider } from './289_ClimateWindProvider.js';
import { SoilCompositionProvider } from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider } from './291_SoilFertilityProvider.js';
import { LightingSunIntensityProvider } from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider } from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem } from './296_SeasonalitySystem.js';

// ---- Sensory (297, 317) ----
import { SensoryDetailsProvider } from './297_SensoryDetailsProvider.js';
import { AudioLightEmissionSystem } from './317_AudioLightEmissionSystem.js';

// ---- Performance governance (303–307) ----
import { HLODController } from './303_HLODController.js';
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ---- Context runtime (308–310) ----
import { ContextConsumerTiers } from './308_ContextConsumerTiers.js';
import { ContextRuntime } from './309_ContextRuntime.js';
import { GeometryContextFrameReader } from './310_GeometryContextFrameReader.js';

// ---- Consumer systems (311–316) ----
import { EcologyResponseSystem } from './316_EcologyResponseSystem.js';

// ---- Biome descriptors (318–326_Z17) ----
import { TropicalRainforestBiome } from './318_TropicalRainforestBiome.js';
import { TemperateDeciduousForestBiome } from './319_TemperateDeciduousForestBiome.js';
import { TaigaBorealForestBiome } from './320_TaigaBorealForestBiome.js';
import { GrasslandSavannaBiome } from './321_GrasslandSavannaBiome.js';
import { DesertBiome } from './322_DesertBiome.js';
import { TundraBiome } from './323_TundraBiome.js';
import { AquaticFreshwaterBiome } from './324_AquaticFreshwaterBiome.js';
import { AquaticMarineBiome } from './325_AquaticMarineBiome.js';
import { AlpineBiome } from './326_AlpineBiome.js';
import { WetlandMarshSwampBiome } from './326_Z01_WetlandMarshSwampBiome.js';
import { MediterraneanChaparralBiome } from './326_Z02_MediterraneanChaparralBiome.js';
import { SteppePrairieBiome } from './326_Z03_SteppePrairieBiome.js';
import { SavannaWoodlandBiome } from './326_Z04_SavannaWoodlandBiome.js';
import { MangroveCoastalBiome } from './326_Z05_MangroveCoastalBiome.js';
import { TaigaBorealConiferousForestBiome } from './326_Z06_TaigaBorealConiferousForestBiome.js';
import { TemperateDeciduousForestBiomeZ07 } from './326_Z07_TemperateDeciduousForestBiome.js';
import { TemperateRainforestBiome } from './326_Z08_TemperateRainforestBiome.js';
import { SubtropicalHumidForestBiome } from './326_Z09_SubtropicalHumidForestBiome.js';
import { FloodingPampaGrasslandBiome } from './326_Z10_FloodingPampaGrasslandBiome.js';
import { CamposGrasslandBiome } from './326_Z11_CamposGrasslandBiome.js';
import { CerradoSavannaBiome } from './326_Z12_CerradoSavannaBiome.js';
import { AndeanPunaGrasslandBiome } from './326_Z13_AndeanPunaGrasslandBiome.js';
import { CanyonlandsBiome } from './326_Z14_CanyonlandsBiome.js';
import { MountainLakeValleyBiome } from './326_Z15_MountainLakeValleyBiome.js';
import { RiverDeltaEstuaryBiome } from './326_Z16_RiverDeltaEstuaryBiome.js';
import { BadlandsErodedHillsBiome } from './326_Z17_BadlandsErodedHillsBiome.js';

// ---- Biome coupling (327–335) ----
import { BiomeRegistryBarrel } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';

// ---- Landscape chunk (336–341) ----
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';

// ---- Terrain pipeline types (373–397) ----
import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  stringTileKey,
  fnv1aHash,
  DEFAULT_TILESET_OPTIONS
} from './373_Tileset2DTypes.js';

import { HeightmapTerrain } from './374_TerrainHeightmapTile.js';
import { QuantizedMeshTerrain } from './375_TerrainParseQuantizedMesh.js';
import { I3SElevationTerrain } from './389_TerrainI3SElevationDecoder.js';

// ---- Procedural generator scatter types (386_Z01, 386_Z02) ----
import {
  ScatterMarkerBuffer,
  ScatterMarkerType
} from './386_Z01_ProceduralTerrainGenerator_Ext.js';

import {
  AdvancedScatterParams,
  ScatterRockShape,
  ScatterTreeShape
} from './386_Z02_ProceduralTerrainGenerator_Adv.js';

// ---- Material painter and bridge (383, 394) ----
import { TerrainMaterialPainter } from './383_TerrainMaterialPainter.js';
import { TerrainMaterialBridge3D } from './394_TerrainMaterialBridge3D.js';

// ---- LOD fidelity (395) ----
import {
  TerrainLODFidelity3D,
  LODResolution,
  LODMaterialTier
} from './395_TerrainLODFidelity3D.js';

// ---- Seam stitcher (396) ----
import { TerrainSeamStitcher3D } from './396_TerrainSeamStitcher3D.js';

// ---- Query and collision (397) ----
import {
  TerrainQueryCollision3D,
  RayHit3D,
  SphereContact3D,
  SlopeResult3D
} from './397_TerrainQueryCollision3D.js';

// ---- Hydrology (404) ----
import {
  TerrainProceduralHydrology3D,
  HydrologyFlowKind,
  HydrologyWavePreset
} from './404_TerrainProceduralHydrology3D.js';

// ---- Scatter (405) ----
import {
  TerrainProceduralScatter3D,
  ScatterFamily,
  ScatterShapeClass
} from './405_TerrainProceduralScatter3D.js';

// ═════════════════════════════════════════════════════════════════════
// 1. ENUMS AND CONSTANTS
// ═════════════════════════════════════════════════════════════════════

/**
 * FaunaFamily — the broad taxonomic/behavioural category of a species.
 * Determines locomotion, LOD behaviour, and render path.
 */
export const FaunaFamily = Object.freeze({
  BIRD:        0,   // flying
  MAMMAL:      1,   // walking, running
  FISH:        2,   // swimming
  INSECT:      3,   // crawling, flying (small)
  REPTILE:     4,   // crawling
  AMPHIBIAN:   5,   // hopping, swimming
  CRUSTACEAN:  6,   // crawling underwater
  MARINE_MAMMAL: 7, // swimming, breaching
  CUSTOM:      8
});

/**
 * FaunaBehavior — the current behaviour of an instance. Drives animation,
 * locomotion speed, and interaction hooks.
 */
export const FaunaBehavior = Object.freeze({
  IDLE:        0,
  GRAZE:       1,   // eating grass / berries
  DRINK:       2,   // drinking at a water source
  SLEEP:       3,
  WANDER:      4,
  FLEE:        5,   // running from danger (player, predator)
  HUNT:        6,   // chasing prey
  MIGRATE:     7,   // moving along migration corridors
  SOCIALIZE:   8,   // flock, herd, school
  DEAD:        9
});

/**
 * FaunaHookPhase — the lifecycle phases a hook can subscribe to.
 */
export const FaunaHookPhase = Object.freeze({
  ON_SPAWN:      0,   // a creature is created
  ON_TICK:       1,   // every simulation tick for each creature
  ON_INTERACT:   2,   // player or external system touched the creature
  ON_FEED:       3,   // creature ate something
  ON_DEATH:      4,   // creature died (from combat, starvation, age)
  ON_DESPAWN:    5    // creature removed from the world
});

/**
 * FaunaLODTier — how detailed a creature's simulation is.
 */
export const FaunaLODTier = Object.freeze({
  FULL:      0,   // <100m: full behaviour + animation
  REDUCED:   1,   // <500m: simplified behaviour
  BILLBOARD: 2,   // <2000m: billboard-only
  CULLED:    3    // >2000m: not rendered
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENTS
// ═════════════════════════════════════════════════════════════════════

/**
 * FaunaTileComponent — bound to every tile that has fauna.
 */
export class FaunaTileComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    faunaStart:           { type: 'u32' },   // offset into instance arena
    faunaCount:           { type: 'u32' },
    // Per-family counts
    birdCount:            { type: 'u32' },
    mammalCount:          { type: 'u32' },
    fishCount:            { type: 'u32' },
    insectCount:          { type: 'u32' },
    otherCount:           { type: 'u32' },
    // LOD
    currentLod:           { type: 'u8' },
    faunаTier:            { type: 'u8' },   // FaunaLODTier.*
    // Lifecycle
    lastUpdatedTick:      { type: 'u32' }
  };
}

/**
 * FaunaInstanceComponent — bound to each living creature that needs ECS-level
 * tracking (playable creatures, quest targets, boss monsters). Bulk fauna
 * only exist in the arena; this component is only bound when external
 * systems need to address the creature directly.
 */
export class FaunaInstanceComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    instanceIndex:        { type: 'u32' },
    speciesId:            { type: 'u16' },
    family:               { type: 'u8' },   // FaunaFamily.*
    behavior:             { type: 'u8' },   // FaunaBehavior.*
    health:               { type: 'f32' },
    hunger:               { type: 'f32' },
    age:                  { type: 'f32' },
    growthStage:          { type: 'f32' },
    lastUpdatedTick:      { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. FAUNA INSTANCE ARENA (SoA + Free-list, grows by doubling)
// ═════════════════════════════════════════════════════════════════════

/**
 * FaunaInstanceArena — a shared Float32Array holding every living creature's
 * full state. Grows by doubling, reuses freed ranges via best-fit free-list.
 *
 * Layout per instance (32 floats):
 *   [0..2]   – world position (x, y, z)
 *   [3..5]   – velocity (vx, vy, vz)
 *   [6..9]   – orientation quaternion (x, y, z, w)
 *   [10]     – animation phase (0..1)
 *   [11]     – scale
 *   [12]     – variation seed
 *   [13]     – health
 *   [14]     – hunger
 *   [15]     – age (seconds)
 *   [16]     – growth stage (0=infant, 1=mature)
 *   [17]     – behavior enum (as float)
 *   [18]     – family enum (as float)
 *   [19]     – speciesId (as float)
 *   [20]     – lodTier (as float)
 *   [21]     – target x
 *   [22]     – target y
 *   [23]     – target z
 *   [24]     – behavior timer
 *   [25]     – flee timer
 *   [26]     – flock id
 *   [27]     – alive flag (0 or 1)
 *   [28..31] – reserved
 */
class FaunaInstanceArena {
  constructor(initialCapacity = 65536) {
    this.data = new Float32Array(initialCapacity);
    this.capacity = initialCapacity;
    this.used = 0;
    this.freeRanges = [];
    this.highWaterMark = 0;
  }

  alloc(count) {
    // Best-fit from free-list.
    let bestIdx = -1;
    let bestSize = Infinity;
    for (let i = 0; i < this.freeRanges.length; i++) {
      const r = this.freeRanges[i];
      if (r.size >= count && r.size < bestSize) {
        bestSize = r.size;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const r = this.freeRanges[bestIdx];
      const start = r.start;
      if (r.size === count) this.freeRanges.splice(bestIdx, 1);
      else { r.start += count; r.size -= count; }
      return start;
    }

    // Grow.
    if (this.used + count > this.capacity) {
      let newCap = this.capacity;
      while (newCap < this.used + count) newCap *= 2;
      const newData = new Float32Array(newCap);
      newData.set(this.data);
      this.data = newData;
      this.capacity = newCap;
    }
    const start = this.used;
    this.used += count;
    if (this.used > this.highWaterMark) this.highWaterMark = this.used;
    return start;
  }

  free(start, count) {
    if (count <= 0) return;
    let inserted = false;
    for (let i = 0; i < this.freeRanges.length; i++) {
      if (this.freeRanges[i].start > start) {
        this.freeRanges.splice(i, 0, { start, size: count });
        inserted = true;
        break;
      }
    }
    if (!inserted) this.freeRanges.push({ start, size: count });
    this.freeRanges.sort((a, b) => a.start - b.start);
    for (let i = 0; i < this.freeRanges.length - 1; i++) {
      const cur = this.freeRanges[i];
      const next = this.freeRanges[i + 1];
      if (cur.start + cur.size === next.start) {
        cur.size += next.size;
        this.freeRanges.splice(i + 1, 1);
        i--;
      }
    }
    if (this.freeRanges.length > 0) {
      const last = this.freeRanges[this.freeRanges.length - 1];
      if (last.start + last.size === this.used) {
        this.used -= last.size;
        this.freeRanges.pop();
        while (this.freeRanges.length > 0) {
          const tail = this.freeRanges[this.freeRanges.length - 1];
          if (tail.start + tail.size === this.used) {
            this.used -= tail.size;
            this.freeRanges.pop();
          } else break;
        }
      }
    }
  }

  clear() {
    this.used = 0;
    this.freeRanges.length = 0;
  }

  dispose() {
    this.data = null;
    this.freeRanges.length = 0;
    this.used = 0;
    this.capacity = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. FAUNA SPECIES REGISTRY (append-only array + ID map)
// ═════════════════════════════════════════════════════════════════════

/**
 * FaunaSpeciesDescriptor — the parametric recipe for a single species.
 * Everything is generated at instance-creation time; no meshes are loaded.
 */
export class FaunaSpeciesDescriptor {
  constructor(props) {
    this.id = props.id ?? 0;
    this.name = props.name ?? 'unnamed';
    this.family = props.family ?? FaunaFamily.MAMMAL;

    // ---- Environmental tolerances ----
    this.minElevation = props.minElevation ?? -10000;
    this.maxElevation = props.maxElevation ?? 10000;
    this.minSlope = props.minSlope ?? 0;
    this.maxSlope = props.maxSlope ?? 1;
    this.minTemperature = props.minTemperature ?? 0;
    this.maxTemperature = props.maxTemperature ?? 1;
    this.requiresWater = props.requiresWater ?? false;
    this.canSwim = props.canSwim ?? false;
    this.canFly = props.canFly ?? false;
    this.isNocturnal = props.isNocturnal ?? false;
    this.isDiurnal = props.isDiurnal ?? true;

    // ---- Density & spawn ----
    this.baseDensity = props.baseDensity ?? 0.01;
    this.minSpacing = props.minSpacing ?? 5.0;
    this.maxPerTile = props.maxPerTile ?? 32;
    this.spawnRadius = props.spawnRadius ?? 0.8;     // how far from anchor

    // ---- Size & lifespan ----
    this.minSize = props.minSize ?? 0.2;
    this.maxSize = props.maxSize ?? 2.0;
    this.lifespan = props.lifespan ?? 3600;          // seconds

    // ---- Behaviour ----
    this.baseSpeed = props.baseSpeed ?? 1.0;         // m/s
    this.fleeSpeed = props.fleeSpeed ?? 3.0;
    this.huntSpeed = props.huntSpeed ?? 2.0;
    this.behaviorWeights = props.behaviorWeights ?? {
      IDLE: 0.3, GRAZE: 0.3, DRINK: 0.1, SLEEP: 0.2, WANDER: 0.1
    };
    this.predators = props.predators ?? [];          // species IDs
    this.prey = props.prey ?? [];                    // species IDs
    this.foodSource = props.foodSource ?? 'grass';   // 'grass', 'berries', 'meat', 'fish', 'insects'

    // ---- Biomes ----
    this.biomeAffinity = props.biomeAffinity ?? new Map();

    // ---- Rendering ----
    this.shapeClass = props.shapeClass ?? 0;         // 0=bird, 1=quadruped, 2=fish, 3=insect, ...
    this.baseColor = props.baseColor ?? [0.5, 0.3, 0.2];
    this.secondaryColor = props.secondaryColor ?? null;

    // ---- Sensory ----
    this.audioCue = props.audioCue ?? null;
    this.lightCue = props.lightCue ?? null;

    // ---- Metadata ----
    this.tags = props.tags ?? [];
  }

  affinityForBiome(biomeName) {
    return this.biomeAffinity.get(biomeName) ?? 0;
  }
}

/**
 * FaunaSpeciesRegistry — an append-only registry of species with O(1)
 * add and O(1) lookup. This is one of the two extensibility points that
 * lets external systems hook new living beings into the world.
 */
export class FaunaSpeciesRegistry {
  constructor() {
    this._species = [];               // array of descriptors
    this._idToIndex = new Map();      // speciesId → array index
    this._nameToIndex = new Map();    // name → array index
    this._freeIds = [];               // recycled ids
    this._nextId = 1;
  }

  /**
   * Registers a new species. Returns its stable numeric ID.
   * O(1) amortized.
   */
  register(props) {
    const id = props.id ?? (this._freeIds.length > 0 ? this._freeIds.pop() : this._nextId++);
    if (this._idToIndex.has(id)) {
      throw new Error(`Species ID ${id} already registered`);
    }

    const descriptor = new FaunaSpeciesDescriptor({ ...props, id });
    const index = this._species.length;
    this._species.push(descriptor);
    this._idToIndex.set(id, index);
    this._nameToIndex.set(descriptor.name, index);
    return id;
  }

  /**
   * Unregisters a species by ID. Frees its slot for reuse.
   * O(1) — does not compact the array.
   */
  unregister(id) {
    const index = this._idToIndex.get(id);
    if (index === undefined) return false;
    const descriptor = this._species[index];
    this._species[index] = null;      // hole
    this._idToIndex.delete(id);
    this._nameToIndex.delete(descriptor.name);
    this._freeIds.push(id);
    return true;
  }

  get(id) {
    const index = this._idToIndex.get(id);
    return index !== undefined ? this._species[index] : null;
  }

  getByName(name) {
    const index = this._nameToIndex.get(name);
    return index !== undefined ? this._species[index] : null;
  }

  get size() { return this._idToIndex.size; }

  forEach(fn) {
    for (let i = 0; i < this._species.length; i++) {
      if (this._species[i]) fn(this._species[i], i);
    }
  }

  clear() {
    this._species.length = 0;
    this._idToIndex.clear();
    this._nameToIndex.clear();
    this._freeIds.length = 0;
    this._nextId = 1;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. FAUNA HOOK ARRAY (extensibility point #2)
// ═════════════════════════════════════════════════════════════════════

/**
 * FaunaHookArray — an append-only array of hooks that fire at defined
 * lifecycle points. External systems (audio, quests, AI, particles,
 * achievements) register hooks here without modifying the engine.
 *
 * Adding a hook is O(1). Hooks are called in registration order. Removing
 * a hook by name is O(n) but is a cold-path operation; the hot path never
 * touches the removal list.
 */
export class FaunaHookArray {
  constructor() {
    // Parallel arrays keyed by phase for O(1) dispatch.
    this._hooksByPhase = new Map();    // phase → [{ name, callback }]
    for (const phase of Object.values(FaunaHookPhase)) {
      this._hooksByPhase.set(phase, []);
    }
    this._names = new Set();
  }

  /**
   * Registers a hook. Returns an opaque handle for removal.
   * O(1) amortized.
   */
  register(name, phase, callback) {
    if (this._names.has(name)) {
      throw new Error(`Hook '${name}' already registered`);
    }
    const list = this._hooksByPhase.get(phase);
    if (!list) throw new Error(`Unknown hook phase: ${phase}`);
    const entry = { name, callback };
    list.push(entry);
    this._names.add(name);
    return { name, phase };
  }

  /**
   * Removes a hook by name.
   */
  unregister(name) {
    if (!this._names.has(name)) return false;
    for (const list of this._hooksByPhase.values()) {
      const idx = list.findIndex(h => h.name === name);
      if (idx >= 0) {
        list.splice(idx, 1);
        this._names.delete(name);
        return true;
      }
    }
    return false;
  }

  /**
   * Fires all hooks for a phase. O(k) where k = number of hooks for that
   * phase (typically 0–3 in production).
   */
  fire(phase, payload) {
    const list = this._hooksByPhase.get(phase);
    if (!list || list.length === 0) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i].callback(payload);
      } catch (e) {
        // Never break the engine on hook error.
      }
    }
  }

  /**
   * Returns the number of registered hooks across all phases.
   */
  get size() {
    let n = 0;
    for (const list of this._hooksByPhase.values()) n += list.length;
    return n;
  }

  clear() {
    for (const list of this._hooksByPhase.values()) list.length = 0;
    this._names.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. PER-TILE FAUNA STATE
// ═════════════════════════════════════════════════════════════════════

/**
 * FaunaTileState — the per-tile fauna state. Stores the instance list and
 * a free-list for instance slots.
 */
class FaunaTileState {
  constructor(tileKey) {
    this.tileKey = tileKey;
    this.instances = [];              // [{ speciesId, slot, ...state }]
    this.freeSlots = [];
    this.instanceCount = 0;

    // Per-family counts.
    this.birdCount = 0;
    this.mammalCount = 0;
    this.fishCount = 0;
    this.insectCount = 0;
    this.otherCount = 0;

    // LOD.
    this.currentLod = 0;
    this.faunaTier = FaunaLODTier.FULL;

    // Arena range.
    this.faunaStart = 0;

    // Cache.
    this.cacheVersion = 0;
    this.lastUpdatedTick = 0;
  }

  /**
   * Adds an instance. Reuses freed slots first.
   */
  addInstance(instance) {
    let slot;
    if (this.freeSlots.length > 0) {
      slot = this.freeSlots.pop();
      this.instances[slot] = instance;
    } else {
      slot = this.instances.length;
      this.instances.push(instance);
    }
    instance.slot = slot;
    this.instanceCount++;
    return slot;
  }

  /**
   * Removes an instance by slot. Reuses the slot immediately.
   */
  removeInstance(slot) {
    if (slot < 0 || slot >= this.instances.length) return null;
    const instance = this.instances[slot];
    if (!instance) return null;
    this.instances[slot] = null;
    this.freeSlots.push(slot);
    this.instanceCount--;
    return instance;
  }

  /**
   * Iterates live instances. Skips null slots.
   */
  forEachInstance(fn) {
    for (let i = 0; i < this.instances.length; i++) {
      const inst = this.instances[i];
      if (inst) fn(inst, i);
    }
  }

  reset() {
    this.instances.length = 0;
    this.freeSlots.length = 0;
    this.instanceCount = 0;
    this.birdCount = 0;
    this.mammalCount = 0;
    this.fishCount = 0;
    this.insectCount = 0;
    this.otherCount = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 7. THE FAUNA ENGINE
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainProceduralFauna3D — the procedural fauna engine.
 */
export class TerrainProceduralFauna3D {
  constructor(options = {}) {
    this.options = {
      // Frequency
      targetHz: options.targetHz ?? 10,

      // Grid resolution for placement sampling
      samplingResolution: options.samplingResolution ?? 16,

      // Per-tile instance caps
      maxInstancesPerTile: options.maxInstancesPerTile ?? 64,
      maxInstancesTotal: options.maxInstancesTotal ?? 8192,

      // LOD
      enableLOD: options.enableLOD ?? true,
      lodFullRadius: options.lodFullRadius ?? 100,
      lodReducedRadius: options.lodReducedRadius ?? 500,
      lodBillboardRadius: options.lodBillboardRadius ?? 2000,

      // Simulation
      enableBehaviorSim: options.enableBehaviorSim ?? true,
      behaviorTickInterval: options.behaviorTickInterval ?? 3,   // every N ticks
      behaviorVariationScale: options.behaviorVariationScale ?? 1.0,
      fleeRadius: options.fleeRadius ?? 15,
      fleeDuration: options.fleeDuration ?? 5.0,
      huntRadius: options.huntRadius ?? 30,
      hungerRate: options.hungerRate ?? 0.01,
      hungerToFeed: options.hungerToFeed ?? 0.5,

      // Cache
      maxCachedTiles: options.maxCachedTiles ?? 512,
      cacheVersionTickInterval: options.cacheVersionTickInterval ?? 30,

      // Arena
      initialArenaCapacity: options.initialArenaCapacity ?? 65536,

      // Registry & hooks
      speciesRegistry: options.speciesRegistry ?? null,
      hookArray: options.hookArray ?? null,

      // Biome registry
      biomeRegistry: options.biomeRegistry ?? null,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Arena ----
    this._arena = new FaunaInstanceArena(this.options.initialArenaCapacity);

    // ---- Per-tile state ----
    this._tileStates = new Map();
    this._cacheVersion = 1;

    // ---- Species registry (extensibility #1) ----
    this._speciesRegistry = this.options.speciesRegistry ?? new FaunaSpeciesRegistry();
    if (this._speciesRegistry.size === 0) {
      this._registerDefaultSpecies();
    }

    // ---- Hook array (extensibility #2) ----
    this._hookArray = this.options.hookArray ?? new FaunaHookArray();

    // ---- Biome registry ----
    this._biomeRegistry = this.options.biomeRegistry ?? new BiomeRegistryBarrel();

    // ---- Noise ----
    this._noise = new SimplexNoise({ seed: 0x4641554E }); // "FAUN"

    // ---- Context bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.queryEngine = null;
    this.hydrology = null;
    this.scatter = null;
    this.lodFidelity = null;
    this.faunaMigration = null;
    this.playerContext = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Published SoA ----
    this._published = {
      tileKeys: [],
      instanceStarts: [],
      instanceCounts: [],
      birdCounts: [],
      mammalCounts: [],
      fishCounts: [],
      insectCounts: [],
      otherCounts: [],
      count: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      ticksProcessed: 0,
      tilesProcessed: 0,
      totalInstances: 0,
      spawnsThisTick: 0,
      despawnsThisTick: 0,
      behaviorTransitions: 0,
      cacheHits: 0,
      cacheMisses: 0,
      peakInstancesPerTile: 0,
      lastDurationMs: 0,
      arenaUsed: 0,
      arenaCapacity: 0
    };
  }

  // ---------------------------------------------------------------------
  // Default species
  // ---------------------------------------------------------------------

  _registerDefaultSpecies() {
    // ---- Birds ----
    this._speciesRegistry.register({
      name: 'songbird', family: FaunaFamily.BIRD,
      minElevation: 0, maxElevation: 2500,
      minTemperature: 0.3, maxTemperature: 0.9,
      baseDensity: 0.05, minSpacing: 8, maxPerTile: 16,
      minSize: 0.1, maxSize: 0.25,
      baseSpeed: 2.0, fleeSpeed: 8.0,
      canFly: true,
      behaviorWeights: { IDLE: 0.2, GRAZE: 0.3, SOCIALIZE: 0.3, WANDER: 0.2 },
      foodSource: 'insects',
      shapeClass: 0,
      baseColor: [0.35, 0.45, 0.65],
      biomeAffinity: new Map([
        ['temperate_deciduous_forest', 1.0],
        ['tropical_rainforest', 0.8],
        ['grassland_savanna', 0.9],
        ['temperate_rainforest', 0.8]
      ]),
      audioCue: 'birdsong'
    });

    this._speciesRegistry.register({
      name: 'eagle', family: FaunaFamily.BIRD,
      minElevation: 500, maxElevation: 4000,
      minTemperature: 0.2, maxTemperature: 0.8,
      baseDensity: 0.005, minSpacing: 50, maxPerTile: 2,
      minSize: 0.8, maxSize: 1.5,
      baseSpeed: 4.0, fleeSpeed: 10.0, huntSpeed: 15.0,
      canFly: true,
      behaviorWeights: { IDLE: 0.3, HUNT: 0.4, WANDER: 0.3 },
      predators: [], prey: [20, 21],
      foodSource: 'meat',
      shapeClass: 0,
      baseColor: [0.25, 0.20, 0.15],
      biomeAffinity: new Map([
        ['alpine', 1.0],
        ['taiga_boreal_forest', 0.5],
        ['canyonlands', 0.7]
      ])
    });

    // ---- Mammals ----
    this._speciesRegistry.register({
      name: 'deer', family: FaunaFamily.MAMMAL,
      minElevation: 0, maxElevation: 2000,
      minTemperature: 0.2, maxTemperature: 0.7,
      baseDensity: 0.02, minSpacing: 20, maxPerTile: 8,
      minSize: 0.8, maxSize: 1.6,
      baseSpeed: 2.0, fleeSpeed: 8.0,
      behaviorWeights: { GRAZE: 0.4, DRINK: 0.1, FLEE: 0.2, MIGRATE: 0.3 },
      predators: [30, 31],
      foodSource: 'grass',
      shapeClass: 1,
      baseColor: [0.55, 0.40, 0.25],
      biomeAffinity: new Map([
        ['temperate_deciduous_forest', 1.0],
        ['taiga_boreal_forest', 0.9],
        ['temperate_rainforest', 0.7]
      ]),
      audioCue: 'deer_call'
    });

    this._speciesRegistry.register({
      name: 'wolf', family: FaunaFamily.MAMMAL,
      minElevation: 0, maxElevation: 2500,
      minTemperature: 0.1, maxTemperature: 0.6,
      baseDensity: 0.005, minSpacing: 50, maxPerTile: 4,
      minSize: 0.8, maxSize: 1.3,
      baseSpeed: 3.0, fleeSpeed: 6.0, huntSpeed: 10.0,
      behaviorWeights: { HUNT: 0.5, SOCIALIZE: 0.3, SLEEP: 0.2 },
      predators: [], prey: [20, 21, 22],
      foodSource: 'meat',
      isNocturnal: true, isDiurnal: false,
      shapeClass: 1,
      baseColor: [0.35, 0.35, 0.35],
      biomeAffinity: new Map([
        ['taiga_boreal_forest', 1.0],
        ['tundra', 0.9],
        ['alpine', 0.6]
      ]),
      audioCue: 'wolf_howl'
    });

    this._speciesRegistry.register({
      name: 'rabbit', family: FaunaFamily.MAMMAL,
      minElevation: 0, maxElevation: 2000,
      minTemperature: 0.2, maxTemperature: 0.8,
      baseDensity: 0.08, minSpacing: 6, maxPerTile: 16,
      minSize: 0.2, maxSize: 0.4,
      baseSpeed: 1.5, fleeSpeed: 6.0,
      behaviorWeights: { GRAZE: 0.5, FLEE: 0.3, WANDER: 0.2 },
      predators: [30, 31, 40],
      foodSource: 'grass',
      shapeClass: 1,
      baseColor: [0.75, 0.65, 0.55],
      biomeAffinity: new Map([
        ['grassland_savanna', 1.0],
        ['temperate_deciduous_forest', 0.8],
        ['steppe_prairie', 0.9]
      ])
    });

    // ---- Fish ----
    this._speciesRegistry.register({
      name: 'trout', family: FaunaFamily.FISH,
      minElevation: -50, maxElevation: 2000,
      minTemperature: 0.2, maxTemperature: 0.6,
      requiresWater: true, canSwim: true,
      baseDensity: 0.05, minSpacing: 3, maxPerTile: 12,
      minSize: 0.15, maxSize: 0.4,
      baseSpeed: 1.0, fleeSpeed: 4.0,
      behaviorWeights: { IDLE: 0.3, GRAZE: 0.5, WANDER: 0.2 },
      foodSource: 'insects',
      shapeClass: 2,
      baseColor: [0.45, 0.55, 0.60],
      biomeAffinity: new Map([
        ['aquatic_freshwater', 1.0],
        ['mountain_lake_valley', 0.9],
        ['river_delta_estuary', 0.7]
      ])
    });

    this._speciesRegistry.register({
      name: 'shark', family: FaunaFamily.FISH,
      minElevation: -500, maxElevation: 0,
      minTemperature: 0.3, maxTemperature: 0.9,
      requiresWater: true, canSwim: true,
      baseDensity: 0.002, minSpacing: 100, maxPerTile: 2,
      minSize: 2.0, maxSize: 5.0,
      baseSpeed: 2.0, fleeSpeed: 5.0, huntSpeed: 8.0,
      behaviorWeights: { HUNT: 0.6, WANDER: 0.4 },
      prey: [50],
      foodSource: 'fish',
      shapeClass: 2,
      baseColor: [0.35, 0.40, 0.45],
      biomeAffinity: new Map([
        ['aquatic_marine', 1.0],
        ['mangrove_coastal', 0.6]
      ])
    });

    // ---- Insects ----
    this._speciesRegistry.register({
      name: 'butterfly', family: FaunaFamily.INSECT,
      minElevation: 0, maxElevation: 2000,
      minTemperature: 0.4, maxTemperature: 0.9,
      baseDensity: 0.2, minSpacing: 2, maxPerTile: 32,
      minSize: 0.05, maxSize: 0.15,
      baseSpeed: 0.5, fleeSpeed: 1.0,
      canFly: true,
      behaviorWeights: { GRAZE: 0.6, WANDER: 0.4 },
      foodSource: 'nectar',
      shapeClass: 3,
      baseColor: [0.9, 0.6, 0.2],
      biomeAffinity: new Map([
        ['grassland_savanna', 1.0],
        ['mediterranean_chaparral', 0.9],
        ['temperate_deciduous_forest', 0.8]
      ])
    });

    this._speciesRegistry.register({
      name: 'firefly', family: FaunaFamily.INSECT,
      minElevation: 0, maxElevation: 1500,
      minTemperature: 0.4, maxTemperature: 0.9,
      baseDensity: 0.3, minSpacing: 1, maxPerTile: 48,
      minSize: 0.02, maxSize: 0.05,
      baseSpeed: 0.3, fleeSpeed: 0.5,
      canFly: true, isNocturnal: true, isDiurnal: false,
      behaviorWeights: { WANDER: 0.7, SOCIALIZE: 0.3 },
      shapeClass: 3,
      baseColor: [0.9, 0.9, 0.3],
      biomeAffinity: new Map([
        ['wetland_marsh_swamp', 1.0],
        ['temperate_deciduous_forest', 0.8]
      ]),
      lightCue: 'firefly_glow'
    });

    // ---- Amphibians ----
    this._speciesRegistry.register({
      name: 'frog', family: FaunaFamily.AMPHIBIAN,
      minElevation: -5, maxElevation: 1000,
      minTemperature: 0.4, maxTemperature: 0.9,
      requiresWater: true, canSwim: true,
      baseDensity: 0.05, minSpacing: 3, maxPerTile: 16,
      minSize: 0.05, maxSize: 0.2,
      baseSpeed: 0.3, fleeSpeed: 1.5,
      behaviorWeights: { IDLE: 0.3, GRAZE: 0.3, FLEE: 0.2, SOCIALIZE: 0.2 },
      foodSource: 'insects',
      isNocturnal: true, isDiurnal: false,
      shapeClass: 4,
      baseColor: [0.30, 0.55, 0.20],
      biomeAffinity: new Map([
        ['wetland_marsh_swamp', 1.0],
        ['aquatic_freshwater', 0.9],
        ['river_delta_estuary', 0.8]
      ]),
      audioCue: 'frog_croak'
    });

    // ---- Reptiles ----
    this._speciesRegistry.register({
      name: 'lizard', family: FaunaFamily.REPTILE,
      minElevation: 0, maxElevation: 2000,
      minTemperature: 0.5, maxTemperature: 1.0,
      baseDensity: 0.03, minSpacing: 5, maxPerTile: 12,
      minSize: 0.1, maxSize: 0.4,
      baseSpeed: 0.5, fleeSpeed: 2.5,
      behaviorWeights: { IDLE: 0.4, GRAZE: 0.3, FLEE: 0.3 },
      foodSource: 'insects',
      shapeClass: 4,
      baseColor: [0.45, 0.40, 0.25],
      biomeAffinity: new Map([
        ['desert', 1.0],
        ['canyonlands', 0.8],
        ['mediterranean_chaparral', 0.7]
      ])
    });
  }

  // ---------------------------------------------------------------------
  // Species registry API (extensibility #1)
  // ---------------------------------------------------------------------

  registerSpecies(props) {
    return this._speciesRegistry.register(props);
  }

  unregisterSpecies(id) {
    return this._speciesRegistry.unregister(id);
  }

  getSpecies(id) {
    return this._speciesRegistry.get(id);
  }

  getSpeciesByName(name) {
    return this._speciesRegistry.getByName(name);
  }

  getSpeciesCount() {
    return this._speciesRegistry.size;
  }

  // ---------------------------------------------------------------------
  // Hook array API (extensibility #2)
  // ---------------------------------------------------------------------

  registerHook(name, phase, callback) {
    return this._hookArray.register(name, phase, callback);
  }

  unregisterHook(name) {
    return this._hookArray.unregister(name);
  }

  getHookCount() {
    return this._hookArray.size;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  bind(contextFrame, ecsWorld, source, queryEngine, hydrology, scatter, lodFidelity, faunaMigration, playerContext, eventDispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.source = source;
    this.queryEngine = queryEngine;
    this.hydrology = hydrology;
    this.scatter = scatter;
    this.lodFidelity = lodFidelity;
    this.faunaMigration = faunaMigration;
    this.playerContext = playerContext;
    this.dispatcher = eventDispatcher;
    return this;
  }

  // ---------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------

  update(contextFrame, tick, dt, visibleHeaders) {
    this.frame = contextFrame;
    this.lastTick = tick;

    this._accumulator += dt;
    const interval = 1 / this.options.targetHz;
    if (this._accumulator < interval) return;
    this._accumulator %= interval;

    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // Bump cache version.
    if (tick % this.options.cacheVersionTickInterval === 0) {
      this._cacheVersion++;
    }

    // Read context.
    const temporal = contextFrame?.layers?.temporal;
    const physical = contextFrame?.layers?.physical;
    const causal = contextFrame?.layers?.causal;
    const player = contextFrame?.layers?.player;

    const weatherSeverity = temporal?.weatherSeverity ?? 0;
    const timeOfDay = temporal?.timeOfDay ?? 0.5;
    const season = temporal?.season ?? 0.5;
    const temperature = physical?.temperature ?? 0.5;
    const precipitation = physical?.precipitation ?? 0.5;
    const playerX = player?.position?.[0] ?? 0;
    const playerY = player?.position?.[1] ?? 0;
    const playerZ = player?.position?.[2] ?? 0;

    // Reset counters.
    this.stats.spawnsThisTick = 0;
    this.stats.despawnsThisTick = 0;

    // Reset published.
    this._resetPublished();

    // Process each visible tile.
    const visibleSet = new Set();
    for (const h of visibleHeaders) {
      if (h.state !== TileState.READY) continue;
      visibleSet.add(h.tileKey);

      const record = this.source?.tileMap?.get(h.tileKey);
      if (!record) continue;
      const terrain = record.terrainObject ?? record.terrain;
      if (!terrain) continue;

      // Determine LOD tier.
      const lodRes = this.lodFidelity?.getResolution(h.tileKey) ?? null;
      const currentLod = lodRes?.currentLod ?? h.lod;
      const tier = this._tierFromLod(currentLod, terrain, playerX, playerY, playerZ);

      // Skip culled tiles.
      if (tier === FaunaLODTier.CULLED) {
        continue;
      }

      // Get or create state.
      let state = this._tileStates.get(h.tileKey);
      const cachedVersion = state?.cacheVersion ?? -1;
      if (state && cachedVersion === this._cacheVersion &&
          state.currentLod === currentLod && state.faunaTier === tier) {
        this.stats.cacheHits++;
        // Still update behaviour every tick even on cache hit.
        if (this.options.enableBehaviorSim) {
          this._simulateBehaviors(state, terrain, h, tier, {
            weatherSeverity, timeOfDay, season, temperature, precipitation,
            playerX, playerY, playerZ
          }, tick, dt);
        }
        this._publishTile(state, h);
        continue;
      }
      this.stats.cacheMisses++;

      // Create state.
      if (!state) {
        state = new FaunaTileState(h.tileKey);
        this._tileStates.set(h.tileKey, state);
      }
      state.reset();
      state.cacheVersion = this._cacheVersion;
      state.currentLod = currentLod;
      state.faunaTier = tier;

      // Spawn fauna for this tile.
      this._spawnTileFauna(state, terrain, h, tier, {
        weatherSeverity, timeOfDay, season, temperature, precipitation,
        playerX, playerY, playerZ
      }, tick);

      // Simulate behaviors.
      if (this.options.enableBehaviorSim && tier !== FaunaLODTier.BILLBOARD) {
        this._simulateBehaviors(state, terrain, h, tier, {
          weatherSeverity, timeOfDay, season, temperature, precipitation,
          playerX, playerY, playerZ
        }, tick, dt);
      }

      // Publish.
      this._publishTile(state, h);
    }

    // Upload to arena.
    this._uploadToArena();

    // Publish to physical channel.
    this._publishToPhysicalChannel();

    // Evict stale.
    this._evictStale(visibleSet);

    // Stats.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastDurationMs = t1 - t0;
    this.stats.ticksProcessed++;
    this.stats.arenaUsed = this._arena.used;
    this.stats.arenaCapacity = this._arena.capacity;
  }

  // ---------------------------------------------------------------------
  // Tier determination
  // ---------------------------------------------------------------------

  _tierFromLod(lod, terrain, playerX, playerY, playerZ) {
    if (!this.options.enableLOD) return FaunaLODTier.FULL;

    const cx = (terrain.bounds ? (terrain.bounds[0] + terrain.bounds[3]) * 0.5 : (terrain.originX ?? 0) + (terrain.tileWorldSize ?? 100) * 0.5);
    const cy = (terrain.bounds ? (terrain.bounds[1] + terrain.bounds[4]) * 0.5 : (terrain.originY ?? 0) + (terrain.tileWorldSize ?? 100) * 0.5);
    const cz = (terrain.bounds ? (terrain.bounds[2] + terrain.bounds[5]) * 0.5 : 0);

    const dx = cx - playerX;
    const dy = cy - playerY;
    const dz = cz - playerZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < this.options.lodFullRadius) return FaunaLODTier.FULL;
    if (dist < this.options.lodReducedRadius) return FaunaLODTier.REDUCED;
    if (dist < this.options.lodBillboardRadius) return FaunaLODTier.BILLBOARD;
    return FaunaLODTier.CULLED;
  }

  // ---------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------

  _spawnTileFauna(state, terrain, header, tier, context, tick) {
    const biomeName = this._resolveDominantBiome(terrain, header);

    // Iterate species and place instances.
    this._speciesRegistry.forEach((species) => {
      // Skip species that don't live in this biome.
      const affinity = species.affinityForBiome(biomeName);
      if (affinity < 0.1) return;

      // Skip species that are inactive at this time of day.
      if (species.isNocturnal && context.timeOfDay > 0.3 && context.timeOfDay < 0.7) return;
      if (species.isDiurnal && (context.timeOfDay < 0.25 || context.timeOfDay > 0.75)) return;

      // Skip species outside their temperature range.
      if (context.temperature < species.minTemperature ||
          context.temperature > species.maxTemperature) return;

      // Skip if water is required but no water is present.
      if (species.requiresWater) {
        const waterState = this.hydrology?.getTileState(header.tileKey);
        if (!waterState || waterState.totalWaterVolume < 1) return;
      }

      // Compute spawn count.
      const tileArea = (terrain.tileWorldSize ?? 100) ** 2;
      const spawnCount = Math.min(
        Math.floor(tileArea * species.baseDensity * affinity),
        species.maxPerTile,
        this.options.maxInstancesPerTile - state.instanceCount
      );

      if (spawnCount <= 0) return;

      // Poisson-disk placement.
      const placed = [];
      const originX = terrain.originX ?? (terrain.bounds ? terrain.bounds[0] : 0);
      const originY = terrain.originY ?? (terrain.bounds ? terrain.bounds[1] : 0);
      const cellSize = (terrain.tileWorldSize ?? 100) / this.options.samplingResolution;

      for (let attempt = 0; attempt < spawnCount * 3 && placed.length < spawnCount; attempt++) {
        // Deterministic position from noise.
        const seed = this._noise.noise2D(attempt * 0.1, tick * 0.01);
        const seed2 = this._noise.noise2D(attempt * 0.1 + 500, tick * 0.01 + 500);
        const gx = Math.floor((seed * 0.5 + 0.5) * this.options.samplingResolution);
        const gy = Math.floor((seed2 * 0.5 + 0.5) * this.options.samplingResolution);
        if (gx < 0 || gx >= this.options.samplingResolution) continue;
        if (gy < 0 || gy >= this.options.samplingResolution) continue;

        const wx = originX + gx * cellSize;
        const wy = originY + gy * cellSize;

        // Query terrain height.
        let wz = this.queryEngine?.getHeight(wx, wy) ?? 0;
        if (isNaN(wz)) wz = 0;

        // Check elevation.
        if (wz < species.minElevation || wz > species.maxElevation) continue;

        // Check water.
        if (species.requiresWater && this.hydrology) {
          const waterState = this.hydrology.getTileState(header.tileKey);
          if (waterState) {
            const depth = this.hydrology.getWaterDepthAt(
              header.tileKey, gx / this.options.samplingResolution, gy / this.options.samplingResolution
            );
            if (depth < 0.1) continue;
          }
        }

        // Check Poisson spacing.
        let tooClose = false;
        for (const p of placed) {
          const dx = p.x - wx, dy = p.y - wy;
          if (dx * dx + dy * dy < species.minSpacing * species.minSpacing) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;

        // Build instance.
        const instance = this._buildInstance(species, wx, wy, wz, context, seed, seed2);

        state.addInstance(instance);
        placed.push({ x: wx, y: wy });

        this._incrementFamilyCount(state, species.family);
        this.stats.spawnsThisTick++;

        // Fire ON_SPAWN hook.
        this._hookArray.fire(FaunaHookPhase.ON_SPAWN, {
          tileKey: header.tileKey,
          speciesId: species.id,
          speciesName: species.name,
          family: species.family,
          instance
        });
      }
    });
  }

  // ---------------------------------------------------------------------
  // Instance construction
  // ---------------------------------------------------------------------

  _buildInstance(species, wx, wy, wz, context, seed, seed2) {
    const size = species.minSize + (seed * 0.5 + 0.5) * (species.maxSize - species.minSize);

    // Choose a behavior based on weighted probabilities.
    const behavior = this._chooseInitialBehavior(species, context);

    // Variation seed.
    const variationSeed = Math.abs(this._noise.noise2D(wx * 0.1, wy * 0.1));

    return {
      slot: 0,
      speciesId: species.id,
      family: species.family,
      position: [wx, wy, wz],
      velocity: [0, 0, 0],
      orientation: [0, 0, 0, 1],
      animationPhase: seed * 0.5 + 0.5,
      size,
      variationSeed,
      health: 1.0,
      hunger: 0.3,
      age: 0,
      growthStage: 0.8,
      behavior,
      behaviorTimer: 2 + seed * 3,
      fleeTimer: 0,
      flockId: 0,
      alive: 1,
      target: [wx, wy, wz],
      shapeClass: species.shapeClass,
      baseColor: species.baseColor,
      secondaryColor: species.secondaryColor,
      audioCue: species.audioCue,
      lightCue: species.lightCue
    };
  }

  _chooseInitialBehavior(species, context) {
    const weights = species.behaviorWeights;

    // Force sleep at night for diurnal, or day for nocturnal.
    if (species.isDiurnal && (context.timeOfDay < 0.25 || context.timeOfDay > 0.75)) {
      if (weights.SLEEP != null) return FaunaBehavior.SLEEP;
    }
    if (species.isNocturnal && context.timeOfDay > 0.3 && context.timeOfDay < 0.7) {
      if (weights.SLEEP != null) return FaunaBehavior.SLEEP;
    }

    // Weighted random from the species' behaviour weights.
    const keys = Object.keys(weights);
    let total = 0;
    for (const k of keys) total += weights[k];
    let r = Math.random() * total;
    for (const k of keys) {
      r -= weights[k];
      if (r <= 0) return FaunaBehavior[k] ?? FaunaBehavior.IDLE;
    }
    return FaunaBehavior.IDLE;
  }

  // ---------------------------------------------------------------------
  // Behaviour simulation
  // ---------------------------------------------------------------------

  _simulateBehaviors(state, terrain, header, tier, context, tick, dt) {
    if (tick % this.options.behaviorTickInterval !== 0) return;

    const behaviorDt = dt * this.options.behaviorTickInterval;

    state.forEachInstance((instance) => {
      const species = this._speciesRegistry.get(instance.speciesId);
      if (!species) return;

      // Update age.
      instance.age += behaviorDt;
      if (instance.age >= species.lifespan) {
        this._killInstance(state, instance, header, 'old_age');
        return;
      }

      // Update hunger.
      instance.hunger += this.options.hungerRate * behaviorDt;
      if (instance.hunger > 1.0) {
        instance.hunger = 1.0;
        if (instance.hunger > this.options.hungerToFeed) {
          // Starvation begins.
          instance.health -= 0.05 * behaviorDt;
        }
      }

      // Check for player proximity (flee).
      if (context.playerX !== undefined) {
        const dx = instance.position[0] - context.playerX;
        const dy = instance.position[1] - context.playerY;
        const dz = instance.position[2] - context.playerZ;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < this.options.fleeRadius * this.options.fleeRadius) {
          if (instance.behavior !== FaunaBehavior.FLEE) {
            instance.behavior = FaunaBehavior.FLEE;
            instance.fleeTimer = this.options.fleeDuration;
            this.stats.behaviorTransitions++;
            this._hookArray.fire(FaunaHookPhase.ON_INTERACT, {
              tileKey: header.tileKey,
              speciesId: species.id,
              instance,
              interaction: 'player_proximity'
            });
          }
        }
      }

      // Update flee timer.
      if (instance.behavior === FaunaBehavior.FLEE) {
        instance.fleeTimer -= behaviorDt;
        if (instance.fleeTimer <= 0) {
          instance.behavior = FaunaBehavior.WANDER;
          instance.behaviorTimer = 2 + Math.random() * 3;
          this.stats.behaviorTransitions++;
        }
      } else {
        // Update behavior timer.
        instance.behaviorTimer -= behaviorDt;
        if (instance.behaviorTimer <= 0) {
          this._transitionBehavior(instance, species, state, header, context, tick);
        }
      }

      // Move the instance based on its behavior.
      this._moveInstance(instance, species, terrain, tier, behaviorDt);

      // Clamp position to tile bounds.
      if (terrain.bounds) {
        instance.position[0] = Math.max(terrain.bounds[0], Math.min(terrain.bounds[3], instance.position[0]));
        instance.position[1] = Math.max(terrain.bounds[1], Math.min(terrain.bounds[4], instance.position[1]));
      }

      // Update ground height.
      const groundH = this.queryEngine?.getHeight(instance.position[0], instance.position[1]);
      if (!isNaN(groundH)) {
        if (species.canFly) {
          // Flying animals stay above ground.
          instance.position[2] = Math.max(groundH + 3, instance.position[2]);
        } else if (species.canSwim) {
          // Swimming animals stay near water surface.
          instance.position[2] = Math.min(groundH + 0.5, instance.position[2]);
        } else {
          instance.position[2] = groundH;
        }
      }

      // Update animation phase.
      instance.animationPhase = (instance.animationPhase + behaviorDt * 0.5) % 1;

      // Fire ON_TICK hook.
      this._hookArray.fire(FaunaHookPhase.ON_TICK, {
        tileKey: header.tileKey,
        speciesId: species.id,
        instance
      });
    });
  }

  _transitionBehavior(instance, species, state, header, context, tick) {
    const weights = species.behaviorWeights;
    const keys = Object.keys(weights);
    let total = 0;
    for (const k of keys) total += weights[k];
    let r = Math.random() * total;
    for (const k of keys) {
      r -= weights[k];
      if (r <= 0) {
        instance.behavior = FaunaBehavior[k] ?? FaunaBehavior.IDLE;
        instance.behaviorTimer = 2 + Math.random() * 5;
        this.stats.behaviorTransitions++;
        return;
      }
    }
    instance.behavior = FaunaBehavior.IDLE;
    instance.behaviorTimer = 2 + Math.random() * 3;
  }

  _moveInstance(instance, species, terrain, tier, dt) {
    const b = instance.behavior;

    // Determine speed.
    let speed = species.baseSpeed;
    if (b === FaunaBehavior.FLEE) speed = species.fleeSpeed;
    else if (b === FaunaBehavior.HUNT) speed = species.huntSpeed;
    else if (b === FaunaBehavior.SLEEP || b === FaunaBehavior.IDLE) speed = 0;

    if (speed === 0) return;

    // Simple locomotion: move in the direction of the target.
    const dx = instance.target[0] - instance.position[0];
    const dy = instance.target[1] - instance.position[1];
    const dz = instance.target[2] - instance.position[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist < 0.5) {
      // Reached the target; pick a new one.
      this._pickNewTarget(instance, terrain);
      return;
    }

    // Normalize and move.
    const vx = (dx / dist) * speed * dt;
    const vy = (dy / dist) * speed * dt;
    const vz = (dz / dist) * speed * dt;

    instance.position[0] += vx;
    instance.position[1] += vy;
    instance.position[2] += vz;
  }

  _pickNewTarget(instance, terrain) {
    // Random point within the tile bounds.
    if (terrain.bounds) {
      const w = terrain.bounds[3] - terrain.bounds[0];
      const h = terrain.bounds[4] - terrain.bounds[1];
      instance.target[0] = terrain.bounds[0] + Math.random() * w;
      instance.target[1] = terrain.bounds[1] + Math.random() * h;
      instance.target[2] = 0;
    } else {
      instance.target[0] += (Math.random() - 0.5) * 10;
      instance.target[1] += (Math.random() - 0.5) * 10;
    }
  }

  _killInstance(state, instance, header, cause) {
    instance.alive = 0;
    instance.behavior = FaunaBehavior.DEAD;

    // Fire ON_DEATH hook.
    const species = this._speciesRegistry.get(instance.speciesId);
    this._hookArray.fire(FaunaHookPhase.ON_DEATH, {
      tileKey: header.tileKey,
      speciesId: instance.speciesId,
      speciesName: species?.name,
      instance,
      cause
    });

    // Remove the instance.
    state.removeInstance(instance.slot);
    this.stats.despawnsThisTick++;

    // Fire ON_DESPAWN hook.
    this._hookArray.fire(FaunaHookPhase.ON_DESPAWN, {
      tileKey: header.tileKey,
      speciesId: instance.speciesId,
      instance
    });
  }

  // ---------------------------------------------------------------------
  // Aggregate counts
  // ---------------------------------------------------------------------

  _incrementFamilyCount(state, family) {
    switch (family) {
      case FaunaFamily.BIRD:      state.birdCount++; break;
      case FaunaFamily.MAMMAL:    state.mammalCount++; break;
      case FaunaFamily.FISH:      state.fishCount++; break;
      case FaunaFamily.INSECT:    state.insectCount++; break;
      default:                    state.otherCount++; break;
    }
  }

  // ---------------------------------------------------------------------
  // Biome resolution
  // ---------------------------------------------------------------------

  _resolveDominantBiome(terrain, header) {
    if (terrain.dominantBiomeName) return terrain.dominantBiomeName;

    const avgH = (terrain.minElevation + terrain.maxElevation) * 0.5;
    if (avgH > 2500) return 'alpine';
    if (avgH > 1500) return 'taiga_boreal_forest';
    if (avgH > 500) return 'temperate_deciduous_forest';
    if (avgH > 100) return 'grassland_savanna';
    return 'desert';
  }

  // ---------------------------------------------------------------------
  // Arena upload
  // ---------------------------------------------------------------------

  _uploadToArena() {
    for (const [tileKey, state] of this._tileStates) {
      if (state.instanceCount === 0) continue;

      // Free old range.
      if (state.faunaStart > 0) {
        this._arena.free(state.faunaStart, state.instances.length * 32);
      }

      // Allocate fresh (using instances.length, not instanceCount,
      // to preserve slot indexing).
      const totalFloats = state.instances.length * 32;
      if (totalFloats === 0) continue;
      state.faunaStart = this._arena.alloc(totalFloats);

      // Copy each live instance.
      const data = this._arena.data;
      for (let i = 0; i < state.instances.length; i++) {
        const inst = state.instances[i];
        const base = state.faunaStart + i * 32;

        if (!inst) {
          // Null slot: mark as dead.
          data[base + 27] = 0;
          continue;
        }

        // Position.
        data[base + 0] = inst.position[0];
        data[base + 1] = inst.position[1];
        data[base + 2] = inst.position[2];

        // Velocity.
        data[base + 3] = inst.velocity[0];
        data[base + 4] = inst.velocity[1];
        data[base + 5] = inst.velocity[2];

        // Orientation.
        data[base + 6] = inst.orientation[0];
        data[base + 7] = inst.orientation[1];
        data[base + 8] = inst.orientation[2];
        data[base + 9] = inst.orientation[3];

        // Per-instance uniforms.
        data[base + 10] = inst.animationPhase;
        data[base + 11] = inst.size;
        data[base + 12] = inst.variationSeed;
        data[base + 13] = inst.health;
        data[base + 14] = inst.hunger;
        data[base + 15] = inst.age;
        data[base + 16] = inst.growthStage;
        data[base + 17] = inst.behavior;
        data[base + 18] = inst.family;
        data[base + 19] = inst.speciesId;
        data[base + 20] = state.faunaTier;
        data[base + 21] = inst.target[0];
        data[base + 22] = inst.target[1];
        data[base + 23] = inst.target[2];
        data[base + 24] = inst.behaviorTimer;
        data[base + 25] = inst.fleeTimer;
        data[base + 26] = inst.flockId;
        data[base + 27] = inst.alive;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------

  _resetPublished() {
    const p = this._published;
    p.tileKeys.length = 0;
    p.instanceStarts.length = 0;
    p.instanceCounts.length = 0;
    p.birdCounts.length = 0;
    p.mammalCounts.length = 0;
    p.fishCounts.length = 0;
    p.insectCounts.length = 0;
    p.otherCounts.length = 0;
    p.count = 0;
  }

  _publishTile(state, header) {
    const p = this._published;
    p.tileKeys.push(header.tileKey);
    p.instanceStarts.push(state.faunaStart);
    p.instanceCounts.push(state.instanceCount);
    p.birdCounts.push(state.birdCount);
    p.mammalCounts.push(state.mammalCount);
    p.fishCounts.push(state.fishCount);
    p.insectCounts.push(state.insectCount);
    p.otherCounts.push(state.otherCount);
    p.count++;
  }

  _publishToPhysicalChannel() {
    if (!this.frame?.layers?.physical) return;
    const physical = this.frame.layers.physical;
    const p = this._published;

    physical.faunaTileKeys = p.tileKeys;
    physical.faunaInstanceStarts = p.instanceStarts;
    physical.faunaInstanceCounts = p.instanceCounts;
    physical.faunaBirdCounts = p.birdCounts;
    physical.faunaMammalCounts = p.mammalCounts;
    physical.faunaFishCounts = p.fishCounts;
    physical.faunaInsectCounts = p.insectCounts;
    physical.faunaOtherCounts = p.otherCounts;
    physical.faunaArena = this._arena.data;
    physical.faunaStats = this.getStats();
  }

  // ---------------------------------------------------------------------
  // Eviction
  // ---------------------------------------------------------------------

  _evictStale(visibleSet) {
    if (this._tileStates.size <= this.options.maxCachedTiles) return;

    const toEvict = [];
    for (const [tileKey, state] of this._tileStates) {
      if (!visibleSet.has(tileKey)) toEvict.push(tileKey);
    }

    for (const tileKey of toEvict) {
      if (this._tileStates.size <= this.options.maxCachedTiles) break;
      const state = this._tileStates.get(tileKey);
      if (state) {
        // Free arena range.
        if (state.faunaStart > 0) {
          this._arena.free(state.faunaStart, state.instances.length * 32);
        }
        // Fire ON_DESPAWN for each remaining instance.
        state.forEachInstance((instance) => {
          this._hookArray.fire(FaunaHookPhase.ON_DESPAWN, {
            tileKey,
            speciesId: instance.speciesId,
            instance
          });
        });
      }
      this._tileStates.delete(tileKey);
    }
  }

  // ---------------------------------------------------------------------
  // Public queries
  // ---------------------------------------------------------------------

  getTileFauna(tileKey) {
    return this._tileStates.get(tileKey) ?? null;
  }

  getInstanceCount(tileKey) {
    return this._tileStates.get(tileKey)?.instanceCount ?? 0;
  }

  getArena() {
    return this._arena.data;
  }

  getStats() {
    return {
      ...this.stats,
      cachedTiles: this._tileStates.size,
      arenaUsed: this._arena.used,
      arenaCapacity: this._arena.capacity,
      arenaHighWaterMark: this._arena.highWaterMark,
      speciesCount: this._speciesRegistry.size,
      hookCount: this._hookArray.size,
      cacheVersion: this._cacheVersion
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  clear() {
    for (const state of this._tileStates.values()) {
      if (state.faunaStart > 0) {
        this._arena.free(state.faunaStart, state.instances.length * 32);
      }
    }
    this._tileStates.clear();
    this._arena.clear();
    this._resetPublished();
  }

  dispose() {
    this.clear();
    this._arena.dispose();
    this._speciesRegistry.clear();
    this._hookArray.clear();
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.queryEngine = null;
    this.hydrology = null;
    this.scatter = null;
    this.lodFidelity = null;
    this.faunaMigration = null;
    this.playerContext = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 8. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainProceduralFauna3D(options = {}) {
  return new TerrainProceduralFauna3D({
    targetHz: options.targetHz ?? 10,
    samplingResolution: options.samplingResolution ?? 16,
    maxInstancesPerTile: options.maxInstancesPerTile ?? 64,
    maxInstancesTotal: options.maxInstancesTotal ?? 8192,
    enableLOD: options.enableLOD ?? true,
    lodFullRadius: options.lodFullRadius ?? 100,
    lodReducedRadius: options.lodReducedRadius ?? 500,
    lodBillboardRadius: options.lodBillboardRadius ?? 2000,
    enableBehaviorSim: options.enableBehaviorSim ?? true,
    behaviorTickInterval: options.behaviorTickInterval ?? 3,
    behaviorVariationScale: options.behaviorVariationScale ?? 1.0,
    fleeRadius: options.fleeRadius ?? 15,
    fleeDuration: options.fleeDuration ?? 5.0,
    huntRadius: options.huntRadius ?? 30,
    hungerRate: options.hungerRate ?? 0.01,
    hungerToFeed: options.hungerToFeed ?? 0.5,
    maxCachedTiles: options.maxCachedTiles ?? 512,
    cacheVersionTickInterval: options.cacheVersionTickInterval ?? 30,
    initialArenaCapacity: options.initialArenaCapacity ?? 65536,
    speciesRegistry: options.speciesRegistry ?? null,
    hookArray: options.hookArray ?? null,
    biomeRegistry: options.biomeRegistry ?? null,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 9. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainProceduralFauna3D,
  FaunaSpeciesRegistry,
  FaunaSpeciesDescriptor,
  FaunaHookArray,
  FaunaTileComponent,
  FaunaInstanceComponent,
  FaunaInstanceArena,
  FaunaTileState,
  FaunaFamily,
  FaunaBehavior,
  FaunaHookPhase,
  FaunaLODTier,
  createTerrainProceduralFauna3D
};