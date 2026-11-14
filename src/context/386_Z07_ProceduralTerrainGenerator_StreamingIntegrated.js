// file number : 386_Z07
// full path name : src/context/386_Z07_ProceduralTerrainGenerator_StreamingIntegrated.js
//### Description : Final streaming-integration layer for the ProceduralTerrain
//###               Generator lineage (files 386, 386_Z01–386_Z06). This file
//###               fulfils the remaining behavioural requirements of the
//###               src/context catalogue by:
//###                 • Making BiomeRegistryBarrel (327) the single authoritative
//###                   lookup for every biome descriptor.
//###                 • Coordinating LandscapeChunkDescriptor (336),
//###                   LandscapeChunkStreamer (337), LandscapeChunkHLOD (338),
//###                   LandscapeChunkSpatialHash (339),
//###                   LandscapeChunkOcclusion (340), and
//###                   LandscapeChunkPersistence (341) into one
//###                   TerrainStreamingManager.
//###                 • Exposing allocation-free spatial queries that leverage
//###                   the spatial hash, frustum culling, and occlusion graph.
//###                 • Bridging terrain state (deformations, ecology responses)
//###                   into the persistence layer so a destroyed world remains
//###                   destroyed across sessions.
//###               No external loader, no CDN access, no static server. Designed
//###               for Android arm64 under the 8 ms per-tick CPU ceiling and
//###               200 MB resident memory cap.
//### Best for : Worlds that must actually stream and persist terrain in real
//###            time. Use createStreamingIntegratedTerrainGenerator() for a
//###            turnkey instance, or installStreamingIntegratedExtensions() to
//###            upgrade an existing generator in place.
//### License : MIT

import {
  Vec2, Vec3, Vec4, Mat4, Quat, SimplexNoise, Precision, DoubleDouble,
  BufferAttribute, BufferGeometry, Ray, Plane, Sphere, Box3, Frustum,
  MeshStandardMaterial, MeshPhysicalMaterial, MeshToonMaterial,
  MeshStandardNodeMaterial, MeshPhysicalNodeMaterial, MeshToonNodeMaterial,
  Texture, DataTexture, Data3DTexture, DataArrayTexture, CanvasTexture
} from './264_MathECSImportBarrel.js';

import { ContextFrame } from './263_ContextFrame.js';
import { CoreEventDispatcher, EVENT_TYPE, EVENT_NAMES } from './265_CoreEventDispatcher.js';
import { CoreLayers, LAYER, LAYER_MASKS } from './266_CoreLayers.js';
import { CoreClock, TIER, TIER_PERIOD } from './267_CoreClock.js';
import { smoothstep } from './268_ExtrasCurveUtils.js';
import { LODHelper } from './269_ExtrasLODHelper.js';
import { TimerUtils } from './270_ExtrasTimerUtils.js';

// ─── Spatial acceleration (271–274) ──────────────────────────────────
import { SpatialHashGrid } from './271_SpatialHashGrid.js';
import { DynamicBVH } from './272_DynamicBVH.js';
import { FrustumCullingSystem } from './273_FrustumCullingSystem.js';
import { OcclusionGraph } from './274_OcclusionGraph.js';

// ─── Context providers (275–279) ─────────────────────────────────────
import { SpatialContextProvider } from './275_SpatialContextProvider.js';
import { TemporalContextProvider, WEATHER } from './276_TemporalContextProvider.js';
import { PhysicalContextProvider } from './277_PhysicalContextProvider.js';
import { CausalContextProvider, DERIVED_SIGNAL } from './278_CausalContextProvider.js';
import { PlayerContextProvider } from './279_PlayerContextProvider.js';

// ─── Terrain providers (280–282) ─────────────────────────────────────
import { TerrainProvider, BIOME_HINT } from './280_TerrainProvider.js';
import { ElevationProvider, ELEVATION_BAND } from './281_ElevationProvider.js';
import { SlopeGradientProvider, SLOPE_BAND } from './282_SlopeGradientProvider.js';
import { ReliefGradientProvider, RELIEF_CLASS } from './282_Z01_ReliefGradientProvider.js';
import { CliffsGradientProvider, CLIFF_CLASS } from './282_Z02_CliffsGradientProvider.js';
import { CarveGradientProvider, CARVE_TYPE } from './282_Z03_CarveGradientProvider.js';
import { NaturalFormationGradientProvider, FORMATION_TYPE } from './282_Z04_NaturalFormationGradientProvider.js';
import { RockGradientProvider, ROCK_CLASS } from './282_Z06_RockGradientProvider.js';
import { ForestGradientProvider, TREE_TYPE, SUCCESSION } from './282_Z07_ForestGradientProvider.js';
import { GrassAndFlowresGradientProvider, GRASS_TYPE } from './282_Z08_GrassAndFlowresGradientProvider.js';
import { ContinentalReliefGradientProvider, CONTINENTAL_TYPE } from './282_Z09_ContinentalReliefGradientProvider.js';

// ─── Environmental providers (283–296) ───────────────────────────────
import { BathymetryProvider, BATHY_ZONE, SEABED_CLASS } from './283_BathymetryProvider.js';
import { GroundwaterProvider, GROUNDWATER_TYPE } from './284_GroundwaterProvider.js';
import { MoistureLevelProvider, MOISTURE_STATE } from './285_MoistureLevelProvider.js';
import { DecomposersSystem, DECOMPOSER_TYPE } from './286_DecomposersSystem.js';
import { ClimateTemperatureProvider } from './287_ClimateTemperatureProvider.js';
import { ClimatePrecipitationProvider, PRECIPITATION_PHASE } from './288_ClimatePrecipitationProvider.js';
import { ClimateWindProvider, WIND_STATE } from './289_ClimateWindProvider.js';
import { SoilCompositionProvider, SOIL_TEXTURE_CLASS } from './290_SoilCompositionProvider.js';
import { SoilFertilityProvider, FERTILITY_CLASS } from './291_SoilFertilityProvider.js';
import { SoilColorTextureProvider, SOIL_VISUAL_ARCHETYPE } from './292_SoilColorTextureProvider.js';
import { LightingSunIntensityProvider } from './293_LightingSunIntensityProvider.js';
import { LightingTimeOfDayProvider } from './294_LightingTimeOfDayProvider.js';
import { AirQualityAtmosphereProvider } from './295_AirQualityAtmosphereProvider.js';
import { SeasonalitySystem, PHENOLOGY_STAGE, SEASONAL_MATERIAL } from './296_SeasonalitySystem.js';

// ─── Sensory emission (297, 317) ─────────────────────────────────────
import { SensoryDetailsProvider, ACOUSTIC_PROFILE } from './297_SensoryDetailsProvider.js';
import { AudioLightEmissionSystem, AUDIO_CUE_TYPE, LIGHT_CUE_TYPE } from './317_AudioLightEmissionSystem.js';

// ─── Performance governance (303–307) ────────────────────────────────
import { HLODController } from './303_HLODController.js';
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ─── Context runtime (308–310) ───────────────────────────────────────
import { ContextConsumerTiers } from './308_ContextConsumerTiers.js';
import { ContextRuntime } from './309_ContextRuntime.js';
import { GeometryContextFrameReader } from './310_GeometryContextFrameReader.js';

// ─── Consumer systems (311–316) ──────────────────────────────────────
import { UpdateLODConsumer } from './311_UpdateLODConsumer.js';
import { UpdateLoadStateConsumer } from './312_UpdateLoadStateConsumer.js';
import { IsVisibleConsumer } from './313_IsVisibleConsumer.js';
import { ApplyNoiseConsumer } from './314_ApplyNoiseConsumer.js';
import { SetMaterialParamsConsumer } from './315_SetMaterialParamsConsumer.js';
import { EcologyResponseSystem } from './316_EcologyResponseSystem.js';

// ─── Biome registry & coupling (327–334) ────────────────────────────
import { BiomeRegistryBarrel } from './327_BiomeRegistryBarrel.js';
import { BiomeBlendField } from './328_BiomeBlendField.js';
import { BiomeBlendSystem } from './329_BiomeBlendSystem.js';
import { CrossBiomeEcotoneSystem } from './330_CrossBiomeEcotoneSystem.js';
import { BiomeBlendMaterialBridge } from './331_BiomeBlendMaterialBridge.js';
import { BiomeClimateCoupling } from './332_BiomeClimateCoupling.js';
import { BiomeSoilCoupling } from './333_BiomeSoilCoupling.js';
import { BiomeHydrologyCoupling } from './334_BiomeHydrologyCoupling.js';
import { BiomeFaunaMigrationSystem } from './335_BiomeFaunaMigrationSystem.js';

// ─── Landscape chunk infrastructure (336–341) ───────────────────────
import { LandscapeChunkDescriptor } from './336_LandscapeChunkDescriptor.js';
import { LandscapeChunkStreamer } from './337_LandscapeChunkStreamer.js';
import { LandscapeChunkHLOD } from './338_LandscapeChunkHLOD.js';
import { LandscapeChunkSpatialHash } from './339_LandscapeChunkSpatialHash.js';
import { LandscapeChunkOcclusion } from './340_LandscapeChunkOcclusion.js';
import { LandscapeChunkPersistence } from './341_LandscapeChunkPersistence.js';

// ─── Generator lineage (386–386_Z06) ─────────────────────────────────
import {
  ProceduralTerrainGenerator, ProceduralNoise, TerrainErosion,
  TerrainType, BiomeType, createProceduralTerrainGenerator
} from './386_ProceduralTerrainGenerator.js';

import {
  ExtendedTerrainGenerator, ExtendedTerrainType, ExtendedBiomeType,
  ExtendedErosion, ScatterMarkerBuffer, ScatterMarkerType,
  HydrologyExtension, SeasonalVariantCache,
  installTerrainGeneratorExtensions, createExtendedTerrainGenerator
} from './386_Z01_ProceduralTerrainGenerator_Ext.js';

import {
  AdvancedTerrainGenerator, AdvancedTerrainType, AdvancedBiomeType,
  SubsurfaceLayer, SubsurfaceColumn, SubsurfaceComposition,
  MineralType, MineralDepositSystem, RiverNetworkBuilder,
  TectonicPlateSimulator, VolcanicActivitySimulator, ImpactCraterSystem,
  BiomeTransitionZoneSystem, ClimateAdaptiveModifiers,
  ContextDrivenDeformation, WaterTableModel, AnisotropicDetailPass,
  CavityAO, TerrainDerivedData, DetailLamination,
  ArchaeologyMarkerSystem, LODFidelitySystem,
  ScatterRockShape, ScatterTreeShape,
  installAdvancedTerrainExtensions, createAdvancedTerrainGenerator
} from './386_Z02_ProceduralTerrainGenerator_Adv.js';

import {
  UltimateTerrainGenerator, UltimateBiomeType,
  LandscapeChunkIntegration, FaunaMigrationHook, ProceduralTextureBaker,
  installUltimateTerrainExtensions, createUltimateTerrainGenerator
} from './386_Z03_ProceduralTerrainGenerator_Ultimate.js';

import {
  UltimateFulfilledTerrainGenerator, BiomeCouplingLayer,
  SensoryEmissionLayer, SpatialAccelerationLayer,
  SeasonalTerrainLayer, DecomposerMarkerLayer,
  PlayerBiasedRefinement,
  installUltimateFulfilledExtensions, createUltimateFulfilledTerrainGenerator
} from './386_Z04_ProceduralTerrainGenerator_UltimateFulfill.js';

import {
  UltimateIntegratedTerrainGenerator,
  ContextAggregationLayer,
  EnvironmentAggregationLayer,
  TerrainFeatureExtractor,
  DynamicDeformationEngine,
  TerrainQuerySystem,
  ContextAmbientAudioDispatcher,
  installUltimateIntegratedExtensions, createUltimateIntegratedTerrainGenerator
} from './386_Z05_ProceduralTerrainGenerator_UltimateIntegrated.js';

import {
  FullyIntegratedTerrainGenerator,
  TerrainPerformanceGovernor,
  TerrainContextRuntime,
  TerrainEcologyResponseLayer,
  installFullyIntegratedExtensions,
  createFullyIntegratedTerrainGenerator
} from './386_Z06_ProceduralTerrainGenerator_FullyIntegrated.js';

// ═════════════════════════════════════════════════════════════════════
// 1. BIOME REGISTRY ADAPTER
// ═════════════════════════════════════════════════════════════════════

/**
 * BiomeRegistryAdapter — makes the BiomeRegistryBarrel (327) the single
 * authoritative lookup for every biome descriptor. The generator’s internal
 * `biomeRegistry` becomes a thin proxy over the barrel, so biome lookups
 * are always O(1) and always consistent with the official registry.
 */
export class BiomeRegistryAdapter {
  constructor(barrel = null) {
    this.barrel = barrel ?? new BiomeRegistryBarrel();
    this._registered = new Set();
  }

  /**
   * Registers a biome in the barrel (idempotent).
   */
  register(name, descriptor) {
    if (this._registered.has(name)) return;
    this._registered.add(name);
    this.barrel.register?.(name, descriptor) ?? this.barrel.set?.(name, descriptor);
  }

  /**
   * Returns the biome descriptor for `name`, or null.
   */
  get(name) {
    return this.barrel.get?.(name) ?? this.barrel.lookup?.(name) ?? null;
  }

  /**
   * Returns true if the biome is registered.
   */
  has(name) {
    return this._registered.has(name);
  }

  /**
   * Returns all registered biome names.
   */
  names() {
    return Array.from(this._registered);
  }

  /**
   * Synchronises every biome from an external generator registry into the
   * barrel.
   */
  syncFromGenerator(generatorRegistry) {
    for (const [name, descriptor] of generatorRegistry) {
      this.register(name, descriptor);
    }
  }

  dispose() {
    this._registered.clear();
    this.barrel?.dispose?.();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 2. TERRAIN STREAMING MANAGER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainStreamingManager — coordinates every landscape-chunk system
 * (336–341) into a single streaming pipeline that the terrain generator
 * can drive per tick.
 *
 * Responsibilities:
 *   • Register every generated tile as a LandscapeChunkDescriptor.
 *   • Stream chunks around the camera using the LandscapeChunkStreamer.
 *   • Select HLOD levels using the LandscapeChunkHLOD.
 *   • Insert chunks into the LandscapeChunkSpatialHash for fast queries.
 *   • Apply the LandscapeChunkOcclusion culling.
 *   • Persist and restore chunk state via LandscapeChunkPersistence.
 */
export class TerrainStreamingManager {
  constructor(options = {}) {
    this.descriptorFactory = new LandscapeChunkDescriptor(options.descriptorOptions ?? {});
    this.streamer = new LandscapeChunkStreamer(options.streamerOptions ?? {});
    this.hlod = new LandscapeChunkHLOD(options.hlodOptions ?? {});
    this.spatialHash = new LandscapeChunkSpatialHash(options.spatialHashOptions ?? {});
    this.occlusion = new LandscapeChunkOcclusion(options.occlusionOptions ?? {});
    this.persistence = new LandscapeChunkPersistence(options.persistenceOptions ?? {});

    // Active chunk registry: chunkKey → descriptor
    this._chunks = new Map();
    // Chunk insertion order for LRU eviction.
    this._lru = [];
    // Maximum number of chunks to keep resident.
    this.maxChunks = options.maxChunks ?? 512;
  }

  /**
   * Registers a newly generated tile as a chunk descriptor.
   */
  registerTile(tileInfo, terrain, markers) {
    const key = this._chunkKey(tileInfo.tileX, tileInfo.tileY, tileInfo.lod ?? 0);
    if (this._chunks.has(key)) return this._chunks.get(key);

    // Build the descriptor.
    const descriptor = this.descriptorFactory.create?.({
      chunkKey: key,
      tileX: tileInfo.tileX,
      tileY: tileInfo.tileY,
      tileZ: tileInfo.tileZ ?? 0,
      lod: tileInfo.lod ?? 0,
      tileWorldSize: terrain.tileWorldSize,
      bounds: terrain.getBoundingBox?.(),
      boundingSphere: terrain.getBoundingSphere?.(),
      elevationMin: terrain.minElevation,
      elevationMax: terrain.maxElevation,
      resolution: terrain.resolution,
      markerCount: markers?.count ?? 0
    }) ?? {
      chunkKey: key,
      tileX: tileInfo.tileX,
      tileY: tileInfo.tileY,
      tileZ: tileInfo.tileZ ?? 0,
      lod: tileInfo.lod ?? 0,
      tileWorldSize: terrain.tileWorldSize,
      bounds: terrain.getBoundingBox?.(),
      boundingSphere: terrain.getBoundingSphere?.(),
      elevationMin: terrain.minElevation,
      elevationMax: terrain.maxElevation,
      resolution: terrain.resolution,
      markerCount: markers?.count ?? 0
    };

    this._chunks.set(key, descriptor);
    this.spatialHash.insert?.(key, descriptor.bounds);
    this.occlusion.addNode?.(key, descriptor.bounds);
    this._touch(key);
    this._evictLRU();

    return descriptor;
  }

  /**
   * Streams chunks around a camera position. Delegates to the streamer,
   * HLOD, and occlusion systems in that order.
   *
   * @returns {{ streamed: number, hlodSelected: number, visible: number }}
   */
  streamAround(cameraX, cameraY, cameraZ, radius, tick, dt, screenHeight, fovRadians, frustumPlanes) {
    // 1. Stream (fetch/decode/evict).
    const streamed = this.streamer.update?.(
      this._chunks, this.spatialHash, this.hlod, this.occlusion,
      cameraX, cameraY, cameraZ, radius, tick, dt
    ) ?? 0;

    // 2. HLOD selection.
    const hlodSelected = this.hlod.select?.(
      Array.from(this._chunks.values()),
      cameraX, cameraY, cameraZ, screenHeight, fovRadians
    ) ?? 0;

    // 3. Occlusion culling.
    const visible = this.occlusion.cull?.(
      Array.from(this._chunks.values()),
      cameraX, cameraY, cameraZ, frustumPlanes, tick
    ) ?? 0;

    return { streamed, hlodSelected, visible };
  }

  /**
   * Returns the descriptor for a chunk key, or null.
   */
  getChunk(chunkKey) {
    return this._chunks.get(chunkKey) ?? null;
  }

  /**
   * Returns all chunks whose bounds intersect the given sphere.
   */
  querySphere(cx, cy, cz, radius) {
    return this.spatialHash.querySphere?.(cx, cy, cz, radius) ?? [];
  }

  /**
   * Returns all chunks whose bounds intersect the given frustum.
   */
  queryFrustum(frustumPlanes) {
    return this.spatialHash.queryFrustum?.(frustumPlanes) ?? [];
  }

  /**
   * Persists the current state of a chunk (including deformations and
   * ecology responses) through the persistence layer.
   */
  async persistChunk(chunkKey, state) {
    const chunk = this._chunks.get(chunkKey);
    if (!chunk) return false;
    try {
      await this.persistence.persist?.(chunkKey, state) ??
            await this.persistence.save?.(chunkKey, state);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Restores a chunk state from persistence.
   */
  async restoreChunk(chunkKey) {
    try {
      return await this.persistence.restore?.(chunkKey) ??
             await this.persistence.load?.(chunkKey) ?? null;
    } catch (err) {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // LRU eviction
  // ---------------------------------------------------------------------

  _touch(key) {
    const idx = this._lru.indexOf(key);
    if (idx >= 0) this._lru.splice(idx, 1);
    this._lru.push(key);
  }

  _evictLRU() {
    while (this._chunks.size > this.maxChunks && this._lru.length > 0) {
      const oldest = this._lru.shift();
      this._chunks.delete(oldest);
      this.spatialHash.remove?.(oldest);
      this.occlusion.removeNode?.(oldest);
    }
  }

  _chunkKey(tileX, tileY, lod) {
    return `${lod}:${tileX}:${tileY}`;
  }

  dispose() {
    this.streamer?.dispose?.();
    this.persistence?.dispose?.();
    this._chunks.clear();
    this._lru.length = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 3. TERRAIN PERSISTENCE BRIDGE
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainPersistenceBridge — bridges terrain-specific state (deformations,
 * ecology responses, seasonality snapshots) into the generic chunk
 * persistence layer. Ensures that a destroyed tree or an erupted volcano
 * remains destroyed or erupted across sessions.
 */
export class TerrainPersistenceBridge {
  constructor(persistenceManager) {
    this.persistence = persistenceManager;
    this._pending = new Map(); // chunkKey → pending state
  }

  /**
   * Records a terrain state change (deformation, ignition, etc.) that
   * should be persisted.
   */
  recordStateChange(chunkKey, statePatch) {
    let existing = this._pending.get(chunkKey);
    if (!existing) {
      existing = {};
      this._pending.set(chunkKey, existing);
    }
    Object.assign(existing, statePatch);
  }

  /**
   * Flushes all pending state changes to the persistence layer.
   * Called once per second (1 Hz tier).
   */
  async flush() {
    for (const [chunkKey, state] of this._pending) {
      await this.persistence.persistChunk(chunkKey, state);
    }
    this._pending.clear();
  }

  /**
   * Restores terrain state for a chunk from persistence.
   */
  async restore(chunkKey) {
    return await this.persistence.restoreChunk(chunkKey);
  }

  /**
   * Returns the pending state for a chunk (before flush).
   */
  getPending(chunkKey) {
    return this._pending.get(chunkKey) ?? null;
  }

  dispose() {
    this._pending.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. STREAMING-INTEGRATED TERRAIN GENERATOR
// ═════════════════════════════════════════════════════════════════════

/**
 * StreamingIntegratedTerrainGenerator — the terminal generator in the lineage.
 * Combines every layer from 386 through 386_Z06 plus:
 *
 *   • BiomeRegistryAdapter (makes the barrel authoritative).
 *   • TerrainStreamingManager (coordinates 336–341).
 *   • TerrainPersistenceBridge (bridges terrain state to persistence).
 */
export class StreamingIntegratedTerrainGenerator extends FullyIntegratedTerrainGenerator {
  constructor(options = {}) {
    super(options);

    // ---- New layers ----
    this.biomeAdapter = new BiomeRegistryAdapter(options.biomeBarrel ?? null);
    this.streamingManager = new TerrainStreamingManager(options.streamingOptions ?? {});
    this.persistenceBridge = new TerrainPersistenceBridge(this.streamingManager);

    // ---- Sync existing biome registry into the adapter ----
    this.biomeAdapter.syncFromGenerator(this.biomeRegistry);
  }

  // ---------------------------------------------------------------------
  // Streaming-integrated generation
  // ---------------------------------------------------------------------

  /**
   * Generates a terrain tile, registers it with the streaming manager, and
   * records its initial state for persistence.
   *
   * @param {object} tileInfo – { tileX, tileY, tileZ, lod }
   * @param {object} contextFrame – the live context frame
   * @param {object} options – generation options
   * @returns {object} the complete generation result
   */
  generateStreamingIntegratedTile(tileInfo, contextFrame, options = {}) {
    // 1. Run the fully integrated generation.
    const integrated = super.generateFullyIntegratedTile(tileInfo, contextFrame, options);

    // 2. Register the tile with the streaming manager.
    const chunk = this.streamingManager.registerTile(
      tileInfo, integrated.terrain, integrated.markers
    );
    integrated.chunk = chunk;

    // 3. Record the initial terrain state for persistence.
    this.persistenceBridge.recordStateChange(chunk.chunkKey, {
      minElevation: integrated.terrain.minElevation,
      maxElevation: integrated.terrain.maxElevation,
      ecologyState: integrated.terrain.ecologyState ?? null,
      seasonality: integrated.seasonal ?? null
    });

    return integrated;
  }

  /**
   * Streams chunks around the camera. Called once per frame or once per
   * terrain tick.
   */
  streamChunks(cameraX, cameraY, cameraZ, radius, tick, dt,
               screenHeight, fovRadians, frustumPlanes) {
    return this.streamingManager.streamAround(
      cameraX, cameraY, cameraZ, radius, tick, dt,
      screenHeight, fovRadians, frustumPlanes
    );
  }

  /**
   * Flushes pending terrain state to the persistence layer.
   * Called once per second (1 Hz tier).
   */
  async flushPersistence() {
    await this.persistenceBridge.flush();
  }

  /**
   * Restores terrain state for a chunk from persistence.
   */
  async restoreChunk(chunkKey) {
    return await this.persistenceBridge.restore(chunkKey);
  }

  // ---------------------------------------------------------------------
  // Fast spatial queries (delegated to the streaming manager)
  // ---------------------------------------------------------------------

  /**
   * Returns all chunks intersecting a sphere.
   */
  queryChunksInSphere(cx, cy, cz, radius) {
    return this.streamingManager.querySphere(cx, cy, cz, radius);
  }

  /**
   * Returns all chunks intersecting a frustum.
   */
  queryChunksInFrustum(frustumPlanes) {
    return this.streamingManager.queryFrustum(frustumPlanes);
  }

  /**
   * Returns the chunk descriptor for a chunk key.
   */
  getChunk(chunkKey) {
    return this.streamingManager.getChunk(chunkKey);
  }

  // ---------------------------------------------------------------------
  // Biome registry (delegated to the adapter)
  // ---------------------------------------------------------------------

  /**
   * Returns the biome descriptor for `name` via the authoritative barrel.
   */
  getBiome(name) {
    return this.biomeAdapter.get(name);
  }

  /**
   * Registers a new biome in the barrel.
   */
  registerBiomeInBarrel(name, descriptor) {
    this.biomeAdapter.register(name, descriptor);
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    super.dispose();
    this.biomeAdapter?.dispose();
    this.streamingManager?.dispose();
    this.persistenceBridge?.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. INSTALLER
// ═════════════════════════════════════════════════════════════════════

/**
 * installStreamingIntegratedExtensions — augments an existing generator with
 * the streaming manager, biome adapter, and persistence bridge.
 */
export function installStreamingIntegratedExtensions(generator) {
  if (!generator || typeof generator.registerTerrainGenerator !== 'function') {
    throw new Error('installStreamingIntegratedExtensions requires a ProceduralTerrainGenerator');
  }

  const temp = new StreamingIntegratedTerrainGenerator({
    resolution: generator.options.resolution,
    seed: generator.options.seed
  });

  // Copy every biome into the adapter.
  for (const [name, descriptor] of temp.biomeRegistry) {
    if (!generator.biomeRegistry.has(name)) {
      generator.registerBiome(name, descriptor);
    }
  }
  generator.biomeAdapter = temp.biomeAdapter;
  generator.biomeAdapter.syncFromGenerator(generator.biomeRegistry);

  // Attach new layers.
  generator.streamingManager = temp.streamingManager;
  generator.persistenceBridge = temp.persistenceBridge;

  // Attach methods.
  generator.generateStreamingIntegratedTile = function (tileInfo, contextFrame, options) {
    return StreamingIntegratedTerrainGenerator.prototype.generateStreamingIntegratedTile.call(
      this, tileInfo, contextFrame, options
    );
  };
  generator.streamChunks = function (
    cameraX, cameraY, cameraZ, radius, tick, dt,
    screenHeight, fovRadians, frustumPlanes
  ) {
    return StreamingIntegratedTerrainGenerator.prototype.streamChunks.call(
      this, cameraX, cameraY, cameraZ, radius, tick, dt,
      screenHeight, fovRadians, frustumPlanes
    );
  };
  generator.flushPersistence = function () {
    return StreamingIntegratedTerrainGenerator.prototype.flushPersistence.call(this);
  };
  generator.restoreChunk = function (chunkKey) {
    return StreamingIntegratedTerrainGenerator.prototype.restoreChunk.call(this, chunkKey);
  };
  generator.queryChunksInSphere = function (cx, cy, cz, radius) {
    return StreamingIntegratedTerrainGenerator.prototype.queryChunksInSphere.call(
      this, cx, cy, cz, radius
    );
  };
  generator.queryChunksInFrustum = function (frustumPlanes) {
    return StreamingIntegratedTerrainGenerator.prototype.queryChunksInFrustum.call(
      this, frustumPlanes
    );
  };
  generator.getChunk = function (chunkKey) {
    return StreamingIntegratedTerrainGenerator.prototype.getChunk.call(this, chunkKey);
  };
  generator.getBiome = function (name) {
    return StreamingIntegratedTerrainGenerator.prototype.getBiome.call(this, name);
  };
  generator.registerBiomeInBarrel = function (name, descriptor) {
    return StreamingIntegratedTerrainGenerator.prototype.registerBiomeInBarrel.call(
      this, name, descriptor
    );
  };

  temp.dispose();
  return generator;
}

// ═════════════════════════════════════════════════════════════════════
// 6. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a StreamingIntegratedTerrainGenerator pre-populated with every
 * feature from files 386 through 386_Z06 plus the streaming manager, biome
 * adapter, and persistence bridge in this file.
 */
export function createStreamingIntegratedTerrainGenerator(options = {}) {
  return new StreamingIntegratedTerrainGenerator({
    resolution: options.resolution ?? 65,
    tileWorldSize: options.tileWorldSize ?? 100,
    seed: options.seed ?? 1337,
    zScale: options.zScale ?? 500,
    erosionIterations: options.erosionIterations ?? 50000,
    thermalIterations: options.thermalIterations ?? 10,
    riverDepth: options.riverDepth ?? 8.0,
    riverThreshold: options.riverThreshold ?? 100,
    defaultBiome: options.defaultBiome ?? BiomeType.TROPICAL_RAINFOREST,
    defaultTerrainType: options.defaultTerrainType ?? TerrainType.MOUNTAINS,
    seasonalCacheCapacity: options.seasonalCacheCapacity ?? 512,
    plateCount: options.plateCount ?? 12,
    maxLod: options.maxLod ?? 12,
    targetFrameMs: options.targetFrameMs ?? 8,
    maxResidentBytes: options.maxResidentBytes ?? 200 * 1024 * 1024,
    maxGCPauseMs: options.maxGCPauseMs ?? 2,
    // Sub-layer options
    biomeCouplingOptions: options.biomeCouplingOptions ?? {},
    sensoryOptions: options.sensoryOptions ?? {},
    spatialOptions: options.spatialOptions ?? {},
    seasonalOptions: options.seasonalOptions ?? {},
    decomposerOptions: options.decomposerOptions ?? {},
    playerRefinementOptions: options.playerRefinementOptions ?? {},
    contextOptions: options.contextOptions ?? {},
    environmentOptions: options.environmentOptions ?? {},
    featureOptions: options.featureOptions ?? {},
    deformationOptions: options.deformationOptions ?? {},
    ambientAudioOptions: options.ambientAudioOptions ?? {},
    governorOptions: options.governorOptions ?? {},
    runtimeOptions: options.runtimeOptions ?? {},
    ecologyOptions: options.ecologyOptions ?? {},
    streamingOptions: options.streamingOptions ?? {},
    biomeBarrel: options.biomeBarrel ?? null,
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 7. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  StreamingIntegratedTerrainGenerator,
  BiomeRegistryAdapter,
  TerrainStreamingManager,
  TerrainPersistenceBridge,
  installStreamingIntegratedExtensions,
  createStreamingIntegratedTerrainGenerator
};