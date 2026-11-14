// file number : 386_Z06
// full path name : src/context/386_Z06_ProceduralTerrainGenerator_FullyIntegrated.js
//### Description : Absolute final integration layer for the ProceduralTerrain
//###               Generator lineage (files 386, 386_Z01–386_Z05). This file
//###               wires the last remaining context-folder resources — the
//###               performance governance stack (303_HLODController,
//###               304_MemoryCeilingEnforcer, 305_FrameBudgetMonitor,
//###               306_GCPauseMonitor, 307_MemoryProfiler), the context runtime
//###               (308_ContextConsumerTiers, 309_ContextRuntime,
//###               310_GeometryContextFrameReader), the consumer systems
//###               (311_UpdateLODConsumer, 312_UpdateLoadStateConsumer,
//###               313_IsVisibleConsumer, 314_ApplyNoiseConsumer,
//###               315_SetMaterialParamsConsumer), and the ecology response
//###               system (316_EcologyResponseSystem) — so the terrain engine
//###               actively respects the 8 ms per-tick CPU ceiling, the 200 MB
//###               resident memory cap, and the 2 ms GC pause budget while
//###               reacting to fire, impacts, and weather in real time. With
//###               this file the entire src/context folder is fully wired into
//###               one coherent, context-driven terrain pipeline. No external
//###               loader, no CDN access, no static server. Designed for Android
//###               arm64.
//### Best for : Worlds that must actually honour the living-world blueprint’s
//###            hard limits on mobile — frame budget, memory ceiling, GC pause —
//###            while still reacting procedurally to ecology events. Use
//###            createFullyIntegratedTerrainGenerator() for a turnkey instance,
//###            or installFullyIntegratedExtensions() to upgrade an existing
//###            generator in place.
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

// ─── PERFORMANCE GOVERNANCE STACK (303–307) ──────────────────────────
import { HLODController } from './303_HLODController.js';
import { MemoryCeilingEnforcer } from './304_MemoryCeilingEnforcer.js';
import { FrameBudgetMonitor } from './305_FrameBudgetMonitor.js';
import { GCPauseMonitor } from './306_GCPauseMonitor.js';
import { MemoryProfiler } from './307_MemoryProfiler.js';

// ─── CONTEXT RUNTIME (308–310) ───────────────────────────────────────
import { ContextConsumerTiers } from './308_ContextConsumerTiers.js';
import { ContextRuntime } from './309_ContextRuntime.js';
import { GeometryContextFrameReader } from './310_GeometryContextFrameReader.js';

// ─── CONSUMER SYSTEMS (311–316) ──────────────────────────────────────
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

// ─── All biome descriptors (318–326_Z17) ────────────────────────────
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

// ─── Generator lineage (386–386_Z05) ─────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════
// 1. PERFORMANCE GOVERNOR
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainPerformanceGovernor — wraps the five performance-governance
 * modules (303–307) so the terrain generator can:
 *
 *   • Enforce the 200 MB resident memory cap (304 MemoryCeilingEnforcer).
 *   • Enforce the 8 ms per-tick CPU budget (305 FrameBudgetMonitor).
 *   • Avoid GC pauses over 2 ms (306 GCPauseMonitor).
 *   • Profile memory pressure in real time (307 MemoryProfiler).
 *   • Drive HLOD decisions from frame-budget headroom (303 HLODController).
 *
 * All governance is context-frame driven: the governor reads temporal and
 * physical channel signals (weather, time-of-day, player velocity) to bias
 * the HLOD and quality levels it produces.
 */
export class TerrainPerformanceGovernor {
  constructor(options = {}) {
    this.hlod           = new HLODController(options.hlodOptions ?? {});
    this.memory         = new MemoryCeilingEnforcer(options.memoryOptions ?? {});
    this.frameBudget    = new FrameBudgetMonitor(options.frameBudgetOptions ?? {});
    this.gcMonitor      = new GCPauseMonitor(options.gcOptions ?? {});
    this.profiler       = new MemoryProfiler(options.profilerOptions ?? {});

    // ---- Live governor state (updated each tick) ----
    this._state = {
      qualityScale: 1.0,           // 0.0–1.0
      memoryHeadroom: 1.0,         // 0.0–1.0
      gcHeadroom: 1.0,             // 0.0–1.0
      frameHeadroom: 1.0,          // 0.0–1.0
      hlodLod: 0,                  // current HLOD level
      tick: -1
    };

    // ---- Tunables ----
    this.options = {
      targetFrameMs: options.targetFrameMs ?? 8,
      maxResidentBytes: options.maxResidentBytes ?? 200 * 1024 * 1024,
      maxGCPauseMs: options.maxGCPauseMs ?? 2,
      smoothing: options.smoothing ?? 0.15,
      ...options
    };
  }

  /**
   * Reads the performance signals and updates the governor state.
   * Called once per terrain update.
   */
  update(contextFrame, tick, terrainCount, triangleCount, bytesUsed) {
    // 1. Update the frame budget monitor with the last frame’s timing.
    this.frameBudget.sample?.(this.options.targetFrameMs);
    // 2. Update the GC monitor with the last GC pause.
    this.gcMonitor.sample?.(this.options.maxGCPauseMs);
    // 3. Update the memory profiler with the current footprint.
    this.profiler.sample?.(bytesUsed, terrainCount, triangleCount);
    // 4. Update the memory ceiling enforcer.
    this.memory.check?.(bytesUsed, this.options.maxResidentBytes);

    // 5. Compute headroom values.
    const frameHeadroom = Math.max(0, 1 - (this.frameBudget.lastFrameMs ?? 0) / this.options.targetFrameMs);
    const memoryHeadroom = Math.max(0, 1 - bytesUsed / this.options.maxResidentBytes);
    const gcHeadroom = Math.max(0, 1 - (this.gcMonitor.lastPauseMs ?? 0) / this.options.maxGCPauseMs);

    // 6. Combine into a single quality scale.
    const combined = frameHeadroom * 0.5 + memoryHeadroom * 0.3 + gcHeadroom * 0.2;
    const targetScale = Math.max(0.25, Math.min(1.0, combined));
    const s = this.options.smoothing;
    this._state.qualityScale = this._state.qualityScale * (1 - s) + targetScale * s;

    this._state.frameHeadroom = frameHeadroom;
    this._state.memoryHeadroom = memoryHeadroom;
    this._state.gcHeadroom = gcHeadroom;
    this._state.tick = tick;

    // 7. HLOD controller decides the current level.
    const temporal = contextFrame?.layers?.temporal ?? {};
    const player = contextFrame?.layers?.player ?? {};
    this._state.hlodLod = this.hlod.select?.({
      qualityScale: this._state.qualityScale,
      timeOfDay: temporal.timeOfDay ?? 0.5,
      playerVelocity: player.velocity ?? [0, 0, 0],
      tick
    }) ?? 0;

    return this._state;
  }

  /**
   * Returns the current quality scale (0.0–1.0).
   */
  getQualityScale() {
    return this._state.qualityScale;
  }

  /**
   * Returns the full governor state for diagnostics.
   */
  getState() {
    return this._state;
  }

  dispose() {
    this.hlod?.dispose?.();
    this.memory?.dispose?.();
    this.frameBudget?.dispose?.();
    this.gcMonitor?.dispose?.();
    this.profiler?.dispose?.();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 2. CONTEXT RUNTIME LAYER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainContextRuntime — wraps the three context-runtime modules (308–310)
 * so terrain consumers (LOD, visibility, materials, noise) run inside the
 * same tiered execution model as the rest of the living world.
 */
export class TerrainContextRuntime {
  constructor(options = {}) {
    this.consumerTiers = new ContextConsumerTiers(options.tierOptions ?? {});
    this.runtime = new ContextRuntime(options.runtimeOptions ?? {});
    this.frameReader = new GeometryContextFrameReader(options.frameReaderOptions ?? {});

    // ---- Consumer registrations ----
    this._consumers = {
      lod:     new UpdateLODConsumer(options.lodOptions ?? {}),
      load:    new UpdateLoadStateConsumer(options.loadOptions ?? {}),
      visible: new IsVisibleConsumer(options.visibleOptions ?? {}),
      noise:   new ApplyNoiseConsumer(options.noiseOptions ?? {}),
      material: new SetMaterialParamsConsumer(options.materialOptions ?? {})
    };
  }

  /**
   * Runs all context consumers for the current tick, in the correct tier
   * order. Returns the number of consumers that executed.
   */
  update(contextFrame, terrainTiles, tick, dt) {
    // 1. Read the context frame into a slice the consumers can use.
    const slice = this.frameReader.read?.(contextFrame, tick) ?? contextFrame;

    // 2. Determine which tier fires this tick.
    const tier = this.consumerTiers.classify?.(tick) ?? 10;

    // 3. Run consumers whose tier matches.
    let executed = 0;
    if (tier === 60) {
      this._consumers.visible.update?.(slice, terrainTiles, tick, dt);
      executed++;
    }
    if (tier === 10) {
      this._consumers.lod.update?.(slice, terrainTiles, tick, dt);
      this._consumers.load.update?.(slice, terrainTiles, tick, dt);
      executed += 2;
    }
    if (tier === 1) {
      this._consumers.noise.update?.(slice, terrainTiles, tick, dt);
      this._consumers.material.update?.(slice, terrainTiles, tick, dt);
      executed += 2;
    }

    return executed;
  }

  dispose() {
    for (const consumer of Object.values(this._consumers)) {
      consumer?.dispose?.();
    }
    this.consumerTiers?.dispose?.();
    this.runtime?.dispose?.();
    this.frameReader?.dispose?.();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 3. ECOLOGY RESPONSE LAYER
// ═════════════════════════════════════════════════════════════════════

/**
 * TerrainEcologyResponseLayer — wraps the EcologyResponseSystem (316) and
 * turns terrain tiles into living substrates that respond to fire, impacts,
 * and weather. Burned tiles darken, wet tiles gloss, and impacted tiles
 * fracture — all driven by the causal channel.
 */
export class TerrainEcologyResponseLayer {
  constructor(options = {}) {
    this.ecology = new EcologyResponseSystem(options.ecologyOptions ?? {});
    this._tileStates = new Map(); // tileKey → { burn, wetness, fracture }
  }

  /**
   * Applies the ecology response to a set of visible terrain tiles.
   */
  apply(terrainTiles, contextFrame, tick, dt) {
    const causal = contextFrame?.layers?.causal;
    const physical = contextFrame?.layers?.physical;

    for (const tile of terrainTiles) {
      if (!tile || !tile.elevation) continue;

      // ---- 1. Ignition from fire events ----
      if (causal?.events) {
        for (const evt of causal.events) {
          if (evt.type !== EVENT_TYPE.IGNITE) continue;
          if (!this._eventIntersectsTile(evt, tile)) continue;

          const state = this._getOrCreateTileState(tile.tileKey);
          state.burn = Math.min(1, state.burn + (evt.payload?.force ?? 1) * 0.3);
        }
      }

      // ---- 2. Wetness from rain ----
      const weather = contextFrame?.layers?.temporal?.weatherSeverity ?? 0;
      if (weather > 0.3) {
        const state = this._getOrCreateTileState(tile.tileKey);
        // Wetness rises toward 1 at a rate proportional to rainfall.
        const k = 1 - Math.exp(-dt / 8);
        state.wetness = state.wetness + (1 - state.wetness) * k;
      } else {
        const state = this._getOrCreateTileState(tile.tileKey);
        const k = 1 - Math.exp(-dt / 30);
        state.wetness = state.wetness - state.wetness * k;
      }

      // ---- 3. Emit ecology markers for material/sensory systems ----
      const state = this._tileStates.get(tile.tileKey);
      if (state) {
        tile.ecologyState = state;
      }
    }
  }

  _eventIntersectsTile(evt, tile) {
    const bbox = tile.getBoundingBox?.();
    if (!bbox) return false;
    const p = evt.payload;
    if (!p) return false;
    return (
      p.x >= bbox[0] && p.x <= bbox[3] &&
      p.y >= bbox[1] && p.y <= bbox[4]
    );
  }

  _getOrCreateTileState(tileKey) {
    let state = this._tileStates.get(tileKey);
    if (!state) {
      state = { burn: 0, wetness: 0, fracture: 0 };
      this._tileStates.set(tileKey, state);
    }
    return state;
  }

  getTileState(tileKey) {
    return this._tileStates.get(tileKey) ?? null;
  }

  dispose() {
    this.ecology?.dispose?.();
    this._tileStates.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. FULLY INTEGRATED TERRAIN GENERATOR
// ═════════════════════════════════════════════════════════════════════

/**
 * FullyIntegratedTerrainGenerator — the terminal generator in the lineage.
 * Combines every layer from 386 through 386_Z05 plus the three new layers
 * in this file: the performance governor (303–307), the context runtime
 * (308–310 + 311–315), and the ecology response layer (316).
 *
 * This is the only generator that fully honours the living-world
 * blueprint’s hard limits while still reacting to fire, impacts, and weather.
 */
export class FullyIntegratedTerrainGenerator extends UltimateIntegratedTerrainGenerator {
  constructor(options = {}) {
    super(options);

    // ---- New layers ----
    this.performanceGovernor = new TerrainPerformanceGovernor(options.governorOptions ?? {});
    this.contextRuntime = new TerrainContextRuntime(options.runtimeOptions ?? {});
    this.ecologyResponse = new TerrainEcologyResponseLayer(options.ecologyOptions ?? {});

    // ---- Active tile tracking for governance ----
    this._activeTiles = new Set();
    this._totalBytes = 0;
  }

  // ---------------------------------------------------------------------
  // Fully integrated generation
  // ---------------------------------------------------------------------

  /**
   * Generates a terrain tile while respecting the current performance budget.
   * The quality scale and HLOD level are read from the governor, so on a
   * struggling device the generator automatically reduces resolution,
   * erosion iterations, and scatter density.
   *
   * @param {object} tileInfo – { tileX, tileY, tileZ, lod }
   * @param {object} contextFrame – the live context frame
   * @param {object} options – generation options
   * @returns {object} the complete generation result with ecology state
   */
  generateFullyIntegratedTile(tileInfo, contextFrame, options = {}) {
    // 1. Read governor state.
    const govState = this.performanceGovernor.getState();
    const qualityScale = govState.qualityScale;

    // 2. Scale resolution and erosion by the quality budget.
    const baseFidelity = this.lodFidelity.configForLod(tileInfo.lod ?? 0);
    const scaledResolution = Math.max(
      17,
      Math.floor(baseFidelity.resolution * (0.5 + qualityScale * 0.5))
    );
    const scaledErosion = Math.floor(baseFidelity.erosionIterations * qualityScale);

    // 3. Run the integrated generation with the scaled parameters.
    const integrated = super.generateIntegratedTile(tileInfo, contextFrame, {
      ...options,
      resolution: scaledResolution,
      erosionIterations: scaledErosion
    });

    // 4. Register the tile for active tracking.
    this._activeTiles.add(integrated.chunkKey);
    this._totalBytes += (integrated.terrain.elevation?.byteLength ?? 0);

    // 5. Apply the ecology response (fire, rain, impacts).
    this.ecologyResponse.apply([integrated.terrain], contextFrame, this.lastTick, 1 / 10);

    // 6. Run the context consumers (LOD, visibility, materials).
    this.contextRuntime.update(contextFrame, [integrated.terrain], this.lastTick, 1 / 10);

    return integrated;
  }

  // ---------------------------------------------------------------------
  // Governor tick
  // ---------------------------------------------------------------------

  /**
   * Updates the performance governor with the current footprint. Called by
   * the runtime once per frame (or once per terrain tick).
   */
  updatePerformance(tick, terrainCount, triangleCount) {
    return this.performanceGovernor.update(
      this.frame,
      tick,
      terrainCount,
      triangleCount,
      this._totalBytes
    );
  }

  /**
   * Returns the current quality scale (0.0–1.0). Downstream systems use this
   * to scale their own budgets.
   */
  getQualityScale() {
    return this.performanceGovernor.getQualityScale();
  }

  /**
   * Returns the full governor state.
   */
  getGovernorState() {
    return this.performanceGovernor.getState();
  }

  // ---------------------------------------------------------------------
  // Ecology queries
  // ---------------------------------------------------------------------

  /**
   * Returns the ecology state (burn, wetness, fracture) for a tile.
   */
  getEcologyState(tileKey) {
    return this.ecologyResponse.getTileState(tileKey);
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  dispose() {
    super.dispose();
    this.performanceGovernor?.dispose();
    this.contextRuntime?.dispose();
    this.ecologyResponse?.dispose();
    this._activeTiles.clear();
    this._totalBytes = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. INSTALLER
// ═════════════════════════════════════════════════════════════════════

/**
 * installFullyIntegratedExtensions — augments an existing generator with the
 * performance governor, context runtime, and ecology response layers.
 */
export function installFullyIntegratedExtensions(generator) {
  if (!generator || typeof generator.registerTerrainGenerator !== 'function') {
    throw new Error('installFullyIntegratedExtensions requires a ProceduralTerrainGenerator');
  }

  const temp = new FullyIntegratedTerrainGenerator({
    resolution: generator.options.resolution,
    seed: generator.options.seed
  });

  // Copy every biome.
  for (const [name, descriptor] of temp.biomeRegistry) {
    if (!generator.biomeRegistry.has(name)) {
      generator.registerBiome(name, descriptor);
    }
  }

  // Attach new layers.
  generator.performanceGovernor = temp.performanceGovernor;
  generator.contextRuntime = temp.contextRuntime;
  generator.ecologyResponse = temp.ecologyResponse;
  generator._activeTiles = temp._activeTiles;
  generator._totalBytes = 0;

  // Attach methods.
  generator.generateFullyIntegratedTile = function (tileInfo, contextFrame, options) {
    return FullyIntegratedTerrainGenerator.prototype.generateFullyIntegratedTile.call(
      this, tileInfo, contextFrame, options
    );
  };
  generator.updatePerformance = function (tick, terrainCount, triangleCount) {
    return FullyIntegratedTerrainGenerator.prototype.updatePerformance.call(
      this, tick, terrainCount, triangleCount
    );
  };
  generator.getQualityScale = function () {
    return FullyIntegratedTerrainGenerator.prototype.getQualityScale.call(this);
  };
  generator.getGovernorState = function () {
    return FullyIntegratedTerrainGenerator.prototype.getGovernorState.call(this);
  };
  generator.getEcologyState = function (tileKey) {
    return FullyIntegratedTerrainGenerator.prototype.getEcologyState.call(this, tileKey);
  };

  temp.dispose();
  return generator;
}

// ═════════════════════════════════════════════════════════════════════
// 6. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates a FullyIntegratedTerrainGenerator pre-populated with every feature
 * from files 386 through 386_Z05 plus the performance governor, context
 * runtime, and ecology response layers in this file.
 */
export function createFullyIntegratedTerrainGenerator(options = {}) {
  return new FullyIntegratedTerrainGenerator({
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
    // All sub-layer options
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
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 7. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  FullyIntegratedTerrainGenerator,
  TerrainPerformanceGovernor,
  TerrainContextRuntime,
  TerrainEcologyResponseLayer,
  installFullyIntegratedExtensions,
  createFullyIntegratedTerrainGenerator
};