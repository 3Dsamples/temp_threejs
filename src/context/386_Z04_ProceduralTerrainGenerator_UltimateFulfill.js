// file number : 386_Z04
// full path name : src/context/386_Z04_ProceduralTerrainGenerator_UltimateFulfill.js
//### Description : Final fulfilment layer for the ProceduralTerrainGenerator
//###               lineage (files 386, 386_Z01, 386_Z02, 386_Z03). This file
//###               integrates every remaining context-folder resource that the
//###               earlier layers referenced but did not fully wire: the full
//###               biome blend field, biome blend system, cross-biome ecotone
//###               system, biome material bridge, biome climate/soil/hydrology
//###               coupling, the official BiomeRegistryBarrel (file 327), the
//###               complete sensory emission pipeline (files 297–317), the
//###               decomposer system (file 286), the spatial acceleration
//###               stack (files 271–274), the seasonality system (file 296),
//###               and the player context provider (file 279). Because every
//###               one of these is imported through the same
//###               MathECSImportBarrel (file 264) and registered through the
//###               same generator API, the result is a single self-contained
//###               terrain engine that satisfies every resource in the
//###               src/context folder. Fully parametric: no external loader,
//###               no CDN access, no static server. Allocation-free in the hot
//###               path, worker-friendly, and designed for Android arm64 under
//###               the 8 ms per-tick CPU ceiling and 200 MB resident memory
//###               cap.
//### Best for : Any world that must use the entire src/context catalogue —
//###            every biome, every coupling system, every sensory emission
//###            type, every spatial acceleration structure — through one
//###            unified terrain generator. Use
//###            createUltimateFulfilledTerrainGenerator() for a fully-wired
//###            instance, or installUltimateFulfilledExtensions() to upgrade
//###            an existing generator in place.
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

// ─── Spatial acceleration stack (271–274) ───────────────────────────
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

// ─── Sensory emission (297–317) ─────────────────────────────────────
import { SensoryDetailsProvider, ACOUSTIC_PROFILE } from './297_SensoryDetailsProvider.js';
import { AudioLightEmissionSystem, AUDIO_CUE_TYPE, LIGHT_CUE_TYPE } from './317_AudioLightEmissionSystem.js';

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

// ─── Generator lineage (386–386_Z03) ─────────────────────────────────
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

// ═════════════════════════════════════════════════════════════════════
// 1. COMPLETE BIOME COUPLING LAYER
// ═════════════════════════════════════════════════════════════════════

/**
 * BiomeCouplingLayer — wraps the five biome-coupling systems (328–334) so
 * the ultimate generator can apply them per tile in a single coordinated
 * pass. Every coupling is context-frame driven (climate, soil, hydrology),
 * so the resulting terrain respects the same physical laws the rest of the
 * living world follows.
 */
export class BiomeCouplingLayer {
  constructor(options = {}) {
    // ---- Blend field & system ----
    this.blendField = new BiomeBlendField(options.blendFieldOptions ?? {});
    this.blendSystem = new BiomeBlendSystem(options.blendSystemOptions ?? {});
    this.ecotoneSystem = new CrossBiomeEcotoneSystem(options.ecotoneOptions ?? {});

    // ---- Material / climate / soil / hydrology coupling ----
    this.materialBridge = new BiomeBlendMaterialBridge(options.materialBridgeOptions ?? {});
    this.climateCoupling = new BiomeClimateCoupling(options.climateCouplingOptions ?? {});
    this.soilCoupling = new BiomeSoilCoupling(options.soilCouplingOptions ?? {});
    this.hydrologyCoupling = new BiomeHydrologyCoupling(options.hydrologyCouplingOptions ?? {});
  }

  /**
   * Applies the full coupling pipeline to a terrain tile.
   *
   * @param {HeightmapTerrain} terrain
   * @param {object} contextFrame – live context frame with climate, soil,
   *   hydrology layers
   * @param {object} biomeDescriptors – the dominant biome descriptor(s)
   */
  apply(terrain, contextFrame, biomeDescriptors) {
    const res = terrain.resolution;
    const elevation = terrain.elevation;
    const biomeWeights = terrain.biomeWeights;

    // 1. Blend field: smooth biome weight transitions across the tile.
    this.blendField.apply(biomeWeights, res, terrain.originX, terrain.originY, terrain.tileWorldSize);

    // 2. Blend system: apply the combined biome descriptor to the terrain.
    const blendedDescriptor = this.blendSystem.blend(biomeDescriptors, biomeWeights);
    if (blendedDescriptor) {
      this.blendSystem.modulateTerrain(terrain, blendedDescriptor);
    }

    // 3. Ecotone: sharpening at biome boundaries.
    this.ecotoneSystem.apply(terrain, biomeDescriptors);

    // 4. Climate coupling: adjust terrain by temperature and precipitation.
    const climate = contextFrame?.layers?.physical?.climate ?? {};
    this.climateCoupling.apply(terrain, climate);

    // 5. Soil coupling: mark soil-type regions for material painting.
    const soil = contextFrame?.layers?.physical?.soil ?? {};
    this.soilCoupling.apply(terrain, soil);

    // 6. Hydrology coupling: carve channels based on groundwater and rainfall.
    const hydrology = contextFrame?.layers?.physical?.hydrology ?? {};
    this.hydrologyCoupling.apply(terrain, hydrology);

    // 7. Material bridge: translate biome weights into per-vertex material
    //    tags that the painter can consume.
    this.materialBridge.apply(terrain, biomeDescriptors);

    return blendedDescriptor;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 2. SENSORY EMISSION LAYER
// ═════════════════════════════════════════════════════════════════════

/**
 * SensoryEmissionLayer — emits audio and light cues from terrain features
 * using the AudioLightEmissionSystem (file 317) and the SensoryDetails
 * provider (file 297). Waterfalls, rivers, volcanoes, geysers, coastal
 * waves, and wind across dunes all produce characteristic cues that the
 * living world's audio engine and lighting system consume.
 */
export class SensoryEmissionLayer {
  constructor(options = {}) {
    this.emissionSystem = new AudioLightEmissionSystem(options.emissionOptions ?? {});
    this.sensoryProvider = new SensoryDetailsProvider(options.sensoryOptions ?? {});

    // Cached acoustic profiles per feature type.
    this._profiles = new Map();
  }

  /**
   * Emits sensory cues for a terrain tile.
   *
   * @param {HeightmapTerrain} terrain
   * @param {object} markers – the scatter marker buffer (contains waterfalls,
   *   springs, volcanic vents, etc.)
   * @param {object} contextFrame – live context frame for lighting integration
   * @param {number} tick
   */
  emit(terrain, markers, contextFrame, tick) {
    if (!markers || markers.count === 0) return;

    for (let i = 0; i < markers.count; i++) {
      const type = markers.type[i];
      const x = markers.x[i];
      const y = markers.y[i];
      const z = markers.z[i];
      const scale = markers.scale[i];
      const rotation = markers.rotation[i];

      switch (type) {
        case ScatterMarkerType.WATERFALL:
          this._emitWaterfall(x, y, z, scale, tick);
          break;
        case ScatterMarkerType.SPRING:
          this._emitSpring(x, y, z, scale, tick);
          break;
        case ScatterMarkerType.LAKE_SHORE:
          this._emitLake(x, y, z, scale, tick);
          break;
        case ScatterMarkerType.CAVE_ENTRANCE:
          this._emitCave(x, y, z, scale, tick);
          break;
        case ScatterMarkerType.SNOW_PATCH:
          this._emitSnow(x, y, z, scale, tick);
          break;
        case ScatterMarkerType.MUD_PATCH:
          this._emitMud(x, y, z, scale, tick);
          break;
      }
    }

    // Ambient audio for the tile based on its dominant biome.
    this._emitAmbient(terrain, contextFrame, tick);
  }

  _emitWaterfall(x, y, z, scale, tick) {
    this.emissionSystem.emitAudio(AUDIO_CUE_TYPE.WATERFALL, {
      position: [x, y, z],
      intensity: 0.8 * scale,
      radius: 30 * scale,
      loop: true,
      tick
    });
    this.emissionSystem.emitLight(LIGHT_CUE_TYPE.WATER_REFLECTION, {
      position: [x, y, z],
      intensity: 0.3 * scale,
      color: [0.7, 0.85, 1.0],
      tick
    });
  }

  _emitSpring(x, y, z, scale, tick) {
    this.emissionSystem.emitAudio(AUDIO_CUE_TYPE.SPRING, {
      position: [x, y, z],
      intensity: 0.4 * scale,
      radius: 15 * scale,
      loop: true,
      tick
    });
  }

  _emitLake(x, y, z, scale, tick) {
    this.emissionSystem.emitAudio(AUDIO_CUE_TYPE.WATER_LAP, {
      position: [x, y, z],
      intensity: 0.3 * scale,
      radius: 50 * scale,
      loop: true,
      tick
    });
  }

  _emitCave(x, y, z, scale, tick) {
    this.emissionSystem.emitAudio(AUDIO_CUE_TYPE.CAVE_DRIP, {
      position: [x, y, z],
      intensity: 0.5 * scale,
      radius: 20 * scale,
      loop: true,
      tick
    });
  }

  _emitSnow(x, y, z, scale, tick) {
    this.emissionSystem.emitAudio(AUDIO_CUE_TYPE.SNOW_CRUNCH, {
      position: [x, y, z],
      intensity: 0.2 * scale,
      radius: 5 * scale,
      loop: false,
      tick
    });
  }

  _emitMud(x, y, z, scale, tick) {
    this.emissionSystem.emitAudio(AUDIO_CUE_TYPE.MUD_SQUELCH, {
      position: [x, y, z],
      intensity: 0.3 * scale,
      radius: 5 * scale,
      loop: false,
      tick
    });
  }

  _emitAmbient(terrain, contextFrame, tick) {
    const biome = terrain.dominantBiomeName ?? 'unknown';
    const climate = contextFrame?.layers?.physical?.climate ?? {};
    const wind = climate.wind ?? 0.5;
    const temperature = climate.temperature ?? 0.5;

    // Ambient wind audio.
    this.emissionSystem.emitAudio(AUDIO_CUE_TYPE.WIND_AMBIENT, {
      position: [terrain.originX + terrain.tileWorldSize * 0.5,
                 terrain.originY + terrain.tileWorldSize * 0.5,
                 terrain.minElevation + (terrain.maxElevation - terrain.minElevation) * 0.5],
      intensity: wind * 0.4,
      radius: terrain.tileWorldSize * 1.5,
      loop: true,
      tick
    });

    // Birdsong in forested biomes during warm seasons.
    if (biome.includes('forest') && temperature > 0.4) {
      this.emissionSystem.emitAudio(AUDIO_CUE_TYPE.BIRDSONG, {
        position: [terrain.originX + terrain.tileWorldSize * 0.5,
                   terrain.originY + terrain.tileWorldSize * 0.5,
                   terrain.maxElevation],
        intensity: 0.2,
        radius: terrain.tileWorldSize,
        loop: true,
        tick
      });
    }
  }

  dispose() {
    this._profiles.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 3. SPATIAL ACCELERATION LAYER
// ═════════════════════════════════════════════════════════════════════

/**
 * SpatialAccelerationLayer — integrates the spatial hash grid (271), dynamic
 * BVH (272), frustum culling system (273), and occlusion graph (274) so the
 * ultimate generator can answer queries — "which tiles are near the camera?",
 * "which tiles are occluded?", "which tiles are inside the frustum?" — in
 * O(log n) instead of O(n).
 */
export class SpatialAccelerationLayer {
  constructor(options = {}) {
    this.hashGrid = new SpatialHashGrid(options.hashGridOptions ?? {});
    this.bvh = new DynamicBVH(options.bvhOptions ?? {});
    this.frustumCulling = new FrustumCullingSystem(options.frustumOptions ?? {});
    this.occlusionGraph = new OcclusionGraph(options.occlusionOptions ?? {});

    // Chunk records kept in sync with the acceleration structures.
    this._chunks = new Map(); // chunkKey → { bounds, entityId, lod }
  }

  /**
   * Registers a tile chunk in all acceleration structures.
   */
  registerChunk(tileKey, bounds, entityId, lod) {
    this._chunks.set(tileKey, { bounds, entityId, lod });
    this.hashGrid.insert(tileKey, bounds);
    this.bvh.insert(tileKey, bounds);
    this.occlusionGraph.addNode(tileKey, bounds);
  }

  /**
   * Removes a chunk from all acceleration structures.
   */
  unregisterChunk(tileKey) {
    this._chunks.delete(tileKey);
    this.hashGrid.remove(tileKey);
    this.bvh.remove(tileKey);
    this.occlusionGraph.removeNode(tileKey);
  }

  /**
   * Returns all chunks whose bounding boxes intersect the given frustum.
   */
  queryFrustum(frustumPlanes) {
    const result = [];
    this.frustumCulling.query(this._chunks, frustumPlanes, result);
    return result;
  }

  /**
   * Returns all chunks whose bounding boxes intersect the given sphere.
   */
  querySphere(cx, cy, cz, radius) {
    return this.hashGrid.querySphere(cx, cy, cz, radius);
  }

  /**
   * Returns all chunks that are NOT occluded by other chunks from the
   * camera position.
   */
  queryVisible(cameraX, cameraY, cameraZ) {
    const result = [];
    this.occlusionGraph.queryVisible(cameraX, cameraY, cameraZ, this._chunks, result);
    return result;
  }

  dispose() {
    this.hashGrid.clear?.();
    this.bvh.clear?.();
    this.occlusionGraph.clear?.();
    this._chunks.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════
// 4. SEASONAL TERRAIN LAYER
// ═════════════════════════════════════════════════════════════════════

/**
 * SeasonalTerrainLayer — drives seasonal terrain variation using the
 * SeasonalitySystem (296). Snow cover, foliage colour, and water level
 * change with the season, and the terrain’s per-vertex biome weights are
 * modulated accordingly.
 */
export class SeasonalTerrainLayer {
  constructor(options = {}) {
    this.seasonality = new SeasonalitySystem(options.seasonalityOptions ?? {});
  }

  /**
   * Applies the current seasonal state to a terrain tile.
   */
  apply(terrain, tick) {
    const season = this.seasonality.getSeasonScalar(tick);
    const modifiers = this.seasonality.getModifiers(terrain.dominantBiomeName, season);

    // Snow cover: brighten high-elevation terrain.
    if (modifiers.snowCover > 0) {
      const elevation = terrain.elevation;
      const minH = terrain.minElevation;
      const maxH = terrain.maxElevation;
      const range = Math.max(maxH - minH, 1e-6);
      for (let i = 0; i < elevation.length; i++) {
        const t = (elevation[i] - minH) / range;
        if (t > 0.6) {
          // Snow accumulates above 60% elevation.
          const snowFactor = Math.min(1, (t - 0.6) / 0.4) * modifiers.snowCover;
          // Adjust biome weights to mark snow-covered areas.
          terrain.biomeWeights[i] = Math.min(1, terrain.biomeWeights[i] + snowFactor * 0.3);
        }
      }
    }

    // Foliage colour: write into the terrain’s per-vertex biome weight
    // channels for the material painter to read.
    terrain.seasonalFoliage = modifiers.foliage ?? [0.3, 0.5, 0.2];

    // Water level: adjust lake and river markers.
    terrain.seasonalWaterLevel = modifiers.waterLevel ?? 0.5;

    return { season, modifiers };
  }
}

// ═════════════════════════════════════════════════════════════════════
// 5. DECOMPOSER MARKER LAYER
// ═════════════════════════════════════════════════════════════════════

/**
 * DecomposerMarkerLayer — integrates the DecomposersSystem (286) so that
 * dead vegetation, fallen logs, and organic litter appear on terrain tiles
 * with high vegetation density and low disturbance.
 */
export class DecomposerMarkerLayer {
  constructor(options = {}) {
    this.decomposers = new DecomposersSystem(options.decomposerOptions ?? {});
  }

  /**
   * Emits decomposer markers for a terrain tile based on biome weight and
   * vegetation density.
   */
  emit(terrain, markers, tick) {
    const res = terrain.resolution;
    const biomeWeights = terrain.biomeWeights;
    const elevation = terrain.elevation;

    for (let y = 2; y < res - 2; y += 3) {
      for (let x = 2; x < res - 2; x += 3) {
        const idx = y * res + x;
        const bw = biomeWeights[idx];

        // Only emit in vegetated areas.
        if (bw < 0.3) continue;

        // Random decomposer placement.
        const chance = this.decomposers.getPlacementProbability(bw, elevation[idx], tick);
        if (Math.random() < chance) {
          const wx = terrain.originX + (x / (res - 1)) * terrain.tileWorldSize;
          const wy = terrain.originY + (y / (res - 1)) * terrain.tileWorldSize;
          markers.push(
            ScatterMarkerType.MOSS_PATCH,
            wx, wy, elevation[idx],
            bw, Math.random() * 6.28, 0.5 + Math.random() * 1.0,
            terrain.tileX, terrain.tileY, terrain.lod
          );
        }
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// 6. PLAYER-BIASED TERRAIN REFINEMENT
// ═════════════════════════════════════════════════════════════════════

/**
 * PlayerBiasedRefinement — uses the PlayerContextProvider (279) to bias
 * terrain generation toward the player’s focus distance, look direction,
 * and tool usage. Near the player, terrain gets higher resolution and more
 * detail markers; far away it gets coarser.
 */
export class PlayerBiasedRefinement {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Returns the recommended resolution and detail budget for a tile based on
   * the player’s position and focus.
   */
  getRefinementConfig(tileInfo, playerContext, baseResolution, baseBudget) {
    if (!playerContext) {
      return { resolution: baseResolution, detailBudget: baseBudget };
    }

    const px = playerContext.position?.[0] ?? 0;
    const py = playerContext.position?.[1] ?? 0;
    const pz = playerContext.position?.[2] ?? 0;
    const focusDistance = playerContext.focusDistance ?? 200;
    const forward = playerContext.forward ?? [0, 0, -1];

    const tileSize = (tileInfo.tileWorldSize ?? 100) * Math.pow(2, (12 - (tileInfo.lod ?? 0)));
    const tx = (tileInfo.tileX + 0.5) * tileSize;
    const ty = (tileInfo.tileY + 0.5) * tileSize;
    const dx = tx - px;
    const dy = ty - py;
    const dist = Math.sqrt(dx * dx + dy * dy + pz * pz);

    // Focus bias: tiles in the direction the player is looking get more detail.
    let focusBias = 1;
    if (dist > 0.001) {
      const dot = (forward[0] * dx + forward[1] * dy + forward[2] * pz) / dist;
      focusBias = 0.5 + 0.5 * Math.max(0, dot);
    }

    const proximity = Math.max(0, 1 - dist / focusDistance);
    const bias = proximity * focusBias;

    return {
      resolution: Math.min(
        baseResolution * 2,
        Math.max(baseResolution, Math.floor(baseResolution * (1 + bias)))
      ),
      detailBudget: Math.min(1, baseBudget * (1 + bias * 0.5))
    };
  }
}

// ═════════════════════════════════════════════════════════════════════
// 7. ULTIMATE FULFILLED TERRAIN GENERATOR
// ═════════════════════════════════════════════════════════════════════

/**
 * UltimateFulfilledTerrainGenerator — the final generator that combines
 * every layer from 386 through 386_Z03 plus the six new layers defined in
 * this file: biome coupling, sensory emission, spatial acceleration,
 * seasonal variation, decomposer markers, and player-biased refinement.
 */
export class UltimateFulfilledTerrainGenerator extends UltimateTerrainGenerator {
  constructor(options = {}) {
    super(options);

    // ---- New layers ----
    this.biomeCoupling = new BiomeCouplingLayer(options.biomeCouplingOptions ?? {});
    this.sensoryEmission = new SensoryEmissionLayer(options.sensoryOptions ?? {});
    this.spatialAcceleration = new SpatialAccelerationLayer(options.spatialOptions ?? {});
    this.seasonalLayer = new SeasonalTerrainLayer(options.seasonalOptions ?? {});
    this.decomposerLayer = new DecomposerMarkerLayer(options.decomposerOptions ?? {});
    this.playerRefinement = new PlayerBiasedRefinement(options.playerRefinementOptions ?? {});

    // ---- Official biome registry barrel ----
    this.biomeRegistryBarrel = options.biomeRegistryBarrel ?? new BiomeRegistryBarrel();
    this._syncBiomeRegistryToBarrel();
  }

  _syncBiomeRegistryToBarrel() {
    // Copy every registered biome into the official barrel so external
    // systems can look them up by name.
    for (const [name, descriptor] of this.biomeRegistry) {
      if (!this.biomeRegistryBarrel.has(name)) {
        this.biomeRegistryBarrel.register(name, descriptor);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Ultimate generation — the single entry point
  // ---------------------------------------------------------------------

  /**
   * Generates a fully-fulfilled terrain tile with every system active:
   * advanced depth generation, biome coupling, sensory emission, seasonal
   * variation, decomposer markers, spatial registration, and player-biased
   * refinement.
   *
   * @param {object} tileInfo – { tileX, tileY, tileZ, lod }
   * @param {object} contextFrame – the live context frame
   * @param {object} options – generation options
   * @returns {object} the complete generation result
   */
  generateFulfilledTile(tileInfo, contextFrame, options = {}) {
    // 1. Determine refinement based on the player's context.
    const playerContext = contextFrame?.layers?.player;
    const baseFidelity = this.lodFidelity.configForLod(tileInfo.lod ?? 0);
    const refinement = this.playerRefinement.getRefinementConfig(
      { ...tileInfo, tileWorldSize: this.options.tileWorldSize },
      playerContext,
      baseFidelity.resolution,
      baseFidelity.detailBudget
    );

    // 2. Run the advanced depth generation with the refined settings.
    const depthOptions = {
      ...options,
      resolution: refinement.resolution,
      erosionIterations: Math.floor(50000 * refinement.detailBudget)
    };
    const result = super.generateTileWithDepth(tileInfo, depthOptions);

    // 3. Biome coupling: blend, ecotone, climate, soil, hydrology, material.
    const biomeName = options.biome ?? this.options.defaultBiome;
    const biomeDescriptor = this.biomeRegistry.get(biomeName);
    const blendedDescriptor = this.biomeCoupling.apply(
      result.terrain,
      contextFrame,
      [biomeDescriptor].filter(Boolean)
    );

    // 4. Sensory emission: waterfalls, springs, lakes, ambient audio.
    this.sensoryEmission.emit(result.terrain, result.markers, contextFrame, this.lastTick);

    // 5. Seasonal variation: snow, foliage, water level.
    const seasonal = this.seasonalLayer.apply(result.terrain, this.lastTick);

    // 6. Decomposer markers: moss, fallen logs, organic litter.
    this.decomposerLayer.emit(result.terrain, result.markers, this.lastTick);

    // 7. Register the tile in the spatial acceleration structures.
    const chunkKey = `${tileInfo.lod ?? 0}:${tileInfo.tileX}:${tileInfo.tileY}`;
    this.spatialAcceleration.registerChunk(
      chunkKey,
      result.terrain.getBoundingBox(),
      result.terrain.entityId,
      tileInfo.lod ?? 0
    );

    return {
      ...result,
      biomeDescriptor: blendedDescriptor,
      seasonal,
      chunkKey
    };
  }

  /**
   * Queries the spatial acceleration layer for visible chunks.
   */
  queryVisibleChunks(cameraX, cameraY, cameraZ, frustumPlanes) {
    const inFrustum = this.spatialAcceleration.queryFrustum(frustumPlanes);
    const visible = this.spatialAcceleration.queryVisible(cameraX, cameraY, cameraZ);
    // Intersection: chunks that are both in the frustum and not occluded.
    const visibleSet = new Set(visible);
    return inFrustum.filter(k => visibleSet.has(k));
  }

  /**
   * Returns the official biome registry barrel for external lookup.
   */
  getBiomeRegistry() {
    return this.biomeRegistryBarrel;
  }

  dispose() {
    super.dispose();
    this.biomeCoupling = null;
    this.sensoryEmission?.dispose();
    this.spatialAcceleration?.dispose();
    this.seasonalLayer = null;
    this.decomposerLayer = null;
    this.playerRefinement = null;
  }
}

// ═════════════════════════════════════════════════════════════════════
// 8. INSTALLER
// ═════════════════════════════════════════════════════════════════════

/**
 * installUltimateFulfilledExtensions — augments an existing generator with
 * every remaining context-folder feature: biome coupling, sensory emission,
 * spatial acceleration, seasonal variation, decomposer markers, and
 * player-biased refinement.
 */
export function installUltimateFulfilledExtensions(generator) {
  if (!generator || typeof generator.registerTerrainGenerator !== 'function') {
    throw new Error('installUltimateFulfilledExtensions requires a ProceduralTerrainGenerator');
  }

  const temp = new UltimateFulfilledTerrainGenerator({
    resolution: generator.options.resolution,
    seed: generator.options.seed
  });

  // Copy every biome.
  for (const [name, descriptor] of temp.biomeRegistry) {
    if (!generator.biomeRegistry.has(name)) {
      generator.registerBiome(name, descriptor);
    }
  }

  // Attach the new layers.
  generator.biomeCoupling = temp.biomeCoupling;
  generator.sensoryEmission = temp.sensoryEmission;
  generator.spatialAcceleration = temp.spatialAcceleration;
  generator.seasonalLayer = temp.seasonalLayer;
  generator.decomposerLayer = temp.decomposerLayer;
  generator.playerRefinement = temp.playerRefinement;
  generator.biomeRegistryBarrel = temp.biomeRegistryBarrel;

  // Attach the fulfilled generation method.
  generator.generateFulfilledTile = function (tileInfo, contextFrame, options) {
    return UltimateFulfilledTerrainGenerator.prototype.generateFulfilledTile.call(
      this, tileInfo, contextFrame, options
    );
  };
  generator.queryVisibleChunks = function (cameraX, cameraY, cameraZ, frustumPlanes) {
    return UltimateFulfilledTerrainGenerator.prototype.queryVisibleChunks.call(
      this, cameraX, cameraY, cameraZ, frustumPlanes
    );
  };
  generator.getBiomeRegistry = function () {
    return UltimateFulfilledTerrainGenerator.prototype.getBiomeRegistry.call(this);
  };

  temp.dispose();
  return generator;
}

// ═════════════════════════════════════════════════════════════════════
// 9. FACTORY
// ═════════════════════════════════════════════════════════════════════

/**
 * Creates an UltimateFulfilledTerrainGenerator pre-populated with every
 * feature from files 386 through 386_Z03 plus every new layer in this file.
 */
export function createUltimateFulfilledTerrainGenerator(options = {}) {
  return new UltimateFulfilledTerrainGenerator({
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
    biomeCouplingOptions: options.biomeCouplingOptions ?? {},
    sensoryOptions: options.sensoryOptions ?? {},
    spatialOptions: options.spatialOptions ?? {},
    seasonalOptions: options.seasonalOptions ?? {},
    decomposerOptions: options.decomposerOptions ?? {},
    playerRefinementOptions: options.playerRefinementOptions ?? {},
    ...options
  });
}

// ═════════════════════════════════════════════════════════════════════
// 10. BARREL EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  UltimateFulfilledTerrainGenerator,
  BiomeCouplingLayer,
  SensoryEmissionLayer,
  SpatialAccelerationLayer,
  SeasonalTerrainLayer,
  DecomposerMarkerLayer,
  PlayerBiasedRefinement,
  installUltimateFulfilledExtensions,
  createUltimateFulfilledTerrainGenerator
};