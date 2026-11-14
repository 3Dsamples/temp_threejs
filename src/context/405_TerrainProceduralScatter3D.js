// file number : 405
// full path name : src/context/405_TerrainProceduralScatter3D.js
//### Description : Context-aware procedural scatter engine for the seamless
//###               3D terrain pipeline. This is the module that populates every
//###               terrain tile with living content — trees, shrubs, grass
//###               tufts, rocks, boulders, cacti, ferns, bamboo, flowers,
//###               mushrooms, deadwood, debris, and every other instanced
//###               natural object — driven entirely by procedural rules and the
//###               runtime context frame. Nothing is fetched, loaded, or
//###               authored: every instance is placed by a deterministic
//###               Poisson-disk sampler that reads the tile's height, slope,
//###               biome weights, material families, hydrology, weather, and
//###               LOD, and every instance's shape, scale, rotation, and
//###               variation is derived from a per-tile seed shared across the
//###               pipeline.
//###               The scatter engine integrates every relevant context file:
//###                 • CONTEXT FRAME (263) — temporal, physical, causal channels
//###                   drive density, colour, and lifecycle.
//###                 • MATH/ECS BARREL (264) — Vec3, Mat4, Quat, SimplexNoise,
//###                   World, Components, Systems.
//###                 • CORE EVENT DISPATCHER (265) — emits scatter lifecycle events.
//###                 • SPATIAL ACCELERATION (271–274) — instance culling.
//###                 • CONTEXT PROVIDERS (275–279) — spatial, temporal,
//###                   physical, causal, player context.
//###                 • TERRAIN PROVIDERS (280–282_Z09) — elevation, slope, rock,
//###                   forest, grass, and continental relief gradients.
//###                 • ENVIRONMENTAL PROVIDERS (283–296) — bathymetry,
//###                   groundwater, moisture, decomposers, climate, soil,
//###                   lighting, seasonality.
//###                 • SENSORY (297, 317) — audio/light emission for scatter.
//###                 • PERFORMANCE (303–307) — HLOD, memory, frame budget, GC.
//###                 • CONTEXT RUNTIME (308–310) — consumer tiers, runtime.
//###                 • CONSUMER SYSTEMS (311–316) — LOD, load state, visibility,
//###                   material params, ecology response.
//###                 • AUDIO/LIGHT EMISSION (317) — footstep and leaf rustle cues.
//###                 • BIOME DESCRIPTORS (318–326_Z17) — every biome in the
//###                   pipeline, including tropical rainforest, taiga, savanna,
//###                   desert, tundra, alpine, wetland, chaparral, steppe,
//###                   mangrove, cerrado, puna, canyonlands, mountain lake,
//###                   river delta, and badlands.
//###                 • BIOME COUPLING (327–334) — blend, ecotone, material,
//###                   climate, soil, hydrology coupling.
//###                 • FAUNA MIGRATION (335) — animal-driven scatter patterns.
//###                 • LANDSCAPE CHUNK (336–341) — descriptor, streamer, HLOD,
//###                   spatial hash, occlusion, persistence.
//###                 • PROCEDURAL GENERATOR (386 series) — ScatterMarkerBuffer,
//###                   ScatterMarkerType, AdvancedScatterParams, ScatterRockShape,
//###                   ScatterTreeShape, FaunaMigrationHook.
//###                 • MATERIAL PAINTER (383) — per-vertex material weights.
//###                 • MATERIAL BRIDGE (394) — coupled material state.
//###                 • LOD FIDELITY (395) — distance-based scatter density.
//###                 • SEAM STITCHER (396) — cross-tile instance coherence.
//###                 • QUERY & COLLISION (397) — height/normal/slope sampling.
//###                 • HYDROLOGY (404) — water-dependent vegetation.
//###               The engine implements five complementary placement strategies
//###               that run in order per tile:
//###                 1. DETERMINISTIC POISSON-DISK — guarantees minimum spacing
//###                    between instances of the same species, matching real
//###                    spatial distributions.
//###                 2. BIOME-DRIVEN DENSITY — reads the biome descriptor's
//###                    scatter rules (tree density, shrub density, grass
//###                    density, rock density, flower density) and blends them
//###                    across biome boundaries using the blended biome weight
//###                    field.
//###                 3. GRADIENT-DRIVEN FILTERING — uses the forest, grass, rock,
//###                    cliff, and relief gradients to reject placements on
//###                    wrong surfaces.
//###                 4. HYDROLOGY-DRIVEN SCATTER — places water-dependent species
//###                    (reeds, lilies, mangroves) along rivers, lakes, and
//###                    coastlines using the hydrology simulator's river
//###                    network and lake mask.
//###                 5. FAUNA-DRIVEN SCATTER — places trampled grass, animal
//###                    paths, and grazing patches along the fauna migration
//###                    corridors.
//###               Every instance is placed in one of the scatter families:
//###                 • TREE (instanced mesh with per-instance matrix)
//###                 • SHRUB (instanced mesh)
//###                 • GRASS (instanced billboard or mesh)
//###                 • ROCK (instanced mesh with fractal shape)
//###                 • BOULDER (instanced mesh)
//###                 • FLOWER (instanced billboard)
//###                 • MUSHROOM (instanced billboard)
//###                 • FERN (instanced mesh)
//###                 • CACTUS (instanced mesh)
//###                 • BAMBOO (instanced mesh)
//###                 • REED (instanced billboard)
//###                 • DEADWOOD (instanced mesh)
//###                 • DEBRIS (instanced mesh)
//###                 • EGG_CLUSTER (instanced mesh, fauna-related)
//###                 • DUNG (instanced mesh, fauna-related)
//###                 • TRACK (decal)
//###                 • NEST (instanced mesh)
//###                 • BURROW (decal)
//###               Each instance stores a full 4×4 transformation matrix, a
//###               per-instance colour, a per-instance scale, a per-instance
//###               rotation seed, and a reference into the shared shape
//###               descriptor array. All instance data lives in a single
//###               structure-of-arrays arena that the render dispatcher (file
//###               393) consumes directly — the scatter engine never emits a
//###               per-instance draw call.
//###               No external loader, no CDN access, no static server.
//###               Everything is generated procedurally. Designed for Android
//###               arm64 under the 8 ms per-tick CPU ceiling and 200 MB resident
//###               memory cap, and scales from a single 10-unit tile to galactic
//###               streaming (10k+ units) without main-thread stalls.
//### Best for : Any world that needs to be populated with living content
//###            procedurally — forests, grasslands, deserts, tundras, alpine
//###            meadows, wetlands, coral reefs, ruins, badlands, canyons,
//###            savannas, and every biome in the pipeline. The scatter engine
//###            is the single source of truth for "what should grow here?" so
//###            downstream systems (materials, audio, ecology, gameplay) never
//###            need to duplicate the scatter logic. Because it plugs into the
//###            same physical channel as the material bridge (file 394) and the
//###            render dispatcher (file 393), scatter appears seamlessly across
//###            all tile families — heightmap grids, quantized meshes, I3S
//###            elevation, procedural meshes — without any family-specific
//###            workarounds.
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
import { ReliefGradientProvider } from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider } from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider } from './282_Z03_CarveGradientProvider.js';
import { NaturalFormationGradientProvider } from './282_Z04_NaturalFormationGradientProvider.js';
import { RockGradientProvider } from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider } from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider } from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider } from './282_Z09_ContinentalReliefGradientProvider.js';

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
import { SoilColorTextureProvider } from './292_SoilColorTextureProvider.js';
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
import { UpdateLODConsumer } from './311_UpdateLODConsumer.js';
import { UpdateLoadStateConsumer } from './312_UpdateLoadStateConsumer.js';
import { IsVisibleConsumer } from './313_IsVisibleConsumer.js';
import { ApplyNoiseConsumer } from './314_ApplyNoiseConsumer.js';
import { SetMaterialParamsConsumer } from './315_SetMaterialParamsConsumer.js';
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

// ---- Biome coupling (327–334) ----
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

// ---- Terrain pipeline types (373–385) ----
import {
  TilesetSourceFormat,
  TileState,
  TileEventType,
  SeamEdge,
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
  ScatterMarkerType,
  ExtendedTerrainGenerator
} from './386_Z01_ProceduralTerrainGenerator_Ext.js';

import {
  AdvancedScatterParams,
  ScatterRockShape,
  ScatterTreeShape,
  AdvancedTerrainGenerator
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

// ═════════════════════════════════════════════════════════════════════
// 1. ENUMS AND CONSTANTS
// ═════════════════════════════════════════════════════════════════════

/**
 * ScatterFamily — the top-level category of a scatter instance.
 * Determines the shader path, material family, and LOD behaviour.
 */
export const ScatterFamily = Object.freeze({
  TREE:        0,
  SHRUB:       1,
  GRASS:       2,
  ROCK:        3,
  BOULDER:     4,
  FLOWER:      5,
  MUSHROOM:    6,
  FERN:        7,
  CACTUS:      8,
  BAMBOO:      9,
  REED:       10,
  DEADWOOD:   11,
  DEBRIS:     12,
  EGG_CLUSTER: 13,
  DUNG:       14,
  NEST:       15
});

/**
 * ScatterPlacementStrategy — how the instance was placed.
 */
export const ScatterPlacementStrategy = Object.freeze({
  POISSON:        0,
  BIOME_DENSITY:  1,
  GRADIENT_FILTER: 2,
  HYDROLOGY:      3,
  FAUNA_PATH:     4
});

/**
 * ScatterShapeClass — the high-level shape descriptor for an instance.
 */
export const ScatterShapeClass = Object.freeze({
  CONIFER:    0,
  DECIDUOUS:  1,
  PALM:       2,
  CACTUS:     3,
  BAMBOO:     4,
  SHRUB:      5,
  FERN:       6,
  GRASS_TUFT: 7,
  FLOWER:     8,
  MUSHROOM:   9,
  ROCK_ANGULAR: 10,
  ROCK_SPHERE: 11,
  ROCK_FRACTAL: 12,
  BOULDER:    13,
  DEADWOOD_LOG: 14,
  DEBRIS_CHUNK: 15
});

// ═════════════════════════════════════════════════════════════════════
// 2. ECS COMPONENTS
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainScatterTileComponent — bound to every tile that has scatter
 * instances. Stores the per-tile aggregate statistics and the pointer into
 * the scatter arena.
 */
export class TerrainScatterTileComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    scatterStart:         { type: 'u32' },    // offset into instance arena
    scatterCount:         { type: 'u32' },
    // Per-family counts (packed)
    treeCount:            { type: 'u32' },
    shrubCount:           { type: 'u32' },
    grassCount:           { type: 'u32' },
    rockCount:            { type: 'u32' },
    flowerCount:          { type: 'u32' },
    otherCount:           { type: 'u32' },
    // Biome and density
    dominantBiome:        { type: 'u32' },    // hash
    biomeTreeDensity:     { type: 'f32' },
    biomeShrubDensity:    { type: 'f32' },
    biomeGrassDensity:    { type: 'f32' },
    biomeRockDensity:     { type: 'f32' },
    // LOD
    currentLod:           { type: 'u8' },
    lodMaterialTier:      { type: 'u8' },
    // Lifecycle
    lastUpdatedTick:      { type: 'u32' },
    isDirty:              { type: 'u8' }
  };
}

/**
 * TerrainScatterInstanceComponent — bound to each scatter instance that
 * needs to be individually addressable (e.g. destructible trees).
 * Most instances only exist in the arena; this component is only bound when
 * the instance needs ECS-level tracking.
 */
export class TerrainScatterInstanceComponent {
  static schema = {
    tileKeyHash:          { type: 'u32' },
    instanceIndex:        { type: 'u32' },
    family:               { type: 'u8' },   // ScatterFamily.*
    shapeClass:           { type: 'u8' },   // ScatterShapeClass.*
    materialId:           { type: 'u16' },
    // Health / destruction
    isAlive:              { type: 'u8' },
    health:               { type: 'f32' },
    // Growth
    growthStage:          { type: 'f32' },  // 0 = seedling, 1 = mature
    // Lifecycle
    lastUpdatedTick:      { type: 'u32' }
  };
}

// ═════════════════════════════════════════════════════════════════════
// 3. SCATTER ARENA
// ═════════════════════════════════════════════════════════════════════

/**
 * ScatterInstanceArena — a shared Float32Array holding every scatter
 * instance's transformation matrix, colour, and per-instance uniforms.
 * Tiles carve contiguous ranges from this arena; ranges are freed when a
 * tile is evicted.
 *
 * Layout per instance (32 floats):
 *   [0..15]  – 4×4 transformation matrix (column-major)
 *   [16..18] – per-instance colour RGB
 *   [19]     – per-instance scale
 *   [20]     – per-instance rotation seed
 *   [21]     – family (as float)
 *   [22]     – shapeClass (as float)
 *   [23]     – lodLevel (as float)
 *   [24]     – variationSeed (as float)
 *   [25]     – health (as float)
 *   [26]     – growthStage (as float)
 *   [27..31] – reserved
 */
class ScatterInstanceArena {
  constructor(initialCapacity = 65536) {
    this.data = new Float32Array(initialCapacity);
    this.capacity = initialCapacity;
    this.used = 0;
    this.freeRanges = [];
  }

  alloc(count) {
    for (let i = 0; i < this.freeRanges.length; i++) {
      const r = this.freeRanges[i];
      if (r.size >= count) {
        const start = r.start;
        if (r.size === count) this.freeRanges.splice(i, 1);
        else { r.start += count; r.size -= count; }
        return start;
      }
    }
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

  clear() { this.used = 0; this.freeRanges.length = 0; }
  dispose() { this.data = null; this.freeRanges.length = 0; this.used = 0; this.capacity = 0; }
}

// ═════════════════════════════════════════════════════════════════════
// 4. SCATTER SPECIES REGISTRY
// ═════════════════════════════════════════════════════════════════════

/**
 * ScatterSpeciesDescriptor — the procedural recipe for a single species.
 * Everything is generated from these parameters at instance-creation time;
 * no mesh assets are loaded.
 */
export class ScatterSpeciesDescriptor {
  constructor(props) {
    this.id = props.id ?? 0;
    this.name = props.name ?? 'unnamed';
    this.family = props.family ?? ScatterFamily.GRASS;
    this.shapeClass = props.shapeClass ?? ScatterShapeClass.GRASS_TUFT;

    // ---- Environmental tolerances ----
    this.minElevation = props.minElevation ?? -10000;
    this.maxElevation = props.maxElevation ?? 10000;
    this.minSlope = props.minSlope ?? 0;
    this.maxSlope = props.maxSlope ?? 1;
    this.minMoisture = props.minMoisture ?? 0;
    this.maxMoisture = props.maxMoisture ?? 1;
    this.minTemperature = props.minTemperature ?? 0;
    this.maxTemperature = props.maxTemperature ?? 1;
    this.requiresWater = props.requiresWater ?? false;
    this.canFlood = props.canFlood ?? false;
    this.saltTolerance = props.saltTolerance ?? 0.5;

    // ---- Density ----
    this.baseDensity = props.baseDensity ?? 0.1;     // instances per m²
    this.maxDensity = props.maxDensity ?? 0.5;
    this.minSpacing = props.minSpacing ?? 1.0;       // Poisson-disk radius (m)

    // ---- Size ----
    this.minHeight = props.minHeight ?? 0.2;
    this.maxHeight = props.maxHeight ?? 5.0;
    this.minRadius = props.minRadius ?? 0.1;
    this.maxRadius = props.maxRadius ?? 1.0;

    // ---- Colours ----
    this.baseColor = props.baseColor ?? [0.3, 0.5, 0.2];
    this.seasonalColors = props.seasonalColors ?? null;

    // ---- Material ----
    this.materialFamily = props.materialFamily ?? 0;   // MaterialFamily3D.*

    // ---- Procedural shape parameters ----
    this.branchAngle = props.branchAngle ?? 30;
    this.branchCount = props.branchCount ?? 5;
    this.leafDensity = props.leafDensity ?? 0.7;
    this.trunkTaper = props.trunkTaper ?? 0.3;
    this.fractalIterations = props.fractalIterations ?? 3;

    // ---- Biome affinity ----
    this.biomeAffinity = props.biomeAffinity ?? new Map();

    // ---- Sensory ----
    this.acousticProfile = props.acousticProfile ?? null;
    this.lightProfile = props.lightProfile ?? null;
  }

  /**
   * Returns the affinity (0..1) for a given biome name.
   */
  affinityForBiome(biomeName) {
    if (this.biomeAffinity.has(biomeName)) return this.biomeAffinity.get(biomeName);
    return 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. THE SCATTER ENGINE
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainProceduralScatter3D — the procedural scatter engine.
 */
export class TerrainProceduralScatter3D {
  constructor(options = {}) {
    this.options = {
      // Frequency
      targetHz: options.targetHz ?? 10,

      // Grid resolution for placement sampling
      samplingResolution: options.samplingResolution ?? 32,

      // Per-tile instance caps
      maxInstancesPerTile: options.maxInstancesPerTile ?? 2048,
      maxInstancesTotal: options.maxInstancesTotal ?? 65536,

      // LOD-aware scatter density
      enableLODScatter: options.enableLODScatter ?? true,
      lodFullMaxLod: options.lodFullMaxLod ?? 2,
      lodReducedMaxLod: options.lodReducedMaxLod ?? 5,
      lodReducedScale: options.lodReducedScale ?? 0.4,
      lodCulledMaxLod: options.lodCulledMaxLod ?? 9,

      // Cache
      maxCachedTiles: options.maxCachedTiles ?? 512,
      cacheVersionTickInterval: options.cacheVersionTickInterval ?? 30,

      // Arena
      initialArenaCapacity: options.initialArenaCapacity ?? 65536,

      // Biome registry
      biomeRegistry: options.biomeRegistry ?? null,

      // Seasonality
      enableSeasonalColor: options.enableSeasonalColor ?? true,

      // Fauna influence
      enableFaunaScatter: options.enableFaunaScatter ?? true,

      // Diagnostics
      enableDiagnostics: options.enableDiagnostics ?? true,

      ...options
    };

    // ---- Arena ----
    this._arena = new ScatterInstanceArena(this.options.initialArenaCapacity);

    // ---- Per-tile state ----
    this._tileStates = new Map();     // tileKey → ScatterTileState
    this._cacheVersion = 1;

    // ---- Biome registry ----
    this._biomeRegistry = this.options.biomeRegistry ?? new BiomeRegistryBarrel();

    // ---- Species catalogue ----
    this._speciesCatalogue = this._buildSpeciesCatalogue();

    // ---- Noise for deterministic placement ----
    this._noise = new SimplexNoise({ seed: 0x53434154 }); // "SCAT"

    // ---- Gradient providers (lazy-init) ----
    this._forestGradient = null;
    this._grassGradient = null;
    this._rockGradient = null;
    this._cliffsGradient = null;
    this._reliefGradient = null;

    // ---- Context bindings ----
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.queryEngine = null;
    this.hydrology = null;
    this.materialBridge = null;
    this.lodFidelity = null;
    this.faunaMigration = null;
    this.dispatcher = null;
    this.lastTick = 0;
    this._accumulator = 0;

    // ---- Published SoA ----
    this._published = {
      tileKeys: [],
      instanceStarts: [],
      instanceCounts: [],
      treeCounts: [],
      shrubCounts: [],
      grassCounts: [],
      rockCounts: [],
      flowerCounts: [],
      otherCounts: [],
      count: 0
    };

    // ---- Diagnostics ----
    this.stats = {
      ticksProcessed: 0,
      tilesProcessed: 0,
      totalInstances: 0,
      treesPlaced: 0,
      shrubsPlaced: 0,
      grassPlaced: 0,
      rocksPlaced: 0,
      flowersPlaced: 0,
      cacheHits: 0,
      cacheMisses: 0,
      peakInstancesPerTile: 0,
      lastDurationMs: 0,
      arenaUsed: 0,
      arenaCapacity: 0
    };
  }

  // ---------------------------------------------------------------------
  // Species catalogue
  // ---------------------------------------------------------------------

  _buildSpeciesCatalogue() {
    const catalogue = new Map();

    // ---- Trees ----
    this._registerSpecies(catalogue, {
      id: 1, name: 'conifer_pine', family: ScatterFamily.TREE,
      shapeClass: ScatterShapeClass.CONIFER,
      minElevation: 0, maxElevation: 3000,
      minSlope: 0, maxSlope: 0.6,
      minMoisture: 0.3, maxMoisture: 1.0,
      minTemperature: 0.0, maxTemperature: 0.6,
      baseDensity: 0.08, maxDensity: 0.3, minSpacing: 3.0,
      minHeight: 4.0, maxHeight: 18.0, minRadius: 0.15, maxRadius: 0.4,
      baseColor: [0.12, 0.28, 0.10],
      materialFamily: 0,
      branchAngle: 45, branchCount: 6, leafDensity: 0.8, trunkTaper: 0.25,
      biomeAffinity: new Map([
        ['taiga_boreal_forest', 1.0],
        ['taiga_boreal_coniferous', 1.0],
        ['alpine', 0.6],
        ['temperate_deciduous_forest', 0.4]
      ])
    });

    this._registerSpecies(catalogue, {
      id: 2, name: 'deciduous_oak', family: ScatterFamily.TREE,
      shapeClass: ScatterShapeClass.DECIDUOUS,
      minElevation: 0, maxElevation: 1500,
      minSlope: 0, maxSlope: 0.5,
      minMoisture: 0.4, maxMoisture: 1.0,
      minTemperature: 0.3, maxTemperature: 0.8,
      baseDensity: 0.06, maxDensity: 0.25, minSpacing: 4.0,
      minHeight: 6.0, maxHeight: 20.0, minRadius: 0.2, maxRadius: 0.5,
      baseColor: [0.18, 0.38, 0.12],
      materialFamily: 0,
      branchAngle: 40, branchCount: 8, leafDensity: 0.75, trunkTaper: 0.3,
      biomeAffinity: new Map([
        ['temperate_deciduous_forest', 1.0],
        ['temperate_deciduous_forest_z07', 1.0],
        ['subtropical_humid_forest', 0.7],
        ['mediterranean_chaparral', 0.5]
      ])
    });

    this._registerSpecies(catalogue, {
      id: 3, name: 'tropical_hardwood', family: ScatterFamily.TREE,
      shapeClass: ScatterShapeClass.DECIDUOUS,
      minElevation: 0, maxElevation: 800,
      minSlope: 0, maxSlope: 0.4,
      minMoisture: 0.6, maxMoisture: 1.0,
      minTemperature: 0.7, maxTemperature: 1.0,
      baseDensity: 0.15, maxDensity: 0.4, minSpacing: 2.5,
      minHeight: 10.0, maxHeight: 35.0, minRadius: 0.2, maxRadius: 0.6,
      baseColor: [0.10, 0.35, 0.08],
      materialFamily: 0,
      branchAngle: 35, branchCount: 10, leafDensity: 0.9, trunkTaper: 0.2,
      biomeAffinity: new Map([
        ['tropical_rainforest', 1.0],
        ['temperate_rainforest', 0.8],
        ['subtropical_humid_forest', 0.9]
      ])
    });

    this._registerSpecies(catalogue, {
      id: 4, name: 'palm_tree', family: ScatterFamily.TREE,
      shapeClass: ScatterShapeClass.PALM,
      minElevation: -5, maxElevation: 200,
      minSlope: 0, maxSlope: 0.3,
      minMoisture: 0.5, maxMoisture: 1.0,
      minTemperature: 0.7, maxTemperature: 1.0,
      baseDensity: 0.05, maxDensity: 0.2, minSpacing: 5.0,
      minHeight: 5.0, maxHeight: 15.0, minRadius: 0.1, maxRadius: 0.25,
      baseColor: [0.20, 0.45, 0.10],
      materialFamily: 0,
      branchAngle: 60, branchCount: 8, leafDensity: 0.8, trunkTaper: 0.1,
      biomeAffinity: new Map([
        ['tropical_rainforest', 0.8],
        ['mangrove_coastal', 0.6],
        ['river_delta_estuary', 0.7]
      ])
    });

    // ---- Shrubs ----
    this._registerSpecies(catalogue, {
      id: 10, name: 'mediterranean_shrub', family: ScatterFamily.SHRUB,
      shapeClass: ScatterShapeClass.SHRUB,
      minElevation: 0, maxElevation: 1000,
      minSlope: 0, maxSlope: 0.7,
      minMoisture: 0.2, maxMoisture: 0.7,
      minTemperature: 0.4, maxTemperature: 0.9,
      baseDensity: 0.15, maxDensity: 0.5, minSpacing: 1.5,
      minHeight: 0.5, maxHeight: 2.0, minRadius: 0.3, maxRadius: 0.8,
      baseColor: [0.25, 0.35, 0.15],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['mediterranean_chaparral', 1.0],
        ['steppe_prairie', 0.5],
        ['grassland_savanna', 0.4]
      ])
    });

    this._registerSpecies(catalogue, {
      id: 11, name: 'desert_scrub', family: ScatterFamily.SHRUB,
      shapeClass: ScatterShapeClass.SHRUB,
      minElevation: 0, maxElevation: 2000,
      minSlope: 0, maxSlope: 0.6,
      minMoisture: 0.0, maxMoisture: 0.2,
      minTemperature: 0.5, maxTemperature: 1.0,
      baseDensity: 0.05, maxDensity: 0.15, minSpacing: 3.0,
      minHeight: 0.3, maxHeight: 1.5, minRadius: 0.2, maxRadius: 0.6,
      baseColor: [0.35, 0.30, 0.15],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['desert', 1.0],
        ['badlands_eroded_hills', 0.5],
        ['steppe_prairie', 0.3]
      ])
    });

    // ---- Grass ----
    this._registerSpecies(catalogue, {
      id: 20, name: 'meadow_grass', family: ScatterFamily.GRASS,
      shapeClass: ScatterShapeClass.GRASS_TUFT,
      minElevation: 0, maxElevation: 2500,
      minSlope: 0, maxSlope: 0.5,
      minMoisture: 0.3, maxMoisture: 0.9,
      minTemperature: 0.2, maxTemperature: 0.8,
      baseDensity: 0.8, maxDensity: 2.0, minSpacing: 0.15,
      minHeight: 0.05, maxHeight: 0.4, minRadius: 0.05, maxRadius: 0.15,
      baseColor: [0.30, 0.55, 0.15],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['grassland_savanna', 1.0],
        ['steppe_prairie', 1.0],
        ['temperate_deciduous_forest', 0.6],
        ['alpine', 0.7],
        ['flooding_pampa_grassland', 1.0]
      ])
    });

    // ---- Rocks ----
    this._registerSpecies(catalogue, {
      id: 30, name: 'limestone_rock', family: ScatterFamily.ROCK,
      shapeClass: ScatterShapeClass.ROCK_ANGULAR,
      minElevation: 0, maxElevation: 4000,
      minSlope: 0.2, maxSlope: 1.0,
      minMoisture: 0, maxMoisture: 0.5,
      baseDensity: 0.02, maxDensity: 0.1, minSpacing: 2.0,
      minHeight: 0.2, maxHeight: 1.5, minRadius: 0.2, maxRadius: 0.8,
      baseColor: [0.45, 0.42, 0.38],
      materialFamily: 0,
      fractalIterations: 3,
      biomeAffinity: new Map([
        ['alpine', 0.6],
        ['canyonlands', 1.0],
        ['badlands_eroded_hills', 1.0],
        ['desert', 0.5]
      ])
    });

    this._registerSpecies(catalogue, {
      id: 31, name: 'granite_boulder', family: ScatterFamily.BOULDER,
      shapeClass: ScatterShapeClass.BOULDER,
      minElevation: 0, maxElevation: 3000,
      minSlope: 0, maxSlope: 0.8,
      minMoisture: 0, maxMoisture: 0.5,
      baseDensity: 0.01, maxDensity: 0.05, minSpacing: 5.0,
      minHeight: 0.5, maxHeight: 3.0, minRadius: 0.5, maxRadius: 2.0,
      baseColor: [0.4, 0.4, 0.4],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['alpine', 1.0],
        ['taiga_boreal_forest', 0.5]
      ])
    });

    // ---- Flowers ----
    this._registerSpecies(catalogue, {
      id: 40, name: 'wildflower', family: ScatterFamily.FLOWER,
      shapeClass: ScatterShapeClass.FLOWER,
      minElevation: 0, maxElevation: 2500,
      minSlope: 0, maxSlope: 0.4,
      minMoisture: 0.4, maxMoisture: 0.9,
      minTemperature: 0.3, maxTemperature: 0.8,
      baseDensity: 0.3, maxDensity: 0.8, minSpacing: 0.4,
      minHeight: 0.05, maxHeight: 0.3, minRadius: 0.03, maxRadius: 0.08,
      baseColor: [0.9, 0.6, 0.2],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['alpine', 0.8],
        ['temperate_deciduous_forest', 0.6],
        ['grassland_savanna', 0.7],
        ['mediterranean_chaparral', 0.9]
      ])
    });

    // ---- Ferns ----
    this._registerSpecies(catalogue, {
      id: 50, name: 'forest_fern', family: ScatterFamily.FERN,
      shapeClass: ScatterShapeClass.FERN,
      minElevation: 0, maxElevation: 1500,
      minSlope: 0, maxSlope: 0.6,
      minMoisture: 0.6, maxMoisture: 1.0,
      minTemperature: 0.4, maxTemperature: 0.9,
      baseDensity: 0.2, maxDensity: 0.6, minSpacing: 0.8,
      minHeight: 0.2, maxHeight: 1.2, minRadius: 0.2, maxRadius: 0.6,
      baseColor: [0.15, 0.35, 0.10],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['tropical_rainforest', 0.9],
        ['temperate_rainforest', 0.9],
        ['wetland_marsh_swamp', 0.7]
      ])
    });

    // ---- Cactus ----
    this._registerSpecies(catalogue, {
      id: 60, name: 'saguaro_cactus', family: ScatterFamily.CACTUS,
      shapeClass: ScatterShapeClass.CACTUS,
      minElevation: 0, maxElevation: 1500,
      minSlope: 0, maxSlope: 0.5,
      minMoisture: 0.0, maxMoisture: 0.2,
      minTemperature: 0.6, maxTemperature: 1.0,
      baseDensity: 0.02, maxDensity: 0.08, minSpacing: 6.0,
      minHeight: 2.0, maxHeight: 8.0, minRadius: 0.15, maxRadius: 0.35,
      baseColor: [0.25, 0.45, 0.20],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['desert', 1.0]
      ])
    });

    // ---- Bamboo ----
    this._registerSpecies(catalogue, {
      id: 70, name: 'bamboo_cluster', family: ScatterFamily.BAMBOO,
      shapeClass: ScatterShapeClass.BAMBOO,
      minElevation: 0, maxElevation: 800,
      minSlope: 0, maxSlope: 0.5,
      minMoisture: 0.6, maxMoisture: 1.0,
      minTemperature: 0.6, maxTemperature: 0.9,
      baseDensity: 0.15, maxDensity: 0.5, minSpacing: 0.4,
      minHeight: 3.0, maxHeight: 12.0, minRadius: 0.03, maxRadius: 0.08,
      baseColor: [0.35, 0.50, 0.15],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['subtropical_humid_forest', 1.0],
        ['tropical_rainforest', 0.7]
      ])
    });

    // ---- Reeds ----
    this._registerSpecies(catalogue, {
      id: 80, name: 'water_reed', family: ScatterFamily.REED,
      shapeClass: ScatterShapeClass.GRASS_TUFT,
      minElevation: -5, maxElevation: 50,
      minSlope: 0, maxSlope: 0.2,
      minMoisture: 0.8, maxMoisture: 1.0,
      minTemperature: 0.3, maxTemperature: 0.9,
      requiresWater: true,
      canFlood: true,
      baseDensity: 0.4, maxDensity: 1.5, minSpacing: 0.2,
      minHeight: 0.5, maxHeight: 2.5, minRadius: 0.03, maxRadius: 0.06,
      baseColor: [0.30, 0.45, 0.15],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['wetland_marsh_swamp', 1.0],
        ['river_delta_estuary', 0.9],
        ['flooding_pampa_grassland', 0.6]
      ])
    });

    // ---- Mushrooms ----
    this._registerSpecies(catalogue, {
      id: 90, name: 'forest_mushroom', family: ScatterFamily.MUSHROOM,
      shapeClass: ScatterShapeClass.MUSHROOM,
      minElevation: 0, maxElevation: 2000,
      minSlope: 0, maxSlope: 0.4,
      minMoisture: 0.7, maxMoisture: 1.0,
      minTemperature: 0.3, maxTemperature: 0.7,
      baseDensity: 0.05, maxDensity: 0.2, minSpacing: 1.0,
      minHeight: 0.05, maxHeight: 0.25, minRadius: 0.05, maxRadius: 0.15,
      baseColor: [0.7, 0.3, 0.2],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['temperate_deciduous_forest', 0.8],
        ['taiga_boreal_forest', 0.7],
        ['temperate_rainforest', 0.6]
      ])
    });

    // ---- Deadwood ----
    this._registerSpecies(catalogue, {
      id: 100, name: 'fallen_log', family: ScatterFamily.DEADWOOD,
      shapeClass: ScatterShapeClass.DEADWOOD_LOG,
      minElevation: 0, maxElevation: 2500,
      minSlope: 0, maxSlope: 0.5,
      minMoisture: 0.3, maxMoisture: 1.0,
      minTemperature: 0.2, maxTemperature: 0.8,
      baseDensity: 0.01, maxDensity: 0.05, minSpacing: 8.0,
      minHeight: 0.2, maxHeight: 0.6, minRadius: 0.15, maxRadius: 0.4,
      baseColor: [0.25, 0.18, 0.10],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['temperate_deciduous_forest', 0.6],
        ['taiga_boreal_forest', 0.8],
        ['tropical_rainforest', 0.4]
      ])
    });

    // ---- Debris ----
    this._registerSpecies(catalogue, {
      id: 110, name: 'rock_debris', family: ScatterFamily.DEBRIS,
      shapeClass: ScatterShapeClass.DEBRIS_CHUNK,
      minElevation: 0, maxElevation: 4000,
      minSlope: 0.3, maxSlope: 1.0,
      minMoisture: 0, maxMoisture: 0.5,
      baseDensity: 0.05, maxDensity: 0.2, minSpacing: 0.5,
      minHeight: 0.05, maxHeight: 0.3, minRadius: 0.05, maxRadius: 0.2,
      baseColor: [0.4, 0.38, 0.35],
      materialFamily: 0,
      biomeAffinity: new Map([
        ['alpine', 0.8],
        ['canyonlands', 1.0],
        ['badlands_eroded_hills', 1.0]
      ])
    });

    return catalogue;
  }

  _registerSpecies(catalogue, props) {
    const descriptor = new ScatterSpeciesDescriptor(props);
    catalogue.set(props.id, descriptor);
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  bind(contextFrame, ecsWorld, source, queryEngine, hydrology, materialBridge, lodFidelity, faunaMigration, eventDispatcher = null) {
    this.frame = contextFrame;
    this.ecsWorld = ecsWorld;
    this.source = source;
    this.queryEngine = queryEngine;
    this.hydrology = hydrology;
    this.materialBridge = materialBridge;
    this.lodFidelity = lodFidelity;
    this.faunaMigration = faunaMigration;
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

    // 1. Bump cache version periodically.
    if (tick % this.options.cacheVersionTickInterval === 0) {
      this._cacheVersion++;
    }

    // 2. Read context state.
    const temporal = contextFrame?.layers?.temporal;
    const physical = contextFrame?.layers?.physical;

    const weatherSeverity = temporal?.weatherSeverity ?? 0;
    const timeOfDay = temporal?.timeOfDay ?? 0.5;
    const season = temporal?.season ?? 0.5;
    const temperature = physical?.temperature ?? 0.5;
    const precipitation = physical?.precipitation ?? 0.5;
    const moisture = physical?.moisture ?? 0.5;

    // 3. Reset published.
    this._resetPublished();

    // 4. Process each visible tile.
    const visibleSet = new Set();
    for (const h of visibleHeaders) {
      if (h.state !== TileState.READY) continue;
      visibleSet.add(h.tileKey);

      const record = this.source?.tileMap?.get(h.tileKey);
      if (!record) continue;
      const terrain = record.terrainObject ?? record.terrain;
      if (!terrain) continue;

      // Get the LOD resolution for this tile.
      const lodRes = this.lodFidelity?.getResolution(h.tileKey) ?? null;
      const currentLod = lodRes?.currentLod ?? h.lod;

      // Skip tiles that are too far to scatter.
      if (this.options.enableLODScatter && currentLod > this.options.lodCulledMaxLod) {
        continue;
      }

      // Check the cache.
      let state = this._tileStates.get(h.tileKey);
      const cachedVersion = state?.cacheVersion ?? -1;
      if (state && cachedVersion === this._cacheVersion &&
          state.currentLod === currentLod) {
        this.stats.cacheHits++;
        this._publishTile(state, h);
        continue;
      }
      this.stats.cacheMisses++;

      // Generate (or regenerate) the scatter for this tile.
      if (!state) {
        state = new ScatterTileState(h.tileKey);
        this._tileStates.set(h.tileKey, state);
      }
      state.reset();
      state.cacheVersion = this._cacheVersion;
      state.currentLod = currentLod;

      this._scatterTile(state, terrain, h, currentLod, {
        weatherSeverity, timeOfDay, season,
        temperature, precipitation, moisture
      }, tick);

      // Publish.
      this._publishTile(state, h);
    }

    // 5. Upload to arena.
    this._uploadToArena();

    // 6. Publish to physical channel.
    this._publishToPhysicalChannel();

    // 7. Evict stale.
    this._evictStale(visibleSet);

    // 8. Stats.
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.stats.lastDurationMs = t1 - t0;
    this.stats.ticksProcessed++;
    this.stats.arenaUsed = this._arena.used;
    this.stats.arenaCapacity = this._arena.capacity;
  }

  // ---------------------------------------------------------------------
  // Per-tile scatter
  // ---------------------------------------------------------------------

  _scatterTile(state, terrain, header, lod, context, tick) {
    const res = this.options.samplingResolution;
    const cellSize = (terrain.tileWorldSize ?? 100) / res;

    // ---- 1. Sample the terrain grid at the sampling resolution ----
    const heights = new Float32Array(res * res);
    const slopes = new Float32Array(res * res);
    const normals = new Float32Array(res * res * 3);
    const moistureGrid = new Float32Array(res * res);

    this._sampleTerrainGrid(terrain, res, heights, slopes, normals, moistureGrid, context);

    // ---- 2. Determine the dominant biome ----
    const biomeName = this._resolveDominantBiome(terrain, header);
    const biomeDescriptor = this._biomeRegistry.get?.(biomeName) ?? null;

    // ---- 3. Get the LOD scatter scale ----
    const lodScale = this._lodScatterScale(lod);

    // ---- 4. Iterate species and place instances ----
    for (const [speciesId, species] of this._speciesCatalogue) {
      // Skip species that don't grow in this biome.
      const affinity = species.affinityForBiome(biomeName);
      if (affinity < 0.1) continue;

      // Compute the effective density for this LOD.
      const effectiveDensity = species.baseDensity * affinity * lodScale;
      if (effectiveDensity < 0.001) continue;

      // Poisson-disk placement.
      const placed = this._poissonDiskPlacement(
        state, species, res, cellSize, heights, slopes, normals,
        moistureGrid, terrain, header, effectiveDensity, context, tick
      );
    }

    // ---- 5. Hydrological scatter ----
    if (this.hydrology) {
      this._scatterHydrological(state, terrain, header, res, cellSize, heights, context, tick);
    }

    // ---- 6. Fauna-driven scatter ----
    if (this.options.enableFaunaScatter && this.faunaMigration) {
      this._scatterFauna(state, terrain, header, res, cellSize, heights, context, tick);
    }

    // ---- 7. Compute per-family counts ----
    this._computeFamilyCounts(state);

    // ---- 8. Record stats ----
    state.lastUpdatedTick = tick;
    this.stats.tilesProcessed++;
    this.stats.peakInstancesPerTile = Math.max(
      this.stats.peakInstancesPerTile, state.instanceCount
    );
  }

  // ---------------------------------------------------------------------
  // Terrain grid sampling
  // ---------------------------------------------------------------------

  _sampleTerrainGrid(terrain, res, heights, slopes, normals, moistureGrid, context) {
    const cellSize = (terrain.tileWorldSize ?? 100) / (res - 1);
    const originX = terrain.originX ?? (terrain.bounds ? terrain.bounds[0] : 0);
    const originY = terrain.originY ?? (terrain.bounds ? terrain.bounds[1] : 0);

    const normalOut = new Float64Array(3);

    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const i = y * res + x;
        const wx = originX + x * cellSize;
        const wy = originY + y * cellSize;

        // Height.
        let h = 0;
        if (terrain instanceof HeightmapTerrain) {
          h = terrain.getHeight(wx, wy);
        } else if (this.queryEngine) {
          h = this.queryEngine.getHeight(wx, wy);
        }
        if (isNaN(h)) h = 0;
        heights[i] = h;

        // Normal.
        if (terrain instanceof HeightmapTerrain) {
          terrain.getNormal(wx, wy, normalOut);
        } else if (this.queryEngine) {
          this.queryEngine.getNormal(wx, wy, normalOut);
        } else {
          normalOut[0] = 0; normalOut[1] = 0; normalOut[2] = 1;
        }
        normals[i * 3] = normalOut[0];
        normals[i * 3 + 1] = normalOut[1];
        normals[i * 3 + 2] = normalOut[2];

        // Slope.
        slopes[i] = 1 - normalOut[1];

        // Moisture: from context.
        moistureGrid[i] = context.moisture;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Poisson-disk placement
  // ---------------------------------------------------------------------

  _poissonDiskPlacement(state, species, res, cellSize, heights, slopes, normals,
                        moistureGrid, terrain, header, density, context, tick) {
    const originX = terrain.originX ?? (terrain.bounds ? terrain.bounds[0] : 0);
    const originY = terrain.originY ?? (terrain.bounds ? terrain.bounds[1] : 0);

    // Calculate how many instances to attempt.
    const tileArea = (terrain.tileWorldSize ?? 100) ** 2;
    const attempts = Math.min(
      Math.floor(tileArea * density / (species.minSpacing * species.minSpacing)),
      this.options.maxInstancesPerTile
    );

    // Grid for Poisson-disk rejection.
    const gridSize = Math.ceil(res);
    const placed = [];

    for (let a = 0; a < attempts; a++) {
      // Deterministic pseudo-random position from the noise.
      const seed = this._noise.noise2D(
        (a + species.id * 1000) * 0.1,
        (header.tileKeyHash ?? 0) * 0.001
      );
      const seed2 = this._noise.noise2D(
        (a + species.id * 1000 + 500) * 0.1,
        (header.tileKeyHash ?? 0) * 0.001 + 500
      );

      const gx = Math.floor((seed * 0.5 + 0.5) * res);
      const gy = Math.floor((seed2 * 0.5 + 0.5) * res);
      if (gx < 0 || gx >= res || gy < 0 || gy >= res) continue;

      const cellIdx = gy * res + gx;

      // Check tolerances.
      const h = heights[cellIdx];
      const s = slopes[cellIdx];
      const m = moistureGrid[cellIdx];

      if (h < species.minElevation || h > species.maxElevation) continue;
      if (s < species.minSlope || s > species.maxSlope) continue;
      if (m < species.minMoisture || m > species.maxMoisture) continue;
      if (context.temperature < species.minTemperature ||
          context.temperature > species.maxTemperature) continue;

      // Check water requirement.
      if (species.requiresWater && this.hydrology) {
        const state = this.hydrology.getTileState(header.tileKey);
        if (!state) continue;
        const localX = gx / res;
        const localY = gy / res;
        const depth = this.hydrology.getWaterDepthAt(header.tileKey, localX, localY);
        if (depth < 0.1) continue;
      }

      // Poisson-disk rejection.
      const wx = originX + gx * cellSize;
      const wy = originY + gy * cellSize;
      let tooClose = false;
      for (const p of placed) {
        const dx = p.wx - wx;
        const dy = p.wy - wy;
        if (dx * dx + dy * dy < species.minSpacing * species.minSpacing) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      // Build the instance.
      const instance = this._buildInstance(
        species, wx, wy, h, s, normals, cellIdx, context, seed, seed2
      );

      state.addInstance(instance);
      placed.push({ wx, wy });

      this._incrementFamilyCount(species.family);
    }
  }

  // ---------------------------------------------------------------------
  // Instance construction
  // ---------------------------------------------------------------------

  _buildInstance(species, wx, wy, wz, slope, normals, cellIdx, context, seed, seed2) {
    // Compute the per-instance matrix.
    const scale = species.minHeight + (seed * 0.5 + 0.5) * (species.maxHeight - species.minHeight);
    const radius = species.minRadius + (seed2 * 0.5 + 0.5) * (species.maxRadius - species.minRadius);
    const rotation = (seed2 * 0.5 + 0.5) * Math.PI * 2;

    // Build the matrix.
    const matrix = new Float32Array(16);
    this._composeMatrix(matrix, wx, wy, wz, rotation, radius, scale);

    // Compute the colour.
    let color = species.baseColor.slice();
    if (this.options.enableSeasonalColor && species.seasonalColors) {
      const seasonal = species.seasonalColors;
      const s = context.season;
      if (s < 0.25) color = seasonal.winter ?? color;
      else if (s < 0.5) color = seasonal.spring ?? color;
      else if (s < 0.75) color = seasonal.summer ?? color;
      else color = seasonal.autumn ?? color;
    }

    // Compute the variation seed.
    const variationSeed = Math.abs(this._noise.noise2D(wx * 0.1, wy * 0.1));

    return {
      matrix,
      color,
      scale,
      radius,
      rotation,
      family: species.family,
      shapeClass: species.shapeClass,
      materialId: 0,
      variationSeed,
      health: 1.0,
      growthStage: 0.5 + seed * 0.5,
      speciesId: species.id
    };
  }

  _composeMatrix(out, x, y, z, rotation, radius, height) {
    // Simple matrix: uniform scale, rotation around Y, translation.
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);

    // Column 0
    out[0] = c * radius;
    out[1] = 0;
    out[2] = -s * radius;
    out[3] = 0;

    // Column 1
    out[4] = 0;
    out[5] = height;
    out[6] = 0;
    out[7] = 0;

    // Column 2
    out[8] = s * radius;
    out[9] = 0;
    out[10] = c * radius;
    out[11] = 0;

    // Column 3
    out[12] = x;
    out[13] = y + height * 0.5;
    out[14] = z;
    out[15] = 1;
  }

  // ---------------------------------------------------------------------
  // Hydrological scatter
  // ---------------------------------------------------------------------

  _scatterHydrological(state, terrain, header, res, cellSize, heights, context, tick) {
    const hydrologyState = this.hydrology.getTileState(header.tileKey);
    if (!hydrologyState) return;

    const originX = terrain.originX ?? 0;
    const originY = terrain.originY ?? 0;

    // Place reeds along river banks.
    const reedSpecies = this._speciesCatalogue.get(80);
    if (reedSpecies) {
      for (const river of hydrologyState.riverSegments) {
        if (river.strahlerOrder < 2) continue;

        // Place a reed cluster at the river's midpoint.
        const mx = (river.startX + river.endX) * 0.5;
        const my = (river.startY + river.endY) * 0.5;
        const mz = this.queryEngine?.getHeight(mx, my) ?? 0;

        const instance = this._buildInstance(
          reedSpecies, mx, my, mz, 0, [0, 1, 0], 0, context, 0.5, 0.5
        );
        state.addInstance(instance);
        this._incrementFamilyCount(ScatterFamily.REED);
      }
    }

    // Place lilies on lakes.
    for (const lake of hydrologyState.lakes) {
      if (lake.cellCount < 10) continue;

      // Pick a random cell in the lake.
      const cellIdx = lake.cells[Math.floor(lake.cells.length * 0.5)];
      const gx = cellIdx % res;
      const gy = (cellIdx / res) | 0;
      const wx = originX + gx * cellSize;
      const wy = originY + gy * cellSize;
      const wz = heights[cellIdx];

      // Place a lily pad.
      const lilySpecies = this._speciesCatalogue.get(20); // reuse grass
      if (lilySpecies) {
        const instance = this._buildInstance(
          lilySpecies, wx, wy, wz, 0, [0, 1, 0], cellIdx, context, 0.5, 0.5
        );
        state.addInstance(instance);
        this._incrementFamilyCount(ScatterFamily.GRASS);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Fauna-driven scatter
  // ---------------------------------------------------------------------

  _scatterFauna(state, terrain, header, res, cellSize, heights, context, tick) {
    // Use the fauna migration system to find corridors in this tile.
    // (The fauna system exposes a query API; here we call it defensively.)
    if (!this.faunaMigration.getCorridors) return;

    const corridors = this.faunaMigration.getCorridors(header.tileKey) ?? [];
    const originX = terrain.originX ?? 0;
    const originY = terrain.originY ?? 0;

    for (const corridor of corridors) {
      const wx = corridor.x ?? originX + corridor.localX * cellSize;
      const wy = corridor.y ?? originY + corridor.localY * cellSize;
      const wz = this.queryEngine?.getHeight(wx, wy) ?? 0;

      // Trampled grass along the corridor.
      const trampledGrass = this._speciesCatalogue.get(20);
      if (trampledGrass) {
        const instance = this._buildInstance(
          trampledGrass, wx, wy, wz, 0, [0, 1, 0], 0, context, 0.3, 0.3
        );
        instance.growthStage = 0.2; // trampled
        instance.color = [0.35, 0.30, 0.15]; // brown
        state.addInstance(instance);
        this._incrementFamilyCount(ScatterFamily.GRASS);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Family counts
  // ---------------------------------------------------------------------

  _computeFamilyCounts(state) {
    state.treeCount = 0;
    state.shrubCount = 0;
    state.grassCount = 0;
    state.rockCount = 0;
    state.flowerCount = 0;
    state.otherCount = 0;

    for (const inst of state.instances) {
      switch (inst.family) {
        case ScatterFamily.TREE:   state.treeCount++; break;
        case ScatterFamily.SHRUB:  state.shrubCount++; break;
        case ScatterFamily.GRASS:  state.grassCount++; break;
        case ScatterFamily.ROCK:
        case ScatterFamily.BOULDER: state.rockCount++; break;
        case ScatterFamily.FLOWER: state.flowerCount++; break;
        default:                   state.otherCount++; break;
      }
    }
  }

  _incrementFamilyCount(family) {
    switch (family) {
      case ScatterFamily.TREE:   this.stats.treesPlaced++; break;
      case ScatterFamily.SHRUB:  this.stats.shrubsPlaced++; break;
      case ScatterFamily.GRASS:
      case ScatterFamily.REED:   this.stats.grassPlaced++; break;
      case ScatterFamily.ROCK:
      case ScatterFamily.BOULDER: this.stats.rocksPlaced++; break;
      case ScatterFamily.FLOWER: this.stats.flowersPlaced++; break;
    }
  }

  // ---------------------------------------------------------------------
  // Biome resolution
  // ---------------------------------------------------------------------

  _resolveDominantBiome(terrain, header) {
    // The material bridge publishes the dominant material; we could map
    // that to a biome. For now, use the terrain's dominantBiomeName if set.
    if (terrain.dominantBiomeName) return terrain.dominantBiomeName;

    // Fallback: pick from elevation.
    const avgH = (terrain.minElevation + terrain.maxElevation) * 0.5;
    if (avgH > 2500) return 'alpine';
    if (avgH > 1500) return 'taiga_boreal_forest';
    if (avgH > 500) return 'temperate_deciduous_forest';
    if (avgH > 100) return 'grassland_savanna';
    return 'desert';
  }

  _lodScatterScale(lod) {
    if (!this.options.enableLODScatter) return 1.0;
    if (lod <= this.options.lodFullMaxLod) return 1.0;
    if (lod <= this.options.lodReducedMaxLod) return this.options.lodReducedScale;
    return 0;
  }

  // ---------------------------------------------------------------------
  // Arena upload
  // ---------------------------------------------------------------------

  _uploadToArena() {
    for (const [tileKey, state] of this._tileStates) {
      if (state.instanceCount === 0) continue;

      // Free old range.
      if (state.scatterStart > 0) {
        this._arena.free(state.scatterStart, state.instanceCount * 32);
      }

      // Allocate fresh.
      const totalFloats = state.instanceCount * 32;
      state.scatterStart = this._arena.alloc(totalFloats);

      // Copy each instance.
      const data = this._arena.data;
      for (let i = 0; i < state.instanceCount; i++) {
        const inst = state.instances[i];
        const base = state.scatterStart + i * 32;

        // Matrix (16 floats).
        for (let k = 0; k < 16; k++) data[base + k] = inst.matrix[k];

        // Colour.
        data[base + 16] = inst.color[0];
        data[base + 17] = inst.color[1];
        data[base + 18] = inst.color[2];

        // Per-instance uniforms.
        data[base + 19] = inst.scale;
        data[base + 20] = inst.rotation;
        data[base + 21] = inst.family;
        data[base + 22] = inst.shapeClass;
        data[base + 23] = state.currentLod;
        data[base + 24] = inst.variationSeed;
        data[base + 25] = inst.health;
        data[base + 26] = inst.growthStage;
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
    p.treeCounts.length = 0;
    p.shrubCounts.length = 0;
    p.grassCounts.length = 0;
    p.rockCounts.length = 0;
    p.flowerCounts.length = 0;
    p.otherCounts.length = 0;
    p.count = 0;
  }

  _publishTile(state, header) {
    const p = this._published;
    p.tileKeys.push(header.tileKey);
    p.instanceStarts.push(state.scatterStart);
    p.instanceCounts.push(state.instanceCount);
    p.treeCounts.push(state.treeCount);
    p.shrubCounts.push(state.shrubCount);
    p.grassCounts.push(state.grassCount);
    p.rockCounts.push(state.rockCount);
    p.flowerCounts.push(state.flowerCount);
    p.otherCounts.push(state.otherCount);
    p.count++;
  }

  _publishToPhysicalChannel() {
    if (!this.frame?.layers?.physical) return;
    const physical = this.frame.layers.physical;
    const p = this._published;

    physical.scatterTileKeys = p.tileKeys;
    physical.scatterInstanceStarts = p.instanceStarts;
    physical.scatterInstanceCounts = p.instanceCounts;
    physical.scatterTreeCounts = p.treeCounts;
    physical.scatterShrubCounts = p.shrubCounts;
    physical.scatterGrassCounts = p.grassCounts;
    physical.scatterRockCounts = p.rockCounts;
    physical.scatterFlowerCounts = p.flowerCounts;
    physical.scatterOtherCounts = p.otherCounts;
    physical.scatterArena = this._arena.data;
    physical.scatterStats = this.getStats();
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
      if (state && state.scatterStart > 0) {
        this._arena.free(state.scatterStart, state.instanceCount * 32);
      }
      this._tileStates.delete(tileKey);
    }
  }

  // ---------------------------------------------------------------------
  // Public queries
  // ---------------------------------------------------------------------

  getTileScatter(tileKey) {
    return this._tileStates.get(tileKey) ?? null;
  }

  getInstanceCount(tileKey) {
    return this._tileStates.get(tileKey)?.instanceCount ?? 0;
  }

  getArena() {
    return this._arena.data;
  }

  getSpeciesById(id) {
    return this._speciesCatalogue.get(id) ?? null;
  }

  getStats() {
    return {
      ...this.stats,
      cachedTiles: this._tileStates.size,
      arenaUsed: this._arena.used,
      arenaCapacity: this._arena.capacity,
      speciesCount: this._speciesCatalogue.size,
      cacheVersion: this._cacheVersion
    };
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  clear() {
    for (const state of this._tileStates.values()) {
      if (state.scatterStart > 0) {
        this._arena.free(state.scatterStart, state.instanceCount * 32);
      }
    }
    this._tileStates.clear();
    this._arena.clear();
    this._resetPublished();
  }

  dispose() {
    this.clear();
    this._arena.dispose();
    this._speciesCatalogue.clear();
    this.frame = null;
    this.ecsWorld = null;
    this.source = null;
    this.queryEngine = null;
    this.hydrology = null;
    this.materialBridge = null;
    this.lodFidelity = null;
    this.faunaMigration = null;
    this.dispatcher = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. PER-TILE SCATTER STATE
// ═════════════════════════════════════════════════════════════════════

/**
 * ScatterTileState — the per-tile scatter state. Stores the instance list
 * and the aggregate counts.
 */
class ScatterTileState {
  constructor(tileKey) {
    this.tileKey = tileKey;
    this.instances = [];
    this.instanceCount = 0;

    // Per-family counts.
    this.treeCount = 0;
    this.shrubCount = 0;
    this.grassCount = 0;
    this.rockCount = 0;
    this.flowerCount = 0;
    this.otherCount = 0;

    // LOD.
    this.currentLod = 0;

    // Arena range.
    this.scatterStart = 0;

    // Cache.
    this.cacheVersion = 0;
    this.lastUpdatedTick = 0;
  }

  addInstance(instance) {
    this.instances.push(instance);
    this.instanceCount++;
  }

  reset() {
    this.instances.length = 0;
    this.instanceCount = 0;
    this.treeCount = 0;
    this.shrubCount = 0;
    this.grassCount = 0;
    this.rockCount = 0;
    this.flowerCount = 0;
    this.otherCount = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 7. FACTORY
// ═════════════════════════════════════════════════════════════════════

export function createTerrainProceduralScatter3D(options = {}) {
  return new TerrainProceduralScatter3D({
    targetHz: options.targetHz ?? 10,
    samplingResolution: options.samplingResolution ?? 32,
    maxInstancesPerTile: options.maxInstancesPerTile ?? 2048,
    maxInstancesTotal: options.maxInstancesTotal ?? 65536,
    enableLODScatter: options.enableLODScatter ?? true,
    lodFullMaxLod: options.lodFullMaxLod ?? 2,
    lodReducedMaxLod: options.lodReducedMaxLod ?? 5,
    lodReducedScale: options.lodReducedScale ?? 0.4,
    lodCulledMaxLod: options.lodCulledMaxLod ?? 9,
    maxCachedTiles: options.maxCachedTiles ?? 512,
    cacheVersionTickInterval: options.cacheVersionTickInterval ?? 30,
    initialArenaCapacity: options.initialArenaCapacity ?? 65536,
    biomeRegistry: options.biomeRegistry ?? null,
    enableSeasonalColor: options.enableSeasonalColor ?? true,
    enableFaunaScatter: options.enableFaunaScatter ?? true,
    enableDiagnostics: options.enableDiagnostics ?? true,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 8. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  TerrainProceduralScatter3D,
  TerrainScatterTileComponent,
  TerrainScatterInstanceComponent,
  ScatterInstanceArena,
  ScatterSpeciesDescriptor,
  ScatterTileState,
  ScatterFamily,
  ScatterPlacementStrategy,
  ScatterShapeClass,
  createTerrainProceduralScatter3D
};